import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

const maximumCredentialBytes = 4_096;
const maximumAncestors = 256;
const defaultFileSystem = { lstat, open, realpath };

function unavailable() {
  const error = new Error('Lichess acquisition credential is unavailable');
  error.code = 'BOOK_FORGE_AUTH';
  return error;
}

function boundedAbsolutePath(value, platform) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/u.test(value) || !path.isAbsolute(value)) {
    throw new Error('invalid credential path');
  }
  const normalized = path.normalize(value);
  const withinPlatformLimit = platform === 'win32'
    ? normalized.length <= 32_767
    : Buffer.byteLength(normalized, 'utf8') <= 4_096;
  if (!withinPlatformLimit) throw new Error('invalid credential path');
  return normalized;
}

function sameObject(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileState(left, right) {
  return sameObject(left, right)
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function pathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative));
}

function requireRegularCredential(stats, platform, effectiveUid) {
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1n) {
    throw new Error('invalid credential object');
  }
  if (stats.size < 1n || stats.size > BigInt(maximumCredentialBytes)) {
    throw new Error('invalid credential size');
  }
  if (platform !== 'win32') {
    const mode = stats.mode & 0o777n;
    if (stats.uid !== BigInt(effectiveUid) || (mode & 0o400n) === 0n || (mode & 0o077n) !== 0n) {
      throw new Error('invalid credential ownership');
    }
  }
}

async function ancestorState(filename, fileSystem) {
  const directory = path.dirname(filename);
  const root = path.parse(directory).root;
  const relative = path.relative(root, directory);
  const components = relative ? relative.split(path.sep).filter(Boolean) : [];
  if (components.length > maximumAncestors) throw new Error('credential path is too deep');
  const result = [];
  let current = root;
  for (const component of ['', ...components]) {
    if (component) current = path.join(current, component);
    const stats = await fileSystem.lstat(current, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error('invalid credential ancestor');
    }
    result.push({ path: current, stats });
  }
  return result;
}

function sameAncestors(before, after) {
  return before.length === after.length && before.every((entry, index) => (
    entry.path === after[index].path && sameObject(entry.stats, after[index].stats)
  ));
}

async function protectedRootState(excludedRoots, fileSystem, platform) {
  const roots = [];
  for (const root of excludedRoots) {
    const bounded = boundedAbsolutePath(root, platform);
    const declaredStats = await fileSystem.lstat(bounded, { bigint: true });
    const physical = await fileSystem.realpath(bounded);
    const physicalStats = await fileSystem.lstat(physical, { bigint: true });
    if (!physicalStats.isDirectory()) throw new Error('protected root is not a directory');
    roots.push({ bounded, declaredStats, physical, physicalStats });
  }
  return roots;
}

function sameProtectedRoots(before, after) {
  return before.length === after.length && before.every((root, index) => (
    root.bounded === after[index].bounded
    && root.physical === after[index].physical
    && sameObject(root.declaredStats, after[index].declaredStats)
    && sameObject(root.physicalStats, after[index].physicalStats)
  ));
}

function parseCredential(bytes, length) {
  let payloadLength = length;
  if (bytes[payloadLength - 1] === 0x0a) payloadLength -= 1;
  if (payloadLength < 1) throw new Error('empty credential');
  for (let index = 0; index < payloadLength; index += 1) {
    const byte = bytes[index];
    if (byte < 0x21 || byte > 0x7e) throw new Error('invalid credential byte');
  }
  return bytes.toString('ascii', 0, payloadLength);
}

async function readAdmittedCredential(filename, {
  excludedRoots,
  fileSystem,
  platform,
  effectiveUid,
}) {
  const credentialPath = boundedAbsolutePath(filename, platform);
  if (!Array.isArray(excludedRoots) || excludedRoots.length < 1) {
    throw new Error('credential exclusion roots are required');
  }
  const protectedRootsBefore = await protectedRootState(excludedRoots, fileSystem, platform);
  const ancestorsBefore = await ancestorState(credentialPath, fileSystem);
  const pathBefore = await fileSystem.lstat(credentialPath, { bigint: true });
  requireRegularCredential(pathBefore, platform, effectiveUid);
  const physicalBefore = await fileSystem.realpath(credentialPath);
  if (protectedRootsBefore.some((root) => pathInside(physicalBefore, root.physical))) {
    throw new Error('credential is inside a protected root');
  }

  const noFollow = Number.isInteger(constants.O_NOFOLLOW) ? constants.O_NOFOLLOW : 0;
  const nonblocking = Number.isInteger(constants.O_NONBLOCK) ? constants.O_NONBLOCK : 0;
  let handle;
  let bytes;
  let result;
  let failure;
  try {
    handle = await fileSystem.open(credentialPath, constants.O_RDONLY | noFollow | nonblocking);
    const descriptorBefore = await handle.stat({ bigint: true });
    requireRegularCredential(descriptorBefore, platform, effectiveUid);
    if (!sameFileState(pathBefore, descriptorBefore)) throw new Error('credential changed before open');

    bytes = Buffer.allocUnsafe(maximumCredentialBytes + 1);
    let total = 0;
    while (total < bytes.length) {
      const observed = await handle.read(bytes, total, bytes.length - total, null);
      if (!Number.isSafeInteger(observed.bytesRead) || observed.bytesRead < 0) {
        throw new Error('invalid credential read result');
      }
      if (observed.bytesRead === 0) break;
      total += observed.bytesRead;
    }

    const descriptorAfter = await handle.stat({ bigint: true });
    const pathAfter = await fileSystem.lstat(credentialPath, { bigint: true });
    const physicalAfter = await fileSystem.realpath(credentialPath);
    const ancestorsAfter = await ancestorState(credentialPath, fileSystem);
    const protectedRootsAfter = await protectedRootState(excludedRoots, fileSystem, platform);
    if (total < 1 || total > maximumCredentialBytes
        || BigInt(total) !== descriptorBefore.size
        || !sameFileState(descriptorBefore, descriptorAfter)
        || !sameFileState(descriptorBefore, pathAfter)
        || physicalBefore !== physicalAfter
        || !sameAncestors(ancestorsBefore, ancestorsAfter)
        || !sameProtectedRoots(protectedRootsBefore, protectedRootsAfter)
        || protectedRootsAfter.some((root) => pathInside(physicalAfter, root.physical))) {
      throw new Error('credential changed during admission');
    }
    result = parseCredential(bytes, total);
  } catch (error) {
    failure = error;
  } finally {
    if (bytes) bytes.fill(0);
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure) throw failure;
  return result;
}

export async function readExactCredential(filename, {
  excludedRoots,
  fileSystem = defaultFileSystem,
  platform = process.platform,
  effectiveUid = typeof process.geteuid === 'function' ? process.geteuid() : 0,
} = {}) {
  try {
    return await readAdmittedCredential(filename, {
      excludedRoots,
      fileSystem,
      platform,
      effectiveUid,
    });
  } catch {
    throw unavailable();
  }
}
