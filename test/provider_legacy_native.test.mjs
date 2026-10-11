import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WindowsTaskScheduler } from '@uci-arena/background-service-runtime/windows-task-scheduler';
import { packageRoot, loadConfig } from '../src/config.mjs';
import { admitBookComponentRoot } from '../src/provider_root.mjs';
import { currentUserSid } from '../src/windows_startup.mjs';
import { configureProcessIdentity, probeProcessInstance, sameProcessInstance, validProcessIdentity } from '../src/process_identity.mjs';
import { observeDaemonDrainObstacle } from '../src/daemon_observation.mjs';
import { readDaemonOwnershipPacket } from '../src/daemon.mjs';
import { BookLifecycleStore } from '../src/provider_state.mjs';
import { WindowsBookLifecyclePlatform } from '../src/windows_provider_lifecycle.mjs';
import { convergeBookLifecycle } from '../src/provider_lifecycle.mjs';

const execute = promisify(execFile); const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('owned immutable044 clone: actual24 staged-pre,26 final-post,renamed-controller24 inverse and legacy proof', {
  skip: process.platform !== 'win32' || !process.env.BOOK_LEGACY_PUBLIC_COMPONENT_ROOT || !process.env.BOOK_LEGACY_NODE_EXECUTABLE,
  timeout: 240000,
}, async () => {
  // This is immutable PUBLIC component payload only, never provider data,
  // configuration, task, catalog or credentials from the installed service.
  const original = process.env.BOOK_LEGACY_PUBLIC_COMPONENT_ROOT;
  const oldNode = await realpath(process.env.BOOK_LEGACY_NODE_EXECUTABLE);
  assert.equal((await execute(oldNode, ['--version'])).stdout.trim(), 'v24.15.0');
  await admitBookComponentRoot(original);
  const parent = await realpath(os.tmpdir()); const fixture = await realpath(await mkdtemp(path.join(parent, 'book-v3-legacy-')));
  const oldRoot = path.join(fixture, 'old-component'), newRoot = path.join(fixture, 'stage-component');
  const finalRoot = path.join(fixture, 'future-final'), rollbackRoot = path.join(fixture, 'renamed-rollback-controller');
  const workspace = path.join(fixture, 'workspace'); const taskPath = `\\UCI Arena Book Forge Test ${randomUUID()}`;
  const scheduler = new WindowsTaskScheduler(); let config = null, complete = false;
  try {
    const oldManifest = JSON.parse(await readFile(path.join(original, 'arena-component.json')));
    for (const row of oldManifest.files) {
      const source = path.join(original, row.path); const destination = path.join(oldRoot, row.path);
      const bytes = await readFile(source); assert.equal(hash(bytes), row.sha256); assert.equal(bytes.length, row.size_bytes);
      await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, bytes);
    }
    await writeFile(path.join(oldRoot, 'arena-component.json'), JSON.stringify(oldManifest));
    const destination = path.join(newRoot, 'services/book-forge'); await mkdir(destination, { recursive: true });
    for (const name of ['src', 'node_modules', 'policy', 'package.json', 'package-lock.json', 'native']) {
      await cp(path.join(packageRoot, name), path.join(destination, name), { recursive: true });
    }
    const files = [];
    async function collect(directory, relative = '') {
      for (const name of await readdir(directory)) {
        const absolute = path.join(directory, name); const selected = relative ? `${relative}/${name}` : name;
        const stat = await lstat(absolute); assert.equal(stat.isSymbolicLink(), false);
        if (stat.isDirectory()) await collect(absolute, selected);
        else { assert.equal(stat.isFile(), true); const bytes = await readFile(absolute);
          files.push({ path: selected, sha256: hash(bytes), size_bytes: bytes.length }); }
      }
    }
    await collect(newRoot);
    await writeFile(path.join(newRoot, 'arena-component.json'), JSON.stringify({ schema: 'arena_install_component_v1', schema_version: 1,
      component_id: 'book_forge.service', component_version: '0.4.9', target_triple: 'windows-x86_64',
      entrypoints: { cli: 'services/book-forge/src/cli.mjs', startup_launcher: 'services/book-forge/native/bin/uci_arena_service_launcher.exe',
        process_identity_helper: 'services/book-forge/native/bin/uci_arena_background_guard.exe' }, files }));
    await mkdir(workspace); const configFile = path.join(workspace, 'config.json');
    await writeFile(configFile, JSON.stringify({ schema: 'uci_arena_book_forge_config_v1', workspace,
      acquisition: { enabled: false }, analysis: { enabled: false },
      nativeHelper: path.join(destination, 'native/bin/uci_arena_background_guard.exe'),
      nativeLauncher: path.join(destination, 'native/bin/uci_arena_service_launcher.exe') }));
    config = await loadConfig({ workspace, configFile }); assert.equal(await configureProcessIdentity(config), true);
    const oldDescriptor = await admitBookComponentRoot(oldRoot); const sid = await currentUserSid();
    const oldStartup = await import(pathToFileURL(path.join(oldDescriptor.packageRoot, 'src/windows_startup.mjs')));
    const xmlArgument = value => oldStartup.quoteWindowsArgument(value).replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
    const oldXml = oldStartup.buildTaskXml({ ...config, nativeLauncher: oldDescriptor.launcher }, sid)
      .replace('<URI>\\UCI Arena Book Forge</URI>', `<URI>${taskPath}</URI>`)
      .replace(xmlArgument(process.execPath), xmlArgument(oldNode));
    const xmlFile = path.join(fixture, 'old-template.xml'); await writeFile(xmlFile, '\ufeff' + oldXml, 'utf16le');
    // Establish prior definition through the SAME published old registration
    // route, under a unique fixture name; never invoke the old lifecycle CLI.
    await execute(path.join(process.env.SystemRoot, 'System32/schtasks.exe'), ['/Create', '/TN', taskPath, '/XML', xmlFile, '/F'],
      { windowsHide: true, timeout: 20000 });
    let observed = (await scheduler.perform({ operation: 'inspect', task_path: taskPath })).observation;
    assert.equal(observed.registered, true);
    const run = await scheduler.perform({ operation: 'run', task_path: taskPath,
      expected_definition_xml: observed.definition_xml, expected_xml_sha256: observed.definition_sha256 });
    assert.equal(run.outcome, 'completed');
    let obstacle; const limit = performance.now() + 30000;
    do { obstacle = await observeDaemonDrainObstacle(config); if (obstacle.state === 'present') break; await delay(100); } while (performance.now() < limit);
    assert.equal(obstacle.state, 'present');
    const oldLock = await readDaemonOwnershipPacket(path.join(config.paths.locks, 'daemon.lock'));
    assert.equal(oldLock.value.schema, undefined); const firstNonce = oldLock.value.nonce;
    // Actual separate interpreter processes exercise the public CLI ingress.
    // Only the fixture namespace is injected into the already public platform
    // constructor; no installed task name or production wire is changed.
    const driver = path.join(fixture, 'controller-fixture.mjs');
    await writeFile(driver, `import path from 'node:path'; import {pathToFileURL} from 'node:url';
const [root,taskPath,...argv]=process.argv.slice(2);
const base=path.join(root,'services/book-forge/src');
const {main}=await import(pathToFileURL(path.join(base,'cli.mjs')));
const {runBookLifecycle}=await import(pathToFileURL(path.join(base,'provider_command.mjs')));
const {WindowsBookLifecyclePlatform}=await import(pathToFileURL(path.join(base,'windows_provider_lifecycle.mjs')));
const {observeOwnedLegacyActivity,observeDaemonActivity,observeDaemonDrainObstacle}=await import(pathToFileURL(path.join(base,'daemon_observation.mjs')));
const {restoreBookCatalog4}=await import(pathToFileURL(path.join(base,'provider_catalog_compatibility.mjs')));
const {readDaemonOwnershipPacket}=await import(pathToFileURL(path.join(base,'daemon.mjs')));
const {probeProcessInstance}=await import(pathToFileURL(path.join(base,'process_identity.mjs')));
await main({argv,lifecycleImpl:(config,request)=>runBookLifecycle(config,request,{root,
 platformFactory:options=>{
 const probe=label=>pid=>{const result=probeProcessInstance(pid);console.error(JSON.stringify({phase:'os-probe',label,state:result.state}));return result;};
 const platform=new WindowsBookLifecyclePlatform(config,{...options,taskPath,probe:probe('absence'),
 activity:config=>observeDaemonActivity(config,{probe:probe('activity')}),
 drain:config=>observeDaemonDrainObstacle(config,{probe:probe('drain')}),
 restoreCatalog:(config,options)=>{console.error(JSON.stringify({phase:'catalog-restore-enter'}));
  try{restoreBookCatalog4(config,{...options,probe:probe('catalog')});console.error(JSON.stringify({phase:'catalog-restore-completed'}));}
  catch(error){console.error(JSON.stringify({phase:'catalog-restore-failed'}));throw error;}},
 legacyActivity:async(config,options)=>{
  const result=await observeOwnedLegacyActivity(config,options);
  const lock=await readDaemonOwnershipPacket(path.join(config.paths.locks,'daemon.lock'));
  const observed=lock?.value?.pid?probeProcessInstance(lock.value.pid):null;
  const birth=observed?.state==='present'?Number(BigInt(observed.identity.start_token)/10000n-62135596800000n):null;
  console.error(JSON.stringify({phase:'legacy-proof',active:result.active,origin:options.launch.originUtcMs,
   birth,lockStart:Date.parse(lock?.value?.startedAt),taskCount:options.task.instance_guids.length,
   launchCount:options.launch.instanceGuids.length,nonceChanged:lock?.value?.nonce!==options.launch.previousNonce}));
  return result;}});
 const task=platform.task.bind(platform);platform.task=async(operation,...args)=>{
  const result=await task(operation,...args);console.error(JSON.stringify({phase:'task',operation,
   registered:result.registered,enabled:result.enabled,instances:result.instance_guids.length}));return result;};
 for(const method of ['inspect','quiesce','apply']){const original=platform[method].bind(platform);
  platform[method]=async(...args)=>{console.error(JSON.stringify({phase:'method-enter',method}));try{
   const result=await original(...args);console.error(JSON.stringify({phase:'method-completed',method}));return result;}
   catch(error){console.error(JSON.stringify({phase:'method-failed',method}));throw error;}};}
 return platform;}})});`);
    let callNumber = 0;
    const call = async (node, controlRoot, operation, previousRoot, replacementRoot) => {
      const args = [driver, controlRoot, taskPath, 'lifecycle', operation, '--workspace', workspace, '--config', configFile,
        ...(operation.includes('replace') ? ['--previous-root', previousRoot, '--replacement-root', replacementRoot] : [])];
      const result = await execute(node, args, { windowsHide: true, timeout: 60000, maxBuffer: 1048576 });
      await writeFile(path.join(fixture, `phase-${++callNumber}.jsonl`), result.stderr);
      for (const line of result.stderr.split(/\r?\n/u)) if (line.startsWith('{')) console.error(line);
      const value = JSON.parse(result.stdout.trim());
      console.error(`owned legacy ${operation}: ${value.disposition}; interpreter=${path.basename(path.dirname(node))}`);
      return value;
    };
    assert.equal((await call(oldNode, newRoot, 'pre_replace', oldRoot, finalRoot)).disposition, 'ready');
    assert.equal(probeProcessInstance(obstacle.currentIncarnation.pid).state, 'absent');
    const before = JSON.parse(await readFile(path.join(workspace, '.book-lifecycle/before-state.json')));
    assert.equal(before.records.at(-1).runtimePending, true);
    assert.equal(before.records.at(-1).before.nodeExecutable.toLowerCase(), oldNode.toLowerCase());
    await cp(newRoot, finalRoot, { recursive: true });
    assert.equal((await call(process.execPath, finalRoot, 'post_replace', oldRoot, finalRoot)).disposition, 'ready');
    assert.equal((await call(process.execPath, finalRoot, 'pre_replace', finalRoot, oldRoot)).disposition, 'ready');
    await rename(finalRoot, rollbackRoot);
    assert.equal((await call(oldNode, rollbackRoot, 'post_replace', oldRoot, oldRoot)).disposition, 'ready');
    assert.equal((await call(oldNode, rollbackRoot, 'post_replace', oldRoot, oldRoot)).disposition, 'ready');
    const restored = await readDaemonOwnershipPacket(path.join(config.paths.locks, 'daemon.lock'));
    assert.equal(restored.value.schema, undefined); assert.notEqual(restored.value.nonce, firstNonce);
    const restoredState = JSON.parse(await readFile(path.join(workspace, '.book-lifecycle/before-state.json')));
    assert.ok(restoredState.records.some(record => record.desired.launch?.instanceGuids.length > 0));
    assert.equal((await call(oldNode, rollbackRoot, 'uninstall', oldRoot, oldRoot)).disposition, 'ready');
    // A separate same-root dependency transaction starts with an actual049
    // daemon under Node24, then uses actual26 and restores actual24. It must
    // capture this baseline rather than the earlier044 transition's before.
    await cp(newRoot, finalRoot, { recursive: true });
    assert.equal((await call(oldNode, finalRoot, 'install', finalRoot, finalRoot)).disposition, 'ready');
    const node24Lock = await readDaemonOwnershipPacket(path.join(config.paths.locks, 'daemon.lock'));
    assert.equal(node24Lock.value.processIdentity.executable_path.toLowerCase(), oldNode.toLowerCase());
    assert.equal((await call(oldNode, finalRoot, 'pre_replace', finalRoot, finalRoot)).disposition, 'ready');
    assert.equal((await call(process.execPath, finalRoot, 'post_replace', finalRoot, finalRoot)).disposition, 'ready');
    const node26Lock = await readDaemonOwnershipPacket(path.join(config.paths.locks, 'daemon.lock'));
    assert.equal(node26Lock.value.processIdentity.executable_path.toLowerCase(), process.execPath.toLowerCase());
    assert.equal((await call(process.execPath, finalRoot, 'pre_replace', finalRoot, finalRoot)).disposition, 'ready');
    assert.equal((await call(oldNode, finalRoot, 'post_replace', finalRoot, finalRoot)).disposition, 'ready');
    const inverseLock = await readDaemonOwnershipPacket(path.join(config.paths.locks, 'daemon.lock'));
    assert.equal(inverseLock.value.processIdentity.executable_path.toLowerCase(), oldNode.toLowerCase());
    assert.equal((await call(oldNode, finalRoot, 'uninstall', finalRoot, finalRoot)).disposition, 'ready'); complete = true;
  } finally {
    const result = await scheduler.perform({ operation: 'inspect', task_path: taskPath }); assert.equal(result.outcome, 'completed');
    let task = result.observation;
    if (task.registered) {
      const obstacle = config ? await observeDaemonDrainObstacle(config) : null;
      task = (await scheduler.perform({ operation: 'set_enabled', task_path: taskPath, expected_definition_xml: task.definition_xml,
        expected_xml_sha256: task.definition_sha256, enabled: false })).observation;
      if (task.instance_guids.length) {
        const stop = await scheduler.perform({ operation: 'stop_instances', task_path: taskPath,
          expected_definition_xml: task.definition_xml, expected_xml_sha256: task.definition_sha256, instance_guids: task.instance_guids });
        assert.equal(stop.outcome, 'completed'); task = stop.observation;
      }
      if (obstacle?.state === 'present') {
        let current = probeProcessInstance(obstacle.currentIncarnation.pid);
        const limit = performance.now() + 5000;
        while (current.state === 'present' && sameProcessInstance(current.identity, obstacle.currentIncarnation) && performance.now() < limit) {
          await delay(50); current = probeProcessInstance(obstacle.currentIncarnation.pid);
        }
        assert.ok(current.state === 'absent' || (current.state === 'present' && !sameProcessInstance(current.identity, obstacle.currentIncarnation)),
          `Owned legacy child not joined; fixture retained at ${fixture}`);
      }
      const deleted = await scheduler.perform({ operation: 'delete', task_path: taskPath,
        expected_definition_xml: task.definition_xml, expected_xml_sha256: task.definition_sha256 }); assert.equal(deleted.outcome, 'completed');
    }
    if (complete) {
      const resolved = await realpath(fixture); const stat = await lstat(fixture);
      assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('book-v3-legacy-'));
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink()); await rm(resolved, { recursive: true });
    }
  }
});
