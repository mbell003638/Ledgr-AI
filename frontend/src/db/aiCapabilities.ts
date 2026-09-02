import { AIConfig, DEFAULT_PROVIDER, getProviderMeta } from './ai';

export type AICapability = 'chat' | 'vision' | 'transcription';
export interface AICapabilityStatus { supported: boolean; configured: boolean; reason?: string }
export type AICapabilities = Record<AICapability, AICapabilityStatus>;

/** Fast local capability status; network probes remain the source of truth. */
export function getAICapabilities(cfg: Partial<AIConfig>): AICapabilities {
  const meta = getProviderMeta(String(cfg.provider || DEFAULT_PROVIDER));
  const hasKey = Boolean(cfg.apiKey?.trim());
  const base = cfg.baseUrl?.trim() || meta.defaultBaseUrl;
  const chatConfigured = hasKey && (meta.api !== 'openai' || Boolean(base));
  const chat: AICapabilityStatus = { supported: true, configured: chatConfigured, ...(!hasKey ? { reason: 'Add an API key.' } : !chatConfigured ? { reason: 'Add a chat Base URL.' } : {}) };
  const vision: AICapabilityStatus = { supported: meta.supportsVision, configured: chatConfigured && meta.supportsVision, ...(!meta.supportsVision ? { reason: 'This provider does not expose image input.' } : !chatConfigured ? { reason: chat.reason } : {}) };
  const separateBase = cfg.transcriptionBaseUrl?.trim() || '';
  const voiceBase = separateBase || (meta.supportsAudio || meta.api === 'openai' ? base : '');
  const voiceKey = cfg.transcriptionApiKey?.trim() || (meta.supportsAudio || meta.api === 'openai' ? cfg.apiKey?.trim() : '');
  const transcriptionSupported = meta.supportsAudio || Boolean(separateBase);
  const transcription: AICapabilityStatus = { supported: transcriptionSupported, configured: Boolean(voiceBase && voiceKey && transcriptionSupported), ...(!transcriptionSupported ? { reason: 'Add a separate speech endpoint.' } : !voiceBase ? { reason: 'Add a voice Base URL.' } : !voiceKey ? { reason: 'Add a voice API key.' } : {}) };
  return { chat, vision, transcription };
}

