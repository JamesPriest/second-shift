-- second-shift/control.lua
-- Factorio 2.0 compatible production statistics exporter.
-- Writes script-output/second-shift.json every TICK_INTERVAL ticks.
-- On first tick, writes a one-time script-output/second-shift-backfill.json
-- using LuaFlowStatistics.get_flow_count to backfill historical data.

local TICK_INTERVAL           = 300      -- 5 seconds at 60 ticks/s
local BACKFILL_INTERVAL_TICKS = 216000   -- re-backfill once per in-game hour (60 min × 60 s/min × 60 ticks/s)
local OUTPUT_FILE    = "second-shift.json"
local BACKFILL_FILE  = "second-shift-backfill.json"

local BACKFILL_PRECISIONS = {
    { key = "one_minute", precision = defines.flow_precision_index.one_minute, bucket_ticks = 3600,   n_buckets = 120 },
    { key = "one_hour",   precision = defines.flow_precision_index.one_hour,   bucket_ticks = 216000, n_buckets = 120 },
}

local function ss_log(msg)
    log("[second-shift] " .. tostring(msg))
end

local function generate_id()
    local chars = "abcdefghijklmnopqrstuvwxyz0123456789"
    local id = ""
    for _ = 1, 12 do
        local i = math.random(1, #chars)
        id = id .. string.sub(chars, i, i)
    end
    return id
end

-- Snapshot a single LuaFlowStatistics into { inputs = {}, outputs = {} }.
local function snapshot_stat(stat)
    local s = { inputs = {}, outputs = {} }
    for name, count in pairs(stat.input_counts)  do s.inputs[name]  = count end
    for name, count in pairs(stat.output_counts) do s.outputs[name] = count end
    return s
end

-- Snapshot force-wide electric network statistics.
-- Returns { inputs = { name = cumulative_joules }, outputs = { … } }
local function snapshot_electricity(force)
    local s = { inputs = {}, outputs = {} }
    local ok, stat = pcall(function() return force.electric_network_statistics end)
    if ok and stat then
        for name, count in pairs(stat.input_counts)  do s.inputs[name]  = count end
        for name, count in pairs(stat.output_counts) do s.outputs[name] = count end
    end
    return s
end

-- Diff two electricity snapshots. Returns { name = { produced = joules, consumed = joules } }
local function compute_electricity_deltas(prev_elec, curr_elec)
    local deltas = {}
    local names  = {}
    for name in pairs(curr_elec.inputs)  do names[name] = true end
    for name in pairs(curr_elec.outputs) do names[name] = true end
    for name in pairs(names) do
        local p_in  = (prev_elec and prev_elec.inputs[name])  or 0
        local p_out = (prev_elec and prev_elec.outputs[name]) or 0
        local consumed = (curr_elec.inputs[name]  or 0) - p_in
        local produced = (curr_elec.outputs[name] or 0) - p_out
        if consumed > 0 or produced > 0 then
            deltas[name] = { produced = produced, consumed = consumed }
        end
    end
    return deltas
end

-- Snapshot item + fluid stats for every surface, keyed by surface name.
-- Returns { [surface_name] = { items = snap, fluids = snap } }
local function snapshot_per_surface(force)
    local result = {}
    for _, surface in pairs(game.surfaces) do
        local ok_i, item_stat  = pcall(force.get_item_production_statistics,  surface)
        local ok_f, fluid_stat = pcall(force.get_fluid_production_statistics, surface)
        if ok_i and ok_f then
            result[surface.name] = {
                items  = snapshot_stat(item_stat),
                fluids = snapshot_stat(fluid_stat),
            }
        else
            if not ok_i then ss_log("snapshot items  failed on " .. surface.name .. ": " .. tostring(item_stat))  end
            if not ok_f then ss_log("snapshot fluids failed on " .. surface.name .. ": " .. tostring(fluid_stat)) end
        end
    end
    return result
end

-- Diff two per-surface snapshots. Returns per-surface deltas:
-- { [surface_name] = { items = {name={produced,consumed}}, fluids = {...} } }
local function compute_surface_deltas(prev_surfaces, curr_surfaces)
    local result = {}
    for sname, curr in pairs(curr_surfaces) do
        local prev = prev_surfaces and prev_surfaces[sname]
        local surface_out = {}
        for _, cat in ipairs({"items", "fluids"}) do
            local deltas = {}
            local names = {}
            for name in pairs(curr[cat].inputs)  do names[name] = true end
            for name in pairs(curr[cat].outputs) do names[name] = true end
            for name in pairs(names) do
                local p_in  = (prev and prev[cat].inputs[name])  or 0
                local p_out = (prev and prev[cat].outputs[name]) or 0
                local consumed = (curr[cat].inputs[name]  or 0) - p_in
                local produced = (curr[cat].outputs[name] or 0) - p_out
                if consumed > 0 or produced > 0 then
                    deltas[name] = { produced = produced, consumed = consumed }
                end
            end
            surface_out[cat] = deltas
        end
        result[sname] = surface_out
    end
    return result
end

-- ── Backfill helpers ──────────────────────────────────────────────────────────

local function collect_flow_history(stat, precision, n_buckets)
    local result = {}
    local names = {}
    for name in pairs(stat.input_counts)  do names[name] = true end
    for name in pairs(stat.output_counts) do names[name] = true end

    local n = 0; for _ in pairs(names) do n = n + 1 end
    ss_log("  collect_flow_history: " .. n .. " names")

    for name in pairs(names) do
        local ok_in, inp = pcall(function()
            return stat.get_flow_count{ name = name, input = true,  precision = precision, count = true }
        end)
        local ok_out, out = pcall(function()
            return stat.get_flow_count{ name = name, input = false, precision = precision, count = true }
        end)
        if ok_in and ok_out then
            -- Use direct index access rather than `#inp` / `#out`.
            -- In Factorio 2.0, get_flow_count returns a LuaArray (C-side object);
            -- the Lua length operator `#` may return 0 on such objects in LuaJIT 5.1
            -- because it does not call __len on non-standard metatables.
            -- Direct indexing (`arr[i]`) does call __index and works correctly.
            local inp_t, out_t = {}, {}
            for i = 1, n_buckets do
                if inp[i] == nil then break end
                inp_t[i] = inp[i]
            end
            for i = 1, n_buckets do
                if out[i] == nil then break end
                out_t[i] = out[i]
            end
            local n_got = 0; for _ in pairs(inp_t) do n_got = n_got + 1 end
            ss_log("  [" .. name .. "] buckets: inp=" .. n_got)
            if n_got > 0 or next(out_t) ~= nil then
                result[name] = { input = inp_t, output = out_t }
            end
        else
            if not ok_in  then ss_log("  get_flow_count input  failed [" .. name .. "]: " .. tostring(inp))  end
            if not ok_out then ss_log("  get_flow_count output failed [" .. name .. "]: " .. tostring(out)) end
        end
    end
    return result
end

local function write_backfill(force)
    local precisions_out = {}

    for _, prec in ipairs(BACKFILL_PRECISIONS) do
        local items_merged  = {}
        local fluids_merged = {}

        local surface_count = 0
        for _, surface in pairs(game.surfaces) do
            surface_count = surface_count + 1
            local ok_i, item_stat  = pcall(force.get_item_production_statistics,  surface)
            local ok_f, fluid_stat = pcall(force.get_fluid_production_statistics, surface)

            if ok_i then
                local n = 0; for _ in pairs(item_stat.input_counts) do n = n + 1 end
                ss_log("backfill " .. prec.key .. ": surface [" .. surface.name .. "] " .. n .. " items")

                local hist = collect_flow_history(item_stat, prec.precision, prec.n_buckets)
                for name, buckets in pairs(hist) do
                    if not items_merged[name] then items_merged[name] = { input = {}, output = {} } end
                    for i, v in ipairs(buckets.input)  do items_merged[name].input[i]  = (items_merged[name].input[i]  or 0) + v end
                    for i, v in ipairs(buckets.output) do items_merged[name].output[i] = (items_merged[name].output[i] or 0) + v end
                end
            else
                ss_log("backfill " .. prec.key .. ": item stat failed [" .. surface.name .. "]: " .. tostring(item_stat))
            end

            if ok_f then
                local hist = collect_flow_history(fluid_stat, prec.precision, prec.n_buckets)
                for name, buckets in pairs(hist) do
                    if not fluids_merged[name] then fluids_merged[name] = { input = {}, output = {} } end
                    for i, v in ipairs(buckets.input)  do fluids_merged[name].input[i]  = (fluids_merged[name].input[i]  or 0) + v end
                    for i, v in ipairs(buckets.output) do fluids_merged[name].output[i] = (fluids_merged[name].output[i] or 0) + v end
                end
            else
                ss_log("backfill " .. prec.key .. ": fluid stat failed [" .. surface.name .. "]: " .. tostring(fluid_stat))
            end
        end

        local item_count = 0; for _ in pairs(items_merged) do item_count = item_count + 1 end
        ss_log("backfill " .. prec.key .. ": " .. surface_count .. " surfaces, " .. item_count .. " merged items")

        -- Electricity is per-force, not per-surface — collect once outside the surface loop.
        local electricity_hist = {}
        local ok_e, elec_stat = pcall(function() return force.electric_network_statistics end)
        if ok_e and elec_stat then
            electricity_hist = collect_flow_history(elec_stat, prec.precision, prec.n_buckets)
        else
            ss_log("backfill " .. prec.key .. ": electric stat failed: " .. tostring(elec_stat))
        end

        precisions_out[prec.key] = {
            bucket_ticks = prec.bucket_ticks,
            items        = items_merged,
            fluids       = fluids_merged,
            electricity  = electricity_hist,
        }
    end

    helpers.write_file(BACKFILL_FILE, helpers.table_to_json({
        game_id    = storage.game_id,
        tick       = game.tick,
        precisions = precisions_out,
    }), false)
    ss_log("backfill written at tick=" .. game.tick)
end

-- ── Lifecycle ────────────────────────────────────────────────────────────────

script.on_init(function()
    storage.game_id            = generate_id()
    storage.prev_surfaces      = nil
    storage.prev_electricity   = nil
    storage.last_backfill_tick = nil
    ss_log("initialized  game_id=" .. storage.game_id)
end)

script.on_load(function()
    ss_log("loaded  game_id=" .. tostring(storage.game_id))
end)

-- ── Main export loop ──────────────────────────────────────────────────────────

script.on_nth_tick(TICK_INTERVAL, function(event)
    local force = game.forces["player"]
    if not force then return end

    -- Null-guard for saves predating this mod version.
    if not storage.game_id then storage.game_id = generate_id(); ss_log("generated game_id=" .. storage.game_id) end

    -- Migration: old saves stored merged totals in storage.prev_snapshot.
    -- The new format uses storage.prev_surfaces (per-surface). Reset if stale.
    if storage.prev_snapshot ~= nil then
        storage.prev_snapshot = nil
        storage.prev_surfaces = nil
        ss_log("reset prev_snapshot (migrated to per-surface format)")
    end

    -- Migration: old saves used a one-shot backfill_done boolean.
    -- New code uses last_backfill_tick for periodic re-backfill (SQLite is idempotent).
    if storage.backfill_done ~= nil then
        storage.last_backfill_tick = nil  -- trigger an immediate backfill on next check
        storage.backfill_done = nil
        ss_log("migrated backfill_done → periodic backfill (last_backfill_tick)")
    end

    -- Re-backfill once per in-game hour so SQLite always has up-to-date long history.
    if not storage.last_backfill_tick or
       (event.tick - storage.last_backfill_tick) >= BACKFILL_INTERVAL_TICKS then
        write_backfill(force)
        storage.last_backfill_tick = event.tick
    end

    local curr_surfaces      = snapshot_per_surface(force)
    local surface_deltas     = compute_surface_deltas(storage.prev_surfaces, curr_surfaces)

    local curr_electricity   = snapshot_electricity(force)
    local electricity_deltas = compute_electricity_deltas(storage.prev_electricity, curr_electricity)

    local payload = {
        schema_version = 2,
        game_id        = storage.game_id,
        tick           = event.tick,
        interval_ticks = TICK_INTERVAL,
        surfaces       = surface_deltas,
        electricity    = electricity_deltas,
    }

    helpers.write_file(OUTPUT_FILE, helpers.table_to_json(payload), false)
    ss_log("wrote tick=" .. event.tick)

    storage.prev_surfaces    = curr_surfaces
    storage.prev_electricity = curr_electricity
end)
