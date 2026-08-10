const SYSTEM_PROMPT_SETTLE_MS = 750;
export const APP_LOCK_BACKGROUND_DEBOUNCE_MS = 300;

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

/**
 * AppState can emit a short `background` transition while Android closes a
 * permission or biometric sheet. Defer locking long enough for the matching
 * `active` event to arrive, while still locking promptly when the user really
 * leaves the app.
 */
export function scheduleBackgroundLock(
  getAppState: () => string,
  onLock: () => void,
  delayMs = APP_LOCK_BACKGROUND_DEBOUNCE_MS,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (getAppState() === "background" && !isSystemPromptActive()) onLock();
  }, delayMs);
}
