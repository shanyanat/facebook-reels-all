'use strict';

const bg = msg => chrome.runtime.sendMessage(msg).catch(() => null);

async function refresh() {
    const state = await new Promise(resolve => {
        chrome.storage.local.get('reel_gen_state', r => {
            resolve(r['reel_gen_state'] || null);
        });
    });

    const statusMsg = document.getElementById('status-msg');
    const startBtn  = document.getElementById('start-btn');
    const stopBtn   = document.getElementById('stop-btn');
    const slotSel   = document.getElementById('slot-count');

    if (!state) {
        statusMsg.textContent = 'Extension initializing...';
        return;
    }

    statusMsg.textContent = state.running ? '● Running' : '○ Stopped';
    statusMsg.style.color = state.running ? '#1a73e8' : '#666';
    startBtn.style.display = state.running ? 'none' : '';
    stopBtn.style.display  = state.running ? '' : 'none';
    slotSel.disabled = state.running;

    // ── Slots ──────────────────────────────────────────────────────────────────
    const slotsDiv = document.getElementById('slots-container');
    slotsDiv.innerHTML = '';
    state.slots.forEach((slot, i) => {
        if (i >= state.maxSlots && slot.status === 'idle') return;
        const label = slot.projectId
            ? `Slot ${i + 1}: ${slot.projectId} [${slot.phase || 'done'}]`
            : `Slot ${i + 1}: idle`;
        const div = document.createElement('div');
        div.className = `slot ${slot.status}`;
        div.innerHTML = `
            <div class="slot-title">${label}</div>
            <div class="slot-prog">${slot.progress || ''}</div>
            ${slot.status === 'error'
                ? `<button class="reset" data-idx="${i}">Reset</button>`
                : ''}
            ${slot.status === 'running'
                ? `<button class="stop-slot" data-idx="${i}">⏹ Stop</button>`
                : ''}
        `;
        slotsDiv.appendChild(div);
    });

    slotsDiv.querySelectorAll('button.reset').forEach(btn => {
        btn.onclick = async () => {
            await bg({ action: 'resetSlot', idx: +btn.dataset.idx });
            setTimeout(refresh, 300);
        };
    });
    slotsDiv.querySelectorAll('button.stop-slot').forEach(btn => {
        btn.onclick = async () => {
            await bg({ action: 'stopSlot', idx: +btn.dataset.idx });
            setTimeout(refresh, 300);
        };
    });

    // ── Queue (with checkboxes) ────────────────────────────────────────────────
    const noMonitor = document.getElementById('no-monitor');
    const listDiv   = document.getElementById('projects-list');
    const selCount  = document.getElementById('sel-count');

    try {
        const res = await fetch('http://localhost:7788/contents.json',
            { signal: AbortSignal.timeout(3000) });
        const projects = await res.json();
        noMonitor.style.display = 'none';

        const selectedIds = state.selectedIds || [];
        const runningIds  = new Set(state.slots.filter(s => s.projectId).map(s => s.projectId));
        const SELECTABLE  = new Set(['pending', 'storyboard_done', 'images_done']);

        // Detect whether monitor.py has the new disk_status field (requires restart)
        const hasNewMonitor = projects.some(p => p.disk_status !== undefined);
        const staleMonitor  = document.getElementById('stale-monitor');
        staleMonitor.style.display = hasNewMonitor ? 'none' : '';

        const show = projects
            .filter(p => {
                const st = p.disk_status || p.project_status;
                if (st === 'archived') return false;
                // Ghost entry: pending with no brief file on disk.
                // brief_exists === false   → new monitor.py confirmed no brief
                // brief_exists === undefined → old monitor.py; still hide if
                //   project_status is pending (no files have ever been made)
                if (st === 'pending') {
                    if (p.brief_exists === false) return false;         // new monitor
                    if (p.brief_exists === undefined &&
                        p.project_status === 'pending') return false;   // old monitor fallback
                }
                return true;
            })
            .slice(0, 20);

        if (show.length) {
            listDiv.innerHTML = show.map(p => {
                const status    = p.disk_status || p.project_status;
                const isRunning = runningIds.has(p.id);
                const canSelect = SELECTABLE.has(status) && !isRunning;
                const isChecked = canSelect && selectedIds.includes(p.id);
                const phaseTag  = status === 'images_done'
                    ? '<span class="phase-tag">▶ videos</span>'
                    : status === 'storyboard_done'
                        ? '<span class="phase-tag">▶ scenes</span>'
                        : '';

                if (isRunning) {
                    const slotIdx = state.slots.findIndex(s => s.projectId === p.id);
                    return `<div class="project">
                      <span class="slot-tag">▶ slot ${slotIdx + 1}</span>
                      <span class="proj-id">${p.id}</span>
                      <span class="proj-page">${p.page}</span>
                      <span class="pill ${status}">${status.replace(/_/g,' ')}</span>
                    </div>`;
                }
                return `<div class="project">
                  ${canSelect
                    ? `<input type="checkbox" class="proj-check" data-id="${p.id}"${isChecked ? ' checked' : ''}>`
                    : `<span class="proj-nochk"></span>`}
                  <span class="proj-id">${p.id}${phaseTag}</span>
                  <span class="proj-page">${p.page}</span>
                  <span class="pill ${status}">${status.replace(/_/g,' ')}</span>
                </div>`;
            }).join('');
        } else {
            listDiv.innerHTML = '<div style="color:#999;font-size:11px;padding:4px 0">No active projects</div>';
        }

        // Selection count (queued, not yet running)
        const waitingCount = selectedIds.filter(id => !runningIds.has(id)).length;
        selCount.textContent = waitingCount ? `${waitingCount} queued` : '';

        // Wire checkbox changes → persist selectedIds
        listDiv.querySelectorAll('.proj-check').forEach(cb => {
            cb.onchange = async () => {
                const ids = [...listDiv.querySelectorAll('.proj-check:checked')]
                    .map(c => c.dataset.id);
                await bg({ action: 'setSelectedIds', ids });
                selCount.textContent = ids.length ? `${ids.length} queued` : '';
            };
        });

    } catch {
        noMonitor.style.display = '';
        listDiv.innerHTML = '';
        selCount.textContent = '';
    }
}

document.getElementById('start-btn').onclick = async () => {
    const maxSlots = +document.getElementById('slot-count').value;
    await bg({ action: 'start', maxSlots });
    setTimeout(refresh, 400);
};

document.getElementById('stop-btn').onclick = async () => {
    await bg({ action: 'stop' });
    setTimeout(refresh, 400);
};

document.getElementById('refresh-btn').onclick = () => refresh();

// Live updates from background
chrome.runtime.onMessage.addListener(msg => {
    if (msg.action === 'stateUpdate') refresh();
});

// Storage change listener for when popup is already open
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['reel_gen_state']) refresh();
});

refresh();
setInterval(refresh, 4000);
