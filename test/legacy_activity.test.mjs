import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, realpath, lstat, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { observeOwnedLegacyActivity, observeDaemonDrainObstacle } from '../src/daemon_observation.mjs';

const origin = Date.parse('2026-10-09T12:00:00.000Z');
const identity = { schema: 'uci_arena_process_instance_identity_v1', platform: 'win32', pid: 12345,
  start_token: (BigInt(origin + 10) * 10000n + 621355968000000000n).toString(),
  executable_path: 'C:\\Exact Prior Node\\node.exe', boot_id: '' };
const task = { registered: true, enabled: true, definition_sha256: '1'.repeat(64),
  instance_guids: ['{11111111-1111-1111-1111-111111111111}'] };
const launch = { originUtcMs: origin, previousNonce: '11111111-1111-4111-8111-111111111111',
  previousOwnerAbsentAtUtcMs: origin - 1, expectedNodeExecutable: identity.executable_path,
  taskDefinitionSha256: task.definition_sha256, taskEnabled: true, instanceGuids: task.instance_guids };

async function fixture(t, changes = {}) {
  const parent = await realpath(os.tmpdir());
  const root = await realpath(await mkdtemp(path.join(parent, 'book-legacy-activity-')));
  const locks = path.join(root, 'locks'); await mkdir(locks);
  const config = { workspace: root, paths: { catalog: path.join(root, 'catalog.sqlite'), locks },
    daemonHeartbeatFile: path.join(locks, 'daemon.heartbeat') };
  t.after(async () => {
    const resolved = await realpath(root); const stat = await lstat(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('book-legacy-activity-'));
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    await rm(resolved, { recursive: true });
  });
  const row = { pid: identity.pid, phase: 'sleep', startedAt: origin + 20,
    heartbeatAt: origin + 30, ...changes };
  const database = new DatabaseSync(config.paths.catalog);
  database.exec('CREATE TABLE daemon_state(singleton INTEGER PRIMARY KEY,pid INTEGER,phase TEXT,started_at TEXT,heartbeat_at TEXT)');
  database.prepare('INSERT INTO daemon_state VALUES(1,?,?,?,?)').run(row.pid, row.phase,
    new Date(row.startedAt).toISOString(), new Date(row.heartbeatAt).toISOString());
  database.close();
  await writeFile(path.join(locks, 'daemon.lock'), JSON.stringify({ pid: row.pid,
    nonce: changes.nonce ?? '22222222-2222-4222-8222-222222222222', startedAt: new Date(row.startedAt).toISOString() }));
  await writeFile(config.daemonHeartbeatFile, JSON.stringify({ pid: changes.heartbeatPid ?? row.pid,
    heartbeatAt: new Date(row.heartbeatAt).toISOString() }));
  return config;
}

test('controlled old-format restart combines fresh nonce, task scope and exact OS incarnation', async t => {
  const config = await fixture(t);
  const before = await readFile(config.paths.catalog);
  const result = await observeOwnedLegacyActivity(config, { launch, task, now: () => origin + 40,
    probe: () => ({ state: 'present', identity }) });
  assert.equal(result.active, true);
  assert.equal(result.ownerLive, true);
  assert.deepEqual(await readFile(config.paths.catalog), before);
});

test('readonly legacy record reports only its current incarnation obstacle, never daemon activity', async t => {
  const config = await fixture(t);
  const before = await readFile(config.paths.catalog);
  const result = await observeDaemonDrainObstacle(config, { probe: () => ({ state: 'present', identity }) });
  assert.equal(result.state, 'present');
  assert.equal(result.authority, 'current-incarnation-at-record-pid-only');
  assert.deepEqual(result.currentIncarnation, identity);
  assert.equal(Object.hasOwn(result, 'active'), false);
  assert.deepEqual(await readFile(config.paths.catalog), before);
  assert.equal((await observeDaemonDrainObstacle(config, { probe: () => ({ state: 'unverifiable' }) })).state, 'unverifiable');
});

test('repeated lifecycle observation keeps an old controlled start with freshly renewed heartbeat', async t => {
  const later = origin + 24 * 60 * 60 * 1000;
  const config = await fixture(t, { heartbeatAt: later });
  const result = await observeOwnedLegacyActivity(config, { launch, task, now: () => later,
    probe: () => ({ state: 'present', identity }) });
  assert.equal(result.active, true);
});

test('old nonce, stale/failed phase, PID disagreement and old start cannot grant legacy activity', async t => {
  for (const changes of [{ nonce: launch.previousNonce }, { phase: 'failed' },
    { phase: 'stopped' }, { startedAt: origin - 1 }, { heartbeatPid: identity.pid + 1 },
    { heartbeatAt: origin + 1000 }]) {
    const config = await fixture(t, changes);
    assert.equal((await observeOwnedLegacyActivity(config, { launch, task, now: () => origin + 40,
      probe: () => ({ state: 'present', identity }) })).active, null);
  }
});

test('unknown query, old incarnation, foreign executable or task drift never grants ready', async t => {
  const config = await fixture(t);
  for (const observed of [{ state: 'unverifiable' }, { state: 'absent' },
    { state: 'present', identity: { ...identity, start_token: '639111234567890123' } },
    { state: 'present', identity: { ...identity, executable_path: 'C:\\Foreign\\node.exe' } }]) {
    assert.equal((await observeOwnedLegacyActivity(config, { launch, task, now: () => origin + 40,
      probe: () => observed })).active, null);
  }
  for (const changedTask of [{ ...task, definition_sha256: '2'.repeat(64) },
    { ...task, instance_guids: [] }, { ...task, enabled: false },
    { ...task, instance_guids: ['{22222222-2222-2222-2222-222222222222}'] }]) {
    assert.equal((await observeOwnedLegacyActivity(config, { launch, task: changedTask, now: () => origin + 40,
      probe: () => ({ state: 'present', identity }) })).active, null);
  }
  assert.equal((await observeOwnedLegacyActivity(config, { task, now: () => origin + 40 })).active, null);
});
