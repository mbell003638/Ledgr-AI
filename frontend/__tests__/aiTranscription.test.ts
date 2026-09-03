jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  writeAsStringAsync: jest.fn(async () => undefined),
  EncodingType: { Base64: 'base64' },
}));

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
  const previousFormData = global.FormData;
  afterEach(() => {
    global.fetch = previousFetch;
    global.FormData = previousFormData;
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
    expect(body.contents[0].parts[1]).toEqual({ inlineData: { mimeType: 'audio/mp4', data: 'YQ==' } });
  });

  it('uses the OpenAI-compatible audio transcription endpoint and separate voice model', async () => {
    class NativeFormData {
      parts = new Map<string, unknown>();
      append(name: string, value: unknown) { this.parts.set(name, value); }
      get(name: string) { return this.parts.get(name); }
    }
    global.FormData = NativeFormData as any;
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
    const form = fetchSpy.mock.calls[0][1].body as NativeFormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('file')).toEqual({
      uri: 'file:///cache/ledgr-voice.m4a',
      name: 'ledgr-voice.m4a',
      type: 'audio/m4a',
    });
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

  it('does not pretend Anthropic can transcribe audio and gives an actionable setup error', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;

    await expect(transcribe({ provider: 'anthropic', apiKey: 'test-key', model: 'claude-sonnet-4-6' }, 'YQ=='))
      .rejects.toThrow('Anthropic does not include speech-to-text');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('lets Anthropic chat use a separate OpenAI-compatible voice endpoint', async () => {
    const fetchSpy = jest.fn().mockResolvedValue(response({ text: 'paid supplier 100 today' }));
    global.fetch = fetchSpy as any;

    await expect(transcribe({
      provider: 'anthropic',
      apiKey: 'anthropic-key',
      model: 'claude-sonnet-4-6',
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
});
