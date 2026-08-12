import { askHistoryStorageKey, MAX_ASK_HISTORY_MESSAGES, normalizeAskHistory } from '../src/utils/askHistory';

describe('Ask AI local history', () => {
  it('uses a separate storage key for each business book', () => {
    expect(askHistoryStorageKey('book-a')).not.toBe(askHistoryStorageKey('book-b'));
    expect(askHistoryStorageKey('book-a')).toContain('book-a');
  });

  it('drops malformed entries, trims text, and keeps only the newest messages', () => {
    const rows = Array.from({ length: MAX_ASK_HISTORY_MESSAGES + 5 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      text: ` message ${index} `,
    }));
    const normalized = normalizeAskHistory([null, { role: 'system', text: 'hidden' }, { role: 'user', text: '   ' }, ...rows]);
    expect(normalized).toHaveLength(MAX_ASK_HISTORY_MESSAGES);
    expect(normalized[0].text).toBe('message 5');
    expect(normalized.at(-1)).toEqual({ role: 'user', text: `message ${MAX_ASK_HISTORY_MESSAGES + 4}` });
  });
});
