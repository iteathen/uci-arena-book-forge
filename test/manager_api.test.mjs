import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { Catalog } from '../src/catalog.mjs';
import { loadConfig } from '../src/config.mjs';
import {
  describeApi,
  inspectOutputApi,
  listOutputsApi,
  statusApi,
  validateConfigApi,
} from '../src/manager_api.mjs';
import { validatedManagerIntegrationApi } from '../tools/release/component_release.mjs';

const execFileAsync = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'book-forge-manager-api-'));
  const config = await loadConfig({ workspace: root });
  const catalog = new Catalog(config);
  t.after(async () => {
    catalog.close();
    await rm(root, { recursive: true, force: true });
  });
  return { catalog, config };
}

test('Manager API describes a stable one-way JSON contract', async (t) => {
  const { catalog, config } = await fixture(t);
  const description = describeApi();
  assert.equal(description.schema, 'uci_arena_manager_service_api_v1');
  assert.equal(description.api_version, '1.0');
  assert.equal(description.component_id, 'book_forge.service');
  assert.deepEqual(description.payload.invocation, ['api']);
  assert.ok(description.payload.operations.includes('outputs_list'));
  assert.equal(statusApi(catalog).payload.status.schema, 'uci_arena_book_forge_status_v2');
  assert.equal(validateConfigApi(config).payload.valid, true);
  assert.equal(Object.hasOwn(validateConfigApi(config).payload, 'token_file'), false);
});

test('Manager API empty output cursor is stable and rejects malformed requests', async (t) => {
  const { catalog, config } = await fixture(t);
  const first = await listOutputsApi(catalog, config);
  assert.match(first.payload.cursor, /^[0-9a-f]{64}$/u);
  assert.deepEqual(first.payload.outputs, []);
  const unchanged = await listOutputsApi(catalog, config, first.payload.cursor);
  assert.equal(unchanged.payload.unchanged, true);
  await assert.rejects(
    listOutputsApi(catalog, config, 'not-a-cursor'),
    /cursor is malformed/,
  );
  await assert.rejects(
    inspectOutputApi(catalog, config, '../catalog.sqlite'),
    /output id is malformed/,
  );
});

test('Manager API rejects a catalog output path outside the snapshot root', async (t) => {
  const { catalog, config } = await fixture(t);
  catalog.addSnapshot({
    id: 'integration-0123456789abcdefabcd',
    channel: 'integration',
    directory: path.dirname(config.paths.snapshots),
    recordCount: 1,
    includesFixture: true,
    qualified: false,
    manifestSha256: '0'.repeat(64),
  });
  await assert.rejects(
    listOutputsApi(catalog, config),
    /escapes the declared snapshot root/,
  );
});

test('provider definition advertises the same Manager API contract', async () => {
  const definition = JSON.parse(
    await import('node:fs/promises').then(({ readFile }) => readFile(
      new URL('../release/components/book-forge.json', import.meta.url),
      'utf8',
    )),
  );
  const serviceContract = JSON.parse(
    await import('node:fs/promises').then(({ readFile }) => readFile(
      new URL('../contracts/service-contract.json', import.meta.url),
      'utf8',
    )),
  );
  assert.deepEqual(
    definition.manager_integration_api,
    serviceContract.manager_integration_api,
  );
  assert.equal(definition.manager_integration_api.entrypoint, 'cli');
  assert.deepEqual(
    validatedManagerIntegrationApi(
      definition.manager_integration_api,
      definition.entrypoints,
    ),
    serviceContract.manager_integration_api,
  );
});

test('installed CLI API works from an unrelated working directory', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'book-forge-manager-cli-'));
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'book-forge-manager-cwd-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(cwd, { recursive: true, force: true }),
  ]));
  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve('src/cli.mjs'),
    'api',
    'describe',
    '--workspace',
    root,
  ], { cwd });
  const response = JSON.parse(stdout);
  assert.equal(response.schema, 'uci_arena_manager_service_api_v1');
  assert.equal(response.operation, 'describe');
  assert.equal(response.ok, true);
});
