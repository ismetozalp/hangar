// Integration tests for libexec/hangar-run (python3).
//
// hangar-run duplicates a small amount of logic from js/core (repository URL
// construction, retention args) because it must work with no Cockpit session
// present. Duplication is only safe if it is policed, so these tests drive the
// helper's --print-plan mode and assert it agrees with the JavaScript modules.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELPER = path.join(__dirname, '..', '..', 'libexec', 'hangar-run');
const Repos = require('../../js/core/repos.js');
const Retention = require('../../js/core/retention.js');

function withConfig(repos, jobs, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-test-'));
    try {
        fs.mkdirSync(path.join(dir, 'repos'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
        for (const r of repos)
            fs.writeFileSync(path.join(dir, 'repos', r.id + '.json'), JSON.stringify(r));
        for (const j of jobs)
            fs.writeFileSync(path.join(dir, 'jobs', j.id + '.json'), JSON.stringify(j));
        return fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function plan(dir, jobId) {
    const out = execFileSync('python3', [HELPER, jobId, '--print-plan'], {
        env: Object.assign({}, process.env, { HANGAR_CONF_DIR: dir, CREDENTIALS_DIRECTORY: '' }),
        encoding: 'utf8'
    });
    return JSON.parse(out);
}

function runExpectFailure(dir, jobId) {
    try {
        execFileSync('python3', [HELPER, jobId, '--print-plan'], {
            env: Object.assign({}, process.env, { HANGAR_CONF_DIR: dir }),
            encoding: 'utf8', stdio: 'pipe'
        });
        return null;
    } catch (e) {
        return { code: e.status, stderr: String(e.stderr || '') };
    }
}

const LOCAL_REPO = { id: 'main', kind: 'local', path: '/srv/backup' };
const SIMPLE_JOB = {
    id: 'nightly', repo: 'main',
    sources: [{ kind: 'filesystem', paths: ['/home', '/etc'], excludes: ['*.tmp'] }],
    retention: { hourly: 24, daily: 30, weekly: 52, monthly: 12 }
};

test('builds a backup command for a local repository', () => {
    withConfig([LOCAL_REPO], [SIMPLE_JOB], (dir) => {
        const p = plan(dir, 'nightly');
        assert.deepEqual(p.backup.slice(0, 2), ['restic', '-r']);
        assert.equal(p.backup[2], '/srv/backup');
        assert.ok(p.backup.includes('backup'));
        assert.ok(p.backup.includes('--json'));
        assert.ok(p.backup.includes('/home'));
        assert.ok(p.backup.includes('/etc'));
        assert.ok(p.backup.includes('--exclude'));
        assert.ok(p.backup.includes('*.tmp'));
    });
});

test('password file falls back to the on-disk key when no credential is present', () => {
    withConfig([LOCAL_REPO], [SIMPLE_JOB], (dir) => {
        const p = plan(dir, 'nightly');
        const i = p.backup.indexOf('--password-file');
        assert.ok(i > 0);
        assert.equal(p.backup[i + 1], path.join(dir, 'repos', 'main.key'));
    });
});

test('forget command carries the retention policy and --prune', () => {
    withConfig([LOCAL_REPO], [SIMPLE_JOB], (dir) => {
        const p = plan(dir, 'nightly');
        assert.ok(p.forget.includes('forget'));
        assert.ok(p.forget.includes('--keep-hourly'));
        assert.ok(p.forget.includes('24'));
        assert.ok(p.forget.includes('--group-by'));
        assert.ok(p.forget.includes('host,paths'));
        // One command: forget takes an exclusive lock of its own, so splitting
        // --prune out of it only adds a second operation to be blocked.
        assert.ok(p.forget.includes('--prune'));
    });
});

test('retention args agree with js/core/retention.js', () => {
    // The contract this whole file exists to police.
    withConfig([LOCAL_REPO], [SIMPLE_JOB], (dir) => {
        const p = plan(dir, 'nightly');
        const jsArgs = Retention.toArgs(SIMPLE_JOB.retention);
        const pyArgs = p.forget.slice(p.forget.indexOf('--prune') + 1);
        assert.deepEqual(pyArgs, jsArgs,
            'python and javascript disagree on retention args');
    });
});

test('repository URLs agree with js/core/repos.js for every backend', () => {
    const backends = [
        { id: 'r-local',  kind: 'local',  path: '/srv/b' },
        { id: 'r-sftp',   kind: 'sftp',   user: 'bak', host: 'nas.lan', path: '/vol/b' },
        { id: 'r-rest',   kind: 'rest',   url: 'https://rest.lan:8000/' },
        { id: 'r-s3',     kind: 's3',     endpoint: 's3.eu-west-1.amazonaws.com', bucket: 'buck' },
        // 'prefix' (a key prefix inside a bucket) is deliberately a different field
        // from 'path' (a filesystem path). Conflating them is the drift this test
        // caught between the JS and Python implementations.
        { id: 'r-b2',     kind: 'b2',     bucket: 'buck', prefix: 'p' },
        { id: 'r-azure',  kind: 'azure',  container: 'cont', prefix: 'p' },
        { id: 'r-gs',     kind: 'gs',     bucket: 'buck', prefix: 'p' },
        { id: 'r-rclone', kind: 'rclone', remote: 'wasabi', prefix: 'p' },
        // Empty prefixes must not produce a trailing colon.
        { id: 'r-b2-bare',     kind: 'b2',     bucket: 'buck' },
        { id: 'r-rclone-bare', kind: 'rclone', remote: 'wasabi' },
        { id: 's3-prefixed',   kind: 's3', endpoint: 's3.amazonaws.com', bucket: 'b', prefix: 'hosts/db01' }
    ];
    // Keyed on the repo id, not the kind — several kinds appear more than once here.
    const jobs = backends.map((r) => ({
        id: 'j-' + r.id, repo: r.id,
        sources: [{ kind: 'filesystem', paths: ['/home'] }],
        retention: { daily: 7 }
    }));

    withConfig(backends, jobs, (dir) => {
        for (const r of backends) {
            const p = plan(dir, 'j-' + r.id);
            assert.equal(p.backup[2], Repos.buildUrl(r),
                'URL mismatch for repository ' + r.id + ' (kind ' + r.kind + ')');
        }
    });
});

test('a job with no retention policy produces no forget command', () => {
    const job = Object.assign({}, SIMPLE_JOB, { id: 'noret', retention: null });
    withConfig([LOCAL_REPO], [job], (dir) => {
        assert.equal(plan(dir, 'noret').forget, null);
    });
});

test('a retention policy that keeps nothing is refused, not silently obeyed', () => {
    // Running `forget` with no --keep flags would delete every snapshot. This is the
    // most destructive possible bug in a backup tool, so it must fail loudly.
    const job = Object.assign({}, SIMPLE_JOB, { id: 'empty', retention: { daily: 0 } });
    withConfig([LOCAL_REPO], [job], (dir) => {
        const res = runExpectFailure(dir, 'empty');
        assert.ok(res, 'helper should have exited non-zero');
        assert.equal(res.code, 1);
        assert.match(res.stderr, /keep no snapshots/);
    });
});

test('a job with no paths is refused', () => {
    const job = { id: 'nopaths', repo: 'main', sources: [{ kind: 'filesystem', paths: [] }] };
    withConfig([LOCAL_REPO], [job], (dir) => {
        const res = runExpectFailure(dir, 'nopaths');
        assert.equal(res.code, 1);
        assert.match(res.stderr, /no paths/);
    });
});

test('an unsupported source kind is refused rather than silently skipped', () => {
    // Silently ignoring a kind the helper does not implement would produce a backup
    // that looks successful while containing nothing the user asked for. ('libvirt'
    // was the example here until v2 implemented it; the invariant is the same.)
    const job = { id: 'vm', repo: 'main', sources: [{ kind: 'zfs-dataset', paths: ['/x'] }] };
    withConfig([LOCAL_REPO], [job], (dir) => {
        const res = runExpectFailure(dir, 'vm');
        assert.equal(res.code, 1);
        assert.match(res.stderr, /unsupported source kind/);
    });
});

test('a missing job file is a configuration error', () => {
    withConfig([LOCAL_REPO], [], (dir) => {
        const res = runExpectFailure(dir, 'ghost');
        assert.equal(res.code, 1);
        assert.match(res.stderr, /not found/);
    });
});

test('malformed job JSON is reported as a config error, not a crash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-test-'));
    try {
        fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'repos'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'jobs', 'bad.json'), '{ not json');
        const res = runExpectFailure(dir, 'bad');
        assert.equal(res.code, 1);
        assert.match(res.stderr, /not valid JSON/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a job naming a nonexistent repository is a configuration error', () => {
    const job = Object.assign({}, SIMPLE_JOB, { id: 'orphan', repo: 'gone' });
    withConfig([], [job], (dir) => {
        const res = runExpectFailure(dir, 'orphan');
        assert.equal(res.code, 1);
    });
});

test('backend credentials are exported as environment, never as CLI arguments', () => {
    // Anything on argv is visible in `ps` to every user on the box.
    const repo = Object.assign({}, LOCAL_REPO, {
        id: 'main',
        credentials: { AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'shhh' }
    });
    withConfig([repo], [SIMPLE_JOB], (dir) => {
        const p = plan(dir, 'nightly');
        assert.equal(p.env.AWS_ACCESS_KEY_ID, 'AKIA');
        assert.equal(p.env.AWS_SECRET_ACCESS_KEY, 'shhh');
        assert.ok(!p.backup.join(' ').includes('shhh'));
        assert.ok(!(p.forget || []).join(' ').includes('shhh'));
    });
});

test('per-source and per-job tags both reach the backup command', () => {
    const job = {
        id: 'tagged', repo: 'main', tags: ['nightly'],
        sources: [{ kind: 'filesystem', paths: ['/home'], tags: ['home'] }],
        retention: { daily: 7 }
    };
    withConfig([LOCAL_REPO], [job], (dir) => {
        const p = plan(dir, 'tagged');
        assert.ok(p.backup.includes('home'));
        assert.ok(p.backup.includes('nightly'));
    });
});

test('oneFileSystem and excludeFile are honoured', () => {
    const job = {
        id: 'flags', repo: 'main',
        sources: [{
            kind: 'filesystem', paths: ['/'], oneFileSystem: true,
            excludeFile: '/etc/hangar/excludes.txt'
        }],
        retention: { daily: 7 }
    };
    withConfig([LOCAL_REPO], [job], (dir) => {
        const p = plan(dir, 'flags');
        assert.ok(p.backup.includes('--one-file-system'));
        assert.ok(p.backup.includes('--exclude-file'));
        assert.ok(p.backup.includes('/etc/hangar/excludes.txt'));
    });
});

test('paths containing spaces and unicode survive as single argv entries', () => {
    const job = {
        id: 'weird', repo: 'main',
        sources: [{ kind: 'filesystem', paths: ['/home/a b', '/srv/veriler/çöp'] }],
        retention: { daily: 7 }
    };
    withConfig([LOCAL_REPO], [job], (dir) => {
        const p = plan(dir, 'weird');
        assert.ok(p.backup.includes('/home/a b'));
        assert.ok(p.backup.includes('/srv/veriler/çöp'));
    });
});

test('the systemd credential is preferred over the on-disk key when present', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-test-'));
    const creds = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-creds-'));
    try {
        fs.mkdirSync(path.join(dir, 'repos'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'repos', 'main.json'), JSON.stringify(LOCAL_REPO));
        fs.writeFileSync(path.join(dir, 'jobs', 'nightly.json'), JSON.stringify(SIMPLE_JOB));
        fs.writeFileSync(path.join(creds, 'hangar-repo-main'), 'secret');

        const out = execFileSync('python3', [HELPER, 'nightly', '--print-plan'], {
            env: Object.assign({}, process.env, {
                HANGAR_CONF_DIR: dir, CREDENTIALS_DIRECTORY: creds
            }),
            encoding: 'utf8'
        });
        const p = JSON.parse(out);
        const i = p.backup.indexOf('--password-file');
        assert.equal(p.backup[i + 1], path.join(creds, 'hangar-repo-main'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(creds, { recursive: true, force: true });
    }
});

// --- the unwind survives the run being killed -------------------------------
//
// The rest of this file drives --print-plan, which is a dry run. These two
// spawn the helper for real against stub binaries, because what is being tested
// is what happens to a container when the process is stopped mid-backup — and
// that is not visible in a plan.
//
// `systemctl stop`, a unit that overruns TimeoutStartSec, and a host shutdown
// during a nightly run all deliver SIGTERM. Python's default disposition for it
// kills the process outright, with no `finally` — so the container that was
// stopped for the copy is never started again. A database left down because a
// backup was interrupted is the one outcome the design calls worse than a
// failed backup, and an operator reaches it by typing an ordinary command.

const { spawn } = require('node:child_process');

const KILLABLE_JOB = {
    id: 'vols', repo: 'main', retention: { daily: 7 },
    sources: [{
        id: 'db', kind: 'container', volumes: ['pgdata'],
        user: 'root', consistency: 'stop', containers: ['postgres']
    }]
};

// Answers `volume inspect` the way both runtimes really do (a JSON array) and
// logs every call, so the unwind can be asserted rather than assumed.
const PODMAN_STUB = `#!/bin/sh
echo "podman $*" >> "$HANGAR_TEST_CMD_LOG"
if [ "$1" = "volume" ] && [ "$2" = "inspect" ]; then
  printf '[{"Name":"%s","Mountpoint":"/stub/%s/_data"}]\\n' "$3" "$3"
fi
exit 0
`;

// A backup that never finishes on its own. The signal is what ends this run.
// `exec` matters: without it the shell stays as an extra layer, hangar-run's
// kill lands on the shell, and the orphaned sleep keeps the inherited stdout
// pipe open — which would hang the test runner rather than the helper.
const RESTIC_STUB_HANGS = `#!/bin/sh
echo "restic $*" >> "$HANGAR_TEST_CMD_LOG"
exec sleep 60
`;

// Async on purpose: these two tests await a signalled child, so a synchronous
// finally would delete the stub directory out from under the run it set up.
async function withStubHost(job, stubs, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-sig-'));
    try {
        fs.mkdirSync(path.join(dir, 'repos'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
        const bin = path.join(dir, 'bin');
        fs.mkdirSync(bin, { recursive: true });
        fs.writeFileSync(path.join(dir, 'repos', 'main.json'), JSON.stringify(LOCAL_REPO));
        fs.writeFileSync(path.join(dir, 'jobs', job.id + '.json'), JSON.stringify(job));
        for (const [name, body] of Object.entries(stubs)) {
            fs.writeFileSync(path.join(bin, name), body);
            fs.chmodSync(path.join(bin, name), 0o755);
        }
        const log = path.join(dir, 'commands.log');
        fs.writeFileSync(log, '');
        return await fn({
            dir,
            env: Object.assign({}, process.env, {
                HANGAR_CONF_DIR: dir,
                HANGAR_STATE_DIR: path.join(dir, 'state'),
                CREDENTIALS_DIRECTORY: '',
                HANGAR_TEST_CMD_LOG: log,
                PATH: bin + ':' + process.env.PATH
            }),
            commands: () => fs.readFileSync(log, 'utf8').split('\n').filter((l) => l !== ''),
            state: () => {
                const p = path.join(dir, 'state', job.id + '.json');
                return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
            }
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// Starts the helper, waits until the log shows restic is running, then delivers
// `sig` and resolves with the exit status. Polling the log rather than sleeping
// a fixed time: the point is to arrive while the backup is in flight.
function runAndSignal(host, sig) {
    return new Promise((resolve, reject) => {
        const child = spawn('python3', [HELPER, 'vols'],
            { env: host.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', reject);
        child.on('exit', (code, signal) => resolve({ code, signal, stderr }));

        const deadline = Date.now() + 15000;
        const poll = setInterval(() => {
            if (host.commands().some((c) => c.startsWith('restic '))) {
                clearInterval(poll);
                child.kill(sig);
            } else if (Date.now() > deadline) {
                clearInterval(poll);
                child.kill('SIGKILL');
                reject(new Error('restic never started'));
            }
        }, 50);
    });
}

test('a container stopped for the backup is started again when the run is killed', async () => {
    await withStubHost(KILLABLE_JOB, { podman: PODMAN_STUB, restic: RESTIC_STUB_HANGS },
        async (host) => {
            const result = await runAndSignal(host, 'SIGTERM');
            const commands = host.commands();

            assert.ok(commands.includes('podman stop postgres'),
                'the test never got as far as stopping the container');
            assert.ok(commands.includes('podman start postgres'),
                'SIGTERM left the container stopped: ' + JSON.stringify(commands));
            // Order matters: starting it again before the backup was abandoned
            // would mean the copy ran against a running database after all.
            assert.ok(commands.indexOf('podman start postgres') >
                commands.findIndex((c) => c.startsWith('restic ')));

            // Reported as what it was, and by exiting rather than by dying.
            assert.equal(result.signal, null, 'the helper was killed instead of unwinding');
            assert.equal(result.code, 2);
            assert.match(result.stderr, /backup was interrupted/);
            assert.match(result.stderr, /"kind": "CANCELLED"/);

            // The state marker is what the Jobs screen reads once the journal has
            // rotated, so an interrupted run must leave one.
            const state = host.state();
            assert.ok(state, 'no state file was written for the interrupted run');
            assert.equal(state.kind, 'CANCELLED');
            assert.equal(state.exit_code, 130);
        });
});

test('the same holds for SIGINT, which is what a hand-run helper gets', async () => {
    await withStubHost(KILLABLE_JOB, { podman: PODMAN_STUB, restic: RESTIC_STUB_HANGS },
        async (host) => {
            const result = await runAndSignal(host, 'SIGINT');
            assert.ok(host.commands().includes('podman start postgres'),
                'Ctrl-C left the container stopped');
            assert.equal(result.signal, null);
            assert.equal(result.code, 2);
        });
});

test('a forget that emits a JSON document instead of JSON lines does not crash the run', () => {
    // Found by running hangar for real, not by review. `restic forget --json` emits a
    // single JSON ARRAY, while backup emits JSON *lines* — and the runner streams
    // both through one reader. Calling .get() on a list raised AttributeError AFTER
    // the snapshot had been written, and the handler that kills restic on an early
    // exit then stranded an exclusive lock, so every later run failed REPO_LOCKED
    // until a human ran `restic unlock`. A nightly job would have broken permanently
    // the first time retention ran.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-forget-'));
    const bin = path.join(dir, 'bin');
    try {
        fs.mkdirSync(bin, { recursive: true });
        // A restic stand-in that answers backup with JSON lines and forget with the
        // document form, exactly as the real one does.
        fs.writeFileSync(path.join(bin, 'restic'),
            '#!/bin/sh\n' +
            'for a in "$@"; do [ "$a" = "forget" ] && { printf \'[{"tags":null,"keep":[],"remove":[]}]\\n\'; exit 0; }; done\n' +
            'printf \'{"message_type":"summary","snapshot_id":"deadbeef","files_new":1}\\n\'\n' +
            'exit 0\n', { mode: 0o755 });

        fs.mkdirSync(path.join(dir, 'repos'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'repos', 'main.json'), JSON.stringify(LOCAL_REPO));
        fs.writeFileSync(path.join(dir, 'jobs', 'nightly.json'), JSON.stringify(SIMPLE_JOB));

        const r = require('node:child_process').spawnSync('python3', [HELPER, 'nightly'], {
            env: Object.assign({}, process.env, {
                HANGAR_CONF_DIR: dir,
                HANGAR_STATE_DIR: path.join(dir, 'state'),
                PATH: bin + ':' + process.env.PATH
            }),
            encoding: 'utf8'
        });

        assert.equal(r.status, 0, `run failed: ${r.stderr}`);
        assert.ok(!/Traceback/.test(r.stderr), `the run raised:\n${r.stderr}`);
        assert.ok(!/AttributeError/.test(r.stderr), 'the list-vs-dict crash is back');

        // The run must be recorded as a clean success, not merely "did not crash".
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'nightly.json'), 'utf8'));
        assert.equal(state.status, 'ok');
        assert.equal(state.exit_code, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// --- an expired cloud destination is recorded, not just failed ---------------
//
// restic spawns rclone for an `rclone:` repository, so when the destination's
// authorisation lapses the evidence is a line in RESTIC's stderr and nothing
// else — there is no exit code for it. These tests run the helper for real
// against a restic stand-in that fails the way a real one does at 03:00, and
// assert the state file the UI reads in the morning says which failure it was.
//
// The stubs' stderr is the wording rclone and the providers really produce.

const Rclone = require('../../js/core/rclone.js');
const Restic = require('../../js/engine/restic.js');

const RCLONE_REPO = { id: 'main', kind: 'rclone', remote: 'gdrive', prefix: 'backups' };

// A restic that fails the way one does when rclone's token has expired.
const RESTIC_STUB_EXPIRED = '#!/bin/sh\n' +
    "cat >&2 <<'EOS'\n" +
    '2026/07/31 03:00:12 ERROR : backups/db: Failed to copy: failed to open source object: ' +
    'couldn\'t fetch token - maybe it has expired? - refresh with "rclone config reconnect gdrive:"\n' +
    '{"message_type":"exit_error","code":1,"message":"backup failed"}\n' +
    'EOS\n' +
    'exit 1\n';

// The counter-example: same exit code, same HTTP-ish shape, entirely different
// cause. Re-authorising would not free a byte of quota.
const RESTIC_STUB_QUOTA = '#!/bin/sh\n' +
    "echo '403: User Rate Limit Exceeded, userRateLimitExceeded' >&2\n" +
    'exit 1\n';

// A snapshot that WAS written, with an unreadable file — and an expiry-shaped
// line in the noise. Exit 3 must stay exit 3.
const RESTIC_STUB_READ_ERRORS = '#!/bin/sh\n' +
    'printf \'{"message_type":"summary","snapshot_id":"deadbeef","files_new":1}\\n\'\n' +
    'echo "couldn\'t fetch token - maybe it has expired?" >&2\n' +
    'exit 3\n';

function runWithStubRestic(repo, job, stub) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-auth-'));
    const bin = path.join(dir, 'bin');
    try {
        fs.mkdirSync(bin, { recursive: true });
        fs.mkdirSync(path.join(dir, 'repos'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'repos', repo.id + '.json'), JSON.stringify(repo));
        fs.writeFileSync(path.join(dir, 'jobs', job.id + '.json'), JSON.stringify(job));
        fs.writeFileSync(path.join(bin, 'restic'), stub, { mode: 0o755 });

        const r = require('node:child_process').spawnSync('python3', [HELPER, job.id], {
            env: Object.assign({}, process.env, {
                HANGAR_CONF_DIR: dir,
                HANGAR_STATE_DIR: path.join(dir, 'state'),
                CREDENTIALS_DIRECTORY: '',
                PATH: bin + ':' + process.env.PATH
            }),
            encoding: 'utf8'
        });
        const statePath = path.join(dir, 'state', job.id + '.json');
        return {
            status: r.status,
            stderr: r.stderr || '',
            state: fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null
        };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('an expired destination is recorded as AUTH_EXPIRED in the state file', () => {
    // This is what makes the failure survivable: the UI can show an expired
    // destination in the morning without re-running the backup to find out.
    const job = Object.assign({}, SIMPLE_JOB, { id: 'nightly', repo: 'main' });
    const r = runWithStubRestic(RCLONE_REPO, job, RESTIC_STUB_EXPIRED);

    assert.ok(r.state, 'no state file was written for the failed run');
    assert.equal(r.state.kind, 'AUTH_EXPIRED');
    assert.equal(r.state.status, 'failed');
    assert.equal(r.state.exit_code, 1);
    assert.ok(!/Traceback/.test(r.stderr), 'the run raised:\n' + r.stderr);
});

test('the exit contract is preserved — an expired destination is still exit 2', () => {
    // A recoverable failure is still a failure. The unit must fail, or nothing
    // downstream (systemd, a monitoring check, an operator) ever notices.
    const job = Object.assign({}, SIMPLE_JOB, { id: 'nightly', repo: 'main' });
    const r = runWithStubRestic(RCLONE_REPO, job, RESTIC_STUB_EXPIRED);
    assert.equal(r.status, 2);
    // …and the journal says it in words, not only as a kind.
    assert.match(r.stderr, /authorisation has expired/);
    assert.match(r.stderr, /"kind": "AUTH_EXPIRED"/);
});

test('a quota refusal with the same exit code is NOT recorded as expired', () => {
    // The false positive that matters: it would send the operator to re-authorise
    // a destination that authenticated perfectly, and hide the real cause.
    const job = Object.assign({}, SIMPLE_JOB, { id: 'nightly', repo: 'main' });
    const r = runWithStubRestic(RCLONE_REPO, job, RESTIC_STUB_QUOTA);
    assert.equal(r.status, 2);
    assert.equal(r.state.kind, 'GENERIC');
    assert.equal(/AUTH_EXPIRED/.test(r.stderr), false);
});

test('a written snapshot stays a success even with an expiry-shaped line in the noise', () => {
    // restic exit 3 WROTE the snapshot. Reclassifying it as a fatal expiry would
    // report a backup that happened as one that did not — the one direction of
    // error that costs the most trust.
    const job = { id: 'partial', repo: 'main', retention: null,
        sources: [{ kind: 'filesystem', paths: ['/etc'] }] };
    const r = runWithStubRestic(RCLONE_REPO, job, RESTIC_STUB_READ_ERRORS);
    assert.equal(r.status, 0);
    assert.equal(r.state.status, 'partial');
    assert.equal(r.state.kind, 'READ_ERRORS');
    assert.equal(r.state.snapshot, 'deadbeef');
});

// --- the two implementations of the signal must not drift -------------------
//
// hangar-run duplicates isAuthExpired from js/core/rclone.js because it has to
// run with no Cockpit session and no node present. Duplication is only safe if
// it is policed, so this drives both over the same table — including the whole
// false-positive half, which is the half that costs a user a pointless
// re-authorisation if the two ever disagree.

const SIGNAL_CASES = [
    // Expiry, as rclone and the providers really word it.
    ["couldn't fetch token - maybe it has expired?", true],
    ['refresh with "rclone config reconnect gdrive:"', true],
    ['oauth2: token expired and refresh token is not set', true],
    ['{"error":"invalid_grant","error_description":"Token has been expired or revoked."}', true],
    ['AADSTS700082: The refresh token has expired due to inactivity.', true],
    ['Refresh token has expired', true],
    ['{"error_summary":"expired_access_token/..."}', true],
    ['401 Unauthorized: the bearer token is no longer accepted', true],
    ['googleapi: Error 401: Expected OAuth 2 access token, ..., unauthorized', true],
    ['INVALID_GRANT', true],
    // Not expiry. Every one of these has a different remedy.
    ['401 Unauthorized', false],
    ['403 Forbidden', false],
    ['403 Forbidden: The user does not have permission to access this folder', false],
    ['403: User Rate Limit Exceeded, userRateLimitExceeded', false],
    ['Failed to copy: 403 storageQuotaExceeded', false],
    ['error listing: permission denied', false],
    ['AccessDenied: Access Denied, status code: 403', false],
    ['dial tcp 142.250.0.1:443: i/o timeout', false],
    ['connection refused', false],
    ['no such host', false],
    ['Fatal: wrong password or no key found', false],
    ['write /srv/repo/data/ab: no space left on device', false],
    ['NOTICE: using token from the config file', false],
    ['', false],
    // Per-line pairing: a quota refusal and a token mention are not one fact.
    ['ERROR : db.sql: Failed to copy: 403 Forbidden: storageQuotaExceeded\n' +
        'NOTICE: using token from the config file', false]
];

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

test('hangar-run agrees with js/core/rclone.js on every expiry signal', () => {
    const answers = pythonAnswers('auth_expired', SIGNAL_CASES.map(([t]) => [t]));
    SIGNAL_CASES.forEach(([text, expected], i) => {
        assert.equal(Rclone.isAuthExpired(text), expected,
            'javascript disagrees with the table: ' + JSON.stringify(text));
        assert.equal(answers[i], expected,
            'python disagrees with the table: ' + JSON.stringify(text));
    });
});

test('hangar-run agrees with js/engine/restic.js on which kind a run gets', () => {
    // Not just the signal — the gate around it. Only GENERIC and UNKNOWN may be
    // refined; 0/3/130 must never be, and 10/11/12 carry restic's own answer.
    const codes = [0, 1, 2, 3, 10, 11, 12, 130, 99];
    const expiry = "couldn't fetch token - maybe it has expired?";
    const quota = '403: User Rate Limit Exceeded, userRateLimitExceeded';
    const pairs = [];
    codes.forEach((c) => { pairs.push([c, expiry]); pairs.push([c, quota]); });

    const answers = pythonAnswers('classify_run', pairs);
    pairs.forEach(([code, text], i) => {
        assert.equal(answers[i], Restic.classifyExit(code, text).kind,
            'python and javascript disagree for exit ' + code + ' / ' + JSON.stringify(text));
    });
    // And the specific claim, spelled out rather than left to the loop.
    assert.equal(answers[pairs.findIndex(([c, t]) => c === 1 && t === expiry)], 'AUTH_EXPIRED');
    assert.equal(answers[pairs.findIndex(([c, t]) => c === 3 && t === expiry)], 'READ_ERRORS');
    assert.equal(answers[pairs.findIndex(([c, t]) => c === 1 && t === quota)], 'GENERIC');
});

// --- the whole false-positive sweep, driven through BOTH implementations -----
//
// SIGNAL_CASES above is the short table. This is the long one, and it exists
// because a disagreement between the two copies is not a cosmetic drift: the
// editor decides whether the repository shows a "sign in again" button, and the
// runner decides what the 03:00 unit writes into the state file the morning
// after. One saying expiry and the other not is a repository that looks broken
// in one place and fine in the other.
//
// The corpus is the same one tests/unit/rclone.test.js sweeps, so a case added
// in one place must be added in both — deliberately, since it is the AGREEMENT
// that is under test here, not the verdict.

const FALSE_POSITIVE_CORPUS = [
    // Ordinary failures, each with a remedy that is not re-authorising.
    ['error listing: permission denied', false],
    ['Fatal: unable to open repo: stat /srv/repo: permission denied', false],
    ['mkdir /srv/repo/data: permission denied', false],
    ['Failed to copy: 403 storageQuotaExceeded', false],
    ["googleapi: Error 403: The user's Drive storage quota has been exceeded., quotaExceeded", false],
    ['NoSuchBucket: The specified bucket does not exist', false],
    ['ContainerNotFound: The specified container does not exist', false],
    ['Get "https://s3.eu-central-1.amazonaws.com/": dial tcp: lookup s3.eu-central-1.amazonaws.com: no such host', false],
    ['temporary failure in name resolution', false],
    ['dial tcp 10.0.0.5:8000: connect: connection refused', false],
    ['read tcp 10.0.0.2:5000->10.0.0.9:443: read: connection reset by peer', false],
    ['net/http: TLS handshake timeout', false],
    ['x509: certificate signed by unknown authority', false],
    ['Fatal: wrong password or no key found', false],
    ['Fatal: unable to open repository: repository is already locked exclusively by PID 42 on host nas', false],
    ['Fatal: unable to open config file: Stat: file does not exist\nIs there a repository at the following location?', false],
    ['write /srv/repo/data/ab: no space left on device', false],
    ['disk quota exceeded', false],
    ['401 Unauthorized', false],
    ['HTTP/1.1 401 Unauthorized', false],
    ['403 Forbidden', false],
    ['403 Forbidden: The user does not have permission to access this folder', false],
    ['Access Denied', false],
    ['AccessDenied: Access Denied, status code: 403', false],
    ['access_denied', false],
    ['SignatureDoesNotMatch: The request signature we calculated does not match', false],
    ['429 Too Many Requests', false],
    ['403: User Rate Limit Exceeded, userRateLimitExceeded', false],
    ['ERROR : x: Failed to copy: googleapi: Error 429: Rate Limit Exceeded, rateLimitExceeded', false],
    ["couldn't fetch to", false],
    ['inval', false],
    [' garbled��', false],
    ['', false],
    ['   ', false],
    ['\n\n\n', false],
    ['NOTICE: using token from the config file', false],
    // A file NAME is not a diagnosis.
    ['error: lstat /home/alice/token: permission denied', false],
    ['error: open /var/log/token_expired.log: permission denied', false],
    ['error: lstat /srv/oauth2/data: permission denied', false],
    ['error: open /home/bob/bearer.key: permission denied', false],
    ['Fatal: unable to open file /etc/hangar/invalid_grant.json: permission denied', false],
    ['ERROR : secrets/token.json: Failed to copy: 403 Forbidden', false],
    ['ERROR : token/db.sql: Failed to copy: 403 Forbidden', false],
    ['error: lstat ./oauth2/data: permission denied', false],
    ['error: lstat ~/tokens: permission denied', false],
    ['error: lstat ../bearer: permission denied', false],
    ['Get "https://s3.example.com/bucket/token-store/x": 403 Forbidden', false],
    // Per-line pairing.
    ['ERROR : db.sql: Failed to copy: 403 Forbidden: storageQuotaExceeded\n' +
        'NOTICE: using token from the config file', false],
    ['403 Forbidden\nusing token from the config file', false],
    // Line separators. Python's str.splitlines() breaks on all of these and the
    // JavaScript now does too; before it did not, and a bare carriage return —
    // which fills rclone's progress output — joined two unrelated lines into one
    // false expiry on the editor side only.
    ['403 Forbidden\rTransferred: 1 token of many', false],
    ['403 Forbidden\r\nusing token from the config file', false],
    ['403 Forbidden\voauth token', false],
    ['403 Forbidden\foauth token', false],
    ['403 Forbidden\x1coauth token', false],
    ['403 Forbidden\x1doauth token', false],
    ['403 Forbidden\x1eoauth token', false],
    ['403 Forbidden\x85oauth token', false],
    ['403 Forbidden\u2028oauth token', false],
    ['403 Forbidden\u2029oauth token', false],
    ["couldn't fetch\rtoken", false],
    // The genuine article, every wording hangar claims to recognise.
    ["couldn't fetch token - maybe it has expired?", true],
    ['couldn’t fetch token - maybe it has expired?', true],
    ['couldnt fetch token', true],
    ['Failed to create file system for "gd:x": couldn\'t fetch token - maybe it has expired?', true],
    ['refresh with "rclone config reconnect gdrive:"', true],
    ['rclone config reconnect box:', true],
    ['oauth2: token expired and refresh token is not set', true],
    ['invalid_grant', true],
    ['INVALID_GRANT', true],
    ['{"error":"invalid_grant","error_description":"Token has been expired or revoked."}', true],
    ['Token has been expired or revoked.', true],
    ['Refresh token has expired', true],
    ['AADSTS700082: The refresh token has expired due to inactivity.', true],
    ['expired_access_token', true],
    ['{"error_summary":"expired_access_token/..."}', true],
    ['unexpected HTTP status 401: {"error_summary": "expired_access_token/.", ' +
        '"error": {".tag": "expired_access_token"}}', true],
    ['401 Unauthorized: the bearer token is no longer accepted', true],
    ['googleapi: Error 401: Expected OAuth 2 access token, ..., unauthorized', true],
    ['2026/07/31 03:00:12 ERROR : backups/db: Failed to copy: failed to open ' +
        'source object: couldn\'t fetch token - maybe it has expired?', true],
    ['Post "https://oauth2.googleapis.com/token": oauth2: cannot fetch token: 401', true]
];

test('the two expiry implementations agree on the whole false-positive corpus', () => {
    const answers = pythonAnswers('auth_expired', FALSE_POSITIVE_CORPUS.map(([t]) => [t]));
    FALSE_POSITIVE_CORPUS.forEach(([text, expected], i) => {
        assert.equal(Rclone.isAuthExpired(text), expected,
            'js/core/rclone.js disagrees with the table: ' + JSON.stringify(text));
        assert.equal(answers[i], expected,
            'libexec/hangar-run disagrees with the table: ' + JSON.stringify(text));
    });
    // The sweep must not be passable by a function that always answers false.
    assert.ok(FALSE_POSITIVE_CORPUS.filter(([, e]) => e).length >= 18);
    assert.ok(FALSE_POSITIVE_CORPUS.filter(([, e]) => !e).length >= 50);
});

test('the runner answers no, rather than raising, for a stderr that is not text', () => {
    // classify_run() is called on whatever the channel handed back. `text or ""`
    // let a non-string reach .splitlines() and raise an AttributeError out of a
    // classifier whose entire contract is to answer yes or no — and it would have
    // done so on the failure path, where nothing is left to catch it.
    const answers = pythonAnswers('auth_expired', [[null], [123], [true], [[]], [{}], [1.5]]);
    assert.deepEqual(answers, [false, false, false, false, false, false]);
    [null, 123, true, [], {}, 1.5].forEach((v) => {
        assert.equal(Rclone.isAuthExpired(v), false);
    });
});

// Runs the helper for real against the stub host and returns its exit status.
function runStub(host, jobId) {
    try {
        execFileSync('python3', [HELPER, jobId],
            { env: host.env, encoding: 'utf8', stdio: 'pipe' });
        return { code: 0, stderr: '' };
    } catch (e) {
        return { code: e.status, stderr: String(e.stderr || '') };
    }
}

// ------------------------------------------------- prune waits out a lock
//
// restic locks the repository for almost everything, and `prune` needs an
// EXCLUSIVE lock — so retention fails whenever anything else is touching the
// repository. That something is usually ours: an open Hangar tab polls stats
// and diff every few seconds, and a Logbook mount holds a lock for as long as
// it is mounted. Failing outright means old snapshots quietly accumulate.

// exit 11 is EXIT_REPO_LOCKED. Fails the forget twice, then lets it through.
const RESTIC_STUB_LOCKED_TWICE = `#!/bin/sh
echo "restic $*" >> "$HANGAR_TEST_CMD_LOG"
for a in "$@"; do
  if [ "$a" = forget ]; then
    n=$(cat "$HANGAR_TEST_CMD_LOG.tries" 2>/dev/null || echo 0)
    n=$((n + 1)); echo "$n" > "$HANGAR_TEST_CMD_LOG.tries"
    if [ "$n" -le 2 ]; then
      echo "unable to create lock in backend: repository is already locked" >&2
      exit 11
    fi
    echo '[]'; exit 0
  fi
done
echo '{"message_type":"summary","snapshot_id":"deadbeef","files_new":1,"data_added":1}'
exit 0
`;

test('retention waits for a lock to clear instead of giving up', async () => {
    const job = Object.assign({}, SIMPLE_JOB, { id: 'vols' });
    await withStubHost(job, { restic: RESTIC_STUB_LOCKED_TWICE }, async (host) => {
        host.env.HANGAR_PRUNE_LOCK_WAIT = '0';
        const res = runStub(host, job.id);
        assert.equal(res.code, 0, 'a lock that clears is not a failed backup: ' + res.stderr);
        const forgets = host.commands().filter((c) => / forget /.test(c + ' '));
        assert.equal(forgets.length, 3, 'two refusals then the one that worked');
        const state = host.state();
        assert.equal(state.status, 'ok');
    });
});

// Only locks are worth waiting for. Anything else should fail at once rather
// than sit there for two minutes repeating a command that cannot succeed.
const RESTIC_STUB_FORGET_BROKEN = `#!/bin/sh
echo "restic $*" >> "$HANGAR_TEST_CMD_LOG"
for a in "$@"; do
  if [ "$a" = forget ]; then
    echo "Fatal: wrong password" >&2
    exit 1
  fi
done
echo '{"message_type":"summary","snapshot_id":"deadbeef","files_new":1,"data_added":1}'
exit 0
`;

test('a retention failure that is not a lock is not retried', async () => {
    const job = Object.assign({}, SIMPLE_JOB, { id: 'vols' });
    await withStubHost(job, { restic: RESTIC_STUB_FORGET_BROKEN }, async (host) => {
        host.env.HANGAR_PRUNE_LOCK_WAIT = '0';
        const res = runStub(host, job.id);
        assert.equal(res.code, 3, 'the documented exit for a failed prune');
        const forgets = host.commands().filter((c) => / forget /.test(c + ' '));
        assert.equal(forgets.length, 1, 'tried once, reported, stopped');
        assert.equal(host.state().status, 'prune-failed');
    });
});

// ------------------------------------------- retention outlives a Logbook
//
// A Logbook mount holds a repository lock for as long as somebody is browsing,
// and prune needs an exclusive one — so an open tab means old snapshots are
// never thinned. Waiting does not help: a browsing session outlasts any
// patience. hangar's own mount is therefore released, but only after a lock has
// actually blocked the prune, so browsing is never interrupted on spec.

const RESTIC_STUB_LOCKED_ONCE = `#!/bin/sh
echo "restic $*" >> "$HANGAR_TEST_CMD_LOG"
for a in "$@"; do
  if [ "$a" = forget ]; then
    n=$(cat "$HANGAR_TEST_CMD_LOG.tries" 2>/dev/null || echo 0)
    n=$((n + 1)); echo "$n" > "$HANGAR_TEST_CMD_LOG.tries"
    if [ "$n" -le 1 ]; then
      echo "unable to create lock in backend: repository is already locked" >&2
      exit 11
    fi
    echo '[]'; exit 0
  fi
done
echo '{"message_type":"summary","snapshot_id":"deadbeef","files_new":1,"data_added":1}'
exit 0
`;

// A restic that simply works: no locks, nothing to wait for.
const RESTIC_STUB_OK = `#!/bin/sh
echo "restic $*" >> "$HANGAR_TEST_CMD_LOG"
for a in "$@"; do
  if [ "$a" = forget ]; then echo '[]'; exit 0; fi
done
echo '{"message_type":"summary","snapshot_id":"deadbeef","files_new":1,"data_added":1}'
exit 0
`;

const SYSTEMCTL_STUB_MOUNT_ACTIVE = `#!/bin/sh
echo "systemctl $*" >> "$HANGAR_TEST_CMD_LOG"
[ "$1" = is-active ] && exit 0        # yes, the mount is running
exit 0
`;

test('a Logbook mount is released so retention can run', async () => {
    const job = Object.assign({}, SIMPLE_JOB, { id: 'vols' });
    await withStubHost(job, {
        restic: RESTIC_STUB_LOCKED_ONCE,
        systemctl: SYSTEMCTL_STUB_MOUNT_ACTIVE
    }, async (host) => {
        host.env.HANGAR_PRUNE_LOCK_WAIT = '0';
        const res = runStub(host, job.id);
        assert.equal(res.code, 0, 'the backup and its retention both succeed: ' + res.stderr);
        const cmds = host.commands();
        assert.ok(cmds.some((c) => c === 'systemctl stop hangar-mount-main.service'),
            'our own mount is stopped, by name: ' + cmds.filter((c) => c.startsWith('systemctl')).join(' | '));
        assert.equal(cmds.filter((c) => / forget /.test(c + ' ')).length, 2,
            'one refusal, then the retry that worked');
    });
});

const SYSTEMCTL_STUB_NO_MOUNT = `#!/bin/sh
echo "systemctl $*" >> "$HANGAR_TEST_CMD_LOG"
[ "$1" = is-active ] && exit 3        # nothing mounted
exit 0
`;

test('nothing is stopped when the lock is somebody else', async () => {
    const job = Object.assign({}, SIMPLE_JOB, { id: 'vols' });
    await withStubHost(job, {
        restic: RESTIC_STUB_LOCKED_ONCE,
        systemctl: SYSTEMCTL_STUB_NO_MOUNT
    }, async (host) => {
        host.env.HANGAR_PRUNE_LOCK_WAIT = '0';
        runStub(host, job.id);
        assert.ok(!host.commands().some((c) => c.startsWith('systemctl stop')),
            'a lock hangar does not own is waited out, not fought');
    });
});

// A backup that never hits a lock must leave a browsing session alone.
test('an unblocked retention does not disturb the Logbook', async () => {
    const job = Object.assign({}, SIMPLE_JOB, { id: 'vols' });
    await withStubHost(job, {
        restic: RESTIC_STUB_OK,
        systemctl: SYSTEMCTL_STUB_MOUNT_ACTIVE
    }, async (host) => {
        runStub(host, job.id);
        assert.ok(!host.commands().some((c) => c.startsWith('systemctl stop')),
            'no lock, no interruption');
    });
});

// A lock whose owner has died blocks every retention run that follows, for
// ever. Seen on a real repository: a lock thirteen hours old, its PID long
// gone, and every backup since reporting "retention failed". `restic unlock`
// removes exactly those and leaves a live one alone.
const RESTIC_STUB_STALE_LOCK = `#!/bin/sh
echo "restic $*" >> "$HANGAR_TEST_CMD_LOG"
for a in "$@"; do
  if [ "$a" = unlock ]; then echo "successfully removed 1 locks"; exit 0; fi
  if [ "$a" = forget ]; then
    n=$(cat "$HANGAR_TEST_CMD_LOG.tries" 2>/dev/null || echo 0)
    n=$((n + 1)); echo "$n" > "$HANGAR_TEST_CMD_LOG.tries"
    # Blocked until the stale lock is removed.
    if ! grep -q " unlock" "$HANGAR_TEST_CMD_LOG"; then
      echo "unable to create lock in backend: repository is already locked" >&2
      exit 11
    fi
    echo '[]'; exit 0
  fi
done
echo '{"message_type":"summary","snapshot_id":"deadbeef","files_new":1,"data_added":1}'
exit 0
`;

test('a lock left by a dead process is cleared so retention can run', async () => {
    const job = Object.assign({}, SIMPLE_JOB, { id: 'vols' });
    await withStubHost(job, {
        restic: RESTIC_STUB_STALE_LOCK,
        systemctl: SYSTEMCTL_STUB_NO_MOUNT
    }, async (host) => {
        host.env.HANGAR_PRUNE_LOCK_WAIT = '0';
        const res = runStub(host, job.id);
        assert.equal(res.code, 0, 'retention succeeds once the dead lock is gone: ' + res.stderr);
        const cmds = host.commands();
        assert.ok(cmds.some((c) => / unlock$| unlock /.test(c + ' ')),
            'unlock was attempted: ' + cmds.join(' | ').slice(0, 200));
        assert.ok(cmds.filter((c) => / forget /.test(c + ' ')).length >= 2,
            'and the forget was retried afterwards');
    });
});

// unlock only ever removes locks nobody owns, so it must not be withheld — but
// it must also not be the first thing tried on a healthy repository.
test('an unblocked run never unlocks anything', async () => {
    const job = Object.assign({}, SIMPLE_JOB, { id: 'vols' });
    await withStubHost(job, {
        restic: RESTIC_STUB_OK,
        systemctl: SYSTEMCTL_STUB_NO_MOUNT
    }, async (host) => {
        runStub(host, job.id);
        assert.ok(!host.commands().some((c) => / unlock/.test(c)),
            'nothing was blocked, so nothing is unlocked');
    });
});
