import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { packageRoot } from './config.mjs';

const execFileAsync = promisify(execFile);
export const startupTaskName = 'UCI Arena Book Forge';
const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url));

function requireWindows() {
  if (process.platform !== 'win32') throw new Error('Book Forge startup registration is supported only on Windows');
}

function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function quoteWindowsArgument(value) {
  const text = String(value);
  if (!text.length) return '""';
  if (!/[\s"]/.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

export function startupAction(config) {
  const argumentsList = ['--restart', path.resolve(process.execPath), cliPath, 'daemon', '--workspace', config.workspace];
  if (config.configFile) argumentsList.push('--config', config.configFile);
  return {
    command: path.resolve(config.nativeLauncher),
    arguments: argumentsList.map(quoteWindowsArgument).join(' '),
    workingDirectory: packageRoot,
  };
}

export function buildTaskXml(config, userSid) {
  if (!/^S-\d(?:-\d+)+$/.test(userSid)) throw new Error(`Invalid Windows user SID: ${userSid}`);
  const action = startupAction(config);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Continuously improves and publishes UCI Arena opening-book snapshots.</Description>
    <URI>\\${startupTaskName}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <Delay>PT15S</Delay>
      <UserId>${xmlEscape(userSid)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(userSid)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>true</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(action.command)}</Command>
      <Arguments>${xmlEscape(action.arguments)}</Arguments>
      <WorkingDirectory>${xmlEscape(action.workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

async function currentUserSid() {
  const { stdout } = await execFileAsync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 5_000 });
  const match = /"[^"]+","(S-\d(?:-\d+)+)"/.exec(stdout.trim());
  if (!match) throw new Error('Could not determine the current Windows user SID');
  return match[1];
}

function decodeXmlValue(xml, tag) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (!match) return null;
  return match[1].replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<').replaceAll('&amp;', '&');
}

export async function queryWindowsStartup(config, { execFileImpl = execFileAsync } = {}) {
  requireWindows();
  try {
    const { stdout } = await execFileImpl('schtasks.exe', ['/Query', '/TN', startupTaskName, '/XML'], {
      windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    const expected = startupAction(config);
    const actual = {
      command: decodeXmlValue(stdout, 'Command'),
      arguments: decodeXmlValue(stdout, 'Arguments'),
      workingDirectory: decodeXmlValue(stdout, 'WorkingDirectory'),
    };
    const enabledValues = [...stdout.matchAll(/<Enabled>(true|false)<\/Enabled>/giu)].map((match) => match[1] === 'true');
    return { platform: 'windows', installed: true, enabled: enabledValues.length > 0 && enabledValues.every(Boolean), taskName: startupTaskName, action: actual,
      matchesCurrentConfiguration: actual.command === expected.command && actual.arguments === expected.arguments && actual.workingDirectory === expected.workingDirectory };
  } catch (error) {
    if (error.code === 1) return { platform: 'windows', installed: false, enabled: false, taskName: startupTaskName, matchesCurrentConfiguration: false };
    throw new Error(`Could not query Windows startup task: ${error.stderr?.trim() || error.message}`);
  }
}

export async function installWindowsStartup(config) {
  requireWindows();
  if (!config.nativeLauncherAvailable) {
    throw new Error(`Book Forge windowless launcher is unavailable: ${config.nativeLauncher}`);
  }
  const userSid = await currentUserSid();
  const taskXml = buildTaskXml(config, userSid);
  const temporaryXml = path.join(config.paths.locks, `startup-task-${process.pid}.xml`);
  const evidencePath = path.join(config.workspace, 'startup-task.json');
  const encodedXml = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml, 'utf16le')]);
  await writeFile(temporaryXml, encodedXml);
  try {
    await execFileAsync('schtasks.exe', ['/Create', '/TN', startupTaskName, '/XML', temporaryXml, '/F'], {
      windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`Could not install Windows startup task: ${error.stderr?.trim() || error.stdout?.trim() || error.message}`);
  } finally {
    await rm(temporaryXml, { force: true });
  }
  const status = await queryWindowsStartup(config);
  if (!status.installed || !status.matchesCurrentConfiguration) throw new Error('Windows accepted the startup task but its registered action does not match Book Forge');
  const evidence = { schema: 'uci_arena_book_forge_startup_v2', taskName: startupTaskName, userSid,
    action: startupAction(config), workspace: config.workspace, installedAt: new Date().toISOString() };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  try {
    await execFileAsync('schtasks.exe', ['/Run', '/TN', startupTaskName], { windowsHide: true, timeout: 10_000 });
  } catch (error) {
    throw new Error(`Startup task was installed but could not be started: ${error.stderr?.trim() || error.stdout?.trim() || error.message}`);
  }
  return { ...status, started: true, evidencePath };
}

export async function startWindowsStartup(config, {
  queryImpl = queryWindowsStartup,
  execFileImpl = execFileAsync,
} = {}) {
  requireWindows();
  const registered = await queryImpl(config);
  if (!registered.installed) throw new Error(`Book Forge startup task is not registered: ${startupTaskName}`);
  try {
    await execFileImpl('schtasks.exe', ['/Run', '/TN', startupTaskName], {
      windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`Could not start Windows startup task: ${error.stderr?.trim() || error.stdout?.trim() || error.message}`);
  }
  return { ...(await queryImpl(config)), startRequested: true };
}

export async function stopWindowsStartup(config, {
  queryImpl = queryWindowsStartup,
  execFileImpl = execFileAsync,
} = {}) {
  requireWindows();
  const registered = await queryImpl(config);
  if (!registered.installed) throw new Error(`Book Forge startup task is not registered: ${startupTaskName}`);
  try {
    await execFileImpl('schtasks.exe', ['/End', '/TN', startupTaskName], {
      windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    if (error.code !== 1) {
      throw new Error(`Could not stop Windows startup task: ${error.stderr?.trim() || error.stdout?.trim() || error.message}`);
    }
  }
  return { ...(await queryImpl(config)), stopRequested: true };
}

export async function uninstallWindowsStartup(config) {
  requireWindows();
  try { await execFileAsync('schtasks.exe', ['/End', '/TN', startupTaskName], { windowsHide: true, timeout: 10_000 }); } catch {}
  try {
    await execFileAsync('schtasks.exe', ['/Delete', '/TN', startupTaskName, '/F'], { windowsHide: true, timeout: 10_000 });
  } catch (error) {
    if (error.code !== 1) throw new Error(`Could not uninstall Windows startup task: ${error.stderr?.trim() || error.message}`);
  }
  await rm(path.join(config.workspace, 'startup-task.json'), { force: true });
  return { installed: false, taskName: startupTaskName };
}

export async function readStartupEvidence(config) {
  try { return JSON.parse(await readFile(path.join(config.workspace, 'startup-task.json'), 'utf8')); } catch { return null; }
}
