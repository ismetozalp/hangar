// core/sources.js — what gets backed up, and the seam that keeps VM/Podman
// sources out of the engine.
//
// Everything here is pure: no cockpit, no filesystem access. A source is data;
// KINDS is a lookup table of behaviour keyed by `kind`. Adding a source kind in
// v2 (libvirt domains, podman volumes) is a `registerKind()` call plus three
// functions — the engine keeps calling toResticArgs()/validate()/describe()
// against the table and never learns a second vocabulary.
'use strict';
(function (root) {
    // Dual-load: require() under node --test, the already-loaded global in the browser.
    const Errors = (typeof module !== 'undefined' && module.exports && typeof require === 'function')
        ? require('./errors.js')
        : root.HangarErrors;

    const SEVERITY = { ERROR: 'error', WARNING: 'warning' };

    // Stable machine-readable problem codes. The UI keys remediation off these,
    // so they are constants rather than the (translatable) message text.
    const PROBLEM = {
        BAD_SOURCE: 'bad-source',
        UNKNOWN_KIND: 'unknown-kind',
        BAD_ID: 'bad-id',
        NO_PATHS: 'no-paths',
        PATH_TYPE: 'path-type',
        PATH_EMPTY: 'path-empty',
        PATH_NOT_ABSOLUTE: 'path-not-absolute',
        PATH_TRAVERSAL: 'path-traversal',
        PATH_NUL: 'path-nul',
        PATH_DUPLICATE: 'path-duplicate',
        PATH_REDUNDANT: 'path-redundant',
        PATTERN_TYPE: 'pattern-type',
        PATTERN_EMPTY: 'pattern-empty',
        PATTERN_NUL: 'pattern-nul',
        EXCLUDE_FILE_NUL: 'exclude-file-nul',
        EXCLUDE_FILE_RELATIVE: 'exclude-file-relative',
        TAG_TYPE: 'tag-type',
        TAG_EMPTY: 'tag-empty',
        TAG_COMMA: 'tag-comma',
        TAG_NUL: 'tag-nul',
        HOOK_TYPE: 'hook-type',
        HOOK_NUL: 'hook-nul'
    };

    const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

    function problem(severity, code, message, extra) {
        const p = { severity, code, message };
        if (extra) Object.keys(extra).forEach((k) => { p[k] = extra[k]; });
        return p;
    }

    function isString(v) { return typeof v === 'string'; }

    // `kind` is untrusted config, and quoting it into a message must never be the
    // thing that fails: implicit concat of a Symbol — or of an object with no
    // prototype — throws a raw TypeError before the HangarError can be built.
    function kindLabel(k) {
        try { return String(k); } catch (e) { return typeof k; }
    }

    function hasNul(s) { return s.indexOf('\u0000') >= 0; }

    // Code-unit order, never localeCompare: golden arg vectors must not shift
    // when the browser's collation locale changes.
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

    // Collapse slash runs and strip the trailing slash so that "/srv/", "/srv"
    // and "/srv//" are one path — otherwise duplicate and parent detection both
    // miss, and restic would store the same tree twice.
    function canonicalPath(p) {
        if (!isString(p) || p === '') return '';
        const collapsed = p.replace(/\/{2,}/g, '/');
        return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
    }

    function hasTraversal(p) {
        return p.split('/').some((seg) => seg === '.' || seg === '..');
    }

    // Sorted input guarantees an ancestor is seen before its descendants.
    function isAncestor(a, b) {
        return b.startsWith(a === '/' ? '/' : a + '/');
    }

    // Null guard: hasErrors()/toError() are public and take a caller-supplied
    // list, which for a third-party kind may hold holes.
    function isError(p) { return !!p && p.severity === SEVERITY.ERROR; }
    function hasErrors(problems) { return toArray(problems).some(isError); }

    function toError(problems, message) {
        const list = toArray(problems);
        const first = list.filter(isError)[0] || list[0];
        return Errors.create(
            Errors.KIND.GENERIC,
            message || (first ? first.message : 'Invalid backup source.'),
            { problems: list }
        );
    }

    // ---- filesystem kind ---------------------------------------------------

    function validateFilesystem(source) {
        const out = [];

        if (!isString(source.id) || !ID_RE.test(source.id))
            out.push(problem(SEVERITY.ERROR, PROBLEM.BAD_ID,
                'A source needs an id of letters, digits, dot, dash or underscore.'));

        if (!Array.isArray(source.paths) || source.paths.length === 0) {
            out.push(problem(SEVERITY.ERROR, PROBLEM.NO_PATHS,
                'A filesystem source must list at least one path.'));
        } else {
            const canon = [];
            const seen = new Set();
            source.paths.forEach((p, index) => {
                if (!isString(p)) {
                    out.push(problem(SEVERITY.ERROR, PROBLEM.PATH_TYPE,
                        'Path entries must be strings.', { index }));
                    return;
                }
                if (hasNul(p)) {
                    out.push(problem(SEVERITY.ERROR, PROBLEM.PATH_NUL,
                        'A path contains a NUL byte.', { index }));
                    return;
                }
                if (p === '') {
                    out.push(problem(SEVERITY.ERROR, PROBLEM.PATH_EMPTY,
                        'A path is empty.', { index }));
                    return;
                }
                if (p.charAt(0) !== '/') {
                    out.push(problem(SEVERITY.ERROR, PROBLEM.PATH_NOT_ABSOLUTE,
                        'Path "' + p + '" is not absolute.', { index, path: p }));
                    return;
                }
                const c = canonicalPath(p);
                if (hasTraversal(c)) {
                    out.push(problem(SEVERITY.ERROR, PROBLEM.PATH_TRAVERSAL,
                        'Path "' + p + '" contains "." or ".." components.', { index, path: p }));
                    return;
                }
                if (seen.has(c)) {
                    out.push(problem(SEVERITY.ERROR, PROBLEM.PATH_DUPLICATE,
                        'Path "' + p + '" is listed more than once.', { index, path: p, canonical: c }));
                    return;
                }
                seen.add(c);
                canon.push(c);
            });

            // Redundant, not wrong: restic would back the child up once anyway,
            // so this is a warning the user can dismiss.
            canon.slice().sort(byCodeUnit).forEach((child, i, sorted) => {
                for (let j = 0; j < i; j++) {
                    if (isAncestor(sorted[j], child)) {
                        out.push(problem(SEVERITY.WARNING, PROBLEM.PATH_REDUNDANT,
                            'Path "' + child + '" is already covered by "' + sorted[j] + '".',
                            { path: child, coveredBy: sorted[j] }));
                        return;
                    }
                }
            });
        }

        ['excludes', 'iexcludes'].forEach((field) => {
            const v = source[field];
            if (v === undefined || v === null) return;
            if (!Array.isArray(v)) {
                out.push(problem(SEVERITY.ERROR, PROBLEM.PATTERN_TYPE,
                    'Field "' + field + '" must be an array of patterns.', { field }));
                return;
            }
            v.forEach((pat, index) => {
                if (!isString(pat))
                    out.push(problem(SEVERITY.ERROR, PROBLEM.PATTERN_TYPE,
                        'Exclude patterns must be strings.', { field, index }));
                else if (hasNul(pat))
                    out.push(problem(SEVERITY.ERROR, PROBLEM.PATTERN_NUL,
                        'An exclude pattern contains a NUL byte.', { field, index }));
                else if (pat === '')
                    out.push(problem(SEVERITY.ERROR, PROBLEM.PATTERN_EMPTY,
                        'An exclude pattern is empty.', { field, index }));
            });
        });

        toArray(source.excludeFile).forEach((f, index) => {
            if (!isString(f)) {
                out.push(problem(SEVERITY.ERROR, PROBLEM.PATTERN_TYPE,
                    'excludeFile must be a path or a list of paths.', { index }));
                return;
            }
            if (hasNul(f)) {
                out.push(problem(SEVERITY.ERROR, PROBLEM.EXCLUDE_FILE_NUL,
                    'An exclude file path contains a NUL byte.', { index }));
                return;
            }
            if (f === '') {
                out.push(problem(SEVERITY.ERROR, PROBLEM.PATTERN_EMPTY,
                    'An exclude file path is empty.', { index }));
                return;
            }
            // restic resolves it against its own cwd, which is the unit's cwd —
            // relative here means "wherever systemd happened to start us".
            if (f.charAt(0) !== '/')
                out.push(problem(SEVERITY.WARNING, PROBLEM.EXCLUDE_FILE_RELATIVE,
                    'Exclude file "' + f + '" is relative and will be resolved at run time.',
                    { index, path: f }));
        });

        if (source.tags !== undefined && source.tags !== null) {
            if (!Array.isArray(source.tags)) {
                out.push(problem(SEVERITY.ERROR, PROBLEM.TAG_TYPE, 'Field "tags" must be an array.'));
            } else {
                source.tags.forEach((t, index) => {
                    if (!isString(t))
                        out.push(problem(SEVERITY.ERROR, PROBLEM.TAG_TYPE,
                            'Tags must be strings.', { index }));
                    else if (hasNul(t))
                        out.push(problem(SEVERITY.ERROR, PROBLEM.TAG_NUL,
                            'A tag contains a NUL byte.', { index }));
                    else if (t === '')
                        out.push(problem(SEVERITY.ERROR, PROBLEM.TAG_EMPTY, 'A tag is empty.', { index }));
                    else if (t.indexOf(',') >= 0)
                        // restic splits --tag on commas, so one tag would silently become two.
                        out.push(problem(SEVERITY.ERROR, PROBLEM.TAG_COMMA,
                            'Tag "' + t + '" contains a comma.', { index, tag: t }));
                });
            }
        }

        // Hooks are shell by design — `;`, `|`, `$()` and friends are the point,
        // not an injection. Only a NUL byte is rejected: it cannot survive execve.
        ['preHook', 'postHook'].forEach((field) => {
            const v = source[field];
            if (v === undefined || v === null || v === '') return;
            if (!isString(v))
                out.push(problem(SEVERITY.ERROR, PROBLEM.HOOK_TYPE,
                    'Hook "' + field + '" must be a shell command string.', { field }));
            else if (hasNul(v))
                out.push(problem(SEVERITY.ERROR, PROBLEM.HOOK_NUL,
                    'Hook "' + field + '" contains a NUL byte.', { field }));
        });

        return out;
    }

    function normalizeFilesystem(source) {
        const s = (source && typeof source === 'object') ? source : {};
        const paths = dedupe(toArray(s.paths).filter(isString).map(canonicalPath).filter((p) => p !== ''))
            .sort(byCodeUnit);
        return {
            id: isString(s.id) ? s.id : '',
            kind: 'filesystem',
            paths,
            // Pattern order is preserved (not sorted): restic exclude semantics
            // give later entries meaning, and de-dup alone is already stable.
            excludes: dedupe(toArray(s.excludes).filter(isString)),
            iexcludes: dedupe(toArray(s.iexcludes).filter(isString)),
            excludeFile: dedupe(toArray(s.excludeFile).filter(isString).map(canonicalPath)
                .filter((p) => p !== '')),
            oneFileSystem: !!s.oneFileSystem,
            tags: dedupe(toArray(s.tags).filter(isString).filter((t) => t !== '')),
            preHook: isString(s.preHook) ? s.preHook : '',
            postHook: isString(s.postHook) ? s.postHook : ''
        };
    }

    function filesystemToResticArgs(source) {
        const n = normalizeFilesystem(source);
        const args = [];
        n.excludes.forEach((p) => { args.push('--exclude', p); });
        n.iexcludes.forEach((p) => { args.push('--iexclude', p); });
        n.excludeFile.forEach((f) => { args.push('--exclude-file', f); });
        if (n.oneFileSystem) args.push('--one-file-system');
        n.tags.forEach((t) => { args.push('--tag', t); });
        // Positionals last. Every path is absolute by validation, so none can be
        // mistaken for a flag or swallowed as a flag's value.
        n.paths.forEach((p) => { args.push(p); });
        return args;
    }

    function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

    function listPhrase(items) {
        if (items.length === 1) return items[0];
        if (items.length === 2) return items[0] + ' and ' + items[1];
        if (items.length <= 3) return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
        return items.slice(0, 3).join(', ') + ' and ' + (items.length - 3) + ' more';
    }

    function describeFilesystem(source) {
        const n = normalizeFilesystem(source);
        if (n.paths.length === 0) return 'Backs up nothing (no paths configured).';

        const clauses = [];
        const patterns = n.excludes.length + n.iexcludes.length;
        if (patterns > 0) clauses.push('excluding ' + plural(patterns, 'pattern'));
        if (n.excludeFile.length > 0) clauses.push('using ' + plural(n.excludeFile.length, 'exclude file'));
        if (n.oneFileSystem) clauses.push('staying on one filesystem');
        if (n.tags.length > 0) clauses.push('tagged ' + n.tags.join(', '));
        if (n.preHook && n.postHook) clauses.push('running pre- and post-backup hooks');
        else if (n.preHook) clauses.push('running a pre-backup hook');
        else if (n.postHook) clauses.push('running a post-backup hook');

        return 'Backs up ' + listPhrase(n.paths) + (clauses.length ? ', ' + clauses.join(', ') : '') + '.';
    }

    // ---- kind registry -----------------------------------------------------

    // Null prototype on purpose: `kind` is untrusted config. A plain object would
    // answer KINDS['constructor'] / KINDS['__proto__'] with something truthy from
    // Object.prototype, and the caller would get a raw TypeError instead of the
    // HangarError that says "unknown source kind".
    const KINDS = Object.create(null);
    KINDS.filesystem = {
        validate: validateFilesystem,
        normalize: normalizeFilesystem,
        toResticArgs: filesystemToResticArgs,
        describe: describeFilesystem
    };

    function registerKind(kind, impl) {
        if (!isString(kind) || kind === '')
            throw Errors.create(Errors.KIND.GENERIC, 'A source kind needs a name.', { kind });
        if (KINDS[kind])
            throw Errors.create(Errors.KIND.GENERIC, 'Source kind "' + kind + '" is already registered.', { kind });
        if (!impl || ['validate', 'toResticArgs', 'describe'].some((f) => typeof impl[f] !== 'function'))
            throw Errors.create(Errors.KIND.GENERIC,
                'Source kind "' + kind + '" must provide validate, toResticArgs and describe.', { kind });
        KINDS[kind] = {
            validate: impl.validate,
            // Normalisation is optional: a kind whose config is already canonical
            // (a VM's UUID, say) has nothing to fold.
            normalize: typeof impl.normalize === 'function'
                ? impl.normalize
                : (s) => Object.assign({}, s),
            toResticArgs: impl.toResticArgs,
            describe: impl.describe
        };
        return KINDS[kind];
    }

    function kinds() { return Object.keys(KINDS).sort(byCodeUnit); }

    function implFor(source) {
        if (!source || typeof source !== 'object' || Array.isArray(source))
            throw Errors.create(Errors.KIND.GENERIC, 'A backup source must be an object.', { source });
        const impl = isString(source.kind) ? KINDS[source.kind] : null;
        if (!impl)
            throw Errors.create(Errors.KIND.GENERIC,
                'Unknown source kind "' + kindLabel(source.kind) + '".',
                { kind: source.kind, known: kinds() });
        return impl;
    }

    // ---- public API --------------------------------------------------------

    function validate(source) {
        if (!source || typeof source !== 'object' || Array.isArray(source))
            return [problem(SEVERITY.ERROR, PROBLEM.BAD_SOURCE, 'A backup source must be an object.')];
        if (!isString(source.kind) || !KINDS[source.kind])
            return [problem(SEVERITY.ERROR, PROBLEM.UNKNOWN_KIND,
                'Unknown source kind "' + kindLabel(source.kind) + '".', { kind: source.kind })];
        return KINDS[source.kind].validate(source);
    }

    function isValid(source) { return !hasErrors(validate(source)); }

    function normalize(source) { return implFor(source).normalize(source); }

    function toResticArgs(source) {
        const impl = implFor(source);
        // toArray: a registered kind may hand back a single problem instead of a
        // list, and a malformed report must still surface as a HangarError.
        const problems = toArray(validate(source));
        if (hasErrors(problems)) throw toError(problems, 'Cannot build restic arguments: ' +
            problems.filter(isError)[0].message);
        return impl.toResticArgs(source);
    }

    function describe(source) { return implFor(source).describe(source); }

    const HangarSources = {
        KINDS, SEVERITY, PROBLEM,
        registerKind, kinds,
        validate, isValid, hasErrors, toError,
        normalize, toResticArgs, describe,
        canonicalPath
    };
    root.HangarSources = HangarSources;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarSources;
})(typeof window !== 'undefined' ? window : globalThis);
