import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const repositoryRoot = path.resolve(packageRoot, '..', '..');

const defaults = {
  schema: 'flashfork_book_forge_config_v1',
  workspace: process.env.BOOK_FORGE_ROOT || 'E:/book-forge',
  policyFile: path.join(packageRoot, 'policy', 'strong_rare_v1.policy'),
  stockfish: path.join(repositoryRoot, 'third_party', 'bin', 'stockfish.exe'),
  nativeHelper: path.join(packageRoot, 'native', 'build', 'Release', 'book_forge_guard.exe'),
  channels: { integration: true, qualified: true },
  ingestion: {
    minimumRating: 2000,
    maximumPly: 30,
    speeds: ['rapid', 'classical'],
    chunkGames: 25_000,
    maximumChunkRecords: 100_000,
    inboxSettleSeconds: 60,
  },
  analysis: {
    enabled: true,
    initialNodes: 250_000,
    confirmationNodes: 2_000_000,
    threadsPerWorker: 1,
    hashMbPerWorker: 128,
    maximumWorkers: 8,
  },
  resources: {
    minimumFreeWorkspaceGb: 75,
    pauseAvailableMemoryGb: 6,
    courtesyCpuPercent: 20,
    idleCpuPercent: 80,
    priorityProcessNames: ['flashfork_uci.exe', 'msbuild.exe', 'cl.exe'],
  },
  maintenance: {
    intervalDays: 30,
    detailedCohortRetentionMonths: 24,
    snapshotVersionsPerChannel: 4,
  },
};

function merge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      result[key] = merge(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function resolveConfiguredPath(value, configDirectory) {
  if (!value) return value;
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(configDirectory, value);
}

export function assertSupportedNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 15)) {
    throw new Error(`Book Forge requires Node.js >=24.15.0; found ${process.versions.node}`);
  }
}

export async function loadConfig({ configFile, workspace } = {}) {
  assertSupportedNode();
  let loaded = {};
  let configDirectory = packageRoot;
  if (configFile) {
    const absolute = path.resolve(configFile);
    loaded = JSON.parse(await readFile(absolute, 'utf8'));
    if (loaded.schema !== defaults.schema) {
      throw new Error(`Unsupported Book Forge config schema: ${loaded.schema ?? '<missing>'}`);
    }
    configDirectory = path.dirname(absolute);
  }
  const config = merge(defaults, loaded);
  config.workspace = path.resolve(workspace ?? process.env.BOOK_FORGE_ROOT ?? config.workspace);
  config.policyFile = resolveConfiguredPath(config.policyFile, configDirectory);
  config.stockfish = resolveConfiguredPath(config.stockfish, configDirectory);
  config.nativeHelper = resolveConfiguredPath(config.nativeHelper, configDirectory);
  config.paths = {
    catalog: path.join(config.workspace, 'catalog.sqlite'),
    shards: path.join(config.workspace, 'shards'),
    sources: path.join(config.workspace, 'sources'),
    inbox: path.join(config.workspace, 'inbox'),
    snapshots: path.join(config.workspace, 'snapshots'),
    published: path.join(config.workspace, 'published'),
    locks: path.join(config.workspace, 'locks'),
  };
  config.stockfishAvailable = Boolean(config.stockfish && existsSync(config.stockfish));
  config.nativeHelperAvailable = process.platform === 'win32' && Boolean(config.nativeHelper && existsSync(config.nativeHelper));
  return config;
}
