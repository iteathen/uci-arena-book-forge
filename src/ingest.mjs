import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import * as zlib from 'node:zlib';
import { Chess } from 'chess.js';
import { canonicalFen, encodePolyglotMove, keyBuffer, polyglotKey, positionFingerprint, uciFromVerboseMove } from './chess.mjs';
import { packageRoot } from './config.mjs';

export async function sha256File(filename, governor = null) {
  const hash = createHash('sha256');
  let bytesUntilPermit = 64 * 1024 * 1024;
  for await (const chunk of createReadStream(filename)) {
    hash.update(chunk);
    bytesUntilPermit -= chunk.length;
    if (governor && bytesUntilPermit <= 0) {
      const permit = await governor.permit();
      if (!permit.allowed) {
        const error = new Error(`Source hashing backed off: ${permit.reason}`);
        error.code = 'BOOK_FORGE_BACKOFF';
        throw error;
      }
      bytesUntilPermit = 64 * 1024 * 1024;
    }
  }
  return hash.digest('hex');
}

export function fixturePath(fixtureId) {
  if (!/^[a-z0-9_-]+$/i.test(fixtureId)) throw new Error(`Invalid fixture id: ${fixtureId}`);
  return path.join(packageRoot, 'fixtures', `${fixtureId}.json`);
}

export async function registerInput(catalog, { filename, fixtureId }, governor = null) {
  const sourcePath = fixtureId ? fixturePath(fixtureId) : path.resolve(filename);
  const sourceType = fixtureId ? 'integration_fixture' : detectSourceType(sourcePath);
  const sha256 = await sha256File(sourcePath, governor);
  return catalog.registerSource({ sha256, sourcePath, sourceType, fixture: Boolean(fixtureId) });
}

export async function discoverInbox(catalog, config, governor = null) {
  const discovered = [];
  const entries = await readdir(config.paths.inbox, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/\.pgn(?:\.gz|\.zst)?$/i.test(entry.name)) continue;
    const sourcePath = path.join(config.paths.inbox, entry.name);
    const details = await stat(sourcePath);
    if (config.ingestion.inboxSettleSeconds > 0 && Date.now() - details.mtimeMs < config.ingestion.inboxSettleSeconds * 1000) continue;
    const previous = catalog.inboxFile(sourcePath);
    if (previous && Number(previous.byte_size) === details.size && Number(previous.modified_ms) === Math.trunc(details.mtimeMs)) continue;
    let source;
    try {
      source = await registerInput(catalog, { filename: sourcePath }, governor);
    } catch (error) {
      if (error.code === 'BOOK_FORGE_BACKOFF') break;
      throw error;
    }
    if (previous && Number(previous.source_id) !== Number(source.id)) catalog.setSourceLifecycle(previous.source_id, 'quarantined');
    catalog.recordInboxFile({ sourcePath, byteSize: details.size, modifiedMs: Math.trunc(details.mtimeMs), sha256: source.sha256, sourceId: source.id });
    discovered.push({ sourceId: Number(source.id), sourcePath, sha256: source.sha256 });
  }
  return discovered;
}

function detectSourceType(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pgn')) return 'pgn';
  if (lower.endsWith('.pgn.gz')) return 'pgn_gzip';
  if (lower.endsWith('.pgn.zst')) return 'pgn_zstd';
  throw new Error(`Unsupported source type: ${filename}`);
}

function sourceStream(source) {
  const input = createReadStream(source.source_path);
  if (source.source_type === 'pgn_gzip') return input.pipe(zlib.createGunzip());
  if (source.source_type === 'pgn_zstd') {
    if (!zlib.createZstdDecompress) throw new Error('This Node.js runtime does not provide Zstandard decompression');
    return input.pipe(zlib.createZstdDecompress());
  }
  return input;
}

async function* pgnGames(source) {
  const lines = readline.createInterface({ input: sourceStream(source), crlfDelay: Infinity });
  let game = [];
  for await (const line of lines) {
    if (/^\[Event\s+/.test(line) && game.some((entry) => entry.trim() && !entry.startsWith('['))) {
      yield game.join('\n');
      game = [];
    }
    game.push(line);
  }
  if (game.some((entry) => entry.trim())) yield game.join('\n');
}

function speedFromHeaders(headers) {
  const declaredSpeed = headers.Speed ? String(headers.Speed).toLowerCase() : null;
  if (declaredSpeed) {
    if (declaredSpeed.includes('classical')) return 'classical';
    if (declaredSpeed.includes('rapid')) return 'rapid';
    return null;
  }
  const declared = String(headers.Event ?? '').toLowerCase();
  if (declared.includes('classical')) return 'classical';
  if (declared.includes('rapid')) return 'rapid';
  const timeControl = String(headers.TimeControl ?? '');
  const match = /^(\d+)(?:\+(\d+))?$/.exec(timeControl);
  if (!match) return null;
  const estimatedSeconds = Number(match[1]) + 40 * Number(match[2] ?? 0);
  if (estimatedSeconds >= 1500) return 'classical';
  if (estimatedSeconds >= 480) return 'rapid';
  return null;
}

function monthFromHeaders(headers) {
  const date = String(headers.UTCDate ?? headers.Date ?? 'unknown').replace(/\?/g, '0');
  const match = /^(\d{4})[.-](\d{2})/.exec(date);
  return match ? `${match[1]}-${match[2]}` : 'unknown';
}

function outcomeForMover(result, color) {
  if (result === '1/2-1/2') return 'draws';
  if ((result === '1-0' && color === 'w') || (result === '0-1' && color === 'b')) return 'wins';
  return 'losses';
}

function cohortRecord(map, position, move, cohort, outcome) {
  const rawMove = encodePolyglotMove(move);
  const fingerprint = positionFingerprint(position);
  const identity = `${fingerprint.toString('hex')}:${rawMove}:${cohort.month}:${cohort.speed}:${cohort.ratingBucket}`;
  let record = map.get(identity);
  if (!record) {
    const key = polyglotKey(position);
    record = {
      key, keyBuffer: keyBuffer(key), fingerprint, fen: canonicalFen(position), rawMove, uciMove: move,
      month: cohort.month, speed: cohort.speed, ratingBucket: cohort.ratingBucket,
      games: 0, wins: 0, draws: 0, losses: 0,
    };
    map.set(identity, record);
  }
  record.games += 1;
  record[outcome] += 1;
}

async function ingestFixture(catalog, source) {
  const fixture = JSON.parse(await readFile(source.source_path, 'utf8'));
  if (fixture.schema !== 'flashfork_book_forge_fixture_v1' || fixture.qualification !== 'integration_only') {
    throw new Error(`Invalid integration fixture: ${source.source_path}`);
  }
  const records = fixture.observations.map((entry) => {
    const fen = canonicalFen(entry.fen);
    const chess = new Chess(fen);
    const uciMove = entry.move;
    try {
      if (!chess.move({ from: uciMove.slice(0, 2), to: uciMove.slice(2, 4), promotion: uciMove[4] })) {
        throw new Error('illegal');
      }
    } catch {
      throw new Error(`Fixture contains illegal move ${uciMove} for ${fen}`);
    }
    if (entry.games !== entry.wins + entry.draws + entry.losses || entry.games <= 0) {
      throw new Error(`Fixture outcome counts do not balance for ${uciMove}`);
    }
    const key = polyglotKey(fen);
    return {
      key, keyBuffer: keyBuffer(key), fingerprint: positionFingerprint(fen), fen,
      rawMove: encodePolyglotMove(uciMove), uciMove, month: 'fixture', speed: 'fixture', ratingBucket: 0,
      games: entry.games, wins: entry.wins, draws: entry.draws, losses: entry.losses,
    };
  });
  catalog.replaceObservationChunk(source.id, 0, records);
  return { gamesSeen: records.reduce((sum, record) => sum + record.games, 0), gamesAccepted: records.reduce((sum, record) => sum + record.games, 0), chunks: 1 };
}

async function ingestPgn(catalog, source, config, governor) {
  const records = new Map();
  let gamesSeen = 0;
  let gamesAccepted = 0;
  let gamesInChunk = 0;
  let chunkIndex = 0;

  const flush = () => {
    if (records.size === 0) return;
    catalog.replaceObservationChunk(source.id, chunkIndex, [...records.values()]);
    chunkIndex += 1;
    records.clear();
    gamesInChunk = 0;
    catalog.updateSource(source.id, 'processing', { gamesSeen, gamesAccepted, chunks: chunkIndex });
  };

  for await (const pgn of pgnGames(source)) {
    gamesSeen += 1;
    if (governor && gamesSeen % 128 === 0) {
      const permit = await governor.permit();
      if (!permit.allowed) {
        flush();
        return { gamesSeen, gamesAccepted, chunks: chunkIndex, interrupted: true, reason: permit.reason };
      }
    }
    const chess = new Chess();
    try {
      chess.loadPgn(pgn, { strict: true });
    } catch {
      continue;
    }
    const headers = chess.getHeaders();
    const result = headers.Result;
    if (!['1-0', '0-1', '1/2-1/2'].includes(result)) continue;
    if (headers.Variant && !/^standard$/i.test(headers.Variant)) continue;
    if (headers.SetUp === '1' || headers.FEN) continue;
    const whiteElo = Number(headers.WhiteElo);
    const blackElo = Number(headers.BlackElo);
    if (!Number.isFinite(whiteElo) || !Number.isFinite(blackElo) ||
        whiteElo < config.ingestion.minimumRating || blackElo < config.ingestion.minimumRating) continue;
    const speed = speedFromHeaders(headers);
    if (!speed || !config.ingestion.speeds.includes(speed)) continue;
    const history = chess.history({ verbose: true }).slice(0, config.ingestion.maximumPly);
    if (history.length === 0) continue;
    const replay = new Chess();
    const cohort = {
      month: monthFromHeaders(headers), speed,
      ratingBucket: Math.floor(Math.min(whiteElo, blackElo) / 100) * 100,
    };
    for (const move of history) {
      const uci = uciFromVerboseMove(move);
      cohortRecord(records, replay.fen(), uci, cohort, outcomeForMover(result, move.color));
      replay.move({ from: move.from, to: move.to, promotion: move.promotion });
    }
    gamesAccepted += 1;
    gamesInChunk += 1;
    if (gamesInChunk >= config.ingestion.chunkGames || records.size >= config.ingestion.maximumChunkRecords) flush();
  }
  flush();
  return { gamesSeen, gamesAccepted, chunks: chunkIndex };
}

export async function ingestSource(catalog, source, config, governor = null) {
  catalog.updateSource(source.id, 'processing');
  try {
    const telemetry = source.fixture ? await ingestFixture(catalog, source) : await ingestPgn(catalog, source, config, governor);
    catalog.updateSource(source.id, telemetry.interrupted ? 'processing' : 'complete', telemetry);
    return telemetry;
  } catch (error) {
    catalog.updateSource(source.id, 'error', { error: error.message });
    throw error;
  }
}
