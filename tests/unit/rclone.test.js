// tests/unit/rclone.test.js — HangarRclone: the provider table, remote-name and
// field validation, the argv/secrets split, headless-OAuth paste parsing and the
// rclone.conf merge.
//
// The single most important assertion in this file is that no secret value ever
// appears in the argv `rclone config create` is run with: /proc/<pid>/cmdline is
// world-readable, so an argument is a published secret. Every provider is checked,
// not just the interesting ones.
//
// No fixture files: every rclone paste below is SYNTHETIC, hand-built in the shape
// rclone.org/remote_setup documents, with the token values replaced.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Rclone = require('../../js/core/rclone.js');
const Errors = require('../../js/core/errors.js');

function assertGeneric(fn) {
    assert.throws(fn, (e) => {
        assert.ok(Errors.isHangarError(e), 'expected a HangarError, got ' + e);
        assert.equal(e.kind, Errors.KIND.GENERIC);
        return true;
    });
}

// String() itself throws on a null-prototype object, so an assertion message that
// wants to name the offending value needs its own total coercion.
function label(v) {
    try { return String(v); } catch (e) { return '(unprintable)'; }
}

// A realistic Google token blob. Values are fake, the shape is rclone's.
const TOKEN_JSON = '{"access_token":"ya29.a0AfB_FAKEACCESSTOKEN0123456789","token_type":"Bearer",' +
    '"refresh_token":"1//0fFAKEREFRESHTOKEN9876543210","expiry":"2026-08-01T21:00:00.000000000+03:00"}';

// ---------------------------------------------------------------- providers

test('providers() covers every destination the brief demands', () => {
    const ids = Rclone.providers().map((p) => p.id);
    ['drive', 'dropbox', 'onedrive', 'box', 'pcloud', 'yandex', 'jottacloud',
        'webdav', 'sftp', 'ftp', 'smb', 's3', 'b2', 'swift', 'koofr', 'mega']
        .forEach((id) => assert.ok(ids.includes(id), 'missing provider ' + id));
});

test('providers() returns a fresh array so a caller cannot shrink the table', () => {
    const list = Rclone.providers();
    const n = list.length;
    list.length = 0;
    assert.equal(Rclone.providers().length, n);
});

test('every provider has the declared shape', () => {
    Rclone.providers().forEach((p) => {
        assert.equal(typeof p.id, 'string');
        assert.notEqual(p.id, '');
        assert.equal(typeof p.label, 'string');
        assert.notEqual(p.label, '');
        assert.equal(typeof p.type, 'string');
        assert.notEqual(p.type, '');
        assert.ok([Rclone.AUTH.OAUTH, Rclone.AUTH.CREDENTIALS,
            Rclone.AUTH.EXTERNAL, Rclone.AUTH.NONE].includes(p.auth),
            p.id + ' has auth ' + p.auth);
        assert.ok(Array.isArray(p.fields), p.id + ' has no fields array');
        assert.equal(typeof p.notes, 'string');
        assert.notEqual(p.notes, '', p.id + ' has no notes');
    });
});

test('every field has the declared shape and a legal type', () => {
    Rclone.providers().forEach((p) => {
        p.fields.forEach((f) => {
            assert.ok(['text', 'password', 'select'].includes(f.type), p.id + '.' + f.key + ' type ' + f.type);
            assert.match(f.key, /^[a-z0-9_]+$/, p.id + ' has a non-rclone key ' + f.key);
            assert.equal(typeof f.label, 'string');
            assert.notEqual(f.label, '');
            assert.equal(typeof f.required, 'boolean');
            assert.equal(typeof f.placeholder, 'string');
            assert.equal(typeof f.help, 'string');
            if (f.type === 'select') assert.ok(Array.isArray(f.options) && f.options.length, p.id + '.' + f.key);
        });
    });
});

test('provider ids and field keys are unique', () => {
    const ids = Rclone.providers().map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
    Rclone.providers().forEach((p) => {
        const keys = p.fields.map((f) => f.key);
        assert.equal(new Set(keys).size, keys.length, 'duplicate key in ' + p.id);
    });
});

test('the rclone config keys are the real ones for each backend', () => {
    const expect = {
        webdav: ['url', 'vendor', 'user', 'pass'],
        sftp: ['host', 'user', 'port', 'key_file', 'key_file_pass', 'pass'],
        ftp: ['host', 'user', 'port', 'pass'],
        smb: ['host', 'user', 'domain', 'port', 'pass'],
        s3: ['provider', 'access_key_id', 'secret_access_key', 'region', 'endpoint'],
        b2: ['account', 'key'],
        swift: ['auth', 'user', 'key', 'tenant', 'domain', 'region'],
        koofr: ['provider', 'endpoint', 'user', 'password'],
        mega: ['user', 'pass']
    };
    Object.keys(expect).forEach((id) => {
        assert.deepEqual(Rclone.providerFor(id).fields.map((f) => f.key), expect[id], id);
    });
});

test('the rclone backend type matches the provider id for every destination', () => {
    Rclone.providers().forEach((p) => assert.equal(p.type, p.id, p.id + ' type drifted'));
});

test('the table is deeply frozen — a view cannot un-mark a secret field', () => {
    const drive = Rclone.providerFor('drive');
    assert.equal(Object.isFrozen(drive), true);
    assert.equal(Object.isFrozen(drive.fields), true);
    assert.equal(Object.isFrozen(drive.fields[1]), true);
    assert.throws(() => { 'use strict'; drive.fields[1].type = 'text'; }, TypeError);
    assert.equal(Rclone.providerFor('drive').fields[1].type, 'password');
});

test('providerFor returns null for anything unknown instead of throwing', () => {
    [null, undefined, '', 'nope', 42, {}, [], Symbol('x'), '__proto__', 'constructor', 'toString']
        .forEach((v) => assert.equal(Rclone.providerFor(v), null, label(v)));
});

test('isOAuth is true for exactly the destinations rclone can authorize', () => {
    // jottacloud is deliberately NOT here. Verified by running it:
    // `rclone authorize jottacloud` answers "not supported by this backend",
    // even though the backend HAS a token option — which is the proxy that let a
    // broken command ship. Marking it OAuth would print a command that errors.
    ['drive', 'dropbox', 'onedrive', 'box', 'pcloud', 'yandex']
        .forEach((id) => assert.equal(Rclone.isOAuth(id), true, id));
    ['webdav', 'sftp', 'ftp', 'smb', 's3', 'b2', 'swift', 'koofr', 'mega', 'jottacloud']
        .forEach((id) => assert.equal(Rclone.isOAuth(id), false, id));
});

test('a provider rclone cannot authorize offers instructions, not a command', () => {
    assert.equal(Rclone.authorizeCommand('jottacloud'), null,
        'a command that errors is worse than no command');
    const setup = Rclone.externalSetup('jottacloud');
    assert.ok(setup, 'no setup instructions for an external provider');
    assert.ok(setup.steps.length >= 2, 'instructions too thin to follow');
    assert.equal(setup.command, 'rclone config');
    // And the opposite direction: an OAuth provider has no external setup.
    assert.equal(Rclone.externalSetup('drive'), null);
    assert.equal(Rclone.authorizeCommand('drive'), 'rclone authorize "drive"');
});

test('isOAuth is total — unknown input is false, never a throw', () => {
    [null, undefined, '', 'nope', 0, {}, []].forEach((v) => assert.equal(Rclone.isOAuth(v), false));
});

test('every OAuth provider carries a client_id and client_secret field', () => {
    Rclone.providers().filter((p) => p.auth === Rclone.AUTH.OAUTH).forEach((p) => {
        const keys = p.fields.map((f) => f.key);
        assert.ok(keys.includes('client_id'), p.id);
        assert.ok(keys.includes('client_secret'), p.id);
        assert.equal(Rclone.fieldFor(p.id, 'client_secret').type, 'password', p.id);
    });
});

test('Google Drive warns about the shared, rate-limited built-in client ID', () => {
    const notes = Rclone.providerFor('drive').notes;
    assert.match(notes, /rate-limited/i);
    assert.match(notes, /own client ID/i);
});

test('every password-typed field rclone stores obscured is marked obscure', () => {
    // Verified against `rclone config providers` on 1.74.3 (IsPassword=true).
    const obscured = { webdav: ['pass'], sftp: ['pass', 'key_file_pass'], ftp: ['pass'],
        smb: ['pass'], koofr: ['password'], mega: ['pass'] };
    Object.keys(obscured).forEach((id) => {
        obscured[id].forEach((key) => {
            assert.equal(Rclone.fieldFor(id, key).obscure, true, id + '.' + key);
        });
    });
    // Tokens and API keys are stored verbatim; obscuring them would corrupt them.
    ['s3.secret_access_key', 'b2.key', 'swift.key'].forEach((pair) => {
        const parts = pair.split('.');
        assert.notEqual(Rclone.fieldFor(parts[0], parts[1]).obscure, true, pair);
    });
});

test('fieldFor returns null for an unknown provider or key', () => {
    assert.equal(Rclone.fieldFor('nope', 'pass'), null);
    assert.equal(Rclone.fieldFor('webdav', 'nope'), null);
    assert.equal(Rclone.fieldFor('webdav', '__proto__'), null);
    assert.equal(Rclone.fieldFor('webdav', 'pass').key, 'pass');
});

test('isSecretField keys off the password type alone', () => {
    assert.equal(Rclone.isSecretField({ type: 'password' }), true);
    assert.equal(Rclone.isSecretField({ type: 'text' }), false);
    assert.equal(Rclone.isSecretField(null), false);
    assert.equal(Rclone.isSecretField(undefined), false);
});

// --------------------------------------------------------- authorizeCommand

test('authorizeCommand is the documented headless command, quoted', () => {
    assert.equal(Rclone.authorizeCommand('drive'), 'rclone authorize "drive"');
    assert.equal(Rclone.authorizeCommand('dropbox'), 'rclone authorize "dropbox"');
    assert.equal(Rclone.authorizeCommand('onedrive'), 'rclone authorize "onedrive"');
});

test('authorizeCommand throws GENERIC for an unknown destination', () => {
    assertGeneric(() => Rclone.authorizeCommand('nope'));
    assertGeneric(() => Rclone.authorizeCommand(null));
    assertGeneric(() => Rclone.authorizeCommand(''));
});

test('describeProvider names the paste flow for OAuth and the credentials otherwise', () => {
    const drive = Rclone.describeProvider('drive');
    assert.match(drive, /Google Drive/);
    assert.match(drive, /rclone authorize "drive"/);
    assert.match(drive, /own computer/);
    const s3 = Rclone.describeProvider('s3');
    assert.match(s3, /Needs access key id and secret access key\./);
    assert.equal(/authorize/.test(s3), false);
});

test('describeProvider never throws and never returns an empty string', () => {
    Rclone.providers().forEach((p) => {
        const s = Rclone.describeProvider(p.id);
        assert.equal(typeof s, 'string');
        assert.ok(s.length > 20, p.id);
    });
    assert.equal(Rclone.describeProvider('nope'), 'Unknown destination.');
    assert.equal(Rclone.describeProvider(null), 'Unknown destination.');
});

// ------------------------------------------------------ validateRemoteName

test('validateRemoteName accepts ordinary names', () => {
    ['gdrive', 'nas', 'offsite-2', 'a', 'b2_cold', 'work.drive', 'a+b', 'user@host', 'Yedek']
        .forEach((n) => assert.deepEqual(Rclone.validateRemoteName(n), [], n));
});

test('validateRemoteName accepts unicode letters, as rclone itself does', () => {
    ['günlük', 'yedek-ölçüm', '日本語'].forEach((n) => {
        assert.deepEqual(Rclone.validateRemoteName(n), [], n);
    });
});

test('validateRemoteName rejects empty, null and whitespace-only names', () => {
    assert.deepEqual(Rclone.validateRemoteName(''), ['A remote name is required.']);
    assert.deepEqual(Rclone.validateRemoteName(null), ['A remote name is required.']);
    assert.deepEqual(Rclone.validateRemoteName(undefined), ['A remote name is required.']);
    ['   ', '\t', '\n'].forEach((n) => {
        const p = Rclone.validateRemoteName(n);
        assert.ok(p.length >= 1, JSON.stringify(n) + ' was accepted');
    });
});

test('validateRemoteName rejects a colon — it separates the remote from the path', () => {
    ['gdrive:', ':gdrive', 'a:b', 'rclone:gdrive:backups'].forEach((n) => {
        const p = Rclone.validateRemoteName(n);
        assert.ok(p.some((x) => /must not contain ":"/.test(x)), n + ' -> ' + JSON.stringify(p));
    });
});

test('validateRemoteName rejects a leading dash — argv would read it as a flag', () => {
    ['-gdrive', '--config', '-'].forEach((n) => {
        const p = Rclone.validateRemoteName(n);
        assert.ok(p.some((x) => /must not start with "-"/.test(x)), n + ' -> ' + JSON.stringify(p));
    });
});

test('validateRemoteName allows a dash anywhere but the first character', () => {
    assert.deepEqual(Rclone.validateRemoteName('off-site-2'), []);
    assert.deepEqual(Rclone.validateRemoteName('x-'), []);
});

test('validateRemoteName rejects a slash', () => {
    ['a/b', '/gdrive', '../etc', 'gdrive/'].forEach((n) => {
        assert.ok(Rclone.validateRemoteName(n).some((x) => /must not contain "\/"/.test(x)), n);
    });
});

test('validateRemoteName rejects every kind of whitespace', () => {
    ['my drive', 'a\tb', 'a\nb', 'a\r\nb', ' lead', 'trail ', 'a b'].forEach((n) => {
        assert.ok(Rclone.validateRemoteName(n).some((x) => /must not contain spaces/.test(x)),
            JSON.stringify(n));
    });
});

test('validateRemoteName rejects control characters and a NUL byte', () => {
    // U+202E is the right-to-left override: it makes a name render as something
    // other than what it is. U+200B is an invisible zero-width space.
    ['a\u0000b', '\u0000', 'a\u0007b', 'a\u001bb', 'a\u202eb', 'a\u200bb'].forEach((n) => {
        assert.ok(Rclone.validateRemoteName(n).some((x) => /control characters/.test(x)),
            JSON.stringify(n) + ' -> ' + JSON.stringify(Rclone.validateRemoteName(n)));
    });
});

test('validateRemoteName rejects shell metacharacters', () => {
    ['$(id)', '`id`', 'a;rm', 'a&&b', 'a|b', '${IFS}', 'a*', 'a?', 'a\\b', '"q"', "'q'", 'a#b', 'a[b]']
        .forEach((n) => assert.notDeepEqual(Rclone.validateRemoteName(n), [], n));
});

test('validateRemoteName enforces a sane length', () => {
    const ok = 'a'.repeat(Rclone.MAX_NAME_LEN);
    assert.deepEqual(Rclone.validateRemoteName(ok), []);
    const tooLong = 'a'.repeat(Rclone.MAX_NAME_LEN + 1);
    assert.deepEqual(Rclone.validateRemoteName(tooLong),
        ['A remote name may be at most ' + Rclone.MAX_NAME_LEN + ' characters.']);
    assert.notDeepEqual(Rclone.validateRemoteName('x'.repeat(100000)), []);
});

test('validateRemoteName reports one problem per distinct fault, never a duplicate', () => {
    const p = Rclone.validateRemoteName('-a:b/c d');
    assert.equal(new Set(p).size, p.length, JSON.stringify(p));
    assert.equal(p.length, 4, JSON.stringify(p));
});

test('validateRemoteName never throws, whatever it is handed', () => {
    [Symbol('x'), 9007199254740993n, {}, [], () => {}, new Date(0), Object.create(null), /re/, NaN]
        .forEach((v) => {
            assert.ok(Array.isArray(Rclone.validateRemoteName(v)), label(v));
        });
});

test('validateRemoteName returns a fresh array each call', () => {
    const a = Rclone.validateRemoteName('a:b');
    a.push('injected');
    assert.equal(Rclone.validateRemoteName('a:b').length, 1);
});

// ----------------------------------------------------------- validateFields

test('validateFields accepts a complete credentials form', () => {
    assert.deepEqual(Rclone.validateFields('webdav',
        { url: 'https://cloud.example/remote.php/dav/files/a/', user: 'alice', pass: 'hunter2' }), []);
    assert.deepEqual(Rclone.validateFields('s3',
        { access_key_id: 'AKIA1', secret_access_key: 'sec', region: 'eu-central-1' }), []);
});

test('validateFields accepts an empty form for a provider with no required field', () => {
    assert.deepEqual(Rclone.validateFields('drive', {}), []);
    assert.deepEqual(Rclone.validateFields('dropbox', null), []);
    assert.deepEqual(Rclone.validateFields('box', undefined), []);
});

test('validateFields reports every missing required field by label', () => {
    assert.deepEqual(Rclone.validateFields('s3', {}),
        ['Access key ID is required.', 'Secret access key is required.']);
    assert.deepEqual(Rclone.validateFields('b2', {}),
        ['Account ID or application key ID is required.', 'Application key is required.']);
    assert.deepEqual(Rclone.validateFields('webdav', {}), ['Server URL is required.']);
});

test('validateFields treats a whitespace-only required value as missing', () => {
    assert.deepEqual(Rclone.validateFields('webdav', { url: '   ' }), ['Server URL is required.']);
    assert.deepEqual(Rclone.validateFields('mega', { user: '\t', pass: '\n' }).length, 2);
});

test('validateFields rejects a newline or NUL in any value — that is config injection', () => {
    ['a\nb', 'a\r\nb', 'a\0b', 'a\rb'].forEach((bad) => {
        assert.deepEqual(Rclone.validateFields('webdav', { url: bad }),
            ['Server URL must not contain line breaks or NUL bytes.'], JSON.stringify(bad));
        assert.deepEqual(Rclone.validateFields('webdav', { url: 'https://x/', pass: bad }),
            ['Password must not contain line breaks or NUL bytes.'], JSON.stringify(bad));
    });
});

test('validateFields rejects a select value outside its option list', () => {
    const p = Rclone.validateFields('webdav', { url: 'https://x/', vendor: 'dropbox' });
    assert.equal(p.length, 1);
    assert.match(p[0], /^Server type must be one of: nextcloud, owncloud, /);
    assert.deepEqual(Rclone.validateFields('webdav', { url: 'https://x/', vendor: 'nextcloud' }), []);
});

test('validateFields ignores keys the provider does not declare', () => {
    assert.deepEqual(Rclone.validateFields('webdav',
        { url: 'https://x/', nonsense: 'a\nb', __proto__: 'x' }), []);
});

test('validateFields reports an unknown provider rather than throwing', () => {
    assert.deepEqual(Rclone.validateFields('nope', {}), ['Unknown destination: nope.']);
    assert.deepEqual(Rclone.validateFields('', {}), ['Unknown destination: (empty).']);
    assert.deepEqual(Rclone.validateFields(null, {}), ['Unknown destination: (empty).']);
});

test('validateFields never throws on hostile values', () => {
    [Symbol('v'), {}, [], () => {}, 0, false, Object.create(null)].forEach((v) => {
        assert.ok(Array.isArray(Rclone.validateFields('webdav', { url: v, pass: v })), label(v));
    });
    assert.ok(Array.isArray(Rclone.validateFields('webdav', 'not an object')));
});

// ------------------------------------------------------- configCreateArgv
//
// The security core of the module.

test('configCreateArgv builds the documented command for a credentials remote', () => {
    const out = Rclone.configCreateArgv('nc', 'webdav',
        { url: 'https://cloud.example/dav/', vendor: 'nextcloud', user: 'alice', pass: 'hunter2' });
    assert.deepEqual(out.argv, ['rclone', 'config', 'create', 'nc', 'webdav',
        'url=https://cloud.example/dav/', 'vendor=nextcloud', 'user=alice']);
    assert.deepEqual(out.secrets, [{ key: 'pass', value: 'hunter2', obscure: true }]);
});

test('configCreateArgv adds config_is_local=false for OAuth, as rclone documents', () => {
    const out = Rclone.configCreateArgv('gdrive', 'drive', {});
    assert.deepEqual(out.argv, ['rclone', 'config', 'create', 'gdrive', 'drive', 'config_is_local=false']);
    assert.deepEqual(out.secrets, []);
});

test('configCreateArgv adds config_is_local=false for exactly the OAuth destinations', () => {
    Rclone.providers().forEach((p) => {
        const values = {};
        p.fields.filter((f) => f.required).forEach((f) => { values[f.key] = 'x'; });
        const argv = Rclone.configCreateArgv('r', p.id, values).argv;
        assert.equal(argv.includes('config_is_local=false'), p.auth === Rclone.AUTH.OAUTH, p.id);
    });
});

test('configCreateArgv NEVER puts a secret value in argv — every provider, every secret field', () => {
    const MARKER = 'SUPER-SECRET-VALUE-';
    Rclone.providers().forEach((p) => {
        const values = {};
        let n = 0;
        p.fields.forEach((f) => {
            if (f.type === 'select') values[f.key] = f.options[0].value;
            else if (f.type === 'password') values[f.key] = MARKER + (n++);
            else values[f.key] = 'plain-' + f.key;
        });
        const out = Rclone.configCreateArgv('r', p.id, values, p.auth === Rclone.AUTH.OAUTH ? TOKEN_JSON : '');

        const joined = out.argv.join(' ');
        assert.equal(joined.includes(MARKER), false,
            p.id + ' leaked a password into argv: ' + joined);
        assert.equal(joined.includes(TOKEN_JSON), false, p.id + ' leaked the token into argv');
        assert.equal(joined.includes('ya29.'), false, p.id + ' leaked part of the token into argv');

        // …and every secret is still delivered, exactly once, off argv.
        const expected = p.fields.filter((f) => f.type === 'password').map((f) => f.key)
            .concat(p.auth === Rclone.AUTH.OAUTH ? ['token'] : []);
        assert.deepEqual(out.secrets.map((s) => s.key), expected, p.id);
        out.secrets.forEach((s) => assert.notEqual(s.value, '', p.id + '.' + s.key));
    });
});

test('configCreateArgv puts every non-secret field in argv as key=value', () => {
    const out = Rclone.configCreateArgv('sf', 'sftp',
        { host: 'nas.lan', user: 'backup', port: '2222', key_file: '/root/.ssh/id_ed25519',
          key_file_pass: 'kp', pass: 'pw' });
    assert.deepEqual(out.argv, ['rclone', 'config', 'create', 'sf', 'sftp',
        'host=nas.lan', 'user=backup', 'port=2222', 'key_file=/root/.ssh/id_ed25519']);
    assert.deepEqual(out.secrets, [
        { key: 'key_file_pass', value: 'kp', obscure: true },
        { key: 'pass', value: 'pw', obscure: true }
    ]);
});

test('configCreateArgv omits blank optional fields entirely', () => {
    const out = Rclone.configCreateArgv('sf', 'sftp', { host: 'nas.lan', user: '', port: '  ', pass: '' });
    assert.deepEqual(out.argv, ['rclone', 'config', 'create', 'sf', 'sftp', 'host=nas.lan']);
    assert.deepEqual(out.secrets, []);
});

test('configCreateArgv trims a non-secret value but never a password', () => {
    const out = Rclone.configCreateArgv('nc', 'webdav',
        { url: '  https://cloud.example/dav/  ', pass: '  spaced password  ' });
    assert.ok(out.argv.includes('url=https://cloud.example/dav/'));
    assert.equal(out.secrets[0].value, '  spaced password  ');
});

test('configCreateArgv keeps the field order of the provider table', () => {
    const out = Rclone.configCreateArgv('s3r', 's3',
        { endpoint: 'https://minio.lan:9000', region: 'eu', access_key_id: 'AK', secret_access_key: 'SK',
          provider: 'Minio' });
    assert.deepEqual(out.argv.slice(5),
        ['provider=Minio', 'access_key_id=AK', 'region=eu', 'endpoint=https://minio.lan:9000']);
});

test('configCreateArgv carries the pasted token as a secret named token', () => {
    const out = Rclone.configCreateArgv('gdrive', 'drive', { client_id: 'cid' }, TOKEN_JSON);
    assert.deepEqual(out.argv,
        ['rclone', 'config', 'create', 'gdrive', 'drive', 'client_id=cid', 'config_is_local=false']);
    assert.deepEqual(out.secrets, [{ key: 'token', value: TOKEN_JSON, obscure: false }]);
});

test('configCreateArgv trims a pasted token and ignores an empty one', () => {
    assert.equal(Rclone.configCreateArgv('g', 'drive', {}, '  ' + TOKEN_JSON + '  ').secrets[0].value,
        TOKEN_JSON);
    assert.deepEqual(Rclone.configCreateArgv('g', 'drive', {}, '   ').secrets, []);
    assert.deepEqual(Rclone.configCreateArgv('g', 'drive', {}, null).secrets, []);
});

test('configCreateArgv refuses a multi-line token — it would forge a config key', () => {
    assertGeneric(() => Rclone.configCreateArgv('g', 'drive', {}, 'tok\nteam_drive = evil'));
    assertGeneric(() => Rclone.configCreateArgv('g', 'drive', {}, 'tok\0evil'));
});

test('configCreateArgv refuses a token for a provider that has no OAuth flow', () => {
    assertGeneric(() => Rclone.configCreateArgv('nc', 'webdav', { url: 'https://x/' }, TOKEN_JSON));
});

test('configCreateArgv refuses an invalid remote name before building anything', () => {
    ['', '-x', 'a:b', 'a/b', 'a b', 'a\0b', 'x'.repeat(200)].forEach((n) => {
        assertGeneric(() => Rclone.configCreateArgv(n, 'drive', {}));
    });
});

test('configCreateArgv carries the name problems in the error detail', () => {
    try {
        Rclone.configCreateArgv('-a:b', 'drive', {});
        assert.fail('expected a throw');
    } catch (e) {
        assert.equal(e.name, 'HangarError');
        assert.equal(e.detail.name, '-a:b');
        assert.equal(e.detail.problems.length, 2);
    }
});

test('configCreateArgv refuses an unknown provider', () => {
    assertGeneric(() => Rclone.configCreateArgv('r', 'nope', {}));
    assertGeneric(() => Rclone.configCreateArgv('r', '', {}));
    assertGeneric(() => Rclone.configCreateArgv('r', null, {}));
    assertGeneric(() => Rclone.configCreateArgv('r', '__proto__', {}));
});

test('configCreateArgv refuses a value that would inject a second config key', () => {
    assertGeneric(() => Rclone.configCreateArgv('nc', 'webdav',
        { url: 'https://x/\ntoken = stolen' }));
    assertGeneric(() => Rclone.configCreateArgv('nc', 'webdav',
        { url: 'https://x/', pass: 'a\nb' }));
});

test('configCreateArgv refuses a missing required field', () => {
    assertGeneric(() => Rclone.configCreateArgv('s3r', 's3', { access_key_id: 'AK' }));
    assertGeneric(() => Rclone.configCreateArgv('m', 'mega', { user: 'a@b.c' }));
});

test('configCreateArgv argv is always rclone config create <name> <type> first', () => {
    Rclone.providers().forEach((p) => {
        const values = {};
        p.fields.filter((f) => f.required).forEach((f) => { values[f.key] = 'x'; });
        const argv = Rclone.configCreateArgv('r', p.id, values).argv;
        assert.deepEqual(argv.slice(0, 5), ['rclone', 'config', 'create', 'r', p.type], p.id);
        argv.slice(5).forEach((a) => assert.match(a, /^[a-z0-9_]+=/, p.id + ' -> ' + a));
    });
});

test('configCreateArgv returns fresh arrays a caller cannot alias into the table', () => {
    const a = Rclone.configCreateArgv('r', 'drive', {});
    a.argv.push('injected');
    a.secrets.push({ key: 'x' });
    const b = Rclone.configCreateArgv('r', 'drive', {});
    assert.equal(b.argv.includes('injected'), false);
    assert.deepEqual(b.secrets, []);
});

test('configCreateArgv passes shell metacharacters through as one argv element', () => {
    const out = Rclone.configCreateArgv('r', 'webdav', { url: 'https://x/$(id);rm -rf /' });
    assert.equal(out.argv[5], 'url=https://x/$(id);rm -rf /');
});

// -------------------------------------------------------- configDeleteArgv

test('configDeleteArgv builds the delete command', () => {
    assert.deepEqual(Rclone.configDeleteArgv('gdrive'), ['rclone', 'config', 'delete', 'gdrive']);
});

test('configDeleteArgv refuses the same names configCreateArgv does', () => {
    ['', '-x', 'a:b', 'a b', 'a/b'].forEach((n) => assertGeneric(() => Rclone.configDeleteArgv(n)));
});

test('configFileArgv and obscureArgv are the documented commands', () => {
    assert.deepEqual(Rclone.configFileArgv(), ['rclone', 'config', 'file']);
    // The hyphen is what makes rclone read the password from stdin instead of argv.
    assert.deepEqual(Rclone.obscureArgv(), ['rclone', 'obscure', '-']);
});

// ---------------------------------------------------------- looksLikeToken

test('looksLikeToken accepts the JSON token rclone authorize prints', () => {
    assert.equal(Rclone.looksLikeToken(TOKEN_JSON), true);
    assert.equal(Rclone.looksLikeToken('{"access_token":"x","expiry":"2026-01-01T00:00:00Z"}'), true);
    assert.equal(Rclone.looksLikeToken('{"refresh_token":"x"}'), true);
});

test('looksLikeToken accepts pretty-printed and whitespace-padded JSON', () => {
    assert.equal(Rclone.looksLikeToken('\n  {"access_token": "x"}  \n'), true);
    assert.equal(Rclone.looksLikeToken('{\n  "access_token": "x",\n  "token_type": "Bearer"\n}'), true);
});

test('looksLikeToken accepts a JSON blob a terminal mangled but that still names the fields', () => {
    assert.equal(Rclone.looksLikeToken('{"access_token" : "x" ,,}'), true);
});

test('looksLikeToken accepts the opaque form', () => {
    assert.equal(Rclone.looksLikeToken('AbCdEf0123456789_-.~+/=AbCdEf'), true);
    assert.equal(Rclone.looksLikeToken('a'.repeat(200)), true);
});

test('looksLikeToken rejects rclone log lines and the marker lines themselves', () => {
    ['', '   ', 'Paste the following into your remote machine --->', '<---End paste',
        'Waiting for code...', 'Got code', 'Log in and authorize rclone for access',
        'If your browser doesn\'t open automatically go to the following link: http://127.0.0.1:53682/auth?state=x',
        'http://127.0.0.1:53682/auth?state=abcdefghijklmnop',
        '2026/08/01 20:00:00 NOTICE: Config file not found - using defaults']
        .forEach((s) => assert.equal(Rclone.looksLikeToken(s), false, JSON.stringify(s)));
});

test('looksLikeToken rejects a short blob and a JSON object with no token field', () => {
    assert.equal(Rclone.looksLikeToken('short'), false);
    assert.equal(Rclone.looksLikeToken('SECRET'), false);
    assert.equal(Rclone.looksLikeToken('{"hello":"world"}'), false);
    assert.equal(Rclone.looksLikeToken('{}'), false);
});

test('looksLikeToken never throws on hostile input', () => {
    [null, undefined, 0, NaN, {}, [], Symbol('t'), () => {}, Object.create(null), 9007199254740993n]
        .forEach((v) => assert.equal(typeof Rclone.looksLikeToken(v), 'boolean', label(v)));
});

// ----------------------------------------------------- parseAuthorizeOutput

// The full shape rclone prints on the user's own machine, log lines and all.
const FULL_PASTE = [
    '2026/08/01 20:00:00 NOTICE: Config file "/home/u/.config/rclone/rclone.conf" not found - using defaults',
    'If your browser doesn\'t open automatically go to the following link: http://127.0.0.1:53682/auth?state=Xy9',
    'Log in and authorize rclone for access',
    'Waiting for code...',
    'Got code',
    'Paste the following into your remote machine --->',
    TOKEN_JSON,
    '<---End paste'
].join('\n');

test('parseAuthorizeOutput extracts the token from the full documented output', () => {
    assert.equal(Rclone.parseAuthorizeOutput(FULL_PASTE), TOKEN_JSON);
});

test('parseAuthorizeOutput tolerates CRLF line endings', () => {
    assert.equal(Rclone.parseAuthorizeOutput(FULL_PASTE.replace(/\n/g, '\r\n')), TOKEN_JSON);
});

test('parseAuthorizeOutput tolerates leading and trailing blank lines and indentation', () => {
    const messy = '\n\n\n   Paste the following into your remote machine --->   \n\n' +
        '    ' + TOKEN_JSON + '   \n\n<---End paste\n\n\n';
    assert.equal(Rclone.parseAuthorizeOutput(messy), TOKEN_JSON);
});

test('parseAuthorizeOutput accepts the marker lines being absent', () => {
    assert.equal(Rclone.parseAuthorizeOutput(TOKEN_JSON), TOKEN_JSON);
    assert.equal(Rclone.parseAuthorizeOutput('\n  ' + TOKEN_JSON + '  \n'), TOKEN_JSON);
});

test('parseAuthorizeOutput accepts only the end marker surviving the copy', () => {
    assert.equal(Rclone.parseAuthorizeOutput(TOKEN_JSON + '\n<---End paste'), TOKEN_JSON);
});

test('parseAuthorizeOutput accepts only the start marker surviving the copy', () => {
    assert.equal(Rclone.parseAuthorizeOutput(
        'Paste the following into your remote machine --->\n' + TOKEN_JSON), TOKEN_JSON);
});

test('parseAuthorizeOutput rejoins a token the terminal hard-wrapped', () => {
    const wrapped = 'Paste the following into your remote machine --->\n' +
        TOKEN_JSON.slice(0, 40) + '\n' + TOKEN_JSON.slice(40, 90) + '\n' + TOKEN_JSON.slice(90) +
        '\n<---End paste';
    assert.equal(Rclone.parseAuthorizeOutput(wrapped), TOKEN_JSON);
});

test('parseAuthorizeOutput handles the token sharing the marker line', () => {
    assert.equal(Rclone.parseAuthorizeOutput(
        'Paste the following into your remote machine ---> ' + TOKEN_JSON + '\n<---End paste'), TOKEN_JSON);
});

test('parseAuthorizeOutput tolerates marker variants and mixed case', () => {
    ['PASTE THE FOLLOWING INTO YOUR REMOTE MACHINE --->', 'Paste the following into your remote machine',
        'paste the following into your remote machine -->']
        .forEach((marker) => {
            assert.equal(Rclone.parseAuthorizeOutput(marker + '\n' + TOKEN_JSON + '\n<---End paste'),
                TOKEN_JSON, marker);
        });
    ['<---End paste', '<--- End paste', 'End paste', '<---End paste--->']
        .forEach((marker) => {
            assert.equal(Rclone.parseAuthorizeOutput(
                'Paste the following into your remote machine --->\n' + TOKEN_JSON + '\n' + marker),
            TOKEN_JSON, marker);
        });
});

test('parseAuthorizeOutput ignores everything after the end marker', () => {
    assert.equal(Rclone.parseAuthorizeOutput(FULL_PASTE + '\nu@laptop:~$ echo done\ndone'), TOKEN_JSON);
});

test('parseAuthorizeOutput extracts an opaque token between the markers', () => {
    const opaque = 'eyJhbGciOiJIUzI1NiJ9.FAKE.OPAQUE-TOKEN_0123456789';
    assert.equal(Rclone.parseAuthorizeOutput(
        'Paste the following into your remote machine --->\n' + opaque + '\n<---End paste'), opaque);
    assert.equal(Rclone.parseAuthorizeOutput(opaque), opaque);
});

test('parseAuthorizeOutput digs a JSON token out of surrounding prose', () => {
    assert.equal(Rclone.parseAuthorizeOutput('here you go: ' + TOKEN_JSON + ' -- good luck'), TOKEN_JSON);
});

test('parseAuthorizeOutput finds the token line among rclone log noise with no markers', () => {
    const noisy = ['Waiting for code...', 'Got code', TOKEN_JSON].join('\n');
    assert.equal(Rclone.parseAuthorizeOutput(noisy), TOKEN_JSON);
});

test('parseAuthorizeOutput returns null rather than a guess when there is nothing usable', () => {
    ['', '   ', '\n\n', null, undefined, 'no token here', 'Waiting for code...',
        'Paste the following into your remote machine --->\n<---End paste',
        'Paste the following into your remote machine --->\n\n\n',
        'user@laptop:~$ rclone authorize "drive"']
        .forEach((s) => assert.equal(Rclone.parseAuthorizeOutput(s), null, JSON.stringify(s)));
});

test('parseAuthorizeOutput never returns a partial token', () => {
    // A paste that lost its closing brace is not a token, and half a token would
    // fail at 03:00 in a unit nobody is watching.
    const truncated = TOKEN_JSON.slice(0, 40);
    assert.equal(Rclone.parseAuthorizeOutput(truncated), null);
});

test('parseAuthorizeOutput never throws on hostile input', () => {
    [0, NaN, {}, [], Symbol('t'), () => {}, Object.create(null), '\0', '‮']
        .forEach((v) => {
            const out = Rclone.parseAuthorizeOutput(v);
            assert.ok(out === null || typeof out === 'string', label(v));
        });
});

// ------------------------------------------------------ mergeConfigSection

const EXISTING = [
    '# hand-written comment',
    '[other]',
    'type = webdav',
    'url = https://keep.me/',
    '',
    '[gdrive]',
    'type = drive',
    'scope = drive',
    ''
].join('\n');

test('mergeConfigSection adds a key to an existing section and leaves the rest byte-identical', () => {
    const out = Rclone.mergeConfigSection(EXISTING, 'gdrive', [{ key: 'token', value: TOKEN_JSON }]);
    assert.equal(out, [
        '# hand-written comment',
        '[other]',
        'type = webdav',
        'url = https://keep.me/',
        '',
        '[gdrive]',
        'type = drive',
        'scope = drive',
        'token = ' + TOKEN_JSON
    ].join('\n') + '\n');
});

test('mergeConfigSection rewrites an existing key in place', () => {
    const out = Rclone.mergeConfigSection(EXISTING, 'other', [{ key: 'url', value: 'https://new/' }]);
    assert.match(out, /^url = https:\/\/new\/$/m);
    assert.equal(out.includes('https://keep.me/'), false);
    assert.match(out, /\[gdrive\]/);
});

test('mergeConfigSection touches only the named section', () => {
    const out = Rclone.mergeConfigSection(EXISTING, 'gdrive', [{ key: 'type', value: 'drive2' }]);
    assert.match(out, /\[other\]\ntype = webdav/);
    assert.match(out, /\[gdrive\]\ntype = drive2/);
});

test('mergeConfigSection appends a whole new section when the remote is not there yet', () => {
    const out = Rclone.mergeConfigSection(EXISTING, 'nc', [{ key: 'pass', value: 'obscured' }]);
    assert.match(out, /\n\n\[nc\]\npass = obscured\n$/);
    assert.match(out, /\[gdrive\]/);
});

test('mergeConfigSection creates the file content from nothing', () => {
    assert.equal(Rclone.mergeConfigSection('', 'nc', [{ key: 'pass', value: 'x' }]),
        '[nc]\npass = x\n');
    assert.equal(Rclone.mergeConfigSection(null, 'nc', []), '[nc]\n');
    assert.equal(Rclone.mergeConfigSection('\n\n\n', 'nc', [{ key: 'a', value: 'b' }]), '[nc]\na = b\n');
});

test('mergeConfigSection preserves comments and blank lines it did not touch', () => {
    const text = '# top\n\n[a]\n# inner comment\nk = 1\n\n# between\n\n[b]\nk = 2\n';
    const out = Rclone.mergeConfigSection(text, 'a', [{ key: 'k', value: '9' }]);
    assert.match(out, /# top/);
    assert.match(out, /# inner comment/);
    assert.match(out, /# between/);
    assert.match(out, /^k = 9$/m);
    assert.match(out, /\[b\]\nk = 2/);
});

test('mergeConfigSection collapses duplicate keys inside the target section', () => {
    const text = '[a]\nk = 1\nk = 2\nk = 3\n';
    assert.equal(Rclone.mergeConfigSection(text, 'a', [{ key: 'k', value: '9' }]), '[a]\nk = 9\n');
});

test('mergeConfigSection writes several keys at once and keeps their order', () => {
    const out = Rclone.mergeConfigSection('[a]\ntype = webdav\n', 'a',
        [{ key: 'user', value: 'alice' }, { key: 'pass', value: 'obsc' }]);
    assert.equal(out, '[a]\ntype = webdav\nuser = alice\npass = obsc\n');
});

test('mergeConfigSection ends the file with exactly one newline', () => {
    ['[a]\nk = 1', '[a]\nk = 1\n', '[a]\nk = 1\n\n\n'].forEach((text) => {
        const out = Rclone.mergeConfigSection(text, 'a', [{ key: 'k', value: '2' }]);
        assert.equal(out, '[a]\nk = 2\n', JSON.stringify(text));
    });
});

test('mergeConfigSection tolerates CRLF input and normalises to LF', () => {
    const out = Rclone.mergeConfigSection('[a]\r\ntype = webdav\r\n', 'a', [{ key: 'k', value: '1' }]);
    assert.equal(out, '[a]\ntype = webdav\nk = 1\n');
});

test('mergeConfigSection is idempotent', () => {
    const once = Rclone.mergeConfigSection(EXISTING, 'gdrive', [{ key: 'token', value: 'T' }]);
    assert.equal(Rclone.mergeConfigSection(once, 'gdrive', [{ key: 'token', value: 'T' }]), once);
});

test('mergeConfigSection refuses a value that would forge another key', () => {
    assertGeneric(() => Rclone.mergeConfigSection('[a]\n', 'a', [{ key: 'k', value: 'x\ntoken = stolen' }]));
    assertGeneric(() => Rclone.mergeConfigSection('[a]\n', 'a', [{ key: 'k', value: 'x\0y' }]));
    assertGeneric(() => Rclone.mergeConfigSection('[a]\n', 'a', [{ key: 'k\nevil', value: 'x' }]));
});

test('mergeConfigSection refuses a key that is not an rclone config key', () => {
    ['k-1', 'k.1', 'k 1', 'k=1', '[k]', 'k;1'].forEach((k) => {
        assertGeneric(() => Rclone.mergeConfigSection('[a]\n', 'a', [{ key: k, value: 'x' }]));
    });
});

test('mergeConfigSection refuses a section name that would break the INI structure', () => {
    ['', '[evil]', 'a]b', 'a\nb', 'a\0b'].forEach((n) => {
        assertGeneric(() => Rclone.mergeConfigSection('[a]\n', n, [{ key: 'k', value: 'x' }]));
    });
});

test('mergeConfigSection ignores empty and malformed pair entries', () => {
    const out = Rclone.mergeConfigSection('[a]\n', 'a', [null, undefined, {}, { key: '  ' }, { key: 'k', value: 'v' }]);
    assert.equal(out, '[a]\nk = v\n');
    assert.equal(Rclone.mergeConfigSection('[a]\nk = 1\n', 'a', 'not an array'), '[a]\nk = 1\n');
});

test('mergeConfigSection does not match a section whose name merely starts the same', () => {
    const text = '[gdrive-old]\nk = 1\n\n[gdrive]\nk = 2\n';
    const out = Rclone.mergeConfigSection(text, 'gdrive', [{ key: 'k', value: '9' }]);
    assert.match(out, /\[gdrive-old\]\nk = 1/);
    assert.match(out, /\[gdrive\]\nk = 9/);
});

// ------------------------------------------------------ parseConfigFilePath

test('parseConfigFilePath reads the path out of rclone config file output', () => {
    assert.equal(Rclone.parseConfigFilePath(
        'Configuration file is stored at:\n/root/.config/rclone/rclone.conf\n'),
    '/root/.config/rclone/rclone.conf');
});

test('parseConfigFilePath tolerates CRLF, blank lines and a NOTICE above', () => {
    assert.equal(Rclone.parseConfigFilePath(
        '2026/08/01 NOTICE: Config file not found - using defaults\r\n\r\n' +
        'Configuration file is stored at:\r\n  /etc/rclone.conf  \r\n\r\n'), '/etc/rclone.conf');
});

test('parseConfigFilePath returns null when there is no absolute path', () => {
    ['', '   ', null, undefined, 'Configuration file is stored at:', 'relative/path.conf']
        .forEach((s) => assert.equal(Rclone.parseConfigFilePath(s), null, JSON.stringify(s)));
});

// ------------------------------------------------------ classifyRcloneError

test('classifyRcloneError reports a missing rclone as an installable state', () => {
    ['exec: "rclone": executable file not found in $PATH', 'ENOENT', 'rclone: command not found']
        .forEach((m) => {
            const e = Rclone.classifyRcloneError(m);
            assert.equal(e.kind, Errors.KIND.GENERIC);
            assert.equal(e.message, 'rclone is not installed on this host.');
        });
});

test('classifyRcloneError maps unreachable services to NETWORK, which offers a retry', () => {
    ['dial tcp 10.0.0.1:443: i/o timeout', 'connection refused', 'no such host', 'network is unreachable']
        .forEach((m) => {
            const e = Rclone.classifyRcloneError(m);
            assert.equal(e.kind, Errors.KIND.NETWORK, m);
            assert.equal(Errors.remediationFor(e), 'retry');
        });
});

test('classifyRcloneError falls back to GENERIC with the raw message', () => {
    const e = Rclone.classifyRcloneError('Failed to create remote: unknown backend "wat"');
    assert.equal(e.kind, Errors.KIND.GENERIC);
    assert.match(e.message, /unknown backend/);
    assert.equal(Rclone.classifyRcloneError('').message, 'rclone reported an error.');
    assert.equal(Rclone.classifyRcloneError(null).kind, Errors.KIND.GENERIC);
});

// ------------------------------------------------------------------ impure

test('createRemote rejects with a typed error when cockpit is absent', async () => {
    await assert.rejects(Rclone.createRemote('gdrive', 'drive', {}, TOKEN_JSON), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.equal(e.kind, Errors.KIND.GENERIC);
        assert.equal(e.message, 'cockpit is not available');
        return true;
    });
});

test('createRemote validates before it would ever spawn', async () => {
    await assert.rejects(Rclone.createRemote('a:b', 'drive', {}), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.match(e.message, /must not contain ":"/);
        return true;
    });
    await assert.rejects(Rclone.createRemote('r', 'nope', {}), (e) => {
        assert.match(e.message, /Unknown destination/);
        return true;
    });
    await assert.rejects(Rclone.createRemote('r', 's3', {}), (e) => {
        assert.match(e.message, /Access key ID is required/);
        return true;
    });
});

test('createRemote returns a promise and never throws synchronously', () => {
    const p = Rclone.createRemote(null, null, null, null);
    assert.ok(p && typeof p.then === 'function');
    return p.then(() => assert.fail('expected a rejection'), (e) => assert.ok(Errors.isHangarError(e)));
});

test('deleteRemote rejects with a typed error when cockpit is absent', async () => {
    await assert.rejects(Rclone.deleteRemote('gdrive'), (e) => {
        assert.equal(e.message, 'cockpit is not available');
        return true;
    });
});

test('deleteRemote validates the name before it would ever spawn', async () => {
    await assert.rejects(Rclone.deleteRemote('-x'), (e) => {
        assert.match(e.message, /must not start with "-"/);
        return true;
    });
    await assert.rejects(Rclone.deleteRemote(''), (e) => {
        assert.match(e.message, /required/);
        return true;
    });
});

// ------------------------------------------------------------------ module

test('module exposes the expected surface', () => {
    ['providers', 'providerFor', 'isOAuth', 'isSecretField', 'fieldFor', 'describeProvider',
        'validateRemoteName', 'validateFields', 'configCreateArgv', 'configDeleteArgv',
        'configFileArgv', 'obscureArgv', 'authorizeCommand', 'parseAuthorizeOutput',
        'looksLikeToken', 'mergeConfigSection', 'parseConfigFilePath', 'classifyRcloneError',
        'createRemote', 'deleteRemote']
        .forEach((fn) => assert.equal(typeof Rclone[fn], 'function', 'missing ' + fn));
    assert.equal(typeof Rclone.MAX_NAME_LEN, 'number');
    // EXTERNAL means rclone has no `authorize` hook for the backend, so hangar
    // shows instructions instead of a command that would error.
    assert.deepEqual(Rclone.AUTH,
        { OAUTH: 'oauth', CREDENTIALS: 'credentials', EXTERNAL: 'external', NONE: 'none' });
});

test('the module is a plain script with a dual export and no cockpit in its pure half', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'core', 'rclone.js'), 'utf8');
    assert.equal(/^\s*(import|export)\s/m.test(src), false, 'ES module syntax found');
    assert.ok(src.includes('module.exports'), 'no dual export');
    assert.ok(src.includes("'use strict';"));
    // Every cockpit reference must live in the impure half, which begins at
    // hasCockpit(). Comments are stripped first — the header explains the split
    // and would otherwise flag itself.
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const pure = code.slice(0, code.indexOf('function hasCockpit'));
    assert.equal(/\bcockpit\b/.test(pure), false, 'cockpit referenced in the pure half');
    // …and every reference in the impure half is guarded, never bare.
    assert.equal(/typeof cockpit !== 'undefined'/.test(code), true, 'unguarded cockpit access');
});

test('the module never writes a secret anywhere but into rclone config', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'core', 'rclone.js'), 'utf8');
    // No console logging at all: the values passing through here are credentials.
    assert.equal(/console\.(log|warn|error|debug|info)/.test(src), false, 'the module logs');
    assert.equal(/localStorage|sessionStorage/.test(src), false, 'the module stores in the browser');
});

test('the snapshot browser is never called anything but the Logbook', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'core', 'rclone.js'), 'utf8');
    assert.equal(/time\s*machine/i.test(src), false);
});

// =====================================================================
// Adversarial hardening pass.
//
// Everything below assumes the module is hostile-facing: every value in it
// arrives from a text box, and one of them is a credential. The organising
// question is not "does it work" but "what is the worst thing a value can be,
// and where does it end up".
// =====================================================================

const HangarRepos = require('../../js/core/repos.js');

// Values chosen to be NOTICED. Each contains the substring CANARY, so a leak is
// found by one search rather than by remembering which value went where. No
// newline or NUL here — those are refused outright and are tested separately.
const NOTICED = [
    'CANARY-plain-0001',
    'CANARY with spaces 0002',
    '--CANARY-looks-like-a-flag',
    '-C',
    'CANARY;rm -rf /;#0003',
    '$(id)`id`${HOME}CANARY',
    'CANARY\'"\\|&<>*?[]0004',
    'CANARY-ünïcödé-🔐-0005',
    '../../../etc/shadow#CANARY',
    'CANARY:with:colons',
    'CANARY=with=equals',
    'CANARY-user:pass@host',       // a password may legitimately look like a URL
    ' CANARY-leading-and-trailing ',
    '\t CANARY-tabs \t',
    'C'.repeat(4096) + 'ANARY-very-long',
    'CANARY‮reversed'         // an RTL override, which renders as a lie
];

function benignValues(p, except) {
    const v = {};
    p.fields.forEach((f) => {
        if (f.key === except) return;
        if (f.type === 'select') v[f.key] = f.options[0].value;
        else v[f.key] = 'benign-' + f.key;
    });
    return v;
}

// Total, and never throws on a detail holding a cycle or a Symbol — an assertion
// helper that can itself fail is worse than no assertion.
function dump(v) {
    const seen = new Set();
    try {
        return JSON.stringify(v, (k, x) => {
            if (typeof x === 'object' && x !== null) {
                if (seen.has(x)) return '[cycle]';
                seen.add(x);
            }
            return (typeof x === 'symbol' || typeof x === 'bigint') ? String(x) : x;
        }) || String(v);
    } catch (e) {
        return label(v);
    }
}

function assertNoCanary(text, where) {
    assert.equal(String(text).includes('CANARY'), false, 'CANARY leaked into ' + where + ': ' + text);
}

// ------------------------------------------------- argv is a published secret

test('no secret-typed field of any provider reaches argv, for any hostile value', () => {
    let checked = 0;
    Rclone.providers().forEach((p) => {
        p.fields.filter((f) => f.type === 'password').forEach((f) => {
            NOTICED.forEach((value) => {
                const values = benignValues(p, f.key);
                values[f.key] = value;
                const out = Rclone.configCreateArgv('r', p.id, values,
                    p.auth === Rclone.AUTH.OAUTH ? TOKEN_JSON : '');
                out.argv.forEach((a) => assertNoCanary(a, p.id + '.' + f.key + ' argv'));
                // …and it is still delivered, byte for byte, off argv.
                const carried = out.secrets.filter((s) => s.key === f.key);
                assert.equal(carried.length, 1, p.id + '.' + f.key + ' was dropped');
                assert.equal(carried[0].value, value, p.id + '.' + f.key + ' was altered');
                checked++;
            });
        });
    });
    assert.ok(checked > 200, 'the sweep covered only ' + checked + ' combinations');
});

test('every secret field of a provider can hold a hostile value at the same time', () => {
    // One field at a time can pass by accident; all of them at once is the shape
    // a real form submits.
    Rclone.providers().forEach((p) => {
        const secretFields = p.fields.filter((f) => f.type === 'password');
        if (!secretFields.length) return;
        const values = benignValues(p);
        secretFields.forEach((f, i) => { values[f.key] = NOTICED[i % NOTICED.length]; });
        const out = Rclone.configCreateArgv('r', p.id, values,
            p.auth === Rclone.AUTH.OAUTH ? TOKEN_JSON : '');
        assertNoCanary(out.argv.join(''), p.id + ' argv');
        assert.deepEqual(out.secrets.filter((s) => s.key !== 'token').map((s) => s.key),
            secretFields.map((f) => f.key), p.id);
    });
});

test('no argv element is ever keyed on a field the table calls secret', () => {
    // Stronger than searching for a value: it forbids the SHAPE `secretkey=…`,
    // so a future field cannot leak by holding a value that happens to look
    // innocent.
    Rclone.providers().forEach((p) => {
        const secretKeys = p.fields.filter((f) => f.type === 'password').map((f) => f.key);
        const out = Rclone.configCreateArgv('r', p.id, benignValues(p),
            p.auth === Rclone.AUTH.OAUTH ? TOKEN_JSON : '');
        out.argv.slice(5).forEach((a) => {
            const key = a.slice(0, a.indexOf('='));
            assert.equal(secretKeys.includes(key), false, p.id + ' put ' + key + ' in argv');
            assert.notEqual(key, 'token', p.id + ' put a token key in argv');
        });
    });
});

test('the pasted OAuth token never reaches argv, whatever shape it arrives in', () => {
    const shapes = [
        TOKEN_JSON,
        '{"access_token":"CANARY-opaque","refresh_token":"CANARY-refresh","expiry":"2026-01-01T00:00:00Z"}',
        'CANARY' + 'x'.repeat(4000),
        '--CANARY-token-looks-like-a-flag',
        'CANARY-with-$(id)-and-;semicolons',
        '  CANARY-padded  '
    ];
    Rclone.providers().filter((p) => p.auth === Rclone.AUTH.OAUTH).forEach((p) => {
        shapes.forEach((tok) => {
            const out = Rclone.configCreateArgv('r', p.id, benignValues(p), tok);
            out.argv.forEach((a) => {
                assertNoCanary(a, p.id + ' argv');
                assert.equal(a.includes('ya29.'), false, p.id + ' leaked part of a real-shaped token');
                assert.equal(a.includes('token='), false, p.id + ' put a token key in argv');
            });
            const carried = out.secrets.filter((s) => s.key === 'token');
            assert.equal(carried.length, 1, p.id);
            assert.equal(carried[0].value, tok.trim(), p.id);
            assert.equal(carried[0].obscure, false, 'rclone stores the token in the clear');
        });
    });
});

test('argv holds nothing but the command, the name, the type and non-secret key=value', () => {
    Rclone.providers().forEach((p) => {
        const out = Rclone.configCreateArgv('r', p.id, benignValues(p),
            p.auth === Rclone.AUTH.OAUTH ? TOKEN_JSON : '');
        assert.deepEqual(out.argv.slice(0, 5), ['rclone', 'config', 'create', 'r', p.type], p.id);
        out.argv.slice(5).forEach((a) => {
            // A key rclone will accept, then a value. Nothing may be bare, or it
            // would be read as another positional argument.
            assert.match(a, /^[a-z0-9_]+=/, p.id + ' -> ' + a);
            assert.notEqual(a.charAt(0), '-', p.id + ' -> ' + a);
        });
    });
});

// ------------------------------------------------- a URL is not a hiding place

test('a credential embedded in a URL field is refused — argv is world-readable', () => {
    // The obvious thing to type into "Server URL" if you have ever used curl,
    // and the one way a password could still have reached the command line.
    const attempts = [
        ['webdav', 'url', 'https://alice:hunter2@cloud.example.com/remote.php/dav/'],
        ['webdav', 'url', '  https://alice:hunter2@cloud.example.com/dav  '],
        ['s3', 'endpoint', 'https://AKIA:secret@minio.lan:9000'],
        ['swift', 'auth', 'https://user:hunter2@auth.example.com/v3'],
        ['koofr', 'endpoint', 'https://a:hunter2@app.koofr.net'],
        ['sftp', 'host', 'alice:hunter2@nas.lan'],
        ['ftp', 'host', 'alice:hunter2@ftp.example.com'],
        ['smb', 'host', 'alice:hunter2@fileserver.lan']
    ];
    attempts.forEach(([id, key, value]) => {
        const p = Rclone.providerFor(id);
        const values = benignValues(p);
        values[key] = value;
        const problems = Rclone.validateFields(id, values);
        assert.ok(problems.length >= 1, id + '.' + key + ' accepted ' + value);
        assert.match(problems[0], /username and password/, id + '.' + key);
        // The refusal must not quote the value back — that is how a password
        // ends up in a screenshot of the error.
        problems.forEach((m) => assert.equal(m.includes('hunter2'), false, m));
        assertGeneric(() => Rclone.configCreateArgv('r', id, values));
    });
});

test('the URL rule does not fire on the URLs people legitimately type', () => {
    const fine = [
        ['webdav', 'url', 'https://cloud.example.com/remote.php/dav/files/alice/'],
        ['webdav', 'url', 'http://192.168.1.10:8080/dav'],
        ['s3', 'endpoint', 'https://minio.lan:9000'],
        ['s3', 'endpoint', 'https://s3.eu-central-1.amazonaws.com'],
        ['swift', 'auth', 'https://auth.example.com/v3'],
        ['sftp', 'host', 'nas.lan'],
        ['sftp', 'host', '[2001:db8::1]'],
        ['sftp', 'key_file', '/root/.ssh/id_ed25519'],
        ['koofr', 'user', 'alice@example.com'],
        ['mega', 'user', 'alice+backup@example.com'],
        ['webdav', 'url', 'https://host/path@v2'],
        ['webdav', 'url', 'https://user@cloud.example.com/dav']   // a name, not a secret
    ];
    fine.forEach(([id, key, value]) => {
        const values = benignValues(Rclone.providerFor(id));
        values[key] = value;
        assert.deepEqual(Rclone.validateFields(id, values), [], id + '.' + key + ' = ' + value);
    });
});

test('a password field may still hold anything that looks like a URL credential', () => {
    // The rule exists because the value would reach argv. A password never does,
    // so restricting it would only reject legitimate passwords.
    const out = Rclone.configCreateArgv('nc', 'webdav',
        { url: 'https://cloud.example/dav/', pass: 'https://a:b@c/' });
    assert.deepEqual(out.secrets, [{ key: 'pass', value: 'https://a:b@c/', obscure: true }]);
    assert.equal(out.argv.join(' ').includes('a:b@c'), false);
});

// --------------------------------------------- failures must not quote secrets

test('no failure path puts a secret in the error message or its detail', () => {
    const SECRET = 'CANARY-in-a-failing-form';
    let paths = 0;
    Rclone.providers().forEach((p) => {
        const secretFields = p.fields.filter((f) => f.type === 'password');
        if (!secretFields.length) return;

        // Every way this call is known to fail, each with a real secret loaded.
        const breakers = [
            ['bad name', (v) => Rclone.configCreateArgv('-bad:name', p.id, v)],
            ['long name', (v) => Rclone.configCreateArgv('n'.repeat(500), p.id, v)],
            ['newline in a secret', (v) => Rclone.configCreateArgv('r', p.id,
                Object.assign({}, v, { [secretFields[0].key]: SECRET + '\nteam_drive = evil' }))],
            ['NUL in a secret', (v) => Rclone.configCreateArgv('r', p.id,
                Object.assign({}, v, { [secretFields[0].key]: SECRET + '\0' }))],
            ['multi-line token', (v) => Rclone.configCreateArgv('r', p.id, v, SECRET + '\nevil = 1')],
            ['token where none is wanted', (v) => Rclone.configCreateArgv('r', p.id, v, SECRET)],
            ['credential in a URL', (v) => Rclone.configCreateArgv('r', p.id,
                Object.assign({}, v, Object.fromEntries(
                    p.fields.filter((f) => f.type === 'text')
                        .map((f) => [f.key, 'https://u:' + SECRET + '@h/']))))]
        ];

        breakers.forEach(([what, run]) => {
            const values = benignValues(p);
            secretFields.forEach((f) => { values[f.key] = SECRET; });
            try {
                run(values);
                return;         // this breaker does not apply to this provider
            } catch (e) {
                assert.ok(Errors.isHangarError(e), p.id + '/' + what + ' threw untyped: ' + e);
                assertNoCanary(e.message, p.id + '/' + what + ' message');
                assertNoCanary(dump(e.detail), p.id + '/' + what + ' detail');
                paths++;
            }
        });
    });
    assert.ok(paths > 20, 'only ' + paths + ' failure paths were exercised');
});

test('mergeConfigSection never quotes the value it is refusing', () => {
    [['token', 'CANARY\nevil = 1'], ['token', 'CANARY\0'], ['tok en', 'CANARY'],
        ['to-ken', 'CANARY'], ['token=', 'CANARY']]
        .forEach(([key, value]) => {
            try {
                Rclone.mergeConfigSection('[a]\n', 'a', [{ key: key, value: value }]);
                assert.fail('expected a throw for ' + key);
            } catch (e) {
                assert.ok(Errors.isHangarError(e));
                assertNoCanary(e.message, 'merge message');
                assertNoCanary(dump(e.detail), 'merge detail');
            }
        });
});

test('classifyRcloneError repeats only what rclone said, and types it', () => {
    // It is handed rclone's stderr, so it cannot invent — but it must not add a
    // command line either, which is the tempting thing to put in a detail.
    const e = Rclone.classifyRcloneError('Failed to create file system: dial tcp: i/o timeout',
        { command: 'rclone config create' });
    assert.equal(e.kind, Errors.KIND.NETWORK);
    assertNoCanary(e.message + dump(e.detail), 'classify');
    [null, undefined, '', 0, {}, [], Symbol('s'), Object.create(null)].forEach((v) => {
        const t = Rclone.classifyRcloneError(v);
        assert.ok(Errors.isHangarError(t), label(v));
        assert.ok(typeof t.message === 'string' && t.message !== '', label(v));
    });
});

// ------------------------------------------------------ validateRemoteName

test('no character in the BMP can smuggle a colon, a dash, a space or a control past the name rule', () => {
    // Exhaustive rather than representative: the two properties this guards are
    // "cannot become a second URL segment" and "cannot become a command flag",
    // and both are one accepted character away from being false.
    const exotic = ['😀', '：', '⁄', '﹕', '꞉', ' ', '　',
        '᠎', '​', '﻿', '‮', ' ', ' ', ' '];
    for (let c = 0; c < 0x3000; c++) exotic.push(String.fromCharCode(c));

    let accepted = 0;
    exotic.forEach((ch) => {
        [ch, ch + 'a', 'a' + ch, 'a' + ch + 'b'].forEach((name) => {
            if (Rclone.validateRemoteName(name).length) return;
            accepted++;
            assert.equal(name.includes(':'), false, 'accepted a colon: ' + JSON.stringify(name));
            assert.equal(name.charAt(0) === '-', false,
                'accepted a leading dash: ' + JSON.stringify(name));
            assert.equal(/[/\s]/.test(name), false, 'accepted a separator: ' + JSON.stringify(name));
            assert.equal(/\p{C}/u.test(name), false, 'accepted a control: ' + JSON.stringify(name));
        });
    });
    assert.ok(accepted > 1000, 'the sweep accepted almost nothing — is the rule broken?');
});

test('an accepted remote name survives a round trip through a repository URL', () => {
    // This is WHY the colon is banned: repos.js splits on the first one, so a
    // name containing a colon would silently become a name plus a path.
    ['gdrive', 'g', 'g-2', 'g.2', 'g+2', 'g_2', 'g@2', 'Ünïcödé', '9',
        'a'.repeat(64), '.', '..']
        .forEach((name) => {
            assert.deepEqual(Rclone.validateRemoteName(name), [], name);
            const url = HangarRepos.buildUrl({ kind: 'rclone', remote: name, prefix: 'backups/hangar' });
            assert.equal(url, 'rclone:' + name + ':backups/hangar', name);
            const back = HangarRepos.parseUrl(url);
            assert.equal(back.remote, name, name);
            assert.equal(back.prefix, 'backups/hangar', name);
        });
});

test('an accepted remote name can never be read as a command flag', () => {
    ['gdrive', 'g-2', '.', '..', '9', 'a'.repeat(64), 'Ünïcödé', '_x', '@x',
        '+x', '.x']
        .forEach((name) => {
            const argv = Rclone.configCreateArgv(name, 'drive', {}).argv;
            assert.equal(argv[3], name, name);
            assert.notEqual(argv[3].charAt(0), '-', name);
            assert.equal(argv[3].includes(':'), false, name);
            assert.equal(Rclone.configDeleteArgv(name)[3], name, name);
            assert.notEqual(Rclone.configDeleteArgv(name)[3].charAt(0), '-', name);
        });
});

test('validateRemoteName rejects every way of writing a leading dash', () => {
    ['-', '--', '-x', '---force', '-rf', '- x', '-́', '-😀', '-.', '-_']
        .forEach((n) => {
            const problems = Rclone.validateRemoteName(n);
            assert.ok(problems.length >= 1, JSON.stringify(n) + ' was accepted');
            assert.ok(problems.some((m) => m.includes('command option')),
                JSON.stringify(n) + ' -> ' + problems.join(' | '));
            assertGeneric(() => Rclone.configCreateArgv(n, 'drive', {}));
            assertGeneric(() => Rclone.configDeleteArgv(n));
        });
});

test('validateRemoteName rejects every way of writing a colon', () => {
    [':', 'a:', ':a', 'a:b', 'rclone:gdrive', 'gdrive:backups/hangar', 'a::b', 'drive:/']
        .forEach((n) => {
            assert.ok(Rclone.validateRemoteName(n).some((m) => m.includes('":"')),
                JSON.stringify(n) + ' was accepted');
            assertGeneric(() => Rclone.configCreateArgv(n, 'drive', {}));
        });
});

test('validateRemoteName is exact about its length boundary', () => {
    const n = Rclone.MAX_NAME_LEN;
    assert.deepEqual(Rclone.validateRemoteName('a'.repeat(n)), []);
    assert.equal(Rclone.validateRemoteName('a'.repeat(n + 1)).length, 1);
    assert.equal(Rclone.validateRemoteName('a'.repeat(100000)).length, 1);
    // Enormous and hostile at once: still one answer, still no throw.
    assert.ok(Rclone.validateRemoteName('-' + ':'.repeat(50000)).length >= 2);
});

test('validateRemoteName reports something for every rejection, and never a duplicate', () => {
    ['-a:b/c d\0e', ':::', '   ', '‮-evil:', '../../etc/passwd', 'a b:c']
        .forEach((n) => {
            const problems = Rclone.validateRemoteName(n);
            assert.ok(problems.length >= 1, JSON.stringify(n));
            assert.equal(new Set(problems).size, problems.length, 'duplicate message for ' + n);
            problems.forEach((m) => assert.equal(typeof m, 'string'));
        });
});

// ------------------------------------------------------ parseAuthorizeOutput

test('parseAuthorizeOutput never fuses two authorize runs into one token', () => {
    const A = '{"access_token":"AAAA111122223333","refresh_token":"BBBB"}';
    const B = '{"access_token":"CCCC555566667777","refresh_token":"DDDD"}';
    const M = 'Paste the following into your remote machine --->';
    // Both blocks complete: the first is the answer, never a concatenation.
    assert.equal(Rclone.parseAuthorizeOutput([M, A, '<---End paste', M, B, '<---End paste'].join('\n')), A);
    // The first block lost its end marker to the copy — still not a fusion.
    assert.equal(Rclone.parseAuthorizeOutput([M, A, M, B, '<---End paste'].join('\n')), A);
    // Duplicated markers with nothing between them is not half a token.
    assert.equal(Rclone.parseAuthorizeOutput([M, M, A, '<---End paste'].join('\n')), null);
});

test('parseAuthorizeOutput strips an end marker the terminal wrapped onto the token line', () => {
    const A = '{"access_token":"AAAA111122223333","refresh_token":"BBBB"}';
    assert.equal(Rclone.parseAuthorizeOutput('Paste the following into your remote machine --->\n' +
        A + '<---End paste'), A);
    assert.equal(Rclone.parseAuthorizeOutput('Paste the following into your remote machine ---> ' +
        A + '<---End paste'), A);
    assert.equal(Rclone.parseAuthorizeOutput('Paste the following into your remote machine --->\n' +
        A + ' <--- End paste'), A);
});

test('parseAuthorizeOutput survives a paste of the whole terminal scrollback', () => {
    const scrollback = [
        'Last login: Fri Aug  1 20:00:00 2026 from 192.168.1.5',
        'user@laptop:~$ which rclone',
        '/usr/bin/rclone',
        'user@laptop:~$ rclone authorize "drive"',
        '2026/08/01 20:14:01 NOTICE: Config file not found - using defaults',
        'If your browser doesn\'t open automatically go to the following link:',
        '  http://127.0.0.1:53682/auth?state=Kx9-abc_DEF',
        'Log in and authorize rclone for access',
        'Waiting for code...',
        'Got code',
        'Paste the following into your remote machine --->',
        TOKEN_JSON,
        '<---End paste',
        'user@laptop:~$ ',
        'user@laptop:~$ exit',
        'logout'
    ].join('\r\n');
    assert.equal(Rclone.parseAuthorizeOutput(scrollback), TOKEN_JSON);
});

test('parseAuthorizeOutput refuses a paste that is only markers, noise or an empty block', () => {
    const M = 'Paste the following into your remote machine --->';
    [M, '<---End paste', M + '\n<---End paste', M + '\n   \n\t\n<---End paste',
        M + '\n<---End paste\n' + M + '\n<---End paste',
        'Waiting for code...', 'Got code', 'user@laptop:~$ rclone authorize "drive"',
        'If your browser doesn\'t open automatically go to the following link:',
        'http://127.0.0.1:53682/auth?state=Kx9abcDEF', 'no', '{}', '{"foo":"bar"}',
        '   \n\n\t\t\n   ', '----', '>>>', '\0\0\0']
        .forEach((s) => assert.equal(Rclone.parseAuthorizeOutput(s), null, JSON.stringify(s)));
});

test('a paste the parser accepts is always a paste the token check accepts too', () => {
    // The two are used together — extract, then judge — and a value that passes
    // one but not the other is a confusing error message at best.
    const M = 'Paste the following into your remote machine --->';
    [TOKEN_JSON, M + '\n' + TOKEN_JSON + '\n<---End paste',
        'eyJhbGciOiJIUzI1NiJ9.FAKE.OPAQUE-TOKEN_0123456789',
        'noise\n' + TOKEN_JSON + '\nmore noise']
        .forEach((s) => {
            const t = Rclone.parseAuthorizeOutput(s);
            assert.ok(t !== null, JSON.stringify(s));
            assert.equal(Rclone.looksLikeToken(t), true, JSON.stringify(s));
        });
});

test('parseAuthorizeOutput never returns a token containing a line break or a NUL', () => {
    // Whatever it returns is about to be written into an INI file as one line.
    const M = 'Paste the following into your remote machine --->';
    [M + '\n' + TOKEN_JSON + '\n<---End paste', TOKEN_JSON,
        M + '\r\n' + TOKEN_JSON + '\r\n<---End paste', 'x\n' + TOKEN_JSON,
        M + '\n' + TOKEN_JSON.slice(0, 30) + '\n' + TOKEN_JSON.slice(30) + '\n<---End paste']
        .forEach((s) => {
            const t = Rclone.parseAuthorizeOutput(s);
            if (t === null) return;
            assert.equal(/[\r\n\0]/.test(t), false, JSON.stringify(s) + ' -> ' + JSON.stringify(t));
            // …and therefore it is always something configCreateArgv will accept.
            assert.equal(Rclone.configCreateArgv('g', 'drive', {}, t).secrets[0].key, 'token');
        });
});

test('parseAuthorizeOutput and looksLikeToken are total on enormous and malformed input', () => {
    const huge = 'Paste the following into your remote machine --->\n' +
        ('x'.repeat(1000) + '\n').repeat(500) + '<---End paste';
    assert.ok(Rclone.parseAuthorizeOutput(huge) === null || typeof Rclone.parseAuthorizeOutput(huge) === 'string');
    ['{'.repeat(5000), '}'.repeat(5000), '{"access_token":' + '['.repeat(2000),
        '\ud800', 'a\udc00b', '‮'.repeat(100)]
        .forEach((s) => {
            const t = Rclone.parseAuthorizeOutput(s);
            assert.ok(t === null || typeof t === 'string', JSON.stringify(s));
            assert.equal(typeof Rclone.looksLikeToken(s), 'boolean', JSON.stringify(s));
        });
});

// -------------------------------------------------------- mergeConfigSection

test('mergeConfigSection writes a repeated key once, taking the last value', () => {
    // The rewrite path already took the last value; the append path used to write
    // BOTH, and rclone reads the first — so the value hangar was asked to store
    // would not be the one in force.
    const out = Rclone.mergeConfigSection('[a]\ntype = drive\n', 'a',
        [{ key: 'token', value: 'FIRST' }, { key: 'token', value: 'LAST' }]);
    assert.equal(out, '[a]\ntype = drive\ntoken = LAST\n');
    assert.equal((out.match(/^token = /gm) || []).length, 1);

    const fresh = Rclone.mergeConfigSection('', 'a',
        [{ key: 'pass', value: '1' }, { key: 'token', value: 'T' }, { key: 'pass', value: '2' }]);
    assert.equal(fresh, '[a]\npass = 2\ntoken = T\n');
});

test('mergeConfigSection does not lose a key called __proto__', () => {
    // An rclone config key is [A-Za-z0-9_]+ — and so is __proto__, which on a
    // plain object reads back as Object.prototype and looks already written.
    assert.equal(Rclone.mergeConfigSection('[a]\n', 'a', [{ key: '__proto__', value: 'x' }]),
        '[a]\n__proto__ = x\n');
    assert.equal(Rclone.mergeConfigSection('[a]\nconstructor = 1\n', 'a',
        [{ key: 'constructor', value: '2' }]), '[a]\nconstructor = 2\n');
});

test('mergeConfigSection keeps every other remote byte-identical, whatever the file looks like', () => {
    const bodies = ['', '\n', '\n\n\n', '# c\n', '[a]\n', '[a]\ntype = x\n',
        '[a]\ntype = x\n\n[b]\ny = 1\n', '[a]\n\n\n[b]\n', '[b]\ny=1\n[a]\ntoken = old\nz = 2\n',
        '[a]\ntoken = old\ntoken = older\n', '[a]\r\ntype = x\r\n', '[a]\ntype = x',
        '  [a]  \n  type = x  \n', '[a]\n[a]\ntype=y\n', '[]\nx = 1\n[a]\n',
        '[a b]\nx=1\n[a]\ny=2\n', '# [a]\n[b]\nq=1\n', '[a]\n;comment\ntype = x\n'];
    const names = ['a', 'b', 'new', 'a.b', 'a-b', 'a+b', 'a@b'];
    const pairs = [{ key: 'token', value: 'T' }, { key: 'pass', value: 'P' }];

    function sections(text) {
        const out = {};
        let cur = null;
        text.split('\n').forEach((l) => {
            const h = /^\s*\[([^\]]*)\]\s*$/.exec(l);
            if (h) { cur = h[1]; out[cur] = out[cur] || {}; return; }
            const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(l);
            if (m && cur !== null) out[cur][m[1]] = m[2];
        });
        return out;
    }

    bodies.forEach((body) => names.forEach((name) => {
        const out = Rclone.mergeConfigSection(body, name, pairs);
        const after = sections(out);
        const before = sections(body);

        pairs.forEach((p) => assert.equal(after[name][p.key], p.value,
            JSON.stringify(body) + ' / ' + name + ' lost ' + p.key));
        Object.keys(before).forEach((sec) => {
            if (sec === name) return;
            Object.keys(before[sec]).forEach((k) => assert.equal(after[sec][k], before[sec][k],
                JSON.stringify(body) + ' clobbered [' + sec + '] ' + k));
        });
        // Shape: LF only, exactly one trailing newline, and idempotent.
        assert.equal(/\r/.test(out), false, JSON.stringify(out));
        assert.match(out, /[^\n]\n$/);
        assert.equal(Rclone.mergeConfigSection(out, name, pairs), out,
            'not idempotent: ' + JSON.stringify(out));
    }));
});

test('mergeConfigSection takes every name validateRemoteName accepts, and no other', () => {
    ['', 'a[b', 'a]b', 'a\nb', 'a\0b', '\r'].forEach((n) => {
        assertGeneric(() => Rclone.mergeConfigSection('[x]\n', n, [{ key: 'token', value: 'T' }]));
    });
    ['g', 'g-2', 'g.2', 'g+2', 'g_2', 'g@2', '..'].forEach((n) => {
        assert.deepEqual(Rclone.validateRemoteName(n), [], n);
        const out = Rclone.mergeConfigSection('', n, [{ key: 'token', value: 'T' }]);
        assert.equal(out, '[' + n + ']\ntoken = T\n', n);
    });
});

// ------------------------------------------------------------- totality

test('every pure function answers rather than throws, whatever it is handed', () => {
    const hostile = [null, undefined, '', '   ', 0, -1, NaN, Infinity, true, false, {}, [],
        Symbol('s'), () => {}, Object.create(null), 1n, new Date(), /re/, new Map(), new Set(),
        'a'.repeat(100000), '\0', '\r\n', '../../etc/passwd', '$(id)', '-x', 'a:b',
        '😀', '‮',
        { toString() { throw new Error('boom'); } },
        new Proxy({}, { get() { throw new Error('trap'); },
            getOwnPropertyDescriptor() { throw new Error('trap'); } })];

    function total(name, fn, args) {
        try {
            fn.apply(null, args);
        } catch (e) {
            assert.ok(Errors.isHangarError(e),
                name + ' threw an untyped ' + (e && e.name) + ': ' + (e && e.message));
        }
    }

    hostile.forEach((h) => {
        ['providerFor', 'isOAuth', 'isSecretField', 'describeProvider', 'validateRemoteName',
            'configDeleteArgv', 'authorizeCommand', 'parseAuthorizeOutput', 'looksLikeToken',
            'parseConfigFilePath'].forEach((fn) => total(fn, Rclone[fn], [h]));

        ['drive', 'webdav', 's3', 'nope', null, '__proto__'].forEach((pid) => {
            total('fieldFor', Rclone.fieldFor, [pid, h]);
            total('validateFields', Rclone.validateFields, [pid, h]);
            total('configCreateArgv', Rclone.configCreateArgv, ['r', pid, h]);
            total('configCreateArgv+token', Rclone.configCreateArgv, ['r', pid, {}, h]);
            total('configCreateArgv+name', Rclone.configCreateArgv, [h, pid, {}]);
            total('classifyRcloneError', Rclone.classifyRcloneError, [h, pid]);
        });

        total('mergeConfigSection', Rclone.mergeConfigSection, [h, 'a', [{ key: 'token', value: 'T' }]]);
        total('mergeConfigSection', Rclone.mergeConfigSection, ['[a]\n', 'a', h]);
        total('mergeConfigSection', Rclone.mergeConfigSection, ['[a]\n', 'a', [h]]);
        total('mergeConfigSection', Rclone.mergeConfigSection, ['[a]\n', 'a', [{ key: h, value: h }]]);
    });

    // These two must ANSWER, not throw: a form calls them on every keystroke.
    hostile.forEach((h) => {
        assert.ok(Array.isArray(Rclone.validateRemoteName(h)), label(h));
        assert.ok(Array.isArray(Rclone.validateFields('webdav', h)), label(h));
    });
});

test('a values object with a poisoned prototype contributes nothing', () => {
    const poisoned = JSON.parse('{"__proto__":{"pass":"CANARY-inherited","url":"CANARY-inherited"}}');
    assert.deepEqual(Rclone.validateFields('webdav', poisoned).filter((m) => m.includes('CANARY')), []);
    const out = Rclone.configCreateArgv('r', 'webdav', Object.assign({ url: 'https://x/' }, poisoned));
    assertNoCanary(out.argv.join(' '), 'argv');
    assertNoCanary(dump(out.secrets), 'secrets');

    // The same through the prototype chain rather than an own key.
    function Hostile() {}
    Hostile.prototype.pass = 'CANARY-prototype';
    Hostile.prototype.url = 'CANARY-prototype';
    const inherited = new Hostile();
    inherited.url = 'https://x/';
    assertNoCanary(dump(Rclone.configCreateArgv('r', 'webdav', inherited)), 'inherited values');
});

test('a field value with a throwing getter is treated as absent, not as a crash', () => {
    const values = { url: 'https://x/' };
    Object.defineProperty(values, 'pass', { get() { throw new Error('boom'); }, enumerable: true });
    assert.ok(Array.isArray(Rclone.validateFields('webdav', values)));
    const out = Rclone.configCreateArgv('r', 'webdav', values);
    assert.deepEqual(out.secrets, []);
    assert.ok(out.argv.includes('url=https://x/'));
});

// ------------------------------------------------------------- impure edges

test('createRemote never spawns and never leaks when a secret-bearing form is invalid', async () => {
    const values = { url: 'https://x/\ntoken = evil', pass: 'CANARY-never-spawned' };
    await Rclone.createRemote('nc', 'webdav', values, '').then(
        () => assert.fail('expected a rejection'),
        (e) => {
            assert.ok(Errors.isHangarError(e));
            assertNoCanary(e.message, 'createRemote message');
            assertNoCanary(dump(e.detail), 'createRemote detail');
        });
});

test('createRemote and deleteRemote reject, never throw, for every hostile argument', async () => {
    const cases = [[null, null, null, null], ['-x', 'drive', {}, ''], ['r', 'nope', {}, ''],
        ['r', 'drive', { client_secret: 'CANARY' }, 'tok\nevil'], [{}, [], Symbol('s'), 0]];
    for (const args of cases) {
        let p;
        assert.doesNotThrow(() => { p = Rclone.createRemote.apply(null, args); });
        await p.then(() => assert.fail('expected a rejection'), (e) => {
            assert.ok(Errors.isHangarError(e), 'untyped rejection: ' + e);
            assertNoCanary(e.message + dump(e.detail), 'createRemote');
        });
        let d;
        assert.doesNotThrow(() => { d = Rclone.deleteRemote(args[0]); });
        await d.then(() => assert.fail('expected a rejection'), (e) => {
            assert.ok(Errors.isHangarError(e), 'untyped rejection: ' + e);
        });
    }
});

test('the module keeps its own promise: stdin is the only channel a secret leaves by', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'core', 'rclone.js'), 'utf8');
    // `rclone obscure -` is the documented stdin form. If the hyphen were ever
    // dropped, the password would become argv[2].
    assert.deepEqual(Rclone.obscureArgv(), ['rclone', 'obscure', '-']);
    // A secret is passed to run() as `input`, never spliced into an argv array.
    assert.match(src, /run\(obscureArgv\(\),\s*s\.value\)/);
    assert.equal(/argv\.push\([^)]*secret/i.test(src), false, 'a secret is pushed into argv');
    // …and never into an error detail alongside the command that failed.
    assert.equal(/detail[^\n]*s\.value/.test(src), false);
});
