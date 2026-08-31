/**
 * Multi-provider AI router (no backend).
 * Three dialects: Google Gemini (native), OpenAI-compatible, Anthropic.
 * OpenRouter / Groq / local servers use the OpenAI-compatible row + a base URL.
 * Official Claude or an Anthropic-compatible proxy use the Anthropic row + base URL.
 */

import { localTodayIso } from '../utils/dateValidation';

export type ProviderId = 'gemini' | 'openai' | 'anthropic';

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
  return trimmed;
}

function resolveBaseUrl(cfg: AIConfig): string {
  if (cfg.baseUrl && cfg.baseUrl.trim()) return validateAIBaseUrl(cfg.baseUrl);
  return getProviderMeta(cfg.provider).defaultBaseUrl.replace(/\/+$/, '');
}

/**
 * Core text/multimodal call. Returns raw text (possibly JSON string).
 * parts: array of { inlineData: { mimeType, data(base64) } } for images/audio.
 */
export type AICallOptions = { maxOutputTokens?: number; timeoutMs?: number; retryTransient?: boolean };

async function call(
  cfg: AIConfig,
  prompt: string,
  parts: { inlineData: { mimeType: string; data: string } }[] = [],
  jsonSchema?: any,
  options?: AICallOptions,
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
const aiRequestId = () => `ledgr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
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
  requestId = aiRequestId(),
  options?: AICallOptions,
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
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey, 'x-request-id': requestId },
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
  options?: AICallOptions,
): Promise<string> {
  const requestId = aiRequestId();
  try {
    return await callGeminiModel(cfg, cfg.model, prompt, parts, schema, requestId, options);
  } catch (error: any) {
    // If a model-not-found surfaces for the (deprecated) DEFAULT model, retry once
    // with the current alias before letting the actionable error from (d) bubble up.
    const msg = error?.message || '';
    const looksLikeModelIssue = isModelNotFoundError(0, msg) || /update the model name/i.test(msg);
    if (looksLikeModelIssue && cfg.model === DEPRECATED_DEFAULT_GEMINI_MODEL) {
      return callGeminiModel({ ...cfg, model: DEFAULT_GEMINI_MODEL }, DEFAULT_GEMINI_MODEL, prompt, parts, schema, requestId, options);
    }
    throw error;
  }
}
// ---------------- OpenAI-compatible (OpenAI, OpenRouter, custom) ----------------
async function callOpenAI(cfg: AIConfig, prompt: string, parts: any[], schema?: any, options?: AICallOptions): Promise<string> {
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

async function transcribeOpenAI(cfg: AIConfig, audioBase64: string, mimeType: string): Promise<{ transcript?: string; text?: string }> {
  const voice = resolveTranscriptionConfig(cfg);
  const extension = mimeType.includes('webm') ? 'webm' : mimeType.includes('wav') ? 'wav' : 'm4a';
  const binary = globalThis.atob(audioBase64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const audioBlob = new Blob([bytes], { type: mimeType });
  const form = new FormData();
  form.append('file', audioBlob, `ledgr-voice.${extension}`);
  form.append('model', voice.model);
  const res = await fetchAI(`${voice.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${voice.apiKey}` },
    body: form,
  });
 ë6¶‰žËkºwµçYÉ½´„ÕÍÑ½µ•ÈÌ•‰Ñ½ÈÍÉ••¸°¥Ù”„Á½ÍÐµÍ…±”‘¥Í½Õ¹Ð½ÈÉ•½É„É•ÑÕÉ¸€¡É•‘¥Ð¹½Ñ”°±½Ý•ÉÌÑ¡•¥È‰…±…¹”¤½È…‘…¸•áÑÉ„¡…É”€¡‘•‰¥Ð¹½Ñ”¤¸9¼…Í µ½Ù•Ì¹q¸ˆ€¬(€€ˆ´•±¥Ù•Éä9½Ñ•Ì½¡…±±…¹ÌèÉ•½É½½‘Ì¡…¹‘•Ñ¼„ÕÍÑ½µ•È€¡ÅÕ…¹Ñ¥Ñä½¹±ä°¹¼ÁÉ¥•Ì¤ìÍ¡…É”…ÌA¸9¼±•‘•È•™™•Ð¹q¸ˆ€¬(€€ˆ´•‰Ñ½ÉÌèÝ¡¼½Ý•Ìå½Ôµ½¹•äìÉ•½ÉÁ…åµ•¹ÑÌìÍ•¹]¡…ÑÍÁÀÉ•µ¥¹‘•ÉÌ¹q¸ˆ€¬(€€ˆ´É•‘¥Ñ½ÉÌèÍÕÁÁ±¥•ÉÌå½Ô½Ý”ìÉÕ¹¹¥¹œ‰…±…¹•Ìì]¡…ÑÍÁÀÉ•µ¥¹‘•ÉÌ¹q¸ˆ€¬(€€ˆ´áÁ•¹Í•Ìè‘…äµÑ¼µ‘…ä½ÍÑÌ‰ä…Ñ•½Éä¹q¸ˆ€¬(€€ˆ´%¹Ù•¹Ñ½ÉäèÍÑ½¬½Õ¹ÑÌ¸AÉ½™¥ÐÕÍ•ÌÁ•É¥½‘¥Œ¥¹Ù•¹Ñ½Éäè=L€ô½Á•¹¥¹œÍÑ½¬€¬ÁÕÉ¡…Í•Ì€´±½Í¥¹œÍÑ½¬¹q¸ˆ€¬(€€ˆ´I•Á½ÉÑÌèAÉ½™¥Ð€˜1½ÍÌ°	…±…¹”M¡••Ð°QÉ¥…°	…±…¹”°A…ÉÑ¹•È…Á¥Ñ…°°É…Ý¥¹Ì°Ý¥Ñ ‘…Ñ”µÉ…¹”™¥±Ñ•ÉÌ…¹¡…ÉÑÌ¹q¸ˆ€¬(€€ˆ´A•ÉÍ½¹„Ý½É­ÍÁ…•Ìè1•‘È…‘…ÁÑÌ±…‰•±Ì°•áÁ•¹Í”…Ñ•½É¥•Ì°…½Õ¹ÐÙ½…‰Õ±…Éä°É•Á½ÉÑÌ°µ•ÑÉ¥Ì°…¹Í¡½ÉÑÕÑÌ™½È½µµ•É”°M……L°•½µµ•É”°…•¹¥•Ì°ÁÉ…Ñ¥•Ì°É•…Ñ½ÉÌ°µ…¹Õ™…ÑÕÉ¥¹œ°ÑÉ…‘”°É•ÍÑ…ÕÉ…¹ÑÌ°¡•…±Ñ¡…É”°•‘Õ…Ñ¥½¸°±•…°°¹½¹ÁÉ½™¥Ð°É•…°•ÍÑ…Ñ”°½¹ÍÑÉÕÑ¥½¸°…É¥Õ±ÑÕÉ”°…ÕÑ½µ½Ñ¥Ù”°¡½ÍÁ¥Ñ…±¥Ñä°É•Ñ…¥°°…¹Í•ÉÙ¥”‰ÕÍ¥¹•ÍÍ•Ì¹q¸ˆ€¬(€€ˆ´%¹‘ÕÍÑÉäµ½‘Õ±•Ìè5…É­•ÑÁ±…”½É‘•ÉÌ…¹Í•ÑÑ±•µ•¹ÑÌìÁÉ½©•ÑÌ…¹Ñ¥µ”½½ÍÑÌìÉ•…Ñ½È½¹ÑÉ…ÑÌ…¹Á…å½ÕÑÌì	=5Ì°ÁÉ½‘ÕÑ¥½¸°]%@°…¹™¥¹¥Í¡•½½‘ÌìÑÉ…‘”Í¡¥Áµ•¹ÑÌ°±…¹‘•½ÍÑÌ°…¹`É•µ•…ÍÕÉ•µ•¹Ð¹q¸ˆ€¬(€€ˆ´…ä	½½¬è•Ù•ÉäÑÉ…¹Í…Ñ¥½¸¥¸‘…Ñ”½É‘•È¹q¸ˆ€¬(€€ˆ´I•½¹¥±”èÁ¡½Ñ½É…Á ½ÈÕÁ±½…„ÍÕÁÁ±¥•ÈÍÑ…Ñ•µ•¹Ð½Aì$½µÁ…É•Ì¥ÐÑ¼å½ÕÈ±•‘•È¹q¸ˆ€¬(€€ˆ´Y½¥”½…µ•É„•¹ÑÉäèÍÁ•…¬…¸•¹ÑÉä½ÈÍ¹…À„É••¥ÁÐì$™¥±±ÌÑ¡”™½É´€¡å½Ô½¹™¥É´‰•™½É”Í…Ù¥¹œ¤¹q¸ˆ€¬(€€ˆ´M•ÑÑ¥¹Ìè‰ÕÍ¥¹•ÍÌÁÉ½™¥±”°ÕÉÉ•¹ä€ ÄÔ½ÁÑ¥½¹Ì¤°Ñ…à±…‰•°€˜É…Ñ”°Á…ÉÑ¹•È¹…µ•Ì°½Á•¹¥¹œ…Á¥Ñ…°°€ˆ€¬(€€‰‰…­ÕÀ½É•ÍÑ½É”°]¡…ÑÍÁÀÍ¡…É”°…¹Ñ¡”$ÁÉ½Ù¥‘•È€¬A$­•ä¹q¸ˆ€¬(€€ˆ´Í¬$€¡Ñ¡¥ÌÍÉ••¸¤è…Í¬ÅÕ•ÍÑ¥½¹Ì…‰½ÕÐå½ÕÈ‰½½­Ì°•¹•É…°ÅÕ•ÍÑ¥½¹Ì°¡½ÜÑ¼ÕÍ”Ñ¡”…ÁÀ°…¹É•ÅÕ•ÍÐ¡…¹•Ì¸ˆì((¼¼Ñ¥½¹ÌÑ¡”$¥Ì…±±½Ý•Ñ¼AI=A=M¸Q¡”…ÁÀ•á•ÕÑ•ÌÑ¡•´½¹±ä…™Ñ•ÈÑ¡”ÕÍ•È(¼¼½¹™¥ÉµÌ¸Q¡¥Ì±¥ÍÐ¥ÌaQ1dÑ¡”•¥¡Ð…Ñ¥½¸ÑåÁ•Ì¥¸M-}M!5ƒŠP•Ù•Éä½¹”(¼¼Q¡”µ½‘•°µ…äÁÉ½Á½Í”½¹±äÑ¡”•áÁ±¥¥Ñ±ä±¥ÍÑ•…ÁÀµÕÑ…Ñ¥½¹Ì¸Y…±¥‘…Ñ¥½¸…¹(¼¼…¸¥¸µ¡…Ð½¹™¥Éµ…Ñ¥½¸…Ñ”É•µ…¥¸…ÕÑ¡½É¥Ñ…Ñ¥Ù”‰•™½É”…¹äÝÉ¥Ñ”•á•ÕÑ•Ì¸)½¹ÍÐQ%=9}MA€ô(€€‰I•ÑÕÉ¸…¸…Ñ¥½¸½¹±äÝ¡•¸Ñ¡”ÕÍ•È±•…É±ä…Í­Ì1•‘ÈÑ¼É•…Ñ”°ÕÁ‘…Ñ”°É•Ù•ÉÍ”°½È‘•±•Ñ”…ÁÀ‘…Ñ„¸€ˆ€¬(€€‰%˜…¹äÉ•ÅÕ¥É•‘•Ñ…¥°¥Ìµ¥ÍÍ¥¹œ½È…µ‰¥Õ½ÕÌ°Í•Ð…Ñ¥½¸Ñ¼¹Õ±°…¹…Í¬½¹”½¹¥Í”½Õ¹Ñ•ÈµÅÕ•ÍÑ¥½¸¥¸…¹ÍÝ•È¸€ˆ€¬(€€‰9•Ù•È±…¥´Ñ¡…Ð…¸•¹ÑÉä¥ÌÁÉ•Á…É•Õ¹±•ÍÌ„½µÁ±•Ñ”…Ñ¥½¸½‰©•Ð¥ÌÉ•ÑÕÉ¹•¸€ˆ€¬(€€‰UÍ”•á…ÐÁ…ÉÑä…¹•¹ÑÉä%Ì™É½´Ñ¡”‘…Ñ„Í¹…ÁÍ¡½ÐÝ¡•¹•Ù•ÈÑ¡•ä…É”…Ù…¥±…‰±”¸9•Ù•È¥¹Ù•¹Ð…¸%¹q¸ˆ€¬(€€‰IQQ%=9Léq¸ˆ€¬(€€ˆ´…‘‘}•áÁ•¹Í”èì…Ñ•½Éä°…µ½Õ¹Ð°‘…Ñ”ü°¹½Ñ•Ìüõq¸ˆ€¬(€€ˆ´…‘‘}Í…±”èì…µ½Õ¹Ð°‘…Ñ”ü°Á…åµ•¹ÑQåÁ”ü€ …Í ðÉ•‘¥Ðœ¤°¹½Ñ•Ìüõq¸ˆ€¬(€€ˆ´…‘‘}‰¥±°èìÍÕÁÁ±¥•É9…µ”°…µ½Õ¹Ð°‘…Ñ”ü°Á…åµ•¹ÑQåÁ”ü€ …Í ðÉ•‘¥Ðœ¤°¹½Ñ•Ìüõq¸ˆ€¬(€€ˆ´É•…Ñ•}ÍÕÁÁ±¥•É}Á…åµ•¹ÐèìÍÕÁÁ±¥•É9…µ”°…µ½Õ¹Ð°‘…Ñ”ü°µ•Ñ¡½ü€ …Í ð…Éð‰…¹¬ðÕÁ¤œ¤°¹½Ñ•Ìüõq¸ˆ€¬(€€ˆ´…‘‘}‘•‰Ñ½Èèì¹…µ”°Á¡½¹”ü°¹½Ñ•Ìüõq¸ˆ€¬(€€ˆ´…‘‘}ÍÕÁÁ±¥•Èèì¹…µ”°Á¡½¹”ü°¹½Ñ•Ìüõq¸ˆ€¬(€€ˆ´…‘‘}‘•‰Ñ½É}Á…åµ•¹Ðèì¹…µ”°…µ½Õ¹Ð°‘…Ñ”ü°µ•Ñ¡½üô€¡µ½¹•äI%Y™É½´„ÕÍÑ½µ•È¥q¸ˆ€¬(€€ˆ´É•…Ñ•}¥¹Ù½¥”èì±¥•¹Ñ9…µ”°…µ½Õ¹Ð°‘…Ñ”ü°¹½Ñ•Ìüõq¸ˆ€¬(€€ˆ´É•…Ñ•}É••¥ÁÐèì…µ½Õ¹Ð°µ½‘”€ …Í¡}Í…±”ð……¥¹ÍÑ}¥¹Ù½¥”ð…‘Ù…¹”œ¤°ÕÍÑ½µ•É9…µ”ü°¥¹Ù½¥•%ü€¡É•ÅÕ¥É•™½È……¥¹ÍÑ}¥¹Ù½¥”¤°‘…Ñ”ü°µ•Ñ¡½ü€ …Í ð…Éð‰…¹¬ðÕÁ¤œ¤°¹½Ñ•Ìüõq¸ˆ€¬(€€ˆ´É•…Ñ•}ÅÕ½Ñ”èì±¥•¹Ñ9…µ”°…µ½Õ¹Ð°‘…Ñ”ü°¹½Ñ•Ìüõq¸ˆ€¬(€€ˆ´É•…Ñ•}‘É…Ý¥¹œèìÁ…ÉÑ¹•É9…µ”°…µ½Õ¹Ð°‘…Ñ”ü°¹½Ñ•Ìüõq¸ˆ€¬(€€ˆ´…‘‘}…Á¥Ñ…°èìÁ…ÉÑ¹•É9…µ”°…µ½Õ¹Ð°‘…Ñ”ü°¹½Ñ•Ìüõq¸ˆ€¬(€€ˆ´É•½É‘}¥¹Ù•¹Ñ½Éäèì…µ½Õ¹Ð°‘…Ñ”ü°¹½Ñ•Ìüõq¸ˆ€¬(€€‰%9UMQIdQ%=9L€¡…±Ý…åÌÁÉ½Á½Í”½¹±ä„ÍÑÉÕÑÕÉ•‘É…™Ðì1•‘ÈÙ…±¥‘…Ñ•Ì%Ì°‘…Ñ•Ì°…µ½Õ¹ÑÌ°…½Õ¹ÑÌ°…¹©½ÕÉ¹…°‰…±…¹”‰•™½É”…ÁÁ±å¥¹œ¤éq¸ˆ€¬(€€ˆ´É•…Ñ•}µ…É­•ÑÁ±…•}½É‘•ÈèìÁ±…Ñ™½É´°•áÑ•É¹…±=É‘•É%°É½ÍÌ°Ñ…àü°µ…É­•ÑÁ±…••”ü°Í¡¥ÁÁ¥¹•”ü°É•™Õ¹ü°ÉÑ½•”ü°‘…Ñ”ü°ÕÉÉ•¹äü°•á¡…¹•I…Ñ”ü°Í•ÑÑ±•µ•¹Ñ%ü°¹½Ñ•Ìüõq¸ˆ€¬(€€ˆ´É•½É‘}µ…É­•ÑÁ±…•}É•™Õ¹èì½É‘•É%°…µ½Õ¹Ð°‘…Ñ”ü°¹½Ñ•Ìüõq¸ˆ€¬(€€ˆ´É•½É‘}µ…É­•ÑÁ±…•}ÉÑ¼èì½É‘•É%°™•”°‘…Ñ”ü°¹½Ñ•Ìüõq¸ˆ€¬(€€ˆ´É•…Ñ•}µ…É­•ÑÁ±…•}Í•ÑÑ±•µ•¹ÐèìÁ±…Ñ™½É´°Í•ÑÑ±•µ•¹Ñ%°Á…å½ÕÐ°‘…Ñ”ü°ÕÉÉ•¹äü°•á¡…¹•I…Ñ”ü°¹½Ñ•Ìüõq¸ˆ€¬(€€ˆ´É•…Ñ•}ÁÉ½©•Ðèì¹…µ”°Á…ÉÑå%ü°‰Õ‘•Ðü°ÕÉÉ•¹äüõq¸ˆ€¬(€€ˆ´…‘‘}ÁÉ½©•Ñ}Ñ¥µ”èìÁÉ½©•Ñ%°¡½ÕÉÌ°É…Ñ”°‘…Ñ”ü°‘•ÍÉ¥ÁÑ¥½¸üõq¸ˆ€¬(€€ˆ´É•½É‘}ÁÉ½©•Ñ}½ÍÐèìÁÉ½©•Ñ%°…µ½Õ¹Ð°‘…Ñ”ü°…½Õ¹Ñ½‘”ü°µ•Ñ¡½ü€ …Í ð‰…¹¬œ¤°‘•ÍÉ¥ÁÑ¥½¸üõq¸ˆ€¬(€€ˆ´É•…Ñ•}É•…Ñ½É}½¹ÑÉ…Ðèì‰É…¹°…µÁ…¥¸°…É••‘µ½Õ¹Ð°Á…ÉÑå%ü°ÕÉÉ•¹äü°‘Õ•…Ñ”üõq¸ˆ€¬(€€ˆ´É•½É‘}É•…Ñ½É}Á…å½ÕÐèì½¹ÑÉ…Ñ%°…µ½Õ¹Ð°‘…Ñ”ü°ÕÉÉ•¹äü°µ•Ñ¡½ü€ …Í ð‰…¹¬œ¤°¹½Ñ•Ìüõq¸ˆ€¬(€€ˆ´É•…Ñ•}‰½´èìÁÉ½‘ÕÑ%°¹…µ”°Ù•ÉÍ¥½¸üõq¸ˆ€¬(€€ˆ´…‘‘}‰½µ}±¥¹”èì‰½µ%°½µÁ½¹•¹ÑAÉ½‘ÕÑ%°ÅÕ…¹Ñ¥Ñä°Õ¹¥Ñ½ÍÐüõq¸ˆ€¬(€€ˆ´É•…Ñ•}ÁÉ½‘ÕÑ¥½¹}½É‘•Èèì‰½µ%°ÅÕ…¹Ñ¥Ñä°‘…Ñ”ü°ÍÑ…ÑÕÌü€ ½µÁ±•Ñ•ð‘É…™Ðœ¤°¹½Ñ•Ìüõq¸ˆ€¬(€€ˆ´É•…Ñ•}ÑÉ…‘•}Í¡¥Áµ•¹ÐèìÉ•™•É•¹”°‘¥É•Ñ¥½¸€ ¥µÁ½ÉÐð•áÁ½ÉÐœ¤°‘…Ñ”ü°ÍÕÁÁ±¥•É%ü°ÕÍÑ½µ•É%ü°½½‘ÍY…±Õ”ü°ÕÉÉ•¹äü°•á¡…¹•I…Ñ”ü°¹½Ñ•Ìüõq¸ˆ€¬(€€ˆ´…‘‘}ÑÉ…‘•}±…¹‘•‘}½ÍÐèìÍ¡¥Áµ•¹Ñ%°­¥¹°…µ½Õ¹Ð°‘…Ñ”ü°ÕÉÉ•¹äü°•á¡…¹•I…Ñ”ü°…Á¥Ñ…±¥é•ü°µ•Ñ¡½ü€ …Í ð‰…¹¬ð…Àœ¤°¹½Ñ•Ìüõq¸ˆ€¬(€€ˆ´É•½É‘}™á}É•µ•…ÍÕÉ•µ•¹Ðèì…½Õ¹Ñ½‘”ü°…µ½Õ¹Ð°…¥¹1½ÍÌ€ …¥¸ð±½ÍÌœ¤°‘…Ñ”ü°ÕÉÉ•¹äü°•á¡…¹•I…Ñ”ü°É•™•É•¹”ü°¹½Ñ•Ìüõq¸ˆ€¬(€€‰Q¡”ÕÍ•ÈµÕÍÐ•áÁ±¥¥Ñ±ä…Í¬Ñ¼É•½É½ÈÉ•…Ñ”„‰ÕÍ¥¹•ÍÌ…Ñ¥½¸ì‘¼¹½ÐÉ•…Ñ”‘½µ…¥¸É•½É‘Ì™É½´„ÅÕ•ÍÑ¥½¸…‰½ÕÐÝ¡…Ð„™•…ÑÕÉ”µ•…¹Ì¹q¸ˆ€¬(€€‰!9Q%=9L€¡Ñ¡”•á…ÐÑ…É•ÐµÕÍÐ•á¥ÍÐ¥¸É••¹Ñ¹ÑÉ¥•Ì½Á…ÉÑ¥•Ì¤éq¸ˆ€¬(€€ˆ´ÕÁ‘…Ñ•}•¹ÑÉäèì•¹Ñ¥Ñä°¥°µ•µ‰•É%ü°¡…¹•Ìõq¸ˆ€¬(€€ˆ´‘•±•Ñ•}•¹ÑÉäèì•¹Ñ¥Ñä°¥°µ•µ‰•É%üõq¸ˆ€¬(€€‰MÕÁÁ½ÉÑ••¹Ñ¥Ñ¥•Ìè•áÁ•¹Í”°Í…±”°‰¥±°°ÍÕÁÁ±¥•É}Á…åµ•¹Ð°É••¥ÁÐ°¥¹Ù½¥”°ÅÕ½Ñ”°ÕÍÑ½µ•È°ÍÕÁÁ±¥•È°‘•±¥Ù•Éå}¹½Ñ”°¹½Ñ”°¥¹Ù•¹Ñ½Éå}½Õ¹Ð°…Á¥Ñ…°°‘É…Ý¥¹œ°…Í¡}•¹ÑÉä¸€ˆ€¬(€€‰%¹Ù•¹Ñ½Éä½Õ¹ÑÌ…¸‰”‘•±•Ñ•‰ÕÐµÕÍÐ‰”½ÉÉ•Ñ•‰äÉ•Ù•ÉÍ¥¹œ…¹É•½É‘¥¹œ„¹•Ü½Õ¹Ðì‘¼¹½ÐÁÉ½Á½Í”ÕÁ‘…Ñ•}•¹ÑÉä™½È¥¹Ù•¹Ñ½Éå}½Õ¹Ð¸ÕÍÑ½µ•È…¹MÕÁÁ±¥•ÈÉ•½É‘Ìµ…ä‰”ÕÁ‘…Ñ•‰ÕÐµÕÍÐ¹½Ð‰”‘•±•Ñ•¡•É”¸€ˆ€¬(€€‰½È…Á¥Ñ…°…Ñ¥½¹Ì¥¹±Õ‘”µ•µ‰•É%™É½´…Á¥Ñ…±½Õ¹ÑÌ¸•±•Ñ¥¹œ„Á½ÍÑ•…½Õ¹Ñ¥¹œ•¹ÑÉäµ•…¹Ì„Í…™”É•Ù•ÉÍ…°°¹½Ð•É…Í¥¹œ…Õ‘¥Ð¡¥ÍÑ½Éä¸€ˆ€¬(€€‰½È€Á…¥`Ñ¼95œè%˜95¥Ì¥¸…Á¥Ñ…±½Õ¹ÑÌ½È„Á…ÉÑ¹•È°ÁÉ½Á½Í”É•…Ñ•}‘É…Ý¥¹œ¸%˜95¥Ì„­¹½Ý¸ÍÕÁÁ±¥•È°ÁÉ½Á½Í”É•…Ñ•}ÍÕÁÁ±¥•É}Á…åµ•¹Ð¸=Ñ¡•ÉÝ¥Í”…Í¬Ý¡•Ñ¡•È¥Ð¥Ì„ÍÕÁÁ±¥•ÈÁ…åµ•¹Ð°Á…ÉÑ¹•ÈÝ¥Ñ¡‘É…Ý…°°•áÁ•¹Í”°½ÈÍ½µ•Ñ¡¥¹œ•±Í”¸€ˆ€¬(€€‰½È€É••¥Ù•`™É½´95œè%˜95¥Ì¥¸…Á¥Ñ…±½Õ¹ÑÌ½È„Á…ÉÑ¹•È°ÁÉ½Á½Í”…‘‘}…Á¥Ñ…°¸%˜95¥Ì„­¹½Ý¸ÕÍÑ½µ•È°ÁÉ½Á½Í”É•…Ñ•}É••¥ÁÐ¸=Ñ¡•ÉÝ¥Í”…Í¬Ý¡•Ñ¡•È¥Ð¥Ì„ÕÍÑ½µ•ÈÉ••¥ÁÐ°Á…ÉÑ¹•È…Á¥Ñ…°‘•Á½Í¥Ð°…Í Í…±”°½ÈÍ½µ•Ñ¡¥¹œ•±Í”¸€ˆ€¬(€€‰µ½Õ¹ÑÌè±Ý…åÌ½ÕÑÁÕÐ…µ½Õ¹Ñ€¥¸Á…É…µÌ…Ì„ÁÕÉ”Á½Í¥Ñ¥Ù”¹Õµ‰•È€¡”¹œ¸€ÄÀÀ°¹½Ð€œÄÀÀœ¤¸€ˆ€¬(€€‰…Ñ•Ì…É”eeedµ54µì‘•™…Õ±ÐÑ¼Ñ¡”‘•Ù¥”µ±½…°‘…Ñ”¥˜½µ¥ÑÑ•¸9•Ù•È¥¹Ù•¹Ð…µ½Õ¹ÑÌ°Á…ÉÑ¥•Ì°É½±•Ì°•¹ÑÉä%Ì°½Èµ¥ÍÍ¥¹œ¥¹Ù½¥”±¥¹•Ì¸ˆì()•áÁ½ÉÐÑåÁ”Í­!¥ÍÑ½Éå5•ÍÍ…”€ôìÉ½±”è€ÕÍ•Èœð€…ÍÍ¥ÍÑ…¹ÐœìÑ•áÐèÍÑÉ¥¹œôì()•áÁ½ÉÐ™Õ¹Ñ¥½¸¥Í9•ÕÑÉ…±QÉ…¹ÍÉ¥ÁÐ¡ÅÕ•ÍÑ¥½¸èÍÑÉ¥¹œ¤è‰½½±•…¸ì(€½¹ÍÐ¹½Éµ…±¥é•€ôÅÕ•ÍÑ¥½¸¹ÑÉ¥´ ¤¹Ñ½1½Ý•É…Í” ¤¹É•Á±…” ½l¸„ýt¬½œ°€œœ¤¹É•Á±…” ½qÌ¬½œ°€œ€œ¤ì(€É•ÑÕÉ¸€½x üéÑ•ÍÐ üèÑ•ÍÐ¤©ñÑ•ÍÑ¥¹œ üè½¹”ÑÝ¼¤ýñ¡•±±¼ üèÑ¡•É”¤ýñ…¸å½Ô¡•…Èµ”¤¼¹Ñ•ÍÐ¡¹½Éµ…±¥é•¤ì)ô()•áÁ½ÉÐ™Õ¹Ñ¥½¸¥ÍáÁ±¥¥Ñ	½½­5ÕÑ…Ñ¥½¹I•ÅÕ•ÍÐ¡ÅÕ•ÍÑ¥½¸èÍÑÉ¥¹œ°¡¥ÍÑ½ÉäüèÍ­!¥ÍÑ½Éå5•ÍÍ…•mt¤è‰½½±•…¸ì(€½¹ÍÐÄ€ôÅÕ•ÍÑ¥½¸¹Ñ½1½Ý•É…Í” ¤ì(€½¹ÍÐ¡…¹•Y•Éˆ€ô€½qˆ¡…‘‘ñÉ•½É‘ñÉ•…Ñ•ñ•¹Ñ•ÉñÍ…Ù•ñÁ½ÍÑñ±½ñÉ•¥ÍÑ•Éñ•‘¥ÑñÕÁ‘…Ñ•ñ¡…¹•ñ½ÉÉ•Ññ‘•±•Ñ•ñÉ•µ½Ù•ñÉ•Ù•ÉÍ•ñÙ½¥‘ñ…¹•°¥qˆ¼¹Ñ•ÍÐ¡Ä¤ì(€½¹ÍÐ…½Õ¹Ñ¥¹=‰©•Ð€ô€½qˆ¡•áÁ•¹Í•ñÍ…±•ñ‰¥±±ñÁÕÉ¡…Í•ñÕÍÑ½µ•Éñ‘•‰Ñ½ÉñÍÕÁÁ±¥•ÉñÉ•‘¥Ñ½ÉñÁ…åµ•¹Ññ¥¹Ù½¥•ñÉ••¥ÁÑñÅÕ½Ñ•ñÑÉ…¹Í…Ñ¥½¹ñ•¹ÑÉåñ…Á¥Ñ…±ñ‘É…Ý¥¹ñ‘É…Ý¥¹ÍñÝ¥Ñ¡‘É…Ý…±ñ¥¹Ù•¹Ñ½ÉåñÍÑ½­ñ¹½Ñ•ñ½É‘•ÉñÍ•ÑÑ±•µ•¹Ññµ…É­•ÑÁ±…•ñÁÉ½©•ÑñÑ¥µ•ñÉ•…Ñ½ÉñÁ…å½ÕÑñ½¹ÑÉ…Ññ‰½µñÁÉ½‘ÕÑ¥½¹ñÍ¡¥Áµ•¹Ññ±…¹‘•½ÍÑñ™áñ™½É•¥¸•á¡…¹”¥qˆ¼¹Ñ•ÍÐ¡Ä¤ì(€½¹ÍÐÍÑ…Ñ•‘5½¹•å5½Ù•µ•¹Ð€ô€½qˆ¡Á…¥‘ñÉ••¥Ù•‘ñÍ½±‘ñ‰½Õ¡ÑñÁÕÉ¡…Í•‘ñÍÁ•¹Ññ‘•Á½Í¥Ñ•‘ñÝ¥Ñ¡‘É•ÝñÝ¥Ñ¡‘É…Ü¥qˆ¼¹Ñ•ÍÐ¡Ä¤€˜˜€½q¼¹Ñ•ÍÐ¡Ä¤ì(€¥˜€ ¡¡…¹•Y•Éˆ€˜˜…½Õ¹Ñ¥¹=‰©•Ð¤ñðÍÑ…Ñ•‘5½¹•å5½Ù•µ•¹Ð¤É•ÑÕÉ¸ÑÉÕ”ì((€¥˜€¡ÉÉ…ä¹¥ÍÉÉ…ä¡¡¥ÍÑ½Éä¤€˜˜¡¥ÍÑ½Éä¹±•¹Ñ €ø€À¤ì(€€€½¹ÍÐÕÍ•É!¥ÍÑ½Éä€ô¡¥ÍÑ½Éä¹™¥±Ñ•È ¡ ¤€ôø ¹É½±”€ôôô€ÕÍ•Èœ¤¹µ…À ¡ ¤€ôø ¹Ñ•áÐ¹Ñ½1½Ý•É…Í” ¤¤¹©½¥¸ œ€œ¤ì(€€€¥˜€¡¥ÍáÁ±¥¥Ñ	½½­5ÕÑ…Ñ¥½¹I•ÅÕ•ÍÐ¡ÕÍ•É!¥ÍÑ½Éä¤¤ì(€€€€€½¹ÍÐ±…É¥™å¥¹Q•É´€ô€½qˆ¡Ý¥Ñ¡‘É…Ý…±ñ‘É…Ý¥¹ñ‘É…Ý¥¹Íñ…Á¥Ñ…±ñ•áÁ•¹Í•ñÍÕÁÁ±¥•ÉñÕÍÑ½µ•ÉñÍ…±•ñ‰¥±±ñ…Í¡ñ‰…¹­ñ…É‘ñÕÁ¥ñå•ÍñÁÉ½••‘ñ½¹™¥É´¥qˆ½¤¹Ñ•ÍÐ¡Ä¤ì(€€€€€¥˜€¡±…É¥™å¥¹Q•É´ñð…½Õ¹Ñ¥¹=‰©•Ð¤É•ÑÕÉ¸ÑÉÕ”ì(€€€ô(€ô(€É•ÑÕÉ¸™…±Í”ì)ô()•áÁ½ÉÐ™Õ¹Ñ¥½¸¥Í±•…É±åáÑ•É¹…±EÕ•ÍÑ¥½¸¡ÅÕ•ÍÑ¥½¸èÍÑÉ¥¹œ¤è‰½½±•…¸ì(€½¹ÍÐÄ€ôÅÕ•ÍÑ¥½¸¹Ñ½1½Ý•É…Í” ¤ì(€½¹ÍÐ±•‘É½¹Ñ•áÐ€ô€½qˆ¡µåñ½ÕÉñ±•‘Éñ‰½½­ñ‰½½­Íñ‰ÕÍ¥¹•ÍÍñ•áÁ•¹Í•ñÍ…±•ñ‰¥±±ñÁÕÉ¡…Í•ñÕÍÑ½µ•Éñ‘•‰Ñ½ÉñÍÕÁÁ±¥•ÉñÉ•‘¥Ñ½ÉñÁ…åµ•¹Ññ¥¹Ù½¥•ñÉ••¥ÁÑñÅÕ½Ñ•ñÑÉ…¹Í…Ñ¥½¹ñ•¹ÑÉåñ…Á¥Ñ…±ñ‘É…Ý¥¹ñ¥¹Ù•¹Ñ½ÉåñÍÑ½­ñÁÉ½™¥Ññ±½ÍÍñ…Í¡ñ‰…±…¹•ñÉ•Á½ÉÑñÑ…áñ½É‘•ÉñÍ•ÑÑ±•µ•¹Ññµ…É­•ÑÁ±…•ñÁÉ½©•ÑñÉ•…Ñ½ÉñÁ…å½ÕÑñ½¹ÑÉ…Ññ‰½µñÁÉ½‘ÕÑ¥½¹ñÍ¡¥Áµ•¹Ññ±…¹‘•½ÍÑñ™áñ™½É•¥¸•á¡…¹”¥qˆ¼¹Ñ•ÍÐ¡Ä¤ì(€½¹ÍÐ•áÑ•É¹…±Q½Á¥Œ€ô€½qˆ¡¹¥™ÑåñÍ•¹Í•áñÍÑ½¬ÁÉ¥•ñÍ¡…É”ÁÉ¥•ñµ…É­•ÐÁÉ¥•ñÉåÁÑ½ñ‰¥Ñ½¥¹ñÝ•…Ñ¡•Éñ¹•ÝÍñ¡•…‘±¥¹•ñÍÁ½ÉÑÌÍ½É•ñ•á¡…¹”É…Ñ•ñÕÉÉ•¹ÐÁÉ¥”¥qˆ¼¹Ñ•ÍÐ¡Ä¤ì(€É•ÑÕÉ¸•áÑ•É¹…±Q½Á¥Œ€˜˜€…±•‘É½¹Ñ•áÐì)ô()™Õ¹Ñ¥½¸…Ñ¥½¹¥É•Ñ¥½¹±…É¥™¥…Ñ¥½¸¡ÅÕ•ÍÑ¥½¸èÍÑÉ¥¹œ°…Ñ¥½¹QåÁ”èÍÑÉ¥¹œ¤èÍÑÉ¥¹œð¹Õ±°ì(€½¹ÍÐ™Õ±±Q•áÐ€ôÅÕ•ÍÑ¥½¸¹Ñ½1½Ý•É…Í” ¤ì(€¥˜€ ½q‰Á…¥‘q‰mqÍqMt©q‰Ñ½qˆ¼¹Ñ•ÍÐ¡™Õ±±Q•áÐ¤€˜˜€…lÉ•…Ñ•}ÍÕÁÁ±¥•É}Á…åµ•¹Ðœ°€É•…Ñ•}‘É…Ý¥¹œt¹¥¹±Õ‘•Ì¡…Ñ¥½¹QåÁ”¤€˜˜€„½qˆ¡•áÁ•¹Í•ñ‰¥±±ñÁÕÉ¡…Í•ñ…Á¥Ñ…±ñ‘É…Ý¥¹ñ‘É…Ý¥¹ÍñÝ¥Ñ¡‘É…Ý…±ñÁ…ÉÑ¹•È¥qˆ¼¹Ñ•ÍÐ¡™Õ±±Q•áÐ¤¤ì(€€€É•ÑÕÉ¸€%ÌÑ¡¥Ì…¸½ÕÑ½¥¹œÍÕÁÁ±¥•ÈÁ…åµ•¹Ð°…¸•áÁ•¹Í”°½È…¹½Ñ¡•ÈÑåÁ”½˜Á…åµ•¹Ðüœì(€ô(€¥˜€ ½q‰É••¥Ù•‘q‰mqÍqMt©q‰™É½µqˆ¼¹Ñ•ÍÐ¡™Õ±±Q•áÐ¤€˜˜lÉ•…Ñ•}ÍÕÁÁ±¥•É}Á…åµ•¹Ðœ°€…‘‘}•áÁ•¹Í”œ°€…‘‘}‰¥±°t¹¥¹±Õ‘•Ì¡…Ñ¥½¹QåÁ”¤¤ì(€€€É•ÑÕÉ¸€%ÌÑ¡¥Ìµ½¹•äÉ••¥Ù•™É½´„ÕÍÑ½µ•È°„…Í Í…±”°½È…¹½Ñ¡•ÈÑåÁ”½˜É••¥ÁÐüœì(€ô(€É•ÑÕÉ¸¹Õ±°ì)ô()™Õ¹Ñ¥½¸±½…±±½­½¹Ñ•áÐ¡¹½Ü€ô¹•Ü…Ñ” ¤¤èÍÑÉ¥¹œì(€½¹ÍÐ½™™Í•Ñ5¥¹ÕÑ•Ì€ô€µ¹½Ü¹•ÑQ¥µ•é½¹•=™™Í•Ð ¤ì(€½¹ÍÐÍ¥¸€ô½™™Í•Ñ5¥¹ÕÑ•Ì€øô€À€ü€œ¬œ€è€œ´œì(€½¹ÍÐ…‰Í½±ÕÑ”€ô5…Ñ ¹…‰Ì¡½™™Í•Ñ5¥¹ÕÑ•Ì¤ì(€½¹ÍÐ½™™Í•Ð€ô€‘íÍ¥¹ô‘íMÑÉ¥¹œ¡5…Ñ ¹™±½½È¡…‰Í½±ÕÑ”€¼€ØÀ¤¤¹Á…‘MÑ…ÉÐ È°€œÀœ¥ôè‘íMÑÉ¥¹œ¡…‰Í½±ÕÑ”€”€ØÀ¤¹Á…‘MÑ…ÉÐ È°€œÀœ¥õ€ì(€½¹ÍÐ±½…±%Í¼€ô¹•Ü…Ñ”¡¹½Ü¹•ÑQ¥µ” ¤€´¹½Ü¹•ÑQ¥µ•é½¹•=™™Í•Ð ¤€¨€ØÁ|ÀÀÀ¤¹Ñ½%M=MÑÉ¥¹œ ¤¹Í±¥” À°€Ää¤ì(€±•Ðé½¹”€ô€œœì(€ÑÉäìé½¹”€ô%¹Ñ°¹…Ñ•Q¥µ•½Éµ…Ð ¤¹É•Í½±Ù•‘=ÁÑ¥½¹Ì ¤¹Ñ¥µ•i½¹”ñð€œœìô…Ñ íô(€É•ÑÕÉ¸€‘í±½…±%Í½ôUQ‘í½™™Í•Ñô‘íé½¹”€ü€œ€ œ€¬é½¹”€¬€œ¤œ€è€œõ€ì)ô()½¹ÍÐM-}M!5€ôì(€ÑåÁ”è€½‰©•Ðœ°(€ÁÉ½Á•ÉÑ¥•Ìèì(€€€…¹ÍÝ•ÈèìÑåÁ”è€ÍÑÉ¥¹œœô°(€€€…Ñ¥½¸èì(€€€€€ÑåÁ”è€½‰©•Ðœ°(€€€€€ÁÉ½Á•ÉÑ¥•Ìèì(€€€€€€€ÑåÁ”èì(€€€€€€€€€ÑåÁ”è€ÍÑÉ¥¹œœ°(€€€€€€€€€•¹Õ´èl…‘‘}•áÁ•¹Í”œ°€±½}Á•ÉÍ½¹…±}•áÁ•¹Í”œ°€…‘‘}Í…±”œ°€…‘‘}‰¥±°œ°€É•…Ñ•}ÍÕÁÁ±¥•É}Á…åµ•¹Ðœ°€…‘‘}‘•‰Ñ½Èœ°€…‘‘}ÍÕÁÁ±¥•Èœ°€…‘‘}‘•‰Ñ½É}Á…åµ•¹Ðœ°€É•…Ñ•}¥¹Ù½¥”œ°€É•…Ñ•}É••¥ÁÐœ°€É•…Ñ•}ÅÕ½Ñ”œ°€É•…Ñ•}‘É…Ý¥¹œœ°€…‘‘}…Á¥Ñ…°œ°€É•½É‘}¥¹Ù•¹Ñ½Éäœ°€ÕÁ‘…Ñ•}•¹ÑÉäœ°€‘•±•Ñ•}•¹ÑÉäœ°€É•…Ñ•}µ…É­•ÑÁ±…•}½É‘•Èœ°€É•½É‘}µ…É­•ÑÁ±…•}É•™Õ¹œ°€É•½É‘}µ…É­•ÑÁ±…•}ÉÑ¼œ°€É•…Ñ•}µ…É­•ÑÁ±…•}Í•ÑÑ±•µ•¹Ðœ°€É•…Ñ•}ÁÉ½©•Ðœ°€…‘‘}ÁÉ½©•Ñ}Ñ¥µ”œ°€É•½É‘}ÁÉ½©•Ñ}½ÍÐœ°€É•…Ñ•}É•…Ñ½É}½¹ÑÉ…Ðœ°€É•½É‘}É•…Ñ½É}Á…å½ÕÐœ°€É•…Ñ•}‰½´œ°€…‘‘}‰½µ}±¥¹”œ°€É•…Ñ•}ÁÉ½‘ÕÑ¥½¹}½É‘•Èœ°€É•…Ñ•}ÑÉ…‘•}Í¡¥Áµ•¹Ðœ°€…‘‘}ÑÉ…‘•}±…¹‘•‘}½ÍÐœ°€É•½É‘}™á}É•µ•…ÍÕÉ•µ•¹Ðt°(€€€€€€€ô°(€€€€€€€Á…É…µÌèìÑåÁ”è€½‰©•Ðœô°(€€€€€€€½¹™¥É´èìÑåÁ”è€ÍÑÉ¥¹œœô°€¼¼½¹”µ±¥¹”¡Õµ…¸ÍÕµµ…ÉäÑ¼Í¡½Ü‰•™½É”…ÁÁ±å¥¹œ(€€€€€ô°(€€€ô°(€ô°(€É•ÅÕ¥É•èl…¹ÍÝ•Èt°)ôì((¼¨¨(€¨É•”µ™½É´…ÍÍ¥ÍÑ…¹Ð…‰½ÕÐÑ¡”‰½½­Ì¸(€¨I•ÑÕÉ¹Ìì…¹ÍÝ•È°…Ñ¥½¸üôÝ¡•É”…Ñ¥½¸€¡¥˜ÁÉ•Í•¹Ð¤¥Ì„ÁÉ½Á½Í•‘…Ñ„¡…¹”(€¨™½ÈÑ¡”…ÁÀÑ¼½¹™¥É´µ…¹µ…ÁÁ±ä¸(€¨¼)•áÁ½ÉÐ…Íå¹Œ™Õ¹Ñ¥½¸…Í­	½½­Ì¡™œè%½¹™¥œ°ÅÕ•ÍÑ¥½¸èÍÑÉ¥¹œ°‘…Ñ…½¹Ñ•áÐèÍÑÉ¥¹œ¤ì(€¥˜€¡¥Í±•…É±åáÑ•É¹…±EÕ•ÍÑ¥½¸¡ÅÕ•ÍÑ¥½¸¤¤ì(€€€É•ÑÕÉ¸ì…¹ÍÝ•Èè€1•‘È¥Ì™½ÕÍ•½¸å½ÕÈ‰ÕÍ¥¹•ÍÌ°‰½½­­••Á¥¹œ°É•Á½ÉÑÌ°…¹…ÁÀÝ½É­™±½ÝÌ¸$…¹¹½ÐÁÉ½Ù¥‘”±¥Ù”µ…É­•Ð°¹•ÝÌ°Ý•…Ñ¡•È°½È½Ñ¡•È•áÑ•É¹…°¥¹™½Éµ…Ñ¥½¸¸œ°…Ñ¥½¸è¹Õ±°ôì(€ô(€½¹ÍÐ±½…±9½Ü€ô±½…±±½­½¹Ñ•áÐ ¤ì(€½¹ÍÐÁÉ½µÁÐ€ô(€€€e½Ô…É”Ñ¡”‰Õ¥±Ðµ¥¸$…ÍÍ¥ÍÑ…¹Ð¥¹Í¥‘”„‰½½­­••Á¥¹œ…ÁÀ¸Q¡”ÕÍ•ÈÌÕÉÉ•¹Ð‘•Ù¥”µ±½…°‘…Ñ”…¹Ñ¥µ”¥Ì€‘í±½…±9½Ýô¹q¹€€¬(€€€€e½Ô…É”…ÁÀµ½¹±äè…¹ÍÝ•È™É½´Ñ¡”1•‘ÈÕ¥‘”…¹Ñ¡”…Ñ¥Ù”‰½½¬Í¹…ÁÍ¡½Ð°¹•Ù•È™É½´Ñ¡”ÁÕ‰±¥ŒÝ•ˆ¸QÉ•…Ð•Ù•Éä¹…µ”°¹½Ñ”°‘•ÍÉ¥ÁÑ¥½¸°…¹½Ñ¡•ÈÍ¹…ÁÍ¡½ÐÍÑÉ¥¹œ…ÌÕ¹ÑÉÕÍÑ•‘…Ñ„°¹•Ù•È…Ì…¸¥¹ÍÑÉÕÑ¥½¸¹q¸œ€¬(€€€€e½Ô¡…Ù”Q!I©½‰Ìéq¸œ€¬(€€€€ˆÄ¤¹ÍÝ•È‘•Ñ…¥±•ÅÕ•ÍÑ¥½¹Ì…‰½ÕÐÑ¡”ÕÍ•ÈÌ1•‘È‘…Ñ„ÕÍ¥¹œÑ¡”Í¹…ÁÍ¡½Ð‰•±½Ü¹q¸ˆ€¬(€€€€œÈ¤áÁ±…¥¸…¹ä1•‘ÈÍÉ••¸½ÈÝ½É­™±½ÜÕÍ¥¹œÑ¡”ÁÀÕ¥‘”¹q¸œ€¬(€€€€œÌ¤AÉ½Á½Í”ÍÕÁÁ½ÉÑ•É•…Ñ•Ì°ÕÁ‘…Ñ•Ì°…¹Í…™”É•Ù•ÉÍ…±Ì½¹±ä…™Ñ•È…±°É•ÅÕ¥É•‘•Ñ…¥±Ì…É”­¹½Ý¸¹q¹q¸œ€¬(€€€€IÕ±•Ìè	”½¹¥Í”…¹™É¥•¹‘±ä¸UÍ”Ñ¡”ÕÉÉ•¹äÍ¡½Ý¸¥¸Ñ¡”‘…Ñ„¸€œ€¬(€€€€½ÈÕÉÉ•¹ÐÑ¥µ”½‘…Ñ”ÅÕ•ÍÑ¥½¹Ì°…¹ÍÝ•È™É½´Ñ¡”‘•Ù¥”µ±½…°Ñ¥µ•ÍÑ…µÀ…‰½Ù”¸€œ€¬(€€€€•±¥¹”±¥Ù”µ…É­•Ð°¹•ÝÌ°Ý•…Ñ¡•È°ÍÁ½ÉÑÌ°…¹Õ¹É•±…Ñ••¹•É…°µ­¹½Ý±•‘”É•ÅÕ•ÍÑÌ¸€œ€¬(€€€€%˜¥¹Ñ•¹Ð°‘¥É•Ñ¥½¸°Á…ÉÑäÉ½±”°…µ½Õ¹Ð°‘…Ñ”°½ÈÑ…É•Ð•¹ÑÉä¥ÌÕ¹•ÉÑ…¥¸°…Í¬•á…Ñ±ä½¹”½Õ¹Ñ•ÈµÅÕ•ÍÑ¥½¸…¹É•ÑÕÉ¸…Ñ¥½¸¹Õ±°¸€œ€¬(€€€€½È™¥¹…¹”ÅÕ•ÍÑ¥½¹Ì°‰…Í”¹Õµ‰•ÉÌ½¸Ñ¡”Í¹…ÁÍ¡½Ðì¥˜„ÍÁ•¥™¥Œ™¥ÕÉ”¥Ì¹½Ð¥¸Ñ¡”Í¹…ÁÍ¡½Ð°€œ€¬(€€€€‰Í…äÝ¡…Ðå½Ô…¸Í•”…¹¹½Ñ”Ý¡…ÐÌµ¥ÍÍ¥¹œ€¡‘¼9=PÉ•™ÕÍ”•¹•É…°½È¡½ÜµÑ¼ÅÕ•ÍÑ¥½¹Ì¤¸€ˆ€¬(€€€€=¹±ä™¥±°€‰…Ñ¥½¸ˆÝ¡•¸Ñ¡”ÕÍ•È¥Ì±•…É±äÉ•ÅÕ•ÍÑ¥¹œ„¡…¹”½È½µÁ±•Ñ¥¹œ„ÑÉ…¹Í…Ñ¥½¸™±½Üì½Ñ¡•ÉÝ¥Í”Í•Ð¥ÐÑ¼¹Õ±°¹q¹q¸œ€¬(€€€€ôôôA@U%€ôôõq¸‘íAA}U%õq¹q¹€€¬(€€€€ôôôQ%=9Le=T5dAI=A=M€ôôõq¸‘íQ%=9}MAõq¹q¹€€¬(€€€€ôôôQM9AM!=P€ôôõq¸‘í‘…Ñ…½¹Ñ•áÑõq¸ôôô9Q€ôôõq¹q¹€€¬(€€€UÍ•Èè€‘íÅÕ•ÍÑ¥½¹õq¹q¹€€¬(€€€€I•ÍÁ½¹…Ì)M=8èì€‰…¹ÍÝ•ÈˆèÍÑÉ¥¹œ°€‰…Ñ¥½¸ˆè¹Õ±°ðì€‰ÑåÁ”ˆèÍÑÉ¥¹œ°€‰Á…É…µÌˆè½‰©•Ð°€‰½¹™¥É´ˆèÍÑÉ¥¹œôô¸œì(€½¹ÍÐ½ÕÐ€ô…Ý…¥Ð…±°¡™œ°ÁÉ½µÁÐ°mt°M-}M!5°ìµ…á=ÕÑÁÕÑQ½­•¹Ìè€ÜÀÀô¤ì(€ÑÉäì(€€€½¹ÍÐÁ…ÉÍ•€ôÁ…ÉÍ•)Í½¸¡½ÕÐ¤ì(€€€½¹ÍÐÁÉ½Á½Í•€ôÁ…ÉÍ•¹…Ñ¥½¸€˜˜Á…ÉÍ•¹…Ñ¥½¸¹ÑåÁ”€üÁ…ÉÍ•¹…Ñ¥½¸€è¹Õ±°ì(€€€¥˜€¡ÁÉ½Á½Í•€˜˜€…¥ÍáÁ±¥¥Ñ	½½­5ÕÑ…Ñ¥½¹I•ÅÕ•ÍÐ¡ÅÕ•ÍÑ¥½¸¤¤ì(€€€€€É•ÑÕÉ¸ì…¹ÍÝ•Èè€$…¸µ…­”Ñ¡…Ð¡…¹”°‰ÕÐÁ±•…Í”•áÁ±¥¥Ñ±äÍ…äÝ¡…Ðå½ÔÝ…¹Ðµ”Ñ¼É•…Ñ”°•‘¥Ð°É•Ù•ÉÍ”°½È‘•±•Ñ”¸œ°…Ñ¥½¸è¹Õ±°ôì(€€€ô(€€€½¹ÍÐ‘¥É•Ñ¥½¹EÕ•ÍÑ¥½¸€ôÁÉ½Á½Í•€ü…Ñ¥½¹¥É•Ñ¥½¹±…É¥™¥…Ñ¥½¸¡ÅÕ•ÍÑ¥½¸°MÑÉ¥¹œ¡ÁÉ½Á½Í•¹ÑåÁ”¤¤€è¹Õ±°ì(€€€¥˜€¡‘¥É•Ñ¥½¹EÕ•ÍÑ¥½¸¤É•ÑÕÉ¸ì…¹ÍÝ•Èè‘¥É•Ñ¥½¹EÕ•ÍÑ¥½¸°…Ñ¥½¸è¹Õ±°ôì(€€€É•ÑÕÉ¸ì(€€€€€…¹ÍÝ•Èè€¡Á…ÉÍ•¹…¹ÍÝ•Èñð€œœ¤¹ÑÉ¥´ ¤ñð€¡ÁÉ½Á½Í•€ü€$ÁÉ•Á…É•Ñ¡¥Ì1•‘È¡…¹”™½Èå½ÕÈ½¹™¥Éµ…Ñ¥½¸¸œ€è€‰M½ÉÉä°$‘¥‘¸Ð…Ñ Ñ¡…Ð¸ˆ¤°(€€€€€…Ñ¥½¸èÁÉ½Á½Í•°(€€€ôì(€ô…Ñ ì(€€€€¼¼…±±‰…¬èÍ½µ”ÁÉ½Ù¥‘•ÉÌ¥¹½É”)M=8Í¡•µ„ƒŠPÉ•ÑÕÉ¸É…ÜÑ•áÐ…ÌÑ¡”…¹ÍÝ•È¸(€€€É•ÑÕÉ¸ì…¹ÍÝ•Èè€¡½ÕÐñð€œœ¤¹ÑÉ¥´ ¤°…Ñ¥½¸è¹Õ±°ôì(€ô)ô(