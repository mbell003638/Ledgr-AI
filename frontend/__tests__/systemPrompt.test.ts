import { isSystemPromptActive, runWithSystemPrompt } from '@/src/utils/systemPrompt';

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
});
