import { validLifecycleIntent } from './provider_state.mjs';

const operations = new Set(['install', 'uninstall', 'pre_replace', 'post_replace']);

export function lifecycleResult(operation, version, disposition, observed, reason = null) {
  return { schema: 'arena_provider_lifecycle_result_v1', schema_version: 1,
    component_id: 'book_forge.service', component_version: version, operation,
    disposition, observed, ...(reason ? { reason } : {}) };
}
const unknown = { installation: 'unknown', activity: 'unknown', configuration: 'unknown', replacement: 'unknown' };
const failed = (operation, version) => lifecycleResult(operation, version, 'failed', { ...unknown },
  { id: 'book_lifecycle_unproven', message: 'Book lifecycle target or ownership could not be proven; existing before-state is preserved.' });
const terminal = value => ({ binding: value.binding, enabled: value.enabled, active: value.active,
  definition: value.task?.definition_sha256 ?? null });
const unchanged = (last, value) => last !== null && JSON.stringify(last) === JSON.stringify(terminal(value));
function makeRoom(state) {
  const latest = [...state.records].reverse().find(record => record.postDone);
  // A later exact before-image supersedes older completed history. Keep the
  // latest completed transition (current compensation) and every unfinished
  // transition. Retire on every new capture, not just at the record-count cap:
  // otherwise legal large definitions can exhaust the serialized-byte cap.
  const retained = state.records.filter(record => !record.postDone || record === latest);
  if (retained.length >= 16) throw Error();
  state.records.splice(0, state.records.length, ...retained);
}

const samePlan = (left, right) => JSON.stringify(left) === JSON.stringify(right);
async function deferredReplacement(request, state, platform, version) {
  const plan = await platform.plan(request);
  let current = await platform.inspect();
  let selected;
  if (request.operation === 'pre_replace') {
    selected = [...state.records].reverse().find(record => !record.postDone && record.plan &&
      samePlan(record.plan, plan) && [record.before.binding, record.desired.binding].includes(current.binding));
    if (!selected) {
      if (state.records.some(record => !record.postDone)) throw Error();
      if (!current.registered) throw Error();
      const predecessor = [...state.records].reverse().find(record => record.postDone &&
        record.desired.binding === current.binding && unchanged(record.last, current));
      const before = await platform.capture(current, request);
      makeRoom(state);
      selected = { before, desired: structuredClone(before), preDone: false, postDone: false, last: null,
        plan, runtimePending: true, predecessorBefore: predecessor ? structuredClone(predecessor.before) : null };
      state.records.push(selected); await state.save();
    }
    await platform.quiesce(current);
    current = await platform.inspect();
    if (!current.registered || current.active !== false || current.orphan) throw Error();
    selected.preDone = true; selected.last = terminal(current); await state.save();
    return lifecycleResult(request.operation, version, 'ready', {
      installation: 'installed', activity: 'inactive', configuration: 'matches', replacement: 'safe' });
  }
  // No effect precedes this physical destination/runtime admission. The pre
  // plan deliberately contains no guessed future executable or task XML.
  const desired = await platform.desired(request);
  if (!validLifecycleIntent(desired)) throw Error();
  selected = [...state.records].reverse().find(record => record.plan &&
    (samePlan(record.plan, plan) || record.before.binding === desired.binding || record.predecessorBefore?.binding === desired.binding) &&
    [record.before.binding, record.desired.binding].includes(current.binding) &&
    (!record.postDone || unchanged(record.last, current)));
  if (!selected) {
    if (state.records.some(record => !record.postDone)) throw Error();
    const before = await platform.capture(current, request);
    makeRoom(state);
    selected = { before, desired, preDone: false, postDone: false, last: null,
      plan, runtimePending: false, predecessorBefore: null };
    state.records.push(selected); await state.save();
  }
  if (!selected.postDone && !selected.runtimePending &&
      ![selected.desired.binding, selected.before.binding, selected.predecessorBefore?.binding].includes(desired.binding)) throw Error();
  const original = selected.before.binding === desired.binding ? selected.before :
    selected.predecessorBefore?.binding === desired.binding ? selected.predecessorBefore : null;
  const target = original ? structuredClone(original) : { ...desired,
    enabled: selected.before.registered ? selected.before.enabled : true,
    active: selected.before.registered ? selected.before.active : true };
  if (selected.postDone && selected.desired.binding === target.binding && unchanged(selected.last, current)) {
    // A completed response is idempotent only with its exact terminal intent.
  } else {
    selected.desired = target; selected.runtimePending = false; selected.postDone = false;
    await state.save(); // Actual full post tuple is durable before effects.
  }
  if (!current.registered || current.binding !== target.binding || current.enabled !== target.enabled) {
    if (current.registered) await platform.quiesce(current);
    await platform.apply(target, await platform.inspect());
  }
  current = await platform.inspect();
  if (target.active && current.active !== true) {
    await platform.activate(target, current);
    if (target.launch) selected.desired.launch = target.launch;
  }
  if (!target.active && current.active !== false) await platform.quiesce(current);
  current = await platform.inspect();
  if (!current.registered || current.binding !== target.binding || current.enabled !== target.enabled ||
      current.active !== target.active || current.orphan) throw Error();
  selected.postDone = true; selected.last = terminal(current); await state.save();
  return lifecycleResult(request.operation, version, target.active ? 'ready' : 'safe_inactive', {
    installation: 'installed', activity: target.active ? 'active' : 'inactive', configuration: 'matches', replacement: 'safe',
  }, target.active ? null : { id: 'book_preserved_inactive', message: 'The captured inactive startup intent is preserved.' });
}

// This actor owns Book policy. Platform effects are implemented by the Book
// adapters, and storage is private producer before-state, never Installer state.
export async function convergeBookLifecycle(request, { platform, store, version }) {
  const operation = request.operation;
  if (!operations.has(operation)) throw new TypeError('Invalid Book lifecycle operation');
  try {
    return await store.transact(async state => {
      if (state.records.some(record => !validLifecycleIntent(record.before) || !validLifecycleIntent(record.desired))) throw Error();
      await platform.begin?.(state.records);
      if (typeof platform.plan === 'function' && ['pre_replace', 'post_replace'].includes(operation)) {
        return deferredReplacement(request, state, platform, version);
      }
      const desired = await platform.desired(request);
      if (!validLifecycleIntent(desired)) throw Error();
      let current = await platform.inspect();
      if (operation === 'uninstall') {
        const unfinished = state.records.filter(record => !record.postDone);
        const compensatingInstall = record => record.before.registered === false &&
          record.desired.binding === desired.binding &&
          (current.binding === record.desired.binding || current.binding === 'absent');
        const continuingUninstall = record => record.desired.binding === 'absent' &&
          record.before.binding === desired.binding &&
          (current.binding === record.before.binding || current.binding === 'absent');
        if (unfinished.some(record => !compensatingInstall(record) && !continuingUninstall(record))) throw Error();
        if (current.registered) {
          let existing = [...state.records].reverse().find(record => record.desired.binding === 'absent' && record.before.binding === current.binding);
          if (existing?.postDone && !unchanged(existing.last, current)) existing = undefined;
          if (!existing) {
            const before = await platform.capture(current, request);
            makeRoom(state);
            existing = { before, desired: { binding: 'absent', registered: false, enabled: false, active: false }, preDone: false, postDone: false, last: null };
            state.records.push(existing);
            await state.save();
          }
          await platform.quiesce(current);
          existing.preDone = true; existing.last = terminal(await platform.inspect()); await state.save();
          await platform.remove(await platform.inspect());
        }
        current = await platform.inspect();
        if (current.registered || current.active !== false || current.orphan) throw Error();
        const removed = [...state.records].reverse().find(record => record.desired.binding === 'absent' && record.preDone);
        if (removed) { removed.postDone = true; removed.last = terminal(current); await state.save(); }
        for (const record of unfinished.filter(compensatingInstall)) {
          record.postDone = true; record.last = terminal(current); await state.save();
        }
        return lifecycleResult(operation, version, 'ready', { installation: 'absent', activity: 'inactive',
          configuration: 'not_applicable', replacement: 'not_applicable' });
      }
      // Prefer the most recent applicable captured transition. A same-root
      // runtime replacement has a different full binding and captures anew.
      let selected = [...state.records].reverse().find(record =>
        (record.desired.binding === desired.binding || record.before.binding === desired.binding) &&
        (current.binding === record.desired.binding || current.binding === record.before.binding));
      // A completed transaction is not permanent authority over later operator
      // intent. The exact retained terminal observation distinguishes immediate
      // retries from a new baseline with the same root/runtime/action binding.
      if (selected?.postDone && !unchanged(selected.last, current)) selected = undefined;
      let restoring = selected?.before.binding === desired.binding;
      if (!selected) {
        if (state.records.some(record => !record.postDone)) throw Error();
        if (operation === 'pre_replace' && !current.registered) throw Error();
        const before = await platform.capture(current, request);
        makeRoom(state);
        selected = { before, desired, preDone: false, postDone: false, last: null };
        state.records.push(selected);
        await state.save(); // Strictly before gate/registration/run effects.
        restoring = before.binding === desired.binding;
      }
      const target = restoring ? selected.before : { ...selected.desired,
        enabled: selected.before.registered ? selected.before.enabled : true,
        active: selected.before.registered ? selected.before.active : true };
      if (operation === 'pre_replace') {
        if (!current.registered) throw Error();
        if (selected.postDone) {
          selected.postDone = false; selected.preDone = false; await state.save();
        }
        await platform.quiesce(current);
        current = await platform.inspect();
        if (!current.registered || current.active !== false || current.orphan) throw Error();
        selected.preDone = true; selected.last = terminal(current); await state.save();
        return lifecycleResult(operation, version, 'ready', { installation: 'installed', activity: 'inactive',
          configuration: 'matches', replacement: 'safe' });
      }
      if (selected.postDone && (current.binding !== target.binding || current.enabled !== target.enabled ||
          current.active !== target.active || current.orphan)) {
        selected.postDone = false; await state.save();
      }
      if (!current.registered || current.binding !== target.binding || current.enabled !== target.enabled) {
        if (current.registered) await platform.quiesce(current);
        await platform.apply(target, await platform.inspect());
      }
      current = await platform.inspect();
      if (target.active && current.active !== true) {
        await platform.activate(target, current);
        if (!restoring && target.launch) selected.desired.launch = target.launch;
      }
      if (!target.active && current.active !== false) await platform.quiesce(current);
      current = await platform.inspect();
      if (!current.registered || current.binding !== target.binding || current.enabled !== target.enabled ||
          current.active !== target.active || current.orphan) throw Error();
      selected.postDone = true; selected.last = terminal(current); await state.save();
      return lifecycleResult(operation, version, target.active ? 'ready' : 'safe_inactive', {
        installation: 'installed', activity: target.active ? 'active' : 'inactive', configuration: 'matches',
        replacement: operation === 'install' ? 'not_applicable' : 'safe',
      }, target.active ? null : { id: 'book_preserved_inactive', message: 'The captured inactive startup intent is preserved.' });
    });
  } catch { return failed(operation, version); }
}
