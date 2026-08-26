import { activePersonaFor } from '../utils/workspaceCapabilities';

export type ExpenseCategorySuggestion = {
  label: string;
  accountCode: string;
  description: string;
};

const COMMON: ExpenseCategorySuggestion[] = [
  { label: 'Rent', accountCode: '5100', description: 'Premises rent and occupancy.' },
  { label: 'Utilities', accountCode: '5100', description: 'Electricity, water, phone and internet.' },
  { label: 'Transport', accountCode: '5100', description: 'Local travel, fuel and delivery travel.' },
  { label: 'Software & Cloud', accountCode: '5100', description: 'Subscriptions, hosting and online tools.' },
  { label: 'Advertising', accountCode: '5100', description: 'Promotion and customer acquisition.' },
  { label: 'Wages', accountCode: '5100', description: 'Employee wages outside a recorded pay run.' },
];

const PERSONA_SUGGESTIONS: Record<string, ExpenseCategorySuggestion[]> = {
  retail: [
    { label: 'Packaging', accountCode: '5100', description: 'Bags, boxes and retail packaging.' },
    { label: 'Delivery Fees', accountCode: '5100', description: 'Courier and fulfilment costs.' },
  ],
  wholesale: [
    { label: 'Freight', accountCode: '5100', description: 'Inbound and outbound freight.' },
    { label: 'Warehouse', accountCode: '5100', description: 'Storage and warehouse running costs.' },
  ],
  salon: [
    { label: 'Salon Supplies', accountCode: '5100', description: 'Consumable beauty and hygiene supplies.' },
    { label: 'Laundry', accountCode: '5100', description: 'Towels, linen and cleaning.' },
  ],
  handyman: [
    { label: 'Tools & Repairs', accountCode: '5100', description: 'Small tools, repairs and maintenance.' },
    { label: 'Job Travel', accountCode: '5100', description: 'Travel directly related to customer jobs.' },
  ],
  professional_service: [
    { label: 'Professional Fees', accountCode: '5100', description: 'Legal, accounting and specialist advice.' },
    { label: 'Client Meetings', accountCode: '5100', description: 'Business meeting and client-service costs.' },
  ],
  it_freelancer: [
    { label: 'Software & Cloud', accountCode: '5100', description: 'Development tools, hosting and subscriptions.' },
    { label: 'Contractors', accountCode: '5100', description: 'Independent contractor costs.' },
  ],
};

export function expenseCategorySuggestions(settings: any): ExpenseCategorySuggestion[] {
  const persona = activePersonaFor(settings);
  const seen = new Set<string>();
  return [...(PERSONA_SUGGESTIONS[persona] || []), ...COMMON].filter((item) => {
    const key = item.label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
