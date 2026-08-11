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
} from '../src/windows_startup.mjs';

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

test('Windows startup inspection treats omitted default Enabled values as true', {
  skip: process.platform !== 'win32',
}, async () => {
  const config = {
    workspace: 'C:\\Arena Workspaces\\Book Forge',
    configFile: 'C:\\Arena Config\\book-forge.json',
    nativeLauncher: 'C:\\Arena Suite\\book-forge\\launcher.exe',
  };
  const normalizedXml = buildTaskXml(config, 'S-1-5-21-1-2-3-1001')
    .replaceAll('    <Enabled>true</Enabled>\n', '');
  const status = await queryWindowsStartup(config, {
    execFileImpl: async () => ({ stdout: normalizedXml }),
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
  const disabledXml = buildTaskXml(config, 'S-1-5-21-1-2-3-1001')
    .replace('<Enabled>true</Enabled>', '<Enabled>false</Enabled>');
  const status = await queryWindowsStartup(config, {
    execFileImpl: async () => ({ stdout: disabledXml }),
  });

  assert.equal(status.installed, true);
  assert.equal(status.enabled, false);
  assert.equal(status.matchesCurrentConfiguration, true);
});
