import fs from 'fs';
import path from 'path';
import {
  commandWithCreatedParty,
  parseVoicePartyCreateRole,
  resolveVoicePartyCommand,
  suggestedVoicePartyCreateRole,
  voiceCommandPartyName,
} from '../src/accountingV2/voicePartyResolution';

const directory = { suppliers: [], customers: [], capitalAccounts: [] };

describe('answering the unknown-party question with an affirmative', () => {
  const command = { intent: 'supplier_payment', amount: 100, supplierName: 'amit cash' } as never;

  it('reproduces the loop: the resolver alone re-asks the same question', () => {
    // "Yes" carries none of the words resolveVoicePartyCommand looks for, so it
    // returned the identical question no matter how many times it was answered.
    const first = resolveVoicePartyCommand(command, 'Paid 100 to amit cash', directory);
    const second = resolveVoicePartyCommand(command, 'Paid 100 to amit cash\nUser clarification: Yes', directory);
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (!first.ok && !second.ok) expect(second.question).toBe(first.question);
  });

  it('takes the recommended role from a plain "Yes"', () => {
    const suggested = suggestedVoicePartyCreateRole('supplier_payment');
    expect(parseVoicePartyCreateRole('Yes', suggested)).toBe('supplier');
    expect(parseVoicePartyCreateRole('I confirm', suggested)).toBe(null);
    expect(parseVoicePartyCreateRole('ok', suggested)).toBe('supplier');
  });

  it('still honours an explicit role over the recommendation', () => {
    const suggested = suggestedVoicePartyCreateRole('supplier_payment');
    expect(parseVoicePartyCreateRole('create customer', suggested)).toBe('customer');
    expect(parseVoicePartyCreateRole('supplier', suggested)).toBe('supplier');
  });

  it('produces a saveable command once the role is known', () => {
    const name = voiceCommandPartyName(command);
    const answered = commandWithCreatedParty(command, name, 'supplier');
    expect(answered.pendingPartyCreate).toEqual({ role: 'supplier', name: 'amit cash' });
    expect(answered.supplierName).toBe('amit cash');
  });
});

describe('the Ask screen wires those pieces together', () => {
  const screen = fs.readFileSync(path.join(__dirname, '..', 'app', 'ask.tsx'), 'utf8');

  it('answers a pending party clarification instead of re-resolving from text', () => {
    expect(screen).toContain('parseVoicePartyCreateRole(q, suggested)');
    expect(screen).toContain('commandWithCreatedParty(clarification.command, partyName, role)');
  });

  it('sends the text that is on screen, not a stale render value', () => {
    // Android commits the IME's last word on blur, which the send button causes,
    // so reading `input` from the closure dropped it.
    expect(screen).toContain('send(inputRef.current)');
    expect(screen).not.toContain('send(input)');
    expect(screen).toContain('onChangeText={updateInput}');
  });
});
