import type { EntryHelpOrder, InterpretationMode } from '../db/ai';
import { DEFAULT_ENTRY_HELP_ORDER, withCloudHelpTimeout } from '../db/ai';
import {
  continueLocalTransaction,
  parseLocalTransactions,
  type LocalTransactionParseResult,
  type LocalTransactionParserOptions,
} from './localTransactionParser';
import type { VoiceCommand } from './voicePartyResolution';

export type VoiceInterpretationResult =
  | { kind: 'command'; command: VoiceCommand; commands: VoiceCommand[]; transcript: string; source: 'local' | 'cloud' }
  | Extract<LocalTransactionParseResult, { kind: 'clarification' | 'unsupported' }>;

export type PendingVoiceClarification = Extract<LocalTransactionParseResult, { kind: 'clarification' }>;

type InterpretationRequest = {
  transcript: string;
  mode: InterpretationMode;
  hasCloudAI: boolean;
  parseCloud: (text: string) => Promise<VoiceCommand>;
  parserOptions?: LocalTransactionParserOptions;
  entryHelpOrder?: EntryHelpOrder;
};

/**
 * Keeps transaction interpretation independent from speech recognition.
 * Automatic mode follows the Advanced Settings order: cloud-first (default)
 * tries AI with a timeout then on-device parsing; device-first stays local
 * unless the parser cannot understand the sentence.
 */
function asCommandResult(command: VoiceCommand, transcript: string, source: 'local' | 'cloud', commands?: VoiceCommand[]): VoiceInterpretationResult {
  const list = commands?.length ? commands : [command];
  return { kind: 'command', command: list[0], commands: list, transcript, source };
}

export async function interpretVoiceTransaction(request: InterpretationRequest): Promise<VoiceInterpretationResult> {
  const parseLocal = () => parseLocalTransactions(request.transcript, request.parserOptions);
  const parseCloud = () => withCloudHelpTimeout(request.parseCloud(request.transcript));
  const order = request.entryHelpOrder || DEFAULT_ENTRY_HELP_ORDER;

  const local = parseLocal();
  const localCommands = local.kind === 'confident' ? (local.commands?.length ? local.commands : [local.command]) : [];
  // Cloud parseCommand is a single-intent schema, so keep split local drafts.
  if (local.kind === 'confident' && localCommands.length > 1) {
    return asCommandResult(local.command, local.transcript, 'local', localCommands);
  }

  if (request.mode === 'device-only') {
    if (local.kind === 'confident') return asCommandResult(local.command, local.transcript, 'local', localCommands);
    return local;
  }

  if (request.mode === 'cloud' || (request.mode === 'auto' && order === 'cloud-first' && request.hasCloudAI)) {
    try {
      const command = await parseCloud();
      return asCommandResult(command, request.transcript, 'cloud');
    } catch (error) {
      if (request.mode === 'cloud') throw error;
      if (local.kind === 'confident') return asCommandResult(local.command, local.transcript, 'local', localCommands);
      if (local.kind !== 'unsupported') return local;
      throw error;
    }
  }

  if (local.kind === 'confident') return asCommandResult(local.command, local.transcript, 'local', localCommands);
  if (local.kind === 'clarification' || !request.hasCloudAI) return local;
  try {
    return asCommandResult(await parseCloud(), request.transcript, 'cloud');
  } catch {
    return local;
  }
}

export function continueVoiceTransaction(
  pending: PendingVoiceClarification,
  answer: string,
  parserOptions?: LocalTransactionParserOptions,
): VoiceInterpretationResult {
  const result = continueLocalTransaction(pending, answer, parserOptions);
  return result.kind === 'confident'
    ? asCommandResult(result.command, result.transcript, 'local', result.commands)
    : result;
}
