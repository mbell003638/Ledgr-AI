import { parseSimpleOutgoingPayment, resolveVoicePartyCommand } from '../src/accountingV2/voicePartyResolution';
import { V2AppService } from '../src/accountingV2/appService';

const supplier = { id: 'supplier-amit', name: 'Amit' };
const customer = { id: 'customer-amit', name: 'Amit' };
const capital = { id: 'member-amit', name: 'Amit' };
const command = { intent: 'supplier_payment', supplierName: 'Amit', amount: 100, summary: 'Paid 100 to Amit' };

describe('voice party-role resolution', () => {
  it('routes an exact Capital Account-only payment to a withdrawal without another role question', () => {
    const result = resolveVoicePartyCommand(command, 'Paid 100 to Amit', {
      suppliers: [], customers: [], capitalAccounts: [capital],
    });
    expect(result).toMatchObject({
      ok: true,
      command: { intent: 'drawing', partnerName: 'Amit', amount: 100 },
    });
  });

  it('parses a currency-after-amount outgoing payment for local exact matching', () => {
    expect(parseSimpleOutgoingPayment('Paid 100$ today to Amit')).toMatchObject({
      intent: 'supplier_payment',
      supplierName: 'Amit',
      amount: 100,
    });
  });

  it('keeps Supplier Payment when only an exact Supplier matches', () => {
    expect(resolveVoicePartyCommand(command, 'Paid 100 to Amit', {
      suppliers: [supplier], customers: [], capitalAccounts: [],
    })).toMatchObject({
      ok: true,
      command: { intent: 'supplier_payment', supplierName: 'Amit' },
    });
  });

  it('asks a counter-question when the same name has more than one role', () => {
    const result = resolveVoicePartyCommand(command, 'Paid 100 to Amit', {
      suppliers: [supplier], customers: [], capitalAccounts: [capital],
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.question).toMatch(/Supplier.*Capital Account.*say/i);
  });

  it('honors an explicit Supplier or Capital Account role when duplicate names exist', () => {
    const directory = { suppliers: [supplier], customers: [], capitalAccounts: [capital] };
    expect(resolveVoicePartyCommand(command, 'Pay supplier Amit 100', directory)).toMatchObject({
      ok: true,
      command: { intent: 'supplier_payment', supplierName: 'Amit' },
    });
    expect(resolveVoicePartyCommand(command, 'Withdraw 100 capital from Amit', directory)).toMatchObject({
      ok: true,
      command: { intent: 'drawing', partnerName: 'Amit' },
    });
  });

  it('does not silently turn a Customer or unknown name into a Supplier', () => {
    const customerResult = resolveVoicePartyCommand(command, 'Paid 100 to Amit', {
      suppliers: [], customers: [customer], capitalAccounts: [],
    });
    const unknownResult = resolveVoicePartyCommand(command, 'Paid 100 to Amit', {
      suppliers: [], customers: [], capitalAccounts: [],
    });
    expect(customerResult).toMatchObject({ ok: false });
    expect(unknownResult).toMatchObject({ ok: false });
  });

  it('requires an existing exact Customer for a receipt', () => {
    const receipt = { intent: 'receipt', customerName: 'Amit', amount: 100, summary: 'Received 100 from Amit' };
    expect(resolveVoicePartyCommand(receipt, 'Received 100 from Amit', {
      suppliers: [], customers: [customer], capitalAccounts: [],
    })).toMatchObject({ ok: true, command: { intent: 'receipt', customerName: 'Amit' } });
    expect(resolveVoicePartyCommand(receipt, 'Received 100 from Amit', {
      suppliers: [], customers: [], capitalAccounts: [capital],
    })).toMatchObject({ ok: false });
  });

  it('recovers a paid-to Capital Account even when the provider labeled it as a bill', () => {
    const result = resolveVoicePartyCommand(
      { intent: 'bill', supplierName: 'Amit', amount: 100 },
      'Paid 100 to Amit',
      { suppliers: [], customers: [], capitalAccounts: [capital] },
    );
    expect(result).toMatchObject({ ok: true, command: { intent: 'drawing', partnerName: 'Amit' } });
  });

  it('requires an exact existing Supplier for bills but allows an unnamed walk-in cash sale receipt', () => {
    expect(resolveVoicePartyCommand(
      { intent: 'bill', supplierName: 'Amit', amount: 100 },
      'Bought inventory from supplier Amit',
      { suppliers: [supplier], customers: [], capitalAccounts: [] },
    )).toMatchObject({ ok: true, command: { intent: 'bill', supplierName: 'Amit' } });
    expect(resolveVoicePartyCommand(
      { intent: 'receipt', receiptMode: 'cash_sale', amount: 100 },
      'Cash sale 100',
      { suppliers: [], customers: [], capitalAccounts: [] },
    )).toMatchObject({ ok: true, command: { intent: 'receipt', receiptMode: 'cash_sale' } });
  });
});


describe('authoritative Capital Account name protection', () => {
  it('rejects Customer or Supplier creation when a Capital Account has the same normalized name', async () => {
    const db = {
      all: jest.fn(async () => [{ name: 'Amit' }]),
    };
    const service = new V2AppService(db as any);
    await expect(service.assertPartyNameAvailable('  amit  ', 'book-1')).rejects.toThrow(/Capital Account named 'amit' already exists/i);
    expect(db.all).toHaveBeenCalledWith('SELECT name FROM v2_members WHERE book_id=?', ['book-1']);
  });

  it('allows a distinct party name', async () => {
    const service = new V2AppService({ all: jest.fn(async () => [{ name: 'Amit' }]) } as any);
    await expect(service.assertPartyNameAvailable('Rahul Supplies', 'book-1')).resolves.toBeUndefined();
  });
});
