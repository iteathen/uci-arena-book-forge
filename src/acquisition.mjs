import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Chess } from 'chess.js';
import { canonicalFen, encodePolyglotMove, keyBuffer, legalUciMove, polyglotKey, positionFingerprint } from './chess.mjs';
import { parsePolicy, scoreSiblingCandidates } from './book_policy.mjs';
import { packageRoot, suiteRoot } from './config.mjs';
import { readExactCredential } from './exact_credential.mjs';
import { RESOURCE_WORK_CLASSES } from './resource_governor.mjs';

const providerId = 'lichess_opening_explorer';
const overlapDomain = 'lichess_standard_rated';
const startFen = canonicalFen(new Chess().fen());
const maximumResponseBytes = 1_048_576;

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

async function boundedResponseText(response) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumResponseBytes) {
    throw new Error('Explorer response exceeds the 1 MiB contract');
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maximumResponseBytes) {
      throw new Error('Explorer response exceeds the 1 MiB contract');
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumResponseBytes) {
        try { await reader.cancel('response limit exceeded'); } catch {}
        throw new Error('Explorer response exceeds the 1 MiB contract');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function positionRecord(fen) {
  const canonical = canonicalFen(fen);
  const key = polyglotKey(canonical);
  return { fen: canonical, fingerprint: positionFingerprint(canonical), key, keyBuffer: keyBuffer(key) };
}

function safeCount(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Explorer response has invalid ${field}`);
  return value;
}

function normalizedQuery(config) {
  return {
    variant: config.acquisition.variant,
    speeds: [...config.acquisition.speeds].sort(),
    ratings: [...config.acquisition.ratings].sort((left, right) => left - right),
    moves: config.acquisition.movesPerPosition,
    topGames: 0,
    recentGames: 0,
    history: false,
  };
}

function canonicalProviderMove(fen, uci) {
  // This provider encodes castling as king-to-rook, including standard games.
  // Match an actual legal standard castle before translating transport notation.
  const destination = { e1h1: 'g1', e1a1: 'c1', e8h8: 'g8', e8a8: 'c8' }[uci];
  if (typeof destination !== 'string') return uci;
  const chess = new Chess(canonicalFen(fen));
  const from = uci.slice(0, 2);
  const king = chess.get(from);
  const rook = chess.get(uci.slice(2, 4));
  if (king?.type !== 'k' || rook?.type !== 'r' || rook.color !== king.color) return uci;
  const castle = chess.moves({ verbose: true }).some((move) => move.from === from && move.to === destination &&
    (move.flags.includes('k') || move.flags.includes('q')));
  return castle ? `${from}${destination}` : uci;
}

function responseRecords(fen, payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.moves)) throw new Error('Explorer response is not a move aggregate object');
  if (payload.moves.length > 50) throw new Error('Explorer response exceeds the requested move bound');
  const totals = {
    white: safeCount(payload.white, 'white total'), draws: safeCount(payload.draws, 'draw total'),
    black: safeCount(payload.black, 'black total'),
  };
  const moverIsWhite = canonicalFen(fen).split(' ')[1] === 'w';
  const seen = new Set();
  const records = payload.moves.map((move, index) => {
    if (!move || typeof move !== 'object' || typeof move.uci !== 'string') {
      throw new Error(`Explorer response has invalid move at index ${index}`);
    }
    const uci = canonicalProviderMove(fen, move.uci);
    if (seen.has(uci) || !legalUciMove(fen, uci)) throw new Error(`Explorer response has invalid move at index ${index}`);
    seen.add(uci);
    const white = safeCount(move.white, `move ${move.uci} white`);
    const draws = safeCount(move.draws, `move ${move.uci} draws`);
    const black = safeCount(move.black, `move ${move.uci} black`);
    const averageRating = safeCount(move.averageRating, `move ${move.uci} average rating`);
    return {
      rawMove: encodePolyglotMove(uci), uciMove: uci, games: white + draws + black,
      wins: moverIsWhite ? white : black, draws, losses: moverIsWhite ? black : white, averageRating,
    };
  });
  const returned = records.reduce((sum, record) => ({
    white: sum.white + (moverIsWhite ? record.wins : record.losses), draws: sum.draws + record.draws,
    black: sum.black + (moverIsWhite ? record.losses : record.wins),
  }), { white: 0, draws: 0, black: 0 });
  if (returned.white > totals.white || returned.draws > totals.draws || returned.black > totals.black) {
    throw new Error('Explorer move totals exceed position totals');
  }
  return records;
}

function retryAfterMilliseconds(response, minimum = 60_000) {
  const value = response.headers.get('retry-after');
  if (!value) return minimum;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(minimum, seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(minimum, timestamp - Date.now()) : minimum;
}

export class ExplorerAcquisition {
  constructor(catalog, config, {
    fetchImpl = globalThis.fetch,
    delayImpl = delay,
    credentialReader = readExactCredential,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('Book Forge acquisition requires a Fetch implementation');
    this.catalog = catalog;
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.delay = delayImpl;
    this.credentialReader = credentialReader;
    this.dataset = null;
    this.policy = null;
    this.lastRequestAt = 0;
  }

  async initialize() {
    if (this.dataset) return this.dataset;
    const query = normalizedQuery(this.config);
    const queryJson = JSON.stringify(query);
    this.dataset = this.catalog.ensureAcquisitionDataset({
      provider: providerId, overlapDomain, contributionMode: 'authoritative', queryJson, queryDigest: sha256(queryJson),
    });
    this.catalog.recoverAcquisitionWork(Number(this.dataset.id));
    const seed = positionRecord(startFen);
    this.catalog.enqueueFrontier(Number(this.dataset.id), { ...seed, ply: 0, priority: Number.MAX_SAFE_INTEGER });
    this.policy = parsePolicy(await readFile(this.config.policyFile, 'utf8'));
    return this.dataset;
  }

  async credential() {
    try {
      return await this.credentialReader(this.config.acquisition.tokenFile, {
        excludedRoots: [packageRoot, suiteRoot, this.config.workspace],
      });
    } catch {
      const error = new Error('Lichess acquisition credential is unavailable');
      error.code = 'BOOK_FORGE_AUTH';
      throw error;
    }
  }

  requestUrl(fen) {
    const query = normalizedQuery(this.config);
    const url = new URL(this.config.acquisition.endpoint);
    url.searchParams.set('variant', query.variant);
    url.searchParams.set('speeds', query.speeds.join(','));
    url.searchParams.set('ratings', query.ratings.join(','));
    url.searchParams.set('moves', String(query.moves));
    url.searchParams.set('topGames', '0');
    url.searchParams.set('recentGames', '0');
    url.searchParams.set('history', 'false');
    url.searchParams.set('fen', canonicalFen(fen));
    return url;
  }

  async fetchPosition(frontier, governor) {
    const wait = this.config.acquisition.requestIntervalMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) await this.delay(wait);
    const token = await this.credential();
    const controller = new AbortController();
    let abortReason = null;
    let polling = false;
    const timeout = setTimeout(() => { abortReason = 'request timeout'; controller.abort(); }, this.config.acquisition.requestTimeoutMs);
    const resourcePoll = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const permit = await governor.permit(RESOURCE_WORK_CLASSES.ACQUISITION);
        if (!permit.allowed) { abortReason = permit.reason || 'resource permission revoked'; controller.abort(); }
      } catch {
        abortReason = 'resource permission check failed';
        controller.abort();
      } finally {
        polling = false;
      }
    }, this.config.acquisition.resourcePollMs);
    try {
      this.lastRequestAt = Date.now();
      const response = await this.fetchImpl(this.requestUrl(frontier.fen), {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        const error = new Error('Lichess acquisition authentication was rejected');
        error.code = 'BOOK_FORGE_AUTH'; error.status = response.status; throw error;
      }
      if (response.status === 429) {
        const error = new Error('Lichess acquisition rate limit');
        error.code = 'BOOK_FORGE_RATE_LIMIT'; error.status = response.status;
        error.retryAfterMs = retryAfterMilliseconds(response); throw error;
      }
      if (!response.ok) {
        const error = new Error(`Lichess acquisition HTTP ${response.status}`);
        error.code = 'BOOK_FORGE_HTTP'; error.status = response.status; throw error;
      }
      const body = await boundedResponseText(response);
      let payload;
      try { payload = JSON.parse(body); } catch { throw new Error('Explorer response is not valid JSON'); }
      return { records: responseRecords(frontier.fen, payload), responseDigest: sha256(body), status: response.status };
    } catch (error) {
      if (error.name === 'AbortError') {
        const wrapped = new Error(abortReason || 'Lichess acquisition request aborted');
        wrapped.code = abortReason === 'request timeout' ? 'BOOK_FORGE_TIMEOUT' : 'BOOK_FORGE_BACKOFF';
        throw wrapped;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      clearInterval(resourcePoll);
    }
  }

  enqueueChildren(frontier, records) {
    const { eligible } = scoreSiblingCandidates(records, this.policy, this.config.acquisition.crawlLcbGap);
    if (Number(frontier.ply) >= this.config.acquisition.maximumPly) return 0;
    const parent = positionFingerprint(frontier.fen);
    let enqueued = 0;
    for (const record of eligible) {
      if (record.games < this.config.acquisition.minimumGames) continue;
      const chess = new Chess(canonicalFen(frontier.fen));
      chess.move({ from: record.uciMove.slice(0, 2), to: record.uciMove.slice(2, 4), promotion: record.uciMove[4] });
      const child = positionRecord(chess.fen());
      this.catalog.enqueueFrontier(Number(this.dataset.id), {
        ...child, ply: Number(frontier.ply) + 1, parentFingerprint: parent,
        viaMove: record.uciMove, priority: record.selectionWeight,
      });
      enqueued += 1;
    }
    return enqueued;
  }

  failureDelay(error, failures) {
    if (error.code === 'BOOK_FORGE_AUTH') return 6 * 60 * 60 * 1_000;
    if (error.code === 'BOOK_FORGE_RATE_LIMIT') return Math.max(60_000, error.retryAfterMs ?? 0, Math.min(3_600_000, 60_000 * 2 ** failures));
    return Math.min(30 * 60_000, 30_000 * 2 ** failures);
  }

  async run(governor, { maxRequests } = {}) {
    if (!this.config.acquisition.enabled) return { enabled: false, requests: 0, positions: 0, moves: 0 };
    await this.initialize();
    const status = this.catalog.acquisitionStatus();
    const bootstrapRemaining = Math.max(0, this.config.acquisition.firstPublishPositions - status.positions);
    const limit = Math.max(1, Number(maxRequests ?? (bootstrapRemaining ? Math.min(bootstrapRemaining, 25) : 1)));
    const report = { enabled: true, requests: 0, positions: 0, moves: 0, enqueued: 0, stopped: '' };
    for (let count = 0; count < limit; count += 1) {
      const permit = await governor.permit(RESOURCE_WORK_CLASSES.ACQUISITION);
      if (!permit.allowed) { report.stopped = permit.reason; break; }
      const frontier = this.catalog.nextFrontier(Number(this.dataset.id));
      if (!frontier) { report.stopped = 'frontier not due'; break; }
      if (!this.catalog.consumeAcquisitionRequest(this.config.acquisition.dailyRequestBudget)) {
        report.stopped = 'daily request budget exhausted'; break;
      }
      this.catalog.markFrontierAttempt(Number(this.dataset.id), frontier.fingerprint);
      report.requests += 1;
      try {
        const result = await this.fetchPosition(frontier, governor);
        const position = positionRecord(frontier.fen);
        this.catalog.replaceRemotePosition(Number(this.dataset.id), position, result.records, result.responseDigest);
        report.enqueued += this.enqueueChildren(frontier, result.records);
        const refreshDays = frontier.published ? this.config.acquisition.publishedRefreshDays : this.config.acquisition.frontierRefreshDays;
        this.catalog.completeFrontier(Number(this.dataset.id), frontier.fingerprint, {
          responseDigest: result.responseDigest, httpStatus: result.status, refreshDays,
        });
        report.positions += 1;
        report.moves += result.records.length;
      } catch (error) {
        const milliseconds = this.failureDelay(error, Number(frontier.failures));
        this.catalog.failFrontier(Number(this.dataset.id), frontier.fingerprint, {
          state: error.code === 'BOOK_FORGE_AUTH' ? 'auth_blocked' : 'backoff', httpStatus: error.status ?? null,
          error: error.message, nextDueAt: new Date(Date.now() + milliseconds).toISOString(),
        });
        report.stopped = error.message;
        if (error.code === 'BOOK_FORGE_BACKOFF') break;
        if (error.code === 'BOOK_FORGE_AUTH' || error.code === 'BOOK_FORGE_RATE_LIMIT') break;
      }
    }
    return report;
  }
}

export function acquisitionQuery(config) { return normalizedQuery(config); }
export function validateExplorerResponse(fen, payload) { return responseRecords(fen, payload); }
