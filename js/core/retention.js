// core/retention.js — retention policy: presets, restic forget args, validation,
// and the human sentence the UI shows under the policy picker.
//
// This module is entirely pure: retention has no I/O of its own. The policy is
// data that js/engine/restic.js turns into a `forget` invocation, so keeping
// zero `cockpit` references here means the whole thinning model is unit testable.
//
// The load-bearing rule is the delete-everything guard in validate(): a policy
// with no positive keep value makes `restic forget --prune` destroy every
// snapshot in the group. That is unrecoverable, so it is an error, never a
// warning, and the UI must refuse to save a policy that fails it.
'use strict';
(function (root) {
    // errors.js may be loaded either as a plain script (global already set) or by
    // node's require, in any order — resolve whichever is available.
    const Errors = root.HangarErrors ||
        (typeof require === 'function' ? require('./errors.js') : null);

    // restic applies retention per host+path group. Without this, snapshots of a
    // path that stopped being backed up get counted against a different path's
    // budget and silently thinned away. It is never optional.
    const GROUP_BY = ['--group-by', 'host,paths'];

    // Ordered: emission order of toArgs() and reading order of describe().
    // `word` is the noun phrase describe() uses for the bucket.
    const COUNT_KEYS = [
        { key: 'last', flag: '--keep-last', word: 'most recent' },
        { key: 'hourly', flag: '--keep-hourly', word: 'hourly' },
        { key: 'daily', flag: '--keep-daily', word: 'daily' },
        { key: 'weekly', flag: '--keep-weekly', word: 'weekly' },
        { key: 'monthly', flag: '--keep-monthly', word: 'monthly' },
        { key: 'yearly', flag: '--keep-yearly', word: 'yearly' }
    ];

    // The design doc names these fields keepLast/keepWithin/keepTag; stored job
    // JSON uses the short form. Accept both rather than making callers guess.
    const ALIASES = {
        keepLast: 'last',
        keepHourly: 'hourly',
        keepDaily: 'daily',
        keepWeekly: 'weekly',
        keepMonthly: 'monthly',
        keepYearly: 'yearly',
        keepWithin: 'within',
        keepTag: 'tags',
        tag: 'tags'
    };

    const CANONICAL = COUNT_KEYS.map((c) => c.key).concat(['within', 'tags']);

    // restic durations are y/m/d/h, in that order, each part optional but at
    // least one required. Weeks and seconds are not accepted by restic.
    const DURATION_RE = /^(?:(\d+)y)?(?:(\d+)m)?(?:(\d+)d)?(?:(\d+)h)?$/;

    const PRESETS = {
        // Just enough to survive a bad week without paying for a year of history.
        minimal: Object.freeze({ last: 1, daily: 7, weekly: 4 }),
        // The default. A year of coverage that thins smoothly as it ages, which
        // is what makes the Logbook scrubber feel continuous rather than sparse.
        rolling: Object.freeze({ hourly: 24, daily: 30, weekly: 52, monthly: 12 }),
        // Compliance-shaped: a decade of yearlies and a full week of hourlies.
        paranoid: Object.freeze({
            last: 10, hourly: 168, daily: 90, weekly: 104, monthly: 60, yearly: 10
        }),
        // For small or expensive destinations: recent days plus a short tail.
        'space-saver': Object.freeze({ last: 1, daily: 7, monthly: 3 }),

        // Age-based, which is what people usually mean by "delete backups older
        // than a month". `--keep-within` keeps EVERY snapshot inside the window
        // rather than thinning it, so an hourly job on a 30-day window keeps ~720
        // snapshots — cheap in a deduplicating repository, but worth knowing.
        //
        // Each carries `last: 1` as a floor. Without it, a repository whose newest
        // snapshot is already older than the window would have every snapshot
        // forgotten in one run: restic measures the window from the LATEST
        // snapshot, so a job that stops running is safe, but one whose source
        // disappears and whose window then lapses is not.
        'last-30-days': Object.freeze({ last: 1, within: '30d' }),
        'last-90-days': Object.freeze({ last: 1, within: '90d' }),
        'last-year': Object.freeze({ last: 1, within: '1y' }),

        // Age-based with thinning: everything for a week, then one a day for a
        // month and one a month for a year. Usually what someone wants when they
        // ask for "30 days" but does not want 700 snapshots.
        'recent-then-thin': Object.freeze({
            last: 1, within: '7d', daily: 30, monthly: 12
        })
    };
    Object.freeze(PRESETS);

    const DEFAULT_PRESET = 'rolling';

    // Returns a mutable copy: the UI edits a preset as the starting point of a
    // custom policy, and must not be able to mutate the shared table.
    function preset(name) {
        // Typed guard first: an object with a null prototype cannot be coerced to
        // a property key, so hasOwnProperty would throw a bare TypeError on it.
        if (typeof name !== 'string') return null;
        const p = Object.prototype.hasOwnProperty.call(PRESETS, name) ? PRESETS[name] : null;
        return p ? Object.assign({}, p) : null;
    }

    function isPlainObject(v) {
        return !!v && typeof v === 'object' && !Array.isArray(v);
    }

    // Splits a caller policy into canonical form plus the keys we did not
    // recognise; validate() reports those rather than dropping them, because a
    // typo like `wekly: 52` would otherwise silently discard a whole bucket.
    function split(policy) {
        const norm = {};
        const unknown = [];
        if (!isPlainObject(policy)) return { norm, unknown };

        CANONICAL.forEach((k) => {
            if (Object.prototype.hasOwnProperty.call(policy, k)) norm[k] = policy[k];
        });
        Object.keys(policy).forEach((k) => {
            if (CANONICAL.indexOf(k) >= 0) return;
            // Own-property lookup only: a policy key named `toString` or
            // `constructor` would otherwise resolve to an inherited function and
            // be accepted as an alias, which is exactly the silent-typo failure
            // this function exists to prevent.
            const canon = Object.prototype.hasOwnProperty.call(ALIASES, k) ? ALIASES[k] : null;
            if (!canon) {
                unknown.push(k);
                return;
            }
            if (!Object.prototype.hasOwnProperty.call(norm, canon)) norm[canon] = policy[k];
        });
        return { norm, unknown };
    }

    function normalize(policy) {
        return split(policy).norm;
    }

    function parseDuration(text) {
        if (typeof text !== 'string') return null;
        const t = text.trim();
        if (!t) return null;
        const m = DURATION_RE.exec(t);
        // A regex of all-optional groups also matches the empty string, so an
        // all-undefined match means "no units given" (e.g. "5" or "").
        if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
        const years = m[1] ? parseInt(m[1], 10) : 0;
        const months = m[2] ? parseInt(m[2], 10) : 0;
        const days = m[3] ? parseInt(m[3], 10) : 0;
        const hours = m[4] ? parseInt(m[4], 10) : 0;
        return {
            years, months, days, hours,
            // Nominal year/month lengths — only ever used for UI estimates and
            // for deciding whether the duration is non-zero.
            totalHours: ((years * 365 + months * 30 + days) * 24) + hours
        };
    }

    // Tags may be a single string or a list; blanks are dropped so an empty text
    // field does not become `--keep-tag ''`.
    function tagList(value) {
        if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
        if (!Array.isArray(value)) return [];
        return value
            .filter((t) => typeof t === 'string' && t.trim())
            .map((t) => t.trim());
    }

    function badTags(value) {
        if (value === undefined || value === null) return false;
        if (typeof value === 'string') return false;
        if (!Array.isArray(value)) return true;
        return value.some((t) => typeof t !== 'string' || !t.trim());
    }

    // toArgs is deliberately lenient: it emits only values restic would accept
    // and drops everything else, so a half-edited form can still be previewed.
    // validate() is what explains to the user why a value was dropped.
    function countArg(value) {
        if (value === undefined || value === null || value === '') return null;
        // A count is a JSON number or a form string; nothing else is coerced.
        // Number(symbol) throws, and Number([5]) or Number(true) would invent a
        // count the user never entered.
        if (typeof value !== 'number' && typeof value !== 'string') return null;
        const n = Number(value);
        // isSafeInteger, not isInteger: beyond 2^53 String() renders 1e+21, which
        // restic's flag parser rejects, and the value is no longer the one typed.
        if (!Number.isSafeInteger(n) || n <= 0) return null;
        return String(n);
    }

    function toArgs(policy) {
        const p = normalize(policy);
        const args = [];

        COUNT_KEYS.forEach((c) => {
            const v = countArg(p[c.key]);
            if (v !== null) args.push(c.flag, v);
        });

        const within = parseDuration(p.within);
        if (within && within.totalHours > 0) args.push('--keep-within', String(p.within).trim());

        tagList(p.tags).forEach((t) => args.push('--keep-tag', t));

        return args.concat(GROUP_BY);
    }

    // Problems are HangarErrors so the UI renders them through one path. The
    // machine-readable discriminator lives in detail.code; the error *kind* stays
    // GENERIC because these are user input faults, not tool outcomes.
    function problem(code, message, detail) {
        return Errors.create(Errors.KIND.GENERIC, message, Object.assign({ code }, detail || {}));
    }

    function validate(policy) {
        if (!isPlainObject(policy)) {
            return [problem('not-object', 'Retention policy must be an object.', { value: policy })];
        }

        const parts = split(policy);
        const p = parts.norm;
        const problems = [];
        let keeps = 0;

        parts.unknown.forEach((k) => {
            problems.push(problem('unknown-key', 'Unknown retention setting "' + k + '".', { field: k }));
        });

        COUNT_KEYS.forEach((c) => {
            const v = p[c.key];
            if (v === undefined || v === null) return;
            if (typeof v !== 'number' || !Number.isInteger(v)) {
                problems.push(problem('not-integer',
                    'Retention "' + c.key + '" must be a whole number of snapshots.',
                    { field: c.key, value: v }));
                return;
            }
            if (v < 0) {
                problems.push(problem('negative',
                    'Retention "' + c.key + '" cannot be negative.',
                    { field: c.key, value: v }));
                return;
            }
            // A count past 2^53 is silently rounded by JSON and dropped by
            // toArgs. Accepting it here would clear the delete-everything guard
            // for a policy that in fact emits no keep flag at all.
            if (!Number.isSafeInteger(v)) {
                problems.push(problem('too-large',
                    'Retention "' + c.key + '" is larger than this field can hold.',
                    { field: c.key, value: v }));
                return;
            }
            if (v > 0) keeps += 1;
        });

        if (p.within !== undefined && p.within !== null && p.within !== '') {
            const d = parseDuration(p.within);
            if (!d) {
                problems.push(problem('bad-duration',
                    'Retention "within" must be a duration like 2y5m7d3h.',
                    { field: 'within', value: p.within }));
            } else if (d.totalHours > 0) {
                keeps += 1;
            }
        }

        if (badTags(p.tags)) {
            problems.push(problem('bad-tag',
                'Retention "tags" must be a tag name or a list of tag names.',
                { field: 'tags', value: p.tags }));
        } else if (tagList(p.tags).length > 0) {
            keeps += 1;
        }

        // The guard. Reached only when nothing above kept anything: `restic forget
        // --prune` with such a policy deletes every snapshot in the group.
        if (keeps === 0) {
            problems.push(problem('delete-everything',
                'This policy keeps nothing — every snapshot would be deleted.',
                { field: null }));
        }

        return problems;
    }

    function joinList(items) {
        if (items.length === 0) return '';
        if (items.length === 1) return items[0];
        return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
    }

    function plural(n, word) {
        return n + ' ' + word + (n === 1 ? '' : 's');
    }

    function durationText(text) {
        const d = parseDuration(text);
        // Never throw and never hide input: an unparsable duration is echoed back
        // verbatim so the user sees exactly what they typed.
        if (!d) return String(text);
        const bits = [];
        if (d.years) bits.push(plural(d.years, 'year'));
        if (d.months) bits.push(plural(d.months, 'month'));
        if (d.days) bits.push(plural(d.days, 'day'));
        if (d.hours) bits.push(plural(d.hours, 'hour'));
        return joinList(bits);
    }

    function describe(policy) {
        const p = normalize(policy);
        const phrases = [];
        const values = [];

        COUNT_KEYS.forEach((c) => {
            const v = countArg(p[c.key]);
            if (v === null) return;
            const n = Number(v);
            values.push(n);
            phrases.push(c.key === 'last'
                ? (n === 1 ? 'the most recent' : 'the ' + n + ' most recent')
                : n + ' ' + c.word);
        });

        const sentences = [];
        if (phrases.length) {
            // "1 daily snapshot" reads right only when it is the whole policy.
            const single = values.length === 1 && values[0] === 1;
            sentences.push('Keeps ' + joinList(phrases) + (single ? ' snapshot.' : ' snapshots.'));
        }

        if (p.within !== undefined && p.within !== null && p.within !== '') {
            const d = parseDuration(p.within);
            if (!d || d.totalHours > 0) {
                sentences.push((phrases.length ? 'Also keeps' : 'Keeps') +
                    ' everything from the last ' + durationText(p.within) + '.');
            }
        }

        const tags = tagList(p.tags);
        if (tags.length) {
            sentences.push('Snapshots tagged ' +
                joinList(tags.map((t) => '"' + t + '"')) + ' are always kept.');
        }

        if (!sentences.length) return 'Keeps nothing — every snapshot would be deleted.';
        return sentences.join(' ');
    }

    // Upper bound, not a prediction: restic's buckets overlap (one snapshot can
    // satisfy hourly, daily and weekly at once) and a bucket only fills if
    // snapshots exist in that period, so the real count is usually lower.
    function estimateCount(policy) {
        const p = normalize(policy);
        let n = 0;

        COUNT_KEYS.forEach((c) => {
            const v = countArg(p[c.key]);
            if (v !== null) n += Number(v);
        });

        const d = parseDuration(p.within);
        if (d && d.totalHours > 0) n += Math.ceil(d.totalHours / 24);   // ~one per day

        return n;   // tags contribute nothing knowable without reading the repo
    }

    const HangarRetention = {
        PRESETS, DEFAULT_PRESET, GROUP_BY, COUNT_KEYS,
        preset, normalize, parseDuration, toArgs, validate, describe, estimateCount
    };
    root.HangarRetention = HangarRetention;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarRetention;
})(typeof window !== 'undefined' ? window : globalThis);
