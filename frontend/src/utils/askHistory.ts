export type AskHistoryMessage = { role: "user" | "assistant"; text: string };

export const MAX_ASK_HISTORY_MESSAGES = 100;

export function askHistoryStorageKey(bookId: string): string {
  return `ledgr:ask-history:${bookId || "default"}`;
}

export function normalizeAskHistory(value: unknown): AskHistoryMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is AskHistoryMessage => {
      if (!item || typeof item !== "object") return false;
      const row = item as Record<string, unknown>;
      return (row.role === "user" || row.role === "assistant") && typeof row.text === "string" && row.text.trim().length > 0;
    })
    .map((item) => ({ role: item.role, text: item.text.trim().slice(0, 8000) }))
    .slice(-MAX_ASK_HISTORY_MESSAGES);
}
