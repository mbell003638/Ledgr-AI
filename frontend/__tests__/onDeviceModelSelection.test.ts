import { selectOnDevicePack, type InstalledOnDevicePack } from '../src/utils/onDeviceLlm';
import { OPTIONAL_ON_DEVICE_MODELS } from '../src/accountingV2/onDeviceTools';

/** Builds a pack row in the shape listOptionalOnDeviceModels returns. */
function pack(id: string, over: Partial<InstalledOnDevicePack> = {}): InstalledOnDevicePack {
  const spec = OPTIONAL_ON_DEVICE_MODELS.find((row) => row.id === id);
  if (!spec) throw new Error(`unknown pack ${id}`);
  return { ...spec, installed: true, eligible: true, bytesOnDisk: spec.bytes, ...over } as InstalledOnDevicePack;
}

describe('on-device pack selection', () => {
  it('prefers the higher-ranked pack instead of the first one listed', () => {
    // The bug this replaces: selection took the first installed entry in array
    // order, so a phone holding both answered with the smaller, weaker pack
    // purely because it is listed first.
    const packs = [pack('qwen25-0-5b'), pack('qwen25-1-5b')];
    expect(packs[0].id).toBe('qwen25-0-5b');
    expect(selectOnDevicePack(packs)?.id).toBe('qwen25-1-5b');
  });

  it('never hands a vision task to a text-only pack', () => {
    const packs = [pack('qwen25-1-5b')];
    expect(selectOnDevicePack(packs, ['text'])?.id).toBe('qwen25-1-5b');
    expect(selectOnDevicePack(packs, ['vision'])).toBeNull();
  });

  it('picks the highest-ranked pack that has the needed capability', () => {
    const packs = [pack('qwen25-0-5b'), pack('qwen25-1-5b'), pack('phi4-mini')];
    expect(selectOnDevicePack(packs, ['tools'])?.id).toBe('phi4-mini');
  });

  it('has no pack claiming vision, so scans stay on local OCR', () => {
    // Only bundles MediaPipe can load are shipped, and none carry a vision
    // tower. Declaring vision here would route photos to a model that cannot
    // read them; ML Kit OCR handles receipts instead.
    const packs = OPTIONAL_ON_DEVICE_MODELS.map((spec) => pack(spec.id));
    expect(selectOnDevicePack(packs, ['vision'])).toBeNull();
  });

  it('honours a pinned pack over a higher-ranked one', () => {
    const packs = [pack('qwen25-1-5b'), pack('phi4-mini')];
    expect(selectOnDevicePack(packs, ['text'], 'qwen25-1-5b')?.id).toBe('qwen25-1-5b');
  });

  it('falls back to Auto when the pinned pack is not installed', () => {
    const packs = [pack('qwen25-1-5b'), pack('phi4-mini', { installed: false })];
    expect(selectOnDevicePack(packs, ['text'], 'phi4-mini')?.id).toBe('qwen25-1-5b');
  });

  it('falls back to Auto when the pinned pack cannot run on this phone', () => {
    const packs = [pack('qwen25-1-5b'), pack('phi4-mini', { eligible: false })];
    expect(selectOnDevicePack(packs, ['text'], 'phi4-mini')?.id).toBe('qwen25-1-5b');
  });

  it('never selects a pack the phone cannot run, even when installed', () => {
    const packs = [pack('phi4-mini', { eligible: false })];
    expect(selectOnDevicePack(packs)).toBeNull();
  });

  it('never selects a pack that is eligible but not installed', () => {
    const packs = [pack('phi4-mini', { installed: false })];
    expect(selectOnDevicePack(packs)).toBeNull();
  });

  it('returns null when nothing is installed, so Needle stays in charge', () => {
    expect(selectOnDevicePack([])).toBeNull();
  });

  it('does not mutate the caller list while ranking', () => {
    const packs = [pack('qwen25-1-5b'), pack('phi4-mini')];
    const before = packs.map((row) => row.id);
    selectOnDevicePack(packs);
    expect(packs.map((row) => row.id)).toEqual(before);
  });

  it('gives every catalogue pack a rank and capabilities', () => {
    for (const spec of OPTIONAL_ON_DEVICE_MODELS) {
      expect(typeof spec.rank).toBe('number');
      expect(spec.capabilities.length).toBeGreaterThan(0);
      // vision/audio flags and declared capabilities must not drift apart.
      expect(spec.capabilities.includes('vision')).toBe(spec.vision);
      expect(spec.capabilities.includes('audio')).toBe(spec.audio);
    }
  });

  it('points every pack at a real, ungated .task file', () => {
    // The shipped catalogue used to name .cact files that Cactus never
    // published, so every download returned 404. These URLs were verified to
    // return HTTP 200 with no auth; .task is the only container the Android
    // runtime (MediaPipe tasks-genai) can read, since LiteRT-LM has no
    // published Android artifact.
    for (const spec of OPTIONAL_ON_DEVICE_MODELS) {
      expect(spec.filename.endsWith('.task')).toBe(true);
      expect(spec.downloadUrl).toMatch(/^https:\/\/huggingface\.co\/litert-community\//);
      expect(spec.downloadUrl.endsWith(spec.filename)).toBe(true);
      expect(spec.downloadUrl).not.toContain('.cact');
      // Sizes are real content-lengths, so the free-space guard is meaningful.
      expect(spec.bytes).toBeGreaterThan(500 * 1024 * 1024);
      expect(Number.isInteger(spec.bytes)).toBe(true);
    }
  });

  it('keeps catalogue ranks unique so selection is deterministic', () => {
    const ranks = OPTIONAL_ON_DEVICE_MODELS.map((spec) => spec.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});
