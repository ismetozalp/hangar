'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const S = require('../../js/core/secrets.js');
const Errors = require('../../js/core/errors.js');

const SRC = path.join(__dirname, '../../js/core/secrets.js');

// Every rejection out of the path guard must be a typed GENERIC HangarError,
// never a bare Error — the UI switches on `kind`.
function assertGuard(fn) {
    assert.throws(fn, (e) => {
        assert.equal(e.name, 'HangarError', 'not a HangarError');
        assert.equal(e.kind, Errors.KIND.GENERIC);
        assert.equal(e.fatal, true);
        return true;
    });
}

// A stand-in for the cockpit global. The module reaches for `cockpit` at call
// time, so installing it on globalThis is enough to exercise the I/O layer.
function fakeCockpit(opts) {
    opts = opts || {};
    const calls = { spawn: [], file: [], replace: [], reads: 0, closes: 0 };
    globalThis.cockpit = {
        spawn(argv, o) {
            calls.spawn.push({ argv, opts: o });
            if (opts.spawnFails) return Promise.reject(opts.spawnFails);
            // Fail one step of writeKey's install/chmod/chown sequence, so the
            // window between "file written" and "file locked down" is testable.
            if (opts.spawnFailsOn && argv[0] === opts.spawnFailsOn)
                return Promise.reject(new Error(argv[0] + ': operation failed'));
            return Promise.resolve('');
        },
        file(p, o) {
            calls.file.push({ path: p, opts: o });
            return {
                read() {
                    calls.reads++;
                    // ...RejectsWith exists so a test can reject with a falsy
                    // value, which is exactly the case that trips a `if (err)`.
                    if ('readRejectsWith' in opts) return Promise.reject(opts.readRejectsWith);
                    if (opts.readFails) return Promise.reject(opts.readFails);
                    return Promise.resolve('content' in opts ? opts.content : 'hunter2');
                },
                replace(v) {
                    calls.replace.push(v);
                    if ('replaceRejectsWith' in opts) return Promise.reject(opts.replaceRejectsWith);
                    if (opts.replaceFails) return Promise.reject(opts.replaceFails);
                    return Promise.resolve();
                },
                close() { calls.closes++; }
            };
        }
    };
    return calls;
}

function dropCockpit() { delete globalThis.cockpit; }

// ---------------------------------------------------------------- keyPath ---

test('keyPath: builds the documented /etc/hangar/repos/<id>.key path', () => {
    assert.equal(S.keyPath('home'), '/etc/hangar/repos/home.key');
});

test('keyPath: accepts digits and internal dashes', () => {
    assert.equal(S.keyPath('nas-2-offsite'), '/etc/hangar/repos/nas-2-offsite.key');
    assert.equal(S.keyPath('0'), '/etc/hangar/repos/0.key');
});

test('keyPath: accepts an id exactly at the length limit', () => {
    const id = 'a'.repeat(S.MAX_ID_LEN);
    assert.equal(S.keyPath(id), '/etc/hangar/repos/' + id + '.key');
});

test('keyPath: rejects an id one character over the length limit', () => {
    assertGuard(() => S.keyPath('a'.repeat(S.MAX_ID_LEN + 1)));
});

test('keyPath: the resolved path can never escape the repo directory', () => {
    // Belt and braces: whatever survives the guard must normalise back into REPO_DIR.
    ['home', 'a-b-c', 'x9'].forEach((id) => {
        assert.equal(path.dirname(path.normalize(S.keyPath(id))), S.REPO_DIR);
    });
});

// Path traversal and injection. One test per hostile shape so a regression names
// the exact input that got through.
const HOSTILE_IDS = [
    ['empty string', ''],
    ['single dot', '.'],
    ['double dot', '..'],
    ['triple dot', '...'],
    ['classic traversal', '../../etc/shadow'],
    ['traversal suffix', 'home/..'],
    ['traversal infix', 'a/../../b'],
    ['dot-dot without slash', 'a..b'],
    ['leading slash', '/etc/passwd'],
    ['absolute key path', '/etc/hangar/repos/home'],
    ['trailing slash', 'home/'],
    ['bare slash', '/'],
    ['embedded slash', 'a/b'],
    ['backslash', 'a\\b'],
    ['windows traversal', '..\\..\\windows'],
    ['NUL byte', 'home\u0000'],
    ['NUL infix', 'ho\u0000me'],
    ['NUL then traversal', 'home\u0000/../etc'],
    ['url-encoded traversal', '%2e%2e%2fetc'],
    ['url-encoded slash', 'a%2Fb'],
    ['double-encoded traversal', '%252e%252e'],
    ['uppercase', 'Home'],
    ['mixed case', 'myRepo'],
    ['underscore', 'my_repo'],
    ['dot in name', 'my.repo'],
    ['space', 'my repo'],
    ['leading space', ' home'],
    ['trailing space', 'home '],
    ['tab', 'home\thome'],
    ['newline (unit-file injection)', 'home\nLoadCredential=x:/etc/shadow'],
    ['carriage return', 'home\r'],
    ['leading dash (argv injection)', '-rf'],
    ['double dash', '--password'],
    ['colon (credential separator)', 'a:b'],
    ['semicolon', 'a;b'],
    ['shell substitution', '$(id)'],
    ['backtick', '`id`'],
    ['glob', 'home*'],
    ['tilde', '~root'],
    ['unicode accent', 'r\u00e9po'],
    ['fullwidth homoglyph', '\uff48ome'],
    ['zero-width joiner', 'ho\u200dme'],
    ['rtl override', 'home\u202e'],
    ['emoji', 'home\u{1f4be}'],
    ['numeric type', 42],
    ['null', null],
    ['undefined', undefined],
    ['boolean', true],
    ['array', ['home']],
    ['object without id', {}],
    ['String object', new String('home')]     // eslint-disable-line no-new-wrappers
];

HOSTILE_IDS.forEach(([label, id]) => {
    test('keyPath: rejects ' + label, () => {
        assertGuard(() => S.keyPath(id));
    });
});

test('keyPath: guard error detail names the offending id', () => {
    try {
        S.keyPath('my repo');
        assert.fail('expected a throw');
    } catch (e) {
        assert.equal(e.detail.repoId, 'my repo');
    }
});

test('keyPath: NUL detail is escaped rather than raw', () => {
    try {
        S.keyPath('ho\u0000me');
        assert.fail('expected a throw');
    } catch (e) {
        assert.equal(e.detail.repoId.indexOf('\u0000'), -1);
    }
});

test('validateRepoId: returns the id unchanged when it is acceptable', () => {
    assert.equal(S.validateRepoId('home-nas-1'), 'home-nas-1');
});

test('validateRepoId: distinguishes the non-string case in the detail', () => {
    try {
        S.validateRepoId(42);
        assert.fail('expected a throw');
    } catch (e) {
        assert.equal(e.detail.type, 'number');
    }
});

test('ID_RE: is anchored at both ends', () => {
    assert.equal(S.ID_RE.test('home\nevil'), false);
    assert.equal(S.ID_RE.test('evil\nhome'), false);
});

// ----------------------------------------------------------- passwordArgs ---

test('passwordArgs: emits --password-file with the key path', () => {
    assert.deepEqual(S.passwordArgs({ id: 'home' }),
        ['--password-file', '/etc/hangar/repos/home.key']);
});

test('passwordArgs: accepts a bare id as well as a repo object', () => {
    assert.deepEqual(S.passwordArgs('home'), S.passwordArgs({ id: 'home' }));
});

test('passwordArgs: never puts the password on the command line', () => {
    const args = S.passwordArgs('home');
    assert.equal(args.length, 2);
    assert.equal(args.some((a) => /--password[= ]/.test(a) && a !== '--password-file'), false);
});

test('passwordArgs: returns a fresh array each call', () => {
    const a = S.passwordArgs('home');
    const b = S.passwordArgs('home');
    assert.deepEqual(a, b);
    assert.notEqual(a, b);
});

test('passwordArgs: propagates the path guard', () => {
    assertGuard(() => S.passwordArgs({ id: '../../etc/shadow' }));
    assertGuard(() => S.passwordArgs({}));
    assertGuard(() => S.passwordArgs(null));
});

// ------------------------------------------------------- systemd credentials ---

test('credentialName: prefixes the id', () => {
    assert.equal(S.credentialName({ id: 'home' }), 'hangar-repo-home');
});

test('credentialLines: emits a single LoadCredential= line', () => {
    assert.deepEqual(S.credentialLines({ id: 'home' }),
        ['LoadCredential=hangar-repo-home:/etc/hangar/repos/home.key']);
});

test('credentialLines: line is single-line and injection-free', () => {
    const line = S.credentialLines('nas-2')[0];
    assert.equal(/[\r\n]/.test(line), false);
    assert.equal(line, 'LoadCredential=hangar-repo-nas-2:/etc/hangar/repos/nas-2.key');
});

test('credentialLines: propagates the path guard', () => {
    assertGuard(() => S.credentialLines({ id: 'home\nExecStart=/bin/sh' }));
});

test('credentialEnv: points restic at %d, not at /etc', () => {
    assert.deepEqual(S.credentialEnv({ id: 'home' }),
        { RESTIC_PASSWORD_FILE: '%d/hangar-repo-home' });
});

test('credentialEnv: value carries no /etc path', () => {
    const v = S.credentialEnv('home').RESTIC_PASSWORD_FILE;
    assert.equal(v.indexOf(S.REPO_DIR), -1);
});

test('credentialEnvLines: renders unit Environment= lines', () => {
    assert.deepEqual(S.credentialEnvLines('home'),
        ['Environment=RESTIC_PASSWORD_FILE=%d/hangar-repo-home']);
});

test('credentialEnv: propagates the path guard', () => {
    assertGuard(() => S.credentialEnv({ id: 'a/b' }));
    assertGuard(() => S.credentialEnvLines({ id: '..' }));
});

// ----------------------------------------------------------------- redact ---

test('redact: masks RESTIC_PASSWORD', () => {
    assert.equal(S.redact('RESTIC_PASSWORD=hunter2'), 'RESTIC_PASSWORD=***');
});

test('redact: keeps RESTIC_PASSWORD_FILE, which is a location not a secret', () => {
    const line = 'RESTIC_PASSWORD_FILE=/etc/hangar/repos/home.key';
    assert.equal(S.redact(line), line);
});

test('redact: masks an inner assignment carried by systemd Environment=', () => {
    assert.equal(S.redact('Environment=RESTIC_PASSWORD=hunter2'),
        'Environment=RESTIC_PASSWORD=***');
});

test('redact: leaves Environment= pointing at the credentials directory alone', () => {
    const line = 'Environment=RESTIC_PASSWORD_FILE=%d/hangar-repo-home';
    assert.equal(S.redact(line), line);
});

test('redact: masks sftp URL userinfo passwords', () => {
    assert.equal(S.redact('sftp://backup:hunter2@nas.local/srv/restic'),
        'sftp://backup:***@nas.local/srv/restic');
});

test('redact: masks userinfo inside a rest: repository URL', () => {
    assert.equal(S.redact('rest:https://u:s3cr3t@backup.example:8000/repo'),
        'rest:https://u:***@backup.example:8000/repo');
});

test('redact: leaves a port-bearing URL with no userinfo untouched', () => {
    const u = 'rest:https://backup.example:8000/repo';
    assert.equal(S.redact(u), u);
});

test('redact: leaves user@host without a password untouched', () => {
    const u = 'sftp://backup@nas.local/srv';
    assert.equal(S.redact(u), u);
});

test('redact: masks JSON-shaped password fields and keeps the quotes', () => {
    assert.equal(S.redact('{"user":"bob","password":"hunter2"}'),
        '{"user":"bob","password":"***"}');
});

test('redact: masks backend credentials by name', () => {
    assert.equal(S.redact('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG'),
        'AWS_SECRET_ACCESS_KEY=***');
    assert.equal(S.redact('B2_ACCOUNT_KEY=0026abcd'), 'B2_ACCOUNT_KEY=***');
    assert.equal(S.redact('AZURE_ACCOUNT_KEY=abc=='), 'AZURE_ACCOUNT_KEY=***');
    assert.equal(S.redact('api_token: abc123'), 'api_token: ***');
});

test('redact: masks SetCredential=, which carries the value inline', () => {
    assert.equal(S.redact('SetCredential=hangar-repo-home:hunter2'),
        'SetCredential=hangar-repo-home:***');
});

test('redact: leaves LoadCredential= intact — its value is a file path', () => {
    const line = S.credentialLines('home')[0];
    assert.equal(S.redact(line), line);
});

test('redact: leaves ordinary log text alone', () => {
    const text = 'repository 3a1b2c opened (version 2)\nno parent snapshot found';
    assert.equal(S.redact(text), text);
});

test('redact: is idempotent', () => {
    const once = S.redact('RESTIC_PASSWORD=hunter2 sftp://u:p@h/x');
    assert.equal(S.redact(once), once);
});

test('redact: masks every secret in a multi-line blob and leaks none', () => {
    const blob = [
        'Environment=RESTIC_REPOSITORY=sftp://backup:hunter2@nas.local/srv',
        'Environment=RESTIC_PASSWORD=hunter2',
        'LoadCredential=hangar-repo-home:/etc/hangar/repos/home.key',
        'AWS_SECRET_ACCESS_KEY=hunter2',
        '{"password": "hunter2"}'
    ].join('\n');
    const out = S.redact(blob);
    assert.equal(out.indexOf('hunter2'), -1, 'password survived redaction: ' + out);
    assert.ok(out.indexOf('/etc/hangar/repos/home.key') >= 0, 'lost the diagnosable path');
});

test('redact: handles null, undefined and non-string input', () => {
    assert.equal(S.redact(null), '');
    assert.equal(S.redact(undefined), '');
    assert.equal(S.redact(''), '');
    assert.equal(S.redact(42), '42');
});

test('redact: over-masks rather than under-masks an unknown credential name', () => {
    assert.equal(S.redact('GOOGLE_APPLICATION_CREDENTIALS=/root/gcs.json'),
        'GOOGLE_APPLICATION_CREDENTIALS=***');
});

test('redact: does not mask a word that merely contains "key"', () => {
    assert.equal(S.redact('monkey=1'), 'monkey=1');
    assert.equal(S.redact('keypath=/etc/hangar'), 'keypath=/etc/hangar');
});

// --------------------------------------------------------------- purity -----

test('pure functions never touch the cockpit global', () => {
    const tripwire = new Proxy({}, {
        get() { throw new Error('a pure function touched cockpit'); }
    });
    globalThis.cockpit = tripwire;
    try {
        S.keyPath('home');
        S.passwordArgs('home');
        S.credentialName('home');
        S.credentialLines('home');
        S.credentialEnv('home');
        S.credentialEnvLines('home');
        S.redact('RESTIC_PASSWORD=hunter2');
        S.validateRepoId('home');
    } finally {
        dropCockpit();
    }
});

test('module shape: no ES module syntax, cockpit access is guarded', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    assert.equal(/^\s*(import|export)\s/m.test(src), false, 'ES module syntax present');
    assert.ok(src.indexOf("typeof cockpit !== 'undefined'") >= 0, 'unguarded cockpit access');
    assert.ok(src.indexOf('module.exports') > 0);
    assert.equal(typeof globalThis.HangarSecrets, 'object');
});

// ------------------------------------------------------------------- I/O ----

test('readKey: rejects with a typed error when cockpit is absent', async (t) => {
    dropCockpit();
    await assert.rejects(S.readKey('home'), (e) => {
        assert.equal(e.kind, Errors.KIND.GENERIC);
        assert.equal(e.detail.op, 'readKey');
        return true;
    });
});

test('readKey: validates the id before any I/O', async (t) => {
    const calls = fakeCockpit();
    t.after(dropCockpit);
    await assert.rejects(S.readKey('../../etc/shadow'));
    assert.equal(calls.file.length, 0);
});

test('readKey: reads the key file as root and strips one trailing newline', async (t) => {
    const calls = fakeCockpit({ content: 'hunter2\n' });
    t.after(dropCockpit);
    assert.equal(await S.readKey('home'), 'hunter2');
    assert.equal(calls.file[0].path, '/etc/hangar/repos/home.key');
    assert.equal(calls.file[0].opts.superuser, 'require');
    assert.equal(calls.closes, 1);
});

test('readKey: preserves a password that legitimately contains spaces', async (t) => {
    fakeCockpit({ content: '  two words  ' });
    t.after(dropCockpit);
    assert.equal(await S.readKey('home'), '  two words  ');
});

test('readKey: a missing key file is WRONG_PASSWORD, so the UI re-prompts', async (t) => {
    fakeCockpit({ content: null });
    t.after(dropCockpit);
    await assert.rejects(S.readKey('home'), (e) => {
        assert.equal(e.kind, Errors.KIND.WRONG_PASSWORD);
        assert.equal(e.remediation, 'reprompt');
        return true;
    });
});

test('readKey: closes the file handle even when the read fails', async (t) => {
    const calls = fakeCockpit({ readFails: Object.assign(new Error('access denied'), { problem: 'access-denied' }) });
    t.after(dropCockpit);
    await assert.rejects(S.readKey('home'), (e) => {
        assert.equal(e.kind, Errors.KIND.GENERIC);
        assert.equal(e.detail.problem, 'access-denied');
        return true;
    });
    assert.equal(calls.closes, 1);
});

test('writeKey: rejects an empty password', async (t) => {
    const calls = fakeCockpit();
    t.after(dropCockpit);
    await assert.rejects(S.writeKey('home', ''), (e) => {
        assert.equal(e.kind, Errors.KIND.GENERIC);
        return true;
    });
    assert.equal(calls.spawn.length, 0);
    assert.equal(calls.file.length, 0);
});

test('writeKey: rejects a non-string password', async (t) => {
    fakeCockpit();
    t.after(dropCockpit);
    await assert.rejects(S.writeKey('home', null));
    await assert.rejects(S.writeKey('home', undefined));
    await assert.rejects(S.writeKey('home', 12345));
    await assert.rejects(S.writeKey('home', { password: 'x' }));
});

test('writeKey: validates the id before touching the password', async (t) => {
    const calls = fakeCockpit();
    t.after(dropCockpit);
    await assert.rejects(S.writeKey('../../root/.ssh/id_rsa', 'hunter2'));
    assert.equal(calls.spawn.length, 0);
    assert.equal(calls.replace.length, 0);
});

test('writeKey: creates a 0700 root:root directory, writes, then locks the file down', async (t) => {
    const calls = fakeCockpit();
    t.after(dropCockpit);
    const p = await S.writeKey('home', 'hunter2');

    assert.equal(p, '/etc/hangar/repos/home.key');
    assert.deepEqual(calls.spawn[0].argv,
        ['install', '-d', '-m', '0700', '-o', 'root', '-g', 'root', '/etc/hangar/repos']);
    assert.deepEqual(calls.spawn[1].argv, ['chmod', '0600', '/etc/hangar/repos/home.key']);
    assert.deepEqual(calls.spawn[2].argv, ['chown', 'root:root', '/etc/hangar/repos/home.key']);
    calls.spawn.forEach((c) => assert.equal(c.opts.superuser, 'require'));
    assert.equal(calls.file[0].opts.superuser, 'require');
});

test('writeKey: stores the password verbatim with no trailing newline', async (t) => {
    const calls = fakeCockpit();
    t.after(dropCockpit);
    await S.writeKey('home', 'hunter2');
    assert.deepEqual(calls.replace, ['hunter2']);
    assert.equal(calls.closes, 1);
});

test('writeKey: resolves with the path, never with the password', async (t) => {
    fakeCockpit();
    t.after(dropCockpit);
    const out = await S.writeKey('home', 'hunter2');
    assert.equal(String(out).indexOf('hunter2'), -1);
});

test('writeKey: a failed spawn surfaces as a typed error without the password', async (t) => {
    fakeCockpit({ spawnFails: new Error('install: cannot create directory') });
    t.after(dropCockpit);
    await assert.rejects(S.writeKey('home', 'hunter2'), (e) => {
        assert.equal(e.kind, Errors.KIND.GENERIC);
        assert.equal(JSON.stringify(e.detail).indexOf('hunter2'), -1);
        assert.equal(e.message.indexOf('hunter2'), -1);
        return true;
    });
});

test('writeKey: rejects with a typed error when cockpit is absent', async () => {
    dropCockpit();
    await assert.rejects(S.writeKey('home', 'hunter2'), (e) => {
        assert.equal(e.detail.op, 'writeKey');
        return true;
    });
});

test('removeKey: unlinks via replace(null) and closes the handle', async (t) => {
    const calls = fakeCockpit();
    t.after(dropCockpit);
    assert.equal(await S.removeKey('home'), '/etc/hangar/repos/home.key');
    assert.deepEqual(calls.replace, [null]);
    assert.equal(calls.file[0].opts.superuser, 'require');
    assert.equal(calls.closes, 1);
});

test('removeKey: validates the id before any I/O', async (t) => {
    const calls = fakeCockpit();
    t.after(dropCockpit);
    await assert.rejects(S.removeKey('..'));
    assert.equal(calls.file.length, 0);
});

test('removeKey: rejects with a typed error when cockpit is absent', async () => {
    dropCockpit();
    await assert.rejects(S.removeKey('home'), (e) => {
        assert.equal(e.detail.op, 'removeKey');
        return true;
    });
});

// ============================================================== hardening ====
// An adversarial second pass over the same surface: the branches the first pass
// did not reach, and the shapes a caller should never send but eventually will.

// Nothing in here is a valid repository id, for any accessor, in any position.
const HOSTILE_ANY = [
    null, undefined, '', ' ', '.', '..', '../x', '/x', 'a/b', 'a\\b', 'A', 'a_b',
    'a b', 'a\nb', 'a\tb', 'a\u0000b', '-x', 'a:b', '$(id)', '`id`', '*', 'répo',
    '\u{1f4be}', 'x'.repeat(1000), 0, 1, NaN, true, false, [], ['home'], {},
    { id: null }, { id: 42 }, { id: '' }, { id: 'a/b' }, () => 1, Symbol('s'), 10n,
    new Date(), /re/
];

// Symbols refuse implicit conversion, so labels have to be built defensively —
// a test helper that throws on the hostile input proves nothing.
function label(v) {
    try {
        return typeof v + ' ' + JSON.stringify(v) + '/' + String(v);
    } catch (e) {
        return typeof v;
    }
}

function expectTyped(fn, what) {
    let caught;
    let threw = false;
    try {
        fn();
    } catch (e) {
        threw = true;
        caught = e;
    }
    assert.ok(threw, 'no throw for ' + what);
    assert.ok(Errors.isHangarError(caught),
        'untyped ' + (caught && caught.name) + ' for ' + what + ': ' + (caught && caught.message));
    assert.equal(caught.kind, Errors.KIND.GENERIC, 'wrong kind for ' + what);
    assert.ok(caught.detail && typeof caught.detail === 'object', 'no detail for ' + what);
}

async function expectTypedRejection(makePromise, what) {
    let p;
    // The async surface must never throw synchronously: callers attach .catch()
    // and would otherwise take an unhandled exception on the happy path.
    assert.doesNotThrow(() => { p = makePromise(); }, 'sync throw for ' + what);
    assert.ok(p && typeof p.then === 'function', 'not a promise for ' + what);
    let caught;
    let rejected = false;
    await p.then(() => {}, (e) => { rejected = true; caught = e; });
    assert.ok(rejected, 'no rejection for ' + what);
    assert.ok(Errors.isHangarError(caught),
        'untyped rejection ' + (caught && caught.name) + ' for ' + what);
}

// ------------------------------------------------ validateRepoId branches ----

test('validateRepoId: over-length detail carries the length and the limit', () => {
    try {
        S.validateRepoId('a'.repeat(S.MAX_ID_LEN + 6));
        assert.fail('expected a throw');
    } catch (e) {
        assert.equal(e.detail.length, S.MAX_ID_LEN + 6);
        assert.equal(e.detail.max, S.MAX_ID_LEN);
    }
});

test('validateRepoId: length is checked before the charset', () => {
    // Otherwise a 1 MB id gets handed to a regex before anyone asks how big it is.
    try {
        S.validateRepoId('a'.repeat(S.MAX_ID_LEN + 1) + '!');
        assert.fail('expected a throw');
    } catch (e) {
        assert.match(e.message, /too long/);
    }
});

test('validateRepoId: a pathologically long id is rejected promptly', () => {
    const started = Date.now();
    assertGuard(() => S.validateRepoId('a'.repeat(1000000)));
    assert.ok(Date.now() - started < 1000, 'length guard is not short-circuiting');
});

test('validateRepoId: NUL is diagnosed before the path separator', () => {
    try {
        S.validateRepoId('a\u0000/b');
        assert.fail('expected a throw');
    } catch (e) {
        assert.match(e.message, /NUL/);
    }
});

test('validateRepoId: a path separator is named as such', () => {
    try {
        S.validateRepoId('a/b');
        assert.fail('expected a throw');
    } catch (e) {
        assert.match(e.message, /path separator/);
    }
});

test('validateRepoId: ".." is diagnosed distinctly from a separator', () => {
    try {
        S.validateRepoId('a..b');
        assert.fail('expected a throw');
    } catch (e) {
        assert.match(e.message, /\.\./);
        assert.equal(e.detail.repoId, 'a..b');
    }
});

test('validateRepoId: reports the type for every non-string primitive', () => {
    [[function () {}, 'function'], [Symbol('x'), 'symbol'], [10n, 'bigint'],
        [NaN, 'number'], [true, 'boolean'], [[], 'object']].forEach(([v, expected]) => {
        try {
            S.validateRepoId(v);
            assert.fail('expected a throw for ' + expected);
        } catch (e) {
            assert.equal(e.detail.type, expected);
        }
    });
});

test('validateRepoId: a boxed String is rejected — typeof, not duck typing', () => {
    // eslint-disable-next-line no-new-wrappers
    assertGuard(() => S.validateRepoId(new String('home')));
});

test('validateRepoId: accepts a single-character id', () => {
    assert.equal(S.validateRepoId('a'), 'a');
    assert.equal(S.validateRepoId('9'), '9');
});

test('validateRepoId: accepts a trailing dash, rejects a leading one', () => {
    assert.equal(S.validateRepoId('home-'), 'home-');
    assertGuard(() => S.validateRepoId('-home'));
    assertGuard(() => S.validateRepoId('-'.repeat(S.MAX_ID_LEN)));
});

test('validateRepoId: accepts a dash-dense id at the length limit', () => {
    const id = 'a-'.repeat(S.MAX_ID_LEN / 2);
    assert.equal(id.length, S.MAX_ID_LEN);
    assert.equal(S.validateRepoId(id), id);
});

test('validateRepoId: rejects consecutive dashes only when they hide a ".."', () => {
    assert.equal(S.validateRepoId('a--b'), 'a--b');
    assertGuard(() => S.validateRepoId('a..b'));
});

// --------------------------------------------------- repo-object acceptance --

test('keyPath: takes an id, not a repo object', () => {
    // Only the accessors unwrap {id}. Widening keyPath would make every caller
    // guess which one it is holding.
    assertGuard(() => S.keyPath({ id: 'home' }));
});

test('accessors: unwrap a repo object and ignore its other fields', () => {
    const repo = { id: 'home', url: 'sftp://u:p@h/x', password: 'hunter2' };
    assert.deepEqual(S.passwordArgs(repo), ['--password-file', '/etc/hangar/repos/home.key']);
    assert.equal(S.credentialName(repo), 'hangar-repo-home');
    assert.deepEqual(S.credentialLines(repo), S.credentialLines('home'));
    assert.deepEqual(S.credentialEnv(repo), S.credentialEnv('home'));
});

test('accessors: an inherited id is still an id', () => {
    // Documented, not accidental: repoIdOf reads a property, and the value it
    // reads is validated either way.
    assert.equal(S.credentialName(Object.create({ id: 'home' })), 'hangar-repo-home');
});

test('accessors: a null-prototype object with no id fails typed, not untyped', () => {
    expectTyped(() => S.credentialName(Object.create(null)), 'null-prototype object');
});

test('accessors: a nested repo object is not unwrapped twice', () => {
    expectTyped(() => S.passwordArgs({ id: { id: 'home' } }), 'nested repo');
});

[['passwordArgs', (v) => S.passwordArgs(v)],
    ['credentialName', (v) => S.credentialName(v)],
    ['credentialLines', (v) => S.credentialLines(v)],
    ['credentialEnv', (v) => S.credentialEnv(v)],
    ['credentialEnvLines', (v) => S.credentialEnvLines(v)],
    ['keyPath', (v) => S.keyPath(v)],
    ['validateRepoId', (v) => S.validateRepoId(v)]].forEach(([name, fn]) => {
    test(name + ': throws a typed error for every hostile input, never an untyped one', () => {
        HOSTILE_ANY.forEach((v) => expectTyped(() => fn(v), name + '(' + label(v) + ')'));
    });
});

// ------------------------------------------------------- output invariants ---

test('keyPath: output stays inside the repo directory for every accepted id', () => {
    ['a', '9', 'home-', 'a--b', 'nas-2-offsite', 'a'.repeat(S.MAX_ID_LEN)].forEach((id) => {
        const p = S.keyPath(id);
        assert.equal(p, path.normalize(p));
        assert.equal(p.indexOf(S.REPO_DIR + '/'), 0);
        assert.equal(p.indexOf('..'), -1);
        assert.equal(p.indexOf('//'), -1);
        assert.equal(path.extname(p), S.KEY_SUFFIX);
    });
});

test('credentialName: distinct ids give distinct credential names', () => {
    const ids = ['home', 'home-1', 'homea', 'a-home'];
    const names = ids.map((id) => S.credentialName(id));
    assert.equal(new Set(names).size, ids.length);
    names.forEach((n) => assert.equal(/[\s/:\r\n]/.test(n), false, 'unsafe credential name ' + n));
});

test('credentialLines and credentialEnv agree on the credential name', () => {
    const name = S.credentialName('nas-2');
    assert.ok(S.credentialLines('nas-2')[0].indexOf('LoadCredential=' + name + ':') === 0);
    assert.equal(S.credentialEnv('nas-2').RESTIC_PASSWORD_FILE, S.CRED_DIR + '/' + name);
});

test('credentialLines: points at the same file keyPath builds', () => {
    assert.equal(S.credentialLines('home')[0].split(':')[1], S.keyPath('home'));
});

test('credentialEnv: returns a fresh object each call', () => {
    const a = S.credentialEnv('home');
    const b = S.credentialEnv('home');
    assert.deepEqual(a, b);
    assert.notEqual(a, b);
    a.RESTIC_PASSWORD_FILE = 'tampered';
    assert.equal(S.credentialEnv('home').RESTIC_PASSWORD_FILE, '%d/hangar-repo-home');
});

test('credentialLines and credentialEnvLines return fresh single-line arrays', () => {
    [S.credentialLines('home'), S.credentialEnvLines('home')].forEach((lines) => {
        assert.equal(lines.length, 1);
        assert.equal(/[\r\n]/.test(lines[0]), false);
    });
    assert.notEqual(S.credentialLines('home'), S.credentialLines('home'));
    assert.notEqual(S.credentialEnvLines('home'), S.credentialEnvLines('home'));
});

// ------------------------------------------------------------ redact more ----

test('redact: masks a single-quoted value and keeps the quote style', () => {
    assert.equal(S.redact("password='hunter2'"), "password='***'");
});

test('redact: masks a value whose closing quote never arrived', () => {
    // A truncated log tail used to fail every quoted alternative and fall
    // through unmasked, which is the one outcome this module exists to prevent.
    assert.equal(S.redact('RESTIC_PASSWORD="hunter2'), 'RESTIC_PASSWORD="***"');
    assert.equal(S.redact("RESTIC_PASSWORD='hunter2"), "RESTIC_PASSWORD='***'");
});

test('redact: an escaped quote inside the value does not end the mask early', () => {
    assert.equal(S.redact('{"password":"hun\\"ter2"}'), '{"password":"***"}');
});

test('redact: an unterminated quote does not swallow the following lines', () => {
    const out = S.redact('password="hunter2\nrepository 3a1b2c opened');
    assert.equal(out.indexOf('hunter2'), -1);
    assert.ok(out.indexOf('repository 3a1b2c opened') >= 0, 'lost a diagnosable line');
});

test('redact: tolerates whitespace around the separator', () => {
    assert.equal(S.redact('password = hunter2'), 'password = ***');
    assert.equal(S.redact('password  :  hunter2'), 'password  :  ***');
});

test('redact: masks the CLI flag form', () => {
    assert.equal(S.redact('--password=hunter2'), '--password=***');
});

test('redact: masks a bare key= assignment', () => {
    assert.equal(S.redact('key=abc123'), 'key=***');
    assert.equal(S.redact('api_key=abc123'), 'api_key=***');
    assert.equal(S.redact('api-key: abc123'), 'api-key: ***');
});

test('redact: over-masks AWS_ACCESS_KEY_ID rather than reasoning about it', () => {
    assert.equal(S.redact('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7'), 'AWS_ACCESS_KEY_ID=***');
});

test('redact: a word merely containing "key" is left alone in either case', () => {
    ['monkey=1', 'monkeys=1', 'MONKEY=1', 'donkeys: 2'].forEach((s) => assert.equal(S.redact(s), s));
});

test('redact: location-suffixed names survive, whatever the secret word', () => {
    ['keyfile=/etc/hangar/repos/home.key', 'key_path=/etc/hangar', 'TOKEN_URL=https://h/t',
        'secret_dir=/run/secrets', 'password_file=/etc/hangar/repos/home.key',
        'CREDENTIALS_DIRECTORY=/run/credentials/hangar.service'
    ].forEach((s) => assert.equal(S.redact(s), s, 'over-masked ' + s));
});

test('redact: masks passphrase, secret and token names', () => {
    assert.equal(S.redact('passphrase=hunter2'), 'passphrase=***');
    assert.equal(S.redact('client_secret=hunter2'), 'client_secret=***');
    assert.equal(S.redact('token=hunter2'), 'token=***');
    assert.equal(S.redact('credential=hunter2'), 'credential=***');
});

test('redact: SetCredential= is case-insensitive and survives an empty value', () => {
    assert.equal(S.redact('setcredential=hangar-repo-home:hunter2'),
        'setcredential=hangar-repo-home:***');
    assert.equal(S.redact('SetCredential=hangar-repo-home:'), 'SetCredential=hangar-repo-home:***');
});

test('redact: LoadCredential= is left alone whatever its case', () => {
    const line = 'LOADCREDENTIAL=hangar-repo-home:/etc/hangar/repos/home.key';
    assert.equal(S.redact(line), line);
});

test('redact: masks inside a systemd-quoted Environment= line', () => {
    assert.equal(S.redact('Environment="RESTIC_PASSWORD=hunter2"'),
        'Environment="RESTIC_PASSWORD=***"');
});

test('redact: preserves the indentation of an Environment= line', () => {
    assert.equal(S.redact('    Environment=RESTIC_PASSWORD=hunter2'),
        '    Environment=RESTIC_PASSWORD=***');
});

test('redact: handles several Environment= lines independently', () => {
    const out = S.redact([
        'Environment=RESTIC_PASSWORD=hunter2',
        'Environment=RESTIC_REPOSITORY=/srv/restic',
        'Environment=RESTIC_PASSWORD_FILE=%d/hangar-repo-home'
    ].join('\n'));
    assert.equal(out.indexOf('hunter2'), -1);
    assert.ok(out.indexOf('/srv/restic') >= 0);
    assert.ok(out.indexOf('%d/hangar-repo-home') >= 0);
});

test('redact: an Environment= line with no inner assignment is untouched', () => {
    assert.equal(S.redact('Environment=FOO'), 'Environment=FOO');
});

test('redact: keeps CRLF line endings and the following line', () => {
    assert.equal(S.redact('PASSWORD=hunter2\r\nnext=1'), 'PASSWORD=***\r\nnext=1');
});

test('redact: masks every URL on a line, not just the first', () => {
    assert.equal(S.redact('sftp://u:p1@h/x rest:https://u:p2@h:8000/y'),
        'sftp://u:***@h/x rest:https://u:***@h:8000/y');
});

test('redact: masks an empty URL password rather than reporting it', () => {
    assert.equal(S.redact('sftp://backup:@nas.local/srv'), 'sftp://backup:***@nas.local/srv');
});

test('redact: an @ in a query string is not userinfo', () => {
    const u = 'rest:https://backup.example:8000/repo?owner=a@b';
    assert.equal(S.redact(u), u);
});

test('redact: masks a unicode secret value whole', () => {
    const out = S.redact('RESTIC_PASSWORD=hünteré\u{1f4be}');
    assert.equal(out, 'RESTIC_PASSWORD=***');
});

test('redact: masks the secret and keeps its innocent neighbour', () => {
    assert.equal(S.redact('password=hunter2\nfiles_new=12'), 'password=***\nfiles_new=12');
});

test('redact: coerces every non-string input without throwing', () => {
    assert.equal(S.redact(true), 'true');
    assert.equal(S.redact(0), '0');
    assert.equal(S.redact(NaN), 'NaN');
    assert.equal(S.redact([1, 2]), '1,2');
    assert.equal(S.redact({}), '[object Object]');
    assert.equal(S.redact(10n), '10');
    assert.ok(S.redact(Symbol('s')).indexOf('Symbol') >= 0);
    HOSTILE_ANY.forEach((v) => assert.equal(typeof S.redact(v), 'string', 'not a string for ' + label(v)));
});

test('redact: a value with no primitive conversion does not throw', () => {
    // Object.create(null) has no toString; the redactor runs on the failure
    // path and must not turn a reportable failure into a TypeError.
    assert.equal(typeof S.redact(Object.create(null)), 'string');
    assert.equal(typeof S.redact({ toString() { throw new Error('hostile'); } }), 'string');
});

test('redact: is stateless across calls', () => {
    // A /g regex shared between calls leaks lastIndex if anyone ever swaps
    // replace() for exec().
    const input = 'RESTIC_PASSWORD=hunter2 sftp://u:p@h/x SetCredential=n:v';
    const first = S.redact(input);
    assert.equal(S.redact(input), first);
    assert.equal(S.redact(input), first);
});

test('redact: no shape of a secret assignment leaks the value', () => {
    const names = ['password', 'PASSWORD', 'RESTIC_PASSWORD', 'passphrase', 'api_key',
        'AWS_SECRET_ACCESS_KEY', 'client_secret', 'token'];
    const values = ['hunter2', '"hunter2"', "'hunter2'", '"hunter2', "'hunter2",
        '"hun\\"ter2"', '"hunter2 with spaces"'];
    const seps = ['=', ':', ' = ', ': '];
    const wraps = [['', ''], ['{', '}'], ['{"', '"}'], ['--', ''], ['Environment=', ''],
        ['  Environment=', ''], ['log line: ', '\nnext line']];
    names.forEach((n) => seps.forEach((s) => values.forEach((v) => wraps.forEach(([a, b]) => {
        const input = a + n + s + v + b;
        const out = S.redact(input);
        assert.equal(out.indexOf('hunter2'), -1, 'leak: ' + JSON.stringify(input) + ' -> ' + out);
    }))));
});

test('redact: this module\'s own generated artefacts survive unchanged', () => {
    [S.keyPath('home'), S.credentialLines('home')[0], S.credentialEnvLines('home')[0],
        S.passwordArgs('home').join(' '), S.REPO_DIR
    ].forEach((s) => assert.equal(S.redact(s), s, 'redaction damaged ' + s));
});

test('redact: a long unbroken token does not stall the UI thread', () => {
    // Regression guard: an unbounded greedy name made this quadratic, and one
    // 50 kB blob took 15 seconds.
    const text = 'x'.repeat(200000) + ' A9b.c-d_'.repeat(20000) + ' RESTIC_PASSWORD=hunter2';
    const started = Date.now();
    const out = S.redact(text);
    const ms = Date.now() - started;
    assert.equal(out.indexOf('hunter2'), -1);
    assert.ok(ms < 5000, 'redact took ' + ms + 'ms on a long token');
});

test('redact: masks an assignment nested inside another one', () => {
    // A journal line is `unit[pid]: <message>`, so almost every secret hangar
    // could log arrives as the value of something else.
    assert.equal(S.redact('stderr: password=hunter2'), 'stderr: password=***');
    assert.equal(S.redact('stderr: password="hunter2"'), 'stderr: password="***"');
    assert.equal(S.redact('log line: password = hunter2'), 'log line: password = ***');
    assert.equal(S.redact('msg: env: RESTIC_PASSWORD=hunter2'), 'msg: env: RESTIC_PASSWORD=***');
    assert.equal(S.redact('a=b=password=hunter2'), 'a=b=password=***');
});

test('redact: masks a secret nested inside a JSON object', () => {
    assert.equal(S.redact('{"user":"bob","nested":{"password":"hunter2"}}'),
        '{"user":"bob","nested":{"password":"***"}}');
});

test('redact: masks one logfmt field and leaves the others byte for byte', () => {
    assert.equal(S.redact('level=error msg="repository open failed" password=hunter2 repo=sftp://u:p@h/x'),
        'level=error msg="repository open failed" password=*** repo=sftp://u:***@h/x');
});

test('redact: a journald line keeps everything but the secret', () => {
    assert.equal(S.redact('Jun 01 12:00:01 host hangar[1]: backing up /srv with token=abc123'),
        'Jun 01 12:00:01 host hangar[1]: backing up /srv with token=***');
});

test('redact: a generated unit file loses its secrets and nothing else', () => {
    const unit = [
        '[Service]',
        'Type=oneshot',
        'ExecStart=/usr/bin/restic backup --password-file /etc/hangar/repos/home.key /srv',
        'LoadCredential=hangar-repo-home:/etc/hangar/repos/home.key',
        'Environment=RESTIC_PASSWORD_FILE=%d/hangar-repo-home',
        'Environment=RESTIC_REPOSITORY=sftp://backup:hunter2@nas.local/srv',
        'Environment=AWS_SECRET_ACCESS_KEY=hunter2',
        'SetCredential=hangar-repo-home:hunter2'
    ].join('\n');
    assert.equal(S.redact(unit), [
        '[Service]',
        'Type=oneshot',
        'ExecStart=/usr/bin/restic backup --password-file /etc/hangar/repos/home.key /srv',
        'LoadCredential=hangar-repo-home:/etc/hangar/repos/home.key',
        'Environment=RESTIC_PASSWORD_FILE=%d/hangar-repo-home',
        'Environment=RESTIC_REPOSITORY=sftp://backup:***@nas.local/srv',
        'Environment=AWS_SECRET_ACCESS_KEY=***',
        'SetCredential=hangar-repo-home:***'
    ].join('\n'));
});

test('redact: descending into a value changes nothing when nothing below is secret', () => {
    ['a=b=c=d', 'level=info msg="no parent snapshot found"', 'rest:https://backup.example:8000/repo',
        'files_new=12 data_added=1024 snapshot_id=3a1b2c', '{"user":"bob","host":"nas.local"}'
    ].forEach((s) => assert.equal(S.redact(s), s, 'descent damaged ' + s));
});

test('redact: a chain of assignments does not stall the scan', () => {
    // The nested descent re-reads the value it descends into; unbudgeted, this
    // input makes that quadratic.
    const started = Date.now();
    const out = S.redact('a=b='.repeat(50000) + ' password=hunter2');
    const ms = Date.now() - started;
    assert.equal(out.indexOf('hunter2'), -1);
    assert.ok(ms < 5000, 'redact took ' + ms + 'ms on a chained assignment');
});

test('redact: is idempotent for quoted and truncated forms too', () => {
    ['password="hunter2', "password='hunter2", '{"password":"hun\\"ter2"}',
        'Environment="RESTIC_PASSWORD=hunter2"', 'SetCredential=n:v'
    ].forEach((s) => {
        const once = S.redact(s);
        assert.equal(S.redact(once), once, 'not idempotent: ' + s);
    });
});

// ------------------------------------------------------------------ I/O ------

test('readKey: never throws synchronously, whatever the id', async () => {
    fakeCockpit();
    try {
        for (const v of HOSTILE_ANY) await expectTypedRejection(() => S.readKey(v), 'readKey(' + label(v) + ')');
    } finally {
        dropCockpit();
    }
});

test('writeKey: never throws synchronously, whatever the id', async () => {
    fakeCockpit();
    try {
        for (const v of HOSTILE_ANY) await expectTypedRejection(() => S.writeKey(v, 'hunter2'), 'writeKey(' + label(v) + ')');
    } finally {
        dropCockpit();
    }
});

test('removeKey: never throws synchronously, whatever the id', async () => {
    fakeCockpit();
    try {
        for (const v of HOSTILE_ANY) await expectTypedRejection(() => S.removeKey(v), 'removeKey(' + label(v) + ')');
    } finally {
        dropCockpit();
    }
});

test('I/O: a hostile id never reaches cockpit', async (t) => {
    const calls = fakeCockpit();
    t.after(dropCockpit);
    for (const v of HOSTILE_ANY) {
        await S.readKey(v).catch(() => {});
        await S.writeKey(v, 'hunter2').catch(() => {});
        await S.removeKey(v).catch(() => {});
    }
    assert.equal(calls.file.length, 0);
    assert.equal(calls.spawn.length, 0);
});

test('readKey: accepts a repo object and never spawns', async (t) => {
    const calls = fakeCockpit({ content: 'hunter2' });
    t.after(dropCockpit);
    assert.equal(await S.readKey({ id: 'home' }), 'hunter2');
    assert.equal(calls.spawn.length, 0);
    assert.equal(calls.file.length, 1);
});

test('readKey: strips exactly one trailing newline, not two', async (t) => {
    fakeCockpit({ content: 'hunter2\n\n' });
    t.after(dropCockpit);
    assert.equal(await S.readKey('home'), 'hunter2\n');
});

test('readKey: strips a CRLF terminator', async (t) => {
    fakeCockpit({ content: 'hunter2\r\n' });
    t.after(dropCockpit);
    assert.equal(await S.readKey('home'), 'hunter2');
});

test('readKey: keeps newlines that are not at the end', async (t) => {
    fakeCockpit({ content: 'two\nlines\n' });
    t.after(dropCockpit);
    assert.equal(await S.readKey('home'), 'two\nlines');
});

test('readKey: preserves unicode and very long passwords byte for byte', async (t) => {
    const pw = 'hünteré\u{1f4be}' + 'x'.repeat(4096);
    fakeCockpit({ content: pw });
    t.after(dropCockpit);
    assert.equal(await S.readKey('home'), pw);
});

test('readKey: falsy content is content, not a missing key', async (t) => {
    fakeCockpit({ content: 0 });
    t.after(dropCockpit);
    assert.equal(await S.readKey('home'), '0');
});

test('readKey: an empty key file reads as an empty password', async (t) => {
    // Documented, not endorsed: writeKey refuses to create one, so an empty
    // file means something outside hangar truncated it.
    fakeCockpit({ content: '' });
    t.after(dropCockpit);
    assert.equal(await S.readKey('home'), '');
});

test('readKey: closes the handle on the missing-key path too', async (t) => {
    const calls = fakeCockpit({ content: null });
    t.after(dropCockpit);
    await S.readKey('home').catch(() => {});
    assert.equal(calls.closes, 1);
});

test('readKey: an already-typed failure keeps its kind and remediation', async (t) => {
    const locked = Errors.create(Errors.KIND.REPO_LOCKED, 'repository is locked');
    fakeCockpit({ readFails: locked });
    t.after(dropCockpit);
    await assert.rejects(S.readKey('home'), (e) => {
        assert.equal(e, locked);
        assert.equal(e.kind, Errors.KIND.REPO_LOCKED);
        assert.equal(e.remediation, 'unlock');
        return true;
    });
});

test('readKey: types a rejection that is not an Error at all', async (t) => {
    fakeCockpit({ readRejectsWith: 'access-denied' });
    t.after(dropCockpit);
    await assert.rejects(S.readKey('home'), (e) => {
        assert.equal(e.kind, Errors.KIND.GENERIC);
        assert.equal(e.detail.op, 'readKey');
        assert.equal(e.detail.path, '/etc/hangar/repos/home.key');
        return true;
    });
});

test('readKey: types a rejection with no value', async (t) => {
    fakeCockpit({ readRejectsWith: undefined });
    t.after(dropCockpit);
    await assert.rejects(S.readKey('home'), (e) => {
        assert.equal(e.kind, Errors.KIND.GENERIC);
        assert.equal(e.detail.problem, null);
        return true;
    });
});

test('I/O: a null cockpit global counts as absent', async (t) => {
    globalThis.cockpit = null;
    t.after(dropCockpit);
    await assert.rejects(S.readKey('home'), (e) => {
        assert.equal(e.detail.op, 'readKey');
        return true;
    });
    await assert.rejects(S.removeKey('home'), (e) => e.detail.op === 'removeKey');
});

test('writeKey: does exactly one write and three privileged commands', async (t) => {
    const calls = fakeCockpit();
    t.after(dropCockpit);
    await S.writeKey('home', 'hunter2');
    assert.equal(calls.spawn.length, 3);
    assert.equal(calls.file.length, 1);
    assert.equal(calls.replace.length, 1);
    calls.spawn.forEach((c) => assert.equal(c.opts.err, 'message'));
});

test('writeKey: a chmod failure is reported, not swallowed', async (t) => {
    // The file exists and is still under the bridge umask at this point, so
    // silently resolving would leave a readable key behind.
    const calls = fakeCockpit({ spawnFailsOn: 'chmod' });
    t.after(dropCockpit);
    await assert.rejects(S.writeKey('home', 'hunter2'), (e) => {
        assert.equal(e.kind, Errors.KIND.GENERIC);
        assert.equal(e.detail.op, 'writeKey');
        assert.equal(e.detail.path, '/etc/hangar/repos/home.key');
        return true;
    });
    assert.deepEqual(calls.replace, ['hunter2']);
});

test('writeKey: a chown failure is reported', async (t) => {
    fakeCockpit({ spawnFailsOn: 'chown' });
    t.after(dropCockpit);
    await assert.rejects(S.writeKey('home', 'hunter2'), (e) => e.detail.op === 'writeKey');
});

test('writeKey: chmod runs before chown and after the write', async (t) => {
    const calls = fakeCockpit();
    t.after(dropCockpit);
    await S.writeKey('home', 'hunter2');
    assert.equal(calls.spawn[0].argv[0], 'install');
    assert.equal(calls.spawn[1].argv[0], 'chmod');
    assert.equal(calls.spawn[2].argv[0], 'chown');
});

test('writeKey: a failed write closes the handle and leaks nothing', async (t) => {
    const calls = fakeCockpit({ replaceRejectsWith: new Error('disk full') });
    t.after(dropCockpit);
    await assert.rejects(S.writeKey('home', 'hunter2'), (e) => {
        assert.equal(e.kind, Errors.KIND.GENERIC);
        assert.equal(e.message.indexOf('hunter2'), -1);
        assert.equal(JSON.stringify(e.detail).indexOf('hunter2'), -1);
        return true;
    });
    assert.equal(calls.closes, 1);
    assert.equal(calls.spawn.length, 1);
});

test('writeKey: the id is validated before the password', async (t) => {
    fakeCockpit();
    t.after(dropCockpit);
    await assert.rejects(S.writeKey('../x', ''), (e) => {
        assert.match(e.message, /repository id/);
        return true;
    });
});

test('writeKey: the password is validated before cockpit is needed', async () => {
    dropCockpit();
    await assert.rejects(S.writeKey('home', ''), (e) => {
        assert.match(e.message, /password/);
        return true;
    });
});

test('writeKey: rejects every non-string password shape', async (t) => {
    const calls = fakeCockpit();
    t.after(dropCockpit);
    for (const pw of [null, undefined, 0, 1, NaN, true, false, [], ['x'], {}, Symbol('s'), 10n,
        () => 'x', new String('hunter2')]) {          // eslint-disable-line no-new-wrappers
        await expectTypedRejection(() => S.writeKey('home', pw), 'writeKey password ' + label(pw));
    }
    assert.equal(calls.replace.length, 0);
});

test('writeKey: a single space is a password', async (t) => {
    const calls = fakeCockpit();
    t.after(dropCockpit);
    await S.writeKey('home', ' ');
    assert.deepEqual(calls.replace, [' ']);
});

test('writeKey: stores hostile password bytes verbatim', async (t) => {
    // The file content is the password; restic reads it as-is, so nothing here
    // may be trimmed, escaped or normalised.
    const calls = fakeCockpit();
    t.after(dropCockpit);
    const hostile = ['two words', 'a\nb', 'trailing\n', 'a\u0000b', 'hünteré\u{1f4be}',
        '$(id)', '--password-file', 'x'.repeat(8192)];
    for (const pw of hostile) await S.writeKey('home', pw);
    assert.deepEqual(calls.replace, hostile);
});

test('writeKey: accepts a repo object', async (t) => {
    const calls = fakeCockpit();
    t.after(dropCockpit);
    assert.equal(await S.writeKey({ id: 'home' }, 'hunter2'), '/etc/hangar/repos/home.key');
    assert.equal(calls.file[0].path, '/etc/hangar/repos/home.key');
});

test('removeKey: accepts a repo object and never spawns', async (t) => {
    const calls = fakeCockpit();
    t.after(dropCockpit);
    assert.equal(await S.removeKey({ id: 'home' }), '/etc/hangar/repos/home.key');
    assert.equal(calls.spawn.length, 0);
});

test('removeKey: a failed unlink closes the handle and types the error', async (t) => {
    const calls = fakeCockpit({ replaceRejectsWith: Object.assign(new Error('EPERM'), { problem: 'access-denied' }) });
    t.after(dropCockpit);
    await assert.rejects(S.removeKey('home'), (e) => {
        assert.equal(e.kind, Errors.KIND.GENERIC);
        assert.equal(e.detail.op, 'removeKey');
        assert.equal(e.detail.problem, 'access-denied');
        return true;
    });
    assert.equal(calls.closes, 1);
});

test('removeKey: repeated removal is idempotent', async (t) => {
    const calls = fakeCockpit();
    t.after(dropCockpit);
    assert.equal(await S.removeKey('home'), await S.removeKey('home'));
    assert.deepEqual(calls.replace, [null, null]);
});

// ------------------------------------------------------------- constants -----

test('constants match the documented on-disk layout', () => {
    assert.equal(S.REPO_DIR, '/etc/hangar/repos');
    assert.equal(S.KEY_SUFFIX, '.key');
    assert.equal(S.KEY_MODE, '0600');
    assert.equal(S.KEY_OWNER, 'root:root');
    assert.equal(S.DIR_MODE, '0700');
    assert.equal(S.CRED_DIR, '%d');
    assert.equal(S.CRED_PREFIX, 'hangar-repo-');
    assert.equal(S.MASK, '***');
    assert.equal(S.MAX_ID_LEN, 64);
});

test('ID_RE is not a global regex', () => {
    // A /g regex kept on the module object carries lastIndex between calls, so
    // the same id would validate and then fail.
    assert.equal(S.ID_RE.global, false);
    assert.equal(S.ID_RE.test('home'), S.ID_RE.test('home'));
});

test('the exported surface is complete', () => {
    ['validateRepoId', 'keyPath', 'passwordArgs', 'credentialName', 'credentialLines',
        'credentialEnv', 'credentialEnvLines', 'redact', 'readKey', 'writeKey', 'removeKey'
    ].forEach((k) => assert.equal(typeof S[k], 'function', 'missing export ' + k));
});
