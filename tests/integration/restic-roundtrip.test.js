// Integration tests against a REAL restic binary and a real repository.
//
// Unit tests prove we build the right command line; these prove the command line
// actually does what we think against restic itself. Everything runs in a temp
// directory with a local repository — no network, no root, no system state touched.
//
// Skips cleanly when restic is not installed, so the suite stays runnable anywhere.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Restic = require('../../js/engine/restic.js');
const Retention = require('../../js/core/retention.js');
const Repos = require('../../js/core/repos.js');

function resticAvailable() {
    const r = spawnSync('restic', ['version'], { encoding: 'utf8' });
    return r.status === 0;
}

const HAVE_RESTIC = resticAvailable();
const skip = HAVE_RESTIC ? false : 'restic is not installed';

// --- harness -------------------------------------------------------------

function makeSandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-restic-'));
    const repo = path.join(root, 'repo');
    const data = path.join(root, 'data');
    const pw = path.join(root, 'pw');
    // hangar's real cache lives in root-owned /var/cache/hangar/restic; this suite
    // runs as an ordinary user, so it exercises the same flag pointed somewhere
    // it can write. The flag itself is not optional — without it restic exits 1
    // in any environment that has no $HOME, which is every systemd unit.
    const cache = path.join(root, 'cache');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(pw, 'correct-horse-battery-staple\n', { mode: 0o600 });
    return { root, repo, data, pw, cache,
        cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// Run restic using the argv that the plugin itself would build. If these tests pass
// but the plugin fails, the bug is in the UI, not in the engine contract.
function restic(sb, op, opts = {}, expectOk = true) {
    // buildArgs() returns arguments only; run() prepends the binary (restic.js:452).
    // Mirroring that split here keeps the test honest about the real call shape.
    const args = Restic.buildArgs(op,
        Object.assign({ repoUrl: sb.repo, passwordFile: sb.pw, cacheDir: sb.cache }, opts));
    assert.ok(Array.isArray(args) && args.length, 'buildArgs must return an argument array');
    assert.notEqual(args[0], 'restic', 'buildArgs must not include the binary name');
    const r = spawnSync('restic', args, { encoding: 'utf8', env: process.env });
    if (expectOk && r.status !== 0) {
        throw new Error(`restic ${op} failed (${r.status}): ${r.stderr || r.stdout}`);
    }
    return r;
}

function seed(sb, files) {
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(sb.data, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    }
}

// --- tests ---------------------------------------------------------------

test('restic is present and new enough for our exit-code contract', { skip }, () => {
    const out = execFileSync('restic', ['version'], { encoding: 'utf8' });
    // Exit codes 10/11/12 only exist from 0.17.0; the plugin's minimum version.
    const m = out.match(/restic\s+(\d+)\.(\d+)\.(\d+)/);
    assert.ok(m, `could not parse restic version from: ${out}`);
    const [maj, min] = [Number(m[1]), Number(m[2])];
    assert.ok(maj > 0 || min >= 17, `restic ${m[0]} is older than the 0.17.0 minimum`);
});

test('init creates a usable repository', { skip }, () => {
    const sb = makeSandbox();
    try {
        restic(sb, 'init');
        assert.ok(fs.existsSync(path.join(sb.repo, 'config')));
        const r = restic(sb, 'snapshots');
        const snaps = Restic.parseSnapshots(r.stdout);
        assert.deepEqual(snaps, [], 'a fresh repository has no snapshots');
    } finally { sb.cleanup(); }
});

test('backup writes a snapshot and emits a parseable JSON summary', { skip }, () => {
    const sb = makeSandbox();
    try {
        restic(sb, 'init');
        seed(sb, { 'a.txt': 'alpha', 'sub/b.txt': 'bravo' });

        const r = restic(sb, 'backup', { paths: [sb.data] });
        const messages = Restic.parseJsonLines(r.stdout);
        assert.ok(messages.length > 0, 'backup produced no JSON messages');

        const folded = Restic.summarize(messages);
        assert.ok(folded.summary, 'no summary message in the stream');
        assert.equal(folded.summary.files_new, 2);
        assert.ok(folded.summary.snapshot_id, 'summary carries no snapshot id');
    } finally { sb.cleanup(); }
});

test('a second backup of unchanged data deduplicates', { skip }, () => {
    const sb = makeSandbox();
    try {
        restic(sb, 'init');
        seed(sb, { 'a.txt': 'alpha' });
        restic(sb, 'backup', { paths: [sb.data] });

        const r = restic(sb, 'backup', { paths: [sb.data] });
        const folded = Restic.summarize(Restic.parseJsonLines(r.stdout));
        assert.equal(folded.summary.files_new, 0);
        assert.equal(folded.summary.files_unmodified, 1);
        // The point of a deduplicating engine: an unchanged run adds ~nothing.
        assert.ok(folded.summary.data_added < 5000,
            `expected near-zero data_added, got ${folded.summary.data_added}`);
    } finally { sb.cleanup(); }
});

test('snapshots output parses into the shape the UI consumes', { skip }, () => {
    const sb = makeSandbox();
    try {
        restic(sb, 'init');
        seed(sb, { 'a.txt': 'alpha' });
        restic(sb, 'backup', { paths: [sb.data] });
        restic(sb, 'backup', { paths: [sb.data] });

        const snaps = Restic.parseSnapshots(restic(sb, 'snapshots').stdout);
        assert.equal(snaps.length, 2);
        for (const s of snaps) {
            assert.ok(s.id, 'snapshot has no id');
            assert.ok(s.time, 'snapshot has no time');
            assert.ok(Array.isArray(s.paths), 'snapshot has no paths array');
            assert.ok(!Number.isNaN(Date.parse(s.time)), `unparseable time: ${s.time}`);
        }
    } finally { sb.cleanup(); }
});

test('restore reproduces file contents exactly', { skip }, () => {
    const sb = makeSandbox();
    try {
        restic(sb, 'init');
        const files = { 'a.txt': 'alpha', 'sub/b.txt': 'bravo', 'uni/çöp.txt': 'unicode ✓' };
        seed(sb, files);
        restic(sb, 'backup', { paths: [sb.data] });

        const target = path.join(sb.root, 'restored');
        restic(sb, 'restore', { snapshot: 'latest', target });

        for (const [rel, content] of Object.entries(files)) {
            const abs = path.join(target, sb.data, rel);
            assert.ok(fs.existsSync(abs), `restored file missing: ${rel}`);
            assert.equal(fs.readFileSync(abs, 'utf8'), content, `content mismatch: ${rel}`);
        }
    } finally { sb.cleanup(); }
});

test('restore preserves file mode', { skip }, () => {
    const sb = makeSandbox();
    try {
        restic(sb, 'init');
        seed(sb, { 'script.sh': '#!/bin/sh\necho hi\n' });
        fs.chmodSync(path.join(sb.data, 'script.sh'), 0o750);
        restic(sb, 'backup', { paths: [sb.data] });

        const target = path.join(sb.root, 'restored');
        restic(sb, 'restore', { snapshot: 'latest', target });
        const mode = fs.statSync(path.join(target, sb.data, 'script.sh')).mode & 0o777;
        assert.equal(mode, 0o750, 'restore did not preserve mode');
    } finally { sb.cleanup(); }
});

test('exclude patterns are honoured', { skip }, () => {
    const sb = makeSandbox();
    try {
        restic(sb, 'init');
        seed(sb, { 'keep.txt': 'k', 'drop.tmp': 'd' });
        restic(sb, 'backup', { paths: [sb.data], excludes: ['*.tmp'] });

        const target = path.join(sb.root, 'restored');
        restic(sb, 'restore', { snapshot: 'latest', target });
        assert.ok(fs.existsSync(path.join(target, sb.data, 'keep.txt')));
        assert.ok(!fs.existsSync(path.join(target, sb.data, 'drop.tmp')),
            'excluded file was backed up anyway');
    } finally { sb.cleanup(); }
});

test('forget applies the retention policy our module builds', { skip }, () => {
    const sb = makeSandbox();
    try {
        restic(sb, 'init');
        seed(sb, { 'a.txt': 'alpha' });
        for (let i = 0; i < 3; i++) {
            fs.writeFileSync(path.join(sb.data, 'a.txt'), `alpha ${i}`);
            restic(sb, 'backup', { paths: [sb.data] });
        }
        assert.equal(Restic.parseSnapshots(restic(sb, 'snapshots').stdout).length, 3);

        // Keep only the most recent — proves toArgs() output is accepted by restic
        // and actually thins, which no unit test can establish.
        const retentionArgs = Retention.toArgs({ last: 1 });
        restic(sb, 'forget', { retentionArgs, prune: true });

        const after = Restic.parseSnapshots(restic(sb, 'snapshots').stdout);
        assert.equal(after.length, 1, 'forget did not thin to a single snapshot');
    } finally { sb.cleanup(); }
});

test('the rolling preset is accepted by restic', { skip }, () => {
    const sb = makeSandbox();
    try {
        restic(sb, 'init');
        seed(sb, { 'a.txt': 'alpha' });
        restic(sb, 'backup', { paths: [sb.data] });

        // The default preset shown in the UI must not be rejected by the CLI.
        const r = restic(sb, 'forget', {
            retentionArgs: Retention.toArgs(Retention.PRESETS.rolling), prune: true
        });
        assert.equal(r.status, 0, `rolling preset rejected: ${r.stderr}`);
        assert.equal(Restic.parseSnapshots(restic(sb, 'snapshots').stdout).length, 1);
    } finally { sb.cleanup(); }
});

test('check reports a healthy repository', { skip }, () => {
    const sb = makeSandbox();
    try {
        restic(sb, 'init');
        seed(sb, { 'a.txt': 'alpha' });
        restic(sb, 'backup', { paths: [sb.data] });

        const r = restic(sb, 'check');
        const folded = Restic.summarize(Restic.parseJsonLines(r.stdout));
        assert.equal(r.status, 0);
        if (folded.summary) assert.equal(folded.summary.num_errors || 0, 0);
    } finally { sb.cleanup(); }
});

test('stats parses into the shape the overview consumes', { skip }, () => {
    const sb = makeSandbox();
    try {
        restic(sb, 'init');
        seed(sb, { 'a.txt': 'alpha' });
        restic(sb, 'backup', { paths: [sb.data] });

        // parseStats normalises restic's snake_case into camelCase — asserting the
        // module's contract here, not restic's wire format, is the point: if restic
        // renames a field, this test fails and tells us the adapter needs updating.
        const stats = Restic.parseStats(restic(sb, 'stats').stdout);
        assert.equal(typeof stats.totalSize, 'number');
        assert.equal(typeof stats.totalFileCount, 'number');
        assert.ok(stats.totalFileCount >= 1, 'stats reported no files');
        assert.equal(stats.snapshotsCount, 1);
        assert.ok(stats.totalSize > 0, 'stats reported zero bytes for a non-empty backup');
    } finally { sb.cleanup(); }
});

test('diff between two snapshots parses into change badges', { skip }, () => {
    const sb = makeSandbox();
    try {
        restic(sb, 'init');
        seed(sb, { 'a.txt': 'one', 'gone.txt': 'x' });
        const r1 = restic(sb, 'backup', { paths: [sb.data] });
        const id1 = Restic.summarize(Restic.parseJsonLines(r1.stdout)).summary.snapshot_id;

        fs.writeFileSync(path.join(sb.data, 'a.txt'), 'two');
        fs.unlinkSync(path.join(sb.data, 'gone.txt'));
        fs.writeFileSync(path.join(sb.data, 'new.txt'), 'n');
        const r2 = restic(sb, 'backup', { paths: [sb.data] });
        const id2 = Restic.summarize(Restic.parseJsonLines(r2.stdout)).summary.snapshot_id;

        const raw = restic(sb, 'diff', { snapshotA: id1, snapshotB: id2 }).stdout;
        const Logbook = require('../../js/core/logbook.js');
        const badges = Logbook.diffToBadges(Restic.parseDiff(raw));
        const kinds = new Set(Object.values(badges));
        assert.ok(kinds.has('added'), 'no added badge');
        assert.ok(kinds.has('removed'), 'no removed badge');
        assert.ok(kinds.has('modified'), 'no modified badge');
    } finally { sb.cleanup(); }
});

// --- error contracts: the exit codes our whole UI depends on -------------

test('a missing repository yields exit 10 → REPO_MISSING', { skip }, () => {
    const sb = makeSandbox();
    try {
        const r = restic(sb, 'snapshots', {}, false);   // never initialised
        assert.equal(r.status, 10, `expected exit 10, got ${r.status}: ${r.stderr}`);
        assert.equal(Restic.classifyExit(r.status, r.stderr).kind, 'REPO_MISSING');
    } finally { sb.cleanup(); }
});

test('a wrong password yields exit 12 → WRONG_PASSWORD', { skip }, () => {
    const sb = makeSandbox();
    try {
        restic(sb, 'init');
        const wrong = path.join(sb.root, 'wrong');
        fs.writeFileSync(wrong, 'not-the-password\n');
        const args = Restic.buildArgs('snapshots', { repoUrl: sb.repo, passwordFile: wrong });
        const r = spawnSync('restic', args, { encoding: 'utf8' });
        assert.equal(r.status, 12, `expected exit 12, got ${r.status}: ${r.stderr}`);
        assert.equal(Restic.classifyExit(r.status, r.stderr).kind, 'WRONG_PASSWORD');
    } finally { sb.cleanup(); }
});

test('an unreadable file yields exit 3 but still writes the snapshot', { skip }, () => {
    // The behaviour the whole non-fatal READ_ERRORS design rests on. Skipped as root,
    // where permissions cannot make a file unreadable.
    if (process.getuid && process.getuid() === 0) return;
    const sb = makeSandbox();
    try {
        restic(sb, 'init');
        seed(sb, { 'ok.txt': 'fine', 'secret.txt': 'nope' });
        fs.chmodSync(path.join(sb.data, 'secret.txt'), 0o000);

        const r = restic(sb, 'backup', { paths: [sb.data] }, false);
        assert.equal(r.status, 3, `expected exit 3, got ${r.status}: ${r.stderr}`);

        const cls = Restic.classifyExit(r.status, r.stderr);
        assert.equal(cls.kind, 'READ_ERRORS');

        // The critical assertion: the snapshot exists despite the error.
        const snaps = Restic.parseSnapshots(restic(sb, 'snapshots').stdout);
        assert.equal(snaps.length, 1, 'exit 3 should still have produced a snapshot');
    } finally {
        try { fs.chmodSync(path.join(sb.data, 'secret.txt'), 0o600); } catch (e) { /* ignore */ }
        sb.cleanup();
    }
});

test('buildUrl round-trips through a real local repository', { skip }, () => {
    const sb = makeSandbox();
    try {
        const url = Repos.buildUrl({ kind: 'local', path: sb.repo });
        assert.equal(url, sb.repo);
        restic(sb, 'init');
        assert.ok(fs.existsSync(path.join(sb.repo, 'config')));
    } finally { sb.cleanup(); }
});
