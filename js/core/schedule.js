// core/schedule.js — systemd unit generation and OnCalendar handling.
//
// The scheduler IS systemd: hangar runs no daemon and keeps no database, so the
// generated .service/.timer pair is the durable state. That makes these files
// load-bearing artefacts rather than convenience output — they are golden-file
// tested, and every renderer here is deterministic so drift fails the build.
'use strict';
(function (root) {
    // errors.js may be loaded either as a plain script (global already set) or by
    // node's require, in any order — resolve whichever is available.
    const Errors = root.HangarErrors ||
        (typeof require === 'function' ? require('./errors.js') : null);

    // secrets.js owns the credential naming. Deriving it here instead would let the
    // generated LoadCredential= name drift from what libexec/hangar-run looks up at
    // run time — which it did, silently: the unit published "repo-password" while the
    // helper searched for "hangar-repo-<id>" and fell back to reading /etc directly,
    // quietly defeating the point of LoadCredential=.
    const Secrets = root.HangarSecrets ||
        (typeof require === 'function' ? require('./secrets.js') : null);

    const UNIT_PREFIX = 'hangar-backup@';
    const HELPER = '/usr/libexec/hangar/hangar-run';
    const REPO_DIR = '/etc/hangar/repos';
    const CRED_PREFIX = Secrets ? Secrets.CRED_PREFIX : 'hangar-repo-';
    // Retained for callers that referenced it; now derived per repository.
    function passwordCredentialName(repoId) { return CRED_PREFIX + repoId; }

    const DEFAULT_RANDOMIZED_DELAY_SEC = 300;
    const DEFAULT_ACCURACY_SEC = '1min';
    const DEFAULT_TIMEOUT = 'infinity';

    // Identifiers are REJECTED, never escaped. systemd's escaping is lossy in
    // both directions ('a/b' and 'a-b' both escape to 'a-b'), so escaping would
    // let two distinct job ids collide on one unit name — and a collision here
    // means one job silently overwrites another job's timer.
    const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
    const ID_MAX = 64;

    // systemd credential ids become filenames under $CREDENTIALS_DIRECTORY, and
    // ':' is the LoadCredential= separator, so neither may appear.
    const CREDENTIAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

    // Built from escapes rather than literals so this source file stays plain
    // ASCII — a raw control byte sitting in a module is invisible in review.
    const CONTROL_RE = new RegExp('[\\u0000-\\u001f\\u007f]');
    const CONTROL_RE_G = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

    const CALENDAR_MAX = 255;

    // systemd's own shorthand set, mapped to the sentence the UI shows.
    // Anything outside it goes through the structural parser below.
    const SHORTHAND = {
        minutely: 'Every minute.',
        hourly: 'Every hour, on the hour.',
        daily: 'Every day at midnight.',
        weekly: 'Every Monday at midnight.',
        monthly: 'On the first day of every month, at midnight.',
        quarterly: 'On the first day of January, April, July and October, at midnight.',
        semiannually: 'On 1 January and 1 July, at midnight.',
        'semi-annually': 'On 1 January and 1 July, at midnight.',
        yearly: 'On 1 January every year, at midnight.',
        annually: 'On 1 January every year, at midnight.'
    };

    const WEEKDAYS = {
        mon: 'Monday', monday: 'Monday',
        tue: 'Tuesday', tues: 'Tuesday', tuesday: 'Tuesday',
        wed: 'Wednesday', weds: 'Wednesday', wednesday: 'Wednesday',
        thu: 'Thursday', thurs: 'Thursday', thursday: 'Thursday',
        fri: 'Friday', friday: 'Friday',
        sat: 'Saturday', saturday: 'Saturday',
        sun: 'Sunday', sunday: 'Sunday'
    };

    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];

    // Letters only, so this can never swallow a date ('*-*-*') or a time ('09:00').
    const WEEKDAY_TOKEN_RE = /^[A-Za-z]{3,9}(\.\.[A-Za-z]{3,9})?(,[A-Za-z]{3,9}(\.\.[A-Za-z]{3,9})?)*$/;
    const TIMEZONE_RE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;
    // Written as "(number unit)* number unit?" rather than the shorter
    // "(number unit?)+": the latter lets a run of digits be split at every
    // position, so a rejected value like 30 digits followed by junk backtracks
    // exponentially. This field is typed by a user into the UI thread, so that
    // is a freeze, not a slow validation. The accepted language is identical.
    const DURATION_RE = /^(?:[0-9]+(?:us|ms|sec|s|min|m|h|d|w))*[0-9]+(?:us|ms|sec|s|min|m|h|d|w)?$/;

    // Every problem is a typed HangarError carrying a stable `code`, so the UI
    // can key off the code and tests never assert on prose.
    function problem(code, message, extra) {
        const detail = { code };
        if (extra) Object.keys(extra).forEach((k) => { detail[k] = extra[k]; });
        return Errors.create(Errors.KIND.GENERIC, message, detail);
    }

    function fail(message, problems) {
        return Errors.create(Errors.KIND.GENERIC, message, problems);
    }

    // ---- identifiers -------------------------------------------------------

    function validateId(value, label) {
        if (typeof value !== 'string' || value === '')
            return [problem('id-required', label + ' is required')];
        const problems = [];
        if (value.length > ID_MAX)
            problems.push(problem('id-too-long', label + ' must be at most ' + ID_MAX + ' characters'));
        if (!ID_RE.test(value))
            problems.push(problem('id-charset', label + ' may only contain letters, digits, dot, dash and ' +
                'underscore, and must start with a letter or digit: "' + value + '"', { value }));
        return problems;
    }

    function unitName(jobId) {
        const problems = validateId(jobId, 'job id');
        if (problems.length) throw fail('invalid job id', problems);
        return UNIT_PREFIX + jobId;
    }

    function serviceUnit(jobId) { return unitName(jobId) + '.service'; }
    function timerUnit(jobId) { return unitName(jobId) + '.timer'; }

    // ---- calendar ----------------------------------------------------------

    // One numeric field of a date or time spec: '*', '5', '1..7', '0/15',
    // '1..7/2', or a comma-separated list of those.
    function validateField(spec, label, min, max, problems) {
        String(spec).split(',').forEach((part) => {
            if (part === '') {
                problems.push(problem('field-empty', label + ' has an empty list entry', { field: label }));
                return;
            }
            const slash = part.split('/');
            if (slash.length > 2) {
                problems.push(problem('field-step', label + ' has more than one repetition step: "' + part + '"',
                    { field: label, value: part }));
                return;
            }
            if (slash.length === 2 && (!/^[0-9]+$/.test(slash[1]) || Number(slash[1]) === 0)) {
                problems.push(problem('field-step', label + ' repetition step must be a positive integer: "' + part + '"',
                    { field: label, value: part }));
                return;
            }
            const base = slash[0];
            if (base === '*') return;
            const bounds = base.split('..');
            if (bounds.length > 2) {
                problems.push(problem('field-range', label + ' has a malformed range: "' + part + '"',
                    { field: label, value: part }));
                return;
            }
            const nums = [];
            for (let i = 0; i < bounds.length; i++) {
                if (!/^[0-9]+$/.test(bounds[i])) {
                    problems.push(problem('field-not-number', label + ' must be a number, "*" or a range: "' + part + '"',
                        { field: label, value: part }));
                    return;
                }
                const n = Number(bounds[i]);
                if (n < min || n > max) {
                    problems.push(problem('field-out-of-range',
                        label + ' must be between ' + min + ' and ' + max + ': "' + bounds[i] + '"',
                        { field: label, value: bounds[i] }));
                    return;
                }
                nums.push(n);
            }
            if (nums.length === 2 && nums[0] > nums[1])
                problems.push(problem('field-range-backwards', label + ' range runs backwards: "' + part + '"',
                    { field: label, value: part }));
        });
    }

    // Structural split only — systemd's parser is not reimplemented here.
    function splitCalendar(expr) {
        const tokens = String(expr).trim().split(/\s+/).filter((t) => t !== '');
        const out = { weekday: null, date: null, time: null, timezone: null, extra: [] };
        let i = 0;
        if (tokens[i] && WEEKDAY_TOKEN_RE.test(tokens[i])) { out.weekday = tokens[i]; i++; }
        if (tokens[i] && tokens[i].indexOf('-') >= 0 && tokens[i].indexOf(':') < 0) { out.date = tokens[i]; i++; }
        if (tokens[i] && tokens[i].indexOf(':') >= 0) { out.time = tokens[i]; i++; }
        // Only claim the timezone slot for something shaped like a timezone.
        // Otherwise a truncated time ('*-*-* 09') would be reported as a bad
        // timezone, which sends the user looking in the wrong place.
        if (tokens[i] && (tokens[i].indexOf('/') >= 0 || /^[A-Za-z]/.test(tokens[i]))) { out.timezone = tokens[i]; i++; }
        out.extra = tokens.slice(i);
        return out;
    }

    // Returns an array of typed problems; empty means acceptable. Deliberately
    // structural: it rejects obviously malformed input without pretending to be
    // systemd's calendar parser. Two genuinely valid systemd forms are knowingly
    // rejected because hangar's UI never emits them — the '~' last-day-of-month
    // form and fractional seconds.
    function validateCalendar(expr) {
        if (typeof expr !== 'string')
            return [problem('calendar-type', 'schedule must be a string')];
        if (expr.trim() === '')
            return [problem('calendar-empty', 'schedule must not be empty')];
        if (CONTROL_RE.test(expr))
            return [problem('calendar-control-chars', 'schedule must not contain control characters or line breaks')];
        if (expr.length > CALENDAR_MAX)
            return [problem('calendar-too-long', 'schedule must be at most ' + CALENDAR_MAX + ' characters')];

        const trimmed = expr.trim();
        if (Object.prototype.hasOwnProperty.call(SHORTHAND, trimmed.toLowerCase())) return [];

        const parts = splitCalendar(trimmed);
        if (!parts.weekday && !parts.date && !parts.time)
            return [problem('calendar-unrecognised', 'unrecognised schedule expression: "' + trimmed + '"',
                { value: trimmed })];

        const problems = [];
        if (parts.extra.length)
            problems.push(problem('calendar-trailing', 'unrecognised trailing component: "' + parts.extra.join(' ') + '"',
                { value: parts.extra.join(' ') }));

        if (parts.weekday) {
            parts.weekday.split(',').forEach((chunk) => {
                chunk.split('..').forEach((name) => {
                    if (!Object.prototype.hasOwnProperty.call(WEEKDAYS, name.toLowerCase()))
                        problems.push(problem('calendar-weekday', 'unknown weekday: "' + name + '"', { value: name }));
                });
            });
        }

        if (parts.date) {
            const f = parts.date.split('-');
            if (f.length === 3) {
                validateField(f[0], 'year', 1970, 2199, problems);
                validateField(f[1], 'month', 1, 12, problems);
                validateField(f[2], 'day', 1, 31, problems);
            } else if (f.length === 2) {
                validateField(f[0], 'month', 1, 12, problems);
                validateField(f[1], 'day', 1, 31, problems);
            } else {
                problems.push(problem('calendar-date-shape',
                    'date must be year-month-day or month-day: "' + parts.date + '"', { value: parts.date }));
            }
        }

        if (parts.time) {
            const f = parts.time.split(':');
            if (f.length === 2 || f.length === 3) {
                validateField(f[0], 'hour', 0, 23, problems);
                validateField(f[1], 'minute', 0, 59, problems);
                // 60 is legal: systemd allows a leap second.
                if (f.length === 3) validateField(f[2], 'second', 0, 60, problems);
            } else {
                problems.push(problem('calendar-time-shape',
                    'time must be HH:MM or HH:MM:SS: "' + parts.time + '"', { value: parts.time }));
            }
        }

        if (parts.timezone && !TIMEZONE_RE.test(parts.timezone))
            problems.push(problem('calendar-timezone', 'unrecognised timezone: "' + parts.timezone + '"',
                { value: parts.timezone }));

        return problems;
    }

    // ---- human description -------------------------------------------------

    function pad2(n) { return String(n).length < 2 ? '0' + String(n) : String(n); }

    function joinList(items) {
        if (items.length <= 1) return items[0] || '';
        return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
    }

    function describeWeekday(spec) {
        return joinList(spec.split(',').map((chunk) => {
            const ends = chunk.split('..').map((n) => WEEKDAYS[n.toLowerCase()]);
            return ends.length === 2 ? ends[0] + ' to ' + ends[1] : ends[0];
        }));
    }

    function describeDate(date) {
        const f = date.split('-');
        const day = f[f.length - 1];
        const month = f.length === 3 ? f[1] : f[0];
        const year = f.length === 3 ? f[0] : '*';
        if (year === '*' && month === '*' && day === '*') return 'every day';
        if (year === '*' && month === '*' && /^[0-9]{1,2}$/.test(day))
            return 'on day ' + Number(day) + ' of every month';
        if (year === '*' && /^[0-9]{1,2}$/.test(month) && /^[0-9]{1,2}$/.test(day))
            return 'on ' + Number(day) + ' ' + MONTHS[Number(month) - 1] + ' every year';
        return 'on ' + date;
    }

    function describeTime(time) {
        // systemd defaults an omitted time to 00:00:00, so say so rather than
        // leaving the user to guess when "Mon..Fri" actually fires.
        if (!time) return 'at midnight';
        const f = time.split(':');
        const h = f[0], m = f[1], s = f.length === 3 ? f[2] : '00';
        const mStep = /^(?:\*|[0-9]+)\/([0-9]+)$/.exec(m);
        const hStep = /^(?:\*|[0-9]+)\/([0-9]+)$/.exec(h);
        if (h === '*' && mStep) return 'every ' + Number(mStep[1]) + ' minutes';
        if (hStep && /^[0-9]+$/.test(m)) return 'every ' + Number(hStep[1]) + ' hours';
        if (h === '*' && m === '*') return 'every minute';
        if (h === '*' && /^[0-9]+$/.test(m)) return 'at ' + Number(m) + ' minutes past every hour';
        if (/^[0-9]+$/.test(h) && /^[0-9]+$/.test(m)) {
            let out = 'at ' + pad2(Number(h)) + ':' + pad2(Number(m));
            if (/^[0-9]+$/.test(s) && Number(s) !== 0) out += ':' + pad2(Number(s));
            return out;
        }
        return 'at ' + time;
    }

    function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

    function describeSchedule(expr) {
        if (Array.isArray(expr)) return expr.map(describeSchedule).join(' ');
        if (validateCalendar(expr).length) return 'Not a valid schedule.';

        const trimmed = expr.trim();
        const shorthand = SHORTHAND[trimmed.toLowerCase()];
        if (shorthand) return shorthand;

        const parts = splitCalendar(trimmed);
        const day = parts.weekday
            ? describeWeekday(parts.weekday)
            : (parts.date ? describeDate(parts.date) : 'every day');
        const time = describeTime(parts.time);
        // "every 15 minutes" needs a comma to read as a clause; "at 09:00" does not.
        const glue = time.indexOf('every') === 0 ? ', ' : ' ';
        return capitalize(day) + glue + time + (parts.timezone ? ' (' + parts.timezone + ')' : '') + '.';
    }

    // ---- job shape ---------------------------------------------------------

    function repoOf(job) {
        const r = job && job.repo;
        if (typeof r === 'string') return { id: r, credentials: {} };
        if (r && typeof r === 'object' && !Array.isArray(r)) {
            const c = (r.credentials && typeof r.credentials === 'object' && !Array.isArray(r.credentials))
                ? r.credentials : {};
            return { id: r.id, credentials: c };
        }
        return null;
    }

    // A bare string is accepted as shorthand for { calendar: <string> } because
    // that is what most jobs actually are.
    function scheduleOf(job) {
        const s = job && job.schedule;
        if (typeof s === 'string') return { calendar: s };
        if (s && typeof s === 'object' && !Array.isArray(s)) return s;
        return {};
    }

    function calendarsOf(job) {
        const c = scheduleOf(job).calendar;
        if (typeof c === 'string') return [c];
        if (Array.isArray(c)) return c;
        return [];
    }

    function keyPath(repoId) { return REPO_DIR + '/' + repoId + '.key'; }

    function validateRepo(repo) {
        if (!repo) return [problem('repo-required', 'repository is required')];
        const problems = validateId(repo.id, 'repository id');
        const creds = repo.credentials || {};
        Object.keys(creds).sort().forEach((id) => {
            const path = creds[id];
            if (id.length > ID_MAX || !CREDENTIAL_ID_RE.test(id))
                problems.push(problem('credential-id', 'invalid credential id: "' + id + '"', { value: id }));
            if (typeof path !== 'string' || path.charAt(0) !== '/')
                problems.push(problem('credential-path', 'credential "' + id + '" needs an absolute path', { value: id }));
            else if (CONTROL_RE.test(path) || path.indexOf(':') >= 0)
                problems.push(problem('credential-path',
                    'credential "' + id + '" path contains a character systemd cannot express: "' + path + '"',
                    { value: id }));
        });
        return problems;
    }

    // Password first, then extras in sorted order — determinism here is exactly
    // what lets the generated .service file be golden-tested.
    function credentialLines(repo) {
        const norm = repoOf({ repo });
        const problems = validateRepo(norm);
        if (problems.length) throw fail('invalid repository', problems);
        const lines = ['LoadCredential=' + passwordCredentialName(norm.id) + ':' + keyPath(norm.id)];
        Object.keys(norm.credentials).sort().forEach((id) => {
            lines.push('LoadCredential=' + id + ':' + norm.credentials[id]);
        });
        return lines;
    }

    function validateTimeout(value, problems) {
        if (value === undefined || value === null) return DEFAULT_TIMEOUT;
        if (value === 'infinity') return 'infinity';
        // isSafeInteger, not isInteger: String(1e21) is "1e+21", and a validator
        // that accepts a value it cannot render is worse than one that rejects it.
        if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
        problems.push(problem('timeout', 'timeoutSec must be a positive integer or "infinity"'));
        return DEFAULT_TIMEOUT;
    }

    function validateDelay(value, problems) {
        if (value === undefined || value === null) return DEFAULT_RANDOMIZED_DELAY_SEC;
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
        problems.push(problem('randomized-delay', 'randomizedDelaySec must be a non-negative integer'));
        return DEFAULT_RANDOMIZED_DELAY_SEC;
    }

    function validateAccuracy(value, problems) {
        if (value === undefined || value === null) return DEFAULT_ACCURACY_SEC;
        if (typeof value === 'string' && DURATION_RE.test(value)) return value;
        problems.push(problem('accuracy', 'accuracySec must be a systemd duration such as "1min"'));
        return DEFAULT_ACCURACY_SEC;
    }

    function validateJob(job) {
        if (!job || typeof job !== 'object' || Array.isArray(job))
            return [problem('job-shape', 'job must be an object')];
        const problems = validateId(job.id, 'job id').concat(validateRepo(repoOf(job)));
        if (job.name !== undefined && typeof job.name !== 'string')
            problems.push(problem('name-type', 'job name must be a string'));
        validateTimeout(job.timeoutSec, problems);
        const sched = scheduleOf(job);
        validateDelay(sched.randomizedDelaySec, problems);
        validateAccuracy(sched.accuracySec, problems);
        calendarsOf(job).forEach((c) => { validateCalendar(c).forEach((p) => problems.push(p)); });
        return problems;
    }

    // A job name reaches a unit file, where an embedded newline would start a
    // new directive. Flattening to one line is the entire point of this.
    function sanitizeText(value, fallback) {
        const raw = typeof value === 'string' ? value : '';
        const clean = raw.replace(CONTROL_RE_G, ' ').replace(/\s+/g, ' ').trim();
        // The cap counts UTF-16 units, so it can land between the halves of an
        // astral character. A trailing lone surrogate is not expressible in
        // UTF-8, so drop it rather than write a broken byte into the unit file.
        return (clean === '' ? String(fallback) : clean).slice(0, 160).replace(/[\uD800-\uDBFF]$/, '');
    }

    // ---- renderers ---------------------------------------------------------

    // ExecStart passes %i rather than the literal id even though this file is
    // written under the instance name, so this per-job copy and the shipped
    // hangar-backup@.service template differ only in their credential lines.
    function renderService(job) {
        const problems = validateJob(job);
        if (problems.length) throw fail('invalid job', problems);

        const timeout = validateTimeout(job.timeoutSec, []);
        const lines = [
            '# Generated by hangar. Do not edit - this file is rewritten whenever the job',
            '# is saved from the Cockpit UI. Job id: ' + job.id,
            '[Unit]',
            'Description=hangar backup: ' + sanitizeText(job.name, job.id),
            'Documentation=man:restic(1)',
            'Wants=network-online.target',
            'After=network-online.target',
            '',
            '[Service]',
            'Type=oneshot',
            'ExecStart=' + HELPER + ' %i'
        ];
        credentialLines(job.repo).forEach((l) => lines.push(l));
        lines.push(
            '# restic exit 3 means the snapshot was written but some files were unreadable.',
            '# That is a partial success and must not mark the unit failed.',
            'SuccessExitStatus=3',
            '# Type=oneshot otherwise inherits DefaultTimeoutStartSec, which would kill a',
            '# backup that legitimately runs for hours.',
            'TimeoutStartSec=' + timeout,
            'Nice=10',
            'IOSchedulingClass=idle',
            '',
            '# Hardening, deliberately incomplete: this unit has to read the whole',
            '# filesystem, so ProtectSystem=strict, ProtectHome and PrivateTmp are all',
            '# unusable here - they would make the backup capture the wrong content',
            '# instead of failing loudly.',
            '#',
            '# ProtectKernelModules is missing for the same reason, and it was here',
            '# once. It makes /usr/lib/modules INACCESSIBLE to the service, so restic',
            '# recorded that directory as empty, mode 0000, in every snapshot - and a',
            '# system restored from one has no kernel modules, cannot build an initrd,',
            '# and may not boot. Found by a recovery drill: dracut failed in 190ms and',
            '# the backups had looked perfect for weeks.',
            'NoNewPrivileges=yes',
            'ProtectClock=yes',
            'ProtectControlGroups=yes',
            'ProtectHostname=yes',
            'ProtectKernelLogs=yes',
            'ProtectKernelTunables=yes',
            'RestrictNamespaces=yes',
            'RestrictRealtime=yes',
            'RestrictSUIDSGID=yes',
            'LockPersonality=yes',
            'SystemCallArchitectures=native',
            'SystemCallFilter=@system-service'
        );
        return lines.join('\n') + '\n';
    }

    function renderTimer(job) {
        const problems = validateJob(job);
        if (problems.length) throw fail('invalid job', problems);
        const calendars = calendarsOf(job);
        if (!calendars.length)
            throw fail('invalid job', [problem('calendar-required', 'at least one OnCalendar expression is required')]);

        const sched = scheduleOf(job);
        const delay = validateDelay(sched.randomizedDelaySec, []);
        const accuracy = validateAccuracy(sched.accuracySec, []);
        const persistent = sched.persistent === false ? 'false' : 'true';

        const lines = [
            '# Generated by hangar. Do not edit - this file is rewritten whenever the job',
            '# is saved from the Cockpit UI. Job id: ' + job.id,
            '[Unit]',
            'Description=hangar backup timer: ' + sanitizeText(job.name, job.id),
            '',
            '[Timer]',
            'Unit=' + serviceUnit(job.id)
        ];
        calendars.forEach((c) => lines.push('OnCalendar=' + c.trim()));
        lines.push(
            '# Persistent=true is what gives the Logbook its time-machine feel: a host',
            '# that was asleep at the scheduled moment catches up as soon as it wakes,',
            '# instead of silently skipping the window.',
            'Persistent=' + persistent,
            'RandomizedDelaySec=' + delay,
            'AccuracySec=' + accuracy,
            '',
            '[Install]',
            'WantedBy=timers.target'
        );
        return lines.join('\n') + '\n';
    }

    // ---- pure helpers for the D-Bus layer ----------------------------------

    // cockpit returns GetAll() as { name: { t: signature, v: value } }.
    function unwrapProps(raw) {
        const out = {};
        if (!raw || typeof raw !== 'object') return out;
        Object.keys(raw).forEach((k) => {
            const v = raw[k];
            out[k] = (v && typeof v === 'object' && !Array.isArray(v) && 'v' in v) ? v.v : v;
        });
        return out;
    }

    // systemd spells "never" as 0 for LastTriggerUSec but as UINT64_MAX for
    // NextElapseUSecRealtime, so both have to collapse to null.
    function usecToMillis(value) {
        if (value === undefined || value === null || value === '') return null;
        const n = Number(value);
        if (!isFinite(n) || n <= 0 || n >= 1e18) return null;
        return Math.floor(n / 1000);
    }

    function normalizeUnitState(unitProps, timerProps) {
        const u = unwrapProps(unitProps);
        const t = unwrapProps(timerProps);
        const fileState = u.UnitFileState || 'unknown';
        return {
            loadState: u.LoadState || 'not-found',
            activeState: u.ActiveState || 'inactive',
            subState: u.SubState || 'dead',
            unitFileState: fileState,
            enabled: fileState === 'enabled' || fileState === 'enabled-runtime' || fileState === 'static',
            active: u.ActiveState === 'active' || u.ActiveState === 'activating',
            failed: u.ActiveState === 'failed' || (u.Result !== undefined && u.Result !== 'success'),
            result: u.Result === undefined ? null : u.Result,
            nextElapseMs: usecToMillis(t.NextElapseUSecRealtime),
            lastTriggerMs: usecToMillis(t.LastTriggerUSec)
        };
    }

    // ---- thin I/O layer ----------------------------------------------------

    const SYSTEMD = 'org.freedesktop.systemd1';
    const MANAGER_PATH = '/org/freedesktop/systemd1';
    const MANAGER_IFACE = 'org.freedesktop.systemd1.Manager';
    const PROPS_IFACE = 'org.freedesktop.DBus.Properties';

    function available() {
        return typeof cockpit !== 'undefined' && !!cockpit && typeof cockpit.dbus === 'function';
    }

    function bus() {
        return available() ? cockpit.dbus(SYSTEMD, { superuser: 'require' }) : null;
    }

    function noBus() {
        return Promise.reject(Errors.create(Errors.KIND.GENERIC, 'systemd D-Bus is not available',
            { code: 'no-dbus' }));
    }

    function callManager(method, args) {
        const d = bus();
        if (!d) return noBus();
        return d.call(MANAGER_PATH, MANAGER_IFACE, method, args).then((reply) => reply && reply[0]);
    }

    // Is ANY backup running right now?
    //
    // Asked before this plugin reads a repository, because reading takes a
    // restic lock and `prune` needs the repository to itself. hangar's own
    // screens poll sizes and diffs every few seconds, so an open tab could hold
    // a lock more or less continuously and retention would never reclaim
    // anything — measured: prune blocked by a different PID on every attempt,
    // all of them this plugin's own polling.
    //
    // ListUnitsByPatterns rather than a name: any job may be running, and the
    // caller does not know which. Unreachable systemd answers "no", because
    // refusing to show a repository size on a hunch is worse than a lock.
    function anyBackupRunning() {
        const d = bus();
        if (!d) return Promise.resolve(false);
        return d.call(MANAGER_PATH, MANAGER_IFACE, 'ListUnitsByPatterns',
            [['activating', 'active', 'reloading'], ['hangar-backup@*.service']])
            .then((reply) => {
                const units = (reply && reply[0]) || [];
                return Array.isArray(units) && units.length > 0;
            })
            .catch(() => false);
    }

    // Live state for a job's timer and its service. Everything reads through
    // here so no caller is ever tempted to scrape `systemctl` text.
    function unitState(jobId) {
        let timer, service;
        try { timer = timerUnit(jobId); service = serviceUnit(jobId); } catch (e) { return Promise.reject(e); }
        const d = bus();
        if (!d) return noBus();

        function propsFor(name) {
            // LoadUnit, not GetUnit: a unit that exists on disk but has never been
            // started has no loaded object yet, and GetUnit would fail on it.
            return d.call(MANAGER_PATH, MANAGER_IFACE, 'LoadUnit', [name])
                .then((reply) => Promise.all([
                    d.call(reply[0], PROPS_IFACE, 'GetAll', ['org.freedesktop.systemd1.Unit']),
                    d.call(reply[0], PROPS_IFACE, 'GetAll', ['org.freedesktop.systemd1.Timer']).catch(() => [{}])
                ]))
                .then((r) => normalizeUnitState(r[0] && r[0][0], r[1] && r[1][0]));
        }

        return Promise.all([propsFor(timer), propsFor(service)]).then((r) => ({ timer: r[0], service: r[1] }));
    }

    function enable(jobId) {
        let name;
        try { name = timerUnit(jobId); } catch (e) { return Promise.reject(e); }
        return callManager('EnableUnitFiles', [[name], false, true]).then(() => daemonReload());
    }

    function disable(jobId) {
        let name;
        try { name = timerUnit(jobId); } catch (e) { return Promise.reject(e); }
        return callManager('DisableUnitFiles', [[name], false]).then(() => daemonReload());
    }

    function start(jobId) {
        let name;
        try { name = timerUnit(jobId); } catch (e) { return Promise.reject(e); }
        return callManager('StartUnit', [name, 'replace']);
    }

    function stop(jobId) {
        let name;
        try { name = timerUnit(jobId); } catch (e) { return Promise.reject(e); }
        return callManager('StopUnit', [name, 'replace']);
    }

    // "Back up now" — starts the service directly, bypassing the timer.
    function runNow(jobId) {
        let name;
        try { name = serviceUnit(jobId); } catch (e) { return Promise.reject(e); }
        return callManager('StartUnit', [name, 'replace']);
    }

    function daemonReload() {
        return callManager('Reload', []);
    }

    const HangarSchedule = {
        UNIT_PREFIX, HELPER, REPO_DIR, CRED_PREFIX, passwordCredentialName,
        DEFAULT_RANDOMIZED_DELAY_SEC, DEFAULT_ACCURACY_SEC, DEFAULT_TIMEOUT,
        SHORTHAND,
        // pure
        validateId, unitName, serviceUnit, timerUnit,
        keyPath, credentialLines, calendarsOf, sanitizeText,
        validateCalendar, describeSchedule, validateJob,
        renderService, renderTimer,
        unwrapProps, usecToMillis, normalizeUnitState,
        // impure
        available, unitState, anyBackupRunning, enable, disable, start, stop, runNow, daemonReload
    };
    root.HangarSchedule = HangarSchedule;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarSchedule;
})(typeof window !== 'undefined' ? window : globalThis);
