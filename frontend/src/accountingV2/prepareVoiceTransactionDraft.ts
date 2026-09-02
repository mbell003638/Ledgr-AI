import { api } from '../api';
import {
  continueLocalTransaction,
  interpretLocalTransaction,
  type LocalTransactionContinuation,
} from './localTransactionParser';
import { resolveVoicePartyCommand } from './voicePartyResolution';
import { buildVoiceTransactionDraft, type VoiceTransactionDraft } from './voiceTransactionDraft';
import { DEFAULT_ENTRY_HELP_ORDER, withCloudHelpTimeout } from '../db/ai';

export type VoiceDraftPreparation =
  | { status: 'ready'; draft: VoiceTransactionDraft }
  | { status: 'clarification'; question: string; continuation: LocalTransactionContinuation };

function readyDraft(command: Parameters<typeof buildVoiceTransactionDraft>[0]): VoiceDraftPreparation {
  const needsMethod = ['expense', 'receipt', 'supplier_payment', 'drawing', 'capital'].includes(String(command.intent));
  const withMethod = needsMethod && !command.method ? { ...command, method: 'cash' } : command;
  return { status: 'ready', draft: buildVoiceTransactionDraft(withMethod) };
}

function partyClarification(transcript: string, command: Parameters<typeof buildVoiceTransactionDraft>[0], question: string): VoiceDraftPreparation {
  return {
    status: 'clarification',
    question,
    continuation: { originalTranscript: transcript, partial: command, missingField: 'party_role' },
  };
}

/**
 * Automatic mode follows Advanced Settings: cloud-first (default) tries AI
 * with a timeout then on-device parsing. Parties are not written until Save.
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
  const order = config.entryHelpOrder || DEFAULT_ENTRY_HELP_ORDER;
  const hasCloudAI = Boolean(config.apiKey.trim());

  if (continuation) {
    const local = continueLocalTransaction(continuation, clarificationAnswer || transcript, directory);
    if (local.status === 'confident') return readyDraft(local.command);
    if (local.status === 'clarification') {
      return { status: 'clarification', question: local.question, continuation: local.continuation };
    }
    throw new Error(`${local.reason} Edit the transcript with the transaction type, amount, and party, then update the draft.`);
  }

  const parseLocal = () => interpretLocalTransaction(transcript, directory);
  const parseCloud = async () => {
    const parsedCommand = await withCloudHelpTimeout(api.parseCommand(transcript));
    const resolution = resolveVoicePartyCommand(parsedCommand, transcript, directory);
    if (!resolution.ok) return partyClarification(transcript, parsedCommand, resolution.question);
    return readyDraft(resolution.command);
  };

  if (mode === 'cloud' || (mode === 'auto' && order === 'cloud-first' && hasCloudAI)) {
    try {
      return await parseCloud();
    } catch (error: any) {
      if (mode === 'cloud') throw error;
      const local = parseLocal();
      if (local.status === 'confident') return readyDraft(local.command);
      if (local.status === 'clarification') {
        return { status: 'clarification', question: local.question, continuation: local.continuation };
      }
      throw new Error(error?.message || local.reason || 'Could not interpret that transaction.');
    }
  }

  const local = parseLocal();
  if (local.status === 'confident') return readyDraft(local.command);
  if (local.status === 'clarification') {
    return { status: 'clarification', question: local.question, continuation: local.continuation };
  }
  if (mode === 'android-device' || !hasCloudAI) {
    throw new Error(`${local.reason} Edit the transcript with the transaction type, amount, and party, then update the draft.`);
  }
  return parseCloud();
}
