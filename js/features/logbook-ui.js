// features/logbook-ui.js — the Logbook screen: scrubber, file tree, restore.
//
// The screen is the point of the whole plugin: scroll back through moments, find
// the file, take it. Everything that decides *what* is shown — row shaping, badge
// resolution, the selection label, the restore plan — is a pure function at the
// top of this file, so the interesting logic is unit tested without a DOM, a
// mount, or a repository. The component below is deliberately thin glue over
// those functions plus core/logbook.js.
//
// index.html ships an empty #hangar-logbook and boot.js only injects the modal
// partials, so the screen markup lives here and mounts itself before Alpine
// starts. That keeps the feature one file instead of a file plus an entry in a
// loader list nobody remembers to update.
'use strict';
(function (root) {
    const E = root.HangarErrors ||
        (typeof require === 'function' ? require('../core/errors.js') : null);
    const L = root.HangarLogbook ||
        (typeof require === 'function' ? require('../core/logbook.js') : null);
    const R = root.HangarRestic ||
        (typeof require === 'function' ? require('../engine/restic.js') : null);
    const Cfg = root.HangarConfig ||
        (typeof require === 'function' ? require('../core/config.js') : null);
    const Repos = root.HangarRepos ||
        (typeof require === 'function' ? require('../core/repos.js') : null);
    const Secrets = root.HangarSecrets ||
        (typeof require === 'function' ? require('../core/secrets.js') : null);

    // app.js registers these on the global after every feature has loaded, so it
    // is resolved per call rather than captured here.
    function dialogs() { return root.HangarDialogs || {}; }

    const CONTAINER_ID = 'hangar-logbook';
    const RESTORE_MODAL_ID = 'hangar-restore';

    // Alternate-location restore is first because it is the one that cannot
    // destroy anything; §8 of the design makes the destructive path the one the
    // user has to reach for.
    const RESTORE_MODES = ['alternate', 'original'];
    const DEFAULT_RESTORE_MODE = 'alternate';
    const DEFAULT_RESTORE_TARGET = '/var/tmp/hangar-restore';

    const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    function fail(message, detail) {
        return E.create(E.KIND.GENERIC, message, detail === undefined ? null : detail);
    }

    // ---- pure: paths --------------------------------------------------------

    // Guarded like engine/restic.js: a value with a throwing toString (a
    // null-prototype object from parsed JSON, a Proxy) would otherwise escape as
    // an untyped TypeError past every typed error path below.
    function str(v) {
        if (v === null || v === undefined) return '';
        try {
            return String(v);
        } catch (e) {
            return '';
        }
    }

    // Anything that would truncate a path at a syscall or split a line in output
    // this screen parses back.
    const UNSAFE_RE = /[\u0000\r\n]/;

    // Collapses repeated separators so '/etc//' and '/etc' are the same node —
    // otherwise a badge keyed on one spelling never matches a row on the other.
    function normalizePath(p) {
        const s = str(p).replace(/\/{2,}/g, '/');
        if (s === '' || s === '/') return '/';
        return s.replace(/\/+$/, '') || '/';
    }

    function joinPath(base, name) {
        const b = normalizePath(base);
        const n = str(name).replace(/^\/+/, '');
        if (n === '') return b;
        return b === '/' ? '/' + n : b + '/' + n;
    }

    function parentOf(path) {
        const p = normalizePath(path);
        if (p === '/') return '/';
        const cut = p.lastIndexOf('/');
        return cut <= 0 ? '/' : p.slice(0, cut);
    }

    function breadcrumbsFor(path) {
        const p = normalizePath(path);
        const out = [{ label: 'Snapshot root', path: '/' }];
        if (p === '/') return out;
        let acc = '';
        p.split('/').forEach((seg) => {
            if (seg === '') return;
            acc += '/' + seg;
            out.push({ label: seg, path: acc });
        });
        return out;
    }

    // ---- pure: formatting ---------------------------------------------------

    const UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];

    // Decimal units, matching cockpit.format_bytes, so a size shown here reads
    // the same as the same size shown anywhere else in the console.
    function formatBytes(bytes) {
        const raw = Number(bytes);
        if (!Number.isFinite(raw) || raw <= 0) return '0 B';
        // Clamped rather than divided down: past MAX_SAFE_INTEGER the division
        // chain reaches exponential notation ('1e+285 PB'), which is not a size a
        // human can read and is not a size a filesystem can hold either.
        const n = Math.min(raw, Number.MAX_SAFE_INTEGER);
        if (n < 1000) return Math.round(n) + ' B';
        let value = n;
        let unit = 0;
        while (value >= 1000 && unit < UNITS.length - 1) {
            value /= 1000;
            unit++;
        }
        const rounded = Math.round(value * 10) / 10;
        const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
        return text + ' ' + UNITS[unit];
    }

    // Accepts what the three sources actually produce: an ISO string (restic),
    // epoch seconds as a string (`find -printf %T@`), or a Date.
    //
    // Every branch re-checks the constructed Date. isFinite() is not enough: a
    // magnitude past 8.64e15 is outside the Date range and the Invalid Date it
    // produces is truthy, so it would travel all the way to getUTCDate() and print
    // a label reading 'NaN undefined NaN'. core/logbook.js guards the same trap.
    function toDateSafe(value) {
        if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
        if (typeof value === 'number' && isFinite(value))
            return valid(new Date(value < 1e12 ? value * 1000 : value));
        const s = str(value).trim();
        if (s === '') return null;
        if (/^\d+(\.\d+)?$/.test(s)) return valid(new Date(Math.round(parseFloat(s) * 1000)));
        return valid(new Date(s));
    }

    function valid(d) { return isNaN(d.getTime()) ? null : d; }

    function pad2(n) { return n < 10 ? '0' + n : String(n); }

    // UTC, for the same reason core/logbook.js bands in UTC: a label derived from
    // the browser's zone would disagree with the snapshot directory name the user
    // is looking at. The column is labelled UTC in the markup.
    function absoluteLabel(value) {
        const d = toDateSafe(value);
        if (!d) return 'unknown';
        return d.getUTCDate() + ' ' + MONTHS_SHORT[d.getUTCMonth()] + ' ' +
            d.getUTCFullYear() + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
    }

    function clockLabel(value) {
        const d = toDateSafe(value);
        if (!d) return '--:--';
        return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
    }

    // ---- pure: the scrubber -------------------------------------------------

    function momentFor(snapshot, now) {
        const time = snapshot && typeof snapshot === 'object' ? snapshot.time : snapshot;
        const id = (snapshot && snapshot.id) ? String(snapshot.id) : '';
        return {
            id: id,
            shortId: (snapshot && snapshot.shortId) ? String(snapshot.shortId) : id.slice(0, 8),
            time: time === undefined ? null : time,
            absolute: absoluteLabel(time),
            clock: clockLabel(time),
            relative: L.formatRelative(time, now),
            host: (snapshot && snapshot.hostname) ? String(snapshot.hostname) : '',
            paths: (snapshot && Array.isArray(snapshot.paths)) ? snapshot.paths.map(String) : [],
            snapshot: snapshot
        };
    }

    // Snapshots -> the bands the scrubber renders, newest first. The banding
    // itself belongs to core/logbook.js; this only decorates it with the two
    // labels each moment shows.
    function timelineModel(snapshots, now) {
        return L.buildTimeline(snapshots, now).map((band) => ({
            key: band.key,
            label: band.label,
            granularity: band.granularity,
            moments: band.snapshots.map((s) => momentFor(s, now))
        }));
    }

    // ---- pure: the file tree ------------------------------------------------

    const FIND_TYPES = { d: 'dir', f: 'file', l: 'link' };

    // `find -printf` rather than `ls -l`: the field order is ours, so nothing has
    // to be recovered from a locale-dependent column layout, and a name
    // containing spaces stays intact.
    const FIND_FORMAT = '%y\\t%s\\t%T@\\t%f\\n';

    function listDirArgv(fsPath) {
        const p = str(fsPath);
        if (p === '') throw fail('a directory path is required to list it');
        // A NUL truncates the path at the syscall and a newline splits the reply
        // this screen parses back line by line, so either would list a directory
        // other than the one the breadcrumb claims.
        if (UNSAFE_RE.test(p))
            throw fail('that directory name contains a character the Logbook cannot list',
                { path: JSON.stringify(p) });
        return ['find', p, '-mindepth', '1', '-maxdepth', '1', '-printf', FIND_FORMAT];
    }

    // One entry per line: type, size, mtime, name — name last because it is the
    // only field that can contain a tab.
    function parseFindOutput(text, dirPath) {
        const out = [];
        const raw = str(text);
        if (raw.trim() === '') return out;
        raw.split(/\r?\n/).forEach((line) => {
            if (line === '') return;
            const parts = line.split('\t');
            if (parts.length < 4) return;              // noise, or a truncated tail
            const name = parts.slice(3).join('\t');
            if (name === '' || name === '.' || name === '..') return;
            const size = Number(parts[1]);
            out.push({
                name: name,
                type: FIND_TYPES[parts[0]] || 'other',
                size: Number.isFinite(size) ? size : 0,
                mtime: parts[2],
                path: joinPath(dirPath === undefined ? '/' : dirPath, name)
            });
        });
        return out;
    }

    // The no-FUSE path. `restic ls --json --recursive` returns the whole tree, so
    // the directory being viewed is selected here rather than by re-running
    // restic for every folder the user opens.
    function lsEntriesFor(nodes, dirPath) {
        const dir = normalizePath(dirPath === undefined ? '/' : dirPath);
        const out = [];
        (Array.isArray(nodes) ? nodes : []).forEach((n) => {
            if (!n || typeof n !== 'object') return;
            const path = normalizePath(n.path);
            if (path === '/' || parentOf(path) !== dir) return;
            const name = str(n.name) || path.slice(path.lastIndexOf('/') + 1);
            if (name === '') return;
            const size = Number(n.size);
            out.push({
                name: name,
                type: n.type === 'dir' ? 'dir' : (n.type === 'symlink' ? 'link' : 'file'),
                size: Number.isFinite(size) ? size : 0,
                mtime: n.mtime || null,
                path: path
            });
        });
        return out;
    }

    function badgeClassFor(badge) {
        const b = str(badge);
        if (b === 'added' || b === 'modified' || b === 'removed') return 'hangar-badge ' + b;
        return '';
    }

    function isDirEntry(e) { return e && e.type === 'dir'; }

    // Folders first, then case-insensitive by name: the order a file manager uses,
    // and the one a user scanning for a filename expects.
    function compareEntries(a, b) {
        const da = isDirEntry(a) ? 0 : 1;
        const db = isDirEntry(b) ? 0 : 1;
        if (da !== db) return da - db;
        const la = str(a.name).toLowerCase();
        const lb = str(b.name).toLowerCase();
        if (la < lb) return -1;
        if (la > lb) return 1;
        return str(a.name) < str(b.name) ? -1 : (str(a.name) > str(b.name) ? 1 : 0);
    }

    function badgeAt(badges, path) {
        if (!badges || typeof badges !== 'object') return null;
        // badges from diffToBadges is a null-prototype map, so hasOwnProperty has
        // to be borrowed rather than called on it.
        return Object.prototype.hasOwnProperty.call(badges, path) ? str(badges[path]) : null;
    }

    // Directory entries -> the rows the tree renders, with change badges resolved
    // against the diff to the adjacent older snapshot.
    function treeRowsFor(entries, badges) {
        const list = (Array.isArray(entries) ? entries : [])
            .filter((e) => e && typeof e === 'object' && str(e.name) !== '');
        const rows = list.map((e) => {
            const path = normalizePath(e.path !== undefined && e.path !== null && e.path !== ''
                ? e.path : '/' + str(e.name));
            const dir = isDirEntry(e);
            const size = Number(e.size);
            const badge = badgeAt(badges, path);
            return {
                name: str(e.name),
                path: path,
                key: path,
                type: str(e.type) || 'file',
                isDir: dir,
                isLink: e.type === 'link',
                size: Number.isFinite(size) ? size : 0,
                // A directory's own inode size is noise to a user deciding what to
                // restore, so it is not shown.
                sizeLabel: dir ? '' : formatBytes(size),
                mtime: e.mtime === undefined ? null : e.mtime,
                mtimeLabel: absoluteLabel(e.mtime),
                badge: badge,
                badgeClass: badgeClassFor(badge)
            };
        });
        rows.sort(compareEntries);
        return rows;
    }

    // ---- pure: selection ----------------------------------------------------

    function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

    // "3 files, 1 folder (2.4 MB)" — the label above the Restore button, so it has
    // to state exactly what the button will act on.
    function selectionSummary(selected) {
        const list = (Array.isArray(selected) ? selected : [])
            .filter((r) => r && typeof r === 'object');
        if (!list.length) return 'Nothing selected';

        let files = 0;
        let folders = 0;
        let bytes = 0;
        list.forEach((r) => {
            if (r.isDir || r.type === 'dir') {
                folders++;
                return;
            }
            files++;
            const n = Number(r.size);
            if (Number.isFinite(n) && n > 0) bytes += n;
        });

        const parts = [];
        if (files) parts.push(plural(files, 'file', 'files'));
        if (folders) parts.push(plural(folders, 'folder', 'folders'));
        // Folder contents are not walked, so a folder-only selection has no
        // trustworthy size and claiming one would understate the restore.
        return parts.join(', ') + (bytes > 0 ? ' (' + formatBytes(bytes) + ')' : '');
    }

    // ---- pure: the restore plan ---------------------------------------------

    // An entry that names nothing is dropped rather than coerced. normalizePath()
    // turns null into '/', so coercing here would silently promote a hole in the
    // selection into "the whole snapshot" — which in original mode means restoring
    // over the running system.
    function includePathsFrom(selection) {
        const seen = Object.create(null);
        const out = [];
        (Array.isArray(selection) ? selection : []).forEach((r) => {
            if (r === null || r === undefined) return;
            const raw = typeof r === 'object' ? (r.path || r.name) : r;
            if (raw === null || raw === undefined || str(raw).trim() === '') return;
            const path = normalizePath(raw);
            if (path === '' || seen[path]) return;
            seen[path] = true;
            out.push(path);
        });
        return out;
    }

    // A descriptor, not a command line: it is handed straight to
    // HangarRestic.run('restore', ...), which is the only module allowed to know
    // what restic's flags are called.
    //
    // `mode` defaults to 'alternate' because that is the mode that cannot
    // overwrite anything; 'original' always carries a destructive warning, which
    // the modal turns into a danger confirmation.
    function restorePlan(selection, mode, target, opts) {
        const o = opts || {};
        const m = (mode === undefined || mode === null || mode === '') ? DEFAULT_RESTORE_MODE : String(mode);
        if (RESTORE_MODES.indexOf(m) < 0)
            throw fail('Unknown restore mode: ' + m, { mode: m, modes: RESTORE_MODES });

        const include = includePathsFrom(selection);
        const warnings = [];
        const problems = [];

        if (!include.length) problems.push('Select at least one file or folder to restore.');

        let dest;
        if (m === 'original') {
            // restic writes paths relative to --target, so the original location
            // is target '/'. The include list keeps it to the selection.
            dest = '/';
            warnings.push('Files will be written back to their original locations, ' +
                'replacing whatever is there now.');
            if (include.indexOf('/') >= 0)
                warnings.push('The selection includes the snapshot root, so this restores the ' +
                    'whole snapshot over the running system.');
        } else {
            const raw = ((target === undefined || target === null) ? str(o.target) : str(target)).trim();
            dest = raw === '' ? '' : normalizePath(raw);
            if (raw === '') problems.push('Choose a directory to restore into.');
            else if (UNSAFE_RE.test(raw)) {
                problems.push('The restore directory must not contain line breaks or control characters.');
                dest = '';
            } else if (raw.charAt(0) !== '/')
                problems.push('The restore directory must be an absolute path.');
            else if (dest === '/')
                warnings.push('Restoring into "/" writes over the original locations, ' +
                    'exactly as an original-location restore would.');
        }

        const destructive = m === 'original' || dest === '/';
        const snapshot = str(o.snapshot);
        if (snapshot === '') problems.push('No moment is selected.');

        return {
            op: 'restore',
            mode: m,
            snapshot: snapshot,
            target: dest,
            include: include,
            verify: !!o.verify,
            destructive: destructive,
            warnings: warnings,
            problems: problems,
            valid: problems.length === 0
        };
    }

    // ---- pure: error presentation -------------------------------------------

    // A typed failure becomes a button, never a toast (design §8).
    const REMEDIATION_LABELS = {
        'unlock': 'Unlock repository',
        'reprompt': 'Enter password',
        'init': 'Initialise repository',
        'list-unreadable': 'Show unreadable files',
        'free-space': 'Check free space',
        'retry': 'Try again'
    };

    function remediationLabel(action) {
        return REMEDIATION_LABELS[str(action)] || '';
    }

    function errorView(e) {
        if (!e) return null;
        const action = E.remediationFor(e);
        return {
            kind: E.isHangarError(e) ? e.kind : E.KIND.UNKNOWN,
            message: str(e && e.message) || 'Something went wrong.',
            fatal: E.isFatal(e),
            action: action,
            actionLabel: remediationLabel(action)
        };
    }

    // A non-fatal outcome — READ_ERRORS above all — is a partial success and must
    // never wear the failure colour (design §8). The class is derived here rather
    // than in the template so the rule is unit tested rather than eyeballed.
    function errorAlertClass(view) {
        if (!view) return '';
        return view.fatal ? 'alert alert-danger' : 'alert alert-warning';
    }

    function noticeAlertClass(kind) {
        const k = str(kind);
        if (k === 'warning') return 'alert alert-warning';
        if (k === 'info') return 'alert alert-info';
        return 'alert alert-success';
    }

    // restic `error` messages name the file in `item`; `message` is the reason.
    // Both are kept so the list reads "/var/lib/x — permission denied" rather than
    // a bare path the user cannot act on.
    function unreadableFromMessages(messages) {
        const seen = Object.create(null);
        const out = [];
        (Array.isArray(messages) ? messages : []).forEach((m) => {
            if (m === null || m === undefined) return;
            let text;
            if (typeof m === 'object') {
                const item = str(m.item).trim();
                const why = str(m.message || (m.error && m.error.message)).trim();
                text = item && why ? item + ' — ' + why : (item || why);
            } else {
                text = str(m).trim();
            }
            if (text === '' || seen[text]) return;
            seen[text] = true;
            out.push(text);
        });
        return out;
    }

    // The same list, recovered from a typed error rather than from a run result:
    // classifyExit() keeps the raw stderr in `detail`, and that is the only place
    // the unreadable files survive when restic exited 3 on a non-streaming op.
    function unreadableFromError(e) {
        if (!e || typeof e !== 'object') return [];
        const detail = e.detail;
        if (!detail || typeof detail !== 'object') return [];
        const collected = [];
        if (Array.isArray(detail.errors)) detail.errors.forEach((m) => collected.push(m));
        if (Array.isArray(detail.unreadable)) detail.unreadable.forEach((m) => collected.push(m));
        if (typeof detail.stderr === 'string' && detail.stderr !== '') {
            R.parseJsonLines(detail.stderr).forEach((m) => {
                if (m && m.message_type === 'error') collected.push(m);
            });
        }
        return unreadableFromMessages(collected);
    }

    // ---- impure: thin transport ---------------------------------------------

    function hasCockpit() {
        return typeof cockpit !== 'undefined' && !!cockpit && typeof cockpit.spawn === 'function';
    }

    // Opening the channel can fail outright (no superuser bridge, protocol error).
    // Callers only ever .catch() this, so a synchronous throw would escape every
    // error path they have.
    function spawnText(argv) {
        if (!hasCockpit())
            return Promise.reject(fail('cockpit is unavailable', { argv: argv }));
        try {
            return Promise.resolve(cockpit.spawn(argv, { superuser: 'require', err: 'message' }));
        } catch (e) {
            return Promise.reject(fail((e && e.message) || 'Could not start the command',
                { argv: argv }));
        }
    }

    // HangarRestic.run() folds a JSON-*lines* stream into a progress summary,
    // which is exactly wrong for snapshots/ls/diff: those emit a single JSON
    // document that the fold discards. Argument building, exit classification and
    // parsing still go through the engine — only the transport is local.
    function resticText(op, opts) {
        let argv;
        try {
            argv = [(opts && opts.binary) || 'restic'].concat(R.buildArgs(op, opts || {}));
        } catch (e) {
            return Promise.reject(e);
        }
        return spawnText(argv).catch((ex) => {
            throw R.classifyExit(ex && ex.exit_status, (ex && (ex.message || ex.problem)) || '');
        });
    }

    // ---- the screen component ----------------------------------------------

    function hangarLogbookUi() {
        return {
            // repositories
            repos: [],
            repoId: '',
            repo: null,

            // scrubber
            snapshots: [],
            bands: [],
            moment: null,

            // tree
            cwd: '/',
            entries: [],
            badges: {},
            rows: [],
            crumbs: [{ label: 'Snapshot root', path: '/' }],
            selected: [],

            // how the tree was read, and why
            reader: 'none',            // 'mount' | 'ls' | 'none'
            fallbackReason: '',
            mountPoint: '',

            // status
            busy: false,
            busyLabel: '',
            error: null,
            unreadable: [],
            unreadableTitle: '',
            showUnreadable: false,
            notice: '',
            noticeKind: 'success',
            progress: null,

            idleSec: 900,
            visible: false,
            _idle: null,

            // --- lifecycle ---------------------------------------------------

            async init() {
                try {
                    const settings = await Cfg.readGlobal();
                    this.idleSec = Number(settings.mountIdleTimeoutSec) || this.idleSec;
                } catch (e) {
                    // Defaults are enough to browse; a broken global config is the
                    // Settings screen's problem, not the Logbook's.
                }
                if (root.addEventListener) {
                    // A FUSE mount outlives the page by design, so leaving without
                    // dropping it would strand it until the idle timer fires.
                    root.addEventListener('pagehide', () => { this.releaseMount(); });
                }
                await this.loadRepos();
            },

            // Driven by x-effect on the parent's `tab`, so it must be cheap and
            // idempotent — it runs on every reactive change, not only on a switch.
            onScreenChange(tab) {
                const nowVisible = tab === 'logbook';
                if (nowVisible === this.visible) return;
                this.visible = nowVisible;
                if (nowVisible) this.touchIdle();
                else this.releaseMount();
            },

            // A configured timeout past the 32-bit millisecond ceiling is clamped by
            // setTimeout to 1ms, which would drop the mount the instant the screen
            // opened. Bounded to a day: longer than that is a forgotten mount, not
            // an idle one.
            idleMs() {
                const sec = Number(this.idleSec);
                if (!Number.isFinite(sec)) return 900 * 1000;
                return Math.min(Math.max(60, sec), 86400) * 1000;
            },

            touchIdle() {
                this.clearIdle();
                if (!root.setTimeout) return;
                this._idle = root.setTimeout(() => {
                    this._idle = null;
                    this.releaseMount();
                    this.noticeKind = 'info';
                    this.notice = 'The repository was unmounted after being idle.';
                }, this.idleMs());
            },

            clearIdle() {
                if (this._idle && root.clearTimeout) root.clearTimeout(this._idle);
                this._idle = null;
            },

            releaseMount() {
                this.clearIdle();
                if (this.reader !== 'mount' || !this.repoId) return;
                this.reader = 'none';
                this.mountPoint = '';
                return L.unmount(this.repoId).catch(() => null);
            },

            // --- status plumbing ----------------------------------------------

            // The one place a failure becomes screen state. A non-fatal kind —
            // READ_ERRORS above all — is a partial success, so the files it could
            // not read are pulled out of the typed error and listed instead of the
            // whole thing being coloured as a failure (design §8).
            handleError(e) {
                const view = errorView(e);
                this.error = view;
                if (view && !view.fatal) {
                    const files = unreadableFromError(e);
                    if (files.length) {
                        this.unreadable = files;
                        this.unreadableTitle = 'Some files could not be read.';
                    }
                }
                return view;
            },

            errorClass() { return errorAlertClass(this.error); },

            noticeClass() { return noticeAlertClass(this.noticeKind); },

            clearStatus() {
                this.error = null;
                this.notice = '';
                this.noticeKind = 'success';
                this.unreadable = [];
                this.unreadableTitle = '';
                this.showUnreadable = false;
            },

            // '42% · 1.2 GB of 3 GB' during a restore. Rendered rather than merely
            // stored: a long restore with no visible progress is indistinguishable
            // from a hung one.
            progressLabel() {
                const p = this.progress;
                if (!p || typeof p !== 'object') return '';
                const pct = Number(p.percent_done);
                const parts = [];
                if (Number.isFinite(pct)) parts.push(Math.round(Math.min(1, Math.max(0, pct)) * 100) + '%');
                const done = Number(p.bytes_done);
                const total = Number(p.total_bytes);
                if (Number.isFinite(done) && done > 0)
                    parts.push(formatBytes(done) + (Number.isFinite(total) && total > 0
                        ? ' of ' + formatBytes(total) : ''));
                return parts.join(' · ');
            },

            // --- repositories and snapshots -----------------------------------

            async loadRepos() {
                this.busy = true;
                this.busyLabel = 'Looking for repositories…';
                try {
                    const ids = await Cfg.listRepos();
                    const repos = [];
                    const broken = [];
                    for (const id of ids) {
                        try {
                            const r = await Cfg.readRepo(id);
                            if (r) repos.push(Object.assign({ id: id }, r));
                            else broken.push(Cfg.CONF_DIR + '/repos/' + id + '.json — empty');
                        } catch (e) {
                            // One unreadable definition must not hide the others —
                            // but it must not vanish either, or a repository the
                            // user configured is simply missing with no explanation.
                            broken.push(Cfg.CONF_DIR + '/repos/' + id + '.json — ' +
                                (str(e && e.message) || 'could not be read'));
                        }
                    }
                    this.repos = repos;
                    // After selectRepo, which resets the status area: the warning
                    // is about this listing, not about the repository it picked.
                    if (repos.length && !this.repoId) await this.selectRepo(repos[0].id);
                    if (broken.length) {
                        this.unreadable = broken;
                        this.unreadableTitle = 'Some repository definitions could not be read.';
                    }
                } catch (e) {
                    this.handleError(e);
                } finally {
                    this.busy = false;
                }
            },

            async selectRepo(id) {
                if (this.repoId && this.repoId !== id) await this.releaseMount();
                this.clearStatus();
                this.repoId = id;
                this.repo = this.repos.filter((r) => r.id === id)[0] || null;
                this.snapshots = [];
                this.bands = [];
                this.moment = null;
                this.rows = [];
                this.selected = [];
                this.cwd = '/';
                await this.loadSnapshots();
            },

            repoUrl() {
                return this.repo ? Repos.buildUrl(this.repo) : '';
            },

            resticOpts(extra) {
                return Object.assign({
                    repoUrl: this.repoUrl(),
                    passwordFile: Secrets.keyPath(this.repoId)
                }, extra || {});
            },

            async loadSnapshots() {
                if (!this.repo) return;
                this.busy = true;
                this.busyLabel = 'Reading snapshots…';
                this.error = null;
                try {
                    const text = await resticText('snapshots', this.resticOpts());
                    this.snapshots = R.parseSnapshots(text);
                    this.bands = timelineModel(this.snapshots, Date.now());
                    const first = this.bands.length ? this.bands[0].moments[0] : null;
                    if (first) await this.selectMoment(first);
                } catch (e) {
                    this.handleError(e);
                } finally {
                    this.busy = false;
                }
            },

            // --- the scrubber -------------------------------------------------

            isActive(m) {
                return !!this.moment && this.moment.id === m.id;
            },

            async selectMoment(m) {
                this.moment = m;
                this.selected = [];
                this.cwd = '/';
                this.touchIdle();
                await this.loadBadges();
                await this.loadTree();
            },

            // The snapshot immediately older than the selected one, which is what
            // the change badges are relative to.
            previousMoment() {
                const flat = [];
                this.bands.forEach((b) => b.moments.forEach((m) => flat.push(m)));
                for (let i = 0; i < flat.length; i++)
                    if (this.moment && flat[i].id === this.moment.id) return flat[i + 1] || null;
                return null;
            },

            async loadBadges() {
                this.badges = {};
                const prev = this.previousMoment();
                if (!prev || !this.moment || !this.moment.id) return;
                try {
                    const text = await resticText('diff', this.resticOpts({
                        snapshotA: prev.id, snapshotB: this.moment.id
                    }));
                    this.badges = L.diffToBadges(R.parseDiff(text));
                } catch (e) {
                    // Badges are decoration. Losing them must not cost the user the
                    // file tree, which is the thing they came for.
                    this.badges = {};
                }
            },

            // --- the file tree ------------------------------------------------

            async ensureMount() {
                if (this.reader === 'ls') return false;      // already fell back
                if (!this.repo) return false;

                // A transient mount unit carries no environment file, so a backend
                // that needs credentials would mount and then fail to read. Falling
                // back up front beats an empty tree the user cannot explain.
                const env = Repos.envFor(this.repo);
                if (env && Object.keys(env).length) {
                    this.fallback('this repository needs backend credentials that cannot be ' +
                        'handed to a mount unit safely');
                    return false;
                }

                try {
                    const state = await L.isMounted(this.repoId);
                    if (!state.mounted) {
                        this.busyLabel = 'Mounting the repository…';
                        await L.mount({
                            repoId: this.repoId,
                            repoUrl: this.repoUrl(),
                            passwordFile: Secrets.keyPath(this.repoId),
                            // buildMountArgv insists on a positive integer, and a
                            // fractional mountIdleTimeoutSec from config would
                            // otherwise reject the mount and drop us to the slow
                            // path for a reason no user could guess.
                            maxRuntimeSec: Math.round(Math.max(600, this.idleMs() / 250))
                        });
                    }
                    this.reader = 'mount';
                    this.mountPoint = L.mountPoint(this.repoId);
                    return true;
                } catch (e) {
                    this.fallback((e && e.message) || 'the repository could not be mounted');
                    return false;
                }
            },

            // FUSE is optional on every distro hangar targets, so the slower path
            // is normal rather than exceptional — but the user is told, because
            // "why is this suddenly slow" is otherwise unanswerable.
            fallback(reason) {
                this.reader = 'ls';
                this.fallbackReason = reason;
                this.mountPoint = '';
            },

            async loadTree() {
                if (!this.moment) return;
                this.busy = true;
                this.busyLabel = 'Reading the snapshot…';
                this.error = null;
                try {
                    const mounted = await this.ensureMount();
                    this.entries = mounted ? await this.readMounted() : await this.readWithLs();
                    this.rows = treeRowsFor(this.entries, this.badges);
                    this.crumbs = breadcrumbsFor(this.cwd);
                } catch (e) {
                    this.handleError(e);
                    this.rows = [];
                    // The trail still has to match what is on screen, or the user
                    // navigates relative to a directory they are not looking at.
                    this.crumbs = breadcrumbsFor(this.cwd);
                } finally {
                    this.busy = false;
                }
            },

            async readMounted() {
                const base = L.snapshotPath(this.mountPoint, this.moment.snapshot || this.moment);
                const dir = this.cwd === '/' ? base : base + this.cwd;
                const text = await spawnText(listDirArgv(dir));
                return parseFindOutput(text, this.cwd);
            },

            async readWithLs() {
                const text = await resticText('ls', this.resticOpts({
                    snapshot: this.moment.id, recursive: true, long: true
                }));
                const parsed = L.parseLsJson(text);
                this._lsNodes = parsed.nodes;
                return lsEntriesFor(parsed.nodes, this.cwd);
            },

            async open(row) {
                if (!row.isDir) return;
                this.cwd = row.path;
                this.selected = [];
                this.touchIdle();
                // The fallback already holds the whole tree, so re-reading restic
                // for a folder the user just opened would be pure waiting.
                if (this.reader === 'ls' && this._lsNodes) {
                    this.entries = lsEntriesFor(this._lsNodes, this.cwd);
                    this.rows = treeRowsFor(this.entries, this.badges);
                    this.crumbs = breadcrumbsFor(this.cwd);
                    return;
                }
                await this.loadTree();
            },

            async goTo(path) {
                this.cwd = normalizePath(path);
                this.selected = [];
                if (this.reader === 'ls' && this._lsNodes) {
                    this.entries = lsEntriesFor(this._lsNodes, this.cwd);
                    this.rows = treeRowsFor(this.entries, this.badges);
                    this.crumbs = breadcrumbsFor(this.cwd);
                    return;
                }
                await this.loadTree();
            },

            // --- selection ----------------------------------------------------

            isSelected(row) {
                if (!row || typeof row !== 'object') return false;
                return this.selected.some((r) => r && r.path === row.path);
            },

            toggle(row) {
                // A row with no path cannot be restored — it would become '/' in the
                // include list, which is the whole snapshot.
                if (!row || typeof row !== 'object' || !row.path) return;
                this.touchIdle();
                this.selected = this.isSelected(row)
                    ? this.selected.filter((r) => r && r.path !== row.path)
                    : this.selected.concat([row]);
            },

            selectionLabel() {
                return selectionSummary(this.selected);
            },

            // --- restore ------------------------------------------------------

            async restore() {
                if (!this.selected.length || !this.moment) return;
                // The dialog answers through an event listener that only exists if
                // boot.js injected the partial. Without it the await never settles,
                // so the button would look broken rather than report a problem.
                if (!modalPresent(RESTORE_MODAL_ID)) {
                    this.handleError(fail('The restore dialog did not load, so nothing can be restored yet. ' +
                        'Reload the page and try again.'));
                    return;
                }
                const plan = await restoreDialog({
                    selection: this.selected,
                    snapshot: this.moment.id,
                    momentLabel: this.moment.absolute,
                    summary: this.selectionLabel()
                });
                if (!plan) return;                          // dismissed
                await this.runRestore(plan);
            },

            async runRestore(plan) {
                this.busy = true;
                this.busyLabel = 'Restoring…';
                this.clearStatus();
                this.progress = null;
                try {
                    const result = await R.run('restore', this.resticOpts({
                        snapshot: plan.snapshot,
                        target: plan.target,
                        include: plan.include,
                        verify: plan.verify
                    }), (p) => { this.progress = p; });

                    // Exit 3 wrote the files it could read. That is a partial
                    // success with a list, not a failure: it is a warning naming
                    // what was skipped, never the red alert (design §8).
                    const status = result && result.status;
                    if (status === 'partial') {
                        this.unreadable = unreadableFromMessages(result.errors);
                        this.unreadableTitle = 'Some files could not be read.';
                        this.showUnreadable = true;
                        this.noticeKind = 'warning';
                        this.notice = 'Restored to ' + plan.target +
                            ', but some files could not be read.';
                    } else if (status === 'cancelled') {
                        // Cancelling is a decision, not a failure.
                        this.noticeKind = 'info';
                        this.notice = 'The restore was cancelled.';
                    } else {
                        this.noticeKind = 'success';
                        this.notice = 'Restored to ' + plan.target + '.';
                    }
                } catch (e) {
                    this.handleError(e);
                } finally {
                    this.busy = false;
                    this.busyLabel = '';
                    this.progress = null;
                }
            },

            // --- remediation --------------------------------------------------

            // Every remediation HangarErrors can emit is answered here. An action
            // that only clears the error and retries is still spelled out, because
            // silently doing nothing on a button the user pressed is the failure
            // mode this whole design is trying to avoid.
            async remediate() {
                const action = this.error && this.error.action;
                if (!action) return;

                if (action === 'list-unreadable') {
                    this.showUnreadable = !this.showUnreadable;
                    if (this.showUnreadable && !this.unreadable.length) {
                        this.unreadable = ['restic did not name the files it could not read; ' +
                            'the run log in journald has the detail.'];
                        this.unreadableTitle = 'Some files could not be read.';
                    }
                    return;
                }

                if (action === 'free-space') {
                    // hangar cannot free space on the user's behalf, and pretending
                    // to would be worse than naming the destination that is full.
                    this.noticeKind = 'warning';
                    this.notice = 'Free space on the backup destination, then try again: ' +
                        Repos.describe(this.repo);
                    return;
                }

                this.busy = true;
                this.busyLabel = 'Working…';
                let done = false;
                try {
                    if (action === 'unlock') {
                        await R.run('unlock', this.resticOpts());
                        done = true;
                    } else if (action === 'init') {
                        await R.run('init', this.resticOpts());
                        done = true;
                    } else if (action === 'reprompt') {
                        const prompt = dialogs().passwordDialog;
                        if (typeof prompt !== 'function')
                            throw fail('The password dialog did not load. Reload the page and try again.');
                        const pw = await prompt({
                            repoLabel: this.repoId,
                            error: this.error.message
                        });
                        // Dismissing the prompt fixed nothing, so the error stays.
                        // Clearing it here would claim the password was accepted.
                        if (pw) {
                            await Secrets.writeKey(this.repoId, pw);
                            done = true;
                        }
                    } else {
                        done = true;                    // 'retry' and anything new
                    }
                    if (done) this.error = null;
                } catch (e) {
                    this.handleError(e);
                    done = false;
                } finally {
                    this.busy = false;
                    this.busyLabel = '';
                }
                if (done && !this.error) await this.loadSnapshots();
            }
        };
    }

    // ---- the restore modal component ---------------------------------------

    // Its own component rather than state on the screen, matching confirm.html and
    // password.html: the partial is injected once by boot.js and driven by an
    // event, so nothing has to reach across component boundaries.
    function hangarRestore() {
        return {
            open: false,
            mode: DEFAULT_RESTORE_MODE,
            target: DEFAULT_RESTORE_TARGET,
            selection: [],
            snapshot: '',
            momentLabel: '',
            summary: '',
            dialogError: '',
            _resolve: null,

            init() {
                if (!root.addEventListener) return;
                root.addEventListener('hangar:restore', (ev) => {
                    const o = (ev && ev.detail) || {};
                    this.selection = Array.isArray(o.selection) ? o.selection : [];
                    this.snapshot = str(o.snapshot);
                    this.momentLabel = str(o.momentLabel);
                    this.summary = o.summary || selectionSummary(this.selection);
                    this.mode = DEFAULT_RESTORE_MODE;
                    this.target = o.defaultTarget || DEFAULT_RESTORE_TARGET;
                    this.dialogError = '';
                    this._resolve = o.resolve || null;
                    this.open = true;
                    showModal(RESTORE_MODAL_ID);
                });
            },

            // The list the modal shows is the list restic will be given, not the
            // raw selection: an entry that names nothing is dropped by the plan, so
            // showing it here would promise a file that is not going to be written.
            selectionPaths() { return includePathsFrom(this.selection); },

            plan() {
                try {
                    return restorePlan(this.selection, this.mode, this.target, { snapshot: this.snapshot });
                } catch (e) {
                    return {
                        valid: false, destructive: false,
                        problems: [str(e && e.message) || 'That restore cannot be planned.'],
                        warnings: [], include: [], target: ''
                    };
                }
            },

            warnings() { return this.plan().warnings; },
            problems() { return this.plan().problems; },
            valid() { return this.plan().valid; },

            async submit() {
                this.dialogError = '';
                const plan = this.plan();
                if (!plan.valid) return;
                // The destructive path is confirmed separately, in the shared
                // danger dialog, so it cannot be reached by muscle memory on a
                // button that usually does something safe.
                if (plan.destructive) {
                    const confirm = dialogs().confirmDialog;
                    // Fail closed and say so. Proceeding without the confirmation
                    // would overwrite the running system on a single click.
                    if (typeof confirm !== 'function') {
                        this.dialogError = 'The confirmation dialog did not load, so an ' +
                            'original-location restore cannot be confirmed. Reload the page, ' +
                            'or restore into a different directory instead.';
                        return;
                    }
                    let okay = false;
                    try {
                        okay = await confirm({
                            danger: true,
                            title: 'Restore over the original files?',
                            message: 'This writes ' + plan.include.length +
                                ' selected item(s) back to their original locations.',
                            detail: 'Anything currently at those paths is replaced.',
                            confirmLabel: 'Replace files'
                        });
                    } catch (e) {
                        this.dialogError = str(e && e.message) ||
                            'The confirmation dialog failed, so nothing was restored.';
                        return;
                    }
                    if (!okay) return;
                }
                hideModal(RESTORE_MODAL_ID);
                this.open = false;
                const resolve = this._resolve;
                this._resolve = null;
                if (resolve) resolve(plan);
            },

            cancel() {
                hideModal(RESTORE_MODAL_ID);
                this.open = false;
                this.dialogError = '';
                const resolve = this._resolve;
                this._resolve = null;
                if (resolve) resolve(null);
            }
        };
    }

    function restoreDialog(opts) {
        return new Promise((resolve) => {
            if (!root.dispatchEvent) {
                resolve(null);
                return;
            }
            root.dispatchEvent(new CustomEvent('hangar:restore',
                { detail: Object.assign({}, opts, { resolve: resolve }) }));
        });
    }

    // ---- DOM helpers (guarded; no-ops under node) ---------------------------

    // The restore dialog answers through an event listener that only exists once
    // boot.js has injected the partial, so "is the element there" is the only
    // honest test of whether awaiting it will ever settle.
    function modalPresent(id) {
        if (!root.document || typeof root.document.getElementById !== 'function') return false;
        return !!root.document.getElementById(id);
    }

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

    // ---- the screen markup --------------------------------------------------

    // A string rather than a fetched partial: boot.js only injects modals, and a
    // second loader for screens would be a second thing to keep in sync.
    function template() {
        return '' +
'<div class="hangar-logbook" x-data="hangarLogbookUi()" x-init="init()" x-effect="onScreenChange(tab)">' +

'  <div class="hangar-tree d-flex flex-column">' +

'    <div class="d-flex align-items-center gap-2 p-2 border-bottom flex-wrap">' +
'      <label class="form-label mb-0 small text-secondary" for="hangar-logbook-repo">Repository</label>' +
'      <select id="hangar-logbook-repo" class="form-select form-select-sm w-auto"' +
'              x-model="repoId" @change="selectRepo(repoId)">' +
'        <template x-for="r in repos" :key="r.id">' +
'          <option :value="r.id" x-text="r.id"></option>' +
'        </template>' +
'      </select>' +

'      <nav aria-label="Snapshot path" class="flex-grow-1">' +
'        <ol class="breadcrumb mb-0 small">' +
'          <template x-for="(c, i) in crumbs" :key="c.path">' +
'            <li class="breadcrumb-item">' +
'              <button type="button" class="btn btn-link btn-sm p-0 align-baseline"' +
'                      @click="goTo(c.path)" x-text="c.label"></button>' +
'            </li>' +
'          </template>' +
'        </ol>' +
'      </nav>' +

'      <button type="button" class="btn btn-sm btn-primary"' +
'              :disabled="!selected.length || busy" @click="restore()">Restore…</button>' +
'      <span class="small text-secondary" x-text="selectionLabel()"></span>' +
'    </div>' +

'    <div x-show="busy" class="p-2 small text-secondary" role="status" aria-live="polite">' +
'      <span x-text="busyLabel"></span>' +
'      <span class="hangar-mono ms-2" x-show="progressLabel()" x-text="progressLabel()"></span>' +
'    </div>' +

'    <div x-show="reader === \'ls\'" class="alert alert-info m-2 py-2 px-3 small mb-0">' +
'      Browsing without a mount, which is slower: <span x-text="fallbackReason"></span>.' +
'    </div>' +

'    <div x-show="notice" :class="noticeClass()" class="m-2 py-2 px-3 small mb-0"' +
'         role="status" aria-live="polite" x-text="notice"></div>' +

     // A partial result is a warning that names what was skipped — never the
     // failure colour. The list itself is behind the "Show unreadable files"
     // remediation so a thousand-line list cannot bury the rest of the screen.
'    <div x-show="unreadable.length" class="alert alert-warning m-2 py-2 px-3 small mb-0"' +
'         role="status" aria-live="polite">' +
'      <div class="d-flex align-items-center gap-3">' +
'        <strong class="flex-grow-1" x-text="unreadableTitle || \'Some files could not be read.\'"></strong>' +
'        <button type="button" class="btn btn-sm btn-outline-secondary"' +
'                @click="showUnreadable = !showUnreadable" :aria-expanded="showUnreadable"' +
'                aria-controls="hangar-logbook-unreadable"' +
'                x-text="showUnreadable ? \'Hide the list\' : \'Show the list\'"></button>' +
'      </div>' +
'      <ul id="hangar-logbook-unreadable" class="mb-0 mt-1 hangar-mono" x-show="showUnreadable">' +
'        <template x-for="u in unreadable" :key="u"><li x-text="u"></li></template>' +
'      </ul>' +
'    </div>' +

'    <div x-show="error" :class="errorClass()" class="m-2 py-2 px-3 mb-0" role="alert">' +
'      <div class="d-flex align-items-center gap-3">' +
'        <div class="flex-grow-1 small" x-text="error && error.message"></div>' +
'        <button type="button" class="btn btn-sm"' +
'                :class="error && error.fatal ? \'btn-outline-danger\' : \'btn-outline-secondary\'"' +
'                x-show="error && error.action" @click="remediate()"' +
'                x-text="error && error.actionLabel"></button>' +
'      </div>' +
'    </div>' +

'    <div class="flex-grow-1 overflow-auto">' +
'      <div x-show="!rows.length && !busy" class="hangar-empty">' +
'        Nothing to show here.' +
'      </div>' +
'      <table class="table table-sm table-hover mb-0" x-show="rows.length">' +
'        <thead>' +
'          <tr>' +
'            <th scope="col" class="w-auto"><span class="visually-hidden">Selected</span></th>' +
'            <th scope="col">Name</th>' +
'            <th scope="col" class="text-end">Size</th>' +
'            <th scope="col">Modified (UTC)</th>' +
'          </tr>' +
'        </thead>' +
'        <tbody>' +
'          <template x-for="row in rows" :key="row.key">' +
'            <tr>' +
'              <td>' +
'                <input type="checkbox" class="form-check-input" :id="\'sel-\' + row.key"' +
'                       :checked="isSelected(row)" @change="toggle(row)">' +
'                <label class="visually-hidden" :for="\'sel-\' + row.key"' +
'                       x-text="\'Select \' + row.name"></label>' +
'              </td>' +
'              <td>' +
'                <button type="button" class="btn btn-link btn-sm p-0 align-baseline"' +
'                        x-show="row.isDir" @click="open(row)" x-text="row.name"></button>' +
'                <span x-show="!row.isDir" x-text="row.name"></span>' +
'                <span x-show="row.badge" :class="row.badgeClass" x-text="row.badge"></span>' +
'              </td>' +
'              <td class="text-end hangar-mono" x-text="row.sizeLabel"></td>' +
'              <td class="hangar-mono" x-text="row.mtimeLabel"></td>' +
'            </tr>' +
'          </template>' +
'        </tbody>' +
'      </table>' +
'    </div>' +
'  </div>' +

     // A listbox may only own options and groups, so each band is a labelled
     // group rather than a bare div — otherwise the options are orphaned and a
     // screen reader announces a listbox with nothing in it. The band heading is
     // hidden from the accessibility tree because the group label already says it.
'  <div class="hangar-scrubber" role="listbox" aria-label="Snapshot moments">' +
'    <div x-show="!bands.length" class="small text-secondary p-2">No snapshots yet.</div>' +
'    <template x-for="band in bands" :key="band.key">' +
'      <div role="group" :aria-label="band.label">' +
'        <div class="hangar-band-label" aria-hidden="true" x-text="band.label"></div>' +
'        <template x-for="m in band.moments" :key="m.id || m.absolute">' +
'          <button type="button" class="hangar-moment" role="option"' +
'                  :class="{ active: isActive(m) }" :aria-selected="isActive(m)"' +
'                  @click="selectMoment(m)">' +
'            <span x-text="m.absolute"></span>' +
'            <span class="rel" x-text="m.relative"></span>' +
'          </button>' +
'        </template>' +
'      </div>' +
'    </template>' +
'  </div>' +

'</div>';
    }

    // Idempotent: a container that already has markup belongs to whoever put it
    // there, and overwriting it would tear down a live Alpine tree. The assigned
    // string is the first-party constant above — no interpolation, no user data —
    // which is the same footing as boot.js injecting the modal partials.
    function mount(container) {
        const el = container ||
            (root.document && root.document.getElementById(CONTAINER_ID));
        if (!el || el.firstElementChild) return false;
        el.innerHTML = template();
        return true;
    }

    function autoMount() {
        if (!root.document) return;
        if (root.document.readyState === 'loading')
            root.document.addEventListener('DOMContentLoaded', function () { mount(); });
        else mount();
    }

    // Nothing above ran on load; this is the single deferred hook, and it is a
    // no-op under node because there is no document.
    autoMount();

    root.hangarLogbookUi = hangarLogbookUi;
    root.hangarRestore = hangarRestore;

    const API = {
        // pure
        treeRowsFor, selectionSummary, restorePlan,
        timelineModel, momentFor, lsEntriesFor, parseFindOutput, listDirArgv,
        breadcrumbsFor, parentOf, joinPath, normalizePath,
        formatBytes, absoluteLabel, clockLabel, badgeClassFor, remediationLabel,
        errorView, errorAlertClass, noticeAlertClass,
        unreadableFromMessages, unreadableFromError,
        compareEntries, includePathsFrom, template,
        // components and glue
        hangarLogbookUi, hangarRestore, restoreDialog, mount,
        RESTORE_MODES, DEFAULT_RESTORE_MODE, DEFAULT_RESTORE_TARGET,
        CONTAINER_ID, RESTORE_MODAL_ID
    };
    Object.assign(hangarLogbookUi, API);
    if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
