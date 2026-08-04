/**
 * Drift-safe money arithmetic.
 *
 * JavaScript numbers are IEEE-754 doubles, so decimal money math accumulates
 * error (the classic 0.1 + 0.2 = 0.30000000000000004). For a ledger that sums
 * thousands of transactions and multiplies by commission/tax rates, that drift
 * can eventually surface as an off-by-a-cent figure.
 *
 * This module does all arithmetic in INTEGER CENTS (minor units) and only
 * converts back to a decimal at the boundary. Storage stays decimal (no data
 * migration required) — we simply route summation and multiplication through
 * here so the math itself is exact.
 *
 *   toCents(1.005)      -> 101   (rounds half away from zero, like a cash drawer)
 *   fromCents(101)      -> 1.01
 *   sumMoney([...])     -> exact decimal sum
 *   mulMoney(a, factor) -> a * factor, rounded to the nearest cent
 *   pctOf(a, pct)       -> a * pct%, rounded to the nearest cent
 */

/**
 * Parse a user-entered money amount, accepting grouping commas, spaces and
 * locale-style decimal commas commonly produced by mobile keyboards.
 */
export function parseMoneyInput(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  let text = String(value ?? '').trim().replace(/[\s\u00A0\u202F]/g, '');
  if (!text) return NaN;
  text = text.replace(/[^0-9,\.\-+]/g, '');
  if (!/\d/.test(text)) return NaN;
  const comma = text.lastIndexOf(',');
  const dot = text.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    text = comma > dot ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  } else if (comma >= 0) {
    const fractionalDigits = text.length - comma - 1;
    text = fractionalDigits > 0 && fractionalDigits <= 2 ? text.replace(',', '.') : text.replace(/,/g, '');
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : NaN;
}
/** Coerce any value to a finite number, defaulting to 0. */
export function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Convert a decimal amount to integer cents, rounding half away from zero.
 * The + 0.5 / Number.EPSILON nudge avoids representation error at the .xx5 edge
 * (e.g. 1.005 stored as 1.00499999… would otherwise floor to 100).
 */
export function toCents(amount: any): number {
  const n = num(amount);
  const sign = n < 0 ? -1 : 1;
  const scaled = Math.abs(n) * 100;
  // nudge past floating boundary before rounding
  return sign * Math.round(scaled + Number.EPSILON * scaled);
}

/** Convert integer cents back to a decimal amount with 2 dp. */
export function fromCents(cents: number): number {
  return Math.round(num(cents)) / 100;
}

/** Round a decimal to the nearest cent using integer-cent math (drift-safe round2). */
export function round2(amount: any): number {
  return fromCents(toCents(amount));
}

/** Exact sum of a list of {amount} records (or raw numbers). */
export function sumMoney(items: Array<{ amount?: any } | number> | null | undefined): number {
  if (!Array.isArray(items)) return 0;
  const cents = items.reduce<number>(
    (c, it) => c + toCents(typeof it === 'number' ? it : it?.amount),
    0,
  );
  return fromCents(cents);
}

/** Exact sum of already-numeric decimal values. */
export function addMoney(...amounts: number[]): number {
  return fromCents(amounts.reduce((c, a) => c + toCents(a), 0));
}

/** Exact difference a - b - c ... to the nearest cent. */
export function subMoney(first: number, ...rest: number[]): number {
  return fromCents(rest.reduce((c, a) => c - toCents(a), toCents(first)));
}

/**
 * Multiply a money amount by a plain (non-money) factor and round to the
 * nearest cent. Used for quantity * rate on invoice lines.
 */
export function mulMoney(amount: number, factor: number): number {
  return fromCents(Math.round(toCents(amount) * num(factor)));
}

/**
 * Percentage of a money amount, rounded to the nearest cent.
 * pctOf(200, 7.5) -> 15.00. Used for commission and tax.
 */
export function pctOf(amount: number, pct: number): number {
  return fromCents(Math.round(toCents(amount) * num(pct)) / 100);
}
