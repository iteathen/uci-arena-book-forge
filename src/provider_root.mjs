import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

const LIMITS = Object.freeze({ manifest: 16 * 1024 * 1024, package: 65536,
  rows: 4096, total: 512 * 1024 * 1024 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const supportedBookComponentVersions = Object.freeze(['0.4.4', '0.4.8', '0.4.9', '0.4.10', '0.4.11', '0.4.12']);
const supported = new Set(supportedBookComponentVersions);
const text = value => typeof value === 'string' && value.isWellFormed() &&
  value.length > 0 && value.length <= 32767 && !/[\u0000\r\n]/u.test(value);
const samePath = (a, b) => process.platform === 'win32'
  ? a.toLowerCase() === b.toLowerCase() : a === b;

function relative(value) {
  if (!text(value) || value.includes('\\') || value.includes(':') || value.startsWith('/') ||
      value.split('/').some(part => !part || ['.', '..'].includes(part) || /[. ]$/u.test(part) ||
        ['secrets', 'runtime_state'].includes(part.toLowerCase()))) throw Error();
  return value;
}

async function regularPath(root, name) {
  const member = relative(name);
  let current = root;
  const segments = member.split('/');
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    const status = await lstat(current);
    if (status.isSymbolicLink() || (i < segments.length - 1 ? !status.isDirectory() : !status.isFile())) throw Error();
  }
  const physical = await realpath(current);
  if (!samePath(path.dirname(physical), path.dirname(current))) throw Error();
  return current;
}

async function memberSnapshot(root, name, maximum, collect = false) {
  const filename = await regularPath(root, name);
  const before = await lstat(filename, { bigint: true });
  const file = await open(filename, 'r');
  try {
    const start = await file.stat({ bigint: true });
    if (!start.isFile() || start.size > BigInt(maximum) ||
        start.dev !== before.dev || start.ino !== before.ino) throw Error();
    const hasher = createHash('sha256');
    const chunks = [];
    const chunk = Buffer.alloc(65536);
    let size = 0;
    while (true) {
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, maximum + 1 - size), null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > maximum) throw Error();
      hasher.update(chunk.subarray(0, bytesRead));
      if (collect) chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    const end = await file.stat({ bigint: true });
    if (start.size !== BigInt(size) || end.size !== start.size || end.mtimeNs !== start.mtimeNs ||
        end.ctimeNs !== start.ctimeNs) throw Error();
    // Recheck the published name before accepting the same fd-bound snapshot.
    await regularPath(root, name);
    const named = await lstat(filename, { bigint: true });
    if (named.dev !== start.dev || named.ino !== start.ino) throw Error();
    return { sha256: hasher.digest('hex'), size, bytes: collect ? Buffer.concat(chunks) : null };
  } finally { await file.close(); }
}

function parse(bytes) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }

// Root arguments already come from Installer's admitted public component data.
// This producer rebinds that supplied root to its exact public inventory; it does
// not discover installations, read receipts, or grant signature trust itself.
export async function admitBookComponentRoot(input, { platform = process.platform } = {}) {
  try {
    if (!text(input) || !path.isAbsolute(input)) throw Error();
    const requested = path.normalize(input);
    const status = await lstat(requested);
    if (!status.isDirectory() || status.isSymbolicLink()) throw Error();
    const root = await realpath(requested);
    if (!samePath(root, requested)) throw Error();
    const document = await memberSnapshot(root, 'arena-component.json', LIMITS.manifest, true);
    const manifest = parse(document.bytes);
    const target = platform === 'win32' ? 'windows-x86_64' : platform === 'linux' ? 'linux-x86_64' : null;
    if (!target || manifest.schema !== 'arena_install_component_v1' || manifest.schema_version !== 1 ||
        manifest.component_id !== 'book_forge.service' || !supported.has(manifest.component_version) ||
        manifest.target_triple !== target || !Array.isArray(manifest.files) ||
        manifest.files.length === 0 || manifest.files.length > LIMITS.rows) throw Error();
    const rows = new Map();
    let total = 0;
    for (const row of manifest.files) {
      if (!row || Object.keys(row).length !== 3 || !/^[0-9a-f]{64}$/u.test(row.sha256) ||
          !Number.isSafeInteger(row.size_bytes) || row.size_bytes < 0) throw Error();
      const name = relative(row.path);
      const key = platform === 'win32' ? name.toLowerCase() : name;
      if (rows.has(key) || name === 'arena-component.json') throw Error();
      total += row.size_bytes;
      if (total > LIMITS.total) throw Error();
      rows.set(key, { ...row });
    }
    const lookup = name => rows.get(platform === 'win32' ? relative(name).toLowerCase() : relative(name));
    const cliName = relative(manifest.entrypoints?.cli);
    if (cliName !== 'services/book-forge/src/cli.mjs') throw Error();
    const packageName = 'services/book-forge/package.json';
    const legacy = ['0.4.4', '0.4.8'].includes(manifest.component_version);
    let launcherName = null, helperName = null;
    if (platform === 'win32') {
      launcherName = manifest.entrypoints.startup_launcher ?? (legacy
        ? 'services/book-forge/native/bin/uci_arena_service_launcher.exe' : null);
      helperName = manifest.entrypoints.process_identity_helper ?? (legacy
        ? 'services/book-forge/native/bin/uci_arena_background_guard.exe' : null);
      if (!lookup(launcherName) || !lookup(helperName)) throw Error();
    }
    if (!lookup(cliName) || !lookup(packageName)) throw Error();
    let packageDocument;
    for (const row of rows.values()) {
      const snapshot = await memberSnapshot(root, row.path,
        Math.min(row.size_bytes, row.path === packageName ? LIMITS.package : LIMITS.total), row.path === packageName);
      if (snapshot.size !== row.size_bytes || snapshot.sha256 !== row.sha256) throw Error();
      if (row.path === packageName) {
        if (snapshot.size > LIMITS.package) throw Error();
        packageDocument = parse(snapshot.bytes);
      }
    }
    if (packageDocument?.name !== '@uci-arena/book-forge' || packageDocument.version !== manifest.component_version) throw Error();
    return Object.freeze({ schema: 'uci_arena_book_component_root_v1', root,
      componentVersion: manifest.component_version, componentManifestSha256: document.sha256,
      inventorySha256: hash(Buffer.from(JSON.stringify([...rows.values()]))),
      packageRoot: path.join(root, 'services/book-forge'), cli: path.join(root, cliName),
      launcher: launcherName ? path.join(root, relative(launcherName)) : null,
      helper: helperName ? path.join(root, relative(helperName)) : null,
      ownershipProfile: legacy ? `book_forge_public_layout_${manifest.component_version.replaceAll('.', '')}`
        : 'book_forge_manifest_entrypoints_v1' });
  } catch { throw new Error('Book component root admission failed'); }
}
