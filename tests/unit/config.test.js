// Unit tests for js/core/config.js — path derivation, id validation and merging.
// The I/O layer is covered by tests/integration; here we test only the pure parts,
// which is why the module must load cleanly with no `cockpit` global present.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../js/core/config.js');

test('module loads without a cockpit global', () => {
    assert.equal(typeof globalThis.cockpit, 'undefined');
    assert.equal(typeof C.validateId, 'function');
});

test('validateId accepts the documented safe set', () => {
    for (const id of ['a', 'main', 'repo-1', 'x9', '0abc', 'a-b-c-d', 'a'.repeat(63)]) {
        assert.equal(C.validateId(id), id, id);
    }
});

test('validateId rejects path traversal and separators', () => {
    // Ids become filenames AND systemd unit instance names, so this guard is the
    // reason no caller downstream has to think about quoting.
    const hostile = [
        '..', '../etc/passwd', 'a/b', '/abs', './rel', 'a\\b',
        'a\0b', 'a\nb', 'a b', 'a.b', 'A', 'ABC', 'répo', 'repo!', '-lead',
        '', 'a'.repeat(64)
    ];
    for (const id of hostile) {
        assert.throws(() => C.validateId(id), (e) => e.kind === 'GENERIC', JSON.stringify(id));
    }
});

test('validateId rejects non-strings', () => {
    for (const v of [null, undefined, 42, {}, [], true, Symbol('x')]) {
        assert.throws(() => C.validateId(v), (e) => e.kind === 'GENERIC');
    }
});

test('path builders produce the documented layout', () => {
    assert.equal(C.repoPath('main'), '/etc/hangar/repos/main.json');
    assert.equal(C.jobPath('nightly'), '/etc/hangar/jobs/nightly.json');
    assert.equal(C.statePath('nightly'), '/var/lib/hangar/state/nightly.json');
    assert.equal(C.globalPath(), '/etc/hangar/config.json');
    assert.equal(C.drPath(), '/etc/hangar/dr.json');
});

test('path builders inherit the id guard', () => {
    for (const fn of [C.repoPath, C.jobPath, C.statePath]) {
        assert.throws(() => fn('../../etc/shadow'), (e) => e.kind === 'GENERIC');
    }
});

test('state lives under /var/lib, not /run — it must survive a reboot', () => {
    // /run is tmpfs; a run record that vanishes on reboot would hide a failed
    // overnight backup, which is exactly when the user needs to see it.
    assert.ok(C.statePath('j').startsWith('/var/lib/'));
});

test('mergeGlobal fills defaults', () => {
    assert.deepEqual(C.mergeGlobal({}), C.DEFAULT_GLOBAL);
    assert.deepEqual(C.mergeGlobal(null), C.DEFAULT_GLOBAL);
    assert.deepEqual(C.mergeGlobal(undefined), C.DEFAULT_GLOBAL);
    assert.deepEqual(C.mergeGlobal('nonsense'), C.DEFAULT_GLOBAL);
});

test('mergeGlobal honours stored values', () => {
    const merged = C.mergeGlobal({ mountIdleTimeoutSec: 60, notifyOnFailure: false });
    assert.equal(merged.mountIdleTimeoutSec, 60);
    assert.equal(merged.notifyOnFailure, false);
    assert.equal(merged.mountRoot, C.DEFAULT_GLOBAL.mountRoot);
});

test('mergeGlobal drops unknown keys written by a newer hangar', () => {
    const merged = C.mergeGlobal({ mountRoot: '/x', somethingNew: 'boom' });
    assert.equal(merged.mountRoot, '/x');
    assert.equal(merged.somethingNew, undefined);
});

test('mergeGlobal ignores null/undefined values rather than storing them', () => {
    const merged = C.mergeGlobal({ mountRoot: null, mountIdleTimeoutSec: undefined });
    assert.equal(merged.mountRoot, C.DEFAULT_GLOBAL.mountRoot);
    assert.equal(merged.mountIdleTimeoutSec, C.DEFAULT_GLOBAL.mountIdleTimeoutSec);
});

test('mergeGlobal does not mutate its input or the defaults', () => {
    const input = { mountRoot: '/x' };
    const before = JSON.stringify(C.DEFAULT_GLOBAL);
    C.mergeGlobal(input);
    assert.deepEqual(input, { mountRoot: '/x' });
    assert.equal(JSON.stringify(C.DEFAULT_GLOBAL), before);
});

test('mergeGlobal accepts falsy-but-meaningful values', () => {
    assert.equal(C.mergeGlobal({ mountIdleTimeoutSec: 0 }).mountIdleTimeoutSec, 0);
    assert.equal(C.mergeGlobal({ notifyOnFailure: false }).notifyOnFailure, false);
});

test('validateJob flags every missing requirement', () => {
    assert.deepEqual(C.validateJob(null), ['Job is empty.']);
    assert.deepEqual(C.validateJob(undefined), ['Job is empty.']);
    assert.deepEqual(C.validateJob('x'), ['Job is empty.']);

    const problems = C.validateJob({});
    assert.ok(problems.some(p => /id is invalid/.test(p)));
    assert.ok(problems.some(p => /does not name a repository/.test(p)));
    assert.ok(problems.some(p => /no sources/.test(p)));
});

test('validateJob passes a well-formed job', () => {
    assert.deepEqual(C.validateJob({
        id: 'nightly', repo: 'main',
        sources: [{ kind: 'filesystem', paths: ['/home'] }]
    }), []);
});

test('validateJob rejects an empty sources array', () => {
    const problems = C.validateJob({ id: 'j', repo: 'r', sources: [] });
    assert.ok(problems.some(p => /no sources/.test(p)));
});

test('validateJob rejects a hostile repo id', () => {
    const problems = C.validateJob({ id: 'j', repo: '../../etc', sources: [{ paths: ['/a'] }] });
    assert.ok(problems.some(p => /Repository id is invalid/.test(p)));
});

test('listIds returns empty rather than throwing when cockpit is absent', async () => {
    assert.deepEqual(await C.listIds('/etc/hangar/repos'), []);
});

test('ID_RE is anchored — no partial matches', () => {
    assert.equal(C.ID_RE.test('good\nbad'), false);
    assert.equal(C.ID_RE.test('good bad'), false);
});

// --- the config directory may not exist yet ------------------------------
//
// Reported from real use: picking a theme said "The theme was applied, but could
// not be saved: not-found". /etc/hangar is created by `make install`, and a
// symlink into ~/.local/share/cockpit — a perfectly normal way to run a Cockpit
// plugin — never runs it. So on that install EVERY save failed, not just the
// theme: repositories, jobs, settings and the DR config too.

test('directory modes mirror what make install creates', () => {
    // repos/ holds repository passwords alongside the definitions, so it is 0700
    // while the rest is ordinary world-readable configuration.
    assert.equal(C.dirModeFor('/etc/hangar'), '0755');
    assert.equal(C.dirModeFor('/etc/hangar/jobs'), '0755');
    assert.equal(C.dirModeFor('/etc/hangar/repos'), '0700');
});

test('an unknown directory gets the conservative default, not repos mode', () => {
    assert.equal(C.dirModeFor('/etc/hangar/something-new'), '0755');
    assert.equal(C.dirModeFor(''), '0755');
    assert.equal(C.dirModeFor('__proto__'), '0755');
});

test('a raw cockpit problem code becomes something a user can act on', () => {
    // "not-found" on its own reads as a bug in hangar rather than as a missing
    // directory, which is what sent this report in.
    const notFound = C.writeFailureText({ problem: 'not-found' }, '/etc/hangar/config.json');
    assert.match(notFound, /\/etc\/hangar\/config\.json/);
    assert.ok(!/^not-found$/.test(notFound));
    assert.match(notFound, /folder/i);

    assert.match(C.writeFailureText({ problem: 'access-denied' }, '/x'), /[Pp]ermission/);
    assert.match(C.writeFailureText({ problem: 'no-space-left' }, '/x'), /space/i);
});

test('writeFailureText always names the path and never returns empty', () => {
    for (const e of [null, undefined, {}, new Error(''), { problem: '' }, 'a string']) {
        const text = C.writeFailureText(e, '/etc/hangar/config.json');
        assert.ok(text && text.trim() !== '', 'empty failure text for ' + JSON.stringify(e));
        assert.match(text, /\/etc\/hangar\/config\.json/);
    }
});

test('ensureDirFor derives the directory from the file path', async () => {
    // No cockpit under node, so it must reject with a typed error rather than
    // throwing an untyped one — the same contract as every other I/O entry point.
    await assert.rejects(() => C.ensureDirFor('/etc/hangar/config.json'),
        (e) => e.kind === 'GENERIC');
});

test('writeJson refuses cleanly with no cockpit rather than half-writing', async () => {
    await assert.rejects(() => C.writeJson('/etc/hangar/config.json', { a: 1 }),
        (e) => e.kind === 'GENERIC');
});

// --- limited access is not an empty install -------------------------------
//
// Found by driving a real Cockpit session: every page starts with limited
// access, /etc/hangar is root-owned, and listIds answered [] for the refusal.
// A machine with a working repository was told it had none — the worst thing a
// backup tool can get wrong.

test('a refusal is recognised however cockpit words it', () => {
    assert.equal(C.isAccessDenied({ problem: 'access-denied' }), true);
    assert.equal(C.isAccessDenied({ message: 'Not permitted to perform this action.' }), true);
    assert.equal(C.isAccessDenied({ message: 'ls: cannot open directory: Permission denied' }), true);
});

test('a missing directory is not a refusal — it really is nothing configured', () => {
    assert.equal(C.isAccessDenied({ problem: 'not-found', message: 'No such file or directory' }), false);
    assert.equal(C.isAccessDenied(null), false);
    assert.equal(C.isAccessDenied({}), false);
});

test('the refusal carries a kind of its own, and says what to do about it', () => {
    const e = C.adminRequired('/etc/hangar/repos');
    assert.equal(e.kind, 'ADMIN_REQUIRED');
    // Not 'retry': the next read is refused exactly like the last one.
    assert.equal(e.remediation, 'grant-access');
    assert.match(e.message, /\/etc\/hangar\/repos/);
    assert.match(e.message, /administrative access/i);
});
