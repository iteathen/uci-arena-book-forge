import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { shardForKey } from './chess.mjs';

const CATALOG_SCHEMA = 3;
const SHARD_SCHEMA = 2;

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
      INSERT OR IGNORE INTO control(singleton, paused, reason, updated_at)
        VALUES(1, 0, '', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    `);
    const storedVersion = this.database.prepare('SELECT value FROM metadata WHERE key=?').get('schema_version');
    let catalogVersion = Number(storedVersion?.value ?? 0);
    if (catalogVersion === 1) {
      this.database.exec("ALTER TABLE sources ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','quarantined','retired','restored'))");
      catalogVersion = 2;
    }
    if (catalogVersion === 2) catalogVersion = 3;
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
    `);
    const storedVersion = database.prepare('SELECT value FROM metadata WHERE key=?').get('schema_version');
    if (storedVersion && Number(storedVersion.value) === 1) {
      database.exec('ALTER TABLE evaluations ADD COLUMN relative_loss_cp INTEGER');
      database.prepare('UPDATE metadata SET value=? WHERE key=?').run(String(SHARD_SCHEMA), 'schema_version');
    } else if (!storedVersion) {
      database.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('schema_version', String(SHARD_SCHEMA));
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

  registerSource({ sha256, sourcePath, sourceType, fixture = false }) {
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT OR IGNORE INTO sources(sha256,source_path,source_type,fixture,status,created_at,updated_at)
      VALUES(?,?,?,?, 'pending',?,?)
    `).run(sha256, sourcePath, sourceType, fixture ? 1 : 0, now, now);
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
  completedSources({ includeInactive = false } = {}) {
    return this.database.prepare(includeInactive
      ? "SELECT * FROM sources WHERE status='complete' ORDER BY id"
      : "SELECT * FROM sources WHERE status='complete' AND lifecycle IN ('active','restored') ORDER BY id").all();
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

  aggregateObservations({ includeFixtures }) {
    const aggregate = [];
    for (const index of this.existingShardIndexes()) {
      const rows = this.shard(index).prepare(`
        SELECT o.raw_move,MIN(o.uci_move) AS uci_move,SUM(o.games) AS games,SUM(o.wins) AS wins,
               SUM(o.draws) AS draws,SUM(o.losses) AS losses,p.fingerprint,p.polyglot_key,p.fen
        FROM observations o
        JOIN positions p ON p.fingerprint=o.fingerprint
        JOIN forge_catalog.sources s ON s.id=o.source_id
        WHERE s.status='complete' AND s.lifecycle IN ('active','restored') AND (? OR s.fixture=0)
        GROUP BY o.fingerprint,o.raw_move
      `).all(includeFixtures ? 1 : 0);
      for (const row of rows) {
        const keyBytes = Buffer.from(row.polyglot_key);
        aggregate.push({
          fingerprint: Buffer.from(row.fingerprint), keyBuffer: keyBytes,
          key: keyBytes.readBigUInt64BE(), fen: row.fen, rawMove: Number(row.raw_move), uciMove: row.uci_move,
          games: Number(row.games), wins: Number(row.wins), draws: Number(row.draws), losses: Number(row.losses),
        });
      }
    }
    return aggregate;
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

  snapshotRows() { return this.database.prepare('SELECT * FROM snapshots ORDER BY channel,created_at DESC,id DESC').all(); }

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

  control() { return this.database.prepare('SELECT * FROM control WHERE singleton=1').get(); }

  status() {
    const sources = this.database.prepare('SELECT status,lifecycle,COUNT(*) AS count,SUM(games_accepted) AS games FROM sources GROUP BY status,lifecycle').all();
    const channels = this.database.prepare('SELECT * FROM channels ORDER BY channel').all();
    const snapshots = this.database.prepare('SELECT COUNT(*) AS count FROM snapshots').get();
    const qualificationGates = this.database.prepare('SELECT COUNT(*) AS count FROM qualification_gates WHERE passed=1').get();
    return { schema: 'flashfork_book_forge_status_v1', workspace: this.config.workspace, control: this.control(), sources, channels,
      snapshots: Number(snapshots.count), passingQualificationGates: Number(qualificationGates.count) };
  }
}
