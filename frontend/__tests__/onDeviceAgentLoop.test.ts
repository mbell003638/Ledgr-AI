const runNeedle = jest.fn();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(async () => null), setItem: jest.fn(async () => undefined), removeItem: jest.fn(async () => undefined) },
}));
// nativeModule() returns null unless Platform.OS is android, so the engine has
// to be presented as it is on a device for the loop to be exercised at all.
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: { LedgrOnDeviceLlm: { runNeedle: (...args: unknown[]) => runNeedle(...args) } },
}));
jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => ({ runNeedle: (...args: unknown[]) => runNeedle(...args) }),
}));

import { NEEDLE_MAX_AGENT_STEPS, runNeedleAgentTurn } from '../src/utils/onDeviceLlm';

const toolCall = (name: string, args: Record<string, unknown> = {}) =>
  JSON.stringify([{ name, arguments: args }]);

describe('the on-device agent reads before it acts, and stops at a write', () => {
  beforeEach(() => runNeedle.mockReset());

  it('returns a write proposal immediately, without looping past it', async () => {
    // A write must reach validateAssistantProposal and the confirmation sheet.
    // Continuing the loop past it would be how an unconfirmed write escapes.
    runNeedle.mockResolvedValue(toolCall('add_expense', { amount: 50, category: 'fuel' }));
    const turn = await runNeedleAgentTurn('spent 50 on fuel', [], async () => 'unused');
    expect(turn.kind).toBe('write');
    expect(turn.steps).toBe(1);
    if (turn.kind === 'write') expect(turn.call.name).toBe('add_expense');
    expect(runNeedle).toHaveBeenCalledTimes(1);
  });

  it('runs a read and returns what the book actually said', async () => {
    runNeedle
      .mockResolvedValueOnce(toolCall('party_lookup', { query: 'Amit' }))
      .mockResolvedValueOnce('');
    const turn = await runNeedleAgentTurn('how much does Amit owe', [], async () => 'Amit (customer owes you): 100.00');
    expect(turn.kind).toBe('answer');
    if (turn.kind === 'answer') expect(turn.text).toContain('100.00');
  });

  it('feeds the read result back so the next step can build on it', async () => {
    runNeedle
      .mockResolvedValueOnce(toolCall('party_lookup', { query: 'Amit' }))
      .mockResolvedValueOnce(toolCall('report_query', { report: 'profit_and_loss' }))
      .mockResolvedValueOnce('');
    await runNeedleAgentTurn('how is Amit and my profit', [], async (call) => `${call.name} says hello`);
    const secondPrompt = String(runNeedle.mock.calls[1][0]);
    expect(secondPrompt).toContain('TOOL party_lookup RESULT: party_lookup says hello');
  });

  it('never exceeds the step cap, even if the model keeps asking to read', async () => {
    runNeedle.mockResolvedValue(toolCall('report_query', { report: 'profit_and_loss' }));
    const turn = await runNeedleAgentTurn('loop forever', [], async () => 'a figure');
    expect(runNeedle).toHaveBeenCalledTimes(NEEDLE_MAX_AGENT_STEPS);
    expect(turn.steps).toBe(NEEDLE_MAX_AGENT_STEPS);
  });

  it('reports nothing rather than inventing an answer', async () => {
    runNeedle.mockResolvedValue('');
    const turn = await runNeedleAgentTurn('mumble', [], async () => '');
    expect(turn.kind).toBe('none');
  });

  it('still answers when a later step declines but an earlier read produced something', async () => {
    runNeedle
      .mockResolvedValueOnce(toolCall('inventory_profit', {}))
      .mockResolvedValueOnce('');
    const turn = await runNeedleAgentTurn('stock profit', [], async () => 'gross profit 40.00');
    expect(turn.kind).toBe('answer');
    if (turn.kind === 'answer') expect(turn.text).toContain('40.00');
  });
});
