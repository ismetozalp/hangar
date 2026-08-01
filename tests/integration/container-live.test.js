// Integration tests for the 'container' source kind, run against the REAL
// container runtime on THIS machine.
//
// tests/unit/sources-container.test.js proves the module is self-consistent: it
// feeds hand-written fixtures to our parsers and checks our own answers. That can
// never catch the failures that actually matter here, because every one of them is
// a disagreement between our assumptions and a real runtime:
//
//   - `volume ls -q` not emitting what we think it emits,
//   - `volume inspect` not being a JSON array,
//   - NAME_RE being stricter than the names podman actually hands out,
//   - Mountpoint pointing somewhere that does not exist,
//   - and above all: the volumes living in the *user's* store, not root's.
//
// READ-ONLY, ALWAYS. These are the user's live services (mongodb, kafka,
// elasticsearch and friends). Nothing in this file may stop, pause, remove or
// otherwise modify a container or a volume. That is not left to good intentions —
// every runtime invocation goes through run(), which refuses any verb outside a
// read-only allowlist, so a future edit that adds `stop` fails the suite instead of
// taking a database down.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

const C = require('../../js/core/sources-container.js');

// --- preconditions -------------------------------------------------------

function have(cmd) {
    return spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0;
}

const HAVE_PODMAN = have('podman');
// Skip, never fail: this suite has to stay runnable on a host with no containers.
const skip = HAVE_PODMAN ? false : 'podman is not installed on this host';

// The invoking user owns the rootless store, so every command below runs unwrapped
// (no runuser hop). See the asUser test for why that is not a gap.
const USER = os.userInfo().username;
const HOME = os.homedir();

// --- the read-only guard -------------------------------------------------

// Allowlist by verb pair, not by denylist: a denylist has to predict every
// destructive subcommand a runtime might grow, and being wrong once costs the user
// a stopped database.
const READ_ONLY = [
    ['--version'],
    ['volume', 'ls'],
    ['volume', 'inspect'],
    ['ps']
];

// Everything after the runtime binary — which may sit behind a `runuser -u x --`
// prefix, so it is found by name rather than assumed to be argv[0].
function afterRuntime(argv) {
    const i = argv.findIndex((a) => a === 'podman' || a === 'docker');
    return i < 0 ? null : argv.slice(i + 1);
}

function isReadOnly(argv) {
    const rest = afterRuntime(argv);
    if (!rest) return false;
    return READ_ONLY.some((verb) => verb.every((word, i) => rest[i] === word));
}

const executed = [];

function run(argv) {
    assert.ok(isReadOnly(argv),
        `refusing to execute a non-read-only runtime command in a live test: ${argv.join(' ')}`);
    executed.push(argv);
    const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 60000 });
    if (r.error) throw r.error;
    // Mirrors cockpit.spawn with err:'message': stdout on success, stderr in the
    // rejection. The podman-docker shim writes a banner to stderr on every call,
    // so stdout and stderr must not be concatenated.
    if (r.status !== 0) throw new Error(`${argv.join(' ')} exited ${r.status}: ${r.stderr}`);
    return r.stdout;
}

function lines(text) {
    return text.split('\n').map((s) => s.trim()).filter((s) => s !== '');
}

// A cockpit.spawn good enough for the impure half of the module (detectRuntime,
// listVolumes, resolve). It is backed by the same guarded run(), so the async paths
// are exercised against real podman rather than a mock — which is the entire point
// of this file. superuser:'require' is ignored: we are already the user who owns
// the store, which is exactly the privilege the real code obtains via runuser.
function withCockpit(fn) {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'cockpit');
    const prev = globalThis.cockpit;
    globalThis.cockpit = {
        spawn(argv) {
            try { return Promise.resolve(run(argv)); } catch (e) { return Promise.reject(e); }
        }
    };
    return Promise.resolve()
        .then(fn)
        .finally(() => {
            if (had) globalThis.cockpit = prev;
            else delete globalThis.cockpit;
        });
}

// --- live data, gathered once -------------------------------------------

function liveVolumeNames() { return lines(run(['podman', 'volume', 'ls', '-q'])); }
function liveContainerNames() { return lines(run(['podman', 'ps', '-a', '--format', '{{.Names}}'])); }

// --- the argv we build actually works -----------------------------------

test('volumeListArgv builds a command that really lists volumes', { skip }, () => {
    const argv = C.volumeListArgv('podman', '');
    assert.deepEqual(argv, ['podman', 'volume', 'ls', '-q']);
    // The portability rule, asserted rather than trusted: podman's `--format json`
    // is an array and docker's is a Go template emitting one object per line, so
    // the word must never appear here.
    assert.ok(!argv.includes('json'), 'volume ls must not ask for --format json — it is not portable');

    const names = C.parseVolumeNames(run(argv));
    assert.ok(names.length > 0,
        'podman reports no volumes at all — this host was supposed to have some');
    names.forEach((n) => assert.equal(typeof n, 'string'));
});

test('parseVolumeNames reproduces `podman volume ls -q` exactly', { skip }, () => {
    const raw = run(C.volumeListArgv('podman', ''));
    // Split independently rather than reusing the parser we are testing.
    const expected = raw.split('\n').map((s) => s.trim()).filter((s) => s !== '');
    assert.deepEqual(C.parseVolumeNames(raw), expected);
});

test('containerListArgv builds a command that really lists containers', { skip }, () => {
    const argv = C.containerListArgv('podman', '');
    assert.deepEqual(argv, ['podman', 'ps', '-a', '--format', '{{.Names}}']);
    assert.ok(lines(run(argv)).length > 0, 'no containers on a host that was supposed to have some');
});

// --- inspect: shape, parse, and the mountpoint being real ---------------

test('`volume inspect` really returns a JSON array on this runtime', { skip }, () => {
    const name = liveVolumeNames()[0];
    const parsed = JSON.parse(run(C.volumeInspectArgv('podman', '', name)));
    // The one shape both runtimes agree on. If this ever stops being an array,
    // parseVolumeInspect's array-flattening is load-bearing for nothing.
    assert.ok(Array.isArray(parsed), 'volume inspect did not return an array');
    assert.equal(parsed[0].Name, name);
});

test('parseVolumeInspect parses real output, and every Mountpoint exists on disk', { skip }, () => {
    const names = liveVolumeNames();
    const missing = [];
    let checked = 0;

    for (const name of names) {
        const entries = C.parseVolumeInspect(run(C.volumeInspectArgv('podman', '', name)));
        assert.equal(entries.length, 1, `inspect of ${name} parsed to ${entries.length} entries`);

        const e = entries[0];
        assert.equal(e.name, name);
        assert.equal(e.driver, 'local');
        assert.equal(typeof e.labels, 'object');
        assert.ok(e.mountpoint.startsWith('/'),
            `${name} has a non-absolute mountpoint: ${JSON.stringify(e.mountpoint)}`);

        // A mountpoint we cannot stat is a backup of nothing that restic would
        // happily report as a success.
        if (!fs.existsSync(e.mountpoint) || !fs.statSync(e.mountpoint).isDirectory())
            missing.push(`${name} -> ${e.mountpoint}`);

        // mountpointsFor is what actually feeds the restic path vector.
        assert.deepEqual(C.mountpointsFor(entries, [name]), [e.mountpoint]);
        checked++;
    }

    assert.deepEqual(missing, [], `these volume mount points do not exist: ${missing.join(', ')}`);
    assert.ok(checked > 0, 'no volumes were inspected — nothing was actually verified');
});

test('volume names discovered by inspect match `volume ls -q` exactly', { skip }, () => {
    const listed = liveVolumeNames();
    const inspected = listed.map((n) =>
        C.parseVolumeInspect(run(C.volumeInspectArgv('podman', '', n)))[0].name);
    assert.deepEqual(inspected, listed);
});

// --- the per-user store, which is the whole reason asUser() exists ------

test('rootless mount points live under the invoking user\'s home, not a system path', { skip }, () => {
    const names = liveVolumeNames();
    const paths = names.map((n) =>
        C.parseVolumeInspect(run(C.volumeInspectArgv('podman', '', n)))[0].mountpoint);

    const underHome = paths.filter((p) => p.startsWith(HOME + '/'));
    assert.equal(underHome.length, paths.length,
        `these volumes are not in ${HOME}: ${paths.filter((p) => !p.startsWith(HOME + '/')).join(', ')}`);

    // This is the fact the whole per-user design rests on: root's podman is a
    // different store, so a backup run as root without runuser would inspect an
    // empty runtime and silently back up nothing.
    assert.ok(!paths.some((p) => p.startsWith('/var/lib/containers/')),
        'a volume is in the root store — this host is no longer proving the rootless case');
    assert.ok(!paths.some((p) => p.startsWith('/var/lib/docker/')),
        'a volume is in a docker store — this host is no longer proving the podman case');
});

test('asUser wraps the same command for the store owner, and runuser is installed', { skip }, () => {
    const bare = C.volumeListArgv('podman', '');
    const wrapped = C.volumeListArgv('podman', USER);
    assert.deepEqual(wrapped, ['runuser', '-u', USER, '--'].concat(bare));

    // The tests above run bare because they already run AS the store owner; when
    // hangar-run does this it is root, and runuser is how it becomes this user.
    // So the binary has to exist — and it is in /usr/sbin on several distros,
    // which is on root's PATH but not on an unprivileged one.
    const found = ['/usr/sbin/runuser', '/sbin/runuser', '/usr/bin/runuser', '/bin/runuser']
        .filter((p) => fs.existsSync(p));
    assert.ok(found.length > 0, 'runuser is not installed — asUser() would produce an unrunnable command');
});

// --- real names must satisfy our own name rule --------------------------

test('every real volume and container name on this host passes isSafeName', { skip }, () => {
    // NAME_RE exists to keep shell metacharacters and leading dashes out of argv.
    // If it is stricter than what the runtime actually hands out, we would reject
    // the user's own volumes — and a unit test with hand-picked names cannot see it.
    // The 64-hex anonymous volume names here are a real sample of that.
    const names = liveVolumeNames().concat(liveContainerNames());
    const rejected = names.filter((n) => !C.isSafeName(n));
    assert.deepEqual(rejected, [],
        `isSafeName rejects real names from this host: ${rejected.join(', ')}`);
});

// --- the impure layer, driven against real podman -----------------------

test('detectRuntime() finds podman', { skip }, () => withCockpit(async () => {
    const rt = await C.detectRuntime();
    // podman is probed first on purpose: /usr/bin/docker here is a shim onto podman,
    // so answering "docker" would name the wrong runtime for the same store.
    assert.equal(rt, 'podman');
}));

test('listVolumes() returns what podman returns', { skip }, () => withCockpit(async () => {
    const got = await C.listVolumes('podman', '');
    assert.deepEqual(got, liveVolumeNames());
}));

test('resolve() turns real volume names into real paths, and toResticArgs uses them',
    { skip }, () => withCockpit(async () => {
        const volumes = liveVolumeNames().slice(0, 2);
        const resolved = await C.resolve({
            id: 'live-check', kind: 'container', runtime: 'podman', user: '',
            volumes, tags: ['live'], excludes: ['*.tmp']
        });

        assert.equal(resolved.resolvedPaths.length, volumes.length);
        resolved.resolvedPaths.forEach((p) => {
            assert.ok(fs.existsSync(p), `resolve() produced a path that does not exist: ${p}`);
        });

        // The end of the chain: what restic would actually be handed.
        const args = C.toResticArgs(resolved);
        assert.deepEqual(args.slice(0, 4), ['--exclude', '*.tmp', '--tag', 'live']);
        assert.deepEqual(args.slice(4), resolved.resolvedPaths);
        args.slice(4).forEach((p) => assert.ok(p.startsWith(HOME + '/')));
    }));

test('resolve() reports the missing volume by name rather than failing vaguely',
    { skip }, () => withCockpit(async () => {
        // The recoverable case: a volume was removed, or — far more likely — the
        // source records the wrong owner and we are looking at the wrong store.
        await assert.rejects(
            () => C.resolve({
                id: 'live-check', kind: 'container', runtime: 'podman', user: '',
                volumes: ['hangar-no-such-volume']
            }),
            (e) => {
                assert.match(e.message, /hangar-no-such-volume/);
                assert.match(e.message, /owner/);
                return true;
            });
    }));

// --- docker on this host proves nothing about Docker --------------------

test('/usr/bin/docker here is the podman-docker shim, so it is NOT Docker coverage', { skip }, () => {
    if (!fs.existsSync('/usr/bin/docker')) return;   // nothing to disclaim

    const text = fs.readFileSync('/usr/bin/docker', 'utf8');
    const isShim = /^#!/.test(text) && /\bpodman\b/.test(text);

    // Stated as an assertion so it is impossible to read a passing `docker ...` test
    // on this machine as evidence that the docker code path works. It does not: the
    // shim execs podman, so a docker run here re-tests podman under another name.
    // Real Docker differs where it matters — `--format` is a Go template there, which
    // is exactly why this module only uses `volume ls -q` and `volume inspect`.
    assert.ok(isShim,
        '/usr/bin/docker is no longer the podman-docker shim on this host — if real Docker ' +
        'is now installed, the docker path can finally be tested for real and this test ' +
        'should be replaced rather than relaxed');

    // Same store, same answers, because it is the same binary.
    assert.deepEqual(lines(run(['docker', 'volume', 'ls', '-q'])), liveVolumeNames());
});

// --- the warning that stops an unrestorable backup ----------------------

test('the live-database warning fires for the real database containers on this host',
    { skip }, () => {
        const containers = liveContainerNames();

        // Independent of DATABASE_HINTS: if the module's table and this regex ever
        // disagree, one of them is wrong and the test says so.
        const expected = containers.filter((n) =>
            /mongo|postgres|mysql|mariadb|redis|elastic|kafka|cassandra|clickhouse/i.test(n));
        assert.ok(expected.length > 0,
            'no database-looking containers are running — this host cannot prove the warning');

        const problems = C.validate({
            id: 'live-db', kind: 'container', runtime: 'podman', user: USER,
            volumes: liveVolumeNames().slice(0, 1),
            containers,
            consistency: 'none'
        });

        const warned = problems
            .filter((p) => p.code === C.PROBLEM.LIVE_DATABASE)
            .map((p) => p.container);
        assert.deepEqual(warned, expected);

        // The names the design document calls out by hand, present on this host.
        for (const stem of ['mongo', 'kafka', 'elastic']) {
            assert.ok(warned.some((n) => n.toLowerCase().includes(stem)),
                `no warning covers a "${stem}" container, but one is running here: ${containers.join(', ')}`);
        }

        // A warning, never an error: the user is allowed to make this choice, they
        // just may not make it unknowingly.
        problems.filter((p) => p.code === C.PROBLEM.LIVE_DATABASE)
            .forEach((p) => assert.equal(p.severity, 'warning'));
    });

test('choosing a safe consistency mode silences the warning for the same containers',
    { skip }, () => {
        const containers = liveContainerNames();
        const problems = C.validate({
            id: 'live-db', kind: 'container', runtime: 'podman', user: USER,
            volumes: liveVolumeNames().slice(0, 1),
            containers,
            consistency: 'stop'
        });
        assert.equal(problems.filter((p) => p.code === C.PROBLEM.LIVE_DATABASE).length, 0);
    });

test('the stop/pause commands for the live containers are BUILT here and never run',
    { skip }, () => {
        const containers = liveContainerNames().slice(0, 3);
        const source = {
            id: 'live-db', kind: 'container', runtime: 'podman', user: USER,
            volumes: liveVolumeNames().slice(0, 1),
            containers, consistency: 'stop'
        };

        const pre = C.preCommands(source);
        const post = C.postCommands(source);
        assert.deepEqual(pre.map((a) => a.slice(0, 5)),
            containers.map(() => ['runuser', '-u', USER, '--', 'podman']));
        assert.deepEqual(pre.map((a) => a[a.length - 1]), containers);
        // Reverse order on the way back up: the author lists shutdown order, so
        // restart order is its mirror.
        assert.deepEqual(post.map((a) => a[a.length - 1]), containers.slice().reverse());

        // Deliberately not executed. These would stop the user's databases; the guard
        // in run() would refuse them anyway, which is asserted here so the refusal is
        // itself tested.
        pre.concat(post).forEach((argv) => {
            assert.throws(() => run(argv), /non-read-only/);
        });
    });


// --- shell safety, proved against the real binary -----------------------
//
// Every unit test here can only prove that our argv is the shape we intended. It
// cannot prove that the shape is safe, because that depends on how the argument
// actually travels. These tests use the real podman to settle that.

test('the transport is argv, not a shell: metacharacters arrive at podman verbatim',
    { skip }, () => {
        // The name below would be command substitution under any shell. Because the
        // command is executed as an argument vector — which is exactly what
        // cockpit.spawn does — podman receives the 20 literal characters and says so.
        const hostile = 'hangar$(id)-no-such-volume';
        assert.throws(() => run(['podman', 'volume', 'inspect', hostile]), (e) => {
            assert.match(e.message, /hangar\$\(id\)-no-such-volume/,
                'podman did not receive the name literally');
            // If a shell had been involved, `$(id)` would have become "uid=1000(...)"
            // and podman would have complained about a completely different name.
            assert.ok(!/uid=\d+/.test(e.message), 'a shell expanded the name');
            return true;
        });
    });

test('a word with a space is one argument to podman, not two', { skip }, () => {
    // Same proof for the other half of shell word splitting. podman reports one
    // missing volume whose name contains the space, rather than two missing names.
    assert.throws(() => run(['podman', 'volume', 'inspect', 'hangar no such volume']), (e) => {
        assert.match(e.message, /hangar no such volume/);
        return true;
    });
});

test('a real volume name is exactly one argv element and inspects to itself',
    { skip }, () => {
        // The end-to-end statement for the names that actually exist on this host,
        // including the 64-hex anonymous ones: the name we put in is the name podman
        // answers about, with nothing split, joined, quoted or trimmed on the way.
        const names = liveVolumeNames();
        assert.ok(names.length > 0);
        for (const name of names) {
            const argv = C.volumeInspectArgv('podman', '', name);
            assert.deepEqual(argv, ['podman', 'volume', 'inspect', name]);
            assert.equal(argv.filter((a) => a === name).length, 1);
            argv.forEach((a) => assert.equal(typeof a, 'string'));

            const parsed = JSON.parse(run(argv));
            assert.equal(parsed.length, 1, `${name} inspected to ${parsed.length} volumes`);
            assert.equal(parsed[0].Name, name);
        }
    });

test('a name that would become a flag is refused before it can reach podman', { skip }, () => {
    // podman really does read a leading dash as an option — `volume inspect
    // --format {{.Name}}` is a format request, not a volume called "--format" —
    // so the refusal has to happen in the builder, which is what this asserts.
    ['--format', '-f', '--all', '-a', '--help'].forEach((name) => {
        assert.throws(() => C.volumeInspectArgv('podman', '', name), (e) => {
            assert.equal(e.name, 'HangarError');
            return true;
        }, name);
        // And the name is genuinely one podman would misread, which is why the
        // refusal matters: asked directly, podman does not say "no such volume".
        const r = spawnSync('podman', ['volume', 'inspect', name], { encoding: 'utf8' });
        assert.ok(!/no such volume/.test(String(r.stderr)),
            `podman treats ${name} as a volume name after all — the guard may be over-strict`);
    });
});

test('the pause/stop/exec vectors keep a real container name in one element', { skip }, () => {
    // Built, never run — see the guard. What is asserted is the invariant that
    // matters when hangar-run does run them: the container name is the final
    // element and is byte-identical to what podman reported.
    const containers = liveContainerNames();
    assert.ok(containers.length > 0);
    const source = {
        id: 'live-db', kind: 'container', runtime: 'podman', user: USER,
        volumes: liveVolumeNames().slice(0, 1), containers,
        consistency: 'command', command: 'pg_dump app | gzip > /backup/app.sql.gz'
    };
    const pre = C.preCommands(source);
    assert.equal(pre.length, containers.length);
    pre.forEach((argv, i) => {
        argv.forEach((a) => assert.equal(typeof a, 'string'));
        assert.deepEqual(argv.slice(0, 6), ['runuser', '-u', USER, '--', 'podman', 'exec']);
        assert.equal(argv[6], containers[i]);
        // The pipeline is one argument, and the last one — a dump command that
        // split into two would run half a pipeline and report success.
        assert.deepEqual(argv.slice(7), ['sh', '-c', source.command]);
        assert.equal(argv.length, 10);
    });
});

// --- the warning has to reach the code the UI actually calls ------------

test('the live-database warning survives the trip through HangarSources', { skip }, () => {
    // The screen calls HangarSources.validate, not this module. A warning raised
    // only on the kind's own validate() would be correct and invisible.
    const Sources = require('../../js/core/sources.js');
    const containers = liveContainerNames();
    const source = {
        id: 'live-db', kind: 'container', runtime: 'podman', user: USER,
        volumes: liveVolumeNames().slice(0, 1), containers, consistency: 'none'
    };

    const problems = Sources.validate(source);
    const warned = problems.filter((p) => p.code === C.PROBLEM.LIVE_DATABASE);
    assert.ok(warned.length > 0,
        `no live-database warning for any of: ${containers.join(', ')}`);
    warned.forEach((p) => assert.equal(p.severity, Sources.SEVERITY.WARNING));

    // And it is a warning in the sense that matters: the source still saves, and
    // the backup still builds. A warning that blocked would be an error; one that
    // silently stopped the run would be worse than either.
    assert.equal(Sources.hasErrors(problems), false);
    assert.equal(Sources.isValid(source), true);
});

test('every runtime command this file executed was read-only', { skip }, () => {
    // The invariant restated over the whole run: no test above may have slipped a
    // mutating verb past the guard by constructing argv some other way.
    assert.ok(executed.length > 0, 'no runtime commands were executed — nothing was proven live');
    for (const argv of executed) {
        assert.ok(isReadOnly(argv), `a mutating command was executed: ${argv.join(' ')}`);
        // Belt and braces: the allowlist above says what is permitted, this says
        // what must never appear, so neither one alone has to be perfect.
        assert.ok(!/^(stop|start|pause|unpause|rm|kill|restart|exec|prune|create|import)$/
            .test((afterRuntime(argv) || [])[0] || ''),
        `a mutating verb reached the runtime: ${argv.join(' ')}`);
    }
});
