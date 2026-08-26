import { expenseCategorySuggestions } from '../src/accountingV2/expenseCategories';
import { calculateCac, calculateCogs, calculateGrossMargin, calculateRoe, calculateRoi } from '../src/utils/businessMetrics';

describe('safe business insights', () => {
  it('calculates explainable metrics only with valid inputs', () => {
    expect(calculateCogs(1000).value).toBe(1000);
    expect(calculateGrossMargin(2000, 1000).value).toBe(50);
    expect(calculateCac(500, 10).value).toBe(50);
    expect(calculateRoi(1500, 1000).value).toBe(50);
    expect(calculateRoe(200, 800, 1200).value).toBe(20);
  });

  it('suppresses misleading values when a denominator is missing', () => {
    expect(calculateGrossMargin(0, 0).state).toBe('insufficient_data');
    expect(calculateCac(100, 0).state).toBe('insufficient_data');
    expect(calculateRoi(100, 0).state).toBe('insufficient_data');
    expect(calculateRoe(100, 0, 0).state).toBe('insufficient_data');
  });

  it('offers persona-aware labels while retaining common categories', () => {
    const retail = expenseCategorySuggestions({ activePersona: 'retail' }).map((item) => item.label);
    const freelancer = expenseCategorySuggestions({ businessType: 'freelancer' }).map((item) => item.label);
    expect(retail).toEqual(expect.arrayContaining(['Packaging', 'Delivery Fees', 'Rent']));
    expect(freelancer).toEqual(expect.arrayContaining(['Software & Cloud', 'Contractors', 'Rent']));
    expect(new Set(retail).size).toBe(retail.length);
  });
});
