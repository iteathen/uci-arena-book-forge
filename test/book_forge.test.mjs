import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { promisify } from 'node:util';
import { ExplorerAcquisition, acquisitionQuery, validateExplorerResponse } from '../src/acquisition.mjs';
import { Catalog } from '../src/catalog.mjs';
import { canonicalFen, encodePolyglotMove, keyBuffer, polyglotKey, positionFingerprint } from '../src/chess.mjs';
import { buildSnapshot, validateSnapshot } from '../src/compiler.mjs';
import { loadConfig } from '../src/config.mjs';
import { runCycle, runDaemon } from '../src/daemon.mjs';
import { discoverInbox, ingestSource, registerInput } from '../src/ingest.mjs';
import { runMaintenance } from '../src/maintenance.mjs';
import { NativeResourceHelper } from '../src/native_helper.mjs';
import { publishSnapshot } from '../src/publisher.mjs';
import { RESOURCE_WORK_CLASSES, ResourceGovernor } from '../src/resource_governor.mjs';
import { StockfishWorker } from '../src/stockfish.mjs';
import { buildTaskXml, installWindowsStartup, quoteWindowsArgument, startupAction, startupTaskName } from '../src/windows_startup.mjs';

const execFileAsync = promisify(execFile);

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

function mockedResourceGovernor(config, catalog, {
  availableMemoryGb = 64,
  freeWorkspaceGb = 1_024,
  idleRatio = 0.50,
  native = {},
  runningProcesses = [],
} = {}) {
  let idle = 0;
  let total = 0;
  const normalizedProcesses = new Set(runningProcesses.map((name) => name.toLowerCase()));
  return new ResourceGovernor(config, catalog, {
    cpuTotalsImpl: () => {
      idle += idleRatio * 100;
      total += 100;
      return { idle, total };
    },
    statfsImpl: async () => ({ bavail: BigInt(Math.floor(freeWorkspaceGb * 1_024)), bsize: 1_048_576n }),
    freeMemoryImpl: () => availableMemoryGb * 1024 ** 3,
    processProbe: async (names) => names.filter((name) => normalizedProcesses.has(name.toLowerCase())),
    nativeHelper: {
      start() {},
      close() {},
      async probe() {
        return { on_battery: false, battery_saver: false, input_idle_ms: 0, processor_limit_percent: 100, ...native };
      },
    },
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

test('Windows startup task uses a windowless native launcher with absolute paths', async (t) => {
  const config = await workspace(t);
  t.after(() => rm(config.workspace, { recursive: true, force: true }));
  config.workspace = path.join(config.workspace, 'Book & Forge');
  config.configFile = path.join(config.workspace, 'book forge.config.json');
  const action = startupAction(config);
  assert.equal(path.isAbsolute(action.command), true);
  assert.equal(path.isAbsolute(action.workingDirectory), true);
  assert.equal(action.command, config.nativeLauncher);
  assert.ok(action.arguments.startsWith(quoteWindowsArgument(path.resolve(process.execPath))));
  assert.match(action.arguments, / daemon --workspace /);
  assert.doesNotMatch(action.arguments, /--detach/);
  assert.equal(quoteWindowsArgument('C:\\plain'), 'C:\\plain');
  assert.equal(quoteWindowsArgument('C:\\has space\\'), '"C:\\has space\\\\"');
  const xml = buildTaskXml(config, 'S-1-5-21-100-200-300-1001');
  assert.match(xml, new RegExp(`<URI>\\\\${startupTaskName}</URI>`));
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<Hidden>true<\/Hidden>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<RestartOnFailure>/);
  assert.match(xml, /Book &amp; Forge/);
  config.nativeLauncherAvailable = false;
  await assert.rejects(installWindowsStartup(config), /windowless launcher is unavailable/);
});

test('catalog schema three migrates acquisition authority columns without losing sources', async (t) => {
  const config = await workspace(t);
  const legacy = new DatabaseSync(config.paths.catalog);
  legacy.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    INSERT INTO metadata(key,value) VALUES('schema_version','3');
    CREATE TABLE sources (
      id INTEGER PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, source_path TEXT NOT NULL,
      source_type TEXT NOT NULL, fixture INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('pending','processing','complete','error')),
      lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','quarantined','retired','restored')),
      games_seen INTEGER NOT NULL DEFAULT 0, games_accepted INTEGER NOT NULL DEFAULT 0,
      chunks INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO sources(sha256,source_path,source_type,status,created_at,updated_at)
      VALUES('${'f'.repeat(64)}','legacy.pgn','lichess_pgn','complete','2026-01-01','2026-01-01');
  `);
  legacy.close();
  const catalog = new Catalog(config);
  cleanCatalog(t, catalog, config);
  const source = catalog.source(1);
  assert.equal(source.overlap_domain, `manual:${'f'.repeat(64)}`);
  assert.equal(source.contribution_mode, 'additive');
  assert.equal(catalog.database.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value, '4');
});

test('configuration copies defaults and forbids redirecting the credential header', async (t) => {
  const first = await workspace(t);
  first.acquisition.resourcePollMs = 10;
  const second = await loadConfig({ workspace: first.workspace });
  assert.equal(second.acquisition.resourcePollMs, 1_000);
  assert.deepEqual(second.resources.priorityProcessNames.slice(0, 2), [
    'flashfork_uci.exe',
    'uci_arena.exe',
  ]);
  const filename = path.join(first.workspace, 'unsafe.config.json');
  await writeFile(filename, JSON.stringify({
    schema: 'flashfork_book_forge_config_v1', acquisition: { endpoint: 'https://example.com/lichess' },
  }));
  await assert.rejects(loadConfig({ configFile: filename, workspace: first.workspace }), /acquisition configuration/);
  t.after(() => rm(first.workspace, { recursive: true, force: true }));
});

test('Explorer acquisition sips validated mover-relative positions and replaces cumulative observations', async (t) => {
  const config = await workspace(t);
  config.acquisition.tokenFile = path.join(config.workspace, 'fixture-token.txt');
  config.acquisition.dailyRequestBudget = 1;
  await writeFile(config.acquisition.tokenFile, 'fixture-token\n');
  const catalog = new Catalog(config);
  cleanCatalog(t, catalog, config);
  let captured;
  const payload = {
    white: 670, draws: 220, black: 210,
    moves: [
      { uci: 'e2e4', averageRating: 2240, white: 600, draws: 200, black: 200 },
      { uci: 'd2d4', averageRating: 2310, white: 70, draws: 20, black: 10 },
    ], topGames: [], recentGames: [], opening: null,
  };
  const acquisition = new ExplorerAcquisition(catalog, config, { fetchImpl: async (url, options) => {
    captured = { url: new URL(url), authorization: options.headers.Authorization };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const governor = { permit: async () => ({ allowed: true, mode: 'courtesy' }) };
  const report = await acquisition.run(governor, { maxRequests: 2 });
  assert.equal(report.requests, 1);
  assert.equal(report.positions, 1);
  assert.equal(report.moves, 2);
  assert.equal(report.enqueued, 2);
  assert.equal(captured.authorization, 'Bearer fixture-token');
  assert.equal(captured.url.hostname, 'explorer.lichess.org');
  assert.equal(captured.url.searchParams.get('speeds'), 'classical,rapid');
  assert.equal(captured.url.searchParams.get('ratings'), '2000,2200,2500');
  assert.equal(captured.url.searchParams.get('moves'), '50');
  assert.equal(captured.url.searchParams.get('topGames'), '0');
  assert.equal(captured.url.searchParams.get('recentGames'), '0');
  const observations = catalog.aggregateObservations({ includeFixtures: false });
  assert.equal(observations.length, 2);
  const e4 = observations.find((row) => row.uciMove === 'e2e4');
  assert.deepEqual([e4.games, e4.wins, e4.draws, e4.losses], [1000, 600, 200, 200]);
  const next = catalog.nextFrontier(Number(acquisition.dataset.id));
  assert.equal(next.ply, 1);
  assert.equal(next.via_move, 'd2d4');
  const frontierPositions = catalog.acquisitionStatus().frontierPositions;
  catalog.enqueueFrontier(Number(acquisition.dataset.id), { ...next, ply: 2, priority: 0 });
  assert.equal(catalog.acquisitionStatus().frontierPositions, frontierPositions);
  assert.equal(acquisition.enqueueChildren({
    fen: canonicalFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
    ply: config.acquisition.maximumPly,
  }, [{
    rawMove: encodePolyglotMove('e2e4'), uciMove: 'e2e4', games: 100, wins: 70, draws: 20, losses: 10,
  }]), 0);
  assert.equal(catalog.acquisitionStatus().frontierPositions, frontierPositions);
  assert.equal(JSON.stringify(catalog.status()).includes('fixture-token'), false);
  const root = observations[0];
  catalog.replaceRemotePosition(Number(acquisition.dataset.id), root, [{
    rawMove: encodePolyglotMove('e2e4'), uciMove: 'e2e4', games: 77, wins: 50, draws: 17, losses: 10, averageRating: 2300,
  }], 'a'.repeat(64));
  assert.equal(catalog.aggregateObservations({ includeFixtures: false })[0].games, 77);
  const snapshot = await buildSnapshot(catalog, config, 'integration');
  const manifest = JSON.parse(await readFile(path.join(snapshot.directory, 'snapshot.manifest.json'), 'utf8'));
  assert.equal(manifest.source_evidence[0].source_type, 'lichess_opening_explorer');
  assert.equal(manifest.source_evidence[0].overlap_domain, 'lichess_standard_rated');
});

test('Explorer source authority prevents overlapping datasets from double counting', async (t) => {
  const config = await workspace(t);
  const catalog = new Catalog(config);
  cleanCatalog(t, catalog, config);
  const queryA = JSON.stringify({ generation: 'a' });
  const queryB = JSON.stringify({ generation: 'b' });
  const first = catalog.ensureAcquisitionDataset({ provider: 'lichess_opening_explorer', overlapDomain: 'lichess_standard_rated',
    contributionMode: 'authoritative', queryJson: queryA, queryDigest: 'a'.repeat(64) });
  const fen = canonicalFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const key = polyglotKey(fen);
  const position = { fen, key, keyBuffer: keyBuffer(key), fingerprint: positionFingerprint(fen) };
  const record = (games) => ({ rawMove: encodePolyglotMove('e2e4'), uciMove: 'e2e4', games, wins: games, draws: 0, losses: 0, averageRating: 2400 });
  catalog.enqueueFrontier(Number(first.id), { ...position, ply: 0 });
  catalog.replaceRemotePosition(Number(first.id), position, [record(100)], '1'.repeat(64));
  catalog.completeFrontier(Number(first.id), position.fingerprint, { responseDigest: '1'.repeat(64), refreshDays: 7 });
  const second = catalog.ensureAcquisitionDataset({ provider: 'lichess_opening_explorer', overlapDomain: 'lichess_standard_rated',
    contributionMode: 'authoritative', queryJson: queryB, queryDigest: 'b'.repeat(64) });
  catalog.enqueueFrontier(Number(second.id), { ...position, ply: 0 });
  catalog.replaceRemotePosition(Number(second.id), position, [record(40)], '2'.repeat(64));
  const audit = catalog.registerSource({ sha256: 'c'.repeat(64), sourcePath: 'audit.pgn.zst', sourceType: 'lichess_pgn',
    overlapDomain: 'lichess_standard_rated', contributionMode: 'audit_only' });
  catalog.replaceObservationChunk(Number(audit.id), 0, [{ ...position, ...record(500), month: '2026-06', speed: 'rapid', ratingBucket: 2200 }]);
  catalog.updateSource(Number(audit.id), 'complete', { gamesSeen: 500, gamesAccepted: 500, chunks: 1 });
  const aggregate = catalog.aggregateObservations({ includeFixtures: false });
  assert.equal(aggregate.length, 1);
  assert.equal(aggregate[0].games, 40);
  assert.deepEqual(catalog.acquisitionEvidence().map((entry) => entry.contribution_mode).sort(), ['audit_only', 'authoritative']);
  assert.equal(catalog.acquisitionStatus().positions, 0);
  assert.equal(catalog.acquisitionStatus().frontierPositions, 1);
});

test('Explorer rejects malformed results and fails closed when its credential is unavailable', async (t) => {
  const black = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  const converted = validateExplorerResponse(black, { white: 10, draws: 5, black: 20,
    moves: [{ uci: 'c7c5', averageRating: 2200, white: 10, draws: 5, black: 20 }] });
  assert.deepEqual([converted[0].games, converted[0].wins, converted[0].draws, converted[0].losses], [35, 20, 5, 10]);
  assert.throws(() => validateExplorerResponse(black, { white: 0, draws: 0, black: 0,
    moves: [{ uci: 'e2e4', averageRating: 2200, white: 0, draws: 0, black: 0 }] }), /invalid move/);

  const config = await workspace(t);
  config.acquisition.tokenFile = path.join(config.workspace, 'missing-token.txt');
  const catalog = new Catalog(config);
  cleanCatalog(t, catalog, config);
  let fetched = false;
  const acquisition = new ExplorerAcquisition(catalog, config, { fetchImpl: async () => { fetched = true; throw new Error('unexpected'); } });
  const report = await acquisition.run({ permit: async () => ({ allowed: true, mode: 'courtesy' }) }, { maxRequests: 1 });
  assert.equal(fetched, false);
  assert.equal(report.stopped, 'Lichess acquisition credential is unavailable');
  assert.equal(catalog.acquisitionStatus().authState, 'blocked');
  assert.equal(catalog.retryAcquisitionAuth(), 1);
});

test('Book Forge status exposes bounded daemon heartbeat and acquisition telemetry', async (t) => {
  const config = await workspace(t);
  const catalog = new Catalog(config);
  cleanCatalog(t, catalog, config);
  catalog.updateDaemonState({ pid: 123, phase: 'acquisition', heartbeat_at: new Date().toISOString(),
    last_report: { payload: 'x'.repeat(100_000) } });
  const status = catalog.status();
  assert.equal(status.schema, 'flashfork_book_forge_status_v2');
  assert.equal(status.daemon.pid, 123);
  assert.equal(status.daemon.phase, 'acquisition');
  assert.equal(status.daemon.stale, false);
  assert.equal(status.daemon.lastReport.truncated, true);
  assert.deepEqual(acquisitionQuery(config), {
    variant: 'standard', speeds: ['classical', 'rapid'], ratings: [2000, 2200, 2500],
    moves: 50, topGames: 0, recentGames: 0, history: false,
  });
});

test('Explorer rate limits and live resource revocation back off without partial observations', async (t) => {
  const config = await workspace(t);
  config.acquisition.tokenFile = path.join(config.workspace, 'fixture-token.txt');
  config.acquisition.resourcePollMs = 10;
  config.acquisition.requestTimeoutMs = 1_000;
  config.acquisition.dailyRequestBudget = 2;
  await writeFile(config.acquisition.tokenFile, 'fixture-token\n');
  const catalog = new Catalog(config);
  cleanCatalog(t, catalog, config);
  let permits = 0;
  const permitClasses = [];
  const governor = { permit: async (workClass) => {
    permitClasses.push(workClass);
    return ++permits < 3
      ? { allowed: true, mode: 'courtesy' }
      : { allowed: false, mode: 'backoff', reason: 'priority process is running' };
  } };
  const acquisition = new ExplorerAcquisition(catalog, config, { fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }) });
  const started = performance.now();
  const report = await acquisition.run(governor, { maxRequests: 1 });
  assert.ok(performance.now() - started < 2_000);
  assert.equal(report.stopped, 'priority process is running');
  assert.equal(catalog.aggregateObservations({ includeFixtures: false }).length, 0);
  assert.ok(permitClasses.length >= 3);
  assert.ok(permitClasses.every((workClass) => workClass === RESOURCE_WORK_CLASSES.ACQUISITION));

  catalog.retryAcquisitionAuth();
  catalog.database.prepare("UPDATE acquisition_frontier SET state='queued',next_due_at=?").run(new Date().toISOString());
  const limited = new ExplorerAcquisition(catalog, config, { fetchImpl: async () => new Response('', {
    status: 429, headers: { 'retry-after': '1' },
  }) });
  const limitedReport = await limited.run({ permit: async () => ({ allowed: true, mode: 'courtesy' }) }, { maxRequests: 1 });
  assert.equal(limitedReport.stopped, 'Lichess acquisition rate limit');
  assert.equal(catalog.acquisitionStatus().lastHttpStatus, 429);
});

test('one-shot daemon persists a heartbeat and a single bounded cycle report', async (t) => {
  const config = await workspace(t);
  config.acquisition.enabled = false;
  config.channels.integration = false;
  config.channels.qualified = false;
  config.nativeHelperAvailable = false;
  const catalog = new Catalog(config);
  cleanCatalog(t, catalog, config);
  const report = await runDaemon(catalog, config, { once: true });
  const state = catalog.daemonState();
  assert.equal(report.acquisition.enabled, false);
  assert.equal(state.phase, 'stopped');
  assert.equal(state.stale, false);
  assert.equal(state.lastReport.acquisition.enabled, false);
  const heartbeat = JSON.parse(await readFile(config.daemonHeartbeatFile, 'utf8'));
  assert.equal(heartbeat.pid, process.pid);
});

test('a transient Stockfish failure is isolated to analysis and the cycle completes maintenance', async (t) => {
  const config = await workspace(t);
  config.acquisition.enabled = false;
  config.channels.integration = false;
  config.channels.qualified = false;
  config.nativeHelperAvailable = false;
  const catalog = new Catalog(config);
  cleanCatalog(t, catalog, config);
  const governor = mockedResourceGovernor(config, catalog);
  t.after(() => governor.close());
  const phases = [];
  const acquisition = new ExplorerAcquisition(catalog, config);
  const report = await runCycle(
    catalog,
    config,
    governor,
    acquisition,
    (phase) => phases.push(phase),
    undefined,
    false,
    async () => { throw new Error('Timed out waiting for Stockfish after 30000 ms'); },
  );

  assert.equal(report.analysis.positions, 0);
  assert.equal(report.analysis.moves, 0);
  assert.equal(report.analysis.skipped, true);
  assert.match(report.analysis.recoverableError, /Timed out waiting for Stockfish/);
  assert.equal(report.maintenance.skipped, false);
  assert.ok(phases.includes('maintenance'));
});

test('acquisition-only execution stays isolated from ingestion, analysis, and publication', async (t) => {
  const config = await workspace(t);
  config.acquisition.enabled = false;
  config.nativeHelperAvailable = false;
  const catalog = new Catalog(config);
  cleanCatalog(t, catalog, config);
  const report = await runDaemon(catalog, config, { once: true, acquisitionOnly: true });
  assert.equal(report.acquisition.enabled, false);
  assert.deepEqual(report.discovered, []);
  assert.deepEqual(report.ingested, []);
  assert.equal(report.integration, null);
  assert.equal(report.analysis, null);
  assert.equal(report.maintenance, null);
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

test('resource governor keeps lightweight work in courtesy mode while the engine is running', async (t) => {
  const config = await workspace(t);
  config.resources.priorityProcessNames = ['msbuild.exe', 'cl.exe'];
  const catalog = new Catalog(config);
  cleanCatalog(t, catalog, config);
  const governor = mockedResourceGovernor(config, catalog, { runningProcesses: ['flashfork_uci.exe'] });
  t.after(() => governor.close());

  await assert.rejects(governor.permit(), /Unknown Book Forge resource work class/);
  for (const workClass of [RESOURCE_WORK_CLASSES.ACQUISITION, RESOURCE_WORK_CLASSES.INTEGRATION_PUBLICATION]) {
    const permit = await governor.permit(workClass);
    assert.equal(permit.workClass, workClass);
    assert.equal(permit.allowed, true);
    assert.equal(permit.mode, 'courtesy');
    assert.equal(permit.engineProcessRunning, true);
    assert.equal(permit.hardStop, false);
  }
  for (const workClass of [RESOURCE_WORK_CLASSES.STOCKFISH_ANALYSIS, RESOURCE_WORK_CLASSES.INGESTION_AND_MAINTENANCE]) {
    const permit = await governor.permit(workClass);
    assert.equal(permit.workClass, workClass);
    assert.equal(permit.allowed, false);
    assert.equal(permit.mode, 'backoff');
    assert.equal(permit.engineProcessRunning, true);
    assert.equal(permit.hardStop, false);
    assert.match(permit.reason, /flashfork_uci\.exe is running/);
  }
});

test('every hard resource stop rejects every work class', async (t) => {
  const config = await workspace(t);
  config.resources.minimumFreeWorkspaceGb = 75;
  config.resources.priorityProcessNames = ['flashfork_uci.exe', 'msbuild.exe', 'cl.exe'];
  const catalog = new Catalog(config);
  cleanCatalog(t, catalog, config);
  const states = [
    { name: 'operator pause', setup: () => catalog.setPaused(true, 'test pause') },
    { name: 'insufficient disk', options: { freeWorkspaceGb: 1 } },
    { name: 'insufficient memory', options: { availableMemoryGb: 1 } },
    { name: 'battery', options: { native: { on_battery: true } } },
    { name: 'restricted processor power', options: { idleRatio: 0.25, native: { processor_limit_percent: 50 } } },
    { name: 'compiler process', options: { runningProcesses: ['msbuild.exe'] } },
  ];

  for (const state of states) {
    catalog.setPaused(false, '');
    state.setup?.();
    const governor = mockedResourceGovernor(config, catalog, state.options);
    try {
      for (const workClass of Object.values(RESOURCE_WORK_CLASSES)) {
        const permit = await governor.permit(workClass);
        assert.equal(permit.allowed, false, `${state.name} allowed ${workClass}`);
        assert.equal(permit.hardStop, true, `${state.name} did not mark ${workClass} as a hard stop`);
        assert.ok(permit.reason, `${state.name} did not explain ${workClass}`);
      }
    } finally {
      governor.close();
    }
  }
  catalog.setPaused(false, '');
});

test('daemon advances acquisition and integration publication while deferring heavy work to a running engine', async (t) => {
  const config = await workspace(t);
  config.resources.priorityProcessNames = ['flashfork_uci.exe', 'msbuild.exe', 'cl.exe'];
  config.channels.qualified = false;
  const catalog = new Catalog(config);
  cleanCatalog(t, catalog, config);
  const source = await registerInput(catalog, { fixtureId: 'bootstrap_v1' });
  await ingestSource(catalog, source, config);
  const governor = mockedResourceGovernor(config, catalog, { runningProcesses: ['flashfork_uci.exe'] });
  t.after(() => governor.close());
  const phases = [];
  const acquisition = {
    async run(acquisitionGovernor) {
      const permit = await acquisitionGovernor.permit(RESOURCE_WORK_CLASSES.ACQUISITION);
      assert.equal(permit.allowed, true);
      assert.equal(permit.mode, 'courtesy');
      return { enabled: true, requests: 1, positions: 1, moves: 2, enqueued: 0, stopped: '' };
    },
  };

  const report = await runCycle(catalog, config, governor, acquisition,
    (phase, mode) => phases.push({ phase, mode }), 1);
  assert.equal(report.acquisition.requests, 1);
  assert.ok(report.integration?.snapshotId);
  assert.equal(report.analysis.skipped, true);
  assert.match(report.analysis.reason, /flashfork_uci\.exe is running/);
  assert.equal(report.maintenance.skipped, true);
  assert.match(report.maintenance.reason, /flashfork_uci\.exe is running/);
  assert.ok(phases.some(({ phase, mode }) => phase === 'publication' && mode === 'courtesy'));
  assert.ok(phases.some(({ phase, mode }) => phase === 'analysis' && mode === 'backoff'));
});

test('resource governor enters backoff before starting work under disk pressure', async (t) => {
  const config = await workspace(t);
  config.resources.minimumFreeWorkspaceGb = 1_000_000_000;
  config.nativeHelperAvailable = false;
  const catalog = new Catalog(config);
  cleanCatalog(t, catalog, config);
  const governor = new ResourceGovernor(config, catalog);
  t.after(() => governor.close());
  const started = performance.now();
  const permit = await governor.permit(RESOURCE_WORK_CLASSES.ACQUISITION);
  assert.equal(permit.allowed, false);
  assert.equal(permit.mode, 'backoff');
  assert.equal(permit.hardStop, true);
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

test('native launcher is a GUI process that runs Node without a console and propagates its exit code', async (t) => {
  const config = await workspace(t);
  t.after(() => rm(config.workspace, { recursive: true, force: true }));
  if (!config.nativeLauncherAvailable) return t.skip('native windowless launcher is not built');

  const executable = await readFile(config.nativeLauncher);
  const peOffset = executable.readUInt32LE(0x3c);
  assert.equal(executable.readUInt32LE(peOffset), 0x00004550);
  assert.equal(executable.readUInt16LE(peOffset + 24 + 68), 2);

  const { stdout } = await execFileAsync(config.nativeLauncher, ['--probe'], { windowsHide: true, timeout: 5_000 });
  assert.deepEqual(JSON.parse(stdout), {
    schema: 'flashfork_book_forge_launcher_probe_v1', windows_gui_subsystem: true, create_no_window: true,
  });

  const fixture = path.join(config.workspace, 'launcher fixture.mjs');
  const marker = path.join(config.workspace, 'launcher marker.txt');
  await writeFile(fixture, "import { writeFile } from 'node:fs/promises';\nawait writeFile(process.argv[2], process.argv[3]);\nprocess.exitCode = Number(process.argv[4]);\n");
  await assert.rejects(execFileAsync(config.nativeLauncher,
    [process.execPath, fixture, marker, 'windowless child completed', '23'], { windowsHide: true, timeout: 10_000 }),
  (error) => error.code === 23);
  assert.equal(await readFile(marker, 'utf8'), 'windowless child completed');
});
