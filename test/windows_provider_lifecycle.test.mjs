import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WindowsBookLifecyclePlatform } from '../src/windows_provider_lifecycle.mjs';
import { startupAction, buildTaskXml } from '../src/windows_startup.mjs';

const descriptor = { schema: 'uci_arena_book_component_root_v1', root: 'C:\\fixture',
  componentVersion: '0.4.4', componentManifestSha256: 'a'.repeat(64),
  inventorySha256: 'b'.repeat(64),
  packageRoot: 'C:\\fixture\\services\\book-forge', cli: 'C:\\fixture\\services\\book-forge\\src\\cli.mjs',
  launcher: 'C:\\fixture\\services\\book-forge\\native\\bin\\uci_arena_service_launcher.exe' };
const identity = { schema: 'uci_arena_process_instance_identity_v1', platform: 'win32', pid: 123,
  start_token: '639000000000000000', executable_path: 'C:\\Node24\\node.exe', boot_id: '' };
const guid = '{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}';
function fixture({ instances = [guid], live = true } = {}) {
  const config = { workspace: 'C:\\workspace', configFile: 'C:\\workspace\\config.json', paths: { locks: 'C:\\workspace\\locks' } };
  const raw = startupAction(config, { descriptor, nodeExecutable: identity.executable_path });
  const action = { command: raw.command, arguments: raw.arguments, working_directory: raw.workingDirectory };
  const xml = buildTaskXml(config, 'S-1-5-21-123', { descriptor, nodeExecutable: identity.executable_path });
  let task = { registered: true, enabled: true, definition_xml: xml,
    definition_sha256: createHash('sha256').update(xml).digest('hex'), action,
    instance_guids: [...instances], principal: { current_user_sid: 'S-1-5-21-123' } };
  const calls = [];
  const scheduler = { async perform(request) {
    calls.push(request);
    if (request.operation === 'set_enabled') task.enabled = request.enabled;
    if (request.operation === 'stop_instances') { task.instance_guids = []; live = false; }
    if (request.operation === 'delete') task = { registered: false, instance_guids: [], action: null };
    return { outcome: 'completed', observation: structuredClone(task) };
  } };
  const platform = new WindowsBookLifecyclePlatform(config, { roots: [descriptor.root], scheduler,
    nodeExecutable: 'C:\\Node26\\node.exe', admitRoot: async () => descriptor,
    activity: async () => ({ active: null, ownerLive: null }),
    drain: async () => ({ state: live ? 'present' : 'absent', currentIncarnation: live ? identity : null }),
    readLock: async () => ({ value: { nonce: '11111111-1111-1111-1111-111111111111' } }),
    probe: () => ({ state: live ? 'present' : 'absent', ...(live ? { identity } : {}) }),
    readinessMs: 10, pause: async () => {}, executableIdentity: async () => 'f'.repeat(64), catalogVersion: () => 4,
    restoreCatalog: () => {} });
  return { platform, calls, drift: () => { task.action.arguments += ' --foreign'; }, keepAlive: () => {
    scheduler.perform = async request => { calls.push(request); if (request.operation === 'set_enabled') task.enabled = false;
      if (request.operation === 'stop_instances') task.instance_guids = [];
      return { outcome: 'completed', observation: structuredClone(task) }; }; } };
}

test('legacy task-owned case drains exact instances then proves captured incarnation absence', async () => {
  const f = fixture(); await f.platform.begin([]);
  const observed = await f.platform.inspect();
  const before = await f.platform.capture(observed, { previousRoot: descriptor.root });
  assert.equal(before.active, true); // Retained running intent only.
  assert.equal(observed.active, null); // Never a current activity claim.
  await f.platform.quiesce(observed);
  assert.equal((await f.platform.inspect()).active, false);
  assert.deepEqual(f.calls.find(x => x.operation === 'stop_instances').instance_guids, [guid]);
  assert.equal(f.calls.some(x => x.operation === 'delete'), false);
});

test('Task0 legacy orphan blocks before gate; task stop without process absence never passes', async () => {
  const orphan = fixture({ instances: [] }); await orphan.platform.begin([]);
  const observed = await orphan.platform.inspect();
  await assert.rejects(orphan.platform.capture(observed, { previousRoot: descriptor.root }));
  await assert.rejects(orphan.platform.quiesce(observed));
  assert.equal(orphan.calls.every(x => x.operation === 'inspect'), true);
  const survives = fixture(); survives.keepAlive(); await survives.platform.begin([]);
  await assert.rejects(survives.platform.quiesce(await survives.platform.inspect()));
});

test('unknown current-profile liveness is not admitted by the legacy compatibility exception', async () => {
  const f = fixture(); await f.platform.begin([]);
  const current = await f.platform.inspect();
  await assert.rejects(f.platform.capture({ ...current, componentVersion: '0.4.9' }, { previousRoot: descriptor.root }));
  assert.equal(f.calls.every(call => call.operation === 'inspect'), true);
});

test('same-root desired runtime tuples bind differently; changed observed action cannot drain', async () => {
  const f = fixture(); await f.platform.begin([]);
  const desired26 = await f.platform.desired({ replacementRoot: descriptor.root });
  f.platform.nodeExecutable = 'C:\\Node27\\node.exe';
  const desired27 = await f.platform.desired({ replacementRoot: descriptor.root });
  assert.notEqual(desired26.binding, desired27.binding);
  assert.match(desired27.task.definition_xml, /<UseUnifiedSchedulingEngine>true/);
  assert.match(desired27.task.definition_xml, /<Enabled>false/);
  f.drift(); await assert.rejects(f.platform.inspect());
});

test('completed historical source retirement does not block current operation; required missing restoration fails', async () => {
  const f = fixture({ live: false, instances: [] });
  f.platform.candidateRoots = ['C:\\retired'];
  const admission = f.platform.admitRoot;
  f.platform.admitRoot = async root => { if (root === 'C:\\retired') throw Error('retired root'); return admission(root); };
  await f.platform.begin([{ before: { root: 'C:\\retired' }, desired: { root: 'C:\\also-retired' }, postDone: true }]);
  const target = await f.platform.desired({ replacementRoot: descriptor.root });
  assert.equal(target.root, descriptor.root);
  await assert.rejects(f.platform.desired({ replacementRoot: 'C:\\retired' }));
  await assert.rejects(f.platform.apply({ ...target, root: 'C:\\retired' }, await f.platform.inspect()));
  assert.equal(f.calls.every(call => call.operation === 'inspect'), true);
});

test('staged payload plans an absent final root without guessing runtime; post requires exact committed payload', async () => {
  const f = fixture({ live: false, instances: [] });
  const stage = { ...descriptor, root: 'C:\\stage', componentVersion: '0.4.9', inventorySha256: 'b'.repeat(64),
    componentManifestSha256: 'c'.repeat(64), cli: 'C:\\stage\\services\\book-forge\\src\\cli.mjs',
    packageRoot: 'C:\\stage\\services\\book-forge', launcher: 'C:\\stage\\services\\book-forge\\native\\bin\\uci_arena_service_launcher.exe' };
  const final = 'C:\\future49'; let committed = false;
  f.platform.roots = [stage.root]; f.platform.candidateRoots = [descriptor.root];
  f.platform.admitRoot = async root => {
    if (root === descriptor.root) return descriptor;
    if (root === stage.root) return stage;
    if (root === final && committed) return { ...stage, root: final, cli: final + '\\services\\book-forge\\src\\cli.mjs',
      packageRoot: final + '\\services\\book-forge', launcher: final + '\\services\\book-forge\\native\\bin\\uci_arena_service_launcher.exe' };
    throw Error('Absent future payload');
  };
  await f.platform.begin([]);
  const plan = await f.platform.plan({ operation: 'pre_replace', replacementRoot: final });
  assert.equal(plan.root, final.toLowerCase());
  assert.equal(plan.payload.componentManifestSha256, stage.componentManifestSha256);
  assert.equal(Object.hasOwn(plan, 'nodeExecutable'), false);
  await assert.rejects(f.platform.desired({ operation: 'post_replace', replacementRoot: final }));
  committed = true;
  const post = await f.platform.desired({ operation: 'post_replace', replacementRoot: final });
  assert.equal(post.nodeExecutable, 'C:\\Node26\\node.exe');
  assert.deepEqual(await f.platform.plan({ operation: 'post_replace', replacementRoot: final }), plan);
});

test('runtime bytes changed after desired admission fail before task registration', async () => {
  const f = fixture({ live: false, instances: [] }); await f.platform.begin([]);
  const target = await f.platform.desired({ replacementRoot: descriptor.root });
  f.platform.executableIdentity = async () => 'e'.repeat(64);
  await assert.rejects(f.platform.apply(target, await f.platform.inspect()));
  assert.equal(f.calls.every(call => call.operation === 'inspect'), true);
});

test('queued owned legacy Run with empty immediate Task observation waits for exact actual GUID and activity', async () => {
  const f = fixture({ live: false, instances: [] }); await f.platform.begin([]);
  const current = await f.platform.inspect();
  const target = { ...current, active: true };
  let queries = 0; const task = current.task;
  f.platform.scheduler.perform = async request => ({ outcome: 'completed', observation: {
    ...task, instance_guids: request.operation === 'run' || queries++ === 0 ? [] : [guid] } });
  const seen = [];
  f.platform.inspect = async () => {
    const observed = await f.platform.task('inspect');
    seen.push(observed.instance_guids.length);
    return { ...current, task: observed, orphan: observed.instance_guids.length === 0,
      active: observed.instance_guids.length > 0 && f.platform.launch.instanceGuids.length > 0 };
  };
  await f.platform.activate(target, current);
  assert.ok(seen.includes(1)); assert.deepEqual(target.launch.instanceGuids, [guid]);
});

test('owned legacy activation origin precedes register/enable, never a later Run timestamp', async () => {
  const f = fixture({ live: false, instances: [] }); await f.platform.begin([]);
  const original = await f.platform.inspect(); const target = { ...original, active: true };
  let clock = 100, running = false; f.platform.now = () => clock;
  let task = { ...original.task, enabled: false };
  f.platform.scheduler.perform = async request => {
    if (request.operation === 'set_enabled') task.enabled = request.enabled;
    if (request.operation === 'run') running = true;
    return { outcome: 'completed', observation: { ...task, instance_guids: running ? [guid] : [] } };
  };
  await f.platform.apply(target, { ...original, enabled: false, task });
  clock = 200; // A missed-logon launch born at101 may already be queued.
  f.platform.inspect = async () => ({ ...original, task: await f.platform.task('inspect'),
    active: f.platform.launch?.originUtcMs <= 101, orphan: false });
  await f.platform.activate(target, { ...original, task });
  assert.equal(target.launch.originUtcMs, 100);
});

test('persistent queued Task0 cannot become ready and never relaunches the daemon', async () => {
  const f = fixture({ live: false, instances: [] }); await f.platform.begin([]);
  const current = await f.platform.inspect();
  await assert.rejects(f.platform.activate({ ...current, active: true }, current));
  assert.equal(f.calls.filter(call => call.operation === 'run').length, 1);
  assert.deepEqual(f.platform.launch.instanceGuids, []);
});

test('actual retained store rejects XML Exec disagreement before callback, schema restore or task mutation', async () => {
  const fs = await import('node:fs/promises'); const os = await import('node:os'); const path = await import('node:path');
  const { BookLifecycleStore } = await import('../src/provider_state.mjs');
  const parent = await fs.realpath(os.tmpdir()); const root = await fs.mkdtemp(path.join(parent, 'book-xml-consistency-'));
  try {
    const f = fixture({ live: false, instances: [] }); await f.platform.begin([]);
    const target = await f.platform.desired({ replacementRoot: descriptor.root });
    const store = new BookLifecycleStore(root);
    await store.transact(async state => { state.records.push({ before: target, desired: structuredClone(target),
      preDone: false, postDone: false, last: null }); await state.save(); });
    const filename = path.join(root, '.book-lifecycle/before-state.json');
    const packet = JSON.parse(await fs.readFile(filename));
    const bad = packet.records[0].desired;
    bad.task.definition_xml = bad.task.definition_xml.replace(/<Command>[^<]+<\/Command>/u, '<Command>C:\\foreign.exe</Command>');
    bad.task.definition_sha256 = createHash('sha256').update(bad.task.definition_xml).digest('hex');
    await fs.writeFile(filename, JSON.stringify(packet));
    const effects = []; let callbacks = 0;
    f.platform.restoreCatalog = () => { effects.push('schema_restore'); };
    const perform = f.platform.scheduler.perform;
    f.platform.scheduler.perform = async request => {
      if (request.operation !== 'inspect') effects.push(request.operation);
      return perform(request);
    };
    await assert.rejects(store.transact(async state => { callbacks++;
      await f.platform.apply(state.records[0].desired, await f.platform.inspect()); }));
    assert.equal(callbacks, 0); assert.deepEqual(effects, []);
    const count = f.calls.length;
    await assert.rejects(f.platform.apply(bad, await f.platform.inspect()));
    assert.deepEqual(effects, []); assert.equal(f.calls.length, count + 1);
  } finally {
    const resolved = await fs.realpath(root); const stat = await fs.lstat(root);
    assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('book-xml-consistency-'));
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink()); await fs.rm(resolved, { recursive: true });
  }
});
