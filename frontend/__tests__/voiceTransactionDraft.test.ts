import * as fs from 'fs';
import * as path from 'path';
import { buildVoiceTransactionDraft, VOICE_TRANSACTION_GUIDANCE } from '../src/accountingV2/voiceTransactionDraft';

describe('voice transaction draft recovery', () => {
  it('turns non-transaction speech into guidance, not an internal validator error', () => {
    expect(() => buildVoiceTransactionDraft({ intent: 'unknown', summary: 'Hello 1 2 3' }))
      .toThrow(VOICE_TRANSACTION_GUIDANCE);
    expect(VOICE_TRANSACTION_GUIDANCE).not.toMatch(/unsupported AI action/i);
  });

  it('builds a validated expense proposal from a recognized command', () => {
    const draft = buildVoiceTransactionDraft({ intent: 'expense', amount: 100, date: '2026-08-31', category: 'Fuel', summary: 'Paid 100 for fuel' });
    expect(draft.validation.ok).toBe(true);
    expect(draft.validation.action.type).toBe('add_expense');
  });

  it('keeps the Ask AI mic routed to the transaction assistant', () => {
    const ask = fs.readFileSync(path.join(__dirname, '..', 'app', 'ask.tsx'), 'utf8');
    expect(ask).toContain('router.push("/voice")');
    expect(ask).not.toContain('Adding it to this chat');
  });
});
