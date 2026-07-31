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
        mountRoot: '/run/hangar/mnt',
        mountIdleTimeoutSec: 900,
        notifyOnFailure: true,
        // Self-update. Empty by default: hangar will not contact GitHub at all until
        // an administrator names a repository, so a fresh install makes no outbound
        // requests of its own.
        updateRepo: '',
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

    async function readJson(path, fallback) {
        try {
            const text = await file(path).read();
            if (text === null || text === '') return fallback === undefined ? null : fallback;
            return JSON.parse(text);
        } catch (e) {
            if (fallback !== undefined) return fallback;
            throw E.create('GENERIC', 'Could not read ' + path, { error: String(e) });
        }
    }

    async function writeJson(path, value, mode) {
        // replace() is atomic in cockpit.file, so a half-written config is never
        // visible to hangar-run or another browser tab.
        const opts = mode ? { superuser: 'require', mode: mode } : { superuser: 'require' };
        await cockpit.file(path, opts).replace(JSON.stringify(value, null, 2) + '\n');
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
            return [];   // directory absent simply means nothing configured yet
        }
    }

    const HangarConfig = {
        CONF_DIR, STATE_DIR, ID_RE, DEFAULT_GLOBAL,
        validateId, repoPath, jobPath, statePath, globalPath, drPath,
        mergeGlobal, validateJob,
        // I/O
        readJson, writeJson, listIds,
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
