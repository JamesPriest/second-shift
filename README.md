# Second Shift

**A completely vibe coded factorio mod -- I'm just here to solve a want on the game**. Do not ask me about the code, I'm barely competent as it is and the moment Claude starting churning I stopped thinking.

Real-time Factorio production/consumption dashboard for a second monitor. Identifies bottlenecks and deficits without alt-tabbing from the game.

![Items tab showing produced vs consumed per minute with deficit highlighting]

---

## Requirements

- Factorio 2.0+
- Node.js 20+

---

## 1. Install the Factorio mod

Copy the `factorio-mod/` folder into your Factorio mods directory and **rename it** to `second-shift_1.0.0`:

| OS      | Mods directory                                 |
| ------- | ---------------------------------------------- |
| Windows | `%APPDATA%\Factorio\mods\`                     |
| Linux   | `~/.factorio/mods/`                            |
| Mac     | `~/Library/Application Support/factorio/mods/` |

So the result looks like:

```
mods/
└── second-shift_1.0.0/
    ├── info.json
    └── control.lua
```

Enable the mod in Factorio → **Main Menu → Mods**, then start or load a save.

The mod writes stats every 5 seconds to:

| OS      | Output file                                                              |
| ------- | ------------------------------------------------------------------------ |
| Windows | `%APPDATA%\Factorio\script-output\second-shift.json`                     |
| Linux   | `~/.factorio/script-output/second-shift.json`                            |
| Mac     | `~/Library/Application Support/factorio/script-output/second-shift.json` |

---

## 2. Configure the server

```bash
cd server
cp .env.example .env
```

Open `.env` and set `FACTORIO_SCRIPT_OUTPUT` to the `script-output` path from the table above. Example for Windows:

```
FACTORIO_SCRIPT_OUTPUT=C:\Users\YourName\AppData\Roaming\Factorio\script-output
```

---

## 3. Start the server

```bash
cd server
npm install
npm start
```

---

## 4. Open the dashboard

Open **http://localhost:3000** on your second monitor.

The status badge in the top-left shows **Live** once data is flowing. The first update arrives within 5 seconds of the next game tick.

---

## Dashboard overview

| Control                          | Description                                            |
| -------------------------------- | ------------------------------------------------------ |
| **Items / Fluids / Electricity** | Switch stat category                                   |
| **Show top N**                   | Limit how many rows the chart shows                    |
| **Sort by**                      | Order by consumed, produced, deficit severity, or name |

**Left panel** lists every item currently in deficit, worst first:

- 🔴 Red — consuming 50%+ more than producing (severe)
- 🟡 Yellow — consuming any amount more than producing (warning)

**Right panel** shows a horizontal bar chart of produced vs consumed per minute, bars coloured by status.

---

## Troubleshooting

**Mod crashes on load** — confirm you are on Factorio 2.0+. The mod uses APIs (`helpers.write_file`, per-surface statistics) not available in 1.x.

**Dashboard shows "No data yet"** — check that:

1. The mod is enabled and the game is running (not paused)
2. `FACTORIO_SCRIPT_OUTPUT` in `.env` points to the correct folder
3. `second-shift.json` exists in that folder

**Check mod logs** — in Factorio: Help → Open Log File, then search for `[second-shift]`.
