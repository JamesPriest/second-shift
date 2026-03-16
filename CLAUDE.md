# Second Shift — Factorio Production Dashboard

A real-time second-monitor dashboard for Factorio production/consumption statistics. Identifies bottlenecks and deficits without switching away from the game.

## Architecture

```
Factorio (game)
  └─[control.lua writes every 5s]──> %APPDATA%/Factorio/script-output/second-shift.json
                                                    │
                                     Node.js server (chokidar watches file)
                                                    │
                                     WebSocket broadcast to all open browser tabs
                                                    │
                                     Dashboard at http://localhost:3000
```

## Component Overview

| Path | Purpose |
|---|---|
| `factorio-mod/` | Factorio 2.0 mod — exports stats to JSON every 5s |
| `server/index.js` | Express HTTP server + WebSocket server |
| `server/lib/config.js` | Env config loader, fails fast if path unset |
| `server/lib/watcher.js` | File watcher, history ring buffer, WS broadcast |
| `server/lib/statsProcessor.js` | Rate calculation, deficit classification |
| `server/public/` | Single-page dashboard (vanilla JS + Chart.js) |

## Installing the Factorio Mod

1. Locate your Factorio **mods** folder:
   - Windows: `%APPDATA%\Factorio\mods\`
   - Linux:   `~/.factorio/mods/`
   - Mac:     `~/Library/Application Support/factorio/mods/`

2. Copy the `factorio-mod/` folder into the mods directory and rename it to:
   ```
   second-shift_1.0.0
   ```
   Factorio requires the folder name format `modname_version`.

3. Enable the mod in Factorio → Main Menu → Mods. **Factorio 2.0+ required.**

4. Start or load a save. Within 5 seconds, the mod will create:
   - Windows: `%APPDATA%\Factorio\script-output\second-shift.json`
   - Linux:   `~/.factorio/script-output\second-shift.json`
   - Mac:     `~/Library/Application Support/factorio/script-output/second-shift.json`

## Running the Server

```bash
cd server
cp .env.example .env
# Edit .env — set FACTORIO_SCRIPT_OUTPUT to the script-output path above
npm install
npm start
```

Open **http://localhost:3000** on your second monitor.

For auto-restart during development:
```bash
npm run dev
```

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `FACTORIO_SCRIPT_OUTPUT` | *(required)* | Absolute path to Factorio's `script-output` folder |
| `PORT` | `3000` | Port the dashboard server listens on |
| `HISTORY_LENGTH` | `60` | Snapshots retained in memory (60 × 5s = 5 minutes of history) |

## How Rates Are Calculated

Factorio's production statistics expose **cumulative** counters (total units since session start). The mod snapshots these every 300 ticks (5 seconds) and persists the last snapshot in `storage` (Factorio 2.0's persistent table).

Each tick event diffs current vs previous snapshot:

```
delta_produced = current.output_counts[item] - previous.output_counts[item]
delta_consumed = current.input_counts[item]  - previous.input_counts[item]
```

The server converts deltas to per-minute rates:

```
intervalSeconds    = interval_ticks / 60   -- 300 / 60 = 5 seconds
minutesPerInterval = intervalSeconds / 60  -- 5 / 60 ≈ 0.0833 min
producedPerMin     = delta / minutesPerInterval
```

Negative values (e.g. after loading an older save) are clamped to 0.

## Deficit Detection

| Status | Condition | Dashboard Color |
|---|---|---|
| `surplus` | produced > consumed | Blue |
| `balanced` | produced == consumed | Green |
| `deficit-warning` | consumed > produced, ratio < 1.5× | Yellow |
| `deficit-severe` | consumed > produced, ratio ≥ 1.5× | Red |

The ratio is `consumed / produced`. At 1.5× the factory consumes 50% more than it produces — assemblers are starving.

## Factorio 2.0 API Notes

- `storage` (not `global`) is the persistent Lua table in Factorio 2.0
- `LuaCustomTable` (from `.input_counts` / `.output_counts`) must be copied to a plain Lua table before `game.table_to_json()` can serialize it
- `game.write_file(path, content, false)` — `false` means overwrite, not append
- `force.electric_network_statistics` is per-force (not per-surface)
