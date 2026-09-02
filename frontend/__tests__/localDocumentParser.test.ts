import { interpretLocalDocumentText } from '../src/accountingV2/localDocumentParser';

describe('local document parser', () => {
  it('drafts a receipt when amounts are visible without a labelled total', () => {
    const result = interpretLocalDocumentText([
      'Corner Shop',
      'Date 2026-09-01',
      'Milk 2.50',
      'Bread 3.25',
      '8.75',
    ].join('\n'));
    expect(result.status).toBe('confident');
    if (result.status !== 'confident') return;
    expect(result.document.entries[0]).toMatchObject({ amount: 8.75, partyName: 'Corner Shop' });
  });

  it('keeps an unknown merchant name for Scan & Import to create later', () => {
    const result = interpretLocalDocumentText([
      'Make Hardware',
      'Invoice 1044',
      'Grand Total 100.00',
      '01/09/2026',
    ].join('\n'));
    expect(result.status === 'confident' || result.status === 'clarification').toBe(true);
    const party = 'document' in result ? result.document?.entries[0]?.partyName : undefined;
    expect(party).toMatch(/Make Hardware/i);
  });
});
