// features/fspicker-ui.js — the Browse dialog behind every path field.
//
// Pure logic lives in js/core/fspicker.js; this is the Alpine component and the
// promise that callers await. One dialog serves every path in the plugin, so a
// path is chosen the same way whether it is a repository folder, a backup source,
// an exclude file or a restore target.
//
// It resolves to a path or to null (cancelled) and never throws at the call site:
// a picker that can reject would make every Browse button a try/catch.
'use strict';
(function (root) {
    const F = root.HangarFsPicker ||
        (typeof require === 'function' ? require('../core/fspicker.js') : null);
    const Secrets = root.HangarSecrets ||
        (typeof require === 'function' ? require('../core/secrets.js') : null);

    const MODAL_ID = 'hangar-fspicker';

    function redact(v) {
        const s = v === null || v === undefined ? '' : String(v);
        if (!Secrets || typeof Secrets.redact !== 'function') return s;
        try { return Secrets.redact(s); } catch (e) { return s; }
    }

    // ---- pure view helpers -------------------------------------------------

    // The sentence under the title. It has to answer "what is this dialog for"
    // without the caller having to write copy for every field.
    function promptFor(opts) {
        const o = opts || {};
        if (o.prompt) return String(o.prompt);
        const mode = F.modeFor(o.mode).id;
        if (mode === 'file') return 'Choose a file.';
        if (mode === 'any') return 'Choose a file or folder.';
        return 'Choose a folder. The folder you are in is selected unless you pick one inside it.';
    }

    // A directory you cannot read is an ordinary thing to click on — an
    // unreadable /proc entry, a stale mount. It is reported in place and the
    // browser stays where it was, rather than becoming a dialog-wide failure.
    function listErrorText(e) {
        const msg = redact((e && e.message) || 'That folder could not be read.');
        return msg;
    }

    function titleFor(opts) {
        const o = opts || {};
        return o.title || F.modeFor(o.mode).label;
    }

    // Where to start. A field that already holds a path opens at that path's
    // folder rather than at '/', which is the difference between one click and
    // eight.
    function startDirFor(opts) {
        const o = opts || {};
        const current = String(o.current || '').trim();
        if (!current) return F.normalizePath(o.start || '/');
        // If it names a file, start in its folder; if a folder, start inside it.
        return F.normalizePath(o.mode === 'file' ? F.parentOf(current) : current);
    }

    // ---- component ---------------------------------------------------------

    function hangarFsPicker() {
        return {
            open: false,
            mode: F.DEFAULT_MODE,
            title: '',
            prompt: '',
            cwd: '/',
            entries: [],
            selected: null,
            showHidden: false,
            busy: false,
            error: '',
            newFolder: '',
            creating: false,
            _resolve: null,

            init() {
                if (typeof root.addEventListener !== 'function') return;
                root.addEventListener('hangar:pick-path', (ev) => {
                    this.openPicker((ev && ev.detail) || {});
                });
            },

            async openPicker(opts) {
                const o = opts || {};
                this.mode = F.modeFor(o.mode).id;
                this.title = titleFor(o);
                this.prompt = promptFor(o);
                this.selected = null;
                this.error = '';
                this.newFolder = '';
                this.creating = false;
                this._resolve = o.resolve || null;
                this.open = true;
                this.showModal();
                await this.go(startDirFor(o));
            },

            showModal() {
                const el = root.document && root.document.getElementById(MODAL_ID);
                if (el && root.bootstrap) root.bootstrap.Modal.getOrCreateInstance(el).show();
            },

            hideModal() {
                const el = root.document && root.document.getElementById(MODAL_ID);
                if (el && root.bootstrap) root.bootstrap.Modal.getOrCreateInstance(el).hide();
            },

            async go(path) {
                this.busy = true;
                this.error = '';
                const target = F.normalizePath(path);
                try {
                    this.entries = await F.list(target, { mode: this.mode, showHidden: this.showHidden });
                    this.cwd = target;
                    this.selected = null;
                } catch (e) {
                    // Stay where we were: bouncing the user to '/' because one
                    // folder was unreadable loses their place for no reason.
                    this.entries = this.cwd === target ? this.entries : this.entries;
                    this.error = listErrorText(e);
                } finally {
                    this.busy = false;
                }
            },

            up() { return this.go(F.parentOf(this.cwd)); },
            crumbs() { return F.breadcrumbs(this.cwd); },

            // A click descends into anything browsable, and selects anything the
            // mode accepts. Both on one click, because a dialog that needs a
            // double-click to enter a folder is a dialog people fight.
            async activate(entry) {
                if (!entry) return;
                if (F.isNavigable(entry)) return this.go(F.joinPath(this.cwd, entry.name));
                if (entry.selectable) this.selected = entry;
            },

            select(entry) {
                if (entry && entry.selectable) this.selected = entry;
            },

            isSelected(entry) {
                return !!(entry && this.selected && this.selected.name === entry.name);
            },

            async toggleHidden() {
                this.showHidden = !this.showHidden;
                await this.go(this.cwd);
            },

            chosen() { return F.chosenPath(this.cwd, this.selected, this.mode); },
            canChoose() { return !this.busy && F.canChoose(this.cwd, this.selected, this.mode); },

            newFolderProblems() {
                return this.newFolder ? F.validateFolderName(this.newFolder) : [];
            },

            // Creating the destination here matters: a repository folder usually
            // does not exist yet, and sending the user to a terminal to mkdir it
            // is exactly the detour this dialog exists to remove.
            async createFolder() {
                const problems = this.newFolderProblems();
                if (!this.newFolder || problems.length) {
                    this.error = problems[0] || 'A folder name is required.';
                    return false;
                }
                this.busy = true;
                this.error = '';
                try {
                    const made = await F.makeFolder(this.cwd, this.newFolder);
                    this.newFolder = '';
                    this.creating = false;
                    await this.go(made);
                    return true;
                } catch (e) {
                    this.error = redact((e && e.message) || 'The folder could not be created.');
                    return false;
                } finally {
                    this.busy = false;
                }
            },

            choose() {
                const path = this.chosen();
                if (!path) return false;
                this.finish(path);
                return true;
            },

            cancel() { this.finish(null); return true; },

            // Every exit goes through here, including the backdrop and Escape, so a
            // caller awaiting the promise is never left hanging.
            finish(value) {
                this.open = false;
                this.hideModal();
                const resolve = this._resolve;
                this._resolve = null;
                if (resolve) resolve(value);
            }
        };
    }

    // The call-site API. Mirrors HangarDialogs.confirmDialog/passwordDialog.
    function pickPath(opts) {
        return new Promise((resolve) => {
            if (typeof root.dispatchEvent !== 'function' || typeof root.CustomEvent !== 'function') {
                resolve(null);
                return;
            }
            root.dispatchEvent(new root.CustomEvent('hangar:pick-path',
                { detail: Object.assign({}, opts, { resolve }) }));
        });
    }

    const API = { MODAL_ID, promptFor, titleFor, startDirFor, listErrorText, hangarFsPicker, pickPath };
    root.hangarFsPicker = hangarFsPicker;
    root.HangarFsPickerUi = API;
    // Callers use HangarDialogs.pickPath, alongside the other generic dialogs.
    root.HangarDialogs = Object.assign({}, root.HangarDialogs || {}, { pickPath });
    if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
