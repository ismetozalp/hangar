// tests/unit/restic.test.js — exhaustive coverage of the pure restic layer.
//
// Every fixture under tests/fixtures/restic/ is named synthetic-* because it was
// hand-written to the shapes documented in docs/CONVENTIONS.md, NOT captured from
// a live restic run. Nothing here should be read as recorded real output.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const R = require('../../js/engine/restic.js');
const Errors = require('../../js/core/errors.js');

const FIX = path.join(__dirname, '..', 'fixtures', 'restic');
const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');

// ------------------------------------------------------------- parseJsonLines

test('parseJsonLines: empty string yields no messages', () => {
    assert.deepEqual(R.parseJsonLines(''), []);
});

test('parseJsonLines: null and undefined are tolerated', () => {
    assert.deepEqual(R.parseJsonLines(null), []);
    assert.deepEqual(R.parseJsonLines(undefined), []);
});

test('parseJsonLines: single object line', () => {
    assert.deepEqual(R.parseJsonLines('{"message_type":"status","percent_done":0.5}'),
        [{ message_type: 'status', percent_done: 0.5 }]);
});

test('parseJsonLines: leading and trailing blank lines are ignored', () => {
    const text = '\n\n  \n{"message_type":"summary"}\n\n\n';
    assert.deepEqual(R.parseJsonLines(text), [{ message_type: 'summary' }]);
});

test('parseJsonLines: CRLF line endings', () => {
    const text = '{"a":1}\r\n{"b":2}\r\n';
    assert.deepEqual(R.parseJsonLines(text), [{ a: 1 }, { b: 2 }]);
});

test('parseJsonLines: interleaved non-JSON noise is skipped, not thrown', () => {
    const text = 'Fatal: something happened\n{"a":1}\nrandom text\n{"b":2}';
    assert.deepEqual(R.parseJsonLines(text), [{ a: 1 }, { b: 2 }]);
});

test('parseJsonLines: truncated final line is dropped', () => {
    const text = '{"a":1}\n{"message_type":"stat';
    assert.deepEqual(R.parseJsonLines(text), [{ a: 1 }]);
});

test('parseJsonLines: unknown message_type passes through unchanged', () => {
    const line = '{"message_type":"future_thing","nested":{"x":[1,2]}}';
    assert.deepEqual(R.parseJsonLines(line),
        [{ message_type: 'future_thing', nested: { x: [1, 2] } }]);
});

test('parseJsonLines: bare JSON scalars and arrays are treated as noise', () => {
    assert.deepEqual(R.parseJsonLines('42\n"hello"\ntrue\nnull\n[1,2]\n{"a":1}'), [{ a: 1 }]);
});

test('parseJsonLines: unicode and embedded newlines survive', () => {
    const line = JSON.stringify({ message_type: 'error', item: '/srv/ä ö/日本語\nx' });
    assert.equal(R.parseJsonLines(line)[0].item, '/srv/ä ö/日本語\nx');
});

test('parseJsonLines: fixture stream keeps every well-formed message', () => {
    const msgs = R.parseJsonLines(fixture('synthetic-backup-jsonlines.txt'));
    const types = msgs.map((m) => m.message_type);
    assert.equal(types.filter((t) => t === 'status').length, 3);
    assert.equal(types.filter((t) => t === 'error').length, 1);
    assert.equal(types.filter((t) => t === 'summary').length, 1);
    assert.ok(types.includes('future_message_type'));
    assert.equal(types.filter((t) => t === 'verbose_status').length, 1);
    assert.equal(msgs.length, 7);       // noise + truncated tail excluded
});

// ---------------------------------------------------------------- classifyExit

test('classifyExit: 0 is OK and non-fatal', () => {
    const e = R.classifyExit(0, '');
    assert.equal(e.kind, Errors.KIND.OK);
    assert.equal(Errors.isFatal(e), false);
});

test('classifyExit: 1 is GENERIC', () => {
    assert.equal(R.classifyExit(1, 'something broke').kind, Errors.KIND.GENERIC);
});

test('classifyExit: 2 is GO_RUNTIME', () => {
    assert.equal(R.classifyExit(2, 'panic: runtime error').kind, Errors.KIND.GO_RUNTIME);
});

test('classifyExit: 3 is READ_ERRORS and explicitly not fatal', () => {
    const e = R.classifyExit(3, '');
    assert.equal(e.kind, Errors.KIND.READ_ERRORS);
    assert.equal(Errors.isFatal(e), false);
    assert.equal(e.remediation, 'list-unreadable');
});

test('classifyExit: 10 is REPO_MISSING and offers init', () => {
    const e = R.classifyExit(10, '');
    assert.equal(e.kind, Errors.KIND.REPO_MISSING);
    assert.equal(e.remediation, 'init');
});

test('classifyExit: 11 is REPO_LOCKED and offers unlock', () => {
    const e = R.classifyExit(11, '');
    assert.equal(e.kind, Errors.KIND.REPO_LOCKED);
    assert.equal(e.remediation, 'unlock');
});

test('classifyExit: 12 is WRONG_PASSWORD and re-prompts', () => {
    const e = R.classifyExit(12, '');
    assert.equal(e.kind, Errors.KIND.WRONG_PASSWORD);
    assert.equal(e.remediation, 'reprompt');
});

test('classifyExit: 130 is CANCELLED and non-fatal', () => {
    const e = R.classifyExit(130, '');
    assert.equal(e.kind, Errors.KIND.CANCELLED);
    assert.equal(Errors.isFatal(e), false);
});

test('classifyExit: an unmapped code is UNKNOWN, never success', () => {
    [4, 7, 42, 255].forEach((c) => {
        const e = R.classifyExit(c, '');
        assert.equal(e.kind, Errors.KIND.UNKNOWN);
        assert.equal(Errors.isFatal(e), true);
    });
});

test('classifyExit: missing code with no stderr is UNKNOWN', () => {
    assert.equal(R.classifyExit(null, null).kind, Errors.KIND.UNKNOWN);
    assert.equal(R.classifyExit(undefined, '').kind, Errors.KIND.UNKNOWN);
});

test('classifyExit: numeric string exit codes are accepted', () => {
    assert.equal(R.classifyExit('12', '').kind, Errors.KIND.WRONG_PASSWORD);
});

test('classifyExit: exit_error message is preferred over the generic text', () => {
    const stderr = '{"message_type":"exit_error","code":12,"message":"wrong password or no key found"}';
    const e = R.classifyExit(12, stderr);
    assert.equal(e.kind, Errors.KIND.WRONG_PASSWORD);
    assert.equal(e.message, 'wrong password or no key found');
    assert.equal(e.detail.exitError.code, 12);
});

test('classifyExit: exit_error code is used when the exit status is unavailable', () => {
    const e = R.classifyExit(null, fixture('synthetic-exit-error.txt'));
    assert.equal(e.kind, Errors.KIND.REPO_LOCKED);
    assert.match(e.message, /already locked exclusively/);
    assert.equal(e.detail.code, 11);
});

test('classifyExit: the last exit_error object wins', () => {
    const stderr = '{"message_type":"exit_error","code":1,"message":"first"}\n' +
                   '{"message_type":"exit_error","code":1,"message":"second"}';
    assert.equal(R.classifyExit(1, stderr).message, 'second');
});

test('classifyExit: exit 1 with a full disk becomes NO_SPACE', () => {
    const e = R.classifyExit(1, 'error: write /srv/repo/data/ab: no space left on device');
    assert.equal(e.kind, Errors.KIND.NO_SPACE);
    assert.equal(e.remediation, 'free-space');
});

test('classifyExit: exit 1 with a quota failure becomes NO_SPACE', () => {
    assert.equal(R.classifyExit(1, 'Disk quota exceeded').kind, Errors.KIND.NO_SPACE);
});

test('classifyExit: exit 1 with a network failure becomes NETWORK', () => {
    const e = R.classifyExit(1, 'Get "https://backup.lan:8000/": dial tcp 10.0.0.9:8000: i/o timeout');
    assert.equal(e.kind, Errors.KIND.NETWORK);
    assert.equal(e.remediation, 'retry');
});

test('classifyExit: exit 1 with an ssh failure becomes NETWORK', () => {
    assert.equal(R.classifyExit(1, 'ssh: connect to host nas.lan port 22: No route to host').kind,
        Errors.KIND.NETWORK);
});

test('classifyExit: stderr sniffing never overrides a specific exit code', () => {
    assert.equal(R.classifyExit(12, 'connection refused').kind, Errors.KIND.WRONG_PASSWORD);
    assert.equal(R.classifyExit(3, 'no space left on device').kind, Errors.KIND.READ_ERRORS);
    assert.equal(R.classifyExit(11, 'i/o timeout').kind, Errors.KIND.REPO_LOCKED);
});

test('classifyExit: detail carries the raw stderr for verbatim display', () => {
    const e = R.classifyExit(2, 'panic: runtime error: index out of range');
    assert.equal(e.detail.stderr, 'panic: runtime error: index out of range');
    assert.equal(e.detail.code, 2);
    assert.equal(e.detail.exitError, null);
});

test('classifyExit: every mapped code yields a non-empty message', () => {
    [0, 1, 2, 3, 10, 11, 12, 130, 99].forEach((c) => {
        assert.ok(R.classifyExit(c, '').message.length > 0, 'code ' + c);
    });
});

// -------------------------------------------------------------------- buildArgs

const REPO = { repoUrl: '/srv/backup/repo', passwordFile: '/etc/hangar/repos/main.key' };
// --cache-dir is part of every argv now: restic cannot find its cache from a
// systemd unit's environment, and exits 1 rather than running. See the tests at
// the end of this file.
const HEAD = ['-r', '/srv/backup/repo', '--password-file', '/etc/hangar/repos/main.key',
    '--cache-dir', R.CACHE_DIR, '--json'];

test('buildArgs: init', () => {
    assert.deepEqual(R.buildArgs('init', REPO), HEAD.concat(['init']));
});

test('buildArgs: backup places paths after a -- separator', () => {
    const args = R.buildArgs('backup', Object.assign({ paths: ['/srv/data', '/etc'] }, REPO));
    assert.deepEqual(args, HEAD.concat(['backup', '--', '/srv/data', '/etc']));
});

test('buildArgs: backup with excludes, tags and one-file-system', () => {
    const args = R.buildArgs('backup', Object.assign({
        paths: ['/srv/data'],
        excludes: ['*.tmp', '/srv/data/cache'],
        tags: ['nightly', 'hangar:job=daily'],
        oneFileSystem: true,
        excludeFile: '/etc/hangar/excludes.txt'
    }, REPO));
    assert.deepEqual(args, HEAD.concat([
        'backup', '--one-file-system', '--exclude-file', '/etc/hangar/excludes.txt',
        '--exclude', '*.tmp', '--exclude', '/srv/data/cache',
        '--tag', 'nightly', '--tag', 'hangar:job=daily',
        '--', '/srv/data'
    ]));
});

test('buildArgs: a path beginning with a dash is protected by --', () => {
    const args = R.buildArgs('backup', Object.assign({ paths: ['-weird dir'] }, REPO));
    assert.equal(args[args.length - 2], '--');
    assert.equal(args[args.length - 1], '-weird dir');
});

test('buildArgs: backup without paths throws a typed GENERIC error', () => {
    assert.throws(() => R.buildArgs('backup', Object.assign({ paths: [] }, REPO)), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.equal(e.kind, Errors.KIND.GENERIC);
        return true;
    });
    assert.throws(() => R.buildArgs('backup', REPO), /at least one path/);
});

test('buildArgs: empty and null path entries are dropped', () => {
    const args = R.buildArgs('backup', Object.assign({ paths: ['/srv', '', null, undefined] }, REPO));
    assert.deepEqual(args.slice(-2), ['--', '/srv']);
});

test('buildArgs: snapshots with host, tag and path filters', () => {
    const args = R.buildArgs('snapshots', Object.assign({
        tags: ['nightly'], paths: ['/srv/data'], host: 'hangar-dev'
    }, REPO));
    assert.deepEqual(args, HEAD.concat([
        'snapshots', '--tag', 'nightly', '--path', '/srv/data', '--host', 'hangar-dev'
    ]));
});

test('buildArgs: forget splices pre-built retention args verbatim', () => {
    const args = R.buildArgs('forget', Object.assign({
        retentionArgs: ['--keep-hourly', '24', '--keep-daily', '30', '--group-by', 'host,paths'],
        prune: true
    }, REPO));
    assert.deepEqual(args, HEAD.concat([
        'forget', '--keep-hourly', '24', '--keep-daily', '30', '--group-by', 'host,paths', '--prune'
    ]));
});

test('buildArgs: forget does not duplicate a --group-by already in retentionArgs', () => {
    const args = R.buildArgs('forget', Object.assign({
        retentionArgs: ['--group-by', 'host,paths', '--keep-last', '5'],
        groupBy: 'host,paths'
    }, REPO));
    assert.equal(args.filter((a) => a === '--group-by').length, 1);
});

test('buildArgs: forget appends groupBy when retentionArgs omits it', () => {
    const args = R.buildArgs('forget', Object.assign({
        retentionArgs: ['--keep-last', '5'], groupBy: 'host,paths', dryRun: true
    }, REPO));
    assert.deepEqual(args, HEAD.concat([
        'forget', '--keep-last', '5', '--group-by', 'host,paths', '--dry-run'
    ]));
});

test('buildArgs: forget accepts explicit snapshot ids', () => {
    const args = R.buildArgs('forget', Object.assign({ snapshotIds: ['1a2b3c4d'] }, REPO));
    assert.deepEqual(args, HEAD.concat(['forget', '1a2b3c4d']));
});

test('buildArgs: prune', () => {
    assert.deepEqual(R.buildArgs('prune', REPO), HEAD.concat(['prune']));
    assert.deepEqual(R.buildArgs('prune', Object.assign({ dryRun: true, maxUnused: '5%' }, REPO)),
        HEAD.concat(['prune', '--dry-run', '--max-unused', '5%']));
});

test('buildArgs: check with full and subset read-data', () => {
    assert.deepEqual(R.buildArgs('check', Object.assign({ readData: true }, REPO)),
        HEAD.concat(['check', '--read-data']));
    assert.deepEqual(R.buildArgs('check', Object.assign({ readData: '1/10' }, REPO)),
        HEAD.concat(['check', '--read-data-subset', '1/10']));
    assert.deepEqual(R.buildArgs('check', REPO), HEAD.concat(['check']));
});

test('buildArgs: stats with mode and snapshot ids', () => {
    const args = R.buildArgs('stats', Object.assign({
        mode: 'restore-size', snapshotIds: ['latest']
    }, REPO));
    assert.deepEqual(args, HEAD.concat(['stats', '--mode', 'restore-size', 'latest']));
});

test('buildArgs: restore with target and includes', () => {
    const args = R.buildArgs('restore', Object.assign({
        snapshot: '1a2b3c4d', target: '/var/tmp/restore', include: ['/etc/hosts', '/srv/data/a.bin']
    }, REPO));
    assert.deepEqual(args, HEAD.concat([
        'restore', '--target', '/var/tmp/restore',
        '--include', '/etc/hosts', '--include', '/srv/data/a.bin', '1a2b3c4d'
    ]));
});

test('buildArgs: restore rejects a missing snapshot or target', () => {
    assert.throws(() => R.buildArgs('restore', Object.assign({ target: '/tmp/x' }, REPO)),
        /requires a snapshot/);
    assert.throws(() => R.buildArgs('restore', Object.assign({ snapshot: 'abc' }, REPO)),
        /requires a target/);
});

test('buildArgs: ls with a snapshot and sub-paths', () => {
    const args = R.buildArgs('ls', Object.assign({
        snapshot: 'latest', long: true, recursive: true, paths: ['/srv/data']
    }, REPO));
    assert.deepEqual(args, HEAD.concat(['ls', '--long', '--recursive', 'latest', '--', '/srv/data']));
});

test('buildArgs: ls without paths omits the -- separator', () => {
    assert.deepEqual(R.buildArgs('ls', Object.assign({ snapshot: 'latest' }, REPO)),
        HEAD.concat(['ls', 'latest']));
});

test('buildArgs: ls rejects a missing snapshot', () => {
    assert.throws(() => R.buildArgs('ls', REPO), /ls requires a snapshot/);
});

test('buildArgs: diff needs both snapshots', () => {
    assert.deepEqual(R.buildArgs('diff', Object.assign({ snapshotA: 'aaa', snapshotB: 'bbb' }, REPO)),
        HEAD.concat(['diff', 'aaa', 'bbb']));
    assert.throws(() => R.buildArgs('diff', Object.assign({ snapshotA: 'aaa' }, REPO)),
        /requires two snapshots/);
});

test('buildArgs: unlock, optionally removing all locks', () => {
    assert.deepEqual(R.buildArgs('unlock', REPO), HEAD.concat(['unlock']));
    assert.deepEqual(R.buildArgs('unlock', Object.assign({ removeAll: true }, REPO)),
        HEAD.concat(['unlock', '--remove-all']));
});

test('buildArgs: version needs neither a repository nor --json', () => {
    assert.deepEqual(R.buildArgs('version', {}), ['version']);
    assert.deepEqual(R.buildArgs('version'), ['version']);
});

test('buildArgs: every repository-scoped op requires a repoUrl', () => {
    R.OPS.filter((op) => op !== 'version').forEach((op) => {
        assert.throws(() => R.buildArgs(op, {}), /repository URL is required/, op);
    });
});

test('buildArgs: the password file is optional', () => {
    assert.deepEqual(R.buildArgs('snapshots', { repoUrl: '/srv/repo' }),
        ['-r', '/srv/repo', '--cache-dir', R.CACHE_DIR, '--json', 'snapshots']);
});

test('buildArgs: --json is emitted for every op except version', () => {
    const opts = {
        repoUrl: '/srv/repo', paths: ['/srv'], snapshot: 'latest',
        snapshotA: 'a', snapshotB: 'b', target: '/tmp/t'
    };
    R.OPS.forEach((op) => {
        const has = R.buildArgs(op, opts).indexOf('--json') >= 0;
        assert.equal(has, op !== 'version', op);
    });
});

test('buildArgs: an unknown op throws a typed GENERIC error', () => {
    ['', null, undefined, 'mount', 'rm -rf /'].forEach((op) => {
        assert.throws(() => R.buildArgs(op, REPO), (e) => {
            assert.ok(Errors.isHangarError(e));
            assert.equal(e.kind, Errors.KIND.GENERIC);
            assert.match(e.message, /Unsupported restic operation/);
            return true;
        });
    });
});

test('buildArgs: a hostile repository URL is passed as one argument, not shell text', () => {
    const args = R.buildArgs('snapshots', { repoUrl: 'sftp:u@h:/p; rm -rf /' });
    assert.equal(args[1], 'sftp:u@h:/p; rm -rf /');
});

// -------------------------------------------------------------------- summarize

test('summarize: empty input is unknown, not success', () => {
    assert.deepEqual(R.summarize([]),
        { status: 'unknown', summary: null, errors: [], progress: null });
    assert.equal(R.summarize(null).status, 'unknown');
    assert.equal(R.summarize('nonsense').status, 'unknown');
});

test('summarize: only status messages means still running, latest wins', () => {
    const out = R.summarize([
        { message_type: 'status', percent_done: 0.1 },
        { message_type: 'status', percent_done: 0.8 }
    ]);
    assert.equal(out.status, 'running');
    assert.equal(out.progress.percent_done, 0.8);
});

test('summarize: the last summary wins', () => {
    const out = R.summarize([
        { message_type: 'summary', snapshot_id: 'aaa' },
        { message_type: 'summary', snapshot_id: 'bbb' }
    ]);
    assert.equal(out.status, 'ok');
    assert.equal(out.summary.snapshot_id, 'bbb');
});

test('summarize: every error is collected', () => {
    const out = R.summarize([
        { message_type: 'error', item: '/a' },
        { message_type: 'status', percent_done: 0.5 },
        { message_type: 'error', item: '/b' }
    ]);
    assert.equal(out.status, 'failed');
    assert.deepEqual(out.errors.map((e) => e.item), ['/a', '/b']);
});

test('summarize: a summary alongside errors is partial success', () => {
    const out = R.summarize(R.parseJsonLines(fixture('synthetic-backup-jsonlines.txt')));
    assert.equal(out.status, 'partial');
    assert.equal(out.errors.length, 1);
    assert.equal(out.summary.snapshot_id, '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b');
    assert.equal(out.progress.percent_done, 0.9);
});

test('summarize: an exit_error is always failure', () => {
    const out = R.summarize([
        { message_type: 'summary', snapshot_id: 'aaa' },
        { message_type: 'exit_error', code: 11, message: 'locked' }
    ]);
    assert.equal(out.status, 'failed');
});

test('summarize: unknown message types are ignored without affecting status', () => {
    const out = R.summarize([
        { message_type: 'future_thing' },
        { message_type: 'verbose_status', action: 'new' },
        { message_type: 'summary', snapshot_id: 'aaa' }
    ]);
    assert.equal(out.status, 'ok');
    assert.equal(out.errors.length, 0);
});

// ---------------------------------------------------------------- parseSnapshots

test('parseSnapshots: empty output and an empty array both give no snapshots', () => {
    assert.deepEqual(R.parseSnapshots(''), []);
    assert.deepEqual(R.parseSnapshots('   \n'), []);
    assert.deepEqual(R.parseSnapshots('[]'), []);
    assert.deepEqual(R.parseSnapshots(null), []);
});

test('parseSnapshots: normalizes the fixture', () => {
    const snaps = R.parseSnapshots(fixture('synthetic-snapshots.json'));
    assert.equal(snaps.length, 2);
    assert.equal(snaps[0].shortId, '1a2b3c4d');
    assert.equal(snaps[0].hostname, 'hangar-dev');
    assert.deepEqual(snaps[0].paths, ['/srv/data', '/etc']);
    assert.deepEqual(snaps[0].tags, ['nightly', 'hangar:job=daily']);
    assert.equal(snaps[0].programVersion, 'restic 0.19.1');
    assert.equal(snaps[0].summary.files_new, 9);
});

test('parseSnapshots: shortId falls back to the first eight id characters', () => {
    const snaps = R.parseSnapshots(fixture('synthetic-snapshots.json'));
    assert.equal(snaps[1].shortId, '9f8e7d6c');
    assert.equal(snaps[1].parent, null);
    assert.equal(snaps[1].summary, null);
});

test('parseSnapshots: input order is preserved', () => {
    const snaps = R.parseSnapshots(fixture('synthetic-snapshots.json'));
    assert.ok(snaps[0].time < snaps[1].time);
});

test('parseSnapshots: malformed JSON throws a typed GENERIC error', () => {
    assert.throws(() => R.parseSnapshots('[{"id":'), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.equal(e.kind, Errors.KIND.GENERIC);
        return true;
    });
});

test('parseSnapshots: a non-list document is rejected', () => {
    assert.throws(() => R.parseSnapshots('{"id":"aaa"}'), /did not return a list/);
});

// ------------------------------------------------------------------- parseForget

test('parseForget: empty output is an empty result', () => {
    assert.deepEqual(R.parseForget(''), { groups: [], kept: 0, removed: 0 });
    assert.deepEqual(R.parseForget('[]'), { groups: [], kept: 0, removed: 0 });
});

test('parseForget: counts kept and removed across groups', () => {
    const out = R.parseForget(fixture('synthetic-forget.json'));
    assert.equal(out.groups.length, 1);
    assert.equal(out.kept, 2);
    assert.equal(out.removed, 1);
    assert.equal(out.groups[0].host, 'hangar-dev');
    assert.deepEqual(out.groups[0].paths, ['/srv/data', '/etc']);
    assert.equal(out.groups[0].remove[0].shortId, 'deadbeef');
    assert.equal(out.groups[0].reasons.length, 1);
});

test('parseForget: a null tags field normalizes to an empty list', () => {
    assert.deepEqual(R.parseForget(fixture('synthetic-forget.json')).groups[0].tags, []);
});

test('parseForget: a group with nothing to remove counts zero', () => {
    const out = R.parseForget('[{"host":"h","paths":["/srv"],"keep":[{"id":"aa"}],"remove":null}]');
    assert.equal(out.kept, 1);
    assert.equal(out.removed, 0);
});

test('parseForget: malformed output throws GENERIC', () => {
    assert.throws(() => R.parseForget('not json'), /Could not parse restic forget/);
});

// -------------------------------------------------------------------- parseStats

test('parseStats: empty output yields zeroed counters', () => {
    assert.deepEqual(R.parseStats(''), {
        totalSize: 0, totalFileCount: 0, totalBlobCount: 0, totalUncompressedSize: 0,
        compressionRatio: 0, compressionSpaceSaving: 0, snapshotsCount: 0
    });
});

test('parseStats: normalizes the fixture into camelCase', () => {
    const s = R.parseStats(fixture('synthetic-stats.json'));
    assert.equal(s.totalSize, 1181116006);
    assert.equal(s.totalFileCount, 10432);
    assert.equal(s.totalBlobCount, 4211);
    assert.equal(s.snapshotsCount, 27);
    assert.equal(s.compressionRatio, 1.25);
});

test('parseStats: missing fields become 0 rather than undefined', () => {
    const s = R.parseStats('{"total_size":10}');
    assert.equal(s.totalSize, 10);
    assert.equal(s.snapshotsCount, 0);
});

test('parseStats: non-numeric values do not leak NaN into the UI', () => {
    const s = R.parseStats('{"total_size":"huge"}');
    assert.equal(s.totalSize, 0);
});

test('parseStats: malformed output throws GENERIC', () => {
    assert.throws(() => R.parseStats('{oops'), /Could not parse restic stats/);
});

// --------------------------------------------------------------------- parseDiff

test('parseDiff: empty output is an empty diff', () => {
    assert.deepEqual(R.parseDiff(''), {
        source: null, target: null, added: [], removed: [], changed: [], other: [], stats: null
    });
    assert.deepEqual(R.parseDiff(null).added, []);
});

test('parseDiff: buckets changes by modifier', () => {
    const d = R.parseDiff(fixture('synthetic-diff.json'));
    assert.equal(d.source, '1a2b3c4d');
    assert.equal(d.target, '9f8e7d6c');
    assert.deepEqual(d.added.map((c) => c.path), ['/srv/data/new.bin']);
    assert.deepEqual(d.removed.map((c) => c.path), ['/srv/data/gone.bin']);
    assert.deepEqual(d.changed.map((c) => c.path), ['/etc/hosts', '/srv/data/link']);
    assert.equal(d.stats.changed_files, 2);
});

test('parseDiff: an unrecognised modifier is surfaced, not dropped', () => {
    const d = R.parseDiff(fixture('synthetic-diff.json'));
    assert.deepEqual(d.other.map((c) => c.path), ['/srv/data/odd']);
});

test('parseDiff: a document with no changes array is still valid', () => {
    const d = R.parseDiff('{"source_snapshot":"a","target_snapshot":"b"}');
    assert.equal(d.source, 'a');
    assert.deepEqual(d.added, []);
});

test('parseDiff: a JSON-lines diff stream is accepted too', () => {
    const text = '{"message_type":"change","path":"/a","modifier":"+"}\n' +
                 '{"message_type":"change","path":"/b","modifier":"-"}\n' +
                 '{"message_type":"statistics","source_snapshot":"aaa","target_snapshot":"bbb","changed_files":1}';
    const d = R.parseDiff(text);
    assert.deepEqual(d.added.map((c) => c.path), ['/a']);
    assert.deepEqual(d.removed.map((c) => c.path), ['/b']);
    assert.equal(d.source, 'aaa');
    assert.equal(d.stats.changed_files, 1);
});

test('parseDiff: unparseable output throws GENERIC', () => {
    assert.throws(() => R.parseDiff('total garbage, no json at all'), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.equal(e.kind, Errors.KIND.GENERIC);
        return true;
    });
});

// --------------------------------------------------------------------------- run

// run() is the only impure function; these tests drive it through a stand-in
// `cockpit` global so the streaming and rejection paths are still covered.
function withCockpit(spawn, fn) {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'cockpit');
    const prev = globalThis.cockpit;
    globalThis.cockpit = { spawn: spawn };
    return Promise.resolve().then(fn).finally(() => {
        if (had) globalThis.cockpit = prev;
        else delete globalThis.cockpit;
    });
}

function fakeProc(chunks, failure) {
    let onChunk = null;
    const proc = {
        stream(cb) { onChunk = cb; return proc; },
        then(ok, bad) {
            return Promise.resolve().then(() => {
                chunks.forEach((c) => { if (onChunk) onChunk(c); });
                return failure ? bad(failure) : ok('');
            });
        }
    };
    return proc;
}

test('run: rejects with GENERIC when cockpit is absent', async () => {
    assert.equal(typeof globalThis.cockpit, 'undefined');
    await assert.rejects(R.run('snapshots', { repoUrl: '/srv/repo' }), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.equal(e.kind, Errors.KIND.GENERIC);
        assert.match(e.message, /cockpit is not available/);
        return true;
    });
});

test('run: rejects with the buildArgs error before spawning anything', async () => {
    await assert.rejects(R.run('nope', { repoUrl: '/srv/repo' }), /Unsupported restic operation/);
});

test('run: streams status messages to onProgress and resolves with the summary', async () => {
    let argv = null;
    let options = null;
    const text = fixture('synthetic-backup-jsonlines.txt');
    const spawn = (a, o) => { argv = a; options = o; return fakeProc([text.slice(0, 300), text.slice(300)]); };

    await withCockpit(spawn, async () => {
        const seen = [];
        const out = await R.run('backup', { repoUrl: '/srv/repo', paths: ['/srv/data'] }, (m) => seen.push(m));
        assert.equal(argv[0], 'restic');
        assert.deepEqual(options, { superuser: 'require', err: 'message' });
        assert.equal(seen.length, 3);
        assert.equal(out.status, 'partial');
        assert.equal(out.summary.total_files_processed, 12);
    });
});

test('run: a throwing onProgress callback does not abort the run', async () => {
    const spawn = () => fakeProc(['{"message_type":"status","percent_done":0.5}\n{"message_type":"summary","snapshot_id":"x"}\n']);
    await withCockpit(spawn, async () => {
        const out = await R.run('backup', { repoUrl: '/srv/repo', paths: ['/srv'] }, () => { throw new Error('ui blew up'); });
        assert.equal(out.status, 'ok');
    });
});

test('run: rejects with the classified error on a fatal exit', async () => {
    const spawn = () => fakeProc([], { exit_status: 12, message: '{"message_type":"exit_error","code":12,"message":"wrong password or no key found"}' });
    await withCockpit(spawn, async () => {
        await assert.rejects(R.run('snapshots', { repoUrl: '/srv/repo' }), (e) => {
            assert.equal(e.kind, Errors.KIND.WRONG_PASSWORD);
            assert.equal(e.message, 'wrong password or no key found');
            return true;
        });
    });
});

test('run: exit 3 resolves as partial rather than rejecting', async () => {
    const spawn = () => fakeProc(
        ['{"message_type":"error","item":"/srv/secret"}\n{"message_type":"summary","snapshot_id":"abc"}\n'],
        { exit_status: 3, message: '' }
    );
    await withCockpit(spawn, async () => {
        const out = await R.run('backup', { repoUrl: '/srv/repo', paths: ['/srv'] });
        assert.equal(out.status, 'partial');
        assert.equal(out.summary.snapshot_id, 'abc');
        assert.equal(out.error.kind, Errors.KIND.READ_ERRORS);
    });
});

test('run: exit 130 resolves as cancelled, a neutral state', async () => {
    const spawn = () => fakeProc([], { exit_status: 130, message: '' });
    await withCockpit(spawn, async () => {
        const out = await R.run('backup', { repoUrl: '/srv/repo', paths: ['/srv'] });
        assert.equal(out.status, 'cancelled');
        assert.equal(out.error.kind, Errors.KIND.CANCELLED);
    });
});

test('run: honours a custom binary path for the static fallback', async () => {
    let argv = null;
    const spawn = (a) => { argv = a; return fakeProc([]); };
    await withCockpit(spawn, async () => {
        await R.run('version', { binary: '/usr/local/bin/restic' });
        assert.deepEqual(argv, ['/usr/local/bin/restic', 'version']);
    });
});

// ===========================================================================
// Adversarial pass — hostile input, boundaries, and the paths reached only once
// something has already gone wrong.
//
// One invariant runs through this whole section: no input of any shape may leave
// this module as an untyped exception. Either it copes, or it throws a
// HangarError the UI can turn into an action.
// ===========================================================================

const NULL_PROTO = Object.create(null);                 // String() on this throws
const THROWING = { toString() { throw new Error('boom'); } };
const LONG_PATH = '/srv/' + 'a'.repeat(10000);
const NUL = '\u0000';

function typed(kind) {
    return (e) => {
        assert.ok(Errors.isHangarError(e), 'expected a HangarError, got ' + (e && e.name));
        assert.equal(e.kind, kind || Errors.KIND.GENERIC);
        return true;
    };
}

// Captures the outcome instead of propagating it, so a sweep can assert the class
// of failure across hundreds of inputs.
function attempt(fn) {
    try {
        return { threw: false, value: fn() };
    } catch (e) {
        return { threw: true, error: e };
    }
}

// -------------------------------------------------- parseJsonLines: hostile input

test('parseJsonLines: a raw NUL byte makes the line invalid JSON, so it is dropped', () => {
    assert.deepEqual(R.parseJsonLines('{"a":"x' + NUL + 'y"}\n{"b":2}'), [{ b: 2 }]);
});

test('parseJsonLines: an escaped NUL inside a string is preserved', () => {
    const m = R.parseJsonLines('{"item":"x\\u0000y"}')[0];
    assert.equal(m.item.length, 3);
    assert.equal(m.item.charCodeAt(1), 0);
});

test('parseJsonLines: a byte-order mark ahead of the object is tolerated', () => {
    assert.deepEqual(R.parseJsonLines('\uFEFF{"message_type":"summary"}'), [{ message_type: 'summary' }]);
});

test('parseJsonLines: tabs and stray spaces around a line are trimmed', () => {
    assert.deepEqual(R.parseJsonLines('\t  {"a":1}  \t\n\t\t\n'), [{ a: 1 }]);
});

test('parseJsonLines: a lone CR does not terminate a line', () => {
    // Only \n and \r\n are line breaks; a bare \r leaves one unparseable line.
    assert.deepEqual(R.parseJsonLines('{"a":1}\r{"b":2}'), []);
});

test('parseJsonLines: a pretty-printed document is not reassembled across lines', () => {
    // The contract is line-oriented: multi-line JSON belongs to parseDocument.
    assert.deepEqual(R.parseJsonLines('{\n  "message_type": "summary"\n}'), []);
});

test('parseJsonLines: NaN and Infinity literals are noise, not numbers', () => {
    assert.deepEqual(R.parseJsonLines('{"a":NaN}\n{"b":Infinity}\n{"c":1}'), [{ c: 1 }]);
});

test('parseJsonLines: non-string input never throws', () => {
    [42, true, false, {}, [], () => {}, Symbol('s'), NULL_PROTO, THROWING, new Date(0)].forEach((v) => {
        const r = attempt(() => R.parseJsonLines(v));
        assert.equal(r.threw, false, 'threw for ' + typeof v);
        assert.ok(Array.isArray(r.value));
    });
});

test('parseJsonLines: a one-megabyte line is parsed, not truncated', () => {
    const big = 'z'.repeat(1024 * 1024);
    const m = R.parseJsonLines(JSON.stringify({ message_type: 'error', item: big }));
    assert.equal(m[0].item.length, big.length);
});

test('parseJsonLines: deep nesting survives', () => {
    let obj = { message_type: 'summary' };
    for (let i = 0; i < 200; i++) obj = { nested: obj };
    const m = R.parseJsonLines(JSON.stringify(obj));
    assert.equal(m.length, 1);
});

test('parseJsonLines: a __proto__ payload does not pollute Object.prototype', () => {
    const m = R.parseJsonLines('{"__proto__":{"polluted":1},"message_type":"status"}');
    assert.equal(m.length, 1);
    assert.equal(({}).polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
});

test('parseJsonLines: the ls fixture keeps the snapshot header and every node', () => {
    const msgs = R.parseJsonLines(fixture('synthetic-ls-jsonlines.txt'));
    assert.equal(msgs.length, 5);
    assert.equal(msgs[0].message_type, 'snapshot');
    assert.equal(msgs.filter((m) => m.message_type === 'node').length, 4);
    assert.equal(msgs[4].linktarget, 'report.pdf');
});

// ----------------------------------------------------- classifyExit: hostile input

test('classifyExit: a status that is not an integer is UNKNOWN, never OK', () => {
    // Regression: Number('') / Number('  ') / Number(false) / Number([]) are all 0,
    // which would have reported a channel failure as a successful backup.
    ['', '   ', '\t', 'abc', '1.5', '0x0A', '1e1', '12abc', [], {}, true, false,
        NaN, Infinity, () => {}, NULL_PROTO, THROWING, Symbol('s')].forEach((c) => {
        const e = R.classifyExit(c, '');
        assert.equal(e.kind, Errors.KIND.UNKNOWN, 'code ' + String(typeof c));
        assert.equal(Errors.isFatal(e), true);
        assert.equal(e.detail.code, null);
    });
});

test('classifyExit: fractional and negative statuses are not success', () => {
    [1.5, -1, -0.0001, 130.5].forEach((c) => {
        assert.equal(R.classifyExit(c, '').kind, Errors.KIND.UNKNOWN, 'code ' + c);
    });
});

test('classifyExit: whitespace around a numeric status is tolerated', () => {
    assert.equal(R.classifyExit(' 12 ', '').kind, Errors.KIND.WRONG_PASSWORD);
    assert.equal(R.classifyExit('\t3\n', '').kind, Errors.KIND.READ_ERRORS);
});

test('classifyExit: non-string stderr never throws and always lands as text', () => {
    [42, true, {}, [], () => {}, NULL_PROTO, THROWING, Symbol('s')].forEach((s) => {
        const r = attempt(() => R.classifyExit(1, s));
        assert.equal(r.threw, false, 'threw for ' + typeof s);
        assert.equal(typeof r.value.detail.stderr, 'string');
        assert.ok(Errors.isHangarError(r.value));
    });
});

test('classifyExit: an exit_error message that is not a string falls back to the catalogue', () => {
    const e = R.classifyExit(11, '{"message_type":"exit_error","code":11,"message":42}');
    assert.equal(e.message, R.MESSAGES[Errors.KIND.REPO_LOCKED]);
    assert.equal(e.kind, Errors.KIND.REPO_LOCKED);
});

test('classifyExit: a whitespace-only exit_error message falls back to the catalogue', () => {
    const e = R.classifyExit(10, '{"message_type":"exit_error","code":10,"message":"   "}');
    assert.equal(e.message, R.MESSAGES[Errors.KIND.REPO_MISSING]);
});

test('classifyExit: the exit_error message is trimmed', () => {
    const e = R.classifyExit(1, '{"message_type":"exit_error","code":1,"message":"  boom  "}');
    assert.equal(e.message, 'boom');
});

test('classifyExit: a string exit_error code is honoured when the status is missing', () => {
    const e = R.classifyExit(null, '{"message_type":"exit_error","code":"12","message":"nope"}');
    assert.equal(e.kind, Errors.KIND.WRONG_PASSWORD);
    assert.equal(e.detail.code, 12);
});

test('classifyExit: a non-numeric exit_error code stays UNKNOWN but keeps the message', () => {
    const e = R.classifyExit(null, '{"message_type":"exit_error","code":"fatal","message":"broken"}');
    assert.equal(e.kind, Errors.KIND.UNKNOWN);
    assert.equal(e.message, 'broken');
    assert.equal(e.detail.code, null);
});

test('classifyExit: no-space wins over network when both phrases appear', () => {
    const e = R.classifyExit(1, 'dial tcp 10.0.0.9:8000 ... write: no space left on device');
    assert.equal(e.kind, Errors.KIND.NO_SPACE);
});

test('classifyExit: every documented full-disk phrasing is recognised', () => {
    ['no space left on device', 'Disk quota exceeded', 'not enough space',
        'not enough free space', 'ENOSPC', 'write: no space'].forEach((s) => {
        assert.equal(R.classifyExit(1, 'restic: ' + s).kind, Errors.KIND.NO_SPACE, s);
    });
});

test('classifyExit: every documented unreachable-backend phrasing is recognised', () => {
    ['connection refused', 'connection reset', 'network is unreachable', 'no such host',
        'i/o timeout', 'dial tcp', 'temporary failure in name resolution',
        'TLS handshake timeout', 'could not connect', 'ssh: connect to host',
        'host is down', 'no route to host'].forEach((s) => {
        assert.equal(R.classifyExit(1, 'restic: ' + s).kind, Errors.KIND.NETWORK, s);
    });
});

test('classifyExit: backend sniffing is case-insensitive', () => {
    assert.equal(R.classifyExit(1, 'NO SPACE LEFT ON DEVICE').kind, Errors.KIND.NO_SPACE);
    assert.equal(R.classifyExit(1, 'Connection Refused').kind, Errors.KIND.NETWORK);
});

test('classifyExit: a backend phrase under exit 0 does not turn success into failure', () => {
    const e = R.classifyExit(0, 'note: no space left on device (from a hook)');
    assert.equal(e.kind, Errors.KIND.OK);
    assert.equal(Errors.isFatal(e), false);
});

test('classifyExit: an exit_error buried in noise is still found', () => {
    const stderr = 'Load(<lock/abc>) failed\nsome plain text\n' +
                   '{"message_type":"status","percent_done":1}\n' +
                   '{"message_type":"exit_error","code":11,"message":"locked"}\ntrailing noise';
    const e = R.classifyExit(null, stderr);
    assert.equal(e.kind, Errors.KIND.REPO_LOCKED);
    assert.equal(e.message, 'locked');
});

test('classifyExit: a non-exit_error JSON object never supplies the message', () => {
    const e = R.classifyExit(1, '{"message_type":"error","message":"just one file"}');
    assert.equal(e.message, R.MESSAGES[Errors.KIND.GENERIC]);
    assert.equal(e.detail.exitError, null);
});

test('classifyExit: unicode in the exit_error message survives', () => {
    const stderr = JSON.stringify({ message_type: 'exit_error', code: 1, message: 'ä ö 日本語 /srv/データ' });
    assert.equal(R.classifyExit(1, stderr).message, 'ä ö 日本語 /srv/データ');
});

test('classifyExit: exit 130 keeps the restic message and stays non-fatal', () => {
    const e = R.classifyExit(130, '{"message_type":"exit_error","code":130,"message":"interrupted"}');
    assert.equal(e.kind, Errors.KIND.CANCELLED);
    assert.equal(e.message, 'interrupted');
    assert.equal(Errors.isFatal(e), false);
});

test('classifyExit: a one-megabyte stderr is kept verbatim for the log tail', () => {
    const big = 'x'.repeat(1024 * 1024);
    assert.equal(R.classifyExit(1, big).detail.stderr.length, big.length);
});

test('classifyExit: the exit table and the message catalogue agree', () => {
    Object.keys(R.EXIT_KINDS).forEach((code) => {
        const kind = R.EXIT_KINDS[code];
        assert.ok(Errors.KIND[kind], 'exit ' + code + ' maps to an unknown kind');
        assert.ok(R.MESSAGES[kind], 'no message for ' + kind);
    });
    Object.keys(Errors.KIND).forEach((kind) => {
        assert.ok(R.MESSAGES[kind], 'no message for kind ' + kind);
    });
});

test('classifyExit: kinds without a one-click fix report no remediation', () => {
    [0, 1, 2, 99].forEach((c) => {
        const e = R.classifyExit(c, '');
        assert.equal(Errors.remediationFor(e), null, 'code ' + c);
    });
});

// --------------------------------------------------------- buildArgs: hostile sweep

const HOSTILE_VALUES = [
    null, undefined, '', '   ', 0, -1, 1.5, true, false, NaN, [], {}, [[]], [null],
    ['', null], NULL_PROTO, THROWING, Symbol('s'), () => {}, '../../../etc/shadow',
    '; rm -rf /', '$(id)', '`id`', '| tee /etc/passwd', '\n--exclude\n', 'x' + NUL + 'y',
    '日本語 ä ö', LONG_PATH, ['/a', NULL_PROTO], 1e999
];

const BASE_OPTS = {
    init: { repoUrl: '/srv/repo' },
    backup: { repoUrl: '/srv/repo', paths: ['/srv'] },
    snapshots: { repoUrl: '/srv/repo' },
    forget: { repoUrl: '/srv/repo' },
    prune: { repoUrl: '/srv/repo' },
    check: { repoUrl: '/srv/repo' },
    stats: { repoUrl: '/srv/repo' },
    restore: { repoUrl: '/srv/repo', snapshot: 'abc', target: '/var/tmp/r' },
    ls: { repoUrl: '/srv/repo', snapshot: 'abc' },
    diff: { repoUrl: '/srv/repo', snapshotA: 'a', snapshotB: 'b' },
    unlock: { repoUrl: '/srv/repo' },
    version: {}
};

const OPTION_KEYS = [
    'repoUrl', 'passwordFile', 'paths', 'excludes', 'excludeFile', 'tags', 'host', 'dryRun',
    'oneFileSystem', 'snapshot', 'snapshotIds', 'target', 'include', 'verify', 'long',
    'recursive', 'snapshotA', 'snapshotB', 'metadata', 'mode', 'maxUnused', 'readData',
    'withCache', 'removeAll', 'latest', 'retentionArgs', 'groupBy', 'prune', 'binary'
];

test('buildArgs: no option value of any type produces an untyped exception', () => {
    let calls = 0;
    R.OPS.forEach((op) => {
        OPTION_KEYS.forEach((key) => {
            HOSTILE_VALUES.forEach((value) => {
                const opts = Object.assign({}, BASE_OPTS[op]);
                opts[key] = value;
                calls++;
                const r = attempt(() => R.buildArgs(op, opts));
                if (r.threw)
                    assert.ok(Errors.isHangarError(r.error),
                        op + '.' + key + ' threw ' + (r.error && r.error.name));
                else
                    assert.ok(Array.isArray(r.value), op + '.' + key + ' returned a non-array');
            });
        });
    });
    assert.ok(calls > 10000, 'the sweep should be exhaustive');
});

test('buildArgs: every emitted argument is a non-empty string', () => {
    // An empty argv element is not harmless: restic reads it as the operand of the
    // preceding flag, or as the current directory.
    R.OPS.forEach((op) => {
        OPTION_KEYS.forEach((key) => {
            HOSTILE_VALUES.forEach((value) => {
                const opts = Object.assign({}, BASE_OPTS[op]);
                opts[key] = value;
                const r = attempt(() => R.buildArgs(op, opts));
                if (r.threw) return;
                r.value.forEach((a, i) => {
                    assert.equal(typeof a, 'string', op + '.' + key + ' arg ' + i + ' is not a string');
                    assert.ok(a.length > 0, op + '.' + key + ' emitted an empty argument');
                });
            });
        });
    });
});

test('buildArgs: an unstringifiable repository URL is rejected as missing', () => {
    [NULL_PROTO, THROWING].forEach((v) => {
        assert.throws(() => R.buildArgs('snapshots', { repoUrl: v }),
            typed(Errors.KIND.GENERIC));
    });
});

test('buildArgs: unstringifiable paths leave backup with nothing to back up', () => {
    assert.throws(() => R.buildArgs('backup', { repoUrl: '/r', paths: [NULL_PROTO, THROWING] }),
        /at least one path/);
});

test('buildArgs: operation matching is exact and case-sensitive', () => {
    ['Backup', 'BACKUP', ' backup', 'backup ', 'backup\n', 'back up', 'restic backup'].forEach((op) => {
        assert.throws(() => R.buildArgs(op, REPO), typed(Errors.KIND.GENERIC), op);
    });
});

test('buildArgs: inherited Object properties are not operations', () => {
    ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'].forEach((op) => {
        assert.throws(() => R.buildArgs(op, REPO), /Unsupported restic operation/, op);
    });
});

test('buildArgs: an unstringifiable operation is reported, not crashed on', () => {
    [NULL_PROTO, THROWING, Symbol('s'), {}, [], 0, NaN].forEach((op) => {
        assert.throws(() => R.buildArgs(op, REPO), typed(Errors.KIND.GENERIC));
    });
});

test('buildArgs: shell metacharacters are carried, never interpreted', () => {
    // argv is a list; there is no shell. The proof is that each hostile string is
    // exactly one element, unquoted and unescaped.
    const nasty = ['; rm -rf /', '$(id)', '`id`', '| tee /etc/passwd', '&& reboot',
        '> /etc/shadow', "'", '"', '\\', '*', '?', '~/x'];
    nasty.forEach((s) => {
        const args = R.buildArgs('backup', { repoUrl: '/r', paths: [s], tags: [s], host: s });
        assert.equal(args[args.length - 1], s);
        assert.equal(args.filter((a) => a === s).length, 3);
    });
});

test('buildArgs: a NUL byte in a path is neither stripped nor split', () => {
    const p = '/srv/data' + NUL + 'evil';
    const args = R.buildArgs('backup', { repoUrl: '/r', paths: [p] });
    assert.equal(args[args.length - 1], p);
    assert.equal(args[args.length - 1].length, p.length);
});

test('buildArgs: a ten thousand character path is not truncated', () => {
    const args = R.buildArgs('backup', { repoUrl: '/r', paths: [LONG_PATH] });
    assert.equal(args[args.length - 1].length, LONG_PATH.length);
});

test('buildArgs: unicode paths and tags survive byte for byte', () => {
    const p = '/srv/データ/ä ö/🗄';
    const args = R.buildArgs('backup', { repoUrl: '/r', paths: [p], tags: ['ключ=значение'] });
    assert.ok(args.includes(p));
    assert.ok(args.includes('ключ=значение'));
});

test('buildArgs: an embedded newline stays inside one argument', () => {
    const args = R.buildArgs('backup', { repoUrl: '/r', paths: ['/srv'], tags: ['a\nb'] });
    assert.ok(args.includes('a\nb'));
    assert.equal(args.filter((a) => a.indexOf('\n') >= 0).length, 1);
});

test('buildArgs: a path that is literally -- still lands after the separator', () => {
    const args = R.buildArgs('backup', { repoUrl: '/r', paths: ['--'] });
    assert.deepEqual(args.slice(-2), ['--', '--']);
});

test('buildArgs: traversal is passed verbatim — resolving it is not this layer\'s job', () => {
    const args = R.buildArgs('backup', { repoUrl: '/r', paths: ['../../../etc/shadow'] });
    assert.equal(args[args.length - 1], '../../../etc/shadow');
});

test('buildArgs: a paths list of only empties is rejected, not silently emptied', () => {
    [['', null, undefined], [null], [''], [NULL_PROTO]].forEach((paths) => {
        assert.throws(() => R.buildArgs('backup', Object.assign({ paths: paths }, REPO)),
            typed(Errors.KIND.GENERIC));
    });
});

test('buildArgs: a whitespace-only path is kept — a directory of spaces is legal', () => {
    const args = R.buildArgs('backup', Object.assign({ paths: ['   '] }, REPO));
    assert.equal(args[args.length - 1], '   ');
});

test('buildArgs: bare strings are accepted wherever a list is', () => {
    const args = R.buildArgs('backup', {
        repoUrl: '/r', paths: '/srv', excludes: '*.tmp', tags: 'nightly'
    });
    assert.deepEqual(args, ['-r', '/r', '--cache-dir', R.CACHE_DIR, '--json', 'backup', '--exclude', '*.tmp',
        '--tag', 'nightly', '--', '/srv']);
});

test('buildArgs: backup flag order is stable with every option set', () => {
    const args = R.buildArgs('backup', Object.assign({
        paths: ['/srv'], excludes: ['*.tmp'], tags: ['t'], oneFileSystem: true,
        excludeFile: '/e.txt', host: 'h', dryRun: true
    }, REPO));
    assert.deepEqual(args, HEAD.concat([
        'backup', '--one-file-system', '--exclude-file', '/e.txt', '--exclude', '*.tmp',
        '--tag', 't', '--host', 'h', '--dry-run', '--', '/srv'
    ]));
});

test('buildArgs: falsy boolean options emit nothing at all', () => {
    [false, 0, '', null, undefined, NaN].forEach((v) => {
        assert.deepEqual(R.buildArgs('backup', Object.assign({ paths: ['/srv'], oneFileSystem: v, dryRun: v }, REPO)),
            HEAD.concat(['backup', '--', '/srv']));
        assert.deepEqual(R.buildArgs('unlock', Object.assign({ removeAll: v }, REPO)),
            HEAD.concat(['unlock']));
        assert.deepEqual(R.buildArgs('check', Object.assign({ readData: v, withCache: v }, REPO)),
            HEAD.concat(['check']));
    });
});

test('buildArgs: a boolean flag is emitted once, never duplicated', () => {
    const args = R.buildArgs('prune', Object.assign({ dryRun: 'yes' }, REPO));
    assert.equal(args.filter((a) => a === '--dry-run').length, 1);
});

test('buildArgs: a numeric read-data subset becomes a subset argument', () => {
    assert.deepEqual(R.buildArgs('check', Object.assign({ readData: 1 }, REPO)),
        HEAD.concat(['check', '--read-data-subset', '1']));
    assert.deepEqual(R.buildArgs('check', Object.assign({ readData: '5%' }, REPO)),
        HEAD.concat(['check', '--read-data-subset', '5%']));
});

test('buildArgs: check --with-cache is emitted after the read-data choice', () => {
    assert.deepEqual(R.buildArgs('check', Object.assign({ readData: true, withCache: true }, REPO)),
        HEAD.concat(['check', '--read-data', '--with-cache']));
});

test('buildArgs: forget drops holes in retentionArgs instead of relaying them', () => {
    // Regression: an empty argv element is read by restic as a snapshot id, so a
    // half-filled policy would have meant something entirely different.
    const args = R.buildArgs('forget', Object.assign({
        retentionArgs: [null, '', '--keep-last', 5, undefined, NULL_PROTO]
    }, REPO));
    assert.deepEqual(args, HEAD.concat(['forget', '--keep-last', '5']));
});

test('buildArgs: forget accepts a single retention flag as a string', () => {
    assert.deepEqual(R.buildArgs('forget', Object.assign({ retentionArgs: '--keep-last' }, REPO)),
        HEAD.concat(['forget', '--keep-last']));
});

test('buildArgs: forget with no retention at all still builds a valid argv', () => {
    assert.deepEqual(R.buildArgs('forget', REPO), HEAD.concat(['forget']));
});

test('buildArgs: forget skips an unusable groupBy rather than emitting a bare flag', () => {
    [NULL_PROTO, THROWING, '', 0, false].forEach((v) => {
        const args = R.buildArgs('forget', Object.assign({ retentionArgs: ['--keep-last', '5'], groupBy: v }, REPO));
        assert.equal(args.indexOf('--group-by'), -1);
    });
});

test('buildArgs: snapshots --latest accepts a number', () => {
    assert.deepEqual(R.buildArgs('snapshots', Object.assign({ latest: 5 }, REPO)),
        HEAD.concat(['snapshots', '--latest', '5']));
});

test('buildArgs: positional snapshot ids are appended last and empties dropped', () => {
    const args = R.buildArgs('stats', Object.assign({ mode: 'raw-data', snapshotIds: ['', 'aa', null, 'bb'] }, REPO));
    assert.deepEqual(args, HEAD.concat(['stats', '--mode', 'raw-data', 'aa', 'bb']));
});

test('buildArgs: restore rejects every falsy target', () => {
    [0, '', null, undefined, false, NaN, NULL_PROTO, THROWING].forEach((t) => {
        assert.throws(() => R.buildArgs('restore', Object.assign({ snapshot: 'abc', target: t }, REPO)),
            /requires a target directory/);
    });
});

test('buildArgs: restore keeps the snapshot last with every option set', () => {
    const args = R.buildArgs('restore', Object.assign({
        snapshot: 'abc', target: '/t', include: ['/a'], excludes: ['*.tmp'], verify: true
    }, REPO));
    assert.deepEqual(args, HEAD.concat([
        'restore', '--target', '/t', '--include', '/a', '--exclude', '*.tmp', '--verify', 'abc'
    ]));
});

test('buildArgs: ls omits the separator for every empty paths shape', () => {
    [[], [''], [null], null, undefined, ''].forEach((paths) => {
        const args = R.buildArgs('ls', Object.assign({ snapshot: 'latest', paths: paths }, REPO));
        assert.deepEqual(args, HEAD.concat(['ls', 'latest']));
    });
});

test('buildArgs: diff rejects a missing snapshot on either side', () => {
    ['', null, undefined, NULL_PROTO, THROWING].forEach((v) => {
        assert.throws(() => R.buildArgs('diff', Object.assign({ snapshotA: v, snapshotB: 'b' }, REPO)),
            /requires two snapshots/);
        assert.throws(() => R.buildArgs('diff', Object.assign({ snapshotA: 'a', snapshotB: v }, REPO)),
            /requires two snapshots/);
    });
});

test('buildArgs: a numeric snapshot id is stringified, not rejected as falsy', () => {
    // Snapshot ids are hex prefixes, so "0" is a legal one — only null/undefined and
    // the empty string mean "the user did not choose a snapshot".
    assert.deepEqual(R.buildArgs('ls', Object.assign({ snapshot: 0 }, REPO)),
        HEAD.concat(['ls', '0']));
    assert.deepEqual(R.buildArgs('diff', Object.assign({ snapshotA: 0, snapshotB: 1 }, REPO)),
        HEAD.concat(['diff', '0', '1']));
});

test('buildArgs: diff --metadata precedes the two snapshots', () => {
    assert.deepEqual(R.buildArgs('diff', Object.assign({ snapshotA: 'a', snapshotB: 'b', metadata: true }, REPO)),
        HEAD.concat(['diff', '--metadata', 'a', 'b']));
});

test('buildArgs: the options object is never mutated', () => {
    const opts = Object.assign({ paths: ['/srv'], tags: ['t'], retentionArgs: ['--keep-last', '5'] }, REPO);
    const before = JSON.stringify(opts);
    R.buildArgs('backup', opts);
    R.buildArgs('forget', opts);
    assert.equal(JSON.stringify(opts), before);
});

test('buildArgs: each call returns a fresh array', () => {
    const a = R.buildArgs('version', {});
    const b = R.buildArgs('version', {});
    assert.notEqual(a, b);
    a.push('mutated');
    assert.deepEqual(R.buildArgs('version', {}), ['version']);
});

test('buildArgs: options of the wrong type are treated as no options', () => {
    ['a string', 42, true, [], () => {}, NULL_PROTO].forEach((opts) => {
        assert.deepEqual(R.buildArgs('version', opts), ['version']);
        assert.throws(() => R.buildArgs('snapshots', opts), /repository URL is required/);
    });
});

test('buildArgs: the operation name appears once and after every global flag', () => {
    R.OPS.forEach((op) => {
        const args = R.buildArgs(op, Object.assign({ passwordFile: '/k' }, BASE_OPTS[op]));
        const at = args.indexOf(op);
        assert.ok(at >= 0, op + ' missing');
        assert.equal(args.filter((a) => a === op).length, 1, op + ' repeated');
        assert.ok(args.indexOf('--password-file') < at && args.indexOf('--password-file') >= 0, op);
        if (op === 'version') {
            assert.equal(args.indexOf('-r'), -1, 'version is not repository scoped');
            assert.equal(args.indexOf('--json'), -1, op);
        } else {
            assert.equal(args.indexOf('-r'), 0, op);
            assert.ok(args.indexOf('--json') < at, op);
        }
    });
});

test('buildArgs: a password file path with spaces and unicode is one argument', () => {
    const key = '/etc/hangar/repos/ä repo.key';
    const args = R.buildArgs('snapshots', { repoUrl: '/r', passwordFile: key });
    assert.deepEqual(args, ['-r', '/r', '--password-file', key, '--cache-dir', R.CACHE_DIR, '--json', 'snapshots']);
});

// -------------------------------------------------------- summarize: hostile input

test('summarize: any non-array input is unknown', () => {
    [undefined, null, 42, 'text', {}, NULL_PROTO, () => {}, true].forEach((v) => {
        const r = attempt(() => R.summarize(v));
        assert.equal(r.threw, false);
        assert.equal(r.value.status, 'unknown');
    });
});

test('summarize: scalars and nulls inside the list are ignored', () => {
    const out = R.summarize([null, undefined, 42, 'x', [], true, NULL_PROTO]);
    assert.equal(out.status, 'unknown');
    assert.equal(out.errors.length, 0);
});

test('summarize: a percent_done of zero is still progress', () => {
    // Truthiness must not be used here: 0% done is a running backup, not no backup.
    const out = R.summarize([{ message_type: 'status', percent_done: 0 }]);
    assert.equal(out.status, 'running');
    assert.equal(out.progress.percent_done, 0);
});

test('summarize: an exit_error is also counted among the errors', () => {
    const out = R.summarize([{ message_type: 'exit_error', code: 1, message: 'x' }]);
    assert.equal(out.status, 'failed');
    assert.equal(out.errors.length, 1);
});

test('summarize: an exit_error before a summary still fails the run', () => {
    const out = R.summarize([
        { message_type: 'exit_error', code: 11 },
        { message_type: 'summary', snapshot_id: 'aaa' }
    ]);
    assert.equal(out.status, 'failed');
    assert.equal(out.summary.snapshot_id, 'aaa');   // kept for display, not for status
});

test('summarize: a message_type of __proto__ or constructor hits the default branch', () => {
    const out = R.summarize([{ message_type: '__proto__' }, { message_type: 'constructor' },
        { message_type: 'toString' }]);
    assert.equal(out.status, 'unknown');
    assert.equal(({}).polluted, undefined);
});

test('summarize: a message with no message_type is ignored', () => {
    assert.equal(R.summarize([{ percent_done: 0.5 }, { snapshot_id: 'x' }]).status, 'unknown');
});

test('summarize: the input array is not mutated and errors keep identity', () => {
    const a = { message_type: 'error', item: '/a' };
    const list = [a, { message_type: 'status' }];
    const out = R.summarize(list);
    assert.equal(list.length, 2);
    assert.equal(out.errors[0], a);
});

test('summarize: the last status wins even when interleaved with errors', () => {
    const out = R.summarize([
        { message_type: 'status', percent_done: 0.2 },
        { message_type: 'error', item: '/a' },
        { message_type: 'status', percent_done: 0.7 }
    ]);
    assert.equal(out.progress.percent_done, 0.7);
    assert.equal(out.status, 'failed');
});

test('summarize: a ten thousand message stream folds without blowing the stack', () => {
    const list = [];
    for (let i = 0; i < 10000; i++) list.push({ message_type: 'status', percent_done: i / 10000 });
    list.push({ message_type: 'summary', snapshot_id: 'z' });
    const out = R.summarize(list);
    assert.equal(out.status, 'ok');
    assert.equal(out.progress.percent_done, 9999 / 10000);
});

// ---------------------------------------------------- parseSnapshots: hostile input

test('parseSnapshots: hostile text is either parsed or typed, never untyped', () => {
    ['', '   ', 'null', 'true', '42', '"x"', '{}', '[', '[{]', '[{"id":"a"},]',
        '<html>error</html>', '{"a":1}\n{"b":2}', 'ä ö 日本語', NULL_PROTO, THROWING,
        42, true, [], {}, () => {}].forEach((t) => {
        const r = attempt(() => R.parseSnapshots(t));
        if (r.threw) assert.ok(Errors.isHangarError(r.error), 'untyped for ' + typeof t);
        else assert.ok(Array.isArray(r.value));
    });
});

test('parseSnapshots: an id shorter than eight characters is its own short id', () => {
    assert.equal(R.parseSnapshots('[{"id":"abc"}]')[0].shortId, 'abc');
});

test('parseSnapshots: numeric ids are stringified rather than leaked as numbers', () => {
    const s = R.parseSnapshots('[{"id":123456789012,"short_id":12345678}]')[0];
    assert.equal(s.id, '123456789012');
    assert.equal(s.shortId, '12345678');
});

test('parseSnapshots: scalars and arrays inside the list are dropped', () => {
    assert.deepEqual(R.parseSnapshots('["a",1,null,true,[]]'), []);
});

test('parseSnapshots: string paths and tags are normalised to lists', () => {
    const s = R.parseSnapshots('[{"id":"a","paths":"/srv","tags":"nightly"}]')[0];
    assert.deepEqual(s.paths, ['/srv']);
    assert.deepEqual(s.tags, ['nightly']);
});

test('parseSnapshots: a bare object still yields every documented field', () => {
    const s = R.parseSnapshots('[{}]')[0];
    assert.deepEqual(Object.keys(s).sort(), ['excludes', 'hostname', 'id', 'parent', 'paths',
        'programVersion', 'shortId', 'summary', 'tags', 'time', 'tree', 'username'].sort());
    assert.equal(s.id, '');
    assert.equal(s.shortId, '');
    assert.equal(s.time, null);
});

test('parseSnapshots: a summary that is not an object becomes null', () => {
    assert.equal(R.parseSnapshots('[{"id":"a","summary":"broken"}]')[0].summary, null);
    assert.equal(R.parseSnapshots('[{"id":"a","summary":[1,2]}]')[0].summary, null);
});

test('parseSnapshots: unicode hostnames and paths survive', () => {
    const s = R.parseSnapshots('[{"id":"a","hostname":"süd-nas","paths":["/srv/データ"]}]')[0];
    assert.equal(s.hostname, 'süd-nas');
    assert.deepEqual(s.paths, ['/srv/データ']);
});

test('parseSnapshots: whitespace around the document is tolerated', () => {
    assert.equal(R.parseSnapshots('\n\t  [{"id":"a"}]  \n').length, 1);
});

test('parseSnapshots: a JSON-lines stream is rejected — snapshots is one document', () => {
    assert.throws(() => R.parseSnapshots('{"id":"a"}\n{"id":"b"}'), typed(Errors.KIND.GENERIC));
});

test('parseSnapshots: the failure detail carries a bounded excerpt', () => {
    assert.throws(() => R.parseSnapshots('[' + 'x'.repeat(5000)), (e) => {
        assert.equal(e.detail.text.length, 2000);
        return true;
    });
});

test('parseSnapshots: a __proto__ key does not pollute Object.prototype', () => {
    R.parseSnapshots('[{"id":"a","__proto__":{"polluted":1}}]');
    assert.equal(({}).polluted, undefined);
});

test('parseSnapshots: two thousand snapshots normalise without loss', () => {
    const list = [];
    for (let i = 0; i < 2000; i++) list.push({ id: String(i).padStart(64, '0'), hostname: 'h' });
    const snaps = R.parseSnapshots(JSON.stringify(list));
    assert.equal(snaps.length, 2000);
    assert.equal(snaps[1999].shortId, '00000000');
});

// ------------------------------------------------------- parseForget: hostile input

test('parseForget: hostile documents are either empty or typed', () => {
    ['', '   ', 'null', '[]', '[1,2]', '[null]', '["x"]', '{"a":1}', 'garbage', '[',
        NULL_PROTO, THROWING, 42, [], {}].forEach((t) => {
        const r = attempt(() => R.parseForget(t));
        if (r.threw) assert.ok(Errors.isHangarError(r.error), 'untyped for ' + typeof t);
        else assert.equal(typeof r.value.kept, 'number');
    });
});

test('parseForget: non-object groups are dropped', () => {
    assert.deepEqual(R.parseForget('[1,"x",null,[]]'), { groups: [], kept: 0, removed: 0 });
});

test('parseForget: a single keep object is treated as a one-element list', () => {
    const out = R.parseForget('[{"host":"h","keep":{"id":"aa"},"remove":{"id":"bb"}}]');
    assert.equal(out.kept, 1);
    assert.equal(out.removed, 1);
    assert.equal(out.groups[0].remove[0].shortId, 'bb');
});

test('parseForget: scalars inside keep and remove do not inflate the counts', () => {
    const out = R.parseForget('[{"keep":["aa",null,{"id":"bb"}],"remove":[1,2]}]');
    assert.equal(out.kept, 1);
    assert.equal(out.removed, 0);
});

test('parseForget: counts accumulate across several groups', () => {
    const out = R.parseForget('[{"keep":[{"id":"a"},{"id":"b"}],"remove":[{"id":"c"}]},' +
                              '{"keep":[{"id":"d"}],"remove":[{"id":"e"},{"id":"f"}]}]');
    assert.equal(out.groups.length, 2);
    assert.equal(out.kept, 3);
    assert.equal(out.removed, 3);
});

test('parseForget: a single reasons object becomes a one-element list', () => {
    assert.equal(R.parseForget('[{"reasons":{"matches":["daily"]}}]').groups[0].reasons.length, 1);
});

test('parseForget: a group missing host and paths gets empty defaults', () => {
    const g = R.parseForget('[{}]').groups[0];
    assert.equal(g.host, '');
    assert.deepEqual(g.paths, []);
    assert.deepEqual(g.tags, []);
    assert.deepEqual(g.reasons, []);
});

test('parseForget: kept snapshots carry the full normalised shape', () => {
    const s = R.parseForget(fixture('synthetic-forget.json')).groups[0].keep[0];
    assert.equal(s.shortId, '9f8e7d6c');
    assert.equal(s.hostname, 'hangar-dev');
    assert.deepEqual(s.tags, []);
});

// -------------------------------------------------------- parseStats: hostile input

test('parseStats: no input shape leaks NaN, undefined or Infinity', () => {
    ['', '   ', 'null', '[]', '[1]', '{}', '{"total_size":true}', '{"total_size":{}}',
        '{"total_size":[]}', '{"total_size":"12"}', '{"total_size":1e999}',
        '{"total_size":null}', NULL_PROTO, THROWING, 42, [], {}].forEach((t) => {
        const r = attempt(() => R.parseStats(t));
        if (r.threw) {
            assert.ok(Errors.isHangarError(r.error), 'untyped for ' + typeof t);
            return;
        }
        Object.keys(r.value).forEach((k) => {
            assert.equal(typeof r.value[k], 'number', k);
            assert.ok(Number.isFinite(r.value[k]), k + ' is not finite');
        });
    });
});

test('parseStats: an array document yields zeros rather than nonsense', () => {
    assert.equal(R.parseStats('[1,2,3]').totalSize, 0);
    assert.equal(R.parseStats('null').snapshotsCount, 0);
});

test('parseStats: numeric strings are accepted', () => {
    assert.equal(R.parseStats('{"total_size":"1181116006"}').totalSize, 1181116006);
});

test('parseStats: fractional and negative values are preserved as given', () => {
    const s = R.parseStats('{"compression_ratio":1.7531,"total_size":-1}');
    assert.equal(s.compressionRatio, 1.7531);
    assert.equal(s.totalSize, -1);
});

test('parseStats: an overflowing number is clamped to 0, not Infinity', () => {
    assert.equal(R.parseStats('{"total_size":1e999}').totalSize, 0);
});

test('parseStats: exactly the seven documented counters are returned', () => {
    assert.deepEqual(Object.keys(R.parseStats(fixture('synthetic-stats.json'))).sort(),
        ['compressionRatio', 'compressionSpaceSaving', 'snapshotsCount', 'totalBlobCount',
            'totalFileCount', 'totalSize', 'totalUncompressedSize']);
});

test('parseStats: unknown extra fields are ignored', () => {
    const s = R.parseStats('{"total_size":5,"future_field":"x"}');
    assert.equal(s.totalSize, 5);
    assert.equal(s.future_field, undefined);
});

// --------------------------------------------------------- parseDiff: hostile input

test('parseDiff: a non-object JSON document fails loudly instead of showing nothing', () => {
    // An empty Logbook that silently means "parse failed" is the worst outcome here.
    ['[]', '42', '"x"', 'null', 'true', '[{"path":"/a"}]'].forEach((t) => {
        assert.throws(() => R.parseDiff(t), typed(Errors.KIND.GENERIC), t);
    });
});

test('parseDiff: whitespace-only output is an empty diff', () => {
    assert.deepEqual(R.parseDiff('   \n\t '), {
        source: null, target: null, added: [], removed: [], changed: [], other: [], stats: null
    });
});

test('parseDiff: hostile input is either a diff or a typed failure', () => {
    ['', '{', '{}', '{"changes":null}', '{"changes":"x"}', '{"changes":[1,2]}',
        NULL_PROTO, THROWING, 42, [], {}, () => {}].forEach((t) => {
        const r = attempt(() => R.parseDiff(t));
        if (r.threw) assert.ok(Errors.isHangarError(r.error), 'untyped for ' + typeof t);
        else assert.ok(Array.isArray(r.value.added));
    });
});

test('parseDiff: a single change object instead of a list is accepted', () => {
    const d = R.parseDiff('{"changes":{"path":"/a","modifier":"+"}}');
    assert.deepEqual(d.added.map((c) => c.path), ['/a']);
});

test('parseDiff: modifier precedence is added, then removed, then changed', () => {
    const d = R.parseDiff('{"changes":[{"path":"/a","modifier":"+-"},{"path":"/b","modifier":"-M"}]}');
    assert.deepEqual(d.added.map((c) => c.path), ['/a']);
    assert.deepEqual(d.removed.map((c) => c.path), ['/b']);
    assert.equal(d.changed.length, 0);
});

test('parseDiff: U and T modifiers count as changed', () => {
    const d = R.parseDiff('{"changes":[{"path":"/a","modifier":"U"},{"path":"/b","modifier":"T"},{"path":"/c","modifier":"M"}]}');
    assert.deepEqual(d.changed.map((c) => c.path), ['/a', '/b', '/c']);
});

test('parseDiff: a missing or null modifier lands in other, not silently dropped', () => {
    const d = R.parseDiff('{"changes":[{"path":"/a"},{"path":"/b","modifier":null}]}');
    assert.deepEqual(d.other.map((c) => c.path), ['/a', '/b']);
    assert.equal(d.other[0].modifier, '');
});

test('parseDiff: a change without a path is still surfaced', () => {
    const d = R.parseDiff('{"changes":[{"modifier":"+"}]}');
    assert.deepEqual(d.added, [{ path: '', modifier: '+' }]);
});

test('parseDiff: non-object entries in changes are dropped', () => {
    const d = R.parseDiff('{"changes":[1,"x",null,[],{"path":"/a","modifier":"+"}]}');
    assert.equal(d.added.length, 1);
    assert.equal(d.other.length, 0);
});

test('parseDiff: statistics that are not an object become null', () => {
    assert.equal(R.parseDiff('{"statistics":"broken"}').stats, null);
    assert.equal(R.parseDiff('{"statistics":[1]}').stats, null);
});

test('parseDiff: JSON-lines mode ignores messages that carry no path', () => {
    const d = R.parseDiff('{"message_type":"noise"}\n{"path":"/a","modifier":"+"}');
    assert.deepEqual(d.added.map((c) => c.path), ['/a']);
    assert.equal(d.other.length, 0);
});

test('parseDiff: JSON-lines statistics without snapshots leave source and target null', () => {
    const d = R.parseDiff('{"path":"/a","modifier":"+"}\n{"message_type":"statistics","changed_files":1}');
    assert.equal(d.source, null);
    assert.equal(d.target, null);
    assert.equal(d.stats.changed_files, 1);
});

test('parseDiff: unicode and NUL-bearing paths survive bucketing', () => {
    const p = '/srv/データ' + NUL + 'x';
    const d = R.parseDiff(JSON.stringify({ changes: [{ path: p, modifier: '+' }] }));
    assert.equal(d.added[0].path, p);
});

test('parseDiff: a five thousand change diff is bucketed completely', () => {
    const changes = [];
    for (let i = 0; i < 5000; i++)
        changes.push({ path: '/f/' + i, modifier: ['+', '-', 'M'][i % 3] });
    const d = R.parseDiff(JSON.stringify({ changes: changes }));
    assert.equal(d.added.length + d.removed.length + d.changed.length, 5000);
    assert.equal(d.other.length, 0);
});

// --------------------------------------------------------------- run: hostile paths

// A channel that never streams — the shape an older cockpit hands back.
function noStreamProc(data, failure) {
    return { then(ok, bad) { return Promise.resolve().then(() => (failure ? bad(failure) : ok(data))); } };
}

// Always rejects, including with a falsy reason.
function rejectingProc(reason, chunks) {
    let onChunk = null;
    const proc = {
        stream(cb) { onChunk = cb; return proc; },
        then(ok, bad) {
            return Promise.resolve().then(() => {
                (chunks || []).forEach((c) => { if (onChunk) onChunk(c); });
                return bad(reason);
            });
        }
    };
    return proc;
}

test('run: never throws synchronously, whatever it is given', async () => {
    const bad = [null, undefined, '', 'mount', 42, {}, [], NULL_PROTO, THROWING, Symbol('s')];
    const results = [];
    bad.forEach((op) => {
        [undefined, null, {}, 'x', 42, REPO].forEach((opts) => {
            const r = attempt(() => R.run(op, opts));
            assert.equal(r.threw, false, 'threw synchronously for ' + String(typeof op));
            assert.ok(r.value && typeof r.value.then === 'function');
            results.push(r.value.then(() => null, (e) => e));
        });
    });
    (await Promise.all(results)).forEach((e) => {
        assert.ok(Errors.isHangarError(e), 'rejected with an untyped ' + (e && e.name));
    });
});

test('run: rejects typed when opening the channel throws', async () => {
    // cockpit.spawn can throw outright (no superuser bridge, protocol error) and
    // callers only ever .catch() this function.
    const spawn = () => { throw new Error('protocol error: cannot open channel'); };
    await withCockpit(spawn, async () => {
        await assert.rejects(R.run('version', {}), typed(Errors.KIND.GENERIC));
    });
});

test('run: rejects typed when spawn returns something that is not thenable', async () => {
    for (const value of [undefined, null, {}, 'proc', 42]) {
        await withCockpit(() => value, async () => {
            await assert.rejects(R.run('version', {}), typed(Errors.KIND.GENERIC));
        });
    }
});

test('run: rejects typed when cockpit exists but cannot spawn', async () => {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'cockpit');
    globalThis.cockpit = {};
    try {
        await assert.rejects(R.run('version', {}), /cockpit is not available/);
    } finally {
        if (!had) delete globalThis.cockpit;
    }
});

test('run: works when the channel has no stream(), taking output from the result', async () => {
    const spawn = () => noStreamProc('{"message_type":"summary","snapshot_id":"nostream"}\n');
    await withCockpit(spawn, async () => {
        const out = await R.run('backup', { repoUrl: '/r', paths: ['/srv'] });
        assert.equal(out.status, 'ok');
        assert.equal(out.summary.snapshot_id, 'nostream');
    });
});

test('run: flushes a final line that never got its newline', async () => {
    const spawn = () => fakeProc(['{"message_type":"summary","snapshot_id":"tail"}']);
    await withCockpit(spawn, async () => {
        const out = await R.run('backup', { repoUrl: '/r', paths: ['/srv'] });
        assert.equal(out.summary.snapshot_id, 'tail');
    });
});

test('run: reassembles a message split mid-token across chunks', async () => {
    const spawn = () => fakeProc(['{"message_type":"sta', 'tus","percent_done":0.5}\n{"message_ty',
        'pe":"summary","snapshot_id":"z"}\n']);
    await withCockpit(spawn, async () => {
        const seen = [];
        const out = await R.run('backup', { repoUrl: '/r', paths: ['/srv'] }, (m) => seen.push(m));
        assert.equal(seen.length, 1);
        assert.equal(seen[0].percent_done, 0.5);
        assert.equal(out.summary.snapshot_id, 'z');
    });
});

test('run: noise between messages does not break the fold', async () => {
    const spawn = () => fakeProc(['garbage\n{"message_type":"summary","snapshot_id":"a"}\nmore garbage\n']);
    await withCockpit(spawn, async () => {
        assert.equal((await R.run('backup', { repoUrl: '/r', paths: ['/srv'] })).status, 'ok');
    });
});

test('run: onProgress sees status messages only', async () => {
    const spawn = () => fakeProc([
        '{"message_type":"status","percent_done":0.1}\n' +
        '{"message_type":"verbose_status","action":"new"}\n' +
        '{"message_type":"error","item":"/a"}\n' +
        '{"message_type":"summary","snapshot_id":"a"}\n'
    ]);
    await withCockpit(spawn, async () => {
        const seen = [];
        await R.run('backup', { repoUrl: '/r', paths: ['/srv'] }, (m) => seen.push(m));
        assert.deepEqual(seen.map((m) => m.message_type), ['status']);
    });
});

test('run: a non-function progress callback is ignored', async () => {
    const spawn = () => fakeProc(['{"message_type":"status","percent_done":0.1}\n{"message_type":"summary"}\n']);
    for (const cb of [null, undefined, 'x', 42, {}, []]) {
        await withCockpit(spawn, async () => {
            assert.equal((await R.run('backup', { repoUrl: '/r', paths: ['/srv'] }, cb)).status, 'ok');
        });
    }
});

test('run: falls back to ex.problem when the failure carries no message', async () => {
    const spawn = () => rejectingProc({ exit_status: 11, problem: 'repository is already locked' });
    await withCockpit(spawn, async () => {
        await assert.rejects(R.run('unlock', { repoUrl: '/r' }), (e) => {
            assert.equal(e.kind, Errors.KIND.REPO_LOCKED);
            assert.equal(e.detail.stderr, 'repository is already locked');
            return true;
        });
    });
});

test('run: an empty or absent failure object still rejects with a typed error', async () => {
    for (const reason of [{}, undefined, null, '', 0]) {
        await withCockpit(() => rejectingProc(reason), async () => {
            await assert.rejects(R.run('version', {}), (e) => {
                assert.ok(Errors.isHangarError(e));
                assert.equal(e.kind, Errors.KIND.UNKNOWN);
                return true;
            });
        });
    }
});

test('run: exit 3 with no output at all still resolves as partial', async () => {
    await withCockpit(() => rejectingProc({ exit_status: 3, message: '' }), async () => {
        const out = await R.run('backup', { repoUrl: '/r', paths: ['/srv'] });
        assert.equal(out.status, 'partial');
        assert.equal(out.summary, null);
        assert.equal(out.error.kind, Errors.KIND.READ_ERRORS);
    });
});

test('run: a cancelled run keeps whatever arrived before the signal', async () => {
    const spawn = () => rejectingProc({ exit_status: 130, message: '' },
        ['{"message_type":"status","percent_done":0.4}\n{"message_type":"error","item":"/a"}\n']);
    await withCockpit(spawn, async () => {
        const out = await R.run('backup', { repoUrl: '/r', paths: ['/srv'] });
        assert.equal(out.status, 'cancelled');
        assert.equal(out.progress.percent_done, 0.4);
        assert.equal(out.errors.length, 1);
    });
});

test('run: an unusable binary falls back to restic', async () => {
    let argv = null;
    const spawn = (a) => { argv = a; return fakeProc([]); };
    for (const binary of ['', null, undefined, 0, false, NULL_PROTO]) {
        await withCockpit(spawn, async () => {
            await R.run('version', { binary: binary });
            assert.equal(argv[0], 'restic');
        });
    }
});

test('run: every argv element handed to cockpit is a non-empty string', async () => {
    let argv = null;
    const spawn = (a) => { argv = a; return fakeProc([]); };
    await withCockpit(spawn, async () => {
        await R.run('backup', {
            repoUrl: '/srv/repo', paths: ['/srv', NULL_PROTO], tags: [null, 'nightly'],
            host: THROWING, excludes: ['']
        });
        argv.forEach((a) => {
            assert.equal(typeof a, 'string');
            assert.ok(a.length > 0);
        });
        assert.deepEqual(argv, ['restic', '-r', '/srv/repo', '--cache-dir', R.CACHE_DIR,
            '--json', 'backup', '--tag', 'nightly', '--', '/srv']);
    });
});

test('run: options may be omitted entirely for an op that needs none', async () => {
    let argv = null;
    const spawn = (a) => { argv = a; return fakeProc([]); };
    await withCockpit(spawn, async () => {
        const out = await R.run('version');
        assert.deepEqual(argv, ['restic', 'version']);
        assert.equal(out.status, 'unknown');     // version prints no JSON
    });
});

test('run: the rejection carries the raw stderr for verbatim display', async () => {
    const stderr = 'Fatal: unable to open config file\n{"message_type":"exit_error","code":10,"message":"no repo"}';
    await withCockpit(() => rejectingProc({ exit_status: 10, message: stderr }), async () => {
        await assert.rejects(R.run('snapshots', { repoUrl: '/r' }), (e) => {
            assert.equal(e.kind, Errors.KIND.REPO_MISSING);
            assert.equal(e.detail.stderr, stderr);
            assert.equal(e.remediation, 'init');
            return true;
        });
    });
});

// ============================== classifyExit: an expired cloud destination
//
// restic SPAWNS rclone as a subprocess for an `rclone:` repository, so rclone's
// authorisation error arrives inside RESTIC's stderr — never as an exit code of
// its own, because restic collapses every backend failure into 1. This is the
// detection point that matters: a check that only looked at direct rclone
// invocations would miss every scheduled backup, which is to say every failure
// nobody is watching when it happens.
//
// The strings are the ones rclone and the providers really produce, spelled out
// by hand rather than captured; the ones marked as counter-examples are what an
// ordinary permission or quota failure looks like, and must stay GENERIC.

// A whole run's stderr as it arrives from cockpit: restic's own prose, the
// rclone subprocess's line inside it, and restic's JSON exit_error at the end.
const EXPIRED_STDERR = [
    '2026/07/31 03:00:12 ERROR : backups/db: Failed to copy: failed to open source object: ' +
        'couldn\'t fetch token - maybe it has expired? - refresh with "rclone config reconnect gdrive:"',
    'Fatal: unable to save snapshot: Save(<data/0a1b2c>) returned error',
    '{"message_type":"exit_error","code":1,"message":"backup failed"}'
].join('\n');

test('classifyExit: exit 1 whose stderr carries rclone\'s expiry becomes AUTH_EXPIRED', () => {
    // The single most important assertion in this file: this is how a 03:00
    // scheduled failure becomes a button the user can press in the morning.
    const e = R.classifyExit(1, EXPIRED_STDERR);
    assert.equal(e.kind, Errors.KIND.AUTH_EXPIRED);
    assert.equal(e.remediation, 'reauthorize');
    assert.equal(e.fatal, true, 'the backup did not happen — this is fatal');
});

test('classifyExit: every provider\'s expiry wording reaches the same kind', () => {
    [
        'oauth2: token expired and refresh token is not set',
        '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}',
        'Error "invalid_grant" (): AADSTS700082: The refresh token has expired due to inactivity.',
        '{"error_summary":"expired_access_token/..."}',
        'Failed to list: couldn\'t fetch token - maybe it has expired?',
        'refresh with "rclone config reconnect box:"'
    ].forEach((s) => assert.equal(R.classifyExit(1, s).kind, Errors.KIND.AUTH_EXPIRED, 'missed: ' + s));
});

test('classifyExit: AUTH_EXPIRED says it plainly and keeps restic\'s text in detail', () => {
    // "invalid_grant" is not a sentence anyone can act on, and it is what restic
    // would otherwise put in front of the user as the failure's message.
    const stderr = '{"message_type":"exit_error","code":1,"message":"invalid_grant"}';
    const e = R.classifyExit(1, stderr);
    assert.equal(e.kind, Errors.KIND.AUTH_EXPIRED);
    assert.match(e.message, /authorised again/);
    assert.equal(e.message.includes('invalid_grant'), false);
    // Nothing is lost: the raw text is still there for the log and the detail view.
    assert.equal(e.detail.stderr, stderr);
    assert.equal(e.detail.exitError.message, 'invalid_grant');
    assert.equal(e.detail.code, 1);
});

test('classifyExit: a missing exit status still classifies from the message', () => {
    // A channel that dies without an exit status is exactly when the text is all
    // there is — and UNKNOWN offers no remediation at all, so this is a strict
    // improvement over the status quo rather than a reclassification.
    const e = R.classifyExit(null, 'oauth2: cannot fetch token: token expired');
    assert.equal(e.kind, Errors.KIND.AUTH_EXPIRED);
    assert.equal(e.detail.code, null);
    assert.equal(R.classifyExit(undefined, 'invalid_grant').kind, Errors.KIND.AUTH_EXPIRED);
    assert.equal(R.classifyExit('not-a-number', 'invalid_grant').kind, Errors.KIND.AUTH_EXPIRED);
});

test('classifyExit: expiry beats the network guess for the same exit 1', () => {
    // Both signals in one stderr, which is the common case — the HTTP call that
    // failed is reported next to the reason it failed. NETWORK's remediation is
    // 'retry', and retrying an expired token fails identically every night.
    const stderr = 'Get "https://www.googleapis.com/drive/v3/files": ' +
        'oauth2: cannot fetch token: 400 Bad Request\nResponse: {"error":"invalid_grant"}';
    const e = R.classifyExit(1, stderr);
    assert.equal(e.kind, Errors.KIND.AUTH_EXPIRED);
    assert.equal(e.remediation, 'reauthorize');
});

test('classifyExit: every existing exit-code mapping is untouched', () => {
    // The table is restic's own contract and this change must not have moved any
    // of it. Checked against a stderr that WOULD classify as expiry on its own.
    const expiry = 'invalid_grant: Token has been expired or revoked.';
    assert.equal(R.classifyExit(0, expiry).kind, Errors.KIND.OK);
    assert.equal(R.classifyExit(2, expiry).kind, Errors.KIND.GO_RUNTIME);
    assert.equal(R.classifyExit(3, expiry).kind, Errors.KIND.READ_ERRORS);
    assert.equal(R.classifyExit(10, expiry).kind, Errors.KIND.REPO_MISSING);
    assert.equal(R.classifyExit(11, expiry).kind, Errors.KIND.REPO_LOCKED);
    assert.equal(R.classifyExit(12, expiry).kind, Errors.KIND.WRONG_PASSWORD);
    assert.equal(R.classifyExit(130, expiry).kind, Errors.KIND.CANCELLED);
    // The EXIT_KINDS table itself is unchanged.
    assert.deepEqual(R.EXIT_KINDS, {
        0: Errors.KIND.OK, 1: Errors.KIND.GENERIC, 2: Errors.KIND.GO_RUNTIME,
        3: Errors.KIND.READ_ERRORS, 10: Errors.KIND.REPO_MISSING,
        11: Errors.KIND.REPO_LOCKED, 12: Errors.KIND.WRONG_PASSWORD,
        130: Errors.KIND.CANCELLED
    });
});

test('classifyExit: exit 3 stays a written snapshot, whatever the text says', () => {
    // The one that would cost the most trust. Exit 3 WROTE the snapshot; turning
    // it into a fatal failure because rclone grumbled about a token would report
    // a backup that happened as a backup that did not.
    const e = R.classifyExit(3, EXPIRED_STDERR);
    assert.equal(e.kind, Errors.KIND.READ_ERRORS);
    assert.equal(e.fatal, false);
    assert.equal(e.remediation, 'list-unreadable');
});

test('classifyExit: a cancelled run is never reported as an expired sign-in', () => {
    const e = R.classifyExit(130, EXPIRED_STDERR);
    assert.equal(e.kind, Errors.KIND.CANCELLED);
    assert.equal(e.fatal, false);
});

test('classifyExit: ordinary permission and quota failures stay GENERIC', () => {
    // The false-positive direction. Each of these is a real failure with a real
    // cause, and re-authorising fixes none of them — but it does hide them.
    [
        '403 Forbidden: The user does not have permission to access this folder',
        '403: User Rate Limit Exceeded, userRateLimitExceeded',
        '401 Unauthorized',
        'AccessDenied: Access Denied, status code: 403',
        'error listing: permission denied'
    ].forEach((s) => assert.equal(R.classifyExit(1, s).kind, Errors.KIND.GENERIC, 'misread: ' + s));
});

test('classifyExit: no space and network still win their own exit-1 texts', () => {
    assert.equal(R.classifyExit(1, 'write /srv/repo/data/ab: no space left on device').kind,
        Errors.KIND.NO_SPACE);
    assert.equal(R.classifyExit(1, 'dial tcp 10.0.0.9:8000: i/o timeout').kind, Errors.KIND.NETWORK);
    assert.equal(R.classifyExit(1, 'ssh: connect to host nas.lan port 22: No route to host').kind,
        Errors.KIND.NETWORK);
});

test('classifyExit: AUTH_EXPIRED has a message even with an empty stderr shape', () => {
    // MESSAGES must cover the new kind, or the error would carry `undefined`
    // where the UI reads its headline.
    assert.ok(R.MESSAGES[Errors.KIND.AUTH_EXPIRED]);
    assert.ok(R.MESSAGES[Errors.KIND.AUTH_EXPIRED].length > 0);
    assert.ok(R.classifyExit(1, 'invalid_grant').message.length > 0);
});

test('classifyExit: hostile stderr shapes cannot throw on the expiry path', () => {
    [null, undefined, 0, false, [], {}, NULL_PROTO, THROWING].forEach((v) => {
        let e;
        assert.doesNotThrow(() => { e = R.classifyExit(1, v); }, 'threw on ' + typeof v);
        assert.ok(Errors.isHangarError(e));
    });
});

test('run: an expired destination rejects with a reauthorize button, not a retry', async () => {
    // End to end through the impure layer, because this is the shape cockpit
    // hands back: the stderr arrives as the rejection's `message`.
    await withCockpit(() => rejectingProc({ exit_status: 1, message: EXPIRED_STDERR }), async () => {
        await assert.rejects(R.run('backup', { repoUrl: 'rclone:gdrive:backups', paths: ['/etc'] }), (e) => {
            assert.equal(e.kind, Errors.KIND.AUTH_EXPIRED);
            assert.equal(e.remediation, 'reauthorize');
            assert.equal(e.detail.stderr, EXPIRED_STDERR);
            return true;
        });
    });
});

test('the expiry signal is the rclone module\'s, not a second copy of it', () => {
    // Two regex tables that must agree is a bug waiting for the day they do not.
    // restic.js asks core/rclone.js, and the false-positive matrix lives there.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'engine', 'restic.js'), 'utf8');
    assert.ok(src.includes("require('../core/rclone.js')"));
    assert.ok(src.includes('isAuthExpired'));
    // Comments stripped first: the one above rcloneAuthExpired quotes the strings
    // to explain the split, and would otherwise flag itself.
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.equal(/invalid_grant|fetch token/.test(code), false,
        'restic.js grew its own copy of the strings');
});

// --- restic's cache directory --------------------------------------------
//
// Found in a real session: the Logbook's mount unit and every scheduled backup
// exited 1 with "unable to locate cache directory: neither $XDG_CACHE_HOME nor
// $HOME are defined". A systemd unit has no HOME; the browser's privileged
// channel happens to have one, which is why it only failed where it mattered.

test('every operation passes an explicit cache directory', () => {
    // Enough of every option that no operation refuses to build.
    const opts = { repoUrl: '/srv/r', passwordFile: '/k', paths: ['/home'],
        snapshot: 'abc', snapshotA: 'aaa', snapshotB: 'bbb',
        target: '/tmp/out', keepDaily: 7 };
    for (const op of R.OPS) {
        if (op === 'version') continue;       // a presence probe; see the next test
        const args = R.buildArgs(op, opts);
        const i = args.indexOf('--cache-dir');
        assert.ok(i >= 0, `restic ${op} has no --cache-dir`);
        assert.equal(args[i + 1], R.CACHE_DIR, `restic ${op} points somewhere else`);
    }
});

test('the cache directory is root-owned and outside any home', () => {
    // Every process that runs restic here is root: the timer units, the mount
    // unit, and the browser's privileged channel. A path under a user's home
    // would be wrong for all three.
    assert.match(R.CACHE_DIR, /^\/var\//);
    assert.ok(!/\/home\//.test(R.CACHE_DIR));
    assert.ok(!/\/root\//.test(R.CACHE_DIR));
});

test('the cache flag comes before the operation, where a global flag belongs', () => {
    const args = R.buildArgs('backup', { repoUrl: '/srv/r', passwordFile: '/k', paths: ['/home'] });
    assert.ok(args.indexOf('--cache-dir') < args.indexOf('backup'));
});
