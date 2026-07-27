import { makeNodeRunner } from './helpers/nodeRunner';
import { initSchema } from '../src/db/schema';
import { V2BookConfigRepository } from '../src/accountingV2/bookConfigRepository';
import { defaultBook } from '../src/accountingV2/schema';

describe('V2BookConfigRepository — persistent books and persona isolation', () => {
  it('migrates existing persona rows with an active persona per book', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await runner.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO meta(key,value) VALUES('schema_version','3');
        CREATE TABLE v2_books (id TEXT PRIMARY KEY, name TEXT NOT NULL, style TEXT NOT NULL, basis TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE v2_personas (id TEXT PRIMARY KEY, book_id TEXT NOT NULL, type TEXT NOT NULL, enabled INTEGER NOT NULL, config TEXT NOT NULL DEFAULT '{}');
        INSERT INTO v2_books VALUES('old-book','Old','standard','accrual','2026-01-01T00:00:00.000Z');
        INSERT INTO v2_personas VALUES('old-retail','old-book','retail',1,'{}');
        INSERT INTO v2_personas VALUES('old-vendor','old-book','vendor',1,'{}');
      `);
      await initSchema(runner);
      const active = await runner.all<{ type: string }>('SELECT type FROM v2_personas WHERE book_id = ? AND active = 1', ['old-book']);
      expect(active).toEqual([{ type: 'retail' }]);
      expect((await runner.first<{ value: string }>("SELECT value FROM meta WHERE key='schema_version'"))?.value).toBe('5');
    } finally { close(); }
  });

  it('creates, lists, and persistently switches the active book', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initSchema(runner);
      const repo = new V2BookConfigRepository(runner);
      const first = defaultBook('book-a', 'Alpha');
      const second = defaultBook('book-b', 'Beta');

      await repo.createBook(first, ['retail']);
      await repo.createBook(second, ['professional_service']);
      expect((await repo.listBooks()).map((book) => book.id)).toEqual(['book-a', 'book-b']);
      expect((await repo.getActiveBook())?.id).toBe('book-a');

      await repo.switchActiveBook('book-b');
      expect((await new V2BookConfigRepository(runner).getActiveBook())?.id).toBe('book-b');
      await expect(repo.switchActiveBook('missing')).rejects.toThrow(/book not found/i);
      expect((await repo.getActiveBook())?.id).toBe('book-b');
    } finally { close(); }
  });

  it('persists selected and active personas independently for each book', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initSchema(runner);
      const repo = new V2BookConfigRepository(runner);
      await repo.createBook(defaultBook('book-a', 'Alpha'), ['retail', 'wholesale']);
      await repo.createBook(defaultBook('book-b', 'Beta'), ['salon']);

      await repo.setActivePersona('book-a', 'wholesale');
      await repo.addPersona('book-b', 'vendor', { showDeliveries: true });
      await repo.setActivePersona('book-b', 'vendor');

      const reloaded = new V2BookConfigRepository(runner);
      await expect(reloaded.getBookConfig('book-a')).resolves.toMatchObject({
        bookId: 'book-a', selectedPersonas: ['retail', 'wholesale'], activePersona: 'wholesale',
      });
      await expect(reloaded.getBookConfig('book-b')).resolves.toMatchObject({
        bookId: 'book-b', selectedPersonas: ['salon', 'vendor'], activePersona: 'vendor',
      });
      expect((await reloaded.listPersonas('book-b')).find((p) => p.type === 'vendor')?.config).toEqual({ showDeliveries: true });
      await expect(repo.setActivePersona('book-a', 'vendor')).rejects.toThrow(/not enabled/i);
    } finally { close(); }
  });

  it('disables a removed persona without deleting its stored configuration', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initSchema(runner);
      const repo = new V2BookConfigRepository(runner);
      await repo.createBook(defaultBook('book-a', 'Alpha'), ['retail', 'wholesale']);
      await repo.addPersona('book-a', 'vendor', { priceLevel: 'trade' });
      await repo.setActivePersona('book-a', 'vendor');

      await repo.removePersona('book-a', 'vendor');
      expect(await repo.getBookConfig('book-a')).toMatchObject({
        selectedPersonas: ['retail', 'wholesale'], activePersona: 'retail',
      });
      const stored = await runner.first<{ enabled: number; config: string }>(
        'SELECT enabled, config FROM v2_personas WHERE book_id = ? AND type = ?', ['book-a', 'vendor'],
      );
      expect(Number(stored?.enabled)).toBe(0);
      expect(JSON.parse(stored!.config)).toEqual({ priceLevel: 'trade' });

      await repo.addPersona('book-a', 'vendor');
      expect((await repo.listPersonas('book-a')).find((p) => p.type === 'vendor')).toMatchObject({
        enabled: true, config: { priceLevel: 'trade' },
      });
    } finally { close(); }
  });

  it('keeps persona mutations atomic and prevents removing the last enabled persona', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initSchema(runner);
      const repo = new V2BookConfigRepository(runner);
      await repo.createBook(defaultBook('book-a', 'Alpha'), ['retail']);
      await expect(repo.removePersona('book-a', 'retail')).rejects.toThrow(/last enabled persona/i);
      expect((await repo.getBookConfig('book-a')).selectedPersonas).toEqual(['retail']);

      await runner.exec(`CREATE TRIGGER fail_persona BEFORE INSERT ON v2_personas
        WHEN NEW.type = 'vendor' BEGIN SELECT RAISE(FAIL, 'injected persona failure'); END;`);
      await expect(repo.addPersona('book-a', 'vendor')).rejects.toThrow(/injected persona failure/);
      expect((await repo.getBookConfig('book-a')).selectedPersonas).toEqual(['retail']);
    } finally { close(); }
  });
});
