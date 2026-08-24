// Unit tests for js/features/overview.js — the landing screen.
//
// The value here is in the pure functions: they decide whether a user is told
// "all good", "amber, some files were unreadable" or "red, here is the button that
// fixes it". Everything below drives the real logic rather than asserting that a
// component object can be constructed — the component tests use fake core modules
// so no DOM, no cockpit and no filesystem are involved.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const O = require('../../js/features/overview.js');
const Errors = require('../../js/core/errors.js');

const DASH = '—';

// A fixed clock so relative phrasing is deterministic.
const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);
const SEC = (ms) => ms / 1000;

function state(over) {
    return Object.assign({
        job: 'nightly', status: 'ok', kind: 'OK',
        started: SEC(NOW) - 90, finished: SEC(NOW),
        exit_code: 0, snapshot: 'abc1234', unreadable: 0
    }, over || {});
}

function unit(over) {
    const o = over || {};
    return {
        timer: Object.assign({ enabled: true, active: true, failed: false,
            nextElapseMs: null, lastTriggerMs: null }, o.timer || {}),
        service: Object.assign({ enabled: true, active: false, failed: false,
            nextElapseMs: null, lastTriggerMs: null }, o.service || {})
    };
}

// --- module shape --------------------------------------------------------

test('module loads with no DOM and no cockpit global', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.cockpit, 'undefined');
    assert.equal(typeof O.hangarOverview, 'function');
    assert.equal(typeof globalThis.hangarOverview, 'function');
});

test('the screen is never called Time Mach' + 'ine', () => {
    // Split above so this assertion cannot itself trip the smoke-test guard.
    assert.ok(!/time\s*machine/i.test(O.TEMPLATE));
    assert.ok(!/time\s*machine/i.test(JSON.stringify(O.LABEL)));
});

// --- formatBytes ---------------------------------------------------------

test('formatBytes: exact unit boundaries', () => {
    assert.equal(O.formatBytes(0), '0 B');
    assert.equal(O.formatBytes(1), '1 B');
    assert.equal(O.formatBytes(1023), '1023 B');
    assert.equal(O.formatBytes(1024), '1.0 KiB');
    assert.equal(O.formatBytes(1048576), '1.0 MiB');
    assert.equal(O.formatBytes(1073741824), '1.0 GiB');
    assert.equal(O.formatBytes(1099511627776), '1.0 TiB');
    assert.equal(O.formatBytes(1125899906842624), '1.0 PiB');
});

test('formatBytes: one byte below a boundary does not round up to 1024 of the smaller unit', () => {
    // 1048575 / 1024 is 1023.999… KiB, which naively prints as "1024.0 KiB".
    assert.equal(O.formatBytes(1048575), '1.0 MiB');
    assert.equal(O.formatBytes(1073741823), '1.0 GiB');
});

test('formatBytes: fractional values keep one decimal', () => {
    assert.equal(O.formatBytes(1536), '1.5 KiB');
    assert.equal(O.formatBytes(1610612736), '1.5 GiB');
    assert.equal(O.formatBytes(1024 * 1024 * 3.25), '3.3 MiB');
});

test('formatBytes: unknown is a dash, not zero', () => {
    // "we do not know how big the repository is" and "the repository is empty" are
    // different answers and must not look the same.
    for (const bad of [null, undefined, NaN, Infinity, -1, '1024', {}, []])
        assert.equal(O.formatBytes(bad), DASH, `formatBytes(${JSON.stringify(bad)})`);
});

test('formatBytes: caps at the largest unit it knows', () => {
    assert.equal(O.formatBytes(Math.pow(1024, 6)), '1.0 EiB');
    assert.match(O.formatBytes(Math.pow(1024, 8)), /EiB$/);
});

// --- formatDuration ------------------------------------------------------

test('formatDuration: seconds', () => {
    assert.equal(O.formatDuration(0), '0s');
    assert.equal(O.formatDuration(1), '1s');
    assert.equal(O.formatDuration(59), '59s');
    assert.equal(O.formatDuration(0.9), '0s');
});

test('formatDuration: minute boundaries', () => {
    assert.equal(O.formatDuration(60), '1m');
    assert.equal(O.formatDuration(61), '1m 1s');
    assert.equal(O.formatDuration(90), '1m 30s');
    assert.equal(O.formatDuration(3599), '59m 59s');
});

test('formatDuration: hour boundaries', () => {
    assert.equal(O.formatDuration(3600), '1h');
    assert.equal(O.formatDuration(3660), '1h 1m');
    assert.equal(O.formatDuration(3661), '1h 1m');   // never three units deep
    assert.equal(O.formatDuration(86399), '23h 59m');
});

test('formatDuration: day boundaries', () => {
    assert.equal(O.formatDuration(86400), '1d');
    assert.equal(O.formatDuration(90000), '1d 1h');
    assert.equal(O.formatDuration(86400 * 3 + 60), '3d');
});

test('formatDuration: unknown is a dash', () => {
    for (const bad of [null, undefined, NaN, -1, Infinity, '60'])
        assert.equal(O.formatDuration(bad), DASH, `formatDuration(${JSON.stringify(bad)})`);
});

// --- summarizeJob: never run --------------------------------------------

test('summarizeJob: no state and no unit is neutral, not alarming', () => {
    const s = O.summarizeJob({ id: 'nightly' }, null, null);
    assert.equal(s.status, 'never');
    assert.equal(s.remediation, null);
    assert.equal(s.nextRun, null);
    assert.equal(O.statusClass(s.status), '', 'never run must use the grey base dot');
});

test('summarizeJob: never run but scheduled says so', () => {
    const s = O.summarizeJob({ id: 'n' }, null, unit({ timer: { nextElapseMs: NOW + 3600000 } }));
    assert.equal(s.status, 'never');
    assert.equal(s.nextRun, NOW + 3600000);
    assert.match(s.detail, /has not run yet/);
});

test('summarizeJob: an undefined state is treated exactly like a missing one', () => {
    assert.equal(O.summarizeJob({ id: 'n' }, undefined, null).status, 'never');
    assert.equal(O.summarizeJob({ id: 'n' }, {}, null).status, 'never');
});

test('summarizeJob: a failed unit with no state file is a failure, not "never run"', () => {
    // The helper can die before it writes state; hiding that would hide a failure.
    const s = O.summarizeJob({ id: 'n' }, null, unit({ service: { failed: true } }));
    assert.equal(s.status, 'failed');
    assert.equal(s.remediation, 'retry');
});

// --- summarizeJob: ok ----------------------------------------------------

test('summarizeJob: a good run reports its duration', () => {
    const s = O.summarizeJob({ id: 'n' }, state({ data_added: undefined }), null);
    assert.equal(s.status, 'ok');
    assert.equal(s.label, 'Succeeded');
    assert.equal(s.detail, 'Completed in 1m 30s.');
    assert.equal(s.remediation, null);
});

test('summarizeJob: a good run reports bytes added when restic told us', () => {
    const s = O.summarizeJob({ id: 'n' }, state({ data_added: 1048576 }), null);
    assert.equal(s.detail, 'Completed in 1m 30s; 1.0 MiB added.');
});

test('summarizeJob: a good run with no timestamps still reads as success', () => {
    const s = O.summarizeJob({ id: 'n' }, { status: 'ok' }, null);
    assert.equal(s.status, 'ok');
    assert.equal(s.detail, 'Completed successfully.');
});

// --- summarizeJob: partial ----------------------------------------------

test('summarizeJob: read errors are amber and say how many files were unreadable', () => {
    const s = O.summarizeJob({ id: 'n' },
        state({ status: 'partial', kind: 'READ_ERRORS', unreadable: 12, exit_code: 3 }), null);
    assert.equal(s.status, 'partial');
    assert.equal(O.statusClass(s.status), 'partial');
    assert.match(s.detail, /^12 files could not be read/);
    assert.match(s.detail, /Everything else was backed up/);
    assert.equal(s.remediation, 'list-unreadable');
});

test('summarizeJob: one unreadable file is singular', () => {
    const s = O.summarizeJob({ id: 'n' },
        state({ status: 'partial', kind: 'READ_ERRORS', unreadable: 1 }), null);
    assert.match(s.detail, /^1 file could not be read/);
});

test('summarizeJob: partial with no count still refuses to call it a failure', () => {
    const s = O.summarizeJob({ id: 'n' }, { status: 'partial', kind: 'READ_ERRORS' }, null);
    assert.equal(s.status, 'partial');
    assert.match(s.detail, /^Some files could not be read/);
});

test('summarizeJob: a failed prune after a good backup is amber, not red', () => {
    // The snapshot exists — only retention did not run.
    const s = O.summarizeJob({ id: 'n' }, state({ status: 'prune-failed', prune_exit_code: 1 }), null);
    assert.equal(s.status, 'partial');
    assert.equal(s.label, 'Backed up, retention failed');
    assert.equal(s.remediation, 'retry');
});

// --- summarizeJob: failed and its remediations ---------------------------

const REMEDIATION_CASES = [
    ['REPO_LOCKED', 'unlock'],
    ['WRONG_PASSWORD', 'reprompt'],
    ['REPO_MISSING', 'init'],
    ['NO_SPACE', 'free-space'],
    ['NETWORK', 'retry'],
    ['GENERIC', 'retry'],
    ['GO_RUNTIME', 'retry'],
    ['UNKNOWN', 'retry']
];

for (const [kind, remediation] of REMEDIATION_CASES) {
    test(`summarizeJob: ${kind} offers the ${remediation} action`, () => {
        const s = O.summarizeJob({ id: 'n' }, state({ status: 'failed', kind, exit_code: 1 }), null);
        assert.equal(s.status, 'failed');
        assert.equal(s.remediation, remediation);
        assert.ok(s.detail.length > 0);
        assert.ok(O.remediationLabel(s.remediation).length > 0);
    });
}

test('summarizeJob: remediations agree with core/errors.js rather than reinventing them', () => {
    for (const kind of Object.keys(Errors.REMEDIATION)) {
        if (kind === 'READ_ERRORS' || kind === 'CANCELLED') continue;
        const s = O.summarizeJob({ id: 'n' }, { status: 'failed', kind }, null);
        assert.equal(s.remediation, Errors.REMEDIATION[kind], kind);
    }
});

test('summarizeJob: a cancelled run is neutral, never red', () => {
    // Design decision from the spec: CANCELLED (130) is a state, not an error.
    const s = O.summarizeJob({ id: 'n' }, state({ status: 'failed', kind: 'CANCELLED', exit_code: 130 }), null);
    assert.equal(s.status, 'cancelled');
    assert.equal(s.remediation, null);
    assert.equal(O.statusClass(s.status), '');
});

test('summarizeJob: an unrecognised status is never treated as success', () => {
    const s = O.summarizeJob({ id: 'n' }, { status: 'sortof-fine' }, null);
    assert.equal(s.status, 'failed');
    assert.match(s.detail, /Unrecognised result "sortof-fine"/);
    assert.equal(s.remediation, 'retry');
});

// --- summarizeJob: running and nextRun -----------------------------------

test('summarizeJob: a running unit outranks the stale state file', () => {
    const s = O.summarizeJob({ id: 'n' },
        state({ status: 'failed', kind: 'GENERIC' }),
        unit({ service: { active: true } }));
    assert.equal(s.status, 'running');
    assert.equal(s.remediation, null);
    assert.equal(O.statusClass(s.status), 'running');
});

test('summarizeJob: nextRun comes from the timer and survives every status', () => {
    const u = unit({ timer: { nextElapseMs: NOW + 7200000 } });
    for (const st of [null, state(), state({ status: 'failed', kind: 'GENERIC' })])
        assert.equal(O.summarizeJob({ id: 'n' }, st, u).nextRun, NOW + 7200000);
});

test('summarizeJob: a malformed unit object does not throw', () => {
    for (const u of [{}, { timer: null }, { timer: 'x', service: 7 }, [], 'nope', 0]) {
        const s = O.summarizeJob({ id: 'n' }, null, u);
        assert.equal(s.nextRun, null);
        assert.equal(s.status, 'never');
    }
});

test('summarizeJob: always returns the documented shape', () => {
    const keys = Object.keys(O.summarizeJob({ id: 'n' }, state(), unit())).sort();
    assert.deepEqual(keys, ['detail', 'label', 'nextRun', 'remediation', 'status']);
});

// --- overallStatus -------------------------------------------------------

test('overallStatus: worst wins', () => {
    assert.equal(O.overallStatus([{ status: 'ok' }, { status: 'partial' }]), 'partial');
    assert.equal(O.overallStatus([{ status: 'partial' }, { status: 'failed' }]), 'failed');
    assert.equal(O.overallStatus([{ status: 'failed' }, { status: 'ok' }]), 'failed');
    assert.equal(O.overallStatus([{ status: 'ok' }, { status: 'ok' }]), 'ok');
});

test('overallStatus: never run outranks running and ok, but not partial', () => {
    assert.equal(O.overallStatus([{ status: 'ok' }, { status: 'never' }]), 'never');
    assert.equal(O.overallStatus([{ status: 'running' }, { status: 'never' }]), 'never');
    assert.equal(O.overallStatus([{ status: 'never' }, { status: 'partial' }]), 'partial');
});

test('overallStatus: a cancelled run does not outrank a real problem', () => {
    assert.equal(O.overallStatus([{ status: 'cancelled' }, { status: 'failed' }]), 'failed');
    assert.equal(O.overallStatus([{ status: 'cancelled' }, { status: 'ok' }]), 'cancelled');
});

test('overallStatus: accepts bare status strings too', () => {
    assert.equal(O.overallStatus(['ok', 'failed']), 'failed');
    assert.equal(O.overallStatus(['ok', 'ok']), 'ok');
});

test('overallStatus: nothing known is "never", not "ok"', () => {
    assert.equal(O.overallStatus([]), 'never');
    assert.equal(O.overallStatus(null), 'never');
    assert.equal(O.overallStatus('ok'), 'never');
});

test('overallStatus: an unrecognised status is the worst case, never silently ok', () => {
    assert.equal(O.overallStatus([{ status: 'weird' }, { status: 'ok' }]), 'failed');
    assert.equal(O.overallStatus([null, { status: 'ok' }]), 'failed');
});

// --- status presentation -------------------------------------------------

test('statusClass only ever names classes css/hangar.css defines', () => {
    const allowed = new Set(['', 'ok', 'partial', 'failed', 'running']);
    for (const s of Object.keys(O.RANK)) assert.ok(allowed.has(O.statusClass(s)), s);
    assert.equal(O.statusClass('nonsense'), '');
});

test('every status has a badge class and a human label', () => {
    for (const s of Object.keys(O.RANK)) {
        assert.match(O.statusBadgeClass(s), /^text-bg-/);
        assert.ok(O.statusLabel(s).length > 0);
    }
    assert.equal(O.statusBadgeClass('partial'), 'text-bg-warning');
    assert.equal(O.statusBadgeClass('failed'), 'text-bg-danger');
    assert.equal(O.statusBadgeClass('never'), 'text-bg-secondary');
});

test('every remediation core/errors.js can emit has a button label', () => {
    for (const r of Object.values(Errors.REMEDIATION))
        assert.ok(O.REMEDIATION_LABEL[r], `no label for ${r}`);
});

// --- timestamps ----------------------------------------------------------

test('toMillis: epoch seconds from the python helper become milliseconds', () => {
    assert.equal(O.toMillis(1754049600), 1754049600000);
    assert.equal(O.toMillis(1754049600.75), 1754049600750);
});

test('toMillis: a value already in milliseconds is left alone', () => {
    assert.equal(O.toMillis(1754049600000), 1754049600000);
});

test('toMillis: rejects nonsense rather than inventing a date', () => {
    for (const bad of [null, undefined, 0, -1, NaN, '123', {}])
        assert.equal(O.toMillis(bad), null);
});

test('lastRunMs: prefers the state file, falls back to the timer', () => {
    assert.equal(O.lastRunMs(state(), null), NOW);
    assert.equal(O.lastRunMs(null, unit({ timer: { lastTriggerMs: 1234000 } })), 1234000);
    assert.equal(O.lastRunMs(null, unit()), null);
    assert.equal(O.lastRunMs({ status: 'ok' }, unit({ timer: { lastTriggerMs: 99000 } })), 99000);
});

test('durationSec: only when both ends are known and sane', () => {
    assert.equal(O.durationSec(state()), 90);
    assert.equal(O.durationSec({ started: 10, finished: 5 }), null);
    assert.equal(O.durationSec({ started: 10 }), null);
    assert.equal(O.durationSec(null), null);
});

test('lastRunText and nextRunText phrase the unknown case honestly', () => {
    assert.equal(O.lastRunText(null, NOW), 'never');
    assert.equal(O.nextRunText(null, NOW), 'not scheduled');
    assert.equal(O.lastRunText(NOW - 120000, NOW), '2 minutes ago');
    assert.equal(O.nextRunText(NOW + 7200000, NOW), 'in 2 hours');
});

// --- unreadable files ----------------------------------------------------

test('unreadableList: empty unless the record actually carries paths', () => {
    assert.deepEqual(O.unreadableList(null), []);
    assert.deepEqual(O.unreadableList(state({ unreadable: 3 })), []);
});

test('unreadableList: accepts strings and restic error objects', () => {
    assert.deepEqual(O.unreadableList({ unreadable_files: ['/a', '/b'] }), ['/a', '/b']);
    assert.deepEqual(O.unreadableList({ unreadableFiles: [{ item: '/c' }, { path: '/d' }, {}, ''] }),
        ['/c', '/d']);
});

// --- jobRow --------------------------------------------------------------

test('jobRow: carries the identity, status and both times the row renders', () => {
    const row = O.jobRow({ id: 'nightly', name: 'Nightly', repo: 'nas' },
        state(), unit({ timer: { nextElapseMs: NOW + 3600000 } }), NOW);
    assert.equal(row.id, 'nightly');
    assert.equal(row.name, 'Nightly');
    assert.equal(row.repoId, 'nas');
    assert.equal(row.status, 'ok');
    assert.equal(row.lastRunText, 'just now');
    assert.equal(row.nextRunText, 'in 1 hour');
    assert.equal(row.snapshot, 'abc1234');
    assert.equal(row.enabled, true);
});

test('jobRow: falls back to the id when a job has no name', () => {
    assert.equal(O.jobRow({ id: 'nightly' }, null, null, NOW).name, 'nightly');
    assert.equal(O.jobRow({ id: 'nightly', name: '   ' }, null, null, NOW).name, 'nightly');
    assert.equal(O.jobRow({}, null, null, NOW).name, 'Unnamed job');
});

test('jobRow: accepts the object form of job.repo', () => {
    assert.equal(O.jobRow({ id: 'n', repo: { id: 'nas' } }, null, null, NOW).repoId, 'nas');
});

test('jobRow: hostile input does not throw', () => {
    for (const j of [null, undefined, 'nope', 42, []]) {
        const row = O.jobRow(j, null, null, NOW);
        assert.equal(row.status, 'never');
        assert.equal(row.name, 'Unnamed job');
    }
});

// --- repository health ---------------------------------------------------

test('repoRow: renders parsed restic stats', () => {
    const row = O.repoRow({ id: 'nas', kind: 'local', path: '/srv/backup' },
        { totalSize: 1073741824, snapshotsCount: 42, totalFileCount: 1000 }, null);
    assert.equal(row.id, 'nas');
    assert.equal(row.sizeText, '1.0 GiB');
    assert.equal(row.snapshots, 42);
    assert.equal(row.error, null);
    assert.match(row.description, /^Local folder at \/srv\/backup/);
});

test('repoRow: an unreachable repository keeps its remediation button', () => {
    const err = Errors.create('REPO_LOCKED', 'Repository is locked by another operation');
    const row = O.repoRow({ id: 'nas', kind: 'local', path: '/srv/b' }, null, err);
    assert.equal(row.size, null);
    assert.equal(row.sizeText, DASH);
    assert.equal(row.snapshots, null);
    assert.equal(row.remediation, 'unlock');
    assert.match(row.errorText, /locked/);
});

test('sumStats: adds up what is known and counts what is not', () => {
    const rows = [
        O.repoRow({ id: 'a' }, { totalSize: 1024, snapshotsCount: 2 }, null),
        O.repoRow({ id: 'b' }, { totalSize: 2048, snapshotsCount: 3 }, null),
        O.repoRow({ id: 'c' }, null, Errors.create('NETWORK', 'unreachable'))
    ];
    const t = O.sumStats(rows);
    assert.equal(t.repos, 3);
    assert.equal(t.size, 3072);
    assert.equal(t.snapshots, 5);
    assert.equal(t.unknown, 1);
    assert.equal(t.errors, 1);
});

test('sumStats: empty and malformed input is zero, not a crash', () => {
    assert.deepEqual(O.sumStats([]), { repos: 0, size: 0, snapshots: 0, unknown: 0, errors: 0 });
    assert.deepEqual(O.sumStats(null), { repos: 0, size: 0, snapshots: 0, unknown: 0, errors: 0 });
    assert.equal(O.sumStats([null, 'x']).repos, 0);
});

// --- the stats command line ----------------------------------------------

test('statsArgv: asks restic for repository size on disk, not restore size', () => {
    const argv = O.statsArgv({ id: 'nas', kind: 'local', path: '/srv/backup' });
    assert.deepEqual(argv, ['restic', '-r', '/srv/backup',
        '--password-file', '/etc/hangar/repos/nas.key',
        '--cache-dir', '/var/cache/hangar/restic', '--json', 'stats',
        '--mode', 'raw-data']);
});

test('statsArgv: the password never becomes an argument', () => {
    const argv = O.statsArgv({ id: 'nas', kind: 'sftp', host: 'nas.local', path: '/backup' });
    assert.ok(argv.includes('--password-file'));
    assert.ok(argv.includes('sftp:nas.local:/backup'));
    assert.ok(!argv.some((a) => /hunter2|password=/.test(a)));
});

test('statsArgv: an invalid repository id is rejected, never interpolated', () => {
    assert.throws(() => O.statsArgv({ id: '../etc/shadow', kind: 'local', path: '/srv' }));
});

test('environList: backend credentials become a sorted environ array', () => {
    const env = O.environList({
        kind: 's3', id: 'off', endpoint: 's3.eu-west-1.amazonaws.com', bucket: 'b',
        accessKeyId: 'AKIA', secretAccessKey: 'shh'
    });
    assert.ok(Array.isArray(env));
    assert.deepEqual(env.slice().sort(), env, 'environ must be deterministic');
    assert.ok(env.every((e) => e.includes('=')));
});

// --- the component -------------------------------------------------------

function fakeDeps(over) {
    const o = over || {};
    return Object.assign({
        errors: Errors,
        config: {
            listJobs: async () => ['nightly'],
            listRepos: async () => ['nas'],
            readJob: async () => ({ id: 'nightly', name: 'Nightly', repo: 'nas' }),
            readState: async () => state(),
            readRepo: async () => ({ id: 'nas', kind: 'local', path: '/srv/backup' })
        },
        schedule: {
            unitState: async () => unit(),
            runNow: async () => true
        },
        restic: require('../../js/engine/restic.js'),
        repos: require('../../js/core/repos.js'),
        secrets: require('../../js/core/secrets.js'),
        dialogs: { passwordDialog: async () => 'hunter2' }
    }, o);
}

function component(over) {
    const c = O.hangarOverview(fakeDeps(over));
    // No cockpit under node, so repository stats are never fetched; the screen must
    // still render everything else.
    c.fetchStats = async () => ({ totalSize: 2048, snapshotsCount: 7, totalFileCount: 9 });
    return c;
}

test('component constructs with no DOM, no cockpit and no core globals', () => {
    const c = O.hangarOverview();
    assert.equal(c.loading, true);
    assert.deepEqual(c.jobs, []);
    assert.equal(c.overall, 'never');
    assert.equal(c.hasCockpit(), false);
});

test('refresh loads jobs, repositories, totals and the overall status', async () => {
    const c = component();
    await c.refresh();
    await c.sizesDone;
    assert.equal(c.loading, false);
    assert.equal(c.error, null);
    assert.equal(c.jobs.length, 1);
    assert.equal(c.jobs[0].status, 'ok');
    assert.equal(c.repos.length, 1);
    // Sizes arrive after the screen does, so the totals are filled by the size
    // pass rather than by refresh itself.
    await c.fillRepoSizes();
    assert.equal(c.totals.snapshots, 7);
    assert.equal(c.overall, 'ok');
    assert.equal(c.isEmpty(), false);
});

test('nothing configured shows the empty state that leads to a repository', async () => {
    const c = component({ config: Object.assign(fakeDeps().config, {
        listJobs: async () => [], listRepos: async () => []
    }) });
    await c.refresh();
    await c.sizesDone;
    assert.equal(c.isEmpty(), true);
    assert.equal(c.needsJob(), false);
    assert.equal(c.overall, 'never');
});

test('a repository with no job asks for a job, not for another repository', async () => {
    const c = component({ config: Object.assign(fakeDeps().config, { listJobs: async () => [] }) });
    await c.refresh();
    await c.sizesDone;
    assert.equal(c.isEmpty(), false);
    assert.equal(c.needsJob(), true);
});

test('an unreadable job file is a warning beside the rows we did get', async () => {
    // READ_ERRORS thinking applied to config: a partial listing is not a failure.
    const cfg = fakeDeps().config;
    const c = component({ config: Object.assign({}, cfg, {
        listJobs: async () => ['nightly', 'broken'],
        readJob: async (id) => {
            if (id === 'broken') throw Errors.create('GENERIC', 'permission denied');
            return { id: 'nightly', repo: 'nas' };
        }
    }) });
    await c.refresh();
    await c.sizesDone;
    assert.equal(c.error, null, 'a partial listing must not blank the screen');
    assert.equal(c.jobs.length, 1);
    assert.equal(c.warnings.length, 1);
    assert.equal(c.warnings[0].path, 'broken');
});

test('a missing systemd answer still renders the last recorded run', async () => {
    const c = component({ schedule: {
        unitState: async () => { throw Errors.create('GENERIC', 'systemd D-Bus is not available'); },
        runNow: async () => true
    } });
    await c.refresh();
    await c.sizesDone;
    assert.equal(c.error, null);
    assert.equal(c.jobs[0].status, 'ok');
    assert.equal(c.jobs[0].nextRunText, 'not scheduled');
});

test('a failure listing jobs surfaces as a screen error with a retry', async () => {
    const c = component({ config: Object.assign(fakeDeps().config, {
        listJobs: async () => { throw Errors.create('GENERIC', 'nope'); }
    }) });
    await c.refresh();
    await c.sizesDone;
    assert.equal(c.loading, false);
    assert.ok(c.error);
    assert.equal(c.errorText(c.error), 'nope');
});

test('a repository whose stats fail keeps the rest of the screen alive', async () => {
    const c = component();
    c.fetchStats = async () => { throw Errors.create('REPO_LOCKED', 'locked'); };
    await c.refresh();
    await c.sizesDone;
    assert.equal(c.error, null);
    assert.equal(c.repos[0].remediation, 'unlock');
    assert.equal(c.totals.errors, 1);
    assert.equal(c.repos[0].sizeText, DASH);
});

test('Back up now starts the service and refreshes', async () => {
    const started = [];
    const c = component({ schedule: {
        unitState: async () => unit(),
        runNow: async (id) => { started.push(id); }
    } });
    await c.refresh();
    await c.sizesDone;
    await c.backupNow(c.jobs[0]);
    assert.deepEqual(started, ['nightly']);
    assert.equal(c.isBusy('nightly'), false, 'the button must be re-enabled afterwards');
    assert.equal(c.actionError, null);
});

test('a failed Back up now reports the error and clears the busy flag', async () => {
    const c = component({ schedule: {
        unitState: async () => unit(),
        runNow: async () => { throw Errors.create('GENERIC', 'unit not found'); }
    } });
    await c.refresh();
    await c.sizesDone;
    await c.backupNow(c.jobs[0]);
    assert.equal(c.errorText(c.actionError), 'unit not found');
    assert.equal(c.isBusy('nightly'), false);
});

test('the unlock remediation runs restic unlock against the job\'s repository', async () => {
    const calls = [];
    const c = component({ restic: Object.assign({}, require('../../js/engine/restic.js'), {
        run: async (op, opts) => { calls.push([op, opts.repoUrl, opts.passwordFile]); }
    }) });
    await c.refresh();
    await c.sizesDone;
    await c.remediate({ id: 'nightly', repoId: 'nas', remediation: 'unlock' });
    assert.deepEqual(calls, [['unlock', '/srv/backup', '/etc/hangar/repos/nas.key']]);
    assert.equal(c.actionError, null);
});

test('the init remediation initialises the repository', async () => {
    const ops = [];
    const c = component({ restic: Object.assign({}, require('../../js/engine/restic.js'), {
        run: async (op) => { ops.push(op); }
    }) });
    await c.remediate({ id: 'nightly', repoId: 'nas', remediation: 'init' });
    assert.deepEqual(ops, ['init']);
});

test('a remediation against a repository that no longer exists is reported, not thrown', async () => {
    const c = component({ config: Object.assign(fakeDeps().config, { readRepo: async () => null }) });
    await c.remediate({ id: 'nightly', repoId: 'gone', remediation: 'unlock' });
    assert.match(c.errorText(c.actionError), /does not exist/);
});

test('the reprompt remediation stores the new password through core/secrets.js', async () => {
    const written = [];
    const c = component({
        secrets: Object.assign({}, require('../../js/core/secrets.js'), {
            writeKey: async (id, pw) => { written.push([id, pw]); }
        })
    });
    await c.remediate({ id: 'nightly', repoId: 'nas', remediation: 'reprompt' });
    assert.deepEqual(written, [['nas', 'hunter2']]);
});

test('a cancelled password prompt writes nothing', async () => {
    const written = [];
    const c = component({
        dialogs: { passwordDialog: async () => '' },
        secrets: Object.assign({}, require('../../js/core/secrets.js'), {
            writeKey: async (id, pw) => { written.push([id, pw]); }
        })
    });
    await c.remediate({ id: 'nightly', repoId: 'nas', remediation: 'reprompt' });
    assert.deepEqual(written, []);
});

test('list-unreadable and free-space expand in place instead of running anything', async () => {
    const c = component({ schedule: {
        unitState: async () => unit(),
        runNow: async () => { throw new Error('must not run a backup'); }
    } });
    await c.remediate({ id: 'nightly', remediation: 'list-unreadable' });
    assert.equal(c.expanded, 'nightly');
    await c.remediate({ id: 'nightly', remediation: 'list-unreadable' });
    assert.equal(c.expanded, null, 'toggles closed again');
    await c.remediate({ id: 'nightly', remediation: 'free-space' });
    assert.equal(c.expanded, 'nightly');
});

test('an unknown remediation falls back to trying the backup again', async () => {
    const started = [];
    const c = component({ schedule: {
        unitState: async () => unit(),
        runNow: async (id) => { started.push(id); }
    } });
    await c.remediate({ id: 'nightly', remediation: 'retry' });
    assert.deepEqual(started, ['nightly']);
});

test('setBusy is idempotent in both directions', () => {
    const c = component();
    c.setBusy('a', true);
    c.setBusy('a', true);
    assert.deepEqual(c.busyIds, ['a']);
    c.setBusy('a', false);
    c.setBusy('a', false);
    assert.deepEqual(c.busyIds, []);
});

test('startFirstRepo is a no-op without a browser rather than a crash', () => {
    const c = component();
    const hadDispatch = typeof globalThis.dispatchEvent === 'function' &&
        typeof globalThis.CustomEvent === 'function';
    const fired = [];
    if (!hadDispatch) {
        globalThis.CustomEvent = function (name, opts) { this.type = name; this.detail = opts && opts.detail; };
        globalThis.dispatchEvent = (ev) => { fired.push(ev.type); return true; };
    }
    try {
        assert.equal(c.startFirstRepo(), true);
        if (!hadDispatch) assert.deepEqual(fired, ['hangar:new-repo']);
    } finally {
        if (!hadDispatch) { delete globalThis.CustomEvent; delete globalThis.dispatchEvent; }
    }
});

// --- mounting ------------------------------------------------------------

test('mount injects the template once and only once', () => {
    const attrs = {};
    const host = {
        innerHTML: '',
        getAttribute: (k) => attrs[k] || null,
        setAttribute: (k, v) => { attrs[k] = v; }
    };
    const doc = { getElementById: (id) => (id === 'hangar-overview' ? host : null) };

    assert.equal(O.mount(doc), true);
    assert.ok(host.innerHTML.includes('x-data="hangarOverview()"'));
    assert.ok(host.innerHTML.includes('Back up now'));

    host.innerHTML = 'untouched';
    assert.equal(O.mount(doc), false, 'a second mount must not clobber the live DOM');
    assert.equal(host.innerHTML, 'untouched');
});

test('mount does nothing without a document or a container', () => {
    assert.equal(O.mount(null), false);
    assert.equal(O.mount({}), false);
    assert.equal(O.mount({ getElementById: () => null }), false);
});

test('the template uses real buttons and labels its icon-only status dot', () => {
    assert.ok(!/<a [^>]*@click/.test(O.TEMPLATE), 'clickable anchors are not buttons');
    assert.ok(O.TEMPLATE.includes('type="button"'));
    assert.ok(/hangar-dot[^>]*aria-hidden="true"/.test(O.TEMPLATE) ||
        /aria-hidden="true"/.test(O.TEMPLATE));
    assert.ok(O.TEMPLATE.includes(':aria-label='));
});

// =========================================================================
// Adversarial hardening. Everything below attacks the screen rather than
// demonstrating it: prototype-shaped keys arriving from a JSON file on disk,
// core modules that reject, config that is the wrong type entirely, and the
// design rule that a partial result is amber and enumerated, never red.
// =========================================================================

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const MODULE = require.resolve('../../js/features/overview.js');

// Keys that resolve to something truthy on every object literal.
const PROTO_KEYS = ['__proto__', 'toString', 'constructor', 'valueOf',
    'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable'];

// --- prototype-shaped keys ----------------------------------------------

test('status lookups never hand the template a prototype member', () => {
    // `status` and `kind` are read straight out of a JSON file, and JSON.parse
    // will happily produce {"kind":"toString"}. A bare TABLE[key] returns a
    // function there, and x-text renders its source.
    for (const k of PROTO_KEYS) {
        assert.equal(typeof O.statusClass(k), 'string', k);
        assert.equal(O.statusClass(k), '', k);
        assert.equal(O.statusBadgeClass(k), 'text-bg-secondary', k);
        assert.equal(typeof O.statusLabel(k), 'string', k);
        assert.equal(O.statusLabel(k), O.LABEL.never, k);
        assert.equal(O.remediationLabel(k), 'Fix', k);
    }
});

test('an error kind of "toString" produces a sentence, not a function', () => {
    for (const kind of PROTO_KEYS) {
        const s = O.summarizeJob({ id: 'n' }, { status: 'failed', kind }, null);
        assert.equal(s.status, 'failed');
        assert.equal(typeof s.detail, 'string', kind);
        assert.ok(s.detail.length > 0, kind);
        // The remediation must stay inside the closed set errors.js defines.
        assert.ok(s.remediation === null || typeof s.remediation === 'string', kind);
        assert.ok(O.REMEDIATION_LABEL[s.remediation], `${kind} produced ${String(s.remediation)}`);
    }
});

test('normRemediation admits only the remediations errors.js can emit', () => {
    for (const r of Object.values(Errors.REMEDIATION)) assert.equal(O.normRemediation(r), r);
    for (const bad of PROTO_KEYS.concat([null, undefined, 0, 42, {}, [], 'unlock ', 'UNLOCK', '']))
        assert.equal(O.normRemediation(bad), null, String(bad));
});

test('overallStatus treats a prototype-shaped status as the worst case', () => {
    for (const k of PROTO_KEYS)
        assert.equal(O.overallStatus([{ status: k }, { status: 'ok' }]), 'failed', k);
});

// --- hostile input to the formatters ------------------------------------

test('formatBytes: hostile numeric edges', () => {
    assert.equal(O.formatBytes(-0), '0 B', 'negative zero is still zero bytes');
    assert.equal(O.formatBytes(Number.MIN_VALUE), '0 B');
    assert.equal(O.formatBytes(0.4), '0 B');
    assert.equal(O.formatBytes(1023.6), '1024 B');
    assert.match(O.formatBytes(Number.MAX_VALUE), / EiB$/);
    assert.equal(O.formatBytes(-Infinity), DASH);
    assert.equal(O.formatBytes(Number.MIN_SAFE_INTEGER), DASH);
    assert.equal(O.formatBytes(Symbol('x')), DASH);
    assert.equal(O.formatBytes(() => 1), DASH);
    assert.equal(O.formatBytes(true), DASH);
    assert.equal(O.formatBytes(new Date()), DASH);
});

test('formatDuration: hostile numeric edges', () => {
    assert.equal(O.formatDuration(-0), '0s');
    assert.equal(O.formatDuration(59.999), '59s');
    assert.match(O.formatDuration(Number.MAX_SAFE_INTEGER), /^\d+d( \d+h)?$/);
    assert.equal(O.formatDuration(-Infinity), DASH);
    assert.equal(O.formatDuration(Symbol('x')), DASH);
    assert.equal(O.formatDuration({ valueOf: () => 60 }), DASH, 'only real numbers count');
    assert.equal(O.formatDuration(true), DASH);
});

test('toMillis: hostile input never invents a date', () => {
    for (const bad of [Infinity, -Infinity, true, false, [], [1], Symbol('x'), () => 1, new Date()])
        assert.equal(O.toMillis(bad), null, String(bad));
    // Exactly on the seconds/milliseconds discriminator.
    assert.equal(O.toMillis(1e12), 1e15);
    assert.equal(O.toMillis(1e12 + 1), 1e12 + 1);
});

// --- hostile state records ----------------------------------------------

test('summarizeJob: a status carrying quotes and newlines is reported verbatim, not executed', () => {
    const nasty = 'ok"; DROP TABLE\n<script>alert(1)</script>';
    const s = O.summarizeJob({ id: 'n' }, { status: nasty }, null);
    assert.equal(s.status, 'failed');
    assert.ok(s.detail.includes(nasty), 'the raw text is shown so the operator can act on it');
    // The template renders it with x-text, so the markup above is inert. Prove
    // the screen has no interpolating sink at all.
    assert.ok(!/x-html/.test(O.TEMPLATE), 'x-html would make the string above a real script tag');
});

test('summarizeJob: a status with no string conversion does not blank the screen', () => {
    const hostile = Object.create(null);
    hostile.oops = 1;
    const s = O.summarizeJob({ id: 'n' }, { status: hostile }, null);
    assert.equal(s.status, 'failed');
    assert.equal(typeof s.detail, 'string');
});

test('summarizeJob: unicode and enormous values in a state record', () => {
    const s = O.summarizeJob({ id: 'n' },
        { status: 'ok', started: 0, finished: 1e15, data_added: 1e30 }, null);
    assert.equal(s.status, 'ok');
    assert.equal(typeof s.detail, 'string');
    const u = O.summarizeJob({ id: 'n' }, { status: '备份失败 🔥' }, null);
    assert.equal(u.status, 'failed');
    assert.ok(u.detail.includes('备份失败 🔥'));
});

test('summarizeJob: a partial run with no count falls back to the recorded paths', () => {
    const s = O.summarizeJob({ id: 'n' },
        { status: 'partial', kind: 'READ_ERRORS', unreadable_files: ['/a', '/b', '/a'] }, null);
    // Deduplicated: restic reports one error per failed operation, so the same
    // path arrives twice when both its stat and its read failed.
    assert.match(s.detail, /^2 files could not be read/);
});

// --- unreadableList ------------------------------------------------------

test('unreadableList: deduplicates, because the template keys its list on the path', () => {
    assert.deepEqual(O.unreadableList({ unreadable_files: ['/a', '/a', '/b', '/a'] }), ['/a', '/b']);
    assert.deepEqual(O.unreadableList({ unreadable_files: [{ item: '/a' }, '/a'] }), ['/a']);
});

test('unreadableList: hostile entries are dropped, not rendered as "undefined"', () => {
    const out = O.unreadableList({ unreadable_files: [
        null, undefined, 0, false, [], '   ', { }, { item: null }, { path: '' },
        '/real/path', { message: 'permission denied' }, 42, { item: 7 }
    ] });
    assert.deepEqual(out, ['/real/path', 'permission denied', '7']);
});

test('unreadableList: unicode, quotes and newlines in a path survive intact', () => {
    const weird = '/srv/"quoted"/ümläut/🔥';
    assert.deepEqual(O.unreadableList({ unreadable_files: [weird] }), [weird]);
    // A path with an embedded newline is a real filename on Linux. It must not
    // be split into two list entries.
    assert.deepEqual(O.unreadableList({ unreadable_files: ['/a\nb'] }), ['/a\nb']);
});

test('unreadableList: a non-array field is an empty list, never a crash', () => {
    for (const bad of ['[]', 42, {}, true, { length: 3 }])
        assert.deepEqual(O.unreadableList({ unreadable_files: bad }), [], String(bad));
    for (const bad of [null, undefined, 'x', 7, []])
        assert.deepEqual(O.unreadableList(bad), [], String(bad));
});

test('jobRow: an enormous unreadable list is capped so the tab cannot freeze', () => {
    const many = [];
    for (let i = 0; i < O.MAX_LISTED + 57; i++) many.push('/srv/f' + i);
    const row = O.jobRow({ id: 'n' },
        { status: 'partial', kind: 'READ_ERRORS', unreadable_files: many }, null, NOW);
    assert.equal(row.unreadableFiles.length, O.MAX_LISTED);
    assert.equal(row.unreadableMore, 57);
    assert.equal(row.unreadable, many.length);
});

// --- expansionFor: the panel behind list-unreadable / free-space ---------

test('expansionFor: free-space never claims files were unreadable', () => {
    // NO_SPACE and READ_ERRORS share one expand-in-place panel. A disk-full row
    // has no unreadable files, and "0 file(s) were unreadable" under it is a
    // false statement about the backup.
    const e = O.expansionFor({ id: 'n', remediation: 'free-space', unreadable: 0, unreadableFiles: [] });
    assert.equal(e.kind, 'space');
    assert.deepEqual(e.files, []);
    assert.match(e.text, /out of space/);
    assert.ok(!/unreadable/i.test(e.text));
});

test('expansionFor: read errors list the paths when the helper recorded them', () => {
    const e = O.expansionFor({ remediation: 'list-unreadable', unreadable: 2,
        unreadableFiles: ['/a', '/b'], unreadableMore: 0 });
    assert.equal(e.kind, 'files');
    assert.deepEqual(e.files, ['/a', '/b']);
    assert.equal(e.more, 0);
});

test('expansionFor: no recorded paths falls back to the count and says where they are', () => {
    const e = O.expansionFor({ remediation: 'list-unreadable', unreadable: 12, unreadableFiles: [] });
    assert.equal(e.kind, 'count');
    assert.match(e.text, /^12 files could not be read/);
    assert.match(e.text, /journal/);
    assert.match(O.expansionFor({ unreadable: 1, unreadableFiles: [] }).text, /^1 file /);
});

test('expansionFor: hostile input still returns a renderable shape', () => {
    for (const bad of [null, undefined, 'x', 7, [], { unreadableFiles: 'nope', unreadable: NaN }]) {
        const e = O.expansionFor(bad);
        assert.ok(['files', 'count', 'space'].includes(e.kind), String(bad));
        assert.ok(Array.isArray(e.files));
        assert.equal(typeof e.text, 'string');
    }
});

// --- redaction on the failure path --------------------------------------

test('a repository password never reaches the screen through an error message', () => {
    // restic echoes the repository URL in its errors, and a rest:/sftp: URL can
    // carry userinfo. secrets.js owns the masking rules; the UI must use them.
    const e = Errors.create('NETWORK', 'Fatal: unable to open repository at ' +
        'rest:https://bob:hunter2@backup.example/repo');
    assert.ok(!O.errorMessage(e).includes('hunter2'));
    assert.match(O.errorMessage(e), /backup\.example/, 'the host is diagnostic, not secret');
});

test('errorMessage: masks an inline secret assignment and survives hostile values', () => {
    assert.ok(!O.errorMessage(new Error('restic: password=hunter2 rejected')).includes('hunter2'));
    assert.equal(O.errorMessage(null), '');
    assert.equal(O.errorMessage(undefined), '');
    assert.equal(O.errorMessage('plain string failure'), 'plain string failure');
    const hostile = Object.create(null);
    assert.equal(typeof O.errorMessage(hostile), 'string', 'a null-prototype error must not throw');
    assert.equal(typeof O.errorMessage({ get message() { throw new Error('boom'); } }), 'string');
});

test('repoRow redacts the error it renders', () => {
    const err = Errors.create('NETWORK', 'dial sftp://root:s3cret@nas.local:22: no route to host');
    const row = O.repoRow({ id: 'nas', kind: 'sftp', host: 'nas.local', path: '/b' }, null, err);
    assert.ok(!row.errorText.includes('s3cret'));
    assert.match(row.errorText, /no route to host/);
});

// --- READ_ERRORS is a warning, never a failure (design rule) -------------

test('READ_ERRORS on a repository renders amber with its remediation, never red', () => {
    const err = Errors.create('READ_ERRORS', 'Snapshot was written, but some files could not be read');
    const row = O.repoRow({ id: 'nas', kind: 'local', path: '/srv/b' }, null, err);
    assert.equal(row.fatal, false, 'a non-fatal outcome must not be styled as a broken repository');
    assert.equal(row.remediation, 'list-unreadable');
    assert.ok(O.TEMPLATE.includes('r.fatal ? \'text-danger\' : \'text-warning-emphasis\''),
        'the template must branch on fatal rather than painting every error red');
});

test('a fatal repository error keeps the red styling and its own button', () => {
    const row = O.repoRow({ id: 'nas', kind: 'local', path: '/srv/b' }, null,
        Errors.create('REPO_MISSING', 'Repository does not exist'));
    assert.equal(row.fatal, true);
    assert.equal(row.remediation, 'init');
});

test('a repository error with no remediation offers no button rather than a wrong one', () => {
    const row = O.repoRow({ id: 'nas' }, null, Errors.create('GO_RUNTIME', 'restic crashed'));
    assert.equal(row.remediation, null);
    assert.equal(row.fatal, true);
});

test('repoRow: an untyped throw is still rendered, with no invented remediation', () => {
    const row = O.repoRow({ id: 'nas' }, null, new TypeError('x is not a function'));
    assert.equal(row.remediation, null);
    assert.equal(row.fatal, true, 'an unknown failure is fatal by default');
    assert.match(row.errorText, /not a function/);
});

// --- statsArgv and environList under hostile input ----------------------

// assert.throws() does not hand back the error, and the kind is the whole point.
function caught(fn) {
    try { fn(); } catch (e) { return e; }
    return null;
}

test('statsArgv: a core module that did not load is a typed error, not a TypeError', () => {
    // In the browser these come from globals set by index.html; a script that
    // failed to load leaves the module object missing its functions.
    const e = caught(() => O.statsArgv({ id: 'nas', kind: 'local', path: '/srv' },
        { repos: {}, secrets: {}, restic: {} }));
    assert.ok(e, 'a half-loaded page must fail loudly rather than build a wrong argv');
    assert.equal(e.kind, 'GENERIC');
    assert.notEqual(e.name, 'TypeError');
    assert.match(e.message, /core module/);
});

test('statsArgv: a repository with no usable URL throws a typed error', () => {
    for (const repo of [null, undefined, {}, { id: 'nas' }, { id: 'nas', kind: 'nope' },
        { id: 'nas', kind: 's3' }, { id: 'nas', kind: 'local' }]) {
        const e = caught(() => O.statsArgv(repo));
        assert.ok(e, JSON.stringify(repo));
        assert.equal(typeof e.message, 'string');
        assert.notEqual(e.name, 'TypeError', JSON.stringify(repo));
    }
});

test('environList: hostile repositories produce an empty environ, never a crash', () => {
    for (const bad of [null, undefined, 'x', 7, [], { kind: 'local' }, { kind: '__proto__' }])
        assert.deepEqual(O.environList(bad), [], String(bad));
});

test('idList: only usable ids survive', () => {
    assert.deepEqual(O.idList(['a', '', 'b', null, 7, {}, 'c']), ['a', 'b', 'c']);
    for (const bad of [null, undefined, 'abc', 7, {}]) assert.deepEqual(O.idList(bad), []);
});

// --- the component: every core call that can reject ---------------------

test('a failure listing repositories keeps the jobs that did load', async () => {
    const c = component({ config: Object.assign(fakeDeps().config, {
        listRepos: async () => { throw Errors.create('GENERIC', 'ls: permission denied'); }
    }) });
    await c.refresh();
    await c.sizesDone;
    assert.equal(c.jobs.length, 1, 'the jobs we read must not vanish because repos failed');
    assert.equal(c.repos.length, 0);
    assert.ok(c.error);
    assert.equal(c.loading, false);
});

test('a screen-level failure does not masquerade as "nothing configured yet"', async () => {
    const c = component({ config: Object.assign(fakeDeps().config, {
        listJobs: async () => { throw Errors.create('GENERIC', 'nope'); }
    }) });
    await c.refresh();
    await c.sizesDone;
    assert.equal(c.isEmpty(), false, '"No backups yet" would be a lie here');
    assert.ok(O.TEMPLATE.includes('@click="refresh()"'), 'the screen error offers a retry');
});

test('listJobs answering something that is not a list does not crash the screen', async () => {
    for (const bad of [null, undefined, 'nightly', 42, { 0: 'a' }]) {
        const c = component({ config: Object.assign(fakeDeps().config, {
            listJobs: async () => bad, listRepos: async () => bad
        }) });
        await c.refresh();
    await c.sizesDone;
        assert.equal(c.error, null, String(bad));
        assert.deepEqual(c.jobs, []);
    }
});

test('a job file holding a JSON scalar is a warning, not a broken row', async () => {
    const c = component({ config: Object.assign(fakeDeps().config, {
        listJobs: async () => ['nightly', 'weird'],
        readJob: async (id) => (id === 'weird' ? 'not-an-object' : { id: 'nightly', repo: 'nas' })
    }) });
    await c.refresh();
    await c.sizesDone;
    assert.equal(c.error, null);
    assert.equal(c.jobs.length, 1);
    assert.equal(c.warnings.length, 1);
    assert.equal(c.warnings[0].path, 'weird');
});

test('a repository file holding a JSON array is a warning, not a thrown TypeError', async () => {
    // Assigning the id onto a primitive throws under 'use strict', which used to
    // take the whole screen down instead of reporting one bad file.
    for (const bad of ['a string', 42, [], null]) {
        const c = component({ config: Object.assign(fakeDeps().config, {
            readRepo: async () => bad
        }) });
        await c.refresh();
    await c.sizesDone;
        assert.equal(c.error, null, JSON.stringify(bad));
        assert.equal(c.repos.length, 0);
        assert.equal(c.warnings.length, 1);
        assert.equal(c.warnings[0].path, 'nas');
    }
});

test('a job and a repository sharing an id produce two distinct warnings', async () => {
    // The template keys its warning list; two entries keyed on the bare id would
    // collide and one of the two unreadable files would silently disappear.
    const c = component({ config: Object.assign(fakeDeps().config, {
        listJobs: async () => ['nas'],
        listRepos: async () => ['nas'],
        readJob: async () => { throw Errors.create('GENERIC', 'denied'); },
        readRepo: async () => { throw Errors.create('GENERIC', 'denied'); }
    }) });
    await c.refresh();
    await c.sizesDone;
    assert.equal(c.warnings.length, 2);
    assert.notEqual(c.warnings[0].key, c.warnings[1].key);
    assert.equal(new Set(c.warnings.map((w) => w.key)).size, 2);
});

test('the filename is the job identity, not the "id" field inside the file', async () => {
    // systemd is addressed by the filename, so a file claiming another id would
    // point "Back up now" at a different job's unit.
    const started = [];
    const asked = [];
    const c = component({
        config: Object.assign(fakeDeps().config, {
            readJob: async () => ({ id: 'someone-else', name: 'Nightly', repo: 'nas' })
        }),
        schedule: {
            unitState: async (id) => { asked.push(id); return unit(); },
            runNow: async (id) => { started.push(id); }
        }
    });
    await c.refresh();
    await c.sizesDone;
    assert.deepEqual(asked, ['nightly']);
    assert.equal(c.jobs[0].id, 'nightly');
    await c.backupNow(c.jobs[0]);
    assert.deepEqual(started, ['nightly']);
});

test('a readState that rejects still leaves a renderable row', async () => {
    const c = component({ config: Object.assign(fakeDeps().config, {
        readState: async () => { throw Errors.create('GENERIC', '/var/lib is not readable'); }
    }) });
    await c.refresh();
    await c.sizesDone;
    assert.equal(c.error, null);
    assert.equal(c.jobs.length, 1);
    assert.equal(c.jobs[0].status, 'never');
});

test('a state file that is not an object is treated as no state at all', async () => {
    const c = component({ config: Object.assign(fakeDeps().config, {
        readState: async () => 'corrupt'
    }) });
    await c.refresh();
    await c.sizesDone;
    assert.equal(c.jobs[0].status, 'never');
});

// --- READ_ERRORS end to end through the component ------------------------

test('a partial run renders as a warning listing the unreadable files, never as a failure', async () => {
    // The design rule, asserted end to end: restic exit 3 wrote the snapshot.
    const c = component({ config: Object.assign(fakeDeps().config, {
        readState: async () => state({
            status: 'partial', kind: 'READ_ERRORS', exit_code: 3, unreadable: 2,
            unreadable_files: ['/home/ann/.gvfs', '/proc/1/mem']
        })
    }) });
    await c.refresh();
    await c.sizesDone;

    assert.equal(c.error, null, 'a partial run is not a screen failure');
    assert.equal(c.actionError, null);
    const row = c.jobs[0];
    assert.equal(row.status, 'partial');
    assert.equal(c.overall, 'partial', 'and it must not be promoted to "failed"');
    assert.equal(c.statusBadgeClass(c.overall), 'text-bg-warning');
    assert.notEqual(c.statusBadgeClass(c.overall), 'text-bg-danger');
    assert.equal(c.statusClass(row.status), 'partial');
    assert.match(row.detail, /Everything else was backed up/);
    assert.equal(row.remediation, 'list-unreadable');

    // The files are listed, in the panel that remediation opens.
    await c.remediate(row);
    assert.equal(c.expanded, 'nightly');
    const panel = c.expansionFor(row);
    assert.equal(panel.kind, 'files');
    assert.deepEqual(panel.files, ['/home/ann/.gvfs', '/proc/1/mem']);
    // And nothing was run: expanding is not a retry.
    assert.equal(c.actionError, null);
});

test('a partial run beside a good one keeps the header amber, not green', async () => {
    assert.equal(O.overallStatus([{ status: 'ok' }, { status: 'partial' }, { status: 'ok' }]), 'partial');
    assert.equal(O.statusBadgeClass('partial'), 'text-bg-warning');
    assert.equal(O.statusLabel('partial'), 'Completed with warnings');
});

// --- action errors become buttons ---------------------------------------

test('a failed action surfaces the remediation its kind implies as a button', async () => {
    const c = component({ schedule: {
        unitState: async () => unit(),
        runNow: async () => { throw Errors.create('REPO_LOCKED', 'repository is locked'); }
    } });
    await c.refresh();
    await c.sizesDone;
    await c.backupNow(c.jobs[0]);
    assert.ok(c.actionError);
    assert.equal(c.actionRemediation(), 'unlock');
    assert.equal(c.remediationLabel(c.actionRemediation()), 'Unlock repository');
    assert.ok(O.TEMPLATE.includes('runActionRemediation()'),
        'the action-error alert must render that remediation as a button');
});

test('running the action-error remediation performs it against the right repository', async () => {
    const calls = [];
    const c = component({
        restic: Object.assign({}, require('../../js/engine/restic.js'), {
            run: async (op, opts) => { calls.push([op, opts.repoUrl]); }
        }),
        schedule: {
            unitState: async () => unit(),
            runNow: async () => { throw Errors.create('REPO_LOCKED', 'locked'); }
        }
    });
    await c.refresh();
    await c.sizesDone;
    await c.backupNow(c.jobs[0]);
    await c.runActionRemediation();
    assert.deepEqual(calls, [['unlock', '/srv/backup']]);
    assert.equal(c.actionError, null, 'a successful remediation clears the alert');
});

test('an action error with no remediation offers no button rather than a misleading one', async () => {
    const c = component({ schedule: {
        unitState: async () => unit(),
        runNow: async () => { throw Errors.create('GO_RUNTIME', 'restic crashed'); }
    } });
    await c.refresh();
    await c.sizesDone;
    await c.backupNow(c.jobs[0]);
    assert.equal(c.actionRemediation(), null);
});

test('the action error can be dismissed', async () => {
    const c = component({ schedule: {
        unitState: async () => unit(),
        runNow: async () => { throw Errors.create('GENERIC', 'nope'); }
    } });
    await c.refresh();
    await c.sizesDone;
    await c.backupNow(c.jobs[0]);
    assert.ok(c.actionError);
    c.clearAction();
    assert.equal(c.actionError, null);
    assert.equal(c.actionRow, null);
    assert.ok(/class="btn-close"[\s\S]*?aria-label=/.test(O.TEMPLATE),
        'the dismiss control is icon-only and must be labelled');
});

// --- repository rows get their remediation as a real button -------------

test('a locked repository offers Unlock, and it runs restic unlock', async () => {
    const calls = [];
    const c = O.hangarOverview(fakeDeps({
        restic: Object.assign({}, require('../../js/engine/restic.js'), {
            run: async (op, opts) => { calls.push([op, opts.repoUrl, opts.passwordFile]); }
        })
    }));
    c.fetchStats = async () => { throw Errors.create('REPO_LOCKED', 'locked'); };
    await c.refresh();
    await c.sizesDone;
    assert.equal(c.repos[0].remediation, 'unlock');
    await c.remediateRepo(c.repos[0]);
    assert.deepEqual(calls, [['unlock', '/srv/backup', '/etc/hangar/repos/nas.key']]);
    assert.equal(c.isBusy('nas'), false);
    assert.ok(O.TEMPLATE.includes('remediateRepo(r)'),
        'the repository table must render that remediation as a button');
});

test('a missing repository offers Initialise, and it runs restic init', async () => {
    const ops = [];
    const c = O.hangarOverview(fakeDeps({
        restic: Object.assign({}, require('../../js/engine/restic.js'), {
            run: async (op) => { ops.push(op); }
        })
    }));
    c.fetchStats = async () => { throw Errors.create('REPO_MISSING', 'does not exist'); };
    await c.refresh();
    await c.sizesDone;
    assert.equal(c.repos[0].remediation, 'init');
    await c.remediateRepo(c.repos[0]);
    assert.deepEqual(ops, ['init']);
});

test('a repository with a rejected password re-prompts and stores the new one', async () => {
    const written = [];
    const c = O.hangarOverview(fakeDeps({
        secrets: Object.assign({}, require('../../js/core/secrets.js'), {
            writeKey: async (id, pw) => { written.push([id, pw]); }
        })
    }));
    c.fetchStats = async () => { throw Errors.create('WRONG_PASSWORD', 'wrong password'); };
    await c.refresh();
    await c.sizesDone;
    assert.equal(c.repos[0].remediation, 'reprompt');
    await c.remediateRepo(c.repos[0]);
    assert.deepEqual(written, [['nas', 'hunter2']]);
});

test('a repository remediation with no one-click fix just re-reads its health', async () => {
    let reads = 0;
    const c = O.hangarOverview(fakeDeps());
    c.fetchStats = async () => { reads++; throw Errors.create('GO_RUNTIME', 'crashed'); };
    await c.refresh();
    await c.sizesDone;
    assert.equal(reads, 1);
    await c.remediateRepo(c.repos[0]);
    assert.equal(reads, 2, 'retry means look again, not start a backup');
    assert.equal(c.actionError, null);
});

test('a repository remediation that fails reports it and clears the busy flag', async () => {
    const c = O.hangarOverview(fakeDeps({
        restic: Object.assign({}, require('../../js/engine/restic.js'), {
            run: async () => { throw Errors.create('NETWORK', 'no route to host'); }
        })
    }));
    c.fetchStats = async () => { throw Errors.create('REPO_LOCKED', 'locked'); };
    await c.refresh();
    await c.sizesDone;
    await c.remediateRepo(c.repos[0]);
    assert.match(c.errorText(c.actionError), /no route to host/);
    assert.equal(c.actionRemediation(), 'retry');
    assert.equal(c.isBusy('nas'), false);
});

// --- reprompt failure modes ---------------------------------------------

test('a password prompt that does not exist is reported, not silently ignored', async () => {
    // Before this, clicking "Enter password" with no dialog loaded did nothing
    // at all, which reads to the user as a broken button.
    const c = component({ dialogs: null });
    const saved = globalThis.HangarDialogs;
    delete globalThis.HangarDialogs;
    try {
        await c.remediate({ id: 'nightly', repoId: 'nas', remediation: 'reprompt' });
        assert.ok(c.actionError, 'a dead button must become a stated failure');
        assert.match(c.errorText(c.actionError), /password prompt is not available/);
    } finally {
        if (saved !== undefined) globalThis.HangarDialogs = saved;
    }
});

test('a reprompt whose write rejects is reported and clears the busy flag', async () => {
    const c = component({
        secrets: Object.assign({}, require('../../js/core/secrets.js'), {
            writeKey: async () => { throw Errors.create('GENERIC', 'read-only file system'); }
        })
    });
    await c.remediate({ id: 'nightly', repoId: 'nas', remediation: 'reprompt' });
    assert.match(c.errorText(c.actionError), /read-only file system/);
    assert.equal(c.isBusy('nightly'), false);
});

test('a password dialog that rejects is reported rather than left pending', async () => {
    const c = component({ dialogs: { passwordDialog: async () => { throw new Error('dismissed'); } } });
    await c.remediate({ id: 'nightly', repoId: 'nas', remediation: 'reprompt' });
    assert.match(c.errorText(c.actionError), /dismissed/);
});

test('a remediation on a row that names no repository is a stated failure', async () => {
    for (const r of ['unlock', 'init', 'reprompt']) {
        const c = component();
        await c.remediate({ id: 'nightly', repoId: '', remediation: r });
        assert.ok(c.actionError, r);
        assert.match(c.errorText(c.actionError), /does not name a repository/, r);
        assert.equal(c.isBusy('nightly'), false, r);
    }
});

test('a repository read that rejects during a remediation is reported, not thrown', async () => {
    const c = component({ config: Object.assign(fakeDeps().config, {
        readRepo: async () => { throw Errors.create('GENERIC', '/etc/hangar is not readable'); }
    }) });
    await c.remediate({ id: 'nightly', repoId: 'nas', remediation: 'unlock' });
    assert.match(c.errorText(c.actionError), /not readable/);
    assert.equal(c.isBusy('nightly'), false);
});

test('a repository file that is not an object is refused as "does not exist"', async () => {
    for (const bad of ['x', 42, [], null]) {
        const c = component({ config: Object.assign(fakeDeps().config, { readRepo: async () => bad }) });
        await c.remediate({ id: 'nightly', repoId: 'nas', remediation: 'unlock' });
        assert.match(c.errorText(c.actionError), /does not exist/, JSON.stringify(bad));
    }
});

test('a remediation outside the closed set never dispatches on itself', async () => {
    const started = [];
    const c = component({ schedule: {
        unitState: async () => unit(),
        runNow: async (id) => { started.push(id); }
    } });
    for (const bad of PROTO_KEYS.concat(['drop-tables', '', null])) {
        started.length = 0;
        await c.remediate({ id: 'nightly', repoId: 'nas', remediation: bad });
        assert.deepEqual(started, ['nightly'], `"${String(bad)}" must land on the retry branch`);
    }
});

test('backupNow ignores a row with no id instead of starting an unnamed unit', async () => {
    const started = [];
    const c = component({ schedule: {
        unitState: async () => unit(),
        runNow: async (id) => { started.push(id); }
    } });
    for (const row of [null, undefined, {}, { id: '' }, { id: null }]) await c.backupNow(row);
    assert.deepEqual(started, []);
});

// --- fetchStats error paths ---------------------------------------------

test('fetchStats without cockpit fails typed rather than as a TypeError', async () => {
    const c = O.hangarOverview(fakeDeps());
    await assert.rejects(() => c.fetchStats({ id: 'nas', kind: 'local', path: '/srv' }),
        (e) => { assert.equal(e.kind, 'GENERIC'); assert.notEqual(e.name, 'TypeError'); return true; });
});

test('a malformed repository definition fails per row, not per screen', async () => {
    const c = O.hangarOverview(fakeDeps({ config: Object.assign(fakeDeps().config, {
        readRepo: async () => ({ id: 'nas', kind: 'nonsense' })
    }) }));
    await c.refresh();
    await c.sizesDone;
    assert.equal(c.error, null);
    assert.equal(c.repos.length, 1);
    assert.ok(c.repos[0].error);
    assert.match(c.repos[0].errorText, /Unknown repository kind/);
    assert.equal(c.repos[0].sizeText, DASH);
    assert.equal(c.totals.errors, 1);
});

// --- no DOM, no cockpit --------------------------------------------------

function reloadModule() {
    delete require.cache[MODULE];
    return require(MODULE);
}

test('loading the module never reads the cockpit global', async (t) => {
    const reads = [];
    Object.defineProperty(globalThis, 'cockpit', {
        configurable: true,
        get() { reads.push(1); return { spawn: () => {} }; }
    });
    try {
        const M = reloadModule();
        assert.deepEqual(reads, [], 'cockpit must not be touched at module load time');

        const c = M.hangarOverview();
        M.formatBytes(1024);
        M.formatDuration(90);
        M.summarizeJob({ id: 'n' }, { status: 'ok' }, null);
        M.overallStatus([{ status: 'ok' }]);
        M.jobRow({ id: 'n' }, null, null, NOW);
        M.repoRow({ id: 'n', kind: 'local', path: '/srv' }, null, null);
        M.statsArgv({ id: 'nas', kind: 'local', path: '/srv' });
        M.expansionFor({ unreadable: 0, unreadableFiles: [] });
        assert.deepEqual(reads, [], 'constructing the component and running its pure logic must not either');

        // hasCockpit() is the single guarded reader, and it is only called from
        // inside a method.
        assert.equal(c.hasCockpit(), true);
        assert.ok(reads.length > 0);
    } finally {
        delete globalThis.cockpit;
        reloadModule();
    }
});

test('loading the module defers every DOM touch to alpine:init', () => {
    const listeners = [];
    let lookups = 0;
    Object.defineProperty(globalThis, 'document', {
        configurable: true, writable: true,
        value: {
            addEventListener: (name, fn) => { listeners.push([name, fn]); },
            getElementById: () => { lookups++; return null; }
        }
    });
    try {
        reloadModule();
        assert.deepEqual(listeners.map((l) => l[0]), ['alpine:init']);
        assert.equal(lookups, 0, 'the container must not be looked up before Alpine exists');
        listeners[0][1]();
        assert.equal(lookups, 1, 'and must be looked up when alpine:init fires');
    } finally {
        delete globalThis.document;
        reloadModule();
    }
});

test('the component is fully constructible with every core module absent', () => {
    const c = O.hangarOverview({
        errors: null, config: null, schedule: null, repos: null,
        secrets: null, restic: null, logbook: null, dialogs: null
    });
    assert.equal(c.loading, true);
    assert.equal(c.isBusy('x'), false);
    assert.equal(c.overallText(), 'Not run yet');
    assert.equal(c.errorText(null), '');
    assert.equal(c.errorRemediation(new Error('x')), null);
    assert.equal(c.actionRemediation(), null);
    assert.equal(typeof c.totalSizeText(), 'string');
});

test('a core module that is present but broken is reported, not thrown out of refresh', async () => {
    const c = O.hangarOverview(fakeDeps({ config: { listJobs: 'not a function' } }));
    await c.refresh();
    await c.sizesDone;
    assert.equal(c.loading, false, 'the spinner must not be left running');
    assert.ok(c.error);
    assert.deepEqual(c.jobs, []);
    assert.deepEqual(c.repos, []);
});

test('a broken scheduler is reported on the row, not thrown out of the click handler', async () => {
    const c = component({ schedule: { unitState: async () => unit() } });
    await c.refresh();
    await c.sizesDone;
    await c.backupNow({ id: 'nightly' });
    assert.ok(c.actionError);
    assert.equal(c.isBusy('nightly'), false, 'the button must be usable again');
});

// --- naming and accessibility -------------------------------------------

test('nothing in this screen or its tests says Time Mach' + 'ine', () => {
    const banned = new RegExp('time' + '\\s*' + 'machine', 'i');
    for (const rel of ['js/features/overview.js', 'tests/unit/overview.test.js']) {
        const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
        assert.ok(!banned.test(src), `${rel} must call the snapshot browser the Logbook`);
    }
});

test('every interactive control is a real button', () => {
    // A clickable div is invisible to the keyboard and to a screen reader.
    assert.ok(!/<(div|span|a|li|td|tr)\b[^>]*@click/.test(O.TEMPLATE),
        'found a @click on something that is not a button');
    const buttons = O.TEMPLATE.match(/<button\b/g) || [];
    assert.ok(buttons.length >= 6, `expected the screen's buttons, found ${buttons.length}`);
    assert.equal((O.TEMPLATE.match(/<button\b/g) || []).length,
        (O.TEMPLATE.match(/<button[^>]*type="button"/g) || []).length,
        'every button must declare type="button" so it cannot submit a form');
});

test('icon-only controls carry an accessible name', () => {
    // btn-close renders as a glyph with no text node at all.
    for (const m of O.TEMPLATE.match(/<button[^>]*btn-close[\s\S]*?>/g) || [])
        assert.match(m, /aria-label=/, m);
    // The status dot is decorative; the status is also stated in words.
    assert.match(O.TEMPLATE, /hangar-dot[^>]*aria-hidden="true"/);
});

test('the expand-in-place remediation reports its state to assistive technology', () => {
    assert.ok(O.TEMPLATE.includes(':aria-expanded='));
    assert.ok(O.TEMPLATE.includes(':aria-controls='));
    assert.ok(O.TEMPLATE.includes('hangar-job-detail-'), 'aria-controls needs a target id');
    assert.equal(O.expands('list-unreadable'), true);
    assert.equal(O.expands('free-space'), true);
    for (const r of ['unlock', 'init', 'reprompt', 'retry', null, undefined, '__proto__'])
        assert.equal(O.expands(r), false, String(r));
});

test('errors and progress are announced rather than only drawn', () => {
    assert.ok(/alert-danger[^>]*role="alert"|role="alert"[^>]*alert-danger/.test(O.TEMPLATE) ||
        (O.TEMPLATE.match(/role="alert"/g) || []).length >= 2,
        'both failure alerts must be announced');
    assert.ok(O.TEMPLATE.includes('role="status"'));
    assert.ok(O.TEMPLATE.includes('aria-live="polite"'));
});

test('every table column and section is labelled', () => {
    for (const m of O.TEMPLATE.match(/<th\b[^>]*>/g) || [])
        assert.match(m, /scope="(col|row)"/, m);
    for (const m of O.TEMPLATE.match(/<section\b[^>]*>/g) || [])
        assert.match(m, /aria-labelledby=/, m);
});

test('the busy flag disables the buttons that would queue a second run', () => {
    assert.ok(O.TEMPLATE.includes(':disabled="isBusy(j.id)"'));
    assert.ok(O.TEMPLATE.includes(':disabled="isBusy(r.id)"'));
    assert.ok(O.TEMPLATE.includes('isBusy(j.id) || j.status === \'running\''));
});

test('a disk-full job offers "space" help, and the panel it opens is about space', async () => {
    // The full loop for the one remediation that shares a panel with read errors.
    const c = component({ config: Object.assign(fakeDeps().config, {
        readState: async () => state({ status: 'failed', kind: 'NO_SPACE', exit_code: 1 })
    }) });
    await c.refresh();
    await c.sizesDone;
    const row = c.jobs[0];
    assert.equal(row.status, 'failed');
    assert.equal(row.remediation, 'free-space');
    assert.equal(row.unreadable, 0);
    await c.remediate(row);
    assert.equal(c.expanded, 'nightly');
    const panel = c.expansionFor(row);
    assert.equal(panel.kind, 'space');
    assert.ok(!/unreadable/i.test(panel.text), 'no files were unreadable here');
});

test('the partial-listing notice is a warning, not a failure', async () => {
    // The config-reading analogue of restic exit 3: some files were unreadable,
    // the rest of the answer is real and is shown.
    assert.ok(/x-show="warnings.length" class="alert alert-warning"/.test(O.TEMPLATE));
    assert.ok(!/x-show="warnings.length" class="alert alert-danger"/.test(O.TEMPLATE));
    assert.ok(O.TEMPLATE.includes('Everything below was read successfully.'));
    assert.ok(O.TEMPLATE.includes('x-for="w in warnings" :key="w.key"'),
        'the unreadable files must be enumerated, and keyed so none of them collide');
});

// ==========================================================================
// An expired cloud destination: the banner someone meets after a bad night.
//
// Three facts decide whether it is useful or is one more red box to scroll
// past: WHICH repository, that it is failing NOW, and when it last worked.
// "My backups have been broken for three weeks" is the discovery this whole
// feature exists to make impossible.
// ==========================================================================

const DAY = 86400000;

const DRIVE = { id: 'drive', label: 'Google Drive', auth: 'oauth' };
const BOX = { id: 'box', label: 'Box', auth: 'oauth' };
const JOTTA = { id: 'jottacloud', label: 'Jottacloud', auth: 'external' };
const BOX_POLICY = { provider: 'box', label: 'Box', inactivityDays: 60,
    reason: 'Box expires its refresh token after 60 days of inactivity.' };

// A repository row as the screen builds one, with its destination resolved.
function cloudRepo(over) {
    const o = over || {};
    return O.repoRow(
        { id: o.id || 'nas', kind: 'rclone', remote: o.remote || 'gdrive' },
        { totalSize: 2048, snapshotsCount: 7 },
        o.error || null,
        null,
        { remote: o.remote || 'gdrive',
          provider: o.provider === undefined ? DRIVE : o.provider,
          expiryPolicy: o.expiryPolicy || null });
}

// A job row that failed on authorisation last night.
function expiredJob(over) {
    const o = over || {};
    return O.jobRow({ id: o.id || 'nightly', name: o.name || 'Nightly', repo: o.repo || 'nas' },
        state({ status: 'failed', kind: 'AUTH_EXPIRED', exit_code: 1,
            finished: SEC(NOW), last_success: o.lastSuccess === undefined ? undefined : o.lastSuccess }),
        unit(), NOW);
}

// --- what "last succeeded" means ----------------------------------------

test('lastSuccessMs only counts a run that actually wrote something', () => {
    assert.equal(O.lastSuccessMs(state({ status: 'ok' })), NOW);
    // exit 3 WROTE the snapshot, so the destination did accept a write.
    assert.equal(O.lastSuccessMs(state({ status: 'partial' })), NOW);
    // The snapshot exists; only the retention pass failed.
    assert.equal(O.lastSuccessMs(state({ status: 'prune-failed' })), NOW);
    // A failed run is not a success, and hangar must be able to say it does not
    // know rather than quote the time of the failure.
    assert.equal(O.lastSuccessMs(state({ status: 'failed', kind: 'AUTH_EXPIRED' })), null);
    assert.equal(O.lastSuccessMs(null), null);
    assert.equal(O.lastSuccessMs('corrupt'), null);
    assert.equal(O.lastSuccessMs({}), null);
});

test('a recorded last_success is believed over anything inferred', () => {
    // Forward compatibility, not decoration: the day the helper carries the last
    // success across a failure, this screen tells the truth with no change here.
    const s = state({ status: 'failed', kind: 'AUTH_EXPIRED', last_success: SEC(NOW) - 20 * 86400 });
    assert.equal(O.lastSuccessMs(s), NOW - 20 * DAY);
    // Milliseconds (systemd) and seconds (the helper) both arrive.
    assert.equal(O.lastSuccessMs({ status: 'failed', last_success: NOW }), NOW);
    assert.equal(O.lastSuccessMs({ status: 'failed', lastSuccess: SEC(NOW) }), NOW);
    assert.equal(O.lastSuccessMs({ status: 'failed', last_success: 0 }), null);
    assert.equal(O.lastSuccessMs({ status: 'failed', last_success: 'yesterday' }), null);
});

test('a job row reports its last SUCCESS separately from its last run', () => {
    // A job that has failed every night for three weeks ran last night. Showing
    // that as the headline is the misreading this feature exists to prevent.
    const row = expiredJob({ lastSuccess: SEC(NOW) - 21 * 86400 });
    assert.equal(row.status, 'failed');
    assert.equal(row.remediation, 'reauthorize');
    assert.equal(row.lastRun, NOW);
    assert.equal(row.lastSuccess, NOW - 21 * DAY);
    assert.match(row.lastSuccessText, /week|day/);
    assert.notEqual(row.lastRunText, row.lastSuccessText);
});

test('repoLastSuccess is the newest success across every job on that repository', () => {
    const jobs = [
        O.jobRow({ id: 'a', repo: 'nas' }, state({ finished: SEC(NOW) - 3 * 86400 }), unit(), NOW),
        O.jobRow({ id: 'b', repo: 'nas' }, state({ finished: SEC(NOW) - 86400 }), unit(), NOW),
        O.jobRow({ id: 'c', repo: 'other' }, state({ finished: SEC(NOW) }), unit(), NOW),
        O.jobRow({ id: 'd', repo: 'nas' }, state({ status: 'failed', kind: 'AUTH_EXPIRED' }), unit(), NOW)
    ];
    assert.equal(O.repoLastSuccess(jobs, 'nas'), NOW - DAY);
    assert.equal(O.repoLastSuccess(jobs, 'other'), NOW);
    assert.equal(O.repoLastSuccess(jobs, 'gone'), null);
    assert.equal(O.repoLastSuccess(null, 'nas'), null);
    assert.equal(O.repoLastSuccess(jobs, ''), null);
});

test('a destination with no recorded success says so, rather than claiming never', () => {
    // hangar only knows what its state files say. Overstating that on a red
    // banner is the kind of wrong that costs trust exactly when it is needed.
    const s = O.lastSuccessSentence(null, NOW);
    assert.match(s, /no record/i);
    assert.ok(!/never backed up/i.test(s));
    assert.match(O.lastSuccessSentence(NOW - 3 * DAY, NOW), /last backed up successfully/i);
});

// --- the reactive banner -------------------------------------------------

test('an expired destination says which repository, and that it is failing now', () => {
    const banners = O.authBanners([expiredJob()], [cloudRepo()], NOW);
    assert.equal(banners.length, 1);
    const b = banners[0];
    assert.equal(b.level, 'danger');
    assert.equal(b.kind, 'expired');
    assert.equal(b.repoId, 'nas');
    assert.match(b.title, /\bnas\b/);
    // Present tense and unqualified: this already happened last night.
    assert.match(b.title, /are failing/);
    assert.ok(!/may fail|might/i.test(b.title + b.message));
    assert.match(b.message, /Google Drive/);
    assert.match(b.message, /gdrive/);
    // And it says why retrying is not the answer.
    assert.match(b.message, /same failure every night|until it is signed in again/i);
});

test('the banner carries when it last succeeded, and which jobs stopped', () => {
    const jobs = [
        expiredJob({ id: 'nightly', name: 'Nightly', lastSuccess: SEC(NOW) - 21 * 86400 }),
        expiredJob({ id: 'weekly', name: 'Weekly documents', lastSuccess: SEC(NOW) - 21 * 86400 })
    ];
    const b = O.authBanners(jobs, [cloudRepo()], NOW)[0];
    assert.equal(b.lastSuccess, NOW - 21 * DAY);
    assert.match(b.lastSuccessText, /last backed up successfully/i);
    assert.match(b.lastSuccessText, /days? ago/);
    assert.deepEqual(b.jobs, ['Nightly', 'Weekly documents']);
});

test('a destination whose last success is unknown still gets an honest banner', () => {
    const b = O.authBanners([expiredJob()], [cloudRepo()], NOW)[0];
    assert.equal(b.lastSuccess, null);
    assert.match(b.lastSuccessText, /no record of a successful backup/i);
});

test('the repository\'s own health check can raise the banner on its own', () => {
    // No job state at all — the size read failed with AUTH_EXPIRED. That is still
    // a destination that is refusing this server.
    const repo = cloudRepo({ error: Errors.create('AUTH_EXPIRED', 'sign-in expired') });
    assert.equal(repo.remediation, 'reauthorize');
    const b = O.authBanners([], [repo], NOW)[0];
    assert.equal(b.kind, 'expired');
    assert.deepEqual(b.jobs, []);
});

test('the banner is built from the typed error\'s remediation, not from a parallel notion', () => {
    // AUTH_EXPIRED -> 'reauthorize' comes from errors.js; nothing here re-decides
    // what an expired destination is.
    assert.equal(Errors.REMEDIATION[Errors.KIND.AUTH_EXPIRED], 'reauthorize');
    const other = O.jobRow({ id: 'n', repo: 'nas' },
        state({ status: 'failed', kind: 'REPO_LOCKED' }), unit(), NOW);
    assert.equal(other.remediation, 'unlock');
    assert.deepEqual(O.authBanners([other], [cloudRepo()], NOW), []);
});

test('a repository with no cloud destination is never given a sign-in banner', () => {
    const local = O.repoRow({ id: 'usb', kind: 'local', path: '/srv/b' }, null, null, null, null);
    assert.equal(local.remote, '');
    assert.deepEqual(O.authBanners([], [local], NOW), []);
    // Even when a job on it failed for a completely different reason.
    const j = O.jobRow({ id: 'n', repo: 'usb' }, state({ status: 'failed', kind: 'NO_SPACE' }), unit(), NOW);
    assert.deepEqual(O.authBanners([j], [local], NOW), []);
});

test('the provider hangar cannot sign in to is offered instructions, not a flow', () => {
    // Jottacloud has no `rclone authorize` hook at all, so there is no token to
    // paste. Offering a flow that cannot complete costs more than saying so.
    const b = O.authBanners([expiredJob()],
        [cloudRepo({ provider: JOTTA, remote: 'jotta' })], NOW)[0];
    assert.equal(b.external, true);
    assert.equal(b.canReconnect, false);
    assert.equal(b.actionLabel, 'What to do');
    assert.match(b.message, /Jottacloud/);
});

test('an unidentified provider still gets the button — the wizard can look for itself', () => {
    const b = O.authBanners([expiredJob()], [cloudRepo({ provider: null })], NOW)[0];
    assert.equal(b.canReconnect, true);
    assert.equal(b.actionLabel, 'Reconnect');
    assert.match(b.message, /The cloud destination/);
});

// --- the proactive warning ----------------------------------------------

test('expiryWarning only speaks when a provider declares a deadline', () => {
    assert.equal(O.expiryWarning(null, NOW - 50 * DAY, NOW), null);
    assert.equal(O.expiryWarning({}, NOW - 50 * DAY, NOW), null);
    assert.equal(O.expiryWarning({ inactivityDays: 0 }, NOW - 50 * DAY, NOW), null);
    assert.equal(O.expiryWarning({ inactivityDays: 'sixty' }, NOW - 50 * DAY, NOW), null);
});

test('expiryWarning says nothing while the deadline is far away', () => {
    assert.equal(O.expiryWarning(BOX_POLICY, NOW, NOW), null);
    assert.equal(O.expiryWarning(BOX_POLICY, NOW - 45 * DAY, NOW), null);
    // The boundary: 14 days left is the first day worth mentioning.
    assert.equal(O.expiryWarning(BOX_POLICY, NOW - 45 * DAY - 1, NOW), null);
    assert.ok(O.expiryWarning(BOX_POLICY, NOW - 46 * DAY, NOW));
    assert.equal(O.EXPIRY_WARN_DAYS, 14);
});

test('expiryWarning counts from the last write, because inactivity is the rule', () => {
    const w = O.expiryWarning(BOX_POLICY, NOW - 51 * DAY, NOW);
    assert.equal(w.idleDays, 51);
    assert.equal(w.daysLeft, 9);
    assert.equal(w.overdue, false);
    assert.equal(w.inactivityDays, 60);
    assert.equal(w.deadline, NOW - 51 * DAY + 60 * DAY);
});

test('past the deadline is still amber, and still about what has not happened yet', () => {
    const w = O.expiryWarning(BOX_POLICY, NOW - 70 * DAY, NOW);
    assert.equal(w.overdue, true);
    assert.ok(w.daysLeft <= 0);
});

test('a deadline is never invented from a date hangar does not have', () => {
    assert.equal(O.expiryWarning(BOX_POLICY, null, NOW), null);
    assert.equal(O.expiryWarning(BOX_POLICY, 0, NOW), null);
    assert.equal(O.expiryWarning(BOX_POLICY, 'lately', NOW), null);
    // A clock that ran backwards is skew, not a deadline.
    assert.equal(O.expiryWarning(BOX_POLICY, NOW + 5 * DAY, NOW), null);
});

test('a repository nobody writes to warns before it expires, in amber', () => {
    const job = O.jobRow({ id: 'archive', name: 'Archive', repo: 'nas' },
        state({ status: 'ok', finished: SEC(NOW) - 51 * 86400 }), unit(), NOW);
    const b = O.authBanners([job],
        [cloudRepo({ provider: BOX, remote: 'boxed', expiryPolicy: BOX_POLICY })], NOW)[0];
    assert.equal(b.level, 'warning', 'amber: nothing has failed yet');
    assert.equal(b.kind, 'expiring');
    assert.match(b.title, /expires in about 9 days/);
    assert.match(b.message, /60 days without activity/);
    assert.match(b.message, /51 days/);
    // Clearly about the future, and it names both ways out.
    assert.ok(!/are failing|has stopped/i.test(b.title + b.message));
    assert.match(b.message, /Backing up to it now resets that clock/);
    assert.equal(b.canReconnect, true);
});

test('an overdue idle destination is warned about without claiming it has failed', () => {
    const job = O.jobRow({ id: 'archive', repo: 'nas' },
        state({ status: 'ok', finished: SEC(NOW) - 70 * 86400 }), unit(), NOW);
    const b = O.authBanners([job],
        [cloudRepo({ provider: BOX, expiryPolicy: BOX_POLICY })], NOW)[0];
    assert.equal(b.level, 'warning');
    assert.match(b.title, /may already have expired/i);
    assert.match(b.message, /nothing has tried/i);
});

test('a destination that is already failing gets one banner, not two', () => {
    const job = expiredJob({ lastSuccess: SEC(NOW) - 70 * 86400 });
    const banners = O.authBanners([job],
        [cloudRepo({ provider: BOX, expiryPolicy: BOX_POLICY })], NOW);
    assert.equal(banners.length, 1);
    assert.equal(banners[0].kind, 'expired', 'a report of failure outranks a warning about one');
});

test('a busy repository on a provider with a deadline is left alone', () => {
    const job = O.jobRow({ id: 'nightly', repo: 'nas' }, state({ status: 'ok' }), unit(), NOW);
    assert.deepEqual(O.authBanners([job],
        [cloudRepo({ provider: BOX, expiryPolicy: BOX_POLICY })], NOW), []);
});

test('authBanners survives hostile input rather than blanking the screen', () => {
    assert.deepEqual(O.authBanners(null, null, NOW), []);
    assert.deepEqual(O.authBanners('x', 'y', NOW), []);
    assert.deepEqual(O.authBanners([null, 'x'], [null, 'x', 7], NOW), []);
    const weird = O.repoRow({ id: 'nas', kind: 'rclone' }, null,
        Errors.create('AUTH_EXPIRED', 'x'), null, { remote: 5, provider: 'nope', expiryPolicy: 3 });
    assert.equal(weird.remote, '');
    assert.equal(weird.providerLabel, '');
    const b = O.authBanners([], [weird], NOW)[0];
    assert.match(b.message, /The cloud destination/);
});

// --- the component end to end -------------------------------------------

function cloudDeps(over) {
    const o = over || {};
    return {
        config: Object.assign(fakeDeps().config, {
            readRepo: async () => ({ id: 'nas', kind: 'rclone', remote: 'gdrive', prefix: 'b' }),
            readState: async () => state({ status: 'failed', kind: 'AUTH_EXPIRED', exit_code: 1 })
        }, o.config || {}),
        rclone: Object.assign({
            remoteNameFromRepoUrl: (url) => (/^rclone:/.test(String(url)) ? 'gdrive' : null),
            providerOfRemote: async () => DRIVE,
            expiryPolicy: () => null,
            externalSetup: () => null
        }, o.rclone || {})
    };
}

test('the screen raises the banner for an expired destination after a failed night', async () => {
    const c = component(cloudDeps());
    await c.refresh();
    await c.sizesDone;
    assert.equal(c.banners.length, 1);
    const b = c.banners[0];
    assert.equal(b.repoId, 'nas');
    assert.equal(b.remote, 'gdrive');
    assert.equal(b.providerLabel, 'Google Drive');
    assert.equal(b.canReconnect, true);
    assert.equal(c.jobs[0].remediation, 'reauthorize');
});

test('the banner disappears when the destination stops failing', async () => {
    const c = component(cloudDeps({ config: { readState: async () => state({ status: 'ok' }) } }));
    await c.refresh();
    await c.sizesDone;
    assert.deepEqual(c.banners, []);
});

test('Reconnect opens the same wizard the destination was created in', async () => {
    const c = component(cloudDeps());
    await c.refresh();
    await c.sizesDone;
    const seen = [];
    const saved = [globalThis.CustomEvent, globalThis.dispatchEvent,
        Object.prototype.hasOwnProperty.call(globalThis, 'CustomEvent')];
    globalThis.CustomEvent = class { constructor(n, o) { this.type = n; this.detail = (o || {}).detail; } };
    globalThis.dispatchEvent = (ev) => { seen.push(ev); return true; };
    try {
        assert.equal(c.actOnBanner(c.banners[0]), true);
    } finally {
        if (saved[2]) { globalThis.CustomEvent = saved[0]; globalThis.dispatchEvent = saved[1]; }
        else { delete globalThis.CustomEvent; delete globalThis.dispatchEvent; }
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, 'hangar:rclone-remote');
    assert.equal(seen[0].detail.reauthorize, 'gdrive');
    assert.equal(seen[0].detail.repoId, 'nas');
    assert.equal(typeof seen[0].detail.verify, 'function');
});

test('the job row\'s own button performs the repair rather than describing it', async () => {
    // It used to only expand a panel telling the user to go elsewhere. A screen
    // that can take you there and instead tells you where to go is how a failure
    // survives another night.
    assert.equal(O.expands('reauthorize'), false);
    const c = component(cloudDeps());
    await c.refresh();
    await c.sizesDone;
    const seen = [];
    globalThis.CustomEvent = class { constructor(n, o) { this.type = n; this.detail = (o || {}).detail; } };
    globalThis.dispatchEvent = (ev) => { seen.push(ev); return true; };
    try {
        await c.remediate(c.jobs[0]);
    } finally {
        delete globalThis.CustomEvent; delete globalThis.dispatchEvent;
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0].detail.reauthorize, 'gdrive');
    assert.equal(c.expanded, null, 'and it did not just open a panel');
});

test('a repository row remediation reaches the same repair', async () => {
    const c = component(cloudDeps({ config: { readState: async () => state({ status: 'ok' }) } }));
    await c.refresh();
    await c.sizesDone;
    const seen = [];
    globalThis.CustomEvent = class { constructor(n, o) { this.type = n; this.detail = (o || {}).detail; } };
    globalThis.dispatchEvent = (ev) => { seen.push(ev); return true; };
    try {
        await c.remediateRepo({ id: 'nas', remediation: 'reauthorize' });
    } finally {
        delete globalThis.CustomEvent; delete globalThis.dispatchEvent;
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0].detail.reauthorize, 'gdrive');
});

test('a repository with no remote reports why it cannot be signed in to', async () => {
    // A local folder: there is no cloud sign-in to renew, whatever asked.
    const c = component(cloudDeps({
        config: { readRepo: async () => ({ id: 'nas', kind: 'local', path: '/srv/b' }) }
    }));
    await c.refresh();
    await c.sizesDone;
    assert.equal(c.repos[0].remote, '');
    assert.equal(c.reconnect({ repoId: 'nas' }), false);
    assert.ok(c.actionError, 'a silent no-op on a pressed button is the failure mode');
    assert.match(c.errorText(c.actionError), /does not write through an rclone remote/i);
});

test('an unreadable rclone configuration costs the banner nothing but the provider name', async () => {
    const c = component(cloudDeps({ rclone: {
        providerOfRemote: async () => { throw Errors.create('GENERIC', 'no rclone here'); }
    } }));
    await c.refresh();
    await c.sizesDone;
    assert.equal(c.repos.length, 1, 'the repository is still on screen');
    assert.equal(c.banners.length, 1);
    assert.equal(c.banners[0].providerLabel, 'The cloud destination');
    assert.equal(c.banners[0].canReconnect, true);
});

test('the proactive warning reaches the screen from the provider table', async () => {
    const Rclone = require('../../js/core/rclone.js');
    // Not a number invented here: Box's own rule, declared beside the provider.
    const policy = Rclone.expiryPolicy('box');
    assert.equal(policy.inactivityDays, 60);
    assert.equal(Rclone.expiryPolicy('drive'), null, 'no invented deadlines');

    const c = component(cloudDeps({
        config: { readState: async () => state({ status: 'ok', finished: SEC(NOW) - 55 * 86400 }) },
        rclone: { providerOfRemote: async () => BOX, expiryPolicy: () => policy }
    }));
    c.now = NOW;
    await c.refresh();
    await c.sizesDone;
    // refresh() stamps its own clock, so assert on the shape rather than the day.
    assert.equal(c.banners.length, 1);
    assert.equal(c.banners[0].kind, 'expiring');
    assert.equal(c.banners[0].level, 'warning');
});

test('instructions for an external provider come from externalSetup', async () => {
    const Rclone = require('../../js/core/rclone.js');
    const c = component(cloudDeps({ rclone: {
        providerOfRemote: async () => JOTTA,
        externalSetup: (id) => Rclone.externalSetup(id)
    } }));
    await c.refresh();
    await c.sizesDone;
    const b = c.banners[0];
    assert.equal(b.canReconnect, false);
    // Pressing it opens the instructions instead of a flow that cannot run.
    assert.equal(c.actOnBanner(b), false);
    assert.equal(c.expanded, b.id);
    assert.deepEqual(c.instructionsFor(b).steps, Rclone.externalSetup('jottacloud').steps);
});

test('a banner announces itself, and its action is a real button', () => {
    // A live region has to be in the DOM before the message arrives, or there is
    // nothing to announce a change to.
    assert.match(O.TEMPLATE, /aria-live="assertive"/);
    assert.ok(O.TEMPLATE.includes('x-for="b in banners" :key="b.id"'));
    assert.ok(O.TEMPLATE.includes('@click="actOnBanner(b)"'));
    assert.ok(O.TEMPLATE.includes('x-text="b.lastSuccessText"'));
    assert.ok(O.TEMPLATE.includes('<button type="button" class="btn btn-sm"'));
    // The instructions panel is a disclosure, and says so.
    assert.ok(O.TEMPLATE.includes('hangar-banner-'));
    assert.match(O.TEMPLATE, /:aria-expanded="b\.canReconnect \? null/);
});

// ------------------------------------------- a screen that watches when idle
//
// Watching only while a run is in flight meant a run started anywhere else —
// the timer at 3am, `systemctl start`, another tab — was invisible until
// somebody reloaded the page, and the screen could sit on "Running" long after
// the run had finished. An idle screen now looks slowly rather than not at all.

test('an idle screen still watches, just rarely', () => {
    const c = O.hangarOverview();
    const timers = [];
    const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
    globalThis.setInterval = (fn, ms) => { timers.push(ms); return { id: timers.length }; };
    globalThis.clearInterval = () => {};
    try {
        c.jobs = [{ id: 'a', unit: { service: { active: false } } }];
        c.syncWatch();
        assert.equal(timers[timers.length - 1], c.IDLE_WATCH_MS,
            'nothing running, so the slow cadence');
    } finally {
        globalThis.setInterval = realSet; globalThis.clearInterval = realClear;
    }
});

test('a running job switches the screen to the fast cadence', () => {
    const c = O.hangarOverview();
    const timers = [];
    const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
    globalThis.setInterval = (fn, ms) => { timers.push(ms); return { id: timers.length }; };
    globalThis.clearInterval = () => {};
    try {
        c.jobs = [{ id: 'a', unit: { service: { active: false } } }];
        c.syncWatch();
        c.jobs = [{ id: 'a', unit: { service: { active: true } } }];
        c.syncWatch();
        assert.equal(timers[timers.length - 1], c.WATCH_MS);
        // And back down again when it ends, rather than polling every five
        // seconds for the rest of the session.
        c.jobs = [{ id: 'a', unit: { service: { active: false } } }];
        c.syncWatch();
        assert.equal(timers[timers.length - 1], c.IDLE_WATCH_MS);
    } finally {
        globalThis.setInterval = realSet; globalThis.clearInterval = realClear;
    }
});

test('repeated refreshes do not stack timers', () => {
    const c = O.hangarOverview();
    let created = 0;
    const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
    globalThis.setInterval = () => { created++; return { id: created }; };
    globalThis.clearInterval = () => {};
    try {
        c.jobs = [{ id: 'a', unit: { service: { active: false } } }];
        c.syncWatch(); c.syncWatch(); c.syncWatch();
        assert.equal(created, 1, 'one timer, however often the screen refreshes');
    } finally {
        globalThis.setInterval = realSet; globalThis.clearInterval = realClear;
    }
});

// jobRow was given the unit state and threw it away, so anyRunning() — which
// reads row.unit.service.active — could never be true. The screen therefore
// only ever noticed backups it had started itself: one from the timer, from
// `systemctl start`, or from another tab left it showing stale information
// until somebody reloaded the page. Verified against a live Cockpit: systemd
// reported the service activating while the Overview reported nothing running.
test('a job row carries the unit state it was built from', () => {
    const unit = { service: { active: true, activeState: 'activating' }, timer: { active: true } };
    const row = O.jobRow({ id: 'nightly' }, null, unit, Date.now());
    assert.deepEqual(row.unit, unit, 'the row must keep what it was given');
});

test('the Overview sees a run it did not start', () => {
    const c = O.hangarOverview();
    c.jobs = [O.jobRow({ id: 'nightly' }, null,
        { service: { active: true }, timer: { active: true } }, Date.now())];
    assert.equal(c.anyRunning(), true);
    c.jobs = [O.jobRow({ id: 'nightly' }, null,
        { service: { active: false }, timer: { active: true } }, Date.now())];
    assert.equal(c.anyRunning(), false);
});

test('a job with no systemd answer is not reported as running', () => {
    const row = O.jobRow({ id: 'nightly' }, null, null, Date.now());
    assert.equal(row.unit, null);
    const c = O.hangarOverview();
    c.jobs = [row];
    assert.equal(c.anyRunning(), false);
});

// ------------------------------------------------------- the wait itself
//
// A skeleton of the rows that are coming, not a spinner: the Overview always
// renders a card per job, so the wait can show that shape. Nothing jumps when
// the data lands, and the screen says how much is on its way.

test('the wait draws as many rows as there were last time', () => {
    const c = O.hangarOverview();
    assert.equal(c.skeletonRows(), 2, 'two until we know better');
    c._lastCount = 4;
    assert.equal(c.skeletonRows(), 4, 'the shape of the answer, not a guess');
    c._lastCount = 99;
    assert.equal(c.skeletonRows(), 6, 'a hundred jobs is not a hundred grey bars');
    c._lastCount = 0;
    assert.equal(c.skeletonRows(), 2);
});

test('the skeleton is hidden the moment there is anything real to show', () => {
    const html = O.TEMPLATE;
    assert.match(html, /x-show="loading && !jobs\.length"/,
        'a refresh must not blank good data to redraw it identically');
    assert.match(html, /aria-hidden="true"/,
        'a screen reader has no use for a picture of a row');
    assert.match(html, /x-show="loading && jobs\.length"[^>]*>Checking…/,
        'a refresh says it is checking instead');
});

test('the wait is announced once, in words, for anyone not looking at it', () => {
    const html = O.TEMPLATE;
    assert.match(html, /visually-hidden[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(html, /Reading backup status/);
});

// ----------------------------------------- the summary yields to a backup
//
// The Overview lists each repository's size, and reading a repository takes a
// restic lock while retention needs an exclusive one. The Repositories screen
// was taught to hold back during a backup; the Overview reads repositories
// through its own path and was missed, so simply leaving this screen open kept
// retention from ever reclaiming space. Measured: mount stopped, retention
// still blocked, 58 restic processes belonging to this poll.

test('the repository summary is not read while a backup is running', async () => {
    const prev = globalThis.HangarSchedule;
    globalThis.HangarSchedule = { anyBackupRunning: () => Promise.resolve(true) };
    let spawned = false;
    globalThis.cockpit = { spawn() { spawned = true; return Promise.resolve('{}'); } };
    try {
        const c = O.hangarOverview();
        const out = await c.fetchStats({ id: 'main', kind: 'local', path: '/srv/r' });
        assert.equal(spawned, false, 'nothing may touch the repository during a backup');
        assert.equal(out, null, 'a missing size is a gap in a summary, not an error');
    } finally {
        globalThis.HangarSchedule = prev;
        delete globalThis.cockpit;
    }
});

test('an idle machine still gets its sizes', async () => {
    const prev = globalThis.HangarSchedule;
    globalThis.HangarSchedule = { anyBackupRunning: () => Promise.resolve(false) };
    let spawned = false;
    globalThis.cockpit = {
        spawn() { spawned = true; return Promise.resolve('{"total_size":1,"total_file_count":1}'); }
    };
    try {
        const c = O.hangarOverview();
        await c.fetchStats({ id: 'main', kind: 'local', path: '/srv/r' }).catch(() => null);
        assert.equal(spawned, true, 'no backup, no reason to hold back');
    } finally {
        globalThis.HangarSchedule = prev;
        delete globalThis.cockpit;
    }
});

// ------------------------------------------- the screen does not wait for sizes
//
// `restic stats` reads the repository, and on a remote one that means loading
// its index first: measured at 50 seconds against a NAS over SFTP. The Overview
// used to await that before rendering anything, so jobs and statuses already
// read from local files in milliseconds sat behind it — a screencast showed the
// skeleton still up after 28 seconds.

test('jobs appear while a slow repository is still being measured', async () => {
    const c = O.hangarOverview();
    let release;
    const pending = new Promise((r) => { release = r; });
    c.loadJobs = async () => [O.jobRow({ id: 'nightly', repo: 'main' }, null, null, Date.now())];
    c.destinationOf = async () => null;
    c.fetchStats = async () => { await pending; return { totalSize: 1, snapshotsCount: 3 }; };
    c.loadRepoIds = undefined;

    // Deliberately NOT awaiting c.sizesDone: the whole point is that the screen
    // is up before it settles.
    await c.refresh();
    // The size query has not resolved, and must not have been waited for.
    assert.equal(c.loading, false, 'the screen is up');
    assert.equal(c.jobs.length, 1, 'with its jobs');

    release();
    await c.fillRepoSizes();
    assert.equal(c.loading, false);
});

// ------------------------------------------- the size the screen remembers
//
// Measuring costs a minute against a remote repository, so the Overview shows
// the last measurement and its date, and measures again only when that has gone
// stale or the user asks. The risk this introduces is the opposite of the one it
// removes: a number on screen that nobody can tell is old. So the date, and the
// refusal to lose a good remembered size to a transient failure, are as much the
// contract here as the caching is.

const HOUR_MS = 60 * 60 * 1000;

// A size store in memory, shaped like js/core/reposize.js.
function sizeStore(seed) {
    const RepoSize = require('../../js/core/reposize.js');
    const files = Object.assign({}, seed || {});
    const reads = [];
    const writes = [];
    return {
        files: files, reads: reads, writes: writes,
        maxAgeMsFrom: RepoSize.maxAgeMsFrom,
        isStale: RepoSize.isStale,
        normalize: RepoSize.normalize,
        sizePath: RepoSize.sizePath,
        read: async (id) => { reads.push(id); return files[id] || null; },
        write: async (id, stats, now) => {
            const e = { size: stats.totalSize, snapshots: stats.snapshotsCount,
                at: typeof now === 'number' ? now : Date.now() };
            writes.push([id, e]);
            files[id] = e;
            return e;
        }
    };
}

// A component whose repository sizes come from `store`, counting measurements.
function sized(store, over) {
    const c = component(Object.assign({ reposize: store }, over || {}));
    c.measured = [];
    c.fetchStats = async () => {
        c.measured.push('nas');
        return { totalSize: 900, snapshotsCount: 9 };
    };
    return c;
}

test('a remembered size is on screen without measuring anything', async () => {
    const at = Date.now() - HOUR_MS;
    const store = sizeStore({ nas: { size: 500, snapshots: 5, at: at } });
    const c = sized(store);
    await c.refresh();
    await c.sizesDone;
    assert.deepEqual(c.measured, [], 'a fresh cache means the repository is not touched');
    assert.equal(c.repos[0].size, 500);
    assert.equal(c.repos[0].snapshots, 5);
    assert.equal(c.totals.size, 500, 'and it counts toward the summary');
    assert.equal(c.repos[0].measuredAt, at);
});

test('the row says when the size was measured, in words', async () => {
    const store = sizeStore({ nas: { size: 500, snapshots: 5, at: Date.now() - 3 * HOUR_MS } });
    const c = sized(store);
    await c.refresh();
    await c.sizesDone;
    // A number with no date invites the reader to assume it is current.
    assert.equal(c.repos[0].measuredAtText, 'measured 3 hours ago');
    assert.ok(O.TEMPLATE.includes('r.measuredAtText'),
        'and the template must actually render it');
});

test('a stale size is shown first, then replaced by a fresh measurement', async () => {
    const store = sizeStore({ nas: { size: 500, snapshots: 5, at: Date.now() - 30 * HOUR_MS } });
    const c = sized(store);
    const pass = c.fillRepoSizes.bind(c);
    await c.refresh();
    // The remembered number is up before the measurement has been asked for.
    assert.equal(c.repos[0].size, 500, 'the old size renders immediately');
    await c.sizesDone;
    assert.deepEqual(c.measured, ['nas'], 'and then it is measured again');
    assert.equal(c.repos[0].size, 900);
    assert.equal(c.totals.size, 900);
    assert.equal(store.writes.length, 1, 'the new measurement is remembered');
    assert.equal(store.writes[0][1].size, 900);
    // A second pass now finds it fresh.
    c.measured = [];
    await pass();
    assert.deepEqual(c.measured, []);
});

test('a repository that was never measured is measured, and remembered', async () => {
    const store = sizeStore();
    const c = sized(store);
    await c.refresh();
    await c.sizesDone;
    assert.deepEqual(c.measured, ['nas']);
    assert.equal(c.repos[0].size, 900);
    assert.deepEqual(store.writes.map((w) => w[0]), ['nas']);
    assert.ok(c.repos[0].measuredAt > 0, 'and it carries its own date');
    assert.match(c.repos[0].measuredAtText, /^measured /);
});

test('Measure now ignores a perfectly fresh cache', async () => {
    const store = sizeStore({ nas: { size: 500, snapshots: 5, at: Date.now() } });
    const c = sized(store);
    await c.refresh();
    await c.sizesDone;
    assert.deepEqual(c.measured, [], 'nothing on its own');
    assert.equal(await c.measureSizesNow(), true);
    assert.deepEqual(c.measured, ['nas'], '"how big is it right now" is not a cache question');
    assert.equal(c.repos[0].size, 900);
    assert.equal(c.measuring, false, 'and the button comes back');
    assert.ok(O.TEMPLATE.includes('measureSizesNow()'),
        'the screen must offer that as a button');
});

test('Measure now does not queue a second pass over the same repositories', async () => {
    const store = sizeStore();
    const c = sized(store);
    await c.refresh();
    await c.sizesDone;
    c.measured = [];
    let release;
    const pending = new Promise((r) => { release = r; });
    c.fetchStats = async () => { c.measured.push('nas'); await pending; return { totalSize: 1 }; };
    const first = c.measureSizesNow();
    assert.equal(c.measuring, true);
    // Bounded, so that a regression here fails the test rather than wedging the
    // run: without the guard the second press waits on the first one's query.
    const second = await Promise.race([
        c.measureSizesNow(),
        new Promise((r) => { setTimeout(() => r('queued behind the first'), 50); })
    ]);
    assert.equal(second, false, 'the second press is refused, not queued');
    release();
    await first;
    assert.deepEqual(c.measured, ['nas'], 'measured once, not twice');
});

test('a failed measurement keeps the remembered size instead of blanking it', async () => {
    // The repository WAS that size this morning whether or not the NAS answers
    // this minute. Replacing a true number with a transient error loses more
    // than it reports.
    const at = Date.now() - 30 * HOUR_MS;
    const store = sizeStore({ nas: { size: 500, snapshots: 5, at: at } });
    const c = sized(store);
    c.fetchStats = async () => { throw Errors.create('NETWORK', 'no route to host'); };
    await c.refresh();
    await c.sizesDone;
    assert.equal(c.repos[0].size, 500, 'the remembered size survives');
    assert.equal(c.repos[0].measuredAt, at, 'still dated when it was actually taken');
    assert.equal(c.repos[0].error, null);
    assert.equal(c.totals.errors, 0);
    assert.equal(store.writes.length, 0, 'and nothing bad was written to the cache');
});

test('with no remembered size a failed measurement is still reported', async () => {
    const c = sized(sizeStore());
    c.fetchStats = async () => { throw Errors.create('REPO_LOCKED', 'locked'); };
    await c.refresh();
    await c.sizesDone;
    assert.equal(c.repos[0].remediation, 'unlock');
    assert.equal(c.totals.errors, 1);
});

test('a skipped measurement during a backup keeps the remembered size and its date', async () => {
    const at = Date.now() - 30 * HOUR_MS;
    const store = sizeStore({ nas: { size: 500, snapshots: 5, at: at } });
    const c = sized(store);
    c.fetchStats = async () => null;          // what fetchStats answers mid-backup
    await c.refresh();
    await c.sizesDone;
    assert.equal(c.repos[0].size, 500);
    assert.equal(c.repos[0].measuredAt, at);
    assert.equal(c.repos[0].sizeText, '500 B', 'not a dash');
});

test('the refresh interval comes from settings, not from this file', async () => {
    const store = sizeStore({ nas: { size: 500, snapshots: 5, at: Date.now() - 8 * HOUR_MS } });
    const deps = fakeDeps();
    deps.config.readGlobal = async () => ({ repoSizeMaxAgeHours: 24 });
    const c = sized(store, deps);
    await c.refresh();
    await c.sizesDone;
    assert.deepEqual(c.measured, [], '8 hours is fresh under a 24 hour setting');

    deps.config.readGlobal = async () => ({ repoSizeMaxAgeHours: 6 });
    await c.fillRepoSizes();
    assert.deepEqual(c.measured, ['nas'], 'and stale under a 6 hour one');
});

test('a setting change takes effect without reloading the screen', async () => {
    // The settings are re-read on every pass rather than captured at load, so
    // saving a new interval in Settings does not need a page reload to matter.
    const store = sizeStore({ nas: { size: 500, snapshots: 5, at: Date.now() - 2 * HOUR_MS } });
    const deps = fakeDeps();
    let hours = 24;
    deps.config.readGlobal = async () => ({ repoSizeMaxAgeHours: hours });
    const c = sized(store, deps);
    await c.refresh();
    await c.sizesDone;
    assert.deepEqual(c.measured, []);
    hours = 1;
    await c.fillRepoSizes();
    assert.deepEqual(c.measured, ['nas']);
});

test('zero hours means only on demand, and Measure now still works', async () => {
    const store = sizeStore({ nas: { size: 500, snapshots: 5, at: 1 } });
    const deps = fakeDeps();
    deps.config.readGlobal = async () => ({ repoSizeMaxAgeHours: 0 });
    const c = sized(store, deps);
    await c.refresh();
    await c.sizesDone;
    assert.deepEqual(c.measured, [], 'an ancient size is left alone');
    assert.equal(c.repos[0].size, 500);
    await c.measureSizesNow();
    assert.deepEqual(c.measured, ['nas'], 'but the button is never disabled by a setting');
});

test('unreadable settings fall back to the default rather than stopping measurement', async () => {
    const store = sizeStore({ nas: { size: 500, snapshots: 5, at: Date.now() - 30 * HOUR_MS } });
    const deps = fakeDeps();
    deps.config.readGlobal = async () => { throw Errors.create('GENERIC', 'nope'); };
    const c = sized(store, deps);
    await c.refresh();
    await c.sizesDone;
    assert.deepEqual(c.measured, ['nas'], '30 hours is stale under the shipped default');
    assert.equal(c.error, null, 'and it is not a screen error');
});

test('a repository with a broken definition is never measured or cached', async () => {
    const store = sizeStore();
    const c = sized(store, { config: Object.assign(fakeDeps().config, {
        readRepo: async () => ({ id: 'nas', kind: 'martian' })
    }) });
    await c.refresh();
    await c.sizesDone;
    assert.ok(c.repos[0].error, 'the bad definition is reported at once');
    assert.deepEqual(c.measured, [], 'and nothing remote is attempted');
    assert.deepEqual(store.reads, [], 'nor is a cache consulted for it');
    assert.deepEqual(store.writes, []);
});
