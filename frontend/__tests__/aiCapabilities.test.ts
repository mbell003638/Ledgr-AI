import { getAICapabilities, resolveDocumentAnalysisRoute } from '../src/db/aiCapabilities';

describe('AI document capability routing', () => {
  const gemini = { provider: 'gemini' as const, apiKey: 'key', model: 'gemini-3.6-flash' };

  it('keeps text-only analysis local and provider independent', () => {
    expect(resolveDocumentAnalysisRoute({ provider: 'anthropic', apiKey: '' }, { hasText: true })).toBe('local-text');
  });

  it('routes configured image and Gemini PDF analysis to provider vision', () => {
    expect(resolveDocumentAnalysisRoute(gemini, { hasImage: true })).toBe('provider-vision');
    expect(resolveDocumentAnalysisRoute(gemini, { hasPdf: true })).toBe('provider-vision');
  });

  it('does not pretend unsupported providers can analyze documents', () => {
    expect(resolveDocumentAnalysisRoute({ provider: 'anthropic', apiKey: 'key' }, { hasPdf: true })).toBe('unsupported');
    expect(resolveDocumentAnalysisRoute({ provider: 'gemini', apiKey: '' }, { hasImage: true })).toBe('unsupported');
  });

  it('reports vision separately from chat configuration', () => {
    const capabilities = getAICapabilities({ provider: 'anthropic', apiKey: 'key' });
    expect(capabilities.chat.configured).toBe(true);
    expect(capabilities.vision.configured).toBe(true);
    expect(capabilities.transcription.configured).toBe(false);
  });
});
