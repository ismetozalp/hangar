// tests/unit/sizeguard.test.js — the size guard's pure logic.
//
// This module deletes backups, so the tests are ordered by how much damage a
// regression would do:
//   1. the FLOOR — planTrim must never plan a forget that leaves fewer snapshots
//      than the minimum, for any count and any input ordering;
//   2. the OLDEST — planTrim must never choose a newer snapshot over an older
//      one, whatever order the array arrives in;
//   3. parseSize refusing garbage instead of guessing, because a misread limit
//      is a decision to delete.
// Everything after that is behaviour; those three are the contract.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const G = require('../../js/core/sizeguard.js');
const Errors = require('../../js/core/errors.js');

const GB = 1e9;
const NUL = '\u0000';
const LONG = 'x'.repeat(10000);

function codes(problems) {
    return problems.map((p) => p.detail.code).sort();
}

// Safe label for assert messages: the corpus holds symbols and bigints, which
// JSON.stringify respectively drops and throws on.
function label(v) {
    try {
        const s = JSON.stringify(v);
        return s === undefined ? String(v) : s;
    } catch (e) {
        return Object.prototype.toString.call(v);
    }
}

// A snapshot shaped like js/engine/restic.js normalizeSnapshot() output.
function snap(id, iso) {
    return { id: id, shortId: id.slice(0, 8), time: iso, hostname: 'h', paths: ['/srv'] };
}

// Five snapshots, oldest first. Ids are deliberately NOT in time order, so a
// test that accidentally sorts by id fails.
const S1 = snap('zzzz0001', '2024-01-01T00:00:00Z');
const S2 = snap('mmmm0002', '2024-02-01T00:00:00Z');
const S3 = snap('aaaa0003', '2024-03-01T00:00:00Z');
const S4 = snap('kkkk0004', '2024-04-01T00:00:00Z');
const S5 = snap('bbbb0005', '2024-05-01T00:00:00Z');
const FIVE = [S1, S2, S3, S4, S5];

function permutations(list) {
    if (list.length <= 1) return [list.slice()];
    const out = [];
    list.forEach((item, i) => {
        permutations(list.slice(0, i).concat(list.slice(i + 1)))
            .forEach((rest) => out.push([item].concat(rest)));
    });
    return out;
}

// Deterministic pseudo-shuffle, for lists too long to permute exhaustively.
function shuffles(list, n) {
    const out = [];
    for (let seed = 1; seed <= n; seed++) {
        const copy = list.slice();
        let s = seed * 2654435761 % 4294967296;
        for (let i = copy.length - 1; i > 0; i--) {
            s = (s * 1103515245 + 12345) % 2147483648;
            const j = s % (i + 1);
            const t = copy[i]; copy[i] = copy[j]; copy[j] = t;
        }
        out.push(copy);
    }
    return out;
}

function over(extra, snapshots, opts) {
    return Object.assign({
        currentBytes: 100 * GB + extra,
        limitBytes: 100 * GB,
        snapshots: snapshots
    }, opts || {});
}

// ================================================================ 1. the floor
//
// A size cap with no floor deletes the last remaining backup whenever the source
// data alone exceeds the cap — and then reports success, because the repository
// finally fits. These cases are the reason the module exists.

test('the floor stops deletion while the repository is still over the limit', () => {
    const r = G.planTrim(over(50 * GB, [S1, S2, S3], { minSnapshots: 3 }));
    assert.equal(r.action, 'floor-reached');
    assert.equal(r.reason, 'floor');
    assert.equal(r.snapshot, null);
    assert.equal(r.remaining, 50 * GB);
});

test('the floor holds when fewer snapshots remain than the minimum', () => {
    [0, 1, 2].forEach((n) => {
        const r = G.planTrim(over(50 * GB, FIVE.slice(0, n), { minSnapshots: 3 }));
        assert.equal(r.action, 'floor-reached', 'n=' + n);
        assert.notEqual(r.action, 'forget');
    });
});

test('the last remaining snapshot is never forgotten, however far over the limit', () => {
    const r = G.planTrim({
        currentBytes: 900 * GB, limitBytes: 1, snapshots: [S1], minSnapshots: 1
    });
    assert.equal(r.action, 'floor-reached');
    assert.equal(r.snapshot, null);
});

test('minSnapshots 0 is raised to 1 — a config file cannot switch the floor off', () => {
    assert.equal(G.effectiveFloor(0), 1);
    const r = G.planTrim(over(50 * GB, [S1], { minSnapshots: 0 }));
    assert.equal(r.action, 'floor-reached');
});

test('a negative minSnapshots is raised to 1, not treated as no floor', () => {
    [-1, -3, -1e15].forEach((bad) => {
        assert.equal(G.effectiveFloor(bad), 1, String(bad));
        assert.equal(G.planTrim(over(50 * GB, [S1], { minSnapshots: bad })).action,
            'floor-reached', String(bad));
    });
});

test('a nonsensical minSnapshots falls back to the default, never to zero', () => {
    ['3', true, false, null, undefined, NaN, Infinity, 2.5, {}, [], [3], 3n, Symbol('3')]
        .forEach((bad) => {
            assert.equal(G.effectiveFloor(bad), G.DEFAULTS.minSnapshots, label(bad));
        });
});

test('the default floor applies when minSnapshots is not given', () => {
    assert.equal(G.planTrim(over(50 * GB, [S1, S2, S3])).action, 'floor-reached');
    assert.equal(G.planTrim(over(50 * GB, [S1, S2, S3, S4])).action, 'forget');
});

test('the floor is respected for every count and every ordering', () => {
    // The property: a forget is planned only when strictly more snapshots exist
    // than the floor, so applying it can never breach the floor.
    for (let count = 0; count <= 5; count++) {
        const list = FIVE.slice(0, count);
        const orderings = permutations(list);
        [1, 2, 3, 4, 5].forEach((min) => {
            orderings.forEach((ordering) => {
                const r = G.planTrim(over(50 * GB, ordering, { minSnapshots: min }));
                const where = 'count=' + count + ' min=' + min;
                if (r.action === 'forget') {
                    assert.ok(count - 1 >= min, where + ' planned a forget that breaches the floor');
                } else {
                    assert.equal(r.action, 'floor-reached', where);
                    assert.equal(r.snapshot, null, where);
                }
            });
        });
    }
});

test('the floor counts snapshots that exist, including ones with no id', () => {
    // An entry we cannot name is still surviving history, so it counts toward the
    // floor even though it can never be the one deleted.
    const anon = { time: '2023-01-01T00:00:00Z' };
    const r = G.planTrim(over(50 * GB, [anon, anon, S4, S5], { minSnapshots: 4 }));
    assert.equal(r.action, 'floor-reached');
});

test('an empty repository reports floor-reached, not success', () => {
    const r = G.planTrim(over(50 * GB, [], { minSnapshots: 3 }));
    assert.equal(r.action, 'floor-reached');
    assert.equal(r.reason, 'no-snapshots');
    assert.equal(r.remaining, 50 * GB);
});

test('a floor of one still refuses to delete the only snapshot', () => {
    assert.equal(G.planTrim(over(1, [S1], { minSnapshots: 1 })).action, 'floor-reached');
    assert.equal(G.planTrim(over(1, [S1, S2], { minSnapshots: 1 })).action, 'forget');
});

test('the floor is checked before the iteration budget', () => {
    // Both conditions hold. Reporting "budget spent" would invite an operator to
    // raise the budget and re-run, which can never help.
    const r = G.planTrim(over(50 * GB, [S1, S2, S3],
        { minSnapshots: 3, iterations: 99, maxIterations: 20 }));
    assert.equal(r.action, 'floor-reached');
});

// ============================================================== 2. the oldest

test('planTrim forgets the oldest snapshot, one at a time', () => {
    const r = G.planTrim(over(50 * GB, FIVE, { minSnapshots: 1 }));
    assert.equal(r.action, 'forget');
    assert.equal(r.reason, 'oldest');
    assert.equal(r.snapshot, S1);
});

test('planTrim returns the caller’s own snapshot object, not a copy', () => {
    const r = G.planTrim(over(50 * GB, FIVE, { minSnapshots: 1 }));
    assert.equal(r.snapshot === S1, true);
    assert.equal(r.snapshot.id, 'zzzz0001');
});

test('planTrim picks the oldest for every one of the 120 orderings', () => {
    permutations(FIVE).forEach((ordering) => {
        const r = G.planTrim(over(50 * GB, ordering, { minSnapshots: 1 }));
        assert.equal(r.snapshot, S1, 'ordering ' + ordering.map((s) => s.id).join(','));
    });
});

test('planTrim never picks the newest snapshot, in any ordering', () => {
    permutations(FIVE).forEach((ordering) => {
        const r = G.planTrim(over(50 * GB, ordering, { minSnapshots: 1 }));
        assert.notEqual(r.snapshot, S5);
    });
});

test('a newest-first list (the reverse of restic’s order) still yields the oldest', () => {
    const r = G.planTrim(over(50 * GB, FIVE.slice().reverse(), { minSnapshots: 1 }));
    assert.equal(r.snapshot, S1);
});

test('the choice does not depend on id order', () => {
    // Ids sort in the opposite direction to times here, so a lexicographic sort
    // would answer S3 (aaaa0003) instead of S1.
    const byId = FIVE.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
    assert.equal(G.planTrim(over(50 * GB, byId, { minSnapshots: 1 })).snapshot, S1);
});

test('ties on time break on id, identically for every ordering', () => {
    const a = snap('cccc0001', '2024-01-01T00:00:00Z');
    const b = snap('aaaa0002', '2024-01-01T00:00:00Z');
    const c = snap('bbbb0003', '2024-01-01T00:00:00Z');
    const d = snap('dddd0004', '2025-01-01T00:00:00Z');
    permutations([a, b, c, d]).forEach((ordering) => {
        const r = G.planTrim(over(50 * GB, ordering, { minSnapshots: 1 }));
        assert.equal(r.snapshot, b, 'ordering ' + ordering.map((s) => s.id).join(','));
    });
});

test('the same instant written differently is still compared by instant', () => {
    const utc = snap('aaaa0001', '2024-03-01T12:00:00Z');
    const offset = snap('bbbb0002', '2024-03-01T13:00:00+02:00');   // an hour EARLIER
    const r = G.planTrim(over(50 * GB, [utc, offset], { minSnapshots: 1 }));
    assert.equal(r.snapshot, offset);
});

test('a Date object is accepted as a snapshot time', () => {
    const a = { id: 'aaaa0001', time: new Date('2024-01-01T00:00:00Z') };
    const b = { id: 'bbbb0002', time: new Date('2024-06-01T00:00:00Z') };
    assert.equal(G.planTrim(over(50 * GB, [b, a], { minSnapshots: 1 })).snapshot, a);
});

test('an undatable snapshot is skipped rather than assumed oldest', () => {
    [undefined, null, '', '   ', 'yesterday', 42, 1704067200, {}, [], NaN, true,
        new Date('nope')].forEach((bad) => {
        const undated = { id: 'ffff9999', time: bad };
        const r = G.planTrim(over(50 * GB, [undated].concat(FIVE), { minSnapshots: 1 }));
        assert.equal(r.snapshot, S1, label(bad));
    });
});

test('an epoch number is refused as a time — seconds and ms cannot be told apart', () => {
    // 1704067200 (seconds) and 1704067200000 (ms) are eleven centuries apart.
    const numeric = { id: 'ffff9999', time: 1704067200 };
    const r = G.planTrim(over(50 * GB, [numeric, S4, S5, snap('gggg0006', '2030-01-01T00:00:00Z')],
        { minSnapshots: 1 }));
    assert.equal(r.snapshot, S4);
});

test('a snapshot with no id is never chosen, even when it is the oldest', () => {
    const anon = { time: '2000-01-01T00:00:00Z' };
    const r = G.planTrim(over(50 * GB, [anon].concat(FIVE), { minSnapshots: 1 }));
    assert.equal(r.snapshot, S1);
});

test('when nothing can be dated the guard deletes nothing and says so', () => {
    const list = [{ id: 'a1' }, { id: 'b2', time: 'soon' }, { id: 'c3', time: null }];
    const r = G.planTrim(over(50 * GB, list, { minSnapshots: 1 }));
    assert.equal(r.action, 'floor-reached');
    assert.equal(r.reason, 'undatable');
    assert.equal(r.snapshot, null);
});

test('input order is never used as a fallback ordering', () => {
    // If array position leaked into the decision, the first element of an
    // otherwise undatable list would be chosen.
    const list = [{ id: 'first0001' }, { id: 'second002' }, { id: 'third0003' }, S5];
    const r = G.planTrim(over(50 * GB, list, { minSnapshots: 1 }));
    assert.equal(r.snapshot, S5);   // the only datable one, not the first one
});

test('the oldest is chosen consistently across shuffles of a large list', () => {
    const many = [];
    for (let i = 0; i < 40; i++)
        many.push(snap('id' + String(1000 + i), '2024-01-' + String(10 + (i % 20)) + 'T00:00:00Z'));
    const oldest = many[0];
    shuffles(many, 25).forEach((ordering, i) => {
        assert.equal(G.planTrim(over(50 * GB, ordering, { minSnapshots: 1 })).snapshot,
            oldest, 'shuffle ' + i);
    });
});

// ============================================================== 3. parseSize

test('a bare number is bytes', () => {
    assert.equal(G.parseSize('0'), 0);
    assert.equal(G.parseSize('1'), 1);
    assert.equal(G.parseSize('500'), 500);
    assert.equal(G.parseSize('1024'), 1024);
});

test('a single-letter unit is decimal, matching what hangar displays', () => {
    assert.equal(G.parseSize('500G'), 500e9);
    assert.equal(G.parseSize('800M'), 800e6);
    assert.equal(G.parseSize('2K'), 2000);
    assert.equal(G.parseSize('3T'), 3e12);
    assert.equal(G.parseSize('1P'), 1e15);
});

test('spelled decimal units are powers of 1000', () => {
    assert.equal(G.parseSize('1kB'), 1000);
    assert.equal(G.parseSize('1MB'), 1e6);
    assert.equal(G.parseSize('1GB'), 1e9);
    assert.equal(G.parseSize('1TB'), 1e12);
    assert.equal(G.parseSize('1PB'), 1e15);
});

test('binary units are powers of 1024 and must be spelled with the i', () => {
    assert.equal(G.parseSize('1KiB'), 1024);
    assert.equal(G.parseSize('1MiB'), 1048576);
    assert.equal(G.parseSize('1GiB'), 1073741824);
    assert.equal(G.parseSize('1TiB'), 1099511627776);
    assert.equal(G.parseSize('1PiB'), 1125899906842624);
});

test('decimal and binary differ by exactly the amount that matters', () => {
    // 7% on a 500 GB cap is 37 GB — the difference between a guard that trims and
    // one that never fires, so the two spellings must never be conflated.
    assert.notEqual(G.parseSize('500GB'), G.parseSize('500GiB'));
    assert.equal(G.parseSize('500GiB') - G.parseSize('500GB'), 536870912000 - 500000000000);
});

test('a bare B is bytes, not a unit prefix', () => {
    assert.equal(G.parseSize('500B'), 500);
    assert.equal(G.parseSize('500 B'), 500);
});

test('units are case insensitive', () => {
    ['500g', '500G', '500gb', '500GB', '500Gb', '500gB'].forEach((t) => {
        assert.equal(G.parseSize(t), 500e9, t);
    });
    ['1gib', '1GIB', '1GiB', '1giB'].forEach((t) => {
        assert.equal(G.parseSize(t), 1073741824, t);
    });
});

test('spaces and tabs between the number and the unit are allowed', () => {
    assert.equal(G.parseSize('500 GB'), 500e9);
    assert.equal(G.parseSize('500   GB'), 500e9);
    assert.equal(G.parseSize('500\tGB'), 500e9);
    assert.equal(G.parseSize('  1.5 TiB  '), 1649267441664);
});

test('fractions are accepted and rounded to whole bytes', () => {
    assert.equal(G.parseSize('1.5 TiB'), 1649267441664);
    assert.equal(G.parseSize('0.5GB'), 500e6);
    assert.equal(G.parseSize('2.25 MB'), 2250000);
    assert.equal(G.parseSize('1.5'), 2);          // bytes, rounded
    assert.equal(G.parseSize('0.4'), 0);
});

test('parseSize refuses garbage rather than guessing', () => {
    ['', '   ', '\n', 'GB', 'G', 'gigabytes', '500 gigabytes', 'five hundred',
        '1,000', '1_000', '1e3', '1E3', '0x10', '0b101', '500 G B', '500GB extra',
        '500GB;rm -rf /', '$(500)G', '500..5G', '.5G', '5.G', '5..G', '- 500G',
        '+500G', '500%', '500 GB/s', '500GBB', '500KIBB', 'Infinity', 'NaN',
        'null', 'undefined', '٥٠٠G', '500\nGB', '500' + NUL, NUL + '500',
        '500' + NUL + 'GB', '500 GiBi', 'MB500', '500 G 500', LONG]
        .forEach((bad) => {
            assert.equal(G.parseSize(bad), null, label(bad));
        });
});

test('parseSize refuses every non-string, non-number type', () => {
    [null, undefined, true, false, {}, [], ['500G'], new Date(), /5G/,
        Symbol('500G'), 500n, function () {}, { toString: () => '500G' }]
        .forEach((bad) => {
            assert.equal(G.parseSize(bad), null, label(bad));
        });
});

test('parseSize refuses numbers that are not real magnitudes', () => {
    [NaN, Infinity, -Infinity, 1e21, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER + 2]
        .forEach((bad) => {
            assert.equal(G.parseSize(bad), null, String(bad));
        });
});

test('parseSize accepts a number of bytes directly', () => {
    assert.equal(G.parseSize(0), 0);
    assert.equal(G.parseSize(500), 500);
    assert.equal(G.parseSize(500e9), 500e9);
    assert.equal(G.parseSize(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
    assert.equal(G.parseSize(1.6), 2);
});

test('parseSize refuses a magnitude that cannot survive a JSON round trip', () => {
    assert.equal(G.parseSize('10PB'), null);         // 1e16 > MAX_SAFE_INTEGER
    assert.equal(G.parseSize('9PB'), 9e15);          // just inside it
    assert.equal(G.parseSize('8PiB'), null);         // 9.007e15 in binary — just outside
    assert.equal(G.parseSize('1000PiB'), null);
    assert.equal(G.parseSize('9'.repeat(400) + 'G'), null);
});

test('zero parses, so the guard can refuse it with a useful message', () => {
    assert.equal(G.parseSize('0'), 0);
    assert.equal(G.parseSize('0GB'), 0);
    assert.equal(G.parseSize('-0'), 0);
    assert.ok(!Object.is(G.parseSize('-0'), -0), 'negative zero must be normalised');
});

test('a negative size parses to a negative count rather than to null', () => {
    // So validateGuard can say "must be greater than zero" instead of the useless
    // "unparseable". planTrim independently refuses any non-positive limit.
    assert.equal(G.parseSize('-5G'), -5e9);
    assert.equal(G.parseSize(-500), -500);
    assert.equal(G.planTrim({ currentBytes: 900 * GB, limitBytes: -5e9, snapshots: FIVE }).action,
        'none');
});

test('parseSize is linear on hostile input', () => {
    const started = Date.now();
    assert.equal(G.parseSize('9'.repeat(200000) + 'x'), null);
    assert.equal(G.parseSize('1 '.repeat(100000) + 'GB'), null);
    assert.ok(Date.now() - started < 2000, 'SIZE_RE must not backtrack');
});

test('the unit table is frozen', () => {
    assert.ok(Object.isFrozen(G.UNIT_BYTES));
    assert.throws(() => { G.UNIT_BYTES.gb = 1; }, TypeError);
    assert.equal(G.parseSize('1GB'), 1e9);
});

// ============================================================== formatSize

test('formatSize uses the binary convention the rest of hangar uses', () => {
    assert.equal(G.formatSize(999), '999 B');
    assert.equal(G.formatSize(1024), '1 KiB');
    assert.equal(G.formatSize(1536), '1.5 KiB');
    assert.equal(G.formatSize(500e9), '465.7 GiB');
    assert.equal(G.formatSize(2.5e12), '2.3 TiB');
});

test('formatSize matches formatBytes in js/features/logbook-ui.js', () => {
    // The two are duplicated on purpose — core/ must not depend on features/ —
    // so this is what keeps them in step.
    const fmt = require('../../js/features/logbook-ui.js').formatBytes;
    assert.equal(typeof fmt, 'function');
    [0, 1, 999, 1000, 1500, 1e6, 1.5e9, 500e9, 2.5e12, 1e15, -1, NaN,
        Number.MAX_SAFE_INTEGER, 1e300].forEach((n) => {
        assert.equal(G.formatSize(n), fmt(n), String(n));
    });
});

test('formatSize renders nothing rather than a fake size for junk', () => {
    [0, -1, -500e9, NaN, Infinity, -Infinity, null, undefined, true, false, '',
        'big', {}, [], Symbol.iterator && {}].forEach((bad) => {
        assert.equal(G.formatSize(bad), '0 B', label(bad));
    });
});

test('formatSize clamps instead of reaching exponential notation', () => {
    assert.equal(G.formatSize(1e300), '8 PiB');
    assert.match(G.formatSize(Number.MAX_SAFE_INTEGER), /^[0-9.]+ PiB$/);
});

test('a binary size a user types round-trips exactly', () => {
    ['500 GiB', '1 TiB', '250 GiB', '2 TiB'].forEach((text) => {
        assert.equal(G.formatSize(G.parseSize(text)), text, text);
    });
});

test('a decimal size a user types is echoed in binary, not silently reinterpreted', () => {
    // "1TB" still MEANS 10^12 — that is what was typed and what the guard
    // enforces. It is displayed in GiB so it can be compared, by eye, with the
    // repository size shown beside it. Showing "1 TB" next to "14.8 GiB" is what
    // made three correct numbers look like a contradiction.
    assert.equal(G.parseSize('1TB'), 1e12);
    assert.equal(G.formatSize(1e12), '931.3 GiB');
    assert.equal(G.parseSize('500GB'), 500e9);
    assert.equal(G.formatSize(500e9), '465.7 GiB');
});

// ============================================================== DEFAULTS

test('DEFAULTS are the documented values and are frozen', () => {
    assert.deepEqual(G.DEFAULTS, { minSnapshots: 3, maxIterations: 20 });
    assert.ok(Object.isFrozen(G.DEFAULTS));
    assert.throws(() => { G.DEFAULTS.minSnapshots = 0; }, TypeError);
});

// ============================================================== validateGuard

test('validateGuard accepts a sensible configuration', () => {
    assert.deepEqual(G.validateGuard({ limit: '500 GB', minSnapshots: 3 }), []);
    assert.deepEqual(G.validateGuard({ limit: '1.5TiB', minSnapshots: 10 }), []);
    assert.deepEqual(G.validateGuard({ limit: 500e9 }), []);
});

test('validateGuard rejects an unparseable limit', () => {
    ['big', '500 gigabytes', '1,000GB', 'null', {}, [], true, '0x10']
        .forEach((bad) => {
            assert.deepEqual(codes(G.validateGuard({ limit: bad, minSnapshots: 3 })),
                ['limit-unparseable'], label(bad));
        });
});

test('validateGuard rejects a missing limit distinctly from an unreadable one', () => {
    [undefined, null, ''].forEach((bad) => {
        assert.deepEqual(codes(G.validateGuard({ limit: bad, minSnapshots: 3 })),
            ['limit-missing'], label(bad));
    });
    assert.deepEqual(codes(G.validateGuard({ minSnapshots: 3 })), ['limit-missing']);
});

test('validateGuard rejects a zero or negative limit', () => {
    ['0', '0GB', 0, '-5G', -500, '-1TB'].forEach((bad) => {
        assert.deepEqual(codes(G.validateGuard({ limit: bad, minSnapshots: 3 })),
            ['limit-not-positive'], label(bad));
    });
});

test('validateGuard rejects minSnapshots below 1', () => {
    [0, -1, -100].forEach((bad) => {
        assert.deepEqual(codes(G.validateGuard({ limit: '500GB', minSnapshots: bad })),
            ['min-too-low'], String(bad));
    });
});

test('validateGuard rejects a minSnapshots that is not a whole number', () => {
    ['3', 2.5, NaN, Infinity, true, {}, [], 3n, 1e21].forEach((bad) => {
        assert.deepEqual(codes(G.validateGuard({ limit: '500GB', minSnapshots: bad })),
            ['min-not-integer'], label(bad));
    });
});

test('validateGuard treats an absent minSnapshots as "use the default"', () => {
    assert.deepEqual(G.validateGuard({ limit: '500GB' }), []);
    assert.deepEqual(G.validateGuard({ limit: '500GB', minSnapshots: null }), []);
});

test('validateGuard WARNS about a floor of one instead of silently accepting it', () => {
    const problems = G.validateGuard({ limit: '500GB', minSnapshots: 1 });
    assert.deepEqual(codes(problems), ['min-floor-one']);
    assert.equal(problems[0].detail.severity, 'warning');
    assert.equal(G.hasBlockingProblem(problems), false);
    assert.ok(/no margin/.test(problems[0].message), problems[0].message);
});

test('validateGuard warns about a limit small enough to be a missing unit', () => {
    const problems = G.validateGuard({ limit: '500', minSnapshots: 3 });
    assert.deepEqual(codes(problems), ['limit-suspicious']);
    assert.equal(problems[0].detail.severity, 'warning');
    assert.equal(G.hasBlockingProblem(problems), false);
});

test('validateGuard does not warn about an ordinary limit', () => {
    assert.deepEqual(G.validateGuard({ limit: '1GB', minSnapshots: 3 }), []);
    assert.deepEqual(G.validateGuard({ limit: '999MB', minSnapshots: 3 }).length, 1);
});

test('validateGuard rejects a non-object configuration', () => {
    [null, undefined, '500GB', 42, [], ['500GB'], true, Symbol('x')].forEach((bad) => {
        assert.deepEqual(codes(G.validateGuard(bad)), ['not-object'], label(bad));
    });
});

test('validateGuard reports every problem at once', () => {
    assert.deepEqual(codes(G.validateGuard({ limit: 'huge', minSnapshots: 0 })),
        ['limit-unparseable', 'min-too-low']);
});

test('validateGuard problems are typed HangarErrors, never bare strings', () => {
    const problems = G.validateGuard({ limit: 'huge', minSnapshots: 0 });
    problems.forEach((p) => {
        assert.ok(Errors.isHangarError(p));
        assert.equal(p.kind, Errors.KIND.GENERIC);
        assert.equal(p.remediation, null);
        assert.equal(typeof p.detail.code, 'string');
        assert.ok(p.message.length > 0);
    });
});

test('hasBlockingProblem separates refusal from advice', () => {
    assert.equal(G.hasBlockingProblem(G.validateGuard({ limit: '500GB', minSnapshots: 1 })), false);
    assert.equal(G.hasBlockingProblem(G.validateGuard({ limit: '500GB', minSnapshots: 0 })), true);
    assert.equal(G.hasBlockingProblem([]), false);
    assert.equal(G.hasBlockingProblem(null), false);
});

// ============================================================== overBy

test('overBy reports the excess', () => {
    assert.equal(G.overBy(600e9, 500e9), 100e9);
    assert.equal(G.overBy(1, 0), 1);
});

test('overBy is zero at and below the limit', () => {
    assert.equal(G.overBy(500e9, 500e9), 0);
    assert.equal(G.overBy(499e9, 500e9), 0);
    assert.equal(G.overBy(0, 500e9), 0);
});

test('overBy never returns a negative number or NaN', () => {
    [[NaN, 1], [1, NaN], [Infinity, 1], [1, Infinity], ['600', 500], [600, '500'],
        [null, 500], [600, null], [undefined, undefined], [true, false], [{}, []]]
        .forEach((pair) => {
            const n = G.overBy(pair[0], pair[1]);
            assert.equal(n, 0, label(pair));
        });
});

// ============================================================== planTrim

test('planTrim does nothing when the repository is under the limit', () => {
    assert.deepEqual(G.planTrim({ currentBytes: 400e9, limitBytes: 500e9, snapshots: FIVE }),
        { action: 'none', snapshot: null, reason: 'under-limit', remaining: 0 });
});

test('planTrim does nothing when the repository is exactly at the limit', () => {
    const r = G.planTrim({ currentBytes: 500e9, limitBytes: 500e9, snapshots: FIVE });
    assert.equal(r.action, 'none');
    assert.equal(r.reason, 'under-limit');
});

test('planTrim refuses to act without a usable limit', () => {
    [undefined, null, 0, -1, NaN, Infinity, '500GB', '500', true, {}, [], 500n]
        .forEach((bad) => {
            const r = G.planTrim({ currentBytes: 900e9, limitBytes: bad, snapshots: FIVE });
            assert.equal(r.action, 'none', label(bad));
            assert.equal(r.reason, 'no-limit', label(bad));
            assert.equal(r.snapshot, null, label(bad));
        });
});

test('planTrim refuses to act when the repository size is unknown', () => {
    // The most dangerous input in the module: a failed `restic stats` must never
    // read as "enormous, start deleting".
    [undefined, null, NaN, Infinity, -1, '900000000000', true, {}, [], 900n]
        .forEach((bad) => {
            const r = G.planTrim({ currentBytes: bad, limitBytes: 500e9, snapshots: FIVE });
            assert.equal(r.action, 'none', label(bad));
            assert.equal(r.reason, 'unknown-size', label(bad));
            assert.equal(r.snapshot, null, label(bad));
        });
});

test('planTrim tolerates a missing or malformed snapshot list', () => {
    [undefined, null, 'snapshots', 42, {}, true].forEach((bad) => {
        const r = G.planTrim(over(50 * GB, bad, { minSnapshots: 1 }));
        assert.equal(r.action, 'floor-reached', label(bad));
        assert.equal(r.reason, 'no-snapshots', label(bad));
    });
});

test('planTrim ignores list entries that are not snapshot objects', () => {
    const list = [null, undefined, 'zzzz0001', 42, [], true].concat(FIVE);
    const r = G.planTrim(over(50 * GB, list, { minSnapshots: 1 }));
    assert.equal(r.action, 'forget');
    assert.equal(r.snapshot, S1);
});

test('planTrim reports the bytes still over the limit as remaining', () => {
    assert.equal(G.planTrim(over(37 * GB, FIVE, { minSnapshots: 1 })).remaining, 37 * GB);
    assert.equal(G.planTrim(over(37 * GB, [S1], { minSnapshots: 3 })).remaining, 37 * GB);
    assert.equal(G.planTrim({ currentBytes: 1, limitBytes: 500e9, snapshots: FIVE }).remaining, 0);
});

test('planTrim stops when the iteration budget is spent', () => {
    const r = G.planTrim(over(50 * GB, FIVE, { minSnapshots: 1, iterations: 20 }));
    assert.equal(r.action, 'exhausted');
    assert.equal(r.reason, 'budget');
    assert.equal(r.snapshot, null);
    assert.equal(r.remaining, 50 * GB);
});

test('planTrim keeps going until the budget is actually spent', () => {
    for (let i = 0; i < G.DEFAULTS.maxIterations; i++) {
        assert.equal(G.planTrim(over(50 * GB, FIVE, { minSnapshots: 1, iterations: i })).action,
            'forget', 'iteration ' + i);
    }
    assert.equal(G.planTrim(over(50 * GB, FIVE,
        { minSnapshots: 1, iterations: G.DEFAULTS.maxIterations })).action, 'exhausted');
});

test('planTrim honours an explicit iteration budget', () => {
    assert.equal(G.planTrim(over(50 * GB, FIVE,
        { minSnapshots: 1, iterations: 2, maxIterations: 3 })).action, 'forget');
    assert.equal(G.planTrim(over(50 * GB, FIVE,
        { minSnapshots: 1, iterations: 3, maxIterations: 3 })).action, 'exhausted');
    assert.equal(G.planTrim(over(50 * GB, FIVE,
        { minSnapshots: 1, iterations: 0, maxIterations: 0 })).action, 'exhausted');
});

test('a malformed iteration count falls back to a safe reading', () => {
    ['3', -5, 2.5, NaN, Infinity, null, {}, true].forEach((bad) => {
        const r = G.planTrim(over(50 * GB, FIVE, { minSnapshots: 1, iterations: bad }));
        assert.equal(r.action, 'forget', label(bad));
    });
    ['20', 2.5, NaN, null, {}].forEach((bad) => {
        const r = G.planTrim(over(50 * GB, FIVE,
            { minSnapshots: 1, iterations: 19, maxIterations: bad }));
        assert.equal(r.action, 'forget', label(bad));   // default budget of 20
    });
});

test('planTrim returns exactly the four documented keys', () => {
    [over(50 * GB, FIVE, { minSnapshots: 1 }),
        over(50 * GB, [S1], { minSnapshots: 3 }),
        over(50 * GB, FIVE, { minSnapshots: 1, iterations: 99 }),
        { currentBytes: 1, limitBytes: 2, snapshots: [] },
        {}].forEach((input) => {
        assert.deepEqual(Object.keys(G.planTrim(input)).sort(),
            ['action', 'reason', 'remaining', 'snapshot']);
    });
});

test('planTrim never mutates its input', () => {
    const snapshots = FIVE.slice();
    const input = over(50 * GB, snapshots, { minSnapshots: 1, iterations: 1 });
    const before = JSON.stringify(input);
    G.planTrim(input);
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(snapshots, FIVE);
});

test('planTrim tolerates being called with nothing at all', () => {
    [undefined, null, 'x', 42, [], true].forEach((bad) => {
        const r = G.planTrim(bad);
        assert.equal(r.action, 'none', label(bad));
        assert.equal(r.snapshot, null, label(bad));
    });
});

// ---- the full loop, as the caller would run it ----------------------------

test('an iterative trim converges and stops at the floor, never below it', () => {
    // Simulates the real loop with dedup: each forget frees an unpredictable
    // amount, sometimes almost nothing.
    const freed = [10, 0, 30, 1, 0, 25, 0, 0, 5, 40];
    let snapshots = [];
    for (let i = 0; i < 10; i++)
        snapshots.push(snap('snap' + String(1000 + i), '2024-01-' + String(10 + i) + 'T00:00:00Z'));

    let current = 200 * GB;
    let iterations = 0;
    let last = null;
    for (let guard = 0; guard < 100; guard++) {
        last = G.planTrim({
            currentBytes: current, limitBytes: 100 * GB,
            snapshots: snapshots, minSnapshots: 3, iterations: iterations
        });
        if (last.action !== 'forget') break;
        assert.ok(snapshots.length > 3, 'never planned below the floor');
        current -= freed[iterations % freed.length] * GB;
        snapshots = snapshots.filter((s) => s !== last.snapshot);
        iterations++;
    }
    assert.equal(last.action, 'floor-reached');
    assert.equal(snapshots.length, 3);
    assert.ok(current > 100 * GB, 'still over — which is exactly what must be reported');
});

test('a trim that succeeds ends in none, having deleted only what it needed to', () => {
    let snapshots = FIVE.slice();
    let current = 130 * GB;
    let iterations = 0;
    let last = null;
    for (let guard = 0; guard < 50; guard++) {
        last = G.planTrim({
            currentBytes: current, limitBytes: 100 * GB,
            snapshots: snapshots, minSnapshots: 2, iterations: iterations
        });
        if (last.action !== 'forget') break;
        current -= 20 * GB;
        snapshots = snapshots.filter((s) => s !== last.snapshot);
        iterations++;
    }
    assert.equal(last.action, 'none');
    assert.equal(last.reason, 'under-limit');
    assert.equal(iterations, 2);
    assert.deepEqual(snapshots, [S3, S4, S5]);   // the two oldest went, in order
});

// ============================================================== describeOutcome

test('describeOutcome names the snapshot and the overshoot when forgetting', () => {
    const s = G.describeOutcome(G.planTrim(over(2.3 * GB, FIVE, { minSnapshots: 1 })));
    assert.ok(s.indexOf('zzzz0001') >= 0, s);
    assert.ok(s.indexOf('2.1 GiB') >= 0, s);   // 2.3 GB, rendered the way everything else is
    assert.ok(/oldest/.test(s), s);
});

test('describeOutcome is honest about a floor-reached run', () => {
    const s = G.describeOutcome(G.planTrim(over(40 * GB, [S1, S2, S3], { minSnapshots: 3 })));
    assert.ok(/^Stopped/.test(s), s);
    assert.ok(s.indexOf('still 37.3 GiB over') >= 0, s);
    assert.ok(/minimum/.test(s), s);
    assert.equal(/success|succeeded|within its size limit\./.test(s), false, s);
});

test('describeOutcome is honest about an exhausted run', () => {
    const s = G.describeOutcome(G.planTrim(over(40 * GB, FIVE,
        { minSnapshots: 1, iterations: 20 })));
    assert.ok(/^Stopped/.test(s), s);
    assert.ok(s.indexOf('still 37.3 GiB over') >= 0, s);
});

test('describeOutcome distinguishes an empty repository from a floor', () => {
    const empty = G.describeOutcome(G.planTrim(over(40 * GB, [], { minSnapshots: 3 })));
    assert.ok(/no snapshots/.test(empty), empty);
    const undatable = G.describeOutcome(G.planTrim(over(40 * GB,
        [{ id: 'a1' }, { id: 'b2' }, { id: 'c3' }, { id: 'd4' }], { minSnapshots: 1 })));
    assert.ok(/timestamps/.test(undatable), undatable);
    assert.ok(/deleted nothing/.test(undatable), undatable);
});

test('describeOutcome does not report a missing measurement as a success', () => {
    const s = G.describeOutcome(G.planTrim({ currentBytes: null, limitBytes: 500e9 }));
    assert.ok(/could not be measured/.test(s), s);
    assert.ok(/no snapshots were deleted/i.test(s), s);
});

test('describeOutcome says plainly when no limit is configured', () => {
    const s = G.describeOutcome(G.planTrim({ currentBytes: 900e9, snapshots: FIVE }));
    assert.ok(/No size limit is set/.test(s), s);
});

test('describeOutcome reads as fine only when the repository really is fine', () => {
    const s = G.describeOutcome({ action: 'none', snapshot: null, reason: 'under-limit', remaining: 0 });
    assert.equal(s, 'The repository is within its size limit. No snapshots were deleted.');
});

test('describeOutcome never returns an empty string, whatever it is handed', () => {
    [undefined, null, 0, '', 'forget', [], {}, { action: 'forget' }, { action: 'nope' },
        { action: 'floor-reached' }, { action: 'exhausted', remaining: NaN },
        { action: 'forget', snapshot: {}, remaining: -1 },
        { action: 'forget', snapshot: { id: 'abcdef0123456789' }, remaining: 1 }]
        .forEach((bad) => {
            const s = G.describeOutcome(bad);
            assert.equal(typeof s, 'string', label(bad));
            assert.ok(s.length > 0, label(bad));
            assert.ok(/\.$/.test(s), label(bad) + ' -> ' + s);
        });
});

test('describeOutcome falls back to the long id when there is no shortId', () => {
    const s = G.describeOutcome({
        action: 'forget', snapshot: { id: 'abcdef0123456789' }, reason: 'oldest', remaining: GB
    });
    assert.ok(s.indexOf('abcdef01') >= 0, s);
    assert.equal(s.indexOf('abcdef0123456789'), -1, s);
});

test('an unrecognised decision is reported as such, not smoothed over', () => {
    const s = G.describeOutcome({ action: 'sure-go-ahead' });
    assert.ok(/no usable decision/.test(s), s);
    assert.ok(/no snapshots were deleted/.test(s), s);
});

// ============================================================== invariants

// Hostile corpus: the guard config arrives from a hand-editable
// /etc/hangar/config.json and the snapshot list from a tool that may have failed
// halfway, so both can be any JSON value at all.
const CORPUS = [
    undefined, null, 0, 1, NaN, Infinity, -1, true, false, '', 'x', [], {},
    new Date(), /re/, Symbol('x'), 7n, function () {}, Object.create(null),
    { currentBytes: 900e9, limitBytes: 500e9, snapshots: FIVE },
    { currentBytes: 900e9, limitBytes: 500e9, snapshots: FIVE, minSnapshots: 0 },
    { currentBytes: 900e9, limitBytes: 500e9, snapshots: FIVE, minSnapshots: -1e9 },
    { currentBytes: 900e9, limitBytes: 500e9, snapshots: FIVE, minSnapshots: '0' },
    { currentBytes: 900e9, limitBytes: 500e9, snapshots: [], minSnapshots: 0 },
    { currentBytes: 900e9, limitBytes: 500e9, snapshots: [null, 'x', 3] },
    { currentBytes: 900e9, limitBytes: 500e9, snapshots: [{}] },
    { currentBytes: 900e9, limitBytes: 500e9, snapshots: [{ id: 'a' }] },
    { currentBytes: -1, limitBytes: -1, snapshots: FIVE },
    { currentBytes: 900e9, limitBytes: 0.5, snapshots: FIVE, minSnapshots: 1 },
    { currentBytes: Number.MAX_SAFE_INTEGER, limitBytes: 1, snapshots: FIVE, minSnapshots: 1 },
    { currentBytes: '900', limitBytes: '500', snapshots: 'five' },
    { currentBytes: NaN, limitBytes: 500e9, snapshots: FIVE },
    { currentBytes: 900e9, limitBytes: 500e9, snapshots: [{ id: 'a1' }, { id: 'b2' }] },
    { currentBytes: 900e9, limitBytes: 500e9, snapshots: FIVE, iterations: -1 },
    { currentBytes: 900e9, limitBytes: 500e9, snapshots: FIVE, maxIterations: -5 },
    JSON.parse('{"__proto__":{"minSnapshots":0},"currentBytes":9e11,"limitBytes":1}')
];

test('no entry point throws on any corpus value', () => {
    CORPUS.forEach((v) => {
        const where = label(v);
        assert.doesNotThrow(() => G.parseSize(v), where);
        assert.doesNotThrow(() => G.formatSize(v), where);
        assert.doesNotThrow(() => G.validateGuard(v), where);
        assert.doesNotThrow(() => G.overBy(v, v), where);
        assert.doesNotThrow(() => G.effectiveFloor(v), where);
        assert.doesNotThrow(() => G.planTrim(v), where);
        assert.doesNotThrow(() => G.describeOutcome(v), where);
        assert.doesNotThrow(() => G.describeOutcome(G.planTrim(v)), where);
    });
});

test('planTrim never plans a forget that breaches the effective floor — the guard', () => {
    CORPUS.forEach((v) => {
        const r = G.planTrim(v);
        if (r.action !== 'forget') return;
        const cfg = v;
        const present = cfg.snapshots.filter((s) => !!s && typeof s === 'object' && !Array.isArray(s));
        assert.ok(present.length - 1 >= G.effectiveFloor(cfg.minSnapshots),
            'forget planned below the floor for ' + label(v));
        assert.ok(present.indexOf(r.snapshot) >= 0, label(v));
    });
});

test('planTrim never plans a forget while the repository is within its limit', () => {
    CORPUS.concat([
        { currentBytes: 0, limitBytes: 1, snapshots: FIVE, minSnapshots: 1 },
        { currentBytes: 500e9, limitBytes: 500e9, snapshots: FIVE, minSnapshots: 1 }
    ]).forEach((v) => {
        const r = G.planTrim(v);
        if (r.action !== 'forget') return;
        assert.ok(G.overBy(v.currentBytes, v.limitBytes) > 0, label(v));
        assert.equal(r.remaining > 0, true, label(v));
    });
});

test('a prototype-polluted config cannot lower the floor', () => {
    const cfg = JSON.parse('{"currentBytes":9e11,"limitBytes":1,"minSnapshots":0}');
    cfg.snapshots = [S1];
    assert.equal(G.planTrim(cfg).action, 'floor-reached');
    assert.equal({}.minSnapshots, undefined);
});

test('every decision an action can produce carries a usable sentence', () => {
    const seen = {};
    CORPUS.forEach((v) => {
        const r = G.planTrim(v);
        seen[r.action + '/' + r.reason] = G.describeOutcome(r);
    });
    Object.keys(seen).forEach((k) => {
        assert.equal(typeof seen[k], 'string', k);
        assert.ok(seen[k].length > 20, k + ' -> ' + seen[k]);
    });
    // The refusals must all have been exercised by the corpus above.
    ['none/no-limit', 'none/unknown-size', 'floor-reached/floor', 'floor-reached/no-snapshots']
        .forEach((k) => assert.ok(seen[k], 'corpus never produced ' + k));
});

test('the module stays pure: no cockpit call and no ES module syntax', () => {
    const src = require('node:fs').readFileSync(require('node:path')
        .join(__dirname, '..', '..', 'js', 'core', 'sizeguard.js'), 'utf8');
    assert.equal(/cockpit\s*\./.test(src), false, 'sizeguard.js must do no I/O');
    assert.equal(/typeof\s+cockpit/.test(src), false);
    assert.equal(/^\s*(import|export)\s/m.test(src), false);
    assert.equal(/Time Machine/.test(src), false, 'the browser is called the Logbook');
});

test('the module registers its global as well as its CommonJS export', () => {
    assert.equal(globalThis.HangarSizeGuard, G);
});

// ============================================================ the second sweep
//
// Written as an attack on the module rather than a description of it. Every case
// below is a way someone might get the guard to delete more than it should, or
// to call a run that stopped a run that succeeded. The three questions are:
//
//   1. can any input reach a forget that takes the repository below the floor?
//   2. can a malformed or hostile limit turn into a deletion rather than a refusal?
//   3. does a run that stopped short read like a run that stopped short?

// --- 1. the floor, swept over every count and every ordering ----------------

function snapshotsAt(times) {
    return times.map((t, i) => ({ id: String.fromCharCode(97 + i).repeat(64), time: t }));
}

function isoDay(n) {
    return new Date(Date.UTC(2026, 0, 1 + n)).toISOString();
}

test('floor: no snapshot count, from 0 to 40, ever plans a forget below the floor', () => {
    // The brute-force version of the module's one load-bearing rule. Far over the
    // limit, so nothing except the floor can be what stops it.
    for (let floor = 1; floor <= 6; floor++) {
        for (let n = 0; n <= 40; n++) {
            const snaps = snapshotsAt(Array.from({ length: n }, (_, i) => isoDay(i)));
            const d = G.planTrim({
                currentBytes: 1e15, limitBytes: 1, snapshots: snaps,
                minSnapshots: floor, maxIterations: 1000
            });
            if (d.action === 'forget')
                assert.ok(n - 1 >= floor,
                    'planned a forget with ' + n + ' snapshots and a floor of ' + floor);
            else
                assert.ok(n <= floor,
                    'refused to forget with ' + n + ' snapshots and a floor of ' + floor);
        }
    }
});

test('floor: a single snapshot is never the one that goes, at any floor', () => {
    [undefined, null, 0, -100, 1, 3, 1e6].forEach((min) => {
        const d = G.planTrim({
            currentBytes: 1e15, limitBytes: 1,
            snapshots: snapshotsAt([isoDay(0)]), minSnapshots: min
        });
        assert.equal(d.action, 'floor-reached', 'floor ' + min);
        assert.equal(d.snapshot, null);
    });
});

test('floor: zero snapshots is a stop, not a forget of nothing', () => {
    const d = G.planTrim({ currentBytes: 1e15, limitBytes: 1, snapshots: [], minSnapshots: 1 });
    assert.equal(d.action, 'floor-reached');
    assert.equal(d.reason, 'no-snapshots');
    assert.equal(d.snapshot, null);
    assert.ok(d.remaining > 0, 'a stop must still report how far over it is');
});

test('floor: entries that are not objects do not count towards it and are not deleted', () => {
    // Two real snapshots and a lot of noise: the count that matters is 2, so a
    // floor of 2 stops. Counting the noise would let the guard delete a real one.
    const real = snapshotsAt([isoDay(0), isoDay(1)]);
    const d = G.planTrim({
        currentBytes: 1e15, limitBytes: 1,
        snapshots: [null, 'x', 7, [], undefined, real[0], real[1]],
        minSnapshots: 2
    });
    assert.equal(d.action, 'floor-reached');
    assert.equal(d.reason, 'floor');
});

test('floor: an unnameable snapshot still counts as surviving history', () => {
    // Three entries, one with no id. The floor is about how much history is left,
    // so the entry we cannot name still protects the two we can.
    const d = G.planTrim({
        currentBytes: 1e15, limitBytes: 1, minSnapshots: 3,
        snapshots: [{ id: 'a'.repeat(64), time: isoDay(0) },
            { id: 'b'.repeat(64), time: isoDay(1) },
            { time: isoDay(2) }]
    });
    assert.equal(d.action, 'floor-reached');
    assert.equal(d.reason, 'floor');
});

test('floor: nothing datable is a stop that says so, not a guess at the oldest', () => {
    const d = G.planTrim({
        currentBytes: 1e15, limitBytes: 1, minSnapshots: 1,
        snapshots: [{ id: 'a'.repeat(64) }, { id: 'b'.repeat(64), time: '' },
            { id: 'c'.repeat(64), time: 'yesterday' }, { id: 'd'.repeat(64), time: 1700000000 }]
    });
    assert.equal(d.action, 'floor-reached');
    assert.equal(d.reason, 'undatable');
    assert.equal(d.snapshot, null);
    assert.match(G.describeOutcome(d), /cannot tell which is oldest/);
});

// --- 2. the oldest, in every ordering ---------------------------------------

function permutations(a) {
    if (a.length <= 1) return [a];
    const out = [];
    a.forEach((x, i) => {
        const rest = a.slice(0, i).concat(a.slice(i + 1));
        permutations(rest).forEach((p) => out.push([x].concat(p)));
    });
    return out;
}

test('oldest: every one of the 120 orderings of five snapshots picks the same one', () => {
    const snaps = snapshotsAt([isoDay(4), isoDay(0), isoDay(3), isoDay(1), isoDay(2)]);
    const want = snaps[1].id;                       // isoDay(0), the oldest
    const orders = permutations(snaps);
    assert.equal(orders.length, 120);
    orders.forEach((order) => {
        const d = G.planTrim({
            currentBytes: 1e15, limitBytes: 1, snapshots: order, minSnapshots: 1
        });
        assert.equal(d.action, 'forget');
        assert.equal(d.snapshot.id, want, 'ordering changed the choice');
    });
});

test('oldest: sorted, reverse-sorted and shuffled input agree', () => {
    const times = Array.from({ length: 12 }, (_, i) => isoDay(i));
    const snaps = snapshotsAt(times);
    const want = snaps[0].id;
    const shuffled = snaps.slice();
    // A fixed shuffle: a failure has to be reproducible.
    [[0, 7], [1, 11], [2, 4], [3, 9], [5, 10], [6, 8]]
        .forEach(([i, j]) => { const t = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = t; });
    [snaps, snaps.slice().reverse(), shuffled].forEach((order) => {
        const d = G.planTrim({
            currentBytes: 1e15, limitBytes: 1, snapshots: order, minSnapshots: 1
        });
        assert.equal(d.snapshot.id, want);
    });
});

test('oldest: duplicate timestamps break on id, identically for every ordering', () => {
    // Two snapshots taken in the same second is ordinary — two jobs on one
    // repository, or a manual run beside the timer. Without a tie-break the
    // choice would depend on array order, which is exactly what this module
    // refuses to trust.
    const same = '2026-03-01T02:00:00Z';
    const snaps = [
        { id: 'c'.repeat(64), time: same },
        { id: 'a'.repeat(64), time: same },
        { id: 'b'.repeat(64), time: same },
        { id: 'd'.repeat(64), time: '2026-06-01T02:00:00Z' }   // plainly later
    ];
    permutations(snaps).forEach((order) => {
        const d = G.planTrim({
            currentBytes: 1e15, limitBytes: 1, snapshots: order, minSnapshots: 1
        });
        assert.equal(d.action, 'forget');
        assert.equal(d.snapshot.id, 'a'.repeat(64));
    });
});

test('oldest: a mixture of datable and undatable never picks an undatable one', () => {
    const snaps = [
        { id: 'a'.repeat(64), time: 'not a date' },
        { id: 'b'.repeat(64), time: isoDay(9) },
        { id: 'c'.repeat(64) },
        { id: 'd'.repeat(64), time: isoDay(2) },
        { id: 'e'.repeat(64), time: null }
    ];
    permutations(snaps).forEach((order) => {
        const d = G.planTrim({
            currentBytes: 1e15, limitBytes: 1, snapshots: order, minSnapshots: 1
        });
        assert.equal(d.action, 'forget');
        assert.equal(d.snapshot.id, 'd'.repeat(64), 'chose an undatable or a newer one');
    });
});

test('oldest: an epoch number is never read as a time, in either direction', () => {
    // A bare number could be seconds or milliseconds, and the factor of 1000
    // between them reverses the list. Refused, so the entry is simply undatable —
    // and here that leaves the ISO one as the only candidate even though its
    // number is far larger.
    const d = G.planTrim({
        currentBytes: 1e15, limitBytes: 1, minSnapshots: 1,
        snapshots: [{ id: 'a'.repeat(64), time: 0 },
            { id: 'b'.repeat(64), time: 1 },
            { id: 'c'.repeat(64), time: isoDay(100) }]
    });
    assert.equal(d.snapshot.id, 'c'.repeat(64));
});

// --- 3. a hostile limit must refuse, never delete ---------------------------

const HOSTILE_LIMITS = [
    ['a negative size', '-5G'],
    ['a negative number', -5e9],
    ['negative zero', '-0'],
    ['an exponent', '1e999'],
    ['a small exponent', '1e3'],
    ['letters', 'abc'],
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a boolean', true],
    ['an object', {}],
    ['an array', []],
    ['a number in an array', [500]],
    ['a number past MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 1],
    ['a huge float', 1e308],
    ['Infinity', Infinity],
    ['NaN', NaN],
    ['400 digits', '9'.repeat(400)],
    ['400 digits with a unit', '9'.repeat(400) + 'G'],
    ['a NUL after the unit', '500G' + NUL],
    ['a NUL before the number', NUL + '500G'],
    ['a NUL inside the number', '5' + NUL + '00G'],
    ['a thousands separator', '500,000'],
    ['an underscore separator', '500_000'],
    ['hexadecimal', '0x10'],
    ['trailing words', '500GB extra'],
    ['a four-letter unit', '500GBBB'],
    ['an unknown unit', '500%'],
    ['a constructor collision', '500constructor'],
    ['two decimal points', '5.5.5G'],
    ['a leading plus', '+5G'],
    ['Arabic-Indic digits', '٥٠٠GB'],
    ['fullwidth letters', '500ＧＢ'],
    ['a very long string', LONG]
];

HOSTILE_LIMITS.forEach(([what, value]) => {
    test('a hostile limit refuses rather than deletes — ' + what, () => {
        const bytes = G.parseSize(value);
        // Either unreadable, or readable and not a usable limit. Never a usable
        // positive number invented out of junk.
        if (bytes !== null) assert.ok(bytes <= 0, what + ' parsed to ' + bytes);

        // The invariant, whatever the value turns out to be: it never becomes a
        // deletion. Handed straight to planTrim as bytes, and handed to it again
        // as whatever parseSize made of it.
        const snaps = snapshotsAt([isoDay(0), isoDay(1), isoDay(2), isoDay(3)]);
        [value, bytes].forEach((limitBytes) => {
            const d = G.planTrim({
                currentBytes: 1e15, limitBytes: limitBytes, minSnapshots: 1, snapshots: snaps
            });
            assert.notEqual(d.action, 'forget', what + ' planned a deletion');
            assert.equal(d.snapshot, null);
            // A value that is not a usable byte count must be refused outright.
            // A finite positive one that merely dwarfs the repository — 1e308 —
            // is a real limit nothing will ever exceed, and 'under-limit' is the
            // honest answer to it.
            const usable = typeof limitBytes === 'number' &&
                Number.isFinite(limitBytes) && limitBytes > 0;
            assert.equal(d.reason, usable ? 'under-limit' : 'no-limit', what);
        });

        // And the editor blocks the save, so a limit nobody can read never
        // reaches a runner at all.
        if (value !== undefined && value !== null && value !== '')
            assert.equal(G.hasBlockingProblem(G.validateGuard({ limit: value })), true,
                what + ' would have saved');
    });
});

test('a limit that is an unmeasurable size deletes nothing even when far over', () => {
    // The dangerous direction: "I could not measure it" must never become
    // "delete until it fits".
    [undefined, null, NaN, Infinity, -1, '600', true, {}, []].forEach((current) => {
        const d = G.planTrim({
            currentBytes: current, limitBytes: 1, minSnapshots: 1,
            snapshots: snapshotsAt([isoDay(0), isoDay(1), isoDay(2), isoDay(3)])
        });
        assert.equal(d.action, 'none', label(current));
        assert.equal(d.reason, 'unknown-size');
        assert.equal(d.remaining, 0);
    });
});

// --- 4. a stopped run must read as stopped ---------------------------------

test('a floor-reached run never reads as a success', () => {
    ['floor', 'no-snapshots', 'undatable'].forEach((reason) => {
        const s = G.describeOutcome({ action: 'floor-reached', reason: reason, remaining: 40e9 });
        assert.match(s, /^Stopped:/, reason);
        assert.match(s, /still 37.3 GiB over/, reason);
        assert.equal(/within its size limit/.test(s), false, reason);
        assert.equal(/success|succeeded|completed/i.test(s), false, reason);
    });
});

test('an exhausted run never reads as a success', () => {
    const s = G.describeOutcome({ action: 'exhausted', reason: 'budget', remaining: 12e9 });
    assert.match(s, /^Stopped after/);
    assert.match(s, /still 11.2 GiB over/);
    assert.equal(/within its size limit/.test(s), false);
});

test('a stop with no measured overshoot still says it is over', () => {
    // remaining may be missing or unreadable on a record that came back from the
    // runner. The sentence must not quietly become "the repository is fine".
    [undefined, null, 0, -1, NaN, 'lots', {}].forEach((remaining) => {
        const s = G.describeOutcome({ action: 'floor-reached', reason: 'floor', remaining: remaining });
        assert.match(s, /still over its size limit/, label(remaining));
    });
});

test('an unmeasurable run says nothing was changed, never that it is within limit', () => {
    const s = G.describeOutcome({ action: 'none', reason: 'unknown-size', remaining: 0 });
    assert.match(s, /could not be measured/);
    assert.match(s, /Nothing was changed/);
});

test('an unrecognised outcome is reported as unrecognised, not smoothed into success', () => {
    [{}, null, undefined, 'ok', 42, { action: 'done' }, { action: 'forget-all' },
        { action: 'none', reason: 'made up' }].forEach((r) => {
        const s = G.describeOutcome(r);
        assert.equal(typeof s, 'string');
        assert.equal(/^Stopped/.test(s) || /no usable decision/.test(s) ||
            /within its size limit/.test(s), true, label(r) + ' -> ' + s);
        assert.equal(/deleted \d/.test(s), false);
    });
});

test('only under-limit and no-limit are allowed to read as "nothing to do"', () => {
    // The inverse of the sweep above: enumerate everything that MAY produce a
    // reassuring sentence, so a new action cannot join the list by accident.
    const reassuring = /within its size limit|No size limit is set/;
    [['none', 'under-limit'], ['none', 'no-limit'], ['none', 'unknown-size'],
        ['forget', 'oldest'], ['floor-reached', 'floor'], ['floor-reached', 'no-snapshots'],
        ['floor-reached', 'undatable'], ['exhausted', 'budget']]
        .forEach(([action, reason]) => {
            const s = G.describeOutcome({
                action: action, reason: reason, remaining: action === 'none' ? 0 : 5e9,
                snapshot: { shortId: 'deadbeef' }
            });
            const ok = action === 'none' && (reason === 'under-limit' || reason === 'no-limit');
            assert.equal(reassuring.test(s), ok, action + '/' + reason + ' -> ' + s);
        });
});

// --- 5. the budget ----------------------------------------------------------

test('the budget stops the loop, and the floor is reported ahead of it', () => {
    const snaps = snapshotsAt([isoDay(0), isoDay(1), isoDay(2), isoDay(3)]);
    const spent = G.planTrim({
        currentBytes: 1e15, limitBytes: 1, snapshots: snaps,
        minSnapshots: 1, iterations: 20, maxIterations: 20
    });
    assert.equal(spent.action, 'exhausted');
    assert.equal(spent.reason, 'budget');

    // When both apply, the floor wins: it is the durable condition, and saying
    // "budget spent" would invite an operator to raise the budget and re-run,
    // which cannot help.
    const both = G.planTrim({
        currentBytes: 1e15, limitBytes: 1, snapshots: snaps,
        minSnapshots: 4, iterations: 20, maxIterations: 20
    });
    assert.equal(both.action, 'floor-reached');
    assert.equal(both.reason, 'floor');
});

test('an unreadable iteration count cannot buy extra passes', () => {
    // "We do not know how many passes have run" reads as zero, which is safe only
    // because the budget still bounds the loop; a negative or fractional count
    // must not become a licence to keep going past it.
    [-1, -1e9, 2.5, NaN, Infinity, '100', null, undefined, true, {}].forEach((it) => {
        const d = G.planTrim({
            currentBytes: 1e15, limitBytes: 1, minSnapshots: 1, iterations: it,
            maxIterations: 0, snapshots: snapshotsAt([isoDay(0), isoDay(1)])
        });
        assert.equal(d.action, 'exhausted', label(it));
    });
});
