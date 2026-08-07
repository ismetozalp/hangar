// features/provision-ui.js — the prerequisite installer.
//
// hangar installs what it needs rather than telling the user to run a package
// manager, so this screen is the only place in the plugin that talks about
// packages at all. It listens for 'hangar:provision' (dispatched by app.js) and
// drives core/provision.js: detect family and architecture, plan, install.
//
// The one rule that shapes everything here: on RHEL/CentOS restic lives in EPEL,
// so PackageKit can legitimately resolve nothing and the plan carries a
// static-binary fallback. A downloaded binary is not a distribution package, so
// it must never start without the user seeing the release URL and the SHA256
// source and confirming that specific step — separately from "Install".
//
// Pure view logic (stepRows / needsConsent / consentText / packageKitMessage) is
// split out and exported so the wording cannot soften without a test failing.
'use strict';
(function (root) {
    // Under node the siblings are required relative to this file; in the browser
    // index.html has already put them on the global.
    const underNode = (typeof module !== 'undefined' && module.exports);
    const Errors = underNode ? require('../core/errors.js') : root.HangarErrors;
    const Prov = underNode ? require('../core/provision.js') : root.HangarProvision;

    const METHOD = Prov.METHOD;
    const KIND = Errors.KIND;

    // Same two guards core/provision.js uses, and for the same reasons. String()
    // throws on a value with no usable toString, and a plain `table[key]` lookup
    // answers for keys like "constructor" and "toString" that no table declares —
    // which here would mean a status label rendering as a native function, or
    // worse, consentGiven['constructor'] reading as true and waving a download
    // straight past the consent gate.
    function str(v) {
        if (v === null || v === undefined) return '';
        try { return String(v); } catch (e) { return ''; }
    }

    function own(table, key) {
        return (table && Object.prototype.hasOwnProperty.call(table, key)) ? table[key] : undefined;
    }

    // ------------------------------------------------------------- reasons

    // Why the user should care, in their words rather than the package's. Kept
    // here and not in core/provision.js because core's `reason` fields are
    // one-line developer notes, and these are the sentences on screen.
    //
    // libvirt is listed although core does not yet plan it: the recovery drill
    // boots the rescue image in a throwaway VM, and when that tool joins
    // REQUIREMENTS this table already has its sentence.
    const REASONS = {
        restic: 'The backup engine. Hangar cannot back anything up without it.',
        fuse3: 'Lets the Logbook mount a snapshot and browse it as an ordinary file tree. Without it the Logbook still works, but falls back to listing files instead of mounting them.',
        rclone: 'Adds off-site destinations — anything an existing rclone remote can reach.',
        rear: 'Builds the bootable rescue image used for bare-metal recovery.',
        libvirt: 'Runs the recovery drill: boots the rescue image in a throwaway virtual machine to prove it actually recovers.'
    };

    function toolNameOf(step) {
        if (step === null || step === undefined) return '';
        if (typeof step === 'object') return str(step.tool);
        return str(step);
    }

    function reasonFor(tool) {
        const name = toolNameOf(tool);
        const mine = own(REASONS, name);
        if (mine) return mine;
        // Falling back to core's note is better than an empty cell: an unknown
        // tool with no sentence would read as "installing this for no reason".
        const req = own(Prov.REQUIREMENTS, name);
        return (req && req.reason) ? str(req.reason) : '';
    }

    // ------------------------------------------------------------- planning

    // True when carrying out this step could end in a download from GitHub —
    // either because nothing packages the tool here (method), or because the
    // package exists only in a repository that may not be enabled (fallback).
    function wouldDownload(step) {
        if (!step || typeof step !== 'object') return false;
        return step.method === METHOD.BINARY || step.fallback === METHOD.BINARY;
    }

    // core/provision.js sets fallback === 'binary' only for the EPEL_ONLY case,
    // so this is an exact signal rather than a guess about the distribution.
    function epelApplies(step) {
        return !!step && typeof step === 'object'
            && step.method === METHOD.PACKAGEKIT && step.fallback === METHOD.BINARY;
    }

    function stepRows(plan) {
        const steps = Array.isArray(plan) ? plan : (plan === null || plan === undefined ? [] : [plan]);
        return steps
            .filter(function (s) { return !!s && typeof s === 'object' && str(s.tool) !== ''; })
            .map(function (step) {
                return {
                    tool: str(step.tool),
                    step: step,
                    method: step.method,
                    fallback: step.fallback || null,
                    packages: Array.isArray(step.packages) ? step.packages.slice() : [],
                    required: !step.optional,
                    need: step.optional ? 'Optional' : 'Required',
                    reason: reasonFor(step.tool),
                    action: Prov.describeStep(step),
                    download: wouldDownload(step),
                    epel: epelApplies(step),
                    unavailable: step.method === METHOD.UNAVAILABLE,
                    state: 'pending',
                    progress: 0,
                    error: null,
                    note: '',
                    release: null,
                    showUnreadable: false
                };
            });
    }

    // Answers "will this plan want to download something?" before anything runs,
    // so the modal can warn up front instead of ambushing the user mid-install.
    // Rows produced by stepRows carry method and fallback too, so either works.
    function needsConsent(plan) {
        const steps = Array.isArray(plan) ? plan : (plan === null || plan === undefined ? [] : [plan]);
        return steps.some(wouldDownload);
    }

    // ------------------------------------------------------------- consent

    // The exact wording of the download consent. Asserted verbatim in the unit
    // tests: this text is the only thing standing between a user and an
    // unmanaged binary in /usr/local/bin, so it must not drift quietly.
    function consentText(step) {
        const tool = toolNameOf(step) || 'this tool';
        const candidate = (step && typeof step === 'object' && step.release) ? step.release : null;
        // Both halves or neither. A release carrying a URL but no checksum source
        // would print "SHA256: undefined" next to a sentence promising the
        // checksum is compared — an unverifiable download dressed as a verified one.
        const release = (candidate && str(candidate.url) && str(candidate.sha256Url)) ? candidate : null;
        const lines = [];

        lines.push('Hangar would download the official ' + tool +
            ' release binary from GitHub and install it outside your package manager.');
        lines.push('This is not a package from your distribution. Your package manager will not ' +
            'update it, will not verify it again, and will not remove it when you remove hangar. ' +
            'You are taking on those jobs yourself.');

        if (release) {
            lines.push('Release: ' + str(release.url));
            lines.push('SHA256: ' + str(release.sha256Url) +
                ' — the checksum is downloaded from there and compared before anything is installed.');
            if (release.sigUrl) lines.push('Signature: ' + str(release.sigUrl));
        } else {
            // No release means no URL to show, and showing no URL means there is
            // nothing to consent to. Say so rather than offering a blind Yes.
            lines.push('Hangar could not work out which release asset this machine needs, ' +
                'so there is no download URL to show you and nothing will be downloaded.');
        }

        if (epelApplies(step))
            lines.push('There is a better option: ' + tool + ' is packaged in EPEL for this ' +
                'distribution. Enabling EPEL installs a real package that your package manager ' +
                'keeps up to date. Use the download only if EPEL is not an option here.');

        lines.push('Nothing is downloaded until you confirm this step.');
        return lines.join('\n');
    }

    // ------------------------------------------------------------- errors

    // PackageKit's numeric enum moves between releases and its D-Bus errors are
    // unreadable, so classification happens on the text. core/provision.js
    // already covers space, network and cancellation; the two cases it leaves as
    // GENERIC — refused authorisation and nothing to resolve — are the two the
    // user can actually do something about, so they are named here.
    const PK_PATTERNS = [
        {
            re: /not authori[sz]ed|authenticat|access ?denied|permission denied|polkit|refused the request|not permitted/i,
            title: 'Not authorised',
            text: 'The system refused the installation before it started. Turn on administrative access in Cockpit — or sign in as a user who has it — and try again.'
        },
        {
            re: /not available from any enabled repository|package not found|could not find package|no packages? found|nothing to install|cannot find package|unable to find/i,
            title: 'Package not found',
            text: 'No repository enabled on this system provides that package. Enable the repository that carries it, then try again.'
        }
    ];

    const KIND_MESSAGES = {
        // A partial result is not a failure. restic exit 3 means the work was done
        // and some files could not be read, so this is warning-coloured, names the
        // files, and never claims the step failed.
        READ_ERRORS: {
            title: 'Finished, but some files could not be read',
            text: 'The step completed. The files listed below were skipped because they could not be read — everything else was handled.',
            severity: 'warning'
        },
        NETWORK: {
            title: 'Could not reach the repositories',
            text: 'The download failed before anything was installed. Check this machine\'s network and proxy settings, then try again.'
        },
        NO_SPACE: {
            title: 'Not enough disk space',
            text: 'There is not enough free space to unpack the packages. Free some space and try again — nothing was installed.'
        },
        CANCELLED: {
            title: 'Installation cancelled',
            text: 'The installation stopped before it finished. Nothing was left half-installed.',
            severity: 'warning'
        }
    };

    const FALLBACK_MESSAGE = {
        title: 'The installation did not complete',
        text: 'The package manager stopped without installing anything. The message it reported is below.'
    };

    // A READ_ERRORS result carries the paths that could not be read. Different
    // producers spell that differently, so accept the shapes that exist rather
    // than making one of them canonical and dropping the rest on the floor.
    // Capped because a failing mount can produce six figures of paths, and a
    // hundred thousand list items is a hung tab, not information.
    const MAX_UNREADABLE = 100;
    const PREVIEW_UNREADABLE = 10;

    function rawUnreadable(err) {
        const detail = (err && typeof err === 'object') ? err.detail : null;
        let raw = null;
        if (Array.isArray(detail)) raw = detail;
        else if (detail && typeof detail === 'object')
            raw = detail.unreadable || detail.files || detail.paths || null;
        else if (typeof detail === 'string') raw = detail;

        if (typeof raw === 'string') raw = raw.split(/\r?\n/);
        return Array.isArray(raw) ? raw : [];
    }

    function unreadableFrom(err) {
        const raw = rawUnreadable(err);
        const out = [];
        const seen = {};
        for (let i = 0; i < raw.length && out.length < MAX_UNREADABLE; i++) {
            const p = str(raw[i]).trim();
            if (p === '' || own(seen, p)) continue;
            seen[p] = true;
            out.push(p);
        }
        return out;
    }

    function unreadableOverflow(err) {
        const shown = unreadableFrom(err).length;
        // Only meaningful once the cap has bitten; below it, everything is on screen.
        if (shown < MAX_UNREADABLE) return 0;
        return Math.max(0, rawUnreadable(err).length - shown);
    }

    // Turns whatever came back into actionable text plus the raw string, which is
    // shown as secondary detail rather than as the headline — a D-Bus error name
    // tells the user nothing, but hiding it entirely makes bugs unreportable.
    function packageKitMessage(err, step) {
        // Anything that did not already come from core gets classified here, so a
        // bare D-Bus rejection cannot reach the UI unclassified.
        const e = Errors.isHangarError(err)
            ? err
            : Prov.classifyPackageKitError(null, (err && err.message) || err || '');

        const raw = str(e && e.message).trim();
        let picked = own(KIND_MESSAGES, str(e && e.kind)) || null;

        if (!picked)
            for (let i = 0; i < PK_PATTERNS.length && !picked; i++)
                if (PK_PATTERNS[i].re.test(raw)) picked = PK_PATTERNS[i];

        if (!picked) picked = FALLBACK_MESSAGE;

        const remediation = Errors.remediationFor(e);
        return {
            kind: e.kind,
            title: picked.title,
            text: picked.text,
            // A non-fatal kind is a partial result, and the design rule is that a
            // partial result is never painted as a failure. The template binds the
            // alert colour to this, so READ_ERRORS cannot end up red by accident.
            // Decided on the kind rather than on e.fatal: the kind is the contract,
            // the flag is a field anything could have set to anything.
            severity: picked.severity ||
                (Errors.NON_FATAL.has(str(e && e.kind)) ? 'warning' : 'danger'),
            unreadable: unreadableFrom(e),
            unreadableMore: unreadableOverflow(e),
            // The EPEL way out is only ever offered where the plan says it exists.
            hint: epelApplies(step)
                ? 'On this distribution ' + toolNameOf(step) + ' is packaged in EPEL. Enabling EPEL is the least surprising fix.'
                : '',
            detail: raw,
            remediation: remediation,
            actionLabel: actionLabel(remediation)
        };
    }

    // A screen-level failure: hangar could not even work out what is missing. It
    // has to say so, because an empty list here renders as "everything is already
    // installed" — a guess presented as good news.
    function probeFailureMessage(err) {
        const m = packageKitMessage(err, null);
        m.title = 'Could not check what is already installed';
        m.text = 'Hangar could not work out which prerequisites this machine is missing, ' +
            'so nothing is listed below. This is not a statement that everything is installed.';
        m.severity = 'danger';
        if (!m.remediation) m.remediation = 'retry';
        m.actionLabel = actionLabel(m.remediation);
        return m;
    }

    // Remediation slug -> button label. A remediation is an action the user can
    // take, so it is a button; a toast would be an apology instead of a fix.
    const ACTION_LABELS = {
        'unlock': 'Unlock repository',
        'reprompt': 'Enter password',
        'init': 'Initialise repository',
        'list-unreadable': 'Show unreadable files',
        'free-space': 'I freed some space — retry',
        // Cockpit's header owns the switch; hangar cannot flip it from a page,
        // so the button says where to look rather than promising an escalation.
        'grant-access': 'How to grant access',
        // Reachable here only because the table is shared with core/errors.js; a
        // package install has no cloud destination to re-authorise. Labelled all
        // the same, so a kind that gains this remediation can never ship a
        // button with no words on it.
        'reauthorize': 'Sign in again',
        'retry': 'Retry'
    };

    function actionLabel(remediation) {
        return own(ACTION_LABELS, str(remediation)) || null;
    }

    // ------------------------------------------------------------- progress

    // PackageKit reports 101 for "no idea", and -1 on some backends. Either would
    // render as a jumping bar, so an unusable number keeps the previous value.
    function progressFrom(props, current) {
        // The carried-over value is clamped too: it is written straight into a CSS
        // width, and a negative or out-of-range one paints a bar outside its track.
        const now = (typeof current === 'number' && isFinite(current))
            ? Math.min(100, Math.max(0, current)) : 0;
        if (!props || typeof props !== 'object') return now;
        const p = props.Percentage;
        const v = (p && typeof p === 'object' && 'v' in p) ? p.v : p;   // cockpit variant form
        if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > 100) return now;
        return v;
    }

    const STATUS_LABELS = {
        pending: 'Waiting',
        installing: 'Installing…',
        done: 'Installed',
        failed: 'Failed',
        skipped: 'Skipped',
        blocked: 'Needs your confirmation',
        manual: 'Needs a manual step',
        // A non-fatal outcome is neither done nor failed, and it must not be
        // labelled as either.
        partial: 'Finished with warnings'
    };

    // `pending` means two different things and must not read the same way in both.
    // Before the user presses Install nothing is waiting on anything — labelling an
    // untouched row "Waiting" makes an idle dialog look like a stalled one. Once a
    // run is under way, a pending row genuinely is queued behind another.
    function statusLabel(state, started) {
        const s = str(state);
        const idle = started ? 'Waiting' : 'Not installed';
        if (s === 'pending') return idle;
        return own(STATUS_LABELS, s) || idle;
    }

    // ------------------------------------------------------------- DOM edges

    // The only two DOM touches in this file. They no-op without a document or
    // without Bootstrap, so the component constructs and runs under node.
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

    // cockpit exposes no architecture field, and the release asset name depends
    // on it, so this is the one spawn the screen makes on its own.
    function detectArch() {
        if (typeof cockpit === 'undefined' || !cockpit || typeof cockpit.spawn !== 'function')
            return Promise.resolve(null);
        return cockpit.spawn(['uname', '-m'], { err: 'message' })
            .then(function (out) { return Prov.normalizeArch(out); })
            .catch(function () { return null; });
    }

    // ------------------------------------------------------------- component

    function hangarProvisionUi() {
        return {
            rows: [],
            family: 'unknown',
            arch: null,
            busy: false,
            loading: false,
            started: false,
            consent: null,          // { tool, row, release, text, epel, accepted }
            consentGiven: {},       // tool -> the user said yes to this download
            error: null,            // failure of something that is not one row
            request: null,          // what open() was asked for, so it can be retried

            // PackageKit is the mechanism, so hangar cannot install it for the user.
            // When it is missing the dialog stops offering an Install button it
            // cannot honour, and shows the exact commands for THIS distribution.
            pk: { available: true, reason: '', checked: false },
            manual: null,           // { packageKitCommand, directCommands, ... }
            copied: '',             // which command was last copied

            init() {
                if (typeof root.addEventListener !== 'function') return;
                root.addEventListener('hangar:provision', (ev) => {
                    this.open(ev && ev.detail);
                });
            },

            // detail is whatever app.js probed; strings and probe objects both
            // work because planFor accepts either.
            async open(missing) {
                this.reset();
                this.request = missing;
                this.loading = true;
                showModal('hangar-provision');

                try {
                    let list = Array.isArray(missing) ? missing : (missing ? [missing] : []);
                    if (list.length === 0)
                        // Opened without a probe result (deep link, or a stale one):
                        // ask the system rather than showing an empty dialog.
                        list = Prov.missingFrom(await Prov.probeAll());

                    this.family = await Prov.detectFamilyLive();
                    this.arch = await detectArch();
                    this.rows = stepRows(Prov.planFor(list, this.family));

                    // Checked after the plan is built, so the instructions can name
                    // the actual packages this host is missing rather than a generic
                    // list. A failure here must not hide the plan.
                    try {
                        this.pk = Object.assign({ checked: true },
                            await Prov.packageKitAvailable());
                    } catch (e) {
                        this.pk = { available: false, reason: 'unreachable', checked: true };
                    }
                    if (!this.pk.available) {
                        this.manual = Prov.manualInstructions(this.family, list);
                    }
                } catch (e) {
                    // Every one of these can reject, and an empty rows[] renders as
                    // "everything hangar needs is already installed". Swallowing the
                    // failure would turn "I don't know" into "you're fine".
                    this.rows = [];
                    this.error = probeFailureMessage(e);
                } finally {
                    this.loading = false;
                }
            },

            // The screen-level error's remediation. Same request, from the top.
            async retryOpen() {
                await this.open(this.request);
            },

            reset() {
                this.rows = [];
                this.busy = false;
                this.loading = false;
                this.started = false;
                this.consent = null;
                this.consentGiven = {};
                this.error = null;
                this.request = null;
            },

            close() {
                hideModal('hangar-provision');
            },

            // --- derived state ------------------------------------------

            anyDownloads() { return needsConsent(this.rows); },

            // --- PackageKit missing -------------------------------------------

            // Only true once the check has actually run, so the warning never
            // flashes up while the dialog is still loading.
            packageKitMissing() { return this.pk.checked && !this.pk.available; },

            // Distinguishes "PackageKit is not installed" from "it is installed but
            // not answering" — different problems with different fixes.
            packageKitReason() {
                if (this.pk.reason === 'not-installed')
                    return 'PackageKit is not installed on this system.';
                if (this.pk.reason === 'unreachable')
                    return 'PackageKit is installed but is not responding.';
                if (this.pk.reason === 'no-cockpit')
                    return 'This page cannot reach the system to install anything.';
                return 'PackageKit is unavailable.';
            },

            // An unknown distribution is stated plainly rather than given a guessed
            // command: a wrong install line is worse than none.
            manualKnown() { return !!(this.manual && this.manual.known); },

            async copyCommand(cmd) {
                this.copied = '';
                const text = String(cmd || '');
                if (!text) return false;
                try {
                    if (root.navigator && root.navigator.clipboard &&
                        typeof root.navigator.clipboard.writeText === 'function') {
                        await root.navigator.clipboard.writeText(text);
                        this.copied = text;
                        return true;
                    }
                } catch (e) { /* fall through — the command is on screen to select */ }
                return false;
            },

            // Re-run the whole check: the expected flow is that the user runs the
            // command in a terminal and comes straight back here.
            async recheck() { await this.open(this.request); },

            pending() {
                return this.rows.filter(function (r) {
                    return r.state !== 'done' && r.state !== 'skipped';
                }).length;
            },

            finished() {
                return this.started && !this.busy && !this.consent && this.pending() === 0;
            },

            failedRows() {
                return this.rows.filter(function (r) { return r.state === 'failed'; });
            },

            // A partial result is not a failure, but it is still something the user
            // may want to run again — so it is retryable without being red.
            retryableRows() {
                return this.rows.filter(function (r) {
                    return r.state === 'failed' || r.state === 'partial';
                });
            },

            label(state) { return statusLabel(state, this.started); },

            // The unreadable-file list is rendered, not hidden behind the button:
            // a partial result the user has to click to understand is a partial
            // result they will read as a failure. The button only unfolds the tail.
            visibleUnreadable(row) {
                const all = (row && row.error && row.error.unreadable) || [];
                return (row && row.showUnreadable) ? all : all.slice(0, PREVIEW_UNREADABLE);
            },

            moreUnreadable(row) {
                const all = (row && row.error && row.error.unreadable) || [];
                const hidden = (row && row.showUnreadable) ? 0 : Math.max(0, all.length - PREVIEW_UNREADABLE);
                return hidden + ((row && row.error && row.error.unreadableMore) || 0);
            },

            // --- installing ---------------------------------------------

            async installAll() {
                if (this.busy) return;
                this.busy = true;
                this.started = true;
                this.error = null;
                try {
                    for (let i = 0; i < this.rows.length; i++) {
                        const row = this.rows[i];
                        if (row.state === 'done' || row.state === 'skipped' || row.state === 'manual') continue;
                        // A row that parks on consent stops the run: the user is
                        // being asked a question and must answer it first.
                        if (!await this.installRow(row)) break;
                    }
                } catch (e) {
                    // installRow handles its own step failures, so anything landing
                    // here is a bug in this screen. It still has to be visible:
                    // an unhandled rejection inside an Alpine @click is silent.
                    this.error = probeFailureMessage(e);
                    this.error.title = 'The installation stopped unexpectedly';
                    this.error.text = 'Hangar hit a problem it did not expect and stopped. ' +
                        'Nothing further was installed. The reason is shown below.';
                } finally {
                    this.busy = false;
                    // Tell the rest of the page that the system changed. Without this
                    // the header chip and the prerequisite banner keep showing what
                    // was true when the page loaded — so a successful install still
                    // reads as "2 tools missing", which looks like the install failed.
                    // Announced even on failure: a partial run still installed
                    // something, and the banner should reflect what is true now.
                    this.announceInstalled();
                }
            },

            // Deliberately carries no payload. The listener re-probes the system
            // rather than trusting this screen's idea of what happened — the system
            // is the source of truth, and a user may also have installed something
            // in a terminal while this was open.
            announceInstalled() {
                if (typeof root.dispatchEvent !== 'function' ||
                    typeof root.CustomEvent !== 'function') return false;
                root.dispatchEvent(new root.CustomEvent('hangar:provisioned'));
                return true;
            },

            async installRow(row) {
                if (row.method === METHOD.UNAVAILABLE) {
                    row.state = 'skipped';
                    row.note = Prov.describeStep(row.step);
                    return true;
                }

                if (row.method === METHOD.BINARY) {
                    if (!this.hasConsent(row.tool)) { this.askConsent(row); return false; }
                    return this.installBinary(row);
                }

                row.state = 'installing';
                row.progress = 0;
                row.error = null;
                row.note = '';

                try {
                    await Prov.installStep(row.step, (props) => {
                        row.progress = progressFrom(props, row.progress);
                    });
                    row.state = 'done';
                    row.progress = 100;
                    return true;
                } catch (e) {
                    const msg = packageKitMessage(e, row.step);

                    // The EPEL case: PackageKit resolved nothing and the plan
                    // already carries the way out. Never take it silently — and
                    // never offer it after a cancellation, because the user just
                    // said stop and "shall I download a binary instead?" is not an
                    // answer to that.
                    if (row.fallback === METHOD.BINARY && msg.kind !== KIND.CANCELLED) {
                        if (!this.hasConsent(row.tool)) {
                            row.state = 'blocked';
                            row.error = msg;
                            this.askConsent(row);
                            return false;
                        }
                        return this.installBinary(row);
                    }

                    // A non-fatal kind is a partial result, not a failure. Painting
                    // it red would train the user to ignore the red ones that matter.
                    row.state = msg.severity === 'warning' ? 'partial' : 'failed';
                    row.error = msg;
                    // One optional tool failing must not abandon the others.
                    return true;
                }
            },

            // --- consent -------------------------------------------------

            // Own-property only. `consentGiven['constructor']` on a plain object is
            // truthy for free, and the one thing this gate must never do is answer
            // "yes, they agreed" for a question nobody was asked.
            hasConsent(tool) {
                return own(this.consentGiven, str(tool)) === true;
            },

            askConsent(row) {
                let release = null;
                try {
                    release = this.arch ? Prov.binaryFallbackFor(row.tool, null, this.arch) : null;
                } catch (e) {
                    // No asset for this tool/arch pair — consentText says so and
                    // the confirm button stays disabled.
                    release = null;
                }
                row.release = release;
                this.consent = {
                    tool: row.tool,
                    row: row,
                    release: release,
                    epel: row.epel,
                    text: consentText({ tool: row.tool, method: row.method, fallback: row.fallback, release: release }),
                    accepted: false
                };
            },

            canDownload() {
                return !!(this.consent && this.consent.accepted && this.consent.release);
            },

            async acceptConsent() {
                if (!this.canDownload()) return;
                const row = this.consent.row;
                // `__proto__` as a key is a silent no-op on an object literal, so
                // record consent somewhere a key cannot vanish into the prototype.
                this.consentGiven = Object.assign({}, this.consentGiven);
                Object.defineProperty(this.consentGiven, str(row.tool), {
                    value: true, enumerable: true, writable: true, configurable: true
                });
                this.consent = null;
                this.busy = true;
                try {
                    await this.installBinary(row);
                } finally {
                    this.busy = false;
                }
                await this.installAll();
            },

            declineConsent() {
                if (!this.consent) return;
                const row = this.consent.row;
                row.state = 'skipped';
                // The blocked-state alert explained why the download was offered.
                // Once the user has answered, leaving it up paints their own
                // deliberate choice as a failure.
                row.error = null;
                row.note = row.required
                    ? 'Skipped. Hangar cannot back anything up until ' + row.tool + ' is installed.'
                    : 'Skipped — the download was not confirmed.';
                this.consent = null;
            },

            // core/provision.js builds and verifies the URLs but ships no
            // downloader, so this checks for the seam instead of assuming it.
            // When it is absent the user gets the verified URLs and does it
            // themselves — which is still better than a wrong guess.
            async installBinary(row) {
                // Whatever happens next, the alert that got us here described the
                // package-manager attempt, not this one. Stale is worse than absent.
                row.error = null;

                // A consented download with no verified URL is exactly the blind
                // fetch the consent text promises will not happen.
                if (!row.release || !row.release.url || !row.release.sha256Url) {
                    row.state = 'failed';
                    row.error = packageKitMessage(Errors.create(KIND.GENERIC,
                        'Hangar could not work out which release asset this machine needs, ' +
                        'so there was nothing to verify or download.', row.tool), row.step);
                    return true;
                }

                const install = Prov.installBinary;
                if (typeof install !== 'function') {
                    row.state = 'manual';
                    row.note = 'Hangar cannot install an unpackaged binary itself yet. ' +
                        'Download the release below, check it against the SHA256 file, ' +
                        'and put it on this machine\'s PATH.';
                    return true;
                }

                row.state = 'installing';
                row.progress = 0;
                row.note = '';
                try {
                    await install(row.release, (props) => {
                        row.progress = progressFrom(props, row.progress);
                    });
                    row.state = 'done';
                    row.progress = 100;
                } catch (e) {
                    const msg = packageKitMessage(e, row.step);
                    row.state = msg.severity === 'warning' ? 'partial' : 'failed';
                    row.error = msg;
                }
                return true;
            },

            // --- the better alternative ----------------------------------

            // Offered only where the plan says the package exists in EPEL. This
            // is a real install through the same PackageKit path, not a hint.
            async enableEpel() {
                if (!this.consent || !this.consent.epel) return;
                const row = this.consent.row;
                this.consent = null;
                this.busy = true;

                const step = {
                    tool: 'epel-release',
                    method: METHOD.PACKAGEKIT,
                    packages: ['epel-release'],
                    fallback: null,
                    optional: false,
                    reason: ''
                };

                row.state = 'installing';
                row.progress = 0;
                row.error = null;
                row.note = 'Enabling EPEL…';

                try {
                    await Prov.installStep(step, (props) => {
                        row.progress = progressFrom(props, row.progress);
                    });
                    row.note = '';
                    row.state = 'pending';
                } catch (e) {
                    row.state = 'failed';
                    row.note = '';
                    row.error = packageKitMessage(e, step);
                    this.busy = false;
                    return;
                }

                this.busy = false;
                await this.installAll();
            },

            // --- remediation ---------------------------------------------

            async runAction(row) {
                // installAll() refuses to run while a run is in flight, so clearing
                // the row first would leave it Waiting for a loop that has already
                // walked past it — a row stuck at "Waiting" forever.
                if (this.busy || this.consent) return;
                const rem = row && row.error && row.error.remediation;
                // 'list-unreadable' needs no run: the files are already on the row,
                // and the button only has to reveal them.
                if (rem === 'list-unreadable') { row.showUnreadable = true; return; }
                // Only 'retry' and 'free-space' are reachable from a package
                // install; the rest belong to repository errors elsewhere.
                if (rem !== 'retry' && rem !== 'free-space') return;
                row.state = 'pending';
                row.error = null;
                await this.installAll();
            },

            async retryAll() {
                if (this.busy || this.consent) return;
                this.rows.forEach(function (r) {
                    if (r.state === 'failed' || r.state === 'partial') {
                        r.state = 'pending';
                        r.error = null;
                    }
                });
                await this.installAll();
            }
        };
    }

    const HangarProvisionUi = {
        REASONS, ACTION_LABELS, STATUS_LABELS, MAX_UNREADABLE,
        reasonFor, wouldDownload, epelApplies,
        stepRows, needsConsent, consentText,
        packageKitMessage, probeFailureMessage, unreadableFrom,
        actionLabel, progressFrom, statusLabel,
        hangarProvisionUi
    };

    root.hangarProvisionUi = hangarProvisionUi;
    root.HangarProvisionUi = HangarProvisionUi;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarProvisionUi;
})(typeof window !== 'undefined' ? window : globalThis);
