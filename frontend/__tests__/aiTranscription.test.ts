import { transcribe } from '../src/db/ai';

const response = (payload: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  text: async () => JSON.stringify(payload),
});

describe('voice transcription provider routing', () => {
  const previousFetch = global.fetch;

  const previousFormData = global.FormData;
  afterEach(() => {
    global.fetch = previousFetch;
    jest.restoreAllMocks();
  });
    global.FormData = previousFormData;

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
  it('uses a native file URI instead of constructing an ArrayBuffer Blob', async () => {
    class NativeFormData {
      parts = new Map<string, unknown>();
      append(name: string, value: unknown) { this.parts.set(name, value); }
      get(name: string) { return this.parts.get(name); }
    }
    global.FormData = NativeFormData as any;
    const fetchSpy = jest.fn().mockResolvedValue(response({ text: 'paid supplier 100 today' }));
    global.fetch = fetchSpy as any;

    await expect(transcribe({
      provider: 'openai',
      apiKey: 'chat-key',
      model: 'chat-model',
      transcriptionModel: 'whisper-1',
      baseUrl: 'https://example.com/v1',
    }, 'YQ==', 'audio/m4a', 'file:///voice.m4a')).resolves.toEqual({ transcript: 'paid supplier 100 today' });

    const form = fetchSpy.mock.calls[0][1].body as NativeFormData;
    expect(form.get('file')).toEqual({
      uri: 'file:///voice.m4a',
      name: 'ledgr-voice.m4a',
      type: 'audio/m4a',
    });
    expect(form.get('model')).toBe('whisper-1');
  });

  it('explains when a chat host does not expose speech transcription', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: false, status: 404, statusText: 'Not Found', text: async () => '',
    });
    global.fetch = fetchSpy as any;
    await expect(transcribe({
      provider: 'openai', apiKey: 'key', model: 'chat-model', baseUrl: 'https://chat.example.com/v1',
    }, 'YQ==')).rejects.toThrow('Chat and voice use different capabilities');
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
