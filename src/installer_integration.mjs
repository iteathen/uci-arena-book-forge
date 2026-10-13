import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from './config.mjs';

const MAXIMUM_CONTEXT_BYTES = 1024 * 1024;

function retainedOperatingSettings(workspace) {
  const filename = path.join(workspace, 'manager-config.json');
  let before;
  try { before = lstatSync(filename); } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  function admit() {
    let cursor = path.parse(filename).root;
    for (const part of filename.slice(cursor.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      const metadata = lstatSync(cursor);
      if (metadata.isSymbolicLink() || (cursor !== filename && !metadata.isDirectory())) {
        throw new Error('Retained configuration has a linked or invalid ancestor');
      }
    }
    const metadata = lstatSync(filename);
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAXIMUM_CONTEXT_BYTES) {
      throw new Error('Retained configuration must be a bounded regular file');
    }
    return metadata;
  }
  if (!same(before, admit())) throw new Error('Retained configuration changed during admission');
  const fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    | (constants.O_NONBLOCK ?? 0));
  let configuration;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !same(before, opened)) throw new Error('Retained configuration changed during admission');
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error('Retained configuration ended during admission');
      offset += count;
    }
    if (!same(opened, fstatSync(fd)) || !same(opened, admit())) {
      throw new Error('Retained configuration changed during admission');
    }
    configuration = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { closeSync(fd); }
  resolveConfig({ configuration, configFile: filename, workspace });
  // Only service-owned operator tuning survives refresh. Selected workspace,
  // executable, helper, policy, and credential bindings are composed anew.
  return Object.fromEntries(['resources', 'analysis'].filter(name => Object.hasOwn(configuration, name))
    .map(name => [name, structuredClone(configuration[name])]));
}

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
    ...retainedOperatingSettings(workspace),
  };
  if (locators.lichess_token_path !== undefined) {
    configuration.acquisition = {
      tokenFile: requireAbsolutePath(
        locators.lichess_token_path,
        'locators.lichess_token_path',
      ),
    };
  }
  resolveConfig({ configuration, configFile: path.join(workspace, 'manager-config.json'), workspace });
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
