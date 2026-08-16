import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { ProductDomainService } from '../src/accountingV2/services/productDomainService';
import { LocationDomainService } from '../src/accountingV2/services/locationDomainService';
import { postCashSale } from '../src/accountingV2/postings';
import { buildPersistentV2Reports } from '../src/accountingV2/persistentReports';
import { getV2Dashboard } from '../src/accountingV2/v2Dashboard';
import { qtyAtLocation } from '../src/accountingV2/services/locationDomainService';

const BOOK = 'active-v2';
const PERIOD = 'open-2026';
const DATE = '2026-07-01';

async function setup(features: string[]) {
  const node = makeNodeRunner();
  await initializeV2Book(node.runner, {
    book: { id: BOOK, name: 'Multi Shop' },
    period: { id: PERIOD, startDate: '2026-01-01', endDate: '2026-12-31' },
  });
  if (features.length) {
    await node.runner.run(
      "INSERT INTO settings(key,value) VALUES('main',?)",
      [JSON.stringify({ enabledFeatures: features })],
    );
  }
  const repo = new V2SqlRepository(node.runner);
  const products = new ProductDomainService(node.runner, repo, async () => ({ bookId: BOOK, periodId: PERIOD }));
  const locations = new LocationDomainService(node.runner, repo, async () => ({ bookId: BOOK, periodId: PERIOD }));
  return { ...node, repo, products, locations };
}

describe('optional locations', () => {
  it('does not require a location when the module is off', async () => {
    const { runner, close, repo } = await setup([]);
    try {
      await postCashSale(repo, { bookId: BOOK, periodId: PERIOD, date: DATE, amount: 40, method: 'cash' });
      const loc = await runner.first<{ n: number }>("SELECT COUNT(*) AS n FROM v2_journal_lines WHERE location_id IS NOT NULL");
      expect(Number(loc?.n)).toBe(0);
    } finally { close(); }
  });

  it('throws when recording a sale without a shop once locations are on', async () => {
    const { close, repo } = await setup(['locations']);
    try {
      const { SaleDomainService } = await import('../src/accountingV2/services/saleDomainService');
      const { V2DocumentService } = await import('../src/accountingV2/documentService');
      const { PartyDomainService } = await import('../src/accountingV2/services/partyDomainService');
      const { InvoiceDomainService } = await import('../src/accountingV2/services/invoiceDomainService');
      const documents = new V2DocumentService(repo);
      const parties = new PartyDomainService(repo.db, repo, documents, async () => ({ bookId: BOOK, periodId: PERIOD }));
      const invoices = new InvoiceDomainService(repo.db, repo, documents, parties, async () => ({ bookId: BOOK, periodId: PERIOD }), async (input) => input);
      const sales = new SaleDomainService(repo.db, repo, documents, parties, invoices, async () => ({ bookId: BOOK, periodId: PERIOD }), async (input) => input, async () => 'cash_sale');
      await expect(sales.createSale({ date: DATE, amount: 10, method: 'cash' })).rejects.toThrow(/location|Choose a location/i);
    } finally { close(); }
  });

  it('sale at Shop A reduces A stock and cash, not Shop B, and transfers move both', async () => {
    const { runner, close, repo, products, locations } = await setup(['locations', 'perpetualInventory']);
    try {
      const shopA = await locations.createLocation({ name: 'Shop A' });
      const shopB = await locations.createLocation({ name: 'Shop B' });
      await products.upsertProduct({ id: 'widget', name: 'Widget', cost: 5, price: 12, openingQty: 10, locationId: shopA.id });
      expect(await qtyAtLocation(runner, BOOK, 'widget', shopA.id)).toBe(10);
      expect(await qtyAtLocation(runner, BOOK, 'widget', shopB.id)).toBe(0);

      await postCashSale(repo, { bookId: BOOK, periodId: PERIOD, date: DATE, amount: 36, method: 'cash', locationId: shopA.id });
      const saleSource = await runner.first<{ id: string }>("SELECT id FROM v2_sources WHERE type='cash_sale' ORDER BY id DESC LIMIT 1");
      await products.applySaleLines(BOOK, PERIOD, DATE, saleSource!.id, [{ productId: 'widget', qty: 3 }], shopA.id);

      expect(await qtyAtLocation(runner, BOOK, 'widget', shopA.id)).toBe(7);
      expect(await qtyAtLocation(runner, BOOK, 'widget', shopB.id)).toBe(0);

      await expect(products.applySaleLines(BOOK, PERIOD, DATE, saleSource!.id, [{ productId: 'widget', qty: 8 }], shopA.id))
        .rejects.toThrow(/Insufficient stock at this location/i);

      await locations.transferStock({ date: DATE, fromLocationId: shopA.id, toLocationId: shopB.id, productId: 'widget', qty: 4 });
      expect(await qtyAtLocation(runner, BOOK, 'widget', shopA.id)).toBe(3);
      expect(await qtyAtLocation(runner, BOOK, 'widget', shopB.id)).toBe(4);

      await locations.transferCash({ date: DATE, fromLocationId: shopA.id, toLocationId: shopB.id, amount: 10, method: 'cash' });

      const all = await buildPersistentV2Reports(runner, { bookId: BOOK });
      const onlyA = await buildPersistentV2Reports(runner, { bookId: BOOK, locationId: shopA.id });
      const onlyB = await buildPersistentV2Reports(runner, { bookId: BOOK, locationId: shopB.id });
      const cash = (report: typeof all, code: string) => report.trialBalance.accounts.find((a) => a.code === code)?.normalBalance || 0;

      expect(cash(all, '1000')).toBeCloseTo(36, 2);
      expect(cash(onlyA, '1000')).toBeCloseTo(26, 2);
      expect(cash(onlyB, '1000')).toBeCloseTo(10, 2);
      expect(onlyA.profitAndLoss.revenue).toBeCloseTo(36, 2);
      expect(onlyB.profitAndLoss.revenue).toBeCloseTo(0, 2);

      const dashA = await getV2Dashboard(runner, BOOK, shopA.id);
      const dashB = await getV2Dashboard(runner, BOOK, shopB.id);
      const dashAll = await getV2Dashboard(runner, BOOK);
      expect(dashA.cash).toBeCloseTo(26, 2);
      expect(dashB.cash).toBeCloseTo(10, 2);
      expect(dashAll.cash).toBeCloseTo(36, 2);
      expect(dashA.totalSales).toBeCloseTo(36, 2);
      expect(dashB.totalSales).toBeCloseTo(0, 2);
    } finally { close(); }
  });

  it('does not let Book A active location or flags apply to Book B', async () => {
    const { runner, close, locations } = await setup(['locations']);
    try {
      const { writeV2BookPrefs, isOptionalModuleEnabled } = await import('../src/accountingV2/optionalModules');
      const { resolveWriteLocationId } = await import('../src/accountingV2/services/locationDomainService');
      await initializeV2Book(runner, {
        book: { id: 'book-b', name: 'Other Co' },
        period: { id: 'book-b:period', startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      const shopA = await locations.createLocation({ name: 'Shop A' });
      await writeV2BookPrefs(runner, BOOK, { enabledFeatures: ['locations'], activeLocationId: shopA.id });
      await writeV2BookPrefs(runner, 'book-b', { enabledFeatures: [], activeLocationId: shopA.id });

      expect(await isOptionalModuleEnabled(runner, 'locations', BOOK)).toBe(true);
      expect(await isOptionalModuleEnabled(runner, 'locations', 'book-b')).toBe(false);
      expect(await resolveWriteLocationId(runner, 'book-b', shopA.id)).toBeNull();
      expect(await resolveWriteLocationId(runner, BOOK)).toBe(shopA.id);

      await writeV2BookPrefs(runner, 'book-b', { enabledFeatures: ['locations'], activeLocationId: shopA.id });
      await expect(resolveWriteLocationId(runner, 'book-b')).rejects.toThrow(/Location not found|Choose a location/i);
    } finally { close(); }
  });

  it('does not inherit main optional flags onto a second book that has no prefs row', async () => {
    const { runner, close } = await setup(['payroll', 'perpetualInventory', 'locations']);
    try {
      const { isOptionalModuleEnabled } = await import('../src/accountingV2/optionalModules');
      await initializeV2Book(runner, {
        book: { id: 'book-b', name: 'Other Co' },
        period: { id: 'book-b:period', startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      expect(await isOptionalModuleEnabled(runner, 'payroll', BOOK)).toBe(true);
      expect(await isOptionalModuleEnabled(runner, 'payroll', 'book-b')).toBe(false);
      expect(await isOptionalModuleEnabled(runner, 'perpetualInventory', 'book-b')).toBe(false);
      expect(await isOptionalModuleEnabled(runner, 'locations', 'book-b')).toBe(false);
    } finally { close(); }
  });
});
