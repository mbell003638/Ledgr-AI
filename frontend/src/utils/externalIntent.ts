/**
 * Contract for Android App Actions/deep links.
 * External invocations are navigation or draft requests only; they must never
 * write to the ledger directly. The receiving screen performs normal unlock,
 * validation, interpretation, and explicit confirmation.
 */
export type ExternalIntentTarget = "ask" | "voice" | "scan-import" | "draft";

export type ExternalDraftIntent = {
  target: "draft";
  action: "payment" | "expense" | "receipt" | "capital";
  text: string;
  amount?: number;
  currency?: string;
  date?: string;
  party?: string;
  method?: string;
  source: "assistant" | "deeplink";
};

export type ParsedExternalIntent =
  | { target: Exclude<ExternalIntentTarget, "draft">; source: "assistant" | "deeplink" }
  | ExternalDraftIntent;

const MAX_TEXT = 1000;
const TARGETS = new Set<ExternalIntentTarget>(["ask", "voice", "scan-import", "draft"]);
const ACTIONS = new Set<ExternalDraftIntent["action"]>(["payment", "expense", "receipt", "capital"]);

export function parseExternalIntent(input: unknown): ParsedExternalIntent | null {
  let value: Record<string, unknown>;
  if (typeof input === "string") {
    try {
      const url = new URL(input);
      const params = Object.fromEntries(url.searchParams.entries());
      const action = String(params.action || "");
      if (url.hostname === "assistant") {
        if (action === "open_ask_ai") return { target: "ask", source: "assistant" };
        if (action === "open_voice") return { target: "voice", source: "assistant" };
        if (action === "open_scanner") return { target: "scan-import", source: "assistant" };
        const actionMap: Record<string, ExternalDraftIntent["action"]> = {
          record_payment: "payment",
          record_expense: "expense",
          record_receipt: "receipt",
          add_capital: "capital",
        };
        const mappedAction = actionMap[action];
        if (!mappedAction) return null;
        const parts = [
          mappedAction.replace(/_/g, " "),
          params.amount,
          params.currency,
          params.counterparty || params.party,
          params.date,
          params.paymentMethod || params.method,
          params.note,
        ].filter(Boolean);
        value = {
          target: "draft",
          action: mappedAction,
          text: parts.join(" "),
          amount: params.amount ? Number(params.amount) : undefined,
          currency: params.currency,
          date: params.date,
          party: params.counterparty || params.party,
          method: params.paymentMethod || params.method,
          source: "assistant",
        };
      } else {
        value = { ...params, target: url.hostname || url.pathname.replace(/^\//, ""), source: "deeplink" };
      }
    } catch {
      return null;
    }
  } else if (input && typeof input === "object") {
    value = input as Record<string, unknown>;
  } else {
    return null;
  }
  const target = value.target;
  const source = value.source === "assistant" ? "assistant" : value.source === "deeplink" ? "deeplink" : null;
  if (typeof target !== "string" || !TARGETS.has(target as ExternalIntentTarget) || !source) return null;
  if (target !== "draft") return { target: target as Exclude<ExternalIntentTarget, "draft">, source };
  if (typeof value.action !== "string" || !ACTIONS.has(value.action as ExternalDraftIntent["action"])) return null;
  if (typeof value.text !== "string" || value.text.trim().length === 0 || value.text.length > MAX_TEXT) return null;
  const result: ExternalDraftIntent = { target: "draft", action: value.action as ExternalDraftIntent["action"], text: value.text.trim(), source };
  if (value.amount !== undefined) {
    if (typeof value.amount !== "number" || !Number.isFinite(value.amount) || value.amount <= 0 || value.amount > 1e9) return null;
    result.amount = value.amount;
  }
  for (const key of ["currency", "date", "party", "method"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "string" || value[key].length > 100) return null;
      result[key] = value[key] as never;
    }
  }
  return result;
}

export function externalIntentPath(intent: ParsedExternalIntent): string {
  if (intent.target === "draft") return "/ask";
  return intent.target === "scan-import" ? "/scan-import" : `/${intent.target}`;
}
