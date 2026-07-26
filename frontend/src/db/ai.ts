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
    intent: { type: 'string', enum: ['bill', 'sale', 'receipt', 'supplier_payment', 'drawing', 'inventory', 'unknown'] },
    date: { type: 'string' },
    amount: { type: 'number' },
    currency: { type: 'string', enum: ['USD'] },
    supplierName: { type: 'string' },
    customerName: { type: 'string' },
    partnerName: { type: 'string' },
    paymentType: { type: 'string', enum: ['cash', 'credit'] },
    receiptMode: { type: 'string', enum: ['cash_sale', 'against_invoice', 'advance'] },
    method: { type: 'string', enum: ['cash', 'card', 'bank', 'upi'] },
    notes: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['intent', 'summary'],
};

export async function parseCommand(cfg: AIConfig, text: string) {
  const today = new Date().toISOString().slice(0, 10);
  const prompt =
    `Today is ${today}. Parse this shop accounting voice command into JSON. ` +
    "Intents: 'bill' (vendor purchase), 'sale' (customer revenue — a plain cash sale), " +
    "'receipt' (money RECEIVED from a customer — e.g. 'received 500 from Ali', 'Ali paid his invoice', 'took 200 advance from Sara'), " +
    "'supplier_payment' (paying a supplier), 'drawing' (partner withdrawal), 'inventory' (stock count). " +
    "For a 'receipt', also set receiptMode: 'cash_sale' (walk-in paid now, no customer owed), " +
    "'against_invoice' (settling what a named customer already owes), or 'advance' (money before any invoice). " +
    "Set customerName when a customer is named, and method (cash/card/bank/upi) if stated. " +
    'Use ISO date YYYY-MM-DD. All amounts are in USD. ' +
    "Provide a short human summary. Fields: intent, date, amount, currency, supplierName, customerName, partnerName, paymentType, receiptMode, method, notes, summary. " +
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

// Knowledge about the app itself, so the assistant can explain how to use it.
const APP_GUIDE =
  "This app is Ledgr, a standalone (offline, on-device) bookkeeping app for small businesses " +
  "(shops, service providers, retailers). All data is stored on the phone; nothing is sent to a server. " +
  "Main features and where to find them:\n" +
  "- Dashboard (Home): cash, inventory value, net worth, sales, purchases, profit at a glance.\n" +
  "- Purchases (Bills): record what you buy from suppliers/vendors (cash or credit).\n" +
  "- Sales: record customer revenue.\n" +
  "- Receipts: record money actually received. Three kinds — Cash Sale (walk-in paid now), " +
  "Against Invoice (settles what a customer owes, full or partial), and Advance (money before an invoice). " +
  "Every receipt updates cash; against-invoice receipts also update the customer's balance and mark the invoice paid/partial.\n" +
  "- Invoices: create invoices, share as PDF or on WhatsApp, mark paid. An invoice automatically " +
  "creates/updates a Debtor (the customer who owes you).\n" +
  "- Quotes/Estimates: create a price quote (no ledger effect); when the customer accepts, convert it to an invoice in one tap.\n" +
  "- Credit/Debit Notes: from a customer's Debtor screen, give a post-sale discount or record a return (credit note, lowers their balance) or add an extra charge (debit note). No cash moves.\n" +
  "- Delivery Notes/Challans: record goods handed to a customer (quantity only, no prices); share as PDF. No ledger effect.\n" +
  "- Debtors: who owes you money; record payments; send WhatsApp reminders.\n" +
  "- Creditors: suppliers you owe; running balances; WhatsApp reminders.\n" +
  "- Expenses: day-to-day costs by category.\n" +
  "- Inventory: stock counts. Profit uses periodic inventory: COGS = opening stock + purchases - closing stock.\n" +
  "- Reports: Profit & Loss, Balance Sheet, Trial Balance, Partner Capital, Drawings, with date-range filters and charts.\n" +
  "- Day Book: every transaction in date order.\n" +
  "- Reconcile: photograph or upload a supplier statement/PDF; AI compares it to your ledger.\n" +
  "- Voice/Camera entry: speak an entry or snap a receipt; AI fills the form (you confirm before saving).\n" +
  "- Settings: business profile, currency (15 options), tax label & rate, partner names, opening capital, " +
  "backup/restore, WhatsApp share, and the AI provider + API key.\n" +
  "- Ask AI (this screen): ask questions about your books, general questions, how to use the app, and request changes.";

// Actions the AI is allowed to PROPOSE. The app executes them only after the user confirms.
const ACTION_SPEC =
  "You may propose ONE data change when the user clearly asks to add/record/create/update/delete something. " +
  "Supported actions and their fields:\n" +
  "- add_expense: { category, amount, date?, notes? }\n" +
  "- add_sale: { amount, date?, paymentType? ('cash'|'credit'), notes? }\n" +
  "- add_bill: { supplierName, amount, date?, paymentType? ('cash'|'credit'), notes? }\n" +
  "- add_debtor: { name, phone?, notes? }\n" +
  "- add_debtor_payment: { name, amount, date? }\n" +
  "- create_invoice: { clientName, amount, date?, notes? }\n" +
  "- create_receipt: { amount, mode ('cash_sale'|'against_invoice'|'advance'), customerName?, date?, method? ('cash'|'card'|'bank'|'upi'), notes? }\n" +
  "- create_quote: { clientName, amount, date?, notes? }\n" +
  "Dates are YYYY-MM-DD; default to today if unspecified. Never invent amounts — if a required field is " +
  "missing, ask for it in 'answer' and set action to null.";

const ASK_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    action: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['add_expense', 'add_sale', 'add_bill', 'add_debtor', 'add_debtor_payment', 'create_invoice', 'create_receipt', 'create_quote'],
        },
        params: { type: 'object' },
        confirm: { type: 'string' }, // one-line human summary to show before applying
      },
    },
  },
  required: ['answer'],
};

/**
 * Free-form assistant about the books.
 * Returns { answer, action? } where action (if present) is a proposed data change
 * for the app to confirm-and-apply.
 */
export async function askBooks(cfg: AIConfig, question: string, dataContext: string) {
  const today = new Date().toISOString().slice(0, 10);
  const prompt =
    `You are the built-in AI assistant inside a bookkeeping app. Today is ${today}.\n` +
    'You have THREE jobs:\n' +
    "1) Answer questions about the user's finances using the data snapshot below.\n" +
    '2) Answer general questions and explain how to use this app (use the App Guide).\n' +
    '3) When the user asks to record/add/update/delete data, PROPOSE an action for confirmation.\n\n' +
    'Rules: Be concise and friendly. Use the currency shown in the data. ' +
    'For finance questions, base numbers on the snapshot; if a specific figure is not in the snapshot, ' +
    "say what you can see and note what's missing (do NOT refuse general or how-to questions). " +
    'Only fill "action" when the user is clearly requesting a change; otherwise set it to null.\n\n' +
    `=== APP GUIDE ===\n${APP_GUIDE}\n\n` +
    `=== ACTIONS YOU MAY PROPOSE ===\n${ACTION_SPEC}\n\n` +
    `=== DATA SNAPSHOT ===\n${dataContext}\n=== END DATA ===\n\n` +
    `User: ${question}\n\n` +
    'Respond as JSON: { "answer": string, "action": null | { "type": string, "params": object, "confirm": string } }.';
  const out = await call(cfg, prompt, [], ASK_SCHEMA);
  try {
    const parsed = parseJson(out);
    return {
      answer: (parsed.answer || '').trim() || "Sorry, I didn't catch that.",
      action: parsed.action && parsed.action.type ? parsed.action : null,
    };
  } catch {
    // Fallback: some providers ignore JSON schema — return raw text as the answer.
    return { answer: (out || '').trim(), action: null };
  }
}
