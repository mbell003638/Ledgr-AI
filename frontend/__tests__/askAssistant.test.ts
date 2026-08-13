import { askBooks, isClearlyExternalQuestion, isExplicitBookMutationRequest } from '../src/db/ai';

const geminiConfig = { provider: 'gemini' as const, apiKey: 'test-key', model: 'gemini-3.6-flash' };
const geminiResponse = (payload: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }),
});

describe('Ask AI assistant routing', () => {
  const previousFetch = global.fetch;
  afterEach(() => { global.fetch = previousFetch; jest.restoreAllMocks(); });

  it('keeps external live-information requests inside Ledgr and does not call the provider', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;

    await expect(askBooks(geminiConfig, 'What is Gift Nifty current price?', '{}')).resolves.toEqual({
      answer: 'Ledgr AI is focused on your business, bookkeeping, reports, and app workflows. I cannot provide live market, news, weather, or other external information.',
      action: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses the configured provider for app questions without enabling web search', async () => {
    const fetchSpy = jest.fn().mockResolvedValue(geminiResponse({ answer: 'Your cash balance is 500.', action: null }));
    global.fetch = fetchSpy as any;

    await expect(askBooks(geminiConfig, 'What is my cash balance?', '{"snapshot":{"cash":500}}')).resolves.toEqual({
      answer: 'Your cash balance is 500.',
      action: null,
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
    expect(body.generationConfig.responseFormat).toBeUndefined();
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.contents[0].parts[0].text).toContain('You are app-only');
  });

  it('drops hallucinated write actions for ordinary questions', async () => {
    const fetchSpy = jest.fn().mockResolvedValue(geminiResponse({ answer: 'It is 5:20 PM.', action: { type: 'add_expense', params: {}, confirm: 'Add it' } }));
    global.fetch = fetchSpy as any;

    await expect(askBooks(geminiConfig, 'What is the time?', '{}')).resolves.toEqual({
      answer: 'I can make that change, but please explicitly say what you want me to create, edit, reverse, or delete.',
      action: null,
    });
  });

  it('asks a counter-question when a paid-to request is misclassified as money received', async () => {
    const fetchSpy = jest.fn().mockResolvedValue(geminiResponse({ answer: 'Prepared.', action: { type: 'add_debtor_payment', params: { name: 'Amit', amount: 100 }, confirm: 'Record it' } }));
    global.fetch = fetchSpy as any;

    await expect(askBooks(geminiConfig, 'Paid $100 to Amit', '{}')).resolves.toEqual({
      answer: 'Is this an outgoing supplier payment, an expense, or another type of payment?',
      action: null,
    });
  });

  it('does not guess expense when a paid-to request has no accounting direction', async () => {
    const fetchSpy = jest.fn().mockResolvedValue(geminiResponse({ answer: 'Prepared.', action: { type: 'add_expense', params: { category: 'General', amount: 100 }, confirm: 'Record it' } }));
    global.fetch = fetchSpy as any;

    await expect(askBooks(geminiConfig, 'Paid $100 to Amit', '{}')).resolves.toEqual({
      answer: 'Is this an outgoing supplier payment, an expense, or another type of payment?',
      action: null,
    });
  });

  it('recognizes explicit natural-language writes and external topics', () => {
    expect(isExplicitBookMutationRequest('Record a 500 expense for fuel')).toBe(true);
    expect(isExplicitBookMutationRequest('Paid $100 to Amit')).toBe(true);
    expect(isExplicitBookMutationRequest('What was my profit this month?')).toBe(false);
    expect(isClearlyExternalQuestion('What is Gift Nifty current price?')).toBe(true);
    expect(isClearlyExternalQuestion('What is my inventory value?')).toBe(false);
  });
});
