import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class NativeResourceHelper {
  constructor(config) {
    this.config = config;
    this.supervisor = null;
  }

  start() {
    if (!this.config.nativeHelperAvailable || this.supervisor) return false;
    this.supervisor = spawn(this.config.nativeHelper, [
      '--supervise', String(process.pid), '--heartbeat', this.config.daemonHeartbeatFile, '--stale-seconds', '300',
    ], {
      stdio: 'ignore', windowsHide: true,
    });
    this.supervisor.once('exit', () => { this.supervisor = null; });
    this.supervisor.unref();
    return true;
  }

  async probe() {
    if (!this.config.nativeHelperAvailable) return null;
    try {
      const { stdout } = await execFileAsync(this.config.nativeHelper, ['--probe'], { windowsHide: true, timeout: 1_000 });
      const value = JSON.parse(stdout);
      return value.schema === 'flashfork_book_forge_native_probe_v1' ? value : null;
    } catch {
      return null;
    }
  }

  close() {
    this.supervisor?.unref();
    this.supervisor = null;
  }
}
