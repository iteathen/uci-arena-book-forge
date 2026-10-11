import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readDaemonOwnershipPacket } from './daemon.mjs';
import {
  MAXIMUM_PROCESS_IDENTITY_RECORD_BYTES,
  probeProcessInstance,
  processIdentityFromJson,
  sameProcessInstance,
  validProcessIdentity,
} from './process_identity.mjs';

const STALE_MS = 300_000;
const PHASES = new Set(['acquisition', 'ingestion', 'analysis', 'publication',
  'maintenance', 'sleep', 'recovering', 'stopped', 'failed']);
const unknown = () => ({ state: 'unverifiable', active: null, ownerLive: null, identity: null });
const inactive = (identity = null, ownerLive = false) =>
  ({ state: 'inactive', active: false, ownerLive, identity });
const nonce = value => typeof value === 'string' &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value);
const guid = value => typeof value === 'string' &&
  /^\{[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$/u.test(value);

function restoredLegacyCatalogAbsent(database, probe) {
  const fields = ['singleton','pid','phase','process_identity','started_at','heartbeat_at',
    'cycle_started_at','cycle_completed_at','resource_mode','last_report','last_error','updated_at'];
  const columns = database.prepare('PRAGMA table_info(daemon_state)').all().map(row=>row.name);
  if (columns.length !== fields.length || !fields.every(field=>columns.includes(field)) ||
      database.prepare("SELECT CASE WHEN length(CAST(value AS BLOB))<=32 THEN value ELSE NULL END AS value FROM metadata WHERE key='schema_version'").get()?.value !== '5') return false;
  // Preserve a stored nullable stamp; oversized values get a nonstring sentinel
  // so they cannot collapse into legitimate historical NULL.
  const bounded = (column,limit) => `CASE WHEN ${column} IS NULL THEN NULL WHEN length(CAST(${column} AS BLOB))<=${limit} THEN ${column} ELSE 0 END AS ${column}`;
  const row = database.prepare(`SELECT singleton,pid,${bounded('phase',64)},${bounded('process_identity',1)},
    ${['started_at','heartbeat_at','cycle_started_at','cycle_completed_at','updated_at'].map(column=>bounded(column,32)).join(',')},
    ${bounded('resource_mode',256)},${bounded('last_report',65536)},${bounded('last_error',2048)} FROM daemon_state WHERE singleton=1`).get();
  const stamp = value => {
    if (typeof value !== 'string') return false;
    try { return new Date(value).toISOString() === value; } catch { return false; }
  };
  if (!row || row.singleton !== 1 || !Number.isSafeInteger(row.pid) || row.pid < 1 || row.pid > 0xffff_ffff ||
      row.process_identity !== '' || !PHASES.has(row.phase) ||
      ![row.started_at,row.heartbeat_at,row.updated_at].every(stamp) ||
      ![row.cycle_started_at,row.cycle_completed_at].every(value=>value === null || stamp(value)) ||
      ![row.resource_mode,row.last_report,row.last_error].every(value=>typeof value === 'string')) return false;
  // This recognized migrated legacy shape carries no incarnation. Only native
  // positive PID absence proves inactivity; a present/reused PID never does.
  return probe(row.pid)?.state === 'absent';
}

// Missing legacy lock after an owned stop is not enough. The surviving readonly
// catalog/heartbeat must be well formed and still describe the captured PID;
// malformed/replacement packets never become absence.
export async function observeCapturedDaemonExit(config, { identity, nonce: capturedNonce,
  now = Date.now, probe = probeProcessInstance, Database = DatabaseSync } = {}) {
  let database;
  try {
    if (!validProcessIdentity(identity) || !nonce(capturedNonce) ||
        await readDaemonOwnershipPacket(path.join(config.paths.locks, 'daemon.lock')) !== null) return false;
    const heartbeat = await readDaemonOwnershipPacket(config.daemonHeartbeatFile);
    if (heartbeat !== null) {
      if (!heartbeat.value || heartbeat.value.pid !== identity.pid ||
          !Number.isFinite(Date.parse(heartbeat.value.heartbeatAt)) || Date.parse(heartbeat.value.heartbeatAt) > now()) return false;
      if (Object.hasOwn(heartbeat.value, 'processIdentity') &&
          (!sameProcessInstance(heartbeat.value.processIdentity, identity) || heartbeat.value.nonce !== capturedNonce)) return false;
    }
    const stat = lstatSync(config.paths.catalog);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    database = new Database(config.paths.catalog, { readOnly: true });
    const row = database.prepare('SELECT pid,substr(phase,1,65) AS phase FROM daemon_state WHERE singleton=1').get();
    if (!row || row.pid !== identity.pid || !PHASES.has(row.phase)) return false;
    return probe(identity.pid)?.state === 'absent';
  } catch { return false; }
  finally { try { database?.close(); } catch { return false; } }
}

// Diagnostic/control obstacle only. Even a real present incarnation at a
// legacy record's PID is neither old-incarnation ownership nor kill authority.
export async function observeDaemonDrainObstacle(config, { probe = probeProcessInstance,
  Database = DatabaseSync } = {}) {
  const unavailable = () => ({ state: 'unverifiable',
    authority: 'current-incarnation-at-record-pid-only', currentIncarnation: null });
  let database;
  try {
    const lock = await readDaemonOwnershipPacket(path.join(config.paths.locks, 'daemon.lock'));
    const heartbeat = await readDaemonOwnershipPacket(config.daemonHeartbeatFile);
    if (!lock && !heartbeat) return unavailable();
    if (!lock?.value || !nonce(lock.value.nonce) || !Number.isSafeInteger(lock.value.pid) ||
        lock.value.pid < 1 || !heartbeat?.value || heartbeat.value.pid !== lock.value.pid) return unavailable();
    const stat = lstatSync(config.paths.catalog);
    if (!stat.isFile() || stat.isSymbolicLink()) return unavailable();
    database = new Database(config.paths.catalog, { readOnly: true });
    const row = database.prepare('SELECT pid,substr(phase,1,65) AS phase FROM daemon_state WHERE singleton=1').get();
    if (!row || row.pid !== lock.value.pid || !PHASES.has(row.phase)) return unavailable();
    const observation = probe(row.pid);
    if (observation?.state === 'absent') return { state: 'absent',
      authority: 'current-incarnation-at-record-pid-only', currentIncarnation: null };
    const identity = observation?.state === 'present' ? processIdentityFromJson(observation.identity, row.pid) : null;
    return identity ? { state: 'present', authority: 'current-incarnation-at-record-pid-only',
      currentIncarnation: identity } : unavailable();
  } catch { return unavailable(); }
  finally {
    try { database?.close(); }
    catch { return unavailable(); }
  }
}

// A read-only observation never constructs Catalog or performs schema migrations.
// Records remain Book-owned; only the selected public OS query supplies liveness.
export async function observeDaemonActivity(config, { now = Date.now,
  probe = probeProcessInstance, Database = DatabaseSync } = {}) {
  const catalogPath = config.paths?.catalog ?? path.join(config.workspace, 'catalog.sqlite');
  const lockPath = path.join(config.paths?.locks ?? path.join(config.workspace, 'locks'), 'daemon.lock');
  const heartbeatPath = config.daemonHeartbeatFile ?? path.join(path.dirname(lockPath), 'daemon.heartbeat');
  let database;
  try {
    const lock = await readDaemonOwnershipPacket(lockPath);
    const heartbeat = await readDaemonOwnershipPacket(heartbeatPath);
    if (!existsSync(catalogPath)) return lock || heartbeat ? unknown() : inactive();
    const status = lstatSync(catalogPath);
    if (!status.isFile() || status.isSymbolicLink()) return unknown();
    database = new Database(catalogPath, { readOnly: true });
    const row = database.prepare(`SELECT pid, substr(phase,1,65) AS phase,
      substr(heartbeat_at,1,65) AS heartbeat_at,
      substr(process_identity,1,${MAXIMUM_PROCESS_IDENTITY_RECORD_BYTES + 1}) AS process_identity
      FROM daemon_state WHERE singleton=1`).get();
    if (!row) return unknown();
    if (row.pid === null && row.process_identity === '' && !lock && !heartbeat) return inactive();
    if (row.process_identity === '' && !lock && !heartbeat) {
      return restoredLegacyCatalogAbsent(database,probe) ? inactive() : unknown();
    }
    if (!Number.isSafeInteger(row.pid) || typeof row.process_identity !== 'string' ||
        Buffer.byteLength(row.process_identity) > MAXIMUM_PROCESS_IDENTITY_RECORD_BYTES ||
        !PHASES.has(row.phase)) return unknown();
    const identity = processIdentityFromJson(row.process_identity, row.pid);
    if (!identity) return unknown();
    if (lock && (!lock.value || lock.value.schema !== 'uci_arena_book_forge_daemon_lock_v2' ||
        typeof lock.value.nonce !== 'string' || !lock.value.nonce ||
        !sameProcessInstance(identity, lock.value.processIdentity) || lock.value.pid !== row.pid)) return unknown();
    if (heartbeat && (!heartbeat.value || !sameProcessInstance(identity, heartbeat.value.processIdentity) ||
        heartbeat.value.pid !== row.pid || heartbeat.value.nonce !== lock?.value?.nonce)) return unknown();
    const observed = probe(row.pid);
    if (observed?.state === 'absent') return inactive(identity);
    if (observed?.state !== 'present' || !processIdentityFromJson(observed.identity, row.pid)) return unknown();
    if (!sameProcessInstance(identity, observed.identity)) return inactive(identity);
    if (!lock?.value || !heartbeat?.value) return unknown();
    const clock = now();
    const catalogAt = Date.parse(row.heartbeat_at);
    const packetAt = Date.parse(heartbeat.value.heartbeatAt);
    if (![clock, catalogAt, packetAt].every(Number.isFinite) ||
        catalogAt > clock || packetAt > clock) return unknown();
    const active = clock - catalogAt <= STALE_MS && clock - packetAt <= STALE_MS &&
      !['stopped', 'failed'].includes(row.phase);
    return active ? { state: 'active', active: true, ownerLive: true, identity }
      : inactive(identity, true);
  } catch { return unknown(); }
  finally {
    try { database?.close(); }
    catch { return unknown(); }
  }
}

// Explicit044 compatibility only, called after the producer's controlled drain
// and restart. A legacy PID/heartbeat alone can never enter this active branch.
export async function observeOwnedLegacyActivity(config, { launch, task,
  now = Date.now, probe = probeProcessInstance, Database = DatabaseSync } = {}) {
  let database;
  try {
    if (!launch || !Number.isSafeInteger(launch.originUtcMs) || launch.originUtcMs < 0 ||
        !Number.isSafeInteger(launch.previousOwnerAbsentAtUtcMs) || launch.previousOwnerAbsentAtUtcMs < 0 ||
        launch.previousOwnerAbsentAtUtcMs > launch.originUtcMs || !nonce(launch.previousNonce) ||
        typeof launch.expectedNodeExecutable !== 'string' || typeof launch.taskEnabled !== 'boolean' ||
        !/^[0-9a-f]{64}$/u.test(launch.taskDefinitionSha256) ||
        task?.registered !== true || task.enabled !== launch.taskEnabled ||
        task.definition_sha256 !== launch.taskDefinitionSha256 ||
        !Array.isArray(launch.instanceGuids) || !Array.isArray(task.instance_guids) ||
        launch.instanceGuids.length === 0 || launch.instanceGuids.length > 16 ||
        launch.instanceGuids.length !== task.instance_guids.length ||
        !launch.instanceGuids.every(guid) || new Set(launch.instanceGuids).size !== launch.instanceGuids.length ||
        !task.instance_guids.every(id => launch.instanceGuids.includes(id))) return unknown();
    const lockPath = path.join(config.paths.locks, 'daemon.lock');
    const lock = await readDaemonOwnershipPacket(lockPath);
    const heartbeat = await readDaemonOwnershipPacket(config.daemonHeartbeatFile);
    if (!lock?.value || lock.value.schema !== undefined || !nonce(lock.value.nonce) ||
        lock.value.nonce === launch.previousNonce || !heartbeat?.value ||
        lock.value.pid !== heartbeat.value.pid) return unknown();
    const metadata = lstatSync(config.paths.catalog);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return unknown();
    database = new Database(config.paths.catalog, { readOnly: true });
    const row = database.prepare(`SELECT pid,substr(phase,1,65) AS phase,
      substr(started_at,1,65) AS started_at,substr(heartbeat_at,1,65) AS heartbeat_at
      FROM daemon_state WHERE singleton=1`).get();
    if (!row || row.pid !== lock.value.pid || !PHASES.has(row.phase) ||
        ['stopped', 'failed'].includes(row.phase)) return unknown();
    const clock = now();
    const dates = [Date.parse(lock.value.startedAt), Date.parse(heartbeat.value.heartbeatAt),
      Date.parse(row.started_at), Date.parse(row.heartbeat_at)];
    if (!Number.isSafeInteger(clock) || !dates.every(value => Number.isSafeInteger(value) &&
        value >= launch.originUtcMs && value <= clock) || dates[2] < dates[0] ||
        dates[1] < dates[2] || dates[3] < dates[2] ||
        [dates[1], dates[3]].some(value => clock - value > STALE_MS)) return unknown();
    const observed = probe(row.pid);
    const identity = observed?.state === 'present' ? processIdentityFromJson(observed.identity, row.pid) : null;
    if (!identity || identity.platform !== 'win32' || !sameProcessInstance(identity,
      { ...identity, executable_path: launch.expectedNodeExecutable })) return unknown();
    const birth = BigInt(identity.start_token) / 10000n - 62135596800000n;
    if (birth < BigInt(launch.originUtcMs) || birth > BigInt(dates[0])) return unknown();
    return { state: 'active', active: true, ownerLive: true, identity };
  } catch { return unknown(); }
  finally {
    try { database?.close(); }
    catch { return unknown(); }
  }
}
