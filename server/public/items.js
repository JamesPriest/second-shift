'use strict';

// ── Item name formatting ───────────────────────────────────────────────────────
// Converts internal Factorio item IDs to human-readable display names.
// The base algorithm capitalises each hyphen-separated word.
// NAME_OVERRIDES handles the handful of IDs where the automatic result is wrong.
const NAME_OVERRIDES = {
    'uranium-235': 'Uranium-235',
    'uranium-238': 'Uranium-238',
};

function formatItemName(id) {
    if (NAME_OVERRIDES[id]) return NAME_OVERRIDES[id];
    return id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── Icon URL ───────────────────────────────────────────────────────────────────
// Server proxies icons from the Factorio data directory when FACTORIO_DATA_PATH
// is set in .env. Falls back gracefully (img onerror hides the element) if not.
function iconUrl(id) {
    return `/icons/${encodeURIComponent(id)}.png`;
}

// Helper: builds the icon <img> HTML with graceful fallback.
function iconImg(id, extraClass = '') {
    const cls = ['item-icon', extraClass].filter(Boolean).join(' ');
    return `<img class="${cls}" src="${iconUrl(id)}" alt="" onerror="this.style.display='none'">`;
}

// ── Default timeline items ─────────────────────────────────────────────────────
// Auto-selected when the Timeline tab is opened with no prior selection.
// The dashboard filters this list to items that actually exist in the current save.
const DEFAULT_ITEMS = [
    // Core plates — always a bottleneck
    'iron-plate', 'copper-plate', 'steel-plate',
    // Circuit chain
    'electronic-circuit', 'advanced-circuit', 'processing-unit',
    // Key intermediates
    'iron-gear-wheel', 'copper-cable', 'plastic-bar',
    // Science packs (base game)
    'automation-science-pack', 'logistic-science-pack',
    'chemical-science-pack',   'production-science-pack', 'utility-science-pack',
    // Science packs (Space Age)
    'electromagnetic-science-pack', 'metallurgic-science-pack',
    'agricultural-science-pack',    'cryogenic-science-pack',
    // Rocket components
    'low-density-structure', 'rocket-control-unit', 'rocket-fuel',
    // Space Age materials
    'tungsten-plate', 'carbon-fiber',
];
