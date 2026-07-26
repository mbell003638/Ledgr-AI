/**
 * Delivery Notes / Challans tests (feature #6).
 *
 * A delivery note documents goods movement only — it must post NOTHING to the
 * ledger (no revenue, no cash, no debtor balance change).
 */

const mem: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => (k in mem ? mem[k] : null)),
    setItem: jest.fn(async (k: string, v: string) => { mem[k] = v; }),
    removeItem: jest.fn(async (k: string) => { delete mem[k]; }),
  },
}));

import {
  createDeliveryNote, listDeliveryNotes, updateDeliveryNote, deleteDeliveryNote,
  dashboard, listDebtors, updateSettings,
} from '../src/db/local';

beforeEach(() => { for (const k of Object.keys(mem)) delete mem[k]; });

describe('Delivery notes — goods movement only', () => {
  it('creates a numbered challan with no ledger effect', async () => {
    await updateSettings({ accountingBasis: 'accrual' });
    const dn = await createDeliveryNote({
      clientName: 'Buyer', date: '2026-07-10',
      items: [{ description: 'Widgets', qty: 20 }, { description: 'Bolts', qty: 100 }],
      vehicleNo: 'KA-01-1234',
    });
    expect(dn.noteNumber).toBe('DC-0001');
    expect(dn.status).toBe('pending');
    expect(dn.items).toHaveLength(2);

    // Nothing posted to ledger
    const d = await dashboard();
    expect(d.totalSales).toBe(0);
    expect(d.cash).toBe(0);
    expect(await listDebtors()).toHaveLength(0);
  });

  it('status update and delete work', async () => {
    const dn = await createDeliveryNote({ clientName: 'B', date: '2026-07-10', items: [{ description: 'x', qty: 1 }] });
    await updateDeliveryNote(dn.id, { status: 'delivered' });
    expect((await listDeliveryNotes())[0].status).toBe('delivered');
    await deleteDeliveryNote(dn.id);
    expect(await listDeliveryNotes()).toHaveLength(0);
  });

  it('requires a customer name', async () => {
    await expect(createDeliveryNote({ clientName: '', date: '2026-07-10', items: [] })).rejects.toThrow(/customer name/i);
  });
});
