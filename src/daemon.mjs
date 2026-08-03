import { open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireResourceLease } from '@uci-arena/background-service-runtime/lease';
import { ExplorerAcquisition } from './acquisition.mjs';
import { buildSnapshot } from './compiler.mjs';
import { discoverInbox, ingestSource } from './ingest.mjs';
import { runMaintenance } from './maintenance.mjs';
import { publishSnapshot } from './publisher.mjs';
import { RESOURCE_WORK_CLASSES, ResourceGovernor } from './resource_governor.mjs';
import { analyzeObservations } from './stockfish.mjs';

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

async function acquireLock(config) {
  const filename = path.join(config.paths.locks, 'daemon.lock');
  let handle;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(filename, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let lock;
      let age = 0;
      try {
        lock = JSON.parse(await readFile(filename, 'utf8'));
        age = Date.now() - (await stat(filename)).mtimeMs;
      } catch {}
      let alive = age < 10_000;
      if (!alive && Number.isInteger(lock?.pid)) {
        try { process.kill(lock.pid, 0); alive = true; } catch (probeError) { alive = probeError.code === 'EPERM'; }
      }
      if (alive || attempt > 0) throw new Error(`Another Book Forge daemon owns ${filename}`);
      await rm(filename, { force: true });
    }
  }
  if (!handle) throw new Error(`Could not acquire Book Forge daemon lock ${filename}`);
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return async () => {
    await handle.close();
    await rm(filename, { force: true });
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
  delayImpl = delay,
  maximumCycleAttempts = Number.POSITIVE_INFINITY,
} = {}) {
  if (acquisitionOnly && !once) throw new Error('Acquisition-only execution must be one shot');
  if (!once && (!Number.isInteger(maximumCycleAttempts) || maximumCycleAttempts < 1) &&
      maximumCycleAttempts !== Number.POSITIVE_INFINITY) {
    throw new TypeError('maximumCycleAttempts must be a positive integer or Infinity');
  }
  const releaseLock = await acquireLock(config);
  const startedAt = new Date().toISOString();
  const heartbeat = async () => {
    const now = new Date().toISOString();
    let catalogError = null;
    try { catalog.updateDaemonState({ pid: process.pid, started_at: startedAt, heartbeat_at: now }); }
    catch (error) { catalogError = error; }
    await writeFile(config.daemonHeartbeatFile, `${JSON.stringify({ pid: process.pid, heartbeatAt: now })}\n`, 'utf8');
    if (catalogError) throw catalogError;
  };
  await heartbeat();
  const heartbeatTimer = setInterval(() => { heartbeat().catch(() => {}); }, 15_000);
  const setPhase = (phase, resourceMode = '') => catalog.updateDaemonState({ phase, resource_mode: resourceMode, heartbeat_at: new Date().toISOString() });
  let governor = null;
  let completedNormally = false;
  try {
    governor = new ResourceGovernor(config, catalog);
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
    try {
      governor?.close();
      if (completedNormally) {
        catalog.updateDaemonState({ phase: 'stopped', heartbeat_at: new Date().toISOString() });
      }
    } finally {
      await releaseLock();
    }
  }
}
