import type { SqlRunner } from '../../db/schema';
import type { V2ActiveContext } from '../appService';

export type WorkflowStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'posted' | 'failed';
export type WorkflowInput = {
  actionType: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  preview: string;
  requestedBy?: string;
  confidence?: number;
};
export type WorkflowRow = {
  id: string;
  bookId: string;
  actionType: string;
  idempotencyKey: string;
  status: WorkflowStatus;
  payload: Record<string, unknown>;
  preview: string;
  requestedBy: string;
  confidence: number | null;
  createdAt: string;
  submittedAt: string | null;
  approvedAt: string | null;
  postedAt: string | null;
  rejectedAt: string | null;
  sourceId: string | null;
  error: string | null;
};

const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value && typeof value === 'object' ? value : {});
const parse = <T>(value: string | null | undefined, fallback: T): T => { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } };

export class ControlDomainService {
  constructor(private readonly db: SqlRunner, private readonly context: (date?: string) => Promise<V2ActiveContext | null>) {}

  private async requireContext() {
    const context = await this.context();
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    return context;
  }

  private row(row: any): WorkflowRow {
    return {
      id: row.id, bookId: row.book_id, actionType: row.action_type, idempotencyKey: row.idempotency_key,
      status: row.status, payload: parse(row.payload, {}), preview: row.preview, requestedBy: row.requested_by,
      confidence: row.confidence == null ? null : Number(row.confidence), createdAt: row.created_at,
      submittedAt: row.submitted_at, approvedAt: row.approved_at, postedAt: row.posted_at,
      rejectedAt: row.rejected_at, sourceId: row.source_id, error: row.error,
    };
  }

  private async audit(bookId: string, workflowId: string | null, eventType: string, actor: string, payload: Record<string, unknown> = {}) {
    await this.db.run('INSERT INTO v2_audit_events(id,book_id,workflow_id,event_type,actor,payload,created_at) VALUES(?,?,?,?,?,?,?)', [uid('audit'), bookId, workflowId, eventType, actor, json(payload), now()]);
  }

  async createDraft(input: WorkflowInput) {
    const context = await this.requireContext();
    const key = String(input.idempotencyKey || '').trim();
    if (!key) throw new Error('Workflow idempotency key is required');
    const existing = await this.db.first<any>('SELECT * FROM v2_workflows WHERE book_id=? AND idempotency_key=?', [context.bookId, key]);
    if (existing) return this.row(existing);
    const id = uid('workflow');
    const createdAt = now();
    await this.db.run('INSERT INTO v2_workflows(id,book_id,action_type,idempotency_key,status,payload,preview,requested_by,confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', [id, context.bookId, input.actionType, key, 'draft', json(input.payload), input.preview, input.requestedBy || 'user', input.confidence == null ? null : Math.max(0, Math.min(1, Number(input.confidence))), createdAt]);
    await this.audit(context.bookId, id, 'workflow_draft_created', input.requestedBy || 'user', { actionType: input.actionType, preview: input.preview });
    return this.getWorkflow(id);
  }

  async submit(id: string, actor = 'user') {
    const workflow = await this.requireWorkflow(id);
    if (workflow.status !== 'draft') throw new Error(`Only draft workflows can be submitted; current status is ${workflow.status}`);
    const timestamp = now();
    await this.db.run("UPDATE v2_workflows SET status='submitted',submitted_at=? WHERE id=?", [timestamp, id]);
    await this.audit(workflow.bookId, id, 'workflow_submitted', actor);
    return this.getWorkflow(id);
  }

  async approve(id: string, actor = 'user') {
    const workflow = await this.requireWorkflow(id);
    if (!['draft', 'submitted'].includes(workflow.status)) throw new Error(`Only draft or submitted workflows can be approved; current status is ${workflow.status}`);
    const timestamp = now();
    await this.db.run("UPDATE v2_workflows SET status='approved',approved_at=? WHERE id=?", [timestamp, id]);
    await this.audit(workflow.bookId, id, 'workflow_approved', actor, { confirmation: true });
    return this.getWorkflow(id);
  }

  async reject(id: string, actor = 'user', reason = 'Rejected by user') {
    const workflow = await this.requireWorkflow(id);
    if (['posted', 'rejected'].includes(workflow.status)) throw new Error(`Workflow cannot be rejected from ${workflow.status}`);
    const timestamp = now();
    await this.db.run("UPDATE v2_workflows SET status='rejected',rejected_at=?,error=? WHERE id=?", [timestamp, reason, id]);
    await this.audit(workflow.bookId, id, 'workflow_rejected', actor, { reason });
    return this.getWorkflow(id);
  }

  async markPosted(id: string, sourceId?: string, actor = 'system') {
    const workflow = await this.requireWorkflow(id);
    if (!['approved', 'submitted', 'draft'].includes(workflow.status)) throw new Error(`Only an unposted workflow can be marked posted; current status is ${workflow.status}`);
    const timestamp = now();
    await this.db.run("UPDATE v2_workflows SET status='posted',posted_at=?,source_id=? WHERE id=?", [timestamp, sourceId || null, id]);
    await this.audit(workflow.bookId, id, 'workflow_posted', actor, { sourceId: sourceId || null });
    return this.getWorkflow(id);
  }

  async markFailed(id: string, error: string, actor = 'system') {
    const workflow = await this.requireWorkflow(id);
    await this.db.run("UPDATE v2_workflows SET status='failed',error=? WHERE id=?", [String(error || 'Workflow execution failed').slice(0, 2000), id]);
    await this.audit(workflow.bookId, id, 'workflow_failed', actor, { error });
    return this.getWorkflow(id);
  }

  async getWorkflow(id: string) {
    const row = await this.db.first<any>('SELECT * FROM v2_workflows WHERE id=?', [id]);
    if (!row) throw new Error('Workflow not found');
    return this.row(row);
  }

  private async requireWorkflow(id: string) {
    return this.getWorkflow(id);
  }

  async listWorkflows(status?: WorkflowStatus) {
    const context = await this.requireContext();
    const rows = status
      ? await this.db.all<any>('SELECT * FROM v2_workflows WHERE book_id=? AND status=? ORDER BY created_at DESC', [context.bookId, status])
      : await this.db.all<any>('SELECT * FROM v2_workflows WHERE book_id=? ORDER BY created_at DESC', [context.bookId]);
    return rows.map((row) => this.row(row));
  }

  async auditEvents(workflowId?: string) {
    const context = await this.requireContext();
    return workflowId
      ? this.db.all('SELECT * FROM v2_audit_events WHERE book_id=? AND workflow_id=? ORDER BY created_at', [context.bookId, workflowId])
      : this.db.all('SELECT * FROM v2_audit_events WHERE book_id=? ORDER BY created_at DESC LIMIT 500', [context.bookId]);
  }

  async enqueueSync(input: { provider: string; kind: string; idempotencyKey: string; payload: Record<string, unknown> }) {
    const context = await this.requireContext();
    const existing = await this.db.first<any>('SELECT * FROM v2_sync_queue WHERE book_id=? AND provider=? AND idempotency_key=?', [context.bookId, input.provider, input.idempotencyKey]);
    if (existing) return existing;
    const timestamp = now();
    const id = uid('sync');
    await this.db.run('INSERT INTO v2_sync_queue(id,book_id,provider,kind,idempotency_key,payload,status,attempts,next_attempt_at,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [id, context.bookId, input.provider, input.kind, input.idempotencyKey, json(input.payload), 'pending', 0, timestamp, null, timestamp, timestamp]);
    return this.db.first('SELECT * FROM v2_sync_queue WHERE id=?', [id]);
  }

  async listPendingSync() {
    const context = await this.requireContext();
    return this.db.all("SELECT * FROM v2_sync_queue WHERE book_id=? AND status IN ('pending','retry') ORDER BY created_at", [context.bookId]);
  }

  async upsertIntegration(input: { provider: string; kind: string; displayName: string; enabled?: boolean; config?: Record<string, unknown> }) {
    const context = await this.requireContext();
    const timestamp = now();
    const id = uid('integration');
    await this.db.run(`INSERT INTO v2_integrations(id,book_id,provider,kind,display_name,enabled,config,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(book_id,provider,kind) DO UPDATE SET display_name=excluded.display_name,enabled=excluded.enabled,config=excluded.config,updated_at=excluded.updated_at`, [id, context.bookId, input.provider, input.kind, input.displayName, input.enabled ? 1 : 0, json(input.config), timestamp, timestamp]);
    return this.db.first('SELECT * FROM v2_integrations WHERE book_id=? AND provider=? AND kind=?', [context.bookId, input.provider, input.kind]);
  }

  async listIntegrations() {
    const context = await this.requireContext();
    return this.db.all('SELECT id,book_id,provider,kind,display_name,enabled,created_at,updated_at FROM v2_integrations WHERE book_id=? ORDER BY display_name', [context.bookId]);
  }

  async upsertTaxProfile(input: { countryCode: string; taxLabel: string; defaultRate?: number; registration?: string; config?: Record<string, unknown> }) {
    const context = await this.requireContext();
    const existing = await this.db.first<{ id: string }>('SELECT id FROM v2_tax_profiles WHERE book_id=? AND country_code=?', [context.bookId, input.countryCode]);
    const id = existing?.id || uid('tax_profile');
    await this.db.run(`INSERT INTO v2_tax_profiles(id,book_id,country_code,tax_label,default_rate,registration,config,active)
      VALUES(?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET tax_label=excluded.tax_label,default_rate=excluded.default_rate,registration=excluded.registration,config=excluded.config,active=1`, [id, context.bookId, input.countryCode.toUpperCase(), input.taxLabel, Math.max(0, Number(input.defaultRate || 0)), input.registration || null, json(input.config)]);
    return this.db.first('SELECT * FROM v2_tax_profiles WHERE id=?', [id]);
  }

  async listTaxProfiles() {
    const context = await this.requireContext();
    return this.db.all('SELECT * FROM v2_tax_profiles WHERE book_id=? AND active=1 ORDER BY country_code', [context.bookId]);
  }

  async importBankFeedRows(provider: string, rows: { externalId: string; date: string; amount: number; currency?: string; description?: string; rawMetadata?: Record<string, unknown> }[]) {
    const context = await this.requireContext();
    let inserted = 0;
    for (const row of rows) {
      if (!String(row.externalId || '').trim()) continue;
      const before = await this.db.first('SELECT id FROM v2_bank_feed_entries WHERE book_id=? AND provider=? AND external_id=?', [context.bookId, provider, row.externalId]);
      await this.db.run(`INSERT INTO v2_bank_feed_entries(id,book_id,provider,external_id,date,amount,currency,description,status,raw_metadata)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(book_id,provider,external_id) DO UPDATE SET date=excluded.date,amount=excluded.amount,currency=excluded.currency,description=excluded.description,raw_metadata=excluded.raw_metadata`, [uid('bank_feed'), context.bookId, provider, row.externalId, row.date, Number(row.amount || 0), row.currency || 'USD', row.description || null, 'unmatched', json(row.rawMetadata)]);
      if (!before) inserted += 1;
    }
    return { inserted, total: rows.length };
  }

  async listBankFeedEntries(status?: string) {
    const context = await this.requireContext();
    return status ? this.db.all('SELECT * FROM v2_bank_feed_entries WHERE book_id=? AND status=? ORDER BY date DESC', [context.bookId, status]) : this.db.all('SELECT * FROM v2_bank_feed_entries WHERE book_id=? ORDER BY date DESC', [context.bookId]);
  }

  async createBudget(input: { name: string; periodStart: string; periodEnd: string; metadata?: Record<string, unknown> }) {
    const context = await this.requireContext();
    if (!String(input.name || '').trim()) throw new Error('Budget name is required');
    if (input.periodStart > input.periodEnd) throw new Error('Budget start date must not be after the end date');
    const id = uid('budget');
    await this.db.run('INSERT INTO v2_budgets(id,book_id,name,period_start,period_end,status,metadata) VALUES(?,?,?,?,?,?,?)', [id, context.bookId, input.name.trim(), input.periodStart, input.periodEnd, 'draft', json(input.metadata)]);
    await this.audit(context.bookId, null, 'budget_created', 'user', { budgetId: id, name: input.name.trim() });
    return this.db.first('SELECT * FROM v2_budgets WHERE id=?', [id]);
  }

  async addBudgetLine(input: { budgetId: string; accountCode: string; amount: number; locationId?: string }) {
    const context = await this.requireContext();
    const budget = await this.db.first<{ id: string }>('SELECT id FROM v2_budgets WHERE id=? AND book_id=?', [input.budgetId, context.bookId]);
    if (!budget) throw new Error('Budget was not found');
    const account = await this.db.first<{ id: string }>('SELECT id FROM v2_accounts WHERE book_id=? AND code=? AND active=1', [context.bookId, input.accountCode]);
    if (!account) throw new Error(`Account code ${input.accountCode} is not available in this book`);
    const id = uid('budget_line');
    await this.db.run('INSERT INTO v2_budget_lines(id,budget_id,account_code,location_id,amount) VALUES(?,?,?,?,?)', [id, budget.id, input.accountCode, input.locationId || null, Math.max(0, Number(input.amount || 0))]);
    return this.db.first('SELECT * FROM v2_budget_lines WHERE id=?', [id]);
  }

  async listBudgets() {
    const context = await this.requireContext();
    return this.db.all(`SELECT b.*,COALESCE(SUM(l.amount),0) AS budget_total,COUNT(l.id) AS line_count
      FROM v2_budgets b LEFT JOIN v2_budget_lines l ON l.budget_id=b.id
      WHERE b.book_id=? GROUP BY b.id ORDER BY b.period_start DESC`, [context.bookId]);
  }

  async budgetVariance(budgetId: string) {
    const context = await this.requireContext();
    const budget = await this.db.first<{ id: string; period_start: string; period_end: string }>('SELECT id,period_start,period_end FROM v2_budgets WHERE id=? AND book_id=?', [budgetId, context.bookId]);
    if (!budget) throw new Error('Budget was not found');
    return this.db.all(`SELECT l.account_code,l.amount AS budget_amount,
      COALESCE((SELECT SUM(jl.debit-jl.credit) FROM v2_accounts a JOIN v2_journal_lines jl ON jl.account_id=a.id JOIN v2_journal_entries j ON j.id=jl.journal_id WHERE a.book_id=? AND a.code=l.account_code AND j.date BETWEEN ? AND ?),0) AS actual_amount
      FROM v2_budget_lines l WHERE l.budget_id=? ORDER BY l.account_code`, [context.bookId, budget.period_start, budget.period_end, budget.id]);
  }

  async createRecurringTemplate(input: { actionType: string; frequency: 'weekly' | 'monthly' | 'quarterly' | 'annual'; nextDate: string; payload?: Record<string, unknown> }) {
    const context = await this.requireContext();
    if (!String(input.actionType || '').trim()) throw new Error('Recurring action type is required');
    const id = uid('recurring');
    await this.db.run('INSERT INTO v2_recurring_templates(id,book_id,action_type,frequency,next_date,payload,enabled,metadata) VALUES(?,?,?,?,?,?,1,?)', [id, context.bookId, input.actionType, input.frequency, input.nextDate, json(input.payload), json({ userSide: true })]);
    await this.audit(context.bookId, null, 'recurring_template_created', 'user', { templateId: id, actionType: input.actionType });
    return this.db.first('SELECT * FROM v2_recurring_templates WHERE id=?', [id]);
  }

  async listRecurringTemplates() {
    const context = await this.requireContext();
    return this.db.all('SELECT * FROM v2_recurring_templates WHERE book_id=? AND enabled=1 ORDER BY next_date', [context.bookId]);
  }
}

export default ControlDomainService;
