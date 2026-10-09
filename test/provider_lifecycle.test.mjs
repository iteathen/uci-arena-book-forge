import test from 'node:test';
import assert from 'node:assert/strict';
import { convergeBookLifecycle } from '../src/provider_lifecycle.mjs';

function fixture({ root = 'A', node = '24', enabled = true, active = true, orphan = false } = {}) {
  let current = { binding: `${root}/${node}`, registered: true, enabled, active, orphan };
  const records = []; const effects = [];
  const store = { async transact(fn) { return fn({ records, async save() { effects.push('save'); } }); } };
  const platform = {
    async desired(request) { return { binding: `${request.replacementRoot}/${request.node}`, root: request.replacementRoot,
      registered: true, enabled: false, active: false }; },
    async inspect() { return structuredClone(current); },
    async capture(observed) { if (observed.orphan) throw Error(); return structuredClone(observed); },
    async quiesce() { effects.push('quiesce'); if (current.orphan) throw Error(); current.active = false; },
    async apply(target) { effects.push('apply'); current = { ...current, ...target, active: false, registered: target.registered ?? true }; },
    async activate() { effects.push('activate'); current.active = true; },
    async remove() { effects.push('remove'); current = { binding: 'absent', registered: false, enabled: false, active: false }; },
  };
  const call = (operation, previousRoot = 'A', replacementRoot = 'B', node = '26') =>
    convergeBookLifecycle({ operation, previousRoot, replacementRoot, node }, { platform, store, version: '0.4.9' });
  return { call, effects, records, platform, current: () => current, mutate: x => { current = { ...current, ...x }; } };
}

test('before-state is durable before gate; repeated forward and inverse compensation restore actual before intent', async () => {
  const f = fixture();
  assert.equal((await f.call('pre_replace')).disposition, 'ready');
  assert.deepEqual(f.effects.slice(0, 2), ['save', 'quiesce']);
  assert.equal((await f.call('pre_replace')).disposition, 'ready');
  assert.equal((await f.call('post_replace')).disposition, 'ready');
  assert.equal((await f.call('post_replace')).disposition, 'ready');
  assert.equal(f.effects.filter(x => x === 'activate').length, 1);
  assert.equal((await f.call('pre_replace', 'B', 'A', '24')).disposition, 'ready');
  assert.equal((await f.call('post_replace', 'A', 'A', '24')).disposition, 'ready');
  assert.equal(f.current().binding, 'A/24');
  assert.equal(f.current().active, true);
  assert.equal((await f.call('post_replace', 'A', 'A', '24')).disposition, 'ready');
});

test('successive same-root runtime changes capture new disabled/inactive baseline, never stale Node24', async () => {
  const f = fixture();
  await f.call('pre_replace', 'A', 'A', '26'); await f.call('post_replace', 'A', 'A', '26');
  f.mutate({ enabled: false, active: false });
  assert.equal((await f.call('pre_replace', 'A', 'A', '27')).disposition, 'ready');
  assert.equal(f.records.length, 2);
  assert.equal(f.records[1].before.binding, 'A/26');
  assert.equal(f.records[1].before.enabled, false);
  assert.equal((await f.call('post_replace', 'A', 'A', '27')).disposition, 'safe_inactive');
  assert.equal(f.current().binding, 'A/27');
  await f.call('pre_replace', 'A', 'A', '26');
  assert.equal((await f.call('post_replace', 'A', 'A', '26')).disposition, 'safe_inactive');
  assert.equal(f.current().enabled, false);
  assert.equal(f.current().binding, 'A/26');
});

test('compensation when forward did not run and partial activation converge; orphan remains failed without effects', async () => {
  const noForward = fixture();
  assert.equal((await noForward.call('post_replace', 'A', 'A', '24')).disposition, 'ready');
  const f = fixture(); const activate = f.platform.activate;
  f.platform.activate = async () => { await activate(); throw Error('ambiguous response'); };
  assert.equal((await f.call('post_replace')).disposition, 'failed');
  f.platform.activate = activate;
  assert.equal((await f.call('post_replace')).disposition, 'ready');
  const orphan = fixture({ orphan: true });
  assert.equal((await orphan.call('pre_replace')).disposition, 'failed');
  assert.deepEqual(orphan.effects, []);
});

test('failed durable capture causes no platform mutation; foreign binding and absent pre-replacement fail', async () => {
  const f = fixture(); const store = { async transact(fn) { return fn({ records: [], async save() { throw Error(); } }); } };
  assert.equal((await convergeBookLifecycle({ operation: 'pre_replace', previousRoot: 'A', replacementRoot: 'B', node: '26' },
    { platform: f.platform, store, version: '0.4.9' })).disposition, 'failed');
  assert.deepEqual(f.effects, []);
  const absent = fixture(); absent.mutate({ registered: false, active: false, binding: null });
  assert.equal((await absent.call('pre_replace')).disposition, 'failed');
});

test('uninstall records prior intent before deletion; repeated absence and install compensation preserve disabled baseline', async () => {
  const f = fixture({ enabled: false, active: false });
  assert.equal((await f.call('uninstall', 'A', 'A', '24')).disposition, 'ready');
  assert.equal(f.effects[0], 'save');
  assert.equal((await f.call('uninstall', 'A', 'A', '24')).disposition, 'ready');
  assert.equal((await f.call('install', 'A', 'A', '24')).disposition, 'safe_inactive');
  assert.equal(f.current().enabled, false);
  assert.equal(f.current().active, false);
});

test('different replacement cannot take over unfinished retained intent', async () => {
  const f = fixture(); await f.call('pre_replace');
  const count = f.effects.length;
  assert.equal((await f.call('pre_replace', 'A', 'C', '27')).disposition, 'failed');
  assert.equal(f.effects.length, count);
});

test('later identical launch binding captures externally changed enabled/activity baseline; unchanged retry keeps original', async () => {
  const f = fixture({ root: 'A', node: '26' });
  await f.call('pre_replace', 'A', 'A', '26'); await f.call('post_replace', 'A', 'A', '26');
  assert.equal(f.records.length, 1);
  assert.equal((await f.call('post_replace', 'A', 'A', '26')).disposition, 'ready');
  assert.equal(f.records.length, 1);
  f.mutate({ enabled: false, active: false });
  assert.equal((await f.call('pre_replace', 'A', 'A', '26')).disposition, 'ready');
  assert.equal(f.records.length, 2);
  assert.equal(f.records[1].before.enabled, false);
  assert.equal(f.records[1].before.active, false);
  assert.equal((await f.call('post_replace', 'A', 'A', '26')).disposition, 'safe_inactive');
});

test('more than sixteen completed upgrades retire old records but preserve latest compensation', async () => {
  const f = fixture({ root: 'A', node: '0' });
  for (let node = 1; node <= 40; node++) {
    assert.equal((await f.call('pre_replace', 'A', 'A', String(node))).disposition, 'ready');
    assert.equal((await f.call('post_replace', 'A', 'A', String(node))).disposition, 'ready');
  }
  assert.ok(f.records.length <= 16);
  await f.call('pre_replace', 'A', 'A', '39');
  assert.equal((await f.call('post_replace', 'A', 'A', '39')).disposition, 'ready');
  assert.equal(f.current().binding, 'A/39');
});

test('uninstall after reinstall and operator drift captures new intent for compensating install', async () => {
  const f = fixture({ root: 'A', node: '26' });
  await f.call('uninstall', 'A', 'A', '26'); await f.call('install', 'A', 'A', '26');
  f.mutate({ enabled: false, active: false });
  await f.call('uninstall', 'A', 'A', '26');
  assert.equal((await f.call('install', 'A', 'A', '26')).disposition, 'safe_inactive');
  assert.equal(f.current().enabled, false);
});

test('reused pre and ambiguous inverse post remain unfinished and cannot admit a foreign target', async () => {
  const f = fixture(); await f.call('pre_replace'); await f.call('post_replace');
  await f.call('pre_replace');
  const count = f.effects.length;
  assert.equal((await f.call('pre_replace', 'B', 'C', '27')).disposition, 'failed');
  assert.equal(f.effects.length, count);
  const g = fixture(); await g.call('pre_replace'); await g.call('post_replace');
  const apply = g.platform.apply;
  g.platform.apply = async (...args) => { await apply(...args); throw Error('ambiguous inverse activation'); };
  assert.equal((await g.call('post_replace', 'A', 'A', '24')).disposition, 'failed');
  g.platform.apply = apply;
  assert.equal((await g.call('post_replace', 'A', 'A', '24')).disposition, 'ready');
  assert.equal(g.current().active, true);
});

test('malformed retained intent is rejected before every platform callback/effect', async () => {
  const f = fixture();
  const malformed = { before: { binding: 'A', registered: true, enabled: true, active: 'malformed-active' },
    desired: { binding: 'B', registered: true, enabled: true, active: true }, preDone: true, postDone: false, last: null };
  const callbacks = [];
  const platform = new Proxy(f.platform, { get(target, key) { const value = target[key];
    return typeof value === 'function' ? (...args) => { callbacks.push(key); return value(...args); } : value; } });
  const result = await convergeBookLifecycle({ operation: 'post_replace', previousRoot: 'A', replacementRoot: 'B' }, {
    platform, store: { transact: async fn => fn({ records: [malformed], save: async () => {} }) }, version: '0.4.9' });
  assert.equal(result.disposition, 'failed'); assert.deepEqual(callbacks, []); assert.deepEqual(f.effects, []);
});

test('uninstall cannot supersede unfinished replacement but can compensate uncertain first install', async () => {
  const f = fixture(); await f.call('pre_replace');
  const count = f.effects.length;
  assert.equal((await f.call('uninstall', 'A', 'A', '24')).disposition, 'failed');
  assert.equal(f.effects.length, count);
  const g = fixture(); g.mutate({ registered: false, binding: 'absent', enabled: false, active: false });
  const apply = g.platform.apply;
  g.platform.apply = async (...args) => { await apply(...args); throw Error('uncertain first install'); };
  assert.equal((await g.call('install', 'A', 'A', '26')).disposition, 'failed');
  assert.equal((await g.call('uninstall', 'A', 'A', '26')).disposition, 'ready');
  g.platform.apply = apply;
  assert.equal((await g.call('install', 'A', 'A', '27')).disposition, 'ready');
});

test('pre defers future runtime; stage/final/rollback source paths never identify the transition', async () => {
  const f = fixture(); let runtime = '24'; let source = 'stage';
  f.platform.plan = async request => ({ payload: request.replacementRoot, grammar: 'book-v1' });
  const desired = f.platform.desired;
  f.platform.desired = async request => {
    assert.notEqual(request.operation, 'pre_replace', 'pre cannot admit a future executable');
    return desired({ ...request, node: runtime });
  };
  assert.equal((await f.call('pre_replace')).disposition, 'ready');
  assert.equal(f.records[0].runtimePending, true);
  assert.equal(f.records[0].desired.binding, 'A/24');
  source = 'final'; runtime = '26';
  assert.equal((await f.call('post_replace')).disposition, 'ready');
  assert.equal(f.current().binding, 'B/26');
  assert.equal(f.records[0].runtimePending, false);
  source = 'rollback-renamed';
  assert.equal((await f.call('pre_replace', 'B', 'A')).disposition, 'ready');
  runtime = '24';
  assert.equal((await f.call('post_replace', 'A', 'A')).disposition, 'ready');
  assert.equal(f.current().binding, 'A/24');
  assert.equal(source, 'rollback-renamed');
});

test('deferred same-root Node24/26 inverse and later Node27 use exact captured terminal intent', async () => {
  const f = fixture(); let runtime = '24';
  f.platform.plan = async request => ({ payload: request.replacementRoot, grammar: 'book-v1' });
  const desired = f.platform.desired;
  f.platform.desired = request => desired({ ...request, node: runtime });
  await f.call('pre_replace', 'A', 'A'); runtime = '26';
  assert.equal((await f.call('post_replace', 'A', 'A')).disposition, 'ready');
  await f.call('pre_replace', 'A', 'A'); runtime = '24';
  assert.equal((await f.call('post_replace', 'A', 'A')).disposition, 'ready');
  assert.equal(f.current().binding, 'A/24');
  await f.call('pre_replace', 'A', 'A'); runtime = '26'; await f.call('post_replace', 'A', 'A');
  f.mutate({ enabled: false, active: false });
  await f.call('pre_replace', 'A', 'A'); runtime = '27';
  assert.equal((await f.call('post_replace', 'A', 'A')).disposition, 'safe_inactive');
  assert.equal(f.records.at(-1).before.binding, 'A/26');
  assert.equal(f.current().binding, 'A/27'); assert.equal(f.current().enabled, false);
});

test('partial admitted post cannot be replaced by another runtime under the same payload plan', async () => {
  const f = fixture(); let runtime = '24';
  f.platform.plan = async request => ({ payload: request.replacementRoot, grammar: 'book-v1' });
  const desired = f.platform.desired; f.platform.desired = request => desired({ ...request, node: runtime });
  await f.call('pre_replace'); runtime = '26';
  const apply = f.platform.apply;
  f.platform.apply = async (...args) => { await apply(...args); throw Error('unknown reply'); };
  assert.equal((await f.call('post_replace')).disposition, 'failed');
  const count = f.effects.length; runtime = '27';
  assert.equal((await f.call('post_replace')).disposition, 'failed'); assert.equal(f.effects.length, count);
  runtime = '26'; f.platform.apply = apply;
  assert.equal((await f.call('post_replace')).disposition, 'ready');
});
