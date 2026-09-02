import { api } from '../api';
import {
  continueLocalTransaction,
  interpretLocalTransaction,
  type LocalTransactionContinuation,
} from './localTransactionParser';
import { resolveVoicePartyCommand } from './voicePartyResolution';
import { buildVoiceTransactionDraft, type VoiceTransactionDraft } from './voiceTransactionDraft';

export type VoiceDraftPreparation =
  | { status: 'ready'; draft: VoiceTransactionDraft }
  | { status: 'clarification'; question: string; continuation: LocalTransactionContinuation };

/**
 * Interprets a transcript locally first. Automatic mode only calls the configured
 * cloud model when the deterministic parser cannot safely understand the entry.
 */
export async function prepareVoiceTransactionDraft(
  transcript: string,
  continuation?: LocalTransactionContinuation | null,
  clarificationAnswer?: string,
): Promise<VoiceDraftPreparation> {
  const [config, suppliers, customers, capitalAccounts] = await Promise.all([
    api.getAIConfig(),
    api.listSuppliers(),
    api.listDebtors(),
    api.listInvestors(),
  ]);
  const directory = { suppliers, customers, capitalAccounts };
  const mode = config.interpretationProvider || 'auto';

  if (mode !== 'cloud') {
    const local = continuation
      ? continueLocalTransaction(continuation, clarificationAnswer || transcript, directory)
      : interpretLocalTransaction(transcript, directory);
    if (local.status === 'confident') {
      return { status: 'ready', draft: buildVoiceTransactionDraft(local.command) };
    }
    if (local.status === 'clarification') {
      return { status: 'clarification', question: local.question, continuation: local.continuation };
    }
    if (mode === 'android-device' || !config.apiKey.trim()) {
      throw new Error(`${local.reason} Edit the transcript with the transaction type, amount, and party, then update the draft.`);
    }
  }

  if (!config.apiKey.trim()) {
    throw new Error('Cloud interpretation needs an AI API key. Choose On device or add a key in Advanced Settings.');
  }
  const parsedCommand = await api.parseCommand(transcript);
  const resolution = resolveVoicePartyCommand(parsedCommand, transcript, directory);
  if (!resolution.ok) throw new Error(resolution.question);
  return { status: 'ready', draft: buildVoiceTransactionDraft(resolution.command) };
}
