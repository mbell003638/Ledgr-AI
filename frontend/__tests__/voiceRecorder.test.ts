jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));

jest.mock('expo-audio', () => ({
  AudioModule: { requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })) },
  setAudioModeAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-file-system/legacy', () => ({
  readAsStringAsync: jest.fn(async () => 'YQ=='),
  EncodingType: { Base64: 'base64' },
}));

jest.mock('../src/utils/systemPrompt', () => ({
  runWithSystemPrompt: (operation: () => Promise<unknown>) => operation(),
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

  it('deduplicates concurrent starts before recorder preparation completes', async () => {
    let allowPermission!: (value: { granted: boolean }) => void;
    (AudioModule.requestRecordingPermissionsAsync as jest.Mock).mockImplementationOnce(
      () => new Promise((resolve) => { allowPermission = resolve; }),
    );
    const recorder = makeRecorder({ isRecording: false, canRecord: false });
    const first = startVoiceRecorder(recorder);
    const second = startVoiceRecorder(recorder);
    await new Promise((resolve) => setTimeout(resolve, 0));
    allowPermission({ granted: true });
    await Promise.all([first, second]);
    expect(AudioModule.requestRecordingPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(recorder.prepareToRecordAsync).toHaveBeenCalledTimes(1);
    expect(recorder.record).toHaveBeenCalledTimes(1);
  });

  it('recovers when Expo reports that the recorder was already prepared', async () => {
    const recorder = makeRecorder({ isRecording: false, canRecord: false });
    recorder.prepareToRecordAsync.mockRejectedValueOnce(new Error('AudioRecorder has already been prepared'));
    await expect(startVoiceRecorder(recorder)).resolves.toBeUndefined();
    expect(recorder.record).toHaveBeenCalledTimes(1);
  });

  it('recovers from Expo nested prepare rejection text', async () => {
    const recorder = makeRecorder({ isRecording: false, canRecord: false });
    const error: any = new Error("Call to function 'AudioRecorder.prepareToRecordAsync' has been rejected.");
    error.cause = { message: 'AudioRecorder has already been prepared. Stop or release the current session before preparing again.' };
    recorder.prepareToRecordAsync.mockRejectedValueOnce(error);
    await expect(startVoiceRecorder(recorder)).resolves.toBeUndefined();
    expect(recorder.stop).toHaveBeenCalled();
    expect(recorder.record).toHaveBeenCalledTimes(1);
  });

  it('does not record when microphone permission is denied', async () => {
    (AudioModule.requestRecordingPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
    const recorder = makeRecorder({ isRecording: false, canRecord: false });
    await expect(startVoiceRecorder(recorder)).rejects.toThrow('Microphone access is required');
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
