import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig, packageRoot } from '../src/config.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'book-forge-config-contract-'));
  const workspace = path.join(root, 'workspace');
  const secretDirectory = path.join(root, 'operator-secrets');
  await mkdir(workspace, { recursive: true });
  await mkdir(secretDirectory, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    workspace,
    tokenFile: path.join(secretDirectory, 'lichess-token.txt'),
  };
}

function mergeOverride(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeOverride(base[key] ?? {}, value)
      : value;
  }
  return result;
}

async function writeConfig(context, name, override = {}) {
  const filename = path.join(context.root, `${name}.json`);
  const value = mergeOverride({
    schema: 'uci_arena_book_forge_config_v1',
    acquisition: { tokenFile: context.tokenFile },
  }, override);
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return filename;
}

test('configuration accepts only declared root and nested fields', async (t) => {
  const context = await fixture(t);
  const unknownRoot = await writeConfig(context, 'unknown-root', { surprise: true });
  await assert.rejects(
    loadConfig({ configFile: unknownRoot, workspace: context.workspace }),
    /Unknown Book Forge configuration field: configuration\.surprise/,
  );

  const unknownNested = await writeConfig(context, 'unknown-nested', {
    analysis: { extraWorkerMode: true },
  });
  await assert.rejects(
    loadConfig({ configFile: unknownNested, workspace: context.workspace }),
    /Unknown Book Forge configuration field: configuration\.analysis\.extraWorkerMode/,
  );
});

test('bounded operational values and cross-field rules fail closed', async (t) => {
  const context = await fixture(t);
  const cases = [
    ['channel-type', { channels: { integration: 'yes' } }, /channels\.integration must be boolean/],
    ['duplicate-speed', { ingestion: { speeds: ['rapid', 'rapid'] } }, /ingestion\.speeds must be a unique/],
    ['chunk-upper-bound', { ingestion: { chunkGames: 1_000_001 } }, /ingestion\.chunkGames/],
    ['initial-nodes-lower-bound', { analysis: { initialNodes: 0 } }, /analysis\.initialNodes/],
    [
      'confirmation-order',
      { analysis: { initialNodes: 100, confirmationNodes: 99 } },
      /confirmationNodes must not be less/,
    ],
    [
      'worker-order',
      { analysis: { maximumWorkers: 1, backgroundSipWorkers: 2 } },
      /backgroundSipWorkers must not exceed/,
    ],
    ['crawl-gap-positive', { acquisition: { crawlLcbGap: 0 } }, /crawlLcbGap must be a finite number greater than 0/],
    ['request-timeout-lower-bound', { acquisition: { requestTimeoutMs: 999 } }, /requestTimeoutMs/],
    ['request-timeout-upper-bound', { acquisition: { requestTimeoutMs: 300_001 } }, /requestTimeoutMs/],
    [
      'cpu-mode-order',
      { resources: { courtesyCpuPercent: 80, idleCpuPercent: 79 } },
      /idleCpuPercent must not be less/,
    ],
    [
      'process-name-identity',
      { resources: { priorityProcessNames: ['engine', 'ENGINE'] } },
      /unique executable basenames/,
    ],
    [
      'retention-lower-bound',
      { maintenance: { snapshotVersionsPerChannel: 0 } },
      /snapshotVersionsPerChannel/,
    ],
    [
      'backoff-order',
      { daemon: { failureBackoffInitialMs: 5_000, failureBackoffMaximumMs: 4_000 } },
      /failureBackoffMaximumMs must not be less/,
    ],
    ['reserved-pgn-audit', { pgnAudit: { enabled: true } }, /PGN audit is reserved but unavailable/],
  ];

  for (const [name, override, expected] of cases) {
    await t.test(name, async () => {
      const filename = await writeConfig(context, name, override);
      await assert.rejects(
        loadConfig({ configFile: filename, workspace: context.workspace }),
        expected,
      );
    });
  }
});

test('migrated schema and relative paths normalize to the canonical contract', async (t) => {
  const context = await fixture(t);
  const filename = path.join(context.root, 'migrated.json');
  await writeFile(filename, `${JSON.stringify({
    schema: 'previous_product_book_forge_config_v1',
    policyFile: 'policy/custom.policy',
    stockfish: 'bin/stockfish',
    acquisition: { tokenFile: 'operator-secrets/lichess-token.txt' },
  }, null, 2)}\n`, 'utf8');

  const config = await loadConfig({ configFile: filename, workspace: context.workspace });

  assert.equal(config.schema, 'uci_arena_book_forge_config_v1');
  assert.equal(config.policyFile, path.join(context.root, 'policy', 'custom.policy'));
  assert.equal(config.stockfish, path.join(context.root, 'bin', 'stockfish'));
  assert.equal(config.acquisition.tokenFile, context.tokenFile);
  assert.deepEqual(config.resources.priorityProcessNames.slice(0, 1), [
    'uci_arena_engine.exe',
  ]);
});

test('credential path remains outside package, suite, and workspace ownership', async (t) => {
  const context = await fixture(t);
  const packageCredential = await writeConfig(context, 'package-credential', {
    acquisition: { tokenFile: path.join(packageRoot, 'secrets', 'token.txt') },
  });
  await assert.rejects(
    loadConfig({ configFile: packageCredential, workspace: context.workspace }),
    /tokenFile must be operator-owned and outside/,
  );

  const workspaceCredential = await writeConfig(context, 'workspace-credential', {
    acquisition: { tokenFile: path.join(context.workspace, 'secrets', 'token.txt') },
  });
  await assert.rejects(
    loadConfig({ configFile: workspaceCredential, workspace: context.workspace }),
    /tokenFile must be operator-owned and outside the Book Forge workspace/,
  );
});

test('physical credential ownership rejects a lexical escape through a symlink', async (t) => {
  if (process.platform === 'win32') {
    t.skip('ordinary Windows test accounts may not have symlink creation rights');
    return;
  }
  const context = await fixture(t);
  const alias = path.join(context.root, 'apparently-external');
  await symlink(context.workspace, alias, 'dir');
  const filename = await writeConfig(context, 'symlink-credential', {
    acquisition: { tokenFile: path.join(alias, 'token.txt') },
  });

  await assert.rejects(
    loadConfig({ configFile: filename, workspace: context.workspace }),
    /tokenFile must be operator-owned and outside the Book Forge workspace/,
  );
});

test('disabled optional capabilities may omit their private runtime paths', async (t) => {
  const context = await fixture(t);
  const filename = await writeConfig(context, 'disabled-capabilities', {
    stockfish: '',
    analysis: { enabled: false },
    acquisition: { enabled: false, tokenFile: '' },
  });

  const config = await loadConfig({ configFile: filename, workspace: context.workspace });

  assert.equal(config.analysis.enabled, false);
  assert.equal(config.stockfish, '');
  assert.equal(config.stockfishAvailable, false);
  assert.equal(config.acquisition.enabled, false);
  assert.equal(config.acquisition.tokenFile, '');
});
