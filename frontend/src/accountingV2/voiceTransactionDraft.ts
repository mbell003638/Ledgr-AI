import { validateAssistantProposal, type AssistantProposalValidationResult } from './aiActions';
import type { VoiceCommand } from './voicePartyResolution';

export const VOICE_TRANSACTION_GUIDANCE =
  'I could not identify a supported transaction. Include the transaction type and amount, plus the party when relevant—for example, “Paid supplier Amit 100 today”. You can edit the transcript and update the draft.';

export type VoiceTransactionDraft = {
  parsed: VoiceCommand;
  validation: Extract<AssistantProposalValidationResult, { ok: true }>;
};

/**
 * Converts a resolved voice command into the same validated proposal shape used
 * by Ask AI. Unknown speech never reaches the generic validator as `undefined`,
 * so users see actionable guidance instead of an internal "unsupported action"
 * message.
 */
export function buildVoiceTransactionDraft(parsed: VoiceCommand): VoiceTransactionDraft {
  const proposalByIntent: Record<string, { type: string; params: Record<string, unknown> }> = {
    expense: { type: 'add_expense', params: { category: parsed.category || 'General', amount: parsed.amount, date: parsed.date, method: parsed.method, notes: parsed.notes || parsed.summary } },
    bill: { type: 'add_bill', params: { supplierName: parsed.supplierName, amount: parsed.amount, date: parsed.date, paymentType: parsed.paymentType, notes: parsed.notes || parsed.summary } },
    sale: { type: 'add_sale', params: { amount: parsed.amount, date: parsed.date, paymentType: parsed.paymentType, notes: parsed.notes || parsed.summary } },
    receipt: { type: 'create_receipt', params: { amount: parsed.amount, date: parsed.date, mode: parsed.receiptMode, customerName: parsed.customerName, method: parsed.method, notes: parsed.notes || parsed.summary } },
    supplier_payment: { type: 'create_supplier_payment', params: { supplierName: parsed.supplierName, amount: parsed.amount, date: parsed.date, method: parsed.method, notes: parsed.notes || parsed.summary } },
    drawing: { type: 'create_drawing', params: { partnerName: parsed.partnerName, amount: parsed.amount, date: parsed.date, method: parsed.method, notes: parsed.notes || parsed.summary } },
    capital: { type: 'add_capital', params: { partnerName: parsed.partnerName, amount: parsed.amount, date: parsed.date, method: parsed.method, notes: parsed.notes || parsed.summary } },
    inventory: { type: 'record_inventory', params: { amount: parsed.amount, date: parsed.date, notes: parsed.notes || parsed.summary } },
  };

  const proposal = proposalByIntent[String(parsed.intent || '')];
  if (!proposal) throw new Error(VOICE_TRANSACTION_GUIDANCE);

  const validation = validateAssistantProposal(proposal, 'voice');
  if (!validation.ok) {
    throw new Error(`I could not prepare a safe transaction draft: ${validation.errors[0]}. Edit the transcript and update the draft.`);
  }
  return { parsed, validation };
}
