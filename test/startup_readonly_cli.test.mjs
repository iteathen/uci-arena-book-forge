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
