/* eslint-disable @typescript-eslint/no-require-imports */
import {
  LEDGR_ON_DEVICE_TOOL_NAMES,
  OPTIONAL_ON_DEVICE_MODELS,
  ledgrOnDeviceToolContext,
  isReadToolName,
  ledgrOnDeviceToolsJson,
  toolCallToAskAction,
  toolCallToVoiceCommand,
  type LedgrOnDeviceToolCall,
  type LedgrOnDeviceToolName,
  type OptionalOnDeviceModelId,
} from '../accountingV2/onDeviceTools';
import type { VoiceCommand } from '../accountingV2/voicePartyResolution';

function nativeRuntime(): { NativeModules: Record<string, unknown>; Platform: { OS: string } } {
  try { return require('react-native'); } catch { return { NativeModules: {}, Platform: { OS: 'unknown' } }; }
}

export type OnDeviceLlmStatus = {
  supported: boolean;
  needleAvailable: boolean;
  engineLoaded: boolean;
  reason?: string;
  totalRamBytes?: number;
};

export type OptionalModelStatus = {
  id: OptionalOnDeviceModelId;
  installed: boolean;
  eligible: boolean;
  bytesOnDisk?: number;
};

type NativeOnDeviceLlm = {
  isAvailable?: () => Promise<boolean> | boolean;
  getStatus?: () => Promise<OnDeviceLlmStatus> | OnDeviceLlmStatus;
  runNeedle?: (transcript: string, toolsJson: string) => Promise<string> | string;
  runOptional?: (modelId: string, prompt: string, imageUri?: string, audioUri?: string) => Promise<string> | string;
  listOptional?: () => Promise<OptionalModelStatus[]> | OptionalModelStatus[];
  downloadOptional?: (modelId: string, url: string, filename: string) => Promise<boolean> | boolean;
  deleteOptional?: (modelId: string) => Promise<boolean> | boolean;
  addListener?: (event: string, listener: (payload: any) => void) => { remove: () => void };
};

function nativeModule(): NativeOnDeviceLlm | null {
  const { NativeModules, Platform } = nativeRuntime();
  if (Platform.OS !== 'android') return null;
  try {
    return require('expo-modules-core').requireOptionalNativeModule('LedgrOnDeviceLlm')
      || (NativeModules as any).LedgrOnDeviceLlm
      || null;
  } catch { return (NativeModules as any).LedgrOnDeviceLlm || null; }
}

function parseToolCall(raw: string): LedgrOnDeviceToolCall | null {
  const text = String(raw || '').trim();
  if (!text || text === 'null' || text === '{}') return null;
  try {
    const decoded = JSON.parse(text);
    // The training set frames a call as `answers: [{name, arguments}]`, so the
    // model emits an array. Accepting only a bare object meant a correctly
    // formed call parsed to null and looked like "no tool call".
    const parsed = Array.isArray(decoded) ? decoded[0] : decoded;
    if (!parsed || typeof parsed !== 'object') return null;
    const name = String(parsed.name || parsed.tool || parsed.type || parsed.function?.name || '').trim() as LedgrOnDeviceToolName;
    if (!LEDGR_ON_DEVICE_TOOL_NAMES.includes(name)) return null;
    const args = parsed.arguments || parsed.params || parsed.function?.arguments || {};
    const argumentsObject = typeof args === 'string' ? JSON.parse(args) : args;
    if (!argumentsObject || typeof argumentsObject !== 'object') return null;
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : undefined;
    if (confidence != null && confidence < 0.35) return null;
    return { name, arguments: argumentsObject, confidence };
  } catch { return null; }
}

export async function getOnDeviceLlmStatus(): Promise<OnDeviceLlmStatus> {
  const { Platform } = nativeRuntime();
  const module = nativeModule();
  if (!module) {
    return {
      supported: Platform.OS === 'android',
      needleAvailable: false,
      engineLoaded: false,
      reason: Platform.OS === 'android'
        ? 'On-device Needle is available in a native Android build that vendors the Cactus engine.'
        : 'On-device Needle is supported only on Android.',
    };
  }
  try {
    if (module.getStatus) return await module.getStatus();
    const available = module.isAvailable ? await module.isAvailable() : true;
    return { supported: true, needleAvailable: available, engineLoaded: available };
  } catch {
    return { supported: true, needleAvailable: false, engineLoaded: false, reason: 'Could not query the on-device LLM engine.' };
  }
}

export async function runNeedleTools(transcript: string, partyHints: string[] = []): Promise<LedgrOnDeviceToolCall | null> {
  const module = nativeModule();
  if (!module?.runNeedle) return null;
  // The date, known parties and rules travel with the transcript now that the
  // tool argument is the bare array needle_init expects.
  const prompt = `${ledgrOnDeviceToolContext(partyHints)}
USER: ${transcript.trim()}`;
  const raw = await module.runNeedle(prompt, ledgrOnDeviceToolsJson(partyHints));
  return parseToolCall(String(raw || ''));
}

/**
 * One agent turn: let Needle read before it acts.
 *
 * Reads are chained -- "how much does Amit owe" may need a lookup before an
 * answer -- but the loop stops the moment a WRITE tool is proposed, so the
 * proposal reaches validateAssistantProposal and the user's confirmation sheet
 * exactly as a single-shot call would. The cap is small on purpose: a phone is
 * not the place for an open-ended agent loop, and three steps covers the
 * look-up-then-act shape without ever running away.
 */
export const NEEDLE_MAX_AGENT_STEPS = 3;

export type NeedleAgentTurn =
  | { kind: 'write'; call: LedgrOnDeviceToolCall; steps: number }
  | { kind: 'answer'; text: string; steps: number }
  | { kind: 'none'; steps: number };

export async function runNeedleAgentTurn(
  transcript: string,
  partyHints: string[] = [],
  runRead: (call: LedgrOnDeviceToolCall) => Promise<string> = async () => '',
): Promise<NeedleAgentTurn> {
  let prompt = transcript.trim();
  const observations: string[] = [];

  for (let step = 1; step <= NEEDLE_MAX_AGENT_STEPS; step += 1) {
    const call = await runNeedleTools(prompt, partyHints);
    if (!call) {
      return observations.length
        ? { kind: 'answer', text: observations.join('\n'), steps: step }
        : { kind: 'none', steps: step };
    }
    if (!isReadToolName(call.name)) {
      return { kind: 'write', call, steps: step };
    }
    const observation = await runRead(call);
    if (observation) observations.push(observation);
    // Feed the result back so the next step can build on what was just read.
    prompt = `${prompt}\nTOOL ${call.name} RESULT: ${observation || '(nothing found)'}`;
  }

  return observations.length
    ? { kind: 'answer', text: observations.join('\n'), steps: NEEDLE_MAX_AGENT_STEPS }
    : { kind: 'none', steps: NEEDLE_MAX_AGENT_STEPS };
}

export async function interpretNeedleVoiceCommand(transcript: string, partyHints: string[] = []): Promise<VoiceCommand | null> {
  const call = await runNeedleTools(transcript, partyHints);
  return call ? toolCallToVoiceCommand(call) : null;
}

export async function interpretNeedleAskAction(transcript: string, partyHints: string[] = []): Promise<{ type: string; params: Record<string, unknown> } | null> {
  const call = await runNeedleTools(transcript, partyHints);
  return call ? toolCallToAskAction(call) : null;
}

export async function listOptionalOnDeviceModels(): Promise<(typeof OPTIONAL_ON_DEVICE_MODELS[number] & OptionalModelStatus)[]> {
  const module = nativeModule();
  const nativeList = module?.listOptional ? await module.listOptional() : [];
  const byId = new Map(nativeList.map((row) => [row.id, row]));
  const ram = (await getOnDeviceLlmStatus()).totalRamBytes;
  return OPTIONAL_ON_DEVICE_MODELS.map((model) => {
    const native = byId.get(model.id);
    return {
      ...model,
      installed: Boolean(native?.installed),
      eligible: native?.eligible ?? (ram == null || ram >= model.minRamBytes),
      bytesOnDisk: native?.bytesOnDisk,
    };
  });
}

export async function downloadOptionalOnDeviceModel(
  id: OptionalOnDeviceModelId,
  onProgress?: (received: number, total: number) => void,
): Promise<void> {
  const model = OPTIONAL_ON_DEVICE_MODELS.find((row) => row.id === id);
  if (!model) throw new Error('Unknown on-device model.');
  const module = nativeModule();
  if (!module?.downloadOptional) throw new Error('Model download requires an Android native build.');
  let subscription: { remove: () => void } | undefined;
  if (onProgress && module.addListener) {
    subscription = module.addListener('downloadProgress', (payload: { id?: string; received?: number; total?: number }) => {
      if (payload?.id && payload.id !== id) return;
      onProgress(Number(payload.received || 0), Number(payload.total || model.bytes));
    });
  }
  try {
    await module.downloadOptional(id, model.downloadUrl, model.filename);
  } finally {
    subscription?.remove();
  }
}

export async function deleteOptionalOnDeviceModel(id: OptionalOnDeviceModelId): Promise<void> {
  const module = nativeModule();
  if (!module?.deleteOptional) throw new Error('Deleting a model requires an Android native build.');
  await module.deleteOptional(id);
}

export async function runOptionalOnDeviceModel(input: {
  id: OptionalOnDeviceModelId;
  prompt: string;
  imageUri?: string;
  audioUri?: string;
}): Promise<string> {
  const module = nativeModule();
  if (!module?.runOptional) throw new Error('The optional on-device model is not loaded.');
  return String(await module.runOptional(input.id, input.prompt, input.imageUri, input.audioUri) || '').trim();
}
