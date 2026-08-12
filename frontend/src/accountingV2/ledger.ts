import { emptyV2Store, isBalanced, journalTotals, type V2MemoryStore } from './schema';
import type { V2Account, V2Book, V2JournalEntry, V2JournalLine, V2Party, V2PartyRole } from './types';
import { round2 } from '../money';

const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
const cents = round2;

export class V2Ledger {
  readonly store: V2MemoryStore;
  constructor(store: V2MemoryStore = emptyV2Store()) { this.store = store; }

  createBook(book: V2Book, accounts: V2Account[]) {
    if (this.store.books.some((b) => b.id === book.id)) throw new Error('Book already exists');
    this.store.books.push(book); this.store.accounts.push(...accounts);
    return book;
  }

  createParty(input: Omit<V2Party, 'id'> & { id?: string }): V2Party {
    if (!this.store.books.some((b) => b.id === input.bookId)) throw new Error('Book not found');
    if (!input.name.trim()) throw new Error('Business account name is required');
    const roles: V2PartyRole[] = [...new Set(input.roles)];
    if (!roles.length) throw new Error('Business account must be a customer, supplier, or both');
    const party: V2Party = { ...input, id: input.id || uid('party'), name: input.name.trim(), roles };
    this.store.parties.push(party); return party;
  }

  post(input: Omit<V2JournalEntry, 'id'> & { id?: string }): V2JournalEntry {
    if (!this.store.books.some((b) => b.id === input.bookId)) throw new Error('Book not found');
    if (!isBalanced(input.lines)) throw new Error('Journal entry must balance and contain valid debit/credit lines');
    const accountIds = new Set(this.store.accounts.filter((a) => a.bookId === input.bookId).map((a) => a.id));
    const partyIds = new Set(this.store.parties.filter((p) => p.bookId === input.bookId).map((p) => p.id));
    for (const l of input.lines) {
      if (!accountIds.has(l.accountId)) throw new Error(`Account does not belong to book: ${l.accountId}`);
      if (l.partyId && !partyIds.has(l.partyId)) throw new Error(`Business account does not belong to this book: ${l.partyId}`);
    }
    const entry: V2JournalEntry = { ...input, id: input.id || uid('je'), lines: input.lines.map((l) => ({ ...l, debit: cents(l.debit), credit: cents(l.credit) })) };
    this.store.journals.push(entry); return entry;
  }

  reverse(journalId: string, date: string, reason: string): V2JournalEntry {
    const original = this.store.journals.find((j) => j.id === journalId);
    if (!original) throw new Error('Journal entry not found');
    if (this.store.journals.some((j) => j.reversalOf === journalId)) throw new Error('Journal entry already reversed');
    return this.post({ bookId: original.bookId, periodId: original.periodId, sourceId: original.sourceId, date, memo: `Reversal: ${reason}`, reversalOf: journalId, lines: original.lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })) });
  }

  balance(bookId: string, accountId: string): number {
    let debit = 0, credit = 0;
    for (const j of this.store.journals.filter((x) => x.bookId === bookId)) for (const l of j.lines) if (l.accountId === accountId) { debit += l.debit; credit += l.credit; }
    return cents(debit - credit);
  }

  reconcile(bookId: string) {
    const lines: V2JournalLine[] = this.store.journals.filter((j) => j.bookId === bookId).flatMap((j) => j.lines);
    const totals = journalTotals(lines);
    return { debit: cents(totals.debit), credit: cents(totals.credit), difference: cents(totals.debit - totals.credit), balanced: Math.abs(totals.debit - totals.credit) <= 0.005 };
  }
}
