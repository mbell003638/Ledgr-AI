const native = { isAvailable: jest.fn(async () => true), recognize: jest.fn(async () => 'Paid $100 to Amit') };
jest.mock('react-native', () => ({ Platform: { OS: 'android' }, NativeModules: { LedgrLocalOcr: native } }));

import { getLocalOcrStatus, recognizeLocalOcr } from '@/src/utils/localOcr';

describe('local OCR boundary', () => {
  beforeEach(() => jest.clearAllMocks());
  it('reports native availability and extracts text', async () => {
    await expect(getLocalOcrStatus()).resolves.toEqual({ supported: true, available: true });
    await expect(recognizeLocalOcr('file:///receipt.jpg')).resolves.toBe('Paid $100 to Amit');
    expect(native.recognize).toHaveBeenCalledWith('file:///receipt.jpg', undefined);
  });
  it('rejects an empty image URI', async () => {
    await expect(recognizeLocalOcr('')).rejects.toThrow(/image is required/i);
  });

  it('keeps native OCR on a bounding-box line rebuild', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'modules', 'ledgr-native-ai', 'android', 'src', 'main', 'java', 'expo', 'modules', 'ledgrnativeai', 'LedgrLocalOcrModule.kt'), 'utf8');
    expect(source).toContain('formattedOcrText');
    expect(source).toContain('boundingBox');
  });
});
