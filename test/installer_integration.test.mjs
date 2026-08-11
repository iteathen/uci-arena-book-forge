import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { renderInstallerConfiguration } from '../src/installer_integration.mjs';

test('installer integration renders only provider-owned Book Forge configuration', () => {
  const root = path.resolve('C:/suite fixture');
  const token = path.join(root, 'operator', 'missing-token.txt');
  const result = renderInstallerConfiguration({
    schema: 'arena_provider_install_context_v1',
    schema_version: 1,
    component: { id: 'book_forge.service', version: '0.4.2', root },
    workspace: path.join(root, 'state', 'book-forge'),
    enabled: true,
    bindings: { stockfish: path.join(root, 'components', 'stockfish.exe') },
    locators: { lichess_token_path: token },
  });

  assert.equal(result.schema, 'arena_provider_install_result_v1');
  assert.deepEqual(result.generated_documents, []);
  assert.equal(result.configuration.workspace, path.join(root, 'state', 'book-forge'));
  assert.equal(result.configuration.stockfish, path.join(root, 'components', 'stockfish.exe'));
  assert.equal(result.configuration.acquisition.tokenFile, token);
});

test('installer integration rejects relative dependency and locator paths', () => {
  const context = {
    schema: 'arena_provider_install_context_v1',
    schema_version: 1,
    workspace: path.resolve('workspace'),
    enabled: true,
    bindings: { stockfish: 'stockfish.exe' },
    locators: {},
  };
  assert.throws(() => renderInstallerConfiguration(context), /absolute path/u);
  context.bindings.stockfish = path.resolve('stockfish.exe');
  context.locators.lichess_token_path = 'token.txt';
  assert.throws(() => renderInstallerConfiguration(context), /absolute path/u);
});
