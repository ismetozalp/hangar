// features/repos-ui.js — the Repositories screen and its add/edit dialog.
//
// Two Alpine components live here: `hangarReposUi` (the list, mounted into
// #hangar-repos) and `hangarRepoEdit` (the modal in html/modals/repo-edit.html,
// driven by a 'hangar:repo-edit' event exactly like the shared confirm/password
// dialogs). Everything that decides *what* a form contains is a pure function at
// the top of the file, so the interesting logic is unit tested rather than
// inferred from the markup.
//
// Nothing here knows the restic CLI, the systemd bus or the filesystem layout —
// that is core/ and engine/. This file knows only which of them to call.
'use strict';
(function (root) {
    // Browser: index.html has already put the core modules on the global. Node:
    // require them, so the pure functions below are testable with no DOM.
    const req = (typeof require !== 'undefined' && typeof module !== 'undefined' && module.exports)
        ? require : null;

    const Errors = root.HangarErrors || (req ? req('../core/errors.js') : null);
    const Repos = root.HangarRepos || (req ? req('../core/repos.js') : null);
    const Secrets = root.HangarSecrets || (req ? req('../core/secrets.js') : null);
    const Config = root.HangarConfig || (req ? req('../core/config.js') : null);
    const Restic = root.HangarRestic || (req ? req('../engine/restic.js') : null);
    const Rclone = root.HangarRclone || (req ? req('../core/rclone.js') : null);

    // app.js loads AFTER the feature scripts, so HangarDialogs cannot be captured
    // at load time — it is resolved on first use instead.
    function dialogs() {
        if (root.HangarDialogs) return root.HangarDialogs;
        if (req) req('../app.js');
        return root.HangarDialogs || null;
    }

    // ------------------------------------------------------------------ pure

    const KIND_LABEL = {
        local: 'Local folder',
        sftp: 'SFTP',
        rest: 'REST server',
        s3: 'S3',
        b2: 'Backblaze B2',
        azure: 'Azure Blob Storage',
        gs: 'Google Cloud Storage',
        rclone: 'rclone remote'
    };

    // One descriptor per field name, shared by every kind that uses it. `secret`
    // fields render as password inputs; they are backend credentials (S3 keys and
    // friends), never the repository password — that one belongs to core/secrets.js
    // and is only ever typed into the shared password dialog.
    const FIELD = {
        path: { label: 'Path', type: 'text', placeholder: '/srv/backups/hangar',
            help: 'Absolute path. The backup runs from a systemd unit, so a relative path would resolve somewhere else.' },
        host: { label: 'Host', type: 'text', placeholder: 'nas.example.lan' },
        user: { label: 'User', type: 'text', placeholder: 'backup',
            help: 'Optional. Left empty, restic uses root\'s SSH client configuration.' },
        url: { label: 'URL', type: 'text', placeholder: 'https://rest.example:8000/' },
        endpoint: { label: 'Endpoint', type: 'text', placeholder: 's3.eu-central-1.amazonaws.com' },
        bucket: { label: 'Bucket', type: 'text', placeholder: 'hangar' },
        container: { label: 'Container', type: 'text', placeholder: 'hangar' },
        remote: { label: 'Remote', type: 'select', placeholder: 'remote',
            help: 'Taken from this host\'s rclone configuration. Use "Add a cloud destination" to create a new one.' },
        prefix: { label: 'Path inside the destination', type: 'text', placeholder: 'hosts/db01',
            help: 'Optional. Lets several hosts share one bucket.' },
        accessKeyId: { label: 'Access key ID', type: 'text' },
        secretAccessKey: { label: 'Secret access key', type: 'password', secret: true },
        accountId: { label: 'Account ID', type: 'text' },
        accountKey: { label: 'Account key', type: 'password', secret: true },
        accountName: { label: 'Account name', type: 'text' },
        projectId: { label: 'Project ID', type: 'text' }
    };

    // Display order per kind. Which of these are *mandatory* is not repeated here —
    // it is read from HangarRepos.REQUIRED, so the form and the validator cannot
    // drift apart, and a field added to REQUIRED later still appears (see below).
    const ORDER = {
        local: ['path'],
        sftp: ['user', 'host', 'path'],
        rest: ['url'],
        s3: ['endpoint', 'bucket', 'prefix', 'accessKeyId', 'secretAccessKey'],
        b2: ['bucket', 'prefix', 'accountId', 'accountKey'],
        azure: ['container', 'prefix', 'accountName', 'accountKey'],
        gs: ['bucket', 'prefix', 'projectId'],
        rclone: ['remote', 'prefix']
    };

    // Backends whose two credential fields are useless one without the other.
    const CREDENTIAL_PAIRS = {
        s3: ['accessKeyId', 'secretAccessKey'],
        b2: ['accountId', 'accountKey'],
        azure: ['accountName', 'accountKey']
    };

    const REMEDIATION_LABEL = {
        'unlock': 'Unlock repository',
        'reprompt': 'Enter the password again',
        'init': 'Initialise repository',
        'list-unreadable': 'Show unreadable files',
        'free-space': 'Show what to free',
        // Never 'Try again': a destination whose authorisation has lapsed answers
        // every retry the same way, so retrying is how the failure goes unnoticed.
        'reauthorize': 'Sign in again',
        'retry': 'Try again'
    };

    // The module's coercion boundary, so it has to be total. `/etc/hangar/repos/<id>.json`
    // is hand-editable, and JSON.parse can hand back `{"toString": null}` — String()
    // throws on that, which would turn a bad config file into a blank screen.
    function str(v) {
        if (v === null || v === undefined) return '';
        try {
            return String(v);
        } catch (e) {
            return '';
        }
    }

    function trimmed(v) {
        return str(v).trim();
    }

    // typeof first: String(['local']) is 'local', and an array that happens to
    // stringify to a backend name must not be treated as that backend.
    function isKind(kind) {
        return typeof kind === 'string' && Repos.KINDS.indexOf(kind) >= 0;
    }

    function kindLabel(kind) {
        return KIND_LABEL[str(kind)] || str(kind) || 'Unknown';
    }

    function kindChoices() {
        return Repos.KINDS.map(function (k) { return { value: k, label: kindLabel(k) }; });
    }

    function remediationLabel(r) {
        return REMEDIATION_LABEL[str(r)] || '';
    }

    // Ordered field descriptors for one backend. `required` comes from
    // HangarRepos.REQUIRED; anything REQUIRED lists but ORDER forgot is appended
    // rather than dropped, so a new mandatory field can never become invisible and
    // unfillable in the form.
    // Which fields name a path on THIS machine, per backend. Deliberately keyed by
    // kind: 'path' means a local directory for a local repository and a directory
    // on the far side of an SSH connection for an sftp one, and only the first can
    // be browsed from here.
    const BROWSABLE = { local: { path: 'dir' } };

    function fieldsFor(kind) {
        if (!isKind(kind)) return [];
        const required = Repos.REQUIRED[kind] || [];
        const names = (ORDER[kind] || []).slice();
        required.forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); });

        return names.map(function (name) {
            const d = FIELD[name] || { label: name, type: 'text' };
            return {
                name: name,
                label: d.label,
                type: d.type,
                placeholder: d.placeholder || '',
                help: d.help || '',
                secret: !!d.secret,
                // Which picker mode this field wants, if any. Absent for every
                // field that is not a filesystem path.
                browse: (BROWSABLE[kind] && BROWSABLE[kind][name]) || null,
                required: required.indexOf(name) >= 0
            };
        });
    }

    // Form state is flat and all-strings: Alpine's x-model wants a stable set of
    // keys, and a missing key would silently become `undefined` in the markup.
    function blankForm(kind) {
        const k = isKind(kind) ? str(kind) : 'local';
        const form = { id: '', label: '', kind: k };
        fieldsFor(k).forEach(function (f) { form[f.name] = ''; });
        return form;
    }

    function repoToFormState(repo) {
        const r = repo && typeof repo === 'object' ? repo : {};
        const kind = isKind(r.kind) ? str(r.kind) : 'local';
        const form = blankForm(kind);
        form.id = str(r.id);
        form.label = str(r.label);
        fieldsFor(kind).forEach(function (f) { form[f.name] = str(r[f.name]); });
        return form;
    }

    // Empty optional fields are omitted rather than stored as "": repos.js treats
    // blank and absent the same, but a file full of empty strings is noise when an
    // administrator reads /etc/hangar/repos/<id>.json by hand.
    //
    // Values are trimmed. A trailing space in a pasted path or bucket name is
    // always a paste artefact and would otherwise fail with a baffling message.
    function formStateToRepo(kind, form) {
        const f = form && typeof form === 'object' ? form : {};
        // An unknown kind is kept verbatim rather than coerced: validateForm has to
        // be able to report "Unknown repository kind" instead of silently saving a
        // local repository the user never asked for.
        const k = str(kind);
        const repo = { id: trimmed(f.id), kind: k };
        if (trimmed(f.label) !== '') repo.label = trimmed(f.label);
        fieldsFor(k).forEach(function (d) {
            const v = trimmed(f[d.name]);
            if (v !== '') repo[d.name] = v;
        });
        return repo;
    }

    // Switching backend keeps whatever the user already typed under a name the new
    // backend also uses (bucket, prefix, path…). Retyping a bucket name because you
    // changed your mind about B2 versus S3 is pure friction.
    function mergeKind(form, kind) {
        const next = blankForm(kind);
        const f = form && typeof form === 'object' ? form : {};
        next.id = str(f.id);
        next.label = str(f.label);
        Object.keys(next).forEach(function (key) {
            if (key === 'kind') return;
            if (f[key] !== undefined && f[key] !== null) next[key] = str(f[key]);
        });
        return next;
    }

    // config.js caps the id at 63 characters because it becomes a filename and a
    // systemd unit instance name. repos.js has no length opinion, so without this
    // the form accepts an id that the save then rejects.
    const MAX_ID_LEN = 63;

    // A line break or a NUL in a pasted value is always an accident, and every one
    // of these strings ends up in an argv element, a JSON file or a unit file where
    // it produces a failure nobody can read back to the box they typed it in.
    const CONTROL_RE = /[\u0000-\u001f\u007f]/;

    function validateForm(kind, form, existingIds) {
        const repo = formStateToRepo(kind, form);
        const problems = Repos.validate(repo);

        // repos.js accepts an id of "-foo"; secrets.js rejects it, because an id
        // that starts with a dash becomes an option the first time it reaches a
        // command line. Catch it in the form rather than three calls later.
        if (repo.id !== '' && /^-/.test(repo.id))
            problems.push('Repository id must start with a letter or a digit.');

        if (repo.id.length > MAX_ID_LEN)
            problems.push('Repository id must be at most ' + MAX_ID_LEN + ' characters.');

        if (Object.keys(repo).some(function (k) { return CONTROL_RE.test(str(repo[k])); }))
            problems.push('Values must not contain line breaks or control characters.');

        const taken = Array.isArray(existingIds) ? existingIds.map(trimmed) : [];
        if (repo.id !== '' && taken.indexOf(repo.id) >= 0)
            problems.push('A repository with this id already exists.');

        const pair = CREDENTIAL_PAIRS[repo.kind];
        if (pair) {
            const filled = pair.filter(function (n) { return trimmed(repo[n]) !== ''; });
            if (filled.length === 1) {
                const labels = pair.map(function (n) { return (FIELD[n] || {}).label || n; });
                problems.push(labels[0] + ' and ' + labels[1] + ' must be given together.');
            }
        }

        if (trimmed(repo.prefix) !== '' && str(repo.prefix).split('/').indexOf('..') >= 0)
            problems.push('Path inside the destination must not contain "..".');

        return problems;
    }

    // ---------------------------------------------------------- pure: display

    const SIZE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

    // Number(null) is 0, so a size we simply do not have yet would render as "0 B"
    // — a lie that reads as "this repository is empty". Number([]) and Number(true)
    // are 0 and 1 for the same reason, hence the type gate before the conversion.
    function formatSize(bytes) {
        if (typeof bytes !== 'number' && typeof bytes !== 'string') return '—';
        if (bytes === '') return '—';
        const n = Number(bytes);
        if (!Number.isFinite(n) || n < 0) return '—';
        let v = n;
        let i = 0;
        while (v >= 1024 && i < SIZE_UNITS.length - 1) { v /= 1024; i++; }
        return (i === 0 ? String(Math.round(v)) : v.toFixed(v < 10 ? 1 : 0)) + ' ' + SIZE_UNITS[i];
    }

    function formatCount(n) {
        if (typeof n !== 'number' && typeof n !== 'string') return '—';
        if (n === '') return '—';
        return Number.isFinite(Number(n)) && Number(n) >= 0 ? String(Number(n)) : '—';
    }

    // Naming the running operation matters more than a spinner: "Checking
    // integrity…" against a cold S3 bucket takes minutes and looks like a hang.
    const BUSY_LABEL = {
        stats: 'Reading repository…',
        test: 'Testing connection…',
        check: 'Checking integrity…',
        unlock: 'Removing stale locks…',
        init: 'Initialising repository…',
        remove: 'Removing…',
        save: 'Saving…',
        password: 'Saving password…'
    };

    function busyLabelFor(what) {
        return BUSY_LABEL[str(what)] || '';
    }

    function toRow(repo) {
        return {
            id: str(repo && repo.id),
            repo: repo,
            title: trimmed(repo && repo.label) || str(repo && repo.id),
            kindLabel: kindLabel(repo && repo.kind),
            location: Repos.describe(repo),
            stats: null,
            alert: null,
            busy: '',
            showFiles: false
        };
    }

    // restic reports an unreadable file as an `error` message carrying the item it
    // choked on. Listing those is the whole difference between "partial success"
    // and a red banner the user cannot act on.
    function unreadableFrom(x) {
        if (!x || typeof x !== 'object') return [];
        const msgs = Array.isArray(x.errors)
            ? x.errors
            : (x.detail && Array.isArray(x.detail.errors) ? x.detail.errors : []);
        const out = [];
        msgs.forEach(function (m) {
            if (!m || typeof m !== 'object') return;
            const item = str(m.item || m.path);
            if (item !== '' && out.indexOf(item) < 0) out.push(item);
        });
        return out;
    }

    // A typed error becomes an alert with an ACTION, never a toast. Non-fatal kinds
    // (READ_ERRORS, CANCELLED) are warnings — the operation did something useful.
    //
    // `repoId` is carried so a screen-level alert can still route its remediation to
    // the repository it is about, which is the only way "Unlock" can mean anything
    // when the failure happened outside a row.
    function toAlert(e, context, repoId) {
        if (!e) return null;
        const remediation = Errors.remediationFor(e);
        const files = unreadableFrom(e);
        const stderr = (Errors.isHangarError(e) && e.detail && e.detail.stderr) ? str(e.detail.stderr) : '';
        return {
            level: Errors.isFatal(e) ? 'danger' : 'warning',
            kind: Errors.isHangarError(e) ? e.kind : Errors.KIND.UNKNOWN,
            context: str(context),
            repoId: str(repoId),
            message: str(e.message) || 'Something went wrong.',
            remediation: remediation,
            // A "Show unreadable files" button that reveals an empty list is worse
            // than no button: restic does not always name what it choked on.
            actionLabel: (remediation === 'list-unreadable' && files.length === 0)
                ? '' : remediationLabel(remediation),
            files: files,
            // Never render a raw backend error unredacted: it routinely contains a
            // URL with inline credentials.
            detail: stderr === '' ? '' : Secrets.redact(stderr).slice(-2000)
        };
    }

    function okAlert(context, message, repoId) {
        return {
            level: 'success', kind: Errors.KIND.OK, context: str(context), repoId: str(repoId),
            message: str(message), remediation: null, actionLabel: '', files: [], detail: ''
        };
    }

    // The other half: a run that RESOLVED still has an outcome to render.
    function resultAlert(result, context, repoId) {
        if (!result || typeof result !== 'object') return null;
        const files = unreadableFrom(result);
        const id = str(repoId);
        if (result.status === 'partial') {
            return {
                level: 'warning', kind: Errors.KIND.READ_ERRORS, context: str(context), repoId: id,
                message: str(context) + ' finished, but some files could not be read.',
                remediation: 'list-unreadable',
                actionLabel: files.length ? remediationLabel('list-unreadable') : '',
                files: files, detail: ''
            };
        }
        if (result.status === 'failed')
            return toAlert(result.error || Errors.create(Errors.KIND.GENERIC, str(context) + ' failed.'), context, id);
        if (result.status === 'cancelled') {
            return {
                level: 'info', kind: Errors.KIND.CANCELLED, context: str(context), repoId: id,
                message: str(context) + ' was cancelled.',
                remediation: null, actionLabel: '', files: [], detail: ''
            };
        }
        // Only an actual summary is success. 'running' and 'unknown' mean restic
        // produced nothing we can vouch for, and reporting "completed" for that is
        // the one lie a backup tool must never tell.
        if (result.status !== 'ok') {
            return {
                level: 'warning', kind: Errors.KIND.UNKNOWN, context: str(context), repoId: id,
                message: str(context) + ' ended without reporting a result.',
                remediation: 'retry', actionLabel: remediationLabel('retry'),
                files: files, detail: ''
            };
        }
        return okAlert(context, str(context) + ' completed.', id);
    }

    // restic init against a repository that already exists is exit 1 — but for the
    // "add an existing repository" flow that is the expected, successful case.
    //
    // The stderr detail is searched as well as the message: classifyExit only lifts
    // restic's text into `message` when restic emitted an exit_error JSON object.
    // Without that, the message is the generic "restic reported an error" and the
    // real reason sits in detail.stderr — which used to turn the commonest way of
    // adding a repository into a red alert.
    function isAlreadyInitialised(e) {
        if (!e) return false;
        const stderr = (Errors.isHangarError(e) && e.detail && e.detail.stderr) ? str(e.detail.stderr) : '';
        return /already initialized|config file already exists/i.test(str(e.message) + '\n' + stderr);
    }

    // Repository deletion defaults to removing hangar's reference only. Destroying
    // someone's backups as a side effect of tidying a list is unrecoverable, so
    // hangar simply does not offer it — the message says where the data still is.
    function deleteMessage(repo) {
        const name = trimmed(repo && repo.label) || str(repo && repo.id);
        return {
            title: 'Remove ' + name + ' from hangar?',
            message: 'This removes hangar\'s reference to the repository and its stored password. ' +
                'The backup data itself is NOT deleted.',
            detail: Repos.describe(repo) + ' Jobs that use this repository will stop working until you ' +
                'point them somewhere else. To destroy the backups as well, delete that location yourself.',
            confirmLabel: 'Remove reference'
        };
    }

    // buildUrl throws on a repository definition that no longer validates, and
    // this one is called from a click handler on a row that is already failing.
    // An empty string means "no URL to read", which every caller can handle.
    function safeUrl(repo) {
        try {
            return Repos ? str(Repos.buildUrl(repo)) : '';
        } catch (e) {
            return '';
        }
    }

    // The rclone remote a repository is written through, or '' for a repository
    // that does not go through rclone at all. `repo.remote` is the definition's
    // own field; the URL is the fallback for a definition that carries a full
    // URL instead — and the URL parse is the one that also refuses a "remote"
    // containing a slash or a space, which would be a path we misread.
    function remoteOf(repo) {
        const r = repo && typeof repo === 'object' ? repo : {};
        if (str(r.kind) === 'rclone' && trimmed(r.remote) !== '') return trimmed(r.remote);
        if (!Rclone || typeof Rclone.remoteNameFromRepoUrl !== 'function') return '';
        return str(Rclone.remoteNameFromRepoUrl(safeUrl(r)));
    }

    // Test connection has to find an expired authorisation BEFORE the next
    // scheduled run does — that is the whole reason the button exists.
    //
    // classifyExit already reads restic's stderr for rclone's expiry wording, so
    // the common path arrives here typed correctly. This is the path it cannot
    // cover: a failure that never became a restic exit status (the channel died,
    // the spawn threw) still carries rclone's text, and reporting THAT as a
    // generic error is how a lapsed sign-in gets a "Try again" button and another
    // week of silent failures.
    //
    // Only for a repository that actually goes through rclone: a plain SFTP
    // repository whose server said "403 Forbidden" has a permission problem, and
    // sending its owner through a cloud sign-in would hide it.
    function classifyRepoFailure(e, repo) {
        if (!e || !Rclone || typeof Rclone.isAuthExpired !== 'function') return e;
        if (Errors.isHangarError(e) && e.kind === Errors.KIND.AUTH_EXPIRED) return e;
        if (remoteOf(repo) === '') return e;

        const detail = (Errors.isHangarError(e) && e.detail && typeof e.detail === 'object')
            ? e.detail : null;
        const text = str(e.message) + '\n' + (detail ? str(detail.stderr) : '');
        if (!Rclone.isAuthExpired(text)) return e;

        // The original text is kept in the detail — it is what the log needs —
        // while the message becomes the one a person can act on.
        return Errors.create(Errors.KIND.AUTH_EXPIRED, Rclone.AUTH_EXPIRED_MESSAGE,
            detail || { stderr: str(e.message) });
    }

    function resticOptions(repo) {
        return {
            repoUrl: Repos.buildUrl(repo),
            passwordFile: Secrets.keyPath(repo && repo.id)
        };
    }

    // ------------------------------------------------------------- impure I/O

    function hasCockpit() {
        return typeof cockpit !== 'undefined' && !!cockpit && typeof cockpit.spawn === 'function';
    }

    function noCockpit(op) {
        return Errors.create(Errors.KIND.GENERIC, 'cockpit is not available.', { op: op });
    }

    // HangarRestic.run() folds a JSON-LINES stream, which is the wrong shape for
    // `snapshots` and `stats`: those emit a single JSON document that run() would
    // fold to nothing. The argv and the parsing still come from the engine — only
    // the channel is local.
    function runDocument(op, opts) {
        let argv;
        try {
            argv = ['restic'].concat(Restic.buildArgs(op, opts));
        } catch (e) {
            return Promise.reject(e);
        }
        if (!hasCockpit()) return Promise.reject(noCockpit(op));
        try {
            return Promise.resolve(cockpit.spawn(argv, { superuser: 'require', err: 'message' }))
                .catch(function (ex) {
                    throw Restic.classifyExit(ex && ex.exit_status, (ex && (ex.message || ex.problem)) || '');
                });
        } catch (e) {
            // Opening the channel can throw synchronously when the superuser bridge
            // is gone. Saying "cockpit is not available" there would send the user
            // looking for the wrong problem.
            return Promise.reject(Errors.create(Errors.KIND.GENERIC, 'Could not start restic.',
                { op: op, cause: str(e && e.message) }));
        }
    }

    // Config.repoPath() validates the id and throws on a hostile one — but this is
    // called from the failure path, where throwing again would replace a listed
    // problem with a blank screen.
    function repoPathSafe(id) {
        try {
            return Config.repoPath(id);
        } catch (e) {
            return Config.CONF_DIR + '/repos/' + str(id) + '.json';
        }
    }

    // core/config.js writes and reads but never unlinks, and this is the only place
    // in the plugin that needs to. The path still comes from config.js so the id
    // validation and the layout stay in one module.
    function removeRepoFile(id) {
        const path = Config.repoPath(id);
        if (!hasCockpit() || typeof cockpit.file !== 'function') return Promise.reject(noCockpit('removeRepo'));
        const f = cockpit.file(path, { superuser: 'require' });
        return Promise.resolve(f.replace(null)).then(
            function () { f.close(); return path; },
            function (e) { f.close(); throw Errors.create(Errors.KIND.GENERIC, 'Could not remove ' + path, { error: String(e) }); });
    }

    // ------------------------------------------------------------- components

    function hangarReposUi() {
        return {
            rows: [],
            loading: true,
            alert: null,
            // Repository files that exist but could not be read. A partial list is
            // still a useful list, so this is a warning beside the table rather
            // than an empty screen with an error.
            unreadable: [],
            // Whether the screen-level alert has expanded its file list.
            showFiles: false,

            async init() {
                // A destination repaired anywhere — this screen's own rows, or the
                // Overview banner — leaves this list showing a failure that is no
                // longer true. The row is re-read rather than patched, because the
                // host is what decides whether the repair worked.
                if (typeof root.addEventListener === 'function') {
                    root.addEventListener('hangar:rclone-remote-reconnected', (ev) => {
                        this.remoteReconnected((ev && ev.detail) || {});
                    });
                }
                await this.refresh();
            },

            // Never rejects: it runs from an event listener, where a rejection has
            // nowhere to go.
            async remoteReconnected(detail) {
                const id = trimmed(detail && detail.repoId);
                const rows = id === ''
                    ? this.rows.filter(function (r) { return !!r.alert; })
                    : this.rows.filter(function (r) { return r.id === id; });
                for (const row of rows) {
                    row.alert = null;
                    try { await this.loadStats(row); } catch (e) { /* the row shows its own alert */ }
                }
                return rows.length;
            },

            // Never rejects. x-init has nowhere to put a rejection, and a throw here
            // used to leave `loading` true forever — a permanent "Loading…" with no
            // way back.
            async refresh() {
                this.loading = true;
                this.unreadable = [];
                this.showFiles = false;
                let rows = [];
                try {
                    let ids = [];
                    try {
                        ids = await Config.listRepos();
                    } catch (e) {
                        this.alert = toAlert(e, 'Listing repositories');
                    }
                    if (!Array.isArray(ids)) ids = [];

                    for (const id of ids) {
                        try {
                            const repo = await Config.readRepo(id);
                            // An unreadable definition is a PARTIAL result, not a
                            // failure: everything else still renders.
                            if (!repo || typeof repo !== 'object') { this.unreadable.push(repoPathSafe(id)); continue; }
                            if (!repo.id) repo.id = str(id);
                            rows.push(toRow(repo));
                        } catch (e) {
                            this.unreadable.push(repoPathSafe(id));
                        }
                    }
                } catch (e) {
                    this.alert = toAlert(e, 'Listing repositories');
                } finally {
                    this.rows = rows;
                    this.loading = false;
                }

                // Sizes are a per-repository network round trip; the table must not
                // wait on the slowest backend before it renders anything.
                rows.forEach((r) => { this.loadStats(r); });
            },

            existingIds(exceptId) {
                return this.rows.map(function (r) { return r.id; })
                    .filter(function (id) { return id !== exceptId; });
            },

            async loadStats(row) {
                row.busy = 'stats';
                row.alert = null;
                try {
                    const opts = resticOptions(row.repo);
                    const snaps = Restic.parseSnapshots(await runDocument('snapshots', opts));
                    // Published before the (much slower) size query, and never
                    // discarded by its failure: a count we already have is true
                    // whether or not `stats` comes back.
                    row.stats = { snapshots: snaps.length, size: null };
                    const stats = Restic.parseStats(await runDocument('stats',
                        Object.assign({ mode: 'raw-data' }, opts)));
                    row.stats = { snapshots: snaps.length, size: stats.totalSize };
                } catch (e) {
                    // Same reclassification as the Test button: the row that
                    // failed to load its size is usually the first sight of an
                    // expired destination, and it must offer the same fix.
                    row.alert = toAlert(classifyRepoFailure(e, row.repo), 'Reading repository', row.id);
                } finally {
                    row.busy = '';
                }
            },

            // --- actions ---------------------------------------------------

            async openAdd() {
                const repo = await repoEditDialog({ mode: 'add', form: blankForm('local'), existingIds: this.existingIds() });
                if (repo) await this.create(repo);
            },

            async openEdit(row) {
                const repo = await repoEditDialog({
                    mode: 'edit',
                    form: repoToFormState(row.repo),
                    existingIds: this.existingIds(row.id)
                });
                if (repo) await this.update(row, repo);
            },

            async create(repo) {
                const d = dialogs();
                if (!d) return;
                // confirming:true types the password twice. A typo in a NEW
                // repository password is unrecoverable — there is no existing
                // repository to check it against and no reset path.
                let password;
                try {
                    password = await d.passwordDialog({
                        title: 'Password for the new repository',
                        repoLabel: Repos.describe(repo),
                        confirming: true
                    });
                } catch (e) {
                    // A dialog that cannot be shown is a visible failure, not an
                    // unhandled rejection escaping a click handler.
                    this.alert = toAlert(e, 'Add repository', repo && repo.id);
                    return;
                }
                if (!password) return;

                this.alert = null;
                this.loading = true;
                try {
                    await Secrets.writeKey(repo.id, password);
                    await Config.writeRepo(repo);
                    await runDocument('init', resticOptions(repo));
                    this.alert = okAlert('Add repository', 'Repository ' + str(repo.id) + ' is ready.', repo.id);
                } catch (e) {
                    if (isAlreadyInitialised(e)) {
                        this.alert = okAlert('Add repository',
                            'Repository ' + str(repo.id) + ' already existed and was added as it is.', repo.id);
                    } else {
                        // The definition is deliberately left on disk: the user can
                        // fix the destination and use the Initialise action rather
                        // than retyping the whole form. Carrying the id means the
                        // remediation button can act on that row.
                        this.alert = toAlert(e, 'Add repository', repo.id);
                    }
                } finally {
                    this.loading = false;
                    await this.refresh();
                }
            },

            async update(row, repo) {
                row.busy = 'save';
                try {
                    await Config.writeRepo(repo);
                } catch (e) {
                    this.alert = toAlert(e, 'Saving repository', row && row.id);
                } finally {
                    row.busy = '';
                    await this.refresh();
                }
            },

            async remove(row) {
                const d = dialogs();
                if (!d) return;
                const msg = deleteMessage(row.repo);
                try {
                    // Resolves only on confirm; cancelling simply never settles.
                    await d.confirmDialog({
                        danger: true,
                        title: msg.title,
                        message: msg.message,
                        detail: msg.detail,
                        confirmLabel: msg.confirmLabel
                    });
                } catch (e) {
                    this.alert = toAlert(e, 'Removing repository', row.id);
                    return;
                }
                row.busy = 'remove';
                try {
                    // The definition goes even if the key could not be removed:
                    // leaving the repository listed after the user confirmed its
                    // removal is the more confusing half-state, and removeKey is
                    // idempotent so the retry costs nothing.
                    let keyError = null;
                    try {
                        await Secrets.removeKey(row.id);
                    } catch (e) {
                        keyError = e;
                    }
                    await removeRepoFile(row.id);
                    if (keyError) this.alert = toAlert(keyError, 'Removing the stored password', row.id);
                } catch (e) {
                    this.alert = toAlert(e, 'Removing repository', row.id);
                } finally {
                    row.busy = '';
                    await this.refresh();
                }
            },

            async testConnection(row) {
                row.busy = 'test';
                row.alert = null;
                try {
                    const snaps = Restic.parseSnapshots(await runDocument('snapshots', resticOptions(row.repo)));
                    row.stats = Object.assign({ size: null }, row.stats, { snapshots: snaps.length });
                    row.alert = okAlert('Test', 'Reachable — ' + snaps.length + ' snapshot(s).', row.id);
                } catch (e) {
                    // Classified before it is rendered, so an expired sign-in gets
                    // "Sign in again" here rather than being discovered by the
                    // next nightly run.
                    row.alert = toAlert(classifyRepoFailure(e, row.repo), 'Test connection', row.id);
                } finally {
                    row.busy = '';
                }
            },

            async unlock(row) {
                row.busy = 'unlock';
                try {
                    await runDocument('unlock', resticOptions(row.repo));
                    row.alert = null;
                    await this.loadStats(row);
                } catch (e) {
                    row.alert = toAlert(e, 'Unlock', row.id);
                } finally {
                    row.busy = '';
                }
            },

            async initRepo(row) {
                row.busy = 'init';
                try {
                    await runDocument('init', resticOptions(row.repo));
                    row.alert = null;
                    await this.loadStats(row);
                } catch (e) {
                    if (!isAlreadyInitialised(e)) {
                        row.alert = toAlert(e, 'Initialise', row.id);
                    } else {
                        // Already initialised is the expected outcome of "add an
                        // existing repository" — clear the error AND go read it,
                        // otherwise the row keeps its stale empty stats.
                        row.alert = null;
                        await this.loadStats(row);
                    }
                } finally {
                    row.busy = '';
                }
            },

            async check(row) {
                row.busy = 'check';
                row.alert = null;
                try {
                    // `check` emits JSON lines, so this one goes through the engine's
                    // own runner and its partial/failed folding.
                    row.alert = resultAlert(await Restic.run('check', resticOptions(row.repo)),
                        'Integrity check', row.id);
                } catch (e) {
                    row.alert = toAlert(e, 'Integrity check', row.id);
                } finally {
                    row.busy = '';
                }
            },

            async reprompt(row) {
                const d = dialogs();
                if (!d) return;
                let password;
                try {
                    password = await d.passwordDialog({
                        title: 'Repository password',
                        repoLabel: Repos.describe(row.repo),
                        confirming: false
                    });
                } catch (e) {
                    row.alert = toAlert(e, 'Repository password', row.id);
                    return;
                }
                if (!password) return;
                row.busy = 'password';
                try {
                    await Secrets.writeKey(row.id, password);
                    row.alert = null;
                    await this.loadStats(row);
                } catch (e) {
                    row.alert = toAlert(e, 'Saving password', row.id);
                } finally {
                    row.busy = '';
                }
            },

            // The one-click fix for an expired cloud destination. It hands off to
            // features/rclone-ui.js — the SAME wizard that created the remote,
            // because the recovery is the same journey: `rclone authorize` runs on
            // the user's own computer and the token is pasted back. hangar cannot
            // run `rclone config reconnect` itself; it re-enters the interactive
            // flow, binds 127.0.0.1 on THIS machine and asks questions on stdin.
            //
            // `verify` travels with the request so the wizard can prove the repair
            // rather than assert it: the user watches this row's own connection
            // test succeed, in the dialog, before they close it.
            reauthorize(row) {
                const remote = remoteOf(row && row.repo);
                if (remote === '') {
                    // Not an rclone repository, so there is no sign-in to renew.
                    // Expanding the detail says more than a wizard about a
                    // destination this row does not use.
                    if (row) row.showFiles = true;
                    return false;
                }
                if (typeof root.dispatchEvent !== 'function' || typeof CustomEvent !== 'function')
                    return false;
                root.dispatchEvent(new CustomEvent('hangar:rclone-remote', {
                    detail: {
                        existing: [],
                        reauthorize: remote,
                        repoId: row.id,
                        verify: async () => {
                            await this.testConnection(row);
                            const a = row.alert;
                            if (a && a.level !== 'success')
                                throw Errors.create(a.kind || Errors.KIND.UNKNOWN, a.message);
                            return { message: a ? a.message : '' };
                        }
                    }
                }));
                return true;
            },

            // The remediation of a typed error is a button, and this is where the
            // button lands. Unmapped remediations simply expand the detail.
            async remediate(row) {
                if (!row) return null;
                const r = row.alert && row.alert.remediation;
                if (r === 'unlock') return this.unlock(row);
                if (r === 'init') return this.initRepo(row);
                if (r === 'reprompt') return this.reprompt(row);
                if (r === 'retry') return this.loadStats(row);
                if (r === 'reauthorize') return this.reauthorize(row);
                row.showFiles = true;
                return null;
            },

            // The row the screen-level alert is about, if it is still on screen.
            alertRow() {
                const id = this.alert && this.alert.repoId;
                if (!id) return null;
                return this.rows.filter(function (r) { return r.id === id; })[0] || null;
            },

            // A screen-level alert only offers a button it can actually honour.
            // 'unlock' / 'init' / 'reprompt' / 'reauthorize' need a repository to
            // act on; offering them with no row would be a button that silently
            // does nothing.
            alertActionLabel() {
                const a = this.alert;
                if (!a || !a.actionLabel) return '';
                if (a.remediation === 'retry' || a.remediation === 'list-unreadable') return a.actionLabel;
                return this.alertRow() ? a.actionLabel : '';
            },

            async remediateAlert() {
                const a = this.alert;
                if (!a) return null;
                const row = this.alertRow();
                if (row && (a.remediation === 'unlock' || a.remediation === 'init' ||
                            a.remediation === 'reprompt' || a.remediation === 'reauthorize')) {
                    this.alert = null;
                    row.alert = a;
                    return this.remediate(row);
                }
                if (a.remediation === 'retry') {
                    this.alert = null;
                    return this.refresh();
                }
                this.showFiles = true;
                return null;
            },

            // --- display helpers -------------------------------------------

            size(row) { return row.stats ? formatSize(row.stats.size) : '—'; },
            snapshots(row) { return row.stats ? formatCount(row.stats.snapshots) : '—'; },
            busyLabel(row) { return busyLabelFor(row && row.busy); },
            alertClass(alert) {
                return alert ? 'alert alert-' + alert.level : 'alert alert-secondary';
            }
        };
    }

    // Promise helper mirroring HangarDialogs: resolves with the repository object
    // when the user saves, and — like the shared confirm dialog — simply never
    // settles when they cancel.
    function repoEditDialog(opts) {
        return new Promise(function (resolve) {
            // No event target means no modal — under node, or in a browser where the
            // partial failed to load. Resolving with null makes the caller's
            // `if (repo)` guard the single place that has to think about it.
            if (typeof root.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') {
                resolve(null);
                return;
            }
            root.dispatchEvent(new CustomEvent('hangar:repo-edit',
                { detail: Object.assign({}, opts, { resolve: resolve }) }));
        });
    }

    function hangarRepoEdit() {
        return {
            mode: 'add',
            kind: 'local',
            form: blankForm('local'),
            kinds: kindChoices(),
            remotes: [],
            remotesLoaded: false,
            problems: [],
            existingIds: [],
            _resolve: null,

            init() {
                if (typeof root.addEventListener !== 'function') return;
                root.addEventListener('hangar:repo-edit', (ev) => { this.receive(ev.detail || {}); });
                // The rclone wizard (features/rclone-ui.js) reports a new remote
                // globally. Listening here is what lets the user land back on this
                // form with the destination they just made already selected.
                root.addEventListener('hangar:rclone-remote-created', (ev) => {
                    this.remoteCreated((ev && ev.detail) || {});
                });
            },

            receive(o) {
                o = o && typeof o === 'object' ? o : {};
                this.mode = o.mode === 'edit' ? 'edit' : 'add';
                const seed = o.form && typeof o.form === 'object' ? o.form : null;
                this.form = seed ? Object.assign(blankForm(seed.kind), seed) : blankForm('local');
                // A kind the form carries but this build does not know would render a
                // dialog with no fields and no way out. blankForm already fell back
                // to local; make the label agree with the fields it is showing.
                this.kind = isKind(this.form.kind) ? str(this.form.kind) : 'local';
                this.form.kind = this.kind;
                this.existingIds = Array.isArray(o.existingIds) ? o.existingIds : [];
                this.problems = [];
                this._resolve = o.resolve || null;
                if (this.kind === 'rclone') this.loadRemotes();
                showModal('hangar-repo-edit');
            },

            title() {
                return this.mode === 'edit' ? 'Edit repository' : 'Add repository';
            },

            fields() {
                return fieldsFor(this.kind);
            },

            setKind(kind) {
                // <select> can only offer the kinds we listed, but the method is also
                // the programmatic entry point — coerce rather than render an empty
                // form for a kind that has no fields.
                this.kind = isKind(kind) ? str(kind) : 'local';
                this.form = mergeKind(this.form, this.kind);
                this.problems = [];
                if (this.kind === 'rclone') this.loadRemotes();
            },

            async loadRemotes() {
                if (this.remotesLoaded) return;
                this.remotesLoaded = true;      // set first: two setKind() calls must not race
                try {
                    const list = await Repos.listRcloneRemotes();
                    this.remotes = Array.isArray(list) ? list : [];
                } catch (e) {
                    // rclone absent is an ordinary state, not an error — the form
                    // falls back to a free-text remote name. Allow a later retry.
                    this.remotes = [];
                    this.remotesLoaded = false;
                }
            },

            // Hands off to features/rclone-ui.js. The current remote list travels
            // with the request so the wizard can refuse a name that would silently
            // overwrite an existing remote.
            // Opens the shared folder picker for a field that declares `browse`, seeded
            // with whatever is already typed so an edit starts where the user left off
            // rather than at '/'. Cancelling leaves the field untouched.
            async browseFor(field) {
                if (!field || !field.browse) return false;
                const D = root.HangarDialogs;
                if (!D || typeof D.pickPath !== 'function') return false;
                const picked = await D.pickPath({
                    mode: field.browse,
                    current: this.form[field.name] || '',
                    title: 'Choose the ' + String(field.label || 'path').toLowerCase()
                });
                if (picked === null || picked === undefined) return false;
                this.form[field.name] = picked;
                return true;
            },
            openRcloneWizard() {
                if (typeof root.dispatchEvent !== 'function' || typeof CustomEvent !== 'function')
                    return false;
                root.dispatchEvent(new CustomEvent('hangar:rclone-remote',
                    { detail: { existing: this.remotes.slice() } }));
                return true;
            },

            // The one-click fix for an expired cloud destination. It hands off to
            // features/rclone-ui.js — the SAME wizard that created the remote,
            // because the recovery is the same journey: `rclone authorize` runs on
            // the user's own computer and the token is pasted back. `reauthorize`
            // names the remote to repair, so the wizard reopens on that remote
            // instead of asking for a new name.
            //
            // hangar cannot run `rclone config reconnect` itself: it re-enters the
            // interactive OAuth flow, binds 127.0.0.1 on THIS machine — a server
            // nobody is sitting at — and asks questions on stdin.
            reauthorize(row) {
                const repo = (row && row.repo) || row;
                const remote = trimmed(repo && repo.remote) ||
                    (Rclone && Repos ? Rclone.remoteNameFromRepoUrl(safeUrl(repo)) : '') || '';
                if (!remote) {
                    // Nothing to re-authorise: this is not an rclone repository, so
                    // say so rather than opening a wizard about someone else.
                    if (row) row.showFiles = true;
                    return false;
                }
                if (typeof root.dispatchEvent !== 'function' || typeof CustomEvent !== 'function')
                    return false;
                root.dispatchEvent(new CustomEvent('hangar:rclone-remote',
                    { detail: { existing: this.remotes.slice(), reauthorize: remote } }));
                return true;
            },

            // A remote was created elsewhere. Re-read the list from rclone rather
            // than trusting the event: the host is the source of truth, and the
            // user may have added others in a terminal meanwhile. The new name is
            // appended anyway if the re-read missed it, so the dropdown can never
            // end up unable to offer what was just made.
            async remoteCreated(detail) {
                const name = trimmed(detail && detail.name);
                this.remotesLoaded = false;
                await this.loadRemotes();
                if (name === '') return '';
                if (this.remotes.indexOf(name) < 0) this.remotes = this.remotes.concat([name]);
                if (this.kind === 'rclone') this.form.remote = name;
                return name;
            },

            // The id is the filename, the systemd instance name and the key path, so
            // it cannot change once the repository exists.
            idLocked() {
                return this.mode === 'edit';
            },

            validate() {
                this.problems = validateForm(this.kind, this.form,
                    this.mode === 'edit' ? [] : this.existingIds);
                return this.problems.length === 0;
            },

            submit() {
                if (!this.validate()) return;
                const repo = formStateToRepo(this.kind, this.form);
                hideModal('hangar-repo-edit');
                if (typeof this._resolve === 'function') this._resolve(repo);
                this._resolve = null;
            }
        };
    }

    // ------------------------------------------------------------------- DOM

    // Every DOM touch below is guarded: under node there is no document, and the
    // components above must stay constructible without one.
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

    const TEMPLATE = [
        '<div x-data="hangarReposUi()" x-init="init()">',
        '  <div class="d-flex align-items-center gap-3 mb-3">',
        '    <h5 class="mb-0 flex-grow-1">Repositories</h5>',
        '    <button type="button" class="btn btn-sm btn-outline-secondary" @click="refresh()"',
        '            :disabled="loading" aria-label="Refresh repositories">Refresh</button>',
        '    <button type="button" class="btn btn-sm btn-primary" @click="openAdd()">Add repository</button>',
        '  </div>',

        // Screen-level alert. The remediation of a typed error is an action button —
        // and only one the screen can actually honour, see alertActionLabel().
        '  <template x-if="alert">',
        '    <div :class="alertClass(alert)" role="alert">',
        '      <div class="d-flex align-items-start gap-3">',
        '        <div class="flex-grow-1">',
        '          <strong x-show="alert.context" x-text="alert.context"></strong>',
        '          <div x-text="alert.message"></div>',
        '          <ul x-show="showFiles && alert.files.length" class="small hangar-mono mt-2 mb-0">',
        '            <template x-for="f in alert.files" :key="f"><li x-text="f"></li></template>',
        '          </ul>',
        '          <pre x-show="alert.detail" class="hangar-rawlog mt-2 mb-0" x-text="alert.detail"></pre>',
        '        </div>',
        '        <button type="button" class="btn btn-sm btn-primary" x-show="alertActionLabel()"',
        '                :disabled="loading" @click="remediateAlert()"',
        '                x-text="alertActionLabel()"></button>',
        '        <button type="button" class="btn btn-sm btn-outline-secondary" @click="alert = null"',
        '                aria-label="Dismiss message">Dismiss</button>',
        '      </div>',
        '    </div>',
        '  </template>',

        // A repository file we could not read is a PARTIAL result: list what failed
        // and still show everything that worked. Warning, never danger.
        '  <div x-show="unreadable.length" class="alert alert-warning" role="alert">',
        '    <strong>Some repository files could not be read.</strong>',
        '    <div class="small">Everything else is listed below.</div>',
        '    <ul class="small hangar-mono mb-0 mt-2">',
        '      <template x-for="p in unreadable" :key="p"><li x-text="p"></li></template>',
        '    </ul>',
        '  </div>',

        '  <div x-show="loading" class="text-secondary small mb-2" role="status">Loading…</div>',

        '  <div x-show="!loading && rows.length === 0" class="hangar-empty">',
        '    <p class="mb-2">No repositories yet.</p>',
        '    <p class="small mb-3">A repository is where backups are stored — a folder on this',
        '       machine, a NAS over SFTP, or object storage.</p>',
        '    <button type="button" class="btn btn-primary" @click="openAdd()">Add your first repository</button>',
        '  </div>',

        // A list rather than a table: each repository owns one root element, which
        // is what Alpine's x-for requires, and it also lets a per-repository alert
        // sit with its repository instead of in a second <tr> the browser has to
        // be told to associate.
        '  <ul class="list-group" x-show="rows.length">',
        '    <template x-for="row in rows" :key="row.id">',
        '      <li class="list-group-item">',
        '        <div class="d-flex align-items-start gap-3 flex-wrap">',
        '          <div class="flex-grow-1">',
        '            <div><span x-text="row.title"></span>',
        '              <span class="badge text-bg-secondary ms-2" x-text="row.kindLabel"></span></div>',
        '            <div class="small text-secondary" x-text="row.location"></div>',
        '            <div class="small text-secondary hangar-mono" x-text="row.id"></div>',
        '          </div>',
        '          <div class="text-end">',
        '            <div class="hangar-mono" x-text="size(row)"></div>',
        '            <div class="small text-secondary">',
        '              <span x-text="snapshots(row)"></span> snapshot(s)</div>',
        '          </div>',
        '          <div class="btn-group btn-group-sm" role="group"',
        '               :aria-label="\'Actions for \' + row.title">',
        // Each button repeats its verb for every row, so the accessible name has to
        // name the repository too — "Test" five times over is unusable by voice or
        // by screen reader.
        '            <button type="button" class="btn btn-outline-secondary" @click="testConnection(row)"',
        '                    :disabled="!!row.busy" :aria-label="\'Test \' + row.title">Test</button>',
        '            <button type="button" class="btn btn-outline-secondary" @click="check(row)"',
        '                    :disabled="!!row.busy" :aria-label="\'Check \' + row.title">Check</button>',
        '            <button type="button" class="btn btn-outline-secondary" @click="unlock(row)"',
        '                    :disabled="!!row.busy" :aria-label="\'Unlock \' + row.title">Unlock</button>',
        '            <button type="button" class="btn btn-outline-secondary" @click="openEdit(row)"',
        '                    :disabled="!!row.busy" :aria-label="\'Edit \' + row.title">Edit</button>',
        '            <button type="button" class="btn btn-outline-danger" @click="remove(row)"',
        '                    :disabled="!!row.busy" :aria-label="\'Remove \' + row.title">Remove</button>',
        '          </div>',
        '        </div>',
        '        <div x-show="row.busy" class="small text-secondary mt-2" role="status"',
        '             aria-live="polite" x-text="busyLabel(row)"></div>',
        '        <div x-show="row.alert" role="alert" :class="alertClass(row.alert) + \' mt-2 mb-0\'">',
        '          <div class="d-flex align-items-start gap-3">',
        '            <div class="flex-grow-1">',
        '              <div x-text="row.alert && row.alert.message"></div>',
        '              <ul x-show="row.showFiles && row.alert && row.alert.files.length"',
        '                  class="small hangar-mono mt-2 mb-0">',
        '                <template x-for="f in (row.alert ? row.alert.files : [])" :key="f">',
        '                  <li x-text="f"></li>',
        '                </template>',
        '              </ul>',
        '              <pre x-show="row.alert && row.alert.detail" class="hangar-rawlog mt-2 mb-0"',
        '                   x-text="row.alert && row.alert.detail"></pre>',
        '            </div>',
        '            <button type="button" class="btn btn-sm btn-primary"',
        '                    x-show="row.alert && row.alert.actionLabel"',
        '                    :disabled="!!row.busy"',
        '                    @click="remediate(row)" x-text="row.alert && row.alert.actionLabel"></button>',
        '            <button type="button" class="btn btn-sm btn-outline-secondary"',
        '                    @click="row.alert = null" aria-label="Dismiss message">Dismiss</button>',
        '          </div>',
        '        </div>',
        '      </li>',
        '    </template>',
        '  </ul>',
        '</div>'
    ].join('\n');

    // index.html ships an empty #hangar-repos — the screens are injected by their
    // own feature module. This must happen before boot.js loads Alpine, which it
    // does: the feature scripts are parsed while the document is still 'loading',
    // and boot.js only fetches Alpine after its partials resolve.
    function mount(doc) {
        const d = doc || root.document || null;
        if (!d || typeof d.getElementById !== 'function') return false;
        const host = d.getElementById('hangar-repos');
        if (!host || host.getAttribute('data-hangar-mounted')) return false;
        host.setAttribute('data-hangar-mounted', '1');
        // TEMPLATE is a first-party constant in this file — no interpolation, no
        // user input — same trust model as boot.js injecting the modal partials.
        host.insertAdjacentHTML('beforeend', TEMPLATE);
        return true;
    }

    if (root.document && typeof root.addEventListener === 'function') {
        if (root.document.readyState === 'loading')
            root.addEventListener('DOMContentLoaded', function () { mount(); });
        else mount();
    }

    root.hangarReposUi = hangarReposUi;
    root.hangarRepoEdit = hangarRepoEdit;

    const HangarReposUi = {
        KIND_LABEL, FIELD, ORDER, CREDENTIAL_PAIRS, REMEDIATION_LABEL, TEMPLATE,
        kindLabel, kindChoices, remediationLabel, busyLabelFor, BUSY_LABEL,
        fieldsFor, blankForm, repoToFormState, formStateToRepo, mergeKind, validateForm,
        formatSize, formatCount, toRow, unreadableFrom, toAlert, okAlert, resultAlert,
        isAlreadyInitialised, deleteMessage, resticOptions, remoteOf, classifyRepoFailure,
        mount, repoEditDialog, hangarReposUi, hangarRepoEdit
    };
    root.HangarReposUi = HangarReposUi;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarReposUi;
})(typeof window !== 'undefined' ? window : globalThis);
