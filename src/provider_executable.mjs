import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

// Only the Book task's admitted Node executable is read; no argument/config,
// process commandline, credential, or installation discovery is performed.
export async function admitBookNodeExecutable(filename) {
  if (!path.win32.isAbsolute(filename) || path.win32.basename(filename).toLowerCase() !== 'node.exe') throw Error('Book Node admission failed');
  const named = await lstat(filename);
  if (!named.isFile() || named.isSymbolicLink() || named.size < 2 || named.size > 256 * 1024 * 1024 ||
      path.win32.normalize(await realpath(filename)).toLowerCase() !== path.win32.normalize(filename).toLowerCase()) throw Error('Book Node admission failed');
  const handle = await open(filename, 'r');
  try {
    const first = await handle.stat();
    if (first.ino !== named.ino || first.dev !== named.dev || first.size !== named.size) throw Error('Book Node admission failed');
    const hash = createHash('sha256'); const buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < first.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, first.size - offset), offset);
      if (!bytesRead || (offset === 0 && (buffer[0] !== 0x4d || buffer[1] !== 0x5a))) throw Error('Book Node admission failed');
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await handle.stat(); const current = await lstat(filename);
    if (after.size !== first.size || after.mtimeMs !== first.mtimeMs || current.ino !== first.ino ||
        current.dev !== first.dev || !current.isFile() || current.isSymbolicLink()) throw Error('Book Node admission failed');
    return hash.digest('hex');
  } finally { await handle.close(); }
}
