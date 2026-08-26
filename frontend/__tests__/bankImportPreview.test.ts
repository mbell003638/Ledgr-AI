import { parseBankCsvPreview } from '../src/utils/bankImportPreview';
import { blockedModules, previewModules } from '../src/utils/experimentalModules';

describe('bank statement preview', () => {
  it('normalizes debit and credit rows without posting', () => {
    const result = parseBankCsvPreview([
      'Date,Description,Debit,Credit',
      '08/25/2026,"Office supplies",12.50,',
      '2026-08-26,"Customer deposit",,100.00',
    ].join('\n'));
    expect(result.rows).toEqual([
      expect.objectContaining({ date: '2026-08-25', description: 'Office supplies', amount: 12.5, direction: 'outflow', valid: true, duplicate: false }),
      expect.objectContaining({ date: '2026-08-26', description: 'Customer deposit', amount: 100, direction: 'inflow', valid: true, duplicate: false }),
    ]);
    expect(result).toMatchObject({ validCount: 2, duplicateCount: 0, invalidCount: 0 });
  });

  it('flags duplicate and invalid rows instead of silently accepting them', () => {
    const csv = ['Date,Description,Amount', '2026-08-25,Coffee,-5.00', '2026-08-25,Coffee,-5.00', '31/08/2026,Unknown,10'].join('\n');
    const result = parseBankCsvPreview(csv);
    expect(result.rows[1].duplicate).toBe(true);
    expect(result.rows[2]).toMatchObject({ valid: false, issue: 'Invalid or unsupported date' });
    expect(result).toMatchObject({ validCount: 1, duplicateCount: 1, invalidCount: 1 });
  });

  it('can flag rows already seen by a future persistent staging layer', () => {
    const csv = ['Date,Description,Amount', '2026-08-25,Coffee,-5.00'].join('\n');
    const first = parseBankCsvPreview(csv);
    const second = parseBankCsvPreview(csv, [first.rows[0].id]);
    expect(second.rows[0].duplicate).toBe(true);
  });
});

describe('experimental module gate', () => {
  it('exposes only preview-safe modules and gives blocked modules no route', () => {
    expect(previewModules().map((module) => module.key)).toEqual(['bank_import_preview']);
    expect(blockedModules().length).toBeGreaterThan(0);
    for (const module of blockedModules()) expect(module.route).toBeUndefined();
  });
});
