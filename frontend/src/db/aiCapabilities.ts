import { AIConfig, DEFAULT_PROVIDER, getProviderMeta } from './ai';
export type AICapability = 'chat' | 'vision' | 'transcription';
export type DocumentAnalysisRoute = 'local-text' | 'provider-vision' | 'unsupported';
export interface AICapabilityStatus { supported: boolean; configured: boolean; reason?: string; }
export type AICapabilities = Record<AICapability, AICapabilityStatus>;
export function getAICapabilities(cfg: Partial<AIConfig>): AICapabilities {
  const meta = getProviderMeta(String(cfg.provider || DEFAULT_PROVIDER));
  const hasKey = Boolean(cfg.apiKey?.trim());
  const base = cfg.baseUrl?.trim() || meta.defaultBaseUrl;
  const chat = { supported: true, configured: hasKey && (meta.api !== 'openai' || Boolean(base)), ...(!hasKey ? { reason: 'Add an API key.' } : !base && meta.api === 'openai' ? { reason: 'Add a Base URL.' } : {}) };
  const vision = { supported: meta.supportsVision, configured: chat.configured && meta.supportsVision, ...(!meta.supportsVision ? { reason: 'This provider does not expose image input.' } : !chat.configured ? { reason: chat.reason } : {}) };
  const separate = Boolean(cfg.transcriptionBaseUrl?.trim());
  const voiceBase = cfg.transcriptionBaseUrl?.trim() || (meta.supportsAudio || meta.api === 'openai' ? base : '');
  const voiceKey = cfg.transcriptionApiKey?.trim() || (meta.supportsAudio || meta.api === 'openai' ? cfg.apiKey?.trim() : '');
  const transcription = { supported: meta.supportsAudio || separate, configured: Boolean(voiceBase && voiceKey && (meta.supportsAudio || separate)), ...(!meta.supportsAudio && !separate ? { reason: 'Add a separate OpenAI-compatible speech endpoint.' } : !voiceBase ? { reason: 'Add a voice Base URL.' } : !voiceKey ? { reason: 'Add a voice API key.' } : {}) };
  return { chat, vision, transcription };
}

/** Select the safest document path before sending anything to a provider. */
export function resolveDocumentAnalysisRoute(cfg: Partial<AIConfig>, input: { hasImage?: boolean; hasPdf?: boolean; hasText?: boolean }): DocumentAnalysisRoute {
  if (input.hasText && !input.hasImage && !input.hasPdf) return 'local-text';
  const capabilities = getAICapabilities(cfg);
  if (capabilities.vision.configured && !input.hasPdf) return 'provider-vision';
  if (capabilities.vision.configured && input.hasPdf && String(cfg.provider || DEFAULT_PROVIDER) === 'gemini') return 'provider-vision';
  return 'unsupported';
}
