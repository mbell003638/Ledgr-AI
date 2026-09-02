import { parseLocalDocumentText } from '../src/accountingV2/localDocumentParser';

describe('local document parser', () => {
  it('drafts a receipt when amounts are visible without a labelled total', () => {
    const result = parseLocalDocumentText([
      'Corner Shop',
      'Date 2026-09-01',
      'Milk 2.50',
      'Bread 3.25',
      '8.75',
    ].join('\n'));
    expect(result.kind).toBe('confident');
    if (result.kind !== 'confident') return;
    expect(result.analysis.entries[0]).toMatchObject({ amount: 8.75, partyName: 'Corner Shop' });
  });

  it('keeps an unknown merchant name for Scan & Import to create later', () => {
    const result = parseLocalDocumentText([
      'Make Hardware',
      'Invoice 1044',
      'Grand Total 100.00',
      '2026-09-01',
    ].join('\n'));
    expect(result.kind === 'confident' || result.kind === 'clarification').toBe(true);
    const party = result.kind === 'unsupported' ? '' : result.analysis.entries[0]?.partyName;
    expect(party).toMatch(/Make Hardware/i);
  });
});
