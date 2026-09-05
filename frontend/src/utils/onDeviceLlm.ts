/* eslint-disable @typescript-eslint/no-require-imports */
import {
  LEDGR_ON_DEVICE_TOOL_NAMES,
  OPTIONAL_ON_DEVICE_MODELS,
  advertisedRamBytes,
  ledgrOnDeviceToolsJson,
  toolCallToAskAction,
  toolCallToVoiceCommand,
  type LedgrOnDeviceToolCall,
  type LedgrOnDeviceToolName,
  type OnDevicePackCapability,
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
    const parsed = JSON.parse(text);
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
  const raw = await module.runNeedle(transcript.trim(), ledgrOnDeviceToolsJson(partyHints));
  return parseToolCall(String(raw || ''));
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
  const ram = advertisedRamBytes((await getOnDeviceLlmStatus()).totalRamBytes);
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

export type InstalledOnDevicePack = typeof OPTIONAL_ON_DEVICE_MODELS[number] & OptionalModelStatus;

/**
 * Picks the pack to answer with. Previously this took the first installed entry
 * in array order, so a phone holding both Gemma 3 1B and 4 E2B silently used
 * 3 1B -- the weaker one -- because it happened to be listed first.
 *
 * Ranking replaces array order, and a pack is only considered when it declares
 * every capability the task needs, so an image is never handed to a text-only
 * pack. A pinned pack wins outright, but falls back to Auto when it is not
 * installed or the phone cannot run it, rather than leaving Ask unavailable.
 */
export function selectOnDevicePack(
  packs: InstalledOnDevicePack[],
  needs: OnDevicePackCapability[] = ['text'],
  preferredId?: string | null,
): InstalledOnDevicePack | null {
  const usable = packs.filter((pack) => (
    pack.installed
    && pack.eligible
    && needs.every((capability) => pack.capabilities.includes(capability))
  ));
  if (preferredId) {
    const pinned = usable.find((pack) => pack.id === preferredId);
    if (pinned) return pinned;
  }
  return usable.slice().sort((a, b) => b.rank - a.rank)[0] || null;
}

/**
 * Which pack the user pinned, or null for Auto. Lives here rather than in
 * api.ts because api.ts already imports this module, and the reverse import
 * would be circular.
 */
export const PREFERRED_ON_DEVICE_MODEL_KEY = 'ledgr_preferred_on_device_model';

function asyncStorage(): { getItem: (k: string) => Promise<string | null>; setItem: (k: string, v: string) => Promise<void>; removeItem: (k: string) => Promise<void> } | null {
  try { return require('@react-native-async-storage/async-storage').default; } catch { return null; }
}

export async function getPreferredOnDevicePack(): Promise<string | null> {
  try { return (await asyncStorage()?.getItem(PREFERRED_ON_DEVICE_MODEL_KEY)) || null; } catch { return null; }
}

export async function setPreferredOnDevicePack(id: string | null): Promise<void> {
  const storage = asyncStorage();
  if (!storage) return;
  if (id) await storage.setItem(PREFERRED_ON_DEVICE_MODEL_KEY, id);
  else await storage.removeItem(PREFERRED_ON_DEVICE_MODEL_KEY);
}

/** The pack Ask should use for a task, honouring the pinned-model setting. */
export async function bestOnDevicePack(
  needs: OnDevicePackCapability[] = ['text'],
): Promise<InstalledOnDevicePack | null> {
  const [packs, preferred] = await Promise.all([
    listOptionalOnDeviceModels(),
    getPreferredOnDevicePack(),
  ]);
  return selectOnDevicePack(packs, needs, preferred);
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
