import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { isOptionalModuleEnabledForBook } from '../src/accountingV2/optionalModules';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { ProductDomainService } from '../src/accountingV2/services/productDomainService';
import { LocationDomainService } from '../src/accountingV2/services/locationDomainService';
import { qtyAtLocation } from '../src/accountingV2/services/locationDomainService';
import { selectedWorkspaceMetrics } from '../src/utils/capabilities';
import { makeNodeRunner } from './helpers/nodeRunner';

const BOOK = 'manus-remediation-book';
const PERIOD = 'manus-remediation-period';
const DATE = '2026-08-19';

describe('Manus remediation regressions', () => {
  it('shows only metrics explicitly selected for reporting', () => {
    const eligible = { enabledCapabilities: ['cogs_margin', 'growth_analytics'] };
    expect(selectedWorkspaceMetrics(eligible)).toEqual([]);
    expect(selectedWorkspaceMetrics({ ...eligible, workspaceMetricKeys: ['gross_margin', 'roi'] }).map((metric) => metric.key))
      .toEqual(['gross_margin', 'roi']);
  });

  it('treats multi-location capability configuration as enabled by the location enforcement layer', async () => {
    const node = makeNodeRunner();
    try {
      await initializeV2Book(node.runner, { book: { id: BOOK, name: 'Remediation shops' }, period: { id: PERIOD, startDate: '2026-01-01', endDate: '2026-12-31' } });
      const persona = await node.runner.first<{ id: string; config: string }>('SELECT id,config FROM v2_personas WHERE book_id=? AND active=1', [BOOK]);
      expect(persona?.id).toBeTruthy();
      await node.runner.run('UPDATE v2_personas SET config=? WHERE id=?', [JSON.stringify({ enabledCapabilities: ['multi_location', 'inventory'] }), persona!.id]);
      await expect(isOptionalModuleEnabledForBook(node.runner, BOOK, 'locations')).resolves.toBe(true);
    } finally { node.close(); }
  });

  it('keeps physical-stock adjustments and their journal lines scoped to the closed shop', async () => {
    const node = makeNodeRunner();
    try {
      await initializeV2Book(node.runner, { book: { id: BOOK, name: 'Shop count' }, period: { id: PERIOD, startDate: '2026-01-01', endDate: '2026-12-31' } });
      await node.runner.run("INSERT INTO settings(key,value) VALUES('main',?)", [JSON.stringify({ enabledFeatures: ['locations', 'perpetualInventory'] })]);
      const repo = new V2SqlRepository(node.runner);
      const products = new ProductDomainService(node.runner, repo, async () => ({ bookId: BOOK, periodId: PERIOD }));
      const locations = new LocationDomainService(node.runner, repo, async () => ({ bookId: BOOK, periodId: PERIOD }));
      const shopA = await locations.createLocation({ name: 'Shop A' });
      const shopB = await locations.createLocation({ name: 'Shop B' });
      await products.upsertProduct({ id: 'widget', name: 'Widget', cost: 5, price: 10, openingQty: 4, locationId: shopA.id });
      await products.adjustQty({ productId: 'widget', qtyDelta: -1, date: DATE, locationId: shopA.id, notes: 'Physical count — Shop A shop close' });
      expect(await qtyAtLocation(node.runner, BOOK, 'widget', shopA.id)).toBe(3);
      expect(await qtyAtLocation(node.runner, BOOK, 'widget', shopB.id)).toBe(0);
      const lines = await node.runner.all<{ location_id: string | null }>("SELECT l.location_id FROM v2_journal_lines l JOIN v2_journal_entries j ON j.id=l.journal_id WHERE j.book_id=? AND j.memo='Physical count — Shop A shop close'", [BOOK]);
      expect(lines.length).toBe(2);
      expect(lines.every((line) => line.location_id === shopA.id)).toBe(true);
    } finally { node.close(); }
  });
});
