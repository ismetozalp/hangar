// core/dr.js — bare-metal disaster recovery via ReaR.
//
// ReaR has no restic workflow. Upstream calls BACKUP=EXTERNAL "not a real
// integration in ReaR, but rather a last resort" and offers no maintainer
// support for it. hangar generates that configuration so the unsupported part is
// never hand-written by a user who then owns the consequences.
//
// Two rules drive everything below:
//   1. /etc/rear/local.conf is SOURCED BY BASH. Every interpolated value is
//      shell-quoted. A repository path is attacker-influenced input as soon as
//      it comes from an imported config, so quoting here is correctness AND
//      privilege escalation containment.
//   2. ReaR emits no JSON. Known markers are matched and nothing else is
//      interpreted: unrecognised output is surfaced verbatim rather than guessed
//      at, because a wrong guess about a recovery tool is worse than no guess.
'use strict';
(function (root) {
    // Under node the sibling module is required relative to this file; in the
    // browser errors.js has already run and put HangarErrors on the global.
    const Errors = (typeof module !== 'undefined' && module.exports)
        ? require('./errors.js')
        : root.HangarErrors;

    const LOCAL_CONF_PATH = '/etc/rear/local.conf';

    // ReaR mounts the system being recovered here. Not configurable: it is
    // ReaR's own TARGET_FS_ROOT and changing it desynchronises the two.
    const TARGET_FS_ROOT = '/mnt/local';

    // Where the rescue ISO lands when nothing is configured. /var/lib/rear/output
    // is ReaR's own default and is a poor one for a person: it is root-only, easy
    // to forget, and the one file you must be able to find and copy to a USB stick
    // BEFORE the machine you built it on is unavailable. The home directory of the
    // operator who asked for it is somewhere they can actually reach.
    const DEFAULT_OUTPUT_DIR = '/var/lib/rear/output';

    // Pure: the ReaR OUTPUT_URL for a home directory, or the old default when the
    // home is unknown or unusable. ReaR takes a URL, not a path.
    function outputUrlForHome(home) {
        const dir = str(home).trim().replace(/\/+$/, '');
        // Absolute, no traversal, and never '/': this string ends up in a config
        // file that a rescue shell sources as root.
        if (!dir || dir.charAt(0) !== '/' || dir === '/' || dir.split('/').indexOf('..') >= 0)
            return 'file://' + DEFAULT_OUTPUT_DIR;
        if (/[\u0000-\u001f'"\\]/.test(dir)) return 'file://' + DEFAULT_OUTPUT_DIR;
        return 'file://' + dir;
    }

    const DEFAULT_OUTPUT_URL = 'file://' + DEFAULT_OUTPUT_DIR;

    // The repository password lives beside the repository definition. Duplicated
    // from the layout in docs/CONVENTIONS.md rather than imported, so core/dr.js
    // has no dependency on the module that will later own secrets.
    const KEY_DIR = '/etc/hangar/repos';

    // Backing up "/" with restic pulls in the kernel's virtual filesystems and,
    // for a local repository, the repository itself — which would grow without
    // bound. restic applies no implicit excludes, so they must be explicit.
    const DEFAULT_EXCLUDES = [
        '/proc', '/sys', '/dev', '/run',
        '/tmp', '/var/tmp',
        '/mnt', '/media', '/lost+found',
        '/var/lib/rear/output'
    ];

    const DEFAULT_BACKUP_PATHS = ['/'];

    const DR_TAG = 'hangar-dr';

    const ISO_DEFAULT_VALUES = ['boothd', 'manual', 'automatic'];

    const REPO_KINDS = ['local', 'sftp', 'rest', 's3', 'b2', 'azure', 'gs', 'rclone'];

    const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

    // ReaR URL schemes for OUTPUT_URL / BACKUP_URL. "null" is ReaR's documented
    // way of saying "produce nothing".
    const REAR_URL_RE = /^(file|nfs|cifs|usb|sftp|ftp|ftps|rsync|tape|davfs|iso):\/\//i;

    const TAIL_LINES = 40;

    // ---------------------------------------------------------------- helpers

    // The config arrives from JSON.parse of /etc/hangar/dr.json, and JSON can
    // express an object whose `toString` and `valueOf` are strings rather than
    // functions — String() on that throws TypeError. Every value here is
    // untrusted, so an unconvertible one becomes the empty string and is then
    // rejected by validate() as a typed problem, never as a raw TypeError.
    function str(v) {
        if (v === null || v === undefined) return '';
        try { return String(v); } catch (e) { return ''; }
    }

    function blank(v) {
        return str(v).trim() === '';
    }

    function hasCtrl(v) {
        return /[\x00-\x1f\x7f]/.test(str(v));
    }

    function hasTraversal(p) {
        return str(p).split('/').indexOf('..') >= 0;
    }

    function fail(message, detail) {
        throw Errors.create(Errors.KIND.GENERIC, message, detail === undefined ? null : detail);
    }

    // ---------------------------------------------------------------- quoting

    const ANSI_C = { '\\': '\\\\', '\'': '\\\'', '\n': '\\n', '\r': '\\r', '\t': '\\t' };

    // $'...' is the only quoting form that can carry a control character without
    // putting a literal newline into a line-oriented config file. Bash does no
    // parameter, command or arithmetic expansion inside it, so $(...), `...` and
    // ${...} stay inert exactly as they do inside '...'.
    function ansiCQuote(s) {
        let out = '';
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (ANSI_C[ch] !== undefined) { out += ANSI_C[ch]; continue; }
            const code = s.charCodeAt(i);
            if (code < 0x20 || code === 0x7f) {
                out += '\\x' + (code < 0x10 ? '0' : '') + code.toString(16);
                continue;
            }
            out += ch;
        }
        return '$\'' + out + '\'';
    }

    // Single quotes are the strongest form bash has: nothing inside them is
    // special, not even a backslash. The only thing that can end the string is a
    // single quote, so it is closed, escaped and reopened.
    function shQuote(v) {
        const s = str(v);
        if (hasCtrl(s)) return ansiCQuote(s);
        return '\'' + s.replace(/'/g, '\'\\\'\'') + '\'';
    }

    function keyPathFor(repoId) {
        return KEY_DIR + '/' + str(repoId) + '.key';
    }

    // ---------------------------------------------------------------- validate

    function validate(cfg) {
        const problems = [];
        if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg))
            return ['Disaster recovery configuration is missing.'];

        if (blank(cfg.repoId)) problems.push('Disaster recovery requires a repository id.');
        else if (!ID_RE.test(str(cfg.repoId)))
            problems.push('Repository id may only contain lowercase letters, digits and hyphens.');

        if (blank(cfg.repoUrl)) problems.push('Disaster recovery requires a repository URL.');
        else if (hasCtrl(cfg.repoUrl)) problems.push('Repository URL must not contain control characters.');

        if (!blank(cfg.repoKind) && REPO_KINDS.indexOf(str(cfg.repoKind)) < 0)
            problems.push('Unknown repository kind: ' + str(cfg.repoKind) + '.');

        if (!blank(cfg.outputUrl) && !REAR_URL_RE.test(str(cfg.outputUrl)))
            problems.push('OUTPUT_URL must be a ReaR URL such as file:///var/lib/rear/output.');

        if (!blank(cfg.backupUrl) && !REAR_URL_RE.test(str(cfg.backupUrl)))
            problems.push('BACKUP_URL must be a ReaR URL such as nfs://server/export.');

        if (cfg.backupPaths !== undefined && cfg.backupPaths !== null) {
            if (!Array.isArray(cfg.backupPaths) || cfg.backupPaths.length === 0)
                problems.push('Disaster recovery needs at least one backup path.');
            else if (cfg.backupPaths.some(function (p) { return !/^\//.test(str(p)); }))
                problems.push('Backup paths must be absolute.');
        }

        // A rescue system that cannot reach the key file cannot restore, and a
        // relative COPY_AS_IS entry resolves against ReaR's build directory, not
        // against anything the administrator was looking at.
        [['excludes', 'Exclude'], ['extraCopyAsIs', 'COPY_AS_IS']].forEach(function (pair) {
            const v = cfg[pair[0]];
            if (v === undefined || v === null) return;
            if (!Array.isArray(v)) { problems.push(pair[1] + ' list must be an array.'); return; }
            if (v.some(function (p) { return !/^\//.test(str(p)); }))
                problems.push(pair[1] + ' paths must be absolute.');
            if (v.some(hasTraversal))
                problems.push(pair[1] + ' paths must not contain "..".');
        });

        if (cfg.extraRequiredProgs !== undefined && cfg.extraRequiredProgs !== null &&
            !Array.isArray(cfg.extraRequiredProgs))
            problems.push('Required programs list must be an array.');

        if (!blank(cfg.keyPath)) {
            if (!/^\//.test(str(cfg.keyPath))) problems.push('Repository key path must be absolute.');
            else if (hasTraversal(cfg.keyPath)) problems.push('Repository key path must not contain "..".');
            if (hasCtrl(cfg.keyPath)) problems.push('Repository key path must not contain control characters.');
        }

        if (!blank(cfg.excludeFile)) {
            if (!/^\//.test(str(cfg.excludeFile))) problems.push('Exclude file must be an absolute path.');
            else if (hasTraversal(cfg.excludeFile)) problems.push('Exclude file must not contain "..".');
            if (hasCtrl(cfg.excludeFile)) problems.push('Exclude file must not contain control characters.');
        }

        if (!blank(cfg.isoDefault) && ISO_DEFAULT_VALUES.indexOf(str(cfg.isoDefault)) < 0)
            problems.push('ISO_DEFAULT must be one of: ' + ISO_DEFAULT_VALUES.join(', ') + '.');

        if (cfg.userInputTimeout !== undefined && cfg.userInputTimeout !== null) {
            const t = Number(cfg.userInputTimeout);
            // Safe, not merely integral: Number.isInteger(1e21) is true but
            // String(1e21) is "1e+21", which ReaR would read as a word rather
            // than a count of seconds.
            if (!Number.isSafeInteger(t) || t < 0)
                problems.push('User input timeout must be a whole number of seconds.');
        }

        if (cfg.autoshrinkPercent !== undefined && cfg.autoshrinkPercent !== null
                && str(cfg.autoshrinkPercent) !== '') {
            const p = Number(cfg.autoshrinkPercent);
            // A percentage of a disk size: above 100 is meaningless, and ReaR
            // compares it against a byte difference, so a fraction would be
            // silently truncated by the shell arithmetic it lands in.
            if (!Number.isSafeInteger(p) || p < 0 || p > 100)
                problems.push('Shrink limit must be a whole percentage between 0 and 100.');
        }

        return problems;
    }

    // ------------------------------------------------------------ local.conf

    // One element per line so a reviewer can see exactly what each word expands
    // to, with "--flag value" kept together because splitting a pair across lines
    // is what makes a long argv unreadable in the first place.
    function arrayBlock(assignment, values) {
        const lines = [assignment + '('];
        for (let i = 0; i < values.length; i++) {
            const cur = str(values[i]);
            const next = i + 1 < values.length ? str(values[i + 1]) : null;
            if (cur.slice(0, 2) === '--' && next !== null && next.slice(0, 2) !== '--') {
                lines.push('    ' + shQuote(cur) + ' ' + shQuote(next));
                i++;
            } else {
                lines.push('    ' + shQuote(cur));
            }
        }
        lines.push(')');
        return lines.join('\n');
    }

    // Must equal CACHE_DIR in js/engine/restic.js; tests/smoke.mjs checks that.
    const RESTIC_CACHE_DIR = '/var/cache/hangar/restic';

    function resticGlobalArgs(repoUrl, keyPath) {
        return ['restic', '--repo', repoUrl, '--password-file', keyPath];
    }

    function backupArgv(cfg, repoUrl, keyPath) {
        // --cache-dir for the same reason every other hangar path passes it: this
        // runs from ReaR, which is not a login shell, and restic exits 1 rather
        // than backing anything up when it cannot place its cache.
        const argv = resticGlobalArgs(repoUrl, keyPath)
            .concat(['--cache-dir', RESTIC_CACHE_DIR, 'backup', '--tag', DR_TAG]);
        // The same --exclude-file a backup job uses. A machine's exclusions are a
        // property of the machine, not of one job: keeping them in one file means
        // the disaster-recovery snapshot and the nightly one skip the same things,
        // and editing the file changes both. Without this the DR path would happily
        // include the hundreds of gigabytes a job was told to leave out.
        if (!blank(cfg.excludeFile)) {
            argv.push('--exclude-file');
            argv.push(str(cfg.excludeFile));
        }
        let excludes = Array.isArray(cfg.excludes) ? cfg.excludes.map(str) : DEFAULT_EXCLUDES.slice();
        // A local repository sitting inside the tree being backed up would be
        // fed its own growth on every run.
        if (str(cfg.repoKind) === 'local' && excludes.indexOf(repoUrl) < 0) excludes = excludes.concat([repoUrl]);
        excludes.forEach(function (e) { argv.push('--exclude'); argv.push(e); });
        return argv.concat(backupPaths(cfg));
    }

    // Shared by both legs on purpose. The restore leg asks restic for the newest
    // snapshot covering these paths, so if the two ever computed them
    // differently, recovery would silently select the wrong snapshot.
    function backupPaths(cfg) {
        return Array.isArray(cfg.backupPaths) && cfg.backupPaths.length
            ? cfg.backupPaths.map(str) : DEFAULT_BACKUP_PATHS.slice();
    }

    function restoreArgv(cfg, repoUrl, keyPath) {
        // --no-cache, not --cache-dir: this one runs inside the rescue system,
        // where /var/cache/hangar does not exist and may not be creatable. restic
        // refuses to start when it can neither find nor make a cache, and the one
        // place that must never happen is a recovery. A cache would only have sped
        // up a second run there, and there is no second run.
        const argv = resticGlobalArgs(repoUrl, keyPath).concat(['--no-cache', 'restore', 'latest']);
        // Without --host, "latest" can select a snapshot written by a different
        // machine into the same repository and restore it onto this one.
        if (!blank(cfg.host)) { argv.push('--host'); argv.push(str(cfg.host)); }
        // --host alone is not enough to identify the right snapshot. hangar keeps
        // every job in one repository under one hostname, so "latest" is simply
        // the newest snapshot ANY job wrote — and if a job backs up a subset,
        // say /home, that subset becomes the thing a recovery restores. The
        // result is a machine with no /usr and no /etc, reported as a success.
        //
        // restic: "snapshots must include all specified paths", so this asks for
        // the newest snapshot that covers the same roots this config backs up.
        //
        // Deliberately NOT --tag hangar-dr, which is the tighter filter and the
        // wrong one: EXTERNAL_BACKUP only runs during `rear mkbackup`, so an
        // image built with `rear mkrescue` has no hangar-dr snapshot to find and
        // recovery would fail outright with nothing to restore. Filtering by
        // path accepts an ordinary scheduled backup, which is usually the most
        // recent copy of this machine anyway.
        backupPaths(cfg).forEach(function (p) { argv.push('--path'); argv.push(p); });
        argv.push('--target');
        argv.push(TARGET_FS_ROOT);
        return argv;
    }

    function requiredProgs(cfg) {
        const progs = ['restic'];
        // restic's sftp backend execs ssh, and its rclone backend execs rclone.
        // Neither is in the rescue initramfs unless it is named here.
        if (str(cfg.repoKind) === 'sftp') progs.push('ssh');
        if (str(cfg.repoKind) === 'rclone') progs.push('rclone');
        if (Array.isArray(cfg.extraRequiredProgs))
            cfg.extraRequiredProgs.map(str).forEach(function (p) {
                if (progs.indexOf(p) < 0) progs.push(p);
            });
        return progs;
    }

    function copyAsIs(cfg, keyPath) {
        const paths = [keyPath];
        // The exclude file goes into the rescue system with the key: a rescue
        // shell that reruns the backup step must be able to read the same
        // exclusions, and a missing --exclude-file is a hard error in restic.
        if (!blank(cfg.excludeFile)) paths.push(str(cfg.excludeFile));
        if (str(cfg.repoKind) === 'sftp') paths.push('/root/.ssh/');
        if (str(cfg.repoKind) === 'rclone') paths.push('/root/.config/rclone/');
        if (Array.isArray(cfg.extraCopyAsIs))
            cfg.extraCopyAsIs.map(str).forEach(function (p) {
                if (paths.indexOf(p) < 0) paths.push(p);
            });
        return paths;
    }

    function renderLocalConf(cfg) {
        const problems = validate(cfg);
        if (problems.length)
            fail('Disaster recovery configuration is invalid: ' + problems.join(' '), problems);

        const repoUrl = str(cfg.repoUrl);
        const keyPath = blank(cfg.keyPath) ? keyPathFor(cfg.repoId) : str(cfg.keyPath);
        const outputUrl = blank(cfg.outputUrl) ? DEFAULT_OUTPUT_URL : str(cfg.outputUrl);
        const isoDefault = blank(cfg.isoDefault) ? 'boothd' : str(cfg.isoDefault);
        const timeout = (cfg.userInputTimeout === undefined || cfg.userInputTimeout === null)
            ? 30 : Number(cfg.userInputTimeout);

        const out = [];
        // ASCII only: this file is read in a rescue shell with an unknown locale.
        out.push('# ' + LOCAL_CONF_PATH + ' - generated by hangar. Do not edit by hand.');
        out.push('#');
        out.push('# ReaR has no restic workflow. BACKUP=EXTERNAL is documented upstream as a');
        out.push('# last resort with no maintainer support; hangar owns this file so that');
        out.push('# unsupported part is generated, tested and reproducible instead of');
        out.push('# hand-written. Anything added below is lost the next time hangar writes it.');
        out.push('');
        out.push('OUTPUT=ISO');
        out.push('OUTPUT_URL=' + shQuote(outputUrl));
        out.push('');
        // The rescue system talks to the serial port as well as the screen. On real
        // hardware this costs nothing and helps anyone recovering over a BMC or a
        // serial cable; in the drill it is the ONLY way hangar hears what happened,
        // because a VM booted by virt-install has no screen anybody is watching.
        //
        // Without it the drill runs perfectly and reports nothing, which reads as a
        // failure and is really a deaf observer.
        out.push('USE_SERIAL_CONSOLE=1');
        // `auto_recover` is what actually starts the restore, and on UEFI it has
        // to be put here by hand. ReaR adds it for ISO_DEFAULT='automatic' only
        // while writing the syslinux menu; the GRUB2 entry it builds for UEFI is
        // plain `linux $kernel root=UUID=... $KERNEL_CMDLINE` with nothing added
        // (lib/bootloader-functions.sh, create_grub2_rear_boot_entry). Without
        // this the rescue system boots to a login prompt and waits forever.
        //
        // Deliberately not `unattended`, which reboots after a successful
        // recovery: the drill VM boots the ISO first, so it would recover, boot
        // the ISO again, and recover again — the endless cycle ReaR warns about
        // in default.conf. `auto_recover` stops after the restore.
        out.push('KERNEL_CMDLINE=' + shQuote('console=tty0 console=ttyS0,115200n8'
            + (isoDefault === 'automatic' ? ' auto_recover' : '')));
        out.push('');
        out.push('BACKUP=EXTERNAL');
        if (blank(cfg.backupUrl)) {
            out.push('# BACKUP_URL is unset on purpose: EXTERNAL_BACKUP and EXTERNAL_RESTORE move');
            out.push('# the data themselves, so ReaR has no transport of its own to configure.');
        } else {
            out.push('BACKUP_URL=' + shQuote(str(cfg.backupUrl)));
        }
        out.push('');
        out.push('# restic reads the live filesystem directly, so ReaR has nothing to mount');
        out.push('# before the backup step runs.');
        out.push('EXTERNAL_SOURCE_MOUNTED=1');
        out.push('');
        out.push('# restic exit 3 means the snapshot WAS written and only some files were');
        out.push('# unreadable. Failing the whole rescue build on that would teach the operator');
        out.push('# to ignore genuine errors.');
        out.push('EXTERNAL_IGNORE_ERRORS=1');
        out.push('');
        out.push(arrayBlock('EXTERNAL_BACKUP=', backupArgv(cfg, repoUrl, keyPath)));
        out.push('');
        out.push(arrayBlock('EXTERNAL_RESTORE=', restoreArgv(cfg, repoUrl, keyPath)));
        out.push('');
        out.push('# The rescue system is a fresh initramfs: a binary or file not named here does');
        out.push('# not exist at recovery time, and by then the restore cannot be retried.');
        out.push(arrayBlock('REQUIRED_PROGS+=', requiredProgs(cfg)));
        out.push(arrayBlock('COPY_AS_IS+=', copyAsIs(cfg, keyPath)));
        // COPY_AS_IS alone does not get root's ssh key into the rescue system.
        // ReaR defaults to SSH_FILES='avoid_sensitive_files', which copies only
        // authorized_keys and known_hosts from /root/.ssh and drops every
        // private key — sensible for a rescue image somebody might leave lying
        // around, and fatal for an unattended restore over sftp: ssh finds no
        // key, falls back to asking, and the recovery stops dead at
        //
        //   backup@nas.example's password:
        //
        // with no terminal to answer it. Naming the files explicitly is the one
        // form ReaR treats as "copy exactly what is specified"
        // (rescue/default/500_ssh.sh).
        //
        // This does mean the rescue image carries a key that can log into the
        // backup server. It already carries the repository password, so the
        // image must be handled as a secret either way.
        if (str(cfg.repoKind) === 'sftp') {
            out.push(arrayBlock('SSH_FILES=', ['/root/.ssh/']));
            // And it still would not be there. ReaR copies the key, then
            // build/default/501_check_ssh_keys.sh hunts through the rescue root
            // for private keys with no passphrase and DELETES them, because
            // SSH_UNPROTECTED_PRIVATE_KEYS defaults to 'no'.
            //
            // An unattended restore cannot type a passphrase, so the key it
            // needs is necessarily unprotected. Keeping it is the only way the
            // recovery can authenticate — and the reason the finished image has
            // to be treated as a credential, not just a boot disk.
            out.push("SSH_UNPROTECTED_PRIVATE_KEYS='yes'");
        }
        out.push('');
        out.push('# Rescue system behaviour.');
        out.push('ISO_DEFAULT=' + shQuote(isoDefault));
        // ISO_DEFAULT alone only steers the syslinux menu, which is what a BIOS
        // machine boots. A UEFI machine boots the GRUB2 menu, and that reads two
        // different variables — so a config carrying only ISO_DEFAULT boots UEFI
        // hardware straight past the rescue system into the disk it was meant to
        // rebuild. Both spellings are written so the ISO behaves the same either
        // way it is booted.
        //
        // GRUB2_DEFAULT_BOOT defaults to "chainloader" ("Boot next EFI"), and
        // GRUB2_TIMEOUT is set from USER_INPUT_TIMEOUT inside default.conf —
        // which is sourced BEFORE this file, so setting USER_INPUT_TIMEOUT here
        // never reaches it and the menu keeps GRUB's own 300s.
        out.push('GRUB2_DEFAULT_BOOT=' + shQuote(isoDefault === 'boothd' ? 'chainloader' : 'rear'));
        // Zero means opposite things to the two bootloaders. To syslinux it
        // disables the countdown and waits for a human indefinitely; to GRUB it
        // means boot the default at once without even showing the menu. Left
        // untranslated, "wait for me" on a BIOS machine becomes "don't wait" on
        // a UEFI one — which is the exact class of bug this block exists to fix.
        // GRUB spells the indefinite wait -1.
        out.push('GRUB2_TIMEOUT=' + shQuote(timeout > 0 ? String(timeout) : '-1'));
        if (!blank(cfg.isoPrefix)) out.push('ISO_PREFIX=' + shQuote(str(cfg.isoPrefix)));
        if (!blank(cfg.isoVolid)) out.push('ISO_VOLID=' + shQuote(str(cfg.isoVolid)));
        out.push('USER_INPUT_TIMEOUT=' + shQuote(String(timeout)));
        // How much smaller a replacement disk may be before ReaR refuses to
        // shrink the last partition. ReaR's default is 2%, which stops a
        // recovery onto a disk that is merely a different model of "1 TB".
        //
        // Only written when the operator asked for it, because raising it is a
        // real decision: ReaR shrinks the last PARTITION, and nothing else. If
        // that partition holds LVM, the volumes inside are still recreated at
        // their recorded sizes — the first one that does not fit is retried with
        // '-l 100%FREE' and every volume after it fails outright. A disk that is
        // substantially smaller needs a hand-adapted disklayout.conf, which is
        // what ReaR's own documentation says.
        if (!blank(cfg.autoshrinkPercent))
            out.push('AUTOSHRINK_DISK_SIZE_LIMIT_PERCENTAGE=' + shQuote(String(Number(cfg.autoshrinkPercent))));
        out.push('# Without DHCP the rescue system has no route to a remote repository, and a');
        out.push('# restore that cannot reach the repository is not a recovery.');
        out.push('USE_DHCLIENT=' + shQuote(cfg.useDhclient === false ? 'no' : 'yes'));
        out.push('KEEP_BUILD_DIR=' + shQuote(cfg.keepBuildDir === true ? 'Yes' : 'No'));
        out.push('');
        return out.join('\n');
    }

    // ------------------------------------------------------------- log parsing

    // ReaR's log file prefixes each line with a timestamp; its terminal output
    // does not. Both are parsed by the same code, so the prefix is removed first.
    const TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+/;

    // KNOWN markers only. Every entry here is a literal ReaR message prefix; the
    // percentages are declared milestones, not measurements, because ReaR reports
    // no progress of its own. Order matters: the first match on a line wins, so
    // specific prefixes precede the generic ones they share a first word with.
    const PHASES = [
        { re: /^Wrote ISO image\b/,                phase: 'done',      percent: 100 },
        { re: /^Making ISO image\b/,               phase: 'iso',       percent: 85 },
        { re: /^Making\b/,                         phase: 'iso',       percent: 80 },
        { re: /^Creating recovery\/rescue system/, phase: 'initramfs', percent: 70 },
        { re: /^Creating root filesystem layout\b/, phase: 'rootfs',   percent: 25 },
        { re: /^Creating disk layout\b/,           phase: 'layout',    percent: 15 },
        { re: /^Creating\b/,                       phase: 'creating',  percent: 20 },
        { re: /^Copying\b/,                        phase: 'copying',   percent: 45 },
        { re: /^Relax-and-Recover\b/,              phase: 'starting',  percent: 5 }
    ];

    const ERROR_RE = /^(?:ERROR|BUG):/;

    function splitLines(text) {
        // A trailing newline is a terminator, not an empty final line.
        const s = str(text).replace(/\r?\n$/, '');
        if (s === '') return [];
        return s.split(/\r?\n/);
    }

    function strip(line) {
        return line.replace(TS_RE, '');
    }

    function tailOf(lines) {
        return lines.slice(Math.max(0, lines.length - TAIL_LINES)).join('\n');
    }

    function parseRearLog(text) {
        const lines = splitLines(text);
        const errors = [];
        let phase = 'unknown';
        let percent = 0;

        lines.forEach(function (raw) {
            const line = strip(raw);
            if (ERROR_RE.test(line)) { errors.push(line); return; }
            for (let i = 0; i < PHASES.length; i++) {
                if (!PHASES[i].re.test(line)) continue;
                // Milestones only advance. ReaR prints "Copying resulting files"
                // AFTER "Wrote ISO image", so last-match-wins would walk backwards.
                if (PHASES[i].percent >= percent) {
                    phase = PHASES[i].phase;
                    percent = PHASES[i].percent;
                }
                return;
            }
        });

        // Always carried, not only on failure: the UI has nothing else to show for
        // output this module deliberately refuses to interpret.
        return { phase: phase, percent: percent, errors: errors, rawTail: tailOf(lines) };
    }

    // A parenthesised size follows the path in ReaR's message. Only a group that
    // actually looks like a size is stripped, so a path containing parentheses
    // survives intact rather than being truncated by a guess.
    function stripSize(s) {
        const m = /^(.*\S)\s+\(([^()]*)\)$/.exec(s);
        if (m && /^[0-9][0-9.,]*\s*[A-Za-z]*$/.test(m[2].trim())) return m[1];
        return s;
    }

    // Where ReaR DELIVERED the image, which is not where it built it.
    //
    // ReaR always builds into its own output directory and then, if OUTPUT_URL
    // points somewhere else, copies the result there — into a subdirectory named
    // after the host. Its log says both:
    //
    //   Wrote ISO image: /var/lib/rear/output/rear-localhost.iso (905M)
    //   Copying result files '/var/lib/rear/output/rear-localhost.iso …'
    //       to /home/operator/localhost at file location
    //
    // hangar reported the first and sent people to a path that is not where their
    // rescue image ended up. The copy destination wins when there is one: that is
    // the file to put on a USB stick.
    function isoPathFrom(text) {
        let built = null;
        let deliveredDir = null;
        splitLines(text).forEach(function (raw) {
            const line = strip(raw);
            const wrote = /^Wrote ISO image:\s*(\S.*)$/.exec(line);
            if (wrote) {
                built = stripSize(wrote[1].trim());   // last one wins: a rerun supersedes
                return;
            }
            // The quoted file list can contain anything, so the destination is
            // read from the end of the line rather than by splitting on spaces.
            const copied = /^Copying result files\b.*\bto\s+(\S.*?)(?:\s+at\s+\S+\s+location)?$/.exec(line);
            if (copied) deliveredDir = copied[1].trim();
        });
        if (built === null || built === '') return null;
        if (!deliveredDir) return built;
        // Only a plain local directory: a URL destination (nfs://, sftp://) is not
        // a path anybody can open here, so the built file is the honest answer.
        if (deliveredDir.charAt(0) !== '/') return built;
        const name = built.slice(built.lastIndexOf('/') + 1);
        if (!name) return built;
        return deliveredDir.replace(/\/+$/, '') + '/' + name;
    }

    // ---------------------------------------------------------------- I/O layer
    // Thin by design. Everything above is pure and testable under node; nothing
    // below is reachable without cockpit.

    function hasCockpit() {
        return typeof cockpit !== 'undefined' && !!cockpit;
    }

    function noCockpit() {
        return Promise.reject(Errors.create(Errors.KIND.GENERIC, 'cockpit is not available in this context.'));
    }

    function writeLocalConf(cfg, path) {
        let text;
        try { text = renderLocalConf(cfg); } catch (e) { return Promise.reject(e); }
        if (!hasCockpit() || !cockpit.file) return noCockpit();
        return cockpit.file(path || LOCAL_CONF_PATH, { superuser: 'require' }).replace(text);
    }

    function readLocalConf(path) {
        if (!hasCockpit() || !cockpit.file) return noCockpit();
        return cockpit.file(path || LOCAL_CONF_PATH, { superuser: 'require' }).read();
    }

    // `rear -v mkrescue` streams to stderr as well as stdout, so err:'out' keeps
    // the two interleaved in the order ReaR printed them - the order the raw tail
    // has to preserve to be worth surfacing.
    function mkrescue(onProgress) {
        if (!hasCockpit() || !cockpit.spawn) return noCockpit();
        let buffer = '';
        const proc = cockpit.spawn(['rear', '-v', 'mkrescue'], { superuser: 'require', err: 'out' });
        if (typeof onProgress === 'function' && proc.stream) {
            proc.stream(function (chunk) {
                buffer += chunk;
                onProgress(parseRearLog(buffer));
            });
        }
        return proc.then(function (out) {
            const text = out || buffer;
            const parsed = parseRearLog(text);
            const iso = isoPathFrom(text);
            if (!iso)
                throw Errors.create(Errors.KIND.GENERIC, 'ReaR did not report an ISO image.', parsed);
            return { iso: iso, log: parsed };
        }, function (err) {
            const parsed = parseRearLog(buffer || (err && err.message) || '');
            throw Errors.create(Errors.KIND.GENERIC, 'rear mkrescue failed.', parsed);
        });
    }

    const HangarDr = {
        LOCAL_CONF_PATH, TARGET_FS_ROOT, DEFAULT_OUTPUT_URL, DEFAULT_OUTPUT_DIR,
        outputUrlForHome, DEFAULT_EXCLUDES,
        DEFAULT_BACKUP_PATHS, DR_TAG, ISO_DEFAULT_VALUES, REPO_KINDS, TAIL_LINES, PHASES,
        // pure
        shQuote, keyPathFor, validate, renderLocalConf, parseRearLog, isoPathFrom,
        // I/O
        writeLocalConf, readLocalConf, mkrescue
    };
    root.HangarDr = HangarDr;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarDr;
})(typeof window !== 'undefined' ? window : globalThis);
