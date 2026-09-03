import { api } from '../api';
import {
  continueLocalTransaction,
  interpretLocalTransactions,
  type LocalTransactionContinuation,
} from './localTransactionParser';
import { resolveVoicePartyCommand } from './voicePartyResolution';
import { buildVoiceTransactionDraft, resolveVoiceCommandsForDrafts, type VoiceTransactionDraft } from './voiceTransactionDraft';
import { DEFAULT_ENTRY_HELP_ORDER, withCloudHelpTimeout } from '../db/ai';
import { interpretNeedleVoiceCommand } from '../utils/onDeviceLlm';

export type VoiceDraftPreparation =
  | { status: 'ready'; draft: VoiceTransactionDraft; drafts: VoiceTransactionDraft[] }
  | { status: 'clarification'; question: string; continuation: LocalTransactionContinuation };

function readyDrafts(commands: Parameters<typeof buildVoiceTransactionDraft>[0][]): VoiceDraftPreparation {
  const drafts = commands.map((command) => {
    const needsMethod = ['expense', 'receipt', 'supplier_payment', 'drawing', 'capital'].includes(String(command.intent));
    const withMethod = needsMethod && !command.method ? { ...command, method: 'cash' } : command;
    return buildVoiceTransactionDraft(withMethod);
  });
  return { status: 'ready', draft: drafts[0], drafts };
}

function readyDraft(command: Parameters<typeof buildVoiceTransactionDraft>[0]): VoiceDraftPreparation {
  return readyDrafts([command]);
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

  const parseLocal = () => interpretLocalTransactions(transcript, directory);
  const fromLocal = (local: ReturnType<typeof parseLocal>): VoiceDraftPreparation | null => {
    if (local.status !== 'confident') return null;
    const commands = local.commands?.length ? local.commands : [local.command];
    if (commands.length > 1) {
      const resolution = resolveVoiceCommandsForDrafts(commands, transcript, directory);
      if (!resolution.ok) return partyClarification(transcript, resolution.command, resolution.question);
      return readyDrafts(resolution.commands);
    }
    return readyDraft(local.command);
  };
  const parseCloud = async () => {
    const parsedCommand = await withCloudHelpTimeout(api.parseCommand(transcript));
    const resolution = resolveVoicePartyCommand(parsedCommand, transcript, directory);
    if (!resolution.ok) return partyClarification(transcript, parsedCommand, resolution.question);
    return readyDraft(resolution.command);
  };

  const localFirst = parseLocal();
  const localReady = fromLocal(localFirst);
  if (localReady?.status === 'ready' && localReady.drafts.length > 1) return localReady;

  if (mode === 'cloud' || (mode === 'auto' && order === 'cloud-first' && hasCloudAI)) {
    try {
      return await parseCloud();
    } catch (error: any) {
      if (mode === 'cloud') throw error;
      if (localReady) return localReady;
      if (localFirst.status === 'clarification') {
        return { status: 'clarification', question: localFirst.question, continuation: localFirst.continuation };
      }
      throw new Error(error?.message || (localFirst.status === 'unsupported' ? localFirst.reason : '') || 'Could not interpret that transaction.');
    }
  }

  if (localReady) return localReady;
  try {
    const needleCommand = await interpretNeedleVoiceCommand(transcript);
    if (needleCommand?.intent) {
      const resolution = resolveVoicePartyCommand(needleCommand, transcript, directory);
      if (!resolution.ok) return partyClarification(transcript, needleCommand, resolution.question);
      return readyDraft(resolution.command);
    }
  } catch { /* Needle is optional until the native engine is vendored */ }
  if (localFirst.status === 'clarification') {
    return { status: 'clarification', question: localFirst.question, continuation: localFirst.continuation };
  }
  if (mode === 'android-device' || !hasCloudAI) {
    throw new Error(`${localFirst.status === 'unsupported' ? localFirst.reason : 'Could not interpret that transaction.'} Edit the transcript with the transaction type, amount, and party, then update the draft.`);
  }
  return parseCloud();
}
