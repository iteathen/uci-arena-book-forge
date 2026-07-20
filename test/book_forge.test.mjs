import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Catalog } from '../src/catalog.mjs';
import { canonicalFen, encodePolyglotMove, keyBuffer, polyglotKey, positionFingerprint } from '../src/chess.mjs';
import { buildSnapshot, validateSnapshot } from '../src/compiler.mjs';
import { loadConfig } from '../src/config.mjs';
import { discoverInbox, ingestSource, registerInput } from '../src/ingest.mjs';
import { runMaintenance } from '../src/maintenance.mjs';
import { NativeResourceHelper } from '../src/native_helper.mjs';
import { publishSnapshot } from '../src/publisher.mjs';
import { ResourceGovernor } from '../src/resource_governor.mjs';
import { StockfishWorker } from '../src/stockfish.mjs';

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'book-forge-test-'));
  const config = await loadConfig({ workspace: root });
  config.resources.minimumFreeWorkspaceGb = 0;
  config.resources.priorityProcessNames = [];
  return config;
}

function cleanCatalog(t, catalog, config) {
  t.after(async () => {
    catalog.close();
    await rm(config.workspace, { recursive: true, force: true });
  });
}

test('Polyglot vectors, canonical FEN, and move encoding match the runtime contract', () => {
  const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  assert.equal(polyglotKey(start), 0x463b96181691fc9cn);
  const afterE4WithUncapturableEp = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  assert.equal(canonicalFen(afterE4WithUncapturableEp), 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
  assert.equal(polyglotKey(afterE4WithUncapturableEp), 0x823c9b50fd114196n);
  assert.equal(encodePolyglotMove('e2e4'), 0x031c);
  assert.equal(encodePolyglotMove('e1g1'), 0x0107);
});

test('fixture ingestion is idempotent and creates deterministic integration snapshots only', async (t) => {
  const config = await workspace(t);
  const catalog = new Catalog(config);
  cleanCatalog(t, catalog, config);
  const source = await registerInput(catalog, { fixtureId: 'bootstrap_v1' });
  const duplicate = await registerInput(catalog, { fixtureId: 'bootstrap_v1' });
  assert.equal(duplicate.id, source.id);
  await ingestSource(catalog, source, config);
  const firstAggregate = catalog.aggregateObservations({ includeFixtures: true });
  assert.equal(firstAggregate.length, 6);
  assert.equal(firstAggregate.reduce((sum, row) => sum + row.games, 0), 390);

  await ingestSource(catalog, catalog.source(source.id), config);
  const replayAggregate = catalog.aggregateObservations({ includeFixtures: true });
  assert.equal(replayAggregate.reduce((sum, row) => sum + row.games, 0), 390);

  const first = await buildSnapshot(catalog, config, 'integration');
  const firstBook = await readFile(path.join(first.directory, 'strong_rare_v1.bin'));
  await rm(first.directory, { recursive: true, force: true });
  const second = await buildSnapshot(catalog, config, 'integration');
  assert.equal(second.id, first.id);
  assert.deepEqual(await readFile(path.join(second.directory, 'strong_rare_v1.bin')), firstBook);
  assert.equal(first.recordCount, 6);
  assert.equal(first.includesFixture, true);

  const publication = await publishSnapshot(catalog, config, first.directory, 'integration');
  assert.equal(publication.snapshotId, first.id);
  const unchanged = await publishSnapshot(catalog, config, first.directory, 'integration');
  assert.equal(unchanged.unchanged, true);
  await assert.rejects(() => buildSnapshot(catalog, config, 'qualified'), /No observations|Qualified publication blocked/);
});

test('malformed snapshot is rejected before it can replace the published channel', async (t) => {
  const config = await workspace(t);
  const catalog = new Catalog(config);
  cleanCatalog(t, catalog, config);
  const source = await registerInput(catalog, { fixtureId: 'bootstrap_v1' });
  await ingestSource(catalog, source, config);
  const snapshot = await buildSnapshot(catalog, config, 'integration');
  await publishSnapshot(catalog, config, snapshot.directory, 'integration');
  const currentBefore = catalog.status().channels[0].snapshot_id;
  const malformed = path.join(config.workspace, 'malformed-snapshot');
  await cp(snapshot.directory, malformed, { recursive: true });
  await writeFile(path.join(malformed, 'strong_rare_v1.bin'), Buffer.alloc(16));
  await assert.rejects(() => validateSnapshot(malformed), /digest mismatch/);
  await assert.rejects(() => publishSnapshot(catalog, config, malformed, 'integration'), /digest mismatch/);
  assert.equal(catalog.status().channels[0].snapshot_id, currentBefore);
  await validateSnapshot(path.join(config.paths.published, 'integration'));
});

test('current relative evaluation trims confirmed bad moves without pruning merely losing positions', async (t) => {
  const config = await workspace(t);
  const catalog = new Catalog(config);
  cleanCatalog(t, catalog, config);
  const source = await registerInput(catalog, { fixtureId: 'bootstrap_v1' });
  await ingestSource(catalog, source, config);
  const records = catalog.aggregateObservations({ includeFixtures: true });
  const e4 = records.find((record) => record.uciMove === 'e2e4');
  const d4 = records.find((record) => record.uciMove === 'd2d4');
  const engineFingerprint = 'a'.repeat(64);
  catalog.setMetadata('current_engine_fingerprint', engineFingerprint);
  catalog.putEvaluation({ ...d4, engineFingerprint, nodeTier: 2_000_000, scoreCp: -500,
    relativeLossCp: 10, depth: 30, pv: 'd2d4', lifecycle: 'active' });
  let snapshot = await buildSnapshot(catalog, config, 'integration');
  assert.equal(snapshot.recordCount, 6, 'absolute disadvantage alone must not remove a move');
  catalog.putEvaluation({ ...e4, engineFingerprint, nodeTier: 2_000_000, scoreCp: -120,
    relativeLossCp: 80, depth: 30, pv: 'e2e4', lifecycle: 'retired' });
  snapshot = await buildSnapshot(catalog, config, 'integration');
  assert.equal(snapshot.recordCount, 5, 'confirmed relative loss retires the move');
});

test('PGN ingestion filters cohorts and persists accepted games without replay drift', async (t) => {
  const config = await workspace(t);
  config.ingestion.chunkGames = 1;
  const pgn = `[Event "Rated Rapid game"]
[Site "local"]
[Date "2026.07.20"]
[Round "1"]
[White "Strong White"]
[Black "Strong Black"]
[Result "1-0"]
[WhiteElo "2100"]
[BlackElo "2050"]
[TimeControl "600+0"]

1. e4 e5 2. Nf3 Nc6 1-0

[Event "Rated Rapid game"]
[Site "local"]
[Date "2026.07.20"]
[Round "2"]
[White "Below Filter"]
[Black "Strong Black"]
[Result "0-1"]
[WhiteElo "1900"]
[BlackElo "2100"]
[TimeControl "600+0"]

1. d4 d5 0-1
`;
  config.ingestion.inboxSettleSeconds = 0;
  const catalog = new Catalog(config);
  cleanCatalog(t, catalog, config);
  const filename = path.join(config.paths.inbox, 'sample.pgn');
  await writeFile(filename, pgn, 'utf8');
  const discovered = await discoverInbox(catalog, config);
  assert.equal(discovered.length, 1);
  assert.equal((await discoverInbox(catalog, config)).length, 0);
  const source = catalog.source(discovered[0].sourceId);
  const telemetry = await ingestSource(catalog, source, config);
  assert.deepEqual(telemetry, { gamesSeen: 2, gamesAccepted: 1, chunks: 1 });
  const observations = catalog.aggregateObservations({ includeFixtures: false });
  assert.equal(observations.length, 4);
  assert.equal(observations.reduce((sum, row) => sum + row.games, 0), 4);
});

test('qualified channel promotes automatically after current eval and external gates pass', async (t) => {
  const config = await workspace(t);
  const catalog = new Catalog(config);
  cleanCatalog(t, catalog, config);
  const fen = canonicalFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const key = polyglotKey(fen);
  const fingerprint = positionFingerprint(fen);
  const makeRecord = (uciMove, games, wins, draws, losses) => ({
    key, keyBuffer: keyBuffer(key), fingerprint, fen, rawMove: encodePolyglotMove(uciMove), uciMove,
    month: '2026-07', speed: 'rapid', ratingBucket: 2200, games, wins, draws, losses,
  });
  const records = [makeRecord('e2e4', 1000, 570, 230, 200), makeRecord('d2d4', 40, 27, 8, 5)];
  const source = catalog.registerSource({ sha256: 'b'.repeat(64), sourcePath: 'synthetic-qualified.pgn', sourceType: 'pgn' });
  catalog.replaceObservationChunk(source.id, 0, records);
  catalog.updateSource(source.id, 'complete', { gamesSeen: 1040, gamesAccepted: 1040, chunks: 1 });
  const engineFingerprint = 'c'.repeat(64);
  catalog.setMetadata('current_engine_fingerprint', engineFingerprint);
  for (const record of records) {
    catalog.putEvaluation({ ...record, engineFingerprint, nodeTier: config.analysis.confirmationNodes,
      scoreCp: 25, relativeLossCp: 10, depth: 32, pv: record.uciMove, lifecycle: 'active' });
  }
  const integration = await buildSnapshot(catalog, config, 'integration');
  const contentId = integration.id.slice('integration-'.length);
  catalog.recordQualificationGate(contentId, 'paired_color_non_inferiority', true,
    { elo_lower_bound: -3, evidence_sha256: 'd'.repeat(64) });
  catalog.recordQualificationGate(contentId, 'uci_compatibility', true,
    { regressions: 0, evidence_sha256: 'd'.repeat(64) });
  const qualified = await buildSnapshot(catalog, config, 'qualified');
  assert.equal(qualified.qualified, true);
  assert.equal(qualified.includesFixture, false);
  const publication = await publishSnapshot(catalog, config, qualified.directory, 'qualified');
  assert.equal(publication.snapshotId, qualified.id);
});

test('resource governor enters backoff before starting work under disk pressure', async (t) => {
  const config = await workspace(t);
  config.resources.minimumFreeWorkspaceGb = 1_000_000_000;
  config.nativeHelperAvailable = false;
  const catalog = new Catalog(config);
  cleanCatalog(t, catalog, config);
  const governor = new ResourceGovernor(config, catalog);
  const started = performance.now();
  const permit = await governor.permit();
  assert.equal(permit.allowed, false);
  assert.equal(permit.mode, 'backoff');
  assert.ok(performance.now() - started < 2_000);
});

test('monthly maintenance compacts old cohorts idempotently while retaining source identity', async (t) => {
  const config = await workspace(t);
  const catalog = new Catalog(config);
  cleanCatalog(t, catalog, config);
  const fen = canonicalFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const key = polyglotKey(fen);
  const record = { key, keyBuffer: keyBuffer(key), fingerprint: positionFingerprint(fen), fen,
    rawMove: encodePolyglotMove('e2e4'), uciMove: 'e2e4', month: '2020-01', speed: 'rapid',
    ratingBucket: 2200, games: 40, wins: 22, draws: 10, losses: 8 };
  const source = catalog.registerSource({ sha256: 'e'.repeat(64), sourcePath: 'old.pgn', sourceType: 'pgn' });
  catalog.replaceObservationChunk(source.id, 0, [record]);
  catalog.updateSource(source.id, 'complete', { gamesSeen: 40, gamesAccepted: 40, chunks: 1 });
  const first = await runMaintenance(catalog, config, { force: true });
  assert.equal(first.compacted.observationsCompacted, 40);
  assert.equal(catalog.aggregateObservations({ includeFixtures: false })[0].games, 40);
  const second = await runMaintenance(catalog, config, { force: true });
  assert.equal(second.compacted.observationsCompacted, 0);
  assert.equal(catalog.aggregateObservations({ includeFixtures: false })[0].games, 40);
  catalog.setSourceLifecycle(source.id, 'quarantined');
  assert.equal(catalog.aggregateObservations({ includeFixtures: false }).length, 0);
  catalog.setSourceLifecycle(source.id, 'restored');
  assert.equal(catalog.aggregateObservations({ includeFixtures: false })[0].games, 40);
});

test('configured Stockfish passes persistent UCI interrogation and returns candidate analysis', async (t) => {
  const config = await workspace(t);
  if (!config.stockfishAvailable) {
    await rm(config.workspace, { recursive: true, force: true });
    return t.skip('local Stockfish artifact is not installed');
  }
  config.analysis.initialNodes = 1_000;
  config.analysis.hashMbPerWorker = 16;
  const worker = new StockfishWorker(config);
  t.after(async () => {
    await worker.close();
    await rm(config.workspace, { recursive: true, force: true });
  });
  await worker.start();
  assert.match(worker.fingerprint, /^[0-9a-f]{64}$/);
  const result = await worker.analyze('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', ['e2e4', 'd2d4'], 1_000);
  assert.ok(result.has('e2e4') || result.has('d2d4'));
});

test('optional Windows guard exposes battery, input-idle, and processor-limit telemetry', async (t) => {
  const config = await workspace(t);
  t.after(() => rm(config.workspace, { recursive: true, force: true }));
  if (!config.nativeHelperAvailable) return t.skip('native resource guard is not built');
  const probe = await new NativeResourceHelper(config).probe();
  assert.equal(probe.schema, 'flashfork_book_forge_native_probe_v1');
  assert.equal(typeof probe.on_battery, 'boolean');
  assert.ok(Number.isInteger(probe.input_idle_ms));
  assert.ok(probe.processor_limit_percent >= 0 && probe.processor_limit_percent <= 100);
});
