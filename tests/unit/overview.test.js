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
        '--password-file', '/etc/hangar/repos/nas.key', '--json', 'stats',
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
    assert.equal(c.loading, false);
    assert.equal(c.error, null);
    assert.equal(c.jobs.length, 1);
    assert.equal(c.jobs[0].status, 'ok');
    assert.equal(c.repos.length, 1);
    assert.equal(c.totals.snapshots, 7);
    assert.equal(c.overall, 'ok');
    assert.equal(c.isEmpty(), false);
});

test('nothing configured shows the empty state that leads to a repository', async () => {
    const c = component({ config: Object.assign(fakeDeps().config, {
        listJobs: async () => [], listRepos: async () => []
    }) });
    await c.refresh();
    assert.equal(c.isEmpty(), true);
    assert.equal(c.needsJob(), false);
    assert.equal(c.overall, 'never');
});

test('a repository with no job asks for a job, not for another repository', async () => {
    const c = component({ config: Object.assign(fakeDeps().config, { listJobs: async () => [] }) });
    await c.refresh();
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
    assert.equal(c.error, null);
    assert.equal(c.jobs[0].status, 'ok');
    assert.equal(c.jobs[0].nextRunText, 'not scheduled');
});

test('a failure listing jobs surfaces as a screen error with a retry', async () => {
    const c = component({ config: Object.assign(fakeDeps().config, {
        listJobs: async () => { throw Errors.create('GENERIC', 'nope'); }
    }) });
    await c.refresh();
    assert.equal(c.loading, false);
    assert.ok(c.error);
    assert.equal(c.errorText(c.error), 'nope');
});

test('a repository whose stats fail keeps the rest of the screen alive', async () => {
    const c = component();
    c.fetchStats = async () => { throw Errors.create('REPO_LOCKED', 'locked'); };
    await c.refresh();
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
    assert.match(O.formatBytes(Number.MAX_VALUE), /^[0-9.]+ EiB$/);
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
    assert.equal(O.formatDuration(Number.MAX_SAFE_INTEGER).endsWith('d'), true);
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

test('statsArgv: a missing core module is a typed error, not a TypeError', () => {
    const e = assert.throws(() => O.statsArgv({ id: 'nas', kind: 'local', path: '/srv' },
        { repos: null, secrets: null, restic: null }));
    assert.equal(e.kind, 'GENERIC');
    assert.notEqual(e.name, 'TypeError');
});

test('statsArgv: a repository with no usable URL throws a typed error', () => {
    for (const repo of [null, undefined, {}, { id: 'nas' }, { id: 'nas', kind: 'nope' },
        { id: 'nas', kind: 's3' }]) {
        const e = assert.throws(() => O.statsArgv(repo), undefined, JSON.stringify(repo));
        assert.equal(typeof e.message, 'string');
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
    assert.equal(c.isEmpty(), false, '"No backups yet" would be a lie here');
    assert.ok(O.TEMPLATE.includes('@click="refresh()"'), 'the screen error offers a retry');
});

test('listJobs answering something that is not a list does not crash the screen', async () => {
    for (const bad of [null, undefined, 'nightly', 42, { 0: 'a' }]) {
        const c = component({ config: Object.assign(fakeDeps().config, {
            listJobs: async () => bad, listRepos: async () => bad
        }) });
        await c.refresh();
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
    assert.equal(c.error, null);
    assert.equal(c.jobs.length, 1);
    assert.equal(c.jobs[0].status, 'never');
});

test('a state file that is not an object is treated as no state at all', async () => {
    const c = component({ config: Object.assign(fakeDeps().config, {
        readState: async () => 'corrupt'
    }) });
    await c.refresh();
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
    await c.backupNow(c.jobs[0]);
    assert.equal(c.actionRemediation(), null);
});

test('the action error can be dismissed', async () => {
    const c = component({ schedule: {
        unitState: async () => unit(),
        runNow: async () => { throw Errors.create('GENERIC', 'nope'); }
    } });
    await c.refresh();
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
    assert.equal(c.repos[0].remediation, 'reprompt');
    await c.remediateRepo(c.repos[0]);
    assert.deepEqual(written, [['nas', 'hunter2']]);
});

test('a repository remediation with no one-click fix just re-reads its health', async () => {
    let reads = 0;
    const c = O.hangarOverview(fakeDeps());
    c.fetchStats = async () => { reads++; throw Errors.create('GO_RUNTIME', 'crashed'); };
    await c.refresh();
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

test('refresh with no configuration module is a stated failure, not a crash', async () => {
    const c = O.hangarOverview({ errors: Errors, config: null });
    await c.refresh();
    assert.equal(c.loading, false);
    assert.ok(c.error);
    assert.match(c.errorText(c.error), /configuration module/);
    assert.deepEqual(c.jobs, []);
});

test('backupNow with no scheduler module is a stated failure', async () => {
    const c = O.hangarOverview({ errors: Errors, config: null, schedule: null });
    await c.backupNow({ id: 'nightly' });
    assert.ok(c.actionError);
    assert.match(c.errorText(c.actionError), /scheduler module/);
    assert.equal(c.isBusy('nightly'), false);
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
