import { parseAssistantIntent } from '../src/utils/assistantIntent';

describe('Assistant intent contract', () => {
  it('creates a confirmation-required payment draft', () => {
    const result = parseAssistantIntent('ledgr://assistant?action=record_payment&amount=100&counterparty=Amit&date=2026-09-01');
    expect(result).toEqual({
      kind: 'draft',
      draft: expect.objectContaining({
        action: 'record_payment', amount: 100, counterparty: 'Amit',
        requiresConfirmation: true, source: 'android-assistant',
      }),
    });
  });

  it('rejects unsafe or malformed payloads', () => {
    expect(parseAssistantIntent({ action: 'record_payment', amount: -1 }).kind).toBe('rejected');
    expect(parseAssistantIntent({ action: 'record_payment' }).kind).toBe('rejected');
    expect(parseAssistantIntent({ action: 'record_payment', amount: 1, note: 'x'.repeat(241) }).kind).toBe('rejected');
    expect(parseAssistantIntent({ action: 'delete_all_data' }).kind).toBe('rejected');
  });

  it('supports navigation actions without ledger writes', () => {
    expect(parseAssistantIntent({ action: 'open_ask_ai' })).toEqual({ kind: 'navigation', target: 'ask-ai' });
    expect(parseAssistantIntent({ action: 'open_scanner' })).toEqual({ kind: 'navigation', target: 'scanner' });
  });
});
