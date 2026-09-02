import type { InterpretationMode } from '../db/ai';
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
};

/**
 * Keeps transaction interpretation independent from speech recognition.
 * Automatic mode is local-first and only calls cloud AI for unsupported text;
 * focused local clarification questions retain the original command instead.
 */
export async function interpretVoiceTransaction(request: InterpretationRequest): Promise<VoiceInterpretationResult> {
  if (request.mode === 'cloud') {
    return { kind: 'command', command: await request.parseCloud(request.transcript), transcript: request.transcript, source: 'cloud' };
  }

  const local = parseLocalTransaction(request.transcript, request.parserOptions);
  if (local.kind === 'confident') return { kind: 'command', command: local.command, transcript: local.transcript, source: 'local' };
  if (local.kind === 'clarification' || request.mode === 'device-only' || !request.hasCloudAI) return local;

  return { kind: 'command', command: await request.parseCloud(request.transcript), transcript: request.transcript, source: 'cloud' };
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
