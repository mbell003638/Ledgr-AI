import type { SqlRunner } from '../db/schema';
import { V2_TABLES } from '../db/schema';
import { hashPayload, type SyncSnapshot } from './protocol';

export const BOOK_PROJECTION_SCHEMA_VERSION = 2;
export type BookProjection = { schemaVersion: number; bookId: string; tables: Record<string, any[]> };

const CHILD_TABLES = new Set(['v2_journal_lines', 'v2_payslips', 'v2_asset_depreciation', 'v2_bom_lines', 'v2_budget_lines']);
const DIRECT_BOOK_TABLES = (V2_TABLES as readonly string[]).filter((table) => table !== 'v2_books' && !CHILD_TABLES.has(table));

const INSERT_ORDER = [
  'v2_books', 'v2_periods', 'v2_personas', 'v2_parties', 'v2_accounts', 'v2_locations', 'v2_sources',
  'v2_journal_entries', 'v2_journal_lines', 'v2_invoice_allocations', 'v2_inventory_counts', 'v2_members', 'v2_close_books',
  'v2_employees', 'v2_pay_runs', 'v2_payslips', 'v2_fixed_assets', 'v2_asset_depreciation', 'v2_products', 'v2_stock_moves',
  'v2_marketplace_orders', 'v2_marketplace_settlements', 'v2_projects', 'v2_project_entries', 'v2_creator_contracts',
  'v2_creator_payouts', 'v2_boms', 'v2_bom_lines', 'v2_production_orders', 'v2_trade_shipments', 'v2_trade_costs',
  'v2_workflows', 'v2_audit_events', 'v2_sync_queue', 'v2_integrations', 'v2_sync_state', 'v2_tax_profiles',
  'v2_budgets', 'v2_budget_lines', 'v2_recurring_templates', 'v2_bank_feed_entries',
] as const;
const DELETE_ORDER = [...INSERT_ORDER].reverse();

function assertProjection(payload: any, bookId: string): asserts payload is BookProjection {
  if (!payload || typeof payload !== 'object' || payload.schemaVersion !== BOOK_PROJECTION_SCHEMA_VERSION || payload.bookId !== bookId || !payload.tables || typeof payload.tables !== 'object') throw new Error('Snapshot does not contain a compatible book projection');
  const expectedTables = [...V2_TABLES].sort();
  const receivedTables = Object.keys(payload.tables).sort();
  if (receivedTables.length !== expectedTables.length || receivedTables.some((table, index) => table !== expectedTables[index])) throw new Error('Snapshot projection contains an unknown or missing table');
  for (const table of V2_TABLES) if (!Array.isArray(payload.tables[table])) throw new Error(`Snapshot projection is missing table ${table}`);
  const books = payload.tables.v2_books;
  if (books.length !== 1 || String(books[0]?.id || '') !== bookId) throw new Error('Snapshot projection must contain exactly the enrolled Business Account');
  for (const table of DIRECT_BOOK_TABLES) for (const row of payload.tables[table]) if (String(row?.book_id || '') !== bookId) throw new Error(`Snapshot table ${table} contains another Business Account`);

  const ids = (table: string): Set<string> => new Set<string>(payload.tables[table].map((row: any) => String(row?.id || '')));
  const periods = ids('v2_periods'); const sources = ids('v2_sources'); const accounts = ids('v2_accounts');
  const parties = ids('v2_parties'); const locations = ids('v2_locations'); const journals = ids('v2_journal_entries');
  const products = ids('v2_products'); const employees = ids('v2_employees'); const payRuns = ids('v2_pay_runs'); const fixedAssets = ids('v2_fixed_assets');
  const boms = ids('v2_boms'); const projects = ids('v2_projects'); const contracts = ids('v2_creator_contracts');
  const shipments = ids('v2_trade_shipments'); const workflows = ids('v2_workflows');
  const requireOwned = (set: Set<string>, value: unknown, label: string, optional = false) => { const id = String(value || ''); if (!id && optional) return; if (!id || !set.has(id)) throw new Error(`Snapshot contains a cross-book or missing ${label}`); };

  for (const row of payload.tables.v2_sources) requireOwned(locations, row.location_id, 'source location', true);
  for (const row of payload.tables.v2_journal_entries) { requireOwned(periods, row.period_id, 'journal period'); requireOwned(sources, row.source_id, 'journal source', true); requireOwned(journals, row.reversal_of, 'reversal journal', true); }
  for (const row of payload.tables.v2_journal_lines) { requireOwned(journals, row.journal_id, 'journal'); requireOwned(accounts, row.account_id, 'journal account'); requireOwned(parties, row.party_id, 'journal party', true); requireOwned(locations, row.location_id, 'journal location', true); }
  for (const row of payload.tables.v2_invoice_allocations) { requireOwned(sources, row.invoice_source_id, 'allocation invoice'); requireOwned(sources, row.receipt_source_id, 'allocation receipt'); }
  for (const row of payload.tables.v2_inventory_counts) { requireOwned(periods, row.period_id, 'inventory-count period'); requireOwned(locations, row.location_id, 'inventory-count location', true); }
  for (const row of payload.tables.v2_close_books) { requireOwned(periods, row.period_id, 'close-book period'); requireOwned(journals, row.journal_id, 'close-book journal', true); }
  for (const row of payload.tables.v2_pay_runs) { requireOwned(periods, row.period_id, 'pay-run period'); requireOwned(sources, row.source_id, 'pay-run source', true); }
  for (const row of payload.tables.v2_payslips) { requireOwned(payRuns, row.pay_run_id, 'payslip pay run'); requireOwned(employees, row.employee_id, 'payslip employee'); }
  for (const row of payload.tables.v2_fixed_assets) requireOwned(sources, row.source_id, 'asset source', true);
  for (const row of payload.tables.v2_asset_depreciation) { requireOwned(fixedAssets, row.asset_id, 'depreciation asset'); requireOwned(sources, row.source_id, 'depreciation source', true); }
  for (const row of payload.tables.v2_stock_moves) { requireOwned(products, row.product_id, 'stock-move product'); requireOwned(sources, row.source_id, 'stock-move source', true); requireOwned(locations, row.location_id, 'stock-move location', true); }
  for (const row of payload.tables.v2_marketplace_orders) { requireOwned(sources, row.source_id, 'marketplace order source', true); requireOwned(parties, row.customer_id, 'marketplace order customer', true); requireOwned(parties, row.supplier_id, 'marketplace order supplier', true); }
  for (const row of payload.tables.v2_marketplace_settlements) { requireOwned(accounts, row.settlement_account_id, 'settlement account'); requireOwned(sources, row.source_id, 'settlement source', true); }
  for (const row of payload.tables.v2_projects) requireOwned(parties, row.party_id, 'project party', true);
  for (const row of payload.tables.v2_project_entries) { requireOwned(projects, row.project_id, 'project entry project'); requireOwned(sources, row.source_id, 'project entry source', true); }
  for (const row of payload.tables.v2_creator_contracts) { requireOwned(parties, row.party_id, 'creator contract party', true); requireOwned(sources, row.source_id, 'creator contract source', true); }
  for (const row of payload.tables.v2_creator_payouts) { requireOwned(contracts, row.contract_id, 'creator payout contract'); requireOwned(sources, row.source_id, 'creator payout source', true); }
  for (const row of payload.tables.v2_boms) requireOwned(products, row.product_id, 'BOM product');
  for (const row of payload.tables.v2_bom_lines) { requireOwned(boms, row.bom_id, 'BOM line BOM'); requireOwned(products, row.component_product_id, 'BOM component product'); }
  for (const row of payload.tables.v2_production_orders) { requireOwned(boms, row.bom_id, 'production BOM'); requireOwned(sources, row.source_id, 'production source', true); }
  for (const row of payload.tables.v2_trade_shipments) { requireOwned(parties, row.supplier_id, 'shipment supplier', true); requireOwned(parties, row.customer_id, 'shipment customer', true); }
  for (const row of payload.tables.v2_trade_costs) { requireOwned(shipments, row.shipment_id, 'trade-cost shipment'); requireOwned(sources, row.source_id, 'trade-cost source', true); }
  for (const row of payload.tables.v2_workflows) { requireOwned(sources, row.source_id, 'workflow source', true); }
  for (const row of payload.tables.v2_audit_events) requireOwned(workflows, row.workflow_id, 'audit workflow', true);
  for (const row of payload.tables.v2_bank_feed_entries) requireOwned(sources, row.matched_source_id, 'bank-feed matched source', true);
}

async function selectBookRows(db: SqlRunner, table: string, bookId: string): Promise<any[]> {
  if (table === 'v2_asset_depreciation') return db.all(`SELECT d.* FROM v2_asset_depreciation d JOIN v2_fixed_assets a ON a.id=d.asset_id WHERE a.book_id=? ORDER BY d.id`, [bookId]);
  if (table === 'v2_bom_lines') return db.all(`SELECT l.* FROM v2_bom_lines l JOIN v2_boms b ON b.id=l.bom_id WHERE b.book_id=? ORDER BY l.id`, [bookId]);
  if (table === 'v2_budget_lines') return db.all(`SELECT l.* FROM v2_budget_lines l JOIN v2_budgets b ON b.id=l.budget_id WHERE b.book_id=? ORDER BY l.id`, [bookId]);
  return db.all(`SELECT * FROM ${table} WHERE book_id=? ORDER BY id`, [bookId]);
}

export async function exportBookProjection(db: SqlRunner, bookId: string): Promise<BookProjection> {
  const tables: Record<string, any[]> = {};
  tables.v2_books = await db.all('SELECT * FROM v2_books WHERE id=? ORDER BY id', [bookId]);
  for (const table of DIRECT_BOOK_TABLES) tables[table] = await selectBookRows(db, table, bookId);
  tables.v2_journal_lines = await db.all('SELECT l.* FROM v2_journal_lines l JOIN v2_journal_entries j ON j.id=l.journal_id WHERE j.book_id=? ORDER BY l.journal_id,l.account_id,COALESCE(l.party_id,\'\'),l.debit,l.credit,COALESCE(l.memo,\'\'),COALESCE(l.location_id,\'\')', [bookId]);
  tables.v2_payslips = await db.all('SELECT s.* FROM v2_payslips s JOIN v2_pay_runs r ON r.id=s.pay_run_id WHERE r.book_id=? ORDER BY s.id', [bookId]);
  tables.v2_asset_depreciation = await selectBookRows(db, 'v2_asset_depreciation', bookId);
  tables.v2_bom_lines = await selectBookRows(db, 'v2_bom_lines', bookId);
  tables.v2_budget_lines = await selectBookRows(db, 'v2_budget_lines', bookId);
  const projection = { schemaVersion: BOOK_PROJECTION_SCHEMA_VERSION, bookId, tables };
  assertProjection(projection, bookId);
  return projection;
}

const NON_SEMANTIC_PROJECTION_COLUMNS = new Set(['created_at', 'updated_at', 'posted_at', 'closed_at']);
function semanticProjection(projection: BookProjection): BookProjection { const tables = Object.fromEntries(Object.entries(projection.tables).map(([table, rows]) => [table, rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !NON_SEMANTIC_PROJECTION_COLUMNS.has(key))))])); return { ...projection, tables }; }
export async function hashBookProjection(db: SqlRunner, bookId: string): Promise<string> { return hashPayload(semanticProjection(await exportBookProjection(db, bookId))); }

async function preflightColumns(db: SqlRunner, projection: BookProjection): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  for (const table of INSERT_ORDER) {
    const columns = (await db.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((item) => item.name);
    if (!columns.length) throw new Error(`Snapshot target table is unavailable: ${table}`);
    const known = new Set(columns);
    for (const row of projection.tables[table]) { if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`Snapshot table ${table} contains an invalid row`); for (const key of Object.keys(row)) if (!known.has(key)) throw new Error(`Snapshot requires unsupported column ${table}.${key}`); }
    result.set(table, columns);
  }
  return result;
}

async function deleteBookProjection(db: SqlRunner, bookId: string): Promise<void> {
  for (const table of DELETE_ORDER) {
    if (table === 'v2_journal_lines') { await db.run('DELETE FROM v2_journal_lines WHERE journal_id IN (SELECT id FROM v2_journal_entries WHERE book_id=?)', [bookId]); continue; }
    if (table === 'v2_payslips') { await db.run('DELETE FROM v2_payslips WHERE pay_run_id IN (SELECT id FROM v2_pay_runs WHERE book_id=?)', [bookId]); continue; }
    if (table === 'v2_asset_depreciation') { await db.run('DELETE FROM v2_asset_depreciation WHERE asset_id IN (SELECT id FROM v2_fixed_assets WHERE book_id=?)', [bookId]); continue; }
    if (table === 'v2_bom_lines') { await db.run('DELETE FROM v2_bom_lines WHERE bom_id IN (SELECT id FROM v2_boms WHERE book_id=?)', [bookId]); continue; }
    if (table === 'v2_budget_lines') { await db.run('DELETE FROM v2_budget_lines WHERE budget_id IN (SELECT id FROM v2_budgets WHERE book_id=?)', [bookId]); continue; }
    if (table === 'v2_journal_entries') await db.run('UPDATE v2_journal_entries SET reversal_of=NULL WHERE book_id=?', [bookId]);
    const clause = table === 'v2_books' ? 'id=?' : 'book_id=?';
    await db.run(`DELETE FROM ${table} WHERE ${clause}`, [bookId]);
  }
}

async function insertRows(db: SqlRunner, table: string, rows: any[], columns: string[]): Promise<void> {
  const ordered = table === 'v2_journal_entries' ? [...rows].sort((a, b) => Number(Boolean(a?.reversal_of)) - Number(Boolean(b?.reversal_of))) : rows;
  const allowed = new Set(columns);
  for (const row of ordered) { const keys = Object.keys(row).filter((key) => allowed.has(key)); if (!keys.length) throw new Error(`Snapshot row for ${table} has no supported columns`); await db.run(`INSERT INTO ${table}(${keys.map((key) => `"${key}"`).join(',')}) VALUES(${keys.map(() => '?').join(',')})`, keys.map((key) => row[key])); }
}

export async function installBookProjection(db: SqlRunner, payload: unknown, snapshot: SyncSnapshot): Promise<void> {
  assertProjection(payload, snapshot.bookId);
  const columns = await preflightColumns(db, payload);
  await deleteBookProjection(db, snapshot.bookId);
  for (const table of INSERT_ORDER) await insertRows(db, table, payload.tables[table], columns.get(table) || []);
  await db.run("INSERT INTO meta(key,value) VALUES('v2_active_book_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [snapshot.bookId]);
}
