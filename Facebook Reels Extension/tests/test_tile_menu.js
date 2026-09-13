// Stand-alone check of flow.js's overTile() — the geometry that scopes the clip tile's ⋮
// button. The hazard it guards: Flow's page header carries its own ⋮ buttons, and opening
// one of those drives a completely different menu. Scoping by geometry (rather than by
// climbing the DOM) also keeps portal-rendered hover overlays in scope.
// Run: node tests/test_tile_menu.js

// ---- code under test, copied verbatim from content/flow.js ----
function overTile(el, tileRect) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    return cx >= tileRect.left - 24 && cx <= tileRect.right + 24 &&
           cy >= tileRect.top  - 24 && cy <= tileRect.bottom + 24;
}
// ---- end code under test ----

const rect = (left, top, width, height) => ({
    left, top, width, height, right: left + width, bottom: top + height,
});
const btn = r => ({ getBoundingClientRect: () => r });

// Geometry taken from the user's screenshot: a 9:16 clip tile in the grid's top-left, and
// the header ⋮ buttons at y≈27 (x≈259 and x≈1129) in a 1317x852 viewport.
const TILE = rect(21, 73, 174, 310);

const cases = [
    ['⋮ in the tile top-right corner (where Flow paints it)', btn(rect(160, 82, 24, 24)), true],
    ['⋮ in the tile bottom-right corner',                     btn(rect(160, 350, 24, 24)), true],
    ['overlay button dead-centre on the tile',                btn(rect(95, 210, 32, 32)), true],
    ['button 20px above the tile (inside the margin)',        btn(rect(100, 45, 20, 20)), true],
    ['header ⋮ at top-right of the page must NOT match',      btn(rect(1117, 15, 24, 24)), false],
    ['header ⋮ at top-left of the page must NOT match',       btn(rect(247, 15, 24, 24)), false],
    ['compose-bar button at the bottom must NOT match',       btn(rect(966, 793, 34, 34)), false],
    ['a second-row tile\'s ⋮ must NOT match this tile',       btn(rect(160, 470, 24, 24)), false],
    ['button just outside the right margin must NOT match',   btn(rect(230, 210, 20, 20)), false],
    ['full-width row wrapper (centre far from tile) must NOT match',
        btn(rect(0, 73, 1317, 310)), false],
];

let fail = 0;
for (const [desc, el, want] of cases) {
    const got = overTile(el, TILE);
    const ok = got === want;
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${desc}`);
    if (!ok) {
        const r = el.getBoundingClientRect();
        console.log(`        centre=(${r.left + r.width / 2},${r.top + r.height / 2}) got ${got}, want ${want}`);
    }
}
console.log(fail ? `\n${fail} FAILURE(S)` : '\nall cases pass');
process.exit(fail ? 1 : 0);
