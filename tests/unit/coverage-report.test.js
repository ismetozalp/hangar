// tests/unit/coverage-report.test.js — the coverage report generator.
//
// This file produces a number that goes into the repository and gets quoted in
// release notes, so the risk it carries is not a crash — it is a plausible
// wrong figure that nobody can catch by reading it. The tests are ordered by
// how misleading a regression would be:
//   1. the TOTALS are computed over the whole corpus, not averaged per file —
//      averaging makes a one-line module worth as much as a 2000-line one;
//   2. a file with NOTHING to measure is 100%, not 0%, so an empty module
//      cannot drag the total down for having no code in it;
//   3. the OUTPUT is deterministic and escapes what it interpolates, because it
//      is committed and diffed.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../coverage.mjs');

function rec(file, over) {
    return Object.assign({ file, LF: 0, LH: 0, BRF: 0, BRH: 0, FNF: 0, FNH: 0 }, over || {});
}

// --- 1. totals are over the corpus, not an average of averages -----------

test('totals weigh every line equally, not every file equally', async () => {
    const { totals } = await load();
    // A 1000-line file at 90% and a 10-line file at 0%. Averaging the two
    // percentages says 45%; counting lines says 89.1%. Only one of those is
    // the coverage of this code.
    const t = totals([
        rec('big.js', { LF: 1000, LH: 900, BRF: 100, BRH: 90, FNF: 10, FNH: 9 }),
        rec('tiny.js', { LF: 10, LH: 0, BRF: 2, BRH: 0, FNF: 1, FNH: 0 })
    ]);
    assert.equal(t.lines.toFixed(2), '89.11');
    assert.equal(t.branches.toFixed(2), '88.24');
    assert.equal(t.functions.toFixed(2), '81.82');
});

test('the totals of the real lcov agree with what node itself reported', async () => {
    // The figures node printed for this repository at the time of writing. If
    // the arithmetic here ever drifts from node's, one of the two is lying and
    // it matters which.
    const { parseLcov, totals } = await load();
    const files = parseLcov([
        'SF:a.js', 'FNF:9', 'FNH:9', 'BRF:51', 'BRH:48', 'LH:111', 'LF:111', 'end_of_record'
    ].join('\n'));
    const t = totals(files);
    assert.equal(t.lines.toFixed(2), '100.00');
    assert.equal(t.branches.toFixed(2), '94.12');   // node's table: reposize.js 94.12
    assert.equal(t.functions.toFixed(2), '100.00');
});

// --- 2. nothing to measure is not zero -----------------------------------

test('a file with no branches is 100%, never 0%', async () => {
    const { pct, totals } = await load();
    assert.equal(pct(0, 0), 100, 'nothing to cover is covered');
    assert.equal(pct(0, 1), 0, 'something uncovered is still zero');
    assert.equal(pct(1, 1), 100);
    // And it must not drag a total down by contributing a zero.
    const t = totals([
        rec('a.js', { LF: 100, LH: 100, BRF: 0, BRH: 0, FNF: 4, FNH: 4 }),
        rec('b.js', { LF: 100, LH: 100, BRF: 10, BRH: 10, FNF: 4, FNH: 4 })
    ]);
    assert.equal(t.branches, 100);
});

// --- 3. the report is deterministic and escapes what it interpolates -----

test('the same input renders byte-identical output', async () => {
    // It is committed, so a diff must mean the coverage changed — not that the
    // report was regenerated. Nothing in it may carry a clock or a random id.
    const { render } = await load();
    const files = [rec('js/a.js', { LF: 10, LH: 9, BRF: 4, BRH: 3, FNF: 2, FNH: 2 })];
    const a = render(files, '1.2.3');
    const b = render(files, '1.2.3');
    assert.equal(a, b);
    assert.equal(/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/.test(a), false,
        'a timestamp would make the file churn on every run');
});

test('rows are emitted in path order, whatever order they arrived in', async () => {
    // Diff readability: a reshuffle would bury the one row that changed.
    const { render } = await load();
    const shuffled = [rec('js/z.js', { LF: 1, LH: 1 }), rec('js/a.js', { LF: 1, LH: 1 }),
        rec('js/m.js', { LF: 1, LH: 1 })];
    const html = render(shuffled, '1.0.0');
    const order = [...html.matchAll(/data-value="(js\/[^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(order, ['js/a.js', 'js/m.js', 'js/z.js']);
});

test('a path carrying markup is escaped, not rendered', async () => {
    const { render, esc } = await load();
    assert.equal(esc('<img src=x onerror="alert(1)">'),
        '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    const html = render([rec('js/<script>.js', { LF: 1, LH: 1 })], '1.0.0');
    assert.equal(html.includes('<script>.js'), false);
    assert.equal(html.includes('&lt;script&gt;.js'), true);
});

test('every percentage cell carries a sortable numeric value', async () => {
    // The table sorts on data-value, not on the rendered text: "9.00%" sorts
    // above "88.00%" as a string, and a coverage table that lies about which
    // file is worst is worse than an unsorted one.
    const { render } = await load();
    const html = render([
        rec('js/a.js', { LF: 100, LH: 9, BRF: 1, BRH: 1, FNF: 1, FNH: 1 }),
        rec('js/b.js', { LF: 100, LH: 88, BRF: 1, BRH: 1, FNF: 1, FNH: 1 })
    ], '1.0.0');
    assert.match(html, /data-value="9\.0000"[^>]*>9\.00%/);
    assert.match(html, /data-value="88\.0000"[^>]*>88\.00%/);
});

test('the bands are drawn at the floors the build actually enforces', async () => {
    const { band, FLOORS } = await load();
    assert.equal(band(FLOORS.lines - 0.01, FLOORS.lines), 'bad', 'below the floor is red');
    assert.equal(band(FLOORS.lines, FLOORS.lines), 'near', 'exactly at it is not comfortable');
    assert.equal(band(FLOORS.lines + 4.99, FLOORS.lines), 'near');
    assert.equal(band(FLOORS.lines + 5, FLOORS.lines), 'good');
    assert.equal(band(100, FLOORS.lines), 'good');
});

test('the floors in the report match the ones in the Makefile', async () => {
    // Two files, one promise. A report that quotes a floor the build does not
    // enforce is a claim, not a guarantee.
    const { FLOORS } = await load();
    const makefile = require('node:fs')
        .readFileSync(require('node:path').join(__dirname, '../../Makefile'), 'utf8');
    for (const [name, value] of Object.entries(FLOORS)) {
        assert.ok(makefile.includes('--test-coverage-' + name + '=' + value),
            'Makefile does not enforce ' + name + '=' + value);
    }
});

// --- parsing -------------------------------------------------------------

test('parseLcov reads one record per source file and ignores the rest', async () => {
    const { parseLcov } = await load();
    const files = parseLcov([
        'TN:',
        'SF:js/a.js',
        'FN:7,anonymous_0',            // ignored: not a summary counter
        'DA:1,1', 'DA:2,0',            // ignored: this is the 440 KB of noise
        'FNF:2', 'FNH:1', 'LF:2', 'LH:1', 'BRF:4', 'BRH:2',
        'end_of_record',
        'SF:js/b.js',
        'FNF:1', 'FNH:1', 'LF:5', 'LH:5', 'BRF:0', 'BRH:0',
        'end_of_record',
        ''
    ].join('\n'));
    assert.equal(files.length, 2);
    assert.deepEqual(files[0], { file: 'js/a.js', LF: 2, LH: 1, BRF: 4, BRH: 2, FNF: 2, FNH: 1 });
    assert.deepEqual(files[1], { file: 'js/b.js', LF: 5, LH: 5, BRF: 0, BRH: 0, FNF: 1, FNH: 1 });
});

test('counters outside a record cannot invent a file', async () => {
    const { parseLcov } = await load();
    assert.deepEqual(parseLcov('LF:99\nLH:0\nend_of_record\n'), []);
    assert.deepEqual(parseLcov(''), []);
});

test('a record with no counters is zeroed, not undefined', async () => {
    // A truncated lcov file must produce 100% of nothing rather than NaN%.
    const { parseLcov, totals, fmt } = await load();
    const files = parseLcov('SF:js/a.js\nend_of_record\n');
    assert.deepEqual(files[0], { file: 'js/a.js', LF: 0, LH: 0, BRF: 0, BRH: 0, FNF: 0, FNH: 0 });
    assert.equal(fmt(totals(files).lines), '100.00%');
});

// --- the generated page stands on its own --------------------------------

test('the page fetches nothing — it has to work from a file:// URL', async () => {
    const { render } = await load();
    const html = render([rec('js/a.js', { LF: 1, LH: 1 })], '1.0.0');
    assert.equal(/https?:\/\/(?!www\.w3\.org)/.test(html), false, 'no external references');
    assert.equal(/<link\b/.test(html), false, 'no stylesheet links');
    assert.equal(/src=/.test(html), false, 'no script or image sources');
});

test('the page names what it does not measure', async () => {
    // The whole reason this section exists: 95% that silently omits 2200 lines
    // of Python is a misleading number, not a good one.
    const { render } = await load();
    const html = render([rec('js/a.js', { LF: 1, LH: 1 })], '1.0.0');
    assert.match(html, /libexec\/hangar-run/);
    assert.match(html, /tests\/integration/);
    assert.match(html, /tests\/unit<\/code> alone/);
});
