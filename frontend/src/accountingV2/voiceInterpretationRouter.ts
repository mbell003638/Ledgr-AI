import type { EntryHelpOrder, InterpretationMode } from '../db/ai';
import { DEFAULT_ENTRY_HELP_ORDER, withCloudHelpTimeout } from '../db/ai';
import {
  continueLocalTransaction,
  parseLocalTransaction,
  type LocalTransactionParseResult,
  type LocalTransactionParserOptions,
} from './localTransactionParser';
import type { VoiceCommand } from './voicePartyResolution';

export type VoiceInterpretationResult =
  | { kind: 'command'; command: VoiceCommand; transcript: string; source: 'local' | 'cloud' }
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
export async function interpretVoiceTransaction(request: InterpretationRequest): Promise<VoiceInterpretationResult> {
  const parseLocal = () => parseLocalTransaction(request.transcript, request.parserOptions);
  const parseCloud = () => withCloudHelpTimeout(request.parseCloud(request.transcript));
  const order = request.entryHelpOrder || DEFAULT_ENTRY_HELP_ORDER;

  if (request.mode === 'device-only') {
    const local = parseLocal();
    if (local.kind === 'confident') return { kind: 'command', command: local.command, transcript: local.transcript, source: 'local' };
    return local;
  }

  if (request.mode === 'cloud' || (request.mode === 'auto' && order === 'cloud-first' && request.hasCloudAI)) {
    try {
      return { kind: 'command', command: await parseCloud(), transcript: request.transcript, source: 'cloud' };
    } catch (error) {
      if (request.mode === 'cloud') throw error;
      const local = parseLocal();
      if (local.kind === 'confident') return { kind: 'command', command: local.command, transcript: local.transcript, source: 'local' };
      if (local.kind !== 'unsupported') return local;
      throw error;
    }
  }

  const local = parseLocal();
  if (local.kind === 'confident') return { kind: 'command', command: local.command, transcript: local.transcript, source: 'local' };
  if (local.kind === 'clarification' || !request.hasCloudAI) return local;
  try {
    return { kind: 'command', command: await parseCloud(), transcript: request.transcript, source: 'cloud' };
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
    ? { kind: 'command', command: result.command, transcript: result.transcript, source: 'local' }
    : result;
}
