import type { PersonaId } from './config';
import { V2_ACCOUNT_CODES } from './types';

export type ExpenseCategoryOption = {
  label: string;
  accountCode: string;
  description: string;
};

const common: ExpenseCategoryOption[] = [
  { label: 'General operating expense', accountCode: V2_ACCOUNT_CODES.EXPENSES, description: 'Rent, utilities, professional services, or other operating costs.' },
  { label: 'Travel and transport', accountCode: V2_ACCOUNT_CODES.EXPENSES, description: 'Business travel, local transport, and delivery trips.' },
  { label: 'Wages and contractors', accountCode: V2_ACCOUNT_CODES.WAGES_EXPENSE, description: 'Employee, contractor, or casual labour costs.' },
  { label: 'Depreciation', accountCode: V2_ACCOUNT_CODES.DEPRECIATION_EXPENSE, description: 'Depreciation for business equipment and fixed assets.' },
];

const sharedCommerce: ExpenseCategoryOption[] = [
  { label: 'Advertising and acquisition', accountCode: V2_ACCOUNT_CODES.ADVERTISING_EXPENSE, description: 'Paid marketing and customer-acquisition spend used for CAC.' },
  { label: 'Payment and platform fees', accountCode: V2_ACCOUNT_CODES.MARKETPLACE_FEES, description: 'Marketplace, payment gateway, or POS processing charges.' },
  { label: 'Shipping and fulfilment', accountCode: V2_ACCOUNT_CODES.SHIPPING_EXPENSE, description: 'Courier, packing, dispatch, and fulfilment costs.' },
];

export const PERSONA_EXPENSE_CATEGORIES: Partial<Record<PersonaId, ExpenseCategoryOption[]>> = {
  dropshipper: [...sharedCommerce, { label: 'Returns and RTO', accountCode: V2_ACCOUNT_CODES.RETURNS_EXPENSE, description: 'Return-to-origin, refund, reverse-logistics, and failed-delivery costs.' }, { label: 'Software and tools', accountCode: V2_ACCOUNT_CODES.SOFTWARE_EXPENSE, description: 'Store, automation, analytics, and subscription software.' }, ...common],
  marketplace_seller: [...sharedCommerce, { label: 'Returns and refunds', accountCode: V2_ACCOUNT_CODES.RETURNS_EXPENSE, description: 'Refund, return, reimbursement, and reverse-logistics costs.' }, { label: 'Software and tools', accountCode: V2_ACCOUNT_CODES.SOFTWARE_EXPENSE, description: 'Seller tools, analytics, and subscription software.' }, ...common],
  startup: [{ label: 'Advertising and acquisition', accountCode: V2_ACCOUNT_CODES.ADVERTISING_EXPENSE, description: 'Acquisition spend used for CAC and growth analysis.' }, { label: 'Software and cloud', accountCode: V2_ACCOUNT_CODES.SOFTWARE_EXPENSE, description: 'Hosting, cloud infrastructure, SaaS, and developer tools.' }, ...common],
  saas: [{ label: 'Cloud infrastructure', accountCode: V2_ACCOUNT_CODES.SOFTWARE_EXPENSE, description: 'Hosting, compute, storage, observability, and infrastructure costs.' }, { label: 'Product and engineering tools', accountCode: V2_ACCOUNT_CODES.SOFTWARE_EXPENSE, description: 'Developer tools, APIs, analytics, and product software.' }, { label: 'Advertising and acquisition', accountCode: V2_ACCOUNT_CODES.ADVERTISING_EXPENSE, description: 'Customer acquisition spend used for CAC and growth reporting.' }, { label: 'Customer success and support', accountCode: V2_ACCOUNT_CODES.WAGES_EXPENSE, description: 'Support, onboarding, and customer-success labour.' }, ...common],
  ecommerce: [...sharedCommerce, { label: 'Returns and refunds', accountCode: V2_ACCOUNT_CODES.RETURNS_EXPENSE, description: 'Customer returns, refunds, reverse logistics, and restocking.' }, { label: 'Store software', accountCode: V2_ACCOUNT_CODES.SOFTWARE_EXPENSE, description: 'Storefront, analytics, apps, and ecommerce software.' }, ...common],
  developer: [{ label: 'Software and cloud', accountCode: V2_ACCOUNT_CODES.SOFTWARE_EXPENSE, description: 'Hosting, cloud infrastructure, SaaS, and developer tools.' }, { label: 'Client delivery costs', accountCode: V2_ACCOUNT_CODES.EXPENSES, description: 'Direct costs incurred to deliver a client project.' }, ...common],
  agency: [{ label: 'Campaign delivery costs', accountCode: V2_ACCOUNT_CODES.EXPENSES, description: 'Direct media, production, and delivery costs assigned to client work.' }, { label: 'Contractors and freelancers', accountCode: V2_ACCOUNT_CODES.WAGES_EXPENSE, description: 'External specialists engaged for client delivery.' }, { label: 'Advertising and acquisition', accountCode: V2_ACCOUNT_CODES.ADVERTISING_EXPENSE, description: 'Agency lead generation and business development spend.' }, ...common],
  accounting_practice: [{ label: 'Practice software', accountCode: V2_ACCOUNT_CODES.SOFTWARE_EXPENSE, description: 'Practice management, tax, bookkeeping, and document software.' }, { label: 'Client delivery costs', accountCode: V2_ACCOUNT_CODES.EXPENSES, description: 'Direct costs assigned to client engagements.' }, ...common],
  it_freelancer: [{ label: 'Software and cloud', accountCode: V2_ACCOUNT_CODES.SOFTWARE_EXPENSE, description: 'Hosting, cloud infrastructure, SaaS, and developer tools.' }, { label: 'Client delivery costs', accountCode: V2_ACCOUNT_CODES.EXPENSES, description: 'Direct costs incurred to deliver a client project.' }, ...common],
  content_creator: [{ label: 'Creator production costs', accountCode: V2_ACCOUNT_CODES.CREATOR_EXPENSE, description: 'Production, editing, props, talent, and campaign delivery costs.' }, { label: 'Platform fees', accountCode: V2_ACCOUNT_CODES.MARKETPLACE_FEES, description: 'Platform commissions and payout processing charges.' }, { label: 'Advertising and acquisition', accountCode: V2_ACCOUNT_CODES.ADVERTISING_EXPENSE, description: 'Audience-growth and campaign acquisition spend.' }, ...common],
  manufacturer: [{ label: 'Factory overhead', accountCode: V2_ACCOUNT_CODES.MANUFACTURING_OVERHEAD, description: 'Utilities, factory rent, indirect labour, and production overhead.' }, { label: 'Freight and inbound logistics', accountCode: V2_ACCOUNT_CODES.FREIGHT_EXPENSE, description: 'Inbound freight and handling costs related to production inputs.' }, ...common],
  restaurant: [{ label: 'Ingredients and food supplies', accountCode: V2_ACCOUNT_CODES.COGS, description: 'Food, beverage, packaging, and ingredients consumed in sales.' }, { label: 'Kitchen and service wages', accountCode: V2_ACCOUNT_CODES.WAGES_EXPENSE, description: 'Kitchen, service, and casual labour costs.' }, { label: 'Delivery and platform fees', accountCode: V2_ACCOUNT_CODES.MARKETPLACE_FEES, description: 'Delivery apps, payment processing, and ordering platform fees.' }, { label: 'Food wastage', accountCode: V2_ACCOUNT_CODES.EXPENSES, description: 'Spoilage, wastage, and approved inventory write-offs.' }, ...common],
  healthcare: [{ label: 'Clinical supplies', accountCode: V2_ACCOUNT_CODES.COGS, description: 'Consumables and supplies used to deliver patient services.' }, { label: 'Practitioner and team wages', accountCode: V2_ACCOUNT_CODES.WAGES_EXPENSE, description: 'Practitioner, nursing, reception, and support labour.' }, { label: 'Practice software', accountCode: V2_ACCOUNT_CODES.SOFTWARE_EXPENSE, description: 'Scheduling, records, billing, and practice management software.' }, ...common],
  education: [{ label: 'Teaching and program delivery', accountCode: V2_ACCOUNT_CODES.COGS, description: 'Direct costs of delivering classes, courses, and programs.' }, { label: 'Educator and team wages', accountCode: V2_ACCOUNT_CODES.WAGES_EXPENSE, description: 'Teaching, administration, and support labour.' }, { label: 'Learning software', accountCode: V2_ACCOUNT_CODES.SOFTWARE_EXPENSE, description: 'Learning platforms, content tools, and classroom software.' }, ...common],
  import_export: [{ label: 'Freight and inbound logistics', accountCode: V2_ACCOUNT_CODES.FREIGHT_EXPENSE, description: 'Freight, forwarding, port, and handling charges.' }, { label: 'Duties and customs', accountCode: V2_ACCOUNT_CODES.DUTIES_EXPENSE, description: 'Customs duties and import clearance charges.' }, { label: 'Shipping and fulfilment', accountCode: V2_ACCOUNT_CODES.SHIPPING_EXPENSE, description: 'Outbound shipping, packing, and delivery costs.' }, ...common],
  legal: [{ label: 'Matter delivery costs', accountCode: V2_ACCOUNT_CODES.EXPENSES, description: 'Direct costs assigned to legal matters.' }, { label: 'Legal research and practice software', accountCode: V2_ACCOUNT_CODES.SOFTWARE_EXPENSE, description: 'Research, document, billing, and practice software.' }, { label: 'Matter contractors', accountCode: V2_ACCOUNT_CODES.WAGES_EXPENSE, description: 'Paralegal, expert, and contract professional costs.' }, ...common],
  nonprofit: [{ label: 'Program delivery costs', accountCode: V2_ACCOUNT_CODES.COGS, description: 'Direct costs of delivering nonprofit programs and services.' }, { label: 'Fundraising and campaigns', accountCode: V2_ACCOUNT_CODES.ADVERTISING_EXPENSE, description: 'Fundraising, donor acquisition, and campaign costs.' }, { label: 'Grant administration', accountCode: V2_ACCOUNT_CODES.EXPENSES, description: 'Costs of managing grants, compliance, and reporting.' }, ...common],
  real_estate: [{ label: 'Property maintenance', accountCode: V2_ACCOUNT_CODES.EXPENSES, description: 'Repairs, maintenance, service contracts, and property operations.' }, { label: 'Leasing and property marketing', accountCode: V2_ACCOUNT_CODES.ADVERTISING_EXPENSE, description: 'Leasing commissions, listings, and property marketing.' }, { label: 'Property management', accountCode: V2_ACCOUNT_CODES.WAGES_EXPENSE, description: 'Property management and on-site operations.' }, ...common],
  construction: [{ label: 'Materials and job costs', accountCode: V2_ACCOUNT_CODES.COGS, description: 'Materials consumed and direct costs assigned to construction jobs.' }, { label: 'Subcontractors', accountCode: V2_ACCOUNT_CODES.WAGES_EXPENSE, description: 'Subcontractor and trade labour assigned to jobs.' }, { label: 'Equipment and site logistics', accountCode: V2_ACCOUNT_CODES.FREIGHT_EXPENSE, description: 'Equipment hire, haulage, and site logistics.' }, ...common],
  agriculture: [{ label: 'Seed, feed, and farm inputs', accountCode: V2_ACCOUNT_CODES.COGS, description: 'Seed, feed, fertilizer, chemicals, and production inputs.' }, { label: 'Farm labour', accountCode: V2_ACCOUNT_CODES.WAGES_EXPENSE, description: 'Seasonal, field, and farm labour costs.' }, { label: 'Freight and harvest logistics', accountCode: V2_ACCOUNT_CODES.FREIGHT_EXPENSE, description: 'Harvest transport, storage, and delivery logistics.' }, ...common],
  automotive: [{ label: 'Parts and consumables', accountCode: V2_ACCOUNT_CODES.COGS, description: 'Parts, fluids, and consumables used on service orders.' }, { label: 'Workshop labour', accountCode: V2_ACCOUNT_CODES.WAGES_EXPENSE, description: 'Mechanic, technician, and service labour.' }, { label: 'Warranty and rework', accountCode: V2_ACCOUNT_CODES.RETURNS_EXPENSE, description: 'Warranty claims, rework, and approved service adjustments.' }, ...common],
  hospitality: [{ label: 'Room and guest supplies', accountCode: V2_ACCOUNT_CODES.COGS, description: 'Guest amenities, room supplies, and direct hospitality costs.' }, { label: 'Housekeeping and service wages', accountCode: V2_ACCOUNT_CODES.WAGES_EXPENSE, description: 'Housekeeping, front desk, kitchen, and service labour.' }, { label: 'Booking platform fees', accountCode: V2_ACCOUNT_CODES.MARKETPLACE_FEES, description: 'Booking, channel, payment, and platform commissions.' }, ...common],
  retail: [...sharedCommerce, { label: 'POS cash variance', accountCode: V2_ACCOUNT_CODES.POS_VARIANCE, description: 'Approved till shortages, overages, and cash-count variance.' }, ...common],
  wholesale: [...sharedCommerce, { label: 'Freight and inbound logistics', accountCode: V2_ACCOUNT_CODES.FREIGHT_EXPENSE, description: 'Inbound freight and warehouse handling.' }, ...common],
  vendor: [...sharedCommerce, { label: 'Freight and inbound logistics', accountCode: V2_ACCOUNT_CODES.FREIGHT_EXPENSE, description: 'Inbound freight and delivery handling.' }, ...common],
  entrepreneur: [...sharedCommerce, ...common],
  small_business: common,
  solo_founder: [{ label: 'Software and tools', accountCode: V2_ACCOUNT_CODES.SOFTWARE_EXPENSE, description: 'Business software, subscriptions, and productivity tools.' }, { label: 'Advertising and acquisition', accountCode: V2_ACCOUNT_CODES.ADVERTISING_EXPENSE, description: 'Customer acquisition and growth spend.' }, ...common],
  mobile_invoicing: common,
  professional_service: common,
  handyman: [...common, { label: 'Materials and job costs', accountCode: V2_ACCOUNT_CODES.EXPENSES, description: 'Materials and subcontractor costs assigned to jobs.' }],
  salon: [...common, { label: 'Supplies and consumables', accountCode: V2_ACCOUNT_CODES.EXPENSES, description: 'Consumables used to deliver salon services.' }],
  personal: [{ label: 'General personal expense', accountCode: V2_ACCOUNT_CODES.EXPENSES, description: 'Personal spending recorded outside business operations.' }],
  custom: common,
};

export function expenseCategoryOptionsForPersona(persona: PersonaId): ExpenseCategoryOption[] {
  return PERSONA_EXPENSE_CATEGORIES[persona] || common;
}

export function accountCodeForExpenseCategory(category: string): string {
  const normalized = category.trim().toLocaleLowerCase();
  const option = Object.values(PERSONA_EXPENSE_CATEGORIES).flatMap((items) => items || []).find((item) => item.label.toLocaleLowerCase() === normalized);
  return option?.accountCode || V2_ACCOUNT_CODES.EXPENSES;
}
