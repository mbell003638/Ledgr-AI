import { DeviceSpeechError, DeviceSpeechSession, isDeviceSpeechAvailable } from '../src/utils/deviceSpeechRecognizer';

function bridge() {
  const listeners = new Map<string, (payload?: unknown) => void>();
  return {
    listeners,
    startListening: jest.fn(async () => undefined),
    cancelListening: jest.fn(async () => undefined),
    addListener: jest.fn((event: string, listener: (payload?: unknown) => void) => { listeners.set(event, listener); return { remove: () => listeners.delete(event) }; }),
  };
}

describe('device speech recognizer boundary', () => {
  it('reports unavailable without a native bridge', async () => { await expect(isDeviceSpeechAvailable(undefined)).resolves.toBe(false); });
  it('resolves final results and removes listeners', async () => {
    const native = bridge();
    const session = new DeviceSpeechSession(native);
    native.listeners.get('partial')?.('Paid 100');
    native.listeners.get('result')?.({ text: 'Paid 100 to Amit' });
    await expect(session.promise).resolves.toBe('Paid 100 to Amit');
    expect(native.listeners.size).toBe(0);
  });
  it('maps cancellation and permission errors', async () => {
    const native = bridge();
    const session = new DeviceSpeechSession(native);
    session.cancel();
    await expect(session.promise).rejects.toMatchObject({ code: 'CANCELLED' });
    const second = new DeviceSpeechSession(native);
    native.listeners.get('error')?.({ code: 'permission_denied' });
    await expect(second.promise).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(second.promise).rejects.toBeInstanceOf(DeviceSpeechError);
  });
});
