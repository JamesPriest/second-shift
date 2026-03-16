'use strict';
require('dotenv').config();
const path = require('path');
const fs   = require('fs');

const scriptOutputDir = process.env.FACTORIO_SCRIPT_OUTPUT;

if (!scriptOutputDir) {
    console.error('[config] ERROR: FACTORIO_SCRIPT_OUTPUT is not set.');
    console.error('[config] Copy server/.env.example to server/.env and set the path.');
    process.exit(1);
}

if (!fs.existsSync(scriptOutputDir)) {
    console.warn(`[config] WARNING: Directory does not exist yet: ${scriptOutputDir}`);
    console.warn('[config] The watcher will activate once Factorio creates it.');
}

module.exports = {
    scriptOutputDir,
    watchedFile:      path.join(scriptOutputDir, 'second-shift.json'),
    port:             parseInt(process.env.PORT           || '3000', 10),
    historyLength:    parseInt(process.env.HISTORY_LENGTH || '60',   10),
    factorioDataPath: process.env.FACTORIO_DATA_PATH || null,
};
