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

            async init() {
                try {
                    this.settings = await root.HangarConfig.readGlobal();
                } catch (e) {
                    // A missing/unreadable global config is not fatal — defaults are
                    // sufficient to render the UI and let the user fix things.
                    this.settings = root.HangarConfig.mergeGlobal({});
                }

                try {
                    const P = root.HangarProvision;
                    // probe() takes a single tool; probeAll()/missingFrom() is the pair
                    // that answers "what is still needed". missingFrom returns tool
                    // NAMES, so pair each with the reason the UI shows the user.
                    const results = await P.probeAll();
                    this.missing = P.missingFrom(results).map(function (tool) {
                        let reason = '';
                        try { reason = P.requirementFor(tool).reason || ''; } catch (e) { /* unknown tool */ }
                        return { tool: tool, reason: reason };
                    });
                } catch (e) {
                    this.error = e;
                    this.missing = [];
                }

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
        return {
            title: 'Repository password',
            repoLabel: '',
            password: '', confirm: '', reveal: false,
            confirming: false, error: '',
            _resolve: null,

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
