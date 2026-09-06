import { localTodayIso } from '../utils/dateValidation';
import type { AssistantProposalType } from './aiActions';
import type { VoiceCommand } from './voicePartyResolution';

/** OpenAI-style tools Needle/Gemma must call. Keep in lockstep with ASK_SCHEMA / AssistantProposalType. */
export const LEDGR_ON_DEVICE_TOOL_NAMES = [
  'add_expense',
  'log_personal_expense',
  'add_sale',
  'add_bill',
  'create_supplier_payment',
  'add_debtor',
  'add_supplier',
  'add_debtor_payment',
  'create_invoice',
  'create_receipt',
  'create_quote',
  'create_drawing',
  'add_capital',
  'record_inventory',
  'update_entry',
  'delete_entry',
] as const satisfies readonly AssistantProposalType[];

export type LedgrOnDeviceToolName = (typeof LEDGR_ON_DEVICE_TOOL_NAMES)[number];

export type LedgrOnDeviceToolCall = {
  name: LedgrOnDeviceToolName;
  arguments: Record<string, unknown>;
  confidence?: number;
};

export type OptionalOnDeviceModelId = 'qwen25-0-5b' | 'qwen25-1-5b' | 'phi4-mini';

/**
 * What a pack can be asked to do. Selection never routes a task to a pack that
 * does not declare the capability it needs, so a text-only pack is never handed
 * an image.
 */
export type OnDevicePackCapability = 'text' | 'tools' | 'vision' | 'audio';

export const OPTIONAL_ON_DEVICE_MODELS: {
  id: OptionalOnDeviceModelId;
  label: string;
  summary: string;
  bytes: number;
  minRamBytes: number;
  vision: boolean;
  audio: boolean;
  /**
   * Higher wins when several packs are installed. Gaps are deliberate so a pack
   * can be slotted between two others later without renumbering. Becomes
   * manifest-supplied in phase 2.
   */
  rank: number;
  capabilities: OnDevicePackCapability[];
  filename: string;
  downloadUrl: string;
}[] = [
  {
    id: 'qwen25-0-5b',
    label: 'Qwen 2.5 0.5B',
    summary: 'Smallest pack. Short answers about your books on modest phones.',
    bytes: 546_660_344,
    minRamBytes: 4 * 1024 * 1024 * 1024,
    vision: false,
    audio: false,
    rank: 10,
    capabilities: ['text', 'tools'],
    filename: 'Qwen2.5-0.5B-Instruct_multi-prefill-seq_q8_ekv1280.task',
    downloadUrl: 'https://huggingface.co/litert-community/Qwen2.5-0.5B-Instruct/resolve/main/Qwen2.5-0.5B-Instruct_multi-prefill-seq_q8_ekv1280.task',
  },
  {
    id: 'qwen25-1-5b',
    label: 'Qwen 2.5 1.5B',
    summary: 'Better explanations of your books. Text only — scanning stays on-device via OCR.',
    bytes: 1_567_364_648,
    minRamBytes: 6 * 1024 * 1024 * 1024,
    vision: false,
    audio: false,
    rank: 20,
    capabilities: ['text', 'tools'],
    filename: 'Qwen2.5-1.5B-Instruct_seq128_q8_ekv1280.task',
    downloadUrl: 'https://huggingface.co/litert-community/Qwen2.5-1.5B-Instruct/resolve/main/Qwen2.5-1.5B-Instruct_seq128_q8_ekv1280.task',
  },
  {
    id: 'phi4-mini',
    label: 'Phi-4 mini',
    summary: 'Highest quality answers. Large download, flagship phones only.',
    bytes: 3_944_280_650,
    minRamBytes: 12 * 1024 * 1024 * 1024,
    vision: false,
    audio: false,
    rank: 30,
    capabilities: ['text', 'tools'],
    filename: 'phi4_q8_ekv1280.task',
    downloadUrl: 'https://huggingface.co/litert-community/Phi-4-mini-instruct/resolve/main/phi4_q8_ekv1280.task',
  },
];

/**
 * Android reports less memory than the phone is sold with, because the kernel
 * and firmware reserve some before userspace ever sees it: a 12 GB phone
 * commonly reports around 11.2 GB. Comparing that raw figure against a 12 GB
 * requirement hid packs from phones that meet the spec, so round up to the
 * nearest size phones are actually sold in before deciding eligibility.
 * Mirrors advertisedRamBytes() in LedgrOnDeviceLlmModule.kt.
 */
export function advertisedRamBytes(reported?: number | null): number | null {
  if (reported == null || reported <= 0) return null;
  const gib = 1024 ** 3;
  for (const tier of [2, 3, 4, 6, 8, 12, 16, 24, 32]) {
    if (reported <= tier * gib) return tier * gib;
  }
  return reported;
}

export const NEEDLE_ASSET_FILENAME = 'needle2.cact';

export function ledgrOnDeviceToolsJson(partyHints: string[] = []): string {
  const tools = LEDGR_ON_DEVICE_TOOL_NAMES.map((name) => ({
    type: 'function',
    function: {
      name,
      description: toolDescription(name),
      parameters: { type: 'object', additionalProperties: true },
    },
  }));
  // needle_init takes a JSON ARRAY of tool definitions -- the JNI wrapper's own
  // fallback when the argument is null is the literal "[]". Passing an object
  // with tools/partyHints/date/rules made every init fail, which surfaced in
  // Ask AI as "Needle could not load the Ledgr tool list". The context that
  // used to ride along in that object now goes in with the transcript, where
  // Needle actually reads it.
  return JSON.stringify(tools);
}

/** Per-call context for Needle: the tool list itself carries no state. */
export function ledgrOnDeviceToolContext(partyHints: string[] = []): string {
  return [
    `DATE: ${localTodayIso()}`,
    partyHints.length ? `KNOWN PARTIES: ${partyHints.slice(0, 12).join(', ')}` : '',
    'RULES: Call exactly one tool or none. Never invent invoice IDs, entry IDs, or amounts.',
    'Do not delete or update inventory_count. Do not delete customer or supplier records.',
    'If several unpaid invoices could match, call nothing.',
  ].filter(Boolean).join('\n');
}

function toolDescription(name: LedgrOnDeviceToolName): string {
  switch (name) {
    case 'add_expense': return 'Record a business expense. Params: category, amount, date?, method?, notes?';
    case 'log_personal_expense': return 'Record a personal (non-business) expense. Params: category, amount, date?, notes?';
    case 'add_sale': return 'Record a cash or credit sale. Params: amount, date?, paymentType?, notes?';
    case 'add_bill': return 'Record a supplier bill. Params: supplierName, amount, date?, paymentType?, notes?';
    case 'create_supplier_payment': return 'Pay a supplier. Params: supplierName, amount, date?, method?, notes?';
    case 'add_debtor': return 'Create a customer. Params: name, phone?, notes?';
    case 'add_supplier': return 'Create a supplier. Params: name, phone?, notes?';
    case 'add_debtor_payment': return 'Money received from a named customer. Params: name, amount, date?, method?';
    case 'create_invoice': return 'Create a customer invoice. Params: clientName, amount, date?, notes?';
    case 'create_receipt': return 'Money received. Params: amount, mode (cash_sale|against_invoice|advance), customerName?, invoiceId?, date?, method?';
    case 'create_quote': return 'Create a quote. Params: clientName, amount, date?, notes?';
    case 'create_drawing': return 'Partner withdrawal from capital. Params: partnerName, amount, date?, notes?';
    case 'add_capital': return 'Partner capital deposit. Params: partnerName, amount, date?, notes?';
    case 'record_inventory': return 'Stock count. Params: amount, date?, notes?';
    case 'update_entry': return 'Update an existing entry. Params: entity, id, memberId?, changes.';
    case 'delete_entry': return 'Reverse a posted entry. Never inventory_count, customer, or supplier. Params: entity, id, memberId?';
  }
}

const TOOL_TO_INTENT: Partial<Record<LedgrOnDeviceToolName, string>> = {
  add_expense: 'expense',
  log_personal_expense: 'expense',
  add_sale: 'sale',
  add_bill: 'bill',
  create_supplier_payment: 'supplier_payment',
  add_debtor_payment: 'receipt',
  create_receipt: 'receipt',
  create_drawing: 'drawing',
  add_capital: 'capital',
  record_inventory: 'inventory',
};

export function toolCallToVoiceCommand(call: LedgrOnDeviceToolCall): VoiceCommand | null {
  const intent = TOOL_TO_INTENT[call.name];
  if (!intent) return null;
  const args = call.arguments || {};
  const amount = typeof args.amount === 'number' ? args.amount : Number(args.amount);
  const command: VoiceCommand = {
    intent,
    amount: Number.isFinite(amount) ? amount : undefined,
    date: typeof args.date === 'string' ? args.date : undefined,
    method: typeof args.method === 'string' ? args.method : undefined,
    notes: typeof args.notes === 'string' ? args.notes : undefined,
    category: typeof args.category === 'string' ? args.category : undefined,
    supplierName: typeof args.supplierName === 'string' ? args.supplierName : undefined,
    customerName: typeof args.customerName === 'string' ? args.customerName : typeof args.name === 'string' ? args.name : typeof args.clientName === 'string' ? args.clientName : undefined,
    partnerName: typeof args.partnerName === 'string' ? args.partnerName : undefined,
    paymentType: args.paymentType === 'cash' || args.paymentType === 'credit' ? args.paymentType : undefined,
    receiptMode: args.mode === 'cash_sale' || args.mode === 'against_invoice' || args.mode === 'advance' ? args.mode : call.name === 'add_debtor_payment' ? 'against_invoice' : undefined,
    invoiceId: typeof args.invoiceId === 'string' ? args.invoiceId : undefined,
    summary: `${call.name.replace(/_/g, ' ')}${Number.isFinite(amount) ? ` ${amount}` : ''}`.trim(),
  };
  return command;
}

export function toolCallToAskAction(call: LedgrOnDeviceToolCall): { type: string; params: Record<string, unknown> } {
  return { type: call.name, params: call.arguments || {} };
}

export type NeedleGoldenExample = {
  id: string;
  transcript: string;
  expected: null | { name: LedgrOnDeviceToolName; required: Record<string, unknown> };
};

/** Labels for Needle fine-tune + the ≥90% exact-type gate. */
export const NEEDLE_GOLDEN_SET: NeedleGoldenExample[] = [
  { id: 'expense-fuel', transcript: 'spent fifty on diesel in cash yesterday', expected: { name: 'add_expense', required: { amount: 50, category: 'fuel' } } },
  { id: 'expense-rent', transcript: 'record rent expense 1200 bank', expected: { name: 'add_expense', required: { amount: 1200 } } },
  { id: 'sale-cash', transcript: 'cash sale 80', expected: { name: 'add_sale', required: { amount: 80 } } },
  { id: 'bill-supplier', transcript: 'bill from Acme for 200', expected: { name: 'add_bill', required: { amount: 200, supplierName: 'Acme' } } },
  { id: 'pay-supplier', transcript: 'paid 100 to vendor Rahim by bank', expected: { name: 'create_supplier_payment', required: { amount: 100, supplierName: 'Rahim' } } },
  { id: 'drawing', transcript: 'withdraw 300 from Amit capital', expected: { name: 'create_drawing', required: { amount: 300, partnerName: 'Amit' } } },
  { id: 'capital', transcript: 'Amit deposited 5000 capital', expected: { name: 'add_capital', required: { amount: 5000, partnerName: 'Amit' } } },
  { id: 'receipt-acme', transcript: 'received 200 from Acme against the invoice', expected: { name: 'create_receipt', required: { amount: 200, customerName: 'Acme' } } },
  { id: 'inventory', transcript: 'stock count 15000', expected: { name: 'record_inventory', required: { amount: 15000 } } },
  { id: 'personal', transcript: 'personal lunch 12 cash', expected: { name: 'log_personal_expense', required: { amount: 12 } } },
  { id: 'invoice', transcript: 'create invoice 400 for Sara', expected: { name: 'create_invoice', required: { amount: 400, clientName: 'Sara' } } },
  { id: 'question-profit', transcript: "what's my profit this month", expected: null },
  { id: 'question-cash', transcript: 'how much cash do I have', expected: null },
  { id: 'ambiguous-invoices', transcript: 'received 200 from Acme against the old invoice', expected: { name: 'create_receipt', required: { amount: 200, customerName: 'Acme' } } },
  { id: 'no-delete-inventory', transcript: 'delete the inventory count', expected: null },
  { id: 'no-delete-customer', transcript: 'delete customer Acme', expected: null },
];

export function scoreNeedleGolden(actual: LedgrOnDeviceToolCall | null, expected: NeedleGoldenExample['expected']): boolean {
  if (!expected) return actual == null || actual.name === undefined;
  if (!actual || actual.name !== expected.name) return false;
  if (actual.name === 'delete_entry' && String(actual.arguments?.entity || '') === 'inventory_count') return false;
  return Object.entries(expected.required).every(([key, value]) => {
    const got = actual.arguments?.[key];
    if (typeof value === 'number') return Number(got) === value;
    return String(got || '').toLowerCase().includes(String(value).toLowerCase());
  });
}

export function needleGoldenGate(results: { id: string; ok: boolean }[]): { pass: boolean; rate: number; failed: string[] } {
  const ok = results.filter((row) => row.ok).length;
  const rate = results.length ? ok / results.length : 0;
  return { pass: rate >= 0.9 && !results.some((row) => !row.ok && row.id.startsWith('no-delete')), rate, failed: results.filter((row) => !row.ok).map((row) => row.id) };
}
