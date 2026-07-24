/**
 * Direct Google Gemini API calls from the mobile app (no backend proxy).
 * Uses the same model & schemas as the previous FastAPI implementation.
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

async function callGemini(apiKey: string, model: string, prompt: string, parts: any[] = [], schema?: any) {
  if (!apiKey) {
    const err: any = new Error('Missing Google Gemini API key. Set it in Settings.');
    err.status = 401;
    throw err;
  }
  const url = `${BASE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
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
  if (!res.ok) {
    const msg = data?.error?.message || `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  const out = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return out;
}

export async function testKey(apiKey: string, model: string) {
  const out = await callGemini(apiKey, model, 'Reply with the single word: OK');
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

export async function parseCommand(apiKey: string, model: string, text: string) {
  const today = new Date().toISOString().slice(0, 10);
  const prompt =
    `Today is ${today}. Parse this shop accounting voice command into JSON. ` +
    "Intents: 'bill' (vendor purchase), 'sale' (customer revenue), 'supplier_payment' (paying a supplier), " +
    "'drawing' (partner withdrawal), 'inventory' (stock count). " +
    'Use ISO date YYYY-MM-DD. All amounts are in USD. ' +
    'Provide a short human summary. Command: ' + text;
  const out = await callGemini(apiKey, model, prompt, [], PARSE_SCHEMA);
  return JSON.parse(out);
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

export async function ocrReceipt(apiKey: string, model: string, imageBase64: string, mimeType = 'image/jpeg') {
  const prompt =
    'Extract from this receipt/invoice: supplierName (business name), date (YYYY-MM-DD), ' +
    'amount (total), currency (always USD), invoiceNo, rawText (full text). Return JSON.';
  const parts = [{ inlineData: { mimeType, data: imageBase64 } }];
  const out = await callGemini(apiKey, model, prompt, parts, OCR_SCHEMA);
  return JSON.parse(out);
}

const TRANSCRIBE_SCHEMA = {
  type: 'object',
  properties: { transcript: { type: 'string' } },
  required: ['transcript'],
};

export async function transcribe(apiKey: string, model: string, audioBase64: string, mimeType = 'audio/m4a') {
  const prompt = "Transcribe this audio verbatim. Return JSON with a 'transcript' field.";
  const parts = [{ inlineData: { mimeType, data: audioBase64 } }];
  const out = await callGemini(apiKey, model, prompt, parts, TRANSCRIBE_SCHEMA);
  return JSON.parse(out);
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

export async function reconcileStatementAI(apiKey: string, model: string, imageBase64: string, mimeType = 'image/jpeg') {
  const prompt =
    'Extract every line item from this supplier statement / ledger photo. ' +
    "For each line, return: date (YYYY-MM-DD), amount (positive number), " +
    "type ('bill' for purchase/invoice/debit or 'payment' for credit/payment received), " +
    'description, reference/invoice number. Also return the statement total if visible. Return JSON matching the schema.';
  const parts = [{ inlineData: { mimeType, data: imageBase64 } }];
  const out = await callGemini(apiKey, model, prompt, parts, STATEMENT_SCHEMA);
  return JSON.parse(out);
}
