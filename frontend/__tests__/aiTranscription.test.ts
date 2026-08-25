import { askBooks, isNeutralTranscript, transcribe } from '../src/db/ai';

const response = (payload: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  text: async () => JSON.stringify(payload),
});

describe('voice transcription provider routing', () => {
  it('recognizes neutral microphone checks without treating them as accounting commands', () => {
    expect(isNeutralTranscript('test test')).toBe(true);
    expect(isNeutralTranscript('Test test.')).toBe(true);
    expect(isNeutralTranscript('record a sale for 20 dollars')).toBe(false);
    expect(isNeutralTranscript('what was my profit')).toBe(false);
  });
  const previousFetch = global.fetch;
  afterEach(() => {
    global.fetch = previousFetch;
    jest.restoreAllMocks();
  });

  it('bounds Ask AI chat output for faster structured responses', async () => {
    const fetchSpy = jest.fn().mockResolvedValue(response({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ answer: 'Your books are ready.', action: null }) }] } }],
    }));
    global.fetch = fetchSpy as any;

    await expect(askBooks({ provider: 'gemini', apiKey: 'test-key', model: 'gemini-3.6-flash' }, 'How do I open my reports?', '{}'))
      .resolves.toEqual({ answer: 'Your books are ready.', action: null });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.generationConfig.maxOutputTokens).toBe(700);
  });

  it('uses Gemini inline audio and returns the transcript', async () => {
    const fetchSpy = jest.fn().mockResolvedValue(response({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ transcript: 'record a sale for 20 dollars' }) }] } }],
    }));
    global.fetch = fetchSpy as any;

    await expect(transcribe({ provider: 'gemini', apiKey: 'test-key', model: 'gemini-3.6-flash' }, 'YQ==', 'audio/m4a'))
      .resolves.toEqual({ transcript: 'record a sale for 20 dollars' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.contents[0].parts[1]).toEqual({ inlineData: { mimeType: 'audio/m4a', data: 'YQ==' } });
  });

  it('uses the OpenAI-compatible audio transcription endpoint and separate voice model', async () => {
    const fetchSpy = jest.fn().mockResolvedValue(response({ text: 'record an expense for fuel' }));
    global.fetch = fetchSpy as any;

    await expect(transcribe({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'openai-chat-model',
      transcriptionModel: 'whisper-1',
      baseUrl: 'https://example.com/v1',
    }, 'YQ==', 'audio/m4a')).resolves.toEqual({ transcript: 'record an expense for fuel' });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/v1/audio/transcriptions',
      expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer test-key' } }),
    );
    const form = fetchSpy.mock.calls[0][1].body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  it('does not pretend Anthropic can transcribe audio and gives an actionable setup error', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;

    await expect(transcribe({ provider: 'anthropic', apiKey: 'test-key', model: 'claude-sonnet-4-6' }, 'YQ=='))
      .rejects.toThrow('Anthropic does not provide a speech-to-text endpoint');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
