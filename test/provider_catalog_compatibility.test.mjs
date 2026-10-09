import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, realpath, lstat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readBookCatalogVersion, restoreBookCatalog4 } from '../src/provider_catalog_compatibility.mjs';

async function fixture(run) {
  const parent = await realpath(os.tmpdir()); const root = await mkdtemp(path.join(parent, 'book-schema-compat-'));
  const config = { paths: { catalog: path.join(root, 'catalog.sqlite') } };
  const database = new DatabaseSync(config.paths.catalog);
  database.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); INSERT INTO metadata VALUES('schema_version','5');" +
    "CREATE TABLE daemon_state(singleton INTEGER PRIMARY KEY,pid INTEGER,phase TEXT,process_identity TEXT NOT NULL DEFAULT '');" +
    "INSERT INTO daemon_state VALUES(1,NULL,'stopped',''); CREATE TABLE history(id TEXT,value TEXT); INSERT INTO history VALUES('kept','unchanged');");
  database.close();
  try { await run(config); } finally {
    const resolved = await realpath(root); const stat = await lstat(root);
    assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('book-schema-compat-'));
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink()); await rm(resolved, { recursive: true });
  }
}
test('schema5 to4 restores only owned transient delta and preserves all history; repeated restoration is inert', async () => {
  await fixture(config => {
    assert.equal(readBookCatalogVersion(config), 5); restoreBookCatalog4(config);
    assert.equal(readBookCatalogVersion(config), 4); restoreBookCatalog4(config);
    const db = new DatabaseSync(config.paths.catalog, { readOnly: true });
    try {
      assert.deepEqual({ ...db.prepare('SELECT * FROM history').get() }, { id: 'kept', value: 'unchanged' });
      assert.equal(db.prepare('PRAGMA table_info(daemon_state)').all().some(row => row.name === 'process_identity'), false);
    } finally { db.close(); }
  });
});
test('unknown schema or live/denied/untyped daemon identity rejects before any schema/history change', async () => {
  await fixture(config => {
    const identity = { schema: 'uci_arena_process_instance_identity_v1', platform: 'win32', pid: 123,
      start_token: '639000000000000000', executable_path: 'C:\\Node\\node.exe', boot_id: '' };
    const db = new DatabaseSync(config.paths.catalog);
    try { db.prepare('UPDATE daemon_state SET pid=123,process_identity=?').run(JSON.stringify(identity)); } finally { db.close(); }
    for (const observation of [{ state: 'unverifiable' }, { state: 'present', identity }]) {
      assert.throws(() => restoreBookCatalog4(config, { probe: () => observation })); assert.equal(readBookCatalogVersion(config), 5);
    }
    const changed = new DatabaseSync(config.paths.catalog);
    try { changed.exec("UPDATE metadata SET value='6' WHERE key='schema_version'"); } finally { changed.close(); }
    assert.throws(() => restoreBookCatalog4(config));
    const after = new DatabaseSync(config.paths.catalog, { readOnly: true });
    try {
      assert.equal(after.prepare('PRAGMA table_info(daemon_state)').all().some(row => row.name === 'process_identity'), true);
      assert.equal(after.prepare('SELECT value FROM history').get().value, 'unchanged');
    } finally { after.close(); }
  });
});
