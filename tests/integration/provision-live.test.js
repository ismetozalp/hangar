// Integration tests for turnkey provisioning, run against THIS machine.
//
// Unit tests prove the requirement table parses and plans correctly. These prove the
// table is actually true of a real system: that the package names we would ask
// PackageKit for exist, that our probe agrees with `command -v`, and that the family
// we detect matches /etc/os-release.
//
// Wrong package names are the classic cross-distro bug, and they are invisible to
// unit tests because a unit test only ever compares our table to itself.
//
// Nothing here installs anything. Every check is read-only.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

const P = require('../../js/core/provision.js');

function have(cmd) {
    return spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0;
}

const OS_RELEASE = fs.existsSync('/etc/os-release')
    ? fs.readFileSync('/etc/os-release', 'utf8') : '';

const HAVE_PKCON = have('pkcon');
const skipPk = HAVE_PKCON ? false : 'pkcon (PackageKit) is not installed';

// --- family detection ----------------------------------------------------

test('detectFamily agrees with this host /etc/os-release', () => {
    assert.ok(OS_RELEASE, '/etc/os-release is missing — cannot verify detection');
    const parsed = P.parseOsRelease(OS_RELEASE);
    const family = P.detectFamily(parsed);

    assert.ok(P.FAMILIES.includes(family) || family === 'unknown',
        `detectFamily returned an unknown family: ${family}`);
    assert.notEqual(family, 'unknown',
        `this host (${parsed.ID}) was not recognised — the family table needs it`);

    // Cross-check against the raw file rather than trusting our own parser.
    const id = (OS_RELEASE.match(/^ID=("?)(.*?)\1$/m) || [])[2];
    const expected = {
        rhel: 'rhel', centos: 'rhel', rocky: 'rhel', almalinux: 'rhel',
        fedora: 'fedora', debian: 'debian', ubuntu: 'debian',
        opensuse: 'suse', 'opensuse-leap': 'suse', 'opensuse-tumbleweed': 'suse',
        sles: 'suse', arch: 'arch'
    }[id];
    if (expected) assert.equal(family, expected, `ID=${id} should map to ${expected}`);
});

test('parseOsRelease handles the real file, quotes and all', () => {
    const parsed = P.parseOsRelease(OS_RELEASE);
    assert.ok(parsed.ID, 'no ID parsed');
    // Values in os-release are quoted; a parser that keeps the quotes silently breaks
    // every downstream comparison.
    assert.ok(!/^["']|["']$/.test(parsed.ID), `ID retained quotes: ${JSON.stringify(parsed.ID)}`);
    if (parsed.VERSION_ID) assert.ok(!/^["']/.test(parsed.VERSION_ID));
});

// --- probing agrees with the system --------------------------------------

// probe() drives cockpit.spawn, which does not exist under node. So we run the same
// command it would run and feed the output to the pure evaluateProbe() — which is the
// part that can actually be wrong.
function liveProbe(tool) {
    const req = P.requirementFor(tool);
    const binary = req.binary || tool;
    if (!have(binary)) {
        return { tool, binary, optional: !!req.optional, present: false, raw: '', version: null, ok: false };
    }
    const r = spawnSync(binary, req.versionArgs || ['--version'], { encoding: 'utf8' });
    return P.evaluateProbe(tool, `${r.stdout || ''}${r.stderr || ''}`);
}

test('evaluateProbe reads a real version string for every installed tool', () => {
    let checked = 0;
    for (const tool of P.TOOLS) {
        const binary = P.requirementFor(tool).binary || tool;
        if (!have(binary)) continue;
        const res = liveProbe(tool);
        assert.equal(res.present, true, `${tool} is installed but evaluateProbe says absent`);
        assert.ok(res.raw, `${tool} produced no version output`);
        // A tool we cannot version-check is a tool whose minimum we cannot enforce.
        assert.ok(res.version,
            `could not parse a version for ${tool} from: ${JSON.stringify(res.raw.slice(0, 120))}`);
        checked++;
    }
    assert.ok(checked > 0, 'no managed tools are installed — nothing was actually verified');
});

test('probe() reports absent rather than throwing when cockpit is unavailable', async () => {
    // The plugin must degrade to "not installed" outside a Cockpit session, never
    // crash the page.
    const r = await P.probe('restic');
    assert.equal(r.present, false);
    assert.equal(r.ok, false);
    assert.equal(r.tool, 'restic');
});

test('the installed restic meets our stated minimum', () => {
    if (!have('restic')) return;   // nothing to assert on a host without it
    const r = liveProbe('restic');
    assert.ok(r.version, 'restic present but no version parsed from its output');
    const req = P.requirementFor('restic');
    assert.equal(P.meetsMinimum(r.version, req.minVersion), true,
        `installed restic ${P.formatVersion(r.version)} is below the declared minimum ${req.minVersion}`);
});

test('the declared restic minimum is 0.17.0 or later', () => {
    // Exit codes 10/11/12 — which the entire error-handling design depends on — only
    // exist from 0.17.0. Lowering this would silently break remediation.
    const min = P.parseVersion(P.requirementFor('restic').minVersion);
    assert.equal(P.meetsMinimum(min, P.parseVersion('0.17.0')), true,
        'the restic minimum must not drop below 0.17.0');
});

// --- planning against the live host --------------------------------------

test('planFor produces a step for every genuinely missing tool', () => {
    const family = P.detectFamily(P.parseOsRelease(OS_RELEASE));
    // missingFrom() returns tool-name strings, in install order.
    const missing = P.missingFrom(P.TOOLS.map(liveProbe));
    const plan = P.planFor(missing, family);

    // Cross-check against the system rather than trusting our own probe.
    for (const tool of P.TOOLS) {
        const binary = P.requirementFor(tool).binary || tool;
        assert.equal(missing.includes(tool), !have(binary),
            `${tool}: missing=${missing.includes(tool)} but command -v says installed=${have(binary)}`);
    }

    assert.equal(plan.length, missing.length);
    for (const step of plan) {
        assert.ok(P.TOOLS.includes(step.tool));
        assert.ok(Array.isArray(step.packages) && step.packages.length,
            `${step.tool} has no package names for family ${family}`);
        assert.ok(step.reason, `${step.tool} has no reason — the UI must explain why it is needed`);
        assert.ok([P.METHOD.PACKAGEKIT, P.METHOD.BINARY, 'packagekit', 'binary']
            .includes(step.method), `${step.tool} has an unknown method ${step.method}`);
    }
});

test('restic is the only non-optional tool', () => {
    // Everything else must degrade rather than block: no fuse3 means the Logbook uses
    // the ls fallback, no rear means no rescue image, but backups still run.
    for (const tool of P.TOOLS) {
        const req = P.requirementFor(tool);
        assert.equal(!req.optional, tool === 'restic',
            `${tool} optionality is wrong`);
    }
});

test('on RHEL-family hosts restic carries a binary fallback', () => {
    // restic is EPEL-only there, so PackageKit alone can legitimately fail. Without a
    // fallback the plugin would be un-installable on a stock RHEL box.
    const plan = P.planFor(['restic'], 'rhel');
    assert.equal(plan[0].fallback, 'binary');

    // ...and must NOT on distributions that package it directly, where offering an
    // unmanaged binary would be worse than the package.
    for (const fam of ['debian', 'fedora', 'suse', 'arch']) {
        assert.equal(P.planFor(['restic'], fam)[0].fallback, null,
            `${fam} should not offer a binary fallback — it packages restic`);
    }
});

test('the binary fallback points at official release URLs and never fabricates a checksum', () => {
    const fb = P.binaryFallbackFor('restic', '0.19.1', 'x86_64');
    assert.match(fb.url, /^https:\/\/github\.com\/restic\/restic\/releases\//);
    assert.ok(fb.sha256Url, 'no checksum URL — consent screen cannot show one');
    assert.match(fb.sha256Url, /^https:\/\//);
    // A hardcoded digest would be a lie the moment upstream re-tags.
    assert.equal(fb.sha256, undefined);
});

// --- PackageKit is genuinely reachable and our package names are real ----

test('PackageKit resolves the package names our table would install', { skip: skipPk }, () => {
    const family = P.detectFamily(P.parseOsRelease(OS_RELEASE));
    const names = [...new Set(P.TOOLS.flatMap((t) => P.packagesFor(t, family) || []))];
    assert.ok(names.length, 'no package names to resolve');

    const unresolved = [];
    for (const name of names) {
        // `pkcon resolve` is read-only and needs no privileges.
        const r = spawnSync('pkcon', ['--plain', 'resolve', name],
            { encoding: 'utf8', timeout: 120000 });
        const out = `${r.stdout || ''}${r.stderr || ''}`;
        if (r.status !== 0 || /could not be found|no packages were found/i.test(out)) {
            unresolved.push(name);
        }
    }

    assert.deepEqual(unresolved, [],
        `PackageKit cannot find these package names on family "${family}": ${unresolved.join(', ')}. ` +
        'Either the name is wrong for this distribution or the repository providing it is not enabled.');
});

test('classifyPackageKitError turns D-Bus noise into something a user can act on', () => {
    const cases = [
        'org.freedesktop.PackageKit.Transaction.PackageNotFound',
        'org.freedesktop.DBus.Error.AccessDenied',
        'org.freedesktop.PackageKit.Transaction.NotAuthorized',
        'Failed to download: connection timed out',
        'something entirely unexpected'
    ];
    for (const raw of cases) {
        const c = P.classifyPackageKitError(raw);
        assert.ok(c && c.message, `no message for: ${raw}`);
        // The whole point: never surface the raw D-Bus name to a user.
        assert.notEqual(c.message, raw);
        assert.ok(!/org\.freedesktop/.test(c.message),
            `raw D-Bus name leaked into user-facing text: ${c.message}`);
    }
});
