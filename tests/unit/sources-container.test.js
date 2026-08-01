// tests/unit/sources-container.test.js — HangarSourcesContainer: the 'container'
// source kind (podman/docker volumes).
//
// The two things worth the most here are the database warning matrix (a live copy
// of a running database is a backup that will not restore) and the per-user runtime
// wrapping (root's podman is a different store to the user's, and querying the wrong
// one succeeds while finding nothing).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('../../js/core/sources-container.js');
const Sources = require('../../js/core/sources.js');
const Errors = require('../../js/core/errors.js');

const NUL = '\u0000';

function src(over) {
    return Object.assign({
        id: 'app-vols', kind: 'container', runtime: 'podman', user: 'appuser',
        volumes: ['appdata']
    }, over || {});
}

function codes(problems) { return problems.map((p) => p.code); }
function errorCodes(problems) { return codes(problems.filter((p) => p.severity === 'error')); }
function warningCodes(problems) { return codes(problems.filter((p) => p.severity === 'warning')); }
function findCode(problems, code) { return problems.filter((p) => p.code === code); }

// Real `podman volume inspect` shape: a JSON array, both runtimes.
function inspectArray(names) {
    return JSON.stringify(names.map((n) => ({
        Name: n,
        Driver: 'local',
        Mountpoint: '/home/appuser/.local/share/containers/storage/volumes/' + n + '/_data',
        CreatedAt: '2026-07-30T11:02:41.123456789+03:00',
        Labels: {},
        Scope: 'local',
        Options: {}
    })), null, 4);
}

// Docker's `--format '{{json .}}'` shape: one object per line, no enclosing array.
function inspectLines(names) {
    return names.map((n) => JSON.stringify({
        Name: n,
        Driver: 'local',
        Mountpoint: '/var/lib/docker/volumes/' + n + '/_data',
        Labels: null,
        Scope: 'local'
    })).join('\n') + '\n';
}

// ---- constants -------------------------------------------------------------

test('RUNTIMES is exactly podman and docker, podman first', () => {
    assert.deepEqual(C.RUNTIMES, ['podman', 'docker']);
    assert.equal(C.DEFAULT_RUNTIME, 'podman');
});

test('CONSISTENCY has the four modes with id, label, risk and description', () => {
    assert.deepEqual(C.CONSISTENCY_IDS, ['none', 'pause', 'stop', 'command']);
    C.CONSISTENCY_IDS.forEach((id) => {
        const m = C.CONSISTENCY[id];
        assert.equal(m.id, id);
        assert.equal(typeof m.label, 'string');
        assert.ok(m.label.length > 0);
        assert.ok([C.RISK.HIGH, C.RISK.MEDIUM, C.RISK.LOW].includes(m.risk));
        assert.ok(m.description.length > 20);
    });
});

test('CONSISTENCY risk ranks a live copy worst and a stop or dump best', () => {
    assert.equal(C.CONSISTENCY.none.risk, C.RISK.HIGH);
    assert.equal(C.CONSISTENCY.pause.risk, C.RISK.MEDIUM);
    assert.equal(C.CONSISTENCY.stop.risk, C.RISK.LOW);
    assert.equal(C.CONSISTENCY.command.risk, C.RISK.LOW);
});

test('the default consistency mode is the no-op one', () => {
    assert.equal(C.DEFAULT_CONSISTENCY, 'none');
});

// ---- registration ----------------------------------------------------------

test('the module registers itself as the "container" kind', () => {
    assert.ok(Sources.kinds().includes('container'));
    assert.ok(Sources.KINDS.container);
});

test('registering twice is a no-op rather than a throw', () => {
    const first = Sources.KINDS.container;
    assert.equal(C.register(), first);
    assert.equal(C.register(Sources), first);
});

test('register returns null when no registry is available', () => {
    assert.equal(C.register({}), null);
    assert.equal(C.register({ registerKind: 'not a function' }), null);
});

test('HangarSources dispatches validate, describe and toResticArgs to this kind', () => {
    const s = src({ resolvedPaths: ['/var/lib/vol/_data'] });
    assert.deepEqual(Sources.validate(s), C.validate(s));
    assert.equal(Sources.describe(s), C.describe(s));
    assert.deepEqual(Sources.toResticArgs(s), C.toResticArgs(s));
});

// ---- asUser ----------------------------------------------------------------

test('asUser wraps a command in runuser for a non-root user', () => {
    assert.deepEqual(C.asUser('appuser', ['podman', 'volume', 'ls', '-q']),
        ['runuser', '-u', 'appuser', '--', 'podman', 'volume', 'ls', '-q']);
});

test('asUser leaves the command alone for root', () => {
    assert.deepEqual(C.asUser('root', ['docker', 'ps']), ['docker', 'ps']);
});

test('asUser leaves the command alone when no user is given', () => {
    assert.deepEqual(C.asUser('', ['docker', 'ps']), ['docker', 'ps']);
    assert.deepEqual(C.asUser(undefined, ['docker', 'ps']), ['docker', 'ps']);
    assert.deepEqual(C.asUser(null, ['docker', 'ps']), ['docker', 'ps']);
});

test('asUser does not mutate the argv it was handed', () => {
    const argv = ['podman', 'ps'];
    const out = C.asUser('appuser', argv);
    assert.deepEqual(argv, ['podman', 'ps']);
    assert.notEqual(out, argv);
    assert.deepEqual(C.asUser('root', argv), argv);
    assert.notEqual(C.asUser('root', argv), argv);
});

test('asUser rejects a user name containing shell metacharacters', () => {
    ['is;met', 'is met', 'is$met', 'is|met', 'a`b`', 'a&b', 'a>b', "a'b"].forEach((u) => {
        assert.throws(() => C.asUser(u, ['podman', 'ps']), (e) => {
            assert.ok(Errors.isHangarError(e));
            assert.equal(e.kind, Errors.KIND.GENERIC);
            assert.equal(e.detail.user, u);
            return true;
        }, u);
    });
});

test('asUser rejects a user name that would be read as a flag', () => {
    assert.throws(() => C.asUser('-rf', ['podman', 'ps']), Errors.isHangarError);
    assert.throws(() => C.asUser('--help', ['podman', 'ps']), Errors.isHangarError);
});

test('asUser rejects a user name with a newline or a NUL', () => {
    assert.throws(() => C.asUser('appuser\nroot', ['podman', 'ps']), Errors.isHangarError);
    assert.throws(() => C.asUser('appuser' + NUL, ['podman', 'ps']), Errors.isHangarError);
});

test('asUser rejects a non-string user and an over-long one', () => {
    assert.throws(() => C.asUser(42, ['podman', 'ps']), Errors.isHangarError);
    assert.throws(() => C.asUser({}, ['podman', 'ps']), Errors.isHangarError);
    assert.throws(() => C.asUser('u'.repeat(33), ['podman', 'ps']), Errors.isHangarError);
});

test('asUser accepts ordinary POSIX user names', () => {
    ['appuser', '_svc', 'app-user', 'user.name', 'u1', 'A'].forEach((u) => {
        assert.deepEqual(C.asUser(u, ['podman', 'ps']).slice(0, 4), ['runuser', '-u', u, '--']);
    });
});

test('asUser rejects a user name starting with a digit', () => {
    assert.throws(() => C.asUser('1user', ['podman', 'ps']), Errors.isHangarError);
});

test('asUser rejects anything that is not an argument vector', () => {
    assert.throws(() => C.asUser('appuser', 'podman ps'), Errors.isHangarError);
    assert.throws(() => C.asUser('root', null), Errors.isHangarError);
});

// ---- argv builders ---------------------------------------------------------

test('volumeListArgv uses -q, never --format json, which is not portable', () => {
    assert.deepEqual(C.volumeListArgv('podman', 'appuser'),
        ['runuser', '-u', 'appuser', '--', 'podman', 'volume', 'ls', '-q']);
    assert.deepEqual(C.volumeListArgv('docker', ''), ['docker', 'volume', 'ls', '-q']);
    assert.equal(C.volumeListArgv('podman', 'appuser').includes('--format'), false);
});

test('volumeListArgv defaults to podman when no runtime is given', () => {
    assert.deepEqual(C.volumeListArgv(undefined, ''), ['podman', 'volume', 'ls', '-q']);
    assert.deepEqual(C.volumeListArgv('', ''), ['podman', 'volume', 'ls', '-q']);
});

test('volumeListArgv throws a typed error for an unknown runtime', () => {
    assert.throws(() => C.volumeListArgv('lxc', ''), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.deepEqual(e.detail.known, ['podman', 'docker']);
        return true;
    });
});

test('volumeInspectArgv names one volume and stays portable', () => {
    assert.deepEqual(C.volumeInspectArgv('docker', 'root', 'appdata'),
        ['docker', 'volume', 'inspect', 'appdata']);
    assert.deepEqual(C.volumeInspectArgv('podman', 'appuser', 'appdata'),
        ['runuser', '-u', 'appuser', '--', 'podman', 'volume', 'inspect', 'appdata']);
});

test('volumeInspectArgv rejects a hostile volume name before it reaches argv', () => {
    ['a;rm -rf /', '$(id)', '`id`', 'a b', 'vol' + NUL, 'vol\nother', '--format', '-x', ''].forEach((n) => {
        assert.throws(() => C.volumeInspectArgv('podman', 'appuser', n), (e) => {
            assert.ok(Errors.isHangarError(e));
            assert.equal(e.detail.volume, n);
            return true;
        }, JSON.stringify(n));
    });
});

test('volumeInspectArgv rejects a non-string volume name', () => {
    assert.throws(() => C.volumeInspectArgv('podman', '', null), Errors.isHangarError);
    assert.throws(() => C.volumeInspectArgv('podman', '', ['appdata']), Errors.isHangarError);
});

test('containerListArgv uses the Go template that both runtimes accept', () => {
    assert.deepEqual(C.containerListArgv('docker', ''),
        ['docker', 'ps', '-a', '--format', '{{.Names}}']);
    assert.deepEqual(C.containerListArgv('podman', 'appuser'),
        ['runuser', '-u', 'appuser', '--', 'podman', 'ps', '-a', '--format', '{{.Names}}']);
});

// ---- isSafeName ------------------------------------------------------------

test('isSafeName accepts the names the runtimes themselves allow', () => {
    ['appdata', 'app_data', 'app-data', 'app.data', 'v1', 'A1'].forEach((n) => {
        assert.equal(C.isSafeName(n), true, n);
    });
});

test('isSafeName rejects metacharacters, blanks, control bytes and leading punctuation', () => {
    ['', ' ', 'a b', 'a;b', 'a|b', 'a&b', 'a$b', 'a`b', 'a>b', 'a<b', 'a*b', 'a?b',
        'a(b)', 'a{b}', 'a[b]', 'a!b', 'a#b', 'a~b', 'a\\b', 'a"b', "a'b", 'a/b',
        '-lead', '.lead', '_lead', 'a\tb', 'a\nb', 'a\rb', 'a' + NUL, 'yedek-günlüğü', '日本'
    ].forEach((n) => {
        assert.equal(C.isSafeName(n), false, JSON.stringify(n));
    });
    assert.equal(C.isSafeName(null), false);
    assert.equal(C.isSafeName(7), false);
});

// ---- database detection ----------------------------------------------------

test('databaseHint matches every documented database hint', () => {
    assert.deepEqual(C.DATABASE_HINTS,
        ['mongo', 'postgres', 'mysql', 'mariadb', 'redis', 'elastic', 'kafka',
            'cassandra', 'clickhouse']);
    C.DATABASE_HINTS.forEach((h) => {
        assert.equal(C.databaseHint(h), h);
        assert.equal(C.looksLikeDatabase(h), true);
    });
});

test('databaseHint matches inside real-world compose container names', () => {
    assert.equal(C.databaseHint('app-postgres-1'), 'postgres');
    assert.equal(C.databaseHint('mongo_primary'), 'mongo');
    assert.equal(C.databaseHint('prod.redis'), 'redis');
    assert.equal(C.databaseHint('my-mariadb-11'), 'mariadb');
    assert.equal(C.databaseHint('elasticsearch'), 'elastic');
    assert.equal(C.databaseHint('kafka-broker-2'), 'kafka');
    assert.equal(C.databaseHint('clickhouse-server'), 'clickhouse');
    assert.equal(C.databaseHint('cassandra-node-a'), 'cassandra');
    assert.equal(C.databaseHint('postgresql-14'), 'postgres');
    assert.equal(C.databaseHint('mongodb'), 'mongo');
});

test('databaseHint is case insensitive', () => {
    assert.equal(C.databaseHint('MongoDB'), 'mongo');
    assert.equal(C.databaseHint('PROD-POSTGRES'), 'postgres');
    assert.equal(C.databaseHint('MySQL'), 'mysql');
});

test('databaseHint returns the first hint in table order for a multi-match name', () => {
    assert.equal(C.databaseHint('mongo-to-postgres-sync'), 'mongo');
    assert.equal(C.databaseHint('postgres-redis-cache'), 'postgres');
});

test('databaseHint says no for ordinary application containers', () => {
    ['web', 'nginx', 'app', 'worker', 'grafana', 'minio', 'caddy', 'api'].forEach((n) => {
        assert.equal(C.databaseHint(n), '', n);
        assert.equal(C.looksLikeDatabase(n), false, n);
    });
});

test('databaseHint tolerates non-string input', () => {
    assert.equal(C.databaseHint(null), '');
    assert.equal(C.databaseHint(undefined), '');
    assert.equal(C.databaseHint(42), '');
});

// ---- parseVolumeNames ------------------------------------------------------

test('parseVolumeNames reads newline-separated names', () => {
    assert.deepEqual(C.parseVolumeNames('appdata\npgdata\nmedia\n'),
        ['appdata', 'pgdata', 'media']);
});

test('parseVolumeNames tolerates CRLF, blank lines and trailing whitespace', () => {
    assert.deepEqual(C.parseVolumeNames('appdata\r\n\r\n  pgdata  \n\n\nmedia\r\n'),
        ['appdata', 'pgdata', 'media']);
});

test('parseVolumeNames returns an empty list for empty or non-string input', () => {
    assert.deepEqual(C.parseVolumeNames(''), []);
    assert.deepEqual(C.parseVolumeNames('\n\n  \n'), []);
    assert.deepEqual(C.parseVolumeNames(null), []);
    assert.deepEqual(C.parseVolumeNames(undefined), []);
    assert.deepEqual(C.parseVolumeNames(['appdata']), []);
});

test('parseVolumeNames preserves order and does not invent entries', () => {
    assert.deepEqual(C.parseVolumeNames('b\na\nb'), ['b', 'a', 'b']);
});

// ---- parseVolumeInspect ----------------------------------------------------

test('parseVolumeInspect reads the JSON array both runtimes emit', () => {
    const out = C.parseVolumeInspect(inspectArray(['appdata', 'pgdata']));
    assert.equal(out.length, 2);
    assert.equal(out[0].name, 'appdata');
    assert.equal(out[0].mountpoint,
        '/home/appuser/.local/share/containers/storage/volumes/appdata/_data');
    assert.equal(out[0].driver, 'local');
    assert.deepEqual(out[0].labels, {});
    assert.equal(out[1].name, 'pgdata');
});

test('parseVolumeInspect reads docker\'s one-object-per-line --format output', () => {
    const out = C.parseVolumeInspect(inspectLines(['appdata', 'pgdata']));
    assert.deepEqual(out.map((e) => e.name), ['appdata', 'pgdata']);
    assert.equal(out[0].mountpoint, '/var/lib/docker/volumes/appdata/_data');
});

test('parseVolumeInspect turns a null Labels field into an empty object', () => {
    const out = C.parseVolumeInspect(inspectLines(['appdata']));
    assert.deepEqual(out[0].labels, {});
});

test('parseVolumeInspect keeps real labels', () => {
    const text = JSON.stringify([{
        Name: 'appdata', Mountpoint: '/m/appdata',
        Labels: { 'io.podman.compose.project': 'shop' }, Driver: 'local'
    }]);
    assert.deepEqual(C.parseVolumeInspect(text)[0].labels,
        { 'io.podman.compose.project': 'shop' });
});

test('parseVolumeInspect accepts a single bare object', () => {
    const out = C.parseVolumeInspect(JSON.stringify(
        { Name: 'appdata', Mountpoint: '/m/appdata', Driver: 'local' }));
    assert.deepEqual(out, [{ name: 'appdata', mountpoint: '/m/appdata', labels: {}, driver: 'local' }]);
});

test('parseVolumeInspect accepts lowercase field spellings', () => {
    const out = C.parseVolumeInspect('{"name":"v","mountpoint":"/m/v","driver":"local"}');
    assert.deepEqual(out, [{ name: 'v', mountpoint: '/m/v', labels: {}, driver: 'local' }]);
});

test('parseVolumeInspect handles pretty-printed documents concatenated without an array', () => {
    const text = inspectArray(['a']).replace(/^\[|\]$/g, '') + '\n' +
        inspectArray(['b']).replace(/^\[|\]$/g, '');
    assert.deepEqual(C.parseVolumeInspect(text).map((e) => e.name), ['a', 'b']);
});

test('parseVolumeInspect handles two concatenated arrays', () => {
    assert.deepEqual(
        C.parseVolumeInspect(inspectArray(['a']) + '\n' + inspectArray(['b'])).map((e) => e.name),
        ['a', 'b']);
});

test('parseVolumeInspect skips noise lines around the JSON', () => {
    const text = 'WARN[0000] using rootless storage\n' + inspectArray(['appdata']) + '\nbye\n';
    assert.deepEqual(C.parseVolumeInspect(text).map((e) => e.name), ['appdata']);
});

test('parseVolumeInspect survives a brace inside a string value', () => {
    const text = '{"Name":"v","Mountpoint":"/m/v","Labels":{"note":"a } b [ c"},"Driver":"local"}';
    const out = C.parseVolumeInspect(text);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].labels, { note: 'a } b [ c' });
});

test('parseVolumeInspect survives an escaped quote inside a string value', () => {
    const text = '{"Name":"v","Mountpoint":"/m/v","Labels":{"note":"say \\"hi\\""}}';
    assert.deepEqual(C.parseVolumeInspect(text)[0].labels, { note: 'say "hi"' });
});

test('parseVolumeInspect returns an empty list for truncated JSON', () => {
    assert.deepEqual(C.parseVolumeInspect('[{"Name":"appdata","Mountpoint":"/m/a"'), []);
});

test('parseVolumeInspect returns an empty list for empty, blank or non-string input', () => {
    assert.deepEqual(C.parseVolumeInspect(''), []);
    assert.deepEqual(C.parseVolumeInspect('   \n '), []);
    assert.deepEqual(C.parseVolumeInspect(null), []);
    assert.deepEqual(C.parseVolumeInspect(42), []);
    assert.deepEqual(C.parseVolumeInspect('[]'), []);
});

test('parseVolumeInspect drops entries with no usable name', () => {
    const text = '[{"Mountpoint":"/m/x"},{"Name":"","Mountpoint":"/m/y"},' +
        '{"Name":"v","Mountpoint":"/m/v"},null,7,"str"]';
    assert.deepEqual(C.parseVolumeInspect(text).map((e) => e.name), ['v']);
});

test('parseVolumeInspect canonicalises the mountpoint', () => {
    const out = C.parseVolumeInspect('[{"Name":"v","Mountpoint":"/m//v/_data/"}]');
    assert.equal(out[0].mountpoint, '/m/v/_data');
});

test('parseVolumeInspect leaves a missing or non-string mountpoint as an empty string', () => {
    assert.equal(C.parseVolumeInspect('[{"Name":"v"}]')[0].mountpoint, '');
    assert.equal(C.parseVolumeInspect('[{"Name":"v","Mountpoint":null}]')[0].mountpoint, '');
    assert.equal(C.parseVolumeInspect('[{"Name":"v","Mountpoint":7}]')[0].mountpoint, '');
});

// ---- mountpointsFor --------------------------------------------------------

test('mountpointsFor returns the wanted volumes in the order asked for', () => {
    const inspected = C.parseVolumeInspect(inspectArray(['a', 'b', 'c']));
    const paths = C.mountpointsFor(inspected, ['c', 'a']);
    assert.deepEqual(paths, [
        '/home/appuser/.local/share/containers/storage/volumes/c/_data',
        '/home/appuser/.local/share/containers/storage/volumes/a/_data'
    ]);
});

test('mountpointsFor de-duplicates repeated volumes and shared mount paths', () => {
    const inspected = [
        { name: 'a', mountpoint: '/m/shared' },
        { name: 'b', mountpoint: '/m/shared' }
    ];
    assert.deepEqual(C.mountpointsFor(inspected, ['a', 'b', 'a']), ['/m/shared']);
});

test('mountpointsFor returns every inspected mount path when nothing is wanted', () => {
    const inspected = C.parseVolumeInspect(inspectLines(['a', 'b']));
    assert.deepEqual(C.mountpointsFor(inspected, []),
        ['/var/lib/docker/volumes/a/_data', '/var/lib/docker/volumes/b/_data']);
    assert.deepEqual(C.mountpointsFor(inspected, undefined),
        ['/var/lib/docker/volumes/a/_data', '/var/lib/docker/volumes/b/_data']);
});

test('mountpointsFor drops a volume that was not inspected', () => {
    const inspected = [{ name: 'a', mountpoint: '/m/a' }];
    assert.deepEqual(C.mountpointsFor(inspected, ['a', 'missing']), ['/m/a']);
});

test('mountpointsFor drops an entry with an empty or relative mount path', () => {
    const inspected = [
        { name: 'a', mountpoint: '' },
        { name: 'b', mountpoint: 'relative/path' },
        { name: 'c', mountpoint: '/m/c' }
    ];
    assert.deepEqual(C.mountpointsFor(inspected, ['a', 'b', 'c']), ['/m/c']);
});

test('mountpointsFor tolerates junk in either argument', () => {
    assert.deepEqual(C.mountpointsFor(null, ['a']), []);
    assert.deepEqual(C.mountpointsFor([null, 7, 'x'], ['a']), []);
    assert.deepEqual(C.mountpointsFor([{ name: 'a', mountpoint: '/m/a' }], [null, 7, 'a']), ['/m/a']);
});

test('mountpointsFor keeps the first entry when a name is inspected twice', () => {
    const inspected = [{ name: 'a', mountpoint: '/m/first' }, { name: 'a', mountpoint: '/m/second' }];
    assert.deepEqual(C.mountpointsFor(inspected, ['a']), ['/m/first']);
});

// ---- normalize -------------------------------------------------------------

test('normalize fills in every field for a bare source', () => {
    assert.deepEqual(C.normalize({ id: 'v', kind: 'container', volumes: ['appdata'] }), {
        id: 'v',
        kind: 'container',
        runtime: 'podman',
        user: '',
        volumes: ['appdata'],
        consistency: 'none',
        command: '',
        containers: [],
        excludes: [],
        tags: [],
        resolvedPaths: []
    });
});

test('normalize sorts and de-duplicates volumes, which are a set', () => {
    const n = C.normalize(src({ volumes: ['media', 'appdata', 'media', 'pgdata'] }));
    assert.deepEqual(n.volumes, ['appdata', 'media', 'pgdata']);
});

test('normalize keeps container order, because stop order is dependency order', () => {
    const n = C.normalize(src({ consistency: 'stop', containers: ['web', 'app', 'pgdata-db', 'web'] }));
    assert.deepEqual(n.containers, ['web', 'app', 'pgdata-db']);
});

test('normalize falls back to podman for an unknown runtime', () => {
    assert.equal(C.normalize(src({ runtime: 'lxc' })).runtime, 'podman');
    assert.equal(C.normalize(src({ runtime: undefined })).runtime, 'podman');
    assert.equal(C.normalize(src({ runtime: 'docker' })).runtime, 'docker');
});

test('normalize falls back to the live-copy mode for an unknown consistency', () => {
    assert.equal(C.normalize(src({ consistency: 'freeze' })).consistency, 'none');
    assert.equal(C.normalize(src({ consistency: 'stop' })).consistency, 'stop');
});

test('normalize drops non-string entries rather than emitting junk argv', () => {
    const n = C.normalize(src({ volumes: ['a', null, 7, '', 'b'], containers: [1, 'web', ''] }));
    assert.deepEqual(n.volumes, ['a', 'b']);
    assert.deepEqual(n.containers, ['web']);
});

test('normalize canonicalises, de-duplicates and sorts resolvedPaths', () => {
    const n = C.normalize(src({ resolvedPaths: ['/m/b/', '/m//a', '/m/b', ''] }));
    assert.deepEqual(n.resolvedPaths, ['/m/a', '/m/b']);
});

test('normalize is idempotent', () => {
    const once = C.normalize(src({
        volumes: ['b', 'a'], containers: ['web', 'db'], consistency: 'stop',
        tags: ['nightly'], excludes: ['*.tmp'], resolvedPaths: ['/m/b/', '/m/a']
    }));
    assert.deepEqual(C.normalize(once), once);
});

test('normalize does not mutate its input', () => {
    const s = src({ volumes: ['b', 'a', 'b'], containers: ['web', 'web'], tags: ['t', 't'] });
    const copy = JSON.parse(JSON.stringify(s));
    C.normalize(s);
    assert.deepEqual(s, copy);
});

test('normalize survives junk in place of a source object', () => {
    assert.equal(C.normalize(null).kind, 'container');
    assert.deepEqual(C.normalize(['a']).volumes, []);
    assert.equal(C.normalize(undefined).runtime, 'podman');
});

// ---- validate: shape, runtime, user ---------------------------------------

test('validate accepts a minimal container source', () => {
    assert.deepEqual(C.validate(src()), []);
});

test('validate rejects a non-object source', () => {
    assert.deepEqual(errorCodes(C.validate(null)), [C.PROBLEM.BAD_SOURCE]);
    assert.deepEqual(errorCodes(C.validate('appdata')), [C.PROBLEM.BAD_SOURCE]);
    assert.deepEqual(errorCodes(C.validate(['appdata'])), [C.PROBLEM.BAD_SOURCE]);
});

test('validate rejects a missing or malformed id', () => {
    assert.ok(errorCodes(C.validate(src({ id: undefined }))).includes(C.PROBLEM.BAD_ID));
    assert.ok(errorCodes(C.validate(src({ id: 'has space' }))).includes(C.PROBLEM.BAD_ID));
    assert.ok(errorCodes(C.validate(src({ id: '../escape' }))).includes(C.PROBLEM.BAD_ID));
});

test('validate rejects an unknown runtime and names the ones it knows', () => {
    const problems = C.validate(src({ runtime: 'lxc' }));
    assert.deepEqual(errorCodes(problems), [C.PROBLEM.BAD_RUNTIME]);
    assert.deepEqual(problems[0].known, ['podman', 'docker']);
});

test('validate rejects a non-string runtime without throwing on it', () => {
    assert.deepEqual(errorCodes(C.validate(src({ runtime: 7 }))), [C.PROBLEM.BAD_RUNTIME]);
    assert.deepEqual(errorCodes(C.validate(src({ runtime: {} }))), [C.PROBLEM.BAD_RUNTIME]);
});

test('validate accepts both runtimes', () => {
    assert.deepEqual(C.validate(src({ runtime: 'podman' })), []);
    assert.deepEqual(C.validate(src({ runtime: 'docker' })), []);
});

test('validate rejects a user name that could not survive argv', () => {
    ['is;met', '-rf', 'is met', 'appuser' + NUL, 'a\nb', '1user'].forEach((u) => {
        assert.deepEqual(errorCodes(C.validate(src({ user: u }))), [C.PROBLEM.BAD_USER], u);
    });
});

test('validate warns when a podman source records no owning user', () => {
    // The single most likely reason a container backup comes back empty: root's
    // podman store is not the rootless user's.
    const problems = C.validate(src({ user: '' }));
    assert.deepEqual(errorCodes(problems), []);
    assert.deepEqual(warningCodes(problems), [C.PROBLEM.NO_USER]);
});

test('validate does not warn about a missing user for docker, whose daemon is system-wide', () => {
    assert.deepEqual(C.validate(src({ runtime: 'docker', user: '' })), []);
    assert.deepEqual(C.validate(src({ runtime: 'docker', user: undefined })), []);
});

test('validate does not warn when podman runs as an explicit root owner', () => {
    assert.deepEqual(C.validate(src({ user: 'root' })), []);
});

// ---- validate: volumes and containers -------------------------------------

test('validate rejects a source with no volumes', () => {
    assert.deepEqual(errorCodes(C.validate(src({ volumes: [] }))), [C.PROBLEM.NO_VOLUMES]);
    assert.deepEqual(errorCodes(C.validate(src({ volumes: undefined }))), [C.PROBLEM.NO_VOLUMES]);
    assert.deepEqual(errorCodes(C.validate(src({ volumes: 'appdata' }))), [C.PROBLEM.NO_VOLUMES]);
});

test('validate rejects a volume name carrying shell metacharacters', () => {
    ['appdata;rm -rf /', 'app$(id)', 'app`id`', 'app|tee', 'app data', 'app&', 'app>out']
        .forEach((v) => {
            const problems = C.validate(src({ volumes: [v] }));
            assert.deepEqual(errorCodes(problems), [C.PROBLEM.VOLUME_UNSAFE], v);
            assert.equal(problems[0].name, v);
        });
});

test('validate rejects a volume name with a NUL byte and says so', () => {
    const problems = C.validate(src({ volumes: ['appdata' + NUL] }));
    assert.deepEqual(errorCodes(problems), [C.PROBLEM.VOLUME_UNSAFE]);
    assert.equal(problems[0].reason, 'contains a NUL byte');
});

test('validate rejects a volume name with a newline and says so', () => {
    const problems = C.validate(src({ volumes: ['appdata\npgdata'] }));
    assert.equal(problems[0].reason, 'contains a newline');
    const crlf = C.validate(src({ volumes: ['appdata\r\npgdata'] }));
    assert.equal(crlf[0].code, C.PROBLEM.VOLUME_UNSAFE);
});

test('validate rejects a volume name that would be read as a flag', () => {
    const problems = C.validate(src({ volumes: ['--format'] }));
    assert.deepEqual(errorCodes(problems), [C.PROBLEM.VOLUME_UNSAFE]);
    assert.equal(problems[0].reason, 'starts with a dash and would be read as a flag');
});

test('validate rejects empty and non-string volume entries', () => {
    assert.deepEqual(errorCodes(C.validate(src({ volumes: [''] }))), [C.PROBLEM.VOLUME_EMPTY]);
    assert.deepEqual(errorCodes(C.validate(src({ volumes: [7] }))), [C.PROBLEM.VOLUME_TYPE]);
    assert.deepEqual(errorCodes(C.validate(src({ volumes: [null] }))), [C.PROBLEM.VOLUME_TYPE]);
});

test('validate rejects a duplicate volume and reports its index', () => {
    const problems = C.validate(src({ volumes: ['appdata', 'appdata'] }));
    assert.deepEqual(errorCodes(problems), [C.PROBLEM.VOLUME_DUPLICATE]);
    assert.equal(problems[0].index, 1);
});

test('validate reports one problem per bad volume', () => {
    const problems = C.validate(src({ volumes: ['ok', '', 'bad name', 7, 'ok'] }));
    assert.deepEqual(errorCodes(problems), [
        C.PROBLEM.VOLUME_EMPTY, C.PROBLEM.VOLUME_UNSAFE,
        C.PROBLEM.VOLUME_TYPE, C.PROBLEM.VOLUME_DUPLICATE
    ]);
});

test('validate applies the same name rules to containers', () => {
    const s = src({ consistency: 'stop', containers: ['app;rm -rf /'] });
    assert.deepEqual(errorCodes(C.validate(s)), [C.PROBLEM.CONTAINER_UNSAFE, C.PROBLEM.NO_CONTAINERS]);
});

test('validate rejects a duplicate container and a non-array containers field', () => {
    assert.ok(errorCodes(C.validate(src({ consistency: 'stop', containers: ['web', 'web'] })))
        .includes(C.PROBLEM.CONTAINER_DUPLICATE));
    assert.ok(errorCodes(C.validate(src({ containers: 'web' })))
        .includes(C.PROBLEM.CONTAINER_TYPE));
});

test('validate accepts unicode-free ordinary compose names', () => {
    assert.deepEqual(C.validate(src({
        volumes: ['shop_pgdata', 'shop.media', 'shop-uploads'],
        consistency: 'stop', containers: ['shop-web-1', 'shop_db_1']
    })), []);
});

// ---- validate: consistency modes ------------------------------------------

test('validate rejects an unknown consistency mode', () => {
    const problems = C.validate(src({ consistency: 'freeze' }));
    assert.deepEqual(errorCodes(problems), [C.PROBLEM.BAD_CONSISTENCY]);
    assert.deepEqual(problems[0].known, ['none', 'pause', 'stop', 'command']);
});

test('validate accepts a missing consistency as the live-copy mode', () => {
    assert.deepEqual(C.validate(src({ consistency: undefined })), []);
    assert.deepEqual(C.validate(src({ consistency: '' })), []);
});

test('validate rejects the dump mode with no command', () => {
    const problems = C.validate(src({ consistency: 'command', containers: ['app'] }));
    assert.deepEqual(errorCodes(problems), [C.PROBLEM.NO_COMMAND]);
});

test('validate rejects the dump mode with an empty command', () => {
    assert.ok(errorCodes(C.validate(src({ consistency: 'command', containers: ['app'], command: '' })))
        .includes(C.PROBLEM.NO_COMMAND));
});

test('validate accepts the dump mode with a command and a container', () => {
    assert.deepEqual(C.validate(src({
        consistency: 'command', containers: ['app-db'],
        command: 'pg_dump -U postgres shop > /backup/shop.sql'
    })), []);
});

test('validate rejects pause with no containers — there would be nothing to pause', () => {
    const problems = C.validate(src({ consistency: 'pause' }));
    assert.deepEqual(errorCodes(problems), [C.PROBLEM.NO_CONTAINERS]);
    assert.equal(problems[0].consistency, 'pause');
});

test('validate rejects stop with no containers', () => {
    assert.deepEqual(errorCodes(C.validate(src({ consistency: 'stop', containers: [] }))),
        [C.PROBLEM.NO_CONTAINERS]);
});

test('validate rejects the dump mode with no container to exec into', () => {
    const problems = C.validate(src({ consistency: 'command', command: 'mongodump' }));
    assert.deepEqual(errorCodes(problems), [C.PROBLEM.NO_CONTAINERS]);
});

test('validate does not demand containers for a live copy', () => {
    assert.deepEqual(C.validate(src({ consistency: 'none', containers: [] })), []);
});

test('validate accepts shell metacharacters in the dump command — it runs under sh -c', () => {
    assert.deepEqual(C.validate(src({
        consistency: 'command', containers: ['db'],
        command: 'mysqldump --all-databases | gzip > /backup/all.sql.gz; echo $?'
    })), []);
});

test('validate rejects a NUL byte in the dump command', () => {
    assert.deepEqual(errorCodes(C.validate(src({
        consistency: 'command', containers: ['db'], command: 'mongodump' + NUL
    }))), [C.PROBLEM.COMMAND_NUL]);
});

test('validate rejects a non-string dump command', () => {
    assert.deepEqual(errorCodes(C.validate(src({
        consistency: 'command', containers: ['db'], command: ['mongodump']
    }))), [C.PROBLEM.COMMAND_TYPE]);
});

test('validate skips mode-specific checks when the mode itself is unknown', () => {
    const problems = C.validate(src({ consistency: 'freeze', containers: [] }));
    assert.deepEqual(errorCodes(problems), [C.PROBLEM.BAD_CONSISTENCY]);
});

// ---- validate: the database warning matrix --------------------------------

test('validate warns for every database hint under a live copy', () => {
    C.DATABASE_HINTS.forEach((hint) => {
        const name = 'app-' + hint + '-1';
        const problems = C.validate(src({ consistency: 'none', containers: [name] }));
        assert.deepEqual(errorCodes(problems), [], hint);
        assert.deepEqual(warningCodes(problems), [C.PROBLEM.LIVE_DATABASE], hint);
        assert.equal(problems[0].container, name);
        assert.equal(problems[0].match, hint);
    });
});

test('validate does not warn about a database under pause, stop or dump', () => {
    ['pause', 'stop'].forEach((mode) => {
        const problems = C.validate(src({ consistency: mode, containers: ['pg'] }));
        assert.equal(findCode(problems, C.PROBLEM.LIVE_DATABASE).length, 0, mode);
    });
    const dump = C.validate(src({
        consistency: 'command', containers: ['postgres'], command: 'pg_dumpall > /backup/all.sql'
    }));
    assert.equal(findCode(dump, C.PROBLEM.LIVE_DATABASE).length, 0);
});

test('validate warns even though pause is nominally safer — pause is not stop', () => {
    // Deliberate: 'pause' does not flush buffered writes, but the warning is scoped
    // to the mode that copies a genuinely moving target.
    const paused = C.validate(src({ consistency: 'pause', containers: ['mongo'] }));
    assert.deepEqual(warningCodes(paused), []);
    const live = C.validate(src({ consistency: 'none', containers: ['mongo'] }));
    assert.deepEqual(warningCodes(live), [C.PROBLEM.LIVE_DATABASE]);
});

test('validate warns once per database container and not for the others', () => {
    const problems = C.validate(src({
        consistency: 'none', containers: ['web', 'app-postgres-1', 'nginx', 'cache-redis']
    }));
    const warns = findCode(problems, C.PROBLEM.LIVE_DATABASE);
    assert.equal(warns.length, 2);
    assert.deepEqual(warns.map((w) => w.container), ['app-postgres-1', 'cache-redis']);
    assert.deepEqual(warns.map((w) => w.match), ['postgres', 'redis']);
});

test('validate does not warn for a live copy of purely static containers', () => {
    assert.deepEqual(C.validate(src({
        consistency: 'none', containers: ['web', 'nginx', 'static-assets']
    })), []);
});

test('validate warns case-insensitively', () => {
    const problems = C.validate(src({ consistency: 'none', containers: ['PROD-MongoDB'] }));
    assert.deepEqual(warningCodes(problems), [C.PROBLEM.LIVE_DATABASE]);
    assert.equal(problems[0].match, 'mongo');
});

test('validate does not warn about a database-shaped volume name, only a container', () => {
    // The volume is where the bytes are; the container is what is writing to them,
    // and only a running writer makes a live copy dangerous.
    assert.deepEqual(C.validate(src({ volumes: ['pgdata'], consistency: 'none' })), []);
});

test('the database warning never blocks a save', () => {
    const s = src({ consistency: 'none', containers: ['mongo'] });
    assert.equal(Sources.hasErrors(C.validate(s)), false);
    assert.equal(Sources.isValid(s), true);
});

test('validate does not warn for an unsafe container name it already rejected', () => {
    const problems = C.validate(src({ consistency: 'none', containers: ['mongo;rm -rf /'] }));
    assert.deepEqual(errorCodes(problems), [C.PROBLEM.CONTAINER_UNSAFE]);
    assert.deepEqual(warningCodes(problems), []);
});

// ---- validate: excludes and tags ------------------------------------------

test('validate rejects empty, non-string and NUL-bearing exclude patterns', () => {
    assert.deepEqual(errorCodes(C.validate(src({ excludes: ['', 3, 'a' + NUL] }))),
        [C.PROBLEM.PATTERN_EMPTY, C.PROBLEM.PATTERN_TYPE, C.PROBLEM.PATTERN_NUL]);
});

test('validate rejects a non-array excludes field but accepts globs', () => {
    assert.deepEqual(errorCodes(C.validate(src({ excludes: '*.tmp' }))), [C.PROBLEM.PATTERN_TYPE]);
    assert.deepEqual(C.validate(src({ excludes: ['**/tmp', '*.sock'] })), []);
});

test('validate rejects a tag containing a comma, which restic would split in two', () => {
    const problems = C.validate(src({ tags: ['daily,weekly'] }));
    assert.deepEqual(errorCodes(problems), [C.PROBLEM.TAG_COMMA]);
    assert.equal(problems[0].tag, 'daily,weekly');
});

test('validate rejects empty, non-string, NUL-bearing tags and a non-array tags field', () => {
    assert.deepEqual(errorCodes(C.validate(src({ tags: ['', 1, 'x' + NUL] }))),
        [C.PROBLEM.TAG_EMPTY, C.PROBLEM.TAG_TYPE, C.PROBLEM.TAG_NUL]);
    assert.deepEqual(errorCodes(C.validate(src({ tags: 'daily' }))), [C.PROBLEM.TAG_TYPE]);
});

test('validate accepts unicode and spaces in tags, which are not argv-hostile', () => {
    assert.deepEqual(C.validate(src({ tags: ['nightly run', 'yedek-günlük'] })), []);
});

// ---- toResticArgs ----------------------------------------------------------

test('toResticArgs emits excludes, tags and then the resolved paths', () => {
    const args = C.toResticArgs(src({
        volumes: ['appdata', 'pgdata'],
        excludes: ['*.sock', '**/tmp'],
        tags: ['nightly', 'containers'],
        resolvedPaths: ['/m/pgdata/_data', '/m/appdata/_data']
    }));
    assert.deepEqual(args, [
        '--exclude', '*.sock',
        '--exclude', '**/tmp',
        '--tag', 'nightly',
        '--tag', 'containers',
        '/m/appdata/_data', '/m/pgdata/_data'
    ]);
});

test('toResticArgs on a minimal resolved source is just the path', () => {
    assert.deepEqual(C.toResticArgs(src({ resolvedPaths: ['/m/appdata/_data'] })),
        ['/m/appdata/_data']);
});

test('toResticArgs puts every path after every flag', () => {
    const args = C.toResticArgs(src({
        excludes: ['*.tmp'], tags: ['t'], resolvedPaths: ['/m/a', '/m/b']
    }));
    assert.deepEqual(args.slice(args.indexOf('/m/a')), ['/m/a', '/m/b']);
    assert.ok(args.indexOf('/m/a') > args.lastIndexOf('t'));
});

test('toResticArgs is stable under input shuffling', () => {
    const base = { excludes: ['*.tmp'], tags: ['nightly'] };
    const a = C.toResticArgs(src(Object.assign({ resolvedPaths: ['/m/a', '/m/b', '/m/c'] }, base)));
    const b = C.toResticArgs(src(Object.assign({ resolvedPaths: ['/m/c', '/m/a', '/m/b'] }, base)));
    const c = C.toResticArgs(src(Object.assign({ resolvedPaths: ['/m/b//', '/m/c/', '/m/a'] }, base)));
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
});

test('toResticArgs de-duplicates two volumes that resolved to the same path', () => {
    assert.deepEqual(C.toResticArgs(src({
        volumes: ['a', 'b'], resolvedPaths: ['/m/shared', '/m/shared']
    })), ['/m/shared']);
});

test('toResticArgs gives every tag and exclude its own flag', () => {
    assert.deepEqual(C.toResticArgs(src({ tags: ['a', 'b'], resolvedPaths: ['/m/x'] })),
        ['--tag', 'a', '--tag', 'b', '/m/x']);
});

test('toResticArgs throws a typed error when the source has not been resolved', () => {
    assert.throws(() => C.toResticArgs(src()), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.equal(e.kind, Errors.KIND.GENERIC);
        assert.equal(e.detail.code, C.PROBLEM.NOT_RESOLVED);
        assert.deepEqual(e.detail.volumes, ['appdata']);
        assert.match(e.message, /resolve/);
        return true;
    });
});

test('toResticArgs throws rather than guessing when resolvedPaths is empty', () => {
    assert.throws(() => C.toResticArgs(src({ resolvedPaths: [] })), Errors.isHangarError);
    assert.throws(() => C.toResticArgs(src({ resolvedPaths: null })), Errors.isHangarError);
});

test('toResticArgs throws when a resolved path is not absolute', () => {
    assert.throws(() => C.toResticArgs(src({ resolvedPaths: ['m/appdata'] })), (e) => {
        assert.equal(e.detail.code, C.PROBLEM.NOT_RESOLVED);
        assert.match(e.message, /not absolute/);
        return true;
    });
});

test('toResticArgs passes spaces and unicode in a mount path through unquoted', () => {
    assert.deepEqual(C.toResticArgs(src({ resolvedPaths: ['/m/yedek günlüğü/_data'] })),
        ['/m/yedek günlüğü/_data']);
});

test('going through HangarSources.toResticArgs still validates first', () => {
    assert.throws(() => Sources.toResticArgs(src({ volumes: [], resolvedPaths: ['/m/a'] })), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.equal(e.detail.problems[0].code, C.PROBLEM.NO_VOLUMES);
        return true;
    });
});

// ---- preCommands / postCommands -------------------------------------------

test('the live-copy mode runs nothing before or after', () => {
    const s = src({ consistency: 'none', containers: ['web', 'db'] });
    assert.deepEqual(C.preCommands(s), []);
    assert.deepEqual(C.postCommands(s), []);
});

test('pause pauses in order and unpauses in reverse', () => {
    const s = src({ consistency: 'pause', containers: ['web', 'app', 'db'], user: 'appuser' });
    assert.deepEqual(C.preCommands(s), [
        ['runuser', '-u', 'appuser', '--', 'podman', 'pause', 'web'],
        ['runuser', '-u', 'appuser', '--', 'podman', 'pause', 'app'],
        ['runuser', '-u', 'appuser', '--', 'podman', 'pause', 'db']
    ]);
    assert.deepEqual(C.postCommands(s), [
        ['runuser', '-u', 'appuser', '--', 'podman', 'unpause', 'db'],
        ['runuser', '-u', 'appuser', '--', 'podman', 'unpause', 'app'],
        ['runuser', '-u', 'appuser', '--', 'podman', 'unpause', 'web']
    ]);
});

test('stop stops in order and starts in reverse, so dependencies come back first', () => {
    const s = src({ consistency: 'stop', containers: ['web', 'db'], user: 'root' });
    assert.deepEqual(C.preCommands(s), [
        ['podman', 'stop', 'web'],
        ['podman', 'stop', 'db']
    ]);
    assert.deepEqual(C.postCommands(s), [
        ['podman', 'start', 'db'],
        ['podman', 'start', 'web']
    ]);
});

test('post is exactly the reverse of pre, container for container', () => {
    ['pause', 'stop'].forEach((mode) => {
        const s = src({ consistency: mode, containers: ['a', 'b', 'c', 'd'], user: '' });
        const pre = C.preCommands(s).map((c) => c[c.length - 1]);
        const post = C.postCommands(s).map((c) => c[c.length - 1]);
        assert.deepEqual(post, pre.slice().reverse(), mode);
    });
});

test('the dump mode execs the command through sh -c inside each container', () => {
    const s = src({
        consistency: 'command', containers: ['db'], user: 'appuser',
        command: 'pg_dump -U postgres shop | gzip > /backup/shop.sql.gz'
    });
    assert.deepEqual(C.preCommands(s), [[
        'runuser', '-u', 'appuser', '--', 'podman', 'exec', 'db', 'sh', '-c',
        'pg_dump -U postgres shop | gzip > /backup/shop.sql.gz'
    ]]);
});

test('the dump mode has nothing to undo afterwards', () => {
    assert.deepEqual(C.postCommands(src({
        consistency: 'command', containers: ['db'], command: 'mongodump'
    })), []);
});

test('the dump command is passed as one argv element, never spliced on spaces', () => {
    const cmd = 'sh -c "true"; echo $HOME';
    const argv = C.preCommands(src({ consistency: 'command', containers: ['db'], command: cmd }))[0];
    assert.equal(argv[argv.length - 1], cmd);
});

test('pre and post use the docker binary for a docker source', () => {
    const s = src({ runtime: 'docker', user: '', consistency: 'stop', containers: ['web'] });
    assert.deepEqual(C.preCommands(s), [['docker', 'stop', 'web']]);
    assert.deepEqual(C.postCommands(s), [['docker', 'start', 'web']]);
});

test('pre and post are empty when no containers are named', () => {
    ['pause', 'stop', 'command'].forEach((mode) => {
        const s = src({ consistency: mode, containers: [], command: 'x' });
        assert.deepEqual(C.preCommands(s), [], mode);
        assert.deepEqual(C.postCommands(s), [], mode);
    });
});

test('the dump mode emits nothing when the command is missing', () => {
    assert.deepEqual(C.preCommands(src({ consistency: 'command', containers: ['db'] })), []);
});

test('an unknown consistency mode falls back to doing nothing', () => {
    const s = src({ consistency: 'freeze', containers: ['web'] });
    assert.deepEqual(C.preCommands(s), []);
    assert.deepEqual(C.postCommands(s), []);
});

test('pre and post de-duplicate a container listed twice', () => {
    const s = src({ consistency: 'stop', containers: ['web', 'web', 'db'], user: '' });
    assert.deepEqual(C.preCommands(s).map((c) => c[2]), ['web', 'db']);
    assert.deepEqual(C.postCommands(s).map((c) => c[2]), ['db', 'web']);
});

test('pre and post never mutate the source', () => {
    const s = src({ consistency: 'stop', containers: ['web', 'db'] });
    const copy = JSON.parse(JSON.stringify(s));
    C.preCommands(s);
    C.postCommands(s);
    assert.deepEqual(s, copy);
});

// ---- describe --------------------------------------------------------------

test('describe names the runtime, the volume count and the live-copy mode', () => {
    assert.equal(C.describe(src({ user: '', volumes: ['appdata', 'media'] })),
        'Backs up 2 podman volumes, copying the files live.');
});

test('describe uses the singular for one volume', () => {
    assert.equal(C.describe(src({ user: '' })), 'Backs up 1 podman volume, copying the files live.');
});

test('describe names the owning user', () => {
    assert.equal(C.describe(src({ user: 'appuser' })),
        'Backs up 1 podman volume owned by appuser, copying the files live.');
});

test('describe names the runtime it will actually use', () => {
    assert.match(C.describe(src({ runtime: 'docker', user: '' })), /^Backs up 1 docker volume/);
});

test('describe names the paused or stopped containers', () => {
    assert.equal(C.describe(src({ user: '', consistency: 'pause', containers: ['web', 'db'] })),
        'Backs up 1 podman volume, pausing web and db during the copy.');
    assert.equal(C.describe(src({ user: '', consistency: 'stop', containers: ['db'] })),
        'Backs up 1 podman volume, stopping db during the copy.');
});

test('describe mentions the dump mode', () => {
    assert.equal(C.describe(src({
        user: '', consistency: 'command', containers: ['db'], command: 'mongodump'
    })), 'Backs up 1 podman volume, dumping from db first.');
});

test('describe truncates a long container list', () => {
    assert.equal(C.describe(src({
        user: '', consistency: 'stop', containers: ['a', 'b', 'c', 'd', 'e']
    })), 'Backs up 1 podman volume, stopping a, b, c and 2 more during the copy.');
});

test('describe appends the tags', () => {
    assert.equal(C.describe(src({ user: '', tags: ['nightly', 'containers'] })),
        'Backs up 1 podman volume, copying the files live, tagged nightly, containers.');
});

test('describe says so when there is nothing to back up', () => {
    assert.equal(C.describe(src({ volumes: [] })), 'Backs up nothing (no volumes selected).');
    assert.equal(C.describe(null), 'Backs up nothing (no volumes selected).');
});

test('describe never throws on junk', () => {
    [null, undefined, 42, [], { kind: 'container' }].forEach((s) => {
        assert.equal(typeof C.describe(s), 'string');
    });
});

// ---- impure layer under node (no cockpit) ---------------------------------

test('detectRuntime resolves to null with no Cockpit session rather than throwing', async () => {
    assert.equal(await C.detectRuntime(), null);
});

test('listVolumes resolves to an empty list with no Cockpit session', async () => {
    assert.deepEqual(await C.listVolumes('podman', 'appuser'), []);
});

test('listVolumes rejects with a typed error for an unbuildable command', async () => {
    await assert.rejects(() => C.listVolumes('lxc', 'appuser'), Errors.isHangarError);
    await assert.rejects(() => C.listVolumes('podman', 'bad;user'), Errors.isHangarError);
});

test('resolve rejects with a typed error when there is no host to ask', async () => {
    await assert.rejects(() => C.resolve(src()), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.equal(e.kind, Errors.KIND.GENERIC);
        return true;
    });
});

test('resolve rejects a source with no volumes before trying to talk to a runtime', async () => {
    await assert.rejects(() => C.resolve(src({ volumes: [] })), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.match(e.message, /no volumes/);
        return true;
    });
});

test('the module exports a pure surface with no cockpit reference in it', () => {
    // The guard is structural: the whole file must load and every pure function
    // must answer under node, where `cockpit` does not exist.
    const text = require('node:fs').readFileSync(
        require('node:path').join(__dirname, '../../js/core/sources-container.js'), 'utf8');
    text.split('\n').forEach((line, i) => {
        if (!/\bcockpit\b/.test(line)) return;
        if (line.trim().startsWith('//')) return;
        assert.ok(/typeof cockpit !== 'undefined'|cockpit\.spawn/.test(line),
            'unguarded cockpit reference at line ' + (i + 1) + ': ' + line.trim());
    });
});

// ---- adversarial: nothing reaches argv as more than one argument -----------
//
// Everything below exists because a container name, a volume name and the dump
// command all end up on a command line. The rule this section enforces is narrow
// and absolute: each of them travels as exactly ONE argv element, and a value that
// could not do so is refused with a typed error instead of being escaped, quoted
// or silently mangled.

// Names that are not merely rude but actively change what the command means.
// `--all` is the worst of them: `podman stop --all` stops every container on the
// host, so a source that got one past us would take down services the user never
// named.
const ARGV_HOSTILE_NAMES = [
    '--all', '-a', '--latest', '-l', '--force', '-f', '--time=0', '-',
    'a b', 'a\tb', 'a\nb', 'a\rb', 'a' + NUL + 'b',
    'a;id', 'a|id', 'a&&id', '$(id)', '`id`', '${IFS}', 'a>b', 'a<b',
    "a'b", 'a"b', 'a\\b', 'a*b', 'a?b', 'a[b]', '~root', '#a', '(a)',
    '../../etc/passwd', '/etc/passwd', './a', '..',
    '.lead', '_lead', 'yedek günlüğü', '日本', '😀'
];

function everyArgvElementIsAString(argv) {
    assert.ok(Array.isArray(argv));
    argv.forEach((a) => {
        assert.equal(typeof a, 'string');
        assert.notEqual(a, '');
    });
}

test('preCommands refuses a container name that would become a flag', () => {
    // `podman stop --all` is not a stop of the container called "--all"; it is a
    // stop of everything. validate() rejects the name, but preCommands is called
    // by the runner, not by the editor, so it has to refuse on its own.
    ['--all', '-a', '--latest', '-l', '-f'].forEach((name) => {
        ['pause', 'stop'].forEach((mode) => {
            assert.throws(() => C.preCommands(src({ consistency: mode, containers: [name] })),
                (e) => {
                    assert.ok(Errors.isHangarError(e));
                    assert.equal(e.kind, Errors.KIND.GENERIC);
                    assert.equal(e.detail.container, name);
                    assert.match(e.message, /flag|does not allow/);
                    return true;
                }, mode + ' ' + name);
        });
    });
});

test('postCommands refuses the same names, so the undo half cannot be the way in', () => {
    ['--all', '-l'].forEach((name) => {
        assert.throws(() => C.postCommands(src({ consistency: 'stop', containers: [name] })),
            Errors.isHangarError, name);
    });
});

test('the dump mode refuses a container name that would pick a different container', () => {
    // `podman exec --latest sh -c '<dump>'` runs the dump inside whichever
    // container started last — a dump of the wrong database, reported as success.
    assert.throws(() => C.preCommands(src({
        consistency: 'command', containers: ['--latest'], command: 'pg_dump app'
    })), Errors.isHangarError);
});

test('one bad container in the list refuses the whole vector, not just its own command', () => {
    // A half-built vector is worse than none: the caller would run the safe half
    // and stop real containers for a backup that then refuses to start.
    assert.throws(() => C.preCommands(src({
        consistency: 'stop', containers: ['web', '--all', 'db']
    })), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.equal(e.detail.container, '--all');
        return true;
    });
});

test('every hostile container name is refused rather than escaped', () => {
    ARGV_HOSTILE_NAMES.forEach((name) => {
        ['pause', 'stop', 'command'].forEach((mode) => {
            const s = src({ consistency: mode, containers: [name], command: 'dump' });
            assert.throws(() => C.preCommands(s), Errors.isHangarError, mode + ' ' + JSON.stringify(name));
            assert.throws(() => C.postCommands(s), Errors.isHangarError, mode + ' ' + JSON.stringify(name));
        });
        assert.throws(() => C.volumeInspectArgv('podman', '', name), Errors.isHangarError,
            JSON.stringify(name));
    });
    // The empty name is the one exception, and deliberately so: normalize drops it
    // before it can reach argv, and validate reports the resulting "no containers"
    // rather than a name complaint.
    assert.deepEqual(C.preCommands(src({ consistency: 'stop', containers: [''] })), []);
    assert.throws(() => C.volumeInspectArgv('podman', '', ''), Errors.isHangarError);
});

test('a legitimate name always lands as exactly one argv element, byte for byte', () => {
    // The real names this has to survive: compose's generated names, anonymous
    // volume hashes, and the dots and dashes both runtimes allow.
    const names = ['app-postgres-1', 'app_db.1', 'a'.repeat(200), '0abc',
        'f'.repeat(64), 'x.y-z_0'];
    names.forEach((name) => {
        const inspect = C.volumeInspectArgv('podman', 'appuser', name);
        everyArgvElementIsAString(inspect);
        assert.deepEqual(inspect, ['runuser', '-u', 'appuser', '--', 'podman', 'volume', 'inspect', name]);
        assert.equal(inspect.filter((a) => a === name).length, 1);

        const pre = C.preCommands(src({ consistency: 'stop', containers: [name] }));
        assert.equal(pre.length, 1);
        everyArgvElementIsAString(pre[0]);
        assert.deepEqual(pre[0], ['runuser', '-u', 'appuser', '--', 'podman', 'stop', name]);
    });
});

test('the dump command is one argument however shell-like it looks', () => {
    // Shell metacharacters in the command are the POINT — it runs under `sh -c`
    // inside the container, and the useful dumps are pipelines. What matters is
    // that the whole pipeline is one argv element and cannot become two.
    const commands = [
        'pg_dump app | gzip > /backup/app.sql.gz',
        "mysqldump --all-databases | zstd -o '/backup/all.sql.zst'",
        'sh -c "echo $(date)"; rm -rf /nope',
        'mongodump\n--archive=/backup/db.gz\n--gzip',
        'echo "yedek günlüğü 😀" > /backup/utf8',
        'a'.repeat(4096)
    ];
    commands.forEach((command) => {
        const argv = C.preCommands(src({ consistency: 'command', containers: ['db'], command }))[0];
        assert.deepEqual(argv.slice(0, 7),
            ['runuser', '-u', 'appuser', '--', 'podman', 'exec', 'db']);
        assert.deepEqual(argv.slice(7), ['sh', '-c', command]);
        assert.equal(argv.length, 10);
        assert.equal(argv[9], command);
    });
});

test('a dump command carrying a NUL is refused at the point it becomes argv', () => {
    // The command is the one field allowed to be shell — it runs under `sh -c`
    // inside the container. A NUL is still not allowed: execve truncates the
    // argument there, so the command that ran would not be the command that was
    // reviewed. validate() says so, but preCommands() is called by the runner
    // rather than the editor and must refuse on its own, exactly as it does for a
    // container name.
    const s = src({
        consistency: 'command', containers: ['db'],
        command: 'pg_dump app > /backup/app.sql' + NUL + '; curl evil.example'
    });
    assert.deepEqual(errorCodes(C.validate(s)), [C.PROBLEM.COMMAND_NUL]);
    assert.throws(() => C.preCommands(s), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.equal(e.kind, Errors.KIND.GENERIC);
        assert.match(e.message, /NUL/);
        return true;
    });
    // Nothing to undo after a dump, so postCommands stays empty either way —
    // the refusal must not turn into a throw the runner's finally cannot survive.
    assert.deepEqual(C.postCommands(s), []);
});

test('the user name cannot smuggle an extra runuser argument', () => {
    // runuser's own options come before `--`; a user name that parsed as one would
    // change who the command runs as, which is the whole security boundary here.
    ['-u root', '--user=root', 'appuser --preserve-environment', 'appuser;root', 'appuser root']
        .forEach((user) => {
            assert.throws(() => C.asUser(user, ['podman', 'ps']), Errors.isHangarError, user);
        });
    assert.deepEqual(C.asUser('appuser', ['podman', 'ps']).indexOf('--'), 3,
        'runuser option parsing must stop at a "--" we placed, at a fixed position');
});

test('asUser refuses an argv holding anything that is not a string', () => {
    // cockpit stringifies what it is given, so `null` would arrive at execve as
    // the literal argument "null" — in the position a container name was meant to
    // occupy.
    [[null], ['podman', undefined], ['podman', 5], ['podman', {}], ['podman', ['ps']]]
        .forEach((argv) => {
            assert.throws(() => C.asUser('appuser', argv), Errors.isHangarError, JSON.stringify(argv));
            assert.throws(() => C.asUser('', argv), Errors.isHangarError, JSON.stringify(argv));
        });
});

test('no builder ever produces a single string that a shell would have to split', () => {
    // Restated as a property over everything this module can build: an argv is a
    // list, never a command line, so nothing may arrive pre-joined.
    const built = [
        C.volumeListArgv('podman', 'appuser'),
        C.volumeInspectArgv('docker', '', 'appdata'),
        C.containerListArgv('podman', 'appuser'),
        C.asUser('appuser', ['podman', 'ps'])
    ].concat(
        C.preCommands(src({ consistency: 'stop', containers: ['web', 'db'] })),
        C.postCommands(src({ consistency: 'stop', containers: ['web', 'db'] }))
    );
    built.forEach((argv) => {
        everyArgvElementIsAString(argv);
        argv.forEach((a) => {
            assert.equal(a.indexOf(NUL), -1);
            assert.ok(!/[\r\n]/.test(a), 'a newline in argv: ' + JSON.stringify(a));
        });
    });
});

test('toResticArgs refuses a resolved path carrying a NUL byte', () => {
    // execve truncates at a NUL, so restic would be handed a shorter path than the
    // one we logged — a backup of a directory nobody chose.
    assert.throws(() => C.toResticArgs(src({ resolvedPaths: ['/m/app' + NUL + '/_data'] })),
        (e) => {
            assert.ok(Errors.isHangarError(e));
            assert.equal(e.detail.code, C.PROBLEM.NOT_RESOLVED);
            assert.match(e.message, /NUL/);
            return true;
        });
});

test('a NUL in an inspected mount point is dropped rather than passed on', () => {
    // JSON can carry a NUL that no real path can. Dropping it here is what makes
    // resolve() say "this volume has no mount point" and name the volume, instead
    // of handing restic an argument that means something else.
    const entries = C.parseVolumeInspect(
        '[{"Name":"appdata","Mountpoint":"/m/app\\u0000data/_data"}]');
    assert.equal(entries.length, 1);
    assert.deepEqual(C.mountpointsFor(entries, ['appdata']), []);
});

// ---- adversarial: hostile input never throws an untyped exception ----------

test('parseVolumeInspect survives deeply nested JSON without a stack overflow', () => {
    // JSON.parse accepts tens of thousands of nested arrays quite happily. A
    // recursive flattener does not, and a bare RangeError out of a parser is an
    // untyped throw from data we did not write.
    const deep = '['.repeat(20000) + ']'.repeat(20000);
    assert.deepEqual(C.parseVolumeInspect(deep), []);
    const deepWithPayload = '['.repeat(5000) + '{"Name":"v","Mountpoint":"/m/v"}' +
        ']'.repeat(5000);
    assert.deepEqual(C.parseVolumeInspect(deepWithPayload),
        [{ name: 'v', mountpoint: '/m/v', labels: {}, driver: '' }]);
});

test('every public function answers or throws a HangarError for any junk field', () => {
    // The blanket rule, asserted over the product of every field and every shape
    // of hostile value: an untyped exception out of a pure function becomes an
    // unhandled rejection in the UI, with no message the user can act on.
    const values = [
        undefined, null, '', 0, 1, -1, NaN, true, false, [], {}, Object.create(null),
        () => {}, Symbol('s'), new Date(), /re/, new Map(),
        NUL, '\n', '../..', '/etc/../etc', '-x', '--all', '$(id)', 'a;b', 'é😀',
        'x'.repeat(5000), [NUL], ['a', null], [['nested']], [{}], [undefined]
    ];
    const fields = ['id', 'kind', 'runtime', 'user', 'volumes', 'containers',
        'consistency', 'command', 'excludes', 'tags', 'resolvedPaths'];
    const fns = ['normalize', 'validate', 'describe', 'toResticArgs',
        'preCommands', 'postCommands'];
    // Some of these values cannot be turned into a string at all — which is the
    // point of including them — so the label has to be defensive too.
    const say = (v) => { try { return String(v); } catch (e) { return typeof v; } };

    fields.forEach((field) => {
        values.forEach((value) => {
            const s = src({ containers: ['db'], resolvedPaths: ['/m/appdata'] });
            s[field] = value;
            fns.forEach((fn) => {
                try {
                    C[fn](s);
                } catch (e) {
                    assert.ok(Errors.isHangarError(e),
                        fn + ' threw untyped for ' + field + '=' + say(value) + ': ' + e);
                }
            });
        });
    });
});

test('validate always answers with a well-formed problem list, whatever it is given', () => {
    const junk = [undefined, null, 0, '', 'x', [], [1], () => {}, new Map(),
        Object.create(null), { kind: 'container' }, JSON.parse('{"__proto__":{"x":1}}')];
    junk.forEach((s, i) => {
        const problems = C.validate(s);
        assert.ok(Array.isArray(problems), 'case ' + i);
        problems.forEach((p) => {
            assert.equal(typeof p.code, 'string');
            assert.equal(typeof p.message, 'string');
            assert.ok(p.severity === 'error' || p.severity === 'warning');
        });
    });
    assert.equal({}.x, undefined, 'a __proto__ key from parsed JSON must not escape');
});

// ---- the try/finally guarantee: nothing is left paused or stopped ---------
//
// The design is explicit that a container left stopped because a backup failed is
// a worse outcome than the failed backup. The runner is what wraps the two halves
// in try/finally; what this module has to guarantee is that the undo half is
// COMPLETE and needs no knowledge of how far the do half got — otherwise the
// runner has nothing it can call from a finally block.

// A minimum-viable runtime: just enough state to answer "was anything left paused
// or stopped when the backup blew up".
function fakeRuntime(names) {
    const state = new Map(names.map((n) => [n, 'running']));
    return {
        exec(argv) {
            const i = argv.indexOf('podman');
            const verb = argv[i + 1];
            const name = argv[i + 2];
            if (verb === 'exec') return;              // a dump changes no state
            if (!state.has(name)) throw new Error('no such container: ' + name);
            if (verb === 'pause') state.set(name, 'paused');
            else if (verb === 'unpause') state.set(name, 'running');
            else if (verb === 'stop') state.set(name, 'stopped');
            else if (verb === 'start') state.set(name, 'running');
            else throw new Error('unexpected verb: ' + verb);
        },
        notRunning() {
            return [...state.entries()].filter(([, v]) => v !== 'running').map(([n]) => n);
        }
    };
}

// The runner's shape, reduced to the one thing being tested: post always runs.
function backupWithFailureAt(source, rt, failAt) {
    const pre = C.preCommands(source);
    const post = C.postCommands(source);
    let failed = null;
    try {
        pre.forEach((argv, i) => {
            if (i === failAt) throw new Error('the runtime refused step ' + i);
            rt.exec(argv);
        });
        if (failAt >= pre.length) throw new Error('restic failed after the pre commands');
    } catch (e) {
        failed = e;
    } finally {
        // Every post command is attempted even if an earlier one fails: unpausing
        // a container that was never paused is an error, and stopping there would
        // strand the containers after it.
        post.forEach((argv) => { try { rt.exec(argv); } catch (e) { /* keep unwinding */ } });
    }
    return failed;
}

['pause', 'stop'].forEach((mode) => {
    test('a backup that fails mid-' + mode + ' still leaves every container running', () => {
        const containers = ['web', 'api', 'db'];
        const source = src({ consistency: mode, containers });
        // Every failure point, including "after all the pre commands succeeded",
        // which is where a restic failure actually lands.
        for (let failAt = 0; failAt <= containers.length; failAt++) {
            const rt = fakeRuntime(containers);
            const failure = backupWithFailureAt(source, rt, failAt);
            assert.ok(failure, 'the failure must still be reported, not swallowed');
            assert.deepEqual(rt.notRunning(), [],
                'containers left down after a failure at step ' + failAt);
        }
    });
});

test('a backup that fails during the dump leaves the containers untouched', () => {
    const containers = ['web', 'db'];
    const rt = fakeRuntime(containers);
    const source = src({ consistency: 'command', containers, command: 'pg_dump app' });
    assert.ok(backupWithFailureAt(source, rt, 1));
    assert.deepEqual(rt.notRunning(), []);
});

test('a successful backup also leaves every container running', () => {
    ['pause', 'stop', 'command'].forEach((mode) => {
        const containers = ['web', 'db'];
        const rt = fakeRuntime(containers);
        const source = src({ consistency: mode, containers, command: 'dump' });
        C.preCommands(source).forEach((argv) => rt.exec(argv));
        C.postCommands(source).forEach((argv) => rt.exec(argv));
        assert.deepEqual(rt.notRunning(), [], mode);
    });
});

test('the undo half is derivable from the source alone, at any point in the run', () => {
    // This is what makes a finally block possible: postCommands never needs to be
    // told which pre commands ran, so the runner can always compute it — including
    // when the failure happened before a single pre command was issued.
    const source = src({ consistency: 'stop', containers: ['web', 'api', 'db'] });
    const before = C.postCommands(source);
    C.preCommands(source);                       // "running" the pre half changes nothing
    assert.deepEqual(C.postCommands(source), before);
    assert.deepEqual(C.postCommands(JSON.parse(JSON.stringify(source))), before);
});

test('the undo half touches exactly the containers the do half touches', () => {
    // A container the pre half stops but the post half does not start is a service
    // that stays down. Set equality, not just counts.
    ['pause', 'stop'].forEach((mode) => {
        const containers = ['web', 'api', 'db', 'cache'];
        const source = src({ consistency: mode, containers });
        const named = (cmds) => cmds.map((c) => c[c.length - 1]).sort();
        assert.deepEqual(named(C.postCommands(source)), named(C.preCommands(source)), mode);
        assert.deepEqual(named(C.preCommands(source)), containers.slice().sort(), mode);
    });
});

// ---- the consistency warnings must actually reach the user ---------------

test('a live copy of a database warns through the shared HangarSources seam', () => {
    // The UI calls HangarSources.validate, not this module. A warning that only
    // exists on the kind's own validate() would never be seen.
    const s = src({ consistency: 'none', containers: ['app-mongo-1'], resolvedPaths: ['/m/appdata'] });
    const problems = Sources.validate(s);
    const warnings = problems.filter((p) => p.code === C.PROBLEM.LIVE_DATABASE);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].severity, Sources.SEVERITY.WARNING);
    assert.equal(warnings[0].container, 'app-mongo-1');
    assert.match(warnings[0].message, /will not restore/);
});

test('the database warning is a warning: it never blocks the backup being built', () => {
    // A warning the user cannot proceed past would be an error; one that silently
    // stops the run would be worse. Both halves are asserted here.
    const s = src({ consistency: 'none', containers: ['app-mongo-1'], resolvedPaths: ['/m/appdata'] });
    assert.equal(Sources.hasErrors(Sources.validate(s)), false);
    assert.equal(Sources.isValid(s), true);
    assert.deepEqual(Sources.toResticArgs(s), ['/m/appdata']);
});

test('the database warning survives alongside errors instead of being short-circuited', () => {
    // The editor shows every problem at once. A warning dropped because some other
    // field was also wrong would come back only after the user fixed the field —
    // which is the moment they have stopped reading.
    const s = src({ id: '', consistency: 'none', containers: ['redis-cache'], volumes: [] });
    const codes = C.validate(s).map((p) => p.code);
    assert.ok(codes.includes(C.PROBLEM.BAD_ID));
    assert.ok(codes.includes(C.PROBLEM.NO_VOLUMES));
    assert.ok(codes.includes(C.PROBLEM.LIVE_DATABASE));
});

test('a warning-only source still produces a usable typed error object if asked', () => {
    // toError() is what the UI turns a problem list into. Handed warnings alone it
    // must still say something specific rather than the generic fallback.
    const warnings = C.validate(src({ consistency: 'none', containers: ['postgres-main'] }))
        .filter((p) => p.severity === 'warning');
    assert.ok(warnings.length > 0);
    const e = Sources.toError(warnings);
    assert.ok(Errors.isHangarError(e));
    assert.notEqual(e.message, 'Invalid backup source.');
});

test('every consistency mode carries the honest description the picker shows', () => {
    // The warning is only half the story: the mode list is what the user reads
    // while choosing, so an empty or missing description would hide the trade-off.
    C.CONSISTENCY_IDS.forEach((id) => {
        const mode = C.CONSISTENCY[id];
        assert.equal(mode.id, id);
        assert.ok(mode.label.length > 0, id);
        assert.ok(mode.description.length > 40, id + ' has no real description');
        assert.ok([C.RISK.HIGH, C.RISK.MEDIUM, C.RISK.LOW].includes(mode.risk), id);
    });
    assert.equal(C.CONSISTENCY.none.risk, C.RISK.HIGH);
    assert.match(C.CONSISTENCY.none.description, /unsafe for a running database/i);
});

test('a hostile owning user is refused when the pre/post vector is built', () => {
    // The user name decides which runtime store is read and which account the
    // stop/start runs as. It reaches argv through asUser, so the refusal has to
    // hold on the path the runner actually takes, not only on asUser directly.
    ['-u root', 'appuser;root', 'root appuser', '1user', 'a'.repeat(40), 'is met'].forEach((user) => {
        const s = src({ user, consistency: 'stop', containers: ['db'] });
        assert.throws(() => C.preCommands(s), Errors.isHangarError, user);
        assert.throws(() => C.postCommands(s), Errors.isHangarError, user);
        assert.throws(() => C.volumeListArgv('podman', user), Errors.isHangarError, user);
    });
});

test('resolve rejects a hostile owning user without ever spawning anything', async () => {
    // Rejected as a promise rather than thrown synchronously — the caller awaits
    // resolve(), and a synchronous throw out of an async-looking function is an
    // unhandled one — and the runtime is never invoked at all.
    const spawned = [];
    globalThis.cockpit = { spawn(argv) { spawned.push(argv); return Promise.resolve(''); } };
    try {
        await assert.rejects(() => C.resolve(src({ user: 'is;met' })), Errors.isHangarError);
        await assert.rejects(() => C.resolve(src({ volumes: ['--all'] })), Errors.isHangarError);
        assert.deepEqual(spawned, []);
    } finally {
        delete globalThis.cockpit;
    }
});
