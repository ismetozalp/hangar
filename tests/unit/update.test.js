// Unit tests for js/features/update.js.
//
// Self-update downloads a remote archive and runs `make install` as root, so the
// tests here concentrate on the places where remote data reaches a privileged
// action: which URLs are accepted, what a malformed release document does, and
// whether an unexpected archive layout can steer the install.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../../js/features/update.js');

// --- releasesApiUrl -------------------------------------------------------

test('accepts owner/repo and every reasonable GitHub URL form', () => {
    const expected = 'https://api.github.com/repos/appuser/hangar/releases/latest';
    for (const input of [
        'appuser/hangar',
        ' appuser/hangar ',
        'https://github.com/appuser/hangar',
        'http://github.com/appuser/hangar',
        'https://www.github.com/appuser/hangar',
        'https://github.com/appuser/hangar.git',
        'https://github.com/appuser/hangar/'
    ]) {
        assert.equal(U.releasesApiUrl(input), expected, input);
    }
});

test('rejects anything that is not exactly owner/name', () => {
    const bad = ['', '   ', 'hangar', '/hangar', 'appuser/', 'a/b/c', null, undefined, 42, {},
        'https://github.com/appuser', 'https://github.com/appuser/hangar/tree/main'];
    for (const input of bad) {
        assert.equal(U.releasesApiUrl(input), '', JSON.stringify(input));
    }
});

test('rejects owner or name containing characters GitHub does not allow', () => {
    // A crafted "repo" must not be able to bend the API URL into another endpoint.
    for (const input of ['is met/hangar', 'appuser/han gar', 'appuser/../../x',
        'appuser/hangar?x=1', 'appuser/hangar#f', 'appuser/hangar:8080', 'a@b/c']) {
        assert.equal(U.releasesApiUrl(input), '', input);
    }
});

test('the built URL always points at api.github.com', () => {
    const url = U.releasesApiUrl('appuser/hangar');
    assert.ok(url.startsWith('https://api.github.com/repos/'));
});

// --- parseRelease ---------------------------------------------------------

function release(extra) {
    return JSON.stringify(Object.assign({
        tag_name: 'v2.0.0',
        body: 'notes here',
        prerelease: false,
        assets: [{ name: 'hangar-2.0.0.zip', browser_download_url: 'https://github.com/o/r/releases/download/v2.0.0/hangar-2.0.0.zip' }],
        zipball_url: 'https://api.github.com/repos/o/r/zipball/v2.0.0'
    }, extra || {}));
}

test('extracts tag, version, notes and the zip asset', () => {
    const r = U.parseRelease(release(), '1.0.0');
    assert.equal(r.tag, 'v2.0.0');
    assert.equal(r.version, '2.0.0');
    assert.equal(r.notes, 'notes here');
    assert.equal(r.available, true);
    assert.match(r.assetUrl, /hangar-2\.0\.0\.zip$/);
});

test('reports not-available when the release is not newer', () => {
    assert.equal(U.parseRelease(release(), '2.0.0').available, false);
    assert.equal(U.parseRelease(release(), '3.0.0').available, false);
});

test('a prerelease tag is surfaced but never offered as an upgrade over a stable release', () => {
    const r = U.parseRelease(release({ tag_name: 'v2.0.0-rc.1', prerelease: true }), '2.0.0');
    assert.equal(r.prerelease, true);
    assert.equal(r.available, false);
});

test('falls back to zipball_url when the release ships no zip asset', () => {
    const r = U.parseRelease(release({ assets: [] }), '1.0.0');
    assert.match(r.assetUrl, /zipball/);
});

test('ignores non-zip assets when choosing the download', () => {
    const r = U.parseRelease(release({
        assets: [
            { name: 'checksums.txt', browser_download_url: 'https://github.com/o/r/x.txt' },
            { name: 'hangar-2.0.0.zip', browser_download_url: 'https://github.com/o/r/h.zip' }
        ]
    }), '1.0.0');
    assert.match(r.assetUrl, /\.zip$/);
});

test('a GitHub error document is reported as an error, not an empty release', () => {
    // Rate limiting and missing repositories both return HTTP 200 with a message
    // field, which would otherwise look like a release with no tag.
    assert.throws(
        () => U.parseRelease(JSON.stringify({ message: 'API rate limit exceeded' }), '1.0.0'),
        (e) => e.kind === 'NETWORK' && /rate limit/.test(e.message));
});

test('non-JSON and non-object responses raise a typed error', () => {
    for (const text of ['<html>404</html>', '', 'null', '"a string"', '[1,2,3]']) {
        assert.throws(() => U.parseRelease(text, '1.0.0'),
            (e) => e.kind === 'GENERIC' || e.kind === 'NETWORK', JSON.stringify(text));
    }
});

test('a release with a garbage tag is never offered as an upgrade', () => {
    const r = U.parseRelease(release({ tag_name: 'nightly' }), '1.0.0');
    assert.equal(r.available, false);
});

// --- isAllowedAssetUrl: remote data reaching curl -------------------------

test('accepts only GitHub download hosts', () => {
    for (const url of [
        'https://github.com/o/r/releases/download/v1/x.zip',
        'https://codeload.github.com/o/r/zip/refs/tags/v1',
        'https://objects.githubusercontent.com/x'
    ]) {
        assert.equal(U.isAllowedAssetUrl(url), true, url);
    }
});

test('refuses non-GitHub, non-https and lookalike hosts', () => {
    for (const url of [
        'http://github.com/o/r/x.zip',              // plaintext
        'https://evil.com/x.zip',
        'https://github.com.evil.com/x.zip',        // suffix lookalike
        'https://notgithub.com/x.zip',
        'file:///etc/passwd',
        'ftp://github.com/x.zip',
        '', null, undefined, 42
    ]) {
        assert.equal(U.isAllowedAssetUrl(url), false, String(url));
    }
});

// --- chooseSourceDir: what `make install` gets pointed at -----------------

test('picks the single unpacked directory', () => {
    assert.equal(U.chooseSourceDir('/tmp/x', ['hangar', 'update.zip']), '/tmp/x/hangar');
});

test('falls back to the temp dir when the layout is not a single directory', () => {
    // Refusing to guess: pointing `make install` at the wrong tree would be worse
    // than failing.
    assert.equal(U.chooseSourceDir('/tmp/x', ['a', 'b', 'update.zip']), '/tmp/x');
    assert.equal(U.chooseSourceDir('/tmp/x', ['update.zip']), '/tmp/x');
    assert.equal(U.chooseSourceDir('/tmp/x', []), '/tmp/x');
    assert.equal(U.chooseSourceDir('/tmp/x', null), '/tmp/x');
});

// --- component ------------------------------------------------------------

test('the component constructs with no DOM and no cockpit', () => {
    assert.equal(typeof globalThis.cockpit, 'undefined');
    const c = U.hangarUpdateUi();
    assert.equal(c.updatePhase, U.PHASE.IDLE);
    assert.deepEqual(c.updateLog, []);
    assert.equal(c.update.available, false);
});

test('a check with no configured repository reports a settings problem, not a crash', async () => {
    const c = U.hangarUpdateUi();
    const state = await c.checkForUpdate(true, { updateRepo: '' });
    assert.match(state.error, /Settings/);
    assert.equal(state.available, false);
});

test('a check fails cleanly when cockpit is unavailable', async () => {
    const c = U.hangarUpdateUi();
    const state = await c.checkForUpdate(true, { updateRepo: 'appuser/hangar' });
    assert.ok(state.error, 'expected an error without cockpit');
    assert.equal(state.available, false);
});

test('initUpdate forwards settings to the check', async () => {
    // Regression: initUpdate used to call checkForUpdate(false) without settings, so
    // the repository was never seen and the startup check silently resolved to "no
    // repository configured" instead of contacting GitHub. Caught by the browser
    // test, pinned here.
    const c = U.hangarUpdateUi();
    let seen;
    c.checkForUpdate = async (manual, settings) => { seen = { manual, settings }; };
    c.readInstalledVersion = async () => '1.0.0';

    await c.initUpdate({ updateCheckOnStartup: true, updateRepo: 'appuser/hangar' });
    assert.ok(seen, 'checkForUpdate was never called');
    assert.equal(seen.manual, false);
    assert.equal(seen.settings.updateRepo, 'appuser/hangar');
});

test('initUpdate skips the check when it would be pointless', async () => {
    for (const settings of [
        null,
        {},
        { updateCheckOnStartup: false, updateRepo: 'appuser/hangar' },
        { updateCheckOnStartup: true, updateRepo: '' }   // nothing to check against
    ]) {
        const c = U.hangarUpdateUi();
        let called = false;
        c.checkForUpdate = async () => { called = true; };
        c.readInstalledVersion = async () => '1.0.0';
        await c.initUpdate(settings);
        assert.equal(called, false, `should not check for ${JSON.stringify(settings)}`);
    }
});

test('initUpdate always records the installed version', async () => {
    const c = U.hangarUpdateUi();
    c.readInstalledVersion = async () => '1.2.3';
    await c.initUpdate(null);
    assert.equal(c.installedVersion, '1.2.3');
});

test('the update modal cannot be opened without a download URL', () => {
    const c = U.hangarUpdateUi();
    assert.equal(c.openUpdateModal(), false);
});

test('startSelfUpdate refuses without a download URL', async () => {
    const c = U.hangarUpdateUi();
    assert.equal(await c.startSelfUpdate(), false);
});

test('startSelfUpdate refuses a download URL from an unexpected host', async () => {
    const c = U.hangarUpdateUi();
    c.update = Object.assign(U.blankState(), { assetUrl: 'https://evil.com/x.zip' });
    assert.equal(await c.startSelfUpdate(), false);
    assert.equal(c.updatePhase, U.PHASE.ERROR);
    assert.match(c.updateLog.join('\n'), /unexpected host/);
});

test('the modal cannot be dismissed while an install is in flight', () => {
    const c = U.hangarUpdateUi();
    c._inFlight = true;
    assert.equal(c.closeUpdateModal(), false);
    c._inFlight = false;
    assert.equal(c.closeUpdateModal(), true);
});

test('a second startSelfUpdate is refused while one is running', async () => {
    const c = U.hangarUpdateUi();
    c._inFlight = true;
    c.update = Object.assign(U.blankState(), {
        assetUrl: 'https://github.com/o/r/releases/download/v1/x.zip'
    });
    assert.equal(await c.startSelfUpdate(), false);
});

test('the badge label reflects each state', () => {
    const c = U.hangarUpdateUi();
    c.installedVersion = '1.0.0';
    assert.equal(c.updateBadgeLabel(), 'v1.0.0');

    c.update = Object.assign(U.blankState(), { available: true, version: '2.0.0' });
    assert.equal(c.updateBadgeLabel(), 'Update to 2.0.0');

    c.update = Object.assign(U.blankState(), { checking: true });
    assert.equal(c.updateBadgeLabel(), 'Checking…');

    c.update = Object.assign(U.blankState(), { error: 'boom' });
    assert.equal(c.updateBadgeLabel(), 'Update check failed');
});

test('the module never uses browser fetch to reach GitHub', () => {
    // CSP is connect-src 'self', so a fetch() to api.github.com is blocked in the
    // browser while passing happily in a test. Enforce the cockpit.spawn route.
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(
        path.join(__dirname, '..', '..', 'js', 'features', 'update.js'), 'utf8');
    const fetchLines = src.split('\n')
        .filter((l) => /\bfetch\s*\(/.test(l) && !/^\s*\/\//.test(l));
    // The single permitted fetch is the same-origin VERSION file.
    assert.equal(fetchLines.length, 1, `unexpected fetch() calls:\n${fetchLines.join('\n')}`);
    assert.match(fetchLines[0], /'VERSION'/);
    assert.ok(!/fetch\([^)]*github/i.test(src), 'fetch() must never target github.com');
});
