// core/repos.js — repository model and URL handling for restic's 8 backends.
//
// Pure: buildUrl / parseUrl / validate / envFor / describe. Only listRcloneRemotes
// touches cockpit, and it degrades to [] under node.
'use strict';
(function (root) {
    // Under node the sibling module is required relative to this file; in the
    // browser errors.js has already run and put HangarErrors on the global.
    const Errors = (typeof module !== 'undefined' && module.exports)
        ? require('./errors.js')
        : root.HangarErrors;

    // core/sizeguard.js is loaded AFTER this module in index.html — it is grouped
    // with retention.js, the other thinning policy — so it cannot be captured at
    // load time. Resolved on first use instead, and a null result simply means the
    // size fields go unchecked rather than the whole module failing to load.
    function sizeGuard() {
        if (root.HangarSizeGuard) return root.HangarSizeGuard;
        if (typeof module !== 'undefined' && module.exports) return require('./sizeguard.js');
        return null;
    }

    const KINDS = ['local', 'sftp', 'rest', 's3', 'b2', 'azure', 'gs', 'rclone'];

    // Every scheme restic understands. Anything else in front of a colon is part
    // of a path, not a scheme — see parseUrl.
    const SCHEMES = ['sftp', 'rest', 's3', 'b2', 'azure', 'gs', 'rclone'];

    const REQUIRED = {
        local: ['path'],
        sftp: ['host', 'path'],
        rest: ['url'],
        s3: ['endpoint', 'bucket'],
        b2: ['bucket'],
        azure: ['container'],
        gs: ['bucket'],
        rclone: ['remote']
    };

    const KIND_LABEL = {
        local: 'Local',
        sftp: 'SFTP',
        rest: 'REST',
        s3: 'S3',
        b2: 'Backblaze B2',
        azure: 'Azure',
        gs: 'Google Cloud Storage',
        rclone: 'rclone'
    };

    const FIELD_LABEL = {
        path: 'path',
        host: 'host',
        url: 'URL',
        endpoint: 'endpoint',
        bucket: 'bucket',
        container: 'container',
        remote: 'remote'
    };

    // Credential env vars restic reads per backend. The repository password is
    // deliberately absent: it belongs to core/secrets.js and never travels in an
    // environment block, which is world-readable via /proc for the same user.
    const ENV_FIELDS = {
        s3: { accessKeyId: 'AWS_ACCESS_KEY_ID', secretAccessKey: 'AWS_SECRET_ACCESS_KEY' },
        b2: { accountId: 'B2_ACCOUNT_ID', accountKey: 'B2_ACCOUNT_KEY' },
        azure: { accountName: 'AZURE_ACCOUNT_NAME', accountKey: 'AZURE_ACCOUNT_KEY' },
        gs: { projectId: 'GOOGLE_PROJECT_ID' }
    };

    // "a endpoint" reads as a typo in the UI. Spelled out rather than derived from
    // the first letter, because "URL" is a vowel that still takes "a" ("a you-are-el").
    const FIELD_ARTICLE = { endpoint: 'an' };

    const ID_RE = /^[a-z0-9-]+$/;

    function fail(message, detail) {
        throw Errors.create(Errors.KIND.GENERIC, message, detail === undefined ? null : detail);
    }

    // The module's one coercion boundary, so it has to be total: String() throws on
    // a null-prototype object, and every caller below assumes it got a string back.
    function str(v) {
        if (v === null || v === undefined) return '';
        try {
            return String(v);
        } catch (e) {
            return '';
        }
    }

    function blank(v) {
        return str(v).trim() === '';
    }

    // A ".." component anywhere lets a repository definition escape the directory
    // an administrator thought they were confining it to.
    function hasTraversal(p) {
        return str(p).split(/[/\\]/).indexOf('..') >= 0;
    }

    // One wording, so the thrown message and the collected problem cannot drift apart.
    function missingField(kind, f) {
        return KIND_LABEL[kind] + ' repository requires ' + (FIELD_ARTICLE[f] || 'a') + ' ' + FIELD_LABEL[f] + '.';
    }

    function requireFields(repo, kind) {
        REQUIRED[kind].forEach((f) => {
            if (blank(repo[f])) fail(missingField(kind, f), { field: f, kind: kind });
        });
    }

    // Optional second segment shared by b2 / azure / gs / rclone: "<name>:<path>".
    function joinTwo(scheme, name, path) {
        return scheme + ':' + name + (str(path) === '' ? '' : ':' + str(path));
    }

    function buildUrl(repo) {
        if (!repo || typeof repo !== 'object') fail('Repository definition is missing.', repo);
        const kind = str(repo.kind);
        if (KINDS.indexOf(kind) < 0) fail('Unknown repository kind: ' + (kind || '(empty)') + '.', repo.kind);
        requireFields(repo, kind);

        switch (kind) {
        case 'local':
            return str(repo.path);
        case 'sftp':
            return 'sftp:' + (blank(repo.user) ? '' : str(repo.user) + '@') + str(repo.host) + ':' + str(repo.path);
        case 'rest':
            return 'rest:' + str(repo.url);
        case 's3':
            return 's3:' + str(repo.endpoint) + '/' + str(repo.bucket) +
                (str(repo.prefix) === '' ? '' : '/' + str(repo.prefix));
        case 'b2':
            return joinTwo('b2', str(repo.bucket), repo.prefix);
        case 'azure':
            return joinTwo('azure', str(repo.container), repo.prefix);
        case 'gs':
            return joinTwo('gs', str(repo.bucket), repo.prefix);
        case 'rclone':
            return joinTwo('rclone', str(repo.remote), repo.prefix);
        }
        return '';   // unreachable: kind was checked above
    }

    function splitTwo(rest) {
        const i = rest.indexOf(':');
        // Only the FIRST colon separates; a path is allowed to contain colons.
        if (i < 0) return [rest, ''];
        return [rest.slice(0, i), rest.slice(i + 1)];
    }

    function schemeOf(s) {
        const m = /^([A-Za-z0-9]+):/.exec(s);
        if (!m) return null;
        const scheme = m[1].toLowerCase();
        return SCHEMES.indexOf(scheme) >= 0 ? scheme : null;
    }

    function parseUrl(s) {
        if (typeof s !== 'string' || s.trim() === '') fail('Repository URL is empty.', s);

        // A local path wins over any scheme-looking prefix: "/mnt/s3:old" and
        // "C:\backups" are paths, not backends. Only the seven schemes restic
        // actually implements are treated as schemes; everything else is a path.
        const scheme = /^(\/|\.\/|\.\.\/|~)/.test(s) ? null : schemeOf(s);
        if (!scheme) return { kind: 'local', path: s };

        const rest = s.slice(scheme.length + 1);

        if (scheme === 'sftp') {
            const parts = splitTwo(rest);
            let user = '';
            let host = parts[0];
            const at = host.indexOf('@');
            if (at >= 0) {
                user = host.slice(0, at);
                host = host.slice(at + 1);
            }
            const out = { kind: 'sftp', host: host, path: parts[1] };
            if (user !== '') out.user = user;
            return out;
        }

        if (scheme === 'rest')
            return { kind: 'rest', url: rest };

        if (scheme === 's3') {
            // The endpoint may carry its own scheme (s3:https://minio.example/bucket),
            // which must not be mistaken for the endpoint/bucket separator.
            const m = /^(https?:\/\/)/i.exec(rest);
            const head = m ? m[1] : '';
            const segs = rest.slice(head.length).split('/').filter((x) => x !== '');
            const out = { kind: 's3', endpoint: head + (segs.shift() || ''), bucket: segs.shift() || '' };
            const prefix = segs.join('/');
            if (prefix !== '') out.prefix = prefix;
            return out;
        }

        const two = splitTwo(rest);
        const nameField = { b2: 'bucket', azure: 'container', gs: 'bucket', rclone: 'remote' }[scheme];
        const out = { kind: scheme };
        out[nameField] = two[0];
        if (two[1] !== '') out.prefix = two[1];
        return out;
    }

    // The size limit (`sizeLimit`, free text such as "500 GB") and its floor
    // (`minSnapshots`) belong to the REPOSITORY, not to a job: capacity is a
    // property of the destination — a disk or a bucket has one, a job does not —
    // and two jobs writing to one repository with per-job caps would each delete
    // the other's snapshots chasing its own number.
    //
    // Returns only what must BLOCK a save. core/sizeguard.js also emits warnings
    // ("500 with no unit is 500 bytes", "a floor of 1 leaves no margin"); those are
    // advice the editor shows beside the field, and turning advice into a veto
    // would make a legitimate small-repository cap unsaveable.
    function guardProblems(repo) {
        const G = sizeGuard();
        if (!G) return [];
        // An absent limit is the DEFAULT and means no size enforcement at all, so
        // 'limit-missing' — correct when a guard is being configured — is the wrong
        // answer for a repository that simply does not use one. Everything else
        // validateGuard finds still applies, including a malformed floor typed
        // before the limit it belongs to.
        return G.validateGuard({
            limit: blank(repo.sizeLimit) ? undefined : str(repo.sizeLimit),
            minSnapshots: repo.minSnapshots
        }).filter((p) => !!p && !!p.detail &&
                p.detail.severity === 'error' && p.detail.code !== 'limit-missing')
            .map((p) => str(p.message));
    }

    function validate(repo) {
        const problems = [];
        if (!repo || typeof repo !== 'object') return ['Repository definition is missing.'];

        if (blank(repo.id)) problems.push('Repository id is required.');
        // str() first: RegExp.test does its own ToString, which throws on a Symbol —
        // and validate's contract is to return problems, never to throw.
        else if (!ID_RE.test(str(repo.id))) problems.push('Repository id may only contain lowercase letters, digits and hyphens.');

        // Before the kind check, deliberately: the size limit and its floor are
        // properties of the repository itself, not of a backend, so an unreadable
        // one has to be reported even when the kind is the other thing that is
        // wrong. It costs nothing on a repository that sets neither.
        guardProblems(repo).forEach((p) => problems.push(p));

        const kind = str(repo.kind);
        if (KINDS.indexOf(kind) < 0) {
            problems.push('Unknown repository kind: ' + (kind || '(empty)') + '.');
            return problems;   // per-kind field checks are meaningless without a kind
        }

        REQUIRED[kind].forEach((f) => {
            if (blank(repo[f])) problems.push(missingField(kind, f));
        });

        if (kind === 'local' && !blank(repo.path)) {
            // The backup runs from a systemd unit with no shell and no cwd the user
            // controls, so a relative or ~-prefixed path resolves somewhere else.
            if (!/^\//.test(str(repo.path))) problems.push('Local repository path must be absolute.');
            if (hasTraversal(repo.path)) problems.push('Repository path must not contain "..".');
        }
        if (kind === 'sftp' && !blank(repo.path) && hasTraversal(repo.path))
            problems.push('Repository path must not contain "..".');
        if (kind === 'rest' && !blank(repo.url) && !/^https?:\/\//i.test(str(repo.url)))
            problems.push('REST repository URL must start with http:// or https://.');

        return problems;
    }

    function envFor(repo) {
        const env = {};
        if (!repo || typeof repo !== 'object') return env;
        const map = ENV_FIELDS[str(repo.kind)];
        if (!map) return env;
        Object.keys(map).forEach((field) => {
            if (!blank(repo[field])) env[map[field]] = str(repo[field]);
        });
        return env;
    }

    // The size limit read back as a sentence, or '' when the repository has none.
    //
    // The limit is echoed FORMATTED ("500 GB"), not as typed, because that is the
    // only way to see that "500G" was understood as 500 GB and not as 500 bytes.
    // An unreadable limit is echoed verbatim rather than dropped: describe() is
    // what the delete confirmation and the repository list show, and silently
    // omitting a setting nobody could parse is how it stays unnoticed.
    //
    // The floor is always named, even when the repository does not set one,
    // because sizeguard's default (3) applies either way and the number that will
    // actually stop the deleting is the one worth printing.
    function guardSentence(repo) {
        const G = sizeGuard();
        if (!G || blank(repo.sizeLimit)) return '';
        const bytes = G.parseSize(str(repo.sizeLimit));
        const size = (typeof bytes === 'number' && bytes > 0)
            ? G.formatSize(bytes)
            : str(repo.sizeLimit);
        const floor = G.effectiveFloor(repo.minSnapshots);
        return ' Kept under ' + size + ', never fewer than ' + floor +
            ' snapshot' + (floor === 1 ? '' : 's') + '.';
    }

    function describe(repo) {
        if (!repo || typeof repo !== 'object') return 'Unknown repository.';
        const where = locate(repo);
        // A repository whose location we cannot even name gets no size sentence:
        // "Unknown repository. Kept under 500 GB." reads as though hangar knows
        // more about it than it does.
        return where === 'Unknown repository.' ? where : where + guardSentence(repo);
    }

    function locate(repo) {
        const kind = str(repo.kind);
        const at = str(repo.prefix) === '' ? '' : ' under ' + str(repo.prefix);
        switch (kind) {
        case 'local':
            return 'Local folder at ' + str(repo.path) + '.';
        case 'sftp':
            return 'SFTP at ' + (blank(repo.user) ? '' : str(repo.user) + '@') + str(repo.host) +
                ':' + str(repo.path) + '.';
        case 'rest':
            return 'REST server at ' + str(repo.url) + '.';
        case 's3':
            return 'S3 bucket ' + str(repo.bucket) + ' on ' + str(repo.endpoint) + at + '.';
        case 'b2':
            return 'Backblaze B2 bucket ' + str(repo.bucket) + at + '.';
        case 'azure':
            return 'Azure container ' + str(repo.container) + at + '.';
        case 'gs':
            return 'Google Cloud Storage bucket ' + str(repo.bucket) + at + '.';
        case 'rclone':
            return 'rclone remote ' + str(repo.remote) + at + '.';
        }
        return 'Unknown repository.';
    }

    // `rclone listremotes` prints one "name:" per line. Kept pure so the parsing is
    // testable without rclone installed.
    function parseRcloneRemotes(text) {
        return str(text).split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l !== '' && !l.startsWith('#'))
            .map((l) => (l.endsWith(':') ? l.slice(0, -1) : l))
            .filter((l) => l !== '');
    }

    // Impure. restic spawns rclone as root from the backup unit, so the remotes
    // that matter are root's config, not the logged-in user's.
    function listRcloneRemotes() {
        if (typeof cockpit === 'undefined' || !cockpit.spawn) return Promise.resolve([]);
        // cockpit.spawn throws synchronously when the superuser bridge is already gone,
        // and a function whose whole contract is "resolves to a list" must not also
        // throw at its call site. Promise.resolve() additionally tolerates a channel
        // that hands back a plain string instead of a thenable.
        try {
            return Promise.resolve(cockpit.spawn(['rclone', 'listremotes'], { superuser: 'require', err: 'message' }))
                .then(parseRcloneRemotes)
                .catch(() => []);   // rclone absent is an ordinary state, not a failure
        } catch (e) {
            return Promise.resolve([]);
        }
    }

    const HangarRepos = {
        KINDS, SCHEMES, REQUIRED,
        buildUrl, parseUrl, validate, envFor, describe,
        parseRcloneRemotes, listRcloneRemotes
    };
    root.HangarRepos = HangarRepos;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarRepos;
})(typeof window !== 'undefined' ? window : globalThis);
