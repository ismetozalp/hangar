// tests/unit/retention.test.js — pure retention policy logic.
//
// The delete-everything guard is the reason this module exists; its cases are
// first and are the ones that must never be relaxed.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const R = require('../../js/core/retention.js');
const Errors = require('../../js/core/errors.js');

function codes(problems) {
    return problems.map((p) => p.detail.code).sort();
}

// ---------------------------------------------------------------- the guard

test('validate rejects an empty policy — it would delete everything', () => {
    const problems = R.validate({});
    assert.deepEqual(codes(problems), ['delete-everything']);
    assert.ok(Errors.isHangarError(problems[0]));
});

test('validate rejects a policy where every keep value is zero', () => {
    const problems = R.validate({ last: 0, hourly: 0, daily: 0, weekly: 0, monthly: 0, yearly: 0 });
    assert.deepEqual(codes(problems), ['delete-everything']);
});

test('validate rejects a policy whose only keep is a zero duration', () => {
    assert.deepEqual(codes(R.validate({ within: '0d' })), ['delete-everything']);
});

test('validate rejects a policy whose only keep is an empty tag list', () => {
    assert.deepEqual(codes(R.validate({ tags: [] })), ['delete-everything']);
});

test('validate rejects a policy whose only value is negative', () => {
    assert.deepEqual(codes(R.validate({ daily: -1 })), ['delete-everything', 'negative']);
});

test('one positive keep is enough to clear the guard', () => {
    assert.deepEqual(R.validate({ daily: 1 }), []);
    assert.deepEqual(R.validate({ within: '1h' }), []);
    assert.deepEqual(R.validate({ tags: ['keep'] }), []);
});

// ---------------------------------------------------------------- presets

test('rolling is the documented default preset', () => {
    assert.equal(R.DEFAULT_PRESET, 'rolling');
    assert.deepEqual(R.PRESETS.rolling, { hourly: 24, daily: 30, weekly: 52, monthly: 12 });
});

test('minimal, paranoid and space-saver presets exist', () => {
    ['minimal', 'paranoid', 'space-saver'].forEach((name) => {
        assert.equal(typeof R.PRESETS[name], 'object');
    });
});

test('every preset passes validation', () => {
    Object.keys(R.PRESETS).forEach((name) => {
        assert.deepEqual(R.validate(R.PRESETS[name]), [], name + ' must be a valid policy');
    });
});

test('preset() returns an editable copy, not the shared object', () => {
    const a = R.preset('rolling');
    a.daily = 1;
    assert.equal(R.PRESETS.rolling.daily, 30);
    assert.notEqual(a, R.preset('rolling'));
});

test('preset() returns null for an unknown name', () => {
    assert.equal(R.preset('nope'), null);
    assert.equal(R.preset(''), null);
    assert.equal(R.preset('toString'), null);
});

test('PRESETS table is frozen', () => {
    assert.ok(Object.isFrozen(R.PRESETS));
    assert.ok(Object.isFrozen(R.PRESETS.rolling));
});

// ---------------------------------------------------------------- toArgs

test('toArgs emits the rolling preset in flag order and always groups', () => {
    assert.deepEqual(R.toArgs(R.PRESETS.rolling), [
        '--keep-hourly', '24',
        '--keep-daily', '30',
        '--keep-weekly', '52',
        '--keep-monthly', '12',
        '--group-by', 'host,paths'
    ]);
});

test('toArgs emits every supported flag in canonical order', () => {
    const args = R.toArgs({
        last: 3, hourly: 24, daily: 7, weekly: 4, monthly: 6, yearly: 2,
        within: '30d', tags: ['keep', 'release']
    });
    assert.deepEqual(args, [
        '--keep-last', '3',
        '--keep-hourly', '24',
        '--keep-daily', '7',
        '--keep-weekly', '4',
        '--keep-monthly', '6',
        '--keep-yearly', '2',
        '--keep-within', '30d',
        '--keep-tag', 'keep',
        '--keep-tag', 'release',
        '--group-by', 'host,paths'
    ]);
});

test('toArgs on an empty policy still groups by host and paths', () => {
    assert.deepEqual(R.toArgs({}), ['--group-by', 'host,paths']);
});

test('toArgs tolerates null, undefined and non-object policies', () => {
    assert.deepEqual(R.toArgs(null), ['--group-by', 'host,paths']);
    assert.deepEqual(R.toArgs(undefined), ['--group-by', 'host,paths']);
    assert.deepEqual(R.toArgs('rolling'), ['--group-by', 'host,paths']);
    assert.deepEqual(R.toArgs([1, 2]), ['--group-by', 'host,paths']);
});

test('toArgs omits absent, null and zero values', () => {
    assert.deepEqual(R.toArgs({ daily: 0, weekly: null, monthly: undefined, yearly: 2 }),
        ['--keep-yearly', '2', '--group-by', 'host,paths']);
});

test('toArgs never emits a value restic would reject', () => {
    assert.deepEqual(R.toArgs({ daily: -3, weekly: 2.5, monthly: NaN, yearly: 'many' }),
        ['--group-by', 'host,paths']);
});

test('toArgs coerces numeric strings from form input', () => {
    assert.deepEqual(R.toArgs({ daily: '7', within: ' 30d ' }),
        ['--keep-daily', '7', '--keep-within', '30d', '--group-by', 'host,paths']);
});

test('toArgs drops a malformed or zero duration', () => {
    assert.deepEqual(R.toArgs({ daily: 1, within: '5w' }),
        ['--keep-daily', '1', '--group-by', 'host,paths']);
    assert.deepEqual(R.toArgs({ daily: 1, within: '0d' }),
        ['--keep-daily', '1', '--group-by', 'host,paths']);
});

test('toArgs accepts a single tag as a bare string and drops blanks', () => {
    assert.deepEqual(R.toArgs({ daily: 1, tags: 'important' }),
        ['--keep-daily', '1', '--keep-tag', 'important', '--group-by', 'host,paths']);
    assert.deepEqual(R.toArgs({ daily: 1, tags: '   ' }),
        ['--keep-daily', '1', '--group-by', 'host,paths']);
});

test('toArgs accepts the keepXxx spelling used by the design doc', () => {
    assert.deepEqual(R.toArgs({ keepLast: 2, keepWithin: '1y', keepTag: 'keep' }),
        ['--keep-last', '2', '--keep-within', '1y', '--keep-tag', 'keep',
            '--group-by', 'host,paths']);
});

test('toArgs does not mutate the policy it is given', () => {
    const policy = { keepDaily: 7 };
    R.toArgs(policy);
    assert.deepEqual(policy, { keepDaily: 7 });
});

// ---------------------------------------------------------------- normalize

test('normalize folds aliases onto canonical keys', () => {
    assert.deepEqual(R.normalize({ keepLast: 2, keepWithin: '1y', tag: 'x' }),
        { last: 2, within: '1y', tags: 'x' });
});

test('normalize lets an explicit canonical key win over its alias', () => {
    assert.deepEqual(R.normalize({ daily: 7, keepDaily: 99 }), { daily: 7 });
});

// ---------------------------------------------------------------- validate

test('validate accepts the rolling preset with a duration and tags', () => {
    assert.deepEqual(R.validate({ hourly: 24, daily: 30, within: '2y5m7d3h', tags: ['keep'] }), []);
});

test('validate rejects a non-object policy', () => {
    [null, undefined, 'rolling', 42, [], ['daily']].forEach((bad) => {
        assert.deepEqual(codes(R.validate(bad)), ['not-object'], JSON.stringify(bad));
    });
});

test('validate rejects negative counts', () => {
    const problems = R.validate({ daily: 30, weekly: -5 });
    assert.deepEqual(codes(problems), ['negative']);
    assert.equal(problems[0].detail.field, 'weekly');
});

test('validate rejects fractional counts', () => {
    assert.deepEqual(codes(R.validate({ daily: 2.5 })), ['delete-everything', 'not-integer']);
    assert.deepEqual(codes(R.validate({ daily: 7, weekly: 0.5 })), ['not-integer']);
});

test('validate reports a negative fraction once, as a non-integer', () => {
    assert.deepEqual(codes(R.validate({ daily: 7, weekly: -2.5 })), ['not-integer']);
});

test('validate rejects counts that are not numbers', () => {
    ['7', true, {}, [], NaN, Infinity].forEach((bad) => {
        const problems = R.validate({ daily: 7, weekly: bad });
        assert.deepEqual(codes(problems), ['not-integer'], String(bad));
    });
});

test('validate rejects unknown keys so a typo cannot silently drop a bucket', () => {
    const problems = R.validate({ daily: 30, wekly: 52 });
    assert.deepEqual(codes(problems), ['unknown-key']);
    assert.equal(problems[0].detail.field, 'wekly');
});

test('validate rejects malformed durations', () => {
    ['5w', '5', 'd', '2Y', '5d2y', '3.5d', '-3d', 'yesterday', '2y 5m', ''.padEnd(3, '?')]
        .forEach((bad) => {
            const problems = R.validate({ daily: 7, within: bad });
            assert.deepEqual(codes(problems), ['bad-duration'], JSON.stringify(bad));
        });
});

test('validate rejects a non-string duration', () => {
    assert.deepEqual(codes(R.validate({ daily: 7, within: 30 })), ['bad-duration']);
});

test('validate treats an empty duration as absent, not malformed', () => {
    assert.deepEqual(R.validate({ daily: 7, within: '' }), []);
    assert.deepEqual(R.validate({ daily: 7, within: null }), []);
});

test('validate accepts every well-formed duration shape', () => {
    ['2y5m7d3h', '30d', '1y', '3h', '6m', '1y1m1d1h', '2y3d', ' 30d '].forEach((good) => {
        assert.deepEqual(R.validate({ daily: 7, within: good }), [], good);
    });
});

test('validate rejects malformed tag lists', () => {
    [[''], ['ok', 42], [null], 7, {}].forEach((bad) => {
        const problems = R.validate({ daily: 7, tags: bad });
        assert.deepEqual(codes(problems), ['bad-tag'], JSON.stringify(bad));
    });
});

test('validate reports every problem at once', () => {
    const problems = R.validate({ daily: -1, weekly: 1.5, within: 'soon', tags: [''], bogus: 1 });
    assert.deepEqual(codes(problems),
        ['bad-duration', 'bad-tag', 'delete-everything', 'negative', 'not-integer', 'unknown-key']);
});

test('validate problems are typed HangarErrors, not bare strings', () => {
    const p = R.validate({})[0];
    assert.ok(Errors.isHangarError(p));
    assert.equal(p.kind, Errors.KIND.GENERIC);
    assert.equal(typeof p.message, 'string');
    assert.ok(p.message.length > 0);
});

// ---------------------------------------------------------------- describe

test('describe reads naturally for the rolling preset', () => {
    assert.equal(R.describe(R.PRESETS.rolling),
        'Keeps 24 hourly, 30 daily, 52 weekly and 12 monthly snapshots.');
});

test('describe reads naturally for one component', () => {
    assert.equal(R.describe({ daily: 7 }), 'Keeps 7 daily snapshots.');
    assert.equal(R.describe({ daily: 1 }), 'Keeps 1 daily snapshot.');
});

test('describe reads naturally for two components', () => {
    assert.equal(R.describe({ daily: 7, weekly: 4 }), 'Keeps 7 daily and 4 weekly snapshots.');
});

test('describe reads naturally for many components', () => {
    assert.equal(R.describe({ last: 3, hourly: 24, daily: 7, weekly: 4, monthly: 6, yearly: 2 }),
        'Keeps the 3 most recent, 24 hourly, 7 daily, 4 weekly, 6 monthly and 2 yearly snapshots.');
});

test('describe says so plainly when the policy keeps nothing', () => {
    assert.equal(R.describe({}), 'Keeps nothing — every snapshot would be deleted.');
    assert.equal(R.describe(null), 'Keeps nothing — every snapshot would be deleted.');
    assert.equal(R.describe({ daily: 0, within: '0d' }),
        'Keeps nothing — every snapshot would be deleted.');
});

test('describe drops the count for a single most-recent snapshot', () => {
    assert.equal(R.describe({ last: 1 }), 'Keeps the most recent snapshot.');
    assert.equal(R.describe({ last: 1, daily: 7 }), 'Keeps the most recent and 7 daily snapshots.');
});

test('describe spells out a duration', () => {
    assert.equal(R.describe({ within: '2y5m7d3h' }),
        'Keeps everything from the last 2 years, 5 months, 7 days and 3 hours.');
    assert.equal(R.describe({ daily: 7, within: '1d' }),
        'Keeps 7 daily snapshots. Also keeps everything from the last 1 day.');
});

test('describe echoes an unparsable duration verbatim rather than hiding it', () => {
    assert.equal(R.describe({ within: 'soon' }), 'Keeps everything from the last soon.');
});

test('describe mentions protected tags', () => {
    assert.equal(R.describe({ daily: 7, tags: 'keep' }),
        'Keeps 7 daily snapshots. Snapshots tagged "keep" are always kept.');
    assert.equal(R.describe({ tags: ['keep', 'release'] }),
        'Snapshots tagged "keep" and "release" are always kept.');
});

test('describe ignores values restic could never use', () => {
    assert.equal(R.describe({ daily: -3, weekly: 2.5, monthly: 4 }), 'Keeps 4 monthly snapshots.');
});

// ---------------------------------------------------------------- estimateCount

test('estimateCount sums the buckets of each preset', () => {
    assert.equal(R.estimateCount(R.PRESETS.rolling), 118);
    assert.equal(R.estimateCount(R.PRESETS.minimal), 12);
    assert.equal(R.estimateCount(R.PRESETS['space-saver']), 11);
    assert.equal(R.estimateCount(R.PRESETS.paranoid), 442);
});

test('estimateCount is zero for a policy that keeps nothing', () => {
    assert.equal(R.estimateCount({}), 0);
    assert.equal(R.estimateCount(null), 0);
    assert.equal(R.estimateCount({ daily: 0 }), 0);
});

test('estimateCount approximates a duration at one snapshot per day', () => {
    assert.equal(R.estimateCount({ within: '30d' }), 30);
    assert.equal(R.estimateCount({ within: '3h' }), 1);
    assert.equal(R.estimateCount({ daily: 7, within: '1y' }), 372);
});

test('estimateCount ignores tags, which cannot be counted without the repo', () => {
    assert.equal(R.estimateCount({ daily: 7, tags: ['keep', 'release'] }), 7);
});

// ---------------------------------------------------------------- parseDuration

test('parseDuration splits a full y/m/d/h duration', () => {
    assert.deepEqual(R.parseDuration('2y5m7d3h'),
        // (2*365 + 5*30 + 7) days * 24 + 3 — nominal year/month lengths.
        { years: 2, months: 5, days: 7, hours: 3, totalHours: 21291 });
});

test('parseDuration accepts each unit alone and any ordered subset', () => {
    assert.equal(R.parseDuration('1y').totalHours, 8760);
    assert.equal(R.parseDuration('1m').totalHours, 720);
    assert.equal(R.parseDuration('1d').totalHours, 24);
    assert.equal(R.parseDuration('1h').totalHours, 1);
    assert.equal(R.parseDuration('1y1h').totalHours, 8761);
});

test('parseDuration trims surrounding whitespace only', () => {
    assert.equal(R.parseDuration('  7d  ').days, 7);
    assert.equal(R.parseDuration('7 d'), null);
});

test('parseDuration returns null for anything restic would not accept', () => {
    ['', '   ', '5', 'd', 'y5', '5w', '5s', '2Y', '5D', '3.5d', '-3d', '+3d',
        '5d2y', '1d1d', '7d;rm -rf /', '٣d', 'null'].forEach((bad) => {
        assert.equal(R.parseDuration(bad), null, JSON.stringify(bad));
    });
});

test('parseDuration returns null for non-strings', () => {
    [null, undefined, 30, {}, [], ['7d']].forEach((bad) => {
        assert.equal(R.parseDuration(bad), null, JSON.stringify(bad));
    });
});

test('parseDuration keeps a syntactically valid zero duration distinguishable', () => {
    const d = R.parseDuration('0d');
    assert.notEqual(d, null);
    assert.equal(d.totalHours, 0);
});

// ================================================================ hostile input
//
// Everything below treats the policy as attacker-controlled: it arrives from a
// hand-editable /etc/hangar/jobs/<id>.json, so it can be any JSON value at all.
// Two properties are load-bearing and are asserted over a corpus at the end:
//   1. no entry point ever throws an untyped exception;
//   2. validate() === [] implies toArgs() emits at least one --keep-* flag,
//      because `restic forget --prune` with no keep flag destroys the group.

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

const NUL = '\u0000';
const LONG = 'x'.repeat(10000);

// ------------------------------------------------- inherited-property attacks

test('a policy key named after an Object.prototype member is unknown, not an alias', () => {
    ['toString', 'constructor', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
        'propertyIsEnumerable', 'toLocaleString'].forEach((k) => {
        const policy = { daily: 7 };
        policy[k] = 99;
        const problems = R.validate(policy);
        assert.deepEqual(codes(problems), ['unknown-key'], k);
        assert.equal(problems[0].detail.field, k);
    });
});

test('normalize drops inherited-name keys instead of inventing a garbage key', () => {
    assert.deepEqual(R.normalize({ daily: 7, toString: 1 }), { daily: 7 });
    assert.deepEqual(Object.keys(R.normalize({ constructor: 1, valueOf: 2 })), []);
});

test('a __proto__ key from JSON.parse is reported and pollutes nothing', () => {
    const policy = JSON.parse('{"daily":7,"__proto__":{"pwned":1}}');
    const problems = R.validate(policy);
    assert.deepEqual(codes(problems), ['unknown-key']);
    assert.equal(problems[0].detail.field, '__proto__');
    assert.equal({}.pwned, undefined);
    assert.equal(R.normalize(policy).pwned, undefined);
    assert.deepEqual(R.toArgs(policy), ['--keep-daily', '7', '--group-by', 'host,paths']);
});

test('a policy with a null prototype is handled like any other object', () => {
    const policy = Object.create(null);
    policy.daily = 7;
    assert.deepEqual(R.validate(policy), []);
    assert.deepEqual(R.toArgs(policy), ['--keep-daily', '7', '--group-by', 'host,paths']);
    assert.equal(R.describe(policy), 'Keeps 7 daily snapshots.');
});

test('preset() looks up own properties only', () => {
    ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'].forEach((name) => {
        assert.equal(R.preset(name), null, name);
    });
});

test('preset() returns null for every non-string name', () => {
    [null, undefined, 0, 1, NaN, true, false, {}, function () {}].forEach((bad) => {
        assert.equal(R.preset(bad), null, label(bad));
    });
    // A name that merely stringifies to a preset is not a name.
    assert.equal(R.preset(['rolling']), null);
    assert.equal(R.preset(Object.create(null)), null);
    assert.equal(R.preset(Symbol('rolling')), null);
});

test('the PRESETS table cannot be extended or edited through its entries', () => {
    assert.throws(() => { R.PRESETS.evil = { daily: 1 }; }, TypeError);
    assert.equal(R.PRESETS.evil, undefined);
    Object.keys(R.PRESETS).forEach((name) => {
        assert.ok(Object.isFrozen(R.PRESETS[name]), name + ' must be frozen');
        assert.throws(() => { R.PRESETS[name].daily = 0; }, TypeError, name);
    });
});

// ------------------------------------------------------------- hostile counts

test('validate rejects a count too large to survive a JSON round trip', () => {
    [1e21, 1e308, Number.MAX_SAFE_INTEGER + 2, Number.MAX_VALUE].forEach((big) => {
        const problems = R.validate({ daily: 7, weekly: big });
        assert.deepEqual(codes(problems), ['too-large'], String(big));
        assert.equal(problems[0].detail.field, 'weekly');
    });
});

test('an oversized count trips the delete-everything guard rather than passing', () => {
    // Regression: validate() used to accept 1e21 as a keep while toArgs() emitted
    // "1e+21", which restic rejects — a policy that keeps nothing looked valid.
    assert.deepEqual(codes(R.validate({ daily: 1e21 })), ['delete-everything', 'too-large']);
    assert.deepEqual(R.toArgs({ daily: 1e21 }), ['--group-by', 'host,paths']);
});

test('validate reports a huge negative count as negative, not as too large', () => {
    assert.deepEqual(codes(R.validate({ daily: 7, weekly: -1e21 })), ['negative']);
});

test('the largest safe count is accepted and emitted in full', () => {
    assert.deepEqual(R.validate({ daily: Number.MAX_SAFE_INTEGER }), []);
    assert.deepEqual(R.toArgs({ daily: Number.MAX_SAFE_INTEGER }),
        ['--keep-daily', '9007199254740991', '--group-by', 'host,paths']);
});

test('negative zero counts as no keep, not as a negative value', () => {
    assert.deepEqual(codes(R.validate({ daily: -0 })), ['delete-everything']);
    assert.deepEqual(R.toArgs({ daily: -0 }), ['--group-by', 'host,paths']);
});

test('validate rejects counts smuggled in as strings, however numeric', () => {
    ['7', ' 7 ', '0x7', '1e3', '7\n', '7' + NUL, '7; rm -rf /', '٣', '', LONG]
        .forEach((bad) => {
            assert.deepEqual(codes(R.validate({ daily: 7, weekly: bad })), ['not-integer'],
                label(bad));
        });
});

test('validate rejects counts of every other exotic type', () => {
    [true, false, [], [7], {}, function () {}, new Date(), Symbol('7'), 10n]
        .forEach((bad) => {
            assert.deepEqual(codes(R.validate({ daily: 7, weekly: bad })), ['not-integer'],
                label(bad));
        });
});

test('every count toArgs emits is a plain positive decimal integer', () => {
    [' 7 ', '0x10', '1e3', 7.0, true, [5], '007', 1e15, '9'.repeat(30)].forEach((v) => {
        const args = R.toArgs({ daily: v });
        args.forEach((arg, i) => {
            if (i === 0 || !/^--keep-(last|hourly|daily|weekly|monthly|yearly)$/.test(args[i - 1]))
                return;
            assert.match(arg, /^[1-9][0-9]*$/, label(v) + ' -> ' + arg);
        });
    });
});

test('toArgs never emits exponent notation for an oversized count', () => {
    R.COUNT_KEYS.forEach((c) => {
        const policy = {};
        policy[c.key] = 1e21;
        assert.deepEqual(R.toArgs(policy), ['--group-by', 'host,paths'], c.key);
    });
});

// ---------------------------------------------------------- hostile durations

test('parseDuration rejects NUL bytes and control characters', () => {
    ['7d' + NUL, NUL + '7d', '7' + NUL + 'd', '7d\u0007', '7\u200bd', '7d\b']
        .forEach((bad) => {
            assert.equal(R.parseDuration(bad), null, label(bad));
        });
});

test('parseDuration trims newlines and non-breaking space, but nothing inside', () => {
    assert.equal(R.parseDuration('\n7d\t ').days, 7);
    assert.equal(R.parseDuration(' 30d ').days, 30);
    assert.equal(R.parseDuration('7d\n30d'), null);
});

test('a duration reaches argv trimmed, so no newline is ever passed to restic', () => {
    assert.deepEqual(R.toArgs({ within: '\n 30d \n' }),
        ['--keep-within', '30d', '--group-by', 'host,paths']);
});

test('parseDuration rejects shell metacharacters and path traversal', () => {
    ['7d; rm -rf /', '7d && id', '$(date)d', '`id`h', '7d|tee /etc/passwd',
        '../../etc/passwd', '7d & ', '7d\\', "7d'", '7d"', '${IFS}7d', '/dev/null']
        .forEach((bad) => {
            assert.equal(R.parseDuration(bad), null, label(bad));
            assert.deepEqual(R.toArgs({ daily: 1, within: bad }),
                ['--keep-daily', '1', '--group-by', 'host,paths'], label(bad));
        });
});

test('parseDuration rejects repeated or out-of-order units', () => {
    ['3h2y', '1h1d', '5m5m', '1d1y', '3h1h', '1y1y1y'].forEach((bad) => {
        assert.equal(R.parseDuration(bad), null, bad);
    });
});

test('parseDuration is linear on a hostile-length input', () => {
    const started = Date.now();
    assert.equal(R.parseDuration('9'.repeat(200000) + 'x'), null);
    assert.equal(R.parseDuration('1y'.repeat(100000)), null);
    assert.ok(Date.now() - started < 2000, 'DURATION_RE must not backtrack');
});

test('parseDuration saturates instead of throwing on an absurd magnitude', () => {
    const d = R.parseDuration('9'.repeat(400) + 'd');
    assert.notEqual(d, null);
    assert.equal(typeof d.totalHours, 'number');
    assert.ok(d.totalHours > 0);
    assert.equal(typeof R.estimateCount({ within: '9'.repeat(400) + 'd' }), 'number');
});

test('validate treats a whitespace-only duration as malformed, not absent', () => {
    ['   ', '\n', '\t', ' '].forEach((bad) => {
        assert.deepEqual(codes(R.validate({ daily: 7, within: bad })), ['bad-duration'],
            label(bad));
    });
});

test('validate rejects a duration of any non-string type', () => {
    [0, 30, true, false, {}, ['30d'], NaN, Infinity, Symbol('30d'), 30n, function () {}]
        .forEach((bad) => {
            assert.deepEqual(codes(R.validate({ daily: 7, within: bad })), ['bad-duration'],
                label(bad));
        });
});

test('describe echoes a hostile duration verbatim without interpreting it', () => {
    assert.equal(R.describe({ within: '$(rm -rf /)' }),
        'Keeps everything from the last $(rm -rf /).');
    assert.equal(R.describe({ within: '../../etc' }),
        'Keeps everything from the last ../../etc.');
});

// --------------------------------------------------------------- hostile tags

test('a tag reaches argv as exactly one element, metacharacters and all', () => {
    const nasty = 'a b; rm -rf / && $(id) `whoami` | tee ../../etc/passwd';
    const args = R.toArgs({ daily: 1, tags: [nasty] });
    assert.equal(args.filter((a) => a === '--keep-tag').length, 1);
    assert.equal(args[args.indexOf('--keep-tag') + 1], nasty);
});

test('tags keep their interior whitespace, newlines and NUL bytes', () => {
    assert.deepEqual(R.toArgs({ daily: 1, tags: ['  a\nb  ', 'x' + NUL + 'y'] }), [
        '--keep-daily', '1',
        '--keep-tag', 'a\nb',
        '--keep-tag', 'x' + NUL + 'y',
        '--group-by', 'host,paths'
    ]);
});

test('duplicate tags are emitted twice — deduplicating is restic’s business', () => {
    assert.deepEqual(R.toArgs({ daily: 1, tags: ['a', 'a'] }),
        ['--keep-daily', '1', '--keep-tag', 'a', '--keep-tag', 'a', '--group-by', 'host,paths']);
});

test('unicode tags survive untouched', () => {
    ['ünïcødé', '日次バックアップ',
        '🚀', 'é'].forEach((t) => {
        assert.deepEqual(R.toArgs({ tags: t }), ['--keep-tag', t, '--group-by', 'host,paths'], t);
        assert.deepEqual(R.validate({ tags: t }), [], t);
    });
});

test('a very long tag is passed through without truncation', () => {
    assert.equal(R.toArgs({ tags: [LONG] })[1].length, 10000);
    assert.deepEqual(R.validate({ tags: [LONG] }), []);
});

test('a blank tag is a problem in a list but merely absent as a bare string', () => {
    assert.deepEqual(codes(R.validate({ tags: ['  '] })), ['bad-tag', 'delete-everything']);
    assert.deepEqual(codes(R.validate({ tags: '  ' })), ['delete-everything']);
    assert.deepEqual(codes(R.validate({ tags: NUL })), []);   // NUL is not whitespace
});

test('validate rejects every non-string member of a tag list', () => {
    [[42], [null], [undefined], [{}], [[]], [true], [['a']], ['ok', 0], [Symbol('t')]]
        .forEach((bad) => {
            assert.deepEqual(codes(R.validate({ daily: 7, tags: bad })), ['bad-tag'], label(bad));
        });
});

test('validate rejects tag containers that are neither array nor string', () => {
    [new Set(['a']), { 0: 'a', length: 1 }, 42, true, function () {}].forEach((bad) => {
        assert.deepEqual(codes(R.validate({ daily: 7, tags: bad })), ['bad-tag'], label(bad));
        assert.deepEqual(R.toArgs({ daily: 7, tags: bad }),
            ['--keep-daily', '7', '--group-by', 'host,paths'], label(bad));
    });
});

test('describe keeps a tag containing quotes rather than dropping it', () => {
    const s = R.describe({ tags: ['say "hi"'] });
    assert.ok(s.indexOf('say "hi"') >= 0, s);
});

// ------------------------------------------------------- hostile policy shape

test('validate rejects exotic non-objects with not-object', () => {
    [true, false, 0, NaN, Infinity, -1, '', '{}', Symbol('p'), 7n, function () {}]
        .forEach((bad) => {
            assert.deepEqual(codes(R.validate(bad)), ['not-object'], label(bad));
        });
});

test('an object with no usable keys is rejected by the guard, never accepted', () => {
    [new Date(), /re/, new Map(), new Set(), Object.create(null), new Error('x')]
        .forEach((bad) => {
            assert.ok(R.validate(bad).length > 0, label(bad));
        });
});

test('unknown key names are reported verbatim, however hostile', () => {
    ['wékly', 'a\nb', '../../etc/passwd', '', ' ', 'daily ', 'DAILY', LONG, NUL,
        '--keep-daily'].forEach((k) => {
        const policy = { daily: 7 };
        policy[k] = 1;
        const problems = R.validate(policy);
        assert.deepEqual(codes(problems), ['unknown-key'], label(k));
        assert.equal(problems[0].detail.field, k);
        assert.ok(problems[0].message.indexOf(k) >= 0, label(k));
    });
});

test('a policy stuffed with unknown keys yields one typed problem each', () => {
    const policy = { daily: 7 };
    for (let i = 0; i < 500; i++) policy['junk' + i] = i;
    const problems = R.validate(policy);
    assert.equal(problems.length, 500);
    assert.ok(problems.every((p) => Errors.isHangarError(p) && p.detail.code === 'unknown-key'));
});

test('an unknown key never reaches argv', () => {
    assert.deepEqual(R.toArgs({ daily: 1, '--prune': true, 'rm -rf /': 1 }),
        ['--keep-daily', '1', '--group-by', 'host,paths']);
});

test('every alias emits exactly what its canonical key emits', () => {
    [['keepLast', 'last', 2], ['keepHourly', 'hourly', 3], ['keepDaily', 'daily', 4],
        ['keepWeekly', 'weekly', 5], ['keepMonthly', 'monthly', 6], ['keepYearly', 'yearly', 7],
        ['keepWithin', 'within', '30d'], ['keepTag', 'tags', 'k'], ['tag', 'tags', 'k']]
        .forEach((pair) => {
            const a = {}; a[pair[0]] = pair[2];
            const c = {}; c[pair[1]] = pair[2];
            assert.deepEqual(R.toArgs(a), R.toArgs(c), pair[0]);
            assert.deepEqual(R.validate(a), R.validate(c), pair[0]);
            assert.equal(R.describe(a), R.describe(c), pair[0]);
        });
});

test('an alias shadowed by its canonical key is dropped whole, value and all', () => {
    assert.deepEqual(R.validate({ daily: 7, keepDaily: 'garbage' }), []);
    assert.deepEqual(R.toArgs({ daily: 7, keepDaily: 'garbage' }),
        ['--keep-daily', '7', '--group-by', 'host,paths']);
});

test('two aliases for one canonical key resolve to the first seen', () => {
    assert.deepEqual(R.normalize({ keepTag: 'a', tag: 'b' }), { tags: 'a' });
    assert.deepEqual(R.normalize({ tag: 'b', keepTag: 'a' }), { tags: 'b' });
});

test('no entry point mutates the policy it is given', () => {
    const policy = { daily: 7, keepWeekly: 4, within: ' 30d ', tags: ['a'], bogus: 1 };
    const before = JSON.stringify(policy);
    R.normalize(policy); R.toArgs(policy); R.validate(policy);
    R.describe(policy); R.estimateCount(policy);
    assert.equal(JSON.stringify(policy), before);
});

test('a frozen policy is read-only input, not an error', () => {
    const policy = Object.freeze({ keepDaily: 7, keepTag: 'k' });
    assert.deepEqual(R.validate(policy), []);
    assert.deepEqual(R.toArgs(policy),
        ['--keep-daily', '7', '--keep-tag', 'k', '--group-by', 'host,paths']);
});

test('toArgs leaves the exported GROUP_BY constant intact', () => {
    R.toArgs(R.PRESETS.rolling).length = 0;
    R.toArgs({}).push('--prune');
    assert.deepEqual(R.GROUP_BY, ['--group-by', 'host,paths']);
});

// -------------------------------------------------------- describe / estimate

test('describe never returns an empty string, whatever it is handed', () => {
    [undefined, null, 0, '', 'rolling', [], {}, new Date(), { within: [] },
        { within: 30 }, { daily: NaN }, { tags: {} }].forEach((bad) => {
        const s = R.describe(bad);
        assert.equal(typeof s, 'string', label(bad));
        assert.ok(s.length > 0, label(bad));
    });
});

test('describe pluralizes correctly when several buckets each keep one', () => {
    assert.equal(R.describe({ hourly: 1, daily: 1 }), 'Keeps 1 hourly and 1 daily snapshots.');
    assert.equal(R.describe({ monthly: 1 }), 'Keeps 1 monthly snapshot.');
    assert.equal(R.describe({ last: 1, within: '1d' }),
        'Keeps the most recent snapshot. Also keeps everything from the last 1 day.');
});

test('describe spells a one-of-each duration in singular form', () => {
    assert.equal(R.describe({ within: '1y1m1d1h' }),
        'Keeps everything from the last 1 year, 1 month, 1 day and 1 hour.');
});

test('estimateCount ignores exactly what toArgs ignores', () => {
    assert.equal(R.estimateCount({ daily: '7', weekly: -1, monthly: 2.5, yearly: 1e21 }), 7);
    assert.equal(R.estimateCount({ within: 'soon', tags: ['a'] }), 0);
});

test('estimateCount tolerates hostile input and never returns NaN', () => {
    [undefined, null, 0, 'rolling', [], new Date(), { daily: NaN }, { within: {} },
        { within: '9'.repeat(400) + 'y' }, { daily: Number.MAX_SAFE_INTEGER }]
        .forEach((bad) => {
            const n = R.estimateCount(bad);
            assert.equal(typeof n, 'number', label(bad));
            assert.ok(!Number.isNaN(n) && n >= 0, label(bad));
        });
});

// ------------------------------------------------------------- the invariants

// One corpus, reused by the property tests below.
const CORPUS = [
    undefined, null, 0, 1, NaN, Infinity, true, false, '', 'rolling', '{}',
    [], [1, 2], ['daily'], function () {}, new Date(), /re/, new Set(['a']),
    Object.create(null), Symbol('p'), 7n,
    {}, { daily: 1 }, { daily: 0 }, { daily: -1 }, { daily: -0 }, { daily: 2.5 },
    { daily: '7' }, { daily: true }, { daily: [7] }, { daily: NaN }, { daily: Infinity },
    { daily: 1e21 }, { daily: Number.MAX_SAFE_INTEGER }, { daily: Symbol('7') }, { daily: 10n },
    { within: '' }, { within: '   ' }, { within: '0d' }, { within: '30d' }, { within: '2y5m7d3h' },
    { within: '5w' }, { within: 30 }, { within: null }, { within: [] }, { within: {} },
    { within: '7d; rm -rf /' }, { within: NUL }, { within: '9'.repeat(400) + 'd' },
    { tags: [] }, { tags: '' }, { tags: '  ' }, { tags: 'k' }, { tags: ['k', 'j'] },
    { tags: [''] }, { tags: [42] }, { tags: {} }, { tags: null }, { tags: [LONG] },
    { toString: 1 }, { constructor: 1 }, JSON.parse('{"__proto__":{"pwned":1}}'),
    { bogus: 1 }, { '': 1 }, { 'a\nb': 1 }, { keepDaily: 7 }, { keepDaily: 7, daily: 1 },
    { last: 1, hourly: 24, daily: 30, weekly: 52, monthly: 12, yearly: 10, within: '1y', tags: 'k' },
    { daily: 7, weekly: -1, within: 'soon', tags: [''], bogus: 1 }
].concat(Object.keys(R.PRESETS).map((n) => R.preset(n)));

test('no entry point throws an untyped exception on any corpus value', () => {
    CORPUS.forEach((policy) => {
        const where = label(policy);
        assert.doesNotThrow(() => R.normalize(policy), where);
        assert.doesNotThrow(() => R.toArgs(policy), where);
        assert.doesNotThrow(() => R.validate(policy), where);
        assert.doesNotThrow(() => R.describe(policy), where);
        assert.doesNotThrow(() => R.estimateCount(policy), where);
        assert.doesNotThrow(() => R.parseDuration(policy), where);
        assert.doesNotThrow(() => R.preset(policy), where);
    });
});

test('every problem from every corpus value is a typed HangarError', () => {
    CORPUS.forEach((policy) => {
        const where = label(policy);
        R.validate(policy).forEach((p) => {
            assert.ok(Errors.isHangarError(p), where);
            assert.equal(p.kind, Errors.KIND.GENERIC, where);
            assert.equal(Errors.isFatal(p), true, where);
            assert.equal(p.remediation, null, where);
            assert.equal(typeof p.detail.code, 'string', where);
            assert.ok(p.message.length > 0, where);
        });
    });
});

test('toArgs output is always well formed argv', () => {
    CORPUS.forEach((policy) => {
        const args = R.toArgs(policy);
        const where = label(policy);
        assert.ok(Array.isArray(args), where);
        assert.equal(args.length % 2, 0, where);
        args.forEach((a) => {
            assert.equal(typeof a, 'string', where);
            assert.notEqual(a, '', where);
        });
        assert.deepEqual(args.slice(-2), ['--group-by', 'host,paths'], where);
        // Flags in even positions, their values in odd ones.
        args.slice(0, -2).forEach((a, i) => {
            if (i % 2 === 0)
                assert.match(a,
                    /^--keep-(last|hourly|daily|weekly|monthly|yearly|within|tag)$/, where);
        });
    });
});

test('a clean validate() always implies at least one keep flag — the data-loss guard', () => {
    CORPUS.forEach((policy) => {
        if (R.validate(policy).length > 0) return;
        assert.ok(R.toArgs(policy).some((a) => a.indexOf('--keep-') === 0),
            'validate() passed a policy that keeps nothing: ' + label(policy));
    });
});

test('the module stays pure: no cockpit call and no ES module syntax', () => {
    const src = require('node:fs').readFileSync(require('node:path')
        .join(__dirname, '..', '..', 'js', 'core', 'retention.js'), 'utf8');
    assert.equal(/cockpit\s*\./.test(src), false, 'retention.js must do no I/O');
    assert.equal(/typeof\s+cockpit/.test(src), false);
    assert.equal(/^\s*(import|export)\s/m.test(src), false);
});

test('the module registers its global as well as its CommonJS export', () => {
    assert.equal(globalThis.HangarRetention, R);
});
