'use strict';

const bg = msg => chrome.runtime.sendMessage(msg).catch(() => null);

const SELECTABLE = new Set([
    'pending', 'storyboard_done', 'images_done',
    'videos_in_progress', 'videos_partial'
]);

const ARCHIVABLE = new Set(['videos_done', 'videos_in_progress']);

// Count how many scenes are done from DISK TRUTH (img_on_disk / vdo_on_disk, served
// by monitor.py), falling back to contents.json flags only for an old monitor that
// doesn't send those fields. This makes the X/Y count drop correctly when the user
// deletes files from working/ or the reel folder — the image_status/video_status
// flags are NOT cleared by a delete, so counting them left the number stale.
function countDone(scenes, kind) {
    const arr = scenes || [];
    const diskKey = kind === 'img' ? 'img_on_disk' : 'vdo_on_disk';
    const flagKey = kind === 'img' ? 'image_status' : 'video_status';
    const hasDisk = arr.some(s => s[diskKey] !== undefined);
    return arr.filter(s => hasDisk ? !!s[diskKey] : s[flagKey] === 'done').length;
}

let _toastTimer;
function showToast(msg, type = '') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast' + (type ? ' ' + type : '');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

// ── Slot toggle buttons ───────────────────────────────────────────────────────

function getActiveSlots() {
    const active = document.querySelector('.slot-btn.active');
    return active ? +active.dataset.slots : 2;
}

function setActiveSlots(n) {
    document.querySelectorAll('.slot-btn').forEach(btn => {
        btn.classList.toggle('active', +btn.dataset.slots === n);
    });
}

document.querySelectorAll('.slot-btn').forEach(btn => {
    btn.onclick = () => {
        if (btn.disabled) return;
        setActiveSlots(+btn.dataset.slots);
    };
});

// ── Render helpers ────────────────────────────────────────────────────────────

function renderSlots(state) {
    const container = document.getElementById('slots-container');
    container.innerHTML = '';

    // Circuit-breaker pause banner — shown when too many reels failed in a row.
    if (state.pausedReason) {
        const banner = document.createElement('div');
        banner.className = 'pause-banner';
        banner.textContent = '⏸ ' + state.pausedReason;
        container.appendChild(banner);
    }

    // Recent failures — since an errored slot now refills automatically, this is
    // where you see which reels failed (and why) so you can re-tick them.
    if (state.recentErrors && state.recentErrors.length) {
        const box = document.createElement('div');
        box.className = 'recent-errors';
        const items = state.recentErrors.slice(0, 5).map(e =>
            `<div class="recent-error-line">⚠ ${(e.id || '?')}: ${
                String(e.message || 'error').replace(/</g,'&lt;').slice(0, 80)}</div>`
        ).join('');
        box.innerHTML = `<div class="recent-errors-head">Recent failures (re-tick to retry)</div>${items}`;
        container.appendChild(box);
    }

    for (let i = 0; i < state.maxSlots; i++) {
        const slot = state.slots[i];
        const card = document.createElement('div');
        card.className = 'slot-card' +
            (slot.status === 'running' ? ' running' :
             slot.status === 'error'   ? ' error'   :
             slot.status === 'done'    ? ' done'     : '');

        if (slot.status === 'running') {
            const phaseLabel = slot.phase === 'videos' ? 'videos' : 'images';
            const lines = (slot.logLines || []).slice(-10);
            const logsHtml = lines.length
                ? `<div class="slot-logs">${lines.map(l =>
                    `<span class="slot-log-line">${l.replace(/</g,'&lt;')}</span>`
                  ).join('')}</div>`
                : '';
            const stallHtml = slot.stalled
                ? '<div class="stall-badge">⚠ No activity 5 min+ — may be throttled by Chrome</div>'
                : '';
            card.innerHTML = `
              <div class="slot-row">
                <div class="globe">🌐</div>
                <div class="slot-info">
                  <div class="slot-name">${slot.projectId || '…'}
                    <span class="slot-phase">${phaseLabel}</span>
                  </div>
                  <div class="slot-prog">${slot.progress || 'Working…'}</div>
                </div>
                <button class="btn-sm btn-stop-sm" data-idx="${i}">Stop</button>
              </div>${logsHtml}${stallHtml}`;
        } else if (slot.status === 'error') {
            card.innerHTML = `
              <div class="slot-row">
                <div class="slot-info">
                  <div class="slot-name">${slot.projectId || 'Slot ' + (i + 1)}</div>
                  <div class="slot-prog">${slot.progress || 'Error'}</div>
                </div>
                <button class="btn-sm btn-reset-sm" data-idx="${i}">Reset</button>
              </div>`;
        } else if (slot.status === 'done') {
            card.innerHTML = `
              <div class="slot-row">
                <div class="slot-info">
                  <div class="slot-name">${slot.projectId || ''}</div>
                  <div class="slot-prog">${slot.progress || '✓ Complete'}</div>
                </div>
                <button class="btn-sm btn-reset-sm" data-idx="${i}">Clear</button>
              </div>`;
        } else {
            card.innerHTML = `
              <div class="slot-row">
                <span class="slot-idle">Slot ${i + 1} — idle</span>
              </div>`;
        }

        container.appendChild(card);
    }

    container.querySelectorAll('.btn-stop-sm').forEach(btn => {
        btn.onclick = async () => {
            await bg({ action: 'stopSlot', idx: +btn.dataset.idx });
            await refresh();
        };
    });
    container.querySelectorAll('.btn-reset-sm').forEach(btn => {
        btn.onclick = async () => {
            await bg({ action: 'resetSlot', idx: +btn.dataset.idx });
            await refresh();
        };
    });
}

async function renderQueue(state) {
    const noMonitor    = document.getElementById('no-monitor');
    const staleMonitor = document.getElementById('stale-monitor');
    const listDiv      = document.getElementById('projects-list');
    const selCount     = document.getElementById('sel-count');

    let projects;
    try {
        const res = await fetch('http://localhost:7788/contents.json',
            { signal: AbortSignal.timeout(3000) });
        projects = await res.json();
        noMonitor.style.display = 'none';
    } catch {
        noMonitor.style.display = '';
        staleMonitor.style.display = 'none';
        listDiv.innerHTML = '<div class="empty-msg">monitor.py not reachable</div>';
        selCount.textContent = '';
        return;
    }

    // Only warn if there ARE projects and none has disk_status (old monitor.py without the field)
    const hasNewMonitor = projects.length === 0 || projects.some(p => p.disk_status !== undefined);
    staleMonitor.style.display = hasNewMonitor ? 'none' : '';

    const selectedIds = state.selectedIds || [];
    const runningIds  = new Set(state.slots.filter(s => s.projectId).map(s => s.projectId));

    const show = projects.filter(p => {
        const st = p.disk_status || p.project_status;
        if (st === 'archived' || st === 'collected') return false;
        if (st === 'pending') {
            if (p.brief_exists === false) return false;
            if (p.brief_exists === undefined && p.project_status === 'pending') return false;
        }
        return true;
    }).slice(0, 30);

    if (!show.length) {
        listDiv.innerHTML = '<div class="empty-msg">No active projects</div>';
        selCount.textContent = '';
        return;
    }

    listDiv.innerHTML = show.map(p => {
        const status    = p.disk_status || p.project_status;
        const isRunning = runningIds.has(p.id);
        // Selectable even while a run is active, so you can top up / restart reels
        // mid-run without stopping the others (the freed/idle slots pick them up).
        // Still not selectable if THIS reel is the one currently in a slot.
        const canSelect = SELECTABLE.has(status) && !isRunning;
        const isChecked = selectedIds.includes(p.id);
        const pillText  = status.replace(/_/g, ' ');

        const total      = p.total_scenes || 0;
        const imgDone    = countDone(p.scenes, 'img');
        const vidDone    = countDone(p.scenes, 'vid');
        const inVideoPhase = ['images_done','videos_in_progress','videos_partial','videos_done','complete'].includes(status);
        const countHtml  = total > 0
            ? `<span class="proj-count">${inVideoPhase ? vidDone : imgDone}/${total}</span>`
            : '';

        const canArchive = ARCHIVABLE.has(status) && !isRunning;

        if (isRunning) {
            const slotIdx = state.slots.findIndex(s => s.projectId === p.id);
            return `<div class="proj-row">
              <span class="proj-nochk"></span>
              <span class="proj-id">${p.id}</span>
              <span class="proj-page">${p.page || ''}</span>
              ${countHtml}
              <span class="running-tag">▶ slot ${slotIdx + 1}</span>
              <span class="pill ${status}">${pillText}</span>
            </div>`;
        }

        return `<div class="proj-row">
          ${canSelect
            ? `<input type="checkbox" class="proj-check" data-id="${p.id}"${isChecked ? ' checked' : ''}>`
            : `<span class="proj-nochk"></span>`}
          <span class="proj-id">${p.id}</span>
          <span class="proj-page">${p.page || ''}</span>
          ${countHtml}
          ${canArchive ? `<button class="btn-archive" data-id="${p.id}">Archive</button>` : ''}
          <span class="pill ${status}">${pillText}</span>
        </div>`;
    }).join('');

    const waitingCount = selectedIds.filter(id => !runningIds.has(id)).length;
    selCount.innerHTML = waitingCount
        ? `<span class="sel-badge">${waitingCount} queued</span>`
        : '';

    listDiv.querySelectorAll('.proj-check').forEach(cb => {
        cb.onchange = async () => {
            const ids = [...listDiv.querySelectorAll('.proj-check:checked')]
                .map(c => c.dataset.id);
            await bg({ action: 'setSelectedIds', ids });
            const waiting = ids.filter(id => !runningIds.has(id)).length;
            selCount.innerHTML = waiting
                ? `<span class="sel-badge">${waiting} queued</span>`
                : '';
        };
    });

    listDiv.querySelectorAll('.btn-archive').forEach(btn => {
        btn.onclick = async () => {
            const id = btn.dataset.id;
            btn.disabled = true;
            btn.textContent = '…';
            try {
                const res = await fetch('http://localhost:7788/api/archive', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id }),
                    signal: AbortSignal.timeout(15000)
                });
                const json = await res.json();
                if (json.ok) {
                    showToast(`✓ ${id} archived`, 'success');
                    await refresh();
                } else {
                    showToast(`✗ ${json.error || 'Archive failed'}`, 'error');
                    btn.disabled = false;
                    btn.textContent = 'Archive';
                }
            } catch {
                showToast('✗ monitor.py not reachable', 'error');
                btn.disabled = false;
                btn.textContent = 'Archive';
            }
        };
    });
}

// ── Main refresh ──────────────────────────────────────────────────────────────

let refreshing = false;

async function refresh() {
    const state = await new Promise(resolve => {
        chrome.storage.local.get('reel_gen_state', r => {
            resolve(r['reel_gen_state'] || null);
        });
    });

    const statusDot  = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const startBtn   = document.getElementById('start-btn');
    const stopBtn    = document.getElementById('stop-btn');

    if (!state) {
        statusText.textContent = 'Initializing…';
        return;
    }

    // Header status
    if (state.running) {
        statusDot.classList.add('running');
        statusText.textContent = 'Running';
    } else {
        statusDot.classList.remove('running');
        statusText.textContent = 'Stopped';
    }

    // Start / Stop visibility
    startBtn.style.display = state.running ? 'none' : '';
    stopBtn.style.display  = state.running ? ''     : 'none';

    // Slot toggle buttons: reflect saved maxSlots; disable while running
    setActiveSlots(state.maxSlots || 2);
    document.querySelectorAll('.slot-btn').forEach(btn => {
        btn.disabled = state.running;
    });

    renderSlots(state);
    await renderQueue(state);
}

// ── Controls ──────────────────────────────────────────────────────────────────

document.getElementById('start-btn').onclick = async () => {
    const btn = document.getElementById('start-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Starting…';
    await bg({ action: 'start', maxSlots: getActiveSlots() });
    await refresh();
};

document.getElementById('stop-btn').onclick = async () => {
    const btn = document.getElementById('stop-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Stopping…';
    await bg({ action: 'stop' });
    await refresh();
};

document.getElementById('refresh-btn').onclick = async () => {
    const btn = document.getElementById('refresh-btn');
    btn.classList.add('spinning');
    await refresh();
    // Remove class after animation completes (0.6s)
    setTimeout(() => btn.classList.remove('spinning'), 650);
};

// ── Status modal ──────────────────────────────────────────────────────────────

document.getElementById('status-btn').onclick = async () => {
    const modal = document.getElementById('status-modal');
    const tbody = document.getElementById('status-tbody');
    const footer = document.getElementById('status-footer');
    const delCountEl = document.getElementById('status-del-count');
    const delBtn = document.getElementById('delete-sel-btn');
    let selectedForDelete = new Set();

    function updateFooter() {
        const n = selectedForDelete.size;
        if (n > 0) {
            footer.style.display = '';
            delCountEl.textContent = `${n} project${n > 1 ? 's' : ''} selected`;
        } else {
            footer.style.display = 'none';
        }
    }

    modal.classList.add('open');
    footer.style.display = 'none';
    selectedForDelete.clear();
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;color:#9aa0a6">Loading…</td></tr>';

    async function loadStatus() {
        try {
            const res = await fetch('http://localhost:7788/contents.json',
                { signal: AbortSignal.timeout(4000) });
            const projects = await res.json();
            if (!projects.length) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;color:#9aa0a6">No projects found</td></tr>';
                return;
            }
            tbody.innerHTML = projects.map(p => {
                const st = p.disk_status || p.project_status || 'pending';
                const total = p.total_scenes || 0;
                const imgDone = countDone(p.scenes, 'img');
                const vidDone = countDone(p.scenes, 'vid');
                const chk = selectedForDelete.has(p.id) ? ' checked' : '';
                return `<tr>
                  <td style="text-align:center;padding-left:10px">
                    <input type="checkbox" class="status-check" data-id="${p.id}"${chk}
                      style="width:13px;height:13px;cursor:pointer;accent-color:#d93025">
                  </td>
                  <td class="status-id">${p.id}</td>
                  <td class="status-page">${p.page || '—'}</td>
                  <td><span class="pill ${st}">${st.replace(/_/g, ' ')}</span></td>
                  <td class="status-count">${imgDone}/${total}</td>
                  <td class="status-count">${vidDone}/${total}</td>
                </tr>`;
            }).join('');

            tbody.querySelectorAll('.status-check').forEach(cb => {
                cb.onchange = () => {
                    if (cb.checked) selectedForDelete.add(cb.dataset.id);
                    else selectedForDelete.delete(cb.dataset.id);
                    updateFooter();
                };
            });
        } catch {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;color:#c5221f">monitor.py not reachable</td></tr>';
        }
    }

    await loadStatus();

    delBtn.onclick = async () => {
        if (!selectedForDelete.size) return;
        const ids = [...selectedForDelete];
        if (!confirm(`Permanently delete ${ids.length} project(s) from contents.json?\n\n${ids.join(', ')}\n\nThis cannot be undone.`)) return;
        delBtn.disabled = true;
        delBtn.textContent = '⏳ Deleting…';
        try {
            const res = await fetch('http://localhost:7788/api/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids }),
                signal: AbortSignal.timeout(8000)
            });
            const json = await res.json();
            if (json.ok) {
                showToast(`✓ ${json.output || 'Deleted'}`, 'success');
                selectedForDelete.clear();
                updateFooter();
                await loadStatus();
            } else {
                showToast(`✗ ${json.error || 'Delete failed'}`, 'error');
            }
        } catch {
            showToast('✗ monitor.py not reachable', 'error');
        } finally {
            delBtn.disabled = false;
            delBtn.textContent = '🗑 Delete Selected';
        }
    };
};

document.getElementById('modal-close-btn').onclick = () => {
    document.getElementById('status-modal').classList.remove('open');
    document.getElementById('status-footer').style.display = 'none';
};
document.getElementById('status-modal').onclick = e => {
    if (e.target === e.currentTarget) {
        document.getElementById('status-modal').classList.remove('open');
        document.getElementById('status-footer').style.display = 'none';
    }
};

// ── Collect ───────────────────────────────────────────────────────────────────

document.getElementById('collect-btn').onclick = async () => {
    const btn = document.getElementById('collect-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Collecting…';
    try {
        const res = await fetch('http://localhost:7788/api/collect', {
            method: 'POST',
            signal: AbortSignal.timeout(15000)
        });
        const json = await res.json();
        if (json.ok) {
            const lines = (json.output || '').split('\n').filter(Boolean);
            const summary = lines.find(l => l.includes('reel folder')) || lines.slice(-1)[0] || 'Done';
            showToast(`✓ ${summary}`, 'success');
            await refresh();
        } else {
            showToast(`✗ ${json.error || 'Collect failed'}`, 'error');
        }
    } catch {
        showToast('✗ monitor.py not reachable', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '📦 Collect';
    }
};

// ── Live updates ──────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(msg => {
    if (msg.action === 'stateUpdate') refresh();
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['reel_gen_state']) refresh();
});

// Initial load + polling fallback
refresh();
setInterval(refresh, 4000);
