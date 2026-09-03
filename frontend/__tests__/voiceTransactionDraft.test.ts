import * as fs from 'fs';
import * as path from 'path';
import { buildVoiceTransactionDraft, resolveAgainstInvoiceTarget, VOICE_TRANSACTION_GUIDANCE } from '../src/accountingV2/voiceTransactionDraft';

describe('voice transaction draft recovery', () => {
  it('turns non-transaction speech into editable guidance, not an internal validator error', () => {
    expect(() => buildVoiceTransactionDraft({ intent: 'unknown', summary: 'Hello 1 2 3' }))
      .toThrow(VOICE_TRANSACTION_GUIDANCE);
    expect(VOICE_TRANSACTION_GUIDANCE).not.toMatch(/unsupported AI action/i);
  });

  it('builds a validated expense proposal from a recognized command', () => {
    const draft = buildVoiceTransactionDraft({
      intent: 'expense', amount: 100, date: '2026-08-31', category: 'Fuel', summary: 'Paid 100 for fuel',
    });
    expect(draft.validation.ok).toBe(true);
    expect(draft.validation.action.type).toBe('add_expense');
    expect(draft.validation.action.params.amount).toBe(100);
  });

  it('does not guess among multiple unpaid invoices', () => {
    const invoices = [
      { id: 'inv-old', date: '2026-01-01', invoiceNumber: 'INV-1' },
      { id: 'inv-new', date: '2026-02-01', invoiceNumber: 'INV-2' },
    ];
    expect(() => resolveAgainstInvoiceTarget({ intent: 'receipt', receiptMode: 'against_invoice', customerName: 'Ali', amount: 50, summary: 'received 50 from Ali' }, invoices))
      .toThrow(/2 unpaid invoices/i);
    expect(resolveAgainstInvoiceTarget({ intent: 'receipt', receiptMode: 'against_invoice', customerName: 'Ali', amount: 50, summary: 'received 50 from Ali' }, [invoices[1]]))
      .toEqual({ invoiceId: 'inv-new' });
    expect(resolveAgainstInvoiceTarget({ intent: 'receipt', receiptMode: 'against_invoice', customerName: 'Ali', amount: 50, summary: 'received 50 from Ali' }, []))
      .toEqual({ mode: 'advance' });
  });

  it('routes the Ask AI microphone to the same transaction assistant', () => {
    const ask = fs.readFileSync(path.join(__dirname, '..', 'app', 'ask.tsx'), 'utf8');
    expect(ask).toContain('accessibilityLabel="Open voice transaction assistant"');
    expect(ask).toContain('router.push("/voice" as Href)');
    expect(ask).not.toContain('Adding it to this chat');
  });
});
