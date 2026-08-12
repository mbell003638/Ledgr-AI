import { calculateInvoiceTotals } from '../src/utils/invoiceTotals';

describe('invoice totals', () => {
  it('uses quantity and rate, applies a fixed discount, then tax', () => {
    expect(calculateInvoiceTotals([
      { qty: 2, rate: 50 },
      { qty: 1, price: 25 },
    ], 15, 10)).toEqual({ subtotal: 125, discount: 15, taxableSubtotal: 110, tax: 11, total: 121 });
  });

  it('rejects negative and over-subtotal discounts', () => {
    expect(() => calculateInvoiceTotals([{ qty: 1, rate: 10 }], -1)).toThrow('negative');
    expect(() => calculateInvoiceTotals([{ qty: 1, rate: 10 }], 11)).toThrow('exceed subtotal');
  });
});
