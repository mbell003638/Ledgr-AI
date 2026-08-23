import type { V2Basis, V2BookStyle } from './types';

export type PersonaId = 'mobile_invoicing' | 'dropshipper' | 'marketplace_seller' | 'entrepreneur' | 'startup' | 'developer' | 'content_creator' | 'manufacturer' | 'import_export' | 'saas' | 'ecommerce' | 'agency' | 'accounting_practice' | 'small_business' | 'solo_founder' | 'restaurant' | 'healthcare' | 'education' | 'legal' | 'nonprofit' | 'real_estate' | 'construction' | 'agriculture' | 'automotive' | 'hospitality' | 'personal' | 'retail' | 'wholesale' | 'salon' | 'handyman' | 'professional_service' | 'it_freelancer' | 'vendor' | 'custom';
export type PersonaConfig = { id: PersonaId; label: string; description: string; modules: string[]; questions: string[] };

export const PERSONAS: PersonaConfig[] = [
  { id: 'mobile_invoicing', label: 'Mobile Invoicing', description: 'Send invoices, collect payments, and stay on top of customer balances from your phone.', modules: ['invoices', 'receipts', 'customers', 'reports'], questions: ['Use recurring invoices?', 'Offer payment terms?'] },
  { id: 'dropshipper', label: 'Dropshipper', description: 'Track suppliers, orders, shipping costs, returns, and profit without holding all stock.', modules: ['sales', 'purchases', 'marketplace', 'shipping', 'reports'], questions: ['Track return-to-origin orders?', 'Track supplier costs per order?'] },
  { id: 'marketplace_seller', label: 'Marketplace Seller', description: 'Reconcile marketplace orders, fees, refunds, payouts, and product margins.', modules: ['sales', 'purchases', 'inventory', 'marketplace', 'reports'], questions: ['Which marketplace do you sell on?', 'Track settlement payouts?'] },
  { id: 'entrepreneur', label: 'Entrepreneur', description: 'Keep a clear view of cash, revenue, expenses, and business health as you grow.', modules: ['sales', 'invoices', 'expenses', 'reports'], questions: ['Track business goals?', 'Track owner equity?'] },
  { id: 'startup', label: 'Startup', description: 'Understand growth efficiency, burn, margin, acquisition cost, and investor health.', modules: ['sales', 'invoices', 'expenses', 'growth', 'reports'], questions: ['Track acquisition spend?', 'Track investor capital?'] },
  { id: 'developer', label: 'Developer', description: 'Bill clients for projects or retainers and understand project profitability.', modules: ['projects', 'invoices', 'expenses', 'reports'], questions: ['Track billable hours?', 'Track project budgets?'] },
  { id: 'content_creator', label: 'Content Creator', description: 'Track brand deals, platform payouts, campaign costs, and creator expenses.', modules: ['invoices', 'creator_revenue', 'expenses', 'reports'], questions: ['Track campaigns?', 'Track platform payouts?'] },
  { id: 'manufacturer', label: 'Manufacturer', description: 'Track materials, production, finished goods, unit cost, and gross margin.', modules: ['sales', 'purchases', 'inventory', 'manufacturing', 'reports'], questions: ['Track bills of materials?', 'Track work in progress?'] },
  { id: 'import_export', label: 'Import / Export Trader', description: 'Track shipments, freight, duties, foreign exchange, landed cost, and trade margins.', modules: ['sales', 'purchases', 'inventory', 'trade', 'reports'], questions: ['Track landed cost?', 'Track shipment status?'] },
  { id: 'saas', label: 'SaaS', description: 'Track subscriptions, recurring revenue, churn, customer acquisition, and cloud costs.', modules: ['sales', 'invoices', 'subscriptions', 'growth', 'expenses', 'reports'], questions: ['Track monthly recurring revenue?', 'Track churn and runway?'] },
  { id: 'ecommerce', label: 'Ecommerce', description: 'Track online orders, inventory, payment fees, shipping, returns, and contribution margin.', modules: ['sales', 'purchases', 'inventory', 'marketplace', 'shipping', 'reports'], questions: ['Track channel fees?', 'Track returns and shipping?'] },
  { id: 'agency', label: 'Agency', description: 'Track clients, campaigns, retainers, contractors, project margin, and receivables.', modules: ['projects', 'invoices', 'expenses', 'customers', 'reports'], questions: ['Track retainers?', 'Track contractor costs?'] },
  { id: 'accounting_practice', label: 'Accountants', description: 'Manage client books, recurring work, billing, deadlines, and practice profitability.', modules: ['projects', 'invoices', 'customers', 'reports'], questions: ['Track client portfolios?', 'Track recurring compliance work?'] },
  { id: 'small_business', label: 'Small Business', description: 'Run everyday sales, purchases, expenses, payroll, cash, and financial reporting.', modules: ['sales', 'invoices', 'purchases', 'expenses', 'payroll', 'reports'], questions: ['Track payroll?', 'Track cash and bank?'] },
  { id: 'solo_founder', label: 'Solo Founder', description: 'Keep control of revenue, expenses, runway, customers, and owner contributions.', modules: ['sales', 'invoices', 'expenses', 'growth', 'customers', 'reports'], questions: ['Track runway?', 'Track founder contributions?'] },
  { id: 'restaurant', label: 'Restaurant / Food', description: 'Track recipes, ingredients, wastage, food cost, suppliers, team costs, and daily sales.', modules: ['sales', 'purchases', 'inventory', 'manufacturing', 'payroll', 'reports'], questions: ['Track food cost?', 'Track wastage and recipes?'] },
  { id: 'healthcare', label: 'Healthcare', description: 'Track patients, services, claims, supplies, practitioners, and compliant financial records.', modules: ['invoices', 'customers', 'expenses', 'payroll', 'reports'], questions: ['Track insurance claims?', 'Track practitioner revenue?'] },
  { id: 'education', label: 'Education', description: 'Track student fees, programs, grants, payroll, expenses, and financial aid.', modules: ['invoices', 'customers', 'expenses', 'payroll', 'reports'], questions: ['Track tuition schedules?', 'Track grants and aid?'] },
  { id: 'legal', label: 'Legal', description: 'Track matters, billable time, retainers, trust balances, expenses, and client billing.', modules: ['projects', 'invoices', 'customers', 'expenses', 'reports'], questions: ['Track matter budgets?', 'Track trust balances?'] },
  { id: 'nonprofit', label: 'Nonprofit', description: 'Track donors, grants, restricted funds, programs, campaigns, and fund reporting.', modules: ['sales', 'invoices', 'expenses', 'reports'], questions: ['Track restricted funds?', 'Track grant programs?'] },
  { id: 'real_estate', label: 'Real Estate', description: 'Track properties, leases, tenants, deposits, maintenance, and property profitability.', modules: ['invoices', 'customers', 'expenses', 'fixed_assets', 'reports'], questions: ['Track rent schedules?', 'Track property-level costs?'] },
  { id: 'construction', label: 'Construction', description: 'Track jobs, bids, subcontractors, materials, equipment, progress billing, and job margin.', modules: ['projects', 'sales', 'purchases', 'inventory', 'fixed_assets', 'reports'], questions: ['Track job costing?', 'Track subcontractors?'] },
  { id: 'agriculture', label: 'Agriculture', description: 'Track crops, livestock, fields, harvests, inputs, equipment, and seasonal profitability.', modules: ['inventory', 'purchases', 'fixed_assets', 'expenses', 'reports'], questions: ['Track crop cycles?', 'Track field inputs?'] },
  { id: 'automotive', label: 'Automotive', description: 'Track vehicles, service orders, parts, warranties, inventory, and repair profitability.', modules: ['sales', 'purchases', 'inventory', 'fixed_assets', 'projects', 'reports'], questions: ['Track service orders?', 'Track parts and warranties?'] },
  { id: 'hospitality', label: 'Hospitality', description: 'Track reservations, rooms, housekeeping, guest billing, supplies, and property operations.', modules: ['sales', 'invoices', 'purchases', 'inventory', 'payroll', 'reports'], questions: ['Track room revenue?', 'Track occupancy costs?'] },
  { id: 'personal', label: 'Personal Finance', description: 'Personal budget, daily expenses, payees, assets and net worth.', modules: ['sales', 'expenses', 'net_worth', 'parties', 'reports'], questions: ['Track category budgets?', 'Track net worth statement?'] },
  { id: 'retail', label: 'Retail Shop', description: 'Stock, purchases, inventory and customer sales.', modules: ['sales', 'invoices', 'inventory', 'purchases', 'parties', 'reports'], questions: ['Track periodic inventory?', 'Use partnership close-books?'] },
  { id: 'wholesale', label: 'Wholesale / Trading', description: 'Bulk stock, suppliers and receivables.', modules: ['sales', 'invoices', 'inventory', 'purchases', 'parties', 'reports'], questions: ['Track periodic inventory?', 'Default credit terms?'] },
  { id: 'salon', label: 'Salon / Beauty', description: 'Services, customers, appointments and expenses.', modules: ['sales', 'invoices', 'parties', 'expenses', 'reports'], questions: ['Track service providers?', 'Track appointments?'] },
  { id: 'handyman', label: 'Handyman / Repair', description: 'Jobs, materials, service invoices and customers.', modules: ['jobs', 'sales', 'invoices', 'expenses', 'parties', 'reports'], questions: ['Track materials?', 'Track job status?'] },
  { id: 'professional_service', label: 'Professional Service', description: 'Clients, projects, invoices and expenses.', modules: ['projects', 'sales', 'invoices', 'expenses', 'parties', 'reports'], questions: ['Track projects?', 'Track billable hours?'] },
  { id: 'it_freelancer', label: 'IT / Freelancer', description: 'Projects, clients, invoices and payments.', modules: ['projects', 'sales', 'invoices', 'expenses', 'parties', 'reports'], questions: ['Track billable hours?', 'Track project budgets?'] },
  { id: 'vendor', label: 'Vendor / Supplier', description: 'Orders, deliveries, sales and payments.', modules: ['sales', 'invoices', 'purchases', 'parties', 'reports'], questions: ['Track delivery status?', 'Use credit terms?'] },
  { id: 'custom', label: 'Custom Business', description: 'Choose exactly the modules you need.', modules: ['sales', 'invoices', 'parties', 'reports'], questions: ['Which modules should be enabled?'] },
];

export type RetailPartnershipConfig = {
  enabled: boolean;
  shopkeeperName?: string;
  shopkeeperSalaryExpenseAccount?: string;
  commissionPct: number;
  members: { id?: string; name: string; openingContribution: number; profitSharePct: number }[];
  inventoryCadence: 'irregular' | 'monthly' | 'quarterly' | 'annual';
};

export type AccountingPeriodPolicy = {
  mode: 'flexible' | 'fixed';
  startDate?: string;
  endDate?: string;
};

export type V2BookConfig = {
  bookId: string;
  selectedPersonas: PersonaId[];
  activePersona: PersonaId;
  style: V2BookStyle;
  basis: V2Basis;
  periodPolicy: AccountingPeriodPolicy;
  retailPartnership: RetailPartnershipConfig;
};

export function persona(id: PersonaId) { return PERSONAS.find((p) => p.id === id) || PERSONAS.find((p) => p.id === 'custom')!; }
export function modulesFor(personas: PersonaId[]) { return [...new Set(personas.flatMap((id) => persona(id).modules))]; }
export function defaultBookConfig(bookId: string): V2BookConfig { return { bookId, selectedPersonas: ['custom'], activePersona: 'custom', style: 'standard', basis: 'accrual', periodPolicy: { mode: 'flexible' }, retailPartnership: { enabled: false, commissionPct: 0, members: [], inventoryCadence: 'irregular' } }; }

/**
 * Startup workflows commonly need investor/partner capital reporting, but the
 * recommendation must never silently rewrite an existing book. The onboarding
 * choice remains explicit and Advanced Settings remains the canonical editor.
 */
export function defaultAccountingStyleForPersonas(personas: PersonaId[]): 'standard' | 'retail_partnership' {
  return personas.includes('startup') ? 'retail_partnership' : 'standard';
}
