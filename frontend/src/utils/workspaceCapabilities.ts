import { ALL_FEATURES, getEnabledFeatures, type FeatureKey } from './featureFlags';
import { PERSONAS } from '../accountingV2/config';

export type CapabilityKey =
  | 'sales_and_billing'
  | 'purchases_and_expenses'
  | 'core_accounting'
  | 'inventory_control'
  | 'reporting'
  | 'ai_assistance'
  | 'payroll'
  | 'multi_location';

export type CapabilityDefinition = {
  key: CapabilityKey;
  label: string;
  description: string;
  featureKeys: FeatureKey[];
};

export const CAPABILITIES: CapabilityDefinition[] = [
  { key: 'sales_and_billing', label: 'Sales & Billing', description: 'Sales, invoices, quotes, receipts and delivery.', featureKeys: ['sales', 'invoices', 'quotes', 'receipts', 'delivery'] },
  { key: 'purchases_and_expenses', label: 'Purchases & Expenses', description: 'Supplier bills, payments and operating expenses.', featureKeys: ['bills', 'payments', 'expenses'] },
  { key: 'core_accounting', label: 'Core Accounting', description: 'Cash Book, Day Book and Assets & Liabilities.', featureKeys: ['cashbook', 'daybook', 'assets'] },
  { key: 'inventory_control', label: 'Inventory', description: 'Periodic inventory and optional live product stock.', featureKeys: ['inventory', 'perpetualInventory'] },
  { key: 'reporting', label: 'Reports', description: 'Financial reports and monthly summaries.', featureKeys: ['reports', 'monthly'] },
  { key: 'ai_assistance', label: 'AI Assistance', description: 'Ask AI and the optional voice assistant.', featureKeys: ['ask', 'voice'] },
  { key: 'payroll', label: 'Payroll', description: 'Employees and pay runs.', featureKeys: ['payroll'] },
  { key: 'multi_location', label: 'Locations', description: 'Location-specific tills, stock and transfers.', featureKeys: ['locations'] },
];

export type OperationalModule = {
  key: FeatureKey;
  label: string;
  description: string;
  route: string;
  icon: string;
  capability: CapabilityKey;
  featured: boolean;
};

const FEATURE_ROUTES: Record<FeatureKey, string> = {
  sales: '/sales', bills: '/bills', receipts: '/receipts', payments: '/payments', cashbook: '/cashbook',
  invoices: '/invoices', quotes: '/quotes', delivery: '/delivery-notes', expenses: '/expenses', inventory: '/inventory-form',
  assets: '/assets', daybook: '/daybook', reports: '/(tabs)/reports', monthly: '/monthly-summary', ask: '/ask', voice: '/voice',
  payroll: '/payroll', perpetualInventory: '/products', locations: '/locations',
};

const FEATURE_CAPABILITY = new Map<FeatureKey, CapabilityKey>(
  CAPABILITIES.flatMap((capability) => capability.featureKeys.map((feature) => [feature, capability.key] as const)),
);

const FEATURED_LIMIT = 6;

export function activePersonaFor(settings: any): string {
  if (settings?.activePersona) return String(settings.activePersona);
  if (Array.isArray(settings?.selectedPersonas) && settings.selectedPersonas.length) return String(settings.selectedPersonas[0]);
  const legacy = String(settings?.businessType || 'custom');
  return legacy === 'shop' ? 'retail'
    : legacy === 'service' ? 'professional_service'
    : legacy === 'it_consultant' ? 'it_freelancer'
    : legacy === 'freelancer' ? 'it_freelancer'
    : legacy;
}

export function getEnabledCapabilities(settings: any): CapabilityKey[] {
  const enabled = new Set(getEnabledFeatures(settings));
  return CAPABILITIES.filter((capability) => capability.featureKeys.some((key) => enabled.has(key))).map((capability) => capability.key);
}

export function isCapabilityEnabled(settings: any, key: CapabilityKey): boolean {
  return getEnabledCapabilities(settings).includes(key);
}

export function operationalModulesFor(settings: any): OperationalModule[] {
  const enabled = new Set(getEnabledFeatures(settings));
  let featured = 0;
  return ALL_FEATURES.filter((feature) => enabled.has(feature.key)).map((feature) => {
    const isFeatured = featured < FEATURED_LIMIT;
    if (isFeatured) featured += 1;
    return {
      key: feature.key,
      label: feature.label,
      description: feature.description,
      route: FEATURE_ROUTES[feature.key],
      icon: feature.icon,
      capability: FEATURE_CAPABILITY.get(feature.key) || 'core_accounting',
      featured: isFeatured,
    };
  });
}

export type WorkspaceProfile = {
  persona: string;
  title: string;
  summary: string;
  featured: OperationalModule[];
  advanced: OperationalModule[];
};

export function getWorkspaceProfile(settings: any): WorkspaceProfile {
  const personaId = activePersonaFor(settings);
  const persona = PERSONAS.find((item) => item.id === personaId) || PERSONAS.find((item) => item.id === 'custom')!;
  const modules = operationalModulesFor(settings);
  return {
    persona: persona.id,
    title: persona.id === 'custom' ? 'Your Ledgr Workspace' : `${persona.label} Workspace`,
    summary: persona.description,
    featured: modules.filter((module) => module.featured),
    advanced: modules.filter((module) => !module.featured),
  };
}
