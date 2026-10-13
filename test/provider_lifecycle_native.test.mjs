import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, packageRoot } from '../src/config.mjs';
import { configureProcessIdentity, probeProcessInstance, sameProcessInstance, validProcessIdentity } from '../src/process_identity.mjs';
import { readDaemonOwnershipPacket } from '../src/daemon.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { BookLifecycleStore } from '../src/provider_state.mjs';
import { WindowsBookLifecyclePlatform } from '../src/windows_provider_lifecycle.mjs';
import { convergeBookLifecycle } from '../src/provider_lifecycle.mjs';
import { currentUserSid } from '../src/windows_startup.mjs';
import { WindowsTaskScheduler } from '@uci-arena/background-service-runtime/windows-task-scheduler';
import { Catalog } from '../src/catalog.mjs';
import packageDocument from '../package.json' with { type: 'json' };

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
test('owned Windows Book task: canonical catalog-only relocation, actual daemon ready and normal joined lifecycle', {
  skip: process.platform !== 'win32', timeout: 120000,
}, async () => {
  const parent = await realpath(os.tmpdir());
  const fixture = await realpath(await mkdtemp(path.join(parent, 'book-v3-task-')));
  const root = path.join(fixture, 'component'); const destination = path.join(root, 'services/book-forge');
  const sourceWorkspace = path.join(fixture, 'retained-source');
  const sourceBackup = path.join(fixture, 'retained-source-backup');
  const selectedRelocationParent = process.env.BOOK_FORGE_NATIVE_RELOCATION_ROOT ?? parent;
  assert.equal(path.isAbsolute(selectedRelocationParent), true);
  const relocationParent = await realpath(selectedRelocationParent);
  const eParent = await realpath(await mkdtemp(path.join(relocationParent, 'book-v3-restored-')));
  const crossVolumeRelocation = (await stat(parent)).dev !== (await stat(relocationParent)).dev;
  if (process.env.BOOK_FORGE_NATIVE_REQUIRE_CROSS_VOLUME === '1') assert.equal(crossVolumeRelocation, true);
  const workspace = path.join(eParent, 'workspace');
  const taskPath = `\\UCI Arena Book Forge Test ${randomUUID()}`;
  const scheduler = new WindowsTaskScheduler();
  let ownedConfig = null, runRequested = false;
  const perform = scheduler.perform.bind(scheduler);
  scheduler.perform = async (...args) => {
    if (args[0].operation === 'run') runRequested = true;
    const result = await perform(...args);
    if (result.outcome !== 'completed') console.error(`owned fixture SDK ${args[0].operation}: ${JSON.stringify(result.failure)}`);
    return result;
  };
  let safelyClosed = false;
  try {
    await mkdir(destination, { recursive: true });
    for (const name of ['src', 'node_modules', 'policy', 'package.json', 'package-lock.json', 'native']) {
      await cp(path.join(packageRoot, name), path.join(destination, name), { recursive: true, errorOnExist: true });
    }
    const files = [];
    async function inventory(directory, relative = '') {
      for (const name of await readdir(directory)) {
        const absolute = path.join(directory, name); const selected = relative ? `${relative}/${name}` : name;
        const stat = await lstat(absolute);
        assert.equal(stat.isSymbolicLink(), false);
        if (stat.isDirectory()) await inventory(absolute, selected);
        else { assert.equal(stat.isFile(), true); const bytes = await readFile(absolute);
          files.push({ path: selected, size_bytes: bytes.length, sha256: sha(bytes) }); }
      }
    }
    await inventory(root); files.sort((a, b) => a.path.localeCompare(b.path));
    await writeFile(path.join(root, 'arena-component.json'), JSON.stringify({
      schema: 'arena_install_component_v1', schema_version: 1, component_id: 'book_forge.service', component_version: packageDocument.version,
      target_triple: 'windows-x86_64', entrypoints: { cli: 'services/book-forge/src/cli.mjs',
        startup_launcher: 'services/book-forge/native/bin/uci_arena_service_launcher.exe',
        process_identity_helper: 'services/book-forge/native/bin/uci_arena_background_guard.exe' }, files,
    }));
    await mkdir(sourceWorkspace);await mkdir(workspace);
    const retained = new Catalog(await loadConfig({workspace:sourceWorkspace}));
    const stamp='2026-10-01T00:00:00.000Z';
    retained.setMetadata('historical_fixture','preserved opaque history');
    retained.updateDaemonState({pid:2147483600,phase:'sleep',process_identity:'',started_at:stamp,heartbeat_at:stamp});
    // Exact historical schema4 shape before ordinary producer migration.
    retained.database.exec('ALTER TABLE daemon_state DROP COLUMN process_identity');
    retained.setMetadata('schema_version','4');retained.close();
    const sourceBytes=await readFile(path.join(sourceWorkspace,'catalog.sqlite'));
    await cp(path.join(sourceWorkspace,'catalog.sqlite'),path.join(workspace,'catalog.sqlite'));
    await rename(sourceWorkspace,sourceBackup);
    // No lock/heartbeat/runtime authority is copied into the fresh E workspace.
    const migrated = new Catalog(await loadConfig({workspace}));migrated.close();
    const configFile = path.join(workspace, 'config.json');
    await writeFile(configFile, JSON.stringify({ schema: 'uci_arena_book_forge_config_v1', workspace,
      acquisition: { enabled: false }, analysis: { enabled: false },
      resources: { minimumFreeWorkspaceGb: 100000 },
      nativeHelper: path.join(destination, 'native/bin/uci_arena_background_guard.exe'),
      nativeLauncher: path.join(destination, 'native/bin/uci_arena_service_launcher.exe') }));
    const config = await loadConfig({ configFile, workspace });
    ownedConfig = config;
    assert.equal(await configureProcessIdentity(config), true);
    const sid = await currentUserSid(); const store = new BookLifecycleStore(workspace);
    const call = operation => {
      const platform = new WindowsBookLifecyclePlatform(config, { roots: [root], taskPath, scheduler, userSid: sid });
      for (const method of ['begin', 'desired', 'inspect', 'capture', 'quiesce', 'apply', 'activate', 'remove']) {
        const original = platform[method].bind(platform);
        platform[method] = async (...args) => {
          try {
            const result = await original(...args);
            if (method === 'inspect') console.error(`owned fixture ${operation}/observation: ${JSON.stringify({ binding: result.binding,
              enabled: result.enabled, active: result.active, orphan: result.orphan, instances: result.task.instance_guids.length })}`);
            return result;
          }
          catch (error) { console.error(`owned fixture ${operation}/${method}: ${error.stack}`); throw error; }
        };
      }
      return convergeBookLifecycle({ operation, previousRoot: root, replacementRoot: root }, { platform, store, version: packageDocument.version });
    };
    const installed = await call('install'); assert.equal(installed.disposition, 'ready', JSON.stringify(installed));
    assert.equal(installed.observed.activity, 'active');
    assert.equal((await call('install')).disposition, 'ready');
    assert.equal((await call('pre_replace')).disposition, 'ready');
    assert.equal((await call('pre_replace')).disposition, 'ready');
    assert.equal((await call('post_replace')).disposition, 'ready');
    assert.equal((await call('post_replace')).disposition, 'ready');
    assert.equal((await call('uninstall')).disposition, 'ready');
    assert.deepEqual(await readFile(path.join(sourceBackup,'catalog.sqlite')),sourceBytes);
    const finalCatalog=new Catalog(config);
    try{assert.equal(finalCatalog.metadata('historical_fixture'),'preserved opaque history');}finally{finalCatalog.close();}
    await writeFile(path.join(eParent,'observation.json'),JSON.stringify({schema:'book_restored_native_lifecycle_fixture_v1',
      version:packageDocument.version,sourceBackup,workspace,sourceCatalogSha256:sha(sourceBytes),originalBytesPreserved:true,
      catalogOnlyCopy:true,locksHeartbeatStartupAuthorityCopied:false,legacyPid:2147483600,
      nativeInstallReady:true,repeatedForwardInverse:true,normalUninstallReady:true,ownedTaskPath:taskPath,
      crossVolumeRelocation,sourceParent:parent,relocationParent,
      fixtureDisposition:'Relocated workspace/receipt retained; source component/fixture removed only after exact owned task/child closure'},null,2));
    assert.equal((await call('uninstall')).disposition, 'ready');
    safelyClosed = true;
  } finally {
    const packet = ownedConfig ? await readDaemonOwnershipPacket(path.join(ownedConfig.paths.locks, 'daemon.lock')) : null;
    const originalChild = validProcessIdentity(packet?.value?.processIdentity) ? packet.value.processIdentity : null;
    const result = await scheduler.perform({ operation: 'inspect', task_path: taskPath });
    if (result.outcome === 'completed') {
      let observed = result.observation;
      if (observed.registered) {
        if (!safelyClosed) await writeFile(path.join(fixture, 'registered-task.xml'), observed.definition_xml);
        const disable = await scheduler.perform({ operation: 'set_enabled', task_path: taskPath,
          expected_definition_xml: observed.definition_xml, expected_xml_sha256: observed.definition_sha256, enabled: false });
        assert.equal(disable.outcome, 'completed'); observed = disable.observation;
        if (observed.instance_guids.length) {
          const stop = await scheduler.perform({ operation: 'stop_instances', task_path: taskPath,
            expected_definition_xml: observed.definition_xml, expected_xml_sha256: observed.definition_sha256,
            instance_guids: observed.instance_guids });
          assert.equal(stop.outcome, 'completed'); observed = stop.observation;
        }
        if (runRequested) {
          if (!originalChild) assert.fail(`Owned child origin unproven; task and fixture retained at ${fixture}`);
          const limit = performance.now() + 10000;
          let gone = false;
          do {
            const current = probeProcessInstance(originalChild.pid);
            gone = current.state === 'absent' || (current.state === 'present' &&
              validProcessIdentity(current.identity) && !sameProcessInstance(current.identity, originalChild));
            if (!gone) await delay(100);
          } while (!gone && performance.now() < limit);
          assert.ok(gone, `Owned child not joined; task and fixture retained at ${fixture}`);
        }
        const deleted = await scheduler.perform({ operation: 'delete', task_path: taskPath,
          expected_definition_xml: observed.definition_xml, expected_xml_sha256: observed.definition_sha256 });
        assert.equal(deleted.outcome, 'completed');
      }
    } else assert.fail('Owned fixture task inspection failed; fixture retained');
    // Retain failed source/records for diagnosis. Only a fully joined successful
    // fixture is removed; never erase evidence while a child may remain live.
    if (safelyClosed) {
      const resolved = await realpath(fixture); const stat = await lstat(fixture);
      assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('book-v3-task-'));
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink()); await rm(resolved, { recursive: true });
    }
  }
});
