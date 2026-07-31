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

test('formatBytes uses decimal units, matching the rest of the console', () => {
    assert.equal(UI.formatBytes(0), '0 B');
    assert.equal(UI.formatBytes(999), '999 B');
    assert.equal(UI.formatBytes(1000), '1 kB');
    assert.equal(UI.formatBytes(1536), '1.5 kB');
    assert.equal(UI.formatBytes(2400000), '2.4 MB');
    assert.equal(UI.formatBytes(3e9), '3 GB');
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
    assert.equal(rows[2].sizeLabel, '2.4 MB');
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
    assert.equal(UI.selectionSummary(sel), '3 files, 1 folder (2.4 MB)');
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
        '1 file, 1 folder (1 kB)');
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
    assert.equal(c.selectionLabel(), '1 file, 1 folder (1 kB)');
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
