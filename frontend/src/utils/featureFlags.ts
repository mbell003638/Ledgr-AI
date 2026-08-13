export type FeatureKey =
  | "sales"
  | "bills"
  | "receipts"
  | "payments"
  | "cashbook"
  | "invoices"
  | "quotes"
  | "delivery"
  | "expenses"
  | "inventory"
  | "assets"
  | "daybook"
  | "reports"
  | "monthly"
  | "ask"
  | "voice";

export interface FeatureMeta {
  key: FeatureKey;
  label: string;
  category: "sales" | "purchases" | "accounting" | "ai";
  icon: string;
  color: string;
  description: string;
  defaultForPersonas?: string[];
}

export const ALL_FEATURES: FeatureMeta[] = [
  {
    key: "sales",
    label: "Sales (Cash Sales)",
    category: "sales",
    icon: "trending-up-outline",
    color: "#F3E4C8",
    description: "Record instant cash sales & walk-in customer transactions.",
  },
  {
    key: "invoices",
    label: "Invoices & Billing",
    category: "sales",
    icon: "document-text-outline",
    color: "#D8E4F0",
    description: "Issue professional credit invoices and track receivables.",
  },
  {
    key: "quotes",
    label: "Quotes & Estimates",
    category: "sales",
    icon: "pricetags-outline",
    color: "#E0E8F0",
    description: "Create customer estimates and convert them into invoices.",
  },
  {
    key: "receipts",
    label: "Customer Receipts",
    category: "sales",
    icon: "receipt-outline",
    color: "#F0E4D0",
    description: "Record customer payments against invoices or as party advances.",
  },
  {
    key: "delivery",
    label: "Delivery Notes",
    category: "sales",
    icon: "cube-outline",
    color: "#DCE4DC",
    description: "Issue delivery challans and track goods dispatch.",
  },
  {
    key: "bills",
    label: "Purchases & Vendor Bills",
    category: "purchases",
    icon: "receipt-outline",
    color: "#D6E5DB",
    description: "Record supplier bills, stock purchases, and payables.",
  },
  {
    key: "payments",
    label: "Supplier Payments & Capital Withdrawals",
    category: "purchases",
    icon: "cash-outline",
    color: "#E8DAD0",
    description: "Pay suppliers and track capital withdrawals consistently.",
  },
  {
    key: "expenses",
    label: "Business Expenses",
    category: "purchases",
    icon: "wallet-outline",
    color: "#E4D8D8",
    description: "Track operational expenses (rent, utilities, supplies).",
  },
  {
    key: "inventory",
    label: "Inventory & Stock Counts",
    category: "accounting",
    icon: "cube-outline",
    color: "#E3E9DA",
    description: "Manage product stock, stock valuations, and COGS counts.",
  },
  {
    key: "cashbook",
    label: "Cash Book",
    category: "accounting",
    icon: "swap-vertical-outline",
    color: "#DCE8DC",
    description: "Live record of all cash, bank, and card money movements.",
  },
  {
    key: "assets",
    label: "Assets & Liabilities",
    category: "accounting",
    icon: "pie-chart-outline",
    color: "#D0D8E0",
    description: "Track business capital, fixed assets, and loans.",
  },
  {
    key: "daybook",
    label: "Day Book Ledger",
    category: "accounting",
    icon: "book-outline",
    color: "#DDE3EC",
    description: "Daily accounting journal of all recorded transactions.",
  },
  {
    key: "reports",
    label: "Financial Reports",
    category: "accounting",
    icon: "bar-chart-outline",
    color: "#E0E0DA",
    description: "View Profit & Loss, Balance Sheet, and Trial Balance.",
  },
  {
    key: "monthly",
    label: "Monthly Summary",
    category: "accounting",
    icon: "calendar-outline",
    color: "#EFDCC8",
    description: "Monthly financial health breakdown and performance.",
  },
  {
    key: "ask",
    label: "Ask AI Finance Chat",
    category: "ai",
    icon: "sparkles-outline",
    color: "#D0E0D8",
    description: "AI-powered financial insights and tax assistance.",
  },
  {
    key: "voice",
    label: "Voice AI Assistant",
    category: "ai",
    icon: "mic-outline",
    color: "#1C4030",
    description: "Hands-free voice entry for sales, bills, and expenses.",
  },
];

const DEFAULT_ALL_KEYS: FeatureKey[] = ALL_FEATURES.map((f) => f.key);

// Baseline tile set for a pure service/professional persona: no stock, no
// supplier bills lead — invoice + receipt driven.
const SERVICE_BASE: FeatureKey[] = [
  "invoices",
  "quotes",
  "receipts",
  "expenses",
  "cashbook",
  "daybook",
  "reports",
  "monthly",
  "ask",
  "voice",
];

/**
 * Default enabled tiles per persona.
 *
 * Keyed by the canonical `PersonaId` values written by onboarding/settings
 * (src/accountingV2/config.ts): retail, wholesale, salon, handyman,
 * professional_service, it_freelancer, vendor, custom.
 *
 * The legacy `BizType` keys (shop, service, it_consultant, freelancer) are
 * kept as aliases so any settings written by the older onboarding flow that
 * saved `businessType` still resolve to a sensible set.
 */
export const PERSONA_DEFAULT_FEATURES: Record<string, FeatureKey[]> = {
  // --- Canonical PersonaId keys ---
  // Personal finance: focus on expenses, budget, cashbook, income, payees, and reports.
  personal: [
    "expenses",
    "cashbook",
    "sales",
    "receipts",
    "reports",
    "monthly",
    "ask",
    "voice",
    "assets",
  ],
  // Retail & wholesale hold stock and buy from suppliers → full set.
  retail: DEFAULT_ALL_KEYS,
  wholesale: DEFAULT_ALL_KEYS,
  vendor: DEFAULT_ALL_KEYS,
  // Salon sells services + walk-in cash, no inventory/delivery.
  salon: [
    "sales",
    "receipts",
    "expenses",
    "cashbook",
    "invoices",
    "daybook",
    "reports",
    "monthly",
    "ask",
    "voice",
  ],
  // Handyman: jobs & materials — cash sales + invoices, buys some materials,
  // but no shelf inventory.
  handyman: [
    "sales",
    "invoices",
    "expenses",
    "cashbook",
    "receipts",
    "bills",
    "daybook",
    "reports",
    "monthly",
    "ask",
    "voice",
  ],
  // Pure service personas — invoice-led, no stock.
  professional_service: SERVICE_BASE,
  it_freelancer: SERVICE_BASE,
  custom: DEFAULT_ALL_KEYS,

  // --- Legacy BizType aliases (older onboarding wrote `businessType`) ---
  shop: DEFAULT_ALL_KEYS,
  service: SERVICE_BASE,
  it_consultant: SERVICE_BASE,
  freelancer: SERVICE_BASE,
};

/**
 * Resolve the persona baseline tile set for a settings object, honouring the
 * multi-persona case: when the user selected several personas in onboarding,
 * the baseline is the UNION of each persona's default set (preserving the
 * canonical ALL_FEATURES ordering so the grid stays stable).
 *
 * Precedence of sources:
 *   1. settings.selectedPersonas  (multi-persona union)
 *   2. settings.activePersona     (single persona)
 *   3. settings.businessType      (legacy single persona)
 *   4. "custom"                   (everything)
 */
export function getPersonaBaselineFeatures(settings: any): FeatureKey[] {
  const personas: string[] = Array.isArray(settings?.selectedPersonas) && settings.selectedPersonas.length
    ? settings.selectedPersonas
    : [settings?.activePersona || settings?.businessType || "custom"];

  const union = new Set<FeatureKey>();
  for (const p of personas) {
    const set = PERSONA_DEFAULT_FEATURES[p] || DEFAULT_ALL_KEYS;
    for (const key of set) union.add(key);
  }
  // Preserve canonical ordering.
  return DEFAULT_ALL_KEYS.filter((k) => union.has(k));
}

export function getEnabledFeatures(settings: any): FeatureKey[] {
  // Manual override (Customize Features) always wins.
  if (settings && Array.isArray(settings.enabledFeatures) && settings.enabledFeatures.length > 0) {
    return settings.enabledFeatures as FeatureKey[];
  }
  return getPersonaBaselineFeatures(settings);
}

export function isFeatureEnabled(settings: any, key: FeatureKey): boolean {
  const enabled = getEnabledFeatures(settings);
  return enabled.includes(key);
}
