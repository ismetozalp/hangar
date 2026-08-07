// Unit tests for js/core/fspicker.js — the shared path browser.
//
// Two things carry real risk here: path arithmetic that could walk out of the tree
// the user believes they are browsing, and a filename reaching a command line.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../../js/core/fspicker.js');

const NUL = String.fromCharCode(0);
const RS = String.fromCharCode(30);

// --- path arithmetic ------------------------------------------------------

test('normalizePath collapses . and repeated slashes', () => {
    assert.equal(F.normalizePath('/a//b/./c'), '/a/b/c');
    assert.equal(F.normalizePath('/a/b/'), '/a/b');
    assert.equal(F.normalizePath('/'), '/');
    assert.equal(F.normalizePath(''), '/');
    assert.equal(F.normalizePath('   '), '/');
});

test('normalizePath resolves .. and can never escape the root', () => {
    assert.equal(F.normalizePath('/a/b/../c'), '/a/c');
    assert.equal(F.normalizePath('/a/../..'), '/');
    assert.equal(F.normalizePath('/../../../etc'), '/etc');
    assert.equal(F.normalizePath('/..'), '/');
});

test('normalizePath is total for hostile input', () => {
    for (const v of [null, undefined, 42, {}, [], true]) {
        assert.equal(typeof F.normalizePath(v), 'string');
    }
});

test('joinPath handles the root and empty names', () => {
    assert.equal(F.joinPath('/', 'etc'), '/etc');
    assert.equal(F.joinPath('/srv', 'backups'), '/srv/backups');
    assert.equal(F.joinPath('/srv/', 'backups'), '/srv/backups');
    assert.equal(F.joinPath('/srv', ''), '/srv');
});

test('a name containing .. cannot climb out through joinPath', () => {
    // The name comes from a listing, but a crafted one must not escape.
    assert.equal(F.joinPath('/srv/backups', '..'), '/srv');
    assert.equal(F.joinPath('/', '..'), '/');
});

test('parentOf stops at the root', () => {
    assert.equal(F.parentOf('/a/b/c'), '/a/b');
    assert.equal(F.parentOf('/a'), '/');
    assert.equal(F.parentOf('/'), '/');
    assert.equal(F.parentOf(''), '/');
});

test('breadcrumbs walk from the root to the current folder', () => {
    assert.deepEqual(F.breadcrumbs('/srv/backups').map((c) => c.label), ['/', 'srv', 'backups']);
    assert.deepEqual(F.breadcrumbs('/srv/backups').map((c) => c.path),
        ['/', '/srv', '/srv/backups']);
    assert.deepEqual(F.breadcrumbs('/').map((c) => c.path), ['/']);
});

// --- validation -----------------------------------------------------------

test('validatePath demands an absolute path', () => {
    assert.deepEqual(F.validatePath('/srv/backups'), []);
    assert.ok(F.validatePath('relative/path').length);
    assert.ok(F.validatePath('').length);
    assert.ok(F.validatePath('   ').length);
});

test('validatePath rejects newlines and NUL', () => {
    // Both would reach a command line; a NUL truncates an argument at exec time
    // and a newline can start a second directive in a unit file.
    assert.ok(F.validatePath('/srv/a' + String.fromCharCode(10) + 'b').length);
    assert.ok(F.validatePath('/srv/a' + String.fromCharCode(13) + 'b').length);
    assert.ok(F.validatePath('/srv/a' + NUL + 'b').length);
});

test('validateFolderName refuses a separator, so a name cannot become a tree', () => {
    assert.deepEqual(F.validateFolderName('backups'), []);
    assert.ok(F.validateFolderName('a/b').length);
    assert.ok(F.validateFolderName('..').length);
    assert.ok(F.validateFolderName('.').length);
    assert.ok(F.validateFolderName('').length);
    assert.ok(F.validateFolderName('   ').length);
    assert.ok(F.validateFolderName('x'.repeat(300)).length);
    assert.ok(F.validateFolderName('a' + NUL + 'b').length);
});

// --- listing --------------------------------------------------------------

function listing(pairs) {
    return pairs.map(([t, n]) => t + '\t' + n).join(NUL) + NUL;
}

test('parseListing reads find output and orders folders first', () => {
    const out = F.parseListing(listing([
        ['f', 'zeta.txt'], ['d', 'var'], ['f', 'alpha.txt'], ['d', 'etc']
    ]), { mode: 'any' });
    assert.deepEqual(out.map((e) => e.name), ['etc', 'var', 'alpha.txt', 'zeta.txt']);
});

test('a filename containing a newline stays one entry', () => {
    // The whole reason the listing is NUL-separated: splitting on newlines would
    // turn one oddly-named folder into two fake ones.
    const weird = 'two' + String.fromCharCode(10) + 'lines';
    const out = F.parseListing(listing([['d', weird]]), { mode: 'any' });
    assert.equal(out.length, 1);
    assert.equal(out[0].name, weird);
});

test('hidden entries are excluded unless asked for', () => {
    const raw = listing([['d', '.git'], ['d', 'src']]);
    assert.deepEqual(F.parseListing(raw, { mode: 'any' }).map((e) => e.name), ['src']);
    assert.deepEqual(F.parseListing(raw, { mode: 'any', showHidden: true }).map((e) => e.name),
        ['.git', 'src']);
});

test('mode decides what is selectable, not what is shown', () => {
    const raw = listing([['d', 'etc'], ['f', 'notes.txt']]);
    // A file is still listed in dir mode — you may need to see it to know you are
    // in the right folder — it simply cannot be chosen.
    const dir = F.parseListing(raw, { mode: 'dir' });
    assert.equal(dir.length, 2);
    assert.equal(dir.find((e) => e.name === 'etc').selectable, true);
    assert.equal(dir.find((e) => e.name === 'notes.txt').selectable, false);

    const file = F.parseListing(raw, { mode: 'file' });
    assert.equal(file.find((e) => e.name === 'etc').selectable, false);
    assert.equal(file.find((e) => e.name === 'notes.txt').selectable, true);
});

test('a symlink is browsable but not assumed to be a directory', () => {
    const out = F.parseListing(listing([['l', 'link']]), { mode: 'any' });
    assert.equal(out[0].type, 'l');
    assert.equal(out[0].isDir, false);
    assert.equal(F.isNavigable(out[0]), true);
});

test('parseListing survives junk without throwing', () => {
    for (const v of ['', null, undefined, 'no tabs here', NUL + NUL, 42, {}]) {
        assert.ok(Array.isArray(F.parseListing(v, { mode: 'any' })));
    }
});

test('. and .. are never listed', () => {
    const out = F.parseListing(listing([['d', '.'], ['d', '..'], ['d', 'real']]),
        { mode: 'any', showHidden: true });
    assert.deepEqual(out.map((e) => e.name), ['real']);
});

// --- what Choose returns --------------------------------------------------

test('folder mode with nothing selected chooses the current folder', () => {
    // A destination picker should not make the user descend into a folder and then
    // hunt for a way to say "this one".
    assert.equal(F.chosenPath('/srv/backups', null, 'dir'), '/srv/backups');
    assert.equal(F.canChoose('/srv/backups', null, 'dir'), true);
});

test('file mode with nothing selected cannot be chosen', () => {
    assert.equal(F.chosenPath('/srv', null, 'file'), '');
    assert.equal(F.canChoose('/srv', null, 'file'), false);
});

test('a selection wins over the current folder in every mode', () => {
    for (const mode of ['dir', 'file', 'any']) {
        assert.equal(F.chosenPath('/srv', { name: 'thing' }, mode), '/srv/thing');
    }
});

// --- argv -----------------------------------------------------------------

test('listArgv asks find for one level, record separated', () => {
    const argv = F.listArgv('/srv');
    assert.equal(argv[0], 'find');
    assert.equal(argv[1], '/srv');
    assert.ok(argv.includes('-maxdepth'));
    assert.ok(argv.includes('-mindepth'));
    assert.ok(argv.join(' ').includes('%y'));
});

test('the record separator is asked for in octal, which find documents', () => {
    // \xHH is not in find's escape grammar, and a literal control byte in the
    // format string is the thing this whole change exists to avoid.
    const fmt = F.listArgv('/')[F.listArgv('/').length - 1];
    assert.match(fmt, /\\036$/);
    assert.ok(fmt.indexOf(RS) < 0, 'the format string carries a raw control byte');
    assert.ok(fmt.indexOf(NUL) < 0, 'the format string carries a raw NUL');
});

// --- a listing that cannot be read is not an empty folder -----------------
//
// The picker showed "This folder is empty." for '/' on a real machine. Every
// entry had been dropped, and nothing said so — which sends the user looking
// for a problem with their filesystem rather than with hangar.

test('output that yields no records at all is reported, not called empty', () => {
    assert.equal(F.looksUnparsed('d\tetc' + RS + 'd\thome' + RS), false);
    assert.equal(F.looksUnparsed('d\tetc' + NUL + 'd\thome' + NUL), false);
    // What a dropped separator looks like: one run with no separator to split on
    // is still a record, but a listing whose tabs are gone is not.
    assert.equal(F.looksUnparsed('detc dhome'), true);
});

test('an empty listing is an empty folder, not a failure', () => {
    // An unreadable folder is common; claiming a bug every time one is empty
    // would be its own kind of lie.
    for (const v of ['', '   ', '\n', null, undefined])
        assert.equal(F.looksUnparsed(v), false, JSON.stringify(v));
});

test('a folder of nothing but hidden files is empty, not unreadable', () => {
    // Records parsed fine; the mode filtered them. That is not a parse failure.
    const raw = 'f\t.bashrc' + RS + 'f\t.profile' + RS;
    assert.equal(F.looksUnparsed(raw), false);
    assert.deepEqual(F.parseListing(raw, { mode: 'any' }), []);
});

test('listArgv normalises before it asks, so .. never reaches find', () => {
    assert.equal(F.listArgv('/srv/../../etc')[1], '/etc');
});

test('a path or name travels as exactly one argv element', () => {
    // Shell metacharacters are harmless here because nothing goes through a shell,
    // but they must not split into extra arguments.
    // No trailing slash: normalizePath strips one, which is correct and would
    // make this assertion about normalisation rather than about argv splitting.
    const nasty = '/srv/a b; rm -rf *';
    assert.equal(F.listArgv(nasty)[1], nasty);
    // A folder NAME cannot contain '/', so the hostile-but-legal case is one with
    // shell metacharacters and spaces.
    const mk = F.mkdirArgv('/srv', 'a b; rm -rf *');
    assert.equal(mk[mk.length - 1], '/srv/a b; rm -rf *');
    // '--' terminates options, so a leading-dash name cannot become a flag.
    assert.ok(mk.includes('--'));
    assert.equal(mk.length, 4, 'the path split into extra arguments');
});

test('unknown modes fall back rather than failing', () => {
    assert.equal(F.modeFor('nope').id, F.DEFAULT_MODE);
    assert.equal(F.modeFor('__proto__').id, F.DEFAULT_MODE);
    assert.equal(F.modeFor(undefined).id, F.DEFAULT_MODE);
});

test('the impure half degrades to a typed error with no cockpit', async () => {
    await assert.rejects(() => F.list('/srv'), (e) => e.kind === 'GENERIC');
    await assert.rejects(() => F.makeFolder('/srv', 'x'), (e) => e.kind === 'GENERIC');
    // A bad name is refused before it ever needs cockpit.
    await assert.rejects(() => F.makeFolder('/srv', 'a/b'), (e) => e.kind === 'GENERIC');
});

test('mkdirArgv refuses a name that would become a path', () => {
    // Exported, so it must not depend on makeFolder having validated first: a '/'
    // here would silently create a tree somewhere the user did not choose.
    for (const bad of ['a/b', '..', '.', '', 'a' + String.fromCharCode(0) + 'b']) {
        assert.throws(() => F.mkdirArgv('/srv', bad), (e) => e.kind === 'GENERIC',
            JSON.stringify(bad));
    }
});

// --- what the picker asks the bridge for ----------------------------------
//
// Both of these were found by driving a real Cockpit session with Playwright,
// and neither could have been found any other way: the stub answered whatever
// it was asked, so every one of these calls "passed" while the picker was dead.

function withCockpit(reply, fn) {
    const calls = [];
    globalThis.cockpit = {
        spawn(argv, opts) { calls.push({ argv, opts }); return Promise.resolve(reply); }
    };
    try { return fn(calls); } finally { delete globalThis.cockpit; }
}

test('listing asks for superuser but does not demand it', async () => {
    // 'require' is refused outright in a session without administrative access,
    // which left the dialog showing "Not permitted to perform this action." and
    // nothing else. A listing is a read: show what this user can see.
    await withCockpit('d\tetc' + RS, async (calls) => {
        await F.list('/', { mode: 'dir' });
        assert.equal(calls[0].opts.superuser, 'try');
    });
});

test('creating a folder still demands superuser', async () => {
    // A write that half-works is worse than one that is refused.
    await withCockpit('', async (calls) => {
        await F.makeFolder('/srv', 'backups');
        assert.equal(calls[0].opts.superuser, 'require');
    });
});

test('the listing never asks find for a NUL separator', async () => {
    // Measured against a real session: cockpit.spawn's text channel discards
    // output containing NUL, resolving with an empty string — so a picker that
    // asked for '%y\t%f\0' reported every folder on the machine as empty.
    await withCockpit('d\tetc' + RS, async (calls) => {
        await F.list('/', { mode: 'dir' });
        const fmt = calls[0].argv[calls[0].argv.length - 1];
        // \\0 NOT followed by another octal digit: "\\036" is RS, "\\0" is NUL.
        assert.doesNotMatch(fmt, /\\0(?![0-7])/, `the format asks for NUL: ${JSON.stringify(fmt)}`);
        assert.match(fmt, /\\036$/);
        assert.ok(calls[0].argv.every((a) => a.indexOf(NUL) < 0), 'a raw NUL reached argv');
    });
});
