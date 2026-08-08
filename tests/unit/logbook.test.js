'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const L = require('../../js/core/logbook.js');
const Errors = require('../../js/core/errors.js');
const Restic = require('../../js/engine/restic.js');

const FIXTURES = path.join(__dirname, '../fixtures/restic');

function fixture(name) {
    return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

// Every rejection out of this module must be a typed GENERIC HangarError, never
// a bare Error — the UI switches on `kind`.
function assertGuard(fn) {
    assert.throws(fn, (e) => {
        assert.equal(e.name, 'HangarError', 'not a HangarError');
        assert.equal(e.kind, Errors.KIND.GENERIC);
        return true;
    });
}

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// A fixed instant, in UTC, so nothing here depends on where the tests run.
const NOW = Date.parse('2026-08-01T12:00:00Z');

function snap(id, msAgo) {
    return { id: id, short_id: id, time: new Date(NOW - msAgo).toISOString() };
}

function ids(band) {
    return band.snapshots.map((s) => s.id);
}

// ---------------------------------------------------------------- buildTimeline

test('buildTimeline: empty array yields no bands', () => {
    assert.deepEqual(L.buildTimeline([], NOW), []);
});

test('buildTimeline: null and undefined yield no bands', () => {
    assert.deepEqual(L.buildTimeline(null, NOW), []);
    assert.deepEqual(L.buildTimeline(undefined, NOW), []);
});

test('buildTimeline: a non-array input is a typed failure, not an empty scrubber', () => {
    assertGuard(() => L.buildTimeline('not a list', NOW));
    assertGuard(() => L.buildTimeline({ 0: snap('a', 0) }, NOW));
});

test('buildTimeline: a single snapshot yields one hour band', () => {
    const bands = L.buildTimeline([snap('a', 30 * MIN)], NOW);
    assert.equal(bands.length, 1);
    assert.equal(bands[0].granularity, L.GRANULARITY.HOUR);
    assert.equal(bands[0].key, 'hour:2026-08-01T11');
    assert.equal(bands[0].label, '1 Aug 2026, 11:00');
    assert.deepEqual(ids(bands[0]), ['a']);
});

test('buildTimeline: snapshots in the same UTC hour share one band', () => {
    const bands = L.buildTimeline([snap('a', 10 * MIN), snap('b', 20 * MIN)], NOW);
    assert.equal(bands.length, 1);
    assert.deepEqual(ids(bands[0]), ['a', 'b']);
});

test('buildTimeline: unsorted input comes out newest first', () => {
    const bands = L.buildTimeline([snap('old', 5 * HOUR), snap('new', 1 * HOUR), snap('mid', 3 * HOUR)], NOW);
    assert.deepEqual(bands.map((b) => b.snapshots[0].id), ['new', 'mid', 'old']);
    for (let i = 1; i < bands.length; i++)
        assert.ok(bands[i - 1].startMs > bands[i].startMs, 'bands must descend');
});

test('buildTimeline: snapshots inside a band are newest first', () => {
    const bands = L.buildTimeline([snap('c', 50 * MIN), snap('a', 10 * MIN), snap('b', 30 * MIN)], NOW);
    assert.equal(bands.length, 1);
    assert.deepEqual(ids(bands[0]), ['a', 'b', 'c']);
});

test('buildTimeline: identical timestamps keep their input order', () => {
    const t = new Date(NOW - 2 * HOUR).toISOString();
    const bands = L.buildTimeline([
        { id: 'first', time: t }, { id: 'second', time: t }, { id: 'third', time: t }
    ], NOW);
    assert.equal(bands.length, 1);
    assert.deepEqual(ids(bands[0]), ['first', 'second', 'third']);
});

test('buildTimeline: just under one day old is still an hour band', () => {
    const bands = L.buildTimeline([snap('a', DAY - SEC)], NOW);
    assert.equal(bands[0].granularity, L.GRANULARITY.HOUR);
});

test('buildTimeline: exactly one day old crosses into a day band', () => {
    const bands = L.buildTimeline([snap('a', DAY)], NOW);
    assert.equal(bands[0].granularity, L.GRANULARITY.DAY);
    assert.equal(bands[0].key, 'day:2026-07-31');
    assert.equal(bands[0].label, 'Fri 31 Jul 2026');
});

test('buildTimeline: just under seven days old is still a day band', () => {
    const bands = L.buildTimeline([snap('a', 7 * DAY - SEC)], NOW);
    assert.equal(bands[0].granularity, L.GRANULARITY.DAY);
});

test('buildTimeline: exactly seven days old crosses into a week band', () => {
    const bands = L.buildTimeline([snap('a', 7 * DAY)], NOW);
    assert.equal(bands[0].granularity, L.GRANULARITY.WEEK);
});

test('buildTimeline: just under ninety days old is still a week band', () => {
    const bands = L.buildTimeline([snap('a', 90 * DAY - SEC)], NOW);
    assert.equal(bands[0].granularity, L.GRANULARITY.WEEK);
});

test('buildTimeline: exactly ninety days old crosses into a month band', () => {
    const bands = L.buildTimeline([snap('a', 90 * DAY)], NOW);
    assert.equal(bands[0].granularity, L.GRANULARITY.MONTH);
    assert.equal(bands[0].key, 'month:2026-05');
    assert.equal(bands[0].label, 'May 2026');
});

test('buildTimeline: week bands start on the Monday, in UTC', () => {
    // 2026-07-15 is a Wednesday; its ISO week starts Monday 2026-07-13.
    const bands = L.buildTimeline([{ id: 'a', time: '2026-07-15T23:30:00Z' }], NOW);
    assert.equal(bands[0].granularity, L.GRANULARITY.WEEK);
    assert.equal(bands[0].key, 'week:2026-07-13');
    assert.equal(bands[0].label, 'Week of 13 Jul 2026');
    assert.equal(bands[0].start, '2026-07-13T00:00:00.000Z');
});

test('buildTimeline: a Sunday belongs to the week that began the previous Monday', () => {
    // 2026-07-19 is a Sunday — the trap case for a naive getUTCDay() subtraction.
    const bands = L.buildTimeline([{ id: 'a', time: '2026-07-19T06:00:00Z' }], NOW);
    assert.equal(bands[0].key, 'week:2026-07-13');
});

test('buildTimeline: snapshots spanning years get distinct month bands', () => {
    const bands = L.buildTimeline([
        { id: '2024', time: '2024-02-29T12:00:00Z' },
        { id: '2025', time: '2025-11-05T12:00:00Z' },
        { id: '2026', time: '2026-01-01T00:00:00Z' }
    ], NOW);
    assert.deepEqual(bands.map((b) => b.key), ['month:2026-01', 'month:2025-11', 'month:2024-02']);
    assert.deepEqual(bands.map((b) => b.label), ['January 2026', 'November 2025', 'February 2024']);
});

test('buildTimeline: a snapshot from the future sorts first rather than into the far past', () => {
    const bands = L.buildTimeline([snap('past', 2 * HOUR), snap('skewed', -3 * HOUR)], NOW);
    assert.equal(bands[0].granularity, L.GRANULARITY.HOUR);
    assert.deepEqual(ids(bands[0]), ['skewed']);
    assert.deepEqual(ids(bands[1]), ['past']);
});

test('buildTimeline: undated snapshots land in a trailing band instead of vanishing', () => {
    const bands = L.buildTimeline([
        snap('good', HOUR),
        { id: 'missing' },
        { id: 'garbage', time: 'the day before yesterday' },
        { id: 'nulled', time: null }
    ], NOW);
    const last = bands[bands.length - 1];
    assert.equal(last.key, 'unknown');
    assert.equal(last.granularity, L.GRANULARITY.UNKNOWN);
    assert.equal(last.label, 'Unknown date');
    assert.equal(last.start, null);
    assert.deepEqual(ids(last), ['missing', 'garbage', 'nulled']);
});

test('buildTimeline: band keys are namespaced by granularity so they never collide', () => {
    const bands = L.buildTimeline([snap('a', HOUR), snap('b', 3 * DAY), snap('c', 30 * DAY), snap('d', 400 * DAY)], NOW);
    const keys = bands.map((b) => b.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.deepEqual(keys.map((k) => k.split(':')[0]), ['hour', 'day', 'week', 'month']);
});

test('buildTimeline: output does not move with the host timezone', () => {
    const list = [
        { id: 'a', time: '2026-08-01T00:30:00Z' },
        { id: 'b', time: '2026-07-31T23:30:00Z' },
        { id: 'c', time: '2025-12-31T23:00:00Z' }
    ];
    const original = process.env.TZ;
    try {
        process.env.TZ = 'UTC';
        const utc = JSON.stringify(L.buildTimeline(list, NOW));
        process.env.TZ = 'Pacific/Kiritimati';       // UTC+14, the far side of the date line
        const east = JSON.stringify(L.buildTimeline(list, NOW));
        process.env.TZ = 'Pacific/Midway';           // UTC-11
        const west = JSON.stringify(L.buildTimeline(list, NOW));
        assert.equal(east, utc);
        assert.equal(west, utc);
    } finally {
        if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
    }
});

test('buildTimeline: omitting now falls back to the wall clock', () => {
    const bands = L.buildTimeline([{ id: 'a', time: new Date().toISOString() }]);
    assert.equal(bands.length, 1);
    assert.equal(bands[0].granularity, L.GRANULARITY.HOUR);
});

test('granularityFor: the whole boundary table', () => {
    assert.equal(L.granularityFor(-1e9), L.GRANULARITY.HOUR);
    assert.equal(L.granularityFor(0), L.GRANULARITY.HOUR);
    assert.equal(L.granularityFor(DAY - 1), L.GRANULARITY.HOUR);
    assert.equal(L.granularityFor(DAY), L.GRANULARITY.DAY);
    assert.equal(L.granularityFor(7 * DAY - 1), L.GRANULARITY.DAY);
    assert.equal(L.granularityFor(7 * DAY), L.GRANULARITY.WEEK);
    assert.equal(L.granularityFor(90 * DAY - 1), L.GRANULARITY.WEEK);
    assert.equal(L.granularityFor(90 * DAY), L.GRANULARITY.MONTH);
    assert.equal(L.granularityFor(50 * 365 * DAY), L.GRANULARITY.MONTH);
});

// ---------------------------------------------------------------- snapshotPath

test('snapshotPath: builds <root>/snapshots/<RFC3339>, keeping the recorded zone', () => {
    const s = { time: '2026-07-30T02:00:11.123456789+03:00' };
    assert.equal(L.snapshotPath('/run/hangar/mnt/main', s),
        '/run/hangar/mnt/main/snapshots/2026-07-30T02:00:11+03:00');
});

test('snapshotPath: a UTC snapshot keeps restic\'s Z form', () => {
    assert.equal(L.snapshotPath('/mnt/x', { time: '2026-07-30T02:00:11Z' }),
        '/mnt/x/snapshots/2026-07-30T02:00:11Z');
});

test('snapshotPath: a lowercase zone marker is normalised to Z', () => {
    assert.equal(L.snapshotPath('/mnt/x', { time: '2026-07-30t02:00:11z' }),
        '/mnt/x/snapshots/2026-07-30T02:00:11Z');
});

test('snapshotPath: a zone written without a colon gets one', () => {
    assert.equal(L.snapshotPath('/mnt/x', { time: '2026-07-30T02:00:11-0430' }),
        '/mnt/x/snapshots/2026-07-30T02:00:11-04:30');
});

test('snapshotPath: a timestamp with no zone is read as UTC', () => {
    assert.equal(L.snapshotPath('/mnt/x', { time: '2026-07-30T02:00:11' }),
        '/mnt/x/snapshots/2026-07-30T02:00:11Z');
});

test('snapshotPath: a Date or epoch value formats in UTC', () => {
    const d = new Date(Date.UTC(2026, 6, 30, 2, 0, 11));
    assert.equal(L.snapshotPath('/mnt/x', { time: d }), '/mnt/x/snapshots/2026-07-30T02:00:11Z');
    assert.equal(L.snapshotPath('/mnt/x', { time: d.getTime() }), '/mnt/x/snapshots/2026-07-30T02:00:11Z');
});

test('snapshotPath: trailing slashes on the mount root are collapsed', () => {
    assert.equal(L.snapshotPath('/mnt/x///', { time: '2026-07-30T02:00:11Z' }),
        '/mnt/x/snapshots/2026-07-30T02:00:11Z');
});

test('snapshotPath: restic\'s collision suffix is reproducible', () => {
    const s = { time: '2026-07-30T02:00:11Z' };
    assert.equal(L.snapshotPath('/mnt/x', s, 0), '/mnt/x/snapshots/2026-07-30T02:00:11Z');
    assert.equal(L.snapshotPath('/mnt/x', s, 1), '/mnt/x/snapshots/2026-07-30T02:00:11Z-1');
    assert.equal(L.snapshotPath('/mnt/x', s, 2), '/mnt/x/snapshots/2026-07-30T02:00:11Z-2');
});

test('snapshotPath: an unusable timestamp throws rather than naming the wrong moment', () => {
    assertGuard(() => L.snapshotPath('/mnt/x', {}));
    assertGuard(() => L.snapshotPath('/mnt/x', { time: null }));
    assertGuard(() => L.snapshotPath('/mnt/x', { time: 'yesterday' }));
    assertGuard(() => L.snapshotPath('/mnt/x', { time: NaN }));
});

test('snapshotPath: a hostile mount root is rejected', () => {
    assertGuard(() => L.snapshotPath('', { time: '2026-07-30T02:00:11Z' }));
    assertGuard(() => L.snapshotPath(null, { time: '2026-07-30T02:00:11Z' }));
    assertGuard(() => L.snapshotPath('/mnt/\nExecStart=/bin/sh', { time: '2026-07-30T02:00:11Z' }));
    assertGuard(() => L.snapshotPath('/mnt/x', { time: '2026-07-30T02:00:11Z' }, -1));
    assertGuard(() => L.snapshotPath('/mnt/x', { time: '2026-07-30T02:00:11Z' }, 1.5));
});

test('snapshotTimestampDir: accepts a bare timestamp as well as a snapshot', () => {
    assert.equal(L.snapshotTimestampDir('2026-07-30T02:00:11+03:00'), '2026-07-30T02:00:11+03:00');
});

// ---------------------------------------------------------------- diffToBadges

test('diffToBadges: the parsed restic diff fixture becomes badges', () => {
    const parsed = Restic.parseDiff(fixture('synthetic-diff.json'));
    const badges = { ...L.diffToBadges(parsed) };
    assert.deepEqual(badges, {
        '/srv/data/new.bin': 'added',
        '/srv/data/gone.bin': 'removed',
        '/etc/hosts': 'modified',
        '/srv/data/link': 'modified',
        '/srv/data/odd': 'modified'
    });
});

test('diffToBadges: the raw restic diff document works without the parser', () => {
    const doc = JSON.parse(fixture('synthetic-diff.json'));
    const badges = { ...L.diffToBadges(doc) };
    assert.equal(badges['/srv/data/new.bin'], 'added');
    assert.equal(badges['/srv/data/gone.bin'], 'removed');
    assert.equal(Object.keys(badges).length, 5);
});

test('diffToBadges: a bare array of changes works too', () => {
    const badges = { ...L.diffToBadges([{ path: '/a', modifier: '+' }, { path: '/b', modifier: '-' }]) };
    assert.deepEqual(badges, { '/a': 'added', '/b': 'removed' });
});

test('diffToBadges: null and undefined yield an empty map', () => {
    assert.deepEqual({ ...L.diffToBadges(null) }, {});
    assert.deepEqual({ ...L.diffToBadges(undefined) }, {});
    assert.deepEqual({ ...L.diffToBadges({}) }, {});
});

test('diffToBadges: unparsed text is a typed failure, not a silent empty map', () => {
    assertGuard(() => L.diffToBadges('{"changes":[]}'));
    assertGuard(() => L.diffToBadges(7));
});

test('diffToBadges: an unknown modifier is shown as modified rather than dropped', () => {
    const badges = { ...L.diffToBadges([{ path: '/a', modifier: 'X' }, { path: '/b', modifier: '' }]) };
    assert.deepEqual(badges, { '/a': 'modified', '/b': 'modified' });
});

test('diffToBadges: T and U are content-adjacent changes', () => {
    const badges = { ...L.diffToBadges([{ path: '/a', modifier: 'T' }, { path: '/b', modifier: 'U' }]) };
    assert.deepEqual(badges, { '/a': 'modified', '/b': 'modified' });
});

test('diffToBadges: a path reported both added and removed collapses to modified', () => {
    const badges = { ...L.diffToBadges([{ path: '/a', modifier: '+' }, { path: '/a', modifier: '-' }]) };
    assert.deepEqual(badges, { '/a': 'modified' });
});

test('diffToBadges: a repeated identical classification stays itself', () => {
    const badges = { ...L.diffToBadges([{ path: '/a', modifier: '+' }, { path: '/a', modifier: '+' }]) };
    assert.deepEqual(badges, { '/a': 'added' });
});

test('diffToBadges: a file named __proto__ becomes an own property, not a prototype write', () => {
    const badges = L.diffToBadges([{ path: '__proto__', modifier: '+' }, { path: '/srv/x', modifier: '-' }]);
    assert.ok(Object.prototype.hasOwnProperty.call(badges, '__proto__'));
    assert.equal(badges['__proto__'], 'added');
    assert.equal({}.polluted, undefined);
    // Built with defineProperty because an object literal's `__proto__:` key
    // sets the prototype instead of creating the property being asserted on.
    const expected = { '/srv/x': 'removed' };
    Object.defineProperty(expected, '__proto__',
        { value: 'added', enumerable: true, writable: true, configurable: true });
    assert.deepEqual({ ...badges }, expected);
});

test('diffToBadges: entries with no path are skipped', () => {
    const badges = { ...L.diffToBadges([{ modifier: '+' }, { path: '', modifier: '+' }, null, 'junk', { path: '/a', modifier: '+' }]) };
    assert.deepEqual(badges, { '/a': 'added' });
});

test('diffToBadges: unicode and space-bearing paths survive verbatim', () => {
    const p = '/srv/data/ünïcode file: dossier/#1';
    const badges = { ...L.diffToBadges([{ path: p, modifier: 'M' }]) };
    assert.deepEqual(badges, { [p]: 'modified' });
});

// ---------------------------------------------------------------- parseLsJson

test('parseLsJson: the ls fixture yields a snapshot and its nodes', () => {
    const out = L.parseLsJson(fixture('synthetic-ls-jsonlines.txt'));
    assert.equal(out.snapshot.shortId, '1a2b3c4d');
    assert.equal(out.snapshot.hostname, 'hangar-dev');
    assert.deepEqual(out.snapshot.paths, ['/srv/data']);
    assert.deepEqual(out.snapshot.tags, ['nightly']);
    assert.equal(out.nodes.length, 4);
    assert.deepEqual(out.nodes.map((n) => n.path), ['/srv', '/srv/data', '/srv/data/report.pdf', '/srv/data/link']);
    assert.deepEqual(out.nodes.map((n) => n.type), ['dir', 'dir', 'file', 'symlink']);
    assert.equal(out.nodes[2].size, 184320);
    assert.equal(out.nodes[2].permissions, '-rw-r--r--');
});

test('parseLsJson: a directory node with no size reports zero rather than NaN', () => {
    const out = L.parseLsJson(fixture('synthetic-ls-jsonlines.txt'));
    assert.equal(out.nodes[0].size, 0);
});

test('parseLsJson: empty and blank input is an empty listing, not a failure', () => {
    assert.deepEqual(L.parseLsJson(''), { snapshot: null, nodes: [] });
    assert.deepEqual(L.parseLsJson('   \n\n  '), { snapshot: null, nodes: [] });
    assert.deepEqual(L.parseLsJson(null), { snapshot: null, nodes: [] });
    assert.deepEqual(L.parseLsJson(undefined), { snapshot: null, nodes: [] });
});

test('parseLsJson: interleaved non-JSON noise is skipped', () => {
    const text = [
        'Warning: FUSE is unavailable, falling back to ls',
        '{"message_type":"snapshot","id":"abc123","time":"2026-07-30T02:00:11Z"}',
        'repository abc123 opened',
        '{"message_type":"node","name":"a","type":"file","path":"/a","size":1}'
    ].join('\n');
    const out = L.parseLsJson(text);
    assert.equal(out.snapshot.id, 'abc123');
    assert.equal(out.nodes.length, 1);
});

test('parseLsJson: a truncated final line is dropped, not fatal', () => {
    const text = '{"message_type":"node","name":"a","type":"file","path":"/a"}\n{"message_type":"node","name":"b"';
    const out = L.parseLsJson(text);
    assert.equal(out.nodes.length, 1);
    assert.equal(out.nodes[0].path, '/a');
});

test('parseLsJson: CRLF line endings parse identically', () => {
    const lf = fixture('synthetic-ls-jsonlines.txt');
    assert.deepEqual(L.parseLsJson(lf.replace(/\n/g, '\r\n')), L.parseLsJson(lf));
});

test('parseLsJson: the legacy struct_type key is honoured on its own', () => {
    const text = '{"struct_type":"snapshot","id":"deadbeefcafe"}\n{"struct_type":"node","name":"a","type":"file","path":"/a"}';
    const out = L.parseLsJson(text);
    assert.equal(out.snapshot.id, 'deadbeefcafe');
    assert.equal(out.snapshot.shortId, 'deadbeef');
    assert.equal(out.nodes.length, 1);
});

test('parseLsJson: nodes with no snapshot record still list', () => {
    const out = L.parseLsJson('{"message_type":"node","name":"a","type":"file","path":"/a"}');
    assert.equal(out.snapshot, null);
    assert.equal(out.nodes.length, 1);
});

test('parseLsJson: an untagged record carrying name and path is treated as a node', () => {
    const out = L.parseLsJson('{"name":"a","type":"file","path":"/a"}');
    assert.equal(out.nodes.length, 1);
    assert.equal(out.nodes[0].name, 'a');
});

test('parseLsJson: an unknown record type is ignored rather than listed', () => {
    const out = L.parseLsJson('{"message_type":"verbose_status","action":"scanning"}');
    assert.deepEqual(out, { snapshot: null, nodes: [] });
});

test('parseLsJson: a second snapshot record does not clobber the first', () => {
    const text = '{"message_type":"snapshot","id":"first"}\n{"message_type":"snapshot","id":"second"}';
    assert.equal(L.parseLsJson(text).snapshot.id, 'first');
});

test('parseLsJson: JSON scalars and arrays on a line are not mistaken for records', () => {
    assert.deepEqual(L.parseLsJson('[]\n"nope"\n7'), { snapshot: null, nodes: [] });
});

test('parseLsJson: non-empty input with nothing parseable is a typed failure', () => {
    assertGuard(() => L.parseLsJson('Fatal: unable to open repository\nis a directory'));
});

// ---------------------------------------------------------------- mount naming

test('mountUnitName: builds hangar-mount-<repoId>', () => {
    assert.equal(L.mountUnitName('main'), 'hangar-mount-main');
    assert.equal(L.mountUnitName('offsite-b2-01'), 'hangar-mount-offsite-b2-01');
    assert.equal(L.mountUnitName({ id: 'main' }), 'hangar-mount-main');
    assert.equal(L.mountUnitService('main'), 'hangar-mount-main.service');
});

test('mountUnitName: rejects every id shape secrets.js rejects', () => {
    ['', 'Main', 'main repo', 'main/../etc', '../etc', '-main', 'main:1', 'main\n', 'ünï', null, 7, {}]
        .forEach((bad) => assertGuard(() => L.mountUnitName(bad)));
    assertGuard(() => L.mountUnitName('a'.repeat(65)));
});

test('mountPoint: lands under the transient run directory', () => {
    assert.equal(L.mountPoint('main'), '/run/hangar/mnt/main');
    assert.equal(L.MOUNT_ROOT, '/run/hangar/mnt');
    assertGuard(() => L.mountPoint('../../etc'));
});

// ---------------------------------------------------------------- formatRelative

test('formatRelative: anything inside 45 seconds is just now', () => {
    assert.equal(L.formatRelative(NOW, NOW), 'just now');
    assert.equal(L.formatRelative(NOW - 44 * SEC, NOW), 'just now');
    assert.equal(L.formatRelative(NOW + 44 * SEC, NOW), 'just now');
});

test('formatRelative: the minute boundaries', () => {
    assert.equal(L.formatRelative(NOW - 45 * SEC, NOW), '1 minute ago');
    assert.equal(L.formatRelative(NOW - 89 * SEC, NOW), '1 minute ago');
    assert.equal(L.formatRelative(NOW - 90 * SEC, NOW), '2 minutes ago');
    assert.equal(L.formatRelative(NOW - 44 * MIN, NOW), '44 minutes ago');
});

test('formatRelative: the hour boundaries', () => {
    assert.equal(L.formatRelative(NOW - 45 * MIN, NOW), '1 hour ago');
    assert.equal(L.formatRelative(NOW - 89 * MIN, NOW), '1 hour ago');
    assert.equal(L.formatRelative(NOW - 90 * MIN, NOW), '2 hours ago');
    assert.equal(L.formatRelative(NOW - 3 * HOUR, NOW), '3 hours ago');
    assert.equal(L.formatRelative(NOW - 21 * HOUR, NOW), '21 hours ago');
});

test('formatRelative: the day boundaries', () => {
    assert.equal(L.formatRelative(NOW - 22 * HOUR, NOW), '1 day ago');
    assert.equal(L.formatRelative(NOW - 35 * HOUR, NOW), '1 day ago');
    assert.equal(L.formatRelative(NOW - 36 * HOUR, NOW), '2 days ago');
    assert.equal(L.formatRelative(NOW - 25 * DAY, NOW), '25 days ago');
});

test('formatRelative: the month boundaries', () => {
    assert.equal(L.formatRelative(NOW - 26 * DAY, NOW), '1 month ago');
    assert.equal(L.formatRelative(NOW - 45 * DAY, NOW), '1 month ago');
    assert.equal(L.formatRelative(NOW - 46 * DAY, NOW), '2 months ago');
    assert.equal(L.formatRelative(NOW - 319 * DAY, NOW), '11 months ago');
});

test('formatRelative: the year boundaries', () => {
    assert.equal(L.formatRelative(NOW - 320 * DAY, NOW), '1 year ago');
    assert.equal(L.formatRelative(NOW - 547 * DAY, NOW), '1 year ago');
    assert.equal(L.formatRelative(NOW - 548 * DAY, NOW), '2 years ago');
    assert.equal(L.formatRelative(NOW - 10 * 365 * DAY, NOW), '10 years ago');
});

test('formatRelative: it never says "1 minutes" or "1 hours"', () => {
    for (let s = 0; s < 400 * DAY; s += 7 * MIN + 13 * SEC) {
        const label = L.formatRelative(NOW - s, NOW);
        assert.ok(!/\b1 (minutes|hours|days|months|years)\b/.test(label), label);
        assert.ok(!/\b([02-9]|\d\d+) (minute|hour|day|month|year) /.test(label), label);
    }
});

test('formatRelative: a skewed clock reads forwards, not as negative time', () => {
    assert.equal(L.formatRelative(NOW + 3 * HOUR, NOW), 'in 3 hours');
    assert.equal(L.formatRelative(NOW + 2 * DAY, NOW), 'in 2 days');
});

test('formatRelative: accepts ISO strings, Dates and epoch millis alike', () => {
    const then = '2026-08-01T09:00:00Z';
    assert.equal(L.formatRelative(then, NOW), '3 hours ago');
    assert.equal(L.formatRelative(new Date(then), NOW), '3 hours ago');
    assert.equal(L.formatRelative(Date.parse(then), new Date(NOW)), '3 hours ago');
    assert.equal(L.formatRelative(then, '2026-08-01T12:00:00Z'), '3 hours ago');
});

test('formatRelative: an unusable timestamp says so instead of lying', () => {
    assert.equal(L.formatRelative(null, NOW), 'unknown');
    assert.equal(L.formatRelative(undefined, NOW), 'unknown');
    assert.equal(L.formatRelative('', NOW), 'unknown');
    assert.equal(L.formatRelative('soon', NOW), 'unknown');
    assert.equal(L.formatRelative(NaN, NOW), 'unknown');
});

test('formatRelative: omitting now uses the wall clock', () => {
    assert.equal(L.formatRelative(new Date()), 'just now');
});

// ---------------------------------------------------------------- mount argv

const MOUNT_OPTS = { repoId: 'main', repoUrl: 's3:s3.eu-central-1.amazonaws.com/backups' };

test('buildMountArgv: mounts through a named transient unit, not a child process', () => {
    assert.deepEqual(L.buildMountArgv(MOUNT_OPTS), [
        'systemd-run',
        '--unit=hangar-mount-main',
        '--description=hangar Logbook mount for main',
        '--collect',
        '--service-type=exec',
        'restic',
        '-r', 's3:s3.eu-central-1.amazonaws.com/backups',
        '--password-file', '/etc/hangar/repos/main.key',
        // A systemd unit has no $HOME, and restic exits 1 rather than mounting
        // when it cannot place its cache.
        '--cache-dir', '/var/cache/hangar/restic',
        'mount',
        '/run/hangar/mnt/main'
    ]);
});

test('buildMountArgv: the password never appears in argv, only its file', () => {
    const argv = L.buildMountArgv({ ...MOUNT_OPTS, password: 'hunter2' });
    assert.ok(!argv.some((a) => String(a).indexOf('hunter2') >= 0));
    assert.ok(argv.includes('--password-file'));
});

test('buildMountArgv: backend credentials go through EnvironmentFile, never --setenv', () => {
    const argv = L.buildMountArgv({ ...MOUNT_OPTS, envFile: '/etc/hangar/repos/main.env' });
    assert.ok(argv.includes('--property=EnvironmentFile=/etc/hangar/repos/main.env'));
    assert.ok(!argv.some((a) => String(a).indexOf('--setenv') === 0));
});

test('buildMountArgv: an optional runtime cap and allow-other are passed through', () => {
    const argv = L.buildMountArgv({ ...MOUNT_OPTS, maxRuntimeSec: 3600, allowOther: true });
    assert.ok(argv.includes('--property=RuntimeMaxSec=3600'));
    assert.equal(argv[argv.length - 2], '--allow-other');
    assert.equal(argv[argv.length - 1], '/run/hangar/mnt/main');
});

test('buildMountArgv: overrides for binary, mount point and password file are honoured', () => {
    const argv = L.buildMountArgv({
        ...MOUNT_OPTS,
        resticBinary: '/usr/local/bin/restic',
        mountPoint: '/run/hangar/mnt/alt',
        passwordFile: '/etc/hangar/repos/alt.key'
    });
    assert.ok(argv.includes('/usr/local/bin/restic'));
    assert.ok(argv.includes('/etc/hangar/repos/alt.key'));
    assert.equal(argv[argv.length - 1], '/run/hangar/mnt/alt');
});

test('buildMountArgv: a newline anywhere would inject a unit directive, so it is refused', () => {
    assertGuard(() => L.buildMountArgv({ repoId: 'main', repoUrl: 'sftp:u@h:/p\nExecStart=/bin/sh' }));
    assertGuard(() => L.buildMountArgv({ ...MOUNT_OPTS, mountPoint: '/run/x\nType=oneshot' }));
    assertGuard(() => L.buildMountArgv({ ...MOUNT_OPTS, envFile: '/etc/x\nUser=root' }));
    assertGuard(() => L.buildMountArgv({ ...MOUNT_OPTS, passwordFile: '/etc/x\ny' }));
});

test('buildMountArgv: missing or malformed inputs are typed failures', () => {
    assertGuard(() => L.buildMountArgv({ repoId: 'main' }));
    assertGuard(() => L.buildMountArgv({ repoId: 'main', repoUrl: '' }));
    assertGuard(() => L.buildMountArgv({ repoId: '../etc', repoUrl: '/srv/repo' }));
    assertGuard(() => L.buildMountArgv({ ...MOUNT_OPTS, envFile: 'relative.env' }));
    assertGuard(() => L.buildMountArgv({ ...MOUNT_OPTS, maxRuntimeSec: 0 }));
    assertGuard(() => L.buildMountArgv({ ...MOUNT_OPTS, maxRuntimeSec: 1.5 }));
    assertGuard(() => L.buildMountArgv());
});

test('buildMountArgv: a repo object is accepted in place of an id', () => {
    const argv = L.buildMountArgv({ repo: { id: 'main' }, repoUrl: '/srv/repo' });
    assert.ok(argv.includes('--unit=hangar-mount-main'));
});

// ---------------------------------------------------------------- mount state

test('normalizeMountState: an active unit is mounted', () => {
    const s = L.normalizeMountState('main', {
        LoadState: { t: 's', v: 'loaded' },
        ActiveState: { t: 's', v: 'active' },
        SubState: { t: 's', v: 'running' },
        Result: { t: 's', v: 'success' }
    });
    assert.equal(s.unit, 'hangar-mount-main.service');
    assert.equal(s.mountPoint, '/run/hangar/mnt/main');
    assert.equal(s.mounted, true);
    assert.equal(s.failed, false);
    assert.equal(s.subState, 'running');
});

test('normalizeMountState: activating is not yet mounted', () => {
    assert.equal(L.normalizeMountState('main', { ActiveState: { v: 'activating' } }).mounted, false);
});

test('normalizeMountState: a missing unit reads as not mounted, not as an error', () => {
    const s = L.normalizeMountState('main', {});
    assert.equal(s.loadState, 'not-found');
    assert.equal(s.activeState, 'inactive');
    assert.equal(s.mounted, false);
    assert.equal(s.failed, false);
});

test('normalizeMountState: a failed mount is reported as failed', () => {
    const s = L.normalizeMountState('main', { ActiveState: { v: 'failed' }, Result: { v: 'exit-code' } });
    assert.equal(s.failed, true);
    assert.equal(s.result, 'exit-code');
});

test('unwrapProps: tolerates unwrapped values and junk', () => {
    assert.deepEqual(L.unwrapProps({ A: { t: 's', v: 'x' }, B: 'y' }), { A: 'x', B: 'y' });
    assert.deepEqual(L.unwrapProps(null), {});
    assert.deepEqual(L.unwrapProps('nope'), {});
});

// ---------------------------------------------------------------- I/O guards

test('the module loads and its I/O layer rejects cleanly with no cockpit present', async () => {
    delete globalThis.cockpit;
    await assert.rejects(L.mount({ repoId: 'main', repoUrl: '/srv/repo' }),
        (e) => e.name === 'HangarError' && e.kind === Errors.KIND.GENERIC);
    await assert.rejects(L.unmount('main'),
        (e) => e.name === 'HangarError' && e.kind === Errors.KIND.GENERIC);
    await assert.rejects(L.isMounted('main'),
        (e) => e.name === 'HangarError' && e.kind === Errors.KIND.GENERIC);
});

test('the I/O layer rejects an invalid repo id before touching cockpit', async () => {
    let touched = false;
    globalThis.cockpit = { spawn() { touched = true; return Promise.resolve(''); }, dbus() { touched = true; return {}; } };
    try {
        await assert.rejects(L.mount({ repoId: '../etc', repoUrl: '/srv/repo' }), (e) => e.name === 'HangarError');
        await assert.rejects(L.unmount('../etc'), (e) => e.name === 'HangarError');
        await assert.rejects(L.isMounted('../etc'), (e) => e.name === 'HangarError');
        assert.equal(touched, false);
    } finally {
        delete globalThis.cockpit;
    }
});

test('mount: creates a private mount point, then hands the mount to systemd', async () => {
    const spawns = [];
    globalThis.cockpit = {
        spawn(argv, opts) { spawns.push({ argv, opts }); return Promise.resolve(''); }
    };
    try {
        const r = await L.mount({ repoId: 'main', repoUrl: '/srv/repo' });
        // A dead FUSE mount is cleared before anything stats the path: reading a
        // mountpoint whose server has died returns ENOTCONN, and `install -d`
        // reads it.
        // By content, not by position: the sequence gained a stale-mount check
        // and pinning indexes only teaches the next person to renumber them.
        const cmds = spawns.map((sp) => sp.argv.join(' '));
        const install = spawns.find((sp) => sp.argv[0] === 'install');
        assert.deepEqual(install.argv,
            ['install', '-d', '-m', '0700', '-o', 'root', '-g', 'root', '/run/hangar/mnt/main']);
        assert.equal(install.opts.superuser, 'require');
        const run = spawns.find((sp) => sp.argv[0] === 'systemd-run');
        assert.ok(run, 'and the unit is started');
        assert.equal(run.opts.superuser, 'require');
        assert.ok(cmds.indexOf(install.argv.join(' ')) < cmds.indexOf(run.argv.join(' ')),
            'the directory exists before the mount is asked for');
        assert.deepEqual(r, { unit: 'hangar-mount-main.service', mountPoint: '/run/hangar/mnt/main' });
    } finally {
        delete globalThis.cockpit;
    }
});

test('mount: a spawn failure surfaces as a typed error', async () => {
    globalThis.cockpit = { spawn() { return Promise.reject(new Error('Unit already exists')); } };
    try {
        await assert.rejects(L.mount({ repoId: 'main', repoUrl: '/srv/repo' }), (e) => {
            assert.equal(e.name, 'HangarError');
            assert.equal(e.kind, Errors.KIND.GENERIC);
            assert.equal(e.detail.op, 'mount');
            return true;
        });
    } finally {
        delete globalThis.cockpit;
    }
});

test('unmount: stops the unit over D-Bus and clears a failed state', async () => {
    const calls = [];
    globalThis.cockpit = {
        dbus() {
            return {
                call(p, iface, method, args) { calls.push({ method, args }); return Promise.resolve([null]); }
            };
        }
    };
    try {
        const r = await L.unmount('main');
        assert.deepEqual(calls.map((c) => c.method), ['StopUnit', 'ResetFailedUnit']);
        assert.deepEqual(calls[0].args, ['hangar-mount-main.service', 'replace']);
        assert.deepEqual(r, { unit: 'hangar-mount-main.service', mountPoint: '/run/hangar/mnt/main' });
    } finally {
        delete globalThis.cockpit;
    }
});

test('unmount: a unit that was never there still unmounts successfully', async () => {
    globalThis.cockpit = {
        dbus() {
            return {
                call(p, iface, method) {
                    if (method === 'ResetFailedUnit') return Promise.reject(new Error('no such unit'));
                    return Promise.resolve([null]);
                }
            };
        }
    };
    try {
        await L.unmount('main');            // ResetFailedUnit failing is not a failure to unmount
    } finally {
        delete globalThis.cockpit;
    }
});

test('isMounted: asks systemd rather than remembering', async () => {
    const calls = [];
    globalThis.cockpit = {
        dbus() {
            return {
                call(p, iface, method, args) {
                    calls.push(method);
                    if (method === 'LoadUnit') return Promise.resolve(['/org/freedesktop/systemd1/unit/x']);
                    return Promise.resolve([{ ActiveState: { t: 's', v: 'active' }, SubState: { t: 's', v: 'running' } }]);
                }
            };
        }
    };
    try {
        const s = await L.isMounted('main');
        assert.deepEqual(calls, ['LoadUnit', 'GetAll']);
        assert.equal(s.mounted, true);
        assert.equal(s.mountPoint, '/run/hangar/mnt/main');
    } finally {
        delete globalThis.cockpit;
    }
});

// ---------------------------------------------------------------- house rules

test('the module obeys the house pattern: no ES modules, dual export, guarded cockpit', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../js/core/logbook.js'), 'utf8');
    assert.ok(!/^\s*(import|export)\s/m.test(src), 'no import/export keywords');
    assert.ok(src.includes('root.HangarLogbook = HangarLogbook'));
    assert.ok(src.includes('module.exports = HangarLogbook'));
    // Every bare `cockpit` reference must sit behind the typeof guard.
    assert.ok(src.includes("typeof cockpit !== 'undefined'"));
    // The feature is the Logbook. "Time Machine" is a description, never a name.
    assert.ok(!/time\s*machine/i.test(src), 'the feature is named Logbook');
});

// ============================================================ hardening
//
// Everything below is an adversarial pass over the same surface. The standing
// rule it enforces: a corrupt repository, a skewed clock or a hand-edited
// config may make this module fail, but it may only fail as a typed
// HangarError. A bare TypeError or RangeError reaching the UI is a bug,
// because `kind` is what decides which remediation the operator is offered.

const NUL = String.fromCharCode(0);
const MAX_MS = 8640000000000000;        // the largest instant a Date can hold

function assertGuardAsync(promise) {
    return assert.rejects(promise, (e) => {
        assert.equal(e.name, 'HangarError', 'not a HangarError');
        assert.equal(e.kind, Errors.KIND.GENERIC);
        return true;
    });
}

// ------------------------------------------------- the edge of the Date range

test('buildTimeline: an epoch past the end of time is undated, not a RangeError', () => {
    // isFinite() accepts 1e16; Date does not. The Invalid Date it produces is
    // truthy, and toISOString() on the band start would throw untyped.
    const bands = L.buildTimeline([snap('good', HOUR), { id: 'far', time: 1e16 }], NOW);
    assert.equal(bands.length, 2);
    assert.deepEqual(ids(bands[1]), ['far']);
    assert.equal(bands[1].key, 'unknown');
});

test('buildTimeline: every unrepresentable epoch lands in the unknown band', () => {
    [MAX_MS + 1, -MAX_MS - 1, 1e300, -1e300, Number.MAX_VALUE, Infinity, -Infinity, NaN]
        .forEach((t) => {
            const bands = L.buildTimeline([{ id: 'x', time: t }], NOW);
            assert.equal(bands.length, 1, String(t));
            assert.equal(bands[0].key, 'unknown', String(t));
        });
});

test('buildTimeline: the last representable instant still gets a real band', () => {
    const bands = L.buildTimeline([{ id: 'max', time: MAX_MS }], NOW);
    assert.equal(bands[0].granularity, L.GRANULARITY.HOUR);   // it is in the future
    assert.equal(bands[0].key, 'hour:275760-09-13T00');
    assert.ok(bands[0].start.endsWith('Z'));
});

test('buildTimeline: the first representable instant has no representable band start', () => {
    // Its month would begin before the range Date can express, so there is no
    // band to hang it under — it joins the undated rather than crashing.
    const bands = L.buildTimeline([{ id: 'min', time: -MAX_MS }], NOW);
    assert.equal(bands.length, 1);
    assert.equal(bands[0].granularity, L.GRANULARITY.UNKNOWN);
    assert.deepEqual(ids(bands[0]), ['min']);
});

test('buildTimeline: an unusable `now` falls back to the wall clock rather than skewing every band', () => {
    const recent = [{ id: 'a', time: new Date().toISOString() }];
    [1e16, -1e16, NaN, Infinity, 'not a date', '', {}, [], true, new Date(NaN)].forEach((now) => {
        const bands = L.buildTimeline(recent, now);
        assert.equal(bands.length, 1, String(now));
        assert.equal(bands[0].granularity, L.GRANULARITY.HOUR, String(now));
    });
});

test('snapshotTimestampDir: an unrepresentable epoch throws instead of naming NaN-NaN-NaN', () => {
    assertGuard(() => L.snapshotTimestampDir(1e16));
    assertGuard(() => L.snapshotTimestampDir(-1e16));
    assertGuard(() => L.snapshotTimestampDir(Infinity));
    assertGuard(() => L.snapshotPath('/mnt/x', { time: MAX_MS + 1 }));
});

test('formatRelative: an unrepresentable epoch is unknown, not "just now"', () => {
    assert.equal(L.formatRelative(1e16, NOW), 'unknown');
    assert.equal(L.formatRelative(-1e16, NOW), 'unknown');
    assert.equal(L.formatRelative(Infinity, NOW), 'unknown');
    assert.equal(L.formatRelative(new Date(NaN), NOW), 'unknown');
});

// ------------------------------------------------- years Date.UTC would fold

test('buildTimeline: Go\'s zero time is filed under year 1, not 1901', () => {
    // A snapshot whose time Go never set serialises as 0001-01-01T00:00:00Z.
    // Date.UTC(1, 0, 1) is 1901 — a century away from where anyone would look.
    const bands = L.buildTimeline([{ id: 'zero', time: '0001-01-01T00:00:00Z' }], NOW);
    assert.equal(bands[0].key, 'month:0001-01');
    assert.equal(bands[0].label, 'January 0001');
    assert.equal(bands[0].start, '0001-01-01T00:00:00.000Z');
});

test('buildTimeline: a two-digit year is not folded onto the twentieth century', () => {
    const bands = L.buildTimeline([{ id: 'a', time: '0099-06-15T12:00:00Z' }], NOW);
    assert.equal(bands[0].key, 'month:0099-06');
    assert.equal(bands[0].start, '0099-06-01T00:00:00.000Z');
});

test('snapshotTimestampDir: a low year keeps its four digits', () => {
    // restic names the directory in RFC3339; "1-01-01T00:00:00Z" is a directory
    // the mount does not contain.
    assert.equal(L.snapshotTimestampDir(new Date('0001-01-01T00:00:00Z')), '0001-01-01T00:00:00Z');
    assert.equal(L.snapshotTimestampDir('0001-01-01T00:00:00Z'), '0001-01-01T00:00:00Z');
    assert.equal(L.snapshotPath('/mnt/x', { time: new Date('0099-06-15T12:00:00Z') }),
        '/mnt/x/snapshots/0099-06-15T12:00:00Z');
});

// ------------------------------------------------- buildTimeline hostile input

test('buildTimeline: a bare Date, string or epoch is accepted as its own snapshot', () => {
    const t = new Date(NOW - HOUR);
    ['string', 'date', 'number'].forEach((kind) => {
        const value = kind === 'date' ? t : (kind === 'number' ? t.getTime() : t.toISOString());
        const bands = L.buildTimeline([value], NOW);
        assert.equal(bands.length, 1, kind);
        assert.equal(bands[0].key, 'hour:2026-08-01T11', kind);
        assert.equal(bands[0].snapshots[0], value, kind);   // returned by identity
    });
});

test('buildTimeline: holes in a sparse array are skipped, not banded as undated', () => {
    assert.deepEqual(L.buildTimeline(new Array(5), NOW), []);
});

test('buildTimeline: hostile element types all land in the unknown band, in order', () => {
    const hostile = [true, false, [], {}, 'not a date', '', '   ', NUL, () => 1,
        { time: {} }, { time: [] }, { time: true }, { time: NaN }, { time: '' }];
    const bands = L.buildTimeline(hostile.concat([snap('good', HOUR)]), NOW);
    assert.equal(bands.length, 2);
    assert.equal(bands[0].key, 'hour:2026-08-01T11');
    assert.equal(bands[1].key, 'unknown');
    assert.equal(bands[1].snapshots.length, hostile.length);
    assert.deepEqual(bands[1].snapshots, hostile);           // order preserved
});

test('buildTimeline: an object with a numeric-string time still bands', () => {
    // JSON from a hand-edited file can carry the epoch as a string.
    const bands = L.buildTimeline([{ id: 'a', time: '2026-08-01T11:30:00Z' }], NOW);
    assert.equal(bands[0].key, 'hour:2026-08-01T11');
});

test('buildTimeline: the input array and its snapshots are left untouched', () => {
    const list = [{ id: 'a', time: '2026-08-01T10:00:00Z' }, { id: 'b', time: '2026-08-01T11:00:00Z' }];
    const before = JSON.stringify(list);
    L.buildTimeline(list, NOW);
    assert.equal(JSON.stringify(list), before);
    assert.deepEqual(list.map((s) => s.id), ['a', 'b']);     // not sorted in place
});

test('buildTimeline: a large history bands without crashing and stays ordered', () => {
    const list = [];
    for (let i = 0; i < 5000; i++) list.push(snap('i' + i, i * 3 * HOUR));
    const bands = L.buildTimeline(list, NOW);
    assert.ok(bands.length > 4);
    const keys = bands.map((b) => b.key);
    assert.equal(new Set(keys).size, keys.length, 'band keys must be unique');
    for (let i = 1; i < bands.length; i++)
        assert.ok(bands[i - 1].startMs >= bands[i].startMs, 'bands must not ascend');
    const total = bands.reduce((n, b) => n + b.snapshots.length, 0);
    assert.equal(total, 5000, 'no snapshot may be dropped');
});

test('buildTimeline: no snapshot is ever lost, whatever the mix of shapes', () => {
    const list = [snap('a', MIN), snap('b', 3 * DAY), snap('c', 30 * DAY), snap('d', 400 * DAY),
        { id: 'e' }, { id: 'f', time: 'junk' }, null, undefined, 7, '2026-08-01T11:00:00Z'];
    const bands = L.buildTimeline(list, NOW);
    const seen = bands.reduce((n, b) => n + b.snapshots.length, 0);
    assert.equal(seen, list.length);
});

test('buildTimeline: a non-array input is typed for every hostile shape', () => {
    [0, 1, true, false, 'list', NUL, {}, { length: 2 }, () => [], new Date(), Symbol('s')]
        .forEach((bad) => assertGuard(() => L.buildTimeline(bad, NOW)));
});

// ------------------------------------------------- band helpers

test('granularityFor: a nonsense age still returns a granularity rather than throwing', () => {
    assert.equal(L.granularityFor(NaN), L.GRANULARITY.MONTH);
    assert.equal(L.granularityFor(Infinity), L.GRANULARITY.MONTH);
    assert.equal(L.granularityFor(-Infinity), L.GRANULARITY.HOUR);
});

test('bucketStart, bucketKey and bandLabel fall back to the month bucket for an unknown granularity', () => {
    const d = new Date('2026-08-01T13:45:00Z');
    const start = L.bucketStart(d, 'fortnight');
    assert.equal(start, Date.UTC(2026, 7, 1));
    assert.equal(L.bucketKey(start, 'fortnight'), 'month:2026-08');
    assert.equal(L.bandLabel(start, 'fortnight'), 'August 2026');
});

test('bucketKey: the same instant yields four distinct keys, one per granularity', () => {
    const d = new Date('2026-07-15T09:30:00Z');
    const keys = ['hour', 'day', 'week', 'month'].map((g) => L.bucketKey(L.bucketStart(d, g), g));
    assert.deepEqual(keys, ['hour:2026-07-15T09', 'day:2026-07-15', 'week:2026-07-13', 'month:2026-07']);
    assert.equal(new Set(keys).size, 4);
});

test('bandLabel: the weekday is the UTC one', () => {
    assert.equal(L.bandLabel(Date.UTC(2026, 6, 19), 'day'), 'Sun 19 Jul 2026');
    assert.equal(L.bandLabel(Date.UTC(2026, 6, 13), 'day'), 'Mon 13 Jul 2026');
});

// ------------------------------------------------- snapshot paths

test('snapshotPath: a NUL byte in the mount root is refused, not silently truncated', () => {
    // A NUL ends the string at the syscall, so '/run/x\0/../../etc' would open
    // '/run/x'. The regex that catches it must stay visible in the source.
    assertGuard(() => L.snapshotPath('/run/hangar/mnt' + NUL + '/etc', { time: '2026-07-30T02:00:11Z' }));
    assertGuard(() => L.snapshotPath(NUL, { time: '2026-07-30T02:00:11Z' }));
    assertGuard(() => L.snapshotPath('/mnt/x\r', { time: '2026-07-30T02:00:11Z' }));
});

test('snapshotPath: a mount root that is not a string is typed, whatever it is', () => {
    [0, 1, true, false, [], {}, ['/mnt/x'], new Date(), () => '/mnt/x', Symbol('s'), '   ']
        .forEach((bad) => assertGuard(() => L.snapshotPath(bad, { time: '2026-07-30T02:00:11Z' })));
});

test('snapshotPath: spaces and unicode are legal in a path, only control characters are not', () => {
    // The mount root is a filesystem path, not a unit-file line; rejecting a
    // space here would lock out perfectly valid directories.
    assert.equal(L.snapshotPath('/mnt/my backups', { time: '2026-07-30T02:00:11Z' }),
        '/mnt/my backups/snapshots/2026-07-30T02:00:11Z');
    assert.equal(L.snapshotPath('/mnt/données/日本語', { time: '2026-07-30T02:00:11Z' }),
        '/mnt/données/日本語/snapshots/2026-07-30T02:00:11Z');
});

test('snapshotPath: a very long mount root is passed through whole', () => {
    const root = '/' + 'a'.repeat(4096);
    assert.equal(L.snapshotPath(root, { time: '2026-07-30T02:00:11Z' }),
        root + '/snapshots/2026-07-30T02:00:11Z');
});

test('snapshotPath: a bare slash names the snapshots directory at the root', () => {
    assert.equal(L.snapshotPath('/', { time: '2026-07-30T02:00:11Z' }), '/snapshots/2026-07-30T02:00:11Z');
});

test('snapshotPath: the dedup index rejects everything that is not a small whole number', () => {
    const s = { time: '2026-07-30T02:00:11Z' };
    [-1, 1.5, NaN, Infinity, -Infinity, '1', true, [], {}, 1e21, Number.MAX_VALUE, () => 1]
        .forEach((bad) => assertGuard(() => L.snapshotPath('/mnt/x', s, bad)));
    // 1e21 is an "integer" whose decimal form is "1e+21" — a directory name
    // restic could never have written.
    assert.equal(L.snapshotPath('/mnt/x', s, Number.MAX_SAFE_INTEGER),
        '/mnt/x/snapshots/2026-07-30T02:00:11Z-9007199254740991');
    assert.equal(L.snapshotPath('/mnt/x', s, -0), '/mnt/x/snapshots/2026-07-30T02:00:11Z');
});

test('snapshotTimestampDir: a timestamp that is only shaped like RFC3339 in part is refused', () => {
    ['12026-07-30T02:00:11Z', '26-07-30T02:00:11Z', '2026-7-30T02:00:11Z',
        '2026-07-30T02:00:11Z/../etc', '2026-07-30T02:00:11Z\nExecStart=/bin/sh',
        '/etc/passwd', '../../etc', 'snapshots/../../etc/shadow', '2026-07-30T02:00:11Z-1']
        .forEach((bad) => assertGuard(() => L.snapshotTimestampDir(bad)));
});

test('snapshotTimestampDir: trailing junk is dropped by the parser, never carried into the name', () => {
    // The regex refuses it, so it falls through to Date parsing, which stops at
    // the timestamp. What matters is that nothing after the timestamp survives
    // into a string that becomes a path segment.
    assert.equal(L.snapshotTimestampDir('2026-07-30T02:00:11Z' + NUL + 'x'), '2026-07-30T02:00:11Z');
});

test('snapshotTimestampDir: the shapes restic actually emits do not move with the host timezone', () => {
    const inputs = ['2026-07-30T02:00:11Z', '2026-07-30T02:00:11+03:00', '2026-07-30T02:00:11',
        '2026-07-30T02:00:11.123456789Z', new Date(Date.UTC(2026, 6, 30, 2, 0, 11)),
        Date.UTC(2026, 6, 30, 2, 0, 11)];
    const original = process.env.TZ;
    try {
        process.env.TZ = 'UTC';
        const utc = inputs.map((v) => L.snapshotTimestampDir(v));
        process.env.TZ = 'Pacific/Kiritimati';       // UTC+14
        assert.deepEqual(inputs.map((v) => L.snapshotTimestampDir(v)), utc);
        process.env.TZ = 'Pacific/Midway';           // UTC-11
        assert.deepEqual(inputs.map((v) => L.snapshotTimestampDir(v)), utc);
        assert.equal(utc[2], '2026-07-30T02:00:11Z', 'a zoneless restic timestamp is read as UTC');
    } finally {
        if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
    }
});

test('snapshotTimestampDir: surrounding whitespace is tolerated, interior injection is not', () => {
    assert.equal(L.snapshotTimestampDir('  2026-07-30T02:00:11Z  '), '2026-07-30T02:00:11Z');
    assert.equal(L.snapshotTimestampDir('2026-07-30T02:00:11Z\n'), '2026-07-30T02:00:11Z');
    assertGuard(() => L.snapshotTimestampDir('2026-07-30T02:00:11Z\nType=oneshot'));
});

test('snapshotTimestampDir: the name it returns never carries a control character', () => {
    // Whatever the input, the output is interpolated into a path, so it has to
    // come back clean or not at all.
    const inputs = ['2026-07-30T02:00:11Z', '2026-07-30T02:00:11+03:00', '2026-07-30 02:00:11z',
        '2026-07-30T02:00:11.123456789-0430', new Date(NOW), NOW, '2026-07-30T02:00:11Z' + NUL];
    inputs.forEach((v) => {
        const name = L.snapshotTimestampDir(v);
        assert.ok(!/[\u0000-\u001f\u007f]/.test(name), JSON.stringify(name));
    });
});

test('snapshotTimestampDir: a snapshot object with a hostile time is typed, never guessed', () => {
    [{}, { time: null }, { time: undefined }, { time: {} }, { time: [] }, { time: true },
        { time: NaN }, { time: '' }, { time: '   ' }, { time: NUL }, null, undefined, true, [],
        () => 1].forEach((bad) => assertGuard(() => L.snapshotTimestampDir(bad)));
});

// ------------------------------------------------- diff badges

test('diffToBadges: the map has a null prototype so no path can reach Object.prototype', () => {
    const badges = L.diffToBadges([{ path: '/a', modifier: '+' }]);
    assert.equal(Object.getPrototypeOf(badges), null);
});

test('diffToBadges: a raw document whose change is named __proto__ stays an own property', () => {
    const doc = JSON.parse('{"changes":[{"path":"__proto__","modifier":"+"},{"path":"/b","modifier":"-"}]}');
    const badges = L.diffToBadges(doc);
    assert.ok(Object.prototype.hasOwnProperty.call(badges, '__proto__'));
    assert.equal(badges['__proto__'], 'added');
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.toString.call({}), '[object Object]');
});

test('diffToBadges: constructor and toString are ordinary paths, not machinery', () => {
    const badges = L.diffToBadges([{ path: 'constructor', modifier: '+' }, { path: 'toString', modifier: '-' }]);
    assert.equal(badges['constructor'], 'added');
    assert.equal(badges['toString'], 'removed');
    assert.deepEqual(Object.keys(badges).sort(), ['constructor', 'toString']);
});

test('diffToBadges: every non-object diff is a typed failure', () => {
    [true, false, 0, 1, 'text', NUL, () => [], Symbol('s')]
        .forEach((bad) => assertGuard(() => L.diffToBadges(bad)));
});

test('diffToBadges: an object with no changes at all is an empty map, not a failure', () => {
    [new Date(), { changes: null }, { changes: 'x' }, { changes: {} }, { added: null },
        { added: 'x' }, [], Object.create(null)].forEach((v) => {
        assert.deepEqual({ ...L.diffToBadges(v) }, {}, JSON.stringify(v));
    });
});

test('diffToBadges: the parsed lists and a raw changes array in one document are merged', () => {
    const badges = { ...L.diffToBadges({
        added: [{ path: '/from-list' }],
        changes: [{ path: '/from-raw', modifier: '-' }]
    }) };
    assert.deepEqual(badges, { '/from-list': 'added', '/from-raw': 'removed' });
});

test('diffToBadges: entries in the parsed lists that are not objects are skipped', () => {
    const badges = { ...L.diffToBadges({ added: ['/a', null, 7, true], removed: [{ path: '/b' }] }) };
    assert.deepEqual(badges, { '/b': 'removed' });
});

test('diffToBadges: a non-string path is stringified rather than dropped or thrown on', () => {
    const badges = { ...L.diffToBadges([{ path: 0, modifier: '+' }, { path: 12, modifier: '-' },
        { path: true, modifier: 'M' }, { path: ['/a'], modifier: '+' }]) };
    assert.deepEqual(badges, { '0': 'added', '12': 'removed', 'true': 'modified', '/a': 'added' });
});

test('diffToBadges: a modifier of any type resolves to a badge', () => {
    [null, undefined, 0, 1, true, {}, [], 'MM', 'MT', 'whatever_restic_2_invents']
        .forEach((m) => assert.equal(L.badgeForModifier(m), L.BADGE.MODIFIED, JSON.stringify(m)));
    assert.equal(L.badgeForModifier('+-'), L.BADGE.ADDED, 'a plus wins outright');
    assert.equal(L.badgeForModifier('-+'), L.BADGE.ADDED);
    assert.equal(L.badgeForModifier(['+']), L.BADGE.ADDED, 'String(["+"]) is "+"');
    // The scan is for the character anywhere, not for an exact match, so a
    // compound marker from a future restic still classifies.
    assert.equal(L.badgeForModifier('-M'), L.BADGE.REMOVED);
});

test('diffToBadges: paths with newlines, NUL bytes and unicode survive verbatim as keys', () => {
    const paths = ['/srv/a\nb', '/srv/a' + NUL + 'b', '/srv/ünï', '/srv/  spaces  ',
        '/srv/' + 'x'.repeat(20000), '/srv/../../etc/shadow'];
    const badges = L.diffToBadges(paths.map((p) => ({ path: p, modifier: 'M' })));
    paths.forEach((p) => assert.equal(badges[p], 'modified', JSON.stringify(p.slice(0, 40))));
    assert.equal(Object.keys(badges).length, paths.length);
});

test('diffToBadges: a large diff classifies every path exactly once', () => {
    const changes = [];
    for (let i = 0; i < 20000; i++) changes.push({ path: '/srv/f' + i, modifier: i % 2 ? '+' : '-' });
    const badges = L.diffToBadges(changes);
    assert.equal(Object.keys(badges).length, 20000);
    assert.equal(badges['/srv/f1'], 'added');
    assert.equal(badges['/srv/f2'], 'removed');
});

// ------------------------------------------------- ls fallback parser

test('parseLsJson: a non-string input is coerced, never thrown on', () => {
    [7, 0, true, false].forEach((v) => assert.deepEqual(L.parseLsJson(v), { snapshot: null, nodes: [] }));
    // An object stringifies to something unparseable, which IS a parse failure.
    assertGuard(() => L.parseLsJson({}));
    assertGuard(() => L.parseLsJson([1, 2]));
});

test('parseLsJson: JSON literals that are not records are counted as parsed, not as failures', () => {
    ['null', 'false', '0', '""', '[]', '{}'].forEach((line) =>
        assert.deepEqual(L.parseLsJson(line), { snapshot: null, nodes: [] }, line));
});

test('parseLsJson: a byte-order mark on the first line does not hide the first record', () => {
    const out = L.parseLsJson('\ufeff{"message_type":"snapshot","id":"abc"}\n' +
        '{"message_type":"node","name":"a","path":"/a","type":"file"}');
    assert.equal(out.snapshot.id, 'abc');
    assert.equal(out.nodes.length, 1);
});

test('parseLsJson: a NUL byte on its own line is skipped like any other noise', () => {
    const out = L.parseLsJson('{"message_type":"node","name":"a","path":"/a","type":"file"}\n' + NUL);
    assert.equal(out.nodes.length, 1);
});

test('parseLsJson: message_type wins when the legacy struct_type disagrees', () => {
    const out = L.parseLsJson('{"message_type":"node","struct_type":"snapshot","name":"a","path":"/a"}');
    assert.equal(out.snapshot, null);
    assert.equal(out.nodes.length, 1);
});

test('parseLsJson: a snapshot record arriving after the nodes still binds', () => {
    const out = L.parseLsJson('{"message_type":"node","name":"a","path":"/a"}\n' +
        '{"message_type":"snapshot","id":"late"}');
    assert.equal(out.snapshot.id, 'late');
    assert.equal(out.nodes.length, 1);
});

test('parseLsJson: node fields of the wrong type are coerced to something renderable', () => {
    const out = L.parseLsJson(JSON.stringify({
        message_type: 'node', name: 42, type: 7, path: null, size: '184320',
        permissions: 5, mode: null, uid: 'root'
    }));
    const n = out.nodes[0];
    assert.equal(n.name, '42');
    assert.equal(n.type, '7');
    assert.equal(n.path, '');
    assert.equal(n.size, 184320);
    assert.equal(n.permissions, '5');
    assert.equal(n.uid, 'root');
});

test('parseLsJson: a size that is not a finite number reads as zero, never NaN', () => {
    [null, 'abc', {}, [], true, 1e400, -1e400].forEach((size) => {
        const out = L.parseLsJson(JSON.stringify({ message_type: 'node', name: 'a', path: '/a', size: size }));
        assert.equal(Number.isFinite(out.nodes[0].size), true, JSON.stringify(size));
    });
    const neg = L.parseLsJson('{"message_type":"node","name":"a","path":"/a","size":-5}');
    assert.equal(neg.nodes[0].size, -5, 'a negative size is restic\'s problem to report, not ours to hide');
});

test('parseLsJson: a snapshot record with hostile field types normalises without throwing', () => {
    const out = L.parseLsJson(JSON.stringify({
        message_type: 'snapshot', id: 123456789, paths: [1, null, { a: 1 }], tags: 'nightly',
        hostname: 0, tree: false
    }));
    assert.equal(out.snapshot.id, '123456789');
    assert.equal(out.snapshot.shortId, '12345678');
    assert.deepEqual(out.snapshot.paths, ['1', 'null', '[object Object]']);
    assert.deepEqual(out.snapshot.tags, [], 'a string is not a list of tags');
    assert.equal(out.snapshot.hostname, '');
});

test('parseLsJson: a NUL byte inside a node path is preserved rather than silently cut', () => {
    const p = '/srv/a' + NUL + 'b';
    const out = L.parseLsJson(JSON.stringify({ message_type: 'node', name: 'a', path: p, type: 'file' }));
    assert.equal(out.nodes[0].path, p);
});

test('parseLsJson: the failure detail is truncated so a megabyte of noise cannot ride along', () => {
    assert.throws(() => L.parseLsJson('x'.repeat(500000)), (e) => {
        assert.equal(e.name, 'HangarError');
        assert.equal(e.detail.text.length, 2000);
        return true;
    });
});

test('parseLsJson: a very long but valid record parses whole', () => {
    const name = 'n'.repeat(100000);
    const out = L.parseLsJson(JSON.stringify({ message_type: 'node', name: name, path: '/' + name, type: 'file' }));
    assert.equal(out.nodes[0].name.length, 100000);
});

test('parseLsJson: each call returns a fresh result, never a shared one', () => {
    const a = L.parseLsJson('{"message_type":"node","name":"a","path":"/a"}');
    const b = L.parseLsJson('');
    a.nodes.push('mutated');
    assert.deepEqual(b, { snapshot: null, nodes: [] });
    assert.notEqual(a.nodes, b.nodes);
});

// ------------------------------------------------- mount naming

test('mount naming: every entry point rejects the same hostile ids', () => {
    const bad = ['', ' ', 'main ', ' main', 'MAIN', 'main/sub', 'main\\sub', '..', '../etc',
        'main/../../etc', '-main', '_main', 'main!', 'main' + NUL, 'main\n', 'mäin', 'main.key',
        null, undefined, 0, 7, true, [], {}, ['main'], () => 'main', { id: null }, { id: 7 },
        'a'.repeat(65)];
    bad.forEach((id) => {
        assertGuard(() => L.mountUnitName(id));
        assertGuard(() => L.mountUnitService(id));
        assertGuard(() => L.mountPoint(id));
        assertGuard(() => L.normalizeMountState(id, {}));
    });
});

test('mount naming: the longest legal id is accepted at every entry point', () => {
    const id = 'a'.repeat(64);
    assert.equal(L.mountUnitName(id), 'hangar-mount-' + id);
    assert.equal(L.mountUnitService({ id: id }), 'hangar-mount-' + id + '.service');
    assert.equal(L.mountPoint(id), '/run/hangar/mnt/' + id);
});

test('mount naming: a unit name can never contain whitespace or a slash', () => {
    ['main', 'offsite-b2-01', '0', 'a'.repeat(64)].forEach((id) => {
        assert.ok(!/[\s/]/.test(L.mountUnitName(id)), id);
        assert.ok(L.mountPoint(id).startsWith(L.MOUNT_ROOT + '/'), id);
    });
});

// ------------------------------------------------- relative labels

test('formatRelative: every scale boundary reads the same forwards and backwards', () => {
    const table = [
        [45 * SEC, '1 minute'], [90 * SEC, '2 minutes'], [45 * MIN, '1 hour'], [90 * MIN, '2 hours'],
        [22 * HOUR, '1 day'], [36 * HOUR, '2 days'], [26 * DAY, '1 month'], [46 * DAY, '2 months'],
        [320 * DAY, '1 year'], [548 * DAY, '2 years']
    ];
    table.forEach(([d, phrase]) => {
        assert.equal(L.formatRelative(NOW - d, NOW), phrase + ' ago', String(d));
        assert.equal(L.formatRelative(NOW + d, NOW), 'in ' + phrase, String(d));
    });
});

test('formatRelative: one millisecond either side of a boundary picks the right rule', () => {
    assert.equal(L.formatRelative(NOW - (45 * SEC - 1), NOW), 'just now');
    assert.equal(L.formatRelative(NOW - 45 * SEC, NOW), '1 minute ago');
    assert.equal(L.formatRelative(NOW - (90 * SEC - 1), NOW), '1 minute ago');
    assert.equal(L.formatRelative(NOW - (22 * HOUR - 1), NOW), '22 hours ago');
    assert.equal(L.formatRelative(NOW - 22 * HOUR, NOW), '1 day ago');
    assert.equal(L.formatRelative(NOW - (26 * DAY - 1), NOW), '26 days ago');
    assert.equal(L.formatRelative(NOW - 26 * DAY, NOW), '1 month ago');
});

test('formatRelative: hostile inputs of every type read as unknown, never as a lie', () => {
    [null, undefined, '', '   ', NUL, 'soon', 'yesterday', NaN, Infinity, -Infinity, true, false,
        {}, [], () => NOW, new Date(NaN), '2026-13-45T99:99:99Z']
        .forEach((bad) => assert.equal(L.formatRelative(bad, NOW), 'unknown', JSON.stringify(bad)));
});

test('formatRelative: an unusable `now` falls back to the wall clock instead of throwing', () => {
    [null, undefined, '', 'soon', NaN, {}, [], true].forEach((now) =>
        assert.equal(typeof L.formatRelative(new Date(), now), 'string', JSON.stringify(now)));
});

test('formatRelative: the phrase is always singular-correct in both directions', () => {
    for (let d = 0; d < 800 * DAY; d += 3 * HOUR + 7 * MIN) {
        [L.formatRelative(NOW - d, NOW), L.formatRelative(NOW + d, NOW)].forEach((label) => {
            assert.ok(!/\b1 (minutes|hours|days|months|years)\b/.test(label), label);
            assert.ok(!/\b([02-9]|\d\d+) (minute|hour|day|month|year)\b/.test(label), label);
            assert.ok(!/NaN|undefined|Infinity/.test(label), label);
        });
    }
});

// ------------------------------------------------- mount argv

test('buildMountArgv: a NUL byte in any field is refused', () => {
    ['repoUrl', 'mountPoint', 'passwordFile', 'resticBinary', 'envFile'].forEach((field) => {
        const opts = { ...MOUNT_OPTS };
        opts[field] = '/etc/hangar' + NUL + '/x';
        assertGuard(() => L.buildMountArgv(opts));
    });
});

test('buildMountArgv: a carriage return is refused as firmly as a newline', () => {
    assertGuard(() => L.buildMountArgv({ ...MOUNT_OPTS, repoUrl: '/srv/repo\rExecStart=/bin/sh' }));
    assertGuard(() => L.buildMountArgv({ ...MOUNT_OPTS, mountPoint: '/run/x\r\nType=oneshot' }));
});

test('buildMountArgv: the repository url has no default, so any non-string is a typed failure', () => {
    [0, 1, true, false, [], {}, () => '/x', new Date(), '', ' x ' + NUL, Symbol('s'), null, undefined]
        .forEach((bad) => assertGuard(() => L.buildMountArgv({ repoId: 'main', repoUrl: bad })));
});

test('buildMountArgv: a truthy non-string override is a typed failure, not a coerced argv element', () => {
    [1, true, [], ['/x'], {}, () => '/x', new Date(), Symbol('s'), NUL].forEach((bad) => {
        assertGuard(() => L.buildMountArgv({ ...MOUNT_OPTS, mountPoint: bad }));
        assertGuard(() => L.buildMountArgv({ ...MOUNT_OPTS, passwordFile: bad }));
        assertGuard(() => L.buildMountArgv({ ...MOUNT_OPTS, resticBinary: bad }));
    });
});

test('buildMountArgv: a falsy override falls back to the derived default rather than an empty argv slot', () => {
    // '' is the one a form field actually produces; 0/false/null/undefined take
    // the same path because the fallback is a plain ||.
    ['', 0, false, null, undefined, NaN].forEach((empty) => {
        const argv = L.buildMountArgv({ ...MOUNT_OPTS, mountPoint: empty, passwordFile: empty, resticBinary: empty });
        assert.equal(argv[argv.length - 1], '/run/hangar/mnt/main', JSON.stringify(empty));
        assert.ok(argv.includes('/etc/hangar/repos/main.key'), JSON.stringify(empty));
        assert.ok(argv.includes('restic'), JSON.stringify(empty));
    });
});

test('buildMountArgv: maxRuntimeSec accepts only a positive whole number of seconds', () => {
    [0, -1, -3600, 1.5, NaN, Infinity, -Infinity, '3600', true, [], {}, 1e21]
        .forEach((bad) => assertGuard(() => L.buildMountArgv({ ...MOUNT_OPTS, maxRuntimeSec: bad })));
    assert.ok(L.buildMountArgv({ ...MOUNT_OPTS, maxRuntimeSec: 1 })
        .includes('--property=RuntimeMaxSec=1'));
});

test('buildMountArgv: the environment file must be an absolute path with nothing hidden in it', () => {
    ['rel.env', './rel.env', '../etc/shadow', '', ' ', NUL, '/etc/x' + NUL, '/etc/x\n', 7, true, [], {}]
        .forEach((bad) => assertGuard(() => L.buildMountArgv({ ...MOUNT_OPTS, envFile: bad })));
    assert.ok(L.buildMountArgv({ ...MOUNT_OPTS, envFile: '/etc/hangar/repos/main.env' })
        .includes('--property=EnvironmentFile=/etc/hangar/repos/main.env'));
});

test('buildMountArgv: opts of the wrong shape entirely are typed failures', () => {
    [undefined, null, 0, 1, '', 'main', true, [], [{ repoId: 'main' }], () => MOUNT_OPTS, new Date()]
        .forEach((bad) => assertGuard(() => L.buildMountArgv(bad)));
});

test('buildMountArgv: every argv element is a plain string', () => {
    const argv = L.buildMountArgv({ ...MOUNT_OPTS, envFile: '/etc/x.env', maxRuntimeSec: 60, allowOther: true });
    argv.forEach((a) => assert.equal(typeof a, 'string', String(a)));
    assert.ok(!argv.some((a) => a === '' || /[\u0000\r\n]/.test(a)), 'no empty or control-bearing element');
});

test('buildMountArgv: a unicode repository url is passed through unchanged', () => {
    const url = 'sftp:user@host:/srv/données/日本語';
    const argv = L.buildMountArgv({ repoId: 'main', repoUrl: url });
    assert.equal(argv[argv.indexOf('-r') + 1], url);
});

test('buildMountArgv: a falsy allowOther never adds the flag', () => {
    [undefined, null, false, 0, '', NaN].forEach((v) =>
        assert.ok(!L.buildMountArgv({ ...MOUNT_OPTS, allowOther: v }).includes('--allow-other'),
            JSON.stringify(v)));
});

test('buildMountArgv: it does not mutate the options it was handed', () => {
    const opts = { ...MOUNT_OPTS, envFile: '/etc/x.env', maxRuntimeSec: 60 };
    const before = JSON.stringify(opts);
    L.buildMountArgv(opts);
    L.buildMountArgv(opts);
    assert.equal(JSON.stringify(opts), before);
});

// ------------------------------------------------- mount state

test('normalizeMountState: only "active" counts as mounted', () => {
    ['activating', 'deactivating', 'reloading', 'inactive', 'failed', '', 'ACTIVE']
        .forEach((s) => assert.equal(L.normalizeMountState('main', { ActiveState: { v: s } }).mounted,
            false, s));
    assert.equal(L.normalizeMountState('main', { ActiveState: { v: 'active' } }).mounted, true);
});

test('normalizeMountState: a property named __proto__ cannot fake an active mount', () => {
    // cockpit hands GetAll() back as parsed JSON, so a key of any name can
    // arrive. It must land as an own property, not as this object's prototype.
    const props = JSON.parse('{"__proto__":{"t":"a{sv}","v":{"ActiveState":"active"}}}');
    const s = L.normalizeMountState('main', props);
    assert.equal(s.mounted, false);
    assert.equal(s.activeState, 'inactive');
    assert.equal({}.ActiveState, undefined, 'Object.prototype must be untouched');
});

test('unwrapProps: a __proto__ key becomes an own property and leaves the prototype alone', () => {
    const out = L.unwrapProps(JSON.parse('{"__proto__":{"t":"s","v":"x"},"LoadState":{"v":"loaded"}}'));
    assert.ok(Object.prototype.hasOwnProperty.call(out, '__proto__'));
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.equal(out.LoadState, 'loaded');
    assert.equal({}.LoadState, undefined);
});

test('unwrapProps: junk of every type yields an object, never a throw', () => {
    [null, undefined, 0, 1, '', 'nope', true, false, () => ({})].forEach((v) =>
        assert.deepEqual(L.unwrapProps(v), {}, JSON.stringify(v)));
    // A variant is only unwrapped when it actually carries a value; anything
    // else is passed through as it arrived rather than turned into undefined.
    assert.deepEqual(L.unwrapProps({ A: { t: 's' } }), { A: { t: 's' } });
    assert.deepEqual(L.unwrapProps({ A: null, B: 0, C: false }), { A: null, B: 0, C: false });
    assert.deepEqual(L.unwrapProps({ A: { t: 's', v: undefined } }), { A: undefined });
});

test('normalizeMountState: it reports the unit and mount point even when systemd said nothing', () => {
    [null, undefined, {}, 'nope', 7, []].forEach((props) => {
        const s = L.normalizeMountState('main', props);
        assert.equal(s.unit, 'hangar-mount-main.service');
        assert.equal(s.mountPoint, '/run/hangar/mnt/main');
        assert.equal(s.mounted, false);
        assert.equal(s.failed, false);
        assert.equal(s.result, null);
    });
});

// ------------------------------------------------- I/O guards

test('I/O: a cockpit object that cannot spawn or call is the same as no cockpit at all', async () => {
    const halves = [{}, { spawn: null }, { dbus: null }, { spawn: 'no', dbus: 'no' },
        { dbus() { return null; } }, { dbus() { return {}; } }, { dbus() { return { call: 7 }; } }];
    for (const half of halves) {
        globalThis.cockpit = half;
        try {
            await assertGuardAsync(L.mount({ repoId: 'main', repoUrl: '/srv/repo' }));
            await assertGuardAsync(L.unmount('main'));
            await assertGuardAsync(L.isMounted('main'));
        } finally {
            delete globalThis.cockpit;
        }
    }
});

test('I/O: a hostile mount point is refused before anything is spawned', async () => {
    let touched = false;
    globalThis.cockpit = { spawn() { touched = true; return Promise.resolve(''); } };
    try {
        await assertGuardAsync(L.mount({ repoId: 'main', repoUrl: '/srv/repo', mountPoint: '/run/x\nUser=root' }));
        await assertGuardAsync(L.mount({ repoId: 'main', repoUrl: '/srv/repo' + NUL }));
        await assertGuardAsync(L.mount({ repoId: 'main', repoUrl: '/srv/repo', envFile: 'relative.env' }));
        await assertGuardAsync(L.mount());
        assert.equal(touched, false, 'nothing may be spawned once the argv is known to be bad');
    } finally {
        delete globalThis.cockpit;
    }
});

test('mount: every spawn is privileged and asks for message-shaped errors', async () => {
    const spawns = [];
    globalThis.cockpit = {
        file: () => ({ read: () => Promise.resolve('') }),
        spawn(argv, opts) { spawns.push({ argv, opts }); return Promise.resolve(''); }
    };
    try {
        await L.mount({ repoId: 'main', repoUrl: '/srv/repo' });
        // Not a fixed count: the sequence is allowed to grow, but nothing in it
        // may reach the system unprivileged or with an error shape the caller
        // cannot read.
        assert.ok(spawns.length >= 2, 'the directory and the unit, at least');
        spawns.forEach((s) => {
            assert.equal(s.opts.superuser, 'require');
            assert.equal(s.opts.err, 'message');
        });
    } finally {
        delete globalThis.cockpit;
    }
});

test('mount: a failure of the second spawn is still reported as a mount failure', async () => {
    let n = 0;
    globalThis.cockpit = {
        spawn() { n++; return n === 1 ? Promise.resolve('') : Promise.reject({ message: 'Unit is masked', problem: 'access-denied' }); }
    };
    try {
        await assert.rejects(L.mount({ repoId: 'main', repoUrl: '/srv/repo' }), (e) => {
            assert.equal(e.name, 'HangarError');
            assert.equal(e.detail.op, 'mount');
            assert.equal(e.detail.problem, 'access-denied');
            assert.equal(e.message, 'Unit is masked');
            return true;
        });
    } finally {
        delete globalThis.cockpit;
    }
});

test('mount: a rejection that is already typed keeps its kind and its remediation', async () => {
    // WRONG_PASSWORD carries remediation 'reprompt'; re-wrapping it as GENERIC
    // would cost the user the one-click fix.
    globalThis.cockpit = {
        spawn() { return Promise.reject(Errors.create(Errors.KIND.WRONG_PASSWORD, 'bad password')); }
    };
    try {
        await assert.rejects(L.mount({ repoId: 'main', repoUrl: '/srv/repo' }), (e) => {
            assert.equal(e.kind, Errors.KIND.WRONG_PASSWORD);
            assert.equal(e.remediation, 'reprompt');
            return true;
        });
    } finally {
        delete globalThis.cockpit;
    }
});

test('unmount: a StopUnit failure is typed and named, and ResetFailedUnit is not attempted', async () => {
    const methods = [];
    globalThis.cockpit = {
        dbus() {
            return {
                call(p, iface, method) {
                    methods.push(method);
                    return Promise.reject({ message: 'Unit not loaded', problem: 'not-found' });
                }
            };
        }
    };
    try {
        await assert.rejects(L.unmount('main'), (e) => {
            assert.equal(e.name, 'HangarError');
            assert.equal(e.detail.op, 'unmount');
            assert.equal(e.detail.problem, 'not-found');
            return true;
        });
        assert.deepEqual(methods, ['StopUnit']);
    } finally {
        delete globalThis.cockpit;
    }
});

test('unmount and isMounted: a repo object is accepted in place of an id', async () => {
    globalThis.cockpit = {
        dbus() {
            return {
                call(p, iface, method) {
                    if (method === 'LoadUnit') return Promise.resolve(['/unit/x']);
                    return Promise.resolve([{ ActiveState: { v: 'active' } }]);
                }
            };
        }
    };
    try {
        assert.deepEqual(await L.unmount({ id: 'main' }),
            { unit: 'hangar-mount-main.service', mountPoint: '/run/hangar/mnt/main' });
        assert.equal((await L.isMounted({ id: 'main' })).mounted, true);
    } finally {
        delete globalThis.cockpit;
    }
});

test('isMounted: a LoadUnit failure is typed and named', async () => {
    globalThis.cockpit = {
        dbus() { return { call() { return Promise.reject(new Error('no such unit')); } }; }
    };
    try {
        await assert.rejects(L.isMounted('main'), (e) => {
            assert.equal(e.name, 'HangarError');
            assert.equal(e.detail.op, 'isMounted');
            return true;
        });
    } finally {
        delete globalThis.cockpit;
    }
});

test('isMounted: a failed unit is reported as failed rather than as an error', async () => {
    globalThis.cockpit = {
        dbus() {
            return {
                call(p, iface, method) {
                    if (method === 'LoadUnit') return Promise.resolve(['/unit/x']);
                    return Promise.resolve([{
                        LoadState: { v: 'loaded' }, ActiveState: { v: 'failed' },
                        SubState: { v: 'failed' }, Result: { v: 'exit-code' }
                    }]);
                }
            };
        }
    };
    try {
        const s = await L.isMounted('main');
        assert.equal(s.failed, true);
        assert.equal(s.mounted, false);
        assert.equal(s.result, 'exit-code');
    } finally {
        delete globalThis.cockpit;
    }
});

// ------------------------------------------------- the standing rule

test('no hostile value produces an untyped exception anywhere on the data-facing surface', () => {
    // The values a corrupt repo, a hand-edited config or a JSON.parse can hand
    // us. Every one of them is fed to every function the UI can reach.
    const hostile = [
        undefined, null, '', ' ', '\n', '\r\n', NUL, '\t', 0, -0, 1, -1, 1.5, NaN,
        Infinity, -Infinity, 1e16, -1e16, MAX_MS, -MAX_MS, Number.MAX_SAFE_INTEGER,
        true, false, [], {}, [[]], [{}], [null], 'main', '../etc', '/etc/passwd',
        'a'.repeat(5000), '日本語', 'x' + NUL + 'y', '2026-08-01T12:00:00Z',
        '0001-01-01T00:00:00Z', new Date(), new Date(NaN), { id: 'main' },
        { time: '2026-08-01T12:00:00Z' }, { time: null }, { time: Object.create(null) },
        { path: '/a' }, { changes: [] }, { changes: 'x' }, { added: [{ path: '/a' }] },
        () => 1, Symbol('s'), Object.create(null), [Object.create(null)],
        [{ path: Object.create(null), modifier: Object.create(null) }],
        { repoId: 'main', repoUrl: '/srv/r' }, JSON.parse('{"__proto__":{"v":"x"}}')
    ];
    const unary = ['buildTimeline', 'snapshotTimestampDir', 'diffToBadges', 'badgeForModifier',
        'parseLsJson', 'mountUnitName', 'mountUnitService', 'mountPoint', 'formatRelative',
        'buildMountArgv', 'unwrapProps'];

    function attempt(name, args) {
        try { L[name].apply(null, args); } catch (e) {
            if (e && e.name === 'HangarError') return;
            assert.fail(name + ' threw an untyped ' + (e && e.constructor && e.constructor.name) +
                ': ' + (e && e.message));
        }
    }

    hostile.forEach((a) => {
        unary.forEach((n) => attempt(n, [a]));
        hostile.forEach((b) => {
            attempt('buildTimeline', [[a], b]);
            attempt('formatRelative', [a, b]);
            attempt('normalizeMountState', [a, b]);
            attempt('snapshotPath', ['/mnt/x', a, b]);
            attempt('snapshotPath', [a, { time: '2026-08-01T12:00:00Z' }, b]);
            attempt('diffToBadges', [[a]]);
        });
    });
});

test('the source carries no invisible control characters', () => {
    // UNSAFE_RE once held a raw NUL byte, which every editor renders as nothing
    // and one careless save would have deleted — taking the NUL check with it.
    const src = fs.readFileSync(path.join(__dirname, '../../js/core/logbook.js'), 'utf8');
    const bad = [];
    for (let i = 0; i < src.length; i++) {
        const c = src.charCodeAt(i);
        if ((c < 32 && c !== 10) || c === 127) bad.push([i, c]);
    }
    assert.deepEqual(bad, [], 'control characters must be written as escapes');
    assert.ok(src.includes('/[\\u0000\\r\\n]/'), 'the unsafe-character class stays legible');
});

// --- waiting for the mount to serve ---------------------------------------
//
// systemd-run returns when the unit's process has been executed, not when FUSE
// is serving. Listing immediately raced the mount and produced
//   find: '/run/hangar/mnt/<repo>/snapshots/<time>': No such file or directory
// about a snapshot that was perfectly fine. A tiny local repository takes about
// 0.75 s to become listable; one on a NAS fetches its index first.

test('readiness is asked of the snapshots directory, not the mount point', () => {
    // The mount point exists the moment `install -d` made it, so testing that
    // would answer "ready" before restic had attached anything at all.
    assert.deepEqual(L.readyArgv('/run/hangar/mnt/nas/snapshots'),
        ['test', '-d', '/run/hangar/mnt/nas/snapshots']);
});

test('readyArgv applies the same argv safety as everything else here', () => {
    assert.throws(() => L.readyArgv('/run/hangar/mnt/\nevil'), (e) => e.kind === 'GENERIC');
});

test('wait options are bounded at both ends', () => {
    // Zero would make the wait pointless; unbounded would hang the screen on a
    // destination that is never coming back.
    assert.deepEqual(L.waitOptions(), { timeoutMs: 30000, intervalMs: 250 });
    assert.equal(L.waitOptions({ timeoutMs: 0 }).timeoutMs, 1000);
    assert.equal(L.waitOptions({ timeoutMs: 1e9 }).timeoutMs, 300000);
    assert.equal(L.waitOptions({ intervalMs: 1 }).intervalMs, 50);
    assert.equal(L.waitOptions({ intervalMs: 1e9 }).intervalMs, 5000);
});

test('garbage options fall back to the defaults rather than to NaN', () => {
    const o = L.waitOptions({ timeoutMs: 'soon', intervalMs: {} });
    assert.equal(o.timeoutMs, 30000);
    assert.equal(o.intervalMs, 250);
});

test('waiting resolves false without cockpit, and never rejects', async () => {
    // The caller's answer to "not ready" is the slower reader, so a rejection
    // here would turn a degraded experience into a broken screen.
    assert.equal(await L.waitForMount('/run/hangar/mnt/nas', {}), false);
});

test('the mount unit passes a cache directory, matching the engine', () => {
    // Without it the transient unit exits 1 and the Logbook shows a missing-path
    // error about a snapshot that is perfectly fine.
    const Restic = require('../../js/engine/restic.js');
    const argv = L.buildMountArgv({ repoId: 'nas', repoUrl: '/srv/r',
        passwordFile: '/k', maxRuntimeSec: 3600 });
    const i = argv.indexOf('--cache-dir');
    assert.ok(i >= 0, 'the mount unit has no --cache-dir');
    assert.equal(argv[i + 1], Restic.CACHE_DIR);
    // A global flag, so it must precede the subcommand.
    assert.ok(i < argv.indexOf('mount'));
});

// ---------------------------------------------- a mount that died badly
//
// When the restic process behind a FUSE mount dies without unmounting — a
// stopped unit, a killed process — the kernel keeps the mountpoint and every
// access returns ENOTCONN. Seen on a real machine: `restic mount` then failed
// with "mountpoint is inaccessible" on every attempt afterwards.
//
// The check reads /proc/mounts, because everything that stats the path fails
// the same way the mount does — `mountpoint -q` included, which is why an
// earlier version of this fix never fired at all.

function cockpitWithMounts(mounts, onSpawn) {
    return {
        file: (p) => ({ read: () => Promise.resolve(p === '/proc/mounts' ? mounts : '') }),
        spawn: (argv) => (onSpawn ? onSpawn(argv) : Promise.resolve(''))
    };
}

const STALE = 'restic:beee5a3e4e /run/hangar/mnt/main fuse ro,nosuid,nodev 0 0\n';

test('a stale mountpoint is cleared before the path is touched', async () => {
    const spawns = [];
    globalThis.cockpit = cockpitWithMounts(STALE, (argv) => {
        spawns.push(argv.join(' '));
        return Promise.resolve('');
    });
    try {
        await L.mount({ repoId: 'main', repoUrl: '/srv/repo' });
        assert.equal(spawns[0], 'fusermount -u /run/hangar/mnt/main');
        assert.ok(spawns.some((c) => c.startsWith('install -d')),
            'and only then is the directory prepared');
        assert.ok(spawns.indexOf('fusermount -u /run/hangar/mnt/main')
            < spawns.findIndex((c) => c.startsWith('install -d')));
    } finally {
        delete globalThis.cockpit;
    }
});

test('a path with no mount behind it is left alone', async () => {
    const spawns = [];
    globalThis.cockpit = cockpitWithMounts('/dev/sda1 /boot xfs rw 0 0\n', (argv) => {
        spawns.push(argv.join(' '));
        return Promise.resolve('');
    });
    try {
        await L.mount({ repoId: 'main', repoUrl: '/srv/repo' });
        assert.ok(!spawns.some((c) => c.startsWith('fusermount')));
        assert.ok(!spawns.some((c) => c.startsWith('umount')));
    } finally {
        delete globalThis.cockpit;
    }
});

// A path that merely contains the mount point is a different path.
test('a similar path is not mistaken for the mount point', async () => {
    const spawns = [];
    globalThis.cockpit = cockpitWithMounts(
        'restic:x /run/hangar/mnt/main-other fuse ro 0 0\n', (argv) => {
            spawns.push(argv.join(' '));
            return Promise.resolve('');
        });
    try {
        await L.mount({ repoId: 'main', repoUrl: '/srv/repo' });
        assert.ok(!spawns.some((c) => c.startsWith('fusermount')));
    } finally {
        delete globalThis.cockpit;
    }
});

test('a system without fusermount still gets its mount cleared', async () => {
    const spawns = [];
    globalThis.cockpit = cockpitWithMounts(STALE, (argv) => {
        spawns.push(argv.join(' '));
        if (argv[0] === 'fusermount') return Promise.reject(new Error('not found'));
        return Promise.resolve('');
    });
    try {
        await L.mount({ repoId: 'main', repoUrl: '/srv/repo' });
        assert.ok(spawns.some((c) => c === 'umount -l /run/hangar/mnt/main'),
            'lazily, because a stale mount can still hold references');
    } finally {
        delete globalThis.cockpit;
    }
});

// Clearing is best-effort: a mount must not fail because the cleanup of a
// previous one did.
test('a mount is not failed by an unclearable path', async () => {
    globalThis.cockpit = cockpitWithMounts(STALE, (argv) => {
        if (argv[0] === 'fusermount' || argv[0] === 'umount')
            return Promise.reject(new Error('device is busy'));
        return Promise.resolve('');
    });
    try {
        const r = await L.mount({ repoId: 'main', repoUrl: '/srv/repo' });
        assert.equal(r.mountPoint, '/run/hangar/mnt/main');
    } finally {
        delete globalThis.cockpit;
    }
});
