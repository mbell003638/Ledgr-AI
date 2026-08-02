import {
  executeV2AiAction,
  validateV2AiAction,
  type V2WriteExecutor,
  executeAssistantProposal,
  validateAssistantProposal,
} from '../src/accountingV2/aiActions';

describe('V2 AI/voice action validation', () => {
  it('represents report, party, and inventory/profit queries as validated read intents', () => {
    expect(validateV2AiAction({
      source: 'voice', intent: 'report_query', report: 'profit_and_loss',
      from: '2026-01-01', to: '2026-01-31',
    })).toEqual({ ok: true, action: {
      source: 'voice', intent: 'report_query', access: 'read', report: 'profit_and_loss',
      from: '2026-01-01', to: '2026-01-31',
    }});

    expect(validateV2AiAction({ source: 'ai', intent: 'party_lookup', query: 'Acme', role: 'customer' }))
      .toEqual({ ok: true, action: { source: 'ai', intent: 'party_lookup', access: 'read', query: 'Acme', role: 'customer' } });

    expect(validateV2AiAction({ source: 'voice', intent: 'inventory_profit', from: '2026-02-01', to: '2026-02-28' }))
      .toEqual({ ok: true, action: { source: 'voice', intent: 'inventory_profit', access: 'read', from: '2026-02-01', to: '2026-02-28' } });
  });

  it('returns a confirmation preview for invoice creation', () => {
    const result = validateV2AiAction({
      source: 'voice', intent: 'create_invoice', partyId: 'party-1', date: '2026-03-10',
      lines: [{ description: 'Consulting', quantity: 2, unitPrice: 125 }],
    });
    expect(result).toEqual({ ok: true, action: {
      source: 'voice', intent: 'create_invoice', access: 'write', partyId: 'party-1', date: '2026-03-10',
      lines: [{ description: 'Consulting', quantity: 2, unitPrice: 125 }],
      confirmation: { required: true, preview: 'Create invoice for party-1 on 2026-03-10: 1 line, total 250.00' },
    }});
  });

  it('returns confirmation previews for payment and close-books writes', () => {
    expect(validateV2AiAction({
      source: 'ai', intent: 'create_payment', partyId: 'party-2', date: '2026-03-11',
      amount: 75.5, method: 'bank', direction: 'received', invoiceId: 'invoice-1',
    })).toEqual({ ok: true, action: {
      source: 'ai', intent: 'create_payment', access: 'write', partyId: 'party-2', date: '2026-03-11',
      amount: 75.5, method: 'bank', direction: 'received', invoiceId: 'invoice-1',
      confirmation: { required: true, preview: 'Record bank payment received of 75.50 for party-2 on 2026-03-11' },
    }});

    expect(validateV2AiAction({ source: 'voice', intent: 'close_books', periodId: '2026-03', date: '2026-03-31' }))
      .toEqual({ ok: true, action: {
        source: 'voice', intent: 'close_books', access: 'write', periodId: '2026-03', date: '2026-03-31',
        confirmation: { required: true, preview: 'Close books for period 2026-03 on 2026-03-31' },
      }});
  });

  it.each([
    [{ source: 'chat', intent: 'party_lookup', query: 'x' }, 'source'],
    [{ source: 'ai', intent: 'unknown' }, 'intent'],
    [{ source: 'ai', intent: 'report_query', report: 'sales', from: '2026-01-01', to: '2026-01-31' }, 'report'],
    [{ source: 'ai', intent: 'report_query', report: 'cash_flow', from: '01/01/26', to: '2026-01-31' }, 'from'],
    [{ source: 'ai', intent: 'party_lookup', query: '   ' }, 'query'],
    [{ source: 'ai', intent: 'create_invoice', partyId: '', date: '2026-01-01', lines: [] }, 'partyId'],
    [{ source: 'ai', intent: 'create_payment', partyId: 'p1', date: '2026-01-01', amount: 0, method: 'cash', direction: 'received' }, 'amount'],
    [{ source: 'ai', intent: 'close_books', periodId: '', date: '2026-01-01' }, 'periodId'],
  ])('rejects invalid input %j', (input, field) => {
    const result = validateV2AiAction(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((error) => error.includes(field))).toBe(true);
  });

  it('does not execute a write without explicit confirmation', async () => {
    const validated = validateV2AiAction({
      source: 'ai', intent: 'create_payment', partyId: 'party-2', date: '2026-03-11',
      amount: 75, method: 'cash', direction: 'received',
    });
    const executor: V2WriteExecutor<string> = jest.fn(async () => 'created');

    await expect(executeV2AiAction(validated, { confirmed: false }, executor)).rejects.toThrow(/explicit confirmation/i);
    expect(executor).not.toHaveBeenCalled();
  });

  it('executes a validated write only after explicit confirmation', async () => {
    const validated = validateV2AiAction({
      source: 'ai', intent: 'close_books', periodId: '2026-03', date: '2026-03-31',
    });
    const executor: V2WriteExecutor<string> = jest.fn(async (action) => `${action.intent}:done`);

    await expect(executeV2AiAction(validated, { confirmed: true }, executor)).resolves.toBe('close_books:done');
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('never executes invalid or read-only actions through the write gate', async () => {
    const executor: V2WriteExecutor<string> = jest.fn(async () => 'bad');
    const invalid = validateV2AiAction({ source: 'ai', intent: 'create_payment', amount: -1 });
    const read = validateV2AiAction({ source: 'ai', intent: 'party_lookup', query: 'Acme' });

    await expect(executeV2AiAction(invalid, { confirmed: true }, executor)).rejects.toThrow(/invalid action/i);
    await expect(executeV2AiAction(read, { confirmed: true }, executor)).rejects.toThrow(/write action/i);
    expect(executor).not.toHaveBeenCalled();
  });
  it('validates the actual proposed AI action rather than a generic payment proxy', async () => {
    const debtor = validateAssistantProposal({ type: 'add_debtor', params: { name: 'Amit' } }, 'ai');
    expect(debtor).toMatchObject({ ok: true, action: { type: 'add_debtor', params: { name: 'Amit' } } });
    expect(validateAssistantProposal({ type: 'add_bill', params: { amount: 25, date: '2026-01-01' } }, 'ai')).toEqual({ ok: false, errors: ['supplierName is required'] });
    expect(validateAssistantProposal({ type: 'create_receipt', params: { amount: 10, date: '2026-01-01', mode: 'against_invoice' } }, 'ai')).toEqual({ ok: false, errors: ['customerName is required for an invoice receipt'] });
    await expect(executeAssistantProposal(debtor, { confirmed: false }, () => 'bad')).rejects.toThrow(/explicit confirmation/i);
    await expect(executeAssistantProposal(debtor, { confirmed: true }, () => 'saved')).resolves.toBe('saved');
  });
});
