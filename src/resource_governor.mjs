import { execFile } from 'node:child_process';
import os from 'node:os';
import { statfs } from 'node:fs/promises';
import { promisify } from 'node:util';
import { NativeResourceHelper } from './native_helper.mjs';

const execFileAsync = promisify(execFile);
const gibibyte = 1024 ** 3;

function cpuTotals() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

async function priorityProcessRunning(names) {
  if (process.platform !== 'win32' || !names.length) return false;
  try {
    const { stdout } = await execFileAsync('tasklist.exe', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 1500 });
    const lower = stdout.toLowerCase();
    return names.some((name) => lower.includes(`"${name.toLowerCase()}"`));
  } catch {
    return false;
  }
}

export class ResourceGovernor {
  constructor(config, catalog) {
    this.config = config;
    this.catalog = catalog;
    this.previousCpu = cpuTotals();
    this.idleSamples = 0;
    this.workerLimit = 1;
    this.lastRampAt = Date.now();
    this.native = new NativeResourceHelper(config);
    this.native.start();
    this.last = { mode: 'courtesy', allowed: true, reason: '', workerLimit: 1 };
    try { os.setPriority(process.pid, os.constants.priority.PRIORITY_LOW); } catch {}
  }

  async sample() {
    const nowCpu = cpuTotals();
    const idleDelta = nowCpu.idle - this.previousCpu.idle;
    const totalDelta = nowCpu.total - this.previousCpu.total;
    this.previousCpu = nowCpu;
    const idleRatio = totalDelta > 0 ? idleDelta / totalDelta : 0;
    const disk = await statfs(this.config.workspace, { bigint: true });
    const freeWorkspaceGb = Number(disk.bavail * disk.bsize) / gibibyte;
    const availableMemoryGb = os.freemem() / gibibyte;
    const native = await this.native.probe();
    const control = this.catalog.control();
    let mode = 'courtesy';
    let allowed = true;
    let reason = '';
    if (control.paused) {
      mode = 'paused'; allowed = false; reason = control.reason || 'operator pause';
    } else if (freeWorkspaceGb < this.config.resources.minimumFreeWorkspaceGb) {
      mode = 'backoff'; allowed = false; reason = `workspace free space ${freeWorkspaceGb.toFixed(1)} GiB`;
    } else if (availableMemoryGb < this.config.resources.pauseAvailableMemoryGb) {
      mode = 'backoff'; allowed = false; reason = `available memory ${availableMemoryGb.toFixed(1)} GiB`;
    } else if (native?.on_battery || native?.battery_saver) {
      mode = 'backoff'; allowed = false; reason = native.battery_saver ? 'Windows battery saver is active' : 'system is running on battery';
    } else if (Number(native?.processor_limit_percent) < 60 && idleRatio < 0.50) {
      mode = 'backoff'; allowed = false; reason = `processor power limit is ${native.processor_limit_percent}% under load`;
    } else if (await priorityProcessRunning(this.config.resources.priorityProcessNames)) {
      mode = 'backoff'; allowed = false; reason = 'configured priority process is running';
    } else {
      this.idleSamples = idleRatio >= 0.80 ? this.idleSamples + 1 : 0;
      const inputIsIdle = !native || Number(native.input_idle_ms) >= 60_000;
      if (this.idleSamples >= 3 && inputIsIdle) {
        mode = 'idle_harvest';
        if (Date.now() - this.lastRampAt >= 30_000) {
          this.workerLimit = Math.min(this.config.analysis.maximumWorkers, this.workerLimit + 1);
          this.lastRampAt = Date.now();
        }
      } else {
        this.workerLimit = 1;
        this.lastRampAt = Date.now();
      }
    }
    this.last = {
      mode, allowed, reason, workerLimit: mode === 'idle_harvest' ? this.workerLimit : 1,
      idlePercent: Number((idleRatio * 100).toFixed(1)), freeWorkspaceGb: Number(freeWorkspaceGb.toFixed(1)),
      availableMemoryGb: Number(availableMemoryGb.toFixed(1)), sampledAt: new Date().toISOString(),
      nativeHelper: Boolean(native), onBattery: Boolean(native?.on_battery), inputIdleMs: native?.input_idle_ms ?? null,
      processorLimitPercent: native?.processor_limit_percent ?? null,
    };
    return this.last;
  }

  async permit() { return this.sample(); }
  close() { this.native.close(); }
}
