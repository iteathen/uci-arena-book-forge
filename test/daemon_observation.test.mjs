import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeDaemonActivity } from '../src/daemon_observation.mjs';

const clock = Date.parse('2026-10-09T12:00:00.000Z');
const exactIdentity = overrides => ({ schema: 'uci_arena_process_instance_identity_v1',
  platform: 'win32', pid: 12345, start_token: '639111234567890123',
  executable_path: 'C:\\Owned Fixture\\node.exe', boot_id: '', ...overrides });

async function fixture(t, { legacy = false } = {}) {
  const parent = await realpath(os.tmpdir());
  const root = await realpath(await mkdtemp(path.join(parent, 'book-owner-observation-')));
  const locks = path.join(root, 'locks');
  await mkdir(locks);
  const config = { workspace: root, paths: { catalog: path.join(root, 'catalog.sqlite'), locks },
    daemonHeartbeatFile: path.join(locks, 'daemon.heartbeat') };
  t.after(async () => {
    const resolved = await realpath(root);
    const status = await lstat(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('book-owner-observation-'));
    assert.ok(status.isDirectory() && !status.isSymbolicLink());
    await rm(resolved, { recursive: true });
  });
  const database = new DatabaseSync(config.paths.catalog);
  database.exec(`CREATE TABLE daemon_state(singleton INTEGER PRIMARY KEY,pid INTEGER,
    phase TEXT,heartbeat_at TEXT${legacy ? '' : ',process_identity TEXT'});
    INSERT INTO daemon_state VALUES(1,NULL,'stopped',NULL${legacy ? '' : ",''"});`);
  database.close();
  return { config, async records({ identity = exactIdentity(), phase = 'sleep',
    catalogAt = clock, packetAt = clock, nonce = 'owned-fixture' } = {}) {
    const selected = new DatabaseSync(config.paths.catalog);
    selected.prepare('UPDATE daemon_state SET pid=?,phase=?,heartbeat_at=?,process_identity=? WHERE singleton=1')
      .run(identity.pid, phase, new Date(catalogAt).toISOString(), JSON.stringify(identity));
    selected.close();
    await writeFile(path.join(locks, 'daemon.lock'), JSON.stringify({
      schema: 'uci_arena_book_forge_daemon_lock_v2', pid: identity.pid, nonce,
      processIdentity: identity }));
    await writeFile(config.daemonHeartbeatFile, JSON.stringify({ pid: identity.pid, nonce,
      processIdentity: identity, heartbeatAt: new Date(packetAt).toISOString() }));
  } };
}

test('real readonly owner observation combines fresh records with independent exact incarnation', async t => {
  const f = await fixture(t);
  await f.records();
  const before = await readFile(f.config.paths.catalog);
  const result = await observeDaemonActivity(f.config, { now: () => clock,
    probe: () => ({ state: 'present', identity: exactIdentity() }) });
  assert.equal(result.state, 'active');
  assert.equal(result.active, true);
  assert.equal(result.ownerLive, true);
  assert.deepEqual(await readFile(f.config.paths.catalog), before);
});

test('known exit and PID reuse are inactive; denial never proves absence', async t => {
  const f = await fixture(t);
  await f.records();
  for (const observed of [{ state: 'absent' },
    { state: 'present', identity: exactIdentity({ start_token: '639111234567890124' }) }]) {
    const result = await observeDaemonActivity(f.config, { now: () => clock, probe: () => observed });
    assert.equal(result.active, false);
    assert.equal(result.ownerLive, false);
  }
  const denied = await observeDaemonActivity(f.config, { now: () => clock,
    probe: () => ({ state: 'unverifiable' }) });
  assert.equal(denied.active, null);
  assert.equal(denied.ownerLive, null);
});

test('stale or failed daemon remains a live drain obstacle rather than an exited owner', async t => {
  const f = await fixture(t);
  for (const selected of [{ catalogAt: clock - 300001 }, { packetAt: clock - 300001 },
    { phase: 'failed' }, { phase: 'stopped' }]) {
    await f.records(selected);
    const result = await observeDaemonActivity(f.config, { now: () => clock,
      probe: () => ({ state: 'present', identity: exactIdentity() }) });
    assert.equal(result.active, false);
    assert.equal(result.ownerLive, true);
  }
});

test('foreign nonce, future evidence and malformed records remain unavailable', async t => {
  const f = await fixture(t);
  for (const selected of [{ catalogAt: clock + 1 }, { packetAt: clock + 1 }, { phase: 'foreign' }]) {
    await f.records(selected);
    assert.equal((await observeDaemonActivity(f.config, { now: () => clock,
      probe: () => ({ state: 'present', identity: exactIdentity() }) })).active, null);
  }
  await f.records();
  const heartbeat = JSON.parse(await readFile(f.config.daemonHeartbeatFile));
  heartbeat.nonce = 'foreign';
  await writeFile(f.config.daemonHeartbeatFile, JSON.stringify(heartbeat));
  assert.equal((await observeDaemonActivity(f.config, { now: () => clock,
    probe: () => ({ state: 'present', identity: exactIdentity() }) })).active, null);
  await writeFile(path.join(f.config.paths.locks, 'daemon.lock'), Buffer.from([0xff]));
  assert.equal((await observeDaemonActivity(f.config)).active, null);
});

test('legacy catalog stays unchanged and never gains fabricated process identity', async t => {
  const f = await fixture(t, { legacy: true });
  const before = await readFile(f.config.paths.catalog);
  assert.equal((await observeDaemonActivity(f.config)).active, null);
  assert.deepEqual(await readFile(f.config.paths.catalog), before);
  const database = new DatabaseSync(f.config.paths.catalog, { readOnly: true });
  assert.equal(database.prepare('PRAGMA table_info(daemon_state)').all()
    .some(row => row.name === 'process_identity'), false);
  database.close();
});

test('observation resource-close failure is typed unavailable', async () => {
  class BrokenClose {
    prepare() { return { get: () => ({ pid: null, process_identity: '' }) }; }
    close() { throw Error('PRIVATE_CANARY'); }
  }
  // Current source is a regular file; no actual SQLite or provider state is read.
  const filename = fileURLToPath(import.meta.url);
  const config = { workspace: path.dirname(filename), paths: { catalog: filename } };
  const result = await observeDaemonActivity(config, { Database: BrokenClose });
  assert.equal(result.active, null);
});

async function restoredLegacy(t) {
  const f=await fixture(t),db=new DatabaseSync(f.config.paths.catalog),stamp='2026-10-01T00:00:00.000Z';
  db.exec(`DROP TABLE daemon_state; CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO metadata VALUES('schema_version','5');
    CREATE TABLE daemon_state(singleton INTEGER PRIMARY KEY,pid INTEGER,phase TEXT,process_identity TEXT,
      started_at TEXT,heartbeat_at TEXT,cycle_started_at TEXT,cycle_completed_at TEXT,
      resource_mode TEXT,last_report TEXT,last_error TEXT,updated_at TEXT);`);
  db.prepare('INSERT INTO daemon_state VALUES(1,12345,?,\'\',?,?,NULL,NULL,?,?,?,?)').run('sleep',stamp,stamp,'backoff','{}','',stamp);db.close();
  return {...f,edit(sql,...args){const selected=new DatabaseSync(f.config.paths.catalog);try{selected.prepare(sql).run(...args);}finally{selected.close()}}};
}
test('known schema4-to5 restored catalog-only owner admits positive absence without inventing identity',async t=>{
  const f=await restoredLegacy(t),before=await readFile(f.config.paths.catalog),queries=[];
  const result=await observeDaemonActivity(f.config,{probe:pid=>{queries.push(pid);return{state:'absent'}}});
  assert.deepEqual(result,{state:'inactive',active:false,ownerLive:false,identity:null});assert.deepEqual(queries,[12345]);
  assert.deepEqual(await readFile(f.config.paths.catalog),before);
});
test('legacy catalog-only present reused denied and unknown PID observations stay unavailable',async t=>{
  const f=await restoredLegacy(t);
  for(const probe of [()=>({state:'present',identity:exactIdentity()}),()=>({state:'present',identity:exactIdentity({start_token:'639111234567890124'})}),
    ()=>({state:'unverifiable'}),()=>null,()=>({state:'unknown'}),()=>{throw Error('PRIVATE_CANARY')}]) {
    assert.equal((await observeDaemonActivity(f.config,{probe})).active,null);
  }
});
test('malformed declared identity and unknown historical shapes cannot downgrade to legacy absence',async t=>{
  const f=await restoredLegacy(t);
  for(const identity of ['null','{}','malformed',' '.repeat(3)]) {
    f.edit('UPDATE daemon_state SET process_identity=?',identity);let queries=0;
    assert.equal((await observeDaemonActivity(f.config,{probe:()=>{queries++;return{state:'absent'}}})).active,null);assert.equal(queries,0);
  }
  f.edit("UPDATE daemon_state SET process_identity=''");
  for(const [column,value]of [['pid','wrong'],['phase','foreign'],['started_at','invalid'],['heartbeat_at',null],
    ['cycle_completed_at','invalid'],['resource_mode',null],['last_report','x'.repeat(65537)],['last_error','x'.repeat(2049)],['updated_at','invalid']]) {
    const db=new DatabaseSync(f.config.paths.catalog),prior=db.prepare(`SELECT ${column} AS value FROM daemon_state`).get().value;db.close();
    f.edit(`UPDATE daemon_state SET ${column}=?`,value);
    assert.equal((await observeDaemonActivity(f.config,{probe:()=>({state:'absent'})})).active,null,column);
    f.edit(`UPDATE daemon_state SET ${column}=?`,prior);
  }
  f.edit("UPDATE metadata SET value='4'");assert.equal((await observeDaemonActivity(f.config,{probe:()=>({state:'absent'})})).active,null);
  f.edit("UPDATE metadata SET value='5'");f.edit('ALTER TABLE daemon_state ADD COLUMN unknown_owner TEXT');
  assert.equal((await observeDaemonActivity(f.config,{probe:()=>({state:'absent'})})).active,null);
});
test('retained lock or heartbeat does not become catalog-only legacy absence',async t=>{
  const f=await restoredLegacy(t);
  await writeFile(path.join(f.config.paths.locks,'daemon.lock'),'malformed retained lock');
  assert.equal((await observeDaemonActivity(f.config,{probe:()=>({state:'absent'})})).active,null);
  await rm(path.join(f.config.paths.locks,'daemon.lock'));
  await writeFile(f.config.daemonHeartbeatFile,JSON.stringify({pid:12345,heartbeatAt:'2026-10-01T00:00:00.000Z'}));
  assert.equal((await observeDaemonActivity(f.config,{probe:()=>({state:'absent'})})).active,null);
});
