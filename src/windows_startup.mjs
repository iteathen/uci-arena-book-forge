import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { packageRoot } from './config.mjs';
import { observeDaemonActivity, observeDaemonDrainObstacle } from './daemon_observation.mjs';
import { WindowsTaskScheduler } from '@uci-arena/background-service-runtime/windows-task-scheduler';

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

export function startupAction(config, { descriptor = null, nodeExecutable = process.execPath } = {}) {
  const paths = descriptor && (/^[a-z]:[\\/]/iu.test(descriptor.root) || /^\\\\[^\\]+\\[^\\]+/u.test(descriptor.root)) ? path.win32 : path;
  const argumentsList = ['--restart', paths.resolve(nodeExecutable), descriptor?.cli ?? cliPath, 'daemon', '--workspace', config.workspace];
  if (config.configFile) argumentsList.push('--config', config.configFile);
  return {
    command: paths.resolve(descriptor?.launcher ?? config.nativeLauncher),
    arguments: argumentsList.map(quoteWindowsArgument).join(' '),
    workingDirectory: descriptor?.packageRoot ?? packageRoot,
  };
}

export function buildTaskXml(config, userSid, { descriptor = null, nodeExecutable = process.execPath, enabled = true,
  taskName = startupTaskName } = {}) {
  if (!/^S-\d(?:-\d+)+$/.test(userSid)) throw new Error(`Invalid Windows user SID: ${userSid}`);
  if (!/^[A-Za-z0-9 ._-]{1,128}$/u.test(taskName)) throw new Error('Invalid Book task name');
  const action = startupAction(config, { descriptor, nodeExecutable });
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Continuously improves and publishes UCI Arena opening-book snapshots.</Description>
    <URI>\\${xmlEscape(taskName)}</URI>
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
    <Enabled>${enabled ? 'true' : 'false'}</Enabled>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
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

export async function currentUserSid() {
  const { stdout } = await execFileAsync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'),
    ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 5_000 });
  const match = /"[^"]+","(S-\d(?:-\d+)+)"/.exec(stdout.trim());
  if (!match) throw new Error('Could not determine the current Windows user SID');
  return match[1];
}

export async function queryWindowsStartup(config, {
  taskScheduler = new WindowsTaskScheduler(), activityImpl = observeDaemonActivity,
  drainImpl = observeDaemonDrainObstacle,
} = {}) {
  requireWindows();
  const result = await taskScheduler.perform({ operation: 'inspect', task_path: `\\${startupTaskName}` },
    { timeoutMs: 10000 });
  if (result.outcome !== 'completed') throw new Error('Book Forge Windows startup observation failed');
  const observed = result.observation;
  const expected = startupAction(config);
  const activity = await activityImpl(config);
  const drainObstacle = await drainImpl(config);
  const actual = observed.action;
  return { platform: 'windows', installed: observed.registered,
    enabled: observed.registered ? observed.enabled : false, taskName: startupTaskName,
    ...(observed.registered ? { action: { command: actual.command, arguments: actual.arguments,
      workingDirectory: actual.working_directory } } : {}),
    active: activity.active, activityState: activity.state, ownerLive: activity.ownerLive,
    drainObstacle, runningInstanceCount: observed.instance_guids.length,
    serviceManagerActive: observed.instance_guids.length > 0,
    matchesCurrentConfiguration: Boolean(observed.registered && actual.command === expected.command &&
      actual.arguments === expected.arguments && actual.working_directory === expected.workingDirectory) };
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
  // Scheduler Run is intent only. Keep the actual after-run daemon observation
  // distinct; never promote the earlier pre-run query to active evidence.
  return { ...(await queryWindowsStartup(config)), started: true, evidencePath };
}

export async function startWindowsStartup(config, {
  queryImpl = queryWindowsStartup,
  execFileImpl = execFileAsync,
} = {}) {
  requireWindows();
  const registered = await queryImpl(config);
  if (!registered.installed) throw new Error(`Book Forge startup task is not registered: ${startupTaskName}`);
  if (!registered.matchesCurrentConfiguration) {
    throw new Error('Book Forge startup task does not match the current configuration');
  }
  if (registered.enabled === false) throw new Error('Book Forge startup task is disabled');
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
