import { numberToWords, amountToWords, CURRENCY_WORDS } from '../src/utils/numberToWords';

describe('numberToWords', () => {
  it('converts small numbers correctly', () => {
    expect(numberToWords(0)).toBe('Zero');
    expect(numberToWords(1)).toBe('One');
    expect(numberToWords(18)).toBe('Eighteen');
  });

  it('converts hundreds correctly', () => {
    expect(numberToWords(100)).toBe('One Hundred');
    expect(numberToWords(118)).toBe('One Hundred Eighteen');
  });

  it('converts thousands correctly', () => {
    expect(numberToWords(1234)).toBe('One Thousand Two Hundred Thirty Four');
    expect(numberToWords(100050)).toBe('One Hundred Thousand Fifty');
  });

  it('converts millions, billions, and trillions correctly', () => {
    expect(numberToWords(1000000)).toBe('One Million');
    expect(numberToWords(1234567)).toBe('One Million Two Hundred Thirty Four Thousand Five Hundred Sixty Seven');
    expect(numberToWords(999999999999)).toBe(
      'Nine Hundred Ninety Nine Billion Nine Hundred Ninety Nine Million Nine Hundred Ninety Nine Thousand Nine Hundred Ninety Nine'
    );
    expect(numberToWords(1000000000000)).toBe('One Trillion');
  });
});

describe('amountToWords', () => {
  it('converts amounts without fractions correctly', () => {
    expect(amountToWords(118.0, 'USD')).toBe('One Hundred Eighteen Dollars Only');
    expect(amountToWords(0, 'USD')).toBe('Zero Dollars Only');
  });

  it('converts amounts with fractions correctly', () => {
    expect(amountToWords(1234.56, 'INR')).toBe(
      'One Thousand Two Hundred Thirty Four Rupees and Fifty Six Paise Only'
    );
    expect(amountToWords(50.05, 'EUR')).toBe('Fifty Euros and Five Cents Only');
  });

  it('falls back to generic currency for unknown currency code', () => {
    expect(amountToWords(100, 'XYZ')).toBe('One Hundred Units Only');
    expect(amountToWords(100.5, 'XYZ')).toBe('One Hundred Units and Fifty Subunits Only');
  });

  it('handles case-insensitive currency codes', () => {
    expect(amountToWords(100, 'usd')).toBe('One Hundred Dollars Only');
  });

  // [Penny H1] Half-cent boundary regression: subtracting the whole part first
  // loses float precision and silently dropped the cent (1.005 -> "One Dollars Only").
  it('does not silently drop cents at half-cent boundaries', () => {
    // 1.005: previously rounded 0.00499... to 0 cents. Should be 1 cent.
    expect(amountToWords(1.005, 'USD')).toBe('One Dollars and One Cents Only');
    // 2.675: classic float representation (2.675 -> 2.67499...). Should be 68 cents.
    expect(amountToWords(2.675, 'USD')).toBe('Two Dollars and Sixty Eight Cents Only');
  });

  it('carries rounding into the whole part correctly', () => {
    // 1.999 rounds to 200 cents -> 2 dollars, 0 cents.
    expect(amountToWords(1.999, 'USD')).toBe('Two Dollars Only');
  });

  it('handles zero and single-cent amounts', () => {
    expect(amountToWords(0, 'USD')).toBe('Zero Dollars Only');
    expect(amountToWords(0.01, 'USD')).toBe('Zero Dollars and One Cents Only');
  });

  it('handles large amounts with cents without dropping precision', () => {
    expect(amountToWords(999999.99, 'USD')).toBe(
      'Nine Hundred Ninety Nine Thousand Nine Hundred Ninety Nine Dollars and Ninety Nine Cents Only'
    );
  });

  it('handles negative amounts using absolute value and keeps cents', () => {
    // amountToWords works on the absolute value; cents must not be dropped.
    expect(amountToWords(-1.005, 'USD')).toBe('One Dollars and One Cents Only');
    expect(amountToWords(-50.05, 'EUR')).toBe('Fifty Euros and Five Cents Only');
  });
});
