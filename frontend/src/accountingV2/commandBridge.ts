import type { V2ActionSource } from './aiActions';
import { v2Services } from './runtime';
import { executeV2AiAction, validateV2AiAction } from './aiActions';

export async function runConfirmedV2Command(source: V2ActionSource, rawAction: unknown, confirmed = false) {
  const validation = validateV2AiAction({ ...(rawAction as Record<string, unknown>), source });
  if (!validation.ok) throw new Error(`Invalid action: ${validation.errors.join('; ')}`);
  if (validation.action.access === 'read') return { action: validation.action, executed: false };
  const services = v2Services();
  const result = await executeV2AiAction(validation, { confirmed }, async (action) => {
    if (action.intent === 'create_invoice') throw new Error('Invoice execution requires document-line integration');
    if (action.intent === 'create_payment') throw new Error('Payment execution requires direction-specific V2 document integration');
    throw new Error('Close-books execution requires the period close input payload');
  });
  return { action: validation.action, executed: true, result, services };
}
