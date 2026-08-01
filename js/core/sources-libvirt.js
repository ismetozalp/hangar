// core/sources-libvirt.js — the 'libvirt' source kind: back up virtual machines.
//
// A VM backup is not a new subsystem, it is a source with pre/post commands:
// freeze the guest filesystems, copy the disk images, thaw. This module is the
// v2 registerKind() payload for that, and nothing in js/core/sources.js changes.
//
// Three facts shape everything below.
//
//  1. Disk paths are DISCOVERED, never assumed. /var/lib/libvirt/images is only
//     the default pool; a domain can have disks in any pool, on LVM, or on a
//     network target. `virsh domblklist --details` already answers "where are
//     this domain's disks", so we ask it instead of guessing a directory.
//
//  2. A disk image without its domain XML is not a restorable VM — it is a file
//     that happens to contain a filesystem. That is why includeXml defaults to
//     true and why the XML is staged to a known path before the backup runs.
//
//  3. The hypervisor may simply not answer. On the development host
//     qemu:///system times out outright. So every impure call is wrapped in a
//     deadline and turns into a typed HangarError; nothing here may hang a page.
'use strict';
(function (root) {
    // Dual-load: the globals in the browser (index.html loads errors.js and
    // sources.js first), require() under `node --test`.
    const E = root.HangarErrors ||
        (typeof require === 'function' ? require('./errors.js') : null);
    const Sources = root.HangarSources ||
        (typeof require === 'function' ? require('./sources.js') : null);

    const SEVERITY = { ERROR: 'error', WARNING: 'warning' };

    // Problem codes. The first four deliberately spell the same strings as
    // HangarSources.PROBLEM — a libvirt source's excludes and tags are restic's
    // excludes and tags, and the UI keys remediation off the code, so the shared
    // rules must report shared codes. The unit test asserts they still match.
    const PROBLEM = {
        BAD_ID: 'bad-id',
        PATTERN_TYPE: 'pattern-type',
        PATTERN_EMPTY: 'pattern-empty',
        PATTERN_NUL: 'pattern-nul',
        TAG_TYPE: 'tag-type',
        TAG_EMPTY: 'tag-empty',
        TAG_COMMA: 'tag-comma',
        TAG_NUL: 'tag-nul',

        NO_DOMAINS: 'no-domains',
        DOMAIN_TYPE: 'domain-type',
        DOMAIN_EMPTY: 'domain-empty',
        DOMAIN_NUL: 'domain-nul',
        DOMAIN_UNSAFE: 'domain-unsafe',
        DOMAIN_DUPLICATE: 'domain-duplicate',
        URI_EMPTY: 'uri-empty',
        QUIESCE_UNKNOWN: 'quiesce-unknown',
        QUIESCE_CRASH_CONSISTENT: 'quiesce-crash-consistent',
        QUIESCE_AGENT_REQUIRED: 'quiesce-agent-required',
        NO_XML: 'no-xml'
    };

    // Same shape as HangarSources' id rule: the id names /etc/hangar files that
    // root has to be able to type and that must not escape the directory.
    const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

    const DEFAULT_URI = 'qemu:///system';

    // Only the two that exist on a stock Cockpit host. Remote URIs (qemu+ssh://…)
    // are a v3 concern: they need credentials, which is a different feature.
    const URIS = [
        {
            id: 'qemu:///system',
            label: 'System (qemu:///system)',
            description: 'Domains owned by libvirtd, the usual place for server VMs.'
        },
        {
            id: 'qemu:///session',
            label: 'User session (qemu:///session)',
            description: 'Domains owned by the logged-in user, with no root privilege.'
        }
    ];

    // What "consistent" costs. The wording is deliberately blunt: a user who picks
    // 'none' should not later be surprised that the restored guest fscks on boot.
    const QUIESCE = [
        {
            id: 'none',
            label: 'None (live copy)',
            description: 'Copies the disk image while the VM keeps running. Fast, no ' +
                'downtime, and the resulting image is crash-consistent at best — the ' +
                'guest sees it as if the power was cut.',
            requiresGuestAgent: false
        },
        {
            id: 'agent',
            label: 'Freeze guest filesystems',
            description: 'Runs virsh domfsfreeze before the copy and domfsthaw after, ' +
                'so the image is filesystem-consistent with no downtime. Requires ' +
                'qemu-guest-agent to be installed and running inside the guest.',
            requiresGuestAgent: true
        },
        {
            id: 'shutdown',
            label: 'Shut the domain down',
            description: 'Shuts the domain down, copies the disks, then starts it again. ' +
                'Fully consistent, at the cost of downtime for the length of the copy.',
            requiresGuestAgent: false
        }
    ];

    const QUIESCE_BY_ID = QUIESCE.reduce((acc, m) => { acc[m.id] = m; return acc; }, Object.create(null));
    const DEFAULT_QUIESCE = 'none';

    // Where dumped domain XML is staged before restic picks it up. Under
    // /var/lib rather than /etc: it is regenerated on every run, not configuration.
    const XML_DIR = '/var/lib/hangar/libvirt';

    // How long a virsh call may take before we give up on it. qemu:///system
    // hangs rather than failing when libvirtd is wedged, and a hung page is worse
    // than a reported failure.
    const TIMEOUT_MS = 20000;

    // Everything that would change the meaning of a command line if a domain name
    // ever reached a shell, plus '/' which would escape XML_DIR, plus the ASCII
    // control range. virsh itself takes argv, but the name also becomes a
    // filename and appears in generated units, so we reject rather than escape.
    const UNSAFE_DOMAIN_RE = /[;&|<>`$(){}[\]*?!~"'\\\/\u0000-\u001F\u007F]/;

    function isString(v) { return typeof v === 'string'; }
    function hasNul(s) { return s.indexOf('\u0000') >= 0; }
    function byCodeUnit(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

    function toArray(v) {
        if (Array.isArray(v)) return v.slice();
        if (v === undefined || v === null) return [];
        return [v];
    }

    function dedupe(list) {
        const seen = new Set();
        const out = [];
        list.forEach((v) => { if (!seen.has(v)) { seen.add(v); out.push(v); } });
        return out;
    }

    function problem(severity, code, message, extra) {
        const p = { severity, code, message };
        if (extra) Object.keys(extra).forEach((k) => { p[k] = extra[k]; });
        return p;
    }

    function fail(kind, message, detail) {
        return E.create(kind, message, detail === undefined ? null : detail);
    }

    // ---- pure: connection and mode lookups ---------------------------------

    function uriOf(source) {
        const u = source && source.uri;
        return isString(u) && u !== '' ? u : DEFAULT_URI;
    }

    function quiesceMode(id) {
        return (isString(id) && QUIESCE_BY_ID[id]) || null;
    }

    function isKnownQuiesce(id) { return !!quiesceMode(id); }

    // qemu:///session is per-user. Running it through superuser would query
    // root's own session daemon, which owns none of the user's domains — the same
    // trap rootless containers set. So a session URI runs unprivileged.
    function isSessionUri(uri) {
        return /^[A-Za-z0-9+.-]+:\/\/\/session$/.test(isString(uri) ? uri : '');
    }

    // The same rule validate() applies, asked as a question. normalize() folds an
    // unknown quiesce mode but deliberately does NOT drop a hostile domain name —
    // describe() has to be able to echo back what the user typed — so every place
    // that turns a domain into argv or into a file name asks this first.
    function isSafeDomain(d) {
        return isString(d) && d !== '' && d.charAt(0) !== '-' && !UNSAFE_DOMAIN_RE.test(d);
    }

    // `virsh shutdown --all` shuts down every domain on the host, and a name with a
    // '/' in it escapes XML_DIR. validate() rejects both, but preCommands(),
    // postCommands() and toResticArgs() are callable directly, so the refusal has
    // to live at the point the name becomes an argument rather than upstream of it.
    function requireSafeDomain(d) {
        if (!isSafeDomain(d))
            throw fail(E.KIND.GENERIC,
                'Domain name "' + (isString(d) ? d : typeof d) + '" is not safe in a command ' +
                'line or a file name.', { domain: d });
        return d;
    }

    // ---- pure: argv construction -------------------------------------------

    // Deterministic by construction: fixed prefix, caller-supplied tail, no
    // option ordering decided at call time.
    function virshArgv(uri, args) {
        const argv = ['virsh', '-c', isString(uri) && uri !== '' ? uri : DEFAULT_URI];
        toArray(args).forEach((a) => { if (isString(a)) argv.push(a); });
        return argv;
    }

    // --name so there is no table to parse and no localisation to defeat;
    // --all so a shut-off domain is still offered for backup.
    function listDomainsArgv(uri) { return virshArgv(uri, ['list', '--all', '--name']); }

    function dumpXmlArgv(uri, domain) { return virshArgv(uri, ['dumpxml', domain]); }

    // --details is what adds the Type and Device columns, and Device is the only
    // way to tell a disk from a CD-ROM.
    function blkListArgv(uri, domain) { return virshArgv(uri, ['domblklist', '--details', domain]); }

    function freezeArgv(uri, domain) { return virshArgv(uri, ['domfsfreeze', domain]); }
    function thawArgv(uri, domain) { return virshArgv(uri, ['domfsthaw', domain]); }
    function shutdownArgv(uri, domain) { return virshArgv(uri, ['shutdown', domain]); }
    function startArgv(uri, domain) { return virshArgv(uri, ['start', domain]); }

    // ---- pure: parsing ------------------------------------------------------

    function lines(text) {
        return (isString(text) ? text : '').split('\n').map((l) => l.replace(/\r$/, ''));
    }

    // `virsh list --all --name` is one name per line with a trailing blank line
    // (and a leading one on some versions). Blank lines are separators, not names.
    function parseDomainNames(text) {
        return lines(text)
            .map((l) => l.trim())
            .filter((l) => l !== '');
    }

    // A separator row is the dashed rule under the header; a header row is the
    // column titles. LC_ALL=C is forced on the spawn so those titles stay English.
    function isSeparatorRow(line) { return /^[-\s]+$/.test(line) && line.indexOf('-') >= 0; }

    function isHeaderRow(cols) {
        return cols[0].toLowerCase() === 'type' && cols[1].toLowerCase() === 'device' &&
            cols[2].toLowerCase() === 'target';
    }

    // What a backable source looks like: an absolute path (file, block, dir and
    // resolved volume disks) or a scheme (network disks — rbd:, nbd:, nvme:).
    // Anything else is not a thing restic could be handed, and treating it as one
    // is how a stray "error: failed to get domain 'x'" on stdout would become a
    // positional argument.
    const SOURCE_RE = /^(?:\/|[A-Za-z][A-Za-z0-9+.-]*:)/;

    // `virsh domblklist --details` emits:
    //
    //   Type   Device   Target   Source
    //   ------------------------------------------------
    //   file   disk     vda      /var/lib/libvirt/images/web.qcow2
    //   file   cdrom    sda      -
    //
    // Source is the last column and may contain spaces, so the split is bounded
    // at three separators rather than done blindly.
    //
    // Two row shapes are dropped here rather than downstream, because both would
    // make `restic backup` fail on a path that does not exist:
    //   * source '-'    — an empty drive (a CD-ROM with no medium) has no file;
    //   * device cdrom  — an attached ISO is installation media, not VM state,
    //                     and is routinely deleted after the guest was installed.
    function parseBlkList(text) {
        const out = [];
        lines(text).forEach((raw) => {
            const line = raw.trim();
            if (line === '' || isSeparatorRow(line)) return;
            const m = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S[\s\S]*)$/.exec(line);
            if (!m) return;
            if (isHeaderRow([m[1], m[2], m[3]])) return;
            const source = m[4].trim();
            // hasNul before SOURCE_RE: a path the kernel could never produce is
            // noise on stdout, and execve would truncate the argument at the NUL
            // rather than reject it.
            if (source === '-' || hasNul(source) || !SOURCE_RE.test(source)) return;
            if (m[2].toLowerCase() === 'cdrom') return;
            out.push({ target: m[3], source: source, type: m[1], device: m[2] });
        });
        return out;
    }

    // Two disks can share a backing file (a shared data disk attached twice), and
    // restic would then store the same tree twice. Order is the order libvirt
    // reported, which is the order the domain XML lists the devices in.
    function diskPathsFor(parsed) {
        return dedupe(toArray(parsed)
            .map((row) => (row && isString(row.source) ? row.source : ''))
            .filter((p) => p !== ''));
    }

    function firstDomainOf(source) {
        const list = toArray(source && source.domains).filter(isString).filter((d) => d !== '');
        return list.length ? list[0] : '';
    }

    // Staging path for the dumped domain XML. Returns '' rather than a path with
    // an empty basename when there is no domain to name it after — and rather than
    // a path outside XML_DIR when the name contains a '/', because this string is
    // both a restic positional and the file hangar-run writes the dumped XML to.
    function xmlPathFor(source, domain) {
        const d = isString(domain) && domain !== '' ? domain : firstDomainOf(source);
        return isSafeDomain(d) ? XML_DIR + '/' + d + '.xml' : '';
    }

    // ---- pure: normalisation ------------------------------------------------

    function normalize(source) {
        const s = (source && typeof source === 'object' && !Array.isArray(source)) ? source : {};
        return {
            id: isString(s.id) ? s.id : '',
            kind: 'libvirt',
            uri: isString(s.uri) && s.uri !== '' ? s.uri : DEFAULT_URI,
            // Sorted and de-duplicated so the argv vector, the freeze order and
            // the description do not change when the user reorders checkboxes.
            domains: dedupe(toArray(s.domains).filter(isString).filter((d) => d !== '')).sort(byCodeUnit),
            // An unrecognised mode folds to the one that needs nothing from the
            // guest. validate() still reports the raw value, so the user is told;
            // this only stops describe() and preCommands() inventing behaviour.
            quiesce: isKnownQuiesce(s.quiesce) ? s.quiesce : DEFAULT_QUIESCE,
            // Absent means true: a disk without its XML is not a restorable VM.
            includeXml: (s.includeXml === undefined || s.includeXml === null) ? true : !!s.includeXml,
            // Pattern order carries meaning to restic, so de-dup only.
            excludes: dedupe(toArray(s.excludes).filter(isString)),
            tags: dedupe(toArray(s.tags).filter(isString).filter((t) => t !== '')),
            // Filled in by resolve() at run time, not by the user.
            resolvedPaths: dedupe(toArray(s.resolvedPaths).filter(isString).filter((p) => p !== ''))
        };
    }

    // ---- pure: validation ---------------------------------------------------

    function validateDomains(source, out) {
        if (!Array.isArray(source.domains) || source.domains.length === 0) {
            out.push(problem(SEVERITY.ERROR, PROBLEM.NO_DOMAINS,
                'A libvirt source must list at least one domain.'));
            return;
        }
        const seen = new Set();
        source.domains.forEach((d, index) => {
            if (!isString(d)) {
                out.push(problem(SEVERITY.ERROR, PROBLEM.DOMAIN_TYPE,
                    'Domain names must be strings.', { index }));
                return;
            }
            if (hasNul(d)) {
                out.push(problem(SEVERITY.ERROR, PROBLEM.DOMAIN_NUL,
                    'A domain name contains a NUL byte.', { index }));
                return;
            }
            if (d === '') {
                out.push(problem(SEVERITY.ERROR, PROBLEM.DOMAIN_EMPTY,
                    'A domain name is empty.', { index }));
                return;
            }
            // A leading dash would be read as an option by virsh, not as the
            // domain it names.
            if (d.charAt(0) === '-') {
                out.push(problem(SEVERITY.ERROR, PROBLEM.DOMAIN_UNSAFE,
                    'Domain "' + d + '" starts with a dash, which virsh would read as an option.',
                    { index, domain: d }));
                return;
            }
            const bad = UNSAFE_DOMAIN_RE.exec(d);
            if (bad) {
                out.push(problem(SEVERITY.ERROR, PROBLEM.DOMAIN_UNSAFE,
                    'Domain "' + d + '" contains "' + bad[0] + '", which is not safe in a ' +
                    'command line or a file name.', { index, domain: d, character: bad[0] }));
                return;
            }
            if (seen.has(d)) {
                out.push(problem(SEVERITY.ERROR, PROBLEM.DOMAIN_DUPLICATE,
                    'Domain "' + d + '" is listed more than once.', { index, domain: d }));
                return;
            }
            seen.add(d);
        });
    }

    function validateQuiesce(source, out) {
        const q = source.quiesce === undefined || source.quiesce === null ? DEFAULT_QUIESCE : source.quiesce;
        if (!isKnownQuiesce(q)) {
            out.push(problem(SEVERITY.ERROR, PROBLEM.QUIESCE_UNKNOWN,
                'Unknown consistency mode "' + (isString(q) ? q : typeof q) + '".',
                { quiesce: source.quiesce, known: QUIESCE.map((m) => m.id) }));
            return;
        }
        if (q === 'none')
            out.push(problem(SEVERITY.WARNING, PROBLEM.QUIESCE_CRASH_CONSISTENT,
                'Disks are copied while the VM runs, so the image is crash-consistent at ' +
                'best — the restored guest sees it as if the power was cut.', { quiesce: q }));
        // Fails open on purpose: virsh domfsfreeze returns an error when the agent
        // is absent, and a run that silently degrades to a live copy while the UI
        // still says "filesystem-consistent" is the worst of both worlds.
        if (q === 'agent')
            out.push(problem(SEVERITY.WARNING, PROBLEM.QUIESCE_AGENT_REQUIRED,
                'Freezing needs qemu-guest-agent running inside the guest. Without it the ' +
                'freeze fails and the copy is only crash-consistent.', { quiesce: q }));
    }

    function validatePatterns(source, out) {
        const v = source.excludes;
        if (v === undefined || v === null) return;
        if (!Array.isArray(v)) {
            out.push(problem(SEVERITY.ERROR, PROBLEM.PATTERN_TYPE,
                'Field "excludes" must be an array of patterns.', { field: 'excludes' }));
            return;
        }
        v.forEach((pat, index) => {
            if (!isString(pat))
                out.push(problem(SEVERITY.ERROR, PROBLEM.PATTERN_TYPE,
                    'Exclude patterns must be strings.', { field: 'excludes', index }));
            else if (hasNul(pat))
                out.push(problem(SEVERITY.ERROR, PROBLEM.PATTERN_NUL,
                    'An exclude pattern contains a NUL byte.', { field: 'excludes', index }));
            else if (pat === '')
                out.push(problem(SEVERITY.ERROR, PROBLEM.PATTERN_EMPTY,
                    'An exclude pattern is empty.', { field: 'excludes', index }));
        });
    }

    function validateTags(source, out) {
        if (source.tags === undefined || source.tags === null) return;
        if (!Array.isArray(source.tags)) {
            out.push(problem(SEVERITY.ERROR, PROBLEM.TAG_TYPE, 'Field "tags" must be an array.'));
            return;
        }
        source.tags.forEach((t, index) => {
            if (!isString(t))
                out.push(problem(SEVERITY.ERROR, PROBLEM.TAG_TYPE, 'Tags must be strings.', { index }));
            else if (hasNul(t))
                out.push(problem(SEVERITY.ERROR, PROBLEM.TAG_NUL,
                    'A tag contains a NUL byte.', { index }));
            else if (t === '')
                out.push(problem(SEVERITY.ERROR, PROBLEM.TAG_EMPTY, 'A tag is empty.', { index }));
            else if (t.indexOf(',') >= 0)
                // restic splits --tag on commas, so one tag would become two.
                out.push(problem(SEVERITY.ERROR, PROBLEM.TAG_COMMA,
                    'Tag "' + t + '" contains a comma.', { index, tag: t }));
        });
    }

    function validate(source) {
        const out = [];
        if (!source || typeof source !== 'object' || Array.isArray(source)) {
            out.push(problem(SEVERITY.ERROR, PROBLEM.NO_DOMAINS,
                'A libvirt source must list at least one domain.'));
            return out;
        }

        if (!isString(source.id) || !ID_RE.test(source.id))
            out.push(problem(SEVERITY.ERROR, PROBLEM.BAD_ID,
                'A source needs an id of letters, digits, dot, dash or underscore.'));

        // Only an explicitly blank uri is an error; an absent one means the
        // default, which is what the editor hands us before the field is touched.
        if (source.uri !== undefined && source.uri !== null &&
            (!isString(source.uri) || source.uri.trim() === ''))
            out.push(problem(SEVERITY.ERROR, PROBLEM.URI_EMPTY,
                'A libvirt source needs a connection URI.', { uri: source.uri }));

        validateDomains(source, out);
        validateQuiesce(source, out);

        if (source.includeXml === false)
            out.push(problem(SEVERITY.WARNING, PROBLEM.NO_XML,
                'Without the domain XML the disk images restore as files, not as a VM you ' +
                'can start.', { includeXml: false }));

        validatePatterns(source, out);
        validateTags(source, out);
        return out;
    }

    // ---- pure: restic arguments ---------------------------------------------

    // Every positional restic is handed must look like something it could open: an
    // absolute path, or a scheme for a network disk. resolvedPaths comes back from
    // parseBlkList, which already enforces that — but it is also a stored field of
    // the job file, so a hand-edited (or corrupted) "--one-file-system" would
    // otherwise be spliced in as a restic FLAG rather than as a path.
    function requireBackable(paths) {
        const bad = paths.filter((p) => !SOURCE_RE.test(p) || hasNul(p));
        if (bad.length)
            throw fail(E.KIND.GENERIC,
                'Resolved disk path "' + bad[0] + '" is not something restic could open — ' +
                'it is neither an absolute path nor a network disk scheme.',
                { path: bad[0], resolvedPaths: paths.slice() });
        return paths;
    }

    // Disk paths come from resolvedPaths because only the hypervisor knows where
    // a domain's disks are; the UI fills them in via resolve() before a run.
    function toResticArgs(source) {
        const n = normalize(source);
        const args = [];
        n.excludes.forEach((p) => { args.push('--exclude', p); });
        n.tags.forEach((t) => { args.push('--tag', t); });

        const disks = requireBackable(n.resolvedPaths.slice()).sort(byCodeUnit);
        const xml = n.includeXml
            ? n.domains.map(requireSafeDomain).map((d) => xmlPathFor(n, d)).sort(byCodeUnit)
            : [];
        // Positionals last, disks before XML: a reader of `journalctl` sees the
        // payload first and the metadata after it.
        disks.forEach((p) => { args.push(p); });
        xml.forEach((p) => { args.push(p); });
        // `restic backup` with flags and no path does not back up nothing — it
        // fails — but it fails deep inside the run, long after the pre commands
        // have already shut the domain down.
        if (disks.length === 0 && xml.length === 0)
            throw fail(E.KIND.GENERIC,
                'Libvirt source "' + (n.id || '?') + '" has nothing to back up: no resolved ' +
                'disk paths and no domain XML.',
                { id: n.id, kind: 'libvirt', domains: n.domains.slice() });
        return args;
    }

    // ---- pure: pre/post commands --------------------------------------------

    // Reversed on the way out so the domain frozen first is thawed last: unwinding
    // in reverse order is the only thing that keeps a partial failure recoverable
    // by re-running the post half.
    function preCommands(source) {
        const n = normalize(source);
        if (n.quiesce !== 'agent' && n.quiesce !== 'shutdown') return [];
        // Checked across the whole list before any of it is built: a half-safe
        // vector is worse than none, because the caller would run the safe half
        // and shut some domains down for a backup that then refuses to start.
        n.domains.forEach(requireSafeDomain);
        if (n.quiesce === 'agent') return n.domains.map((d) => freezeArgv(n.uri, d));
        return n.domains.map((d) => shutdownArgv(n.uri, d));
    }

    function postCommands(source) {
        const n = normalize(source);
        if (n.quiesce !== 'agent' && n.quiesce !== 'shutdown') return [];
        n.domains.forEach(requireSafeDomain);
        const reversed = n.domains.slice().reverse();
        if (n.quiesce === 'agent') return reversed.map((d) => thawArgv(n.uri, d));
        return reversed.map((d) => startArgv(n.uri, d));
    }

    // ---- pure: description ---------------------------------------------------

    function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

    function listPhrase(items) {
        if (items.length === 1) return items[0];
        if (items.length === 2) return items[0] + ' and ' + items[1];
        if (items.length <= 3) return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
        return items.slice(0, 3).join(', ') + ' and ' + (items.length - 3) + ' more';
    }

    const QUIESCE_CLAUSE = {
        none: 'copying disks while they run (crash-consistent at best)',
        agent: 'freezing guest filesystems with the guest agent',
        shutdown: 'shutting each domain down first'
    };

    function describe(source) {
        const n = normalize(source);
        if (n.domains.length === 0) return 'Backs up nothing (no domains selected).';

        const clauses = [QUIESCE_CLAUSE[n.quiesce]];
        if (n.includeXml) clauses.push('including the domain XML');
        if (n.excludes.length > 0) clauses.push('excluding ' + plural(n.excludes.length, 'pattern'));
        if (n.tags.length > 0) clauses.push('tagged ' + n.tags.join(', '));

        return 'Backs up ' + listPhrase(n.domains) + ' on ' + n.uri + ', ' + clauses.join(', ') + '.';
    }

    // ---- pure: failure classification ---------------------------------------

    // Whether virsh failed because it could not reach a hypervisor, or because
    // the hypervisor said no. The distinction is worth making because NETWORK
    // carries the "retry" remediation and GENERIC does not — offering "retry" for
    // "domain not found" would be a lie.
    const UNREACHABLE_RE =
        /failed to connect to the hypervisor|cannot recv data|connection refused|no such file or directory.*libvirt-sock|end of file while reading data|connect: (?:connection )?timed out|unable to connect to server/i;

    function classifyVirshError(text) {
        const s = isString(text) ? text : '';
        return UNREACHABLE_RE.test(s) ? E.KIND.NETWORK : E.KIND.GENERIC;
    }

    // ---- thin I/O layer (guarded; degrades to a typed rejection under node) ---

    function hasCockpit() {
        return typeof cockpit !== 'undefined' && !!cockpit &&
            typeof cockpit.spawn === 'function';
    }

    // LC_ALL=C because domblklist's column titles are translated, and a header row
    // we fail to recognise would be parsed as a disk called "Ziel".
    function spawnOptionsFor(uri) {
        const opts = { err: 'message', environ: ['LC_ALL=C'] };
        if (!isSessionUri(uri)) opts.superuser = 'require';
        return opts;
    }

    function ioError(e, op, argv) {
        if (E.isHangarError(e)) return e;
        const message = (e && e.message) || 'virsh failed';
        return fail(classifyVirshError(message), message, { op: op, argv: argv || null });
    }

    // cockpit.spawn has no deadline of its own, and libvirtd wedges rather than
    // refusing, so the deadline lives here. The channel is closed explicitly on
    // expiry: a promise nobody awaits still leaves a virsh process attached.
    function runVirsh(argv, uri, op) {
        return new Promise((resolve, reject) => {
            if (!hasCockpit()) {
                reject(fail(E.KIND.GENERIC, 'cockpit is unavailable', { op: op, argv: argv }));
                return;
            }
            let settled = false;
            let proc = null;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                if (proc && typeof proc.close === 'function') {
                    try { proc.close('terminated'); } catch (e) { /* already gone */ }
                }
                reject(fail(E.KIND.NETWORK,
                    'The hypervisor did not answer within ' + Math.round(TIMEOUT_MS / 1000) + ' seconds.',
                    { op: op, argv: argv, uri: uri }));
            }, TIMEOUT_MS);

            const finish = (fn) => (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                fn(value);
            };

            try {
                proc = cockpit.spawn(argv, spawnOptionsFor(uri));
            } catch (e) {
                clearTimeout(timer);
                settled = true;
                reject(ioError(e, op, argv));
                return;
            }
            Promise.resolve(proc).then(
                finish((out) => resolve(isString(out) ? out : '')),
                finish((e) => reject(ioError(e, op, argv)))
            );
        });
    }

    function listDomains(uri) {
        const u = isString(uri) && uri !== '' ? uri : DEFAULT_URI;
        return runVirsh(listDomainsArgv(u), u, 'listDomains').then(parseDomainNames);
    }

    function dumpXml(uri, domain) {
        const u = isString(uri) && uri !== '' ? uri : DEFAULT_URI;
        if (!isString(domain) || domain === '' || UNSAFE_DOMAIN_RE.test(domain) || domain.charAt(0) === '-')
            return Promise.reject(fail(E.KIND.GENERIC, 'Not a usable domain name.', { domain: domain }));
        return runVirsh(dumpXmlArgv(u, domain), u, 'dumpXml');
    }

    // Sequential on purpose: a wedged libvirtd answers no faster for being asked
    // ten questions at once, and each question holds a channel open until its
    // deadline expires.
    function resolve(source) {
        const n = normalize(source);
        return n.domains.reduce(
            (chain, domain) => chain.then((acc) => runVirsh(blkListArgv(n.uri, domain), n.uri, 'resolve')
                .then((text) => acc.concat(diskPathsFor(parseBlkList(text))))),
            Promise.resolve([])
        ).then((paths) => Object.assign({}, n, { resolvedPaths: dedupe(paths) }));
    }

    // ---- registration --------------------------------------------------------

    const IMPL = { validate, normalize, toResticArgs, describe };

    // Guarded so the module still loads (and stays unit testable) when sources.js
    // is not present, and so a double load is not an error.
    if (Sources && typeof Sources.registerKind === 'function' && !Sources.KINDS.libvirt)
        Sources.registerKind('libvirt', IMPL);

    const HangarSourcesLibvirt = {
        KIND: 'libvirt',
        URIS, QUIESCE, PROBLEM, SEVERITY,
        DEFAULT_URI, DEFAULT_QUIESCE, XML_DIR, TIMEOUT_MS,
        quiesceMode, isKnownQuiesce, isSessionUri, isSafeDomain, uriOf,
        virshArgv, listDomainsArgv, dumpXmlArgv, blkListArgv,
        freezeArgv, thawArgv, shutdownArgv, startArgv,
        parseDomainNames, parseBlkList, diskPathsFor, xmlPathFor,
        classifyVirshError,
        validate, normalize, toResticArgs, describe,
        preCommands, postCommands,
        listDomains, resolve, dumpXml
    };
    root.HangarSourcesLibvirt = HangarSourcesLibvirt;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarSourcesLibvirt;
})(typeof window !== 'undefined' ? window : globalThis);
