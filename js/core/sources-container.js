// core/sources-container.js — the 'container' source kind: podman or docker volumes.
//
// Registers itself into the v1 seam (HangarSources.registerKind) rather than
// teaching the engine a second vocabulary. Everything the engine asks for —
// validate / normalize / toResticArgs / describe — is pure; only detectRuntime,
// listVolumes and resolve touch cockpit, and they degrade to a typed error under
// node so this file loads cleanly in `node --test`.
//
// Three facts drive the design, and each of them was a real trap:
//
//  1. A volume's bytes live at whatever the runtime says its Mountpoint is.
//     Rootless podman, rootful podman and docker all answer differently, so
//     nothing here hardcodes /var/lib/docker/volumes or ~/.local/share/containers.
//     Paths are therefore NOT known at config time — hence resolvedPaths and the
//     typed "resolve first" error in toResticArgs.
//
//  2. Rootless runtimes are per-user. The volumes belong to the user's own
//     containers store; hangar-run executes as root from a systemd unit, and
//     root's podman is a DIFFERENT store that would answer "no such volume" —
//     or worse, silently answer about nothing. Every runtime command is therefore
//     wrapped by asUser(), and a podman source with no recorded owner is warned about.
//
//  3. `<rt> volume ls --format json` is not portable: podman emits a JSON array,
//     docker's --format takes a Go template and emits one object per line. The
//     only calls that behave identically on both are `volume ls -q` and
//     `volume inspect <name>`, so those are the only ones used — and the inspect
//     parser tolerates both shapes anyway, because docker users do reach for
//     `--format '{{json .}}'`.
'use strict';
(function (root) {
    // Dual-load: require() under node --test, the already-loaded global in the browser.
    const req = (typeof module !== 'undefined' && module.exports && typeof require === 'function')
        ? require
        : null;

    const Errors = root.HangarErrors || (req ? req('./errors.js') : null);
    // May legitimately be absent: this module must load and be unit-testable on
    // its own, so registration is conditional rather than assumed.
    const Sources = root.HangarSources || (req ? req('./sources.js') : null);

    const SEVERITY = (Sources && Sources.SEVERITY) || { ERROR: 'error', WARNING: 'warning' };

    const RUNTIMES = ['podman', 'docker'];
    const DEFAULT_RUNTIME = 'podman';

    const RISK = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

    // Fixed order, worst-to-best: the UI renders the picker from this and the
    // ordering is the advice.
    const CONSISTENCY_IDS = ['none', 'pause', 'stop', 'command'];

    const CONSISTENCY = {
        none: {
            id: 'none',
            label: 'Live copy',
            risk: RISK.HIGH,
            description: 'Copy the volume files while the container keeps running. ' +
                'Correct for static assets, and unsafe for a running database: the files ' +
                'are captured mid-write and the backup may not restore.'
        },
        pause: {
            id: 'pause',
            label: 'Pause containers',
            risk: RISK.MEDIUM,
            description: 'Pause the containers for the duration of the copy. Better than ' +
                'a live copy, but still no guarantee — writes already buffered inside the ' +
                'process are frozen in memory, not flushed to disk.'
        },
        stop: {
            id: 'stop',
            label: 'Stop containers',
            risk: RISK.LOW,
            description: 'Stop the containers, copy, then start them again. The only ' +
                'file-level mode that is actually safe for a database, at the cost of ' +
                'downtime for the length of the backup.'
        },
        command: {
            id: 'command',
            label: 'Dump command',
            risk: RISK.LOW,
            description: 'Run a dump command inside the container (mongodump, pg_dump, ' +
                'mysqldump) and back up its output. Safest and needs no downtime, but you ' +
                'must supply the command and write the dump into one of the backed-up volumes.'
        }
    };
    const DEFAULT_CONSISTENCY = 'none';

    // Substring hints, not exact names: real containers are called "app-postgres-1",
    // "mongo_primary", "prod.redis". A false positive costs a dismissible warning;
    // a false negative costs an unrestorable database backup.
    const DATABASE_HINTS = [
        'mongo', 'postgres', 'mysql', 'mariadb', 'redis',
        'elastic', 'kafka', 'cassandra', 'clickhouse'
    ];

    // Same codes as core/sources.js where they overlap — the UI keys remediation
    // off the code, so a container source reporting a bad id must report it with
    // the id the filesystem kind already uses.
    const PROBLEM = {
        BAD_SOURCE: 'bad-source',
        BAD_ID: 'bad-id',
        BAD_RUNTIME: 'bad-runtime',
        BAD_USER: 'bad-user',
        NO_USER: 'no-user',
        NO_VOLUMES: 'no-volumes',
        VOLUME_TYPE: 'volume-type',
        VOLUME_EMPTY: 'volume-empty',
        VOLUME_UNSAFE: 'volume-unsafe',
        VOLUME_DUPLICATE: 'volume-duplicate',
        CONTAINER_TYPE: 'container-type',
        CONTAINER_EMPTY: 'container-empty',
        CONTAINER_UNSAFE: 'container-unsafe',
        CONTAINER_DUPLICATE: 'container-duplicate',
        BAD_CONSISTENCY: 'bad-consistency',
        NO_COMMAND: 'no-command',
        NO_CONTAINERS: 'no-containers',
        COMMAND_TYPE: 'command-type',
        COMMAND_NUL: 'command-nul',
        LIVE_DATABASE: 'live-database',
        PATTERN_TYPE: 'pattern-type',
        PATTERN_EMPTY: 'pattern-empty',
        PATTERN_NUL: 'pattern-nul',
        TAG_TYPE: 'tag-type',
        TAG_EMPTY: 'tag-empty',
        TAG_COMMA: 'tag-comma',
        TAG_NUL: 'tag-nul',
        NOT_RESOLVED: 'not-resolved'
    };

    const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

    // Both runtimes enforce this for volume and container names, so an allowlist
    // is not us being strict — it is the runtime's own rule. It also happens to
    // exclude every shell metacharacter, whitespace, NUL and newline, and forbids
    // a leading dash that argv would read as a flag.
    const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

    // Deliberately permissive about case and length within reason: distros disagree
    // (useradd's NAME_REGEX, SSSD's domain\user, trailing '$' machine accounts), and
    // the job here is to keep a shell metacharacter or a leading dash out of argv,
    // not to re-implement getpwnam.
    const USER_RE = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/;

    function isString(v) { return typeof v === 'string'; }
    function hasNul(s) { return s.indexOf('\u0000') >= 0; }
    function byCodeUnit(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

    function toArray(v) {
        if (Array.isArray(v)) return v.slice();
        if (v === undefined || v === null) return [];
        return [v];
    }

    function dedupe(list) {
        const seen = new Set();
        const out = [];
        list.forEach((v) => { if (!seen.has(v)) { seen.add(v); out.push(v); } });
        return out;
    }

    // Mirrors HangarSources.canonicalPath. Duplicated rather than imported because
    // this module must still load with HangarSources absent; it is four lines and
    // the shared unit tests pin both copies to the same behaviour.
    function canonicalPath(p) {
        if (!isString(p) || p === '') return '';
        const collapsed = p.replace(/\/{2,}/g, '/');
        return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
    }

    function problem(severity, code, message, extra) {
        const p = { severity, code, message };
        if (extra) Object.keys(extra).forEach((k) => { p[k] = extra[k]; });
        return p;
    }

    function fail(message, detail) {
        return Errors.create(Errors.KIND.GENERIC, message, detail === undefined ? null : detail);
    }

    // Untrusted config quoted into a message must never be the thing that throws.
    function label(v) {
        try { return String(v); } catch (e) { return typeof v; }
    }

    function isSafeName(name) {
        return isString(name) && NAME_RE.test(name);
    }

    // Why a name was rejected, for the message. Ordered most-specific first so
    // "contains a NUL byte" wins over the generic charset complaint.
    function nameFault(name) {
        if (!isString(name)) return 'is not a string';
        if (name === '') return 'is empty';
        if (hasNul(name)) return 'contains a NUL byte';
        if (/[\r\n]/.test(name)) return 'contains a newline';
        if (name.charAt(0) === '-') return 'starts with a dash and would be read as a flag';
        if (NAME_RE.test(name)) return '';
        return 'contains characters the container runtime does not allow ' +
            '(letters, digits, dot, dash and underscore only)';
    }

    // pause / stop / exec put a container name in argv too, and a name that
    // validate() would have rejected must not reach argv through that other door:
    // `podman stop --all` stops every container on the host, and `exec --latest`
    // runs the dump command inside whichever container happened to start last.
    // Same rule and same typed refusal as volumeInspectArgv.
    function requireSafeContainer(name) {
        const fault = nameFault(name);
        if (fault)
            throw fail('Container name "' + label(name) + '" ' + fault + '.', { container: name });
        return name;
    }

    // The dump command is the one field that is allowed to carry shell syntax —
    // it runs under `sh -c` inside the container, so pipes and redirection are
    // the point. A NUL is still not: execve truncates the argument at it, so the
    // command that ran would not be the command that was reviewed. Same typed
    // refusal at the same seam as requireSafeContainer, because preCommands() is
    // callable directly and must not rely on validate() having been asked first.
    function requireSafeCommand(command) {
        if (hasNul(command))
            throw fail('The dump command contains a NUL byte.', { command: command });
        return command;
    }

    function isKnownRuntime(rt) { return RUNTIMES.indexOf(rt) >= 0; }

    // Returns the matched hint, or '' — the caller puts it in the warning so the
    // user can see why hangar thinks this is a database.
    function databaseHint(name) {
        if (!isString(name)) return '';
        const lower = name.toLowerCase();
        for (let i = 0; i < DATABASE_HINTS.length; i++) {
            if (lower.indexOf(DATABASE_HINTS[i]) >= 0) return DATABASE_HINTS[i];
        }
        return '';
    }

    function looksLikeDatabase(name) { return databaseHint(name) !== ''; }

    // ---- argv construction -------------------------------------------------

    // Rootless podman keeps its volumes in the *user's* store. hangar-run is root,
    // and root's podman would answer about a different, empty store — the failure
    // mode is a backup that silently contains nothing. runuser (not sudo, not su)
    // because it is in util-linux on every target distro, needs no PAM password
    // when already root, and `--` stops option parsing dead.
    function asUser(user, argv) {
        if (!Array.isArray(argv))
            throw fail('A runtime command must be an argument vector.', { argv });
        // A non-string element does not survive the trip to execve intact — cockpit
        // stringifies it, so `null` would silently become the literal argument
        // "null" and land wherever a name was meant to be.
        if (!argv.every(isString))
            throw fail('A runtime command must be an argument vector of strings.', { argv });
        if (user === undefined || user === null || user === '' || user === 'root')
            return argv.slice();
        if (!isString(user) || !USER_RE.test(user))
            throw fail('"' + label(user) + '" is not a valid user name.', { user });
        return ['runuser', '-u', user, '--'].concat(argv);
    }

    function requireRuntime(runtime) {
        const rt = (runtime === undefined || runtime === null || runtime === '')
            ? DEFAULT_RUNTIME : runtime;
        if (!isString(rt) || !isKnownRuntime(rt))
            throw fail('Unknown container runtime "' + label(runtime) + '".',
                { runtime, known: RUNTIMES.slice() });
        return rt;
    }

    // `volume ls -q` and not `--format json`: podman's --format json emits an
    // array, docker's --format is a Go template and emits one object per line.
    // -q is newline-separated names on both.
    function volumeListArgv(runtime, user) {
        return asUser(user, [requireRuntime(runtime), 'volume', 'ls', '-q']);
    }

    function volumeInspectArgv(runtime, user, name) {
        const rt = requireRuntime(runtime);
        const fault = nameFault(name);
        if (fault) throw fail('Volume name "' + label(name) + '" ' + fault + '.', { volume: name });
        return asUser(user, [rt, 'volume', 'inspect', name]);
    }

    function containerListArgv(runtime, user) {
        return asUser(user, [requireRuntime(runtime), 'ps', '-a', '--format', '{{.Names}}']);
    }

    // ---- parsing -----------------------------------------------------------

    function parseVolumeNames(text) {
        if (!isString(text)) return [];
        return text.split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line !== '');
    }

    // Pull out every top-level JSON value in the text.
    //
    // Needed because the output shape is not one thing: podman and docker both
    // return an array from `volume inspect`, but docker's `--format '{{json .}}'`
    // returns one object per line, and inspecting several volumes in one call can
    // concatenate documents. A brace-depth scan that respects strings and escapes
    // handles all three, including pretty-printed objects that a line split would
    // shred.
    function extractJsonValues(text) {
        const out = [];
        let depth = 0;
        let start = -1;
        let inString = false;
        let escaped = false;

        for (let i = 0; i < text.length; i++) {
            const c = text.charAt(i);
            if (inString) {
                if (escaped) escaped = false;
                else if (c === '\\') escaped = true;
                else if (c === '"') inString = false;
                continue;
            }
            if (c === '"') { inString = true; continue; }
            if (c === '{' || c === '[') {
                if (depth === 0) start = i;
                depth++;
                continue;
            }
            if (c === '}' || c === ']') {
                if (depth === 0) continue;       // stray closer in noise, ignore
                depth--;
                if (depth === 0 && start >= 0) {
                    try { out.push(JSON.parse(text.slice(start, i + 1))); } catch (e) { /* not JSON, skip */ }
                    start = -1;
                }
            }
        }
        return out;
    }

    function pick(obj, names) {
        for (let i = 0; i < names.length; i++) {
            const v = obj[names[i]];
            if (v !== undefined && v !== null) return v;
        }
        return undefined;
    }

    function parseVolumeInspect(text) {
        if (!isString(text) || text.trim() === '') return [];

        let values;
        try {
            values = [JSON.parse(text)];
        } catch (e) {
            values = extractJsonValues(text);
        }

        // Flattened with an explicit stack, not recursion: JSON.parse happily
        // accepts tens of thousands of nested arrays, and a recursive walk of that
        // raises a bare RangeError — an untyped throw out of a parser, from data
        // we did not write.
        const flat = [];
        const stack = values.slice().reverse();
        while (stack.length) {
            const v = stack.pop();
            if (Array.isArray(v)) {
                for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]);
            } else if (v && typeof v === 'object') {
                flat.push(v);
            }
        }

        const out = [];
        flat.forEach((entry) => {
            const name = pick(entry, ['Name', 'name']);
            // An entry we cannot key by name cannot be matched to a requested
            // volume, so it is noise rather than data.
            if (!isString(name) || name === '') return;
            const mp = pick(entry, ['Mountpoint', 'mountpoint', 'MountPoint']);
            const labels = pick(entry, ['Labels', 'labels']);
            const driver = pick(entry, ['Driver', 'driver']);
            out.push({
                name,
                mountpoint: isString(mp) ? canonicalPath(mp) : '',
                labels: (labels && typeof labels === 'object' && !Array.isArray(labels)) ? labels : {},
                driver: isString(driver) ? driver : ''
            });
        });
        return out;
    }

    // Ordered by `wanted` (not by inspection order) so the caller controls the
    // vector; unknown or mountpoint-less volumes are dropped rather than turned
    // into an empty positional that restic would read as the current directory.
    function mountpointsFor(inspected, wanted) {
        const entries = toArray(inspected).filter((e) => e && typeof e === 'object');
        const names = toArray(wanted).filter(isString);
        const pool = names.length ? names : entries.map((e) => e.name);

        const byName = new Map();
        entries.forEach((e) => { if (!byName.has(e.name)) byName.set(e.name, e); });

        const paths = [];
        pool.forEach((n) => {
            const e = byName.get(n);
            const mp = e && isString(e.mountpoint) ? canonicalPath(e.mountpoint) : '';
            // JSON can carry a NUL that no real path can, and execve truncates at
            // one — restic would silently back up a shorter path than we asked for.
            // Dropping it here surfaces as "volume has no mount point" in resolve(),
            // which names the volume the user has to look at.
            if (mp !== '' && mp.charAt(0) === '/' && !hasNul(mp)) paths.push(mp);
        });
        return dedupe(paths);
    }

    // ---- normalize ---------------------------------------------------------

    function normalize(source) {
        const s = (source && typeof source === 'object' && !Array.isArray(source)) ? source : {};
        const runtime = isKnownRuntime(s.runtime) ? s.runtime : DEFAULT_RUNTIME;
        const consistency = (isString(s.consistency) && CONSISTENCY[s.consistency])
            ? s.consistency : DEFAULT_CONSISTENCY;
        return {
            id: isString(s.id) ? s.id : '',
            kind: 'container',
            runtime,
            user: isString(s.user) ? s.user : '',
            // Volumes are a set, so sorting them makes the restic path vector — and
            // therefore `forget --group-by host,paths` — independent of the order
            // they were clicked in.
            volumes: dedupe(toArray(s.volumes).filter(isString).filter((v) => v !== '')).sort(byCodeUnit),
            consistency,
            command: isString(s.command) ? s.command : '',
            // Containers keep author order: stop order is dependency order (app
            // before its database), and sorting would silently reorder a shutdown.
            containers: dedupe(toArray(s.containers).filter(isString).filter((c) => c !== '')),
            excludes: dedupe(toArray(s.excludes).filter(isString)),
            tags: dedupe(toArray(s.tags).filter(isString).filter((t) => t !== '')),
            resolvedPaths: dedupe(toArray(s.resolvedPaths).filter(isString).map(canonicalPath)
                .filter((p) => p !== '')).sort(byCodeUnit)
        };
    }

    // ---- validate ----------------------------------------------------------

    function checkNameList(value, spec, out) {
        if (value === undefined || value === null) return [];
        if (!Array.isArray(value)) {
            out.push(problem(SEVERITY.ERROR, spec.typeCode,
                'Field "' + spec.field + '" must be an array of names.', { field: spec.field }));
            return [];
        }
        const seen = new Set();
        const good = [];
        value.forEach((name, index) => {
            if (!isString(name)) {
                out.push(problem(SEVERITY.ERROR, spec.typeCode,
                    spec.noun + ' names must be strings.', { field: spec.field, index }));
                return;
            }
            if (name === '') {
                out.push(problem(SEVERITY.ERROR, spec.emptyCode,
                    'A ' + spec.noun.toLowerCase() + ' name is empty.', { field: spec.field, index }));
                return;
            }
            const fault = nameFault(name);
            if (fault) {
                out.push(problem(SEVERITY.ERROR, spec.unsafeCode,
                    spec.noun + ' name "' + name + '" ' + fault + '.',
                    { field: spec.field, index, name, reason: fault }));
                return;
            }
            if (seen.has(name)) {
                out.push(problem(SEVERITY.ERROR, spec.dupCode,
                    spec.noun + ' "' + name + '" is listed more than once.',
                    { field: spec.field, index, name }));
                return;
            }
            seen.add(name);
            good.push(name);
        });
        return good;
    }

    function checkPatterns(source, out) {
        const v = source.excludes;
        if (v === undefined || v === null) return;
        if (!Array.isArray(v)) {
            out.push(problem(SEVERITY.ERROR, PROBLEM.PATTERN_TYPE,
                'Field "excludes" must be an array of patterns.', { field: 'excludes' }));
            return;
        }
        v.forEach((pat, index) => {
            if (!isString(pat))
                out.push(problem(SEVERITY.ERROR, PROBLEM.PATTERN_TYPE,
                    'Exclude patterns must be strings.', { field: 'excludes', index }));
            else if (hasNul(pat))
                out.push(problem(SEVERITY.ERROR, PROBLEM.PATTERN_NUL,
                    'An exclude pattern contains a NUL byte.', { field: 'excludes', index }));
            else if (pat === '')
                out.push(problem(SEVERITY.ERROR, PROBLEM.PATTERN_EMPTY,
                    'An exclude pattern is empty.', { field: 'excludes', index }));
        });
    }

    function checkTags(source, out) {
        const v = source.tags;
        if (v === undefined || v === null) return;
        if (!Array.isArray(v)) {
            out.push(problem(SEVERITY.ERROR, PROBLEM.TAG_TYPE, 'Field "tags" must be an array.'));
            return;
        }
        v.forEach((t, index) => {
            if (!isString(t))
                out.push(problem(SEVERITY.ERROR, PROBLEM.TAG_TYPE, 'Tags must be strings.', { index }));
            else if (hasNul(t))
                out.push(problem(SEVERITY.ERROR, PROBLEM.TAG_NUL, 'A tag contains a NUL byte.', { index }));
            else if (t === '')
                out.push(problem(SEVERITY.ERROR, PROBLEM.TAG_EMPTY, 'A tag is empty.', { index }));
            else if (t.indexOf(',') >= 0)
                // restic splits --tag on commas, so one tag would silently become two.
                out.push(problem(SEVERITY.ERROR, PROBLEM.TAG_COMMA,
                    'Tag "' + t + '" contains a comma.', { index, tag: t }));
        });
    }

    function validate(source) {
        if (!source || typeof source !== 'object' || Array.isArray(source))
            return [problem(SEVERITY.ERROR, PROBLEM.BAD_SOURCE, 'A backup source must be an object.')];

        const out = [];

        if (!isString(source.id) || !ID_RE.test(source.id))
            out.push(problem(SEVERITY.ERROR, PROBLEM.BAD_ID,
                'A source needs an id of letters, digits, dot, dash or underscore.'));

        const runtimeGiven = !(source.runtime === undefined || source.runtime === null || source.runtime === '');
        const runtime = runtimeGiven ? source.runtime : DEFAULT_RUNTIME;
        if (runtimeGiven && !isKnownRuntime(source.runtime))
            out.push(problem(SEVERITY.ERROR, PROBLEM.BAD_RUNTIME,
                'Unknown container runtime "' + label(source.runtime) + '".',
                { runtime: source.runtime, known: RUNTIMES.slice() }));

        const userGiven = !(source.user === undefined || source.user === null || source.user === '');
        if (userGiven && (!isString(source.user) || !USER_RE.test(source.user)))
            out.push(problem(SEVERITY.ERROR, PROBLEM.BAD_USER,
                '"' + label(source.user) + '" is not a valid user name.', { user: source.user }));
        else if (!userGiven && runtime === 'podman')
            // Not an error: a rootful podman source is legitimate. But the backup
            // runs as root from a systemd unit, and rootless volumes live in the
            // user's own store, so an unrecorded owner is the single most likely
            // reason a container backup comes back empty.
            out.push(problem(SEVERITY.WARNING, PROBLEM.NO_USER,
                'No user is recorded for this podman source, so the backup will use ' +
                'root\'s container store. Rootless volumes belong to their own user and ' +
                'will not be found there.', { runtime }));

        if (!Array.isArray(source.volumes) || source.volumes.length === 0)
            out.push(problem(SEVERITY.ERROR, PROBLEM.NO_VOLUMES,
                'A container source must list at least one volume.'));
        else
            checkNameList(source.volumes, {
                field: 'volumes', noun: 'Volume',
                typeCode: PROBLEM.VOLUME_TYPE, emptyCode: PROBLEM.VOLUME_EMPTY,
                unsafeCode: PROBLEM.VOLUME_UNSAFE, dupCode: PROBLEM.VOLUME_DUPLICATE
            }, out);

        const containers = checkNameList(source.containers, {
            field: 'containers', noun: 'Container',
            typeCode: PROBLEM.CONTAINER_TYPE, emptyCode: PROBLEM.CONTAINER_EMPTY,
            unsafeCode: PROBLEM.CONTAINER_UNSAFE, dupCode: PROBLEM.CONTAINER_DUPLICATE
        }, out);

        const consistencyGiven = !(source.consistency === undefined || source.consistency === null
            || source.consistency === '');
        const consistency = consistencyGiven ? source.consistency : DEFAULT_CONSISTENCY;
        if (consistencyGiven && !(isString(consistency) && CONSISTENCY[consistency])) {
            out.push(problem(SEVERITY.ERROR, PROBLEM.BAD_CONSISTENCY,
                'Unknown consistency mode "' + label(source.consistency) + '".',
                { consistency: source.consistency, known: CONSISTENCY_IDS.slice() }));
        } else {
            if (source.command !== undefined && source.command !== null && source.command !== '') {
                if (!isString(source.command))
                    out.push(problem(SEVERITY.ERROR, PROBLEM.COMMAND_TYPE,
                        'The dump command must be a shell command string.'));
                else if (hasNul(source.command))
                    // Everything else is allowed: the command is run through `sh -c`
                    // inside the container, so pipes and redirection are the point.
                    // A NUL simply cannot survive execve.
                    out.push(problem(SEVERITY.ERROR, PROBLEM.COMMAND_NUL,
                        'The dump command contains a NUL byte.'));
            } else if (consistency === 'command') {
                out.push(problem(SEVERITY.ERROR, PROBLEM.NO_COMMAND,
                    'The "Dump command" mode needs a command to run inside the container.',
                    { consistency }));
            }

            // pause/stop have nothing to pause without a container; command has
            // nothing to exec into. Same defect, same code.
            if (consistency !== 'none' && containers.length === 0)
                out.push(problem(SEVERITY.ERROR, PROBLEM.NO_CONTAINERS,
                    'Consistency mode "' + CONSISTENCY[consistency].label +
                    '" needs at least one container to act on.', { consistency }));

            if (consistency === 'none') {
                containers.forEach((name) => {
                    const hint = databaseHint(name);
                    if (!hint) return;
                    out.push(problem(SEVERITY.WARNING, PROBLEM.LIVE_DATABASE,
                        'Container "' + name + '" looks like a database. Copying its files ' +
                        'while it runs can produce a backup that will not restore — use ' +
                        '"Stop containers" or "Dump command" instead.',
                        { container: name, match: hint, consistency }));
                });
            }
        }

        checkPatterns(source, out);
        checkTags(source, out);
        return out;
    }

    // ---- restic arguments --------------------------------------------------

    // A volume's bytes are wherever the runtime says they are, and that is only
    // knowable by asking it — see resolve(). Refusing loudly here is the whole
    // point: guessing a mountpoint would produce a backup of the wrong tree, or
    // of nothing, and restic would report success either way.
    function requireResolved(n) {
        const detail = () => ({
            code: PROBLEM.NOT_RESOLVED, id: n.id, kind: 'container',
            resolvedPaths: n.resolvedPaths.slice()
        });
        // A NUL cannot be in a path the kernel would accept, and execve truncates
        // at one — the argument restic received would not be the one we printed.
        const nul = n.resolvedPaths.filter(hasNul);
        if (nul.length)
            throw fail('Container source "' + (n.id || '?') + '" has a resolved volume path ' +
                'containing a NUL byte.', detail());
        const bad = n.resolvedPaths.filter((p) => p.charAt(0) !== '/');
        // Checked before emptiness so "your path is relative" is not reported as
        // "you forgot to resolve" — they need different fixes.
        if (bad.length)
            throw fail('Container source "' + (n.id || '?') + '" has a resolved volume path ' +
                'that is not absolute: "' + bad[0] + '".', detail());
        if (n.resolvedPaths.length === 0)
            throw fail('Container source "' + (n.id || '?') + '" has no resolved volume paths. ' +
                'Inspect the volumes with resolve() before building restic arguments.',
                {
                    code: PROBLEM.NOT_RESOLVED, id: n.id, kind: 'container',
                    runtime: n.runtime, user: n.user, volumes: n.volumes.slice()
                });
        return n.resolvedPaths.slice();
    }

    function toResticArgs(source) {
        const n = normalize(source);
        const paths = requireResolved(n);
        const args = [];
        n.excludes.forEach((p) => { args.push('--exclude', p); });
        n.tags.forEach((t) => { args.push('--tag', t); });
        // Positionals last, and every one absolute, so none can be mistaken for a
        // flag or swallowed as a flag's value.
        paths.forEach((p) => { args.push(p); });
        return args;
    }

    // ---- consistency commands ----------------------------------------------

    function runtimeCommand(n, rest) {
        return asUser(n.user, [n.runtime].concat(rest));
    }

    function preCommands(source) {
        const n = normalize(source);
        if (n.consistency === 'none' || n.containers.length === 0) return [];
        // Checked for the whole list before building any of it: a vector that is
        // half-safe is worse than none, because the caller would run the safe half.
        n.containers.forEach(requireSafeContainer);
        if (n.consistency === 'pause')
            return n.containers.map((c) => runtimeCommand(n, ['pause', c]));
        if (n.consistency === 'stop')
            return n.containers.map((c) => runtimeCommand(n, ['stop', c]));
        if (n.consistency === 'command') {
            if (n.command === '') return [];
            requireSafeCommand(n.command);
            // `sh -c` because the useful dump commands are pipelines
            // ("pg_dump db | gzip > /backup/db.sql.gz"), and the target directory
            // is expected to be one of the volumes being backed up.
            return n.containers.map((c) => runtimeCommand(n, ['exec', c, 'sh', '-c', n.command]));
        }
        return [];
    }

    // Reverse of pre, deliberately: the author lists containers in shutdown order
    // (app first, its database last), so bringing them back in reverse starts the
    // database before the app that needs it.
    function postCommands(source) {
        const n = normalize(source);
        if (n.consistency === 'none' || n.containers.length === 0) return [];
        n.containers.forEach(requireSafeContainer);
        const reversed = n.containers.slice().reverse();
        if (n.consistency === 'pause')
            return reversed.map((c) => runtimeCommand(n, ['unpause', c]));
        if (n.consistency === 'stop')
            return reversed.map((c) => runtimeCommand(n, ['start', c]));
        // 'command' wrote a dump and changed nothing else — there is nothing to undo.
        return [];
    }

    // ---- describe ----------------------------------------------------------

    function plural(count, word) { return count + ' ' + word + (count === 1 ? '' : 's'); }

    function listPhrase(items) {
        if (items.length === 1) return items[0];
        if (items.length === 2) return items[0] + ' and ' + items[1];
        if (items.length <= 3) return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
        return items.slice(0, 3).join(', ') + ' and ' + (items.length - 3) + ' more';
    }

    function describe(source) {
        const n = normalize(source);
        if (n.volumes.length === 0) return 'Backs up nothing (no volumes selected).';

        let s = 'Backs up ' + plural(n.volumes.length, n.runtime + ' volume');
        if (n.user) s += ' owned by ' + n.user;

        const who = n.containers.length ? listPhrase(n.containers) : 'no containers';
        if (n.consistency === 'pause') s += ', pausing ' + who + ' during the copy';
        else if (n.consistency === 'stop') s += ', stopping ' + who + ' during the copy';
        else if (n.consistency === 'command') s += ', dumping from ' + who + ' first';
        else s += ', copying the files live';

        if (n.tags.length) s += ', tagged ' + n.tags.join(', ');
        return s + '.';
    }

    // ---- impure: the thin layer that actually talks to the runtime ---------

    function hasCockpit(member) {
        return typeof cockpit !== 'undefined' && cockpit && typeof cockpit[member] === 'function';
    }

    // superuser: runuser needs root, and so does reading a rootless store's
    // mountpoint from outside the session.
    function run(argv) {
        try {
            return Promise.resolve(cockpit.spawn(argv, { superuser: 'require', err: 'message' }));
        } catch (e) {
            // cockpit.spawn throws synchronously once the superuser bridge is gone.
            return Promise.reject(e);
        }
    }

    function noHost(what, detail) {
        return fail('Cannot ' + what + ': no Cockpit session on this host.',
            detail === undefined ? null : detail);
    }

    // Which runtime is installed? podman first — it is the default, and on hosts
    // with podman-docker /usr/bin/docker is a shim that calls podman anyway, so
    // answering "docker" there would be a lie about which store is being read.
    function detectRuntime() {
        if (!hasCockpit('spawn')) return Promise.resolve(null);
        return RUNTIMES.reduce((chain, rt) => chain.then((found) => {
            if (found) return found;
            return run([rt, '--version']).then(() => rt, () => null);
        }), Promise.resolve(null));
    }

    function listVolumes(runtime, user) {
        let argv;
        try {
            argv = volumeListArgv(runtime, user);
        } catch (e) {
            return Promise.reject(e);
        }
        if (!hasCockpit('spawn')) return Promise.resolve([]);
        return run(argv).then(parseVolumeNames, (e) => {
            throw fail('Could not list ' + requireRuntime(runtime) + ' volumes' +
                (user ? ' for user ' + user : '') + '.',
                { runtime, user, cause: (e && e.message) || String(e) });
        });
    }

    // Fills in resolvedPaths by asking the runtime where each volume lives.
    // One inspect per volume rather than one batched call: a batch fails whole
    // when a single name is missing, and "which volume is gone" is exactly what
    // the user needs to be told.
    function resolve(source) {
        let n;
        try {
            n = normalize(source);
        } catch (e) {
            return Promise.reject(e);
        }
        if (n.volumes.length === 0)
            return Promise.reject(fail('Container source "' + (n.id || '?') +
                '" lists no volumes to resolve.', { id: n.id, kind: 'container' }));
        if (!hasCockpit('spawn'))
            return Promise.reject(noHost('inspect container volumes', { id: n.id, kind: 'container' }));

        return n.volumes.reduce((chain, name) => chain.then((acc) => {
            const argv = volumeInspectArgv(n.runtime, n.user, name);
            return run(argv).then(
                (text) => {
                    const paths = mountpointsFor(parseVolumeInspect(text), [name]);
                    if (paths.length === 0)
                        throw fail('Volume "' + name + '" has no mount point in ' +
                            n.runtime + '\'s inspect output.',
                            { volume: name, runtime: n.runtime, user: n.user });
                    return acc.concat(paths);
                },
                (e) => {
                    if (Errors.isHangarError(e)) throw e;
                    throw fail('Could not inspect ' + n.runtime + ' volume "' + name + '"' +
                        (n.user ? ' as user ' + n.user : '') + '. Rootless volumes belong to ' +
                        'the user who created them, so check that the source records the right owner.',
                        { volume: name, runtime: n.runtime, user: n.user, cause: (e && e.message) || String(e) });
                }
            );
        }), Promise.resolve([])).then((paths) => Object.assign({}, n, {
            resolvedPaths: dedupe(paths).sort(byCodeUnit)
        }));
    }

    // ---- registration ------------------------------------------------------

    // Idempotent: registerKind throws on a duplicate, and index.html loading this
    // file twice must not take the whole page down.
    function register(target) {
        const S = target || Sources;
        if (!S || typeof S.registerKind !== 'function') return null;
        if (S.KINDS && S.KINDS.container) return S.KINDS.container;
        return S.registerKind('container', { validate, normalize, toResticArgs, describe });
    }

    register();

    const HangarSourcesContainer = {
        RUNTIMES, DEFAULT_RUNTIME, RISK,
        CONSISTENCY, CONSISTENCY_IDS, DEFAULT_CONSISTENCY,
        DATABASE_HINTS, PROBLEM, SEVERITY,
        isSafeName, looksLikeDatabase, databaseHint,
        asUser, volumeListArgv, volumeInspectArgv, containerListArgv,
        parseVolumeNames, parseVolumeInspect, mountpointsFor,
        normalize, validate, toResticArgs, preCommands, postCommands, describe,
        detectRuntime, listVolumes, resolve, register
    };
    root.HangarSourcesContainer = HangarSourcesContainer;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarSourcesContainer;
})(typeof window !== 'undefined' ? window : globalThis);
