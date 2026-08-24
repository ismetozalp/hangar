// Integration tests for the size guard in libexec/hangar-run.
//
// Two jobs, and the second is the reason this file is long.
//
//  1. Police the duplication. hangar-run mirrors js/core/sizeguard.js — it has to
//     run from a systemd timer with no Cockpit session and no node present — so
//     both implementations are driven over one corpus. A guard that reads "500 GB"
//     differently in the editor and in the runner is a guard nobody can reason
//     about.
//  2. Drive the real helper against a restic stand-in and assert what it DID:
//     which command lines it ran, in which order, what it deleted, what it stopped
//     at, and what the state file says afterwards. The dangerous outcomes here are
//     silent ones — deleting past the floor, or reporting a repository as fine
//     while it is still over — so they are asserted directly rather than inferred.
//
// The stand-in deliberately reproduces the trap that made this feature necessary:
// `restic stats` DEFAULTS to --mode restore-size, which on a real 2.0 MB
// repository answered 5.9 MB. The stub answers the same way, so a runner that
// forgets --mode raw-data measures a repository three times its real size and
// deletes snapshots that were never the problem — and one test below exists purely
// to fail if that ever happens.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELPER = path.join(__dirname, '..', '..', 'libexec', 'hangar-run');
const Guard = require('../../js/core/sizeguard.js');

const LOCAL_REPO = { id: 'main', kind: 'local', path: '/srv/backup' };

// No retention: the guard is what is under test, and a policy forget in the middle
// of the call log only makes the assertions harder to read. One test below puts it
// back, to pin the order of the two.
const JOB = {
    id: 'nightly', repo: 'main', retention: null,
    sources: [{ kind: 'filesystem', paths: ['/etc'] }]
};

// --- a host with a restic that answers about a repository we control ---------
//
// python3 rather than sh: the stub has to keep a repository's worth of state
// between calls, and hangar-run already depends on python3 being present.
const RESTIC_STUB = `#!/usr/bin/env python3
import json, os, sys

state_path, calls_path = os.environ["STUB_STATE"], os.environ["STUB_CALLS"]
argv = sys.argv[1:]
with open(calls_path, "a") as fh:
    fh.write(json.dumps(argv) + "\\n")

with open(state_path) as fh:
    st = json.load(fh)

def save():
    with open(state_path, "w") as fh:
        json.dump(st, fh)

CMDS = ("backup", "snapshots", "stats", "forget", "prune")
cmd = next((a for a in argv if a in CMDS), "")

if (st.get("fail") or {}).get(cmd):
    sys.stderr.write("stub: %s was told to fail\\n" % cmd)
    sys.exit(1)

if st.get("hang") == cmd:
    import time
    while True:
        time.sleep(1)

if cmd == "backup":
    st["raw"] = st.get("raw", 0) + st.get("grow", 0)
    sid = st.get("new_id") or ("f" * 63 + "0")
    st["snapshots"].append({"id": sid, "short_id": sid[:8], "time": st.get("new_time",
                            "2026-08-01T03:00:00+02:00")})
    save()
    print(json.dumps({"message_type": "summary", "snapshot_id": sid, "files_new": 1}))
    sys.exit(st.get("backup_exit", 0))

if cmd == "snapshots":
    print(json.dumps(st["snapshots"]))
    sys.exit(0)

if cmd == "stats":
    # Counted so a test can fail the measurement that comes AFTER a prune, which
    # is the one place the guard has already deleted something when it loses the
    # ability to tell how much good it did.
    st["stats_calls"] = st.get("stats_calls", 0) + 1
    save()
    if st.get("stats_fails_after") and st["stats_calls"] > st["stats_fails_after"]:
        sys.stderr.write("stub: stats was told to fail after %d calls\\n"
                         % st["stats_fails_after"])
        sys.exit(1)
    mode = ""
    if "--mode" in argv:
        i = argv.index("--mode")
        mode = argv[i + 1] if i + 1 < len(argv) else ""
    # The real default. A caller that omits --mode raw-data is told the repository
    # is restore_factor times its true size, exactly as restic would.
    total = st["raw"] if mode == "raw-data" else st["raw"] * st.get("restore_factor", 3)
    print(json.dumps({"total_size": total, "total_file_count": 7,
                      "snapshots_count": len(st["snapshots"])}))
    sys.exit(0)

if cmd == "forget":
    known = set(s["id"] for s in st["snapshots"])
    ids = [a for a in argv if a in known]
    if ids:
        if st.get("forget_fails_on") in ids:
            sys.stderr.write("stub: refusing to forget %s\\n" % ids[0])
            print("[]")
            sys.exit(1)
        st["snapshots"] = [s for s in st["snapshots"] if s["id"] not in ids]
        freed = st.get("free_per_forget", 0)
        st["raw"] = max(st.get("raw", 0) - freed, st.get("floor_bytes", 0))
        save()
    print("[]")
    sys.exit(0)

print("{}")
sys.exit(0)
`;

function snap(n, time) {
    const id = String(n).repeat(64).slice(0, 64);
    return { id: id, short_id: id.slice(0, 8), time: time };
}

// Four snapshots, oldest first. The ids are distinguishable at a glance in a
// failure message, which matters when the assertion is about WHICH one went.
const SNAPS = [
    snap(1, '2026-07-01T03:00:00+02:00'),
    snap(2, '2026-07-02T03:00:00+02:00'),
    snap(3, '2026-07-03T03:00:00+02:00'),
    snap(4, '2026-07-04T03:00:00+02:00')
];

// The temporary host is torn down only once `fn` is finished — including when it
// returns a promise, as the signal test does. A plain finally would delete the
// stub directory out from under the run it set up.
function withHost(repo, job, state, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-guard-'));
    const bin = path.join(dir, 'bin');
    const clean = () => fs.rmSync(dir, { recursive: true, force: true });
    try {
        fs.mkdirSync(bin, { recursive: true });
        fs.mkdirSync(path.join(dir, 'repos'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'repos', repo.id + '.json'), JSON.stringify(repo));
        fs.writeFileSync(path.join(dir, 'jobs', job.id + '.json'), JSON.stringify(job));
        fs.writeFileSync(path.join(bin, 'restic'), RESTIC_STUB, { mode: 0o755 });

        const statePath = path.join(dir, 'repo-state.json');
        const callsPath = path.join(dir, 'calls');
        fs.writeFileSync(statePath, JSON.stringify(Object.assign(
            { snapshots: [], raw: 0, grow: 0 }, state || {})));
        fs.writeFileSync(callsPath, '');

        const env = Object.assign({}, process.env, {
            HANGAR_CONF_DIR: dir,
            HANGAR_STATE_DIR: path.join(dir, 'state'),
            CREDENTIALS_DIRECTORY: '',
            STUB_STATE: statePath,
            STUB_CALLS: callsPath,
            PATH: bin + ':' + process.env.PATH
        });

        const out = fn({
            dir: dir,
            env: env,
            run(args) {
                const r = spawnSync('python3', [HELPER, job.id].concat(args || []),
                    { env: env, encoding: 'utf8' });
                const sp = path.join(dir, 'state', job.id + '.json');
                return {
                    status: r.status,
                    stdout: r.stdout || '',
                    stderr: r.stderr || '',
                    state: fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, 'utf8')) : null
                };
            },
            calls() {
                return fs.readFileSync(callsPath, 'utf8').split('\n')
                    .filter((l) => l.trim()).map((l) => JSON.parse(l));
            },
            repo() { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
        });
        if (out && typeof out.then === 'function')
            return out.then((v) => { clean(); return v; },
                (e) => { clean(); throw e; });
        clean();
        return out;
    } catch (e) {
        clean();
        throw e;
    }
}

const SUBCOMMANDS = ['backup', 'snapshots', 'stats', 'forget', 'prune'];
function subcommandsOf(calls) {
    return calls.map((argv) => argv.find((a) => SUBCOMMANDS.includes(a)) || '');
}
function guardForgets(calls) {
    // A forget carrying a snapshot id is the guard's; a forget carrying keep flags
    // is retention's.
    return calls.filter((argv) => argv.includes('forget') &&
        argv.some((a) => /^[0-9]{64}$/.test(a)));
}

function repoWithGuard(guard) {
    return Object.assign({}, LOCAL_REPO, { sizeGuard: guard });
}

function plan(dir, jobId) {
    return JSON.parse(execFileSync('python3', [HELPER, jobId, '--print-plan'], {
        env: Object.assign({}, process.env,
            { HANGAR_CONF_DIR: dir, CREDENTIALS_DIRECTORY: '' }),
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    }));
}

function planFor(repo, job) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-guard-plan-'));
    try {
        fs.mkdirSync(path.join(dir, 'repos'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'repos', repo.id + '.json'), JSON.stringify(repo));
        fs.writeFileSync(path.join(dir, 'jobs', job.id + '.json'), JSON.stringify(job));
        return plan(dir, job.id);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------- --print-plan

test('a repository with no size guard plans none, and the rest of the plan is untouched', () => {
    const p = planFor(LOCAL_REPO, Object.assign({}, JOB, {
        retention: { daily: 7 }
    }));
    assert.equal(p.guard, null);
    // The pre-existing plan is not disturbed by the new key.
    assert.ok(p.backup.includes('backup'));
    assert.ok(p.forget.includes('--keep-daily'));
    assert.ok(p.forget.includes('--prune'));
});

test('--print-plan shows the guard without running anything', () => {
    withHost(repoWithGuard({ limit: '500 GB' }), JOB, { raw: 10, snapshots: SNAPS }, (host) => {
        const r = host.run(['--print-plan']);
        assert.equal(r.status, 0);
        const p = JSON.parse(r.stdout);
        assert.ok(p.guard, 'the plan carries no guard');
        assert.equal(p.guard.limit, '500 GB');
        assert.equal(p.guard.limitBytes, 500e9);
        // The whole point of a dry run: nothing was measured, nothing was deleted.
        assert.deepEqual(host.calls(), [],
            '--print-plan ran restic: it must stay a pure dry run');
    });
});

test('the guard measures with --mode raw-data, never the default mode', () => {
    // The verified fact this feature is built on: `stats` defaults to
    // --mode restore-size, which counts restored FILE sizes. A real 2.0 MB
    // repository reported 5.9 MB that way.
    const p = planFor(repoWithGuard({ limit: '1 TB' }), JOB);
    const base = ['restic', '-r', '/srv/backup', '--password-file'];
    assert.deepEqual(p.guard.stats.slice(0, 4), base);
    // The cache directory sits between the password file and the subcommand: a
    // systemd unit has no $HOME, and restic exits 1 instead of running.
    assert.deepEqual(p.guard.stats.slice(5),
        ['--cache-dir', '/var/cache/hangar/restic', 'stats', '--json', '--mode', 'raw-data']);
    const i = p.guard.stats.indexOf('--mode');
    assert.ok(i > 0, 'the stats command has no --mode at all');
    assert.equal(p.guard.stats[i + 1], 'raw-data');
});

test('the guard lists snapshots and forgets with --prune, leaving the id for run time', () => {
    const p = planFor(repoWithGuard({ limit: '1 TB' }), JOB);
    const CACHE = ['--cache-dir', '/var/cache/hangar/restic'];
    assert.deepEqual(p.guard.snapshots.slice(5), CACHE.concat(['snapshots', '--json']));
    // Forgetting alone frees nothing — it only unlinks the snapshot from its data.
    assert.deepEqual(p.guard.forget.slice(5), CACHE.concat(['forget', '--json', '--prune']));
    // No snapshot id: which one is oldest cannot be known before the previous pass
    // has been measured.
    assert.equal(p.guard.forget.some((a) => /^[0-9a-f]{8,}$/.test(a)), false);
});

test('the plan shows the floor and the iteration budget that will actually apply', () => {
    const dflt = planFor(repoWithGuard({ limit: '500 GB' }), JOB).guard;
    assert.equal(dflt.minSnapshots, Guard.DEFAULTS.minSnapshots);
    assert.equal(dflt.maxIterations, Guard.DEFAULTS.maxIterations);

    const set = planFor(repoWithGuard({ limit: '500 GB', minSnapshots: 7, maxIterations: 2 }),
        JOB).guard;
    assert.equal(set.minSnapshots, 7);
    assert.equal(set.maxIterations, 2);

    // The floor shown is the one that will be enforced, not the one that was
    // asked for: nothing may push it below 1.
    const zero = planFor(repoWithGuard({ limit: '500 GB', minSnapshots: 0 }), JOB).guard;
    assert.equal(zero.minSnapshots, 1);
    assert.equal(zero.minSnapshots, Guard.effectiveFloor(0));

    const junk = planFor(repoWithGuard({ limit: '500 GB', minSnapshots: 'three' }), JOB).guard;
    assert.equal(junk.minSnapshots, Guard.effectiveFloor('three'));
});

test('the limit in the plan agrees with js/core/sizeguard.js on every spelling', () => {
    ['500 GB', '500G', '1.5 TiB', '800M', '2TB', '1024', '  700 gb  '].forEach((limit) => {
        const p = planFor(repoWithGuard({ limit: limit }), JOB);
        assert.equal(p.guard.limitBytes, Guard.parseSize(limit),
            'python and javascript disagree on ' + JSON.stringify(limit));
    });
});

test('an unreadable limit disables the guard with a warning — it does not fail the run', () => {
    // The alternative is worse than it looks: a die() here turns a typo in one
    // optional field into a host with no backups at all. The guard's own rule is
    // that every uncertain input resolves to deleting nothing.
    ['five hundred gigs', '500 GB extra', '1,000 GB', ''].forEach((limit) => {
        const p = planFor(repoWithGuard({ limit: limit }), JOB);
        assert.equal(p.guard, null, JSON.stringify(limit) + ' produced a guard');
        if (limit === '') return;   // an empty limit is "no guard", not a mistake
        const codes = p.warnings.map((w) => w.code);
        assert.ok(codes.includes('limit-unparseable'),
            'no warning for ' + JSON.stringify(limit) + ': ' + JSON.stringify(codes));
    });
});

test('a limit of zero or less is refused as a limit, not obeyed as one', () => {
    ['0', '-1 GB', 0].forEach((limit) => {
        const p = planFor(repoWithGuard({ limit: limit }), JOB);
        assert.equal(p.guard, null);
        assert.ok(p.warnings.some((w) => w.code === 'limit-not-positive'),
            'no warning for ' + JSON.stringify(limit));
    });
});

test('a size guard that is not an object is refused rather than half-read', () => {
    const p = planFor(repoWithGuard('500 GB'), JOB);
    assert.equal(p.guard, null);
    assert.ok(p.warnings.some((w) => w.code === 'guard-not-object'));
});

// ------------------------------------------------- the two implementations agree
//
// hangar-run cannot call into js/core/sizeguard.js, so it copies it. These drive
// both over one corpus — the copy is only safe while this passes.

function pythonAnswers(fn, inputs) {
    const script = [
        'import importlib.util, json, sys',
        'from importlib.machinery import SourceFileLoader',
        'loader = SourceFileLoader("hangar_run", sys.argv[1])',
        'spec = importlib.util.spec_from_loader("hangar_run", loader)',
        'mod = importlib.util.module_from_spec(spec)',
        'loader.exec_module(mod)',
        'data = json.load(sys.stdin)',
        'print(json.dumps([getattr(mod, sys.argv[2])(*args) for args in data]))'
    ].join('\n');
    return JSON.parse(execFileSync('python3', ['-c', script, HELPER, fn], {
        input: JSON.stringify(inputs), encoding: 'utf8'
    }));
}

const SIZE_CASES = [
    '500 GB', '500GB', '500 gb', '500G', '500g', '500 GiB', '1.5 TiB', '800M', '2TB',
    '1024', '0', '-1 GB', '  700 gb  ', '500 B', '500b', '1 PB', '1 PiB', '9 PB',
    '1e3 GB', '0x10', '1,000 GB', '1_000 GB', '500 GB extra', 'GB', '', '   ',
    '500\nGB', '500 GB\n', '500 QB', '500 gigabytes', '.5 GB', '5.', '5..0 GB',
    '+500 GB', '--500 GB', '500 -GB', 'Infinity', 'NaN', '500\tGB', '٥٠٠ GB',
    500, 500.6, -500, 0, 1e21, null, true, false,
    // The exact edge of an exact number. floor(x + 0.5) is not Math.round up
    // here: past 2**52 the "+ 0.5" is not representable and rounds up on its
    // own, so the runner refused the largest limit the editor accepts.
    9007199254740991, '9007199254740991', '9007199254740991B', 9007199254740992,
    '9007199254740992', 4503599627370497, '4503599627370497'
];

test('hangar-run and js/core/sizeguard.js read every size the same way', () => {
    const answers = pythonAnswers('parse_size', SIZE_CASES.map((v) => [v]));
    SIZE_CASES.forEach((value, i) => {
        assert.equal(answers[i], Guard.parseSize(value),
            'python and javascript disagree on ' + JSON.stringify(value));
    });
    // …and the corpus really does exercise both answers, so a parser that returned
    // null for everything could not pass.
    assert.ok(answers.some((a) => a !== null));
    assert.ok(answers.some((a) => a === null));
    assert.equal(answers[SIZE_CASES.indexOf('500 GB')], 500e9);
    assert.equal(answers[SIZE_CASES.indexOf('500 GiB')], 500 * 1024 * 1024 * 1024);
});

test('hangar-run and js/core/sizeguard.js format a size the same way', () => {
    const cases = [0, 1, 999, 1000, 1500, 1999, 2e6, 5.9e6, 2.0e6, 500e9, 1.5e12,
        -5, 9.007199254740991e15, 1e18];
    const answers = pythonAnswers('format_size', cases.map((v) => [v]));
    cases.forEach((value, i) => {
        assert.equal(answers[i], Guard.formatSize(value),
            'disagreement formatting ' + value);
    });
});

// One corpus for planTrim, exercising every branch and, deliberately, the ones
// where an implementation could "helpfully" guess: an unmeasurable size, a shuffled
// list, snapshots with no usable timestamp, a floor that has been reached.
const GB = 1e9;
const TRIM_CASES = [
    // under, at, and over the limit
    { currentBytes: 10 * GB, limitBytes: 500 * GB, snapshots: SNAPS },
    { currentBytes: 500 * GB, limitBytes: 500 * GB, snapshots: SNAPS },
    { currentBytes: 501 * GB, limitBytes: 500 * GB, snapshots: SNAPS, minSnapshots: 1 },
    // the oldest is chosen by TIME, not by position
    { currentBytes: 501 * GB, limitBytes: 500 * GB, minSnapshots: 1,
        snapshots: [SNAPS[2], SNAPS[0], SNAPS[3], SNAPS[1]] },
    { currentBytes: 501 * GB, limitBytes: 500 * GB, minSnapshots: 1,
        snapshots: SNAPS.slice().reverse() },
    // the floor, at and below
    { currentBytes: 501 * GB, limitBytes: 500 * GB, snapshots: SNAPS.slice(0, 3) },
    { currentBytes: 501 * GB, limitBytes: 500 * GB, snapshots: SNAPS, minSnapshots: 4 },
    { currentBytes: 501 * GB, limitBytes: 500 * GB, snapshots: SNAPS, minSnapshots: 0 },
    { currentBytes: 501 * GB, limitBytes: 500 * GB, snapshots: [] },
    // the budget, and the floor winning when both apply
    { currentBytes: 501 * GB, limitBytes: 500 * GB, snapshots: SNAPS, minSnapshots: 1,
        iterations: 20, maxIterations: 20 },
    { currentBytes: 501 * GB, limitBytes: 500 * GB, snapshots: SNAPS, minSnapshots: 4,
        iterations: 20, maxIterations: 20 },
    { currentBytes: 501 * GB, limitBytes: 500 * GB, snapshots: SNAPS, minSnapshots: 1,
        iterations: 0, maxIterations: 0 },
    { currentBytes: 501 * GB, limitBytes: 500 * GB, snapshots: SNAPS, minSnapshots: 1,
        iterations: -3, maxIterations: 'five' },
    // refusals — every one of these must delete nothing
    { currentBytes: 501 * GB, limitBytes: null, snapshots: SNAPS },
    { currentBytes: 501 * GB, limitBytes: '500 GB', snapshots: SNAPS },
    { currentBytes: 501 * GB, limitBytes: 0, snapshots: SNAPS },
    { currentBytes: 501 * GB, limitBytes: -1, snapshots: SNAPS },
    { currentBytes: null, limitBytes: 500 * GB, snapshots: SNAPS },
    { currentBytes: '501 GB', limitBytes: 500 * GB, snapshots: SNAPS },
    { currentBytes: -1, limitBytes: 500 * GB, snapshots: SNAPS },
    // undatable and unnameable snapshots
    { currentBytes: 501 * GB, limitBytes: 500 * GB, minSnapshots: 1,
        snapshots: [{ id: 'a1', time: null }, { id: 'a2', time: '' },
            { id: 'a3' }, { id: 'a4', time: 'yesterday' }] },
    { currentBytes: 501 * GB, limitBytes: 500 * GB, minSnapshots: 1,
        snapshots: [{ id: 'a1', time: 1751328000 }, { id: 'a2', time: 1751328000000 },
            { id: 'a3', time: '2026-07-01T03:00:00+02:00' }, { id: 'a4' }] },
    { currentBytes: 501 * GB, limitBytes: 500 * GB, minSnapshots: 1,
        snapshots: [{ time: '2026-06-01T00:00:00Z' }, { id: '', time: '2026-05-01T00:00:00Z' },
            SNAPS[0], SNAPS[1]] },
    // a tie on time is broken by id, so a shuffle cannot change the answer
    { currentBytes: 501 * GB, limitBytes: 500 * GB, minSnapshots: 1,
        snapshots: [{ id: 'bbbb', time: '2026-07-01T03:00:00Z' },
            { id: 'aaaa', time: '2026-07-01T03:00:00Z' },
            SNAPS[2], SNAPS[3]] },
    { currentBytes: 501 * GB, limitBytes: 500 * GB, minSnapshots: 1,
        snapshots: [{ id: 'aaaa', time: '2026-07-01T03:00:00Z' },
            { id: 'bbbb', time: '2026-07-01T03:00:00Z' },
            SNAPS[2], SNAPS[3]] },
    // timestamp spellings restic and hand-editing produce
    { currentBytes: 501 * GB, limitBytes: 500 * GB, minSnapshots: 1,
        snapshots: [{ id: 'z1', time: '2026-07-01T03:00:00.123456789+02:00' },
            { id: 'z2', time: '2026-07-01T01:00:00Z' },
            { id: 'z3', time: '2026-07-02' }, { id: 'z4', time: '2026-13-01T00:00:00Z' }] },
    { currentBytes: 501 * GB, limitBytes: 500 * GB, minSnapshots: 1,
        snapshots: [{ id: 'z1', time: '2026-02-30T00:00:00Z' },
            { id: 'z2', time: '2026-07-01T00:00:00-05:00' },
            { id: 'z3', time: '2026-07-01T00:00:00+0530' }, { id: 'z4', time: '2026-07-05' }] },
    // things that are not snapshots at all
    { currentBytes: 501 * GB, limitBytes: 500 * GB, minSnapshots: 1,
        snapshots: [null, 'snapshot', 42, [], SNAPS[1], SNAPS[0]] },
    { currentBytes: 501 * GB, limitBytes: 500 * GB, snapshots: 'all of them' },
    {},
    null
];

test('hangar-run and js/core/sizeguard.js plan the same trim for every case', () => {
    const answers = pythonAnswers('plan_trim', TRIM_CASES.map((c) => [c]));
    TRIM_CASES.forEach((cfg, i) => {
        const js = Guard.planTrim(cfg);
        // Round-tripped through JSON so undefined and null compare as the state
        // file will actually carry them.
        assert.deepEqual(answers[i], JSON.parse(JSON.stringify({
            action: js.action, snapshot: js.snapshot === undefined ? null : js.snapshot,
            reason: js.reason, remaining: js.remaining
        })), 'disagreement on case ' + i + ': ' + JSON.stringify(cfg));
    });

    // The corpus is only useful if it reaches every branch.
    const actions = new Set(answers.map((a) => a.action));
    ['none', 'forget', 'floor-reached', 'exhausted'].forEach((a) => {
        assert.ok(actions.has(a), 'the corpus never produces ' + a);
    });
    const reasons = new Set(answers.map((a) => a.reason));
    ['no-limit', 'unknown-size', 'under-limit', 'oldest', 'floor', 'no-snapshots',
        'undatable', 'budget'].forEach((r) => {
        assert.ok(reasons.has(r), 'the corpus never produces ' + r);
    });
});

test('a shuffled snapshot list never changes which snapshot is chosen', () => {
    // Order is the one input an implementation is most tempted to trust, and
    // trusting it is how a guard deletes the newest snapshot.
    const shuffles = [
        SNAPS, SNAPS.slice().reverse(),
        [SNAPS[1], SNAPS[3], SNAPS[0], SNAPS[2]],
        [SNAPS[3], SNAPS[2], SNAPS[1], SNAPS[0]]
    ].map((s) => [{ currentBytes: 2e12, limitBytes: 1e12, snapshots: s, minSnapshots: 1 }]);
    const answers = pythonAnswers('plan_trim', shuffles);
    answers.forEach((a) => {
        assert.equal(a.action, 'forget');
        assert.equal(a.snapshot.id, SNAPS[0].id, 'a shuffle changed the choice');
    });
});

// ------------------------------------------------------------- the run itself

test('a repository under its limit is measured once and nothing else happens', () => {
    // The normal path, every night, forever. It must cost one `stats` and produce
    // no journal noise — an operator who reads a warning every morning stops
    // reading warnings.
    withHost(repoWithGuard({ limit: '500 GB' }), JOB,
        { raw: 10 * GB, grow: GB, snapshots: SNAPS }, (host) => {
            const r = host.run();
            assert.equal(r.status, 0, r.stderr);
            assert.deepEqual(subcommandsOf(host.calls()), ['backup', 'stats'],
                'a run that is not over paid for more than one measurement');
            assert.equal(r.state.status, 'ok');
            assert.equal(r.state.size_guard.action, 'none');
            assert.equal(r.state.size_guard.reason, 'under-limit');
            assert.equal(r.state.size_guard.remaining, 0);
            assert.deepEqual(r.state.size_guard.forgotten, []);
            assert.equal(r.state.size_guard.size_bytes, 11 * GB);
            // Silence. Nothing about the size guard reaches the journal.
            assert.equal(/size limit/.test(r.stderr), false, r.stderr);
            assert.equal(host.repo().snapshots.length, SNAPS.length + 1);
        });
});

test('a repository over its limit loses its oldest snapshots, one pass at a time', () => {
    // 5 snapshots after the backup, 100 GB, limit 70 GB, each forget frees 20 GB:
    // two passes take it to 60 GB.
    withHost(repoWithGuard({ limit: '70 GB', minSnapshots: 1 }), JOB,
        { raw: 100 * GB, grow: 0, free_per_forget: 20 * GB, snapshots: SNAPS }, (host) => {
            const r = host.run();
            assert.equal(r.status, 0, r.stderr);

            const forgets = guardForgets(host.calls());
            assert.equal(forgets.length, 2, 'expected two passes: ' +
                JSON.stringify(subcommandsOf(host.calls())));
            // Oldest first, and exactly one id per call — a batch would overshoot by
            // an amount deduplication makes unknowable.
            assert.equal(forgets[0][forgets[0].length - 1], SNAPS[0].id);
            assert.equal(forgets[1][forgets[1].length - 1], SNAPS[1].id);
            forgets.forEach((argv) => {
                assert.equal(argv.filter((a) => /^[0-9]{64}$/.test(a)).length, 1);
                assert.ok(argv.includes('--prune'), 'a forget without --prune frees nothing');
            });

            // forget -> prune -> measure -> repeat, not measure once and delete a batch.
            const seq = subcommandsOf(host.calls());
            assert.deepEqual(seq, ['backup', 'stats', 'snapshots', 'forget', 'stats',
                'snapshots', 'forget', 'stats']);

            assert.equal(r.state.status, 'ok');
            assert.equal(r.state.size_guard.action, 'none');
            assert.equal(r.state.size_guard.reason, 'under-limit');
            assert.deepEqual(r.state.size_guard.forgotten, [SNAPS[0].short_id, SNAPS[1].short_id]);
            assert.equal(r.state.size_guard.start_bytes, 100 * GB);
            assert.equal(r.state.size_guard.size_bytes, 60 * GB);
            assert.equal(r.state.size_guard.iterations, 2);
            assert.deepEqual(host.repo().snapshots.map((s) => s.id),
                [SNAPS[2].id, SNAPS[3].id, 'f'.repeat(63) + '0']);
        });
});

test('the guard measures raw-data, so a repository under its real limit is left alone', () => {
    // The trap, reproduced end to end: 2.0 MB of repository that `stats` reports as
    // 5.9 MB in its DEFAULT mode. Under a 3 MB limit the correct answer is "do
    // nothing"; a runner using the default would delete until it "fit".
    withHost(repoWithGuard({ limit: '3 MB', minSnapshots: 1 }), JOB,
        { raw: 2.0e6, grow: 0, restore_factor: 2.95, free_per_forget: 1e6, snapshots: SNAPS },
        (host) => {
            const r = host.run();
            assert.equal(r.status, 0, r.stderr);
            assert.deepEqual(guardForgets(host.calls()), [],
                'the guard deleted snapshots that were never the problem — ' +
                'it measured restore size instead of raw data');
            const stats = host.calls().filter((a) => a.includes('stats'));
            stats.forEach((argv) => {
                assert.equal(argv[argv.indexOf('--mode') + 1], 'raw-data');
            });
            assert.equal(r.state.size_guard.size_bytes, 2.0e6);
            assert.equal(r.state.status, 'ok');
        });
});

test('the floor stops the guard, and the run says so instead of claiming success', () => {
    // The outcome the whole module exists to make unreachable: a cap with no floor
    // deletes the last backup whenever the source data alone exceeds it, then
    // reports success because the repository finally fits.
    withHost(repoWithGuard({ limit: '10 GB', minSnapshots: 3 }), JOB,
        { raw: 100 * GB, grow: 0, free_per_forget: GB, snapshots: SNAPS }, (host) => {
            const r = host.run();

            // Never a failed unit: the snapshot was written.
            assert.equal(r.status, 0, r.stderr);
            const forgets = guardForgets(host.calls());
            assert.equal(forgets.length, 2, 'the floor was crossed or never reached');
            assert.equal(host.repo().snapshots.length, 3, 'fewer snapshots than the floor');

            // A distinct status the UI can show. Not "ok".
            assert.equal(r.state.status, 'size-limit-exceeded');
            assert.equal(r.state.size_guard.action, 'floor-reached');
            assert.equal(r.state.size_guard.reason, 'floor');
            assert.equal(r.state.size_guard.remaining, 98 * GB - 10 * GB + 0);
            assert.equal(r.state.size_guard.min_snapshots, 3);

            // And a journal warning naming the shortfall, in words.
            assert.match(r.stderr, /still 82 GiB over its size limit/);
            assert.match(r.stderr, /"reason": "floor"/);

            // The record renders through the one sentence-writer there is, and that
            // sentence must read like a stop, not like a success.
            const sentence = Guard.describeOutcome(r.state.size_guard);
            assert.match(sentence, /^Stopped:/);
            assert.match(sentence, /82 GiB/);
        });
});

test('a floor already reached deletes nothing at all', () => {
    withHost(repoWithGuard({ limit: '10 GB' }), JOB,
        { raw: 100 * GB, grow: 0, free_per_forget: GB, snapshots: SNAPS.slice(0, 2) },
        (host) => {
            const r = host.run();
            assert.equal(r.status, 0, r.stderr);
            // Three snapshots exist after the backup and the default floor is 3.
            assert.deepEqual(guardForgets(host.calls()), []);
            assert.equal(r.state.status, 'size-limit-exceeded');
            assert.equal(r.state.size_guard.reason, 'floor');
            assert.equal(r.state.size_guard.iterations, 0);
        });
});

test('the iteration budget stops the guard and is recorded as exhausted, not as done', () => {
    // prune rewrites repository data; on a remote destination each pass is minutes.
    // A guard with no budget turns a nightly unit into an all-day job.
    withHost(repoWithGuard({ limit: '10 GB', minSnapshots: 1, maxIterations: 2 }), JOB,
        { raw: 100 * GB, grow: 0, free_per_forget: 0, snapshots: SNAPS }, (host) => {
            const r = host.run();
            assert.equal(r.status, 0, r.stderr);
            assert.equal(guardForgets(host.calls()).length, 2, 'the budget was not obeyed');
            assert.equal(r.state.status, 'size-limit-exceeded');
            assert.equal(r.state.size_guard.action, 'exhausted');
            assert.equal(r.state.size_guard.reason, 'budget');
            assert.equal(r.state.size_guard.iterations, 2);
            assert.equal(r.state.size_guard.max_iterations, 2);
            assert.match(r.stderr, /still 83.8 GiB over its size limit/);
            assert.match(Guard.describeOutcome(r.state.size_guard), /^Stopped after/);
        });
});

test('a budget of zero forgets nothing while still reporting the overshoot', () => {
    withHost(repoWithGuard({ limit: '10 GB', minSnapshots: 1, maxIterations: 0 }), JOB,
        { raw: 100 * GB, grow: 0, free_per_forget: 50 * GB, snapshots: SNAPS }, (host) => {
            const r = host.run();
            assert.equal(r.status, 0, r.stderr);
            assert.deepEqual(guardForgets(host.calls()), []);
            assert.equal(r.state.size_guard.reason, 'budget');
            assert.equal(r.state.status, 'size-limit-exceeded');
        });
});

test('an unmeasurable repository deletes nothing and does not fail the run', () => {
    // The input most likely to be wrong in the dangerous direction. "Delete until
    // it fits" is never the answer to "I could not measure it".
    withHost(repoWithGuard({ limit: '10 GB', minSnapshots: 1 }), JOB,
        { raw: 100 * GB, grow: 0, snapshots: SNAPS, fail: { stats: 1 } }, (host) => {
            const r = host.run();
            assert.equal(r.status, 0, r.stderr);
            assert.deepEqual(guardForgets(host.calls()), []);
            assert.deepEqual(subcommandsOf(host.calls()), ['backup', 'stats']);
            assert.equal(r.state.size_guard.action, 'none');
            assert.equal(r.state.size_guard.reason, 'unknown-size');
            assert.equal(r.state.size_guard.start_bytes, null);
            // Nothing was changed, so the run is not reported as over its limit.
            assert.equal(r.state.status, 'ok');
            assert.match(r.stderr, /could not measure the repository size/);
            // The sentence the UI shows must say nothing was changed.
            assert.match(Guard.describeOutcome(r.state.size_guard), /Nothing was changed/);
        });
});

test('a snapshot listing that fails stops the guard without deleting anything', () => {
    withHost(repoWithGuard({ limit: '10 GB', minSnapshots: 1 }), JOB,
        { raw: 100 * GB, grow: 0, snapshots: SNAPS, fail: { snapshots: 1 } }, (host) => {
            const r = host.run();
            assert.equal(r.status, 0, r.stderr);
            assert.deepEqual(guardForgets(host.calls()), []);
            assert.equal(r.state.status, 'size-limit-exceeded');
            assert.equal(r.state.size_guard.reason, 'unknown-size');
            assert.match(r.state.size_guard.error, /snapshots could not be listed/);
            assert.match(r.stderr, /still 83.8 GiB over its size limit/);
        });
});

test('a forget that fails is recorded and warned about, and still exits successfully', () => {
    withHost(repoWithGuard({ limit: '10 GB', minSnapshots: 1 }), JOB,
        { raw: 100 * GB, grow: 0, free_per_forget: 50 * GB, snapshots: SNAPS,
            forget_fails_on: SNAPS[0].id }, (host) => {
            const r = host.run();
            assert.equal(r.status, 0, r.stderr);
            assert.equal(guardForgets(host.calls()).length, 1, 'it kept trying after a failure');
            assert.equal(host.repo().snapshots.length, SNAPS.length + 1, 'a failed forget deleted');
            assert.equal(r.state.status, 'size-limit-exceeded');
            assert.match(r.state.size_guard.error, /failed with exit 1/);
            assert.equal(r.state.size_guard.iterations, 1);
            assert.deepEqual(r.state.size_guard.forgotten, []);
        });
});

test('a snapshot with unreadable files still gets the guard, and stays exit 0', () => {
    // restic exit 3 wrote the snapshot. The guard must run over it, and neither the
    // partial read nor the size shortfall may turn the unit red.
    withHost(repoWithGuard({ limit: '10 GB', minSnapshots: 3 }), JOB,
        { raw: 100 * GB, grow: 0, free_per_forget: 0, snapshots: SNAPS, backup_exit: 3 },
        (host) => {
            const r = host.run();
            assert.equal(r.status, 0, r.stderr);
            assert.equal(r.state.kind, 'READ_ERRORS', 'the partial read was forgotten');
            assert.equal(r.state.exit_code, 3);
            assert.equal(r.state.status, 'size-limit-exceeded');
            assert.equal(r.state.size_guard.reason, 'floor');
        });
});

test('the guard runs after the retention forget, never before it', () => {
    // Retention is the policy the user asked for; the guard only cleans up what
    // that policy did not keep small enough. Reversing them would delete snapshots
    // retention would have removed for free.
    const job = Object.assign({}, JOB, { retention: { daily: 7 } });
    withHost(repoWithGuard({ limit: '10 GB', minSnapshots: 1 }), job,
        { raw: 100 * GB, grow: 0, free_per_forget: 100 * GB, snapshots: SNAPS }, (host) => {
            const r = host.run();
            assert.equal(r.status, 0, r.stderr);
            const calls = host.calls();
            const policyForget = calls.findIndex((a) => a.includes('--keep-daily'));
            const firstStats = calls.findIndex((a) => a.includes('stats'));
            assert.ok(policyForget >= 0, 'the retention forget did not run');
            assert.ok(firstStats > policyForget, 'the guard measured before retention ran');
        });
});

test('a repository with no size guard runs exactly as it did before', () => {
    // The whole existing contract: no measurement, no extra commands, same status.
    const job = Object.assign({}, JOB, { retention: { daily: 7 } });
    withHost(LOCAL_REPO, job, { raw: 100 * GB, snapshots: SNAPS }, (host) => {
        const r = host.run();
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(subcommandsOf(host.calls()), ['backup', 'forget']);
        assert.equal(r.state.status, 'ok');
        assert.equal('size_guard' in r.state, false);
    });
});

test('the empty-retention guard still refuses a policy that would keep nothing', () => {
    // Unrelated to the size guard, and precisely the thing a rewrite of this area
    // could quietly drop.
    const job = Object.assign({}, JOB, { retention: { daily: 0 } });
    withHost(repoWithGuard({ limit: '500 GB' }), job, { raw: 10, snapshots: SNAPS }, (host) => {
        const r = host.run();
        assert.equal(r.status, 1);
        assert.match(r.stderr, /refusing to prune/);
        assert.deepEqual(host.calls(), [], 'it started restic before refusing');
    });
});

test('a SIGTERM while the guard is measuring ends the run cleanly, not in a traceback', async () => {
    // `systemctl stop` during a prune is an ordinary thing an operator does, and
    // prune on a remote repository gives them plenty of time to do it. The backup
    // has already succeeded by then, so the run has to record what it managed and
    // exit — a traceback would report a written snapshot as a crashed unit.
    await withHost(repoWithGuard({ limit: '10 GB', minSnapshots: 1 }), JOB,
        { raw: 100 * GB, grow: 0, snapshots: SNAPS, hang: 'stats' },
        (host) => new Promise((resolve, reject) => {
            const child = require('node:child_process').spawn(
                'python3', [HELPER, JOB.id],
                { env: host.env, stdio: ['ignore', 'pipe', 'pipe'] });
            let stderr = '';
            child.stderr.on('data', (d) => { stderr += d; });
            child.on('error', reject);

            const deadline = Date.now() + 15000;
            const poll = setInterval(() => {
                if (host.calls().some((a) => a.includes('stats'))) {
                    clearInterval(poll);
                    child.kill('SIGTERM');
                } else if (Date.now() > deadline) {
                    clearInterval(poll);
                    child.kill('SIGKILL');
                    reject(new Error('the guard never started measuring'));
                }
            }, 50);

            child.on('exit', (code, signal) => {
                clearInterval(poll);
                try {
                    assert.equal(signal, null, 'the helper was killed instead of unwinding');
                    assert.equal(code, 0, 'a written snapshot was reported as a failure');
                    assert.equal(/Traceback/.test(stderr), false, stderr);
                    const sp = path.join(host.dir, 'state', JOB.id + '.json');
                    const state = JSON.parse(fs.readFileSync(sp, 'utf8'));
                    assert.equal(state.snapshot, 'f'.repeat(63) + '0',
                        'the snapshot that was written is not in the record');
                    assert.match(state.size_guard.error, /interrupted by signal 15/);
                    assert.deepEqual(state.size_guard.forgotten, []);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        }));
});

test('nothing the guard does ever raises', () => {
    // A traceback out of a systemd timer at 03:00 is the failure mode with the
    // fewest clues, so the hostile cases are run for real rather than reasoned about.
    const hostile = [
        { limit: '10 GB', minSnapshots: 'three', maxIterations: null },
        { limit: '10 GB', minSnapshots: -5, maxIterations: -5 },
        { limit: '10 GB', minSnapshots: 1.5, maxIterations: 1e400 },
        { limit: '10 GB', minSnapshots: [], maxIterations: {} },
        { limit: 10e9, minSnapshots: 1, maxIterations: 1 }
    ];
    hostile.forEach((guard) => {
        withHost(repoWithGuard(guard), JOB,
            { raw: 100 * GB, grow: 0, free_per_forget: 0,
                snapshots: SNAPS.concat([{ id: 'x'.repeat(64), time: null }]) },
            (host) => {
                const r = host.run();
                assert.equal(/Traceback/.test(r.stderr), false,
                    'the run raised for ' + JSON.stringify(guard) + ':\n' + r.stderr);
                assert.ok(r.status === 0, 'exit ' + r.status + ' for ' + JSON.stringify(guard));
            });
    });
});

// ======================================================= the shape on disk
//
// The guard's logic was right and it never ran. hangar-run looked for a nested
// `sizeGuard` object; js/features/repos-ui.js has always saved the limit FLAT, as
// `sizeLimit` and `minSnapshots` beside `kind` and `path`, and js/core/repos.js
// reads it there to validate and describe the repository. Nothing wrote the shape
// the runner read, so every size limit configured in the editor was silently
// ignored — and the failure was invisible from both ends, because the editor
// echoed "Understood as 500 GB" and the runner reported a clean backup.
//
// These tests build the repository through the editor's own function rather than
// by hand, which is what the corpus above could not do: a hand-written fixture
// agrees with whatever the runner happens to read, whichever that is.

const ReposUi = require('../../js/features/repos-ui.js');

// Exactly what the editor saves when someone fills in the size section.
function repoAsSaved(form) {
    return ReposUi.formStateToRepo('local', Object.assign(
        { id: 'main', path: '/srv/backup' }, form));
}

test('a repository saved by the editor actually gets a guard', () => {
    const repo = repoAsSaved({ sizeLimit: '500 GB', minSnapshots: '5' });
    // The premise, asserted rather than assumed: this is the flat shape.
    assert.equal(repo.sizeLimit, '500 GB');
    assert.equal(repo.minSnapshots, 5);
    assert.equal(repo.sizeGuard, undefined);

    withHost(repo, JOB, { snapshots: [] }, (host) => {
        const guard = plan(host.dir, JOB.id).guard;
        assert.ok(guard, 'the editor saved a size limit the runner cannot see');
        assert.equal(guard.limit, '500 GB');
        assert.equal(guard.limitBytes, 500 * GB);
        assert.equal(guard.minSnapshots, 5);
        assert.equal(guard.maxIterations, Guard.DEFAULTS.maxIterations);
    });
});

test('a repository saved by the editor is measured and trimmed for real', () => {
    // End to end on the shape that exists on real hosts: over the limit, the
    // oldest goes first, and the run comes back inside the limit.
    withHost(repoAsSaved({ sizeLimit: '70 GB', minSnapshots: '1' }), JOB,
        { raw: 100 * GB, grow: 0, free_per_forget: 20 * GB, snapshots: SNAPS }, (host) => {
            const r = host.run();
            assert.equal(r.status, 0, r.stderr);
            const forgets = guardForgets(host.calls());
            assert.equal(forgets.length, 2);
            assert.ok(forgets[0].includes(SNAPS[0].id), 'did not forget the oldest first');
            assert.ok(forgets[1].includes(SNAPS[1].id));
            assert.equal(r.state.status, 'ok');
            assert.equal(r.state.size_guard.action, 'none');
            assert.equal(r.state.size_guard.reason, 'under-limit');
        });
});

test('the editor\'s floor is the floor the runner applies', () => {
    // The number that stops the deleting has to be the one the user typed. The
    // backup adds a fifth snapshot to the four already there, so a floor of 4
    // permits exactly ONE deletion — while the module's own default of 3, which
    // is what a runner that could not see the user's setting would fall back to,
    // would take two. The count is the assertion.
    withHost(repoAsSaved({ sizeLimit: '1 GB', minSnapshots: '4' }), JOB,
        { raw: 100 * GB, grow: 0, free_per_forget: 0, snapshots: SNAPS }, (host) => {
            const r = host.run();
            assert.equal(r.status, 0, r.stderr);
            const forgets = guardForgets(host.calls());
            assert.equal(forgets.length, 1, 'deleted past the floor the editor showed');
            assert.ok(forgets[0].includes(SNAPS[0].id), 'did not take the oldest');
            assert.equal(r.state.size_guard.min_snapshots, 4);
            assert.equal(r.state.size_guard.reason, 'floor');
            // Still over, and the run says so rather than reporting a clean night.
            assert.equal(r.state.status, 'size-limit-exceeded');
            assert.match(r.stderr, /still .* over its size limit/);
        });
});

test('a floor already reached in the editor\'s shape deletes nothing at all', () => {
    // Four snapshots plus the one this run wrote, and a floor of 5: nothing may
    // go, and the run must say it is still over instead of claiming success.
    withHost(repoAsSaved({ sizeLimit: '1 GB', minSnapshots: '5' }), JOB,
        { raw: 100 * GB, grow: 0, free_per_forget: 0, snapshots: SNAPS }, (host) => {
            const r = host.run();
            assert.equal(r.status, 0, r.stderr);
            assert.deepEqual(guardForgets(host.calls()), [],
                'deleted despite the floor already being reached');
            assert.equal(host.repo().snapshots.length, SNAPS.length + 1);
            assert.equal(r.state.size_guard.reason, 'floor');
            assert.equal(r.state.status, 'size-limit-exceeded');
            assert.match(Guard.describeOutcome(r.state.size_guard), /^Stopped:/);
        });
});

test('a repository the editor saved with no limit still runs without a guard', () => {
    const repo = repoAsSaved({ minSnapshots: '5' });
    assert.equal(repo.sizeLimit, undefined);
    assert.equal(repo.minSnapshots, 5, 'the floor is kept even with no limit');
    withHost(repo, JOB, { snapshots: [] }, (host) => {
        assert.equal(plan(host.dir, JOB.id).guard, null);
        const r = host.run();
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.state.size_guard, undefined);
        assert.deepEqual(subcommandsOf(host.calls()), ['backup']);
    });
});

test('the flat limit wins over a stale nested one', () => {
    // Both present is not a shape anything writes, but a hand-edited file can
    // carry it. The editor's field is the one the user is looking at and the one
    // the next save overwrites, so it is the one that must apply.
    const repo = Object.assign(repoAsSaved({ sizeLimit: '2 GB', minSnapshots: '2' }),
        { sizeGuard: { limit: '900 GB', minSnapshots: 9 } });
    withHost(repo, JOB, { snapshots: [] }, (host) => {
        const guard = plan(host.dir, JOB.id).guard;
        assert.equal(guard.limit, '2 GB');
        assert.equal(guard.minSnapshots, 2);
    });
});

test('a nested guard alone still works, so a hand-written file is not dropped', () => {
    withHost(repoWithGuard({ limit: '3 GB', minSnapshots: 2, maxIterations: 4 }), JOB,
        { snapshots: [] }, (host) => {
            const guard = plan(host.dir, JOB.id).guard;
            assert.equal(guard.limit, '3 GB');
            assert.equal(guard.minSnapshots, 2);
            assert.equal(guard.maxIterations, 4);
        });
});

// ================================================ a hostile limit on disk
//
// The repository file is root-owned, but it is still a file someone edits by
// hand, restores from a backup of /etc, or writes with a script. Every one of
// these must produce a refusal and a warning — never a deletion, and never a
// failed run, because refusing to back up over a typo in one optional field
// leaves the host with no backups at all.

const NUL = '\u0000';

const HOSTILE_ON_DISK = [
    ['a negative size', '-5G'],
    ['a negative number', -5000000000],
    ['an exponent', '1e999'],
    ['letters', 'abc'],
    ['zero', '0'],
    ['zero bytes as a number', 0],
    ['a boolean', true],
    ['an object', { limit: '500 GB' }],
    ['an array', ['500 GB']],
    ['a number past MAX_SAFE_INTEGER', 9007199254740992],
    ['400 digits', '9'.repeat(400)],
    ['a NUL after the unit', '500G' + NUL],
    ['a NUL inside the number', '5' + NUL + '00G'],
    ['a thousands separator', '500,000 GB'],
    ['trailing words', '500GB extra'],
    ['an unknown unit', '500 QB'],
    ['whitespace only', '   '],
    ['a newline in the middle', '500\nGB'],
    ['a very long string', 'x'.repeat(10000)]
];

HOSTILE_ON_DISK.forEach(([what, limit]) => {
    test('a hostile limit on disk refuses and warns, and never deletes — ' + what, () => {
        const repo = Object.assign(repoAsSaved({ minSnapshots: '1' }), { sizeLimit: limit });
        withHost(repo, JOB, { raw: 900 * GB, grow: 0, free_per_forget: 900 * GB,
            snapshots: SNAPS }, (host) => {
            assert.equal(plan(host.dir, JOB.id).guard, null, what + ' produced a guard');
            const r = host.run();
            // The backup still happens. That is the whole point of warning rather
            // than dying: one bad optional field must not cost a night's backup.
            assert.equal(r.status, 0, r.stderr);
            assert.equal(r.state.status, 'ok');
            assert.deepEqual(guardForgets(host.calls()), [], what + ' deleted a snapshot');
            assert.equal(host.repo().snapshots.length, SNAPS.length + 1,
                what + ' lost a snapshot');
            // Nothing was even measured: with no usable limit there is nothing to
            // measure against.
            assert.deepEqual(subcommandsOf(host.calls()), ['backup']);
            assert.match(r.stderr, /size limit/, what + ' passed in silence');
        });
    });
});

test('a limit hangar cannot read is named in the warning, so it can be corrected', () => {
    const repo = Object.assign(repoAsSaved({ minSnapshots: '1' }), { sizeLimit: '500 QB' });
    withHost(repo, JOB, { snapshots: [] }, (host) => {
        const warnings = plan(host.dir, JOB.id).warnings;
        const w = warnings.find((x) => x.code === 'limit-unparseable');
        assert.ok(w, 'no unparseable warning: ' + JSON.stringify(warnings));
        assert.equal(w.limit, '500 QB');
        assert.match(w.message, /no snapshots will be deleted for size/);
    });
});

test('a limit of zero is refused as a limit, not obeyed as one, in the flat shape', () => {
    // The dangerous misreading of zero: "everything is over the limit".
    const repo = Object.assign(repoAsSaved({ minSnapshots: '1' }), { sizeLimit: '0' });
    withHost(repo, JOB, { raw: 900 * GB, grow: 0, free_per_forget: 900 * GB,
        snapshots: SNAPS }, (host) => {
        const warnings = plan(host.dir, JOB.id).warnings;
        assert.ok(warnings.some((x) => x.code === 'limit-not-positive'));
        const r = host.run();
        assert.deepEqual(guardForgets(host.calls()), []);
        assert.equal(r.state.status, 'ok');
    });
});

test('a measurement that fails after a prune stops, and never reports success', () => {
    // The worst moment to lose the measurement: a snapshot has already been
    // deleted, so the guard has done real damage and can no longer say whether it
    // helped. It must stop there, report the overshoot it last knew about, and
    // never let the run come back as a clean night.
    withHost(repoAsSaved({ sizeLimit: '10 GB', minSnapshots: '1' }), JOB,
        { raw: 100 * GB, grow: 0, free_per_forget: 90 * GB, snapshots: SNAPS,
            stats_fails_after: 1 }, (host) => {
            const r = host.run();
            assert.equal(r.status, 0, r.stderr, 'a written snapshot must not fail the unit');
            assert.equal(guardForgets(host.calls()).length, 1, 'it kept deleting blind');
            assert.equal(r.state.size_guard.action, 'none');
            assert.equal(r.state.size_guard.reason, 'unknown-size');
            assert.match(r.state.size_guard.error, /could not be measured after pruning/);
            // The overshoot it last measured, not zero: "we stopped knowing" is
            // not "we finished".
            assert.ok(r.state.size_guard.remaining > 0);
            assert.equal(r.state.status, 'size-limit-exceeded');
            assert.match(r.stderr, /still 83.8 GiB over its size limit/);
            assert.match(Guard.describeOutcome(r.state.size_guard), /Nothing was changed/);
        });
});

test('a prune that fails on the second pass stops there, still over and saying so', () => {
    // The first forget works, the second is refused. The guard must not keep
    // hammering a repository that will not let go of anything.
    withHost(repoAsSaved({ sizeLimit: '10 GB', minSnapshots: '1' }), JOB,
        { raw: 100 * GB, grow: 0, free_per_forget: 5 * GB, snapshots: SNAPS,
            forget_fails_on: SNAPS[1].id }, (host) => {
            const r = host.run();
            assert.equal(r.status, 0, r.stderr);
            assert.equal(guardForgets(host.calls()).length, 2);
            assert.equal(r.state.size_guard.forgotten.length, 1);
            assert.match(r.state.size_guard.error, /failed with exit 1/);
            assert.equal(r.state.status, 'size-limit-exceeded');
            assert.match(r.stderr, /still .* over its size limit/);
        });
});

// --- the size the guard measured is left where the Overview can find it -----
//
// `restic stats` costs fifty seconds to two minutes against a remote repository.
// The size guard pays that every night anyway, so the number it gets is written
// to the same file js/core/reposize.js reads — a machine that backs up nightly
// then has a fresh size on screen without anyone ever waiting for one.
//
// The risk being tested for is a cache that lies: a size recorded from the wrong
// mode, from before a trim, or for a repository whose measurement failed.

function sizeCache(host, repoId) {
    const p = path.join(host.dir, 'state', 'size-' + (repoId || 'main') + '.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

test('a guarded run records the size and the snapshot count for the Overview', () => {
    const before = Date.now();
    withHost(repoWithGuard({ limit: '500 GB' }), JOB,
        { raw: 10 * GB, grow: GB, snapshots: SNAPS }, (host) => {
            assert.equal(host.run().status, 0);
            const c = sizeCache(host);
            assert.ok(c, 'the guard measured, so the size must have been recorded');
            assert.equal(c.size, 11 * GB, 'raw-data, the same number the guard used');
            assert.equal(c.snapshots, SNAPS.length + 1, 'including tonight\'s');
            // Milliseconds, because the browser reads it with Date.
            assert.ok(c.at >= before && c.at <= Date.now() + 1000,
                'the timestamp is when it was measured, in ms: ' + c.at);
        });
});

test('the recorded size is the one AFTER a trim, not the one that triggered it', () => {
    // 5 snapshots at 100 GB, limit 70 GB, 20 GB freed per forget: two passes end
    // at 60 GB. Recording 100 GB here would put the pre-trim size on screen and
    // leave the operator believing the guard did nothing.
    withHost(repoWithGuard({ limit: '70 GB', minSnapshots: 1 }), JOB,
        { raw: 99 * GB, grow: GB, snapshots: SNAPS, free_per_forget: 20 * GB },
        (host) => {
            assert.equal(host.run().status, 0);
            const c = sizeCache(host);
            assert.equal(c.size, 60 * GB);
            assert.equal(c.snapshots, 3, 'and the count the trim left behind');
        });
});

test('the recorded size is world-readable, since the browser is not root', () => {
    withHost(repoWithGuard({ limit: '500 GB' }), JOB,
        { raw: 10 * GB, snapshots: SNAPS }, (host) => {
            assert.equal(host.run().status, 0);
            const p = path.join(host.dir, 'state', 'size-main.json');
            // hangar-run writes this as root from a systemd unit; the Overview
            // reads it as the logged-in user. 0600 would make the whole cache
            // invisible to the one thing that uses it.
            assert.equal(fs.statSync(p).mode & 0o777, 0o644);
        });
});

test('a repository with no size guard records nothing rather than a guess', () => {
    // Nothing measured it, so there is nothing to remember. Writing a zero, or
    // last night's number with tonight's date, would be worse than no file.
    withHost(LOCAL_REPO, JOB, { raw: 10 * GB, snapshots: SNAPS }, (host) => {
        assert.equal(host.run().status, 0);
        assert.equal(sizeCache(host), null);
        assert.deepEqual(subcommandsOf(host.calls()), ['backup'],
            'and nothing was measured for its own sake');
    });
});

test('a failed measurement leaves no size behind', () => {
    withHost(repoWithGuard({ limit: '500 GB' }), JOB,
        { raw: 10 * GB, snapshots: SNAPS, fail: { stats: true } }, (host) => {
            const r = host.run();
            assert.equal(r.status, 0, 'a failed guard never fails the backup');
            assert.equal(r.state.size_guard.reason, 'unknown-size');
            assert.equal(sizeCache(host), null, 'and it must not cache an unknown');
        });
});

test('a stale recorded size is replaced, not left beside a newer one', () => {
    withHost(repoWithGuard({ limit: '500 GB' }), JOB,
        { raw: 10 * GB, grow: GB, snapshots: SNAPS }, (host) => {
            const dir = path.join(host.dir, 'state');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'size-main.json'),
                JSON.stringify({ size: 1, snapshots: 1, at: 1 }));
            assert.equal(host.run().status, 0);
            const c = sizeCache(host);
            assert.equal(c.size, 11 * GB);
            assert.ok(c.at > 1);
        });
});

test('the file hangar-run writes is the file js/core/reposize.js reads', () => {
    // Two implementations, one contract. The JS side names the path and vets the
    // shape; if either drifts the Overview silently stops finding the size and
    // goes back to costing a minute a visit.
    const RepoSize = require('../../js/core/reposize.js');
    withHost(repoWithGuard({ limit: '500 GB' }), JOB,
        { raw: 10 * GB, grow: GB, snapshots: SNAPS }, (host) => {
            assert.equal(host.run().status, 0);
            const written = path.join(host.dir, 'state', 'size-main.json');
            // Same name, module-independent of HANGAR_STATE_DIR.
            assert.equal(path.basename(RepoSize.sizePath('main')), path.basename(written));
            const raw = JSON.parse(fs.readFileSync(written, 'utf8'));
            assert.deepEqual(RepoSize.normalize(raw),
                { size: 11 * GB, snapshots: SNAPS.length + 1, at: raw.at },
                'the JS side must accept it as a measurement, not reject its shape');
            assert.equal(RepoSize.isStale(raw, raw.at + 1000), false, 'and call it fresh');
        });
});
