jest.mock('expo-linking', () => ({
  getInitialURL: jest.fn(() => Promise.resolve('ledgr://assistant?action=open_ask_ai')),
  addEventListener: jest.fn(() => ({ remove: jest.fn() })),
}));

import * as Linking from 'expo-linking';
import { installAssistantLinkingHandlers } from '../src/utils/assistantLinking';

describe('Assistant URL lifecycle', () => {
  it('handles initial URLs and removes the subscription', async () => {
    const onResult = jest.fn();
    const dispose = installAssistantLinkingHandlers({ onResult });
    await Promise.resolve();
    expect(onResult).toHaveBeenCalledWith({ kind: 'navigation', target: 'ask-ai' });
    expect(Linking.addEventListener).toHaveBeenCalledWith('url', expect.any(Function));
    dispose();
  });
});
