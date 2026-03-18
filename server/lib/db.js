'use strict';
const path     = require('path');
const zlib     = require('zlib');
const Database = require('better-sqlite3');

// Compress a snapshot object to a gzipped Buffer for storage.
function compressSnapshot(obj) {
    return zlib.gzipSync(JSON.stringify(obj));
}

// Decompress a stored snapshot. Handles both:
//   Buffer  — gzip-compressed (new format)
//   string  — raw JSON (legacy rows written before compression was added)
function decompressSnapshot(stored) {
    if (Buffer.isBuffer(stored)) {
        return JSON.parse(zlib.gunzipSync(stored).toString('utf8'));
    }
    return JSON.parse(stored);
}

const DB_PATH = path.join(__dirname, '..', 'second-shift.db');

let db    = null;
let stmts = {};
let currentGameId = null;

function init() {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    db.exec(`
        CREATE TABLE IF NOT EXISTS games (
            game_id    TEXT PRIMARY KEY,
            first_seen TEXT NOT NULL,
            last_seen  TEXT NOT NULL,
            last_tick  INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS history (
            game_id          TEXT    NOT NULL,
            precision        TEXT    NOT NULL,
            bucket_game_tick INTEGER NOT NULL,
            category         TEXT    NOT NULL,
            name             TEXT    NOT NULL,
            bucket_timestamp TEXT    NOT NULL,
            produced_per_min REAL    NOT NULL DEFAULT 0,
            consumed_per_min REAL    NOT NULL DEFAULT 0,
            PRIMARY KEY (game_id, precision, bucket_game_tick, category, name)
        );

        CREATE TABLE IF NOT EXISTS live_snapshots (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id       TEXT    NOT NULL,
            timestamp     TEXT    NOT NULL,
            tick          INTEGER NOT NULL DEFAULT 0,
            snapshot_json TEXT    NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_live_game_ts ON live_snapshots(game_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_hist_query   ON history(game_id, precision, bucket_game_tick);
    `);

    // Migration: add last_tick to existing databases that predate this column.
    try { db.exec(`ALTER TABLE games ADD COLUMN last_tick INTEGER NOT NULL DEFAULT 0`); }
    catch { /* column already exists */ }

    // Also ensure live_snapshots has a tick index for reload-trim queries.
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_live_tick ON live_snapshots(game_id, tick)`); }
    catch { /* already exists */ }

    stmts.upsertGame = db.prepare(`
        INSERT INTO games (game_id, first_seen, last_seen, last_tick) VALUES (?, ?, ?, 0)
        ON CONFLICT(game_id) DO UPDATE SET last_seen = excluded.last_seen
    `);

    stmts.upsertGameWithTick = db.prepare(`
        INSERT INTO games (game_id, first_seen, last_seen, last_tick) VALUES (?, ?, ?, ?)
        ON CONFLICT(game_id) DO UPDATE SET last_seen = excluded.last_seen, last_tick = excluded.last_tick
    `);

    stmts.getLastTick = db.prepare(`SELECT last_tick FROM games WHERE game_id = ?`);

    stmts.trimLiveAfterTick    = db.prepare(`DELETE FROM live_snapshots WHERE game_id = ? AND tick > ?`);
    stmts.trimHistoryAfterTick = db.prepare(`DELETE FROM history        WHERE game_id = ? AND bucket_game_tick > ?`);

    stmts.upsertHistory = db.prepare(`
        INSERT OR REPLACE INTO history
            (game_id, precision, bucket_game_tick, category, name, bucket_timestamp, produced_per_min, consumed_per_min)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmts.insertLive = db.prepare(`
        INSERT INTO live_snapshots (game_id, timestamp, tick, snapshot_json)
        VALUES (?, ?, ?, ?)
    `);

    stmts.pruneLive = db.prepare(`
        DELETE FROM live_snapshots
        WHERE game_id = ? AND timestamp < datetime('now', '-2 hours')
    `);

    stmts.getLive = db.prepare(`
        SELECT snapshot_json FROM live_snapshots
        WHERE game_id = ?
        ORDER BY timestamp ASC
    `);

    stmts.getHistoryRows = db.prepare(`
        SELECT bucket_game_tick, bucket_timestamp, category, name, produced_per_min, consumed_per_min
        FROM history
        WHERE game_id = ? AND precision = ?
        ORDER BY bucket_game_tick ASC
    `);

    stmts.listGames = db.prepare(`
        SELECT
            g.game_id, g.first_seen, g.last_seen,
            (SELECT COUNT(*) FROM live_snapshots l WHERE l.game_id = g.game_id) AS live_count,
            (SELECT COUNT(DISTINCT bucket_game_tick) FROM history h WHERE h.game_id = g.game_id AND h.precision = 'minute') AS minute_count,
            (SELECT COUNT(DISTINCT bucket_game_tick) FROM history h WHERE h.game_id = g.game_id AND h.precision = 'hour')   AS hour_count
        FROM games g
        ORDER BY g.last_seen DESC
    `);

    // Restore most-recently-active game
    const latest = db.prepare('SELECT game_id FROM games ORDER BY last_seen DESC LIMIT 1').get();
    if (latest) {
        currentGameId = latest.game_id;
        console.log(`[db] restored currentGameId=${currentGameId}`);
    }

    console.log(`[db] opened ${DB_PATH}`);
}

// ── Games ─────────────────────────────────────────────────────────────────────

function upsertGame(gameId) {
    const now = new Date().toISOString();
    stmts.upsertGame.run(gameId, now, now);
}

function listGames() {
    if (!db) return [];
    return stmts.listGames.all().map(row => ({
        gameId:   row.game_id,
        lastSeen: row.last_seen,
        counts: { live: row.live_count, minute: row.minute_count, hour: row.hour_count },
    }));
}

function getCurrentGameId() { return currentGameId; }

// ── Live snapshots ────────────────────────────────────────────────────────────

// Returns { reloadDetected: bool } so callers can broadcast a refresh event.
function addLiveSnapshot(gameId, snapshot) {
    currentGameId  = gameId;
    const tick     = snapshot.tick || 0;
    const row      = stmts.getLastTick.get(gameId);
    const lastTick = row?.last_tick ?? 0;

    let reloadDetected = false;

    // A non-trivial backward tick jump means the player loaded an older save.
    // Trim all data that belongs to the abandoned future timeline.
    if (tick > 0 && lastTick > 0 && tick < lastTick) {
        const r1 = stmts.trimLiveAfterTick.run(gameId, tick);
        const r2 = stmts.trimHistoryAfterTick.run(gameId, tick);
        console.log(
            `[db] save reload detected game=${gameId}: tick ${lastTick}→${tick}` +
            ` — trimmed ${r1.changes} live + ${r2.changes} history rows`
        );
        reloadDetected = true;
    }

    const now = new Date().toISOString();
    stmts.upsertGameWithTick.run(gameId, now, now, tick);
    stmts.insertLive.run(gameId, snapshot.timestamp, tick, compressSnapshot(snapshot));
    stmts.pruneLive.run(gameId);

    return { reloadDetected };
}

// ── Backfill ──────────────────────────────────────────────────────────────────

// Normalises bucket arrays from the mod's backfill JSON.
// helpers.table_to_json serialises a proper Lua sequence as a JSON array [v,v,…].
// If the Lua table has gaps or non-consecutive keys it emits a JSON object
// {"1":v,"3":v,…} instead.  This handles both forms transparently.
function normalizeBuckets(x) {
    if (Array.isArray(x)) return x;
    if (!x || typeof x !== 'object') return [];
    // Object with numeric string keys — rebuild as a 0-based JS array.
    // Lua arrays are 1-indexed; subtract the minimum key so the result is 0-based.
    const keys = Object.keys(x).map(Number).filter(k => !isNaN(k)).sort((a, b) => a - b);
    if (keys.length === 0) return [];
    const base   = keys[0];
    const maxIdx = keys[keys.length - 1];
    const result = new Array(maxIdx - base + 1).fill(0);
    for (const k of keys) result[k - base] = x[k] ?? 0;
    return result;
}

// Converts raw mod backfill JSON → columnar rows in history table.
// Buckets are most-recent-first (index 0 = current/most recent bucket).
// bucket_game_tick is used as the stable primary-key component so re-backfills
// are idempotent (INSERT OR REPLACE) regardless of when they run.
function processBackfill(gameId, raw) {
    const receivedAt = Date.now();
    const tick       = raw.tick || 0;

    currentGameId = gameId;
    upsertGame(gameId);

    const insertBatch = db.transaction((rows) => {
        for (const row of rows) stmts.upsertHistory.run(...row);
    });

    for (const [precKey, precData] of Object.entries(raw.precisions || {})) {
        const precision   = precKey === 'one_hour' ? 'hour' : 'minute';
        const bucketTicks = precData.bucket_ticks;
        // one_minute buckets hold 1-minute totals → already per-min
        // one_hour   buckets hold 1-hour totals   → divide by 60 for per-min
        const toPerMin    = precKey === 'one_hour' ? (1 / 60) : 1;
        const rows        = [];

        const itemKeys  = Object.keys(precData.items       || {}).length;
        const fluidKeys = Object.keys(precData.fluids      || {}).length;
        const elecKeys  = Object.keys(precData.electricity || {}).length;
        console.log(`[db] backfill ${precKey}: raw items=${itemKeys} fluids=${fluidKeys} electricity=${elecKeys}`);
        if (itemKeys > 0) {
            const sampleName = Object.keys(precData.items)[0];
            const sample = precData.items[sampleName];
            console.log(`[db]   sample "${sampleName}": input=${JSON.stringify(sample.input).slice(0, 60)}`);
        }

        // Electricity buckets are in joules; convert to average MW over the bucket window.
        // one_minute (3600 ticks = 60 s): joules / 60 / 1e6
        // one_hour  (216000 ticks = 3600 s): joules / 3600 / 1e6
        const electricityScale = precKey === 'one_hour' ? 1 / 3_600_000_000 : 1 / 60_000_000;

        for (const category of ['items', 'fluids', 'electricity']) {
            const scale = category === 'electricity' ? electricityScale : toPerMin;
            for (const [name, counts] of Object.entries(precData[category] || {})) {
                const inputArr  = normalizeBuckets(counts.input);
                const outputArr = normalizeBuckets(counts.output);
                const n = Math.max(inputArr.length, outputArr.length);
                for (let i = 0; i < n; i++) {
                    const produced = (outputArr[i] || 0) * scale;
                    const consumed = (inputArr[i]  || 0) * scale;
                    if (produced < 0.0001 && consumed < 0.0001) continue;

                    // Stable integer key: game-tick at the start of this bucket.
                    // Identical across multiple backfills → enables idempotent upserts.
                    const bucketGameTick = (Math.floor(tick / bucketTicks) - i) * bucketTicks;

                    // Approximate wall-clock timestamp (used for chart x-axis display).
                    const bucketTimestamp = new Date(
                        receivedAt - (tick - bucketGameTick) / 60 * 1000
                    ).toISOString();

                    rows.push([gameId, precision, bucketGameTick, category, name, bucketTimestamp, produced, consumed]);
                }
            }
        }

        insertBatch(rows);
        const bucketCount = rows.length > 0 ? new Set(rows.map(r => r[2])).size : 0;
        console.log(`[db] backfill ${precision}: ${bucketCount} buckets, ${rows.length} rows for game=${gameId}`);
    }
}

// ── History queries ───────────────────────────────────────────────────────────

function getLiveHistory(gameId) {
    if (!gameId) gameId = currentGameId;
    if (!gameId) return [];
    return stmts.getLive.all(gameId).map(row => decompressSnapshot(row.snapshot_json));
}

// Reconstruct snapshot-shaped objects from columnar history rows.
// Shape: { timestamp, tick, source:'backfill', precision, items:{…}, fluids:{…} }
// This matches the live snapshot shape so the dashboard can consume both uniformly.
function getBackfillHistory(gameId, precision) {
    if (!gameId) gameId = currentGameId;
    if (!gameId) return [];

    const rows    = stmts.getHistoryRows.all(gameId, precision);
    const buckets = new Map();  // bucket_game_tick → snapshot object

    for (const row of rows) {
        if (!buckets.has(row.bucket_game_tick)) {
            buckets.set(row.bucket_game_tick, {
                timestamp:   row.bucket_timestamp,
                tick:        row.bucket_game_tick,
                source:      'backfill',
                precision,
                items:       {},
                fluids:      {},
                electricity: {},
            });
        }
        const snap = buckets.get(row.bucket_game_tick);
        snap[row.category][row.name] = {
            name:           row.name,
            producedPerMin: row.produced_per_min,
            consumedPerMin: row.consumed_per_min,
        };
    }

    // Sort oldest-first so charts render left-to-right in chronological order.
    return Array.from(buckets.entries())
        .sort(([a], [b]) => a - b)
        .map(([, snap]) => snap);
}

function getHistory(gameId, precision) {
    if (!gameId) gameId = currentGameId;
    if (precision === 'live') return getLiveHistory(gameId);
    return getBackfillHistory(gameId, precision);
}

// ── Game management ───────────────────────────────────────────────────────────

function forgetGame(gameId) {
    db.transaction(() => {
        db.prepare('DELETE FROM live_snapshots WHERE game_id = ?').run(gameId);
        db.prepare('DELETE FROM history        WHERE game_id = ?').run(gameId);
        db.prepare('DELETE FROM games          WHERE game_id = ?').run(gameId);
    })();
    if (currentGameId === gameId) {
        const latest = db.prepare('SELECT game_id FROM games ORDER BY last_seen DESC LIMIT 1').get();
        currentGameId = latest?.game_id || null;
    }
    console.log(`[db] forgot game=${gameId}`);
}

module.exports = { init, addLiveSnapshot, processBackfill, getHistory, getCurrentGameId, listGames, forgetGame };
