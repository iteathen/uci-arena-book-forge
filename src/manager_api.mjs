import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { realpath, readFile } from 'node:fs/promises';
import path from 'node:path';

import { validateSnapshot } from './compiler.mjs';
import { queryStartup } from './platform_startup.mjs';

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
  const message = String(error instanceof Error ? error.message : error)
    .replace(/Bearer\s+\S+/giu, 'Bearer <redacted>')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 512) || 'Book Forge rejected the request';
  return {
    schema: API_SCHEMA,
    api_version: API_VERSION,
    component_id: COMPONENT_ID,
    component_version: COMPONENT_VERSION,
    operation,
    ok: false,
    error: {
      code: 'service_api_rejected',
      message,
    },
  };
}

async function safeSnapshotRoot(config, directory) {
  const root = await realpath(path.resolve(config.paths.snapshots));
  const resolved = await realpath(path.resolve(directory));
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Book Forge output path escapes the declared snapshot root');
  }
  return resolved;
}

async function validatedLiveChannelRoot(config, current, expected) {
  if (!current || current.snapshot_id !== expected.id) return null;
  const declared = path.resolve(config.paths.published, expected.channel);
  if (path.resolve(current.directory) !== declared) {
    throw new Error(`Book Forge live channel path drifted for ${expected.id}`);
  }
  const directory = await realpath(declared);
  if (directory !== await realpath(path.resolve(current.directory))) {
    throw new Error(`Book Forge live channel path escaped for ${expected.id}`);
  }
  const validated = await validateSnapshot(directory);
  if (validated.id !== expected.id
      || validated.channel !== expected.channel
      || validated.manifestSha256 !== expected.manifestSha256) {
    throw new Error(`Book Forge live channel identity drifted for ${expected.id}`);
  }
  return directory;
}

async function outputRecord(catalog, config, row) {
  if (!/^(?:integration|qualified)-[0-9a-f]{20}$/u.test(row.id ?? '')) {
    throw new Error('Book Forge output identity is malformed');
  }
  const directory = await safeSnapshotRoot(config, row.directory);
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
  const liveChannelRoot = await validatedLiveChannelRoot(config, current, validated);
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
      live_channel_root: liveChannelRoot,
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
  for (const row of catalog.currentSnapshotRows()) {
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

function catalogOutputCursor(catalog) {
  return createHash('sha256').update(JSON.stringify(
    catalog.currentSnapshotRows().map((row) => ({
      output_id: row.id,
      manifest_sha256: row.manifest_sha256,
      current: true,
    })),
  )).digest('hex');
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
    schema_documents: {
      configuration: 'contracts/configuration-schema.json',
      status: 'contracts/status-schema.json',
      output: 'contracts/output-schema.json',
    },
  });
}

export async function publicStatus(catalog, config, queryImpl = queryStartup) {
  const { schema: _catalogSchema, ...catalogStatus } = catalog.status();
  const status = { schema: 'uci_arena_book_forge_status_v2', ...catalogStatus };
  try {
    const startup = await queryImpl(config);
    return {
      ...status,
      startup: {
        platform: startup.platform ?? process.platform,
        inspection: 'available',
        inspectionReason: '',
        registered: Boolean(startup.installed),
        enabled: Boolean(startup.enabled),
        serviceManagerActive: typeof startup.active === 'boolean' ? startup.active : null,
        daemonActive: status.daemon.active,
        matchesCurrentConfiguration: typeof startup.matchesCurrentConfiguration === 'boolean'
          ? startup.matchesCurrentConfiguration : null,
      },
    };
  } catch {
    return {
      ...status,
      startup: {
        platform: process.platform,
        inspection: 'unavailable',
        inspectionReason: 'platform startup inspection failed',
        registered: null,
        enabled: null,
        serviceManagerActive: null,
        daemonActive: status.daemon.active,
        matchesCurrentConfiguration: null,
      },
    };
  }
}

export async function statusApi(catalog, config, queryImpl = queryStartup) {
  return envelope('status', { status: await publicStatus(catalog, config, queryImpl) });
}

export async function listOutputsApi(catalog, config, cursor = '') {
  if (cursor && !/^[0-9a-f]{64}$/u.test(cursor)) {
    throw new Error('Book Forge output cursor is malformed');
  }
  const catalogCursor = catalogOutputCursor(catalog);
  if (cursor === catalogCursor) {
    return envelope('outputs_list', {
      cursor: catalogCursor,
      unchanged: true,
      outputs: [],
    });
  }
  const records = await outputs(catalog, config);
  const currentCursor = outputCursor(records);
  if (currentCursor !== catalogCursor) {
    throw new Error('Book Forge output cursor drifted during validation');
  }
  return envelope('outputs_list', {
    cursor: currentCursor,
    unchanged: false,
    outputs: records,
  });
}

export async function inspectOutputApi(catalog, config, outputId) {
  if (!/^(?:integration|qualified)-[0-9a-f]{20}$/u.test(outputId ?? '')) {
    throw new Error('Book Forge output id is malformed');
  }
  const row = catalog.snapshot(outputId);
  if (!row) throw new Error(`Book Forge output does not exist: ${outputId}`);
  return envelope('outputs_inspect', { output: await outputRecord(catalog, config, row) });
}

export function validateConfigApi(config) {
  return envelope('config_validate', {
    valid: true,
    configuration_schema: 'uci_arena_book_forge_config_v1',
    workspace: config.workspace,
  });
}
