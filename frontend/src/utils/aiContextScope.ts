type Snapshot = Record<string, any>;

const ACTION_INTENT = /\b(record|log|create|add|edit|update|delete|remove|reverse|void|pay|receive|invoice|bill|sale|expense|capital|withdraw|stock|payroll)\b/i;
const PARTY_INTENT = /\b(who|owes?|customer|supplier|vendor|debtor|creditor|invoice|receipt|payable|receivable)\b/i;
const DETAIL_INTENT = /\b(entry|entries|transaction|history|recent|latest|last|find|reference|delete|edit|reverse)\b/i;
const HELP_INTENT = /\b(how|where|help|settings?|feature|screen|button|navigate|can i|what is)\b/i;
const FINANCIAL_INTENT = /\b(profit|loss|cash|bank|sales?|purchases?|expense|inventory|stock|tax|balance|net worth|capital|payroll)\b/i;

function base(snapshot: Snapshot) {
  return {
    source: snapshot.source,
    currency: snapshot.currency,
    currencySymbol: snapshot.currencySymbol,
    businessName: snapshot.businessName,
  };
}

/**
 * Limit accounting data sent to the selected AI provider to what the question
 * needs. The full snapshot is built locally, then reduced before transmission.
 */
export function scopeAiSnapshot(snapshot: Snapshot, question: string): Snapshot {
  const q = String(question || "").trim();
  const common = base(snapshot);

  if (HELP_INTENT.test(q) && !FINANCIAL_INTENT.test(q) && !ACTION_INTENT.test(q)) {
    return { ...common, contextMode: "app_help" };
  }

  if (ACTION_INTENT.test(q) || DETAIL_INTENT.test(q)) {
    const recentEntries = Array.isArray(snapshot.recentEntries) ? snapshot.recentEntries.slice(0, 100) : [];
    return {
      ...common,
      contextMode: "transaction",
      snapshot: snapshot.snapshot,
      yearToDate: snapshot.yearToDate,
      parties: snapshot.parties,
      capitalAccounts: snapshot.capitalAccounts,
      openInvoices: snapshot.openInvoices,
      recentEntries,
      snapshotLimit: 100,
      snapshotTruncated: Boolean(snapshot.snapshotTruncated) || (snapshot.recentEntries?.length || 0) > recentEntries.length,
    };
  }

  if (PARTY_INTENT.test(q)) {
    return {
      ...common,
      contextMode: "business_accounts",
      snapshot: snapshot.snapshot,
      creditors: snapshot.creditors,
      debtors: snapshot.debtors,
      openInvoices: snapshot.openInvoices,
      parties: snapshot.parties,
    };
  }

  return { ...common, contextMode: "financial_summary", snapshot: snapshot.snapshot, yearToDate: snapshot.yearToDate, expensesByCategory: snapshot.expensesByCategory };
}
