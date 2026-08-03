import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const repositoryRoot = packageRoot;
export const suiteRoot = process.env.UCI_ARENA_SUITE_ROOT?.trim()
  ? path.resolve(process.env.UCI_ARENA_SUITE_ROOT)
  : packageRoot;

const CONFIG_SCHEMA_SUFFIX = '_book_forge_config_v1';
const COMPATIBLE_SCHEMA = /^[A-Za-z0-9._-]+_book_forge_config_v1$/u;
const PROCESS_BASENAME = /^[A-Za-z0-9_.-]+$/u;

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
  if (explicit) {
    return path.isAbsolute(explicit)
      ? path.normalize(explicit)
      : path.resolve(root, explicit);
  }
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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compatibleConfigSchema(value) {
  return typeof value === 'string'
    && value.length <= 128
    && (value === defaults.schema
      || (value.length > CONFIG_SCHEMA_SUFFIX.length && COMPATIBLE_SCHEMA.test(value)));
}

function assertExactOverrideShape(value, template, context = 'configuration') {
  if (!isPlainObject(value)) throw new Error(`${context} must be an object`);
  for (const [key, child] of Object.entries(value)) {
    if (!Object.hasOwn(template, key)) {
      throw new Error(`Unknown Book Forge configuration field: ${context}.${key}`);
    }
    if (isPlainObject(template[key])) {
      if (!isPlainObject(child)) throw new Error(`${context}.${key} must be an object`);
      assertExactOverrideShape(child, template[key], `${context}.${key}`);
    }
  }
}

function merge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      result[key] = merge(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function requireString(value, name, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new Error(`${name} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
  }
  return value;
}

function requireBoolean(value, name) {
  if (typeof value !== 'boolean') throw new Error(`${name} must be boolean`);
  return value;
}

function requireFiniteNumber(value, name, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a finite number in ${minimum}..${maximum}`);
  }
  return value;
}

function requirePositiveFiniteNumber(value, name, maximum) {
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a finite number greater than 0 and at most ${maximum}`);
  }
  return value;
}

function requireInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function requireUniqueSubset(value, name, allowed) {
  if (!Array.isArray(value) || value.length === 0
      || value.some((entry) => !allowed.includes(entry))
      || new Set(value).size !== value.length) {
    throw new Error(`${name} must be a unique non-empty subset of ${allowed.join(', ')}`);
  }
  return value;
}

function requirePriorityProcessNames(value) {
  if (!Array.isArray(value) || value.length > 256
      || value.some((entry) => typeof entry !== 'string' || !PROCESS_BASENAME.test(entry))
      || new Set(value.map((entry) => entry.toLowerCase())).size !== value.length) {
    throw new Error('resources.priorityProcessNames must contain at most 256 unique executable basenames');
  }
  return value;
}

function resolveConfiguredPath(value, configDirectory, name, { allowEmpty = false } = {}) {
  const text = requireString(value, name, { allowEmpty });
  if (!text) return text;
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(configDirectory, text);
}

function physicalPath(value) {
  const original = path.resolve(value);
  let existing = original;
  const missing = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return path.normalize(original);
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync.native(existing), ...missing);
}

function comparablePath(value) {
  const normalized = path.normalize(physicalPath(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function withinOrEqual(root, candidate) {
  const relative = path.relative(comparablePath(root), comparablePath(candidate));
  return relative === ''
    || (relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

function validateCredentialPath(tokenFile, workspace) {
  if (!tokenFile) return;
  for (const [label, root] of [
    ['Book Forge package', packageRoot],
    ['installed UCI Arena suite', suiteRoot],
    ['Book Forge workspace', workspace],
  ]) {
    if (withinOrEqual(root, tokenFile)) {
      throw new Error(`acquisition.tokenFile must be operator-owned and outside the ${label}`);
    }
  }
}

function validateChannels(config) {
  requireBoolean(config.channels.integration, 'channels.integration');
  requireBoolean(config.channels.qualified, 'channels.qualified');
}

function validateIngestion(config) {
  const value = config.ingestion;
  requireInteger(value.minimumRating, 'ingestion.minimumRating', 2000, 4000);
  requireInteger(value.maximumPly, 'ingestion.maximumPly', 1, 256);
  requireUniqueSubset(value.speeds, 'ingestion.speeds', ['rapid', 'classical']);
  requireInteger(value.chunkGames, 'ingestion.chunkGames', 1, 1_000_000);
  requireInteger(value.maximumChunkRecords, 'ingestion.maximumChunkRecords', 1, 1_000_000);
  requireInteger(value.inboxSettleSeconds, 'ingestion.inboxSettleSeconds', 0, 86_400);
}

function validateAnalysis(config) {
  const value = config.analysis;
  requireBoolean(value.enabled, 'analysis.enabled');
  requireInteger(value.initialNodes, 'analysis.initialNodes', 1, 10_000_000_000);
  requireInteger(value.confirmationNodes, 'analysis.confirmationNodes', 1, 10_000_000_000);
  if (value.confirmationNodes < value.initialNodes) {
    throw new Error('analysis.confirmationNodes must not be less than analysis.initialNodes');
  }
  requireInteger(value.threadsPerWorker, 'analysis.threadsPerWorker', 1, 256);
  requireInteger(value.hashMbPerWorker, 'analysis.hashMbPerWorker', 1, 1_048_576);
  requireInteger(value.maximumWorkers, 'analysis.maximumWorkers', 1, 256);
  requireInteger(value.backgroundSipWorkers, 'analysis.backgroundSipWorkers', 1, 2);
  if (value.backgroundSipWorkers > value.maximumWorkers) {
    throw new Error('analysis.backgroundSipWorkers must not exceed analysis.maximumWorkers');
  }
  requireInteger(value.backgroundSipEfficiencyCores, 'analysis.backgroundSipEfficiencyCores', 1, 2);
  requireInteger(value.backgroundSipDutyCyclePercent,
    'analysis.backgroundSipDutyCyclePercent', 1, 50);
  if (value.enabled) requireString(config.stockfish, 'stockfish');
}

function validateAcquisition(config) {
  const value = config.acquisition;
  requireBoolean(value.enabled, 'acquisition.enabled');
  if (value.enabled) requireString(value.tokenFile, 'acquisition.tokenFile');
  if (value.provider !== 'lichess_opening_explorer') {
    throw new Error('Book Forge acquisition configuration requires provider lichess_opening_explorer');
  }
  if (value.variant !== 'standard') {
    throw new Error('Book Forge acquisition configuration requires the standard variant');
  }
  requireString(value.endpoint, 'acquisition.endpoint');
  let endpoint;
  try { endpoint = new URL(value.endpoint); } catch { endpoint = null; }
  if (endpoint?.origin !== 'https://explorer.lichess.org'
      || endpoint.username || endpoint.password
      || endpoint.pathname !== '/lichess' || endpoint.search || endpoint.hash) {
    throw new Error('Book Forge acquisition configuration requires endpoint exactly https://explorer.lichess.org/lichess');
  }
  requireUniqueSubset(value.speeds, 'acquisition.speeds', ['rapid', 'classical']);
  requireUniqueSubset(value.ratings, 'acquisition.ratings', [2000, 2200, 2500]);
  requireInteger(value.movesPerPosition, 'acquisition.movesPerPosition', 1, 50);
  requireInteger(value.maximumPly, 'acquisition.maximumPly', 1, 256);
  requireInteger(value.minimumGames, 'acquisition.minimumGames', 1, 1_000_000_000);
  requirePositiveFiniteNumber(value.crawlLcbGap, 'acquisition.crawlLcbGap', 1);
  requireInteger(value.requestIntervalMs, 'acquisition.requestIntervalMs', 5_000, 86_400_000);
  requireInteger(value.dailyRequestBudget, 'acquisition.dailyRequestBudget', 1, 1_000_000);
  requireInteger(value.requestTimeoutMs, 'acquisition.requestTimeoutMs', 1_000, 300_000);
  requireInteger(value.resourcePollMs, 'acquisition.resourcePollMs', 100, 2_000);
  requireInteger(value.publishedRefreshDays, 'acquisition.publishedRefreshDays', 1, 3_650);
  requireInteger(value.frontierRefreshDays, 'acquisition.frontierRefreshDays', 1, 3_650);
  requireInteger(value.firstPublishPositions, 'acquisition.firstPublishPositions', 1, 10_000_000);
  requireInteger(value.firstPublishMaxMinutes, 'acquisition.firstPublishMaxMinutes', 1, 10_080);
  requireInteger(value.integrationDebounceMinutes,
    'acquisition.integrationDebounceMinutes', 0, 10_080);
}

function validateResources(config) {
  const value = config.resources;
  requireFiniteNumber(value.minimumFreeWorkspaceGb,
    'resources.minimumFreeWorkspaceGb', 0, 1_000_000);
  requireFiniteNumber(value.pauseAvailableMemoryGb,
    'resources.pauseAvailableMemoryGb', 0, 1_000_000);
  requireInteger(value.courtesyCpuPercent, 'resources.courtesyCpuPercent', 1, 100);
  requireInteger(value.idleCpuPercent, 'resources.idleCpuPercent', 1, 100);
  if (value.idleCpuPercent < value.courtesyCpuPercent) {
    throw new Error('resources.idleCpuPercent must not be less than resources.courtesyCpuPercent');
  }
  requirePriorityProcessNames(value.priorityProcessNames);
}

function validateMaintenance(config) {
  const value = config.maintenance;
  requireInteger(value.intervalDays, 'maintenance.intervalDays', 1, 3_650);
  requireInteger(value.detailedCohortRetentionMonths,
    'maintenance.detailedCohortRetentionMonths', 1, 1_200);
  requireInteger(value.snapshotVersionsPerChannel,
    'maintenance.snapshotVersionsPerChannel', 1, 1_000);
}

function validateDaemon(config) {
  const value = config.daemon;
  requireInteger(value.cycleIntervalMs, 'daemon.cycleIntervalMs', 1_000, 86_400_000);
  requireInteger(value.failureBackoffInitialMs,
    'daemon.failureBackoffInitialMs', 1_000, 86_400_000);
  requireInteger(value.failureBackoffMaximumMs,
    'daemon.failureBackoffMaximumMs', 1_000, 604_800_000);
  if (value.failureBackoffMaximumMs < value.failureBackoffInitialMs) {
    throw new Error('daemon.failureBackoffMaximumMs must not be less than daemon.failureBackoffInitialMs');
  }
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
    assertExactOverrideShape(loaded, defaults);
    configDirectory = path.dirname(absolute);
  }
  const config = merge(structuredClone(defaults), loaded);
  config.schema = defaults.schema;
  const workspaceValue = requireString(
    workspace ?? process.env.BOOK_FORGE_ROOT ?? config.workspace,
    'workspace');
  config.workspace = path.resolve(workspaceValue);
  config.configFile = configFile ? path.resolve(configFile) : null;
  config.policyFile = resolveConfiguredPath(config.policyFile, configDirectory, 'policyFile');
  requireBoolean(config.analysis.enabled, 'analysis.enabled');
  config.stockfish = resolveConfiguredPath(
    config.stockfish, configDirectory, 'stockfish', { allowEmpty: !config.analysis.enabled });
  config.nativeHelper = resolveConfiguredPath(config.nativeHelper, configDirectory, 'nativeHelper');
  config.nativeLauncher = resolveConfiguredPath(config.nativeLauncher, configDirectory, 'nativeLauncher');
  requireBoolean(config.acquisition.enabled, 'acquisition.enabled');
  config.acquisition.tokenFile = resolveConfiguredPath(
    config.acquisition.tokenFile,
    configDirectory,
    'acquisition.tokenFile',
    { allowEmpty: !config.acquisition.enabled });

  validateChannels(config);
  validateIngestion(config);
  validateAnalysis(config);
  validateAcquisition(config);
  requireBoolean(config.pgnAudit.enabled, 'pgnAudit.enabled');
  if (config.pgnAudit.enabled) {
    throw new Error('Book Forge PGN audit is reserved but unavailable; pgnAudit.enabled must remain false');
  }
  validateResources(config);
  validateMaintenance(config);
  validateDaemon(config);
  validateCredentialPath(config.acquisition.tokenFile, config.workspace);

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
  config.nativeHelperAvailable = process.platform === 'win32'
    && Boolean(config.nativeHelper && existsSync(config.nativeHelper));
  config.nativeLauncherAvailable = process.platform === 'win32'
    && Boolean(config.nativeLauncher && existsSync(config.nativeLauncher));
  return config;
}
