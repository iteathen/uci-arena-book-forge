import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { packageRoot } from './config.mjs';
import {
  installWindowsStartup,
  queryWindowsStartup,
  readStartupEvidence as readWindowsStartupEvidence,
  uninstallWindowsStartup,
} from './windows_startup.mjs';

const execFileAsync = promisify(execFile);
export const linuxUnitName = 'uci-arena-book-forge.service';
const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url));

function systemdQuote(value) {
  const text = String(value);
  if (/[\r\n\0]/.test(text)) throw new Error('systemd arguments cannot contain control lines');
  return `"${text.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function linuxUserUnitPath(environment = process.env) {
  const configRoot = environment.XDG_CONFIG_HOME?.trim()
    || path.join(os.homedir(), '.config');
  return path.join(configRoot, 'systemd', 'user', linuxUnitName);
}

export function buildLinuxUserUnit(config) {
  const values = [
    path.resolve(process.execPath),
    cliPath,
    'daemon',
    '--workspace',
    config.workspace,
  ];
  if (config.configFile) values.push('--config', config.configFile);
  return `[Unit]
Description=UCI Arena Book Forge
After=default.target

[Service]
Type=simple
ExecStart=${values.map(systemdQuote).join(' ')}
WorkingDirectory=${systemdQuote(packageRoot)}
Restart=on-failure
RestartSec=60
Nice=15
CPUWeight=10
IOWeight=10
OOMScoreAdjust=500
UMask=0077
KillMode=control-group
TimeoutStopSec=2
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}

async function queryLinuxStartup() {
  const unitPath = linuxUserUnitPath();
  if (!existsSync(unitPath)) {
    return { platform: 'linux', installed: false, unitName: linuxUnitName, unitPath };
  }
  let enabled = false;
  let active = false;
  try {
    await execFileAsync('systemctl', ['--user', 'is-enabled', '--quiet', linuxUnitName],
      { timeout: 10_000 });
    enabled = true;
  } catch {}
  try {
    await execFileAsync('systemctl', ['--user', 'is-active', '--quiet', linuxUnitName],
      { timeout: 10_000 });
    active = true;
  } catch {}
  return { platform: 'linux', installed: true, enabled, active, unitName: linuxUnitName, unitPath };
}

async function installLinuxStartup(config) {
  const unitPath = linuxUserUnitPath();
  await mkdir(path.dirname(unitPath), { recursive: true });
  await writeFile(unitPath, buildLinuxUserUnit(config), 'utf8');
  await execFileAsync('systemctl', ['--user', 'daemon-reload'], { timeout: 10_000 });
  await execFileAsync('systemctl', ['--user', 'enable', '--now', linuxUnitName],
    { timeout: 20_000 });
  const evidence = {
    schema: 'uci_arena_book_forge_startup_v2',
    platform: 'linux',
    unitName: linuxUnitName,
    unitPath,
    workspace: config.workspace,
    installedAt: new Date().toISOString(),
  };
  await writeFile(path.join(config.workspace, 'startup-task.json'),
    `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return queryLinuxStartup();
}

async function uninstallLinuxStartup(config) {
  try {
    await execFileAsync('systemctl', ['--user', 'disable', '--now', linuxUnitName],
      { timeout: 20_000 });
  } catch {}
  await rm(linuxUserUnitPath(), { force: true });
  await execFileAsync('systemctl', ['--user', 'daemon-reload'], { timeout: 10_000 });
  await rm(path.join(config.workspace, 'startup-task.json'), { force: true });
  return { platform: 'linux', installed: false, unitName: linuxUnitName };
}

export async function queryStartup(config) {
  if (process.platform === 'win32') return queryWindowsStartup(config);
  if (process.platform === 'linux') return queryLinuxStartup(config);
  throw new Error(`Book Forge startup registration is unsupported on ${process.platform}`);
}

export async function installStartup(config) {
  if (process.platform === 'win32') return installWindowsStartup(config);
  if (process.platform === 'linux') return installLinuxStartup(config);
  throw new Error(`Book Forge startup registration is unsupported on ${process.platform}`);
}

export async function uninstallStartup(config) {
  if (process.platform === 'win32') return uninstallWindowsStartup(config);
  if (process.platform === 'linux') return uninstallLinuxStartup(config);
  throw new Error(`Book Forge startup registration is unsupported on ${process.platform}`);
}

export async function readStartupEvidence(config) {
  if (process.platform === 'win32') return readWindowsStartupEvidence(config);
  try {
    return JSON.parse(await readFile(path.join(config.workspace, 'startup-task.json'), 'utf8'));
  } catch {
    return null;
  }
}
