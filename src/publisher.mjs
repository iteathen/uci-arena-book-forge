import { cp, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { validateSnapshot } from './compiler.mjs';

export async function publishSnapshot(catalog, config, snapshotDirectory, channel) {
  if (!['integration', 'qualified'].includes(channel)) throw new Error(`Unknown channel: ${channel}`);
  const source = await validateSnapshot(snapshotDirectory);
  if (source.channel !== channel || source.qualified !== (channel === 'qualified')) throw new Error(`Snapshot ${source.id} is not valid for channel ${channel}`);
  if (channel === 'qualified' && source.includesFixture) throw new Error('Fixture evidence cannot enter the qualified channel');
  catalog.addSnapshot({ id: source.id, channel, directory: path.resolve(snapshotDirectory), recordCount: source.recordCount,
    includesFixture: source.includesFixture, qualified: source.qualified, manifestSha256: source.manifestSha256 });
  const destination = path.join(config.paths.published, channel);
  const current = catalog.channel(channel);
  if (current?.snapshot_id === source.id) {
    try {
      await validateSnapshot(destination);
      return { channel, snapshotId: source.id, directory: destination, previous: null, unchanged: true };
    } catch {}
  }
  const incoming = path.join(config.paths.published, `.${channel}.${source.id}.${process.pid}.incoming`);
  const historyRoot = path.join(config.paths.published, 'history', channel);
  const previous = path.join(historyRoot, `previous-${Date.now()}`);
  await mkdir(historyRoot, { recursive: true });
  await rm(incoming, { recursive: true, force: true });
  await cp(path.resolve(snapshotDirectory), incoming, { recursive: true, errorOnExist: true });
  await validateSnapshot(incoming);
  let movedPrevious = false;
  try {
    try {
      await rename(destination, previous);
      movedPrevious = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await rename(incoming, destination);
    await validateSnapshot(destination);
    catalog.setChannel(channel, source.id, destination);
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    if (movedPrevious) await rename(previous, destination);
    await rm(incoming, { recursive: true, force: true });
    throw error;
  }
  return { channel, snapshotId: source.id, directory: destination, previous: movedPrevious ? previous : null };
}
