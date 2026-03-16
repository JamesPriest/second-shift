'use strict';
const fs   = require('fs');
const path = require('path');

const HISTORY_DIR  = path.join(__dirname, '..', 'history');
const PERSIST_EVERY = 12;   // persist to disk every N live snapshots (~1 min)

// Per-game store: gameId → { minute: Snapshot[], hour: Snapshot[], live: Snapshot[], liveCount: number }
// minute / hour come from the one-time backfill.
// live   comes from ongoing 5-second delta snapshots.
const store = new Map();
let currentGameId = null;

function ensureDir() {
    if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

function filePath(gameId, kind) {
    return path.join(HISTORY_DIR, `${gameId}-${kind}.json`);
}

function persist(gameId, kind) {
    ensureDir();
    const game = store.get(gameId);
    if (!game) return;
    try {
        fs.writeFileSync(filePath(gameId, kind), JSON.stringify(game[kind]), 'utf8');
    } catch (err) {
        console.error(`[history] persist ${gameId}/${kind}: ${err.message}`);
    }
}

// Load all saved history files on server startup.
function loadAll() {
    ensureDir();
    const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
        try {
            const [gameId, kind] = path.basename(file, '.json').split('-');
            const data = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, file), 'utf8'));
            if (!store.has(gameId)) store.set(gameId, { minute: [], hour: [], live: [], liveCount: 0 });
            store.get(gameId)[kind] = data;
            console.log(`[history] loaded ${data.length} ${kind} points for game ${gameId}`);
        } catch (err) {
            console.warn(`[history] could not load ${file}: ${err.message}`);
        }
    }
}

// Convert raw backfill buckets from the mod into uniform Snapshot objects.
// Buckets are ordered most-recent-first (index 0 = most recent).
// count=true values from get_flow_count represent total units in that bucket.
// Per-minute rates: one_minute bucket → value is already /min; one_hour → divide by 60.
function processBackfill(gameId, raw) {
    const receivedAt = Date.now();

    if (!store.has(gameId)) store.set(gameId, { minute: [], hour: [], live: [], liveCount: 0 });
    const game = store.get(gameId);

    for (const [precKey, precData] of Object.entries(raw.precisions || {})) {
        const kind       = precKey === 'one_hour' ? 'hour' : 'minute';
        const bucketMs   = (precData.bucket_ticks / 60) * 1000;  // ticks → ms (60 ticks/s)
        const toPerMin   = precKey === 'one_hour' ? 1 / 60 : 1;  // one_hour counts → /min
        const categories = ['items', 'fluids'];

        // Find max bucket count
        let maxBuckets = 0;
        for (const cat of categories) {
            for (const counts of Object.values(precData[cat] || {})) {
                maxBuckets = Math.max(maxBuckets, counts.input.length, counts.output.length);
            }
        }

        const snapshots = [];
        for (let i = 0; i < maxBuckets; i++) {
            const timestamp = new Date(receivedAt - i * bucketMs).toISOString();
            const snap = { timestamp, tick: null, source: 'backfill', precision: kind, items: {}, fluids: {} };

            for (const cat of categories) {
                for (const [name, counts] of Object.entries(precData[cat] || {})) {
                    const produced = Math.round((counts.output[i] || 0) * toPerMin);
                    const consumed = Math.round((counts.input[i]  || 0) * toPerMin);
                    if (produced > 0 || consumed > 0) {
                        snap[cat][name] = { name, producedPerMin: produced, consumedPerMin: consumed };
                    }
                }
            }
            snapshots.push(snap);
        }

        // Oldest-first, so charts render left-to-right in chronological order.
        snapshots.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        game[kind] = snapshots;
        persist(gameId, kind);
        console.log(`[history] backfilled ${snapshots.length} ${kind} points for game ${gameId}`);
    }
}

// Append a live delta snapshot (ProcessedStats from statsProcessor).
function addLiveSnapshot(gameId, snapshot) {
    currentGameId = gameId;
    if (!store.has(gameId)) store.set(gameId, { minute: [], hour: [], live: [], liveCount: 0 });
    const game = store.get(gameId);
    game.live.push(snapshot);
    game.liveCount++;
    if (game.liveCount % PERSIST_EVERY === 0) persist(gameId, 'live');
}

// Return history for a game.
// precision: 'minute' | 'hour' | 'live' (default: 'live')
function getHistory(gameId, precision = 'live') {
    const game = store.get(gameId || currentGameId);
    if (!game) return [];
    return game[precision] || [];
}

function getCurrentGameId() { return currentGameId; }

// Returns a summary of all known games, sorted most-recently-active first.
function listGames() {
    const result = [];
    for (const [gameId, data] of store.entries()) {
        const liveSnaps   = data.live   || [];
        const minuteSnaps = data.minute || [];
        const lastLive    = liveSnaps[liveSnaps.length - 1]?.timestamp;
        const lastMinute  = minuteSnaps[minuteSnaps.length - 1]?.timestamp;
        const lastSeen    = lastLive || lastMinute || null;
        result.push({
            gameId,
            lastSeen,
            counts: { live: liveSnaps.length, minute: (data.minute || []).length, hour: (data.hour || []).length },
        });
    }
    result.sort((a, b) => {
        if (!a.lastSeen) return 1;
        if (!b.lastSeen) return -1;
        return new Date(b.lastSeen) - new Date(a.lastSeen);
    });
    return result;
}

module.exports = { loadAll, processBackfill, addLiveSnapshot, getHistory, getCurrentGameId, listGames };
