import { interpretLocalTransactions } from '../src/accountingV2/localTransactionParser';
import { countSpokenAmounts, splitSpokenTransactions } from '../src/accountingV2/spokenTransactions';
import { resolveVoiceCommandsForDrafts } from '../src/accountingV2/voiceTransactionDraft';

describe('spoken transaction splitting', () => {
  it('keeps a single payment as one utterance', () => {
    expect(splitSpokenTransactions('paid 100 to Make and Sons today')).toEqual(['paid 100 to Make and Sons today']);
    expect(countSpokenAmounts('paid 100 to Make and Sons today')).toBe(1);
  });

  it('splits two payments joined by and', () => {
    expect(splitSpokenTransactions('paid 100 to Amit and 50 to Rahim')).toEqual([
      'paid 100 to Amit',
      'paid 50 to Rahim',
    ]);
  });

  it('drafts both items instead of collapsing to the first amount', () => {
    const result = interpretLocalTransactions('paid 100 to Amit and 50 to Rahim');
    expect(result.status).toBe('confident');
    if (result.status !== 'confident') return;
    expect(result.commands).toEqual([
      expect.objectContaining({ intent: 'supplier_payment', amount: 100, supplierName: 'Amit' }),
      expect.objectContaining({ intent: 'supplier_payment', amount: 50, supplierName: 'Rahim' }),
    ]);
  });

  it('keeps unknown parties as create-on-save drafts for multi-item speech', () => {
    const parsed = interpretLocalTransactions('paid 100 to Make Hardware and 50 to Rahim Traders');
    expect(parsed.status).toBe('confident');
    if (parsed.status !== 'confident' || !parsed.commands) return;
    const resolved = resolveVoiceCommandsForDrafts(parsed.commands, 'paid 100 to Make Hardware and 50 to Rahim Traders', {
      suppliers: [], customers: [], capitalAccounts: [],
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.commands).toEqual([
      expect.objectContaining({ pendingPartyCreate: { role: 'supplier', name: 'Make Hardware' } }),
      expect.objectContaining({ pendingPartyCreate: { role: 'supplier', name: 'Rahim Traders' } }),
    ]);
  });
});
