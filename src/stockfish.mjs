import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { shutdownChildProcessTree } from '../../../arena/lib/gpu_resource_isolation.mjs';
import { NativeResourceHelper } from './native_helper.mjs';

const defaultRevocationPollMs = 250;

function revocationError(signal) {
  const reason = signal?.reason ? `: ${String(signal.reason).slice(0, 256)}` : '';
  const error = new Error(`Stockfish analysis interrupted${reason}`);
  error.name = 'AbortError';
  return error;
}

function monitorResourcePermit(
  governor,
  controller,
  onRevoked,
  intervalMs,
  activeProfile,
  lease = null,
) {
  let sampling = false;
  let stopped = false;
  const sample = async () => {
    if (stopped || sampling || controller.signal.aborted) return;
    sampling = true;
    try {
      const leaseRevocation = lease?.revocationReason();
      const permit = leaseRevocation
        ? { allowed: false, mode: 'preempt', reason: leaseRevocation }
        : await governor.permit();
      const allocationReduced = permit.allowed && Number(permit.workerLimit) < activeProfile.workerCount;
      const needsReprofile = permit.allowed && permit.mode !== activeProfile.mode;
      if (!stopped && (!permit.allowed || allocationReduced || needsReprofile)) {
        if (allocationReduced) permit.reason ||= `worker limit reduced from ${activeProfile.workerCount} to ${permit.workerLimit}`;
        if (needsReprofile) permit.reason ||= `resource mode changed from ${activeProfile.mode} to ${permit.mode}`;
        onRevoked(permit);
        controller.abort(permit.reason || 'resource permission revoked');
      }
    } catch (error) {
      if (!stopped) {
        const permit = { allowed: false, reason: `resource permit failed: ${String(error?.message ?? error).slice(0, 256)}` };
        onRevoked(permit);
        controller.abort(permit.reason);
      }
    } finally {
      sampling = false;
    }
  };
  const timer = setInterval(() => { sample().catch(() => {}); }, intervalMs);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}

function interruptibleDelay(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(revocationError(signal));
    }
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function hashFile(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(filename).on('data', (chunk) => hash.update(chunk)).on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export class StockfishWorker {
  constructor(config) {
    this.config = config;
    this.child = null;
    this.lines = [];
    this.waiters = [];
    this.identityLines = [];
    this.optionNames = new Set();
    this.fingerprint = null;
    this.resourceMode = null;
    this.resourceProfile = null;
    this.threads = null;
  }

  async start({ resourceMode = 'courtesy' } = {}) {
    if (this.child) return;
    if (!this.config.stockfishAvailable) throw new Error(`Stockfish executable not found: ${this.config.stockfish}`);
    this.child = spawn(this.config.stockfish, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.once('exit', (code) => this.failWaiters(new Error(`Stockfish exited with code ${code}`)));
    this.child.stderr.on('data', () => {});
    readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', (line) => this.acceptLine(line));
    try { os.setPriority(this.child.pid, os.constants.priority.PRIORITY_LOW); } catch {}
    const native = new NativeResourceHelper(this.config);
    this.resourceMode = resourceMode;
    this.threads = resourceMode === 'background_sip' ? 1 : this.config.analysis.threadsPerWorker;
    this.resourceProfile = await native.applyProcessProfile(this.child.pid, {
      efficiencyCoreLimit: resourceMode === 'background_sip'
        ? this.config.analysis.backgroundSipEfficiencyCores : 0,
    });
    this.send('uci');
    const uciLines = await this.collectUntil((line) => line === 'uciok', 15_000);
    for (const line of uciLines) {
      if (line.startsWith('id ') || line.startsWith('option name EvalFile')) this.identityLines.push(line);
      const option = /^option name (.+?) type /.exec(line);
      if (option) this.optionNames.add(option[1]);
    }
    for (const required of ['Threads', 'Hash']) {
      if (!this.optionNames.has(required)) throw new Error(`Stockfish is missing required UCI option ${required}`);
    }
    this.send(`setoption name Threads value ${this.threads}`);
    this.send(`setoption name Hash value ${this.config.analysis.hashMbPerWorker}`);
    if (this.optionNames.has('UCI_ShowWDL')) this.send('setoption name UCI_ShowWDL value true');
    await this.ready();
    this.send('position startpos');
    this.send('go depth 1');
    await this.collectUntil((line) => line.startsWith('bestmove '), 15_000);
    const executableDigest = await hashFile(this.config.stockfish);
    const evalDigests = [];
    for (const line of this.identityLines.filter((entry) => entry.startsWith('option name EvalFile'))) {
      const defaultValue = /\sdefault\s+(.+?)(?:\svar\s|$)/.exec(line)?.[1]?.trim();
      if (!defaultValue || /^<.*>$/.test(defaultValue)) continue;
      const candidates = [path.resolve(path.dirname(this.config.stockfish), defaultValue), path.resolve(defaultValue)];
      const evalPath = candidates.find((candidate) => existsSync(candidate));
      if (evalPath) evalDigests.push({ name: path.basename(evalPath), sha256: await hashFile(evalPath) });
    }
    this.fingerprint = createHash('sha256').update(JSON.stringify({
      executableDigest, identity: this.identityLines.sort(), threads: this.threads,
      hashMb: this.config.analysis.hashMbPerWorker, evalDigests,
    })).digest('hex');
  }

  acceptLine(line) {
    if (this.waiters.length) {
      const waiter = this.waiters[0];
      waiter.lines.push(line);
      if (waiter.predicate(line)) {
        clearTimeout(waiter.timer);
        this.waiters.shift();
        waiter.resolve(waiter.lines);
      }
    } else {
      this.lines.push(line);
    }
  }

  failWaiters(error) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  collectUntil(predicate, timeoutMs) {
    const consumed = [];
    while (this.lines.length) {
      const line = this.lines.shift();
      consumed.push(line);
      if (predicate(line)) return Promise.resolve(consumed);
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, lines: consumed, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for Stockfish after ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  send(command) {
    if (!this.child?.stdin.writable) throw new Error('Stockfish is not running');
    this.child.stdin.write(`${command}\n`);
  }

  async ready() {
    this.send('isready');
    await this.collectUntil((line) => line === 'readyok', 15_000);
  }

  async analyze(fen, candidates, nodes, { signal } = {}) {
    await this.start();
    if (!candidates.length) return new Map();
    const abort = () => {
      const error = revocationError(signal);
      this.failWaiters(error);
      this.abort(error.message).catch(() => {});
    };
    if (signal?.aborted) throw revocationError(signal);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (this.optionNames.has('MultiPV')) this.send(`setoption name MultiPV value ${candidates.length}`);
      this.send(`position fen ${fen}`);
      this.send(`go nodes ${nodes} searchmoves ${candidates.join(' ')}`);
      const timeoutMs = Math.min(300_000, Math.max(30_000, Math.ceil(nodes / 10)));
      const waiting = this.collectUntil((line) => line.startsWith('bestmove '), timeoutMs);
      if (signal?.aborted) abort();
      const lines = await waiting;
      const results = new Map();
      for (const line of lines) {
        if (!line.startsWith('info ') || !line.includes(' pv ')) continue;
        const pv = /\spv\s+(.+)$/.exec(line)?.[1];
        if (!pv) continue;
        const move = pv.split(/\s+/)[0];
        if (!candidates.includes(move)) continue;
        const cp = /\sscore cp (-?\d+)/.exec(line);
        const mate = /\sscore mate (-?\d+)/.exec(line);
        const wdl = /\swdl (\d+ \d+ \d+)/.exec(line);
        const depth = /\sdepth (\d+)/.exec(line);
        const multipv = /\smultipv (\d+)/.exec(line);
        const result = {
          scoreCp: cp ? Number(cp[1]) : null, mate: mate ? Number(mate[1]) : null,
          wdl: wdl?.[1] ?? null, depth: Number(depth?.[1] ?? 0), pv,
          multipv: Number(multipv?.[1] ?? 1),
        };
        const previous = results.get(move);
        if (!previous || result.depth >= previous.depth) results.set(move, result);
      }
      if (!results.size) throw new Error('Stockfish returned bestmove without parseable candidate analysis');
      return results;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async close() {
    if (!this.child) return;
    const child = this.child;
    try {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (child.stdin.writable) child.stdin.write('quit\n');
      await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 2_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    } finally {
      this.child = null;
    }
  }

  async abort(reason = 'shared heavy background lease revoked') {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.failWaiters(Object.assign(new Error(reason), { code: 'BOOK_FORGE_PREEMPTED' }));
    await shutdownChildProcessTree(this.child, {
      label: 'Book Forge Stockfish',
      gracefulTimeoutMs: 100,
      forceTimeoutMs: 500,
      ultimateTimeoutMs: 1_500,
    });
  }
}

function wdlBucket(wdl) {
  if (!wdl) return 0;
  const [wins, draws, losses] = wdl.split(' ').map(Number);
  if (![wins, draws, losses].every(Number.isFinite)) return 0;
  if (wins > draws && wins > losses) return 1;
  if (losses > draws && losses > wins) return -1;
  return 0;
}

async function analyzeGroup(catalog, config, worker, records, signal) {
  let moves = 0;
  const missing = records.filter((record) => !catalog.evaluation(record, worker.fingerprint, config.analysis.initialNodes));
  if (missing.length) {
    const result = await worker.analyze(records[0].fen, records.map((record) => record.uciMove),
      config.analysis.initialNodes, { signal });
    const numericScores = [...result.values()].filter((entry) => entry.scoreCp !== null).map((entry) => entry.scoreCp);
    const bestScore = numericScores.length ? Math.max(...numericScores) : null;
    const bestWdlBucket = Math.max(...[...result.values()].map((entry) => wdlBucket(entry.wdl)));
    for (const record of missing) {
      const evaluation = result.get(record.uciMove);
      if (!evaluation) continue;
      const relativeLoss = bestScore !== null && evaluation.scoreCp !== null ? bestScore - evaluation.scoreCp : null;
      let lifecycle = 'active';
      if (evaluation.mate !== null && evaluation.mate < 0) lifecycle = 'quarantined_pending_confirmation';
      else if (relativeLoss !== null && relativeLoss > 45) lifecycle = 'quarantined_pending_confirmation';
      else if (relativeLoss !== null && relativeLoss > 30 && wdlBucket(evaluation.wdl) < bestWdlBucket) lifecycle = 'quarantined_pending_confirmation';
      catalog.putEvaluation({ ...record, engineFingerprint: worker.fingerprint, nodeTier: config.analysis.initialNodes,
        scoreCp: evaluation.scoreCp, wdl: evaluation.wdl, mate: evaluation.mate, depth: evaluation.depth,
        relativeLossCp: relativeLoss, pv: evaluation.pv, lifecycle });
      moves += 1;
    }
  }
  const risky = records.filter((record) => {
    const initial = catalog.evaluation(record, worker.fingerprint, config.analysis.initialNodes);
    return initial && (initial.mate < 0 || (initial.relative_loss_cp !== null && initial.relative_loss_cp > 30));
  });
  const unconfirmed = risky.filter((record) => !catalog.evaluation(record, worker.fingerprint, config.analysis.confirmationNodes));
  if (unconfirmed.length) {
    const confirmation = await worker.analyze(records[0].fen, records.map((record) => record.uciMove),
      config.analysis.confirmationNodes, { signal });
    const confirmationScores = [...confirmation.values()].filter((entry) => entry.scoreCp !== null).map((entry) => entry.scoreCp);
    const confirmationBest = confirmationScores.length ? Math.max(...confirmationScores) : null;
    const confirmationBestWdlBucket = Math.max(...[...confirmation.values()].map((entry) => wdlBucket(entry.wdl)));
    for (const record of unconfirmed) {
      const evaluation = confirmation.get(record.uciMove);
      if (!evaluation) continue;
      const relativeLoss = confirmationBest !== null && evaluation.scoreCp !== null ? confirmationBest - evaluation.scoreCp : null;
      const initial = catalog.evaluation(record, worker.fingerprint, config.analysis.initialNodes);
      let lifecycle = relativeLoss !== null && relativeLoss > 30 ? 'conditional' : 'active';
      const bucketLoss = confirmationBestWdlBucket - wdlBucket(evaluation.wdl);
      if (initial?.mate < 0 && evaluation.mate !== null && evaluation.mate < 0) lifecycle = 'retired';
      else if (initial?.relative_loss_cp > 70 && relativeLoss > 70) lifecycle = 'retired';
      else if (initial?.relative_loss_cp > 45 && relativeLoss > 45) lifecycle = 'quarantined';
      else if (relativeLoss > 30 && bucketLoss >= 2) lifecycle = 'retired';
      else if (relativeLoss > 30 && bucketLoss > 0) lifecycle = 'quarantined';
      catalog.putEvaluation({ ...record, engineFingerprint: worker.fingerprint, nodeTier: config.analysis.confirmationNodes,
        scoreCp: evaluation.scoreCp, relativeLossCp: relativeLoss, wdl: evaluation.wdl, mate: evaluation.mate,
        depth: evaluation.depth, pv: evaluation.pv, lifecycle });
    }
  }
  return moves;
}

export async function analyzeObservations(catalog, config, governor, {
  workerFactory = (workerConfig) => new StockfishWorker(workerConfig),
  revocationPollMs = defaultRevocationPollMs,
  lease = null,
} = {}) {
  const observations = catalog.aggregateObservations({ includeFixtures: false });
  if (!observations.length || !config.analysis.enabled || !config.stockfishAvailable) return { positions: 0, moves: 0, skipped: true };
  const grouped = new Map();
  for (const record of observations) {
    const identity = record.fingerprint.toString('hex');
    if (!grouped.has(identity)) grouped.set(identity, []);
    grouped.get(identity).push(record);
  }
  const groups = [...grouped.values()];
  const workers = [];
  let positions = 0;
  let moves = 0;
  try {
    let permit = await governor.permit();
    if (!permit.allowed) {
      return { positions: 0, moves: 0, skipped: true, reason: permit.reason || 'resource permission denied' };
    }
    const firstWorker = workerFactory(config);
    workers.push(firstWorker);
    await firstWorker.start({ resourceMode: permit.mode });
    catalog.setMetadata('current_engine_fingerprint', workers[0].fingerprint);
    for (let index = 0; index < groups.length;) {
      permit = await governor.permit();
      if (!permit.allowed) break;
      if (permit.workerLimit < workers.length || permit.mode !== workers[0].resourceMode) {
        return {
          positions, moves, skipped: false, interrupted: true,
          reason: permit.workerLimit < workers.length
            ? `worker limit reduced from ${workers.length} to ${permit.workerLimit}`
            : `resource mode changed from ${workers[0].resourceMode} to ${permit.mode}`,
          workersUsed: workers.length, engineFingerprint: workers[0].fingerprint,
          resourceMode: permit.mode, processProfiles: workers.map((worker) => worker.resourceProfile),
        };
      }
      const sipCpuSetsProven = permit.mode !== 'background_sip' || (
        workers[0].resourceProfile?.cpu_set_applied === true &&
        workers[0].resourceProfile?.idle_priority === true &&
        workers[0].resourceProfile?.eco_qos === true);
      const desiredWorkers = Math.max(1, Math.min(config.analysis.maximumWorkers,
        sipCpuSetsProven ? permit.workerLimit : 1));
      while (workers.length < desiredWorkers) {
        const worker = workerFactory(config);
        await worker.start({ resourceMode: permit.mode });
        if (worker.fingerprint !== workers[0].fingerprint) {
          await worker.close();
          throw new Error('Stockfish worker fingerprints do not match');
        }
        if (permit.mode === 'background_sip' && (worker.resourceProfile?.cpu_set_applied !== true ||
            worker.resourceProfile?.idle_priority !== true || worker.resourceProfile?.eco_qos !== true)) {
          await worker.close();
          break;
        }
        workers.push(worker);
      }
      const batch = groups.slice(index, index + workers.length);
      const controller = new AbortController();
      let revokedPermit = null;
      const stopMonitoring = monitorResourcePermit(governor, controller,
        (revoked) => { revokedPermit = revoked; }, revocationPollMs,
        { mode: permit.mode, workerCount: workers.length }, lease);
      const tasks = batch.map((records, workerIndex) => analyzeGroup(
        catalog, config, workers[workerIndex], records, controller.signal));
      let results;
      const workStartedAt = performance.now();
      try {
        results = await Promise.all(tasks);
        if (permit.mode === 'background_sip' && permit.dutyCyclePercent < 100) {
          const workMilliseconds = performance.now() - workStartedAt;
          const restMilliseconds = Math.ceil(workMilliseconds *
            (100 - permit.dutyCyclePercent) / permit.dutyCyclePercent);
          await interruptibleDelay(restMilliseconds, controller.signal);
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        const settled = await Promise.allSettled(tasks);
        const completed = settled.filter((entry) => entry.status === 'fulfilled');
        moves += completed.reduce((sum, entry) => sum + entry.value, 0);
        positions += completed.length;
        return {
          positions, moves, skipped: false, interrupted: true,
          reason: revokedPermit?.reason || String(controller.signal.reason || 'resource permission revoked'),
          workersUsed: workers.length, engineFingerprint: workers[0].fingerprint,
          resourceMode: permit.mode, processProfiles: workers.map((worker) => worker.resourceProfile),
        };
      } finally {
        stopMonitoring();
      }
      moves += results.reduce((sum, count) => sum + count, 0);
      positions += batch.length;
      index += batch.length;
    }
  } finally {
    await Promise.all(workers.map((worker) => worker.close()));
  }
  return {
    positions, moves, skipped: false, workersUsed: workers.length,
    engineFingerprint: workers[0]?.fingerprint ?? null,
    resourceMode: workers[0]?.resourceMode ?? null,
    processProfiles: workers.map((worker) => worker.resourceProfile),
  };
}
