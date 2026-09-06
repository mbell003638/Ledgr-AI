import { api } from '../api';
import { LEDGR_ON_DEVICE_READ_TOOL_NAMES, type LedgrOnDeviceToolCall } from './onDeviceTools';

/**
 * Executes the on-device READ tools and renders the result as plain text.
 *
 * Reads cannot mutate the book, so unlike a write they need no proposal, no
 * validateAssistantProposal pass and no user confirmation. That asymmetry is
 * deliberate: it is what lets the assistant answer "how much does Amit owe"
 * without putting a confirm sheet in front of a question.
 */

export type ReadToolName = (typeof LEDGR_ON_DEVICE_READ_TOOL_NAMES)[number];

export function isReadToolName(name: string): name is ReadToolName {
  return (LEDGR_ON_DEVICE_READ_TOOL_NAMES as readonly string[]).includes(name);
}

function money(value: unknown): string {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount.toFixed(2) : '0.00';
}

function rows(list: unknown): Record<string, unknown>[] {
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

async function partyLookup(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query || '').trim().toLowerCase();
  if (!query) return 'Tell me which customer or supplier to look up.';
  const role = String(args.role || '').toLowerCase();

  const [customers, suppliers] = await Promise.all([
    role === 'supplier' ? Promise.resolve([]) : api.debtorsReport(),
    role === 'customer' ? Promise.resolve([]) : api.creditorsReport(),
  ]);

  const match = (list: Record<string, unknown>[], kind: string) => rows(list)
    .filter((party) => String(party.name || '').toLowerCase().includes(query))
    .map((party) => `${party.name} (${kind}): ${money(party.balance)}`);

  const found = [...match(customers as never, 'customer owes you'), ...match(suppliers as never, 'you owe')];
  if (!found.length) return `No customer or supplier matches "${args.query}".`;
  // More than one match is reported rather than guessed: picking the "closest"
  // name is how a payment lands on the wrong ledger.
  return found.length === 1 ? found[0] : `${found.length} matches:\n${found.join('\n')}`;
}

async function reportQuery(args: Record<string, unknown>): Promise<string> {
  const report = String(args.report || 'profit_and_loss');
  if (report === 'balance_sheet') {
    const sheet = (await api.balanceSheet()) as Record<string, unknown>;
    return `Balance sheet — assets ${money(sheet.assets)}, liabilities ${money(sheet.liabilities)}, equity ${money(sheet.equity)}.`;
  }
  if (report === 'trial_balance') {
    const trial = (await api.trialBalance()) as Record<string, unknown>;
    return `Trial balance — debits ${money(trial.debit)}, credits ${money(trial.credit)}, ${trial.balanced ? 'balanced' : 'OUT OF BALANCE'}.`;
  }
  const board = (await api.dashboard()) as Record<string, unknown>;
  const label = report === 'cash_flow' ? 'Cash flow' : 'Profit and loss';
  return `${label} — sales ${money(board.sales)}, purchases ${money(board.purchases)}, expenses ${money(board.expenses)}, profit ${money(board.profit ?? board.netProfit)}.`;
}

async function inventoryProfit(): Promise<string> {
  const board = (await api.dashboard()) as Record<string, unknown>;
  const sales = Number(board.sales || 0);
  const cogs = Number(board.cogs ?? board.purchases ?? 0);
  const gross = sales - cogs;
  const margin = sales > 0 ? ((gross / sales) * 100).toFixed(1) : '0.0';
  return `Stock profit — sales ${money(sales)}, cost of goods ${money(cogs)}, gross profit ${money(gross)} (${margin}% margin).`;
}

/**
 * The capability registry exists only on the branches that have Workspace
 * capabilities. Load it lazily so this tool degrades to the core description
 * elsewhere instead of failing to resolve at bundle time.
 */
function capabilityLines(settings: unknown): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../utils/capabilities');
    const enabled = new Set<string>(mod.getEnabledCapabilities(settings));
    return (mod.CAPABILITIES as { key: string; label: string; description: string }[])
      .filter((item) => enabled.has(item.key))
      .map((item) => `- ${item.label}: ${item.description}`);
  } catch {
    return [];
  }
}

async function describeCapabilities(): Promise<string> {
  // Answered from what this book actually has enabled, so toggling a pack in
  // Workspace capabilities changes the answer instead of leaving a stale
  // paragraph in a prompt.
  const settings = await api.getSettings();
  const lines = capabilityLines(settings);
  return [
    'Ledgr keeps your books on this phone: sales, expenses, bills, payments, invoices and stock, with reports built from them.',
    lines.length ? `Turned on for this book:\n${lines.join('\n')}` : 'No optional workflows are turned on for this book yet.',
    'You can also ask me for a report, or what a customer or supplier owes.',
  ].join('\n\n');
}

/** Runs one read tool. Throws nothing the caller cannot show to a user. */
export async function runReadTool(call: LedgrOnDeviceToolCall): Promise<string> {
  const args = call.arguments || {};
  try {
    switch (call.name as ReadToolName) {
      case 'party_lookup': return await partyLookup(args);
      case 'report_query': return await reportQuery(args);
      case 'inventory_profit': return await inventoryProfit();
      case 'describe_capabilities': return await describeCapabilities();
      default: return '';
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return `I could not read that from your books: ${message}`;
  }
}
