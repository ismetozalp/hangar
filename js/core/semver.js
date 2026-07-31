// core/semver.js — just enough semantic-version comparison for the update check.
//
// A dependency-free implementation because the plugin ships no bundler and pulls no
// npm packages at runtime. Deliberately narrow: it answers "is the release on GitHub
// newer than what is installed?" and nothing else.
//
// Pre-release handling matters here. A tag like v1.0.0-rc.1 must NOT be offered as an
// upgrade over an installed 1.0.0, or every release candidate would be pushed to every
// user as though it were stable.
'use strict';
(function (root) {

    // Leading 'v' is conventional on GitHub tags and carries no meaning.
    const RE = /^[vV=\s]*(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?\s*$/;

    function parse(value) {
        if (typeof value !== 'string') return null;
        const m = RE.exec(value);
        if (!m) return null;
        return {
            major: Number(m[1]),
            minor: m[2] === undefined ? 0 : Number(m[2]),
            patch: m[3] === undefined ? 0 : Number(m[3]),
            // '' and undefined are different: '1.0.0-' is malformed, not a release.
            prerelease: m[4] === undefined ? null : m[4],
            build: m[5] === undefined ? null : m[5]
        };
    }

    function isValid(value) { return parse(value) !== null; }

    function cmpNum(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

    // Numeric identifiers compare numerically, alphanumerics lexically, and numeric
    // always sorts below alphanumeric — per the semver spec.
    function cmpPrereleaseIds(a, b) {
        const aNum = /^\d+$/.test(a);
        const bNum = /^\d+$/.test(b);
        if (aNum && bNum) return cmpNum(Number(a), Number(b));
        if (aNum) return -1;
        if (bNum) return 1;
        return a < b ? -1 : (a > b ? 1 : 0);
    }

    function cmpPrerelease(a, b) {
        // No prerelease outranks any prerelease: 1.0.0 > 1.0.0-rc.1.
        if (a === null && b === null) return 0;
        if (a === null) return 1;
        if (b === null) return -1;

        const as = a.split('.');
        const bs = b.split('.');
        const n = Math.min(as.length, bs.length);
        for (let i = 0; i < n; i++) {
            const c = cmpPrereleaseIds(as[i], bs[i]);
            if (c !== 0) return c;
        }
        // A longer prerelease chain is greater when all shared parts are equal.
        return cmpNum(as.length, bs.length);
    }

    // -1 if a < b, 0 if equal, 1 if a > b. Unparseable input sorts LOWEST, so a
    // garbage tag from GitHub can never be presented as an upgrade.
    function compare(a, b) {
        const pa = parse(a);
        const pb = parse(b);
        if (!pa && !pb) return 0;
        if (!pa) return -1;
        if (!pb) return 1;

        return cmpNum(pa.major, pb.major)
            || cmpNum(pa.minor, pb.minor)
            || cmpNum(pa.patch, pb.patch)
            || cmpPrerelease(pa.prerelease, pb.prerelease);
        // Build metadata is ignored, per the spec.
    }

    function gt(a, b) { return compare(a, b) > 0; }
    function eq(a, b) { return compare(a, b) === 0; }

    // The only question the updater actually asks. Unparseable input on either side
    // returns false: refusing to offer an update is always safer than offering a bad
    // one, since accepting runs `make install` as root.
    function isNewer(candidate, installed) {
        if (!isValid(candidate) || !isValid(installed)) return false;
        return compare(candidate, installed) > 0;
    }

    function format(v) {
        const p = typeof v === 'string' ? parse(v) : v;
        if (!p) return '';
        return p.major + '.' + p.minor + '.' + p.patch +
            (p.prerelease ? '-' + p.prerelease : '');
    }

    const HangarSemver = { parse, isValid, compare, gt, eq, isNewer, format };
    root.HangarSemver = HangarSemver;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarSemver;
})(typeof window !== 'undefined' ? window : globalThis);
