import { parseLocalTransactions } from '../src/accountingV2/localTransactionParser';
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

  it('splits mixed expense and payment speech', () => {
    expect(splitSpokenTransactions('spent 20 on fuel and paid 30 to Make Hardware')).toEqual([
      'spent 20 on fuel',
      'paid 30 to Make Hardware',
    ]);
  });

  it('drafts both items instead of collapsing to the first amount', () => {
    const result = parseLocalTransactions('paid 100 to Amit and 50 to Rahim');
    expect(result.kind).toBe('confident');
    if (result.kind !== 'confident') return;
    expect(result.commands).toEqual([
      expect.objectContaining({ intent: 'supplier_payment', amount: 100, supplierName: 'Amit' }),
      expect.objectContaining({ intent: 'supplier_payment', amount: 50, supplierName: 'Rahim' }),
    ]);
  });

  it('keeps unknown parties as create-on-save drafts for multi-item speech', () => {
    const parsed = parseLocalTransactions('paid 100 to Make Hardware and 50 to Rahim Traders');
    expect(parsed.kind).toBe('confident');
    if (parsed.kind !== 'confident' || !parsed.commands) return;
    const resolved = resolveVoiceCommandsForDrafts(parsed.commands, parsed.transcript, {
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
