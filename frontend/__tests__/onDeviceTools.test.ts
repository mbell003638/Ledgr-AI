import {
  LEDGR_ON_DEVICE_TOOL_NAMES,
  NEEDLE_GOLDEN_SET,
  ledgrOnDeviceToolsJson,
  needleGoldenGate,
  scoreNeedleGolden,
  toolCallToAskAction,
  toolCallToVoiceCommand,
} from '../src/accountingV2/onDeviceTools';
import { interpretVoiceTransaction } from '../src/accountingV2/voiceInterpretationRouter';
import { ASSISTANT_PROPOSAL_TYPES, validateAssistantProposal } from '../src/accountingV2/aiActions';

describe('on-device Ledgr tools', () => {
  it('exports the same tool names the assistant validator accepts', () => {
    expect([...LEDGR_ON_DEVICE_TOOL_NAMES].sort()).toEqual([...ASSISTANT_PROPOSAL_TYPES].sort());
  });

  it('keeps inventory_count deletes invalid after a Needle-shaped proposal', () => {
    const action = toolCallToAskAction({
      name: 'delete_entry',
      arguments: { entity: 'inventory_count', id: 'inv-1' },
    });
    expect(validateAssistantProposal(action, 'ai').ok).toBe(false);
  });

  it('maps expense tool calls into voice commands', () => {
    const command = toolCallToVoiceCommand({
      name: 'add_expense',
      arguments: { amount: 50, category: 'fuel', method: 'cash' },
    });
    expect(command).toMatchObject({ intent: 'expense', amount: 50, category: 'fuel', method: 'cash' });
  });

  it('does not invent an invoiceId for against-invoice receipts', () => {
    const command = toolCallToVoiceCommand({
      name: 'create_receipt',
      arguments: { amount: 200, customerName: 'Acme', mode: 'against_invoice' },
    });
    expect(command?.invoiceId).toBeUndefined();
  });

  it('prefers Needle when the local parser cannot read the utterance', async () => {
    const interpretation = await interpretVoiceTransaction({
      transcript: 'please book the usual thing for the shop',
      mode: 'device-only',
      hasCloudAI: false,
      parseCloud: async () => { throw new Error('cloud should not run'); },
      parseNeedle: async () => ({ intent: 'expense', amount: 40, category: 'fuel', summary: 'expense 40 fuel' }),
    });
    expect(interpretation).toMatchObject({ kind: 'command', source: 'needle', command: { intent: 'expense', amount: 40 } });
  });

  it('keeps a confident local parse ahead of Needle', async () => {
    const interpretation = await interpretVoiceTransaction({
      transcript: 'expense 50 fuel cash',
      mode: 'device-only',
      hasCloudAI: false,
      parseCloud: async () => { throw new Error('cloud should not run'); },
      parseNeedle: async () => ({ intent: 'sale', amount: 1, summary: 'wrong' }),
    });
    expect(interpretation).toMatchObject({ kind: 'command', source: 'local' });
  });

  it('scores the golden set labels and includes the tools JSON contract', () => {
    expect(ledgrOnDeviceToolsJson(['Acme']).length).toBeGreaterThan(20);
    const labeled = NEEDLE_GOLDEN_SET.map((row) => ({
      id: row.id,
      ok: scoreNeedleGolden(
        row.expected ? { name: row.expected.name, arguments: row.expected.required } : null,
        row.expected,
      ),
    }));
    const gate = needleGoldenGate(labeled);
    expect(gate.pass).toBe(true);
    expect(gate.rate).toBe(1);
  });
});
