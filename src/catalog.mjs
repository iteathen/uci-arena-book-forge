import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { shardForKey } from './chess.mjs';

const CATALOG_SCHEMA = 4;
const SHARD_SCHEMA = 3;

function transaction(database, action) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export class Catalog {
  constructor(config) {
    this.config = config;
    mkdirSync(config.workspace, { recursive: true });
    for (const directory of Object.values(config.paths).filter((entry) => entry !== config.paths.catalog)) {
      mkdirSync(directory, { recursive: true });
    }
    this.database = new DatabaseSync(config.paths.catalog);
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS control (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), paused INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, source_path TEXT NOT NULL,
        source_type TEXT NOT NULL, fixture INTEGER NOT NULL DEFAULT 0,
        overlap_domain TEXT NOT NULL DEFAULT '',
        contribution_mode TEXT NOT NULL DEFAULT 'additive' CHECK(contribution_mode IN ('additive','audit_only')),
        status TEXT NOT NULL CHECK(status IN ('pending','processing','complete','error')),
        lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','quarantined','retired','restored')),
        games_seen INTEGER NOT NULL DEFAULT 0, games_accepted INTEGER NOT NULL DEFAULT 0,
        chunks INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY, channel TEXT NOT NULL, directory TEXT NOT NULL UNIQUE,
        record_count INTEGER NOT NULL, includes_fixture INTEGER NOT NULL,
        qualified INTEGER NOT NULL, manifest_sha256 TEXT NOT NULL, created_at TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS channels (
        channel TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, directory TEXT NOT NULL,
        published_at TEXT NOT NULL, FOREIGN KEY(snapshot_id) REFERENCES snapshots(id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS qualification_gates (
        snapshot_id TEXT NOT NULL, gate TEXT NOT NULL, passed INTEGER NOT NULL,
        evidence TEXT NOT NULL, recorded_at TEXT NOT NULL,
        PRIMARY KEY(snapshot_id, gate)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS inbox_files (
        source_path TEXT PRIMARY KEY, byte_size INTEGER NOT NULL, modified_ms INTEGER NOT NULL,
        sha256 TEXT NOT NULL, source_id INTEGER NOT NULL, discovered_at TEXT NOT NULL,
        FOREIGN KEY(source_id) REFERENCES sources(id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS acquisition_datasets (
        id INTEGER PRIMARY KEY, provider TEXT NOT NULL, overlap_domain TEXT NOT NULL,
        contribution_mode TEXT NOT NULL CHECK(contribution_mode IN ('authoritative','audit_only')),
        query_json TEXT NOT NULL, query_digest TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS acquisition_authoritative_domain_idx
        ON acquisition_datasets(overlap_domain) WHERE contribution_mode='authoritative';
      CREATE TABLE IF NOT EXISTS acquisition_frontier (
        dataset_id INTEGER NOT NULL, fingerprint BLOB NOT NULL, fen TEXT NOT NULL, ply INTEGER NOT NULL,
        parent_fingerprint BLOB, via_move TEXT, state TEXT NOT NULL DEFAULT 'queued'
          CHECK(state IN ('queued','in_flight','ready','backoff','auth_blocked')),
        priority REAL NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 0,
        first_seen_at TEXT NOT NULL, last_queried_at TEXT,
        next_due_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
        last_http_status INTEGER, error TEXT NOT NULL DEFAULT '', response_digest TEXT,
        PRIMARY KEY(dataset_id,fingerprint),
        FOREIGN KEY(dataset_id) REFERENCES acquisition_datasets(id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS acquisition_frontier_due_idx
        ON acquisition_frontier(dataset_id,state,next_due_at,ply,priority);
      CREATE TABLE IF NOT EXISTS acquisition_request_budget (
        utc_day TEXT PRIMARY KEY, requests INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS daemon_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER, phase TEXT NOT NULL DEFAULT 'stopped',
        started_at TEXT, heartbeat_at TEXT, cycle_started_at TEXT, cycle_completed_at TEXT,
        resource_mode TEXT NOT NULL DEFAULT '', last_report TEXT NOT NULL DEFAULT '{}',
        last_error TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO control(singleton, paused, reason, updated_at)
        VALUES(1, 0, '', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      INSERT OR IGNORE INTO daemon_state(singleton,updated_at)
        VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    `);
    const storedVersion = this.database.prepare('SELECT value FROM metadata WHERE key=?').get('schema_version');
    let catalogVersion = Number(storedVersion?.value ?? 0);
    if (catalogVersion === 1) {
      const columns = new Set(this.database.prepare('PRAGMA table_info(sources)').all().map((column) => column.name));
      if (!columns.has('lifecycle')) {
        this.database.exec("ALTER TABLE sources ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','quarantined','retired','restored'))");
      }
      catalogVersion = 2;
    }
    if (catalogVersion === 2) catalogVersion = 3;
    if (catalogVersion === 3) {
      const columns = new Set(this.database.prepare('PRAGMA table_info(sources)').all().map((column) => column.name));
      if (!columns.has('overlap_domain')) this.database.exec("ALTER TABLE sources ADD COLUMN overlap_domain TEXT NOT NULL DEFAULT ''");
      if (!columns.has('contribution_mode')) {
        this.database.exec("ALTER TABLE sources ADD COLUMN contribution_mode TEXT NOT NULL DEFAULT 'additive' CHECK(contribution_mode IN ('additive','audit_only'))");
      }
      this.database.exec("UPDATE sources SET overlap_domain='manual:' || sha256 WHERE overlap_domain=''");
      catalogVersion = 4;
    }
    if (!storedVersion) {
      this.database.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('schema_version', String(CATALOG_SCHEMA));
    } else if (catalogVersion === CATALOG_SCHEMA) {
      this.database.prepare('UPDATE metadata SET value=? WHERE key=?').run(String(CATALOG_SCHEMA), 'schema_version');
    } else {
      throw new Error(`Unsupported catalog schema ${storedVersion.value}`);
    }
    this.shards = new Map();
  }

  close() {
    for (const database of this.shards.values()) database.close();
    this.shards.clear();
    this.database.close();
  }

  shard(index) {
    if (!Number.isInteger(index) || index < 0 || index >= 64) throw new Error(`Invalid shard index ${index}`);
    if (this.shards.has(index)) return this.shards.get(index);
    const filename = path.join(this.config.paths.shards, `observations-${String(index).padStart(2, '0')}.sqlite`);
    const database = new DatabaseSync(filename);
    database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
    database.prepare('ATTACH DATABASE ? AS forge_catalog').run(this.config.paths.catalog);
    database.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS positions (
        fingerprint BLOB PRIMARY KEY, polyglot_key BLOB NOT NULL, fen TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS positions_key_idx ON positions(polyglot_key);
      CREATE TABLE IF NOT EXISTS observations (
        source_id INTEGER NOT NULL, chunk_index INTEGER NOT NULL, month TEXT NOT NULL,
        speed TEXT NOT NULL, rating_bucket INTEGER NOT NULL, fingerprint BLOB NOT NULL,
        raw_move INTEGER NOT NULL, uci_move TEXT NOT NULL, games INTEGER NOT NULL,
        wins INTEGER NOT NULL, draws INTEGER NOT NULL, losses INTEGER NOT NULL,
        PRIMARY KEY(source_id, chunk_index, month, speed, rating_bucket, fingerprint, raw_move)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS observations_position_idx ON observations(fingerprint, raw_move);
      CREATE TABLE IF NOT EXISTS evaluations (
        fingerprint BLOB NOT NULL, raw_move INTEGER NOT NULL, engine_fingerprint TEXT NOT NULL,
        node_tier INTEGER NOT NULL, score_cp INTEGER, relative_loss_cp INTEGER, wdl TEXT, mate INTEGER, depth INTEGER NOT NULL,
        pv TEXT NOT NULL, lifecycle TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
        PRIMARY KEY(fingerprint, raw_move, engine_fingerprint, node_tier)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS remote_observations (
        dataset_id INTEGER NOT NULL, fingerprint BLOB NOT NULL, raw_move INTEGER NOT NULL,
        uci_move TEXT NOT NULL, games INTEGER NOT NULL, wins INTEGER NOT NULL, draws INTEGER NOT NULL,
        losses INTEGER NOT NULL, average_rating INTEGER NOT NULL, observed_at TEXT NOT NULL,
        response_digest TEXT NOT NULL,
        PRIMARY KEY(dataset_id, fingerprint, raw_move)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS remote_observations_position_idx
        ON remote_observations(fingerprint, raw_move);
    `);
    const storedVersion = database.prepare('SELECT value FROM metadata WHERE key=?').get('schema_version');
    if (storedVersion && Number(storedVersion.value) === 1) {
      const columns = new Set(database.prepare('PRAGMA table_info(evaluations)').all().map((column) => column.name));
      if (!columns.has('relative_loss_cp')) database.exec('ALTER TABLE evaluations ADD COLUMN relative_loss_cp INTEGER');
      database.prepare('UPDATE metadata SET value=? WHERE key=?').run(String(SHARD_SCHEMA), 'schema_version');
    } else if (!storedVersion) {
      database.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('schema_version', String(SHARD_SCHEMA));
    } else if (Number(storedVersion.value) === 2) {
      database.prepare('UPDATE metadata SET value=? WHERE key=?').run(String(SHARD_SCHEMA), 'schema_version');
    } else if (Number(storedVersion.value) !== SHARD_SCHEMA) {
      throw new Error(`Unsupported shard schema ${storedVersion.value}`);
    }
    this.shards.set(index, database);
    return database;
  }

  existingShardIndexes() {
    const indexes = [];
    for (let index = 0; index < 64; index += 1) {
      if (existsSync(path.join(this.config.paths.shards, `observations-${String(index).padStart(2, '0')}.sqlite`))) indexes.push(index);
    }
    return indexes;
  }

  registerSource({ sha256, sourcePath, sourceType, fixture = false, overlapDomain = `manual:${sha256}`, contributionMode = 'additive' }) {
    if (!['additive', 'audit_only'].includes(contributionMode)) throw new Error(`Invalid source contribution mode ${contributionMode}`);
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT OR IGNORE INTO sources(sha256,source_path,source_type,fixture,overlap_domain,contribution_mode,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?, 'pending',?,?)
    `).run(sha256, sourcePath, sourceType, fixture ? 1 : 0, overlapDomain, contributionMode, now, now);
    return this.database.prepare('SELECT * FROM sources WHERE sha256=?').get(sha256);
  }

  inboxFile(sourcePath) { return this.database.prepare('SELECT * FROM inbox_files WHERE source_path=?').get(sourcePath); }

  recordInboxFile({ sourcePath, byteSize, modifiedMs, sha256, sourceId }) {
    this.database.prepare(`
      INSERT INTO inbox_files(source_path,byte_size,modified_ms,sha256,source_id,discovered_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(source_path) DO UPDATE SET byte_size=excluded.byte_size,modified_ms=excluded.modified_ms,
        sha256=excluded.sha256,source_id=excluded.source_id,discovered_at=excluded.discovered_at
    `).run(sourcePath, byteSize, modifiedMs, sha256, sourceId, new Date().toISOString());
  }

  source(id) { return this.database.prepare('SELECT * FROM sources WHERE id=?').get(id); }
  pendingSources() { return this.database.prepare("SELECT * FROM sources WHERE status IN ('pending','processing','error') AND lifecycle IN ('active','restored') ORDER BY id").all(); }
  *iterateCompletedSources({ includeInactive = false } = {}) {
    yield* this.database.prepare(includeInactive
      ? "SELECT * FROM sources WHERE status='complete' ORDER BY id"
      : "SELECT * FROM sources WHERE status='complete' AND lifecycle IN ('active','restored') ORDER BY id").iterate();
  }

  completedSources(options = {}) {
    return [...this.iterateCompletedSources(options)];
  }

  setSourceLifecycle(id, lifecycle) {
    if (!['active', 'quarantined', 'retired', 'restored'].includes(lifecycle)) throw new Error(`Invalid source lifecycle ${lifecycle}`);
    const result = this.database.prepare('UPDATE sources SET lifecycle=?,updated_at=? WHERE id=?').run(lifecycle, new Date().toISOString(), id);
    if (Number(result.changes) !== 1) throw new Error(`Unknown source ${id}`);
    return this.source(id);
  }

  setMetadata(key, value) {
    this.database.prepare(`INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));
  }

  metadata(key) { return this.database.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value ?? null; }

  updateSource(id, status, telemetry = {}) {
    const current = this.source(id);
    if (!current) throw new Error(`Unknown source ${id}`);
    this.database.prepare(`
      UPDATE sources SET status=?, games_seen=?, games_accepted=?, chunks=?, error=?, updated_at=? WHERE id=?
    `).run(status, telemetry.gamesSeen ?? current.games_seen, telemetry.gamesAccepted ?? current.games_accepted,
      telemetry.chunks ?? current.chunks, telemetry.error ?? '', new Date().toISOString(), id);
  }

  replaceObservationChunk(sourceId, chunkIndex, records) {
    const byShard = new Map();
    for (const record of records) {
      const index = shardForKey(record.key);
      if (!byShard.has(index)) byShard.set(index, []);
      byShard.get(index).push(record);
    }
    for (const index of this.existingShardIndexes()) {
      if (byShard.has(index)) continue;
      this.shard(index).prepare('DELETE FROM observations WHERE source_id=? AND chunk_index=?').run(sourceId, chunkIndex);
    }
    for (const [index, shardRecords] of byShard) {
      const database = this.shard(index);
      transaction(database, () => {
        database.prepare('DELETE FROM observations WHERE source_id=? AND chunk_index=?').run(sourceId, chunkIndex);
        const positionStatement = database.prepare(`
          INSERT INTO positions(fingerprint,polyglot_key,fen) VALUES(?,?,?)
          ON CONFLICT(fingerprint) DO UPDATE SET polyglot_key=excluded.polyglot_key, fen=excluded.fen
        `);
        const observationStatement = database.prepare(`
          INSERT INTO observations(source_id,chunk_index,month,speed,rating_bucket,fingerprint,raw_move,uci_move,games,wins,draws,losses)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        `);
        for (const record of shardRecords) {
          positionStatement.run(record.fingerprint, record.keyBuffer, record.fen);
          observationStatement.run(sourceId, chunkIndex, record.month, record.speed, record.ratingBucket,
            record.fingerprint, record.rawMove, record.uciMove, record.games, record.wins, record.draws, record.losses);
        }
      });
    }
  }

  *iterateAggregateObservationGroups({ includeFixtures }) {
    for (const index of this.existingShardIndexes()) {
      const database = this.shard(index);
      const rows = database.prepare(`
        WITH eligible_observations AS (
          SELECT o.fingerprint,o.raw_move,o.uci_move,o.games,o.wins,o.draws,o.losses
          FROM observations o
          JOIN forge_catalog.sources s ON s.id=o.source_id
          WHERE s.status='complete' AND s.lifecycle IN ('active','restored')
            AND s.contribution_mode='additive' AND (? OR s.fixture=0)
          UNION ALL
          SELECT r.fingerprint,r.raw_move,r.uci_move,r.games,r.wins,r.draws,r.losses
          FROM remote_observations r
          JOIN forge_catalog.acquisition_datasets d ON d.id=r.dataset_id
          WHERE d.contribution_mode='authoritative'
        )
        SELECT e.raw_move,MIN(e.uci_move) AS uci_move,SUM(e.games) AS games,
               SUM(e.wins) AS wins,SUM(e.draws) AS draws,SUM(e.losses) AS losses,
               p.fingerprint,p.polyglot_key,p.fen
        FROM eligible_observations e
        JOIN positions p ON p.fingerprint=e.fingerprint
        GROUP BY e.fingerprint,e.raw_move
        ORDER BY p.polyglot_key,p.fingerprint,e.raw_move
      `).iterate(includeFixtures ? 1 : 0);
      let fingerprint = null;
      let group = [];
      for (const row of rows) {
        const nextFingerprint = Buffer.from(row.fingerprint);
        if (fingerprint && !fingerprint.equals(nextFingerprint)) {
          yield group;
          group = [];
        }
        fingerprint = nextFingerprint;
        const keyBytes = Buffer.from(row.polyglot_key);
        const counts = [row.games, row.wins, row.draws, row.losses].map(Number);
        if (!counts.every((value) => Number.isSafeInteger(value) && value >= 0)
            || counts[0] <= 0 || counts[0] !== counts[1] + counts[2] + counts[3]) {
          throw new Error('Aggregated observation counts are outside the safe integer contract');
        }
        group.push({
          fingerprint: nextFingerprint,
          keyBuffer: keyBytes,
          key: keyBytes.readBigUInt64BE(),
          fen: row.fen,
          rawMove: Number(row.raw_move),
          uciMove: row.uci_move,
          games: counts[0],
          wins: counts[1],
          draws: counts[2],
          losses: counts[3],
        });
      }
      if (group.length) yield group;
    }
  }

  aggregateObservations({ includeFixtures }) {
    return [...this.iterateAggregateObservationGroups({ includeFixtures })].flat();
  }

  hasPublishableObservations({ includeFixtures = true } = {}) {
    if (this.completedSources().some((source) => source.contribution_mode === 'additive' && (includeFixtures || !source.fixture))) return true;
    for (const index of this.existingShardIndexes()) {
      const row = this.shard(index).prepare(`
        SELECT 1 FROM remote_observations r
        JOIN forge_catalog.acquisition_datasets d ON d.id=r.dataset_id
        WHERE d.contribution_mode='authoritative' LIMIT 1
      `).get();
      if (row) return true;
    }
    return false;
  }

  ensureAcquisitionDataset({ provider, overlapDomain, contributionMode, queryJson, queryDigest }) {
    if (!['authoritative', 'audit_only'].includes(contributionMode)) throw new Error(`Invalid acquisition contribution mode ${contributionMode}`);
    const now = new Date().toISOString();
    return transaction(this.database, () => {
      const existing = this.database.prepare('SELECT * FROM acquisition_datasets WHERE query_digest=?').get(queryDigest);
      if (contributionMode === 'authoritative') {
        this.database.prepare(`UPDATE acquisition_datasets SET contribution_mode='audit_only',updated_at=?
          WHERE overlap_domain=? AND contribution_mode='authoritative' AND id<>?`).run(now, overlapDomain, existing?.id ?? -1);
      }
      if (existing) {
        this.database.prepare(`UPDATE acquisition_datasets SET provider=?,overlap_domain=?,contribution_mode=?,query_json=?,updated_at=? WHERE id=?`)
          .run(provider, overlapDomain, contributionMode, queryJson, now, existing.id);
        return this.database.prepare('SELECT * FROM acquisition_datasets WHERE id=?').get(existing.id);
      }
      const result = this.database.prepare(`
        INSERT INTO acquisition_datasets(provider,overlap_domain,contribution_mode,query_json,query_digest,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?)
      `).run(provider, overlapDomain, contributionMode, queryJson, queryDigest, now, now);
      return this.database.prepare('SELECT * FROM acquisition_datasets WHERE id=?').get(result.lastInsertRowid);
    });
  }

  acquisitionDataset(id) { return this.database.prepare('SELECT * FROM acquisition_datasets WHERE id=?').get(id); }

  enqueueFrontier(datasetId, { fingerprint, fen, ply, parentFingerprint = null, viaMove = null, priority = 0 }) {
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO acquisition_frontier(dataset_id,fingerprint,fen,ply,parent_fingerprint,via_move,priority,first_seen_at,next_due_at)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(dataset_id,fingerprint) DO UPDATE SET
        priority=MAX(acquisition_frontier.priority,excluded.priority),
        ply=MIN(acquisition_frontier.ply,excluded.ply)
    `).run(datasetId, fingerprint, fen, ply, parentFingerprint, viaMove, priority, now, now);
  }

  recoverAcquisitionWork(datasetId) {
    this.database.prepare(`UPDATE acquisition_frontier SET state='queued',next_due_at=?,error='recovered interrupted request'
      WHERE dataset_id=? AND state='in_flight'`).run(new Date().toISOString(), datasetId);
  }

  nextFrontier(datasetId, now = new Date()) {
    return this.database.prepare(`
      SELECT * FROM acquisition_frontier
      WHERE dataset_id=? AND state IN ('queued','ready','backoff','auth_blocked') AND next_due_at<=?
      ORDER BY (last_queried_at IS NOT NULL) ASC,
        CASE WHEN last_queried_at IS NULL THEN ply ELSE 0 END ASC,
        CASE WHEN last_queried_at IS NULL THEN priority ELSE 0 END DESC,
        published DESC, next_due_at ASC, hex(fingerprint) ASC
      LIMIT 1
    `).get(datasetId, now.toISOString());
  }

  markFrontierAttempt(datasetId, fingerprint) {
    this.database.prepare(`UPDATE acquisition_frontier SET state='in_flight',attempts=attempts+1,error=''
      WHERE dataset_id=? AND fingerprint=?`).run(datasetId, fingerprint);
  }

  completeFrontier(datasetId, fingerprint, { responseDigest, httpStatus = 200, refreshDays }) {
    const now = new Date();
    const nextDue = new Date(now.getTime() + refreshDays * 86_400_000);
    this.database.prepare(`UPDATE acquisition_frontier SET state='ready',last_queried_at=?,next_due_at=?,
      failures=0,last_http_status=?,error='',response_digest=? WHERE dataset_id=? AND fingerprint=?`)
      .run(now.toISOString(), nextDue.toISOString(), httpStatus, responseDigest, datasetId, fingerprint);
  }

  markPublishedFrontier(records) {
    transaction(this.database, () => {
      this.database.prepare(`UPDATE acquisition_frontier SET published=0 WHERE dataset_id IN
        (SELECT id FROM acquisition_datasets WHERE contribution_mode='authoritative')`).run();
      const update = this.database.prepare(`UPDATE acquisition_frontier SET published=1 WHERE fingerprint=? AND dataset_id IN
        (SELECT id FROM acquisition_datasets WHERE contribution_mode='authoritative')`);
      let previous = null;
      for (const record of records) {
        const fingerprint = Buffer.from(record.fingerprint);
        if (previous?.equals(fingerprint)) continue;
        update.run(fingerprint);
        previous = fingerprint;
      }
    });
  }

  failFrontier(datasetId, fingerprint, { state = 'backoff', httpStatus = null, error = '', nextDueAt }) {
    this.database.prepare(`UPDATE acquisition_frontier SET state=?,failures=failures+1,last_http_status=?,error=?,next_due_at=?
      WHERE dataset_id=? AND fingerprint=?`).run(state, httpStatus, String(error).slice(0, 512), nextDueAt, datasetId, fingerprint);
  }

  retryAcquisitionAuth() {
    const now = new Date().toISOString();
    return Number(this.database.prepare(`UPDATE acquisition_frontier SET state='queued',next_due_at=?,error=''
      WHERE state='auth_blocked'`).run(now).changes);
  }

  acquisitionRequestsToday(utcDay = new Date().toISOString().slice(0, 10)) {
    return Number(this.database.prepare('SELECT requests FROM acquisition_request_budget WHERE utc_day=?').get(utcDay)?.requests ?? 0);
  }

  consumeAcquisitionRequest(limit, utcDay = new Date().toISOString().slice(0, 10)) {
    return transaction(this.database, () => {
      const used = this.acquisitionRequestsToday(utcDay);
      if (used >= limit) return false;
      this.database.prepare(`INSERT INTO acquisition_request_budget(utc_day,requests) VALUES(?,1)
        ON CONFLICT(utc_day) DO UPDATE SET requests=requests+1`).run(utcDay);
      this.database.prepare('DELETE FROM acquisition_request_budget WHERE utc_day<?').run(utcDay);
      return true;
    });
  }

  replaceRemotePosition(datasetId, position, records, responseDigest) {
    const database = this.shard(shardForKey(position.key));
    transaction(database, () => {
      database.prepare(`INSERT INTO positions(fingerprint,polyglot_key,fen) VALUES(?,?,?)
        ON CONFLICT(fingerprint) DO UPDATE SET polyglot_key=excluded.polyglot_key,fen=excluded.fen`)
        .run(position.fingerprint, position.keyBuffer, position.fen);
      database.prepare('DELETE FROM remote_observations WHERE dataset_id=? AND fingerprint=?').run(datasetId, position.fingerprint);
      const insert = database.prepare(`
        INSERT INTO remote_observations(dataset_id,fingerprint,raw_move,uci_move,games,wins,draws,losses,average_rating,observed_at,response_digest)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)
      `);
      const observedAt = new Date().toISOString();
      for (const record of records) {
        insert.run(datasetId, position.fingerprint, record.rawMove, record.uciMove, record.games, record.wins,
          record.draws, record.losses, record.averageRating, observedAt, responseDigest);
      }
    });
  }

  *iterateAcquisitionEvidence() {
    const rows = this.database.prepare(`
      SELECT id,provider,overlap_domain,contribution_mode,query_digest,query_json,created_at,updated_at
      FROM acquisition_datasets ORDER BY provider,query_digest
    `).iterate();
    for (const row of rows) {
      yield { ...row, id: Number(row.id), query: JSON.parse(row.query_json) };
    }
  }

  acquisitionEvidence() {
    return [...this.iterateAcquisitionEvidence()];
  }

  acquisitionDatasetHasObservations(datasetId) {
    for (const index of this.existingShardIndexes()) {
      if (this.shard(index).prepare('SELECT 1 FROM remote_observations WHERE dataset_id=? LIMIT 1').get(datasetId)) return true;
    }
    return false;
  }

  acquisitionStatus() {
    const grouped = this.database.prepare(`SELECT f.state,COUNT(*) AS count FROM acquisition_frontier f
      JOIN acquisition_datasets d ON d.id=f.dataset_id WHERE d.contribution_mode='authoritative'
      GROUP BY f.state ORDER BY f.state`).all()
      .map((row) => ({ state: row.state, count: Number(row.count) }));
    const totals = this.database.prepare(`SELECT COUNT(*) AS frontier_positions,
      SUM(CASE WHEN f.last_queried_at IS NOT NULL THEN 1 ELSE 0 END) AS positions,MAX(f.last_queried_at) AS last_success_at,
      MIN(CASE WHEN f.state IN ('queued','ready','backoff','auth_blocked') THEN f.next_due_at END) AS next_request_at
      FROM acquisition_frontier f JOIN acquisition_datasets d ON d.id=f.dataset_id
      WHERE d.contribution_mode='authoritative'`).get();
    const last = this.database.prepare(`SELECT f.last_http_status,f.error,f.state FROM acquisition_frontier f
      JOIN acquisition_datasets d ON d.id=f.dataset_id
      WHERE d.contribution_mode='authoritative' AND f.attempts>0
      ORDER BY COALESCE(f.last_queried_at,f.next_due_at) DESC LIMIT 1`).get();
    return {
      enabled: Boolean(this.config.acquisition.enabled), provider: this.config.acquisition.provider,
      credentialConfigured: Boolean(this.config.acquisition.tokenFile), requestsToday: this.acquisitionRequestsToday(),
      dailyRequestBudget: this.config.acquisition.dailyRequestBudget, frontier: grouped,
      positions: Number(totals.positions ?? 0), frontierPositions: Number(totals.frontier_positions),
      lastSuccessAt: totals.last_success_at, nextRequestAt: totals.next_request_at,
      authState: grouped.some((entry) => entry.state === 'auth_blocked') ? 'blocked' : 'ready',
      lastHttpStatus: last?.last_http_status ?? null, backoffReason: last?.error ?? '',
    };
  }

  updateDaemonState(patch) {
    const current = this.database.prepare('SELECT * FROM daemon_state WHERE singleton=1').get();
    const value = { ...current, ...patch, singleton: 1, updated_at: new Date().toISOString() };
    if (typeof value.last_report !== 'string') value.last_report = JSON.stringify(value.last_report ?? {});
    if (value.last_report.length > 65_536) value.last_report = JSON.stringify({ truncated: true, bytes: value.last_report.length });
    this.database.prepare(`UPDATE daemon_state SET pid=?,phase=?,started_at=?,heartbeat_at=?,cycle_started_at=?,
      cycle_completed_at=?,resource_mode=?,last_report=?,last_error=?,updated_at=? WHERE singleton=1`)
      .run(value.pid, value.phase, value.started_at, value.heartbeat_at, value.cycle_started_at,
        value.cycle_completed_at, value.resource_mode, value.last_report,
        String(value.last_error ?? '').slice(0, 2048), value.updated_at);
  }

  daemonState() {
    const row = this.database.prepare('SELECT * FROM daemon_state WHERE singleton=1').get();
    const heartbeatMs = Date.parse(row.heartbeat_at ?? '');
    const stale = !Number.isFinite(heartbeatMs) || Date.now() - heartbeatMs > 300_000;
    let processAlive = false;
    if (Number.isSafeInteger(row.pid) && row.pid > 0) {
      try {
        process.kill(Number(row.pid), 0);
        processAlive = true;
      } catch (error) {
        processAlive = error.code === 'EPERM';
      }
    }
    let lastReport = {};
    try { lastReport = JSON.parse(row.last_report || '{}'); } catch { lastReport = { invalid: true }; }
    return { pid: row.pid === null ? null : Number(row.pid), phase: row.phase, startedAt: row.started_at,
      heartbeatAt: row.heartbeat_at, cycleStartedAt: row.cycle_started_at, cycleCompletedAt: row.cycle_completed_at,
      resourceMode: row.resource_mode, lastReport, lastError: row.last_error, stale, processAlive,
      active: !stale && processAlive && !['stopped', 'failed'].includes(row.phase) };
  }

  putEvaluation(record) {
    const database = this.shard(shardForKey(record.key));
    database.prepare(`
      INSERT INTO evaluations(fingerprint,raw_move,engine_fingerprint,node_tier,score_cp,relative_loss_cp,wdl,mate,depth,pv,lifecycle,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(fingerprint,raw_move,engine_fingerprint,node_tier) DO UPDATE SET
        score_cp=excluded.score_cp,relative_loss_cp=excluded.relative_loss_cp,wdl=excluded.wdl,mate=excluded.mate,depth=excluded.depth,
        pv=excluded.pv,lifecycle=excluded.lifecycle,created_at=excluded.created_at
    `).run(record.fingerprint, record.rawMove, record.engineFingerprint, record.nodeTier,
      record.scoreCp ?? null, record.relativeLossCp ?? null, record.wdl ?? null, record.mate ?? null, record.depth ?? 0,
      record.pv ?? '', record.lifecycle ?? 'active', new Date().toISOString());
  }

  evaluation(record, engineFingerprint, nodeTier) {
    const database = this.shard(shardForKey(record.key));
    return database.prepare(`
      SELECT * FROM evaluations WHERE fingerprint=? AND raw_move=? AND engine_fingerprint=? AND node_tier=?
    `).get(record.fingerprint, record.rawMove, engineFingerprint, nodeTier);
  }

  latestEvaluation(record, minimumNodeTier = 0, engineFingerprint = null) {
    const database = this.shard(shardForKey(record.key));
    if (engineFingerprint) {
      return database.prepare(`
        SELECT * FROM evaluations WHERE fingerprint=? AND raw_move=? AND node_tier>=? AND engine_fingerprint=?
        ORDER BY node_tier DESC, created_at DESC LIMIT 1
      `).get(record.fingerprint, record.rawMove, minimumNodeTier, engineFingerprint);
    }
    return database.prepare(`SELECT * FROM evaluations WHERE fingerprint=? AND raw_move=? AND node_tier>=?
      ORDER BY node_tier DESC, created_at DESC LIMIT 1`).get(record.fingerprint, record.rawMove, minimumNodeTier);
  }

  addSnapshot(snapshot) {
    this.database.prepare(`
      INSERT OR IGNORE INTO snapshots(id,channel,directory,record_count,includes_fixture,qualified,manifest_sha256,created_at)
      VALUES(?,?,?,?,?,?,?,?)
    `).run(snapshot.id, snapshot.channel, snapshot.directory, snapshot.recordCount,
      snapshot.includesFixture ? 1 : 0, snapshot.qualified ? 1 : 0, snapshot.manifestSha256, new Date().toISOString());
  }

  setChannel(channel, snapshotId, directory) {
    this.database.prepare(`
      INSERT INTO channels(channel,snapshot_id,directory,published_at) VALUES(?,?,?,?)
      ON CONFLICT(channel) DO UPDATE SET snapshot_id=excluded.snapshot_id,directory=excluded.directory,published_at=excluded.published_at
    `).run(channel, snapshotId, directory, new Date().toISOString());
  }

  channel(channel) { return this.database.prepare('SELECT * FROM channels WHERE channel=?').get(channel); }

  snapshot(id) { return this.database.prepare('SELECT * FROM snapshots WHERE id=?').get(id); }

  snapshotRows() { return this.database.prepare('SELECT * FROM snapshots ORDER BY channel,created_at DESC,id DESC').all(); }

  currentSnapshotRows() {
    return this.database.prepare(`
      SELECT s.* FROM channels c
      JOIN snapshots s ON s.id=c.snapshot_id
      ORDER BY s.channel,s.id
    `).all();
  }

  deleteSnapshot(id) {
    if (this.database.prepare('SELECT 1 FROM channels WHERE snapshot_id=?').get(id)) throw new Error(`Cannot delete current snapshot ${id}`);
    this.database.prepare('DELETE FROM snapshots WHERE id=?').run(id);
  }

  compactOldObservations(cutoffMonth) {
    if (!/^\d{4}-\d{2}$/.test(cutoffMonth)) throw new Error(`Invalid cohort cutoff ${cutoffMonth}`);
    const allowedSources = new Set(this.completedSources({ includeInactive: true }).map((source) => Number(source.id)));
    let sourceRows = 0;
    let observationsCompacted = 0;
    let retiredPvsCleared = 0;
    for (const index of this.existingShardIndexes()) {
      const database = this.shard(index);
      const rows = database.prepare(`
        SELECT source_id,fingerprint,raw_move,MIN(uci_move) AS uci_move,
               SUM(games) AS games,SUM(wins) AS wins,SUM(draws) AS draws,SUM(losses) AS losses,COUNT(*) AS source_rows
        FROM observations
        WHERE month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND month < ?
        GROUP BY source_id,fingerprint,raw_move
      `).all(cutoffMonth).filter((row) => allowedSources.has(Number(row.source_id)));
      transaction(database, () => {
        const remove = database.prepare(`DELETE FROM observations WHERE source_id=? AND month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND month < ?`);
        const archive = database.prepare(`
          INSERT INTO observations(source_id,chunk_index,month,speed,rating_bucket,fingerprint,raw_move,uci_move,games,wins,draws,losses)
          VALUES(?,-1,'archive','mixed',0,?,?,?,?,?,?,?)
          ON CONFLICT(source_id,chunk_index,month,speed,rating_bucket,fingerprint,raw_move) DO UPDATE SET
            games=observations.games+excluded.games,wins=observations.wins+excluded.wins,
            draws=observations.draws+excluded.draws,losses=observations.losses+excluded.losses
        `);
        for (const sourceId of new Set(rows.map((row) => Number(row.source_id)))) remove.run(sourceId, cutoffMonth);
        for (const row of rows) {
          archive.run(row.source_id, row.fingerprint, row.raw_move, row.uci_move, row.games, row.wins, row.draws, row.losses);
          sourceRows += Number(row.source_rows);
          observationsCompacted += Number(row.games);
        }
        const result = database.prepare("UPDATE evaluations SET pv='' WHERE lifecycle IN ('retired','quarantined') AND pv<>''").run();
        retiredPvsCleared += Number(result.changes);
      });
      database.exec('PRAGMA optimize');
    }
    return { cutoffMonth, sourceRows, observationsCompacted, retiredPvsCleared };
  }

  recordQualificationGate(contentId, gate, passed, evidence) {
    if (!/^[0-9a-f]{20}$/.test(contentId)) throw new Error('Qualification content id must be 20 lowercase hexadecimal characters');
    this.database.prepare(`
      INSERT INTO qualification_gates(snapshot_id,gate,passed,evidence,recorded_at) VALUES(?,?,?,?,?)
      ON CONFLICT(snapshot_id,gate) DO UPDATE SET passed=excluded.passed,evidence=excluded.evidence,recorded_at=excluded.recorded_at
    `).run(contentId, gate, passed ? 1 : 0, JSON.stringify(evidence), new Date().toISOString());
  }

  qualificationGates(contentId) {
    return this.database.prepare('SELECT * FROM qualification_gates WHERE snapshot_id=? ORDER BY gate').all(contentId)
      .map((row) => ({ ...row, passed: Boolean(row.passed), evidence: JSON.parse(row.evidence) }));
  }

  setPaused(paused, reason = '') {
    this.database.prepare('UPDATE control SET paused=?,reason=?,updated_at=? WHERE singleton=1')
      .run(paused ? 1 : 0, reason, new Date().toISOString());
  }

  control() {
    const row = this.database.prepare('SELECT * FROM control WHERE singleton=1').get();
    return { ...row, singleton: Boolean(row.singleton), paused: Boolean(row.paused) };
  }

  status() {
    const sources = this.database.prepare('SELECT status,lifecycle,COUNT(*) AS count,SUM(games_accepted) AS games FROM sources GROUP BY status,lifecycle').all();
    const channels = this.database.prepare('SELECT * FROM channels ORDER BY channel').all();
    const snapshots = this.database.prepare('SELECT COUNT(*) AS count FROM snapshots').get();
    const qualificationGates = this.database.prepare('SELECT COUNT(*) AS count FROM qualification_gates WHERE passed=1').get();
    return { schema: 'uci_arena_book_forge_catalog_status_v1', workspace: this.config.workspace, control: this.control(), sources, channels,
      snapshots: Number(snapshots.count), passingQualificationGates: Number(qualificationGates.count),
      daemon: this.daemonState(), acquisition: this.acquisitionStatus(),
      audit: { enabled: false, status: 'disabled' } };
  }
}
