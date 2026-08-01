// features/recovery-ui.js — the Recovery screen: bare-metal disaster recovery.
//
// This screen carries a debt the rest of hangar does not. ReaR has no restic
// workflow; BACKUP=EXTERNAL is described by ReaR's own documentation as a last
// resort with no maintainer support. The UI says that once, plainly, and then
// offers the only thing that can actually answer it: a drill that boots the
// image we just built and reports whether recovery completed.
//
// Everything that decides *what* to say or *what argv to run* is a pure function
// down here; the component is the thin part that calls them. That is what makes
// the honesty testable rather than a paragraph someone can quietly soften.
'use strict';
(function (root) {
    const node = typeof module !== 'undefined' && module.exports;

    const Errors  = node ? require('../core/errors.js')  : root.HangarErrors;
    const Dr      = node ? require('../core/dr.js')      : root.HangarDr;
    const Config  = node ? require('../core/config.js')  : root.HangarConfig;
    const Repos   = node ? require('../core/repos.js')   : root.HangarRepos;
    const Secrets = node ? require('../core/secrets.js') : root.HangarSecrets;
    const Restic  = node ? require('../engine/restic.js'): root.HangarRestic;

    // ------------------------------------------------------------------ util

    // /etc/hangar/dr.json is JSON.parse output, and JSON can express an object
    // whose `toString` and `valueOf` are both null — String() on that throws
    // TypeError. Every value reaching this screen is untrusted, so an
    // unconvertible one becomes '' and is then rejected by core/dr.js as a typed
    // problem, never as a raw TypeError that blanks the whole screen.
    function str(v) {
        if (v === null || v === undefined) return '';
        try { return String(v); } catch (e) { return ''; }
    }
    function trim(v) { return str(v).trim(); }

    function splitLines(text) {
        const s = str(text).replace(/\r?\n$/, '');
        return s === '' ? [] : s.split(/\r?\n/);
    }

    // Textareas are the honest control for an unbounded list of absolute paths:
    // one per line, no separator that can appear inside a path.
    function splitList(text) {
        return splitLines(text).map(trim).filter(function (s) { return s !== ''; });
    }

    function joinList(list) {
        return Array.isArray(list) ? list.map(str).join('\n') : '';
    }

    function tailOf(lines, n) {
        return lines.slice(Math.max(0, lines.length - n)).join('\n');
    }

    // Clamped to the safe-integer range rather than merely truncated: String(1e21)
    // is "1e+21", and an argv element in exponent notation would make the "command
    // that will run" preview a lie about what virt-install actually receives.
    function intOr(v, fallback) {
        const n = Number(v);
        if (!Number.isFinite(n)) return fallback;
        const t = Math.trunc(n);
        if (t > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
        if (t < -Number.MAX_SAFE_INTEGER) return -Number.MAX_SAFE_INTEGER;
        return t;
    }

    // ------------------------------------------------------- the DR form

    const TEXT_FIELDS = ['repoId', 'repoUrl', 'repoKind', 'host', 'outputUrl',
                         'backupUrl', 'keyPath', 'isoDefault', 'isoPrefix', 'isoVolid'];

    // Fields that are only sent to core/dr.js when the user actually filled them
    // in, so an empty box means "use ReaR's/hangar's default" rather than "".
    const OPTIONAL_TEXT = ['host', 'outputUrl', 'backupUrl', 'keyPath',
                           'isoDefault', 'isoPrefix', 'isoVolid'];

    const LIST_FIELDS = ['backupPaths', 'excludes', 'extraCopyAsIs', 'extraRequiredProgs'];

    function defaultDrForm() {
        return {
            repoId: '',
            repoUrl: '',
            repoKind: 'local',
            host: '',
            outputUrl: '',
            backupUrl: '',
            keyPath: '',
            backupPaths: joinList(Dr.DEFAULT_BACKUP_PATHS),
            excludes: joinList(Dr.DEFAULT_EXCLUDES),
            extraCopyAsIs: '',
            extraRequiredProgs: '',
            isoDefault: 'boothd',
            isoPrefix: '',
            isoVolid: '',
            userInputTimeout: 30,
            useDhclient: true,
            keepBuildDir: false
        };
    }

    function drFormToConfig(form) {
        const f = Object.assign(defaultDrForm(), form || {});
        const cfg = {
            repoId: trim(f.repoId),
            repoUrl: trim(f.repoUrl),
            repoKind: trim(f.repoKind) || 'local',
            useDhclient: f.useDhclient !== false,
            keepBuildDir: f.keepBuildDir === true
        };

        OPTIONAL_TEXT.forEach(function (k) {
            const v = trim(f[k]);
            if (v !== '') cfg[k] = v;
        });

        LIST_FIELDS.forEach(function (k) {
            const list = splitList(f[k]);
            if (list.length) cfg[k] = list;
        });

        // A non-numeric timeout is passed through untouched rather than coerced to
        // 0: core/dr.js must be the one that rejects it, so the user sees the same
        // message whether the config came from this form or from disk.
        const t = trim(f.userInputTimeout);
        if (t !== '') cfg.userInputTimeout = /^-?\d+$/.test(t) ? Number(t) : f.userInputTimeout;

        return cfg;
    }

    function configToDrForm(cfg) {
        const f = defaultDrForm();
        if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return f;

        TEXT_FIELDS.forEach(function (k) {
            if (cfg[k] !== undefined && cfg[k] !== null) f[k] = str(cfg[k]);
        });

        // An absent list is an empty box, not the default list: the defaults are
        // only ever offered to a form that has never been saved.
        LIST_FIELDS.forEach(function (k) { f[k] = joinList(cfg[k]); });

        if (cfg.userInputTimeout !== undefined && cfg.userInputTimeout !== null)
            f.userInputTimeout = cfg.userInputTimeout;
        f.useDhclient = cfg.useDhclient !== false;
        f.keepBuildDir = cfg.keepBuildDir === true;

        return f;
    }

    // -------------------------------------------------------- phase labelling

    // Mapped from core/dr.js PHASES. A phase that arrives here without an entry is
    // reported as unmapped rather than given a plausible-sounding sentence — the
    // same rule that governs rawTail, applied one level up.
    const PHASE_LABELS = {
        idle:      'Waiting for Relax-and-Recover to start.',
        starting:  'Starting Relax-and-Recover.',
        layout:    'Recording the disk layout.',
        creating:  'Creating the rescue system.',
        rootfs:    'Building the rescue root filesystem.',
        copying:   'Copying files into the rescue system.',
        initramfs: 'Building the rescue initramfs.',
        iso:       'Making the ISO image.',
        done:      'Rescue image written.'
    };

    const UNRECOGNISED_LABEL =
        'hangar did not recognise this output. The raw log is shown below, unedited.';

    function clampPercent(v) {
        const n = Number(v);
        if (!Number.isFinite(n)) return 0;
        if (n < 0) return 0;
        if (n > 100) return 100;
        return n;
    }

    function phaseLabel(parsed) {
        const p = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
        const rawTail = typeof p.rawTail === 'string' ? p.rawTail : '';
        const errors = Array.isArray(p.errors) ? p.errors.map(str) : [];
        const hasErrors = errors.length > 0;
        const percent = clampPercent(p.percent);
        const phase = typeof p.phase === 'string' && p.phase !== '' ? p.phase : 'unknown';

        function out(o) {
            return Object.assign({
                phase: phase, percent: percent, label: '',
                recognised: true, unrecognised: false,
                errors: errors, hasErrors: hasErrors,
                rawTail: rawTail, showRaw: hasErrors
            }, o);
        }

        // Nothing to interpret yet is not the same as output we failed to
        // interpret; conflating them would cry wolf on every build's first frame.
        if (phase === 'unknown' && rawTail.trim() === '')
            return out({ phase: 'idle', percent: 0, label: PHASE_LABELS.idle });

        if (phase === 'unknown')
            return out({ label: UNRECOGNISED_LABEL, recognised: false, unrecognised: true, showRaw: true });

        if (!PHASE_LABELS[phase])
            return out({
                label: 'Relax-and-Recover reported a step hangar has no wording for: ' + phase + '.',
                recognised: false, unrecognised: true, showRaw: true
            });

        return out({ label: PHASE_LABELS[phase] });
    }

    // ------------------------------------------------------------- the drill

    const DRILL_DEFAULTS = {
        name: 'hangar-drill',
        memoryMb: 2048,
        vcpus: 2,
        diskGb: 20,
        diskDir: '/var/lib/libvirt/images',
        network: 'default',
        firmware: 'bios',
        timeoutMin: 30,
        remoteRepo: false,
        systemGb: 0,
        libvirt: true
    };

    const MIN_MEMORY_MB = 1024;
    const COMFORTABLE_MEMORY_MB = 2048;

    // Upper bounds exist so a typo (or a mangled stored value) is refused with a
    // sentence instead of being handed to virt-install, which would fail minutes
    // later with a message about the host that says nothing about the mistake.
    const MAX_MEMORY_MB = 1024 * 1024;      // 1 TiB
    const MAX_VCPUS = 512;
    const MAX_DISK_GB = 65536;              // 64 TiB
    const MAX_TIMEOUT_MIN = 1440;           // a drill that runs past a day is hung

    // The name reaches a libvirt domain name AND a qcow2 path, so it is narrowed
    // here rather than quoted at every use site.
    function drillName(v) {
        let n = trim(v).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-')
            .replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
        return n === '' ? DRILL_DEFAULTS.name : n;
    }

    const CTRL_RE = /[\x00-\x1f\x7f]/;

    function note(level, code, message) {
        return { level: level, code: code, message: message };
    }

    function drillPlan(iso, opts) {
        const o = Object.assign({}, DRILL_DEFAULTS, opts || {});
        const warnings = [];

        const name = drillName(o.name);
        const isoPath = trim(iso);
        const diskDir = trim(o.diskDir).replace(/\/+$/, '') || DRILL_DEFAULTS.diskDir;
        const diskPath = diskDir + '/' + name + '.qcow2';

        if (isoPath === '')
            warnings.push(note('error', 'no-iso',
                'Build the rescue image first — there is nothing to boot yet.'));
        else if (isoPath.charAt(0) !== '/')
            warnings.push(note('error', 'iso-relative',
                'The rescue image path must be absolute.'));
        else if (CTRL_RE.test(isoPath))
            warnings.push(note('error', 'iso-control',
                'The rescue image path contains a control character, so it is not the path ReaR wrote.'));

        // Relative here would resolve against whatever directory the bridge
        // happens to be in, which is not a place a 20 GB disk should appear.
        if (diskDir.charAt(0) !== '/' || CTRL_RE.test(diskDir))
            warnings.push(note('error', 'disk-dir',
                'The drill disk directory must be an absolute path with no control characters.'));

        // Absence of libvirt is a limit of this host, not a defect in the image.
        if (o.libvirt === false)
            warnings.push(note('error', 'no-libvirt',
                'libvirt is not available on this host, so the drill cannot run here. ' +
                'The rescue image itself is unaffected — boot it on other hardware, or ' +
                'copy it to a machine that has libvirt and run the drill there.'));

        const memoryMb = intOr(o.memoryMb, DRILL_DEFAULTS.memoryMb);
        if (memoryMb < MIN_MEMORY_MB)
            warnings.push(note('error', 'memory',
                'The rescue system needs at least ' + MIN_MEMORY_MB + ' MiB of memory to boot.'));
        else if (memoryMb > MAX_MEMORY_MB)
            warnings.push(note('error', 'memory-max',
                'A drill VM cannot be given more than ' + MAX_MEMORY_MB + ' MiB of memory.'));
        else if (memoryMb < COMFORTABLE_MEMORY_MB)
            warnings.push(note('warn', 'memory-low',
                'Below ' + COMFORTABLE_MEMORY_MB + ' MiB the rescue system often runs out of ' +
                'memory while unpacking its initramfs.'));

        const vcpus = intOr(o.vcpus, DRILL_DEFAULTS.vcpus);
        if (vcpus < 1)
            warnings.push(note('error', 'vcpus', 'The drill VM needs at least one virtual CPU.'));
        else if (vcpus > MAX_VCPUS)
            warnings.push(note('error', 'vcpus-max',
                'A drill VM cannot be given more than ' + MAX_VCPUS + ' virtual CPUs.'));

        const diskGb = intOr(o.diskGb, DRILL_DEFAULTS.diskGb);
        const systemGb = intOr(o.systemGb, 0);
        if (diskGb < 1)
            warnings.push(note('error', 'disk', 'The drill disk must be at least 1 GB.'));
        else if (diskGb > MAX_DISK_GB)
            warnings.push(note('error', 'disk-max',
                'The drill disk cannot be larger than ' + MAX_DISK_GB + ' GB.'));
        else if (systemGb > 0 && diskGb < systemGb)
            warnings.push(note('warn', 'disk-small',
                'The drill disk (' + diskGb + ' GB) is smaller than the system being recovered (' +
                systemGb + ' GB). Recovery will stop while recreating the disk layout, which ' +
                'tells you nothing about the backup.'));

        const network = trim(o.network) || DRILL_DEFAULTS.network;
        if (!/^[A-Za-z0-9._-]+$/.test(network))
            warnings.push(note('error', 'network-name',
                'A libvirt network name may only contain letters, digits, dots, dashes and ' +
                'underscores. Use "none" for no network at all.'));
        if (network === 'none' && o.remoteRepo === true)
            warnings.push(note('warn', 'no-network',
                'The repository is not on this machine and the drill VM has no network, so the ' +
                'restore step cannot reach it.'));

        const firmware = o.firmware === 'uefi' ? 'uefi' : 'bios';
        const timeoutMin = Math.min(MAX_TIMEOUT_MIN,
            Math.max(1, intOr(o.timeoutMin, DRILL_DEFAULTS.timeoutMin)));

        const argv = ['virt-install',
            '--name', name,
            '--memory', String(memoryMb),
            '--vcpus', String(vcpus),
            '--disk', 'path=' + diskPath + ',size=' + diskGb + ',format=qcow2,sparse=yes',
            '--cdrom', isoPath,
            '--os-variant', 'generic',
            // No graphics means virt-install attaches the serial console to stdout,
            // which is the only way the drill can report what the rescue system did.
            '--graphics', 'none',
            '--console', 'pty,target_type=serial',
            // The drill is finished the moment recovery reports; letting the VM
            // reboot into the recovered system proves nothing extra and costs time.
            '--noreboot',
            '--wait', String(timeoutMin)];

        if (network === 'none') argv.push('--network', 'none');
        else argv.push('--network', 'network=' + network);
        if (firmware === 'uefi') argv.push('--boot', 'uefi');

        return {
            name: name,
            iso: isoPath,
            diskPath: diskPath,
            memoryMb: memoryMb,
            vcpus: vcpus,
            diskGb: diskGb,
            network: network,
            firmware: firmware,
            timeoutMin: timeoutMin,
            argv: argv,
            // Throwaway means throwaway: the disk goes with the domain, always.
            cleanup: [
                ['virsh', 'destroy', name],
                ['virsh', 'undefine', '--nvram', '--remove-all-storage', name]
            ],
            warnings: warnings,
            ok: !warnings.some(function (w) { return w.level === 'error'; })
        };
    }

    // Decisive markers only, same discipline as core/dr.js: a line hangar does not
    // recognise leaves the outcome inconclusive rather than being read as success.
    const DRILL_MARKERS = [
        { re: /^Finished recovering your system/i,        outcome: 'recovered' },
        { re: /^Recovery is not possible/i,               outcome: 'failed' },
        { re: /^(?:ERROR|BUG):/,                          outcome: 'failed' },
        { re: /Relax-and-Recover .*Rescue image/i,        outcome: 'booted' },
        { re: /^Welcome to Relax-and-Recover/i,           outcome: 'booted' }
    ];

    const DRILL_OUTCOMES = ['inconclusive', 'booted', 'recovered', 'failed'];

    const DRILL_LABELS = {
        inconclusive: 'The drill produced no output hangar recognises. Read the console log below before drawing any conclusion.',
        booted:       'The rescue image booted, but recovery never reported completion.',
        recovered:    'Recovery completed in the drill VM.',
        failed:       'Recovery failed in the drill VM.'
    };

    function drillOutcome(text) {
        const lines = splitLines(text);
        let outcome = 'inconclusive';
        let evidence = null;

        lines.forEach(function (raw) {
            const line = raw.trim();
            for (let i = 0; i < DRILL_MARKERS.length; i++) {
                if (!DRILL_MARKERS[i].re.test(line)) continue;
                const found = DRILL_MARKERS[i].outcome;
                // "booted" is a prelude, never a verdict: it must not overwrite a
                // decisive line that was printed earlier in the same run.
                if (found === 'booted' && (outcome === 'recovered' || outcome === 'failed')) return;
                outcome = found;
                evidence = line;
                return;
            }
        });

        return {
            outcome: outcome,
            decisive: outcome === 'recovered' || outcome === 'failed',
            label: DRILL_LABELS[outcome],
            evidence: evidence,
            rawTail: tailOf(lines, Dr.TAIL_LINES)
        };
    }

    // ------------------------------------------------------------ remediation

    // Wording for the six remediations core/errors.js can return. Kept here rather
    // than inline in the template so a kind that gains a remediation cannot ship a
    // button with no label.
    const REMEDIATION_LABELS = {
        'unlock':          'Unlock repository',
        'reprompt':        'Re-enter repository password',
        'init':            'Initialise repository',
        'list-unreadable': 'Show unreadable files',
        'free-space':      'Show what is using the space',
        'reauthorize':     'Sign in to the destination again',
        'retry':           'Try again'
    };

    function remediationLabel(err) {
        const r = Errors.remediationFor(err);
        return r ? (REMEDIATION_LABELS[r] || 'Fix this') : '';
    }

    // A READ_ERRORS result is a partial success. The files are wherever the
    // producer put them; all three shapes are accepted so no caller has to
    // reshape a non-failure into one.
    function unreadableFrom(err) {
        const d = err && err.detail;
        if (Array.isArray(d)) return d.map(str);
        if (d && typeof d === 'object') {
            if (Array.isArray(d.errors)) return d.errors.map(str);
            if (Array.isArray(d.files)) return d.files.map(str);
        }
        return [];
    }

    // The one place that decides failure-versus-partial. Every catch on this
    // screen goes through it, because a READ_ERRORS rendered in the red box is
    // exactly the mistake that teaches an operator to ignore the red box.
    function routeError(err) {
        return isPartial(err)
            ? { error: null, partial: err }
            : { error: err || null, partial: null };
    }

    function isPartial(err) {
        return Errors.isHangarError(err) && err.kind === Errors.KIND.READ_ERRORS;
    }

    // ------------------------------------------------------------- component

    function hasCockpit() {
        return typeof cockpit !== 'undefined' && !!cockpit;
    }

    function drJsonPath() {
        return typeof Config.drPath === 'function'
            ? Config.drPath() : Config.CONF_DIR + '/dr.json';
    }

    function hangarRecoveryUi() {
        return {
            // --- configuration -------------------------------------------
            form: defaultDrForm(),
            repos: [],
            loading: true,
            saving: false,
            saved: false,
            showPreview: false,

            // --- build ---------------------------------------------------
            building: false,
            progress: phaseLabel(null),
            iso: null,
            error: null,
            partial: null,
            showUnreadable: true,
            notice: '',
            // Which action to repeat when the remediation is 'retry'. Retrying a
            // failed save by building an image would be a different operation
            // wearing the same button.
            lastAction: 'build',

            // --- drill ---------------------------------------------------
            libvirt: { checked: false, available: false, reason: '' },
            drillOpts: Object.assign({}, DRILL_DEFAULTS),
            drillRunning: false,
            drillLog: '',
            drillResult: null,
            drillError: null,
            drillCleaned: false,

            async init() {
                this.loading = true;
                try {
                    await this.loadRepos();
                    await this.loadConfig();
                } catch (e) {
                    this.setError(e);
                }
                this.loading = false;
                // Probed after the screen is usable: the drill is optional and its
                // absence must never delay configuring recovery. Not awaited, so it
                // must not be able to reject either.
                try {
                    await this.probeLibvirt();
                } catch (e) {
                    this.libvirt = { checked: true, available: false,
                        reason: 'hangar could not determine whether libvirt is usable here.' };
                }
            },

            // Single funnel for every caught failure on this screen. READ_ERRORS
            // lands in `partial` and is rendered as a warning listing the files;
            // anything else lands in `error` and gets the remediation button.
            setError(e) {
                const routed = routeError(e);
                this.error = routed.error;
                this.partial = routed.partial;
                if (routed.partial) this.showUnreadable = true;
                return routed;
            },

            async loadRepos() {
                if (!hasCockpit()) return;
                const ids = await Config.listRepos();
                const out = [];
                for (const id of ids) {
                    try {
                        const repo = await Config.readRepo(id);
                        if (!repo) continue;
                        out.push({
                            id: id,
                            kind: str(repo.kind),
                            url: Repos.buildUrl(repo),
                            label: Repos.describe(repo)
                        });
                    } catch (e) {
                        // One unreadable repository definition must not hide the rest.
                        out.push({ id: id, kind: '', url: '', label: 'Could not read this repository definition.' });
                    }
                }
                this.repos = out;
            },

            async loadConfig() {
                if (!hasCockpit()) return;
                const stored = await Config.readJson(drJsonPath(), null);
                if (!stored) return;
                this.form = configToDrForm(stored);
                this.iso = stored.lastIso ? str(stored.lastIso) : null;
            },

            // --- derived -------------------------------------------------

            config() { return drFormToConfig(this.form); },

            problems() { return Dr.validate(this.config()); },

            valid() { return this.problems().length === 0; },

            preview() {
                try {
                    return Dr.renderLocalConf(this.config());
                } catch (e) {
                    return null;
                }
            },

            selectedRepo() {
                const id = trim(this.form.repoId);
                if (!Array.isArray(this.repos)) return null;
                return this.repos.find(function (r) { return r && r.id === id; }) || null;
            },

            remoteRepo() { return trim(this.form.repoKind) !== 'local'; },

            // Selecting a repository fills in everything derivable from it, but
            // leaves the fields editable — a DR repository is sometimes a
            // deliberately different URL from the one the jobs use.
            onRepoChange() {
                const repo = this.selectedRepo();
                if (!repo) return;
                this.form.repoUrl = repo.url;
                this.form.repoKind = repo.kind;
                try {
                    this.form.keyPath = Secrets.keyPath(repo.id);
                } catch (e) {
                    this.form.keyPath = '';
                }
                this.saved = false;
            },

            // --- writing -------------------------------------------------

            async save() {
                this.error = null;
                this.notice = '';
                this.saved = false;
                this.lastAction = 'save';
                if (!this.valid()) return false;
                this.saving = true;
                try {
                    const cfg = this.config();
                    await Dr.writeLocalConf(cfg);
                    await Config.writeJson(drJsonPath(),
                        Object.assign({}, cfg, { lastIso: this.iso || null }));
                    this.saved = true;
                    return true;
                } catch (e) {
                    this.setError(e);
                    return false;
                } finally {
                    this.saving = false;
                }
            },

            // --- building ------------------------------------------------

            async build() {
                this.error = null;
                this.partial = null;
                this.notice = '';
                this.drillResult = null;
                this.building = true;
                this.lastAction = 'build';
                this.progress = phaseLabel(null);
                try {
                    const res = await Dr.mkrescue((parsed) => { this.progress = phaseLabel(parsed); });
                    this.iso = (res && res.iso) || null;
                    this.progress = phaseLabel(res && res.log);
                    await this.rememberIso();
                    return res;
                } catch (e) {
                    // READ_ERRORS means the image exists and some files did not read.
                    // setError is what keeps that out of the failure box.
                    const routed = this.setError(e);
                    // A partial build still produced an image, and the path is the
                    // one thing the operator needs from it.
                    if (routed.partial && e.detail && typeof e.detail === 'object' && e.detail.iso)
                        this.iso = str(e.detail.iso);
                    // Whatever ReaR printed is still the best thing on screen, even
                    // when — especially when — hangar could not interpret it.
                    if (e && e.detail && typeof e.detail === 'object')
                        this.progress = phaseLabel(e.detail);
                    return null;
                } finally {
                    this.building = false;
                }
            },

            async rememberIso() {
                if (!hasCockpit() || !this.iso) return;
                try {
                    const stored = await Config.readJson(drJsonPath(), {});
                    await Config.writeJson(drJsonPath(),
                        Object.assign({}, stored || {}, { lastIso: this.iso }));
                } catch (e) {
                    // Losing the remembered path only costs a re-browse next visit.
                }
            },

            // Read from both slots. A READ_ERRORS should never reach `error`, but if
            // one ever does, losing the file list is the one outcome that would make
            // the warning unactionable.
            unreadable() {
                const list = unreadableFrom(this.partial);
                return list.length ? list : unreadableFrom(isPartial(this.error) ? this.error : null);
            },

            remediation() { return Errors.remediationFor(this.error); },

            remediationLabel() { return remediationLabel(this.error); },

            async applyRemediation() {
                const what = this.remediation();
                if (!what) return;
                this.notice = '';
                if (what === 'retry') {
                    this.error = null;
                    return this.lastAction === 'save' ? this.save() : this.build();
                }
                if (what === 'reprompt') return this.repromptPassword();
                if (what === 'unlock') return this.resticFix('unlock', 'The repository lock has been released.');
                if (what === 'init') return this.resticFix('init', 'The repository has been initialised.');
                // 'list-unreadable' and 'free-space' are informational: the detail is
                // already on screen, so the button only has to reveal it.
                this.showUnreadable = true;
                return null;
            },

            async repromptPassword() {
                const repoId = trim(this.form.repoId);
                if (!repoId || !root.HangarDialogs) return null;
                let pw;
                try {
                    pw = await root.HangarDialogs.passwordDialog({
                        title: 'Repository password',
                        repoLabel: repoId
                    });
                } catch (e) {
                    // A dismissed dialog is a decision, not a failure.
                    return null;
                }
                if (!pw) return null;
                try {
                    await Secrets.writeKey(repoId, pw);
                    this.error = null;
                    this.notice = 'The repository password has been stored. Try the operation again.';
                } catch (e) {
                    this.setError(e);
                }
                return null;
            },

            async resticFix(op, done) {
                try {
                    await Restic.run(op, {
                        repoUrl: trim(this.form.repoUrl),
                        passwordFile: trim(this.form.keyPath) || Secrets.keyPath(trim(this.form.repoId))
                    });
                    this.error = null;
                    this.notice = done || 'Done. Try the operation again.';
                } catch (e) {
                    this.setError(e);
                }
                return null;
            },

            // --- the drill -----------------------------------------------

            async probeLibvirt() {
                if (!hasCockpit() || typeof cockpit.spawn !== 'function') {
                    this.libvirt = { checked: true, available: false,
                        reason: 'This page has no connection to a host, so the drill cannot run.' };
                    return this.libvirt;
                }
                try {
                    await cockpit.spawn(['virt-install', '--version'], { superuser: 'try', err: 'message' });
                } catch (e) {
                    this.libvirt = { checked: true, available: false,
                        reason: 'virt-install is not installed on this host.' };
                    return this.libvirt;
                }
                try {
                    await cockpit.spawn(['virsh', '-c', 'qemu:///system', 'version'],
                        { superuser: 'require', err: 'message' });
                } catch (e) {
                    this.libvirt = { checked: true, available: false,
                        reason: 'libvirtd is not running, or its system connection is not reachable.' };
                    return this.libvirt;
                }
                this.libvirt = { checked: true, available: true, reason: '' };
                return this.libvirt;
            },

            plan() {
                return drillPlan(this.iso, Object.assign({}, this.drillOpts || {}, {
                    libvirt: !!(this.libvirt && this.libvirt.available),
                    remoteRepo: this.remoteRepo()
                }));
            },

            planCommand() { return this.plan().argv.join(' '); },

            async runDrill() {
                const plan = this.plan();
                this.drillError = null;
                this.drillResult = null;
                this.drillLog = '';
                this.drillCleaned = false;
                if (!plan.ok) return null;

                if (!hasCockpit() || typeof cockpit.spawn !== 'function') {
                    this.drillError = Errors.create(Errors.KIND.GENERIC,
                        'cockpit is not available in this context.');
                    return null;
                }

                this.drillRunning = true;
                try {
                    const proc = cockpit.spawn(plan.argv, { superuser: 'require', err: 'out' });
                    if (proc && typeof proc.stream === 'function') {
                        proc.stream((chunk) => {
                            // str(), not +=: a channel can hand back a Uint8Array, and
                            // "[object Uint8Array]" in the console log is worse than
                            // nothing because it looks like output.
                            this.drillLog += str(chunk);
                            this.drillResult = drillOutcome(this.drillLog);
                        });
                    }
                    const out = await proc;
                    this.drillLog = str(out) || this.drillLog;
                    this.drillResult = drillOutcome(this.drillLog);
                    return this.drillResult;
                } catch (e) {
                    // virt-install exiting non-zero is itself part of the answer, so
                    // the console is still parsed before the error is reported.
                    this.drillLog = this.drillLog || str(e && e.message);
                    this.drillResult = drillOutcome(this.drillLog);
                    this.drillError = Errors.isHangarError(e) ? e
                        : Errors.create(Errors.KIND.GENERIC, 'The drill VM could not be run.',
                            { error: str(e && e.message ? e.message : e) });
                    return this.drillResult;
                } finally {
                    this.drillRunning = false;
                    // Cleanup runs in a finally, so a throw here would replace the
                    // drill's verdict with a plumbing error. The verdict is the point.
                    try {
                        await this.cleanupDrill(plan);
                    } catch (e) { /* reported by drillCleaned staying false */ }
                }
            },

            // The drill's own failures get an action too, otherwise a NETWORK or
            // REPO_LOCKED surfacing through virt-install would be a dead-end alert.
            drillRemediation() { return Errors.remediationFor(this.drillError); },

            drillRemediationLabel() { return remediationLabel(this.drillError); },

            async applyDrillRemediation() {
                const what = this.drillRemediation();
                if (!what) return null;
                if (what === 'retry') { this.drillError = null; return this.runDrill(); }
                if (what === 'reprompt') return this.repromptPassword();
                if (what === 'unlock') return this.resticFix('unlock', 'The repository lock has been released.');
                if (what === 'init') return this.resticFix('init', 'The repository has been initialised.');
                return null;
            },

            // A drill that leaves a domain and a 20 GB disk behind is not a drill,
            // it is a mess. Failures here are ignored on purpose: `destroy` on an
            // already-stopped domain is an error and means nothing.
            async cleanupDrill(plan) {
                const p = plan || this.plan();
                if (!hasCockpit() || typeof cockpit.spawn !== 'function') return;
                const steps = Array.isArray(p && p.cleanup) ? p.cleanup : [];
                for (const argv of steps) {
                    try {
                        await cockpit.spawn(argv, { superuser: 'require', err: 'message' });
                    } catch (e) { /* nothing left to clean is the desired state */ }
                }
                this.drillCleaned = true;
            }
        };
    }

    const api = {
        // component
        hangarRecoveryUi,
        // pure
        defaultDrForm, drFormToConfig, configToDrForm,
        phaseLabel, drillPlan, drillOutcome, drillName,
        remediationLabel, unreadableFrom, isPartial, routeError,
        splitList, joinList,
        // constants
        PHASE_LABELS, UNRECOGNISED_LABEL, DRILL_DEFAULTS, DRILL_LABELS,
        DRILL_OUTCOMES, REMEDIATION_LABELS,
        MIN_MEMORY_MB, MAX_MEMORY_MB, MAX_VCPUS, MAX_DISK_GB, MAX_TIMEOUT_MIN
    };

    root.hangarRecoveryUi = hangarRecoveryUi;
    root.HangarRecoveryUi = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
