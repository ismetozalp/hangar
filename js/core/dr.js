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

    const DEFAULT_OUTPUT_URL = 'file:///var/lib/rear/output';

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

    function resticGlobalArgs(repoUrl, keyPath) {
        return ['restic', '--repo', repoUrl, '--password-file', keyPath];
    }

    function backupArgv(cfg, repoUrl, keyPath) {
        const argv = resticGlobalArgs(repoUrl, keyPath).concat(['backup', '--tag', DR_TAG]);
        let excludes = Array.isArray(cfg.excludes) ? cfg.excludes.map(str) : DEFAULT_EXCLUDES.slice();
        // A local repository sitting inside the tree being backed up would be
        // fed its own growth on every run.
        if (str(cfg.repoKind) === 'local' && excludes.indexOf(repoUrl) < 0) excludes = excludes.concat([repoUrl]);
        excludes.forEach(function (e) { argv.push('--exclude'); argv.push(e); });
        const paths = Array.isArray(cfg.backupPaths) && cfg.backupPaths.length
            ? cfg.backupPaths.map(str) : DEFAULT_BACKUP_PATHS.slice();
        return argv.concat(paths);
    }

    function restoreArgv(cfg, repoUrl, keyPath) {
        const argv = resticGlobalArgs(repoUrl, keyPath).concat(['restore', 'latest']);
        // Without --host, "latest" can select a snapshot written by a different
        // machine into the same repository and restore it onto this one.
        if (!blank(cfg.host)) { argv.push('--host'); argv.push(str(cfg.host)); }
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
        out.push('');
        out.push('# Rescue system behaviour.');
        out.push('ISO_DEFAULT=' + shQuote(isoDefault));
        if (!blank(cfg.isoPrefix)) out.push('ISO_PREFIX=' + shQuote(str(cfg.isoPrefix)));
        if (!blank(cfg.isoVolid)) out.push('ISO_VOLID=' + shQuote(str(cfg.isoVolid)));
        out.push('USER_INPUT_TIMEOUT=' + shQuote(String(timeout)));
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

    function isoPathFrom(text) {
        let found = null;
        splitLines(text).forEach(function (raw) {
            const m = /^Wrote ISO image:\s*(\S.*)$/.exec(strip(raw));
            if (m) found = stripSize(m[1].trim());   // last one wins: a rerun supersedes
        });
        return found === null || found === '' ? null : found;
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
        LOCAL_CONF_PATH, TARGET_FS_ROOT, DEFAULT_OUTPUT_URL, DEFAULT_EXCLUDES,
        DEFAULT_BACKUP_PATHS, DR_TAG, ISO_DEFAULT_VALUES, REPO_KINDS, TAIL_LINES, PHASES,
        // pure
        shQuote, keyPathFor, validate, renderLocalConf, parseRearLog, isoPathFrom,
        // I/O
        writeLocalConf, readLocalConf, mkrescue
    };
    root.HangarDr = HangarDr;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarDr;
})(typeof window !== 'undefined' ? window : globalThis);
