// Integration tests for rclone remote creation against a REAL rclone binary.
//
// Unit tests compare core/rclone.js to itself: they prove the argv we build is the
// argv we meant to build. They cannot prove that "yandex" is a backend rclone has,
// that "key_file_pass" is a config key rclone reads, or that a value written under
// an obscured key is one rclone can reveal. Those are exactly the mistakes that
// produce a wizard which completes happily and a remote that authenticates nowhere
// — at 03:00, in a unit nobody is watching. This file checks them against the
// binary.
//
// Two rules hold throughout:
//   * The user's own rclone configuration is never read for content and never
//     written. Every command runs with RCLONE_CONFIG pointing at a throwaway file
//     in a temp directory, which is removed afterwards, and an after() hook proves
//     the real config file is byte-identical to what it was when this file loaded.
//   * Nothing here reaches the network. webdav, sftp, s3 and drive remotes are all
//     created offline — `rclone config create` writes config, it does not connect.
//
// Skips cleanly and in its entirety when rclone is not installed.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Rclone = require('../../js/core/rclone.js');
const Repos = require('../../js/core/repos.js');

const TIMEOUT = 60000;          // no rclone call here should take seconds, let alone a minute
const BIG = 64 * 1024 * 1024;   // `config providers` is ~1 MB, over spawnSync's default cap

function rcloneAvailable() {
    const r = spawnSync('rclone', ['version'], { encoding: 'utf8', timeout: TIMEOUT });
    return r.status === 0;
}

const HAVE_RCLONE = rcloneAvailable();
const skip = HAVE_RCLONE ? false : 'rclone is not installed';

// --- the user's real configuration must survive this file untouched ------

function realConfigPath() {
    if (!HAVE_RCLONE) return null;
    const r = spawnSync('rclone', ['config', 'file'], { encoding: 'utf8', timeout: TIMEOUT });
    return r.status === 0 ? Rclone.parseConfigFilePath(`${r.stdout || ''}${r.stderr || ''}`) : null;
}

// A digest, not the contents: this file must not hold the user's credentials in
// memory, and a hash is enough to prove nothing changed.
function digestOf(p) {
    if (!p || !fs.existsSync(p)) return 'absent';
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

const REAL_CONFIG = realConfigPath();
const REAL_DIGEST = digestOf(REAL_CONFIG);

// --- harness -------------------------------------------------------------

const sandboxes = [];

function makeSandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-rclone-'));
    const conf = path.join(root, 'rclone.conf');
    // Every argv this sandbox ever passed to a process, kept so a test can prove a
    // secret was in none of them. /proc/<pid>/cmdline is world-readable, so this is
    // the property the whole feature is built around.
    const argvLog = [];

    const sb = {
        root,
        conf,
        argvLog,
        run(argv, input) {
            argvLog.push(argv.slice());
            return spawnSync(argv[0], argv.slice(1), {
                encoding: 'utf8',
                input: input === undefined ? undefined : input,
                timeout: TIMEOUT,
                maxBuffer: BIG,
                // Overriding RCLONE_CONFIG is what keeps the real config out of
                // reach — including for any RCLONE_CONFIG already in the environment.
                env: Object.assign({}, process.env, { RCLONE_CONFIG: conf })
            });
        },
        ok(argv, input) {
            const r = sb.run(argv, input);
            if (r.status !== 0)
                throw new Error(`${argv.slice(0, 3).join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`);
            return r;
        },
        text() {
            return fs.existsSync(conf) ? fs.readFileSync(conf, 'utf8') : '';
        },
        cleanup() { fs.rmSync(root, { recursive: true, force: true }); }
    };
    sandboxes.push(sb);
    return sb;
}

test.after(() => {
    sandboxes.forEach((sb) => sb.cleanup());
    // The point of the temp config. If this ever fires, some command escaped the
    // sandbox and edited the user's remotes.
    assert.equal(digestOf(REAL_CONFIG), REAL_DIGEST,
        `the real rclone configuration at ${REAL_CONFIG} changed during these tests`);
});

// rclone's own machine-readable catalogue of backends and their config options.
// Loaded once: every "is this real?" assertion below is a lookup into it.
function loadBackends() {
    if (!HAVE_RCLONE) return null;
    const r = spawnSync('rclone', ['config', 'providers'],
        { encoding: 'utf8', timeout: TIMEOUT, maxBuffer: BIG });
    if (r.status !== 0) return null;
    try {
        const parsed = JSON.parse(r.stdout);
        return Array.isArray(parsed) ? parsed : null;
    } catch (e) {
        return null;
    }
}

const BACKENDS = loadBackends();

function backendFor(type) {
    return (BACKENDS || []).find((b) => b.Name === type) || null;
}

function optionFor(type, key) {
    const be = backendFor(type);
    if (!be || !Array.isArray(be.Options)) return null;
    return be.Options.find((o) => o.Name === key) || null;
}

// Mirrors core/rclone.js createRemote(), with fs standing in for cockpit.file:
// create the remote from the harmless keys only, then deliver the secret keys by
// merging them into the config file — obscuring the ones rclone stores obscured
// through `rclone obscure -`, which takes its input on stdin.
function applySecrets(sb, name, secrets) {
    const pairs = secrets.map((s) => {
        if (!s.obscure) return { key: s.key, value: s.value };
        const argv = Rclone.obscureArgv();
        assert.equal(argv[argv.length - 1], '-',
            'obscureArgv must use the hyphen form, or the password lands in argv');
        const out = sb.ok(argv, s.value).stdout.trim();
        assert.notEqual(out, '', 'rclone obscure produced nothing');
        return { key: s.key, value: out };
    });
    fs.writeFileSync(sb.conf, Rclone.mergeConfigSection(sb.text(), name, pairs), { mode: 0o600 });
    return pairs;
}

// The whole creation path, exactly as the plugin would drive it.
function createRemote(sb, name, providerId, values, token) {
    const plan = Rclone.configCreateArgv(name, providerId, values, token);

    assert.equal(plan.argv[0], 'rclone', 'configCreateArgv must emit the binary as argv[0]');
    plan.secrets.forEach((s) => {
        assert.ok(plan.argv.every((a) => a.indexOf(s.value) < 0),
            `secret ${s.key} appeared in argv — it would be visible in ps`);
    });

    sb.ok(plan.argv);
    const pairs = applySecrets(sb, name, plan.secrets);
    return { plan, pairs };
}

function listRemotes(sb) {
    return Repos.parseRcloneRemotes(sb.ok(['rclone', 'listremotes']).stdout);
}

// --- the binary itself ---------------------------------------------------

test('rclone is present and reports a version we can read', { skip }, () => {
    const out = spawnSync('rclone', ['version'], { encoding: 'utf8', timeout: TIMEOUT }).stdout;
    assert.match(out, /rclone\s+v?\d+\.\d+/, `unrecognised rclone version output: ${out.slice(0, 120)}`);
});

test('rclone exposes a backend catalogue we can check the provider table against',
    { skip }, () => {
        assert.ok(Array.isArray(BACKENDS) && BACKENDS.length > 20,
            '`rclone config providers` did not yield a backend list — every check below ' +
            'would pass vacuously without it');
        assert.ok(BACKENDS.every((b) => typeof b.Name === 'string' && b.Name !== ''),
            'a backend in the catalogue has no name');
    });

// --- the provider table describes backends that really exist -------------

test('every PROVIDERS type is a backend rclone actually has', { skip }, () => {
    const names = BACKENDS.map((b) => b.Name);
    const unknown = Rclone.PROVIDERS
        .filter((p) => !names.includes(p.type))
        .map((p) => `${p.id} -> "${p.type}"`);
    assert.deepEqual(unknown, [],
        `these provider types are not rclone backends: ${unknown.join(', ')}. ` +
        'A typo here produces a wizard that cannot work.');
});

test('every provider field key is a real config option of that backend', { skip }, () => {
    // rclone accepts unknown keys into the config file without complaint, so a
    // misspelled key fails silently: the remote is created and never authenticates.
    const bad = [];
    Rclone.PROVIDERS.forEach((p) => {
        p.fields.forEach((f) => {
            if (!optionFor(p.type, f.key)) bad.push(`${p.id}.${f.key}`);
        });
    });
    assert.deepEqual(bad, [], `not config options of their backend: ${bad.join(', ')}`);
});

test('every select option offers a value the backend advertises', { skip }, () => {
    // A dropdown is hangar promising the value is one of a known set, so each entry
    // must appear in rclone's own examples for that option. Free-form fields
    // (endpoint, region) are text inputs and are not policed here.
    const bad = [];
    let checked = 0;
    Rclone.PROVIDERS.forEach((p) => {
        p.fields.forEach((f) => {
            if (f.type !== 'select' || !Array.isArray(f.options)) return;
            const opt = optionFor(p.type, f.key);
            const examples = (opt && Array.isArray(opt.Examples))
                ? opt.Examples.map((e) => e.Value) : [];
            if (!examples.length) return;
            f.options.forEach((o) => {
                checked++;
                if (!examples.includes(o.value)) bad.push(`${p.id}.${f.key}=${o.value}`);
            });
        });
    });
    assert.deepEqual(bad, [], `values rclone does not list for that option: ${bad.join(', ')}`);
    assert.ok(checked > 0, 'no select values were compared — the check passed vacuously');
});

test('hangar obscures exactly the keys rclone stores obscured', { skip }, () => {
    // A plaintext value under an IsPassword key is silently unusable — rclone
    // "reveals" it into garbage — and obscuring a key rclone does not treat as a
    // password stores the obscured blob as the literal credential. Both directions
    // matter, so both are asserted.
    const wrong = [];
    Rclone.PROVIDERS.forEach((p) => {
        p.fields.forEach((f) => {
            const opt = optionFor(p.type, f.key);
            const rcloneSaysPassword = !!(opt && opt.IsPassword);
            if (!!f.obscure !== rcloneSaysPassword)
                wrong.push(`${p.id}.${f.key}: hangar obscure=${!!f.obscure}, rclone IsPassword=${rcloneSaysPassword}`);
            if (rcloneSaysPassword && !Rclone.isSecretField(f))
                wrong.push(`${p.id}.${f.key}: rclone treats it as a password but hangar does not`);
        });
    });
    assert.deepEqual(wrong, [], wrong.join('; '));
});

// --- headless OAuth ------------------------------------------------------

test('rclone authorize exists and rejects a backend name it does not know', { skip }, () => {
    // The negative control for the test below. Without it, "the name is in the
    // catalogue" would be a claim about our own JSON parsing, not about rclone.
    assert.equal(spawnSync('rclone', ['authorize', '--help'],
        { encoding: 'utf8', timeout: TIMEOUT }).status, 0,
    '`rclone authorize --help` failed — the headless OAuth flow hangar documents does not exist');

    const bogus = spawnSync('rclone', ['authorize', 'hangar-not-a-backend'],
        { encoding: 'utf8', timeout: TIMEOUT });
    assert.notEqual(bogus.status, 0, 'rclone accepted a nonexistent backend name');
    assert.match(`${bogus.stdout || ''}${bogus.stderr || ''}`, /didn't find backend/i);
});

test('authorizeCommand names a backend rclone can actually authorize', { skip }, () => {
    const oauth = Rclone.PROVIDERS.filter((p) => Rclone.isOAuth(p.id));
    assert.ok(oauth.length, 'no OAuth providers — the headless flow would be untested');

    oauth.forEach((p) => {
        const cmd = Rclone.authorizeCommand(p.id);
        // This string is copied by the user into a terminal on their own laptop, so
        // its exact shape is the contract.
        assert.equal(cmd, `rclone authorize "${p.type}"`);

        const m = /^rclone authorize "([^"]+)"$/.exec(cmd);
        assert.ok(m, `authorizeCommand produced something unparseable: ${cmd}`);
        assert.ok(backendFor(m[1]), `${p.id}: rclone has no backend "${m[1]}"`);

        // A token option is NOT evidence of an authorize flow. jottacloud has one
        // and still answers "not supported by this backend" — which is exactly how
        // a command that always errors reached the wizard. The only proof is
        // running it, so that is what this does.
        const r = spawnSync('rclone', ['authorize', p.type],
            { encoding: 'utf8', timeout: 3000, input: '' });
        const out = `${r.stdout || ''}${r.stderr || ''}`;
        assert.ok(!/not supported by this backend/i.test(out),
            `${p.id} is marked OAuth but \`rclone authorize ${p.type}\` refuses it`);
    });
});

test('a provider marked EXTERNAL really is one rclone cannot authorize', { skip }, () => {
    // The other direction, so a backend does not sit in the manual group forever
    // after rclone grows an authorize hook for it.
    const external = Rclone.PROVIDERS.filter((p) => p.auth === Rclone.AUTH.EXTERNAL);
    external.forEach((p) => {
        assert.equal(Rclone.authorizeCommand(p.id), null,
            `${p.id} is EXTERNAL but still offers an authorize command`);
        const r = spawnSync('rclone', ['authorize', p.type],
            { encoding: 'utf8', timeout: 3000, input: '' });
        const out = `${r.stdout || ''}${r.stderr || ''}`;
        assert.match(out, /not supported by this backend/i,
            `${p.id} is marked EXTERNAL but rclone CAN authorize it — move it to OAuth`);
        const setup = Rclone.externalSetup(p.id);
        assert.ok(setup && setup.steps.length, `${p.id} has no setup instructions`);
    });
});

test('providers hangar does not mark OAuth have no token flow either', { skip }, () => {
    // The inverse classification error: a credentials provider that actually needs
    // an authorize step would leave the user with no way to finish.
    // EXTERNAL providers are excluded on purpose: jottacloud genuinely has a token
    // option and genuinely cannot be authorized by rclone, which is the whole
    // reason that group exists. Only a CREDENTIALS provider with a token option is
    // misfiled.
    const misfiled = Rclone.PROVIDERS
        .filter((p) => p.auth === Rclone.AUTH.CREDENTIALS && optionFor(p.type, 'token'))
        .map((p) => p.id);
    assert.deepEqual(misfiled, [],
        `these need an OAuth token but are offered as credentials providers: ${misfiled.join(', ')}`);
});

// --- creation against the real binary ------------------------------------

test('configCreateArgv creates a webdav remote that listremotes then reports', { skip }, () => {
    const sb = makeSandbox();
    try {
        const name = 'hangar_live_webdav';
        createRemote(sb, name, 'webdav', {
            url: 'https://cloud.example.com/remote.php/dav/files/alice/',
            vendor: 'nextcloud',
            user: 'alice'
        });

        const remotes = listRemotes(sb);
        assert.ok(remotes.includes(name), `listremotes did not report ${name}: ${remotes.join(', ')}`);
        // parseRcloneRemotes must strip the trailing colon rclone prints.
        assert.ok(remotes.every((r) => !r.endsWith(':')), `colon left on a remote name: ${remotes.join(', ')}`);

        const shown = sb.ok(['rclone', 'config', 'show', name]).stdout;
        assert.match(shown, /^type\s*=\s*webdav$/m);
        assert.match(shown, /^vendor\s*=\s*nextcloud$/m);
    } finally { sb.cleanup(); }
});

test('configCreateArgv creates an sftp remote that listremotes then reports', { skip }, () => {
    const sb = makeSandbox();
    try {
        const name = 'hangar_live_sftp';
        createRemote(sb, name, 'sftp', {
            host: 'nas.lan',
            user: 'backup',
            port: '2222',
            key_file: '/root/.ssh/id_ed25519'
        });

        assert.ok(listRemotes(sb).includes(name));
        const shown = sb.ok(['rclone', 'config', 'show', name]).stdout;
        assert.match(shown, /^type\s*=\s*sftp$/m);
        assert.match(shown, /^host\s*=\s*nas\.lan$/m);
        assert.match(shown, /^port\s*=\s*2222$/m);
    } finally { sb.cleanup(); }
});

test('two remotes coexist and parseRcloneRemotes reads them both back', { skip }, () => {
    const sb = makeSandbox();
    try {
        createRemote(sb, 'hangar_live_a', 'webdav', { url: 'https://a.example.com/dav/' });
        createRemote(sb, 'hangar_live_b', 'sftp', { host: 'b.example.com' });

        const remotes = listRemotes(sb);
        assert.deepEqual(remotes.slice().sort(), ['hangar_live_a', 'hangar_live_b'],
            'creating the second remote disturbed the first');
    } finally { sb.cleanup(); }
});

test('an OAuth provider is created without a browser and without the network', { skip }, () => {
    const sb = makeSandbox();
    try {
        const name = 'hangar_live_drive';
        const { plan } = createRemote(sb, name, 'drive', { scope: 'drive.file' });

        // The documented headless switch. Without it rclone tries to open a browser
        // and bind 127.0.0.1:53682 on the server, which is not where the user is.
        assert.ok(plan.argv.includes('config_is_local=false'),
            'the OAuth argv omits config_is_local=false — rclone would try to open a browser here');

        assert.ok(listRemotes(sb).includes(name));
        const shown = sb.ok(['rclone', 'config', 'show', name]).stdout;
        assert.match(shown, /^type\s*=\s*drive$/m);
        assert.match(shown, /^scope\s*=\s*drive\.file$/m);
        // No token was pasted, so none must have been invented.
        assert.ok(!/^token\s*=\s*\S/m.test(shown), `a token appeared from nowhere: ${shown}`);
    } finally { sb.cleanup(); }
});

// --- secrets reach the config file and never argv ------------------------

test('an obscured secret lands in the config file having never been an argument',
    { skip }, () => {
        const sb = makeSandbox();
        try {
            const name = 'hangar_live_secret';
            // Fabricated, and never used against anything: spaces and punctuation are
            // deliberate, because a value that survives obscure/reveal unchanged is
            // the only proof the round trip is lossless.
            const password = 'tr0ub4dor &3 correct horse';

            const { plan, pairs } = createRemote(sb, name, 'webdav', {
                url: 'https://cloud.example.com/remote.php/dav/files/alice/',
                user: 'alice',
                pass: password
            });

            assert.equal(plan.secrets.length, 1, 'the password was not classified as a secret');
            assert.equal(plan.secrets[0].key, 'pass');
            assert.equal(plan.secrets[0].obscure, true);

            const stored = pairs.find((p) => p.key === 'pass').value;
            assert.notEqual(stored, password, 'the password was stored in the clear');

            // It is in the file rclone authenticates from...
            const text = sb.text();
            assert.match(text, new RegExp(`^\\[${name}\\]$`, 'm'));
            assert.ok(text.includes(`pass = ${stored}`), `pass missing from the config file:\n${text}`);
            assert.ok(!text.includes(password), 'the plaintext password reached the config file');

            // ...and rclone reads back exactly what the user typed. Only the obscured
            // form is passed as an argument here; the plaintext never is.
            const revealed = sb.ok(['rclone', 'reveal', stored]).stdout.replace(/\r?\n$/, '');
            assert.equal(revealed, password,
                'rclone could not reveal the stored password — the remote would authenticate nowhere');

            // The point of the whole design: no process this test started could have
            // shown the password in `ps`.
            sb.argvLog.forEach((argv) => {
                assert.ok(argv.every((a) => a.indexOf(password) < 0),
                    `the password appeared in argv of: ${argv.slice(0, 3).join(' ')}`);
            });

            // And rclone agrees the remote is complete.
            assert.ok(listRemotes(sb).includes(name));
            assert.match(sb.ok(['rclone', 'config', 'show', name]).stdout, /^type\s*=\s*webdav$/m);
        } finally { sb.cleanup(); }
    });

test('a secret rclone does not obscure is stored verbatim, still never in argv', { skip }, () => {
    const sb = makeSandbox();
    try {
        const name = 'hangar_live_s3';
        const secretKey = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

        const { plan } = createRemote(sb, name, 's3', {
            provider: 'Minio',
            access_key_id: 'AKIAIOSFODNN7EXAMPLE',
            secret_access_key: secretKey,
            endpoint: 'https://minio.lan:9000'
        });

        assert.deepEqual(plan.secrets.map((s) => s.key), ['secret_access_key']);
        assert.equal(plan.secrets[0].obscure, false, 's3 secret keys are not obscured by rclone');

        // Stored as typed, because rclone does not treat it as an IsPassword option...
        assert.ok(sb.text().includes(`secret_access_key = ${secretKey}`),
            'the S3 secret key did not reach the config file');
        // ...but it still never touched a command line.
        sb.argvLog.forEach((argv) => {
            assert.ok(argv.every((a) => a.indexOf(secretKey) < 0),
                `the S3 secret key appeared in argv of: ${argv.slice(0, 3).join(' ')}`);
        });

        const shown = sb.ok(['rclone', 'config', 'show', name]).stdout;
        assert.match(shown, /^type\s*=\s*s3$/m);
        assert.match(shown, /^access_key_id\s*=\s*AKIAIOSFODNN7EXAMPLE$/m);
    } finally { sb.cleanup(); }
});

test('merging secrets leaves every other remote in the file untouched', { skip }, () => {
    const sb = makeSandbox();
    try {
        createRemote(sb, 'hangar_live_keep', 'sftp', { host: 'keep.example.com', user: 'keeper' });
        const before = sb.text();

        createRemote(sb, 'hangar_live_add', 'webdav', {
            url: 'https://add.example.com/dav/', user: 'adder', pass: 'not a real password'
        });

        // The user's other remotes are theirs. Every line of the first section must
        // survive the second creation verbatim.
        before.split('\n').filter((l) => l.trim() !== '').forEach((line) => {
            assert.ok(sb.text().includes(line), `merging dropped or rewrote: ${line}`);
        });
        assert.deepEqual(listRemotes(sb).slice().sort(), ['hangar_live_add', 'hangar_live_keep']);
    } finally { sb.cleanup(); }
});

// --- the created remote is a repository restic can be pointed at ---------

test('the created remote round-trips through Repos.buildUrl and Repos.parseUrl', { skip }, () => {
    const sb = makeSandbox();
    try {
        const name = 'hangar_live_repo';
        createRemote(sb, name, 'webdav', { url: 'https://cloud.example.com/dav/', user: 'alice' });

        const remote = listRemotes(sb).find((r) => r === name);
        assert.ok(remote, 'the remote hangar just created is not in listremotes');

        // What restic is actually handed. restic strips "rclone:" and passes the rest
        // to rclone as remote:path, so the remote half must be exactly the name
        // rclone printed.
        const url = Repos.buildUrl({ kind: 'rclone', remote: remote, prefix: 'backups/hangar' });
        assert.equal(url, `rclone:${remote}:backups/hangar`);
        assert.equal(url.slice('rclone:'.length).split(':')[0], remote);

        const back = Repos.parseUrl(url);
        assert.equal(back.kind, 'rclone');
        assert.equal(back.remote, remote);
        assert.equal(back.prefix, 'backups/hangar');
        assert.equal(Repos.buildUrl(back), url, 'parseUrl did not reverse buildUrl');

        // A repository at the root of the remote is the other shape the UI allows.
        const bare = Repos.buildUrl({ kind: 'rclone', remote: remote });
        assert.equal(bare, `rclone:${remote}`);
        assert.deepEqual(Repos.parseUrl(bare), { kind: 'rclone', remote: remote });

        assert.deepEqual(Repos.validate({ id: 'live', kind: 'rclone', remote: remote }), [],
            'a repository on the remote we just created does not validate');
    } finally { sb.cleanup(); }
});

// --- config path and deletion --------------------------------------------

test('parseConfigFilePath reads the real `rclone config file` output', { skip }, () => {
    const sb = makeSandbox();
    try {
        createRemote(sb, 'hangar_live_path', 'sftp', { host: 'path.example.com' });
        const out = sb.ok(Rclone.configFileArgv()).stdout;
        assert.equal(Rclone.parseConfigFilePath(out), sb.conf,
            `parseConfigFilePath did not find the path in: ${JSON.stringify(out)}`);
    } finally { sb.cleanup(); }
});

test('configDeleteArgv removes the remote it names and nothing else', { skip }, () => {
    const sb = makeSandbox();
    try {
        createRemote(sb, 'hangar_live_gone', 'sftp', { host: 'gone.example.com' });
        createRemote(sb, 'hangar_live_stays', 'sftp', { host: 'stays.example.com' });

        sb.ok(Rclone.configDeleteArgv('hangar_live_gone'));
        assert.deepEqual(listRemotes(sb), ['hangar_live_stays']);
    } finally { sb.cleanup(); }
});

// --- error text rclone really produces -----------------------------------

test('classifyRcloneError classifies a genuine rclone failure', { skip }, () => {
    const sb = makeSandbox();
    try {
        // A backend that does not exist: real rclone stderr, not an invented string.
        const r = sb.run(['rclone', 'config', 'create', 'hangar_live_bad', 'hangar-not-a-backend']);
        assert.notEqual(r.status, 0, 'rclone accepted a nonexistent backend type');

        const err = Rclone.classifyRcloneError(r.stderr || r.stdout, { command: 'config create' });
        assert.ok(err && err.message, 'no message produced for a real rclone failure');
        assert.equal(typeof err.kind, 'string');
        assert.ok(!listRemotes(sb).includes('hangar_live_bad'));
    } finally { sb.cleanup(); }
});
