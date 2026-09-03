import { continueLocalDocumentParse, parseLocalDocumentText } from '../src/accountingV2/localDocumentParser';
import { buildBalancedOpeningSet, mapAnalyzedDocument } from '../src/accountingV2/scanImport';

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

function expectPartnerClosingSetup(result: ReturnType<typeof parseLocalDocumentText>) {
  expect(result.kind === 'confident' || result.kind === 'clarification').toBe(true);
  if (result.kind === 'unsupported') return;
  expect(result.analysis.docType).toBe('closing_report');
  expect(result.analysis.entries).toEqual([]);
  expect(result.analysis.setup).toMatchObject({
    creditorsTotal: 36215.42,
    extraAssets: [
      { name: 'Cash USD at Home', amount: 37741.17 },
      { name: 'Cash FC in Shop', amount: 948.04 },
      { name: 'Physical Stock', amount: 150527.46 },
      { name: 'Shop Deposit', amount: 7500 },
      { name: 'House Deposit', amount: 750 },
    ],
    extraLiabilities: [{ name: 'Commission Payable', amount: 6063.15 }],
    partners: [
      { name: 'Amit', capital: 68935.48, profitSharePct: 50 },
      { name: 'Rahim', capital: 86252.62, profitSharePct: 50 },
    ],
  });
  expect(result.analysis.setup?.openingCash).toBeUndefined();
  expect(result.analysis.setup?.stockValue).toBeUndefined();
}

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

  it('reads the photographed partner closing report as setup, not a Net Profit expense', () => {
    const result = parseLocalDocumentText(PARTNER_CLOSING_REPORT);
    expectPartnerClosingSetup(result);
    if (result.kind === 'unsupported') return;
    expect(result.kind).toBe('clarification');
    if (result.kind !== 'clarification') return;
    expect(result.field).toBe('date');
    expect(result.question).toMatch(/statement date/i);
    const continued = continueLocalDocumentParse(result, '2026-08-10');
    expect(continued.kind).toBe('confident');
    if (continued.kind !== 'confident') return;
    const mapped = mapAnalyzedDocument(continued.analysis);
    expect(mapped.validRows.some((row) => row.kind === 'transaction')).toBe(false);
    expect(mapped.validRows.filter((row) => row.kind === 'asset').map((row) => row.kind === 'asset' ? row.name : '')).toEqual([
      'Cash USD at Home', 'Cash FC in Shop', 'Physical Stock', 'Shop Deposit', 'House Deposit',
    ]);
    const balanced = buildBalancedOpeningSet(mapped.validRows);
    expect(balanced.error).toBeNull();
    expect(balanced.value?.totalAssets).toBeCloseTo(197466.67, 2);
    expect(balanced.value?.partnerCapitals.map((row) => row.name)).toEqual(['Amit', 'Rahim']);
  });

  it('reassembles OCR that splits closing-report labels from right-aligned amounts', () => {
    const result = parseLocalDocumentText(splitLabelAndAmount(PARTNER_CLOSING_REPORT));
    expectPartnerClosingSetup(result);
    if (result.kind === 'unsupported') return;
    expect(result.analysis.entries).toHaveLength(0);
    expect(result.analysis.setup?.openingCash).not.toBe(197466.67);
  });

  it('unpacks a packed closing-report line into many setup rows, not one total', () => {
    const result = parseLocalDocumentText(
      "ASSETS Cash USD at Home $37,741.17 Cash FC in Shop $948.04 Physical Stock $150,527.46 Shop Deposit $7,500.00 House Deposit $750.00 Total Assets $197,466.67 LIABILITIES Creditors $36,215.42 Commission Payable $6,063.15 Amit Ending Stake $68,935.48 Rahim Ending Stake $86,252.62 Each Partner's Share (50/50) $13,810.50",
    );
    expectPartnerClosingSetup(result);
    if (result.kind === 'unsupported') return;
    expect(result.analysis.entries).toHaveLength(0);
    const continued = result.kind === 'clarification' ? continueLocalDocumentParse(result, '2026-08-10') : result;
    if (continued.kind === 'unsupported') return;
    const mapped = mapAnalyzedDocument(continued.analysis);
    expect(mapped.validRows.some((row) => row.kind === 'transaction')).toBe(false);
    expect(mapped.validRows.length).toBeGreaterThanOrEqual(7);
  });
});
