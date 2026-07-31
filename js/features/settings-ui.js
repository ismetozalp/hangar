// features/settings-ui.js — global settings, and the diagnostics a bug report needs.
//
// Two screens in one, deliberately. The settings themselves are three fields; on
// their own they would not justify a tab. But Settings is where a user goes when
// something is wrong, so this is also where hangar answers "what does this machine
// actually have installed?" in a form that can be pasted into an issue.
//
// Everything that decides an answer — validation, dirty detection, the diagnostics
// report — is a pure function at the top of the file. The Alpine component below
// only fetches state and hands it to them, which is what keeps this testable under
// `node --test` with no DOM and no cockpit.
'use strict';
(function (root) {
    // Browser: index.html has already put the core modules on the global. Node:
    // require them relative to this file so the pure functions stand alone.
    const req = (typeof require !== 'undefined' && typeof module !== 'undefined' && module.exports)
        ? require : null;

    const Errors = root.HangarErrors || (req ? req('../core/errors.js') : null);
    const Config = root.HangarConfig || (req ? req('../core/config.js') : null);
    const Prov = root.HangarProvision || (req ? req('../core/provision.js') : null);
    const Secrets = root.HangarSecrets || (req ? req('../core/secrets.js') : null);

    // ------------------------------------------------------------------ pure

    // The three settings a user may edit. `version` is in DEFAULT_GLOBAL too, but
    // it is a schema marker owned by core/config.js, not a preference.
    const EDITABLE = ['mountRoot', 'mountIdleTimeoutSec', 'notifyOnFailure',
        'updateRepo', 'updateCheckOnStartup'];

    // Bounds for the idle timeout, with reasons, because "absurd" has to mean
    // something specific to be testable:
    //   0        never unmount on idle — a legitimate choice, so it is allowed
    //   < 60s    unmounts while the user is still reading a directory listing
    //   > 24h    is not an idle timeout, it is a leak with extra steps
    const NEVER_IDLE = 0;
    const MIN_IDLE_SEC = 60;
    const MAX_IDLE_SEC = 86400;

    // Linux PATH_MAX. A longer mountRoot cannot be created, so rejecting it here
    // beats a mount failing three screens later with an errno.
    const MAX_PATH_LEN = 4096;

    // Written by `make install`; a plain one-line string, not JSON, which is why
    // core/config.js (JSON only) has no reader for it.
    const VERSION_PATH = (Config ? Config.CONF_DIR : '/etc/hangar') + '/installed-version';

    function str(v) {
        if (v === null || v === undefined) return '';
        try { return String(v); } catch (e) { return ''; }
    }

    function trimmed(v) { return str(v).trim(); }

    // ------------------------------------------------------- pure: validation

    // A number the user typed. Alpine hands back strings from a text input and
    // numbers from `x-model.number`, so both have to arrive at the same answer;
    // anything else (empty, blank, "abc", a boolean, an object) is not a number
    // and must not silently become 0.
    function toNumber(v) {
        if (typeof v === 'number') return isFinite(v) ? v : null;
        const s = trimmed(v);
        if (s === '') return null;
        const n = Number(s);
        return isFinite(n) ? n : null;
    }

    function pathProblems(value) {
        const problems = [];
        const path = trimmed(value);

        if (path === '') {
            problems.push('Mount folder is required.');
            return problems;
        }
        if (path.charAt(0) !== '/')
            problems.push('Mount folder must be an absolute path, starting with "/".');
        if (path === '/')
            problems.push('Mount folder cannot be "/" — snapshots are mounted in a subfolder of it.');
        if (path.length > MAX_PATH_LEN)
            problems.push('Mount folder is longer than ' + MAX_PATH_LEN + ' characters.');
        if (path.split('/').indexOf('..') >= 0)
            problems.push('Mount folder must not contain "..".');
        // A NUL or a newline in a path is either a paste accident or an attempt to
        // smuggle a second line into a unit file. Neither is a folder name.
        if (/[\x00-\x1f\x7f]/.test(path))
            problems.push('Mount folder must not contain control characters.');
        return problems;
    }

    function timeoutProblems(value) {
        const problems = [];
        const n = toNumber(value);

        if (n === null) {
            problems.push('Idle timeout must be a number of seconds.');
            return problems;
        }
        if (!Number.isInteger(n)) {
            problems.push('Idle timeout must be a whole number of seconds.');
            return problems;
        }
        if (n < 0) {
            problems.push('Idle timeout cannot be negative.');
            return problems;
        }
        if (n === NEVER_IDLE) return problems;   // explicit "never unmount"
        if (n < MIN_IDLE_SEC)
            problems.push('Idle timeout must be at least ' + MIN_IDLE_SEC +
                ' seconds, or 0 to never unmount automatically.');
        if (n > MAX_IDLE_SEC)
            problems.push('Idle timeout must be at most ' + MAX_IDLE_SEC +
                ' seconds (24 hours), or 0 to never unmount automatically.');
        return problems;
    }

    function notifyProblems(value) {
        // The checkbox can only produce a boolean; anything else came from a
        // hand-edited config.json, and guessing its truthiness would silently turn
        // "notifyOnFailure": "no" into notifications being on.
        if (typeof value === 'boolean') return [];
        return ['Notify on failure must be true or false.'];
    }

    // Empty is valid and is the default: with no repository set, hangar never
    // contacts GitHub at all. A non-empty value must be a real owner/name, since a
    // wrong one would silently never find an update.
    function updateRepoProblems(value) {
        const s = trimmed(value);
        if (s === '') return [];
        const Update = root.HangarUpdate ||
            (typeof require === 'function' ? require('../features/update.js') : null);
        if (Update && !Update.releasesApiUrl(s))
            return ['Update repository must be "owner/name" or a GitHub repository URL.'];
        return [];
    }

    function checkOnStartupProblems(value) {
        if (typeof value === 'boolean') return [];
        return ['Check for updates on startup must be true or false.'];
    }

    // Per-field problems, so the form can mark the field that is wrong rather than
    // showing one undifferentiated list.
    function fieldProblems(form) {
        const f = (form && typeof form === 'object') ? form : {};
        return {
            mountRoot: pathProblems(f.mountRoot),
            mountIdleTimeoutSec: timeoutProblems(f.mountIdleTimeoutSec),
            notifyOnFailure: notifyProblems(f.notifyOnFailure),
            updateRepo: updateRepoProblems(f.updateRepo),
            updateCheckOnStartup: checkOnStartupProblems(f.updateCheckOnStartup)
        };
    }

    // The flat list, in field order. Empty means the form can be saved.
    function validateSettings(form) {
        const byField = fieldProblems(form);
        return EDITABLE.reduce(function (out, name) {
            return out.concat(byField[name]);
        }, []);
    }

    // -------------------------------------------------------- pure: form state

    // Settings -> form. The timeout stays a number here; the input is type=number
    // and Alpine's x-model.number gives it back as one.
    function formFromSettings(settings) {
        const merged = Config ? Config.mergeGlobal(settings) : Object.assign({}, settings || {});
        return {
            mountRoot: str(merged.mountRoot),
            mountIdleTimeoutSec: merged.mountIdleTimeoutSec,
            notifyOnFailure: !!merged.notifyOnFailure,
            updateRepo: str(merged.updateRepo),
            updateCheckOnStartup: !!merged.updateCheckOnStartup
        };
    }

    // Form -> the object handed to writeGlobal. Coercion happens exactly once,
    // here, and only for a form that already passed validateSettings.
    function settingsFromForm(form) {
        const f = (form && typeof form === 'object') ? form : {};
        const n = toNumber(f.mountIdleTimeoutSec);
        return {
            mountRoot: trimmed(f.mountRoot),
            mountIdleTimeoutSec: n === null ? null : n,
            notifyOnFailure: !!f.notifyOnFailure,
            updateRepo: trimmed(f.updateRepo),
            updateCheckOnStartup: !!f.updateCheckOnStartup
        };
    }

    // ------------------------------------------------------- pure: dirty check

    // Field-by-field, because the fields disagree about what "the same" means.
    // Trailing whitespace in a path is not a change; "900" and 900 are not a change
    // either, since the same value survives a round trip through an input as a
    // string. Anything unparseable compares as raw text, so a half-typed number
    // still reads as dirty instead of collapsing to "unchanged".
    function sameValue(name, a, b) {
        if (name === 'notifyOnFailure' || name === 'updateCheckOnStartup') return !!a === !!b;
        if (name === 'mountIdleTimeoutSec') {
            const x = toNumber(a);
            const y = toNumber(b);
            if (x === null || y === null) return trimmed(a) === trimmed(b);
            return x === y;
        }
        return trimmed(a) === trimmed(b);
    }

    // Both sides fall back to the defaults for anything missing, so a form
    // compared against a config that was never written is dirty only where the
    // user actually changed something.
    function isDirty(form, saved) {
        const a = formFromSettings(form);
        const b = formFromSettings(saved);
        return EDITABLE.some(function (name) { return !sameValue(name, a[name], b[name]); });
    }

    function changedFields(form, saved) {
        const a = formFromSettings(form);
        const b = formFromSettings(saved);
        return EDITABLE.filter(function (name) { return !sameValue(name, a[name], b[name]); });
    }

    // -------------------------------------------------------- pure: diagnostics

    const UNKNOWN = 'unknown';

    // `make install` writes one line. Anything else — an empty file, a stray
    // newline, a whole changelog someone redirected in by accident — collapses to
    // the first non-empty line or to null, never to a lie.
    function parseVersionFile(text) {
        const lines = str(text).split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line !== '') return line.slice(0, 64);
        }
        return null;
    }

    function versionText(v) {
        if (!v) return '-';
        if (typeof v === 'string') return v.trim() || '-';
        if (Prov && typeof Prov.formatVersion === 'function') {
            try { return Prov.formatVersion(v); } catch (e) { return '-'; }
        }
        return '-';
    }

    // A tool banner is multi-line and can be long; one padded column per tool is
    // what makes the report skimmable in an issue comment.
    function bannerText(raw) {
        const one = str(raw).replace(/\s+/g, ' ').trim();
        if (one === '') return 'not installed';
        return one.length > 120 ? one.slice(0, 117) + '...' : one;
    }

    function toolStatus(probe) {
        if (!probe || typeof probe !== 'object') return 'unknown';
        if (!probe.present) return 'missing';
        return probe.ok ? 'ok' : 'too old';
    }

    // probeAll results -> table rows. Kept pure so the screen and the copyable
    // report render from exactly the same data.
    function toolRows(probes) {
        const list = Array.isArray(probes) ? probes : [];
        return list.filter(function (p) { return !!p && typeof p === 'object' && p.tool; })
            .map(function (p) {
                return {
                    tool: str(p.tool),
                    binary: str(p.binary),
                    optional: !!p.optional,
                    need: p.optional ? 'optional' : 'required',
                    present: !!p.present,
                    version: versionText(p.version),
                    status: toolStatus(p),
                    banner: bannerText(p.raw)
                };
            });
    }

    // Whether the Logbook can mount a snapshot, derived from the fuse3 probe
    // rather than by poking /dev/fuse: reading a character device from the browser
    // is not a probe, it is a hang.
    function fuseState(probes) {
        const rows = toolRows(probes);
        let fuse = null;
        for (let i = 0; i < rows.length; i++) if (rows[i].tool === 'fuse3') fuse = rows[i];

        if (!fuse)
            return { usable: false, label: UNKNOWN,
                detail: 'fuse3 was not checked, so hangar cannot say whether snapshots can be mounted.' };
        if (!fuse.present)
            return { usable: false, label: 'not available',
                detail: (fuse.binary || 'fusermount3') +
                    ' is not installed. The Logbook still works — it lists files instead of mounting them.' };
        if (fuse.status !== 'ok')
            return { usable: false, label: 'too old',
                detail: 'The installed FUSE is older than hangar needs. The Logbook falls back to listing files.' };
        return { usable: true, label: 'available',
            detail: 'Snapshots can be mounted and browsed as an ordinary file tree.' };
    }

    function pad(text, width) {
        const s = str(text);
        return s.length >= width ? s : s + ' '.repeat(width - s.length);
    }

    // The copyable bug report. Deliberately fixed-width plain text with no markup:
    // it is going into an issue, an email or a paste buffer, and it has to survive
    // all three. Snapshot-tested, so the shape cannot drift without a test failing.
    //
    // Only named fields are rendered — the whole `info` object is never dumped —
    // and the result is passed through the secrets redactor as a last line of
    // defence, because a user pastes this in public.
    function diagnosticsText(info) {
        const i = (info && typeof info === 'object') ? info : {};
        const lines = [];

        lines.push('hangar diagnostics');
        lines.push('==================');
        lines.push(pad('hangar version:', 22) + (trimmed(i.version) || UNKNOWN));
        lines.push(pad('distribution family:', 22) + (trimmed(i.family) || UNKNOWN));

        const fuse = (i.fuse && typeof i.fuse === 'object') ? i.fuse : fuseState(i.tools);
        lines.push(pad('FUSE:', 22) + fuse.label);
        lines.push(pad('generated:', 22) + (trimmed(i.generatedAt) || UNKNOWN));

        lines.push('');
        lines.push('tools');
        lines.push('-----');
        const rows = toolRows(i.tools);
        if (rows.length === 0) {
            lines.push('(no tools were probed)');
        } else {
            rows.forEach(function (r) {
                lines.push(pad(r.tool, 10) + pad(r.need, 10) + pad(r.version, 10) +
                    pad(r.status, 10) + r.banner);
            });
        }

        lines.push('');
        lines.push('settings');
        lines.push('--------');
        const s = (i.settings && typeof i.settings === 'object') ? formFromSettings(i.settings) : null;
        if (!s) {
            lines.push('(settings could not be read)');
        } else {
            lines.push(pad('mountRoot', 22) + s.mountRoot);
            lines.push(pad('mountIdleTimeoutSec', 22) + s.mountIdleTimeoutSec);
            lines.push(pad('notifyOnFailure', 22) + s.notifyOnFailure);
        }

        const notes = Array.isArray(i.notes)
            ? i.notes.map(trimmed).filter(function (n) { return n !== ''; }) : [];
        if (notes.length) {
            lines.push('');
            lines.push('notes');
            lines.push('-----');
            notes.forEach(function (n) { lines.push(n); });
        }

        const text = lines.join('\n') + '\n';
        return (Secrets && typeof Secrets.redact === 'function') ? Secrets.redact(text) : text;
    }

    // ---------------------------------------------------------- pure: labels

    const REMEDIATION_LABEL = {
        'unlock': 'Unlock repository',
        'reprompt': 'Enter the password again',
        'init': 'Initialise repository',
        'list-unreadable': 'Show unreadable files',
        'free-space': 'Show what to free',
        'retry': 'Try again'
    };

    function remediationLabel(r) { return REMEDIATION_LABEL[str(r)] || ''; }

    function errorText(e) {
        if (!e) return '';
        return str(e.message) || str(e);
    }

    // "900 seconds" means nothing at a glance; "15 minutes" does.
    function describeTimeout(value) {
        const n = toNumber(value);
        if (n === null || !Number.isInteger(n) || n < 0) return '';
        if (n === NEVER_IDLE) return 'Snapshots stay mounted until you unmount them.';
        if (n < 120) return 'Unmounts after ' + n + ' seconds of no activity.';
        if (n < 7200) return 'Unmounts after ' + Math.round(n / 60) + ' minutes of no activity.';
        const hours = n / 3600;
        const shown = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
        return 'Unmounts after ' + shown + ' hours of no activity.';
    }

    const STATUS_CLASS = {
        ok: 'text-bg-success',
        missing: 'text-bg-secondary',
        'too old': 'text-bg-warning',
        unknown: 'text-bg-secondary'
    };

    function statusClass(status) { return STATUS_CLASS[str(status)] || 'text-bg-secondary'; }

    // ------------------------------------------------------------- component

    function resolveDeps(deps) {
        const d = deps || {};
        return {
            errors: d.errors || Errors,
            config: d.config || Config,
            provision: d.provision || Prov,
            // Injected in tests; in the browser this reads /etc/hangar/installed-version.
            readVersion: d.readVersion || readInstalledVersion,
            now: d.now || function () { return new Date().toISOString(); },
            clipboard: d.clipboard || null
        };
    }

    // core/config.js reads JSON and only JSON, and this file is a bare version
    // string, so this is the one filesystem read the screen makes for itself. It
    // is world-readable, hence no superuser, and a missing file is an ordinary
    // "installed by hand" answer rather than an error.
    function readInstalledVersion() {
        if (typeof cockpit === 'undefined' || !cockpit || typeof cockpit.file !== 'function')
            return Promise.resolve(null);
        return cockpit.file(VERSION_PATH).read()
            .then(function (text) { return parseVersionFile(text); })
            .catch(function () { return null; });
    }

    function hangarSettingsUi(deps) {
        const D = resolveDeps(deps);

        return {
            loading: true,
            saving: false,
            saved: null,            // last known on-disk settings
            form: formFromSettings(null),
            error: null,            // load or save failure
            savedAt: null,          // set on a successful write, cleared on edit
            diag: null,             // gathered diagnostics
            diagLoading: false,
            copyState: '',          // '' | 'copied' | 'failed'

            // Pure helpers the template calls directly.
            remediationLabel: remediationLabel,
            errorText: errorText,
            describeTimeout: describeTimeout,
            statusClass: statusClass,

            async init() {
                await this.load();
                await this.loadDiagnostics();
            },

            async load() {
                this.loading = true;
                this.error = null;
                try {
                    const settings = await D.config.readGlobal();
                    this.saved = settings;
                    this.form = formFromSettings(settings);
                } catch (e) {
                    // Unreadable settings are not a dead screen: defaults still let
                    // the user see what hangar would use, and fix it.
                    this.error = e;
                    this.saved = formFromSettings(null);
                    this.form = formFromSettings(null);
                } finally {
                    this.loading = false;
                }
            },

            // --- derived -------------------------------------------------

            problems() { return validateSettings(this.form); },
            problemsFor(name) { return fieldProblems(this.form)[name] || []; },
            hasProblem(name) { return this.problemsFor(name).length > 0; },
            dirty() { return isDirty(this.form, this.saved); },
            changed() { return changedFields(this.form, this.saved); },
            canSave() { return !this.saving && this.dirty() && this.problems().length === 0; },
            canRevert() { return !this.saving && this.dirty(); },
            errorRemediation() { return this.error && D.errors ? D.errors.remediationFor(this.error) : null; },

            // --- actions -------------------------------------------------

            touched() {
                // The "Saved" confirmation belongs to the values that were saved,
                // not to the ones now in the form.
                this.savedAt = null;
                this.copyState = '';
            },

            async save() {
                if (this.problems().length) return false;
                if (this.saving) return false;
                this.saving = true;
                this.error = null;
                try {
                    const next = settingsFromForm(this.form);
                    await D.config.writeGlobal(next);
                    // Re-derive from mergeGlobal rather than trusting the form, so
                    // what the screen shows is what a reader of the file would get.
                    this.saved = D.config.mergeGlobal(next);
                    this.form = formFromSettings(this.saved);
                    this.savedAt = D.now();
                    // The report quotes the settings, so it is stale the moment
                    // they change.
                    if (this.diag) this.diag.settings = this.saved;
                    return true;
                } catch (e) {
                    this.error = e;
                    return false;
                } finally {
                    this.saving = false;
                }
            },

            revert() {
                this.form = formFromSettings(this.saved);
                this.savedAt = null;
            },

            // --- diagnostics ---------------------------------------------

            async loadDiagnostics() {
                this.diagLoading = true;
                this.copyState = '';
                const notes = [];
                const info = {
                    version: null, family: UNKNOWN, tools: [],
                    fuse: null, settings: this.saved, generatedAt: D.now(), notes: notes
                };

                try {
                    info.version = await D.readVersion();
                } catch (e) {
                    notes.push('The installed version could not be read.');
                }
                try {
                    info.family = await D.provision.detectFamilyLive();
                } catch (e) {
                    info.family = UNKNOWN;
                    notes.push('The distribution family could not be detected.');
                }
                try {
                    info.tools = await D.provision.probeAll();
                } catch (e) {
                    info.tools = [];
                    notes.push('Installed tools could not be probed: ' + errorText(e));
                }

                info.fuse = fuseState(info.tools);
                this.diag = info;
                this.diagLoading = false;
                return info;
            },

            tools() { return toolRows(this.diag && this.diag.tools); },
            fuse() { return (this.diag && this.diag.fuse) || fuseState([]); },
            report() { return diagnosticsText(this.diag); },

            // navigator.clipboard needs a secure context and a user gesture, and
            // has neither under node — so a failure sets a state the template
            // answers by telling the user to select the report themselves. The
            // text is on screen either way.
            async copyReport() {
                const clip = D.clipboard ||
                    (typeof navigator !== 'undefined' && navigator && navigator.clipboard) || null;
                if (!clip || typeof clip.writeText !== 'function') {
                    this.copyState = 'failed';
                    return false;
                }
                try {
                    await clip.writeText(this.report());
                    this.copyState = 'copied';
                    return true;
                } catch (e) {
                    this.copyState = 'failed';
                    return false;
                }
            }
        };
    }

    // ------------------------------------------------------------- template
    //
    // index.html ships #hangar-settings empty, so the screen brings its own markup.
    // A first-party constant string with no interpolation — same trust boundary as
    // boot.js injecting the modal partials.

    const TEMPLATE = [
        '<div x-data="hangarSettingsUi()" x-init="init()">',

        '  <div class="d-flex align-items-center gap-2 mb-3">',
        '    <h2 class="h6 mb-0">Settings</h2>',
        '    <span x-show="dirty()" class="badge text-bg-warning">Unsaved changes</span>',
        '    <span x-show="savedAt" class="badge text-bg-success">Saved</span>',
        '    <span class="flex-grow-1"></span>',
        '    <span x-show="loading" class="text-secondary small">Loading…</span>',
        '  </div>',

        '  <div x-show="error" class="alert alert-danger d-flex align-items-center gap-3">',
        '    <div class="flex-grow-1">',
        '      <strong>Settings could not be read or written.</strong>',
        '      <div class="small" x-text="errorText(error)"></div>',
        '    </div>',
        '    <button type="button" class="btn btn-sm btn-danger"',
        '            x-show="errorRemediation()"',
        '            @click="load()" x-text="remediationLabel(errorRemediation())"></button>',
        '  </div>',

        // --- the form ---------------------------------------------------
        '  <form class="mb-4" style="max-width: 44rem" @submit.prevent="save()">',

        '    <div class="mb-3">',
        '      <label class="form-label" for="hangar-mount-root">Snapshot mount folder</label>',
        '      <input class="form-control" id="hangar-mount-root" type="text"',
        '             x-model="form.mountRoot" @input="touched()"',
        '             :class="hasProblem(\'mountRoot\') ? \'is-invalid\' : \'\'"',
        '             :aria-invalid="hasProblem(\'mountRoot\') ? \'true\' : \'false\'"',
        '             aria-describedby="hangar-mount-root-help">',
        '      <div class="form-text" id="hangar-mount-root-help">',
        '        Where the Logbook mounts a snapshot while you browse it. One subfolder',
        '        per repository is created underneath, and removed again on unmount.',
        '      </div>',
        '      <template x-for="p in problemsFor(\'mountRoot\')" :key="p">',
        '        <div class="invalid-feedback d-block" x-text="p"></div>',
        '      </template>',
        '    </div>',

        '    <div class="mb-3">',
        '      <label class="form-label" for="hangar-idle-timeout">Unmount after (seconds)</label>',
        '      <input class="form-control" id="hangar-idle-timeout" type="number"',
        '             min="0" step="1" x-model.number="form.mountIdleTimeoutSec" @input="touched()"',
        '             :class="hasProblem(\'mountIdleTimeoutSec\') ? \'is-invalid\' : \'\'"',
        '             :aria-invalid="hasProblem(\'mountIdleTimeoutSec\') ? \'true\' : \'false\'"',
        '             aria-describedby="hangar-idle-timeout-help">',
        '      <div class="form-text" id="hangar-idle-timeout-help">',
        '        <span x-text="describeTimeout(form.mountIdleTimeoutSec)"></span>',
        '        Use 0 to keep snapshots mounted until you unmount them.',
        '      </div>',
        '      <template x-for="p in problemsFor(\'mountIdleTimeoutSec\')" :key="p">',
        '        <div class="invalid-feedback d-block" x-text="p"></div>',
        '      </template>',
        '    </div>',

        '    <div class="form-check mb-3">',
        '      <input class="form-check-input" id="hangar-notify" type="checkbox"',
        '             x-model="form.notifyOnFailure" @change="touched()"',
        '             aria-describedby="hangar-notify-help">',
        '      <label class="form-check-label" for="hangar-notify">Report failed backups</label>',
        '      <div class="form-text" id="hangar-notify-help">',
        '        A failed run always lands in the journal. With this on, hangar also',
        '        raises it where the desktop can show it.',
        '      </div>',
        '      <template x-for="p in problemsFor(\'notifyOnFailure\')" :key="p">',
        '        <div class="invalid-feedback d-block" x-text="p"></div>',
        '      </template>',
        '    </div>',

        // --- updates ------------------------------------------------------
        // Left empty by default: with no repository set, hangar makes no outbound
        // requests of its own, which is the right default for a server tool.
        '    <div class="mb-3">',
        '      <label class="form-label" for="hangar-update-repo">Update repository</label>',
        '      <input class="form-control form-control-sm" id="hangar-update-repo" type="text"',
        '             placeholder="owner/name" spellcheck="false" autocomplete="off"',
        '             x-model="form.updateRepo" @input="touched()"',
        '             :class="hasProblem(\'updateRepo\') ? \'is-invalid\' : \'\'"',
        '             :aria-invalid="hasProblem(\'updateRepo\') ? \'true\' : \'false\'"',
        '             aria-describedby="hangar-update-repo-help">',
        '      <div class="form-text" id="hangar-update-repo-help">',
        '        The GitHub repository hangar checks for new releases. Leave empty to',
        '        disable update checks entirely — hangar will not contact GitHub at all.',
        '      </div>',
        '      <template x-for="p in problemsFor(\'updateRepo\')" :key="p">',
        '        <div class="invalid-feedback d-block" x-text="p"></div>',
        '      </template>',
        '    </div>',

        '    <div class="form-check mb-3">',
        '      <input class="form-check-input" id="hangar-update-startup" type="checkbox"',
        '             x-model="form.updateCheckOnStartup" @change="touched()"',
        '             :disabled="!form.updateRepo"',
        '             aria-describedby="hangar-update-startup-help">',
        '      <label class="form-check-label" for="hangar-update-startup">',
        '        Check for updates when the page opens</label>',
        '      <div class="form-text" id="hangar-update-startup-help">',
        '        Only checks; it never installs anything without you confirming.',
        '      </div>',
        '      <template x-for="p in problemsFor(\'updateCheckOnStartup\')" :key="p">',
        '        <div class="invalid-feedback d-block" x-text="p"></div>',
        '      </template>',
        '    </div>',

        '    <div class="d-flex align-items-center gap-2">',
        '      <button type="submit" class="btn btn-primary btn-sm" :disabled="!canSave()">Save</button>',
        '      <button type="button" class="btn btn-outline-secondary btn-sm"',
        '              :disabled="!canRevert()" @click="revert()">Discard changes</button>',
        '      <span x-show="saving" class="text-secondary small">Saving…</span>',
        '    </div>',
        '  </form>',

        // --- diagnostics --------------------------------------------------
        '  <section aria-labelledby="hangar-diagnostics-title">',
        '    <div class="d-flex align-items-center gap-2 mb-2">',
        '      <h3 class="h6 mb-0" id="hangar-diagnostics-title">Diagnostics</h3>',
        '      <span x-show="diagLoading" class="text-secondary small">Checking…</span>',
        '      <span class="flex-grow-1"></span>',
        '      <button type="button" class="btn btn-sm btn-outline-secondary"',
        '              @click="loadDiagnostics()" :disabled="diagLoading">Re-check</button>',
        '      <button type="button" class="btn btn-sm btn-outline-secondary"',
        '              @click="copyReport()">Copy for a bug report</button>',
        '    </div>',

        '    <div x-show="copyState === \'copied\'" class="text-success small mb-2" role="status">',
        '      Copied to the clipboard.</div>',
        '    <div x-show="copyState === \'failed\'" class="text-warning-emphasis small mb-2" role="status">',
        '      This browser would not let hangar use the clipboard — select the report below and copy it.</div>',

        '    <dl class="row mb-3 small">',
        '      <dt class="col-sm-3">Hangar version</dt>',
        '      <dd class="col-sm-9 hangar-mono" x-text="(diag && diag.version) || \'unknown\'"></dd>',
        '      <dt class="col-sm-3">Distribution family</dt>',
        '      <dd class="col-sm-9 hangar-mono" x-text="(diag && diag.family) || \'unknown\'"></dd>',
        '      <dt class="col-sm-3">FUSE</dt>',
        '      <dd class="col-sm-9">',
        '        <span x-text="fuse().label"></span>',
        '        <div class="text-secondary" x-text="fuse().detail"></div>',
        '      </dd>',
        '    </dl>',

        '    <div class="table-responsive mb-3">',
        '      <table class="table table-sm align-middle mb-0">',
        '        <thead><tr><th scope="col">Tool</th><th scope="col">Needed</th>',
        '          <th scope="col">Version</th><th scope="col">State</th>',
        '          <th scope="col">Reported</th></tr></thead>',
        '        <tbody>',
        '          <template x-for="t in tools()" :key="t.tool">',
        '            <tr>',
        '              <th scope="row" class="fw-normal hangar-mono" x-text="t.tool"></th>',
        '              <td class="text-secondary" x-text="t.need"></td>',
        '              <td class="hangar-mono" x-text="t.version"></td>',
        '              <td><span class="badge" :class="statusClass(t.status)" x-text="t.status"></span></td>',
        '              <td class="text-secondary small" x-text="t.banner"></td>',
        '            </tr>',
        '          </template>',
        '        </tbody>',
        '      </table>',
        '    </div>',

        '    <label class="form-label small" for="hangar-diagnostics-report">Plain-text report</label>',
        '    <pre class="hangar-rawlog mb-0" id="hangar-diagnostics-report" tabindex="0"',
        '         x-text="report()"></pre>',
        '  </section>',
        '</div>'
    ].join('\n');

    // Guarded so the module still loads under node with no DOM. index.html parses
    // the feature scripts while the document is still 'loading', and boot.js only
    // fetches Alpine once its partials resolve — so this always lands first.
    function mount(doc) {
        const d = doc || root.document || null;
        if (!d || typeof d.getElementById !== 'function') return false;
        const host = d.getElementById('hangar-settings');
        if (!host || host.getAttribute('data-hangar-mounted')) return false;
        host.setAttribute('data-hangar-mounted', '1');
        host.insertAdjacentHTML('beforeend', TEMPLATE);
        return true;
    }

    if (root.document && typeof root.addEventListener === 'function') {
        if (root.document.readyState === 'loading')
            root.addEventListener('DOMContentLoaded', function () { mount(); });
        else mount();
    }

    root.hangarSettingsUi = hangarSettingsUi;

    const HangarSettingsUi = {
        EDITABLE, NEVER_IDLE, MIN_IDLE_SEC, MAX_IDLE_SEC, MAX_PATH_LEN, VERSION_PATH,
        REMEDIATION_LABEL, STATUS_CLASS, TEMPLATE,
        toNumber, pathProblems, timeoutProblems, notifyProblems,
        fieldProblems, validateSettings,
        formFromSettings, settingsFromForm,
        sameValue, isDirty, changedFields,
        parseVersionFile, versionText, bannerText, toolStatus, toolRows, fuseState,
        pad, diagnosticsText,
        remediationLabel, errorText, describeTimeout, statusClass,
        readInstalledVersion, mount, hangarSettingsUi
    };
    root.HangarSettingsUi = HangarSettingsUi;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarSettingsUi;
})(typeof window !== 'undefined' ? window : globalThis);
