import {
  num,
  toCents,
  fromCents,
  round2,
  sumMoney,
  addMoney,
  subMoney,
  mulMoney,
  pctOf,
} from '../src/money';

describe('toCents() / fromCents()', () => {
  it('round-trips whole and fractional amounts', () => {
    expect(toCents(1.01)).toBe(101);
    expect(toCents(10)).toBe(1000);
    expect(fromCents(101)).toBe(1.01);
    expect(fromCents(1000)).toBe(10);
  });
  it('rounds the .xx5 edge away from zero (cash-drawer rounding)', () => {
    expect(toCents(1.005)).toBe(101); // NOT 100 — the float-drift bug this module fixes
    expect(toCents(2.675)).toBe(268); // classic IEEE-754 trap (2.675 stored as 2.67499…)
  });
  it('handles negatives symmetrically', () => {
    expect(toCents(-1.005)).toBe(-101);
    expect(fromCents(-101)).toBe(-1.01);
  });
  it('coerces junk to 0', () => {
    expect(toCents('abc')).toBe(0);
    expect(toCents(undefined)).toBe(0);
    expect(toCents(NaN)).toBe(0);
  });
});

describe('sumMoney() — drift-safe summation', () => {
  it('sums the classic 0.1 + 0.2 without float drift', () => {
    // Plain JS: 0.1 + 0.2 = 0.30000000000000004
    expect(sumMoney([0.1, 0.2])).toBe(0.3);
  });
  it('sums many small amounts exactly', () => {
    const items = Array.from({ length: 10 }, () => ({ amount: 0.1 }));
    expect(sumMoney(items)).toBe(1); // 10 x 0.1, no drift
  });
  it('sums {amount} records', () => {
    expect(sumMoney([{ amount: 10 }, { amount: 5.5 }, { amount: 0.25 }])).toBe(15.75);
  });
  it('ignores non-array input', () => {
    expect(sumMoney(null)).toBe(0);
    expect(sumMoney(undefined)).toBe(0);
  });
});

describe('addMoney() / subMoney()', () => {
  it('adds exactly', () => {
    expect(addMoney(0.1, 0.2)).toBe(0.3);
    expect(addMoney(100.05, 200.10, 0.85)).toBe(301);
  });
  it('subtracts a chain exactly', () => {
    expect(subMoney(1, 0.9)).toBe(0.1); // plain JS: 0.09999999999999998
    expect(subMoney(500, 100.25, 50.75, 0.5)).toBe(348.5);
  });
});

describe('mulMoney()', () => {
  it('multiplies qty x rate and rounds to a cent', () => {
    expect(mulMoney(19.99, 3)).toBe(59.97);
    expect(mulMoney(0.1, 3)).toBe(0.3);
  });
  it('rounds a fractional result to the nearest cent', () => {
    expect(mulMoney(10.005, 1)).toBe(10.01);
  });
});

describe('pctOf() — commission & tax', () => {
  it('computes a clean percentage', () => {
    expect(pctOf(200, 7.5)).toBe(15);
    expect(pctOf(1000, 2.5)).toBe(25);
  });
  it('rounds fractional-cent results to the nearest cent', () => {
    expect(pctOf(99.99, 18)).toBe(18); // 17.9982 -> 18.00
    expect(pctOf(33.33, 33.33)).toBe(11.11); // 11.109… -> 11.11
  });
  it('handles 0% and junk', () => {
    expect(pctOf(500, 0)).toBe(0);
    expect(pctOf(500, 'x' as any)).toBe(0);
  });
});

describe('num() / round2() re-exports', () => {
  it('num coerces', () => {
    expect(num('12.5')).toBe(12.5);
    expect(num(undefined)).toBe(0);
  });
  it('round2 uses integer-cent rounding', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(10.126)).toBe(10.13);
  });
});
