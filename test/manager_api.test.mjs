import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { Catalog } from '../src/catalog.mjs';
import { buildSnapshot } from '../src/compiler.mjs';
import { loadConfig } from '../src/config.mjs';
import { ingestSource, registerInput } from '../src/ingest.mjs';
import {
  apiError,
  describeApi,
  inspectOutputApi,
  listOutputsApi,
  statusApi,
  validateConfigApi,
} from '../src/manager_api.mjs';
import { validatedManagerIntegrationApi } from '../tools/release/component_release.mjs';
import { publishSnapshot } from '../src/publisher.mjs';

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
  const status = await statusApi(catalog, config, async () => ({
    platform: 'windows', installed: true, enabled: true,
    matchesCurrentConfiguration: true,
  }));
  assert.equal(status.payload.status.schema, 'uci_arena_book_forge_status_v2');
  assert.equal(status.payload.status.daemon.active, false);
  assert.deepEqual(status.payload.status.startup, {
    platform: 'windows', inspection: 'available', inspectionReason: '', registered: true, enabled: true,
    serviceManagerActive: null, daemonActive: false, matchesCurrentConfiguration: true,
  });
  const statusSchema = JSON.parse(await readFile(new URL('../contracts/status-schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(status.payload.status).sort(), [...statusSchema.required].sort());
  assert.deepEqual(Object.keys(status.payload.status.startup).sort(),
    [...statusSchema.properties.startup.required].sort());
  assert.equal(validateConfigApi(config).payload.valid, true);
  assert.equal(Object.hasOwn(validateConfigApi(config).payload, 'token_file'), false);
  assert.deepEqual(description.payload.schema_documents, {
    configuration: 'contracts/configuration-schema.json',
    status: 'contracts/status-schema.json',
    output: 'contracts/output-schema.json',
  });
});

test('Manager API errors are bounded, single-line, and redact authorization values', () => {
  const response = apiError('status', new Error(`failed\nAuthorization: Bearer ${'s'.repeat(800)}`));
  assert.equal(response.ok, false);
  assert.ok(response.error.message.length <= 512);
  assert.doesNotMatch(response.error.message, /\n/u);
  assert.doesNotMatch(response.error.message, /s{20}/u);
  assert.match(response.error.message, /Bearer <redacted>/u);
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
  catalog.setChannel(
    'integration',
    'integration-0123456789abcdefabcd',
    path.dirname(config.paths.snapshots),
  );
  await assert.rejects(
    listOutputsApi(catalog, config),
    /escapes the declared snapshot root/,
  );
});

test('Manager API rejects a snapshot-root junction that resolves outside provider ownership', async (t) => {
  const { catalog, config } = await fixture(t);
  const outside = path.join(config.workspace, 'external-output');
  const linked = path.join(config.paths.snapshots, 'integration-0123456789abcdefabcd');
  await mkdir(outside, { recursive: true });
  await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  catalog.addSnapshot({
    id: 'integration-0123456789abcdefabcd', channel: 'integration', directory: linked,
    recordCount: 1, includesFixture: true, qualified: false, manifestSha256: '0'.repeat(64),
  });
  catalog.setChannel('integration', 'integration-0123456789abcdefabcd', linked);
  await assert.rejects(listOutputsApi(catalog, config), /escapes the declared snapshot root/u);
});

test('Manager API discovery never traverses retained historical snapshots', async (t) => {
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

  const listed = await listOutputsApi(catalog, config);

  assert.deepEqual(listed.payload.outputs, []);
  await assert.rejects(
    inspectOutputApi(catalog, config, 'integration-0123456789abcdefabcd'),
    /escapes the declared snapshot root/,
  );
});

test('Manager API accepts an unchanged cursor without reopening snapshot files', async (t) => {
  const { catalog, config } = await fixture(t);
  const snapshot = {
    id: 'integration-0123456789abcdefabcd',
    channel: 'integration',
    directory: path.dirname(config.paths.snapshots),
    recordCount: 1,
    includesFixture: true,
    qualified: false,
    manifestSha256: '0'.repeat(64),
  };
  catalog.addSnapshot(snapshot);
  catalog.setChannel(snapshot.channel, snapshot.id, snapshot.directory);
  const cursor = createHash('sha256').update(JSON.stringify([{
    output_id: snapshot.id,
    manifest_sha256: snapshot.manifestSha256,
    current: true,
  }])).digest('hex');

  const unchanged = await listOutputsApi(catalog, config, cursor);

  assert.equal(unchanged.payload.unchanged, true);
  assert.equal(unchanged.payload.cursor, cursor);
  assert.deepEqual(unchanged.payload.outputs, []);
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
  assert.deepEqual(definition.controls, serviceContract.controls);
  assert.deepEqual(definition.schema_documents, serviceContract.schema_documents);
  for (const [role, relative] of Object.entries(serviceContract.schema_documents)) {
    const schema = JSON.parse(await readFile(new URL(`../${relative}`, import.meta.url), 'utf8'));
    const expectedId = role === 'configuration' ? serviceContract.configuration_schema
      : role === 'status' ? serviceContract.status_schema
        : serviceContract.manager_integration_api.output_schema;
    assert.equal(schema.$id, expectedId);
    assert.equal(schema.additionalProperties, false);
  }
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

test('Manager API opening-book output matches its closed packaged schema surface', async (t) => {
  const { catalog, config } = await fixture(t);
  const source = await registerInput(catalog, { fixtureId: 'bootstrap_v1' });
  await ingestSource(catalog, source, config);
  const snapshot = await buildSnapshot(catalog, config, 'integration');
  await publishSnapshot(catalog, config, snapshot.directory, 'integration');
  const response = await listOutputsApi(catalog, config);
  assert.equal(response.payload.outputs.length, 1);
  const output = response.payload.outputs[0];
  const schema = JSON.parse(await readFile(new URL('../contracts/output-schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(output).sort(), [...schema.required].sort());
  for (const field of ['state', 'authority', 'compatibility', 'summary', 'artifact']) {
    assert.deepEqual(Object.keys(output[field]).sort(), [...schema.properties[field].required].sort());
  }
  assert.equal(output.artifact.live_channel_root, path.resolve(config.paths.published, 'integration'));
});

test('Manager API rejects a live channel that no longer matches its immutable output', async (t) => {
  const { catalog, config } = await fixture(t);
  const source = await registerInput(catalog, { fixtureId: 'bootstrap_v1' });
  await ingestSource(catalog, source, config);
  const snapshot = await buildSnapshot(catalog, config, 'integration');
  await publishSnapshot(catalog, config, snapshot.directory, 'integration');
  await writeFile(
    path.join(config.paths.published, 'integration', 'strong_rare_v1.policy'),
    'corrupt\n',
  );
  await assert.rejects(
    listOutputsApi(catalog, config),
    /Snapshot digest mismatch: strong_rare_v1\.policy/u,
  );
});

test('installed CLI status distinguishes startup registration from live daemon activity', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'book-forge-status-cli-'));
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'book-forge-status-cwd-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(cwd, { recursive: true, force: true }),
  ]));
  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve('src/cli.mjs'), 'api', 'status', '--workspace', root,
  ], { cwd });
  const response = JSON.parse(stdout);
  assert.equal(response.operation, 'status');
  assert.equal(response.payload.status.daemon.active, false);
  assert.equal(typeof response.payload.status.startup.inspection, 'string');
  assert.equal(response.payload.status.startup.daemonActive, false);
  assert.ok([true, false, null].includes(response.payload.status.startup.registered));
});

test('installed CLI output inspection accepts the canonical named id', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'book-forge-manager-inspect-'));
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'book-forge-manager-cwd-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(cwd, { recursive: true, force: true }),
  ]));
  const outputId = 'integration-0123456789abcdefabcd';
  await assert.rejects(
    execFileAsync(process.execPath, [
      path.resolve('src/cli.mjs'),
      'api',
      'outputs',
      'inspect',
      '--workspace',
      root,
      '--id',
      outputId,
    ], { cwd }),
    (error) => {
      const response = JSON.parse(error.stderr);
      assert.equal(response.operation, 'outputs_inspect');
      assert.match(response.error.message, new RegExp(outputId));
      assert.doesNotMatch(response.error.message, /malformed/u);
      return true;
    },
  );
});
