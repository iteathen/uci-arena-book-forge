import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as identity from '../src/process_identity.mjs';
import { loadConfig } from '../src/config.mjs';
import { Catalog } from '../src/catalog.mjs';
import { acquireDaemonLock } from '../src/daemon.mjs';

function exactIdentity(overrides = {}) {
  return { schema: 'uci_arena_process_instance_identity_v1', platform: 'win32', pid: process.pid,
    start_token: '639111234567890123', executable_path: 'C:\\runtime\\node.exe', boot_id: '', ...overrides };
}

test('configured native process query requires the actual declared capability and preserves shrinking budgets', { skip: process.platform !== 'win32' }, async () => {
  const calls = [];
  const helper = {
    async probe() { return { schema: 'uci_arena_background_service_native_probe_v1', capabilities: ['process_instance_query_v1'] }; },
    queryProcessInstanceSync(pid, options) { calls.push([pid, options]); return { schema: 'uci_arena_process_instance_query_v1', state: 'present', identity: exactIdentity({ pid }) }; },
  };
  const config = { nativeHelper: 'C:\\runtime\\guard.exe', nativeHelperAvailable: true };
  assert.equal(await identity.configureProcessIdentity(config, { helper }), true);
  assert.deepEqual(identity.probeProcessInstance(process.pid, { timeoutMs: 73 }), { state: 'present', identity: exactIdentity() });
  assert.deepEqual(calls, [[process.pid, { timeoutMs: 73 }]]);
  for (const timeoutMs of [0, -1, 2001, NaN, Infinity, 0.5]) assert.equal(identity.probeProcessInstance(process.pid, { timeoutMs }).state, 'unverifiable');
  assert.equal(identity.probeProcessInstance(0).state, 'unverifiable');
  assert.equal(calls.length, 1);
  helper.probe = async () => ({ schema: 'uci_arena_background_service_native_probe_v1', capabilities: [] });
  assert.equal(await identity.configureProcessIdentity(config, { helper }), false);
  assert.equal(identity.probeProcessInstance(process.pid).state, 'unverifiable');
  assert.equal(calls.length, 1);
});

test('persisted Windows identity retains the public path domain and rejects rounded or malformed identity', () => {
  const longPath = `C:\\${'\uFFFD'.repeat(32764)}`;
  assert.equal(longPath.length, 32767);
  assert.equal(identity.validProcessIdentity(exactIdentity({ executable_path: longPath })), true);
  for (const overrides of [
    { start_token: 639111234567890123 }, { start_token: '1' }, { start_token: '3155378976000000000' },
    { pid: 4294967296 }, { executable_path: 'relative.exe' }, { executable_path: 'C:\\bad\u0000.exe' },
    { executable_path: `${longPath}x` }, { executable_path: 'C:\\\uD800.exe' }, { boot_id: 'foreign' },
  ]) assert.equal(identity.validProcessIdentity(exactIdentity(overrides)), false, JSON.stringify(overrides));
  assert.equal(identity.validProcessIdentity({ ...exactIdentity(), platform: 'linux', start_token: '1', executable_path: '/usr/bin/node', boot_id: 'linux-boot' }), true);
});

test('daemon ownership never reclaims malformed current records or unverifiable observations', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'book-forge-identity-'));
  const config = await loadConfig({ workspace: root });
  const catalog = new Catalog(config);
  t.after(async () => { catalog.close(); await rm(root, { recursive: true, force: true }); });
  const filename = path.join(config.paths.locks, 'daemon.lock');
  const current = exactIdentity();
  const old = new Date(Date.now() - 310000);
  const packet = (processIdentity) => ({ schema: 'uci_arena_book_forge_daemon_lock_v2', pid: process.pid, nonce: 'retained', processIdentity });
  for (const processIdentity of [false, 0, '', null, undefined, { ...current, start_token: 639111234567890123 }]) {
    const bytes = Buffer.from(JSON.stringify(packet(processIdentity)));
    await writeFile(filename, bytes); await utimes(filename, old, old);
    await assert.rejects(acquireDaemonLock(config, { identity: current, probe: () => ({ state: 'absent' }) }).then((lock) => {
      t.after(() => lock.release());
      return lock;
    }), /unverifiable|malformed/);
    assert.deepEqual(await readFile(filename), bytes);
  }
  for (const lock of [packet(current), { pid: process.pid }]) {
    const bytes = Buffer.from(JSON.stringify(lock));
    await writeFile(filename, bytes); await utimes(filename, old, old);
    for (const observed of [{ state: 'unverifiable' }, { state: 'present', identity: false }, { state: 'unknown' }]) {
      await assert.rejects(acquireDaemonLock(config, { identity: current, probe: () => observed }), /unverifiable|owns/);
      assert.deepEqual(await readFile(filename), bytes);
    }
  }
});

test('daemon record reader rejects malformed UTF-8 while admitting valid literal replacement characters', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'book-forge-identity-bytes-'));
  const config = await loadConfig({ workspace: root });
  const catalog = new Catalog(config);
  t.after(async () => { catalog.close(); await rm(root, { recursive: true, force: true }); });
  const filename = path.join(config.paths.locks, 'daemon.lock');
  const owner = exactIdentity({ executable_path: 'C:\\\uFFFDnode.exe' });
  const packet = { schema: 'uci_arena_book_forge_daemon_lock_v2', pid: process.pid, nonce: 'old', processIdentity: owner };
  const bytes = Buffer.from(JSON.stringify(packet));
  const old = new Date(Date.now() - 310000);
  await writeFile(filename, bytes); await utimes(filename, old, old);
  const acquired = await acquireDaemonLock(config, { identity: exactIdentity(), probe: () => ({ state: 'absent' }) });
  await acquired.release();
  const damaged = Buffer.from(bytes);
  const replacement = damaged.indexOf(Buffer.from('\uFFFD'));
  assert.ok(replacement >= 0);
  damaged[replacement] = 0xff;
  await writeFile(filename, damaged); await utimes(filename, old, old);
  await assert.rejects(acquireDaemonLock(config, { identity: exactIdentity(), probe: () => ({ state: 'absent' }) }).then((lock) => {
    t.after(() => lock.release());
    return lock;
  }), /unverifiable|malformed/);
  assert.deepEqual(await readFile(filename), damaged);
});

test('daemon lock admits a complete maximum-path identity record', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'book-forge-identity-range-'));
  const config = await loadConfig({ workspace: root });
  const catalog = new Catalog(config);
  t.after(async () => { catalog.close(); await rm(root, { recursive: true, force: true }); });
  const filename = path.join(config.paths.locks, 'daemon.lock');
  const owner = exactIdentity({ executable_path: `C:\\${'\uFFFD'.repeat(32764)}` });
  await writeFile(filename, JSON.stringify({ schema: 'uci_arena_book_forge_daemon_lock_v2', pid: process.pid, nonce: 'old', processIdentity: owner }));
  const old = new Date(Date.now() - 310000);
  await utimes(filename, old, old);
  const acquired = await acquireDaemonLock(config, { identity: exactIdentity(), probe: () => ({ state: 'absent' }) });
  await acquired.release();
});
