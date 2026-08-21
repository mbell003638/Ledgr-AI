/**
 * Expo SQLite exposes one shared connection to the application. Serialize the
 * outermost sync/local mutation boundaries so independent savepoints can never
 * overlap and accidentally release or roll back one another.
 */
let databaseMutationTail: Promise<void> = Promise.resolve();

export async function withSyncDatabaseMutationLock<T>(apply: () => Promise<T>): Promise<T> {
  const previous = databaseMutationTail;
  let release!: () => void;
  databaseMutationTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await apply();
  } finally {
    release();
  }
}
