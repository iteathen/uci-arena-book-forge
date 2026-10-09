import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { runBookLifecycle } from '../src/provider_command.mjs';
import { lifecycleResult } from '../src/provider_lifecycle.mjs';

test('neutral ready result has exact identity/observations and omits unsupported null reason', () => {
  const result = lifecycleResult('pre_replace', '0.4.9', 'ready', {
    installation: 'installed', activity: 'inactive', configuration: 'matches', replacement: 'safe' });
  assert.deepEqual(Object.keys(result), ['schema', 'schema_version', 'component_id', 'component_version', 'operation', 'disposition', 'observed']);
  assert.equal(result.schema, 'arena_provider_lifecycle_result_v1');
  assert.equal(result.component_id, 'book_forge.service');
  assert.equal(result.operation, 'pre_replace');
});

test('unsupported platform and malformed root requests fail before platform effects; no extra result fields', async () => {
  let opened = 0;
  const root = path.join(os.tmpdir(), 'book-protocol-fixture');
  const config = { workspace: root };
  const options = { platformFactory: () => { opened++; throw Error('Must not execute'); }, userSid: async () => 'S-1-5-21-123', root };
  const unsupported = await runBookLifecycle(config, { operation: 'install' }, { ...options, platform: 'linux' });
  assert.equal(unsupported.disposition, 'failed');
  assert.equal(unsupported.reason.id, 'book_lifecycle_platform');
  const malformed = await runBookLifecycle(config, { operation: 'post_replace', previousRoot: 'relative', replacementRoot: root },
    { ...options, platform: 'win32' });
  assert.equal(malformed.disposition, 'failed');
  assert.equal(opened, 0);
  assert.equal(malformed.reason.message.includes(root), false);
  await assert.rejects(runBookLifecycle(config, { operation: 'unknown' }, options));
});
