'use strict';

const TICKS_PER_SECOND = 60;

function processStats(raw, wallClockMs = Date.now()) {
    const intervalSeconds    = (raw.interval_ticks || 300) / TICKS_PER_SECOND;
    const minutesPerInterval = intervalSeconds / 60;

    const toPerMinute = (delta) => Math.max(0, Math.round((delta || 0) / minutesPerInterval));

    // Electricity deltas are in joules; convert to average MW over the interval.
    const toMW = (delta) => Math.max(0, (delta || 0) / intervalSeconds / 1_000_000);

    const processCategory = (categoryObj) => {
        const result = {};
        for (const [name, counts] of Object.entries(categoryObj || {})) {
            const producedPM = toPerMinute(counts.produced);
            const consumedPM = toPerMinute(counts.consumed);
            const netPM      = producedPM - consumedPM;
            let status = 'balanced';
            if (consumedPM > producedPM) {
                const ratio = producedPM === 0 ? Infinity : consumedPM / producedPM;
                status = ratio >= 1.5 ? 'deficit-severe' : 'deficit-warning';
            } else if (producedPM > consumedPM) {
                status = 'surplus';
            }
            result[name] = { name, producedPerMin: producedPM, consumedPerMin: consumedPM, netPerMin: netPM, status };
        }
        return result;
    };

    // Electricity entries use MW instead of items/min.
    // producedPerMin / consumedPerMin / netPerMin fields hold MW values.
    const processElectricity = (electricityObj) => {
        const result = {};
        for (const [name, counts] of Object.entries(electricityObj || {})) {
            const producedMW = toMW(counts.produced);
            const consumedMW = toMW(counts.consumed);
            const netMW = producedMW - consumedMW;
            let status = 'balanced';
            if (consumedMW > producedMW) {
                const ratio = producedMW === 0 ? Infinity : consumedMW / producedMW;
                status = ratio >= 1.5 ? 'deficit-severe' : 'deficit-warning';
            } else if (producedMW > consumedMW) {
                status = 'surplus';
            }
            result[name] = { name, producedPerMin: producedMW, consumedPerMin: consumedMW, netPerMin: netMW, status };
        }
        return result;
    };

    // Schema v2: per-surface data in raw.surfaces
    // Schema v1 (legacy): flat raw.items / raw.fluids
    if (raw.surfaces) {
        // Build per-surface processed stats
        const processedSurfaces = {};
        // Also accumulate merged totals across all surfaces
        const mergedItems  = {};
        const mergedFluids = {};

        for (const [surfaceName, surfaceData] of Object.entries(raw.surfaces)) {
            processedSurfaces[surfaceName] = {
                items:  processCategory(surfaceData.items),
                fluids: processCategory(surfaceData.fluids),
            };
            // Merge raw deltas for the "all planets" aggregate
            for (const [name, counts] of Object.entries(surfaceData.items  || {})) {
                mergedItems[name]  = { produced: (mergedItems[name]?.produced  || 0) + (counts.produced || 0), consumed: (mergedItems[name]?.consumed  || 0) + (counts.consumed || 0) };
            }
            for (const [name, counts] of Object.entries(surfaceData.fluids || {})) {
                mergedFluids[name] = { produced: (mergedFluids[name]?.produced || 0) + (counts.produced || 0), consumed: (mergedFluids[name]?.consumed || 0) + (counts.consumed || 0) };
            }
        }

        return {
            timestamp:  new Date(wallClockMs).toISOString(),
            tick:       raw.tick,
            surfaces:   processedSurfaces,
            // Merged totals for "All Planets" — same shape as per-surface stats
            items:      processCategory(mergedItems),
            fluids:     processCategory(mergedFluids),
            electricity: processElectricity(raw.electricity),
        };
    }

    // Legacy schema v1 fallback
    return {
        timestamp:   new Date(wallClockMs).toISOString(),
        tick:        raw.tick,
        surfaces:    {},
        items:       processCategory(raw.items),
        fluids:      processCategory(raw.fluids),
        electricity: processCategory(raw.electricity),
    };
}

module.exports = { processStats };
