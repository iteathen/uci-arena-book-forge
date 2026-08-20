import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import {
  appendFile,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readExactCredential } from '../src/exact_credential.mjs';

const syntheticToken = 'fixture-token';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'book-forge-credential-test-'));
  const workspace = path.join(root, 'workspace');
  const credentials = path.join(root, 'external-credentials');
  await mkdir(workspace);
  await mkdir(credentials);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace, credentials };
}

async function writeCredential(filename, contents = `${syntheticToken}\n`) {
  await writeFile(filename, contents, { mode: 0o600 });
  if (process.platform !== 'win32') await chmod(filename, 0o600);
}

function options(workspace, fileSystem) {
  return {
    excludedRoots: [workspace],
    ...(fileSystem ? { fileSystem } : {}),
  };
}

async function rejectsUnavailable(promise, forbidden = syntheticToken) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, 'BOOK_FORGE_AUTH');
    assert.equal(error.message, 'Lichess acquisition credential is unavailable');
    assert.equal(error.message.includes(forbidden), false);
    return true;
  });
}

function wrappedFileSystem(wrapHandle) {
  return {
    lstat,
    realpath,
    async open(filename, flags) {
      return wrapHandle(await open(filename, flags), filename);
    },
  };
}

function forwardingHandle(handle, overrides = {}) {
  return {
    stat: (...argumentsList) => handle.stat(...argumentsList),
    read: (...argumentsList) => handle.read(...argumentsList),
    close: () => handle.close(),
    ...overrides,
  };
}

function simulatedPosixFileSystem({ mode, uid }) {
  const adapt = (stats) => new Proxy(stats, {
    get(target, property) {
      if (property === 'mode') return (target.mode & ~0o777n) | mode;
      if (property === 'uid') return uid;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    async lstat(filename, settings) {
      return adapt(await lstat(filename, settings));
    },
    realpath,
    async open(filename, flags) {
      const handle = await open(filename, flags);
      return forwardingHandle(handle, {
        async stat(settings) {
          return adapt(await handle.stat(settings));
        },
      });
    },
  };
}

test('exact credential admission accepts only the configured external file generation', async (t) => {
  const { workspace, credentials } = await fixture(t);
  const filename = path.join(credentials, 'token');
  await writeCredential(filename);

  assert.equal(await readExactCredential(filename, options(workspace)), syntheticToken);
  await writeCredential(filename, syntheticToken);
  assert.equal(await readExactCredential(filename, options(workspace)), syntheticToken);
});

test('exact credential admission rejects every non-exact byte shape', async (t) => {
  const { workspace, credentials } = await fixture(t);
  const filename = path.join(credentials, 'token');
  const invalid = [
    '',
    '\n',
    ` ${syntheticToken}\n`,
    `${syntheticToken} \n`,
    `${syntheticToken}\r\n`,
    `${syntheticToken}\nextra`,
    `${syntheticToken}\0`,
    `${syntheticToken}\t`,
    Buffer.concat([Buffer.from(syntheticToken), Buffer.from([0x7f])]),
    'x'.repeat(4_097),
  ];
  for (const contents of invalid) {
    await writeCredential(filename, contents);
    await rejectsUnavailable(readExactCredential(filename, options(workspace)));
  }
});

test('exact credential admission rejects final and ancestor links', async (t) => {
  const { workspace, credentials } = await fixture(t);
  const targetDirectory = path.join(credentials, 'target');
  await mkdir(targetDirectory);
  const target = path.join(targetDirectory, 'token');
  await writeCredential(target);

  const finalLink = path.join(credentials, 'final-link');
  if (process.platform === 'win32') {
    await symlink(targetDirectory, finalLink, 'junction');
  } else {
    await symlink(target, finalLink, 'file');
  }
  await rejectsUnavailable(readExactCredential(finalLink, options(workspace)));

  const parentLink = path.join(credentials, 'parent-link');
  await symlink(targetDirectory, parentLink, process.platform === 'win32' ? 'junction' : 'dir');
  await rejectsUnavailable(readExactCredential(
    path.join(parentLink, 'token'), options(workspace),
  ));
});

test('exact credential admission rejects protected-root files and hard-link aliases', async (t) => {
  const { workspace, credentials } = await fixture(t);
  const protectedToken = path.join(workspace, 'token');
  await writeCredential(protectedToken);
  await rejectsUnavailable(readExactCredential(protectedToken, options(workspace)));

  const alias = path.join(credentials, 'alias');
  await link(protectedToken, alias);
  await rejectsUnavailable(readExactCredential(alias, options(workspace)));
});

test('exact credential admission rejects same-size mutation and growth during read', async (t) => {
  const { workspace, credentials } = await fixture(t);
  const filename = path.join(credentials, 'token');
  await writeCredential(filename);
  let mutated = false;
  const mutationFileSystem = wrappedFileSystem((handle, openedPath) => forwardingHandle(handle, {
    async read(...argumentsList) {
      if (!mutated) {
        mutated = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
        await writeCredential(openedPath, 'altered-token\n');
      }
      return handle.read(...argumentsList);
    },
  }));
  await rejectsUnavailable(readExactCredential(filename, options(workspace, mutationFileSystem)));

  await writeCredential(filename);
  let grown = false;
  const growthFileSystem = wrappedFileSystem((handle, openedPath) => forwardingHandle(handle, {
    async read(...argumentsList) {
      if (!grown) {
        grown = true;
        await appendFile(openedPath, 'x'.repeat(4_096));
      }
      return handle.read(...argumentsList);
    },
  }));
  await rejectsUnavailable(readExactCredential(filename, options(workspace, growthFileSystem)));
});

test('exact credential admission rejects a premature descriptor EOF', async (t) => {
  const { workspace, credentials } = await fixture(t);
  const filename = path.join(credentials, 'token');
  await writeCredential(filename);
  let reads = 0;
  const partialFileSystem = wrappedFileSystem((handle) => forwardingHandle(handle, {
    async read(buffer, offset) {
      reads += 1;
      if (reads > 1) return { bytesRead: 0, buffer };
      const partial = Buffer.from('partial');
      partial.copy(buffer, offset);
      return { bytesRead: partial.length, buffer };
    },
  }));
  await rejectsUnavailable(readExactCredential(filename, options(workspace, partialFileSystem)));
});

test('exact credential admission rejects path replacement after open', async (t) => {
  const { workspace, credentials } = await fixture(t);
  const filename = path.join(credentials, 'token');
  const retired = path.join(credentials, 'retired-token');
  await writeCredential(filename);
  let replaced = false;
  const replacementFileSystem = wrappedFileSystem((handle, openedPath) => forwardingHandle(handle, {
    async read(...argumentsList) {
      if (!replaced) {
        replaced = true;
        await rename(openedPath, retired);
        await writeCredential(openedPath, 'replacement-token\n');
      }
      return handle.read(...argumentsList);
    },
  }));
  await rejectsUnavailable(readExactCredential(filename, options(workspace, replacementFileSystem)));
});

test('exact credential admission rejects protected-root replacement during read', async (t) => {
  const { root, workspace, credentials } = await fixture(t);
  const filename = path.join(credentials, 'token');
  const retiredWorkspace = path.join(root, 'retired-workspace');
  await writeCredential(filename);
  let replaced = false;
  const replacementFileSystem = wrappedFileSystem((handle) => forwardingHandle(handle, {
    async read(...argumentsList) {
      if (!replaced) {
        replaced = true;
        await rename(workspace, retiredWorkspace);
        await mkdir(workspace);
      }
      return handle.read(...argumentsList);
    },
  }));
  await rejectsUnavailable(readExactCredential(filename, options(workspace, replacementFileSystem)));
});

test('exact credential admission makes access and close failures pathless', async (t) => {
  const { workspace, credentials } = await fixture(t);
  const filename = path.join(credentials, 'token');
  await writeCredential(filename);

  const deniedFileSystem = {
    lstat,
    realpath,
    async open() {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    },
  };
  await rejectsUnavailable(readExactCredential(filename, options(workspace, deniedFileSystem)));

  const closeFailureFileSystem = wrappedFileSystem((handle) => forwardingHandle(handle, {
    async close() {
      await handle.close();
      throw new Error('close failed');
    },
  }));
  await rejectsUnavailable(readExactCredential(filename, options(workspace, closeFailureFileSystem)));
});

test('exact credential admission rejects broad POSIX file modes', async (t) => {
  const { workspace, credentials } = await fixture(t);
  const filename = path.join(credentials, 'token');
  await writeCredential(filename);
  if (process.platform !== 'win32') {
    await chmod(filename, 0o640);
    await rejectsUnavailable(readExactCredential(filename, options(workspace)));
    return;
  }

  const effectiveUid = 4_242;
  assert.equal(await readExactCredential(filename, {
    excludedRoots: [workspace],
    fileSystem: simulatedPosixFileSystem({ mode: 0o600n, uid: BigInt(effectiveUid) }),
    platform: 'linux',
    effectiveUid,
  }), syntheticToken);
  await rejectsUnavailable(readExactCredential(filename, {
    excludedRoots: [workspace],
    fileSystem: simulatedPosixFileSystem({ mode: 0o640n, uid: BigInt(effectiveUid) }),
    platform: 'linux',
    effectiveUid,
  }));
  await rejectsUnavailable(readExactCredential(filename, {
    excludedRoots: [workspace],
    fileSystem: simulatedPosixFileSystem({ mode: 0o600n, uid: 7_777n }),
    platform: 'linux',
    effectiveUid,
  }));
});

test('exact credential admission rejects directories, special files, and bounded paths', async (t) => {
  const { workspace, credentials } = await fixture(t);
  await rejectsUnavailable(readExactCredential(credentials, options(workspace)));
  if (process.platform !== 'win32') {
    await rejectsUnavailable(readExactCredential('/dev/null', options(workspace)));
  }
  const overlong = process.platform === 'win32'
    ? `C:\\${'x'.repeat(32_768)}`
    : `/${'x'.repeat(4_097)}`;
  await rejectsUnavailable(readExactCredential(overlong, options(workspace)));
});

test('exact credential admission requests no-follow and nonblocking opens when available', async (t) => {
  const { workspace, credentials } = await fixture(t);
  const filename = path.join(credentials, 'token');
  await writeCredential(filename);
  let observedFlags;
  const observingFileSystem = {
    lstat,
    realpath,
    async open(openedPath, flags) {
      observedFlags = flags;
      return open(openedPath, flags);
    },
  };
  assert.equal(
    await readExactCredential(filename, options(workspace, observingFileSystem)),
    syntheticToken,
  );
  if (Number.isInteger(constants.O_NOFOLLOW)) {
    assert.equal((observedFlags & constants.O_NOFOLLOW) !== 0, true);
  }
  if (Number.isInteger(constants.O_NONBLOCK)) {
    assert.equal((observedFlags & constants.O_NONBLOCK) !== 0, true);
  }
});
