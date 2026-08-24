// tests/unit/reposize.test.js — the remembered repository size.
//
// This module exists to stop a screen costing two minutes to draw, and the risk
// it carries is the opposite of the one it removes: a cache that lies. So the
// tests are ordered by how misleading a regression would be:
//   1. a MALFORMED entry never reaches the screen — a hand-edited file must not
//      put "undefined bytes, measured NaN" in front of anyone;
//   2. STALENESS is decided honestly, including for a clock that moved
//      backwards, because "fresh" is a claim about time and time is not
//      trustworthy;
//   3. the SETTING is honoured, and a broken one falls back to the default
//      rather than to never measuring at all.
// Everything after that is plumbing.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const R = require('../../js/core/reposize.js');
const Config = require('../../js/core/config.js');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// The module reaches core/config.js for its I/O, and under node that module
// wants a cockpit bridge. Swapping the two functions out is enough: reposize
// holds the module object, not the functions.
function withStore(files, body) {
    const readJson = Config.readJson;
    const writeJson = Config.writeJson;
    const writes = [];
    Config.readJson = async function (path, fallback) {
        if (Object.prototype.hasOwnProperty.call(files, path)) {
            const v = files[path];
            if (v instanceof Error) throw v;
            return v;
        }
        return fallback === undefined ? null : fallback;
    };
    Config.writeJson = async function (path, value, mode) {
        writes.push({ path: path, value: value, mode: mode });
        files[path] = value;
        return true;
    };
    return Promise.resolve(body(writes)).finally(function () {
        Config.readJson = readJson;
        Config.writeJson = writeJson;
    });
}

// --- 1. a malformed entry never reaches the screen -----------------------

test('normalize refuses every shape that is not a measurement', () => {
    const junk = [
        null, undefined, 0, 1, '', 'x', true, false, [], [1, 2], NaN,
        {}, { size: 1 }, { at: 1 },
        { size: '5', at: 1 }, { size: 1, at: '5' },
        { size: NaN, at: 1 }, { size: 1, at: NaN },
        { size: Infinity, at: 1 }, { size: 1, at: -Infinity }
    ];
    junk.forEach((v) => {
        assert.equal(R.normalize(v), null, 'accepted ' + JSON.stringify(v));
    });
});

test('normalize keeps only the three fields, and a missing count stays null', () => {
    assert.deepEqual(R.normalize({ size: 5, at: 9, snapshots: 3, extra: 'x' }),
        { size: 5, snapshots: 3, at: 9 });
    assert.deepEqual(R.normalize({ size: 5, at: 9 }),
        { size: 5, snapshots: null, at: 9 });
    // A snapshot count that is not a number is dropped, not shown: the size is
    // still worth having, the count is not worth guessing.
    assert.deepEqual(R.normalize({ size: 5, at: 9, snapshots: 'lots' }),
        { size: 5, snapshots: null, at: 9 });
});

test('a prototype-shaped entry is not a measurement', () => {
    const hostile = JSON.parse('{"__proto__": {"size": 1, "at": 1}}');
    assert.equal(R.normalize(hostile), null);
    assert.equal(({}).size, undefined, 'the prototype must be untouched');
});

test('read turns an unreadable, absent or malformed file into no cache at all', async () => {
    const path = R.sizePath('nas');
    await withStore({}, async () => {
        assert.equal(await R.read('nas'), null, 'absent');
    });
    await withStore({ [path]: new Error('access denied') }, async () => {
        assert.equal(await R.read('nas'), null, 'unreadable');
    });
    await withStore({ [path]: { size: 'big' } }, async () => {
        assert.equal(await R.read('nas'), null, 'malformed');
    });
    await withStore({ [path]: { size: 5, at: 9 } }, async () => {
        assert.deepEqual(await R.read('nas'), { size: 5, snapshots: null, at: 9 });
    });
});

// --- 2. staleness is decided honestly ------------------------------------

test('no entry is stale, so a repository that was never measured is measured', () => {
    assert.equal(R.isStale(null, 1000), true);
    assert.equal(R.isStale(undefined, 1000), true);
    assert.equal(R.isStale({ size: 5 }, 1000), true, 'no date means no claim');
});

test('staleness is measured against the limit, not a hardcoded interval', () => {
    const now = 10 * DAY;
    const fresh = { size: 5, at: now - HOUR };
    const old = { size: 5, at: now - 30 * HOUR };
    assert.equal(R.isStale(fresh, now), false);
    assert.equal(R.isStale(old, now), true);
    assert.equal(R.isStale(old, now, 40 * HOUR), false, 'a longer limit forgives it');
    assert.equal(R.isStale(fresh, now, 30 * 1000), true, 'a shorter one does not');
});

test('exactly at the limit is stale, so a 24 hour setting means at least daily', () => {
    const now = 10 * DAY;
    assert.equal(R.isStale({ size: 5, at: now - DAY }, now, DAY), true);
    assert.equal(R.isStale({ size: 5, at: now - DAY + 1 }, now, DAY), false);
});

test('a timestamp from the future is stale, not fresh for a day', () => {
    // A clock that jumped forward and back — an NTP correction, a VM restored
    // from a snapshot — would otherwise pin the size on screen for the whole
    // interval with no way to tell it had.
    const now = 10 * DAY;
    assert.equal(R.isStale({ size: 5, at: now + 1 }, now), true);
    assert.equal(R.isStale({ size: 5, at: now + 100 * DAY }, now), true);
});

test('a limit of zero means never on its own, even for an ancient entry', () => {
    const now = 100 * DAY;
    assert.equal(R.isStale({ size: 5, at: 0 }, now, 0), false);
    // But an entry that is not a measurement is still missing, whatever the
    // limit says: "never refresh" must not mean "never measure".
    assert.equal(R.isStale(null, now, 0), true);
});

// --- 3. the setting is honoured, and a broken one is not obeyed ----------

test('the shipped default is a day', () => {
    assert.equal(R.DEFAULT_MAX_AGE_HOURS, 24);
    assert.equal(R.MAX_AGE_MS, DAY);
    assert.equal(R.maxAgeMsFrom(null), DAY);
    assert.equal(R.maxAgeMsFrom({}), DAY);
});

test('hours from settings become milliseconds', () => {
    assert.equal(R.maxAgeMsFrom({ repoSizeMaxAgeHours: 6 }), 6 * HOUR);
    assert.equal(R.maxAgeMsFrom({ repoSizeMaxAgeHours: '6' }), 6 * HOUR);
    assert.equal(R.maxAgeMsFrom({ repoSizeMaxAgeHours: 0.5 }), 30 * 60 * 1000);
    assert.equal(R.maxAgeMsFrom({ repoSizeMaxAgeHours: 0 }), 0, 'zero is a choice');
});

test('a broken setting falls back to the default, never to never', () => {
    // Falling back to 0 would be the friendlier-looking bug: sizes would still
    // show, from a cache nothing ever refreshed.
    [undefined, null, '', 'abc', NaN, -1, -0.5, [], {}, true].forEach((v) => {
        assert.equal(R.maxAgeMsFrom({ repoSizeMaxAgeHours: v }), DAY,
            'obeyed ' + JSON.stringify(v));
    });
});

// --- paths and writing ---------------------------------------------------

test('the path is under the state directory and named for the repository', () => {
    assert.equal(R.sizePath('nas-nightly'), Config.STATE_DIR + '/size-nas-nightly.json');
});

test('a repository id that could escape the state directory is refused', () => {
    ['../etc/passwd', 'a/b', '', '.', '..', 'a b', null, undefined, 5].forEach((id) => {
        assert.throws(() => R.sizePath(id), 'accepted ' + JSON.stringify(id));
    });
});

test('write stores the size, the count and the moment, world-readable', async () => {
    await withStore({}, async (writes) => {
        const entry = await R.write('nas', { totalSize: 42, snapshotsCount: 7 }, 1234);
        assert.deepEqual(entry, { size: 42, snapshots: 7, at: 1234 });
        assert.equal(writes.length, 1);
        assert.equal(writes[0].path, Config.STATE_DIR + '/size-nas.json');
        // hangar-run writes this as root and the browser reads it as the
        // logged-in user, so it cannot be 0600.
        assert.equal(writes[0].mode, '0644');
        assert.deepEqual(writes[0].value, { size: 42, snapshots: 7, at: 1234 });
    });
});

test('write refuses stats with no usable size rather than caching a hole', async () => {
    await withStore({}, async (writes) => {
        assert.equal(await R.write('nas', null), null);
        assert.equal(await R.write('nas', {}), null);
        assert.equal(await R.write('nas', { totalSize: 'big' }), null);
        assert.equal(await R.write('nas', { totalSize: NaN }), null);
        assert.equal(writes.length, 0, 'nothing was written');
    });
});

test('a size of zero is a real measurement of an empty repository', async () => {
    await withStore({}, async (writes) => {
        const entry = await R.write('nas', { totalSize: 0, snapshotsCount: 0 }, 5);
        assert.deepEqual(entry, { size: 0, snapshots: 0, at: 5 });
        assert.equal(writes.length, 1);
    });
});

test('what write stores, read gives back, and it is not stale', async () => {
    await withStore({}, async () => {
        const now = 10 * DAY;
        await R.write('nas', { totalSize: 42, snapshotsCount: 7 }, now);
        const back = await R.read('nas');
        assert.deepEqual(back, { size: 42, snapshots: 7, at: now });
        assert.equal(R.isStale(back, now + HOUR), false);
        assert.equal(R.isStale(back, now + 25 * HOUR), true);
    });
});

test('two repositories do not share a file', async () => {
    await withStore({}, async () => {
        await R.write('nas', { totalSize: 1 }, 1);
        await R.write('usb', { totalSize: 2 }, 2);
        assert.equal((await R.read('nas')).size, 1);
        assert.equal((await R.read('usb')).size, 2);
    });
});
