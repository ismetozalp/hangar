// engine/restic.js — the only module that knows the restic CLI.
//
// Everything here except run() is pure: argument construction, stream parsing and
// exit classification never touch `cockpit`, so `node --test` exercises the real
// code paths rather than a mock of them.
'use strict';
(function (root) {
    const Errors = (typeof require !== 'undefined' && typeof module !== 'undefined' && module.exports)
        ? require('../core/errors.js')
        : root.HangarErrors;

    const KIND = Errors.KIND;

    // Looked up when it is needed rather than captured at load time. index.html
    // loads core/rclone.js first, but a module that resolves a sibling at load
    // time breaks the moment someone reorders those script tags — and this one
    // must degrade to "no rclone knowledge", not to a TypeError on the failure
    // path, which is the worst possible place to throw.
    function rcloneModule() {
        if (typeof require === 'function' && typeof module !== 'undefined' && module.exports) {
            try {
                return require('../core/rclone.js');
            } catch (e) {
                return null;
            }
        }
        return root.HangarRclone || null;
    }

    // restic SPAWNS rclone as a subprocess for an `rclone:` repository, so when a
    // cloud destination's authorisation expires, rclone's message arrives inside
    // RESTIC's stderr and nowhere else. A check that only looked at direct rclone
    // invocations would miss every scheduled backup — which is to say, every case
    // that matters, because those are the ones nobody is watching.
    function rcloneAuthExpired(text) {
        const rc = rcloneModule();
        return !!(rc && typeof rc.isAuthExpired === 'function' && rc.isAuthExpired(text));
    }

    // ---------------------------------------------------------------- constants

    const OPS = [
        'init', 'backup', 'snapshots', 'forget', 'prune', 'check',
        'stats', 'restore', 'ls', 'diff', 'unlock', 'version'
    ];

    // `version` is the one op we run against a restic we have not vetted yet —
    // possibly the static-binary fallback — so we ask for its plain text line
    // instead of a JSON shape that only newer builds emit.
    const NO_JSON_OPS = new Set(['version']);

    // `version` is also the only op that is not repository scoped.
    const NO_REPO_OPS = new Set(['version']);

    // Verified table (CONVENTIONS.md, restic 0.19.1). Anything absent is UNKNOWN —
    // never silently treated as success.
    const EXIT_KINDS = {
        0: KIND.OK,
        1: KIND.GENERIC,
        2: KIND.GO_RUNTIME,
        3: KIND.READ_ERRORS,
        10: KIND.REPO_MISSING,
        11: KIND.REPO_LOCKED,
        12: KIND.WRONG_PASSWORD,
        130: KIND.CANCELLED
    };

    const MESSAGES = {
        [KIND.OK]: 'Completed successfully',
        [KIND.GENERIC]: 'restic reported an error',
        [KIND.GO_RUNTIME]: 'restic crashed with a Go runtime error',
        [KIND.READ_ERRORS]: 'Snapshot was written, but some files could not be read',
        [KIND.REPO_MISSING]: 'Repository does not exist',
        [KIND.REPO_LOCKED]: 'Repository is locked by another operation',
        [KIND.WRONG_PASSWORD]: 'Wrong repository password',
        [KIND.CANCELLED]: 'Operation was cancelled',
        [KIND.NO_SPACE]: 'No space left on the backup destination',
        [KIND.NETWORK]: 'Could not reach the repository over the network',
        [KIND.AUTH_EXPIRED]: 'This cloud destination needs to be authorised again — its sign-in has expired',
        // Not something restic can report — the refusal happens before restic is
        // reached — but the catalogue is exhaustive over KIND on purpose, so that
        // an error of any kind always renders as a sentence rather than a bare
        // enum. See tests/unit/restic.test.js.
        [KIND.ADMIN_REQUIRED]: 'Cockpit is running with limited access, so hangar cannot read its own configuration',
        [KIND.UNKNOWN]: 'restic exited with an unexpected status'
    };

    // Only consulted for exit 1: restic collapses every backend failure into the
    // generic code, so the text is the only signal separating "disk full" and
    // "the NAS is unreachable" — two conditions with very different remediations.
    const NO_SPACE_RE = /(no space left on device|disk quota exceeded|not enough (free )?space|ENOSPC|write: no space)/i;
    const NETWORK_RE = /(connection refused|connection reset|network is unreachable|no such host|i\/o timeout|dial tcp|temporary failure in name resolution|tls handshake timeout|could not connect|ssh: connect to host|host is down|no route to host)/i;

    // ---------------------------------------------------------------- pure: parse

    function isPlainObject(v) {
        return !!v && typeof v === 'object' && !Array.isArray(v);
    }

    // Every value crossing into this module (config JSON, a cockpit channel payload,
    // a caller's option bag) is converted exactly once, here. A null-prototype object
    // or a throwing toString would otherwise escape as an untyped TypeError past all
    // the typed error handling below; '' funnels it into the normal "missing" paths.
    function str(v) {
        try {
            return String(v);
        } catch (e) {
            return '';
        }
    }

    // Tolerant by design: a restic stream can carry progress text, shell noise from
    // a hook, or a final line cut off when the process died mid-write. Losing one
    // unparseable line must never lose the whole run's output.
    function parseJsonLines(text) {
        const out = [];
        if (text === null || text === undefined) return out;
        const lines = str(text).split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            let parsed;
            try {
                parsed = JSON.parse(line);
            } catch (e) {
                continue;                       // noise or truncated tail
            }
            // restic only ever emits objects; a bare scalar is noise that happened
            // to be valid JSON.
            if (isPlainObject(parsed)) out.push(parsed);
        }
        return out;
    }

    function findExitError(stderr) {
        const msgs = parseJsonLines(stderr);
        let found = null;
        for (let i = 0; i < msgs.length; i++)
            if (msgs[i].message_type === 'exit_error') found = msgs[i];
        return found;                           // last one wins
    }

    // Strict on purpose: `Number('')`, `Number('  ')`, `Number(false)` and `Number([])`
    // are all 0, i.e. success. An exit status we cannot read as an integer must become
    // UNKNOWN, never a silent OK — that is the whole point of the EXIT_KINDS table.
    function exitCode(v) {
        if (v === null || v === undefined || typeof v === 'boolean') return NaN;
        const s = str(v).trim();
        return /^[+-]?\d+$/.test(s) ? Number(s) : NaN;
    }

    function classifyExit(code, stderr) {
        const text = stderr === null || stderr === undefined ? '' : str(stderr);
        const exitError = findExitError(text);

        let n = exitCode(code);
        // A channel failure can leave us without an exit status while restic still
        // managed to print its exit_error object.
        if (!Number.isFinite(n) && exitError && Number.isFinite(exitCode(exitError.code)))
            n = exitCode(exitError.code);

        let kind = Number.isFinite(n) && Object.prototype.hasOwnProperty.call(EXIT_KINDS, n)
            ? EXIT_KINDS[n]
            : KIND.UNKNOWN;

        // Expiry is read from the message, never from a code: restic has no exit
        // status for "the backend's credential lapsed" and collapses it into 1.
        //
        // Only GENERIC and UNKNOWN are eligible, and that restraint is the point.
        // 10/11/12 carry restic's own authoritative answer, and 0/3/130 must never
        // be reclassified at all — exit 3 WROTE the snapshot, and turning a written
        // snapshot into a fatal failure because rclone grumbled about a token would
        // be a lie in the direction that costs the most trust.
        if (kind === KIND.GENERIC || kind === KIND.UNKNOWN) {
            if (rcloneAuthExpired(text)) kind = KIND.AUTH_EXPIRED;
        }

        if (kind === KIND.GENERIC) {
            if (NO_SPACE_RE.test(text)) kind = KIND.NO_SPACE;
            else if (NETWORK_RE.test(text)) kind = KIND.NETWORK;
        }

        // AUTH_EXPIRED is the one kind whose own sentence beats restic's: what
        // restic relays is rclone's jargon ("invalid_grant", "couldn't fetch
        // token"), which tells the user nothing they can act on. The raw text is
        // still carried in detail.stderr and detail.exitError for the log.
        const message = (kind !== KIND.AUTH_EXPIRED &&
            exitError && typeof exitError.message === 'string' && exitError.message.trim())
            ? exitError.message.trim()
            : MESSAGES[kind];

        return Errors.create(kind, message, {
            code: Number.isFinite(n) ? n : null,
            stderr: text,
            exitError: exitError
        });
    }

    // ---------------------------------------------------------------- pure: args

    function fail(message, detail) {
        throw Errors.create(KIND.GENERIC, message, detail === undefined ? null : detail);
    }

    function asList(v) {
        if (v === null || v === undefined) return [];
        return Array.isArray(v) ? v : [v];
    }

    // Drops empties so an unfilled form field cannot turn into an empty argument
    // that restic would interpret as the current directory.
    function cleanList(v) {
        return asList(v)
            .map((x) => (x === null || x === undefined ? '' : str(x)))
            .filter((x) => x.length > 0);
    }

    function repeat(flag, values, out) {
        cleanList(values).forEach((v) => { out.push(flag, v); });
    }

    // A flag whose operand vanished is worse than a missing flag: restic would read
    // the next argument as the operand, so `--host` would silently swallow the
    // operation name. Unset stays unset; unusable is dropped with it.
    function pushFlag(out, flag, value) {
        if (!value) return;
        const s = str(value);
        if (s) out.push(flag, s);
    }

    // Root-owned and outside any home directory, because every process that runs
    // restic here is root: the timer units, the Logbook mount unit, and the
    // browser's privileged channel. restic creates it on first use.
    const CACHE_DIR = '/var/cache/hangar/restic';

    function buildArgs(op, opts) {
        const o = opts || {};
        if (OPS.indexOf(op) < 0)
            fail('Unsupported restic operation: ' + str(op), { op: op });

        const args = [];
        const repo = o.repoUrl === null || o.repoUrl === undefined ? '' : str(o.repoUrl);
        if (!NO_REPO_OPS.has(op)) {
            if (!repo) fail('A repository URL is required for restic ' + op, { op: op });
            args.push('-r', repo);
        }
        pushFlag(args, '--password-file', o.passwordFile);
        // ALWAYS, on every operation. restic locates its cache from $XDG_CACHE_HOME
        // or $HOME, and a systemd unit has neither — so `restic mount` and every
        // scheduled `restic backup` exited 1 before touching the repository:
        //
        //   unable to locate cache directory: neither $XDG_CACHE_HOME nor $HOME
        //   are defined
        //
        // It worked from the browser only because the cockpit bridge happens to
        // carry a HOME. Depending on ambient environment for something this
        // load-bearing is how a backup fails every night in silence, so the path
        // is stated outright instead.
        // Repository-scoped operations only. `restic version` is hangar's presence
        // probe, and a probe that can fail for a reason unrelated to restic being
        // installed would report the wrong thing.
        // Overridable, but never absent: a host with a small /var can point it
        // elsewhere, and the integration suite runs as an ordinary user who
        // cannot write under /var/cache at all.
        if (!NO_REPO_OPS.has(op)) args.push('--cache-dir', str(o.cacheDir || CACHE_DIR));
        if (!NO_JSON_OPS.has(op)) args.push('--json');

        args.push(op);

        switch (op) {
        case 'init':
            break;

        case 'backup': {
            const paths = cleanList(o.paths);
            if (!paths.length) fail('backup requires at least one path', { op: op });
            if (o.oneFileSystem) args.push('--one-file-system');
            pushFlag(args, '--exclude-file', o.excludeFile);
            repeat('--exclude', o.excludes, args);
            repeat('--tag', o.tags, args);
            pushFlag(args, '--host', o.host);
            if (o.dryRun) args.push('--dry-run');
            // Backup paths come from user configuration and may legitimately begin
            // with a dash; `--` stops cobra reading them as flags.
            args.push('--');
            paths.forEach((p) => args.push(p));
            break;
        }

        case 'snapshots':
            repeat('--tag', o.tags, args);
            repeat('--path', o.paths, args);
            pushFlag(args, '--host', o.host);
            pushFlag(args, '--latest', o.latest);
            cleanList(o.snapshotIds).forEach((id) => args.push(id));
            break;

        case 'forget': {
            // Retention formatting belongs to core/retention.js — this module must not
            // grow a second opinion about what a policy means. It does refuse to relay
            // a hole in the list: an empty argv element is read by restic as a snapshot
            // id, so a half-filled policy would silently mean something else.
            const retention = cleanList(o.retentionArgs);
            retention.forEach((a) => args.push(a));
            if (o.groupBy && retention.indexOf('--group-by') < 0)
                pushFlag(args, '--group-by', o.groupBy);
            repeat('--tag', o.tags, args);
            pushFlag(args, '--host', o.host);
            if (o.prune) args.push('--prune');
            if (o.dryRun) args.push('--dry-run');
            cleanList(o.snapshotIds).forEach((id) => args.push(id));
            break;
        }

        case 'prune':
            if (o.dryRun) args.push('--dry-run');
            pushFlag(args, '--max-unused', o.maxUnused);
            break;

        case 'check':
            if (o.readData === true) args.push('--read-data');
            else pushFlag(args, '--read-data-subset', o.readData);
            if (o.withCache) args.push('--with-cache');
            break;

        case 'stats':
            pushFlag(args, '--mode', o.mode);
            pushFlag(args, '--host', o.host);
            cleanList(o.snapshotIds).forEach((id) => args.push(id));
            break;

        case 'restore': {
            const snapshot = o.snapshot === null || o.snapshot === undefined ? '' : str(o.snapshot);
            if (!snapshot) fail('restore requires a snapshot', { op: op });
            const target = o.target ? str(o.target) : '';
            if (!target) fail('restore requires a target directory', { op: op });
            args.push('--target', target);
            repeat('--include', o.include, args);
            repeat('--exclude', o.excludes, args);
            if (o.verify) args.push('--verify');
            args.push(snapshot);
            break;
        }

        case 'ls': {
            const snapshot = o.snapshot === null || o.snapshot === undefined ? '' : str(o.snapshot);
            if (!snapshot) fail('ls requires a snapshot', { op: op });
            if (o.long) args.push('--long');
            if (o.recursive) args.push('--recursive');
            args.push(snapshot);
            const paths = cleanList(o.paths);
            if (paths.length) {
                args.push('--');
                paths.forEach((p) => args.push(p));
            }
            break;
        }

        case 'diff': {
            const a = o.snapshotA === null || o.snapshotA === undefined ? '' : str(o.snapshotA);
            const b = o.snapshotB === null || o.snapshotB === undefined ? '' : str(o.snapshotB);
            if (!a || !b) fail('diff requires two snapshots', { op: op });
            if (o.metadata) args.push('--metadata');
            args.push(a, b);
            break;
        }

        case 'unlock':
            if (o.removeAll) args.push('--remove-all');
            break;

        case 'version':
            break;
        }

        return args;
    }

    // ---------------------------------------------------------------- pure: fold

    // Folds a JSON-lines stream into the single state the UI renders. Only the last
    // summary and the last status matter; every error is kept because the READ_ERRORS
    // case has to list the unreadable files rather than just say "partial".
    function summarize(messages) {
        const list = Array.isArray(messages) ? messages : [];
        let summary = null;
        let progress = null;
        let exitError = null;
        const errors = [];

        for (let i = 0; i < list.length; i++) {
            const m = list[i];
            if (!isPlainObject(m)) continue;
            switch (m.message_type) {
            case 'summary': summary = m; break;
            case 'status': progress = m; break;
            case 'error': errors.push(m); break;
            case 'exit_error': exitError = m; errors.push(m); break;
            default: break;                     // unknown types pass through untouched
            }
        }

        let status;
        if (exitError) status = 'failed';
        else if (summary && errors.length) status = 'partial';
        else if (summary) status = 'ok';
        else if (errors.length) status = 'failed';
        else if (progress) status = 'running';
        else status = 'unknown';

        return { status: status, summary: summary, errors: errors, progress: progress };
    }

    // ------------------------------------------------- pure: single JSON documents

    function parseDocument(text, what) {
        const raw = text === null || text === undefined ? '' : str(text).trim();
        if (!raw) return null;                  // restic prints nothing for an empty result
        try {
            return JSON.parse(raw);
        } catch (e) {
            return fail('Could not parse restic ' + what + ' output', { text: raw.slice(0, 2000) });
        }
    }

    function shortIdOf(s) {
        if (s.short_id) return String(s.short_id);
        return s.id ? String(s.id).slice(0, 8) : '';
    }

    function normalizeSnapshot(s) {
        return {
            id: s.id ? String(s.id) : '',
            shortId: shortIdOf(s),
            time: s.time || null,
            hostname: s.hostname || '',
            username: s.username || '',
            paths: asList(s.paths).map(String),
            tags: asList(s.tags).map(String),
            excludes: asList(s.excludes).map(String),
            parent: s.parent || null,
            tree: s.tree || null,
            programVersion: s.program_version || '',
            summary: isPlainObject(s.summary) ? s.summary : null
        };
    }

    function parseSnapshots(text) {
        const doc = parseDocument(text, 'snapshots');
        if (doc === null) return [];
        if (!Array.isArray(doc)) fail('restic snapshots did not return a list', { doc: doc });
        return doc.filter(isPlainObject).map(normalizeSnapshot);
    }

    function parseForget(text) {
        const doc = parseDocument(text, 'forget');
        if (doc === null) return { groups: [], kept: 0, removed: 0 };
        if (!Array.isArray(doc)) fail('restic forget did not return a list', { doc: doc });

        let kept = 0;
        let removed = 0;
        const groups = doc.filter(isPlainObject).map((g) => {
            const keep = asList(g.keep).filter(isPlainObject).map(normalizeSnapshot);
            const remove = asList(g.remove).filter(isPlainObject).map(normalizeSnapshot);
            kept += keep.length;
            removed += remove.length;
            return {
                host: g.host || '',
                paths: asList(g.paths).map(String),
                tags: asList(g.tags).map(String),
                keep: keep,
                remove: remove,
                reasons: asList(g.reasons)
            };
        });
        return { groups: groups, kept: kept, removed: removed };
    }

    function num(v) {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    }

    function parseStats(text) {
        const doc = parseDocument(text, 'stats');
        const s = isPlainObject(doc) ? doc : {};
        return {
            totalSize: num(s.total_size),
            totalFileCount: num(s.total_file_count),
            totalBlobCount: num(s.total_blob_count),
            totalUncompressedSize: num(s.total_uncompressed_size),
            compressionRatio: num(s.compression_ratio),
            compressionSpaceSaving: num(s.compression_space_saving),
            snapshotsCount: num(s.snapshots_count)
        };
    }

    function emptyDiff() {
        return { source: null, target: null, added: [], removed: [], changed: [], other: [], stats: null };
    }

    function applyChange(out, change) {
        const path = change.path ? String(change.path) : '';
        const modifier = change.modifier === null || change.modifier === undefined ? '' : String(change.modifier);
        const entry = { path: path, modifier: modifier };
        if (modifier.indexOf('+') >= 0) out.added.push(entry);
        else if (modifier.indexOf('-') >= 0) out.removed.push(entry);
        else if (modifier.indexOf('M') >= 0 || modifier.indexOf('T') >= 0 || modifier.indexOf('U') >= 0) out.changed.push(entry);
        else out.other.push(entry);             // an unseen modifier is surfaced, not dropped
    }

    function parseDiff(text) {
        const raw = text === null || text === undefined ? '' : str(text).trim();
        const out = emptyDiff();
        if (!raw) return out;

        let doc = null;
        try {
            doc = JSON.parse(raw);
        } catch (e) {
            doc = null;
        }

        if (isPlainObject(doc)) {
            out.source = doc.source_snapshot || null;
            out.target = doc.target_snapshot || null;
            out.stats = isPlainObject(doc.statistics) ? doc.statistics : null;
            asList(doc.changes).filter(isPlainObject).forEach((c) => applyChange(out, c));
            return out;
        }

        // CONVENTIONS records diff as a single document; tolerate the JSON-lines
        // shape too so a differing restic build degrades to a correct diff rather
        // than an empty Logbook.
        const msgs = parseJsonLines(raw);
        if (!msgs.length) fail('Could not parse restic diff output', { text: raw.slice(0, 2000) });
        msgs.forEach((m) => {
            if (m.message_type === 'statistics') {
                out.stats = m;
                if (m.source_snapshot) out.source = m.source_snapshot;
                if (m.target_snapshot) out.target = m.target_snapshot;
            } else if (m.path !== undefined) {
                applyChange(out, m);
            }
        });
        return out;
    }

    // ---------------------------------------------------------------- impure: run

    // The only function in this module that touches cockpit. It must not throw at
    // load time under node, hence the typeof guard rather than a top-level capture.
    function run(op, opts, onProgress) {
        const o = opts || {};
        let argv;
        try {
            // cockpit.spawn takes a list of strings; a configured binary that is not
            // one (or not usable as one) falls back rather than reaching the bridge.
            const binary = o.binary ? str(o.binary) : '';
            argv = [binary || 'restic'].concat(buildArgs(op, o));
        } catch (e) {
            return Promise.reject(e);
        }

        if (typeof cockpit === 'undefined' || !cockpit || typeof cockpit.spawn !== 'function')
            return Promise.reject(Errors.create(KIND.GENERIC, 'cockpit is not available', { op: op, argv: argv }));

        // Opening the channel can fail outright (no superuser bridge, protocol error).
        // Callers only ever .catch() this function, so a synchronous throw here would
        // escape every error path they have.
        let proc;
        try {
            proc = cockpit.spawn(argv, { superuser: 'require', err: 'message' });
        } catch (e) {
            return Promise.reject(Errors.create(KIND.GENERIC, 'Could not start restic', { op: op, argv: argv, cause: str(e && e.message) }));
        }
        if (!proc || typeof proc.then !== 'function')
            return Promise.reject(Errors.create(KIND.GENERIC, 'Could not start restic', { op: op, argv: argv }));

        const messages = [];
        let pending = '';

        function emit(msgs) {
            for (let i = 0; i < msgs.length; i++) {
                const m = msgs[i];
                messages.push(m);
                if (m.message_type === 'status' && typeof onProgress === 'function') {
                    try {
                        onProgress(m);
                    } catch (e) {
                        // A rendering callback must never abort a running backup.
                    }
                }
            }
        }

        function feed(chunk) {
            pending += (chunk === null || chunk === undefined) ? '' : str(chunk);
            const cut = pending.lastIndexOf('\n');
            if (cut < 0) return;                // hold a partial line until it completes
            const complete = pending.slice(0, cut);
            pending = pending.slice(cut + 1);
            emit(parseJsonLines(complete));
        }

        if (typeof proc.stream === 'function') proc.stream(feed);

        return new Promise((resolve, reject) => {
            proc.then((data) => {
                feed(data);
                emit(parseJsonLines(pending));
                pending = '';
                resolve(summarize(messages));
            }, (ex) => {
                emit(parseJsonLines(pending));
                pending = '';
                // Only an object carries an exit status. `ex && ex.exit_status` yields
                // ex itself for a falsy reason, and a channel that rejected with 0
                // would then classify as OK — a failure reported as a finished backup.
                const reason = isPlainObject(ex) ? ex : {};
                const err = classifyExit(reason.exit_status, reason.message || reason.problem || '');
                // READ_ERRORS (3) and CANCELLED (130) are outcomes, not failures:
                // exit 3 still wrote the snapshot. Rejecting would teach users to
                // ignore the errors that do matter.
                if (!Errors.isFatal(err)) {
                    const result = summarize(messages);
                    result.status = err.kind === KIND.CANCELLED ? 'cancelled' : 'partial';
                    result.error = err;
                    resolve(result);
                    return;
                }
                reject(err);
            });
        });
    }

    const HangarRestic = {
        OPS,
        EXIT_KINDS,
        MESSAGES,
        CACHE_DIR,
        parseJsonLines,
        classifyExit,
        buildArgs,
        summarize,
        parseSnapshots,
        parseForget,
        parseStats,
        parseDiff,
        run
    };
    root.HangarRestic = HangarRestic;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarRestic;
})(typeof window !== 'undefined' ? window : globalThis);
