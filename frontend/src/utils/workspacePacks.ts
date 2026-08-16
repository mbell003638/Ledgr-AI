import type { PersonaId } from '@/src/accountingV2/config';
import { V2_ACCOUNT_CODES } from '@/src/accountingV2/types';
import { activePersonaFor, getPersonaCapabilityDefaults, reportSegmentsFor, workspaceLabelsFor, workspaceTileLabelsFor, type CapabilityKey, type ReportSegmentKey } from './capabilities';
import { expenseCategoryOptionsForPersona } from '@/src/accountingV2/expenseCategories';
import { advancedOperationalModulesFor, featuredOperationalModulesFor, type OperationalModule } from './operationalModules';

export type WorkspaceMetricInputKey = 'acquisitionSpend' | 'newCustomers' | 'returnedOrders' | 'shippedOrders' | 'investmentReturn' | 'investmentCost' | 'priceToEarnings' | 'expectedGrowthPercent';
export type WorkspacePack = {
  persona: PersonaId;
  title: string;
  summary: string;
  capabilities: CapabilityKey[];
  reportSegments: ReportSegmentKey[];
  homeLabels: Partial<Record<string, string>>;
  accounts: string[];
  metricInputs: WorkspaceMetricInputKey[];
  expenseCategories: ReturnType<typeof expenseCategoryOptionsForPersona>;
  featuredModules: OperationalModule[];
  advancedModules: OperationalModule[];
};

const BASE_ACCOUNT_CODES = [
  V2_ACCOUNT_CODES.CASH, V2_ACCOUNT_CODES.BANK, V2_ACCOUNT_CODES.AR, V2_ACCOUNT_CODES.AP,
  V2_ACCOUNT_CODES.SALES, V2_ACCOUNT_CODES.EXPENSES, V2_ACCOUNT_CODES.COGS,
];

const METRIC_INPUTS: Record<string, WorkspaceMetricInputKey[]> = {
  cac: ['acquisitionSpend', 'newCustomers'],
  rto: ['returnedOrders', 'shippedOrders'],
  roi: ['investmentReturn', 'investmentCost'],
  peg: ['priceToEarnings', 'expectedGrowthPercent'],
};

const TITLES: Partial<Record<PersonaId, { title: string; summary: string }>> = {
  mobile_invoicing: { title: 'Mobile Invoicing', summary: 'Invoice-led bookkeeping for customer balances and mobile collections.' },
  dropshipper: { title: 'Dropshipper', summary: 'Orders, supplier costs, shipping, returns, marketplace fees, and unit economics.' },
  marketplace_seller: { title: 'Marketplace Seller', summary: 'Marketplace orders, fees, payouts, refunds, product margins, and reconciliation.' },
  entrepreneur: { title: 'Entrepreneur', summary: 'A balanced business workspace for cash control, sales, costs, and growth.' },
  startup: { title: 'Startup', summary: 'Revenue, burn, acquisition efficiency, runway inputs, and investor metrics.' },
  developer: { title: 'Developer', summary: 'Client invoices, project costs, estimates, and delivery profitability.' },
  content_creator: { title: 'Content Creator', summary: 'Brand deals, platform payouts, campaign costs, and creator production expenses.' },
  manufacturer: { title: 'Manufacturer', summary: 'Materials, production, finished goods, unit cost, and gross margin.' },
  import_export: { title: 'Import / Export Trader', summary: 'Shipments, freight, duties, foreign exchange, landed cost, and trade margin.' },
  saas: { title: 'SaaS', summary: 'Subscriptions, recurring revenue, churn, cloud costs, and growth efficiency.' },
  ecommerce: { title: 'Ecommerce', summary: 'Online orders, inventory, channel fees, shipping, returns, and contribution margin.' },
  agency: { title: 'Agency', summary: 'Clients, retainers, campaigns, contractors, delivery costs, and project margin.' },
  accounting_practice: { title: 'Accounting Practice', summary: 'Client portfolios, recurring compliance work, billing, and practice profitability.' },
  small_business: { title: 'Small Business', summary: 'Everyday sales, purchases, expenses, payroll, cash, and reporting.' },
  solo_founder: { title: 'Solo Founder', summary: 'Revenue, expenses, runway, customers, and owner contributions.' },
  restaurant: { title: 'Restaurant / Food', summary: 'Ingredients, recipes, wastage, food cost, suppliers, team costs, and daily sales.' },
  healthcare: { title: 'Healthcare', summary: 'Patients, services, claims, supplies, practitioners, and compliant records.' },
  education: { title: 'Education', summary: 'Student fees, programs, grants, payroll, expenses, and financial aid.' },
  legal: { title: 'Legal', summary: 'Matters, billable time, retainers, trust balances, expenses, and client billing.' },
  nonprofit: { title: 'Nonprofit', summary: 'Donors, grants, restricted funds, programs, campaigns, and fund reporting.' },
  real_estate: { title: 'Real Estate', summary: 'Properties, leases, tenants, deposits, maintenance, and property profitability.' },
  construction: { title: 'Construction', summary: 'Jobs, bids, subcontractors, materials, equipment, and progress billing.' },
  agriculture: { title: 'Agriculture', summary: 'Crops, livestock, fields, harvests, inputs, equipment, and seasonal profitability.' },
  automotive: { title: 'Automotive', summary: 'Vehicles, service orders, parts, warranties, inventory, and repair profitability.' },
  hospitality: { title: 'Hospitality', summary: 'Reservations, rooms, housekeeping, guest billing, supplies, and operations.' },
  retail: { title: 'Retail Shop', summary: 'Store sales, tills, stock, purchases, locations, and consolidated retail reports.' },
  wholesale: { title: 'Wholesale / Trading', summary: 'Bulk purchases, customer receivables, inventory, and trading margin.' },
  salon: { title: 'Salon / Beauty', summary: 'Service revenue, customers, supplies, and operating expenses.' },
  handyman: { title: 'Handyman / Repair', summary: 'Jobs, materials, service invoices, and customer balances.' },
  professional_service: { title: 'Professional Service', summary: 'Clients, projects, invoices, expenses, and profitability.' },
  it_freelancer: { title: 'IT / Freelancer', summary: 'Projects, clients, invoices, payments, and delivery costs.' },
  vendor: { title: 'Vendor / Supplier', summary: 'Orders, deliveries, sales, customer balances, and payments.' },
  personal: { title: 'Personal Finance', summary: 'Personal spending, cash, assets, payees, and net worth.' },
  custom: { title: 'Custom Business', summary: 'Choose the modules and accounting workflows that fit your business.' },
};

export function workspacePackFor(settings: any): WorkspacePack {
  const persona = activePersonaFor(settings) as PersonaId;
  const capabilities = getPersonaCapabilityDefaults(settings) as CapabilityKey[];
  const title = TITLES[persona] || TITLES.custom!;
  const metrics = new Set<string>();
  for (const capability of capabilities) {
    if (capability === 'growth_analytics') ['cac', 'roi', 'peg', 'roe'].forEach((key) => metrics.add(key));
    if (capability === 'shipping_returns') metrics.add('rto');
    if (capability === 'cogs_margin' || capability === 'inventory' || capability === 'manufacturing' || capability === 'trade_landed_cost') ['cogs', 'gross_margin'].forEach((key) => metrics.add(key));
  }
  const metricInputs = [...new Set(Array.from(metrics).flatMap((key) => METRIC_INPUTS[key] || []))];
  const expenseCategories = expenseCategoryOptionsForPersona(persona);
  const accounts = [...new Set([...BASE_ACCOUNT_CODES, ...expenseCategories.map((category) => category.accountCode)])];
  return {
    persona,
    title: title.title,
    summary: title.summary,
    capabilities,
    reportSegments: reportSegmentsFor(settings),
    homeLabels: workspaceTileLabelsFor(settings),
    accounts,
    metricInputs,
    expenseCategories,
    featuredModules: featuredOperationalModulesFor(settings),
    advancedModules: advancedOperationalModulesFor(settings),
  };
}

export function workspacePackSummary(settings: any) {
  const pack = workspacePackFor(settings);
  const labels = workspaceLabelsFor(settings);
  return { ...pack, accountsTitle: labels.accountsTitle, customerLabel: labels.customerLabel, supplierLabel: labels.supplierLabel };
}
