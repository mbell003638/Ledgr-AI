import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2AppService } from '../src/accountingV2/appService';

const BOOK = 'scan-contract-book';

async function setup() {
  const node = makeNodeRunner();
  await initializeV2Book(node.runner, {
    book: { id: BOOK, name: 'Scan Contract Shop' },
    period: { id: `${BOOK}:period`, startDate: '2026-01-01', endDate: '2026-12-31' },
  });
  return { ...node, service: new V2AppService(node.runner) };
}

const count = async (runner: any, table: string) =>
  Number((await runner.first(`SELECT COUNT(*) AS n FROM ${table}`))?.n);

describe('V2 Scan & Import — creation approval boundary', () => {
  it('preflights missing/existing/role-missing/generic-AP ledgers read-only and deduplicates requests', async () => {
    const { runner, close, service } = await setup();
    try {
      await service.repo.createParty({
        id: `${BOOK}:existing`, bookId: BOOK, name: 'Existing Customer', roles: ['customer'], active: true,
      } as any);
      const before = {
        parties: await count(runner, 'v2_parties'),
        sources: await count(runner, 'v2_sources'),
        journals: await count(runner, 'v2_journal_entries'),
      };

      const result = await service.preflightScanParties([
        { name: 'New Customer', role: 'customer' },
        { name: ' new   customer ', role: 'customer' },
        { name: 'New Supplier', role: 'supplier' },
        { name: 'Existing Customer', role: 'customer' },
        { name: 'Existing Customer', role: 'supplier' },
        { name: 'Creditors', role: 'supplier' },
      ]);

      expect(result.requiresApproval).toBe(true);
      expect(result.items).toHaveLength(5);
      expect(result.items).toEqual(expect.arrayContaining([
        { name: 'new   customer', role: 'customer', status: 'missing', requiresCreation: true },
        { name: 'New Supplier', role: 'supplier', status: 'missing', requiresCreation: true },
        expect.objectContaining({ name: 'Existing Customer', role: 'customer', status: 'existing', requiresCreation: false, partyId: `${BOOK}:existing` }),
        expect.objectContaining({ name: 'Existing Customer', role: 'supplier', status: 'role_missing', requiresCreation: true, partyId: `${BOOK}:existing` }),
        { name: 'Creditors', role: 'supplier', status: 'ignored_generic_ap', requiresCreation: false },
      ]));
      expect({
        parties: await count(runner, 'v2_parties'),
        sources: await count(runner, 'v2_sources'),
        journals: await count(runner, 'v2_journal_entries'),
      }).toEqual(before);
    } finally { close(); }
  });

  it('requires approval before creating a credit-sale customer, then posts one invoice to that customer AR', async () => {
    const { runner, close, service } = await setup();
    try {
      const input = {
        entryType: 'sale' as const, date: '2026-08-10', partyName: 'New Customer', amount: 75,
        method: 'credit' as const, notes: '[Scan] Credit sale',
      };
      await expect(service.importScanTransaction(input)).rejects.toThrow("Customer ledger 'New Customer' requires confirmed creation");
      expect(await count(runner, 'v2_parties')).toBe(0);
      expect(await count(runner, 'v2_sources')).toBe(0);
      expect(await count(runner, 'v2_journal_entries')).toBe(0);

      await service.importScanTransaction({ ...input, createMissingParty: true });
      const party = await runner.first<{ id: string; name: string; roles: string }>('SELECT id,name,roles FROM v2_parties WHERE book_id=?', [BOOK]);
      expect(party).toMatchObject({ name: 'New Customer', roles: '["customer"]' });
      expect(await runner.all('SELECT type FROM v2_sources WHERE book_id=?', [BOOK])).toEqual([{ type: 'invoice' }]);
      expect(await service.repo.accountBalance(BOOK, `${BOOK}:account:1100`)).toBe(75);
      expect((await service.repo.reconcileBook(BOOK)).balanced).toBe(true);
    } finally { close(); }
  });

  it('rejects a blank supplier and atomically rolls back supplier creation when the transaction write fails', async () => {
    const { runner, close, service } = await setup();
    try {
      await expect(service.importScanTransaction({
        entryType: 'purchase_bill', date: '2026-08-10', partyName: ' ', amount: 40,
        method: 'credit', createMissingParty: true,
      })).rejects.toThrow('Supplier name is required');
      expect(await count(runner, 'v2_parties')).toBe(0);

      await runner.exec(`CREATE TRIGGER fail_scan_source BEFORE INSERT ON v2_sources
        BEGIN SELECT RAISE(FAIL, 'injected scan source failure'); END;`);
      await expect(service.importScanTransaction({
        entryType: 'purchase_bill', date: '2026-08-10', partyName: 'New Supplier', amount: 40,
        method: 'credit', createMissingParty: true,
      })).rejects.toThrow(/injected scan source failure/);
      expect(await count(runner, 'v2_parties')).toBe(0);
      expect(await count(runner, 'v2_sources')).toBe(0);
      expect(await count(runner, 'v2_journal_entries')).toBe(0);
    } finally { close(); }
  });
});
