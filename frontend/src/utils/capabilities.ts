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
  { key: 'marketplace', label: 'Marketplace operations', description: 'Marketplace orders, fees, settlement payouts, and refunds.', featureKeys: ['sales', 'invoices', 'receipts'], routes: ['/sales', '/reconcile'], metrics: ['cogs', 'gross_margin', 'rto', 'roi'] },
  { key: 'shipping_returns', label: 'Shipping and returns', description: 'Dispatch, delivery, returns, and return-to-origin tracking.', featureKeys: ['delivery'], routes: ['/delivery-notes'], metrics: ['rto'] },
  { key: 'projects', label: 'Projects and billable work', description: 'Client projects, billable work, estimates, and project profitability.', featureKeys: ['invoices', 'quotes', 'expenses'], routes: ['/invoices', '/quotes'], metrics: ['roi', 'gross_margin'] },
  { key: 'creator_revenue', label: 'Creator revenue', description: 'Brand deals, sponsorship invoices, platform payouts, and campaign costs.', featureKeys: ['invoices', 'receipts', 'expenses'], routes: ['/invoices', '/receipts'], metrics: ['roi'] },
  { key: 'manufacturing', label: 'Manufacturing', description: 'Materials, production work, finished goods, and unit-cost tracking.', featureKeys: ['inventory', 'perpetualInventory', 'bills'], routes: ['/inventory-form', '/products', '/bills'], metrics: ['cogs', 'gross_margin', 'roi', 'roe'] },
  { key: 'trade_landed_cost', label: 'Import and export trade', description: 'Shipments, freight, duties, foreign currency, and landed cost.', featureKeys: ['bills', 'inventory', 'invoices', 'delivery'], routes: ['/bills', '/inventory-form', '/invoices', '/delivery-notes'], metrics: ['cogs', 'gross_margin', 'rto', 'roi', 'roe'] },
  { key: 'cogs_margin', label: 'COGS and gross margin', description: 'Cost of goods sold, gross profit, and margin by period or workflow.', featureKeys: ['inventory', 'reports', 'monthly'], routes: ['/reports', '/monthly-summary'], metrics: ['cogs', 'gross_margin'] },
  { key: 'growth_analytics', label: 'Growth analytics', description: 'Acquisition cost, operating efficiency, campaign returns, and investor metrics.', featureKeys: ['reports', 'monthly'], routes: ['/reports', '/monthly-summary', '/custom-report'], metrics: ['cac', 'roi', 'roe', 'peg'] },
  { key: 'reconciliation', label: 'Reconciliation', description: 'Match statements, payouts, receipts, and recorded ledger activity.', featureKeys: [], routes: ['/reconcile', '/scan-import'] },
  { key: 'cashbook', label: 'Cash and bank', description: 'Manual cash movements, bank balances, and cash controls.', featureKeys: ['cashbook'], routes: ['/cashbook'] },
  { key: 'reporting', label: 'Financial reporting', description: 'Profit and Loss, Balance Sheet, Trial Balance, and summaries.', featureKeys: ['reports', 'monthly'], routes: ['/reports', '/monthly-summary', '/custom-report'] },
  { key: 'ai_assistant', label: 'AI assistance', description: 'Reviewable voice, OCR, reconciliation suggestions, and finance questions.', featureKeys: ['ask', 'voice'], routes: ['/ask', '/voice', '/scan-import'] },
  { key: 'payroll', label: 'Payroll', description: 'Employees, pay runs, payslips, and payroll reporting.', featureKeys: ['payroll'], routes: ['/payroll'] },
  { key: 'fixed_assets', label: 'Fixed assets', description: 'Equipment, vehicles, depreciation, and asset register.', featureKeys: ['fixedAssets'], routes: ['/fixed-assets'], metrics: ['roe'] },
  { key: 'multi_location', label: 'Multi-location retail', description: 'Stores, POS sessions, location-level sales, stock transfers, and consolidated reports.', featureKeys: ['sales', 'inventory', 'cashbook', 'reports'], routes: ['/locations', '/pos-sessions', '/stock-transfers'], metrics: ['cogs', 'gross_margin', 'roi'] },
];

const PERSONA_DEFAULTS: Record<PersonaId, CapabilityKey[]> = {
  mobile_invoicing: ['core_ledger', 'invoicing', 'customers', 'commerce', 'reconciliation', 'ai_assistant'],
  dropshipper: ['core_ledger', 'commerce', 'procurement', 'inventory', 'marketplace', 'shipping_returns', 'cogs_margin', 'reconciliation', 'ai_assistant'],
  marketplace_seller: ['core_ledger', 'commerce', 'procurement', 'inventory', 'marketplace', 'shipping_returns', 'cogs_margin', 'reconciliation', 'ai_assistant'],
  entrepreneur: ['core_ledger', 'invoicing', 'commerce', 'customers', 'growth_analytics', 'reconciliation', 'ai_assistant'],
  startup: ['core_ledger', 'invoicing', 'commerce', 'customers', 'growth_analytics', 'reconciliation', 'ai_assistant'],
  developer: ['core_ledger', 'invoicing', 'customers', 'projects', 'growth_analytics', 'reconciliation', 'ai_assistant'],
  content_creator: ['core_ledger', 'invoicing', 'customers', 'creator_revenue', 'growth_analytics', 'reconciliation', 'ai_assistant'],
  manufacturer: ['core_ledger', 'commerce', 'procurement', 'inventory', 'manufacturing', 'cogs_margin', 'reconciliation', 'fixed_assets', 'ai_assistant'],
  import_export: ['core_ledger', 'invoicing', 'commerce', 'procurement', 'inventory', 'trade_landed_cost', 'shipping_returns', 'cogs_margin', 'reconciliation', 'ai_assistant'],
  personal: ['core_ledger', 'cashbook', 'reporting', 'ai_assistant'],
  retail: ['core_ledger', 'commerce', 'procurement', 'inventory', 'cogs_margin', 'reconciliation', 'ai_assistant'],
  wholesale: ['core_ledger', 'commerce', 'invoicing', 'procurement', 'inventory', 'cogs_margin', 'reconciliation', 'ai_assistant'],
  salon: ['core_ledger', 'invoicing', 'commerce', 'customers', 'reconciliation', 'ai_assistant'],
  handyman: ['core_ledger', 'invoicing', 'commerce', 'procurement', 'customers', 'projects', 'reconciliation', 'ai_assistant'],
  professional_service: ['core_ledger', 'invoicing', 'customers', 'projects', 'reconciliation', 'ai_assistant'],
  it_freelancer: ['core_ledger', 'invoicing', 'customers', 'projects', 'reconciliation', 'ai_assistant'],
  vendor: ['core_ledger', 'commerce', 'invoicing', 'procurement', 'inventory', 'cogs_margin', 'reconciliation', 'ai_assistant'],
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

export function featureKeysForCapabilities(settings: any): string[] {
  const enabled = new Set(getEnabledCapabilities(settings));
  const keys = new Set<string>();
  for (const capability of CAPABILITIES) {
    if (!enabled.has(capability.key)) continue;
    for (const featureKey of capability.featureKeys) keys.add(featureKey);
  }
  return [...keys];
}
