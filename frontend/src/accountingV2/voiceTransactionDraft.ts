import { validateAssistantProposal, type AssistantProposalValidationResult } from './aiActions';
import {
  commandWithCreatedParty,
  resolveVoicePartyCommand,
  type VoiceCommand,
  type VoicePartyCreateProposal,
  type VoicePartyDirectory,
} from './voicePartyResolution';

export const VOICE_TRANSACTION_GUIDANCE =
  'I could not identify a supported transaction. Include the transaction type and amount, plus the party when relevant—for example, “Paid supplier Amit 100 today”. You can edit the transcript and update the draft.';

export type VoiceTransactionDraft = {
  parsed: VoiceCommand;
  validation: Extract<AssistantProposalValidationResult, { ok: true }>;
};

export function unpaidInvoicesForCustomer(invoices: any[], customer: { id?: string } | undefined, customerName?: string) {
  const name = String(customerName || '').trim().toLowerCase();
  return invoices.filter((invoice: any) => invoice.status !== 'paid' && (
    (customer?.id && (invoice.partyId === customer.id || invoice.debtorId === customer.id))
    || (name && String(invoice.clientName || '').trim().toLowerCase() === name)
  )).sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)));
}

/** Never guesses among multiple unpaid invoices. */
export function resolveAgainstInvoiceTarget(command: VoiceCommand, invoices: any[]): { invoiceId: string } | { mode: 'advance' } {
  if (command.invoiceId) {
    const match = invoices.find((invoice: any) => invoice.id === command.invoiceId);
    if (!match) throw new Error('That invoice was not found or is already paid. Choose a specific unpaid invoice.');
    return { invoiceId: match.id };
  }
  if (invoices.length === 0) return { mode: 'advance' };
  if (invoices.length === 1) return { invoiceId: invoices[0].id };
  const list = invoices.slice(0, 5).map((invoice: any) => `${invoice.invoiceNumber || invoice.id} dated ${invoice.date}`).join('; ');
  throw new Error(`This customer has ${invoices.length} unpaid invoices. Name the invoice number or date, or record an advance. Open invoices: ${list}`);
}

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
    receipt: { type: 'create_receipt', params: { amount: parsed.amount, date: parsed.date, mode: parsed.receiptMode, customerName: parsed.customerName, invoiceId: parsed.invoiceId, method: parsed.method, notes: parsed.notes || parsed.summary } },
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

/** Resolves parties for one or more voice commands. Unknown names on a multi-item utterance become create-on-save drafts. */
export function resolveVoiceCommandsForDrafts(
  commands: VoiceCommand[],
  transcript: string,
  directory: VoicePartyDirectory,
): { ok: true; commands: VoiceCommand[] } | { ok: false; question: string; command: VoiceCommand; createProposal?: VoicePartyCreateProposal } {
  const allowPendingCreate = commands.length > 1;
  const resolved: VoiceCommand[] = [];
  for (const command of commands) {
    const resolution = resolveVoicePartyCommand(command, transcript, directory);
    if (resolution.ok) {
      resolved.push(resolution.command);
      continue;
    }
    const proposal = resolution.createProposal;
    if (allowPendingCreate && proposal?.suggestedRole && proposal.name) {
      resolved.push(commandWithCreatedParty(command, proposal.name, proposal.suggestedRole));
      continue;
    }
    return { ok: false, question: resolution.question, command, createProposal: proposal };
  }
  return { ok: true, commands: resolved };
}
