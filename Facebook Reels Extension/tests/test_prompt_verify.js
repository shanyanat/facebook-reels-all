// Stand-alone check of flow.js's editorText()/promptFilled(). The bug these pin: Slate
// renders its placeholder ("What do you want to create?") INSIDE the editable, so a plain
// `textContent.length > 0` test reported an untouched compose bar as filled — the prompt
// fallbacks never ran and Generate fired on an empty box.
// Run: node tests/test_prompt_verify.js

// ---- code under test, copied verbatim from content/flow.js ----
function editorText(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return (el.value || '').trim();
    try {
        const clone = el.cloneNode(true);
        clone.querySelectorAll('[data-slate-placeholder], [data-placeholder]')
             .forEach(ph => ph.remove());
        return (clone.textContent || '').trim();
    } catch { return (el.textContent || '').trim(); }
}

function promptFilled(text) {
    const norm = s => s.replace(/\s+/g, ' ').trim();
    const want = norm(text);
    const need = Math.max(20, Math.floor(want.length * 0.5));
    const head = want.slice(0, 20);
    return findPromptEditors().some(el => {
        const got = norm(editorText(el));
        return got.length >= need && got.includes(head);
    });
}
// ---- end code under test ----

// Minimal DOM stubs. A node is {kind:'text'|'placeholder', text}.
function mkEditable(nodes) {
    return {
        tagName: 'DIV',
        _nodes: nodes.slice(),
        getAttribute(k) { return k === 'contenteditable' ? 'true' : null; },
        get textContent() { return this._nodes.map(n => n.text).join(''); },
        cloneNode() { return mkEditable(this._nodes); },
        querySelectorAll(sel) {
            const self = this;
            const hits = sel.includes('placeholder')
                ? this._nodes.filter(n => n.kind === 'placeholder')
                : [];
            return hits.map(n => ({
                remove() { self._nodes = self._nodes.filter(x => x !== n); }
            }));
        },
    };
}
const txt = t => ({ kind: 'text', text: t });
const ph  = t => ({ kind: 'placeholder', text: t });
const mkTextarea = value => ({ tagName: 'TEXTAREA', value, getAttribute: () => null });

const PLACEHOLDER = 'What do you want to create?';
// A real scene video prompt is ~1200-1800 chars; this stands in for one.
const PROMPT = 'Slow dolly-in on the man kneeling by the kitchen island, warm morning light '
             + 'raking across the oak worktop, dust motes drifting, he slides the stack of '
             + 'bowls onto the lower shelf and glances up. Handheld, shallow depth of field, '
             + '8 seconds, no camera shake, no text overlays, natural room ambience only.';

let findPromptEditors = () => [];

const cases = [
    ['empty Slate box showing ONLY the placeholder must NOT count as filled  <-- the bug',
        [mkEditable([ph(PLACEHOLDER)])], PROMPT, false],
    ['Slate box holding the real prompt counts as filled',
        [mkEditable([txt(PROMPT)])], PROMPT, true],
    ['prompt plus a leftover placeholder span still counts as filled',
        [mkEditable([ph(PLACEHOLDER), txt(PROMPT)])], PROMPT, true],
    ['newlines renormalised to spaces by the editor still counts as filled',
        [mkEditable([txt(PROMPT.replace(/ /g, '\n  '))])], PROMPT, true],
    ['textarea carrying the prompt counts as filled',
        [mkTextarea(PROMPT)], PROMPT, true],
    ['empty textarea must NOT count as filled',
        [mkTextarea('')], PROMPT, false],
    ['unrelated leftover text must NOT count as filled',
        [mkEditable([txt('hello there')])], PROMPT, false],
    ['only 40% of the prompt must NOT count as filled (truncated insert)',
        [mkEditable([txt(PROMPT.slice(0, Math.floor(PROMPT.length * 0.4)))])], PROMPT, false],
    ['right length but wrong text must NOT count as filled',
        [mkEditable([txt('x'.repeat(PROMPT.length))])], PROMPT, false],
    ['no editor at all must NOT count as filled',
        [], PROMPT, false],
    ['second candidate holds the prompt — any match counts',
        [mkEditable([ph(PLACEHOLDER)]), mkEditable([txt(PROMPT)])], PROMPT, true],
];

let fail = 0;
for (const [desc, editors, text, want] of cases) {
    findPromptEditors = () => editors;
    const got = promptFilled(text);
    const ok = got === want;
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${desc}`);
    if (!ok) console.log(`        got ${got}, want ${want}`);
}

// editorText must strip the placeholder outright.
const stripped = editorText(mkEditable([ph(PLACEHOLDER)]));
if (stripped !== '') { fail++; console.log(`FAIL  editorText strips the placeholder (got ${JSON.stringify(stripped)})`); }
else console.log('PASS  editorText strips the placeholder to an empty string');

console.log(fail ? `\n${fail} FAILURE(S)` : '\nall cases pass');
process.exit(fail ? 1 : 0);
