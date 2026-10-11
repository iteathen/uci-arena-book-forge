import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, realpath, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { admitBookComponentRoot } from '../src/provider_root.mjs';
import { WindowsBookLifecyclePlatform } from '../src/windows_provider_lifecycle.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// These data-only fixture manifests deliberately select Windows inventory
// semantics on every test host; physical file guards still use the actual OS.
const admitWindowsRoot = input => admitBookComponentRoot(input, { platform: 'win32' });
async function fixture(t, version = '0.4.9') {
  const parent = await realpath(os.tmpdir());
  const root = await realpath(await mkdtemp(path.join(parent, 'book-component-root-')));
  t.after(async () => {
    let resolved;
    try { resolved = await realpath(root); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const status = await lstat(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('book-component-root-'));
    assert.ok(status.isDirectory() && !status.isSymbolicLink());
    await rm(resolved, { recursive: true });
  });
  const payload = {
    'services/book-forge/src/cli.mjs': Buffer.from('// owned synthetic CLI\n'),
    'services/book-forge/package.json': Buffer.from(JSON.stringify({ name: '@uci-arena/book-forge', version })),
    'services/book-forge/native/bin/uci_arena_service_launcher.exe': Buffer.from('synthetic launcher'),
    'services/book-forge/native/bin/uci_arena_background_guard.exe': Buffer.from('synthetic helper'),
    'services/book-forge/src/dependency.mjs': Buffer.from('// exact transitive closure\n'),
  };
  for (const [name, bytes] of Object.entries(payload)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), bytes);
  }
  const manifest = { schema: 'arena_install_component_v1', schema_version: 1,
    component_id: 'book_forge.service', component_version: version, target_triple: 'windows-x86_64',
    entrypoints: { cli: 'services/book-forge/src/cli.mjs',
      startup_launcher: 'services/book-forge/native/bin/uci_arena_service_launcher.exe',
      process_identity_helper: 'services/book-forge/native/bin/uci_arena_background_guard.exe' },
    files: Object.entries(payload).map(([name, bytes]) => ({ path: name, sha256: sha(bytes), size_bytes: bytes.length })) };
  const save = () => writeFile(path.join(root, 'arena-component.json'), JSON.stringify(manifest));
  await save();
  return { root, manifest, save };
}

test('exact public component root admits declared roles and entire inventoried closure', async t => {
  const f = await fixture(t);
  const descriptor = await admitWindowsRoot(f.root);
  assert.equal(descriptor.root, f.root);
  assert.equal(descriptor.componentVersion, '0.4.9');
  assert.equal(descriptor.cli, path.join(f.root, f.manifest.entrypoints.cli));
  assert.equal(descriptor.launcher, path.join(f.root, f.manifest.entrypoints.startup_launcher));
  assert.equal(descriptor.componentManifestSha256, sha(await readFile(path.join(f.root, 'arena-component.json'))));
  assert.equal(Object.isFrozen(descriptor), true);
  await assert.rejects(admitBookComponentRoot(f.root, { platform: 'linux' }), /component root admission failed/);
});

test('physically retired completed source is optional history, but requested restoration requires exact payload', async t => {
  const old = await fixture(t); const current = await fixture(t);
  const oldDescriptor = await admitWindowsRoot(old.root);
  const parent = await realpath(os.tmpdir()); const resolved = await realpath(old.root); const stat = await lstat(old.root);
  assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('book-component-root-'));
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink()); await rm(resolved, { recursive: true });
  const calls = [];
  const platform = new WindowsBookLifecyclePlatform({ workspace: 'C:\\fixture-workspace' }, {
    roots: [current.root], candidateRoots: [old.root], admitRoot: admitWindowsRoot, executableIdentity: async () => 'f'.repeat(64),
    scheduler: { perform: async request => { calls.push(request); return { outcome: 'completed', observation: {
      registered: false, principal: null, instance_guids: [] } }; } }, userSid: 'S-1-5-21-123',
  });
  await platform.begin([{ before: { root: oldDescriptor.root }, desired: { root: oldDescriptor.root }, postDone: true }]);
  assert.equal((await platform.desired({ replacementRoot: current.root })).root, current.root);
  await assert.rejects(platform.desired({ replacementRoot: old.root }));
  assert.equal(calls.every(request => request.operation === 'inspect'), true);
});

test('transitive substitution and absent inventory role reject before task control', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'services/book-forge/src/dependency.mjs'), '// changed closure');
  await assert.rejects(admitWindowsRoot(f.root), /component root admission failed/);
  const second = await fixture(t);
  second.manifest.files = second.manifest.files.filter(row => row.path !== second.manifest.entrypoints.startup_launcher);
  await second.save();
  await assert.rejects(admitWindowsRoot(second.root), /component root admission failed/);
});

test('foreign component, unsupported version, traversal and Windows aliases reject', async t => {
  for (const mutate of [
    manifest => { manifest.component_id = 'foreign.service'; },
    manifest => { manifest.component_version = '9.0.0'; },
    manifest => { manifest.entrypoints.cli = '../other/cli.mjs'; },
    manifest => { manifest.files.push({ ...manifest.files[0], path: manifest.files[0].path.toUpperCase() }); },
  ]) {
    const f = await fixture(t); mutate(f.manifest); await f.save();
    await assert.rejects(admitWindowsRoot(f.root), /component root admission failed/);
  }
});

test('legacy044 layout is an explicit inventoried compatibility profile', async t => {
  const f = await fixture(t, '0.4.4');
  delete f.manifest.entrypoints.startup_launcher;
  delete f.manifest.entrypoints.process_identity_helper;
  await f.save();
  const descriptor = await admitWindowsRoot(f.root);
  assert.equal(descriptor.ownershipProfile, 'book_forge_public_layout_044');
  assert.equal(descriptor.launcher, path.join(f.root, 'services/book-forge/native/bin/uci_arena_service_launcher.exe'));
  const current = await fixture(t);
  delete current.manifest.entrypoints.startup_launcher;
  await current.save();
  await assert.rejects(admitWindowsRoot(current.root), /component root admission failed/);
});
