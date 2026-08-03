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
        'isAuthExpired', 'remoteNameFromRepoUrl', 'reconnectCommand', 'remoteTypeFromConfig',
        'providerForType', 'providerOfRemote', 'updateRemoteToken',
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

// ==================================================== authorisation expiry
//
// A cloud destination stops working long after anyone was looking at it: Box
// expires a refresh token after 60 days of INACTIVITY, Google revokes one, a
// tenant policy retires another. The backup then fails at 03:00 inside a systemd
// unit, and the only evidence is a line of text.
//
// Every string below is one rclone or the provider really produces, written here
// by hand from the wording rclone and the OAuth error registry use; none is a
// captured fixture, which is why there is no file for them.
//
// The false-positive half of this matrix is the more important half. A wrong
// "your login expired" sends someone through a re-authorisation that was never
// the problem AND hides the real cause, so an ordinary permission denial, a
// quota refusal, a network timeout and a wrong password must all read as "no".

// ------------------------------------------------------ isAuthExpired: yes

test('isAuthExpired: rclone\'s own "couldn\'t fetch token" line', () => {
    assert.equal(Rclone.isAuthExpired(
        'couldn\'t fetch token - maybe it has expired? - refresh with "rclone config reconnect gdrive:"'), true);
    // The apostrophe a terminal, a JSON encoder or a copy-paste may have changed.
    assert.equal(Rclone.isAuthExpired('couldn’t fetch token - maybe it has expired?'), true);
    assert.equal(Rclone.isAuthExpired('couldnt fetch token'), true);
});

test('isAuthExpired: rclone naming its own remedy is decisive on its own', () => {
    // rclone prints this when it knows the remote has to be re-authorised, and
    // nothing else in its output says "config reconnect".
    assert.equal(Rclone.isAuthExpired('refresh with "rclone config reconnect box:"'), true);
});

test('isAuthExpired: oauth2 token expired with no refresh token', () => {
    assert.equal(Rclone.isAuthExpired('oauth2: token expired and refresh token is not set'), true);
});

test('isAuthExpired: invalid_grant, the OAuth code for a dead refresh token', () => {
    assert.equal(Rclone.isAuthExpired(
        'Failed to copy: failed to authorise: oauth2: cannot fetch token: 400 Bad Request\n' +
        'Response: {"error":"invalid_grant"}'), true);
});

test('isAuthExpired: Google — "Token has been expired or revoked"', () => {
    assert.equal(Rclone.isAuthExpired(
        '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}'), true);
    // …and without the invalid_grant beside it, which some responses omit.
    assert.equal(Rclone.isAuthExpired('Token has been expired or revoked.'), true);
});

test('isAuthExpired: OneDrive — AADSTS700082, the refresh token expired', () => {
    assert.equal(Rclone.isAuthExpired(
        'Error "invalid_grant" (): AADSTS700082: The refresh token has expired due to inactivity.'), true);
    assert.equal(Rclone.isAuthExpired('The refresh token has expired due to inactivity.'), true);
});

test('isAuthExpired: Box — "Refresh token has expired" after 60 days of inactivity', () => {
    // The case a purely reactive design serves worst: nobody wrote to the
    // repository, so nothing failed, so nobody looked — and the token died of
    // the silence itself.
    assert.equal(Rclone.isAuthExpired('Refresh token has expired'), true);
    assert.equal(Rclone.isAuthExpired(
        'HTTP 400: {"error":"invalid_grant","error_description":"Refresh token has expired"}'), true);
});

test('isAuthExpired: Dropbox — expired_access_token, where underscores hide the words', () => {
    // "_" is a word character, so \btoken\b does not match inside
    // "expired_access_token". Missing this would miss Dropbox entirely.
    assert.equal(Rclone.isAuthExpired(
        '{"error_summary":"expired_access_token/...","error":{".tag":"expired_access_token"}}'), true);
    assert.equal(Rclone.isAuthExpired('expired_access_token'), true);
});

test('isAuthExpired: the plainest forms — "token expired", "token was revoked"', () => {
    const yes = [
        'token expired',
        'the access token expired',
        'access token has expired',
        'token has been revoked by the user',
        'oauth2: cannot fetch token: token expired',
        'ERROR : : error reading source: expired token'
    ];
    yes.forEach((t) => assert.equal(Rclone.isAuthExpired(t), true, 'missed: ' + t));
});

test('isAuthExpired: an ambiguous status code counts once a token signal stands beside it', () => {
    const yes = [
        // Google's real 401 body, which names the credential explicitly.
        'googleapi: Error 401: Request had invalid authentication credentials. ' +
            'Expected OAuth 2 access token, login cookie or other valid authentication credential., unauthorized',
        '401 Unauthorized: the bearer token is no longer accepted',
        '403 Forbidden: token rejected'
    ];
    yes.forEach((t) => assert.equal(Rclone.isAuthExpired(t), true, 'missed: ' + t));
});

test('isAuthExpired: case and CRLF do not change the answer', () => {
    assert.equal(Rclone.isAuthExpired('INVALID_GRANT'), true);
    assert.equal(Rclone.isAuthExpired('TOKEN HAS BEEN EXPIRED OR REVOKED'), true);
    assert.equal(Rclone.isAuthExpired('noise\r\ncouldn\'t fetch token\r\nmore noise'), true);
});

test('isAuthExpired: finds the one expiry line inside a long restic stderr blob', () => {
    // What actually arrives from a scheduled run: restic's own noise, the rclone
    // subprocess's line somewhere in the middle, and a JSON exit_error at the end.
    const blob = [
        'using parent snapshot 4f2a1b3c',
        'Files:           0 new,     0 changed,  1204 unmodified',
        '2026/07/31 03:00:12 ERROR : backups/db: Failed to copy: failed to open source object: ' +
            'couldn\'t fetch token - maybe it has expired? - refresh with "rclone config reconnect gdrive:"',
        'Fatal: unable to save snapshot: Save(<data/0a1b2c>) returned error',
        '{"message_type":"exit_error","code":1,"message":"backup failed"}'
    ].join('\n');
    assert.equal(Rclone.isAuthExpired(blob), true);
});

// ------------------------------------------------------- isAuthExpired: no

test('isAuthExpired: a bare 401 is NOT expiry', () => {
    // The rule the whole design turns on. A 401 with nothing beside it is just as
    // likely to be a revoked share, a wrong account or a tenant policy.
    assert.equal(Rclone.isAuthExpired('401 Unauthorized'), false);
    assert.equal(Rclone.isAuthExpired('HTTP/1.1 401 Unauthorized'), false);
    assert.equal(Rclone.isAuthExpired('Failed to copy: 401 Unauthorized'), false);
});

test('isAuthExpired: a bare 403 is NOT expiry', () => {
    assert.equal(Rclone.isAuthExpired('403 Forbidden'), false);
    assert.equal(Rclone.isAuthExpired('Failed to list: 403 Forbidden'), false);
});

test('isAuthExpired: ordinary permission denials are NOT expiry', () => {
    const no = [
        '403 Forbidden: The user does not have permission to access this folder',
        'error listing: permission denied',
        'access denied for this bucket',
        'Failed to mkdir: 403 Forbidden: insufficientPermissions',
        'AccessDenied: Access Denied, status code: 403',
        'unauthorized: the account is not a member of this team'
    ];
    no.forEach((t) => assert.equal(Rclone.isAuthExpired(t), false, 'false positive: ' + t));
});

test('isAuthExpired: quota and rate-limit refusals are NOT expiry', () => {
    // Same status code, completely different remediation. Offering a
    // re-authorisation here would send the user round a loop that cannot help.
    const no = [
        '403: User Rate Limit Exceeded, userRateLimitExceeded',
        '403 Forbidden: quotaExceeded — the account is out of storage',
        'Failed to copy: 403 storageQuotaExceeded',
        'insufficient storage: 507',
        '429 Too Many Requests: rateLimitExceeded'
    ];
    no.forEach((t) => assert.equal(Rclone.isAuthExpired(t), false, 'false positive: ' + t));
});

test('isAuthExpired: network failures are NOT expiry', () => {
    const no = [
        'Get "https://www.googleapis.com/drive/v3/files": dial tcp 142.250.0.1:443: i/o timeout',
        'connection refused',
        'no such host',
        'network is unreachable',
        'TLS handshake timeout',
        'temporary failure in name resolution',
        'context deadline exceeded (Client.Timeout exceeded while awaiting headers)'
    ];
    no.forEach((t) => assert.equal(Rclone.isAuthExpired(t), false, 'false positive: ' + t));
});

test('isAuthExpired: a wrong repository password is NOT expiry', () => {
    // restic's own wording. Its remediation is 'reprompt', and confusing the two
    // would send the user to re-authorise a destination that answered perfectly.
    const no = [
        'Fatal: wrong password or no key found',
        'wrong password',
        '{"message_type":"exit_error","code":12,"message":"wrong password or no key found"}'
    ];
    no.forEach((t) => assert.equal(Rclone.isAuthExpired(t), false, 'false positive: ' + t));
});

test('isAuthExpired: full disks, missing repositories and locks are NOT expiry', () => {
    const no = [
        'write /srv/repo/data/ab/0123: no space left on device',
        'Disk quota exceeded',
        'Fatal: unable to open config file: Stat: stat /srv/repo/config: no such file or directory. ' +
            'Is there a repository at the following location?',
        'repository is already locked exclusively by PID 4213 on nas',
        'panic: runtime error: invalid memory address'
    ];
    no.forEach((t) => assert.equal(Rclone.isAuthExpired(t), false, 'false positive: ' + t));
});

test('isAuthExpired: a token signal on a DISTANT line does not license a 403', () => {
    // The reason pairing is per line. These two facts are unrelated: the 403 is a
    // quota refusal, and the token line is rclone saying which credential it used.
    const blob = [
        '2026/07/31 03:00:01 ERROR : db.sql: Failed to copy: 403 Forbidden: storageQuotaExceeded',
        'transferred: 0 / 0 Bytes',
        'elapsed time: 1.2s',
        'NOTICE: using token from the config file'
    ].join('\n');
    assert.equal(Rclone.isAuthExpired(blob), false);
});

test('isAuthExpired: the word "token" alone, with no failure beside it, is NOT expiry', () => {
    const no = [
        'NOTICE: using token from the config file',
        'saving token to rclone.conf',
        'oauth token refreshed',
        'Bearer authentication configured'
    ];
    no.forEach((t) => assert.equal(Rclone.isAuthExpired(t), false, 'false positive: ' + t));
});

test('isAuthExpired: empty and hostile input answer false, never throw', () => {
    const hostile = [null, undefined, '', '   ', 0, false, true, [], {}, Symbol('s'),
        Object.create(null), { toString() { throw new Error('nope'); } }, () => {}];
    hostile.forEach((v) => {
        let out;
        assert.doesNotThrow(() => { out = Rclone.isAuthExpired(v); }, 'threw on ' + dump(v));
        assert.equal(out, false, 'true for ' + dump(v));
    });
});

test('isAuthExpired: the answer is stable when asked repeatedly', () => {
    // A stateful (/g) regex would answer differently on the second call, and this
    // function is asked once per failed run for as long as the session lives.
    const yes = 'invalid_grant: Token has been expired or revoked.';
    const no = '403 Forbidden: quotaExceeded';
    for (let i = 0; i < 5; i++) {
        assert.equal(Rclone.isAuthExpired(yes), true, 'call ' + i);
        assert.equal(Rclone.isAuthExpired(no), false, 'call ' + i);
    }
});

// ------------------------------------------------- remoteNameFromRepoUrl

test('remoteNameFromRepoUrl: the remote out of a repository URL', () => {
    assert.equal(Rclone.remoteNameFromRepoUrl('rclone:gdrive:backups/x'), 'gdrive');
    assert.equal(Rclone.remoteNameFromRepoUrl('rclone:box:'), 'box');
    // hangar itself builds this shape when the repository has no prefix.
    assert.equal(Rclone.remoteNameFromRepoUrl('rclone:wasabi'), 'wasabi');
    assert.equal(Rclone.remoteNameFromRepoUrl('  rclone:gdrive:a/b  '), 'gdrive');
});

test('remoteNameFromRepoUrl: names with the punctuation rclone allows', () => {
    assert.equal(Rclone.remoteNameFromRepoUrl('rclone:s3-cold:bucket/path'), 's3-cold');
    assert.equal(Rclone.remoteNameFromRepoUrl('rclone:my_drive.2+work@home:p'), 'my_drive.2+work@home');
    assert.equal(Rclone.remoteNameFromRepoUrl('rclone:yedek:arşiv/veri'), 'yedek');
});

test('remoteNameFromRepoUrl: every other backend answers null', () => {
    ['/srv/backup', 'sftp:bak@nas.lan:/vol/b', 'rest:https://rest.lan:8000/',
        's3:s3.eu-west-1.amazonaws.com/buck', 'b2:buck:p', 'azure:cont:p', 'gs:buck:p',
        'rclone', 'rclone:', 'rclone::path', 'clone:x:y', 'xrclone:g:p', '']
        .forEach((u) => assert.equal(Rclone.remoteNameFromRepoUrl(u), null, 'not null for ' + u));
});

test('remoteNameFromRepoUrl: a path we misread is not a remote', () => {
    // Anything failing the rule the name was created under is refused rather than
    // guessed at — a wrong name builds a reconnect command that means something
    // else, and a reauthorise flow aimed at the wrong remote.
    ['rclone:/srv/backup', 'rclone:a b:c', 'rclone:-x:p', 'rclone:a/b:c']
        .forEach((u) => assert.equal(Rclone.remoteNameFromRepoUrl(u), null, 'not null for ' + u));
});

test('remoteNameFromRepoUrl: hostile input answers null and never throws', () => {
    [null, undefined, 0, false, [], {}, Symbol('s'), Object.create(null),
        { toString() { throw new Error('no'); } }]
        .forEach((v) => {
            let out;
            assert.doesNotThrow(() => { out = Rclone.remoteNameFromRepoUrl(v); }, dump(v));
            assert.equal(out, null, dump(v));
        });
});

test('remoteNameFromRepoUrl: a control character never survives into a name', () => {
    assert.equal(Rclone.remoteNameFromRepoUrl('rclone:gd\nrive:p'), null);
    assert.equal(Rclone.remoteNameFromRepoUrl('rclone:gd rive:p'), null);
});

// ---------------------------------------------------- reconnectCommand

test('reconnectCommand: the command rclone documents, with its trailing colon', () => {
    // Shown for the record only. hangar cannot run it: it re-enters the
    // interactive OAuth flow, asks questions on stdin nobody can answer, and
    // binds 127.0.0.1 on the server rather than on the user's own machine.
    assert.equal(Rclone.reconnectCommand('gdrive'), 'rclone config reconnect gdrive:');
    assert.equal(Rclone.reconnectCommand('  box  '), 'rclone config reconnect box:');
    assert.equal(Rclone.reconnectCommand('s3-cold'), 'rclone config reconnect s3-cold:');
});

test('reconnectCommand: an unusable name yields no command at all', () => {
    // A broken command that gets pasted is worse than no command: it either fails
    // or means something else entirely.
    ['', '   ', '-x', 'a:b', 'a/b', 'a b', 'a\nb', 'x'.repeat(Rclone.MAX_NAME_LEN + 1)]
        .forEach((n) => assert.equal(Rclone.reconnectCommand(n), null, 'command for ' + JSON.stringify(n)));
});

test('reconnectCommand: hostile input answers null and never throws', () => {
    [null, undefined, [], {}, Symbol('s'), Object.create(null),
        { toString() { throw new Error('no'); } }]
        .forEach((v) => {
            let out;
            assert.doesNotThrow(() => { out = Rclone.reconnectCommand(v); }, dump(v));
            assert.equal(out, null, dump(v));
        });
    // 0 and false coerce to "0" and "false", which ARE legal rclone remote names.
    // The module's coercion boundary is deliberate and shared by every function
    // here; pretending those are unusable would be a different rule for this one.
    assert.equal(Rclone.reconnectCommand(0), 'rclone config reconnect 0:');
});

test('reconnectCommand: the command hangar shows is never one hangar runs', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'core', 'rclone.js'), 'utf8');
    // No argv anywhere contains 'reconnect'. If that ever changes, hangar has
    // started a command whose prompts it cannot answer, and the run will hang.
    assert.equal(/\[\s*'rclone'\s*,\s*'config'\s*,\s*'reconnect'/.test(src), false);
});

// ------------------------------------------------- remoteTypeFromConfig

const CONFIG_SAMPLE = [
    '# hand-written by the admin, and it stays that way',
    '[local-nas]',
    'type = sftp',
    'host = nas.lan',
    '',
    '[gdrive]',
    'type = drive',
    'client_id = 123-abc.apps.googleusercontent.com',
    'scope = drive',
    'token = {"access_token":"OLD","refresh_token":"OLDR","expiry":"2020-01-01T00:00:00Z"}',
    '',
    '[jc]',
    'type = jottacloud',
    '',
    '[no-type]',
    'host = mystery.lan'
].join('\n');

test('remoteTypeFromConfig: reads the type of the section it was asked about', () => {
    assert.equal(Rclone.remoteTypeFromConfig(CONFIG_SAMPLE, 'gdrive'), 'drive');
    assert.equal(Rclone.remoteTypeFromConfig(CONFIG_SAMPLE, 'local-nas'), 'sftp');
    assert.equal(Rclone.remoteTypeFromConfig(CONFIG_SAMPLE, 'jc'), 'jottacloud');
});

test('remoteTypeFromConfig: a section with no type does not borrow the next one\'s', () => {
    // Reading on would report "the mystery host is a drive", and the UI would
    // offer a Google sign-in to recover an SFTP box.
    assert.equal(Rclone.remoteTypeFromConfig(CONFIG_SAMPLE, 'no-type'), null);
    assert.equal(Rclone.remoteTypeFromConfig('[a]\nhost = x\n\n[b]\ntype = drive\n', 'a'), null);
});

test('remoteTypeFromConfig: an absent remote is null, not a guess', () => {
    assert.equal(Rclone.remoteTypeFromConfig(CONFIG_SAMPLE, 'nonesuch'), null);
    assert.equal(Rclone.remoteTypeFromConfig('', 'gdrive'), null);
    assert.equal(Rclone.remoteTypeFromConfig(CONFIG_SAMPLE, ''), null);
});

test('remoteTypeFromConfig: matching is exact — case and spelling included', () => {
    assert.equal(Rclone.remoteTypeFromConfig(CONFIG_SAMPLE, 'GDrive'), null);
    assert.equal(Rclone.remoteTypeFromConfig(CONFIG_SAMPLE, 'gdriv'), null);
    assert.equal(Rclone.remoteTypeFromConfig(CONFIG_SAMPLE, ' gdrive'), null);
});

test('remoteTypeFromConfig: tolerates CRLF, spacing and a leading blank file', () => {
    assert.equal(Rclone.remoteTypeFromConfig('[a]\r\ntype = drive\r\n', 'a'), 'drive');
    assert.equal(Rclone.remoteTypeFromConfig('  [a]  \n   type=box   \n', 'a'), 'box');
    assert.equal(Rclone.remoteTypeFromConfig('\n\n[a]\ntype = b2\n', 'a'), 'b2');
    // An empty value is nothing, not the empty string.
    assert.equal(Rclone.remoteTypeFromConfig('[a]\ntype = \n', 'a'), null);
});

test('remoteTypeFromConfig: never returns another key\'s value', () => {
    const text = '[a]\nsubtype = drive\nmytype = box\ntype = onedrive\n';
    assert.equal(Rclone.remoteTypeFromConfig(text, 'a'), 'onedrive');
});

test('remoteTypeFromConfig: hostile input answers null and never throws', () => {
    [null, undefined, 0, [], {}, Symbol('s'), Object.create(null)].forEach((v) => {
        let out;
        assert.doesNotThrow(() => { out = Rclone.remoteTypeFromConfig(v, 'a'); }, dump(v));
        assert.equal(out, null);
        assert.doesNotThrow(() => { out = Rclone.remoteTypeFromConfig(CONFIG_SAMPLE, v); }, dump(v));
        assert.equal(out, null);
    });
});

// ------------------------------------------------------- providerForType

test('providerForType: rclone\'s backend name maps back to hangar\'s provider', () => {
    assert.equal(Rclone.providerForType('drive').id, 'drive');
    assert.equal(Rclone.providerForType('drive').label, 'Google Drive');
    assert.equal(Rclone.providerForType('onedrive').id, 'onedrive');
    assert.equal(Rclone.providerForType('webdav').id, 'webdav');
});

test('providerForType: every provider in the table is reachable from its own type', () => {
    // Guards the direction that rots: a provider added with a type nothing maps
    // back from would show no authorize command when its token expired.
    Rclone.providers().forEach((p) => {
        assert.equal(Rclone.providerForType(p.type), p, 'unreachable type: ' + p.type);
    });
});

test('providerForType: a backend hangar has no entry for is null, not a default', () => {
    ['', '   ', 'crypt', 'union', 'chunker', 'alias', 'unknown-backend', 'DRIVE', 'drive.file']
        .forEach((t) => assert.equal(Rclone.providerForType(t), null, 'matched ' + t));
    // Surrounding whitespace is trimmed, because rclone's own ini reader trims a
    // value: `type = drive ` is a drive remote, not an unknown backend.
    assert.equal(Rclone.providerForType(' drive ').id, 'drive');
});

test('providerForType: hostile input answers null and never throws', () => {
    [null, undefined, 0, [], {}, Symbol('s'), Object.create(null)].forEach((v) => {
        let out;
        assert.doesNotThrow(() => { out = Rclone.providerForType(v); }, dump(v));
        assert.equal(out, null);
    });
});

test('providerForType: Jottacloud maps to a provider rclone cannot authorize', () => {
    // Its recovery is instructions, not a token paste — offering it the paste
    // flow would send the user to a command that answers
    // "Error: not supported by this backend".
    const p = Rclone.providerForType('jottacloud');
    assert.equal(p.auth, Rclone.AUTH.EXTERNAL);
    assert.equal(Rclone.authorizeCommand(p.id), null);
    assert.ok(Rclone.externalSetup(p.id).steps.length > 0);
});

// ------------------------------------ classifyRcloneError: the new kind

test('classifyRcloneError: an expiry message becomes AUTH_EXPIRED with a button', () => {
    const e = Rclone.classifyRcloneError(
        'couldn\'t fetch token - maybe it has expired? - refresh with "rclone config reconnect gdrive:"');
    assert.equal(e.kind, Errors.KIND.AUTH_EXPIRED);
    assert.equal(e.remediation, 'reauthorize');
    assert.equal(e.fatal, true);
    // Said plainly. The provider's own wording is jargon and belongs in the detail.
    assert.match(e.message, /authorised again/);
    assert.equal(/invalid_grant|couldn/.test(e.message), false);
});

test('classifyRcloneError: "token not found" is expiry, not a missing rclone', () => {
    // The ordering trap: the not-installed test matches "not found", and would
    // otherwise send the user to install something they already have.
    const e = Rclone.classifyRcloneError('oauth2: token expired; refresh token not found');
    assert.equal(e.kind, Errors.KIND.AUTH_EXPIRED);
});

test('classifyRcloneError: the existing classifications are untouched', () => {
    assert.equal(Rclone.classifyRcloneError('rclone: command not found').kind, Errors.KIND.GENERIC);
    assert.match(Rclone.classifyRcloneError('rclone: command not found').message, /not installed/);
    assert.equal(Rclone.classifyRcloneError('dial tcp 10.0.0.9:443: i/o timeout').kind,
        Errors.KIND.NETWORK);
    assert.equal(Rclone.classifyRcloneError('403 Forbidden: quotaExceeded').kind, Errors.KIND.GENERIC);
    assert.equal(Rclone.classifyRcloneError('unknown backend "wat"').kind, Errors.KIND.GENERIC);
});

test('classifyRcloneError: the detail is passed through untouched for AUTH_EXPIRED', () => {
    const e = Rclone.classifyRcloneError('invalid_grant', { remote: 'gdrive' });
    assert.deepEqual(e.detail, { remote: 'gdrive' });
    assert.equal(Rclone.classifyRcloneError('invalid_grant').detail, null);
});

// -------------------------------------------------------- impure: cockpit

// The impure layer is exercised through a stub on the global, which is exactly
// how cockpit reaches it in the browser. Restored in finally so ordering cannot
// leak between tests.
function withCockpit(stub, fn) {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'cockpit');
    const prev = globalThis.cockpit;
    globalThis.cockpit = stub;
    return Promise.resolve().then(fn).finally(() => {
        if (had) globalThis.cockpit = prev;
        else delete globalThis.cockpit;
    });
}

// A stand-in for a host with an rclone config file. Records every argv it is
// given, so the tests can assert what did NOT reach a command line.
function fakeHost(text) {
    const host = {
        text: text === undefined ? CONFIG_SAMPLE : text,
        argvs: [],
        closes: 0
    };
    host.spawn = function (argv, opts) {
        host.argvs.push(argv.slice());
        host.opts = opts;
        if (argv[1] === 'config' && argv[2] === 'file')
            return Promise.resolve('Configuration file is stored at:\n/etc/rclone.conf\n');
        return Promise.resolve('');
    };
    host.file = function (p) {
        host.path = p;
        return {
            read: function () { return Promise.resolve(host.text); },
            modify: function (cb) { host.text = cb(host.text); return Promise.resolve(host.text); },
            replace: function (t) { host.text = t; return Promise.resolve(); },
            close: function () { host.closes += 1; }
        };
    };
    return host;
}

test('providerOfRemote: reads the type out of the config and maps it', async () => {
    const host = fakeHost();
    await withCockpit(host, async () => {
        const p = await Rclone.providerOfRemote('gdrive');
        assert.equal(p.id, 'drive');
        assert.equal(Rclone.authorizeCommand(p.id), 'rclone authorize "drive"');
    });
    assert.deepEqual(host.argvs[0], ['rclone', 'config', 'file']);
    assert.equal(host.closes, 1, 'the config file handle was not closed');
});

test('providerOfRemote: a remote hangar has no provider for is null, not a failure', async () => {
    // An rclone config may legitimately hold backends the wizard never made.
    await withCockpit(fakeHost('[weird]\ntype = chunker\n'), async () => {
        assert.equal(await Rclone.providerOfRemote('weird'), null);
    });
    await withCockpit(fakeHost('[a]\ntype = drive\n'), async () => {
        assert.equal(await Rclone.providerOfRemote('absent'), null);
    });
});

test('providerOfRemote: an EXTERNAL backend comes back as itself, not as OAuth', async () => {
    await withCockpit(fakeHost(), async () => {
        const p = await Rclone.providerOfRemote('jc');
        assert.equal(p.id, 'jottacloud');
        assert.equal(p.auth, Rclone.AUTH.EXTERNAL);
    });
});

test('providerOfRemote: validates the name before it would ever spawn', async () => {
    const host = fakeHost();
    await withCockpit(host, async () => {
        await assert.rejects(Rclone.providerOfRemote('a:b'), (e) => {
            assert.ok(Errors.isHangarError(e));
            assert.match(e.message, /must not contain ":"/);
            return true;
        });
        await assert.rejects(Rclone.providerOfRemote(''), (e) => {
            assert.match(e.message, /required/);
            return true;
        });
    });
    assert.deepEqual(host.argvs, [], 'a rejected name still reached a command line');
});

test('providerOfRemote: rejects, never throws, when cockpit is absent', async () => {
    let p;
    assert.doesNotThrow(() => { p = Rclone.providerOfRemote('gdrive'); });
    await p.then(() => assert.fail('expected a rejection'), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.equal(e.message, 'cockpit is not available');
    });
});

test('providerOfRemote: never puts the config text into an error', async () => {
    const host = fakeHost('[gdrive]\ntype = drive\ntoken = {"refresh_token":"CANARY"}\n');
    host.file = function () {
        return { read: () => Promise.reject(new Error('EACCES: permission denied')), close: () => {} };
    };
    await withCockpit(host, async () => {
        await Rclone.providerOfRemote('gdrive').then(
            () => assert.fail('expected a rejection'),
            (e) => {
                assert.ok(Errors.isHangarError(e));
                assertNoCanary(e.message + dump(e.detail), 'providerOfRemote');
            });
    });
});

// ------------------------------------------------------ updateRemoteToken

const NEW_TOKEN = '{"access_token":"CANARY-ACCESS","refresh_token":"CANARY-REFRESH",' +
    '"expiry":"2027-01-01T00:00:00Z"}';

test('updateRemoteToken: replaces only the token line of that one remote', async () => {
    const host = fakeHost();
    await withCockpit(host, async () => {
        const out = await Rclone.updateRemoteToken('gdrive', NEW_TOKEN);
        assert.deepEqual(out, { name: 'gdrive', updated: 'token' });
    });

    const before = CONFIG_SAMPLE.split('\n');
    const after = host.text.split('\n');
    // Exactly one line differs, and it is the token line of [gdrive].
    const changed = before.filter((l, i) => after[i] !== l);
    assert.deepEqual(changed, [before.find((l) => l.startsWith('token = '))]);
    assert.ok(host.text.includes('token = ' + NEW_TOKEN));
    // Every other remote, key, comment and blank line survives byte for byte.
    assert.ok(host.text.includes('# hand-written by the admin, and it stays that way'));
    assert.ok(host.text.includes('[local-nas]\ntype = sftp\nhost = nas.lan'));
    assert.ok(host.text.includes('client_id = 123-abc.apps.googleusercontent.com'));
    assert.ok(host.text.includes('scope = drive'));
    assert.ok(host.text.includes('[jc]\ntype = jottacloud'));
    assert.equal(host.text.includes('OLDR'), false, 'the old token survived');
});

test('updateRemoteToken: the token line appears exactly once afterwards', async () => {
    const host = fakeHost();
    await withCockpit(host, async () => { await Rclone.updateRemoteToken('gdrive', NEW_TOKEN); });
    const tokens = host.text.split('\n').filter((l) => /^token\s*=/.test(l));
    assert.equal(tokens.length, 1, 'rclone reads the FIRST token line: ' + tokens.join(' | '));
});

test('updateRemoteToken: the token never reaches argv', async () => {
    // /proc/<pid>/cmdline is world-readable. A token on a command line is a
    // published credential for as long as the process lives.
    const host = fakeHost();
    await withCockpit(host, async () => { await Rclone.updateRemoteToken('gdrive', NEW_TOKEN); });
    host.argvs.forEach((argv) => assertNoCanary(argv.join(' '), 'argv ' + argv.join(' ')));
    // …and the only spawns are the config-path lookup and the permission fix.
    assert.deepEqual(host.argvs[0], ['rclone', 'config', 'file']);
    assert.deepEqual(host.argvs[1], ['chmod', '600', '/etc/rclone.conf']);
    assert.equal(host.opts.superuser, 'require');
});

test('updateRemoteToken: what it resolves with carries no token', async () => {
    const host = fakeHost();
    await withCockpit(host, async () => {
        const out = await Rclone.updateRemoteToken('gdrive', NEW_TOKEN);
        assertNoCanary(JSON.stringify(out), 'result');
    });
});

test('updateRemoteToken: writes a token key for a remote that had none', async () => {
    const host = fakeHost('[box]\ntype = box\nclient_id = abc\n');
    await withCockpit(host, async () => { await Rclone.updateRemoteToken('box', NEW_TOKEN); });
    assert.ok(host.text.includes('token = ' + NEW_TOKEN));
    assert.ok(host.text.includes('client_id = abc'));
    assert.ok(host.text.indexOf('token =') > host.text.indexOf('[box]'));
});

test('updateRemoteToken: refuses an empty or unusable token', async () => {
    const host = fakeHost();
    await withCockpit(host, async () => {
        for (const bad of ['', '   ', null, undefined]) {
            await assert.rejects(Rclone.updateRemoteToken('gdrive', bad), (e) => {
                assert.ok(Errors.isHangarError(e));
                assert.match(e.message, /Paste the token/);
                return true;
            });
        }
        // A newline would end the key= line and start a new config key: config
        // injection into the file restic authenticates with.
        for (const bad of ['tok\nevil = 1', 'tok\r\nevil', 'tok\0evil']) {
            await assert.rejects(Rclone.updateRemoteToken('gdrive', bad), (e) => {
                assert.match(e.message, /single line/);
                return true;
            });
        }
    });
    assert.equal(host.text, CONFIG_SAMPLE, 'a refused token still changed the file');
    assert.deepEqual(host.argvs, [], 'a refused token still reached a command line');
});

test('updateRemoteToken: refuses an unusable remote name before touching anything', async () => {
    const host = fakeHost();
    await withCockpit(host, async () => {
        for (const bad of ['', '-x', 'a:b', 'a/b', 'a b', null]) {
            await assert.rejects(Rclone.updateRemoteToken(bad, NEW_TOKEN),
                (e) => Errors.isHangarError(e));
        }
    });
    assert.equal(host.text, CONFIG_SAMPLE);
    assert.deepEqual(host.argvs, []);
});

test('updateRemoteToken: no rejection ever carries the token', async () => {
    const cases = [['', NEW_TOKEN], ['a:b', NEW_TOKEN], ['gdrive', NEW_TOKEN + '\nevil = 1']];
    for (const [name, tok] of cases) {
        await Rclone.updateRemoteToken(name, tok).then(
            () => assert.fail('expected a rejection'),
            (e) => assertNoCanary(e.message + dump(e.detail), 'updateRemoteToken ' + name));
    }
    // …including when the write itself fails, which is where a helpful error
    // message is most tempting to build out of everything to hand.
    const host = fakeHost();
    host.file = function () {
        return {
            modify: () => Promise.reject(new Error('EROFS: read-only file system')),
            read: () => Promise.reject(new Error('EROFS: read-only file system')),
            close: () => {}
        };
    };
    await withCockpit(host, async () => {
        await Rclone.updateRemoteToken('gdrive', NEW_TOKEN).then(
            () => assert.fail('expected a rejection'),
            (e) => {
                assert.ok(Errors.isHangarError(e));
                assertNoCanary(e.message + dump(e.detail), 'failed write');
            });
    });
});

test('updateRemoteToken: rejects, never throws, when cockpit is absent', async () => {
    let p;
    assert.doesNotThrow(() => { p = Rclone.updateRemoteToken('gdrive', NEW_TOKEN); });
    await p.then(() => assert.fail('expected a rejection'), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.equal(e.message, 'cockpit is not available');
    });
});

test('updateRemoteToken: reuses mergeConfigSection rather than editing the file itself', () => {
    // The guarantee that every other remote, comment and blank line survives is
    // mergeConfigSection's, and it is tested exhaustively above. A second
    // implementation here would be a second set of bugs.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'core', 'rclone.js'), 'utf8');
    const fn = src.slice(src.indexOf('function updateRemoteToken'));
    const body = fn.slice(0, fn.indexOf('\n    function '));
    assert.ok(body.includes('writeSecrets('), 'updateRemoteToken does not go through writeSecrets');
    assert.equal(/f\.replace\(|mergeConfigSection\(/.test(body), false,
        'updateRemoteToken writes the config file itself');
});

// ================================================================== expiry:
// the false-positive sweep
//
// The risk this section exists for is not a missed expiry. It is the OPPOSITE:
// telling someone their sign-in lapsed when it did not. That costs them a
// pointless re-authorisation AND hides the real cause behind a green button —
// they fix the login, the backup fails again the next night, and the bucket
// policy or the full disk that actually broke it is never looked at.
//
// So every ordinary failure a cloud destination can produce is swept here and
// asserted NOT to be expiry, one named case each, and the genuine wordings are
// swept beside them so the sweep cannot be satisfied by a function that always
// answers false.
//
// tests/integration/hangar-run.test.js drives the same corpus through the Python
// copy in libexec/hangar-run. A message the editor calls expiry and the runner
// does not (or the reverse) is a bug in itself.

// Every entry is a real failure with a DIFFERENT remedy from re-authorising.
const NOT_EXPIRY = [
    ['permission denied', 'error listing: permission denied'],
    ['permission denied on a local path', 'Fatal: unable to open repo: stat /srv/repo: permission denied'],
    ['permission denied creating a directory', 'mkdir /srv/repo/data: permission denied'],
    ['quota exceeded', 'Failed to copy: 403 storageQuotaExceeded'],
    ['quota exceeded, spelled out', "googleapi: Error 403: The user's Drive storage quota has been exceeded., quotaExceeded"],
    ['bucket not found', 'NoSuchBucket: The specified bucket does not exist'],
    ['container not found', 'ContainerNotFound: The specified container does not exist'],
    ['DNS resolution failure', 'Get "https://s3.eu-central-1.amazonaws.com/": dial tcp: lookup s3.eu-central-1.amazonaws.com: no such host'],
    ['DNS resolution failure, resolver wording', 'temporary failure in name resolution'],
    ['connection refused', 'dial tcp 10.0.0.5:8000: connect: connection refused'],
    ['connection reset', 'read tcp 10.0.0.2:5000->10.0.0.9:443: read: connection reset by peer'],
    ['TLS handshake failure', 'net/http: TLS handshake timeout'],
    ['TLS certificate failure', 'x509: certificate signed by unknown authority'],
    ['wrong restic password', 'Fatal: wrong password or no key found'],
    ['repository locked', 'Fatal: unable to open repository: repository is already locked exclusively by PID 42 on host nas'],
    ['repository does not exist', 'Fatal: unable to open config file: Stat: file does not exist\nIs there a repository at the following location?'],
    ['disk full', 'write /srv/repo/data/ab: no space left on device'],
    ['disk quota', 'disk quota exceeded'],
    ['a bare 401', '401 Unauthorized'],
    ['a bare 401 with the status line', 'HTTP/1.1 401 Unauthorized'],
    ['a bare 403', '403 Forbidden'],
    ['a 403 that names a folder permission', '403 Forbidden: The user does not have permission to access this folder'],
    ['access denied', 'Access Denied'],
    ['access denied, S3 wording', 'AccessDenied: Access Denied, status code: 403'],
    ['access_denied, the OAuth code for a REFUSED consent', 'access_denied'],
    ['a bad signature', 'SignatureDoesNotMatch: The request signature we calculated does not match'],
    ['rate limiting', '429 Too Many Requests'],
    ['rate limiting, Google wording', '403: User Rate Limit Exceeded, userRateLimitExceeded'],
    ['rate limiting mid-copy', 'ERROR : x: Failed to copy: googleapi: Error 429: Rate Limit Exceeded, rateLimitExceeded'],
    ['a truncated message', "couldn't fetch to"],
    ['a truncated code', 'inval'],
    ['a garbled message', ' garbled��'],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['blank lines only', '\n\n\n'],
    ['a token mentioned in passing', 'NOTICE: using token from the config file']
];

NOT_EXPIRY.forEach(([label, text]) => {
    test('isAuthExpired: NOT expiry — ' + label, () => {
        assert.equal(Rclone.isAuthExpired(text), false,
            'reported as expiry: ' + JSON.stringify(text));
    });
});

test('isAuthExpired: a quota refusal and a token mention are not one fact', () => {
    // Pairing is per line. A stderr tail routinely carries an unrelated NOTICE
    // about the config file forty lines from the error that actually stopped the
    // backup; joining the two is the cheapest way to invent an expiry.
    assert.equal(Rclone.isAuthExpired(
        'ERROR : db.sql: Failed to copy: 403 Forbidden: storageQuotaExceeded\n' +
        'NOTICE: using token from the config file'), false);
    assert.equal(Rclone.isAuthExpired('403 Forbidden\nusing token from the config file'), false);
});

// --- a file NAME is not a diagnosis ----------------------------------------
//
// This is the class that got through. Both tools report the path they failed on,
// and a backup tool of all things is pointed at directories full of files called
// token, oauth2, bearer.key and invalid_grant.json. Reading the name as a signal
// turns "permission denied" into "your sign-in expired".

const PATHS_NOT_SIGNALS = [
    ['a file called token', 'error: lstat /home/alice/token: permission denied'],
    ['a log called token_expired.log', 'error: open /var/log/token_expired.log: permission denied'],
    ['a directory called oauth2', 'error: lstat /srv/oauth2/data: permission denied'],
    ['a key called bearer.key', 'error: open /home/bob/bearer.key: permission denied'],
    ['a file called invalid_grant.json', 'Fatal: unable to open file /etc/hangar/invalid_grant.json: permission denied'],
    ['a relative path with a 403', 'ERROR : secrets/token.json: Failed to copy: 403 Forbidden'],
    ['a directory called token with a 403', 'ERROR : token/db.sql: Failed to copy: 403 Forbidden'],
    ['a ./ path', 'error: lstat ./oauth2/data: permission denied'],
    ['a ~/ path', 'error: lstat ~/tokens: permission denied'],
    ['a ../ path', 'error: lstat ../bearer: permission denied'],
    ['a URL whose path mentions tokens', 'Get "https://s3.example.com/bucket/token-store/x": 403 Forbidden']
];

PATHS_NOT_SIGNALS.forEach(([label, text]) => {
    test('isAuthExpired: a path is not a signal — ' + label, () => {
        assert.equal(Rclone.isAuthExpired(text), false,
            'a filename was read as a diagnosis: ' + JSON.stringify(text));
    });
});

test('isAuthExpired: masking a path does not mask the message beside it', () => {
    // The mask must not become a way to lose a real expiry. rclone prints a
    // timestamp with slashes and the object it was copying, and the sentence that
    // matters comes after both.
    assert.equal(Rclone.isAuthExpired(
        '2026/07/31 03:00:12 ERROR : backups/db: Failed to copy: failed to open ' +
        'source object: couldn\'t fetch token - maybe it has expired?'), true);
    assert.equal(Rclone.isAuthExpired(
        'Post "https://oauth2.googleapis.com/token": oauth2: cannot fetch token: 401'), true);
});

test('isAuthExpired: Dropbox\'s code survives the path mask despite its slash', () => {
    // expired_access_token/... has a slash inside the API code for exactly this
    // failure. A mask that blanked every slash-bearing run would delete the one
    // word that decides and file a real expiry as "restic reported an error".
    assert.equal(Rclone.isAuthExpired('{"error_summary":"expired_access_token/..."}'), true);
    assert.equal(Rclone.isAuthExpired(
        'unexpected HTTP status 401: {"error_summary": "expired_access_token/.", ' +
        '"error": {".tag": "expired_access_token"}}'), true);
});

// --- the genuine wordings ---------------------------------------------------

const IS_EXPIRY = [
    ['rclone: couldn\'t fetch token', "couldn't fetch token - maybe it has expired?"],
    ['rclone: with a typographic apostrophe', 'couldn’t fetch token - maybe it has expired?'],
    ['rclone: with the apostrophe lost', 'couldnt fetch token'],
    ['rclone: in the sentence it really appears in',
        'Failed to create file system for "gd:x": couldn\'t fetch token - maybe it has expired?'],
    ['rclone naming its own remedy', 'refresh with "rclone config reconnect gdrive:"'],
    ['rclone: the bare command', 'rclone config reconnect box:'],
    ['oauth2: no refresh token to renew with', 'oauth2: token expired and refresh token is not set'],
    ['invalid_grant', 'invalid_grant'],
    ['invalid_grant shouted', 'INVALID_GRANT'],
    ['Google: expired or revoked',
        '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}'],
    ['Google: the description alone', 'Token has been expired or revoked.'],
    ['Box: 60 days of inactivity', 'Refresh token has expired'],
    ['OneDrive: AADSTS700082', 'AADSTS700082: The refresh token has expired due to inactivity.'],
    ['Dropbox: expired_access_token', 'expired_access_token'],
    ['a 401 that names the credential', '401 Unauthorized: the bearer token is no longer accepted'],
    ['a 401 that names the OAuth token',
        'googleapi: Error 401: Expected OAuth 2 access token, ..., unauthorized']
];

IS_EXPIRY.forEach(([label, text]) => {
    test('isAuthExpired: IS expiry — ' + label, () => {
        assert.equal(Rclone.isAuthExpired(text), true,
            'missed a real expiry: ' + JSON.stringify(text));
    });
});

test('isAuthExpired: the sweep is not satisfied by a function that always says no', () => {
    // A guard on the guard. If someone tightens the patterns until the
    // false-positive half passes trivially, this fails.
    assert.equal(NOT_EXPIRY.every(([, t]) => Rclone.isAuthExpired(t) === false), true);
    assert.equal(IS_EXPIRY.every(([, t]) => Rclone.isAuthExpired(t) === true), true);
    assert.ok(IS_EXPIRY.length >= 15);
    assert.ok(NOT_EXPIRY.length >= 30);
});

// --- line separators --------------------------------------------------------

test('isAuthExpired: a carriage return separates lines, as it does for the runner', () => {
    // rclone's progress output is full of bare carriage returns. Treating one as
    // an ordinary character joined a status code on one line to a token word on
    // the next — a false expiry the Python copy, which splits on \r, never saw.
    assert.equal(Rclone.isAuthExpired('403 Forbidden\rTransferred: 1 token of many'), false);
    assert.equal(Rclone.isAuthExpired('403 Forbidden\r\nusing token from the config file'), false);
});

test('isAuthExpired: every separator Python splits on splits here too', () => {
    // Spelled out rather than assumed: the two implementations must divide the
    // same text into the same lines or they can reach different verdicts on it.
    ['\r', '\n', '\r\n', '\v', '\f', '\x1c', '\x1d', '\x1e', '\x85', '\u2028', '\u2029']
        .forEach((sep) => {
            assert.equal(Rclone.isAuthExpired('403 Forbidden' + sep + 'oauth token'), false,
                'joined across ' + JSON.stringify(sep));
        });
});

test('isAuthExpired: a separator inside a phrase does not manufacture one either', () => {
    assert.equal(Rclone.isAuthExpired("couldn't fetch\rtoken"), false);
    assert.equal(Rclone.isAuthExpired('invalid\x85_grant'), false);
});
