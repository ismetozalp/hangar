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
    // v1 ships filesystem only. Silently ignoring a 'libvirt' source would produce a
    // backup that looks successful while containing nothing the user asked for.
    const job = { id: 'vm', repo: 'main', sources: [{ kind: 'libvirt', paths: ['/x'] }] };
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
