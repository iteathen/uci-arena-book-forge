import assert from 'node:assert/strict';
import test from 'node:test';
import { main } from '../src/cli.mjs';

test('public startup status branches before Catalog construction or migration', async () => {
  let opened = 0;
  let output;
  const config = { workspace: 'owned fixture', configFile: 'owned fixture configuration' };
  const inspected = { installed: true, enabled: true, active: null,
    activityState: 'unverifiable', matchesCurrentConfiguration: false };
  await main({ argv: ['startup', 'status', '--workspace', 'owned fixture'],
    loadConfigImpl: async () => config,
    configureIdentityImpl: async selected => { assert.equal(selected, config); },
    CatalogImpl: class {
      constructor() { opened++; throw Error('Catalog migration must not run'); }
    },
    queryStartupImpl: async selected => { assert.equal(selected, config); return inspected; },
    readStartupEvidenceImpl: async () => null,
    outputImpl: value => { output = value; },
  });
  assert.equal(opened, 0);
  assert.equal(output.startup.active, null);
  assert.equal(output.startup.activityState, 'unverifiable');
});

test('neutral lifecycle dispatch never constructs or migrates Catalog; closed operation/root arguments', async () => {
  let output; let called = 0;
  const dependencies = { loadConfigImpl: async () => ({ workspace: 'fixture' }),
    configureIdentityImpl: async () => {}, CatalogImpl: class { constructor() { throw Error('Catalog must not open'); } },
    lifecycleImpl: async (_config, request) => { called++; return { operation: request.operation, disposition: 'failed' }; },
    outputImpl: value => { output = value; } };
  await main({ ...dependencies, argv: ['lifecycle', 'pre_replace', '--workspace', 'fixture', '--previous-root', 'A', '--replacement-root', 'B'] });
  assert.equal(output.operation, 'pre_replace');
  assert.equal(called, 1);
  await assert.rejects(main({ ...dependencies, argv: ['lifecycle', 'install', '--previous-root', 'A', '--replacement-root', 'B'] }));
  await assert.rejects(main({ ...dependencies, argv: ['lifecycle', 'post_replace', '--previous-root', 'A'] }));
  await assert.rejects(main({ ...dependencies, argv: ['lifecycle', 'install', '--arbitrary', 'value'] }));
  await assert.rejects(main({ ...dependencies, argv: ['lifecycle', 'install', '--workspace', 'A', '--workspace', 'B'] }));
  assert.equal(called, 1);
});
