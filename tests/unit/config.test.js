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
