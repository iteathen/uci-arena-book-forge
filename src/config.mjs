import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const repositoryRoot = packageRoot;
export const suiteRoot = process.env.UCI_ARENA_SUITE_ROOT?.trim()
  ? path.resolve(process.env.UCI_ARENA_SUITE_ROOT)
  : packageRoot;

function defaultWorkspace() {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA?.trim() || os.homedir();
    return path.join(local, 'UCI Arena', 'Book Forge');
  }
  const state = process.env.XDG_STATE_HOME?.trim()
    || path.join(os.homedir(), '.local', 'state');
  return path.join(state, 'uci-arena', 'book-forge');
}

function defaultTokenFile() {
  if (process.platform === 'win32') {
    const config = process.env.APPDATA?.trim() || os.homedir();
    return path.join(config, 'UCI Arena', 'secrets', 'lichess_bot_token.txt');
  }
  const config = process.env.XDG_CONFIG_HOME?.trim()
    || path.join(os.homedir(), '.config');
  return path.join(config, 'uci-arena', 'secrets', 'lichess_bot_token.txt');
}

function suiteExecutable(windowsPath, unixPath) {
  return path.join(suiteRoot, process.platform === 'win32' ? windowsPath : unixPath);
}

const defaults = {
  schema: 'uci_arena_book_forge_config_v1',
  workspace: process.env.BOOK_FORGE_ROOT || defaultWorkspace(),
  policyFile: path.join(packageRoot, 'policy', 'strong_rare_v1.policy'),
  stockfish: process.env.UCI_ARENA_STOCKFISH?.trim()
    || suiteExecutable('components/stockfish.engine/current/stockfish.exe',
      'components/stockfish.engine/current/stockfish'),
  nativeHelper: path.join(packageRoot, 'native', 'bin',
    process.platform === 'win32' ? 'uci_arena_background_guard.exe' : 'uci_arena_background_guard'),
  nativeLauncher: path.join(packageRoot, 'native', 'bin',
    process.platform === 'win32' ? 'uci_arena_service_launcher.exe' : 'uci_arena_service_launcher'),
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
    backgroundSipWorkers: 2,
    backgroundSipEfficiencyCores: 2,
    backgroundSipDutyCyclePercent: 50,
  },
  acquisition: {
    enabled: true,
    provider: 'lichess_opening_explorer',
    endpoint: 'https://explorer.lichess.org/lichess',
    tokenFile: defaultTokenFile(),
    variant: 'standard',
    speeds: ['rapid', 'classical'],
    ratings: [2000, 2200, 2500],
    movesPerPosition: 50,
    maximumPly: 30,
    minimumGames: 32,
    crawlLcbGap: 0.10,
    requestIntervalMs: 5_000,
    dailyRequestBudget: 2_000,
    requestTimeoutMs: 10_000,
    resourcePollMs: 1_000,
    publishedRefreshDays: 7,
    frontierRefreshDays: 30,
    firstPublishPositions: 25,
    firstPublishMaxMinutes: 5,
    integrationDebounceMinutes: 15,
  },
  pgnAudit: { enabled: false },
  resources: {
    minimumFreeWorkspaceGb: 75,
    pauseAvailableMemoryGb: 6,
    courtesyCpuPercent: 20,
    idleCpuPercent: 80,
    priorityProcessNames: ['uci_arena_engine.exe', 'msbuild.exe', 'cl.exe'],
  },
  maintenance: {
    intervalDays: 30,
    detailedCohortRetentionMonths: 24,
    snapshotVersionsPerChannel: 4,
  },
  daemon: {
    cycleIntervalMs: 60_000,
    failureBackoffInitialMs: 5_000,
    failureBackoffMaximumMs: 300_000,
  },
};

const configSchemaSuffix = '_book_forge_config_v1';

function compatibleConfigSchema(value) {
  return typeof value === 'string'
    && (value === defaults.schema
      || (value.endsWith(configSchemaSuffix) && value.length > configSchemaSuffix.length));
}

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
    if (!compatibleConfigSchema(loaded.schema)) {
      throw new Error(`Unsupported Book Forge config schema: ${loaded.schema ?? '<missing>'}`);
    }
    configDirectory = path.dirname(absolute);
  }
  const config = merge(structuredClone(defaults), loaded);
  config.schema = defaults.schema;
  config.workspace = path.resolve(workspace ?? process.env.BOOK_FORGE_ROOT ?? config.workspace);
  config.configFile = configFile ? path.resolve(configFile) : null;
  config.policyFile = resolveConfiguredPath(config.policyFile, configDirectory);
  config.stockfish = resolveConfiguredPath(config.stockfish, configDirectory);
  config.nativeHelper = resolveConfiguredPath(config.nativeHelper, configDirectory);
  config.nativeLauncher = resolveConfiguredPath(config.nativeLauncher, configDirectory);
  config.acquisition.tokenFile = resolveConfiguredPath(config.acquisition.tokenFile, configDirectory);
  let acquisitionEndpoint;
  try { acquisitionEndpoint = new URL(config.acquisition.endpoint); } catch { acquisitionEndpoint = null; }
  if (config.acquisition.provider !== 'lichess_opening_explorer' || config.acquisition.variant !== 'standard' ||
      acquisitionEndpoint?.origin !== 'https://explorer.lichess.org' || acquisitionEndpoint.username || acquisitionEndpoint.password ||
      acquisitionEndpoint.pathname !== '/lichess' || acquisitionEndpoint.search || acquisitionEndpoint.hash ||
      !Array.isArray(config.acquisition.speeds) || !config.acquisition.speeds.length ||
      config.acquisition.speeds.some((speed) => !['rapid', 'classical'].includes(speed)) ||
      !Array.isArray(config.acquisition.ratings) || !config.acquisition.ratings.length ||
      config.acquisition.ratings.some((rating) => ![2000, 2200, 2500].includes(rating)) ||
      !Number.isInteger(config.acquisition.movesPerPosition) || config.acquisition.movesPerPosition < 1 || config.acquisition.movesPerPosition > 50 ||
      !Number.isInteger(config.acquisition.maximumPly) || config.acquisition.maximumPly < 1 ||
      !Number.isInteger(config.acquisition.minimumGames) || config.acquisition.minimumGames < 1 ||
      !Number.isInteger(config.acquisition.dailyRequestBudget) || config.acquisition.dailyRequestBudget < 1 ||
      config.acquisition.requestIntervalMs < 5_000 || config.acquisition.requestTimeoutMs < 1_000 ||
      config.acquisition.resourcePollMs < 100 || config.acquisition.resourcePollMs > 2_000 ||
      !Number.isInteger(config.acquisition.publishedRefreshDays) || config.acquisition.publishedRefreshDays < 1 ||
      !Number.isInteger(config.acquisition.frontierRefreshDays) || config.acquisition.frontierRefreshDays < 1 ||
      !Number.isInteger(config.acquisition.firstPublishPositions) || config.acquisition.firstPublishPositions < 1 ||
      config.acquisition.firstPublishMaxMinutes <= 0 || config.acquisition.integrationDebounceMinutes < 0 ||
      config.acquisition.crawlLcbGap <= 0) {
    throw new Error('Book Forge acquisition configuration violates its numeric or provider contract');
  }
  if (!Number.isInteger(config.analysis.threadsPerWorker) || config.analysis.threadsPerWorker < 1 ||
      !Number.isInteger(config.analysis.maximumWorkers) || config.analysis.maximumWorkers < 1 ||
      !Number.isInteger(config.analysis.backgroundSipWorkers) || config.analysis.backgroundSipWorkers < 1 ||
      config.analysis.backgroundSipWorkers > config.analysis.maximumWorkers || config.analysis.backgroundSipWorkers > 2 ||
      !Number.isInteger(config.analysis.backgroundSipEfficiencyCores) ||
      config.analysis.backgroundSipEfficiencyCores < 1 || config.analysis.backgroundSipEfficiencyCores > 2 ||
      !Number.isInteger(config.analysis.backgroundSipDutyCyclePercent) ||
      config.analysis.backgroundSipDutyCyclePercent < 1 || config.analysis.backgroundSipDutyCyclePercent > 50 ||
      !Number.isInteger(config.daemon.cycleIntervalMs) || config.daemon.cycleIntervalMs < 1_000 ||
      !Number.isInteger(config.daemon.failureBackoffInitialMs) || config.daemon.failureBackoffInitialMs < 1_000 ||
      !Number.isInteger(config.daemon.failureBackoffMaximumMs) ||
      config.daemon.failureBackoffMaximumMs < config.daemon.failureBackoffInitialMs) {
    throw new Error('Book Forge analysis or daemon configuration violates its bounded background-work contract');
  }
  config.paths = {
    catalog: path.join(config.workspace, 'catalog.sqlite'),
    shards: path.join(config.workspace, 'shards'),
    sources: path.join(config.workspace, 'sources'),
    inbox: path.join(config.workspace, 'inbox'),
    snapshots: path.join(config.workspace, 'snapshots'),
    published: path.join(config.workspace, 'published'),
    locks: path.join(config.workspace, 'locks'),
  };
  config.daemonHeartbeatFile = path.join(config.paths.locks, 'daemon.heartbeat');
  config.stockfishAvailable = Boolean(config.stockfish && existsSync(config.stockfish));
  config.nativeHelperAvailable = process.platform === 'win32' && Boolean(config.nativeHelper && existsSync(config.nativeHelper));
  config.nativeLauncherAvailable = process.platform === 'win32' && Boolean(config.nativeLauncher && existsSync(config.nativeLauncher));
  return config;
}
