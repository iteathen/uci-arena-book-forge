import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { encodePolyglotMove, legalUciMove, keyHex, moveHex, polyglotKey } from './chess.mjs';
import { parsePolicy, scoreSiblingCandidates } from './book_policy.mjs';

export { parsePolicy } from './book_policy.mjs';

const compilerVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const maximumSnapshotRecords = 2_000_000;
const maximumManifestBytes = 1_048_576;
const maximumPolicyBytes = 1_048_576;
const maximumProvenanceBytes = 524_288;
const artifactBufferBytes = 1_048_576;
const snapshotSchema = 'uci_arena_book_snapshot_v2';
const snapshotArtifacts = Object.freeze([
  'strong_rare_v1.bin',
  'strong_rare_v1.stats',
  'strong_rare_v1.policy',
  'evaluation.audit.jsonl',
]);

async function requireRegularFile(filename, maximumBytes, exactBytes = null) {
  const details = await lstat(filename);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Snapshot artifact is not a regular file: ${path.basename(filename)}`);
  if (exactBytes !== null && details.size !== exactBytes) throw new Error(`Snapshot artifact size mismatch: ${path.basename(filename)}`);
  if (details.size > maximumBytes) throw new Error(`Snapshot artifact exceeds its size contract: ${path.basename(filename)}`);
  return details;
}

function updateFnv1a64(value, bytes) {
  let result = value;
  for (const byte of bytes) {
    result ^= BigInt(byte);
    result = BigInt.asUintN(64, result * 0x100000001b3n);
  }
  return result;
}

export function fnv1a64(bytes) {
  return updateFnv1a64(0xcbf29ce484222325n, bytes);
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

async function* boundedLines(filename, maximumLineBytes) {
  let pending = Buffer.alloc(0);
  for await (const chunk of createReadStream(filename)) {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      if (newline === -1) {
        const suffix = chunk.subarray(offset);
        if (pending.length + suffix.length > maximumLineBytes + 1) {
          throw new Error(`${path.basename(filename)} line exceeds ${maximumLineBytes} bytes`);
        }
        pending = pending.length ? Buffer.concat([pending, suffix]) : Buffer.from(suffix);
        break;
      }
      const segment = chunk.subarray(offset, newline);
      if (pending.length + segment.length > maximumLineBytes + 1) {
        throw new Error(`${path.basename(filename)} line exceeds ${maximumLineBytes} bytes`);
      }
      let line = pending.length ? Buffer.concat([pending, segment]) : segment;
      if (line.length && line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.length > maximumLineBytes) {
        throw new Error(`${path.basename(filename)} line exceeds ${maximumLineBytes} bytes`);
      }
      yield line.toString('utf8');
      pending = Buffer.alloc(0);
      offset = newline + 1;
    }
  }
  if (pending.length) {
    if (pending.at(-1) === 0x0d) pending = pending.subarray(0, -1);
    if (pending.length > maximumLineBytes) {
      throw new Error(`${path.basename(filename)} line exceeds ${maximumLineBytes} bytes`);
    }
    yield pending.toString('utf8');
  }
}

class BufferedArtifactWriter {
  constructor(filename) {
    this.stream = createWriteStream(filename, { flags: 'wx' });
    this.buffer = Buffer.allocUnsafe(artifactBufferBytes);
    this.offset = 0;
    this.hash = createHash('sha256');
  }

  append(bytes) {
    this.hash.update(bytes);
    if (bytes.length <= this.buffer.length - this.offset) {
      bytes.copy(this.buffer, this.offset);
      this.offset += bytes.length;
      return null;
    }
    return this.flushAndAppend(bytes);
  }

  async flushAndAppend(bytes) {
    await this.flush();
    if (bytes.length > this.buffer.length) {
      if (!this.stream.write(bytes)) await once(this.stream, 'drain');
      return;
    }
    bytes.copy(this.buffer, 0);
    this.offset = bytes.length;
  }

  async flush() {
    if (this.offset === 0) return;
    const chunk = Buffer.from(this.buffer.subarray(0, this.offset));
    this.offset = 0;
    if (!this.stream.write(chunk)) await once(this.stream, 'drain');
  }

  async close() {
    await this.flush();
    this.stream.end();
    await finished(this.stream);
    return this.hash.digest('hex');
  }

  destroy() {
    this.stream.destroy();
  }
}

function sqliteRowToRecord(row) {
  const keyBuffer = Buffer.from(row.key_buffer);
  return {
    fingerprint: Buffer.from(row.fingerprint),
    keyBuffer,
    key: keyBuffer.readBigUInt64BE(),
    fen: row.fen,
    rawMove: Number(row.raw_move),
    uciMove: row.uci_move,
    games: Number(row.games),
    wins: Number(row.wins),
    draws: Number(row.draws),
    losses: Number(row.losses),
    posterior: Number(row.posterior),
    lcb: Number(row.lcb),
    selectionWeight: Number(row.selection_weight),
    qualityWeight: Number(row.quality_weight),
    auditEvaluation: row.audit_evaluation_json === null
      ? null : JSON.parse(row.audit_evaluation_json),
  };
}

class CandidateStore {
  constructor(filename) {
    this.database = new DatabaseSync(filename);
    this.database.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=OFF;
      PRAGMA temp_store=FILE;
      PRAGMA cache_size=-8192;
      CREATE TABLE position_identity (
        key_buffer BLOB PRIMARY KEY,
        fingerprint BLOB NOT NULL UNIQUE,
        fen TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE candidates (
        id INTEGER PRIMARY KEY,
        fingerprint BLOB NOT NULL,
        key_buffer BLOB NOT NULL,
        fen TEXT NOT NULL,
        raw_move INTEGER NOT NULL,
        uci_move TEXT NOT NULL,
        games INTEGER NOT NULL,
        wins INTEGER NOT NULL,
        draws INTEGER NOT NULL,
        losses INTEGER NOT NULL,
        posterior REAL NOT NULL,
        lcb REAL NOT NULL,
        selection_weight REAL NOT NULL,
        quality_weight REAL NOT NULL,
        audit_evaluation_json TEXT,
        UNIQUE(key_buffer,raw_move)
      );
    `);
    this.insertPosition = this.database.prepare(`
      INSERT OR IGNORE INTO position_identity(key_buffer,fingerprint,fen) VALUES(?,?,?)
    `);
    this.selectPosition = this.database.prepare(`
      SELECT fingerprint,fen FROM position_identity WHERE key_buffer=?
    `);
    this.insertCandidate = this.database.prepare(`
      INSERT INTO candidates(
        fingerprint,key_buffer,fen,raw_move,uci_move,games,wins,draws,losses,
        posterior,lcb,selection_weight,quality_weight,audit_evaluation_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    this.transactionOpen = false;
    this.pending = 0;
  }

  begin() {
    if (!this.transactionOpen) {
      this.database.exec('BEGIN');
      this.transactionOpen = true;
    }
  }

  checkpoint() {
    if (!this.transactionOpen) return;
    this.database.exec('COMMIT');
    this.transactionOpen = false;
    this.pending = 0;
  }

  addGroup(records) {
    if (!records.length) return;
    this.begin();
    const first = records[0];
    this.insertPosition.run(first.keyBuffer, first.fingerprint, first.fen);
    const stored = this.selectPosition.get(first.keyBuffer);
    if (!stored || !Buffer.from(stored.fingerprint).equals(first.fingerprint)
        || stored.fen !== first.fen) {
      throw new Error(`Polyglot key collision prevents unambiguous snapshot publication: ${keyHex(first.key)}`);
    }
    for (const record of records) {
      this.insertCandidate.run(
        record.fingerprint,
        record.keyBuffer,
        record.fen,
        record.rawMove,
        record.uciMove,
        record.games,
        record.wins,
        record.draws,
        record.losses,
        record.posterior,
        record.lcb,
        record.selectionWeight,
        record.qualityWeight,
        record.auditEvaluation === null ? null : JSON.stringify(record.auditEvaluation),
      );
      this.pending += 1;
    }
    if (this.pending >= 4096) this.checkpoint();
  }

  finalize() {
    this.checkpoint();
    this.database.exec(`
      CREATE INDEX candidates_rank_idx
        ON candidates(lcb DESC,games ASC,key_buffer ASC,raw_move ASC);
      CREATE TABLE selected AS
        SELECT fingerprint,key_buffer,fen,raw_move,uci_move,games,wins,draws,losses,
               posterior,lcb,selection_weight,quality_weight,audit_evaluation_json
        FROM candidates
        ORDER BY lcb DESC,games ASC,key_buffer ASC,raw_move ASC
        LIMIT ${maximumSnapshotRecords};
      CREATE UNIQUE INDEX selected_order_idx ON selected(key_buffer,raw_move);
    `);
    return Number(this.database.prepare('SELECT COUNT(*) AS count FROM selected').get().count);
  }

  *groups() {
    const rows = this.database.prepare(`
      SELECT * FROM selected ORDER BY key_buffer,raw_move
    `).iterate();
    let keyBuffer = null;
    let group = [];
    for (const row of rows) {
      const record = sqliteRowToRecord(row);
      if (keyBuffer && !keyBuffer.equals(record.keyBuffer)) {
        yield group;
        group = [];
      }
      keyBuffer = record.keyBuffer;
      group.push(record);
    }
    if (group.length) yield group;
  }

  *records() {
    const rows = this.database.prepare(`
      SELECT fingerprint FROM selected ORDER BY key_buffer,raw_move
    `).iterate();
    for (const row of rows) yield { fingerprint: Buffer.from(row.fingerprint) };
  }

  close() {
    if (this.transactionOpen) {
      try { this.database.exec('ROLLBACK'); } catch {}
    }
    this.database.close();
  }
}

class MetricsStore {
  constructor(filename) {
    this.database = new DatabaseSync(filename);
    this.database.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=OFF;
      PRAGMA temp_store=FILE;
      PRAGMA cache_size=-4096;
      CREATE TABLE samples (
        rare_popularity REAL NOT NULL,
        baseline_popularity REAL NOT NULL,
        rare_lcb REAL NOT NULL,
        baseline_lcb REAL NOT NULL
      );
      BEGIN;
    `);
    this.insert = this.database.prepare(`
      INSERT INTO samples(rare_popularity,baseline_popularity,rare_lcb,baseline_lcb)
      VALUES(?,?,?,?)
    `);
    this.pending = 0;
  }

  add(sample) {
    this.insert.run(
      sample.rarePopularity,
      sample.baselinePopularity,
      sample.rareLcb,
      sample.baselineLcb,
    );
    this.pending += 1;
    if (this.pending >= 4096) {
      this.database.exec('COMMIT; BEGIN;');
      this.pending = 0;
    }
  }

  median(column, count) {
    const offset = Math.floor((count - 1) / 2);
    const limit = count % 2 === 0 ? 2 : 1;
    const rows = this.database.prepare(`
      SELECT ${column} AS value FROM samples ORDER BY ${column} LIMIT ? OFFSET ?
    `).all(limit, offset);
    return rows.reduce((sum, row) => sum + Number(row.value), 0) / rows.length;
  }

  finalize() {
    this.database.exec(`
      COMMIT;
      CREATE INDEX samples_rare_popularity_idx ON samples(rare_popularity);
      CREATE INDEX samples_baseline_popularity_idx ON samples(baseline_popularity);
    `);
    const aggregate = this.database.prepare(`
      SELECT COUNT(*) AS count,AVG(rare_lcb) AS mean_rare_lcb,
             AVG(baseline_lcb) AS mean_baseline_lcb FROM samples
    `).get();
    const count = Number(aggregate.count);
    if (count === 0) {
      return {
        medianRarePopularity: 0,
        medianBaselinePopularity: 0,
        popularityReduction: 0,
        meanRareLcb: 0,
        meanBaselineLcb: 0,
        meanLcbRegression: 0,
      };
    }
    const medianRarePopularity = this.median('rare_popularity', count);
    const medianBaselinePopularity = this.median('baseline_popularity', count);
    const meanRareLcb = Number(aggregate.mean_rare_lcb);
    const meanBaselineLcb = Number(aggregate.mean_baseline_lcb);
    return {
      medianRarePopularity,
      medianBaselinePopularity,
      popularityReduction: medianBaselinePopularity > 0
        ? 1 - medianRarePopularity / medianBaselinePopularity : 0,
      meanRareLcb,
      meanBaselineLcb,
      meanLcbRegression: meanBaselineLcb - meanRareLcb,
    };
  }

  close() {
    try { this.database.exec('ROLLBACK'); } catch {}
    this.database.close();
  }
}

function scalePublishedCounts(records) {
  const factor = Math.max(1, Math.ceil(
    Math.max(...records.map((record) => record.games)) / 0xffff_ffff,
  ));
  if (factor === 1) return;
  for (const record of records) {
    const target = Math.max(1, Math.floor(record.games / factor));
    const exact = [record.wins, record.draws, record.losses]
      .map((value) => value * target / record.games);
    const scaled = exact.map(Math.floor);
    let remainder = target - scaled.reduce((sum, value) => sum + value, 0);
    const order = [0, 1, 2].sort((left, right) =>
      (exact[right] - scaled[right]) - (exact[left] - scaled[left]) || left - right);
    for (let index = 0; remainder > 0; index = (index + 1) % order.length) {
      scaled[order[index]] += 1;
      remainder -= 1;
    }
    [record.wins, record.draws, record.losses] = scaled;
    record.games = target;
  }
}

function qualificationSample(siblings) {
  const maxGames = Math.max(...siblings.map((row) => row.games));
  const rareTotal = siblings.reduce((sum, row) => sum + row.selectionWeight, 0);
  const baselineTotal = siblings.reduce((sum, row) => sum + row.qualityWeight, 0);
  return {
    rarePopularity: siblings.reduce((sum, row) =>
      sum + row.selectionWeight / rareTotal * row.games / maxGames, 0),
    baselinePopularity: siblings.reduce((sum, row) =>
      sum + row.qualityWeight / baselineTotal * row.games / maxGames, 0),
    rareLcb: siblings.reduce((sum, row) =>
      sum + row.selectionWeight / rareTotal * row.lcb, 0),
    baselineLcb: siblings.reduce((sum, row) =>
      sum + row.qualityWeight / baselineTotal * row.lcb, 0),
  };
}

function stableEvaluation(evaluation) {
  if (!evaluation) return null;
  return {
    engine_fingerprint: evaluation.engine_fingerprint,
    node_tier: Number(evaluation.node_tier),
    score_cp: evaluation.score_cp,
    relative_loss_cp: evaluation.relative_loss_cp,
    wdl: evaluation.wdl,
    mate: evaluation.mate,
    depth: Number(evaluation.depth),
    pv: evaluation.pv,
    lifecycle: evaluation.lifecycle,
  };
}

function collectCandidates(catalog, config, channel, policy, store) {
  const includeFixtures = channel === 'integration';
  const currentEngineFingerprint = catalog.metadata('current_engine_fingerprint');
  let groups = 0;
  for (const observations of catalog.iterateAggregateObservationGroups({ includeFixtures })) {
    const active = [];
    for (const record of observations) {
      const auditEvaluation = catalog.latestEvaluation(
        record,
        0,
        currentEngineFingerprint,
      );
      if (currentEngineFingerprint
          && ['quarantined', 'retired'].includes(auditEvaluation?.lifecycle)) {
        continue;
      }
      record.auditEvaluation = stableEvaluation(auditEvaluation);
      active.push(record);
    }
    const { eligible } = scoreSiblingCandidates(active, policy);
    eligible.sort((left, right) =>
      right.selectionWeight - left.selectionWeight
      || right.lcb - left.lcb
      || left.rawMove - right.rawMove);
    store.addGroup(eligible.slice(0, 6));
    groups += 1;
  }
  return { currentEngineFingerprint, groups };
}

function collectSourceEvidence(catalog, includeFixtures) {
  const sourceEvidence = [];
  let approximateBytes = 0;
  const append = (entry) => {
    approximateBytes += Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
    if (approximateBytes > maximumProvenanceBytes) {
      throw new Error('Snapshot source evidence exceeds the bounded manifest contract');
    }
    sourceEvidence.push(entry);
  };
  const localRows = catalog.iterateCompletedSources?.()
    ?? catalog.completedSources();
  for (const source of localRows) {
    if (source.contribution_mode !== 'additive' || (!includeFixtures && source.fixture)) continue;
    append({
      sha256: source.sha256,
      source_type: source.source_type,
      fixture: Boolean(source.fixture),
      overlap_domain: source.overlap_domain,
      contribution_mode: source.contribution_mode,
      games_seen: Number(source.games_seen),
      games_accepted: Number(source.games_accepted),
      chunks: Number(source.chunks),
    });
  }
  const remoteRows = catalog.iterateAcquisitionEvidence?.()
    ?? catalog.acquisitionEvidence();
  for (const source of remoteRows) {
    if (source.contribution_mode !== 'authoritative'
        || !catalog.acquisitionDatasetHasObservations(source.id)) continue;
    append({
      sha256: source.query_digest,
      source_type: source.provider,
      fixture: false,
      overlap_domain: source.overlap_domain,
      contribution_mode: source.contribution_mode,
      query: source.query,
    });
  }
  sourceEvidence.sort((left, right) =>
    left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0);
  return sourceEvidence;
}

function validatePublishedRecord(record) {
  for (const value of [record.games, record.wins, record.draws, record.losses]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new Error('Observation counts exceed the book-stats u32 contract');
    }
  }
  if (record.games <= 0 || record.games !== record.wins + record.draws + record.losses) {
    throw new Error('Observation outcomes do not sum to games');
  }
  if (!legalUciMove(record.fen, record.uciMove)) {
    throw new Error(`Illegal emitted move ${record.uciMove} for ${record.fen}`);
  }
}

async function writeBookArtifact(
  store,
  metricsStore,
  filename,
  channel,
  { catalog, config, currentEngineFingerprint },
) {
  const writer = new BufferedArtifactWriter(filename);
  let fnv = 0xcbf29ce484222325n;
  let recordCount = 0;
  let missingQualificationEvaluations = 0;
  let pendingConfirmation = false;
  try {
    for (const group of store.groups()) {
      metricsStore.add(qualificationSample(group));
      scalePublishedCounts(group);
      const bytes = Buffer.allocUnsafe(group.length * 16);
      for (let index = 0; index < group.length; index += 1) {
        const record = group[index];
        validatePublishedRecord(record);
        const offset = index * 16;
        bytes.writeBigUInt64BE(record.key, offset);
        bytes.writeUInt16BE(record.rawMove, offset + 8);
        bytes.writeUInt16BE(Math.max(1, Math.min(65535, record.games)), offset + 10);
        bytes.writeUInt32BE(0, offset + 12);
        if (channel === 'qualified') {
          const qualificationEvaluation = currentEngineFingerprint
            ? stableEvaluation(catalog.latestEvaluation(
              record,
              config.analysis.initialNodes,
              currentEngineFingerprint,
            ))
            : null;
          if (!qualificationEvaluation) missingQualificationEvaluations += 1;
          if (qualificationEvaluation?.lifecycle
              === 'quarantined_pending_confirmation') pendingConfirmation = true;
        }
      }
      fnv = updateFnv1a64(fnv, bytes);
      const pending = writer.append(bytes);
      if (pending) await pending;
      recordCount += group.length;
    }
    const digest = await writer.close();
    return {
      digest,
      fnv: fnv.toString(16).padStart(16, '0'),
      recordCount,
      missingQualificationEvaluations,
      pendingConfirmation,
    };
  } catch (error) {
    writer.destroy();
    throw error;
  }
}

async function writeStatsArtifact(store, filename, bookFnv, recordCount) {
  const writer = new BufferedArtifactWriter(filename);
  try {
    let pending = writer.append(Buffer.from(
      `# uci_arena_book_stats_v1 book_fnv1a64=${bookFnv} rows=${recordCount}\n`,
      'utf8',
    ));
    if (pending) await pending;
    let rows = 0;
    for (const group of store.groups()) {
      scalePublishedCounts(group);
      for (const record of group) {
        const line = Buffer.from(`${[
          keyHex(record.key),
          moveHex(record.rawMove),
          record.games,
          record.wins,
          record.draws,
          record.losses,
        ].join('\t')}\n`, 'utf8');
        if (line.length > 512) throw new Error('Stats row exceeds the bounded line contract');
        pending = writer.append(line);
        if (pending) await pending;
        rows += 1;
      }
    }
    if (rows !== recordCount) throw new Error('Stats construction record count mismatch');
    return await writer.close();
  } catch (error) {
    writer.destroy();
    throw error;
  }
}

async function writeAuditArtifact(store, filename, recordCount) {
  const writer = new BufferedArtifactWriter(filename);
  try {
    let rows = 0;
    for (const group of store.groups()) {
      scalePublishedCounts(group);
      for (const record of group) {
        const line = Buffer.from(`${JSON.stringify({
          key: keyHex(record.key),
          move: moveHex(record.rawMove),
          uci: record.uciMove,
          fen: record.fen,
          games: record.games,
          wins: record.wins,
          draws: record.draws,
          losses: record.losses,
          posterior: Number(record.posterior.toFixed(12)),
          lcb: Number(record.lcb.toFixed(12)),
          selection_weight: Number(record.selectionWeight.toPrecision(12)),
          evaluation: record.auditEvaluation,
        })}\n`, 'utf8');
        if (line.length > 4096) throw new Error('Audit row exceeds the bounded line contract');
        const pending = writer.append(line);
        if (pending) await pending;
        rows += 1;
      }
    }
    if (rows !== recordCount) throw new Error('Audit construction record count mismatch');
    return await writer.close();
  } catch (error) {
    writer.destroy();
    throw error;
  }
}

async function hashSnapshotArtifacts(directory, provenanceBytes) {
  const contentHash = createHash('sha256');
  contentHash.update(Buffer.from(`${snapshotSchema}\0`, 'utf8'));
  const artifactDigests = {};
  let bookFnv = 0xcbf29ce484222325n;
  for (const name of snapshotArtifacts) {
    const artifactHash = createHash('sha256');
    contentHash.update(Buffer.from(`${name}\0`, 'utf8'));
    for await (const chunk of createReadStream(path.join(directory, name))) {
      artifactHash.update(chunk);
      contentHash.update(chunk);
      if (name === 'strong_rare_v1.bin') bookFnv = updateFnv1a64(bookFnv, chunk);
    }
    artifactDigests[name] = artifactHash.digest('hex');
  }
  contentHash.update(provenanceBytes);
  return {
    artifactDigests,
    contentIdentity: contentHash.digest('hex').slice(0, 20),
    bookFnv: bookFnv.toString(16).padStart(16, '0'),
  };
}

function qualificationErrors(catalog, currentEngineFingerprint, summary, contentId, metrics) {
  const errors = [];
  if (!currentEngineFingerprint) errors.push('no current Stockfish fingerprint is registered');
  const missing = currentEngineFingerprint
    ? summary.missingQualificationEvaluations : summary.recordCount;
  if (missing) errors.push(`${missing} emitted moves lack current Stockfish evidence`);
  if (summary.pendingConfirmation) {
    errors.push('one or more emitted moves still require confirmation analysis');
  }
  if (metrics.popularityReduction < 0.20) {
    errors.push(`rarity popularity reduction ${metrics.popularityReduction.toFixed(4)} is below 0.20`);
  }
  if (metrics.meanLcbRegression > 0.01) {
    errors.push(`mean LCB regression ${metrics.meanLcbRegression.toFixed(4)} exceeds 0.01`);
  }
  const gates = new Map(catalog.qualificationGates(contentId)
    .map((gate) => [gate.gate, gate]));
  const match = gates.get('paired_color_non_inferiority');
  if (!match?.passed || Number(match.evidence.elo_lower_bound) < -5) {
    errors.push('paired-color Elo lower bound is missing or below -5');
  }
  const compatibility = gates.get('uci_compatibility');
  if (!compatibility?.passed || Number(compatibility.evidence.regressions) !== 0) {
    errors.push('zero-regression UCI compatibility evidence is missing');
  }
  return errors;
}

export async function buildSnapshot(catalog, config, channel = 'integration') {
  if (!['integration', 'qualified'].includes(channel)) throw new Error(`Unknown channel: ${channel}`);
  const includeFixtures = channel === 'integration';
  const policyBytes = await readFile(config.policyFile);
  if (policyBytes.length > maximumPolicyBytes) throw new Error('Opening-book policy exceeds its size contract');
  const policy = parsePolicy(policyBytes.toString('utf8'));
  await mkdir(config.paths.snapshots, { recursive: true });
  const workRoot = path.join(
    config.paths.snapshots,
    `.build-${channel}-${process.pid}-${Date.now()}.tmp`,
  );
  const artifactDirectory = path.join(workRoot, 'snapshot');
  await rm(workRoot, { recursive: true, force: true });
  await mkdir(artifactDirectory, { recursive: true });
  let candidates;
  let metricsStore;
  try {
    candidates = new CandidateStore(path.join(workRoot, 'candidates.sqlite'));
    metricsStore = new MetricsStore(path.join(workRoot, 'metrics.sqlite'));
    const { currentEngineFingerprint } = collectCandidates(
      catalog,
      config,
      channel,
      policy,
      candidates,
    );
    const selectedCount = candidates.finalize();
    if (selectedCount === 0) throw new Error('No observations satisfy the opening-book policy');

    const sourceEvidence = collectSourceEvidence(catalog, includeFixtures);
    const corpusFilter = {
      variant: 'standard',
      speeds: [...config.ingestion.speeds].sort(),
      minimum_rating_both: config.ingestion.minimumRating,
      maximum_ply: config.ingestion.maximumPly,
      require_normal_result: true,
    };
    const provenanceBytes = Buffer.from(JSON.stringify({
      source_evidence: sourceEvidence,
      corpus_filter: corpusFilter,
    }), 'utf8');
    if (provenanceBytes.length > maximumProvenanceBytes) {
      throw new Error('Snapshot provenance exceeds the bounded manifest contract');
    }

    const bookSummary = await writeBookArtifact(
      candidates,
      metricsStore,
      path.join(artifactDirectory, 'strong_rare_v1.bin'),
      channel,
      { catalog, config, currentEngineFingerprint },
    );
    if (bookSummary.recordCount !== selectedCount) {
      throw new Error('Book construction record count mismatch');
    }
    const metrics = metricsStore.finalize();
    await writeStatsArtifact(
      candidates,
      path.join(artifactDirectory, 'strong_rare_v1.stats'),
      bookSummary.fnv,
      selectedCount,
    );
    await writeFile(path.join(artifactDirectory, 'strong_rare_v1.policy'), policyBytes, {
      flag: 'wx',
    });
    await writeAuditArtifact(
      candidates,
      path.join(artifactDirectory, 'evaluation.audit.jsonl'),
      selectedCount,
    );

    const identities = await hashSnapshotArtifacts(artifactDirectory, provenanceBytes);
    if (identities.bookFnv !== bookSummary.fnv) {
      throw new Error('Streamed book identity changed after construction');
    }
    const contentIdentity = identities.contentIdentity;
    if (channel === 'qualified') {
      const errors = qualificationErrors(
        catalog,
        currentEngineFingerprint,
        bookSummary,
        contentIdentity,
        metrics,
      );
      if (errors.length) throw new Error(`Qualified publication blocked: ${errors.join('; ')}`);
    }
    const snapshotId = `${channel}-${contentIdentity}`;
    const finalDirectory = path.join(config.paths.snapshots, snapshotId);
    const manifest = {
      schema: snapshotSchema,
      snapshot_id: snapshotId,
      channel,
      record_count: selectedCount,
      includes_fixture: sourceEvidence.some((source) => source.fixture),
      qualified: channel === 'qualified',
      artifacts: identities.artifactDigests,
      qualification_metrics: metrics,
      source_evidence: sourceEvidence,
      corpus_filter: corpusFilter,
      compiler: {
        package: '@uci-arena/book-forge',
        version: compilerVersion,
        observation_shards: 64,
      },
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    if (manifestBytes.length > maximumManifestBytes) {
      throw new Error('Snapshot manifest exceeds its size contract');
    }
    await writeFile(path.join(artifactDirectory, 'snapshot.manifest.json'), manifestBytes, {
      flag: 'wx',
    });

    try {
      await stat(finalDirectory);
      const validation = await validateSnapshot(finalDirectory);
      if (channel === 'integration') catalog.markPublishedFrontier(candidates.records());
      return { ...validation, id: snapshotId, directory: finalDirectory };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    await validateSnapshot(artifactDirectory);
    await rename(artifactDirectory, finalDirectory);
    const manifestSha256 = sha256(manifestBytes);
    catalog.addSnapshot({
      id: snapshotId,
      channel,
      directory: finalDirectory,
      recordCount: selectedCount,
      includesFixture: manifest.includes_fixture,
      qualified: manifest.qualified,
      manifestSha256,
    });
    if (channel === 'integration') catalog.markPublishedFrontier(candidates.records());
    return {
      id: snapshotId,
      directory: finalDirectory,
      recordCount: selectedCount,
      includesFixture: manifest.includes_fixture,
      qualified: manifest.qualified,
      manifestSha256,
    };
  } finally {
    try {
      metricsStore?.close();
    } finally {
      try {
        candidates?.close();
      } finally {
        await rm(workRoot, { recursive: true, force: true });
      }
    }
  }
}

async function validateSnapshotRows({
  bookPath,
  statsPath,
  auditPath,
  recordCount,
  expectedFnv,
}) {
  const statsLines = boundedLines(statsPath, 512);
  const auditLines = boundedLines(auditPath, 4096);
  const statsIterator = statsLines[Symbol.asyncIterator]();
  const auditIterator = auditLines[Symbol.asyncIterator]();
  try {
    const header = await statsIterator.next();
    if (header.done || header.value
        !== `# uci_arena_book_stats_v1 book_fnv1a64=${expectedFnv} rows=${recordCount}`) {
      throw new Error('Invalid stats header');
    }
    let previousKey = -1n;
    let previousMove = -1;
    let rows = 0;
    let carry = Buffer.alloc(0);
    for await (const chunk of createReadStream(bookPath)) {
      const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const completeBytes = bytes.length - (bytes.length % 16);
      for (let offset = 0; offset < completeBytes; offset += 16) {
        const key = bytes.readBigUInt64BE(offset);
        const move = bytes.readUInt16BE(offset + 8);
        const weight = bytes.readUInt16BE(offset + 10);
        const learn = bytes.readUInt32BE(offset + 12);
        if (key < previousKey || (key === previousKey && move <= previousMove)) {
          throw new Error('Polyglot records are not strictly ordered');
        }
        if (weight === 0 || learn !== 0) {
          throw new Error(`Invalid Polyglot payload at row ${rows}`);
        }
        const statsRow = await statsIterator.next();
        if (statsRow.done) {
          throw new Error(`Stats row count or line bound mismatch at row ${rows}`);
        }
        const columns = statsRow.value.split('\t');
        if (columns.length !== 6 || columns[0] !== keyHex(key)
            || columns[1] !== moveHex(move)) {
          throw new Error(`Stats parity mismatch at row ${rows}`);
        }
        const [games, wins, draws, losses] = columns.slice(2).map(Number);
        if (![games, wins, draws, losses].every((value) =>
          Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff)
            || games <= 0 || games !== wins + draws + losses) {
          throw new Error(`Invalid stats outcomes at row ${rows}`);
        }
        const auditLine = await auditIterator.next();
        if (auditLine.done) {
          throw new Error(`Audit row count or line bound mismatch at row ${rows}`);
        }
        let auditRow;
        try { auditRow = JSON.parse(auditLine.value); } catch {
          throw new Error(`Invalid audit JSON at row ${rows}`);
        }
        if (!auditRow || typeof auditRow !== 'object'
            || auditRow.key !== columns[0] || auditRow.move !== columns[1]
            || auditRow.games !== games || auditRow.wins !== wins
            || auditRow.draws !== draws || auditRow.losses !== losses
            || !legalUciMove(auditRow.fen, auditRow.uci)
            || polyglotKey(auditRow.fen) !== key
            || encodePolyglotMove(auditRow.uci) !== move) {
          throw new Error(`Audit legality mismatch at row ${rows}`);
        }
        previousKey = key;
        previousMove = move;
        rows += 1;
      }
      carry = Buffer.from(bytes.subarray(completeBytes));
    }
    if (carry.length !== 0 || rows !== recordCount) {
      throw new Error('Invalid Polyglot record count');
    }
    if (!(await statsIterator.next()).done) throw new Error('Stats row count mismatch');
    if (!(await auditIterator.next()).done) throw new Error('Audit row count mismatch');
  } finally {
    await statsIterator.return?.();
    await auditIterator.return?.();
  }
}

export async function validateSnapshot(directory) {
  const directoryDetails = await lstat(directory);
  if (!directoryDetails.isDirectory() || directoryDetails.isSymbolicLink()) throw new Error('Snapshot root is not a regular directory');
  const manifestPath = path.join(directory, 'snapshot.manifest.json');
  await requireRegularFile(manifestPath, maximumManifestBytes);
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.schema !== snapshotSchema) throw new Error('Unsupported snapshot manifest schema');
  if (!['integration', 'qualified'].includes(manifest.channel)
      || manifest.qualified !== (manifest.channel === 'qualified')) {
    throw new Error('Invalid snapshot channel metadata');
  }
  if (!Number.isSafeInteger(manifest.record_count) || manifest.record_count < 1
      || manifest.record_count > maximumSnapshotRecords) {
    throw new Error('Snapshot record count is outside the supported range');
  }
  if (!Array.isArray(manifest.source_evidence)) throw new Error('Snapshot source evidence is missing');
  if (!manifest.corpus_filter || typeof manifest.corpus_filter !== 'object') throw new Error('Snapshot corpus filter evidence is missing');
  if (manifest.includes_fixture
      !== manifest.source_evidence.some((source) => source.fixture === true)) {
    throw new Error('Snapshot fixture provenance mismatch');
  }
  const bookPath = path.join(directory, 'strong_rare_v1.bin');
  const statsPath = path.join(directory, 'strong_rare_v1.stats');
  const policyPath = path.join(directory, 'strong_rare_v1.policy');
  const auditPath = path.join(directory, 'evaluation.audit.jsonl');
  await Promise.all([
    requireRegularFile(bookPath, maximumSnapshotRecords * 16, manifest.record_count * 16),
    requireRegularFile(statsPath, manifest.record_count * 128 + 1_024),
    requireRegularFile(policyPath, maximumPolicyBytes),
    requireRegularFile(auditPath, manifest.record_count * 4_096 + 1),
  ]);
  const expectedArtifacts = [...snapshotArtifacts];
  if (!manifest.artifacts || Object.keys(manifest.artifacts).sort().join(',')
      !== expectedArtifacts.sort().join(',')) {
    throw new Error('Snapshot artifact set mismatch');
  }
  const provenanceBytes = Buffer.from(JSON.stringify({
    source_evidence: manifest.source_evidence,
    corpus_filter: manifest.corpus_filter,
  }), 'utf8');
  if (provenanceBytes.length > maximumProvenanceBytes) {
    throw new Error('Snapshot provenance exceeds the bounded manifest contract');
  }
  const identities = await hashSnapshotArtifacts(directory, provenanceBytes);
  for (const [name, digest] of Object.entries(identities.artifactDigests)) {
    if (manifest.artifacts[name] !== digest) throw new Error(`Snapshot digest mismatch: ${name}`);
  }
  if (manifest.snapshot_id !== `${manifest.channel}-${identities.contentIdentity}`) {
    throw new Error('Snapshot content identity mismatch');
  }
  const policy = await readFile(policyPath);
  parsePolicy(policy.toString('utf8'));
  await validateSnapshotRows({
    bookPath,
    statsPath,
    auditPath,
    recordCount: manifest.record_count,
    expectedFnv: identities.bookFnv,
  });
  return {
    id: manifest.snapshot_id,
    channel: manifest.channel,
    directory: path.resolve(directory),
    recordCount: manifest.record_count,
    includesFixture: manifest.includes_fixture,
    qualified: manifest.qualified,
    manifestSha256: sha256(manifestBytes),
  };
}
