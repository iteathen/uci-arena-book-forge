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

export function discoverStockfish({
  environment = process.env,
  platform = process.platform,
  root = suiteRoot,
} = {}) {
  const explicit = environment.UCI_ARENA_STOCKFISH?.trim();
  if (explicit) return path.isAbsolute(explicit) ? path.normalize(explicit) : path.resolve(root, explicit);
  const relative = platform === 'win32'
    ? 'components/stockfish.engine/current/stockfish.exe'
    : 'components/stockfish.engine/current/stockfish';
  const suiteCandidate = path.resolve(root, relative);
  if (existsSync(suiteCandidate)) return suiteCandidate;
  const executable = platform === 'win32' ? 'stockfish.exe' : 'stockfish';
  const searchPath = environment.PATH ?? environment.Path ?? '';
  for (const rawDirectory of searchPath.split(path.delimiter).filter(Boolean)) {
    const directory = rawDirectory.replace(/^"|"$/gu, '');
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.resolve(directory, executable);
    if (existsSync(candidate)) return candidate;
  }
  return suiteCandidate;
}

const defaults = {
  schema: 'uci_arena_book_forge_config_v1',
  workspace: process.env.BOOK_FORGE_ROOT || defaultWorkspace(),
  policyFile: path.join(packageRoot, 'policy', 'strong_rare_v1.policy'),
  stockfish: discoverStockfish(),
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
      || (new RegExp(`^[A-Za-z0-9._-]+${configSchemaSuffix}$`, 'u').test(value)));
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

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownConfiguration(template, candidate, location = 'configuration') {
  if (!plainObject(candidate)) throw new Error(`${location} must be an object`);
  for (const [key, value] of Object.entries(candidate)) {
    if (!Object.hasOwn(template, key)) throw new Error(`Unknown Book Forge configuration field: ${location}.${key}`);
    if (plainObject(template[key])) rejectUnknownConfiguration(template[key], value, `${location}.${key}`);
  }
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonnegativeNumber(value) {
  return Number.isFinite(value) && value >= 0;
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
  const configuration = configFile
    ? JSON.parse(await readFile(path.resolve(configFile), 'utf8')) : {};
  return resolveConfig({ configuration, configFile, workspace });
}

// File and installer composition share one validator. The synchronous form
// accepts already bounded bytes; it never opens a credential or executes a helper.
export function resolveConfig({ configuration = {}, configFile, workspace } = {}) {
  assertSupportedNode();
  const loaded = configuration;
  const configDirectory = configFile ? path.dirname(path.resolve(configFile)) : packageRoot;
  if (configFile || Object.keys(loaded).length) {
    rejectUnknownConfiguration(defaults, loaded);
    if (!compatibleConfigSchema(loaded.schema)) {
      throw new Error(`Unsupported Book Forge config schema: ${loaded.schema ?? '<missing>'}`);
    }
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
  if (typeof config.workspace !== 'string' || typeof config.policyFile !== 'string' ||
      typeof config.stockfish !== 'string' || typeof config.nativeHelper !== 'string' ||
      typeof config.nativeLauncher !== 'string' || typeof config.acquisition.tokenFile !== 'string' ||
      !config.acquisition.tokenFile.trim()) {
    throw new Error('Book Forge configured paths must be non-empty strings');
  }
  if (typeof config.channels.integration !== 'boolean' || typeof config.channels.qualified !== 'boolean' ||
      typeof config.acquisition.enabled !== 'boolean' || typeof config.analysis.enabled !== 'boolean' ||
      typeof config.pgnAudit.enabled !== 'boolean') {
    throw new Error('Book Forge feature switches must be booleans');
  }
  if (config.pgnAudit.enabled) {
    throw new Error('Book Forge PGN audit is reserved but unavailable; pgnAudit.enabled must remain false');
  }
  if (!positiveInteger(config.ingestion.minimumRating) || !positiveInteger(config.ingestion.maximumPly) ||
      !Array.isArray(config.ingestion.speeds) || config.ingestion.speeds.length === 0 ||
      new Set(config.ingestion.speeds).size !== config.ingestion.speeds.length ||
      config.ingestion.speeds.some((speed) => !['rapid', 'classical'].includes(speed)) ||
      !positiveInteger(config.ingestion.chunkGames) || !positiveInteger(config.ingestion.maximumChunkRecords) ||
      !nonnegativeNumber(config.ingestion.inboxSettleSeconds)) {
    throw new Error('Book Forge ingestion configuration violates its bounded corpus contract');
  }
  let acquisitionEndpoint;
  try { acquisitionEndpoint = new URL(config.acquisition.endpoint); } catch { acquisitionEndpoint = null; }
  if (config.acquisition.provider !== 'lichess_opening_explorer' || config.acquisition.variant !== 'standard' ||
      acquisitionEndpoint?.origin !== 'https://explorer.lichess.org' || acquisitionEndpoint.username || acquisitionEndpoint.password ||
      acquisitionEndpoint.pathname !== '/lichess' || acquisitionEndpoint.search || acquisitionEndpoint.hash ||
      !Array.isArray(config.acquisition.speeds) || !config.acquisition.speeds.length ||
      new Set(config.acquisition.speeds).size !== config.acquisition.speeds.length ||
      config.acquisition.speeds.some((speed) => !['rapid', 'classical'].includes(speed)) ||
      !Array.isArray(config.acquisition.ratings) || !config.acquisition.ratings.length ||
      new Set(config.acquisition.ratings).size !== config.acquisition.ratings.length ||
      config.acquisition.ratings.some((rating) => ![2000, 2200, 2500].includes(rating)) ||
      !positiveInteger(config.acquisition.movesPerPosition) || config.acquisition.movesPerPosition > 50 ||
      !positiveInteger(config.acquisition.maximumPly) || !positiveInteger(config.acquisition.minimumGames) ||
      !positiveInteger(config.acquisition.dailyRequestBudget) ||
      !positiveInteger(config.acquisition.requestIntervalMs) || config.acquisition.requestIntervalMs < 5_000 ||
      !positiveInteger(config.acquisition.requestTimeoutMs) || config.acquisition.requestTimeoutMs < 1_000 ||
      !positiveInteger(config.acquisition.resourcePollMs) || config.acquisition.resourcePollMs < 100 || config.acquisition.resourcePollMs > 2_000 ||
      !positiveInteger(config.acquisition.publishedRefreshDays) ||
      !positiveInteger(config.acquisition.frontierRefreshDays) ||
      !positiveInteger(config.acquisition.firstPublishPositions) ||
      !Number.isFinite(config.acquisition.firstPublishMaxMinutes) || config.acquisition.firstPublishMaxMinutes <= 0 ||
      !nonnegativeNumber(config.acquisition.integrationDebounceMinutes) ||
      !Number.isFinite(config.acquisition.crawlLcbGap) || config.acquisition.crawlLcbGap <= 0) {
    throw new Error('Book Forge acquisition configuration violates its numeric or provider contract');
  }
  if (!positiveInteger(config.analysis.initialNodes) || !positiveInteger(config.analysis.confirmationNodes) ||
      config.analysis.confirmationNodes < config.analysis.initialNodes ||
      !positiveInteger(config.analysis.threadsPerWorker) || !positiveInteger(config.analysis.hashMbPerWorker) ||
      !positiveInteger(config.analysis.maximumWorkers) ||
      !positiveInteger(config.analysis.backgroundSipWorkers) ||
      config.analysis.backgroundSipWorkers > config.analysis.maximumWorkers || config.analysis.backgroundSipWorkers > 2 ||
      !positiveInteger(config.analysis.backgroundSipEfficiencyCores) ||
      config.analysis.backgroundSipEfficiencyCores < 1 || config.analysis.backgroundSipEfficiencyCores > 2 ||
      !positiveInteger(config.analysis.backgroundSipDutyCyclePercent) ||
      config.analysis.backgroundSipDutyCyclePercent < 1 || config.analysis.backgroundSipDutyCyclePercent > 50 ||
      !positiveInteger(config.daemon.cycleIntervalMs) || config.daemon.cycleIntervalMs < 1_000 ||
      !positiveInteger(config.daemon.failureBackoffInitialMs) || config.daemon.failureBackoffInitialMs < 1_000 ||
      !positiveInteger(config.daemon.failureBackoffMaximumMs) ||
      config.daemon.failureBackoffMaximumMs < config.daemon.failureBackoffInitialMs) {
    throw new Error('Book Forge analysis or daemon configuration violates its bounded background-work contract');
  }
  if (!Number.isFinite(config.resources.minimumFreeWorkspaceGb) || config.resources.minimumFreeWorkspaceGb < 0 ||
      !Number.isFinite(config.resources.pauseAvailableMemoryGb) || config.resources.pauseAvailableMemoryGb < 0 ||
      !Number.isFinite(config.resources.courtesyCpuPercent) || config.resources.courtesyCpuPercent < 0 || config.resources.courtesyCpuPercent > 100 ||
      !Number.isFinite(config.resources.idleCpuPercent) || config.resources.idleCpuPercent < 0 || config.resources.idleCpuPercent > 100 ||
      !Array.isArray(config.resources.priorityProcessNames) ||
      new Set(config.resources.priorityProcessNames).size !== config.resources.priorityProcessNames.length ||
      config.resources.priorityProcessNames.some((name) => typeof name !== 'string' || !name.trim() || /[\r\n\0]/u.test(name)) ||
      !positiveInteger(config.maintenance.intervalDays) ||
      !positiveInteger(config.maintenance.detailedCohortRetentionMonths) ||
      !positiveInteger(config.maintenance.snapshotVersionsPerChannel)) {
    throw new Error('Book Forge resource or maintenance configuration violates its bounded lifecycle contract');
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
