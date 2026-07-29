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
    label: "Supplier Payments & Drawings",
    category: "purchases",
    icon: "cash-outline",
    color: "#E8DAD0",
    description: "Pay vendors, track owner drawings, and partner payouts.",
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

export const PERSONA_DEFAULT_FEATURES: Record<string, FeatureKey[]> = {
  shop: DEFAULT_ALL_KEYS,
  vendor: DEFAULT_ALL_KEYS,
  service: [
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
  ],
  it_consultant: [
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
  ],
  freelancer: [
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
  ],
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
  handyman: [
    "sales",
    "invoices",
    "expenses",
    "cashbook",
    "receipts",
    "daybook",
    "reports",
    "monthly",
    "ask",
    "voice",
  ],
  custom: DEFAULT_ALL_KEYS,
};

export function getEnabledFeatures(settings: any): FeatureKey[] {
  if (settings && Array.isArray(settings.enabledFeatures) && settings.enabledFeatures.length > 0) {
    return settings.enabledFeatures as FeatureKey[];
  }
  const persona = settings?.activePersona || settings?.businessType || "custom";
  return PERSONA_DEFAULT_FEATURES[persona] || DEFAULT_ALL_KEYS;
}

export function isFeatureEnabled(settings: any, key: FeatureKey): boolean {
  const enabled = getEnabledFeatures(settings);
  return enabled.includes(key);
}
