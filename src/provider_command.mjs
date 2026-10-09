import path from 'node:path';
import packageDocument from '../package.json' with { type: 'json' };
import { packageRoot } from './config.mjs';
import { BookLifecycleStore } from './provider_state.mjs';
import { convergeBookLifecycle, lifecycleResult } from './provider_lifecycle.mjs';
import { WindowsBookLifecyclePlatform } from './windows_provider_lifecycle.mjs';
import { currentUserSid } from './windows_startup.mjs';

const componentRoot = path.resolve(packageRoot, '../..');
export async function runBookLifecycle(config, request, { platform = process.platform,
  store = new BookLifecycleStore(config.workspace), platformFactory = options => new WindowsBookLifecyclePlatform(config, options),
  userSid = currentUserSid, version = packageDocument.version, root = componentRoot } = {}) {
  if (!['install', 'uninstall', 'pre_replace', 'post_replace'].includes(request.operation)) throw TypeError('Invalid Book lifecycle operation');
  if (platform !== 'win32') return lifecycleResult(request.operation, version, 'failed', {
    installation: 'unknown', activity: 'unknown', configuration: 'unknown', replacement: 'unknown',
  }, { id: 'book_lifecycle_platform', message: 'Transactional task lifecycle is declared only for Windows.' });
  try {
    const replacement = ['pre_replace', 'post_replace'].includes(request.operation);
    if (replacement && (!path.isAbsolute(request.previousRoot ?? '') || !path.isAbsolute(request.replacementRoot ?? ''))) throw Error();
    const roots = [...new Set([root, ...(request.operation === 'post_replace' ? [request.replacementRoot] : [])])];
    const candidateRoots = replacement ? [request.previousRoot] : [];
    const selected = platformFactory({ roots, candidateRoots, userSid: await userSid() });
    return await convergeBookLifecycle({ ...request, previousRoot: request.previousRoot ?? root,
      replacementRoot: request.replacementRoot ?? root }, { platform: selected, store, version });
  } catch { return lifecycleResult(request.operation, version, 'failed', {
    installation: 'unknown', activity: 'unknown', configuration: 'unknown', replacement: 'unknown',
  }, { id: 'book_lifecycle_admission', message: 'The exact Book lifecycle inputs could not be admitted.' }); }
}
