'use strict';

// ── Chart.js: note annotation plugin ─────────────────────────────────────────
// Draws vertical dashed lines + labels at stored note positions on timeline cards.
const noteAnnotationPlugin = {
    id: 'noteAnnotations',
    afterDraw(chart) {
        const notes = chart.options.noteAnnotations;
        if (!notes?.length) return;
        const { ctx, scales, chartArea } = chart;
        if (!scales?.x || !chartArea) return;
        ctx.save();
        for (const note of notes) {
            const x = scales.x.getPixelForValue(note.x);
            if (x < chartArea.left || x > chartArea.right) continue;
            ctx.strokeStyle = '#a855f7bb';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(x, chartArea.top);
            ctx.lineTo(x, chartArea.bottom);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = '#a855f7';
            ctx.font = '9px ui-monospace, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            const label = note.text.length > 22 ? note.text.slice(0, 19) + '…' : note.text;
            ctx.fillText(label, x, chartArea.top + 2);
        }
        ctx.restore();
    },
};
Chart.register(noteAnnotationPlugin);

// ── Shared state ──────────────────────────────────────────────────────────────
let currentData    = null;
let activeView     = 'overview';
let activeCategory = 'items';
let activeGameId   = null;
let activePlanet   = 'all';
let currentItems   = [];  // bar chart items, captured for goal click handler

function getStatsForPlanet(stats) {
    if (!stats) return stats;
    if (activePlanet === 'all' || !stats.surfaces?.[activePlanet]) return stats;
    // electricity is force-wide (not per-surface) — keep the global value from stats
    return {
        ...stats,
        items:  stats.surfaces[activePlanet].items  || {},
        fluids: stats.surfaces[activePlanet].fluids || {},
    };
}

// ── Overview state ─────────────────────────────────────────────────────────────
let barChart = null;

// ── Timeline state ─────────────────────────────────────────────────────────────
let cardCharts       = new Map();  // itemName → Chart instance
let cardToggles      = new Map();  // itemName → { produced: bool, consumed: bool }
let activePrecision  = 'live';
let timelineCat      = 'items';
let selectedItems    = [];
let timelineHistory  = [];
let liveWindowMinutes = 30;
let maximizedItem    = null;
let modalChart       = null;

const STATUS_COLORS = {
    'deficit-severe':  '#ef4444',
    'deficit-warning': '#f59e0b',
    'balanced':        '#22c55e',
    'surplus':         '#3b82f6',
    'below-target':    '#f97316',
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
            // Click a bar to set/clear a production goal for that item
            onClick: (evt, elements) => {
                if (!elements.length) return;
                const idx = elements[0].index;
                if (idx === undefined || !currentItems[idx]) return;
                const item = currentItems[idx];
                const unit = activeCategory === 'electricity' ? 'MW' : '/min';
                const cur  = goals[item.name] !== undefined ? String(goals[item.name]) : '';
                const raw  = prompt(`Target for ${formatItemName(item.name)} (${unit}):\nLeave blank to clear.`, cur);
                if (raw === null) return;
                const val = parseFloat(raw.trim());
                if (!isNaN(val) && val > 0) goals[item.name] = val; else delete goals[item.name];
                saveGoals();
                if (currentData) renderOverview(getStatsForPlanet(currentData));
            },
            plugins: {
                legend: { display: true, labels: { color: '#f9fafb' } },
                tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${c.parsed.x.toLocaleString()}` } },
            },
            scales: {
                x: { title: { display: true, text: 'Units per minute', color: '#9ca3af' }, ticks: { color: '#9ca3af' }, grid: { color: '#374151' }, beginAtZero: true },
                y: { ticks: { color: '#f9fafb', font: { size: 11 } }, grid: { color: '#374151' } },
            },
        },
    });
}

// ── Overview rendering ─────────────────────────────────────────────────────────

// Returns the display status for an item, upgrading surplus/balanced to 'below-target'
// when the item has a goal and is currently underproducing relative to it.
function effectiveStatus(item) {
    if ((item.status === 'surplus' || item.status === 'balanced') &&
        goals[item.name] !== undefined && item.producedPerMin < goals[item.name]) {
        return 'below-target';
    }
    return item.status;
}

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
    currentItems = items;  // captured for goal click handler

    const unit = activeCategory === 'electricity' ? 'MW' : '/min';
    barChart.options.scales.x.title.text = activeCategory === 'electricity' ? 'Megawatts (MW)' : 'Units per minute';

    barChart.data.labels   = items.map(i => formatItemName(i.name));
    barChart.data.datasets = [
        {
            label:           `Produced (${unit})`,
            data:            items.map(i => i.producedPerMin),
            backgroundColor: items.map(i => STATUS_COLORS[effectiveStatus(i)] + 'bb'),
            borderColor:     items.map(i => STATUS_COLORS[effectiveStatus(i)]),
            borderWidth: 1,
        },
        {
            label:           `Consumed (${unit})`,
            data:            items.map(i => i.consumedPerMin),
            backgroundColor: '#6b728077',
            borderColor:     '#6b7280',
            borderWidth: 1,
        },
    ];

    // Target tick marks — thin bar at the goal value for each item that has one
    const targetData = items.map(i => goals[i.name] !== undefined ? goals[i.name] : null);
    if (targetData.some(v => v !== null)) {
        barChart.data.datasets.push({
            label:           `Target (${unit})`,
            data:            targetData,
            backgroundColor: '#fbbf24',
            borderColor:     '#fbbf24',
            borderWidth:     2,
            barThickness:    4,
        });
    }

    barChart.update('none');

    // Deficit panel: real deficits + items below their production target
    const deficits = Object.values(cat)
        .filter(i => {
            if (i.status === 'deficit-severe' || i.status === 'deficit-warning') return true;
            if (goals[i.name] !== undefined && i.producedPerMin < goals[i.name]) return true;
            return false;
        })
        .sort((a, b) => a.netPerMin - b.netPerMin);

    const list = document.getElementById('deficit-list');
    list.innerHTML = deficits.length === 0
        ? '<li class="ok">No deficits detected</li>'
        : deficits.map(i => {
            const es = effectiveStatus(i);
            const targetPct = goals[i.name] !== undefined
                ? ` · ${Math.round(i.producedPerMin / goals[i.name] * 100)}% of target`
                : '';
            return `
            <li class="${es}">
                <span class="item-name">${iconImg(i.name, 'item-icon-sm')} ${formatItemName(i.name)}</span>
                <span class="rates">${i.producedPerMin.toLocaleString()}${unit} produced</span>
                <span class="rates">${i.consumedPerMin.toLocaleString()}${unit} consumed</span>
                <span class="net">Net: ${i.netPerMin.toLocaleString()}${unit}${targetPct}</span>
            </li>`;
        }).join('');

    document.getElementById('last-update').textContent =
        `Updated: ${new Date(stats.timestamp).toLocaleTimeString()}  ·  Tick ${stats.tick.toLocaleString()}`;
}

// ── Timeline: shared chart helpers ────────────────────────────────────────────

function makeLineChartOptions() {
    return {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: { display: false },
            tooltip: {
                callbacks: {
                    title: (items) => {
                        const x = items[0]?.parsed.x ?? 0;
                        if (x === 0) return 'Now';
                        const abs = Math.abs(x);
                        if (abs < 1)    return `${Math.round(abs * 60)}s ago`;
                        if (abs < 60)   return `${abs.toFixed(1)}m ago`;
                        if (abs < 1440) return `${(abs / 60).toFixed(1)}h ago`;
                        return `${(abs / 1440).toFixed(1)}d ago`;
                    },
                    label: (c) => ` ${c.dataset.label}: ${Math.round(c.parsed.y).toLocaleString()}/min`,
                },
            },
        },
        scales: {
            x: {
                type: 'linear',
                ticks: {
                    color: '#9ca3af',
                    maxTicksLimit: 8,
                    callback: (value) => {
                        if (value === 0) return 'now';
                        const abs = Math.abs(value);
                        if (abs < 60)   return `${Math.round(abs)}m ago`;
                        if (abs < 1440) return `${Math.round(abs / 60)}h ago`;
                        return `${Math.round(abs / 1440)}d ago`;
                    },
                },
                grid: { color: '#374151' },
            },
            y: {
                ticks: { color: '#9ca3af' },
                grid:  { color: '#374151' },
                beginAtZero: true,
            },
        },
    };
}

function buildDatasets(name) {
    const toggles    = cardToggles.get(name) || { produced: true, consumed: true };
    const latestTick = timelineHistory.reduce((m, s) => Math.max(m, s.tick || 0), 0);
    const toMinAgo   = (tick) => -((latestTick - (tick || 0)) / 3600);

    const snaps = (activePrecision === 'live' && liveWindowMinutes > 0)
        ? timelineHistory.filter(s => toMinAgo(s.tick) >= -liveWindowMinutes)
        : timelineHistory;

    const datasets = [];

    if (toggles.produced) {
        const pts = snaps
            .filter(s => getCat(s)?.[name])
            .map(s => ({ x: toMinAgo(s.tick), y: getCat(s)[name].producedPerMin }));
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
        const pts = snaps
            .filter(s => getCat(s)?.[name])
            .map(s => ({ x: toMinAgo(s.tick), y: getCat(s)[name].consumedPerMin }));
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

    return datasets;
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
            <button class="card-note-btn toggle-btn" title="Notes">Note</button>
            <button class="card-close" title="Remove">×</button>
        </div>
        <div class="card-notes-panel hidden">
            <ul class="notes-list"></ul>
            <div class="note-add-row">
                <input type="text" class="note-input" placeholder="Add a note…" maxlength="120">
                <button class="note-add-btn">+</button>
            </div>
        </div>
        <div class="card-body">
            <canvas></canvas>
        </div>
    `;

    document.getElementById('card-grid').appendChild(card);

    card.querySelectorAll('.toggle-btn[data-line]').forEach(btn => {
        btn.addEventListener('click', () => {
            const state = cardToggles.get(name);
            state[btn.dataset.line] = !state[btn.dataset.line];
            btn.classList.toggle('active', state[btn.dataset.line]);
            updateCard(name);
        });
    });

    card.querySelector('.card-note-btn').addEventListener('click', () => {
        const panel = card.querySelector('.card-notes-panel');
        panel.classList.toggle('hidden');
        if (!panel.classList.contains('hidden')) renderNotesPanel(name, panel);
    });

    card.querySelector('.card-close').addEventListener('click', () => removeItem(name));
    card.querySelector('.card-body').addEventListener('click', () => openModal(name));

    const chart = new Chart(card.querySelector('canvas').getContext('2d'), {
        type: 'line',
        data: { datasets: [] },
        options: { ...makeLineChartOptions(), noteAnnotations: [] },
    });

    cardCharts.set(name, chart);
}

function updateCard(name) {
    const chart = cardCharts.get(name);
    if (!chart) return;
    chart.data.datasets        = buildDatasets(name);
    chart.options.noteAnnotations = buildNoteAnnotations(name);
    chart.update('none');

    // Keep the Note button label in sync with the note count
    const card = document.querySelector(`.timeline-card[data-name="${CSS.escape(name)}"]`);
    if (card) {
        const count = (loadNotes()[name] || []).length;
        const btn   = card.querySelector('.card-note-btn');
        if (btn) btn.textContent = count > 0 ? `Note (${count})` : 'Note';
        // Refresh notes panel if open
        const panel = card.querySelector('.card-notes-panel');
        if (panel && !panel.classList.contains('hidden')) renderNotesPanel(name, panel);
    }

    if (maximizedItem === name) updateModal();
}

function destroyCard(name) {
    if (maximizedItem === name) closeModal();
    const chart = cardCharts.get(name);
    if (chart) { chart.destroy(); cardCharts.delete(name); }
    const el = document.querySelector(`.timeline-card[data-name="${CSS.escape(name)}"]`);
    if (el) el.remove();
}

// ── Modal (maximized chart) ───────────────────────────────────────────────────

function openModal(name) {
    maximizedItem = name;
    const toggles = cardToggles.get(name) || { produced: true, consumed: true };
    const accent  = itemColor(name);

    const modal = document.getElementById('chart-modal');
    modal.style.setProperty('--card-accent', accent);
    modal.classList.remove('hidden');

    document.getElementById('chart-modal-icon').innerHTML    = iconImg(name);
    document.getElementById('chart-modal-title').textContent = formatItemName(name);

    const togglesEl = document.getElementById('chart-modal-toggles');
    togglesEl.innerHTML = `
        <button class="toggle-btn${toggles.produced ? ' active' : ''}" data-line="produced">Produced</button>
        <button class="toggle-btn${toggles.consumed ? ' active' : ''}" data-line="consumed">Consumed</button>
    `;
    togglesEl.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const state = cardToggles.get(name);
            state[btn.dataset.line] = !state[btn.dataset.line];
            btn.classList.toggle('active', state[btn.dataset.line]);
            const cardBtn = document.querySelector(`.timeline-card[data-name="${CSS.escape(name)}"] .toggle-btn[data-line="${btn.dataset.line}"]`);
            if (cardBtn) cardBtn.classList.toggle('active', state[btn.dataset.line]);
            updateCard(name);
        });
    });

    if (modalChart) { modalChart.destroy(); modalChart = null; }
    const canvas = document.getElementById('chart-modal-canvas');
    modalChart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: { datasets: buildDatasets(name) },
        options: { ...makeLineChartOptions(), noteAnnotations: buildNoteAnnotations(name) },
    });
}

function closeModal() {
    maximizedItem = null;
    document.getElementById('chart-modal').classList.add('hidden');
    if (modalChart) { modalChart.destroy(); modalChart = null; }
}

function updateModal() {
    if (!modalChart || !maximizedItem) return;
    modalChart.data.datasets        = buildDatasets(maximizedItem);
    modalChart.options.noteAnnotations = buildNoteAnnotations(maximizedItem);
    modalChart.update('none');
}

function removeItem(name) {
    selectedItems = selectedItems.filter(n => n !== name);
    renderSelectedTags();
    destroyCard(name);
    document.getElementById('timeline-empty').style.display =
        selectedItems.length === 0 ? 'flex' : 'none';
    updateHash();
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

    // Sync select value with activePlanet (e.g. restored from URL hash before options existed)
    if (activePlanet !== 'all' && [...sel.options].some(o => o.value === activePlanet)) {
        sel.value = activePlanet;
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
// Profiles are stored in localStorage as a UUID-keyed object { [id]: { id, name, items[], category } }.
// UUID keys are stable — deleting one profile never shifts the indices of others.

const PROFILES_KEY = 'second-shift-profiles';

function readProfiles() {
    try {
        const raw = JSON.parse(localStorage.getItem(PROFILES_KEY) || '{}');
        // Migrate from old array format (pre-UUID)
        if (Array.isArray(raw)) {
            const migrated = {};
            for (const p of raw) {
                const id = crypto.randomUUID();
                migrated[id] = { ...p, id };
            }
            writeProfiles(migrated);
            return migrated;
        }
        return raw;
    } catch { return {}; }
}

function writeProfiles(profiles) {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
}

function renderProfileDropdown() {
    const sel      = document.getElementById('profile-select');
    const current  = sel.value;
    const profiles = readProfiles();
    sel.innerHTML  = '<option value="">— Load profile —</option>' +
        Object.values(profiles).map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    if (profiles[current]) sel.value = current;
}

function saveCurrentAsProfile() {
    if (selectedItems.length === 0) { alert('No items selected to save.'); return; }
    const name = prompt('Profile name:');
    if (!name || !name.trim()) return;
    const trimmed  = name.trim();
    const profiles = readProfiles();
    const existing = Object.values(profiles).find(p => p.name === trimmed);
    if (existing) {
        if (!confirm(`Overwrite existing profile "${trimmed}"?`)) return;
        profiles[existing.id] = { ...existing, items: [...selectedItems], category: timelineCat };
        writeProfiles(profiles);
        renderProfileDropdown();
        document.getElementById('profile-select').value = existing.id;
    } else {
        const id = crypto.randomUUID();
        profiles[id] = { id, name: trimmed, items: [...selectedItems], category: timelineCat };
        writeProfiles(profiles);
        renderProfileDropdown();
        document.getElementById('profile-select').value = id;
    }
}

function loadSelectedProfile() {
    const sel     = document.getElementById('profile-select');
    const id      = sel.value;
    if (!id) return;
    const profiles = readProfiles();
    const profile  = profiles[id];
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
    updateHash();
}

function deleteSelectedProfile() {
    const sel     = document.getElementById('profile-select');
    const id      = sel.value;
    if (!id) return;
    const profiles = readProfiles();
    if (!profiles[id]) return;
    if (!confirm(`Delete profile "${profiles[id].name}"?`)) return;
    delete profiles[id];
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
            checkDeficitAlerts(currentData);
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

// ── Toast notifications ────────────────────────────────────────────────────────
let _toastTimer = null;
function showToast(msg, durationMs = 4000) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('visible');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.remove('visible'), durationMs);
}

// ── Notes ──────────────────────────────────────────────────────────────────────
// Per-item freetext notes shown as vertical lines on timeline charts.
// Stored in localStorage as { itemName: [ { text, wallMs, createdAt } ] }.

const NOTES_KEY = 'second-shift-notes';

function loadNotes() {
    try { return JSON.parse(localStorage.getItem(NOTES_KEY) || '{}'); } catch { return {}; }
}
function saveNotes(notes) { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); }

function addNote(itemName, text) {
    const notes = loadNotes();
    if (!notes[itemName]) notes[itemName] = [];
    notes[itemName].push({ text, wallMs: Date.now(), createdAt: new Date().toISOString() });
    saveNotes(notes);
    updateCard(itemName);
    if (maximizedItem === itemName) updateModal();
}

function deleteNote(itemName, idx) {
    const notes = loadNotes();
    if (!notes[itemName]) return;
    notes[itemName].splice(idx, 1);
    if (!notes[itemName].length) delete notes[itemName];
    saveNotes(notes);
    updateCard(itemName);
    if (maximizedItem === itemName) updateModal();
}

// Convert stored notes to chart-space x coordinates (minutes ago relative to latest snapshot).
function buildNoteAnnotations(name) {
    const itemNotes = loadNotes()[name];
    if (!itemNotes?.length || !timelineHistory.length) return [];
    const latestSnap = timelineHistory[timelineHistory.length - 1];
    if (!latestSnap?.timestamp) return [];
    const latestWallMs = new Date(latestSnap.timestamp).getTime();
    return itemNotes.map(n => ({
        x:    (n.wallMs - latestWallMs) / 60_000,
        text: n.text,
    }));
}

function renderNotesPanel(itemName, panel) {
    const notes = loadNotes()[itemName] || [];
    const list  = panel.querySelector('.notes-list');
    list.innerHTML = notes.length === 0
        ? '<li class="note-empty">No notes yet</li>'
        : notes.map((n, i) => `
            <li class="note-item">
                <span class="note-text">${n.text}</span>
                <span class="note-date">${new Date(n.createdAt).toLocaleString()}</span>
                <button class="note-delete" data-idx="${i}">×</button>
            </li>`).join('');

    list.querySelectorAll('.note-delete').forEach(btn =>
        btn.addEventListener('click', () => {
            deleteNote(itemName, parseInt(btn.dataset.idx, 10));
            renderNotesPanel(itemName, panel);
        })
    );

    const input  = panel.querySelector('.note-input');
    const addBtn = panel.querySelector('.note-add-btn');
    const doAdd  = () => {
        const text = input.value.trim();
        if (!text) return;
        addNote(itemName, text);
        input.value = '';
        renderNotesPanel(itemName, panel);
    };
    addBtn.onclick    = doAdd;
    input.onkeydown   = (e) => { if (e.key === 'Enter') doAdd(); };
}

// ── Goals ──────────────────────────────────────────────────────────────────────
// Production targets stored in localStorage as { itemName → rate }.
// Click any bar in the Overview chart to set or clear a target.

const GOALS_KEY = 'second-shift-goals';
let goals       = {};

function loadGoals() {
    try { goals = JSON.parse(localStorage.getItem(GOALS_KEY) || '{}'); } catch { goals = {}; }
}
function saveGoals() { localStorage.setItem(GOALS_KEY, JSON.stringify(goals)); }

// ── Notifications ──────────────────────────────────────────────────────────────
// One browser Notification per item per deficit-severe transition.
// Global toggle stored in localStorage; permission is requested on first enable.

const NOTIF_KEY          = 'second-shift-notifications';
let notificationsEnabled = localStorage.getItem(NOTIF_KEY) !== 'false';
let severeItems          = new Set();

function requestNotifPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') return;
    Notification.requestPermission().then(perm => {
        if (perm !== 'granted') {
            notificationsEnabled = false;
            localStorage.setItem(NOTIF_KEY, 'false');
            document.getElementById('notif-toggle').classList.remove('active');
        }
    });
}

function checkDeficitAlerts(stats) {
    if (!notificationsEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
    const s = getStatsForPlanet(stats) || {};
    const nowSevere = new Set();
    for (const cat of ['items', 'fluids', 'electricity']) {
        for (const [name, item] of Object.entries(s[cat] || {})) {
            if (item.status === 'deficit-severe') nowSevere.add(name);
        }
    }
    for (const name of nowSevere) {
        if (!severeItems.has(name)) {
            let item = null;
            for (const cat of ['items', 'fluids', 'electricity']) {
                if (s[cat]?.[name]) { item = s[cat][name]; break; }
            }
            if (item) {
                new Notification(`Deficit: ${formatItemName(name)}`, {
                    body: `${item.producedPerMin.toLocaleString()}/min produced · ${item.consumedPerMin.toLocaleString()}/min consumed · net ${item.netPerMin.toLocaleString()}/min`,
                    tag:  `second-shift-deficit-${name}`,
                });
            }
        }
    }
    severeItems = nowSevere;
}

// ── URL state ──────────────────────────────────────────────────────────────────
// Hash format:
//   Overview: #overview/<category>/<planet>
//   Timeline: #timeline/<precision>/<planet>[/<item1,item2,...>]

function updateHash() {
    const parts = [activeView];
    if (activeView === 'overview') {
        parts.push(activeCategory, activePlanet);
    } else {
        parts.push(activePrecision, activePlanet);
        if (selectedItems.length > 0) parts.push(encodeURIComponent(selectedItems.join(',')));
    }
    history.replaceState(null, '', '#' + parts.join('/'));
}

function applyHash() {
    const hash = decodeURIComponent(location.hash.slice(1));
    if (!hash) return;
    const parts = hash.split('/');
    const view  = parts[0];
    if (view !== 'overview' && view !== 'timeline') return;

    if (view === 'overview') {
        const cat = parts[1];
        if (cat && ['items', 'fluids', 'electricity'].includes(cat)) {
            activeCategory = cat;
            document.querySelectorAll('.filter-btn[data-cat]').forEach(b =>
                b.classList.toggle('active', b.dataset.cat === activeCategory));
        }
        if (parts[2]) activePlanet = parts[2];
    } else {
        const prec = parts[1];
        if (prec && ['live', 'minute', 'hour'].includes(prec)) {
            activePrecision = prec;
            document.querySelectorAll('.filter-btn[data-precision]').forEach(b =>
                b.classList.toggle('active', b.dataset.precision === activePrecision));
            document.getElementById('live-window-wrap').classList.toggle('hidden', activePrecision !== 'live');
        }
        if (parts[2]) activePlanet = parts[2];
        if (parts[3]) {
            selectedItems = parts[3].split(',').filter(Boolean);
            renderSelectedTags();
        }
    }
    switchView(view);
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initBarChart();
    loadGoals();
    connect();
    setupItemSearch();

    // View switching
    document.querySelectorAll('.view-btn').forEach(btn =>
        btn.addEventListener('click', () => { switchView(btn.dataset.view); updateHash(); })
    );

    // Category filter (Overview)
    document.querySelectorAll('.filter-btn[data-cat]').forEach(btn =>
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn[data-cat]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeCategory = btn.dataset.cat;
            if (currentData) renderOverview(getStatsForPlanet(currentData));
            updateHash();
        })
    );

    document.getElementById('top-n').addEventListener('input',    () => { if (currentData) renderOverview(getStatsForPlanet(currentData)); });
    document.getElementById('sort-by').addEventListener('change', () => { if (currentData) renderOverview(getStatsForPlanet(currentData)); });

    // Precision filter (Timeline)
    document.querySelectorAll('.filter-btn[data-precision]').forEach(btn =>
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn[data-precision]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activePrecision = btn.dataset.precision;
            document.getElementById('live-window-wrap').classList.toggle('hidden', activePrecision !== 'live');
            loadTimelineHistory();
            updateHash();
        })
    );

    document.getElementById('live-window').addEventListener('input', (e) => {
        liveWindowMinutes = parseInt(e.target.value, 10) || 30;
        for (const name of selectedItems) updateCard(name);
        updateModal();
    });

    document.getElementById('chart-modal-backdrop').addEventListener('click', closeModal);
    document.getElementById('chart-modal-close').addEventListener('click', closeModal);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

    document.getElementById('timeline-cat').addEventListener('change', (e) => {
        timelineCat   = e.target.value;
        selectedItems = [];
        cardToggles.clear();
        for (const name of [...cardCharts.keys()]) destroyCard(name);
        renderSelectedTags();
        document.getElementById('timeline-empty').style.display = 'flex';
        loadTimelineHistory();
        updateHash();
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
        updateHash();
    });

    fetch('/api/games').then(r => r.json()).then(updateGamesList).catch(() => {});

    // Profiles
    renderProfileDropdown();
    document.getElementById('profile-select').addEventListener('change', loadSelectedProfile);
    document.getElementById('profile-save').addEventListener('click',   saveCurrentAsProfile);
    document.getElementById('profile-delete').addEventListener('click', deleteSelectedProfile);

    // Trigger backfill
    document.getElementById('trigger-backfill').addEventListener('click', async () => {
        try {
            const res  = await fetch('/api/trigger-backfill', { method: 'POST' });
            const data = await res.json();
            try {
                await navigator.clipboard.writeText(data.command);
                showToast('Copied! Paste in the Factorio console (press ~ to open it):\n' + data.command);
            } catch {
                showToast('Run this in the Factorio console (press ~ to open it):\n' + data.command, 8000);
            }
        } catch (err) {
            showToast('Could not reach server.');
        }
    });

    // Forget game
    document.getElementById('forget-game').addEventListener('click', async () => {
        if (!activeGameId) return;
        const label = activeGameId.slice(0, 8) + '…';
        if (!confirm(`Remove save "${label}" and all its history from the database?\nThis cannot be undone.`)) return;
        await fetch(`/api/games/${activeGameId}`, { method: 'DELETE' });
        // games_list WS message will arrive and refresh the selector
    });

    // Deficit notifications toggle
    const notifBtn = document.getElementById('notif-toggle');
    notifBtn.classList.toggle('active', notificationsEnabled);
    notifBtn.addEventListener('click', () => {
        notificationsEnabled = !notificationsEnabled;
        localStorage.setItem(NOTIF_KEY, String(notificationsEnabled));
        notifBtn.classList.toggle('active', notificationsEnabled);
        if (notificationsEnabled) requestNotifPermission();
    });

    // Item search: update hash after adding an item
    document.getElementById('item-suggestions').addEventListener('click', () => {
        // The actual add logic is in setupItemSearch; update hash on next tick after it runs
        setTimeout(updateHash, 0);
    });

    // URL hash: apply on load and on manual hash change
    applyHash();
    window.addEventListener('hashchange', () => applyHash());

    // Sidebar collapse toggle
    const sidebarCollapsed = localStorage.getItem('sidebar-collapsed') === 'true';
    if (sidebarCollapsed) document.getElementById('overview-view').classList.add('sidebar-collapsed');
    document.getElementById('sidebar-toggle').textContent = sidebarCollapsed ? '›' : '‹';
    document.getElementById('sidebar-toggle').addEventListener('click', () => {
        const view = document.getElementById('overview-view');
        const collapsed = view.classList.toggle('sidebar-collapsed');
        document.getElementById('sidebar-toggle').textContent = collapsed ? '›' : '‹';
        localStorage.setItem('sidebar-collapsed', collapsed);
    });

    // Export timeline data as CSV
    document.getElementById('export-csv').addEventListener('click', () => {
        if (!activeGameId) { showToast('No active game to export.'); return; }
        const url = `/api/export?gameId=${encodeURIComponent(activeGameId)}&precision=${activePrecision}`;
        const a   = document.createElement('a');
        a.href    = url;
        a.click();
    });
});
