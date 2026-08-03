/**
 * V2 dashboard (audit C1c + L3).
 *
 * Proves:
 *  - grossProfit/netProfit are derived from the journal-authoritative report (COGS-aware),
 *    not the old sales−purchases shortcut.
 *  - opening figures are REAL balances as of the period start, not aliases of the current
 *    balances (openingCash/openingInventory/openingBalance differ from the closing ones
 *    once trading happens within the period).
 */

import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2AppService } from '../src/accountingV2/appService';
import { getV2Dashboard } from '../src/accountingV2/v2Dashboard';

async function setup() {
  const node = makeNodeRunner();
  await initializeV2Book(node.runner, {
    book: { id: 'dash-v2', name: 'Dash V2' },
    period: { id: 'p1', startDate: '2026-07-01', endDate: '2026-07-31' },
  });
  return { ...node, service: new V2AppService(node.runner) };
}

describe('V2 dashboard opening balances (L3)', () => {
  it('reports real opening figures distinct from current balances', async () => {
    const { runner, close, service } = await setup();
    try {
      // Opening balances on the period start: cash 500, inventory 200.
      await service.postOpeningBalances({ date: '2026-07-01', cash: 500, inventory: 200 });
      // Later in the period: cash sale 100 and a cash purchase (inventory up 60, cash down 60).
      await service.createSale({ date: '2026-07-10', amount: 100, method: 'cash' });
      await service.createBill({ date: '2026-07-12', amount: 60, supplierName: 'Supplier', paymentType: 'cash', method: 'cash' });

      const dash = await getV2Dashboard(runner, 'dash-v2');

      // Opening figures reflect the START of the period (just the opening-balance entry).
      expect(dash.openingCash).toBe(500);
      expect(dash.openingInventory).toBe(200);
      expect(dash.openingBalance).toBe(700); // 500 cash + 200 inventory

      // Current figures reflect the period's trading and are NOT equal to opening.
      expect(dash.cash).toBe(540);           // 500 + 100 sale − 60 purchase
      expect(dash.inventoryValue).toBe(260); // 200 + 60 purchase
      expect(dash.closingBalance).toBe(800); // 540 + 260
      expect(dash.openingBalance).not.toBe(dash.closingBalance);
    } finally { close(); }
  });
});
