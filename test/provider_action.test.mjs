import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWindowsArguments, bindWindowsTaskToRoot } from '../src/provider_action.mjs';
import { quoteWindowsArgument } from '../src/windows_startup.mjs';

test('retained Windows argument grammar roundtrips spaces, quotes and trailing slashes', () => {
  const values = ['--restart', 'C:\\Node Root\\node.exe', 'C:\\Root\\a"b\\', '', 'trailing\\'];
  assert.deepEqual(parseWindowsArguments(values.map(quoteWindowsArgument).join(' ')), values);
  assert.throws(() => parseWindowsArguments('"unfinished'), /task action admission failed/);
});

const descriptor = { schema: 'uci_arena_book_component_root_v1',
  launcher: 'C:\\Old Book Root\\native\\launcher.exe', cli: 'C:\\Old Book Root\\src\\cli.mjs',
  packageRoot: 'C:\\Old Book Root' };
const config = { workspace: 'C:\\Fixture Workspace', configFile: 'C:\\Fixture Workspace\\config.json' };
const node = 'C:\\Managed Node\\node.exe';
const observation = () => ({ registered: true, action: { command: descriptor.launcher,
  arguments: ['--restart', node, descriptor.cli, 'daemon', '--workspace', config.workspace,
    '--config', config.configFile].map(quoteWindowsArgument).join(' '), working_directory: descriptor.packageRoot } });

test('root action admission retains exact original Node and raw typed tuple', () => {
  const original = observation();
  const binding = bindWindowsTaskToRoot(original, descriptor, config);
  assert.equal(binding.nodeExecutable, node);
  assert.deepEqual(binding.action, original.action);
  assert.equal(Object.isFrozen(binding), true);
  assert.equal(Object.isFrozen(binding.action), true);
});

test('root, workspace, runtime, extra option and foreground-launch substitutions reject', () => {
  for (const mutate of [
    value => { value.action.command = 'C:\\Foreign\\launcher.exe'; },
    value => { value.action.working_directory = 'C:\\Foreign'; },
    value => { value.action.arguments += ' --detach'; },
    value => { value.action.arguments = value.action.arguments.replace('--restart', '--other'); },
    value => { value.action.arguments = value.action.arguments.replace('C:\\Managed Node\\node.exe', 'relative.exe'); },
    value => { value.action.arguments = value.action.arguments.replace('C:\\Fixture Workspace', 'C:\\Foreign Workspace'); },
    value => { value.action.arguments = value.action.arguments.replace(descriptor.cli, 'C:\\Foreign\\cli.mjs'); },
  ]) {
    const original = observation(); mutate(original);
    assert.throws(() => bindWindowsTaskToRoot(original, descriptor, config), /task action admission failed/);
  }
});
