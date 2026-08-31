import { transcribe } from '../src/db/ai';

const response = (payload: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  text: async () => JSON.stringify(payload),
});

describe('voice transcription provider routing', () => {
  const previousFetch = global.fetch;

  afterEach(() => {
    global.fetch = previousFetch;
    jest.restoreAllMocks();
  });

  it('uses the OpenAI-compatible audio endpoint and separate voice model', async () => {
    const fetchSpy = jest.fn().mockResolvedValue(response({ text: 'record an expense for fuel' }));
    global.fetch = fetchSpy as any;

    await expect(transcribe({
      provider: 'openai',
      apiKey: 'chat-key',
      model: 'chat-model',
      transcriptionModel: 'whisper-1',
      baseUrl: 'https://example.com/v1',
    }, 'YQ==', 'audio/m4a')).resolves.toEqual({ transcript: 'record an expense for fuel' });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/v1/audio/transcriptions',
      expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer chat-key' } }),
    );
  });

  it('lets Anthropic chat use a separate OpenAI-compatible voice endpoint', async () => {
    const fetchSpy = jest.fn().mockResolvedValue(response({ text: 'paid supplier 100 today' }));
    global.fetch = fetchSpy as any;

    await expect(transcribe({
      provider: 'anthropic',
      apiKey: 'anthropic-key',
      model: 'claude-model',
      transcriptionModel: 'whisper-large-v3',
      transcriptionBaseUrl: 'https://speech.example.com/v1',
      transcriptionApiKey: 'speech-key',
    }, 'YQ==', 'audio/m4a')).resolves.toEqual({ transcript: 'paid supplier 100 today' });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://speech.example.com/v1/audio/transcriptions',
      expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer speech-key' } }),
    );
    expect((fetchSpy.mock.calls[0][1].body as FormData).get('model')).toBe('whisper-large-v3');
  });

  it('explains the missing speech endpoint without sending audio to Anthropic', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;

    await expect(transcribe({ provider: 'anthropic', apiKey: 'key', model: 'claude-model' }, 'YQ=='))
      .rejects.toThrow('Add a separate OpenAI-compatible voice Base URL');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
