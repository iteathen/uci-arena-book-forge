import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BookLifecycleStore } from '../src/provider_state.mjs';
import { convergeBookLifecycle } from '../src/provider_lifecycle.mjs';
const hash = text => createHash('sha256').update(text).digest('hex');
function intent(label, description = '') {
  const action = { command: 'C:\\Owned Store Fixture\\launcher.exe', arguments: '--restart "C:\\Owned Node\\node.exe"',
    working_directory: 'C:\\Owned Store Fixture' };
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const xml = `<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>${escape(description)}</Description></RegistrationInfo>` +
    `<Settings><Enabled>false</Enabled></Settings><Actions Context="Author"><Exec><Command>${escape(action.command)}</Command>` +
    `<Arguments>${escape(action.arguments)}</Arguments><WorkingDirectory>${escape(action.working_directory)}</WorkingDirectory></Exec></Actions></Task>`;
  return { binding: hash(label), registered: true, enabled: true, active: true,
    root: 'C:\\Owned Store Fixture', nodeExecutable: 'C:\\Owned Node\\node.exe', componentVersion: '0.4.9',
    nonce: null, launch: null, obstacleIdentity: null, catalogSchemaVersion: 5,
    task: { definition_xml: xml, definition_sha256: hash(xml), action } };
}

test('closed deferred packet admits pending payload only and rejects malformed plan or predecessor before callback', async () => {
  const fs = await import('node:fs/promises');
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'book-lifecycle-store-'));
  try {
    const store = new BookLifecycleStore(workspace);
    const before = { ...intent('A'), payloadIdentity: { componentVersion: '0.4.9',
      componentManifestSha256: hash('manifest'), inventorySha256: hash('inventory') } };
    await store.transact(async state => {
      state.records.push({ before, desired: structuredClone(before), preDone: false, postDone: false, last: null,
        plan: { schema: 'book_lifecycle_target_plan_v1', root: 'C:\\Future', payload: before.payloadIdentity,
          workspace: 'C:\\Workspace', configuration: null, launchGrammar: 'book_windows_restart_daemon_v1' },
        runtimePending: true, predecessorBefore: null }); await state.save();
    });
    const filename = path.join(workspace, '.book-lifecycle/before-state.json');
    const original = JSON.parse(await readFile(filename)); let entered = 0;
    for (const change of [record => { record.plan.nodeExecutable = 'C:\\Guessed\\node.exe'; },
      record => { record.plan.payload.inventorySha256 = 'invalid'; },
      record => { record.plan.root = 'relative'; }, record => { record.runtimePending = 'true'; },
      record => { record.postDone = true; }, record => { record.desired.binding = hash('B'); },
      record => { record.predecessorBefore = { ...record.before, active: 'unknown' }; }]) {
      const packet = structuredClone(original); change(packet.records[0]); await writeFile(filename, JSON.stringify(packet));
      await assert.rejects(store.transact(async () => { entered++; }));
    }
    assert.equal(entered, 0);
  } finally {
    const resolved = await fs.realpath(workspace); const stat = await fs.lstat(workspace);
    assert.equal(path.dirname(resolved), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('book-lifecycle-store-')); assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    await rm(resolved, { recursive: true });
  }
});

test('bounded producer store preserves before-state, serializes ownership and rejects malformed/foreign unfinished state', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'book-lifecycle-store-'));
  try {
    const store = new BookLifecycleStore(workspace);
    await store.transact(async state => {
      state.records.push({ before: intent('A'), desired: intent('B'), preDone: false, postDone: false, last: null });
      await state.save();
      await assert.rejects(store.transact(async () => {}));
    });
    await store.transact(async state => assert.equal(state.records[0].before.binding, hash('A')));
    const directory = path.join(workspace, '.book-lifecycle');
    const original = await readFile(path.join(directory, 'before-state.json'));
    await writeFile(path.join(directory, 'operation.lock'), 'foreign unfinished intent');
    await assert.rejects(store.transact(async () => {}));
    assert.deepEqual(await readFile(path.join(directory, 'before-state.json')), original);
    await rm(path.join(directory, 'operation.lock'));
    await writeFile(path.join(directory, 'before-state.json'), '{}');
    await assert.rejects(store.transact(async () => {}));
  } finally {
    const resolved = await import('node:fs/promises').then(fs => fs.realpath(workspace));
    assert.equal(path.dirname(resolved), await import('node:fs/promises').then(fs => fs.realpath(os.tmpdir())));
    assert.ok(path.basename(resolved).startsWith('book-lifecycle-store-'));
    await rm(resolved, { recursive: true });
  }
});

test('actual bounded packet store retires completed large definitions before byte capacity exhaustion', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'book-lifecycle-store-'));
  try {
    const store = new BookLifecycleStore(workspace);
    let current = intent('root/0', 'x'.repeat(900000));
    const platform = { desired: async request => ({ ...current, binding: hash(`root/${request.node}`), active: false, enabled: false }),
      inspect: async () => structuredClone(current), capture: async value => structuredClone(value),
      quiesce: async () => { current.active = false; },
      apply: async target => { current = { ...structuredClone(target), active: false }; },
      activate: async () => { current.active = true; } };
    for (let node = 1; node <= 24; node++) {
      for (const operation of ['pre_replace', 'post_replace']) {
        const result = await convergeBookLifecycle({ operation, node }, { platform, store, version: '0.4.9' });
        assert.equal(result.disposition, 'ready');
      }
    }
    const saved = JSON.parse(await readFile(path.join(workspace, '.book-lifecycle/before-state.json')));
    assert.ok(saved.records.length <= 2);
  } finally {
    const fs = await import('node:fs/promises'); const resolved = await fs.realpath(workspace); const stat = await fs.lstat(workspace);
    assert.equal(path.dirname(resolved), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('book-lifecycle-store-')); assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    await rm(resolved, { recursive: true });
  }
});

test('real packet rejects malformed root/task/launch/terminal/phase facts before entering callback', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'book-lifecycle-store-'));
  try {
    const store = new BookLifecycleStore(workspace);
    await store.transact(async state => { state.records.push({ before: intent('A'), desired: intent('B'),
      preDone: false, postDone: false, last: null }); await state.save(); });
    const filename = path.join(workspace, '.book-lifecycle/before-state.json');
    const original = JSON.parse(await readFile(filename));
    let entered = 0;
    const mutations = [
      record => { record.before.active = 'malformed-active'; },
      record => { record.before.enabled = false; record.before.active = true; },
      record => { delete record.desired.enabled; },
      record => { record.before.root = 'relative'; },
      record => { record.desired.nodeExecutable = 'C:\\Wrong\\not-node.exe'; },
      record => { record.before.task.definition_sha256 = '0'.repeat(64); },
      record => { record.desired.task.action.command = 'relative.exe'; },
      record => { record.before.launch = { originUtcMs: -1 }; },
      record => { delete record.before.nonce; },
      record => { delete record.desired.launch; },
      record => { record.before.obstacleIdentity = { pid: 12 }; },
      record => { record.preDone = 'true'; },
      record => { record.postDone = true; },
      record => { record.last = { binding: hash('foreign'), enabled: true, active: true, definition: hash('<Task/>') }; },
    ];
    for (const mutate of mutations) {
      const value = structuredClone(original); mutate(value.records[0]);
      await writeFile(filename, JSON.stringify(value));
      await assert.rejects(store.transact(async () => { entered++; }));
    }
    assert.equal(entered, 0);
  } finally {
    const fs = await import('node:fs/promises'); const resolved = await fs.realpath(workspace); const stat = await fs.lstat(workspace);
    assert.equal(path.dirname(resolved), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('book-lifecycle-store-')); assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    await rm(resolved, { recursive: true });
  }
});
