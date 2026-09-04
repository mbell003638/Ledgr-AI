import { parseSimpleOutgoingPayment, resolveVoicePartyCommand } from '../src/accountingV2/voicePartyResolution';
import { continueLocalTransaction, parseLocalTransaction } from '../src/accountingV2/localTransactionParser';
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
    if (!unknownResult.ok) {
      expect(unknownResult.question).toMatch(/create a supplier/i);
      expect(unknownResult.createProposal).toMatchObject({ name: 'Amit', suggestedRole: 'supplier' });
    }
  });

  it('does not treat the spoken verb "make" as a new Supplier', () => {
    const unknown = { intent: 'supplier_payment', supplierName: 'make', amount: 100, summary: 'Paid 100 to make' };
    const asked = resolveVoicePartyCommand(unknown, 'paid $100 to make today', {
      suppliers: [], customers: [], capitalAccounts: [],
    });
    expect(asked).toMatchObject({ ok: false });
    if (!asked.ok) expect(asked.question).toMatch(/which/i);
  });

  it('creates a pending Supplier when the user names that role for an unknown party', () => {
    const unknown = { intent: 'supplier_payment', supplierName: 'Make Hardware', amount: 100, summary: 'Paid 100 to Make Hardware' };
    expect(resolveVoicePartyCommand(unknown, 'paid $100 to supplier Make Hardware', {
      suppliers: [], customers: [], capitalAccounts: [],
    })).toMatchObject({
      ok: true,
      command: {
        intent: 'supplier_payment',
        supplierName: 'Make Hardware',
        pendingPartyCreate: { role: 'supplier', name: 'Make Hardware' },
      },
    });
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

describe('continueLocalTransaction capital account clarification', () => {
  it('resolves party_role clarification to drawing when capital account exists', () => {
    const continuation = {
      kind: 'clarification' as const,
      confidence: 'medium' as const,
      field: 'party' as const,
      transcript: 'Paid 100 to Amit',
      question: 'Is Amit a Customer, Supplier, or Capital Account?',
      command: { intent: 'supplier_payment', amount: 100, supplierName: 'Amit' },
    };
    const result = continueLocalTransaction(continuation, 'Capital Account', {
      directory: { suppliers: [supplier], customers: [], capitalAccounts: [capital] },
      requirePaymentMethod: false,
    });
    expect(result).toMatchObject({
      kind: 'confident',
      command: { intent: 'drawing', partnerName: 'Amit', amount: 100 },
    });
  });

  it('rejects creating new Capital Account when none matches', () => {
    const continuation = {
      kind: 'clarification' as const,
      confidence: 'medium' as const,
      field: 'party' as const,
      transcript: 'Paid 100 to NonExistent',
      question: 'Is NonExistent a Customer, Supplier, or Capital Account?',
      command: { intent: 'supplier_payment', amount: 100, supplierName: 'NonExistent' },
    };
    const result = continueLocalTransaction(continuation, 'Capital Account', {
      directory: { suppliers: [], customers: [], capitalAccounts: [capital] },
      requirePaymentMethod: false,
    });
    expect(result).toMatchObject({
      kind: 'clarification',
      question: expect.stringMatching(/Capital Accounts must be added from Accounts/i),
    });
  });
});

describe('spoken capital account drawing and withdrawal parsing', () => {
  it('parses "Paid $100 to amit withdrawal from Capital account" directly as drawing for Amit', () => {
    const parsedOutgoing = parseSimpleOutgoingPayment('Paid $100 to amit withdrawal from Capital account');
    expect(parsedOutgoing).toMatchObject({
      intent: 'drawing',
      partnerName: 'amit',
      amount: 100,
    });

    const resolved = resolveVoicePartyCommand(parsedOutgoing!, 'Paid $100 to amit withdrawal from Capital account', {
      suppliers: [],
      customers: [],
      capitalAccounts: [{ id: '1', name: 'Amit' }],
    });
    expect(resolved).toMatchObject({
      ok: true,
      command: {
        intent: 'drawing',
        partnerName: 'Amit',
        amount: 100,
      },
    });
  });

  it('parses "Paid $100 cash to amit withdrawal from Capital account" with payment method', () => {
    const parsed = parseLocalTransaction('Paid $100 cash to amit withdrawal from Capital account');
    expect(parsed).toMatchObject({
      kind: 'confident',
      command: {
        intent: 'drawing',
        partnerName: 'amit',
        amount: 100,
        method: 'cash',
      },
    });
  });

  it('keeps an ordinary deposit payment a Supplier Payment instead of partner capital', () => {
    expect(parseSimpleOutgoingPayment('Paid 500 to Acme Realty by bank deposit')).toMatchObject({
      intent: 'supplier_payment',
      supplierName: 'Acme Realty',
      method: 'bank',
    });
    expect(parseSimpleOutgoingPayment('Paid $500 to Acme Realty as security deposit')).toMatchObject({
      intent: 'supplier_payment',
    });
  });

  it('still reads explicit capital wording as a contribution or drawing', () => {
    expect(parseSimpleOutgoingPayment('Paid 500 to Amit as capital contribution')).toMatchObject({
      intent: 'capital', partnerName: 'Amit', amount: 500,
    });
    expect(parseSimpleOutgoingPayment('Paid 500 to Amit for capital withdrawal')).toMatchObject({
      intent: 'drawing', partnerName: 'Amit', amount: 500,
    });
    expect(parseSimpleOutgoingPayment('Paid 500 to Amit as a drawing')).toMatchObject({
      intent: 'drawing', partnerName: 'Amit', amount: 500,
    });
  });

  it('does not turn a named Supplier answer into a Capital Account drawing', () => {
    const pending = parseLocalTransaction('Bought goods on credit for 500', { requirePaymentMethod: false });
    expect(pending).toMatchObject({ kind: 'clarification', field: 'party' });
    if (pending.kind !== 'clarification') return;

    // "Sharma Traders" prefix-matches a "Sharma" Capital Account, but the user
    // answered a Supplier question with a Supplier name.
    expect(continueLocalTransaction(pending, 'Sharma Traders', {
      directory: { suppliers: [{ id: 's1', name: 'Sharma Traders' }], customers: [], capitalAccounts: [{ id: 'c1', name: 'Sharma' }] },
      requirePaymentMethod: false,
    })).toMatchObject({ kind: 'confident', command: { intent: 'bill', supplierName: 'Sharma Traders' } });

    // A name held by both records keeps the role the question asked about.
    expect(continueLocalTransaction(pending, 'Amit', {
      directory: { suppliers: [supplier], customers: [], capitalAccounts: [capital] },
      requirePaymentMethod: false,
    })).toMatchObject({ kind: 'confident', command: { intent: 'bill', supplierName: 'Amit' } });

    // Naming the role explicitly still reaches the Capital Account.
    expect(continueLocalTransaction(pending, 'Capital Account Sharma', {
      directory: { suppliers: [{ id: 's1', name: 'Sharma Traders' }], customers: [], capitalAccounts: [{ id: 'c1', name: 'Sharma' }] },
      requirePaymentMethod: false,
    })).toMatchObject({ kind: 'confident', command: { intent: 'drawing', partnerName: 'Sharma' } });
  });

  it('resolves a drawing party question against the Capital Account directory', () => {
    const pending = parseLocalTransaction('Withdrew 500 cash', { requirePaymentMethod: false });
    expect(pending).toMatchObject({ kind: 'clarification', field: 'party' });
    if (pending.kind !== 'clarification') return;
    expect(continueLocalTransaction(pending, 'Amit', {
      directory: { suppliers: [], customers: [], capitalAccounts: [capital] },
      requirePaymentMethod: false,
    })).toMatchObject({ kind: 'confident', command: { intent: 'drawing', partnerName: 'Amit', amount: 500 } });
  });

  it('cleans trailing role noise from candidate name in continueLocalTransaction', () => {
    const continuation = {
      kind: 'clarification' as const,
      confidence: 'medium' as const,
      field: 'party' as const,
      transcript: 'Paid 100 to amit withdrawal from Capital account',
      question: 'Is amit a Customer, Supplier, or Capital Account?',
      command: { intent: 'supplier_payment', amount: 100, supplierName: 'amit withdrawal from Capital account' },
    };
    const result = continueLocalTransaction(continuation, 'Capital Account', {
      directory: { suppliers: [], customers: [], capitalAccounts: [capital] },
      requirePaymentMethod: false,
    });
    expect(result).toMatchObject({
      kind: 'confident',
      command: { intent: 'drawing', partnerName: 'Amit', amount: 100 },
    });
  });
});

