import { askBooks, isExplicitBookMutationRequest, needsLiveInformationSearch } from '../src/db/ai';

const geminiConfig = { provider: 'gemini' as const, apiKey: 'test-key', model: 'gemini-3.6-flash' };

describe('Ask AI assistant routing', () => {
  const previousFetch = global.fetch;
  afterEach(() => { global.fetch = previousFetch; jest.restoreAllMocks(); });

  it('gives Gemini 3.6 access to Google Search and the device-local clock', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ answer: 'Current answer', action: null }) }] } }] }) });
    global.fetch = fetchSpy as any;
    await expect(askBooks(geminiConfig, 'What is the latest AI news?', '{}')).resolves.toEqual({ answer: 'Current answer', action: null });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.tools).toEqual([{ googleSearch: {} }]);
    expect(body.generationConfig.responseFormat.text.mimeType).toBe('application/json');
    expect(body.contents[0].parts[0].text).toMatch(/current device-local date and time is \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2} UTC[+-]\d{2}:\d{2}/);
  });

  it('drops hallucinated write actions for ordinary questions', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ answer: 'It is 5:20 PM.', action: { type: 'add_expense', params: {}, confirm: 'Add it' } }) }] } }] }) });
    global.fetch = fetchSpy as any;
    await expect(askBooks(geminiConfig, 'What is the time?', '{}')).resolves.toEqual({ answer: 'It is 5:20 PM.', action: null });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
  });

  it('keeps a valid action when the user explicitly asks to record it', () => {
    expect(isExplicitBookMutationRequest('Record a 500 expense for fuel')).toBe(true);
    expect(isExplicitBookMutationRequest('What is the time?')).toBe(false);
    expect(isExplicitBookMutationRequest('What was my profit this month?')).toBe(false);
    expect(needsLiveInformationSearch('What is the latest AI news?')).toBe(true);
    expect(needsLiveInformationSearch('What is the time?')).toBe(false);
  });
});
