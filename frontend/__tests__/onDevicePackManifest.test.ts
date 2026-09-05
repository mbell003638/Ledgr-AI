import {
  APP_PACK_RUNTIME_VERSION,
  ON_DEVICE_PACK_SCHEMA,
  bundledPacks,
  parsePackManifest,
  parsePackRow,
} from '../src/accountingV2/onDevicePackManifest';

const validRow = {
  id: 'qwen25-1-5b',
  label: 'Qwen 2.5 1.5B',
  summary: 'text pack',
  bytes: 1_567_364_648,
  minRamBytes: 6 * 1024 ** 3,
  rank: 20,
  capabilities: ['text', 'tools'],
  filename: 'Qwen2.5-1.5B-Instruct_seq128_q8_ekv1280.task',
  downloadUrl: 'https://huggingface.co/litert-community/x/resolve/main/a.task',
};

const manifest = (packs: unknown[]) => ({ schema: ON_DEVICE_PACK_SCHEMA, packs });

describe('on-device pack manifest', () => {
  it('parses a well-formed manifest', () => {
    const packs = parsePackManifest(manifest([validRow]));
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({ id: 'qwen25-1-5b', rank: 20, vision: false });
  });

  it('derives the vision and audio flags from declared capabilities', () => {
    const pack = parsePackRow({ ...validRow, capabilities: ['text', 'vision'] });
    expect(pack).toMatchObject({ vision: true, audio: false });
    // The flags must never disagree with capabilities, or routing breaks.
    expect(pack!.capabilities.includes('vision')).toBe(pack!.vision);
  });

  it('rejects a manifest whose schema this build does not understand', () => {
    expect(parsePackManifest({ schema: 99, packs: [validRow] })).toEqual([]);
    expect(parsePackManifest({ packs: [validRow] })).toEqual([]);
  });

  it('skips packs that need a newer app than this one', () => {
    const future = { ...validRow, id: 'future', minAppVersion: APP_PACK_RUNTIME_VERSION + 1 };
    expect(parsePackManifest(manifest([validRow, future])).map((p) => p.id)).toEqual(['qwen25-1-5b']);
  });

  it('refuses a filename that could escape the models folder', () => {
    // The name becomes a path on the device, and the manifest is fetched over
    // the network, so traversal must be rejected rather than sanitised silently.
    expect(parsePackRow({ ...validRow, filename: '../../secrets.task' })).toBeNull();
    expect(parsePackRow({ ...validRow, filename: 'nested/model.task' })).toBeNull();
    expect(parsePackRow({ ...validRow, filename: 'a\\b.task' })).toBeNull();
  });

  it('refuses a download URL that is not https', () => {
    expect(parsePackRow({ ...validRow, downloadUrl: 'http://example.com/a.task' })).toBeNull();
    expect(parsePackRow({ ...validRow, downloadUrl: 'file:///etc/passwd' })).toBeNull();
    expect(parsePackRow({ ...validRow, downloadUrl: '' })).toBeNull();
  });

  it('drops rows missing an id, filename, or capability', () => {
    expect(parsePackRow({ ...validRow, id: '' })).toBeNull();
    expect(parsePackRow({ ...validRow, filename: '' })).toBeNull();
    expect(parsePackRow({ ...validRow, capabilities: [] })).toBeNull();
    expect(parsePackRow({ ...validRow, capabilities: ['nonsense'] })).toBeNull();
  });

  it('keeps only the first row for a duplicated id, so selection stays deterministic', () => {
    const packs = parsePackManifest(manifest([validRow, { ...validRow, label: 'Impostor' }]));
    expect(packs).toHaveLength(1);
    expect(packs[0].label).toBe('Qwen 2.5 1.5B');
  });

  it('survives junk without throwing', () => {
    for (const junk of [null, undefined, 'nope', 42, [], {}, { schema: 1 }, { schema: 1, packs: 'no' }]) {
      expect(parsePackManifest(junk)).toEqual([]);
    }
    expect(parsePackRow(null)).toBeNull();
    expect(parsePackRow('string')).toBeNull();
  });

  it('carries an optional sha256 through but never invents one', () => {
    expect(parsePackRow({ ...validRow, sha256: ' abc123 ' })?.sha256).toBe('abc123');
    expect(parsePackRow(validRow)?.sha256).toBeUndefined();
    expect(parsePackRow({ ...validRow, sha256: '   ' })?.sha256).toBeUndefined();
  });

  it('falls back to packs compiled into this build', () => {
    const packs = bundledPacks();
    expect(packs.length).toBeGreaterThan(0);
    // Whatever ships must itself satisfy the manifest rules.
    for (const pack of packs) expect(parsePackRow(pack)).not.toBeNull();
  });
});
