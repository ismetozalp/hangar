// features/recovery-ui.js — the Recovery screen: bare-metal disaster recovery.
//
// This screen carries a debt the rest of hangar does not. ReaR has no restic
// workflow; BACKUP=EXTERNAL is described by ReaR's own documentation as a last
// resort with no maintainer support. The UI says that once, plainly, and then
// offers the only thing that can actually answer it: a drill that boots the
// image we just built and reports whether recovery completed.
//
// Everything that decides *what* to say or *what argv to run* is a pure function
// down here; the component is the thin part that calls them. That is what makes
// the honesty testable rather than a paragraph someone can quietly soften.
'use strict';
(function (root) {
    const node = typeof module !== 'undefined' && module.exports;

    const Errors  = node ? require('../core/errors.js')  : root.HangarErrors;
    const Dr      = node ? require('../core/dr.js')      : root.HangarDr;
    const Config  = node ? require('../core/config.js')  : root.HangarConfig;
    const Repos   = node ? require('../core/repos.js')   : root.HangarRepos;
    const Secrets = node ? require('../core/secrets.js') : root.HangarSecrets;
    const Restic  = node ? require('../engine/restic.js'): root.HangarRestic;

    // ------------------------------------------------------------------ util

    // /etc/hangar/dr.json is JSON.parse output, and JSON can express an object
    // whose `toString` and `valueOf` are both null — String() on that throws
    // TypeError. Every value reaching this screen is untrusted, so an
    // unconvertible one becomes '' and is then rejected by core/dr.js as a typed
    // problem, never as a raw TypeError that blanks the whole screen.
    function str(v) {
        if (v === null || v === undefined) return '';
        try { return String(v); } catch (e) { return ''; }
    }
    function trim(v) { return str(v).trim(); }

    function splitLines(text) {
        const s = str(text).replace(/\r?\n$/, '');
        return s === '' ? [] : s.split(/\r?\n/);
    }

    // Textareas are the honest control for an unbounded list of absolute paths:
    // one per line, no separator that can appear inside a path.
    function splitList(text) {
        return splitLines(text).map(trim).filter(function (s) { return s !== ''; });
    }

    function joinList(list) {
        return Array.isArray(list) ? list.map(str).join('\n') : '';
    }

    function tailOf(lines, n) {
        return lines.slice(Math.max(0, lines.length - n)).join('\n');
    }

    // Clamped to the safe-integer range rather than merely truncated: String(1e21)
    // is "1e+21", and an argv element in exponent notation would make the "command
    // that will run" preview a lie about what virt-install actually receives.
    function intOr(v, fallback) {
        const n = Number(v);
        if (!Number.isFinite(n)) return fallback;
        const t = Math.trunc(n);
        if (t > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
        if (t < -Number.MAX_SAFE_INTEGER) return -Number.MAX_SAFE_INTEGER;
        return t;
    }

    // ------------------------------------------------------- the DR form

    const TEXT_FIELDS = ['repoId', 'repoUrl', 'repoKind', 'host', 'outputUrl', 'excludeFile',
                         'backupUrl', 'keyPath', 'isoDefault', 'isoPrefix', 'isoVolid'];

    // Fields that are only sent to core/dr.js when the user actually filled them
    // in, so an empty box means "use ReaR's/hangar's default" rather than "".
    const OPTIONAL_TEXT = ['host', 'outputUrl', 'excludeFile', 'backupUrl', 'keyPath',
                           'isoDefault', 'isoPrefix', 'isoVolid'];

    const LIST_FIELDS = ['backupPaths', 'excludes', 'extraCopyAsIs', 'extraRequiredProgs'];

    function defaultDrForm() {
        return {
            repoId: '',
            repoUrl: '',
            repoKind: 'local',
            host: '',
            outputUrl: '',
            excludeFile: '',
            backupUrl: '',
            keyPath: '',
            backupPaths: joinList(Dr.DEFAULT_BACKUP_PATHS),
            excludes: joinList(Dr.DEFAULT_EXCLUDES),
            extraCopyAsIs: '',
            extraRequiredProgs: '',
            isoDefault: 'boothd',
            isoPrefix: '',
            isoVolid: '',
            userInputTimeout: 30,
            autoshrinkPercent: '',
            useDhclient: true,
            keepBuildDir: false
        };
    }

    function drFormToConfig(form) {
        const f = Object.assign(defaultDrForm(), form || {});
        const cfg = {
            repoId: trim(f.repoId),
            repoUrl: trim(f.repoUrl),
            repoKind: trim(f.repoKind) || 'local',
            useDhclient: f.useDhclient !== false,
            keepBuildDir: f.keepBuildDir === true
        };

        OPTIONAL_TEXT.forEach(function (k) {
            const v = trim(f[k]);
            if (v !== '') cfg[k] = v;
        });

        LIST_FIELDS.forEach(function (k) {
            const list = splitList(f[k]);
            if (list.length) cfg[k] = list;
        });

        // A non-numeric timeout is passed through untouched rather than coerced to
        // 0: core/dr.js must be the one that rejects it, so the user sees the same
        // message whether the config came from this form or from disk.
        const t = trim(f.userInputTimeout);
        if (t !== '') cfg.userInputTimeout = /^-?\d+$/.test(t) ? Number(t) : f.userInputTimeout;

        // Empty means "do not write AUTOSHRINK_DISK_SIZE_LIMIT_PERCENTAGE at
        // all", so ReaR keeps its own default rather than hangar restating it.
        const a = trim(f.autoshrinkPercent);
        if (a !== '') cfg.autoshrinkPercent = /^-?\d+$/.test(a) ? Number(a) : f.autoshrinkPercent;

        return cfg;
    }

    // Has this object ever held a CONFIGURATION, or only hangar's own bookkeeping?
    //
    // hangar records the path of the last rescue image it built in the same file,
    // so /etc/hangar/dr.json can exist while holding nothing but {"lastIso": ...}.
    // Treating that as a saved form blanked the default paths and excludes — a
    // user who had never saved anything found "Paths to back up" empty after
    // building an image, and a recovery configuration that backs up nothing is
    // the worst kind of empty box.
    function isSavedConfig(cfg) {
        if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false;
        const has = (k) => Object.prototype.hasOwnProperty.call(cfg, k) &&
            cfg[k] !== undefined && cfg[k] !== null;
        // A list PRESENT but empty still counts: clearing the excludes and saving
        // is a decision, and the defaults must not creep back in afterwards. The
        // switches count too — someone who turned dhclient off and saved has
        // configured this form as surely as someone who typed a path.
        const SWITCHES = ['useDhclient', 'keepBuildDir', 'userInputTimeout', 'autoshrinkPercent'];
        return TEXT_FIELDS.some((k) => has(k) && str(cfg[k]) !== '') ||
            LIST_FIELDS.some(has) || SWITCHES.some(has);
    }

    function configToDrForm(cfg) {
        const f = defaultDrForm();
        if (!isSavedConfig(cfg)) return f;

        TEXT_FIELDS.forEach(function (k) {
            if (cfg[k] !== undefined && cfg[k] !== null) f[k] = str(cfg[k]);
        });

        // An absent list is an empty box, not the default list: the defaults are
        // only ever offered to a form that has never been saved.
        LIST_FIELDS.forEach(function (k) { f[k] = joinList(cfg[k]); });

        if (cfg.userInputTimeout !== undefined && cfg.userInputTimeout !== null)
            f.userInputTimeout = cfg.userInputTimeout;
        f.autoshrinkPercent = (cfg.autoshrinkPercent === undefined || cfg.autoshrinkPercent === null)
            ? '' : cfg.autoshrinkPercent;
        f.useDhclient = cfg.useDhclient !== false;
        f.keepBuildDir = cfg.keepBuildDir === true;

        return f;
    }

    // -------------------------------------------------------- phase labelling

    // Mapped from core/dr.js PHASES. A phase that arrives here without an entry is
    // reported as unmapped rather than given a plausible-sounding sentence — the
    // same rule that governs rawTail, applied one level up.
    const PHASE_LABELS = {
        idle:      'Waiting for Relax-and-Recover to start.',
        starting:  'Starting Relax-and-Recover.',
        layout:    'Recording the disk layout.',
        creating:  'Creating the rescue system.',
        rootfs:    'Building the rescue root filesystem.',
        copying:   'Copying files into the rescue system.',
        initramfs: 'Building the rescue initramfs.',
        iso:       'Making the ISO image.',
        done:      'Rescue image written.'
    };

    const UNRECOGNISED_LABEL =
        'hangar did not recognise this output. The raw log is shown below, unedited.';

    function clampPercent(v) {
        const n = Number(v);
        if (!Number.isFinite(n)) return 0;
        if (n < 0) return 0;
        if (n > 100) return 100;
        return n;
    }

    function phaseLabel(parsed) {
        const p = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
        const rawTail = typeof p.rawTail === 'string' ? p.rawTail : '';
        const errors = Array.isArray(p.errors) ? p.errors.map(str) : [];
        const hasErrors = errors.length > 0;
        const percent = clampPercent(p.percent);
        const phase = typeof p.phase === 'string' && p.phase !== '' ? p.phase : 'unknown';

        function out(o) {
            return Object.assign({
                phase: phase, percent: percent, label: '',
                recognised: true, unrecognised: false,
                errors: errors, hasErrors: hasErrors,
                rawTail: rawTail, showRaw: hasErrors
            }, o);
        }

        // Nothing to interpret yet is not the same as output we failed to
        // interpret; conflating them would cry wolf on every build's first frame.
        if (phase === 'unknown' && rawTail.trim() === '')
            return out({ phase: 'idle', percent: 0, label: PHASE_LABELS.idle });

        if (phase === 'unknown')
            return out({ label: UNRECOGNISED_LABEL, recognised: false, unrecognised: true, showRaw: true });

        if (!PHASE_LABELS[phase])
            return out({
                label: 'Relax-and-Recover reported a step hangar has no wording for: ' + phase + '.',
                recognised: false, unrecognised: true, showRaw: true
            });

        return out({ label: PHASE_LABELS[phase] });
    }

    // ------------------------------------------------------------- the drill

    const DRILL_DEFAULTS = {
        name: 'hangar-drill',
        memoryMb: 2048,
        vcpus: 2,
        diskGb: 20,
        diskDir: '/var/lib/libvirt/images',
        network: 'default',
        firmware: 'bios',
        timeoutMin: 30,
        remoteRepo: false,
        systemGb: 0,
        libvirt: true,
        keepDisk: false
    };

    const MIN_MEMORY_MB = 1024;
    const COMFORTABLE_MEMORY_MB = 2048;

    // Upper bounds exist so a typo (or a mangled stored value) is refused with a
    // sentence instead of being handed to virt-install, which would fail minutes
    // later with a message about the host that says nothing about the mistake.
    const MAX_MEMORY_MB = 1024 * 1024;      // 1 TiB
    const MAX_VCPUS = 512;
    const MAX_DISK_GB = 65536;              // 64 TiB
    const MAX_TIMEOUT_MIN = 1440;           // a drill that runs past a day is hung

    // The name reaches a libvirt domain name AND a qcow2 path, so it is narrowed
    // here rather than quoted at every use site.
    function drillName(v) {
        let n = trim(v).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-')
            .replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
        return n === '' ? DRILL_DEFAULTS.name : n;
    }

    const CTRL_RE = /[\x00-\x1f\x7f]/;

    function note(level, code, message) {
        return { level: level, code: code, message: message };
    }

    // Where the drill's guest console is captured. Its own directory, because the
    // file has to be writable by the qemu user and /var/lib/libvirt/images is not.
    const DRILL_DIR = '/var/lib/hangar/drill';

    // The group libvirt runs qemu as, by distribution. Probed in order; the first
    // that exists on this host wins. RHEL/Fedora use qemu, Debian/Ubuntu
    // libvirt-qemu, and kvm is the fallback that exists nearly everywhere.
    const QEMU_GROUPS = ['qemu', 'libvirt-qemu', 'kvm'];

    function drillPlan(iso, opts) {
        const o = Object.assign({}, DRILL_DEFAULTS, opts || {});
        const warnings = [];

        const name = drillName(o.name);
        const isoPath = trim(iso);
        // Already configurable — the libvirt pool is usually on /, which is the
        // filesystem of the machine being tested, and a drill disk big enough to
        // hold its restore is by definition big enough to fill it.
        const diskDir = trim(o.diskDir).replace(/\/+$/, '') || DRILL_DEFAULTS.diskDir;
        const diskPath = diskDir + '/' + name + '.qcow2';

        if (isoPath === '')
            warnings.push(note('error', 'no-iso',
                'Build the rescue image first — there is nothing to boot yet.'));
        else if (isoPath.charAt(0) !== '/')
            warnings.push(note('error', 'iso-relative',
                'The rescue image path must be absolute.'));
        else if (CTRL_RE.test(isoPath))
            warnings.push(note('error', 'iso-control',
                'The rescue image path contains a control character, so it is not the path ReaR wrote.'));

        // Relative here would resolve against whatever directory the bridge
        // happens to be in, which is not a place a 20 GB disk should appear.
        // Absolute, no traversal, no shell metacharacters. Every consumer passes it
        // as an argv element rather than through a shell, so this is the second
        // line of defence rather than the first — but it runs as root and creates
        // a directory, so a value like /home/../etc should never get that far.
        if (diskDir.charAt(0) !== '/' || CTRL_RE.test(diskDir) ||
            diskDir.split('/').indexOf('..') >= 0 || /['"`$;&|<>()\s\\]/.test(diskDir))
            warnings.push(note('error', 'disk-dir',
                'The drill disk directory must be an absolute path with no "..", ' +
                'spaces, quotes or shell characters.'));

        // Absence of libvirt is a limit of this host, not a defect in the image.
        if (o.libvirt === false)
            warnings.push(note('error', 'no-libvirt',
                'libvirt is not available on this host, so the drill cannot run here. ' +
                'The rescue image itself is unaffected — boot it on other hardware, or ' +
                'copy it to a machine that has libvirt and run the drill there.'));

        const memoryMb = intOr(o.memoryMb, DRILL_DEFAULTS.memoryMb);
        if (memoryMb < MIN_MEMORY_MB)
            warnings.push(note('error', 'memory',
                'The rescue system needs at least ' + MIN_MEMORY_MB + ' MiB of memory to boot.'));
        else if (memoryMb > MAX_MEMORY_MB)
            warnings.push(note('error', 'memory-max',
                'A drill VM cannot be given more than ' + MAX_MEMORY_MB + ' MiB of memory.'));
        else if (memoryMb < COMFORTABLE_MEMORY_MB)
            warnings.push(note('warn', 'memory-low',
                'Below ' + COMFORTABLE_MEMORY_MB + ' MiB the rescue system often runs out of ' +
                'memory while unpacking its initramfs.'));

        const vcpus = intOr(o.vcpus, DRILL_DEFAULTS.vcpus);
        if (vcpus < 1)
            warnings.push(note('error', 'vcpus', 'The drill VM needs at least one virtual CPU.'));
        else if (vcpus > MAX_VCPUS)
            warnings.push(note('error', 'vcpus-max',
                'A drill VM cannot be given more than ' + MAX_VCPUS + ' virtual CPUs.'));

        const diskGb = intOr(o.diskGb, DRILL_DEFAULTS.diskGb);
        const systemGb = intOr(o.systemGb, 0);
        if (diskGb < 1)
            warnings.push(note('error', 'disk', 'The drill disk must be at least 1 GB.'));
        else if (diskGb > MAX_DISK_GB)
            warnings.push(note('error', 'disk-max',
                'The drill disk cannot be larger than ' + MAX_DISK_GB + ' GB.'));
        else if (systemGb > 0 && diskGb < systemGb)
            warnings.push(note('warn', 'disk-small',
                'The drill disk (' + diskGb + ' GB) is smaller than the system being recovered (' +
                systemGb + ' GB). Recovery will stop while recreating the disk layout, which ' +
                'tells you nothing about the backup.'));

        const network = trim(o.network) || DRILL_DEFAULTS.network;
        if (!/^[A-Za-z0-9._-]+$/.test(network))
            warnings.push(note('error', 'network-name',
                'A libvirt network name may only contain letters, digits, dots, dashes and ' +
                'underscores. Use "none" for no network at all.'));
        if (network === 'none' && o.remoteRepo === true)
            warnings.push(note('warn', 'no-network',
                'The repository is not on this machine and the drill VM has no network, so the ' +
                'restore step cannot reach it.'));

        // NOT beside the disk: /var/lib/libvirt/images is drwx--x--x root:root, so
        // the qemu user can traverse it but cannot CREATE anything in it —
        //   ERROR Unable to open file: …-console.log: Permission denied
        // and the domain is torn down again having produced nothing. hangar makes
        // its own directory for this, group-owned by whichever group the local
        // libvirt runs qemu as.
        const consolePath = DRILL_DIR + '/' + name + '-console.log';
        // The drill name is already sanitised for a domain name, and the same
        // characters are legal in a unit name.
        const unitName = name;
        const toolLogPath = DRILL_DIR + '/' + name + '.log';

        const firmware = o.firmware === 'uefi' ? 'uefi' : 'bios';
        const keepDisk = o.keepDisk === true;
        const timeoutMin = Math.min(MAX_TIMEOUT_MIN,
            Math.max(1, intOr(o.timeoutMin, DRILL_DEFAULTS.timeoutMin)));

        const argv = ['virt-install',
            '--name', name,
            '--memory', String(memoryMb),
            '--vcpus', String(vcpus),
            '--disk', 'path=' + diskPath + ',size=' + diskGb + ',format=qcow2,sparse=yes',
            '--cdrom', isoPath,
            '--os-variant', 'generic',
            '--graphics', 'none',
            // NOT '--console pty': virt-install would try to attach an interactive
            // console, and hangar runs it through cockpit's channel, which has no
            // controlling TTY. It refuses outright —
            //
            //   error: Cannot run interactive console without a controlling TTY
            //
            // — after defining the domain, so the drill died having proved nothing.
            //
            // The guest's serial output is still the only evidence the drill
            // produces, so it goes to a FILE that hangar reads instead of to a
            // terminal nobody is sitting at. The path is beside the drill disk on
            // purpose: /var/lib/libvirt/images is already labelled for qemu to write
            // to, which /var/log is not.
            '--noautoconsole',
            '--serial', 'file,path=' + consolePath,
            // The drill is finished the moment recovery reports; letting the VM
            // reboot into the recovered system proves nothing extra and costs time.
            // The drill disk must be as big as the ORIGINAL disk, because ReaR
            // recreates the recorded partition table and refuses to shrink a
            // partition by more than a couple of percent. That nominal size is
            // not what gets used: the disk is sparse, so it occupies roughly
            // what the restore actually writes.
            //
            // virt-install checks the requested size against free space as if
            // it were fully allocated, and refuses — "The requested volume
            // capacity will exceed the available pool space when the volume is
            // fully allocated" — which for a sparse drill disk measures the
            // wrong thing entirely. Turning off that one check (not all of
            // them) is what lets a 1 TB layout be drilled on a filesystem with
            // room for the data but not for a full 1 TB.
            //
            // The real "is there room" question is asked by the System size
            // field, which warns when the disk is too small for the restore.
            '--check', 'disk_size=off',
            '--noreboot',
            '--wait', String(timeoutMin)];

        if (network === 'none') argv.push('--network', 'none');
        else argv.push('--network', 'network=' + network);
        // UEFI, but NOT Secure Boot. A ReaR rescue image is not signed by a key
        // any firmware trusts, so a secure-boot guest stops at the bootloader —
        //
        //   failed to load Boot0002 "UEFI QEMU DVD-ROM": Access Denied
        //     -- rejected probably by Secure Boot
        //   No bootable option or device was found.
        //
        // and then waits at the boot menu until the drill times out, having
        // tested nothing.
        //
        // It must be the firmware feature, not `uefi,loader.secure=no`. The
        // `uefi` shorthand resolves to a secure-boot firmware and overrides the
        // attribute; measured with `virt-install --print-xml`:
        //
        //   uefi,loader.secure=no  -> <loader secure="yes">OVMF_CODE.secboot.fd
        //   firmware.feature0…=no  -> <firmware><feature enabled="no"
        //                                 name="secure-boot"/></firmware>
        //
        // The second form also matches how these machines really boot: the host
        // this was found on reports SecureBoot disabled.
        //
        // --machine q35 is not decoration. Every EFI firmware descriptor ships
        // q35-only targets (checked across all of /usr/share/qemu/firmware:
        // machines=['q35'], the no-secure-boot one included). virt-install's
        // default machine is i440fx, and it only switched to q35 as a side
        // effect of arranging secure boot — so turning secure boot off took the
        // machine type down with it and left firmware autoselect with nothing:
        //
        //   ERROR operation failed: Unable to find 'efi' firmware that is
        //   compatible with the current configuration
        //
        // Asking for q35 outright makes the drill independent of that coupling.
        if (firmware === 'uefi') {
            argv.push('--machine', 'q35');
            argv.push('--boot', 'firmware=efi,firmware.feature0.name=secure-boot,'
                + 'firmware.feature0.enabled=no');
        }

        // virt-install is launched through systemd-run, not directly.
        //
        // cockpit.spawn ties a process to the BROWSER: when the page reloads or
        // the connection drops, cockpit kills what it started. A drill is a
        // quarter of an hour of restoring, and it was dying with the tab —
        // observed on a real run, killed 19 GB into a 47 GB restore by a
        // disconnect. A transient unit belongs to systemd instead, so the drill
        // survives the session that asked for it.
        //
        // Its output goes to a file for the same reason: a log that only exists
        // in a browser tab is lost exactly when it is most wanted.
        // No --collect: the unit has to outlive its own exit long enough for
        // hangar to read the status virt-install returned. Without that, a
        // virt-install that refused outright ("pool space exceeded", "cannot
        // access storage file") would leave the drill reporting nothing at all.
        // cleanup runs `systemctl reset-failed`, which is what --collect would
        // otherwise have done.
        const launch = ['systemd-run', '--unit', unitName,
            '--service-type=exec',
            '--property=StandardOutput=append:' + toolLogPath,
            '--property=StandardError=append:' + toolLogPath].concat(argv);

        return {
            launch: launch,
            name: name,
            iso: isoPath,
            diskPath: diskPath,
            consolePath: consolePath,
            memoryMb: memoryMb,
            vcpus: vcpus,
            diskGb: diskGb,
            network: network,
            firmware: firmware,
            timeoutMin: timeoutMin,
            argv: argv,
            // Throwaway means throwaway: the disk goes with the domain, always.
            // Keeping the disk is a post-mortem tool, not a convenience. ReaR
            // copies its own recovery log into the RESTORED system
            // (wrapup/default/990_copy_logfile.sh), so the only copy of what
            // went wrong during a recovery is inside the disk hangar deletes.
            // A drill that reported a warning and then destroyed the evidence
            // is a drill you cannot act on.
            cleanup: keepDisk
                ? [
                    ['virsh', 'destroy', name],
                    // No --remove-all-storage: that is the whole point.
                    ['virsh', 'undefine', '--nvram', name],
                    ['rm', '-f', consolePath],
                    ['systemctl', 'reset-failed', unitName]
                ]
                : [
                    ['virsh', 'destroy', name],
                    ['virsh', 'undefine', '--nvram', '--remove-all-storage', name],
                    // --remove-all-storage takes the disk; the console log is an
                    // ordinary file beside it and has to be named.
                    ['rm', '-f', consolePath],
                    ['systemctl', 'reset-failed', unitName]
                ],
            keepDisk: keepDisk,
            unit: unitName,
            toolLogPath: toolLogPath,
            warnings: warnings,
            ok: !warnings.some(function (w) { return w.level === 'error'; })
        };
    }

    // Decisive markers only, same discipline as core/dr.js: a line hangar does not
    // recognise leaves the outcome inconclusive rather than being read as success.
    // What ReaR says when it is done. The wording is version-specific and there
    // is no machine-readable result to parse, so several spellings are matched.
    //
    // The first entry used to be the ONLY success marker, and ReaR 2.9 never
    // prints it: a drill that restored 47 GB and ended with "'rear recover'
    // finished successfully" was reported as "no output hangar recognises".
    // A recovery test that cannot recognise a recovery is worse than none,
    // because it teaches the operator to ignore the verdict.
    const DRILL_MARKERS = [
        { re: /^Finished recovering your system/i,        outcome: 'recovered' },
        { re: /^'?rear recover'? finished successfully/i, outcome: 'recovered' },
        { re: /^Finished 'recover'\./i,                   outcome: 'recovered' },
        { re: /^Recovery is not possible/i,               outcome: 'failed' },
        { re: /^'?rear recover'? failed with exit code/i, outcome: 'failed' },
        { re: /^Aborting due to an error/i,               outcome: 'failed' },
        { re: /^(?:ERROR|BUG):/,                          outcome: 'failed' },
        { re: /Relax-and-Recover .*Rescue image/i,        outcome: 'booted' },
        { re: /^Welcome to Relax-and-Recover/i,           outcome: 'booted' },
        { re: /^Launching 'rear recover' automatically/i, outcome: 'booted' }
    ];

    const DRILL_OUTCOMES = ['inconclusive', 'booted', 'recovered', 'failed'];

    const DRILL_LABELS = {
        inconclusive: 'The drill produced no output hangar recognises. Read the console log below before drawing any conclusion.',
        booted:       'The rescue image booted, but recovery never reported completion.',
        recovered:    'Recovery completed in the drill VM.',
        failed:       'Recovery failed in the drill VM.'
    };

    // How often the guest console file is re-read while a drill runs. Slow enough
    // not to hammer a privileged channel, fast enough that the box on screen looks
    // alive rather than hung.
    const GUEST_POLL_MS = 2000;

    // How long to let a guest close its files before the power goes off:
    // 30 x 2s. Generous, because the alternative is losing whatever it had not
    // written yet, and stingy enough that a wedged guest cannot stall a drill.
    const GUEST_SHUTDOWN_TRIES = 30;

    // The drill no longer has a process to await, so waiting is explicit.
    function sleep(ms) {
        return new Promise(function (resolve) {
            if (root.setTimeout) root.setTimeout(resolve, ms);
            else resolve();
        });
    }

    // A serial console is a terminal, not a log file. What arrives is the byte
    // stream a VT100 would have drawn: cursor moves, colour changes, screen
    // clears, and a boot menu that repaints one line 300 times to count down.
    // Shown raw it is unreadable —
    //
    //   [2J[001;001HBdsDxe: loading Boot0002 …
    //   [054;001H   The highlighted entry will be executed automatically in 300s.
    //   [054;001H   The highlighted entry will be executed automatically in 299s.
    //
    // This is not a terminal emulator and does not try to be one: it keeps the
    // text, drops the drawing instructions, and collapses repaints.
    function decodeConsole(raw) {
        let s = str(raw);
        if (!s) return '';

        // Cursor moves and screen/line erases are where the firmware jumps to
        // write somewhere else, so each one reads as a line break.
        // Cursor moves and screen/line erases are where the firmware jumps to
        // write somewhere else, so each one reads as a line break.
        s = s.replace(/\u001b\[[0-9;]*[Hf]/g, '\n');
        s = s.replace(/\u001b\[[0-9;?]*[JK]/g, '\n');
        // Operating-system commands (window titles and such) carry no console text.
        s = s.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '');
        // Every other CSI: colours, modes, the 8;056;240t window resize.
        s = s.replace(/\u001b\[[0-9;?=<>!]*[ -\/]*[@-~]/g, '');
        s = s.replace(/\u001b[()][A-Za-z0-9]/g, '');   // charset selection
        s = s.replace(/\u001b[=><NOMDEHc78]/g, '');    // single-character escapes
        s = s.replace(/\u001b/g, '');                  // anything left over

        const out = [];
        const lines = s.split('\n');
        for (let i = 0; i < lines.length; i++) {
            // A carriage return rewinds to column one and the rest overwrites.
            // Keeping the last segment is the usual approximation and is what
            // makes progress bars readable.
            // The trailing CR of a CRLF ending is NOT an overwrite. Stripping it
            // first is the whole ballgame: 'text\r'.split('\r').pop() is '', so
            // treating it as one deleted every CRLF-terminated line — which is
            // every line a Linux rescue system prints. Measured on a real drill
            // log: 89 KB in, 20 lines out, with 'rear recover failed' among the
            // casualties.
            let line = lines[i].replace(/\r+$/, '');
            // An embedded CR is a genuine rewind: what follows overwrites.
            if (line.indexOf('\r') >= 0) line = line.split('\r').pop();
            // Trimmed at BOTH ends. DRILL_MARKERS anchors its verdicts to the
            // start of a line ("^Finished recovering your system"), but a console
            // line begins wherever the cursor was parked — a single leading space
            // would hide the one line the whole drill exists to report.
            line = line.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
            if (!line.trim()) continue;
            // The menu frame is drawn character by character; it says nothing.
            if (/^[\s\u2500-\u257f*]*$/.test(line)) continue;
            out.push(line);
        }
        return collapseRepaints(out).join('\n');
    }

    // A repainted line arrives once per update. Consecutive lines of the same
    // shape — identical once their numbers are blanked — are one line being
    // rewritten, and only the final state is worth reading.
    function collapseRepaints(lines) {
        const out = [];
        let i = 0;
        while (i < lines.length) {
            const shape = lines[i].replace(/\d+/g, '#');
            let j = i + 1;
            while (j < lines.length && lines[j].replace(/\d+/g, '#') === shape) j++;
            const runLength = j - i;
            const identical = lines[i] === lines[j - 1];
            if (runLength === 1) {
                out.push(lines[i]);
            } else if (identical) {
                out.push(lines[i] + '   [repeated ' + runLength + ' times]');
            } else if (runLength >= 3) {
                // A counter. The last value is the only informative one, but say
                // how long it ran so a stall is still visible.
                out.push(lines[j - 1] + '   [' + runLength + ' updates, last shown]');
            } else {
                for (let k = i; k < j; k++) out.push(lines[k]);
            }
            i = j;
        }
        return out;
    }

    // virt-install's own output and the guest's serial output, in that order, with
    // a rule between them so a reader can tell which machine said what.
    function joinLogs(toolLog, guestLog) {
        const tool = str(toolLog);
        const guest = str(guestLog);
        if (!guest) return tool;
        if (!tool) return guest;
        return tool.replace(/\s+$/, '') + '\n\n--- guest console ---\n' + guest;
    }

    function drillOutcome(text) {
        const lines = splitLines(text);
        let outcome = 'inconclusive';
        let evidence = null;

        lines.forEach(function (raw) {
            const line = raw.trim();
            for (let i = 0; i < DRILL_MARKERS.length; i++) {
                if (!DRILL_MARKERS[i].re.test(line)) continue;
                const found = DRILL_MARKERS[i].outcome;
                // "booted" is a prelude, never a verdict: it must not overwrite a
                // decisive line that was printed earlier in the same run.
                if (found === 'booted' && (outcome === 'recovered' || outcome === 'failed')) return;
                outcome = found;
                evidence = line;
                return;
            }
        });

        return {
            outcome: outcome,
            decisive: outcome === 'recovered' || outcome === 'failed',
            label: DRILL_LABELS[outcome],
            evidence: evidence,
            rawTail: tailOf(lines, Dr.TAIL_LINES)
        };
    }

    // ------------------------------------------------------------ remediation

    // Wording for the six remediations core/errors.js can return. Kept here rather
    // than inline in the template so a kind that gains a remediation cannot ship a
    // button with no label.
    const REMEDIATION_LABELS = {
        'unlock':          'Unlock repository',
        'reprompt':        'Re-enter repository password',
        'init':            'Initialise repository',
        'list-unreadable': 'Show unreadable files',
        'free-space':      'Show what is using the space',
        // Cockpit's header owns the switch; hangar cannot flip it from a page,
        // so the button says where to look rather than promising an escalation.
        'grant-access':      'How to grant access',
        'reauthorize':     'Sign in to the destination again',
        'retry':           'Try again'
    };

    function remediationLabel(err) {
        const r = Errors.remediationFor(err);
        return r ? (REMEDIATION_LABELS[r] || 'Fix this') : '';
    }

    // A READ_ERRORS result is a partial success. The files are wherever the
    // producer put them; all three shapes are accepted so no caller has to
    // reshape a non-failure into one.
    function unreadableFrom(err) {
        const d = err && err.detail;
        if (Array.isArray(d)) return d.map(str);
        if (d && typeof d === 'object') {
            if (Array.isArray(d.errors)) return d.errors.map(str);
            if (Array.isArray(d.files)) return d.files.map(str);
        }
        return [];
    }

    // The one place that decides failure-versus-partial. Every catch on this
    // screen goes through it, because a READ_ERRORS rendered in the red box is
    // exactly the mistake that teaches an operator to ignore the red box.
    function routeError(err) {
        return isPartial(err)
            ? { error: null, partial: err }
            : { error: err || null, partial: null };
    }

    function isPartial(err) {
        return Errors.isHangarError(err) && err.kind === Errors.KIND.READ_ERRORS;
    }

    // ------------------------------------------------------------- component

    function hasCockpit() {
        return typeof cockpit !== 'undefined' && !!cockpit;
    }

    function drJsonPath() {
        return typeof Config.drPath === 'function'
            ? Config.drPath() : Config.CONF_DIR + '/dr.json';
    }

    function hangarRecoveryUi() {
        return {
            // --- configuration -------------------------------------------
            form: defaultDrForm(),
            repos: [],
            loading: true,
            saving: false,
            saved: false,
            showPreview: false,

            // --- build ---------------------------------------------------
            building: false,
            progress: phaseLabel(null),
            iso: null,
            error: null,
            partial: null,
            showUnreadable: true,
            notice: '',
            // Which action to repeat when the remediation is 'retry'. Retrying a
            // failed save by building an image would be a different operation
            // wearing the same button.
            lastAction: 'build',

            // --- drill ---------------------------------------------------
            libvirt: { checked: false, available: false, reason: '' },
            drillOpts: Object.assign({}, DRILL_DEFAULTS),
            // The path of a rescue image hangar recorded and can no longer find.
            // Kept so the screen can say what happened rather than silently
            // dropping back to "no image yet".
            isoMissing: '',
            // Set when Build is asked to run against a /etc/rear/local.conf that
            // does not match this form.
            unwritten: false,
            drillRunning: false,
            runningPlan: null,
            // Set only when a drill was told to keep its disk. It is the one
            // thing hangar leaves on this machine, so it is also the one thing
            // the screen keeps mentioning until it is gone.
            keptDisk: '',
            // The guest's serial output, read from the file virt-install writes it
            // to. Kept apart from virt-install's own output so a tool error and a
            // guest message never overwrite one another.
            guestLog: '',
            drillLog: '',
            drillResult: null,
            drillError: null,
            drillCleaned: false,

            async init() {
                this.loading = true;
                try {
                    await this.loadRepos();
                    await this.loadConfig();
                    // AFTER loadConfig, never before: a location already written to
                    // /etc/rear/local.conf is the user's decision and outranks any
                    // default hangar would like to suggest.
                    await this.seedOutputUrl();
                    await this.seedHost();
                } catch (e) {
                    this.setError(e);
                }
                this.loading = false;
                // Probed after the screen is usable: the drill is optional and its
                // absence must never delay configuring recovery. Not awaited, so it
                // must not be able to reject either.
                try {
                    await this.probeLibvirt();
                    // Deliberately not awaited: a drill can have hours left to run,
                    // and the screen must finish loading either way.
                    this.adoptRunningDrill();
                } catch (e) {
                    this.libvirt = { checked: true, available: false,
                        reason: 'hangar could not determine whether libvirt is usable here.' };
                }
            },

            // Single funnel for every caught failure on this screen. READ_ERRORS
            // lands in `partial` and is rendered as a warning listing the files;
            // anything else lands in `error` and gets the remediation button.
            setError(e) {
                const routed = routeError(e);
                this.error = routed.error;
                this.partial = routed.partial;
                if (routed.partial) this.showUnreadable = true;
                return routed;
            },

            // Shown in place of an empty repository dropdown: the Recovery screen
            // cannot do anything useful without one, so it sends the user to the
            // screen that can and opens the form there.
            goCreateRepository() {
                if (typeof root.dispatchEvent !== 'function' || typeof root.CustomEvent !== 'function')
                    return false;
                root.dispatchEvent(new root.CustomEvent('hangar:go', { detail: { tab: 'repos' } }));
                root.dispatchEvent(new root.CustomEvent('hangar:new-repository'));
                return true;
            },

            // The ISO default follows the person using hangar, not root. cockpit
            // knows whose session this is; when it cannot say, ReaR's own default
            // is used and nothing changes.
            //
            // Only ever fills an EMPTY field: a path the user typed, or one already
            // written to /etc/rear/local.conf, is theirs and is left alone.
            async defaultOutputUrl() {
                if (typeof cockpit === 'undefined' || typeof cockpit.user !== 'function')
                    return Dr.DEFAULT_OUTPUT_URL;
                try {
                    const who = await cockpit.user();
                    return Dr.outputUrlForHome(who && who.home);
                } catch (e) {
                    return Dr.DEFAULT_OUTPUT_URL;
                }
            },

            // The field's placeholder promises "this machine's hostname"; without a
            // value the generated config carried no --host at all, so `restore
            // latest` in a shared repository could pick a snapshot written by a
            // different machine and restore it onto this one. Seeded from the same
            // name restic records in a snapshot.
            async seedHost() {
                if (str(this.form.host).trim() !== '') return false;
                if (typeof cockpit === 'undefined' || !cockpit.spawn) return false;
                try {
                    const name = str(await cockpit.spawn(['hostname'], { err: 'message' })).trim();
                    if (!name) return false;
                    this.form.host = name;
                    return true;
                } catch (e) {
                    return false;
                }
            },

            async seedOutputUrl() {
                if (str(this.form.outputUrl).trim() !== '') return false;
                this.form.outputUrl = await this.defaultOutputUrl();
                return true;
            },

            async loadRepos() {
                if (!hasCockpit()) return;
                const ids = await Config.listRepos();
                const out = [];
                for (const id of ids) {
                    try {
                        const repo = await Config.readRepo(id);
                        if (!repo) continue;
                        out.push({
                            id: id,
                            kind: str(repo.kind),
                            url: Repos.buildUrl(repo),
                            label: Repos.describe(repo)
                        });
                    } catch (e) {
                        // One unreadable repository definition must not hide the rest.
                        out.push({ id: id, kind: '', url: '', label: 'Could not read this repository definition.' });
                    }
                }
                this.repos = out;
            },

            async loadConfig() {
                if (!hasCockpit()) return;
                const stored = await Config.readJson(drJsonPath(), null);
                if (!stored) return;
                this.form = configToDrForm(stored);
                this.iso = stored.lastIso ? str(stored.lastIso) : null;
                // Remembered, not verified — until now. hangar went on saying
                // "Rescue image ready" and naming a file that had been deleted,
                // moved, or written to a USB stick and removed. That is the worst
                // thing this screen can get wrong: the whole point of the rescue
                // image is that it EXISTS when everything else does not.
                await this.verifyIso();
            },

            // --- derived -------------------------------------------------

            config() { return drFormToConfig(this.form); },

            // The shared folder/file picker. Two behaviours, deliberately:

            //   * a single-value field is REPLACED;

            //   * a multi-line field (one path per line) gets the choice APPENDED, because

            //     replacing a list of paths with one would quietly discard the rest.

            // Cancelling changes nothing in either case.

            async browsePath(fieldKey, opts) {

                const D = root.HangarDialogs;

                if (!D || typeof D.pickPath !== 'function') return false;

                const o = opts || {};

                const multi = !!o.multi;

                const bag = o.bag ? this[o.bag] : this.form;

                if (!bag) return false;

                const currentRaw = String(bag[fieldKey] || '');

                const lines = currentRaw.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);

                const picked = await D.pickPath({

                    mode: o.mode || 'dir',

                    title: o.title || '',

                    current: multi ? (lines[lines.length - 1] || '') : currentRaw.trim()

                });

                if (picked === null || picked === undefined) return false;

                if (!multi) { bag[fieldKey] = picked; return true; }

                if (lines.indexOf(picked) < 0) lines.push(picked);

                bag[fieldKey] = lines.join('\n');

                return true;

            },


            problems() { return Dr.validate(this.config()); },

            valid() { return this.problems().length === 0; },

            preview() {
                try {
                    return Dr.renderLocalConf(this.config());
                } catch (e) {
                    return null;
                }
            },

            selectedRepo() {
                const id = trim(this.form.repoId);
                if (!Array.isArray(this.repos)) return null;
                return this.repos.find(function (r) { return r && r.id === id; }) || null;
            },

            remoteRepo() { return trim(this.form.repoKind) !== 'local'; },

            // Selecting a repository fills in everything derivable from it, but
            // leaves the fields editable — a DR repository is sometimes a
            // deliberately different URL from the one the jobs use.
            onRepoChange() {
                const repo = this.selectedRepo();
                if (!repo) return;
                this.form.repoUrl = repo.url;
                this.form.repoKind = repo.kind;
                try {
                    this.form.keyPath = Secrets.keyPath(repo.id);
                } catch (e) {
                    this.form.keyPath = '';
                }
                this.saved = false;
            },

            // --- writing -------------------------------------------------

            async save() {
                this.error = null;
                this.notice = '';
                this.saved = false;
                this.lastAction = 'save';
                if (!this.valid()) return false;
                this.saving = true;
                try {
                    const cfg = this.config();
                    await Dr.writeLocalConf(cfg);
                    await Config.writeJson(drJsonPath(),
                        Object.assign({}, cfg, { lastIso: this.iso || null }));
                    this.saved = true;
                    return true;
                } catch (e) {
                    this.setError(e);
                    return false;
                } finally {
                    this.saving = false;
                }
            },

            // Does /etc/rear/local.conf match this form?
            //
            // `rear mkrescue` reads that file and knows nothing about what is typed
            // here. Building with unsaved changes silently produces an image from
            // the OLD configuration — which is how an image landed in
            // /var/lib/rear/output while the form said /home/operator, and how an image
            // got built with none of hangar's restic workflow in it at all.
            //
            // Returns true when they agree, false when they do not, and null when
            // the question cannot be answered — in which case the build proceeds,
            // because refusing on a failed check would block a legitimate build.
            async configMatchesDisk() {
                if (typeof cockpit === 'undefined' || !cockpit.file) return null;
                let wanted;
                try {
                    wanted = Dr.renderLocalConf(this.config());
                } catch (e) {
                    return null;                    // an invalid form is reported elsewhere
                }
                try {
                    const onDisk = await cockpit.file(Dr.LOCAL_CONF_PATH,
                        { superuser: 'require' }).read();
                    if (onDisk === null || onDisk === undefined) return false;
                    return str(onDisk).trim() === str(wanted).trim();
                } catch (e) {
                    return null;
                }
            },

            // --- building ------------------------------------------------

            async build() {
                this.error = null;
                this.partial = null;
                this.notice = '';
                this.drillResult = null;

                // Before anything is built, not after several minutes of it.
                const matches = await this.configMatchesDisk();
                if (matches === false) {
                    this.unwritten = true;
                    return null;
                }
                this.unwritten = false;

                this.building = true;
                this.lastAction = 'build';
                this.progress = phaseLabel(null);
                try {
                    const res = await Dr.mkrescue((parsed) => { this.progress = phaseLabel(parsed); });
                    this.iso = (res && res.iso) || null;
                    // A build answers the "the rescue image is gone" notice. Leaving
                    // it up beside a fresh "Rescue image ready" put two contradictory
                    // boxes on screen at once.
                    if (this.iso) this.isoMissing = '';
                    this.progress = phaseLabel(res && res.log);
                    await this.rememberIso();
                    return res;
                } catch (e) {
                    // READ_ERRORS means the image exists and some files did not read.
                    // setError is what keeps that out of the failure box.
                    const routed = this.setError(e);
                    // A partial build still produced an image, and the path is the
                    // one thing the operator needs from it.
                    if (routed.partial && e.detail && typeof e.detail === 'object' && e.detail.iso)
                        this.iso = str(e.detail.iso);
                    // Whatever ReaR printed is still the best thing on screen, even
                    // when — especially when — hangar could not interpret it.
                    if (e && e.detail && typeof e.detail === 'object')
                        this.progress = phaseLabel(e.detail);
                    return null;
                } finally {
                    this.building = false;
                }
            },

            async rememberIso() {
                if (!hasCockpit() || !this.iso) return;
                try {
                    const stored = await Config.readJson(drJsonPath(), {});
                    await Config.writeJson(drJsonPath(),
                        Object.assign({}, stored || {}, { lastIso: this.iso }));
                } catch (e) {
                    // Losing the remembered path only costs a re-browse next visit.
                }
            },

            // Read from both slots. A READ_ERRORS should never reach `error`, but if
            // one ever does, losing the file list is the one outcome that would make
            // the warning unactionable.
            unreadable() {
                const list = unreadableFrom(this.partial);
                return list.length ? list : unreadableFrom(isPartial(this.error) ? this.error : null);
            },

            remediation() { return Errors.remediationFor(this.error); },

            remediationLabel() { return remediationLabel(this.error); },

            async applyRemediation() {
                const what = this.remediation();
                if (!what) return;
                this.notice = '';
                if (what === 'retry') {
                    this.error = null;
                    return this.lastAction === 'save' ? this.save() : this.build();
                }
                if (what === 'reprompt') return this.repromptPassword();
                if (what === 'unlock') return this.resticFix('unlock', 'The repository lock has been released.');
                if (what === 'init') return this.resticFix('init', 'The repository has been initialised.');
                // 'list-unreadable' and 'free-space' are informational: the detail is
                // already on screen, so the button only has to reveal it.
                this.showUnreadable = true;
                return null;
            },

            async repromptPassword() {
                const repoId = trim(this.form.repoId);
                if (!repoId || !root.HangarDialogs) return null;
                let pw;
                try {
                    pw = await root.HangarDialogs.passwordDialog({
                        title: 'Repository password',
                        repoLabel: repoId
                    });
                } catch (e) {
                    // A dismissed dialog is a decision, not a failure.
                    return null;
                }
                if (!pw) return null;
                try {
                    await Secrets.writeKey(repoId, pw);
                    this.error = null;
                    this.notice = 'The repository password has been stored. Try the operation again.';
                } catch (e) {
                    this.setError(e);
                }
                return null;
            },

            async resticFix(op, done) {
                try {
                    await Restic.run(op, {
                        repoUrl: trim(this.form.repoUrl),
                        passwordFile: trim(this.form.keyPath) || Secrets.keyPath(trim(this.form.repoId))
                    });
                    this.error = null;
                    this.notice = done || 'Done. Try the operation again.';
                } catch (e) {
                    this.setError(e);
                }
                return null;
            },

            // --- the drill -----------------------------------------------

            async probeLibvirt() {
                if (!hasCockpit() || typeof cockpit.spawn !== 'function') {
                    this.libvirt = { checked: true, available: false,
                        reason: 'This page has no connection to a host, so the drill cannot run.' };
                    return this.libvirt;
                }
                try {
                    await cockpit.spawn(['virt-install', '--version'], { superuser: 'try', err: 'message' });
                } catch (e) {
                    this.libvirt = { checked: true, available: false,
                        reason: 'virt-install is not installed on this host.' };
                    return this.libvirt;
                }
                try {
                    await cockpit.spawn(['virsh', '-c', 'qemu:///system', 'version'],
                        { superuser: 'require', err: 'message' });
                } catch (e) {
                    this.libvirt = { checked: true, available: false,
                        reason: 'libvirtd is not running, or its system connection is not reachable.' };
                    return this.libvirt;
                }
                this.libvirt = { checked: true, available: true, reason: '' };
                return this.libvirt;
            },

            plan() {
                return drillPlan(this.iso, Object.assign({}, this.drillOpts || {}, {
                    libvirt: !!(this.libvirt && this.libvirt.available),
                    remoteRepo: this.remoteRepo()
                }));
            },

            planCommand() { return this.plan().argv.join(' '); },

            async runDrill() {
                const plan = this.plan();
                this.drillError = null;
                this.drillResult = null;
                this.drillLog = '';
                this.drillCleaned = false;
                if (!plan.ok) return null;

                if (!hasCockpit() || typeof cockpit.spawn !== 'function') {
                    this.drillError = Errors.create(Errors.KIND.GENERIC,
                        'cockpit is not available in this context.');
                    return null;
                }

                this.drillRunning = true;
                // Kept so "Stop the drill" and a close-while-running know which
                // domain to destroy: the form can be edited while it runs.
                this.runningPlan = plan;
                this.guestLog = '';
                let toolLog = '';
                let staged = null;
                this.drillStopping = false;
                try {
                    await this.prepareConsole(plan);
                    await this.prepareDiskDir(plan);

                    // Before virt-install spends a minute allocating a disk it
                    // will not be allowed to open.
                    const blocked = await this.blockedDiskParent(plan);
                    if (blocked) {
                        this.drillError = Errors.create(Errors.KIND.GENERIC,
                            'The drill disk cannot be created where you asked: ' + blocked +
                            ' is not readable by the qemu user, so the virtual machine could ' +
                            'not open its disk. A home directory is 0700 and blocks everything ' +
                            'beneath it. Choose a location outside any home directory — ' +
                            '/home/hangar-drill or /var/lib/libvirt/images both work.',
                            { blocked: blocked, diskPath: plan.diskPath });
                        return null;
                    }
                    // The plan's argv names the image; if it has to be staged, the
                    // copy replaces it in place so the command that runs is the
                    // command the dialog showed, bar the path.
                    staged = await this.stageIso(plan);
                    // Clear the way first. A drill that was interrupted — killed
                    // with its browser, or stopped by hand — leaves its domain
                    // DEFINED, and libvirt then refuses the next one outright:
                    //
                    //   ERROR Disk ... is already in use by other guests
                    //         ['hangar-drill']
                    //
                    // Observed on a real retry. Every step is allowed to fail:
                    // "nothing to clean" is the state we are trying to reach.
                    await this.cleanupDrill(plan);
                    this.drillCleaned = false;

                    // And start this drill's log empty. systemd APPENDS to it, so
                    // without this the verdict would be computed from every drill
                    // ever run: one old "Recovery is not possible" line would
                    // condemn a healthy restore for ever after. The finished log
                    // is kept — it is only cleared when a new drill replaces it.
                    try {
                        await cockpit.spawn(['rm', '-f', plan.toolLogPath],
                            { superuser: 'require', err: 'message' });
                    } catch (e) { /* a log that will not go is not worth failing over */ }

                    // systemd-run returns as soon as the unit has started; the
                    // drill itself now belongs to systemd, not to this page.
                    const launch = (staged && staged !== plan.iso)
                        ? plan.launch.map((a) => (a === plan.iso ? staged : a))
                        : plan.launch;
                    await cockpit.spawn(launch, { superuser: 'require', err: 'out' });
                    // The guest writes to a file now, so it has to be read WHILE the
                    // drill runs — otherwise the console box stays empty for the whole
                    // wait and the user cannot tell a working drill from a hung one.

                    toolLog = await this.watchDrill(plan);
                    this.drillResult = drillOutcome(this.drillLog);
                    // A unit that exited non-zero is an error even when the guest
                    // never said anything: virt-install refusing to start at all
                    // is the commonest way a drill goes wrong, and silence about
                    // it reads as "nothing happened".
                    const status = await this.unitExitStatus(plan);
                    if (status) {
                        this.drillError = Errors.create(Errors.KIND.GENERIC,
                            'The drill VM could not be run.',
                            { error: tailOf(splitLines(toolLog), 5) || ('exit status ' + status) });
                    }
                    return this.drillResult;
                } catch (e) {
                    // virt-install exiting non-zero is itself part of the answer, so
                    // the console is still parsed before the error is reported.
                    // A guest that said something before virt-install failed is
                    // still evidence; the tool's error is appended, not substituted.
                    const said = await this.readGuestConsole(plan);
                    if (said !== null) this.guestLog = said;
                    this.drillLog = joinLogs(toolLog || str(e && e.message), this.guestLog) ||
                        str(e && e.message);
                    this.drillResult = drillOutcome(this.drillLog);
                    this.drillError = Errors.isHangarError(e) ? e
                        : Errors.create(Errors.KIND.GENERIC, 'The drill VM could not be run.',
                            { error: str(e && e.message ? e.message : e) });
                    return this.drillResult;
                } finally {
                    // A staged copy is 900 MB of somebody's disk; it goes with the VM.
                    if (staged && staged !== plan.iso) {
                        try {
                            await cockpit.spawn(['rm', '-f', staged],
                                { superuser: 'require', err: 'message' });
                        } catch (e) { /* reported by the disk usage, not worth an alert */ }
                    }
                    this.drillRunning = false;
                    // Cleanup runs in a finally, so a throw here would replace the
                    // drill's verdict with a plumbing error. The verdict is the point.
                    try {
                        await this.cleanupDrill(plan);
                    } catch (e) { /* reported by drillCleaned staying false */ }
                    // cleanupDrill has run, so anything still on disk is there
                    // on purpose. Remember it: a 47 GB file nobody remembers is
                    // exactly what "a drill leaves nothing behind" must prevent.
                    this.keptDisk = (plan && plan.keepDisk) ? str(plan.diskPath) : '';
                }
            },

            // A drill boots the image and watches. If the image's own boot default
            // is "boot the hard disk" or "wait for a human", nothing happens: the
            // menu waits for a keypress that cannot arrive on a VM with no display,
            // burning a core until the timeout expires. Measured on a real host —
            // 100% of a CPU, zero bytes written to the target disk, in ten minutes.
            //
            // The safe default for a real rescue USB is exactly the one that makes a
            // drill useless, so this is a warning rather than a rule: hangar says
            // what will happen and lets the operator decide.
            drillWillWait() {
                return str(this.form.isoDefault || 'boothd') !== 'automatic';
            },

            // Confirms the remembered rescue image is still on disk. Clears the
            // record when it is not, so the screen offers a rebuild instead of a
            // promise it cannot keep. Never throws: a check that cannot run leaves
            // the record alone rather than discarding a good image.
            async verifyIso() {
                const path = str(this.iso).trim();
                if (!path) return false;
                if (typeof cockpit === 'undefined' || !cockpit.spawn) return false;
                try {
                    await cockpit.spawn(['test', '-f', path], { superuser: 'require', err: 'message' });
                    this.isoMissing = '';
                    return true;
                } catch (e) {
                    this.isoMissing = path;
                    this.iso = null;
                    return false;
                }
            },

            // Can the hypervisor actually READ the rescue image?
            //
            // qemu runs as its own user and has to traverse every directory in the
            // path. A rescue image delivered into a home directory cannot be read:
            // /home/<user> is 0700, so virt-install warns and the VM fails to boot —
            //
            //   WARNING /home/operator/localhost/rear-localhost.iso may not be
            //   accessible by the hypervisor. You will need to grant the 'qemu' user
            //   search permissions for the following directories …
            //
            // Rather than telling the operator to loosen the permissions on their
            // home directory, hangar stages a copy in the drill directory it
            // already owns — and removes it again with the rest of the drill.
            // The drill disk's directory has to exist, be traversable by the qemu
            // user, and be labelled for VM images. None of that is true of a path
            // someone types under their home: /home/<user> is 0700, and a
            // directory there carries a home label SELinux will not let qemu open.
            //
            // hangar makes it rather than telling the operator to chmod their home.
            // 0711: traversable by everyone, listable by nobody but root — the disk
            // inside is a copy of this machine's filesystem.
            async prepareDiskDir(plan) {
                const dir = plan && plan.diskPath &&
                    plan.diskPath.slice(0, plan.diskPath.lastIndexOf('/'));
                if (!dir || typeof cockpit === 'undefined' || !cockpit.spawn) return false;
                try {
                    await cockpit.spawn(['install', '-d', '-m', '0711', '-o', 'root', '-g', 'root', dir],
                        { superuser: 'require', err: 'message' });
                    // argv, never a shell string: `dir` is a free-text field, and
                    // this runs as root.
                    await cockpit.spawn(['chcon', '-t', 'svirt_image_t', '--', dir],
                        { superuser: 'require', err: 'message' }).catch(() => null);
                    return true;
                } catch (e) {
                    return false;               // virt-install reports it better than a guess would
                }
            },

            // Can qemu actually reach the drill disk?
            //
            // prepareDiskDir makes the directory traversable, but it cannot fix the
            // PARENTS: /home/<user> is 0700, so a location under a home is
            // unreachable however the leaf is chmodded. virt-install only says so
            // after allocating the disk —
            //
            //   Cannot access storage file '…' (as uid:107, gid:107): Permission denied
            //
            // — which is a minute of writing a 60 GB file to learn something
            // knowable in advance. Returns the directory that blocks it, or ''.
            async blockedDiskParent(plan) {
                const dir = plan && plan.diskPath &&
                    plan.diskPath.slice(0, plan.diskPath.lastIndexOf('/'));
                if (!dir || typeof cockpit === 'undefined' || !cockpit.spawn) return '';

                // Is the check itself usable? `/` is traversable by everyone, so a
                // failure here means there is no qemu user, no runuser, or no
                // privilege — not that the directory is unreachable. "Cannot tell"
                // must never become "refuse to run": the drill is what the operator
                // asked for, and virt-install reports the truth either way.
                try {
                    await cockpit.spawn(['runuser', '-u', 'qemu', '--', 'test', '-x', '/'],
                        { superuser: 'require', err: 'message' });
                } catch (e) {
                    return '';
                }

                // -x, not -w: qemu never creates the disk. libvirt creates it as
                // root and hands over the open file, so all qemu needs is to
                // TRAVERSE every directory on the way to it. Testing for write
                // access condemned hangar's own 0711 drill directory — and then
                // recommended it in the same sentence.
                const parts = dir.split('/').filter(Boolean);
                for (let i = 1; i <= parts.length; i++) {
                    const step = '/' + parts.slice(0, i).join('/');
                    try {
                        await cockpit.spawn(['runuser', '-u', 'qemu', '--', 'test', '-x', step],
                            { superuser: 'require', err: 'message' });
                    } catch (err) {
                        return step;            // the first one that blocks the way
                    }
                }
                return '';                      // every step is traversable
            },

            async stageIso(plan) {
                const iso = plan && plan.iso;
                if (!iso || typeof cockpit === 'undefined' || !cockpit.spawn) return null;
                try {
                    // Readable where it stands? Then use it as it is: copying 900 MB
                    // for nothing is not free.
                    await cockpit.spawn(['runuser', '-u', 'qemu', '--', 'test', '-r', iso],
                        { superuser: 'require', err: 'message' });
                    return iso;
                } catch (e) {
                    // Not readable, or there is no qemu user to ask as. Stage it.
                }
                const staged = DRILL_DIR + '/' + drillName(plan.name) + '.iso';
                try {
                    await cockpit.spawn(['install', '-m', '0644', iso, staged],
                        { superuser: 'require', err: 'message' });
                    await cockpit.spawn(['chcon', '-t', 'svirt_image_t', '--', staged],
                        { superuser: 'require', err: 'message' }).catch(() => null);
                    return staged;
                } catch (e) {
                    return null;                 // fall back to the original path
                }
            },

            // The guest console file must exist, and must be writable by the user
            // libvirt runs qemu as, BEFORE the domain starts — qemu creates nothing
            // in a directory it cannot write, and virt-install reports that as a
            // flat "Permission denied" after tearing the domain down again.
            //
            // Best effort by design: if this cannot be done the drill still runs and
            // simply has no guest console, which is a worse drill but not a broken
            // one. The verdict then comes from virt-install's own exit.
            async prepareConsole(plan) {
                const path = plan && plan.consolePath;
                if (!path || typeof cockpit === 'undefined' || !cockpit.spawn) return false;
                for (const group of QEMU_GROUPS) {
                    try {
                        // 0770, not 0710: libvirt cleans up the console file as the
                        // qemu user when the domain goes away, and unlinking needs
                        // WRITE on the directory, not just traverse. With 0710 the
                        // drill failed on its own cleanup —
                        //   ERROR Unable to delete file …-console.log: Permission denied
                        await cockpit.spawn(['install', '-d', '-m', '0770', '-o', 'root',
                            '-g', group, DRILL_DIR], { superuser: 'require', err: 'message' });
                        await cockpit.spawn(['install', '-m', '0660', '-o', 'root', '-g', group,
                            '/dev/null', path], { superuser: 'require', err: 'message' });
                        // SELinux, on a host where it is enforcing, is the rest of the
                        // problem: the file inherits var_lib_t from its directory and
                        // qemu (svirt_t) may not write or unlink that, whatever the
                        // Unix permissions say. libvirt relabels the DISKS it manages
                        // but not a serial chardev target, so hangar labels it.
                        //
                        // restorecon would be exactly wrong here — it would reset the
                        // label to the one the directory implies, which is the one
                        // that does not work. Best effort: a host without SELinux has
                        // no chcon and needs none.
                        // argv, never a shell string: the path is built from a
                        // VM name the operator types. A missing chcon rejects and
                        // is caught, which is the same outcome the old `command -v`
                        // guard produced without handing a shell anything to parse.
                        await cockpit.spawn(['chcon', '-t', 'svirt_image_t', '--', DRILL_DIR, path],
                            { superuser: 'require', err: 'message' }).catch(() => null);
                        return group;
                    } catch (e) {
                        // Wrong group for this distribution — try the next one.
                    }
                }
                return false;
            },

            // Never throws and never reports a failure: the console file does not
            // exist until the guest writes its first line, and "not there yet" is
            // the normal state for the first few seconds of every drill.
            async readGuestConsole(plan) {
                const path = plan && plan.consolePath;
                if (!path || typeof cockpit === 'undefined' || !cockpit.file) return null;
                try {
                    const text = await cockpit.file(path, { superuser: 'require' }).read();
                    // Decoded here rather than at display time: drillOutcome reads
                    // this text looking for what the rescue system said, and the
                    // words it needs are the ones buried in the escape sequences.
                    return text === null || text === undefined ? null : decodeConsole(text);
                } catch (e) {
                    return null;
                }
            },

            // The drill's own failures get an action too, otherwise a NETWORK or
            // REPO_LOCKED surfacing through virt-install would be a dead-end alert.
            drillRemediation() { return Errors.remediationFor(this.drillError); },

            drillRemediationLabel() { return remediationLabel(this.drillError); },

            async applyDrillRemediation() {
                const what = this.drillRemediation();
                if (!what) return null;
                if (what === 'retry') { this.drillError = null; return this.runDrill(); }
                if (what === 'reprompt') return this.repromptPassword();
                if (what === 'unlock') return this.resticFix('unlock', 'The repository lock has been released.');
                if (what === 'init') return this.resticFix('init', 'The repository has been initialised.');
                return null;
            },

            // A drill that leaves a domain and a 20 GB disk behind is not a drill,
            // it is a mess. Failures here are ignored on purpose: `destroy` on an
            // already-stopped domain is an error and means nothing.
            // Ending a drill on purpose. Separate from stopDrillGuest, which is
            // the automatic path: this one asks first, because a drill that is
            // still restoring has work to lose.
            //
            // hangar's confirm dialog resolves ONLY when the operator accepts —
            // cancelling leaves the promise pending for ever, which is why every
            // destructive step in this file sits after the await rather than
            // behind an `if`. Getting that backwards would delete on cancel.
            async abortDrill() {
                if (!this.drillRunning) return false;
                const D = root.HangarDialogs;
                if (!D || typeof D.confirmDialog !== 'function') return false;
                await D.confirmDialog({
                    title: 'Stop the drill?',
                    message: 'Destroy the drill VM and remove its disk.',
                    detail: 'Nothing on this machine is affected, but the drill will '
                        + 'not be able to tell you whether recovery works.',
                    danger: true,
                    confirmLabel: 'Stop the drill'
                });
                await this.stopDrillGuest(this.runningPlan || { name: this.drillOpts.name });
                return true;
            },

            // The X and Close both come here. The dialog is hidden FIRST and the
            // question asked after: closing is what the operator just asked for,
            // and the question is only about the VM. Waiting for an answer that
            // never comes — cancel does not resolve — would have pinned the
            // dialog open on "leave it running".
            //
            // A drill outlives this dialog quite happily; reopening the screen
            // picks it back up.
            async closeDrill() {
                const running = this.drillRunning;
                this.hideDrill();
                if (!running) return this.offerToRemoveKeptDisk();
                const D = root.HangarDialogs;
                if (!D || typeof D.confirmDialog !== 'function') return false;
                await D.confirmDialog({
                    title: 'The drill is still running',
                    message: 'Stop it and remove the drill VM?',
                    detail: 'Leave this alone and the drill keeps running in the '
                        + 'background; the Recovery screen picks it up again.',
                    danger: true,
                    confirmLabel: 'Stop the drill',
                    cancelLabel: 'Leave it running'
                });
                await this.stopDrillGuest(this.runningPlan || { name: this.drillOpts.name });
                await this.offerToRemoveKeptDisk();
                return true;
            },

            // A separate question from stopping the VM, because they are
            // separate decisions: one ends a drill, the other reclaims the
            // space of a whole restored system.
            async offerToRemoveKeptDisk() {
                if (!this.keptDisk) return false;
                const D = root.HangarDialogs;
                if (!D || typeof D.confirmDialog !== 'function') return false;
                await D.confirmDialog({
                    title: 'Remove the drill disk?',
                    message: 'Delete ' + str(this.keptDisk) + '.',
                    detail: 'It was kept so the recovery log inside it could be read. '
                        + 'Nothing else uses it, and it is as large as the system that '
                        + 'was restored.',
                    danger: true,
                    confirmLabel: 'Remove it'
                });
                return this.removeKeptDisk();
            },

            async removeKeptDisk() {
                const target = str(this.keptDisk);
                if (!target || !hasCockpit() || typeof cockpit.spawn !== 'function') return false;
                try {
                    await cockpit.spawn(['rm', '-f', target],
                        { superuser: 'require', err: 'message' });
                    this.keptDisk = '';
                    return true;
                } catch (e) {
                    this.setError(e);
                    return false;
                }
            },

            // Is the drill's unit still there? --collect removes it once it has
            // exited, so "not active" and "gone" are the same answer.
            async unitRunning(plan) {
                if (!hasCockpit() || typeof cockpit.spawn !== 'function') return false;
                try {
                    const out = await cockpit.spawn(
                        ['systemctl', 'is-active', str(plan && plan.unit)],
                        { superuser: 'require', err: 'message' });
                    return str(out).trim() === 'active';
                } catch (e) {
                    // is-active exits non-zero for inactive, failed and unknown.
                    return false;
                }
            },

            // Watch a drill until it answers, ends, or runs out of time. Used
            // both by the run that started it and by a page that found one
            // already running — which is the whole point of it being a unit.
            // Returns whatever the unit has written so far.
            async watchDrill(plan) {
                let toolLog = '';
                const deadline = Date.now() + plan.timeoutMin * 60000;
                // Read first, sleep after: the screen shows the guest's first words
                // immediately rather than two seconds late, and a drill that is
                // already over is noticed at once.
                while (Date.now() < deadline) {
                    toolLog = str(await this.readFileOrEmpty(plan.toolLogPath));
                    const text = await this.readGuestConsole(plan);
                    if (text !== null) this.guestLog = text;
                    this.drillLog = joinLogs(toolLog, this.guestLog);
                    this.drillResult = drillOutcome(this.drillLog);
                    if (this.drillResult && this.drillResult.decisive) {
                        await this.stopDrillGuest(plan);
                        break;
                    }
                    if (!(await this.unitRunning(plan))) break;
                    await sleep(GUEST_POLL_MS);
                }
                // One last read: the guest's final words land after the unit has
                // already gone.
                toolLog = str(await this.readFileOrEmpty(plan.toolLogPath));
                const last = await this.readGuestConsole(plan);
                if (last !== null) this.guestLog = last;
                this.drillLog = joinLogs(toolLog, this.guestLog);
                return toolLog;
            },

            // A drill outlives the page that started it, so a page that opens
            // while one is running has to say so — otherwise the operator sees an
            // idle screen and starts a second drill on top of the first.
            async adoptRunningDrill() {
                if (this.drillRunning) return false;
                const plan = this.plan();
                if (!(await this.unitRunning(plan))) return false;
                this.drillRunning = true;
                this.runningPlan = plan;
                this.drillError = null;
                this.drillCleaned = false;
                try {
                    await this.watchDrill(plan);
                } finally {
                    this.drillRunning = false;
                    try {
                        await this.cleanupDrill(plan);
                    } catch (e) { /* reported by drillCleaned staying false */ }
                    this.keptDisk = plan.keepDisk ? str(plan.diskPath) : '';
                }
                return true;
            },

            // systemd keeps the exit status of a finished unit until it is reset.
            // Anything unreadable counts as "no complaint": a missing status must
            // never invent a failure.
            async unitExitStatus(plan) {
                if (!hasCockpit() || typeof cockpit.spawn !== 'function') return 0;
                try {
                    const out = await cockpit.spawn(
                        ['systemctl', 'show', '--value', '-p', 'ExecMainStatus',
                            str(plan && plan.unit)],
                        { superuser: 'require', err: 'message' });
                    const n = parseInt(str(out).trim(), 10);
                    return Number.isFinite(n) ? n : 0;
                } catch (e) {
                    return 0;
                }
            },

            async readFileOrEmpty(path) {
                if (!path || typeof cockpit === 'undefined' || !cockpit.file) return '';
                try {
                    const text = await cockpit.file(path, { superuser: 'require' }).read();
                    return text === null || text === undefined ? '' : str(text);
                } catch (e) {
                    return '';
                }
            },

            hideDrill() {
                const doc = root.document;
                const el = doc && doc.getElementById('hangar-recovery-drill');
                if (el && root.bootstrap)
                    root.bootstrap.Modal.getOrCreateInstance(el).hide();
            },

            // Destroy the guest, once, without touching the disk or the
            // domain definition — cleanupDrill still does that afterwards. This
            // only ends the wait: `virt-install --wait` returns as soon as the
            // domain is gone, so the normal finish-and-clean path runs exactly
            // as it would have on a timeout.
            // Ask the guest to shut down, and only cut its power if it will not.
            //
            // `virsh destroy` is a power cut. Stopping a drill the moment its
            // verdict appears therefore threw away whatever the guest had not
            // yet flushed — measured on a real drill: the restored system had
            // ReaR's late finalize writes but NOT the recovery log ReaR copies
            // in as its very last act. Everything older than the writeback
            // interval survived; the last few seconds did not.
            //
            // A drill that ends this way also never shows whether the restored
            // filesystems unmount cleanly, which is part of what it is meant to
            // be testing.
            async stopDrillGuest(plan) {
                if (this.drillStopping) return false;
                this.drillStopping = true;
                if (typeof cockpit === 'undefined' || !cockpit.spawn) return false;
                const name = drillName(plan.name);
                const run = (argv) => cockpit.spawn(argv,
                    { superuser: 'require', err: 'message' });

                try {
                    await run(['virsh', 'shutdown', name]);
                } catch (e) {
                    // No domain to shut down, or ACPI refused. Fall through: the
                    // destroy below is the answer to both.
                }

                // The rescue system is idle at its menu by now, so this is quick
                // when it works at all. It is bounded because a guest that
                // ignores ACPI must not hold the drill open for ever.
                for (let i = 0; i < GUEST_SHUTDOWN_TRIES; i++) {
                    let state = '';
                    try {
                        state = str(await run(['virsh', 'domstate', name])).trim();
                    } catch (e) {
                        return true;                    // domain is gone: done
                    }
                    if (state === 'shut off' || state === '') return true;
                    await sleep(GUEST_POLL_MS);
                }

                try {
                    await run(['virsh', 'destroy', name]);
                    return true;
                } catch (e) {
                    // Already gone, or libvirt refused: the timeout is still there
                    // as a backstop, so this is not worth an alert.
                    return false;
                }
            },

            async cleanupDrill(plan) {
                const p = plan || this.plan();
                if (!hasCockpit() || typeof cockpit.spawn !== 'function') return;
                const steps = Array.isArray(p && p.cleanup) ? p.cleanup : [];
                for (const argv of steps) {
                    try {
                        await cockpit.spawn(argv, { superuser: 'require', err: 'message' });
                    } catch (e) { /* nothing left to clean is the desired state */ }
                }
                this.drillCleaned = true;
            }
        };
    }

    const api = {
        // component
        hangarRecoveryUi,
        // pure
        defaultDrForm, drFormToConfig, configToDrForm,
        phaseLabel, drillPlan, drillOutcome, drillName, joinLogs, decodeConsole, isSavedConfig,
        remediationLabel, unreadableFrom, isPartial, routeError,
        splitList, joinList,
        // constants
        PHASE_LABELS, UNRECOGNISED_LABEL, DRILL_DEFAULTS, DRILL_LABELS,
        DRILL_OUTCOMES, REMEDIATION_LABELS,
        MIN_MEMORY_MB, MAX_MEMORY_MB, MAX_VCPUS, MAX_DISK_GB, MAX_TIMEOUT_MIN
    };

    root.hangarRecoveryUi = hangarRecoveryUi;
    root.HangarRecoveryUi = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
