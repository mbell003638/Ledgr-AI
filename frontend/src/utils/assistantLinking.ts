import * as Linking from 'expo-linking';
import { parseAssistantIntent, type AssistantIntentResult } from './assistantIntent';

/**
 * Installs the external Assistant URL handlers. Call from the root layout and
 * pass callbacks that already enforce app unlock and the normal draft review.
 * This helper intentionally has no navigation or ledger side effects.
 */
export function installAssistantLinkingHandlers(handlers: {
  onResult: (result: AssistantIntentResult) => void;
  onError?: (error: unknown) => void;
}): () => void {
  let disposed = false;
  const handleUrl = (url: string | null) => {
    if (disposed || !url) return;
    try {
      const result = parseAssistantIntent(url);
      handlers.onResult(result);
    } catch (error) {
      handlers.onError?.(error);
    }
  };

  void Linking.getInitialURL().then(handleUrl).catch((error) => handlers.onError?.(error));
  const subscription = Linking.addEventListener('url', ({ url }) => handleUrl(url));
  return () => {
    disposed = true;
    subscription.remove();
  };
}
