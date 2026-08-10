import {
  APP_LOCK_BACKGROUND_DEBOUNCE_MS,
  isSystemPromptActive,
  runWithSystemPrompt,
  scheduleBackgroundLock,
} from '@/src/utils/systemPrompt';

describe('system prompt lifecycle', () => {
  it('stays active while a prompt is open and briefly after it closes', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000);

    let finish!: () => void;
    const pending = runWithSystemPrompt(() => new Promise<void>((resolve) => {
      finish = resolve;
    }));

    expect(isSystemPromptActive()).toBe(true);
    finish();
    await pending;

    expect(isSystemPromptActive()).toBe(true);
    jest.advanceTimersByTime(751);
    expect(isSystemPromptActive()).toBe(false);
  });

  it('locks only when the app remains genuinely backgrounded', () => {
    jest.useFakeTimers();
    jest.setSystemTime(10_000);
    let appState = 'background';
    const onLock = jest.fn();

    scheduleBackgroundLock(() => appState, onLock);
    jest.advanceTimersByTime(APP_LOCK_BACKGROUND_DEBOUNCE_MS - 1);
    expect(onLock).not.toHaveBeenCalled();

    appState = 'active';
    jest.advanceTimersByTime(1);
    expect(onLock).not.toHaveBeenCalled();

    appState = 'background';
    scheduleBackgroundLock(() => appState, onLock);
    jest.advanceTimersByTime(APP_LOCK_BACKGROUND_DEBOUNCE_MS);
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('does not lock while an Android system prompt is active', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(20_000);
    let finish!: () => void;
    const pendingPrompt = runWithSystemPrompt(() => new Promise<void>((resolve) => {
      finish = resolve;
    }));
    const onLock = jest.fn();

    scheduleBackgroundLock(() => 'background', onLock);
    jest.advanceTimersByTime(APP_LOCK_BACKGROUND_DEBOUNCE_MS);
    expect(onLock).not.toHaveBeenCalled();

    finish();
    await pendingPrompt;
  });
});
