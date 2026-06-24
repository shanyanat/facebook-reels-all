'use strict';

// Open side panel when user clicks the extension icon
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const API = 'http://localhost:7788';
const STORAGE_KEY = 'reel_gen_state';
const MAX_SLOT_COUNT = 5;
// Circuit breaker: if this many slots error in a row WITHOUT any reel succeeding
// in between, stop auto-refilling and pause the run. This stops a "tab-churn" loop
// where a systemic problem (ChatGPT rate limit / logged out) makes every refilled
// tab fail too, silently draining the whole selection. Any success resets the count.
const ERROR_BREAKER_THRESHOLD = 3;

// ── Desktop notification when a reel finishes ──────────────────────────────────
// Fires only when every scene video is confirmed on disk (a truly finished reel),
// so the user can leave the slots running in background tabs and be told when one
// is done. Best-effort: wrapped so a notification failure can never break the
// pipeline. Requires the "notifications" permission in manifest.json.
function notifyReelFinished(projectId, page, sceneCount) {
    try {
        const where = page ? ` (${page})` : '';
        const count = sceneCount ? `all ${sceneCount} scene videos` : 'all scene videos';
        chrome.notifications.create('reel-done-' + projectId + '-' + Date.now(), {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon128.png'),
            title: '✓ Reel finished',
            message: `${projectId}${where} — ${count} done.`,
            priority: 2
        }, () => { void chrome.runtime.lastError; /* ignore — fire and forget */ });
    } catch (e) {
        console.warn('[bg] notifyReelFinished failed:', e);
    }
}

// ── State helpers ─────────────────────────────────────────────────────────────

function freshSlot(idx) {
    return { idx, status: 'idle', projectId: null, tabId: null, phase: null, progress: '', stopping: false, logLines: [], lastProgressAt: null, stalled: false };
}

function defaultState() {
    return {
        running: false,
        maxSlots: 2,
        slots: Array.from({ length: MAX_SLOT_COUNT }, (_, i) => freshSlot(i)),
        selectedIds: [],
        consecutiveErrors: 0,   // reset by any success; trips the circuit breaker
        recentErrors: [],       // [{id, message, at}] — kept so the UI can show failures
        pausedReason: ''        // set when the breaker pauses the run; '' otherwise
    };
}

async function loadState() {
    const r = await chrome.storage.local.get(STORAGE_KEY);
    const state = r[STORAGE_KEY] || defaultState();
    // Backfill fields added after a user's state was first saved.
    if (typeof state.consecutiveErrors !== 'number') state.consecutiveErrors = 0;
    if (!Array.isArray(state.recentErrors)) state.recentErrors = [];
    if (typeof state.pausedReason !== 'string') state.pausedReason = '';
    if (state.slots.length < MAX_SLOT_COUNT) {
        while (state.slots.length < MAX_SLOT_COUNT) {
            state.slots.push(freshSlot(state.slots.length));
        }
        await chrome.storage.local.set({ [STORAGE_KEY]: state });
    }
    return state;
}

async function saveState(state) {
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
    chrome.runtime.sendMessage({ action: 'stateUpdate', state }).catch(() => {});
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function fetchContents() {
    const res = await fetch(`${API}/contents.json`);
    if (!res.ok) throw new Error(`contents fetch failed: ${res.status}`);
    return res.json();
}

async function patchProject(id, fields) {
    await fetch(`${API}/patch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...fields })
    });
}

// ── Slot management ───────────────────────────────────────────────────────────

let _fillingSlotsInProgress = false;

async function fillIdleSlots(state) {
    if (!state.running) return;
    if (_fillingSlotsInProgress) {
        console.log('[bg] fillIdleSlots: skipping concurrent call');
        return;
    }
    _fillingSlotsInProgress = true;
    try {
        await _fillIdleSlotsInner(state);
    } finally {
        _fillingSlotsInProgress = false;
    }
}

async function _fillIdleSlotsInner(state) {
    if (!state.running) return;

    let projects;
    try { projects = await fetchContents(); }
    catch (e) { console.error('[bg] fetchContents failed:', e); return; }

    const assignedIds = new Set(
        state.slots.filter(s => s.projectId).map(s => s.projectId)
    );
    // Only run reels the user explicitly selected
    // Use disk_status (added by monitor.py) if available, fall back to project_status
    const selectedIds = state.selectedIds || [];
    const eligible = projects.filter(p => {
        const st = p.disk_status || p.project_status;
        return (st === 'pending' || st === 'storyboard_done' || st === 'images_done' ||
                st === 'videos_in_progress' || st === 'videos_partial') &&
               selectedIds.includes(p.id) &&
               !assignedIds.has(p.id);
    });

    for (let i = 0; i < state.maxSlots; i++) {
        if (state.slots[i].status !== 'idle') continue;
        if (!eligible.length) break;

        // Pick next project whose brief file still exists on disk
        let project = null;
        while (eligible.length) {
            const candidate = eligible.shift();
            try {
                const briefRes = await fetch(
                    `${API}/file/pages/${candidate.page}/briefs/${candidate.source_txt}`
                );
                if (briefRes.ok) { project = candidate; break; }
                console.warn(`[bg] Skipping ${candidate.id}: brief file not found`);
                state.selectedIds = (state.selectedIds || []).filter(id => id !== candidate.id);
            } catch {
                console.warn(`[bg] Skipping ${candidate.id}: brief check failed`);
            }
        }
        if (!project) break;

        const slot = state.slots[i];
        slot.projectId = project.id;
        slot.status = 'running';

        // Determine phase from disk_status (more accurate than project_status)
        const effectiveStatus = project.disk_status || project.project_status;
        console.log(`[bg] slot[${i}] ← ${project.id} (${effectiveStatus})`);
        const videosOnly    = effectiveStatus === 'images_done' ||
                              effectiveStatus === 'videos_in_progress' ||
                              effectiveStatus === 'videos_partial';
        const scenesOnly    = effectiveStatus === 'storyboard_done'; // Phase A already done
        slot.phase    = videosOnly ? 'videos' : 'images';
        slot.progress = videosOnly ? 'Opening Google Flow...' : 'Opening ChatGPT...';

        // Remove from selection queue now that it is assigned
        state.selectedIds = (state.selectedIds || []).filter(id => id !== project.id);
        await saveState(state);

        const tabUrl = videosOnly ? 'https://labs.google/fx/th/tools/flow' : 'https://chatgpt.com/';
        const tab = await chrome.tabs.create({ url: tabUrl, active: false });
        // Stop Chrome's Memory Saver from freezing/discarding this background tab —
        // a discarded tab's automation loop stalls (only the visible tab keeps running).
        chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
        slot.tabId = tab.id;
        await saveState(state);
    }
}

// ── Message handler ───────────────────────────────────────────────────────────

// ── fillSlate: run Slate manipulation in the page's MAIN world ───────────────
// Content scripts run in an isolated world and cannot access React fiber or
// Slate internals. chrome.scripting.executeScript with world:'MAIN' can.
// It calls editor.insertText() directly — no DOM hacks, no selectionchange crash.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action !== 'fillSlate') return false; // let next listener handle other msgs
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false, error: 'no tabId' }); return true; }

    chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (text) => {
            try {
                const editorEl = document.querySelector('[data-slate-editor="true"]');
                if (!editorEl) return 'no-editor';

                const fk = Object.keys(editorEl).find(k => k.startsWith('__reactFiber'));
                if (!fk) return 'no-fiber';

                let editor = null;
                let f = editorEl[fk];
                while (f) {
                    const p = f.memoizedProps;
                    if (p && p.editor && typeof p.editor.insertText === 'function') {
                        editor = p.editor;
                        break;
                    }
                    f = f.return;
                }
                if (!editor) return 'no-slate-editor';

                function getFirstLeaf(node, path) {
                    if (!node.children) return { path, offset: 0 };
                    return getFirstLeaf(node.children[0], [...path, 0]);
                }
                function getLastLeaf(node, path) {
                    if (!node.children) return { path, offset: (node.text || '').length };
                    const i = node.children.length - 1;
                    return getLastLeaf(node.children[i], [...path, i]);
                }

                const doc = { children: editor.children };
                const start = getFirstLeaf(doc, []);
                const end   = getLastLeaf(doc, []);

                // Select the entire document, then insertText replaces selection
                editor.apply({
                    type: 'set_selection',
                    properties: editor.selection,
                    newProperties: {
                        anchor: { path: start.path, offset: 0 },
                        focus:  { path: end.path,   offset: end.offset }
                    }
                });
                editor.insertText(text);

                return 'ok:' + (editorEl.textContent || '').trim().length;
            } catch (e) {
                return 'error:' + e.message;
            }
        },
        args: [msg.text]
    }).then(results => {
        const result = results[0]?.result || 'no-result';
        sendResponse({ ok: String(result).startsWith('ok:'), result });
    }).catch(e => {
        sendResponse({ ok: false, error: e.message });
    });
    return true; // async
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action !== 'clickGenerateSlate') return false;
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false, error: 'no tabId' }); return true; }

    chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (vhFraction) => {
            try {
                const vh = window.innerHeight;
                const btns = [...document.querySelectorAll('button')].filter(btn => {
                    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
                    const r = btn.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0 || r.top < vh * vhFraction) return false;
                    const t = (btn.textContent || '').trim();
                    return ['arrow_forward', 'สร้าง', 'ส่ง'].some(k => t.includes(k));
                });
                if (!btns.length) return 'no-button';
                btns.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
                const btn = btns[0];
                const label = (btn.textContent || '').trim().substring(0, 20);

                // Approach 1: walk React fiber tree and call onClick prop directly.
                // This bypasses DOM event dispatch entirely — no isTrusted issue.
                const fk = Object.keys(btn).find(k => k.startsWith('__reactFiber'));
                if (fk) {
                    let f = btn[fk];
                    while (f) {
                        const p = f.memoizedProps;
                        if (p && typeof p.onClick === 'function') {
                            p.onClick({
                                preventDefault()  {},
                                stopPropagation() {},
                                isPropagationStopped() { return false; },
                                isDefaultPrevented()   { return false; },
                                type: 'click',
                                button: 0,
                                bubbles: true,
                                cancelable: true,
                                target: btn,
                                currentTarget: btn,
                                nativeEvent: { isTrusted: true, type: 'click', button: 0 }
                            });
                            return 'fiber-onclick:' + label;
                        }
                        f = f.return;
                    }
                }

                // Approach 2: plain DOM click as fallback
                btn.click();
                return 'dom-click:' + label;
            } catch (e) {
                return 'error:' + e.message;
            }
        },
        args: [0.3]
    }).then(results => {
        const result = results[0]?.result || 'no-result';
        sendResponse({ ok: result.startsWith('fiber-onclick:') || result.startsWith('dom-click:'), result });
    }).catch(e => {
        sendResponse({ ok: false, error: e.message });
    });
    return true; // async
});

// Injects a file into ChatGPT's React file input.
// Fetches the file in the service worker (not subject to page CSP), encodes to base64,
// then passes to MAIN world executeScript which decodes and calls React onChange.
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    if (msg.action !== 'injectFileUpload') return false;
    var tabId = sender.tab && sender.tab.id;
    if (!tabId) { sendResponse({ ok: false, error: 'no tabId' }); return true; }

    (async function() {
        try {
            // Convert Windows backslashes to forward slashes before building URL
            var safePath = msg.path.replace(/\\/g, '/');
            var url = 'http://localhost:7788/file/' + encodeURI(safePath);
            var response, lastFetchErr;
            for (var attempt = 0; attempt < 3; attempt++) {
                try {
                    response = await fetch(url);
                    lastFetchErr = null;
                    break;
                } catch (fe) {
                    lastFetchErr = fe;
                    if (attempt < 2) await new Promise(function(r) { setTimeout(r, 800); });
                }
            }
            if (lastFetchErr) throw lastFetchErr;
            if (!response.ok) {
                sendResponse({ ok: false, result: 'fetch-error:' + response.status + ':' + msg.filename });
                return;
            }
            var buf = await response.arrayBuffer();
            var bytes = new Uint8Array(buf);
            var CHUNK = 8192;
            var s = '';
            for (var i = 0; i < bytes.length; i += CHUNK) {
                s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
            }
            var base64 = btoa(s);

            var results = await chrome.scripting.executeScript({
                target: { tabId: tabId },
                world: 'MAIN',
                func: function(b64, filename) {
                    try {
                        var s = atob(b64);
                        var bytes = new Uint8Array(s.length);
                        for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
                        var file = new File([bytes], filename, { type: 'image/png' });

                        var input = document.querySelector(
                            "input[data-testid='upload-photos-input'], input[type='file']"
                        );
                        if (!input) return 'no-input:' + filename;

                        var nativeSetter = Object.getOwnPropertyDescriptor(
                            HTMLInputElement.prototype, 'files'
                        ).set;
                        var dt = new DataTransfer();
                        dt.items.add(file);
                        nativeSetter.call(input, dt.files);

                        var fk = Object.keys(input).find(function(k) {
                            return k.indexOf('__reactFiber') === 0;
                        });
                        if (fk) {
                            var fiber = input[fk];
                            var depth = 0;
                            while (fiber && depth < 60) {
                                if (fiber.memoizedProps && typeof fiber.memoizedProps.onChange === 'function') {
                                    fiber.memoizedProps.onChange({
                                        persist:              function() {},
                                        preventDefault:       function() {},
                                        stopPropagation:      function() {},
                                        isPropagationStopped: function() { return false; },
                                        isDefaultPrevented:   function() { return false; },
                                        type: 'change', bubbles: true, cancelable: true,
                                        target: input, currentTarget: input,
                                        nativeEvent: { isTrusted: true, type: 'change', target: input }
                                    });
                                    return 'fiber:' + filename + ':' + file.size;
                                }
                                fiber = fiber.return;
                                depth++;
                            }
                        }

                        var pk = Object.keys(input).find(function(k) {
                            return k.indexOf('__reactProps') === 0;
                        });
                        if (pk && input[pk] && typeof input[pk].onChange === 'function') {
                            input[pk].onChange({
                                persist:              function() {},
                                preventDefault:       function() {},
                                stopPropagation:      function() {},
                                isPropagationStopped: function() { return false; },
                                isDefaultPrevented:   function() { return false; },
                                type: 'change', bubbles: true, cancelable: true,
                                target: input, currentTarget: input,
                                nativeEvent: { isTrusted: true, type: 'change', target: input }
                            });
                            return 'props:' + filename + ':' + file.size;
                        }

                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        input.dispatchEvent(new Event('input',  { bubbles: true }));
                        return 'dom-events:' + filename;
                    } catch (e) {
                        return 'error:' + e.message;
                    }
                },
                args: [base64, msg.filename]
            });

            var result = (results[0] && results[0].result) || 'no-result';
            var ok = result.indexOf('fiber:') === 0 || result.indexOf('props:') === 0;
            sendResponse({ ok: ok, result: result });
        } catch (e) {
            sendResponse({ ok: false, error: e.message });
        }
    })();
    return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'fillSlate' || msg.action === 'clickGenerateSlate' || msg.action === 'injectFileUpload') return false; // handled by dedicated listeners above
    (async () => {
        try {
            await handleMessage(msg, sender);
            sendResponse({ ok: true });
        } catch (e) {
            console.error('[bg] handleMessage error:', e);
            sendResponse({ error: String(e) });
        }
    })();
    return true;
});

async function handleMessage(msg, sender) {
    const tabId = sender.tab?.id;

    // ── Popup ─────────────────────────────────────────────────────────────────
    if (msg.action === 'getState') {
        const state = await loadState();
        return chrome.runtime.sendMessage({ action: 'stateUpdate', state }).catch(() => state);
    }

    if (msg.action === 'start') {
        const state = await loadState();
        state.running = true;
        state.consecutiveErrors = 0;   // fresh start clears the breaker + pause banner
        state.pausedReason = '';
        if (msg.maxSlots) state.maxSlots = Math.min(msg.maxSlots, MAX_SLOT_COUNT);
        await saveState(state);
        await fillIdleSlots(state);
        return;
    }

    if (msg.action === 'stop') {
        const state = await loadState();
        state.running = false;
        await saveState(state);
        return;
    }

    if (msg.action === 'resetSlot') {
        const state = await loadState();
        if (state.slots[msg.idx]) {
            Object.assign(state.slots[msg.idx], freshSlot(msg.idx));
            await saveState(state);
        }
        return;
    }

    if (msg.action === 'setSelectedIds') {
        const state = await loadState();
        state.selectedIds = msg.ids || [];
        await saveState(state);
        // If a run is active, newly ticked reels should start in any free slot right
        // away instead of waiting for the ~24s heartbeat — this is what lets you
        // top up / restart reels mid-run without stopping the others.
        if (state.running) await fillIdleSlots(state);
        return;
    }

    if (msg.action === 'stopSlot') {
        const state = await loadState();
        const slot = state.slots[msg.idx];
        if (slot && slot.status !== 'idle') {
            if (slot.tabId) {
                try { await chrome.tabs.remove(slot.tabId); } catch {}
            }
            Object.assign(slot, freshSlot(slot.idx));
            await saveState(state);
            if (state.running) await fillIdleSlots(state);
        }
        return;
    }

    // ── Content scripts ───────────────────────────────────────────────────────
    if (msg.action === 'tabReady') {
        if (!tabId) return;
        const state = await loadState();
        const slot = state.slots.find(s => s.tabId === tabId);
        if (!slot || slot.status !== 'running') return;

        let projects;
        try { projects = await fetchContents(); } catch { return; }
        const project = projects.find(p => p.id === slot.projectId);
        if (!project) {
            console.error(`[bg] tabReady tab=${tabId}: slot.projectId=${slot.projectId} not found in contents.json`);
            return;
        }

        // Pass effective status so chatgpt.js can skip Phase A when storyboard already exists
        const effectiveSt = project.disk_status || project.project_status;
        const start = slot.phase === 'images'
            ? { action: 'startImages', project, resumeFrom: effectiveSt }
            : { action: 'startVideos', project };

        console.log(`[bg] tabReady tab=${tabId} → slot[${slot.idx}] ${slot.phase} project=${project.id}`);

        chrome.tabs.sendMessage(tabId, start).catch(e =>
            console.error(`[bg] sendMessage to tab ${tabId} failed:`, e)
        );
        return;
    }

    if (msg.action === 'progress') {
        const state = await loadState();
        const slot = state.slots.find(s => s.tabId === tabId);
        if (slot) {
            slot.progress = msg.text;
            if (!slot.logLines) slot.logLines = [];
            slot.logLines.push(msg.text);
            if (slot.logLines.length > 12) slot.logLines.splice(0, slot.logLines.length - 12);
            slot.lastProgressAt = Date.now();
            if (slot.stalled) slot.stalled = false;
            await saveState(state);
        }
        return;
    }

    if (msg.action === 'downloadImageBlob') {
        // Content script fetched the image in-page (same-site, has SameSite cookies),
        // encoded it as base64, and sent it here. We reconstruct a Blob and create a
        // chrome-extension:// blob URL that chrome.downloads can access without size limits.
        try {
            const binaryStr = atob(msg.base64);
            const len = binaryStr.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i);
            const blob = new Blob([bytes], { type: msg.mimeType || 'image/png' });
            const blobUrl = URL.createObjectURL(blob);
            chrome.downloads.download(
                { url: blobUrl, filename: msg.filename, conflictAction: 'overwrite', saveAs: false },
                (id) => {
                    if (chrome.runtime.lastError) {
                        console.error('[bg] download error:', chrome.runtime.lastError.message, msg.filename);
                    } else {
                        console.log(`[bg] download started: ${msg.filename} id=${id}`);
                        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
                    }
                }
            );
        } catch (e) {
            console.error('[bg] downloadImageBlob error:', e.message);
        }
        return;
    }

    if (msg.action === 'downloadVideo') {
        chrome.downloads.download({
            url: msg.videoUrl,
            filename: msg.filename,
            conflictAction: 'overwrite',
            saveAs: false
        });
        return;
    }

    if (msg.action === 'imagesComplete') {
        const state = await loadState();
        const slot = state.slots.find(s => s.tabId === tabId);
        if (!slot) return;

        await patchProject(slot.projectId, { project_status: 'images_done' }).catch(console.error);

        state.consecutiveErrors = 0;   // a reel made it through — reset the breaker
        slot.phase = 'videos';
        slot.progress = 'Opening Google Flow...';
        await saveState(state);

        const newTab = await chrome.tabs.create({
            url: 'https://labs.google/fx/th/tools/flow',
            active: false
        });
        // Keep this background tab from being frozen/discarded by Memory Saver.
        chrome.tabs.update(newTab.id, { autoDiscardable: false }).catch(() => {});
        try { await chrome.tabs.remove(tabId); } catch {}
        slot.tabId = newTab.id;
        await saveState(state);
        return;
    }

    if (msg.action === 'videosComplete') {
        const state = await loadState();
        const slot = state.slots.find(s => s.tabId === tabId);
        if (!slot) return;

        // Backstop: confirm on disk that every scene actually has a video before
        // showing a green "Complete". If any are missing, show an honest warning
        // rather than hiding a failed generation behind a checkmark.
        let allOnDisk = true, missing = 0, projPage = '', sceneCount = 0;
        try {
            const projects = await fetchContents();
            const proj = projects.find(p => p.id === (msg.projectId || slot.projectId));
            if (proj) {
                projPage = proj.page || '';
                sceneCount = (proj.scenes && proj.scenes.length) || 0;
                if (proj.scenes.some(s => s.vdo_on_disk !== undefined)) {
                    missing = proj.scenes.filter(s => !s.vdo_on_disk).length;
                    allOnDisk = missing === 0;
                }
            }
        } catch {}

        try { await chrome.tabs.remove(tabId); } catch {}
        Object.assign(slot, freshSlot(slot.idx));
        slot.status = 'done';
        slot.progress = allOnDisk ? '✓ Complete' : `⚠ ${missing} video(s) still missing`;
        state.consecutiveErrors = 0;   // a reel finished — reset the breaker
        await saveState(state);

        // Only a truly finished reel (every scene video on disk) fires the notification.
        if (allOnDisk) {
            notifyReelFinished(msg.projectId || slot.projectId, projPage, sceneCount);
        }

        if (state.running) {
            slot.status = 'idle';
            slot.progress = '';
            await fillIdleSlots(state);
        }
        return;
    }

    if (msg.action === 'videosNeedsImages') {
        const state = await loadState();
        const slot = state.slots.find(s => s.tabId === tabId);
        if (!slot) return;

        try { await chrome.tabs.remove(tabId); } catch {}
        Object.assign(slot, freshSlot(slot.idx));
        slot.status = 'done';
        slot.progress = `⚠ ${msg.count || 0} scene(s) need images — run Images first`;
        await saveState(state);

        if (state.running) {
            slot.status = 'idle';
            slot.progress = '';
            await fillIdleSlots(state);
        }
        return;
    }

    if (msg.action === 'videosPartialComplete') {
        const state = await loadState();
        const slot = state.slots.find(s => s.tabId === tabId);
        if (!slot) return;

        try { await chrome.tabs.remove(tabId); } catch {}
        Object.assign(slot, freshSlot(slot.idx));
        slot.status = 'done';
        slot.progress = '⚠ Finish (not complete)';
        await saveState(state);

        if (state.running) {
            slot.status = 'idle';
            slot.progress = '';
            await fillIdleSlots(state);
        }
        return;
    }

    if (msg.action === 'videosRateLimited') {
        // Google throttled us ("unusual activity"). flow.js already backed off and
        // gave up for now WITHOUT dropping or penalising any scene — the project is
        // left at its real progress. Show an honest status; re-running later resumes.
        const state = await loadState();
        const slot = state.slots.find(s => s.tabId === tabId);
        if (!slot) return;

        try { await chrome.tabs.remove(tabId); } catch {}
        Object.assign(slot, freshSlot(slot.idx));
        slot.status = 'done';
        slot.progress = '⚠ Rate limited — re-run later to finish';
        await saveState(state);

        if (state.running) {
            slot.status = 'idle';
            slot.progress = '';
            await fillIdleSlots(state);
        }
        return;
    }

    if (msg.action === 'error') {
        const state = await loadState();
        const slot = state.slots.find(s => s.tabId === tabId);
        if (!slot) return;

        const failedId = slot.projectId;
        // Keep the failure visible even though we reuse the slot: record it so the UI
        // can show "recent errors" (the slot's own progress text gets overwritten when
        // it refills). The failed reel is NOT re-queued — it stays at its on-disk
        // progress so you can re-tick it later; this also avoids retrying a doomed reel.
        state.recentErrors = state.recentErrors || [];
        state.recentErrors.unshift({ id: failedId, message: msg.message || 'error', at: Date.now() });
        if (state.recentErrors.length > 10) state.recentErrors.length = 10;

        // Reclaim the slot just like every other terminal outcome (don't leave a dead
        // tab occupying a slot — that was the bug that wasted slots while you waited).
        try { await chrome.tabs.remove(slot.tabId); } catch {}
        Object.assign(slot, freshSlot(slot.idx));

        state.consecutiveErrors = (state.consecutiveErrors || 0) + 1;

        // Circuit breaker: too many errors in a row with no success between them means
        // something systemic (rate limit / logged out). Stop instead of churning tabs.
        if (state.consecutiveErrors >= ERROR_BREAKER_THRESHOLD) {
            state.running = false;
            state.pausedReason =
                `Paused after ${state.consecutiveErrors} errors in a row — likely a ChatGPT ` +
                `rate limit or a logged-out tab. Fix that, then press Start again.`;
            slot.status = 'idle';
            slot.progress = '';
            await saveState(state);
            try {
                chrome.notifications.create({
                    type: 'basic',
                    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
                    title: 'Reels generation paused',
                    message: state.pausedReason
                }, () => void chrome.runtime.lastError);
            } catch {}
            return;
        }

        // Otherwise free the slot and pull the next selected reel — no waiting for the
        // other tabs to finish. (Refills only from reels still in the queue; if none
        // remain the slot stays idle until you tick more.)
        slot.status = 'idle';
        slot.progress = '';
        await saveState(state);   // persist recentErrors/consecutiveErrors even if nothing refills
        if (state.running) await fillIdleSlots(state);
        return;
    }
}

// Keep service worker alive via alarm while running
chrome.alarms.create('heartbeat', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== 'heartbeat') return;
    const state = await loadState();
    if (state.running) await fillIdleSlots(state);

    const STALL_MS = 5 * 60 * 1000;
    const now = Date.now();
    let changed = false;
    for (const slot of state.slots) {
        if (slot.status === 'running' && slot.lastProgressAt) {
            const shouldStall = (now - slot.lastProgressAt) > STALL_MS;
            if (shouldStall !== slot.stalled) {
                slot.stalled = shouldStall;
                changed = true;
            }
        }
    }
    if (changed) await saveState(state);
});
