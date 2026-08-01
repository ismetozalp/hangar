// Integration tests for the v2 source kinds in libexec/hangar-run.
//
// hangar-run is the thing systemd actually executes, so "the JavaScript agrees
// with itself" is not enough — the helper has to resolve a volume's mount point
// and a domain's disks for real, as the right user, and unwind whatever it did
// afterwards. These tests drive --print-plan against stub `podman`, `docker`,
// `virsh` and `runuser` binaries placed first on PATH.
//
// Stubs rather than the real tools on purpose:
//   * rootless podman volumes belong to a user, and runuser needs root, so a
//     real inspect cannot run in a test;
//   * qemu:///system times out on this host and qemu:///session owns nothing,
//     so a real virsh would prove only that libvirt is unhappy.
// What is being tested is hangar-run's own behaviour — which argv it builds, as
// whom, in what order, and what it does with the answer — and a stub pins that
// precisely. Live-runtime coverage lives in the *-live tests.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELPER = path.join(__dirname, '..', '..', 'libexec', 'hangar-run');
const Container = require('../../js/core/sources-container.js');
const Libvirt = require('../../js/core/sources-libvirt.js');
const LOCAL_REPO = { id: 'main', kind: 'local', path: '/srv/backup' };
const STORE = '/stub/store';

// ---- stub binaries ---------------------------------------------------------

// Answers `volume inspect <name>` the way podman and docker both really do: a
// JSON array. Every invocation is appended to $HANGAR_TEST_CMD_LOG so the
// resolution call itself can be asserted, not just the plan it produced.
const RUNTIME_STUB = `#!/bin/sh
echo "$(basename "$0") $*" >> "$HANGAR_TEST_CMD_LOG"
if [ "$1" = "volume" ] && [ "$2" = "inspect" ]; then
  printf '[\\n  {\\n    "Name": "%s",\\n    "Driver": "local",\\n' "$3"
  printf '    "Mountpoint": "${STORE}/%s/_data"\\n  }\\n]\\n' "$3"
  exit 0
fi
exit 0
`;

// docker's --format '{{json .}}' emits one object per line and no array. Users
// do reach for it, so the parser has to survive the shape it produces.
const RUNTIME_STUB_LINES = `#!/bin/sh
echo "$(basename "$0") $*" >> "$HANGAR_TEST_CMD_LOG"
if [ "$1" = "volume" ] && [ "$2" = "inspect" ]; then
  printf '{"Name":"%s","Mountpoint":"${STORE}/%s/_data"}\\n' "$3" "$3"
  exit 0
fi
exit 0
`;

const RUNTIME_STUB_FAILS = `#!/bin/sh
echo "$(basename "$0") $*" >> "$HANGAR_TEST_CMD_LOG"
echo "Error: no such volume" >&2
exit 125
`;

// A volume the runtime knows about but reports no Mountpoint for. Guessing a
// path here would back up the wrong tree and restic would report success.
const RUNTIME_STUB_NO_MOUNT = `#!/bin/sh
echo "$(basename "$0") $*" >> "$HANGAR_TEST_CMD_LOG"
printf '[{"Name":"%s","Driver":"local"}]\\n' "$3"
exit 0
`;

// Strips "-u <user> --" and execs the rest, so a source that records an owner
// really does reach the runtime through runuser.
const RUNUSER_STUB = `#!/bin/sh
if [ "$1" != "-u" ]; then echo "runuser stub: expected -u, got $1" >&2; exit 2; fi
user=$2
shift 2
if [ "$1" != "--" ]; then echo "runuser stub: expected --, got $1" >&2; exit 2; fi
shift
echo "runuser -u $user -- $*" >> "$HANGAR_TEST_CMD_LOG"
exec "$@"
`;

// Two disks (one of them shared with every other domain, and with a space in
// its name), an attached ISO and an empty optical drive — the four rows that
// decide whether the parser is right.
const VIRSH_STUB = `#!/bin/sh
echo "virsh $*" >> "$HANGAR_TEST_CMD_LOG"
if [ "$1" = "-c" ]; then shift 2; fi
cmd=$1
shift
case "$cmd" in
  domblklist)
    domain=$2
    printf ' Type   Device   Target   Source\\n'
    printf '------------------------------------------------\\n'
    printf ' file   disk     vda      ${STORE}/%s.qcow2\\n' "$domain"
    printf ' file   disk     vdb      ${STORE}/shared data.qcow2\\n'
    printf ' file   cdrom    sda      ${STORE}/install.iso\\n'
    printf ' file   cdrom    sdb      -\\n'
    ;;
  dumpxml)
    printf '<domain type="kvm"><name>%s</name></domain>\\n' "$1"
    ;;
esac
exit 0
`;

const VIRSH_STUB_UNREACHABLE = `#!/bin/sh
echo "virsh $*" >> "$HANGAR_TEST_CMD_LOG"
echo "error: failed to connect to the hypervisor" >&2
exit 1
`;

// Inspects fine, refuses to stop. The pre step that fails is the interesting
// one: the post steps still have to run.
const RUNTIME_STUB_STOP_FAILS = `#!/bin/sh
echo "$(basename "$0") $*" >> "$HANGAR_TEST_CMD_LOG"
if [ "$1" = "volume" ] && [ "$2" = "inspect" ]; then
  printf '[{"Name":"%s","Mountpoint":"${STORE}/%s/_data"}]\\n' "$3" "$3"
  exit 0
fi
if [ "$1" = "stop" ]; then
  echo "Error: no container with name or ID \\"$2\\" found" >&2
  exit 125
fi
exit 0
`;

const RESTIC_STUB_OK = `#!/bin/sh
echo "restic $*" >> "$HANGAR_TEST_CMD_LOG"
echo '{"message_type":"summary","snapshot_id":"abc1234","files_new":1,"data_added":42}'
exit 0
`;

const RESTIC_STUB_FAILS = `#!/bin/sh
echo "restic $*" >> "$HANGAR_TEST_CMD_LOG"
echo '{"message_type":"exit_error","code":1,"message":"repository is unreachable"}' >&2
exit 1
`;

const DEFAULT_STUBS = {
    podman: RUNTIME_STUB,
    docker: RUNTIME_STUB,
    runuser: RUNUSER_STUB,
    virsh: VIRSH_STUB
};

// ---- harness ---------------------------------------------------------------

function withHost(jobs, stubs, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-src-'));
    try {
        fs.mkdirSync(path.join(dir, 'repos'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
        const bin = path.join(dir, 'bin');
        fs.mkdirSync(bin, { recursive: true });
        fs.writeFileSync(path.join(dir, 'repos', 'main.json'), JSON.stringify(LOCAL_REPO));
        for (const j of jobs)
            fs.writeFileSync(path.join(dir, 'jobs', j.id + '.json'), JSON.stringify(j));

        const all = Object.assign({}, DEFAULT_STUBS, stubs || {});
        for (const [name, body] of Object.entries(all)) {
            const p = path.join(bin, name);
            // ${STORE} is expanded here, not by the shell: the stub must not
            // depend on an environment variable a real runtime would not have.
            fs.writeFileSync(p, body.split('${STORE}').join(STORE));
            fs.chmodSync(p, 0o755);
        }

        const log = path.join(dir, 'commands.log');
        fs.writeFileSync(log, '');
        const env = Object.assign({}, process.env, {
            HANGAR_CONF_DIR: dir,
            CREDENTIALS_DIRECTORY: '',
            HANGAR_TEST_CMD_LOG: log,
            PATH: bin + ':' + process.env.PATH
        });
        return fn({
            dir, env, log,
            commands: () => fs.readFileSync(log, 'utf8').split('\n').filter((l) => l !== '')
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// stdio 'pipe' on stderr as well: the helper writes its consistency warnings to
// the journal even for a dry run, and letting them through would bury the test
// runner's own output in them.
function plan(host, jobId) {
    return JSON.parse(execFileSync('python3', [HELPER, jobId, '--print-plan'],
        { env: host.env, encoding: 'utf8', stdio: 'pipe' }));
}

function refuse(host, jobId) {
    try {
        execFileSync('python3', [HELPER, jobId, '--print-plan'],
            { env: host.env, encoding: 'utf8', stdio: 'pipe' });
        return null;
    } catch (e) {
        return { code: e.status, stderr: String(e.stderr || '') };
    }
}

// A real run, with a stub restic. Returns the exit code and stderr rather than
// throwing, because the failure paths are what these tests are about.
function run(host, jobId) {
    host.env.HANGAR_STATE_DIR = path.join(host.dir, 'state');
    host.env.HANGAR_LIBVIRT_XML_DIR = path.join(host.dir, 'xml');
    try {
        execFileSync('python3', [HELPER, jobId], { env: host.env, encoding: 'utf8', stdio: 'pipe' });
        return { code: 0, stderr: '' };
    } catch (e) {
        return { code: e.status, stderr: String(e.stderr || '') };
    }
}

const argvs = (steps) => steps.map((s) => s.argv);
const job = (extra) => Object.assign({ id: 'j', repo: 'main', retention: { daily: 7 } }, extra);

// ---- container sources -----------------------------------------------------

test('container volume paths come from the runtime, not from a guessed directory', () => {
    const j = job({
        sources: [{ id: 'vols', kind: 'container', runtime: 'podman', user: 'appuser',
            volumes: ['pgdata', 'assets'] }]
    });
    withHost([j], null, (host) => {
        const p = plan(host, 'j');
        // Sorted, so the restic path vector — and with it `forget --group-by
        // host,paths` — does not depend on the order volumes were clicked in.
        assert.deepEqual(p.sources[0].paths,
            [`${STORE}/assets/_data`, `${STORE}/pgdata/_data`]);
        assert.ok(p.backup.includes(`${STORE}/pgdata/_data`));
        assert.ok(p.backup.includes(`${STORE}/assets/_data`));
        assert.ok(!p.backup.some((a) => a.includes('/var/lib/containers')),
            'no hardcoded store path may appear in the command');
    });
});

test('a rootless source inspects volumes through runuser, as the owning user', () => {
    // The single most important thing here: root's podman is a different store,
    // so an inspect that forgets runuser silently finds nothing.
    const j = job({
        sources: [{ id: 'vols', kind: 'container', user: 'appuser', volumes: ['pgdata'] }]
    });
    withHost([j], null, (host) => {
        plan(host, 'j');
        assert.ok(host.commands().includes('runuser -u appuser -- podman volume inspect pgdata'),
            'the inspect must run as the user who owns the runtime\n' +
            host.commands().join('\n'));
    });
});

test('a source with no user recorded talks to the runtime directly', () => {
    const j = job({ sources: [{ id: 'vols', kind: 'container', volumes: ['assets'] }] });
    withHost([j], null, (host) => {
        plan(host, 'j');
        assert.deepEqual(host.commands(), ['podman volume inspect assets']);
    });
});

test('user "root" is not wrapped in runuser — it is already the runtime we are', () => {
    const j = job({
        sources: [{ id: 'vols', kind: 'container', user: 'root', volumes: ['assets'],
            containers: ['app'], consistency: 'pause' }]
    });
    withHost([j], null, (host) => {
        const p = plan(host, 'j');
        assert.deepEqual(argvs(p.pre), [['podman', 'pause', 'app']]);
        assert.deepEqual(host.commands(), ['podman volume inspect assets']);
    });
});

test('pause mode pauses in order and unpauses in reverse', () => {
    const j = job({
        sources: [{ id: 'vols', kind: 'container', user: 'appuser', volumes: ['pgdata'],
            containers: ['app', 'db'], consistency: 'pause' }]
    });
    withHost([j], null, (host) => {
        const p = plan(host, 'j');
        assert.deepEqual(argvs(p.pre), [
            ['runuser', '-u', 'appuser', '--', 'podman', 'pause', 'app'],
            ['runuser', '-u', 'appuser', '--', 'podman', 'pause', 'db']
        ]);
        // Reverse, because the author lists containers in shutdown order: the
        // database comes back before the app that needs it.
        assert.deepEqual(argvs(p.post), [
            ['runuser', '-u', 'appuser', '--', 'podman', 'unpause', 'db'],
            ['runuser', '-u', 'appuser', '--', 'podman', 'unpause', 'app']
        ]);
    });
});

test('stop mode stops in order and starts in reverse', () => {
    const j = job({
        sources: [{ id: 'vols', kind: 'container', volumes: ['pgdata'],
            containers: ['app', 'db'], consistency: 'stop' }]
    });
    withHost([j], null, (host) => {
        const p = plan(host, 'j');
        assert.deepEqual(argvs(p.pre),
            [['podman', 'stop', 'app'], ['podman', 'stop', 'db']]);
        assert.deepEqual(argvs(p.post),
            [['podman', 'start', 'db'], ['podman', 'start', 'app']]);
    });
});

test('command mode execs a shell pipeline inside the container and undoes nothing', () => {
    const j = job({
        sources: [{ id: 'vols', kind: 'container', volumes: ['dumps'], containers: ['db'],
            consistency: 'command', command: 'pg_dump app | gzip > /dumps/app.sql.gz' }]
    });
    withHost([j], null, (host) => {
        const p = plan(host, 'j');
        assert.deepEqual(argvs(p.pre), [
            ['podman', 'exec', 'db', 'sh', '-c', 'pg_dump app | gzip > /dumps/app.sql.gz']
        ]);
        // The dump wrote a file and changed nothing else, so there is nothing
        // to unwind — an unpause here would be a lie about what happened.
        assert.deepEqual(p.post, []);
    });
});

test('live copy mode runs no pre or post commands at all', () => {
    const j = job({
        sources: [{ id: 'vols', kind: 'container', volumes: ['assets'], containers: ['web'] }]
    });
    withHost([j], null, (host) => {
        const p = plan(host, 'j');
        assert.deepEqual(p.pre, []);
        assert.deepEqual(p.post, []);
        assert.equal(p.sources[0].consistency, 'none');
    });
});

test('docker is accepted, and one-object-per-line inspect output is tolerated', () => {
    const j = job({
        sources: [{ id: 'vols', kind: 'container', runtime: 'docker', volumes: ['assets'] }]
    });
    withHost([j], { docker: RUNTIME_STUB_LINES }, (host) => {
        const p = plan(host, 'j');
        assert.deepEqual(p.sources[0].paths, [`${STORE}/assets/_data`]);
        assert.deepEqual(host.commands(), ['docker volume inspect assets']);
    });
});

test('per-source excludes and tags reach the backup command', () => {
    const j = job({
        sources: [{ id: 'vols', kind: 'container', volumes: ['assets'],
            excludes: ['*.tmp'], tags: ['containers'] }]
    });
    withHost([j], null, (host) => {
        const p = plan(host, 'j');
        assert.deepEqual(p.sources[0].flags, ['--exclude', '*.tmp', '--tag', 'containers']);
        assert.ok(p.backup.includes('*.tmp'));
        assert.ok(p.backup.includes('containers'));
    });
});

test('a failing inspect is a configuration error naming the volume, not a crash', () => {
    const j = job({
        sources: [{ id: 'vols', kind: 'container', user: 'appuser', volumes: ['gone'] }]
    });
    withHost([j], { podman: RUNTIME_STUB_FAILS }, (host) => {
        const res = refuse(host, 'j');
        assert.equal(res.code, 1);
        assert.match(res.stderr, /could not inspect container volume/);
        assert.match(res.stderr, /gone/);
        // Which user was asked matters: it is almost always the answer.
        assert.match(res.stderr, /appuser/);
    });
});

test('a volume with no mount point is refused rather than guessed at', () => {
    const j = job({ sources: [{ id: 'vols', kind: 'container', volumes: ['weird'] }] });
    withHost([j], { podman: RUNTIME_STUB_NO_MOUNT }, (host) => {
        const res = refuse(host, 'j');
        assert.equal(res.code, 1);
        assert.match(res.stderr, /no mount point/);
    });
});

test('unknown runtimes, unsafe names and bad users are refused', () => {
    const cases = [
        [{ id: 'a', kind: 'container', runtime: 'lxc', volumes: ['v'] }, /unknown container runtime/],
        [{ id: 'b', kind: 'container', volumes: ['v; rm -rf /'] }, /unsafe volume name/],
        [{ id: 'c', kind: 'container', volumes: ['-flag'] }, /unsafe volume name/],
        [{ id: 'd', kind: 'container', volumes: ['v'], containers: ['a b'],
            consistency: 'stop' }, /unsafe container name/],
        [{ id: 'e', kind: 'container', volumes: ['v'], user: 'a;b' }, /not a valid user name/],
        [{ id: 'f', kind: 'container', volumes: [] }, /lists no volumes/],
        [{ id: 'g', kind: 'container', volumes: ['v'], consistency: 'blend' },
            /unknown consistency mode/],
        [{ id: 'h', kind: 'container', volumes: ['v'], containers: ['db'],
            consistency: 'command' }, /needs a command/],
        [{ id: 'i', kind: 'container', volumes: ['v'], consistency: 'stop' },
            /needs at least one container/]
    ];
    const jobs = cases.map((c, i) => job({ id: 'bad' + i, sources: [c[0]] }));
    withHost(jobs, null, (host) => {
        cases.forEach((c, i) => {
            const res = refuse(host, 'bad' + i);
            assert.ok(res, 'case ' + i + ' should have been refused');
            assert.equal(res.code, 1, 'case ' + i);
            assert.match(res.stderr, c[1], 'case ' + i);
        });
    });
});

// ---- libvirt sources -------------------------------------------------------

test('domain disks come from domblklist, skipping cdroms and empty drives', () => {
    const j = job({ sources: [{ id: 'vms', kind: 'libvirt', domains: ['web'] }] });
    withHost([j], null, (host) => {
        const p = plan(host, 'j');
        const disks = p.sources[0].paths.filter((x) => x.endsWith('.qcow2'));
        // The space in "shared data.qcow2" survives as one argv entry, which is
        // what the bounded four-column split exists for.
        assert.deepEqual(disks, [`${STORE}/shared data.qcow2`, `${STORE}/web.qcow2`]);
        assert.ok(!p.backup.some((a) => a.endsWith('.iso')), 'installation media is not VM state');
        assert.ok(!p.backup.includes('-'));
        assert.ok(host.commands().includes('virsh -c qemu:///system domblklist --details web'));
    });
});

test('a disk shared by two domains is backed up once', () => {
    const j = job({ sources: [{ id: 'vms', kind: 'libvirt', domains: ['web', 'db'] }] });
    withHost([j], null, (host) => {
        const p = plan(host, 'j');
        const shared = p.sources[0].paths.filter((x) => x === `${STORE}/shared data.qcow2`);
        assert.equal(shared.length, 1);
    });
});

test('the domain XML is staged under /var/lib/hangar/libvirt and backed up with the disks', () => {
    // A disk image without its XML is not a restorable VM, so includeXml is on
    // unless the user turned it off.
    const j = job({ sources: [{ id: 'vms', kind: 'libvirt', domains: ['web'] }] });
    withHost([j], null, (host) => {
        const p = plan(host, 'j');
        assert.equal(p.sources[0].includeXml, true);
        assert.deepEqual(p.sources[0].xml, ['/var/lib/hangar/libvirt/web.xml']);
        assert.ok(p.backup.includes('/var/lib/hangar/libvirt/web.xml'));
        assert.deepEqual(p.pre[0].argv, ['virsh', '-c', 'qemu:///system', 'dumpxml', 'web']);
        assert.equal(p.pre[0].capture, '/var/lib/hangar/libvirt/web.xml');
        // --print-plan describes the run; it must not perform it.
        assert.ok(!host.commands().some((c) => c.includes('dumpxml')));
    });
});

test('includeXml false drops both the dump step and the staged path', () => {
    const j = job({
        sources: [{ id: 'vms', kind: 'libvirt', domains: ['web'], includeXml: false }]
    });
    withHost([j], null, (host) => {
        const p = plan(host, 'j');
        assert.deepEqual(p.sources[0].xml, []);
        assert.deepEqual(p.pre, []);
        assert.ok(!p.backup.some((a) => a.endsWith('.xml')));
    });
});

test('agent quiesce freezes every domain and thaws in reverse', () => {
    const j = job({
        sources: [{ id: 'vms', kind: 'libvirt', domains: ['web', 'db'], quiesce: 'agent',
            includeXml: false }]
    });
    withHost([j], null, (host) => {
        const p = plan(host, 'j');
        assert.deepEqual(argvs(p.pre), [
            ['virsh', '-c', 'qemu:///system', 'domfsfreeze', 'db'],
            ['virsh', '-c', 'qemu:///system', 'domfsfreeze', 'web']
        ]);
        assert.deepEqual(argvs(p.post), [
            ['virsh', '-c', 'qemu:///system', 'domfsthaw', 'web'],
            ['virsh', '-c', 'qemu:///system', 'domfsthaw', 'db']
        ]);
    });
});

test('shutdown quiesce shuts down first and starts again afterwards', () => {
    const j = job({
        sources: [{ id: 'vms', kind: 'libvirt', domains: ['web'], quiesce: 'shutdown' }]
    });
    withHost([j], null, (host) => {
        const p = plan(host, 'j');
        // XML is dumped before the domain goes down: a shutdown that fails
        // still has to leave us with something restorable.
        assert.deepEqual(argvs(p.pre), [
            ['virsh', '-c', 'qemu:///system', 'dumpxml', 'web'],
            ['virsh', '-c', 'qemu:///system', 'shutdown', 'web']
        ]);
        assert.deepEqual(argvs(p.post), [['virsh', '-c', 'qemu:///system', 'start', 'web']]);
    });
});

test('quiesce none leaves the domain alone', () => {
    const j = job({
        sources: [{ id: 'vms', kind: 'libvirt', domains: ['web'], includeXml: false }]
    });
    withHost([j], null, (host) => {
        const p = plan(host, 'j');
        assert.deepEqual(p.pre, []);
        assert.deepEqual(p.post, []);
    });
});

test('a session URI is passed through to virsh unchanged', () => {
    const j = job({
        sources: [{ id: 'vms', kind: 'libvirt', uri: 'qemu:///session', domains: ['web'] }]
    });
    withHost([j], null, (host) => {
        const p = plan(host, 'j');
        assert.deepEqual(p.pre[0].argv.slice(0, 3), ['virsh', '-c', 'qemu:///session']);
        assert.ok(host.commands().includes('virsh -c qemu:///session domblklist --details web'));
    });
});

test('an unreachable hypervisor is reported, not hung on', () => {
    // qemu:///system times out outright on some hosts. A unit that never
    // finishes is invisible in a way a failed one is not.
    const j = job({ sources: [{ id: 'vms', kind: 'libvirt', domains: ['web'] }] });
    withHost([j], { virsh: VIRSH_STUB_UNREACHABLE }, (host) => {
        const res = refuse(host, 'j');
        assert.equal(res.code, 1);
        assert.match(res.stderr, /could not list domain disks/);
        assert.match(res.stderr, /failed to connect to the hypervisor/);
    });
});

test('a virsh that never answers is abandoned at the deadline', () => {
    const j = job({ sources: [{ id: 'vms', kind: 'libvirt', domains: ['web'] }] });
    const stub = '#!/bin/sh\nsleep 30\n';
    withHost([j], { virsh: stub }, (host) => {
        host.env.HANGAR_CMD_TIMEOUT = '1';
        const started = Date.now();
        const res = refuse(host, 'j');
        assert.equal(res.code, 1);
        assert.match(res.stderr, /no answer within/);
        assert.ok(Date.now() - started < 15000, 'the deadline did not fire');
    });
});

test('unsafe domain names and unknown quiesce modes are refused', () => {
    const cases = [
        [{ id: 'a', kind: 'libvirt', domains: [] }, /lists no domains/],
        [{ id: 'b', kind: 'libvirt', domains: ['../../etc/passwd'] }, /unsafe domain name/],
        [{ id: 'c', kind: 'libvirt', domains: ['web; reboot'] }, /unsafe domain name/],
        [{ id: 'd', kind: 'libvirt', domains: ['-all'] }, /unsafe domain name/],
        [{ id: 'e', kind: 'libvirt', domains: ['web'], quiesce: 'magic' }, /unknown quiesce mode/]
    ];
    const jobs = cases.map((c, i) => job({ id: 'bad' + i, sources: [c[0]] }));
    withHost(jobs, null, (host) => {
        cases.forEach((c, i) => {
            const res = refuse(host, 'bad' + i);
            assert.ok(res, 'case ' + i + ' should have been refused');
            assert.equal(res.code, 1, 'case ' + i);
            assert.match(res.stderr, c[1], 'case ' + i);
        });
    });
});

// ---- what --print-plan cannot prove: the try/finally guarantee -------------

test('containers are started again even when the backup fails', () => {
    // The whole reason the pre/post steps live in a try/finally. A container
    // left stopped because a backup errored is a worse outcome than a failed
    // backup, and it is the outcome nobody notices until the service is missed.
    const j = job({
        sources: [{ id: 'vols', kind: 'container', volumes: ['pgdata'],
            containers: ['app', 'db'], consistency: 'stop' }]
    });
    withHost([j], { restic: RESTIC_STUB_FAILS }, (host) => {
        const res = run(host, 'j');
        assert.equal(res.code, 2, 'a failed backup is still a failed backup');
        const cmds = host.commands();
        assert.ok(cmds.includes('podman start db'), cmds.join('\n'));
        assert.ok(cmds.includes('podman start app'), cmds.join('\n'));
        // Started only after restic was given its chance, not instead of it.
        assert.ok(cmds.findIndex((c) => c.startsWith('restic')) <
                  cmds.indexOf('podman start db'));
    });
});

test('a failing pre step aborts the backup but still runs every post step', () => {
    const j = job({
        sources: [{ id: 'vols', kind: 'container', volumes: ['pgdata'],
            containers: ['app', 'db'], consistency: 'stop' }]
    });
    withHost([j], { podman: RUNTIME_STUB_STOP_FAILS, restic: RESTIC_STUB_OK }, (host) => {
        const res = run(host, 'j');
        assert.equal(res.code, 4);
        assert.match(res.stderr, /source pre-command failed/);
        const cmds = host.commands();
        // Backing up a database that was never actually stopped, while telling
        // the user it was, is the one thing this must not do.
        assert.ok(!cmds.some((c) => c.startsWith('restic')), cmds.join('\n'));
        assert.ok(cmds.includes('podman start db'));
        assert.ok(cmds.includes('podman start app'));
    });
});

test('a failing post step is reported even though the snapshot was written', () => {
    // podman stops nothing and starts nothing here; `stop` failing in the pre
    // half is what leaves `start` to fail too. Exit 4 rather than 0: the
    // snapshot is safe, the host is not.
    const j = job({
        sources: [{ id: 'vols', kind: 'container', volumes: ['pgdata'],
            containers: ['db'], consistency: 'stop' }]
    });
    const stub = RUNTIME_STUB_STOP_FAILS.replace('if [ "$1" = "stop" ]', 'if [ "$1" = "start" ]');
    withHost([j], { podman: stub, restic: RESTIC_STUB_OK }, (host) => {
        const res = run(host, 'j');
        assert.equal(res.code, 4);
        assert.match(res.stderr, /source post-command failed/);
        const state = JSON.parse(fs.readFileSync(
            path.join(host.dir, 'state', 'j.json'), 'utf8'));
        assert.equal(state.snapshot, 'abc1234');
        assert.equal(state.post_failures, 1);
    });
});

test('a clean run stages the domain XML and unwinds the freeze', () => {
    const j = job({
        sources: [{ id: 'vms', kind: 'libvirt', domains: ['web'], quiesce: 'agent' }]
    });
    withHost([j], { restic: RESTIC_STUB_OK }, (host) => {
        const res = run(host, 'j');
        assert.equal(res.code, 0, res.stderr);
        // The dump is captured to a file rather than piped through a shell, and
        // that file is what makes the disk image a restorable VM.
        assert.equal(fs.readFileSync(path.join(host.dir, 'xml', 'web.xml'), 'utf8'),
            '<domain type="kvm"><name>web</name></domain>\n');
        const cmds = host.commands();
        assert.ok(cmds.includes('virsh -c qemu:///system domfsfreeze web'));
        assert.ok(cmds.includes('virsh -c qemu:///system domfsthaw web'));
        assert.ok(cmds.indexOf('virsh -c qemu:///system domfsfreeze web') <
                  cmds.findIndex((c) => c.startsWith('restic')));
        assert.ok(cmds.findIndex((c) => c.startsWith('restic')) <
                  cmds.indexOf('virsh -c qemu:///system domfsthaw web'));
    });
});

// ---- agreement with js/core ------------------------------------------------
//
// hangar-run re-implements what the source modules do, because it must work with
// no Cockpit session present. Duplication is only safe if it is policed.

test('container argv and restic args agree with js/core/sources-container.js', () => {
    const source = {
        id: 'vols', kind: 'container', runtime: 'podman', user: 'appuser',
        volumes: ['pgdata', 'assets'], containers: ['app', 'db'], consistency: 'stop',
        excludes: ['*.tmp'], tags: ['containers']
    };
    withHost([job({ sources: [source] })], null, (host) => {
        const p = plan(host, 'j');
        const py = p.sources[0];

        assert.deepEqual(argvs(p.pre), Container.preCommands(source),
            'python and javascript disagree on the pre commands');
        assert.deepEqual(argvs(p.post), Container.postCommands(source),
            'python and javascript disagree on the post commands');
        // Feeding the JS the paths the helper resolved is the point: only the
        // runtime knows them, and both sides must lay them out the same way.
        assert.deepEqual(py.flags.concat(py.paths),
            Container.toResticArgs(Object.assign({}, source, { resolvedPaths: py.paths })),
            'python and javascript disagree on the restic arguments');
        assert.deepEqual(py.volumes, Container.normalize(source).volumes);
        assert.deepEqual(py.containers, Container.normalize(source).containers);
    });
});

test('libvirt argv and restic args agree with js/core/sources-libvirt.js', () => {
    const source = {
        id: 'vms', kind: 'libvirt', uri: 'qemu:///system', domains: ['web', 'db'],
        quiesce: 'agent', excludes: ['*.iso'], tags: ['vms']
    };
    withHost([job({ sources: [source] })], null, (host) => {
        const p = plan(host, 'j');
        const py = p.sources[0];
        const disks = py.paths.filter((x) => py.xml.indexOf(x) < 0);

        // The XML dumps are hangar-run's own doing (the JS stages them from the
        // browser), so only the quiesce half is compared.
        const quiesceSteps = argvs(p.pre).filter((a) => a[3] !== 'dumpxml');
        assert.deepEqual(quiesceSteps, Libvirt.preCommands(source));
        assert.deepEqual(argvs(p.post), Libvirt.postCommands(source));

        assert.deepEqual(py.flags.concat(py.paths),
            Libvirt.toResticArgs(Object.assign({}, source, { resolvedPaths: disks })),
            'python and javascript disagree on the restic arguments');
        // Including where the XML is staged — a path the two sides invent
        // separately is a path a restore would look for in the wrong place.
        assert.deepEqual(py.xml, source.domains.slice().sort()
            .map((d) => Libvirt.xmlPathFor(source, d)));
    });
});

// ---- the whole job ---------------------------------------------------------

test('a job mixing all three kinds unwinds in the reverse of the order it wound up', () => {
    const j = job({
        sources: [
            { id: 'files', kind: 'filesystem', paths: ['/etc'] },
            { id: 'vols', kind: 'container', volumes: ['pgdata'], containers: ['app', 'db'],
                consistency: 'stop' },
            { id: 'vms', kind: 'libvirt', domains: ['web'], quiesce: 'agent', includeXml: false }
        ]
    });
    withHost([j], null, (host) => {
        const p = plan(host, 'j');
        assert.deepEqual(p.sources.map((s) => s.kind), ['filesystem', 'container', 'libvirt']);
        assert.deepEqual(argvs(p.pre), [
            ['podman', 'stop', 'app'],
            ['podman', 'stop', 'db'],
            ['virsh', '-c', 'qemu:///system', 'domfsfreeze', 'web']
        ]);
        // Across sources as well as within one: the VM thaws before the
        // containers that might be talking to it come back.
        assert.deepEqual(argvs(p.post), [
            ['virsh', '-c', 'qemu:///system', 'domfsthaw', 'web'],
            ['podman', 'start', 'db'],
            ['podman', 'start', 'app']
        ]);
        assert.ok(p.backup.includes('/etc'));
        assert.ok(p.backup.includes(`${STORE}/pgdata/_data`));
        assert.ok(p.backup.includes(`${STORE}/web.qcow2`));
    });
});

test('every step carries the id of the source that asked for it', () => {
    const j = job({
        sources: [
            { id: 'vols', kind: 'container', volumes: ['v'], containers: ['db'],
                consistency: 'stop' },
            { id: 'vms', kind: 'libvirt', domains: ['web'] }
        ]
    });
    withHost([j], null, (host) => {
        const p = plan(host, 'j');
        assert.deepEqual(p.pre.map((s) => s.source), ['vols', 'vms']);
        assert.deepEqual(p.post.map((s) => s.source), ['vols']);
    });
});

test('the empty-retention guard still fires for the new kinds', () => {
    // Running `forget` with no --keep flags deletes every snapshot. Resolution
    // happening first must not let that guard slip.
    const j = job({
        id: 'empty', retention: { daily: 0 },
        sources: [{ id: 'vols', kind: 'container', volumes: ['assets'] }]
    });
    withHost([j], null, (host) => {
        const res = refuse(host, 'empty');
        assert.equal(res.code, 1);
        assert.match(res.stderr, /keep no snapshots/);
    });
});

test('a source kind the helper does not implement is still refused', () => {
    const j = job({ sources: [{ id: 'x', kind: 'zfs-dataset', paths: ['/tank'] }] });
    withHost([j], null, (host) => {
        const res = refuse(host, 'j');
        assert.equal(res.code, 1);
        assert.match(res.stderr, /unsupported source kind/);
    });
});

test('a container source that resolves to nothing cannot produce an empty backup', () => {
    // The v1 guard, still standing: restic with no positional paths would back
    // up the unit's working directory.
    const j = { id: 'j', repo: 'main', sources: [] };
    withHost([j], null, (host) => {
        const res = refuse(host, 'j');
        assert.equal(res.code, 1);
        assert.match(res.stderr, /no paths to back up/);
    });
});

// ============================================================================
// adversarial hardening
// ============================================================================
//
// Everything above proves the helper builds the right plan for a well-formed
// job. Everything below assumes the job file is hostile — because it is the one
// input hangar-run cannot re-check against a live UI: it is read by root, from a
// systemd timer, at three in the morning, with nobody watching.
//
// Three properties, in this order of importance:
//
//   1. SHELL SAFETY. Every volume name, container name, domain name, dump
//      command and discovered path travels as exactly ONE argv element, and a
//      value that could not do so is refused rather than escaped or quoted.
//   2. THE UNWIND. Whatever fails and however it fails, no container is left
//      paused or stopped and no guest is left frozen or shut down.
//   3. NO TRACEBACKS. Every refusal is a structured journal line and an exit
//      code. A stack trace tells the operator that hangar broke; only a
//      structured refusal tells them their configuration is wrong.

const NUL = '\u0000';

// Named absolutely for the one test that empties PATH to prove what the runner
// does when restic is simply not installed.
const PYTHON3 = execFileSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim();

// Logs argument BOUNDARIES rather than a joined line. `$*` has already lost the
// distinction between one argument containing a space and two arguments, so it
// cannot prove atomicity; `argc` plus one line per argument can.
const RECORD_ARGV = `record_argv() {
  { printf '%s argc=%d\\n' "$(basename "$0")" "$#"
    for a in "$@"; do printf '%s arg=[%s]\\n' "$(basename "$0")" "$a"; done
  } >> "$HANGAR_TEST_CMD_LOG"
}
`;

const RUNTIME_STUB_ARGV = `#!/bin/sh
${RECORD_ARGV}record_argv "$@"
if [ "$1" = "volume" ] && [ "$2" = "inspect" ]; then
  printf '[{"Name":"%s","Mountpoint":"${STORE}/%s/_data"}]\\n' "$3" "$3"
fi
exit 0
`;

const RUNUSER_STUB_ARGV = `#!/bin/sh
${RECORD_ARGV}record_argv "$@"
if [ "$1" != "-u" ]; then echo "runuser stub: expected -u, got $1" >&2; exit 2; fi
shift 2
if [ "$1" != "--" ]; then echo "runuser stub: expected --, got $1" >&2; exit 2; fi
shift
exec "$@"
`;

const VIRSH_STUB_ARGV = `#!/bin/sh
${RECORD_ARGV}record_argv "$@"
if [ "$1" = "-c" ]; then shift 2; fi
if [ "$1" = "domblklist" ]; then
  printf ' Type   Device   Target   Source\\n'
  printf ' file   disk     vda      ${STORE}/disk.qcow2\\n'
fi
if [ "$1" = "dumpxml" ]; then printf '<domain/>\\n'; fi
exit 0
`;

// Answers with a mount point no kernel could produce. Handing it to execve would
// back up a path silently truncated at the NUL.
const RUNTIME_STUB_NUL_MOUNT = `#!/bin/sh
echo "$(basename "$0") $*" >> "$HANGAR_TEST_CMD_LOG"
printf '[{"Name":"%s","Mountpoint":"${STORE}/bad\\\\u0000name/_data"}]\\n' "$3"
exit 0
`;

// Inspects and stops fine; refuses to start again. A post half that fails while
// the backup succeeded is the case the exit contract has a code for.
const RUNTIME_STUB_START_FAILS = `#!/bin/sh
echo "$(basename "$0") $*" >> "$HANGAR_TEST_CMD_LOG"
if [ "$1" = "volume" ] && [ "$2" = "inspect" ]; then
  printf '[{"Name":"%s","Mountpoint":"${STORE}/%s/_data"}]\\n' "$3" "$3"
  exit 0
fi
if [ "$1" = "start" ]; then
  echo "Error: cannot start \\"$2\\"" >&2
  exit 125
fi
exit 0
`;

// Freezes fine, refuses to thaw the FIRST domain it is asked about. Whether the
// second domain is still thawed afterwards is the whole question.
const VIRSH_STUB_THAW_FAILS = `#!/bin/sh
echo "virsh $*" >> "$HANGAR_TEST_CMD_LOG"
if [ "$1" = "-c" ]; then shift 2; fi
case "$1" in
  domblklist)
    printf ' Type   Device   Target   Source\\n'
    printf ' file   disk     vda      ${STORE}/%s.qcow2\\n' "$3"
    ;;
  dumpxml) printf '<domain/>\\n' ;;
  domfsthaw)
    if [ "$2" = "web" ]; then echo "error: Unable to thaw filesystems" >&2; exit 1; fi
    ;;
esac
exit 0
`;

// Stops fine, then refuses to freeze. The containers an earlier source stopped
// are the ones nobody would think to check.
const VIRSH_STUB_FREEZE_FAILS = `#!/bin/sh
echo "virsh $*" >> "$HANGAR_TEST_CMD_LOG"
if [ "$1" = "-c" ]; then shift 2; fi
case "$1" in
  domblklist)
    printf ' Type   Device   Target   Source\\n'
    printf ' file   disk     vda      ${STORE}/%s.qcow2\\n' "$3"
    ;;
  dumpxml) printf '<domain/>\\n' ;;
  domfsfreeze) echo "error: Unable to freeze filesystems" >&2; exit 1 ;;
esac
exit 0
`;

// ---- harness additions -----------------------------------------------------

// spawnSync rather than execFileSync: the warnings under test are journal lines
// on stderr, and execFileSync only surfaces stderr when the child fails.
function planAndLog(host, jobId) {
    const res = spawnSync('python3', [HELPER, jobId, '--print-plan'],
        { env: host.env, encoding: 'utf8' });
    return {
        code: res.status,
        stderr: String(res.stderr || ''),
        plan: res.status === 0 ? JSON.parse(res.stdout) : null
    };
}

function runAndLog(host, jobId) {
    host.env.HANGAR_STATE_DIR = path.join(host.dir, 'state');
    host.env.HANGAR_LIBVIRT_XML_DIR = path.join(host.dir, 'xml');
    const res = spawnSync('python3', [HELPER, jobId], { env: host.env, encoding: 'utf8' });
    return { code: res.status, stderr: String(res.stderr || '') };
}

// Rebuilds the argument vectors a stub really received, from the boundary
// markers it logged. `argc` is read first and exactly that many `arg=[...]`
// lines are consumed, so a miscount surfaces as a wrong-length vector rather
// than as a silently plausible one.
function argvCalls(host, program) {
    const lines = host.commands();
    const calls = [];
    for (let i = 0; i < lines.length; i++) {
        const head = new RegExp('^' + program + ' argc=(\\d+)$').exec(lines[i]);
        if (!head) continue;
        const count = Number(head[1]);
        const argv = [];
        for (let k = 0; k < count; k++) {
            const m = new RegExp('^' + program + ' arg=\\[([\\s\\S]*)\\]$').exec(lines[i + 1 + k]);
            argv.push(m ? m[1] : lines[i + 1 + k]);
        }
        calls.push(argv);
        i += count;
    }
    return calls;
}

// A refusal is only acceptable if it is a refusal.
function assertNoTraceback(stderr, label) {
    assert.ok(!/Traceback \(most recent call last\)/.test(stderr),
        (label || 'the helper') + ' crashed instead of refusing:\n' + stderr);
}

// Every journal line is a JSON object behind a <N> priority prefix. Parsing them
// back is how the warnings are asserted without pinning the exact wording.
function journal(stderr) {
    return stderr.split('\n')
        .map((l) => /^<\d+>(\{[\s\S]*\})$/.exec(l.trim()))
        .filter(Boolean)
        .map((m) => { try { return JSON.parse(m[1]); } catch (e) { return null; } })
        .filter(Boolean);
}

// ---- shell safety: one argv element, always --------------------------------

test('a domain name containing a space reaches virsh as exactly one argument', () => {
    // Spaces are legal in a libvirt domain name and both implementations accept
    // them, which makes this the sharpest proof available: if the name were ever
    // joined into a command line, virsh would be asked about two domains.
    const j = job({ sources: [{ id: 'vms', kind: 'libvirt', domains: ['web server'] }] });
    withHost([j], { virsh: VIRSH_STUB_ARGV }, (host) => {
        const p = plan(host, 'j');
        assert.deepEqual(argvCalls(host, 'virsh'), [
            ['-c', 'qemu:///system', 'domblklist', '--details', 'web server']
        ]);
        // The same name, still whole, in the step the runner will execute.
        assert.deepEqual(p.pre[0].argv,
            ['virsh', '-c', 'qemu:///system', 'dumpxml', 'web server']);
        assert.equal(p.pre[0].capture, '/var/lib/hangar/libvirt/web server.xml');
    });
});

test('the dump command survives runuser and the runtime as a single argument', () => {
    // It passes through three programs before it reaches sh: runuser, the
    // runtime, then exec. Any one of them joining it would turn the redirection
    // into a redirection of the wrapper's own output.
    const command = "pg_dump -U postgres 'app db' | gzip > /dumps/app.sql.gz; echo $?";
    const j = job({
        sources: [{ id: 'vols', kind: 'container', user: 'appuser', volumes: ['dumps'],
            containers: ['db'], consistency: 'command', command }]
    });
    withHost([j], { podman: RUNTIME_STUB_ARGV, runuser: RUNUSER_STUB_ARGV }, (host) => {
        const argv = plan(host, 'j').pre[0].argv;
        assert.deepEqual(argv,
            ['runuser', '-u', 'appuser', '--', 'podman', 'exec', 'db', 'sh', '-c', command]);
        assert.equal(argv.filter((a) => a === command).length, 1);
        // '--' at a fixed position is what stops runuser reading anything after it
        // as one of its own options.
        assert.equal(argv.indexOf('--'), 3);
    });
});

test('an argument stays whole through a real exec, not just in the plan', () => {
    // --print-plan proves the vector; this proves nothing on the way to execve
    // re-splits it. The volume name is the carrier because it is what runuser
    // actually forwards.
    const j = job({
        sources: [{ id: 'vols', kind: 'container', user: 'appuser', volumes: ['app.data-1'] }]
    });
    withHost([j], { podman: RUNTIME_STUB_ARGV, runuser: RUNUSER_STUB_ARGV }, (host) => {
        plan(host, 'j');
        assert.deepEqual(argvCalls(host, 'runuser'),
            [['-u', 'appuser', '--', 'podman', 'volume', 'inspect', 'app.data-1']]);
        assert.deepEqual(argvCalls(host, 'podman'), [['volume', 'inspect', 'app.data-1']]);
    });
});

test('a name that would become a second argument is refused, never quoted', () => {
    // `podman stop --all` stops every container on the host and
    // `podman exec --latest` runs the dump inside whichever container started
    // last. Neither is a name; both are what a hostile job file would try.
    const cases = [
        [{ id: 'a', kind: 'container', volumes: ['--format'] }, /unsafe volume name/],
        [{ id: 'b', kind: 'container', volumes: ['v'], containers: ['--all'],
            consistency: 'stop' }, /unsafe container name/],
        [{ id: 'c', kind: 'container', volumes: ['v'], containers: ['--latest'],
            consistency: 'command', command: 'pg_dump' }, /unsafe container name/],
        [{ id: 'd', kind: 'container', volumes: ['v'], containers: ['-l'],
            consistency: 'pause' }, /unsafe container name/],
        [{ id: 'e', kind: 'container', volumes: ['a b'] }, /unsafe volume name/],
        [{ id: 'f', kind: 'container', volumes: ['a;id'] }, /unsafe volume name/],
        [{ id: 'g', kind: 'container', volumes: ['$(id)'] }, /unsafe volume name/],
        [{ id: 'h', kind: 'container', volumes: ['../../etc'] }, /unsafe volume name/],
        [{ id: 'i', kind: 'container', volumes: ['v' + NUL] }, /NUL byte|unsafe volume name/],
        [{ id: 'j', kind: 'container', volumes: ['v'], user: '-u root' },
            /not a valid user name/],
        [{ id: 'k', kind: 'container', volumes: ['v'], user: 'appuser root' },
            /not a valid user name/],
        [{ id: 'l', kind: 'libvirt', domains: ['--all'] }, /unsafe domain name/],
        [{ id: 'm', kind: 'libvirt', domains: ['web;reboot'] }, /unsafe domain name/],
        [{ id: 'n', kind: 'libvirt', domains: ['web' + NUL] }, /NUL byte|unsafe domain name/],
        [{ id: 'o', kind: 'libvirt', domains: ['$(virsh destroy web)'] }, /unsafe domain name/]
    ];
    const jobs = cases.map((c, i) => job({ id: 'evil' + i, sources: [c[0]] }));
    withHost(jobs, null, (host) => {
        cases.forEach((c, i) => {
            const res = refuse(host, 'evil' + i);
            assert.ok(res, 'case ' + i + ' was accepted: ' + JSON.stringify(c[0]));
            assert.equal(res.code, 1, 'case ' + i);
            assert.match(res.stderr, c[1], 'case ' + i);
            assertNoTraceback(res.stderr, 'case ' + i);
        });
    });
});

test('a trailing newline does not slip past the name allowlist', () => {
    // Python's '$' also matches just before a trailing newline, so a '$'-anchored
    // allowlist accepts "assets\n" while the JavaScript editor's identical-looking
    // rule rejects it. The two halves must not disagree about what a legal name
    // is, least of all with the runner being the permissive one.
    const cases = [
        { id: 'a', kind: 'container', volumes: ['assets\n'] },
        { id: 'b', kind: 'container', volumes: ['v'], containers: ['app\n'],
            consistency: 'stop' },
        { id: 'c', kind: 'container', volumes: ['v'], user: 'appuser\n' }
    ];
    const jobs = cases.map((c, i) => job({ id: 'nl' + i, sources: [c] }));
    withHost(jobs, null, (host) => {
        cases.forEach((c, i) => {
            const res = refuse(host, 'nl' + i);
            assert.ok(res, 'a trailing newline was accepted in ' + JSON.stringify(c));
            assert.equal(res.code, 1);
            assertNoTraceback(res.stderr);
        });
    });
    // And the editor agrees, which is the reason it is asserted here.
    assert.ok(Container.validate({ id: 'a', kind: 'container', volumes: ['assets\n'] })
        .some((p) => p.severity === 'error'));
});

test('the dump command is checked for the NUL execve would truncate at', () => {
    const j = job({
        sources: [{ id: 'vols', kind: 'container', volumes: ['v'], containers: ['db'],
            consistency: 'command', command: 'pg_dump app' + NUL + '; curl evil.example' }]
    });
    withHost([j], null, (host) => {
        const res = refuse(host, 'j');
        assert.equal(res.code, 1);
        assert.match(res.stderr, /NUL byte/);
        assertNoTraceback(res.stderr);
    });
});

test('a dump command that is not a string is refused before it reaches argv', () => {
    const j = job({
        sources: [{ id: 'vols', kind: 'container', volumes: ['v'], containers: ['db'],
            consistency: 'command', command: ['pg_dump', 'app'] }]
    });
    withHost([j], null, (host) => {
        const res = refuse(host, 'j');
        assert.equal(res.code, 1);
        assert.match(res.stderr, /shell command string/);
        assertNoTraceback(res.stderr);
    });
});

test('a mount point carrying a NUL is refused rather than handed to restic', () => {
    // The runtime's own JSON is not trusted either: execve stops at the NUL, so
    // restic would receive a shorter path than the one the journal recorded.
    const j = job({ sources: [{ id: 'vols', kind: 'container', volumes: ['bad'] }] });
    withHost([j], { podman: RUNTIME_STUB_NUL_MOUNT }, (host) => {
        const res = refuse(host, 'j');
        assert.equal(res.code, 1);
        assert.match(res.stderr, /no mount point/);
        assertNoTraceback(res.stderr);
    });
});

test('an exclude given as a bare string is refused, not iterated per letter', () => {
    // `for pat in "*.tmp"` yields '*', '.', 't', 'm', 'p' — five excludes, none of
    // them the one that was asked for, and a backup that quietly stores the wrong
    // set of files while reporting success.
    const cases = [
        { id: 'a', kind: 'container', volumes: ['v'], excludes: '*.tmp' },
        { id: 'b', kind: 'container', volumes: ['v'], tags: 'nightly' },
        { id: 'c', kind: 'libvirt', domains: ['web'], excludes: '*.iso' },
        { id: 'd', kind: 'filesystem', paths: ['/etc'], excludes: '*.tmp' }
    ];
    const jobs = cases.map((c, i) => job({ id: 'str' + i, sources: [c] }));
    withHost(jobs, null, (host) => {
        cases.forEach((c, i) => {
            const res = refuse(host, 'str' + i);
            assert.ok(res, 'case ' + i + ' was accepted');
            assert.match(res.stderr, /must be a list of strings/, 'case ' + i);
            assertNoTraceback(res.stderr);
        });
    });
});

test('a NUL in an exclude, a tag, a path or a URI is refused wherever it appears', () => {
    const cases = [
        { id: 'a', kind: 'container', volumes: ['v'], excludes: ['*.tmp' + NUL] },
        { id: 'b', kind: 'container', volumes: ['v'], tags: ['nightly' + NUL] },
        { id: 'c', kind: 'libvirt', domains: ['web'], tags: ['vm' + NUL] },
        { id: 'd', kind: 'filesystem', paths: ['/etc' + NUL] },
        { id: 'e', kind: 'libvirt', domains: ['web'], uri: 'qemu:///system' + NUL }
    ];
    const jobs = cases.map((c, i) => job({ id: 'nul' + i, sources: [c] }));
    withHost(jobs, null, (host) => {
        cases.forEach((c, i) => {
            const res = refuse(host, 'nul' + i);
            assert.ok(res, 'case ' + i + ' was accepted');
            assert.equal(res.code, 1, 'case ' + i);
            assertNoTraceback(res.stderr);
        });
    });
});

test('the editor\'s list-shaped excludeFile becomes one flag per file', () => {
    // core/sources.js normalises excludeFile to a LIST, and that is what the job
    // editor writes. Splicing the list itself into argv is not a path — it is a
    // TypeError inside subprocess, raised from a timer.
    const j = job({
        sources: [{ id: 'files', kind: 'filesystem', paths: ['/srv'],
            excludeFile: ['/etc/hangar/a.txt', '/etc/hangar/b.txt'] }]
    });
    withHost([j], null, (host) => {
        const p = plan(host, 'j');
        assert.deepEqual(p.sources[0].flags, [
            '--exclude-file', '/etc/hangar/a.txt',
            '--exclude-file', '/etc/hangar/b.txt'
        ]);
        p.backup.forEach((a) => assert.equal(typeof a, 'string'));
    });
});

test('every argument of every command in the plan is a plain string', () => {
    // The property the whole section is about, asserted over a job that exercises
    // all three kinds at once.
    const j = job({
        tags: ['nightly'],
        sources: [
            { id: 'files', kind: 'filesystem', paths: ['/etc'], excludeFile: ['/e.txt'] },
            { id: 'vols', kind: 'container', user: 'appuser', volumes: ['pgdata'],
                containers: ['app', 'db'], consistency: 'stop', excludes: ['*.sock'] },
            { id: 'vms', kind: 'libvirt', domains: ['web'], quiesce: 'agent', tags: ['vm'] }
        ]
    });
    withHost([j], null, (host) => {
        const p = plan(host, 'j');
        const vectors = [p.backup, p.forget]
            .concat(p.pre.map((s) => s.argv), p.post.map((s) => s.argv));
        vectors.forEach((argv) => {
            assert.ok(Array.isArray(argv));
            argv.forEach((a) => {
                assert.equal(typeof a, 'string');
                assert.equal(a.indexOf(NUL), -1);
                assert.notEqual(a, '');
            });
        });
    });
});

// ---- the unwind: nothing left paused, stopped, frozen or shut down ---------

test('a frozen guest is thawed even when the backup fails', () => {
    // The container half of this is covered above; the VM half matters more,
    // because a frozen guest is not merely down — its filesystems stay wedged
    // until something thaws them.
    const j = job({
        sources: [{ id: 'vms', kind: 'libvirt', domains: ['web'], quiesce: 'agent' }]
    });
    withHost([j], { restic: RESTIC_STUB_FAILS }, (host) => {
        const res = run(host, 'j');
        assert.equal(res.code, 2, 'a failed backup is still a failed backup');
        const cmds = host.commands();
        assert.ok(cmds.includes('virsh -c qemu:///system domfsthaw web'), cmds.join('\n'));
        assert.ok(cmds.findIndex((c) => c.startsWith('restic')) <
                  cmds.indexOf('virsh -c qemu:///system domfsthaw web'),
        'the thaw must come after restic was given its chance, not instead of it');
        assertNoTraceback(res.stderr);
    });
});

test('a shut-down domain is started again even when the backup fails', () => {
    const j = job({
        sources: [{ id: 'vms', kind: 'libvirt', domains: ['web', 'db'], quiesce: 'shutdown' }]
    });
    withHost([j], { restic: RESTIC_STUB_FAILS }, (host) => {
        const res = run(host, 'j');
        assert.equal(res.code, 2);
        const cmds = host.commands();
        assert.ok(cmds.includes('virsh -c qemu:///system start web'), cmds.join('\n'));
        assert.ok(cmds.includes('virsh -c qemu:///system start db'), cmds.join('\n'));
        assertNoTraceback(res.stderr);
    });
});

test('one post step that fails does not strand the ones queued behind it', () => {
    // An unwind that aborts on its first failure leaves every later container
    // stopped and every later guest frozen — the exact outcome the try/finally
    // exists to prevent, reintroduced one level down.
    const j = job({
        sources: [
            { id: 'vols', kind: 'container', volumes: ['pgdata'],
                containers: ['app', 'db'], consistency: 'stop' },
            { id: 'vms', kind: 'libvirt', domains: ['web', 'db'], quiesce: 'agent',
                includeXml: false }
        ]
    });
    withHost([j], { virsh: VIRSH_STUB_THAW_FAILS, restic: RESTIC_STUB_OK }, (host) => {
        const res = run(host, 'j');
        assert.equal(res.code, 4, 'a host left in a bad state is not a clean run');
        const cmds = host.commands();
        // The thaw of 'web' is the one that fails. Everything after it still ran.
        assert.ok(cmds.includes('virsh -c qemu:///system domfsthaw web'));
        assert.ok(cmds.includes('virsh -c qemu:///system domfsthaw db'), cmds.join('\n'));
        assert.ok(cmds.includes('podman start db'), cmds.join('\n'));
        assert.ok(cmds.includes('podman start app'), cmds.join('\n'));
        assertNoTraceback(res.stderr);
        const state = JSON.parse(fs.readFileSync(path.join(host.dir, 'state', 'j.json'), 'utf8'));
        assert.equal(state.snapshot, 'abc1234');
        assert.equal(state.post_failures, 1);
    });
});

test('a restic that cannot be started is a reported failure, and the unwind still runs', () => {
    // Popen RAISES rather than returning a code when the binary is not there —
    // restic is EPEL-only on RHEL, so "not installed" is a real state a host can
    // be in. Letting that escape would still run the finally, but the operator
    // would get a stack trace instead of a reason.
    const j = job({
        sources: [{ id: 'vols', kind: 'container', volumes: ['pgdata'],
            containers: ['app', 'db'], consistency: 'stop' }]
    });
    // basename is the one external command the stubs use, and emptying PATH
    // takes it away with restic; a two-line shim keeps the log lines identical
    // to every other test's.
    const basenameStub = '#!/bin/sh\necho "${1##*/}"\n';
    withHost([j], { basename: basenameStub }, (host) => {
        // Only the stub directory: the stubs are found, restic is not. python3
        // has to be named absolutely for the same reason.
        host.env.PATH = path.join(host.dir, 'bin');
        host.env.HANGAR_STATE_DIR = path.join(host.dir, 'state');
        const res = spawnSync(PYTHON3, [HELPER, 'j'], { env: host.env, encoding: 'utf8' });
        assert.equal(res.status, 2);
        assertNoTraceback(String(res.stderr || ''));
        assert.ok(journal(String(res.stderr)).some((e) => /could not start restic/.test(e.msg || '')),
            res.stderr);
        const cmds = host.commands();
        assert.ok(cmds.includes('podman start db'), cmds.join('\n'));
        assert.ok(cmds.includes('podman start app'), cmds.join('\n'));
    });
});

test('a post step the runtime refuses is counted rather than fatal', () => {
    const j = job({
        sources: [{ id: 'vols', kind: 'container', volumes: ['pgdata'],
            containers: ['db'], consistency: 'stop' }]
    });
    withHost([j], { podman: RUNTIME_STUB_START_FAILS, restic: RESTIC_STUB_OK }, (host) => {
        const res = runAndLog(host, 'j');
        assert.equal(res.code, 4);
        assertNoTraceback(res.stderr);
        assert.match(res.stderr, /source post-command failed/);
    });
});

test('a later source failing to wind up still unwinds the earlier source', () => {
    // The container source stops its containers, then the libvirt source's freeze
    // fails. Those containers were stopped by a source that succeeded, and they
    // are the ones nobody would think to check.
    const j = job({
        sources: [
            { id: 'vols', kind: 'container', volumes: ['pgdata'],
                containers: ['app', 'db'], consistency: 'stop' },
            { id: 'vms', kind: 'libvirt', domains: ['web'], quiesce: 'agent',
                includeXml: false }
        ]
    });
    withHost([j], { virsh: VIRSH_STUB_FREEZE_FAILS, restic: RESTIC_STUB_OK }, (host) => {
        const res = run(host, 'j');
        assert.equal(res.code, 4);
        assert.match(res.stderr, /source pre-command failed/);
        const cmds = host.commands();
        assert.ok(!cmds.some((c) => c.startsWith('restic')), 'the backup must not have run');
        assert.ok(cmds.includes('podman start db'), cmds.join('\n'));
        assert.ok(cmds.includes('podman start app'), cmds.join('\n'));
        assertNoTraceback(res.stderr);
    });
});

// ---- the consistency warnings have to reach the journal --------------------
//
// The editor shows these at the moment of choosing. The runner has to repeat
// them at the moment of running, because a job is configured once and then runs
// unattended for years — and the journal is the only record anyone will have
// when the restore does not work.

test('a live copy of a running database warns, by name and by code', () => {
    const j = job({
        sources: [{ id: 'vols', kind: 'container', volumes: ['pgdata'],
            containers: ['web', 'app-postgres-1'], consistency: 'none' }]
    });
    withHost([j], null, (host) => {
        const res = planAndLog(host, 'j');
        assert.equal(res.code, 0);
        const warn = res.plan.warnings.filter((w) => w.code === 'live-database');
        assert.equal(warn.length, 1, JSON.stringify(res.plan.warnings));
        assert.equal(warn[0].container, 'app-postgres-1');
        assert.equal(warn[0].match, 'postgres');
        // And it is in the journal, at warning priority, not merely in the plan.
        const logged = journal(res.stderr).filter((e) => e.code === 'live-database');
        assert.equal(logged.length, 1, res.stderr);
        assert.match(res.stderr, /^<4>/m);
        assert.match(logged[0].msg, /may not restore/);
    });
});

test('the same warning reaches the journal of a real run, not only of a dry one', () => {
    const j = job({
        sources: [{ id: 'vols', kind: 'container', volumes: ['pgdata'],
            containers: ['cache-redis'], consistency: 'none' }]
    });
    withHost([j], { restic: RESTIC_STUB_OK }, (host) => {
        const res = runAndLog(host, 'j');
        assert.equal(res.code, 0, res.stderr);
        assert.ok(journal(res.stderr).some((e) => e.code === 'live-database'), res.stderr);
    });
});

test('choosing a safe mode removes the warning rather than muting it', () => {
    ['pause', 'stop'].forEach((mode) => {
        const j = job({
            sources: [{ id: 'vols', kind: 'container', volumes: ['pgdata'],
                containers: ['app-postgres-1'], consistency: mode }]
        });
        withHost([j], null, (host) => {
            assert.deepEqual(
                planAndLog(host, 'j').plan.warnings.filter((w) => w.code === 'live-database'),
                [], mode);
        });
    });
});

test('a podman source with no owner warns that root\'s store is a different store', () => {
    const j = job({ sources: [{ id: 'vols', kind: 'container', volumes: ['assets'] }] });
    withHost([j], null, (host) => {
        const codes = planAndLog(host, 'j').plan.warnings.map((w) => w.code);
        assert.ok(codes.includes('no-user'), codes.join(','));
    });
    const docker = job({
        id: 'd',
        sources: [{ id: 'vols', kind: 'container', runtime: 'docker', volumes: ['assets'] }]
    });
    withHost([docker], null, (host) => {
        // docker's daemon is system-wide, so there is no per-user store to miss.
        assert.deepEqual(planAndLog(host, 'd').plan.warnings, []);
    });
});

test('every libvirt consistency choice that costs something says so', () => {
    const cases = [
        [{ quiesce: 'none', includeXml: true }, ['quiesce-crash-consistent']],
        [{ quiesce: 'agent', includeXml: true }, ['quiesce-agent-required']],
        [{ quiesce: 'shutdown', includeXml: true }, []],
        [{ quiesce: 'shutdown', includeXml: false }, ['no-xml']],
        [{ quiesce: 'none', includeXml: false }, ['quiesce-crash-consistent', 'no-xml']]
    ];
    const jobs = cases.map((c, i) => job({
        id: 'q' + i,
        sources: [Object.assign({ id: 'vms', kind: 'libvirt', domains: ['web'] }, c[0])]
    }));
    withHost(jobs, null, (host) => {
        cases.forEach((c, i) => {
            const res = planAndLog(host, 'q' + i);
            assert.equal(res.code, 0, res.stderr);
            assert.deepEqual(res.plan.warnings.map((w) => w.code), c[1], JSON.stringify(c[0]));
            c[1].forEach((code) => {
                assert.ok(journal(res.stderr).some((e) => e.code === code),
                    code + ' never reached the journal:\n' + res.stderr);
            });
        });
    });
});

test('a warning is a warning: it never stops the backup being planned or run', () => {
    const j = job({
        sources: [{ id: 'vms', kind: 'libvirt', domains: ['web'], quiesce: 'none',
            includeXml: false }]
    });
    withHost([j], { restic: RESTIC_STUB_OK }, (host) => {
        const res = runAndLog(host, 'j');
        assert.equal(res.code, 0, res.stderr);
        assert.ok(journal(res.stderr).some((e) => e.code === 'quiesce-crash-consistent'));
        const state = JSON.parse(fs.readFileSync(path.join(host.dir, 'state', 'j.json'), 'utf8'));
        assert.equal(state.status, 'ok');
    });
});

test('the runner warns with the codes js/core reports, not a second dialect', () => {
    // The operator reading the journal and the user reading the editor have to be
    // looking at the same vocabulary; two spellings of one warning are two
    // warnings as far as anyone searching is concerned.
    const container = {
        id: 'vols', kind: 'container', volumes: ['pgdata'],
        containers: ['app-mongo-1'], consistency: 'none'
    };
    const libvirt = {
        id: 'vms', kind: 'libvirt', domains: ['web'], quiesce: 'agent', includeXml: false
    };
    withHost([job({ id: 'c', sources: [container] }), job({ id: 'v', sources: [libvirt] })],
        null, (host) => {
            const jsCodes = (impl, s) => impl.validate(s)
                .filter((p) => p.severity === 'warning').map((p) => p.code).sort();
            assert.deepEqual(planAndLog(host, 'c').plan.warnings.map((w) => w.code).sort(),
                jsCodes(Container, container));
            assert.deepEqual(planAndLog(host, 'v').plan.warnings.map((w) => w.code).sort(),
                jsCodes(Libvirt, libvirt));
        });
});

test('the database hint table is the same table on both sides', () => {
    // A hint the runner does not know is a database the journal never warns
    // about. Asserted through behaviour rather than by reading the constant, so
    // it stays true however either side chooses to spell the table.
    const jobs = Container.DATABASE_HINTS.map((hint, i) => job({
        id: 'h' + i,
        sources: [{ id: 'vols', kind: 'container', volumes: ['v'],
            containers: ['svc-' + hint + '-1'], consistency: 'none' }]
    }));
    withHost(jobs, null, (host) => {
        Container.DATABASE_HINTS.forEach((hint, i) => {
            const live = planAndLog(host, 'h' + i).plan.warnings
                .filter((w) => w.code === 'live-database');
            assert.equal(live.length, 1, hint + ' produced no warning');
            assert.equal(live[0].match, hint);
        });
    });
});

// ---- no hostile job file produces a traceback ------------------------------

test('no shape of junk in a job file makes the helper crash instead of refusing', () => {
    // The product of every field the three kinds read and every shape that is not
    // what they expect. Exit 0 and exit 1 are both acceptable answers; a stack
    // trace is not, because it says hangar is broken rather than that the
    // configuration is.
    const junk = [null, 0, true, '', 'x', [], {}, [null], [7], NUL, '-x'];
    const kinds = [
        [{ kind: 'filesystem', paths: ['/etc'] },
            ['paths', 'excludes', 'excludeFile', 'tags']],
        [{ kind: 'container', volumes: ['v'], containers: ['db'], consistency: 'stop' },
            ['id', 'runtime', 'user', 'volumes', 'containers', 'consistency', 'command',
                'excludes', 'tags']],
        [{ kind: 'libvirt', domains: ['web'] },
            ['uri', 'domains', 'quiesce', 'includeXml', 'excludes', 'tags']]
    ];

    const jobs = [];
    const labels = [];
    kinds.forEach(([base, fields], k) => {
        fields.forEach((field, f) => {
            junk.forEach((value, v) => {
                const id = ['junk', k, f, v].join('-');
                const source = Object.assign({ id: 'src' }, base);
                source[field] = value;
                jobs.push(job({ id, sources: [source] }));
                labels.push([id, base.kind + '.' + field + ' = ' + JSON.stringify(value)]);
            });
        });
    });

    withHost(jobs, null, (host) => {
        labels.forEach(([id, label]) => {
            const res = spawnSync('python3', [HELPER, id, '--print-plan'],
                { env: host.env, encoding: 'utf8' });
            assertNoTraceback(String(res.stderr || ''), label);
            assert.ok(res.status === 0 || res.status === 1,
                label + ' exited ' + res.status + ':\n' + res.stderr);
        });
    });
});

test('a job or repository that is not what it claims is refused without a traceback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-src-'));
    try {
        fs.mkdirSync(path.join(dir, 'repos'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
        const files = {
            'repos/main.json': JSON.stringify(LOCAL_REPO),
            // A local repository with no path at all: repo_url would otherwise
            // raise KeyError from inside the plan builder.
            'repos/thin.json': JSON.stringify({ kind: 'local' }),
            'repos/listy.json': '["not", "an", "object"]',
            'jobs/listy.json': '[1,2,3]',
            'jobs/badrepo.json': JSON.stringify({ id: 'badrepo', repo: 'listy', sources: [] }),
            // A repo id that would walk out of /etc/hangar/repos and parse
            // whatever it landed on.
            'jobs/escape.json': JSON.stringify({ id: 'escape', repo: '../../etc/shadow',
                sources: [] }),
            'jobs/noret.json': JSON.stringify({ id: 'noret', repo: 'main', retention: 'daily',
                sources: [{ id: 's', kind: 'filesystem', paths: ['/etc'] }] }),
            'jobs/thinrepo.json': JSON.stringify({ id: 'thinrepo', repo: 'thin',
                sources: [{ id: 's', kind: 'filesystem', paths: ['/etc'] }] })
        };
        Object.keys(files).forEach((rel) => fs.writeFileSync(path.join(dir, rel), files[rel]));

        const env = Object.assign({}, process.env, {
            HANGAR_CONF_DIR: dir, CREDENTIALS_DIRECTORY: ''
        });
        ['listy', 'badrepo', 'escape', 'noret', 'thinrepo'].forEach((id) => {
            const res = spawnSync('python3', [HELPER, id, '--print-plan'],
                { env, encoding: 'utf8' });
            assert.equal(res.status, 1, id + ':\n' + res.stderr);
            assertNoTraceback(String(res.stderr || ''), id);
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a repository definition cannot smuggle a bad argument into the restic command', () => {
    // The repository is the one part of the plan that no name allowlist covers:
    // its URL is assembled from free-form fields and lands as a positional value
    // of -r. A NUL there truncates the repository path execve actually sees, and
    // a non-string cannot be handed to subprocess at all.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-src-'));
    try {
        fs.mkdirSync(path.join(dir, 'repos'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
        const sources = [{ id: 's', kind: 'filesystem', paths: ['/etc'] }];
        const repos = {
            nulpath: { id: 'nulpath', kind: 'local', path: '/srv/back' + NUL + 'up' },
            numpath: { id: 'numpath', kind: 'local', path: 12345 },
            nulhost: { id: 'nulhost', kind: 'sftp', user: 'bak',
                host: 'nas.lan' + NUL, path: '/vol/b' }
        };
        Object.keys(repos).forEach((id) => {
            fs.writeFileSync(path.join(dir, 'repos', id + '.json'), JSON.stringify(repos[id]));
            fs.writeFileSync(path.join(dir, 'jobs', id + '.json'),
                JSON.stringify({ id, repo: id, sources }));
        });
        const env = Object.assign({}, process.env,
            { HANGAR_CONF_DIR: dir, CREDENTIALS_DIRECTORY: '' });
        Object.keys(repos).forEach((id) => {
            const res = spawnSync('python3', [HELPER, id, '--print-plan'],
                { env, encoding: 'utf8' });
            assert.equal(res.status, 1, id + ':\n' + res.stderr);
            assert.match(String(res.stderr), /NUL byte|not a string|incomplete/, id);
            assertNoTraceback(String(res.stderr || ''), id);
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a job id that is not a plain identifier cannot reach outside the config dir', () => {
    const j = job({ sources: [{ id: 's', kind: 'filesystem', paths: ['/etc'] }] });
    withHost([j], null, (host) => {
        ['../../etc/passwd', '/etc/passwd', 'a/b', '.', '..', ''].forEach((id) => {
            const res = spawnSync('python3', [HELPER, id, '--print-plan'],
                { env: host.env, encoding: 'utf8' });
            assert.equal(res.status, 1, JSON.stringify(id));
            assertNoTraceback(String(res.stderr || ''), JSON.stringify(id));
        });
    });
});
