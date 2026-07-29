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
      return value.schema === 'uci_arena_background_service_native_probe_v1' ? value : null;
    } catch {
      return null;
    }
  }

  async applyProcessProfile(processId, { efficiencyCoreLimit = 0 } = {}) {
    if (!this.config.nativeHelperAvailable) {
      return {
        schema: 'uci_arena_background_service_process_profile_v1', applied: false,
        eco_qos: false, cpu_set_applied: false, reason: 'native helper unavailable',
      };
    }
    if (!Number.isInteger(processId) || processId <= 0 ||
        !Number.isInteger(efficiencyCoreLimit) || efficiencyCoreLimit < 0 || efficiencyCoreLimit > 2) {
      throw new TypeError('Invalid UCI Arena service process profile request');
    }
    try {
      const { stdout } = await execFileAsync(this.config.nativeHelper, [
        '--apply-process-profile', String(processId), '--efficiency-cores', String(efficiencyCoreLimit),
      ], { windowsHide: true, timeout: 2_000 });
      const value = JSON.parse(stdout);
      if (value.schema !== 'uci_arena_background_service_process_profile_v1') throw new Error('unexpected helper response');
      return value;
    } catch (error) {
      return {
        schema: 'uci_arena_background_service_process_profile_v1', applied: false,
        eco_qos: false, cpu_set_applied: false,
        reason: String(error?.message ?? error).slice(0, 256),
      };
    }
  }

  close() {
    this.supervisor?.unref();
    this.supervisor = null;
  }
}
