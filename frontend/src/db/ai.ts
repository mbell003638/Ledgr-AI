/**
 * Multi-provider AI router (no backend).
 * Supports: Google Gemini (native), OpenAI-compatible, Anthropic, OpenRouter.
 * Exposes the same surface as the old gemini.ts so callers don't change:
 *   testKey, parseCommand, ocrReceipt, transcribe, reconcileStatementAI
 *
 * A "provider config" is { provider, apiKey, model, baseUrl? }.
 * - provider: 'gemini' | 'openai' | 'anthropic' | 'openrouter' | 'custom'
 * - baseUrl is only needed for 'custom' (any OpenAI-compatible endpoint).
 */

export type ProviderId = 'gemini' | 'openai' | 'anthropic' | 'openrouter' | 'custom';

export interface AIConfig {
  provider: ProviderId;
  apiKey: string;
  model: string;
  baseUrl?: string; // for custom OpenAI-compatible endpoints
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
    defaultModel: 'gemini-2.0-flash-001',
    keyHint: 'AIza… — free at aistudio.google.com',
    supportsVision: true,
    supportsAudio: true,
    api: 'gemini',
  },
  {
    id: 'openai',
    label: 'OpenAI (GPT)',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    keyHint: 'sk-… from platform.openai.com',
    supportsVision: true,
    supportsAudio: false,
    api: 'openai',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-3-5-sonnet-latest',
    keyHint: 'sk-ant-… from console.anthropic.com',
    supportsVision: true,
    supportsAudio: false,
    api: 'anthropic',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'google/gemini-2.0-flash-001',
    keyHint: 'sk-or-… from openrouter.ai',
    supportsVision: true,
    supportsAudio: false,
    api: 'openai',
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    defaultBaseUrl: '',
    defaultModel: '',
    keyHint: 'Your endpoint API key',
    supportsVision: true,
    supportsAudio: false,
    api: 'openai',
  },
];

export function getProviderMeta(id: ProviderId): ProviderMeta {
  return PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
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

function resolveBaseUrl(cfg: AIConfig): string {
  if (cfg.baseUrl && cfg.baseUrl.trim()) return cfg.baseUrl.replace(/\/+$/, '');
  return getProviderMeta(cfg.provider).defaultBaseUrl.replace(/\/+$/, '');
}

/**
 * Core text/multimodal call. Returns raw text (possibly JSON string).
 * parts: array of { inlineData: { mimeType, data(base64) } } for images/audio.
 */
async function call(
  cfg: AIConfig,
  prompt: string,
  parts: Array<{ inlineData: { mimeType: string; data: string } }> = [],
  jsonSchema?: any
): Promise<string> {
  requireKey(cfg);
  const api = resolveApi(cfg);
  if (api === 'gemini') return callGemini(cfg, prompt, parts, jsonSchema);
  if (api === 'anthropic') return callAnthropic(cfg, prompt, parts, jsonSchema);
  return callOpenAI(cfg, prompt, parts, jsonSchema);
}

// ---------------- Gemini native ----------------
async function callGemini(cfg: AIConfig, prompt: string, parts: any[], schema?: any): Promise<string> {
  const base = resolveBaseUrl(cfg);
  const url = `${base}/models/${cfg.model}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const body: any = {
    contents: [{ role: 'user', parts: [{ text: prompt }, ...parts] }],
    generationConfig: {
      temperature: 0,
      ...(schema ? { responseMimeType: 'application/json', responseSchema: schema } : {}),
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new Error(data?.error?.message || `${res.status} ${res.statusText}`);
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ---------------- OpenAI-compatible (OpenAI, OpenRouter, custom) ----------------
async function callOpenAI(cfg: AIConfig, prompt: string, parts: any[], schema?: any): Promise<string> {
  const base = resolveBaseUrl(cfg);
  const url = `${base}/chat/completions`;
  const content: any[] = [{ type: 'text', text: prompt }];
  for (const p of parts) {
    if (p.inlineData?.mimeType?.startsWith('image/')) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` },
      });
    }
    // Note: OpenAI-compatible chat does not accept raw audio inline; audio is
    // handled by the caller falling back to Gemini for transcription.
  }
  const body: any = {
    model: cfg.model,
    temperature: 0,
    messages: [{ role: 'user', content }],
    ...(schema ? { response_format: { type: 'json_object' } } : {}),
  };
  const headers: any = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  };
  if (cfg.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://ledgr.app';
    headers['X-Title'] = 'Ledgr';
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new Error(data?.error?.message || data?.error || `${res.status} ${res.statusText}`);
  return data?.choices?.[0]?.message?.content || '';
}

// ---------------- Anthropic ----------------
async function callAnthropic(cfg: AIConfig, prompt: string, parts: any[], schema?: any): Promise<string> {
  const base = resolveBaseUrl(cfg);
  const url = `${base}/messages`;
  const content: any[] = [{ type: 'text', text: prompt + (schema ? '\n\nRespond with ONLY valid JSON, no prose.' : '') }];
  for (const p of parts) {
    if (p.inlineData?.mimeType?.startsWith('image/')) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: p.inlineData.mimeType, data: p.inlineData.data },
      });
    }
  }
  const body: any = {
    model: cfg.model,
    max_tokens: 2048,
    temperature: 0,
    messages: [{ role: 'user', content }],
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new Error(data?.error?.message || `${res.status} ${res.statusText}`);
  const out = Array.isArray(data?.content) ? data.content.map((c: any) => c.text || '').join('') : '';
  return out;
}

/** Strip ```json fences some models add, then parse. */
function parseJson(raw: string): any {
  let s = (raw || '').trim();
  if (s.startsWith('```')) s = s.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first > 0 || last < s.length - 1) {
    if (first !== -1 && last !== -1) s = s.slice(first, last + 1);
  }
  return JSON.parse(s);
}

// ================= Public surface (same as old gemini.ts) =================

export async function testKey(cfg: AIConfig) {
  const out = await call(cfg, 'Reply with the single word: OK');
  return { ok: true, reply: (out || '').trim() };
}

const PARSE_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['bill', 'sale', 'supplier_payment', 'drawing', 'inventory', 'unknown'] },
    date: { type: 'string' },
    amount: { type: 'number' },
    currency: { type: 'string', enum: ['USD'] },
    supplierName: { type: 'string' },
    partnerName: { type: 'string' },
    paymentType: { type: 'string', enum: ['cash', 'credit'] },
    notes: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['intent', 'summary'],
};

export async function parseCommand(cfg: AIConfig, text: string) {
  const today = new Date().toISOString().slice(0, 10);
  const prompt =
    `Today is ${today}. Parse this shop accounting voice command into JSON. ` +
    "Intents: 'bill' (vendor purchase), 'sale' (customer revenue), 'supplier_payment' (paying a supplier), " +
    "'drawing' (partner withdrawal), 'inventory' (stock count). " +
    'Use ISO date YYYY-MM-DD. All amounts are in USD. ' +
    "Provide a short human summary. Fields: intent, date, amount, currency, supplierName, partnerName, paymentType, notes, summary. " +
    'Command: ' + text;
  const out = await call(cfg, prompt, [], PARSE_SCHEMA);
  return parseJson(out);
}

const OCR_SCHEMA = {
  type: 'object',
  properties: {
    supplierName: { type: 'string' },
    date: { type: 'string' },
    amount: { type: 'number' },
    currency: { type: 'string' },
    invoiceNo: { type: 'string' },
    rawText: { type: 'string' },
  },
};

export async function ocrReceipt(cfg: AIConfig, imageBase64: string, mimeType = 'image/jpeg') {
  const prompt =
    'Extract from this receipt/invoice and return JSON with fields ' +
    'supplierName (business name), date (YYYY-MM-DD), amount (total number), ' +
    'currency (always USD), invoiceNo, rawText (full text).';
  const parts = [{ inlineData: { mimeType, data: imageBase64 } }];
  const out = await call(cfg, prompt, parts, OCR_SCHEMA);
  return parseJson(out);
}

export async function transcribe(cfg: AIConfig, audioBase64: string, mimeType = 'audio/m4a') {
  // Only Gemini reliably accepts raw audio inline. For non-Gemini providers,
  // caller should keep Gemini configured for voice, or use device STT.
  if (resolveApi(cfg) !== 'gemini') {
    const err: any = new Error(
      `Voice transcription needs Google Gemini. The selected provider (${getProviderMeta(cfg.provider).label}) can't process audio directly. Switch AI provider to Gemini for voice, or type the entry.`
    );
    err.status = 400;
    throw err;
  }
  const prompt = "Transcribe this audio verbatim. Return JSON with a 'transcript' field.";
  const parts = [{ inlineData: { mimeType, data: audioBase64 } }];
  const out = await call(cfg, prompt, parts, { type: 'object', properties: { transcript: { type: 'string' } }, required: ['transcript'] });
  return parseJson(out);
}

const STATEMENT_SCHEMA = {
  type: 'object',
  properties: {
    supplierName: { type: 'string' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          amount: { type: 'number' },
          type: { type: 'string', enum: ['bill', 'payment', 'unknown'] },
          description: { type: 'string' },
          reference: { type: 'string' },
        },
      },
    },
    totalOnStatement: { type: 'number' },
  },
  required: ['entries'],
};

export async function reconcileStatementAI(cfg: AIConfig, imageBase64: string, mimeType = 'image/jpeg') {
  const prompt =
    'Extract every line item from this supplier statement / ledger photo. ' +
    "For each line, return: date (YYYY-MM-DD), amount (positive number), " +
    "type ('bill' for purchase/invoice/debit or 'payment' for credit/payment received), " +
    'description, reference/invoice number. Also return totalOnStatement if visible. ' +
    'Return JSON with fields supplierName, entries[], totalOnStatement.';
  const parts = [{ inlineData: { mimeType, data: imageBase64 } }];
  const out = await call(cfg, prompt, parts, STATEMENT_SCHEMA);
  return parseJson(out);
}

/** Free-form: ask the AI a question about the books (Gemini chat feature). */
export async function askBooks(cfg: AIConfig, question: string, dataContext: string) {
  const prompt =
    'You are an accounting assistant for a small business bookkeeping app. ' +
    "Answer the user's question using ONLY the data snapshot below. " +
    'Be concise, use the currency as shown, and if the data does not contain the answer, say so.\n\n' +
    `=== DATA SNAPSHOT ===\n${dataContext}\n=== END DATA ===\n\nQuestion: ${question}`;
  const out = await call(cfg, prompt);
  return (out || '').trim();
}
