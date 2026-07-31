// core/secrets.js — the single choke point for repository secret material.
//
// Every path that can touch a repository password goes through here, so a TPM
// backend can replace the storage later without a single caller changing. The
// corollary is a rule: no other module may build `/etc/hangar/repos/<id>.key`
// by string concatenation.
//
// The password never becomes an argv element and never leaves a pure function:
// restic gets `--password-file`, systemd gets `LoadCredential=`. That keeps the
// secret out of /proc/<pid>/cmdline (world-readable) and out of journald.
'use strict';
(function (root) {
    // index.html loads errors.js ahead of us; under node we pull it in directly
    // so this module stands alone in unit tests.
    const E = root.HangarErrors ||
        (typeof require === 'function' ? require('./errors.js') : null);

    const REPO_DIR = '/etc/hangar/repos';
    const KEY_SUFFIX = '.key';
    const KEY_MODE = '0600';
    const KEY_OWNER = 'root:root';
    const DIR_MODE = '0700';
    const CRED_PREFIX = 'hangar-repo-';
    const CRED_DIR = '%d';          // systemd specifier for $CREDENTIALS_DIRECTORY
    const MASK = '***';
    const MAX_ID_LEN = 64;

    // A whitelist, never a blacklist: the id is interpolated into a filesystem
    // path, a systemd credential name and a unit-file line, so anything outside
    // this set is rejected rather than escaped. The leading character excludes
    // '-' as well, because an id that starts with a dash turns into an option
    // the first time some caller hands it to a command line.
    const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

    function fail(message, detail) {
        return E.create(E.KIND.GENERIC, message, detail);
    }

    // ---- pure -------------------------------------------------------------

    // The individual checks below are all subsumed by ID_RE. They exist so the
    // typed error says which hostile shape arrived, which is the difference
    // between an audit trail and a shrug.
    function validateRepoId(repoId) {
        if (typeof repoId !== 'string')
            throw fail('repository id must be a string', { type: typeof repoId });
        if (repoId === '')
            throw fail('repository id must not be empty', { repoId });
        if (repoId.length > MAX_ID_LEN)
            throw fail('repository id is too long', { length: repoId.length, max: MAX_ID_LEN });
        if (repoId.indexOf('\0') >= 0)
            throw fail('repository id contains a NUL byte', { repoId: JSON.stringify(repoId) });
        if (repoId.indexOf('/') >= 0 || repoId.indexOf('\\') >= 0)
            throw fail('repository id contains a path separator', { repoId });
        if (repoId.indexOf('..') >= 0)
            throw fail('repository id contains ".."', { repoId });
        if (!ID_RE.test(repoId))
            throw fail('repository id must match [a-z0-9-] and start with a letter or digit', { repoId });
        return repoId;
    }

    // Callers hold either the repo object or just its id. Accepting both is what
    // keeps anyone from reaching past this module for the "easy" case.
    function repoIdOf(repo) {
        if (repo && typeof repo === 'object' && !Array.isArray(repo)) return repo.id;
        return repo;                                   // validateRepoId types the failure
    }

    function keyPath(repoId) {
        return REPO_DIR + '/' + validateRepoId(repoId) + KEY_SUFFIX;
    }

    function passwordArgs(repo) {
        return ['--password-file', keyPath(repoIdOf(repo))];
    }

    function credentialName(repo) {
        return CRED_PREFIX + validateRepoId(repoIdOf(repo));
    }

    // LoadCredential= copies the key into a unit-private tmpfs owned by the unit
    // user, so the service never needs read access to /etc/hangar/repos itself.
    function credentialLines(repo) {
        const id = validateRepoId(repoIdOf(repo));
        return ['LoadCredential=' + CRED_PREFIX + id + ':' + REPO_DIR + '/' + id + KEY_SUFFIX];
    }

    // Inside the unit the key lives at %d/<name>, never at its /etc path.
    function credentialEnv(repo) {
        return { RESTIC_PASSWORD_FILE: CRED_DIR + '/' + credentialName(repo) };
    }

    function credentialEnvLines(repo) {
        const env = credentialEnv(repo);
        return Object.keys(env).map((k) => 'Environment=' + k + '=' + env[k]);
    }

    // ---- redaction --------------------------------------------------------

    const SECRET_NAME_RE =
        /(passw(?:or)?d|passphrase|secret|token|credential|(?:^|[^a-z])keys?(?:[^a-z]|$)|api[_-]?keys?)/i;
    // A location is not a secret, and blanking it destroys the one thing that
    // makes a failed run diagnosable.
    const LOCATION_NAME_RE = /(file|path|dir|directory|url)$/i;
    // LoadCredential= names a file; SetCredential= carries the value inline and
    // gets its own rule below.
    const NOT_SECRET_NAME_RE = /^(?:(?:load|set)credential|credentials?_?directory)$/i;

    // A scheme starts at a token boundary. Without that leading group the
    // scheme is attempted at every offset of a long unbroken token and each
    // attempt rescans the remainder, which is quadratic — see PAIR_RE below.
    const URL_USERINFO_RE = /(^|[^a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s/@]*@/gi;
    const SET_CREDENTIAL_RE = /(\bSetCredential\s*=\s*[^\s:]+:)\S*/gi;
    const ENVIRONMENT_LINE_RE = /^([ \t]*Environment\s*=\s*)(.*)$/gim;
    // Two details here are load-bearing, both learned the hard way.
    //
    // The name length is bounded because an unbounded greedy name is quadratic:
    // every offset inside one long unbroken token becomes a match attempt that
    // rescans the rest of the token, and a 50 kB blob in a log tail froze the
    // redactor for 15 seconds — on the UI thread. 64 is far past any real
    // credential name (AWS_SECRET_ACCESS_KEY is 21) and a longer run still
    // matches on its tail, so nothing stops being masked.
    //
    // The value alternation is ordered, and the order is the point. A closing
    // quote wins first (and may span lines, as a JSON blob does); only when
    // there is none do we fall back to "quote to end of line", because a log
    // tail truncated mid-value used to fail every alternative and hand the
    // secret through unmasked. Escapes are consumed so a password containing a
    // quote cannot terminate its own string early.
    const PAIR_RE =
        /("?)([A-Za-z_][A-Za-z0-9_.-]{0,63})\1(\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|"[^\n]*|'[^\n]*|[^\s"']+)/g;

    function isSecretName(name) {
        if (NOT_SECRET_NAME_RE.test(name)) return false;
        if (LOCATION_NAME_RE.test(name)) return false;
        return SECRET_NAME_RE.test(name);
    }

    // A value can itself be an assignment — systemd's `Environment=` wraps one,
    // and so does any journal line prefixed `stderr: `. Without descending into
    // it the outer pair consumes the inner one and the secret is never
    // inspected. The descent rewrites nothing unless something below it was
    // actually masked, so a name that is merely assignment-shaped comes back
    // byte for byte. The depth cap bounds the work on a hostile `a=b=c=...`.
    const MAX_PAIR_DEPTH = 3;

    function redactPairs(text, depth) {
        const left = depth === undefined ? MAX_PAIR_DEPTH : depth;
        return text.replace(PAIR_RE, (m, q, name, sep, value) => {
            if (isSecretName(name)) {
                const ch = value.charAt(0);
                const masked = (ch === '"' || ch === "'") ? ch + MASK + ch : MASK;
                return q + name + q + sep + masked;
            }
            if (left <= 0) return m;
            const inner = redactPairs(value, left - 1);
            return inner === value ? m : q + name + q + sep + inner;
        });
    }

    // The redactor runs on the failure path, on whatever the failure handed us.
    // A value with no primitive conversion (Object.create(null), a hostile
    // toString) must not turn "the backup failed" into an unhandled TypeError.
    function asText(value) {
        try {
            return String(value);
        } catch (e) {
            return Object.prototype.toString.call(value);
        }
    }

    // Over-masking is the safe direction: a redactor that guesses wrong and
    // hides a hostname costs a support round-trip, one that guesses wrong the
    // other way puts a repository password in a screenshot.
    function redact(text) {
        if (text === null || text === undefined) return '';
        let out = asText(text);
        out = out.replace(URL_USERINFO_RE, '$1$2:' + MASK + '@');
        out = out.replace(SET_CREDENTIAL_RE, '$1' + MASK);
        // Environment= wraps a second assignment; without this the outer pair
        // swallows the inner one and the inner value never gets inspected.
        out = out.replace(ENVIRONMENT_LINE_RE, (m, head, rest) => head + redactPairs(rest));
        return redactPairs(out);
    }

    // ---- I/O (guarded; degrades to a typed rejection under node) -----------

    function hasCockpit() {
        return typeof cockpit !== 'undefined' && !!cockpit;
    }

    function noCockpit(op) {
        return fail('cockpit is unavailable', { op });
    }

    function ioError(e, path, op) {
        if (E.isHangarError(e)) return e;
        return fail((e && e.message) || 'secret store I/O failed',
            { path, op, problem: (e && e.problem) || null });
    }

    function readKey(repoId) {
        return Promise.resolve().then(() => {
            const path = keyPath(repoIdOf(repoId));
            if (!hasCockpit()) throw noCockpit('readKey');
            const f = cockpit.file(path, { superuser: 'require' });
            return f.read()
                .then((content) => {
                    // A missing key file is not a missing repository — the repo is
                    // usually fine and only the password is gone. WRONG_PASSWORD is
                    // the kind whose remediation is "ask the user again".
                    if (content === null || content === undefined)
                        throw E.create(E.KIND.WRONG_PASSWORD, 'no stored password for this repository', { path });
                    return String(content).replace(/\r?\n$/, '');   // restic ignores one trailing newline
                })
                .then((v) => { f.close(); return v; },
                    (e) => { f.close(); throw ioError(e, path, 'readKey'); });
        });
    }

    function writeKey(repoId, password) {
        return Promise.resolve().then(() => {
            const path = keyPath(repoIdOf(repoId));
            if (typeof password !== 'string' || password === '')
                throw fail('repository password must be a non-empty string', { path });
            if (!hasCockpit()) throw noCockpit('writeKey');
            // The directory is created 0700 root:root BEFORE the write: the new
            // file lands under the bridge's umask, so without a private parent
            // there is a window where the key is world-readable until chmod runs.
            return cockpit.spawn(['install', '-d', '-m', DIR_MODE, '-o', 'root', '-g', 'root', REPO_DIR],
                { superuser: 'require', err: 'message' })
                .then(() => {
                    const f = cockpit.file(path, { superuser: 'require' });
                    // No trailing newline: the file content IS the password.
                    return f.replace(password).then(() => f.close(),
                        (e) => { f.close(); throw e; });
                })
                .then(() => cockpit.spawn(['chmod', KEY_MODE, path], { superuser: 'require', err: 'message' }))
                .then(() => cockpit.spawn(['chown', KEY_OWNER, path], { superuser: 'require', err: 'message' }))
                .then(() => path)                       // the path, never the password
                .catch((e) => { throw ioError(e, path, 'writeKey'); });
        });
    }

    function removeKey(repoId) {
        return Promise.resolve().then(() => {
            const path = keyPath(repoIdOf(repoId));
            if (!hasCockpit()) throw noCockpit('removeKey');
            const f = cockpit.file(path, { superuser: 'require' });
            // replace(null) unlinks. An already-absent key is success: removal is
            // idempotent so a half-finished repo delete can always be retried.
            return f.replace(null).then(() => { f.close(); return path; },
                (e) => { f.close(); throw ioError(e, path, 'removeKey'); });
        });
    }

    const HangarSecrets = {
        REPO_DIR, KEY_SUFFIX, KEY_MODE, KEY_OWNER, DIR_MODE,
        CRED_PREFIX, CRED_DIR, MASK, MAX_ID_LEN, ID_RE,
        validateRepoId, keyPath, passwordArgs, credentialName, credentialLines,
        credentialEnv, credentialEnvLines, redact,
        readKey, writeKey, removeKey
    };
    root.HangarSecrets = HangarSecrets;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarSecrets;
})(typeof window !== 'undefined' ? window : globalThis);
