import type { V2ActionSource, V2WriteAction } from './aiActions';
import { buildPersistentV2Reports } from './persistentReports';
import { executeV2AiAction, validateV2AiAction } from './aiActions';
import { V2AppService } from './appService';
import { activeSqlRunner } from '../db/backend';

export type V2CommandOptions = { service?: V2AppService };

export async function runConfirmedV2Command(source: V2ActionSource, rawAction: unknown, confirmed = false, options: V2CommandOptions = {}) {
  const validation = validateV2AiAction({ ...(rawAction as Record<string, unknown>), source });
  if (!validation.ok) throw new Error(`Invalid action: ${validation.errors.join('; ')}`);
  const service = options.service || (() => { const db = activeSqlRunner(); if (!db) throw new Error('V2 accounting requires SQLite storage'); return new V2AppService(db); })();
  if (validation.action.access === 'read') {
    const action = validation.action;
    if (action.intent === 'report_query') {
      const report = await buildPersistentV2Reports(service.db, { bookId: (await service.activeContext())?.bookId || '', from: action.from, to: action.to });
      return { action, executed: true, result: report.profitAndLoss };
    }
    if (action.intent === 'party_lookup') return { action, executed: true, result: (await service.listParties()).filter((p: any) => p.name.toLowerCase().includes(action.query.toLowerCase())) };
    const report = await buildPersistentV2Reports(service.db, { bookId: (await service.activeContext())?.bookId || '', from: action.from, to: action.to });
    return { action, executed: true, result: report.profitAndLoss };
  }
  const result = await executeV2AiAction(validation, { confirmed }, async (action: V2WriteAction) => {
    if (action.intent === 'create_invoice') return service.createInvoice({ partyId: action.partyId, date: action.date, total: action.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0), invoiceNumber: undefined });
    if (action.intent === 'create_payment') {
      if (action.direction === 'received') return service.createReceipt({ debtorId: action.partyId, clientName: action.partyId, date: action.date, amount: action.amount, method: action.method, allocations: action.invoiceId ? [{ invoiceSourceId: action.invoiceId, amount: action.amount }] : [] });
      return service.createPayment({ supplierId: action.partyId, supplierName: action.partyId, date: action.date, amount: action.amount, method: action.method });
    }
    return service.closeBooks({ actualStock: 0, openingInventory: 0, commissionPct: 0 });
  });
  return { action: validation.action, executed: true, result };
}
