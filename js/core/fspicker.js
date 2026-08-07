// core/fspicker.js — the shared filesystem browser behind every path field.
//
// hangar asks for a lot of absolute paths: where a local repository lives, what a
// job backs up, what it excludes, where a restore lands, where a rescue image is
// written, where snapshots are mounted. Typing those by hand is where typos become
// "backed up the wrong directory for three weeks", so every one of them gets a
// Browse button and they all come here.
//
// Two decisions worth stating:
//
//  1. Listing asks for superuser but does not demand it ('try', not 'require').
//     hangar's backups run as root from a systemd unit and legitimately target
//     /srv, /var/lib and other places a normal user cannot even enumerate, so the
//     escalation is worth having. Demanding it was wrong though: in a session
//     without administrative access every listing was refused outright and the
//     dialog was useless, when showing what the user CAN see is strictly better
//     than showing nothing. Creating a folder still requires it — that is a write,
//     and a write that half-works is worse than one that is refused.
//
//  2. Entries are parsed from a NUL-separated `find` listing, not a newline one.
//     A newline is a legal character in a filename, and a picker that splits on it
//     turns one oddly-named directory into two fake ones.
'use strict';
(function (root) {
    const E = root.HangarErrors ||
        (typeof require === 'function' ? require('./errors.js') : null);

    // What a given field is asking for. A repository path is a directory; an
    // exclude file is a file; a backup source may be either.
    const MODES = {
        dir: { id: 'dir', label: 'Choose a folder', accepts: 'd' },
        file: { id: 'file', label: 'Choose a file', accepts: 'f' },
        any: { id: 'any', label: 'Choose a file or folder', accepts: 'df' }
    };

    // Record separator 0x1E, not NUL. This is measured, not preferred:
    // cockpit.spawn's text channel DISCARDS output containing NUL bytes. Asking
    // find for '%y\t%f\0' against a real Cockpit session resolves with an empty
    // string — not an error, not a truncated listing, nothing — so the picker
    // reported every folder on the machine as empty. The same command with
    // '%y\t%f\036' returns all 20 records.
    //
    //   NUL separated: 0 chars
    //   RS  separated: 129 chars, 20 tabs, 20 separators
    //
    // NUL would be the only separator a filename cannot contain, and it is still
    // accepted when splitting so nothing that already works breaks. It is not
    // what hangar asks for: a filename containing 0x1E is a theoretical problem,
    // and a listing that arrives empty is one that actually happened.
    const RS = '\u001e';
    const NUL = '\u0000';

    const DEFAULT_MODE = 'dir';
    const ROOT = '/';

    function fail(message, detail) {
        if (E && typeof E.create === 'function') return E.create('GENERIC', message, detail || null);
        const e = new Error(message);
        e.name = 'HangarError';
        e.kind = 'GENERIC';
        return e;
    }

    function str(v) {
        if (v === null || v === undefined) return '';
        try { return String(v); } catch (e) { return ''; }
    }

    function modeFor(id) {
        return Object.prototype.hasOwnProperty.call(MODES, id) ? MODES[id] : MODES[DEFAULT_MODE];
    }

    function modes() { return Object.keys(MODES).map(function (k) { return MODES[k]; }); }

    // ---- pure: paths -------------------------------------------------------

    // Collapses '.', '..' and repeated slashes without ever escaping above '/'.
    // Done here rather than trusting the shell so a crafted path cannot walk out
    // of the tree the caller believes it is browsing.
    function normalizePath(p) {
        const raw = str(p).trim();
        if (raw === '') return ROOT;
        const absolute = raw.charAt(0) === '/';
        const out = [];
        raw.split('/').forEach(function (part) {
            if (part === '' || part === '.') return;
            if (part === '..') { out.pop(); return; }
            out.push(part);
        });
        return (absolute ? '/' : '') + out.join('/') || ROOT;
    }

    function joinPath(dir, name) {
        const d = normalizePath(dir);
        const n = str(name);
        if (n === '') return d;
        return normalizePath(d === ROOT ? '/' + n : d + '/' + n);
    }

    function parentOf(p) {
        const n = normalizePath(p);
        if (n === ROOT) return ROOT;
        const i = n.lastIndexOf('/');
        return i <= 0 ? ROOT : n.slice(0, i);
    }

    // Clickable path segments, so a user three levels deep can jump back in one go.
    function breadcrumbs(p) {
        const n = normalizePath(p);
        const crumbs = [{ label: '/', path: ROOT }];
        if (n === ROOT) return crumbs;
        let acc = '';
        n.split('/').filter(Boolean).forEach(function (part) {
            acc += '/' + part;
            crumbs.push({ label: part, path: acc });
        });
        return crumbs;
    }

    // A path that reaches a command line. Newlines and NULs are rejected rather
    // than escaped: neither belongs in a path a user is choosing, and both are how
    // a name turns into a second argument.
    function validatePath(p) {
        const raw = str(p);
        if (raw.trim() === '') return ['A path is required.'];
        if (/[\u0000\r\n]/.test(raw)) return ['A path cannot contain newlines or NUL bytes.'];
        if (raw.trim().charAt(0) !== '/') return ['The path must be absolute, starting with "/".'];
        return [];
    }

    // ---- pure: listing -----------------------------------------------------

    // NUL-separated, and type-tagged so directories can be shown first and files
    // filtered by mode. `-mindepth 1 -maxdepth 1` keeps it to one level, which is
    // what a browser wants and what keeps a listing of / cheap.
    function listArgv(path) {
        const dir = normalizePath(path);
        // \NNN octal is find's documented escape; \xHH is not.
        return ['find', dir, '-mindepth', '1', '-maxdepth', '1',
            '-printf', '%y\\t%f\\036'];
    }

    // Either separator ends a record: RS is what listArgv asks for, NUL is what
    // an older hangar asked for.
    const SEPARATORS = /[\u001e\u0000]/;

    // find prints "<type>\t<name>" then a record separator. 'l' is a symlink; it is reported as
    // its own type rather than resolved, because following one blindly is how a
    // picker walks into /proc.
    function parseListing(text, opts) {
        const o = opts || {};
        const wantHidden = !!o.showHidden;
        const accepts = modeFor(o.mode || DEFAULT_MODE).accepts;

        const out = [];
        str(text).split(SEPARATORS).forEach(function (chunk) {
            if (chunk === '') return;
            const tab = chunk.indexOf('\t');
            if (tab < 0) return;                       // not a line find produced
            const type = chunk.slice(0, tab);
            const name = chunk.slice(tab + 1);
            if (name === '' || name === '.' || name === '..') return;
            if (!wantHidden && name.charAt(0) === '.') return;

            const isDir = type === 'd';
            // A symlink is browsable: whether it leads to a directory is decided
            // when it is opened, not guessed at here.
            const selectable = isDir ? accepts.indexOf('d') >= 0
                : accepts.indexOf('f') >= 0;
            out.push({ name: name, type: type, isDir: isDir, selectable: selectable });
        });

        // Folders first, then case-insensitive by name: the order people expect
        // from every other file browser they have used.
        out.sort(function (a, b) {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });
        return out;
    }

    // Did find produce records this parser understood? A folder holding only
    // hidden files legitimately yields records and no entries, so the question is
    // asked about RECORDS: output that contains not one separated "<type>\t<name>"
    // is output nobody read, whatever the reason.
    //
    // A backstop, not the fix for the NUL bug above: that failure arrived as an
    // empty string, which is indistinguishable from an empty folder. This catches
    // the other shape — output that arrives and cannot be parsed — because the
    // alternative is telling the user a full filesystem is empty and sending them
    // to look for a problem with their disk.
    function looksUnparsed(text) {
        const raw = str(text);
        if (raw.trim() === '') return false;              // genuinely nothing to read
        return !raw.split(SEPARATORS).some(function (chunk) {
            return chunk.indexOf('\t') > 0;
        });
    }

    // Entries a click can descend into, versus entries a click selects.
    function isNavigable(entry) {
        return !!entry && (entry.isDir || entry.type === 'l');
    }

    // What "Choose" returns for the current state. Selecting nothing in dir mode
    // means "this folder", which is what a destination picker should do — it saves
    // the user descending into a folder and then hunting for a way to pick it.
    function chosenPath(cwd, selected, mode) {
        const m = modeFor(mode);
        if (selected && selected.name) return joinPath(cwd, selected.name);
        if (m.accepts.indexOf('d') >= 0) return normalizePath(cwd);
        return '';
    }

    function canChoose(cwd, selected, mode) {
        return chosenPath(cwd, selected, mode) !== '';
    }

    // Validates rather than trusting the caller: makeFolder checks first, but a
    // name containing '/' reaching here would be silently normalised into a path
    // somewhere else instead of being refused, and this function is exported.
    function mkdirArgv(dir, name) {
        const problems = validateFolderName(name);
        if (problems.length) throw fail(problems[0], { name: name });
        // '--' terminates options so a leading-dash name cannot become a flag.
        return ['mkdir', '-p', '--', joinPath(dir, name)];
    }

    // A new folder's name, not a path: a separator here would silently create a
    // tree somewhere else.
    function validateFolderName(name) {
        const n = str(name).trim();
        if (n === '') return ['A folder name is required.'];
        if (n === '.' || n === '..') return ['That name is reserved.'];
        if (n.indexOf('/') >= 0) return ['A folder name cannot contain "/".'];
        if (/[\u0000\r\n]/.test(n)) return ['A folder name cannot contain newlines or NUL bytes.'];
        if (n.length > 255) return ['That name is too long.'];
        return [];
    }

    // ---- impure: thin transport -------------------------------------------

    function hasCockpit() {
        return typeof cockpit !== 'undefined' && cockpit && typeof cockpit.spawn === 'function';
    }

    // 'try', not 'require': see the note at the top of this file.
    function list(path, opts) {
        if (!hasCockpit()) return Promise.reject(fail('cockpit is not available in this context.'));
        return Promise.resolve(
            cockpit.spawn(listArgv(path), { superuser: 'try', err: 'message' })
        ).then(function (out) {
            if (looksUnparsed(out))
                throw fail('That folder was listed, but the listing could not be read. ' +
                    'This is a bug in hangar, not a problem with the folder.', { path: path });
            return parseListing(out, opts);
        }).catch(function (e) {
            // An unreadable directory is an ordinary thing to click on, not a
            // failure of the picker. The caller shows it in place and stays put.
            throw fail((e && e.message) || 'That folder could not be read.', { path: path });
        });
    }

    function makeFolder(dir, name) {
        const problems = validateFolderName(name);
        if (problems.length) return Promise.reject(fail(problems[0], { name: name }));
        if (!hasCockpit()) return Promise.reject(fail('cockpit is not available in this context.'));
        return Promise.resolve(
            cockpit.spawn(mkdirArgv(dir, name), { superuser: 'require', err: 'message' })
        ).then(function () { return joinPath(dir, name); });
    }

    const HangarFsPicker = {
        MODES, DEFAULT_MODE, ROOT,
        modeFor, modes,
        normalizePath, joinPath, parentOf, breadcrumbs, validatePath,
        listArgv, parseListing, looksUnparsed, isNavigable, chosenPath, canChoose,
        mkdirArgv, validateFolderName,
        list, makeFolder
    };
    root.HangarFsPicker = HangarFsPicker;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarFsPicker;
})(typeof window !== 'undefined' ? window : globalThis);
