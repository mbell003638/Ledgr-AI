import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { LocationDomainService } from '../src/accountingV2/services/locationDomainService';
import { makeNodeRunner } from './helpers/nodeRunner';

describe('Phase 6 location lifecycle', () => {
  it('renames, archives, reopens, and retains historical location records', async () => {
    const bookId = 'phase46-location-book';
    const periodId = 'phase46-location-period';
    const node = makeNodeRunner();
    try {
      await initializeV2Book(node.runner, {
        book: { id: bookId, name: 'Location lifecycle' },
        period: { id: periodId, startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      const persona = await node.runner.first<{ id: string }>('SELECT id FROM v2_personas WHERE book_id=? AND active=1', [bookId]);
      await node.runner.run('UPDATE v2_personas SET config=? WHERE id=?', [JSON.stringify({ enabledCapabilities: ['multi_location'] }), persona!.id]);

      const locations = new LocationDomainService(node.runner, new V2SqlRepository(node.runner), async () => ({ bookId, periodId }));
      const created = await locations.createLocation({ name: 'Shop A' });
      await expect(locations.renameLocation(created.id, 'Main Shop')).resolves.toMatchObject({ id: created.id, name: 'Main Shop', archived: false });
      await expect(locations.archiveLocation(created.id)).resolves.toMatchObject({ id: created.id, name: 'Main Shop', archived: true });
      await expect(locations.listLocations()).resolves.toEqual([]);
      await expect(locations.listLocations({ includeArchived: true })).resolves.toEqual([
        expect.objectContaining({ id: created.id, name: 'Main Shop', archived: true }),
      ]);
      await expect(locations.reopenLocation(created.id)).resolves.toMatchObject({ id: created.id, name: 'Main Shop', archived: false });
      await expect(locations.listLocations()).resolves.toEqual([
        expect.objectContaining({ id: created.id, name: 'Main Shop', archived: false }),
      ]);
    } finally {
      node.close();
    }
  });
});

