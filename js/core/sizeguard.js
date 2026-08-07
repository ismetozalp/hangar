// core/sizeguard.js — keep a repository under a size limit by forgetting its
// oldest snapshots, one at a time, and refusing to go too far.
//
// Entirely pure: no cockpit reference, no I/O. It decides; js/engine/restic.js
// and the caller do the forgetting, the pruning and the measuring.
//
// Why this module is shaped the way it is — three facts, established by running
// the real tools, that the design is forced to obey:
//
//   1. restic has NO size or quota option. `forget` offers counts (--keep-last N)
//      and durations (--keep-within 30d) and nothing else. Everything here is
//      hangar's own logic layered on top.
//   2. The number a caller feeds in as `currentBytes` must come from
//      `restic stats --json --mode raw-data`. `stats` DEFAULTS to
//      --mode restore-size, which sums the sizes of restored FILES, not the bytes
//      the repository occupies. Measured on a real 2.0 MB repository, the default
//      mode reported 5.9 MB. A guard fed that number believes the repository is
//      several times its real size and deletes snapshots that were never the
//      problem.
//   3. Deduplication makes freed space unpredictable. Snapshots share blobs, so
//      forgetting a snapshot that "contains" 40 GB can free almost nothing when
//      its neighbours reference the same data. You therefore cannot compute up
//      front how many snapshots to delete. The only correct shape is iterative:
//      forget the oldest -> prune -> measure -> ask again.
//
// The load-bearing rule is the FLOOR in planTrim(). A size cap with no floor
// deletes the last remaining backup whenever the source data alone exceeds the
// cap — and then reports success, because the repository is finally under the
// limit. planTrim must stop and say so instead. Everything below is arranged so
// that the dangerous outcome is unreachable rather than merely unlikely:
// every uncertain input (an unusable limit, an unmeasurable size, a snapshot
// list with no usable timestamps) resolves to "delete nothing", never to a guess.
'use strict';
(function (root) {
    // errors.js may be loaded either as a plain script (global already set) or by
    // node's require, in any order — resolve whichever is available.
    const Errors = root.HangarErrors ||
        (typeof require === 'function' ? require('./errors.js') : null);

    // ---- sizes --------------------------------------------------------------

    // Decimal units are powers of 1000, binary units powers of 1024. Both are
    // accepted because both are typed: a disk vendor's "500 GB" and a filesystem
    // tool's "500 GiB" differ by 7%, and silently treating one as the other is a
    // 37 GB error on a 500 GB cap.
    //
    // A BARE letter — "500G", "800M" — is DECIMAL. That is the convention the
    // rest of hangar displays (formatBytes in js/features/logbook-ui.js divides by
    // 1000), so a user who types back the number the UI just showed them gets the
    // size they saw. Binary must be spelled with the `i`: GiB, MiB, TiB.
    // Frozen: it is exported so the UI can document the units it accepts, and a
    // mutated multiplier here would silently rescale every limit in the product.
    const UNIT_BYTES = Object.freeze({
        '': 1,
        b: 1,
        k: 1e3, kb: 1e3, kib: 1024,
        m: 1e6, mb: 1e6, mib: 1024 * 1024,
        g: 1e9, gb: 1e9, gib: 1024 * 1024 * 1024,
        t: 1e12, tb: 1e12, tib: 1024 * 1024 * 1024 * 1024,
        p: 1e15, pb: 1e15, pib: 1024 * 1024 * 1024 * 1024 * 1024
    });

    // One optional sign, a plain decimal number, optional spaces or tabs, an
    // optional unit of at most three letters. Deliberately narrow:
    //   - no exponent ("1e3"), no hex ("0x10"), no separators ("1,000", "1_000"),
    //     because "1,000" means one thousand in one locale and one in another and
    //     a misread limit deletes backups;
    //   - no newlines inside the value, so a pasted multi-line blob is refused
    //     rather than half-read;
    //   - the whole string must match, so "500GB extra" is not silently "500GB".
    // Anchored with no nested quantifier, so it cannot backtrack on long input.
    const SIZE_RE = /^(-?)(\d+(?:\.\d+)?)[ \t]*([A-Za-z]{0,3})$/;

    // BINARY, matching formatBytes() in features/logbook-ui.js, overview.js and
    // jobs-ui.js. Duplicated rather than imported because core/ must not depend on
    // features/ — the two are kept in step by tests, not by a shared reference.
    //
    // PARSING is untouched: "1TB" still means 10^12 and "1TiB" still means 2^40,
    // because that is what the user typed. Only the rendering is unified, which
    // means a limit entered as 1TB now reads back as "931 GiB" — the same unit as
    // the repository size it is being compared against, which is the whole point.
    const DISPLAY_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
    const DISPLAY_STEP = 1024;

    // parseSize returns a byte count, or null when the text is not a size.
    //
    // NEVER a guess: anything it cannot read exactly becomes null, because a
    // misparsed limit is not a cosmetic bug — it is a decision to delete
    // backups. "Unreadable" is a state the UI can report; "probably 500 GB" is
    // not.
    //
    // Zero and negative values DO parse. They are perfectly readable sizes that
    // happen to be unusable as a limit, and validateGuard() can then say "a size
    // limit must be greater than zero" instead of the useless "unparseable".
    // planTrim() independently refuses any limit that is not a positive finite
    // number, so a negative result can never become a licence to delete.
    function parseSize(input) {
        // A bare number is bytes. Booleans are excluded first: Number(true) is 1,
        // so an unguarded boolean would become a one-byte limit.
        if (typeof input === 'number') {
            if (!Number.isFinite(input)) return null;
            const n = Math.round(input);
            return Number.isSafeInteger(n) ? (n === 0 ? 0 : n) : null;
        }
        if (typeof input !== 'string') return null;

        const t = input.trim();
        if (!t) return null;

        const m = SIZE_RE.exec(t);
        if (!m) return null;

        const unit = m[3].toLowerCase();
        // Own-property lookup: without it a unit spelled to collide with an
        // inherited member would resolve to a function and multiply to NaN.
        if (!Object.prototype.hasOwnProperty.call(UNIT_BYTES, unit)) return null;

        const value = parseFloat(m[2]);
        // 400 digits of "9" parse to Infinity. A limit nobody can represent is
        // not a limit we may act on.
        if (!Number.isFinite(value)) return null;

        const magnitude = Math.round(value * UNIT_BYTES[unit]);
        const bytes = m[1] === '-' ? -magnitude : magnitude;
        // Past MAX_SAFE_INTEGER (~9 PB) the value no longer survives arithmetic
        // or a JSON round trip, so it is no longer the number the user typed.
        if (!Number.isSafeInteger(bytes)) return null;
        return bytes === 0 ? 0 : bytes;   // normalise -0, which is not deepEqual 0
    }

    // Human text for a byte count, decimal, matching the rest of hangar.
    function formatSize(bytes) {
        // Only a number or a numeric string is a size. Everything else — a
        // boolean (Number(true) is 1, which would render as a one-byte
        // repository), a symbol (Number() throws on it), an object — is nothing.
        if (typeof bytes !== 'number' && typeof bytes !== 'string') return '0 B';
        const raw = Number(bytes);
        if (!Number.isFinite(raw) || raw <= 0) return '0 B';
        // Clamped rather than divided down: past MAX_SAFE_INTEGER the division
        // chain reaches exponential notation ('1e+285 PB'), which is not a size a
        // human reads and not a size a filesystem holds.
        const n = Math.min(raw, Number.MAX_SAFE_INTEGER);
        if (n < DISPLAY_STEP) return Math.round(n) + ' B';
        let value = n;
        let unit = 0;
        while (value >= DISPLAY_STEP && unit < DISPLAY_UNITS.length - 1) {
            value /= DISPLAY_STEP;
            unit++;
        }
        const rounded = Math.round(value * 10) / 10;
        const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
        return text + ' ' + DISPLAY_UNITS[unit];
    }

    // ---- defaults -----------------------------------------------------------

    const DEFAULTS = Object.freeze({
        // How many snapshots must survive no matter what the limit says.
        //
        // Three, not one. A floor of one leaves no margin at all: if the single
        // surviving snapshot is the one taken AFTER the deletion you are trying
        // to undo, or the one whose read failed, there is nothing behind it.
        // Three survives one bad snapshot and one failed restore attempt while
        // still leaving a size cap real room to work.
        minSnapshots: 3,

        // How many forget+prune passes one guard run may make.
        //
        // Bounded because `prune` rewrites repository data: on a remote
        // destination a single pass takes minutes, sometimes far longer. Twenty
        // passes reclaim a large overshoot on a repository with ordinary
        // retention, and still cannot turn a nightly unit into an all-day job.
        // When the budget runs out the run STOPS and reports 'exhausted' — it
        // does not keep going, and it does not pretend to have succeeded.
        maxIterations: 20
    });

    // A limit below this is almost certainly a typo — a bare number is bytes, so
    // "500" is 500 bytes, not 500 GB. Such a cap is smaller than any real
    // snapshot and would grind the repository down to the floor on the first run.
    // It is a warning rather than an error because a tiny repository of text
    // files is a legitimate, if unusual, thing to cap.
    const SUSPICIOUS_LIMIT_BYTES = 1e9;

    // ---- validation ---------------------------------------------------------

    function isPlainObject(v) {
        return !!v && typeof v === 'object' && !Array.isArray(v);
    }

    // Problems are HangarErrors so the UI renders them through one path, as in
    // core/retention.js. The machine-readable discriminator lives in detail.code;
    // detail.severity separates "refuse to save" from "save, but say this out
    // loud". The error KIND stays GENERIC: these are user input faults, not tool
    // outcomes.
    function problem(code, message, detail) {
        return Errors.create(Errors.KIND.GENERIC, message,
            Object.assign({ code: code, severity: 'error' }, detail || {}));
    }

    function warning(code, message, detail) {
        return Errors.create(Errors.KIND.GENERIC, message,
            Object.assign({ code: code, severity: 'warning' }, detail || {}));
    }

    function hasBlockingProblem(problems) {
        if (!Array.isArray(problems)) return false;
        return problems.some((p) => !!p && !!p.detail && p.detail.severity === 'error');
    }

    // validateGuard({ limit, minSnapshots }) -> array of problems, empty when the
    // configuration is safe to save. Reports everything at once.
    function validateGuard(cfg) {
        if (!isPlainObject(cfg)) {
            return [problem('not-object', 'Size guard settings must be an object.', { value: cfg })];
        }

        const problems = [];
        const limit = cfg.limit;

        if (limit === undefined || limit === null || limit === '') {
            problems.push(problem('limit-missing',
                'Enter a size limit, for example 500 GB.', { field: 'limit' }));
        } else {
            const bytes = parseSize(limit);
            if (bytes === null) {
                problems.push(problem('limit-unparseable',
                    'That is not a size hangar can read. Use a number and a unit, ' +
                    'like 500 GB, 1.5 TiB or 800M.',
                    { field: 'limit', value: limit }));
            } else if (bytes <= 0) {
                problems.push(problem('limit-not-positive',
                    'A size limit must be greater than zero.',
                    { field: 'limit', value: limit }));
            } else if (bytes < SUSPICIOUS_LIMIT_BYTES) {
                problems.push(warning('limit-suspicious',
                    'That limit is only ' + formatSize(bytes) + ', which is smaller ' +
                    'than a single backup is likely to be. A number with no unit means ' +
                    'bytes: 500 is 500 bytes, not 500 GB.',
                    { field: 'limit', value: limit, bytes: bytes }));
            }
        }

        const min = cfg.minSnapshots;
        if (min !== undefined && min !== null) {
            if (typeof min !== 'number' || !Number.isSafeInteger(min)) {
                problems.push(problem('min-not-integer',
                    'The minimum number of snapshots must be a whole number.',
                    { field: 'minSnapshots', value: min }));
            } else if (min < 1) {
                problems.push(problem('min-too-low',
                    'The minimum number of snapshots must be at least 1 — a size ' +
                    'limit must never be allowed to delete the last backup.',
                    { field: 'minSnapshots', value: min }));
            } else if (min === 1) {
                // Not an error: one is a real answer for a tiny destination. But a
                // floor of one is nearly no floor at all — it protects only against
                // an empty repository, not against being left with a single
                // snapshot that is itself the problem.
                problems.push(warning('min-floor-one',
                    'A minimum of 1 snapshot leaves no margin: if that last ' +
                    'snapshot is unreadable or is newer than the mistake you need ' +
                    'to undo, there is nothing behind it.',
                    { field: 'minSnapshots', value: min }));
            }
        }

        return problems;
    }

    // ---- the decision -------------------------------------------------------

    // Bytes by which `currentBytes` exceeds `limitBytes`, or 0. Never negative,
    // never NaN: anything unreadable is reported as "not over", which is the
    // answer that deletes nothing.
    function overBy(currentBytes, limitBytes) {
        if (typeof currentBytes !== 'number' || !Number.isFinite(currentBytes)) return 0;
        if (typeof limitBytes !== 'number' || !Number.isFinite(limitBytes)) return 0;
        const over = currentBytes - limitBytes;
        return over > 0 ? over : 0;
    }

    // The floor actually applied, which is NOT simply what the caller asked for.
    // An absent or nonsensical value falls back to the default, and no value can
    // ever push the floor below 1: whatever a config file says, this module will
    // not plan the deletion of the last remaining backup.
    function effectiveFloor(minSnapshots) {
        if (minSnapshots === undefined || minSnapshots === null) return DEFAULTS.minSnapshots;
        if (typeof minSnapshots !== 'number' || !Number.isSafeInteger(minSnapshots))
            return DEFAULTS.minSnapshots;
        return minSnapshots < 1 ? 1 : minSnapshots;
    }

    function effectiveBudget(maxIterations) {
        if (maxIterations === undefined || maxIterations === null) return DEFAULTS.maxIterations;
        if (typeof maxIterations !== 'number' || !Number.isSafeInteger(maxIterations))
            return DEFAULTS.maxIterations;
        return maxIterations < 0 ? 0 : maxIterations;
    }

    // Passes already made. Unreadable means "we do not know", and the safe
    // reading of that is zero — the budget check below still bounds the loop.
    function iterationsDone(v) {
        if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return 0;
        return v;
    }

    // Epoch milliseconds for a snapshot, or null when it cannot be dated.
    //
    // A bare number is REFUSED on purpose: restic emits ISO 8601 strings, and a
    // raw number could be epoch seconds or milliseconds — a factor of 1000
    // between the two would silently reorder the whole list and pick the newest
    // snapshot as the oldest.
    function timeOf(snapshot) {
        const t = snapshot.time;
        if (t instanceof Date) {
            const ms = t.getTime();
            return Number.isFinite(ms) ? ms : null;
        }
        if (typeof t !== 'string' || !t.trim()) return null;
        const ms = Date.parse(t);
        return Number.isFinite(ms) ? ms : null;
    }

    function idOf(snapshot) {
        return typeof snapshot.id === 'string' && snapshot.id ? snapshot.id : null;
    }

    function decision(action, snapshot, reason, remaining) {
        return { action: action, snapshot: snapshot, reason: reason, remaining: remaining };
    }

    // planTrim decides the SINGLE next step of a trim loop.
    //
    //   { currentBytes, limitBytes, snapshots, minSnapshots, iterations, maxIterations }
    //     -> { action, snapshot, reason, remaining }
    //
    // action:
    //   'none'          nothing to do — under the limit, or the guard cannot
    //                   apply at all (no usable limit, unmeasurable size).
    //   'forget'        forget `snapshot` — the OLDEST — then prune, then measure
    //                   and call again.
    //   'floor-reached' still over the limit, but nothing more may be deleted.
    //   'exhausted'     still over the limit, iteration budget spent.
    //
    // `remaining` is the bytes by which the repository is STILL over the limit at
    // the moment of this decision (0 when it is not over). It is the loop's
    // progress signal and the number the journal sentence quotes.
    //
    // Exactly one snapshot per call. Deleting a batch is tempting and wrong:
    // deduplication means the space a forget frees cannot be known in advance, so
    // a batch overshoots by an unknowable amount — and an overshoot here is
    // destroyed history, not a wasted byte.
    function planTrim(input) {
        const cfg = isPlainObject(input) ? input : {};

        // --- refusals: every uncertain input resolves to "delete nothing" -----

        // No usable limit means the guard is not configured, not that everything
        // is over. Strings are refused rather than coerced: this function takes
        // bytes, and parsing belongs to parseSize where a failure is visible.
        const limitBytes = cfg.limitBytes;
        if (typeof limitBytes !== 'number' || !Number.isFinite(limitBytes) || limitBytes <= 0)
            return decision('none', null, 'no-limit', 0);

        // An unmeasurable repository size is the input most likely to be wrong in
        // the dangerous direction, so it is refused outright. A caller that hands
        // over a failed `restic stats` gets "nothing deleted", never "delete
        // until it fits".
        const currentBytes = cfg.currentBytes;
        if (typeof currentBytes !== 'number' || !Number.isFinite(currentBytes) || currentBytes < 0)
            return decision('none', null, 'unknown-size', 0);

        // --- the common case, checked before anything expensive ---------------

        const remaining = overBy(currentBytes, limitBytes);
        if (remaining === 0) return decision('none', null, 'under-limit', 0);

        // --- over the limit ---------------------------------------------------

        // Anything that is not an object is not a snapshot and is not counted.
        const present = (Array.isArray(cfg.snapshots) ? cfg.snapshots : [])
            .filter(isPlainObject);

        if (present.length === 0)
            return decision('floor-reached', null, 'no-snapshots', remaining);

        // The floor is checked against every snapshot that EXISTS, not just the
        // ones we could delete: the point of the floor is how much history
        // survives, so an entry we cannot name still counts as surviving history.
        const floor = effectiveFloor(cfg.minSnapshots);
        if (present.length <= floor)
            return decision('floor-reached', null, 'floor', remaining);

        // Checked after the floor, deliberately: when both apply, the floor is
        // the durable condition. Saying "budget spent" would invite an operator
        // to raise the budget and re-run, which cannot help — more passes will
        // never delete past the floor.
        if (iterationsDone(cfg.iterations) >= effectiveBudget(cfg.maxIterations))
            return decision('exhausted', null, 'budget', remaining);

        // A candidate must be nameable (restic forgets by id) and datable (we
        // must know it is the oldest). Input ORDER is never used as a fallback:
        // restic lists oldest-first but callers sort, reverse and filter, and
        // trusting an assumed order is exactly how a guard deletes the newest
        // snapshot.
        let best = null;
        present.forEach((s) => {
            const id = idOf(s);
            if (id === null) return;
            const ms = timeOf(s);
            if (ms === null) return;
            // Ties break on id so the choice is identical for every permutation
            // of the same list — a shuffled input must never change the outcome.
            if (best === null || ms < best.ms || (ms === best.ms && id < best.id))
                best = { snapshot: s, ms: ms, id: id };
        });

        if (best === null)
            return decision('floor-reached', null, 'undatable', remaining);

        return decision('forget', best.snapshot, 'oldest', remaining);
    }

    // ---- the sentence -------------------------------------------------------

    function shortIdOf(snapshot) {
        if (!isPlainObject(snapshot)) return 'the oldest snapshot';
        if (typeof snapshot.shortId === 'string' && snapshot.shortId)
            return 'snapshot ' + snapshot.shortId;
        if (typeof snapshot.id === 'string' && snapshot.id)
            return 'snapshot ' + snapshot.id.slice(0, 8);
        return 'the oldest snapshot';
    }

    // One plain sentence for the journal and the UI.
    //
    // The rule it must obey: a run that stopped while still over the limit has to
    // READ like it stopped. 'floor-reached' and 'exhausted' are not successes —
    // they are the guard declining to keep deleting — and a sentence that glosses
    // over that is worse than no sentence, because someone will read it in a
    // nightly digest and conclude the size problem is handled.
    function describeOutcome(result) {
        const r = isPlainObject(result) ? result : {};
        const over = typeof r.remaining === 'number' && Number.isFinite(r.remaining) && r.remaining > 0
            ? formatSize(r.remaining)
            : null;
        const stillOver = over ? 'still ' + over + ' over its size limit' : 'still over its size limit';

        switch (r.action) {
        case 'none':
            if (r.reason === 'no-limit')
                return 'No size limit is set for this repository, so no snapshots were deleted.';
            if (r.reason === 'unknown-size')
                return 'The repository size could not be measured, so no snapshots were ' +
                    'deleted. Nothing was changed.';
            return 'The repository is within its size limit. No snapshots were deleted.';

        case 'forget':
            return 'The repository is ' + (over ? over + ' over' : 'over') +
                ' its size limit. Forgetting the oldest ' + shortIdOf(r.snapshot) +
                ', then pruning and measuring again.';

        case 'floor-reached':
            if (r.reason === 'no-snapshots')
                return 'Stopped: the repository is ' + stillOver + ' and has no snapshots ' +
                    'left to delete. The size limit cannot be met by deleting backups.';
            if (r.reason === 'undatable')
                return 'Stopped: the repository is ' + stillOver + ', but its snapshots ' +
                    'carry no usable timestamps, so hangar cannot tell which is oldest ' +
                    'and deleted nothing.';
            return 'Stopped: the repository is ' + stillOver + ', but deleting another ' +
                'snapshot would leave fewer backups than the minimum. Nothing more was ' +
                'deleted — raise the limit, or back up less data.';

        case 'exhausted':
            return 'Stopped after the maximum number of prune passes with the repository ' +
                stillOver + '. Nothing further was deleted; the guard will continue on ' +
                'the next run.';

        default:
            // An unrecognised result is reported as such rather than smoothed
            // into a success sentence.
            return 'The size guard returned no usable decision, so no snapshots were deleted.';
        }
    }

    const HangarSizeGuard = {
        DEFAULTS, UNIT_BYTES, SUSPICIOUS_LIMIT_BYTES,
        parseSize, formatSize, validateGuard, hasBlockingProblem,
        overBy, effectiveFloor, planTrim, describeOutcome
    };
    root.HangarSizeGuard = HangarSizeGuard;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarSizeGuard;
})(typeof window !== 'undefined' ? window : globalThis);
