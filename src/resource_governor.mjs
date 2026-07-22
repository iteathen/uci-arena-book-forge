import { execFile } from 'node:child_process';
import os from 'node:os';
import { statfs } from 'node:fs/promises';
import { promisify } from 'node:util';
import { NativeResourceHelper } from './native_helper.mjs';

const execFileAsync = promisify(execFile);
const gibibyte = 1024 ** 3;
const engineProcessNames = new Set(['flashfork_uci.exe', 'uci_arena.exe']);

export const RESOURCE_WORK_CLASSES = Object.freeze({
  ACQUISITION: 'acquisition',
  INTEGRATION_PUBLICATION: 'integration_publication',
  STOCKFISH_ANALYSIS: 'stockfish_analysis',
  INGESTION_AND_MAINTENANCE: 'ingestion_and_maintenance',
});

const resourceWorkClasses = new Set(Object.values(RESOURCE_WORK_CLASSES));
const courtesyWorkClasses = new Set([
  RESOURCE_WORK_CLASSES.ACQUISITION,
  RESOURCE_WORK_CLASSES.INTEGRATION_PUBLICATION,
]);

function cpuTotals() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

async function runningConfiguredProcesses(names) {
  if (process.platform !== 'win32' || !names.length) return [];
  try {
    const { stdout } = await execFileAsync('tasklist.exe', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 1500 });
    const lower = stdout.toLowerCase();
    return names.filter((name) => lower.includes(`"${name.toLowerCase()}"`));
  } catch {
    return [];
  }
}

function validateWorkClass(workClass) {
  if (!resourceWorkClasses.has(workClass)) {
    throw new TypeError(`Unknown Book Forge resource work class: ${String(workClass)}`);
  }
}

export class ResourceGovernor {
  constructor(config, catalog, {
    cpuTotalsImpl = cpuTotals,
    statfsImpl = statfs,
    freeMemoryImpl = () => os.freemem(),
    processProbe = runningConfiguredProcesses,
    nativeHelper = new NativeResourceHelper(config),
    now = () => Date.now(),
  } = {}) {
    this.config = config;
    this.catalog = catalog;
    this.cpuTotals = cpuTotalsImpl;
    this.statfs = statfsImpl;
    this.freeMemory = freeMemoryImpl;
    this.processProbe = processProbe;
    this.now = now;
    this.previousCpu = this.cpuTotals();
    this.idleSamples = 0;
    this.workerLimit = 1;
    this.lastRampAt = this.now();
    this.native = nativeHelper;
    this.native.start?.();
    this.last = { workClass: null, mode: 'courtesy', allowed: false, reason: 'resource permit not sampled', workerLimit: 1 };
    try { os.setPriority(process.pid, os.constants.priority.PRIORITY_LOW); } catch {}
  }

  async sample(workClass) {
    validateWorkClass(workClass);
    const nowCpu = this.cpuTotals();
    const idleDelta = nowCpu.idle - this.previousCpu.idle;
    const totalDelta = nowCpu.total - this.previousCpu.total;
    this.previousCpu = nowCpu;
    const idleRatio = totalDelta > 0 ? idleDelta / totalDelta : 0;
    const disk = await this.statfs(this.config.workspace, { bigint: true });
    const freeWorkspaceGb = Number(disk.bavail * disk.bsize) / gibibyte;
    const availableMemoryGb = this.freeMemory() / gibibyte;
    const native = await this.native.probe();
    const control = this.catalog.control();
    let mode = 'courtesy';
    let allowed = true;
    let reason = '';
    let hardStop = false;
    let engineProcessRunning = false;
    let blockingProcesses = [];
    if (control.paused) {
      mode = 'paused'; allowed = false; hardStop = true; reason = control.reason || 'operator pause';
    } else if (freeWorkspaceGb < this.config.resources.minimumFreeWorkspaceGb) {
      mode = 'backoff'; allowed = false; hardStop = true; reason = `workspace free space ${freeWorkspaceGb.toFixed(1)} GiB`;
    } else if (availableMemoryGb < this.config.resources.pauseAvailableMemoryGb) {
      mode = 'backoff'; allowed = false; hardStop = true; reason = `available memory ${availableMemoryGb.toFixed(1)} GiB`;
    } else if (native?.on_battery || native?.battery_saver) {
      mode = 'backoff'; allowed = false; hardStop = true;
      reason = native.battery_saver ? 'Windows battery saver is active' : 'system is running on battery';
    } else if (Number(native?.processor_limit_percent) < 60 && idleRatio < 0.50) {
      mode = 'backoff'; allowed = false; hardStop = true;
      reason = `processor power limit is ${native.processor_limit_percent}% under load`;
    } else {
      const processNames = [...new Set([
        ...this.config.resources.priorityProcessNames,
        ...engineProcessNames,
      ])];
      const runningProcesses = await this.processProbe(processNames);
      const runningEngines = runningProcesses.filter((name) => engineProcessNames.has(name.toLowerCase()));
      engineProcessRunning = runningEngines.length > 0;
      blockingProcesses = runningProcesses.filter((name) => !engineProcessNames.has(name.toLowerCase()));
      if (blockingProcesses.length) {
        mode = 'backoff'; allowed = false; hardStop = true;
        reason = `configured priority process is running: ${blockingProcesses.join(', ')}`;
      } else if (engineProcessRunning) {
        this.idleSamples = 0;
        this.workerLimit = 1;
        this.lastRampAt = this.now();
        if (!courtesyWorkClasses.has(workClass)) {
          mode = 'backoff'; allowed = false;
          reason = `foreground UCI engine is running (${runningEngines.join(', ')}); ${workClass} is deferred`;
        }
      } else {
        this.idleSamples = idleRatio >= 0.80 ? this.idleSamples + 1 : 0;
        const inputIsIdle = !native || Number(native.input_idle_ms) >= 60_000;
        if (this.idleSamples >= 3 && inputIsIdle) {
          mode = 'idle_harvest';
          if (this.now() - this.lastRampAt >= 30_000) {
            this.workerLimit = Math.min(this.config.analysis.maximumWorkers, this.workerLimit + 1);
            this.lastRampAt = this.now();
          }
        } else {
          this.workerLimit = 1;
          this.lastRampAt = this.now();
        }
      }
    }
    if (hardStop) {
      this.idleSamples = 0;
      this.workerLimit = 1;
      this.lastRampAt = this.now();
    }
    this.last = {
      workClass, mode, allowed, reason, hardStop, engineProcessRunning, blockingProcesses,
      workerLimit: mode === 'idle_harvest' ? this.workerLimit : 1,
      idlePercent: Number((idleRatio * 100).toFixed(1)), freeWorkspaceGb: Number(freeWorkspaceGb.toFixed(1)),
      availableMemoryGb: Number(availableMemoryGb.toFixed(1)), sampledAt: new Date().toISOString(),
      nativeHelper: Boolean(native), onBattery: Boolean(native?.on_battery), inputIdleMs: native?.input_idle_ms ?? null,
      processorLimitPercent: native?.processor_limit_percent ?? null,
    };
    return this.last;
  }

  async permit(workClass) { return this.sample(workClass); }
  close() { this.native.close?.(); }
}
