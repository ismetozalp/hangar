// Unit tests for js/features/logbook-ui.js — the Logbook screen.
//
// The screen's judgement calls are all pure functions: which rows are shown and
// how they are badged, what the selection label claims, and what a restore is
// actually going to do. Those are exercised here directly, with no DOM and no
// cockpit, which is also the invariant that makes the component loadable at all.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');

const UI = require('../../js/features/logbook-ui.js');
const Errors = require('../../js/core/errors.js');
const Restic = require('../../js/engine/restic.js');
const Config = require('../../js/core/config.js');
const Core = require('../../js/core/logbook.js');
const Secrets = require('../../js/core/secrets.js');

const ROOT = path.resolve(__dirname, '../..');
const SRC = fs.readFileSync(path.join(ROOT, 'js/features/logbook-ui.js'), 'utf8');
const RESTORE_HTML = fs.readFileSync(path.join(ROOT, 'html/modals/restore.html'), 'utf8');

const LOCAL_REPO = { id: 'nas', kind: 'local', path: '/srv/backup' };

// A component wired to a real, valid repository, so the failures under test are
// the ones being injected rather than an invalid repo id throwing first.
function attached() {
    const c = UI.hangarLogbookUi();
    c.repos = [LOCAL_REPO];
    c.repoId = 'nas';
    c.repo = LOCAL_REPO;
    return c;
}

// cockpit is a bare global in the plugin, so it is stubbed as one here. Every
// helper restores what it replaced, because a leaked stub turns a later failure
// into a mystery.
async function withCockpit(spawn, fn) {
    globalThis.cockpit = { spawn: spawn };
    try {
        return await fn();
    } finally {
        delete globalThis.cockpit;
    }
}

async function withPatched(target, patch, fn) {
    const saved = {};
    Object.keys(patch).forEach((k) => { saved[k] = target[k]; target[k] = patch[k]; });
    try {
        return await fn();
    } finally {
        Object.keys(patch).forEach((k) => { target[k] = saved[k]; });
    }
}

async function withDialogs(dialogs, fn) {
    globalThis.HangarDialogs = dialogs;
    try {
        return await fn();
    } finally {
        delete globalThis.HangarDialogs;
    }
}

// A rejection shaped like the one cockpit.spawn produces for a failed process.
function spawnFailure(exitStatus, message) {
    return () => Promise.reject({ exit_status: exitStatus, message: message || '' });
}

// --- the module loads with nothing around it ------------------------------

test('module loads with no DOM and no cockpit', () => {
    assert.equal(typeof UI.hangarLogbookUi, 'function');
    assert.equal(typeof UI.hangarRestore, 'function');
    assert.equal(typeof globalThis.document, 'undefined', 'test env must have no DOM');
});

test('the factory is the global and carries the pure helpers', () => {
    assert.equal(typeof UI.hangarLogbookUi.treeRowsFor, 'function');
    assert.equal(typeof UI.hangarLogbookUi.selectionSummary, 'function');
    assert.equal(typeof UI.hangarLogbookUi.restorePlan, 'function');
});

test('nothing in the screen is called "Time Mach" + "ine"', () => {
    // Spelled apart so this assertion cannot itself trip the smoke test.
    assert.ok(!/time\s*machine/i.test(UI.template()));
});

// --- paths ----------------------------------------------------------------

test('normalizePath collapses separators and trailing slashes', () => {
    assert.equal(UI.normalizePath('/etc//hangar/'), '/etc/hangar');
    assert.equal(UI.normalizePath('/'), '/');
    assert.equal(UI.normalizePath(''), '/');
    assert.equal(UI.normalizePath(null), '/');
});

test('joinPath does not double the root separator', () => {
    assert.equal(UI.joinPath('/', 'etc'), '/etc');
    assert.equal(UI.joinPath('/etc', 'hosts'), '/etc/hosts');
    assert.equal(UI.joinPath('/etc/', '/hosts'), '/etc/hosts');
    assert.equal(UI.joinPath('/etc', ''), '/etc');
});

test('joinPath keeps spaces and unicode in names intact', () => {
    assert.equal(UI.joinPath('/home/appuser', 'Ünlü belge.txt'), '/home/appuser/Ünlü belge.txt');
});

test('parentOf climbs one level and stops at the root', () => {
    assert.equal(UI.parentOf('/etc/hangar/config.json'), '/etc/hangar');
    assert.equal(UI.parentOf('/etc'), '/');
    assert.equal(UI.parentOf('/'), '/');
});

test('breadcrumbsFor builds a clickable trail from the snapshot root', () => {
    assert.deepEqual(UI.breadcrumbsFor('/var/log'), [
        { label: 'Snapshot root', path: '/' },
        { label: 'var', path: '/var' },
        { label: 'log', path: '/var/log' }
    ]);
    assert.deepEqual(UI.breadcrumbsFor('/'), [{ label: 'Snapshot root', path: '/' }]);
});

// --- formatting -----------------------------------------------------------

test('formatBytes uses binary units, the same as every other screen', () => {
    assert.equal(UI.formatBytes(0), '0 B');
    assert.equal(UI.formatBytes(999), '999 B');
    assert.equal(UI.formatBytes(1024), '1 KiB');
    assert.equal(UI.formatBytes(1536), '1.5 KiB');
    assert.equal(UI.formatBytes(2516582), '2.4 MiB');
    assert.equal(UI.formatBytes(3 * 1024 ** 3), '3 GiB');
});

test('formatBytes refuses to invent a size from hostile input', () => {
    assert.equal(UI.formatBytes(null), '0 B');
    assert.equal(UI.formatBytes('nonsense'), '0 B');
    assert.equal(UI.formatBytes(-5), '0 B');
    assert.equal(UI.formatBytes(Infinity), '0 B');
});

test('absoluteLabel renders UTC, the same zone the bands are built in', () => {
    assert.equal(UI.absoluteLabel('2026-08-01T10:04:00Z'), '1 Aug 2026 10:04');
    assert.equal(UI.absoluteLabel('not a date'), 'unknown');
    assert.equal(UI.absoluteLabel(null), 'unknown');
});

test('absoluteLabel accepts epoch seconds, which is what find -printf %T@ emits', () => {
    // 1767225840 == 2026-01-01T00:04:00Z
    assert.equal(UI.absoluteLabel('1767225840.0000000000'), '1 Jan 2026 00:04');
});

test('clockLabel falls back to a placeholder rather than to NaN', () => {
    assert.equal(UI.clockLabel('2026-08-01T09:07:00Z'), '09:07');
    assert.equal(UI.clockLabel(undefined), '--:--');
});

// --- the scrubber ---------------------------------------------------------

const NOW = '2026-08-01T12:00:00Z';
const SNAPS = [
    { id: 'aaaaaaaabbbb', shortId: 'aaaaaaaa', time: '2026-08-01T10:00:00Z', hostname: 'nas', paths: ['/etc'] },
    { id: 'ccccccccdddd', shortId: 'cccccccc', time: '2026-07-31T10:00:00Z', hostname: 'nas', paths: ['/etc'] },
    { id: 'eeeeeeeeffff', shortId: 'eeeeeeee', time: '2026-05-02T10:00:00Z', hostname: 'nas', paths: ['/etc'] }
];

test('timelineModel bands newest first with both labels per moment', () => {
    const bands = UI.timelineModel(SNAPS, NOW);
    assert.ok(bands.length >= 2);
    assert.equal(bands[0].moments[0].id, 'aaaaaaaabbbb');
    assert.equal(bands[0].moments[0].absolute, '1 Aug 2026 10:00');
    assert.equal(bands[0].moments[0].relative, '2 hours ago');
    assert.equal(bands[0].granularity, 'hour');
});

test('timelineModel keeps the coarse end of the scrubber coarse', () => {
    const bands = UI.timelineModel(SNAPS, NOW);
    const last = bands[bands.length - 1];
    assert.equal(last.granularity, 'month');
    assert.equal(last.moments[0].id, 'eeeeeeeeffff');
});

test('timelineModel tolerates an empty and a null snapshot list', () => {
    assert.deepEqual(UI.timelineModel([], NOW), []);
    assert.deepEqual(UI.timelineModel(null, NOW), []);
});

test('momentFor derives a short id when restic did not send one', () => {
    const m = UI.momentFor({ id: '0123456789abcdef', time: NOW }, NOW);
    assert.equal(m.shortId, '01234567');
    assert.equal(m.relative, 'just now');
});

// --- reading the tree from a mount ---------------------------------------

test('listDirArgv asks find for our own field order, not ls columns', () => {
    const argv = UI.listDirArgv('/run/hangar/mnt/nas/snapshots/2026-08-01T10:00:00Z');
    assert.equal(argv[0], 'find');
    assert.ok(argv.includes('-maxdepth'));
    assert.ok(argv[argv.length - 1].includes('%y'));
});

test('listDirArgv refuses an empty directory', () => {
    assert.throws(() => UI.listDirArgv(''), (e) => e.name === 'HangarError');
});

const FIND_OUT = [
    'd\t4096\t1767225840.0\tetc',
    'f\t1234\t1767225840.0\thosts',
    'l\t11\t1767225840.0\tresolv.conf'
].join('\n') + '\n';

test('parseFindOutput maps types, sizes and paths', () => {
    const entries = UI.parseFindOutput(FIND_OUT, '/');
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map((e) => e.type), ['dir', 'file', 'link']);
    assert.equal(entries[1].size, 1234);
    assert.equal(entries[1].path, '/hosts');
});

test('parseFindOutput keeps names containing spaces and tabs', () => {
    const entries = UI.parseFindOutput('f\t10\t0\tmy report\ttab.txt\n', '/docs');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'my report\ttab.txt');
    assert.equal(entries[0].path, '/docs/my report\ttab.txt');
});

test('parseFindOutput drops noise and truncated tails instead of failing', () => {
    const entries = UI.parseFindOutput('f\t1\t0\tok\nrubbish\nf\t2\t0\n', '/');
    assert.deepEqual(entries.map((e) => e.name), ['ok']);
});

test('parseFindOutput returns nothing for empty output', () => {
    assert.deepEqual(UI.parseFindOutput('', '/'), []);
    assert.deepEqual(UI.parseFindOutput(null, '/'), []);
});

test('parseFindOutput treats an unknown find type as "other" rather than a file', () => {
    const entries = UI.parseFindOutput('s\t0\t0\tdocker.sock\n', '/run');
    assert.equal(entries[0].type, 'other');
});

// --- reading the tree without FUSE ---------------------------------------

const LS_NODES = [
    { name: 'etc', type: 'dir', path: '/etc', size: 0 },
    { name: 'hosts', type: 'file', path: '/etc/hosts', size: 220 },
    { name: 'hangar', type: 'dir', path: '/etc/hangar', size: 0 },
    { name: 'config.json', type: 'file', path: '/etc/hangar/config.json', size: 91 },
    { name: 'motd', type: 'symlink', path: '/etc/motd', size: 12 }
];

test('lsEntriesFor selects exactly one directory level out of a recursive listing', () => {
    const entries = UI.lsEntriesFor(LS_NODES, '/etc');
    assert.deepEqual(entries.map((e) => e.name).sort(), ['hangar', 'hosts', 'motd']);
});

test('lsEntriesFor maps restic symlinks to links, not files', () => {
    const motd = UI.lsEntriesFor(LS_NODES, '/etc').filter((e) => e.name === 'motd')[0];
    assert.equal(motd.type, 'link');
});

test('lsEntriesFor handles the snapshot root', () => {
    assert.deepEqual(UI.lsEntriesFor(LS_NODES, '/').map((e) => e.name), ['etc']);
});

test('lsEntriesFor ignores junk nodes', () => {
    const entries = UI.lsEntriesFor([null, 42, { path: '/etc/x', name: 'x', type: 'file' }], '/etc');
    assert.deepEqual(entries.map((e) => e.name), ['x']);
});

test('lsEntriesFor returns nothing when the tree is not an array', () => {
    assert.deepEqual(UI.lsEntriesFor(undefined, '/'), []);
});

// --- rows and badges ------------------------------------------------------

const ENTRIES = [
    { name: 'zeta.txt', type: 'file', size: 2400000, mtime: '2026-08-01T10:00:00Z', path: '/data/zeta.txt' },
    { name: 'Alpha', type: 'dir', size: 4096, mtime: '2026-08-01T10:00:00Z', path: '/data/Alpha' },
    { name: 'beta.log', type: 'file', size: 512, mtime: '2026-08-01T10:00:00Z', path: '/data/beta.log' }
];

test('treeRowsFor puts folders first, then names case-insensitively', () => {
    const rows = UI.treeRowsFor(ENTRIES, {});
    assert.deepEqual(rows.map((r) => r.name), ['Alpha', 'beta.log', 'zeta.txt']);
});

test('treeRowsFor resolves the badge class from the diff', () => {
    const badges = { '/data/zeta.txt': 'added', '/data/beta.log': 'modified' };
    const rows = UI.treeRowsFor(ENTRIES, badges);
    const byName = {};
    rows.forEach((r) => { byName[r.name] = r; });
    assert.equal(byName['zeta.txt'].badgeClass, 'hangar-badge added');
    assert.equal(byName['beta.log'].badgeClass, 'hangar-badge modified');
    assert.equal(byName.Alpha.badgeClass, '');
    assert.equal(byName.Alpha.badge, null);
});

test('treeRowsFor reads badges out of a null-prototype map', () => {
    // diffToBadges returns Object.create(null); a plain hasOwnProperty call on it
    // would throw, so the lookup has to borrow one.
    const badges = Object.create(null);
    badges['/data/zeta.txt'] = 'removed';
    const rows = UI.treeRowsFor(ENTRIES, badges);
    assert.equal(rows.filter((r) => r.name === 'zeta.txt')[0].badge, 'removed');
});

test('treeRowsFor is not fooled by a path named __proto__', () => {
    const rows = UI.treeRowsFor([{ name: '__proto__', type: 'file', path: '/__proto__' }], {});
    assert.equal(rows.length, 1);
    assert.equal(rows[0].badge, null);
});

test('treeRowsFor ignores an unrecognised badge value', () => {
    const rows = UI.treeRowsFor(ENTRIES, { '/data/Alpha': 'exploded' });
    assert.equal(rows[0].badgeClass, '');
});

test('treeRowsFor hides a directory size, which means nothing to a restore', () => {
    const rows = UI.treeRowsFor(ENTRIES, {});
    assert.equal(rows[0].sizeLabel, '');
    assert.equal(rows[2].sizeLabel, '2.3 MiB');
});

test('treeRowsFor drops entries with no name — an unclickable row is worse than none', () => {
    const rows = UI.treeRowsFor([{ type: 'file', path: '/x' }, null, 'nope', ENTRIES[1]], {});
    assert.deepEqual(rows.map((r) => r.name), ['Alpha']);
});

test('treeRowsFor synthesises a path when the reader did not supply one', () => {
    const rows = UI.treeRowsFor([{ name: 'orphan', type: 'file' }], {});
    assert.equal(rows[0].path, '/orphan');
    assert.equal(rows[0].key, '/orphan');
});

test('treeRowsFor normalises the path so badges keyed the other way still match', () => {
    const rows = UI.treeRowsFor([{ name: 'hosts', type: 'file', path: '/etc//hosts/' }],
        { '/etc/hosts': 'modified' });
    assert.equal(rows[0].path, '/etc/hosts');
    assert.equal(rows[0].badge, 'modified');
});

test('treeRowsFor copes with an empty list and a non-list', () => {
    assert.deepEqual(UI.treeRowsFor([], {}), []);
    assert.deepEqual(UI.treeRowsFor(null, null), []);
});

test('badgeClassFor only emits the three classes the stylesheet defines', () => {
    assert.equal(UI.badgeClassFor('added'), 'hangar-badge added');
    assert.equal(UI.badgeClassFor('removed'), 'hangar-badge removed');
    assert.equal(UI.badgeClassFor('deleted'), '');
    assert.equal(UI.badgeClassFor(null), '');
});

// --- the selection label --------------------------------------------------

function row(name, isDir, size) {
    return { name: name, path: '/data/' + name, isDir: isDir, type: isDir ? 'dir' : 'file', size: size };
}

test('selectionSummary names counts and total size', () => {
    const sel = [row('a', false, 2000000), row('b', false, 400000), row('c', false, 0), row('d', true, 4096)];
    assert.equal(UI.selectionSummary(sel), '3 files, 1 folder (2.3 MiB)');
});

test('selectionSummary is singular for one of each', () => {
    assert.equal(UI.selectionSummary([row('a', false, 512)]), '1 file (512 B)');
    assert.equal(UI.selectionSummary([row('a', true, 0)]), '1 folder');
});

test('selectionSummary states plainly when nothing is picked', () => {
    assert.equal(UI.selectionSummary([]), 'Nothing selected');
    assert.equal(UI.selectionSummary(null), 'Nothing selected');
});

test('selectionSummary omits a size it cannot vouch for', () => {
    // Folder contents are not walked, so a folder-only selection has no size.
    assert.equal(UI.selectionSummary([row('a', true, 4096), row('b', true, 4096)]), '2 folders');
});

test('selectionSummary ignores a nonsense size rather than printing NaN', () => {
    assert.equal(UI.selectionSummary([row('a', false, 'big')]), '1 file');
});

test('selectionSummary accepts rows typed by "type" alone', () => {
    assert.equal(UI.selectionSummary([{ type: 'dir' }, { type: 'file', size: 1000 }]),
        '1 file, 1 folder (1000 B)');
});

// --- the restore plan -----------------------------------------------------

const SEL = [row('a.txt', false, 100), row('b.txt', false, 200)];

test('restorePlan defaults to the mode that cannot destroy anything', () => {
    const plan = UI.restorePlan(SEL, undefined, '/var/tmp/restore', { snapshot: 'abc' });
    assert.equal(plan.mode, 'alternate');
    assert.equal(plan.destructive, false);
    assert.deepEqual(plan.warnings, []);
    assert.equal(plan.valid, true);
});

test('restorePlan produces the descriptor the engine takes, not a command line', () => {
    const plan = UI.restorePlan(SEL, 'alternate', '/var/tmp/restore', { snapshot: 'abc' });
    assert.equal(plan.op, 'restore');
    assert.equal(plan.snapshot, 'abc');
    assert.equal(plan.target, '/var/tmp/restore');
    assert.deepEqual(plan.include, ['/data/a.txt', '/data/b.txt']);
});

test('restorePlan in original mode always warns and is always destructive', () => {
    const plan = UI.restorePlan(SEL, 'original', '/ignored', { snapshot: 'abc' });
    assert.equal(plan.destructive, true);
    assert.equal(plan.target, '/');
    assert.ok(plan.warnings.length >= 1);
    assert.match(plan.warnings[0], /original locations/);
});

test('restorePlan warns twice when the snapshot root itself is selected', () => {
    const plan = UI.restorePlan([{ path: '/' }], 'original', '', { snapshot: 'abc' });
    assert.equal(plan.warnings.length, 2);
    assert.match(plan.warnings[1], /whole snapshot/);
});

test('restorePlan treats an alternate target of "/" as the destructive case', () => {
    const plan = UI.restorePlan(SEL, 'alternate', '/', { snapshot: 'abc' });
    assert.equal(plan.destructive, true);
    assert.equal(plan.warnings.length, 1);
    assert.equal(plan.valid, true);
});

test('restorePlan refuses an empty alternate target', () => {
    const plan = UI.restorePlan(SEL, 'alternate', '   ', { snapshot: 'abc' });
    assert.equal(plan.valid, false);
    assert.match(plan.problems[0], /Choose a directory/);
});

test('restorePlan refuses a relative alternate target', () => {
    const plan = UI.restorePlan(SEL, 'alternate', 'tmp/restore', { snapshot: 'abc' });
    assert.equal(plan.valid, false);
    assert.match(plan.problems[0], /absolute path/);
});

test('restorePlan refuses an empty selection', () => {
    const plan = UI.restorePlan([], 'alternate', '/var/tmp', { snapshot: 'abc' });
    assert.equal(plan.valid, false);
    assert.match(plan.problems[0], /Select at least one/);
});

test('restorePlan refuses a plan with no snapshot', () => {
    const plan = UI.restorePlan(SEL, 'alternate', '/var/tmp', {});
    assert.equal(plan.valid, false);
    assert.ok(plan.problems.some((p) => /moment/.test(p)));
});

test('restorePlan de-duplicates the include list', () => {
    const plan = UI.restorePlan([row('a.txt', false, 1), row('a.txt', false, 1)],
        'alternate', '/var/tmp', { snapshot: 'abc' });
    assert.deepEqual(plan.include, ['/data/a.txt']);
});

test('restorePlan accepts bare path strings as a selection', () => {
    const plan = UI.restorePlan(['/etc/hosts', '/etc//hangar/'], 'alternate', '/var/tmp',
        { snapshot: 'abc' });
    assert.deepEqual(plan.include, ['/etc/hosts', '/etc/hangar']);
});

test('restorePlan normalises the alternate target', () => {
    const plan = UI.restorePlan(SEL, 'alternate', '/var/tmp/restore//', { snapshot: 'abc' });
    assert.equal(plan.target, '/var/tmp/restore');
});

test('restorePlan throws on a mode it does not recognise', () => {
    // Silently picking a mode here would mean silently choosing whether to
    // overwrite the running system.
    assert.throws(() => UI.restorePlan(SEL, 'in-place-ish', '/tmp', { snapshot: 'a' }),
        (e) => e.name === 'HangarError' && /Unknown restore mode/.test(e.message));
});

test('restorePlan passes verify through', () => {
    const plan = UI.restorePlan(SEL, 'alternate', '/var/tmp', { snapshot: 'a', verify: true });
    assert.equal(plan.verify, true);
});

// --- errors become buttons ------------------------------------------------

test('every remediation the errors module can emit has a button label', () => {
    Object.keys(Errors.REMEDIATION).forEach((kind) => {
        const label = UI.remediationLabel(Errors.REMEDIATION[kind]);
        assert.ok(label, `no label for ${Errors.REMEDIATION[kind]}`);
    });
});

test('remediationLabel is empty for an action that does not exist', () => {
    assert.equal(UI.remediationLabel('reboot'), '');
    assert.equal(UI.remediationLabel(null), '');
});

test('errorView turns a locked repository into an Unlock action', () => {
    const view = UI.errorView(Errors.create('REPO_LOCKED', 'Repository is locked'));
    assert.equal(view.action, 'unlock');
    assert.equal(view.actionLabel, 'Unlock repository');
    assert.equal(view.fatal, true);
});

test('errorView keeps read errors non-fatal — they are a partial success', () => {
    const view = UI.errorView(Errors.create('READ_ERRORS', 'some files were unreadable'));
    assert.equal(view.fatal, false);
    assert.equal(view.action, 'list-unreadable');
});

test('errorView degrades a plain Error to a fatal unknown with no action', () => {
    const view = UI.errorView(new Error('boom'));
    assert.equal(view.kind, 'UNKNOWN');
    assert.equal(view.action, null);
    assert.equal(view.fatal, true);
    assert.equal(view.message, 'boom');
});

test('errorView passes null through', () => {
    assert.equal(UI.errorView(null), null);
});

// --- the screen component -------------------------------------------------

test('the component constructs with no DOM and no cockpit', () => {
    const c = UI.hangarLogbookUi();
    assert.equal(c.cwd, '/');
    assert.equal(c.reader, 'none');
    assert.deepEqual(c.selected, []);
    assert.deepEqual(c.rows, []);
    assert.equal(c.error, null);
});

// --- the busy indicator ---------------------------------------------------
//
// Picking a repository starts loadSnapshots, which starts loadTree, so two or
// three loads are always in flight together. A plain boolean let the first one
// to finish declare the screen idle — and with Alpine applying x-show on an
// animation frame, the resulting show/hide/show flurry could settle on "shown"
// and strand "Mounting the repository…" above a fully loaded tree.

test('nested work keeps the screen busy until the outermost finishes', () => {
    const c = UI.hangarLogbookUi();
    c.beginBusy('Reading snapshots…');
    c.beginBusy('Reading the snapshot…');
    c.endBusy();
    assert.equal(c.busy, true, 'the inner load ended and claimed the screen was idle');
    assert.equal(c.busyLabel, 'Reading the snapshot…');
    c.endBusy();
    assert.equal(c.busy, false);
});

test('the last endBusy clears the label, so nothing stale is left on screen', () => {
    const c = UI.hangarLogbookUi();
    c.beginBusy('Mounting the repository…');
    c.endBusy();
    assert.equal(c.busy, false);
    assert.equal(c.busyLabel, '');
});

test('an unpaired endBusy cannot drive the depth negative', () => {
    // A stray end would otherwise leave the counter at -1, and the next real
    // load would need two ends to clear — the indicator sticking on again.
    const c = UI.hangarLogbookUi();
    c.endBusy();
    c.endBusy();
    assert.equal(c.busyDepth, 0);
    c.beginBusy('Working…');
    assert.equal(c.busy, true);
    c.endBusy();
    assert.equal(c.busy, false);
});

test('selection toggling is idempotent per path', () => {
    const c = UI.hangarLogbookUi();
    const r = { path: '/etc/hosts', name: 'hosts', isDir: false, size: 100 };
    c.toggle(r);
    assert.equal(c.isSelected(r), true);
    c.toggle({ path: '/etc/hosts' });
    assert.equal(c.isSelected(r), false);
    c.clearIdle();
});

test('the selection label comes from the pure summary', () => {
    const c = UI.hangarLogbookUi();
    c.selected = [row('a', false, 1000), row('b', true, 0)];
    assert.equal(c.selectionLabel(), '1 file, 1 folder (1000 B)');
});

test('previousMoment finds the adjacent older snapshot the badges are relative to', () => {
    const c = UI.hangarLogbookUi();
    c.bands = UI.timelineModel(SNAPS, NOW);
    c.moment = c.bands[0].moments[0];
    assert.equal(c.previousMoment().id, 'ccccccccdddd');
});

test('previousMoment returns null for the oldest snapshot', () => {
    const c = UI.hangarLogbookUi();
    c.bands = UI.timelineModel(SNAPS, NOW);
    const flat = [];
    c.bands.forEach((b) => b.moments.forEach((m) => flat.push(m)));
    c.moment = flat[flat.length - 1];
    assert.equal(c.previousMoment(), null);
});

test('isActive compares moments by id', () => {
    const c = UI.hangarLogbookUi();
    c.moment = { id: 'x' };
    assert.equal(c.isActive({ id: 'x' }), true);
    assert.equal(c.isActive({ id: 'y' }), false);
});

test('fallback records why the slower path is in use', () => {
    const c = UI.hangarLogbookUi();
    c.fallback('fuse3 is not installed');
    assert.equal(c.reader, 'ls');
    assert.equal(c.fallbackReason, 'fuse3 is not installed');
    assert.equal(c.mountPoint, '');
});

test('leaving the screen without a mount does nothing at all', () => {
    const c = UI.hangarLogbookUi();
    c.visible = true;
    assert.equal(c.onScreenChange('repos'), undefined);
    assert.equal(c.visible, false);
    assert.equal(c.reader, 'none');
});

test('a repeated screen change is a no-op', () => {
    const c = UI.hangarLogbookUi();
    c.onScreenChange('overview');
    assert.equal(c.visible, false);
    c.onScreenChange('overview');
    assert.equal(c.visible, false);
});

test('the idle timer is armed on entry and can be cleared', () => {
    const c = UI.hangarLogbookUi();
    c.onScreenChange('logbook');
    assert.equal(c.visible, true);
    assert.notEqual(c._idle, null);
    c.clearIdle();                  // otherwise the timer outlives the test process
    assert.equal(c._idle, null);
});

test('an operation without cockpit rejects rather than throwing at call time', async () => {
    const c = UI.hangarLogbookUi();
    c.repos = [{ id: 'nas', kind: 'local', path: '/srv/backup' }];
    c.repoId = 'nas';
    c.repo = c.repos[0];
    await c.loadSnapshots();
    assert.ok(c.error, 'the failure should surface as an error view');
    assert.equal(c.busy, false);
});

// --- the restore modal component -----------------------------------------

test('the restore dialog opens on the safe mode', () => {
    const d = UI.hangarRestore();
    assert.equal(d.mode, 'alternate');
    assert.equal(d.target, UI.DEFAULT_RESTORE_TARGET);
    assert.equal(d.open, false);
});

test('the restore dialog computes its plan from its own state', () => {
    const d = UI.hangarRestore();
    d.selection = SEL;
    d.snapshot = 'abc';
    const plan = d.plan();
    assert.equal(plan.valid, true);
    assert.equal(plan.target, UI.DEFAULT_RESTORE_TARGET);
});

test('the restore dialog reports problems instead of enabling the button', () => {
    const d = UI.hangarRestore();
    d.selection = [];
    d.snapshot = 'abc';
    assert.equal(d.valid(), false);
    assert.ok(d.problems().length >= 1);
});

test('an unknown mode surfaces as a problem, never as a thrown dialog', () => {
    const d = UI.hangarRestore();
    d.selection = SEL;
    d.snapshot = 'abc';
    d.mode = 'sideways';
    assert.equal(d.valid(), false);
    assert.match(d.problems()[0], /Unknown restore mode/);
});

test('the restore dialog warns before an original-location restore', () => {
    const d = UI.hangarRestore();
    d.selection = SEL;
    d.snapshot = 'abc';
    d.mode = 'original';
    assert.ok(d.warnings().length >= 1);
    assert.equal(d.plan().destructive, true);
});

test('cancelling resolves with null and drops the resolver', () => {
    let got = 'untouched';
    const d = UI.hangarRestore();
    d._resolve = (v) => { got = v; };
    d.cancel();
    assert.equal(got, null);
    assert.equal(d._resolve, null);
    assert.equal(d.open, false);
});

test('a safe restore submits without a danger confirmation', async () => {
    let got = null;
    const d = UI.hangarRestore();
    d.selection = SEL;
    d.snapshot = 'abc';
    d.target = '/var/tmp/restore';
    d._resolve = (v) => { got = v; };
    await d.submit();
    assert.ok(got);
    assert.equal(got.mode, 'alternate');
    assert.equal(got.destructive, false);
});

test('a destructive restore is gated on the shared danger dialog', async () => {
    const asked = [];
    globalThis.HangarDialogs = {
        confirmDialog: (o) => { asked.push(o); return Promise.resolve(true); }
    };
    try {
        let got = null;
        const d = UI.hangarRestore();
        d.selection = SEL;
        d.snapshot = 'abc';
        d.mode = 'original';
        d._resolve = (v) => { got = v; };
        await d.submit();
        assert.equal(asked.length, 1);
        assert.equal(asked[0].danger, true);
        assert.ok(got && got.destructive);
    } finally {
        delete globalThis.HangarDialogs;
    }
});

test('declining the danger dialog restores nothing', async () => {
    globalThis.HangarDialogs = { confirmDialog: () => Promise.resolve(false) };
    try {
        let got = 'untouched';
        const d = UI.hangarRestore();
        d.selection = SEL;
        d.snapshot = 'abc';
        d.mode = 'original';
        d._resolve = (v) => { got = v; };
        await d.submit();
        assert.equal(got, 'untouched');
        assert.notEqual(d._resolve, null, 'the dialog stays open for a second decision');
    } finally {
        delete globalThis.HangarDialogs;
    }
});

test('an invalid plan cannot be submitted', async () => {
    let called = false;
    const d = UI.hangarRestore();
    d.selection = [];
    d._resolve = () => { called = true; };
    await d.submit();
    assert.equal(called, false);
});

// --- the screen markup ----------------------------------------------------

test('the template uses the stylesheet classes the screen was designed around', () => {
    const html = UI.template();
    ['hangar-logbook', 'hangar-tree', 'hangar-scrubber', 'hangar-band-label', 'hangar-moment']
        .forEach((cls) => assert.ok(html.includes(cls), `template is missing .${cls}`));
});

test('the template wires itself to the component factory', () => {
    assert.ok(UI.template().includes('x-data="hangarLogbookUi()"'));
});

test('the template uses real buttons and labels its icon-free controls', () => {
    const html = UI.template();
    assert.ok(html.includes('<button type="button"'));
    assert.ok(html.includes('aria-label="Snapshot moments"'));
    assert.ok(html.includes('visually-hidden'));
});

test('mount fills an empty container exactly once', () => {
    const el = { innerHTML: '', firstElementChild: null };
    assert.equal(UI.mount(el), true);
    assert.ok(el.innerHTML.includes('hangar-scrubber'));

    // A container someone else already populated is left alone: overwriting it
    // would tear down a live Alpine tree.
    const taken = { innerHTML: '<div>mine</div>', firstElementChild: {} };
    assert.equal(UI.mount(taken), false);
    assert.equal(taken.innerHTML, '<div>mine</div>');
});

test('mount with no container and no document is a no-op', () => {
    assert.equal(UI.mount(null), false);
});

// ==========================================================================
// Adversarial hardening: error states, hostile input, and the partial-success
// rule. Everything below assumes the screen is wrong until it proves it is not.
// ==========================================================================

const NUL = String.fromCharCode(0);

// --- load-time purity -----------------------------------------------------

test('the module reads no cockpit global at load time', () => {
    const touched = [];
    Object.defineProperty(globalThis, 'cockpit', {
        configurable: true,
        get() { touched.push('read'); throw new Error('cockpit was read at load time'); }
    });
    const id = require.resolve('../../js/features/logbook-ui.js');
    try {
        delete require.cache[id];
        const fresh = require('../../js/features/logbook-ui.js');
        assert.equal(typeof fresh.hangarLogbookUi, 'function');
        assert.deepEqual(touched, [], 'cockpit must not be touched while the module loads');
    } finally {
        delete globalThis.cockpit;
        delete require.cache[id];
        require('../../js/features/logbook-ui.js');
    }
});

test('a document that exists but is empty does not mount or throw at load time', () => {
    const asked = [];
    globalThis.document = {
        readyState: 'complete',
        getElementById(x) { asked.push(x); return null; }
    };
    const id = require.resolve('../../js/features/logbook-ui.js');
    try {
        delete require.cache[id];
        const fresh = require('../../js/features/logbook-ui.js');
        // It may look for its own container; it must not assume one is there.
        assert.ok(asked.every((a) => a === 'hangar-logbook'));
        assert.equal(typeof fresh.template(), 'string');
    } finally {
        delete globalThis.document;
        delete require.cache[id];
        require('../../js/features/logbook-ui.js');
    }
});

test('every pure export survives being called with nothing at all', () => {
    // Nothing here may throw a bare TypeError; the two that reject hostile input
    // do it with a typed HangarError.
    const tolerant = ['treeRowsFor', 'selectionSummary', 'timelineModel', 'momentFor',
        'lsEntriesFor', 'parseFindOutput', 'breadcrumbsFor', 'parentOf', 'joinPath',
        'normalizePath', 'formatBytes', 'absoluteLabel', 'clockLabel', 'badgeClassFor',
        'remediationLabel', 'errorView', 'includePathsFrom', 'errorAlertClass',
        'noticeAlertClass', 'unreadableFromMessages', 'unreadableFromError'];
    tolerant.forEach((name) => {
        assert.doesNotThrow(() => UI[name](undefined, undefined), `${name} threw on undefined`);
        assert.doesNotThrow(() => UI[name](null, null), `${name} threw on null`);
    });
    ['listDirArgv', 'restorePlan'].forEach((name) => {
        try {
            UI[name](null, null, null, null);
        } catch (e) {
            assert.equal(e.name, 'HangarError', `${name} threw an untyped error`);
        }
    });
});

// --- hostile input to the pure layer --------------------------------------

test('a value whose toString throws becomes empty rather than an untyped crash', () => {
    const hostile = { path: { toString() { throw new Error('nope'); } } };
    assert.doesNotThrow(() => UI.includePathsFrom([hostile]));
    assert.deepEqual(UI.includePathsFrom([hostile]), []);
    assert.equal(UI.normalizePath({ toString() { throw new Error('nope'); } }), '/');
});

test('absoluteLabel refuses a time outside the Date range instead of printing NaN', () => {
    // 1e20 is past the 8.64e15 Date ceiling; the Invalid Date it makes is truthy,
    // so an unchecked path prints 'NaN undefined NaN NaN:NaN'.
    assert.equal(UI.absoluteLabel(1e20), 'unknown');
    assert.equal(UI.absoluteLabel('99999999999999999999'), 'unknown');
    assert.equal(UI.absoluteLabel(Number.MAX_VALUE), 'unknown');
    assert.equal(UI.clockLabel(1e20), '--:--');
    assert.ok(!/NaN|undefined/.test(UI.absoluteLabel(-1e20)));
});

test('absoluteLabel copes with zero and negative epoch values', () => {
    // Before 1970 is a real mtime on restored archives, so it is rendered rather
    // than treated as missing.
    assert.equal(UI.absoluteLabel(0), '1 Jan 1970 00:00');
    assert.equal(UI.absoluteLabel(-1), '31 Dec 1969 23:59');
    assert.equal(UI.absoluteLabel(''), 'unknown');
});

test('formatBytes never reaches exponential notation, however large the claim', () => {
    [1e300, Number.MAX_VALUE, 1e21].forEach((n) => {
        const label = UI.formatBytes(n);
        assert.ok(!/e\+/.test(label), `exponential leaked: ${label}`);
        assert.ok(!/NaN/.test(label), `NaN leaked: ${label}`);
        // Clamped at MAX_SAFE_INTEGER, which lands in PiB with this table.
        assert.match(label, /PiB$/);
    });
});

test('formatBytes rejects wrong types rather than guessing', () => {
    [[], {}, true, false, '12 kB', NaN, -Infinity].forEach((v) => {
        assert.equal(UI.formatBytes(v), '0 B', `formatBytes(${String(v)})`);
    });
});

test('path helpers keep quotes, newlines and unicode instead of mangling them', () => {
    assert.equal(UI.normalizePath('/data/"quoted"/x'), '/data/"quoted"/x');
    assert.equal(UI.normalizePath("/data/it's/x"), "/data/it's/x");
    assert.equal(UI.joinPath('/data', 'a\nb'), '/data/a\nb');
    assert.equal(UI.joinPath('/data', 'Ünlü — çığ'), '/data/Ünlü — çığ');
    assert.equal(UI.parentOf('/данные/файл'), '/данные');
});

test('breadcrumbsFor survives a path made of separators alone', () => {
    assert.deepEqual(UI.breadcrumbsFor('////'), [{ label: 'Snapshot root', path: '/' }]);
    assert.deepEqual(UI.breadcrumbsFor(undefined), [{ label: 'Snapshot root', path: '/' }]);
});

test('listDirArgv refuses a directory name that would split the reply it parses back', () => {
    // The reply is parsed line by line, so a newline in the path would attribute
    // entries to a directory the breadcrumb is not pointing at.
    assert.throws(() => UI.listDirArgv('/mnt/a\nb'),
        (e) => e.name === 'HangarError' && /cannot list/.test(e.message));
    assert.throws(() => UI.listDirArgv('/mnt/a' + NUL + 'b'), (e) => e.name === 'HangarError');
    assert.throws(() => UI.listDirArgv('/mnt/a\rb'), (e) => e.name === 'HangarError');
});

test('listDirArgv passes a name with quotes and spaces straight through', () => {
    // argv, never a shell string: quoting is not this layer's problem.
    const argv = UI.listDirArgv('/mnt/it\'s "here"/x');
    assert.equal(argv[1], '/mnt/it\'s "here"/x');
});

test('parseFindOutput refuses to invent sizes from hostile fields', () => {
    const out = UI.parseFindOutput([
        'f\tnonsense\t0\ta',
        'f\t-500\t0\tb',
        'f\t1e309\t0\tc',
        'f\t\t\t'
    ].join('\n'), '/x');
    const byName = {};
    out.forEach((e) => { byName[e.name] = e; });
    assert.equal(byName.a.size, 0);
    assert.equal(byName.b.size, -500);              // find said so; do not lie about it
    assert.equal(byName.c.size, 0);                 // Infinity is not a size
    assert.equal(out.length, 3, 'a nameless row is no row');
});

test('parseFindOutput keeps unicode and quotes in names', () => {
    const out = UI.parseFindOutput('f\t10\t0\tÜnlü "belge".txt\n', '/docs');
    assert.equal(out[0].name, 'Ünlü "belge".txt');
    assert.equal(out[0].path, '/docs/Ünlü "belge".txt');
});

test('parseFindOutput ignores a directory argument of the wrong type', () => {
    assert.equal(UI.parseFindOutput('f\t1\t0\tx\n', null)[0].path, '/x');
    assert.equal(UI.parseFindOutput('f\t1\t0\tx\n', 42)[0].path, '42/x');
});

test('lsEntriesFor is not confused by prototype-shaped paths or huge sizes', () => {
    const nodes = [
        { name: '__proto__', type: 'file', path: '/__proto__', size: 1 },
        { name: 'constructor', type: 'dir', path: '/constructor', size: 0 },
        { name: 'big', type: 'file', path: '/big', size: 1e308 }
    ];
    const out = UI.lsEntriesFor(nodes, '/');
    assert.deepEqual(out.map((e) => e.name).sort(), ['__proto__', 'big', 'constructor']);
    assert.equal({}.polluted, undefined);
});

test('lsEntriesFor tolerates nodes whose fields are the wrong type', () => {
    const out = UI.lsEntriesFor([
        { name: 42, type: 7, path: '/x', size: 'big' },
        { path: '/y' },
        { name: 'z', path: null }
    ], '/');
    assert.deepEqual(out.map((e) => e.name), ['42', 'y']);
    assert.equal(out[0].size, 0);
    assert.equal(out[0].type, 'file');
});

test('treeRowsFor survives an mtime no calendar can hold', () => {
    const rows = UI.treeRowsFor([{ name: 'x', type: 'file', path: '/x', mtime: 1e20 }], {});
    assert.equal(rows[0].mtimeLabel, 'unknown');
});

test('treeRowsFor does not choke on a badge map that is not a map', () => {
    ['string', 42, true, []].forEach((badges) => {
        assert.doesNotThrow(() => UI.treeRowsFor(ENTRIES, badges));
    });
});

test('compareEntries orders unicode names without throwing', () => {
    const rows = UI.treeRowsFor([
        { name: 'çilek', type: 'file', path: '/a' },
        { name: 'Ada', type: 'file', path: '/b' },
        { name: 'ada', type: 'file', path: '/c' }
    ], {});
    assert.equal(rows.length, 3);
    assert.equal(rows[0].name.toLowerCase(), 'ada');
});

test('selectionSummary ignores negative and absurd sizes', () => {
    assert.equal(UI.selectionSummary([{ type: 'file', size: -100 }]), '1 file');
    assert.equal(UI.selectionSummary([{ type: 'file', size: 1e309 }]), '1 file');
});

test('timelineModel refuses a snapshot list that is not a list', () => {
    assert.throws(() => UI.timelineModel('nope', NOW), (e) => e.name === 'HangarError');
});

test('timelineModel keeps undated snapshots reachable rather than dropping them', () => {
    // A snapshot the user cannot reach is a file the user cannot restore.
    const bands = UI.timelineModel([{ id: 'x', time: 'not a date' }], NOW);
    assert.equal(bands.length, 1);
    assert.equal(bands[0].moments[0].id, 'x');
    assert.equal(bands[0].moments[0].absolute, 'unknown');
});

test('momentFor tolerates a snapshot that is not an object', () => {
    assert.equal(UI.momentFor(null, NOW).id, '');
    assert.equal(UI.momentFor('2026-08-01T12:00:00Z', NOW).relative, 'just now');
    assert.deepEqual(UI.momentFor({ paths: 'not-a-list' }, NOW).paths, []);
});

// --- the selection cannot silently become "everything" --------------------

test('includePathsFrom drops entries that name nothing', () => {
    // normalizePath(null) is '/', so coercing a hole in the selection would turn
    // it into the snapshot root — the whole system, in original mode.
    assert.deepEqual(UI.includePathsFrom([null, undefined, '', '   ', {}, { path: '' }]), []);
});

test('includePathsFrom keeps a genuine root selection', () => {
    assert.deepEqual(UI.includePathsFrom([{ path: '/' }]), ['/']);
});

test('restorePlan with a hole in the selection does not restore the whole snapshot', () => {
    const plan = UI.restorePlan([null, { path: '' }], 'original', '', { snapshot: 'abc' });
    assert.deepEqual(plan.include, []);
    assert.equal(plan.valid, false);
    assert.ok(!plan.warnings.some((w) => /whole snapshot/.test(w)));
});

test('restorePlan refuses a target containing a line break or a NUL', () => {
    ['/var/tmp/a\nb', '/var/tmp/a' + NUL + 'b', '/var/tmp/a\rb'].forEach((target) => {
        const plan = UI.restorePlan(SEL, 'alternate', target, { snapshot: 'abc' });
        assert.equal(plan.valid, false, `accepted ${JSON.stringify(target)}`);
        assert.ok(plan.problems.some((p) => /control characters/.test(p)));
        assert.equal(plan.target, '');
    });
});

test('restorePlan keeps quotes and unicode in an otherwise valid target', () => {
    const plan = UI.restorePlan(SEL, 'alternate', '/var/tmp/"geri yükle"', { snapshot: 'abc' });
    assert.equal(plan.valid, true);
    assert.equal(plan.target, '/var/tmp/"geri yükle"');
});

test('restorePlan rejects every wrong-typed mode with a typed error', () => {
    [0, 42, [], {}, true].forEach((mode) => {
        assert.throws(() => UI.restorePlan(SEL, mode, '/var/tmp', { snapshot: 'a' }),
            (e) => e.name === 'HangarError', `mode ${String(mode)} was accepted`);
    });
});

test('restorePlan treats a missing opts bag as no snapshot rather than crashing', () => {
    const plan = UI.restorePlan(SEL, 'alternate', '/var/tmp');
    assert.equal(plan.valid, false);
    assert.ok(plan.problems.some((p) => /moment/.test(p)));
});

// --- errors become buttons, and non-fatal ones become warnings ------------

test('errorAlertClass never paints a partial success as a failure', () => {
    const partial = UI.errorView(Errors.create('READ_ERRORS', 'some files were unreadable'));
    const fatal = UI.errorView(Errors.create('REPO_LOCKED', 'locked'));
    assert.equal(UI.errorAlertClass(partial), 'alert alert-warning');
    assert.equal(UI.errorAlertClass(fatal), 'alert alert-danger');
    assert.equal(UI.errorAlertClass(null), '');
});

test('a cancelled operation is neutral, not a failure', () => {
    const view = UI.errorView(Errors.create('CANCELLED', 'Operation was cancelled'));
    assert.equal(view.fatal, false);
    assert.equal(UI.errorAlertClass(view), 'alert alert-warning');
    assert.equal(view.action, null);
});

test('noticeAlertClass maps the three notice kinds and defaults to success', () => {
    assert.equal(UI.noticeAlertClass('warning'), 'alert alert-warning');
    assert.equal(UI.noticeAlertClass('info'), 'alert alert-info');
    assert.equal(UI.noticeAlertClass('success'), 'alert alert-success');
    assert.equal(UI.noticeAlertClass(undefined), 'alert alert-success');
});

test('unreadableFromMessages names the file and the reason, once each', () => {
    const out = UI.unreadableFromMessages([
        { message_type: 'error', item: '/var/lib/x', message: 'permission denied' },
        { message_type: 'error', item: '/var/lib/x', message: 'permission denied' },
        { message_type: 'error', item: '/var/lib/y' },
        { message_type: 'error', message: 'no item recorded' },
        null,
        'a bare string'
    ]);
    assert.deepEqual(out, [
        '/var/lib/x — permission denied',
        '/var/lib/y',
        'no item recorded',
        'a bare string'
    ]);
});

test('unreadableFromMessages tolerates junk instead of rendering "undefined"', () => {
    assert.deepEqual(UI.unreadableFromMessages(null), []);
    assert.deepEqual(UI.unreadableFromMessages('not a list'), []);
    assert.deepEqual(UI.unreadableFromMessages([{}, { item: '   ' }]), []);
});

test('unreadableFromError recovers the file list out of a typed read error', () => {
    const stderr = [
        '{"message_type":"error","item":"/proc/1/mem","message":"permission denied"}',
        'restic: some plain noise',
        '{"message_type":"exit_error","code":3,"message":"read errors"}'
    ].join('\n');
    const e = Errors.create('READ_ERRORS', 'some files were unreadable', { stderr: stderr });
    assert.deepEqual(UI.unreadableFromError(e), ['/proc/1/mem — permission denied']);
});

test('unreadableFromError returns nothing when there is nothing to list', () => {
    assert.deepEqual(UI.unreadableFromError(null), []);
    assert.deepEqual(UI.unreadableFromError(new Error('boom')), []);
    assert.deepEqual(UI.unreadableFromError(Errors.create('READ_ERRORS', 'x')), []);
});

// --- typed failures reaching the screen ------------------------------------

test('a locked repository offers Unlock rather than a toast', async () => {
    const c = attached();
    await withCockpit(spawnFailure(11, ''), () => c.loadSnapshots());
    assert.equal(c.error.kind, 'REPO_LOCKED');
    assert.equal(c.error.action, 'unlock');
    assert.equal(c.error.actionLabel, 'Unlock repository');
    assert.equal(c.errorClass(), 'alert alert-danger');
    assert.equal(c.busy, false);
});

test('a wrong password offers a re-prompt', async () => {
    const c = attached();
    await withCockpit(spawnFailure(12, ''), () => c.loadSnapshots());
    assert.equal(c.error.kind, 'WRONG_PASSWORD');
    assert.equal(c.error.action, 'reprompt');
    assert.equal(c.error.actionLabel, 'Enter password');
});

test('a missing repository offers to initialise it', async () => {
    const c = attached();
    await withCockpit(spawnFailure(10, ''), () => c.loadSnapshots());
    assert.equal(c.error.kind, 'REPO_MISSING');
    assert.equal(c.error.action, 'init');
});

test('a full destination offers the free-space remediation', async () => {
    const c = attached();
    await withCockpit(spawnFailure(1, 'save: write /srv/backup: no space left on device'),
        () => c.loadSnapshots());
    assert.equal(c.error.kind, 'NO_SPACE');
    assert.equal(c.error.action, 'free-space');
});

test('an unreachable backend offers retry', async () => {
    const c = attached();
    await withCockpit(spawnFailure(1, 'dial tcp 10.0.0.9:22: connection refused'),
        () => c.loadSnapshots());
    assert.equal(c.error.kind, 'NETWORK');
    assert.equal(c.error.action, 'retry');
});

test('read errors reaching the screen render as a warning listing the files', async () => {
    // The design rule: exit 3 is a PARTIAL SUCCESS. It must never wear the
    // failure colour, and it must name what could not be read.
    const c = attached();
    const stderr = '{"message_type":"error","item":"/srv/x","message":"permission denied"}';
    await withCockpit(spawnFailure(3, stderr), () => c.loadSnapshots());
    assert.equal(c.error.kind, 'READ_ERRORS');
    assert.equal(c.error.fatal, false);
    assert.equal(c.errorClass(), 'alert alert-warning');
    assert.deepEqual(c.unreadable, ['/srv/x — permission denied']);
    assert.equal(c.unreadableTitle, 'Some files could not be read.');
    assert.equal(c.showUnreadable, true, 'a partial result lists what it skipped');
});

test('a repository definition restic cannot use fails typed, not with a raw TypeError', async () => {
    const c = UI.hangarLogbookUi();
    c.repoId = 'nas';
    c.repo = { id: 'nas', kind: 'nonsense-backend' };
    await c.loadSnapshots();
    assert.ok(c.error, 'an unusable repository must surface');
    assert.match(c.error.message, /repository kind/i);
    assert.equal(c.busy, false);
});

test('a repository id that is not a legal filename fails typed', async () => {
    const c = UI.hangarLogbookUi();
    c.repoId = '../../etc/shadow';
    c.repo = LOCAL_REPO;
    await c.loadSnapshots();
    assert.ok(c.error);
    assert.equal(c.busy, false);
});

test('a channel that throws when it opens rejects rather than escaping the try', async () => {
    const c = attached();
    await withCockpit(() => { throw new Error('no superuser bridge'); }, () => c.loadSnapshots());
    assert.ok(c.error);
    assert.match(c.error.message, /superuser bridge/);
    assert.equal(c.busy, false);
});

test('unparseable snapshot output fails typed instead of rendering an empty scrubber', async () => {
    const c = attached();
    await withCockpit(() => Promise.resolve('<html>proxy error</html>'), () => c.loadSnapshots());
    assert.ok(c.error, 'garbage must not silently become "no snapshots"');
    assert.deepEqual(c.bands, []);
});

// --- the listing is partial, not silently short ---------------------------

test('one unreadable repository definition warns instead of vanishing', async () => {
    await withPatched(Config, {
        listRepos: () => Promise.resolve(['nas', 'broken']),
        readRepo: (id) => id === 'nas'
            ? Promise.resolve({ kind: 'local', path: '/srv/backup' })
            : Promise.reject(Errors.create('GENERIC', 'Could not read /etc/hangar/repos/broken.json'))
    }, async () => {
        const c = UI.hangarLogbookUi();
        await withCockpit(spawnFailure(10, ''), () => c.loadRepos());
        assert.deepEqual(c.repos.map((r) => r.id), ['nas'], 'the readable one still lists');
        assert.equal(c.unreadable.length, 1);
        assert.match(c.unreadable[0], /broken\.json/);
        assert.match(c.unreadableTitle, /could not be read/);
        c.clearIdle();
    });
});

test('an empty repository definition is reported, not treated as absent', async () => {
    await withPatched(Config, {
        listRepos: () => Promise.resolve(['hollow']),
        readRepo: () => Promise.resolve(null)
    }, async () => {
        const c = UI.hangarLogbookUi();
        await c.loadRepos();
        assert.deepEqual(c.repos, []);
        assert.equal(c.unreadable.length, 1);
        assert.match(c.unreadable[0], /empty/);
    });
});

test('a listing that fails outright surfaces as an error with a remediation', async () => {
    await withPatched(Config, {
        listRepos: () => Promise.reject(Errors.create('REPO_LOCKED', 'locked'))
    }, async () => {
        const c = UI.hangarLogbookUi();
        await c.loadRepos();
        assert.equal(c.error.action, 'unlock');
        assert.equal(c.busy, false);
    });
});

// --- the file tree ---------------------------------------------------------

test('a tree that cannot be read leaves a breadcrumb the user can climb out of', async () => {
    const c = attached();
    c.moment = { id: 'abc', snapshot: { id: 'abc', time: '2026-08-01T10:00:00Z' } };
    c.cwd = '/var/log';
    c.reader = 'ls';
    await withCockpit(spawnFailure(11, ''), () => c.loadTree());
    assert.equal(c.error.action, 'unlock');
    assert.deepEqual(c.rows, []);
    assert.deepEqual(c.crumbs.map((x) => x.path), ['/', '/var', '/var/log']);
    assert.equal(c.busy, false);
});

test('losing the diff costs badges, never the file tree', async () => {
    const c = attached();
    c.bands = UI.timelineModel(SNAPS, NOW);
    c.moment = c.bands[0].moments[0];
    await withCockpit(spawnFailure(11, ''), () => c.loadBadges());
    assert.deepEqual(c.badges, {});
    assert.equal(c.error, null, 'a decorative failure must not become a screen error');
});

test('a backend needing credentials falls back before mounting, with a reason', async () => {
    const c = UI.hangarLogbookUi();
    c.repoId = 'off';
    c.repo = { id: 'off', kind: 's3', endpoint: 's3.eu.amazonaws.com', bucket: 'b',
        accessKeyId: 'AK', secretAccessKey: 'S' };
    assert.equal(await c.ensureMount(), false);
    assert.equal(c.reader, 'ls');
    assert.match(c.fallbackReason, /credentials/);
});

test('a mount that cannot be made falls back rather than failing the screen', async () => {
    await withPatched(Core, {
        isMounted: () => Promise.reject(Errors.create('GENERIC', 'fuse3 is not installed'))
    }, async () => {
        const c = attached();
        assert.equal(await c.ensureMount(), false);
        assert.equal(c.reader, 'ls');
        assert.equal(c.fallbackReason, 'fuse3 is not installed');
        assert.equal(c.error, null);
    });
});

test('the mount runtime cap is always the positive integer systemd insists on', async () => {
    const seen = [];
    await withPatched(Core, {
        isMounted: () => Promise.resolve({ mounted: false }),
        mount: (o) => { seen.push(o); return Promise.resolve({}); },
        mountPoint: () => '/run/hangar/mnt/nas'
    }, async () => {
        for (const idle of [900, 100.3, 1e12, -5, 'nonsense', 0]) {
            const c = attached();
            c.idleSec = idle;
            await c.ensureMount();
            c.clearIdle();
        }
        assert.equal(seen.length, 6);
        seen.forEach((o) => {
            assert.ok(Number.isInteger(o.maxRuntimeSec), `not an integer: ${o.maxRuntimeSec}`);
            assert.ok(o.maxRuntimeSec > 0, `not positive: ${o.maxRuntimeSec}`);
        });
    });
});

test('an unmount that fails is swallowed rather than blocking the screen', async () => {
    await withPatched(Core, {
        unmount: () => Promise.reject(new Error('unit not loaded'))
    }, async () => {
        const c = attached();
        c.reader = 'mount';
        await c.releaseMount();
        assert.equal(c.reader, 'none');
        assert.equal(c.error, null);
    });
});

// --- the idle timer --------------------------------------------------------

test('an absurd idle timeout cannot collapse to an instant unmount', () => {
    // setTimeout clamps anything past the 32-bit ceiling to 1ms, which would drop
    // the mount the moment the screen opened.
    const c = UI.hangarLogbookUi();
    [1e12, Number.MAX_VALUE, Infinity].forEach((v) => {
        c.idleSec = v;
        assert.ok(c.idleMs() <= 86400 * 1000, `not clamped: ${c.idleMs()}`);
        assert.ok(c.idleMs() >= 60 * 1000);
    });
});

test('a nonsense or negative idle timeout falls back to something usable', () => {
    const c = UI.hangarLogbookUi();
    [-5, 0, NaN, 'nonsense', null, undefined, {}].forEach((v) => {
        c.idleSec = v;
        const ms = c.idleMs();
        assert.ok(Number.isFinite(ms) && ms >= 60 * 1000, `bad idleMs for ${String(v)}: ${ms}`);
    });
});

// --- remediation actually remediates --------------------------------------

test('Unlock runs restic unlock and then reloads the scrubber', async () => {
    const ops = [];
    await withPatched(Restic, { run: (op) => { ops.push(op); return Promise.resolve({ status: 'ok' }); } },
        async () => {
            const c = attached();
            c.error = UI.errorView(Errors.create('REPO_LOCKED', 'locked'));
            await withCockpit(() => Promise.resolve('[]'), () => c.remediate());
            assert.deepEqual(ops, ['unlock']);
            assert.equal(c.error, null);
            assert.equal(c.busy, false);
            c.clearIdle();
        });
});

test('Initialise runs restic init', async () => {
    const ops = [];
    await withPatched(Restic, { run: (op) => { ops.push(op); return Promise.resolve({ status: 'ok' }); } },
        async () => {
            const c = attached();
            c.error = UI.errorView(Errors.create('REPO_MISSING', 'missing'));
            await withCockpit(() => Promise.resolve('[]'), () => c.remediate());
            assert.deepEqual(ops, ['init']);
            assert.equal(c.error, null);
            c.clearIdle();
        });
});

test('a remediation that itself fails replaces the error rather than clearing it', async () => {
    await withPatched(Restic, { run: () => Promise.reject(Errors.create('WRONG_PASSWORD', 'wrong password')) },
        async () => {
            const c = attached();
            c.error = UI.errorView(Errors.create('REPO_LOCKED', 'locked'));
            await c.remediate();
            assert.equal(c.error.kind, 'WRONG_PASSWORD');
            assert.equal(c.error.action, 'reprompt');
            assert.equal(c.busy, false);
        });
});

test('the password re-prompt stores the new password and clears the error', async () => {
    const written = [];
    await withPatched(Secrets, { writeKey: (id, pw) => { written.push([id, pw]); return Promise.resolve(); } },
        () => withDialogs({ passwordDialog: () => Promise.resolve('hünkar') }, async () => {
            const c = attached();
            c.error = UI.errorView(Errors.create('WRONG_PASSWORD', 'wrong password'));
            await withCockpit(() => Promise.resolve('[]'), () => c.remediate());
            assert.deepEqual(written, [['nas', 'hünkar']]);
            assert.equal(c.error, null);
            c.clearIdle();
        }));
});

test('dismissing the password prompt leaves the error standing', async () => {
    // Clearing it would claim a password was accepted when none was entered.
    const written = [];
    await withPatched(Secrets, { writeKey: (id, pw) => { written.push(pw); return Promise.resolve(); } },
        () => withDialogs({ passwordDialog: () => Promise.resolve(null) }, async () => {
            const c = attached();
            c.error = UI.errorView(Errors.create('WRONG_PASSWORD', 'wrong password'));
            await c.remediate();
            assert.deepEqual(written, []);
            assert.ok(c.error, 'the error must survive a dismissed prompt');
            assert.equal(c.error.kind, 'WRONG_PASSWORD');
            assert.equal(c.busy, false);
        }));
});

test('a missing password dialog is a typed failure, not "is not a function"', async () => {
    const c = attached();
    c.error = UI.errorView(Errors.create('WRONG_PASSWORD', 'wrong password'));
    await c.remediate();
    assert.ok(c.error);
    assert.match(c.error.message, /password dialog/i);
    assert.ok(!/is not a function/.test(c.error.message));
    assert.equal(c.busy, false);
});

test('the free-space remediation names the destination and keeps the error', async () => {
    const c = attached();
    c.error = UI.errorView(Errors.create('NO_SPACE', 'no space left on the backup destination'));
    await c.remediate();
    assert.equal(c.noticeKind, 'warning');
    assert.match(c.notice, /\/srv\/backup/);
    assert.ok(c.error, 'hangar cannot free the space, so the condition still stands');
});

test('the retry remediation clears the error and reloads', async () => {
    const c = attached();
    c.error = UI.errorView(Errors.create('NETWORK', 'connection refused'));
    await withCockpit(() => Promise.resolve('[]'), () => c.remediate());
    assert.equal(c.error, null);
    assert.deepEqual(c.snapshots, []);
    c.clearIdle();
});

test('the list-unreadable remediation reveals a list, and says so when there is none', async () => {
    const c = attached();
    c.error = UI.errorView(Errors.create('READ_ERRORS', 'some files were unreadable'));
    await c.remediate();
    assert.equal(c.showUnreadable, true);
    assert.equal(c.unreadable.length, 1);
    assert.match(c.unreadable[0], /journald/);
    await c.remediate();
    assert.equal(c.showUnreadable, false, 'the button toggles');
});

test('every remediation the errors module can emit is handled by the screen', async () => {
    await withPatched(Restic, { run: () => Promise.resolve({ status: 'ok' }) },
        () => withPatched(Secrets, { writeKey: () => Promise.resolve() },
            () => withDialogs({ passwordDialog: () => Promise.resolve('pw') }, async () => {
                for (const kind of Object.keys(Errors.REMEDIATION)) {
                    const c = attached();
                    c.error = UI.errorView(Errors.create(kind, kind));
                    assert.ok(c.error.actionLabel, `no button label for ${kind}`);
                    await withCockpit(() => Promise.resolve('[]'), () => c.remediate());
                    // Handled means something observably happened: the error was
                    // cleared, a notice explained why it could not be, or the
                    // unreadable list opened.
                    const acted = c.error === null || c.notice !== '' || c.showUnreadable;
                    assert.ok(acted, `remediation for ${kind} did nothing`);
                    c.clearIdle();
                }
            })));
});

test('remediate does nothing at all when the error carries no action', async () => {
    const c = attached();
    c.error = UI.errorView(Errors.create('GO_RUNTIME', 'restic crashed'));
    assert.equal(c.error.action, null);
    await c.remediate();
    assert.ok(c.error, 'an error with no one-click fix stays on screen');
    assert.equal(c.busy, false);
});

// --- restore outcomes ------------------------------------------------------

const PLAN = { snapshot: 'abc', target: '/var/tmp/hangar-restore', include: ['/etc/hosts'], verify: false };

test('a partial restore is a warning naming the unreadable files, never a failure', async () => {
    // Design §8: exit 3 wrote what it could read. Reporting it as a failure would
    // train the user to ignore the failures that matter.
    await withPatched(Restic, {
        run: () => Promise.resolve({
            status: 'partial',
            errors: [
                { message_type: 'error', item: '/etc/shadow', message: 'permission denied' },
                { message_type: 'error', item: '/proc/1/mem', message: 'operation not permitted' }
            ],
            summary: {}, progress: null
        })
    }, async () => {
        const c = attached();
        await c.runRestore(PLAN);
        assert.equal(c.error, null, 'a partial success must not be an error');
        assert.equal(c.noticeKind, 'warning');
        assert.equal(c.noticeClass(), 'alert alert-warning');
        assert.match(c.notice, /some files could not be read/i);
        assert.deepEqual(c.unreadable, [
            '/etc/shadow — permission denied',
            '/proc/1/mem — operation not permitted'
        ]);
        assert.equal(c.showUnreadable, true, 'the list is opened, not hidden behind a click');
        assert.equal(c.unreadableTitle, 'Some files could not be read.');
        assert.equal(c.busy, false);
    });
});

test('a cancelled restore is neutral, not an error and not a success', async () => {
    await withPatched(Restic, { run: () => Promise.resolve({ status: 'cancelled', errors: [] }) },
        async () => {
            const c = attached();
            await c.runRestore(PLAN);
            assert.equal(c.error, null);
            assert.equal(c.noticeKind, 'info');
            assert.equal(c.noticeClass(), 'alert alert-info');
            assert.match(c.notice, /cancelled/);
        });
});

test('a successful restore says where the files went', async () => {
    await withPatched(Restic, { run: () => Promise.resolve({ status: 'ok', errors: [] }) },
        async () => {
            const c = attached();
            await c.runRestore(PLAN);
            assert.equal(c.noticeKind, 'success');
            assert.match(c.notice, /\/var\/tmp\/hangar-restore/);
            assert.deepEqual(c.unreadable, []);
        });
});

test('a failed restore surfaces the remediation and drops the stale success notice', async () => {
    await withPatched(Restic, { run: () => Promise.reject(Errors.create('NO_SPACE', 'no space left')) },
        async () => {
            const c = attached();
            c.notice = 'Restored to /somewhere.';
            await c.runRestore(PLAN);
            assert.equal(c.notice, '', 'a previous success must not sit next to a failure');
            assert.equal(c.error.action, 'free-space');
            assert.equal(c.errorClass(), 'alert alert-danger');
            assert.equal(c.busy, false);
            assert.equal(c.progress, null);
        });
});

test('a restore result of an unexpected shape does not crash the screen', async () => {
    for (const result of [null, undefined, {}, 'ok']) {
        await withPatched(Restic, { run: () => Promise.resolve(result) }, async () => {
            const c = attached();
            await c.runRestore(PLAN);
            assert.equal(c.busy, false);
            assert.equal(c.error, null);
        });
    }
});

test('restore progress is rendered rather than merely stored', () => {
    const c = attached();
    assert.equal(c.progressLabel(), '');
    c.progress = { message_type: 'status', percent_done: 0.4213, bytes_done: 2400000, total_bytes: 3e9 };
    assert.equal(c.progressLabel(), '42% \u00b7 2.3 MiB of 2.8 GiB');
});

test('progressLabel refuses to render a nonsense percentage', () => {
    const c = UI.hangarLogbookUi();
    c.progress = { percent_done: 'nonsense', bytes_done: -1 };
    assert.equal(c.progressLabel(), '');
    c.progress = { percent_done: 7, bytes_done: 0 };
    assert.equal(c.progressLabel(), '100%');       // clamped, never '700%'
    c.progress = { percent_done: -3 };
    assert.equal(c.progressLabel(), '0%');
});

test('the restore button reports a missing dialog instead of hanging on it', async () => {
    // Without the partial there is no listener, so the await would never settle
    // and the button would look broken with nothing said.
    const c = attached();
    c.moment = { id: 'abc', absolute: '1 Aug 2026 10:00' };
    c.selected = [{ path: '/etc/hosts', name: 'hosts', isDir: false, size: 1 }];
    await c.restore();
    assert.ok(c.error);
    assert.match(c.error.message, /restore dialog/i);
});

test('restore does nothing when nothing is selected or no moment is chosen', async () => {
    const c = attached();
    c.moment = { id: 'abc' };
    await c.restore();
    assert.equal(c.error, null);
    c.selected = [{ path: '/x' }];
    c.moment = null;
    await c.restore();
    assert.equal(c.error, null);
});

// --- selection guards ------------------------------------------------------

test('a row with no path cannot be selected', () => {
    const c = UI.hangarLogbookUi();
    [null, undefined, {}, { path: '' }, 'string'].forEach((r) => c.toggle(r));
    assert.deepEqual(c.selected, []);
    assert.equal(c.isSelected(null), false);
    c.clearIdle();
});

test('a selection that survived from an older render cannot summarise to nonsense', () => {
    const c = UI.hangarLogbookUi();
    c.selected = [null, { path: '/a', type: 'file', size: 1000 }];
    assert.equal(c.selectionLabel(), '1 file (1000 B)');
});

// --- the restore dialog ----------------------------------------------------

test('the dialog lists exactly the paths the plan will restore', () => {
    const d = UI.hangarRestore();
    d.selection = [{ path: '/etc/hosts' }, null, { path: '' }, { name: 'orphan' }, { path: '/etc/hosts' }];
    // Entries that name nothing are gone, duplicates are collapsed, and what
    // remains is character-for-character what restic will be handed.
    assert.deepEqual(d.selectionPaths(), ['/etc/hosts', 'orphan']);
    assert.deepEqual(d.selectionPaths(), d.plan().include);
});

test('a destructive restore fails closed when the confirmation dialog is missing', async () => {
    let got = 'untouched';
    const d = UI.hangarRestore();
    d.selection = SEL;
    d.snapshot = 'abc';
    d.mode = 'original';
    d._resolve = (v) => { got = v; };
    await d.submit();
    assert.equal(got, 'untouched', 'nothing may be restored without the confirmation');
    assert.match(d.dialogError, /confirmation dialog/i);
    assert.equal(d.open, false);
});

test('a confirmation dialog that throws stops the restore and says why', async () => {
    await withDialogs({ confirmDialog: () => Promise.reject(new Error('modal is gone')) }, async () => {
        let got = 'untouched';
        const d = UI.hangarRestore();
        d.selection = SEL;
        d.snapshot = 'abc';
        d.mode = 'original';
        d._resolve = (v) => { got = v; };
        await d.submit();
        assert.equal(got, 'untouched');
        assert.equal(d.dialogError, 'modal is gone');
    });
});

test('a safe restore never consults the danger dialog at all', async () => {
    let asked = 0;
    await withDialogs({ confirmDialog: () => { asked++; return Promise.resolve(true); } }, async () => {
        const d = UI.hangarRestore();
        d.selection = SEL;
        d.snapshot = 'abc';
        d.target = '/var/tmp/restore';
        d._resolve = () => {};
        await d.submit();
        assert.equal(asked, 0);
    });
});

test('a target of "/" is treated as destructive by the dialog too', async () => {
    const asked = [];
    await withDialogs({ confirmDialog: (o) => { asked.push(o); return Promise.resolve(true); } },
        async () => {
            let got = null;
            const d = UI.hangarRestore();
            d.selection = SEL;
            d.snapshot = 'abc';
            d.target = '/';
            d._resolve = (v) => { got = v; };
            await d.submit();
            assert.equal(asked.length, 1, 'restoring into "/" overwrites the originals');
            assert.equal(asked[0].danger, true);
            assert.ok(got.destructive);
        });
});

test('the dialog reports a plan it cannot build without a destructive fallback', () => {
    const d = UI.hangarRestore();
    d.selection = SEL;
    d.mode = 'sideways';
    const plan = d.plan();
    assert.equal(plan.valid, false);
    assert.equal(plan.destructive, false, 'an unbuildable plan must never look destructive-ready');
});

// --- accessibility ---------------------------------------------------------

function tagsWithClick(html) {
    return [...html.matchAll(/<([a-zA-Z-]+)[^>]*?@click/g)].map((m) => m[1].toLowerCase());
}

test('every click target in the screen is a real button', () => {
    const tags = tagsWithClick(UI.template());
    assert.ok(tags.length >= 4);
    tags.forEach((tag) => {
        assert.equal(tag, 'button', `@click on <${tag}> — keyboard users cannot reach it`);
    });
});

test('every click target in the restore modal is a real button', () => {
    const tags = tagsWithClick(RESTORE_HTML);
    assert.ok(tags.length >= 2);
    tags.forEach((tag) => {
        assert.equal(tag, 'button', `@click on <${tag}> in restore.html`);
    });
});

test('every form control in the screen has a label bound to it', () => {
    const html = UI.template();
    // Static ids...
    [...html.matchAll(/<(?:input|select|textarea)[^>]*\bid="([^"]+)"/g)].forEach((m) => {
        assert.ok(html.includes(`for="${m[1]}"`), `no label for #${m[1]}`);
    });
    // ...and Alpine-bound ones, where the expression itself has to match.
    const bound = [...html.matchAll(/<(?:input|select|textarea)[^>]*:id="([^"]+)"/g)];
    assert.ok(bound.length >= 1);
    bound.forEach((m) => {
        assert.ok(html.includes(`:for="${m[1]}"`), `no bound label for :id="${m[1]}"`);
    });
});

test('every form control in the restore modal has a label bound to it', () => {
    const ids = [...RESTORE_HTML.matchAll(/<(?:input|select|textarea)[^>]*?\bid="([^"]+)"/g)];
    assert.ok(ids.length >= 3);
    ids.forEach((m) => {
        assert.ok(RESTORE_HTML.includes(`for="${m[1]}"`), `no label for #${m[1]}`);
    });
});

test('the only control with no visible text carries an aria-label', () => {
    // btn-close renders an icon, so its name has to come from aria-label.
    assert.match(RESTORE_HTML, /class="btn-close"[\s\S]*?aria-label="Close"/);
});

test('the scrubber owns its options through labelled groups, not orphaned divs', () => {
    const html = UI.template();
    assert.ok(html.includes('role="listbox"'));
    assert.ok(html.includes('role="group"'), 'options directly under a listbox need a group wrapper');
    assert.ok(html.includes('role="option"'));
    assert.ok(html.includes(':aria-label="band.label"'));
    // The visible band heading would otherwise be announced twice.
    assert.ok(html.includes('aria-hidden="true"'));
});

test('status and failure regions announce themselves', () => {
    const html = UI.template();
    assert.ok(html.includes('role="alert"'), 'the error region must be a live alert');
    assert.ok(html.includes('role="status"'), 'progress and notices must be announced');
    assert.ok(html.includes('aria-live="polite"'));
    assert.ok(html.includes(':aria-expanded="showUnreadable"'), 'the disclosure state must be exposed');
});

test('the error region takes its colour from the fatality of the error', () => {
    const html = UI.template();
    assert.ok(html.includes(':class="errorClass()"'),
        'a hardcoded alert-danger would paint a partial success as a failure');
    assert.ok(!/x-show="error"[^>]*alert-danger/.test(html));
    assert.ok(html.includes(':class="noticeClass()"'));
});

// --- the feature is called Logbook -----------------------------------------

test('neither the screen nor its modal mentions "Time Mach" + "ine"', () => {
    // Spelled apart so this assertion cannot itself trip the smoke test.
    const re = /time\s*machine/i;
    assert.ok(!re.test(SRC), 'js/features/logbook-ui.js');
    assert.ok(!re.test(RESTORE_HTML), 'html/modals/restore.html');
});

test('the source carries no stray NUL or carriage return', () => {
    // A control character in a plain script loaded by Cockpit is a silent and very
    // confusing failure.
    assert.ok(SRC.indexOf(NUL) < 0, 'NUL byte in the source');
    assert.ok(SRC.indexOf('\r') < 0, 'carriage return in the source');
    assert.ok(RESTORE_HTML.indexOf(NUL) < 0);
});

// --- deleting a snapshot ---------------------------------------------------
//
// restic separates unlinking a snapshot (`forget`, instant, frees nothing) from
// reclaiming its space (`prune`, slow). A delete that only forgot would leave a
// user watching a repository that never shrinks.

test('deleting asks restic to forget AND prune', () => {
    const Restic = require('../../js/engine/restic.js');
    const args = Restic.buildArgs('forget', {
        repoUrl: '/srv/r', passwordFile: '/k', snapshotIds: ['abc123'], prune: true
    });
    assert.ok(args.includes('abc123'), 'the snapshot id never reaches restic');
    assert.ok(args.includes('--prune'), 'forget without prune reclaims nothing');
});

test('a delete with no snapshot selected does nothing at all', async () => {
    const c = UI.hangarLogbookUi();
    c.repoId = 'main';
    assert.equal(await c.deleteMoment(null), false);
});

test('a delete on a moment carrying no id is refused', async () => {
    // A malformed timeline entry must not turn into `restic forget --prune`
    // with no snapshot argument, which is how you delete more than you meant.
    const c = UI.hangarLogbookUi();
    c.repoId = 'main';
    assert.equal(await c.deleteMoment({ time: '2026-08-04T00:00:00Z' }), false);
});

test('the button names the snapshot it would destroy', () => {
    const c = UI.hangarLogbookUi();
    assert.equal(c.momentLabel(), 'no snapshot');
    c.moment = { id: 'ff66aa11bb22', time: '2026-08-03T21:32:00Z' };
    assert.match(c.momentLabel(), /2026/);
});

// --- the screen must not be a photograph of page-load time -----------------
//
// Found live: a backup of / finished while the page was open, and the Logbook
// went on saying "Nothing has been backed up yet" about a repository that had
// just received 475,000 files. The list was read once, at load, and nothing
// ever read it again.

test('showing the screen re-reads the snapshot list', async () => {
    const c = UI.hangarLogbookUi();
    let asked = 0;
    c.repoId = 'main';
    c.refreshOnShow = async () => { asked += 1; return true; };
    c.visible = false;
    c.onScreenChange('logbook');
    assert.equal(asked, 1);
    // Becoming visible arms the idle-unmount timer; an armed timer keeps node
    // alive and the suite never exits.
    c.clearIdle();
});

test('leaving the screen releases the mount rather than refreshing', async () => {
    const c = UI.hangarLogbookUi();
    let released = 0, asked = 0;
    c.releaseMount = () => { released += 1; };
    c.refreshOnShow = async () => { asked += 1; };
    c.visible = true;
    c.onScreenChange('settings');
    assert.equal(released, 1);
    assert.equal(asked, 0);
});

test('a repeated visibility event does no work at all', () => {
    // x-effect fires on every reactive change, not only on a tab switch.
    const c = UI.hangarLogbookUi();
    let asked = 0;
    c.repoId = 'main';
    c.refreshOnShow = async () => { asked += 1; };
    c.visible = false;
    c.onScreenChange('logbook');
    c.onScreenChange('logbook');
    c.onScreenChange('logbook');
    assert.equal(asked, 1);
    c.clearIdle();
});

test('refreshing without a repository or mid-load does nothing', async () => {
    const c = UI.hangarLogbookUi();
    assert.equal(await c.refreshOnShow(), false);
    c.repoId = 'main';
    c.busy = true;
    assert.equal(await c.refreshOnShow(), false);
});

// --- how much is in the snapshot you are looking at ------------------------

test('the size label reads as a person would say it', () => {
    const c = UI.hangarLogbookUi();
    c.momentStats = { totalSize: 37437177569, totalFileCount: 475099 };
    assert.equal(c.momentSizeLabel(), '34.9 GiB \u00b7 475,099 files in this snapshot');
});

test('an unknown size renders nothing rather than a zero', () => {
    // A stats call that failed must not claim the snapshot is empty.
    const c = UI.hangarLogbookUi();
    assert.equal(c.momentSizeLabel(), '');
    c.momentStats = { totalSize: NaN, totalFileCount: 10 };
    assert.equal(c.momentSizeLabel(), '');
});

test('a slow repository says so instead of showing a stale number', () => {
    const c = UI.hangarLogbookUi();
    c.momentStats = { totalSize: 100, totalFileCount: 1 };
    c.momentStatsBusy = true;
    assert.equal(c.momentSizeLabel(), 'measuring…');
});

test('a genuinely empty snapshot shows its size without a file count', () => {
    const c = UI.hangarLogbookUi();
    c.momentStats = { totalSize: 0, totalFileCount: 0 };
    assert.equal(c.momentSizeLabel(), '0 B in this snapshot');
});

test('measuring nothing is refused, and clears any previous number', async () => {
    const c = UI.hangarLogbookUi();
    c.momentStats = { totalSize: 1, totalFileCount: 1 };
    assert.equal(await c.loadMomentStats(), false);
    assert.equal(c.momentStats, null, 'the previous snapshot\'s size was left on screen');
});

test('the size is measured with restore-size, not raw-data', () => {
    // "How much is in here" is the size of the files as they were — not how many
    // bytes this snapshot occupies after deduplication against its neighbours,
    // which is a different question with a much smaller answer.
    const Restic = require('../../js/engine/restic.js');
    const args = Restic.buildArgs('stats', { repoUrl: '/r', passwordFile: '/k',
        mode: 'restore-size', snapshotIds: ['ff66'] });
    assert.ok(args.includes('restore-size'));
    assert.ok(args.includes('ff66'), 'the snapshot id never reaches restic');
});
