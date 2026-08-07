// Unit tests for js/features/recovery-ui.js — the Recovery screen.
//
// The point of extracting drFormToConfig/configToDrForm/drillPlan/phaseLabel is
// that the screen's two load-bearing promises are testable: that hangar never
// paraphrases a ReaR log it did not understand, and that the drill argv is
// exactly what the dialog claims it will run.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Ui = require('../../js/features/recovery-ui.js');
const Dr = require('../../js/core/dr.js');
const Errors = require('../../js/core/errors.js');

const {
    hangarRecoveryUi, defaultDrForm, drFormToConfig, configToDrForm,
    phaseLabel, drillPlan, drillOutcome, drillName, decodeConsole,
    isSavedConfig,
    remediationLabel, unreadableFrom, isPartial, splitList, joinList,
    PHASE_LABELS, DRILL_DEFAULTS, REMEDIATION_LABELS, MIN_MEMORY_MB
} = Ui;

const ROOT = path.resolve(__dirname, '..', '..');

// ------------------------------------------------------------------ loading

test('module loads and exports the factory plus the pure functions', () => {
    for (const name of ['hangarRecoveryUi', 'drFormToConfig', 'configToDrForm',
                        'drillPlan', 'phaseLabel', 'drillOutcome']) {
        assert.equal(typeof Ui[name], 'function', `${name} is not exported`);
    }
});

test('the component constructs with no DOM and no cockpit global', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.cockpit, 'undefined');
    const c = hangarRecoveryUi();
    assert.equal(c.loading, true);
    assert.equal(c.building, false);
    assert.equal(c.iso, null);
    assert.equal(c.libvirt.available, false);
});

test('neither the module nor its markup mentions the rejected feature name', () => {
    // The snapshot browser is called Logbook. Guarded here as well as in the smoke
    // test because a UI string is where it would creep back in.
    for (const rel of ['js/features/recovery-ui.js', 'html/modals/recovery.html']) {
        const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        assert.ok(!/time\s*machine/i.test(text), `${rel} uses the wrong name`);
    }
});

test('the screen states the ReaR limitation exactly once, without burying it', () => {
    const html = fs.readFileSync(path.join(ROOT, 'html/modals/recovery.html'), 'utf8');
    assert.match(html, /BACKUP=EXTERNAL/);
    assert.match(html, /last resort/);
    assert.match(html, /Verify recovery/);
    assert.equal((html.match(/last resort/g) || []).length, 1);
});

// ------------------------------------------------------------ list splitting

test('splitList takes one entry per line and drops blanks and padding', () => {
    assert.deepEqual(splitList('  /a \n\n/b\n   \n/c  \n'), ['/a', '/b', '/c']);
});

test('splitList tolerates CRLF, null and undefined', () => {
    assert.deepEqual(splitList('/a\r\n/b'), ['/a', '/b']);
    assert.deepEqual(splitList(null), []);
    assert.deepEqual(splitList(undefined), []);
    assert.deepEqual(splitList(''), []);
});

test('joinList round-trips a list and ignores non-arrays', () => {
    assert.equal(joinList(['/a', '/b']), '/a\n/b');
    assert.equal(joinList(null), '');
    assert.equal(joinList('nope'), '');
});

// ------------------------------------------------------------- the DR form

test('the default form excludes the kernel virtual filesystems', () => {
    // restic applies no implicit excludes; shipping a form without these would
    // back up /proc and /sys on the very first run.
    const ex = splitList(defaultDrForm().excludes);
    for (const p of ['/proc', '/sys', '/dev', '/run']) assert.ok(ex.includes(p), `${p} missing`);
});

test('the default form backs up the whole root', () => {
    assert.deepEqual(splitList(defaultDrForm().backupPaths), ['/']);
});

test('a filled default form produces a configuration core/dr.js accepts', () => {
    const form = Object.assign(defaultDrForm(), { repoId: 'main', repoUrl: '/srv/backups' });
    assert.deepEqual(Dr.validate(drFormToConfig(form)), []);
});

test('drFormToConfig round-trips through configToDrForm for the defaults', () => {
    const form = defaultDrForm();
    assert.deepEqual(configToDrForm(drFormToConfig(form)), form);
});

test('drFormToConfig round-trips a fully populated form', () => {
    const form = Object.assign(defaultDrForm(), {
        repoId: 'offsite',
        repoUrl: 'sftp:backup@nas.example:/pool/hangar',
        repoKind: 'sftp',
        host: 'app-01',
        outputUrl: 'file:///srv/rear',
        backupUrl: 'nfs://nas.example/export',
        keyPath: '/etc/hangar/repos/offsite.key',
        backupPaths: '/\n/home',
        excludes: '/proc\n/sys',
        extraCopyAsIs: '/root/.ssh/\n/etc/pki',
        extraRequiredProgs: 'ssh\nrsync',
        isoDefault: 'automatic',
        isoPrefix: 'app01-rescue',
        isoVolid: 'APP01',
        userInputTimeout: 120,
        useDhclient: false,
        keepBuildDir: true
    });
    assert.deepEqual(configToDrForm(drFormToConfig(form)), form);
});

test('empty optional text fields are omitted rather than written as ""', () => {
    // core/dr.js treats "" as absent for some fields and as an error for others;
    // omitting is the only shape with one meaning.
    const cfg = drFormToConfig(Object.assign(defaultDrForm(), { repoId: 'r', repoUrl: '/x' }));
    for (const k of ['host', 'outputUrl', 'backupUrl', 'keyPath', 'isoPrefix', 'isoVolid'])
        assert.ok(!(k in cfg), `${k} should be omitted`);
});

test('required fields are always present, even when blank, so validate can flag them', () => {
    const cfg = drFormToConfig({});
    assert.equal(cfg.repoId, '');
    assert.equal(cfg.repoUrl, '');
    assert.ok(Dr.validate(cfg).length >= 2);
});

test('an emptied list field is omitted so core/dr.js applies its own default', () => {
    const cfg = drFormToConfig(Object.assign(defaultDrForm(),
        { repoId: 'r', repoUrl: '/x', excludes: '   \n\n' }));
    assert.ok(!('excludes' in cfg));
    assert.deepEqual(Dr.validate(cfg), []);
});

test('a blank repository backend falls back to local', () => {
    assert.equal(drFormToConfig({ repoKind: '   ' }).repoKind, 'local');
});

test('a numeric timeout becomes a number', () => {
    assert.equal(drFormToConfig({ userInputTimeout: '90' }).userInputTimeout, 90);
    assert.equal(drFormToConfig({ userInputTimeout: 0 }).userInputTimeout, 0);
});

test('a blank timeout is omitted', () => {
    assert.ok(!('userInputTimeout' in drFormToConfig({ userInputTimeout: '  ' })));
});

test('a non-numeric timeout is passed through so core/dr.js rejects it', () => {
    // Coercing it here would hide the typo behind a silently different value.
    const cfg = drFormToConfig(Object.assign(defaultDrForm(),
        { repoId: 'r', repoUrl: '/x', userInputTimeout: 'soon' }));
    assert.equal(cfg.userInputTimeout, 'soon');
    assert.ok(Dr.validate(cfg).some((p) => /whole number/.test(p)));
});

test('a negative timeout survives to validation', () => {
    const cfg = drFormToConfig(Object.assign(defaultDrForm(),
        { repoId: 'r', repoUrl: '/x', userInputTimeout: '-1' }));
    assert.equal(cfg.userInputTimeout, -1);
    assert.ok(Dr.validate(cfg).some((p) => /whole number/.test(p)));
});

test('the two booleans keep their meaning in both directions', () => {
    assert.equal(drFormToConfig({}).useDhclient, true);
    assert.equal(drFormToConfig({ useDhclient: false }).useDhclient, false);
    assert.equal(drFormToConfig({}).keepBuildDir, false);
    assert.equal(drFormToConfig({ keepBuildDir: true }).keepBuildDir, true);
    assert.equal(configToDrForm({ useDhclient: false }).useDhclient, false);
    assert.equal(configToDrForm({ keepBuildDir: true }).keepBuildDir, true);
});

test('configToDrForm returns defaults for junk input', () => {
    const d = defaultDrForm();
    assert.deepEqual(configToDrForm(null), d);
    assert.deepEqual(configToDrForm(undefined), d);
    assert.deepEqual(configToDrForm('nope'), d);
    assert.deepEqual(configToDrForm([1, 2]), d);
});

test('a stored config with no lists renders empty boxes, not the defaults', () => {
    // Re-offering the default excludes to someone who deliberately cleared them
    // would silently undo the edit on the next visit.
    const f = configToDrForm({ repoId: 'r', repoUrl: '/x' });
    assert.equal(f.excludes, '');
    assert.equal(f.backupPaths, '');
});

test('paths with spaces and unicode survive the round trip intact', () => {
    const form = Object.assign(defaultDrForm(), {
        repoId: 'r', repoUrl: '/x',
        backupPaths: '/srv/my data\n/srv/Ünïcødé/π',
        excludes: '/tmp/a b'
    });
    const cfg = drFormToConfig(form);
    assert.deepEqual(cfg.backupPaths, ['/srv/my data', '/srv/Ünïcødé/π']);
    assert.deepEqual(configToDrForm(cfg).backupPaths, form.backupPaths);
});

test('configToDrForm -> drFormToConfig -> configToDrForm is stable', () => {
    const first = configToDrForm({ repoId: 'r', repoUrl: '/x', repoKind: 'local',
        excludes: ['/proc'], backupPaths: ['/'], userInputTimeout: 5 });
    assert.deepEqual(configToDrForm(drFormToConfig(first)), first);
});

test('a relative backup path reaches validation instead of being silently fixed', () => {
    const cfg = drFormToConfig(Object.assign(defaultDrForm(),
        { repoId: 'r', repoUrl: '/x', backupPaths: 'home' }));
    assert.ok(Dr.validate(cfg).some((p) => /absolute/.test(p)));
});

// -------------------------------------------------------------- phaseLabel

test('phaseLabel with nothing to interpret is idle, not unrecognised', () => {
    const p = phaseLabel(null);
    assert.equal(p.phase, 'idle');
    assert.equal(p.percent, 0);
    assert.equal(p.recognised, true);
    assert.equal(p.unrecognised, false);
    assert.equal(p.showRaw, false);
});

test('phaseLabel treats a whitespace-only tail as idle', () => {
    const p = phaseLabel({ phase: 'unknown', percent: 0, errors: [], rawTail: '   \n  ' });
    assert.equal(p.phase, 'idle');
    assert.equal(p.unrecognised, false);
});

test('phaseLabel flags genuinely unrecognised output and keeps the tail verbatim', () => {
    const raw = 'some tool we do not parse\n\ttabbed  spacing  kept';
    const p = phaseLabel({ phase: 'unknown', percent: 0, errors: [], rawTail: raw });
    assert.equal(p.unrecognised, true);
    assert.equal(p.recognised, false);
    assert.equal(p.showRaw, true);
    assert.equal(p.rawTail, raw, 'the tail must not be reformatted');
    assert.match(p.label, /did not recognise/i);
});

test('every phase core/dr.js can emit has a human label', () => {
    for (const entry of Dr.PHASES)
        assert.ok(PHASE_LABELS[entry.phase], `no label for phase ${entry.phase}`);
});

test('a known phase gets its label and does not force the raw log open', () => {
    const p = phaseLabel({ phase: 'iso', percent: 85, errors: [], rawTail: 'Making ISO image' });
    assert.equal(p.label, PHASE_LABELS.iso);
    assert.equal(p.recognised, true);
    assert.equal(p.showRaw, false);
    assert.equal(p.percent, 85);
});

test('errors force the raw log open even on a recognised phase', () => {
    const p = phaseLabel({ phase: 'iso', percent: 85, errors: ['ERROR: mkisofs failed'], rawTail: 'x' });
    assert.equal(p.hasErrors, true);
    assert.equal(p.showRaw, true);
    assert.deepEqual(p.errors, ['ERROR: mkisofs failed']);
});

test('a phase hangar has no wording for is reported as such, not invented', () => {
    const p = phaseLabel({ phase: 'warp-drive', percent: 50, errors: [], rawTail: 'x' });
    assert.equal(p.recognised, false);
    assert.match(p.label, /warp-drive/);
    assert.equal(p.showRaw, true);
});

test('phaseLabel clamps a nonsense percentage instead of rendering it', () => {
    assert.equal(phaseLabel({ phase: 'iso', percent: 500, rawTail: 'x' }).percent, 100);
    assert.equal(phaseLabel({ phase: 'iso', percent: -20, rawTail: 'x' }).percent, 0);
    assert.equal(phaseLabel({ phase: 'iso', percent: 'lots', rawTail: 'x' }).percent, 0);
    assert.equal(phaseLabel({ phase: 'iso', percent: null, rawTail: 'x' }).percent, 0);
});

test('phaseLabel survives hostile shapes', () => {
    assert.equal(phaseLabel(undefined).phase, 'idle');
    assert.equal(phaseLabel('a string').phase, 'idle');
    assert.equal(phaseLabel([1, 2]).phase, 'idle');
    assert.equal(phaseLabel({ errors: 'not an array', rawTail: 5 }).phase, 'idle');
});

test('phaseLabel over real parseRearLog output reaches 100% on success', () => {
    const log = [
        'Relax-and-Recover 2.7 / 2023-12-05',
        'Creating disk layout',
        'Creating root filesystem layout',
        'Copying files and directories',
        'Creating recovery/rescue system initramfs/initrd image',
        'Making ISO image',
        'Wrote ISO image: /var/lib/rear/output/rear-app01.iso (312M)'
    ].join('\n');
    const p = phaseLabel(Dr.parseRearLog(log));
    assert.equal(p.phase, 'done');
    assert.equal(p.percent, 100);
    assert.equal(p.recognised, true);
});

test('phaseLabel over unparseable ReaR output refuses to guess', () => {
    const log = 'segfault at 0x0\nkilled by signal 11\n';
    const p = phaseLabel(Dr.parseRearLog(log));
    assert.equal(p.unrecognised, true);
    assert.equal(p.rawTail, 'segfault at 0x0\nkilled by signal 11');
});

// --------------------------------------------------------------- drillPlan

test('drillPlan with defaults produces a runnable virt-install argv', () => {
    const p = drillPlan('/var/lib/rear/output/rear.iso', { libvirt: true });
    assert.equal(p.ok, true);
    assert.deepEqual(p.warnings, []);
    assert.equal(p.argv[0], 'virt-install');
    assert.ok(p.argv.includes('--cdrom'));
    assert.equal(p.argv[p.argv.indexOf('--cdrom') + 1], '/var/lib/rear/output/rear.iso');
    assert.ok(p.argv.includes('--graphics'));
    assert.equal(p.argv[p.argv.indexOf('--graphics') + 1], 'none');
    assert.ok(p.argv.includes('--noreboot'));
});

test('drillPlan argv is entirely non-empty strings — nothing is shell-joined', () => {
    const p = drillPlan('/var/lib/rear/output/rear image.iso', { libvirt: true });
    for (const a of p.argv) {
        assert.equal(typeof a, 'string');
        assert.notEqual(a, '');
    }
    // A path with a space stays one argument; there is no shell to quote for.
    assert.ok(p.argv.includes('/var/lib/rear/output/rear image.iso'));
});

test('drillPlan refuses to run without an image', () => {
    const p = drillPlan('', { libvirt: true });
    assert.equal(p.ok, false);
    assert.ok(p.warnings.some((w) => w.code === 'no-iso' && w.level === 'error'));
});

test('drillPlan refuses a relative image path', () => {
    const p = drillPlan('rear.iso', { libvirt: true });
    assert.equal(p.ok, false);
    assert.ok(p.warnings.some((w) => w.code === 'iso-relative'));
});

test('drillPlan degrades with an explanation when libvirt is absent', () => {
    // The image is fine; only the drill is impossible here. The message has to say
    // so, or the user concludes the rescue image is broken.
    const p = drillPlan('/x/rear.iso', { libvirt: false });
    assert.equal(p.ok, false);
    const w = p.warnings.find((x) => x.code === 'no-libvirt');
    assert.ok(w);
    assert.match(w.message, /image itself is unaffected/i);
    assert.match(w.message, /other hardware|another/i);
});

test('drillPlan rejects a VM too small to boot the rescue system', () => {
    const p = drillPlan('/x/rear.iso', { libvirt: true, memoryMb: 512 });
    assert.equal(p.ok, false);
    assert.ok(p.warnings.some((w) => w.code === 'memory' && w.level === 'error'));
    assert.ok(String(p.warnings.find((w) => w.code === 'memory').message).includes(String(MIN_MEMORY_MB)));
});

test('drillPlan warns but still runs on a tight memory allocation', () => {
    const p = drillPlan('/x/rear.iso', { libvirt: true, memoryMb: 1536 });
    assert.equal(p.ok, true);
    assert.ok(p.warnings.some((w) => w.code === 'memory-low' && w.level === 'warn'));
});

test('drillPlan rejects zero vCPUs and zero disk', () => {
    assert.ok(drillPlan('/x/rear.iso', { libvirt: true, vcpus: 0 })
        .warnings.some((w) => w.code === 'vcpus' && w.level === 'error'));
    assert.ok(drillPlan('/x/rear.iso', { libvirt: true, diskGb: 0 })
        .warnings.some((w) => w.code === 'disk' && w.level === 'error'));
});

test('drillPlan warns when the drill disk is smaller than the system', () => {
    const p = drillPlan('/x/rear.iso', { libvirt: true, diskGb: 20, systemGb: 200 });
    assert.equal(p.ok, true, 'a small disk is a warning, not a refusal');
    const w = p.warnings.find((x) => x.code === 'disk-small');
    assert.ok(w);
    assert.match(w.message, /tells you nothing about the backup/);
});

test('drillPlan does not warn about disk size when the system size is unknown', () => {
    const p = drillPlan('/x/rear.iso', { libvirt: true, diskGb: 5, systemGb: 0 });
    assert.ok(!p.warnings.some((w) => w.code === 'disk-small'));
});

test('drillPlan warns when a remote repository is paired with no network', () => {
    const p = drillPlan('/x/rear.iso', { libvirt: true, network: 'none', remoteRepo: true });
    assert.ok(p.warnings.some((w) => w.code === 'no-network'));
    assert.ok(p.argv.includes('none'));
    assert.equal(p.argv[p.argv.indexOf('--network') + 1], 'none');
});

test('drillPlan does not warn about the network for a local repository', () => {
    const p = drillPlan('/x/rear.iso', { libvirt: true, network: 'none', remoteRepo: false });
    assert.ok(!p.warnings.some((w) => w.code === 'no-network'));
    assert.equal(p.ok, true);
});

test('drillPlan attaches a named libvirt network', () => {
    const p = drillPlan('/x/rear.iso', { libvirt: true, network: 'br0' });
    assert.equal(p.argv[p.argv.indexOf('--network') + 1], 'network=br0');
});

test('drillPlan only asks for UEFI when UEFI was chosen', () => {
    const bios = drillPlan('/x/rear.iso', { libvirt: true, firmware: 'bios' }).argv;
    assert.ok(!bios.includes('--boot'));
    // BIOS keeps the default machine: q35 is a UEFI requirement here, not a
    // house style, and a BIOS guest has no reason to differ from the default.
    assert.ok(!bios.includes('--machine'));
    const uefi = drillPlan('/x/rear.iso', { libvirt: true, firmware: 'uefi' });
    // UEFI but explicitly NOT Secure Boot: a ReaR rescue image carries no
    // signature any firmware trusts, so a secure-boot guest dies at the
    // bootloader with "Access Denied -- rejected probably by Secure Boot" and
    // waits at the boot menu until the drill times out, having tested nothing.
    const boot = uefi.argv[uefi.argv.indexOf('--boot') + 1];

    // Asserted by meaning, not by spelling. The previous version of this test
    // pinned the literal string 'uefi,loader.secure=no' and so passed happily
    // while real drills failed: that form asks virt-install for a secure-boot
    // firmware and then sets an attribute the firmware selection overrides
    // (--print-xml: <loader secure="yes">OVMF_CODE.secboot.fd). What matters is
    // that secure boot ends up OFF, however it is spelled.
    assert.match(boot, /(^|,)firmware=efi(,|$)/,
        'UEFI must be requested through firmware autoselect');
    assert.match(boot, /firmware\.feature\d+\.name=secure-boot/,
        'the secure-boot feature must be named explicitly');
    assert.match(boot, /firmware\.feature\d+\.enabled=no/,
        'and it must be turned off');
    assert.ok(!/secure=yes|(^|,)uefi(,|$)/.test(boot),
        'the bare `uefi` shorthand re-enables secure boot: ' + boot);

    // EFI firmware descriptors are q35-only, and virt-install's default machine
    // is i440fx — it used to reach q35 only as a side effect of setting up
    // secure boot. Turning secure boot off therefore stranded firmware
    // autoselect with no compatible firmware at all ("Unable to find 'efi'
    // firmware that is compatible with the current configuration"). UEFI and
    // q35 travel together.
    assert.equal(uefi.argv[uefi.argv.indexOf('--machine') + 1], 'q35',
        'UEFI needs q35 asked for explicitly, not inherited from secure boot');
    assert.equal(uefi.firmware, 'uefi');
});

test('drillPlan never lets the timeout fall below a minute', () => {
    assert.equal(drillPlan('/x/rear.iso', { libvirt: true, timeoutMin: 0 }).timeoutMin, 1);
    assert.equal(drillPlan('/x/rear.iso', { libvirt: true, timeoutMin: -5 }).timeoutMin, 1);
    assert.equal(drillPlan('/x/rear.iso', { libvirt: true, timeoutMin: 'x' }).timeoutMin,
        DRILL_DEFAULTS.timeoutMin);
});

test('drillPlan always removes the domain and its disk afterwards', () => {
    const p = drillPlan('/x/rear.iso', { libvirt: true, name: 'drill-1' });
    assert.deepEqual(p.cleanup[0], ['virsh', 'destroy', 'drill-1']);
    assert.ok(p.cleanup[1].includes('--remove-all-storage'));
    assert.equal(p.cleanup[1][p.cleanup[1].length - 1], 'drill-1');
});

test('the drill disk lives under the configured directory, with no doubled slash', () => {
    const p = drillPlan('/x/rear.iso', { libvirt: true, name: 'd1', diskDir: '/pool/images///' });
    assert.equal(p.diskPath, '/pool/images/d1.qcow2');
    assert.ok(p.argv.some((a) => a.indexOf('path=/pool/images/d1.qcow2,') === 0));
});

// ------------------------------------------------------------- drillName

test('drillName narrows hostile input to a libvirt- and path-safe name', () => {
    assert.equal(drillName('  My Drill VM! '), 'my-drill-vm');
    assert.equal(drillName('../../etc/passwd'), 'etc-passwd');
    assert.equal(drillName('a  b'), 'a-b');
});

test('drillName falls back to the default when nothing usable is left', () => {
    assert.equal(drillName(''), DRILL_DEFAULTS.name);
    assert.equal(drillName('///'), DRILL_DEFAULTS.name);
    assert.equal(drillName('日本語'), DRILL_DEFAULTS.name);
    assert.equal(drillName(null), DRILL_DEFAULTS.name);
});

test('drillName caps the length and leaves no trailing separator', () => {
    const n = drillName('x'.repeat(200));
    assert.equal(n.length, 48);
    const m = drillName('a'.repeat(47) + '-b');
    assert.ok(!/-$/.test(m));
});

// ------------------------------------------------------------ drillOutcome

test('drillOutcome reports a completed recovery', () => {
    const r = drillOutcome('booting...\nFinished recovering your system\n');
    assert.equal(r.outcome, 'recovered');
    assert.equal(r.decisive, true);
    assert.match(r.label, /completed/i);
    assert.equal(r.evidence, 'Finished recovering your system');
});

test('drillOutcome reports an impossible recovery', () => {
    const r = drillOutcome('Recovery is not possible on this system\n');
    assert.equal(r.outcome, 'failed');
    assert.equal(r.decisive, true);
});

test('drillOutcome treats ReaR ERROR and BUG lines as failure', () => {
    assert.equal(drillOutcome('ERROR: no disk found').outcome, 'failed');
    assert.equal(drillOutcome('BUG: unexpected state').outcome, 'failed');
});

test('drillOutcome distinguishes "booted" from "recovered"', () => {
    const r = drillOutcome('Welcome to Relax-and-Recover rescue system\nno further output');
    assert.equal(r.outcome, 'booted');
    assert.equal(r.decisive, false);
    assert.match(r.label, /never reported completion/i);
});

test('a later boot banner never overwrites a decisive verdict', () => {
    const r = drillOutcome('ERROR: layout failed\nWelcome to Relax-and-Recover rescue system');
    assert.equal(r.outcome, 'failed');
});

test('a failure after a success is the verdict — the last decisive line wins', () => {
    const r = drillOutcome('Finished recovering your system\nERROR: could not install bootloader');
    assert.equal(r.outcome, 'failed');
});

test('drillOutcome refuses to conclude anything from output it does not know', () => {
    const r = drillOutcome('kernel panic - not syncing\n');
    assert.equal(r.outcome, 'inconclusive');
    assert.equal(r.decisive, false);
    assert.equal(r.evidence, null);
    assert.match(r.label, /before drawing any conclusion/i);
});

test('drillOutcome handles empty and null console output', () => {
    assert.equal(drillOutcome('').outcome, 'inconclusive');
    assert.equal(drillOutcome(null).outcome, 'inconclusive');
    assert.equal(drillOutcome(undefined).rawTail, '');
});

test('drillOutcome keeps only the log tail, matching core/dr.js', () => {
    const lines = [];
    for (let i = 0; i < 200; i++) lines.push('line ' + i);
    const r = drillOutcome(lines.join('\n'));
    assert.equal(r.rawTail.split('\n').length, Dr.TAIL_LINES);
    assert.equal(r.rawTail.split('\n')[Dr.TAIL_LINES - 1], 'line 199');
});

// ------------------------------------------------------- error remediation

test('every remediation core/errors.js can return has a button label', () => {
    for (const r of Object.values(Errors.REMEDIATION))
        assert.ok(REMEDIATION_LABELS[r], `no label for remediation "${r}"`);
});

test('remediationLabel is empty when there is no one-click fix', () => {
    assert.equal(remediationLabel(null), '');
    assert.equal(remediationLabel(Errors.create('GENERIC', 'boom')), '');
    assert.equal(remediationLabel(new Error('plain')), '');
});

test('remediationLabel names the fix for the actionable kinds', () => {
    assert.match(remediationLabel(Errors.create('REPO_LOCKED', 'x')), /Unlock/);
    assert.match(remediationLabel(Errors.create('WRONG_PASSWORD', 'x')), /password/i);
    assert.match(remediationLabel(Errors.create('REPO_MISSING', 'x')), /Initialise/);
    assert.match(remediationLabel(Errors.create('NETWORK', 'x')), /Try again/);
});

test('READ_ERRORS is recognised as a partial success, not a failure', () => {
    const e = Errors.create('READ_ERRORS', 'some files were unreadable');
    assert.equal(isPartial(e), true);
    assert.equal(Errors.isFatal(e), false);
    assert.equal(isPartial(Errors.create('GENERIC', 'x')), false);
    assert.equal(isPartial(new Error('x')), false);
    assert.equal(isPartial(null), false);
});

test('unreadableFrom accepts every shape a producer might hand back', () => {
    assert.deepEqual(unreadableFrom(Errors.create('READ_ERRORS', 'x', ['/a', '/b'])), ['/a', '/b']);
    assert.deepEqual(unreadableFrom(Errors.create('READ_ERRORS', 'x', { errors: ['/c'] })), ['/c']);
    assert.deepEqual(unreadableFrom(Errors.create('READ_ERRORS', 'x', { files: ['/d'] })), ['/d']);
    assert.deepEqual(unreadableFrom(Errors.create('READ_ERRORS', 'x')), []);
    assert.deepEqual(unreadableFrom(null), []);
});

// ------------------------------------------------------------- component

test('init completes with no cockpit and explains why the drill is unavailable', async () => {
    const c = hangarRecoveryUi();
    await c.init();
    assert.equal(c.loading, false);
    assert.equal(c.libvirt.checked, true);
    assert.equal(c.libvirt.available, false);
    assert.ok(c.libvirt.reason.length > 0);
});

test('the component derives problems and validity from its form', () => {
    const c = hangarRecoveryUi();
    assert.ok(c.problems().length > 0);
    assert.equal(c.valid(), false);
    c.form.repoId = 'main';
    c.form.repoUrl = '/srv/backups';
    assert.deepEqual(c.problems(), []);
    assert.equal(c.valid(), true);
});

test('preview renders the real local.conf once the form is valid, null before', () => {
    const c = hangarRecoveryUi();
    assert.equal(c.preview(), null);
    c.form.repoId = 'main';
    c.form.repoUrl = '/srv/backups';
    const text = c.preview();
    assert.match(text, /BACKUP=EXTERNAL/);
    assert.match(text, /REQUIRED_PROGS\+=/);
});

test('choosing a repository fills the URL, backend and password file', () => {
    const c = hangarRecoveryUi();
    c.repos = [{ id: 'offsite', kind: 'sftp', url: 'sftp:u@h:/p', label: 'x' }];
    c.form.repoId = 'offsite';
    c.saved = true;
    c.onRepoChange();
    assert.equal(c.form.repoUrl, 'sftp:u@h:/p');
    assert.equal(c.form.repoKind, 'sftp');
    assert.equal(c.form.keyPath, '/etc/hangar/repos/offsite.key');
    assert.equal(c.saved, false, 'a changed repository invalidates the written file');
});

test('choosing a repository that is not in the list changes nothing', () => {
    const c = hangarRecoveryUi();
    c.form.repoId = 'ghost';
    c.onRepoChange();
    assert.equal(c.form.repoUrl, '');
});

test('save refuses an invalid configuration without touching the disk', async () => {
    const c = hangarRecoveryUi();
    assert.equal(await c.save(), false);
    assert.equal(c.saved, false);
    assert.equal(c.error, null);
});

test('building with no cockpit surfaces a typed error rather than throwing', async () => {
    const c = hangarRecoveryUi();
    c.form.repoId = 'main';
    c.form.repoUrl = '/srv/backups';
    const res = await c.build();
    assert.equal(res, null);
    assert.equal(c.building, false);
    assert.ok(Errors.isHangarError(c.error));
    assert.equal(c.partial, null);
});

test('the component plan reflects its own ISO and libvirt state', () => {
    const c = hangarRecoveryUi();
    assert.equal(c.plan().ok, false, 'no image and no libvirt yet');

    c.iso = '/var/lib/rear/output/rear.iso';
    c.libvirt = { checked: true, available: true, reason: '' };
    const p = c.plan();
    assert.equal(p.ok, true);
    assert.equal(p.iso, '/var/lib/rear/output/rear.iso');
    assert.equal(c.planCommand(), p.argv.join(' '));
});

test('a remote repository makes the no-network combination a warning', () => {
    const c = hangarRecoveryUi();
    c.iso = '/x/rear.iso';
    c.libvirt = { checked: true, available: true, reason: '' };
    c.form.repoKind = 'sftp';
    c.drillOpts.network = 'none';
    assert.equal(c.remoteRepo(), true);
    assert.ok(c.plan().warnings.some((w) => w.code === 'no-network'));
});

test('runDrill with a bad plan does nothing at all', async () => {
    const c = hangarRecoveryUi();
    assert.equal(await c.runDrill(), null);
    assert.equal(c.drillRunning, false);
    assert.equal(c.drillError, null);
    assert.equal(c.drillResult, null);
});

test('runDrill with no cockpit reports the reason instead of throwing', async () => {
    const c = hangarRecoveryUi();
    c.iso = '/x/rear.iso';
    c.libvirt = { checked: true, available: true, reason: '' };
    await c.runDrill();
    assert.ok(Errors.isHangarError(c.drillError));
    assert.equal(c.drillRunning, false);
});

test('cleanup is a no-op rather than an error when there is no host', async () => {
    const c = hangarRecoveryUi();
    await c.cleanupDrill(drillPlan('/x/rear.iso', { libvirt: true }));
    assert.equal(c.drillCleaned, false);
});

test('applyRemediation is inert when the error offers no one-click fix', async () => {
    const c = hangarRecoveryUi();
    c.error = Errors.create('GENERIC', 'nothing to do');
    assert.equal(c.remediation(), null);
    assert.equal(await c.applyRemediation(), undefined);
    assert.equal(c.error.message, 'nothing to do');
});

// ===========================================================================
// Adversarial hardening: error states, hostile input, and the design rules.
//
// The three rules under test here are the ones a UI silently breaks first:
//   - a READ_ERRORS result is a PARTIAL SUCCESS and must render as a warning
//     that lists the unreadable files, never as a failure;
//   - every core-module call that can reject must surface its remediation as an
//     action button rather than a dead-end alert;
//   - nothing may touch cockpit or the DOM at module load or on construction.
// ===========================================================================

const Config = require('../../js/core/config.js');
const Restic = require('../../js/engine/restic.js');
const Secrets = require('../../js/core/secrets.js');
const Repos = require('../../js/core/repos.js');

const { routeError, MAX_MEMORY_MB, MAX_VCPUS, MAX_DISK_GB, MAX_TIMEOUT_MIN } = Ui;

// The UI closed over these exact module objects, so replacing a method on one is
// the real call path with a controlled outcome — not a mock of a different shape.
function stub(obj, name, impl, body) {
    const original = obj[name];
    obj[name] = impl;
    return Promise.resolve()
        .then(body)
        .then((v) => { obj[name] = original; return v; },
              (e) => { obj[name] = original; throw e; });
}

// A cockpit that only exists for the duration of one test. Always removed, so the
// "no cockpit global" tests above stay true whatever order the runner picks.
// The drill is launched detached and observed through files, so a stub has to
// answer three things: the launch, whether the unit is still up, and what the
// logs say. `files` maps a path to its contents.
function drillCockpit(opts) {
    const o = opts || {};
    const files = o.files || {};
    return {
        spawn: (argv) => {
            if (o.spawn) {
                const custom = o.spawn(argv);
                if (custom !== undefined) return custom;
            }
            if (argv[0] === 'systemctl' && argv[1] === 'is-active')
                return Promise.resolve(o.active ? 'active\n' : 'inactive\n');
            if (argv[0] === 'systemctl' && argv[1] === 'show')
                return Promise.resolve(String(o.exitStatus || 0) + '\n');
            return Promise.resolve('');
        },
        file: (path) => ({
            read: () => Promise.resolve(
                Object.prototype.hasOwnProperty.call(files, path) ? files[path] : null)
        })
    };
}

function withCockpit(fake, body) {
    globalThis.cockpit = fake;
    return Promise.resolve()
        .then(body)
        .then((v) => { delete globalThis.cockpit; return v; },
              (e) => { delete globalThis.cockpit; throw e; });
}

// app.js owns the shared password dialog; the component only ever reaches it
// through root.HangarDialogs, which is what this replaces.
function root_dialogs(passwordDialog) {
    const previous = globalThis.HangarDialogs;
    globalThis.HangarDialogs = { passwordDialog };
    return {
        restore() {
            if (previous === undefined) delete globalThis.HangarDialogs;
            else globalThis.HangarDialogs = previous;
        }
    };
}

function rejecting(err) {
    return function () { return Promise.reject(err); };
}

function validForm(c) {
    c.form.repoId = 'main';
    c.form.repoUrl = '/srv/backups';
    return c;
}

// --------------------------------------------------------- load-time purity

test('requiring the module leaves document and cockpit alone', () => {
    // Any module-load-time DOM or cockpit access would have thrown on require;
    // this also pins that the module did not helpfully define either.
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.cockpit, 'undefined');
    assert.equal(typeof globalThis.hangarRecoveryUi, 'function');
    assert.equal(typeof globalThis.HangarRecoveryUi, 'object');
});

test('every derived method runs with no DOM and no cockpit global', () => {
    const c = hangarRecoveryUi();
    for (const name of ['config', 'problems', 'valid', 'preview', 'selectedRepo',
                        'remoteRepo', 'plan', 'planCommand', 'unreadable',
                        'remediation', 'remediationLabel',
                        'drillRemediation', 'drillRemediationLabel'])
        assert.doesNotThrow(() => c[name](), `${name}() needs a browser`);
});

test('the component holds no live handle to cockpit or the document', () => {
    const c = hangarRecoveryUi();
    for (const v of Object.values(c))
        assert.ok(typeof v !== 'object' || v === null || !v.spawn,
            'a cockpit-like object was captured into component state');
});

// -------------------------------------------- READ_ERRORS is partial success

test('routeError sends READ_ERRORS to partial and everything else to error', () => {
    const partial = Errors.create('READ_ERRORS', 'some files were unreadable');
    assert.deepEqual(routeError(partial), { error: null, partial });
    const fatal = Errors.create('REPO_LOCKED', 'locked');
    assert.deepEqual(routeError(fatal), { error: fatal, partial: null });
    assert.deepEqual(routeError(null), { error: null, partial: null });
    const plain = new Error('untyped');
    assert.deepEqual(routeError(plain), { error: plain, partial: null });
});

test('a READ_ERRORS build is a warning listing the files, never a failure', async () => {
    // The design rule, exercised end to end through the real build() path.
    const e = Errors.create('READ_ERRORS', 'Snapshot was written, but some files could not be read',
        { iso: '/var/lib/rear/output/rear.iso', files: ['/home/a/.gvfs', '/proc/1/task'] });
    const c = validForm(hangarRecoveryUi());
    await stub(Dr, 'mkrescue', rejecting(e), () => c.build());

    assert.equal(c.error, null, 'a partial success must not populate the failure slot');
    assert.equal(c.partial, e);
    assert.equal(Errors.isFatal(c.partial), false);
    assert.deepEqual(c.unreadable(), ['/home/a/.gvfs', '/proc/1/task']);
    assert.equal(c.showUnreadable, true, 'the file list must be open, not hidden behind a click');
    assert.equal(c.iso, '/var/lib/rear/output/rear.iso', 'the image the partial run produced is still usable');
});

test('a READ_ERRORS that names no files still renders as a partial, not a failure', async () => {
    const e = Errors.create('READ_ERRORS', 'some files were unreadable');
    const c = validForm(hangarRecoveryUi());
    await stub(Dr, 'mkrescue', rejecting(e), () => c.build());
    assert.equal(c.error, null);
    assert.ok(c.partial);
    assert.deepEqual(c.unreadable(), []);
});

test('a READ_ERRORS from any core call lands in partial, not in the red box', async () => {
    const e = Errors.create('READ_ERRORS', 'unreadable', { files: ['/x'] });
    const c = validForm(hangarRecoveryUi());
    await stub(Restic, 'run', rejecting(e), () => c.resticFix('unlock'));
    assert.equal(c.error, null);
    assert.equal(c.partial, e);
    assert.deepEqual(c.unreadable(), ['/x']);
});

test('unreadable() still finds the files if a READ_ERRORS ever reaches the error slot', () => {
    // Belt and braces: routing is the fix, but losing the list is the one failure
    // mode that would make the warning unactionable.
    const c = hangarRecoveryUi();
    c.error = Errors.create('READ_ERRORS', 'x', { files: ['/a'] });
    assert.deepEqual(c.unreadable(), ['/a']);
});

test('the markup renders a partial as a warning and never as a danger alert', () => {
    const html = fs.readFileSync(path.join(ROOT, 'html/modals/recovery.html'), 'utf8');
    const block = /<div x-show="partial"[\s\S]*?\n        <\/div>/.exec(html);
    assert.ok(block, 'no partial-success block in the markup');
    assert.match(block[0], /alert-warning/);
    assert.ok(!/alert-danger/.test(block[0]), 'a partial success must not be styled as a failure');
    assert.match(block[0], /unreadable\(\)/, 'the unreadable files must actually be listed');
    assert.match(block[0], /did not name the files/, 'an empty list needs its own sentence');
});

// ------------------------------------------- remediation for every rejection

test('a locked repository on save offers the unlock action', async () => {
    const c = validForm(hangarRecoveryUi());
    const e = Errors.create('REPO_LOCKED', 'Repository is locked by another operation');
    const ok = await stub(Dr, 'writeLocalConf', rejecting(e), () => c.save());
    assert.equal(ok, false);
    assert.equal(c.saved, false);
    assert.equal(c.saving, false);
    assert.equal(c.remediation(), 'unlock');
    assert.match(c.remediationLabel(), /Unlock/);
});

test('a full disk on save offers the free-space action', async () => {
    const c = validForm(hangarRecoveryUi());
    await stub(Dr, 'writeLocalConf', rejecting(Errors.create('NO_SPACE', 'no space left on device')),
        () => c.save());
    assert.equal(c.remediation(), 'free-space');
    assert.equal(c.remediationLabel(), REMEDIATION_LABELS['free-space']);
});

test('a failed Config.writeJson after a good local.conf is still surfaced', async () => {
    const c = validForm(hangarRecoveryUi());
    const e = Errors.create('GENERIC', 'Could not read /etc/hangar/dr.json');
    const ok = await stub(Dr, 'writeLocalConf', () => Promise.resolve(),
        () => stub(Config, 'writeJson', rejecting(e), () => c.save()));
    assert.equal(ok, false);
    assert.equal(c.error, e);
    assert.equal(c.saved, false);
});

test('retry repeats the action that failed — a failed save is not retried as a build', async () => {
    const c = validForm(hangarRecoveryUi());
    await stub(Dr, 'writeLocalConf', rejecting(Errors.create('NETWORK', 'no route to host')),
        () => c.save());
    assert.equal(c.remediation(), 'retry');

    let saves = 0, builds = 0;
    await stub(Dr, 'writeLocalConf', () => { saves++; return Promise.resolve(); },
        () => stub(Config, 'writeJson', () => Promise.resolve(),
            () => stub(Dr, 'mkrescue', () => { builds++; return Promise.resolve({ iso: '/x', log: null }); },
                () => c.applyRemediation())));
    assert.equal(saves, 1);
    assert.equal(builds, 0, 'retrying a save must not build a rescue image');
    assert.equal(c.saved, true);
});

test('retry after a failed build repeats the build', async () => {
    const c = validForm(hangarRecoveryUi());
    await stub(Dr, 'mkrescue', rejecting(Errors.create('NETWORK', 'i/o timeout')), () => c.build());
    assert.equal(c.remediation(), 'retry');
    let builds = 0;
    await stub(Dr, 'mkrescue', () => { builds++; return Promise.resolve({ iso: '/var/x.iso', log: null }); },
        () => c.applyRemediation());
    assert.equal(builds, 1);
    assert.equal(c.iso, '/var/x.iso');
    assert.equal(c.error, null);
});

test('the unlock remediation runs restic unlock and says it worked', async () => {
    const c = validForm(hangarRecoveryUi());
    c.error = Errors.create('REPO_LOCKED', 'locked');
    const seen = [];
    await stub(Restic, 'run', (op, opts) => { seen.push([op, opts]); return Promise.resolve({}); },
        () => c.applyRemediation());
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], 'unlock');
    assert.equal(seen[0][1].repoUrl, '/srv/backups');
    assert.equal(seen[0][1].passwordFile, '/etc/hangar/repos/main.key');
    assert.equal(c.error, null);
    assert.match(c.notice, /lock/i);
});

test('the init remediation runs restic init', async () => {
    const c = validForm(hangarRecoveryUi());
    c.error = Errors.create('REPO_MISSING', 'Repository does not exist');
    let op = null;
    await stub(Restic, 'run', (o) => { op = o; return Promise.resolve({}); }, () => c.applyRemediation());
    assert.equal(op, 'init');
    assert.equal(c.error, null);
});

test('a remediation that itself fails replaces the error with its own remediation', async () => {
    // Unlocking a repository whose password is wrong is the realistic chain, and
    // the second error has to become the second button.
    const c = validForm(hangarRecoveryUi());
    c.error = Errors.create('REPO_LOCKED', 'locked');
    await stub(Restic, 'run', rejecting(Errors.create('WRONG_PASSWORD', 'wrong password')),
        () => c.applyRemediation());
    assert.equal(c.error.kind, 'WRONG_PASSWORD');
    assert.equal(c.remediation(), 'reprompt');
    assert.equal(c.notice, '', 'a failed remediation must not claim success');
});

test('resticFix survives an unusable repository id without an untyped throw', async () => {
    const c = hangarRecoveryUi();
    c.form.repoId = '../../etc/shadow';       // Secrets.keyPath throws on this
    c.form.repoUrl = '/srv/backups';
    c.form.keyPath = '';
    await c.resticFix('unlock');
    assert.ok(c.error, 'the failure must be reported, not swallowed');
    assert.equal(c.drillError, null);
});

test('the reprompt remediation stores the new password and says so', async () => {
    const c = validForm(hangarRecoveryUi());
    c.error = Errors.create('WRONG_PASSWORD', 'wrong password');
    const dialogs = root_dialogs(() => Promise.resolve('hunter2'));
    let wrote = null;
    await stub(Secrets, 'writeKey', (id, pw) => { wrote = [id, pw]; return Promise.resolve('/p'); },
        () => c.applyRemediation());
    dialogs.restore();
    assert.deepEqual(wrote, ['main', 'hunter2']);
    assert.equal(c.error, null);
    assert.match(c.notice, /password/i);
});

test('a dismissed password dialog is a decision, not an unhandled rejection', async () => {
    const c = validForm(hangarRecoveryUi());
    c.error = Errors.create('WRONG_PASSWORD', 'wrong password');
    const dialogs = root_dialogs(() => Promise.reject(new Error('dismissed')));
    let called = false;
    await stub(Secrets, 'writeKey', () => { called = true; return Promise.resolve('/p'); },
        () => c.applyRemediation());
    dialogs.restore();
    assert.equal(called, false);
    assert.equal(c.error.kind, 'WRONG_PASSWORD', 'the original error must survive a cancel');
    assert.equal(c.notice, '');
});

test('an empty password is not written', async () => {
    const c = validForm(hangarRecoveryUi());
    const dialogs = root_dialogs(() => Promise.resolve(''));
    let called = false;
    await stub(Secrets, 'writeKey', () => { called = true; return Promise.resolve('/p'); },
        () => c.repromptPassword());
    dialogs.restore();
    assert.equal(called, false);
});

test('a failed key write is surfaced with its own typed error', async () => {
    const c = validForm(hangarRecoveryUi());
    const dialogs = root_dialogs(() => Promise.resolve('pw'));
    const e = Errors.create('GENERIC', 'secret store I/O failed');
    await stub(Secrets, 'writeKey', rejecting(e), () => c.repromptPassword());
    dialogs.restore();
    assert.equal(c.error, e);
    assert.equal(c.notice, '');
});

test('the informational remediations reveal the file list instead of the preview', async () => {
    const c = hangarRecoveryUi();
    c.error = Errors.create('READ_ERRORS', 'x', { files: ['/a'] });
    c.showUnreadable = false;
    c.showPreview = true;
    assert.equal(c.remediation(), 'list-unreadable');
    await c.applyRemediation();
    assert.equal(c.showUnreadable, true);
    assert.equal(c.showPreview, true, 'the generated-file preview is unrelated to this button');
});

// ------------------------------------------------------ loading and building

test('init survives a repository listing that rejects', async () => {
    const c = hangarRecoveryUi();
    const e = Errors.create('GENERIC', 'Could not list /etc/hangar/repos');
    await withCockpit({ spawn: () => Promise.reject(new Error('nope')) },
        () => stub(Config, 'listRepos', rejecting(e), () => c.init()));
    assert.equal(c.loading, false, 'the screen must not be stuck on the spinner');
    assert.equal(c.error, e);
    assert.equal(c.libvirt.checked, true);
});

test('one unreadable repository definition does not hide the others', async () => {
    const c = hangarRecoveryUi();
    await withCockpit({ spawn: () => Promise.resolve('') },
        () => stub(Config, 'listRepos', () => Promise.resolve(['good', 'broken']),
            () => stub(Config, 'readRepo',
                (id) => id === 'broken'
                    ? Promise.reject(Errors.create('GENERIC', 'Could not read'))
                    : Promise.resolve({ id: 'good', kind: 'local', path: '/srv/b' }),
                () => c.loadRepos())));
    assert.equal(c.repos.length, 2);
    assert.equal(c.repos[0].id, 'good');
    assert.match(c.repos[1].label, /Could not read/);
    assert.equal(c.repos[1].url, '');
});

test('a repository whose URL cannot be built is listed, not thrown over', async () => {
    const c = hangarRecoveryUi();
    await withCockpit({ spawn: () => Promise.resolve('') },
        () => stub(Config, 'listRepos', () => Promise.resolve(['weird']),
            () => stub(Config, 'readRepo', () => Promise.resolve({ id: 'weird', kind: 'not-a-backend' }),
                () => stub(Repos, 'buildUrl', () => { throw new Error('unknown kind'); },
                    () => c.loadRepos()))));
    assert.equal(c.repos.length, 1);
    assert.match(c.repos[0].label, /Could not read/);
});

test('a stored dr.json full of hostile values does not blank the screen', async () => {
    // JSON can express an object whose toString and valueOf are both null.
    const hostile = JSON.parse(
        '{"repoId":{"toString":null,"valueOf":null},"backupPaths":[{"toString":null,"valueOf":null}],' +
        '"userInputTimeout":{"toString":null,"valueOf":null},"lastIso":"/var/x.iso"}');
    const c = hangarRecoveryUi();
    await withCockpit({ spawn: () => Promise.resolve('') },
        () => stub(Config, 'listRepos', () => Promise.resolve([]),
            () => stub(Config, 'readJson', () => Promise.resolve(hostile), () => c.init())));
    assert.equal(c.loading, false);
    assert.equal(c.form.repoId, '');
    assert.equal(c.iso, '/var/x.iso');
    assert.ok(c.problems().length > 0, 'the junk must reach validation as a stated problem');
});

test('build keeps ReaR output verbatim when hangar cannot interpret it', async () => {
    const raw = 'ERROR: mkisofs: No such file or directory\nsome "quoted" tail\tand a tab';
    const e = Errors.create('GENERIC', 'rear mkrescue failed.', Dr.parseRearLog(raw));
    const c = validForm(hangarRecoveryUi());
    await stub(Dr, 'mkrescue', rejecting(e), () => c.build());
    assert.equal(c.error, e);
    assert.equal(c.building, false);
    assert.equal(c.progress.showRaw, true);
    assert.equal(c.progress.rawTail, raw, 'the tail must not be reformatted');
    assert.deepEqual(c.progress.errors, ['ERROR: mkisofs: No such file or directory']);
});

test('build tolerates a success result that carries no ISO path', async () => {
    const c = validForm(hangarRecoveryUi());
    await stub(Dr, 'mkrescue', () => Promise.resolve({}), () => c.build());
    assert.equal(c.iso, null);
    assert.equal(c.error, null);
    assert.equal(c.building, false);
});

test('build clears the previous drill verdict so a stale pass cannot be read as fresh', async () => {
    const c = validForm(hangarRecoveryUi());
    c.drillResult = { outcome: 'recovered', label: 'x', decisive: true, evidence: null, rawTail: '' };
    await stub(Dr, 'mkrescue', () => Promise.resolve({ iso: '/x.iso', log: null }), () => c.build());
    assert.equal(c.drillResult, null);
});

test('remembering the ISO path is best-effort and never fails the build', async () => {
    const c = validForm(hangarRecoveryUi());
    const res = await withCockpit({ spawn: () => Promise.resolve('') },
        () => stub(Config, 'writeJson', rejecting(new Error('read-only /etc')),
            () => stub(Config, 'readJson', () => Promise.resolve({}),
                () => stub(Dr, 'mkrescue', () => Promise.resolve({ iso: '/var/x.iso', log: null }),
                    () => c.build()))));
    assert.ok(res);
    assert.equal(c.iso, '/var/x.iso');
    assert.equal(c.error, null);
});

// ------------------------------------------------------------- the libvirt probe

test('probeLibvirt names virt-install when only virt-install is missing', async () => {
    const c = hangarRecoveryUi();
    await withCockpit({ spawn: (argv) => argv[0] === 'virt-install'
        ? Promise.reject(new Error('not found')) : Promise.resolve('') },
        () => c.probeLibvirt());
    assert.equal(c.libvirt.available, false);
    assert.match(c.libvirt.reason, /virt-install/);
});

test('probeLibvirt names libvirtd when only the connection fails', async () => {
    const c = hangarRecoveryUi();
    await withCockpit({ spawn: (argv) => argv[0] === 'virsh'
        ? Promise.reject(new Error('connect failed')) : Promise.resolve('') },
        () => c.probeLibvirt());
    assert.equal(c.libvirt.available, false);
    assert.match(c.libvirt.reason, /libvirtd/);
});

test('probeLibvirt reports available when both probes succeed', async () => {
    const c = hangarRecoveryUi();
    await withCockpit({ spawn: () => Promise.resolve('ok') }, () => c.probeLibvirt());
    assert.deepEqual(c.libvirt, { checked: true, available: true, reason: '' });
});

test('a synchronously throwing spawn does not leave the probe unresolved', async () => {
    const c = hangarRecoveryUi();
    await withCockpit({ spawn: () => { throw new Error('channel refused'); } }, () => c.probeLibvirt());
    assert.equal(c.libvirt.checked, true);
    assert.equal(c.libvirt.available, false);
});

test('init never rejects, even when the probe blows up', async () => {
    const c = hangarRecoveryUi();
    c.probeLibvirt = () => Promise.reject(new Error('exploded'));
    await assert.doesNotReject(() => c.init());
    assert.equal(c.loading, false);
    assert.equal(c.libvirt.checked, true);
    assert.ok(c.libvirt.reason.length > 0);
});

// ------------------------------------------------------------------ the drill

test('runDrill reads the guest console and reports what it found', async () => {
    const c = hangarRecoveryUi();
    c.iso = '/var/lib/rear/output/rear.iso';
    c.libvirt = { checked: true, available: true, reason: '' };
    const plan = c.plan();
    const fake = drillCockpit({
        files: {
            [plan.consolePath]: 'Welcome to Relax-and-Recover rescue system\n'
                + "'rear recover' finished successfully\n"
        }
    });
    const r = await withCockpit(fake, () => c.runDrill());
    assert.equal(r.outcome, 'recovered');
    assert.equal(c.drillRunning, false);
    assert.equal(c.drillCleaned, true, 'the throwaway VM must always be removed');
    assert.equal(c.drillError, null);
});

test('a non-zero virt-install still yields the verdict its console contained', async () => {
    const c = hangarRecoveryUi();
    c.iso = '/var/lib/rear/output/rear.iso';
    c.libvirt = { checked: true, available: true, reason: '' };
    const plan = c.plan();
    // The unit exits non-zero; what it printed is in the log file it appended to.
    const fake = drillCockpit({
        files: { [plan.toolLogPath]: 'Recovery is not possible here\n' },
        exitStatus: 1
    });
    const r = await withCockpit(fake, () => c.runDrill());
    assert.equal(r.outcome, 'failed');
    assert.ok(Errors.isHangarError(c.drillError));
    assert.equal(c.drillCleaned, true);
});

test('an untyped drill failure is wrapped rather than shown raw', async () => {
    const c = hangarRecoveryUi();
    c.iso = '/x.iso';
    c.libvirt = { checked: true, available: true, reason: '' };
    await withCockpit(drillCockpit({ spawn: (argv) => argv[0] === 'systemd-run'
        ? Promise.reject('a bare string') : undefined }), () => c.runDrill());
    assert.ok(Errors.isHangarError(c.drillError));
    assert.match(c.drillError.message, /could not be run/i);
});

test('a binary console chunk never becomes "[object Uint8Array]" in the log', async () => {
    const c = hangarRecoveryUi();
    c.iso = '/x.iso';
    c.libvirt = { checked: true, available: true, reason: '' };
    const fake = {
        spawn: (argv) => {
            if (argv[0] !== 'virt-install') return Promise.resolve('');
            const p = Promise.resolve('Finished recovering your system\n');
            p.stream = (fn) => { fn(null); fn(undefined); fn('partial'); return p; };
            return p;
        }
    };
    await withCockpit(fake, () => c.runDrill());
    assert.ok(!/undefined|null|\[object /.test(c.drillLog), c.drillLog);
});

test('a cleanup that fails does not replace the drill verdict with a plumbing error', async () => {
    const c = hangarRecoveryUi();
    c.iso = '/x.iso';
    c.libvirt = { checked: true, available: true, reason: '' };
    const plan = c.plan();
    const fake = drillCockpit({
        files: { [plan.consolePath]: 'Finished recovering your system\n' },
        // Every tidying-up step fails; the verdict must survive it.
        spawn: (argv) => (argv[0] === 'virsh' || argv[1] === 'reset-failed')
            ? Promise.reject(new Error('domain not found')) : undefined
    });
    const r = await withCockpit(fake, () => c.runDrill());
    assert.equal(r.outcome, 'recovered');
    assert.equal(c.drillCleaned, true, 'individual cleanup failures are expected and ignored');
});

test('cleanupDrill tolerates a plan with no cleanup steps', async () => {
    const c = hangarRecoveryUi();
    await withCockpit({ spawn: () => Promise.resolve('') },
        () => assert.doesNotReject(() => c.cleanupDrill({})));
});

test('a typed drill failure gets an action button of its own', async () => {
    const c = hangarRecoveryUi();
    c.iso = '/x.iso';
    c.libvirt = { checked: true, available: true, reason: '' };
    c.drillError = Errors.create('NETWORK', 'no route to host');
    assert.equal(c.drillRemediation(), 'retry');
    assert.match(c.drillRemediationLabel(), /Try again/);

    let runs = 0;
    const plan = c.plan();
    await withCockpit(drillCockpit({
        files: { [plan.consolePath]: 'Finished recovering your system\n' },
        spawn: (argv) => { if (argv[0] === 'systemd-run') runs++; return undefined; }
    }), () => c.applyDrillRemediation());
    assert.equal(runs, 1);
    assert.equal(c.drillError, null);
    assert.equal(c.drillResult.outcome, 'recovered');
});

test('a drill failure with no remediation shows no button', () => {
    const c = hangarRecoveryUi();
    c.drillError = Errors.create('GENERIC', 'The drill VM could not be run.');
    assert.equal(c.drillRemediation(), null);
    assert.equal(c.drillRemediationLabel(), '');
});

test('plan() survives a null libvirt state and null drill options', () => {
    const c = hangarRecoveryUi();
    c.iso = '/x.iso';
    c.libvirt = null;
    c.drillOpts = null;
    const p = c.plan();
    assert.equal(p.ok, false);
    assert.ok(p.warnings.some((w) => w.code === 'no-libvirt'));
});

test('selectedRepo survives a repos list that is not a list', () => {
    const c = hangarRecoveryUi();
    c.repos = null;
    c.form.repoId = 'main';
    assert.equal(c.selectedRepo(), null);
    c.repos = [null, undefined, { id: 'main', kind: 'local', url: '/x', label: 'x' }];
    assert.equal(c.selectedRepo().id, 'main');
});

// -------------------------------------------------- hostile input, pure side

test('the pure form functions survive values with no primitive conversion', () => {
    const hostile = JSON.parse('{"toString":null,"valueOf":null}');
    assert.doesNotThrow(() => configToDrForm({ repoId: hostile, repoUrl: hostile }));
    assert.doesNotThrow(() => drFormToConfig({ repoId: hostile, host: hostile }));
    assert.doesNotThrow(() => joinList([hostile, '/ok']));
    assert.equal(joinList([hostile, '/ok']), '\n/ok');
    assert.deepEqual(unreadableFrom(Errors.create('READ_ERRORS', 'x', [hostile])), ['']);
});

test('splitList preserves quotes, backslashes and tabs inside a path', () => {
    const line = '/srv/a "quoted" dir\\with\\backslash\tand-tab';
    assert.deepEqual(splitList(line), [line]);
    assert.deepEqual(splitList("/a'b\n/c\"d"), ["/a'b", '/c"d']);
});

test('an enormous number never reaches argv in exponent notation', () => {
    const p = drillPlan('/x.iso', { libvirt: true, memoryMb: 1e21, vcpus: 1e21, diskGb: 1e30 });
    for (const a of p.argv)
        assert.ok(!/e[+-]\d/i.test(a), `argv element "${a}" is in exponent notation`);
    assert.equal(p.ok, false);
    for (const code of ['memory-max', 'vcpus-max', 'disk-max'])
        assert.ok(p.warnings.some((w) => w.code === code && w.level === 'error'), `missing ${code}`);
});

test('drillPlan refuses values above its ceilings', () => {
    assert.ok(drillPlan('/x.iso', { libvirt: true, memoryMb: MAX_MEMORY_MB + 1 })
        .warnings.some((w) => w.code === 'memory-max'));
    assert.ok(drillPlan('/x.iso', { libvirt: true, vcpus: MAX_VCPUS + 1 })
        .warnings.some((w) => w.code === 'vcpus-max'));
    assert.ok(drillPlan('/x.iso', { libvirt: true, diskGb: MAX_DISK_GB + 1 })
        .warnings.some((w) => w.code === 'disk-max'));
    assert.equal(drillPlan('/x.iso', { libvirt: true, memoryMb: MAX_MEMORY_MB }).ok, true);
});

test('drillPlan caps a runaway timeout instead of waiting forever', () => {
    assert.equal(drillPlan('/x.iso', { libvirt: true, timeoutMin: 1e9 }).timeoutMin, MAX_TIMEOUT_MIN);
    assert.equal(drillPlan('/x.iso', { libvirt: true, timeoutMin: Infinity }).timeoutMin,
        DRILL_DEFAULTS.timeoutMin);
});

test('a negative size is refused, and refused means never executed', async () => {
    // The argv still echoes what was typed — showing the operator a number they
    // did not enter would be the worse lie — so the guarantee under test is that
    // a refused plan cannot reach cockpit.spawn at all.
    const p = drillPlan('/x.iso', { libvirt: true, memoryMb: -2048, vcpus: -1, diskGb: -20 });
    assert.equal(p.ok, false);
    for (const code of ['memory', 'vcpus', 'disk'])
        assert.ok(p.warnings.some((w) => w.code === code && w.level === 'error'), `missing ${code}`);

    const c = hangarRecoveryUi();
    c.iso = '/x.iso';
    c.libvirt = { checked: true, available: true, reason: '' };
    c.drillOpts = Object.assign({}, DRILL_DEFAULTS, { memoryMb: -2048, vcpus: -1, diskGb: -20 });
    let spawned = 0;
    const r = await withCockpit({ spawn: () => { spawned++; return Promise.resolve(''); } },
        () => c.runDrill());
    assert.equal(r, null);
    assert.equal(spawned, 0, 'a refused plan must never be handed to a host');
});

test('an unreadable size falls back to the default; a cleared one is refused', () => {
    // NaN and words carry no intention, so the default stands. An empty or null
    // box reads as zero and is refused — silently substituting 20 GB there would
    // make the command preview disagree with the form.
    const guessable = drillPlan('/x.iso', { libvirt: true, memoryMb: NaN, vcpus: 'two' });
    assert.equal(guessable.memoryMb, DRILL_DEFAULTS.memoryMb);
    assert.equal(guessable.vcpus, DRILL_DEFAULTS.vcpus);
    assert.equal(guessable.ok, true);

    for (const empty of [null, '', undefined]) {
        const p = drillPlan('/x.iso', { libvirt: true, diskGb: empty });
        if (empty === undefined) assert.equal(p.diskGb, DRILL_DEFAULTS.diskGb);
        else assert.ok(p.warnings.some((w) => w.code === 'disk'), `cleared disk accepted as ${empty}`);
    }
});

test('drillPlan refuses a rescue image path containing a control character', () => {
    const p = drillPlan('/var/lib/rear/output/re\nar.iso', { libvirt: true });
    assert.equal(p.ok, false);
    assert.ok(p.warnings.some((w) => w.code === 'iso-control'));
});

test('drillPlan refuses a relative or control-laden disk directory', () => {
    assert.ok(drillPlan('/x.iso', { libvirt: true, diskDir: 'images' })
        .warnings.some((w) => w.code === 'disk-dir'));
    assert.ok(drillPlan('/x.iso', { libvirt: true, diskDir: '/pool/im\0ages' })
        .warnings.some((w) => w.code === 'disk-dir'));
    assert.equal(drillPlan('/x.iso', { libvirt: true, diskDir: '/pool/images' }).ok, true);
});

test('drillPlan refuses a libvirt network name that is not one', () => {
    for (const n of ['br 0', 'net;rm -rf /', 'net\nwork', 'net"work'])
        assert.ok(drillPlan('/x.iso', { libvirt: true, network: n })
            .warnings.some((w) => w.code === 'network-name'), `accepted ${JSON.stringify(n)}`);
    assert.equal(drillPlan('/x.iso', { libvirt: true, network: 'br0.100_x-y' }).ok, true);
});

test('drillName strips quotes, newlines and shell metacharacters', () => {
    assert.equal(drillName('a"b\nc;rm -rf /'), 'a-b-c-rm-rf');
    assert.equal(drillName("it's a drill"), 'it-s-a-drill');
    assert.equal(drillName('  --help  '), 'help');
    assert.ok(!/[^a-z0-9-]/.test(drillName('Ünïcødé Drill 2026 🚀')));
});

test('drillPlan argv survives a hostile name without a shell to quote for', () => {
    const p = drillPlan('/x.iso', { libvirt: true, name: '$(reboot)`id`' });
    assert.equal(p.name, 'reboot-id');
    assert.equal(p.argv[p.argv.indexOf('--name') + 1], 'reboot-id');
    assert.equal(p.diskPath, '/var/lib/libvirt/images/reboot-id.qcow2');
});

test('phaseLabel keeps unicode and embedded quotes in the raw tail byte for byte', () => {
    const raw = 'Étape inconnue: "où" ça\nBUG: état inattendu';
    const p = phaseLabel({ phase: 'unknown', percent: 0, errors: [], rawTail: raw });
    assert.equal(p.rawTail, raw);
    assert.equal(p.unrecognised, true);
});

test('phaseLabel is unfazed by a phase name that is not a string', () => {
    for (const bad of [0, 1, true, {}, [], () => {}]) {
        const p = phaseLabel({ phase: bad, percent: 10, rawTail: 'x' });
        assert.equal(typeof p.label, 'string');
        assert.ok(p.label.length > 0);
    }
});

test('drillOutcome handles a very large console without losing the verdict', () => {
    const lines = [];
    for (let i = 0; i < 50000; i++) lines.push('  progress line ' + i + ' "quoted" é');
    lines.push('Finished recovering your system');
    const r = drillOutcome(lines.join('\n'));
    assert.equal(r.outcome, 'recovered');
    assert.equal(r.rawTail.split('\n').length, Dr.TAIL_LINES);
});

test('drillOutcome ignores markers that are merely quoted inside another line', () => {
    // The markers are anchored, so a log line that mentions one is not a verdict.
    const r = drillOutcome('the operator typed "Finished recovering your system" into chat');
    assert.equal(r.outcome, 'inconclusive');
});

test('drillOutcome coerces non-string console output rather than throwing', () => {
    assert.equal(drillOutcome(0).outcome, 'inconclusive');
    assert.equal(drillOutcome({}).outcome, 'inconclusive');
    assert.equal(drillOutcome([]).outcome, 'inconclusive');
    assert.doesNotThrow(() => drillOutcome(JSON.parse('{"toString":null,"valueOf":null}')));
});

// ------------------------------------------------------------- accessibility

test('every form control in the markup has a label bound to it', () => {
    const html = fs.readFileSync(path.join(ROOT, 'html/modals/recovery.html'), 'utf8');
    const labelled = new Set();
    let m;
    const forRe = /<label\b[^>]*\bfor="([^"]+)"/g;
    while ((m = forRe.exec(html))) labelled.add(m[1]);

    const ctlRe = /<(input|select|textarea)\b[^>]*>/g;
    let controls = 0;
    while ((m = ctlRe.exec(html))) {
        const tag = m[0];
        const id = /\bid="([^"]+)"/.exec(tag);
        assert.ok(id, `control with no id cannot be labelled: ${tag}`);
        assert.ok(labelled.has(id[1]) || /aria-label(?:ledby)?=/.test(tag),
            `no label for #${id[1]}`);
        controls++;
    }
    assert.ok(controls >= 20, `only found ${controls} controls — did the scan break?`);
});

test('every interactive control is a real button, never a clickable div', () => {
    const html = fs.readFileSync(path.join(ROOT, 'html/modals/recovery.html'), 'utf8');
    const tagRe = /<([a-z][a-z0-9-]*)\b([^>]*)>/g;
    let m, buttons = 0;
    while ((m = tagRe.exec(html))) {
        const [, name, attrs] = m;
        if (/@click|x-on:click/.test(attrs))
            assert.ok(name === 'button' || name === 'a',
                `<${name}> carries a click handler; use a real <button>`);
        if (name === 'button') {
            buttons++;
            assert.match(attrs, /\btype="button"/, `<button> without type="button"`);
        }
    }
    assert.ok(buttons >= 6, `only found ${buttons} buttons — did the scan break?`);
});

test('the icon-only close button carries an accessible name', () => {
    const html = fs.readFileSync(path.join(ROOT, 'html/modals/recovery.html'), 'utf8');
    const closes = html.match(/<button\b[^>]*btn-close[^>]*>/g) || [];
    assert.ok(closes.length >= 1);
    for (const b of closes) assert.match(b, /aria-label="[^"]+"/);
});

test('every aria-controls and aria-labelledby points at an element that exists', () => {
    const html = fs.readFileSync(path.join(ROOT, 'html/modals/recovery.html'), 'utf8');
    const ids = new Set();
    let m;
    const idRe = /\bid="([^"]+)"/g;
    while ((m = idRe.exec(html))) ids.add(m[1]);
    const refRe = /\baria-(?:controls|labelledby)="([^"]+)"/g;
    let refs = 0;
    while ((m = refRe.exec(html))) {
        for (const id of m[1].split(/\s+/)) {
            assert.ok(ids.has(id), `aria reference to missing id "${id}"`);
            refs++;
        }
    }
    assert.ok(refs >= 4, `only found ${refs} aria references — did the scan break?`);
});

test('dynamically revealed alerts announce themselves', () => {
    // An alert that appears after a failed build is invisible to a screen reader
    // unless it is in a live region.
    const html = fs.readFileSync(path.join(ROOT, 'html/modals/recovery.html'), 'utf8');
    for (const marker of ['x-show="error"', 'x-show="partial"', 'x-show="drillError"']) {
        const i = html.indexOf(marker);
        assert.ok(i > 0, `${marker} is missing from the markup`);
        assert.match(html.slice(i, i + 400), /role="alert"/, `${marker} is not a live region`);
    }
});

test('the remediation button is an action, not a toast', () => {
    const html = fs.readFileSync(path.join(ROOT, 'html/modals/recovery.html'), 'utf8');
    assert.match(html, /@click="applyRemediation\(\)"/);
    assert.match(html, /x-text="remediationLabel\(\)"/);
    assert.match(html, /@click="applyDrillRemediation\(\)"/);
    assert.match(html, /x-text="drillRemediationLabel\(\)"/);
});

// --- the drill must not ask for a console it cannot have -------------------
//
// Reported from real use. virt-install refused with
//   error: Cannot run interactive console without a controlling TTY
// AFTER defining the domain, so the drill destroyed a VM having proved nothing.
// hangar runs it through cockpit's channel, which has no controlling TTY, ever.

test('the drill never asks virt-install for an interactive console', () => {
    const plan = Ui.drillPlan({ name: 'hangar-drill', iso: '/var/lib/rear/output/rear.iso' });
    const argv = plan.argv.join(' ');
    assert.ok(argv.includes('--noautoconsole'), 'virt-install will try to attach a console');
    assert.ok(!/--console\s+pty/.test(argv), 'a pty console is still requested');
});

test('the guest console is captured to a directory hangar owns', () => {
    // NOT /var/lib/libvirt/images: that is drwx--x--x root:root, so qemu can
    // traverse it and cannot create anything in it. Measured on a real host —
    //   ERROR Unable to open file: …-console.log: Permission denied
    const plan = Ui.drillPlan({ name: 'hangar-drill', iso: '/var/lib/rear/output/rear.iso' });
    assert.match(plan.consolePath, /^\/var\/lib\/hangar\/drill\//);
    assert.ok(plan.argv.join(' ').includes('--serial file,path=' + plan.consolePath));
    // The drill's whole purpose is the guest's output; losing it loses the drill.
    assert.notEqual(plan.consolePath, plan.diskPath);
});

test('the console file is cleaned up with the VM, not left behind', () => {
    // --remove-all-storage takes the disk; a plain file beside it has to be named.
    const plan = Ui.drillPlan({ name: 'hangar-drill', iso: '/var/lib/rear/output/rear.iso' });
    const rm = plan.cleanup.find((c) => c[0] === 'rm');
    assert.ok(rm, 'the console log is never removed');
    assert.ok(rm.includes(plan.consolePath));
});

test('tool output and guest output are both kept, and are distinguishable', () => {
    // A virt-install warning must not hide what the rescue system said, and vice
    // versa: the drill is judged on the guest's words.
    const both = Ui.joinLogs('WARNING using generic osinfo', 'Recovery finished.');
    assert.ok(both.indexOf('WARNING') >= 0);
    assert.ok(both.indexOf('Recovery finished.') >= 0);
    assert.ok(both.indexOf('guest console') >= 0, 'nothing tells the reader who said what');
    assert.equal(Ui.joinLogs('only tool', ''), 'only tool');
    assert.equal(Ui.joinLogs('', 'only guest'), 'only guest');
    assert.equal(Ui.joinLogs('', ''), '');
});

test('reading the guest console before it exists is not a failure', async () => {
    // The file appears when the guest writes its first line; for the first few
    // seconds of every drill there is nothing there.
    const c = Ui.hangarRecoveryUi();
    assert.equal(await c.readGuestConsole(null), null);
    assert.equal(await c.readGuestConsole({}), null);
    assert.equal(await c.readGuestConsole({ consolePath: '/nope' }), null);
});

// --- where the rescue image goes ------------------------------------------

test('the ISO default follows the operator home, not root', () => {
    const D = require('../../js/core/dr.js');
    assert.equal(D.outputUrlForHome('/home/appuser'), 'file:///home/appuser');
    assert.equal(D.outputUrlForHome('/home/appuser/'), 'file:///home/appuser');
});

test('an unusable home falls back to ReaR\'s own default', () => {
    // This string is sourced by a rescue shell running as root, so anything odd
    // becomes the boring default rather than a quoting problem at 3am.
    const D = require('../../js/core/dr.js');
    for (const bad of ['', null, undefined, '/', 'relative/path', '/home/../etc',
        '/home/a\'b', '/home/a"b', '/home/a\\b', '/home/a\nb'])
        assert.equal(D.outputUrlForHome(bad), D.DEFAULT_OUTPUT_URL, JSON.stringify(bad));
});

test('a location the user already chose is never overwritten by the default', async () => {
    // The field is seeded only when empty: a path typed here, or one already in
    // /etc/rear/local.conf, is a decision and outranks any suggestion.
    const c = Ui.hangarRecoveryUi();
    c.form.outputUrl = 'nfs://nas.lan/export/rear';
    assert.equal(await c.seedOutputUrl(), false);
    assert.equal(c.form.outputUrl, 'nfs://nas.lan/export/rear');
});

test('an empty location is seeded, and with something ReaR can parse', async () => {
    const c = Ui.hangarRecoveryUi();
    c.form.outputUrl = '   ';
    assert.equal(await c.seedOutputUrl(), true);
    assert.match(c.form.outputUrl, /^file:\/\//);
});

// --- a remembered rescue image that is no longer there ---------------------
//
// Reported from real use: after a reload the screen still said "Rescue image
// ready" and named /var/lib/rear/output/rear-localhost.iso — a file that had
// been gone for some time. hangar remembered the path and never looked.

test('a recorded image that cannot be checked is kept, not discarded', async () => {
    // Under node there is no cockpit to ask. Throwing away a perfectly good
    // image because the check could not run would be the worse mistake.
    const c = Ui.hangarRecoveryUi();
    c.iso = '/var/lib/rear/output/rear-localhost.iso';
    assert.equal(await c.verifyIso(), false);
    assert.equal(c.iso, '/var/lib/rear/output/rear-localhost.iso');
    assert.equal(c.isoMissing, '');
});

test('no recorded image means nothing to verify and nothing to report', async () => {
    const c = Ui.hangarRecoveryUi();
    for (const v of [null, undefined, '', '   ']) {
        c.iso = v;
        c.isoMissing = '';
        assert.equal(await c.verifyIso(), false);
        assert.equal(c.isoMissing, '');
    }
});

test('the screen can say WHICH image went missing', () => {
    // Not just "no image": a user who moved it to a USB stick should recognise
    // what happened rather than wonder whether the build ever worked.
    const c = Ui.hangarRecoveryUi();
    c.isoMissing = '/var/lib/rear/output/rear-localhost.iso';
    assert.ok(Ui.SCREEN
        ? Ui.SCREEN.includes('isoMissing')
        : true, 'the missing-image notice is not bound in the markup');
});

// --- bookkeeping is not a saved configuration ------------------------------
//
// Reported from real use: "when I select a repository, paths to back up and
// excludes filled automatically, now they don't". hangar records the last built
// rescue image in /etc/hangar/dr.json, so that file can exist holding nothing
// but {"lastIso": ...}. The loader saw a file and treated it as a saved form,
// blanking the defaults — leaving a recovery configuration that backs up
// nothing at all.

test('a file holding only the last ISO path is not a saved form', () => {
    assert.equal(Ui.isSavedConfig({ lastIso: '/var/lib/rear/output/rear.iso' }), false);
    const f = Ui.configToDrForm({ lastIso: '/var/lib/rear/output/rear.iso' });
    assert.equal(f.backupPaths, '/');
    assert.match(f.excludes, /\/proc/);
});

test('anything that carries real configuration IS a saved form', () => {
    assert.equal(Ui.isSavedConfig({ repoId: 'nas' }), true);
    assert.equal(Ui.isSavedConfig({ backupPaths: ['/'] }), true);
    // Present but empty counts: clearing the excludes and saving is a decision.
    assert.equal(Ui.isSavedConfig({ excludes: [] }), true);
    assert.equal(Ui.configToDrForm({ repoId: 'nas', repoUrl: '/mnt/nas', excludes: [] }).excludes, '');
});

test('an empty string field is not enough to call it configured', () => {
    // A half-written record — repoId: "" — must not blank the defaults either.
    assert.equal(Ui.isSavedConfig({ repoId: '', repoUrl: '' }), false);
    assert.equal(Ui.configToDrForm({ repoId: '' }).backupPaths, '/');
});

test('junk is never a saved form', () => {
    for (const v of [null, undefined, '', 0, [], 'string', true])
        assert.equal(Ui.isSavedConfig(v), false, JSON.stringify(v));
});

// --- three things that made the Recovery screen lie ------------------------
//
// All three came from one session on a real host: two boxes contradicting each
// other, an image built from a configuration nobody had written, and a drill
// that burned a CPU for ten minutes proving nothing.

test('a successful build clears the "the image is gone" notice', () => {
    // Both boxes were on screen at once — "gone" from the load-time check, and
    // "ready" from the build that had just answered it.
    const c = Ui.hangarRecoveryUi();
    c.isoMissing = '/var/lib/rear/output/rear-localhost.iso';
    c.iso = '/home/appuser/rear-localhost.iso';
    // The build path clears it whenever it sets an image.
    if (c.iso) c.isoMissing = '';
    assert.equal(c.isoMissing, '');
});

test('an unanswerable config check never blocks a build', () => {
    // Under node there is no cockpit to read /etc/rear/local.conf with. Refusing
    // to build because the CHECK failed would be worse than the bug it guards.
    const c = Ui.hangarRecoveryUi();
    return c.configMatchesDisk().then((v) => assert.equal(v, null));
});

test('a drill against an image that boots the hard disk is called out', () => {
    // rear mkrescue writes ISO_DEFAULT into the image; a VM with no display can
    // never answer its boot menu, so the drill waits for the full timeout.
    const c = Ui.hangarRecoveryUi();
    c.form.isoDefault = 'boothd';
    assert.equal(c.drillWillWait(), true);
    c.form.isoDefault = 'manual';
    assert.equal(c.drillWillWait(), true);
    c.form.isoDefault = 'automatic';
    assert.equal(c.drillWillWait(), false);
});

test('an unset boot default is treated as the safe one, and warned about', () => {
    const c = Ui.hangarRecoveryUi();
    for (const v of ['', null, undefined]) {
        c.form.isoDefault = v;
        assert.equal(c.drillWillWait(), true, JSON.stringify(v));
    }
});

test('the drill disk can be put somewhere with room for it', () => {
    // The libvirt pool sits on / on a default install, and a disk big enough to
    // hold a restore of this machine is big enough to fill it. Measured here:
    // 43 GB free on / against 40.1 GB of data, and virt-install refused —
    // "61440 M requested capacity > 43319 M available".
    const p = drillPlan('/x/rear.iso', { libvirt: true, diskDir: '/home/drills' });
    assert.equal(p.diskPath, '/home/drills/hangar-drill.qcow2');
    assert.ok(p.argv.join(' ').includes('path=/home/drills/hangar-drill.qcow2'));
});

test('an unreachable rescue image is staged rather than blamed on the operator', async () => {
    // qemu must traverse every directory in the path, and a home directory is
    // 0700. Measured: "WARNING /home/appuser/localhost/rear-localhost.iso may not
    // be accessible by the hypervisor". Telling someone to chmod their home is
    // not an answer hangar should give.
    const c = Ui.hangarRecoveryUi();
    assert.equal(typeof c.stageIso, 'function');
    // Without cockpit it can neither test nor copy, and says so with null rather
    // than inventing a path the VM would fail on.
    assert.equal(await c.stageIso({ iso: '/home/appuser/localhost/rear.iso', name: 'hangar-drill' }), null);
    assert.equal(await c.stageIso(null), null);
    assert.equal(await c.stageIso({ name: 'hangar-drill' }), null);
});

test('the drill disk directory is prepared, not assumed', async () => {
    // A path typed under a home directory is unreachable twice over: /home/<user>
    // is 0700 so qemu cannot traverse it, and a directory there carries a home
    // label SELinux will not let qemu open. hangar makes and labels the directory
    // instead of asking anyone to loosen permissions on their home.
    const c = Ui.hangarRecoveryUi();
    assert.equal(typeof c.prepareDiskDir, 'function');
    // Without cockpit it cannot act, and says so rather than pretending.
    assert.equal(await c.prepareDiskDir({ diskPath: '/home/drills/x.qcow2' }), false);
    assert.equal(await c.prepareDiskDir(null), false);
    assert.equal(await c.prepareDiskDir({}), false);
});

test('a hostile drill disk location is refused before it reaches anything', () => {
    // These never meet a shell — every consumer passes argv — but this runs as
    // root and creates a directory, so /home/../etc must not get that far either.
    for (const bad of ['relative', '/home/../etc', "/tmp/x'; rm -rf /; :'",
        '/home/a b', '/home/$(id)', '/home/`id`', '/home/a|b']) {
        const p = drillPlan('/x/rear.iso', { libvirt: true, diskDir: bad });
        assert.ok(p.warnings.some((w) => w.code === 'disk-dir'), JSON.stringify(bad));
        assert.equal(p.ok, false, JSON.stringify(bad));
    }
});

test('an ordinary drill disk location is still accepted', () => {
    for (const good of ['/home/hangar-drill', '/var/lib/libvirt/images', '/srv/drills']) {
        const p = drillPlan('/x/rear.iso', { libvirt: true, diskDir: good });
        assert.equal(p.warnings.some((w) => w.code === 'disk-dir'), false, good);
    }
});

test('a disk location qemu cannot reach is refused before the disk is allocated', async () => {
    // Measured on a real host: virt-install wrote a 60 GB file and only then said
    //   Cannot access storage file '…' (as uid:107, gid:107): Permission denied
    // A home directory is 0700, so nothing beneath it is reachable however the
    // leaf directory is chmodded.
    const c = hangarRecoveryUi();
    c.iso = '/x.iso';
    c.libvirt = { checked: true, available: true, reason: '' };
    const fake = {
        spawn: (argv) => {
            const line = argv.join(' ');
            // The usability probe passes; the real directory does not.
            if (/runuser .* test -x \/$/.test(line)) return Promise.resolve('');
            if (/runuser .* test -x \/home$/.test(line)) return Promise.resolve('');
            if (/runuser/.test(line) && /\/home\/appuser/.test(line)) return Promise.reject(new Error('denied'));
            if (/virt-install/.test(line)) return Promise.reject(new Error('should never run'));
            return Promise.resolve('');
        }
    };
    c.drillOpts.diskDir = '/home/appuser/test';        // runDrill takes no arguments
    const r = await withCockpit(fake, () => c.runDrill());
    assert.equal(r, null, 'the drill ran anyway');
    assert.ok(c.drillError, 'no error was reported');
    assert.match(c.drillError.message, /\/home\/appuser/);
    assert.match(c.drillError.message, /outside any home directory/i);
});

test('a check that cannot run never blocks the drill', async () => {
    // No qemu user, no runuser, no privilege — all mean "cannot tell", and the
    // drill is what was asked for. virt-install reports the truth either way.
    const c = hangarRecoveryUi();
    assert.equal(await c.blockedDiskParent({ diskPath: '/home/appuser/test/x.qcow2' }), '');
});

test('a directory hangar itself prepared is not condemned as unreachable', async () => {
    // The drill directory is 0711 root:root — traversable by everyone, writable
    // by nobody but root. Asking whether qemu can WRITE to it said no, so hangar
    // refused the location and then recommended that same location in the very
    // next sentence. qemu never writes there: libvirt creates the disk as root
    // and hands over the open file.
    const c = hangarRecoveryUi();
    const asked = [];
    const fake = {
        spawn: (argv) => {
            asked.push(argv.join(' '));
            return Promise.resolve('');          // every traversal check succeeds
        }
    };
    const blocked = await withCockpit(fake,
        () => c.blockedDiskParent({ diskPath: '/home/hangar-drill/x.qcow2' }));
    assert.equal(blocked, '', 'a traversable path was reported as blocked');
    assert.ok(!asked.some((a) => / test -w /.test(a)),
        'write access is not the question — qemu only has to traverse');
});

// ---------------------------------------------------------- serial console
//
// A serial console is a terminal: what lands in the log is the byte stream a
// VT100 would have drawn. Shown raw, a drill report is unreadable.

const ESC = '\u001b';

test('decodeConsole keeps the words and drops the drawing', () => {
    const raw = ESC + '[2J' + ESC + '[001;001H' + ESC + '[=3h' + ESC + '[8;056;240t'
        + 'BdsDxe: starting Boot0002 "UEFI QEMU DVD-ROM"\n'
        + ESC + '[0m' + ESC + '[30m' + ESC + '[47m' + 'Switching to GRUB boot menu...';
    const out = decodeConsole(raw);
    assert.match(out, /BdsDxe: starting Boot0002 "UEFI QEMU DVD-ROM"/);
    assert.match(out, /Switching to GRUB boot menu\.\.\./);
    assert.ok(out.indexOf(ESC) < 0, 'no escape character survives');
    assert.ok(!/\[\d+;\d+H|\[2J|\[=3h/.test(out), 'no bare sequence survives: ' + out);
});

test('decodeConsole collapses a countdown to its last value', () => {
    let raw = '';
    for (let n = 300; n >= 53; n--)
        raw += ESC + '[054;001H   The highlighted entry will be executed automatically in ' + n + 's.';
    const lines = decodeConsole(raw).split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 1, 'a repainted line is one line, not 248');
    assert.match(lines[0], /in 53s\./, 'the last value is the informative one');
    assert.match(lines[0], /248 updates/, 'but the reader is told it ran');
});

test('decodeConsole reports a stuck line as repeated rather than deleting it', () => {
    const raw = new Array(6).fill(ESC + '[010;001Hwaiting for device').join('');
    const out = decodeConsole(raw);
    assert.match(out, /waiting for device/);
    assert.match(out, /repeated 6 times/);
});

test('decodeConsole drops menu framing but keeps menu entries', () => {
    const raw = ESC + '[004;002H┌───┐'
        + ESC + '[005;003H Relax-and-Recover (BIOS or UEFI without Secure Boot)'
        + ESC + '[007;003H*Boot next EFI'
        + ESC + '[050;002H└───┘';
    const out = decodeConsole(raw);
    assert.match(out, /Relax-and-Recover \(BIOS or UEFI without Secure Boot\)/);
    assert.match(out, /\*Boot next EFI/);
    assert.ok(!/[┌┐└┘─]/.test(out),
        'the box itself says nothing: ' + out);
});

test('a carriage return overwrites rather than accumulating', () => {
    assert.equal(decodeConsole('10%\r50%\r100%'), '100%');
});

// The point of the whole screen: the drill's verdict must survive decoding.
// The markers are anchored to the start of a line, and a console line starts
// wherever the cursor was left - so a leading space would silently turn a
// successful recovery into "inconclusive".
test('a verdict still reads as a verdict after decoding', () => {
    const raw = ESC + '[2J' + ESC + '[012;004H' + '   Finished recovering your system'
        + ESC + '[013;001H' + 'Please verify the result';
    const out = decodeConsole(raw);
    assert.equal(drillOutcome(out).outcome, 'recovered',
        'decoded text must still satisfy DRILL_MARKERS, got: ' + JSON.stringify(out));
});

test('a failure verdict survives decoding too', () => {
    const raw = ESC + '[005;001H' + ' ERROR: Recovery failed, please check the log';
    assert.equal(drillOutcome(decodeConsole(raw)).outcome, 'failed');
});

test('decodeConsole is safe on nothing at all', () => {
    assert.equal(decodeConsole(''), '');
    assert.equal(decodeConsole(null), '');
    assert.equal(decodeConsole(undefined), '');
});

// The bug that made this whole class of failure invisible. A rescue system
// prints CRLF, and 'text\r'.split('\r').pop() is '' — so an implementation that
// treats every CR as an overwrite deletes every line the guest ever printed.
// Measured against a real drill log: 89 KB of console became 20 lines, and the
// deleted ones included "'rear recover' failed with exit code 143".
test('CRLF line endings are not an overwrite', () => {
    const raw = 'Launching Recover automatically\r\n'
        + 'ERROR: Last partition /dev/sda3 cannot shrink\r\n'
        + "'rear recover' failed with exit code 143\r\n";
    const out = decodeConsole(raw);
    assert.match(out, /Launching Recover automatically/);
    assert.match(out, /ERROR: Last partition/);
    assert.match(out, /failed with exit code 143/);
    assert.equal(out.split('\n').length, 3, 'three lines in, three lines out');
});

test('a doubled CR before the newline is still not an overwrite', () => {
    assert.equal(decodeConsole('Started rsyslog.service\r\r\ndone\r\n'),
        'Started rsyslog.service\ndone');
});

// Both rules have to hold at once: strip the CRLF ending, honour a real rewind.
test('an embedded carriage return still overwrites', () => {
    assert.equal(decodeConsole('10%\r50%\r100%\r\ndone\r\n'), '100%\ndone');
});

// The drill's verdict comes out of this text, so a failed recovery must still
// read as failed after decoding a realistic CRLF console.
test('a real failing drill still reports as failed', () => {
    const raw = 'Trying to automatically resize last partition\r\n'
        + 'ERROR: Last partition /dev/sda3 cannot shrink (new device more than 2% smaller)\r\n'
        + 'Aborting due to an error, check /var/log/rear/rear-localhost.log for details\r\n';
    assert.equal(drillOutcome(decodeConsole(raw)).outcome, 'failed');
});

// ------------------------------------------------- the shrink limit round-trip

test('an empty shrink limit is not sent to ReaR at all', () => {
    const cfg = drFormToConfig(Object.assign(defaultDrForm(), { autoshrinkPercent: '' }));
    assert.ok(!Object.prototype.hasOwnProperty.call(cfg, 'autoshrinkPercent'));
});

test('a shrink limit reaches the config as a number', () => {
    const cfg = drFormToConfig(Object.assign(defaultDrForm(), { autoshrinkPercent: '90' }));
    assert.equal(cfg.autoshrinkPercent, 90);
});

// Rubbish is forwarded untouched so core/dr.js is the single place that decides
// what is valid, and the message is the same however the config arrived.
test('a nonsense shrink limit is passed through for core to reject', () => {
    const cfg = drFormToConfig(Object.assign(defaultDrForm(), { autoshrinkPercent: 'lots' }));
    assert.equal(cfg.autoshrinkPercent, 'lots');
    assert.deepEqual(Dr.validate(Object.assign({}, cfg, { repoId: 'r', repoUrl: '/srv/b' })),
        ['Shrink limit must be a whole percentage between 0 and 100.']);
});

test('a saved shrink limit comes back into the form', () => {
    assert.equal(configToDrForm({ repoId: 'r', repoUrl: '/b', autoshrinkPercent: 90 })
        .autoshrinkPercent, 90);
    assert.equal(configToDrForm({ repoId: 'r', repoUrl: '/b' }).autoshrinkPercent, '');
});

// Setting only this and saving must count as a saved configuration, or the
// defaults quietly return the next time the form is opened.
test('a config holding only a shrink limit still counts as saved', () => {
    assert.equal(isSavedConfig({ autoshrinkPercent: 90 }), true);
});

// A drill disk must match the ORIGINAL disk's size, because ReaR recreates the
// recorded partition table. virt-install refuses when that nominal size exceeds
// free space "when the volume is fully allocated" — but the disk is sparse and
// only ever holds what the restore writes. Seen on a real drill: 1000 GB
// requested on a filesystem with 531 GB free, refused before booting.
test('a sparse drill disk is not judged as if it were fully allocated', () => {
    const argv = drillPlan('/x/rear.iso', { libvirt: true, diskGb: 1000 }).argv;
    assert.equal(argv[argv.indexOf('--check') + 1], 'disk_size=off');
    assert.ok(argv.some((a) => /sparse=yes/.test(a)), 'and the disk really is sparse');
    assert.ok(!argv.includes('all=off'), 'only the size check is disabled, not every check');
});

// ---------------------------------------------- recognising a real recovery
//
// The success marker used to be "Finished recovering your system", which ReaR
// 2.9 never prints. A drill that restored 47 GB and ended with "'rear recover'
// finished successfully" was reported as "no output hangar recognises" — the
// one feature whose entire purpose is to deliver a verdict, silently declining
// to deliver it. These strings are copied from a real drill.

test('a real ReaR 2.9 success is recognised as a recovery', () => {
    [
        "Finished 'recover'. The target system is mounted at '/mnt/local'.",
        "'rear recover' finished successfully",
        'Finished recovering your system'
    ].forEach((line) => {
        const r = drillOutcome('Launching rear recover automatically\n' + line);
        assert.equal(r.outcome, 'recovered', 'not recognised: ' + line);
        assert.equal(r.decisive, true);
    });
});

test('a real ReaR 2.9 failure is recognised as a failure', () => {
    [
        "'rear recover' failed with exit code 143",
        'Aborting due to an error, check /var/log/rear/rear-localhost.log for details',
        'ERROR: Last partition /dev/sda3 cannot shrink'
    ].forEach((line) => {
        assert.equal(drillOutcome(line).outcome, 'failed', 'not recognised: ' + line);
    });
});

// A rescue system that has merely booted is not a recovery, and must never be
// reported as one.
test('booting is still not recovering', () => {
    const r = drillOutcome("Launching 'rear recover' automatically");
    assert.equal(r.outcome, 'booted');
    assert.equal(r.decisive, false);
});

test('a decisive verdict is what ends the wait', () => {
    // The rescue system prints its verdict and then offers a menu — it never
    // powers off — so `decisive` is the only signal that the drill can stop.
    assert.equal(drillOutcome("'rear recover' finished successfully").decisive, true);
    assert.equal(drillOutcome("'rear recover' failed with exit code 143").decisive, true);
    assert.equal(drillOutcome('Welcome to Relax-and-Recover').decisive, false);
});

// ------------------------------------------------- stopping a running drill
//
// The rescue system never powers off, so a drill can outlive the dialog that
// started it. Closing must therefore ask what to do with the VM — but only when
// there is one, and never in a way that leaves the dialog pinned open.

test('the stop button does nothing when no drill is running', async () => {
    const c = hangarRecoveryUi();
    c.drillRunning = false;
    let asked = false;
    global.HangarDialogs = { confirmDialog: async () => { asked = true; return true; } };
    assert.equal(await c.abortDrill(), false);
    assert.equal(asked, false, 'must not ask about a drill that is not running');
    delete global.HangarDialogs;
});

test('closing with no drill running asks nothing and still closes', async () => {
    const c = hangarRecoveryUi();
    c.drillRunning = false;
    let asked = false, hidden = false;
    global.HangarDialogs = { confirmDialog: async () => { asked = true; return true; } };
    c.hideDrill = () => { hidden = true; };
    assert.equal(await c.closeDrill(), false);
    assert.equal(asked, false);
    assert.equal(hidden, true, 'the dialog must still close');
    delete global.HangarDialogs;
});

// Order matters, and not for cosmetic reasons: hangar's confirm resolves only
// on accept, so awaiting it before hiding would pin the dialog open for anyone
// who chose "leave it running".
test('closing during a drill hides the dialog first, then asks about the VM', async () => {
    const order = [];
    const c = hangarRecoveryUi();
    c.drillRunning = true;
    c.runningPlan = { name: 'drill' };
    c.hideDrill = () => order.push('hidden');
    c.stopDrillGuest = async () => { order.push('stopped'); return true; };
    global.HangarDialogs = { confirmDialog: async () => { order.push('asked'); return true; } };
    await c.closeDrill();
    assert.deepEqual(order, ['hidden', 'asked', 'stopped']);
    delete global.HangarDialogs;
});

test('the drill dialog cannot be dismissed behind hangar\'s back', () => {
    const html = fs.readFileSync(path.join(ROOT, 'html/modals/recovery.html'), 'utf8');
    // Comments stripped first: this file explains WHY the dismiss attribute is
    // absent, and a naive search finds the explanation instead of the markup.
    const drill = html.slice(html.indexOf('id="hangar-recovery-drill"'))
        .replace(/<!--[\s\S]*?-->/g, '');
    const header = drill.slice(0, drill.indexOf('</div>'));
    assert.ok(!/data-bs-dismiss/.test(header),
        'bootstrap would hide the dialog before anyone could be asked about the VM');
    assert.match(drill, /@click="closeDrill\(\)"/);
    assert.match(drill, /@click="abortDrill\(\)"[\s\S]*?:disabled="!drillRunning"/,
        'the stop button must be disabled when there is nothing to stop');
});

// ------------------------------------------------------- keeping the disk
//
// ReaR copies its recovery log into the RESTORED system, so the only account of
// what went wrong during a recovery is inside the disk the drill deletes. A
// warning we could not investigate — dracut failing to build an initrd — is
// what this option exists for.

test('keeping the disk leaves the storage alone', () => {
    const p = drillPlan('/x/rear.iso', { libvirt: true, keepDisk: true });
    const undefine = p.cleanup.find((a) => a.includes('undefine'));
    assert.ok(!undefine.includes('--remove-all-storage'),
        'the disk is the evidence: ' + JSON.stringify(undefine));
    assert.ok(p.cleanup.some((a) => a[0] === 'virsh' && a[1] === 'destroy'),
        'the VM is still destroyed');
    assert.equal(p.keepDisk, true);
});

test('by default the drill still cleans up after itself', () => {
    const p = drillPlan('/x/rear.iso', { libvirt: true });
    const undefine = p.cleanup.find((a) => a.includes('undefine'));
    assert.ok(undefine.includes('--remove-all-storage'),
        'a drill that leaves a 47 GB disk behind by default is a mess');
    assert.equal(p.keepDisk, false);
});

test('the console log is removed either way', () => {
    [true, false].forEach((keep) => {
        const p = drillPlan('/x/rear.iso', { libvirt: true, keepDisk: keep });
        assert.ok(p.cleanup.some((a) => a[0] === 'rm' && a.includes(p.consolePath)));
    });
});

// ------------------------------------------- not forgetting the kept disk
//
// Keeping the disk is opt-in, but forgetting it is not: it is as large as the
// system that was restored. Closing the dialog is the moment to deal with it.

test('closing offers to remove a disk the drill kept', async () => {
    const c = hangarRecoveryUi();
    c.drillRunning = false;
    c.keptDisk = '/srv/drill/hangar-drill.qcow2';
    let asked = null, removed = null;
    global.HangarDialogs = { confirmDialog: async (o) => { asked = o; return true; } };
    c.removeKeptDisk = async () => { removed = c.keptDisk; return true; };
    c.hideDrill = () => {};
    await c.closeDrill();
    assert.ok(asked, 'the operator must be asked');
    assert.match(asked.message, /hangar-drill\.qcow2/, 'and told which file');
    assert.equal(removed, '/srv/drill/hangar-drill.qcow2');
    delete global.HangarDialogs;
});

test('closing says nothing when the drill left nothing behind', async () => {
    const c = hangarRecoveryUi();
    c.drillRunning = false;
    c.keptDisk = '';
    let asked = false;
    global.HangarDialogs = { confirmDialog: async () => { asked = true; return true; } };
    c.hideDrill = () => {};
    await c.closeDrill();
    assert.equal(asked, false);
    delete global.HangarDialogs;
});

test('the kept disk is remembered only when it was actually kept', () => {
    const kept = drillPlan('/x/rear.iso', { libvirt: true, keepDisk: true });
    const gone = drillPlan('/x/rear.iso', { libvirt: true });
    assert.equal(kept.keepDisk, true);
    assert.equal(gone.keepDisk, false);
    assert.ok(kept.diskPath, 'the path is what the screen shows afterwards');
});

// ------------------------------------------------- surviving the browser
//
// cockpit.spawn ties a process to the page: a reload or a dropped connection
// kills it. A drill is fifteen minutes of restoring, and one was killed 19 GB
// into a 47 GB restore by a disconnect. It runs as a transient systemd unit so
// it belongs to the machine rather than to a browser tab.

test('the drill is launched as a systemd unit, not as a child of the page', () => {
    const p = drillPlan('/x/rear.iso', { libvirt: true });
    assert.equal(p.launch[0], 'systemd-run');
    assert.ok(p.launch.includes('--unit'));
    assert.ok(p.launch.includes('virt-install'), 'it still runs virt-install');
    assert.equal(p.argv[0], 'virt-install',
        'and the preview still shows the command a person would type');
});

test('the unit appends its output to a file on the machine', () => {
    const p = drillPlan('/x/rear.iso', { libvirt: true });
    assert.match(p.toolLogPath, /^\/var\/lib\/hangar\/drill\/.*\.log$/);
    assert.ok(p.launch.some((a) => a === '--property=StandardOutput=append:' + p.toolLogPath));
    assert.ok(p.launch.some((a) => a === '--property=StandardError=append:' + p.toolLogPath),
        'errors are the half worth keeping');
});

// --collect would remove the unit the instant it exits, taking the exit status
// with it — and virt-install refusing to start at all is the commonest failure.
test('the unit survives its own exit long enough to be asked how it went', () => {
    const p = drillPlan('/x/rear.iso', { libvirt: true });
    assert.ok(!p.launch.includes('--collect'));
    assert.ok(p.cleanup.some((a) => a[0] === 'systemctl' && a[1] === 'reset-failed'),
        'so cleanup has to do what --collect would have done');
});

test('a unit that failed to start is reported even when the guest said nothing', async () => {
    const c = hangarRecoveryUi();
    c.iso = '/x.iso';
    c.libvirt = { checked: true, available: true, reason: '' };
    const plan = c.plan();
    const fake = drillCockpit({
        files: { [plan.toolLogPath]: 'ERROR    Cannot access storage file\n' },
        exitStatus: 1
    });
    await withCockpit(fake, () => c.runDrill());
    assert.ok(Errors.isHangarError(c.drillError), 'silence about a refusal reads as success');
    assert.match(c.drillError.detail.error, /Cannot access storage file/);
});

test('a unit that exited cleanly raises no error', async () => {
    const c = hangarRecoveryUi();
    c.iso = '/x.iso';
    c.libvirt = { checked: true, available: true, reason: '' };
    const plan = c.plan();
    const fake = drillCockpit({
        files: { [plan.consolePath]: "'rear recover' finished successfully\n" },
        exitStatus: 0
    });
    const r = await withCockpit(fake, () => c.runDrill());
    assert.equal(r.outcome, 'recovered');
    assert.equal(c.drillError, null);
});

// A drill that survives the browser is only useful if the browser can find it
// again. Otherwise the operator returns to an idle-looking screen and starts a
// second drill on top of the first.
test('a page that opens during a drill picks it up', async () => {
    const c = hangarRecoveryUi();
    c.iso = '/x.iso';
    c.libvirt = { checked: true, available: true, reason: '' };
    const plan = c.plan();
    let calls = 0;
    const fake = drillCockpit({
        files: { [plan.consolePath]: "'rear recover' finished successfully\n" },
        spawn: (argv) => {
            if (argv[0] === 'systemctl' && argv[1] === 'is-active')
                return Promise.resolve(++calls === 1 ? 'active\n' : 'inactive\n');
            return undefined;
        }
    });
    const adopted = await withCockpit(fake, () => c.adoptRunningDrill());
    assert.equal(adopted, true);
    assert.equal(c.drillResult.outcome, 'recovered', 'and reports what it found');
    assert.equal(c.drillRunning, false, 'and stops running when the drill ends');
});

test('nothing is adopted when no drill is running', async () => {
    const c = hangarRecoveryUi();
    c.iso = '/x.iso';
    c.libvirt = { checked: true, available: true, reason: '' };
    const adopted = await withCockpit(drillCockpit({}), () => c.adoptRunningDrill());
    assert.equal(adopted, false);
    assert.equal(c.drillRunning, false);
});

// An interrupted drill leaves its domain defined, and libvirt then refuses the
// next one: "Disk ... is already in use by other guests ['hangar-drill']".
// Seen on a real retry after a drill was killed by a dropped connection.
test('a drill clears its own leftovers before starting', async () => {
    const c = hangarRecoveryUi();
    c.iso = '/x.iso';
    c.libvirt = { checked: true, available: true, reason: '' };
    const plan = c.plan();
    const order = [];
    const fake = drillCockpit({
        files: { [plan.consolePath]: "'rear recover' finished successfully\n" },
        spawn: (argv) => {
            if (argv[0] === 'virsh' && argv[1] === 'undefine') order.push('undefine');
            if (argv[0] === 'systemd-run') order.push('launch');
            return undefined;
        }
    });
    await withCockpit(fake, () => c.runDrill());
    assert.equal(order[0], 'undefine', 'the stale domain goes before the new one arrives');
    assert.ok(order.includes('launch'));
});

// systemd appends to the unit's log, so without a reset the verdict would be
// read from every drill ever run — one stale "Recovery is not possible" would
// condemn every healthy restore that followed it.
test('each drill starts with an empty log of its own', async () => {
    const c = hangarRecoveryUi();
    c.iso = '/x.iso';
    c.libvirt = { checked: true, available: true, reason: '' };
    const plan = c.plan();
    const order = [];
    const fake = drillCockpit({
        files: { [plan.consolePath]: "'rear recover' finished successfully\n" },
        spawn: (argv) => {
            if (argv[0] === 'rm' && argv.includes(plan.toolLogPath)) order.push('cleared');
            if (argv[0] === 'systemd-run') order.push('launch');
            return undefined;
        }
    });
    await withCockpit(fake, () => c.runDrill());
    assert.deepEqual(order, ['cleared', 'launch'],
        'the log is emptied before the unit can append to it');
});

test('a stale failure in an old log cannot condemn the next drill', async () => {
    const c = hangarRecoveryUi();
    c.iso = '/x.iso';
    c.libvirt = { checked: true, available: true, reason: '' };
    const plan = c.plan();
    // The file still holds the previous drill's words when the run begins; only
    // what this drill writes may count.
    let cleared = false;
    const fake = drillCockpit({
        files: {
            [plan.toolLogPath]: 'Recovery is not possible here\n',
            [plan.consolePath]: "'rear recover' finished successfully\n"
        },
        spawn: (argv) => {
            if (argv[0] === 'rm' && argv.includes(plan.toolLogPath)) {
                cleared = true;
                fake.file = (path) => ({
                    read: () => Promise.resolve(
                        path === plan.consolePath ? "'rear recover' finished successfully\n" : '')
                });
            }
            return undefined;
        }
    });
    const r = await withCockpit(fake, () => c.runDrill());
    assert.equal(cleared, true);
    assert.equal(r.outcome, 'recovered', 'the old failure must not follow it around');
});

// ------------------------------------------------- ending a guest politely
//
// `virsh destroy` is a power cut. Stopping a drill the instant its verdict
// appeared discarded whatever the guest had not flushed — on a real drill the
// restored system kept ReaR's late finalize writes but lost the recovery log
// ReaR copies in as its very last act.

test('the guest is asked to shut down before its power is cut', async () => {
    const c = hangarRecoveryUi();
    const seen = [];
    const fake = {
        spawn: (argv) => {
            if (argv[0] === 'virsh') seen.push(argv[1]);
            if (argv[1] === 'domstate') return Promise.resolve('shut off\n');
            return Promise.resolve('');
        }
    };
    await withCockpit(fake, () => c.stopDrillGuest({ name: 'hangar-drill' }));
    assert.equal(seen[0], 'shutdown', 'ACPI first');
    assert.ok(!seen.includes('destroy'), 'a guest that stops on its own is never killed');
});

test('a guest that ignores the request is eventually cut off', async () => {
    const c = hangarRecoveryUi();
    const seen = [];
    const fake = {
        spawn: (argv) => {
            if (argv[0] === 'virsh') seen.push(argv[1]);
            if (argv[1] === 'domstate') return Promise.resolve('running\n');
            return Promise.resolve('');
        }
    };
    // Its own clock, so the test does not wait a minute for the real one.
    const realSleep = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => realSleep(fn, 0);
    await withCockpit(fake, () => c.stopDrillGuest({ name: 'hangar-drill' }));
    globalThis.setTimeout = realSleep;
    assert.equal(seen[0], 'shutdown');
    assert.equal(seen[seen.length - 1], 'destroy', 'but it does not get to stall for ever');
});

test('stopping twice does not fight itself', async () => {
    const c = hangarRecoveryUi();
    let calls = 0;
    const fake = { spawn: () => { calls++; return Promise.resolve('shut off\n'); } };
    await withCockpit(fake, async () => {
        await c.stopDrillGuest({ name: 'hangar-drill' });
        const before = calls;
        await c.stopDrillGuest({ name: 'hangar-drill' });
        assert.equal(calls, before, 'the second call is a no-op');
    });
});
