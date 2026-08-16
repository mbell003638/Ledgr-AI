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
  developer: [{ label: 'Software and cloud', accountCode: V2_ACCOUNT_CODES.SOFTWARE_EXPENSE, description: 'Hosting, cloud infrastructure, SaaS, and developer tools.' }, { label: 'Client delivery costs', accountCode: V2_ACCOUNT_CODES.EXPENSES, description: 'Direct costs incurred to deliver a client project.' }, ...common],
  it_freelancer: [{ label: 'Software and cloud', accountCode: V2_ACCOUNT_CODES.SOFTWARE_EXPENSE, description: 'Hosting, cloud infrastructure, SaaS, and developer tools.' }, { label: 'Client delivery costs', accountCode: V2_ACCOUNT_CODES.EXPENSES, description: 'Direct costs incurred to deliver a client project.' }, ...common],
  content_creator: [{ label: 'Creator production costs', accountCode: V2_ACCOUNT_CODES.CREATOR_EXPENSE, description: 'Production, editing, props, talent, and campaign delivery costs.' }, { label: 'Platform fees', accountCode: V2_ACCOUNT_CODES.MARKETPLACE_FEES, description: 'Platform commissions and payout processing charges.' }, { label: 'Advertising and acquisition', accountCode: V2_ACCOUNT_CODES.ADVERTISING_EXPENSE, description: 'Audience-growth and campaign acquisition spend.' }, ...common],
  manufacturer: [{ label: 'Factory overhead', accountCode: V2_ACCOUNT_CODES.MANUFACTURING_OVERHEAD, description: 'Utilities, factory rent, indirect labour, and production overhead.' }, { label: 'Freight and inbound logistics', accountCode: V2_ACCOUNT_CODES.FREIGHT_EXPENSE, description: 'Inbound freight and handling costs related to production inputs.' }, ...common],
  import_export: [{ label: 'Freight and inbound logistics', accountCode: V2_ACCOUNT_CODES.FREIGHT_EXPENSE, description: 'Freight, forwarding, port, and handling charges.' }, { label: 'Duties and customs', accountCode: V2_ACCOUNT_CODES.DUTIES_EXPENSE, description: 'Customs duties and import clearance charges.' }, { label: 'Shipping and fulfilment', accountCode: V2_ACCOUNT_CODES.SHIPPING_EXPENSE, description: 'Outbound shipping, packing, and delivery costs.' }, ...common],
  retail: [...sharedCommerce, { label: 'POS cash variance', accountCode: V2_ACCOUNT_CODES.POS_VARIANCE, description: 'Approved till shortages, overages, and cash-count variance.' }, ...common],
  wholesale: [...sharedCommerce, { label: 'Freight and inbound logistics', accountCode: V2_ACCOUNT_CODES.FREIGHT_EXPENSE, description: 'Inbound freight and warehouse handling.' }, ...common],
  vendor: [...sharedCommerce, { label: 'Freight and inbound logistics', accountCode: V2_ACCOUNT_CODES.FREIGHT_EXPENSE, description: 'Inbound freight and delivery handling.' }, ...common],
  entrepreneur: [...sharedCommerce, ...common],
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
