import { DatabaseSync } from 'node:sqlite';

const initializers = new Map();

/** Open a SQLite connection with durable metadata safety invariants enabled. */
export function openDatabase(databasePath) {
  const database = new DatabaseSync(databasePath, { allowExtension: false });
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const enabled = database.prepare('PRAGMA foreign_keys').get()?.foreign_keys;
  if (enabled !== 1) {
    database.close();
    throw new Error('SQLite foreign-key enforcement is unavailable');
  }
  return database;
}

/**
 * SQLite serializes writers across processes. This in-process queue also
 * keeps concurrent plugin initializers from even attempting the same ledger
 * transition twice.
 */
export async function serializeInitialization(databasePath, operation) {
  const prior = initializers.get(databasePath) || Promise.resolve();
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  const queued = prior.then(() => turn);
  initializers.set(databasePath, queued);
  await prior;
  try {
    return await operation();
  } finally {
    release();
    if (initializers.get(databasePath) === queued) initializers.delete(databasePath);
  }
}

export function closeDatabase(database) {
  if (database) database.close();
}
