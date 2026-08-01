// tests/unit/provision.test.js — HangarProvision: version parsing and comparison,
// os-release family detection for all five families, install planning (including
// the EPEL-only restic fallback on RHEL) and static-binary URL construction.
//
// The os-release blocks below are hand-written in the documented os-release
// format, abridged to the ID / ID_LIKE / VERSION_ID fields this module reads.
// They are inline rather than in tests/fixtures/ precisely because they are not
// captured verbatim from the distributions they name.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('../../js/core/provision.js');
const Errors = require('../../js/core/errors.js');

function assertGeneric(fn) {
    assert.throws(fn, (e) => {
        assert.ok(Errors.isHangarError(e), 'expected a HangarError, got ' + e);
        assert.equal(e.kind, Errors.KIND.GENERIC);
        return true;
    });
}

// ---------------------------------------------------------------- parseVersion

test('parseVersion reads restic\'s real banner', () => {
    assert.deepEqual(P.parseVersion('restic 0.19.1 compiled with go1.23 on linux/amd64'),
        { major: 0, minor: 19, patch: 1 });
});

test('parseVersion is not fooled by the go toolchain version', () => {
    // "go1.23" must not win: the digits are glued to a word.
    assert.deepEqual(P.parseVersion('restic compiled with go1.23 on linux/amd64'), null);
});

test('parseVersion reads rclone\'s v-prefixed banner', () => {
    assert.deepEqual(P.parseVersion('rclone v1.74.3'), { major: 1, minor: 74, patch: 3 });
});

test('parseVersion reads a multi-line rclone banner', () => {
    const text = 'rclone v1.74.3\n- os/version: fedora 42 (64 bit)\n- go/version: go1.24.1\n';
    assert.deepEqual(P.parseVersion(text), { major: 1, minor: 74, patch: 3 });
});

test('parseVersion ignores the 3 in fusermount3', () => {
    assert.deepEqual(P.parseVersion('fusermount3 version: 3.16.2'), { major: 3, minor: 16, patch: 2 });
});

test('parseVersion reads ReaR\'s banner', () => {
    assert.deepEqual(P.parseVersion('Relax-and-Recover 2.7 / 2020-06-17'), { major: 2, minor: 7, patch: 0 });
});

test('parseVersion accepts a bare two-component version', () => {
    assert.deepEqual(P.parseVersion('2.6'), { major: 2, minor: 6, patch: 0 });
});

test('parseVersion accepts a bare single-component version', () => {
    assert.deepEqual(P.parseVersion('9'), { major: 9, minor: 0, patch: 0 });
});

test('parseVersion tolerates a pre-release suffix', () => {
    assert.deepEqual(P.parseVersion('restic 0.17.0-dev (compiled manually)'),
        { major: 0, minor: 17, patch: 0 });
});

test('parseVersion returns null on empty, null and undefined', () => {
    assert.equal(P.parseVersion(''), null);
    assert.equal(P.parseVersion(null), null);
    assert.equal(P.parseVersion(undefined), null);
});

test('parseVersion returns null on garbage', () => {
    assert.equal(P.parseVersion('command not found'), null);
    assert.equal(P.parseVersion('.....'), null);
    assert.equal(P.parseVersion('vvv'), null);
});

test('parseVersion returns null when the digits are part of a word', () => {
    assert.equal(P.parseVersion('abc123'), null);
    assert.equal(P.parseVersion('linux/amd64'), null);
});

test('parseVersion handles a leading v with no separator', () => {
    assert.deepEqual(P.parseVersion('v0.19.1'), { major: 0, minor: 19, patch: 1 });
});

// ---------------------------------------------------------------- formatVersion

test('formatVersion pads missing components', () => {
    assert.equal(P.formatVersion('rear 2.7'), '2.7.0');
    assert.equal(P.formatVersion({ major: 1, minor: 2, patch: 3 }), '1.2.3');
});

test('formatVersion throws a typed error on garbage', () => {
    assertGeneric(() => P.formatVersion('nope'));
});

// ---------------------------------------------------------------- compareVersions

test('compareVersions orders by major', () => {
    assert.equal(P.compareVersions('1.0.0', '0.19.1'), 1);
    assert.equal(P.compareVersions('0.19.1', '1.0.0'), -1);
});

test('compareVersions orders by minor', () => {
    assert.equal(P.compareVersions('0.17.0', '0.9.0'), 1);
    assert.equal(P.compareVersions('0.9.0', '0.17.0'), -1);
});

test('compareVersions orders by patch', () => {
    assert.equal(P.compareVersions('0.19.1', '0.19.0'), 1);
    assert.equal(P.compareVersions('0.19.0', '0.19.1'), -1);
});

test('compareVersions reports equality', () => {
    assert.equal(P.compareVersions('0.19.1', '0.19.1'), 0);
    assert.equal(P.compareVersions('2.7', '2.7.0'), 0);
});

test('compareVersions accepts banners and parsed objects interchangeably', () => {
    assert.equal(P.compareVersions('restic 0.19.1 compiled with go1.23', { major: 0, minor: 19, patch: 1 }), 0);
    assert.equal(P.compareVersions({ major: 0, minor: 16, patch: 4 }, 'restic 0.17.0'), -1);
});

test('compareVersions does not compare numerically as text', () => {
    // "0.9" > "0.17" as strings; as versions it is the other way round.
    assert.equal(P.compareVersions('0.9.0', '0.17.0'), -1);
});

test('compareVersions throws a typed error on unparseable input', () => {
    assertGeneric(() => P.compareVersions('garbage', '1.0.0'));
    assertGeneric(() => P.compareVersions('1.0.0', ''));
});

// ---------------------------------------------------------------- meetsMinimum

test('meetsMinimum accepts the exact minimum', () => {
    assert.equal(P.meetsMinimum('restic 0.17.0', '0.17.0'), true);
});

test('meetsMinimum rejects the version below the exit-code floor', () => {
    // Pre-0.17.0 restic lacks exit codes 10/11, which the error model needs.
    assert.equal(P.meetsMinimum('restic 0.16.4', '0.17.0'), false);
});

test('meetsMinimum accepts a newer version', () => {
    assert.equal(P.meetsMinimum('restic 0.19.1', '0.17.0'), true);
});

test('meetsMinimum is true when no minimum is declared', () => {
    assert.equal(P.meetsMinimum('rclone v1.74.3', null), true);
    assert.equal(P.meetsMinimum(null, null), true);
});

test('meetsMinimum is false when the found version cannot be read', () => {
    assert.equal(P.meetsMinimum('command not found', '0.17.0'), false);
    assert.equal(P.meetsMinimum(null, '0.17.0'), false);
});

// ---------------------------------------------------------------- parseOsRelease

test('parseOsRelease strips quotes, comments and blank lines', () => {
    const text = '# a comment\n\nID="rhel"\nNAME=\'Red Hat Enterprise Linux\'\nVERSION_ID="10.2"\n';
    const f = P.parseOsRelease(text);
    assert.equal(f.ID, 'rhel');
    assert.equal(f.NAME, 'Red Hat Enterprise Linux');
    assert.equal(f.VERSION_ID, '10.2');
});

test('parseOsRelease survives CRLF and stray lines without an =', () => {
    const f = P.parseOsRelease('ID=debian\r\nnonsense\r\n=orphan\r\nVERSION_ID="12"\r\n');
    assert.deepEqual(f, { ID: 'debian', VERSION_ID: '12' });
});

test('parseOsRelease unescapes backslash escapes inside quotes', () => {
    assert.equal(P.parseOsRelease('PRETTY_NAME="Acme \\"Linux\\""').PRETTY_NAME, 'Acme "Linux"');
});

test('parseOsRelease returns an empty object for empty and null input', () => {
    assert.deepEqual(P.parseOsRelease(''), {});
    assert.deepEqual(P.parseOsRelease(null), {});
    assert.deepEqual(P.parseOsRelease(undefined), {});
});

// ---------------------------------------------------------------- detectFamily

test('detectFamily: RHEL, whose ID_LIKE is fedora', () => {
    // ID must win over ID_LIKE here, or restic would lose its EPEL fallback.
    assert.equal(P.detectFamily('NAME="Red Hat Enterprise Linux"\nID="rhel"\nID_LIKE="fedora"\nVERSION_ID="10.2"\n'), 'rhel');
});

test('detectFamily: CentOS Stream', () => {
    assert.equal(P.detectFamily('ID="centos"\nID_LIKE="rhel fedora"\nVERSION_ID="10"\n'), 'rhel');
});

test('detectFamily: Rocky Linux', () => {
    assert.equal(P.detectFamily('ID="rocky"\nID_LIKE="rhel centos fedora"\nVERSION_ID="9.5"\n'), 'rhel');
});

test('detectFamily: AlmaLinux', () => {
    assert.equal(P.detectFamily('ID="almalinux"\nID_LIKE="rhel centos fedora"\nVERSION_ID="9.5"\n'), 'rhel');
});

test('detectFamily: Oracle Linux', () => {
    assert.equal(P.detectFamily('ID="ol"\nID_LIKE="fedora"\nVERSION_ID="9.5"\n'), 'rhel');
});

test('detectFamily: an unknown rebuild resolves rhel ahead of fedora via ID_LIKE', () => {
    assert.equal(P.detectFamily('ID="acmeos"\nID_LIKE="rhel centos fedora"\n'), 'rhel');
});

test('detectFamily: Fedora', () => {
    assert.equal(P.detectFamily('NAME="Fedora Linux"\nID=fedora\nVERSION_ID=42\n'), 'fedora');
});

test('detectFamily: a Fedora derivative with no rhel token', () => {
    assert.equal(P.detectFamily('ID="nobara"\nID_LIKE="fedora"\n'), 'fedora');
});

test('detectFamily: Debian', () => {
    assert.equal(P.detectFamily('ID=debian\nVERSION_ID="12"\n'), 'debian');
});

test('detectFamily: Ubuntu', () => {
    assert.equal(P.detectFamily('ID=ubuntu\nID_LIKE=debian\nVERSION_ID="24.04"\n'), 'debian');
});

test('detectFamily: Linux Mint', () => {
    assert.equal(P.detectFamily('ID=linuxmint\nID_LIKE="ubuntu debian"\nVERSION_ID="22"\n'), 'debian');
});

test('detectFamily: Raspberry Pi OS', () => {
    assert.equal(P.detectFamily('ID=raspbian\nID_LIKE=debian\n'), 'debian');
});

test('detectFamily: an unknown Debian derivative via ID_LIKE=ubuntu', () => {
    assert.equal(P.detectFamily('ID="acmebuntu"\nID_LIKE="ubuntu"\n'), 'debian');
});

test('detectFamily: openSUSE Leap', () => {
    assert.equal(P.detectFamily('ID="opensuse-leap"\nID_LIKE="suse opensuse"\nVERSION_ID="15.6"\n'), 'suse');
});

test('detectFamily: openSUSE Tumbleweed', () => {
    assert.equal(P.detectFamily('ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n'), 'suse');
});

test('detectFamily: SLES', () => {
    assert.equal(P.detectFamily('ID="sles"\nID_LIKE="suse"\nVERSION_ID="15.6"\n'), 'suse');
});

test('detectFamily: Arch', () => {
    assert.equal(P.detectFamily('NAME="Arch Linux"\nID=arch\nBUILD_ID=rolling\n'), 'arch');
});

test('detectFamily: Manjaro', () => {
    assert.equal(P.detectFamily('ID=manjaro\nID_LIKE=arch\n'), 'arch');
});

test('detectFamily: EndeavourOS', () => {
    assert.equal(P.detectFamily('ID=endeavouros\nID_LIKE=arch\n'), 'arch');
});

test('detectFamily: unknown for empty, null and unrelated content', () => {
    assert.equal(P.detectFamily(''), 'unknown');
    assert.equal(P.detectFamily(null), 'unknown');
    assert.equal(P.detectFamily('ID=plan9\nID_LIKE="inferno"\n'), 'unknown');
});

test('detectFamily is case-insensitive about ID', () => {
    assert.equal(P.detectFamily('ID=Fedora\n'), 'fedora');
    assert.equal(P.detectFamily('ID="RHEL"\n'), 'rhel');
});

test('detectFamily accepts an already-parsed os-release object', () => {
    assert.equal(P.detectFamily({ ID: 'ubuntu', ID_LIKE: 'debian' }), 'debian');
});

// ---------------------------------------------------------------- REQUIREMENTS

test('REQUIREMENTS covers exactly the managed tools, in install order', () => {
    assert.deepEqual(P.TOOLS,
        ['restic', 'rclone', 'fuse3', 'rear', 'libvirt', 'unzip', 'curl']);
    assert.deepEqual(Object.keys(P.REQUIREMENTS).sort(),
        ['curl', 'fuse3', 'libvirt', 'rclone', 'rear', 'restic', 'unzip']);
});

test('REQUIREMENTS names a package for every family, and restic alone is mandatory', () => {
    P.TOOLS.forEach((tool) => {
        const req = P.REQUIREMENTS[tool];
        P.FAMILIES.forEach((fam) => {
            assert.ok(Array.isArray(req.packages[fam]), tool + ' has no package list for ' + fam);
        });
    });
    assert.equal(P.REQUIREMENTS.restic.optional, false);
    assert.equal(P.REQUIREMENTS.rclone.optional, true);
    assert.equal(P.REQUIREMENTS.fuse3.optional, true);
    assert.equal(P.REQUIREMENTS.rear.optional, true);
});

test('restic\'s minimum is the version that introduced exit codes 10 and 11', () => {
    assert.equal(P.REQUIREMENTS.restic.minVersion, '0.17.0');
    assert.equal(P.meetsMinimum('0.16.4', P.REQUIREMENTS.restic.minVersion), false);
});

test('fuse3 is probed through fusermount3, not a binary called fuse3', () => {
    assert.equal(P.REQUIREMENTS.fuse3.binary, 'fusermount3');
});

test('requirementFor throws a typed error for an unknown tool', () => {
    assertGeneric(() => P.requirementFor('borg'));
    assertGeneric(() => P.requirementFor(''));
});

test('packagesFor returns a copy, so callers cannot mutate the table', () => {
    const a = P.packagesFor('restic', 'debian');
    a.push('evil');
    assert.deepEqual(P.packagesFor('restic', 'debian'), ['restic']);
});

test('packagesFor returns an empty list for rear on arch and for unknown families', () => {
    assert.deepEqual(P.packagesFor('rear', 'arch'), []);
    assert.deepEqual(P.packagesFor('restic', 'unknown'), []);
});

// ---------------------------------------------------------------- planFor

test('planFor marks restic on RHEL as packagekit with a binary fallback', () => {
    const plan = P.planFor(['restic'], 'rhel');
    assert.equal(plan.length, 1);
    assert.deepEqual(plan[0], {
        tool: 'restic',
        method: 'packagekit',
        packages: ['restic'],
        fallback: 'binary',
        optional: false,
        reason: P.REQUIREMENTS.restic.reason,
        // Enabling EPEL keeps restic a managed, signed, updatable package, so it is
        // offered ahead of the loose binary rather than instead of it.
        enableRepo: P.EPEL_PACKAGE
    });
});

test('planFor gives restic no fallback on the families that ship it themselves', () => {
    ['fedora', 'debian', 'suse', 'arch'].forEach((fam) => {
        const step = P.planFor(['restic'], fam)[0];
        assert.equal(step.method, 'packagekit', fam);
        assert.equal(step.fallback, null, fam);
    });
});

test('planFor keeps the install order regardless of the order asked for', () => {
    const plan = P.planFor(['rear', 'fuse3', 'restic'], 'debian');
    assert.deepEqual(plan.map((s) => s.tool), ['restic', 'fuse3', 'rear']);
});

test('planFor de-duplicates and drops unknown tools rather than guessing', () => {
    const plan = P.planFor(['restic', 'restic', 'borg', '', null], 'fedora');
    assert.deepEqual(plan.map((s) => s.tool), ['restic']);
});

test('planFor falls back to the static binary when the family is unknown', () => {
    const plan = P.planFor(['restic', 'rclone'], 'martian');
    assert.deepEqual(plan.map((s) => s.method), ['binary', 'binary']);
});

test('planFor reports fuse3 and rear as unavailable when nothing can install them', () => {
    assert.equal(P.planFor(['fuse3'], 'unknown')[0].method, 'unavailable');
    assert.equal(P.planFor(['rear'], 'arch')[0].method, 'unavailable');
});

test('planFor returns an empty plan for empty, null and non-array input', () => {
    assert.deepEqual(P.planFor([], 'rhel'), []);
    assert.deepEqual(P.planFor(null, 'rhel'), []);
    assert.deepEqual(P.planFor(undefined, 'rhel'), []);
});

test('planFor accepts a bare tool name and probe-result objects', () => {
    assert.deepEqual(P.planFor('restic', 'debian').map((s) => s.tool), ['restic']);
    assert.deepEqual(P.planFor([{ tool: 'rclone' }], 'debian').map((s) => s.tool), ['rclone']);
});

test('planFor marks optional tools as optional', () => {
    const plan = P.planFor(['restic', 'rclone', 'fuse3', 'rear'], 'suse');
    assert.deepEqual(plan.map((s) => s.optional), [false, true, true, true]);
});

// ---------------------------------------------------------------- describeStep

test('describeStep mentions the fallback only when there is one', () => {
    const withFallback = P.describeStep(P.planFor(['restic'], 'rhel')[0]);
    assert.match(withFallback, /static binary/);
    const plain = P.describeStep(P.planFor(['restic'], 'debian')[0]);
    assert.doesNotMatch(plain, /static binary/);
    assert.match(plain, /package manager/);
});

test('describeStep says so when a tool cannot be installed at all', () => {
    assert.match(P.describeStep(P.planFor(['rear'], 'arch')[0]), /manually/);
    assert.equal(P.describeStep(null), 'Nothing to install.');
});

// ---------------------------------------------------------------- normalizeArch

test('normalizeArch maps uname names onto release-asset names', () => {
    assert.equal(P.normalizeArch('x86_64'), 'amd64');
    assert.equal(P.normalizeArch('aarch64'), 'arm64');
    assert.equal(P.normalizeArch('armv7l'), 'arm');
    assert.equal(P.normalizeArch('i686'), '386');
    assert.equal(P.normalizeArch('ppc64le'), 'ppc64le');
});

test('normalizeArch is case- and whitespace-tolerant, and null on nonsense', () => {
    assert.equal(P.normalizeArch('  X86_64 '), 'amd64');
    assert.equal(P.normalizeArch('sparc'), null);
    assert.equal(P.normalizeArch(''), null);
    assert.equal(P.normalizeArch(null), null);
});

// ---------------------------------------------------------------- binaryFallbackFor

test('binaryFallbackFor builds the official restic release URLs', () => {
    assert.deepEqual(P.binaryFallbackFor('restic', '0.19.1', 'x86_64'), {
        tool: 'restic',
        version: '0.19.1',
        arch: 'amd64',
        url: 'https://github.com/restic/restic/releases/download/v0.19.1/restic_0.19.1_linux_amd64.bz2',
        sha256Url: 'https://github.com/restic/restic/releases/download/v0.19.1/SHA256SUMS',
        sigUrl: 'https://github.com/restic/restic/releases/download/v0.19.1/SHA256SUMS.asc'
    });
});

test('binaryFallbackFor handles arm64 and a v-prefixed version string', () => {
    const out = P.binaryFallbackFor('restic', 'v0.19.1', 'aarch64');
    assert.equal(out.url, 'https://github.com/restic/restic/releases/download/v0.19.1/restic_0.19.1_linux_arm64.bz2');
});

test('binaryFallbackFor builds rclone URLs with rclone\'s asset naming', () => {
    const out = P.binaryFallbackFor('rclone', '1.74.3', 'x86_64');
    assert.equal(out.url, 'https://github.com/rclone/rclone/releases/download/v1.74.3/rclone-v1.74.3-linux-amd64.zip');
    assert.equal(out.sha256Url, 'https://github.com/rclone/rclone/releases/download/v1.74.3/SHA256SUMS');
    // rclone's SHA256SUMS is clear-signed, so there is no detached signature asset.
    assert.equal(out.sigUrl, null);
});

test('binaryFallbackFor never returns a checksum value, only where to fetch one', () => {
    const out = P.binaryFallbackFor('restic', '0.19.1', 'x86_64');
    assert.equal(out.sha256, undefined);
    assert.deepEqual(Object.keys(out).sort(), ['arch', 'sha256Url', 'sigUrl', 'tool', 'url', 'version']);
});

test('binaryFallbackFor defaults to the verified version when none is given', () => {
    assert.equal(P.binaryFallbackFor('restic', null, 'x86_64').version, P.RECOMMENDED_VERSION.restic);
});

test('binaryFallbackFor refuses tools with no official static release', () => {
    assertGeneric(() => P.binaryFallbackFor('rear', '2.7', 'x86_64'));
    assertGeneric(() => P.binaryFallbackFor('fuse3', '3.16.2', 'x86_64'));
    assertGeneric(() => P.binaryFallbackFor('', '1.0.0', 'x86_64'));
});

test('binaryFallbackFor refuses unknown and unpublished architectures', () => {
    assertGeneric(() => P.binaryFallbackFor('restic', '0.19.1', 'sparc'));
    assertGeneric(() => P.binaryFallbackFor('rclone', '1.74.3', 's390x'));
});

test('binaryFallbackFor refuses an unparseable version', () => {
    assertGeneric(() => P.binaryFallbackFor('restic', 'latest', 'x86_64'));
});

// ---------------------------------------------------------------- probe helpers

test('evaluateProbe accepts a good restic banner', () => {
    assert.deepEqual(P.evaluateProbe('restic', 'restic 0.19.1 compiled with go1.23 on linux/amd64\n'), {
        tool: 'restic',
        binary: 'restic',
        optional: false,
        present: true,
        raw: 'restic 0.19.1 compiled with go1.23 on linux/amd64',
        version: { major: 0, minor: 19, patch: 1 },
        ok: true
    });
});

test('evaluateProbe rejects a restic below the minimum but still calls it present', () => {
    const r = P.evaluateProbe('restic', 'restic 0.16.4 compiled with go1.21 on linux/amd64');
    assert.equal(r.present, true);
    assert.equal(r.ok, false);
});

test('evaluateProbe accepts any version of a tool with no minimum', () => {
    assert.equal(P.evaluateProbe('rclone', 'rclone v1.50.0').ok, true);
    assert.equal(P.evaluateProbe('rear', 'Relax-and-Recover 2.6 / 2020-06-17').ok, true);
});

test('evaluateProbe treats unreadable output as present but not ok when a minimum exists', () => {
    const r = P.evaluateProbe('restic', '');
    assert.equal(r.present, true);
    assert.equal(r.version, null);
    assert.equal(r.ok, false);
});

test('evaluateProbe throws a typed error for an unknown tool', () => {
    assertGeneric(() => P.evaluateProbe('borg', 'borg 1.4.4'));
});

test('missingFrom lists absent and too-old tools in install order', () => {
    const results = [
        { tool: 'rear', present: false, ok: false },
        { tool: 'rclone', present: true, ok: true },
        { tool: 'restic', present: true, ok: false },
        { tool: 'fuse3', present: true, ok: true }
    ];
    assert.deepEqual(P.missingFrom(results), ['restic', 'rear']);
});

test('missingFrom ignores unknown tools and non-array input', () => {
    assert.deepEqual(P.missingFrom([{ tool: 'borg', present: false, ok: false }, null]), []);
    assert.deepEqual(P.missingFrom(null), []);
});

test('missingFrom output feeds planFor directly', () => {
    const missing = P.missingFrom([{ tool: 'restic', present: false, ok: false }]);
    assert.deepEqual(P.planFor(missing, 'rhel').map((s) => s.fallback), ['binary']);
});

// ---------------------------------------------------------------- PackageKit

test('resolveFilter asks for the newest build of this architecture, not sources', () => {
    const f = P.resolveFilter();
    assert.equal(f & P.PK.FILTER_ARCH, P.PK.FILTER_ARCH);
    assert.equal(f & P.PK.FILTER_NEWEST, P.PK.FILTER_NEWEST);
    assert.equal(f & P.PK.FILTER_NOT_SOURCE, P.PK.FILTER_NOT_SOURCE);
    assert.equal(f & P.PK.FILTER_INSTALLED, 0);
});

test('classifyPackageKitError maps a full disk to NO_SPACE', () => {
    const e = P.classifyPackageKitError(6, 'No space left on device while downloading restic');
    assert.equal(e.kind, Errors.KIND.NO_SPACE);
    assert.equal(e.remediation, 'free-space');
});

test('classifyPackageKitError maps a repository failure to NETWORK', () => {
    const e = P.classifyPackageKitError(4, 'Could not resolve host: download.fedoraproject.org');
    assert.equal(e.kind, Errors.KIND.NETWORK);
    assert.equal(e.remediation, 'retry');
});

test('classifyPackageKitError maps a cancelled transaction to the non-fatal CANCELLED', () => {
    const e = P.classifyPackageKitError(3, 'The transaction was cancelled by the user');
    assert.equal(e.kind, Errors.KIND.CANCELLED);
    assert.equal(Errors.isFatal(e), false);
});

test('classifyPackageKitError falls back to GENERIC and keeps the raw code', () => {
    const e = P.classifyPackageKitError(9, 'Package restic is already installed');
    assert.equal(e.kind, Errors.KIND.GENERIC);
    assert.deepEqual(e.detail, { code: 9 });
});

test('classifyPackageKitError still produces a message with no detail text', () => {
    const e = P.classifyPackageKitError(undefined, null);
    assert.equal(e.kind, Errors.KIND.GENERIC);
    assert.ok(e.message.length > 0);
});

// ---------------------------------------------------------------- impure layer under node

test('the module loads and stays usable with no cockpit in scope', () => {
    assert.equal(typeof cockpit, 'undefined');
    assert.equal(typeof P.probe, 'function');
});

test('probe reports a tool as absent rather than throwing when cockpit is missing', async () => {
    const r = await P.probe('restic');
    assert.equal(r.present, false);
    assert.equal(r.ok, false);
    assert.equal(r.binary, 'restic');
});

test('probe rejects an unknown tool with a typed error', async () => {
    await assert.rejects(P.probe('borg'), (e) => {
        assert.equal(e.kind, Errors.KIND.GENERIC);
        return true;
    });
});

test('probeAll defaults to every requirement and drops unknown names', async () => {
    assert.deepEqual((await P.probeAll()).map((r) => r.tool), P.TOOLS);
    assert.deepEqual((await P.probeAll(['rclone', 'borg'])).map((r) => r.tool), ['rclone']);
});

test('detectFamilyLive answers unknown instead of throwing without cockpit', async () => {
    assert.equal(await P.detectFamilyLive(), 'unknown');
});

test('resolvePackages and installPackages short-circuit on an empty list', async () => {
    assert.deepEqual(await P.resolvePackages([]), []);
    assert.deepEqual(await P.installPackages([]), []);
    assert.deepEqual(await P.resolvePackages(null), []);
});

test('resolvePackages rejects with a typed error when cockpit is missing', async () => {
    await assert.rejects(P.resolvePackages(['restic']), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.equal(e.kind, Errors.KIND.GENERIC);
        return true;
    });
});

test('installStep refuses a step that is not a package-manager step', async () => {
    const step = P.planFor(['rear'], 'arch')[0];
    await assert.rejects(P.installStep(step), (e) => {
        assert.equal(e.kind, Errors.KIND.GENERIC);
        return true;
    });
});

// ================================================================ hostile input
//
// Everything from here down attacks the module. The contract is narrow: a pure
// function either answers or throws a HangarError. An untyped TypeError out of a
// table lookup reaches the UI as "something went wrong" with no remediation,
// which is the single outcome core/errors.js exists to prevent.

// Values chosen for the ways they break naive code: prototype member names that
// a bare `TABLE[key]` resolves to a function, control characters, path and shell
// metacharacters, and objects String() itself refuses to render.
const HOSTILE = [
    null, undefined, '', ' ', '\n', '\u0000', 0, -1, 1.5, NaN, Infinity, true, false,
    [], {}, [[]], [null], { tool: {} }, Object.create(null), Symbol('hostile'),
    function () { return 'restic'; }, new Date(0), /restic/,
    'constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'prototype',
    '../../../etc/passwd', '/etc/hangar/../../etc/shadow', '$(rm -rf /)', '; rm -rf /',
    '`id`', 'a|b', 'a && b', "a'b\"c", 'a\nb', 'a\u0000b', 'a\tb',
    'ünïcödé', 'ロケール', '🙂', 'x'.repeat(20000)
];

function label(v) {
    if (typeof v === 'symbol') return 'Symbol()';
    try { return typeof v + ' ' + JSON.stringify(v); } catch (e) { return typeof v + ' <unrenderable>'; }
}

// Calls fn and insists the outcome is either a value or a HangarError.
function survives(fn, where) {
    try { return { value: fn() }; } catch (e) {
        assert.ok(Errors.isHangarError(e), where + ' threw an untyped ' + e + ' instead of a HangarError');
        return { error: e };
    }
}

test('no pure function throws an untyped exception on hostile input', () => {
    HOSTILE.forEach((h) => {
        const w = ' <- ' + label(h);
        survives(() => P.parseVersion(h), 'parseVersion' + w);
        survives(() => P.formatVersion(h), 'formatVersion' + w);
        survives(() => P.compareVersions(h, '1.0.0'), 'compareVersions(a)' + w);
        survives(() => P.compareVersions('1.0.0', h), 'compareVersions(b)' + w);
        survives(() => P.meetsMinimum(h, '0.17.0'), 'meetsMinimum(found)' + w);
        survives(() => P.meetsMinimum('0.19.1', h), 'meetsMinimum(required)' + w);
        survives(() => P.parseOsRelease(h), 'parseOsRelease' + w);
        survives(() => P.detectFamily(h), 'detectFamily' + w);
        survives(() => P.requirementFor(h), 'requirementFor' + w);
        survives(() => P.packagesFor(h, 'rhel'), 'packagesFor(tool)' + w);
        survives(() => P.packagesFor('restic', h), 'packagesFor(family)' + w);
        survives(() => P.planFor(h, 'rhel'), 'planFor(missing)' + w);
        survives(() => P.planFor(['restic'], h), 'planFor(family)' + w);
        survives(() => P.planFor([h], h), 'planFor(both)' + w);
        survives(() => P.describeStep(h), 'describeStep' + w);
        survives(() => P.normalizeArch(h), 'normalizeArch' + w);
        survives(() => P.binaryFallbackFor(h, '0.19.1', 'x86_64'), 'binaryFallbackFor(tool)' + w);
        survives(() => P.binaryFallbackFor('restic', h, 'x86_64'), 'binaryFallbackFor(version)' + w);
        survives(() => P.binaryFallbackFor('restic', '0.19.1', h), 'binaryFallbackFor(arch)' + w);
        survives(() => P.evaluateProbe(h, 'restic 0.19.1'), 'evaluateProbe(tool)' + w);
        survives(() => P.evaluateProbe('restic', h), 'evaluateProbe(text)' + w);
        survives(() => P.missingFrom(h), 'missingFrom' + w);
        survives(() => P.missingFrom([h]), 'missingFrom([x])' + w);
        survives(() => P.classifyPackageKitError(h, h), 'classifyPackageKitError' + w);
    });
});

test('hostile input never widens a return type', () => {
    HOSTILE.forEach((h) => {
        const w = ' <- ' + label(h);
        const fam = P.detectFamily(h);
        assert.ok(P.FAMILIES.indexOf(fam) >= 0 || fam === 'unknown', 'detectFamily' + w);
        assert.equal(typeof P.parseOsRelease(h), 'object', 'parseOsRelease' + w);
        const arch = P.normalizeArch(h);
        assert.ok(arch === null || typeof arch === 'string', 'normalizeArch' + w);
        assert.ok(Array.isArray(P.planFor(h, 'rhel')), 'planFor' + w);
        assert.ok(Array.isArray(P.missingFrom(h)), 'missingFrom' + w);
        assert.equal(typeof P.describeStep(h), 'string', 'describeStep' + w);
        assert.ok(Errors.isHangarError(P.classifyPackageKitError(h, h)), 'classifyPackageKitError' + w);
    });
});

test('a prototype member name is not a tool, a family or an architecture', () => {
    // A bare `TABLE[key]` resolves "constructor" to Object.prototype's, which is
    // truthy — so the guard has to be an own-property check, everywhere.
    ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'prototype'].forEach((name) => {
        assertGeneric(() => P.requirementFor(name));
        assertGeneric(() => P.evaluateProbe(name, 'x 1.0'));
        assertGeneric(() => P.binaryFallbackFor(name, '1.0.0', 'x86_64'));
        assert.equal(P.normalizeArch(name), null, name);
        assert.equal(P.detectFamily({ ID: name }), 'unknown', name);
        assert.equal(P.detectFamily({ ID: 'zz', ID_LIKE: name }), 'unknown', name);
        assert.deepEqual(P.planFor([name], 'rhel'), [], name);
        assert.deepEqual(P.missingFrom([{ tool: name, present: false, ok: false }]), [], name);
        assert.deepEqual(P.packagesFor('restic', name), [], name);
    });
});

// ---------------------------------------------------------------- parseVersion

test('parseVersion is unmoved by shell metacharacters and NUL bytes', () => {
    assert.deepEqual(P.parseVersion('restic 0.19.1; rm -rf /'), { major: 0, minor: 19, patch: 1 });
    assert.deepEqual(P.parseVersion('restic 0.19.1\u0000extra'), { major: 0, minor: 19, patch: 1 });
    assert.deepEqual(P.parseVersion('restic $(id) 0.19.1'), { major: 0, minor: 19, patch: 1 });
});

test('parseVersion ignores components past the patch level', () => {
    assert.deepEqual(P.parseVersion('1.2.3.4'), { major: 1, minor: 2, patch: 3 });
    assert.deepEqual(P.parseVersion('restic 0.19.1+deb12u1'), { major: 0, minor: 19, patch: 1 });
});

test('parseVersion only reads ASCII digits', () => {
    // Arabic-Indic digits are digits to a human; restic never prints them and
    // \d must not accept them either.
    assert.equal(P.parseVersion('restic ٠.١٩.١'), null);
});

test('parseVersion finds the version at the end of a very long banner', () => {
    assert.deepEqual(P.parseVersion('warning: '.repeat(20000) + 'restic 0.19.1'),
        { major: 0, minor: 19, patch: 1 });
});

test('parseVersion accepts non-strings without throwing', () => {
    assert.deepEqual(P.parseVersion(19), { major: 19, minor: 0, patch: 0 });
    assert.equal(P.parseVersion({}), null);
    assert.equal(P.parseVersion([]), null);
    // String() itself throws on this one. The module must not.
    assert.equal(P.parseVersion(Object.create(null)), null);
});

// ---------------------------------------------------------------- version algebra

test('formatVersion does not wrap a version larger than 2^31', () => {
    // `n | 0` used to turn this into a negative version, which would then have
    // gone straight into a release-download URL.
    assert.equal(P.formatVersion({ major: 2147483648, minor: 0, patch: 0 }), '2147483648.0.0');
    assert.equal(P.formatVersion(P.parseVersion('2147483648')), P.formatVersion('2147483648'));
});

test('formatVersion fills in the components a parsed object is missing', () => {
    assert.equal(P.formatVersion({ major: 2 }), '2.0.0');
    assert.equal(P.formatVersion({ major: 2, minor: 7 }), '2.7.0');
});

test('formatVersion truncates a fractional component', () => {
    assert.equal(P.formatVersion({ major: 1.9, minor: 2.5, patch: 3.5 }), '1.2.3');
});

test('formatVersion rejects components that are not version numbers', () => {
    assertGeneric(() => P.formatVersion({ major: NaN }));
    assertGeneric(() => P.formatVersion({ major: Infinity }));
    assertGeneric(() => P.formatVersion({ major: -1 }));
    assertGeneric(() => P.formatVersion({ major: 1, minor: 'two' }));
});

test('compareVersions gives the same answer for a banner and for its parsed form', () => {
    [['restic 0.19.1', 'restic 0.17.0'], ['1.0.0', '1.0.1'], ['2.7', '2.7.0'],
        ['2147483648', '2147483647']].forEach(([a, b]) => {
        assert.equal(P.compareVersions(a, b),
            P.compareVersions(P.parseVersion(a), P.parseVersion(b)), a + ' vs ' + b);
    });
});

test('compareVersions is antisymmetric', () => {
    [['0.19.1', '0.17.0'], ['0.17.0', '0.19.1'], ['1.2.3', '1.2.3'], ['1.0.0', '0.99.99']].forEach(([a, b]) => {
        assert.equal(P.compareVersions(a, b) + P.compareVersions(b, a), 0, a + ' vs ' + b);
    });
});

test('compareVersions refuses NaN and Infinity instead of reading them as zero', () => {
    assertGeneric(() => P.compareVersions({ major: NaN }, '0.0.0'));
    assertGeneric(() => P.compareVersions({ major: Infinity }, '9.9.9'));
    assertGeneric(() => P.compareVersions(null, '1.0.0'));
    assertGeneric(() => P.compareVersions(undefined, '1.0.0'));
});

test('meetsMinimum treats an unreadable minimum as no minimum', () => {
    // The minimum comes from the REQUIREMENTS table, so garbage there means the
    // tool declares none — not that every version on earth fails.
    assert.equal(P.meetsMinimum('0.19.1', 'garbage'), true);
    assert.equal(P.meetsMinimum('0.19.1', undefined), true);
});

test('meetsMinimum compares a parsed object against the declared floor', () => {
    assert.equal(P.meetsMinimum({ major: 0, minor: 17, patch: 0 }, '0.17.0'), true);
    assert.equal(P.meetsMinimum({ major: 0, minor: 16, patch: 999 }, '0.17.0'), false);
});

// ---------------------------------------------------------------- parseOsRelease

test('parseOsRelease keeps the last value when a key repeats', () => {
    assert.equal(P.parseOsRelease('ID=debian\nID=ubuntu\n').ID, 'ubuntu');
});

test('parseOsRelease keeps an = inside the value', () => {
    assert.equal(P.parseOsRelease('CPE_NAME="cpe:/o:redhat:enterprise_linux:10::baseos"').CPE_NAME,
        'cpe:/o:redhat:enterprise_linux:10::baseos');
    assert.equal(P.parseOsRelease('X=a=b').X, 'a=b');
});

test('parseOsRelease accepts an empty value and whitespace around the =', () => {
    assert.deepEqual(P.parseOsRelease('ID=\n'), { ID: '' });
    assert.equal(P.parseOsRelease('ID = fedora\n').ID, 'fedora');
});

test('parseOsRelease drops keys that are not shell-safe names', () => {
    assert.deepEqual(P.parseOsRelease('2FOO=x\nA-B=y\nA B=z\nID=arch\n'), { ID: 'arch' });
});

test('parseOsRelease leaves an unterminated quote alone rather than guessing', () => {
    assert.equal(P.parseOsRelease('ID="rhel\n').ID, '"rhel');
    assert.equal(P.detectFamily('ID="rhel\n'), 'unknown');
});

test('parseOsRelease does not pollute Object.prototype', () => {
    const before = ({}).polluted;
    const out = P.parseOsRelease('__proto__=polluted\nID=debian\n');
    assert.equal(({}).polluted, before);
    assert.deepEqual(Object.keys(out), ['ID']);
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
});

test('parseOsRelease passes unicode and control characters through verbatim', () => {
    const f = P.parseOsRelease('PRETTY_NAME="Ünïcödé 🙂"\nX=a\u0000b\n');
    assert.equal(f.PRETTY_NAME, 'Ünïcödé 🙂');
    assert.equal(f.X, 'a\u0000b');
});

test('parseOsRelease survives a comment-only file and a very large one', () => {
    assert.deepEqual(P.parseOsRelease('#\n# comment\n   \n\t\n'), {});
    const big = 'NOISE=' + 'x'.repeat(50000) + '\n' + 'PAD=1\n'.repeat(5000) + 'ID=sles\n';
    assert.equal(P.detectFamily(big), 'suse');
});

test('parseOsRelease accepts non-string input', () => {
    assert.deepEqual(P.parseOsRelease(42), {});
    assert.deepEqual(P.parseOsRelease([]), {});
    assert.deepEqual(P.parseOsRelease(Object.create(null)), {});
});

// ---------------------------------------------------------------- detectFamily

test('detectFamily prefers rhel, then suse, then debian, then arch, over fedora', () => {
    // The priority exists so a rebuild listing several ID_LIKE tokens is planned
    // as the family whose packaging constraints are strictest.
    assert.equal(P.detectFamily('ID=x\nID_LIKE="fedora rhel"\n'), 'rhel');
    assert.equal(P.detectFamily('ID=x\nID_LIKE="debian suse"\n'), 'suse');
    assert.equal(P.detectFamily('ID=x\nID_LIKE="arch debian"\n'), 'debian');
    assert.equal(P.detectFamily('ID=x\nID_LIKE="fedora arch"\n'), 'arch');
});

test('detectFamily splits ID_LIKE on any run of whitespace', () => {
    assert.equal(P.detectFamily('ID=x\nID_LIKE="  \tubuntu   debian  "\n'), 'debian');
});

test('detectFamily is case-insensitive about ID_LIKE too', () => {
    assert.equal(P.detectFamily({ ID: 'x', ID_LIKE: 'RHEL Fedora' }), 'rhel');
});

test('detectFamily ignores ID_LIKE once ID is recognised', () => {
    assert.equal(P.detectFamily({ ID: 'fedora', ID_LIKE: 'rhel' }), 'fedora');
});

test('detectFamily answers unknown for an empty ID and for non-object input', () => {
    assert.equal(P.detectFamily('ID=\n'), 'unknown');
    assert.equal(P.detectFamily(42), 'unknown');
    assert.equal(P.detectFamily([]), 'unknown');
    assert.equal(P.detectFamily({ ID: Object.create(null) }), 'unknown');
});

test('detectFamily only ever returns something planFor understands', () => {
    ['ID=rhel', 'ID=fedora', 'ID=debian', 'ID=opensuse-leap', 'ID=arch', 'ID=plan9', ''].forEach((text) => {
        const fam = P.detectFamily(text);
        assert.ok(P.FAMILIES.indexOf(fam) >= 0 || fam === 'unknown', text);
        assert.doesNotThrow(() => P.planFor(['restic'], fam));
    });
});

// ---------------------------------------------------------------- table integrity

test('every requirement is self-consistent', () => {
    P.TOOLS.forEach((t) => {
        const req = P.REQUIREMENTS[t];
        assert.equal(req.tool, t, t + ' disagrees with its key');
        assert.ok(req.binary && typeof req.binary === 'string', t + ' has no binary');
        assert.ok(Array.isArray(req.versionArgs) && req.versionArgs.length, t + ' has no version args');
        assert.ok(req.reason && req.reason.length > 10, t + ' has no reason to show the user');
        assert.ok(req.minVersion === null || P.parseVersion(req.minVersion), t + ' has an unparseable minimum');
    });
});

test('no package name carries anything a package manager could misread', () => {
    P.TOOLS.forEach((t) => {
        P.FAMILIES.forEach((fam) => {
            P.REQUIREMENTS[t].packages[fam].forEach((name) => {
                assert.match(name, /^[a-z0-9][a-z0-9._+-]*$/, t + '/' + fam + ': ' + name);
            });
        });
    });
});

test('EPEL_ONLY only names tools that have a static-binary way out', () => {
    Object.keys(P.EPEL_ONLY).forEach((fam) => {
        assert.ok(P.FAMILIES.indexOf(fam) >= 0, fam);
        P.EPEL_ONLY[fam].forEach((tool) => {
            assert.ok(P.REQUIREMENTS[tool], tool);
            assert.ok(P.BINARY_RELEASE[tool], tool + ' is EPEL-gated with no fallback');
        });
    });
});

test('the recommended fallback versions satisfy the declared minimums', () => {
    Object.keys(P.RECOMMENDED_VERSION).forEach((tool) => {
        assert.ok(P.BINARY_RELEASE[tool], tool);
        assert.equal(P.meetsMinimum(P.RECOMMENDED_VERSION[tool], P.REQUIREMENTS[tool].minVersion), true, tool);
    });
});

// ---------------------------------------------------------------- planFor

test('planFor never throws and always yields a known method, for every family', () => {
    P.FAMILIES.concat(['unknown', '']).forEach((fam) => {
        const plan = P.planFor(P.TOOLS, fam);
        assert.equal(plan.length, P.TOOLS.length, fam);
        plan.forEach((step) => {
            assert.ok([P.METHOD.PACKAGEKIT, P.METHOD.BINARY, P.METHOD.UNAVAILABLE].indexOf(step.method) >= 0,
                fam + '/' + step.tool);
            assert.ok(Array.isArray(step.packages), fam + '/' + step.tool);
            assert.equal(typeof step.reason, 'string');
            assert.ok(step.fallback === null || step.fallback === P.METHOD.BINARY);
        });
    });
});

test('only restic on RHEL carries a fallback, because only it is EPEL-gated', () => {
    P.FAMILIES.forEach((fam) => {
        P.planFor(P.TOOLS, fam).forEach((step) => {
            const expected = (fam === 'rhel' && step.tool === 'restic') ? P.METHOD.BINARY : null;
            assert.equal(step.fallback, expected, fam + '/' + step.tool);
        });
    });
});

test('a step owns its package list, so the UI cannot edit the table through it', () => {
    const step = P.planFor(['restic'], 'debian')[0];
    step.packages.push('evil');
    assert.deepEqual(P.planFor(['restic'], 'debian')[0].packages, ['restic']);
    assert.deepEqual(P.REQUIREMENTS.restic.packages.debian, ['restic']);
});

test('planFor collapses any number of duplicates into one step per tool', () => {
    const many = [];
    for (let i = 0; i < 500; i++) many.push('restic', 'rclone');
    assert.deepEqual(P.planFor(many, 'fedora').map((s) => s.tool), ['restic', 'rclone']);
});

test('planFor treats an unusable family exactly like an unknown one', () => {
    ['martian', '', null, undefined, 42, ['martian'], {}].forEach((fam) => {
        assert.deepEqual(P.planFor(['restic'], fam).map((s) => s.method), ['binary'], String(fam));
    });
    // A family only has to name itself, however it is wrapped.
    assert.equal(P.planFor(['restic'], ['rhel'])[0].method, 'packagekit');
});

test('planFor accepts probe results with extra fields, and objects with no tool', () => {
    const results = [{ tool: 'restic', present: false, ok: false, raw: '', version: null }];
    assert.deepEqual(P.planFor(results, 'debian').map((s) => s.tool), ['restic']);
    assert.deepEqual(P.planFor([{ present: false }], 'debian'), []);
});

// ---------------------------------------------------------------- describeStep

test('describeStep tolerates a malformed step instead of throwing', () => {
    // packages arriving as a bare string used to reach String.prototype.join.
    assert.equal(typeof P.describeStep({ tool: 'restic', method: 'packagekit', packages: 'restic' }), 'string');
    assert.equal(typeof P.describeStep({ tool: 'restic', method: 'packagekit' }), 'string');
    assert.equal(P.describeStep('restic'), 'Nothing to install.');
    assert.equal(P.describeStep(undefined), 'Nothing to install.');
    assert.equal(P.describeStep(0), 'Nothing to install.');
});

test('describeStep produces one finished sentence for every step of every plan', () => {
    P.FAMILIES.concat(['unknown']).forEach((fam) => {
        P.planFor(P.TOOLS, fam).forEach((step) => {
            const text = P.describeStep(step);
            assert.ok(text.length > 20, fam + '/' + step.tool);
            assert.match(text, /\.$/, fam + '/' + step.tool);
        });
    });
});

test('describeStep names the tool when only a static binary is left', () => {
    assert.match(P.describeStep(P.planFor(['rclone'], 'unknown')[0]), /rclone/);
    assert.match(P.describeStep(P.planFor(['rear'], 'arch')[0]), /rear/);
});

// ---------------------------------------------------------------- normalizeArch

test('normalizeArch maps every alias onto an asset name restic actually publishes', () => {
    ['x86_64', 'amd64', 'x64', 'aarch64', 'arm64', 'armv7l', 'armv6l', 'armhf', 'arm',
        'i386', 'i686', 'x86', '386', 'ppc64le', 'ppc64el', 's390x', 'riscv64'].forEach((a) => {
        const norm = P.normalizeArch(a);
        assert.ok(norm, a);
        assert.ok(P.BINARY_RELEASE.restic.arch[norm], a + ' normalises to an arch restic does not publish');
    });
});

test('normalizeArch refuses padding it cannot trim', () => {
    assert.equal(P.normalizeArch('x86_64\u0000'), null);
    assert.equal(P.normalizeArch('x86_64; rm -rf /'), null);
    assert.equal(P.normalizeArch('x86_64\nx86_64'), null);
    assert.equal(P.normalizeArch(64), null);
    assert.equal(P.normalizeArch(undefined), null);
});

// ---------------------------------------------------------------- binaryFallbackFor

test('binaryFallbackFor emits only github release URLs, whatever it is handed', () => {
    // The version reaches a URL, so it is rebuilt from parsed integers rather
    // than pasted: a traversal or a shell fragment cannot survive that.
    ['1.2.3/../../evil', '1.2.3; rm -rf /', '1.2.3\n0.0.0', 'v1.2.3-rc1', '1.2.3\u0000'].forEach((v) => {
        const out = P.binaryFallbackFor('restic', v, 'x86_64');
        assert.equal(out.version, '1.2.3', JSON.stringify(v));
        [out.url, out.sha256Url, out.sigUrl].forEach((u) => {
            assert.ok(u.startsWith('https://github.com/restic/restic/releases/download/'), u);
            assert.doesNotMatch(u, /\.\./, u);
            assert.match(u, /^[\x21-\x7e]+$/, u);   // printable ASCII, no space and no control bytes
            assert.doesNotMatch(u, /[;&|$'"<>\\]/, u);
        });
    });
});

test('binaryFallbackFor covers every architecture each project actually publishes', () => {
    Object.keys(P.BINARY_RELEASE).forEach((tool) => {
        Object.keys(P.BINARY_RELEASE[tool].arch).forEach((norm) => {
            const out = P.binaryFallbackFor(tool, null, norm);
            assert.equal(out.arch, norm, tool + '/' + norm);
            assert.ok(out.url.indexOf(P.BINARY_RELEASE[tool].arch[norm]) > 0, out.url);
            assert.equal(out.version, P.RECOMMENDED_VERSION[tool]);
        });
    });
});

test('binaryFallbackFor uses rclone\'s arm-v7 asset name for a 32-bit arm host', () => {
    assert.match(P.binaryFallbackFor('rclone', '1.74.3', 'armv7l').url, /rclone-v1\.74\.3-linux-arm-v7\.zip$/);
});

test('binaryFallbackFor falls back to the verified version for empty and undefined', () => {
    ['', null, undefined].forEach((v) => {
        assert.equal(P.binaryFallbackFor('rclone', v, 'x86_64').version, P.RECOMMENDED_VERSION.rclone, String(v));
    });
});

test('binaryFallbackFor refuses a version that is not a version', () => {
    ['latest', 'HEAD', 'v', ' ', '..', 'main'].forEach((v) => {
        assertGeneric(() => P.binaryFallbackFor('restic', v, 'x86_64'));
    });
    assertGeneric(() => P.binaryFallbackFor('restic', { major: -1 }, 'x86_64'));
});

test('binaryFallbackFor refuses a missing architecture rather than assuming amd64', () => {
    [null, undefined, '', 'x86_64_v2', 'linux/amd64'].forEach((a) => {
        assertGeneric(() => P.binaryFallbackFor('restic', '0.19.1', a));
    });
});

test('binaryFallbackFor refuses unknown tools with a typed error, not a TypeError', () => {
    [null, undefined, 'borg', 'constructor', 'restic ', 'RESTIC'].forEach((t) => {
        assertGeneric(() => P.binaryFallbackFor(t, '1.0.0', 'x86_64'));
    });
});

// ---------------------------------------------------------------- probe helpers

test('evaluateProbe normalises whitespace and survives hostile banners', () => {
    assert.equal(P.evaluateProbe('restic', '\n\t restic 0.19.1 \n').raw, 'restic 0.19.1');
    assert.equal(P.evaluateProbe('restic', 12345).raw, '12345');
    assert.equal(P.evaluateProbe('restic', null).present, true);
    assert.equal(P.evaluateProbe('rclone', 'x'.repeat(50000)).ok, true);
});

test('evaluateProbe puts the boundary exactly at the declared minimum', () => {
    assert.equal(P.evaluateProbe('restic', 'restic 0.17.0').ok, true);
    assert.equal(P.evaluateProbe('restic', 'restic 0.16.999').ok, false);
    assert.equal(P.evaluateProbe('restic', 'restic 1.0.0').ok, true);
});

test('evaluateProbe reports a tool it cannot version as present but not ok', () => {
    const r = P.evaluateProbe('restic', 'restic: command not found');
    assert.equal(r.present, true);
    assert.equal(r.version, null);
    assert.equal(r.ok, false);
    // fuse3 declares no minimum, so the same unreadable banner is acceptable.
    assert.equal(P.evaluateProbe('fuse3', 'garbage').ok, true);
});

test('missingFrom de-duplicates and ignores entries that are not probe results', () => {
    assert.deepEqual(P.missingFrom([
        { tool: 'restic', present: false, ok: false },
        { tool: 'restic', present: true, ok: false }
    ]), ['restic']);
    assert.deepEqual(P.missingFrom(['restic', 42, undefined, [], {}]), []);
});

test('missingFrom treats a result with no ok field as not ok', () => {
    assert.deepEqual(P.missingFrom([{ tool: 'rclone', present: true }]), ['rclone']);
});

test('missingFrom returns nothing when every tool is present and current', () => {
    const results = P.TOOLS.map((t) => ({ tool: t, present: true, ok: true }));
    assert.deepEqual(P.missingFrom(results), []);
    assert.deepEqual(P.planFor(P.missingFrom(results), 'rhel'), []);
});

// ---------------------------------------------------------------- PackageKit constants

test('the PackageKit filter bits are distinct single bits', () => {
    const bits = [P.PK.FILTER_INSTALLED, P.PK.FILTER_NOT_INSTALLED, P.PK.FILTER_NEWEST,
        P.PK.FILTER_ARCH, P.PK.FILTER_NOT_SOURCE];
    bits.forEach((b) => assert.equal(b & (b - 1), 0, String(b)));
    assert.equal(new Set(bits).size, bits.length);
});

test('resolveFilter does not restrict the answer by installed state', () => {
    const f = P.resolveFilter();
    assert.equal(f & P.PK.FILTER_INSTALLED, 0);
    assert.equal(f & P.PK.FILTER_NOT_INSTALLED, 0);
    assert.equal(f, P.PK.FILTER_ARCH | P.PK.FILTER_NEWEST | P.PK.FILTER_NOT_SOURCE);
});

// ---------------------------------------------------------------- classifyPackageKitError

test('a cancellation stays a cancellation even when it mentions downloading', () => {
    // PackageKit names the phase it was cancelled in; the network pattern used to
    // claim that message and turn a deliberate stop into a fatal Retry.
    const e = P.classifyPackageKitError(3, 'Cancelled while downloading restic');
    assert.equal(e.kind, Errors.KIND.CANCELLED);
    assert.equal(Errors.isFatal(e), false);
    assert.equal(P.classifyPackageKitError(3, 'The transaction was canceled').kind, Errors.KIND.CANCELLED);
});

test('a full disk outranks every other wording', () => {
    assert.equal(P.classifyPackageKitError(6, 'Download failed: not enough space on /var').kind,
        Errors.KIND.NO_SPACE);
    ['disk full', 'out of disk space', 'No space left on device'].forEach((t) => {
        assert.equal(P.classifyPackageKitError(6, t).kind, Errors.KIND.NO_SPACE, t);
    });
});

test('the network kind covers the wordings a repository failure actually uses', () => {
    ['Could not resolve host: mirror.example', 'Connection refused', 'The download timed out',
        'Temporary failure in name resolution', 'network unreachable'].forEach((t) => {
        assert.equal(P.classifyPackageKitError(4, t).kind, Errors.KIND.NETWORK, t);
    });
});

test('classifyPackageKitError always returns a typed error with a message and the raw code', () => {
    [[1, 'Package not found'], [undefined, undefined], [0, ''], [null, null],
        [7, 42], [8, { toString() { return 'objected'; } }]].forEach(([code, text]) => {
        const e = P.classifyPackageKitError(code, text);
        assert.ok(Errors.isHangarError(e), String(text));
        assert.ok(e.message.length > 0, String(text));
        assert.equal(e.detail.code, code === undefined ? null : code);
    });
    assert.deepEqual(P.classifyPackageKitError(0, 'x').detail, { code: 0 });
});

// ================================================================ the D-Bus half
//
// The module resolves `cockpit` at call time, so a stub on the global is enough
// to drive the PackageKit transaction loop under node. Every test that installs
// one removes it again, because the tests above assert it is absent.

function pkStub(script) {
    const state = { calls: [], clients: [] };
    const plans = Object.assign({ CreateTransaction: { reply: ['/tx/1'] } }, script || {});
    state.cockpit = {
        dbus: function (service, opts) {
            const subs = [];
            const client = {
                service: service, opts: opts, subs: subs, closed: 0,
                subscribe: function (match, handler) {
                    const s = { match: match, handler: handler, removed: false };
                    s.remove = function () { s.removed = true; };
                    subs.push(s);
                    return s;
                },
                close: function () { client.closed += 1; },
                call: function (path, iface, method, args) {
                    state.calls.push({ path: path, iface: iface, method: method, args: args });
                    const plan = plans[method];
                    if (!plan) return Promise.reject(new Error('unscripted method ' + method));
                    // The real bus delivers signals after the method returns.
                    if (method !== 'CreateTransaction')
                        setTimeout(function () {
                            (plan.signals || []).forEach(function (sig) {
                                subs.forEach(function (s) {
                                    if (s.removed || s.match.member !== sig.member) return;
                                    s.handler(s.match.path, s.match.interface, sig.member, sig.args);
                                });
                            });
                        }, 0);
                    return plan.reject ? Promise.reject(plan.reject) : Promise.resolve(plan.reply || []);
                }
            };
            state.clients.push(client);
            return client;
        }
    };
    return state;
}

async function withCockpit(stub, fn) {
    globalThis.cockpit = stub;
    try { return await fn(); } finally { delete globalThis.cockpit; }
}

const FINISHED_SUCCESS = { member: 'Finished', args: [1, 100] };
function pkg(id) { return { member: 'Package', args: [1, id, 'summary of ' + id] }; }

test('resolvePackages asks PackageKit as root and returns what it named', async () => {
    const pk = pkStub({ Resolve: { signals: [pkg('restic;0.19.1;x86_64;epel'), FINISHED_SUCCESS] } });
    await withCockpit(pk.cockpit, async () => {
        assert.deepEqual(await P.resolvePackages(['restic', '', 5]), [{
            info: 1, packageId: 'restic;0.19.1;x86_64;epel', summary: 'summary of restic;0.19.1;x86_64;epel'
        }]);
    });
    assert.equal(pk.clients[0].service, P.PK.SERVICE);
    assert.equal(pk.clients[0].opts.superuser, 'require');
    // Empty names are dropped, and a number is stringified before it is sent.
    assert.deepEqual(pk.calls[1], {
        path: '/tx/1', iface: P.PK.TX_IFACE, method: 'Resolve',
        args: [P.resolveFilter(), ['restic', '5']]
    });
});

test('a finished transaction unsubscribes and closes its D-Bus client', async () => {
    const pk = pkStub({ Resolve: { signals: [FINISHED_SUCCESS] } });
    await withCockpit(pk.cockpit, () => P.resolvePackages(['restic']));
    assert.equal(pk.clients[0].closed, 1);
    assert.equal(pk.clients[0].subs.length, 3);
    pk.clients[0].subs.forEach((s) => assert.equal(s.removed, true));
});

test('signals arriving after Finished cannot change the outcome', async () => {
    const pk = pkStub({ Resolve: { signals: [
        pkg('restic;0.19.1;x86_64;epel'), FINISHED_SUCCESS,
        pkg('late;1;x86_64;epel'), { member: 'Finished', args: [4] }
    ] } });
    await withCockpit(pk.cockpit, async () => {
        const found = await P.resolvePackages(['restic']);
        assert.deepEqual(found.map((p) => p.packageId), ['restic;0.19.1;x86_64;epel']);
    });
});

test('an ErrorCode before Finished is what the caller is rejected with', async () => {
    const pk = pkStub({ Resolve: { signals: [
        { member: 'ErrorCode', args: [6, 'No space left on device'] },
        { member: 'Finished', args: [4] }
    ] } });
    await withCockpit(pk.cockpit, async () => {
        await assert.rejects(P.resolvePackages(['restic']), (e) => {
            assert.equal(e.kind, Errors.KIND.NO_SPACE);
            assert.equal(e.remediation, 'free-space');
            return true;
        });
    });
});

test('a cancelled transaction rejects non-fatally even with no ErrorCode', async () => {
    const pk = pkStub({ Resolve: { signals: [{ member: 'Finished', args: [P.PK.EXIT_CANCELLED] }] } });
    await withCockpit(pk.cockpit, async () => {
        await assert.rejects(P.resolvePackages(['restic']), (e) => {
            assert.equal(e.kind, Errors.KIND.CANCELLED);
            assert.equal(Errors.isFatal(e), false);
            assert.deepEqual(e.detail, { exit: P.PK.EXIT_CANCELLED });
            return true;
        });
    });
});

test('a failed transaction with no ErrorCode still rejects typed, keeping the exit enum', async () => {
    const pk = pkStub({ Resolve: { signals: [{ member: 'Finished', args: [4] }] } });
    await withCockpit(pk.cockpit, async () => {
        await assert.rejects(P.resolvePackages(['restic']), (e) => {
            assert.ok(Errors.isHangarError(e));
            assert.equal(e.kind, Errors.KIND.GENERIC);
            assert.deepEqual(e.detail, { exit: 4 });
            return true;
        });
    });
});

test('a D-Bus method that refuses the request becomes a typed error', async () => {
    const pk = pkStub({ Resolve: { reject: new Error('org.freedesktop.DBus.Error.AccessDenied') } });
    await withCockpit(pk.cockpit, async () => {
        await assert.rejects(P.resolvePackages(['restic']), (e) => {
            assert.ok(Errors.isHangarError(e));
            assert.equal(e.message, 'org.freedesktop.DBus.Error.AccessDenied');
            assert.deepEqual(e.detail, { method: 'Resolve' });
            return true;
        });
    });
});

test('a PolicyKit refusal on CreateTransaction is typed, not a raw D-Bus object', async () => {
    // The likeliest failure of the whole flow: the admin dismisses the
    // authentication dialog. It used to escape as whatever cockpit threw.
    const pk = pkStub({ CreateTransaction: { reject: { problem: 'access-denied', message: 'Not authorized' } } });
    await withCockpit(pk.cockpit, async () => {
        await assert.rejects(P.installPackages(['restic;0.19.1;x86_64;epel']), (e) => {
            assert.ok(Errors.isHangarError(e), 'expected a HangarError, got ' + JSON.stringify(e));
            assert.equal(e.kind, Errors.KIND.GENERIC);
            assert.equal(e.message, 'Not authorized');
            assert.deepEqual(e.detail, { method: 'InstallPackages' });
            return true;
        });
    });
    assert.equal(pk.clients[0].closed, 1);
});

test('a transaction id that never arrives fails instead of hanging', async () => {
    // With no transaction path there is nothing to subscribe to, so the promise
    // would never settle and the install would sit at 0% for ever.
    for (const reply of [[], [null], ['']]) {
        const pk = pkStub({ CreateTransaction: { reply: reply }, Resolve: { signals: [FINISHED_SUCCESS] } });
        await withCockpit(pk.cockpit, async () => {
            await assert.rejects(P.resolvePackages(['restic']), (e) => {
                assert.ok(Errors.isHangarError(e));
                assert.equal(e.kind, Errors.KIND.GENERIC);
                assert.match(e.message, /transaction/i);
                return true;
            });
        });
        assert.equal(pk.clients[0].closed, 1, JSON.stringify(reply));
        assert.equal(pk.calls.filter((c) => c.method === 'Resolve').length, 0, JSON.stringify(reply));
    }
});

test('installStep resolves the names, then installs the ids it got back', async () => {
    const pk = pkStub({
        Resolve: { signals: [pkg('restic;0.19.1;x86_64;epel'), pkg('restic;0.19.1;i686;epel'), FINISHED_SUCCESS] },
        InstallPackages: { signals: [FINISHED_SUCCESS] }
    });
    await withCockpit(pk.cockpit, () => P.installStep(P.planFor(['restic'], 'rhel')[0]));
    assert.deepEqual(pk.calls.map((c) => c.method),
        ['CreateTransaction', 'Resolve', 'CreateTransaction', 'InstallPackages']);
    // TRANSACTION_FLAG_NONE: install for real, and only what Resolve named.
    assert.deepEqual(pk.calls[3].args,
        [P.PK.FLAG_NONE, ['restic;0.19.1;x86_64;epel', 'restic;0.19.1;i686;epel']]);
});

test('installStep reports progress from PropertiesChanged', async () => {
    const pk = pkStub({
        Resolve: { signals: [pkg('restic;0.19.1;x86_64;deb'), FINISHED_SUCCESS] },
        InstallPackages: { signals: [
            { member: 'PropertiesChanged', args: [P.PK.TX_IFACE, { Percentage: 42 }, []] },
            FINISHED_SUCCESS
        ] }
    });
    const seen = [];
    await withCockpit(pk.cockpit, () => P.installStep(P.planFor(['restic'], 'debian')[0], (p) => seen.push(p)));
    assert.deepEqual(seen, [{ Percentage: 42 }]);
});

test('installStep offers the static binary when no repository has the package', async () => {
    // The EPEL case: PackageKit resolved nothing and reported no error at all.
    const pk = pkStub({ Resolve: { signals: [FINISHED_SUCCESS] } });
    await withCockpit(pk.cockpit, async () => {
        await assert.rejects(P.installStep(P.planFor(['restic'], 'rhel')[0]), (e) => {
            assert.ok(Errors.isHangarError(e));
            assert.deepEqual(e.detail, { tool: 'restic', fallback: 'binary' });
            assert.match(e.message, /^restic is not available/);
            return true;
        });
    });
    assert.equal(pk.calls.filter((c) => c.method === 'InstallPackages').length, 0);
});

test('installStep ignores resolved packages that carry no package id', async () => {
    const pk = pkStub({ Resolve: { signals: [{ member: 'Package', args: [1, '', 'nameless'] }, FINISHED_SUCCESS] } });
    await withCockpit(pk.cockpit, async () => {
        await assert.rejects(P.installStep(P.planFor(['rclone'], 'debian')[0]), (e) => {
            assert.equal(e.detail.tool, 'rclone');
            assert.equal(e.detail.fallback, null);
            return true;
        });
    });
});

test('installStep refuses every step the package manager cannot act on', async () => {
    const pk = pkStub({});
    await withCockpit(pk.cockpit, async () => {
        const steps = [P.planFor(['restic'], 'unknown')[0], P.planFor(['rear'], 'arch')[0],
            null, undefined, {}, { method: 'packagekit', packages: 'restic' }];
        for (const step of steps) {
            const outcome = await P.installStep(step).then(() => null, (e) => e);
            assert.ok(Errors.isHangarError(outcome), 'expected a HangarError for ' + JSON.stringify(step));
            assert.equal(outcome.kind, Errors.KIND.GENERIC);
        }
    });
    // Nothing reached the bus: a step with no packages never opens a transaction.
    assert.equal(pk.calls.length, 0);
});

test('installPackages rejects with a typed error when cockpit is missing', async () => {
    await assert.rejects(P.installPackages(['restic;0.19.1;x86_64;epel']), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.deepEqual(e.detail, { method: 'InstallPackages' });
        return true;
    });
});

// ---------------------------------------------------------------- probe, live

test('probe runs the requirement\'s own binary with its own version flag', async () => {
    const seen = [];
    const stub = {
        spawn: function (argv, opts) {
            seen.push({ argv: argv, opts: opts });
            return Promise.resolve('restic 0.19.1 compiled with go1.23 on linux/amd64\n');
        }
    };
    const r = await withCockpit(stub, () => P.probe('restic'));
    // Spelled from the table, not hardcoded here: restic's is `restic version`,
    // fuse3's is `fusermount3 --version`, and probe must not assume either.
    assert.deepEqual(seen[0].argv,
        [P.REQUIREMENTS.restic.binary].concat(P.REQUIREMENTS.restic.versionArgs));
    assert.equal(seen[0].argv[0], 'restic');
    assert.equal(seen[0].opts.err, 'message');
    // Reading a version is not privileged, so it must not ask for root.
    assert.equal(seen[0].opts.superuser, undefined);
    assert.deepEqual(r.version, { major: 0, minor: 19, patch: 1 });
    assert.equal(r.ok, true);
});

test('probe calls a tool that is too old present but not ok', async () => {
    const stub = { spawn: () => Promise.resolve('restic 0.16.4 compiled with go1.21') };
    const r = await withCockpit(stub, () => P.probe('restic'));
    assert.equal(r.present, true);
    assert.equal(r.ok, false);
    assert.deepEqual(P.missingFrom([r]), ['restic']);
});

test('probe treats a failed spawn as absence, not as an error to report', async () => {
    const stub = { spawn: () => Promise.reject(new Error('no such file or directory')) };
    const r = await withCockpit(stub, () => P.probe('fuse3'));
    assert.deepEqual(r, {
        tool: 'fuse3', binary: 'fusermount3', optional: true,
        present: false, raw: '', version: null, ok: false
    });
});

test('probeAll probes every requirement through cockpit, in install order', async () => {
    const stub = { spawn: (argv) => Promise.resolve(argv[0] + ' 9.9.9') };
    const results = await withCockpit(stub, () => P.probeAll());
    assert.deepEqual(results.map((r) => r.tool), P.TOOLS);
    assert.deepEqual(P.missingFrom(results), []);
});

test('probeAll drops names that are not requirements and treats no list as all', async () => {
    assert.deepEqual((await P.probeAll(['borg', 'restic', 'constructor'])).map((r) => r.tool), ['restic']);
    assert.deepEqual((await P.probeAll('restic')).map((r) => r.tool), P.TOOLS);
    assert.deepEqual((await P.probeAll([])).map((r) => r.tool), P.TOOLS);
});

test('detectFamilyLive reads os-release and answers a family planFor accepts', async () => {
    const seen = [];
    const stub = {
        file: function (path) {
            seen.push(path);
            return { read: () => Promise.resolve('ID="rocky"\nID_LIKE="rhel centos fedora"\n') };
        }
    };
    const fam = await withCockpit(stub, () => P.detectFamilyLive());
    assert.deepEqual(seen, ['/etc/os-release']);
    assert.equal(fam, 'rhel');
    assert.equal(P.planFor(['restic'], fam)[0].fallback, 'binary');
});

test('detectFamilyLive answers unknown when os-release cannot be read or is empty', async () => {
    const denied = { file: () => ({ read: () => Promise.reject(new Error('permission denied')) }) };
    assert.equal(await withCockpit(denied, () => P.detectFamilyLive()), 'unknown');
    const empty = { file: () => ({ read: () => Promise.resolve('') }) };
    assert.equal(await withCockpit(empty, () => P.detectFamilyLive()), 'unknown');
});

test('every cockpit stub was removed again, so the module is still bare', () => {
    assert.equal(typeof cockpit, 'undefined');
});

// --- PackageKit missing: the one thing hangar cannot install for the user ---
//
// PackageKit IS the install mechanism, so its absence is a genuine dead end for the
// turnkey path. These pin the escape hatch: the exact command for THIS distribution,
// never a generic instruction and never a guessed one.

test('manualCommand builds the right install line per family', () => {
    assert.equal(P.manualCommand('rhel', ['restic']), 'sudo dnf install -y restic');
    assert.equal(P.manualCommand('fedora', ['restic']), 'sudo dnf install -y restic');
    assert.equal(P.manualCommand('debian', ['restic']), 'sudo apt install -y restic');
    assert.equal(P.manualCommand('suse', ['restic']), 'sudo zypper install -y restic');
    assert.equal(P.manualCommand('arch', ['restic']), 'sudo pacman -S --needed restic');
});

test('manualCommand returns nothing for an unknown family rather than guessing', () => {
    // A wrong package-manager command is worse than no command: it fails in a way
    // that looks like hangar is broken.
    for (const fam of ['unknown', '', null, undefined, 'martian', 42]) {
        assert.equal(P.manualCommand(fam, ['restic']), '', String(fam));
    }
});

test('manualCommand handles empty and hostile package lists', () => {
    assert.equal(P.manualCommand('debian', []), '');
    assert.equal(P.manualCommand('debian', null), '');
    assert.equal(P.manualCommand('debian', ['']), '');
    assert.equal(P.manualCommand('debian', 'restic'), 'sudo apt install -y restic');
    assert.equal(P.manualCommand('debian', ['a', 'b']), 'sudo apt install -y a b');
});

test('the PackageKit package name is cased correctly per family', () => {
    // Not cosmetic: apt and pacman will not find "PackageKit".
    assert.equal(P.packageKitPackageFor('rhel'), 'PackageKit');
    assert.equal(P.packageKitPackageFor('fedora'), 'PackageKit');
    assert.equal(P.packageKitPackageFor('suse'), 'PackageKit');
    assert.equal(P.packageKitPackageFor('debian'), 'packagekit');
    assert.equal(P.packageKitPackageFor('arch'), 'packagekit');
    assert.equal(P.packageKitPackageFor('unknown'), '');
});

test('packageKitCommand names the package manager the host actually has', () => {
    assert.equal(P.packageKitCommand('rhel'), 'sudo dnf install -y PackageKit');
    assert.equal(P.packageKitCommand('debian'), 'sudo apt install -y packagekit');
    assert.equal(P.packageKitCommand('arch'), 'sudo pacman -S --needed packagekit');
    assert.equal(P.packageKitCommand('unknown'), '');
});

test('manualInstructions offers both the recommended and the direct route', () => {
    const i = P.manualInstructions('debian', ['restic', 'fuse3']);
    assert.equal(i.known, true);
    assert.equal(i.family, 'debian');
    assert.equal(i.packageManager, 'apt');
    assert.equal(i.packageKitCommand, 'sudo apt install -y packagekit');
    assert.deepEqual(i.directCommands, ['sudo apt install -y restic fuse3']);
    assert.equal(i.needsEpel, false);
});

test('on RHEL the direct route enables EPEL first', () => {
    // Without this, `dnf install restic` reports that nothing matches — which reads
    // like hangar printed a broken command.
    const i = P.manualInstructions('rhel', ['restic']);
    assert.equal(i.needsEpel, true);
    assert.equal(i.directCommands.length, 2);
    assert.equal(i.directCommands[0], 'sudo dnf install -y epel-release');
    assert.equal(i.directCommands[1], 'sudo dnf install -y restic');
});

test('EPEL is not mentioned when nothing missing actually needs it', () => {
    const i = P.manualInstructions('rhel', ['fuse3', 'unzip']);
    assert.equal(i.needsEpel, false);
    assert.deepEqual(i.directCommands, ['sudo dnf install -y fuse3 unzip']);
});

test('manualInstructions maps tools to this distribution package names', () => {
    // virt-install is 'virtinst' on Debian — the classic cross-distro mistake.
    assert.ok(P.manualInstructions('debian', ['libvirt']).packages.includes('virtinst'));
    assert.ok(P.manualInstructions('rhel', ['libvirt']).packages.includes('virt-install'));
});

test('manualInstructions is honest about an unrecognised distribution', () => {
    const i = P.manualInstructions('martian', ['restic']);
    assert.equal(i.known, false);
    assert.equal(i.family, 'unknown');
    assert.equal(i.packageKitCommand, '');
    assert.deepEqual(i.directCommands, []);
});

test('manualInstructions ignores tool names it does not manage', () => {
    const i = P.manualInstructions('debian', ['restic', 'nonsense', '__proto__', null]);
    assert.deepEqual(i.packages, ['restic']);
});

test('manualInstructions never emits a duplicate package', () => {
    const i = P.manualInstructions('debian', ['restic', 'restic']);
    assert.deepEqual(i.packages, ['restic']);
});

test('packageKitAvailable reports rather than throws when cockpit is absent', async () => {
    // Runs while the dialog is still rendering, so it must never reject.
    const r = await P.packageKitAvailable();
    assert.equal(r.available, false);
    assert.equal(r.reason, 'no-cockpit');
});
