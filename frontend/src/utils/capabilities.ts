export type PersonaId =
  | 'mobile_invoicing'
  | 'dropshipper'
  | 'marketplace_seller'
  | 'entrepreneur'
  | 'startup'
  | 'developer'
  | 'content_creator'
  | 'manufacturer'
  | 'import_export'
  | 'saas'
  | 'ecommerce'
  | 'agency'
  | 'accounting_practice'
  | 'small_business'
  | 'solo_founder'
  | 'restaurant'
  | 'healthcare'
  | 'education'
  | 'legal'
  | 'nonprofit'
  | 'real_estate'
  | 'construction'
  | 'agriculture'
  | 'automotive'
  | 'hospitality'
  | 'personal'
  | 'retail'
  | 'wholesale'
  | 'salon'
  | 'handyman'
  | 'professional_service'
  | 'it_freelancer'
  | 'vendor'
  | 'custom';

export type CapabilityKey =
  | 'core_ledger'
  | 'invoicing'
  | 'commerce'
  | 'procurement'
  | 'customers'
  | 'inventory'
  | 'marketplace'
  | 'shipping_returns'
  | 'projects'
  | 'creator_revenue'
  | 'manufacturing'
  | 'trade_landed_cost'
  | 'cogs_margin'
  | 'growth_analytics'
  | 'reconciliation'
  | 'cashbook'
  | 'reporting'
  | 'ai_assistant'
  | 'voice_assistant'
  | 'payroll'
  | 'fixed_assets'
  | 'multi_location';

export type MetricKey = 'cac' | 'cogs' | 'gross_margin' | 'peg' | 'rto' | 'roi' | 'roe';

export type CapabilityDefinition = {
  key: CapabilityKey;
  label: string;
  description: string;
  featureKeys: string[];
  routes: string[];
  metrics?: MetricKey[];
};

export const CORE_CAPABILITIES: CapabilityKey[] = ['core_ledger', 'cashbook', 'reporting'];

export const CAPABILITIES: CapabilityDefinition[] = [
  { key: 'core_ledger', label: 'Core accounting', description: 'Cash, parties, expenses, reports, backup, and book controls.', featureKeys: ['expenses', 'assets', 'daybook'], routes: ['/expenses', '/assets', '/daybook'], metrics: ['roe'] },
  { key: 'invoicing', label: 'Mobile invoicing', description: 'Invoices, receipts, quotes, due dates, and customer balances.', featureKeys: ['invoices', 'receipts', 'quotes'], routes: ['/invoices', '/receipts', '/quotes'], metrics: ['roi'] },
  { key: 'commerce', label: 'Sales and commerce', description: 'Cash sales, products, customers, and commercial orders.', featureKeys: ['sales'], routes: ['/sales', '/sale-form'] },
  { key: 'procurement', label: 'Purchases and suppliers', description: 'Supplier bills, purchase payments, and payable tracking.', featureKeys: ['bills', 'payments'], routes: ['/bills', '/payments'] },
  { key: 'customers', label: 'Customer accounts', description: 'Customer records, receivables, and collection history.', featureKeys: ['receipts'], routes: ['/suppliers', '/debtors'] },
  { key: 'inventory', label: 'Inventory and products', description: 'Stock counts, products, stock value, and inventory controls.', featureKeys: ['inventory', 'perpetualInventory'], routes: ['/inventory-form', '/products'], metrics: ['cogs', 'gross_margin'] },
  { key: 'marketplace', label: 'Marketplace operations', description: 'Marketplace orders, fees, settlement payouts, and refunds.', featureKeys: ['sales', 'invoices', 'receipts'], routes: ['/sales', '/reconcile', '/marketplace'], metrics: ['cogs', 'gross_margin', 'rto', 'roi'] },
  { key: 'shipping_returns', label: 'Shipping and returns', description: 'Dispatch, delivery, returns, and return-to-origin tracking.', featureKeys: ['delivery'], routes: ['/delivery-notes'], metrics: ['rto'] },
  { key: 'projects', label: 'Projects and billable work', description: 'Client projects, billable work, estimates, and project profitability.', featureKeys: ['invoices', 'quotes', 'expenses'], routes: ['/invoices', '/quotes', '/projects'], metrics: ['roi', 'gross_margin'] },
  { key: 'creator_revenue', label: 'Creator revenue', description: 'Brand deals, sponsorship invoices, platform payouts, and campaign costs.', featureKeys: ['invoices', 'receipts', 'expenses'], routes: ['/invoices', '/receipts', '/projects'], metrics: ['roi'] },
  { key: 'manufacturing', label: 'Manufacturing', description: 'Materials, production work, finished goods, and unit-cost tracking.', featureKeys: ['inventory', 'perpetualInventory', 'bills'], routes: ['/inventory-form', '/products', '/bills'], metrics: ['cogs', 'gross_margin', 'roi', 'roe'] },
  { key: 'trade_landed_cost', label: 'Import and export trade', description: 'Shipments, freight, duties, foreign currency, and landed cost.', featureKeys: ['bills', 'inventory', 'invoices', 'delivery'], routes: ['/bills', '/inventory-form', '/invoices', '/delivery-notes'], metrics: ['cogs', 'gross_margin', 'rto', 'roi', 'roe'] },
  { key: 'cogs_margin', label: 'COGS and gross margin', description: 'Cost of goods sold, gross profit, and margin by period or workflow.', featureKeys: ['inventory', 'reports', 'monthly'], routes: ['/reports', '/monthly-summary'], metrics: ['cogs', 'gross_margin'] },
  { key: 'growth_analytics', label: 'Growth analytics', description: 'Acquisition cost, operating efficiency, campaign returns, and investor metrics.', featureKeys: ['reports', 'monthly'], routes: ['/reports', '/monthly-summary', '/custom-report'], metrics: ['cac', 'roi', 'roe', 'peg'] },
  { key: 'reconciliation', label: 'Reconciliation', description: 'Match statements, payouts, receipts, and recorded ledger activity.', featureKeys: [], routes: ['/reconcile'] },
  { key: 'cashbook', label: 'Cash and bank', description: 'Manual cash movements, bank balances, and cash controls.', featureKeys: ['cashbook'], routes: ['/cashbook'] },
  { key: 'reporting', label: 'Financial reporting', description: 'Profit and Loss, Balance Sheet, Trial Balance, and summaries.', featureKeys: ['reports', 'monthly'], routes: ['/reports', '/monthly-summary', '/custom-report'] },
  { key: 'ai_assistant', label: 'AI assistance', description: 'Ask AI finance chat, OCR, reconciliation suggestions, and reviewable answers.', featureKeys: ['ask'], routes: ['/ask', '/scan-import'] },
  { key: 'voice_assistant', label: 'Voice AI Assistant', description: 'Record transactions by voice and review the draft before saving it.', featureKeys: ['voice'], routes: ['/voice'] },
  { key: 'payroll', label: 'Payroll', description: 'Employees, pay runs, payslips, and payroll reporting.', featureKeys: ['payroll'], routes: ['/payroll'] },
  { key: 'fixed_assets', label: 'Fixed assets', description: 'Equipment, vehicles, depreciation, and asset register.', featureKeys: ['fixedAssets'], routes: ['/fixed-assets'], metrics: ['roe'] },
  { key: 'multi_location', label: 'Multi-location retail', description: 'Stores, POS sessions, location-level sales, stock transfers, and consolidated reports.', featureKeys: ['sales', 'inventory', 'cashbook', 'reports', 'locations'], routes: ['/locations', '/pos-sessions', '/stock-transfers'], metrics: ['cogs', 'gross_margin', 'roi'] },
];

const PERSONA_DEFAULTS: Record<PersonaId, CapabilityKey[]> = {
  mobile_invoicing: ['core_ledger', 'invoicing', 'customers', 'commerce', 'reconciliation', 'ai_assistant'],
  dropshipper: ['core_ledger', 'commerce', 'procurement', 'inventory', 'marketplace', 'shipping_returns', 'cogs_margin', 'growth_analytics', 'reconciliation', 'ai_assistant'],
  marketplace_seller: ['core_ledger', 'commerce', 'procurement', 'inventory', 'marketplace', 'shipping_returns', 'cogs_margin', 'growth_analytics', 'reconciliation', 'ai_assistant'],
  entrepreneur: ['core_ledger', 'invoicing', 'commerce', 'customers', 'growth_analytics', 'reconciliation', 'ai_assistant'],
  startup: ['core_ledger', 'invoicing', 'commerce', 'customers', 'growth_analytics', 'reconciliation', 'ai_assistant'],
  developer: ['core_ledger', 'invoicing', 'customers', 'projects', 'growth_analytics', 'reconciliation', 'ai_assistant'],
  content_creator: ['core_ledger', 'invoicing', 'customers', 'creator_revenue', 'growth_analytics', 'reconciliation', 'ai_assistant'],
  manufacturer: ['core_ledger', 'commerce', 'procurement', 'inventory', 'manufacturing', 'cogs_margin', 'reconciliation', 'fixed_assets', 'ai_assistant'],
  import_export: ['core_ledger', 'invoicing', 'commerce', 'procurement', 'inventory', 'trade_landed_cost', 'shipping_returns', 'cogs_margin', 'reconciliation', 'ai_assistant'],
  saas: ['core_ledger', 'invoicing', 'commerce', 'customers', 'projects', 'growth_analytics', 'reconciliation', 'ai_assistant'],
  ecommerce: ['core_ledger', 'commerce', 'procurement', 'inventory', 'marketplace', 'shipping_returns', 'cogs_margin', 'growth_analytics', 'reconciliation', 'ai_assistant'],
  agency: ['core_ledger', 'invoicing', 'customers', 'projects', 'growth_analytics', 'reconciliation', 'ai_assistant'],
  accounting_practice: ['core_ledger', 'invoicing', 'customers', 'projects', 'growth_analytics', 'reconciliation', 'ai_assistant'],
  small_business: ['core_ledger', 'commerce', 'invoicing', 'procurement', 'customers', 'payroll', 'fixed_assets', 'reconciliation', 'ai_assistant'],
  solo_founder: ['core_ledger', 'invoicing', 'commerce', 'customers', 'growth_analytics', 'reconciliation', 'ai_assistant'],
  restaurant: ['core_ledger', 'commerce', 'procurement', 'inventory', 'manufacturing', 'cogs_margin', 'payroll', 'reconciliation', 'ai_assistant'],
  healthcare: ['core_ledger', 'invoicing', 'customers', 'procurement', 'payroll', 'fixed_assets', 'reconciliation', 'ai_assistant'],
  education: ['core_ledger', 'invoicing', 'customers', 'payroll', 'reporting', 'reconciliation', 'ai_assistant'],
  legal: ['core_ledger', 'invoicing', 'customers', 'projects', 'growth_analytics', 'reconciliation', 'ai_assistant'],
  nonprofit: ['core_ledger', 'invoicing', 'customers', 'growth_analytics', 'reporting', 'reconciliation', 'ai_assistant'],
  real_estate: ['core_ledger', 'invoicing', 'customers', 'fixed_assets', 'growth_analytics', 'reconciliation', 'ai_assistant'],
  construction: ['core_ledger', 'commerce', 'procurement', 'inventory', 'projects', 'fixed_assets', 'cogs_margin', 'reconciliation', 'ai_assistant'],
  agriculture: ['core_ledger', 'procurement', 'inventory', 'fixed_assets', 'cogs_margin', 'reconciliation', 'ai_assistant'],
  automotive: ['core_ledger', 'commerce', 'procurement', 'inventory', 'projects', 'fixed_assets', 'cogs_margin', 'reconciliation', 'ai_assistant'],
  hospitality: ['core_ledger', 'commerce', 'invoicing', 'procurement', 'inventory', 'payroll', 'reconciliation', 'ai_assistant'],
  personal: ['core_ledger', 'cashbook', 'reporting', 'ai_assistant'],
  retail: ['core_ledger', 'commerce', 'invoicing', 'procurement', 'customers', 'inventory', 'shipping_returns', 'cogs_margin', 'reconciliation', 'ai_assistant'],
  wholesale: ['core_ledger', 'commerce', 'invoicing', 'procurement', 'customers', 'inventory', 'shipping_returns', 'cogs_margin', 'reconciliation', 'ai_assistant'],
  salon: ['core_ledger', 'invoicing', 'commerce', 'customers', 'reconciliation', 'ai_assistant'],
  handyman: ['core_ledger', 'invoicing', 'commerce', 'procurement', 'customers', 'projects', 'reconciliation', 'ai_assistant'],
  professional_service: ['core_ledger', 'invoicing', 'customers', 'projects', 'reconciliation', 'ai_assistant'],
  it_freelancer: ['core_ledger', 'invoicing', 'customers', 'projects', 'reconciliation', 'ai_assistant'],
  vendor: ['core_ledger', 'commerce', 'invoicing', 'procurement', 'customers', 'inventory', 'shipping_returns', 'cogs_margin', 'reconciliation', 'ai_assistant'],
  custom: ['core_ledger', 'invoicing', 'commerce', 'procurement', 'customers', 'reporting', 'ai_assistant'],
};

const LEGACY_PERSONA_ALIASES: Record<string, PersonaId> = {
  shop: 'retail', service: 'professional_service', it_consultant: 'it_freelancer', freelancer: 'content_creator',
};

export const PERSONA_CAPABILITY_DEFAULTS = PERSONA_DEFAULTS;

export function normalizePersonaId(value: unknown): PersonaId {
  const raw = String(value || '').trim() as PersonaId;
  if (raw in PERSONA_DEFAULTS) return raw;
  return LEGACY_PERSONA_ALIASES[raw] || 'custom';
}

export function activePersonaFor(settings: any): PersonaId {
  if (Array.isArray(settings?.selectedPersonas) && settings.selectedPersonas.length) {
    return normalizePersonaId(settings.activePersona || settings.selectedPersonas[0]);
  }
  return normalizePersonaId(settings?.activePersona || settings?.businessType || 'custom');
}

export function getPersonaCapabilityDefaults(settings: any): CapabilityKey[] {
  const personas: PersonaId[] = Array.isArray(settings?.selectedPersonas) && settings.selectedPersonas.length
    ? settings.selectedPersonas.map((value: unknown) => normalizePersonaId(value))
    : [activePersonaFor(settings)];
  const keys = new Set<CapabilityKey>(CORE_CAPABILITIES);
  for (const persona of personas) for (const key of PERSONA_DEFAULTS[persona] || PERSONA_DEFAULTS.custom) keys.add(key);
  return [...keys];
}

export function getEnabledCapabilities(settings: any): CapabilityKey[] {
  if (Array.isArray(settings?.enabledCapabilities) && settings.enabledCapabilities.length) {
    return [...new Set([...CORE_CAPABILITIES, ...settings.enabledCapabilities as CapabilityKey[]])];
  }
  return getPersonaCapabilityDefaults(settings);
}

export function isCapabilityEnabled(settings: any, key: CapabilityKey): boolean {
  return getEnabledCapabilities(settings).includes(key);
}

export function capabilityForRoute(route: string): CapabilityKey | null {
  const normalized = route.split('?')[0];
  const definition = CAPABILITIES.find((item) => item.routes.some((candidate) => normalized === candidate || normalized.startsWith(`${candidate}/`)));
  return definition?.key || null;
}

export function capabilityDefinition(key: CapabilityKey): CapabilityDefinition | undefined {
  return CAPABILITIES.find((item) => item.key === key);
}

export type MetricDefinition = {
  key: MetricKey;
  label: string;
  description: string;
  requiredCapabilities: CapabilityKey[];
};

export const METRICS: MetricDefinition[] = [
  { key: 'cac', label: 'CAC', description: 'Customer acquisition cost from attributed acquisition spend and new customers.', requiredCapabilities: ['growth_analytics'] },
  { key: 'cogs', label: 'COGS', description: 'Cost assigned to goods sold for the selected period.', requiredCapabilities: ['cogs_margin'] },
  { key: 'gross_margin', label: 'Gross margin', description: 'Revenue remaining after COGS, shown as amount and percentage.', requiredCapabilities: ['cogs_margin'] },
  { key: 'peg', label: 'PEG', description: 'Optional growth/investor metric based on valuation and expected earnings growth.', requiredCapabilities: ['growth_analytics'] },
  { key: 'rto', label: 'RTO', description: 'Return-to-origin shipments divided by shipped orders.', requiredCapabilities: ['shipping_returns'] },
  { key: 'roi', label: 'ROI', description: 'Return attributable to an investment or campaign divided by its cost.', requiredCapabilities: ['growth_analytics'] },
  { key: 'roe', label: 'ROE', description: 'Net profit divided by average owner or shareholder equity.', requiredCapabilities: ['growth_analytics'] },
];

export function metricDefinition(key: MetricKey): MetricDefinition {
  return METRICS.find((metric) => metric.key === key)!;
}

export function eligibleMetrics(settings: any): MetricDefinition[] {
  const enabled = new Set(getEnabledCapabilities(settings));
  return METRICS.filter((metric) => metric.requiredCapabilities.every((key) => enabled.has(key)));
}

/**
 * Metrics are opt-in workspace reporting views. Capability eligibility makes a
 * metric available; it does not force a speculative tile onto Home or Reports.
 */
export function selectedWorkspaceMetrics(settings: any): MetricDefinition[] {
  const requested = new Set(
    Array.isArray(settings?.workspaceMetricKeys)
      ? settings.workspaceMetricKeys.map(String)
      : [],
  );
  return eligibleMetrics(settings).filter((metric) => requested.has(metric.key));
}

export function featureKeysForCapabilities(settings: any): string[] {
  const enabled = new Set(getEnabledCapabilities(settings));
  const keys = new Set<string>();
  for (const capability of CAPABILITIES) {
    if (!enabled.has(capability.key)) continue;
    for (const featureKey of capability.featureKeys) keys.add(featureKey);
  }
  return [...keys];
}

export type ReportSegmentKey = 'Summary' | 'P&L' | 'Balance' | 'Trial' | 'Capital Statement' | 'Capital Withdrawals' | 'Suppliers' | 'Customers' | 'Tax' | 'Sales Reg' | 'Receipts';

const BASE_REPORT_SEGMENTS: ReportSegmentKey[] = ['Summary', 'P&L', 'Balance', 'Trial', 'Tax', 'Sales Reg', 'Receipts'];

export function reportSegmentsFor(settings: any): ReportSegmentKey[] {
  const enabled = new Set(getEnabledCapabilities(settings));
  const segments = [...BASE_REPORT_SEGMENTS];
  if (enabled.has('customers') || enabled.has('invoicing') || enabled.has('commerce')) segments.push('Customers');
  if (enabled.has('procurement')) segments.push('Suppliers');
  if (enabled.has('core_ledger') && settings?.accountingStyle === 'retail_partnership') segments.push('Capital Statement', 'Capital Withdrawals');
  return segments;
}

export type WorkspaceLabels = {
  accountsTitle: string;
  customerLabel: string;
  supplierLabel: string;
  emptyAccountsHint: string;
};

export function workspaceLabelsFor(settings: any): WorkspaceLabels {
  switch (activePersonaFor(settings)) {
    case 'developer':
    case 'it_freelancer':
    case 'professional_service':
      return { accountsTitle: 'Clients', customerLabel: 'Clients', supplierLabel: 'Vendors', emptyAccountsHint: 'Add a client or vendor to track invoices, payments, and project balances.' };
    case 'content_creator':
      return { accountsTitle: 'Partners & Platforms', customerLabel: 'Brands & Platforms', supplierLabel: 'Vendors', emptyAccountsHint: 'Add a brand, platform, or vendor to track payouts, invoices, and expenses.' };
    case 'startup':
    case 'saas':
    case 'solo_founder':
      return { accountsTitle: 'Business Accounts', customerLabel: 'Customers', supplierLabel: 'Vendors', emptyAccountsHint: 'Add customers or enable procurement when you need supplier balances.' };
    case 'dropshipper':
    case 'marketplace_seller':
    case 'ecommerce':
    case 'retail':
    case 'wholesale':
    case 'vendor':
    case 'manufacturer':
    case 'import_export':
    case 'restaurant':
    case 'construction':
    case 'agriculture':
    case 'automotive':
    case 'hospitality':
      return { accountsTitle: 'Customers & Suppliers', customerLabel: 'Customers', supplierLabel: 'Suppliers', emptyAccountsHint: 'Add a customer or supplier to track receivables, payables, and trade balances.' };
    default:
      return { accountsTitle: 'Business Accounts', customerLabel: 'Customers', supplierLabel: 'Suppliers', emptyAccountsHint: 'Add a customer, supplier, or business account.' };
  }
}

export function workspaceTileLabelsFor(settings: any): Partial<Record<string, string>> {
  switch (activePersonaFor(settings)) {
    case 'developer':
    case 'it_freelancer':
    case 'professional_service':
    case 'agency':
    case 'accounting_practice':
    case 'legal':
      return { sales: 'Client Work', invoices: 'Client Invoices', quotes: 'Estimates', expenses: 'Project Costs', reports: 'Project Reports', monthly: 'Monthly Review' };
    case 'content_creator':
      return { sales: 'Brand Deals', invoices: 'Brand Invoices', receipts: 'Platform Payouts', quotes: 'Proposals', expenses: 'Campaign Costs', reports: 'Creator Analytics', monthly: 'Monthly Payouts' };
    case 'startup':
    case 'saas':
    case 'solo_founder':
      return { bills: 'Vendor Bills', sales: 'Revenue', invoices: 'Subscriptions & Invoices', expenses: 'Burn & Expenses', reports: 'Growth Reports', monthly: 'Monthly Burn' };
    case 'dropshipper':
    case 'ecommerce':
      return { bills: 'Supplier Orders', sales: 'Customer Orders', receipts: 'Marketplace Payouts', payments: 'Supplier Payments', invoices: 'Customer Invoices', delivery: 'Shipping & RTO', expenses: 'Ads & Operating Costs', reports: 'Unit Economics', monthly: 'Monthly Margin' };
    case 'marketplace_seller':
      return { bills: 'Supplier Purchases', sales: 'Marketplace Orders', receipts: 'Platform Payouts', payments: 'Marketplace Fees', invoices: 'Customer Invoices', expenses: 'Ads & Seller Costs', reports: 'Marketplace Reports', monthly: 'Monthly Settlement' };
    case 'manufacturer':
      return { bills: 'Materials Purchases', sales: 'Finished-Goods Sales', inventory: 'Materials & Stock', perpetualInventory: 'Products & BOM', expenses: 'Factory Overhead', reports: 'Production Reports', monthly: 'Monthly Costing' };
    case 'restaurant':
      return { bills: 'Ingredient Purchases', sales: 'Daily Sales', inventory: 'Ingredients & Stock', expenses: 'Food & Labour Costs', reports: 'Food Cost Reports', monthly: 'Monthly Store P&L' };
    case 'construction':
      return { bills: 'Subcontractors & Materials', sales: 'Progress Billing', inventory: 'Job Materials', expenses: 'Job Costs', reports: 'Job Cost Reports', monthly: 'Monthly Job Margin' };
    case 'agriculture':
      return { bills: 'Farm Inputs', sales: 'Harvest Sales', inventory: 'Inputs & Harvest', expenses: 'Field Costs', reports: 'Seasonal Reports', monthly: 'Monthly Farm Review' };
    case 'automotive':
      return { bills: 'Parts Purchases', sales: 'Service Orders', inventory: 'Parts Inventory', expenses: 'Workshop Costs', reports: 'Repair Margin', monthly: 'Monthly Workshop' };
    case 'hospitality':
      return { bills: 'Hospitality Supplies', sales: 'Room & POS Sales', invoices: 'Guest Billing', expenses: 'Housekeeping Costs', reports: 'Occupancy Reports', monthly: 'Monthly Property P&L' };
    case 'import_export':
      return { bills: 'Import Purchases', sales: 'Trade Sales', delivery: 'Shipments', expenses: 'Freight & Duties', reports: 'Trade Margin', monthly: 'Monthly Landed Cost' };
    case 'healthcare':
      return { invoices: 'Patient Billing', receipts: 'Claims & Receipts', expenses: 'Clinical Supplies', reports: 'Practice Reports', monthly: 'Monthly Practice P&L' };
    case 'education':
      return { invoices: 'Tuition Billing', receipts: 'Fee Receipts', expenses: 'Programs & Grants', reports: 'Education Reports', monthly: 'Monthly Program Review' };
    case 'nonprofit':
      return { sales: 'Donations', invoices: 'Grant Billing', receipts: 'Donor Receipts', expenses: 'Program Costs', reports: 'Fund Reports', monthly: 'Monthly Fund Review' };
    case 'real_estate':
      return { sales: 'Property Income', invoices: 'Rent & Leases', receipts: 'Tenant Receipts', expenses: 'Maintenance', reports: 'Property Reports', monthly: 'Monthly Property P&L' };
    case 'retail':
      return { bills: 'Store Purchases', sales: 'POS Sales', receipts: 'Customer Receipts', payments: 'Supplier Payments', inventory: 'Stock Counts', perpetualInventory: 'Products', reports: 'Retail Reports', monthly: 'Monthly Store P&L' };
    case 'wholesale':
    case 'vendor':
      return { bills: 'Bulk Purchases', sales: 'Wholesale Sales', receipts: 'Customer Receipts', expenses: 'Trade Expenses', reports: 'Wholesale Reports', monthly: 'Monthly Trading' };
    default:
      return {};
  }
}
