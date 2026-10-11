import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildLinuxUserUnit,
  linuxUserUnitPath,
} from '../src/platform_startup.mjs';
import { packageRoot } from '../src/config.mjs';
import {
  buildTaskXml,
  queryWindowsStartup,
  startupAction,
} from '../src/windows_startup.mjs';

test('Task0 and current legacy PID presence remain separate from daemon activity', {
  skip: process.platform !== 'win32',
}, async () => {
  const config = { workspace: 'C:\\Owned Fixture Workspace', nativeLauncher: 'C:\\Owned Fixture\\launcher.exe' };
  const action = startupAction(config);
  const result = await queryWindowsStartup(config, {
    taskScheduler: { perform: async () => ({ outcome: 'completed', observation: {
      registered: true, enabled: true, instance_guids: [], action: { command: action.command,
        arguments: action.arguments, working_directory: action.workingDirectory } } }) },
    activityImpl: async () => ({ state: 'unverifiable', active: null, ownerLive: null }),
    drainImpl: async () => ({ state: 'present', authority: 'current-incarnation-at-record-pid-only',
      currentIncarnation: null }),
  });
  assert.equal(result.serviceManagerActive, false);
  assert.equal(result.active, null);
  assert.equal(result.ownerLive, null);
  assert.equal(result.drainObstacle.state, 'present');
});

test('Linux startup unit is per-user, relocatable, and least privilege', () => {
  const config = {
    workspace: '/srv/arena workspaces/book forge',
    configFile: '/srv/arena config/book-forge.json',
  };
  const unit = buildLinuxUserUnit(config);
  assert.match(unit, /Description=UCI Arena Book Forge/);
  assert.match(unit, /NoNewPrivileges=true/);
  assert.match(unit, /KillMode=control-group/);
  assert.ok(unit.includes(
    `WorkingDirectory="${packageRoot.replaceAll('\\', '\\\\')}"`,
  ));
  assert.doesNotMatch(unit, /lichess_bot_token/);
});

test('Linux startup unit path honors XDG_CONFIG_HOME', () => {
  assert.equal(
    linuxUserUnitPath({ XDG_CONFIG_HOME: '/tmp/arena-config' }),
    path.join('/tmp/arena-config', 'systemd', 'user', 'uci-arena-book-forge.service'),
  );
  assert.equal(
    path.basename(linuxUserUnitPath({})),
    'uci-arena-book-forge.service',
  );
  assert.ok(os.homedir());
});

test('Windows startup inspection retains the qualified platform default Enabled value', {
  skip: process.platform !== 'win32',
}, async () => {
  const config = {
    workspace: 'C:\\Arena Workspaces\\Book Forge',
    configFile: 'C:\\Arena Config\\book-forge.json',
    nativeLauncher: 'C:\\Arena Suite\\book-forge\\launcher.exe',
  };
  const action = startupAction(config);
  const status = await queryWindowsStartup(config, {
    taskScheduler: { perform: async () => ({ outcome: 'completed', observation: {
      registered: true, enabled: true, instance_guids: [], action: {
        command: action.command, arguments: action.arguments, working_directory: action.workingDirectory } } }) },
  });

  assert.equal(status.installed, true);
  assert.equal(status.enabled, true);
  assert.equal(status.matchesCurrentConfiguration, true);
});

test('Windows startup inspection preserves an explicit disabled value', {
  skip: process.platform !== 'win32',
}, async () => {
  const config = {
    workspace: 'C:\\Arena Workspaces\\Book Forge',
    configFile: 'C:\\Arena Config\\book-forge.json',
    nativeLauncher: 'C:\\Arena Suite\\book-forge\\launcher.exe',
  };
  const action = startupAction(config);
  const status = await queryWindowsStartup(config, {
    taskScheduler: { perform: async () => ({ outcome: 'completed', observation: {
      registered: true, enabled: false, instance_guids: [], action: {
        command: action.command, arguments: action.arguments, working_directory: action.workingDirectory } } }) },
  });

  assert.equal(status.installed, true);
  assert.equal(status.enabled, false);
  assert.equal(status.matchesCurrentConfiguration, true);
});

test('Windows startup activity is an independent producer observation', {
  skip: process.platform !== 'win32',
}, async () => {
  const config = {
    workspace: 'C:\\Arena Fixtures\\Book Forge',
    nativeLauncher: 'C:\\Arena Fixtures\\launcher.exe',
  };
  const action = startupAction(config);
  for (const [state, active] of [['active', true], ['inactive', false], ['unverifiable', null]]) {
    const status = await queryWindowsStartup(config, {
      taskScheduler: { perform: async () => ({ outcome: 'completed', observation: {
        registered: true, enabled: true, instance_guids: [], action: {
          command: action.command, arguments: action.arguments, working_directory: action.workingDirectory } } }) },
      activityImpl: async () => ({ state, active }),
    });
    assert.equal(status.installed, true);
    assert.equal(status.matchesCurrentConfiguration, true);
    assert.equal(status.activityState, state);
    assert.equal(status.active, active);
    assert.equal(Object.hasOwn(status, 'started'), false);
  }
});
