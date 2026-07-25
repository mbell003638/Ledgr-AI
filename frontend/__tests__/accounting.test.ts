import {
  num,
  round2,
  sumAmounts,
  computeCogs,
  grossProfit,
  commission,
  netProfit,
  closingCapital,
  partnerShare,
  computePnl,
  computeCash,
  computeNetWorth,
} from '../src/accounting';

describe('num()', () => {
  it('coerces valid numbers', () => {
    expect(num(5)).toBe(5);
    expect(num('12.5')).toBe(12.5);
  });
  it('defaults invalid/empty to 0', () => {
    expect(num(undefined)).toBe(0);
    expect(num(null)).toBe(0);
    expect(num('abc')).toBe(0);
    expect(num(NaN)).toBe(0);
    expect(num(Infinity)).toBe(0);
  });
});

describe('round2()', () => {
  it('rounds to 2 decimals (drift-safe, half away from zero)', () => {
    expect(round2(1.005)).toBe(1.01); // integer-cent math rounds the .005 edge up
    expect(round2(10.126)).toBe(10.13);
    expect(round2(10)).toBe(10);
  });
});

describe('sumAmounts()', () => {
  it('sums {amount} records', () => {
    expect(sumAmounts([{ amount: 10 }, { amount: 5.5 }])).toBe(15.5);
  });
  it('sums raw numbers', () => {
    expect(sumAmounts([1, 2, 3])).toBe(6);
  });
  it('handles empty / null / bad values', () => {
    expect(sumAmounts([])).toBe(0);
    expect(sumAmounts(null)).toBe(0);
    expect(sumAmounts(undefined)).toBe(0);
    expect(sumAmounts([{ amount: 'x' }, { amount: undefined }, { amount: 4 }])).toBe(4);
  });
});

describe('computeCogs() — periodic inventory', () => {
  it('uses opening + purchases - closing when a closing count exists', () => {
    // opening 100 + purchases 500 - closing 150 = 450
    expect(computeCogs(100, 500, 150, true)).toBe(450);
  });
  it('falls back to purchases when no closing count', () => {
    expect(computeCogs(100, 500, 150, false)).toBe(500);
  });
  it('handles zero/garbage inputs', () => {
    expect(computeCogs(0, 0, 0, true)).toBe(0);
    expect(computeCogs(undefined as any, undefined as any, undefined as any, false)).toBe(0);
  });
});

describe('grossProfit()', () => {
  it('sales - cogs', () => {
    expect(grossProfit(1000, 450)).toBe(550);
  });
  it('can go negative (loss)', () => {
    expect(grossProfit(100, 300)).toBe(-200);
  });
});

describe('commission()', () => {
  it('accrues on positive gross profit', () => {
    expect(commission(1000, 10)).toBe(100);
    expect(commission(550, 5)).toBe(27.5);
  });
  it('is zero when gross profit <= 0', () => {
    expect(commission(0, 10)).toBe(0);
    expect(commission(-500, 10)).toBe(0);
  });
  it('is zero when pct is 0', () => {
    expect(commission(1000, 0)).toBe(0);
  });
});

describe('netProfit()', () => {
  it('gross - commission - expenses - drawings', () => {
    // 550 - 55 - 100 - 50 = 345
    expect(netProfit(550, 55, 100, 50)).toBe(345);
  });
  it('handles missing components as 0', () => {
    expect(netProfit(500, 0, 0, 0)).toBe(500);
  });
});

describe('closingCapital()', () => {
  it('opening + net profit - drawings', () => {
    // 5000 + 1200 - 300 = 5900
    expect(closingCapital(5000, 1200, 300)).toBe(5900);
  });
});

describe('partnerShare()', () => {
  it('splits net profit equally', () => {
    expect(partnerShare(1000, 2)).toBe(500);
    expect(partnerShare(1000, 4)).toBe(250);
  });
  it('guards against divide-by-zero', () => {
    expect(partnerShare(1000, 0)).toBe(1000);
    expect(partnerShare(1000, undefined as any)).toBe(1000);
  });
});

describe('computeCash()', () => {
  it('opening + sales - supplier payments - drawings', () => {
    // 2000 + 5000 - 1500 - 500 = 5000
    expect(computeCash(2000, 5000, 1500, 500)).toBe(5000);
  });
  it('also subtracts commission payments', () => {
    // 2000 + 5000 - 1500 - 500 - 300 = 4700
    expect(computeCash(2000, 5000, 1500, 500, 300)).toBe(4700);
  });
  it('commission payments default to 0 when omitted', () => {
    expect(computeCash(1000, 0, 0, 0)).toBe(1000);
  });
});

describe('computeNetWorth()', () => {
  it('assets - liabilities', () => {
    expect(computeNetWorth(10000, 3500)).toBe(6500);
  });
});

describe('computePnl() — full period P&L', () => {
  it('computes a realistic period with closing stock', () => {
    const r = computePnl({
      sales: 10000,
      purchases: 6000,
      openingStock: 2000,
      closingStock: 2500,
      hasClosingCount: true,
      expenses: 800,
      drawings: 500,
      commissionPct: 10,
    });
    // COGS = 2000 + 6000 - 2500 = 5500
    expect(r.cogs).toBe(5500);
    // Gross = 10000 - 5500 = 4500
    expect(r.grossProfit).toBe(4500);
    // Commission = 4500 * 10% = 450
    expect(r.commission).toBe(450);
    // Net = 4500 - 450 - 800 - 500 = 2750
    expect(r.netProfit).toBe(2750);
  });

  it('falls back to purchases as COGS before first stock take', () => {
    const r = computePnl({
      sales: 1000,
      purchases: 700,
      openingStock: 0,
      closingStock: 0,
      hasClosingCount: false,
      expenses: 0,
      drawings: 0,
      commissionPct: 0,
    });
    expect(r.cogs).toBe(700);
    expect(r.grossProfit).toBe(300);
    expect(r.commission).toBe(0);
    expect(r.netProfit).toBe(300);
  });

  it('handles an empty/zero period without NaN', () => {
    const r = computePnl({
      sales: 0, purchases: 0, openingStock: 0, closingStock: 0,
      hasClosingCount: false, expenses: 0, drawings: 0, commissionPct: 10,
    });
    expect(r.revenue).toBe(0);
    expect(r.cogs).toBe(0);
    expect(r.grossProfit).toBe(0);
    expect(r.commission).toBe(0);
    expect(r.netProfit).toBe(0);
    expect(Number.isNaN(r.netProfit)).toBe(false);
  });

  it('reports a loss (negative net) correctly, no commission on loss', () => {
    const r = computePnl({
      sales: 1000, purchases: 1500, openingStock: 0, closingStock: 0,
      hasClosingCount: false, expenses: 200, drawings: 0, commissionPct: 10,
    });
    // COGS 1500, gross = -500, commission 0, net = -500 - 200 = -700
    expect(r.grossProfit).toBe(-500);
    expect(r.commission).toBe(0);
    expect(r.netProfit).toBe(-700);
  });
});
