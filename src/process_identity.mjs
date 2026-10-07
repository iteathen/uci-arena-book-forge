import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { NativeResourceHelper } from '@uci-arena/background-service-runtime/native-resource-helper';
import processQueryContract from '@uci-arena/background-service-runtime/process-instance-query-contract' with { type: 'json' };

export const PROCESS_INSTANCE_IDENTITY_SCHEMA = 'uci_arena_process_instance_identity_v1';
let cachedCurrentIdentity = null;
let nativeQuery = null;

// One record cap covers the public maximum path's JSON/UTF-8 expansion plus
// the fixed daemon lock/heartbeat envelope, within the package's bounded packet.
export const MAXIMUM_PROCESS_IDENTITY_RECORD_BYTES = processQueryContract.maximum_response_bytes;

function fullyQualifiedWindowsPath(value) {
  const root = path.win32.parse(value).root;
  return /^[a-z]:[\\/]/iu.test(root) || root.startsWith('\\\\');
}

export async function configureProcessIdentity(config, { helper = new NativeResourceHelper(config) } = {}) {
  nativeQuery = null;
  cachedCurrentIdentity = null;
  if (process.platform !== 'win32' || !config.nativeHelperAvailable ||
      typeof config.nativeHelper !== 'string' || /[\u0000\r\n]/u.test(config.nativeHelper) ||
      !fullyQualifiedWindowsPath(config.nativeHelper)) return false;
  const capability = await helper.probe();
  if (!Array.isArray(capability?.capabilities) || !capability.capabilities.includes(processQueryContract.capability)) return false;
  nativeQuery = helper.queryProcessInstanceSync.bind(helper);
  return true;
}

function normalizedExecutable(identity) {
  const value = String(identity?.executable_path ?? '');
  return identity?.platform === 'win32'
    ? path.win32.normalize(value).toLocaleLowerCase('en-US')
    : path.normalize(value);
}

export function validProcessIdentity(value, expectedPid = null) {
  const base = value?.schema === PROCESS_INSTANCE_IDENTITY_SCHEMA
    && (value.platform === 'win32' || value.platform === 'linux')
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && value.pid <= processQueryContract.pid_maximum
    && (expectedPid === null || value.pid === expectedPid)
    && typeof value.start_token === 'string'
    && /^[0-9]{1,32}$/.test(value.start_token)
    && typeof value.executable_path === 'string'
    && value.executable_path.length > 0
    && value.executable_path.length <= (value.platform === 'win32' ? processQueryContract.maximum_executable_path_utf16_units : 4096)
    && typeof value.boot_id === 'string'
    && value.boot_id.length <= 128;
  if (!base || value.platform !== 'win32') return base;
  const ticks = BigInt(value.start_token);
  return value.start_token.length <= processQueryContract.creation_tick_maximum.length
    && value.boot_id === '' && value.executable_path.isWellFormed() && !/[\u0000\r\n]/u.test(value.executable_path)
    && fullyQualifiedWindowsPath(value.executable_path)
    && ticks >= BigInt(processQueryContract.creation_tick_minimum) && ticks <= BigInt(processQueryContract.creation_tick_maximum);
}

export function sameProcessInstance(left, right) {
  return validProcessIdentity(left)
    && validProcessIdentity(right)
    && left.platform === right.platform
    && left.pid === right.pid
    && String(left.start_token) === String(right.start_token)
    && String(left.boot_id) === String(right.boot_id)
    && normalizedExecutable(left) === normalizedExecutable(right);
}

function linuxProcessIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return { state: 'unverifiable' };
    const fields = stat.slice(close + 2).trim().split(/\s+/u);
    const startToken = fields[19];
    const identity = {
      schema: PROCESS_INSTANCE_IDENTITY_SCHEMA,
      platform: 'linux',
      pid,
      start_token: startToken,
      executable_path: realpathSync(`/proc/${pid}/exe`),
      boot_id: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    };
    return validProcessIdentity(identity, pid)
      ? { state: 'present', identity }
      : { state: 'unverifiable' };
  } catch (error) {
    return ['ENOENT', 'ESRCH'].includes(error?.code)
      ? { state: 'absent' }
      : { state: 'unverifiable' };
  }
}

function windowsProcessIdentity(pid, timeoutMs) {
  try {
    const result = nativeQuery?.(pid, { timeoutMs });
    if (result?.state === 'absent') return { state: 'absent' };
    return result?.state === 'present' && validProcessIdentity(result.identity, pid)
      ? { state: 'present', identity: result.identity }
      : { state: 'unverifiable' };
  } catch {
    return { state: 'unverifiable' };
  }
}

export function probeProcessInstance(pid, { timeoutMs = processQueryContract.timeout_ms } = {}) {
  if (!Number.isSafeInteger(pid) || pid < processQueryContract.pid_minimum || pid > processQueryContract.pid_maximum ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > processQueryContract.timeout_ms) {
    return { state: 'unverifiable' };
  }
  if (process.platform === 'linux') return linuxProcessIdentity(pid);
  if (process.platform === 'win32') return windowsProcessIdentity(pid, timeoutMs);
  return { state: 'unverifiable' };
}

export function currentProcessIdentity() {
  if (cachedCurrentIdentity) return cachedCurrentIdentity;
  const result = probeProcessInstance(process.pid);
  if (result.state !== 'present') {
    throw new Error('current process instance identity is unavailable');
  }
  cachedCurrentIdentity = Object.freeze(result.identity);
  return cachedCurrentIdentity;
}

export function processIdentityFromJson(value, expectedPid = null) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return validProcessIdentity(parsed, expectedPid) ? parsed : null;
  } catch {
    return null;
  }
}

export function processInstanceIsCurrent(value, probe = probeProcessInstance) {
  const identity = processIdentityFromJson(value);
  if (!identity) return false;
  const current = identity.pid === process.pid
    ? { state: 'present', identity: currentProcessIdentity() }
    : probe(identity.pid);
  return current?.state === 'present' && sameProcessInstance(identity, current.identity);
}
