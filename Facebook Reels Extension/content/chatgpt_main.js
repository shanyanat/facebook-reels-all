'use strict';

// Runs in ChatGPT's MAIN world at document_start — before any page scripts.
// Intercepts HTMLInputElement.prototype.click so that when the attachment
// button calls fileInput.click(), we inject our file instead of opening the
// native OS file chooser. File data arrives via postMessage from the isolated-
// world content script (chatgpt.js).

(function () {
    let pendingFile = null;

    // Receive file data from the isolated-world content script.
    window.addEventListener('message', function (event) {
        if (event.source !== window) return;
        if (!event.data || event.data.__reels !== 'setFile') return;
        try {
            const { base64, filename, mimeType } = event.data;
            const s = atob(base64);
            const bytes = new Uint8Array(s.length);
            for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
            pendingFile = new File([bytes], filename, { type: mimeType });
        } catch (e) {
            console.error('[reels-main] setFile error:', e);
        }
    });

    // Override click on every file input. When a pending file is queued,
    // inject it and call React's onChange instead of opening the file dialog.
    const _origClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
        if (this.type !== 'file' || !pendingFile) {
            return _origClick.call(this);
        }

        const file = pendingFile;
        pendingFile = null;

        // Set files via the native C++ setter (bypasses React's read-only wrapper).
        try {
            const nativeSetter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype, 'files'
            ).set;
            const dt = new DataTransfer();
            dt.items.add(file);
            nativeSetter.call(this, dt.files);
        } catch (e) {
            console.error('[reels-main] nativeSetter error:', e);
            return _origClick.call(this);
        }

        // Call React's onChange via fiber traversal — same pattern as clickGenerateSlate.
        const input = this;
        const synEvt = {
            persist:              function () {},
            preventDefault:       function () {},
            stopPropagation:      function () {},
            isPropagationStopped: function () { return false; },
            isDefaultPrevented:   function () { return false; },
            type: 'change', bubbles: true, cancelable: true,
            target: input, currentTarget: input,
            nativeEvent: { isTrusted: true, type: 'change', target: input }
        };

        const fk = Object.keys(input).find(function (k) {
            return k.startsWith('__reactFiber');
        });
        if (fk) {
            let fiber = input[fk];
            let depth = 0;
            while (fiber && depth < 60) {
                if (fiber.memoizedProps && typeof fiber.memoizedProps.onChange === 'function') {
                    fiber.memoizedProps.onChange(synEvt);
                    console.log('[reels-main] onChange called via fiber — file:', file.name, file.size);
                    return; // do NOT open native dialog
                }
                fiber = fiber.return;
                depth++;
            }
        }

        // Fallback: __reactProps direct (older React builds)
        const pk = Object.keys(input).find(function (k) {
            return k.startsWith('__reactProps');
        });
        if (pk && input[pk] && typeof input[pk].onChange === 'function') {
            input[pk].onChange(synEvt);
            console.log('[reels-main] onChange called via props — file:', file.name, file.size);
            return;
        }

        // Last resort: DOM events (may not trigger React)
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('input',  { bubbles: true }));
        console.warn('[reels-main] no React onChange found — dispatched DOM events');
    };
})();
