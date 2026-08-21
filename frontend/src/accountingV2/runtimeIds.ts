let deterministicSeed: string | null = null;
let deterministicCounter = 0;
let replacementSourcePending = false;
let queue: Promise<void> = Promise.resolve();

function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 80);
}

/**
 * V2 services historically generated row IDs from wall-clock time and random
 * numbers. During sync replay that produced equivalent accounting with
 * different source/journal IDs on each device. This scope serializes only
 * mutation execution and derives every generated row ID from the immutable
 * operation ID instead.
 */
export async function withDeterministicAccountingIds<T>(operationId: string, apply: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const previous = queue;
  queue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  deterministicSeed = safe(operationId);
  deterministicCounter = 0;
  replacementSourcePending = false;
  try { return await apply(); }
  finally { deterministicSeed = null; deterministicCounter = 0; replacementSourcePending = false; release(); }
}

/** Reserve an exact operation-derived identity for the replacement source. */
export async function withDeterministicReplacementSourceId<T>(apply: () => Promise<T>): Promise<T> {
  if (!deterministicSeed) return apply();
  if (replacementSourcePending) throw new Error('A deterministic replacement source is already pending');
  replacementSourcePending = true;
  try { return await apply(); }
  finally { replacementSourcePending = false; }
}

export function accountingRuntimeId(prefix: string): string {
  if (deterministicSeed) {
    if (replacementSourcePending) {
      replacementSourcePending = false;
      return `replacement_${deterministicSeed}`;
    }
    const index = deterministicCounter++;
    return index === 0 ? deterministicSeed : `${safe(prefix)}_${deterministicSeed}_${index.toString(36)}`;
  }
  return `${safe(prefix)}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}
