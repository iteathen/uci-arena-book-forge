import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { validateSnapshot } from './compiler.mjs';

const API_SCHEMA = 'uci_arena_manager_service_api_v1';
const API_VERSION = '1.0';
const COMPONENT_ID = 'book_forge.service';
const COMPONENT_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
const OUTPUT_SCHEMA = 'uci_arena_service_output_v1';
const OUTPUT_KIND = 'opening_book.snapshot';
const OPERATIONS = Object.freeze([
  'describe',
  'status',
  'outputs_list',
  'outputs_inspect',
  'config_validate',
]);

function envelope(operation, payload) {
  return {
    schema: API_SCHEMA,
    api_version: API_VERSION,
    component_id: COMPONENT_ID,
    component_version: COMPONENT_VERSION,
    operation,
    ok: true,
    payload,
  };
}

export function apiError(operation, error) {
  return {
    schema: API_SCHEMA,
    api_version: API_VERSION,
    component_id: COMPONENT_ID,
    component_version: COMPONENT_VERSION,
    operation,
    ok: false,
    error: {
      code: 'service_api_rejected',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function safeSnapshotRoot(config, directory) {
  const root = path.resolve(config.paths.snapshots);
  const resolved = path.resolve(directory);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Book Forge output path escapes the declared snapshot root');
  }
  return resolved;
}

async function outputRecord(catalog, config, row) {
  if (!/^(?:integration|qualified)-[0-9a-f]{20}$/u.test(row.id ?? '')) {
    throw new Error('Book Forge output identity is malformed');
  }
  const directory = safeSnapshotRoot(config, row.directory);
  const validated = await validateSnapshot(directory);
  if (validated.id !== row.id
      || validated.channel !== row.channel
      || validated.manifestSha256 !== row.manifest_sha256
      || validated.qualified !== Boolean(row.qualified)) {
    throw new Error(`Book Forge output identity drifted for ${row.id}`);
  }
  const manifestPath = path.join(directory, 'snapshot.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const current = catalog.channel(row.channel);
  return {
    schema: OUTPUT_SCHEMA,
    output_id: row.id,
    output_kind: OUTPUT_KIND,
    created_at: row.created_at,
    state: {
      channel: row.channel,
      current: current?.snapshot_id === row.id,
      immutable: true,
    },
    authority: {
      installable: true,
      strength_qualified: Boolean(row.qualified),
      diagnostic_only: false,
      includes_fixture: Boolean(row.includes_fixture),
    },
    compatibility: {
      component_id: 'opening_book.standard',
      consumer_component_id: 'uci_arena.engine',
      snapshot_schema: manifest.schema,
    },
    summary: {
      record_count: validated.recordCount,
    },
    artifact: {
      root: directory,
      manifest_path: manifestPath,
      manifest_sha256: validated.manifestSha256,
      files: Object.entries(manifest.artifacts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, sha256]) => ({ name, sha256 })),
    },
  };
}

async function outputs(catalog, config) {
  const records = [];
  for (const row of catalog.snapshotRows()) {
    records.push(await outputRecord(catalog, config, row));
  }
  return records;
}

function outputCursor(records) {
  return createHash('sha256').update(JSON.stringify(records.map((record) => ({
    output_id: record.output_id,
    manifest_sha256: record.artifact.manifest_sha256,
    current: record.state.current,
  })))).digest('hex');
}

export function describeApi() {
  return envelope('describe', {
    transport: 'cli_json',
    invocation: ['api'],
    operations: [...OPERATIONS],
    output_schemas: [OUTPUT_SCHEMA],
    output_kinds: [OUTPUT_KIND],
    configuration_schema: 'uci_arena_book_forge_config_v1',
    status_schema: 'uci_arena_book_forge_status_v2',
  });
}

export function statusApi(catalog) {
  return envelope('status', { status: catalog.status() });
}

export async function listOutputsApi(catalog, config, cursor = '') {
  if (cursor && !/^[0-9a-f]{64}$/u.test(cursor)) {
    throw new Error('Book Forge output cursor is malformed');
  }
  const records = await outputs(catalog, config);
  const currentCursor = outputCursor(records);
  return envelope('outputs_list', {
    cursor: currentCursor,
    unchanged: cursor === currentCursor,
    outputs: cursor === currentCursor ? [] : records,
  });
}

export async function inspectOutputApi(catalog, config, outputId) {
  if (!/^(?:integration|qualified)-[0-9a-f]{20}$/u.test(outputId ?? '')) {
    throw new Error('Book Forge output id is malformed');
  }
  const records = await outputs(catalog, config);
  const record = records.find((candidate) => candidate.output_id === outputId);
  if (!record) throw new Error(`Book Forge output does not exist: ${outputId}`);
  return envelope('outputs_inspect', { output: record });
}

export function validateConfigApi(config) {
  return envelope('config_validate', {
    valid: true,
    configuration_schema: 'uci_arena_book_forge_config_v1',
    workspace: config.workspace,
  });
}
