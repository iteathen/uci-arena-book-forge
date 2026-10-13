import { randomUUID, createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { supportedBookComponentVersions } from './provider_root.mjs';
import { validProcessIdentity } from './process_identity.mjs';
import { admitBookTaskDefinition } from './provider_task_xml.mjs';

const cap = 16 * 1024 * 1024;
const schema = 'uci_arena_book_lifecycle_before_state_v1';
const rejected = () => new Error('Book lifecycle before-state unavailable');
async function directory(filename) {
  const stat = await lstat(filename);
  const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical(await realpath(filename)) !== canonical(filename)) throw rejected();
}
async function readPacket(filename) {
  let handle;
  try {
    const named = await lstat(filename);
    if (!named.isFile() || named.isSymbolicLink() || named.size > cap) throw rejected();
    handle = await open(filename, 'r');
    const stat = await handle.stat();
    if (stat.dev !== named.dev || stat.ino !== named.ino || stat.size !== named.size) throw rejected();
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (bytesRead !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw rejected();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)));
  } catch (error) { if (error.code === 'ENOENT' && !handle) return null; throw rejected(); }
  finally { if (handle) await handle.close(); }
}
export function validLifecycleIntent(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    typeof value.binding === 'string' && value.binding.length > 0 && value.binding.length <= 512 &&
    typeof value.registered === 'boolean' && typeof value.enabled === 'boolean' && typeof value.active === 'boolean' &&
    (value.registered || (value.binding === 'absent' && value.enabled === false && value.active === false));
}
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const text = value => typeof value === 'string' && value.isWellFormed() && value.length <= 32767 && !/[\u0000\r\n]/u.test(value);
const absolute = value => text(value) && (/^[a-z]:[\\/]/iu.test(value) || /^\\\\[^\\]+\\[^\\]+/u.test(value));
const sha = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value);
const guid = value => typeof value === 'string' && /^\{[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$/u.test(value);
function validLaunch(value) {
  return value === null || (exact(value, ['originUtcMs', 'previousNonce', 'previousOwnerAbsentAtUtcMs',
    'expectedNodeExecutable', 'taskDefinitionSha256', 'taskEnabled', 'instanceGuids']) &&
    Number.isSafeInteger(value.originUtcMs) && value.originUtcMs >= 0 &&
    Number.isSafeInteger(value.previousOwnerAbsentAtUtcMs) && value.previousOwnerAbsentAtUtcMs >= 0 &&
    value.previousOwnerAbsentAtUtcMs <= value.originUtcMs && uuid(value.previousNonce) &&
    absolute(value.expectedNodeExecutable) && sha(value.taskDefinitionSha256) && value.taskEnabled === true &&
    Array.isArray(value.instanceGuids) && value.instanceGuids.length > 0 && value.instanceGuids.length <= 16 &&
    value.instanceGuids.every(guid) && new Set(value.instanceGuids).size === value.instanceGuids.length);
}
function concreteIntent(value) {
  if (!validLifecycleIntent(value)) return false;
  if (value.active && !value.enabled) return false;
  const fields = ['binding', 'root', 'componentVersion', 'registered', 'enabled', 'active', 'orphan', 'task',
    'nodeExecutable', 'obstacleIdentity', 'nonce', 'launch', 'ownershipUnverifiable', 'catalogSchemaVersion', 'payloadIdentity'];
  if (Object.keys(value).some(field => !fields.includes(field))) return false;
  if (Object.hasOwn(value, 'payloadIdentity') && !validPayload(value.payloadIdentity)) return false;
  if (!value.registered && exact(value, ['binding', 'registered', 'enabled', 'active'])) return true;
  if (['root', 'nodeExecutable', 'task', 'nonce', 'launch', 'obstacleIdentity'].some(field => !Object.hasOwn(value, field))) return false;
  if (!Number.isInteger(value.catalogSchemaVersion) || ![0, 4, 5].includes(value.catalogSchemaVersion)) return false;
  if (![null, undefined].includes(value.nonce) && !uuid(value.nonce)) return false;
  if (value.launch !== undefined && !validLaunch(value.launch)) return false;
  if (value.obstacleIdentity !== null && (!validProcessIdentity(value.obstacleIdentity) || value.obstacleIdentity.platform !== 'win32' ||
      !exact(value.obstacleIdentity, ['schema', 'platform', 'pid', 'start_token', 'executable_path', 'boot_id']))) return false;
  if (['orphan', 'ownershipUnverifiable'].some(field => Object.hasOwn(value, field) && typeof value[field] !== 'boolean')) return false;
  const task = value.task;
  if (!value.registered) return value.root === null && value.nodeExecutable === null && value.componentVersion === null &&
    exact(task, ['registered', 'enabled', 'definition_xml', 'definition_sha256', 'instance_guids', 'principal', 'action']) &&
    task.registered === false && task.enabled === null && task.definition_xml === null && task.definition_sha256 === null &&
    task.principal === null && task.action === null && Array.isArray(task.instance_guids) && task.instance_guids.length === 0;
  if (!sha(value.binding) || !absolute(value.root) || !absolute(value.nodeExecutable) ||
      path.win32.basename(value.nodeExecutable).toLowerCase() !== 'node.exe' ||
      (value.componentVersion !== undefined && !supportedBookComponentVersions.includes(value.componentVersion))) return false;
  const planned = exact(task, ['action', 'definition_xml', 'definition_sha256']);
  const captured = exact(task, ['registered', 'enabled', 'definition_xml', 'definition_sha256', 'instance_guids', 'principal', 'action']);
  if (!planned && !captured) return false;
  if (typeof task.definition_xml !== 'string' || !task.definition_xml.isWellFormed() ||
      Buffer.byteLength(task.definition_xml) > 1048576 || /<!\s*(?:DOCTYPE|ENTITY)/iu.test(task.definition_xml) ||
      !sha(task.definition_sha256) || createHash('sha256').update(task.definition_xml).digest('hex') !== task.definition_sha256 ||
      !exact(task.action, ['command', 'arguments', 'working_directory']) || !absolute(task.action.command) ||
      !absolute(task.action.working_directory) || !text(task.action.arguments)) return false;
  if (captured && (task.registered !== true || task.enabled !== value.enabled ||
      !Array.isArray(task.instance_guids) || task.instance_guids.length > 16 || !task.instance_guids.every(guid) ||
      new Set(task.instance_guids).size !== task.instance_guids.length ||
      !exact(task.principal, ['current_user_sid', 'user_sid', 'logon_type', 'run_level']) ||
      typeof task.principal.current_user_sid !== 'string' || !/^S-\d(?:-\d+)+$/u.test(task.principal.current_user_sid) ||
      task.principal.current_user_sid !== task.principal.user_sid || task.principal.logon_type !== 3 || task.principal.run_level !== 0)) return false;
  try { admitBookTaskDefinition(task.definition_xml, task.action, { enabled: captured ? task.enabled : undefined }); }
  catch { return false; }
  return true;
}
function validPayload(value) {
  return exact(value, ['componentVersion', 'componentManifestSha256', 'inventorySha256']) &&
    supportedBookComponentVersions.includes(value.componentVersion) &&
    sha(value.componentManifestSha256) && sha(value.inventorySha256);
}
function validPlan(value) {
  return exact(value, ['schema', 'root', 'payload', 'workspace', 'configuration', 'launchGrammar']) &&
    value.schema === 'book_lifecycle_target_plan_v1' && absolute(value.root) && validPayload(value.payload) &&
    absolute(value.workspace) && (value.configuration === null || absolute(value.configuration)) &&
    value.launchGrammar === 'book_windows_restart_daemon_v1';
}
function validState(value) {
  return value?.schema === schema && value.schema_version === 1 &&
    Object.keys(value).length === 3 && Array.isArray(value.records) && value.records.length <= 16 &&
    value.records.every(record => record && (Object.keys(record).length === 5 ||
      (exact(record, ['before', 'desired', 'preDone', 'postDone', 'last', 'plan', 'runtimePending', 'predecessorBefore']) &&
        validPlan(record.plan) && typeof record.runtimePending === 'boolean' &&
        (!record.runtimePending || (!record.postDone && record.desired.binding === record.before.binding)) &&
        validPayload(record.before.payloadIdentity) && validPayload(record.desired.payloadIdentity) &&
        (record.predecessorBefore === null || concreteIntent(record.predecessorBefore)))) &&
      concreteIntent(record.before) && concreteIntent(record.desired) &&
      typeof record.preDone === 'boolean' && typeof record.postDone === 'boolean' &&
      (record.last === null || (Object.keys(record.last).length === 4 && typeof record.last.binding === 'string' &&
        typeof record.last.enabled === 'boolean' && typeof record.last.active === 'boolean' &&
        [record.before.binding, record.desired.binding].includes(record.last.binding) &&
        (record.last.binding === 'absent' ? record.last.definition === null && record.last.active === false && record.last.enabled === false : sha(record.last.definition)))) &&
      (!(record.preDone || record.postDone) || record.last !== null));
}

export class BookLifecycleStore {
  constructor(workspace) { this.workspace = path.resolve(workspace); }
  async transact(callback) {
    await directory(this.workspace);
    const root = path.join(this.workspace, '.book-lifecycle');
    try { await mkdir(root, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw rejected(); }
    await directory(root);
    const lockPath = path.join(root, 'operation.lock');
    // An abandoned/foreign lock is explicit failure, not guessed ownership or
    // a PID-based reclamation. Only this held invocation removes its own lock.
    const lock = await open(lockPath, 'wx', 0o600);
    const nonce = randomUUID();
    let lockWritten = false;
    try {
      await lock.writeFile(JSON.stringify({ schema: 'book_lifecycle_operation_lock_v1', nonce }));
      await lock.sync(); lockWritten = true;
      const filename = path.join(root, 'before-state.json');
      const saved = await readPacket(filename);
      if (saved !== null && !validState(saved)) throw rejected();
      const value = saved ?? { schema, schema_version: 1, records: [] };
      const state = { records: value.records, save: async () => {
        if (!validState(value)) throw rejected();
        const bytes = Buffer.from(JSON.stringify(value));
        if (bytes.length > cap) throw rejected();
        await directory(root);
        const prior = await readPacket(filename); // Reject nonregular replaced targets before publication.
        if (prior !== null && !validState(prior)) throw rejected();
        const temporary = path.join(root, `before-state-${randomUUID()}.json`);
        const output = await open(temporary, 'wx', 0o600);
        try { await output.writeFile(bytes); await output.sync(); } finally { await output.close(); }
        // A failed activation retains the complete temporary before-image.
        await rename(temporary, filename);
      } };
      return await callback(state);
    } finally {
      const held = await lock.stat();
      await lock.close();
      const named = await lstat(lockPath);
      if (!lockWritten || !named.isFile() || named.isSymbolicLink() || named.dev !== held.dev || named.ino !== held.ino ||
          (await readPacket(lockPath))?.nonce !== nonce) throw rejected();
      await unlink(lockPath);
    }
  }
}
