// Unit tests for the configurable Logbook mount folder.
//
// Settings offers a "Mount folder" field, validates it and saves it. Until this was
// threaded through, the Logbook still mounted under the hardcoded default — a
// setting that validates, saves and then does nothing, which is worse than not
// offering one at all.
//
// Found by mounting a real repository and noticing the generated argv ignored the
// root it had been handed, not by reading the code.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../../js/core/logbook.js');

const DEFAULT_ROOT = '/run/hangar/mnt';

test('mountPoint uses the configured root when given one', () => {
    assert.equal(L.mountPoint('main'), DEFAULT_ROOT + '/main');
    assert.equal(L.mountPoint('main', '/srv/hangar-mnt'), '/srv/hangar-mnt/main');
});

test('an absent, empty or root-only mount folder falls back to the default', () => {
    // "/" is refused as a root rather than mounting repositories directly under it.
    for (const v of [undefined, null, '', '   ', '/']) {
        assert.equal(L.mountPoint('main', v), DEFAULT_ROOT + '/main', JSON.stringify(v));
    }
});

test('a trailing slash on the mount folder does not double up', () => {
    assert.equal(L.mountPoint('main', '/srv/mnt/'), '/srv/mnt/main');
    assert.equal(L.mountPoint('main', '/srv/mnt///'), '/srv/mnt/main');
});

test('a relative or traversing mount folder is refused, not mounted elsewhere', () => {
    // The value reaches an argv. A relative root would mount relative to whatever
    // the unit's working directory happens to be, and ".." would escape entirely.
    for (const v of ['relative/path', './x', '../x', '/srv/../etc', '/a/b/../..']) {
        assert.throws(() => L.mountPoint('main', v), (e) => e.kind === 'GENERIC', v);
    }
});

test('a mount folder carrying a newline, CR or NUL is refused', () => {
    // Any of these would start a new directive if it reached a transient unit file.
    const hostile = [
        '/srv/a' + String.fromCharCode(10) + 'ExecStart=/bin/sh',
        '/srv/a' + String.fromCharCode(13) + 'b',
        '/srv/a' + String.fromCharCode(0) + 'b'
    ];
    for (const v of hostile) {
        assert.throws(() => L.mountPoint('main', v), (e) => e.kind === 'GENERIC');
    }
});

test('normalizeMountRoot never throws an untyped error', () => {
    for (const v of [42, {}, [], true, Symbol('x')]) {
        try {
            L.normalizeMountRoot(v);
        } catch (e) {
            assert.equal(e.kind, 'GENERIC', String(typeof v));
        }
    }
});

test('normalizeMountRoot returns the default for the empty forms', () => {
    assert.equal(L.normalizeMountRoot(undefined), DEFAULT_ROOT);
    assert.equal(L.normalizeMountRoot(''), DEFAULT_ROOT);
    assert.equal(L.normalizeMountRoot('/'), DEFAULT_ROOT);
});

test('buildMountArgv mounts at the configured root', () => {
    const argv = L.buildMountArgv({
        repoId: 'main', repoUrl: '/srv/repo',
        passwordFile: '/etc/hangar/repos/main.key',
        mountRoot: '/srv/hangar-mnt'
    });
    assert.equal(argv[argv.length - 1], '/srv/hangar-mnt/main',
        'the configured mount folder did not reach the command');
});

test('an explicit mountPoint still wins over a configured root', () => {
    // Callers may compute the full path themselves; that must keep working.
    const argv = L.buildMountArgv({
        repoId: 'main', repoUrl: '/srv/repo', passwordFile: '/k',
        mountRoot: '/srv/ignored', mountPoint: '/mnt/explicit'
    });
    assert.equal(argv[argv.length - 1], '/mnt/explicit');
});

test('a hostile configured root cannot inject a systemd directive', () => {
    assert.throws(() => L.buildMountArgv({
        repoId: 'main', repoUrl: '/srv/repo', passwordFile: '/k',
        mountRoot: '/srv/x' + String.fromCharCode(10) + 'ExecStartPost=/bin/sh -c id'
    }), (e) => e.kind === 'GENERIC');
});

test('the repo id is still validated when a custom root is used', () => {
    // The root changing must not open a second path to a bad id.
    for (const bad of ['../escape', 'a/b', '', null]) {
        assert.throws(() => L.mountPoint(bad, '/srv/mnt'), (e) => e.kind === 'GENERIC',
            JSON.stringify(bad));
    }
});
