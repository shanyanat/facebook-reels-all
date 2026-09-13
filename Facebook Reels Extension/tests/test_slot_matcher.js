// Stand-alone check of flow.js's accName()/isStartSlot() against the DOM shapes Google
// Flow's Material buttons actually take. Run: node test_slot_matcher.js
global.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };

// ---- the code under test, copied verbatim from content/flow.js ----
const SLOT_NAMES = ['Start', 'เริ่ม', 'เริ่มต้น'];

function accNameText(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (node.getAttribute('aria-hidden') === 'true') return '';
    if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return '';
    let s = '';
    for (const child of node.childNodes) s += accNameText(child);
    return s;
}

function accName(el) {
    const aria = (el.getAttribute('aria-label') || '').trim();
    if (aria) return aria;
    return accNameText(el).replace(/\s+/g, ' ').trim();
}

function isStartSlot(el) {
    if (SLOT_NAMES.includes(accName(el))) return true;
    const raw = (el.textContent || '').trim();
    return SLOT_NAMES.some(n => raw.endsWith(n) && raw.length <= n.length + 24);
}
// ---- end code under test ----

// Minimal DOM stubs
const txt = s => ({ nodeType: 3, nodeValue: s });
const el = (tag, attrs, kids) => ({
    nodeType: 1,
    tagName: tag.toUpperCase(),
    _a: attrs || {},
    childNodes: kids || [],
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._a, k) ? this._a[k] : null; },
    get textContent() {
        return this.childNodes.map(c => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join('');
    },
});
const icon = name => el('span', { 'aria-hidden': 'true', class: 'material-symbols-outlined' }, [txt(name)]);

const cases = [
    // [description, element, expected isStartSlot]
    ['aria-hidden icon + Start  (the shape Playwright matches, old code missed)',
        el('button', {}, [icon('image'), txt('Start')]), true],
    ['aria-label="Start" only',
        el('button', { 'aria-label': 'Start' }, [icon('image')]), true],
    ['ligature NOT aria-hidden ("imageStart")',
        el('button', {}, [el('span', {}, [txt('image')]), txt('Start')]), true],
    ['plain text Start (old code already matched)',
        el('button', {}, [txt('Start')]), true],
    ['Thai empty slot "เริ่ม" with icon',
        el('button', {}, [icon('add_photo_alternate'), txt('เริ่ม')]), true],
    ['"Start over" must NOT match',
        el('button', {}, [txt('Start over')]), false],
    ['"Get Started" must NOT match',
        el('button', {}, [txt('Get Started')]), false],
    ['"Restart" must NOT match',
        el('button', {}, [txt('Restart')]), false],
    ['occupied slot chip aria-label="Image ingredient" must NOT match',
        el('button', { 'aria-label': 'Image ingredient' }, [el('img', {}, [])]), false],
    ['"videocamVideo" settings row must NOT match',
        el('button', {}, [icon('videocam'), txt('Video')]), false],
    ['"addNew project" must NOT match',
        el('button', {}, [icon('add'), txt('New project')]), false],
    ['End frame slot "End" must NOT match',
        el('button', {}, [icon('image'), txt('End')]), false],
];

let fail = 0;
for (const [desc, node, want] of cases) {
    const got = isStartSlot(node);
    const ok = got === want;
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${desc}`);
    console.log(`        textContent=${JSON.stringify(node.textContent)} accName=${JSON.stringify(accName(node))} -> ${got} (want ${want})`);
}
console.log(fail ? `\n${fail} FAILURE(S)` : '\nall cases pass');
process.exit(fail ? 1 : 0);
