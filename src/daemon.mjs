import { open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
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

export async function runCycle(catalog, config, governor = new ResourceGovernor(config, catalog)) {
  const initialPermit = await governor.permit();
  const report = { discovered: [], ingested: [], integration: null, analysis: null, qualified: null, maintenance: null, resource: initialPermit };
  if (!initialPermit.allowed) {
    report.analysis = { positions: 0, moves: 0, skipped: true, reason: initialPermit.reason };
    report.maintenance = { skipped: true, reason: initialPermit.reason };
    return report;
  }
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
  if (config.channels.integration && catalog.completedSources().length) {
    try {
      const snapshot = await buildSnapshot(catalog, config, 'integration');
      report.integration = await publishSnapshot(catalog, config, snapshot.directory, 'integration');
    } catch (error) {
      report.integration = { blocked: true, reason: error.message };
    }
  }
  report.analysis = await analyzeObservations(catalog, config, governor);
  if (config.channels.qualified && catalog.completedSources().some((source) => !source.fixture)) {
    try {
      const snapshot = await buildSnapshot(catalog, config, 'qualified');
      report.qualified = await publishSnapshot(catalog, config, snapshot.directory, 'qualified');
    } catch (error) {
      report.qualified = { blocked: true, reason: error.message };
    }
  }
  const maintenancePermit = await governor.permit();
  if (maintenancePermit.allowed) report.maintenance = await runMaintenance(catalog, config);
  else report.maintenance = { skipped: true, reason: maintenancePermit.reason };
  return report;
}

export async function runDaemon(catalog, config, { once = false } = {}) {
  const releaseLock = await acquireLock(config);
  const governor = new ResourceGovernor(config, catalog);
  try {
    const reports = [];
    do {
      reports.push(await runCycle(catalog, config, governor));
      if (!once) await delay(60_000);
    } while (!once);
    return reports.at(-1);
  } finally {
    governor.close();
    await releaseLock();
  }
}
