// tests/unit/repos.test.js — HangarRepos: URL build/parse round-trips for all 8
// restic backends, validation and credential env, with hostile input.
//
// Fixture note: tests/fixtures/rclone/synthetic-listremotes.txt is SYNTHETIC
// (hand-written in rclone's documented one-"name:"-per-line format), not captured
// from a real rclone install — hence the synthetic- prefix.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Repos = require('../../js/core/repos.js');
const Errors = require('../../js/core/errors.js');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function assertGeneric(fn) {
    assert.throws(fn, (e) => {
        assert.ok(Errors.isHangarError(e), 'expected a HangarError, got ' + e);
        assert.equal(e.kind, Errors.KIND.GENERIC);
        return true;
    });
}

// ---------------------------------------------------------------- buildUrl

test('buildUrl local emits the bare path', () => {
    assert.equal(Repos.buildUrl({ kind: 'local', path: '/srv/backups' }), '/srv/backups');
});

test('buildUrl sftp with user', () => {
    assert.equal(Repos.buildUrl({ kind: 'sftp', user: 'backup', host: 'nas.lan', path: '/vol/restic' }),
        'sftp:backup@nas.lan:/vol/restic');
});

test('buildUrl sftp without user omits the @', () => {
    assert.equal(Repos.buildUrl({ kind: 'sftp', host: 'nas.lan', path: '/vol/restic' }),
        'sftp:nas.lan:/vol/restic');
});

test('buildUrl rest', () => {
    assert.equal(Repos.buildUrl({ kind: 'rest', url: 'https://rest.example:8000/' }),
        'rest:https://rest.example:8000/');
});

test('buildUrl s3 without prefix', () => {
    assert.equal(Repos.buildUrl({ kind: 's3', endpoint: 's3.eu-central-1.amazonaws.com', bucket: 'hangar' }),
        's3:s3.eu-central-1.amazonaws.com/hangar');
});

test('buildUrl s3 with prefix', () => {
    assert.equal(Repos.buildUrl({ kind: 's3', endpoint: 's3.amazonaws.com', bucket: 'hangar', prefix: 'hosts/db01' }),
        's3:s3.amazonaws.com/hangar/hosts/db01');
});

test('buildUrl s3 keeps an explicit https endpoint', () => {
    assert.equal(Repos.buildUrl({ kind: 's3', endpoint: 'https://minio.lan:9000', bucket: 'hangar' }),
        's3:https://minio.lan:9000/hangar');
});

test('buildUrl b2 with path', () => {
    assert.equal(Repos.buildUrl({ kind: 'b2', bucket: 'hangar', prefix: 'srv' }), 'b2:hangar:srv');
});

test('buildUrl b2 without path', () => {
    assert.equal(Repos.buildUrl({ kind: 'b2', bucket: 'hangar' }), 'b2:hangar');
});

test('buildUrl azure', () => {
    assert.equal(Repos.buildUrl({ kind: 'azure', container: 'backups', prefix: 'db01' }), 'azure:backups:db01');
});

test('buildUrl gs', () => {
    assert.equal(Repos.buildUrl({ kind: 'gs', bucket: 'hangar-gs', prefix: 'a/b' }), 'gs:hangar-gs:a/b');
});

test('buildUrl rclone', () => {
    assert.equal(Repos.buildUrl({ kind: 'rclone', remote: 'gdrive', prefix: 'backups/db01' }),
        'rclone:gdrive:backups/db01');
});

test('buildUrl throws GENERIC on an unknown kind', () => {
    assertGeneric(() => Repos.buildUrl({ kind: 'dropbox', path: '/x' }));
});

test('buildUrl throws GENERIC on an empty kind', () => {
    assertGeneric(() => Repos.buildUrl({ path: '/x' }));
});

test('buildUrl throws on a missing local path', () => {
    assertGeneric(() => Repos.buildUrl({ kind: 'local' }));
});

test('buildUrl throws on a whitespace-only local path', () => {
    assertGeneric(() => Repos.buildUrl({ kind: 'local', path: '   ' }));
});

test('buildUrl throws on a missing sftp host', () => {
    assertGeneric(() => Repos.buildUrl({ kind: 'sftp', path: '/vol/restic' }));
});

test('buildUrl throws on a missing s3 bucket', () => {
    assertGeneric(() => Repos.buildUrl({ kind: 's3', endpoint: 's3.amazonaws.com' }));
});

test('buildUrl throws on null and on a non-object', () => {
    assertGeneric(() => Repos.buildUrl(null));
    assertGeneric(() => Repos.buildUrl('sftp:nas.lan:/x'));
});

test('buildUrl errors are fatal HangarErrors with no remediation', () => {
    try {
        Repos.buildUrl({ kind: 'nope' });
        assert.fail('expected a throw');
    } catch (e) {
        assert.equal(e.name, 'HangarError');
        assert.equal(Errors.isFatal(e), true);
        assert.equal(Errors.remediationFor(e), null);
    }
});

// ---------------------------------------------------------------- parseUrl

test('parseUrl treats an absolute path as local', () => {
    assert.deepEqual(Repos.parseUrl('/srv/backups'), { kind: 'local', path: '/srv/backups' });
});

test('parseUrl treats ./ and ../ and ~ paths as local', () => {
    assert.equal(Repos.parseUrl('./repo').kind, 'local');
    assert.equal(Repos.parseUrl('../repo').kind, 'local');
    assert.equal(Repos.parseUrl('~/repo').kind, 'local');
});

test('parseUrl does not mistake a Windows-style path for a scheme', () => {
    assert.deepEqual(Repos.parseUrl('C:\\backups\\restic'), { kind: 'local', path: 'C:\\backups\\restic' });
});

test('parseUrl does not mistake an unknown scheme for a backend', () => {
    assert.deepEqual(Repos.parseUrl('ftp:host/path'), { kind: 'local', path: 'ftp:host/path' });
});

test('parseUrl keeps colons inside an absolute local path', () => {
    assert.deepEqual(Repos.parseUrl('/mnt/vol:1/restic'), { kind: 'local', path: '/mnt/vol:1/restic' });
});

test('parseUrl does not read a scheme out of the middle of a local path', () => {
    assert.deepEqual(Repos.parseUrl('/mnt/s3:old/repo'), { kind: 'local', path: '/mnt/s3:old/repo' });
});

test('parseUrl sftp with user', () => {
    assert.deepEqual(Repos.parseUrl('sftp:backup@nas.lan:/vol/restic'),
        { kind: 'sftp', host: 'nas.lan', path: '/vol/restic', user: 'backup' });
});

test('parseUrl sftp without user leaves user unset', () => {
    assert.deepEqual(Repos.parseUrl('sftp:nas.lan:/vol/restic'),
        { kind: 'sftp', host: 'nas.lan', path: '/vol/restic' });
});

test('parseUrl sftp keeps colons in the remote path', () => {
    assert.deepEqual(Repos.parseUrl('sftp:nas.lan:/vol/a:b/restic'),
        { kind: 'sftp', host: 'nas.lan', path: '/vol/a:b/restic' });
});

test('parseUrl rest keeps the whole URL including its port', () => {
    assert.deepEqual(Repos.parseUrl('rest:https://rest.example:8000/'),
        { kind: 'rest', url: 'https://rest.example:8000/' });
});

test('parseUrl s3 splits endpoint and bucket', () => {
    assert.deepEqual(Repos.parseUrl('s3:s3.eu-central-1.amazonaws.com/hangar'),
        { kind: 's3', endpoint: 's3.eu-central-1.amazonaws.com', bucket: 'hangar' });
});

test('parseUrl s3 collects the remainder as a prefix', () => {
    assert.deepEqual(Repos.parseUrl('s3:s3.amazonaws.com/hangar/hosts/db01'),
        { kind: 's3', endpoint: 's3.amazonaws.com', bucket: 'hangar', prefix: 'hosts/db01' });
});

test('parseUrl s3 keeps an https endpoint together with its port', () => {
    assert.deepEqual(Repos.parseUrl('s3:https://minio.lan:9000/hangar'),
        { kind: 's3', endpoint: 'https://minio.lan:9000', bucket: 'hangar' });
});

test('parseUrl s3 normalises a trailing slash away', () => {
    assert.deepEqual(Repos.parseUrl('s3:s3.amazonaws.com/hangar/'),
        { kind: 's3', endpoint: 's3.amazonaws.com', bucket: 'hangar' });
});

test('parseUrl b2 with and without a path', () => {
    assert.deepEqual(Repos.parseUrl('b2:hangar:srv/db01'), { kind: 'b2', bucket: 'hangar', prefix: 'srv/db01' });
    assert.deepEqual(Repos.parseUrl('b2:hangar'), { kind: 'b2', bucket: 'hangar' });
});

test('parseUrl azure', () => {
    assert.deepEqual(Repos.parseUrl('azure:backups:db01'), { kind: 'azure', container: 'backups', prefix: 'db01' });
});

test('parseUrl gs', () => {
    assert.deepEqual(Repos.parseUrl('gs:hangar-gs:a/b'), { kind: 'gs', bucket: 'hangar-gs', prefix: 'a/b' });
});

test('parseUrl rclone keeps a nested path with colons', () => {
    assert.deepEqual(Repos.parseUrl('rclone:gdrive:backups/2026:07'),
        { kind: 'rclone', remote: 'gdrive', prefix: 'backups/2026:07' });
});

test('parseUrl is case-insensitive about the scheme', () => {
    assert.equal(Repos.parseUrl('SFTP:nas.lan:/vol/restic').kind, 'sftp');
});

test('parseUrl throws GENERIC on empty and whitespace-only input', () => {
    assertGeneric(() => Repos.parseUrl(''));
    assertGeneric(() => Repos.parseUrl('   '));
    assertGeneric(() => Repos.parseUrl('\n\t'));
});

test('parseUrl throws GENERIC on null, undefined and non-strings', () => {
    assertGeneric(() => Repos.parseUrl(null));
    assertGeneric(() => Repos.parseUrl(undefined));
    assertGeneric(() => Repos.parseUrl(42));
    assertGeneric(() => Repos.parseUrl({ kind: 'local' }));
    assertGeneric(() => Repos.parseUrl(['/srv']));
});

// ---------------------------------------------------------------- round trips

const ROUND_TRIP_URLS = [
    '/srv/backups',
    './repo',
    '../sibling/repo',
    '~/backups',
    'C:\\backups\\restic',
    '/mnt/vol:1/restic',
    'sftp:backup@nas.lan:/vol/restic',
    'sftp:nas.lan:/vol/restic',
    'sftp:nas.lan:/vol/a:b/restic',
    'rest:https://rest.example:8000/',
    'rest:http://10.0.0.4:8000/hangar',
    's3:s3.eu-central-1.amazonaws.com/hangar',
    's3:s3.amazonaws.com/hangar/hosts/db01',
    's3:https://minio.lan:9000/hangar/db01',
    'b2:hangar',
    'b2:hangar:srv/db01',
    'azure:backups:db01',
    'gs:hangar-gs:a/b',
    'rclone:gdrive:backups/db01',
    'rclone:gdrive'
];

ROUND_TRIP_URLS.forEach((url) => {
    test('round trip buildUrl(parseUrl(x)) === x for ' + url, () => {
        assert.equal(Repos.buildUrl(Repos.parseUrl(url)), url);
    });
});

test('round trip parseUrl(buildUrl(repo)) recovers every field', () => {
    const repos = [
        { kind: 'local', path: '/srv/backups' },
        { kind: 'sftp', user: 'backup', host: 'nas.lan', path: '/vol/restic' },
        { kind: 'sftp', host: 'nas.lan', path: '/vol/restic' },
        { kind: 'rest', url: 'https://rest.example:8000/' },
        { kind: 's3', endpoint: 's3.amazonaws.com', bucket: 'hangar', prefix: 'db01' },
        { kind: 'b2', bucket: 'hangar', prefix: 'srv' },
        { kind: 'azure', container: 'backups', prefix: 'db01' },
        { kind: 'gs', bucket: 'hangar-gs', prefix: 'a/b' },
        { kind: 'rclone', remote: 'gdrive', prefix: 'backups' }
    ];
    repos.forEach((r) => assert.deepEqual(Repos.parseUrl(Repos.buildUrl(r)), r));
});

test('round trip survives unicode in paths and remotes', () => {
    ['/srv/yedekler/ünité-π', 'rclone:günlük:yedek/ölçüm', 'sftp:kullanıcı@sunucu.lan:/veri/日本語']
        .forEach((u) => assert.equal(Repos.buildUrl(Repos.parseUrl(u)), u));
});

test('round trip survives spaces in paths', () => {
    ['/srv/My Backups/restic', 'b2:my bucket:some path', 'rest:https://host:8000/a b']
        .forEach((u) => assert.equal(Repos.buildUrl(Repos.parseUrl(u)), u));
});

test('round trip survives a very long path', () => {
    const long = '/srv/' + 'a'.repeat(4000) + '/restic';
    const parsed = Repos.parseUrl(long);
    assert.equal(parsed.kind, 'local');
    assert.equal(Repos.buildUrl(parsed), long);
});

test('round trip preserves a traversal path verbatim rather than resolving it', () => {
    assert.equal(Repos.buildUrl(Repos.parseUrl('/srv/../etc/hangar')), '/srv/../etc/hangar');
});

// ---------------------------------------------------------------- validate

test('validate accepts a well-formed local repository', () => {
    assert.deepEqual(Repos.validate({ id: 'nas-1', kind: 'local', path: '/srv/backups' }), []);
});

test('validate accepts a well-formed s3 repository', () => {
    assert.deepEqual(Repos.validate({ id: 'offsite', kind: 's3', endpoint: 's3.amazonaws.com', bucket: 'hangar' }), []);
});

test('validate reports a missing id', () => {
    const p = Repos.validate({ kind: 'local', path: '/srv/backups' });
    assert.deepEqual(p, ['Repository id is required.']);
});

test('validate reports a whitespace-only id', () => {
    assert.deepEqual(Repos.validate({ id: '   ', kind: 'local', path: '/srv/backups' }),
        ['Repository id is required.']);
});

test('validate rejects an empty-string id', () => {
    assert.deepEqual(Repos.validate({ id: '', kind: 'local', path: '/srv/backups' }),
        ['Repository id is required.']);
});

test('validate rejects ids outside [a-z0-9-]', () => {
    ['NAS', 'nas_1', 'nas 1', 'nas.1', 'nas/1', 'nas:1', 'yedek-ü', '../nas']
        .forEach((id) => {
            const p = Repos.validate({ id: id, kind: 'local', path: '/srv/backups' });
            assert.equal(p.length, 1, 'expected exactly one problem for id ' + id + ', got ' + JSON.stringify(p));
            assert.match(p[0], /lowercase letters, digits and hyphens/);
        });
});

test('validate accepts digits and hyphens in an id', () => {
    assert.deepEqual(Repos.validate({ id: 'nas-01-offsite', kind: 'local', path: '/srv/b' }), []);
});

test('validate reports an unknown kind and stops there', () => {
    const p = Repos.validate({ id: 'x', kind: 'dropbox' });
    assert.deepEqual(p, ['Unknown repository kind: dropbox.']);
});

test('validate reports a missing kind', () => {
    assert.deepEqual(Repos.validate({ id: 'x' }), ['Unknown repository kind: (empty).']);
});

test('validate on null and non-objects', () => {
    assert.deepEqual(Repos.validate(null), ['Repository definition is missing.']);
    assert.deepEqual(Repos.validate(undefined), ['Repository definition is missing.']);
    assert.deepEqual(Repos.validate('/srv/backups'), ['Repository definition is missing.']);
});

test('validate rejects a relative local path', () => {
    const p = Repos.validate({ id: 'x', kind: 'local', path: './repo' });
    assert.deepEqual(p, ['Local repository path must be absolute.']);
});

test('validate rejects a ~ local path because units have no shell expansion', () => {
    assert.deepEqual(Repos.validate({ id: 'x', kind: 'local', path: '~/repo' }),
        ['Local repository path must be absolute.']);
});

test('validate rejects path traversal in a local path', () => {
    assert.deepEqual(Repos.validate({ id: 'x', kind: 'local', path: '/srv/../etc/hangar' }),
        ['Repository path must not contain "..".']);
});

test('validate rejects path traversal in an sftp path', () => {
    assert.deepEqual(Repos.validate({ id: 'x', kind: 'sftp', host: 'nas.lan', path: '/vol/../etc' }),
        ['Repository path must not contain "..".']);
});

test('validate allows a filename that merely starts with dots', () => {
    assert.deepEqual(Repos.validate({ id: 'x', kind: 'local', path: '/srv/..hidden/repo' }), []);
});

test('validate reports every missing required field for a kind', () => {
    assert.deepEqual(Repos.validate({ id: 'x', kind: 'sftp' }),
        ['SFTP repository requires a host.', 'SFTP repository requires a path.']);
});

test('validate reports a missing s3 bucket', () => {
    assert.deepEqual(Repos.validate({ id: 'x', kind: 's3', endpoint: 's3.amazonaws.com' }),
        ['S3 repository requires a bucket.']);
});

test('validate reports a missing rclone remote', () => {
    assert.deepEqual(Repos.validate({ id: 'x', kind: 'rclone' }),
        ['rclone repository requires a remote.']);
});

test('validate reports a missing azure container and gs bucket', () => {
    assert.deepEqual(Repos.validate({ id: 'x', kind: 'azure' }),
        ['Azure repository requires a container.']);
    assert.deepEqual(Repos.validate({ id: 'x', kind: 'gs' }),
        ['Google Cloud Storage repository requires a bucket.']);
});

test('validate rejects a rest URL without an http scheme', () => {
    assert.deepEqual(Repos.validate({ id: 'x', kind: 'rest', url: 'rest.example:8000' }),
        ['REST repository URL must start with http:// or https://.']);
});

test('validate accepts a plain http rest URL', () => {
    assert.deepEqual(Repos.validate({ id: 'x', kind: 'rest', url: 'http://10.0.0.4:8000/' }), []);
});

test('validate accumulates id and field problems together', () => {
    const p = Repos.validate({ id: 'BAD ID', kind: 'local', path: 'relative/repo' });
    assert.equal(p.length, 2);
});

// ---------------------------------------------------------------- envFor

test('envFor s3 emits the AWS credential pair', () => {
    assert.deepEqual(Repos.envFor({ kind: 's3', accessKeyId: 'AKIA1', secretAccessKey: 'sec' }),
        { AWS_ACCESS_KEY_ID: 'AKIA1', AWS_SECRET_ACCESS_KEY: 'sec' });
});

test('envFor b2 emits the account pair', () => {
    assert.deepEqual(Repos.envFor({ kind: 'b2', accountId: 'id1', accountKey: 'k1' }),
        { B2_ACCOUNT_ID: 'id1', B2_ACCOUNT_KEY: 'k1' });
});

test('envFor azure emits the account pair', () => {
    assert.deepEqual(Repos.envFor({ kind: 'azure', accountName: 'acct', accountKey: 'k2' }),
        { AZURE_ACCOUNT_NAME: 'acct', AZURE_ACCOUNT_KEY: 'k2' });
});

test('envFor gs emits only the project id', () => {
    assert.deepEqual(Repos.envFor({ kind: 'gs', projectId: 'proj-1' }), { GOOGLE_PROJECT_ID: 'proj-1' });
});

test('envFor omits blank credential values', () => {
    assert.deepEqual(Repos.envFor({ kind: 's3', accessKeyId: 'AKIA1', secretAccessKey: '  ' }),
        { AWS_ACCESS_KEY_ID: 'AKIA1' });
});

test('envFor returns an empty object for credential-free backends', () => {
    ['local', 'sftp', 'rest', 'rclone'].forEach((kind) => {
        assert.deepEqual(Repos.envFor({ kind: kind, path: '/srv' }), {});
    });
});

test('envFor returns an empty object for null and unknown kinds', () => {
    assert.deepEqual(Repos.envFor(null), {});
    assert.deepEqual(Repos.envFor({ kind: 'dropbox', accessKeyId: 'x' }), {});
});

test('envFor never leaks the repository password', () => {
    const env = Repos.envFor({ kind: 's3', accessKeyId: 'AKIA1', secretAccessKey: 'sec', password: 'hunter2' });
    assert.deepEqual(Object.keys(env).sort(), ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
    assert.equal(JSON.stringify(env).includes('hunter2'), false);
    assert.equal('RESTIC_PASSWORD' in env, false);
});

// ---------------------------------------------------------------- describe

test('describe produces a sentence per backend', () => {
    assert.equal(Repos.describe({ kind: 'local', path: '/srv/backups' }), 'Local folder at /srv/backups.');
    assert.equal(Repos.describe({ kind: 'sftp', user: 'backup', host: 'nas.lan', path: '/vol/r' }),
        'SFTP at backup@nas.lan:/vol/r.');
    assert.equal(Repos.describe({ kind: 'sftp', host: 'nas.lan', path: '/vol/r' }), 'SFTP at nas.lan:/vol/r.');
    assert.equal(Repos.describe({ kind: 'rest', url: 'https://r.example:8000/' }),
        'REST server at https://r.example:8000/.');
    assert.equal(Repos.describe({ kind: 'rclone', remote: 'gdrive' }), 'rclone remote gdrive.');
});

test('describe mentions the prefix when there is one', () => {
    assert.equal(Repos.describe({ kind: 's3', endpoint: 's3.amazonaws.com', bucket: 'hangar', prefix: 'db01' }),
        'S3 bucket hangar on s3.amazonaws.com under db01.');
    assert.equal(Repos.describe({ kind: 'b2', bucket: 'hangar' }), 'Backblaze B2 bucket hangar.');
    assert.equal(Repos.describe({ kind: 'azure', container: 'backups', prefix: 'db01' }),
        'Azure container backups under db01.');
    assert.equal(Repos.describe({ kind: 'gs', bucket: 'g1' }), 'Google Cloud Storage bucket g1.');
});

test('describe never throws on garbage', () => {
    assert.equal(Repos.describe(null), 'Unknown repository.');
    assert.equal(Repos.describe({}), 'Unknown repository.');
    assert.equal(Repos.describe('x'), 'Unknown repository.');
    assert.equal(Repos.describe({ kind: 'dropbox' }), 'Unknown repository.');
});

test('describe covers every declared kind', () => {
    Repos.KINDS.forEach((kind) => {
        assert.notEqual(Repos.describe({ kind: kind }), 'Unknown repository.', 'no sentence for ' + kind);
    });
});

// ------------------------------------------------------------ the size limit
//
// `sizeLimit` (free text) and `minSnapshots` (the floor) are repository fields:
// capacity belongs to the destination, not to a job. repos.js does not enforce
// them — core/sizeguard.js does — it only has to carry them through validate()
// and describe() without inventing a value or losing one.

const Guard = require('../../js/core/sizeguard.js');

test('a repository with no size limit is unchanged — that is the default', () => {
    assert.deepEqual(Repos.validate({ id: 'nas', kind: 'local', path: '/srv/b' }), []);
    assert.equal(Repos.describe({ kind: 'local', path: '/srv/b' }), 'Local folder at /srv/b.');
});

test('validate accepts every size spelling core/sizeguard.js can read', () => {
    ['500 GB', '500GB', '1.5 TiB', '800M', '2T', '1000000000'].forEach((limit) => {
        assert.deepEqual(Repos.validate({ id: 'nas', kind: 'local', path: '/srv/b', sizeLimit: limit }),
            [], limit);
    });
});

test('validate rejects a limit nobody can read rather than guessing at one', () => {
    // A misparsed limit is not a cosmetic bug: it is a decision to delete backups.
    ['lots', '500 GB extra', '1e3', '1,000 GB', '0x10', '500 GB\n1 TB'].forEach((limit) => {
        const p = Repos.validate({ id: 'nas', kind: 'local', path: '/srv/b', sizeLimit: limit });
        assert.equal(p.length, 1, 'accepted ' + JSON.stringify(limit));
        assert.match(p[0], /not a size hangar can read/i);
    });
});

test('a whitespace-only limit is no limit at all, not a broken one', () => {
    ['   ', '\t', '\n\n'].forEach((limit) => {
        assert.deepEqual(Repos.validate({ id: 'nas', kind: 'local', path: '/srv/b', sizeLimit: limit }),
            [], JSON.stringify(limit));
        assert.equal(Repos.describe({ kind: 'local', path: '/srv/b', sizeLimit: limit }),
            'Local folder at /srv/b.');
    });
});

test('validate rejects a limit of zero or less', () => {
    ['0', '-5 GB', '0 GB'].forEach((limit) => {
        assert.deepEqual(Repos.validate({ id: 'nas', kind: 'local', path: '/srv/b', sizeLimit: limit }),
            ['A size limit must be greater than zero.'], limit);
    });
});

test('a suspiciously small limit is a WARNING, so it still saves', () => {
    // "500" means 500 bytes. That is almost certainly a missing unit — but a tiny
    // repository of text files is a legitimate thing to cap, so validate() must
    // not veto it. The editor says so beside the field instead.
    assert.deepEqual(Repos.validate({ id: 'nas', kind: 'local', path: '/srv/b', sizeLimit: '500' }), []);
    assert.ok(Guard.validateGuard({ limit: '500' }).some((p) => p.detail.severity === 'warning'));
});

test('validate rejects a floor that is not a whole number', () => {
    [
        '3', 2.5, -1, NaN, Number.MAX_SAFE_INTEGER + 2, {}, [], true
    ].forEach((min) => {
        const p = Repos.validate({ id: 'nas', kind: 'local', path: '/srv/b',
            sizeLimit: '500 GB', minSnapshots: min });
        assert.equal(p.length, 1, 'accepted floor ' + JSON.stringify(min));
        assert.match(p[0], /whole number|at least 1/);
    });
});

test('validate rejects a floor of 0 — the limit must never delete the last backup', () => {
    const p = Repos.validate({ id: 'nas', kind: 'local', path: '/srv/b',
        sizeLimit: '500 GB', minSnapshots: 0 });
    assert.equal(p.length, 1);
    assert.match(p[0], /at least 1/);
});

test('a floor of 1 is a WARNING, so it still saves', () => {
    assert.deepEqual(Repos.validate({ id: 'nas', kind: 'local', path: '/srv/b',
        sizeLimit: '500 GB', minSnapshots: 1 }), []);
});

test('a malformed floor is reported even when no limit is set', () => {
    // The floor is inert without a limit, but a value nobody can read must not sit
    // in the file waiting to surprise whoever adds the limit later.
    const p = Repos.validate({ id: 'nas', kind: 'local', path: '/srv/b', minSnapshots: 'three' });
    assert.equal(p.length, 1);
    assert.match(p[0], /whole number/);
});

test('a missing limit is never reported as a fault — it is the default state', () => {
    // sizeguard's own validateGuard says "Enter a size limit", which is right for a
    // guard being configured and wrong for a repository that does not use one.
    assert.ok(Guard.validateGuard({}).some((p) => p.detail.code === 'limit-missing'));
    Repos.validate({ id: 'nas', kind: 'local', path: '/srv/b' })
        .forEach((p) => assert.doesNotMatch(p, /Enter a size limit/));
});

test('size problems are reported alongside the ordinary field problems', () => {
    const p = Repos.validate({ id: 'BAD ID', kind: 'local', path: 'relative', sizeLimit: 'lots' });
    assert.equal(p.length, 3);
});

test('a size problem is reported even when the backend is unknown', () => {
    // The limit belongs to the repository, not to a backend, so it cannot be
    // hidden behind a kind that is also wrong.
    const p = Repos.validate({ id: 'x', kind: 'dropbox', sizeLimit: '-1 GB' });
    assert.equal(p.length, 2);
    assert.match(p.join(' '), /greater than zero/);
});

test('validate still never throws on a hostile size limit', () => {
    // Labelled by index, not by String(value): Object.create(null) cannot be
    // stringified, and a test that throws while writing its own failure message
    // hides the thing it was testing.
    [Symbol('s'), {}, [], () => 1, Object.create(null), 5, true, NaN].forEach((limit, i) => {
        const repo = { id: 'x', kind: 'local', path: '/srv', sizeLimit: limit };
        assert.equal(survives(() => Repos.validate(repo)), null, 'threw for input ' + i);
        assert.ok(Array.isArray(Repos.validate(repo)));
    });
});

test('describe echoes the limit FORMATTED, so the units can be checked by eye', () => {
    // "500G" is 500 GB and "500" is 500 bytes. Echoing the typed text back would
    // prove nothing; echoing the parsed size proves it was understood.
    assert.equal(Repos.describe({ kind: 'local', path: '/srv/b', sizeLimit: '500G' }),
        'Local folder at /srv/b. Kept under 465.7 GiB, never fewer than 3 snapshots.');
    assert.equal(Repos.describe({ kind: 'local', path: '/srv/b', sizeLimit: '1 TiB' }),
        'Local folder at /srv/b. Kept under 1 TiB, never fewer than 3 snapshots.');
});

test('describe names the floor that will actually apply, default included', () => {
    const at = (min) => Repos.describe({ kind: 'b2', bucket: 'hangar', sizeLimit: '2 TB', minSnapshots: min });
    assert.match(at(undefined), /never fewer than 3 snapshots\.$/);
    assert.match(at(10), /never fewer than 10 snapshots\.$/);
    // Singular, because "1 snapshots" is how a sentence tells you it was generated.
    assert.match(at(1), /never fewer than 1 snapshot\.$/);
    // Whatever the file says, the floor can never be below 1.
    assert.match(at(0), /never fewer than 1 snapshot\.$/);
});

test('describe echoes an unreadable limit verbatim rather than dropping it', () => {
    // describe() is what the delete confirmation shows. A setting nobody could
    // parse must not vanish from the one sentence the user reads.
    assert.equal(Repos.describe({ kind: 'local', path: '/srv/b', sizeLimit: 'lots' }),
        'Local folder at /srv/b. Kept under lots, never fewer than 3 snapshots.');
});

test('describe adds no size sentence to a repository it cannot locate', () => {
    assert.equal(Repos.describe({ kind: 'dropbox', sizeLimit: '500 GB' }), 'Unknown repository.');
});

test('describe carries the limit through every backend', () => {
    Repos.KINDS.forEach((kind) => {
        assert.match(Repos.describe({ kind: kind, sizeLimit: '500 GB' }),
            / Kept under 465.7 GiB, never fewer than 3 snapshots\.$/, kind);
    });
});

test('describe never throws on a hostile size limit', () => {
    [Symbol('s'), {}, [], Object.create(null), NaN, -1].forEach((limit, i) => {
        const repo = { kind: 'local', path: '/srv', sizeLimit: limit, minSnapshots: Symbol('m') };
        assert.equal(survives(() => Repos.describe(repo)), null, 'threw for input ' + i);
        assert.equal(typeof Repos.describe(repo), 'string');
    });
});

// ---------------------------------------------------------------- rclone remotes

test('parseRcloneRemotes reads the synthetic listremotes fixture', () => {
    const text = fs.readFileSync(path.join(FIXTURES, 'rclone', 'synthetic-listremotes.txt'), 'utf8');
    assert.deepEqual(Repos.parseRcloneRemotes(text), ['gdrive', 's3-cold', 'onedrive-work', 'box']);
});

test('parseRcloneRemotes tolerates CRLF, blank lines and stray indentation', () => {
    assert.deepEqual(Repos.parseRcloneRemotes('gdrive:\r\n\r\n  box:  \r\n'), ['gdrive', 'box']);
});

test('parseRcloneRemotes on empty, null and non-string input', () => {
    assert.deepEqual(Repos.parseRcloneRemotes(''), []);
    assert.deepEqual(Repos.parseRcloneRemotes(null), []);
    assert.deepEqual(Repos.parseRcloneRemotes(undefined), []);
    assert.deepEqual(Repos.parseRcloneRemotes('\n\n\n'), []);
});

test('parseRcloneRemotes keeps unicode remote names and drops the trailing colon once', () => {
    assert.deepEqual(Repos.parseRcloneRemotes('günlük:\nödev-yedek:\n'), ['günlük', 'ödev-yedek']);
});

test('listRcloneRemotes resolves to [] when cockpit is absent', async () => {
    assert.deepEqual(await Repos.listRcloneRemotes(), []);
});

test('module exposes the expected surface and no ES module syntax', () => {
    ['buildUrl', 'parseUrl', 'validate', 'envFor', 'describe', 'parseRcloneRemotes', 'listRcloneRemotes']
        .forEach((fn) => assert.equal(typeof Repos[fn], 'function', 'missing ' + fn));
    assert.deepEqual(Repos.KINDS, ['local', 'sftp', 'rest', 's3', 'b2', 'azure', 'gs', 'rclone']);
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'core', 'repos.js'), 'utf8');
    assert.equal(/^\s*(import|export)\s/m.test(src), false, 'ES module syntax found');
});

// ================================================================ adversarial
//
// Everything below attacks the module rather than demonstrating it. The standing
// contract under attack: a hostile value may be rejected with a HangarError, or
// carried through verbatim, but it may never escape as an untyped exception —
// an untyped throw crosses into Alpine's render loop and blanks the page.

// Values that are not repository objects. Symbols are included because String()
// accepts them where "" + x would throw, so they reach further in than they look.
const NOT_OBJECTS = [null, undefined, 0, 1, -1, NaN, Infinity, '', 'x', true, false,
    function () {}, Symbol('repo'), 9007199254740993n];

// Values that ARE objects but carry no usable kind.
const EMPTY_OBJECTS = [{}, [], ['local'], new Date(0), Object.create(null), /re/];

const CONTROL_CHARS = ['\0', '\n', '\r', '\r\n', '\t', '\u0007', '\u2028', '\u202e'];

// Shell metacharacters matter because the repository URL becomes one argv element
// under cockpit.spawn — never a shell word. Any of these being mangled or rejected
// would be the bug; passing through untouched is the correct behaviour.
const SHELL_META = ['$(id)', '`id`', '; rm -rf /', '&& reboot', '| tee /etc/passwd',
    '$HOME', '${IFS}', '\'quoted\'', '"quoted"', '*', '?', '!!', '\\'];

function assertHangar(fn) {
    assert.throws(fn, (e) => {
        assert.ok(Errors.isHangarError(e), 'expected a HangarError, got ' + String(e && e.stack));
        return true;
    });
}

// Calls fn and reports only whether it escaped as something other than a HangarError.
function survives(fn) {
    try {
        fn();
    } catch (e) {
        if (!Errors.isHangarError(e)) return 'untyped ' + (e && e.name) + ': ' + (e && e.message);
    }
    return null;
}

// ---------------------------------------------------------- buildUrl hostile

test('buildUrl rejects every non-object with a typed error', () => {
    NOT_OBJECTS.forEach((v) => assertGeneric(() => Repos.buildUrl(v)));
});

test('buildUrl rejects objects with no usable kind', () => {
    EMPTY_OBJECTS.forEach((v) => assertGeneric(() => Repos.buildUrl(v)));
});

test('buildUrl rejects every kind spelled in the wrong case', () => {
    Repos.KINDS.forEach((kind) => {
        assertGeneric(() => Repos.buildUrl({ kind: kind.toUpperCase(), path: '/x', host: 'h', url: 'http://h',
            endpoint: 'e', bucket: 'b', container: 'c', remote: 'r' }));
    });
});

test('buildUrl rejects a kind that only looks like one after trimming', () => {
    [' local', 'local ', 'local\n', 'lo cal', 'local\0'].forEach((kind) => {
        assertGeneric(() => Repos.buildUrl({ kind: kind, path: '/x' }));
    });
});

test('buildUrl demands each required field of each kind independently', () => {
    const full = { path: '/x', host: 'h', url: 'http://h/', endpoint: 'e', bucket: 'b', container: 'c', remote: 'r' };
    Repos.KINDS.forEach((kind) => {
        Repos.REQUIRED[kind].forEach((missing) => {
            const repo = Object.assign({ kind: kind }, full);
            delete repo[missing];
            assertGeneric(() => Repos.buildUrl(repo));
        });
    });
});

test('buildUrl treats empty string, whitespace and empty array as a missing field alike', () => {
    ['', '   ', '\t\n', [], null, undefined].forEach((v) => {
        assertGeneric(() => Repos.buildUrl({ kind: 'local', path: v }));
        assertGeneric(() => Repos.buildUrl({ kind: 'rclone', remote: v }));
    });
});

test('buildUrl carries the offending field and kind in the error detail', () => {
    try {
        Repos.buildUrl({ kind: 's3', endpoint: 's3.amazonaws.com' });
        assert.fail('expected a throw');
    } catch (e) {
        assert.deepEqual(e.detail, { field: 'bucket', kind: 's3' });
    }
});

test('buildUrl detail is the offending kind for an unknown kind, and null for a null repo', () => {
    try {
        Repos.buildUrl({ kind: 'dropbox' });
        assert.fail('expected a throw');
    } catch (e) {
        assert.equal(e.detail, 'dropbox');
    }
    try {
        Repos.buildUrl(null);
        assert.fail('expected a throw');
    } catch (e) {
        assert.equal(e.detail, null);
    }
});

test('buildUrl says "an endpoint", not "a endpoint"', () => {
    try {
        Repos.buildUrl({ kind: 's3', bucket: 'hangar' });
        assert.fail('expected a throw');
    } catch (e) {
        assert.equal(e.message, 'S3 repository requires an endpoint.');
    }
});

test('buildUrl passes shell metacharacters through untouched — the URL is one argv element', () => {
    SHELL_META.forEach((meta) => {
        assert.equal(Repos.buildUrl({ kind: 'local', path: '/srv/' + meta }), '/srv/' + meta);
        assert.equal(Repos.buildUrl({ kind: 'b2', bucket: 'hangar', prefix: meta }), 'b2:hangar:' + meta);
    });
});

test('buildUrl passes control characters and a NUL byte through untouched', () => {
    CONTROL_CHARS.forEach((c) => {
        assert.equal(Repos.buildUrl({ kind: 'local', path: '/srv/a' + c + 'b' }), '/srv/a' + c + 'b');
    });
});

test('buildUrl does not resolve or normalise a traversal path', () => {
    assert.equal(Repos.buildUrl({ kind: 'local', path: '/srv/../../etc/shadow' }), '/srv/../../etc/shadow');
    assert.equal(Repos.buildUrl({ kind: 'sftp', host: 'nas.lan', path: '/vol/../..' }), 'sftp:nas.lan:/vol/../..');
});

test('buildUrl survives a 200k-character path', () => {
    const p = '/srv/' + 'x'.repeat(200000);
    assert.equal(Repos.buildUrl({ kind: 'local', path: p }).length, p.length);
});

test('buildUrl coerces numeric and boolean fields rather than throwing', () => {
    assert.equal(Repos.buildUrl({ kind: 'local', path: 0 }), '0');
    assert.equal(Repos.buildUrl({ kind: 'rclone', remote: 'r', prefix: 7 }), 'rclone:r:7');
    assert.equal(Repos.buildUrl({ kind: 'gs', bucket: 'b', prefix: false }), 'gs:b:false');
});

test('buildUrl omits an absent prefix for every two-segment backend', () => {
    [['b2', 'bucket'], ['azure', 'container'], ['gs', 'bucket'], ['rclone', 'remote']].forEach((pair) => {
        const repo = { kind: pair[0] };
        repo[pair[1]] = 'name';
        assert.equal(Repos.buildUrl(repo), pair[0] + ':name');
        assert.equal(Repos.buildUrl(Object.assign({ prefix: '' }, repo)), pair[0] + ':name');
        assert.equal(Repos.buildUrl(Object.assign({ prefix: null }, repo)), pair[0] + ':name');
    });
});

test('buildUrl s3 omits the prefix separator when there is no prefix', () => {
    assert.equal(Repos.buildUrl({ kind: 's3', endpoint: 'e', bucket: 'b', prefix: null }), 's3:e/b');
    assert.equal(Repos.buildUrl({ kind: 's3', endpoint: 'e', bucket: 'b', prefix: undefined }), 's3:e/b');
});

test('buildUrl is not fooled by a JSON payload carrying __proto__', () => {
    const poisoned = JSON.parse('{"__proto__":{"kind":"local","path":"/pwned"}}');
    assertGeneric(() => Repos.buildUrl(poisoned));
    assert.equal({}.kind, undefined, 'Object.prototype was polluted');
    assert.equal({}.path, undefined, 'Object.prototype was polluted');
});

// ---------------------------------------------------------- parseUrl hostile

test('parseUrl rejects every non-string with a typed error', () => {
    NOT_OBJECTS.concat(EMPTY_OBJECTS).filter((v) => typeof v !== 'string')
        .forEach((v) => assertGeneric(() => Repos.parseUrl(v)));
});

test('parseUrl rejects a boxed String because only a primitive is a URL here', () => {
    assertGeneric(() => Repos.parseUrl(new String('/srv/backups')));   // eslint-disable-line no-new-wrappers
});

test('parseUrl rejects every whitespace-only string', () => {
    ['', ' ', '\t', '\n', '\r\n', '   \t\n  ', '\f', '\v'].forEach((s) => assertGeneric(() => Repos.parseUrl(s)));
});

test('parseUrl carries the offending input in the error detail', () => {
    try {
        Repos.parseUrl('   ');
        assert.fail('expected a throw');
    } catch (e) {
        assert.equal(e.detail, '   ');
        assert.equal(Errors.isFatal(e), true);
        assert.equal(Errors.remediationFor(e), null);
    }
});

test('parseUrl treats a lone NUL byte as a local path rather than an empty URL', () => {
    // trim() does not strip NUL, so this is deliberately not "empty".
    assert.deepEqual(Repos.parseUrl('\0'), { kind: 'local', path: '\0' });
    assert.deepEqual(Repos.parseUrl('/srv/a\0b'), { kind: 'local', path: '/srv/a\0b' });
});

test('parseUrl keeps embedded newlines in a local path instead of splitting on them', () => {
    assert.deepEqual(Repos.parseUrl('/srv/a\nb'), { kind: 'local', path: '/srv/a\nb' });
    assert.deepEqual(Repos.parseUrl('/srv/a\r\nb'), { kind: 'local', path: '/srv/a\r\nb' });
});

test('parseUrl keeps shell metacharacters in a local path', () => {
    SHELL_META.forEach((meta) => {
        assert.deepEqual(Repos.parseUrl('/srv/' + meta), { kind: 'local', path: '/srv/' + meta });
    });
});

test('parseUrl never invents a scheme out of a non-restic one', () => {
    ['ftp:host/p', 'http://example/p', 'https://example/p', 'file:///srv', 'ssh://h/p',
        'swift:c:p', 'gcs:b:p', 'S3X:h/b', 's3x:h/b', 'azurex:c', 'data:text/plain,x']
        .forEach((s) => assert.deepEqual(Repos.parseUrl(s), { kind: 'local', path: s }));
});

test('parseUrl only accepts a scheme at position zero', () => {
    ['/mnt/b2:bucket/repo', '/mnt/rclone:remote/repo', 'x/sftp:h:/p', ' sftp:h:/p', ':sftp:h:/p']
        .forEach((s) => assert.equal(Repos.parseUrl(s).kind, 'local', s));
});

test('parseUrl treats a bare colon-prefixed string as a local path', () => {
    assert.deepEqual(Repos.parseUrl(':/srv'), { kind: 'local', path: ':/srv' });
    assert.deepEqual(Repos.parseUrl('::'), { kind: 'local', path: '::' });
});

test('parseUrl accepts every scheme in mixed case and lowercases only the kind', () => {
    assert.deepEqual(Repos.parseUrl('SfTp:NAS.LAN:/Vol/R'), { kind: 'sftp', host: 'NAS.LAN', path: '/Vol/R' });
    assert.deepEqual(Repos.parseUrl('S3:HOST/BUCKET'), { kind: 's3', endpoint: 'HOST', bucket: 'BUCKET' });
    assert.deepEqual(Repos.parseUrl('RCLONE:GDrive:P'), { kind: 'rclone', remote: 'GDrive', prefix: 'P' });
    assert.deepEqual(Repos.parseUrl('Rest:https://H/'), { kind: 'rest', url: 'https://H/' });
});

test('parseUrl on a scheme with nothing after it yields blank fields, not a throw', () => {
    assert.deepEqual(Repos.parseUrl('sftp:'), { kind: 'sftp', host: '', path: '' });
    assert.deepEqual(Repos.parseUrl('rest:'), { kind: 'rest', url: '' });
    assert.deepEqual(Repos.parseUrl('s3:'), { kind: 's3', endpoint: '', bucket: '' });
    assert.deepEqual(Repos.parseUrl('b2:'), { kind: 'b2', bucket: '' });
    assert.deepEqual(Repos.parseUrl('azure:'), { kind: 'azure', container: '' });
    assert.deepEqual(Repos.parseUrl('gs:'), { kind: 'gs', bucket: '' });
    assert.deepEqual(Repos.parseUrl('rclone:'), { kind: 'rclone', remote: '' });
});

test('a scheme-only URL parses but cannot be rebuilt — the missing field is reported', () => {
    ['sftp:', 'rest:', 's3:', 'b2:', 'azure:', 'gs:', 'rclone:']
        .forEach((s) => assertGeneric(() => Repos.buildUrl(Repos.parseUrl(s))));
});

test('parseUrl sftp splits the user at the first @ and the host at the first colon', () => {
    assert.deepEqual(Repos.parseUrl('sftp:a@b@c.lan:/p'), { kind: 'sftp', host: 'b@c.lan', path: '/p', user: 'a' });
    assert.deepEqual(Repos.parseUrl('sftp:u@h:'), { kind: 'sftp', host: 'h', path: '', user: 'u' });
});

test('parseUrl sftp drops an empty user rather than emitting user: ""', () => {
    const out = Repos.parseUrl('sftp:@nas.lan:/vol/r');
    assert.deepEqual(out, { kind: 'sftp', host: 'nas.lan', path: '/vol/r' });
    assert.equal('user' in out, false);
});

test('parseUrl sftp with no colon leaves the path empty', () => {
    assert.deepEqual(Repos.parseUrl('sftp:nas.lan'), { kind: 'sftp', host: 'nas.lan', path: '' });
});

test('parseUrl s3 leaves the bucket empty when only an endpoint was given', () => {
    assert.deepEqual(Repos.parseUrl('s3:s3.amazonaws.com'), { kind: 's3', endpoint: 's3.amazonaws.com', bucket: '' });
    assert.deepEqual(Repos.parseUrl('s3:/'), { kind: 's3', endpoint: '', bucket: '' });
});

test('parseUrl s3 collapses repeated slashes', () => {
    assert.deepEqual(Repos.parseUrl('s3:host//bucket//a//b'),
        { kind: 's3', endpoint: 'host', bucket: 'bucket', prefix: 'a/b' });
});

test('parseUrl s3 does not treat a non-http scheme in the endpoint as the endpoint head', () => {
    assert.deepEqual(Repos.parseUrl('s3:ftp://host/bucket'), { kind: 's3', endpoint: 'ftp:', bucket: 'host',
        prefix: 'bucket' });
});

test('parseUrl two-segment backends split at the first colon only', () => {
    assert.deepEqual(Repos.parseUrl('b2:::'), { kind: 'b2', bucket: '', prefix: ':' });
    assert.deepEqual(Repos.parseUrl('rclone:a:b:c'), { kind: 'rclone', remote: 'a', prefix: 'b:c' });
    assert.deepEqual(Repos.parseUrl('azure:c:a:b/c'), { kind: 'azure', container: 'c', prefix: 'a:b/c' });
});

test('parseUrl two-segment backends drop a trailing separator with no path', () => {
    assert.deepEqual(Repos.parseUrl('b2:hangar:'), { kind: 'b2', bucket: 'hangar' });
    assert.deepEqual(Repos.parseUrl('gs:g1:'), { kind: 'gs', bucket: 'g1' });
});

test('parseUrl always returns a plain object whose kind is a declared kind', () => {
    ['/srv', 'sftp:h:/p', 'rest:http://h/', 's3:h/b', 'b2:b', 'azure:c', 'gs:b', 'rclone:r', 'ftp:x', '\0']
        .forEach((s) => {
            const out = Repos.parseUrl(s);
            assert.equal(Object.getPrototypeOf(out), Object.prototype, s);
            assert.ok(Repos.KINDS.indexOf(out.kind) >= 0, 'undeclared kind for ' + s);
        });
});

test('parseUrl survives a 200k-character URL for every scheme', () => {
    const pad = 'y'.repeat(200000);
    assert.equal(Repos.parseUrl('/srv/' + pad).path.length, 5 + pad.length);
    assert.equal(Repos.parseUrl('rclone:r:' + pad).prefix.length, pad.length);
    assert.equal(Repos.parseUrl('rest:https://h/' + pad).url.length, 10 + pad.length);
});

test('parseUrl keeps emoji and RTL-override characters verbatim', () => {
    assert.deepEqual(Repos.parseUrl('/srv/📦/yedek'), { kind: 'local', path: '/srv/📦/yedek' });
    assert.deepEqual(Repos.parseUrl('b2:kova:gizli\u202egpj.exe'),
        { kind: 'b2', bucket: 'kova', prefix: 'gizli\u202egpj.exe' });
});

// ------------------------------------------------------- normalisation is stable

// A URL the user typed non-canonically is rewritten once on save. If a second pass
// rewrote it again, the saved definition would keep drifting on every edit.
const NON_CANONICAL = [
    's3:s3.amazonaws.com/hangar/',
    's3:host//bucket//a//b',
    'b2:hangar:',
    'gs:g1:',
    'sftp:@nas.lan:/vol/r',
    'SFTP:nas.lan:/vol/r',
    '/mnt/s3:old/repo',
    'rclone:gdrive:a:b'
];

NON_CANONICAL.forEach((url) => {
    test('normalisation reaches a fixed point for ' + url, () => {
        const once = Repos.buildUrl(Repos.parseUrl(url));
        assert.equal(Repos.buildUrl(Repos.parseUrl(once)), once);
    });
});

test('round trip survives control characters and shell metacharacters in a local path', () => {
    CONTROL_CHARS.concat(SHELL_META).forEach((c) => {
        const u = '/srv/a' + c + 'b';
        assert.equal(Repos.buildUrl(Repos.parseUrl(u)), u);
    });
});

// ---------------------------------------------------------- validate hostile

test('validate never throws, whatever it is handed', () => {
    const inputs = NOT_OBJECTS.concat(EMPTY_OBJECTS, [
        { id: 'x', kind: 'local', path: Symbol('p') },
        { id: Symbol('i'), kind: 'local', path: '/srv' },
        { id: 'x', kind: Symbol('k') },
        { id: 'x', kind: 'rest', url: 12345 },
        { id: 'x', kind: 'sftp', host: [], path: {} }
    ]);
    inputs.forEach((v) => {
        const bad = survives(() => Repos.validate(v));
        assert.equal(bad, null, 'validate threw for ' + String(v && v.kind) + ': ' + bad);
        assert.ok(Array.isArray(Repos.validate(v)), 'validate did not return an array');
    });
});

test('validate returns a fresh array each call so callers cannot poison the next one', () => {
    const repo = { id: 'x', kind: 'local', path: './rel' };
    const a = Repos.validate(repo);
    a.push('injected');
    assert.deepEqual(Repos.validate(repo), ['Local repository path must be absolute.']);
});

test('validate reports exactly the required fields of every kind for a bare repo', () => {
    Repos.KINDS.forEach((kind) => {
        const p = Repos.validate({ id: 'x', kind: kind });
        assert.equal(p.length, Repos.REQUIRED[kind].length, 'wrong problem count for ' + kind + ': ' +
            JSON.stringify(p));
    });
});

test('validate says "an endpoint", not "a endpoint"', () => {
    assert.deepEqual(Repos.validate({ id: 'x', kind: 's3', bucket: 'hangar' }),
        ['S3 repository requires an endpoint.']);
});

test('validate rejects control characters and a NUL byte in an id', () => {
    CONTROL_CHARS.concat(['\0nas', 'nas\0', 'na\0s']).forEach((c) => {
        const p = Repos.validate({ id: 'nas' + c, kind: 'local', path: '/srv' });
        assert.equal(p.length, 1, 'id ' + JSON.stringify('nas' + c) + ' was accepted');
        assert.match(p[0], /lowercase letters, digits and hyphens/);
    });
});

test('validate rejects an id with leading or trailing spaces', () => {
    [' nas', 'nas ', ' nas '].forEach((id) => {
        assert.deepEqual(Repos.validate({ id: id, kind: 'local', path: '/srv' }),
            ['Repository id may only contain lowercase letters, digits and hyphens.']);
    });
});

test('validate rejects an id with shell metacharacters or emoji', () => {
    SHELL_META.concat(['📦', 'nas&job', 'nas%2e%2e']).forEach((frag) => {
        const p = Repos.validate({ id: 'nas' + frag, kind: 'local', path: '/srv' });
        assert.equal(p.length, 1, 'accepted id nas' + frag);
    });
});

test('validate accepts the shortest legal ids and a very long one', () => {
    ['a', '0', '-', '9', 'z'].forEach((id) => {
        assert.deepEqual(Repos.validate({ id: id, kind: 'local', path: '/srv' }), [], 'rejected id ' + id);
    });
    assert.deepEqual(Repos.validate({ id: 'a'.repeat(100000), kind: 'local', path: '/srv' }), []);
});

test('validate stops after an unknown kind however the kind was spelled', () => {
    [{ kind: 'dropbox' }, { kind: 'LOCAL' }, { kind: ' local' }, { kind: 0 }, { kind: [] }, { kind: {} }]
        .forEach((partial) => {
            const p = Repos.validate(Object.assign({ id: 'x' }, partial));
            assert.equal(p.length, 1, 'expected one problem for ' + JSON.stringify(partial) + ': ' + JSON.stringify(p));
            assert.match(p[0], /^Unknown repository kind: /);
        });
});

test('validate flags "." components only when the component is exactly ".."', () => {
    ['/srv/..', '/..', '/srv/../etc', '/../..', '/srv/sub/../x'].forEach((p) => {
        assert.deepEqual(Repos.validate({ id: 'x', kind: 'local', path: p }),
            ['Repository path must not contain "..".'], 'missed traversal in ' + p);
    });
    ['/srv/...', '/srv/..a', '/srv/a..', '/srv/a..b', '/srv/.hidden', '/.'].forEach((p) => {
        assert.deepEqual(Repos.validate({ id: 'x', kind: 'local', path: p }), [], 'false traversal in ' + p);
    });
});

test('validate reports both problems for a relative traversal path', () => {
    assert.deepEqual(Repos.validate({ id: 'x', kind: 'local', path: '../escape' }),
        ['Local repository path must be absolute.', 'Repository path must not contain "..".']);
});

test('validate rejects a local path that is absolute only after whitespace', () => {
    ['  /srv', '\t/srv', '\n/srv'].forEach((p) => {
        assert.deepEqual(Repos.validate({ id: 'x', kind: 'local', path: p }),
            ['Local repository path must be absolute.'], JSON.stringify(p));
    });
});

test('validate accepts a local path containing spaces, colons and unicode', () => {
    ['/srv/My Backups', '/mnt/vol:1/restic', '/srv/yedekler/ünité', '/srv/📦'].forEach((p) => {
        assert.deepEqual(Repos.validate({ id: 'x', kind: 'local', path: p }), [], p);
    });
});

test('validate does not check traversal for backends where the segment is an object key', () => {
    // b2/azure/gs/s3 prefixes are key names in a flat namespace, not path components.
    assert.deepEqual(Repos.validate({ id: 'x', kind: 'b2', bucket: 'b', prefix: '../../x' }), []);
    assert.deepEqual(Repos.validate({ id: 'x', kind: 's3', endpoint: 'e', bucket: 'b', prefix: '../x' }), []);
});

test('validate rest URL check is case-insensitive and demands both slashes', () => {
    ['HTTPS://r.example/', 'HtTp://r.example/'].forEach((url) => {
        assert.deepEqual(Repos.validate({ id: 'x', kind: 'rest', url: url }), [], url);
    });
    ['https:/r.example/', 'https:r.example', '//r.example/', 'httpss://r/', ' https://r/', 'javascript:alert(1)']
        .forEach((url) => {
            assert.deepEqual(Repos.validate({ id: 'x', kind: 'rest', url: url }),
                ['REST repository URL must start with http:// or https://.'], url);
        });
});

test('validate accumulates every independent problem at once', () => {
    const p = Repos.validate({ id: 'BAD_ID', kind: 'local', path: '../escape' });
    assert.deepEqual(p, [
        'Repository id may only contain lowercase letters, digits and hyphens.',
        'Local repository path must be absolute.',
        'Repository path must not contain "..".'
    ]);
});

test('anything validate calls clean can also be built into a URL', () => {
    const repos = [
        { id: 'a', kind: 'local', path: '/srv/b' },
        { id: 'b', kind: 'sftp', host: 'nas.lan', path: '/vol/r' },
        { id: 'c', kind: 'sftp', user: 'u', host: 'nas.lan', path: '/vol/r' },
        { id: 'd', kind: 'rest', url: 'https://r.example:8000/' },
        { id: 'e', kind: 's3', endpoint: 's3.amazonaws.com', bucket: 'h' },
        { id: 'f', kind: 'b2', bucket: 'h', prefix: 'p' },
        { id: 'g', kind: 'azure', container: 'c' },
        { id: 'h', kind: 'gs', bucket: 'h' },
        { id: 'i', kind: 'rclone', remote: 'r', prefix: 'p' }
    ];
    repos.forEach((r) => {
        assert.deepEqual(Repos.validate(r), [], JSON.stringify(r));
        assert.equal(survives(() => Repos.buildUrl(r)), null, 'buildUrl threw for a valid repo ' + r.id);
    });
});

// ------------------------------------------------------------ envFor hostile

test('envFor never throws, whatever it is handed', () => {
    NOT_OBJECTS.concat(EMPTY_OBJECTS, [
        { kind: 's3', accessKeyId: Symbol('k') },
        { kind: 'b2', accountId: [], accountKey: {} }
    ]).forEach((v) => {
        assert.equal(survives(() => Repos.envFor(v)), null, 'envFor threw');
        assert.equal(typeof Repos.envFor(v), 'object');
    });
});

test('envFor returns a fresh object each call', () => {
    const repo = { kind: 'gs', projectId: 'p1' };
    const a = Repos.envFor(repo);
    a.INJECTED = 'x';
    assert.deepEqual(Repos.envFor(repo), { GOOGLE_PROJECT_ID: 'p1' });
});

test('envFor emits only the current backend keys, never another backend field', () => {
    const kitchenSink = { accessKeyId: 'ak', secretAccessKey: 'sk', accountId: 'ai', accountKey: 'akey',
        accountName: 'an', projectId: 'pi' };
    assert.deepEqual(Object.keys(Repos.envFor(Object.assign({ kind: 's3' }, kitchenSink))).sort(),
        ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
    assert.deepEqual(Object.keys(Repos.envFor(Object.assign({ kind: 'b2' }, kitchenSink))).sort(),
        ['B2_ACCOUNT_ID', 'B2_ACCOUNT_KEY']);
    assert.deepEqual(Object.keys(Repos.envFor(Object.assign({ kind: 'gs' }, kitchenSink))).sort(),
        ['GOOGLE_PROJECT_ID']);
});

test('envFor never emits a restic password or repository variable for any kind', () => {
    Repos.KINDS.forEach((kind) => {
        const env = Repos.envFor({ kind: kind, password: 'hunter2', key: 'hunter2', RESTIC_PASSWORD: 'hunter2',
            accessKeyId: 'ak', secretAccessKey: 'sk', accountId: 'ai', accountKey: 'k', accountName: 'n',
            projectId: 'p' });
        Object.keys(env).forEach((k) => assert.equal(/^RESTIC_/.test(k), false, 'leaked ' + k + ' for ' + kind));
        assert.equal(JSON.stringify(env).includes('hunter2'), false, 'leaked the password for ' + kind);
    });
});

test('envFor treats whitespace-only and empty credentials as absent', () => {
    ['', '   ', '\t', '\n', null, undefined, []].forEach((v) => {
        assert.deepEqual(Repos.envFor({ kind: 'gs', projectId: v }), {}, JSON.stringify(v));
    });
});

test('envFor keeps a credential verbatim including unicode and embedded newlines', () => {
    assert.deepEqual(Repos.envFor({ kind: 'azure', accountName: 'hesap-ü', accountKey: 'a\nb' }),
        { AZURE_ACCOUNT_NAME: 'hesap-ü', AZURE_ACCOUNT_KEY: 'a\nb' });
});

test('envFor does not trim a credential that has meaningful surrounding space', () => {
    assert.deepEqual(Repos.envFor({ kind: 'gs', projectId: ' p1 ' }), { GOOGLE_PROJECT_ID: ' p1 ' });
});

test('envFor ignores a kind spelled in the wrong case rather than guessing', () => {
    assert.deepEqual(Repos.envFor({ kind: 'S3', accessKeyId: 'ak' }), {});
});

// ---------------------------------------------------------- describe hostile

test('describe never throws, whatever it is handed', () => {
    NOT_OBJECTS.concat(EMPTY_OBJECTS, [
        { kind: 'local', path: Symbol('p') },
        { kind: 's3', bucket: [], endpoint: {}, prefix: 0 }
    ]).forEach((v) => {
        assert.equal(survives(() => Repos.describe(v)), null, 'describe threw');
        assert.equal(typeof Repos.describe(v), 'string');
    });
});

test('describe ends every sentence with a full stop', () => {
    Repos.KINDS.forEach((kind) => {
        assert.match(Repos.describe({ kind: kind, path: '/p', host: 'h', url: 'u', endpoint: 'e', bucket: 'b',
            container: 'c', remote: 'r' }), /\.$/, kind);
    });
});

test('describe mentions the prefix only for backends that have one', () => {
    assert.equal(Repos.describe({ kind: 'local', path: '/srv', prefix: 'ignored' }), 'Local folder at /srv.');
    assert.equal(Repos.describe({ kind: 'rest', url: 'http://h/', prefix: 'ignored' }), 'REST server at http://h/.');
    assert.equal(Repos.describe({ kind: 'rclone', remote: 'r', prefix: 'p' }), 'rclone remote r under p.');
});

test('describe echoes hostile field values verbatim rather than interpreting them', () => {
    assert.equal(Repos.describe({ kind: 'local', path: '/srv/$(id)' }), 'Local folder at /srv/$(id).');
    assert.equal(Repos.describe({ kind: 'b2', bucket: '📦' }), 'Backblaze B2 bucket 📦.');
});

// -------------------------------------------------- parseRcloneRemotes hostile

test('parseRcloneRemotes always returns an array of strings', () => {
    NOT_OBJECTS.concat(EMPTY_OBJECTS, ['gdrive:\nbox:']).forEach((v, i) => {
        const out = Repos.parseRcloneRemotes(v);
        assert.ok(Array.isArray(out), 'not an array for input #' + i);
        out.forEach((x) => assert.equal(typeof x, 'string'));
    });
});

test('parseRcloneRemotes drops a line that is nothing but a colon', () => {
    assert.deepEqual(Repos.parseRcloneRemotes(':\n:\n'), []);
    assert.deepEqual(Repos.parseRcloneRemotes('  :  \n'), []);
});

test('parseRcloneRemotes strips exactly one trailing colon', () => {
    assert.deepEqual(Repos.parseRcloneRemotes('a::\n'), ['a:']);
    assert.deepEqual(Repos.parseRcloneRemotes('::\n'), [':']);
});

test('parseRcloneRemotes drops comment lines but keeps a # inside a name', () => {
    assert.deepEqual(Repos.parseRcloneRemotes('# a comment\ngdrive:\n#another\nbo#x:'), ['gdrive', 'bo#x']);
});

test('parseRcloneRemotes keeps a name that rclone emitted without a colon', () => {
    assert.deepEqual(Repos.parseRcloneRemotes('gdrive\nbox:'), ['gdrive', 'box']);
});

test('parseRcloneRemotes tolerates a bare-CR terminated stream as one line', () => {
    assert.deepEqual(Repos.parseRcloneRemotes('a:\rb:'), ['a:\rb']);
});

test('parseRcloneRemotes keeps a NUL byte inside a remote name rather than truncating', () => {
    assert.deepEqual(Repos.parseRcloneRemotes('we\0ird:\n'), ['we\0ird']);
});

test('parseRcloneRemotes handles 20k remotes without loss', () => {
    const names = [];
    for (let i = 0; i < 20000; i++) names.push('remote-' + i + ':');
    const out = Repos.parseRcloneRemotes(names.join('\n'));
    assert.equal(out.length, 20000);
    assert.equal(out[19999], 'remote-19999');
});

test('parseRcloneRemotes leaves a remote name with spaces intact', () => {
    assert.deepEqual(Repos.parseRcloneRemotes('my drive:\n'), ['my drive']);
});

// ------------------------------------------------- listRcloneRemotes with cockpit

// The impure layer is exercised through a stub on the global, which is exactly how
// cockpit reaches it in the browser. Restored in finally so ordering cannot leak.
function withCockpit(stub, fn) {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'cockpit');
    const prev = globalThis.cockpit;
    globalThis.cockpit = stub;
    return Promise.resolve()
        .then(fn)
        .finally(() => {
            if (had) globalThis.cockpit = prev;
            else delete globalThis.cockpit;
        });
}

test('listRcloneRemotes parses what the spawned rclone printed', async () => {
    await withCockpit({ spawn: () => Promise.resolve('gdrive:\ns3-cold:\n') }, async () => {
        assert.deepEqual(await Repos.listRcloneRemotes(), ['gdrive', 's3-cold']);
    });
});

test('listRcloneRemotes asks for rclone listremotes as root with message errors', async () => {
    let seen = null;
    await withCockpit({ spawn: (argv, opts) => { seen = [argv, opts]; return Promise.resolve(''); } }, async () => {
        await Repos.listRcloneRemotes();
    });
    assert.deepEqual(seen[0], ['rclone', 'listremotes']);
    assert.equal(seen[1].superuser, 'require');
    assert.equal(seen[1].err, 'message');
});

test('listRcloneRemotes treats a rejected spawn as "no remotes", not a failure', async () => {
    await withCockpit({ spawn: () => Promise.reject(new Error('rclone: command not found')) }, async () => {
        assert.deepEqual(await Repos.listRcloneRemotes(), []);
    });
});

test('listRcloneRemotes survives a spawn that throws synchronously', async () => {
    // cockpit.spawn does this when the superuser bridge has already gone away.
    await withCockpit({ spawn: () => { throw new Error('channel closed'); } }, async () => {
        assert.deepEqual(await Repos.listRcloneRemotes(), []);
    });
});

test('listRcloneRemotes survives a spawn that returns a non-thenable', async () => {
    await withCockpit({ spawn: () => 'gdrive:\n' }, async () => {
        assert.deepEqual(await Repos.listRcloneRemotes(), ['gdrive']);
    });
});

test('listRcloneRemotes resolves to [] when cockpit exists but has no spawn', async () => {
    await withCockpit({}, async () => {
        assert.deepEqual(await Repos.listRcloneRemotes(), []);
    });
    await withCockpit({ spawn: null }, async () => {
        assert.deepEqual(await Repos.listRcloneRemotes(), []);
    });
});

test('listRcloneRemotes always returns a promise and never throws at the call site', async () => {
    const stubs = [undefined, {}, { spawn: () => { throw new Error('x'); } },
        { spawn: () => Promise.reject(new Error('x')) }, { spawn: () => 42 }];
    for (const stub of stubs) {
        await withCockpit(stub, async () => {
            let p;
            assert.equal(survives(() => { p = Repos.listRcloneRemotes(); }), null, 'threw at the call site');
            assert.equal(typeof p.then, 'function');
            assert.ok(Array.isArray(await p));
        });
    }
});

// ----------------------------------------------------------------- invariants

test('SCHEMES is exactly KINDS without the local pseudo-backend', () => {
    assert.deepEqual(Repos.SCHEMES, Repos.KINDS.filter((k) => k !== 'local'));
});

test('every kind has a required-field list and every required field has a label', () => {
    Repos.KINDS.forEach((kind) => {
        assert.ok(Array.isArray(Repos.REQUIRED[kind]), 'no REQUIRED entry for ' + kind);
        assert.ok(Repos.REQUIRED[kind].length > 0, 'empty REQUIRED for ' + kind);
        Repos.REQUIRED[kind].forEach((f) => {
            // A missing label would render "requires a undefined." in the UI.
            const msg = Repos.validate({ id: 'x', kind: kind })[0];
            assert.equal(/undefined/.test(msg), false, 'unlabelled field ' + f + ' for ' + kind);
        });
    });
});

test('every scheme parses back to its own kind', () => {
    Repos.SCHEMES.forEach((scheme) => {
        assert.equal(Repos.parseUrl(scheme + ':name:path').kind, scheme);
    });
});

test('the module keeps cockpit behind a typeof guard', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'core', 'repos.js'), 'utf8');
    const bare = src.split(/\r?\n/).filter((l) => /\bcockpit\./.test(l) && !/typeof cockpit/.test(l));
    // Only the spawn call itself, which sits behind the guard above it.
    bare.forEach((l) => assert.match(l, /cockpit\.spawn/, 'unguarded cockpit use: ' + l));
});
