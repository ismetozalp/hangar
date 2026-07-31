// features/jobs-ui.js — the Jobs screen: list, editor, and "back up now" with
// live progress.
//
// Two Alpine components live here because the editor markup is a modal partial
// injected into #hangar-partials, outside the screen's x-data scope (see
// js/boot.js). They talk over a CustomEvent carrying a resolver, exactly like the
// shared confirm/password dialogs in js/app.js, so the list component stays the
// only place that performs I/O.
//
// Everything that decides something — form <-> job conversion, validation, the
// progress line — is a pure function exported alongside the factories, so the
// unit tests exercise the real logic rather than a component that merely
// constructs.
'use strict';
(function (root) {

    // Resolved on first use, never at load time: in the browser app.js (which owns
    // HangarDialogs) loads *after* the feature scripts, so an eager capture would
    // pin undefined forever. Under node the require() branch makes the pure
    // functions work with no globals at all.
    const PATHS = {
        HangarErrors: '../core/errors.js',
        HangarConfig: '../core/config.js',
        HangarRepos: '../core/repos.js',
        HangarSecrets: '../core/secrets.js',
        HangarSources: '../core/sources.js',
        HangarRetention: '../core/retention.js',
        HangarSchedule: '../core/schedule.js',
        HangarRestic: '../engine/restic.js',
        HangarDialogs: '../app.js'
    };
    const RESOLVED = {};

    function M(name) {
        // The live global wins over the cache: index.html loads app.js *after* the
        // feature scripts, so a module can legitimately appear later than the first
        // lookup, and a cached miss would pin the wrong answer forever.
        const live = root[name];
        if (live) return live;
        if (RESOLVED[name]) return RESOLVED[name];
        let mod = root[name];
        if (!mod && typeof require === 'function' && PATHS[name]) {
            try {
                require(PATHS[name]);
                mod = root[name];       // app.js exports a bundle; the global is canonical
            } catch (e) {
                mod = null;
            }
        }
        if (mod) RESOLVED[name] = mod;
        return mod;
    }

    // A typed HangarError when errors.js is loaded, a plain Error when it is not.
    // Reporting a failure must not itself depend on a module having loaded.
    function err(kind, message, detail) {
        const Errors = M('HangarErrors');
        if (Errors) return Errors.create(kind, message, detail);
        const e = new Error(message);
        e.kind = kind;
        e.detail = detail === undefined ? null : detail;
        return e;
    }

    const CONTAINER_ID = 'hangar-jobs';
    const MODAL_ID = 'hangar-job-edit';
    const EDIT_EVENT = 'hangar:job-edit';

    const UNIT_DIR = '/etc/systemd/system';

    // Shorthands are systemd's own (schedule.js SHORTHAND), so describeSchedule()
    // explains them without hangar owning a second calendar vocabulary.
    const SCHEDULE_MODES = [
        { id: 'daily', calendar: 'daily', label: 'Every day, at midnight' },
        { id: 'hourly', calendar: 'hourly', label: 'Every hour, on the hour' },
        { id: 'weekly', calendar: 'weekly', label: 'Every Monday, at midnight' },
        { id: 'custom', calendar: '', label: 'Custom schedule…' }
    ];

    const COUNT_FIELDS = ['last', 'hourly', 'daily', 'weekly', 'monthly', 'yearly'];

    // Wording for each HangarErrors remediation. `null` (no remediation) shows no
    // button at all — the failure is still reported, just without a one-click fix.
    const REMEDIATION_LABELS = {
        unlock: 'Unlock repository',
        reprompt: 'Enter password',
        init: 'Initialise repository',
        'list-unreadable': 'Show unreadable files',
        'free-space': 'Try again after freeing space',
        retry: 'Try again'
    };

    // ---------------------------------------------------------------- helpers

    // Total by construction. Everything this screen renders came from JSON on disk
    // or from a restic stream, so String() can meet a symbol or a null-prototype
    // object — and a value we cannot render must not take the whole screen down.
    function str(v) {
        if (typeof v === 'string') return v;
        if (v === null || v === undefined) return '';
        try {
            return String(v);
        } catch (e) {
            return '';
        }
    }

    function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

    function num(v) {
        if (typeof v === 'boolean' || v === '' || v === null || v === undefined) return null;
        let n;
        try {
            n = Number(v);          // Number(symbol) throws, as does a null-prototype object
        } catch (e) {
            return null;
        }
        return isFinite(n) ? n : null;
    }

    // A textarea is the honest widget for "a list of paths", so one line is one
    // entry. Blank lines are dropped rather than becoming empty paths.
    function splitLines(value) {
        if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
        return str(value).split('\n').map((l) => l.trim()).filter((l) => l !== '');
    }

    function joinLines(list) {
        return (Array.isArray(list) ? list : []).filter((v) => typeof v === 'string').join('\n');
    }

    // Tags are a single-line field, so both commas and whitespace separate them.
    function splitTags(value) {
        if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
        return str(value).split(/[,\n]/).map((t) => t.trim()).filter((t) => t !== '');
    }

    function joinTags(list) {
        return (Array.isArray(list) ? list : []).filter((v) => typeof v === 'string').join(', ');
    }

    function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

    // ---------------------------------------------------------------- pure: form

    function emptyRetentionFields() {
        return { last: '', hourly: '', daily: '', weekly: '', monthly: '', yearly: '', within: '', tags: '' };
    }

    function defaultPreset() {
        const R = M('HangarRetention');
        return (R && R.DEFAULT_PRESET) || 'rolling';
    }

    function emptyForm() {
        return {
            isNew: true,
            id: '',
            name: '',
            repo: '',
            sourceId: 'main',
            paths: '',
            excludes: '',
            excludeFile: '',
            oneFileSystem: false,
            tags: '',
            // 'rolling' is preselected: it is the policy that makes the Logbook feel
            // continuous rather than sparse.
            retentionPreset: defaultPreset(),
            retention: emptyRetentionFields(),
            scheduleMode: 'daily',
            calendar: '',
            preHook: '',
            postHook: '',
            enabled: true,
            timeoutSec: null,
            // Carried through untouched so saving never silently drops something
            // this screen does not render.
            scheduleExtra: {},
            otherSources: []
        };
    }

    // Fills the custom fields from a preset, so switching to "Custom" starts from
    // what the user was already looking at instead of an empty form.
    function presetFields(name) {
        const R = M('HangarRetention');
        const p = (R && R.preset(name)) || {};
        const out = emptyRetentionFields();
        COUNT_FIELDS.forEach((k) => { if (p[k] !== undefined && p[k] !== null) out[k] = String(p[k]); });
        if (p.within) out.within = String(p.within);
        if (p.tags) out.tags = joinTags(Array.isArray(p.tags) ? p.tags : [p.tags]);
        return out;
    }

    function formRetention(form) {
        const f = isObj(form) ? form : {};
        const R = M('HangarRetention');
        if (f.retentionPreset && f.retentionPreset !== 'custom')
            return (R && R.preset(f.retentionPreset)) || {};

        const src = isObj(f.retention) ? f.retention : {};
        const out = {};
        COUNT_FIELDS.forEach((k) => {
            const raw = src[k];
            if (raw === '' || raw === null || raw === undefined) return;
            const n = Number(raw);
            // An unparsable value is kept verbatim so retention.validate() can
            // complain about what the user actually typed instead of a silent NaN.
            out[k] = isFinite(n) && str(raw).trim() !== '' ? n : raw;
        });
        if (str(src.within).trim()) out.within = str(src.within).trim();
        const tags = splitTags(src.tags);
        if (tags.length) out.tags = tags;
        return out;
    }

    function samePolicy(a, b) {
        const R = M('HangarRetention');
        const na = R ? R.normalize(a) : a;
        const nb = R ? R.normalize(b) : b;
        const ka = Object.keys(na).sort();
        const kb = Object.keys(nb).sort();
        if (ka.length !== kb.length || ka.join(',') !== kb.join(',')) return false;
        return ka.every((k) => String(na[k]) === String(nb[k]));
    }

    function presetNameFor(policy) {
        const R = M('HangarRetention');
        if (!R) return 'custom';
        const names = Object.keys(R.PRESETS);
        for (let i = 0; i < names.length; i++) {
            if (samePolicy(policy, R.PRESETS[names[i]])) return names[i];
        }
        return 'custom';
    }

    function keepsNothing(form) {
        const R = M('HangarRetention');
        const problems = R ? R.validate(formRetention(form)) : [];
        return problems.some((p) => p && p.detail && p.detail.code === 'delete-everything');
    }

    function formCalendar(form) {
        const f = isObj(form) ? form : {};
        if (f.scheduleMode === 'custom') return str(f.calendar).trim();
        const mode = SCHEDULE_MODES.filter((m) => m.id === f.scheduleMode)[0];
        return mode ? mode.calendar : '';
    }

    function scheduleModeFor(calendar) {
        const c = str(calendar).trim().toLowerCase();
        const mode = SCHEDULE_MODES.filter((m) => m.calendar && m.calendar === c)[0];
        return mode ? mode.id : 'custom';
    }

    function formSource(form) {
        const f = isObj(form) ? form : {};
        const source = {
            id: str(f.sourceId).trim() || 'main',
            kind: 'filesystem',
            paths: splitLines(f.paths),
            excludes: splitLines(f.excludes),
            oneFileSystem: !!f.oneFileSystem
        };
        const excludeFile = splitLines(f.excludeFile);
        if (excludeFile.length) source.excludeFile = excludeFile;
        const tags = splitTags(f.tags);
        if (tags.length) source.tags = tags;
        return source;
    }

    function isFilesystem(source) {
        return isObj(source) && (source.kind === 'filesystem' || source.kind === undefined);
    }

    // The editor presents one filesystem source. A job with several is merged for
    // editing and for a manual run — restic takes all the paths in one invocation
    // anyway, so nothing is lost.
    function mergeFilesystemSources(job) {
        const list = (job && Array.isArray(job.sources) ? job.sources : []).filter(isFilesystem);
        const merged = {
            id: str(list.length ? list[0].id : '') || 'main',
            kind: 'filesystem',
            paths: [], excludes: [], excludeFile: [], tags: [],
            oneFileSystem: false
        };
        list.forEach((s) => {
            splitLines(s.paths).forEach((p) => { if (merged.paths.indexOf(p) < 0) merged.paths.push(p); });
            splitLines(s.excludes).forEach((p) => { if (merged.excludes.indexOf(p) < 0) merged.excludes.push(p); });
            splitLines(s.excludeFile).forEach((p) => { if (merged.excludeFile.indexOf(p) < 0) merged.excludeFile.push(p); });
            splitTags(s.tags).forEach((t) => { if (merged.tags.indexOf(t) < 0) merged.tags.push(t); });
            if (s.oneFileSystem) merged.oneFileSystem = true;
        });
        return merged;
    }

    function formStateToJob(form) {
        const f = isObj(form) ? form : {};
        const job = {
            id: str(f.id).trim(),
            name: str(f.name).trim(),
            repo: str(f.repo).trim(),
            enabled: f.enabled !== false,
            sources: [formSource(f)].concat(Array.isArray(f.otherSources) ? f.otherSources : []),
            retention: formRetention(f),
            schedule: Object.assign({}, isObj(f.scheduleExtra) ? f.scheduleExtra : {},
                { calendar: formCalendar(f) })
        };

        const pre = str(f.preHook).trim();
        const post = str(f.postHook).trim();
        if (pre || post) {
            job.hooks = {};
            if (pre) job.hooks.pre = pre;
            if (post) job.hooks.post = post;
        }

        const timeout = num(f.timeoutSec);
        if (timeout !== null) job.timeoutSec = timeout;

        return job;
    }

    function jobToFormState(job) {
        const f = emptyForm();
        const j = isObj(job) ? job : {};

        f.isNew = !str(j.id);
        f.id = str(j.id);
        f.name = str(j.name);
        // schedule.js accepts { id } as well as a bare id for job.repo; both mean
        // the same repository here.
        f.repo = typeof j.repo === 'string' ? j.repo : (isObj(j.repo) ? str(j.repo.id) : '');
        f.enabled = j.enabled !== false;

        const sources = Array.isArray(j.sources) ? j.sources : [];
        // Only real objects are carried through: a null or a string in `sources`
        // would otherwise be written straight back to /etc on the next save.
        f.otherSources = sources.filter((s) => isObj(s) && !isFilesystem(s));
        const merged = mergeFilesystemSources(j);
        f.sourceId = merged.id;
        f.paths = joinLines(merged.paths);
        f.excludes = joinLines(merged.excludes);
        f.excludeFile = joinLines(merged.excludeFile);
        f.tags = joinTags(merged.tags);
        f.oneFileSystem = merged.oneFileSystem;

        const R = M('HangarRetention');
        const policy = R ? R.normalize(j.retention) : (j.retention || {});
        f.retentionPreset = presetNameFor(policy);
        if (f.retentionPreset === 'custom') {
            const fields = emptyRetentionFields();
            COUNT_FIELDS.forEach((k) => {
                if (policy[k] !== undefined && policy[k] !== null && policy[k] !== '')
                    fields[k] = String(policy[k]);
            });
            if (policy.within !== undefined && policy.within !== null) fields.within = String(policy.within);
            if (policy.tags !== undefined && policy.tags !== null) fields.tags = joinTags(splitTags(policy.tags));
            f.retention = fields;
        } else {
            f.retention = presetFields(f.retentionPreset);
        }

        const schedule = typeof j.schedule === 'string' ? { calendar: j.schedule }
            : (isObj(j.schedule) ? j.schedule : {});
        const calendars = Array.isArray(schedule.calendar) ? schedule.calendar : [schedule.calendar];
        const calendar = str(calendars[0]);
        f.scheduleMode = calendar ? scheduleModeFor(calendar) : 'daily';
        f.calendar = calendar;
        f.scheduleExtra = {};
        Object.keys(schedule).forEach((k) => { if (k !== 'calendar') f.scheduleExtra[k] = schedule[k]; });

        const hooks = isObj(j.hooks) ? j.hooks : {};
        f.preHook = str(hooks.pre);
        f.postHook = str(hooks.post);

        const timeout = num(j.timeoutSec);
        f.timeoutSec = timeout;

        return f;
    }

    // ---------------------------------------------------------- pure: validation

    function problem(severity, code, field, message) {
        return { severity: severity, code: code, field: field, message: message };
    }

    // `code` comes from a source kind's validate(), which in v2 may be a third
    // party's — so it is normalised rather than assumed to be a string.
    function fieldForSourceProblem(raw) {
        const code = str(raw);
        if (code === 'no-paths' || code.indexOf('path-') === 0) return 'paths';
        if (code.indexOf('pattern-') === 0) return 'excludes';
        if (code.indexOf('exclude-file') === 0) return 'excludeFile';
        if (code.indexOf('tag-') === 0) return 'tags';
        return 'source';
    }

    // `taken` is the list of ids that already exist; only a *new* job can collide.
    function validateForm(form, taken) {
        const f = isObj(form) ? form : {};
        const out = [];
        const Config = M('HangarConfig');
        const Sources = M('HangarSources');
        const Retention = M('HangarRetention');
        const Schedule = M('HangarSchedule');

        const id = str(f.id).trim();
        if (!id) {
            out.push(problem('error', 'id-required', 'id', 'Give the job an id.'));
        } else if (Config) {
            try {
                Config.validateId(id);
            } catch (e) {
                out.push(problem('error', 'id-invalid', 'id', e.message));
            }
        }
        if (id && f.isNew && Array.isArray(taken) && taken.indexOf(id) >= 0)
            out.push(problem('error', 'id-taken', 'id', 'A job with the id "' + id + '" already exists.'));

        if (!str(f.name).trim())
            out.push(problem('warning', 'name-empty', 'name', 'Without a name the job is listed by its id.'));

        if (!str(f.repo).trim())
            out.push(problem('error', 'repo-required', 'repo', 'Choose the repository this job backs up to.'));

        if (Sources) {
            Sources.validate(formSource(f)).forEach((p) => {
                out.push(problem(p.severity, 'source-' + p.code, fieldForSourceProblem(p.code), p.message));
            });
        }

        // The guard that matters: `restic forget --prune` with a policy that keeps
        // nothing destroys every snapshot in the group, and that is unrecoverable.
        // It is refused here as well as in core/retention.js so the user is stopped
        // at the form rather than at the run.
        if (keepsNothing(f)) {
            out.push(problem('error', 'retention-keeps-nothing', 'retention',
                'This policy keeps nothing — every snapshot would be deleted. ' +
                'Choose a preset, or set at least one keep value.'));
        } else if (Retention) {
            Retention.validate(formRetention(f)).forEach((p) => {
                const code = (p.detail && p.detail.code) || 'invalid';
                if (code === 'delete-everything') return;   // reported above, in the form's own words
                out.push(problem('error', 'retention-' + code, 'retention', p.message));
            });
        }

        if (Schedule) {
            Schedule.validateCalendar(formCalendar(f)).forEach((p) => {
                const code = (p.detail && p.detail.code) || 'invalid';
                out.push(problem('error', 'schedule-' + code, 'calendar', p.message));
            });
        }

        // Hooks are shell by design, so only a NUL byte is rejected — it cannot
        // survive execve, and would truncate the command silently.
        [['preHook', 'pre-backup'], ['postHook', 'post-backup']].forEach((pair) => {
            if (str(f[pair[0]]).indexOf('\u0000') >= 0)
                out.push(problem('error', 'hook-nul', pair[0],
                    'The ' + pair[1] + ' hook contains a NUL byte.'));
        });

        return out;
    }

    function hasErrors(problems) {
        return (Array.isArray(problems) ? problems : []).some((p) => p && p.severity === 'error');
    }

    function problemsFor(problems, field) {
        return (Array.isArray(problems) ? problems : []).filter((p) => p && p.field === field);
    }

    // ------------------------------------------------------------ pure: progress

    const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

    function formatBytes(value) {
        const n = num(value);
        if (n === null || n < 0) return '';
        if (n < 1024) return Math.round(n) + ' B';
        let v = n;
        let i = 0;
        while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i += 1; }
        const rounded = Math.round(v * 10) / 10;
        return (rounded % 1 === 0 ? String(rounded) : rounded.toFixed(1)) + ' ' + UNITS[i];
    }

    // restic reports percent_done as a fraction. Returns null when the message
    // carries no usable percentage, so the caller can show an indeterminate bar
    // rather than a confident 0%.
    function progressPercent(status) {
        if (!isObj(status)) return null;
        const p = num(status.percent_done);
        if (p === null) return null;
        return Math.max(0, Math.min(100, Math.round(p * 100)));
    }

    function progressLabel(status) {
        if (!isObj(status)) return 'Starting…';
        const bits = [];

        const pct = progressPercent(status);
        if (pct !== null) bits.push(pct + '%');

        const filesDone = num(status.files_done);
        const totalFiles = num(status.total_files);
        if (filesDone !== null && filesDone >= 0) {
            bits.push(totalFiles !== null && totalFiles > 0
                ? filesDone + ' of ' + plural(totalFiles, 'file')
                : plural(filesDone, 'file'));
        }

        // formatBytes returns '' for a value it will not vouch for (negative, not a
        // number). Pushing that would leave a dangling separator in the line.
        const totalRaw = num(status.total_bytes);
        const bytesDone = formatBytes(status.bytes_done);
        const totalBytes = totalRaw !== null && totalRaw > 0 ? formatBytes(totalRaw) : '';
        if (bytesDone) bits.push(totalBytes ? bytesDone + ' of ' + totalBytes : bytesDone);

        if (!bits.length) return 'Starting…';
        return bits.join(' · ');
    }

    // A backup of / can hit tens of thousands of unreadable files. The list is
    // still the point, but rendering all of them freezes the UI thread, so it is
    // truncated with an explicit count rather than silently.
    const MAX_UNREADABLE = 200;

    // The same list arrives by three routes depending on where the run stopped:
    // on the summarised result, on the typed error, or inside that error's detail.
    function errorList(value) {
        if (Array.isArray(value)) return value;
        if (!isObj(value)) return [];
        if (Array.isArray(value.errors)) return value.errors;
        const detail = value.detail;
        if (Array.isArray(detail)) return detail;
        if (isObj(detail) && Array.isArray(detail.errors)) return detail.errors;
        return [];
    }

    // The files restic could not read (exit 3). Listing them is the whole point of
    // the READ_ERRORS remediation — "partial" without the list is unactionable.
    function unreadableFiles(result) {
        const errors = errorList(result);
        const out = [];
        for (let i = 0; i < errors.length && out.length < MAX_UNREADABLE; i++) {
            const e = errors[i];
            let text;
            if (!isObj(e)) {
                text = str(e);
            } else {
                const item = str(e.item);
                const message = str(e.message) || str(isObj(e.error) ? e.error.message : '');
                text = (item && message) ? item + ' — ' + message : (item || message || 'unknown error');
            }
            if (text !== '') out.push(text);
        }
        if (errors.length > MAX_UNREADABLE)
            out.push('… and ' + plural(errors.length - MAX_UNREADABLE, 'more file'));
        return out;
    }

    // restic exit 3 means the snapshot WAS written. Wherever a READ_ERRORS error
    // surfaces — resolved result, rejected promise, or a stored state marker — it
    // is a partial success and must never render as a failure.
    function kindOf(error) {
        const Errors = M('HangarErrors');
        if (!Errors || !Errors.isHangarError(error)) return '';
        return str(error.kind);
    }

    function isReadErrors(error) { return kindOf(error) === 'READ_ERRORS'; }

    // Cancelled is a neutral outcome, not a failure: the user asked for it.
    function isCancelled(error) { return kindOf(error) === 'CANCELLED'; }

    // -------------------------------------------------------------- pure: status

    function lastResultLabel(state) {
        if (!isObj(state)) return { tone: 'idle', text: 'Never run' };
        switch (str(state.status)) {
        case 'ok':
            return { tone: 'ok', text: 'Succeeded' };
        case 'partial':
            return {
                tone: 'partial',
                text: 'Partial — ' + plural(num(state.unreadable) || 0, 'file') + ' unreadable'
            };
        case 'prune-failed':
            return { tone: 'partial', text: 'Backed up, but thinning failed' };
        case 'failed': {
            const kind = str(state.kind);
            return { tone: 'failed', text: 'Failed' + (kind ? ' (' + kind + ')' : '') };
        }
        default:
            return { tone: 'idle', text: state.status ? str(state.status) : 'Never run' };
        }
    }

    function remediationLabel(remediation) {
        return REMEDIATION_LABELS[remediation] || '';
    }

    // Options for HangarRestic.run('backup', …) built from a stored job.
    function backupOpts(job, repoUrl, passwordFile) {
        const src = mergeFilesystemSources(job);
        const opts = {
            repoUrl: repoUrl,
            passwordFile: passwordFile,
            paths: src.paths,
            excludes: src.excludes,
            oneFileSystem: src.oneFileSystem,
            tags: src.tags
        };
        if (src.excludeFile.length) opts.excludeFile = src.excludeFile[0];
        return opts;
    }

    // ------------------------------------------------------------------- markup
    // index.html ships an empty #hangar-jobs, so the screen supplies its own
    // markup. Built as a string rather than a partial because boot.js only injects
    // the modal partials.

    const SCREEN = [
        '<div class="d-flex align-items-center gap-2 mb-3">',
        '  <h2 class="h5 mb-0 flex-grow-1">Backup jobs</h2>',
        '  <button type="button" class="btn btn-sm btn-outline-secondary" @click="reload()"',
        '          :disabled="loading">Refresh</button>',
        '  <button type="button" class="btn btn-sm btn-primary" @click="create()">Create job</button>',
        '</div>',

        '<template x-if="error">',
        '  <div class="alert alert-danger d-flex align-items-start gap-3">',
        '    <div class="flex-grow-1"><strong>Could not read the job list.</strong>',
        '      <div class="small" x-text="error.message"></div></div>',
        '    <button type="button" class="btn btn-sm btn-danger" @click="reload()">Try again</button>',
        '  </div>',
        '</template>',

        // Typed failures become an action, never a toast.
        '<template x-if="failure">',
        '  <div class="alert alert-danger d-flex align-items-start gap-3">',
        '    <div class="flex-grow-1">',
        '      <strong x-text="failure.title"></strong>',
        '      <div class="small" x-text="failure.message"></div>',
        '    </div>',
        '    <button type="button" class="btn btn-sm btn-danger" x-show="failure.remediation"',
        '            @click="applyRemediation()" :disabled="working"',
        '            x-text="remediationLabel(failure.remediation)"></button>',
        '    <button type="button" class="btn-close" @click="failure = null"',
        '            aria-label="Dismiss this error"></button>',
        '  </div>',
        '</template>',

        // A config file we could not read is a PARTIAL read, not a failed one: the
        // jobs that did load are listed as usual and the ones that did not are named
        // here, because "some of your jobs are invisible" is not something to infer
        // from a shorter table.
        '<template x-if="unreadable.length">',
        '  <div class="alert alert-warning">',
        '    <div class="d-flex align-items-start gap-3">',
        '      <div class="flex-grow-1">',
        '        <strong>Some configuration files could not be read.</strong>',
        '        <div class="small">Everything else on this page loaded normally. ',
        '          A job listed here is shown read-only until its file can be read again.</div>',
        '      </div>',
        '      <button type="button" class="btn-close" @click="unreadable = []"',
        '              aria-label="Dismiss this warning"></button>',
        '    </div>',
        '    <ul class="small hangar-mono mt-2 mb-0">',
        '      <template x-for="(f, i) in unreadable" :key="i"><li x-text="f"></li></template>',
        '    </ul>',
        '  </div>',
        '</template>',

        // restic exit 3: the snapshot WAS written. Warning, never failure.
        '<template x-if="partial">',
        '  <div class="alert alert-warning">',
        '    <div class="d-flex align-items-start gap-3">',
        '      <div class="flex-grow-1">',
        '        <strong>Backup finished — some files could not be read.</strong>',
        '        <div class="small">The snapshot was written and is safe to restore from.</div>',
        '      </div>',
        '      <button type="button" class="btn-close" @click="partial = null"',
        '              aria-label="Dismiss this warning"></button>',
        '    </div>',
        '    <ul class="small hangar-mono mt-2 mb-0">',
        '      <template x-for="(f, i) in partial.files" :key="i"><li x-text="f"></li></template>',
        '    </ul>',
        '    <div class="small mt-1" x-show="!partial.files.length">restic did not name the files.</div>',
        '    <div class="small mt-1" x-show="partial.message" x-text="partial.message"></div>',
        '  </div>',
        '</template>',

        '<template x-if="run">',
        '  <div class="card mb-3">',
        '    <div class="card-body py-2">',
        '      <div class="d-flex align-items-center gap-2">',
        '        <span class="hangar-dot running"></span>',
        '        <strong x-text="\'Backing up \' + run.jobId"></strong>',
        '        <span class="ms-auto small text-secondary" x-text="run.label"></span>',
        '      </div>',
        '      <div class="progress hangar-progress mt-2" role="progressbar"',
        '           :aria-valuenow="run.percent === null ? 0 : run.percent"',
        '           aria-valuemin="0" aria-valuemax="100" aria-label="Backup progress">',
        '        <div class="progress-bar" :class="run.percent === null ? \'progress-bar-striped progress-bar-animated\' : \'\'"',
        '             :style="\'width: \' + (run.percent === null ? 100 : run.percent) + \'%\'"></div>',
        '      </div>',
        '    </div>',
        '  </div>',
        '</template>',

        '<div x-show="loading" class="text-secondary small">Loading jobs…</div>',

        '<div x-show="!loading && !jobs.length" class="hangar-empty">',
        '  <p class="mb-2">No backup jobs yet.</p>',
        '  <button type="button" class="btn btn-sm btn-primary" @click="create()">Create the first job</button>',
        '</div>',

        '<div class="table-responsive" x-show="jobs.length">',
        '  <table class="table table-sm align-middle">',
        '    <thead><tr>',
        '      <th scope="col">Job</th>',
        '      <th scope="col">Repository</th>',
        '      <th scope="col">Schedule</th>',
        '      <th scope="col">Retention</th>',
        '      <th scope="col">Last result</th>',
        '      <th scope="col" class="text-end">Actions</th>',
        '    </tr></thead>',
        '    <tbody>',
        '      <template x-for="row in jobs" :key="row.id">',
        '        <tr>',
        '          <td>',
        // Decorative: the same state is spelled out in the "Last result" column, so
        // announcing the dot would only repeat it.
        '            <span class="hangar-dot" :class="dotClass(row)" aria-hidden="true"></span>',
        '            <span x-text="row.job.name || row.id"></span>',
        '            <span class="badge text-bg-warning ms-1" x-show="row.unreadable">Unreadable</span>',
        '            <div class="small text-secondary" x-text="describeSources(row)"></div>',
        '          </td>',
        '          <td x-text="repoLabel(row.job.repo)"></td>',
        '          <td>',
        '            <div x-text="describeSchedule(row)"></div>',
        '            <span class="badge" :class="row.job.enabled ? \'text-bg-success\' : \'text-bg-secondary\'"',
        '                  x-text="row.job.enabled ? \'Enabled\' : \'Disabled\'"></span>',
        '          </td>',
        '          <td class="small" x-text="describeRetention(row)"></td>',
        '          <td>',
        '            <div x-text="lastResult(row).text"></div>',
        '            <div class="small text-secondary" x-text="lastRunTime(row)"></div>',
        '          </td>',
        // Everything except Delete is disabled for a job whose definition failed to
        // load: editing one would save the empty form back over the real file.
        '          <td class="text-end text-nowrap">',
        '            <button type="button" class="btn btn-sm btn-outline-primary"',
        '                    @click="runNow(row)" :disabled="working || !!run || row.unreadable"',
        '                    :aria-label="\'Back up \' + row.id + \' now\'">Back up now</button>',
        '            <button type="button" class="btn btn-sm btn-outline-secondary ms-1"',
        '                    @click="edit(row)" :disabled="working || row.unreadable"',
        '                    :aria-label="\'Edit job \' + row.id">Edit</button>',
        '            <button type="button" class="btn btn-sm btn-outline-secondary ms-1"',
        '                    @click="toggle(row)" :disabled="working || row.unreadable"',
        '                    :aria-label="(row.job.enabled ? \'Disable job \' : \'Enable job \') + row.id"',
        '                    x-text="row.job.enabled ? \'Disable\' : \'Enable\'"></button>',
        '            <button type="button" class="btn btn-sm btn-outline-danger ms-1"',
        '                    @click="remove(row)" :disabled="working"',
        '                    :aria-label="\'Delete job \' + row.id">Delete</button>',
        '          </td>',
        '        </tr>',
        '      </template>',
        '    </tbody>',
        '  </table>',
        '</div>'
    ].join('\n');

    // ------------------------------------------------------------- DOM plumbing
    // Every DOM touch in this file goes through these. They no-op with no document
    // and no Bootstrap, which is what keeps the components constructible under node.

    function showModal(id) {
        const el = root.document && root.document.getElementById(id);
        if (!el || !root.bootstrap) return;
        root.bootstrap.Modal.getOrCreateInstance(el).show();
    }

    function hideModal(id) {
        const el = root.document && root.document.getElementById(id);
        if (!el || !root.bootstrap) return;
        root.bootstrap.Modal.getOrCreateInstance(el).hide();
    }

    function emit(name, detail) {
        if (!root.dispatchEvent || typeof root.CustomEvent !== 'function') return false;
        root.dispatchEvent(new root.CustomEvent(name, { detail: detail }));
        return true;
    }

    function mount() {
        const el = root.document && root.document.getElementById(CONTAINER_ID);
        // Idempotent, and never clobbers markup someone else already put there.
        if (!el || el.getAttribute('x-data') || el.innerHTML.trim() !== '') return;
        el.setAttribute('x-data', 'hangarJobsUi()');
        el.innerHTML = SCREEN;
    }

    // ---------------------------------------------------------- I/O (guarded)

    function hasCockpit() { return typeof cockpit !== 'undefined' && !!cockpit; }

    // core/config.js owns every path under /etc/hangar but has no delete or
    // raw-write primitive. The paths still come from the core modules, so the id
    // validation guard cannot be bypassed from here.
    function noCockpit() {
        return Promise.reject(err('GENERIC', 'cockpit is not available.'));
    }

    function writeFile(path, text) {
        if (!hasCockpit()) return noCockpit();
        // cockpit.file() itself throws when the superuser channel is already gone,
        // and every caller only ever .catch()es this.
        try {
            return Promise.resolve(cockpit.file(path, { superuser: 'require' }).replace(text));
        } catch (e) {
            return Promise.reject(e);
        }
    }

    function removeFile(path) {
        if (!hasCockpit()) return noCockpit();
        try {
            return Promise.resolve(cockpit.file(path, { superuser: 'require' }).replace(null));
        } catch (e) {
            return Promise.reject(e);
        }
    }

    // ------------------------------------------------------------- the list UI

    function hangarJobsUi() {
        return {
            jobs: [],
            repos: [],
            loading: true,
            working: false,
            error: null,
            failure: null,
            partial: null,
            // Config files that could not be read this pass. A partial read is a
            // warning listing them, never a failure — the rest of the page is fine.
            unreadable: [],
            run: null,

            async init() {
                await this.reload();
            },

            // ---- reading ------------------------------------------------

            async reload() {
                const Config = M('HangarConfig');
                this.loading = true;
                this.error = null;
                try {
                    if (!Config) throw new Error('The configuration module is not loaded.');
                    this.repos = await this.loadRepos();
                    const ids = await Config.listJobs();
                    const rows = [];
                    for (let i = 0; i < (Array.isArray(ids) ? ids.length : 0); i++)
                        rows.push(await this.loadJob(ids[i]));
                    this.jobs = rows;
                    this.unreadable = this.unreadablePaths();
                } catch (e) {
                    this.error = e;
                } finally {
                    this.loading = false;
                }
            },

            // Named by path, because "which file" is the only actionable part of
            // "could not read it".
            unreadablePaths() {
                const Config = M('HangarConfig');
                const out = [];
                function pathFor(kind, id) {
                    try {
                        return kind === 'repo' ? Config.repoPath(id) : Config.jobPath(id);
                    } catch (e) {
                        return kind + ' "' + str(id) + '"';
                    }
                }
                this.jobs.forEach((r) => { if (r && r.unreadable) out.push(pathFor('job', r.id)); });
                this.repos.forEach((r) => { if (r && r.unreadable) out.push(pathFor('repo', r.id)); });
                return out;
            },

            async loadRepos() {
                const Config = M('HangarConfig');
                const out = [];
                let ids = [];
                try {
                    ids = await Config.listRepos();
                } catch (e) {
                    return out;
                }
                for (let i = 0; i < ids.length; i++) {
                    try {
                        const repo = await Config.readRepo(ids[i]);
                        if (repo) out.push(Object.assign({ id: ids[i] }, repo));
                    } catch (e) {
                        // One unreadable repository must not hide the others.
                        out.push({ id: ids[i], unreadable: true });
                    }
                }
                return out;
            },

            async loadJob(id) {
                const Config = M('HangarConfig');
                const Schedule = M('HangarSchedule');
                const row = { id: id, job: { id: id }, state: null, unit: null, unreadable: false };
                try {
                    const job = await Config.readJob(id);
                    // listJobs() saw the file, so nothing back means it vanished or
                    // holds something that is not a job object. Either way its real
                    // content is unknown, and pretending it is an empty job would let
                    // an edit overwrite it.
                    if (!isObj(job))
                        throw err('GENERIC', 'The job file is empty or is not a job definition.', { id: id });
                    row.job = Object.assign({ id: id }, job);
                } catch (e) {
                    row.unreadable = true;
                    row.error = e;
                }
                try {
                    row.state = await Config.readState(id);
                } catch (e) {
                    row.state = null;
                }
                try {
                    row.unit = Schedule.available() ? await Schedule.unitState(id) : null;
                } catch (e) {
                    row.unit = null;   // systemd not reachable is not a reason to hide the job
                }
                return row;
            },

            // ---- rendering ----------------------------------------------

            // Every renderer below is called by Alpine on each re-render, so none of
            // them may throw: an exception here blanks the whole screen, including
            // the error banner that would have explained it.

            repoLabel(id) {
                const repo = this.repos.filter((r) => r && r.id === id)[0];
                if (!repo) return str(id) ? str(id) + ' (missing)' : 'None';
                if (repo.unreadable) return str(repo.id) + ' (unreadable)';
                const Repos = M('HangarRepos');
                if (str(repo.name)) return str(repo.name);
                try {
                    return Repos ? Repos.describe(repo) : str(repo.id);
                } catch (e) {
                    return str(repo.id);
                }
            },

            describeSchedule(row) {
                const Schedule = M('HangarSchedule');
                const job = (row && row.job) || {};
                if (!Schedule) return '';
                try {
                    const calendars = Schedule.calendarsOf(job);
                    if (!calendars.length) return 'No schedule.';
                    return Schedule.describeSchedule(calendars[0]);
                } catch (e) {
                    return 'Not a valid schedule.';
                }
            },

            describeRetention(row) {
                const Retention = M('HangarRetention');
                if (!Retention) return '';
                try {
                    return Retention.describe(((row && row.job) || {}).retention);
                } catch (e) {
                    return '';
                }
            },

            describeSources(row) {
                const Sources = M('HangarSources');
                if (!Sources) return '';
                try {
                    return Sources.describe(mergeFilesystemSources(row && row.job));
                } catch (e) {
                    return '';
                }
            },

            lastResult(row) { return lastResultLabel(row && row.state); },

            lastRunTime(row) {
                const finished = row && row.state && num(row.state.finished);
                if (!finished) return '';
                // hangar-run writes seconds since the epoch. A value outside the range
                // Date can express renders as "Invalid Date", which tells nobody
                // anything — say nothing instead.
                const when = new Date(finished * 1000);
                if (isNaN(when.getTime())) return '';
                try {
                    return when.toLocaleString();
                } catch (e) {
                    return when.toISOString();
                }
            },

            dotClass(row) {
                if (this.run && row && this.run.jobId === row.id) return 'running';
                return lastResultLabel(row && row.state).tone;
            },

            remediationLabel: remediationLabel,

            // ---- editing ------------------------------------------------

            create() {
                this.openEditor(emptyForm());
            },

            edit(row) {
                // An unreadable job is shown read-only: opening the editor on the
                // empty form we fell back to would save that form over the real file.
                if (row && row.unreadable) {
                    this.failure = this.failureFor(row.job, null,
                        (row.error || err('GENERIC', 'This job could not be read.')), 'edit');
                    this.failure.title = 'This job cannot be edited';
                    return Promise.resolve(null);
                }
                return this.openEditor(jobToFormState(row && row.job));
            },

            openEditor(form) {
                const taken = this.jobs.map((r) => r.id);
                const repos = this.repos;
                const self = this;
                return new Promise((resolve) => {
                    if (!emit(EDIT_EVENT, { form: form, repos: repos, taken: taken, resolve: resolve }))
                        resolve(null);
                }).then((result) => (result ? self.save(result) : null));
            },

            async save(form) {
                const Config = M('HangarConfig');
                const Schedule = M('HangarSchedule');
                this.working = true;
                this.failure = null;
                try {
                    if (!Config || !Schedule) throw err('GENERIC', 'A required module is not loaded.');
                    const job = formStateToJob(form);
                    // Belt and braces: the modal will not submit an invalid form, but
                    // this is the last place before something reaches /etc.
                    if (hasErrors(validateForm(form)))
                        throw err('GENERIC', 'The job is not valid and was not saved.');

                    // Rendered before anything is written: core/schedule.js validates
                    // more strictly than the form does, and a job on disk with no
                    // timer is a backup that silently never runs.
                    const service = Schedule.renderService(job);
                    const timer = Schedule.renderTimer(job);

                    await Config.writeJob(job);
                    await writeFile(UNIT_DIR + '/' + Schedule.serviceUnit(job.id), service);
                    await writeFile(UNIT_DIR + '/' + Schedule.timerUnit(job.id), timer);
                    await Schedule.daemonReload();
                    if (job.enabled) {
                        await Schedule.enable(job.id);
                        await Schedule.start(job.id);
                    } else {
                        await Schedule.stop(job.id);
                        await Schedule.disable(job.id);
                    }
                } catch (e) {
                    this.failure = this.failureFor(form, null, e, 'save');
                    this.failure.title = 'The job was not saved';
                } finally {
                    this.working = false;
                }
                await this.reload();
            },

            async toggle(row) {
                const Config = M('HangarConfig');
                const Schedule = M('HangarSchedule');
                const job = Object.assign({}, (row && row.job) || {});
                const enable = !job.enabled;
                this.working = true;
                this.failure = null;
                try {
                    if (!Config || !Schedule) throw err('GENERIC', 'A required module is not loaded.');
                    job.enabled = enable;
                    await Config.writeJob(job);
                    if (enable) {
                        await Schedule.enable(job.id);
                        await Schedule.start(job.id);
                    } else {
                        await Schedule.stop(job.id);
                        await Schedule.disable(job.id);
                    }
                } catch (e) {
                    this.failure = this.failureFor(job, null, e, 'toggle');
                    this.failure.title = (enable ? 'Could not enable "' : 'Could not disable "') +
                        (job.name || job.id) + '"';
                } finally {
                    this.working = false;
                }
                await this.reload();
            },

            async remove(row) {
                const Dialogs = M('HangarDialogs');
                const Config = M('HangarConfig');
                const Schedule = M('HangarSchedule');
                const job = (row && row.job) || {};
                const id = (row && row.id) || job.id;

                // Deleting without asking is not an option, so a missing dialog module
                // stops the delete rather than skipping the confirmation.
                if (!Dialogs) {
                    this.failure = this.failureFor(job, null,
                        err('GENERIC', 'The confirmation dialog is unavailable, so nothing was deleted.'),
                        'delete');
                    this.failure.title = 'Could not confirm the deletion';
                    return;
                }
                try {
                    await Dialogs.confirmDialog({
                        title: 'Delete backup job?',
                        message: 'Delete the job "' + (job.name || str(id)) + '".',
                        // Said plainly: deleting a job is not deleting its backups.
                        detail: 'Snapshots already in the repository are kept. Only the ' +
                            'schedule and this job definition are removed.',
                        danger: true,
                        confirmLabel: 'Delete job'
                    });
                } catch (e) {
                    // A dialog that failed to open is not consent.
                    this.failure = this.failureFor(job, null, e, 'delete');
                    this.failure.title = 'Could not confirm the deletion';
                    return;
                }

                this.working = true;
                this.failure = null;
                try {
                    if (!Config || !Schedule) throw err('GENERIC', 'A required module is not loaded.');
                    try {
                        await Schedule.stop(id);
                        await Schedule.disable(id);
                    } catch (e) {
                        // A job whose units were never written still has to be deletable.
                    }
                    // The job definition goes first: it is what makes the job exist, and
                    // a leftover unit file must never be able to block the delete. The
                    // units are already stopped and disabled by this point, so nothing
                    // fires in the window between the two.
                    await removeFile(Config.jobPath(id));
                    await removeFile(UNIT_DIR + '/' + Schedule.timerUnit(id));
                    await removeFile(UNIT_DIR + '/' + Schedule.serviceUnit(id));
                    await Schedule.daemonReload();
                } catch (e) {
                    this.failure = this.failureFor(job, null, e, 'delete');
                    this.failure.title = 'The job was not fully deleted';
                } finally {
                    this.working = false;
                }
                await this.reload();
            },

            // ---- running ------------------------------------------------

            runNow(row) {
                return this.startBackup(row.job);
            },

            async startBackup(job) {
                const Restic = M('HangarRestic');
                const Repos = M('HangarRepos');
                const Secrets = M('HangarSecrets');
                const Errors = M('HangarErrors');

                const repo = this.repos.filter((r) => r.id === job.repo)[0];
                if (!repo) {
                    this.failure = {
                        jobId: job.id, repoId: job.repo,
                        title: 'Repository not found',
                        message: 'The job points at repository "' + job.repo + '", which no longer exists.',
                        remediation: null
                    };
                    return;
                }

                this.failure = null;
                this.partial = null;
                this.working = true;
                this.run = { jobId: job.id, percent: null, label: 'Starting…' };

                try {
                    const opts = backupOpts(job, Repos.buildUrl(repo), Secrets.keyPath(repo.id));
                    const self = this;
                    const result = await Restic.run('backup', opts, (status) => {
                        // restic emits a status line several times a second; assigning
                        // two scalars keeps Alpine's re-render cheap.
                        self.run.percent = progressPercent(status);
                        self.run.label = progressLabel(status);
                    });

                    if (result.status === 'partial') {
                        this.partial = { jobId: job.id, files: unreadableFiles(result) };
                    } else if (result.status === 'failed') {
                        const err = result.error || Errors.create('GENERIC', 'The backup failed.');
                        this.failure = this.failureFor(job, repo, err);
                    }
                } catch (e) {
                    this.failure = this.failureFor(job, repo, e);
                } finally {
                    this.run = null;
                    this.working = false;
                }
                await this.reload();
            },

            failureFor(job, repo, error) {
                const Errors = M('HangarErrors');
                return {
                    jobId: job.id,
                    repoId: repo ? repo.id : job.repo,
                    title: 'Backup of "' + (job.name || job.id) + '" did not complete',
                    message: (error && error.message) || String(error),
                    remediation: Errors.remediationFor(error),
                    error: error
                };
            },

            async applyRemediation() {
                const f = this.failure;
                if (!f) return;
                const Restic = M('HangarRestic');
                const Repos = M('HangarRepos');
                const Secrets = M('HangarSecrets');
                const Dialogs = M('HangarDialogs');

                const repo = this.repos.filter((r) => r.id === f.repoId)[0];
                const row = this.jobs.filter((r) => r.id === f.jobId)[0];
                if (!repo || !row) { this.failure = null; return; }

                const opts = { repoUrl: Repos.buildUrl(repo), passwordFile: Secrets.keyPath(repo.id) };
                this.working = true;
                try {
                    switch (f.remediation) {
                    case 'unlock':
                        await Restic.run('unlock', opts);
                        break;
                    case 'init':
                        await Restic.run('init', opts);
                        break;
                    case 'reprompt': {
                        const password = Dialogs ? await Dialogs.passwordDialog({
                            title: 'Repository password',
                            repoLabel: repo.id
                        }) : '';
                        if (!password) { this.working = false; return; }
                        await Secrets.writeKey(repo.id, password);
                        break;
                    }
                    case 'list-unreadable':
                        this.partial = { jobId: f.jobId, files: unreadableFiles(f.error && f.error.detail) };
                        this.failure = null;
                        this.working = false;
                        return;
                    default:
                        break;      // 'free-space' and 'retry' just retry the backup
                    }
                } catch (e) {
                    this.failure = this.failureFor(row.job, repo, e);
                    this.working = false;
                    return;
                }
                this.working = false;
                this.failure = null;
                await this.startBackup(row.job);
            }
        };
    }

    // ------------------------------------------------------------ the editor UI

    function hangarJobEdit() {
        return {
            form: emptyForm(),
            repos: [],
            taken: [],
            problems: [],
            submitted: false,
            modes: SCHEDULE_MODES,
            _resolve: null,

            init() {
                if (!root.addEventListener) return;
                root.addEventListener(EDIT_EVENT, (ev) => {
                    const detail = (ev && ev.detail) || {};
                    this.form = isObj(detail.form) ? detail.form : emptyForm();
                    this.repos = Array.isArray(detail.repos) ? detail.repos : [];
                    this.taken = Array.isArray(detail.taken) ? detail.taken : [];
                    this.submitted = false;
                    this.problems = [];
                    this._resolve = detail.resolve || null;
                    showModal(MODAL_ID);
                });
            },

            presetNames() {
                const R = M('HangarRetention');
                return Object.keys(R.PRESETS).concat(['custom']);
            },

            presetLabel(name) {
                if (name === 'custom') return 'Custom';
                const R = M('HangarRetention');
                return name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, ' ') +
                    (name === R.DEFAULT_PRESET ? ' (recommended)' : '');
            },

            // Switching to Custom seeds the fields from the preset the user was
            // looking at, so "custom" starts as a tweak rather than a blank form.
            onPresetChange() {
                if (this.form.retentionPreset === 'custom' && !this.hasCustomValues())
                    this.form.retention = presetFields(defaultPreset());
                this.revalidate();
            },

            hasCustomValues() {
                const r = this.form.retention || {};
                return Object.keys(r).some((k) => str(r[k]).trim() !== '');
            },

            // ---- live explanation of the policy -------------------------

            retentionPolicy() { return formRetention(this.form); },

            retentionText() { return M('HangarRetention').describe(this.retentionPolicy()); },

            retentionEstimate() {
                const n = M('HangarRetention').estimateCount(this.retentionPolicy());
                if (!n) return '';
                // Upper bound, not a prediction — restic's buckets overlap.
                return 'At most about ' + plural(n, 'snapshot') + ' are kept.';
            },

            keepsNothing() { return keepsNothing(this.form); },

            scheduleText() {
                return M('HangarSchedule').describeSchedule(formCalendar(this.form));
            },

            calendarPreview() { return formCalendar(this.form); },

            // ---- validation ---------------------------------------------

            revalidate() {
                this.problems = validateForm(this.form, this.taken);
                return this.problems;
            },

            problemsFor(field) {
                return problemsFor(this.submitted ? this.problems : this.revalidate(), field);
            },

            messageFor(field) {
                const list = this.problemsFor(field);
                return list.length ? list[0].message : '';
            },

            invalid(field) {
                return this.problemsFor(field).some((p) => p.severity === 'error');
            },

            canSave() {
                return !hasErrors(this.revalidate());
            },

            submit() {
                this.submitted = true;
                if (hasErrors(this.revalidate())) return;
                const form = this.form;
                hideModal(MODAL_ID);
                if (this._resolve) this._resolve(form);
                this._resolve = null;
            },

            cancel() {
                if (this._resolve) this._resolve(null);
                this._resolve = null;
            }
        };
    }

    // Wiring, not logic: the screen mounts its own markup before Alpine walks the
    // DOM. Guarded so requiring this module under node --test does nothing at all.
    if (root.document && typeof root.document.addEventListener === 'function') {
        if (root.document.readyState === 'loading')
            root.document.addEventListener('DOMContentLoaded', mount);
        else mount();
    }

    const HangarJobsUi = {
        SCHEDULE_MODES, COUNT_FIELDS, REMEDIATION_LABELS, SCREEN,
        // pure
        emptyForm, presetFields, formRetention, presetNameFor, keepsNothing,
        formCalendar, scheduleModeFor, formSource, mergeFilesystemSources,
        formStateToJob, jobToFormState,
        validateForm, hasErrors, problemsFor,
        formatBytes, progressPercent, progressLabel, unreadableFiles,
        lastResultLabel, remediationLabel, backupOpts,
        splitLines, joinLines, splitTags, joinTags,
        // components
        hangarJobsUi, hangarJobEdit, mount
    };

    root.hangarJobsUi = hangarJobsUi;
    root.hangarJobEdit = hangarJobEdit;
    root.HangarJobsUi = HangarJobsUi;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarJobsUi;
})(typeof window !== 'undefined' ? window : globalThis);
