'use strict';
const fs       = require('fs');
const path     = require('path');
const chokidar = require('chokidar');
const { processStats }                                     = require('./statsProcessor');
const { processBackfill, addLiveSnapshot, listGames }      = require('./db');
const config   = require('./config');

const backfillFile = path.join(config.scriptOutputDir, 'second-shift-backfill.json');

// Latest processed snapshot — sent immediately to new WebSocket clients.
let latestStats = null;

// WebSocket clients — populated by index.js via the exported Set.
const clients = new Set();

// Stale detection: if no file update arrives within this window, broadcast waiting.
const STALE_MS = 15_000;
let staleTimer  = null;
let gameIsLive  = false;

function broadcast(data) {
    const message = JSON.stringify(data);
    for (const ws of clients) {
        if (ws.readyState === 1 /* OPEN */) ws.send(message);
    }
}

function resetStaleTimer() {
    if (!gameIsLive) {
        gameIsLive = true;
        broadcast({ type: 'game_status', status: 'live' });
    }
    clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
        gameIsLive = false;
        broadcast({ type: 'game_status', status: 'waiting' });
        console.log('[watcher] no update in 15s — game may be paused or closed');
    }, STALE_MS);
}

function handleStats(filePath) {
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        console.warn(`[watcher] could not parse ${filePath}: ${err.message}`);
        return;
    }

    const processed = processStats(raw);
    latestStats = processed;

    // Store in per-game history; detect save reloads
    if (raw.game_id) {
        const { reloadDetected } = addLiveSnapshot(raw.game_id, processed);
        if (reloadDetected) broadcast({ type: 'reload_detected', payload: { tick: raw.tick } });
    }

    resetStaleTimer();
    broadcast({ type: 'stats_update', payload: processed });
    const surfaces = Object.keys(raw.surfaces || {}).length;
    console.log(`[watcher] tick=${raw.tick}  game=${raw.game_id || '?'}  surfaces=${surfaces}`);
}

function handleBackfill(filePath) {
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        console.warn(`[watcher] could not parse backfill ${filePath}: ${err.message}`);
        return;
    }

    if (!raw.game_id) {
        console.warn('[watcher] backfill missing game_id, skipping');
        return;
    }

    processBackfill(raw.game_id, raw);
    broadcast({ type: 'backfill_ready', payload: { game_id: raw.game_id } });
    broadcast({ type: 'games_list', payload: listGames() });
    console.log(`[watcher] backfill processed for game=${raw.game_id}`);
}

function startWatcher() {
    const watcher = chokidar.watch(
        [config.watchedFile, backfillFile],
        {
            persistent:       true,
            usePolling:       false,
            awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
            ignoreInitial:    false,
        }
    );

    watcher.on('add',    (p) => p.endsWith('backfill.json') ? handleBackfill(p) : handleStats(p));
    watcher.on('change', (p) => p.endsWith('backfill.json') ? handleBackfill(p) : handleStats(p));
    watcher.on('error',  (err) => console.error('[watcher] error:', err));

    console.log(`[watcher] watching: ${config.watchedFile}`);
    console.log(`[watcher] watching: ${backfillFile}`);
}

module.exports = {
    startWatcher,
    clients,
    getLatest:    () => latestStats,
    getGameIsLive: () => gameIsLive,
};
