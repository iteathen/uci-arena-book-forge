import { lstat, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { acquireResourceLease } from '@uci-arena/background-service-runtime/lease';
import processQueryContract from '@uci-arena/background-service-runtime/process-instance-query-contract' with { type: 'json' };
import { ExplorerAcquisition } from './acquisition.mjs';
import { buildSnapshot } from './compiler.mjs';
import { discoverInbox, ingestSource } from './ingest.mjs';
import { runMaintenance } from './maintenance.mjs';
import { publishSnapshot } from './publisher.mjs';
import { RESOURCE_WORK_CLASSES, ResourceGovernor } from './resource_governor.mjs';
import { analyzeObservations } from './stockfish.mjs';
import {
  currentProcessIdentity,
  configureProcessIdentity,
  MAXIMUM_PROCESS_IDENTITY_RECORD_BYTES,
  probeProcessInstance,
  sameProcessInstance,
  validProcessIdentity,
} from './process_identity.mjs';

const DAEMON_LOCK_SETTLE_MS = 10_000;
const LEGACY_DAEMON_STALE_MS = 300_000;

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function scopedGovernor(governor, workClass, lease = null) {
  return {
    permit: async () => {
      const revocation = lease?.revocationReason();
      if (revocation) {
        return {
          allowed: false,
          mode: 'preempt',
          reason: revocation,
          sampledAt: new Date().toISOString(),
        };
      }
      return governor.permit(workClass);
    },
  };
}

async function defaultHeavyLeaseFactory() {
  return acquireResourceLease({
    producer: 'book_forge',
    priority: 'background',
    timeoutMs: 250,
  });
}

async function withHeavyLease(factory, work) {
  const lease = await factory();
  if (!lease) return { acquired: false, reason: 'shared heavy background lease is busy' };
  const heartbeat = setInterval(() => lease.heartbeat(), 2_000);
  heartbeat.unref?.();
  try {
    return { acquired: true, value: await work(lease) };
  } finally {
    clearInterval(heartbeat);
    lease.release();
  }
}

async function readLockPacket(filename) {
  try {
    const link = await lstat(filename);
    if (!link.isFile() || link.isSymbolicLink() || link.size > MAXIMUM_PROCESS_IDENTITY_RECORD_BYTES) {
      return { value: null, raw: null, modifiedMs: link.mtimeMs };
    }
    const handle = await open(filename, 'r');
    let bytes;
    try {
      const descriptor = await handle.stat();
      if (!descriptor.isFile() || descriptor.size > MAXIMUM_PROCESS_IDENTITY_RECORD_BYTES) return { value: null, raw: null, modifiedMs: link.mtimeMs };
      const buffer = Buffer.alloc(MAXIMUM_PROCESS_IDENTITY_RECORD_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > MAXIMUM_PROCESS_IDENTITY_RECORD_BYTES) return { value: null, raw: null, modifiedMs: link.mtimeMs };
      bytes = buffer.subarray(0, offset);
    } finally {
      await handle.close();
    }
    const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    try {
      return { value: JSON.parse(raw), raw, modifiedMs: link.mtimeMs };
    } catch {
      return { value: null, raw, modifiedMs: link.mtimeMs };
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { value: null, raw: null, modifiedMs: 0 };
  }
}

async function legacyHeartbeatIsFresh(config, lock, now) {
  try {
    const heartbeat = await readLockPacket(config.daemonHeartbeatFile);
    if (heartbeat === null) return false;
    if (!heartbeat.value) return null;
    const heartbeatAt = Date.parse(String(heartbeat?.value?.heartbeatAt ?? ''));
    return heartbeat?.value?.pid === lock?.pid
      && Number.isFinite(heartbeatAt)
      && now - heartbeatAt <= LEGACY_DAEMON_STALE_MS;
  } catch {
    return null;
  }
}

async function retireLock(filename, expected) {
  if (typeof expected?.raw !== 'string') return false;
  const current = await readLockPacket(filename);
  if (typeof current?.raw !== 'string' || current.raw !== expected.raw) return false;
  const retired = `${filename}.retired-${process.pid}-${randomUUID()}`;
  try {
    await rename(filename, retired);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  await rm(retired, { force: true });
  return true;
}

export async function acquireDaemonLock(config, {
  identity = currentProcessIdentity(),
  probe = probeProcessInstance,
  now = Date.now,
} = {}) {
  if (!validProcessIdentity(identity, process.pid)) {
    throw new Error('Book Forge daemon process identity is invalid');
  }
  const filename = path.join(config.paths.locks, 'daemon.lock');
  const nonce = randomUUID();
  let handle;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      handle = await open(filename, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const packet = await readLockPacket(filename);
      if (!packet) continue;
      const age = Math.max(0, now() - packet.modifiedMs);
      const lock = packet.value;
      const currentFormat = lock?.schema === 'uci_arena_book_forge_daemon_lock_v2';
      const legacyFormat = lock && (lock.schema === undefined || lock.schema === 'uci_arena_book_forge_daemon_lock_v1')
        && !Object.hasOwn(lock, 'processIdentity') && Number.isSafeInteger(lock.pid)
        && lock.pid >= processQueryContract.pid_minimum && lock.pid <= processQueryContract.pid_maximum;
      const recordedIdentity = currentFormat && validProcessIdentity(lock?.processIdentity) && lock.pid === lock.processIdentity.pid
        ? lock.processIdentity
        : null;
      if ((!currentFormat && !legacyFormat) || (currentFormat && !recordedIdentity)) {
        throw new Error(`Book Forge daemon ownership is malformed or unverifiable at ${filename}`);
      }
      let reclaimable = false;
      if (recordedIdentity) {
        const observed = probe(recordedIdentity.pid);
        if (observed?.state !== 'absent' && !(observed?.state === 'present' && validProcessIdentity(observed.identity, recordedIdentity.pid))) {
          throw new Error(`Another Book Forge daemon has unverifiable ownership of ${filename}`);
        }
        reclaimable = observed?.state === 'absent'
          || (observed?.state === 'present'
            && !sameProcessInstance(recordedIdentity, observed.identity));
      } else if (age >= DAEMON_LOCK_SETTLE_MS) {
        const observed = Number.isSafeInteger(lock?.pid) && lock.pid > 0
          ? probe(lock.pid)
          : { state: 'unverifiable' };
        if (observed?.state !== 'absent' && !(observed?.state === 'present' && validProcessIdentity(observed.identity, lock.pid))) {
          throw new Error(`Another Book Forge daemon has unverifiable ownership of ${filename}`);
        }
        reclaimable = observed?.state === 'absent'
          || (age >= LEGACY_DAEMON_STALE_MS
            && await legacyHeartbeatIsFresh(config, lock, now()) === false);
      }
      if (!reclaimable || age < DAEMON_LOCK_SETTLE_MS || attempt > 1) {
        throw new Error(`Another Book Forge daemon owns ${filename}`);
      }
      if (!await retireLock(filename, packet)) continue;
    }
  }
  if (!handle) throw new Error(`Could not acquire Book Forge daemon lock ${filename}`);
  const lock = {
    schema: 'uci_arena_book_forge_daemon_lock_v2',
    pid: process.pid,
    nonce,
    startedAt: new Date(now()).toISOString(),
    processIdentity: identity,
  };
  const raw = `${JSON.stringify(lock)}\n`;
  await handle.writeFile(raw);
  await handle.sync();
  return {
    nonce,
    processIdentity: identity,
    release: async () => {
    await handle.close();
      await retireLock(filename, { raw });
    },
  };
}

function integrationBuildDue(catalog, config, report) {
  if (!catalog.channel('integration')) return true;
  if (report.acquisition?.positions > 0 || report.ingested.length || catalog.pendingSources().length) {
    const last = Date.parse(catalog.metadata('last_integration_build_at') ?? '');
    return !Number.isFinite(last) || Date.now() - last >= config.acquisition.integrationDebounceMinutes * 60_000;
  }
  return false;
}

function acquisitionBootstrapReady(catalog, config) {
  const status = catalog.acquisitionStatus();
  if (status.positions >= config.acquisition.firstPublishPositions) return true;
  const dataset = catalog.acquisitionEvidence().find((entry) => entry.contribution_mode === 'authoritative');
  return dataset && Date.now() - Date.parse(dataset.created_at) >= config.acquisition.firstPublishMaxMinutes * 60_000;
}

export async function runCycle(catalog, config, governor = new ResourceGovernor(config, catalog),
    acquisition = new ExplorerAcquisition(catalog, config), setPhase = () => {}, acquisitionMaxRequests = undefined,
    acquisitionOnly = false, analyzer = analyzeObservations,
    heavyLeaseFactory = defaultHeavyLeaseFactory) {
  const acquisitionPermit = await governor.permit(RESOURCE_WORK_CLASSES.ACQUISITION);
  const report = { acquisition: null, discovered: [], ingested: [], integration: null, analysis: null, qualified: null, maintenance: null, resource: acquisitionPermit };
  if (!acquisitionPermit.allowed) {
    report.acquisition = { enabled: config.acquisition.enabled, requests: 0, positions: 0, moves: 0, stopped: acquisitionPermit.reason };
    if (!acquisitionOnly) {
      report.analysis = { positions: 0, moves: 0, skipped: true, reason: acquisitionPermit.reason };
      report.maintenance = { skipped: true, reason: acquisitionPermit.reason };
    }
    return report;
  }
  setPhase('acquisition', acquisitionPermit.mode);
  report.acquisition = await acquisition.run(governor, { maxRequests: acquisitionMaxRequests });
  if (acquisitionOnly) return report;

  const ingestionPermit = await governor.permit(RESOURCE_WORK_CLASSES.INGESTION_AND_MAINTENANCE);
  report.resource = ingestionPermit;
  setPhase('ingestion', ingestionPermit.mode);
  if (ingestionPermit.allowed) {
    const leased = await withHeavyLease(heavyLeaseFactory, async (lease) => {
      const ingestionGovernor = scopedGovernor(
        governor,
        RESOURCE_WORK_CLASSES.INGESTION_AND_MAINTENANCE,
        lease,
      );
      report.discovered = await discoverInbox(catalog, config, ingestionGovernor);
      for (const source of catalog.pendingSources()) {
        const permit = await ingestionGovernor.permit();
        report.resource = permit;
        if (!permit.allowed) break;
        try {
          const telemetry = await ingestSource(catalog, source, config, ingestionGovernor);
          report.ingested.push({ sourceId: Number(source.id), ...telemetry });
          if (telemetry.interrupted) break;
        } catch (error) {
          report.ingested.push({ sourceId: Number(source.id), error: error.message });
        }
      }
    });
    if (!leased.acquired) {
      report.resource = { ...ingestionPermit, allowed: false, reason: leased.reason };
    }
  }

  const localReady = catalog.completedSources().some((source) => source.contribution_mode === 'additive');
  const remoteReady = config.acquisition.enabled && catalog.hasPublishableObservations() && acquisitionBootstrapReady(catalog, config);
  if (config.channels.integration && (localReady || remoteReady) && integrationBuildDue(catalog, config, report)) {
    const publicationPermit = await governor.permit(RESOURCE_WORK_CLASSES.INTEGRATION_PUBLICATION);
    report.resource = publicationPermit;
    setPhase('publication', publicationPermit.mode);
    if (publicationPermit.allowed) {
      try {
        const snapshot = await buildSnapshot(catalog, config, 'integration');
        report.integration = await publishSnapshot(catalog, config, snapshot.directory, 'integration');
        catalog.setMetadata('last_integration_build_at', new Date().toISOString());
      } catch (error) {
        report.integration = { blocked: true, reason: error.message };
      }
    } else {
      report.integration = { blocked: true, reason: publicationPermit.reason };
    }
  }

  const analysisPermit = await governor.permit(RESOURCE_WORK_CLASSES.STOCKFISH_ANALYSIS);
  report.resource = analysisPermit;
  setPhase('analysis', analysisPermit.mode);
  if (analysisPermit.allowed) {
    const leased = await withHeavyLease(heavyLeaseFactory, async (lease) => {
      try {
        return await analyzer(
          catalog,
          config,
          scopedGovernor(governor, RESOURCE_WORK_CLASSES.STOCKFISH_ANALYSIS, lease),
          { lease },
        );
      } catch (error) {
        return {
          positions: 0,
          moves: 0,
          skipped: true,
          recoverableError: String(error?.message ?? error).slice(0, 512),
        };
      }
    });
    report.analysis = leased.acquired
      ? leased.value
      : { positions: 0, moves: 0, skipped: true, reason: leased.reason };
  } else {
    report.analysis = { positions: 0, moves: 0, skipped: true, reason: analysisPermit.reason };
  }

  if (config.channels.qualified && catalog.hasPublishableObservations({ includeFixtures: false })) {
    const qualifiedPermit = await governor.permit(RESOURCE_WORK_CLASSES.INTEGRATION_PUBLICATION);
    report.resource = qualifiedPermit;
    setPhase('publication', qualifiedPermit.mode);
    if (qualifiedPermit.allowed) {
      try {
        const snapshot = await buildSnapshot(catalog, config, 'qualified');
        report.qualified = await publishSnapshot(catalog, config, snapshot.directory, 'qualified');
      } catch (error) {
        report.qualified = { blocked: true, reason: error.message };
      }
    } else {
      report.qualified = { blocked: true, reason: qualifiedPermit.reason };
    }
  }

  const maintenancePermit = await governor.permit(RESOURCE_WORK_CLASSES.INGESTION_AND_MAINTENANCE);
  report.resource = maintenancePermit;
  setPhase('maintenance', maintenancePermit.mode);
  if (maintenancePermit.allowed) {
    const leased = await withHeavyLease(
      heavyLeaseFactory,
      () => runMaintenance(catalog, config),
    );
    report.maintenance = leased.acquired
      ? leased.value
      : { skipped: true, reason: leased.reason };
  } else report.maintenance = { skipped: true, reason: maintenancePermit.reason };
  return report;
}

export async function runDaemon(catalog, config, {
  once = false,
  acquisitionMaxRequests = undefined,
  acquisitionOnly = false,
  cycleRunner = runCycle,
  governorFactory = (configuration, storage) => new ResourceGovernor(configuration, storage),
  delayImpl = delay,
  maximumCycleAttempts = Number.POSITIVE_INFINITY,
} = {}) {
  if (acquisitionOnly && !once) throw new Error('Acquisition-only execution must be one shot');
  if (!once && (!Number.isInteger(maximumCycleAttempts) || maximumCycleAttempts < 1) &&
      maximumCycleAttempts !== Number.POSITIVE_INFINITY) {
    throw new TypeError('maximumCycleAttempts must be a positive integer or Infinity');
  }
  await configureProcessIdentity(config);
  const daemonLock = await acquireDaemonLock(config);
  const startedAt = new Date().toISOString();
  const heartbeat = async () => {
    const now = new Date().toISOString();
    let catalogError = null;
    try {
      catalog.updateDaemonState({
        pid: process.pid,
        process_identity: JSON.stringify(daemonLock.processIdentity),
        started_at: startedAt,
        heartbeat_at: now,
      });
    }
    catch (error) { catalogError = error; }
    const temporary = `${config.daemonHeartbeatFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({
      pid: process.pid,
      nonce: daemonLock.nonce,
      processIdentity: daemonLock.processIdentity,
      heartbeatAt: now,
    })}\n`, 'utf8');
    await rename(temporary, config.daemonHeartbeatFile);
    if (catalogError) throw catalogError;
  };
  await heartbeat();
  const heartbeatTimer = setInterval(() => { heartbeat().catch(() => {}); }, 15_000);
  const setPhase = (phase, resourceMode = '') => catalog.updateDaemonState({ phase, resource_mode: resourceMode, heartbeat_at: new Date().toISOString() });
  let governor = null;
  let completedNormally = false;
  try {
    governor = governorFactory(config, catalog);
    const acquisition = new ExplorerAcquisition(catalog, config);
    let lastReport = null;
    let attempts = 0;
    let consecutiveFailures = 0;
    do {
      attempts += 1;
      try {
        catalog.updateDaemonState({ cycle_started_at: new Date().toISOString() });
        lastReport = await cycleRunner(
          catalog, config, governor, acquisition, setPhase, acquisitionMaxRequests, acquisitionOnly);
        consecutiveFailures = 0;
        catalog.updateDaemonState({
          cycle_completed_at: new Date().toISOString(), last_report: lastReport, last_error: '',
        });
      } catch (error) {
        const boundedError = String(error?.message ?? error).slice(0, 2_048);
        if (once || attempts >= maximumCycleAttempts) {
          catalog.updateDaemonState({ phase: 'failed', heartbeat_at: new Date().toISOString(), last_error: boundedError });
          throw error;
        }
        consecutiveFailures += 1;
        const retryDelayMs = Math.min(config.daemon.failureBackoffMaximumMs,
          config.daemon.failureBackoffInitialMs * (2 ** Math.min(30, consecutiveFailures - 1)));
        const nextRetryAt = new Date(Date.now() + retryDelayMs).toISOString();
        try {
          catalog.updateDaemonState({
            phase: 'recovering', resource_mode: governor.last.mode,
            heartbeat_at: new Date().toISOString(), last_error: boundedError,
            last_report: {
              recovery: { consecutiveFailures, retryDelayMs, nextRetryAt, error: boundedError },
            },
          });
        } catch {}
        await delayImpl(retryDelayMs);
        continue;
      }
      if (!once && attempts < maximumCycleAttempts) {
        try { setPhase('sleep', governor.last.mode); } catch {}
        await delayImpl(config.daemon.cycleIntervalMs);
      }
    } while (!once && attempts < maximumCycleAttempts);
    completedNormally = true;
    return lastReport;
  } catch (error) {
    try {
      catalog.updateDaemonState({
        phase: 'failed', heartbeat_at: new Date().toISOString(),
        last_error: String(error?.message ?? error).slice(0, 2_048),
      });
    } catch {}
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
    governor?.close();
    if (completedNormally) {
      catalog.updateDaemonState({ phase: 'stopped', heartbeat_at: new Date().toISOString() });
    }
    await daemonLock.release();
  }
}
