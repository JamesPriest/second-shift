'use strict';
const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const cors    = require('cors');
const config  = require('./lib/config');
const { startWatcher, clients, getLatest, getGameIsLive } = require('./lib/watcher');
const { init: dbInit, getHistory, getCurrentGameId, listGames, forgetGame } = require('./lib/db');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Latest delta snapshot
app.get('/api/stats', (req, res) => {
    const latest = getLatest();
    if (!latest) return res.status(503).json({ error: 'No data yet. Is Factorio running with the second-shift mod?' });
    res.json(latest);
});

// Item icons — proxied from the Factorio data directory (requires FACTORIO_DATA_PATH in .env).
// Searches base game and Space Age DLC icon directories in order.
const ICON_MODS = ['base', 'space-age', 'elevated-rails', 'quality'];
app.get('/icons/:name', (req, res) => {
    if (!config.factorioDataPath) return res.status(404).end();
    // Validate: Factorio item IDs only use letters, digits, hyphens, underscores.
    const name = req.params.name.replace(/\.png$/i, '');
    if (!/^[\w-]+$/.test(name)) return res.status(400).end();
    for (const mod of ICON_MODS) {
        const p = path.join(config.factorioDataPath, mod, 'graphics', 'icons', `${name}.png`);
        if (fs.existsSync(p)) {
            res.set('Cache-Control', 'public, max-age=86400');
            return res.sendFile(p);
        }
    }
    res.status(404).end();
});

// All known games (for the save selector)
app.get('/api/games', (req, res) => res.json(listGames()));

// Trigger an immediate backfill — writes a marker file to script-output so future
// mod versions can detect it; also returns the Factorio console command as a fallback.
app.post('/api/trigger-backfill', (req, res) => {
    try {
        fs.writeFileSync(
            path.join(config.scriptOutputDir, 'second-shift-trigger.json'),
            JSON.stringify({ type: 'backfill', requestedAt: new Date().toISOString() })
        );
    } catch (err) {
        console.warn('[server] could not write backfill trigger file:', err.message);
    }
    res.json({ command: '/c storage.last_backfill_tick = nil' });
});

// Forget a game — remove it and all its data from the DB
app.delete('/api/games/:gameId', (req, res) => {
    try {
        forgetGame(req.params.gameId);
        const msg = JSON.stringify({ type: 'games_list', payload: listGames() });
        for (const ws of clients) { if (ws.readyState === 1) ws.send(msg); }
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Historical data for the timeline chart.
// ?precision=live|minute|hour   (default: live)
// ?gameId=...                   (default: most recently seen game)
app.get('/api/history', (req, res) => {
    const precision = req.query.precision || 'live';
    const gameId    = req.query.gameId    || getCurrentGameId();
    if (!gameId) return res.status(503).json({ error: 'No game data yet.' });
    res.json(getHistory(gameId, precision));
});

// Export history as CSV download
app.get('/api/export', (req, res) => {
    const precision = req.query.precision || 'live';
    const gameId    = req.query.gameId    || getCurrentGameId();
    if (!gameId) return res.status(503).json({ error: 'No game data yet.' });

    const rows = getHistory(gameId, precision);

    const escape = (v) => {
        const s = String(v ?? '');
        return s.includes(',') || s.includes('"') || s.includes('\n')
            ? '"' + s.replace(/"/g, '""') + '"'
            : s;
    };

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
        `attachment; filename="second-shift-${gameId.slice(0, 8)}-${precision}.csv"`);

    res.write('timestamp,tick,category,name,produced_per_min,consumed_per_min,net_per_min,status\n');

    for (const snap of rows) {
        for (const category of ['items', 'fluids', 'electricity']) {
            for (const [name, item] of Object.entries(snap[category] || {})) {
                const produced = item.producedPerMin ?? 0;
                const consumed = item.consumedPerMin ?? 0;
                const net      = item.netPerMin ?? (produced - consumed);
                const status   = item.status ?? '';
                res.write([snap.timestamp, snap.tick, category, name,
                    produced, consumed, net, status].map(escape).join(',') + '\n');
            }
        }
    }

    res.end();
});

// WebSocket: push live updates to all connected dashboard tabs
wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`[ws] client connected (total: ${clients.size})`);

    // Send current state immediately so the dashboard isn't blank
    const latest = getLatest();
    if (latest) ws.send(JSON.stringify({ type: 'stats_update', payload: latest }));
    ws.send(JSON.stringify({ type: 'game_status', status: getGameIsLive() ? 'live' : 'waiting' }));
    ws.send(JSON.stringify({ type: 'games_list', payload: listGames() }));

    ws.on('close', () => { clients.delete(ws); console.log(`[ws] client disconnected (total: ${clients.size})`); });
    ws.on('error', (err) => { console.error('[ws] error:', err.message); clients.delete(ws); });
});

// Initialise SQLite DB, then start the file watcher
dbInit();
startWatcher();

server.listen(config.port, () => {
    console.log(`[server] dashboard → http://localhost:${config.port}`);
});
