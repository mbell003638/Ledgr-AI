import type { PersonaId } from '@/src/accountingV2/config';
import { activePersonaFor, getEnabledCapabilities, type CapabilityKey } from './capabilities';

export type OperationalModuleKey =
  | 'sales_orders'
  | 'customer_accounts'
  | 'supplier_procurement'
  | 'inventory_catalog'
  | 'shipping_returns'
  | 'marketplace_settlements'
  | 'projects_time'
  | 'creator_contracts'
  | 'manufacturing_bom'
  | 'trade_landed_cost'
  | 'pos_locations'
  | 'payroll'
  | 'fixed_assets'
  | 'bank_reconciliation'
  | 'budgets_forecasts'
  | 'recurring_billing'
  | 'tax_compliance'
  | 'cash_flow'
  | 'industry_metrics'
  | 'ai_copilot';

export type OperationalModule = {
  key: OperationalModuleKey;
  label: string;
  shortLabel: string;
  description: string;
  requiredCapabilities: CapabilityKey[];
  routes: string[];
  advanced?: boolean;
};

export const OPERATIONAL_MODULES: OperationalModule[] = [
  { key: 'sales_orders', label: 'Sales and orders', shortLabel: 'Sales', description: 'Record revenue, orders, invoices, receipts, and customer collections.', requiredCapabilities: ['commerce'], routes: ['/sales', '/invoices', '/receipts'] },
  { key: 'customer_accounts', label: 'Customer accounts', shortLabel: 'Customers', description: 'Track customer records, receivables, balances, and collection history.', requiredCapabilities: ['customers'], routes: ['/suppliers', '/debtors'] },
  { key: 'supplier_procurement', label: 'Procurement and suppliers', shortLabel: 'Purchases', description: 'Track purchasing, supplier bills, payments, and payables.', requiredCapabilities: ['procurement'], routes: ['/bills', '/payments'] },
  { key: 'inventory_catalog', label: 'Inventory and catalog', shortLabel: 'Inventory', description: 'Manage products, quantities, stock value, and inventory controls.', requiredCapabilities: ['inventory'], routes: ['/products', '/inventory-form'] },
  { key: 'shipping_returns', label: 'Shipping and returns', shortLabel: 'Delivery', description: 'Manage dispatch, delivery, returns, refunds, and RTO workflows.', requiredCapabilities: ['shipping_returns'], routes: ['/delivery-notes', '/marketplace'] },
  { key: 'marketplace_settlements', label: 'Marketplace settlements', shortLabel: 'Settlements', description: 'Reconcile channels, platform fees, refunds, payouts, and clearing balances.', requiredCapabilities: ['marketplace'], routes: ['/marketplace'], advanced: true },
  { key: 'projects_time', label: 'Projects and time', shortLabel: 'Projects', description: 'Track projects, budgets, billable time, delivery costs, and margin.', requiredCapabilities: ['projects'], routes: ['/projects'], advanced: true },
  { key: 'creator_contracts', label: 'Creator contracts', shortLabel: 'Creator work', description: 'Track brand campaigns, contracts, payouts, and production costs.', requiredCapabilities: ['creator_revenue'], routes: ['/projects'], advanced: true },
  { key: 'manufacturing_bom', label: 'BOM and production', shortLabel: 'Production', description: 'Manage bills of materials, WIP, production orders, and finished goods.', requiredCapabilities: ['manufacturing'], routes: ['/products', '/inventory-form', '/bills'], advanced: true },
  { key: 'trade_landed_cost', label: 'Trade and landed cost', shortLabel: 'Trade', description: 'Track shipments, freight, duties, landed cost, and FX remeasurement.', requiredCapabilities: ['trade_landed_cost'], routes: ['/bills', '/inventory-form', '/marketplace'], advanced: true },
  { key: 'pos_locations', label: 'POS and locations', shortLabel: 'Locations', description: 'Manage stores, tills, stock transfers, location reporting, and consolidated books.', requiredCapabilities: ['multi_location'], routes: ['/locations', '/pos-sessions', '/stock-transfers'], advanced: true },
  { key: 'payroll', label: 'Payroll', shortLabel: 'Payroll', description: 'Manage employees, pay runs, payslips, taxes, and payroll journals.', requiredCapabilities: ['payroll'], routes: ['/payroll'], advanced: true },
  { key: 'fixed_assets', label: 'Fixed assets', shortLabel: 'Assets', description: 'Track equipment, vehicles, depreciation, and disposals.', requiredCapabilities: ['fixed_assets'], routes: ['/fixed-assets'], advanced: true },
  { key: 'bank_reconciliation', label: 'Bank reconciliation', shortLabel: 'Reconcile', description: 'Stage bank feeds, match transactions, and review unmatched items.', requiredCapabilities: ['reconciliation'], routes: ['/reconcile', '/scan-import'] },
  { key: 'budgets_forecasts', label: 'Budgets and forecasts', shortLabel: 'Planning', description: 'Compare budgets to actuals and plan cash, margin, and growth.', requiredCapabilities: ['reporting'], routes: ['/planning', '/reports', '/custom-report'], advanced: true },
  { key: 'recurring_billing', label: 'Recurring billing', shortLabel: 'Recurring', description: 'Schedule repeat invoices, expenses, subscriptions, and local reminders.', requiredCapabilities: ['invoicing'], routes: ['/planning', '/invoices'], advanced: true },
  { key: 'tax_compliance', label: 'Tax and compliance', shortLabel: 'Tax', description: 'Apply country tax profiles, rates, registrations, and compliance reports.', requiredCapabilities: ['reporting'], routes: ['/planning', '/reports'], advanced: true },
  { key: 'cash_flow', label: 'Cash flow control', shortLabel: 'Cash flow', description: 'Understand cash movement, liquidity, and upcoming obligations.', requiredCapabilities: ['cashbook'], routes: ['/cashbook', '/reports'] },
  { key: 'industry_metrics', label: 'Industry metrics', shortLabel: 'Metrics', description: 'Show only relevant operational metrics with honest input requirements.', requiredCapabilities: ['reporting'], routes: ['/reports', '/metric-inputs'] },
  { key: 'ai_copilot', label: 'AI accounting copilot', shortLabel: 'Ask AI', description: 'Prepare reviewable accounting actions without direct database access.', requiredCapabilities: ['ai_assistant'], routes: ['/ask', '/voice'], advanced: true },
];

const PERSONA_FEATURED: Partial<Record<PersonaId, OperationalModuleKey[]>> = {
  mobile_invoicing: ['sales_orders', 'customer_accounts', 'bank_reconciliation', 'cash_flow', 'ai_copilot'],
  dropshipper: ['sales_orders', 'supplier_procurement', 'inventory_catalog', 'shipping_returns', 'marketplace_settlements', 'industry_metrics', 'ai_copilot'],
  marketplace_seller: ['sales_orders', 'inventory_catalog', 'shipping_returns', 'marketplace_settlements', 'supplier_procurement', 'industry_metrics', 'ai_copilot'],
  entrepreneur: ['sales_orders', 'customer_accounts', 'supplier_procurement', 'cash_flow', 'industry_metrics', 'ai_copilot'],
  startup: ['sales_orders', 'customer_accounts', 'projects_time', 'cash_flow', 'budgets_forecasts', 'industry_metrics', 'ai_copilot'],
  developer: ['sales_orders', 'customer_accounts', 'projects_time', 'cash_flow', 'industry_metrics', 'ai_copilot'],
  content_creator: ['sales_orders', 'customer_accounts', 'creator_contracts', 'cash_flow', 'industry_metrics', 'ai_copilot'],
  manufacturer: ['sales_orders', 'supplier_procurement', 'inventory_catalog', 'manufacturing_bom', 'fixed_assets', 'industry_metrics', 'ai_copilot'],
  import_export: ['sales_orders', 'supplier_procurement', 'inventory_catalog', 'trade_landed_cost', 'shipping_returns', 'industry_metrics', 'ai_copilot'],
  saas: ['sales_orders', 'customer_accounts', 'recurring_billing', 'cash_flow', 'budgets_forecasts', 'industry_metrics', 'ai_copilot'],
  ecommerce: ['sales_orders', 'inventory_catalog', 'supplier_procurement', 'marketplace_settlements', 'shipping_returns', 'industry_metrics', 'ai_copilot'],
  agency: ['sales_orders', 'customer_accounts', 'projects_time', 'budgets_forecasts', 'cash_flow', 'industry_metrics', 'ai_copilot'],
  accounting_practice: ['customer_accounts', 'sales_orders', 'projects_time', 'recurring_billing', 'tax_compliance', 'industry_metrics', 'ai_copilot'],
  small_business: ['sales_orders', 'customer_accounts', 'supplier_procurement', 'cash_flow', 'tax_compliance', 'ai_copilot'],
  solo_founder: ['sales_orders', 'customer_accounts', 'cash_flow', 'budgets_forecasts', 'industry_metrics', 'ai_copilot'],
  restaurant: ['sales_orders', 'supplier_procurement', 'inventory_catalog', 'payroll', 'industry_metrics', 'ai_copilot'],
  healthcare: ['sales_orders', 'customer_accounts', 'supplier_procurement', 'fixed_assets', 'tax_compliance', 'ai_copilot'],
  education: ['sales_orders', 'customer_accounts', 'budgets_forecasts', 'tax_compliance', 'industry_metrics', 'ai_copilot'],
  legal: ['sales_orders', 'customer_accounts', 'projects_time', 'recurring_billing', 'cash_flow', 'ai_copilot'],
  nonprofit: ['sales_orders', 'customer_accounts', 'budgets_forecasts', 'tax_compliance', 'industry_metrics', 'ai_copilot'],
  real_estate: ['sales_orders', 'customer_accounts', 'fixed_assets', 'recurring_billing', 'industry_metrics', 'ai_copilot'],
  construction: ['sales_orders', 'supplier_procurement', 'inventory_catalog', 'projects_time', 'fixed_assets', 'industry_metrics', 'ai_copilot'],
  agriculture: ['supplier_procurement', 'inventory_catalog', 'fixed_assets', 'budgets_forecasts', 'industry_metrics', 'ai_copilot'],
  automotive: ['sales_orders', 'supplier_procurement', 'inventory_catalog', 'projects_time', 'fixed_assets', 'industry_metrics', 'ai_copilot'],
  hospitality: ['sales_orders', 'customer_accounts', 'supplier_procurement', 'inventory_catalog', 'payroll', 'industry_metrics', 'ai_copilot'],
  retail: ['sales_orders', 'customer_accounts', 'supplier_procurement', 'inventory_catalog', 'pos_locations', 'industry_metrics', 'ai_copilot'],
  wholesale: ['sales_orders', 'customer_accounts', 'supplier_procurement', 'inventory_catalog', 'cash_flow', 'industry_metrics', 'ai_copilot'],
};

export function operationalModulesFor(settings: any): OperationalModule[] {
  const enabled = new Set(getEnabledCapabilities(settings));
  return OPERATIONAL_MODULES.filter((module) => module.requiredCapabilities.every((key) => enabled.has(key)));
}

export function featuredOperationalModulesFor(settings: any): OperationalModule[] {
  const persona = activePersonaFor(settings);
  const available = new Map(operationalModulesFor(settings).map((module) => [module.key, module]));
  const keys = PERSONA_FEATURED[persona] || ['sales_orders', 'customer_accounts', 'supplier_procurement', 'cash_flow', 'industry_metrics', 'ai_copilot'];
  return keys.map((key) => available.get(key)).filter(Boolean) as OperationalModule[];
}

export function advancedOperationalModulesFor(settings: any): OperationalModule[] {
  const featured = new Set(featuredOperationalModulesFor(settings).map((module) => module.key));
  return operationalModulesFor(settings).filter((module) => module.advanced && !featured.has(module.key));
}

export function operationalModuleFor(key: OperationalModuleKey): OperationalModule {
  return OPERATIONAL_MODULES.find((module) => module.key === key)!;
}
