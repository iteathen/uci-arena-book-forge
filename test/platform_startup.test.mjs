import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildLinuxUserUnit,
  linuxUserUnitPath,
} from '../src/platform_startup.mjs';
import { packageRoot } from '../src/config.mjs';

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
