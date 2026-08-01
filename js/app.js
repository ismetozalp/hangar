// app.js — the Alpine root component.
//
// Deliberately thin: it owns tab state and the prerequisite gate, and delegates
// everything else to the feature modules. Anything that knows about restic, ReaR or
// systemd belongs in js/core or js/engine, not here.
'use strict';
(function (root) {

    const TABS = [
        { id: 'overview',  label: 'Overview' },
        { id: 'repos',     label: 'Repositories' },
        { id: 'jobs',      label: 'Jobs' },
        { id: 'logbook',   label: 'Logbook' },
        { id: 'recovery',  label: 'Recovery' },
        { id: 'settings',  label: 'Settings' }
    ];

    function hangarApp() {
        // Self-update state and methods are spread in rather than nested, so the
        // version badge in index.html can bind to `update`/`installedVersion`
        // directly on the root component.
        const updateUi = (root.hangarUpdateUi ? root.hangarUpdateUi() : {
            update: { available: false, version: '', checking: false, error: '' },
            installedVersion: '',
            async initUpdate() {},
            openUpdateModal() { return false; }
        });

        return Object.assign({}, updateUi, {
            tabs: TABS,
            tab: 'overview',
            ready: false,
            missing: [],
            settings: null,
            error: null,

            // --- theming ------------------------------------------------------
            // Applied before anything else renders, so the page never flashes the
            // default palette and then repaint into the chosen one.
            applyTheme(id) {
                const T = root.HangarThemes;
                if (!T || !root.document || !root.document.documentElement) return;
                const chosen = id !== undefined ? id
                    : ((this.settings && this.settings.theme) || T.DEFAULT_THEME);
                const prefersDark = !!(root.matchMedia &&
                    root.matchMedia('(prefers-color-scheme: dark)').matches);
                root.document.documentElement.setAttribute(
                    'data-bs-theme', T.resolve(chosen, prefersDark).attr);
            },

            // 'system' has to keep tracking the OS after load, or a user who
            // switches their desktop to dark at dusk is left on the light palette
            // until they reload.
            _watchSystemTheme() {
                if (this._themeWatched || !root.matchMedia) return;
                this._themeWatched = true;
                const mq = root.matchMedia('(prefers-color-scheme: dark)');
                const onChange = () => {
                    const id = (this.settings && this.settings.theme) || 'system';
                    if (id === 'system') this.applyTheme();
                };
                // addEventListener is not available on MediaQueryList everywhere;
                // addListener is the deprecated-but-universal fallback.
                if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
                else if (typeof mq.addListener === 'function') mq.addListener(onChange);
            },

            async init() {
                try {
                    this.settings = await root.HangarConfig.readGlobal();
                } catch (e) {
                    // A missing/unreadable global config is not fatal — defaults are
                    // sufficient to render the UI and let the user fix things.
                    this.settings = root.HangarConfig.mergeGlobal({});
                }

                this.applyTheme();
                this._watchSystemTheme();
                // A theme picked on the Settings screen must repaint the whole page,
                // not just that tab, so the change comes back here as an event.
                root.addEventListener('hangar:theme', (ev) => {
                    const id = ev && ev.detail;
                    if (this.settings) this.settings.theme = id;
                    this.applyTheme(id);
                });

                await this.refreshMissing();

                // The prerequisite banner and the header chip are a view of the
                // system, not a one-off snapshot taken at load. Re-probe whenever
                // something claims to have changed it, or a successful install
                // leaves the page still saying tools are missing.
                root.addEventListener('hangar:provisioned', () => { this.refreshMissing(); });

                // Deliberately after the prerequisite probe and never blocking on it:
                // an unreachable GitHub must not stop the plugin rendering.
                try {
                    await this.initUpdate(this.settings);
                } catch (e) { /* the badge simply stays hidden */ }

                this.ready = true;

                // Deep-link support: cockpit passes the fragment through, so
                // #/logbook lands straight on the Logbook.
                const frag = (root.location && root.location.hash || '').replace(/^#\/?/, '');
                if (frag && TABS.some(function (t) { return t.id === frag; })) this.tab = frag;
            },

            // Ask the system what is still missing. Called at load and again after
            // anything that may have installed something.
            async refreshMissing() {
                const P = root.HangarProvision;
                if (!P || typeof P.probeAll !== 'function') { this.missing = []; return this.missing; }
                try {
                    // probe() takes a single tool; probeAll()/missingFrom() is the pair
                    // that answers "what is still needed". missingFrom returns tool
                    // NAMES, so pair each with the reason the UI shows the user.
                    const results = await P.probeAll();
                    this.missing = P.missingFrom(results).map(function (tool) {
                        let reason = '';
                        try { reason = P.requirementFor(tool).reason || ''; } catch (e) { /* unknown tool */ }
                        return { tool: tool, reason: reason };
                    });
                    // A previous probe failure must not keep an error on screen once a
                    // later probe has succeeded.
                    this.error = null;
                } catch (e) {
                    this.error = e;
                    this.missing = [];
                }
                return this.missing;
            },

            missingSummary() {
                return this.missing.map(function (m) {
                    return m.tool + (m.reason ? ' (' + m.reason + ')' : '');
                }).join(', ');
            },

            openProvision() {
                root.dispatchEvent(new CustomEvent('hangar:provision', { detail: this.missing }));
            }
        });
    }

    // --- generic modals ---------------------------------------------------
    // These two are app-level rather than per-feature so every screen reuses one
    // confirmation dialog and one password prompt instead of shipping its own.

    // Every DOM touch in this file goes through these two helpers. They no-op when
    // there is no document (under node) or no Bootstrap yet, so component logic
    // stays unit testable and a modal that failed to load cannot take the page down.
    function showModal(id) {
        const el = root.document && root.document.getElementById(id);
        if (!el || !root.bootstrap) return null;
        const m = root.bootstrap.Modal.getOrCreateInstance(el);
        m.show();
        return m;
    }

    function hideModal(id) {
        const el = root.document && root.document.getElementById(id);
        if (!el || !root.bootstrap) return;
        root.bootstrap.Modal.getOrCreateInstance(el).hide();
    }

    function hangarConfirm() {
        return {
            title: '', message: '', detail: '', danger: false,
            confirmLabel: 'Confirm', cancelLabel: 'Cancel',
            _resolve: null,

            init() {
                root.addEventListener('hangar:confirm', (ev) => {
                    const o = ev.detail || {};
                    this.title = o.title || 'Are you sure?';
                    this.message = o.message || '';
                    this.detail = o.detail || '';
                    this.danger = !!o.danger;
                    this.confirmLabel = o.confirmLabel || (o.danger ? 'Delete' : 'Confirm');
                    this.cancelLabel = o.cancelLabel || 'Cancel';
                    this._resolve = o.resolve || null;
                    showModal('hangar-confirm');
                });
            },

            accept() {
                hideModal('hangar-confirm');
                if (this._resolve) this._resolve(true);
                this._resolve = null;
            }
        };
    }

    function hangarPassword() {
        const Passgen = root.HangarPassgen ||
            (typeof require === 'function' ? require('./core/passgen.js') : null);

        return {
            title: 'Repository password',
            repoLabel: '',
            password: '', confirm: '', reveal: false,
            confirming: false, error: '',
            _resolve: null,

            // --- generator ------------------------------------------------
            // A restic repository password is UNRECOVERABLE, so the dialog that
            // creates one has to do two things: make a strong password easy to
            // get, and make it impossible to close without noticing it must be
            // stored. Everything below serves that second half as much as the first.
            generated: false,
            copied: false,
            // 'memorable' by default: the one time this password is guaranteed to
            // be typed by hand is at a rescue console during a bare-metal recovery,
            // and words survive an unfamiliar keyboard layout far better than
            // symbols do.
            genMode: 'memorable',            // 'memorable' | 'random'
            genPattern: Passgen ? Passgen.DEFAULT_PATTERN : 'strong',
            genLength: Passgen ? Passgen.DEFAULT_LENGTH : 24,
            genAlphabet: Passgen ? Passgen.DEFAULT_ALPHABET : 'safe',
            genError: '',

            canGenerate() { return !!(Passgen && Passgen.hasSecureRandom()); },
            alphabets() { return Passgen ? Passgen.alphabets() : []; },
            patterns() { return Passgen ? Passgen.patterns() : []; },

            // One accessor for both modes, so the meter and the warning below it
            // never disagree with what pressing Generate would actually produce.
            strength() {
                if (!Passgen) return null;
                return this.genMode === 'memorable'
                    ? Passgen.describePassphrase({ pattern: this.genPattern })
                    : Passgen.describe({ length: this.genLength, alphabet: this.genAlphabet });
            },

            // Shown next to the shape picker so the trade-off is visible BEFORE the
            // click, not discovered from a meter afterwards. A memorable password
            // costs entropy; hiding that would be the dishonest part of offering one.
            weakChoice() {
                const s = this.strength();
                return !!s && (s.strength === 'weak' || s.strength === 'fair');
            },

            // Shown grouped, because an unbroken 24-character run is where
            // transcription errors come from. The VALUE is never grouped.
            displayPassword() {
                if (!this.password) return '';
                if (!this.generated || !Passgen) return this.password;
                // A memorable password carries its own separators; only the random
                // one needs grouping to be readable.
                if (this.genMode === 'memorable') return this.password;
                return Passgen.group(this.password, Passgen.GROUP_SIZE);
            },

            generatePassword() {
                this.genError = '';
                this.copied = false;
                if (!Passgen) { this.genError = 'The password generator is unavailable.'; return false; }
                try {
                    const value = this.genMode === 'memorable'
                        ? Passgen.generatePassphrase({ pattern: this.genPattern })
                        : Passgen.generate({ length: this.genLength, alphabet: this.genAlphabet });
                    this.password = value;
                    // Both fields, deliberately: the confirmation exists to catch a
                    // typo, and there is no typo to catch in a value the user never
                    // typed. Making them retype 24 random characters would only
                    // invite them to shorten it.
                    this.confirm = value;
                    this.generated = true;
                    this.reveal = true;      // a password you cannot see is one you cannot save
                    this.error = '';
                    return true;
                } catch (e) {
                    // hasSecureRandom() is checked before the button is offered, so
                    // this is the browser withdrawing crypto mid-session. Refusing is
                    // right: a weak password the user believes is strong is worse
                    // than no generator.
                    this.genError = (e && e.message) || 'Could not generate a password.';
                    return false;
                }
            },

            async copyPassword() {
                this.copied = false;
                if (!this.password) return false;
                try {
                    const nav = root.navigator;
                    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
                        await nav.clipboard.writeText(this.password);
                        this.copied = true;
                        return true;
                    }
                } catch (e) { /* fall through: the value is on screen to select */ }
                this.genError = 'Could not copy automatically — select the password and copy it.';
                return false;
            },

            init() {
                root.addEventListener('hangar:password', (ev) => {
                    const o = ev.detail || {};
                    this.title = o.title || 'Repository password';
                    this.repoLabel = o.repoLabel || '';
                    this.confirming = !!o.confirming;
                    this.error = o.error || '';
                    this.password = '';
                    this.confirm = '';
                    this.reveal = false;
                    this.generated = false;
                    this.copied = false;
                    this.genError = '';
                    this._resolve = o.resolve || null;
                    showModal('hangar-password');
                });
            },

            valid() {
                if (!this.password) return false;
                if (this.confirming && this.password !== this.confirm) return false;
                return true;
            },

            submit() {
                if (!this.valid()) {
                    this.error = this.confirming && this.password !== this.confirm
                        ? 'The two passwords do not match.'
                        : 'Enter a password.';
                    return;
                }
                const value = this.password;
                // Drop the secret from component state as soon as it is handed on —
                // core/secrets.js is the only thing allowed to hold it.
                this.password = '';
                this.confirm = '';
                this.generated = false;
                this.copied = false;
                this.error = '';
                hideModal('hangar-password');
                if (this._resolve) this._resolve(value);
                this._resolve = null;
            }
        };
    }

    // Promise-returning helpers so features can `await` a dialog.
    function confirmDialog(opts) {
        return new Promise((resolve) => {
            root.dispatchEvent(new CustomEvent('hangar:confirm',
                { detail: Object.assign({}, opts, { resolve }) }));
        });
    }

    function passwordDialog(opts) {
        return new Promise((resolve) => {
            root.dispatchEvent(new CustomEvent('hangar:password',
                { detail: Object.assign({}, opts, { resolve }) }));
        });
    }

    root.hangarApp = hangarApp;
    root.hangarConfirm = hangarConfirm;
    root.hangarPassword = hangarPassword;
    root.HangarDialogs = { confirmDialog, passwordDialog };
    if (typeof module !== 'undefined' && module.exports)
        module.exports = { hangarApp, hangarConfirm, hangarPassword, confirmDialog, passwordDialog, TABS };
})(typeof window !== 'undefined' ? window : globalThis);
