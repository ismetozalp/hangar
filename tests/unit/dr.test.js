// tests/unit/dr.test.js — HangarDr: ReaR local.conf generation (golden files),
// shell-injection containment, config validation and marker-only log parsing.
//
// Fixture note: everything under tests/fixtures/rear/ is SYNTHETIC — hand-written
// in ReaR's documented message format, not captured from a real `rear mkrescue`
// run on this host (rear is not installed here). Hence the synthetic- prefix.
//
// The injection tests do not assert on the generated text alone: they write the
// file out and source it with a REAL bash, then assert both that the value came
// back byte-identical and that the canary command never ran. Asserting on the
// rendering only would prove that hangar quotes the way hangar expects to quote.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const Dr = require('../../js/core/dr.js');
const Errors = require('../../js/core/errors.js');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const GOLDEN = path.join(FIXTURES, 'golden');
const REAR = path.join(FIXTURES, 'rear');

function fixture(name) {
    return fs.readFileSync(path.join(REAR, name), 'utf8');
}

const BASE = { repoId: 'nas-1', repoUrl: '/srv/backups', repoKind: 'local', host: 'db01' };

function render(extra) {
    return Dr.renderLocalConf(Object.assign({}, BASE, extra || {}));
}

function assertGeneric(fn) {
    assert.throws(fn, (e) => {
        assert.ok(Errors.isHangarError(e), 'expected a HangarError, got ' + e);
        assert.equal(e.kind, Errors.KIND.GENERIC);
        return true;
    });
}

// Source `conf` with a real bash and print one array element back out. Anything
// the generated file executes leaves its trace in `dir`.
function sourceAndRead(dir, conf, expr) {
    const confPath = path.join(dir, 'local.conf');
    fs.writeFileSync(confPath, conf);
    const script = 'REQUIRED_PROGS=(); COPY_AS_IS=(); source "$1"; printf %s "' + expr + '"';
    return execFileSync('bash', ['-c', script, 'bash', confPath], { encoding: 'utf8' });
}

function tmpdir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-dr-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

// ------------------------------------------------------------ golden files

test('renderLocalConf matches the golden local-repository local.conf', () => {
    assert.equal(render(), fs.readFileSync(path.join(GOLDEN, 'rear-local.conf'), 'utf8'));
});

test('renderLocalConf matches the golden sftp local.conf', () => {
    const cfg = {
        repoId: 'offsite-nas', repoUrl: 'sftp:backup@nas.lan:/vol/restic', repoKind: 'sftp', host: 'db01',
        outputUrl: 'nfs://nas.lan/export/rear', backupUrl: 'nfs://nas.lan/export/rear',
        isoPrefix: 'rear-db01', isoVolid: 'REAR-DB01', isoDefault: 'manual',
        userInputTimeout: 0, keepBuildDir: true,
        backupPaths: ['/', '/boot'], extraCopyAsIs: ['/etc/hangar/'], extraRequiredProgs: ['sftp']
    };
    assert.equal(Dr.renderLocalConf(cfg), fs.readFileSync(path.join(GOLDEN, 'rear-sftp.conf'), 'utf8'));
});

test('renderLocalConf emits every directive the EXTERNAL integration depends on', () => {
    const conf = render();
    ['OUTPUT=ISO', 'BACKUP=EXTERNAL', 'EXTERNAL_SOURCE_MOUNTED=1', 'EXTERNAL_IGNORE_ERRORS=1',
        'EXTERNAL_BACKUP=(', 'EXTERNAL_RESTORE=(', 'REQUIRED_PROGS+=(', 'COPY_AS_IS+=(']
        .forEach((d) => assert.ok(conf.split('\n').some((l) => l === d || l.startsWith(d)),
            'missing directive ' + d));
    assert.match(conf, /^OUTPUT_URL='file:\/\/\/var\/lib\/rear\/output'$/m);
});

test('renderLocalConf output is pure ASCII so a rescue shell in any locale can read it', () => {
    assert.match(render(), /^[\x09\x0a\x20-\x7e]*$/);
});

test('renderLocalConf output ends with exactly one trailing newline', () => {
    const conf = render();
    assert.ok(conf.endsWith('\n'));
    assert.ok(!conf.endsWith('\n\n'));
});

test('renderLocalConf is deterministic for the same config', () => {
    assert.equal(render(), render());
});

// ------------------------------------------------------ rendering behaviour

test('renderLocalConf excludes a local repository from its own backup', () => {
    assert.match(render(), /'--exclude' '\/srv\/backups'/);
});

test('renderLocalConf does not self-exclude for a remote repository', () => {
    const conf = Dr.renderLocalConf({ repoId: 'r', repoUrl: 'sftp:nas.lan:/vol/r', repoKind: 'sftp' });
    assert.equal(conf.includes("'--exclude' 'sftp:nas.lan:/vol/r'"), false);
});

test('renderLocalConf excludes the kernel virtual filesystems by default', () => {
    const conf = render();
    Dr.DEFAULT_EXCLUDES.forEach((e) => assert.ok(conf.includes("'--exclude' '" + e + "'"), 'missing ' + e));
});

test('renderLocalConf lets custom excludes replace the defaults entirely', () => {
    const conf = render({ excludes: ['/var/cache'] });
    assert.ok(conf.includes("'--exclude' '/var/cache'"));
    assert.equal(conf.includes("'--exclude' '/proc'"), false);
});

test('renderLocalConf restores latest into /mnt/local', () => {
    assert.match(render(), /'restore'\n {4}'latest'\n[\s\S]*? {4}'--target' '\/mnt\/local'/);
});

// --host is not enough. hangar keeps every job in one repository under one
// hostname, so "latest" is the newest snapshot ANY job wrote. Seen in a real
// repository: two snapshots, both host=localhost.localdomain, tagged 'nightly'
// — neither tagged hangar-dr. Had one of those jobs been backing up /home only,
// recovery would have restored a machine with no /usr and no /etc and called it
// a success.
test('the restore leg will not accept a snapshot that omits what is backed up', () => {
    const conf = render({ backupPaths: ['/', '/boot'] });
    const restore = conf.slice(conf.indexOf('EXTERNAL_RESTORE=('));
    assert.ok(restore.includes("'--path' '/'"), 'restore must require the backed-up roots');
    assert.ok(restore.includes("'--path' '/boot'"));
});

// The two legs must ask about the same paths, or recovery selects a snapshot
// that does not match what was saved.
test('backup and restore agree on the paths, whatever they are', () => {
    [['/'], ['/', '/boot'], ['/srv', '/etc']].forEach((paths) => {
        const conf = render({ backupPaths: paths });
        const cut = conf.indexOf('EXTERNAL_RESTORE=(');
        const restore = conf.slice(cut);
        paths.forEach((p) => {
            assert.ok(conf.slice(0, cut).includes("    '" + p + "'"),
                'backup leg must save ' + p);
            assert.ok(restore.includes("'--path' '" + p + "'"),
                'restore leg must require ' + p);
        });
    });
});

// The tighter filter is the wrong one: EXTERNAL_BACKUP runs only during
// `rear mkbackup`, so an image built with `rear mkrescue` has no hangar-dr
// snapshot at all and a tag filter would leave recovery with nothing to find.
test('the restore leg does not demand a DR-tagged snapshot that may not exist', () => {
    const conf = render();
    const restore = conf.slice(conf.indexOf('EXTERNAL_RESTORE=('));
    assert.ok(!restore.includes("'--tag'"),
        'a tag filter makes recovery fail when only scheduled backups exist');
});

test('renderLocalConf pins the snapshot host so latest cannot select another machine', () => {
    assert.ok(render({ host: 'web02' }).includes("'--host' 'web02'"));
});

test('renderLocalConf omits --host when no host is configured', () => {
    assert.equal(render({ host: '' }).includes("'--host'"), false);
    assert.equal(Dr.renderLocalConf({ repoId: 'r', repoUrl: '/srv/b' }).includes("'--host'"), false);
});

test('renderLocalConf adds ssh and /root/.ssh/ only for the sftp backend', () => {
    const sftp = Dr.renderLocalConf({ repoId: 'r', repoUrl: 'sftp:nas.lan:/v', repoKind: 'sftp' });
    assert.ok(sftp.includes("    'ssh'"));
    assert.ok(sftp.includes("    '/root/.ssh/'"));
    assert.equal(render().includes("'/root/.ssh/'"), false);
    assert.equal(render().includes("    'ssh'"), false);
});

test('renderLocalConf adds rclone and its config directory only for the rclone backend', () => {
    const rc = Dr.renderLocalConf({ repoId: 'r', repoUrl: 'rclone:gdrive:b', repoKind: 'rclone' });
    assert.ok(rc.includes("    'rclone'"));
    assert.ok(rc.includes("    '/root/.config/rclone/'"));
    assert.equal(render().includes('/root/.config/rclone/'), false);
});

test('renderLocalConf comments out BACKUP_URL when there is none and sets it when there is', () => {
    assert.match(render(), /^# BACKUP_URL is unset on purpose/m);
    assert.equal(/^BACKUP_URL=/m.test(render()), false);
    assert.match(render({ backupUrl: 'nfs://nas.lan/export' }), /^BACKUP_URL='nfs:\/\/nas\.lan\/export'$/m);
});

test('renderLocalConf uses an explicit keyPath in both the argv and COPY_AS_IS', () => {
    const conf = render({ keyPath: '/etc/hangar/keys/other.key' });
    assert.ok(conf.includes("'--password-file' '/etc/hangar/keys/other.key'"));
    assert.ok(conf.includes("    '/etc/hangar/keys/other.key'"));
    assert.equal(conf.includes('/etc/hangar/repos/nas-1.key'), false);
});

test('renderLocalConf does not repeat a COPY_AS_IS or REQUIRED_PROGS entry it already has', () => {
    const conf = Dr.renderLocalConf(Object.assign({}, BASE, {
        extraCopyAsIs: ['/etc/hangar/repos/nas-1.key'], extraRequiredProgs: ['restic']
    }));
    // Two argvs plus the array itself — never four, which is what a missing
    // duplicate check would produce.
    assert.equal(conf.split("'/etc/hangar/repos/nas-1.key'").length - 1, 3);
    assert.equal(conf.split("\n    'restic'").length - 1, 3);
});

test('renderLocalConf toggles USE_DHCLIENT and KEEP_BUILD_DIR', () => {
    assert.match(render(), /^USE_DHCLIENT='yes'$/m);
    assert.match(render(), /^KEEP_BUILD_DIR='No'$/m);
    assert.match(render({ useDhclient: false, keepBuildDir: true }), /^USE_DHCLIENT='no'$/m);
    assert.match(render({ useDhclient: false, keepBuildDir: true }), /^KEEP_BUILD_DIR='Yes'$/m);
});

test('renderLocalConf emits ISO_PREFIX and ISO_VOLID only when configured', () => {
    assert.equal(/^ISO_(PREFIX|VOLID)=/m.test(render()), false);
    const conf = render({ isoPrefix: 'rear-db01', isoVolid: 'REAR' });
    assert.match(conf, /^ISO_PREFIX='rear-db01'$/m);
    assert.match(conf, /^ISO_VOLID='REAR'$/m);
});

test('renderLocalConf accepts every documented ISO_DEFAULT value', () => {
    Dr.ISO_DEFAULT_VALUES.forEach((v) =>
        assert.match(render({ isoDefault: v }), new RegExp('^ISO_DEFAULT=\'' + v + '\'$', 'm')));
});

// ISO_DEFAULT steers the syslinux menu, which is what a BIOS machine boots. A
// UEFI machine boots GRUB2, which reads two entirely different variables — so a
// config carrying only ISO_DEFAULT sends UEFI hardware straight past the rescue
// system and into the disk it was supposed to rebuild. Observed on a real drill:
// the menu defaulted to "Boot next EFI" on a 300s timer while the config said
// ISO_DEFAULT='automatic' and USER_INPUT_TIMEOUT='30'.
test('the rescue menu behaves the same whether it boots via BIOS or UEFI', () => {
    const conf = render({ isoDefault: 'automatic', userInputTimeout: 45 });
    assert.match(conf, /^ISO_DEFAULT='automatic'$/m);
    assert.match(conf, /^GRUB2_DEFAULT_BOOT='rear'$/m,
        'GRUB2 defaults to "chainloader" (Boot next EFI) unless told otherwise');
    assert.match(conf, /^GRUB2_TIMEOUT='45'$/m,
        'GRUB2_TIMEOUT is expanded in default.conf before local.conf is read, '
        + 'so USER_INPUT_TIMEOUT alone never reaches it');
});

// "Wait for a human" is 0 to syslinux and -1 to GRUB; 0 tells GRUB to boot at
// once without showing the menu. Passed through unchanged, a config asking the
// rescue system to wait would do the opposite on UEFI.
test('waiting for a human means waiting on both bootloaders', () => {
    const conf = render({ userInputTimeout: 0 });
    assert.match(conf, /^USER_INPUT_TIMEOUT='0'$/m);
    assert.match(conf, /^GRUB2_TIMEOUT='-1'$/m,
        "GRUB reads 0 as 'boot immediately, show nothing'");
});

test('booting the hard disk is honoured on UEFI as well as BIOS', () => {
    assert.match(render({ isoDefault: 'boothd' }), /^GRUB2_DEFAULT_BOOT='chainloader'$/m);
});

// ReaR adds `auto_recover` to the kernel line for ISO_DEFAULT='automatic' only
// while writing the SYSLINUX menu; its GRUB2 entry is plain
// `linux $kernel root=UUID=... $KERNEL_CMDLINE`. Without this the rescue system
// boots on UEFI and sits at a login prompt forever.
test('automatic recovery actually starts on a UEFI machine', () => {
    assert.match(render({ isoDefault: 'automatic' }),
        /^KERNEL_CMDLINE='[^']*\bauto_recover\b[^']*'$/m);
});

test('a manual rescue system is not turned into an automatic one', () => {
    ['boothd', 'manual'].forEach((v) => {
        assert.ok(!/\bauto_recover\b/.test(render({ isoDefault: v })),
            v + ' must not start a recovery on its own');
    });
});

// `unattended` reboots after a successful recovery. The drill VM boots the ISO
// first, so that would recover, reboot, boot the ISO, and recover again — the
// endless cycle ReaR warns about in default.conf.
test('the rescue system never reboots itself into another recovery', () => {
    assert.ok(!/\bunattended\b/.test(render({ isoDefault: 'automatic' })));
});

// ReaR refuses to recover onto a disk more than AUTOSHRINK_DISK_SIZE_LIMIT_PERCENTAGE
// smaller than the original (default 2%), which stops a recovery onto a
// replacement disk that is merely a different model of the same nominal size.
test('the shrink limit is only written when the operator asked for one', () => {
    assert.ok(!render().includes('AUTOSHRINK_DISK_SIZE_LIMIT_PERCENTAGE'),
        "an unset field must leave ReaR's own default alone");
    assert.match(render({ autoshrinkPercent: 90 }),
        /^AUTOSHRINK_DISK_SIZE_LIMIT_PERCENTAGE='90'$/m);
});

test('a blank shrink limit is the same as not setting one', () => {
    ['', '   '].forEach((v) => assert.ok(
        !render({ autoshrinkPercent: v }).includes('AUTOSHRINK_DISK_SIZE_LIMIT_PERCENTAGE')));
});

test('validate rejects a shrink limit that is not a whole percentage', () => {
    [101, -1, 1.5, 'lots', '10%'].forEach((v) => {
        assert.deepEqual(Dr.validate(Object.assign({}, BASE, { autoshrinkPercent: v })),
            ['Shrink limit must be a whole percentage between 0 and 100.'],
            'accepted ' + JSON.stringify(v));
    });
    [0, 2, 100, '50'].forEach((v) => {
        assert.deepEqual(Dr.validate(Object.assign({}, BASE, { autoshrinkPercent: v })), [],
            'rejected ' + JSON.stringify(v));
    });
});

test('renderLocalConf throws a fatal GENERIC HangarError on an invalid config', () => {
    assertGeneric(() => Dr.renderLocalConf({}));
    assertGeneric(() => Dr.renderLocalConf(null));
    assertGeneric(() => Dr.renderLocalConf({ repoId: 'NAS', repoUrl: '/srv/b' }));
    try {
        Dr.renderLocalConf({ repoId: 'x' });
        assert.fail('expected a throw');
    } catch (e) {
        assert.equal(Errors.isFatal(e), true);
        assert.ok(Array.isArray(e.detail));
        assert.ok(e.detail.length > 0);
    }
});

test('renderLocalConf output is syntactically valid bash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-dr-'));
    try {
        [render(), render({ repoKind: 'sftp', repoUrl: 'sftp:u@h:/p' }),
            render({ backupUrl: 'nfs://h/e', isoPrefix: 'p', isoVolid: 'v' })].forEach((conf, i) => {
            const p = path.join(dir, 'c' + i + '.conf');
            fs.writeFileSync(p, conf);
            execFileSync('bash', ['-n', p]);
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// --------------------------------------------------------- shell injection
//
// /etc/rear/local.conf is sourced by bash as root during a recovery build, so a
// value that escapes its quoting is arbitrary root code execution at the exact
// moment the operator has no working system to notice it on.

test('shQuote wraps an empty string rather than emitting nothing', () => {
    assert.equal(Dr.shQuote(''), "''");
});

test('shQuote closes, escapes and reopens an embedded single quote', () => {
    assert.equal(Dr.shQuote("it's"), "'it'\\''s'");
    assert.equal(Dr.shQuote("'"), "''\\'''");
});

test('shQuote leaves command substitution inert', () => {
    assert.equal(Dr.shQuote('$(id)'), "'$(id)'");
    assert.equal(Dr.shQuote('`id`'), "'`id`'");
    assert.equal(Dr.shQuote('$((1+1))'), "'$((1+1))'");
});

test('shQuote leaves parameter expansion and globbing inert', () => {
    assert.equal(Dr.shQuote('$HOME/${IFS}'), "'$HOME/${IFS}'");
    assert.equal(Dr.shQuote('/srv/*'), "'/srv/*'");
    assert.equal(Dr.shQuote('~root/x'), "'~root/x'");
});

test('shQuote leaves command separators inert', () => {
    ['a; id', 'a && id', 'a || id', 'a | id', 'a & id', 'a > /etc/passwd', 'a < /etc/shadow']
        .forEach((v) => assert.equal(Dr.shQuote(v), "'" + v + "'"));
});

test('shQuote keeps a backslash literal inside single quotes', () => {
    assert.equal(Dr.shQuote('a\\b'), "'a\\b'");
});

test('shQuote uses ANSI-C quoting for a newline so the config stays line-oriented', () => {
    const q = Dr.shQuote('/srv/a\nid');
    assert.equal(q, "$'/srv/a\\nid'");
    assert.equal(q.includes('\n'), false);
});

test('shQuote escapes carriage return, tab, NUL, ESC and DEL', () => {
    assert.equal(Dr.shQuote('a\rb'), "$'a\\rb'");
    assert.equal(Dr.shQuote('a\tb'), "$'a\\tb'");
    assert.equal(Dr.shQuote('a\u0000b'), "$'a\\x00b'");
    assert.equal(Dr.shQuote('a\u001bb'), "$'a\\x1bb'");
    assert.equal(Dr.shQuote('a\u007fb'), "$'a\\x7fb'");
});

test('shQuote escapes backslash and quote inside ANSI-C quoting too', () => {
    assert.equal(Dr.shQuote("a\\b'c\nd"), "$'a\\\\b\\'c\\nd'");
});

test('shQuote leaves unicode untouched', () => {
    assert.equal(Dr.shQuote('/srv/yedekler/ünité-π/日本語'), "'/srv/yedekler/ünité-π/日本語'");
});

test('shQuote coerces null, undefined, numbers and objects instead of throwing', () => {
    assert.equal(Dr.shQuote(null), "''");
    assert.equal(Dr.shQuote(undefined), "''");
    assert.equal(Dr.shQuote(0), "'0'");
    assert.equal(Dr.shQuote(30), "'30'");
    assert.equal(Dr.shQuote(['a', 'b']), "'a,b'");
});

test('bash round-trips every hostile value shQuote produces', () => {
    const hostile = [
        '', 'plain', "it's", "''", '$(id)', '`id`', '$((1+1))', '$HOME', '${IFS}',
        'a; id', 'a && id', 'a | id', 'a > /tmp/x', '/srv/*', '~root', 'a\\b', 'a\\\\b',
        'a\nb', 'a\rb', 'a\tb', 'a\u001bb', 'a b', '  ', 'ünité-π', '日本語', '"dq"',
        "';id;'", '$\'x\'', '!!', '#comment', '%s', 'a\u007fb'
    ];
    // ${N} braces are required: "$10" is positional 1 followed by a literal 0.
    const script = hostile.map((_, i) => 'printf "%s\\0" "${' + (i + 1) + '}"').join('; ');
    const quoted = hostile.map(Dr.shQuote).join(' ');
    const out = execFileSync('bash', ['-c', 'set -- ' + quoted + '; ' + script], { encoding: 'utf8' });
    assert.deepEqual(out.split('\u0000').slice(0, -1), hostile);
});

test('a repository URL that tries to break out of its quotes is neutralised by real bash', (t) => {
    const dir = tmpdir(t);
    const canary = path.join(dir, 'PWNED');
    const evil = "/srv/x'; touch " + canary + "; echo '";
    const out = sourceAndRead(dir, render({ repoUrl: evil }), '${EXTERNAL_BACKUP[2]}');
    assert.equal(out, evil);
    assert.equal(fs.existsSync(canary), false, 'injected command ran');
});

test('command substitution in a repository URL is not executed when sourced', (t) => {
    const dir = tmpdir(t);
    const canary = path.join(dir, 'PWNED');
    const evil = '/srv/$(touch ' + canary + ')/`touch ' + canary + '2`';
    const out = sourceAndRead(dir, render({ repoUrl: evil }), '${EXTERNAL_RESTORE[2]}');
    assert.equal(out, evil);
    assert.equal(fs.existsSync(canary), false);
    assert.equal(fs.existsSync(canary + '2'), false);
});

test('a newline in a COPY_AS_IS entry cannot open a new config line', (t) => {
    const dir = tmpdir(t);
    const canary = path.join(dir, 'PWNED');
    const evil = '/root/a\ntouch ' + canary + '\n';
    const conf = render({ extraCopyAsIs: [evil] });
    assert.equal(conf.split('\n').some((l) => l.startsWith('touch ')), false);
    const out = sourceAndRead(dir, conf, '${COPY_AS_IS[1]}');
    assert.equal(out, evil);
    assert.equal(fs.existsSync(canary), false);
});

test('an injected value in the host, key path and iso fields stays a literal string', (t) => {
    const dir = tmpdir(t);
    const canary = path.join(dir, 'PWNED');
    const evil = "x'; touch " + canary + "; :'";
    const conf = render({ host: evil, isoVolid: evil, isoPrefix: evil });
    // EXTERNAL_RESTORE: restic --repo U --password-file K --no-cache restore
    // latest --target T --host H — the host VALUE is element 9 now that
    // --no-cache sits in front of the subcommand.
    const out = sourceAndRead(dir, conf, '${EXTERNAL_RESTORE[9]}|$ISO_VOLID|$ISO_PREFIX');
    assert.equal(out, evil + '|' + evil + '|' + evil);
    assert.equal(fs.existsSync(canary), false);
});

test('an injected exclude and required program stay literal words', (t) => {
    const dir = tmpdir(t);
    const canary = path.join(dir, 'PWNED');
    const evil = '/var/`touch ' + canary + '`';
    const conf = render({ excludes: [evil], extraRequiredProgs: ["a'; touch " + canary + "2; :'"] });
    // EXTERNAL_BACKUP: restic --repo U --password-file K --cache-dir C backup
    // --tag T --exclude E — the exclude VALUE is element 11 now that --cache-dir
    // adds two words in front of the subcommand.
    const out = sourceAndRead(dir, conf, '${EXTERNAL_BACKUP[11]}|${REQUIRED_PROGS[1]}');
    assert.equal(out.split('|')[0], evil);
    assert.equal(out.split('|')[1], "a'; touch " + canary + "2; :'");
    assert.equal(fs.existsSync(canary), false);
    assert.equal(fs.existsSync(canary + '2'), false);
});

// ------------------------------------------------------------------ validate

test('validate accepts a minimal configuration', () => {
    assert.deepEqual(Dr.validate({ repoId: 'nas-1', repoUrl: '/srv/backups' }), []);
});

test('validate accepts the full configuration surface', () => {
    assert.deepEqual(Dr.validate({
        repoId: 'nas-1', repoUrl: '/srv/b', repoKind: 'local', host: 'db01',
        outputUrl: 'file:///var/lib/rear/output', backupUrl: 'nfs://h/e',
        backupPaths: ['/'], excludes: ['/proc'], extraCopyAsIs: ['/etc/hangar/'],
        extraRequiredProgs: ['ssh'], keyPath: '/etc/hangar/repos/nas-1.key',
        isoDefault: 'automatic', isoPrefix: 'p', isoVolid: 'v',
        userInputTimeout: 0, useDhclient: false, keepBuildDir: true
    }), []);
});

test('validate reports a missing configuration', () => {
    ['Disaster recovery configuration is missing.'].forEach((m) => {
        assert.deepEqual(Dr.validate(null), [m]);
        assert.deepEqual(Dr.validate(undefined), [m]);
        assert.deepEqual(Dr.validate('/srv/b'), [m]);
        assert.deepEqual(Dr.validate([]), [m]);
        assert.deepEqual(Dr.validate(42), [m]);
    });
});

test('validate reports a missing or malformed repository id', () => {
    assert.ok(Dr.validate({ repoUrl: '/srv/b' }).includes('Disaster recovery requires a repository id.'));
    assert.ok(Dr.validate({ repoId: '  ', repoUrl: '/srv/b' })
        .includes('Disaster recovery requires a repository id.'));
    ['NAS', 'nas_1', 'nas 1', '-nas', 'nas/1', '../nas', 'yedek-ü', 'a'.repeat(64)].forEach((id) => {
        assert.ok(Dr.validate({ repoId: id, repoUrl: '/srv/b' })
            .includes('Repository id may only contain lowercase letters, digits and hyphens.'),
        'accepted bad id ' + id);
    });
});

test('validate reports a missing repository URL', () => {
    assert.ok(Dr.validate({ repoId: 'x' }).includes('Disaster recovery requires a repository URL.'));
    assert.ok(Dr.validate({ repoId: 'x', repoUrl: '   ' })
        .includes('Disaster recovery requires a repository URL.'));
});

test('validate rejects control characters in the repository URL', () => {
    ['/srv/a\nb', '/srv/a\rb', '/srv/a\u0000b'].forEach((u) => {
        assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: u }),
            ['Repository URL must not contain control characters.']);
    });
});

test('validate rejects an unknown repository kind but accepts every known one', () => {
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', repoKind: 'dropbox' }),
        ['Unknown repository kind: dropbox.']);
    Dr.REPO_KINDS.forEach((k) =>
        assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', repoKind: k }), []));
});

test('validate rejects a non-ReaR OUTPUT_URL or BACKUP_URL', () => {
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', outputUrl: '/var/lib/rear/output' }),
        ['OUTPUT_URL must be a ReaR URL such as file:///var/lib/rear/output.']);
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', backupUrl: 'nas.lan:/export' }),
        ['BACKUP_URL must be a ReaR URL such as nfs://server/export.']);
});

test('validate accepts the ReaR URL schemes', () => {
    ['file:///var/lib/rear/output', 'nfs://nas.lan/export', 'cifs://srv/share',
        'usb:///dev/disk/by-label/REAR-000', 'sftp://u@h/p', 'rsync://h/m', 'tape:///dev/nst0']
        .forEach((u) => assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', outputUrl: u }), []));
});

test('validate rejects empty, non-array and relative backup paths', () => {
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', backupPaths: [] }),
        ['Disaster recovery needs at least one backup path.']);
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', backupPaths: '/' }),
        ['Disaster recovery needs at least one backup path.']);
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', backupPaths: ['/', 'etc'] }),
        ['Backup paths must be absolute.']);
});

test('validate rejects relative and traversing exclude and COPY_AS_IS paths', () => {
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', excludes: ['proc'] }),
        ['Exclude paths must be absolute.']);
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', excludes: ['/srv/../etc'] }),
        ['Exclude paths must not contain "..".']);
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', extraCopyAsIs: ['etc/hangar'] }),
        ['COPY_AS_IS paths must be absolute.']);
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', extraCopyAsIs: ['/etc/../root/.ssh'] }),
        ['COPY_AS_IS paths must not contain "..".']);
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', extraCopyAsIs: '/etc' }),
        ['COPY_AS_IS list must be an array.']);
});

test('validate allows a path component that merely begins with dots', () => {
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', extraCopyAsIs: ['/etc/..hidden/x'] }), []);
});

test('validate rejects a non-array required programs list', () => {
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', extraRequiredProgs: 'ssh' }),
        ['Required programs list must be an array.']);
});

test('validate rejects a relative, traversing or control-laden key path', () => {
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', keyPath: 'repos/x.key' }),
        ['Repository key path must be absolute.']);
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', keyPath: '/etc/../root/x.key' }),
        ['Repository key path must not contain "..".']);
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', keyPath: '/etc/a\nb.key' }),
        ['Repository key path must not contain control characters.']);
});

test('validate rejects an ISO_DEFAULT value ReaR does not understand', () => {
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', isoDefault: 'auto' }),
        ['ISO_DEFAULT must be one of: boothd, manual, automatic.']);
});

test('validate rejects a non-integer or negative input timeout', () => {
    ['x', 1.5, -1, NaN].forEach((t) => {
        assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', userInputTimeout: t }),
            ['User input timeout must be a whole number of seconds.'], 'accepted ' + t);
    });
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', userInputTimeout: 0 }), []);
});

test('validate accumulates every independent problem', () => {
    const p = Dr.validate({ repoId: 'BAD', repoUrl: '', repoKind: 'dropbox', isoDefault: 'auto' });
    assert.equal(p.length, 4);
});

test('keyPathFor derives the documented per-repository key path', () => {
    assert.equal(Dr.keyPathFor('nas-1'), '/etc/hangar/repos/nas-1.key');
});

// -------------------------------------------------------------- parseRearLog

test('parseRearLog reaches done at 100 percent on a successful mkrescue', () => {
    const r = Dr.parseRearLog(fixture('synthetic-mkrescue-ok.txt'));
    assert.equal(r.phase, 'done');
    assert.equal(r.percent, 100);
    assert.deepEqual(r.errors, []);
});

test('parseRearLog never walks a milestone backwards', () => {
    // ReaR prints "Copying resulting files" AFTER "Wrote ISO image"; last-match
    // -wins would report 45 percent for a finished build.
    const r = Dr.parseRearLog('Making ISO image\nWrote ISO image: /o/x.iso (1M)\nCopying resulting files\n');
    assert.equal(r.phase, 'done');
    assert.equal(r.percent, 100);
});

test('parseRearLog tracks each known milestone in order', () => {
    const expect = [
        ['Relax-and-Recover 2.7 / 2023-12-05', 'starting'],
        ['Creating disk layout', 'layout'],
        ['Creating root filesystem layout', 'rootfs'],
        ['Copying binaries and libraries', 'copying'],
        ['Creating recovery/rescue system initramfs/initrd initrd.cgz', 'initramfs'],
        ['Making ISO image', 'iso'],
        ['Wrote ISO image: /var/lib/rear/output/rear-db01.iso (267M)', 'done']
    ];
    let acc = '';
    let last = -1;
    expect.forEach((pair) => {
        acc += pair[0] + '\n';
        const r = Dr.parseRearLog(acc);
        assert.equal(r.phase, pair[1], 'wrong phase after: ' + pair[0]);
        assert.ok(r.percent > last, 'percent did not advance at: ' + pair[0]);
        last = r.percent;
    });
});

test('parseRearLog collects ERROR: and BUG: lines', () => {
    const r = Dr.parseRearLog(fixture('synthetic-mkrescue-error.txt'));
    assert.deepEqual(r.errors, ['ERROR: Could not find a required program: restic']);
    const b = Dr.parseRearLog('Creating disk layout\nBUG: bad partition table\nERROR: aborting\n');
    assert.deepEqual(b.errors, ['BUG: bad partition table', 'ERROR: aborting']);
});

test('parseRearLog does not mistake a mention of an error for an error line', () => {
    const r = Dr.parseRearLog('Copying files\nsee ERROR: nothing here\ncheck the log for ERROR: lines\n');
    assert.deepEqual(r.errors, []);
});

test('parseRearLog strips the log-file timestamp prefix before matching', () => {
    const r = Dr.parseRearLog(fixture('synthetic-mkrescue-timestamped.log'));
    assert.equal(r.phase, 'done');
    assert.equal(r.percent, 100);
    assert.ok(r.rawTail.includes('2026-08-01 09:15:44'), 'rawTail must stay verbatim');
});

test('parseRearLog strips a timestamp from an error line too', () => {
    const r = Dr.parseRearLog('2026-08-01 09:31:52.118293145 ERROR: mkisofs failed\n');
    assert.deepEqual(r.errors, ['ERROR: mkisofs failed']);
});

test('parseRearLog reports unknown for output it refuses to interpret', () => {
    const text = fixture('synthetic-unrecognised.txt');
    const r = Dr.parseRearLog(text);
    assert.equal(r.phase, 'unknown');
    assert.equal(r.percent, 0);
    assert.deepEqual(r.errors, []);
    assert.equal(r.rawTail, text.replace(/\n$/, ''), 'unrecognised output must survive verbatim');
});

test('parseRearLog rawTail carries the last 40 lines and no more', () => {
    const lines = [];
    for (let i = 1; i <= 100; i++) lines.push('line ' + i);
    const r = Dr.parseRearLog(lines.join('\n') + '\n');
    const tail = r.rawTail.split('\n');
    assert.equal(tail.length, Dr.TAIL_LINES);
    assert.equal(tail[0], 'line 61');
    assert.equal(tail[tail.length - 1], 'line 100');
});

test('parseRearLog rawTail returns everything when the log is shorter than the tail', () => {
    assert.equal(Dr.parseRearLog('a\nb\nc').rawTail, 'a\nb\nc');
});

test('parseRearLog rawTail preserves blank lines, indentation and stray characters', () => {
    const text = 'Creating disk layout\n\n\tindented\n  + spaced\n\u001b[1mbold\u001b[0m\n';
    assert.equal(Dr.parseRearLog(text).rawTail, text.replace(/\n$/, ''));
});

test('parseRearLog handles empty, blank and non-string input without throwing', () => {
    [['', 0], [null, 0], [undefined, 0], ['\n', 0]].forEach((pair) => {
        const r = Dr.parseRearLog(pair[0]);
        assert.equal(r.phase, 'unknown');
        assert.equal(r.percent, pair[1]);
        assert.deepEqual(r.errors, []);
        assert.equal(r.rawTail, '');
    });
    assert.equal(Dr.parseRearLog(42).rawTail, '42');
});

test('parseRearLog normalises CRLF line endings', () => {
    const r = Dr.parseRearLog('Creating disk layout\r\nERROR: boom\r\n');
    assert.deepEqual(r.errors, ['ERROR: boom']);
    assert.equal(r.rawTail, 'Creating disk layout\nERROR: boom');
});

test('parseRearLog always returns the four documented fields', () => {
    const r = Dr.parseRearLog('anything at all');
    assert.deepEqual(Object.keys(r).sort(), ['errors', 'percent', 'phase', 'rawTail']);
});

// --------------------------------------------------------------- isoPathFrom

test('isoPathFrom reads the ISO path out of a successful run', () => {
    assert.equal(Dr.isoPathFrom(fixture('synthetic-mkrescue-ok.txt')),
        '/var/lib/rear/output/rear-db01.iso');
});

test('isoPathFrom strips the parenthesised size in its documented forms', () => {
    ['(267M)', '(1.2 GiB)', '(267)', '(280,123,456 bytes)'].forEach((size) => {
        assert.equal(Dr.isoPathFrom('Wrote ISO image: /o/x.iso ' + size), '/o/x.iso');
    });
});

test('isoPathFrom keeps a path that itself contains parentheses', () => {
    assert.equal(Dr.isoPathFrom('Wrote ISO image: /o/rear (old).iso'), '/o/rear (old).iso');
});

test('isoPathFrom keeps spaces inside the path', () => {
    assert.equal(Dr.isoPathFrom('Wrote ISO image: /var/lib/rear out/rear db01.iso (267M)'),
        '/var/lib/rear out/rear db01.iso');
});

test('isoPathFrom takes the last reported image so a rerun supersedes the previous one', () => {
    assert.equal(Dr.isoPathFrom('Wrote ISO image: /o/a.iso (1M)\nWrote ISO image: /o/b.iso (2M)\n'),
        '/o/b.iso');
});

test('isoPathFrom works on a timestamped log line', () => {
    assert.equal(Dr.isoPathFrom(fixture('synthetic-mkrescue-timestamped.log')),
        '/var/lib/rear/output/rear-db01.iso');
});

test('isoPathFrom returns null when no image was reported', () => {
    assert.equal(Dr.isoPathFrom(fixture('synthetic-mkrescue-error.txt')), null);
    assert.equal(Dr.isoPathFrom(fixture('synthetic-unrecognised.txt')), null);
    assert.equal(Dr.isoPathFrom(''), null);
    assert.equal(Dr.isoPathFrom(null), null);
    assert.equal(Dr.isoPathFrom(undefined), null);
    assert.equal(Dr.isoPathFrom('Making ISO image'), null);
    assert.equal(Dr.isoPathFrom('Wrote ISO image:'), null);
    assert.equal(Dr.isoPathFrom('Wrote ISO image:   '), null);
});

// ---------------------------------------------------------------- I/O layer

test('the I/O layer rejects with a HangarError instead of throwing at load time', async () => {
    await assert.rejects(() => Dr.readLocalConf(), (e) => Errors.isHangarError(e) && e.kind === 'GENERIC');
    await assert.rejects(() => Dr.mkrescue(), (e) => Errors.isHangarError(e) && e.kind === 'GENERIC');
    await assert.rejects(() => Dr.writeLocalConf({ repoId: 'x', repoUrl: '/srv/b' }),
        (e) => Errors.isHangarError(e) && e.kind === 'GENERIC');
});

test('writeLocalConf rejects on an invalid config before it ever reaches cockpit', async () => {
    await assert.rejects(() => Dr.writeLocalConf({}), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.match(e.message, /Disaster recovery configuration is invalid/);
        return true;
    });
});

test('module exposes the expected surface and contains no ES module syntax', () => {
    ['shQuote', 'keyPathFor', 'validate', 'renderLocalConf', 'parseRearLog', 'isoPathFrom',
        'writeLocalConf', 'readLocalConf', 'mkrescue']
        .forEach((fn) => assert.equal(typeof Dr[fn], 'function', 'missing ' + fn));
    assert.equal(Dr.LOCAL_CONF_PATH, '/etc/rear/local.conf');
    assert.equal(Dr.TARGET_FS_ROOT, '/mnt/local');
    assert.equal(Dr.TAIL_LINES, 40);
    const src = fs.readFileSync(path.join(ROOT, 'js', 'core', 'dr.js'), 'utf8');
    assert.equal(/^\s*(import|export)\s/m.test(src), false, 'ES module syntax found');
    assert.equal(/\bcockpit\./.test(src.split('// ---------------------------------------------------------------- I/O layer')[0]),
        false, 'cockpit referenced outside the I/O layer');
});

// ==========================================================================
// Adversarial hardening. Everything below attacks the module rather than
// describing it: unconvertible values, boundary lengths, hostile text in every
// field validate() lets through, and the I/O layer driven against a stubbed
// cockpit so its error paths are reachable under node at all.
// ==========================================================================

// JSON can express this: `toString` and `valueOf` present but not callable, so
// String(v) throws TypeError. It is the one shape a config file read off disk
// can take that breaks naive coercion.
const UNCONVERTIBLE = JSON.parse('{"toString":"x","valueOf":"y"}');

// Written as escapes on purpose: a literal control byte in a test file is
// invisible in review and gets mangled by editors and diff tools.
const NUL = '\u0000';
const ESC = '\u001b';

// Install a fake cockpit for the duration of `fn`. The module resolves the bare
// identifier `cockpit` against the global, so this is enough to reach the I/O
// layer that is otherwise dead code under node.
function withCockpit(stub, fn) {
    globalThis.cockpit = stub;
    return Promise.resolve().then(fn).finally(() => { delete globalThis.cockpit; });
}

function fileStub(behaviour) {
    const calls = [];
    return {
        calls,
        file(p, options) {
            const rec = { path: p, options: options, replaced: null };
            calls.push(rec);
            return {
                replace(text) {
                    rec.replaced = text;
                    return behaviour && behaviour.replaceRejects
                        ? Promise.reject(behaviour.replaceRejects) : Promise.resolve(text.length);
                },
                read() {
                    return behaviour && behaviour.readRejects
                        ? Promise.reject(behaviour.readRejects) : Promise.resolve('conf-of:' + p);
                }
            };
        }
    };
}

function spawnStub(opts) {
    const calls = [];
    return {
        calls,
        spawn(argv, options) {
            calls.push({ argv: argv, options: options });
            const settled = opts.fail
                ? Promise.reject('error' in opts ? opts.error : new Error('boom'))
                : Promise.resolve(opts.out);
            const proc = { then: function (ok, no) { return settled.then(ok, no); } };
            if (opts.chunks) proc.stream = function (cb) { opts.chunks.forEach(cb); return proc; };
            return proc;
        }
    };
}

// ------------------------------------------------- unconvertible input (str)

test('validate reports a typed problem for a value String() cannot convert', () => {
    // Regression: String({toString:"x",valueOf:"y"}) threw a raw TypeError out
    // of validate, so a hostile /etc/hangar/dr.json crashed the caller untyped.
    assert.ok(Dr.validate({ repoId: UNCONVERTIBLE, repoUrl: '/srv/b' })
        .includes('Disaster recovery requires a repository id.'));
    assert.ok(Dr.validate({ repoId: 'x', repoUrl: UNCONVERTIBLE })
        .includes('Disaster recovery requires a repository URL.'));
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', excludes: [UNCONVERTIBLE] }),
        ['Exclude paths must be absolute.']);
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', backupPaths: [UNCONVERTIBLE] }),
        ['Backup paths must be absolute.']);
});

test('renderLocalConf throws a HangarError, not a TypeError, on unconvertible values', () => {
    assertGeneric(() => Dr.renderLocalConf({ repoId: UNCONVERTIBLE, repoUrl: '/srv/b' }));
    assertGeneric(() => Dr.renderLocalConf({ repoId: 'x', repoUrl: UNCONVERTIBLE }));
});

test('an unconvertible host or iso field degrades to an omitted value, not a crash', () => {
    const conf = render({ host: UNCONVERTIBLE, isoPrefix: UNCONVERTIBLE, isoVolid: UNCONVERTIBLE });
    assert.equal(conf.includes("'--host'"), false);
    assert.equal(/^ISO_(PREFIX|VOLID)=/m.test(conf), false);
});

test('shQuote coerces an unconvertible value to an empty quoted string', () => {
    assert.equal(Dr.shQuote(UNCONVERTIBLE), "''");
    assert.equal(Dr.shQuote(Object.create(null)), "''");
});

test('parseRearLog and isoPathFrom survive unconvertible input', () => {
    assert.equal(Dr.parseRearLog(UNCONVERTIBLE).rawTail, '');
    assert.equal(Dr.isoPathFrom(UNCONVERTIBLE), null);
});

// ------------------------------------------------------- validate boundaries

test('validate accepts a repository id at the length limit and rejects one past it', () => {
    assert.deepEqual(Dr.validate({ repoId: 'a'.repeat(63), repoUrl: '/srv/b' }), []);
    assert.deepEqual(Dr.validate({ repoId: 'a', repoUrl: '/srv/b' }), []);
    assert.deepEqual(Dr.validate({ repoId: '0', repoUrl: '/srv/b' }), []);
    assert.deepEqual(Dr.validate({ repoId: 'a'.repeat(64), repoUrl: '/srv/b' }),
        ['Repository id may only contain lowercase letters, digits and hyphens.']);
});

test('validate rejects a repository id carrying a newline, NUL or shell metacharacter', () => {
    // JS anchors `$` at end of input, not before a trailing newline - a second
    // line smuggled into the id would otherwise reach keyPathFor().
    ['nas-1\n', 'nas-1\nrm -rf /', '\nnas-1', 'nas' + NUL, 'nas 1', 'nas;id', 'nas$(id)',
        'nas`id`', 'nas|id', 'nas*', 'nas/1', '..', '.', '/', '-', 'a'.repeat(63) + 'b']
        .forEach((id) => {
            assert.ok(Dr.validate({ repoId: id, repoUrl: '/srv/b' }).length > 0,
                'accepted hostile id ' + JSON.stringify(id));
        });
});

test('validate accepts a repository id supplied as a number', () => {
    assert.deepEqual(Dr.validate({ repoId: 42, repoUrl: '/srv/b' }), []);
    assert.equal(Dr.keyPathFor(42), '/etc/hangar/repos/42.key');
});

test('validate rejects an out-of-range or non-numeric input timeout', () => {
    // 1e21 passes Number.isInteger but stringifies as "1e+21", which ReaR would
    // read as a word rather than a count of seconds.
    [1e21, Number.MAX_SAFE_INTEGER + 2, Infinity, -Infinity, '30s', {}, [1, 2], '-5', -0.5]
        .forEach((t) => {
            assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', userInputTimeout: t }),
                ['User input timeout must be a whole number of seconds.'],
                'accepted ' + JSON.stringify(String(t)));
        });
    [0, 30, '30', Number.MAX_SAFE_INTEGER, -0].forEach((t) => {
        assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', userInputTimeout: t }), [],
            'rejected ' + String(t));
    });
});

test('USER_INPUT_TIMEOUT is always rendered as plain decimal digits', () => {
    [undefined, 0, 30, '30', 86400, Number.MAX_SAFE_INTEGER].forEach((t) => {
        const conf = render(t === undefined ? {} : { userInputTimeout: t });
        assert.match(conf, /^USER_INPUT_TIMEOUT='[0-9]+'$/m, 'bad timeout rendering for ' + String(t));
    });
});

test('validate accumulates both problems a single key path can have', () => {
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', keyPath: 'rel/a\nb.key' }).sort(),
        ['Repository key path must be absolute.',
            'Repository key path must not contain control characters.']);
});

test('validate treats a whitespace-only key path as unset and falls back to the default', () => {
    assert.deepEqual(Dr.validate({ repoId: 'nas-1', repoUrl: '/srv/b', keyPath: '   ' }), []);
    assert.ok(render({ keyPath: '   ' }).includes("'/etc/hangar/repos/nas-1.key'"));
});

test('validate does not treat a NUL-only key path as unset', () => {
    // NUL is not JS whitespace, so trim() leaves it: it must not slip past the
    // blank() gate and reach the file unchecked.
    assert.ok(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', keyPath: NUL }).length >= 2);
});

test('validate rejects a repository kind whose case does not match', () => {
    ['SFTP', 'Local', 'S3 ', ' s3'].forEach((k) =>
        assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', repoKind: k }),
            ['Unknown repository kind: ' + k + '.'], 'accepted ' + JSON.stringify(k)));
});

test('an unknown repository kind cannot forge a second problem in the list', () => {
    const p = Dr.validate({ repoId: 'x', repoUrl: '/srv/b', repoKind: 'a.\nBackup paths must be absolute' });
    assert.equal(p.length, 1);
});

test('validate rejects a URL scheme ReaR does not implement', () => {
    ['https://h/p', 'http://h/p', 'javascript:alert(1)', 'file:/var/lib', 'file:/', '://x',
        ' file:///x', 'nfs:/h/e', 's3://bucket', 'file//x']
        .forEach((u) => assert.equal(
            Dr.validate({ repoId: 'x', repoUrl: '/srv/b', outputUrl: u }).length, 1, 'accepted ' + u));
});

test('validate accepts a ReaR URL scheme in any case', () => {
    ['FILE:///var/lib/rear/output', 'Nfs://h/e', 'ISO:///x'].forEach((u) =>
        assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', outputUrl: u }), []));
});

test('validate rejects hostile backup path entries of every shape', () => {
    [[null], [''], [42], [{}], [[]], ['./etc'], ['../etc'], [' /etc'], [UNCONVERTIBLE]]
        .forEach((paths) => assert.deepEqual(
            Dr.validate({ repoId: 'x', repoUrl: '/srv/b', backupPaths: paths }),
            ['Backup paths must be absolute.'], 'accepted ' + JSON.stringify(paths)));
});

test('validate rejects a non-array exclude list', () => {
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', excludes: '/proc' }),
        ['Exclude list must be an array.']);
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', excludes: 42 }),
        ['Exclude list must be an array.']);
});

test('validate reports both absoluteness and traversal when a list has one of each', () => {
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', excludes: ['proc', '/srv/../etc'] }),
        ['Exclude paths must be absolute.', 'Exclude paths must not contain "..".']);
});

test('validate catches traversal in any component, not only the second', () => {
    ['/..', '/../etc', '/etc/..', '/etc/../../root', '/a/b/../c'].forEach((p) =>
        assert.ok(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', extraCopyAsIs: [p] })
            .includes('COPY_AS_IS paths must not contain "..".'), 'missed traversal in ' + p));
});

test('validate accepts an empty exclude or COPY_AS_IS list', () => {
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', excludes: [], extraCopyAsIs: [] }), []);
});

test('validate accepts a repository URL full of shell metacharacters', () => {
    // Quoting is the defence, not rejection: a legitimate path may contain any
    // byte except a control character.
    ['/srv/$(id)', '/srv/`id`;rm -rf /', "/srv/it's", '/srv/*', '/srv/a b', '/srv/yedek-ü/日本語',
        's3:s3.eu-central-1.amazonaws.com/bucket', 'rclone:gdrive:backups', '/srv/' + 'x'.repeat(100000)]
        .forEach((u) => assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: u }), [],
            'rejected legitimate url ' + u.slice(0, 40)));
});

test('validate rejects every control character in the repository URL', () => {
    [0x00, 0x01, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b, 0x1f, 0x7f].forEach((c) => {
        assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/a' + String.fromCharCode(c) + 'b' }),
            ['Repository URL must not contain control characters.'], 'accepted 0x' + c.toString(16));
    });
});

test('validate ignores unknown keys instead of failing on them', () => {
    assert.deepEqual(Dr.validate({ repoId: 'x', repoUrl: '/srv/b', nonsense: 1, EXTERNAL_BACKUP: 'id' }), []);
});

test('validate does not mutate the configuration it was handed', () => {
    const cfg = { repoId: 'x', repoUrl: '/srv/b', excludes: ['/proc'], backupPaths: ['/'] };
    const before = JSON.stringify(cfg);
    Dr.validate(cfg);
    assert.equal(JSON.stringify(cfg), before);
});

// -------------------------------------------------- renderLocalConf hardening

test('renderLocalConf does not mutate its configuration or the shared defaults', () => {
    const cfg = Object.assign({}, BASE, { excludes: ['/var/cache'], extraCopyAsIs: ['/etc/hangar/'] });
    const before = JSON.stringify(cfg);
    const defaults = Dr.DEFAULT_EXCLUDES.slice();
    const paths = Dr.DEFAULT_BACKUP_PATHS.slice();
    Dr.renderLocalConf(cfg);
    Dr.renderLocalConf(cfg);
    assert.equal(JSON.stringify(cfg), before);
    assert.deepEqual(Dr.DEFAULT_EXCLUDES, defaults, 'DEFAULT_EXCLUDES was mutated');
    assert.deepEqual(Dr.DEFAULT_BACKUP_PATHS, paths, 'DEFAULT_BACKUP_PATHS was mutated');
});

test('renderLocalConf still self-excludes a local repository when excludes is empty', () => {
    const conf = render({ excludes: [] });
    assert.ok(conf.includes("'--exclude' '/srv/backups'"));
    assert.equal(conf.split("'--exclude'").length - 1, 1);
});

test('renderLocalConf does not add the self-exclude twice when it is already listed', () => {
    const conf = render({ excludes: ['/srv/backups', '/proc'] });
    assert.equal(conf.split("'--exclude' '/srv/backups'").length - 1, 1);
});

test('renderLocalConf produces valid bash for every documented repository kind', (t) => {
    const dir = tmpdir(t);
    Dr.REPO_KINDS.forEach((kind) => {
        const conf = Dr.renderLocalConf({ repoId: 'r-' + kind, repoUrl: kind + ':host:/p', repoKind: kind });
        const p = path.join(dir, kind + '.conf');
        fs.writeFileSync(p, conf);
        execFileSync('bash', ['-n', p]);
        assert.match(conf, /^REQUIRED_PROGS\+=\($/m);
    });
});

test('renderLocalConf treats useDhclient and keepBuildDir as strict booleans', () => {
    // Anything that is not exactly false / exactly true keeps the safe default,
    // so a string "no" from a hand-edited JSON cannot silently disable DHCP.
    [0, '', null, 'no', 'false'].forEach((v) =>
        assert.match(render({ useDhclient: v }), /^USE_DHCLIENT='yes'$/m, 'useDhclient ' + String(v)));
    [1, 'yes', 'true', {}].forEach((v) =>
        assert.match(render({ keepBuildDir: v }), /^KEEP_BUILD_DIR='No'$/m, 'keepBuildDir ' + String(v)));
});

test('a flag and its value stay two separate bash words in a generated array', (t) => {
    const dir = tmpdir(t);
    const conf = render({ extraRequiredProgs: ['--exclude', '/etc/shadow'] });
    const out = sourceAndRead(dir, conf,
        '${#REQUIRED_PROGS[@]}|${REQUIRED_PROGS[1]}|${REQUIRED_PROGS[2]}');
    assert.equal(out, '3|--exclude|/etc/shadow');
});

test('the generated EXTERNAL_BACKUP argv reaches bash with the exact element count', (t) => {
    const dir = tmpdir(t);
    // restic --repo U --password-file K --cache-dir C backup --tag T = 10 words,
    // then the 10 default excludes plus the self-exclude as flag/value pairs = 22,
    // then the single backup path at index 32. EXTERNAL_RESTORE is 14: --no-cache
    // adds one, --host and --path add two each.
    const out = sourceAndRead(dir, render(),
        '${#EXTERNAL_BACKUP[@]}|${EXTERNAL_BACKUP[0]}|${EXTERNAL_BACKUP[32]}|${#EXTERNAL_RESTORE[@]}');
    assert.equal(out, '33|restic|/|14');
    assert.equal(Dr.DEFAULT_EXCLUDES.length, 10);
});

test('sourcing a config built entirely from hostile values executes nothing', (t) => {
    const dir = tmpdir(t);
    const evil = "x'; touch " + path.join(dir, 'PWNED') + '; $(touch ' + path.join(dir, 'PWNED2')
        + ')`touch ' + path.join(dir, 'PWNED3') + "`; :'";
    const conf = Dr.renderLocalConf({
        repoId: 'nas-1', repoKind: 'local',
        repoUrl: '/srv/' + evil,
        host: evil, isoPrefix: evil, isoVolid: evil,
        outputUrl: 'file:///var/lib/rear/' + evil,
        backupUrl: 'nfs://nas.lan/' + evil,
        keyPath: '/etc/hangar/repos/' + evil + '.key',
        backupPaths: ['/' + evil],
        excludes: ['/proc', '/var/' + evil],
        extraCopyAsIs: ['/etc/' + evil],
        extraRequiredProgs: [evil]
    });
    const confPath = path.join(dir, 'local.conf');
    fs.writeFileSync(confPath, conf);
    execFileSync('bash', ['-n', confPath]);
    execFileSync('bash', ['-c', 'REQUIRED_PROGS=(); COPY_AS_IS=(); source "$1"', 'bash', confPath],
        { cwd: dir });
    assert.deepEqual(fs.readdirSync(dir).sort(), ['local.conf'], 'sourcing the config created files');
});

test('a unicode repository path round-trips through bash byte-identically', (t) => {
    const dir = tmpdir(t);
    const url = '/srv/yedekler/ünité-π/日本語/🐧';
    assert.equal(sourceAndRead(dir, render({ repoUrl: url }), '${EXTERNAL_BACKUP[2]}'), url);
});

test('a newline smuggled through OUTPUT_URL cannot open a new configuration line', (t) => {
    const dir = tmpdir(t);
    const canary = path.join(dir, 'PWNED');
    // outputUrl only has to start with a ReaR scheme; the rest is arbitrary and
    // is not control-character checked, so the quoting is the only defence.
    const evil = 'file:///var/lib/rear\ntouch ' + canary;
    const conf = render({ outputUrl: evil });
    assert.equal(conf.split('\n').some((l) => l.startsWith('touch ')), false);
    assert.equal(sourceAndRead(dir, conf, '$OUTPUT_URL'), evil);
    assert.equal(fs.existsSync(canary), false);
});

test('a NUL byte in a path is truncated by bash rather than escaping its quoting', (t) => {
    const dir = tmpdir(t);
    const canary = path.join(dir, 'PWNED');
    // bash cannot hold a NUL in a variable at all, so the value is cut short.
    // What matters is that the remainder is inert text and not a command.
    const conf = render({ extraCopyAsIs: ['/root/a' + NUL + '; touch ' + canary] });
    assert.equal(conf.split('\n').filter((l) => l.indexOf('/root/a') >= 0).length, 1);
    assert.equal(sourceAndRead(dir, conf, '${COPY_AS_IS[1]}'), '/root/a');
    assert.equal(fs.existsSync(canary), false);
});

test('a very long repository path is quoted whole and survives bash', (t) => {
    const dir = tmpdir(t);
    const url = '/srv/' + 'a'.repeat(65536);
    assert.equal(sourceAndRead(dir, render({ repoUrl: url }), '${EXTERNAL_BACKUP[2]}'), url);
});

test('renderLocalConf keeps a key path containing spaces and quotes intact', (t) => {
    const dir = tmpdir(t);
    const key = "/etc/hangar/repos/it's a key.key";
    const out = sourceAndRead(dir, render({ keyPath: key }), '${EXTERNAL_BACKUP[4]}|${COPY_AS_IS[0]}');
    assert.equal(out, key + '|' + key);
});

// --------------------------------------------------------- parseRearLog attack

test('parseRearLog strips a T-separated timestamp as well as a space-separated one', () => {
    assert.equal(Dr.parseRearLog('2026-08-01T09:14:03 Creating disk layout').phase, 'layout');
    assert.equal(Dr.parseRearLog('2026-08-01T09:14:03.123456789 Making ISO image').percent, 85);
});

test('parseRearLog only strips a timestamp at the start of a line', () => {
    assert.equal(Dr.parseRearLog('prefix 2026-08-01 09:14:03 Creating disk layout').phase, 'unknown');
    assert.equal(Dr.parseRearLog('2026-08-01 Creating disk layout').phase, 'unknown');
    assert.equal(Dr.parseRearLog('26-08-01 09:14:03 Creating disk layout').phase, 'unknown');
});

test('parseRearLog does not treat an indented or lowercased marker as an error', () => {
    ['  ERROR: indented', '\tERROR: tabbed', 'error: lowercase', 'ERRORS: plural',
        'ERROR no colon', 'BUGS: plural', 'xERROR: prefixed'].forEach((l) =>
        assert.deepEqual(Dr.parseRearLog(l).errors, [], 'wrongly collected ' + JSON.stringify(l)));
});

test('parseRearLog keeps every error line in order, duplicates included', () => {
    assert.deepEqual(Dr.parseRearLog('ERROR: a\nBUG: b\nERROR: a\nERROR: c\n').errors,
        ['ERROR: a', 'BUG: b', 'ERROR: a', 'ERROR: c']);
});

test('parseRearLog returns a fresh errors array on every call', () => {
    const a = Dr.parseRearLog('ERROR: x');
    const b = Dr.parseRearLog('ERROR: x');
    a.errors.push('mutated');
    assert.deepEqual(b.errors, ['ERROR: x']);
});

test('parseRearLog falls back to the generic Creating and Making milestones', () => {
    const c = Dr.parseRearLog('Creating something new');
    assert.deepEqual([c.phase, c.percent], ['creating', 20]);
    const m = Dr.parseRearLog('Making the coffee');
    assert.deepEqual([m.phase, m.percent], ['iso', 80]);
});

test('parseRearLog requires a word boundary before treating a line as a milestone', () => {
    ['Creatingness', 'Makingdo', 'Relax-and-Recovering'].forEach((l) =>
        assert.equal(Dr.parseRearLog(l).phase, 'unknown', 'matched ' + l));
});

test('parseRearLog never regresses however the milestones are shuffled', () => {
    const lines = ['Wrote ISO image: /o/x.iso (1M)', 'Creating disk layout', 'Copying resulting files',
        'Relax-and-Recover 2.7', 'Making ISO image', 'Creating root filesystem layout'];
    let acc = '';
    let last = 0;
    lines.forEach((l) => {
        acc += l + '\n';
        const p = Dr.parseRearLog(acc).percent;
        assert.ok(p >= last, 'percent went backwards at ' + l);
        last = p;
    });
    assert.equal(last, 100);
});

test('parseRearLog surfaces hostile log text verbatim without interpreting it', () => {
    const text = 'ERROR: $(touch /tmp/x) `id`\n' + NUL + ' embedded\n' + ESC + ']0;title\n日本語 ünité\n';
    const r = Dr.parseRearLog(text);
    assert.deepEqual(r.errors, ['ERROR: $(touch /tmp/x) `id`']);
    assert.equal(r.rawTail, text.replace(/\n$/, ''));
});

test('parseRearLog keeps blank interior lines in the tail', () => {
    assert.equal(Dr.parseRearLog('\n\n').rawTail, '\n');
    assert.equal(Dr.parseRearLog('a\n\n\nb\n').rawTail, 'a\n\n\nb');
});

test('parseRearLog handles a lone CRLF and a lone CR', () => {
    assert.equal(Dr.parseRearLog('\r\n').rawTail, '');
    assert.equal(Dr.parseRearLog('Creating disk layout\rERROR: boom').errors.length, 0,
        'a bare CR must not act as a line separator');
});

test('parseRearLog tails a large log without losing the last line', () => {
    const lines = [];
    for (let i = 1; i <= 20000; i++) lines.push('noise ' + i);
    lines.push('Wrote ISO image: /o/big.iso (9G)');
    const r = Dr.parseRearLog(lines.join('\n'));
    assert.equal(r.percent, 100);
    assert.equal(r.rawTail.split('\n').length, Dr.TAIL_LINES);
    assert.equal(r.rawTail.split('\n').pop(), 'Wrote ISO image: /o/big.iso (9G)');
});

test('parseRearLog handles a single unterminated line one megabyte long', () => {
    const r = Dr.parseRearLog('Copying ' + 'x'.repeat(1024 * 1024));
    assert.equal(r.phase, 'copying');
    assert.equal(r.rawTail.length, 8 + 1024 * 1024);
});

test('parseRearLog coerces numbers, booleans and arrays instead of throwing', () => {
    [[42, '42'], [true, 'true'], [['a', 'b'], 'a,b'], [{}, '[object Object]']].forEach((pair) => {
        const r = Dr.parseRearLog(pair[0]);
        assert.equal(r.rawTail, pair[1]);
        assert.equal(r.phase, 'unknown');
    });
});

// --------------------------------------------------------- isoPathFrom attack

test('isoPathFrom needs the marker exactly as ReaR prints it', () => {
    assert.equal(Dr.isoPathFrom('Wrote ISO image /o/x.iso'), null);
    assert.equal(Dr.isoPathFrom('Wrote ISO image'), null);
    assert.equal(Dr.isoPathFrom('wrote ISO image: /o/x.iso'), null);
    assert.equal(Dr.isoPathFrom('  Wrote ISO image: /o/x.iso'), null);
});

test('isoPathFrom only strips a trailing group that really looks like a size', () => {
    ['(v2)', '(beta)', '(1 M B)', '(final)', '()', '(-1M)'].forEach((suffix) =>
        assert.equal(Dr.isoPathFrom('Wrote ISO image: /o/x.iso ' + suffix), '/o/x.iso ' + suffix,
            'wrongly stripped ' + suffix));
});

test('isoPathFrom strips only the last group when the path has its own parentheses', () => {
    assert.equal(Dr.isoPathFrom('Wrote ISO image: /o/rear (old).iso (267M)'), '/o/rear (old).iso');
});

test('isoPathFrom trims surrounding whitespace and tabs from the path', () => {
    assert.equal(Dr.isoPathFrom('Wrote ISO image:\t/o/x.iso   '), '/o/x.iso');
    assert.equal(Dr.isoPathFrom('Wrote ISO image:     /o/x.iso'), '/o/x.iso');
});

test('isoPathFrom keeps a unicode or metacharacter-laden ISO path verbatim', () => {
    ['/var/lib/rear/çıktı/日本語.iso', "/o/it's.iso", '/o/$(id).iso', '/o/a;b.iso']
        .forEach((p) => assert.equal(Dr.isoPathFrom('Wrote ISO image: ' + p + ' (1M)'), p));
});

test('isoPathFrom keeps the last good path when a later report is malformed', () => {
    assert.equal(Dr.isoPathFrom('Wrote ISO image: /o/a.iso (1M)\nWrote ISO image:\n'), '/o/a.iso');
});

test('isoPathFrom reads a CRLF log', () => {
    assert.equal(Dr.isoPathFrom('Making ISO image\r\nWrote ISO image: /o/x.iso (1M)\r\n'), '/o/x.iso');
});

test('isoPathFrom coerces non-string input rather than throwing', () => {
    [42, {}, [], true].forEach((v) => assert.equal(Dr.isoPathFrom(v), null));
});

// ------------------------------------------------- I/O layer, stubbed cockpit

test('the I/O layer rejects typed when cockpit is present but unusable', async () => {
    for (const stub of [null, 0, {}, { file: undefined, spawn: undefined }]) {
        await withCockpit(stub, async () => {
            await assert.rejects(() => Dr.readLocalConf(),
                (e) => Errors.isHangarError(e) && e.kind === Errors.KIND.GENERIC);
            await assert.rejects(() => Dr.mkrescue(),
                (e) => Errors.isHangarError(e) && e.kind === Errors.KIND.GENERIC);
            await assert.rejects(() => Dr.writeLocalConf({ repoId: 'x', repoUrl: '/srv/b' }),
                (e) => Errors.isHangarError(e) && e.kind === Errors.KIND.GENERIC);
        });
    }
});

test('writeLocalConf writes the rendered config to the documented path as root', async () => {
    const stub = fileStub();
    await withCockpit(stub, async () => {
        await Dr.writeLocalConf(Object.assign({}, BASE));
        await Dr.writeLocalConf(Object.assign({}, BASE), '/etc/rear/site.conf');
    });
    assert.equal(stub.calls[0].path, Dr.LOCAL_CONF_PATH);
    assert.deepEqual(stub.calls[0].options, { superuser: 'require' });
    assert.equal(stub.calls[0].replaced, render());
    assert.equal(stub.calls[1].path, '/etc/rear/site.conf');
});

test('writeLocalConf validates before it touches cockpit at all', async () => {
    const stub = fileStub();
    await withCockpit(stub, async () => {
        await assert.rejects(() => Dr.writeLocalConf({ repoId: 'BAD' }),
            (e) => Errors.isHangarError(e) && e.kind === Errors.KIND.GENERIC);
    });
    assert.deepEqual(stub.calls, [], 'an invalid config still reached cockpit');
});

test('writeLocalConf propagates a cockpit write failure', async () => {
    await withCockpit(fileStub({ replaceRejects: new Error('read-only filesystem') }), async () => {
        await assert.rejects(() => Dr.writeLocalConf(Object.assign({}, BASE)), /read-only filesystem/);
    });
});

test('readLocalConf reads the documented path and any explicit override', async () => {
    const stub = fileStub();
    await withCockpit(stub, async () => {
        assert.equal(await Dr.readLocalConf(), 'conf-of:' + Dr.LOCAL_CONF_PATH);
        assert.equal(await Dr.readLocalConf('/etc/rear/site.conf'), 'conf-of:/etc/rear/site.conf');
    });
    assert.deepEqual(stub.calls[0].options, { superuser: 'require' });
});

test('mkrescue spawns the documented argv with stderr interleaved into stdout', async () => {
    const stub = spawnStub({ out: 'Wrote ISO image: /o/x.iso (1M)\n' });
    await withCockpit(stub, () => Dr.mkrescue());
    assert.deepEqual(stub.calls[0].argv, ['rear', '-v', 'mkrescue']);
    assert.deepEqual(stub.calls[0].options, { superuser: 'require', err: 'out' });
});

test('mkrescue resolves with the ISO path and the parsed log', async () => {
    const r = await withCockpit(spawnStub({ out: fixture('synthetic-mkrescue-ok.txt') }),
        () => Dr.mkrescue());
    assert.equal(r.iso, '/var/lib/rear/output/rear-db01.iso');
    assert.equal(r.log.phase, 'done');
    assert.equal(r.log.percent, 100);
    assert.deepEqual(r.log.errors, []);
});

test('mkrescue reports progress from the partial buffer as chunks arrive', async () => {
    const seen = [];
    const stub = spawnStub({
        out: 'Wrote ISO image: /o/x.iso (1M)\n',
        chunks: ['Relax-and-Recover 2.7\n', 'Creating disk layout\n', 'Copying binaries\n',
            'Making ISO image\n']
    });
    const r = await withCockpit(stub, () => Dr.mkrescue((p) => seen.push(p.phase + ':' + p.percent)));
    assert.deepEqual(seen, ['starting:5', 'layout:15', 'copying:45', 'iso:85']);
    assert.equal(r.iso, '/o/x.iso');
});

test('mkrescue falls back to the streamed buffer when the process yields no output', async () => {
    const stub = spawnStub({ out: '', chunks: ['Making ISO image\n', 'Wrote ISO image: /o/y.iso (2M)\n'] });
    const r = await withCockpit(stub, () => Dr.mkrescue(() => {}));
    assert.equal(r.iso, '/o/y.iso');
    assert.equal(r.log.percent, 100);
});

test('mkrescue tolerates a non-function progress callback and a proc without stream', async () => {
    const out = 'Wrote ISO image: /o/x.iso (1M)\n';
    for (const cb of [undefined, null, 'nope', 42, {}]) {
        const r = await withCockpit(spawnStub({ out: out, chunks: ['ignored\n'] }), () => Dr.mkrescue(cb));
        assert.equal(r.iso, '/o/x.iso');
    }
    const r = await withCockpit(spawnStub({ out: out }), () => Dr.mkrescue(() => {}));
    assert.equal(r.iso, '/o/x.iso');
});

test('mkrescue rejects typed when ReaR finished without reporting an image', async () => {
    const out = 'Relax-and-Recover 2.7\nMaking ISO image\n';
    await withCockpit(spawnStub({ out: out }), async () => {
        await assert.rejects(() => Dr.mkrescue(), (e) => {
            assert.ok(Errors.isHangarError(e));
            assert.equal(e.kind, Errors.KIND.GENERIC);
            assert.equal(Errors.isFatal(e), true);
            assert.equal(e.detail.phase, 'iso');
            assert.equal(e.detail.rawTail, out.replace(/\n$/, ''));
            return true;
        });
    });
});

test('mkrescue turns a failed process into a typed error carrying the parsed log', async () => {
    const err = new Error('ERROR: Could not find a required program: restic');
    await withCockpit(spawnStub({ fail: true, error: err }), async () => {
        await assert.rejects(() => Dr.mkrescue(), (e) => {
            assert.ok(Errors.isHangarError(e), 'raw cockpit error leaked out');
            assert.equal(e.kind, Errors.KIND.GENERIC);
            assert.equal(e.message, 'rear mkrescue failed.');
            assert.deepEqual(e.detail.errors, ['ERROR: Could not find a required program: restic']);
            return true;
        });
    });
});

test('mkrescue prefers the streamed buffer over the error message on failure', async () => {
    const stub = spawnStub({
        fail: true, error: new Error('exited with code 1'),
        chunks: [fixture('synthetic-mkrescue-error.txt')]
    });
    await withCockpit(stub, async () => {
        await assert.rejects(() => Dr.mkrescue(() => {}), (e) => {
            assert.deepEqual(e.detail.errors, ['ERROR: Could not find a required program: restic']);
            return true;
        });
    });
});

test('mkrescue survives a failure with no message and no buffer at all', async () => {
    await withCockpit(spawnStub({ fail: true, error: undefined }), async () => {
        await assert.rejects(() => Dr.mkrescue(), (e) => {
            assert.ok(Errors.isHangarError(e));
            assert.equal(e.detail.rawTail, '');
            return true;
        });
    });
});

test('the I/O layer is inert again once cockpit goes away', async () => {
    assert.equal(typeof globalThis.cockpit, 'undefined', 'a cockpit stub leaked between tests');
    await assert.rejects(() => Dr.readLocalConf(), (e) => Errors.isHangarError(e));
});

// --- one exclude file for the machine, not one per job ---------------------
//
// Reported from real use: the Recovery screen showed hangar's short default
// exclude list while the backup job used a 70-pattern ~/excludes.txt. Two
// answers to "what does this machine skip" is one too many — the DR snapshot
// would have carried the hundreds of gigabytes the job was told to leave out.

test('an exclude file reaches restic as --exclude-file', () => {
    const conf = render({ excludeFile: '/home/appuser/excludes.txt' });
    assert.match(conf, /'--exclude-file' '\/home\/appuser\/excludes\.txt'/);
});

test('the exclude file is carried into the rescue system', () => {
    // A rescue shell that reruns the backup step must be able to read it;
    // restic treats a missing --exclude-file as a hard error, not a warning.
    const conf = render({ excludeFile: '/home/appuser/excludes.txt' });
    const copySection = conf.slice(conf.indexOf('COPY_AS_IS+='));
    assert.ok(copySection.includes("'/home/appuser/excludes.txt'"),
        'the exclude file is not copied into the rescue system');
});

test('no exclude file means no flag at all, not an empty one', () => {
    // `--exclude-file ''` would make restic fail on every run.
    const conf = render();
    assert.ok(!conf.includes('--exclude-file'));
});

test('an exclude file is held to the same path rules as everything else here', () => {
    // This string is sourced by a rescue shell running as root.
    for (const bad of ['relative.txt', '/home/../etc/x', '/home/a\nb'])
        assert.ok(Dr.validate({ repoId: 'n', repoUrl: '/r', excludeFile: bad })
            .some((p) => /Exclude file/.test(p)), JSON.stringify(bad));
    assert.equal(Dr.validate({ repoId: 'n', repoUrl: '/r', excludeFile: '/home/appuser/excludes.txt' })
        .some((p) => /Exclude file/.test(p)), false);
});

// --- where the image ENDED UP, not where it was built ----------------------
//
// ReaR always builds into its own output directory, then copies the result to
// OUTPUT_URL — into a subdirectory named after the host. hangar reported the
// build path, so the screen sent people to /var/lib/rear/output while their
// rescue image was in /home/appuser/localhost. Both lines are in ReaR's log; only
// one of them is the file to put on a USB stick.

const REAL_TAIL = [
    'Wrote ISO image: /var/lib/rear/output/rear-localhost.iso (905M)',
    "Copying result files '/var/lib/rear/output/rear-localhost.iso " +
        "/var/tmp/rear.zabqAzl1bwFCFoE/tmp/VERSION' to /home/appuser/localhost at file location"
].join('\n');

test('isoPathFrom reports the copy destination when ReaR made one', () => {
    assert.equal(Dr.isoPathFrom(REAL_TAIL), '/home/appuser/localhost/rear-localhost.iso');
});

test('isoPathFrom falls back to the build path when nothing was copied', () => {
    // OUTPUT_URL pointing at ReaR's own directory produces no copy step.
    assert.equal(Dr.isoPathFrom('Wrote ISO image: /var/lib/rear/output/rear-localhost.iso (905M)'),
        '/var/lib/rear/output/rear-localhost.iso');
});

test('a remote destination is not reported as a local path', () => {
    // nfs:// or sftp:// is not somewhere the operator can open a file, so the
    // built copy — which does exist here — is the honest answer.
    const text = 'Wrote ISO image: /var/lib/rear/output/x.iso (1G)\n' +
        "Copying result files '/var/lib/rear/output/x.iso' to nfs://nas/export at nfs location";
    assert.equal(Dr.isoPathFrom(text), '/var/lib/rear/output/x.iso');
});

test('a rerun supersedes an earlier build, and its delivery', () => {
    const text = [
        'Wrote ISO image: /var/lib/rear/output/old.iso (1G)',
        "Copying result files '/old.iso' to /tmp/first at file location",
        'Wrote ISO image: /var/lib/rear/output/new.iso (1G)',
        "Copying result files '/new.iso' to /home/appuser/localhost at file location"
    ].join('\n');
    assert.equal(Dr.isoPathFrom(text), '/home/appuser/localhost/new.iso');
});

test('isoPathFrom still reports nothing when ReaR wrote no image', () => {
    assert.equal(Dr.isoPathFrom('Copying result files \'/x\' to /home/appuser at file location'), null);
    assert.equal(Dr.isoPathFrom(''), null);
    assert.equal(Dr.isoPathFrom('no iso here'), null);
});

// --- restic must be able to run where ReaR runs it -------------------------

test('the DR backup carries a cache directory, like every other hangar path', () => {
    // ReaR is not a login shell; restic exits 1 when it can neither find nor
    // make a cache. The same failure killed the Logbook mount and would have
    // killed every scheduled backup.
    const conf = render();
    const backup = conf.slice(conf.indexOf('EXTERNAL_BACKUP=('), conf.indexOf('EXTERNAL_RESTORE=('));
    assert.match(backup, /'--cache-dir' '\/var\/cache\/hangar\/restic'/);
});

test('the DR restore uses --no-cache, because the rescue system has nowhere to put one', () => {
    // /var/cache/hangar does not exist in the rescue initramfs and may not be
    // creatable. A cache would only speed up a second run, and there is no
    // second run — this is the recovery.
    const conf = render();
    const restore = conf.slice(conf.indexOf('EXTERNAL_RESTORE=('));
    assert.match(restore, /'--no-cache'/);
    assert.ok(!/--cache-dir/.test(restore.slice(0, restore.indexOf(')'))),
        'the restore leg points at a cache directory that will not exist');
});

test('restore latest is pinned to a host when one is configured', () => {
    // Without it, a repository holding more than one machine can restore the
    // wrong machine onto this one — silently, and only once.
    const conf = render({ host: 'db01' });
    const restore = conf.slice(conf.indexOf('EXTERNAL_RESTORE=('));
    assert.match(restore, /'--host' 'db01'/);
});

// ReaR's default SSH_FILES='avoid_sensitive_files' copies only authorized_keys
// and known_hosts from /root/.ssh, dropping every private key. COPY_AS_IS does
// not override it. An unattended sftp restore then stops at
// "backup@host's password:" with no terminal to answer — observed in a real drill
// after the disk layout had been recreated successfully.
test('an sftp rescue system carries the key it needs to reach the repository', () => {
    const conf = render({ repoKind: 'sftp', repoUrl: 'sftp:u@nas:/vol/restic' });
    assert.match(conf, /^SSH_FILES=\(\n\s+'\/root\/\.ssh\/'\n\)$/m);
});

test('a local repository is not given ssh keys it has no use for', () => {
    assert.ok(!render().includes('SSH_FILES'));
    assert.ok(!render({ repoKind: 'rclone', repoUrl: 'rclone:r:bucket' }).includes('SSH_FILES'));
});

// ReaR copies the key and then deletes it: 501_check_ssh_keys.sh strips private
// keys that have no passphrase, because SSH_UNPROTECTED_PRIVATE_KEYS defaults
// to 'no'. An unattended restore cannot type a passphrase, so its key is always
// unprotected — without this the drill stops at "backup@host's password:" even
// with SSH_FILES set. Observed twice on a real drill.
test('the sftp key survives ReaR stripping unprotected private keys', () => {
    const conf = render({ repoKind: 'sftp', repoUrl: 'sftp:u@nas:/vol/restic' });
    assert.match(conf, /^SSH_UNPROTECTED_PRIVATE_KEYS='yes'$/m);
});

test('a repository that needs no ssh key does not keep unprotected keys', () => {
    assert.ok(!render().includes('SSH_UNPROTECTED_PRIVATE_KEYS'));
});
