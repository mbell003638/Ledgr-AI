const native = {
  isAvailable: jest.fn(async () => true),
  start: jest.fn(async () => undefined),
  stop: jest.fn(async () => undefined),
  cancel: jest.fn(async () => undefined),
  destroy: jest.fn(async () => undefined),
  addListener: jest.fn((event: string, listener: (payload: any) => void) => {
    listeners[event] = listener;
    return { remove: jest.fn() };
  }),
};
const listeners: Record<string, (payload: any) => void> = {};

jest.mock("react-native", () => ({
  Platform: { OS: "android" },
  NativeModules: { LedgrSpeechRecognizer: native },
}));

import { cancelDeviceSpeechRecognition, getDeviceSpeechStatus, startDeviceSpeechRecognition } from "@/src/utils/deviceSpeechRecognizer";

describe("device speech recognizer capability boundary", () => {
  beforeEach(() => {
    Object.values(listeners).forEach(() => undefined);
    jest.clearAllMocks();
  });

  it("reports native availability", async () => {
    await expect(getDeviceSpeechStatus()).resolves.toEqual({ supported: true, available: true });
  });

  it("forwards partial and final events and removes listeners once", async () => {
    const partial = jest.fn();
    const final = jest.fn();
    const stop = await startDeviceSpeechRecognition({ onPartial: partial, onFinal: final }, { locale: "en-CA" });
    listeners.partial({ text: "paid one" });
    listeners.final({ text: "Paid $1" });
    expect(partial).toHaveBeenCalledWith("paid one");
    expect(final).toHaveBeenCalledWith("Paid $1");
    await stop();
    await stop();
    expect(native.start).toHaveBeenCalledWith("en-CA");
    expect(native.stop).toHaveBeenCalledTimes(1);
  });

  it("maps busy start errors and supports cancel cleanup", async () => {
    native.start.mockRejectedValueOnce(new Error("recognizer is already busy"));
    await expect(startDeviceSpeechRecognition({})).rejects.toThrow("already running");
    await expect(cancelDeviceSpeechRecognition()).resolves.toBeUndefined();
    expect(native.cancel).toHaveBeenCalled();
    expect(native.destroy).toHaveBeenCalled();
  });
});
