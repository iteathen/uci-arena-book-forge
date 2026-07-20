import { open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ExplorerAcquisition } from './acquisition.mjs';
import { buildSnapshot } from './compiler.mjs';
import { discoverInbox, ingestSource } from './ingest.mjs';
import { runMaintenance } from './maintenance.mjs';
import { publishSnapshot } from './publisher.mjs';
import { ResourceGovernor } from './resource_governor.mjs';
import { analyzeObservations } from './stockfish.mjs';

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

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
    acquisitionOnly = false) {
  const initialPermit = await governor.permit();
  const report = { acquisition: null, discovered: [], ingested: [], integration: null, analysis: null, qualified: null, maintenance: null, resource: initialPermit };
  if (!initialPermit.allowed) {
    report.acquisition = { enabled: config.acquisition.enabled, requests: 0, positions: 0, moves: 0, stopped: initialPermit.reason };
    report.analysis = { positions: 0, moves: 0, skipped: true, reason: initialPermit.reason };
    report.maintenance = { skipped: true, reason: initialPermit.reason };
    return report;
  }
  setPhase('acquisition', initialPermit.mode);
  report.acquisition = await acquisition.run(governor, { maxRequests: acquisitionMaxRequests });
  if (acquisitionOnly) return report;
  setPhase('ingestion', report.resource.mode);
  report.discovered = await discoverInbox(catalog, config, governor);
  for (const source of catalog.pendingSources()) {
    const permit = await governor.permit();
    report.resource = permit;
    if (!permit.allowed) break;
    try {
      const telemetry = await ingestSource(catalog, source, config, governor);
      report.ingested.push({ sourceId: Number(source.id), ...telemetry });
      if (telemetry.interrupted) break;
    } catch (error) {
      report.ingested.push({ sourceId: Number(source.id), error: error.message });
    }
  }
  const localReady = catalog.completedSources().some((source) => source.contribution_mode === 'additive');
  const remoteReady = config.acquisition.enabled && catalog.hasPublishableObservations() && acquisitionBootstrapReady(catalog, config);
  if (config.channels.integration && (localReady || remoteReady) && integrationBuildDue(catalog, config, report)) {
    setPhase('publication', report.resource.mode);
    try {
      const snapshot = await buildSnapshot(catalog, config, 'integration');
      report.integration = await publishSnapshot(catalog, config, snapshot.directory, 'integration');
      catalog.setMetadata('last_integration_build_at', new Date().toISOString());
    } catch (error) {
      report.integration = { blocked: true, reason: error.message };
    }
  }
  setPhase('analysis', report.resource.mode);
  report.analysis = await analyzeObservations(catalog, config, governor);
  if (config.channels.qualified && catalog.hasPublishableObservations({ includeFixtures: false })) {
    setPhase('publication', report.resource.mode);
    try {
      const snapshot = await buildSnapshot(catalog, config, 'qualified');
      report.qualified = await publishSnapshot(catalog, config, snapshot.directory, 'qualified');
    } catch (error) {
      report.qualified = { blocked: true, reason: error.message };
    }
  }
  setPhase('maintenance', report.resource.mode);
  const maintenancePermit = await governor.permit();
  if (maintenancePermit.allowed) report.maintenance = await runMaintenance(catalog, config);
  else report.maintenance = { skipped: true, reason: maintenancePermit.reason };
  return report;
}

export async function runDaemon(catalog, config, { once = false, acquisitionMaxRequests = undefined, acquisitionOnly = false } = {}) {
  if (acquisitionOnly && !once) throw new Error('Acquisition-only execution must be one shot');
  const releaseLock = await acquireLock(config);
  const startedAt = new Date().toISOString();
  const heartbeat = async () => {
    const now = new Date().toISOString();
    catalog.updateDaemonState({ pid: process.pid, started_at: startedAt, heartbeat_at: now });
    await writeFile(config.daemonHeartbeatFile, `${JSON.stringify({ pid: process.pid, heartbeatAt: now })}\n`, 'utf8');
  };
  await heartbeat();
  const heartbeatTimer = setInterval(() => { heartbeat().catch(() => {}); }, 15_000);
  const setPhase = (phase, resourceMode = '') => catalog.updateDaemonState({ phase, resource_mode: resourceMode, heartbeat_at: new Date().toISOString() });
  const governor = new ResourceGovernor(config, catalog);
  const acquisition = new ExplorerAcquisition(catalog, config);
  try {
    let lastReport = null;
    do {
      catalog.updateDaemonState({ cycle_started_at: new Date().toISOString(), last_error: '' });
      lastReport = await runCycle(catalog, config, governor, acquisition, setPhase, acquisitionMaxRequests, acquisitionOnly);
      catalog.updateDaemonState({ cycle_completed_at: new Date().toISOString(), last_report: lastReport });
      if (!once) { setPhase('sleep', governor.last.mode); await delay(60_000); }
    } while (!once);
    return lastReport;
  } catch (error) {
    catalog.updateDaemonState({ phase: 'failed', heartbeat_at: new Date().toISOString(), last_error: error.message });
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
    governor.close();
    if (once) catalog.updateDaemonState({ phase: 'stopped', heartbeat_at: new Date().toISOString() });
    await releaseLock();
  }
}
