import { validateAIBaseUrl } from '@/src/db/ai';

describe('AI endpoint security', () => {
  test('accepts and normalizes HTTPS endpoints', () => {
    expect(validateAIBaseUrl(' https://example.com/v1/// ')).toBe('https://example.com/v1');
  });

  test('rejects non-local plaintext HTTP endpoints', () => {
    expect(() => validateAIBaseUrl('http://example.com/v1')).toThrow(/HTTPS/);
  });

  test('permits localhost HTTP for development', () => {
    expect(validateAIBaseUrl('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434/v1');
  });

  test('rejects embedded credentials', () => {
    expect(() => validateAIBaseUrl('https://user:secret@example.com/v1')).toThrow(/credentials/);
  });

  test('rejects the GitHub website when an API host is required', () => {
    expect(() => validateAIBaseUrl('https://github.com/v1')).toThrow(/not the github\.com website/);
    expect(validateAIBaseUrl('https://models.github.ai/inference')).toBe('https://models.github.ai/inference');
  });
});
