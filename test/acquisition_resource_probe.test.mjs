import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ExplorerAcquisition } from '../src/acquisition.mjs';
import { loadConfig } from '../src/config.mjs';

const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

test('acquisition aborts fail closed when a resource probe throws', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'book-forge-resource-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const config = await loadConfig({ workspace: root });
  config.acquisition.tokenFile = path.join(root, 'token.txt');
  config.acquisition.resourcePollMs = 100;
  config.acquisition.requestTimeoutMs = 2_000;
  await writeFile(config.acquisition.tokenFile, 'synthetic-test-token\n', 'utf8');

  let requestAborted = false;
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      requestAborted = true;
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const acquisition = new ExplorerAcquisition(null, config, { fetchImpl });
  const governor = {
    async permit() {
      throw new Error('resource probe unavailable');
    },
  };

  await assert.rejects(
    acquisition.fetchPosition({ fen: startFen }, governor),
    (error) => {
      assert.equal(error.code, 'BOOK_FORGE_BACKOFF');
      assert.match(error.message, /resource permission probe failed/);
      return true;
    },
  );
  assert.equal(requestAborted, true);
});
