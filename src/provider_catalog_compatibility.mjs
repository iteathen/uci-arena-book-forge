import { existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { probeProcessInstance, processIdentityFromJson, sameProcessInstance } from './process_identity.mjs';

const failure = () => new Error('Book catalog compatibility is unproven');
function regular(config) {
  const stat = lstatSync(config.paths.catalog);
  if (!stat.isFile() || stat.isSymbolicLink()) throw failure();
}
export function readBookCatalogVersion(config, { Database = DatabaseSync } = {}) {
  if (!existsSync(config.paths.catalog)) return 0;
  regular(config);
  const database = new Database(config.paths.catalog, { readOnly: true });
  try {
    const row = database.prepare("SELECT substr(value,1,17) AS value FROM metadata WHERE key='schema_version'").get();
    if (!['4', '5'].includes(row?.value)) throw failure();
    return Number(row.value);
  } finally { database.close(); }
}

// Exactly the reversible schema4→5 delta owned by this producer: one transient
// daemon identity column and the version marker. No historical data is reset.
// Caller must first prove task/daemon quiescence; this function independently
// rejects a live/unknown identity retained in schema5 before any schema change.
export function restoreBookCatalog4(config, { Database = DatabaseSync, probe = probeProcessInstance } = {}) {
  const version = readBookCatalogVersion(config, { Database });
  if (version === 0 || version === 4) return;
  regular(config);
  const database = new Database(config.paths.catalog);
  try {
    database.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    const marker = database.prepare("SELECT value FROM metadata WHERE key='schema_version'").get();
    if (marker?.value !== '5') throw failure();
    const column = database.prepare('PRAGMA table_info(daemon_state)').all().find(value => value.name === 'process_identity');
    if (!column || column.type !== 'TEXT' || column.notnull !== 1 || column.pk !== 0 || column.dflt_value !== "''") throw failure();
    const row = database.prepare('SELECT pid,process_identity FROM daemon_state WHERE singleton=1').get();
    const identity = processIdentityFromJson(row?.process_identity, row?.pid);
    if (row?.pid !== null) {
      if (!identity) throw failure();
      const current = probe(identity.pid);
      if (!(current.state === 'absent' || (current.state === 'present' &&
          processIdentityFromJson(current.identity, identity.pid) && !sameProcessInstance(identity, current.identity)))) throw failure();
    } else if (row?.process_identity !== '') throw failure();
    database.exec('ALTER TABLE daemon_state DROP COLUMN process_identity');
    database.prepare("UPDATE metadata SET value='4' WHERE key='schema_version'").run();
    database.exec('COMMIT');
  } catch {
    try { database.exec('ROLLBACK'); } catch {}
    throw failure();
  } finally { database.close(); }
}
