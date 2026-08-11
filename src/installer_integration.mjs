import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAXIMUM_CONTEXT_BYTES = 1024 * 1024;

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireAbsolutePath(value, label) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.normalize(value);
}

export function renderInstallerConfiguration(context) {
  requireObject(context, 'installer context');
  if (context.schema !== 'arena_provider_install_context_v1'
      || context.schema_version !== 1) {
    throw new Error('unsupported installer context');
  }
  const workspace = requireAbsolutePath(context.workspace, 'workspace');
  const bindings = requireObject(context.bindings, 'bindings');
  const locators = requireObject(context.locators ?? {}, 'locators');
  const configuration = {
    schema: 'uci_arena_book_forge_config_v1',
    workspace,
    stockfish: requireAbsolutePath(bindings.stockfish, 'bindings.stockfish'),
  };
  if (locators.lichess_token_path !== undefined) {
    configuration.acquisition = {
      tokenFile: requireAbsolutePath(
        locators.lichess_token_path,
        'locators.lichess_token_path',
      ),
    };
  }
  return {
    schema: 'arena_provider_install_result_v1',
    schema_version: 1,
    configuration,
    generated_documents: [],
  };
}

function readContext(filename) {
  const absolute = requireAbsolutePath(filename, 'context file');
  const metadata = lstatSync(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink()
      || metadata.size < 2 || metadata.size > MAXIMUM_CONTEXT_BYTES) {
    throw new Error('installer context file is not a bounded regular file');
  }
  return JSON.parse(readFileSync(absolute, 'utf8'));
}

function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--context') {
    throw new Error('usage: installer_integration.mjs --context <absolute-json-file>');
  }
  process.stdout.write(`${JSON.stringify(renderInstallerConfiguration(readContext(argv[1])))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Book Forge installer integration failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
