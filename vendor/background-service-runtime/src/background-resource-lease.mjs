import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, resolve } from "node:path";

export const RESOURCE_LEASE_SCHEMA = "uci_arena_background_resource_lease_v1";
export const RESOURCE_LEASE_SCOPE = "host_account_global_os_temp";
export const RESOURCE_LEASE_TOKEN_ENV = "UCI_ARENA_RESOURCE_LEASE_TOKEN";
export const RESOURCE_LEASE_ROOT_ENV = "UCI_ARENA_RESOURCE_LEASE_ROOT";

const HOLDER_FILENAME = "holder.json";
const DEFAULT_STALE_MS = 10_000;
const DEFAULT_POLL_MS = 100;

function nowIso() {
  return new Date().toISOString();
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function leaseRoot(explicitRoot = "") {
  return resolve(
    explicitRoot
      || process.env[RESOURCE_LEASE_ROOT_ENV]?.trim()
      || resolve(os.tmpdir(), "uci_arena_background_resource_lease"),
  );
}

function safeJson(filename) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(filename, "utf8")) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function packetCurrent(packet, staleMs, currentTime = Date.now()) {
  const heartbeat = Date.parse(String(packet?.heartbeat_at ?? ""));
  return packet?.schema === RESOURCE_LEASE_SCHEMA
    && packet?.scope === RESOURCE_LEASE_SCOPE
    && processAlive(Number(packet?.pid))
    && Number.isFinite(heartbeat)
    && currentTime - heartbeat <= staleMs;
}

function removeStaleFile(filename, staleMs) {
  if (!existsSync(filename)) return;
  const parsed = safeJson(filename);
  let stale = !parsed.ok || !packetCurrent(parsed.value, staleMs);
  if (!stale) return;
  try {
    const age = Date.now() - statSync(filename).mtimeMs;
    stale = age >= Math.min(staleMs, 1_000) || !parsed.ok;
  } catch {
    stale = true;
  }
  if (stale) {
    try {
      unlinkSync(filename);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function requestFilename(root, priority, nonce) {
  return resolve(root, `request-${priority}-${nonce}.json`);
}

function holderFilename(root) {
  return resolve(root, HOLDER_FILENAME);
}

function writeExclusiveJson(filename, value) {
  mkdirSync(dirname(filename), { recursive: true });
  const descriptor = openSync(filename, "wx");
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function replaceJson(filename, value) {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, "utf8");
  try {
    renameSync(temporary, filename);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
  }
}

function listRequests(root, staleMs) {
  if (!existsSync(root)) return [];
  const requests = [];
  for (const name of readdirSync(root)) {
    if (!/^request-(foreground|background)-[0-9a-f-]{36}\.json$/i.test(name)) continue;
    const filename = resolve(root, name);
    removeStaleFile(filename, staleMs);
    if (!existsSync(filename)) continue;
    const parsed = safeJson(filename);
    if (!parsed.ok || !packetCurrent(parsed.value, staleMs)) continue;
    requests.push({ ...parsed.value, filename });
  }
  return requests.sort((left, right) => {
    if (left.priority !== right.priority) return left.priority === "foreground" ? -1 : 1;
    const time = Date.parse(left.requested_at) - Date.parse(right.requested_at);
    return time || String(left.nonce).localeCompare(String(right.nonce));
  });
}

function holder(root, staleMs) {
  const filename = holderFilename(root);
  removeStaleFile(filename, staleMs);
  if (!existsSync(filename)) return null;
  const parsed = safeJson(filename);
  return parsed.ok && packetCurrent(parsed.value, staleMs) ? { ...parsed.value, filename } : null;
}

function sameIdentity(left, right) {
  return left?.schema === RESOURCE_LEASE_SCHEMA
    && left?.scope === RESOURCE_LEASE_SCOPE
    && left?.nonce === right?.nonce
    && left?.token === right?.token
    && Number(left?.pid) === Number(right?.pid);
}

export function resourceLeaseSnapshot({ root: explicitRoot = "", staleMs = DEFAULT_STALE_MS } = {}) {
  const root = leaseRoot(explicitRoot);
  return {
    schema: RESOURCE_LEASE_SCHEMA,
    scope: RESOURCE_LEASE_SCOPE,
    root,
    holder: holder(root, staleMs),
    requests: listRequests(root, staleMs),
    sampled_at: nowIso(),
  };
}

export function foregroundResourceDemand(options = {}) {
  return resourceLeaseSnapshot(options).requests.some((request) => request.priority === "foreground");
}

export function validateInheritedResourceLease(
  token = process.env[RESOURCE_LEASE_TOKEN_ENV]?.trim() || "",
  options = {},
) {
  if (!token) return { valid: false, reason: "resource_lease_token_missing" };
  const snapshot = resourceLeaseSnapshot(options);
  if (!snapshot.holder || snapshot.holder.token !== token) {
    return { valid: false, reason: "resource_lease_token_not_current", snapshot };
  }
  return { valid: true, lease: snapshot.holder, snapshot };
}

export async function acquireResourceLease({
  producer,
  priority = "background",
  root: explicitRoot = "",
  staleMs = DEFAULT_STALE_MS,
  pollMs = DEFAULT_POLL_MS,
  timeoutMs = 0,
  signal,
} = {}) {
  if (!String(producer ?? "").trim()) throw new Error("resource lease producer is required");
  if (!new Set(["foreground", "background"]).has(priority)) {
    throw new Error("resource lease priority must be foreground or background");
  }
  const root = leaseRoot(explicitRoot);
  mkdirSync(root, { recursive: true });
  const nonce = randomUUID();
  const token = randomUUID();
  const requestedAt = nowIso();
  const request = {
    schema: RESOURCE_LEASE_SCHEMA,
    scope: RESOURCE_LEASE_SCOPE,
    kind: "request",
    priority,
    producer: String(producer),
    pid: process.pid,
    nonce,
    token,
    requested_at: requestedAt,
    heartbeat_at: requestedAt,
  };
  const requestPath = requestFilename(root, priority, nonce);
  writeExclusiveJson(requestPath, request);
  const startedAt = Date.now();
  let requestPacket = request;
  try {
    while (!signal?.aborted) {
      const currentTime = Date.now();
      requestPacket = { ...requestPacket, heartbeat_at: nowIso() };
      replaceJson(requestPath, requestPacket);
      const currentHolder = holder(root, staleMs);
      const requests = listRequests(root, staleMs);
      const first = requests[0];
      const eligible = first?.nonce === nonce && currentHolder === null;
      if (eligible) {
        const acquiredAt = nowIso();
        const packet = {
          schema: RESOURCE_LEASE_SCHEMA,
          scope: RESOURCE_LEASE_SCOPE,
          kind: "holder",
          priority,
          producer: String(producer),
          pid: process.pid,
          nonce,
          token,
          requested_at: requestedAt,
          acquired_at: acquiredAt,
          heartbeat_at: acquiredAt,
        };
        try {
          writeExclusiveJson(holderFilename(root), packet);
          try {
            unlinkSync(requestPath);
          } catch {}
          return new ResourceLease(root, packet, staleMs);
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
      }
      if (timeoutMs === 0 || currentTime - startedAt >= timeoutMs) return null;
      await delay(Math.min(pollMs, Math.max(1, timeoutMs - (currentTime - startedAt))));
    }
    return null;
  } finally {
    try {
      unlinkSync(requestPath);
    } catch {}
  }
}

export async function withForegroundResourceLease(producer, work, options = {}) {
  const inherited = validateInheritedResourceLease(
    process.env[RESOURCE_LEASE_TOKEN_ENV]?.trim() || "",
    options,
  );
  if (inherited.valid) return work(inherited.lease);
  const lease = await acquireResourceLease({
    ...options,
    producer,
    priority: "foreground",
    timeoutMs: options.timeoutMs ?? 24 * 60 * 60 * 1_000,
  });
  if (!lease) throw new Error("foreground resource lease could not be acquired");
  const heartbeat = setInterval(() => lease.heartbeat(), 2_000);
  try {
    return await work(lease.packet);
  } finally {
    clearInterval(heartbeat);
    lease.release();
  }
}

export class ResourceLease {
  constructor(root, packet, staleMs = DEFAULT_STALE_MS) {
    this.root = root;
    this.packet = packet;
    this.staleMs = staleMs;
    this.released = false;
  }

  get token() {
    return this.packet.token;
  }

  environment(environment = process.env) {
    return {
      ...environment,
      [RESOURCE_LEASE_TOKEN_ENV]: this.token,
      [RESOURCE_LEASE_ROOT_ENV]: this.root,
    };
  }

  heartbeat() {
    if (this.released) return false;
    const current = holder(this.root, this.staleMs);
    if (!sameIdentity(current, this.packet)) return false;
    this.packet = { ...this.packet, heartbeat_at: nowIso() };
    replaceJson(holderFilename(this.root), this.packet);
    return true;
  }

  revocationReason() {
    if (this.released) return "resource_lease_released";
    const current = holder(this.root, this.staleMs);
    if (!sameIdentity(current, this.packet)) return "resource_lease_identity_changed";
    if (this.packet.priority === "background") {
      const foreground = listRequests(this.root, this.staleMs)
        .find((request) => request.priority === "foreground");
      if (foreground) return `foreground_resource_request:${foreground.producer}`;
    }
    return "";
  }

  release() {
    if (this.released) return;
    const filename = holderFilename(this.root);
    const current = holder(this.root, this.staleMs);
    if (sameIdentity(current, this.packet)) {
      try {
        unlinkSync(filename);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    this.released = true;
  }
}
