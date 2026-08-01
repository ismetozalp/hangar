// tests/unit/sources-libvirt.test.js — HangarSourcesLibvirt: the 'libvirt'
// source kind. Argv construction, virsh output parsing, validation, restic
// arguments, pre/post commands, and the guarded I/O layer.
//
// The domblklist samples below are REAL output, captured on this host from
// libvirt 11.10.0 by defining a throwaway domain under qemu:///session with a
// file disk, a block disk, an empty CD-ROM and a CD-ROM holding an ISO, running
// `virsh domblklist --details`, and undefining it again. Column widths, the
// leading space on every row and the trailing blank line are as emitted.
//
// Nothing here needs a working hypervisor: qemu:///system times out on this
// host, which is precisely why the I/O layer is tested through a fake cockpit.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const L = require('../../js/core/sources-libvirt.js');
const Sources = require('../../js/core/sources.js');
const Errors = require('../../js/core/errors.js');

const NUL = '\u0000';
const MODULE_PATH = path.join(__dirname, '../../js/core/sources-libvirt.js');

// Captured verbatim from `virsh -c qemu:///session domblklist --details hangar-probe`.
const BLKLIST_REAL = [
    ' Type    Device   Target   Source',
    '----------------------------------------------------------------',
    ' file    disk     vda      /tmp/hangar probe/disk one.qcow2',
    ' block   disk     vdb      /dev/vg0/data',
    ' file    cdrom    sda      -',
    ' file    cdrom    sdb      /var/lib/libvirt/images/install.iso',
    ''
].join('\n');

// Captured verbatim from `virsh -c qemu:///session list --all --name` with one
// defined domain: the name, then the blank line virsh always prints.
const LIST_REAL = 'hangar-probe\n\n';

function src(over) {
    return Object.assign({ id: 'vms', kind: 'libvirt', domains: ['web'] }, over || {});
}

function codes(problems) { return problems.map((p) => p.code); }
function errorCodes(problems) { return codes(problems.filter((p) => p.severity === 'error')); }
function warningCodes(problems) { return codes(problems.filter((p) => p.severity === 'warning')); }

function withCockpit(fake, fn) {
    globalThis.cockpit = fake;
    return Promise.resolve().then(fn).finally(() => { delete globalThis.cockpit; });
}

// ---- registration and module contract --------------------------------------

test('the module registers itself as the libvirt kind on HangarSources', () => {
    assert.ok(Sources.kinds().includes('libvirt'));
    assert.equal(typeof Sources.KINDS.libvirt.toResticArgs, 'function');
    assert.equal(typeof Sources.KINDS.libvirt.normalize, 'function');
});

test('a libvirt source flows through the shared HangarSources entry points', () => {
    const s = src({ resolvedPaths: ['/srv/vm/web.qcow2'] });
    assert.deepEqual(errorCodes(Sources.validate(s)), []);
    assert.equal(Sources.isValid(s), true);
    assert.deepEqual(Sources.toResticArgs(s),
        ['/srv/vm/web.qcow2', '/var/lib/hangar/libvirt/web.xml']);
    assert.equal(Sources.describe(s), L.describe(s));
    assert.deepEqual(Sources.normalize(s), L.normalize(s));
});

test('the codes shared with the filesystem kind are spelled identically', () => {
    // The UI keys remediation off the code, so a libvirt tag problem and a
    // filesystem tag problem must be the same code, not two dialects.
    ['BAD_ID', 'PATTERN_TYPE', 'PATTERN_EMPTY', 'PATTERN_NUL',
        'TAG_TYPE', 'TAG_EMPTY', 'TAG_COMMA', 'TAG_NUL'].forEach((k) => {
        assert.equal(L.PROBLEM[k], Sources.PROBLEM[k], k);
    });
    assert.deepEqual(L.SEVERITY, Sources.SEVERITY);
});

test('every PROBLEM code is a distinct kebab-case string', () => {
    const values = Object.keys(L.PROBLEM).map((k) => L.PROBLEM[k]);
    assert.equal(new Set(values).size, values.length);
    values.forEach((v) => assert.match(v, /^[a-z]+(-[a-z]+)*$/));
});

test('the module obeys the house pattern: no ES modules, dual export, guarded cockpit', () => {
    const text = fs.readFileSync(MODULE_PATH, 'utf8');
    assert.ok(!/^\s*(import|export)\s/m.test(text), 'no import/export keywords');
    assert.ok(text.includes('root.HangarSourcesLibvirt = HangarSourcesLibvirt'));
    assert.ok(text.includes('module.exports = HangarSourcesLibvirt'));
    assert.ok(text.includes("typeof cockpit !== 'undefined'"));
    assert.ok(!/time\s*machine/i.test(text), 'the feature is named Logbook');
    assert.equal(text.indexOf(NUL), -1, 'a literal NUL in source would be a footgun');
});

test('the pure half of the module never mentions cockpit', () => {
    const text = fs.readFileSync(MODULE_PATH, 'utf8');
    const marker = text.indexOf('// ---- thin I/O layer');
    assert.ok(marker > 0, 'the I/O layer is marked off');
    const pure = text.slice(0, marker).replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/\bcockpit\b/.test(pure), false);
});

// ---- the URI and quiesce tables --------------------------------------------

test('URIS offers the system and session connections with labels', () => {
    assert.deepEqual(L.URIS.map((u) => u.id), ['qemu:///system', 'qemu:///session']);
    L.URIS.forEach((u) => {
        assert.equal(typeof u.label, 'string');
        assert.ok(u.label.includes(u.id));
        assert.ok(u.description.length > 0);
    });
    assert.equal(L.DEFAULT_URI, 'qemu:///system');
});

test('QUIESCE lists the three modes and marks the one needing a guest agent', () => {
    assert.deepEqual(L.QUIESCE.map((m) => m.id), ['none', 'agent', 'shutdown']);
    assert.deepEqual(L.QUIESCE.map((m) => m.requiresGuestAgent), [false, true, false]);
    L.QUIESCE.forEach((m) => {
        assert.equal(typeof m.label, 'string');
        assert.ok(m.description.length > 0);
    });
});

test('QUIESCE states the cost of each mode plainly', () => {
    assert.match(L.quiesceMode('none').description, /crash-consistent at best/);
    assert.match(L.quiesceMode('agent').description, /qemu-guest-agent/);
    assert.match(L.quiesceMode('shutdown').description, /downtime/);
    assert.equal(L.DEFAULT_QUIESCE, 'none');
});

test('quiesceMode and isKnownQuiesce reject anything not in the table', () => {
    assert.equal(L.quiesceMode('agent').id, 'agent');
    [null, undefined, '', 'AGENT', 'freeze', 42, {}, 'constructor', '__proto__', 'toString']
        .forEach((v) => {
            assert.equal(L.quiesceMode(v), null, String(v));
            assert.equal(L.isKnownQuiesce(v), false, String(v));
        });
});

test('isSessionUri recognises a per-user connection and nothing else', () => {
    assert.equal(L.isSessionUri('qemu:///session'), true);
    assert.equal(L.isSessionUri('test:///session'), true);
    ['qemu:///system', 'qemu+ssh://host/session', 'qemu:///session/', '', null, 42,
        'qemu:///SESSION'].forEach((u) => {
        assert.equal(L.isSessionUri(u), false, String(u));
    });
});

test('uriOf falls back to the system connection', () => {
    assert.equal(L.uriOf({ uri: 'qemu:///session' }), 'qemu:///session');
    [{}, null, { uri: '' }, { uri: 42 }].forEach((s) => assert.equal(L.uriOf(s), L.DEFAULT_URI));
});

// ---- argv construction ------------------------------------------------------

test('virshArgv puts the connection first and the caller args after', () => {
    assert.deepEqual(L.virshArgv('qemu:///session', ['list', '--all']),
        ['virsh', '-c', 'qemu:///session', 'list', '--all']);
});

test('virshArgv defaults an empty or non-string uri rather than emitting a hole', () => {
    // A missing element in argv would shift every later argument by one.
    ['', null, undefined, 42, {}].forEach((u) => {
        assert.deepEqual(L.virshArgv(u, ['list']), ['virsh', '-c', L.DEFAULT_URI, 'list']);
    });
});

test('virshArgv drops non-string args and tolerates a non-array tail', () => {
    assert.deepEqual(L.virshArgv('qemu:///system', ['a', null, 7, 'b']),
        ['virsh', '-c', 'qemu:///system', 'a', 'b']);
    assert.deepEqual(L.virshArgv('qemu:///system', 'list'),
        ['virsh', '-c', 'qemu:///system', 'list']);
    assert.deepEqual(L.virshArgv('qemu:///system'), ['virsh', '-c', 'qemu:///system']);
});

test('listDomainsArgv asks for names only, including inactive domains', () => {
    assert.deepEqual(L.listDomainsArgv('qemu:///system'),
        ['virsh', '-c', 'qemu:///system', 'list', '--all', '--name']);
});

test('blkListArgv asks domblklist for the detailed columns', () => {
    assert.deepEqual(L.blkListArgv('qemu:///system', 'web'),
        ['virsh', '-c', 'qemu:///system', 'domblklist', '--details', 'web']);
});

test('dumpXmlArgv, freezeArgv, thawArgv, shutdownArgv and startArgv name one domain each', () => {
    const u = 'qemu:///session';
    assert.deepEqual(L.dumpXmlArgv(u, 'web'), ['virsh', '-c', u, 'dumpxml', 'web']);
    assert.deepEqual(L.freezeArgv(u, 'web'), ['virsh', '-c', u, 'domfsfreeze', 'web']);
    assert.deepEqual(L.thawArgv(u, 'web'), ['virsh', '-c', u, 'domfsthaw', 'web']);
    assert.deepEqual(L.shutdownArgv(u, 'web'), ['virsh', '-c', u, 'shutdown', 'web']);
    assert.deepEqual(L.startArgv(u, 'web'), ['virsh', '-c', u, 'start', 'web']);
});

test('every argv builder is deterministic and emits only non-empty strings', () => {
    const builders = [L.listDomainsArgv, L.dumpXmlArgv, L.blkListArgv,
        L.freezeArgv, L.thawArgv, L.shutdownArgv, L.startArgv];
    builders.forEach((fn) => {
        const a = fn('qemu:///system', 'web');
        const b = fn('qemu:///system', 'web');
        assert.deepEqual(a, b);
        a.forEach((arg) => {
            assert.equal(typeof arg, 'string');
            assert.notEqual(arg, '');
        });
    });
});

// ---- parseDomainNames -------------------------------------------------------

test('parseDomainNames reads the real `list --all --name` output', () => {
    assert.deepEqual(L.parseDomainNames(LIST_REAL), ['hangar-probe']);
});

test('parseDomainNames returns nothing for a host with no domains', () => {
    // qemu:///session on this host: virsh prints a single blank line.
    assert.deepEqual(L.parseDomainNames('\n'), []);
    assert.deepEqual(L.parseDomainNames(''), []);
    assert.deepEqual(L.parseDomainNames('   \n\t\n'), []);
});

test('parseDomainNames tolerates CRLF line endings', () => {
    assert.deepEqual(L.parseDomainNames('web\r\nbuilder\r\n\r\n'), ['web', 'builder']);
});

test('parseDomainNames drops leading and trailing blank lines but keeps order', () => {
    assert.deepEqual(L.parseDomainNames('\n\nweb\nbuilder\ndb\n\n\n'), ['web', 'builder', 'db']);
});

test('parseDomainNames trims the row padding without touching interior spaces', () => {
    assert.deepEqual(L.parseDomainNames('  web server  \n  db  \n'), ['web server', 'db']);
});

test('parseDomainNames keeps unicode names verbatim', () => {
    assert.deepEqual(L.parseDomainNames('yedek-sunucu\nвеб\n日本\n'), ['yedek-sunucu', 'веб', '日本']);
});

test('parseDomainNames tolerates junk instead of text', () => {
    [null, undefined, 42, {}, []].forEach((v) => assert.deepEqual(L.parseDomainNames(v), []));
});

// ---- parseBlkList -----------------------------------------------------------

test('parseBlkList reads the real domblklist --details output', () => {
    assert.deepEqual(L.parseBlkList(BLKLIST_REAL), [
        { target: 'vda', source: '/tmp/hangar probe/disk one.qcow2', type: 'file', device: 'disk' },
        { target: 'vdb', source: '/dev/vg0/data', type: 'block', device: 'disk' }
    ]);
});

test('parseBlkList skips an empty drive, whose source virsh prints as "-"', () => {
    // An empty CD-ROM has no file; backing up "-" would fail the whole run.
    const rows = L.parseBlkList(BLKLIST_REAL);
    assert.equal(rows.some((r) => r.source === '-'), false);
    assert.equal(rows.some((r) => r.target === 'sda'), false);
});

test('parseBlkList skips a CD-ROM even when it holds an ISO', () => {
    // Installation media is not VM state, and the ISO is routinely deleted after
    // the guest was installed — restic would then fail on a missing path.
    const rows = L.parseBlkList(BLKLIST_REAL);
    assert.equal(rows.some((r) => r.device === 'cdrom'), false);
    assert.equal(rows.some((r) => /install\.iso/.test(r.source)), false);
});

test('parseBlkList preserves a source path containing spaces', () => {
    assert.equal(L.parseBlkList(BLKLIST_REAL)[0].source, '/tmp/hangar probe/disk one.qcow2');
});

test('parseBlkList keeps a block-backed disk, which is not under any image directory', () => {
    const row = L.parseBlkList(BLKLIST_REAL)[1];
    assert.equal(row.type, 'block');
    assert.equal(row.source, '/dev/vg0/data');
});

test('parseBlkList drops the header row and the dashed rule', () => {
    const rows = L.parseBlkList(BLKLIST_REAL);
    assert.equal(rows.some((r) => r.target === 'Target' || r.type === 'Type'), false);
    assert.equal(rows.length, 2);
});

test('parseBlkList drops a dashed rule of any length', () => {
    ['---', '-'.repeat(200), ' ------ ', '--- ---'].forEach((rule) => {
        const text = ' Type   Device   Target   Source\n' + rule +
            '\n file   disk     vda      /srv/a.qcow2\n';
        assert.deepEqual(L.parseBlkList(text).map((r) => r.target), ['vda'], rule);
    });
});

test('parseBlkList reads the older unindented printf layout too', () => {
    // libvirt before the vshTable rewrite printed rows without the leading space.
    const text = [
        'Type       Device     Target     Source',
        '------------------------------------------------',
        'file       disk       vda        /var/lib/libvirt/images/old.qcow2',
        'file       cdrom      hdc        -',
        ''
    ].join('\n');
    assert.deepEqual(L.parseBlkList(text),
        [{ target: 'vda', source: '/var/lib/libvirt/images/old.qcow2', type: 'file', device: 'disk' }]);
});

test('parseBlkList tolerates CRLF line endings', () => {
    assert.deepEqual(L.parseBlkList(BLKLIST_REAL.split('\n').join('\r\n')).map((r) => r.target),
        ['vda', 'vdb']);
});

test('parseBlkList trims trailing whitespace from the source column', () => {
    const text = ' Type   Device   Target   Source\n---\n file   disk     vda      /srv/a.qcow2   \n';
    assert.equal(L.parseBlkList(text)[0].source, '/srv/a.qcow2');
});

test('parseBlkList keeps a network disk verbatim rather than guessing at it', () => {
    const text = ' Type      Device   Target   Source\n---\n' +
        ' network   disk     vda      rbd:pool/img\n';
    assert.deepEqual(L.parseBlkList(text),
        [{ target: 'vda', source: 'rbd:pool/img', type: 'network', device: 'disk' }]);
});

test('parseBlkList skips an empty floppy and an empty LUN by the "-" rule', () => {
    const text = ' Type   Device   Target   Source\n---\n' +
        ' file   floppy   fda      -\n block  lun      sdc      -\n' +
        ' file   disk     vda      /srv/a.qcow2\n';
    assert.deepEqual(L.parseBlkList(text).map((r) => r.target), ['vda']);
});

test('parseBlkList matches the cdrom device case-insensitively', () => {
    const text = ' Type   Device   Target   Source\n---\n' +
        ' file   CDROM    sda      /srv/x.iso\n file   Disk     vda      /srv/a.qcow2\n';
    assert.deepEqual(L.parseBlkList(text).map((r) => r.target), ['vda']);
    assert.equal(L.parseBlkList(text)[0].device, 'Disk');   // reported as libvirt spelled it
});

test('parseBlkList ignores a domblklist run without --details', () => {
    // Two columns cannot say whether a row is a disk or a CD-ROM, so parsing it
    // as a disk list would silently back up ISO paths.
    const text = ' Target   Source\n-------------------\n vda      /srv/a.qcow2\n sda      -\n';
    assert.deepEqual(L.parseBlkList(text), []);
});

test('parseBlkList returns nothing for empty, blank or non-text input', () => {
    ['', '\n\n', '   \n \t \n', null, undefined, 42, {}, []].forEach((v) => {
        assert.deepEqual(L.parseBlkList(v), [], JSON.stringify(v));
    });
});

test('parseBlkList skips an error line virsh printed onto the same stream', () => {
    // Captured from `virsh domblklist --details nosuch`. Four whitespace-separated
    // words is exactly a row's shape, so only the source column tells them apart.
    const text = "error: failed to get domain 'nosuch'\n";
    assert.deepEqual(L.parseBlkList(text), []);
});

test('parseBlkList skips a source that is neither an absolute path nor a scheme', () => {
    // restic resolves a relative path against the unit's cwd, which is not where
    // libvirt meant it — backing that up would silently store the wrong tree.
    const text = ' Type   Device   Target   Source\n---\n' +
        ' file   disk     vda      relative.qcow2\n' +
        ' file   disk     vdb      -unexpected\n' +
        ' file   disk     vdc      /srv/real.qcow2\n';
    assert.deepEqual(L.parseBlkList(text).map((r) => r.target), ['vdc']);
});

test('parseBlkList reports exactly the four documented fields', () => {
    L.parseBlkList(BLKLIST_REAL).forEach((row) => {
        assert.deepEqual(Object.keys(row).sort(), ['device', 'source', 'target', 'type']);
    });
});

test('parseBlkList handles a domain with many disks in listed order', () => {
    const rows = [];
    for (let i = 0; i < 12; i++) rows.push(' file   disk     vd' + i + '      /srv/d' + i + '.qcow2');
    const text = ' Type   Device   Target   Source\n---\n' + rows.join('\n') + '\n';
    assert.equal(L.parseBlkList(text).length, 12);
    assert.equal(L.parseBlkList(text)[11].source, '/srv/d11.qcow2');
});

// ---- diskPathsFor -----------------------------------------------------------

test('diskPathsFor returns the backing files in order', () => {
    assert.deepEqual(L.diskPathsFor(L.parseBlkList(BLKLIST_REAL)),
        ['/tmp/hangar probe/disk one.qcow2', '/dev/vg0/data']);
});

test('diskPathsFor de-duplicates a backing file attached twice', () => {
    const rows = [
        { target: 'vda', source: '/srv/shared.qcow2', type: 'file', device: 'disk' },
        { target: 'vdb', source: '/srv/shared.qcow2', type: 'file', device: 'disk' },
        { target: 'vdc', source: '/srv/other.qcow2', type: 'file', device: 'disk' }
    ];
    assert.deepEqual(L.diskPathsFor(rows), ['/srv/shared.qcow2', '/srv/other.qcow2']);
});

test('diskPathsFor tolerates junk rows and junk input', () => {
    assert.deepEqual(L.diskPathsFor([null, {}, { source: 7 }, { source: '' }, { source: '/srv/a' }]),
        ['/srv/a']);
    [null, undefined, 42, ''].forEach((v) => assert.deepEqual(L.diskPathsFor(v), []));
});

// ---- xmlPathFor -------------------------------------------------------------

test('xmlPathFor stages the domain XML under /var/lib/hangar/libvirt', () => {
    assert.equal(L.xmlPathFor(src(), 'web'), '/var/lib/hangar/libvirt/web.xml');
    assert.equal(L.XML_DIR, '/var/lib/hangar/libvirt');
});

test('xmlPathFor falls back to the first domain of the source', () => {
    assert.equal(L.xmlPathFor(src({ domains: ['db', 'web'] })), '/var/lib/hangar/libvirt/db.xml');
});

test('xmlPathFor returns an empty string rather than a path with no basename', () => {
    [src({ domains: [] }), src({ domains: [7] }), null, {}].forEach((s) => {
        assert.equal(L.xmlPathFor(s), '');
    });
});

test('xmlPathFor gives each domain its own file', () => {
    const paths = ['web', 'db'].map((d) => L.xmlPathFor(src(), d));
    assert.equal(new Set(paths).size, 2);
});

// ---- normalize --------------------------------------------------------------

test('normalize fills in every field for a bare source', () => {
    assert.deepEqual(L.normalize({ id: 'vms', kind: 'libvirt', domains: ['web'] }), {
        id: 'vms',
        kind: 'libvirt',
        uri: 'qemu:///system',
        domains: ['web'],
        quiesce: 'none',
        includeXml: true,
        excludes: [],
        tags: [],
        resolvedPaths: []
    });
});

test('normalize sorts and de-duplicates domains by code unit', () => {
    const n = L.normalize(src({ domains: ['web', 'db', 'web', 'App', 'über'] }));
    assert.deepEqual(n.domains, ['App', 'db', 'web', 'über']);
});

test('normalize defaults includeXml to true but keeps an explicit false', () => {
    assert.equal(L.normalize(src()).includeXml, true);
    assert.equal(L.normalize(src({ includeXml: null })).includeXml, true);
    assert.equal(L.normalize(src({ includeXml: false })).includeXml, false);
    assert.equal(L.normalize(src({ includeXml: 0 })).includeXml, false);
    assert.equal(L.normalize(src({ includeXml: 'false' })).includeXml, true);   // truthy string
});

test('normalize folds an unrecognised quiesce mode to the one needing nothing', () => {
    ['freeze', '', null, 42, 'AGENT'].forEach((q) => {
        assert.equal(L.normalize(src({ quiesce: q })).quiesce, 'none', String(q));
    });
    assert.equal(L.normalize(src({ quiesce: 'shutdown' })).quiesce, 'shutdown');
});

test('normalize drops junk domains, tags, patterns and resolved paths', () => {
    const n = L.normalize(src({
        domains: ['web', '', null, 7, 'web'],
        tags: ['vm', '', 3, 'vm'],
        excludes: ['*.tmp', null, '*.tmp', '*.iso'],
        resolvedPaths: ['/srv/a', '', 9, '/srv/a', '/srv/b']
    }));
    assert.deepEqual(n.domains, ['web']);
    assert.deepEqual(n.tags, ['vm']);
    assert.deepEqual(n.excludes, ['*.tmp', '*.iso']);   // author order kept
    assert.deepEqual(n.resolvedPaths, ['/srv/a', '/srv/b']);
});

test('normalize is idempotent and does not mutate its input', () => {
    const s = src({ domains: ['web', 'db'], quiesce: 'agent', tags: ['vm', 'vm'] });
    const copy = JSON.parse(JSON.stringify(s));
    const once = L.normalize(s);
    assert.deepEqual(L.normalize(once), once);
    assert.deepEqual(s, copy);
});

test('normalize tolerates a source the validator would reject outright', () => {
    // The editor normalises on every keystroke; it must not explode mid-typing.
    [null, undefined, 'qemu:///system', 42, ['web']].forEach((s) => {
        const n = L.normalize(s);
        assert.equal(n.kind, 'libvirt');
        assert.deepEqual(n.domains, []);
        assert.equal(n.uri, L.DEFAULT_URI);
    });
});

test('normalize never lets a "__proto__" key from parsed JSON reach Object.prototype', () => {
    const s = JSON.parse('{"id":"vms","kind":"libvirt","domains":["web"],"__proto__":{"pwned":1}}');
    L.normalize(s);
    L.validate(s);
    L.toResticArgs(s);
    assert.equal({}.pwned, undefined);
    assert.equal(L.normalize(s).pwned, undefined);
});

// ---- validate: domains ------------------------------------------------------

test('validate accepts a minimal source, warning only about consistency', () => {
    assert.deepEqual(errorCodes(L.validate(src())), []);
    assert.deepEqual(warningCodes(L.validate(src())), [L.PROBLEM.QUIESCE_CRASH_CONSISTENT]);
});

test('validate rejects a source with no domains', () => {
    [undefined, [], null, 'web', {}, 7].forEach((domains) => {
        assert.ok(errorCodes(L.validate(src({ domains }))).includes(L.PROBLEM.NO_DOMAINS),
            String(domains));
    });
});

test('validate rejects a non-object source without throwing', () => {
    [null, undefined, 'web', 42, ['web']].forEach((s) => {
        assert.deepEqual(errorCodes(L.validate(s)), [L.PROBLEM.NO_DOMAINS], String(s));
    });
});

test('validate rejects non-string domain entries and reports the index', () => {
    const problems = L.validate(src({ domains: [null, 7, {}, ['web']] }));
    assert.deepEqual(errorCodes(problems), Array(4).fill(L.PROBLEM.DOMAIN_TYPE));
    assert.deepEqual(problems.filter((p) => p.severity === 'error').map((p) => p.index), [0, 1, 2, 3]);
});

test('validate rejects a NUL byte in a domain name before anything else', () => {
    assert.deepEqual(errorCodes(L.validate(src({ domains: ['we' + NUL + 'b'] }))),
        [L.PROBLEM.DOMAIN_NUL]);
    // NUL wins over the unsafe-character rule: it cannot survive execve at all.
    assert.deepEqual(errorCodes(L.validate(src({ domains: ['web;' + NUL] }))),
        [L.PROBLEM.DOMAIN_NUL]);
});

test('validate rejects an empty domain name', () => {
    assert.deepEqual(errorCodes(L.validate(src({ domains: [''] }))), [L.PROBLEM.DOMAIN_EMPTY]);
});

test('validate rejects every shell metacharacter in a domain name', () => {
    [';', '&', '|', '<', '>', '`', '$', '(', ')', '{', '}', '[', ']', '*', '?', '!', '~',
        '"', "'", '\\'].forEach((ch) => {
        const problems = L.validate(src({ domains: ['web' + ch + 'x'] }));
        assert.deepEqual(errorCodes(problems), [L.PROBLEM.DOMAIN_UNSAFE], ch);
        assert.equal(problems[0].character, ch);
        assert.equal(problems[0].domain, 'web' + ch + 'x');
    });
});

test('validate rejects a slash, which would escape the XML staging directory', () => {
    ['../../etc/passwd', 'web/db', '/web'].forEach((d) => {
        assert.deepEqual(errorCodes(L.validate(src({ domains: [d] }))), [L.PROBLEM.DOMAIN_UNSAFE], d);
    });
});

test('validate rejects newlines, carriage returns, tabs and DEL in a domain name', () => {
    ['web\nevil', 'web\r\nevil', 'web\tx', 'web\u0007', 'web\u001B[0m'].forEach((d) => {
        assert.deepEqual(errorCodes(L.validate(src({ domains: [d] }))), [L.PROBLEM.DOMAIN_UNSAFE],
            JSON.stringify(d));
    });
});

test('validate rejects a domain name starting with a dash, which virsh reads as an option', () => {
    const problems = L.validate(src({ domains: ['--all'] }));
    assert.deepEqual(errorCodes(problems), [L.PROBLEM.DOMAIN_UNSAFE]);
    assert.match(problems[0].message, /option/);
});

test('validate accepts the domain names libvirt actually produces', () => {
    ['web', 'hangar-probe', 'rhel10.2', 'vm_01', 'A1', 'web server', 'yedek-sunucu', '日本']
        .forEach((d) => {
            assert.deepEqual(errorCodes(L.validate(src({ domains: [d] }))), [], d);
        });
});

test('validate rejects a duplicated domain, which would be frozen and thawed twice', () => {
    const problems = L.validate(src({ domains: ['web', 'db', 'web'] }));
    assert.deepEqual(errorCodes(problems), [L.PROBLEM.DOMAIN_DUPLICATE]);
    assert.equal(problems[0].index, 2);
    assert.equal(problems[0].domain, 'web');
});

// ---- validate: quiesce warnings --------------------------------------------

test('validate warns that a live copy is crash-consistent at best', () => {
    const problems = L.validate(src({ quiesce: 'none' }));
    assert.deepEqual(errorCodes(problems), []);
    assert.deepEqual(warningCodes(problems), [L.PROBLEM.QUIESCE_CRASH_CONSISTENT]);
    assert.match(problems[0].message, /crash-consistent at best/);
    assert.equal(problems[0].quiesce, 'none');
});

test('validate warns for the same reason when quiesce is simply absent', () => {
    [undefined, null].forEach((q) => {
        assert.deepEqual(warningCodes(L.validate(src({ quiesce: q }))),
            [L.PROBLEM.QUIESCE_CRASH_CONSISTENT], String(q));
    });
});

test('validate warns that agent mode fails open without qemu-guest-agent', () => {
    const problems = L.validate(src({ quiesce: 'agent' }));
    assert.deepEqual(errorCodes(problems), []);
    assert.deepEqual(warningCodes(problems), [L.PROBLEM.QUIESCE_AGENT_REQUIRED]);
    assert.match(problems[0].message, /qemu-guest-agent/);
    assert.match(problems[0].message, /crash-consistent/);
});

test('validate does not warn about consistency for shutdown mode', () => {
    assert.deepEqual(L.validate(src({ quiesce: 'shutdown' })), []);
});

test('validate rejects an unknown consistency mode and lists the known ones', () => {
    const problems = L.validate(src({ quiesce: 'fsfreeze' }));
    assert.deepEqual(errorCodes(problems), [L.PROBLEM.QUIESCE_UNKNOWN]);
    assert.deepEqual(problems[0].known, ['none', 'agent', 'shutdown']);
    ['', 'AGENT', 42, {}, ['agent'], '__proto__'].forEach((q) => {
        assert.ok(errorCodes(L.validate(src({ quiesce: q }))).includes(L.PROBLEM.QUIESCE_UNKNOWN),
            String(q));
    });
});

test('an unknown quiesce mode produces no consistency warning to contradict the error', () => {
    assert.deepEqual(warningCodes(L.validate(src({ quiesce: 'fsfreeze' }))), []);
});

// ---- validate: uri, xml, patterns, tags, id --------------------------------

test('validate rejects an empty or blank connection uri', () => {
    ['', '   ', '\t'].forEach((uri) => {
        const problems = L.validate(src({ uri }));
        assert.deepEqual(errorCodes(problems), [L.PROBLEM.URI_EMPTY], JSON.stringify(uri));
        assert.equal(problems[0].uri, uri);
    });
    [42, {}, ['qemu:///system']].forEach((uri) => {
        assert.deepEqual(errorCodes(L.validate(src({ uri }))), [L.PROBLEM.URI_EMPTY], String(uri));
    });
});

test('validate accepts an absent uri, which means the default connection', () => {
    assert.deepEqual(errorCodes(L.validate(src({ uri: undefined }))), []);
    assert.deepEqual(errorCodes(L.validate(src({ uri: null }))), []);
    assert.deepEqual(errorCodes(L.validate(src({ uri: 'qemu+ssh://root@host/system' }))), []);
});

test('validate warns when the domain XML is left out', () => {
    const problems = L.validate(src({ quiesce: 'shutdown', includeXml: false }));
    assert.deepEqual(errorCodes(problems), []);
    assert.deepEqual(warningCodes(problems), [L.PROBLEM.NO_XML]);
    assert.match(problems[0].message, /not as a VM you can start/);
});

test('validate says nothing about the XML when it is included', () => {
    [true, undefined, null].forEach((includeXml) => {
        assert.equal(warningCodes(L.validate(src({ quiesce: 'shutdown', includeXml })))
            .includes(L.PROBLEM.NO_XML), false, String(includeXml));
    });
});

test('validate rejects a missing or malformed id', () => {
    ['', '.', '..', 'a/b', '_x', 'a b', 'sys\n', 'sys' + NUL, 42, null, undefined]
        .forEach((id) => {
            assert.ok(errorCodes(L.validate(src({ id }))).includes(L.PROBLEM.BAD_ID), String(id));
        });
    assert.deepEqual(errorCodes(L.validate(src({ id: 'a.b-c_1' }))), []);
});

test('validate applies the shared exclude-pattern rules', () => {
    assert.deepEqual(errorCodes(L.validate(src({ excludes: '*.tmp' }))), [L.PROBLEM.PATTERN_TYPE]);
    assert.deepEqual(errorCodes(L.validate(src({ excludes: ['', 3, 'a' + NUL] }))),
        [L.PROBLEM.PATTERN_EMPTY, L.PROBLEM.PATTERN_TYPE, L.PROBLEM.PATTERN_NUL]);
    assert.deepEqual(errorCodes(L.validate(src({ excludes: null }))), []);
    assert.deepEqual(errorCodes(L.validate(src({ excludes: ['*.iso', '**/swap'] }))), []);
});

test('validate applies the shared tag rules, including restic comma splitting', () => {
    assert.deepEqual(errorCodes(L.validate(src({ tags: ['daily,weekly'] }))), [L.PROBLEM.TAG_COMMA]);
    assert.deepEqual(errorCodes(L.validate(src({ tags: ['', 1, 'x' + NUL] }))),
        [L.PROBLEM.TAG_EMPTY, L.PROBLEM.TAG_TYPE, L.PROBLEM.TAG_NUL]);
    assert.deepEqual(errorCodes(L.validate(src({ tags: 'vm' }))), [L.PROBLEM.TAG_TYPE]);
    assert.deepEqual(errorCodes(L.validate(src({ tags: ['vm', 'yedek günlük'] }))), []);
});

test('validate reports problems in field order so the UI can focus the first field', () => {
    const problems = L.validate({
        id: 'bad id', kind: 'libvirt', uri: '', domains: [''], quiesce: 'nope',
        includeXml: false, excludes: [''], tags: ['']
    });
    assert.deepEqual(errorCodes(problems), [
        L.PROBLEM.BAD_ID,
        L.PROBLEM.URI_EMPTY,
        L.PROBLEM.DOMAIN_EMPTY,
        L.PROBLEM.QUIESCE_UNKNOWN,
        L.PROBLEM.PATTERN_EMPTY,
        L.PROBLEM.TAG_EMPTY
    ]);
    assert.deepEqual(warningCodes(problems), [L.PROBLEM.NO_XML]);
});

test('validate does not mutate the source it inspects', () => {
    const s = src({ domains: ['web', 'web'], quiesce: 'agent', tags: ['a,b'] });
    const copy = JSON.parse(JSON.stringify(s));
    L.validate(s);
    assert.deepEqual(s, copy);
});

test('no hostile source makes validate throw or emit a malformed problem', () => {
    const hostile = [
        null, undefined, 0, '', 'libvirt', true, [], ['web'], () => 'web', Symbol('vm'),
        Object.create(null), new Date(),
        {}, { kind: 'libvirt' }, { domains: [NUL] }, { domains: ['web'], quiesce: Symbol('q') },
        { id: NUL, kind: 'libvirt', domains: ['web'], excludes: [NUL], tags: [NUL] },
        { id: 'x', kind: 'libvirt', domains: ['x'.repeat(70000)] },
        JSON.parse('{"kind":"libvirt","domains":["web"],"__proto__":{"x":1}}')
    ];
    hostile.forEach((s, i) => {
        const problems = L.validate(s);
        assert.ok(Array.isArray(problems), 'case ' + i);
        problems.forEach((p) => {
            assert.equal(typeof p.code, 'string', 'case ' + i);
            assert.equal(typeof p.message, 'string', 'case ' + i);
            assert.ok(p.severity === 'error' || p.severity === 'warning', 'case ' + i);
        });
        [L.normalize, L.describe, L.toResticArgs, L.preCommands, L.postCommands].forEach((fn) => {
            try {
                fn(s);
            } catch (e) {
                assert.ok(Errors.isHangarError(e), 'case ' + i + ': ' + (e && e.message));
            }
        });
    });
});

// ---- toResticArgs -----------------------------------------------------------

test('toResticArgs emits the full flag vector in the documented order', () => {
    const s = src({
        domains: ['web', 'db'],
        excludes: ['*.iso', '/var/cache'],
        tags: ['vm', 'nightly'],
        resolvedPaths: ['/srv/vm/web.qcow2', '/srv/vm/db.qcow2']
    });
    assert.deepEqual(L.toResticArgs(s), [
        '--exclude', '*.iso',
        '--exclude', '/var/cache',
        '--tag', 'vm',
        '--tag', 'nightly',
        '/srv/vm/db.qcow2', '/srv/vm/web.qcow2',
        '/var/lib/hangar/libvirt/db.xml', '/var/lib/hangar/libvirt/web.xml'
    ]);
});

test('toResticArgs backs up the resolved disks plus the staged XML', () => {
    assert.deepEqual(L.toResticArgs(src({ resolvedPaths: ['/srv/vm/web.qcow2'] })),
        ['/srv/vm/web.qcow2', '/var/lib/hangar/libvirt/web.xml']);
});

test('toResticArgs leaves the XML out when includeXml is false', () => {
    assert.deepEqual(L.toResticArgs(src({ includeXml: false, resolvedPaths: ['/srv/vm/web.qcow2'] })),
        ['/srv/vm/web.qcow2']);
});

test('toResticArgs emits only the XML before the disks have been resolved', () => {
    assert.deepEqual(L.toResticArgs(src()), ['/var/lib/hangar/libvirt/web.xml']);
});

test('toResticArgs de-duplicates and sorts the resolved disk paths', () => {
    const args = L.toResticArgs(src({
        includeXml: false,
        resolvedPaths: ['/srv/b.qcow2', '/srv/a.qcow2', '/srv/b.qcow2']
    }));
    assert.deepEqual(args, ['/srv/a.qcow2', '/srv/b.qcow2']);
});

test('toResticArgs is stable under input shuffling', () => {
    const base = { excludes: ['*.iso'], tags: ['vm'] };
    const a = L.toResticArgs(src(Object.assign({ domains: ['web', 'db'], resolvedPaths: ['/b', '/a'] }, base)));
    const b = L.toResticArgs(src(Object.assign({ domains: ['db', 'web'], resolvedPaths: ['/a', '/b'] }, base)));
    assert.deepEqual(a, b);
});

test('toResticArgs puts every positional after every flag', () => {
    const args = L.toResticArgs(src({ excludes: ['*.iso'], tags: ['vm'], resolvedPaths: ['/srv/a'] }));
    assert.ok(args.indexOf('/srv/a') > args.lastIndexOf('vm'));
});

test('toResticArgs never emits an empty or NUL-bearing argument', () => {
    L.toResticArgs(src({ domains: ['web', 'db'], excludes: ['*.iso'], tags: ['vm'],
        resolvedPaths: ['/srv/a'] })).forEach((a) => {
        assert.equal(typeof a, 'string');
        assert.notEqual(a, '');
        assert.equal(a.indexOf(NUL), -1);
    });
});

test('toResticArgs passes spaces and unicode through unquoted — argv, not a shell line', () => {
    assert.deepEqual(L.toResticArgs(src({
        includeXml: false, resolvedPaths: ['/tmp/hangar probe/disk one.qcow2']
    })), ['/tmp/hangar probe/disk one.qcow2']);
});

test('HangarSources.toResticArgs refuses to build args for an invalid libvirt source', () => {
    assert.throws(() => Sources.toResticArgs(src({ domains: [] })), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.equal(e.kind, Errors.KIND.GENERIC);
        assert.equal(e.detail.problems[0].code, L.PROBLEM.NO_DOMAINS);
        return true;
    });
    assert.throws(() => Sources.toResticArgs(src({ quiesce: 'fsfreeze' })), Errors.isHangarError);
});

test('a crash-consistency warning alone does not stop the args being built', () => {
    assert.deepEqual(Sources.toResticArgs(src({ quiesce: 'none', includeXml: false,
        resolvedPaths: ['/srv/a'] })), ['/srv/a']);
});

test('toResticArgs does not mutate the source', () => {
    const s = src({ domains: ['web', 'db'], resolvedPaths: ['/b', '/a'] });
    const copy = JSON.parse(JSON.stringify(s));
    L.toResticArgs(s);
    assert.deepEqual(s, copy);
});

// ---- preCommands / postCommands --------------------------------------------

test('a live copy needs no pre or post commands', () => {
    assert.deepEqual(L.preCommands(src({ quiesce: 'none' })), []);
    assert.deepEqual(L.postCommands(src({ quiesce: 'none' })), []);
});

test('agent mode freezes every domain and thaws them in reverse', () => {
    const s = src({ domains: ['web', 'db'], quiesce: 'agent', uri: 'qemu:///system' });
    assert.deepEqual(L.preCommands(s), [
        ['virsh', '-c', 'qemu:///system', 'domfsfreeze', 'db'],
        ['virsh', '-c', 'qemu:///system', 'domfsfreeze', 'web']
    ]);
    assert.deepEqual(L.postCommands(s), [
        ['virsh', '-c', 'qemu:///system', 'domfsthaw', 'web'],
        ['virsh', '-c', 'qemu:///system', 'domfsthaw', 'db']
    ]);
});

test('shutdown mode stops every domain and starts them in reverse', () => {
    const s = src({ domains: ['web', 'db'], quiesce: 'shutdown' });
    assert.deepEqual(L.preCommands(s).map((c) => c.slice(3)), [['shutdown', 'db'], ['shutdown', 'web']]);
    assert.deepEqual(L.postCommands(s).map((c) => c.slice(3)), [['start', 'web'], ['start', 'db']]);
});

test('post is exactly pre reversed, domain for domain', () => {
    ['agent', 'shutdown'].forEach((quiesce) => {
        const s = src({ domains: ['a', 'b', 'c'], quiesce });
        const pre = L.preCommands(s).map((c) => c[c.length - 1]);
        const post = L.postCommands(s).map((c) => c[c.length - 1]);
        assert.deepEqual(post, pre.slice().reverse(), quiesce);
    });
});

test('pre and post commands use the source connection, not the default', () => {
    const s = src({ uri: 'qemu:///session', quiesce: 'agent' });
    assert.equal(L.preCommands(s)[0][2], 'qemu:///session');
    assert.equal(L.postCommands(s)[0][2], 'qemu:///session');
});

test('an unknown quiesce mode yields no commands rather than invented ones', () => {
    assert.deepEqual(L.preCommands(src({ quiesce: 'fsfreeze' })), []);
    assert.deepEqual(L.postCommands(src({ quiesce: 'fsfreeze' })), []);
    assert.deepEqual(L.preCommands(src({ domains: [], quiesce: 'agent' })), []);
});

// ---- describe ---------------------------------------------------------------

test('describe names the domains, the connection and the consistency mode', () => {
    assert.equal(L.describe(src({ domains: ['web', 'db'], quiesce: 'agent' })),
        'Backs up db and web on qemu:///system, freezing guest filesystems with the ' +
        'guest agent, including the domain XML.');
});

test('describe says plainly that a live copy is crash-consistent at best', () => {
    assert.equal(L.describe(src()),
        'Backs up web on qemu:///system, copying disks while they run ' +
        '(crash-consistent at best), including the domain XML.');
});

test('describe renders every clause in a fixed order', () => {
    assert.equal(L.describe(src({
        uri: 'qemu:///session', domains: ['web'], quiesce: 'shutdown',
        excludes: ['*.iso'], tags: ['vm', 'nightly']
    })), 'Backs up web on qemu:///session, shutting each domain down first, ' +
         'including the domain XML, excluding 1 pattern, tagged vm, nightly.');
});

test('describe drops the XML clause when the XML is left out', () => {
    assert.equal(L.describe(src({ includeXml: false })),
        'Backs up web on qemu:///system, copying disks while they run ' +
        '(crash-consistent at best).');
});

test('describe truncates beyond three domains', () => {
    assert.equal(L.describe(src({ domains: ['a', 'b', 'c', 'd', 'e'], includeXml: false })),
        'Backs up a, b, c and 2 more on qemu:///system, copying disks while they run ' +
        '(crash-consistent at best).');
});

test('describe says so when no domain is selected', () => {
    assert.equal(L.describe(src({ domains: [] })), 'Backs up nothing (no domains selected).');
    assert.equal(L.describe(src({ domains: [null, 7] })), 'Backs up nothing (no domains selected).');
});

test('describe still renders a source that would fail validation', () => {
    // The list page describes saved config it did not write; it must never throw.
    assert.equal(L.describe({ kind: 'libvirt', id: 42, domains: ['web'], quiesce: 'nope',
        tags: 'x', includeXml: false }),
    'Backs up web on qemu:///system, copying disks while they run ' +
    '(crash-consistent at best), tagged x.');
});

// ---- classifyVirshError ------------------------------------------------------

test('classifyVirshError calls a real connection failure a NETWORK error', () => {
    // Captured from `virsh -c qemu+unix:///system?socket=/nope/libvirt-sock list`.
    const real = "error: failed to connect to the hypervisor\n" +
        "error: Failed to connect socket to '/nope/libvirt-sock': No such file or directory";
    assert.equal(L.classifyVirshError(real), Errors.KIND.NETWORK);
    assert.equal(Errors.REMEDIATION[Errors.KIND.NETWORK], 'retry');
});

test('classifyVirshError leaves a hypervisor refusal as GENERIC', () => {
    // Captured from `virsh domfsfreeze` against a shut-off domain.
    const real = 'error: Unable to freeze filesystems\n' +
        'error: Requested operation is not valid: domain is not running';
    assert.equal(L.classifyVirshError(real), Errors.KIND.GENERIC);
    assert.equal(L.classifyVirshError("error: failed to get domain 'nosuch'"), Errors.KIND.GENERIC);
});

test('classifyVirshError tolerates junk instead of stderr text', () => {
    [null, undefined, 42, {}, ''].forEach((v) => {
        assert.equal(L.classifyVirshError(v), Errors.KIND.GENERIC, String(v));
    });
});

// ---- the guarded I/O layer ---------------------------------------------------

test('the I/O layer rejects with a typed error when cockpit is absent', async () => {
    delete globalThis.cockpit;
    const typed = (e) => Errors.isHangarError(e) && e.kind === Errors.KIND.GENERIC;
    await assert.rejects(L.listDomains('qemu:///system'), typed);
    await assert.rejects(L.dumpXml('qemu:///system', 'web'), typed);
    await assert.rejects(L.resolve(src()), typed);
});

test('a cockpit object that cannot spawn is the same as no cockpit at all', async () => {
    await withCockpit({}, async () => {
        await assert.rejects(L.listDomains('qemu:///system'), Errors.isHangarError);
    });
});

test('listDomains parses the real virsh output it is handed', async () => {
    const seen = [];
    await withCockpit({
        spawn(argv, opts) { seen.push({ argv, opts }); return Promise.resolve(LIST_REAL); }
    }, async () => {
        assert.deepEqual(await L.listDomains('qemu:///session'), ['hangar-probe']);
        assert.deepEqual(seen[0].argv,
            ['virsh', '-c', 'qemu:///session', 'list', '--all', '--name']);
    });
});

test('a system connection runs privileged, with the C locale forced', async () => {
    const seen = [];
    await withCockpit({
        spawn(argv, opts) { seen.push(opts); return Promise.resolve(''); }
    }, async () => {
        await L.listDomains('qemu:///system');
        assert.equal(seen[0].superuser, 'require');
        // Column titles are translated; a header we fail to recognise would be
        // parsed as a disk.
        assert.deepEqual(seen[0].environ, ['LC_ALL=C']);
        assert.equal(seen[0].err, 'message');
    });
});

test('a session connection runs unprivileged, because the domains are the user\'s', async () => {
    const seen = [];
    await withCockpit({
        spawn(argv, opts) { seen.push(opts); return Promise.resolve(''); }
    }, async () => {
        await L.listDomains('qemu:///session');
        assert.equal(seen[0].superuser, undefined);
    });
});

test('resolve fills resolvedPaths from domblklist, one domain at a time', async () => {
    const calls = [];
    await withCockpit({
        spawn(argv) {
            calls.push(argv);
            return Promise.resolve(argv[argv.length - 1] === 'web'
                ? BLKLIST_REAL
                : ' Type   Device   Target   Source\n---\n file   disk     vda      /srv/db.qcow2\n');
        }
    }, async () => {
        const out = await L.resolve(src({ domains: ['web', 'db'] }));
        assert.deepEqual(calls.map((c) => c[c.length - 1]), ['db', 'web']);   // normalised order
        assert.deepEqual(out.resolvedPaths,
            ['/srv/db.qcow2', '/tmp/hangar probe/disk one.qcow2', '/dev/vg0/data']);
        assert.equal(out.kind, 'libvirt');
        assert.deepEqual(calls[0].slice(3), ['domblklist', '--details', 'db']);
    });
});

test('resolve de-duplicates a disk shared between two domains', async () => {
    await withCockpit({
        spawn() {
            return Promise.resolve(' Type   Device   Target   Source\n---\n' +
                ' file   disk     vda      /srv/shared.qcow2\n');
        }
    }, async () => {
        const out = await L.resolve(src({ domains: ['web', 'db'] }));
        assert.deepEqual(out.resolvedPaths, ['/srv/shared.qcow2']);
    });
});

test('resolve on a source with no domains never touches the hypervisor', async () => {
    let spawned = false;
    await withCockpit({ spawn() { spawned = true; return Promise.resolve(''); } }, async () => {
        const out = await L.resolve(src({ domains: [] }));
        assert.deepEqual(out.resolvedPaths, []);
        assert.equal(spawned, false);
    });
});

test('a failing virsh becomes a typed error, classified by what it said', async () => {
    await withCockpit({
        spawn() { return Promise.reject(new Error('error: failed to connect to the hypervisor')); }
    }, async () => {
        await assert.rejects(L.listDomains('qemu:///system'), (e) => {
            assert.ok(Errors.isHangarError(e));
            assert.equal(e.kind, Errors.KIND.NETWORK);
            assert.equal(e.remediation, 'retry');
            return true;
        });
    });
    await withCockpit({
        spawn() { return Promise.reject(new Error("error: failed to get domain 'nosuch'")); }
    }, async () => {
        await assert.rejects(L.resolve(src()), (e) => {
            assert.equal(e.kind, Errors.KIND.GENERIC);
            assert.equal(e.detail.op, 'resolve');
            return true;
        });
    });
});

test('a cockpit.spawn that throws synchronously still yields a typed rejection', async () => {
    await withCockpit({ spawn() { throw new Error('channel is closed'); } }, async () => {
        await assert.rejects(L.listDomains('qemu:///system'), Errors.isHangarError);
    });
});

test('dumpXml returns the domain XML and refuses a hostile domain name first', async () => {
    let spawned = false;
    await withCockpit({
        spawn() { spawned = true; return Promise.resolve('<domain type="kvm"/>'); }
    }, async () => {
        assert.equal(await L.dumpXml('qemu:///session', 'web'), '<domain type="kvm"/>');
        spawned = false;
        for (const bad of ['', '../etc', 'web;reboot', '--all', null, 42]) {
            await assert.rejects(L.dumpXml('qemu:///session', bad), Errors.isHangarError, String(bad));
        }
        assert.equal(spawned, false);
    });
});

test('a hypervisor that never answers becomes a NETWORK error, and the channel is closed', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let closedWith = null;
    globalThis.cockpit = {
        spawn() {
            // qemu:///system on this host hangs instead of failing.
            const p = new Promise(() => {});
            p.close = (problem) => { closedWith = problem; };
            return p;
        }
    };
    try {
        const pending = L.listDomains('qemu:///system');
        t.mock.timers.tick(L.TIMEOUT_MS);
        await assert.rejects(pending, (e) => {
            assert.ok(Errors.isHangarError(e));
            assert.equal(e.kind, Errors.KIND.NETWORK);
            assert.match(e.message, /did not answer within/);
            assert.equal(e.detail.op, 'listDomains');
            return true;
        });
        assert.equal(closedWith, 'terminated');
    } finally {
        delete globalThis.cockpit;
        t.mock.timers.reset();
    }
});

test('a spawn that answers before the deadline is not also failed by it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
        globalThis.cockpit = { spawn() { return Promise.resolve(LIST_REAL); } };
        const names = await L.listDomains('qemu:///system');
        assert.deepEqual(names, ['hangar-probe']);
        t.mock.timers.tick(L.TIMEOUT_MS * 2);   // the pending timer must be gone
    } finally {
        delete globalThis.cockpit;
        t.mock.timers.reset();
    }
});

test('the deadline is long enough to be a hang, not a slow hypervisor', () => {
    assert.ok(L.TIMEOUT_MS >= 10000 && L.TIMEOUT_MS <= 60000);
});

// ---- adversarial: a domain name is one argument, or it is refused ----------
//
// A domain name reaches three places that all care: virsh's argv, the staging
// path under XML_DIR, and restic's positional list. `virsh shutdown --all` shuts
// down every domain on the host and `/var/lib/hangar/libvirt/../../etc/x.xml`
// leaves the directory entirely, so the name is refused rather than escaped.

const DOMAIN_HOSTILE = [
    '--all', '-a', '--mode=agent', '-f', '-',
    'a;id', 'a|id', 'a&&id', '$(id)', '`id`', '${IFS}', 'a>b', 'a<b',
    "a'b", 'a"b', 'a\\b', 'a*b', 'a?b', 'a[b]', '~root', '(a)', '{a}', '!a',
    '../../etc/passwd', '/etc/passwd', 'a/b', './a',
    'a\nb', 'a\rb', 'a\tb', 'a' + NUL + 'b'
];

test('preCommands refuses a domain name that virsh would read as an option', () => {
    // `virsh shutdown --all` is not a shutdown of a domain called "--all".
    ['agent', 'shutdown'].forEach((quiesce) => {
        ['--all', '-a', '-f'].forEach((domain) => {
            assert.throws(() => L.preCommands(src({ quiesce, domains: [domain] })), (e) => {
                assert.ok(Errors.isHangarError(e));
                assert.equal(e.detail.domain, domain);
                return true;
            }, quiesce + ' ' + domain);
        });
    });
});

test('postCommands refuses the same names, so the thaw half is not the way in', () => {
    ['agent', 'shutdown'].forEach((quiesce) => {
        assert.throws(() => L.postCommands(src({ quiesce, domains: ['--all'] })),
            Errors.isHangarError, quiesce);
    });
});

test('one bad domain refuses the whole vector rather than half of it', () => {
    // Shutting two of three domains down and then refusing to build the third is
    // strictly worse than refusing all three: the first two stay down.
    assert.throws(() => L.preCommands(src({
        quiesce: 'shutdown', domains: ['web', '../etc', 'db']
    })), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.equal(e.detail.domain, '../etc');
        return true;
    });
});

test('every hostile domain name is refused by every path that puts it on a line', () => {
    DOMAIN_HOSTILE.forEach((domain) => {
        assert.equal(L.isSafeDomain(domain), false, JSON.stringify(domain));
        ['agent', 'shutdown'].forEach((quiesce) => {
            const s = src({ quiesce, domains: [domain] });
            assert.throws(() => L.preCommands(s), Errors.isHangarError, JSON.stringify(domain));
            assert.throws(() => L.postCommands(s), Errors.isHangarError, JSON.stringify(domain));
        });
        assert.throws(() => L.toResticArgs(src({ domains: [domain], resolvedPaths: ['/i/a.qcow2'] })),
            Errors.isHangarError, JSON.stringify(domain));
        // The staging path is a file name as well as an argument, so it answers ''
        // instead of a path that walks out of XML_DIR.
        assert.equal(L.xmlPathFor(src(), domain), '', JSON.stringify(domain));
    });
});

test('the XML staging path can never leave its directory', () => {
    // hangar-run writes the dumped domain XML to this path, so a name that walked
    // out of XML_DIR would be an arbitrary file overwrite running as root.
    ['../../etc/passwd', 'a/../../b', '/etc/shadow', 'a/b'].forEach((domain) => {
        assert.equal(L.xmlPathFor(src({ domains: [domain] })), '', domain);
    });
    assert.equal(L.xmlPathFor(src(), 'web'), L.XML_DIR + '/web.xml');

    // The general statement, over every name the rule lets through: whatever comes
    // back normalises to a file sitting directly in XML_DIR. '.' and '..' are
    // allowed names — with no '/' they can only ever be the basename "..xml".
    ['web', '..', '.', '...', 'a.b', 'my vm', 'a'.repeat(200)].forEach((domain) => {
        const p = L.xmlPathFor(src(), domain);
        if (p === '') return;
        assert.equal(path.posix.dirname(path.posix.normalize(p)), L.XML_DIR, domain);
    });
});

test('a legitimate domain name lands as exactly one argv element, byte for byte', () => {
    // libvirt allows spaces and unicode in a domain name, and both are harmless in
    // argv — the rule is one element, not one word.
    ['web', 'db-01', 'vm.example.com', 'my vm', 'yedek gunlugu', 'a'.repeat(200)]
        .forEach((domain) => {
            assert.equal(L.isSafeDomain(domain), true, domain);
            const pre = L.preCommands(src({ quiesce: 'shutdown', domains: [domain] }));
            assert.deepEqual(pre, [['virsh', '-c', 'qemu:///system', 'shutdown', domain]]);
            assert.equal(pre[0].filter((a) => a === domain).length, 1);
            pre[0].forEach((a) => assert.equal(typeof a, 'string'));
            assert.deepEqual(L.dumpXmlArgv('qemu:///system', domain).slice(3), ['dumpxml', domain]);
        });
});

test('the connection URI is always the value of -c and never a bare argument', () => {
    // A URI is not validated beyond being non-empty, so the guarantee has to be
    // positional: it sits immediately after -c, where virsh consumes it as that
    // option's value and cannot read it as a verb.
    ['qemu:///system', 'qemu:///session', '--connect=evil', '-x', 'a b', ''].forEach((uri) => {
        const argv = L.listDomainsArgv(uri);
        assert.equal(argv[0], 'virsh');
        assert.equal(argv[1], '-c');
        assert.equal(argv.length, 6);
        assert.deepEqual(argv.slice(3), ['list', '--all', '--name']);
    });
});

test('toResticArgs refuses a resolved disk path that is really a restic flag', () => {
    // resolvedPaths is a stored field of the job file. "--one-file-system" there
    // would be spliced into the command as a FLAG, changing what gets backed up
    // while restic still reports success.
    ['--one-file-system', '-x', '--exclude', 'relative/path', '-', '/a' + NUL + 'b']
        .forEach((p) => {
            assert.throws(() => L.toResticArgs(src({ includeXml: false, resolvedPaths: [p] })),
                (e) => {
                    assert.ok(Errors.isHangarError(e));
                    assert.equal(e.detail.path, p);
                    return true;
                }, JSON.stringify(p));
        });
});

test('toResticArgs still accepts the disk shapes libvirt really reports', () => {
    ['/var/lib/libvirt/images/web.qcow2', '/tmp/hangar probe/disk one.qcow2',
        '/dev/vg0/data', 'rbd:pool/image', 'nbd:host:10809', 'gluster://h/v/i.qcow2']
        .forEach((p) => {
            assert.deepEqual(L.toResticArgs(src({ includeXml: false, resolvedPaths: [p] })), [p]);
        });
});

test('toResticArgs refuses to build a backup with no positional at all', () => {
    // `restic backup --tag vm` with no path fails — but it fails deep in the run,
    // after the pre commands have already shut the domain down.
    assert.throws(() => L.toResticArgs(src({ includeXml: false, resolvedPaths: [] })), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.match(e.message, /nothing to back up/);
        return true;
    });
});

test('parseBlkList drops a source carrying a NUL rather than passing it on', () => {
    // execve truncates at a NUL, so restic would receive a shorter path than the
    // one the journal recorded.
    assert.deepEqual(L.parseBlkList('file disk vda /var/lib/a' + NUL + 'b.qcow2\n'), []);
    assert.deepEqual(L.diskPathsFor(L.parseBlkList(
        ' file   disk   vda   /i/ok.qcow2\n file   disk   vdb   /i/b' + NUL + '.qcow2\n')),
    ['/i/ok.qcow2']);
});

test('parseBlkList never turns virsh diagnostics into a path', () => {
    // A wedged libvirtd prints its complaint on stdout, and a row we mis-parse
    // becomes a positional argument to restic.
    [
        "error: failed to get domain 'web'\n",
        "error: Failed to connect socket to '/var/run/libvirt/libvirt-sock'\n",
        'Authorization required, but no authorization protocol specified\n',
        ' \n',
        'Type Device Target Source\n'
    ].forEach((text) => {
        assert.deepEqual(L.diskPathsFor(L.parseBlkList(text)), [], JSON.stringify(text));
    });
});

// ---- adversarial: hostile input never throws an untyped exception ----------

test('every public function answers or throws a HangarError for any junk field', () => {
    const values = [
        undefined, null, '', 0, 1, -1, NaN, true, false, [], {}, Object.create(null),
        () => {}, Symbol('q'), new Date(), /re/, new Map(),
        NUL, '\n', '../..', '-x', '--all', '$(id)', 'a;b', 'x'.repeat(5000),
        [NUL], ['a', null], [['nested']], [{}], [undefined]
    ];
    const fields = ['id', 'kind', 'uri', 'domains', 'quiesce', 'includeXml',
        'excludes', 'tags', 'resolvedPaths'];
    const fns = ['normalize', 'validate', 'describe', 'toResticArgs',
        'preCommands', 'postCommands'];
    const say = (v) => { try { return String(v); } catch (e) { return typeof v; } };

    fields.forEach((field) => {
        values.forEach((value) => {
            const s = src({ resolvedPaths: ['/i/web.qcow2'] });
            s[field] = value;
            fns.forEach((fn) => {
                try {
                    L[fn](s);
                } catch (e) {
                    assert.ok(Errors.isHangarError(e),
                        fn + ' threw untyped for ' + field + '=' + say(value) + ': ' + e);
                }
            });
        });
    });
});

// ---- the try/finally guarantee: no VM is left frozen or shut down ---------
//
// A frozen guest is worse than a stopped container: its filesystems stay blocked
// until something thaws them, and nothing else on the host will. So the undo half
// must be complete and computable from the source alone, whatever the do half did.

function fakeHypervisor(names) {
    const state = new Map(names.map((n) => [n, 'running']));
    return {
        exec(argv) {
            const verb = argv[3];
            const domain = argv[4];
            if (!state.has(domain)) throw new Error('no such domain: ' + domain);
            if (verb === 'domfsfreeze') state.set(domain, 'frozen');
            else if (verb === 'domfsthaw') state.set(domain, 'running');
            else if (verb === 'shutdown') state.set(domain, 'shut');
            else if (verb === 'start') state.set(domain, 'running');
            else throw new Error('unexpected verb: ' + verb);
        },
        notRunning() {
            return [...state.entries()].filter(([, v]) => v !== 'running').map(([n]) => n);
        }
    };
}

function backupWithFailureAt(source, hv, failAt) {
    const pre = L.preCommands(source);
    const post = L.postCommands(source);
    let failed = null;
    try {
        pre.forEach((argv, i) => {
            if (i === failAt) throw new Error('the hypervisor refused step ' + i);
            hv.exec(argv);
        });
        if (failAt >= pre.length) throw new Error('restic failed after the pre commands');
    } catch (e) {
        failed = e;
    } finally {
        // Each post command is attempted even when an earlier one fails: thawing a
        // domain that was never frozen is an error, and stopping there would leave
        // the domains after it frozen for good.
        post.forEach((argv) => { try { hv.exec(argv); } catch (e) { /* keep unwinding */ } });
    }
    return failed;
}

['agent', 'shutdown'].forEach((quiesce) => {
    test('a backup that fails mid-' + quiesce + ' still leaves every domain running', () => {
        const domains = ['api', 'db', 'web'];   // normalize sorts, so this is the order
        const source = src({ quiesce, domains });
        for (let failAt = 0; failAt <= domains.length; failAt++) {
            const hv = fakeHypervisor(domains);
            const failure = backupWithFailureAt(source, hv, failAt);
            assert.ok(failure, 'the failure itself must still be reported');
            assert.deepEqual(hv.notRunning(), [],
                quiesce + ': domains left down after a failure at step ' + failAt);
        }
    });
});

test('a successful backup also leaves every domain running', () => {
    ['none', 'agent', 'shutdown'].forEach((quiesce) => {
        const domains = ['db', 'web'];
        const hv = fakeHypervisor(domains);
        const source = src({ quiesce, domains });
        L.preCommands(source).forEach((argv) => hv.exec(argv));
        L.postCommands(source).forEach((argv) => hv.exec(argv));
        assert.deepEqual(hv.notRunning(), [], quiesce);
    });
});

test('the thaw half is derivable from the source alone, at any point in the run', () => {
    const source = src({ quiesce: 'agent', domains: ['api', 'db', 'web'] });
    const before = L.postCommands(source);
    L.preCommands(source);
    assert.deepEqual(L.postCommands(source), before);
    assert.deepEqual(L.postCommands(JSON.parse(JSON.stringify(source))), before);
});

test('the thaw half touches exactly the domains the freeze half touches', () => {
    ['agent', 'shutdown'].forEach((quiesce) => {
        const domains = ['api', 'db', 'web', 'mail'];
        const source = src({ quiesce, domains });
        const named = (cmds) => cmds.map((c) => c[c.length - 1]).sort();
        assert.deepEqual(named(L.postCommands(source)), named(L.preCommands(source)), quiesce);
        assert.deepEqual(named(L.preCommands(source)), domains.slice().sort(), quiesce);
    });
});

// ---- the quiesce warnings must actually reach the user --------------------

test('a live copy of a VM warns through the shared HangarSources seam', () => {
    // The UI calls HangarSources.validate, so a warning that only exists on this
    // module's own validate() would never be shown to anyone.
    const problems = Sources.validate(src({ quiesce: 'none', resolvedPaths: ['/i/web.qcow2'] }));
    const warned = problems.filter((p) => p.code === L.PROBLEM.QUIESCE_CRASH_CONSISTENT);
    assert.equal(warned.length, 1);
    assert.equal(warned[0].severity, Sources.SEVERITY.WARNING);
    assert.match(warned[0].message, /crash-consistent/);
});

test('choosing the guest agent warns that it degrades silently without one', () => {
    // The failure this prevents: domfsfreeze errors when the agent is missing, the
    // copy proceeds anyway, and the UI still says "filesystem-consistent".
    const warned = Sources.validate(src({ quiesce: 'agent', resolvedPaths: ['/i/web.qcow2'] }))
        .filter((p) => p.code === L.PROBLEM.QUIESCE_AGENT_REQUIRED);
    assert.equal(warned.length, 1);
    assert.equal(warned[0].severity, Sources.SEVERITY.WARNING);
    assert.match(warned[0].message, /qemu-guest-agent/);
});

test('dropping the domain XML warns that what is left is not a restorable VM', () => {
    const warned = Sources.validate(src({ includeXml: false, resolvedPaths: ['/i/web.qcow2'] }))
        .filter((p) => p.code === L.PROBLEM.NO_XML);
    assert.equal(warned.length, 1);
    assert.equal(warned[0].severity, Sources.SEVERITY.WARNING);
});

test('the quiesce warnings are warnings: they never block the backup being built', () => {
    const s = src({ quiesce: 'none', includeXml: false, resolvedPaths: ['/i/web.qcow2'] });
    assert.equal(Sources.hasErrors(Sources.validate(s)), false);
    assert.equal(Sources.isValid(s), true);
    assert.deepEqual(Sources.toResticArgs(s), ['/i/web.qcow2']);
});

test('a quiesce warning survives alongside errors instead of being short-circuited', () => {
    // The editor shows every problem at once; a warning dropped because another
    // field was also wrong would reappear only once the user stopped reading.
    const codes = L.validate({ id: '', kind: 'libvirt', domains: ['web'], quiesce: 'none',
        excludes: [NUL] }).map((p) => p.code);
    assert.ok(codes.includes(L.PROBLEM.BAD_ID));
    assert.ok(codes.includes(L.PROBLEM.PATTERN_NUL));
    assert.ok(codes.includes(L.PROBLEM.QUIESCE_CRASH_CONSISTENT));
});

test('every quiesce mode carries the honest description the picker shows', () => {
    L.QUIESCE.forEach((mode) => {
        assert.ok(mode.id.length > 0);
        assert.ok(mode.label.length > 0, mode.id);
        assert.ok(mode.description.length > 40, mode.id + ' has no real description');
        assert.equal(typeof mode.requiresGuestAgent, 'boolean', mode.id);
    });
    assert.equal(L.QUIESCE.filter((m) => m.requiresGuestAgent).length, 1);
    assert.match(L.quiesceMode('none').description, /crash-consistent/);
});
