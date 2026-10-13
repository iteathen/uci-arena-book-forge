import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { renderInstallerConfiguration } from '../src/installer_integration.mjs';

test('installer integration renders only provider-owned Book Forge configuration', () => {
  const root = path.resolve('C:/suite fixture');
  const token = path.join(root, 'operator', 'missing-token.txt');
  const result = renderInstallerConfiguration({
    schema: 'arena_provider_install_context_v1',
    schema_version: 1,
    component: { id: 'book_forge.service', version: '0.4.3', root },
    workspace: path.join(root, 'state', 'book-forge'),
    enabled: true,
    bindings: { stockfish: path.join(root, 'components', 'stockfish.exe') },
    locators: { lichess_token_path: token },
  });

  assert.equal(result.schema, 'arena_provider_install_result_v1');
  assert.deepEqual(result.generated_documents, []);
  assert.equal(result.configuration.workspace, path.join(root, 'state', 'book-forge'));
  assert.equal(result.configuration.stockfish, path.join(root, 'components', 'stockfish.exe'));
  assert.equal(result.configuration.acquisition.tokenFile, token);
});

test('installer integration rejects relative dependency and locator paths', () => {
  const context = {
    schema: 'arena_provider_install_context_v1',
    schema_version: 1,
    workspace: path.resolve('workspace'),
    enabled: true,
    bindings: { stockfish: 'stockfish.exe' },
    locators: {},
  };
  assert.throws(() => renderInstallerConfiguration(context), /absolute path/u);
  context.bindings.stockfish = path.resolve('stockfish.exe');
  context.locators.lichess_token_path = 'token.txt';
  assert.throws(() => renderInstallerConfiguration(context), /absolute path/u);
});

function retainedContext(t, settings) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'book-forge-settings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');mkdirSync(workspace);
  writeFileSync(path.join(workspace, 'manager-config.json'), JSON.stringify({
    schema: 'uci_arena_book_forge_config_v1', workspace: path.join(root, 'old-workspace'),
    stockfish: path.join(root, 'old-stockfish'),
    nativeHelper: path.join(root, 'unselected-helper'),
    acquisition: { tokenFile: path.join(root, 'old-token-reference') }, ...settings,
  }));
  return { schema: 'arena_provider_install_context_v1', schema_version: 1, workspace,
    enabled: true, bindings: { stockfish: path.join(root, 'selected-stockfish') },
    locators: { lichess_token_path: path.join(root, 'selected-token-reference') } };
}

test('refresh preserves validated resource reserve and one-worker policy while replacing execution and credential bindings', t => {
  const resources = { minimumFreeWorkspaceGb: 25, courtesyCpuPercent: 15 };
  const analysis = { maximumWorkers: 1, backgroundSipWorkers: 1, hashMbPerWorker: 64 };
  const context = retainedContext(t, { resources, analysis });
  const { configuration } = renderInstallerConfiguration(context);
  assert.deepEqual(configuration.resources, resources);
  assert.deepEqual(configuration.analysis, analysis);
  assert.equal(configuration.workspace, context.workspace);
  assert.equal(configuration.stockfish, context.bindings.stockfish);
  assert.equal(configuration.acquisition.tokenFile, context.locators.lichess_token_path);
  assert.equal(Object.hasOwn(configuration, 'nativeHelper'), false);
});

for (const [label, settings] of [
  ['negative reserve', { resources: { minimumFreeWorkspaceGb: -1 } }],
  ['too many sip workers', { analysis: { maximumWorkers: 1, backgroundSipWorkers: 2 } }],
  ['unknown settings', { resources: { undocumentedBudget: 1 } }],
]) {
  test(`refresh rejects retained ${label} rather than discarding operator policy`, t => {
    const context = retainedContext(t, settings);
    assert.throws(() => renderInstallerConfiguration(context), /configuration|Unknown/u);
  });
}

test('a zero free-space reserve remains an explicit validated operator value', t => {
  const context = retainedContext(t, { resources: { minimumFreeWorkspaceGb: 0 } });
  assert.equal(renderInstallerConfiguration(context).configuration.resources.minimumFreeWorkspaceGb, 0);
});

test('retained oversized configuration is rejected before its bytes are read', t => {
  const context = retainedContext(t, {});
  writeFileSync(path.join(context.workspace, 'manager-config.json'), ' '.repeat(1024 * 1024 + 1));
  assert.throws(() => renderInstallerConfiguration(context), /bounded|large/u);
});

test('a retained configuration reached through a directory link is rejected', t => {
  const context = retainedContext(t, { resources: { minimumFreeWorkspaceGb: 25 } });
  const link = path.join(path.dirname(context.workspace), 'linked-workspace');
  try { symlinkSync(context.workspace, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
    t.skip(`directory-link capability unavailable: ${error.code}`);return;
  }
  context.workspace = link;
  assert.throws(() => renderInstallerConfiguration(context), /linked/u);
});
