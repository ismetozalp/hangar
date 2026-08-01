// core/provision.js — turnkey prerequisite installation across distro families.
//
// The user must never be told to run a package manager by hand, and hangar must
// never name one: Cockpit runs on six distro families with three different
// package tools, so provisioning goes through the PackageKit D-Bus API.
//
// Pure: the REQUIREMENTS table, version parsing/comparison, os-release family
// detection, install planning and static-binary URL construction. Only probe()
// and the PackageKit calls touch cockpit, and they degrade under node rather
// than throwing at load time.
'use strict';
(function (root) {
    // Under node the sibling module is required relative to this file; in the
    // browser errors.js has already run and put HangarErrors on the global.
    const Errors = (typeof module !== 'undefined' && module.exports)
        ? require('./errors.js')
        : root.HangarErrors;

    const KIND = Errors.KIND;

    function fail(message, detail) {
        throw Errors.create(KIND.GENERIC, message, detail === undefined ? null : detail);
    }

    // Every entry point stringifies caller input, and String() itself throws on a
    // value with no usable toString (a null-prototype object, say). A name we
    // cannot read is the empty string, which every caller already treats as
    // "unknown" and turns into a typed error.
    function str(v) {
        if (v === null || v === undefined) return '';
        try { return String(v); } catch (e) { return ''; }
    }

    // Table lookups must be own-property only. Otherwise a tool called
    // "constructor" resolves to Object.prototype's and hangar plans an install
    // for something it cannot name — or dies on an untyped TypeError.
    function own(table, key) {
        return (table && Object.prototype.hasOwnProperty.call(table, key)) ? table[key] : undefined;
    }

    const FAMILIES = ['rhel', 'fedora', 'debian', 'suse', 'arch'];

    // 'unavailable' is not a way to install anything — it is the honest answer for
    // a tool this distribution does not package and that has no static release.
    const METHOD = { PACKAGEKIT: 'packagekit', BINARY: 'binary', UNAVAILABLE: 'unavailable' };

    // Install order: restic first, because everything else is optional polish.
    // curl and unzip look like odd entries for a backup tool, but self-update depends
    // on both and minimal server images often ship neither — leaving the user to
    // discover it only when an update fails halfway.
    const TOOLS = ['restic', 'rclone', 'fuse3', 'rear', 'libvirt', 'unzip', 'curl'];

    const REQUIREMENTS = {
        restic: {
            tool: 'restic',
            binary: 'restic',
            // `version` is a SUBCOMMAND, not a flag: restic exits non-zero with
            // "unknown flag: --version". Getting this wrong makes an installed restic
            // look absent forever, so the plugin would nag the user to install a tool
            // they already have. Covered by tests/integration/provision-live.test.js.
            versionArgs: ['version'],
            // 0.17.0 is the floor because earlier restic did not emit the distinct
            // exit codes 10 (repo missing) and 11 (locked) that the whole typed
            // error model in core/errors.js turns into one-click remediations.
            minVersion: '0.17.0',
            optional: false,
            reason: 'The backup engine.',
            // Same package name everywhere — but on RHEL/CentOS it lives in EPEL,
            // which is why EPEL_ONLY below exists.
            packages: {
                rhel: ['restic'], fedora: ['restic'], debian: ['restic'],
                suse: ['restic'], arch: ['restic']
            }
        },
        rclone: {
            tool: 'rclone',
            binary: 'rclone',
            versionArgs: ['--version'],
            // No minimum: restic spawns rclone itself and reads its existing config,
            // so hangar depends on no rclone feature that is version-gated.
            minVersion: null,
            optional: true,
            reason: 'Needed only for off-site repositories on an rclone remote.',
            packages: {
                rhel: ['rclone'], fedora: ['rclone'], debian: ['rclone'],
                suse: ['rclone'], arch: ['rclone']
            }
        },
        fuse3: {
            tool: 'fuse3',
            binary: 'fusermount3',
            versionArgs: ['--version'],
            minVersion: null,
            optional: true,
            reason: 'Needed to mount snapshots for the Logbook; without it the Logbook falls back to restic ls.',
            packages: {
                rhel: ['fuse3'], fedora: ['fuse3'], debian: ['fuse3'],
                suse: ['fuse3'], arch: ['fuse3']
            }
        },
        rear: {
            tool: 'rear',
            binary: 'rear',
            versionArgs: ['--version'],
            minVersion: null,
            optional: true,
            reason: 'Needed only for bare-metal disaster recovery.',
            // ReaR is in RHEL AppStream, Fedora, Debian and openSUSE, but not in
            // Arch's official repositories — so there is nothing PackageKit's alpm
            // backend could resolve there, and no static release either.
            packages: {
                rhel: ['rear'], fedora: ['rear'], debian: ['rear'],
                suse: ['rear'], arch: []
            }
        },
        libvirt: {
            tool: 'libvirt',
            // virt-install is what the drill actually shells out to, so probe for it
            // rather than for libvirtd: a host can run libvirtd and still not be able
            // to create the throwaway VM.
            binary: 'virt-install',
            versionArgs: ['--version'],
            minVersion: null,
            optional: true,
            reason: 'Needed only to verify a rescue image by booting it in a throwaway VM.',
            packages: {
                rhel: ['virt-install'], fedora: ['virt-install'],
                // Debian and Ubuntu ship virt-install in virtinst, not virt-install.
                debian: ['virtinst'],
                suse: ['virt-install'], arch: ['virt-install']
            }
        },
        unzip: {
            tool: 'unzip',
            binary: 'unzip',
            versionArgs: ['-v'],
            minVersion: null,
            optional: true,
            // Frequently absent on minimal server images, and self-update fails at
            // the unpack step with a bare "command not found" without it.
            reason: 'Needed only to unpack a downloaded update.',
            packages: {
                rhel: ['unzip'], fedora: ['unzip'], debian: ['unzip'],
                suse: ['unzip'], arch: ['unzip']
            }
        },
        curl: {
            tool: 'curl',
            binary: 'curl',
            versionArgs: ['--version'],
            minVersion: null,
            optional: true,
            // The plugin's CSP forbids talking to GitHub from the browser, so the
            // update check runs through curl on the host. No curl, no update check.
            reason: 'Needed only to check for and download updates.',
            packages: {
                rhel: ['curl'], fedora: ['curl'], debian: ['curl'],
                suse: ['curl'], arch: ['curl']
            }
        }
    };

    // Packaged, but not by the distribution itself. A stock RHEL host without EPEL
    // will have PackageKit resolve nothing — that is expected, not a bug, so the
    // plan carries the way out with it.
    const EPEL_ONLY = { rhel: ['restic'] };

    // The package that enables EPEL. Installing this is itself a PackageKit
    // operation, so the turnkey path never has to leave the D-Bus API.
    const EPEL_PACKAGE = 'epel-release';

    // ---------------------------------------------------------- manual fallback
    //
    // PackageKit is the one prerequisite hangar cannot install for the user: it IS
    // the mechanism. When it is absent the turnkey path is genuinely unavailable,
    // and the only honest response is to say so and give the exact command for THIS
    // distribution — never a generic "install PackageKit" that leaves the user
    // guessing which tool their system uses.
    //
    // Package name casing is not cosmetic: it is `PackageKit` on RPM distributions
    // and `packagekit` on Debian and Arch.
    const PACKAGE_MANAGER = {
        rhel:   { tool: 'dnf',    install: 'dnf install -y',            packagekit: 'PackageKit' },
        fedora: { tool: 'dnf',    install: 'dnf install -y',            packagekit: 'PackageKit' },
        debian: { tool: 'apt',    install: 'apt install -y',            packagekit: 'packagekit' },
        suse:   { tool: 'zypper', install: 'zypper install -y',         packagekit: 'PackageKit' },
        arch:   { tool: 'pacman', install: 'pacman -S --needed',        packagekit: 'packagekit' }
    };

    function packageManagerFor(family) {
        return own(PACKAGE_MANAGER, str(family)) || null;
    }

    // A shell command the user can copy verbatim. Returns '' for an unknown family
    // rather than guessing a package manager — a wrong command is worse than none.
    function manualCommand(family, packages) {
        const pm = packageManagerFor(family);
        if (!pm) return '';
        const list = (Array.isArray(packages) ? packages : [packages])
            .map(str)
            .filter(function (p) { return p !== ''; });
        if (!list.length) return '';
        return 'sudo ' + pm.install + ' ' + list.join(' ');
    }

    function packageKitPackageFor(family) {
        const pm = packageManagerFor(family);
        return pm ? pm.packagekit : '';
    }

    // The command that restores the turnkey path itself.
    function packageKitCommand(family) {
        return manualCommand(family, [packageKitPackageFor(family)]);
    }

    // Everything the UI needs to explain a missing PackageKit on this host:
    // what to install to get turnkey back, and — for a user who would rather not
    // install PackageKit at all — the one command that installs the tools directly.
    function manualInstructions(family, missing) {
        const fam = FAMILIES.indexOf(str(family)) >= 0 ? str(family) : 'unknown';
        const pm = packageManagerFor(fam);
        const tools = (Array.isArray(missing) ? missing : [missing])
            .map(function (m) { return (m && typeof m === 'object') ? str(m.tool) : str(m); })
            .filter(function (t) { return own(REQUIREMENTS, t); });

        const packages = [];
        tools.forEach(function (t) {
            (packagesFor(t, fam) || []).forEach(function (p) {
                if (packages.indexOf(p) < 0) packages.push(p);
            });
        });

        // On RHEL the direct route needs EPEL first, or `dnf install restic` simply
        // reports that nothing matches — which reads like a broken instruction.
        const epel = own(EPEL_ONLY, fam);
        const needsEpel = Array.isArray(epel) && tools.some(function (t) { return epel.indexOf(t) >= 0; });

        const direct = [];
        if (needsEpel) direct.push(manualCommand(fam, [EPEL_PACKAGE]));
        const pkgCmd = manualCommand(fam, packages);
        if (pkgCmd) direct.push(pkgCmd);

        return {
            family: fam,
            known: !!pm,
            packageManager: pm ? pm.tool : '',
            packageKitPackage: packageKitPackageFor(fam),
            // Preferred: restore turnkey, then let hangar do the rest.
            packageKitCommand: packageKitCommand(fam),
            // Alternative: skip PackageKit entirely and install the tools by hand.
            directCommands: direct.filter(Boolean),
            packages: packages,
            needsEpel: needsEpel
        };
    }

    // Official GitHub release assets. URLs only: a checksum value is never invented
    // here, it is downloaded from sha256Url and shown to the user for consent.
    const BINARY_RELEASE = {
        restic: {
            repo: 'restic/restic',
            asset: function (v, a) { return 'restic_' + v + '_linux_' + a + '.bz2'; },
            sums: 'SHA256SUMS',
            sig: 'SHA256SUMS.asc',
            arch: {
                amd64: 'amd64', arm64: 'arm64', arm: 'arm', '386': '386',
                ppc64le: 'ppc64le', s390x: 's390x', riscv64: 'riscv64'
            }
        },
        rclone: {
            repo: 'rclone/rclone',
            asset: function (v, a) { return 'rclone-v' + v + '-linux-' + a + '.zip'; },
            sums: 'SHA256SUMS',
            // rclone's SHA256SUMS is itself clear-signed, so there is no separate
            // detached signature asset to point at.
            sig: null,
            arch: { amd64: 'amd64', arm64: 'arm64', arm: 'arm-v7', '386': '386' }
        }
    };

    // The versions this project was verified against; used as the default offer for
    // the static-binary fallback, never as an assertion about what is installed.
    const RECOMMENDED_VERSION = { restic: '0.19.1', rclone: '1.74.3' };

    const ARCH_ALIAS = {
        x86_64: 'amd64', amd64: 'amd64', x64: 'amd64',
        aarch64: 'arm64', arm64: 'arm64',
        armv7l: 'arm', armv6l: 'arm', armhf: 'arm', arm: 'arm',
        i386: '386', i686: '386', x86: '386', '386': '386',
        ppc64le: 'ppc64le', ppc64el: 'ppc64le',
        s390x: 's390x', riscv64: 'riscv64'
    };

    // ---------------------------------------------------------------- versions

    // The leading class rejects a number glued to a word, so "go1.23" in restic's
    // banner and the "3" in "fusermount3" are not mistaken for the version.
    const VERSION_RE = /(?:^|[^0-9A-Za-z.])v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?![0-9A-Za-z])/;

    function parseVersion(text) {
        const m = VERSION_RE.exec(str(text));
        if (!m) return null;
        return {
            major: parseInt(m[1], 10),
            minor: m[2] === undefined ? 0 : parseInt(m[2], 10),
            patch: m[3] === undefined ? 0 : parseInt(m[3], 10)
        };
    }

    function formatVersion(v) {
        const p = coerce(v);
        if (!p) fail('Cannot format an unparseable version.', v);
        return p.major + '.' + p.minor + '.' + p.patch;
    }

    // A missing component is 0; anything that is not a finite, non-negative number
    // is not a version component at all. `x | 0` used to be the coercion here, but
    // it wrapped 2^31 round to negative and quietly turned NaN into 0 — so the same
    // version compared differently depending on whether it arrived parsed or raw.
    function component(n) {
        if (n === undefined || n === null) return 0;
        if (typeof n !== 'number' || !isFinite(n) || n < 0) return null;
        return Math.floor(n);
    }

    // Accepts either an already-parsed {major,minor,patch} or any tool banner.
    function coerce(v) {
        if (v && typeof v === 'object' && typeof v.major === 'number') {
            const major = component(v.major);
            const minor = component(v.minor);
            const patch = component(v.patch);
            if (major === null || minor === null || patch === null) return null;
            return { major: major, minor: minor, patch: patch };
        }
        return parseVersion(v);
    }

    function compareVersions(a, b) {
        const x = coerce(a);
        const y = coerce(b);
        if (!x) fail('Cannot parse a version out of: ' + str(a), a);
        if (!y) fail('Cannot parse a version out of: ' + str(b), b);
        const fields = ['major', 'minor', 'patch'];
        for (let i = 0; i < fields.length; i++) {
            if (x[fields[i]] < y[fields[i]]) return -1;
            if (x[fields[i]] > y[fields[i]]) return 1;
        }
        return 0;
    }

    function meetsMinimum(found, required) {
        const r = coerce(required);
        if (!r) return true;        // no minimum declared for this tool
        const f = coerce(found);
        if (!f) return false;       // a version we could not read is never "good enough"
        return compareVersions(f, r) >= 0;
    }

    // ---------------------------------------------------------------- os-release

    function parseOsRelease(text) {
        const out = {};
        str(text).split(/\r?\n/).forEach(function (raw) {
            const line = raw.trim();
            if (line === '' || line.charAt(0) === '#') return;
            const i = line.indexOf('=');
            if (i <= 0) return;
            const key = line.slice(0, i).trim();
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;
            let val = line.slice(i + 1).trim();
            const q = val.charAt(0);
            if ((q === '"' || q === "'") && val.length > 1 && val.charAt(val.length - 1) === q)
                val = val.slice(1, -1);
            out[key] = val.replace(/\\(.)/g, '$1');   // os-release permits \" and \\ inside quotes
        });
        return out;
    }

    const ID_FAMILY = {
        // RHEL and everything that rebuilds it.
        rhel: 'rhel', redhat: 'rhel', centos: 'rhel', rocky: 'rhel', almalinux: 'rhel',
        ol: 'rhel', oracle: 'rhel', scientific: 'rhel', cloudlinux: 'rhel',
        eurolinux: 'rhel', virtuozzo: 'rhel', miraclelinux: 'rhel',
        fedora: 'fedora',
        debian: 'debian', ubuntu: 'debian', linuxmint: 'debian', raspbian: 'debian',
        pop: 'debian', elementary: 'debian', devuan: 'debian', kali: 'debian',
        neon: 'debian', zorin: 'debian', deepin: 'debian',
        suse: 'suse', sles: 'suse', sled: 'suse', sles_sap: 'suse', opensuse: 'suse',
        'opensuse-leap': 'suse', 'opensuse-tumbleweed': 'suse', 'opensuse-microos': 'suse',
        'sle-micro': 'suse',
        arch: 'arch', archlinux: 'arch', archarm: 'arch', manjaro: 'arch',
        'manjaro-arm': 'arch', endeavouros: 'arch', garuda: 'arch', artix: 'arch',
        cachyos: 'arch', steamos: 'arch'
    };

    // Rocky and Alma declare ID_LIKE="rhel centos fedora". The rhel token has to
    // win, or they would be planned as Fedora — where restic is not EPEL-gated and
    // the plan would carry no fallback.
    const FAMILY_PRIORITY = ['rhel', 'suse', 'debian', 'arch', 'fedora'];

    function detectFamily(osRelease) {
        const fields = (osRelease && typeof osRelease === 'object')
            ? osRelease
            : parseOsRelease(osRelease);

        const id = str(fields.ID).trim().toLowerCase();
        const direct = own(ID_FAMILY, id);
        if (direct) return direct;

        const seen = {};
        str(fields.ID_LIKE).toLowerCase().split(/\s+/).forEach(function (token) {
            const fam = own(ID_FAMILY, token);
            if (fam) seen[fam] = true;
        });
        for (let i = 0; i < FAMILY_PRIORITY.length; i++)
            if (seen[FAMILY_PRIORITY[i]]) return FAMILY_PRIORITY[i];

        return 'unknown';
    }

    // ---------------------------------------------------------------- planning

    function requirementFor(tool) {
        const req = own(REQUIREMENTS, str(tool));
        if (!req) fail('Unknown prerequisite: ' + str(tool) + '.', tool);
        return req;
    }

    function packagesFor(tool, family) {
        const req = requirementFor(tool);
        const list = own(req.packages, str(family));
        return Array.isArray(list) ? list.slice() : [];
    }

    function stepFor(tool, family) {
        const req = requirementFor(tool);
        const packages = packagesFor(tool, family);
        const step = {
            tool: req.tool,
            method: METHOD.PACKAGEKIT,
            packages: packages,
            fallback: null,
            optional: !!req.optional,
            reason: req.reason
        };

        if (packages.length === 0) {
            // Nothing to name to PackageKit — either the family is unknown or this
            // distribution does not package the tool at all.
            step.method = own(BINARY_RELEASE, req.tool) ? METHOD.BINARY : METHOD.UNAVAILABLE;
            return step;
        }

        const epel = own(EPEL_ONLY, str(family));
        if (Array.isArray(epel) && epel.indexOf(req.tool) >= 0) {
            // Enabling EPEL is strictly better than downloading a loose binary: the
            // package stays managed, signed and updatable by the system. So it is
            // offered FIRST, and the binary remains only as the last resort for a
            // host that cannot reach or use EPEL.
            step.enableRepo = EPEL_PACKAGE;
            if (own(BINARY_RELEASE, req.tool)) step.fallback = METHOD.BINARY;
        }

        return step;
    }

    function planFor(missing, family) {
        const fam = FAMILIES.indexOf(str(family)) >= 0 ? str(family) : 'unknown';
        const list = Array.isArray(missing) ? missing : (missing === null || missing === undefined ? [] : [missing]);
        const want = {};
        list.forEach(function (m) {
            const name = (m && typeof m === 'object') ? str(m.tool) : str(m);
            // Unknown tool names are dropped rather than guessed at: installing a
            // package hangar cannot name is worse than installing nothing.
            if (own(REQUIREMENTS, name)) want[name] = true;
        });
        return TOOLS.filter(function (t) { return want[t]; })
            .map(function (t) { return stepFor(t, fam); });
    }

    function describeStep(step) {
        if (!step || typeof step !== 'object') return 'Nothing to install.';
        const names = (Array.isArray(step.packages) ? step.packages : []).join(', ');
        if (step.method === METHOD.PACKAGEKIT && step.fallback === METHOD.BINARY)
            return 'Install ' + names + ' with the system package manager. If no enabled repository provides it, ' +
                'hangar can install the official static binary once you confirm the download.';
        if (step.method === METHOD.PACKAGEKIT)
            return 'Install ' + names + ' with the system package manager.';
        if (step.method === METHOD.BINARY)
            return 'Install the official ' + step.tool + ' static binary once you confirm the download URL and SHA256.';
        return step.tool + ' is not available from this distribution and has no official static release; install it manually.';
    }

    function normalizeArch(a) {
        return own(ARCH_ALIAS, str(a).trim().toLowerCase()) || null;
    }

    // Builds URLs only. The SHA256 is never invented here: it is fetched from
    // sha256Url and shown to the user, who must consent before anything downloads.
    function binaryFallbackFor(tool, version, arch) {
        const name = str(tool);
        const rel = own(BINARY_RELEASE, name);
        if (!rel) fail('No official static release exists for ' + (name || '(none)') + '.', tool);

        const parsed = coerce(version === null || version === undefined || version === ''
            ? own(RECOMMENDED_VERSION, name) : version);
        if (!parsed) fail('Cannot parse a version out of: ' + str(version), version);
        const v = formatVersion(parsed);

        const norm = normalizeArch(arch);
        if (!norm) fail('Unknown architecture: ' + str(arch) + '.', arch);
        const assetArch = own(rel.arch, norm);
        if (!assetArch) fail(name + ' publishes no linux/' + norm + ' binary.', arch);

        const base = 'https://github.com/' + rel.repo + '/releases/download/v' + v + '/';
        return {
            tool: name,
            version: v,
            arch: norm,
            url: base + rel.asset(v, assetArch),
            sha256Url: base + rel.sums,
            sigUrl: rel.sig ? base + rel.sig : null
        };
    }

    // ---------------------------------------------------------------- probing

    // Pure half of probe(): given the banner a tool printed, decide whether it is
    // good enough. Called only when the spawn succeeded, so present is true here.
    function evaluateProbe(tool, text) {
        const req = requirementFor(tool);
        const raw = str(text).trim();
        const version = parseVersion(raw);
        return {
            tool: req.tool,
            binary: req.binary,
            optional: !!req.optional,
            present: true,
            raw: raw,
            version: version,
            ok: meetsMinimum(version, req.minVersion)
        };
    }

    // Tools the user still needs, in install order. An absent optional tool is
    // still reported: whether it matters is the caller's decision, not ours.
    function missingFrom(results) {
        const bad = {};
        (Array.isArray(results) ? results : []).forEach(function (r) {
            if (!r || typeof r !== 'object') return;
            const name = str(r.tool);
            if (!own(REQUIREMENTS, name)) return;
            if (!r.present || !r.ok) bad[name] = true;
        });
        return TOOLS.filter(function (t) { return bad[t]; });
    }

    // ---------------------------------------------------------------- PackageKit

    const PK = {
        SERVICE: 'org.freedesktop.PackageKit',
        PATH: '/org/freedesktop/PackageKit',
        IFACE: 'org.freedesktop.PackageKit',
        TX_IFACE: 'org.freedesktop.PackageKit.Transaction',
        // Filter bitfield values are 1 << enum, as pk_bitfield_value() computes them.
        FILTER_INSTALLED: 1 << 2,
        FILTER_NOT_INSTALLED: 1 << 3,
        FILTER_NEWEST: 1 << 16,
        FILTER_ARCH: 1 << 18,
        FILTER_NOT_SOURCE: 1 << 21,
        EXIT_SUCCESS: 1,
        EXIT_CANCELLED: 3,
        // TRANSACTION_FLAG_NONE: install for real, do not simulate.
        FLAG_NONE: 0
    };

    // "Newest build for this machine's architecture, not a source package" is what
    // a can-I-install-this lookup means.
    function resolveFilter() {
        return PK.FILTER_ARCH | PK.FILTER_NEWEST | PK.FILTER_NOT_SOURCE;
    }

    // PackageKit's numeric error enum has shifted between releases, so classify on
    // the human detail string and keep the raw code in detail for the log.
    function classifyPackageKitError(code, details) {
        const text = str(details).trim();
        const detail = { code: code === undefined ? null : code };
        if (/no space|disk full|out of disk|not enough space/i.test(text))
            return Errors.create(KIND.NO_SPACE, text || 'The package installation ran out of disk space.', detail);
        // Cancellation is tested before the network pattern, because PackageKit
        // reports the phase it was cancelled in ("cancelled while downloading…")
        // and the network pattern would claim it — turning a deliberate stop into
        // a fatal error with a Retry button.
        if (/cancell?ed/i.test(text))
            return Errors.create(KIND.CANCELLED, text || 'The package installation was cancelled.', detail);
        if (/network|download|could not resolve host|connection|timed out|temporary failure/i.test(text))
            return Errors.create(KIND.NETWORK, text || 'The package installation could not reach the repositories.', detail);
        return Errors.create(KIND.GENERIC, text || 'PackageKit reported an error.', detail);
    }

    function hasCockpit(member) {
        return typeof cockpit !== 'undefined' && cockpit && typeof cockpit[member] === 'function';
    }

    // Is the turnkey mechanism itself present?
    //
    // Answered by reading a property rather than by creating a transaction, because
    // CreateTransaction prompts for authentication — asking the user for a password
    // merely to discover whether a button should be shown would be hostile.
    //
    // Resolves to { available, reason } and never rejects: "cannot tell" has to be
    // reported, not thrown, since this runs while the page is still rendering.
    function packageKitAvailable() {
        if (!hasCockpit('dbus'))
            return Promise.resolve({ available: false, reason: 'no-cockpit' });

        let client;
        try {
            client = cockpit.dbus(PK.SERVICE);
        } catch (e) {
            return Promise.resolve({ available: false, reason: 'not-installed' });
        }

        return client.call(PK.PATH, 'org.freedesktop.DBus.Properties', 'Get',
            [PK.IFACE, 'VersionMajor'])
            .then(function (reply) {
                const v = reply && reply[0];
                // cockpit unwraps the variant to { v: <value> } or the value itself.
                const major = (v && typeof v === 'object' && 'v' in v) ? v.v : v;
                return { available: true, reason: '', version: Number(major) || null };
            })
            .catch(function (ex) {
                // A name that cannot be activated means the package is absent; any
                // other failure means it is there but not answering.
                const msg = str(ex && (ex.message || ex.problem));
                const missing = /ServiceUnknown|NameHasNoOwner|not provided by any|was not provided/i.test(msg);
                return {
                    available: false,
                    reason: missing ? 'not-installed' : 'unreachable',
                    message: msg
                };
            })
            .then(function (result) {
                if (client && typeof client.close === 'function') client.close();
                return result;
            });
    }

    // Every PackageKit action has the same shape — create a transaction, wire the
    // signals, call the method, settle on Finished — so it lives in one place.
    function runTransaction(method, args, onPackage, onProgress) {
        if (!hasCockpit('dbus'))
            return Promise.reject(Errors.create(KIND.GENERIC, 'cockpit is not available', { method: method }));

        const client = cockpit.dbus(PK.SERVICE, { superuser: 'require' });

        // A PolicyKit refusal lands on CreateTransaction, which is the single most
        // likely failure of the whole flow — it has to reach the UI as a typed
        // error like every other one, not as a raw D-Bus object.
        return client.call(PK.PATH, PK.IFACE, 'CreateTransaction', []).catch(function (ex) {
            if (typeof client.close === 'function') client.close();
            throw Errors.create(KIND.GENERIC,
                (ex && ex.message) || 'PackageKit refused to start a transaction.',
                { method: method });
        }).then(function (reply) {
            const tid = reply && reply[0];
            // Without a transaction path there is nothing to subscribe to, and the
            // promise would never settle. A hung install is worse than an error.
            if (!tid) {
                if (typeof client.close === 'function') client.close();
                throw Errors.create(KIND.GENERIC, 'PackageKit returned no transaction.', { method: method });
            }
            return new Promise(function (resolveP, rejectP) {
                const packages = [];
                const subs = [];
                let failure = null;
                let settled = false;

                function finish(err) {
                    if (settled) return;
                    settled = true;
                    subs.forEach(function (s) { if (s && typeof s.remove === 'function') s.remove(); });
                    if (typeof client.close === 'function') client.close();
                    if (err) rejectP(err); else resolveP(packages);
                }

                function on(member, handler) {
                    subs.push(client.subscribe({ path: tid, interface: PK.TX_IFACE, member: member }, handler));
                }

                on('Package', function (path, iface, member, a) {
                    const pkg = { info: a[0], packageId: a[1], summary: a[2] };
                    packages.push(pkg);
                    if (typeof onPackage === 'function') onPackage(pkg);
                });

                // ErrorCode arrives before Finished; hold it so Finished can reject
                // with the real reason rather than a bare exit enum.
                on('ErrorCode', function (path, iface, member, a) {
                    failure = classifyPackageKitError(a[0], a[1]);
                });

                on('Finished', function (path, iface, member, a) {
                    const exit = a[0];
                    if (exit === PK.EXIT_SUCCESS) { finish(null); return; }
                    if (exit === PK.EXIT_CANCELLED) {
                        finish(failure || Errors.create(KIND.CANCELLED, 'The package installation was cancelled.', { exit: exit }));
                        return;
                    }
                    finish(failure || Errors.create(KIND.GENERIC, 'PackageKit did not complete the transaction.', { exit: exit }));
                });

                if (typeof onProgress === 'function')
                    subs.push(client.subscribe(
                        { path: tid, interface: 'org.freedesktop.DBus.Properties', member: 'PropertiesChanged' },
                        function (path, iface, member, a) { onProgress(a[1] || {}); }));

                client.call(tid, PK.TX_IFACE, method, args).catch(function (ex) {
                    finish(Errors.create(KIND.GENERIC,
                        (ex && ex.message) || 'PackageKit refused the request.',
                        { method: method }));
                });
            });
        });
    }

    function resolvePackages(names) {
        const wanted = (Array.isArray(names) ? names : []).map(String).filter(function (n) { return n !== ''; });
        if (wanted.length === 0) return Promise.resolve([]);
        return runTransaction('Resolve', [resolveFilter(), wanted]);
    }

    function installPackages(packageIds, onProgress) {
        const ids = (Array.isArray(packageIds) ? packageIds : []).map(String).filter(function (i) { return i !== ''; });
        if (ids.length === 0) return Promise.resolve([]);
        return runTransaction('InstallPackages', [PK.FLAG_NONE, ids], null, onProgress);
    }

    function installStep(step, onProgress) {
        if (!step || step.method !== METHOD.PACKAGEKIT)
            return Promise.reject(Errors.create(KIND.GENERIC, 'This step cannot be installed with the package manager.', step || null));
        return resolvePackages(step.packages).then(function (found) {
            const ids = found.map(function (p) { return p.packageId; })
                .filter(function (i) { return i !== undefined && i !== null && i !== ''; });
            // The EPEL case: nothing resolved and nothing failed. Rejecting with the
            // fallback in detail is what lets the UI offer the static binary — which
            // must never start without the user seeing URL and SHA256 first.
            if (ids.length === 0)
                throw Errors.create(KIND.GENERIC,
                    (Array.isArray(step.packages) ? step.packages : []).join(', ') +
                    ' is not available from any enabled repository.',
                    { tool: step.tool, fallback: step.fallback });
            return installPackages(ids, onProgress);
        });
    }

    // Impure. A tool that is not installed is an ordinary state, not a failure.
    function probe(tool) {
        let req;
        try {
            req = requirementFor(tool);
        } catch (e) {
            return Promise.reject(e);
        }
        const absent = {
            tool: req.tool, binary: req.binary, optional: !!req.optional,
            present: false, raw: '', version: null, ok: false
        };
        if (!hasCockpit('spawn')) return Promise.resolve(absent);
        return cockpit.spawn([req.binary].concat(req.versionArgs), { err: 'message' })
            .then(function (out) { return evaluateProbe(req.tool, out); })
            .catch(function () { return absent; });
    }

    function probeAll(tools) {
        const list = (Array.isArray(tools) && tools.length ? tools : TOOLS)
            .filter(function (t) { return !!own(REQUIREMENTS, str(t)); });
        return Promise.all(list.map(probe));
    }

    // Impure. /etc/os-release is world-readable, so no superuser is needed.
    function detectFamilyLive() {
        if (!hasCockpit('file')) return Promise.resolve('unknown');
        return cockpit.file('/etc/os-release').read()
            .then(function (text) { return detectFamily(text); })
            .catch(function () { return 'unknown'; });
    }

    const HangarProvision = {
        FAMILIES, TOOLS, METHOD, REQUIREMENTS, EPEL_ONLY, EPEL_PACKAGE, PACKAGE_MANAGER, BINARY_RELEASE, RECOMMENDED_VERSION, PK,
        packageManagerFor, manualCommand, packageKitPackageFor, packageKitCommand,
        manualInstructions,
        parseVersion, formatVersion, compareVersions, meetsMinimum,
        parseOsRelease, detectFamily,
        requirementFor, packagesFor, planFor, describeStep,
        normalizeArch, binaryFallbackFor,
        evaluateProbe, missingFrom,
        resolveFilter, classifyPackageKitError,
        probe, probeAll, detectFamilyLive, resolvePackages, installPackages, installStep,
        packageKitAvailable
    };
    root.HangarProvision = HangarProvision;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarProvision;
})(typeof window !== 'undefined' ? window : globalThis);
