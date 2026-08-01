// features/overview.js — the landing screen: "are my backups OK?" in one glance.
//
// Everything that decides what the user is told is a pure function at the top of
// this file. The Alpine component underneath is a thin shell that fetches state and
// hands it to those functions, which is what keeps the interesting logic testable
// under `node --test` with no DOM and no cockpit.
'use strict';
(function (root) {

    // index.html loads core/* before features/*; under node we require directly so
    // the pure functions below stand alone in unit tests.
    function need(name, path) {
        if (root[name]) return root[name];
        if (typeof require === 'function') {
            try { return require(path); } catch (e) { return null; }
        }
        return null;
    }

    const Errors = need('HangarErrors', '../core/errors.js');
    const Config = need('HangarConfig', '../core/config.js');
    const Schedule = need('HangarSchedule', '../core/schedule.js');
    const Repos = need('HangarRepos', '../core/repos.js');
    const Secrets = need('HangarSecrets', '../core/secrets.js');
    const Logbook = need('HangarLogbook', '../core/logbook.js');
    const Restic = need('HangarRestic', '../engine/restic.js');
    // Only for what a cloud destination IS: which remote a repository writes
    // through, which provider that remote is, and whether that provider declares
    // an expiry rule of its own. No provider fact is restated in this file.
    const Rclone = need('HangarRclone', '../core/rclone.js');

    // ------------------------------------------------------------------ status

    // 'never' and 'cancelled' are deliberately neutral: a job that has not run yet,
    // or a run the user stopped, is not a failure, and colouring them red is how a
    // dashboard teaches people to ignore red.
    const STATUS = {
        OK: 'ok',
        RUNNING: 'running',
        CANCELLED: 'cancelled',
        NEVER: 'never',
        PARTIAL: 'partial',
        FAILED: 'failed'
    };

    // Worst wins. Order matters more than the numbers: it is the only thing that
    // decides what the header badge says when jobs disagree.
    const RANK = {
        ok: 0,
        running: 1,
        cancelled: 2,
        never: 3,
        partial: 4,
        failed: 5
    };

    const LABEL = {
        ok: 'All backups OK',
        running: 'Backup running',
        cancelled: 'Last run cancelled',
        never: 'Not run yet',
        partial: 'Completed with warnings',
        failed: 'Backup failed'
    };

    // Only the classes that css/hangar.css actually defines. 'never' and 'cancelled'
    // fall through to the bare .hangar-dot, which is grey.
    const DOT_CLASS = { ok: 'ok', partial: 'partial', failed: 'failed', running: 'running' };

    const BADGE_CLASS = {
        ok: 'text-bg-success',
        running: 'text-bg-success',
        cancelled: 'text-bg-secondary',
        never: 'text-bg-secondary',
        partial: 'text-bg-warning',
        failed: 'text-bg-danger'
    };

    // UI copy for a typed error kind. Deliberately here rather than in core: these
    // are sentences shown to a person, not error semantics.
    const KIND_DETAIL = {
        GENERIC: 'restic reported an error.',
        GO_RUNTIME: 'restic crashed.',
        REPO_MISSING: 'The repository does not exist yet.',
        REPO_LOCKED: 'Another operation has the repository locked.',
        WRONG_PASSWORD: 'The stored repository password was rejected.',
        NO_SPACE: 'The backup destination is out of space.',
        NETWORK: 'The repository could not be reached.',
        AUTH_EXPIRED: 'The cloud destination\'s sign-in has expired.',
        CANCELLED: 'The last run was cancelled.',
        UNKNOWN: 'The backup did not complete.'
    };

    const REMEDIATION_LABEL = {
        unlock: 'Unlock repository',
        reprompt: 'Enter password',
        init: 'Initialise repository',
        'list-unreadable': 'Show unreadable files',
        'free-space': 'Show space used',
        // Not 'Try again'. The next run fails identically until someone signs
        // in again, and offering a retry is what lets that repeat unnoticed.
        reauthorize: 'Sign in again',
        retry: 'Try again'
    };

    // Every table lookup on this screen is keyed by a string that came out of a JSON
    // file on disk — a status, an error kind. `TABLE[key]` walks the prototype, so a
    // state file saying "kind": "toString" hands the template a function to render
    // and "__proto__" hands it Object.prototype. Own properties only, always.
    function has(table, key) {
        return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);
    }

    function lookup(table, key, fallback) {
        return has(table, key) ? table[key] : fallback;
    }

    // The closed set of remediations errors.js can emit. Anything else is not a
    // button this screen has, and must not become one by accident.
    function normRemediation(r) { return has(REMEDIATION_LABEL, r) ? r : null; }

    // The remediations whose button opens the panel under the row instead of
    // running something.
    //
    // 'reauthorize' used to be one of them, back when this screen could only
    // describe the fix. It is not any more: the button opens the same wizard the
    // destination was created in, aimed at the remote that expired. Telling
    // someone where to go to fix a thing, on a screen that could take them
    // there, is how a failure survives another night.
    function expands(r) {
        return r === 'list-unreadable' || r === 'free-space';
    }

    function statusClass(status) { return lookup(DOT_CLASS, status, ''); }
    function statusBadgeClass(status) { return lookup(BADGE_CLASS, status, 'text-bg-secondary'); }
    function statusLabel(status) { return lookup(LABEL, status, LABEL.never); }
    function remediationLabel(r) { return lookup(REMEDIATION_LABEL, r, 'Fix'); }

    // ------------------------------------------------------------ error text

    // restic's stderr is echoed verbatim into error messages, and it echoes the
    // repository URL with it — a rest:// or sftp: URL can carry userinfo. secrets.js
    // owns the masking rules; this is the one place the UI has to remember them.
    function redactText(v, deps) {
        const S = (deps && deps.secrets) || Secrets;
        const raw = v === null || v === undefined ? '' : text(v);
        if (!S || typeof S.redact !== 'function') return raw;
        // The redactor runs on the failure path; a failure inside it must not
        // replace the message with nothing.
        try { return S.redact(raw); } catch (e) { return raw; }
    }

    // Last resort wording. An error alert that renders as an empty box with only a
    // button is worse than a vague sentence: the user cannot tell what failed, and
    // cannot tell whether the blank space is a bug or the message.
    const UNDESCRIBED = 'The reason was not reported.';

    function errorMessage(e, deps) {
        if (!e) return '';
        let raw = '';
        // A getter that throws is a real shape: cockpit channel errors are plain
        // objects, and so is whatever a third-party promise rejected with.
        try { raw = (typeof e.message === 'string' && e.message) ? e.message : text(e); }
        catch (x) { raw = ''; }
        const out = redactText(raw, deps);
        // Redaction can also empty a message that was entirely a secret.
        return (typeof out === 'string' && out.trim() !== '') ? out : UNDESCRIBED;
    }

    // A typed error even when errors.js never loaded: an untyped TypeError escaping
    // to the screen is precisely the failure this module exists to prevent.
    function failure(deps, message, detail) {
        const E = (deps && deps.errors) || Errors;
        if (E && typeof E.create === 'function') return E.create('GENERIC', message, detail || null);
        const e = new Error(message);
        e.name = 'HangarError';
        e.kind = 'GENERIC';
        e.detail = detail || null;
        e.fatal = true;
        e.remediation = null;
        return e;
    }

    // ------------------------------------------------------------- formatting

    const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];

    function isNum(v) { return typeof v === 'number' && isFinite(v); }

    // An em dash, not '0': "we do not know" and "nothing" are different answers and
    // conflating them on a backup dashboard is a lie.
    const UNKNOWN = '\u2014';

    function formatBytes(n) {
        if (!isNum(n) || n < 0) return UNKNOWN;
        let v = n;
        let i = 0;
        while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
        if (i === 0) return Math.round(v) + ' B';
        // 1048575 divides to 1023.999… KiB, which would print as "1024.0 KiB".
        if (Number(v.toFixed(1)) >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
        return v.toFixed(1) + ' ' + UNITS[i];
    }

    // Two units at most: "1d 4h" is legible, "1d 4h 3m 12s" is a stopwatch reading.
    function formatDuration(sec) {
        if (!isNum(sec) || sec < 0) return UNKNOWN;
        const total = Math.floor(sec);
        const d = Math.floor(total / 86400);
        const h = Math.floor((total % 86400) / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        if (d) return h ? d + 'd ' + h + 'h' : d + 'd';
        if (h) return m ? h + 'h ' + m + 'm' : h + 'h';
        if (m) return s ? m + 'm ' + s + 's' : m + 'm';
        return s + 's';
    }

    function relative(ms, now) {
        if (!isNum(ms)) return null;
        if (!Logbook || typeof Logbook.formatRelative !== 'function') return null;
        return Logbook.formatRelative(ms, now === undefined ? undefined : now);
    }

    function lastRunText(ms, now) {
        const rel = relative(ms, now);
        return rel === null ? 'never' : rel;
    }

    function nextRunText(ms, now) {
        const rel = relative(ms, now);
        return rel === null ? 'not scheduled' : rel;
    }

    // ------------------------------------------------------- state inspection

    function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }

    // String() throws on a null-prototype object and on a Symbol, and both can reach
    // this screen from a state file parsed by JSON.parse with a "__proto__" key. A
    // TypeError escaping a status renderer would blank the whole dashboard.
    function text(v) {
        try { return String(v); } catch (e) { return Object.prototype.toString.call(v); }
    }

    // The helper writes epoch seconds (python time.time()); systemd hands us
    // milliseconds. Both arrive here, so normalise on the only thing that tells
    // them apart — magnitude.
    function toMillis(v) {
        if (!isNum(v) || v <= 0) return null;
        return v > 1e12 ? Math.floor(v) : Math.floor(v * 1000);
    }

    function lastRunMs(state, unit) {
        const s = obj(state);
        const fromState = s ? toMillis(s.finished) : null;
        if (fromState !== null) return fromState;
        const timer = obj(obj(unit) && unit.timer);
        return timer && isNum(timer.lastTriggerMs) ? timer.lastTriggerMs : null;
    }

    function durationSec(state) {
        const s = obj(state);
        if (!s || !isNum(s.started) || !isNum(s.finished)) return null;
        const d = s.finished - s.started;
        return d >= 0 ? d : null;
    }

    // The state record only carries a count; the paths live in the journal. If a
    // future helper does record them, surface them rather than the count.
    //
    // Deduplicated because restic reports one error per failed operation, so the
    // same path arrives twice when both its stat and its read failed — and the
    // template keys its x-for on the path, where a repeat is a broken list.
    function unreadableList(state) {
        const s = obj(state);
        if (!s) return [];
        const raw = s.unreadable_files || s.unreadableFiles;
        if (!Array.isArray(raw)) return [];
        const seen = Object.create(null);
        const out = [];
        raw.forEach(function (e) {
            let p = '';
            if (typeof e === 'string') p = e;
            else {
                const o = obj(e);
                if (o) p = text(o.item || o.path || o.message || '');
            }
            p = p.trim();
            if (p === '' || seen[p]) return;
            seen[p] = true;
            out.push(p);
        });
        return out;
    }

    // Remediation comes from errors.js, never from a string invented here — and is
    // re-checked against the closed set, because errors.js keys its own table by an
    // unvalidated kind and would happily return Object.prototype.toString for
    // `kind: "toString"`.
    function remediationForKind(kind) {
        if (!Errors) return null;
        try { return normRemediation(Errors.remediationFor(Errors.create(kind, ''))); }
        catch (e) { return null; }
    }

    // ---------------------------------------------------------- summarizeJob

    function neverDetail(timer, nextRun) {
        if (nextRun !== null || (timer && timer.enabled))
            return 'Scheduled, but it has not run yet.';
        return 'This job has never run and is not scheduled.';
    }

    function okDetail(state) {
        const d = durationSec(state);
        const added = obj(state) && isNum(state.data_added) ? formatBytes(state.data_added) : null;
        const head = d === null ? 'Completed successfully' : 'Completed in ' + formatDuration(d);
        return added ? head + '; ' + added + ' added.' : head + '.';
    }

    function partialDetail(state) {
        const s = obj(state);
        // The count is authoritative when the helper recorded one; otherwise the
        // paths it did record are a better answer than "some".
        const listed = unreadableList(s).length;
        const n = s && isNum(s.unreadable) ? s.unreadable : (listed || null);
        if (n === null) return 'Some files could not be read. Everything else was backed up.';
        return n + ' file' + (n === 1 ? '' : 's') + ' could not be read. Everything else was backed up.';
    }

    /**
     * The one function that decides what a job's row says.
     *
     * @param job   the job definition (only used for its identity/name)
     * @param state the parsed /var/lib/hangar/state/<id>.json record, or null
     * @param unit  { timer, service } from HangarSchedule.unitState, or null
     * @returns { status, label, detail, remediation, nextRun }
     */
    function summarizeJob(job, state, unit) {
        const u = obj(unit) || {};
        const timer = obj(u.timer) || {};
        const service = obj(u.service) || {};
        const nextRun = isNum(timer.nextElapseMs) ? timer.nextElapseMs : null;
        const s = obj(state);

        function out(status, label, detail, remediation) {
            return {
                status: status,
                label: label,
                detail: detail,
                remediation: remediation || null,
                nextRun: nextRun
            };
        }

        // A running unit outranks whatever the last completed run recorded — the
        // state file on disk is by definition stale while the backup is in flight.
        if (service.active)
            return out(STATUS.RUNNING, 'Running now', 'A backup is running.', null);

        if (!s || !s.status) {
            // systemd can know a run failed when the helper died before it could
            // write a state file. Reporting "never run" there would hide a failure.
            if (service.failed)
                return out(STATUS.FAILED, 'Failed',
                    'The backup unit failed before it recorded a result.', 'retry');
            return out(STATUS.NEVER, 'Never run', neverDetail(timer, nextRun), null);
        }

        switch (s.status) {
        case 'ok':
            return out(STATUS.OK, 'Succeeded', okDetail(s), null);

        case 'partial':
            // restic exit 3: the snapshot WAS written. Amber, never red.
            return out(STATUS.PARTIAL, 'Completed with unreadable files',
                partialDetail(s), remediationForKind(s.kind) || 'list-unreadable');

        case 'prune-failed':
            // The snapshot exists; only the retention pass failed. That is a
            // warning about old snapshots piling up, not a lost backup.
            return out(STATUS.PARTIAL, 'Backed up, retention failed',
                'The snapshot was written, but removing old snapshots failed.', 'retry');

        case 'failed':
            if (s.kind === 'CANCELLED')
                return out(STATUS.CANCELLED, 'Cancelled', KIND_DETAIL.CANCELLED, null);
            return out(STATUS.FAILED, 'Failed',
                lookup(KIND_DETAIL, s.kind, KIND_DETAIL.UNKNOWN),
                remediationForKind(s.kind) || 'retry');

        default:
            // An unrecognised status is not evidence of success.
            return out(STATUS.FAILED, 'Failed',
                'Unrecognised result "' + text(s.status) + '".', 'retry');
        }
    }

    // The single worst status across every job, for the header badge. An empty or
    // malformed list is 'never' — nothing is known to be healthy.
    function overallStatus(summaries) {
        if (!Array.isArray(summaries) || summaries.length === 0) return STATUS.NEVER;
        let worst = STATUS.OK;
        for (let i = 0; i < summaries.length; i++) {
            const entry = summaries[i];
            const raw = typeof entry === 'string' ? entry : (obj(entry) ? entry.status : null);
            // Same reasoning as summarizeJob's default branch: unknown is not OK.
            const status = Object.prototype.hasOwnProperty.call(RANK, raw) ? raw : STATUS.FAILED;
            if (RANK[status] > RANK[worst]) worst = status;
        }
        return worst;
    }

    // ------------------------------------------------------------------ rows

    // A backup that walked a dead NFS mount can report tens of thousands of
    // unreadable paths. Rendering all of them is a frozen tab, which is a worse
    // failure than the one being reported.
    const MAX_LISTED = 200;

    // Pure: job + state + unit -> everything the template renders for one row.
    function jobRow(job, state, unit, now) {
        const j = obj(job) || {};
        const id = typeof j.id === 'string' ? j.id : '';
        const summary = summarizeJob(j, state, unit);
        const last = lastRunMs(state, unit);
        const s = obj(state);
        const files = unreadableList(state);
        return {
            id: id,
            name: (typeof j.name === 'string' && j.name.trim()) ? j.name.trim() : (id || 'Unnamed job'),
            repoId: typeof j.repo === 'string' ? j.repo : (obj(j.repo) && typeof j.repo.id === 'string' ? j.repo.id : ''),
            status: summary.status,
            label: summary.label,
            detail: summary.detail,
            remediation: summary.remediation,
            nextRun: summary.nextRun,
            nextRunText: nextRunText(summary.nextRun, now),
            lastRun: last,
            lastRunText: lastRunText(last, now),
            snapshot: s && typeof s.snapshot === 'string' ? s.snapshot : null,
            unreadable: s && isNum(s.unreadable) ? s.unreadable : files.length,
            unreadableFiles: files.slice(0, MAX_LISTED),
            unreadableMore: Math.max(0, files.length - MAX_LISTED),
            enabled: !!(obj(obj(unit) && unit.timer) && unit.timer.enabled)
        };
    }

    // Pure: what the expand-in-place panel under a job says.
    //
    // 'free-space' and 'list-unreadable' share one panel, and a NO_SPACE row has no
    // unreadable files to list — printing "0 file(s) were unreadable" underneath it
    // is not a rough edge, it is a false statement about the backup.
    function expansionFor(row) {
        const r = obj(row) || {};
        const files = Array.isArray(r.unreadableFiles) ? r.unreadableFiles : [];
        if (r.remediation === 'reauthorize')
            return {
                kind: 'auth', files: [], more: 0,
                text: 'The cloud destination stopped accepting this server\'s sign-in, so nothing '
                    + 'was backed up. "Sign in again" reopens the sign-in for that destination; '
                    + 'the backups resume on the next run.'
            };
        if (r.remediation === 'free-space')
            return {
                kind: 'space', files: [], more: 0,
                text: 'The destination ran out of space. Free space on it, or shorten how ' +
                      'much history the retention policy keeps, then run the backup again.'
            };
        if (files.length)
            return {
                kind: 'files', files: files,
                more: isNum(r.unreadableMore) && r.unreadableMore > 0 ? r.unreadableMore : 0,
                text: ''
            };
        const n = isNum(r.unreadable) && r.unreadable > 0 ? r.unreadable : 0;
        return {
            kind: 'count', files: [], more: 0,
            text: n + ' file' + (n === 1 ? '' : 's') + ' could not be read. The paths are in ' +
                  'the journal for this job\'s unit.'
        };
    }

    // Pure: repository + its stats (or the error that stopped us getting them).
    //
    // `fatal` is carried separately from `error` so the template can colour a
    // non-fatal outcome amber. A READ_ERRORS-shaped result is a warning about part
    // of the answer, never a red row claiming the repository is broken.
    function repoRow(repo, stats, error, deps) {
        const r = obj(repo) || {};
        const st = obj(stats);
        const E = (deps && deps.errors) || Errors;
        return {
            id: typeof r.id === 'string' ? r.id : '',
            kind: typeof r.kind === 'string' ? r.kind : '',
            description: Repos && typeof Repos.describe === 'function' ? Repos.describe(r) : '',
            size: st && isNum(st.totalSize) ? st.totalSize : null,
            sizeText: formatBytes(st && isNum(st.totalSize) ? st.totalSize : NaN),
            snapshots: st && isNum(st.snapshotsCount) ? st.snapshotsCount : null,
            files: st && isNum(st.totalFileCount) ? st.totalFileCount : null,
            error: error || null,
            errorText: errorMessage(error, deps),
            fatal: error ? !(E && typeof E.isFatal === 'function' && !E.isFatal(error)) : false,
            remediation: error && E && typeof E.remediationFor === 'function'
                ? normRemediation(E.remediationFor(error)) : null
        };
    }

    function sumStats(rows) {
        const out = { repos: 0, size: 0, snapshots: 0, unknown: 0, errors: 0 };
        if (!Array.isArray(rows)) return out;
        rows.forEach(function (r) {
            const row = obj(r);
            if (!row) return;
            out.repos++;
            if (row.error) out.errors++;
            if (isNum(row.size)) out.size += row.size; else out.unknown++;
            if (isNum(row.snapshots)) out.snapshots += row.snapshots;
        });
        return out;
    }

    // Pure: the exact command line used for repository health. Every restic-specific
    // decision still belongs to the engine — this only composes what it exports.
    function statsArgv(repo, deps) {
        const d = deps || {};
        const R = d.repos || Repos;
        const S = d.secrets || Secrets;
        const E = d.restic || Restic;
        // A module that failed to load must not surface as "Cannot read properties
        // of null" in an alert box — every failure this screen shows is typed.
        if (!R || typeof R.buildUrl !== 'function' ||
            !S || typeof S.keyPath !== 'function' ||
            !E || typeof E.buildArgs !== 'function')
            throw failure(d, 'A core module required to read repository health is missing.');
        return ['restic'].concat(E.buildArgs('stats', {
            repoUrl: R.buildUrl(repo),
            passwordFile: S.keyPath(obj(repo) ? repo.id : repo),
            // raw-data is the size the repository occupies on the destination.
            // restore-size (the default) answers a different question entirely.
            mode: 'raw-data'
        }));
    }

    function environList(repo, deps) {
        const R = (deps && deps.repos) || Repos;
        const env = R && typeof R.envFor === 'function' ? R.envFor(repo) : {};
        return Object.keys(env).sort().map(function (k) { return k + '=' + env[k]; });
    }

    // listRepos/listJobs answer [] when the directory is absent, but a core module
    // that fails differently must not reach the loop as "ids.length of undefined".
    function idList(v) {
        if (!Array.isArray(v)) return [];
        return v.filter(function (x) { return typeof x === 'string' && x !== ''; });
    }

    // ------------------------------------------------------------- component

    function resolveDeps(deps) {
        const d = deps || {};
        return {
            errors: d.errors || Errors,
            config: d.config || Config,
            schedule: d.schedule || Schedule,
            repos: d.repos || Repos,
            secrets: d.secrets || Secrets,
            restic: d.restic || Restic,
            logbook: d.logbook || Logbook,
            // app.js loads after the feature scripts, so the dialogs global is only
            // guaranteed to exist by the time a handler runs.
            dialogs: d.dialogs || null
        };
    }

    function hangarOverview(deps) {
        const D = resolveDeps(deps);

        // Shared by the row button and the action-error button, so a remediation
        // cannot mean one thing in one place and another somewhere else.
        function resticOp(op) {
            return function (repo) {
                if (!D.restic || !D.repos || !D.secrets)
                    throw failure(D, 'A core module required to talk to restic is missing.');
                return D.restic.run(op, {
                    repoUrl: D.repos.buildUrl(repo),
                    passwordFile: D.secrets.keyPath(repo.id)
                });
            };
        }

        return {
            loading: true,
            jobs: [],
            repos: [],
            totals: sumStats([]),
            overall: STATUS.NEVER,
            error: null,
            actionError: null,
            // The row an action failed for, so the action-error alert can offer the
            // remediation its kind implies rather than only naming the problem.
            actionRow: null,
            // Config files we could not read. A partial listing is reported as a
            // warning next to the rows we did get, never as a failed screen.
            warnings: [],
            busyIds: [],
            expanded: null,
            now: 0,

            // --- pure helpers reused by the template ---------------------
            statusClass: statusClass,
            statusBadgeClass: statusBadgeClass,
            statusLabel: statusLabel,
            remediationLabel: remediationLabel,
            formatBytes: formatBytes,
            formatDuration: formatDuration,
            expansionFor: expansionFor,
            expands: expands,

            init() {
                this.refresh();
            },

            isBusy(id) { return this.busyIds.indexOf(id) >= 0; },

            setBusy(id, on) {
                const i = this.busyIds.indexOf(id);
                if (on && i < 0) this.busyIds.push(id);
                if (!on && i >= 0) this.busyIds.splice(i, 1);
            },

            hasCockpit() { return typeof cockpit !== 'undefined' && !!cockpit; },

            // A file we could not read is a hole in the answer, not a failed screen.
            // The key is scoped by kind because a job and a repository are allowed
            // to share an id, and two warnings keyed on the bare id would collide in
            // the template's x-for.
            warn(kind, path, message, e) {
                this.warnings.push({
                    key: kind + ':' + path,
                    kind: kind,
                    path: path,
                    message: message,
                    detail: errorMessage(e, D)
                });
            },

            async refresh() {
                this.loading = true;
                this.error = null;
                this.warnings = [];
                this.now = Date.now();
                let jobs = [];
                let repos = [];
                try {
                    if (!D.config) throw failure(D, 'The configuration module is not available.');
                    jobs = await this.loadJobs();
                    repos = await this.loadRepos();
                } catch (e) {
                    this.error = e;
                } finally {
                    // Assigned even on the failure path: whatever we did manage to
                    // read is still shown next to the error, and stale rows from the
                    // previous refresh are worse than none.
                    this.jobs = jobs;
                    this.repos = repos;
                    this.totals = sumStats(repos);
                    this.overall = overallStatus(jobs);
                    this.loading = false;
                }
            },

            async loadJobs() {
                const ids = idList(await D.config.listJobs());
                const rows = [];
                for (let i = 0; i < ids.length; i++) {
                    const id = ids[i];
                    let job = null;
                    try {
                        job = await D.config.readJob(id);
                    } catch (e) {
                        this.warn('job', id, 'Job could not be read.', e);
                        continue;
                    }
                    if (job !== null && job !== undefined && !obj(job)) {
                        // A file holding a JSON scalar or array is not a job, and
                        // assigning to it below would throw under 'use strict'.
                        this.warn('job', id, 'Job file does not contain a JSON object.', null);
                        continue;
                    }
                    // The filename is the identity. unitState() and "Back up now"
                    // both address systemd by it, so a file whose "id" field
                    // disagrees must not be able to aim a row's actions at another
                    // job — or collide with that job's row key.
                    const def = Object.assign({}, obj(job) || {}, { id: id });
                    let state = null;
                    try { state = await D.config.readState(id); } catch (e) { state = null; }
                    let unit = null;
                    try {
                        unit = D.schedule ? await D.schedule.unitState(id) : null;
                    } catch (e) {
                        // No systemd answer means no schedule information; the last
                        // recorded run is still worth showing.
                        unit = null;
                    }
                    rows.push(jobRow(def, state, unit, this.now));
                }
                return rows;
            },

            async loadRepos() {
                const ids = idList(await D.config.listRepos());
                const rows = [];
                for (let i = 0; i < ids.length; i++) {
                    const id = ids[i];
                    let repo = null;
                    try {
                        repo = await D.config.readRepo(id);
                    } catch (e) {
                        this.warn('repository', id, 'Repository could not be read.', e);
                        continue;
                    }
                    if (!obj(repo)) {
                        // Covers an empty file (readJson answers null) and a file
                        // holding a scalar or array. Silently skipping it would hide
                        // a repository the user believes exists.
                        this.warn('repository', id, 'Repository file does not contain a JSON object.', null);
                        continue;
                    }
                    const def = Object.assign({}, repo, { id: id });
                    let stats = null;
                    let err = null;
                    try {
                        stats = await this.fetchStats(def);
                    } catch (e) {
                        err = e;
                    }
                    rows.push(repoRow(def, stats, err, D));
                }
                return rows;
            },

            // HangarRestic.run() folds a JSON-LINES stream, but `stats` emits a
            // single JSON document, so its numbers are not reachable through run().
            // The engine still owns both restic-specific decisions here: buildArgs
            // makes the command line, parseStats reads the answer.
            async fetchStats(repo) {
                // The definition is checked before cockpit is: a repository with an
                // unknown kind is broken whether or not a channel is available, and
                // saying "cockpit is not available" about it sends the user looking
                // in the wrong place. Both throws are typed, and both are outside the
                // try below so neither is reclassified as a restic exit status it
                // never had.
                const argv = statsArgv(repo, D);
                const environ = environList(repo, D);
                if (!this.hasCockpit())
                    throw failure(D, 'cockpit is not available.');
                try {
                    const out = await cockpit.spawn(argv, {
                        superuser: 'require',
                        err: 'message',
                        environ: environ
                    });
                    return D.restic.parseStats(out);
                } catch (e) {
                    // parseStats throws a typed error of its own on unparseable
                    // output; re-classifying that as an exit status would invent a
                    // remediation for a failure that has none.
                    if (D.errors && D.errors.isHangarError && D.errors.isHangarError(e) &&
                        (e.exit_status === undefined || e.exit_status === null)) throw e;
                    throw D.restic.classifyExit(e && e.exit_status,
                        (e && (e.message || e.problem)) || '');
                }
            },

            // --- actions --------------------------------------------------

            failAction(e, row, scope) {
                this.actionError = e;
                this.actionRow = row && row.id
                    ? { id: row.id, repoId: row.repoId, scope: scope || 'job' }
                    : null;
            },

            clearAction() { this.actionError = null; this.actionRow = null; },

            async backupNow(row) {
                const id = row && row.id;
                if (!id) return;
                this.clearAction();
                if (!D.schedule) {
                    this.failAction(failure(D, 'The scheduler module is not available.'), row);
                    return;
                }
                this.setBusy(id, true);
                try {
                    await D.schedule.runNow(id);
                    // StartUnit returns as soon as the job is queued, so this
                    // refresh shows "Running now"; the outcome lands on a later one.
                    await this.refresh();
                } catch (e) {
                    this.failAction(e, row);
                } finally {
                    this.setBusy(id, false);
                }
            },

            // Typed errors become buttons, not toasts — this is where the button
            // ends up. Unrecognised remediations fall through to the retry branch
            // rather than being dispatched on, so a string from outside the closed
            // set can never name a code path here.
            async remediate(row) {
                if (!row) return;
                switch (normRemediation(row.remediation)) {
                case 'list-unreadable':
                case 'free-space':
                case 'reauthorize':
                    this.toggle(row.id);
                    return;
                case 'unlock':
                    return this.withRepo(row, resticOp('unlock'));
                case 'init':
                    return this.withRepo(row, resticOp('init'));
                case 'reprompt':
                    return this.reprompt(row);
                default:
                    return this.backupNow(row);
                }
            },

            // A repository row is not a job: there is no unit to start, so the
            // retry case re-reads its health rather than launching a backup, and
            // the expand-in-place remediations have no panel to open here.
            async remediateRepo(row) {
                const id = row && row.id;
                if (!id) return;
                const target = { id: id, repoId: id };
                switch (normRemediation(row.remediation)) {
                case 'unlock':
                    return this.withRepo(target, resticOp('unlock'), 'repo');
                case 'init':
                    return this.withRepo(target, resticOp('init'), 'repo');
                case 'reprompt':
                    return this.reprompt(target, 'repo');
                default:
                    this.clearAction();
                    return this.refresh();
                }
            },

            toggle(id) { this.expanded = this.expanded === id ? null : id; },

            async withRepo(row, fn, scope) {
                this.clearAction();
                this.setBusy(row.id, true);
                try {
                    if (!D.config) throw failure(D, 'The configuration module is not available.');
                    if (!row.repoId) throw failure(D,
                        'This row does not name a repository, so there is nothing to act on.');
                    const repo = await D.config.readRepo(row.repoId);
                    if (!obj(repo)) throw failure(D,
                        'Job "' + row.id + '" names a repository that does not exist.');
                    await fn(Object.assign({}, repo, { id: row.repoId }));
                    await this.refresh();
                } catch (e) {
                    this.failAction(e, row, scope);
                } finally {
                    this.setBusy(row.id, false);
                }
            },

            async reprompt(row, scope) {
                const dialogs = D.dialogs || root.HangarDialogs;
                this.clearAction();
                if (!dialogs || typeof dialogs.passwordDialog !== 'function') {
                    // Silence here reads as a dead button. A password that cannot be
                    // asked for is a failure with a name.
                    this.failAction(failure(D,
                        'The password prompt is not available on this page.'), row, scope);
                    return;
                }
                if (!row || !row.repoId) {
                    this.failAction(failure(D,
                        'This row does not name a repository, so there is no password to set.'), row, scope);
                    return;
                }
                this.setBusy(row.id, true);
                try {
                    const password = await dialogs.passwordDialog({
                        title: 'Repository password',
                        repoLabel: row.repoId
                    });
                    if (!password) return;
                    if (!D.secrets) throw failure(D, 'The secret store module is not available.');
                    await D.secrets.writeKey(row.repoId, password);
                    await this.refresh();
                } catch (e) {
                    this.failAction(e, row, scope);
                } finally {
                    this.setBusy(row.id, false);
                }
            },

            // The empty state's only job is to get the user to a repository.
            startFirstRepo() {
                if (typeof root.dispatchEvent !== 'function' ||
                    typeof root.CustomEvent !== 'function') return false;
                root.dispatchEvent(new root.CustomEvent('hangar:new-repo', { detail: {} }));
                return true;
            },

            // --- derived --------------------------------------------------

            isEmpty() {
                return !this.loading && !this.error && !this.jobs.length && !this.repos.length;
            },
            needsJob() { return !this.loading && !this.jobs.length && !!this.repos.length; },
            overallText() { return statusLabel(this.overall); },
            errorText(e) { return errorMessage(e, D); },
            errorRemediation(e) {
                if (!e || !D.errors || typeof D.errors.remediationFor !== 'function') return null;
                try { return normRemediation(D.errors.remediationFor(e)); } catch (x) { return null; }
            },

            // The action-error alert's own button. Without it a typed failure from
            // an action would be the one place on this screen where a remediation
            // is computed and then shown as prose.
            actionRemediation() { return this.errorRemediation(this.actionError); },

            async runActionRemediation() {
                const r = this.actionRemediation();
                const row = this.actionRow;
                if (!r) return;
                if (!row) { this.clearAction(); return this.refresh(); }
                const scope = row.scope;
                this.clearAction();
                return scope === 'repo'
                    ? this.remediateRepo({ id: row.id, remediation: r })
                    : this.remediate({ id: row.id, repoId: row.repoId, remediation: r });
            },

            totalSizeText() { return this.totals.unknown && !this.totals.repos ? UNKNOWN : formatBytes(this.totals.size); }
        };
    }

    // ------------------------------------------------------------- template
    //
    // index.html ships #hangar-overview empty, so the screen brings its own markup.
    // It is a first-party constant string, injected before Alpine walks the DOM.

    const TEMPLATE = [
        '<div x-data="hangarOverview()" x-init="init()">',
        '  <div class="d-flex align-items-center gap-2 mb-3">',
        '    <h2 class="h6 mb-0">Backup status</h2>',
        '    <span class="badge" :class="statusBadgeClass(overall)" x-text="overallText()"',
        '          x-show="!loading && jobs.length"></span>',
        '    <span class="flex-grow-1"></span>',
        '    <span x-show="loading" class="text-secondary small" role="status"',
        '          aria-live="polite">Loading…</span>',
        '    <button type="button" class="btn btn-sm btn-outline-secondary"',
        '            @click="refresh()" :disabled="loading">Refresh</button>',
        '  </div>',

        // Whole-screen failure. Reading the configuration is the only thing that can
        // fail here, so retrying the read is the only honest action to offer.
        // x-show sets an inline `display: none`, but Bootstrap's `.d-flex` is
        // `display: flex !important` and wins — so the two must never share an
        // element or the box is permanently visible. The toggle goes on a plain
        // wrapper; the flex layout stays inside it.
        '  <div x-show="error">',
        '    <div class="alert alert-danger d-flex align-items-center gap-3" role="alert">',
        '      <div class="flex-grow-1">',
        '        <strong>Could not read the backup configuration.</strong>',
        '        <div class="small" x-text="errorText(error)"></div>',
        '      </div>',
        '      <button type="button" class="btn btn-sm btn-danger" @click="refresh()">Try again</button>',
        '    </div>',
        '  </div>',

        // A partial listing: some files were unreadable, the rest are below. Amber
        // and enumerated — the same rule restic exit 3 gets, applied to config.
        '  <div x-show="warnings.length" class="alert alert-warning" role="status">',
        '    <strong>Some configuration files could not be read.</strong>',
        '    <div class="small">Everything below was read successfully.</div>',
        '    <ul class="mb-0 small">',
        '      <template x-for="w in warnings" :key="w.key">',
        '        <li><span class="hangar-mono" x-text="w.path"></span> — <span x-text="w.message"></span>',
        '          <span class="text-secondary" x-show="w.detail" x-text="w.detail"></span></li>',
        '      </template>',
        '    </ul>',
        '  </div>',

        // An action that failed carries its remediation with it, as a button.
        // Same rule as above: the x-show toggle must not carry `.d-flex`.
        '  <div x-show="actionError">',
        '    <div class="alert alert-danger d-flex align-items-center gap-2 py-2 px-3" role="alert">',
        '      <div class="flex-grow-1 small" x-text="errorText(actionError)"></div>',
        '      <button type="button" class="btn btn-sm btn-danger" x-show="actionRemediation()"',
        '              @click="runActionRemediation()"',
        '              x-text="remediationLabel(actionRemediation())"></button>',
        '      <button type="button" class="btn-close" aria-label="Dismiss this error"',
        '              @click="clearAction()"></button>',
        '    </div>',
        '  </div>',

        // Empty state.
        '  <div x-show="isEmpty()" class="hangar-empty">',
        '    <h3 class="h5">No backups yet</h3>',
        '    <p class="mb-3">Start by adding a repository — the encrypted destination your',
        '       backups are written to. A job then decides what goes into it and when.</p>',
        '    <button type="button" class="btn btn-primary"',
        '            @click="tab = \'repos\'; startFirstRepo()">Create your first repository</button>',
        '  </div>',

        '  <div x-show="needsJob()" class="hangar-empty">',
        '    <h3 class="h5">No backup jobs yet</h3>',
        '    <p class="mb-3">You have a repository. Add a job to decide what is backed up and how often.</p>',
        '    <button type="button" class="btn btn-primary" @click="tab = \'jobs\'">Create a job</button>',
        '  </div>',

        // Jobs.
        '  <section x-show="jobs.length" aria-labelledby="hangar-overview-jobs">',
        '    <h3 class="visually-hidden" id="hangar-overview-jobs">Jobs</h3>',
        '    <template x-for="j in jobs" :key="j.id">',
        '      <div class="card mb-2">',
        '        <div class="card-body py-2 d-flex align-items-center gap-3 flex-wrap">',
        '          <div class="flex-grow-1">',
        '            <div>',
        '              <span class="hangar-dot" :class="statusClass(j.status)" aria-hidden="true"></span>',
        '              <strong x-text="j.name"></strong>',
        '              <span class="text-secondary small ms-2" x-show="j.repoId">→ <span',
        '                    class="hangar-mono" x-text="j.repoId"></span></span>',
        '            </div>',
        '            <div class="small" :class="j.status === \'failed\' ? \'text-danger\' :',
        '                 (j.status === \'partial\' ? \'text-warning-emphasis\' : \'text-secondary\')">',
        '              <span x-text="j.label"></span> — <span x-text="j.detail"></span>',
        '            </div>',
        '            <div class="small text-secondary">',
        '              Last run <span x-text="j.lastRunText"></span> ·',
        '              next <span x-text="j.nextRunText"></span>',
        '            </div>',
        '            <div x-show="expanded === j.id" class="small mt-2"',
        '                 :id="\'hangar-job-detail-\' + j.id">',
        '              <div x-show="expansionFor(j).kind === \'files\'">',
        '                <ul class="hangar-mono mb-0">',
        '                  <template x-for="p in expansionFor(j).files" :key="p">',
        '                    <li x-text="p"></li>',
        '                  </template>',
        '                </ul>',
        '                <div class="text-secondary" x-show="expansionFor(j).more">',
        '                  and <span x-text="expansionFor(j).more"></span> more, in the journal',
        '                  for this job\'s unit.',
        '                </div>',
        '              </div>',
        '              <div x-show="expansionFor(j).kind !== \'files\'" class="text-secondary"',
        '                   x-text="expansionFor(j).text"></div>',
        '            </div>',
        '          </div>',
        '          <button type="button" x-show="j.remediation"',
        '                  class="btn btn-sm"',
        '                  :class="j.status === \'failed\' ? \'btn-outline-danger\' : \'btn-outline-warning\'"',
        '                  :disabled="isBusy(j.id)"',
        '                  :aria-expanded="expands(j.remediation) ? (expanded === j.id ? \'true\' : \'false\') : null"',
        '                  :aria-controls="expands(j.remediation) ? (\'hangar-job-detail-\' + j.id) : null"',
        '                  @click="remediate(j)"',
        '                  x-text="remediationLabel(j.remediation)"></button>',
        '          <button type="button" class="btn btn-sm btn-primary"',
        '                  :disabled="isBusy(j.id) || j.status === \'running\'"',
        '                  :aria-label="\'Back up \' + j.name + \' now\'"',
        '                  @click="backupNow(j)">Back up now</button>',
        '        </div>',
        '      </div>',
        '    </template>',
        '  </section>',

        // Repository health.
        '  <section x-show="repos.length" class="mt-4" aria-labelledby="hangar-overview-repos">',
        '    <div class="d-flex align-items-baseline gap-2 mb-2">',
        '      <h3 class="h6 mb-0" id="hangar-overview-repos">Repositories</h3>',
        '      <span class="text-secondary small">',
        '        <span x-text="totalSizeText()"></span> in',
        '        <span x-text="totals.snapshots"></span> snapshot(s)',
        '      </span>',
        '    </div>',
        '    <div class="table-responsive">',
        '      <table class="table table-sm align-middle mb-0">',
        '        <thead><tr><th scope="col">Repository</th><th scope="col">Where</th>',
        '          <th scope="col" class="text-end">Size</th>',
        '          <th scope="col" class="text-end">Snapshots</th></tr></thead>',
        '        <tbody>',
        '          <template x-for="r in repos" :key="r.id">',
        '            <tr>',
        '              <th scope="row" class="fw-normal hangar-mono" x-text="r.id"></th>',
        '              <td class="text-secondary small">',
        '                <span x-text="r.description"></span>',
        // A non-fatal outcome is amber. Red is reserved for "this repository is
        // broken", which a partial answer is not.
        '                <div x-show="r.error" x-text="r.errorText"',
        '                     :class="r.fatal ? \'text-danger\' : \'text-warning-emphasis\'"></div>',
        '                <button type="button" class="btn btn-sm mt-1"',
        '                        x-show="r.error && r.remediation"',
        '                        :class="r.fatal ? \'btn-outline-danger\' : \'btn-outline-warning\'"',
        '                        :disabled="isBusy(r.id)"',
        '                        :aria-label="remediationLabel(r.remediation) + \' for repository \' + r.id"',
        '                        @click="remediateRepo(r)"',
        '                        x-text="remediationLabel(r.remediation)"></button>',
        '              </td>',
        '              <td class="text-end" x-text="r.sizeText"></td>',
        '              <td class="text-end" x-text="r.snapshots === null ? \'\\u2014\' : r.snapshots"></td>',
        '            </tr>',
        '          </template>',
        '        </tbody>',
        '      </table>',
        '    </div>',
        '  </section>',
        '</div>'
    ].join('\n');

    // Mounting is guarded so this module still loads under node with no DOM.
    // 'alpine:init' is the only moment guaranteed to be after this script ran (it is
    // a plain <script> in index.html) and before Alpine walks the DOM — boot.js
    // appends Alpine only once the modal partials have landed.
    function mount(doc) {
        const host = doc && typeof doc.getElementById === 'function'
            ? doc.getElementById('hangar-overview') : null;
        if (!host || host.getAttribute('data-hangar-mounted')) return false;
        // TEMPLATE is a module constant with no interpolation of any kind — no
        // configuration, hostname or restic output reaches it. Same trust boundary
        // as boot.js injecting the modal partials.
        host.innerHTML = TEMPLATE;
        host.setAttribute('data-hangar-mounted', '1');
        return true;
    }

    if (root.document && typeof root.document.addEventListener === 'function') {
        root.document.addEventListener('alpine:init', function () { mount(root.document); });
    }

    root.hangarOverview = hangarOverview;

    const HangarOverview = {
        STATUS, RANK, LABEL, DOT_CLASS, BADGE_CLASS, KIND_DETAIL, REMEDIATION_LABEL, TEMPLATE,
        MAX_LISTED,
        hangarOverview,
        summarizeJob, overallStatus,
        formatBytes, formatDuration,
        statusClass, statusBadgeClass, statusLabel, remediationLabel,
        normRemediation, expands, expansionFor,
        errorMessage, redactText,
        lastRunMs, durationSec, unreadableList, toMillis,
        relative, lastRunText, nextRunText,
        jobRow, repoRow, sumStats, statsArgv, environList, idList,
        mount
    };
    root.HangarOverview = HangarOverview;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarOverview;
})(typeof window !== 'undefined' ? window : globalThis);
