/**
 * Multi-provider AI router (no backend).
 * Three dialects: Google Gemini (native), OpenAI-compatible, Anthropic.
 * OpenRouter / Groq / local servers use the OpenAI-compatible row + a base URL.
 * Official Claude or an Anthropic-compatible proxy use the Anthropic row + base URL.
 */

import { localTodayIso } from '../utils/dateValidation';

export type ProviderId = 'gemini' | 'openai' | 'anthropic';
export type VoiceProvider = 'auto' | 'android-device' | 'cloud';

// Default provider used when the stored provider is missing/unknown/legacy.
export const DEFAULT_PROVIDER: ProviderId = 'gemini';
// Modern Gemini default; the previous 'gemini-2.0-flash-001' is deprecation-exposed.
export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';

export interface AIConfig {
  provider: ProviderId;
  apiKey: string;
  model: string;
  visionModel?: string;
  transcriptionModel?: string;
  transcriptionBaseUrl?: string;
  transcriptionApiKey?: string;
  baseUrl?: string; // OpenAI-compatible or Anthropic-compatible endpoint
  voiceProvider?: VoiceProvider;
}

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  defaultBaseUrl: string;
  defaultModel: string;
  keyHint: string;
  supportsVision: boolean;
  supportsAudio: boolean;
  api: 'gemini' | 'openai' | 'anthropic';
}

export const PROVIDERS: ProviderMeta[] = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: DEFAULT_GEMINI_MODEL,
    keyHint: 'AIzaâ€¦ â€” free at aistudio.google.com',
    supportsVision: true,
    supportsAudio: true,
    api: 'gemini',
  },
  {
    id: 'openai',
    label: 'OpenAI compatible',
    defaultBaseUrl: '',
    defaultModel: '',
    keyHint: 'Bearer key â€” OpenRouter, Groq, OpenAI, or any /v1 host',
    supportsVision: true,
    supportsAudio: true,
    api: 'openai',
  },
  {
    id: 'anthropic',
    label: 'Anthropic compatible',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-6',
    keyHint: 'sk-ant-â€¦ or your proxy key',
    supportsVision: true,
    supportsAudio: false,
    api: 'anthropic',
  },
];

const DEFAULT_PROVIDER_META: ProviderMeta = PROVIDERS.find((p) => p.id === DEFAULT_PROVIDER) || PROVIDERS[0];
let warnedUnknownProvider = false;

/**
 * Resolve provider metadata. An unknown/legacy stored provider id (e.g. the
 * removed 'openai') falls back to the default provider, but â€” unlike the old
 * silent fallback that quietly sent an OpenAI-style key to Gemini â€” we surface a
 * one-time console.warn and normalize the stored value so the caller can persist
 * the corrected provider.
 */
export function getProviderMeta(id: ProviderId | string): ProviderMeta {
  const found = PROVIDERS.find((p) => p.id === id);
  if (found) return found;
  if (!warnedUnknownProvider) {
    warnedUnknownProvider = true;
    console.warn(`[ai] Unknown/legacy AI provider "${String(id)}" â€” falling back to "${DEFAULT_PROVIDER}". Update the provider in Settings.`);
  }
  return DEFAULT_PROVIDER_META;
}

/**
 * Returns the canonical provider id for a possibly-legacy stored value, so
 * callers (api.ts loaders) can normalize what they persist. Known ids pass
 * through unchanged; anything else maps to the default provider.
 */
export function normalizeProviderId(id: ProviderId | string | null | undefined): ProviderId {
  return PROVIDERS.some((p) => p.id === id) ? (id as ProviderId) : DEFAULT_PROVIDER;
}

function requireKey(cfg: AIConfig) {
  if (!cfg.apiKey) {
    const err: any = new Error('Missing API key. Set it in Settings.');
    err.status = 401;
    throw err;
  }
}

function resolveApi(cfg: AIConfig): 'gemini' | 'openai' | 'anthropic' {
  return getProviderMeta(cfg.provider).api;
}

export function validateAIBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('AI Base URL must be a valid URL.');
  }
  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  if (parsed.protocol !== 'https:' && !(isLocal && parsed.protocol === 'http:')) {
    throw new Error('AI Base URL must use HTTPS (HTTP is allowed only for localhost development).');
  }
  if (parsed.username || parsed.password) {
    throw new Error('AI Base URL must not contain credentials.');
  }
  if (['github.com', 'www.github.com'].includes(parsed.hostname.toLowerCase())) {
    throw new Error('Use an AI API endpoint, not the github.com website. For GitHub Models use its documented inference API host; voice also requires an endpoint that supports /audio/transcriptions.');
  }

  return trimmed;
}

function resolveBaseUrl(cfg: AIConfig): string {
  if (cfg.baseUrl && cfg.baseUrl.trim()) return validateAIBaseUrl(cfg.baseUrl);
  return getProviderMeta(cfg.provider).defaultBaseUrl.replace(/\/+$/, '');
}

export interface CallOptions {
  maxOutputTokens?: number;
  timeoutMs?: number;
  retryTransient?: boolean;
}

/**
 * Core text/multimodal call. Returns raw text (possibly JSON string).
 * parts: array of { inlineData: { mimeType, data(base64) } } for images/audio.
 */
async function call(
  cfg: AIConfig,
  prompt: string,
  parts: { inlineData: { mimeType: string; data: string } }[] = [],
  jsonSchema?: any,
  options?: CallOptions,
): Promise<string> {
  requireKey(cfg);
  const api = resolveApi(cfg);
  if (api === 'gemini') return callGemini(cfg, prompt, parts, jsonSchema, options);
  if (api === 'anthropic') return callAnthropic(cfg, prompt, parts, jsonSchema, options);
  if (!resolveBaseUrl(cfg)) {
    throw new Error('Set a Base URL for the OpenAI-compatible provider (for example https://openrouter.ai/api/v1).');
  }
  return callOpenAI(cfg, prompt, parts, jsonSchema, options);
}

const AI_REQUEST_TIMEOUT_MS = 60_000;
const AI_TRANSIENT_RETRY_MS = 1_500;
const TRANSIENT_AI_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOnce(url: string, init: RequestInit, timeoutMs = AI_REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error: any) {
    if (error?.name === 'AbortError') throw new Error('AI request timed out. Check your connection and try again.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch with an automatic retry for temporary provider, rate-limit, network, or timeout failures.
 * Permanent failures are returned immediately so callers can show the provider's actionable error.
 */
async function fetchAI(url: string, init: RequestInit, timeoutMs?: number, retryTransient = true): Promise<Response> {
  if (!retryTransient) return fetchOnce(url, init, timeoutMs);
  try {
    const res = await fetchOnce(url, init, timeoutMs);
    if (!TRANSIENT_AI_STATUSES.has(res.status)) return res;
  } catch {
    // A second attempt below covers brief connectivity and timeout failures.
  }
  await delay(AI_TRANSIENT_RETRY_MS);
  return fetchOnce(url, init, timeoutMs);
}

/**
 * Map a failed AI HTTP response to a friendly, actionable Error.
 * - 429: quota reached (surfaced only after the single retry in fetchAI failed).
 * - 404/410: the model is likely deprecated/unknown â†’ point at Settings.
 */
function aiHttpError(status: number, statusText: string, data: any): Error {
  const providerMsg = data?.error?.message || (typeof data?.error === 'string' ? data.error : '') || `${status} ${statusText}`;
  if (status === 429) {
    return new Error('AI quota reached â€” wait a moment and try again, or check your API plan.');
  }
  if (status === 404 || status === 410) {
    return new Error('The configured AI model may be deprecated â€” open Settings and update the model name.');
  }
  if (status === 401 || status === 403) {
    return new Error('The AI provider rejected this API key. Check that the selected provider, API key, model, and account access all match.');
  }
  return new Error(providerMsg);
}

/** Heuristic: does this error look like an unknown/deprecated model (for alias retry)? */
function isModelNotFoundError(status: number, message: string): boolean {
  if (status === 404 || status === 410) return true;
  return /model/i.test(message) && /(not found|not exist|deprecat|unsupported|unknown|invalid)/i.test(message);
}
// ---------------- Gemini native ----------------
// Single Gemini generateContent call for a specific model. Key is sent in the
// x-goog-api-key HEADER (not the URL query) so it can't leak via request logs.
async function callGeminiModel(
  cfg: AIConfig,
  model: string,
  prompt: string,
  parts: any[],
  schema?: any,
  options?: CallOptions,
): Promise<string> {
  const base = resolveBaseUrl(cfg);
  const url = `${base}/models/${model}:generateContent`;
  const body: any = {
    contents: [{ role: 'user', parts: [{ text: prompt }, ...parts] }],
    generationConfig: {
      temperature: 0,
      ...(options?.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
      ...(schema ? { responseMimeType: 'application/json', responseSchema: schema } : {}),
    },
  };
  const res = await fetchAI(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
    body: JSON.stringify(body),
  }, options?.timeoutMs, options?.retryTransient !== false);
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw aiHttpError(res.status, res.statusText, data);
  const responseParts = data?.candidates?.[0]?.content?.parts;
  return Array.isArray(responseParts) ? responseParts.map((part: any) => part?.text || '').join('') : '';
}
// The previous hard-coded default that many installs still have persisted.
const DEPRECATED_DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash-001';

async function callGemini(
  cfg: AIConfig,
  prompt: string,
  parts: any[],
  schema?: any,
  options?: CallOptions,
): Promise<string> {
  try {
    return await callGeminiModel(cfg, cfg.model, prompt, parts, schema, options);
  } catch (error: any) {
    // If a model-not-found surfaces for the (deprecated) DEFAULT model, retry once
    // with the current alias before letting the actionable error from (d) bubble up.
    const msg = error?.message || '';
    const looksLikeModelIssue = isModelNotFoundError(0, msg) || /update the model name/i.test(msg);
    if (looksLikeModelIssue && cfg.model === DEPRECATED_DEFAULT_GEMINI_MODEL) {
      return callGeminiModel({ ...cfg, model: DEFAULT_GEMINI_MODEL }, DEFAULT_GEMINI_MODEL, prompt, parts, schema, options);
    }
    throw error;
  }
}
// ---------------- OpenAI-compatible (OpenAI, OpenRouter, custom) ----------------
async function callOpenAI(cfg: AIConfig, prompt: string, parts: any[], schema?: any, options?: CallOptions): Promise<string> {
  const base = resolveBaseUrl(cfg);
  const url = `${base}/chat/completions`;
  const hasImage = parts.some((part) => part.inlineData?.mimeType?.startsWith('image/'));
  const content: any[] = [{ type: 'text', text: prompt }];
  for (const p of parts) {
    if (p.inlineData?.mimeType?.startsWith('image/')) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` },
      });
    }
  }
  const body: any = {
    model: hasImage && cfg.visionModel?.trim() ? cfg.visionModel.trim() : cfg.model,
    temperature: 0,
    messages: [{ role: 'user', content }],
    ...(schema ? { response_format: { type: 'json_object' } } : {}),
    ...(options?.maxOutputTokens ? { max_tokens: options.maxOutputTokens } : {}),
  };
  const headers: any = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  };
  if (/openrouter\.ai/i.test(base)) {
    headers['HTTP-Referer'] = 'https://ledgr.app';
    headers['X-Title'] = 'Ledgr';
  }
  const send = async (requestBody: any) => {
    const response = await fetchAI(url, { method: 'POST', headers, body: JSON.stringify(requestBody) }, options?.timeoutMs, options?.retryTransient !== false);
    const responseText = await response.text();
    let data: any = null;
    try { data = responseText ? JSON.parse(responseText) : null; } catch { data = null; }
    return { response, data };
  };
  let result = await send(body);
  const providerMessage = result.data?.error?.message || (typeof result.data?.error === 'string' ? result.data.error : '');
  if (!result.response.ok && schema && [400, 422].includes(result.response.status) && /response[_ -]?format|json[_ -]?object|structured output/i.test(providerMessage)) {
    const fallbackBody = { ...body, messages: [{ role: 'user', content: [{ type: 'text', text: `${prompt}\n\nReturn one valid JSON object only. Do not use Markdown fences or commentary.` }, ...content.slice(1)] }] };
    delete fallbackBody.response_format;
    result = await send(fallbackBody);
  }
  if (!result.response.ok) throw aiHttpError(result.response.status, result.response.statusText, result.data);
  if (result.data?.choices?.[0]?.finish_reason === 'length') {
    throw new Error('AI response too long / statement too large â€” try a smaller image or fewer line items.');
  }
  const output = result.data?.choices?.[0]?.message?.content;
  return typeof output === 'string' ? output : Array.isArray(output) ? output.map((part: any) => part?.text || '').join('') : '';
}

function resolveTranscriptionConfig(cfg: AIConfig): { baseUrl: string; apiKey: string; model: string } {
  const provider = resolveApi(cfg);
  const baseUrl = cfg.transcriptionBaseUrl?.trim()
    ? validateAIBaseUrl(cfg.transcriptionBaseUrl)
    : provider === 'openai' ? resolveBaseUrl(cfg) : '';
  const apiKey = cfg.transcriptionApiKey?.trim() || (provider === 'openai' ? cfg.apiKey : '');
  if (!baseUrl || !apiKey) {
    throw new Error('Voice-to-text needs an OpenAI-compatible transcription Base URL and API key. Configure them in Advanced Settings; your chat provider can remain unchanged.');
  }
  return { baseUrl, apiKey, model: cfg.transcriptionModel?.trim() || 'whisper-1' };
}

async function transcribeOpenAI(cfg: AIConfig, audioBase64: string, mimeType: string, audioUri?: string): Promise<{ transcript?: string; text?: string }> {
  const voice = resolveTranscriptionConfig(cfg);
  const extension = mimeType.includes('webm') ? 'wçÎ{¶‰ËkºwµçYœè%½¹™¥œ°4(€¥¹ÁÕĞèì‰…Í”ØĞüèÍÑÉ¥¹œìµ¥µ•QåÁ”üèÍÑÉ¥¹œìÑ•áĞüèÍÑÉ¥¹œô4(¤ì4(€½¹ÍĞ¡…Í¥±”€ô€„…¥¹ÁÕĞ¹‰…Í”ØĞì4(€½¹ÍĞ¡…ÍQ•áĞ€ôÑåÁ•½˜¥¹ÁÕĞ¹Ñ•áĞ€ôôô€ÍÑÉ¥¹œœ€˜˜¥¹ÁÕĞ¹Ñ•áĞ¹ÑÉ¥´ ¤¹±•¹Ñ €ø€Àì4(€¥˜€ …¡…Í¥±”€˜˜€…¡…ÍQ•áĞ¤Ñ¡É½Ü¹•ÜÉÉ½È 9½Ñ¡¥¹œÑ¼…¹…±åé”ƒŠPÁÉ½Ù¥‘”„‘½Õµ•¹Ğ½ÈÁ…ÍÑ”¥ÑÌÑ•áĞ¸œ¤ì4(€¥˜€¡¡…Í¥±”€˜˜¥¹ÁÕĞ¹µ¥µ•QåÁ”€ôôô€…ÁÁ±¥…Ñ¥½¸½Á‘˜œ€˜˜É•Í½±Ù•Á¤¡™œ¤€„ôô€•µ¥¹¤œ¤ì4(€€€Ñ¡É½Ü¹•ÜÉÉ½È AM…¸€˜%µÁ½ÉĞ¥ÌÕÉÉ•¹Ñ±äÍÕÁÁ½ÉÑ•½¹±äİ¥Ñ Ñ¡”•µ¥¹¤ÁÉ½Ù¥‘•È¸Mİ¥Ñ Ñ¡”$ÁÉ½Ù¥‘•ÈÑ¼•µ¥¹¤°ÕÁ±½…Á…”¥µ…•Ì¥¹ÍÑ•…°½ÈÁ…ÍÑ”Ñ¡”AÑ•áĞ¸Q¡”Aİ…Ì¹½ĞÍ•¹Ğ½È…¹…±åé•¸œ¤ì4(€ô4(€½¹ÍĞÁÉ½µÁĞ€ô‰Õ¥±‘¹…±åé•½Õµ•¹ÑAÉ½µÁĞ¡¡…ÍQ•áĞ€˜˜€…¡…Í¥±”€ü¥¹ÁÕĞ¹Ñ•áĞ€èÕ¹‘•™¥¹•¤ì4(€½¹ÍĞÁ…ÉÑÌ€ô¡…Í¥±”€ümì¥¹±¥¹•…Ñ„èìµ¥µ•QåÁ”è¥¹ÁÕĞ¹µ¥µ•QåÁ”ñğ€¥µ…”½©Á•œœ°‘…Ñ„è¥¹ÁÕĞ¹‰…Í”ØĞ„ôõt€èmtì4(€½¹ÍĞ½ÕĞ€ô…İ…¥Ğ…±°¡™œ°ÁÉ½µÁĞ°Á…ÉÑÌ°91ei}=U59Q}M!5¤ì4(€ÑÉäì4(€€€É•ÑÕÉ¸Á…ÉÍ•)Í½¸¡½ÕĞ¤ì4(€ô…Ñ ì4(€€€½¹ÍĞÉ•Á…¥ÉAÉ½µÁĞ€ôÁÉ½µÁĞ€¬4(€€€€€€q¹q¹Q¡”ÁÉ¥½È•áÑÉ…Ñ¥½¸É•ÍÁ½¹Í”İ…Ì¹½ĞÙ…±¥)M=8¸¹…±åé”Ñ¡”Í…µ”‘½Õµ•¹Ğ……¥¸…¹É•ÑÕÉ¸½¹”½µÁ±•Ñ”)M=8½‰©•Ğ½¹±ä°•á…Ñ±äµ…Ñ¡¥¹œÑ¡”É•ÅÕ•ÍÑ•Í¡•µ„¸¼¹½ĞÕÍ”5…É­‘½İ¸™•¹•Ì½È½µµ•¹Ñ…Éä¸œì4(€€€½¹ÍĞÉ•Á…¥É•€ô…İ…¥Ğ…±°¡™œ°É•Á…¥ÉAÉ½µÁĞ°Á…ÉÑÌ°91ei}=U59Q}M!5¤ì4(€€€ÑÉäì4(€€€€€É•ÑÕÉ¸Á…ÉÍ•)Í½¸¡É•Á…¥É•¤ì4(€€€ô…Ñ ì4(€€€€€Ñ¡É½Ü¹•ÜÉÉ½È $É•ÑÕÉ¹•…¸Õ¹É•…‘…‰±”‘½Õµ•¹ĞÉ•ÍÕ±Ğ¸QÉä„±•…É•È¥µ…”°„Íµ…±±•È‘½Õµ•¹Ğ°½ÈÁ…ÍÑ”Ñ¡”Ñ•áĞ¥¹ÍÑ•…¸œ¤ì4(€€€ô4(€ô4)ô4(4(¼¼-¹½İ±•‘”…‰½ÕĞÑ¡”…ÁÀ¥ÑÍ•±˜°Í¼Ñ¡”…ÍÍ¥ÍÑ…¹Ğ…¸•áÁ±…¥¸¡½ÜÑ¼ÕÍ”¥Ğ¸4)½¹ÍĞAA}U%€ô4(€€‰Q¡¥Ì…ÁÀ¥Ì1•‘È°„‰½½­­••Á¥¹œ…ÁÀ™½ÈÍµ…±°‰ÕÍ¥¹•ÍÍ•Ì€¡Í¡½ÁÌ°Í•ÉÙ¥”ÁÉ½Ù¥‘•ÉÌ°É•Ñ…¥±•ÉÌ¤¸€ˆ€¬4(€€‰1•‘•È‘…Ñ„¥ÌÍÑ½É•½¸Ñ¡”Á¡½¹”¸]¡•¸Ñ¡”ÕÍ•È•áÁ±¥¥Ñ±äÕÍ•Ì…¸$™•…ÑÕÉ”°½¹±äÑ¡”ÁÉ½µÁĞ…¹É•±•Ù…¹ĞÍ•±•Ñ•‘…Ñ„°¥µ…”°…Õ‘¥¼°½ÈÍÑ…Ñ•µ•¹Ğ…É”Í•¹Ğ‘¥É•Ñ±äÑ¼Ñ¡•¥È¡½Í•¸$ÁÉ½Ù¥‘•È¸€ˆ€¬4(€€‰5…¥¸™•…ÑÕÉ•Ì…¹İ¡•É”Ñ¼™¥¹Ñ¡•´éq¸ˆ€¬4(€€ˆ´…Í¡‰½…É€¡!½µ”¤è…Í °¥¹Ù•¹Ñ½ÉäÙ…±Õ”°¹•Ğİ½ÉÑ °Í…±•Ì°ÁÕÉ¡…Í•Ì°ÁÉ½™¥Ğ…Ğ„±…¹”¹q¸ˆ€¬4(€€ˆ´AÕÉ¡…Í•Ì€¡	¥±±Ì¤èÉ•½Éİ¡…Ğå½Ô‰Õä™É½´ÍÕÁÁ±¥•ÉÌ½Ù•¹‘½ÉÌ€¡…Í ½ÈÉ•‘¥Ğ¤¹q¸ˆ€¬4(€€ˆ´M…±•ÌèÉ•½ÉÕÍÑ½µ•ÈÉ•Ù•¹Õ”¹q¸ˆ€¬4(€€ˆ´I••¥ÁÑÌèÉ•½Éµ½¹•ä…ÑÕ…±±äÉ••¥Ù•¸Q¡É•”­¥¹‘ÌƒŠP…Í M…±”€¡İ…±¬µ¥¸Á…¥¹½Ü¤°€ˆ€¬4(€€‰…¥¹ÍĞ%¹Ù½¥”€¡Í•ÑÑ±•Ìİ¡…Ğ„ÕÍÑ½µ•È½İ•Ì°™Õ±°½ÈÁ…ÉÑ¥…°¤°…¹‘Ù…¹”€¡µ½¹•ä‰•™½É”…¸¥¹Ù½¥”¤¸€ˆ€¬4(€€‰Ù•ÉäÉ••¥ÁĞÕÁ‘…Ñ•Ì…Í ì……¥¹ÍĞµ¥¹Ù½¥”É••¥ÁÑÌ…±Í¼ÕÁ‘…Ñ”Ñ¡”ÕÍÑ½µ•ÈÌ‰…±…¹”…¹µ…É¬Ñ¡”¥¹Ù½¥”Á…¥½Á…ÉÑ¥…°¹q¸ˆ€¬4(€€ˆ´%¹Ù½¥•ÌèÉ•…Ñ”¥¹Ù½¥•Ì°Í¡…É”…ÌA½È½¸]¡…ÑÍÁÀ°µ…É¬Á…¥¸¸¥¹Ù½¥”…ÕÑ½µ…Ñ¥…±±ä€ˆ€¬4(€€‰É•…Ñ•Ì½ÕÁ‘…Ñ•Ì„•‰Ñ½È€¡Ñ¡”ÕÍÑ½µ•Èİ¡¼½İ•Ìå½Ô¤¹q¸ˆ€¬4(€€ˆ´EÕ½Ñ•Ì½ÍÑ¥µ…Ñ•ÌèÉ•…Ñ”„ÁÉ¥”ÅÕ½Ñ”€¡¹¼±•‘•È•™™•Ğ¤ìİ¡•¸Ñ¡”ÕÍÑ½µ•È…•ÁÑÌ°½¹Ù•ÉĞ¥ĞÑ¼…¸¥¹Ù½¥”¥¸½¹”Ñ…À¹q¸ˆ€¬4(€€ˆ´É•‘¥Ğ½•‰¥Ğ9½Ñ•Ìè™É½´„ÕÍÑ½µ•ÈÌ•‰Ñ½ÈÍÉ••¸°¥Ù”„Á½ÍĞµÍ…±”‘¥Í½Õ¹Ğ½ÈÉ•½É„É•ÑÕÉ¸€¡É•‘¥Ğ¹½Ñ”°±½İ•ÉÌÑ¡•¥È‰…±…¹”¤½È…‘…¸•áÑÉ„¡…É”€¡‘•‰¥Ğ¹½Ñ”¤¸9¼…Í µ½Ù•Ì¹q¸ˆ€¬4(€€ˆ´•±¥Ù•Éä9½Ñ•Ì½¡…±±…¹ÌèÉ•½É½½‘Ì¡…¹‘•Ñ¼„ÕÍÑ½µ•È€¡ÅÕ…¹Ñ¥Ñä½¹±ä°¹¼ÁÉ¥•Ì¤ìÍ¡…É”…ÌA¸9¼±•‘•È•™™•Ğ¹q¸ˆ€¬4(€€ˆ´•‰Ñ½ÉÌèİ¡¼½İ•Ìå½Ôµ½¹•äìÉ•½ÉÁ…åµ•¹ÑÌìÍ•¹]¡…ÑÍÁÀÉ•µ¥¹‘•ÉÌ¹q¸ˆ€¬4(€€ˆ´É•‘¥Ñ½ÉÌèÍÕÁÁ±¥•ÉÌå½Ô½İ”ìÉÕ¹¹¥¹œ‰…±…¹•Ìì]¡…ÑÍÁÀÉ•µ¥¹‘•ÉÌ¹q¸ˆ€¬4(€€ˆ´áÁ•¹Í•Ìè‘…äµÑ¼µ‘…ä½ÍÑÌ‰ä…Ñ•½Éä¹q¸ˆ€¬4(€€ˆ´%¹Ù•¹Ñ½ÉäèÍÑ½¬½Õ¹ÑÌ¸AÉ½™¥ĞÕÍ•ÌÁ•É¥½‘¥Œ¥¹Ù•¹Ñ½Éäè=L€ô½Á•¹¥¹œÍÑ½¬€¬ÁÕÉ¡…Í•Ì€´±½Í¥¹œÍÑ½¬¹q¸ˆ€¬4(€€ˆ´I•Á½ÉÑÌèAÉ½™¥Ğ€˜1½ÍÌ°	…±…¹”M¡••Ğ°QÉ¥…°	…±…¹”°A…ÉÑ¹•È…Á¥Ñ…°°É…İ¥¹Ì°İ¥Ñ ‘…Ñ”µÉ…¹”™¥±Ñ•ÉÌ…¹¡…ÉÑÌ¹q¸ˆ€¬4(€€ˆ´…ä	½½¬è•Ù•ÉäÑÉ…¹Í…Ñ¥½¸¥¸‘…Ñ”½É‘•È¹q¸ˆ€¬4(€€ˆ´I•½¹¥±”èÁ¡½Ñ½É…Á ½ÈÕÁ±½…„ÍÕÁÁ±¥•ÈÍÑ…Ñ•µ•¹Ğ½Aì$½µÁ…É•Ì¥ĞÑ¼å½ÕÈ±•‘•È¹q¸ˆ€¬4(€€ˆ´Y½¥”½…µ•É„•¹ÑÉäèÍÁ•…¬…¸•¹ÑÉä½ÈÍ¹…À„É••¥ÁĞì$™¥±±ÌÑ¡”™½É´€¡å½Ô½¹™¥É´‰•™½É”Í…Ù¥¹œ¤¹q¸ˆ€¬4(€€ˆ´M•ÑÑ¥¹Ìè‰ÕÍ¥¹•ÍÌÁÉ½™¥±”°ÕÉÉ•¹ä€ ÄÔ½ÁÑ¥½¹Ì¤°Ñ…à±…‰•°€˜É…Ñ”°Á…ÉÑ¹•È¹…µ•Ì°½Á•¹¥¹œ…Á¥Ñ…°°€ˆ€¬4(€€‰‰…­ÕÀ½É•ÍÑ½É”°]¡…ÑÍÁÀÍ¡…É”°…¹Ñ¡”$ÁÉ½Ù¥‘•È€¬A$­•ä¹q¸ˆ€¬4(€€ˆ´Í¬$€¡Ñ¡¥ÌÍÉ••¸¤è…Í¬ÅÕ•ÍÑ¥½¹Ì…‰½ÕĞå½ÕÈ‰½½­Ì°•¹•É…°ÅÕ•ÍÑ¥½¹Ì°¡½ÜÑ¼ÕÍ”Ñ¡”…ÁÀ°…¹É•ÅÕ•ÍĞ¡…¹•Ì¸ˆì4(4(¼¼Ñ¥½¹ÌÑ¡”$¥Ì…±±½İ•Ñ¼AI=A=M¸Q¡”…ÁÀ•á•ÕÑ•ÌÑ¡•´½¹±ä…™Ñ•ÈÑ¡”ÕÍ•È4(¼¼Ñ¥½¹ÌÑ¡”$¥Ì…±±½İ•Ñ¼AI=A=M¸Q¡”…ÁÀ•á•ÕÑ•ÌÑ¡•´½¹±ä…™Ñ•ÈÑ¡”ÕÍ•È4(¼¼½¹™¥ÉµÌ¸Q¡¥Ì±¥ÍĞ¥ÌaQ1dÑ¡”…Ñ¥½¸ÑåÁ•Ì¥¸M-}M!5¸4(¼¼Q¡”µ½‘•°µ…äÁÉ½Á½Í”½¹±äÑ¡”•áÁ±¥¥Ñ±ä±¥ÍÑ•…ÁÀµÕÑ…Ñ¥½¹Ì¸Y…±¥‘…Ñ¥½¸…¹4(¼¼…¸¥¸µ¡…Ğ½¹™¥Éµ…Ñ¥½¸…Ñ”É•µ…¥¸…ÕÑ¡½É¥Ñ…Ñ¥Ù”‰•™½É”…¹äİÉ¥Ñ”•á•ÕÑ•Ì¸4)½¹ÍĞQ%=9}MA€ô4(€€‰I•ÑÕÉ¸…¸…Ñ¥½¸½¹±äİ¡•¸Ñ¡”ÕÍ•È±•…É±ä…Í­Ì1•‘ÈÑ¼É•…Ñ”°ÕÁ‘…Ñ”°É•Ù•ÉÍ”°½È‘•±•Ñ”…ÁÀ‘…Ñ„°=Hİ¡•¸Ñ¡”ÕÍ•È±…É¥™¥•Ì½½¹™¥ÉµÌ„ÁÉ•Ù¥½ÕÌÉ•ÅÕ•ÍĞ¥¸Ñ¡”½¹Ù•ÉÍ…Ñ¥½¸¸€ˆ€¬4(€€‰%˜…¹äÉ•ÅÕ¥É•‘•Ñ…¥°¥Ìµ¥ÍÍ¥¹œ½È…µ‰¥Õ½ÕÌ°Í•Ğ…Ñ¥½¸Ñ¼¹Õ±°…¹…Í¬½¹”½¹¥Í”½Õ¹Ñ•ÈµÅÕ•ÍÑ¥½¸¥¸…¹Íİ•È¸€ˆ€¬4(€€‰9•Ù•È±…¥´Ñ¡…Ğ…¸•¹ÑÉä¥ÌÁÉ•Á…É•Õ¹±•ÍÌ„½µÁ±•Ñ”…Ñ¥½¸½‰©•Ğ¥ÌÉ•ÑÕÉ¹•¸€ˆ€¬4(€€‰UÍ”•á…ĞÁ…ÉÑä…¹•¹ÑÉä%Ì™É½´Ñ¡”‘…Ñ„Í¹…ÁÍ¡½Ğİ¡•¹•Ù•ÈÑ¡•ä…É”…Ù…¥±…‰±”¸9•Ù•È¥¹Ù•¹Ğ…¸%¹q¸ˆ€¬4(€€‰IQQ%=9Léq¸ˆ€¬4(€€ˆ´…‘‘}•áÁ•¹Í”èì…Ñ•½Éä°…µ½Õ¹Ğ°‘…Ñ”ü°¹½Ñ•Ìüõq¸ˆ€¬4(€€ˆ´…‘‘}Í…±”èì…µ½Õ¹Ğ°‘…Ñ”ü°Á…åµ•¹ÑQåÁ”ü€ …Í ğÉ•‘¥Ğœ¤°¹½Ñ•Ìüõq¸ˆ€¬4(€€ˆ´…‘‘}‰¥±°èìÍÕÁÁ±¥•É9…µ”°…µ½Õ¹Ğ°‘…Ñ”ü°Á…åµ•¹ÑQåÁ”ü€ …Í ğÉ•‘¥Ğœ¤°¹½Ñ•Ìüõq¸ˆ€¬4(€€ˆ´É•…Ñ•}ÍÕÁÁ±¥•É}Á…åµ•¹ĞèìÍÕÁÁ±¥•É9…µ”°…µ½Õ¹Ğ°‘…Ñ”ü°µ•Ñ¡½ü€ …Í ğ…Éğ‰…¹¬ğÕÁ¤œ¤°¹½Ñ•Ìüõq¸ˆ€¬4(€€ˆ´…‘‘}‘•‰Ñ½Èèì¹…µ”°Á¡½¹”ü°¹½Ñ•Ìüõq¸ˆ€¬4(€€ˆ´…‘‘}ÍÕÁÁ±¥•Èèì¹…µ”°Á¡½¹”ü°¹½Ñ•Ìüõq¸ˆ€¬4(€€ˆ´…‘‘}‘•‰Ñ½É}Á…åµ•¹Ğèì¹…µ”°…µ½Õ¹Ğ°‘…Ñ”ü°µ•Ñ¡½üô€¡µ½¹•äI%Y™É½´„ÕÍÑ½µ•È¥q¸ˆ€¬4(€€ˆ´É•…Ñ•}¥¹Ù½¥”èì±¥•¹Ñ9…µ”°…µ½Õ¹Ğ°‘…Ñ”ü°¹½Ñ•Ìüõq¸ˆ€¬4(€€ˆ´É•…Ñ•}É••¥ÁĞèì…µ½Õ¹Ğ°µ½‘”€ …Í¡}Í…±”ğ……¥¹ÍÑ}¥¹Ù½¥”ğ…‘Ù…¹”œ¤°ÕÍÑ½µ•É9…µ”ü°¥¹Ù½¥•%ü€¡É•ÅÕ¥É•™½È……¥¹ÍÑ}¥¹Ù½¥”¤°‘…Ñ”ü°µ•Ñ¡½ü€ …Í ğ…Éğ‰…¹¬ğÕÁ¤œ¤°¹½Ñ•Ìüõq¸ˆ€¬4(€€ˆ´É•…Ñ•}ÅÕ½Ñ”èì±¥•¹Ñ9…µ”°…µ½Õ¹Ğ°‘…Ñ”ü°¹½Ñ•Ìüõq¸ˆ€¬4(€€ˆ´É•…Ñ•}‘É…İ¥¹œèìÁ…ÉÑ¹•É9…µ”°…µ½Õ¹Ğ°‘…Ñ”ü°¹½Ñ•Ìüô€¡A…ÉÑ¹•Èİ¥Ñ¡‘É…İ…°€¼‘É…İ¥¹œ€¼Á…å½ÕĞQ<„Á…ÉÑ¹•È™É½´Ñ¡•¥È…Á¥Ñ…°…½Õ¹Ğ¥q¸ˆ€¬4(€€ˆ´…‘‘}…Á¥Ñ…°èìÁ…ÉÑ¹•É9…µ”°…µ½Õ¹Ğ°‘…Ñ”ü°¹½Ñ•Ìüô€¡A…ÉÑ¹•È‘•Á½Í¥Ğ€¼¥¹Ù•ÍÑµ•¹Ğ€¼…‘‘¥Ñ¥½¸Q<Ñ¡•¥È…Á¥Ñ…°…½Õ¹Ğ¥q¸ˆ€¬4(€€ˆ´É•½É‘}¥¹Ù•¹Ñ½Éäèì…µ½Õ¹Ğ°‘…Ñ”ü°¹½Ñ•Ìüõq¸ˆ€¬4(€€‰!9Q%=9L€¡Ñ¡”•á…ĞÑ…É•ĞµÕÍĞ•á¥ÍĞ¥¸É••¹Ñ¹ÑÉ¥•Ì½Á…ÉÑ¥•Ì¤éq¸ˆ€¬4(€€ˆ´ÕÁ‘…Ñ•}•¹ÑÉäèì•¹Ñ¥Ñä°¥°µ•µ‰•É%ü°¡…¹•Ìõq¸ˆ€¬4(€€ˆ´‘•±•Ñ•}•¹ÑÉäèì•¹Ñ¥Ñä°¥°µ•µ‰•É%üõq¸ˆ€¬4(€€‰MÕÁÁ½ÉÑ••¹Ñ¥Ñ¥•Ìè•áÁ•¹Í”°Í…±”°‰¥±°°ÍÕÁÁ±¥•É}Á…åµ•¹Ğ°É••¥ÁĞ°¥¹Ù½¥”°ÅÕ½Ñ”°ÕÍÑ½µ•È°ÍÕÁÁ±¥•È°‘•±¥Ù•Éå}¹½Ñ”°¹½Ñ”°¥¹Ù•¹Ñ½Éå}½Õ¹Ğ°…Á¥Ñ…°°‘É…İ¥¹œ°…Í¡}•¹ÑÉä¸€ˆ€¬4(€€‰%¹Ù•¹Ñ½Éä½Õ¹ÑÌ…¸‰”‘•±•Ñ•‰ÕĞµÕÍĞ‰”½ÉÉ•Ñ•‰äÉ•Ù•ÉÍ¥¹œ…¹É•½É‘¥¹œ„¹•Ü½Õ¹Ğì‘¼¹½ĞÁÉ½Á½Í”ÕÁ‘…Ñ•}•¹ÑÉä™½È¥¹Ù•¹Ñ½Éå}½Õ¹Ğ¸ÕÍÑ½µ•È…¹MÕÁÁ±¥•ÈÉ•½É‘Ìµ…ä‰”ÕÁ‘…Ñ•‰ÕĞµÕÍĞ¹½Ğ‰”‘•±•Ñ•¡•É”¸€ˆ€¬4(€€‰½È…Á¥Ñ…°…Ñ¥½¹Ì¥¹±Õ‘”µ•µ‰•É%™É½´…Á¥Ñ…±½Õ¹ÑÌ¸•±•Ñ¥¹œ„Á½ÍÑ•…½Õ¹Ñ¥¹œ•¹ÑÉäµ•…¹Ì„Í…™”É•Ù•ÉÍ…°°¹½Ğ•É…Í¥¹œ…Õ‘¥Ğ¡¥ÍÑ½Éä¸€ˆ€¬4(€€‰½È€Á…¥`Ñ¼95œè%˜95¥Ì¥¸…Á¥Ñ…±½Õ¹ÑÌ½È„Á…ÉÑ¹•È°ÁÉ½Á½Í”É•…Ñ•}‘É…İ¥¹œ¸%˜95¥Ì„­¹½İ¸ÍÕÁÁ±¥•È°ÁÉ½Á½Í”É•…Ñ•}ÍÕÁÁ±¥•É}Á…åµ•¹Ğ¸=Ñ¡•Éİ¥Í”…Í¬İ¡•Ñ¡•È¥Ğ¥Ì„ÍÕÁÁ±¥•ÈÁ…åµ•¹Ğ°Á…ÉÑ¹•Èİ¥Ñ¡‘É…İ…°°•áÁ•¹Í”°½ÈÍ½µ•Ñ¡¥¹œ•±Í”¸€ˆ€¬4(€€‰½È€É••¥Ù•`™É½´95œè%˜95¥Ì¥¸…Á¥Ñ…±½Õ¹ÑÌ½È„Á…ÉÑ¹•È°ÁÉ½Á½Í”…‘‘}…Á¥Ñ…°¸%˜95¥Ì„­¹½İ¸ÕÍÑ½µ•È°ÁÉ½Á½Í”É•…Ñ•}É••¥ÁĞ¸=Ñ¡•Éİ¥Í”…Í¬İ¡•Ñ¡•È¥Ğ¥Ì„ÕÍÑ½µ•ÈÉ••¥ÁĞ°Á…ÉÑ¹•È…Á¥Ñ…°‘•Á½Í¥Ğ°…Í Í…±”°½ÈÍ½µ•Ñ¡¥¹œ•±Í”¸€ˆ€¬4(€€‰µ½Õ¹ÑÌè±İ…åÌ½ÕÑÁÕĞ…µ½Õ¹Ñ€¥¸Á…É…µÌ…Ì„ÁÕÉ”Á½Í¥Ñ¥Ù”¹Õµ‰•È€¡”¹œ¸€ÄÀÀ°¹½Ğ€œÄÀÀœ¤¸€ˆ€¬4(€€‰…Ñ•Ì…É”eeedµ54µì‘•™…Õ±ĞÑ¼Ñ¡”‘•Ù¥”µ±½…°‘…Ñ”¥˜½µ¥ÑÑ•¸9•Ù•È¥¹Ù•¹Ğ…µ½Õ¹ÑÌ°Á…ÉÑ¥•Ì°É½±•Ì°•¹ÑÉä%Ì°½Èµ¥ÍÍ¥¹œ¥¹Ù½¥”±¥¹•Ì¸ˆì4(4)•áÁ½ÉĞÑåÁ”Í­!¥ÍÑ½Éå5•ÍÍ…”€ôìÉ½±”è€ÕÍ•Èœğ€…ÍÍ¥ÍÑ…¹ĞœìÑ•áĞèÍÑÉ¥¹œôì4(4)•áÁ½ÉĞ™Õ¹Ñ¥½¸¥ÍáÁ±¥¥Ñ	½½­5ÕÑ…Ñ¥½¹I•ÅÕ•ÍĞ¡ÅÕ•ÍÑ¥½¸èÍÑÉ¥¹œ°¡¥ÍÑ½ÉäüèÍ­!¥ÍÑ½Éå5•ÍÍ…•mt¤è‰½½±•…¸ì4(€½¹ÍĞÄ€ôÅÕ•ÍÑ¥½¸¹Ñ½1½İ•É…Í” ¤ì4(€½¹ÍĞ¡…¹•Y•Éˆ€ô€½qˆ¡…‘‘ñÉ•½É‘ñÉ•…Ñ•ñ•¹Ñ•ÉñÍ…Ù•ñÁ½ÍÑñ±½ñÉ•¥ÍÑ•Éñ•‘¥ÑñÕÁ‘…Ñ•ñ¡…¹•ñ½ÉÉ•Ññ‘•±•Ñ•ñÉ•µ½Ù•ñÉ•Ù•ÉÍ•ñÙ½¥‘ñ…¹•°¥qˆ¼¹Ñ•ÍĞ¡Ä¤ì4(€½¹ÍĞ…½Õ¹Ñ¥¹=‰©•Ğ€ô€½qˆ¡•áÁ•¹Í•ñÍ…±•ñ‰¥±±ñÁÕÉ¡…Í•ñÕÍÑ½µ•Éñ‘•‰Ñ½ÉñÍÕÁÁ±¥•ÉñÉ•‘¥Ñ½ÉñÁ…åµ•¹Ññ¥¹Ù½¥•ñÉ••¥ÁÑñÅÕ½Ñ•ñÑÉ…¹Í…Ñ¥½¹ñ•¹ÑÉåñ…Á¥Ñ…±ñ‘É…İ¥¹ñ‘É…İ¥¹Íñİ¥Ñ¡‘É…İ…±ñ¥¹Ù•¹Ñ½ÉåñÍÑ½­ñ¹½Ñ”¥qˆ¼¹Ñ•ÍĞ¡Ä¤ì4(€½¹ÍĞÍÑ…Ñ•‘5½¹•å5½Ù•µ•¹Ğ€ô€½qˆ¡Á…¥‘ñÉ••¥Ù•‘ñÍ½±‘ñ‰½Õ¡ÑñÁÕÉ¡…Í•‘ñÍÁ•¹Ññ‘•Á½Í¥Ñ•‘ñİ¥Ñ¡‘É•İñİ¥Ñ¡‘É…Ü¥qˆ¼¹Ñ•ÍĞ¡Ä¤€˜˜€½q¼¹Ñ•ÍĞ¡Ä¤ì4(€¥˜€ ¡¡…¹•Y•Éˆ€˜˜…½Õ¹Ñ¥¹=‰©•Ğ¤ñğÍÑ…Ñ•‘5½¹•å5½Ù•µ•¹Ğ¤É•ÑÕÉ¸ÑÉÕ”ì4(4(€¥˜€¡ÉÉ…ä¹¥ÍÉÉ…ä¡¡¥ÍÑ½Éä¤€˜˜¡¥ÍÑ½Éä¹±•¹Ñ €ø€À¤ì4(€€€½¹ÍĞÕÍ•É!¥ÍÑ½Éä€ô¡¥ÍÑ½Éä¹™¥±Ñ•È ¡ ¤€ôø ¹É½±”€ôôô€ÕÍ•Èœ¤¹µ…À ¡ ¤€ôø ¹Ñ•áĞ¹Ñ½1½İ•É…Í” ¤¤¹©½¥¸ œ€œ¤ì4(€€€¥˜€¡¥ÍáÁ±¥¥Ñ	½½­5ÕÑ…Ñ¥½¹I•ÅÕ•ÍĞ¡ÕÍ•É!¥ÍÑ½Éä¤¤ì4(€€€€€½¹ÍĞ±…É¥™å¥¹Q•É´€ô€½qˆ¡İ¥Ñ¡‘É…İ…±ñ‘É…İ¥¹ñ‘É…İ¥¹Íñ…Á¥Ñ…±ñ•áÁ•¹Í•ñÍÕÁÁ±¥•ÉñÕÍÑ½µ•ÉñÍ…±•ñ‰¥±±ñ…Í¡ñ‰…¹­ñ…É‘ñÕÁ¥ñå•ÍñÁÉ½••‘ñ½¹™¥É´¥qˆ½¤¹Ñ•ÍĞ¡Ä¤ì4(€€€€€¥˜€¡±…É¥™å¥¹Q•É´ñğ…½Õ¹Ñ¥¹=‰©•Ğ¤É•ÑÕÉ¸ÑÉÕ”ì4(€€€ô4(€ô4(€É•ÑÕÉ¸™…±Í”ì4)ô4(4)•áÁ½ÉĞ™Õ¹Ñ¥½¸¥Í±•…É±åáÑ•É¹…±EÕ•ÍÑ¥½¸¡ÅÕ•ÍÑ¥½¸èÍÑÉ¥¹œ¤è‰½½±•…¸ì4(€½¹ÍĞÄ€ôÅÕ•ÍÑ¥½¸¹Ñ½1½İ•É…Í” ¤ì4(€½¹ÍĞ±•‘É½¹Ñ•áĞ€ô€½qˆ¡µåñ½ÕÉñ±•‘Éñ‰½½­ñ‰½½­Íñ‰ÕÍ¥¹•ÍÍñ•áÁ•¹Í•ñÍ…±•ñ‰¥±±ñÁÕÉ¡…Í•ñÕÍÑ½µ•Éñ‘•‰Ñ½ÉñÍÕÁÁ±¥•ÉñÉ•‘¥Ñ½ÉñÁ…åµ•¹Ññ¥¹Ù½¥•ñÉ••¥ÁÑñÅÕ½Ñ•ñÑÉ…¹Í…Ñ¥½¹ñ•¹ÑÉåñ…Á¥Ñ…±ñ‘É…İ¥¹ñ¥¹Ù•¹Ñ½ÉåñÍÑ½­ñÁÉ½™¥Ññ±½ÍÍñ…Í¡ñ‰…±…¹•ñÉ•Á½ÉÑñÑ…à¥qˆ¼¹Ñ•ÍĞ¡Ä¤ì4(€½¹ÍĞ•áÑ•É¹…±Q½Á¥Œ€ô€½qˆ¡¹¥™ÑåñÍ•¹Í•áñÍÑ½¬ÁÉ¥•ñÍ¡…É”ÁÉ¥•ñµ…É­•ĞÁÉ¥•ñÉåÁÑ½ñ‰¥Ñ½¥¹ñİ•…Ñ¡•Éñ¹•İÍñ¡•…‘±¥¹•ñÍÁ½ÉÑÌÍ½É•ñ•á¡…¹”É…Ñ•ñÕÉÉ•¹ĞÁÉ¥”¥qˆ¼¹Ñ•ÍĞ¡Ä¤ì4(€É•ÑÕÉ¸•áÑ•É¹…±Q½Á¥Œ€˜˜€…±•‘É½¹Ñ•áĞì4)ô4(4)™Õ¹Ñ¥½¸…Ñ¥½¹¥É•Ñ¥½¹±…É¥™¥…Ñ¥½¸¡ÅÕ•ÍÑ¥½¸èÍÑÉ¥¹œ°…Ñ¥½¹QåÁ”èÍÑÉ¥¹œ¤èÍÑÉ¥¹œğ¹Õ±°ì4(€½¹ÍĞ™Õ±±Q•áĞ€ôÅÕ•ÍÑ¥½¸¹Ñ½1½İ•É…Í” ¤ì4(€¥˜€ ½q‰Á…¥‘q‰mqÍqMt©q‰Ñ½qˆ¼¹Ñ•ÍĞ¡™Õ±±Q•áĞ¤€˜˜€…lÉ•…Ñ•}ÍÕÁÁ±¥•É}Á…åµ•¹Ğœ°€É•…Ñ•}‘É…İ¥¹œt¹¥¹±Õ‘•Ì¡…Ñ¥½¹QåÁ”¤€˜˜€„½qˆ¡•áÁ•¹Í•ñ‰¥±±ñÁÕÉ¡…Í•ñ…Á¥Ñ…±ñ‘É…İ¥¹ñ‘É…İ¥¹Íñİ¥Ñ¡‘É…İ…±ñÁ…ÉÑ¹•È¥qˆ¼¹Ñ•ÍĞ¡™Õ±±Q•áĞ¤¤ì4(€€€É•ÑÕÉ¸€%ÌÑ¡¥Ì…¸½ÕÑ½¥¹œÍÕÁÁ±¥•ÈÁ…åµ•¹Ğ°…¸•áÁ•¹Í”°½È…¹½Ñ¡•ÈÑåÁ”½˜Á…åµ•¹Ğüœì4(€ô4(€¥˜€ ½q‰É••¥Ù•‘q‰mqÍqMt©q‰™É½µqˆ¼¹Ñ•ÍĞ¡™Õ±±Q•áĞ¤€˜˜lÉ•…Ñ•}ÍÕÁÁ±¥•É}Á…åµ•¹Ğœ°€…‘‘}•áÁ•¹Í”œ°€…‘‘}‰¥±°t¹¥¹±Õ‘•Ì¡…Ñ¥½¹QåÁ”¤¤ì4(€€€É•ÑÕÉ¸€%ÌÑ¡¥Ìµ½¹•äÉ••¥Ù•™É½´„ÕÍÑ½µ•È°„…Í Í…±”°½È…¹½Ñ¡•ÈÑåÁ”½˜É••¥ÁĞüœì4(€ô4(€É•ÑÕÉ¸¹Õ±°ì4)ô4(4)™Õ¹Ñ¥½¸±½…±±½­½¹Ñ•áĞ¡¹½Ü€ô¹•Ü…Ñ” ¤¤èÍÑÉ¥¹œì4(€½¹ÍĞ½™™Í•Ñ5¥¹ÕÑ•Ì€ô€µ¹½Ü¹•ÑQ¥µ•é½¹•=™™Í•Ğ ¤ì4(€½¹ÍĞÍ¥¸€ô½™™Í•Ñ5¥¹ÕÑ•Ì€øô€À€ü€œ¬œ€è€œ´œì4(€½¹ÍĞ…‰Í½±ÕÑ”€ô5…Ñ ¹…‰Ì¡½™™Í•Ñ5¥¹ÕÑ•Ì¤ì4(€½¹ÍĞ½™™Í•Ğ€ô€‘íÍ¥¹ô‘íMÑÉ¥¹œ¡5…Ñ ¹™±½½È¡…‰Í½±ÕÑ”€¼€ØÀ¤¤¹Á…‘MÑ…ÉĞ È°€œÀœ¥ôè‘íMÑÉ¥¹œ¡…‰Í½±ÕÑ”€”€ØÀ¤¹Á…‘MÑ…ÉĞ È°€œÀœ¥õ€ì4(€½¹ÍĞ±½…±%Í¼€ô¹•Ü…Ñ”¡¹½Ü¹•ÑQ¥µ” ¤€´¹½Ü¹•ÑQ¥µ•é½¹•=™™Í•Ğ ¤€¨€ØÁ|ÀÀÀ¤¹Ñ½%M=MÑÉ¥¹œ ¤¹Í±¥” À°€Ää¤ì4(€±•Ğé½¹”€ô€œœì4(€ÑÉäìé½¹”€ô%¹Ñ°¹…Ñ•Q¥µ•½Éµ…Ğ ¤¹É•Í½±Ù•‘=ÁÑ¥½¹Ì ¤¹Ñ¥µ•i½¹”ñğ€œœìô…Ñ íô4(€É•ÑÕÉ¸€‘í±½…±%Í½ôUQ‘í½™™Í•Ñô‘íé½¹”€ü€œ€ œ€¬é½¹”€¬€œ¤œ€è€œõ€ì4)ô4(4)½¹ÍĞM-}M!5€ôì4(€ÑåÁ”è€½‰©•Ğœ°4(€ÁÉ½Á•ÉÑ¥•Ìèì4(€€€…¹Íİ•ÈèìÑåÁ”è€ÍÑÉ¥¹œœô°4(€€€…Ñ¥½¸èì4(€€€€€ÑåÁ”è€½‰©•Ğœ°4(€€€€€ÁÉ½Á•ÉÑ¥•Ìèì4(€€€€€€€ÑåÁ”èì4(€€€€€€€€€ÑåÁ”è€ÍÑÉ¥¹œœ°4(€€€€€€€€€•¹Õ´èl…‘‘}•áÁ•¹Í”œ°€±½}Á•ÉÍ½¹…±}•áÁ•¹Í”œ°€…‘‘}Í…±”œ°€…‘‘}‰¥±°œ°€É•…Ñ•}ÍÕÁÁ±¥•É}Á…åµ•¹Ğœ°€…‘‘}‘•‰Ñ½Èœ°€…‘‘}ÍÕÁÁ±¥•Èœ°€…‘‘}‘•‰Ñ½É}Á…åµ•¹Ğœ°€É•…Ñ•}¥¹Ù½¥”œ°€É•…Ñ•}É••¥ÁĞœ°€É•…Ñ•}ÅÕ½Ñ”œ°€É•…Ñ•}‘É…İ¥¹œœ°€…‘‘}…Á¥Ñ…°œ°€É•½É‘}¥¹Ù•¹Ñ½Éäœ°€ÕÁ‘…Ñ•}•¹ÑÉäœ°€‘•±•Ñ•}•¹ÑÉät°4(€€€€€€€ô°4(€€€€€€€Á…É…µÌèìÑåÁ”è€½‰©•Ğœô°4(€€€€€€€½¹™¥É´èìÑåÁ”è€ÍÑÉ¥¹œœô°€¼¼½¹”µ±¥¹”¡Õµ…¸ÍÕµµ…ÉäÑ¼Í¡½Ü‰•™½É”…ÁÁ±å¥¹œ4(€€€€€ô°4(€€€ô°4(€ô°4(€É•ÅÕ¥É•èl…¹Íİ•Èt°4)ôì4(4(¼¨¨4(€¨É•”µ™½É´…ÍÍ¥ÍÑ…¹Ğ…‰½ÕĞÑ¡”‰½½­Ì¸4(€¨I•ÑÕÉ¹Ìì…¹Íİ•È°…Ñ¥½¸üôİ¡•É”…Ñ¥½¸€¡¥˜ÁÉ•Í•¹Ğ¤¥Ì„ÁÉ½Á½Í•‘…Ñ„¡…¹”4(€¨™½ÈÑ¡”…ÁÀÑ¼½¹™¥É´µ…¹µ…ÁÁ±ä¸4(€¨¼4)•áÁ½ÉĞ…Íå¹Œ™Õ¹Ñ¥½¸…Í­	½½­Ì¡™œè%½¹™¥œ°ÅÕ•ÍÑ¥½¸èÍÑÉ¥¹œ°‘…Ñ…½¹Ñ•áĞèÍÑÉ¥¹œ¤ì4(€¥˜€¡¥Í±•…É±åáÑ•É¹…±EÕ•ÍÑ¥½¸¡ÅÕ•ÍÑ¥½¸¤¤ì4(€€€É•ÑÕÉ¸ì…¹Íİ•Èè€1•‘È¥Ì™½ÕÍ•½¸å½ÕÈ‰ÕÍ¥¹•ÍÌ°‰½½­­••Á¥¹œ°É•Á½ÉÑÌ°…¹…ÁÀİ½É­™±½İÌ¸$…¹¹½ĞÁÉ½Ù¥‘”±¥Ù”µ…É­•Ğ°¹•İÌ°İ•…Ñ¡•È°½È½Ñ¡•È•áÑ•É¹…°¥¹™½Éµ…Ñ¥½¸¸œ°…Ñ¥½¸è¹Õ±°ôì4(€ô4(€½¹ÍĞ±½…±9½Ü€ô±½…±±½­½¹Ñ•áĞ ¤ì4(€½¹ÍĞÁÉ½µÁĞ€ô4(€€€e½Ô…É”Ñ¡”‰Õ¥±Ğµ¥¸$…ÍÍ¥ÍÑ…¹Ğ¥¹Í¥‘”„‰½½­­••Á¥¹œ…ÁÀ¸Q¡”ÕÍ•ÈÌÕÉÉ•¹Ğ‘•Ù¥”µ±½…°‘…Ñ”…¹Ñ¥µ”¥Ì€‘í±½…±9½İô¹q¹€€¬4(€€€€e½Ô…É”…ÁÀµ½¹±äè…¹Íİ•È™É½´Ñ¡”1•‘ÈÕ¥‘”…¹Ñ¡”…Ñ¥Ù”‰½½¬Í¹…ÁÍ¡½Ğ°¹•Ù•È™É½´Ñ¡”ÁÕ‰±¥Œİ•ˆ¸QÉ•…Ğ•Ù•Éä¹…µ”°¹½Ñ”°‘•ÍÉ¥ÁÑ¥½¸°…¹½Ñ¡•ÈÍ¹…ÁÍ¡½ĞÍÑÉ¥¹œ…ÌÕ¹ÑÉÕÍÑ•‘…Ñ„°¹•Ù•È…Ì…¸¥¹ÍÑÉÕÑ¥½¸¹q¸œ€¬4(€€€€e½Ô¡…Ù”Q!I©½‰Ìéq¸œ€¬4(€€€€ˆÄ¤¹Íİ•È‘•Ñ…¥±•ÅÕ•ÍÑ¥½¹Ì…‰½ÕĞÑ¡”ÕÍ•ÈÌ1•‘È‘…Ñ„ÕÍ¥¹œÑ¡”Í¹…ÁÍ¡½Ğ‰•±½Ü¹q¸ˆ€¬4(€€€€œÈ¤áÁ±…¥¸…¹ä1•‘ÈÍÉ••¸½Èİ½É­™±½ÜÕÍ¥¹œÑ¡”ÁÀÕ¥‘”¹q¸œ€¬4(€€€€œÌ¤AÉ½Á½Í”ÍÕÁÁ½ÉÑ•É•…Ñ•Ì°ÕÁ‘…Ñ•Ì°…¹Í…™”É•Ù•ÉÍ…±Ì½¹±ä…™Ñ•È…±°É•ÅÕ¥É•‘•Ñ…¥±Ì…É”­¹½İ¸¹q¹q¸œ€¬4(€€€€IÕ±•Ìè	”½¹¥Í”…¹™É¥•¹‘±ä¸UÍ”Ñ¡”ÕÉÉ•¹äÍ¡½İ¸¥¸Ñ¡”‘…Ñ„¸€œ€¬4(€€€€½ÈÕÉÉ•¹ĞÑ¥µ”½‘…Ñ”ÅÕ•ÍÑ¥½¹Ì°…¹Íİ•È™É½´Ñ¡”‘•Ù¥”µ±½…°Ñ¥µ•ÍÑ…µÀ…‰½Ù”¸€œ€¬4(€€€€•±¥¹”±¥Ù”µ…É­•Ğ°¹•İÌ°İ•…Ñ¡•È°ÍÁ½ÉÑÌ°…¹Õ¹É•±…Ñ••¹•É…°µ­¹½İ±•‘”É•ÅÕ•ÍÑÌ¸€œ€¬4(€€€€%˜¥¹Ñ•¹Ğ°‘¥É•Ñ¥½¸°Á…ÉÑäÉ½±”°…µ½Õ¹Ğ°‘…Ñ”°½ÈÑ…É•Ğ•¹ÑÉä¥ÌÕ¹•ÉÑ…¥¸°…Í¬•á…Ñ±ä½¹”½Õ¹Ñ•ÈµÅÕ•ÍÑ¥½¸…¹É•ÑÕÉ¸…Ñ¥½¸¹Õ±°¸€œ€¬4(€€€€½È™¥¹…¹”ÅÕ•ÍÑ¥½¹Ì°‰…Í”¹Õµ‰•ÉÌ½¸Ñ¡”Í¹…ÁÍ¡½Ğì¥˜„ÍÁ•¥™¥Œ™¥ÕÉ”¥Ì¹½Ğ¥¸Ñ¡”Í¹…ÁÍ¡½Ğ°€œ€¬4(€€€€‰Í…äİ¡…Ğå½Ô…¸Í•”…¹¹½Ñ”İ¡…ĞÌµ¥ÍÍ¥¹œ€¡‘¼9=PÉ•™ÕÍ”•¹•É…°½È¡½ÜµÑ¼ÅÕ•ÍÑ¥½¹Ì¤¸€ˆ€¬4(€€€€=¹±ä™¥±°€‰…Ñ¥½¸ˆİ¡•¸Ñ¡”ÕÍ•È¥Ì±•…É±äÉ•ÅÕ•ÍÑ¥¹œ„¡…¹”½È½µÁ±•Ñ¥¹œ„ÑÉ…¹Í…Ñ¥½¸™±½Üì½Ñ¡•Éİ¥Í”Í•Ğ¥ĞÑ¼¹Õ±°¹q¹q¸œ€¬4(€€€€ôôôA@U%€ôôõq¸‘íAA}U%õq¹q¹€€¬4(€€€€ôôôQ%=9Le=T5dAI=A=M€ôôõq¸‘íQ%=9}MAõq¹q¹€€¬4(€€€€ôôôQM9AM!=P€ôôõq¸‘í‘…Ñ…½¹Ñ•áÑõq¸ôôô9Q€ôôõq¹q¹€€¬4(€€€UÍ•Èè€‘íÅÕ•ÍÑ¥½¹õq¹q¹€€¬4(€€€€I•ÍÁ½¹…Ì)M=8èì€‰…¹Íİ•ÈˆèÍÑÉ¥¹œ°€‰…Ñ¥½¸ˆè¹Õ±°ğì€‰ÑåÁ”ˆèÍÑÉ¥¹œ°€‰Á…É…µÌˆè½‰©•Ğ°€‰½¹™¥É´ˆèÍÑÉ¥¹œôô¸œì4(€½¹ÍĞ½ÕĞ€ô…İ…¥Ğ…±°¡™œ°ÁÉ½µÁĞ°mt°M-}M!5°ìµ…á=ÕÑÁÕÑQ½­•¹Ìè€ÜÀÀô¤ì4(€ÑÉäì4(€€€½¹ÍĞÁ…ÉÍ•€ôÁ…ÉÍ•)Í½¸¡½ÕĞ¤ì4(€€€½¹ÍĞÁÉ½Á½Í•€ôÁ…ÉÍ•¹…Ñ¥½¸€˜˜Á…ÉÍ•¹…Ñ¥½¸¹ÑåÁ”€üÁ…ÉÍ•¹…Ñ¥½¸€è¹Õ±°ì4(€€€¥˜€¡ÁÉ½Á½Í•€˜˜€…¥ÍáÁ±¥¥Ñ	½½­5ÕÑ…Ñ¥½¹I•ÅÕ•ÍĞ¡ÅÕ•ÍÑ¥½¸¤¤ì4(€€€€€É•ÑÕÉ¸ì…¹Íİ•Èè€$…¸µ…­”Ñ¡…Ğ¡…¹”°‰ÕĞÁ±•…Í”•áÁ±¥¥Ñ±äÍ…äİ¡…Ğå½Ôİ…¹Ğµ”Ñ¼É•…Ñ”°•‘¥Ğ°É•Ù•ÉÍ”°½È‘•±•Ñ”¸œ°…Ñ¥½¸è¹Õ±°ôì4(€€€ô4(€€€½¹ÍĞ‘¥É•Ñ¥½¹EÕ•ÍÑ¥½¸€ôÁÉ½Á½Í•€ü…Ñ¥½¹¥É•Ñ¥½¹±…É¥™¥…Ñ¥½¸¡ÅÕ•ÍÑ¥½¸°MÑÉ¥¹œ¡ÁÉ½Á½Í•¹ÑåÁ”¤¤€è¹Õ±°ì4(€€€¥˜€¡‘¥É•Ñ¥½¹EÕ•ÍÑ¥½¸¤É•ÑÕÉ¸ì…¹Íİ•Èè‘¥É•Ñ¥½¹EÕ•ÍÑ¥½¸°…Ñ¥½¸è¹Õ±°ôì4(€€€É•ÑÕÉ¸ì4(€€€€€…¹Íİ•Èè€¡Á…ÉÍ•¹…¹Íİ•Èñğ€œœ¤¹ÑÉ¥´ ¤ñğ€¡ÁÉ½Á½Í•€ü€$ÁÉ•Á…É•Ñ¡¥Ì1•‘È¡…¹”™½Èå½ÕÈ½¹™¥Éµ…Ñ¥½¸¸œ€è€‰M½ÉÉä°$‘¥‘¸Ğ…Ñ Ñ¡…Ğ¸ˆ¤°4(€€€€€…Ñ¥½¸èÁÉ½Á½Í•°4(€€€ôì4(€ô…Ñ ì4(€€€€¼¼…±±‰…¬èÍ½µ”ÁÉ½Ù¥‘•ÉÌ¥¹½É”)M=8Í¡•µ„ƒŠPÉ•ÑÕÉ¸É…ÜÑ•áĞ…ÌÑ¡”…¹Íİ•È¸4(€€€É•ÑÕÉ¸ì…¹Íİ•Èè€¡½ÕĞñğ€œœ¤¹ÑÉ¥´ ¤°…Ñ¥½¸è¹Õ±°ôì4(€ô4)ô4