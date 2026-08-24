// core/reposize.js — the last known size of a repository, and when it was taken.
//
// `restic stats` reads the repository, and on a remote one that means loading
// its index first: measured at 50 to 118 seconds against a NAS over SFTP. That
// is a fine price to pay occasionally and an absurd one to pay on every visit
// to a screen whose job is to say whether last night's backup worked.
//
// So a measurement is remembered, shown with the time it was taken, and only
// repeated when it has gone stale or somebody asks for it. A number with a
// date on it is honest; a number that costs two minutes to display is not.
//
// The nightly backup already measures the size for its own size guard, so on a
// machine that backs up daily the cache stays fresh without anyone opening a
// browser at all.
'use strict';
(function (root) {
    const node = typeof module !== 'undefined' && module.exports;
    // Resolved on use, not at load. index.html decides script order, and a
    // module captured here before its dependency's <script> has run is undefined
    // for ever after — which is not a load error, it is a cache that silently
    // never reads anything. Cost the Overview a full measurement per visit until
    // the browser suite caught it.
    function config() {
        return node ? require('./config.js') : root.HangarConfig;
    }

    // A day, unless Settings says otherwise. The nightly backup measures the
    // size for its own guard, so on a machine that backs up daily this is the
    // interval at which the number is already being refreshed for free.
    const DEFAULT_MAX_AGE_HOURS = 24;
    const MAX_AGE_MS = DEFAULT_MAX_AGE_HOURS * 60 * 60 * 1000;

    // Settings gives hours; everything below works in milliseconds. A missing,
    // absurd or unparseable value falls back to the default rather than
    // disabling the cache: a broken setting must not cost two minutes a page.
    function maxAgeMsFrom(settings) {
        const raw = settings && typeof settings === 'object'
            ? settings.repoSizeMaxAgeHours : undefined;
        // NOT Number(raw): Number(null), Number('') and Number([]) are all 0,
        // and 0 is the one value that means "never refresh on its own". A
        // missing setting would have quietly become a permanent cache — sizes
        // on screen for ever, from a file nothing updated.
        let n = null;
        if (typeof raw === 'number') n = raw;
        else if (typeof raw === 'string' && raw.trim() !== '') n = Number(raw);
        if (n === null || !Number.isFinite(n) || n < 0) return MAX_AGE_MS;
        // 0 is a deliberate "only when asked", not a mistake.
        return Math.round(n * 60 * 60 * 1000);
    }

    // Beside the job state, not in a directory of its own: same owner, same
    // permissions, same thing to back up or ignore.
    function sizePath(repoId) {
        return config().STATE_DIR + '/size-' + config().validateId(repoId) + '.json';
    }

    function num(v) {
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
    }

    // A cache entry is only as good as its shape: a file someone hand-edited
    // must not put "undefined" on the screen next to a date.
    function normalize(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const size = num(raw.size);
        const at = num(raw.at);
        if (size === null || at === null) return null;
        return { size: size, snapshots: num(raw.snapshots), at: at };
    }

    async function read(repoId) {
        try {
            return normalize(await config().readJson(sizePath(repoId), null));
        } catch (e) {
            // An unreadable cache is a missing cache. It is not worth an error
            // on a screen that can simply measure again.
            return null;
        }
    }

    async function write(repoId, stats, now) {
        const size = num(stats && stats.totalSize);
        if (size === null) return null;          // nothing worth remembering
        const entry = {
            size: size,
            snapshots: num(stats && stats.snapshotsCount),
            at: typeof now === 'number' ? now : Date.now()
        };
        await config().writeJson(sizePath(repoId), entry, '0644');
        return entry;
    }

    function isStale(entry, now, maxAgeMs) {
        const e = normalize(entry);
        if (!e) return true;
        const limit = typeof maxAgeMs === 'number' ? maxAgeMs : MAX_AGE_MS;
        // Never on its own: a remembered size stays until somebody asks for a
        // new one.
        if (limit === 0) return false;
        const t = typeof now === 'number' ? now : Date.now();
        // A timestamp in the future is a clock that moved, not a fresh
        // measurement: treat it as stale rather than trusting it for a day.
        if (e.at > t) return true;
        return (t - e.at) >= limit;
    }

    const api = { MAX_AGE_MS, DEFAULT_MAX_AGE_HOURS, maxAgeMsFrom,
        sizePath, read, write, isStale, normalize };
    root.HangarRepoSize = api;
    if (node) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
