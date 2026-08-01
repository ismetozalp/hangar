// Integration tests for the libvirt source against a REAL libvirt.
//
// Unit tests parse virsh output we wrote ourselves, which only ever proves the
// parser agrees with our own idea of the format. This file defines an actual domain
// and parses what virsh actually prints.
//
// It uses qemu:///session — the per-user hypervisor — deliberately:
//   * it needs no root and no polkit, so it runs in CI and on a workstation alike;
//   * it cannot touch the system hypervisor or anybody's real virtual machines.
//
// The domain is defined but NEVER STARTED. Every call under test (list, domblklist,
// dumpxml) works on a defined domain, and starting one would need KVM access and
// leave a running guest behind.
//
// Everything is torn down in finally, including on failure.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const L = require('../../js/core/sources-libvirt.js');

const URI = 'qemu:///session';
// Unique enough that a crashed earlier run cannot collide with this one.
const DOMAIN = 'hangar-selftest-' + process.pid;

function virsh(args, opts) {
    return spawnSync('virsh', ['-c', URI].concat(args),
        Object.assign({ encoding: 'utf8', timeout: 30000 }, opts || {}));
}

function have(cmd) {
    return spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0;
}

// qemu:///session can be present but unusable (no qemu binary for the arch, a
// wedged libvirtd). Probe once and skip the whole file rather than fail on the
// user's behalf.
function sessionUsable() {
    if (!have('virsh') || !have('qemu-img')) return false;
    const r = virsh(['list', '--all', '--name']);
    return r.status === 0;
}

const USABLE = sessionUsable();
const skip = USABLE ? false : 'qemu:///session is not usable on this host';

let dir = null;
let defined = false;

test.before(() => {
    if (!USABLE) return;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-libvirt-'));
    const a = path.join(dir, 'disk-a.qcow2');
    const b = path.join(dir, 'disk-b.qcow2');
    for (const f of [a, b]) {
        const r = spawnSync('qemu-img', ['create', '-f', 'qcow2', f, '16M'], { encoding: 'utf8' });
        assert.equal(r.status, 0, `qemu-img failed: ${r.stderr}`);
    }

    // Two disks plus an EMPTY CDROM. The empty drive is the whole point: virsh
    // reports its source as "-", and backing that up as a path would fail the run.
    const xml = `<domain type='qemu'>
  <name>${DOMAIN}</name>
  <memory unit='MiB'>128</memory>
  <vcpu>1</vcpu>
  <os><type arch='x86_64'>hvm</type></os>
  <devices>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/><source file='${a}'/>
      <target dev='vda' bus='virtio'/>
    </disk>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/><source file='${b}'/>
      <target dev='vdb' bus='virtio'/>
    </disk>
    <disk type='file' device='cdrom'>
      <driver name='qemu' type='raw'/>
      <target dev='sda' bus='sata'/><readonly/>
    </disk>
  </devices>
</domain>`;
    const xmlPath = path.join(dir, 'domain.xml');
    fs.writeFileSync(xmlPath, xml);

    const r = virsh(['define', xmlPath]);
    assert.equal(r.status, 0, `virsh define failed: ${r.stderr || r.stdout}`);
    defined = true;
});

test.after(() => {
    // Never leave a defined domain behind, even if an assertion threw.
    if (defined) virsh(['undefine', DOMAIN]);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

// --- discovery -----------------------------------------------------------

test('the argv we build really lists domains', { skip }, () => {
    const argv = L.listDomainsArgv(URI);
    assert.equal(argv[0], 'virsh');
    const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, `our own argv failed: ${r.stderr}`);
    assert.ok(L.parseDomainNames(r.stdout).includes(DOMAIN),
        `defined domain not listed: ${JSON.stringify(r.stdout)}`);
});

test('parseDomainNames reproduces virsh exactly', { skip }, () => {
    const raw = virsh(['list', '--all', '--name']).stdout;
    const ours = L.parseDomainNames(raw).sort();
    // virsh separates names with blank lines; the parser must drop them without
    // dropping a real name.
    const theirs = raw.split('\n').map((s) => s.trim()).filter(Boolean).sort();
    assert.deepEqual(ours, theirs);
});

// --- the disk list, which is where the real formatting risk lives ---------

test('parseBlkList parses real virsh output', { skip }, () => {
    const argv = L.blkListArgv(URI, DOMAIN);
    const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, `domblklist failed: ${r.stderr}`);

    const parsed = L.parseBlkList(r.stdout);
    assert.equal(parsed.length, 2, `expected 2 backed disks, got ${JSON.stringify(parsed)}`);
    assert.deepEqual(parsed.map((d) => d.target).sort(), ['vda', 'vdb']);
    for (const d of parsed) {
        assert.equal(d.device, 'disk');
        assert.equal(d.type, 'file');
        assert.ok(path.isAbsolute(d.source), `not an absolute path: ${d.source}`);
    }
});

test('an empty CDROM is dropped rather than backed up as a path', { skip }, () => {
    // virsh prints the source as "-" for a drive with no medium. Passing that to
    // restic would either fail the run or, worse, back up a file called "-".
    const raw = virsh(['domblklist', '--details', DOMAIN]).stdout;
    assert.match(raw, /cdrom/, 'the fixture domain lost its cdrom — the test is not testing anything');
    assert.match(raw, /\s-\s*$/m, 'virsh no longer prints "-" for an empty drive');

    const parsed = L.parseBlkList(raw);
    assert.ok(!parsed.some((d) => d.device === 'cdrom'), 'a cdrom survived parsing');
    assert.ok(!parsed.some((d) => d.source === '-'), 'a "-" source survived parsing');
});

test('diskPathsFor yields paths that really exist on disk', { skip }, () => {
    const raw = virsh(['domblklist', '--details', DOMAIN]).stdout;
    const paths = L.diskPathsFor(L.parseBlkList(raw));
    assert.equal(paths.length, 2);
    for (const p of paths) {
        assert.ok(fs.existsSync(p), `path does not exist: ${p}`);
        assert.ok(fs.statSync(p).size > 0, `empty disk image: ${p}`);
    }
});

// --- the domain XML, without which a disk image is not a restorable VM ----

test('the domain XML really dumps and names the domain', { skip }, () => {
    const argv = L.dumpXmlArgv(URI, DOMAIN);
    const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, `dumpxml failed: ${r.stderr}`);
    assert.match(r.stdout, /<domain/);
    assert.ok(r.stdout.includes(DOMAIN), 'the dumped XML does not name the domain');
    // Without the disk definitions the XML would not reconstruct the VM.
    assert.match(r.stdout, /<disk\b/);
});

// --- end to end ----------------------------------------------------------

test('resolve turns a real domain into the paths restic will be given', { skip }, async () => {
    // The whole chain, against a real hypervisor: name -> disks -> restic argv.
    const raw = virsh(['domblklist', '--details', DOMAIN]).stdout;
    const source = {
        id: 'vms', kind: 'libvirt', uri: URI, domains: [DOMAIN],
        quiesce: 'none', includeXml: true,
        resolvedPaths: L.diskPathsFor(L.parseBlkList(raw))
    };

    const args = L.toResticArgs(source);
    for (const p of source.resolvedPaths) {
        assert.ok(args.includes(p), `restic args missing a real disk: ${p}`);
    }
    // includeXml is on, so the staged XML path must be handed to restic too —
    // a disk image without its domain XML is not a restorable VM.
    assert.ok(args.some((a) => a.includes(DOMAIN) && a.endsWith('.xml')),
        `no domain XML in the restic args: ${JSON.stringify(args)}`);
});

test('quiesce "none" warns that the copy is crash-consistent at best', { skip }, () => {
    const problems = L.validate({
        id: 'vms', kind: 'libvirt', uri: URI, domains: [DOMAIN], quiesce: 'none'
    });
    const warned = problems.some((p) => /crash|consistent/i.test(p.message || ''));
    assert.ok(warned, `no consistency warning: ${JSON.stringify(problems)}`);
});

test('the system URI is left completely alone by this file', { skip }, () => {
    // Guard against a future edit pointing these destructive-capable calls at the
    // real hypervisor. Nothing here may touch qemu:///system.
    assert.equal(URI, 'qemu:///session');
    assert.ok(!L.isSessionUri || L.isSessionUri(URI) !== false);
});
