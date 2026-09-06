import fs from 'fs';
import path from 'path';
import {
  LEDGR_ON_DEVICE_TOOL_NAMES,
  LEDGR_ON_DEVICE_TOOL_PARAMETERS,
  ledgrOnDeviceToolContext,
  ledgrOnDeviceToolsJson,
} from '../src/accountingV2/onDeviceTools';

/**
 * scripts/on-device-ai/ledgr-tools.json is what Needle's weights were trained
 * against. needle_init is handed the runtime list, so if the two ever diverge
 * the model is being told about tools it does not know.
 */
const trainingSet = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'scripts', 'on-device-ai', 'ledgr-tools.json'), 'utf8'),
) as { name: string; parameters: Record<string, string> }[];

describe('the runtime tool list matches the one Needle was trained on', () => {
  it('is a bare array, which is what needle_init accepts', () => {
    const parsed = JSON.parse(ledgrOnDeviceToolsJson());
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('carries exactly the trained tools, in the trained order', () => {
    expect(LEDGR_ON_DEVICE_TOOL_NAMES).toEqual(trainingSet.map((tool) => tool.name));
  });

  it('declares each tool with the parameters it was trained on', () => {
    expect(JSON.parse(ledgrOnDeviceToolsJson())).toEqual(trainingSet);
  });

  it('never reintroduces the OpenAI-style wrapper needle_init rejects', () => {
    const raw = ledgrOnDeviceToolsJson(['Acme']);
    expect(raw).not.toContain('"type":"function"');
    expect(raw).not.toContain('additionalProperties');
    // partyHints and date used to ride inside the tool argument itself.
    expect(raw).not.toContain('partyHints');
    expect(raw).not.toContain('Acme');
  });

  it('every declared parameter type is one Needle emits', () => {
    const allowed = new Set(['string', 'number', 'boolean', 'object', 'array']);
    for (const [tool, params] of Object.entries(LEDGR_ON_DEVICE_TOOL_PARAMETERS)) {
      for (const [field, type] of Object.entries(params)) {
        expect(allowed.has(type)).toBe(true);
        expect(field).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/);
        expect(tool.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('per-call context travels with the transcript', () => {
  it('carries the date, the known parties and the rules', () => {
    const context = ledgrOnDeviceToolContext(['Acme', 'Rahim']);
    expect(context).toMatch(/^DATE: \d{4}-\d{2}-\d{2}$/m);
    expect(context).toContain('Acme, Rahim');
    expect(context).toMatch(/Call exactly one tool or none/);
    expect(context).toMatch(/Never invent invoice IDs/);
  });

  it('omits the party line when there are no hints', () => {
    expect(ledgrOnDeviceToolContext()).not.toContain('KNOWN PARTIES');
  });

  it('caps the hint list so a large book cannot flood the prompt', () => {
    const many = Array.from({ length: 30 }, (_, i) => `Party${i}`);
    const context = ledgrOnDeviceToolContext(many);
    expect(context).toContain('Party11');
    expect(context).not.toContain('Party12');
  });
});
