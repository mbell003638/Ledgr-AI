export type ExperimentalModuleStatus = 'preview_only' | 'blocked';

export type ExperimentalModuleDefinition = {
  key: 'bank_import_preview' | 'manufacturing' | 'trade_landed_cost' | 'marketplace' | 'projects' | 'fixed_assets';
  label: string;
  summary: string;
  status: ExperimentalModuleStatus;
  route?: string;
  safeguards: string[];
  missingBeforeProduction: string[];
};

export const EXPERIMENTAL_MODULES: ExperimentalModuleDefinition[] = [
  {
    key: 'bank_import_preview', label: 'Bank Statement Preview', status: 'preview_only', route: '/bank-import-preview',
    summary: 'Read a CSV locally, normalize rows and flag duplicates without creating transactions.',
    safeguards: ['No ledger posting API', 'No automatic matching', 'Preview is discarded when the screen closes'],
    missingBeforeProduction: ['Persistent staging with migration support', 'Account mapping and reconciliation', 'Explicit reviewed posting commands', 'Rollback and sync coverage'],
  },
  {
    key: 'manufacturing', label: 'Manufacturing & BOM', status: 'blocked',
    summary: 'Component consumption, work in progress and finished-goods costing.',
    safeguards: ['Not registered as an enabled workflow', 'No production route'],
    missingBeforeProduction: ['Cost-flow design', 'Inventory valuation proof', 'Reversal behavior', 'Close-books, backup and sync coverage'],
  },
  {
    key: 'trade_landed_cost', label: 'Trade & Landed Cost', status: 'blocked',
    summary: 'Freight, duty, exchange rates and capitalized landed costs.',
    safeguards: ['No production route', 'No account creation or posting changes'],
    missingBeforeProduction: ['FX policy', 'Allocation rules', 'Tax treatment', 'Remeasurement and reversal tests'],
  },
  {
    key: 'marketplace', label: 'Marketplace Settlement', status: 'blocked',
    summary: 'Marketplace fees, returns, reserves and settlement reconciliation.',
    safeguards: ['No production route', 'No external connector'],
    missingBeforeProduction: ['Provider contracts', 'Duplicate settlement protection', 'Fee/return accounting', 'Reconciliation and rollback'],
  },
  {
    key: 'projects', label: 'Project Accounting', status: 'blocked',
    summary: 'Project income, costs, budgets and profitability.',
    safeguards: ['No production route', 'Existing invoices and expenses remain authoritative'],
    missingBeforeProduction: ['Project dimension design', 'Allocation rules', 'Reporting contracts', 'Migration and sync coverage'],
  },
  {
    key: 'fixed_assets', label: 'Fixed Asset Register', status: 'blocked',
    summary: 'Asset schedules, depreciation and disposals.',
    safeguards: ['Existing Assets & Liabilities remains authoritative', 'No duplicate depreciation postings'],
    missingBeforeProduction: ['Asset-register schema', 'Depreciation policy', 'Disposal/reversal flow', 'Tax and close-books coverage'],
  },
];

export const previewModules = () => EXPERIMENTAL_MODULES.filter((module) => module.status === 'preview_only');
export const blockedModules = () => EXPERIMENTAL_MODULES.filter((module) => module.status === 'blocked');
