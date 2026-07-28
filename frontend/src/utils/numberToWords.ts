const ONES: string[] = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];

const TENS: string[] = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
];

const SCALES: { value: number; name: string }[] = [
  { value: 1_000_000_000_000, name: 'Trillion' },
  { value: 1_000_000_000, name: 'Billion' },
  { value: 1_000_000, name: 'Million' },
  { value: 1_000, name: 'Thousand' },
];

function convertChunk(n: number): string {
  if (n === 0) return '';
  if (n < 20) return ONES[n];
  if (n < 100) {
    const tens = TENS[Math.floor(n / 10)];
    const remainder = n % 10;
    return remainder !== 0 ? `${tens} ${ONES[remainder]}` : tens;
  }
  const hundreds = ONES[Math.floor(n / 100)];
  const remainder = n % 100;
  return remainder !== 0 ? `${hundreds} Hundred ${convertChunk(remainder)}` : `${hundreds} Hundred`;
}

/**
 * Converts a number to English words.
 * Handles numbers up to trillions (999,999,999,999+).
 */
export function numberToWords(n: number): string {
  if (!Number.isFinite(n)) return '';
  let num = Math.floor(Math.abs(n));
  if (num === 0) return 'Zero';

  const parts: string[] = [];

  for (const scale of SCALES) {
    if (num >= scale.value) {
      const count = Math.floor(num / scale.value);
      parts.push(`${convertChunk(count)} ${scale.name}`);
      num %= scale.value;
    }
  }

  if (num > 0) {
    parts.push(convertChunk(num));
  }

  return parts.join(' ');
}

export const CURRENCY_WORDS: Record<string, { main: string; sub: string; subUnit: number }> = {
  USD: { main: 'Dollars', sub: 'Cents', subUnit: 100 },
  INR: { main: 'Rupees', sub: 'Paise', subUnit: 100 },
  EUR: { main: 'Euros', sub: 'Cents', subUnit: 100 },
  GBP: { main: 'Pounds', sub: 'Pence', subUnit: 100 },
  AED: { main: 'Dirhams', sub: 'Fils', subUnit: 100 },
  CAD: { main: 'Dollars', sub: 'Cents', subUnit: 100 },
  AUD: { main: 'Dollars', sub: 'Cents', subUnit: 100 },
  NGN: { main: 'Naira', sub: 'Kobo', subUnit: 100 },
  KES: { main: 'Shillings', sub: 'Cents', subUnit: 100 },
  ZAR: { main: 'Rand', sub: 'Cents', subUnit: 100 },
  BDT: { main: 'Taka', sub: 'Paisa', subUnit: 100 },
  PKR: { main: 'Rupees', sub: 'Paisa', subUnit: 100 },
  PHP: { main: 'Pesos', sub: 'Centavos', subUnit: 100 },
  MXN: { main: 'Pesos', sub: 'Centavos', subUnit: 100 },
  BRL: { main: 'Reais', sub: 'Centavos', subUnit: 100 },
};

/**
 * Converts a monetary amount to English words with currency formatting.
 */
export function amountToWords(amount: number, currencyCode: string = 'USD'): string {
  const absAmount = Math.abs(amount);
  let whole = Math.floor(absAmount);
  let fractional = Math.round((absAmount - whole) * 100);

  if (fractional >= 100) {
    whole += Math.floor(fractional / 100);
    fractional = fractional % 100;
  }

  const currency = CURRENCY_WORDS[currencyCode.toUpperCase()] || {
    main: 'Units',
    sub: 'Subunits',
    subUnit: 100,
  };

  const wholeWords = numberToWords(whole);

  if (fractional === 0) {
    return `${wholeWords} ${currency.main} Only`;
  }

  const fractionalWords = numberToWords(fractional);
  return `${wholeWords} ${currency.main} and ${fractionalWords} ${currency.sub} Only`;
}
