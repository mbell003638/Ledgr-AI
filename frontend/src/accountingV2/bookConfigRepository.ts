import type { SqlRunner } from '../db/schema';
import type { V2Book } from './types';
import type { PersonaId, V2BookConfig } from './config';
import { defaultBookConfig } from './config';

export type StoredPersona = {
  id: string;
  bookId: string;
  type: PersonaId;
  enabled: boolean;
  active: boolean;
  config: Record<string, unknown>;
};

type BookRow = { id: string; name: string; style: V2Book['style']; basis: V2Book['basis']; created_at: string };
type PersonaRow = { id: string; book_id: string; type: PersonaId; enabled: number; active: number; config: string };

const personaId = (bookId: string, type: PersonaId) => `${bookId}:persona:${type}`;

export class V2BookConfigRepository {
  constructor(readonly db: SqlRunner) {}

  async createBook(book: V2Book, personas: PersonaId[] = ['custom']): Promise<V2Book> {
    const selected = [...new Set(personas)];
    if (!selected.length) selected.push('custom');
    return this.tx(async () => {
      await this.db.run(
        'INSERT INTO v2_books(id,name,style,basis,created_at) VALUES(?,?,?,?,?)',
        [book.id, book.name, book.style, book.basis, book.createdAt],
      );
      for (let index = 0; index < selected.length; index += 1) {
        const type = selected[index];
        await this.db.run(
          'INSERT INTO v2_personas(id,book_id,type,enabled,active,config) VALUES(?,?,?,?,?,?)',
          [personaId(book.id, type), book.id, type, 1, index === 0 ? 1 : 0, '{}'],
        );
      }
      const active = await this.db.first('SELECT value FROM meta WHERE key = ?', ['v2_active_book_id']);
      if (!active) await this.setMeta('v2_active_book_id', book.id);
      return book;
    });
  }

  async listBooks(): Promise<V2Book[]> {
    const rows = await this.db.all<BookRow>('SELECT id,name,style,basis,created_at FROM v2_books ORDER BY created_at,id');
    return rows.map((row) => ({ id: row.id, name: row.name, style: row.style, basis: row.basis, createdAt: row.created_at }));
  }

  async getActiveBook(): Promise<V2Book | null> {
    const row = await this.db.first<BookRow>(`SELECT b.id,b.name,b.style,b.basis,b.created_at
      FROM v2_books b JOIN meta m ON m.key = 'v2_active_book_id' AND m.value = b.id`);
    return row ? { id: row.id, name: row.name, style: row.style, basis: row.basis, createdAt: row.created_at } : null;
  }

  async switchActiveBook(bookId: string): Promise<void> {
    await this.tx(async () => {
      await this.requireBook(bookId);
      await this.setMeta('v2_active_book_id', bookId);
    });
  }

  async listPersonas(bookId: string, includeDisabled = true): Promise<StoredPersona[]> {
    await this.requireBook(bookId);
    const rows = await this.db.all<PersonaRow>(
      `SELECT id,book_id,type,enabled,active,config FROM v2_personas
       WHERE book_id = ?${includeDisabled ? '' : ' AND enabled = 1'} ORDER BY rowid`, [bookId],
    );
    return rows.map((row) => ({
      id: row.id, bookId: row.book_id, type: row.type, enabled: Boolean(row.enabled),
      active: Boolean(row.active), config: this.parseConfig(row.config),
    }));
  }

  async getBookConfig(bookId: string): Promise<V2BookConfig> {
    const book = await this.db.first<BookRow>('SELECT id,name,style,basis,created_at FROM v2_books WHERE id = ?', [bookId]);
    if (!book) throw new Error('Book not found');
    const personas = await this.listPersonas(bookId, false);
    const active = personas.find((item) => item.active) || personas[0];
    if (!active) throw new Error('Book has no enabled persona');
    return {
      ...defaultBookConfig(bookId), style: book.style, basis: book.basis,
      selectedPersonas: personas.map((item) => item.type), activePersona: active.type,
    };
  }

  async addPersona(bookId: string, type: PersonaId, config?: Record<string, unknown>): Promise<void> {
    await this.tx(async () => {
      await this.requireBook(bookId);
      const existing = await this.db.first<PersonaRow>('SELECT id,book_id,type,enabled,active,config FROM v2_personas WHERE book_id = ? AND type = ?', [bookId, type]);
      if (existing) {
        await this.db.run('UPDATE v2_personas SET enabled = 1, config = ? WHERE id = ?', [config === undefined ? existing.config : JSON.stringify(config), existing.id]);
      } else {
        const enabled = await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_personas WHERE book_id = ? AND enabled = 1', [bookId]);
        await this.db.run('INSERT INTO v2_personas(id,book_id,type,enabled,active,config) VALUES(?,?,?,?,?,?)', [personaId(bookId, type), bookId, type, 1, Number(enabled?.n || 0) === 0 ? 1 : 0, JSON.stringify(config || {})]);
      }
    });
  }

  async setActivePersona(bookId: string, type: PersonaId): Promise<void> {
    await this.tx(async () => {
      await this.requireBook(bookId);
      const persona = await this.db.first('SELECT id FROM v2_personas WHERE book_id = ? AND type = ? AND enabled = 1', [bookId, type]);
      if (!persona) throw new Error('Persona is not enabled for book');
      await this.db.run('UPDATE v2_personas SET active = 0 WHERE book_id = ?', [bookId]);
      await this.db.run('UPDATE v2_personas SET active = 1 WHERE book_id = ? AND type = ?', [bookId, type]);
    });
  }

  async removePersona(bookId: string, type: PersonaId): Promise<void> {
    await this.tx(async () => {
      await this.requireBook(bookId);
      const target = await this.db.first<{ active: number }>('SELECT active FROM v2_personas WHERE book_id = ? AND type = ? AND enabled = 1', [bookId, type]);
      if (!target) throw new Error('Persona is not enabled for book');
      const count = await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_personas WHERE book_id = ? AND enabled = 1', [bookId]);
      if (Number(count?.n) <= 1) throw new Error('Cannot remove the last enabled persona');
      await this.db.run('UPDATE v2_personas SET enabled = 0, active = 0 WHERE book_id = ? AND type = ?', [bookId, type]);
      if (Boolean(target.active)) {
        const fallback = await this.db.first<{ id: string }>('SELECT id FROM v2_personas WHERE book_id = ? AND enabled = 1 ORDER BY rowid LIMIT 1', [bookId]);
        await this.db.run('UPDATE v2_personas SET active = 1 WHERE id = ?', [fallback!.id]);
      }
    });
  }

  private async requireBook(bookId: string): Promise<void> {
    if (!(await this.db.first('SELECT id FROM v2_books WHERE id = ?', [bookId]))) throw new Error('Book not found');
  }

  private parseConfig(raw: string): Record<string, unknown> {
    try { const parsed = JSON.parse(raw); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; }
    catch { return {}; }
  }

  private setMeta(key: string, value: string): Promise<void> {
    return this.db.run(`INSERT INTO meta(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);
  }

  private async tx<T>(fn: () => Promise<T>): Promise<T> {
    await this.db.exec('BEGIN');
    try { const value = await fn(); await this.db.exec('COMMIT'); return value; }
    catch (error) { try { await this.db.exec('ROLLBACK'); } catch { /* preserve original */ } throw error; }
  }
}