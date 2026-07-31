// tests/unit/sources.test.js — HangarSources: validation, normalisation,
// restic argument construction and the kind registry.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Sources = require('../../js/core/sources.js');
const Errors = require('../../js/core/errors.js');

const NUL = '\u0000';

function fsSource(over) {
    return Object.assign({ id: 'sys', kind: 'filesystem', paths: ['/etc'] }, over || {});
}

function codes(problems) { return problems.map((p) => p.code); }
function errorCodes(problems) { return codes(problems.filter((p) => p.severity === 'error')); }
function warningCodes(problems) { return codes(problems.filter((p) => p.severity === 'warning')); }

// ---- canonicalPath ---------------------------------------------------------

test('canonicalPath strips a trailing slash', () => {
    assert.equal(Sources.canonicalPath('/srv/'), '/srv');
});

test('canonicalPath strips repeated trailing slashes', () => {
    assert.equal(Sources.canonicalPath('/srv///'), '/srv');
});

test('canonicalPath collapses interior slash runs', () => {
    assert.equal(Sources.canonicalPath('/srv//data///x'), '/srv/data/x');
});

test('canonicalPath leaves the root path alone', () => {
    assert.equal(Sources.canonicalPath('/'), '/');
    assert.equal(Sources.canonicalPath('///'), '/');
});

test('canonicalPath returns empty string for non-strings and empties', () => {
    assert.equal(Sources.canonicalPath(''), '');
    assert.equal(Sources.canonicalPath(null), '');
    assert.equal(Sources.canonicalPath(42), '');
});

// ---- normalize -------------------------------------------------------------

test('normalize sorts and de-duplicates paths', () => {
    const n = Sources.normalize(fsSource({ paths: ['/srv', '/etc', '/srv', '/home'] }));
    assert.deepEqual(n.paths, ['/etc', '/home', '/srv']);
});

test('normalize folds trailing-slash variants into one path', () => {
    const n = Sources.normalize(fsSource({ paths: ['/srv/', '/srv', '/srv//'] }));
    assert.deepEqual(n.paths, ['/srv']);
});

test('normalize sorts by code unit, not by locale collation', () => {
    const n = Sources.normalize(fsSource({ paths: ['/srv/日本', '/srv/über', '/srv/zebra'] }));
    assert.deepEqual(n.paths, ['/srv/zebra', '/srv/über', '/srv/日本']);
});

test('normalize preserves spaces and unicode inside paths', () => {
    const n = Sources.normalize(fsSource({ paths: ['/srv/my documents/', '/srv/Ünïcøde 📦'] }));
    assert.deepEqual(n.paths, ['/srv/my documents', '/srv/Ünïcøde 📦']);
});

test('normalize fills in every field for a bare source', () => {
    assert.deepEqual(Sources.normalize({ id: 'sys', kind: 'filesystem', paths: ['/etc'] }), {
        id: 'sys',
        kind: 'filesystem',
        paths: ['/etc'],
        excludes: [],
        iexcludes: [],
        excludeFile: [],
        oneFileSystem: false,
        tags: [],
        preHook: '',
        postHook: ''
    });
});

test('normalize wraps a single excludeFile string into a list', () => {
    const n = Sources.normalize(fsSource({ excludeFile: '/etc/hangar/excl.txt' }));
    assert.deepEqual(n.excludeFile, ['/etc/hangar/excl.txt']);
});

test('normalize de-duplicates patterns but keeps author order', () => {
    const n = Sources.normalize(fsSource({ excludes: ['*.tmp', '/var/cache', '*.tmp', '*.iso'] }));
    assert.deepEqual(n.excludes, ['*.tmp', '/var/cache', '*.iso']);
});

test('normalize coerces oneFileSystem to a boolean', () => {
    assert.equal(Sources.normalize(fsSource({ oneFileSystem: 1 })).oneFileSystem, true);
    assert.equal(Sources.normalize(fsSource({ oneFileSystem: undefined })).oneFileSystem, false);
});

test('normalize drops non-string path entries rather than emitting junk args', () => {
    const n = Sources.normalize(fsSource({ paths: ['/etc', null, 7, '/srv'] }));
    assert.deepEqual(n.paths, ['/etc', '/srv']);
});

test('normalize is idempotent', () => {
    const once = Sources.normalize(fsSource({
        paths: ['/srv/', '/etc'], excludes: ['*.tmp'], tags: ['daily'], oneFileSystem: true
    }));
    assert.deepEqual(Sources.normalize(once), once);
});

test('normalize does not mutate its input', () => {
    const src = fsSource({ paths: ['/srv/', '/etc'], excludes: ['*.tmp', '*.tmp'] });
    const copy = JSON.parse(JSON.stringify(src));
    Sources.normalize(src);
    assert.deepEqual(src, copy);
});

// ---- validate: shape and kind ---------------------------------------------

test('validate accepts a minimal filesystem source', () => {
    assert.deepEqual(Sources.validate(fsSource()), []);
});

test('validate rejects a non-object source', () => {
    assert.deepEqual(errorCodes(Sources.validate(null)), [Sources.PROBLEM.BAD_SOURCE]);
    assert.deepEqual(errorCodes(Sources.validate('/etc')), [Sources.PROBLEM.BAD_SOURCE]);
    assert.deepEqual(errorCodes(Sources.validate(['/etc'])), [Sources.PROBLEM.BAD_SOURCE]);
});

test('validate rejects an unregistered kind', () => {
    const problems = Sources.validate({ id: 'vm1', kind: 'libvirt', paths: ['/etc'] });
    assert.deepEqual(errorCodes(problems), [Sources.PROBLEM.UNKNOWN_KIND]);
    assert.equal(problems[0].kind, 'libvirt');
});

test('validate rejects a missing or malformed id', () => {
    assert.ok(errorCodes(Sources.validate(fsSource({ id: undefined }))).includes(Sources.PROBLEM.BAD_ID));
    assert.ok(errorCodes(Sources.validate(fsSource({ id: 'has space' }))).includes(Sources.PROBLEM.BAD_ID));
    assert.ok(errorCodes(Sources.validate(fsSource({ id: '../escape' }))).includes(Sources.PROBLEM.BAD_ID));
});

// ---- validate: paths -------------------------------------------------------

test('validate rejects a missing paths array', () => {
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ paths: undefined }))), [Sources.PROBLEM.NO_PATHS]);
});

test('validate rejects an empty paths array', () => {
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ paths: [] }))), [Sources.PROBLEM.NO_PATHS]);
});

test('validate rejects a relative path', () => {
    const problems = Sources.validate(fsSource({ paths: ['etc/hangar'] }));
    assert.deepEqual(errorCodes(problems), [Sources.PROBLEM.PATH_NOT_ABSOLUTE]);
    assert.equal(problems[0].index, 0);
});

test('validate rejects a tilde path, which the shell would have expanded but we do not', () => {
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ paths: ['~/Documents'] }))),
        [Sources.PROBLEM.PATH_NOT_ABSOLUTE]);
});

test('validate rejects an empty path string', () => {
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ paths: [''] }))), [Sources.PROBLEM.PATH_EMPTY]);
});

test('validate rejects non-string path entries', () => {
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ paths: [123] }))), [Sources.PROBLEM.PATH_TYPE]);
});

test('validate rejects a NUL byte in a path', () => {
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ paths: ['/etc' + NUL + 'passwd'] }))),
        [Sources.PROBLEM.PATH_NUL]);
});

test('validate rejects path traversal components', () => {
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ paths: ['/srv/../etc'] }))),
        [Sources.PROBLEM.PATH_TRAVERSAL]);
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ paths: ['/srv/./data'] }))),
        [Sources.PROBLEM.PATH_TRAVERSAL]);
});

test('validate rejects duplicate paths', () => {
    const problems = Sources.validate(fsSource({ paths: ['/srv', '/srv'] }));
    assert.deepEqual(errorCodes(problems), [Sources.PROBLEM.PATH_DUPLICATE]);
    assert.equal(problems[0].index, 1);
});

test('validate treats trailing-slash variants as duplicates', () => {
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ paths: ['/srv', '/srv/'] }))),
        [Sources.PROBLEM.PATH_DUPLICATE]);
});

test('validate warns, but does not fail, on a path covered by a listed parent', () => {
    const problems = Sources.validate(fsSource({ paths: ['/home', '/home/appuser/docs'] }));
    assert.deepEqual(errorCodes(problems), []);
    assert.deepEqual(warningCodes(problems), [Sources.PROBLEM.PATH_REDUNDANT]);
    assert.equal(problems[0].path, '/home/appuser/docs');
    assert.equal(problems[0].coveredBy, '/home');
    assert.equal(Sources.isValid(fsSource({ paths: ['/home', '/home/appuser/docs'] })), true);
});

test('validate reports redundancy regardless of the order paths were entered', () => {
    const problems = Sources.validate(fsSource({ paths: ['/home/appuser/docs', '/home'] }));
    assert.deepEqual(warningCodes(problems), [Sources.PROBLEM.PATH_REDUNDANT]);
    assert.equal(problems[0].coveredBy, '/home');
});

test('validate treats root as the parent of everything, without a doubled slash', () => {
    const problems = Sources.validate(fsSource({ paths: ['/', '/home'] }));
    assert.deepEqual(warningCodes(problems), [Sources.PROBLEM.PATH_REDUNDANT]);
    assert.equal(problems[0].coveredBy, '/');
});

test('validate does not call a name-prefix sibling redundant', () => {
    // "/srv/app" is not a parent of "/srv/application" — only a string prefix.
    assert.deepEqual(Sources.validate(fsSource({ paths: ['/srv/app', '/srv/application'] })), []);
});

test('validate reports one warning per covered child', () => {
    const problems = Sources.validate(fsSource({ paths: ['/srv', '/srv/a', '/srv/b/c'] }));
    assert.deepEqual(warningCodes(problems),
        [Sources.PROBLEM.PATH_REDUNDANT, Sources.PROBLEM.PATH_REDUNDANT]);
});

// ---- validate: excludes, tags, hooks ---------------------------------------

test('validate rejects a non-array excludes field', () => {
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ excludes: '*.tmp' }))),
        [Sources.PROBLEM.PATTERN_TYPE]);
});

test('validate rejects empty, non-string and NUL-bearing exclude patterns', () => {
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ excludes: ['', 3, 'a' + NUL] }))),
        [Sources.PROBLEM.PATTERN_EMPTY, Sources.PROBLEM.PATTERN_TYPE, Sources.PROBLEM.PATTERN_NUL]);
});

test('validate checks iexcludes with the same rules as excludes', () => {
    const problems = Sources.validate(fsSource({ iexcludes: [''] }));
    assert.deepEqual(errorCodes(problems), [Sources.PROBLEM.PATTERN_EMPTY]);
    assert.equal(problems[0].field, 'iexcludes');
});

test('validate accepts glob metacharacters in exclude patterns', () => {
    assert.deepEqual(Sources.validate(fsSource({ excludes: ['**/node_modules', '*.iso', '/var/cache/*'] })), []);
});

test('validate warns on a relative exclude file but accepts an absolute one', () => {
    assert.deepEqual(warningCodes(Sources.validate(fsSource({ excludeFile: 'excl.txt' }))),
        [Sources.PROBLEM.EXCLUDE_FILE_RELATIVE]);
    assert.deepEqual(Sources.validate(fsSource({ excludeFile: '/etc/hangar/excl.txt' })), []);
});

test('validate rejects a NUL byte in an exclude file path', () => {
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ excludeFile: ['/etc/x' + NUL] }))),
        [Sources.PROBLEM.EXCLUDE_FILE_NUL]);
});

test('validate rejects a tag containing a comma, which restic would split in two', () => {
    const problems = Sources.validate(fsSource({ tags: ['daily,weekly'] }));
    assert.deepEqual(errorCodes(problems), [Sources.PROBLEM.TAG_COMMA]);
    assert.equal(problems[0].tag, 'daily,weekly');
});

test('validate rejects empty, non-string, NUL-bearing tags and a non-array tags field', () => {
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ tags: ['', 1, 'x' + NUL] }))),
        [Sources.PROBLEM.TAG_EMPTY, Sources.PROBLEM.TAG_TYPE, Sources.PROBLEM.TAG_NUL]);
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ tags: 'daily' }))), [Sources.PROBLEM.TAG_TYPE]);
});

test('validate accepts unicode and spaces in tags', () => {
    assert.deepEqual(Sources.validate(fsSource({ tags: ['nightly run', 'yedek-günlük'] })), []);
});

test('validate accepts shell metacharacters in hooks — hooks are shell on purpose', () => {
    const hostile = 'systemctl stop app && mysqldump db | gzip > /var/tmp/db.gz; echo $?';
    assert.deepEqual(Sources.validate(fsSource({ preHook: hostile, postHook: '`true`' })), []);
});

test('validate rejects a NUL byte in a hook', () => {
    const problems = Sources.validate(fsSource({ postHook: 'echo hi' + NUL }));
    assert.deepEqual(errorCodes(problems), [Sources.PROBLEM.HOOK_NUL]);
    assert.equal(problems[0].field, 'postHook');
});

test('validate rejects a non-string hook', () => {
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ preHook: ['echo', 'hi'] }))),
        [Sources.PROBLEM.HOOK_TYPE]);
});

test('isValid and hasErrors agree about warnings not being failures', () => {
    const warned = Sources.validate(fsSource({ excludeFile: 'excl.txt' }));
    assert.equal(Sources.hasErrors(warned), false);
    assert.equal(Sources.isValid(fsSource({ excludeFile: 'excl.txt' })), true);
    assert.equal(Sources.isValid(fsSource({ paths: [] })), false);
});

// ---- toResticArgs ----------------------------------------------------------

test('toResticArgs emits the full flag vector in the documented order', () => {
    const src = fsSource({
        paths: ['/srv/', '/etc'],
        excludes: ['*.tmp', '/var/cache'],
        iexcludes: ['*.LOG'],
        excludeFile: '/etc/hangar/excl.txt',
        oneFileSystem: true,
        tags: ['daily', 'system']
    });
    assert.deepEqual(Sources.toResticArgs(src), [
        '--exclude', '*.tmp',
        '--exclude', '/var/cache',
        '--iexclude', '*.LOG',
        '--exclude-file', '/etc/hangar/excl.txt',
        '--one-file-system',
        '--tag', 'daily',
        '--tag', 'system',
        '/etc', '/srv'
    ]);
});

test('toResticArgs on a minimal source is just the paths', () => {
    assert.deepEqual(Sources.toResticArgs(fsSource({ paths: ['/srv', '/etc'] })), ['/etc', '/srv']);
});

test('toResticArgs omits --one-file-system when it is off', () => {
    assert.equal(Sources.toResticArgs(fsSource({ oneFileSystem: false })).includes('--one-file-system'), false);
});

test('toResticArgs gives every tag its own --tag flag', () => {
    assert.deepEqual(Sources.toResticArgs(fsSource({ tags: ['a', 'b', 'c'] })),
        ['--tag', 'a', '--tag', 'b', '--tag', 'c', '/etc']);
});

test('toResticArgs is stable under input shuffling', () => {
    const base = {
        excludes: ['*.tmp', '*.iso'], tags: ['daily'], oneFileSystem: true,
        excludeFile: ['/etc/a.txt', '/etc/b.txt']
    };
    const a = Sources.toResticArgs(fsSource(Object.assign({ paths: ['/etc', '/srv', '/home'] }, base)));
    const b = Sources.toResticArgs(fsSource(Object.assign({ paths: ['/home', '/etc', '/srv/'] }, base)));
    const c = Sources.toResticArgs(fsSource(Object.assign({ paths: ['/srv/', '/home//', '/etc'] }, base)));
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
});

test('toResticArgs passes spaces and unicode through unquoted — argv, not a shell line', () => {
    const args = Sources.toResticArgs(fsSource({
        paths: ['/srv/my documents', '/srv/yedek günlüğü'],
        excludes: ['*.büyük dosya']
    }));
    assert.deepEqual(args, ['--exclude', '*.büyük dosya', '/srv/my documents', '/srv/yedek günlüğü']);
});

test('toResticArgs puts every path after every flag', () => {
    const args = Sources.toResticArgs(fsSource({ paths: ['/etc', '/srv'], excludes: ['*.tmp'], tags: ['t'] }));
    const firstPath = args.indexOf('/etc');
    const lastFlagValue = args.lastIndexOf('t');
    assert.ok(firstPath > lastFlagValue);
    assert.deepEqual(args.slice(firstPath), ['/etc', '/srv']);
});

test('toResticArgs throws a HangarError for an invalid source', () => {
    assert.throws(() => Sources.toResticArgs(fsSource({ paths: ['relative/path'] })), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.equal(e.kind, Errors.KIND.GENERIC);
        assert.equal(e.detail.problems.length, 1);
        assert.equal(e.detail.problems[0].code, Sources.PROBLEM.PATH_NOT_ABSOLUTE);
        return true;
    });
});

test('toResticArgs still builds args when the only problems are warnings', () => {
    assert.deepEqual(Sources.toResticArgs(fsSource({ paths: ['/home', '/home/appuser'] })),
        ['/home', '/home/appuser']);
});

test('toResticArgs throws a HangarError for an unknown kind', () => {
    assert.throws(() => Sources.toResticArgs({ id: 'v', kind: 'podman', paths: ['/etc'] }), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.equal(e.kind, Errors.KIND.GENERIC);
        return true;
    });
});

// ---- describe --------------------------------------------------------------

test('describe renders one path', () => {
    assert.equal(Sources.describe(fsSource({ paths: ['/etc'] })), 'Backs up /etc.');
});

test('describe joins two paths with "and"', () => {
    assert.equal(Sources.describe(fsSource({ paths: ['/srv', '/etc'] })), 'Backs up /etc and /srv.');
});

test('describe truncates beyond three paths', () => {
    assert.equal(Sources.describe(fsSource({ paths: ['/a', '/b', '/c', '/d', '/e'] })),
        'Backs up /a, /b, /c and 2 more.');
});

test('describe renders every clause in a fixed order', () => {
    assert.equal(Sources.describe(fsSource({
        paths: ['/srv/', '/etc'],
        excludes: ['*.tmp', '/var/cache'],
        iexcludes: ['*.LOG'],
        excludeFile: '/etc/hangar/excl.txt',
        oneFileSystem: true,
        tags: ['daily', 'system']
    })), 'Backs up /etc and /srv, excluding 3 patterns, using 1 exclude file, ' +
         'staying on one filesystem, tagged daily, system.');
});

test('describe singularises a lone exclude pattern', () => {
    assert.equal(Sources.describe(fsSource({ excludes: ['*.tmp'] })), 'Backs up /etc, excluding 1 pattern.');
});

test('describe names the hooks that are configured', () => {
    assert.equal(Sources.describe(fsSource({ preHook: 'virsh suspend vm' })),
        'Backs up /etc, running a pre-backup hook.');
    assert.equal(Sources.describe(fsSource({ postHook: 'virsh resume vm' })),
        'Backs up /etc, running a post-backup hook.');
    assert.equal(Sources.describe(fsSource({ preHook: 'a', postHook: 'b' })),
        'Backs up /etc, running pre- and post-backup hooks.');
});

test('describe says so when nothing is configured', () => {
    assert.equal(Sources.describe(fsSource({ paths: [] })), 'Backs up nothing (no paths configured).');
});

test('describe throws a HangarError for an unknown kind', () => {
    assert.throws(() => Sources.describe({ id: 'x', kind: 'nope' }), Errors.isHangarError);
    assert.throws(() => Sources.normalize({ id: 'x', kind: 'nope' }), Errors.isHangarError);
    assert.throws(() => Sources.normalize(null), Errors.isHangarError);
});

// ---- kind registry (the v2 extension seam) ---------------------------------

test('kinds() lists filesystem as the only v1 kind', () => {
    assert.ok(Sources.kinds().includes('filesystem'));
    assert.equal(typeof Sources.KINDS.filesystem.toResticArgs, 'function');
});

test('registerKind makes a new kind work through the shared entry points', () => {
    Sources.registerKind('test-vm', {
        validate: (s) => (s.domain ? [] : [{ severity: 'error', code: 'no-domain', message: 'need a domain' }]),
        toResticArgs: (s) => ['--tag', 'vm:' + s.domain, '/var/lib/libvirt/images/' + s.domain + '.qcow2'],
        describe: (s) => 'Backs up VM ' + s.domain + '.'
    });
    const vm = { id: 'vm1', kind: 'test-vm', domain: 'builder' };
    assert.ok(Sources.kinds().includes('test-vm'));
    assert.deepEqual(Sources.validate(vm), []);
    assert.equal(Sources.isValid(vm), true);
    assert.deepEqual(Sources.toResticArgs(vm),
        ['--tag', 'vm:builder', '/var/lib/libvirt/images/builder.qcow2']);
    assert.equal(Sources.describe(vm), 'Backs up VM builder.');
    assert.deepEqual(Sources.normalize(vm), vm);           // default normalize is a copy
    assert.notEqual(Sources.normalize(vm), vm);
    assert.equal(Sources.isValid({ id: 'vm2', kind: 'test-vm' }), false);
    assert.throws(() => Sources.toResticArgs({ id: 'vm2', kind: 'test-vm' }), Errors.isHangarError);
});

test('registerKind honours a kind-supplied normalize', () => {
    Sources.registerKind('test-podman', {
        validate: () => [],
        normalize: (s) => ({ id: s.id, kind: 'test-podman', volumes: (s.volumes || []).slice().sort() }),
        toResticArgs: (s) => (s.volumes || []).slice().sort(),
        describe: () => 'Backs up podman volumes.'
    });
    assert.deepEqual(Sources.normalize({ id: 'p', kind: 'test-podman', volumes: ['b', 'a'] }),
        { id: 'p', kind: 'test-podman', volumes: ['a', 'b'] });
});

test('registerKind refuses to clobber an existing kind', () => {
    assert.throws(() => Sources.registerKind('filesystem', {
        validate: () => [], toResticArgs: () => [], describe: () => ''
    }), Errors.isHangarError);
});

test('registerKind refuses an incomplete implementation', () => {
    assert.throws(() => Sources.registerKind('test-incomplete', { validate: () => [] }), Errors.isHangarError);
    assert.throws(() => Sources.registerKind('test-null', null), Errors.isHangarError);
    assert.equal(Sources.kinds().includes('test-incomplete'), false);
});

test('registerKind refuses a nameless kind', () => {
    assert.throws(() => Sources.registerKind('', {
        validate: () => [], toResticArgs: () => [], describe: () => ''
    }), Errors.isHangarError);
    assert.throws(() => Sources.registerKind(null, {
        validate: () => [], toResticArgs: () => [], describe: () => ''
    }), Errors.isHangarError);
});

// ---- module contract -------------------------------------------------------

test('toError wraps problems in a typed HangarError', () => {
    const e = Sources.toError(Sources.validate(fsSource({ paths: [] })));
    assert.ok(Errors.isHangarError(e));
    assert.equal(e.kind, Errors.KIND.GENERIC);
    assert.equal(e.fatal, true);
    assert.equal(e.detail.problems[0].code, Sources.PROBLEM.NO_PATHS);
});

test('the module is pure: no cockpit reference, no ES module syntax', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../js/core/sources.js'), 'utf8');
    const code = src.replace(/^\s*\/\/.*$/gm, '');   // prose may mention cockpit; code may not
    assert.equal(/\bcockpit\b/.test(code), false);
    assert.equal(/^\s*(import|export)\s/m.test(src), false);
    assert.equal(src.indexOf(NUL), -1);   // a literal NUL in source would be a footgun
});

// ---- adversarial: canonicalPath edges --------------------------------------

test('canonicalPath returns empty string for undefined, booleans, arrays and objects', () => {
    assert.equal(Sources.canonicalPath(undefined), '');
    assert.equal(Sources.canonicalPath(true), '');
    assert.equal(Sources.canonicalPath(['/etc']), '');
    assert.equal(Sources.canonicalPath({}), '');
    assert.equal(Sources.canonicalPath(() => '/etc'), '');
});

test('canonicalPath collapses a doubled leading slash, which POSIX leaves implementation-defined', () => {
    assert.equal(Sources.canonicalPath('//srv'), '/srv');
    assert.equal(Sources.canonicalPath('//srv//data//'), '/srv/data');
});

test('canonicalPath leaves a bare relative path alone rather than inventing a root', () => {
    assert.equal(Sources.canonicalPath('etc/hangar/'), 'etc/hangar');
    assert.equal(Sources.canonicalPath('x'), 'x');
});

test('canonicalPath is idempotent and survives a pathological slash run', () => {
    const once = Sources.canonicalPath('/' + '/'.repeat(20000) + 'srv' + '/'.repeat(20000));
    assert.equal(once, '/srv');
    assert.equal(Sources.canonicalPath(once), once);
});

test('canonicalPath preserves NUL and newline instead of silently sanitising them', () => {
    // Rejecting them is validate()'s job; canonicalPath must not hide the evidence.
    assert.equal(Sources.canonicalPath('/etc' + NUL + '/x/'), '/etc' + NUL + '/x');
    assert.equal(Sources.canonicalPath('/etc/a\nb//'), '/etc/a\nb');
});

// ---- adversarial: id -------------------------------------------------------

test('validate accepts the id shapes that make a safe /etc/hangar/<id>.json filename', () => {
    ['a', '0', 'sys', 'a.b-c_d', 'A1', 'x'.repeat(512)].forEach((id) => {
        assert.deepEqual(errorCodes(Sources.validate(fsSource({ id }))), [], id);
    });
});

test('validate rejects ids that would escape or collide in the config directory', () => {
    ['', '.', '..', '/etc', 'a/b', './a', '_x', '-x', '.hidden', 'a b', 'a\tb'].forEach((id) => {
        assert.ok(errorCodes(Sources.validate(fsSource({ id }))).includes(Sources.PROBLEM.BAD_ID), id);
    });
});

test('validate rejects an id containing a newline or a NUL byte', () => {
    // JS anchors $ at end-of-string, not before a trailing newline — assert it.
    assert.ok(errorCodes(Sources.validate(fsSource({ id: 'sys\n' }))).includes(Sources.PROBLEM.BAD_ID));
    assert.ok(errorCodes(Sources.validate(fsSource({ id: 'sys\nevil' }))).includes(Sources.PROBLEM.BAD_ID));
    assert.ok(errorCodes(Sources.validate(fsSource({ id: 'sys' + NUL }))).includes(Sources.PROBLEM.BAD_ID));
});

test('validate rejects non-string ids of every flavour', () => {
    [null, 42, true, ['sys'], { id: 'sys' }, 0].forEach((id) => {
        assert.ok(errorCodes(Sources.validate(fsSource({ id }))).includes(Sources.PROBLEM.BAD_ID),
            String(id));
    });
});

test('validate rejects a non-ASCII id, because it names a file root has to type', () => {
    assert.ok(errorCodes(Sources.validate(fsSource({ id: 'yedek-günlük' }))).includes(Sources.PROBLEM.BAD_ID));
    assert.ok(errorCodes(Sources.validate(fsSource({ id: '日次' }))).includes(Sources.PROBLEM.BAD_ID));
});

// ---- adversarial: paths ----------------------------------------------------

test('validate rejects a paths field that is a string, object or number', () => {
    ['/etc', {}, 7, true, { 0: '/etc', length: 1 }].forEach((paths) => {
        assert.deepEqual(errorCodes(Sources.validate(fsSource({ paths }))), [Sources.PROBLEM.NO_PATHS]);
    });
});

test('validate rejects null, undefined and nested-array path entries by index', () => {
    const problems = Sources.validate(fsSource({ paths: [null, undefined, ['/srv'], {}] }));
    assert.deepEqual(errorCodes(problems), Array(4).fill(Sources.PROBLEM.PATH_TYPE));
    assert.deepEqual(problems.map((p) => p.index), [0, 1, 2, 3]);
});

test('validate rejects every traversal spelling of "." and ".."', () => {
    ['/..', '/../etc', '/etc/..', '/etc/../../root', '/.', '/./etc', '/srv/./.', '/srv/..//x']
        .forEach((p) => {
            assert.deepEqual(errorCodes(Sources.validate(fsSource({ paths: [p] }))),
                [Sources.PROBLEM.PATH_TRAVERSAL], p);
        });
});

test('validate allows dot-prefixed names that merely look like traversal', () => {
    // On Linux "..foo" and "..." are ordinary filenames; rejecting them would be a lie.
    assert.deepEqual(Sources.validate(fsSource({ paths: ['/etc/.config', '/srv/...', '/srv/..foo'] })), []);
});

test('validate treats a backslash as an ordinary filename character, not a separator', () => {
    assert.deepEqual(Sources.validate(fsSource({ paths: ['/srv/..\\..\\etc'] })), []);
    assert.deepEqual(Sources.validate(fsSource({ paths: ['/srv/%2e%2e/etc'] })), []);
});

test('validate reports the NUL byte before the traversal, so the worst problem wins', () => {
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ paths: ['/srv/..' + NUL] }))),
        [Sources.PROBLEM.PATH_NUL]);
});

test('validate accepts newlines, tabs and shell metacharacters inside a path', () => {
    // argv entries, never a shell line — only NUL is impossible to pass through execve.
    assert.deepEqual(Sources.validate(fsSource({
        paths: ['/srv/a\nb', '/srv/a\tb', '/srv/$(reboot)', '/srv/a;rm -rf /', '/srv/*']
    })), []);
});

test('validate accepts a very long path and a deeply nested one', () => {
    assert.deepEqual(Sources.validate(fsSource({ paths: ['/srv/' + 'x'.repeat(65536)] })), []);
    assert.deepEqual(Sources.validate(fsSource({ paths: ['/' + 'a/'.repeat(4096) + 'leaf'] })), []);
});

test('validate distinguishes case and unicode normalisation forms rather than guessing', () => {
    // ext4 compares bytes: NFC "é" and NFD "é" really are two different directories.
    assert.deepEqual(Sources.validate(fsSource({ paths: ['/srv', '/SRV'] })), []);
    assert.deepEqual(Sources.validate(fsSource({ paths: ['/srv/café', '/srv/café'] })), []);
});

test('validate flags every repeat of a path, not just the second one', () => {
    const problems = Sources.validate(fsSource({ paths: ['/srv', '/srv/', '//srv', '/srv'] }));
    assert.deepEqual(errorCodes(problems), Array(3).fill(Sources.PROBLEM.PATH_DUPLICATE));
    assert.deepEqual(problems.map((p) => p.index), [1, 2, 3]);
    assert.equal(problems[0].canonical, '/srv');
});

test('validate reports a duplicate and a redundant child from the same list', () => {
    const problems = Sources.validate(fsSource({ paths: ['/srv', '/srv/', '/srv/a'] }));
    assert.deepEqual(errorCodes(problems), [Sources.PROBLEM.PATH_DUPLICATE]);
    assert.deepEqual(warningCodes(problems), [Sources.PROBLEM.PATH_REDUNDANT]);
});

test('validate does not call a path redundant against a sibling it merely prefixes', () => {
    assert.deepEqual(Sources.validate(fsSource({ paths: ['/srv/app', '/srv/app.bak', '/srv/app-2'] })), []);
});

test('validate reports the deepest available parent for a doubly-covered child', () => {
    const problems = Sources.validate(fsSource({ paths: ['/', '/home', '/home/appuser'] }));
    assert.deepEqual(warningCodes(problems),
        [Sources.PROBLEM.PATH_REDUNDANT, Sources.PROBLEM.PATH_REDUNDANT]);
    assert.deepEqual(problems.map((p) => p.coveredBy), ['/', '/']);
});

test('validate warns once per child even when several parents cover it', () => {
    const problems = Sources.validate(fsSource({ paths: ['/a', '/a/b', '/a/b/c'] }));
    assert.equal(warningCodes(problems).length, 2);
});

test('validate reports redundancy using canonical paths, not the raw entry', () => {
    const problems = Sources.validate(fsSource({ paths: ['/home//', '/home//appuser//docs/'] }));
    assert.deepEqual(warningCodes(problems), [Sources.PROBLEM.PATH_REDUNDANT]);
    assert.equal(problems[0].path, '/home/appuser/docs');
    assert.equal(problems[0].coveredBy, '/home');
});

test('validate skips redundancy analysis for entries it already rejected', () => {
    const problems = Sources.validate(fsSource({ paths: ['/home', 'home/x', '/home/y'] }));
    assert.deepEqual(errorCodes(problems), [Sources.PROBLEM.PATH_NOT_ABSOLUTE]);
    assert.deepEqual(warningCodes(problems), [Sources.PROBLEM.PATH_REDUNDANT]);
    assert.equal(problems[1].path, '/home/y');
});

// ---- adversarial: excludes, exclude files, tags, hooks ---------------------

test('validate rejects non-array excludes of every non-array flavour', () => {
    [{}, 7, true, '*.tmp'].forEach((excludes) => {
        const problems = Sources.validate(fsSource({ excludes }));
        assert.deepEqual(errorCodes(problems), [Sources.PROBLEM.PATTERN_TYPE]);
        assert.equal(problems[0].field, 'excludes');
    });
});

test('validate ignores null and undefined exclude fields entirely', () => {
    assert.deepEqual(Sources.validate(fsSource({ excludes: null, iexcludes: undefined })), []);
    assert.deepEqual(Sources.validate(fsSource({ excludes: [] })), []);
});

test('validate carries field and index on every exclude pattern problem', () => {
    const problems = Sources.validate(fsSource({ excludes: ['ok', '', 'ok2'], iexcludes: [7] }));
    assert.deepEqual(errorCodes(problems), [Sources.PROBLEM.PATTERN_EMPTY, Sources.PROBLEM.PATTERN_TYPE]);
    assert.deepEqual(problems.map((p) => [p.field, p.index]), [['excludes', 1], ['iexcludes', 0]]);
});

test('validate accepts hostile-looking but legal exclude patterns', () => {
    assert.deepEqual(Sources.validate(fsSource({
        excludes: ['--exclude', '-rf', '$HOME/*', '../*', 'a\nb', 'x'.repeat(65536), '日本語/*']
    })), []);
});

test('validate rejects a null or numeric excludeFile entry as a type problem', () => {
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ excludeFile: 42 }))),
        [Sources.PROBLEM.PATTERN_TYPE]);
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ excludeFile: [{}] }))),
        [Sources.PROBLEM.PATTERN_TYPE]);
});

test('validate ignores a null excludeFile but rejects an empty string one', () => {
    assert.deepEqual(Sources.validate(fsSource({ excludeFile: null })), []);
    assert.deepEqual(Sources.validate(fsSource({ excludeFile: [] })), []);
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ excludeFile: '' }))),
        [Sources.PROBLEM.PATTERN_EMPTY]);
});

test('validate warns per relative exclude file and reports its index', () => {
    const problems = Sources.validate(fsSource({ excludeFile: ['/abs.txt', 'rel.txt', '~/home.txt'] }));
    assert.deepEqual(warningCodes(problems),
        [Sources.PROBLEM.EXCLUDE_FILE_RELATIVE, Sources.PROBLEM.EXCLUDE_FILE_RELATIVE]);
    assert.deepEqual(problems.map((p) => p.index), [1, 2]);
});

test('validate rejects a tag that is only a comma or is all commas', () => {
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ tags: [','] }))), [Sources.PROBLEM.TAG_COMMA]);
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ tags: ['a,'] }))), [Sources.PROBLEM.TAG_COMMA]);
});

test('validate ignores null and undefined tags but rejects a tags object', () => {
    assert.deepEqual(Sources.validate(fsSource({ tags: null })), []);
    assert.deepEqual(Sources.validate(fsSource({ tags: undefined })), []);
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ tags: {} }))), [Sources.PROBLEM.TAG_TYPE]);
});

test('validate accepts a tag with spaces, emoji, newlines and shell metacharacters', () => {
    assert.deepEqual(Sources.validate(fsSource({ tags: ['a b', '📦', 'a\nb', '$(id)', '-x'] })), []);
});

test('validate ignores an empty-string hook but rejects other falsy hook values', () => {
    assert.deepEqual(Sources.validate(fsSource({ preHook: '', postHook: null })), []);
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ preHook: 0 }))), [Sources.PROBLEM.HOOK_TYPE]);
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ postHook: false }))), [Sources.PROBLEM.HOOK_TYPE]);
});

test('validate accepts a multi-line hook script', () => {
    assert.deepEqual(Sources.validate(fsSource({
        preHook: 'set -e\nvirsh suspend vm\nsync\n'
    })), []);
});

test('validate reports problems in field order so the UI can highlight the first field', () => {
    const problems = Sources.validate({
        id: 'bad id', kind: 'filesystem', paths: ['rel'], excludes: [''], tags: [''], preHook: 7
    });
    assert.deepEqual(errorCodes(problems), [
        Sources.PROBLEM.BAD_ID,
        Sources.PROBLEM.PATH_NOT_ABSOLUTE,
        Sources.PROBLEM.PATTERN_EMPTY,
        Sources.PROBLEM.TAG_EMPTY,
        Sources.PROBLEM.HOOK_TYPE
    ]);
});

test('validate does not mutate the source it inspects', () => {
    const src = fsSource({ paths: ['/srv/', '/srv'], excludes: [''], tags: ['a,b'] });
    const copy = JSON.parse(JSON.stringify(src));
    Sources.validate(src);
    assert.deepEqual(src, copy);
});

// ---- adversarial: normalize ------------------------------------------------

test('normalize tolerates a source the validator would reject outright', () => {
    // The editor normalises on every keystroke; it must not explode mid-typing.
    const n = Sources.normalize({ kind: 'filesystem', id: 42, paths: 7, excludes: '*.tmp', tags: 'x' });
    assert.deepEqual(n, {
        id: '', kind: 'filesystem', paths: [], excludes: ['*.tmp'], iexcludes: [],
        excludeFile: [], oneFileSystem: false, tags: ['x'], preHook: '', postHook: ''
    });
});

test('the filesystem normalizer falls back to defaults for a null source', () => {
    assert.deepEqual(Sources.KINDS.filesystem.normalize(null), {
        id: '', kind: 'filesystem', paths: [], excludes: [], iexcludes: [],
        excludeFile: [], oneFileSystem: false, tags: [], preHook: '', postHook: ''
    });
    assert.deepEqual(Sources.KINDS.filesystem.normalize('/etc'),
        Sources.KINDS.filesystem.normalize(undefined));
});

test('normalize drops empty and non-string tags, patterns and exclude files', () => {
    const n = Sources.normalize(fsSource({
        tags: ['a', '', 3, null, 'a'], excludes: ['*.tmp', 7, null], excludeFile: ['/a.txt', '', 9, '/a.txt/']
    }));
    assert.deepEqual(n.tags, ['a']);
    assert.deepEqual(n.excludes, ['*.tmp']);
    assert.deepEqual(n.excludeFile, ['/a.txt']);
});

test('normalize coerces every non-string hook to an empty string', () => {
    [0, 1, null, {}, ['x']].forEach((v) => {
        assert.equal(Sources.normalize(fsSource({ preHook: v })).preHook, '');
    });
});

test('normalize coerces oneFileSystem truthiness, including the trap string "false"', () => {
    assert.equal(Sources.normalize(fsSource({ oneFileSystem: 'false' })).oneFileSystem, true);
    assert.equal(Sources.normalize(fsSource({ oneFileSystem: 0 })).oneFileSystem, false);
    assert.equal(Sources.normalize(fsSource({ oneFileSystem: null })).oneFileSystem, false);
    assert.equal(Sources.normalize(fsSource({ oneFileSystem: '' })).oneFileSystem, false);
});

test('normalize keeps paths that are only distinguishable by case or unicode form', () => {
    const n = Sources.normalize(fsSource({ paths: ['/srv', '/SRV', '/srv/café', '/srv/café'] }));
    assert.equal(n.paths.length, 4);
});

test('normalize never lets a "__proto__" key from parsed JSON reach Object.prototype', () => {
    const src = JSON.parse('{"id":"sys","kind":"filesystem","paths":["/etc"],"__proto__":{"pwned":1}}');
    Sources.normalize(src);
    Sources.validate(src);
    Sources.toResticArgs(src);
    assert.equal({}.pwned, undefined);
    assert.equal(Sources.normalize(src).pwned, undefined);
});

// ---- adversarial: toResticArgs --------------------------------------------

test('toResticArgs emits one flag per exclude file and de-duplicates them', () => {
    assert.deepEqual(Sources.toResticArgs(fsSource({ excludeFile: ['/a.txt', '/a.txt/', '/b.txt'] })),
        ['--exclude-file', '/a.txt', '--exclude-file', '/b.txt', '/etc']);
});

test('toResticArgs emits a relative exclude file, since that is only a warning', () => {
    assert.deepEqual(Sources.toResticArgs(fsSource({ excludeFile: 'excl.txt' })),
        ['--exclude-file', 'excl.txt', '/etc']);
});

test('toResticArgs de-duplicates repeated tags into a single flag pair', () => {
    assert.deepEqual(Sources.toResticArgs(fsSource({ tags: ['daily', 'daily'] })),
        ['--tag', 'daily', '/etc']);
});

test('toResticArgs keeps root as a lone positional', () => {
    assert.deepEqual(Sources.toResticArgs(fsSource({ paths: ['/'] })), ['/']);
    // "//" folds onto "/", so listing both is a duplicate rather than two roots.
    assert.deepEqual(errorCodes(Sources.validate(fsSource({ paths: ['/', '//'] }))),
        [Sources.PROBLEM.PATH_DUPLICATE]);
});

test('toResticArgs passes newlines, tabs and metacharacters through verbatim', () => {
    const args = Sources.toResticArgs(fsSource({
        paths: ['/srv/a\nb'], excludes: ['$(reboot)'], tags: ['a b']
    }));
    assert.deepEqual(args, ['--exclude', '$(reboot)', '--tag', 'a b', '/srv/a\nb']);
    args.forEach((a) => assert.equal(typeof a, 'string'));
});

test('toResticArgs never emits an empty or NUL-bearing argument', () => {
    const args = Sources.toResticArgs(fsSource({
        paths: ['/etc', '/srv/'], excludes: ['*.tmp'], excludeFile: '/e.txt', tags: ['t']
    }));
    args.forEach((a) => {
        assert.notEqual(a, '');
        assert.equal(a.indexOf(NUL), -1);
    });
});

test('toResticArgs names the failing problem in the thrown message', () => {
    assert.throws(() => Sources.toResticArgs(fsSource({ id: 'bad id' })), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.match(e.message, /^Cannot build restic arguments: /);
        assert.equal(e.detail.problems[0].code, Sources.PROBLEM.BAD_ID);
        return true;
    });
});

test('toResticArgs reports the first error even when a warning came first', () => {
    assert.throws(() => Sources.toResticArgs(fsSource({ paths: ['/home', '/home/x', ''] })), (e) => {
        assert.equal(e.detail.problems[0].code, Sources.PROBLEM.PATH_EMPTY);
        assert.equal(e.detail.problems.length, 2);   // the redundancy warning is kept for context
        return true;
    });
});

test('toResticArgs does not mutate the source', () => {
    const src = fsSource({ paths: ['/srv/', '/etc'], tags: ['a', 'a'] });
    const copy = JSON.parse(JSON.stringify(src));
    Sources.toResticArgs(src);
    assert.deepEqual(src, copy);
});

// ---- adversarial: describe -------------------------------------------------

test('describe joins exactly three paths without truncating', () => {
    assert.equal(Sources.describe(fsSource({ paths: ['/a', '/b', '/c'] })), 'Backs up /a, /b and /c.');
});

test('describe truncates at the fourth path and counts the remainder', () => {
    assert.equal(Sources.describe(fsSource({ paths: ['/a', '/b', '/c', '/d'] })),
        'Backs up /a, /b, /c and 1 more.');
});

test('describe counts the folded path list, not the raw one', () => {
    assert.equal(Sources.describe(fsSource({ paths: ['/a', '/a/', '/a//', '/b'] })), 'Backs up /a and /b.');
});

test('describe says nothing-configured when every path was junk', () => {
    assert.equal(Sources.describe(fsSource({ paths: [null, 7, ''] })),
        'Backs up nothing (no paths configured).');
    assert.equal(Sources.describe(fsSource({ paths: undefined })),
        'Backs up nothing (no paths configured).');
});

test('describe renders a hand-edited bare-string paths field that validate rejects', () => {
    // normalize wraps a lone string like it does for excludeFile, so the description
    // shows what is actually configured; validate is the thing that says no.
    assert.equal(Sources.describe(fsSource({ paths: '/etc' })), 'Backs up /etc.');
    assert.equal(Sources.isValid(fsSource({ paths: '/etc' })), false);
});

test('describe pluralises exclude files and counts iexcludes as patterns', () => {
    assert.equal(Sources.describe(fsSource({ excludeFile: ['/a.txt', '/b.txt'] })),
        'Backs up /etc, using 2 exclude files.');
    assert.equal(Sources.describe(fsSource({ iexcludes: ['*.LOG'] })), 'Backs up /etc, excluding 1 pattern.');
    assert.equal(Sources.describe(fsSource({ excludes: ['a'], iexcludes: ['b'] })),
        'Backs up /etc, excluding 2 patterns.');
});

test('describe reports one-filesystem and tags on their own', () => {
    assert.equal(Sources.describe(fsSource({ oneFileSystem: true })),
        'Backs up /etc, staying on one filesystem.');
    assert.equal(Sources.describe(fsSource({ tags: ['a', 'b'] })), 'Backs up /etc, tagged a, b.');
});

test('describe still renders for a source that would fail validation', () => {
    // The list page describes saved config it did not write; it must never throw.
    assert.equal(Sources.describe({ kind: 'filesystem', paths: ['/etc'], id: 42, tags: 'x' }),
        'Backs up /etc, tagged x.');
});

test('describe passes hostile path text through without escaping it', () => {
    assert.equal(Sources.describe(fsSource({ paths: ['/srv/<script>'] })), 'Backs up /srv/<script>.');
});

// ---- adversarial: registry -------------------------------------------------

test('a kind named after an Object.prototype member is unknown, not a crash', () => {
    // Regression: KINDS used to be a plain object, so KINDS.constructor was truthy
    // and validate() died with a TypeError instead of reporting an unknown kind.
    ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__', 'isPrototypeOf']
        .forEach((kind) => {
            const problems = Sources.validate({ id: 'x', kind, paths: ['/etc'] });
            assert.deepEqual(errorCodes(problems), [Sources.PROBLEM.UNKNOWN_KIND], kind);
            assert.equal(Sources.isValid({ id: 'x', kind }), false, kind);
            [Sources.normalize, Sources.describe, Sources.toResticArgs].forEach((fn) => {
                assert.throws(() => fn({ id: 'x', kind, paths: ['/etc'] }), Errors.isHangarError, kind);
            });
        });
});

test('validate reports a non-string kind as unknown and echoes it in the detail', () => {
    [42, null, undefined, true, {}, ['filesystem']].forEach((kind) => {
        const problems = Sources.validate({ id: 'x', kind, paths: ['/etc'] });
        assert.deepEqual(errorCodes(problems), [Sources.PROBLEM.UNKNOWN_KIND], String(kind));
        assert.equal(problems[0].kind, kind);
    });
});

test('an unstringifiable kind still yields a HangarError, not a TypeError', () => {
    [Symbol('vm'), Object.create(null)].forEach((kind) => {
        assert.deepEqual(errorCodes(Sources.validate({ id: 'x', kind })), [Sources.PROBLEM.UNKNOWN_KIND]);
        assert.throws(() => Sources.describe({ id: 'x', kind }), Errors.isHangarError);
    });
});

test('kinds() is sorted, own-property only, and does not leak inherited names', () => {
    const list = Sources.kinds();
    assert.deepEqual(list, list.slice().sort());
    assert.equal(list.includes('toString'), false);
    assert.equal(list.includes('constructor'), false);
});

test('registerKind returns the stored entry and keeps only the four contract members', () => {
    const entry = Sources.registerKind('test-extra', {
        validate: () => [], toResticArgs: () => [], describe: () => 'x', junk: 1
    });
    assert.deepEqual(Object.keys(entry).sort(), ['describe', 'normalize', 'toResticArgs', 'validate']);
    assert.equal(entry, Sources.KINDS['test-extra']);
});

test('registerKind refuses a non-string kind and a non-function member', () => {
    [42, [], {}, undefined, Symbol('k')].forEach((kind) => {
        assert.throws(() => Sources.registerKind(kind, {
            validate: () => [], toResticArgs: () => [], describe: () => ''
        }), Errors.isHangarError, String(kind));
    });
    assert.throws(() => Sources.registerKind('test-bad-member', {
        validate: 'nope', toResticArgs: () => [], describe: () => ''
    }), Errors.isHangarError);
    assert.equal(Sources.kinds().includes('test-bad-member'), false);
});

test('registerKind ignores a non-function normalize and falls back to a shallow copy', () => {
    Sources.registerKind('test-badnorm', {
        validate: () => [], normalize: 'nope', toResticArgs: () => [], describe: () => ''
    });
    const s = { id: 'n', kind: 'test-badnorm', extra: [1] };
    const n = Sources.normalize(s);
    assert.deepEqual(n, s);
    assert.notEqual(n, s);
    assert.equal(n.extra, s.extra);   // shallow by contract
});

test('a kind that reports a bare problem object instead of a list still throws a HangarError', () => {
    // Regression: toResticArgs called .filter() on whatever validate() returned.
    Sources.registerKind('test-barelist', {
        validate: () => ({ severity: 'error', code: 'nope', message: 'no' }),
        toResticArgs: () => [], describe: () => ''
    });
    assert.throws(() => Sources.toResticArgs({ id: 'b', kind: 'test-barelist' }), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.equal(e.detail.problems.length, 1);
        return true;
    });
});

test('a kind whose validate returns nothing is treated as valid', () => {
    Sources.registerKind('test-void', {
        validate: () => undefined, toResticArgs: () => ['/x'], describe: () => 'x'
    });
    assert.equal(Sources.isValid({ id: 'v', kind: 'test-void' }), true);
    assert.deepEqual(Sources.toResticArgs({ id: 'v', kind: 'test-void' }), ['/x']);
});

test('a kind literally named __proto__ registers as an ordinary key', () => {
    Sources.registerKind('__proto__', {
        validate: () => [], toResticArgs: () => ['/p'], describe: () => 'proto'
    });
    assert.ok(Sources.kinds().includes('__proto__'));
    assert.equal(Sources.describe({ id: 'p', kind: '__proto__' }), 'proto');
    assert.equal(Sources.KINDS.filesystem.describe(fsSource()), 'Backs up /etc.');
    assert.equal({}.toResticArgs, undefined);
});

// ---- adversarial: hasErrors / toError --------------------------------------

test('hasErrors tolerates junk instead of a problem list', () => {
    [null, undefined, 42, 'error', {}, [], [null], [{ severity: 'warning' }]].forEach((v) => {
        assert.equal(Sources.hasErrors(v), false, JSON.stringify(v));
    });
    assert.equal(Sources.hasErrors({ severity: 'error' }), true);
});

test('toError falls back to a generic message when there is nothing to report', () => {
    [[], null, undefined].forEach((v) => {
        const e = Sources.toError(v);
        assert.ok(Errors.isHangarError(e));
        assert.equal(e.message, 'Invalid backup source.');
        assert.deepEqual(e.detail.problems, []);
    });
});

test('toError prefers the first error over an earlier warning, and honours an override', () => {
    const problems = Sources.validate(fsSource({ paths: ['/home', '/home/x', 'rel'] }));
    assert.match(Sources.toError(problems).message, /not absolute/);
    assert.equal(Sources.toError(problems, 'Custom.').message, 'Custom.');
    assert.equal(Sources.toError(problems).fatal, true);
    assert.equal(Sources.toError(problems).remediation, null);
});

test('toError falls back to the first warning when there is no error', () => {
    const problems = Sources.validate(fsSource({ excludeFile: 'rel.txt' }));
    assert.match(Sources.toError(problems).message, /relative/);
});

// ---- the never-throw contract ----------------------------------------------

test('no hostile input makes the module throw an untyped exception', () => {
    const hostile = [
        null, undefined, 0, 1, '', 'filesystem', true, false, [], ['/etc'], () => '/etc',
        Symbol('s'), Object.create(null), new Date(),
        {}, { kind: 'filesystem' }, { kind: '' }, { kind: NUL }, { kind: 'FILESYSTEM' },
        { id: 'x', kind: 'filesystem', paths: null },
        { id: 'x', kind: 'filesystem', paths: [NUL, '', 7, '/etc'] },
        { id: NUL, kind: 'filesystem', paths: ['/etc'], excludes: [NUL], tags: [NUL], preHook: NUL },
        { id: 'x', kind: 'filesystem', paths: ['/x'.repeat(100000)] },
        { id: 'x', kind: 'filesystem', paths: ['/etc'], excludeFile: [null], tags: [[]], postHook: {} },
        JSON.parse('{"kind":"filesystem","paths":["/etc"],"__proto__":{"x":1}}')
    ];
    hostile.forEach((s, i) => {
        const label = 'case ' + i;
        const problems = Sources.validate(s);
        assert.ok(Array.isArray(problems), label);
        problems.forEach((p) => {
            assert.equal(typeof p.code, 'string', label);
            assert.equal(typeof p.message, 'string', label);
            assert.ok(p.severity === 'error' || p.severity === 'warning', label);
        });
        assert.equal(typeof Sources.isValid(s), 'boolean', label);
        [Sources.normalize, Sources.describe, Sources.toResticArgs].forEach((fn) => {
            try {
                fn(s);
            } catch (e) {
                assert.ok(Errors.isHangarError(e), label + ': ' + (e && e.name) + ' ' + (e && e.message));
            }
        });
    });
});

test('every PROBLEM code is a distinct kebab-case string', () => {
    const values = Object.keys(Sources.PROBLEM).map((k) => Sources.PROBLEM[k]);
    assert.equal(new Set(values).size, values.length);
    values.forEach((v) => assert.match(v, /^[a-z]+(-[a-z]+)*$/));
    assert.deepEqual(Sources.SEVERITY, { ERROR: 'error', WARNING: 'warning' });
});
