// core/logbook.js — the Logbook: point-in-time snapshot browsing.
//
// The Logbook is the scrubber plus the file tree behind it. Everything here is
// pure except the last section: banding, path derivation, diff badges and the
// `ls --json` fallback parser are all plain functions so the scrubber can be
// unit tested without a repository, a mount, or a browser.
//
// Two rules shape this module:
//
//  1. All date arithmetic is UTC. Band keys derived from getFullYear()/getHours()
//     would move under the operator's feet when the host timezone differs from
//     the one the snapshot was taken in, and would make these tests pass or fail
//     depending on where CI runs. `now` is an argument, never a hidden read of
//     the clock, for the same reason.
//
//  2. The mount is a systemd transient unit, not a cockpit.spawn child. A
//     cockpit.spawn process dies with its channel, so a page reload would rip
//     the FUSE mount out from under an in-progress restore. systemd owns it
//     instead, which also means "is it mounted?" is answered by asking systemd
//     rather than by remembering.
'use strict';
(function (root) {
    // index.html loads errors.js and secrets.js ahead of us; under node we pull
    // them in directly so this module stands alone in unit tests.
    const E = root.HangarErrors ||
        (typeof require === 'function' ? require('./errors.js') : null);
    // Repo ids are validated by secrets.js rather than by a copy of its regex:
    // a second copy is a second thing to drift, and an id that passes here but
    // fails there would produce a unit whose credential cannot be loaded.
    const Secrets = root.HangarSecrets ||
        (typeof require === 'function' ? require('./secrets.js') : null);

    const MOUNT_ROOT = '/run/hangar/mnt';
    // Must match engine/restic.js CACHE_DIR; a unit test asserts they agree.
    const RESTIC_CACHE_DIR = '/var/cache/hangar/restic';
    const MOUNT_UNIT_PREFIX = 'hangar-mount-';
    const SNAPSHOT_DIR = 'snapshots';
    const MOUNT_DIR_MODE = '0700';

    const SEC = 1000;
    const MIN = 60 * SEC;
    const HOUR = 60 * MIN;
    const DAY = 24 * HOUR;
    const MONTH = 30 * DAY;             // display-only unit, never a calendar month
    const YEAR = 365 * DAY;

    const GRANULARITY = {
        HOUR: 'hour',
        DAY: 'day',
        WEEK: 'week',
        MONTH: 'month',
        UNKNOWN: 'unknown'
    };

    // How far back each granularity reaches, measured from `now`. The shape is
    // the Time-Machine one: dense near the present where the user is scrubbing
    // for "the version from before lunch", coarse further back where they only
    // remember the month. Boundaries are exclusive — an age of exactly one day
    // is already a day band.
    const WINDOWS = {
        hour: DAY,
        day: 7 * DAY,
        week: 90 * DAY
    };

    const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
    const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    // A restic snapshot directory is Go's time.RFC3339 of the snapshot time, in
    // the zone the snapshot recorded. Fractional seconds are dropped by that
    // format, so they are dropped here too.
    const RFC3339_RE =
        /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|z|[+-]\d{2}:?\d{2})?$/;

    // Anything that would start a new directive if it reached a unit file, or
    // truncate a path if it reached a syscall.
    const UNSAFE_RE = /[\u0000\r\n]/;

    function fail(message, detail) {
        return E.create(E.KIND.GENERIC, message, detail === undefined ? null : detail);
    }

    // The house String() guard, same as engine/restic.js: String() itself throws
    // on a value with no usable toString, and a bare TypeError out of a parser is
    // a failure the UI cannot classify.
    function str(v) {
        try { return String(v); } catch (e) { return ''; }
    }

    // ---- time coercion ------------------------------------------------------

    function toDate(value) {
        if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
        // isFinite is not enough: a magnitude above 8.64e15 is outside the Date
        // range, and the Invalid Date it produces is truthy. It would travel all
        // the way to `new Date(NaN).toISOString()`, which throws a bare
        // RangeError — an untyped failure the UI has no remediation for.
        if (typeof value === 'number' && isFinite(value)) {
            const n = new Date(value);
            return isNaN(n.getTime()) ? null : n;
        }
        if (typeof value === 'string' && value.trim() !== '') {
            const d = new Date(value);
            return isNaN(d.getTime()) ? null : d;
        }
        return null;
    }

    function timeOf(snapshot) {
        if (snapshot && typeof snapshot === 'object' && !(snapshot instanceof Date))
            return snapshot.time;
        return snapshot;                            // a bare Date/string/number is a time
    }

    function pad2(n) { return n < 10 ? '0' + n : String(n); }

    // Years are four digits in RFC3339. Go's zero time serialises as
    // 0001-01-01T00:00:00Z, and a snapshot carrying it must not be renamed to
    // "1-01-01" — that is a directory the mount does not have.
    function pad4(n) { return n >= 0 && n < 1000 ? ('000' + n).slice(-4) : String(n); }

    // Date.UTC folds years 0-99 onto 1900+, so Go's zero time would be filed
    // under January 1901 — a century away from where the operator would look for
    // a snapshot whose time restic failed to record.
    function utcMs(y, m, d, h) {
        const ms = Date.UTC(y, m, d, h || 0);
        if (y < 0 || y > 99) return ms;
        const fixed = new Date(ms);
        fixed.setUTCFullYear(y);
        return fixed.getTime();
    }

    // ---- timeline banding ---------------------------------------------------

    function granularityFor(ageMs) {
        // Clock skew puts a snapshot in the future. It is still the newest thing
        // the user has, so it belongs at the top of the scrubber, not in a month
        // band a century away.
        if (ageMs < WINDOWS.hour) return GRANULARITY.HOUR;
        if (ageMs < WINDOWS.day) return GRANULARITY.DAY;
        if (ageMs < WINDOWS.week) return GRANULARITY.WEEK;
        return GRANULARITY.MONTH;
    }

    function bucketStart(date, granularity) {
        const y = date.getUTCFullYear();
        const m = date.getUTCMonth();
        const d = date.getUTCDate();
        if (granularity === GRANULARITY.HOUR) return utcMs(y, m, d, date.getUTCHours());
        if (granularity === GRANULARITY.DAY) return utcMs(y, m, d);
        if (granularity === GRANULARITY.WEEK) {
            // ISO weeks start on Monday; getUTCDay() calls Sunday 0.
            const midnight = utcMs(y, m, d);
            const offset = (date.getUTCDay() + 6) % 7;
            return midnight - offset * DAY;
        }
        return utcMs(y, m, 1);
    }

    function bucketKey(startMs, granularity) {
        const s = new Date(startMs);
        const ymd = pad4(s.getUTCFullYear()) + '-' + pad2(s.getUTCMonth() + 1) + '-' + pad2(s.getUTCDate());
        if (granularity === GRANULARITY.HOUR) return 'hour:' + ymd + 'T' + pad2(s.getUTCHours());
        if (granularity === GRANULARITY.DAY) return 'day:' + ymd;
        if (granularity === GRANULARITY.WEEK) return 'week:' + ymd;
        return 'month:' + pad4(s.getUTCFullYear()) + '-' + pad2(s.getUTCMonth() + 1);
    }

    function bandLabel(startMs, granularity) {
        const s = new Date(startMs);
        const day = s.getUTCDate();
        const mon = MONTHS_SHORT[s.getUTCMonth()];
        // Four digits even for a year below 1000: "January 1" reads as a day.
        const year = pad4(s.getUTCFullYear());
        if (granularity === GRANULARITY.HOUR)
            return day + ' ' + mon + ' ' + year + ', ' + pad2(s.getUTCHours()) + ':00';
        if (granularity === GRANULARITY.DAY)
            return WEEKDAYS_SHORT[s.getUTCDay()] + ' ' + day + ' ' + mon + ' ' + year;
        if (granularity === GRANULARITY.WEEK)
            return 'Week of ' + day + ' ' + mon + ' ' + year;
        return MONTHS_FULL[s.getUTCMonth()] + ' ' + year;
    }

    // Snapshots -> scrubber bands, newest first, each band newest first.
    //
    // `now` is an argument so the caller (and the tests) decide what "now" means.
    // Snapshots whose time restic did not record, or recorded unparseably, get
    // their own trailing band: dropping them would make files silently
    // unreachable, which is the one failure mode a backup UI cannot have.
    function buildTimeline(snapshots, now) {
        if (snapshots === null || snapshots === undefined) return [];
        if (!Array.isArray(snapshots))
            throw fail('snapshot list must be an array', { type: typeof snapshots });

        const nowDate = toDate(now);
        const nowMs = nowDate ? nowDate.getTime() : Date.now();

        const dated = [];
        const undated = [];
        snapshots.forEach((s) => {
            const d = toDate(timeOf(s));
            if (d) dated.push({ snapshot: s, ms: d.getTime() });
            else undated.push(s);
        });

        // Array.prototype.sort is stable, so snapshots sharing a timestamp keep
        // the order restic listed them in rather than shuffling between renders.
        dated.sort((a, b) => b.ms - a.ms);

        const bands = [];
        const byKey = new Map();
        dated.forEach((entry) => {
            const granularity = granularityFor(nowMs - entry.ms);
            const startMs = bucketStart(new Date(entry.ms), granularity);
            // A timestamp within a bucket-width of the edge of the representable
            // range has a bucket start that is not itself representable. There is
            // no band to hang it under, and toISOString() on it would throw a
            // bare RangeError, so it joins the undated instead of vanishing.
            if (!Number.isFinite(startMs)) { undated.push(entry.snapshot); return; }
            const key = bucketKey(startMs, granularity);
            let band = byKey.get(key);
            if (!band) {
                band = {
                    key: key,
                    label: bandLabel(startMs, granularity),
                    granularity: granularity,
                    start: new Date(startMs).toISOString(),
                    startMs: startMs,
                    snapshots: []
                };
                byKey.set(key, band);
                bands.push(band);
            }
            band.snapshots.push(entry.snapshot);
        });

        // Bands are already discovered newest-first, but an age boundary can fall
        // inside a bucket (23h59m old and 24h01m old are the same UTC hour at
        // different granularities), so the order is asserted rather than assumed.
        bands.sort((a, b) => b.startMs - a.startMs);

        if (undated.length) {
            bands.push({
                key: GRANULARITY.UNKNOWN,
                label: 'Unknown date',
                granularity: GRANULARITY.UNKNOWN,
                start: null,
                startMs: null,
                snapshots: undated
            });
        }
        return bands;
    }

    // ---- snapshot paths inside a FUSE mount ---------------------------------

    // The directory name restic's FUSE mount gives this snapshot.
    //
    // Getting this wrong does not fail loudly — it silently reads a different
    // point in time — so an unparseable timestamp throws instead of guessing.
    function snapshotTimestampDir(snapshot) {
        const raw = timeOf(snapshot);
        if (typeof raw === 'string') {
            const m = RFC3339_RE.exec(raw.trim());
            if (m) {
                // The zone is kept verbatim: restic formats in the zone the
                // snapshot recorded, so normalising to UTC would name a
                // directory that does not exist in the mount.
                const zone = m[3] ? m[3].toUpperCase().replace(/^([+-]\d{2})(\d{2})$/, '$1:$2') : 'Z';
                return m[1] + 'T' + m[2] + zone;
            }
        }
        const d = toDate(raw);
        // A Date or epoch value carries no zone, so UTC is the only honest read.
        if (d) {
            return pad4(d.getUTCFullYear()) + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) +
                'T' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds()) + 'Z';
        }
        throw fail('snapshot has no usable timestamp', { time: raw === undefined ? null : str(raw) });
    }

    // <mountRoot>/snapshots/<timestamp>. `dedupIndex` exists because restic
    // disambiguates two snapshots taken in the same second by appending -1, -2
    // to the second and later directory names.
    function snapshotPath(mountRoot, snapshot, dedupIndex) {
        if (typeof mountRoot !== 'string' || mountRoot.trim() === '')
            throw fail('mount root must be a non-empty string', { type: typeof mountRoot });
        if (UNSAFE_RE.test(mountRoot))
            throw fail('mount root contains a control character', { mountRoot: JSON.stringify(mountRoot) });

        let name = snapshotTimestampDir(snapshot);
        if (dedupIndex !== undefined && dedupIndex !== null && dedupIndex !== 0) {
            // isSafeInteger, not isInteger: 1e21 is an "integer" whose decimal
            // form is "1e+21", which would name a directory restic never made.
            if (!Number.isSafeInteger(dedupIndex) || dedupIndex < 0)
                throw fail('snapshot dedup index must be a non-negative integer', { dedupIndex: dedupIndex });
            name += '-' + dedupIndex;
        }
        const base = mountRoot.replace(/\/+$/, '');
        return base + '/' + SNAPSHOT_DIR + '/' + name;
    }

    // ---- diff badges --------------------------------------------------------

    const BADGE = { ADDED: 'added', MODIFIED: 'modified', REMOVED: 'removed' };

    function badgeForModifier(modifier) {
        const m = modifier === null || modifier === undefined ? '' : str(modifier);
        if (m.indexOf('+') >= 0) return BADGE.ADDED;
        if (m.indexOf('-') >= 0) return BADGE.REMOVED;
        // M/T/U are restic's content, type and permission changes. An unknown
        // modifier from a newer restic becomes "modified" rather than vanishing:
        // showing the user a marker they can investigate beats showing nothing.
        return BADGE.MODIFIED;
    }

    function collectChanges(diff) {
        if (Array.isArray(diff)) return diff;
        const out = [];
        // The parsed shape from HangarRestic.parseDiff...
        [['added', '+'], ['removed', '-'], ['changed', 'M'], ['other', '?']].forEach((pair) => {
            const list = diff[pair[0]];
            if (!Array.isArray(list)) return;
            list.forEach((c) => {
                if (!c || typeof c !== 'object') return;
                out.push({ path: c.path, modifier: c.modifier === undefined ? pair[1] : c.modifier });
            });
        });
        // ...or the raw `restic diff --json` document, so a caller that skipped
        // the parser still gets correct badges instead of an empty tree.
        if (Array.isArray(diff.changes)) diff.changes.forEach((c) => out.push(c));
        return out;
    }

    // path -> 'added' | 'modified' | 'removed', for change markers between two
    // adjacent snapshots. Null-prototype so a path literally named "__proto__"
    // becomes an own property instead of silently mutating Object.prototype.
    function diffToBadges(diff) {
        const badges = Object.create(null);
        if (diff === null || diff === undefined) return badges;
        if (typeof diff !== 'object')
            throw fail('diff must be a parsed object, not text', { type: typeof diff });

        collectChanges(diff).forEach((change) => {
            if (!change || typeof change !== 'object') return;
            if (change.path === null || change.path === undefined || change.path === '') return;
            const path = str(change.path);
            const badge = badgeForModifier(change.modifier);
            const seen = badges[path];
            // A path reported both added and removed is a replacement, not two
            // events — the honest single badge for that is "modified".
            badges[path] = (seen === undefined || seen === badge) ? badge : BADGE.MODIFIED;
        });
        return badges;
    }

    // ---- `restic ls --json` fallback ----------------------------------------

    function asList(v) { return Array.isArray(v) ? v : []; }

    function normalizeLsSnapshot(o) {
        return {
            id: o.id ? str(o.id) : '',
            shortId: o.short_id ? str(o.short_id) : (o.id ? str(o.id).slice(0, 8) : ''),
            time: o.time || null,
            hostname: o.hostname || '',
            username: o.username || '',
            paths: asList(o.paths).map((v) => str(v)),
            tags: asList(o.tags).map((v) => str(v)),
            tree: o.tree || null
        };
    }

    function normalizeLsNode(o) {
        const size = Number(o.size);
        return {
            name: o.name === undefined || o.name === null ? '' : str(o.name),
            type: o.type ? str(o.type) : '',
            path: o.path === undefined || o.path === null ? '' : str(o.path),
            size: Number.isFinite(size) ? size : 0,
            mode: o.mode === undefined ? null : o.mode,
            permissions: o.permissions ? str(o.permissions) : '',
            uid: o.uid === undefined ? null : o.uid,
            gid: o.gid === undefined ? null : o.gid,
            mtime: o.mtime || null,
            atime: o.atime || null,
            ctime: o.ctime || null
        };
    }

    // The no-FUSE path: `restic ls --json <snapshot>` emits JSON lines whose
    // first record describes the snapshot and whose remaining records are nodes.
    //
    // restic 0.17 renamed `struct_type` to `message_type` and still emits both;
    // both are accepted so the Logbook does not break on either side of that
    // version. Noise and truncated tails are skipped rather than fatal, because
    // this parser is already the fallback — failing here leaves the user with
    // nothing at all.
    function parseLsJson(text) {
        const raw = text === null || text === undefined ? '' : str(text);
        const out = { snapshot: null, nodes: [] };
        if (raw.trim() === '') return out;

        let parsed = 0;
        raw.split(/\r?\n/).forEach((line) => {
            const t = line.trim();
            if (t === '') return;
            let o;
            try { o = JSON.parse(t); } catch (e) { return; }
            // Counted before the shape check: the guard below asks "was any of
            // this JSON at all", which is the case where restic wrote a plain
            // text error instead of a stream. Valid JSON in an unexpected shape
            // is a listing with nothing in it, not a parse failure.
            parsed++;
            if (!o || typeof o !== 'object' || Array.isArray(o)) return;
            const kind = o.message_type || o.struct_type || '';
            if (kind === 'snapshot') {
                if (!out.snapshot) out.snapshot = normalizeLsSnapshot(o);
                return;
            }
            if (kind === 'node' || (kind === '' && o.path !== undefined && o.name !== undefined))
                out.nodes.push(normalizeLsNode(o));
        });

        if (!parsed)
            throw fail('Could not parse restic ls output', { text: raw.slice(0, 2000) });
        return out;
    }

    // ---- mount naming -------------------------------------------------------

    function repoIdOf(repo) {
        if (repo && typeof repo === 'object' && !Array.isArray(repo)) return repo.id;
        return repo;
    }

    function mountUnitName(repoId) {
        return MOUNT_UNIT_PREFIX + Secrets.validateRepoId(repoIdOf(repoId));
    }

    function mountUnitService(repoId) { return mountUnitName(repoId) + '.service'; }

    // The root is configurable (Settings -> Mount folder), so it has to be threaded
    // through rather than assumed: a setting that validates, saves, and then has no
    // effect is worse than not offering the setting at all.
    //
    // core/config.js validates it too, but this module does not get to trust that —
    // the value reaches an argv, and a relative or traversing root would mount
    // somewhere other than where the UI claims.
    function normalizeMountRoot(root) {
        if (root === undefined || root === null || root === '') return MOUNT_ROOT;
        const s = String(root).trim().replace(/\/+$/, '');
        if (s === '' || s === '/') return MOUNT_ROOT;
        if (s.charAt(0) !== '/')
            throw fail('mount folder must be an absolute path', { mountRoot: root });
        if (s.split('/').indexOf('..') >= 0)
            throw fail('mount folder must not contain ".."', { mountRoot: root });
        // Same rule the rest of the module applies to anything reaching argv.
        return requireSafe(s, 'mount folder');
    }

    function mountPoint(repoId, mountRoot) {
        return normalizeMountRoot(mountRoot) + '/' + Secrets.validateRepoId(repoIdOf(repoId));
    }

    // ---- relative labels ----------------------------------------------------

    // Thresholds are exclusive upper bounds on the absolute distance, chosen so
    // the label never reads "1 minutes": every ranged rule starts at a distance
    // that rounds to 2 or more.
    const SCALE = [
        [45 * SEC, null],
        [90 * SEC, '1 minute'],
        [45 * MIN, function (n) { return Math.round(n / MIN) + ' minutes'; }],
        [90 * MIN, '1 hour'],
        [22 * HOUR, function (n) { return Math.round(n / HOUR) + ' hours'; }],
        [36 * HOUR, '1 day'],
        [26 * DAY, function (n) { return Math.round(n / DAY) + ' days'; }],
        [46 * DAY, '1 month'],
        [320 * DAY, function (n) { return Math.round(n / MONTH) + ' months'; }],
        [548 * DAY, '1 year'],
        [Infinity, function (n) { return Math.round(n / YEAR) + ' years'; }]
    ];

    // '3 hours ago' for the scrubber. A snapshot from the future is a real state
    // — a host with a skewed clock backs up into next week — so it gets 'in 3
    // hours' rather than a negative number of hours ago.
    function formatRelative(then, now) {
        const a = toDate(then);
        if (!a) return 'unknown';
        const b = toDate(now);
        const diff = (b ? b.getTime() : Date.now()) - a.getTime();
        const abs = Math.abs(diff);

        for (let i = 0; i < SCALE.length; i++) {
            if (abs >= SCALE[i][0]) continue;
            const rule = SCALE[i][1];
            if (rule === null) return 'just now';
            const phrase = typeof rule === 'function' ? rule(abs) : rule;
            return diff < 0 ? 'in ' + phrase : phrase + ' ago';
        }
        return 'unknown';                           // unreachable: SCALE ends at Infinity
    }

    // ---- systemd-run argv (pure) --------------------------------------------

    function requireSafe(value, label, detail) {
        if (typeof value !== 'string' || value === '')
            throw fail(label + ' is required', detail);
        if (UNSAFE_RE.test(value))
            throw fail(label + ' contains a character systemd cannot express',
                { value: JSON.stringify(value) });
        return value;
    }

    // `systemd-run --unit=hangar-mount-<id> restic ... mount <point>`.
    //
    // A transient unit rather than a cockpit.spawn child: the mount has to
    // outlive the page. --collect is what makes retrying possible — without it a
    // failed mount leaves a failed unit behind and the next attempt is refused
    // for having a name that already exists.
    //
    // Backend credentials arrive as an EnvironmentFile path, never as
    // --setenv=KEY=VALUE, because a transient unit's command line is readable by
    // anyone who can run `systemctl show`.
    function buildMountArgv(opts) {
        const o = opts || {};
        const repoId = Secrets.validateRepoId(repoIdOf(o.repoId !== undefined ? o.repoId : o.repo));
        const point = requireSafe(o.mountPoint || mountPoint(repoId, o.mountRoot), 'mount point');
        const url = requireSafe(o.repoUrl, 'repository url', { repoId: repoId });
        const passwordFile = requireSafe(o.passwordFile || Secrets.keyPath(repoId), 'password file');
        const binary = requireSafe(o.resticBinary || 'restic', 'restic binary');

        const argv = [
            'systemd-run',
            '--unit=' + mountUnitName(repoId),
            '--description=hangar Logbook mount for ' + repoId,
            '--collect',
            '--service-type=exec'
        ];
        if (o.envFile !== undefined && o.envFile !== null) {
            const envFile = requireSafe(o.envFile, 'environment file');
            if (envFile.charAt(0) !== '/')
                throw fail('environment file must be an absolute path', { envFile: envFile });
            argv.push('--property=EnvironmentFile=' + envFile);
        }
        if (o.maxRuntimeSec !== undefined && o.maxRuntimeSec !== null) {
            // A backstop, not the idle timer: it caps how long a forgotten mount
            // can hold a repository lock even if the browser never comes back.
            // isSafeInteger for the same reason as the dedup index: 1e21 is an
            // "integer" that stringifies to "1e+21", which is not a number of
            // seconds systemd will accept.
            if (!Number.isSafeInteger(o.maxRuntimeSec) || o.maxRuntimeSec <= 0)
                throw fail('maxRuntimeSec must be a positive integer', { maxRuntimeSec: o.maxRuntimeSec });
            argv.push('--property=RuntimeMaxSec=' + o.maxRuntimeSec);
        }

        // --cache-dir for the same reason engine/restic.js passes it on every
        // command: this runs as a transient systemd unit, which has no $HOME, and
        // restic exits 1 rather than mounting when it cannot place its cache.
        argv.push(binary, '-r', url, '--password-file', passwordFile,
            '--cache-dir', RESTIC_CACHE_DIR, 'mount');
        if (o.allowOther) argv.push('--allow-other');
        argv.push(point);
        return argv;
    }

    // cockpit returns GetAll() as { name: { t: signature, v: value } }.
    function unwrapProps(raw) {
        const out = {};
        if (!raw || typeof raw !== 'object') return out;
        Object.keys(raw).forEach((k) => {
            const v = raw[k];
            const value = (v && typeof v === 'object' && 'v' in v) ? v.v : v;
            // defineProperty, not assignment: a property literally named
            // __proto__ would otherwise replace this object's prototype instead
            // of landing on it, and normalizeMountState would then read
            // ActiveState off the injected prototype.
            Object.defineProperty(out, k,
                { value: value, enumerable: true, writable: true, configurable: true });
        });
        return out;
    }

    // 'activating' is deliberately not mounted: restic has been exec'd but the
    // FUSE tree may not be readable yet, and listing it too early looks to the
    // user like an empty backup.
    function normalizeMountState(repoId, props) {
        const p = unwrapProps(props);
        const activeState = p.ActiveState || 'inactive';
        return {
            unit: mountUnitService(repoId),
            mountPoint: mountPoint(repoId),
            loadState: p.LoadState || 'not-found',
            activeState: activeState,
            subState: p.SubState || 'dead',
            result: p.Result || null,
            mounted: activeState === 'active',
            failed: activeState === 'failed'
        };
    }

    // ---- thin I/O layer (guarded; degrades to a typed rejection under node) --

    const SYSTEMD = 'org.freedesktop.systemd1';
    const MANAGER_PATH = '/org/freedesktop/systemd1';
    const MANAGER_IFACE = 'org.freedesktop.systemd1.Manager';
    const PROPS_IFACE = 'org.freedesktop.DBus.Properties';
    const UNIT_IFACE = 'org.freedesktop.systemd1.Unit';

    function hasCockpit() {
        return typeof cockpit !== 'undefined' && !!cockpit;
    }

    function noCockpit(op) {
        return fail('cockpit is unavailable', { op: op });
    }

    function ioError(e, op) {
        if (E.isHangarError(e)) return e;
        return fail((e && e.message) || 'Logbook mount operation failed',
            { op: op, problem: (e && e.problem) || null });
    }

    function bus() {
        if (!hasCockpit() || typeof cockpit.dbus !== 'function') return null;
        const d = cockpit.dbus(SYSTEMD, { superuser: 'require' });
        // A proxy without .call is the same situation as no cockpit at all, and
        // has to fail the same way: a bare TypeError out of here would reach the
        // UI as an untyped rejection with no remediation attached.
        return d && typeof d.call === 'function' ? d : null;
    }

    // ---- waiting for the mount to actually serve ----------------------------
    //
    // systemd-run returns as soon as the unit's process has been EXECUTED, not
    // when restic has attached FUSE and served a tree. Listing straight after it
    // therefore races the mount, and the user gets:
    //
    //   find: '/run/hangar/mnt/<repo>/snapshots/<time>': No such file or directory
    //
    // about a snapshot that exists perfectly well. A tiny local repository takes
    // ~0.75 s to become listable (measured); a repository on a NAS has to fetch
    // its index over the network first and takes considerably longer.

    const READY_TIMEOUT_MS = 30000;
    const READY_INTERVAL_MS = 250;

    // Pure: what to ask, and how long to keep asking.
    function readyArgv(path) {
        return ['test', '-d', requireSafe(str(path), 'mount point')];
    }

    function waitOptions(opts) {
        const o = opts || {};
        const num = (v, dflt, min, max) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return dflt;
            return Math.min(max, Math.max(min, Math.round(n)));
        };
        return {
            // Bounded at both ends: a zero timeout would make the wait pointless,
            // and an unbounded one would hang the screen on a destination that is
            // never coming back.
            timeoutMs: num(o.timeoutMs, READY_TIMEOUT_MS, 1000, 5 * 60 * 1000),
            intervalMs: num(o.intervalMs, READY_INTERVAL_MS, 50, 5000)
        };
    }

    // Resolves true once the snapshots directory is there, false on timeout.
    // Never rejects: the caller's answer to "not ready" is to fall back to the
    // slower reader, which is a better outcome than an error about a missing path.
    function waitForMount(point, opts) {
        const o = waitOptions(opts);
        if (!hasCockpit() || typeof cockpit.spawn !== 'function') return Promise.resolve(false);
        const argv = readyArgv(str(point).replace(/\/+$/, '') + '/' + SNAPSHOT_DIR);
        const deadline = Date.now() + o.timeoutMs;
        const attempt = () => cockpit.spawn(argv, { superuser: 'require', err: 'message' })
            .then(() => true)
            .catch(() => {
                if (Date.now() >= deadline) return false;
                return new Promise((resolve) => setTimeout(resolve, o.intervalMs)).then(attempt);
            });
        return attempt();
    }

    // Is the kernel still holding a mountpoint nobody is serving?
    //
    // Asked of /proc/mounts, never of the path itself. Everything that stats a
    // stale FUSE mount fails with ENOTCONN — including `mountpoint -q`, which
    // reports "not a mountpoint" for exactly the mounts this needs to find, and
    // including the `install -d` below. /proc/mounts is a kernel table: reading
    // it touches no filesystem and cannot hang.
    //
    // Nothing here may fail a mount. A path that is not stale, or a system
    // without fusermount, must simply carry on.
    function clearStaleMount(point) {
        return Promise.resolve().then(() => {
            if (!hasCockpit() || typeof cockpit.spawn !== 'function') return false;
            if (typeof cockpit.file !== 'function') return false;
            return cockpit.file('/proc/mounts').read()
                .then((text) => {
                    const target = str(point);
                    const listed = str(text).split('\n').some((line) => {
                        // "<source> <mountpoint> <type> <options> 0 0", and the
                        // kernel escapes spaces as \040 — our paths have none,
                        // but split on whitespace rather than searching, so a
                        // path that merely CONTAINS this one cannot match.
                        const field = line.split(' ')[1];
                        return field === target;
                    });
                    if (!listed) return false;
                    const run = (argv) => cockpit.spawn(argv,
                        { superuser: 'require', err: 'message' });
                    return run(['fusermount', '-u', target])
                        // -l, because a stale mount can still hold references and
                        // a plain umount would refuse: the point is only to stop
                        // the kernel answering ENOTCONN on this path.
                        .catch(() => run(['umount', '-l', target]).catch(() => null))
                        .then(() => true);
                })
                .catch(() => false);
        });
    }

    function mount(opts) {
        return Promise.resolve().then(() => {
            const o = opts || {};
            const repoId = Secrets.validateRepoId(repoIdOf(o.repoId !== undefined ? o.repoId : o.repo));
            const point = o.mountPoint || mountPoint(repoId, o.mountRoot);
            const argv = buildMountArgv(o);
            // The spawn check mirrors bus(): every way out of this module is a
            // typed rejection, including "cockpit is here but not usable".
            if (!hasCockpit() || typeof cockpit.spawn !== 'function') throw noCockpit('mount');
            // 0700 root:root before the mount: an unprivileged process must not
            // be able to sit in the mount point directory and watch a restore.
            // Clear a dead mount before touching the path at all. When the restic
            // process behind a FUSE mount dies without unmounting — the unit was
            // stopped, the machine was busy, anything — the KERNEL keeps the
            // mountpoint and every access to it returns ENOTCONN. `install -d`
            // below stats that path, so without this the next mount fails on the
            // wreckage of the last one, for ever, and the only cure is a hand-run
            // fusermount. Observed exactly that: "mountpoint is inaccessible".
            return clearStaleMount(point)
                .then(() => cockpit.spawn(['install', '-d', '-m', MOUNT_DIR_MODE, '-o', 'root', '-g', 'root', point],
                    { superuser: 'require', err: 'message' }))
                .then(() => cockpit.spawn(argv, { superuser: 'require', err: 'message' }))
                .then(() => ({ unit: mountUnitService(repoId), mountPoint: point }))
                .catch((e) => { throw ioError(e, 'mount'); });
        });
    }

    function unmount(repoId) {
        return Promise.resolve().then(() => {
            const unit = mountUnitService(repoId);
            const d = bus();
            if (!d) throw noCockpit('unmount');
            // Stopping the unit SIGTERMs restic, which unmounts on its way out.
            // ResetFailedUnit afterwards so a mount that died badly does not
            // block the next mount by name.
            return d.call(MANAGER_PATH, MANAGER_IFACE, 'StopUnit', [unit, 'replace'])
                .catch((e) => { throw ioError(e, 'unmount'); })
                .then(() => d.call(MANAGER_PATH, MANAGER_IFACE, 'ResetFailedUnit', [unit])
                    .catch(() => null))
                .then(() => ({ unit: unit, mountPoint: mountPoint(repoId) }));
        });
    }

    // systemd is the only source of truth here: the mount survives page reloads,
    // so nothing in the page can remember whether it made one.
    function isMounted(repoId) {
        return Promise.resolve().then(() => {
            const unit = mountUnitService(repoId);
            const d = bus();
            if (!d) throw noCockpit('isMounted');
            return d.call(MANAGER_PATH, MANAGER_IFACE, 'LoadUnit', [unit])
                .then((reply) => d.call(reply && reply[0], PROPS_IFACE, 'GetAll', [UNIT_IFACE]))
                .then((reply) => normalizeMountState(repoId, reply && reply[0]))
                .catch((e) => { throw ioError(e, 'isMounted'); });
        });
    }

    const HangarLogbook = {
        MOUNT_ROOT, MOUNT_UNIT_PREFIX, SNAPSHOT_DIR, MOUNT_DIR_MODE,
        GRANULARITY, WINDOWS, BADGE,
        // pure
        clearStaleMount,
        buildTimeline, granularityFor, bucketStart, bucketKey, bandLabel,
        snapshotTimestampDir, snapshotPath,
        diffToBadges, badgeForModifier,
        parseLsJson,
        mountUnitName, mountUnitService, mountPoint, normalizeMountRoot,
        readyArgv, waitOptions, waitForMount,
        formatRelative,
        buildMountArgv, unwrapProps, normalizeMountState,
        // impure
        mount, unmount, isMounted
    };
    root.HangarLogbook = HangarLogbook;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarLogbook;
})(typeof window !== 'undefined' ? window : globalThis);
