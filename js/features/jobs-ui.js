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
        HangarSourcesContainer: '../core/sources-container.js',
        HangarSourcesLibvirt: '../core/sources-libvirt.js',
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

    // The only wording this screen owns about the source kinds: what to call them
    // in the chooser. Every option *inside* a kind's form — runtimes, consistency
    // modes, connection URIs, quiesce modes — is read from that kind's exported
    // table, so a mode added in core/ appears here without an edit.
    const SOURCE_KINDS = [
        {
            id: 'filesystem',
            label: 'Files and directories',
            description: 'Paths on this host, exactly as they are on disk.'
        },
        {
            id: 'container',
            label: 'Container volumes',
            description: 'Named podman or docker volumes, found by asking the runtime ' +
                'where they live.'
        },
        {
            id: 'libvirt',
            label: 'Virtual machines',
            description: 'Libvirt domain disk images, with the domain XML that makes ' +
                'them restorable as a VM.'
        }
    ];

    // Warnings whose subject is whether the backup will RESTORE, rather than
    // whether it will run. They are pulled out of the kind's problem list and
    // shown next to the mode picker instead of as grey helper text under a field:
    // a live copy of a running database is a backup that may not restore, and the
    // moment of choosing is the last moment anyone can say so.
    const RISK_CODES = [
        'live-database',            // container: mode 'none', and a container looks like a DB
        'quiesce-crash-consistent', // libvirt:   mode 'none'
        'quiesce-agent-required',   // libvirt:   mode 'agent', which needs a guest agent
        'no-xml',                   // libvirt:   disks without the XML are not a VM
        'no-user'                   // container: rootless podman with no owner recorded
    ];

    // Wording for each HangarErrors remediation. `null` (no remediation) shows no
    // button at all — the failure is still reported, just without a one-click fix.
    const REMEDIATION_LABELS = {
        unlock: 'Unlock repository',
        reprompt: 'Enter password',
        init: 'Initialise repository',
        'list-unreadable': 'Show unreadable files',
        'free-space': 'Try again after freeing space',
        // Not "try again": a destination whose sign-in has expired fails
        // identically on every retry, which is how a nightly job dies quietly.
        reauthorize: 'Sign in to the destination again',
        // Nothing hangar can do from inside the page: Cockpit's own header owns
        // the switch. The button explains where to look rather than pretending
        // to perform an escalation this page cannot perform.
        'grant-access': 'How to grant access',
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

    // Only a JSON number or a form string is a number. Everything else is refused
    // rather than coerced: Number([]) and Number(null) are both 0, i.e. a reading
    // the user never gave us, rendered as though restic had reported it.
    function num(v) {
        if (typeof v !== 'number' && typeof v !== 'string') return null;
        if (typeof v === 'string' && v.trim() === '') return null;
        const n = Number(v);
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

    function uniq(list) {
        const out = [];
        (Array.isArray(list) ? list : []).forEach((v) => { if (out.indexOf(v) < 0) out.push(v); });
        return out;
    }

    // ------------------------------------------------------- pure: source kinds

    // Requiring these modules is what registers their kinds into HangarSources —
    // index.html loads them in the browser, M() loads them under node. Called
    // before anything asks the registry a question, because an unregistered kind
    // answers "unknown source kind" instead of validating the form the user is
    // looking at.
    function ensureSourceKinds() {
        M('HangarSourcesContainer');
        M('HangarSourcesLibvirt');
        return M('HangarSources');
    }

    // Only kinds that actually registered are offered. A chooser entry whose
    // module failed to load would produce a form that can be filled in and then
    // refuses to save, which is worse than not offering it.
    function sourceKinds() {
        const S = ensureSourceKinds();
        const known = (S && typeof S.kinds === 'function') ? S.kinds() : ['filesystem'];
        return SOURCE_KINDS.filter((k) => known.indexOf(k.id) >= 0);
    }

    function sourceKindLabel(id) {
        const k = SOURCE_KINDS.filter((e) => e.id === str(id))[0];
        return k ? k.label : str(id);
    }

    function containerModule() { return M('HangarSourcesContainer'); }
    function libvirtModule() { return M('HangarSourcesLibvirt'); }

    function runtimeOptions() {
        const C = containerModule();
        return C && Array.isArray(C.RUNTIMES) ? C.RUNTIMES.slice() : [];
    }

    // Worst-to-best, in the table's own order: the ordering is itself the advice.
    function consistencyOptions() {
        const C = containerModule();
        if (!C || !Array.isArray(C.CONSISTENCY_IDS)) return [];
        return C.CONSISTENCY_IDS.map((id) => C.CONSISTENCY[id]).filter((m) => !!m);
    }

    function consistencyInfo(id) {
        return consistencyOptions().filter((m) => m.id === str(id))[0] || null;
    }

    function uriOptions() {
        const L = libvirtModule();
        return L && Array.isArray(L.URIS) ? L.URIS.slice() : [];
    }

    function quiesceOptions() {
        const L = libvirtModule();
        return L && Array.isArray(L.QUIESCE) ? L.QUIESCE.slice() : [];
    }

    function quiesceInfo(id) {
        return quiesceOptions().filter((m) => m.id === str(id))[0] || null;
    }

    function defaultRuntime() {
        const C = containerModule();
        return (C && str(C.DEFAULT_RUNTIME)) || '';
    }

    function defaultConsistency() {
        const C = containerModule();
        return (C && str(C.DEFAULT_CONSISTENCY)) || '';
    }

    function defaultUri() {
        const L = libvirtModule();
        return (L && str(L.DEFAULT_URI)) || '';
    }

    function defaultQuiesce() {
        const L = libvirtModule();
        return (L && str(L.DEFAULT_QUIESCE)) || '';
    }

    // ---------------------------------------------------------------- pure: form

    function emptyRetentionFields() {
        return { last: '', hourly: '', daily: '', weekly: '', monthly: '', yearly: '', within: '', tags: '' };
    }

    function defaultPreset() {
        const R = M('HangarRetention');
        return (R && R.DEFAULT_PRESET) || 'rolling';
    }

    // Discovered lists live on the component, not here: they are what the host
    // answered, not what the user chose, and saving them would freeze a moment in
    // time into /etc/hangar. The form holds only the choice, plus the free-text
    // fallback for when discovery cannot answer at all.
    function emptyContainerFields() {
        return {
            runtime: defaultRuntime(),
            user: '',
            volumes: [],
            volumesText: '',
            containers: [],
            containersText: '',
            consistency: defaultConsistency(),
            command: ''
        };
    }

    function emptyLibvirtFields() {
        return {
            uri: defaultUri(),
            domains: [],
            domainsText: '',
            quiesce: defaultQuiesce(),
            // On by default, and the one default in this form that is a data-safety
            // decision rather than a convenience: a disk image without its domain
            // XML restores as a file, not as a VM.
            includeXml: true
        };
    }

    function emptyForm() {
        return {
            isNew: true,
            id: '',
            name: '',
            repo: '',
            sourceId: 'main',
            sourceKind: 'filesystem',
            container: emptyContainerFields(),
            libvirt: emptyLibvirtFields(),
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

    // Ticked names plus typed names, in that order. Additive rather than
    // either/or: discovery is best effort, and a host where the runtime answers
    // for only some of the volumes — a second user's store, a runtime that is not
    // installed — must still be able to name the rest.
    function nameList(selected, text) {
        return uniq(splitLines(selected).concat(splitLines(text)));
    }

    // What the multi-select renders: everything discovery found, plus everything
    // already selected. A saved volume the runtime no longer reports still has to
    // appear — ticked, and flagged as not found — because dropping it from the
    // list would silently drop it from the backup on the next save.
    function checkboxList(discovered, selected) {
        const found = splitLines(discovered);
        return uniq(found.concat(splitLines(selected)))
            .map((name) => ({ name: name, discovered: found.indexOf(name) >= 0 }));
    }

    function sourceId(f) { return str(f.sourceId).trim() || 'main'; }

    // excludes and tags mean the same thing to restic whatever the kind is, so
    // they are one pair of form fields shared by all three source forms.
    function withSharedFields(source, f) {
        const excludes = splitLines(f.excludes);
        if (excludes.length) source.excludes = excludes;
        const tags = splitTags(f.tags);
        if (tags.length) source.tags = tags;
        return source;
    }

    function filesystemSource(f) {
        const source = {
            id: sourceId(f),
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

    function containerSource(f) {
        const c = isObj(f.container) ? f.container : {};
        const consistency = str(c.consistency) || defaultConsistency();
        const source = {
            id: sourceId(f),
            kind: 'container',
            runtime: str(c.runtime) || defaultRuntime(),
            user: str(c.user).trim(),
            volumes: nameList(c.volumes, c.volumesText),
            consistency: consistency,
            containers: nameList(c.containers, c.containersText)
        };
        // Only the mode that runs it keeps it. A command left behind by a mode the
        // user moved away from is a command hangar-run would not run and the user
        // would still believe in.
        if (consistency === 'command') source.command = str(c.command);
        return withSharedFields(source, f);
    }

    function libvirtSource(f) {
        const v = isObj(f.libvirt) ? f.libvirt : {};
        const source = {
            id: sourceId(f),
            kind: 'libvirt',
            uri: str(v.uri) || defaultUri(),
            domains: nameList(v.domains, v.domainsText),
            quiesce: str(v.quiesce) || defaultQuiesce(),
            // Written explicitly in both directions: normalize() reads an absent
            // includeXml as true, so omitting a false would silently turn the XML
            // back on between saving and running.
            includeXml: v.includeXml !== false
        };
        return withSharedFields(source, f);
    }

    function formSource(form) {
        const f = isObj(form) ? form : {};
        const kind = str(f.sourceKind);
        if (kind === 'container') return containerSource(f);
        if (kind === 'libvirt') return libvirtSource(f);
        return filesystemSource(f);
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

    function objectSources(job) {
        return (job && Array.isArray(job.sources) ? job.sources : []).filter(isObj);
    }

    // Which source the editor opens on. Filesystem wins whenever there is one, so
    // a v1 job edits in v2 exactly as it did in v1 — including the merge of
    // several filesystem sources into the single form the screen has always shown.
    function primaryKind(job) {
        const list = objectSources(job);
        if (list.some(isFilesystem)) return 'filesystem';
        const first = list.filter((s) => str(s.kind) === 'container' || str(s.kind) === 'libvirt')[0];
        return first ? str(first.kind) : 'filesystem';
    }

    function primarySource(job) {
        const kind = primaryKind(job);
        if (kind === 'filesystem') return mergeFilesystemSources(job);
        return objectSources(job).filter((s) => str(s.kind) === kind)[0] || mergeFilesystemSources(job);
    }

    // "Back up now" runs restic from the browser against a path list. A container
    // or VM source has no paths until the runtime or the hypervisor is asked, and
    // needs its containers paused or its guests frozen around the copy — which is
    // hangar-run's job, under the systemd unit's try/finally. So those jobs are
    // handed to the unit instead of being run here with an empty path vector.
    //
    // EVERY source, not the primary one. primaryKind() answers "which form does
    // the editor open", and it answers 'filesystem' whenever there is one — so a
    // job mixing files with volumes would run here against the file paths alone
    // and report a success for a snapshot that is missing the volumes.
    function runsInBrowser(job) {
        return objectSources(job).every(isFilesystem);
    }

    function containerFieldsFrom(source) {
        const s = isObj(source) ? source : {};
        const c = emptyContainerFields();
        c.runtime = str(s.runtime) || defaultRuntime();
        c.user = str(s.user);
        c.volumes = splitLines(s.volumes);
        c.containers = splitLines(s.containers);
        c.consistency = str(s.consistency) || defaultConsistency();
        c.command = str(s.command);
        return c;
    }

    function libvirtFieldsFrom(source) {
        const s = isObj(source) ? source : {};
        const v = emptyLibvirtFields();
        v.uri = str(s.uri) || defaultUri();
        v.domains = splitLines(s.domains);
        v.quiesce = str(s.quiesce) || defaultQuiesce();
        v.includeXml = s.includeXml !== false;
        return v;
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
        f.sourceKind = primaryKind(j);

        if (f.sourceKind === 'filesystem') {
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
        } else {
            const primary = primarySource(j);
            // Identity, not kind: a second container source is a source this screen
            // cannot show, and must survive the edit rather than be merged into the
            // one being edited — the two may name different runtimes or users.
            f.otherSources = sources.filter((s) => isObj(s) && s !== primary);
            f.sourceId = str(primary.id) || 'main';
            f.excludes = joinLines(splitLines(primary.excludes));
            f.tags = joinTags(splitTags(primary.tags));
            if (f.sourceKind === 'container') f.container = containerFieldsFrom(primary);
            else f.libvirt = libvirtFieldsFrom(primary);
        }

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
    // party's — so it is normalised rather than assumed to be a string. Anything
    // unrecognised lands on 'source', which is rendered too: an unattributed
    // problem must still be visible, just not next to the wrong field.
    function fieldForSourceProblem(raw) {
        const code = str(raw);
        if (code === 'no-paths' || code.indexOf('path-') === 0) return 'paths';
        if (code.indexOf('pattern-') === 0) return 'excludes';
        if (code.indexOf('exclude-file') === 0) return 'excludeFile';
        if (code.indexOf('tag-') === 0) return 'tags';

        // container
        if (code === 'no-volumes' || code.indexOf('volume-') === 0) return 'volumes';
        if (code === 'no-containers' || code.indexOf('container-') === 0) return 'containers';
        if (code === 'bad-runtime') return 'runtime';
        if (code === 'bad-user' || code === 'no-user') return 'user';
        if (code === 'no-command' || code.indexOf('command-') === 0) return 'command';
        if (code === 'bad-consistency' || code === 'live-database') return 'consistency';

        // libvirt
        if (code === 'no-domains' || code.indexOf('domain-') === 0) return 'domains';
        if (code === 'uri-empty') return 'uri';
        if (code.indexOf('quiesce-') === 0) return 'quiesce';
        if (code === 'no-xml') return 'includeXml';

        return 'source';
    }

    // The kind's own problem list for the form as it currently stands. Total: a
    // kind that throws while validating must not take the editor down with it,
    // because the editor is where the user would fix whatever upset it.
    function sourceProblems(form) {
        const Sources = ensureSourceKinds();
        if (!Sources) return [];
        try {
            const list = Sources.validate(formSource(form));
            return Array.isArray(list) ? list.filter(isObj) : [];
        } catch (e) {
            return [];
        }
    }

    function sourceWarnings(form) {
        return sourceProblems(form).filter((p) => p.severity !== 'error');
    }

    // The messages are the kind's, verbatim. hangar must not paraphrase a warning
    // about a backup that may not restore into something more comfortable — and a
    // second copy of the wording here would drift from the one core/ enforces.
    //
    // `key` exists because `code` is not unique: a source naming both a postgres
    // and a mongo container raises 'live-database' twice, and Alpine's x-for keeps
    // only the first row of any repeated :key — the user would be warned about one
    // database and told nothing about the other. The position is stable because the
    // list is rebuilt from the same validate() call on every render.
    function riskWarnings(form) {
        return sourceWarnings(form)
            .filter((p) => RISK_CODES.indexOf(str(p.code)) >= 0)
            .map((p, index) => ({
                key: str(p.code) + '#' + index,
                code: str(p.code),
                message: str(p.message)
            }));
    }

    // What the configured source actually does, in the kind's own sentence.
    function sourceDescription(form) {
        const Sources = ensureSourceKinds();
        if (!Sources) return '';
        try {
            return str(Sources.describe(formSource(form)));
        } catch (e) {
            return '';
        }
    }

    // `taken` is the list of ids that already exist; only a *new* job can collide.
    function validateForm(form, taken) {
        const f = isObj(form) ? form : {};
        const out = [];
        const Config = M('HangarConfig');
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

        // Through sourceProblems(), not the registry directly: this function is on
        // the render path (canSave/invalid/messageFor all call it), and the v2 seam
        // means the kind doing the validating may be a third party's. A kind that
        // throws — or that reports a list with a hole in it — must not blank the
        // editor the user would have fixed it from.
        sourceProblems(f).forEach((p) => {
            out.push(problem(p.severity, 'source-' + str(p.code),
                fieldForSourceProblem(p.code), str(p.message)));
        });

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

    // Identical to overview.js and logbook-ui.js; tests/smoke.mjs checks that.
    const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];

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

    // Short enough for a table cell, and the same vocabulary the Overview banner
    // uses — a user who reads both should not have to work out that they are the
    // same failure.
    const FAILURE_REASON = {
        GO_RUNTIME: 'restic crashed',
        REPO_MISSING: 'the repository does not exist yet',
        REPO_LOCKED: 'the repository is locked',
        WRONG_PASSWORD: 'the repository password was rejected',
        NO_SPACE: 'the destination is out of space',
        NETWORK: 'the repository could not be reached',
        AUTH_EXPIRED: 'the destination\'s sign-in has expired',
        CANCELLED: 'cancelled'
    };

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
            // The kind is an internal enum: "Failed (AUTH_EXPIRED)" tells a user
            // nothing they can act on, and the Overview already knows how to say
            // it in a sentence. Anything unrecognised falls back to plain
            // "Failed" rather than leaking the enum into the table.
            const kind = str(state.kind);
            const why = Object.prototype.hasOwnProperty.call(FAILURE_REASON, kind)
                ? FAILURE_REASON[kind] : '';
            return { tone: 'failed', text: 'Failed' + (why ? ' — ' + why : '') };
        }
        default:
            return { tone: 'idle', text: state.status ? str(state.status) : 'Never run' };
        }
    }

    // The banner headline per operation. Kept here, keyed by the same `op` the
    // remediation dispatch uses, so a failure can never be titled "Backup did not
    // complete" when what actually failed was a save.
    const FAILURE_TITLES = {
        backup: 'Backup of "{name}" did not complete',
        save: 'The job was not saved',
        toggle: 'The schedule for "{name}" was not changed',
        delete: 'The job "{name}" was not fully deleted',
        edit: 'The job "{name}" cannot be edited',
        confirm: 'Nothing was deleted: the confirmation could not be shown'
    };

    function failureTitle(op, name) {
        const key = Object.prototype.hasOwnProperty.call(FAILURE_TITLES, str(op)) ? str(op) : 'backup';
        return FAILURE_TITLES[key].replace('{name}', str(name) || 'this job');
    }

    // Own-property lookup only: REMEDIATION_LABELS['__proto__'] would otherwise
    // answer with Object.prototype, which is truthy — and would be rendered into
    // the action button as "[object Object]".
    function remediationLabel(remediation) {
        if (typeof remediation !== 'string') return '';
        return Object.prototype.hasOwnProperty.call(REMEDIATION_LABELS, remediation)
            ? REMEDIATION_LABELS[remediation] : '';
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

        // Only when the read succeeded — see repos-ui for why.
        '<div x-show="!loading && !jobs.length && !error" class="hangar-empty">',
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
        '            <div x-text="isRunning(row) ? \'Running now\' : lastResult(row).text"></div>',
        '            <div class="small text-secondary" x-text="lastRunTime(row)"></div>',
        '          </td>',
        // Everything except Delete is disabled for a job whose definition failed to
        // load: editing one would save the empty form back over the real file.
        '          <td class="text-end text-nowrap">',
        '            <button type="button" class="btn btn-sm btn-outline-primary"',
        '                    @click="runNow(row)" :disabled="working || isRunning(row) || row.unreadable"',
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

    // core/sources-container.js exports listVolumes() but no listContainers() —
    // only the argv builder and the parser, which is all this needs. Built the
    // same way that module builds its own: argv from the pure builder, one guarded
    // spawn, the pure parser on the way out. (parseVolumeNames is the shared
    // "one name per line" parser; `ps --format '{{.Names}}'` emits exactly that.)
    function listContainerNames(runtime, user) {
        const C = M('HangarSourcesContainer');
        if (!C) return Promise.resolve([]);
        let argv;
        try {
            argv = C.containerListArgv(runtime, user);
        } catch (e) {
            return Promise.reject(e);
        }
        if (!hasCockpit()) return Promise.resolve([]);
        try {
            return Promise.resolve(cockpit.spawn(argv, { superuser: 'require', err: 'message' }))
                .then(C.parseVolumeNames);
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
                this.watchRepos();
                await this.reload();
            },

            // ---- reading ------------------------------------------------

            // The button behind ADMIN_REQUIRED. hangar cannot flip Cockpit's own
            // switch from inside the page, so this asks the shell to re-check —
            // the user turns access on in the header, presses this, and the screen
            // reloads rather than the whole page.
            async grantAccess() {
                if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function')
                    root.dispatchEvent(new root.CustomEvent('hangar:recheck-access'));
                return this.reload();
            },

            // A repository added or removed anywhere invalidates this screen's copy.
            watchRepos() {
                if (typeof root.addEventListener !== 'function') return false;
                root.addEventListener('hangar:repos-changed', async () => {
                    try { this.repos = await this.loadRepos(); } catch (e) { /* keep the old list */ }
                });
                return true;
            },

            // A dashboard that is a photograph of page-load time is worse than no
            // dashboard: a backup ran for ten minutes while this screen said
            // "Not run yet". Polling is deliberately conditional — it runs only
            // while something IS running, and stops as soon as nothing is, so an
            // idle page makes no periodic calls at all. The final poll after a run
            // ends is what replaces "Running now" with the actual result.
            _watch: null,
            _watchMs: 0,
            WATCH_MS: 5000,

            // Idle screens still look, just rarely. Watching ONLY while a run is
            // in flight meant a run started anywhere else — the timer at 3am,
            // `systemctl start`, another browser tab — was invisible: the screen
            // kept whatever it last knew until somebody reloaded the page, and
            // said "Running" long after the run had finished.
            //
            // This costs a systemd unit-state read every 30 seconds. It reads no
            // repository and takes no restic lock, so an idle tab cannot get in
            // the way of a backup or its retention.
            IDLE_WATCH_MS: 30000,

            anyRunning() {
                return (this.jobs || []).some((r) => this.isRunning(r));
            },

            syncWatch() {
                const wanted = this.anyRunning() ? this.WATCH_MS : this.IDLE_WATCH_MS;
                // Idempotent, and it re-times itself when the pace should change:
                // repeated refreshes must not stack timers, and a finished run
                // must drop back to the slow cadence rather than keep polling
                // every five seconds for ever.
                if (this._watch && this._watchMs === wanted) return true;
                if (this._watch && root.clearInterval) root.clearInterval(this._watch);
                this._watch = null;
                this._watchMs = 0;
                if (!root.setInterval) return false;
                this._watch = root.setInterval(() => { this.reload(); }, wanted);
                // A browser has no unref and does not need one; node does, and
                // without it an idle screen's timer keeps a test runner alive
                // for ever. Guarded rather than assumed either way.
                if (this._watch && typeof this._watch.unref === 'function') this._watch.unref();
                this._watchMs = wanted;
                return true;
            },

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
                    this.syncWatch();
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
                for (let i = 0; i < (Array.isArray(ids) ? ids.length : 0); i++) {
                    try {
                        const repo = await Config.readRepo(ids[i]);
                        // Same reasoning as loadJob: listed but empty means its real
                        // definition is unknown, and a job pointing at it must not be
                        // backed up against a guess.
                        if (!isObj(repo)) throw err('GENERIC', 'The repository file is empty or malformed.');
                        out.push(Object.assign({ id: ids[i] }, repo));
                    } catch (e) {
                        // One unreadable repository must not hide the others.
                        out.push({ id: ids[i], unreadable: true, error: e });
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
                const Sources = ensureSourceKinds();
                if (!Sources) return '';
                try {
                    return Sources.describe(primarySource(row && row.job));
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

            // A backup started by the timer, by `systemctl start`, from the
            // Overview, or from another browser tab is still a backup. This screen
            // used to know only about runs IT had started, so a job that was
            // running right now showed "Never run" — while the Overview, reading
            // the same systemd state, correctly said "Running now".
            isRunning(row) {
                if (this.run && row && this.run.jobId === row.id) return true;
                const svc = row && row.unit && row.unit.service;
                return !!(svc && svc.active);
            },

            dotClass(row) {
                if (this.isRunning(row)) return 'running';
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
                    return Promise.resolve(null);
                }
                return this.openEditor(jobToFormState(row && row.job));
            },

            async openEditor(form) {
                const taken = this.jobs.map((r) => r.id);
                // Re-read rather than trusting the copy this screen loaded: a
                // repository created on another tab a moment ago is exactly the
                // one the user is here to select, and a stale list showed them a
                // dialog with nothing to choose. The event listener below usually
                // gets there first; this is the belt to its braces.
                try {
                    this.repos = await this.loadRepos();
                } catch (e) {
                    // Keep whatever we already had — an empty list then shows the
                    // guidance, which is still better than a failed dialog.
                }
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
                        'confirm');
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
                    this.failure = this.failureFor(job, null, e, 'confirm');
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
                } finally {
                    this.working = false;
                }
                await this.reload();
            },

            // ---- running ------------------------------------------------

            runNow(row) {
                return this.startBackup(row && row.job);
            },

            // Hands a container or VM job to its systemd unit. Nothing else can do
            // it correctly: the volume mount points are only knowable by asking the
            // runtime as the owning user, and the pause/freeze around the copy has
            // to be unwound in a try/finally that survives this page being closed.
            async startViaUnit(job) {
                const Schedule = M('HangarSchedule');
                const j = isObj(job) ? job : {};
                this.failure = null;
                this.partial = null;
                this.working = true;
                this.run = { jobId: j.id, percent: null, label: 'Handed to systemd…' };
                try {
                    if (!Schedule) throw err('GENERIC', 'A required module is not loaded.');
                    await Schedule.runNow(j.id);
                } catch (e) {
                    this.failure = this.failureFor(j, null, e, 'backup');
                } finally {
                    this.run = null;
                    this.working = false;
                }
                await this.reload();
            },

            async startBackup(job) {
                const Restic = M('HangarRestic');
                const Repos = M('HangarRepos');
                const Secrets = M('HangarSecrets');
                const j = isObj(job) ? job : {};

                if (!runsInBrowser(j)) return this.startViaUnit(j);

                const repo = this.repos.filter((r) => r && r.id === j.repo)[0];
                if (!repo || repo.unreadable) {
                    this.failure = {
                        jobId: j.id, repoId: j.repo, op: 'backup',
                        title: 'Repository not usable',
                        message: repo
                            ? 'The definition of repository "' + str(j.repo) + '" could not be read.'
                            : 'The job points at repository "' + str(j.repo) + '", which no longer exists.',
                        remediation: null,
                        error: null
                    };
                    return;
                }

                this.failure = null;
                this.partial = null;
                this.working = true;
                this.run = { jobId: j.id, percent: null, label: 'Starting…' };

                try {
                    if (!Restic || !Repos || !Secrets) throw err('GENERIC', 'A required module is not loaded.');
                    const opts = backupOpts(j, Repos.buildUrl(repo), Secrets.keyPath(repo.id));
                    const self = this;
                    const result = await Restic.run('backup', opts, (status) => {
                        // restic emits a status line several times a second; assigning
                        // two scalars keeps Alpine's re-render cheap. The run can have
                        // been cleared already if the channel closed mid-stream.
                        if (!self.run) return;
                        self.run.percent = progressPercent(status);
                        self.run.label = progressLabel(status);
                    });

                    const outcome = isObj(result) ? result : {};
                    const status = str(outcome.status);
                    if (status === 'partial' || isReadErrors(outcome.error)) {
                        // Exit 3: the snapshot exists. Warning listing what was missed.
                        this.partial = this.partialFor(j, outcome);
                    } else if (status === 'cancelled' || isCancelled(outcome.error)) {
                        this.partial = null;    // the user asked for it; neutral, not an error
                    } else if (status === 'failed') {
                        this.failure = this.failureFor(j, repo,
                            outcome.error || err('GENERIC', 'The backup failed.'), 'backup');
                    }
                } catch (e) {
                    // The engine only rejects with fatal errors, but a future engine or
                    // a callback fault must not turn a written snapshot into "failed".
                    if (isReadErrors(e)) this.partial = this.partialFor(j, e);
                    else if (!isCancelled(e)) this.failure = this.failureFor(j, repo, e, 'backup');
                } finally {
                    this.run = null;
                    this.working = false;
                }
                await this.reload();
            },

            // A partial is a SUCCESS with a list attached, so it always carries the
            // list — and says so plainly when restic named nothing.
            partialFor(job, source) {
                const j = isObj(job) ? job : {};
                const files = unreadableFiles(source);
                const error = isObj(source) && source.error ? source.error : source;
                return {
                    jobId: j.id,
                    files: files,
                    message: files.length ? '' : str(error && error.message)
                };
            },

            failureFor(job, repo, error, op) {
                const Errors = M('HangarErrors');
                const j = isObj(job) ? job : {};
                const message = str(error && error.message);
                return {
                    jobId: j.id,
                    repoId: repo ? repo.id : j.repo,
                    op: op || 'backup',
                    title: failureTitle(op, j.name || j.id),
                    message: message || str(error) || 'The reason was not reported.',
                    remediation: (Errors && Errors.remediationFor(error)) || null,
                    error: error
                };
            },

            async applyRemediation() {
                const f = this.failure;
                if (!f || !f.remediation) return;
                const Restic = M('HangarRestic');
                const Repos = M('HangarRepos');
                const Secrets = M('HangarSecrets');
                const Dialogs = M('HangarDialogs');

                // Listing the unreadable files needs no repository at all, so it is
                // answered before anything that could fail.
                if (f.remediation === 'list-unreadable') {
                    this.partial = this.partialFor({ id: f.jobId }, f.error);
                    this.failure = null;
                    return;
                }

                const repo = this.repos.filter((r) => r && r.id === f.repoId)[0];
                const row = this.jobs.filter((r) => r && r.id === f.jobId)[0];
                // Silently clearing the banner would look like the fix worked.
                if (!repo) {
                    this.failure = Object.assign({}, f, {
                        title: 'That repository is no longer configured',
                        message: 'Repository "' + str(f.repoId) + '" is gone, so "' +
                            remediationLabel(f.remediation).toLowerCase() + '" cannot run.',
                        remediation: null
                    });
                    return;
                }

                this.working = true;
                try {
                    if (!Restic || !Repos || !Secrets) throw err('GENERIC', 'A required module is not loaded.');
                    // buildUrl and keyPath both throw on a repository definition that
                    // no longer validates, and that has to become the banner, not an
                    // unhandled rejection out of a click handler.
                    const opts = { repoUrl: Repos.buildUrl(repo), passwordFile: Secrets.keyPath(repo.id) };
                    switch (f.remediation) {
                    case 'unlock':
                        await Restic.run('unlock', opts);
                        break;
                    case 'init':
                        await Restic.run('init', opts);
                        break;
                    case 'reprompt': {
                        if (!Dialogs) throw err('GENERIC', 'The password dialog is unavailable.');
                        const password = await Dialogs.passwordDialog({
                            title: 'Repository password',
                            repoLabel: repo.id
                        });
                        if (!password) { this.working = false; return; }   // cancelled: leave the banner
                        await Secrets.writeKey(repo.id, password);
                        break;
                    }
                    case 'reauthorize':
                        // Nothing here can repair it: the OAuth flow needs the
                        // user's own browser, and it lives on the Repositories
                        // screen beside the destination it belongs to. Repeating
                        // the operation would fail exactly the same way, so the
                        // banner is left standing rather than cleared.
                        this.working = false;
                        return;
                    default:
                        break;      // 'free-space' and 'retry' just repeat the operation
                    }
                } catch (e) {
                    this.failure = this.failureFor((row && row.job) || { id: f.jobId }, repo, e, f.op);
                    this.working = false;
                    return;
                }
                this.working = false;
                this.failure = null;
                // Only a backup is safe to repeat unattended. A failed save or delete
                // is repeated by the user, from a list that now shows what is really
                // on disk.
                if (f.op === 'backup' && row) await this.startBackup(row.job);
                else await this.reload();
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
            // What the host answered, kept out of the form so it is never saved.
            discovered: { volumes: [], containers: [], domains: [] },
            // Per-list: 'idle' | 'busy' | 'ok' | 'empty' | 'failed', plus why.
            discovery: { volumes: null, containers: null, domains: null },
            // The manual fallback. Switched on by a failed or empty discovery, and
            // by the user, but never switched off automatically — a name someone
            // typed must not vanish because a later probe succeeded.
            manual: { volumes: false, containers: false, domains: false },
            _resolve: null,

            init() {
                if (!root.addEventListener) return;
                root.addEventListener(EDIT_EVENT, (ev) => {
                    const detail = (ev && ev.detail) || {};
                    // A second open while one is pending would strand the first
                    // caller's promise, and with it the save it was waiting to run.
                    if (this._resolve) this._resolve(null);
                    this.form = isObj(detail.form) ? detail.form : emptyForm();
                    this.repos = Array.isArray(detail.repos) ? detail.repos : [];
                    this.taken = Array.isArray(detail.taken) ? detail.taken : [];
                    this.submitted = false;
                    this.problems = [];
                    this.discovered = { volumes: [], containers: [], domains: [] };
                    this.discovery = { volumes: null, containers: null, domains: null };
                    this.manual = { volumes: false, containers: false, domains: false };
                    this._resolve = detail.resolve || null;
                    showModal(MODAL_ID);
                    this.discover();
                });
            },

            // ---- source kind ---------------------------------------------

            kinds() { return sourceKinds(); },
            kindLabel(id) { return sourceKindLabel(id); },

            kindDescription() {
                const k = SOURCE_KINDS.filter((e) => e.id === str(this.form.sourceKind))[0];
                return k ? k.description : '';
            },

            onKindChange() {
                this.discover();
                this.revalidate();
            },

            isKind(id) { return str(this.form.sourceKind) === id; },

            // ---- the option tables, read from the kinds themselves --------

            runtimes() { return runtimeOptions(); },
            consistencies() { return consistencyOptions(); },
            uris() { return uriOptions(); },
            quiesces() { return quiesceOptions(); },

            // The selected mode's own description, shown beside the picker rather
            // than behind a tooltip: the difference between these modes is the
            // difference between a backup that restores and one that does not.
            consistencyInfo() {
                return consistencyInfo((this.form.container || {}).consistency);
            },

            quiesceInfo() {
                return quiesceInfo((this.form.libvirt || {}).quiesce);
            },

            consistencyText() {
                const m = this.consistencyInfo();
                return m ? m.description : '';
            },

            quiesceText() {
                const m = this.quiesceInfo();
                return m ? m.description : '';
            },

            // 'high' | 'medium' | 'low' — only the container table carries a risk
            // rating, so libvirt falls back to the warning list to colour itself.
            consistencyRisk() {
                const m = this.consistencyInfo();
                return m && m.risk ? str(m.risk) : '';
            },

            // ---- the warnings that decide whether a backup restores --------

            warnings() { return riskWarnings(this.form); },
            hasWarnings() { return this.warnings().length > 0; },
            sourceText() { return sourceDescription(this.form); },

            // ---- discovery -------------------------------------------------

            volumeChoices() {
                return checkboxList(this.discovered.volumes, (this.form.container || {}).volumes);
            },

            containerChoices() {
                return checkboxList(this.discovered.containers, (this.form.container || {}).containers);
            },

            domainChoices() {
                return checkboxList(this.discovered.domains, (this.form.libvirt || {}).domains);
            },

            discoveryState(which) {
                const d = this.discovery[which];
                return d ? str(d.state) : 'idle';
            },

            discoveryMessage(which) {
                const d = this.discovery[which];
                return d ? str(d.message) : '';
            },

            // One place decides what a discovery result means, so an empty answer
            // and a failed one both end up offering the manual list.
            _settle(which, names, error) {
                const list = Array.isArray(names) ? names.filter((n) => typeof n === 'string') : [];
                this.discovered[which] = list;
                if (error) {
                    this.discovery[which] = {
                        state: 'failed',
                        message: str(error.message) || 'The host did not answer.'
                    };
                    this.manual[which] = true;
                    return;
                }
                this.discovery[which] = { state: list.length ? 'ok' : 'empty', message: '' };
                if (!list.length) this.manual[which] = true;
            },

            _probe(which, run) {
                this.discovery[which] = { state: 'busy', message: '' };
                let promise;
                try {
                    promise = run();
                } catch (e) {
                    this._settle(which, [], e);
                    return Promise.resolve();
                }
                return Promise.resolve(promise).then(
                    (names) => { this._settle(which, names, null); },
                    (e) => { this._settle(which, [], e || {}); }
                );
            },

            discover() {
                if (this.isKind('container')) return this.discoverContainerNames();
                if (this.isKind('libvirt')) return this.discoverDomains();
                return Promise.resolve();
            },

            discoverContainerNames() {
                const C = M('HangarSourcesContainer');
                const c = this.form.container || {};
                if (!C) return Promise.resolve();
                return Promise.all([
                    this._probe('volumes', () => C.listVolumes(c.runtime, c.user)),
                    this._probe('containers', () => listContainerNames(c.runtime, c.user))
                ]);
            },

            discoverDomains() {
                const L = M('HangarSourcesLibvirt');
                if (!L) return Promise.resolve();
                return this._probe('domains',
                    () => L.listDomains((this.form.libvirt || {}).uri));
            },

            // The runtime, the owning user and the connection URI all change which
            // store is being read, so each of them re-asks rather than leaving a
            // list from the previous one on screen.
            onRuntimeChange() {
                this.discoverContainerNames();
                this.revalidate();
            },

            onUriChange() {
                this.discoverDomains();
                this.revalidate();
            },

            useManual(which) {
                this.manual[which] = true;
            },

            // Custom is always offered: with no retention module loaded it is the
            // only honest option, since no preset can be named.
            presetNames() {
                const R = M('HangarRetention');
                return (R && R.PRESETS ? Object.keys(R.PRESETS) : []).concat(['custom']);
            },

            presetLabel(raw) {
                const name = str(raw);
                if (name === 'custom' || name === '') return 'Custom';
                const R = M('HangarRetention');
                return name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, ' ') +
                    (R && name === R.DEFAULT_PRESET ? ' (recommended)' : '');
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

            retentionText() {
                const R = M('HangarRetention');
                return R ? R.describe(this.retentionPolicy()) : '';
            },

            retentionEstimate() {
                const R = M('HangarRetention');
                const n = R ? R.estimateCount(this.retentionPolicy()) : 0;
                if (!n) return '';
                // Upper bound, not a prediction — restic's buckets overlap.
                return 'At most about ' + plural(n, 'snapshot') + ' are kept.';
            },

            keepsNothing() { return keepsNothing(this.form); },

            scheduleText() {
                const S = M('HangarSchedule');
                return S ? S.describeSchedule(formCalendar(this.form)) : '';
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
            // The shared folder/file picker. Two behaviours, deliberately:

            //   * a single-value field is REPLACED;

            //   * a multi-line field (one path per line) gets the choice APPENDED, because

            //     replacing a list of sources with one path would quietly discard the rest.

            // Cancelling changes nothing in either case.

            async browsePath(fieldKey, opts) {

                const D = root.HangarDialogs;

                if (!D || typeof D.pickPath !== 'function') return false;

                const o = opts || {};

                const multi = !!o.multi;

                const currentRaw = String((this.form && this.form[fieldKey]) || '');

                const lines = currentRaw.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);

                const picked = await D.pickPath({

                    mode: o.mode || 'dir',

                    title: o.title || '',

                    current: multi ? (lines[lines.length - 1] || '') : currentRaw.trim()

                });

                if (picked === null || picked === undefined) return false;

                if (!this.form) return false;

                if (!multi) { this.form[fieldKey] = picked; return true; }

                if (lines.indexOf(picked) < 0) lines.push(picked);

                this.form[fieldKey] = lines.join('\n');

                return true;

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
            },

            // Shown in place of an empty repository dropdown. The dialog closes
            // first: leaving a modal open behind the Repositories screen strands
            // the promise the caller is awaiting, and hides the screen the user
            // was just sent to.
            goCreateRepository() {
                this.cancel();
                hideModal(MODAL_ID);
                emit('hangar:go', { tab: 'repos' });
                emit('hangar:new-repository', {});
                return true;
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
        SOURCE_KINDS, RISK_CODES,
        // pure
        emptyForm, emptyContainerFields, emptyLibvirtFields,
        presetFields, formRetention, presetNameFor, keepsNothing,
        formCalendar, scheduleModeFor, formSource, mergeFilesystemSources,
        primaryKind, primarySource, runsInBrowser,
        nameList, checkboxList, fieldForSourceProblem,
        sourceKinds, sourceKindLabel, ensureSourceKinds,
        runtimeOptions, consistencyOptions, consistencyInfo,
        uriOptions, quiesceOptions, quiesceInfo,
        sourceProblems, sourceWarnings, riskWarnings, sourceDescription,
        formStateToJob, jobToFormState,
        validateForm, hasErrors, problemsFor, failureTitle, FAILURE_TITLES,
        formatBytes, progressPercent, progressLabel, unreadableFiles, MAX_UNREADABLE,
        isReadErrors, isCancelled,
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
