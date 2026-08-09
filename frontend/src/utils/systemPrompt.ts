const SYSTEM_PROMPT_SETTLE_MS = 750;

let activePromptCount = 0;
let lastPromptEndedAt = 0;

/**
 * Android can report permission, picker, and device-authentication sheets as
 * app background/active transitions. Keep the app-lock lifecycle gate from
 * interpreting those system-owned sheets as the user leaving Ledgr.
 */
export function isSystemPromptActive(): boolean {
  return activePromptCount > 0 || Date.now() - lastPromptEndedAt < SYSTEM_PROMPT_SETTLE_MS;
}

export async function runWithSystemPrompt<T>(operation: () => Promise<T>): Promise<T> {
  activePromptCount += 1;
  try {
    return await operation();
  } finally {
    activePromptCount = Math.max(0, activePromptCount - 1);
    lastPromptEndedAt = Date.now();
  }
}
