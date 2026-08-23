jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));

jest.mock('expo-audio', () => ({
  AudioModule: {
    requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })),
  },
  setAudioModeAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-file-system/legacy', () => ({
  readAsStringAsync: jest.fn(async () => 'YQ=='),
  EncodingType: { Base64: 'base64' },
}));

import { AudioModule, setAudioModeAsync } from 'expo-audio';
import { cancelVoiceRecorder, captureVoiceRecording, startVoiceRecorder } from '../src/utils/voiceRecorder';

const makeRecorder = (status: { isRecording: boolean; canRecord: boolean }, uri: string | null = 'file:///voice.m4a') => ({
  getStatus: jest.fn(() => status),
  get isRecording() { return status.isRecording; },
  uri,
  prepareToRecordAsync: jest.fn(async () => { status.canRecord = true; }),
  record: jest.fn(() => { status.isRecording = true; }),
  stop: jest.fn(async () => { status.isRecording = false; }),
}) as any;

describe('voice recorder lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AudioModule.requestRecordingPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
  });

  it('prepares only when the recorder cannot already record', async () => {
    const status = { isRecording: false, canRecord: false };
    const recorder = makeRecorder(status);
    await startVoiceRecorder(recorder);
    expect(setAudioModeAsync).toHaveBeenCalledWith({ allowsRecording: true, playsInSilentMode: true });
    expect(recorder.prepareToRecordAsync).toHaveBeenCalledTimes(1);
    expect(recorder.record).toHaveBeenCalledTimes(1);

    status.isRecording = false;
    await startVoiceRecorder(recorder);
    expect(recorder.prepareToRecordAsync).toHaveBeenCalledTimes(1);
    expect(recorder.record).toHaveBeenCalledTimes(2);
  });

  it('does not record when microphone permission is denied', async () => {
    (AudioModule.requestRecordingPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
    const recorder = makeRecorder({ isRecording: false, canRecord: false });
    await expect(startVoiceRecorder(recorder)).rejects.toThrow('Microphone permission is required');
    expect(recorder.prepareToRecordAsync).not.toHaveBeenCalled();
    expect(recorder.record).not.toHaveBeenCalled();
  });

  it('cancels an active recording without surfacing cleanup errors', async () => {
    const recorder = makeRecorder({ isRecording: true, canRecord: true });
    await expect(cancelVoiceRecorder(recorder)).resolves.toBeUndefined();
    expect(recorder.stop).toHaveBeenCalledTimes(1);
  });

  it('rejects a stop when the recorder did not produce a URI', async () => {
    const recorder = makeRecorder({ isRecording: false, canRecord: true }, null);
    await expect(captureVoiceRecording(recorder)).rejects.toThrow('No audio was captured');
  });
});
