'use strict';

// ── Shared state ──────────────────────────────────────────────────────────────
let currentData    = null;
let activeView     = 'overview';
let activeCategory = 'items';
let activeGameId   = null;
let activePlanet   = 'all';

function getStatsForPlanet(stats) {
    if (!stats) return stats;
    if (activePlanet === 'all' || !stats.surfaces?.[activePlanet]) return stats;
    return {
        ...stats,
        items:       stats.surfaces[activePlanet].items  || {},
        fluids:      stats.surfaces[activePlanet].fluids || {},
        electricity: {},
    };
}

// ── Overview state ─────────────────────────────────────────────────────────────
let barChart = null;

// ── Timeline state ─────────────────────────────────────────────────────────────
let cardCharts      = new Map();  // itemName → Chart instance
let cardToggles     = new Map();  // itemName → { produced: bool, consumed: bool }
let activePrecision = 'live';
let timelineCat     = 'items';
let selectedItems   = [];
let timelineHistory = [];

const STATUS_COLORS = {
    'deficit-severe':  '#ef4444',
    'deficit-warning': '#f59e0b',
    'balanced':        '#22c55e',
    'surplus':         '#3b82f6',
};

// Stable per-item accent colour for the card left-border.
const LINE_PALETTE = [
    '#3b82f6', '#a855f7', '#06b6d4', '#f97316',
    '#ec4899', '#84cc16', '#14b8a6', '#8b5cf6',
];

function itemColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
    return LINE_PALETTE[h % LINE_PALETTE.length];
}

// ── Bar chart ──────────────────────────────────────────────────────────────────
function initBarChart() {
    const ctx = document.getElementById('bar-chart').getContext('2d');
    barChart = new Chart(ctx, {
        type: 'bar',
        data: { labels: [], datasets: [] },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: true, labels: { color: '#f9fafb' } },
                tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${c.parsed.x.toLocaleString()}/min` } },
            },
            scales: {
                x: { title: { display: true, text: 'Units per minute', color: '#9ca3af' }, ticks: { color: '#9ca3af' }, grid: { color: '#374151' }, beginAtZero: true },
                y: { ticks: { color: '#f9fafb', font: { size: 11 } }, grid: { color: '#374151' } },
            },
        },
    });
}

// ── Overview rendering ─────────────────────────────────────────────────────────
const SORTERS = {
    consumed: (a, b) => b.consumedPerMin - a.consumedPerMin,
    produced: (a, b) => b.producedPerMin - a.producedPerMin,
    deficit:  (a, b) => a.netPerMin - b.netPerMin,
    name:     (a, b) => a.name.localeCompare(b.name),
};

function renderOverview(stats) {
    const topN   = parseInt(document.getElementById('top-n').value, 10) || 20;
    const sortBy = document.getElementById('sort-by').value;
    const cat    = stats[activeCategory] || {};
    const items  = Object.values(cat).sort(SORTERS[sortBy] || SORTERS.consumed).slice(0, topN);

    barChart.data.labels   = items.map(i => formatItemName(i.name));
    barChart.data.datasets = [
        {
            label:           'Produced/min',
            data:            items.map(i => i.producedPerMin),
            backgroundColor: items.map(i => STATUS_COLORS[i.status] + 'bb'),
            borderColor:     items.map(i => STATUS_COLORS[i.status]),
            borderWidth: 1,
        },
        {
            label:           'Consumed/min',
            data:            items.map(i => i.consumedPerMin),
            backgroundColor: '#6b728077',
            borderColor:     '#6b7280',
            borderWidth: 1,
        },
    ];
    barChart.update('none');

    const deficits = Object.values(cat)
        .filter(i => i.status === 'deficit-severe' || i.status === 'deficit-warning')
        .sort((a, b) => a.netPerMin - b.netPerMin);

    const list = document.getElementById('deficit-list');
    list.innerHTML = deficits.length === 0
        ? '<li class="ok">No deficits detected</li>'
        : deficits.map(i => `
            <li class="${i.status}">
                <span class="item-name">${iconImg(i.name, 'item-icon-sm')} ${formatItemName(i.name)}</span>
                <span class="rates">${i.producedPerMin.toLocaleString()}/min produced</span>
                <span class="rates">${i.consumedPerMin.toLocaleString()}/min consumed</span>
                <span class="net">Net: ${i.netPerMin.toLocaleString()}/min</span>
            </li>`).join('');

    document.getElementById('last-update').textContent =
        `Updated: ${new Date(stats.timestamp).toLocaleTimeString()}  ·  Tick ${stats.tick.toLocaleString()}`;
}

// ── Timeline: card helpers ─────────────────────────────────────────────────────

// Resolves the right category object from a snapshot for the active planet/category.
function getCat(snap) {
    if (activePlanet !== 'all' && snap.surfaces?.[activePlanet]) {
        return snap.surfaces[activePlanet][timelineCat];
    }
    return snap[timelineCat];
}

function createCard(name) {
    if (!cardToggles.has(name)) cardToggles.set(name, { produced: true, consumed: true });
    const toggles = cardToggles.get(name);
    const accent  = itemColor(name);

    const card = document.createElement('div');
    card.className    = 'timeline-card';
    card.dataset.name = name;
    card.style.setProperty('--card-accent', accent);
    card.innerHTML = `
        <div class="card-header">
            ${iconImg(name)}
            <span class="card-title">${formatItemName(name)}</span>
            <div class="card-toggles">
                <button class="toggle-btn${toggles.produced ? ' active' : ''}" data-line="produced">Produced</button>
                <button class="toggle-btn${toggles.consumed ? ' active' : ''}" data-line="consumed">Consumed</button>
            </div>
            <button class="card-close" title="Remove">×</button>
        </div>
        <div class="card-body">
            <canvas></canvas>
        </div>
    `;

    document.getElementById('card-grid').appendChild(card);

    card.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const state = cardToggles.get(name);
            state[btn.dataset.line] = !state[btn.dataset.line];
            btn.classList.toggle('active', state[btn.dataset.line]);
            updateCard(name);
        });
    });

    card.querySelector('.card-close').addEventListener('click', () => removeItem(name));

    const chart = new Chart(card.querySelector('canvas').getContext('2d'), {
        type: 'line',
        data: { datasets: [] },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (c) => ` ${c.dataset.label}: ${Math.round(c.parsed.y).toLocaleString()}/min`,
                    },
                },
            },
            scales: {
                x: {
                    type: 'time',
                    time: {
                        tooltipFormat: 'MMM d, HH:mm',
                        displayFormats: { second: 'HH:mm:ss', minute: 'HH:mm', hour: 'MMM d HH:mm', day: 'MMM d' },
                    },
                    ticks: { color: '#9ca3af', maxTicksLimit: 8 },
                    grid:  { color: '#374151' },
                },
                y: {
                    ticks: { color: '#9ca3af' },
                    grid:  { color: '#374151' },
                    beginAtZero: true,
                },
            },
        },
    });

    cardCharts.set(name, chart);
}

function updateCard(name) {
    const chart   = cardCharts.get(name);
    const toggles = cardToggles.get(name);
    if (!chart || !toggles) return;

    const datasets = [];

    if (toggles.produced) {
        const pts = timelineHistory
            .filter(s => getCat(s)?.[name])
            .map(s => ({ x: s.timestamp, y: getCat(s)[name].producedPerMin }));
        if (pts.length) datasets.push({
            label:           'Produced',
            data:            pts,
            borderColor:     '#22c55e',
            backgroundColor: '#22c55e22',
            borderWidth:     2,
            pointRadius:     activePrecision === 'live' ? 0 : 2,
            tension:         0.3,
            fill:            true,
        });
    }

    if (toggles.consumed) {
        const pts = timelineHistory
            .filter(s => getCat(s)?.[name])
            .map(s => ({ x: s.timestamp, y: getCat(s)[name].consumedPerMin }));
        if (pts.length) datasets.push({
            label:           'Consumed',
            data:            pts,
            borderColor:     '#f59e0b',
            backgroundColor: 'transparent',
            borderWidth:     2,
            borderDash:      [5, 5],
            pointRadius:     activePrecision === 'live' ? 0 : 2,
            tension:         0.3,
        });
    }

    chart.data.datasets = datasets;
    chart.update('none');
}

function destroyCard(name) {
    const chart = cardCharts.get(name);
    if (chart) { chart.destroy(); cardCharts.delete(name); }
    const el = document.querySelector(`.timeline-card[data-name="${CSS.escape(name)}"]`);
    if (el) el.remove();
}

function removeItem(name) {
    selectedItems = selectedItems.filter(n => n !== name);
    renderSelectedTags();
    destroyCard(name);
    document.getElementById('timeline-empty').style.display =
        selectedItems.length === 0 ? 'flex' : 'none';
}

// ── Timeline: history loading & rendering ─────────────────────────────────────

// Populates selectedItems with DEFAULT_ITEMS entries that exist in currentData.
// Only runs when nothing has been manually selected yet.
function applyDefaultItems() {
    if (selectedItems.length > 0 || !currentData) return;
    const available = new Set(getAvailableItems());
    for (const name of DEFAULT_ITEMS) {
        if (available.has(name)) selectedItems.push(name);
    }
    if (selectedItems.length > 0) renderSelectedTags();
}

async function loadTimelineHistory() {
    const gid = activeGameId;
    if (!gid) return;

    applyDefaultItems();

    try {
        const res = await fetch(`/api/history?precision=${activePrecision}&gameId=${gid}`);
        timelineHistory = await res.json();
    } catch (err) {
        console.error('history fetch failed:', err);
        timelineHistory = [];
    }
    renderCards();
}

function renderCards() {
    const empty = document.getElementById('timeline-empty');

    if (selectedItems.length === 0) {
        empty.style.display = 'flex';
        for (const name of [...cardCharts.keys()]) destroyCard(name);
        return;
    }
    empty.style.display = 'none';

    // Remove stale cards for items no longer selected
    for (const name of [...cardCharts.keys()]) {
        if (!selectedItems.includes(name)) destroyCard(name);
    }

    // Create cards for new items; update all existing ones
    for (const name of selectedItems) {
        if (!cardCharts.has(name)) createCard(name);
        updateCard(name);
    }
}

// Appends a live snapshot to the in-memory buffer and updates each open card.
function appendLiveSnapshot(snap) {
    if (activeView !== 'timeline' || activePrecision !== 'live') return;
    timelineHistory.push(snap);
    if (timelineHistory.length > 720) timelineHistory.shift();
    for (const name of selectedItems) updateCard(name);
}

// ── Planet filter ─────────────────────────────────────────────────────────────
function updatePlanetFilter(stats) {
    if (!stats?.surfaces) return;
    const sel      = document.getElementById('planet-filter');
    const known    = new Set([...sel.options].map(o => o.value));
    const surfaces = Object.keys(stats.surfaces).sort();

    for (const name of surfaces) {
        if (!known.has(name)) {
            const opt = document.createElement('option');
            opt.value       = name;
            opt.textContent = name.charAt(0).toUpperCase() + name.slice(1);
            sel.appendChild(opt);
        }
    }
}

// ── Game selector ──────────────────────────────────────────────────────────────
function updateGamesList(games) {
    const sel  = document.getElementById('game-selector');
    const prev = sel.value;

    sel.innerHTML = games.map(g => {
        const date  = g.lastSeen ? new Date(g.lastSeen).toLocaleDateString() : 'no data';
        const label = `${g.gameId.slice(0, 8)}… (${date})`;
        return `<option value="${g.gameId}">${label}</option>`;
    }).join('');

    if (games.some(g => g.gameId === prev)) {
        sel.value = prev;
    } else if (games.length > 0) {
        sel.value = games[0].gameId;
        onGameSelected(games[0].gameId);
    }
}

function onGameSelected(gameId) {
    if (gameId === activeGameId) return;
    activeGameId = gameId;
    selectedItems = [];
    cardToggles.clear();
    for (const name of [...cardCharts.keys()]) destroyCard(name);
    renderSelectedTags();
    document.getElementById('timeline-empty').style.display = 'flex';
    if (activeView === 'timeline') loadTimelineHistory();
}

// ── Item search / tag strip ────────────────────────────────────────────────────
function getAvailableItems() {
    const source = getStatsForPlanet(currentData);
    if (!source) return [];
    return Object.keys(source[timelineCat] || {}).sort();
}

function renderSelectedTags() {
    const el = document.getElementById('selected-items');
    el.innerHTML = selectedItems.map(name =>
        `<span class="selected-tag" data-name="${name}">${iconImg(name, 'item-icon-sm')} ${formatItemName(name)} <button class="remove-tag">×</button></span>`
    ).join('');
    el.querySelectorAll('.remove-tag').forEach(btn =>
        btn.addEventListener('click', () => removeItem(btn.closest('.selected-tag').dataset.name))
    );
}

function setupItemSearch() {
    const input   = document.getElementById('item-search');
    const suggest = document.getElementById('item-suggestions');

    input.addEventListener('input', () => {
        const q       = input.value.toLowerCase().trim();
        const matches = q.length === 0 ? [] : getAvailableItems().filter(n => n.includes(q)).slice(0, 10);
        suggest.innerHTML = matches.map(n =>
            `<li data-name="${n}">${iconImg(n, 'item-icon-sm')} ${formatItemName(n)}</li>`
        ).join('');
        suggest.classList.toggle('visible', matches.length > 0);
    });

    suggest.addEventListener('click', (e) => {
        const li = e.target.closest('li');
        if (!li) return;
        const name = li.dataset.name;
        if (!selectedItems.includes(name)) {
            selectedItems.push(name);
            renderSelectedTags();
            renderCards();
        }
        input.value = '';
        suggest.innerHTML = '';
        suggest.classList.remove('visible');
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#item-search-wrap')) {
            suggest.innerHTML = '';
            suggest.classList.remove('visible');
        }
    });
}

// ── Profiles ──────────────────────────────────────────────────────────────────
// Profiles are stored in localStorage as an array of { name, items[], category }.
// They survive page reloads and browser restarts but are local to this browser.

const PROFILES_KEY = 'second-shift-profiles';

function readProfiles() {
    try { return JSON.parse(localStorage.getItem(PROFILES_KEY) || '[]'); }
    catch { return []; }
}

function writeProfiles(profiles) {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
}

function renderProfileDropdown() {
    const sel      = document.getElementById('profile-select');
    const current  = sel.value;
    const profiles = readProfiles();
    sel.innerHTML  = '<option value="">— Load profile —</option>' +
        profiles.map((p, i) => `<option value="${i}">${p.name}</option>`).join('');
    if (profiles.some((_, i) => String(i) === current)) sel.value = current;
}

function saveCurrentAsProfile() {
    if (selectedItems.length === 0) { alert('No items selected to save.'); return; }
    const name = prompt('Profile name:');
    if (!name || !name.trim()) return;
    const trimmed  = name.trim();
    const profiles = readProfiles();
    const existing = profiles.findIndex(p => p.name === trimmed);
    const profile  = { name: trimmed, items: [...selectedItems], category: timelineCat };
    if (existing >= 0) {
        if (!confirm(`Overwrite existing profile "${trimmed}"?`)) return;
        profiles[existing] = profile;
    } else {
        profiles.push(profile);
    }
    writeProfiles(profiles);
    renderProfileDropdown();
    document.getElementById('profile-select').value =
        String(existing >= 0 ? existing : profiles.length - 1);
}

function loadSelectedProfile() {
    const sel      = document.getElementById('profile-select');
    const idx      = parseInt(sel.value, 10);
    if (isNaN(idx)) return;
    const profiles = readProfiles();
    const profile  = profiles[idx];
    if (!profile) return;

    if (profile.category && profile.category !== timelineCat) {
        timelineCat = profile.category;
        document.getElementById('timeline-cat').value = timelineCat;
    }

    selectedItems = [...profile.items];
    for (const name of [...cardCharts.keys()]) destroyCard(name);
    cardToggles.clear();
    renderSelectedTags();
    loadTimelineHistory();
}

function deleteSelectedProfile() {
    const sel     = document.getElementById('profile-select');
    const idx     = parseInt(sel.value, 10);
    if (isNaN(idx)) return;
    const profiles = readProfiles();
    if (!profiles[idx]) return;
    if (!confirm(`Delete profile "${profiles[idx].name}"?`)) return;
    profiles.splice(idx, 1);
    writeProfiles(profiles);
    renderProfileDropdown();
}

// ── View switching ─────────────────────────────────────────────────────────────
function switchView(view) {
    activeView = view;
    document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    document.getElementById('overview-view').classList.toggle('hidden', view !== 'overview');
    document.getElementById('timeline-view').classList.toggle('hidden', view !== 'timeline');
    document.getElementById('overview-controls').classList.toggle('hidden', view !== 'overview');
    document.getElementById('timeline-controls').classList.toggle('hidden', view !== 'timeline');

    if (view === 'timeline') loadTimelineHistory();
}

// ── Game status (badge + overlay) ─────────────────────────────────────────────
let wsConnected = false;
let gameWaiting = false;

function updateBadge() {
    const badge = document.getElementById('connection-badge');
    if (!wsConnected) {
        badge.textContent = 'Reconnecting…';
        badge.className   = 'badge disconnected';
    } else if (gameWaiting) {
        badge.textContent = 'Paused';
        badge.className   = 'badge paused';
    } else {
        badge.textContent = 'Live';
        badge.className   = 'badge connected';
    }
}

function setGameStatus(status) {
    gameWaiting = status === 'waiting';
    document.getElementById('waiting-overlay').classList.toggle('visible', gameWaiting);
    updateBadge();
}

// ── WebSocket ──────────────────────────────────────────────────────────────────
const WS_URL = `ws://${location.host}`;
let ws;
let reconnectDelay = 1000;

function connect() {
    ws = new WebSocket(WS_URL);

    ws.addEventListener('open', () => {
        wsConnected    = true;
        reconnectDelay = 1000;
        updateBadge();
    });

    ws.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }

        if (msg.type === 'stats_update') {
            currentData = msg.payload;
            updatePlanetFilter(currentData);
            if (activeView === 'overview') renderOverview(getStatsForPlanet(currentData));
            appendLiveSnapshot(currentData);
        }
        if (msg.type === 'game_status')  setGameStatus(msg.status);
        if (msg.type === 'games_list')   updateGamesList(msg.payload);
        if (msg.type === 'backfill_ready'  && activeView === 'timeline') loadTimelineHistory();
        if (msg.type === 'reload_detected' && activeView === 'timeline') loadTimelineHistory();
    });

    ws.addEventListener('close', () => {
        wsConnected = false;
        updateBadge();
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    });

    ws.addEventListener('error', () => ws.close());
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initBarChart();
    connect();
    setupItemSearch();

    document.querySelectorAll('.view-btn').forEach(btn =>
        btn.addEventListener('click', () => switchView(btn.dataset.view))
    );

    document.querySelectorAll('.filter-btn[data-cat]').forEach(btn =>
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn[data-cat]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeCategory = btn.dataset.cat;
            if (currentData) renderOverview(getStatsForPlanet(currentData));
        })
    );

    document.getElementById('top-n').addEventListener('input',    () => { if (currentData) renderOverview(getStatsForPlanet(currentData)); });
    document.getElementById('sort-by').addEventListener('change', () => { if (currentData) renderOverview(getStatsForPlanet(currentData)); });

    document.querySelectorAll('.filter-btn[data-precision]').forEach(btn =>
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn[data-precision]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activePrecision = btn.dataset.precision;
            loadTimelineHistory();
        })
    );

    document.getElementById('timeline-cat').addEventListener('change', (e) => {
        timelineCat   = e.target.value;
        selectedItems = [];
        cardToggles.clear();
        for (const name of [...cardCharts.keys()]) destroyCard(name);
        renderSelectedTags();
        document.getElementById('timeline-empty').style.display = 'flex';
        loadTimelineHistory();
    });

    document.getElementById('game-selector').addEventListener('change', (e) => {
        onGameSelected(e.target.value);
    });

    document.getElementById('planet-filter').addEventListener('change', (e) => {
        activePlanet = e.target.value;
        if (currentData) {
            if (activeView === 'overview') renderOverview(getStatsForPlanet(currentData));
            if (activeView === 'timeline') renderCards();
        }
    });

    fetch('/api/games').then(r => r.json()).then(updateGamesList).catch(() => {});

    // Profiles
    renderProfileDropdown();
    document.getElementById('profile-select').addEventListener('change', loadSelectedProfile);
    document.getElementById('profile-save').addEventListener('click',   saveCurrentAsProfile);
    document.getElementById('profile-delete').addEventListener('click', deleteSelectedProfile);
});
