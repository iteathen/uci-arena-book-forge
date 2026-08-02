import { lstat, realpath, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

async function assertOwnedDirectory(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Unsafe maintenance target: ${target}`);
  const details = await lstat(target);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`Unsafe non-directory maintenance target: ${target}`);
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  const realRelative = path.relative(realRoot, realTarget);
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error(`Maintenance target escapes its owned root: ${target}`);
  }
}

function cutoffMonth(retentionMonths) {
  const date = new Date();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - retentionMonths);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function maintenanceDue(catalog, config) {
  const last = catalog.metadata('last_maintenance_at');
  if (!last) return true;
  const timestamp = Date.parse(last);
  return !Number.isFinite(timestamp) || Date.now() - timestamp >= config.maintenance.intervalDays * 86_400_000;
}

export async function runMaintenance(catalog, config, { force = false } = {}) {
  const compactionDue = force || maintenanceDue(catalog, config);
  const compacted = compactionDue
    ? catalog.compactOldObservations(cutoffMonth(config.maintenance.detailedCohortRetentionMonths))
    : null;
  const currentIds = new Set(['integration', 'qualified'].map((channel) => catalog.channel(channel)?.snapshot_id).filter(Boolean));
  const keptByChannel = new Map();
  let snapshotsPruned = 0;
  for (const snapshot of catalog.snapshotRows()) {
    const kept = keptByChannel.get(snapshot.channel) ?? 0;
    if (currentIds.has(snapshot.id) || kept < config.maintenance.snapshotVersionsPerChannel) {
      keptByChannel.set(snapshot.channel, kept + 1);
      continue;
    }
    await assertOwnedDirectory(config.paths.snapshots, snapshot.directory);
    await rm(snapshot.directory, { recursive: true, force: true });
    catalog.deleteSnapshot(snapshot.id);
    snapshotsPruned += 1;
  }
  let historyPruned = 0;
  for (const channel of ['integration', 'qualified']) {
    const root = path.join(config.paths.published, 'history', channel);
    let entries = [];
    try { entries = await readdir(root, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    for (const name of directories.slice(config.maintenance.snapshotVersionsPerChannel)) {
      const target = path.join(root, name);
      await assertOwnedDirectory(root, target);
      await rm(target, { recursive: true, force: true });
      historyPruned += 1;
    }
  }
  const completedAt = new Date().toISOString();
  if (compactionDue) catalog.setMetadata('last_maintenance_at', completedAt);
  const skipped = !compactionDue && snapshotsPruned === 0 && historyPruned === 0;
  return {
    skipped,
    reason: skipped ? 'interval_not_due' : undefined,
    completedAt,
    compacted,
    snapshotsPruned,
    historyPruned,
  };
}
