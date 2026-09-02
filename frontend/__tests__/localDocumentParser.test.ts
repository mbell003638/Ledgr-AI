import { interpretLocalDocumentText } from '../src/accountingV2/localDocumentParser';
import { buildBalancedOpeningSet } from '../src/accountingV2/scanImport';

const PARTNER_CLOSING_REPORT = [
  'Net Profit $27,621.00',
  "Each Partner's Share (50/50) $13,810.50",
  'Profit Before Commission $33,684.15',
  'Commission (18%) $6,063.15',
  'ASSETS',
  'Cash USD at Home $37,741.17',
  'Cash FC in Shop $948.04',
  'Cash USD in Shop $0.00',
  'Physical Stock $150,527.46',
  'Shop Deposit $7,500.00',
  'House Deposit $750.00',
  'Total Assets $197,466.67',
  'LIABILITIES',
  'Creditors $36,215.42',
  'Commission Payable $6,063.15',
  'DRAWINGS THIS PERIOD',
  'Amit Drawings $0.00',
  'Rahim Drawings $0.00',
  'Partner Stakes Reconciliation',
  'Amit Opening $55,124.98',
  '+ Profit Share +$13,810.50',
  '- Drawings -$0.00',
  'Amit Ending Stake $68,935.48',
  'Rahim Opening $72,442.12',
  '+ Profit Share +$13,810.50',
  '- Drawings -$0.00',
  'Rahim Ending Stake $86,252.62',
].join('\n');

function splitLabelAndAmount(text: string): string {
  return text.split('\n').flatMap((line) => {
    const match = line.match(/^(.*?)(\s[+\-−]?\$\d[\d,]*\.\d{2})$/);
    return match && match[1].trim() ? [match[1].trim(), match[2].trim()] : [line];
  }).join('\n');
}

function expectPartnerClosingDocument(result: ReturnType<typeof interpretLocalDocumentText>) {
  expect(result.status === 'confident' || result.status === 'clarification').toBe(true);
  if (result.status === 'unsupported') return;
  expect(result.document?.docType).toBe('closing_report');
  expect(result.document?.entries).toEqual([]);
  expect(result.document?.setup).toMatchObject({
    openingCash: 38689.21,
    stockValue: 150527.46,
    creditorsTotal: 36215.42,
    extraAssets: [
      { name: 'Shop Deposit', amount: 7500 },
      { name: 'House Deposit', amount: 750 },
    ],
    extraLiabilities: [{ name: 'Commission Payable', amount: 6063.15 }],
    partners: [
      { name: 'Amit', capital: 68935.48, profitSharePct: 50 },
      { name: 'Rahim', capital: 86252.62, profitSharePct: 50 },
    ],
  });
}

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

  it('reads the photographed partner closing report as setup, not a Net Profit expense', () => {
    const result = interpretLocalDocumentText(`As of 2026-08-10\n${PARTNER_CLOSING_REPORT}`);
    expectPartnerClosingDocument(result);
    expect(result.status).toBe('confident');
    if (result.status !== 'confident') return;
    expect(result.mapped.validRows.some((row) => row.kind === 'transaction')).toBe(false);
    const balanced = buildBalancedOpeningSet(result.mapped.validRows);
    expect(balanced.error).toBeNull();
    expect(balanced.value?.totalAssets).toBeCloseTo(197466.67, 2);
    expect(balanced.value?.partnerCapitals.map((row) => row.name)).toEqual(['Amit', 'Rahim']);
  });

  it('reassembles OCR that splits closing-report labels from right-aligned amounts', () => {
    const result = interpretLocalDocumentText(splitLabelAndAmount(PARTNER_CLOSING_REPORT));
    expectPartnerClosingDocument(result);
    if (result.status === 'unsupported') return;
    expect(result.document?.entries).toHaveLength(0);
    expect(result.document?.setup?.openingCash).not.toBe(197466.67);
    expect(result.status).toBe('clarification');
    if (result.status !== 'clarification') return;
    expect(result.question).toMatch(/statement date/i);
  });
});
