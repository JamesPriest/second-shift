'use strict';
const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const cors    = require('cors');
const config  = require('./lib/config');
const { startWatcher, clients, getLatest, getGameIsLive } = require('./lib/watcher');
const { init: dbInit, getHistory, getCurrentGameId, listGames } = require('./lib/db');

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
        if (fs.existsSync(p)) return res.sendFile(p);
    }
    res.status(404).end();
});

// All known games (for the save selector)
app.get('/api/games', (req, res) => res.json(listGames()));

// Historical data for the timeline chart.
// ?precision=live|minute|hour   (default: live)
// ?gameId=...                   (default: most recently seen game)
app.get('/api/history', (req, res) => {
    const precision = req.query.precision || 'live';
    const gameId    = req.query.gameId    || getCurrentGameId();
    if (!gameId) return res.status(503).json({ error: 'No game data yet.' });
    res.json(getHistory(gameId, precision));
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
