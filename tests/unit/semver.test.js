// Unit tests for js/core/semver.js.
//
// This module gates a privileged action: saying "newer" causes the UI to offer an
// update that runs `make install` as root. So the interesting cases are the ones
// where it must say NO — garbage input, pre-releases, and equal versions.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../js/core/semver.js');

test('parses plain versions', () => {
    assert.deepEqual(S.parse('1.2.3'),
        { major: 1, minor: 2, patch: 3, prerelease: null, build: null });
});

test('tolerates the conventional leading v on GitHub tags', () => {
    assert.deepEqual(S.parse('v1.2.3'), S.parse('1.2.3'));
    assert.deepEqual(S.parse('V1.2.3'), S.parse('1.2.3'));
    assert.deepEqual(S.parse(' 1.2.3 '), S.parse('1.2.3'));
});

test('fills in omitted minor and patch', () => {
    assert.deepEqual(S.parse('1'), { major: 1, minor: 0, patch: 0, prerelease: null, build: null });
    assert.deepEqual(S.parse('1.2'), { major: 1, minor: 2, patch: 0, prerelease: null, build: null });
});

test('captures prerelease and build metadata separately', () => {
    const p = S.parse('1.2.3-rc.1+build.5');
    assert.equal(p.prerelease, 'rc.1');
    assert.equal(p.build, 'build.5');
});

test('rejects malformed input', () => {
    const bad = ['', ' ', 'x', '1.2.3.4', 'v', 'latest', '1.2.-3', '1.2.3-', 'a.b.c',
        '-1.0.0', '1..2', null, undefined, 42, {}, [], true, '١.٢.٣'];
    for (const v of bad) assert.equal(S.parse(v), null, JSON.stringify(v));
});

test('isValid mirrors parse', () => {
    assert.equal(S.isValid('1.0.0'), true);
    assert.equal(S.isValid('nope'), false);
    assert.equal(S.isValid(null), false);
});

test('compares by major, then minor, then patch', () => {
    assert.equal(S.compare('2.0.0', '1.9.9'), 1);
    assert.equal(S.compare('1.2.0', '1.1.9'), 1);
    assert.equal(S.compare('1.1.2', '1.1.1'), 1);
    assert.equal(S.compare('1.1.1', '1.1.1'), 0);
    assert.equal(S.compare('1.0.0', '2.0.0'), -1);
});

test('compares numerically, not lexically', () => {
    // The classic bug: '10' sorting before '9' as a string.
    assert.equal(S.compare('1.10.0', '1.9.0'), 1);
    assert.equal(S.compare('0.19.1', '0.9.0'), 1);
    assert.equal(S.compare('10.0.0', '9.0.0'), 1);
});

test('a release outranks its own prereleases', () => {
    assert.equal(S.compare('1.0.0', '1.0.0-rc.1'), 1);
    assert.equal(S.compare('1.0.0-rc.1', '1.0.0'), -1);
});

test('prerelease identifiers compare per the spec', () => {
    assert.equal(S.compare('1.0.0-alpha', '1.0.0-alpha.1'), -1);
    assert.equal(S.compare('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1);
    assert.equal(S.compare('1.0.0-alpha.beta', '1.0.0-beta'), -1);
    assert.equal(S.compare('1.0.0-beta', '1.0.0-beta.2'), -1);
    assert.equal(S.compare('1.0.0-beta.2', '1.0.0-beta.11'), -1);   // numeric, not lexical
    assert.equal(S.compare('1.0.0-beta.11', '1.0.0-rc.1'), -1);
});

test('build metadata is ignored when comparing', () => {
    assert.equal(S.compare('1.0.0+a', '1.0.0+b'), 0);
    assert.equal(S.eq('1.0.0+a', '1.0.0'), true);
});

test('unparseable input sorts lowest so it can never look like an upgrade', () => {
    assert.equal(S.compare('garbage', '1.0.0'), -1);
    assert.equal(S.compare('1.0.0', 'garbage'), 1);
    assert.equal(S.compare('garbage', 'rubbish'), 0);
});

test('gt and eq agree with compare', () => {
    assert.equal(S.gt('1.1.0', '1.0.0'), true);
    assert.equal(S.gt('1.0.0', '1.1.0'), false);
    assert.equal(S.gt('1.0.0', '1.0.0'), false);
    assert.equal(S.eq('v1.0.0', '1.0.0'), true);
});

// --- isNewer: the only question the updater actually asks -----------------

test('isNewer accepts a genuine upgrade', () => {
    assert.equal(S.isNewer('1.1.0', '1.0.0'), true);
    assert.equal(S.isNewer('v2.0.0', '1.9.9'), true);
});

test('isNewer refuses an equal or older version', () => {
    assert.equal(S.isNewer('1.0.0', '1.0.0'), false);
    assert.equal(S.isNewer('0.9.0', '1.0.0'), false);
});

test('isNewer never offers a prerelease over a stable release', () => {
    // Otherwise every release candidate would be pushed to every user as if stable.
    assert.equal(S.isNewer('1.0.0-rc.1', '1.0.0'), false);
    assert.equal(S.isNewer('2.0.0-beta.1', '1.0.0'), true);   // still a real upgrade
});

test('isNewer refuses when either side is unparseable', () => {
    // This gates a root `make install`; refusing is always the safe failure.
    assert.equal(S.isNewer('garbage', '1.0.0'), false);
    assert.equal(S.isNewer('2.0.0', 'garbage'), false);
    assert.equal(S.isNewer('', ''), false);
    assert.equal(S.isNewer(null, '1.0.0'), false);
    assert.equal(S.isNewer('2.0.0', undefined), false);
});

test('isNewer works against the shipped VERSION file', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const current = fs.readFileSync(
        path.join(__dirname, '..', '..', 'VERSION'), 'utf8').trim();
    assert.equal(S.isValid(current), true, `VERSION file is not a valid semver: ${current}`);
    assert.equal(S.isNewer(current, current), false);

    const p = S.parse(current);
    assert.equal(S.isNewer(`${p.major + 1}.0.0`, current), true);
    assert.equal(S.isNewer(`${p.major}.${p.minor}.${p.patch}-rc.1`, current), false);
});

test('format round-trips a parsed version', () => {
    assert.equal(S.format('v1.2.3'), '1.2.3');
    assert.equal(S.format('1.2'), '1.2.0');
    assert.equal(S.format('1.2.3-rc.1+meta'), '1.2.3-rc.1');
    assert.equal(S.format('garbage'), '');
    assert.equal(S.format(S.parse('2.0.0')), '2.0.0');
});
