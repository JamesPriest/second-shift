# Second Shift — Factorio Production Dashboard

A real-time second-monitor dashboard for Factorio production/consumption statistics. Identifies bottlenecks and deficits without switching away from the game.

## Architecture

```
Factorio (game)
  ├─[control.lua, every 5s]──────> script-output/second-shift.json          (live deltas)
  └─[control.lua, every ~1h]─────> script-output/second-shift-backfill.json (bucket history)
                                                    │
                                     Node.js server (chokidar watches both files)
                                                    │
                                     SQLite DB  ←──┤  live_snapshots (2h) + history (5d)
                                                    │
                                     WebSocket broadcast to all open browser tabs
                                                    │
                                     Dashboard at http://localhost:3000
```

## Component Overview

| Path | Purpose |
|---|---|
| `factorio-mod/` | Factorio 2.0 mod — exports live stats + backfill history to JSON |
| `server/index.js` | Express HTTP server + WebSocket server |
| `server/lib/config.js` | Env config loader, fails fast if path unset |
| `server/lib/watcher.js` | File watcher for both JSON files, WS broadcast |
| `server/lib/statsProcessor.js` | Rate calculation, deficit classification, multi-surface merge |
| `server/lib/db.js` | SQLite wrapper — live snapshots + bucketed backfill history |
| `server/public/` | Single-page dashboard (vanilla JS + Chart.js) |
| `server/public/items.js` | `formatItemName()`, `iconUrl()`, `DEFAULT_ITEMS` list |

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
   - Linux:   `~/.factorio/script-output/second-shift.json`
   - Mac:     `~/Library/Application Support/factorio/script-output/second-shift.json`

## Running the Server

Quickest way — use the startup scripts in the project root:

- **Windows:** double-click `start.bat`
- **Linux/Mac:** `./start.sh`

Or manually:

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
cd server && npm run dev
```

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `FACTORIO_SCRIPT_OUTPUT` | *(required)* | Absolute path to Factorio's `script-output` folder |
| `PORT` | `3000` | Port the dashboard server listens on |
| `HISTORY_LENGTH` | `60` | Live snapshots retained in memory (60 × 5s = 5 min) |
| `FACTORIO_DATA_PATH` | *(optional)* | Absolute path to Factorio's `data/` folder — enables item icon serving at `/icons/:name` |

## History & Backfill

The mod writes two JSON files:

- **`second-shift.json`** — live 5-second delta snapshot, overwritten each tick
- **`second-shift-backfill.json`** — written once per in-game hour (216,000 ticks); contains `get_flow_count` bucket arrays at 1-minute and 1-hour precision for all items/fluids seen since the save started

The server stores data in SQLite (`second-shift.db`):

| Table | Contents | Retention |
|---|---|---|
| `live_snapshots` | Full JSON blobs from `second-shift.json` | Pruned to last 2 hours |
| `history` | Columnar rows from backfill (produced_per_min, consumed_per_min per bucket) | Kept indefinitely |
| `games` | One row per game_id with `last_tick` for reload detection | Kept indefinitely |

The `history` table uses `bucket_game_tick` (integer tick at bucket start) as part of its primary key, so re-backfills are idempotent (`INSERT OR REPLACE`).

The Timeline view exposes three precision tabs:
- **Live** — 5-second snapshots, last ~2 hours
- **Minutes** — 1-minute buckets, last ~2 hours
- **Hours** — 1-hour buckets, last ~5 days

## Dashboard Features

**Overview view**
- Deficit panel (left sidebar): lists every item currently in deficit, worst first
- Bar chart (right): produced vs consumed per minute for top-N items
- Controls: category filter (Items / Fluids / Electricity), planet filter, save selector, sort-by, top-N

**Timeline view**
- Card grid: one Chart.js line chart per selected item
- Each card has produced (green) and consumed (amber) toggle buttons
- Item search with autocomplete; default items pre-populated on first open
- Profiles: save/load named item selections to `localStorage`
- Precision tabs: Live / Minutes / Hours

**Save reload detection**
- If the game tick goes backwards (player loaded an older autosave), the server trims `live_snapshots` and `history` rows from the abandoned timeline and broadcasts `reload_detected` to all browser tabs, which re-fetch timeline data

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
- `helpers.write_file(path, content, false)` — `false` means overwrite, not append
- `force.electric_network_statistics` is per-force (not per-surface)
- `stat.get_flow_count(precision, direction, name)` returns a `LuaArray` C-side object where `#arr` always returns 0 (LuaJIT 5.1 does not call `__len` on non-standard metatables). Always iterate with direct index access: `for i = 1, n do if arr[i] == nil then break end ... end`
- The mod cannot launch external processes — `os.execute`, `io.popen`, and socket libraries are all blocked by Factorio's sandbox. Use `start.bat` / `start.sh` alongside the game shortcut instead.
