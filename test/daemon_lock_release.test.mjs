import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Catalog } from '../src/catalog.mjs';
import { loadConfig } from '../src/config.mjs';
import { runDaemon } from '../src/daemon.mjs';

test('daemon lock is released when the final stopped-state projection fails', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'book-forge-daemon-lock-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const config = await loadConfig({ workspace });
  const catalog = new Catalog(config);
  t.after(() => catalog.close());
  const updateDaemonState = catalog.updateDaemonState.bind(catalog);
  catalog.updateDaemonState = (update) => {
    if (update.phase === 'stopped') {
      throw new Error('synthetic final state failure');
    }
    return updateDaemonState(update);
  };

  await assert.rejects(
    runDaemon(catalog, config, {
      once: true,
      cycleRunner: async () => ({ completed: true }),
    }),
    /synthetic final state failure/,
  );

  const lockPath = path.join(config.paths.locks, 'daemon.lock');
  assert.equal(existsSync(lockPath), false);

  catalog.updateDaemonState = updateDaemonState;
  const result = await runDaemon(catalog, config, {
    once: true,
    cycleRunner: async () => ({ reacquired: true }),
  });
  assert.deepEqual(result, { reacquired: true });
  assert.equal(existsSync(lockPath), false);
});
