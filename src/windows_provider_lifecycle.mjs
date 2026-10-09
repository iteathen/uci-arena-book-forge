import { createHash } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WindowsTaskScheduler } from '@uci-arena/background-service-runtime/windows-task-scheduler';
import { buildTaskXml, startupAction, startupTaskName } from './windows_startup.mjs';
import { admitBookComponentRoot } from './provider_root.mjs';
import { bindWindowsTaskToRoot } from './provider_action.mjs';
import { readDaemonOwnershipPacket } from './daemon.mjs';
import { observeDaemonActivity, observeDaemonDrainObstacle, observeOwnedLegacyActivity, observeCapturedDaemonExit } from './daemon_observation.mjs';
import { probeProcessInstance, sameProcessInstance, validProcessIdentity } from './process_identity.mjs';
import { admitBookNodeExecutable } from './provider_executable.mjs';
import { readBookCatalogVersion, restoreBookCatalog4 } from './provider_catalog_compatibility.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalize = value => path.win32.normalize(value).replace(/[\\/]+$/u, '').toLowerCase();
const failed = () => new Error('Book Windows lifecycle proof unavailable');
const actionFrom = action => ({ command: action.command, arguments: action.arguments,
  working_directory: action.workingDirectory ?? action.working_directory });
const payloadFrom = descriptor => ({ componentVersion: descriptor.componentVersion,
  componentManifestSha256: descriptor.componentManifestSha256, inventorySha256: descriptor.inventorySha256 });
const retainedDescriptor = value => ({ root: value.root, ...value.payloadIdentity,
  packageRoot: path.join(value.root, 'services/book-forge'), cli: path.join(value.root, 'services/book-forge/src/cli.mjs'),
  launcher: path.join(value.root, 'services/book-forge/native/bin/uci_arena_service_launcher.exe') });

export class WindowsBookLifecyclePlatform {
  constructor(config, { roots, candidateRoots = [], scheduler = new WindowsTaskScheduler(), nodeExecutable = process.execPath,
    admitRoot = admitBookComponentRoot, activity = observeDaemonActivity, drain = observeDaemonDrainObstacle,
    legacyActivity = observeOwnedLegacyActivity, probe = probeProcessInstance,
    readLock = readDaemonOwnershipPacket, now = Date.now, pause = delay,
    taskPath = `\\${startupTaskName}`, readinessMs = 30000, userSid = null,
    executableIdentity = admitBookNodeExecutable, capturedExit = observeCapturedDaemonExit,
    catalogVersion = readBookCatalogVersion, restoreCatalog = restoreBookCatalog4 } = {}) {
    Object.assign(this, { config, roots, candidateRoots, scheduler, nodeExecutable, admitRoot, activity, drain,
      legacyActivity, probe, readLock, now, pause, taskPath, readinessMs, userSid, executableIdentity, capturedExit, catalogVersion, restoreCatalog });
    this.descriptors = new Map(); this.records = []; this.absence = null; this.launch = null;
    this.executables = new Map();
  }
  async descriptor(root) {
    const key = normalize(root);
    if (!this.descriptors.has(key)) this.descriptors.set(key, await this.admitRoot(root));
    return this.descriptors.get(key);
  }
  async nodeIdentity(filename) {
    const key = normalize(filename);
    if (!this.executables.has(key)) this.executables.set(key, await this.executableIdentity(filename));
    return this.executables.get(key);
  }
  binding(descriptor, action, nodeSha256) {
    // Exact ordered argv bytes are authority. A runtime-only same-root upgrade
    // must not accidentally reuse a previous terminal record.
    return hash({ root: normalize(descriptor.root), manifest: descriptor.componentManifestSha256,
      workspace: normalize(this.config.workspace), configuration: this.config.configFile ? normalize(this.config.configFile) : null,
      action, nodeSha256 });
  }
  async begin(records) {
    this.records = records;
    for (const root of this.roots) await this.descriptor(root);
    // Retired historical roots are not a hidden lifetime dependency. Optional
    // prior roots only classify an actual current action; a missing/changed
    // required destination still fails before any restoration effect.
    for (const root of this.candidateRoots) {
      try { await this.descriptor(root); } catch {}
    }
  }
  async task(operation, current = null, extra = {}) {
    const request = { operation, task_path: this.taskPath, ...(operation === 'inspect' ? {} : {
      expected_definition_xml: current?.registered ? current.definition_xml : null,
      expected_xml_sha256: current?.registered ? current.definition_sha256 : null }), ...extra };
    const result = await this.scheduler.perform(request, { timeoutMs: 30000 });
    if (result.outcome !== 'completed') throw failed();
    return result.observation;
  }
  async plan(request) {
    const root = request.replacementRoot;
    let descriptor;
    if (request.operation !== 'pre_replace') descriptor = await this.descriptor(root);
    else {
      // A retained different-root inverse keeps its original payload identity.
      // Forward and same-root pre project the admitted controller payload; an
      // existing old destination is not the forthcoming committed payload.
      const retained = request.previousRoot && normalize(request.previousRoot) !== normalize(root) ?
        [...this.records].reverse().filter(record => record.preDone).flatMap(record => [record.before, record.predecessorBefore])
          .find(value => value?.root && normalize(value.root) === normalize(root) && value.payloadIdentity) : null;
      descriptor = retained ? retainedDescriptor(retained) : { ...(await this.descriptor(this.roots[0])), root };
    }
    return { schema: 'book_lifecycle_target_plan_v1', root: normalize(root), payload: payloadFrom(descriptor),
      workspace: normalize(this.config.workspace), configuration: this.config.configFile ? normalize(this.config.configFile) : null,
      launchGrammar: 'book_windows_restart_daemon_v1' };
  }
  async desired(request) {
    if (request.operation === 'uninstall') {
      const current = await this.inspect();
      if (current.registered) return this.capture(current, request);
      const ownPayload = payloadFrom(await this.descriptor(this.roots[0]));
      const pending = [...this.records].reverse().find(record => !record.postDone &&
        record.before.registered === false && JSON.stringify(record.desired.payloadIdentity) === JSON.stringify(ownPayload));
      if (pending) return structuredClone(pending.desired);
    }
    const root = request.replacementRoot ?? this.roots[0];
    const descriptor = await this.descriptor(root);
    const action = actionFrom(startupAction(this.config, { descriptor, nodeExecutable: this.nodeExecutable }));
    const current = await this.task('inspect');
    const sid = current.principal?.current_user_sid ?? this.userSid;
    if (!sid) throw failed();
    const xml = buildTaskXml(this.config, sid, { descriptor, nodeExecutable: this.nodeExecutable, enabled: false,
      taskName: this.taskPath.slice(1) });
    return { binding: this.binding(descriptor, action, await this.nodeIdentity(this.nodeExecutable)), root: descriptor.root, registered: true,
      enabled: false, active: false, nodeExecutable: this.nodeExecutable,
      task: { action, definition_xml: xml, definition_sha256: createHash('sha256').update(xml).digest('hex') },
      obstacleIdentity: null, nonce: null, launch: null, payloadIdentity: payloadFrom(descriptor),
      catalogSchemaVersion: descriptor.componentVersion === '0.4.4' ? 4 : 5 };
  }
  async inspect() {
    const task = await this.task('inspect');
    const activity = await this.activity(this.config);
    const drain = await this.drain(this.config);
    let binding = 'absent', descriptor = null, nodeExecutable = null;
    if (task.registered) {
      // A physically retired/overwritten prior payload may still have its exact
      // disabled task definition. Only a saved, positively quiesced before-image
      // can classify that non-executing action; no missing target can be launched.
      const saved = [...this.records].reverse().find(record => record.preDone && !record.postDone &&
        record.last?.active === false && record.last.definition === task.definition_sha256 &&
        !task.enabled && !task.instance_guids.length && record.before.payloadIdentity &&
        JSON.stringify(record.before.task.action) === JSON.stringify(task.action));
      if (saved && activity.ownerLive !== true && drain.state !== 'present' &&
          (!saved.before.obstacleIdentity || this.gone(saved.before.obstacleIdentity)) &&
          (drain.state === 'absent' || await this.capturedExit(this.config, {
            identity: saved.before.obstacleIdentity, nonce: saved.before.nonce, now: this.now, probe: this.probe }))) {
        descriptor = retainedDescriptor(saved.before); binding = saved.before.binding; nodeExecutable = saved.before.nodeExecutable;
      }
      for (const selected of descriptor ? [] : this.descriptors.values()) {
        try {
          const tuple = bindWindowsTaskToRoot(task, selected, this.config);
          descriptor = selected; nodeExecutable = tuple.nodeExecutable; binding = this.binding(selected, tuple.action, await this.nodeIdentity(tuple.nodeExecutable)); break;
        } catch {}
      }
      if (!descriptor) {
        // Re-admit only the actual current retained action, never every retired
        // historical payload. Completed records cannot authorize missing bytes.
        const retained = [...this.records].reverse().flatMap(record => [record.desired, record.before, record.predecessorBefore])
          .find(value => value?.registered && JSON.stringify(value.task.action) === JSON.stringify(task.action));
        if (retained) {
          const admitted = await this.descriptor(retained.root);
          const tuple = bindWindowsTaskToRoot(task, admitted, this.config);
          const observedBinding = this.binding(admitted, tuple.action, await this.nodeIdentity(tuple.nodeExecutable));
          if (observedBinding !== retained.binding) throw failed();
          descriptor = admitted; nodeExecutable = tuple.nodeExecutable; binding = observedBinding;
        }
      }
      if (!descriptor) throw failed();
    }
    let active = activity.ownerLive === true && activity.active === false ? null : activity.active;
    let obstacleIdentity = activity.ownerLive ? activity.identity : drain.currentIncarnation;
    if (drain.state === 'absent' && activity.ownerLive !== true) active = false;
    if (active === null && task.instance_guids.length === 0) {
      // A previously captured owner can supply an absence proof after a clean
      // stop even when the daemon removed its lock on exit. Unknown packets do
      // not turn into absence; a replacement current record is checked below.
      const captures = this.absence ? [{ identity: this.absence, nonce: this.previousNonce }] :
        this.records.filter(r => [r.before.binding, r.desired.binding].includes(binding)).map(r => ({
          identity: r.before.obstacleIdentity, nonce: r.before.nonce })).filter(value => value.identity);
      for (const capture of captures) if (await this.capturedExit(this.config, { ...capture,
        now: this.now, probe: this.probe })) { active = false; break; }
    }
    if (this.launch && descriptor?.componentVersion === '0.4.4') {
      const observed = await this.legacyActivity(this.config, { launch: this.launch, task });
      if (observed.active === true) { active = true; obstacleIdentity = observed.identity; }
    } else if (descriptor?.componentVersion === '0.4.4') {
      const retained = [...this.records].reverse().flatMap(r => [r.before, r.desired]).find(t => t.binding === binding && t.launch);
      if (retained) {
        const observed = await this.legacyActivity(this.config, { launch: retained.launch, task });
        if (observed.active === true) { active = true; obstacleIdentity = observed.identity; }
      }
    }
    const lock = await this.readLock(path.join(this.config.paths.locks, 'daemon.lock'));
    if (active === true && (!validProcessIdentity(obstacleIdentity) ||
        !sameProcessInstance(obstacleIdentity, { ...obstacleIdentity, executable_path: nodeExecutable }))) active = null;
    return { binding, root: descriptor?.root ?? null, componentVersion: descriptor?.componentVersion ?? null, registered: task.registered,
      enabled: task.registered ? task.enabled : false, active,
      orphan: (activity.ownerLive === true || drain.state === 'present') && task.instance_guids.length === 0,
      task, nodeExecutable, obstacleIdentity, nonce: lock?.value?.nonce ?? null, launch: this.launch,
      ownershipUnverifiable: drain.state === 'unverifiable' && active === null,
      ...(descriptor ? { payloadIdentity: payloadFrom(descriptor) } : {}),
      catalogSchemaVersion: this.catalogVersion(this.config) };
  }
  gone(identity) {
    if (!validProcessIdentity(identity)) return false;
    const observed = this.probe(identity.pid);
    return observed.state === 'absent' || (observed.state === 'present' &&
      validProcessIdentity(observed.identity) && !sameProcessInstance(observed.identity, identity));
  }
  async capture(observed, request) {
    if (observed.orphan || (!observed.registered && observed.active !== false) ||
        (['pre_replace', 'post_replace'].includes(request.operation) && observed.registered && observed.root &&
          request.previousRoot && normalize(observed.root) !== normalize(request.previousRoot))) throw failed();
    // A legacy task-owned live tree is preserved as running intent, never as an
    // active observation. Its next ready result requires controlled restart.
    const running = observed.task.instance_guids.length > 0;
    if (observed.active === null && !(observed.componentVersion === '0.4.4' &&
        running && validProcessIdentity(observed.obstacleIdentity))) throw failed();
    if (running && !observed.enabled) throw failed();
    return { ...observed, active: observed.active === true || running,
      launch: observed.launch ?? null };
  }
  async quiesce(observed) {
    if (observed.orphan || observed.ownershipUnverifiable) throw failed();
    if (!observed.registered) { if (observed.active !== false) throw failed(); return; }
    let task = await this.task('set_enabled', observed.task, { enabled: false });
    if (task.instance_guids.length) task = await this.task('stop_instances', task, { instance_guids: [...task.instance_guids] });
    const stoppedDefinition = task.definition_sha256;
    const limit = performance.now() + this.readinessMs;
    do {
      task = await this.task('inspect');
      if (!task.registered || task.enabled || task.definition_sha256 !== stoppedDefinition || task.action.command !== observed.task.action.command ||
          task.action.arguments !== observed.task.action.arguments ||
          task.action.working_directory !== observed.task.action.working_directory) throw failed();
      if (!task.instance_guids.length && (!observed.obstacleIdentity || this.gone(observed.obstacleIdentity))) {
        const next = await this.drain(this.config);
        if (next.state === 'present') throw failed();
        if (observed.obstacleIdentity) this.absence = observed.obstacleIdentity;
        this.lastAbsentAtUtcMs = this.now(); this.previousNonce = observed.nonce;
        return;
      }
      await this.pause(100);
    } while (performance.now() < limit);
    throw failed();
  }
  async apply(target, current) {
    const descriptor = await this.admitRoot(target.root);
    const admitted = bindWindowsTaskToRoot({ registered: true, action: target.task.action }, descriptor, this.config);
    if (this.binding(descriptor, admitted.action, await this.executableIdentity(admitted.nodeExecutable)) !== target.binding ||
        typeof target.enabled !== 'boolean' || typeof target.active !== 'boolean' ||
        target.task.definition_sha256 !== createHash('sha256').update(target.task.definition_xml).digest('hex')) throw failed();
    if (descriptor.componentVersion === '0.4.4' && target.catalogSchemaVersion === 4) {
      if (current.active !== false || current.orphan || current.task.instance_guids.length) throw failed();
      this.restoreCatalog(this.config, { probe: this.probe });
    }
    this.activationWindow = null;
    if (target.active) this.markActivationWindow(target, current);
    let task = await this.task('register', current.task, { definition_xml: target.task.definition_xml });
    task = await this.task('set_enabled', task, { enabled: target.enabled });
    if (this.binding(descriptor, bindWindowsTaskToRoot(task, descriptor, this.config).action, await this.nodeIdentity(admitted.nodeExecutable)) !== target.binding ||
        task.enabled !== target.enabled) throw failed();
  }
  markActivationWindow(target, current) {
    if (current.active !== false || current.orphan || current.task.instance_guids.length ||
        (current.registered && current.enabled)) throw failed();
    const originUtcMs = this.now();
    this.activationWindow = { binding: target.binding, originUtcMs,
      previousNonce: this.previousNonce ?? current.nonce ?? target.nonce,
      previousOwnerAbsentAtUtcMs: this.lastAbsentAtUtcMs ?? originUtcMs };
  }
  async activate(target, current) {
    if (current.task.instance_guids.length && current.active !== true) {
      await this.quiesce(current);
      current = await this.inspect();
      this.markActivationWindow(target, current);
      await this.task('set_enabled', current.task, { enabled: target.enabled });
      current = await this.inspect();
    }
    if (!current.enabled || current.binding !== target.binding || current.orphan) throw failed();
    const descriptor = await this.admitRoot(target.root);
    const action = bindWindowsTaskToRoot(current.task, descriptor, this.config);
    if (this.binding(descriptor, action.action, await this.executableIdentity(action.nodeExecutable)) !== target.binding) throw failed();
    const before = await this.readLock(path.join(this.config.paths.locks, 'daemon.lock'));
    const window = this.activationWindow?.binding === target.binding ? this.activationWindow : null;
    const previousNonce = window?.previousNonce ?? this.previousNonce ?? before?.value?.nonce ?? target.nonce;
    const originUtcMs = window?.originUtcMs ?? this.now();
    const task = await this.task('run', current.task);
    if (descriptor.componentVersion === '0.4.4') {
      this.launch = { originUtcMs, previousNonce, previousOwnerAbsentAtUtcMs: window?.previousOwnerAbsentAtUtcMs ?? this.lastAbsentAtUtcMs ?? originUtcMs,
        expectedNodeExecutable: target.nodeExecutable, taskDefinitionSha256: task.definition_sha256,
        taskEnabled: task.enabled, instanceGuids: [...task.instance_guids] };
      target.launch = this.launch;
    }
    const limit = performance.now() + this.readinessMs;
    do {
      // Run may be queued before GetRunningTasks exposes the actual instance.
      // This bounded owned-start window never grants Task0 activity or changes
      // a GUID: capture only a real positive observation of the same definition.
      const running = await this.task('inspect');
      if (!running.registered || !running.enabled || running.definition_sha256 !== task.definition_sha256 ||
          JSON.stringify(running.action) !== JSON.stringify(task.action)) throw failed();
      if (!running.instance_guids.length) { await this.pause(100); continue; }
      if (this.launch && !this.launch.instanceGuids.length) this.launch.instanceGuids = [...running.instance_guids];
      const next = await this.inspect();
      if (next.binding !== target.binding || !next.enabled) throw failed();
      if (next.active === true && !next.orphan && next.task.instance_guids.length) return;
      await this.pause(100);
    } while (performance.now() < limit);
    throw failed();
  }
  async remove(current) {
    if (current.active !== false || current.orphan) throw failed();
    await this.task('delete', current.task);
  }
}
