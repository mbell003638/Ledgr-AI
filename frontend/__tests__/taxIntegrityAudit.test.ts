const mem: Record<string, string> = {};
const secure: Record<string, string> = {};

function installMocks() {
  jest.doMock('@react-native-async-storage/async-storage', () => ({
    __esModule: true,
    default: {
      getItem: jest.fn(async (key: string) => (key in mem ? mem[key] : null)),
      setItem: jest.fn(async (key: string, value: string) => { mem[key] = value; }),
      removeItem: jest.fn(async (key: string) => { delete mem[key]; }),
      multiGet: jest.fn(async (keys: string[]) => keys.map((key) => [key, key in mem ? mem[key] : null])),
      multiSet: jest.fn(async (pairs: [string, string][]) => { for (const [key, value] of pairs) mem[key] = value; }),
      multiRemove: jest.fn(async (keys: string[]) => { for (const key of keys) delete mem[key]; }),
    },
  }));
  jest.doMock('expo-secure-store', () => ({
    __esModule: true,
    getItemAsync: jest.fn(async (key: string) => (key in secure ? secure[key] : null)),
    setItemAsync: jest.fn(async (key: string, value: string) => { secure[key] = value; }),
    deleteItemAsync: jest.fn(async (key: string) => { delete secure[key]; }),
  }));
  const { DatabaseSync } = require('node:sqlite');
  const holder: { db: any } = { db: null };
  jest.doMock('../src/db/expoRunner', () => ({
    __esModule: true,
    getExpoRunner: jest.fn(async () => {
      if (!holder.db) holder.db = new DatabaseSync(':memory:');
      const db = holder.db;
      return {
        exec: async (sql: string) => { db.exec(sql); },
        run: async (sql: string, params: any[] = []) => { db.prepare(sql).run(...params); },
        all: async (sql: string, params: any[] = []) => db.prepare(sql).all(...params),
        first: async (sql: string, params: any[] = []) => db.prepare(sql).get(...params) ?? null,
      };
    }),
  }));
}

function resetMocks() {
  for (const key of Object.keys(mem)) delete mem[key];
  for (const key of Object.keys(secure)) delete secure[key];
}

async function boot(basis: 'accrual' | 'cash' = 'accrual') {
  const backend = require('../src/db/backend');
  const init = await backend.initStorage();
  if (init.mode !== 'sqlite') throw new Error('sqlite mode failed');
  const { api } = require('../src/api');
  const bookId = api.activeBookId();
  await api.initializeV2Book({
    book: { id: bookId, name: 'Tax Book', style: 'standard', basis },
    period: { id: bookId + ':period:2026', startDate: '2026-01-01', endDate: '2026-12-31' },
    personas: ['custom'],
  });
  await api.updateSettings({ businessName: 'Tax Book', currency: 'USD', hasOnboarded: true, taxRate: 10, taxLabel: 'VAT' });
  return api;
}

describe('tax integrity audit regressions', () => {
  beforeEach(() => {
    jest.resetModules();
    resetMocks();
    installMocks();
  });

  it('posts bill input tax and proportional linked notes so source tax reconciles to range GL 2300', async () => {
    const api = await boot('accrual');
    const supplier = await api.findOrCreateParty('Tax Supplier', 'supplier');
    const customer = await api.findOrCreateParty('Tax Customer', 'customer');

    const bill = await api.createBill({
      supplierId: supplier.id,
      date: '2026-04-01',
      amount: 55,
      subtotal: 50,
      tax: 5,
      taxRate: 10,
      paymentType: 'credit',
    });
    const invoice = await api.createInvoice({
      partyId: customer.id,
      date: '2026-04-02',
      total: 110,
      subtotal: 100,
      tax: 10,
      taxRate: 10,
    });

    expect(bill.source.metadata).toMatchObject({ total: 55, subtotal: 50, tax: 5, taxRate: 10 });
    expect(bill.journal.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: expect.stringMatching(/:2300$/), debit: 5, credit: 0 }),
    ]));

    const beforeNotes = await api.taxReport('2026-04-01', '2026-04-30');
    expect(beforeNotes).toMatchObject({
      outputTax: 10,
      inputTax: 5,
      netTaxPayable: 5,
      glTaxPayable: 5,
      taxReconciliationDifference: 0,
      taxReconciled: true,
    });

    const customerCredit = await api.createCreditNote({
      customerId: customer.id,
      invoiceId: invoice.source.id,
      date: '2026-04-03',
      amount: 110,
      reason: 'Full return',
    });
    expect(customerCredit.source.metadata).toMatchObject({ total: 110, subtotal: 100, tax: 10, taxRate: 10 });
    expect(customerCredit.journal.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: expect.stringMatching(/:2300$/), debit: 10, credit: 0 }),
    ]));

    const afterCustomerCredit = await api.taxReport('2026-04-01', '2026-04-30');
    expect(afterCustomerCredit).toMatchObject({
      creditNoteTax: 10,
      netOutputTax: 0,
      inputTax: 5,
      netTaxPayable: -5,
      glTaxPayable: -5,
      taxReconciliationDifference: 0,
      taxReconciled: true,
    });

    const supplierCredit = await api.createCreditNote({
      role: 'supplier',
      supplierId: supplier.id,
      invoiceId: bill.source.id,
      date: '2026-04-04',
      amount: 55,
      reason: 'Full supplier return',
    });
    expect(supplierCredit.source.metadata).toMatchObject({ total: 55, subtotal: 50, tax: 5, taxRate: 10 });
    expect(supplierCredit.journal.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: expect.stringMatching(/:2300$/), debit: 0, credit: 5 }),
    ]));

    const fullyReversed = await api.taxReport('2026-04-01', '2026-04-30');
    expect(fullyReversed).toMatchObject({
      supplierCreditNoteTax: 5,
      inputTax: 0,
      netTaxPayable: 0,
      glTaxPayable: 0,
      taxReconciliationDifference: 0,
      taxReconciled: true,
    });
  });

  it('keeps cash-basis recognition computed and surfaces its timing difference from the accrual GL', async () => {
    const api = await boot('cash');
    const customer = await api.findOrCreateParty('Cash Tax Customer', 'customer');
    await api.createInvoice({
      partyId: customer.id,
      date: '2026-05-01',
      total: 110,
      subtotal: 100,
      tax: 10,
      taxRate: 10,
    });

    const report = await api.taxReport('2026-05-01', '2026-05-31');
    expect(report).toMatchObject({
      basis: 'cash',
      outputTax: 0,
      netTaxPayable: 0,
      glTaxPayable: 10,
      taxReconciliationDifference: -10,
      taxReconciled: false,
      glReconciliationApplicable: false,
    });
  });
});
