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
        assert.ok(p.forget.includes('--prune'));
        assert.ok(p.forget.includes('--keep-hourly'));
        assert.ok(p.forget.includes('24'));
        assert.ok(p.forget.includes('--group-by'));
        assert.ok(p.forget.includes('host,paths'));
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
