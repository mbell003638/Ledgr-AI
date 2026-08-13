import type { SqlRunner } from '../../db/schema';
import { V2SqlRepository } from '../repository';
import { V2_ACCOUNT_CODES, type V2Source } from '../types';
import { round2 } from '../../money';
import { isOptionalModuleEnabled, requireOptionalModule } from '../optionalModules';

const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
const cents = round2;

const CATEGORIES = new Set(['equipment', 'vehicle', 'computer', 'other'] as const);
const FUNDING = new Set(['cash', 'bank', 'loan'] as const);

export type FixedAssetCategory = 'equipment' | 'vehicle' | 'computer' | 'other';
export type FixedAssetFunding = 'cash' | 'bank' | 'loan';

export type AcquireAssetInput = {
  name: string;
  category: FixedAssetCategory;
  date: string;
  cost: number;
  residual?: number;
  usefulLifeMonths: number;
  funding: FixedAssetFunding;
  notes?: string;
};

export type PostDepreciationInput = { assetId: string; date: string };
export type DisposeAssetInput = { assetId: string; date: string };

type AssetRow = {
  id: string;
  book_id: string;
  name: string;
  category: string;
  acquired_date: string;
  cost: number;
  residual: number;
  useful_life_months: number;
  method: string;
  disposed: number;
  source_id: string | null;
  accum: number;
};

function fundingCode(funding: FixedAssetFunding) {
  if (funding === 'bank') return V2_ACCOUNT_CODES.BANK;
  if (funding === 'loan') return V2_ACCOUNT_CODES.OTHER_LIABILITIES;
  return V2_ACCOUNT_CODES.CASH;
}

export class FixedAssetDomainService {
  constructor(
    readonly db: SqlRunner,
    readonly repo: V2SqlRepository,
    private readonly getActiveContext: (date?: string) => Promise<{ bookId: string; periodId: string } | null>,
  ) {}

  async listAssets() {
    const context = await this.getActiveContext();
    if (!context) return [];
    return (await this.loadAssets(context.bookId)).map((row) => this.toListItem(row));
  }

  async acquireAsset(input: AcquireAssetInput) {
    await this.requireModule();
    const context = await this.getActiveContext(input.date);
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');

    const name = String(input.name || '').trim();
    const category = input.category;
    const funding = input.funding;
    const cost = cents(input.cost);
    const residual = cents(input.residual ?? 0);
    const usefulLifeMonths = Number(input.usefulLifeMonths);
    if (!name) throw new Error('Asset name is required');
    if (!CATEGORIES.has(category)) throw new Error('Asset category must be equipment, vehicle, computer, or other');
    if (!FUNDING.has(funding)) throw new Error('Funding must be cash, bank, or loan');
    if (!Number.isFinite(cost) || cost <= 0) throw new Error('Asset cost must be positive');
    if (!Number.isFinite(residual) || residual < 0) throw new Error('Residual value must be non-negative');
    if (residual > cost) throw new Error('Residual value cannot exceed cost');
    if (!Number.isInteger(usefulLifeMonths) || usefulLifeMonths <= 0) throw new Error('Useful life must be a positive number of months');

    await this.repo.ensureDefaultAccounts(context.bookId);
    return this.repo.runInTransaction(async () => {
      const assetId = uid('asset');
      const source: V2Source = {
        id: uid('fixed_asset'),
        bookId: context.bookId,
        type: 'fixed_asset',
        date: input.date,
        metadata: {
          assetId,
          name,
          category,
          total: cost,
          residual,
          usefulLifeMonths,
          funding,
          notes: input.notes || '',
        },
      };
      const journal = await this.repo.postSourceJournal(source, {
        bookId: context.bookId,
        periodId: context.periodId,
        date: input.date,
        memo: input.notes?.trim() || `Acquire asset: ${name}`,
        lines: [
          { accountId: `${context.bookId}:account:${V2_ACCOUNT_CODES.FIXED_ASSETS}`, debit: cost, credit: 0, memo: name },
          { accountId: `${context.bookId}:account:${fundingCode(funding)}`, debit: 0, credit: cost, memo: name },
        ],
      });
      await this.db.run(
        'INSERT INTO v2_fixed_assets(id,book_id,name,category,acquired_date,cost,residual,useful_life_months,method,disposed,source_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        [assetId, context.bookId, name, category, input.date, cost, residual, usefulLifeMonths, 'straight_line', 0, source.id],
      );
      return {
        source,
        journal,
        asset: {
          id: assetId,
          bookId: context.bookId,
          name,
          category,
          acquiredDate: input.date,
          cost,
          residual,
          usefulLifeMonths,
          method: 'straight_line',
          disposed: false,
          sourceId: source.id,
          accumulatedDepreciation: 0,
          netBookValue: cost,
        },
      };
    });
  }

  async postDepreciation(input: PostDepreciationInput) {
    await this.requireModule();
    const context = await this.getActiveContext(input.date);
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');

    const asset = await this.loadAsset(context.bookId, input.assetId);
    if (!asset) throw new Error('Asset not found');
    if (asset.disposed) throw new Error('Asset has been disposed');

    const depreciable = cents(asset.cost - asset.residual);
    const remaining = cents(depreciable - asset.accum);
    if (remaining <= 0) throw new Error('Asset is fully depreciated');
    const monthly = asset.useful_life_months > 0 ? cents(depreciable / asset.useful_life_months) : 0;
    const amount = cents(Math.min(monthly, remaining));
    if (amount <= 0) throw new Error('Asset is fully depreciated');

    const month = String(input.date).slice(0, 7);
    const alreadyPosted = await this.db.first<{ id: string }>(
      'SELECT id FROM v2_asset_depreciation WHERE asset_id=? AND substr(date,1,7)=? LIMIT 1',
      [asset.id, month],
    );
    if (alreadyPosted) throw new Error('Depreciation already posted for this month');

    await this.repo.ensureDefaultAccounts(context.bookId);
    return this.repo.runInTransaction(async () => {
      const source: V2Source = {
        id: uid('depreciation'),
        bookId: context.bookId,
        type: 'depreciation',
        date: input.date,
        metadata: { assetId: asset.id, amount, total: amount },
      };
      const journal = await this.repo.postSourceJournal(source, {
        bookId: context.bookId,
        periodId: context.periodId,
        date: input.date,
        memo: `Depreciation: ${asset.name}`,
        lines: [
          { accountId: `${context.bookId}:account:${V2_ACCOUNT_CODES.DEPRECIATION_EXPENSE}`, debit: amount, credit: 0, memo: asset.name },
          { accountId: `${context.bookId}:account:${V2_ACCOUNT_CODES.ACCUM_DEPRECIATION}`, debit: 0, credit: amount, memo: asset.name },
        ],
      });
      const depreciationId = uid('depr');
      await this.db.run(
        'INSERT INTO v2_asset_depreciation(id,asset_id,date,amount,source_id) VALUES(?,?,?,?,?)',
        [depreciationId, asset.id, input.date, amount, source.id],
      );
      return { source, journal, amount, depreciationId };
    });
  }

  async disposeAsset(input: DisposeAssetInput) {
    await this.requireModule();
    const context = await this.getActiveContext(input.date);
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const asset = await this.loadAsset(context.bookId, input.assetId);
    if (!asset) throw new Error('Asset not found');
    if (asset.disposed) throw new Error('Asset has been disposed');

    const cost = cents(asset.cost);
    const accum = cents(asset.accum);
    const nbv = cents(cost - accum);

    await this.repo.ensureDefaultAccounts(context.bookId);
    return this.repo.runInTransaction(async () => {
      const writeOffCode = await this.writeOffExpenseCode(context.bookId);
      const acct = (code: string) => `${context.bookId}:account:${code}`;
      const lines = [
        accum > 0 ? { accountId: acct(V2_ACCOUNT_CODES.ACCUM_DEPRECIATION), debit: accum, credit: 0, memo: asset.name } : null,
        nbv > 0 ? { accountId: acct(writeOffCode), debit: nbv, credit: 0, memo: asset.name } : null,
        cost > 0 ? { accountId: acct(V2_ACCOUNT_CODES.FIXED_ASSETS), debit: 0, credit: cost, memo: asset.name } : null,
      ].filter((line): line is { accountId: string; debit: number; credit: number; memo: string } => !!line);

      const source: V2Source = {
        id: uid('asset_disposal'),
        bookId: context.bookId,
        type: 'asset_disposal',
        date: input.date,
        metadata: { assetId: asset.id, cost, accum, nbv, total: cost },
      };
      const journal = await this.repo.postSourceJournal(source, {
        bookId: context.bookId,
        periodId: context.periodId,
        date: input.date,
        memo: `Dispose asset: ${asset.name}`,
        lines,
      });
      await this.db.run('UPDATE v2_fixed_assets SET disposed=1 WHERE id=? AND book_id=?', [asset.id, context.bookId]);
      return { id: asset.id, disposed: true, date: input.date, source, journal };
    });
  }

  async assetRegister() {
    const context = await this.getActiveContext();
    if (!context) return [];
    return (await this.loadAssets(context.bookId)).map((row) => {
      const item = this.toListItem(row);
      const depreciable = cents(item.cost - item.residual);
      const monthly = item.usefulLifeMonths > 0 ? cents(depreciable / item.usefulLifeMonths) : 0;
      const remaining = cents(depreciable - item.accumulatedDepreciation);
      const remainingLifeMonths = item.disposed || remaining <= 0 || monthly <= 0 ? 0 : Math.ceil(remaining / monthly);
      return {
        ...item,
        accum: item.accumulatedDepreciation,
        nbv: item.netBookValue,
        remainingLifeMonths,
      };
    });
  }

  private async requireModule() {
    requireOptionalModule(await isOptionalModuleEnabled(this.db, 'fixedAssets'), 'fixedAssets');
  }

  private async writeOffExpenseCode(bookId: string) {
    const dep = await this.db.first('SELECT id FROM v2_accounts WHERE book_id=? AND code=?', [bookId, V2_ACCOUNT_CODES.DEPRECIATION_EXPENSE]);
    return dep ? V2_ACCOUNT_CODES.DEPRECIATION_EXPENSE : V2_ACCOUNT_CODES.EXPENSES;
  }

  private async loadAssets(bookId: string) {
    return this.db.all<AssetRow>(
      `SELECT a.id,a.book_id,a.name,a.category,a.acquired_date,a.cost,a.residual,a.useful_life_months,a.method,a.disposed,a.source_id,
              COALESCE((SELECT SUM(d.amount) FROM v2_asset_depreciation d WHERE d.asset_id=a.id),0) AS accum
       FROM v2_fixed_assets a WHERE a.book_id=? ORDER BY a.acquired_date,a.id`,
      [bookId],
    );
  }

  private async loadAsset(bookId: string, assetId: string) {
    return this.db.first<AssetRow>(
      `SELECT a.id,a.book_id,a.name,a.category,a.acquired_date,a.cost,a.residual,a.useful_life_months,a.method,a.disposed,a.source_id,
              COALESCE((SELECT SUM(d.amount) FROM v2_asset_depreciation d WHERE d.asset_id=a.id),0) AS accum
       FROM v2_fixed_assets a WHERE a.id=? AND a.book_id=?`,
      [assetId, bookId],
    );
  }

  private toListItem(row: AssetRow) {
    const cost = cents(row.cost);
    const accumulatedDepreciation = cents(row.accum);
    return {
      id: row.id,
      bookId: row.book_id,
      name: row.name,
      category: row.category,
      acquiredDate: row.acquired_date,
      cost,
      residual: cents(row.residual),
      usefulLifeMonths: Number(row.useful_life_months),
      method: row.method,
      disposed: Boolean(row.disposed),
      sourceId: row.source_id,
      accumulatedDepreciation,
      netBookValue: cents(cost - accumulatedDepreciation),
    };
  }
}
