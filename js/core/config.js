// core/config.js — reading and writing hangar's on-disk configuration.
//
// hangar has no database: /etc/hangar/**.json IS the state, and this module is the
// only thing that touches it. Everything here that decides a path is pure, so the
// id-validation guard below is unit testable without a filesystem.
'use strict';
(function (root) {
    const E = root.HangarErrors || (typeof require !== 'undefined' ? require('./errors.js') : null);

    const CONF_DIR = '/etc/hangar';
    const STATE_DIR = '/var/lib/hangar/state';

    // Ids become filenames and systemd unit instance names, so the safe set is
    // deliberately narrow. Rejecting here means no caller has to think about
    // traversal or shell quoting.
    const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

    function validateId(id) {
        if (typeof id !== 'string' || !ID_RE.test(id)) {
            throw E.create('GENERIC',
                'Invalid id: must be 1-63 characters of a-z, 0-9 or "-", starting with a letter or digit.',
                { id: id });
        }
        return id;
    }

    function repoPath(id)   { return CONF_DIR + '/repos/' + validateId(id) + '.json'; }
    function jobPath(id)    { return CONF_DIR + '/jobs/' + validateId(id) + '.json'; }
    function statePath(id)  { return STATE_DIR + '/' + validateId(id) + '.json'; }
    function globalPath()   { return CONF_DIR + '/config.json'; }
    function drPath()       { return CONF_DIR + '/dr.json'; }

    const DEFAULT_GLOBAL = {
        version: 1,
        // 'system' follows the OS/Cockpit preference; see js/core/themes.js.
        theme: 'system',
        mountRoot: '/run/hangar/mnt',
        mountIdleTimeoutSec: 900,
        // How long a measured repository size is trusted before it is taken
        // again. `restic stats` reads the whole repository — 50 to 118 seconds
        // against a NAS over SFTP — so the number is remembered and shown with
        // the time it was taken. A day is the default because the nightly
        // backup measures the size anyway for its size guard, and a size that
        // moved during the day is still a size from this morning. 0 means never
        // refresh on its own; the Measure now button always works.
        repoSizeMaxAgeHours: 24,
        notifyOnFailure: true,
        // Self-update. This is hangar's own upstream, so a fresh install can offer
        // updates without being configured first. Note the consequence: the plugin
        // contacts api.github.com once on page load. Clearing this field disables
        // update checking entirely and stops all outbound requests.
        updateRepo: 'ismetozalp/hangar',
        updateCheckOnStartup: true
    };

    // Pure: merge stored settings over defaults, dropping unknown keys so a config
    // written by a newer hangar cannot inject surprises into an older one.
    function mergeGlobal(stored) {
        const out = Object.assign({}, DEFAULT_GLOBAL);
        if (stored && typeof stored === 'object') {
            Object.keys(DEFAULT_GLOBAL).forEach(function (k) {
                if (stored[k] !== undefined && stored[k] !== null) out[k] = stored[k];
            });
        }
        return out;
    }

    // Pure: a job is only runnable when it names a repo, has at least one source
    // and has a retention policy that keeps something.
    function validateJob(job) {
        const problems = [];
        if (!job || typeof job !== 'object') return ['Job is empty.'];
        try { validateId(job.id); } catch (e) { problems.push('Job id is invalid.'); }
        if (!job.repo) problems.push('Job does not name a repository.');
        else { try { validateId(job.repo); } catch (e) { problems.push('Repository id is invalid.'); } }
        if (!Array.isArray(job.sources) || job.sources.length === 0)
            problems.push('Job has no sources.');
        return problems;
    }

    // ---- I/O layer ------------------------------------------------------
    // Guarded so the module loads under node for unit testing the pure parts.

    function hasCockpit() { return typeof cockpit !== 'undefined'; }

    function file(path, opts) {
        if (!hasCockpit()) throw E.create('GENERIC', 'cockpit is not available in this context.');
        return cockpit.file(path, Object.assign({ superuser: 'require' }, opts || {}));
    }

    // Cockpit reports a refused privileged channel as problem 'access-denied';
    // the message is matched too because the same refusal arrives from `ls`
    // itself when the bridge is unprivileged.
    function isAccessDenied(e) {
        if (!e) return false;
        if (e.problem === 'access-denied') return true;
        return /not permitted|permission denied|access denied/i.test(String(e.message || ''));
    }

    function adminRequired(what) {
        const E = root.HangarErrors ||
            (typeof require === 'function' ? require('./errors.js') : null);
        const message = 'hangar could not read ' + what + ': Cockpit is running with ' +
            'limited access. Turn on administrative access in Cockpit, then try again.';
        if (E && typeof E.create === 'function') return E.create('ADMIN_REQUIRED', message, { path: what });
        const e = new Error(message);
        e.name = 'HangarError';
        e.kind = 'ADMIN_REQUIRED';
        return e;
    }

    async function readJson(path, fallback) {
        try {
            const text = await file(path).read();
            if (text === null || text === '') return fallback === undefined ? null : fallback;
            return JSON.parse(text);
        } catch (e) {
            // A fallback means "not configured yet". It does not mean "pretend the
            // refusal was an absence": settings silently reverting to defaults, or
            // a repository reading as missing, is how limited access disguised
            // itself as an empty install.
            if (isAccessDenied(e)) throw adminRequired(path);
            if (fallback !== undefined) return fallback;
            throw E.create('GENERIC', 'Could not read ' + path, { error: String(e) });
        }
    }

    // Directory modes, mirroring `make install`. repos/ is 0700 because it holds
    // repository passwords alongside the definitions; the rest is world-readable
    // configuration.
    const DIR_MODE = { [CONF_DIR + '/repos']: '0700' };

    function dirModeFor(dir) {
        return Object.prototype.hasOwnProperty.call(DIR_MODE, dir) ? DIR_MODE[dir] : '0755';
    }

    // hangar may never have been installed with `make install` — a symlink into
    // ~/.local/share/cockpit is a perfectly normal way to run it, and that path
    // never creates /etc/hangar. Without this, the FIRST save of anything at all —
    // a theme, a repository, a job — fails with a bare "not-found" and the plugin
    // looks broken out of the box.
    //
    // Created before the write rather than after a failure, and with an explicit
    // mode, because the file lands under the bridge's umask: a repository
    // definition must not be world-readable for the window between create and
    // chmod. js/core/secrets.js does the same for the key itself.
    async function ensureDirFor(path) {
        const dir = String(path).slice(0, String(path).lastIndexOf('/')) || CONF_DIR;
        if (!hasCockpit()) throw E.create('GENERIC', 'cockpit is not available in this context.');
        await cockpit.spawn(
            ['install', '-d', '-m', dirModeFor(dir), '-o', 'root', '-g', 'root', dir],
            { superuser: 'require', err: 'message' });
        return dir;
    }

    async function writeJson(path, value, mode) {
        await ensureDirFor(path);
        // replace() is atomic in cockpit.file, so a half-written config is never
        // visible to hangar-run or another browser tab.
        const opts = mode ? { superuser: 'require', mode: mode } : { superuser: 'require' };
        try {
            await cockpit.file(path, opts).replace(JSON.stringify(value, null, 2) + '\n');
        } catch (e) {
            // cockpit surfaces raw problem codes like "not-found" and "access-denied".
            // On their own they read as a bug in hangar rather than as something the
            // operator can act on.
            throw E.create('GENERIC', writeFailureText(e, path), { path: path, cause: String(e) });
        }
    }

    // Turns a cockpit problem code into a sentence that says what to do.
    function writeFailureText(e, path) {
        const problem = (e && (e.problem || e.message)) ? String(e.problem || e.message) : '';
        if (/access-denied|permission/i.test(problem))
            return 'Permission denied writing ' + path + '. Administrative access is required.';
        if (/not-found/i.test(problem))
            return 'Could not create ' + path + '. The folder it belongs in does not exist ' +
                'and could not be created.';
        if (/no-space|space/i.test(problem))
            return 'There is no space left to write ' + path + '.';
        return 'Could not write ' + path + (problem ? ': ' + problem : '.');
    }

    async function listIds(dir) {
        if (!hasCockpit()) return [];
        try {
            const out = await cockpit.spawn(['ls', '-1', dir],
                { superuser: 'require', err: 'message' });
            return String(out).split('\n')
                .map(function (n) { return n.trim(); })
                .filter(function (n) { return n.endsWith('.json'); })
                .map(function (n) { return n.slice(0, -5); })
                .filter(function (n) { return ID_RE.test(n); });
        } catch (e) {
            // A missing directory genuinely means nothing is configured yet. Being
            // REFUSED does not, and answering [] for it is how a machine with a
            // configured repository came to show "No repositories yet." — the one
            // answer a backup tool must never give wrongly.
            if (isAccessDenied(e)) throw adminRequired(dir);
            return [];
        }
    }

    const HangarConfig = {
        CONF_DIR, STATE_DIR, ID_RE, DEFAULT_GLOBAL,
        validateId, repoPath, jobPath, statePath, globalPath, drPath,
        mergeGlobal, validateJob,
        // I/O
        readJson, writeJson, listIds, ensureDirFor, dirModeFor, writeFailureText,
        isAccessDenied, adminRequired,
        listRepos:  function () { return listIds(CONF_DIR + '/repos'); },
        listJobs:   function () { return listIds(CONF_DIR + '/jobs'); },
        readRepo:   function (id) { return readJson(repoPath(id)); },
        writeRepo:  function (r) { return writeJson(repoPath(r.id), r); },
        readJob:    function (id) { return readJson(jobPath(id)); },
        writeJob:   function (j) { return writeJson(jobPath(j.id), j); },
        readState:  function (id) { return readJson(statePath(id), null); },
        readGlobal: async function () { return mergeGlobal(await readJson(globalPath(), {})); },
        writeGlobal: function (g) { return writeJson(globalPath(), mergeGlobal(g)); }
    };

    root.HangarConfig = HangarConfig;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarConfig;
})(typeof window !== 'undefined' ? window : globalThis);
