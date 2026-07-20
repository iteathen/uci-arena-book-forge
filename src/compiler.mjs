import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { encodePolyglotMove, legalUciMove, keyHex, moveHex, polyglotKey } from './chess.mjs';

const requiredPolicyKeys = new Set([
  'prior_games', 'draw_value', 'confidence_standard_errors', 'minimum_games', 'maximum_lcb_gap',
  'quality_exponent', 'maximum_rarity_multiplier', 'exit_intercept', 'exit_depth_weight',
  'exit_advantage_weight', 'exit_disadvantage_weight', 'exit_weakness_weight', 'eval_deadband_cp',
  'eval_scale_cp', 'depth_start_ply', 'depth_span_plies',
]);

export function parsePolicy(text) {
  const policy = {};
  for (const original of text.split(/\r?\n/)) {
    const line = original.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error(`Malformed policy line: ${original}`);
    const key = line.slice(0, separator).trim();
    if (!requiredPolicyKeys.has(key)) throw new Error(`Unknown policy key: ${key}`);
    if (Object.hasOwn(policy, key)) throw new Error(`Duplicate policy key: ${key}`);
    const value = Number(line.slice(separator + 1).trim());
    if (!Number.isFinite(value)) throw new Error(`Invalid policy value for ${key}`);
    policy[key] = value;
  }
  for (const key of requiredPolicyKeys) if (!Object.hasOwn(policy, key)) throw new Error(`Missing policy key: ${key}`);
  if (policy.prior_games < 0 || policy.draw_value < 0 || policy.draw_value > 1 ||
      policy.confidence_standard_errors < 0 || !Number.isInteger(policy.minimum_games) || policy.minimum_games < 1 ||
      policy.maximum_lcb_gap <= 0 || policy.quality_exponent < 0 || policy.maximum_rarity_multiplier < 1 ||
      policy.eval_scale_cp <= 0 || policy.depth_span_plies <= 0) {
    throw new Error('Policy values violate the opening-book numeric contract');
  }
  return policy;
}

export function fnv1a64(bytes) {
  let value = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    value ^= BigInt(byte);
    value = BigInt.asUintN(64, value * 0x100000001b3n);
  }
  return value;
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function compileCandidates(observations, policy) {
  const groups = new Map();
  for (const observation of observations) {
    const identity = observation.fingerprint.toString('hex');
    if (!groups.has(identity)) groups.set(identity, []);
    groups.get(identity).push(observation);
  }
  const selected = [];
  for (const siblings of groups.values()) {
    const totalGames = siblings.reduce((sum, row) => sum + row.games, 0);
    const scoredPoints = siblings.reduce((sum, row) => sum + row.wins + policy.draw_value * row.draws, 0);
    const positionMean = totalGames > 0 ? scoredPoints / totalGames : 0.5;
    for (const row of siblings) {
      row.posterior = (row.wins + policy.draw_value * row.draws + policy.prior_games * positionMean) /
        (row.games + policy.prior_games);
      row.standardError = Math.sqrt(row.posterior * (1 - row.posterior) / (row.games + policy.prior_games + 1));
      row.lcb = row.posterior - policy.confidence_standard_errors * row.standardError;
    }
    const bestLcb = Math.max(...siblings.map((row) => row.lcb));
    const maxGames = Math.max(...siblings.map((row) => row.games));
    const eligible = siblings.filter((row) => row.games >= policy.minimum_games && row.lcb >= bestLcb - policy.maximum_lcb_gap);
    for (const row of eligible) {
      const quality = Math.max(0, Math.min(1, (row.lcb - (bestLcb - policy.maximum_lcb_gap)) / policy.maximum_lcb_gap));
      const rarity = Math.min(policy.maximum_rarity_multiplier, Math.sqrt(maxGames / (row.games + 1)));
      row.quality = quality;
      row.rarity = rarity;
      row.qualityWeight = Math.max(1e-9, quality ** policy.quality_exponent);
      row.selectionWeight = row.qualityWeight * rarity;
    }
    eligible.sort((left, right) => right.selectionWeight - left.selectionWeight || right.lcb - left.lcb || left.rawMove - right.rawMove);
    selected.push(...eligible.slice(0, 6));
  }
  if (selected.length > 2_000_000) {
    selected.sort((left, right) => right.lcb - left.lcb || left.games - right.games ||
      (left.key < right.key ? -1 : left.key > right.key ? 1 : left.rawMove - right.rawMove));
    selected.length = 2_000_000;
  }
  selected.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : left.rawMove - right.rawMove);
  return selected;
}

function polyglotBytes(records) {
  const buffer = Buffer.alloc(records.length * 16);
  records.forEach((record, index) => {
    const offset = index * 16;
    buffer.writeBigUInt64BE(record.key, offset);
    buffer.writeUInt16BE(record.rawMove, offset + 8);
    buffer.writeUInt16BE(Math.max(1, Math.min(65535, record.games)), offset + 10);
    buffer.writeUInt32BE(0, offset + 12);
  });
  return buffer;
}

function statsBytes(records, bookBytes) {
  const digest = fnv1a64(bookBytes).toString(16).padStart(16, '0');
  const lines = [`# flashfork_book_stats_v1 book_fnv1a64=${digest} rows=${records.length}`];
  for (const record of records) {
    lines.push([keyHex(record.key), moveHex(record.rawMove), record.games, record.wins, record.draws, record.losses].join('\t'));
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

function auditBytes(records, evaluations) {
  const lines = records.map((record) => JSON.stringify({
    key: keyHex(record.key), move: moveHex(record.rawMove), uci: record.uciMove, fen: record.fen,
    games: record.games, wins: record.wins, draws: record.draws, losses: record.losses,
    posterior: Number(record.posterior.toFixed(12)), lcb: Number(record.lcb.toFixed(12)),
    selection_weight: Number(record.selectionWeight.toPrecision(12)), evaluation: evaluations.get(`${record.fingerprint.toString('hex')}:${record.rawMove}`) ?? null,
  }));
  return Buffer.from(lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function qualificationMetrics(records) {
  const groups = new Map();
  for (const record of records) {
    const identity = record.fingerprint.toString('hex');
    if (!groups.has(identity)) groups.set(identity, []);
    groups.get(identity).push(record);
  }
  const rarePopularity = [];
  const baselinePopularity = [];
  const rareLcbs = [];
  const baselineLcbs = [];
  for (const siblings of groups.values()) {
    const maxGames = Math.max(...siblings.map((row) => row.games));
    const rareTotal = siblings.reduce((sum, row) => sum + row.selectionWeight, 0);
    const baselineWeights = siblings.map((row) => row.qualityWeight);
    const baselineTotal = baselineWeights.reduce((sum, weight) => sum + weight, 0);
    rarePopularity.push(siblings.reduce((sum, row) => sum + row.selectionWeight / rareTotal * row.games / maxGames, 0));
    baselinePopularity.push(siblings.reduce((sum, row, index) => sum + baselineWeights[index] / baselineTotal * row.games / maxGames, 0));
    rareLcbs.push(siblings.reduce((sum, row) => sum + row.selectionWeight / rareTotal * row.lcb, 0));
    baselineLcbs.push(siblings.reduce((sum, row, index) => sum + baselineWeights[index] / baselineTotal * row.lcb, 0));
  }
  const medianRarePopularity = median(rarePopularity);
  const medianBaselinePopularity = median(baselinePopularity);
  const meanRareLcb = rareLcbs.reduce((sum, value) => sum + value, 0) / Math.max(1, rareLcbs.length);
  const meanBaselineLcb = baselineLcbs.reduce((sum, value) => sum + value, 0) / Math.max(1, baselineLcbs.length);
  return {
    medianRarePopularity, medianBaselinePopularity,
    popularityReduction: medianBaselinePopularity > 0 ? 1 - medianRarePopularity / medianBaselinePopularity : 0,
    meanRareLcb, meanBaselineLcb, meanLcbRegression: meanBaselineLcb - meanRareLcb,
  };
}

function stableEvaluation(evaluation) {
  if (!evaluation) return null;
  return {
    engine_fingerprint: evaluation.engine_fingerprint, node_tier: Number(evaluation.node_tier),
    score_cp: evaluation.score_cp, relative_loss_cp: evaluation.relative_loss_cp, wdl: evaluation.wdl,
    mate: evaluation.mate, depth: Number(evaluation.depth), pv: evaluation.pv, lifecycle: evaluation.lifecycle,
  };
}

function qualificationErrors(catalog, config, records, contentId, metrics) {
  const errors = [];
  const engineFingerprint = catalog.metadata('current_engine_fingerprint');
  if (!engineFingerprint) errors.push('no current Stockfish fingerprint is registered');
  const evaluations = engineFingerprint
    ? records.map((record) => catalog.latestEvaluation(record, config.analysis.initialNodes, engineFingerprint)) : [];
  const missing = engineFingerprint ? evaluations.filter((evaluation) => !evaluation).length : records.length;
  if (missing) errors.push(`${missing} emitted moves lack current Stockfish evidence`);
  if (evaluations.some((evaluation) => evaluation?.lifecycle === 'quarantined_pending_confirmation')) {
    errors.push('one or more emitted moves still require confirmation analysis');
  }
  if (metrics.popularityReduction < 0.20) errors.push(`rarity popularity reduction ${metrics.popularityReduction.toFixed(4)} is below 0.20`);
  if (metrics.meanLcbRegression > 0.01) errors.push(`mean LCB regression ${metrics.meanLcbRegression.toFixed(4)} exceeds 0.01`);
  const gates = new Map(catalog.qualificationGates(contentId).map((gate) => [gate.gate, gate]));
  const match = gates.get('paired_color_non_inferiority');
  if (!match?.passed || Number(match.evidence.elo_lower_bound) < -5) errors.push('paired-color Elo lower bound is missing or below -5');
  const compatibility = gates.get('uci_compatibility');
  if (!compatibility?.passed || Number(compatibility.evidence.regressions) !== 0) errors.push('zero-regression UCI compatibility evidence is missing');
  return errors;
}

export async function buildSnapshot(catalog, config, channel = 'integration') {
  if (!['integration', 'qualified'].includes(channel)) throw new Error(`Unknown channel: ${channel}`);
  const includeFixtures = channel === 'integration';
  const policyBytes = await readFile(config.policyFile);
  const policy = parsePolicy(policyBytes.toString('utf8'));
  const currentEngineFingerprint = catalog.metadata('current_engine_fingerprint');
  const observations = catalog.aggregateObservations({ includeFixtures }).filter((record) => {
    if (!currentEngineFingerprint) return true;
    const evaluation = catalog.latestEvaluation(record, 0, currentEngineFingerprint);
    return !evaluation || !['quarantined', 'retired'].includes(evaluation.lifecycle);
  });
  const records = compileCandidates(observations, policy);
  if (records.length === 0) throw new Error('No observations satisfy the opening-book policy');
  for (const record of records) {
    for (const value of [record.games, record.wins, record.draws, record.losses]) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error('Observation counts exceed the ffstats u32 contract');
    }
    if (!legalUciMove(record.fen, record.uciMove)) throw new Error(`Illegal emitted move ${record.uciMove} for ${record.fen}`);
  }
  const evaluations = new Map();
  for (const record of records) {
    const evaluation = catalog.latestEvaluation(record, 0, currentEngineFingerprint);
    if (evaluation) evaluations.set(`${record.fingerprint.toString('hex')}:${record.rawMove}`, stableEvaluation(evaluation));
  }
  const book = polyglotBytes(records);
  const stats = statsBytes(records, book);
  const audit = auditBytes(records, evaluations);
  const sourceEvidence = catalog.completedSources().filter((source) => includeFixtures || !source.fixture).map((source) => ({
    sha256: source.sha256, source_type: source.source_type, fixture: Boolean(source.fixture),
    games_seen: Number(source.games_seen), games_accepted: Number(source.games_accepted), chunks: Number(source.chunks),
  })).sort((left, right) => left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0);
  const corpusFilter = {
    variant: 'standard', speeds: [...config.ingestion.speeds].sort(), minimum_rating_both: config.ingestion.minimumRating,
    maximum_ply: config.ingestion.maximumPly, require_normal_result: true,
  };
  const provenanceBytes = Buffer.from(JSON.stringify({ source_evidence: sourceEvidence, corpus_filter: corpusFilter }), 'utf8');
  const contentIdentity = sha256(Buffer.concat([book, stats, policyBytes, audit, provenanceBytes])).slice(0, 20);
  const metrics = qualificationMetrics(records);
  if (channel === 'qualified') {
    const errors = qualificationErrors(catalog, config, records, contentIdentity, metrics);
    if (errors.length) throw new Error(`Qualified publication blocked: ${errors.join('; ')}`);
  }
  const snapshotId = `${channel}-${contentIdentity}`;
  const finalDirectory = path.join(config.paths.snapshots, snapshotId);
  const temporaryDirectory = path.join(config.paths.snapshots, `.${snapshotId}.${process.pid}.tmp`);
  const artifactDigests = {
    'strong_rare_v1.bin': sha256(book), 'strong_rare_v1.ffstats': sha256(stats),
    'strong_rare_v1.policy': sha256(policyBytes), 'evaluation.audit.jsonl': sha256(audit),
  };
  const manifest = {
    schema: 'flashfork_book_snapshot_v1', snapshot_id: snapshotId, channel,
    record_count: records.length, includes_fixture: sourceEvidence.some((source) => source.fixture),
    qualified: channel === 'qualified', artifacts: artifactDigests,
    qualification_metrics: metrics,
    source_evidence: sourceEvidence,
    corpus_filter: corpusFilter,
    compiler: { package: '@uci-arena/book-forge', version: '1.0.0', observation_shards: 64 },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  try {
    await stat(finalDirectory);
    const validation = await validateSnapshot(finalDirectory);
    return { ...validation, id: snapshotId, directory: finalDirectory };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
  await mkdir(temporaryDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(temporaryDirectory, 'strong_rare_v1.bin'), book),
    writeFile(path.join(temporaryDirectory, 'strong_rare_v1.ffstats'), stats),
    writeFile(path.join(temporaryDirectory, 'strong_rare_v1.policy'), policyBytes),
    writeFile(path.join(temporaryDirectory, 'evaluation.audit.jsonl'), audit),
    writeFile(path.join(temporaryDirectory, 'snapshot.manifest.json'), manifestBytes),
  ]);
  await validateSnapshot(temporaryDirectory);
  await rename(temporaryDirectory, finalDirectory);
  const manifestSha256 = sha256(manifestBytes);
  catalog.addSnapshot({ id: snapshotId, channel, directory: finalDirectory, recordCount: records.length,
    includesFixture: manifest.includes_fixture, qualified: manifest.qualified, manifestSha256 });
  return { id: snapshotId, directory: finalDirectory, recordCount: records.length,
    includesFixture: manifest.includes_fixture, qualified: manifest.qualified, manifestSha256 };
}

export async function validateSnapshot(directory) {
  const manifestPath = path.join(directory, 'snapshot.manifest.json');
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.schema !== 'flashfork_book_snapshot_v1') throw new Error('Unsupported snapshot manifest schema');
  if (!['integration', 'qualified'].includes(manifest.channel) || manifest.qualified !== (manifest.channel === 'qualified')) throw new Error('Invalid snapshot channel metadata');
  if (!Array.isArray(manifest.source_evidence)) throw new Error('Snapshot source evidence is missing');
  if (!manifest.corpus_filter || typeof manifest.corpus_filter !== 'object') throw new Error('Snapshot corpus filter evidence is missing');
  if (manifest.includes_fixture !== manifest.source_evidence.some((source) => source.fixture === true)) throw new Error('Snapshot fixture provenance mismatch');
  const book = await readFile(path.join(directory, 'strong_rare_v1.bin'));
  const stats = await readFile(path.join(directory, 'strong_rare_v1.ffstats'));
  const policy = await readFile(path.join(directory, 'strong_rare_v1.policy'));
  const audit = await readFile(path.join(directory, 'evaluation.audit.jsonl'));
  const artifacts = { 'strong_rare_v1.bin': book, 'strong_rare_v1.ffstats': stats, 'strong_rare_v1.policy': policy, 'evaluation.audit.jsonl': audit };
  for (const [name, bytes] of Object.entries(artifacts)) {
    if (sha256(bytes) !== manifest.artifacts[name]) throw new Error(`Snapshot digest mismatch: ${name}`);
  }
  if (Object.keys(manifest.artifacts).sort().join(',') !== Object.keys(artifacts).sort().join(',')) throw new Error('Snapshot artifact set mismatch');
  const provenanceBytes = Buffer.from(JSON.stringify({ source_evidence: manifest.source_evidence, corpus_filter: manifest.corpus_filter }), 'utf8');
  const expectedContentId = sha256(Buffer.concat([book, stats, policy, audit, provenanceBytes])).slice(0, 20);
  if (manifest.snapshot_id !== `${manifest.channel}-${expectedContentId}`) throw new Error('Snapshot content identity mismatch');
  parsePolicy(policy.toString('utf8'));
  if (book.length % 16 !== 0 || book.length / 16 !== manifest.record_count) throw new Error('Invalid Polyglot record count');
  const lines = stats.toString('utf8').trimEnd().split(/\r?\n/);
  const expectedFnv = fnv1a64(book).toString(16).padStart(16, '0');
  if (lines[0] !== `# flashfork_book_stats_v1 book_fnv1a64=${expectedFnv} rows=${manifest.record_count}`) throw new Error('Invalid stats header');
  if (lines.length - 1 !== manifest.record_count) throw new Error('Stats row count mismatch');
  const auditLines = audit.length ? audit.toString('utf8').trimEnd().split(/\r?\n/).map(JSON.parse) : [];
  if (auditLines.length !== manifest.record_count) throw new Error('Audit row count mismatch');
  let previousKey = -1n;
  let previousMove = -1;
  for (let index = 0; index < manifest.record_count; index += 1) {
    const offset = index * 16;
    const key = book.readBigUInt64BE(offset);
    const move = book.readUInt16BE(offset + 8);
    const weight = book.readUInt16BE(offset + 10);
    const learn = book.readUInt32BE(offset + 12);
    if (key < previousKey || (key === previousKey && move <= previousMove)) throw new Error('Polyglot records are not strictly ordered');
    if (weight === 0 || learn !== 0) throw new Error(`Invalid Polyglot payload at row ${index}`);
    const columns = lines[index + 1].split('\t');
    if (columns.length !== 6 || columns[0] !== keyHex(key) || columns[1] !== moveHex(move)) throw new Error(`Stats parity mismatch at row ${index}`);
    const [games, wins, draws, losses] = columns.slice(2).map(Number);
    if (![games, wins, draws, losses].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff) ||
        games <= 0 || games !== wins + draws + losses) throw new Error(`Invalid stats outcomes at row ${index}`);
    const auditRow = auditLines[index];
    if (auditRow.key !== columns[0] || auditRow.move !== columns[1] || auditRow.games !== games || auditRow.wins !== wins ||
        auditRow.draws !== draws || auditRow.losses !== losses || !legalUciMove(auditRow.fen, auditRow.uci) ||
        polyglotKey(auditRow.fen) !== key || encodePolyglotMove(auditRow.uci) !== move) {
      throw new Error(`Audit legality mismatch at row ${index}`);
    }
    previousKey = key;
    previousMove = move;
  }
  return { id: manifest.snapshot_id, channel: manifest.channel, directory: path.resolve(directory), recordCount: manifest.record_count,
    includesFixture: manifest.includes_fixture, qualified: manifest.qualified, manifestSha256: sha256(manifestBytes) };
}
