// Live verification of expiry detection against a REAL rclone binary.
//
// Every other test of isAuthExpired() compares our regexes to strings we wrote
// ourselves. That proves the matcher matches what we IMAGINED rclone prints. The
// only failure mode that matters is the other one: rclone prints something we did
// not imagine, isAuthExpired() returns false, the nightly backup is filed as a
// generic error, and the destination stays broken until someone notices months of
// missing snapshots. So this file makes rclone produce the message itself — from a
// remote whose stored token is deliberately unusable — and asserts our classifier
// catches THAT text.
//
// The mirror image is asserted too. A false "your sign-in expired" is not a
// harmless over-trigger: it sends the user through a re-authorisation that fixes
// nothing and hides the real cause. So a webdav remote that cannot connect, and a
// real HTTP 401 from a real server, must NOT be classified as expiry.
//
// Three rules hold throughout:
//   * The user's own rclone configuration is never read for content and never
//     written. Every command runs with RCLONE_CONFIG pointing at a throwaway file
//     in a temp directory, removed in a finally, and an after() hook proves the
//     real config file is byte-identical to what it was when this file loaded.
//   * The tokens here are fabricated and syntactically valid but authorise
//     nothing. "ya29." and "sl." are the shapes Google and Dropbox use; the bodies
//     are nonsense. Nothing in this file can reach anybody's data.
//   * Two probes (invalid_grant, and a real 401) need the network. Neither is
//     allowed to fail merely because there is none: each detects a connectivity
//     failure and skips with a diagnostic instead of reporting a matcher bug that
//     did not happen.
//
// Skips cleanly and in its entirety when rclone is not installed.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Rclone = require('../../js/core/rclone.js');
const Errors = require('../../js/core/errors.js');
const Restic = require('../../js/engine/restic.js');
const Secrets = require('../../js/core/secrets.js');

const KIND = Errors.KIND;

const TIMEOUT = 60000;          // nothing here should take seconds, let alone a minute
const BIG = 64 * 1024 * 1024;

// rclone retries a failing backend for ~20s by default, which turns a two-second
// test into a stalled one. These cap it: we want the FIRST error text, not
// perseverance.
const IMPATIENT = ['--retries', '1', '--low-level-retries', '1',
    '--contimeout', '5s', '--timeout', '5s'];

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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-reauth-'));
    const conf = path.join(root, 'rclone.conf');
    // Every argv any process in this sandbox was started with, so a test can prove
    // a token was in none of them. /proc/<pid>/cmdline is world-readable.
    const argvLog = [];

    function env() {
        // Overriding RCLONE_CONFIG is what keeps the real config out of reach —
        // including any RCLONE_CONFIG already in the environment.
        return Object.assign({}, process.env, { RCLONE_CONFIG: conf });
    }

    const sb = {
        root,
        conf,
        argvLog,
        env,
        run(argv, input) {
            argvLog.push(argv.slice());
            return spawnSync(argv[0], argv.slice(1), {
                encoding: 'utf8',
                input: input === undefined ? undefined : input,
                timeout: TIMEOUT,
                maxBuffer: BIG,
                env: env()
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
        write(text) {
            fs.writeFileSync(conf, text, { mode: 0o600 });
        },
        cleanup() { fs.rmSync(root, { recursive: true, force: true }); }
    };
    sandboxes.push(sb);
    return sb;
}

test.after(() => {
    sandboxes.forEach((sb) => sb.cleanup());
    // If this ever fires, some command escaped the sandbox and edited the user's
    // remotes.
    assert.equal(digestOf(REAL_CONFIG), REAL_DIGEST,
        `the real rclone configuration at ${REAL_CONFIG} changed during these tests`);
});

// The plugin's own creation path, minus secrets: none of the remotes below carry
// a password, and configCreateArgv is asserted to agree.
function createRemote(sb, name, providerId, values) {
    const plan = Rclone.configCreateArgv(name, providerId, values);
    assert.deepEqual(plan.secrets, [], `${providerId} unexpectedly produced secret keys here`);
    sb.ok(plan.argv);
    return plan;
}

// Fixture setup, not the code under test: puts a token into the sandbox config the
// way a real authorisation would have, so that rclone has something to find
// expired. mergeConfigSection is used because writing the INI by hand would test a
// file rclone might not accept.
function stashToken(sb, name, token) {
    sb.write(Rclone.mergeConfigSection(sb.text(), name, [{ key: 'token', value: token }]));
}

// Fabricated. Past expiry, and no refresh token at all — the case rclone can
// diagnose without asking anybody, which is what makes this probe work offline.
function deadToken(accessToken) {
    return JSON.stringify({
        access_token: accessToken,
        token_type: 'Bearer',
        expiry: '2020-01-01T00:00:00Z'
    });
}

// Everything rclone says when it could not get far enough to fail properly. Used
// only to skip a network-dependent probe honestly rather than blame the matcher.
const OFFLINE_RE =
    /(no such host|network is unreachable|connection refused|i\/o timeout|dial tcp|timeout awaiting|no route to host|temporary failure)/i;

// Runs something harmless against a remote and returns everything it printed.
// `about` and `lsd` are both reads; neither writes to the destination — and with a
// token that authorises nothing, neither could reach one anyway.
function probe(sb, name, op) {
    const r = sb.run(['rclone', op || 'about', `${name}:`].concat(IMPATIENT));
    return { status: r.status, text: `${r.stderr || ''}${r.stdout || ''}` };
}

// --- the reconnect command hangar puts in front of the user --------------

test('reconnectCommand names a command rclone really has', { skip }, () => {
    // hangar shows this string for the record — the user cannot run it usefully on
    // a headless server, but it is what rclone's own documentation and its error
    // messages tell them to run, so it must at least be real.
    const help = spawnSync('rclone', ['config', 'reconnect', '--help'],
        { encoding: 'utf8', timeout: TIMEOUT });
    assert.equal(help.status, 0,
        '`rclone config reconnect --help` failed — hangar names a subcommand that does not exist');

    const out = `${help.stdout || ''}${help.stderr || ''}`;
    assert.match(out, /rclone config reconnect remote:/,
        `rclone's own usage line no longer matches the shape hangar builds:\n${out.slice(0, 300)}`);

    const cmd = Rclone.reconnectCommand('gdrive');
    assert.equal(cmd, 'rclone config reconnect gdrive:');
    // The exact shape rclone documents: <name> followed by a colon.
    assert.match(cmd, /^rclone config reconnect \S+:$/);

    // And the reason hangar never runs it: there is no non-interactive form. If
    // rclone ever grows one, this assertion is the place that will notice.
    assert.match(out, /interactive oauth flow/i,
        'rclone no longer calls reconnect an interactive flow — re-check whether ' +
        'hangar could now run it directly instead of asking for a pasted token');
});

// --- THE CRUX: real rclone text, matched by our matcher ------------------

test('a Google Drive remote with a dead token produces text isAuthExpired recognises',
    { skip }, (t) => {
        const sb = makeSandbox();
        try {
            const name = 'hangar_reauth_drive';
            const secret = 'ya29.hangar-test-not-a-real-token';
            createRemote(sb, name, 'drive', { scope: 'drive.file' });
            stashToken(sb, name, deadToken(secret));

            const got = probe(sb, name);
            assert.notEqual(got.text.trim(), '', 'rclone printed nothing at all');
            if (!Rclone.isAuthExpired(got.text) && OFFLINE_RE.test(got.text)) {
                t.skip(`no network: rclone failed before reaching the token — ${got.text.trim()}`);
                return;
            }

            // The assertion this whole file exists for.
            assert.ok(Rclone.isAuthExpired(got.text),
                'isAuthExpired() did NOT recognise what rclone really printed. This is a ' +
                'matcher bug, not a test bug — every scheduled backup to this remote would ' +
                `be filed as a generic error.\nrclone said:\n${got.text}`);

            const err = Rclone.classifyRcloneError(got.text);
            assert.equal(err.kind, KIND.AUTH_EXPIRED);
            assert.equal(err.remediation, 'reauthorize',
                'AUTH_EXPIRED must offer re-authorisation, never retry — retrying fails ' +
                'identically every night');

            // The detection point that actually matters: restic spawns rclone, so in
            // production this text arrives inside RESTIC's stderr with restic's own
            // generic exit 1. Feeding the real text through that path is the only way
            // to know a nightly backup would be classified correctly.
            const viaRestic = Restic.classifyExit(1, got.text);
            assert.equal(viaRestic.kind, KIND.AUTH_EXPIRED,
                `restic's classifier missed it: ${viaRestic.kind}`);
            assert.equal(viaRestic.remediation, 'reauthorize');
            assert.equal(viaRestic.detail.stderr, got.text, 'the raw text must survive for the log');

            // rclone does not echo the credential, and hangar's sentence replaces
            // rclone's jargon — so nothing on the path to the user carries the token.
            assert.ok(got.text.indexOf(secret) < 0,
                'rclone echoed the token into its error text');
            assert.ok(viaRestic.message.indexOf(secret) < 0);
            assert.match(viaRestic.message, /authoris|sign-in/i,
                `the user-facing sentence is still rclone jargon: ${viaRestic.message}`);
        } finally { sb.cleanup(); }
    });

test('a Dropbox remote with a dead token is recognised too', { skip }, (t) => {
    // A second backend, because a matcher tuned to one provider's wording is a
    // matcher that fails on the other five. Dropbox reaches the failure through a
    // different code path (an API call, not a root-directory lookup).
    const sb = makeSandbox();
    try {
        const name = 'hangar_reauth_dropbox';
        createRemote(sb, name, 'dropbox', {});
        stashToken(sb, name, deadToken('sl.hangar-test-not-a-real-token'));

        const got = probe(sb, name);
        assert.notEqual(got.text.trim(), '', 'rclone printed nothing at all');
        if (!Rclone.isAuthExpired(got.text) && OFFLINE_RE.test(got.text)) {
            t.skip(`no network: ${got.text.trim()}`);
            return;
        }
        assert.ok(Rclone.isAuthExpired(got.text),
            `isAuthExpired() missed Dropbox's real wording:\n${got.text}`);
        assert.equal(Restic.classifyExit(1, got.text).kind, KIND.AUTH_EXPIRED);
    } finally { sb.cleanup(); }
});

test('a refresh token the provider rejects is recognised as expiry', { skip }, (t) => {
    // The other real shape, and the commoner one in production: the remote HAS a
    // refresh token, rclone tries it, and the provider answers invalid_grant. This
    // one genuinely requires the network — the answer comes from Google — so a host
    // without it skips rather than accusing the matcher.
    const sb = makeSandbox();
    try {
        const name = 'hangar_reauth_grant';
        createRemote(sb, name, 'drive', { scope: 'drive.file' });
        stashToken(sb, name, JSON.stringify({
            access_token: 'ya29.hangar-test-not-a-real-token',
            token_type: 'Bearer',
            refresh_token: '1//0-hangar-test-not-a-real-refresh-token',
            expiry: '2020-01-01T00:00:00Z'
        }));

        const got = probe(sb, name);
        if (!Rclone.isAuthExpired(got.text) && OFFLINE_RE.test(got.text)) {
            t.skip(`no network: the provider never answered — ${got.text.trim()}`);
            return;
        }
        assert.ok(Rclone.isAuthExpired(got.text),
            `isAuthExpired() missed a rejected refresh token:\n${got.text}`);
        assert.equal(Rclone.classifyRcloneError(got.text).kind, KIND.AUTH_EXPIRED);
    } finally { sb.cleanup(); }
});

test('the redacted form of the real message is still recognised', { skip }, (t) => {
    // hangar-run redacts before it writes the job state file, and the UI classifies
    // what it reads back. If redaction ate the signal, detection would work in the
    // browser console and fail in production, which is the worst possible split.
    const sb = makeSandbox();
    try {
        const name = 'hangar_reauth_redact';
        createRemote(sb, name, 'drive', { scope: 'drive.file' });
        stashToken(sb, name, deadToken('ya29.hangar-test-not-a-real-token'));

        const got = probe(sb, name);
        if (!Rclone.isAuthExpired(got.text)) {
            t.skip('the unredacted text was not recognised — see the crux test for the finding');
            return;
        }
        const masked = Secrets.redact(got.text);
        assert.ok(Rclone.isAuthExpired(masked),
            `redaction destroyed the expiry signal:\n${masked}`);
        assert.equal(Restic.classifyExit(1, masked).kind, KIND.AUTH_EXPIRED);
    } finally { sb.cleanup(); }
});

// --- and the failures that are NOT expiry --------------------------------

test('a webdav remote whose host refuses the connection is not expiry', { skip }, () => {
    const sb = makeSandbox();
    try {
        const name = 'hangar_reauth_refused';
        // Port 9 is discard: nothing listens, and the kernel refuses immediately.
        createRemote(sb, name, 'webdav', { url: 'http://127.0.0.1:9/dav/', vendor: 'other' });

        const got = probe(sb, name, 'lsd');
        assert.notEqual(got.text.trim(), '', 'rclone printed nothing at all');
        assert.equal(Rclone.isAuthExpired(got.text), false,
            `a connection failure was read as expired authorisation:\n${got.text}`);
        assert.equal(Rclone.classifyRcloneError(got.text).kind, KIND.NETWORK);
        assert.notEqual(Restic.classifyExit(1, got.text).kind, KIND.AUTH_EXPIRED);
    } finally { sb.cleanup(); }
});

test('a webdav remote whose host does not resolve is not expiry', { skip }, () => {
    const sb = makeSandbox();
    try {
        const name = 'hangar_reauth_nxdomain';
        // .invalid is reserved by RFC 2606 precisely so it can never resolve.
        createRemote(sb, name, 'webdav',
            { url: 'https://hangar-no-such-host.invalid/dav/', vendor: 'other' });

        const got = probe(sb, name, 'lsd');
        assert.notEqual(got.text.trim(), '', 'rclone printed nothing at all');
        assert.equal(Rclone.isAuthExpired(got.text), false,
            `a name-resolution failure was read as expired authorisation:\n${got.text}`);
        assert.notEqual(Restic.classifyExit(1, got.text).kind, KIND.AUTH_EXPIRED);
    } finally { sb.cleanup(); }
});

// A throwaway HTTP server that answers everything with 401. It runs in a CHILD
// process on purpose: spawnSync blocks this process's event loop, so a server
// hosted here would never get to reply.
function withHttp401(fn) {
    const SRC = "const http=require('node:http');" +
        "const s=http.createServer((req,res)=>{req.resume();" +
        "res.writeHead(401,{'WWW-Authenticate':'Basic realm=\"dav\"'});res.end('Unauthorized');});" +
        "s.listen(0,'127.0.0.1',()=>process.stdout.write('PORT '+s.address().port+'\\n'));";

    const child = spawn(process.execPath, ['-e', SRC], { stdio: ['ignore', 'pipe', 'ignore'] });
    return new Promise((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error('the 401 server never reported a port')), 10000);
        child.on('error', reject);
        child.stdout.on('data', (d) => {
            buf += d;
            const m = /PORT (\d+)/.exec(buf);
            if (!m) return;
            clearTimeout(timer);
            resolve(Number(m[1]));
        });
    }).then((port) => fn(port)).finally(() => { child.kill(); });
}

test('a real 401 from a real server is NOT expiry', { skip }, () => {
    // The judgement the whole design turns on, checked against output rclone
    // really produced rather than a string we wrote. A bare 401 is what an
    // ordinary permission problem looks like — a revoked share, a wrong path, a
    // bucket policy. Calling it expiry would send the user through a
    // re-authorisation that fixes nothing and bury the real cause.
    return withHttp401((port) => {
        const sb = makeSandbox();
        try {
            const name = 'hangar_reauth_401';
            createRemote(sb, name, 'webdav',
                { url: `http://127.0.0.1:${port}/dav/`, vendor: 'other' });

            const got = probe(sb, name, 'lsd');
            assert.match(got.text, /401/, `no 401 in rclone's output:\n${got.text}`);
            assert.equal(Rclone.isAuthExpired(got.text), false,
                `a bare 401 was read as expired authorisation:\n${got.text}`);
            assert.notEqual(Restic.classifyExit(1, got.text).kind, KIND.AUTH_EXPIRED);
        } finally { sb.cleanup(); }
    });
});

// --- the recovery, against a real config file ----------------------------

// Stands in for cockpit: the same spawn/file surface core/rclone.js uses, pointed
// at the sandbox. This runs the REAL updateRemoteToken and providerOfRemote —
// including their `rclone config file` lookup and their config-file merge — rather
// than a copy of what they do, which is the only way this proves anything about
// the code that ships.
function withCockpit(sb, fn) {
    const previous = Object.prototype.hasOwnProperty.call(globalThis, 'cockpit')
        ? globalThis.cockpit : undefined;
    const had = previous !== undefined;

    globalThis.cockpit = {
        spawn(argv) {
            let started = null;
            const exec = (input) => new Promise((resolve, reject) => {
                const r = sb.run(argv, input);
                if (r.error) return reject({ message: String(r.error.message) });
                if (r.status !== 0)
                    return reject({ message: `${r.stderr || ''}${r.stdout || ''}`.trim() });
                return resolve(r.stdout || '');
            });
            // Deferred so `.input(secret)` can supply stdin before anything runs —
            // that stdin channel is how a secret avoids argv.
            const start = (input) => {
                if (!started) started = exec(input);
                return started;
            };
            return {
                input(data) { return start(data); },
                then(a, b) { return start(undefined).then(a, b); },
                catch(f) { return start(undefined).catch(f); }
            };
        },
        file(p) {
            return {
                read() {
                    return Promise.resolve(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
                },
                modify(cb) {
                    return Promise.resolve().then(() => {
                        const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
                        const next = cb(cur);
                        fs.writeFileSync(p, next, { mode: 0o600 });
                        return next;
                    });
                },
                replace(content) {
                    return Promise.resolve().then(() => fs.writeFileSync(p, content, { mode: 0o600 }));
                },
                close() { }
            };
        }
    };

    return Promise.resolve().then(fn).finally(() => {
        if (had) globalThis.cockpit = previous;
        else delete globalThis.cockpit;
    });
}

test('updateRemoteToken replaces one token and leaves the rest of the file byte-identical',
    { skip }, () => {
        const sb = makeSandbox();
        return withCockpit(sb, () => {
            const gd = 'hangar_reauth_target';
            const keep = 'hangar_reauth_bystander';
            const OLD = deadToken('ya29.old-token-nobody-can-use');
            const NEW = JSON.stringify({
                access_token: 'ya29.new-token-also-nobody-can-use',
                token_type: 'Bearer',
                refresh_token: '1//0-new-refresh-token',
                expiry: '2099-01-01T00:00:00Z'
            });

            createRemote(sb, keep, 'sftp', { host: 'nas.lan', user: 'backup', port: '2222' });
            createRemote(sb, gd, 'drive', { scope: 'drive.file' });
            // A comment inside the section being edited. rclone keeps comments, users
            // write them, and a merge that eats them is a merge that edits something
            // it was not asked to edit.
            fs.appendFileSync(sb.conf, '# do not delete: this is Ada\'s work account\n');
            stashToken(sb, gd, OLD);

            const before = sb.text();
            const bystander = /\[hangar_reauth_bystander\][^[]*/.exec(before)[0];

            return Rclone.updateRemoteToken(gd, NEW).then((res) => {
                // The resolution names the remote and the key, never the value.
                assert.deepEqual(res, { name: gd, updated: 'token' });
                assert.ok(JSON.stringify(res).indexOf('ya29') < 0, 'the token came back in the result');

                const after = sb.text();
                assert.ok(after.indexOf(`token = ${NEW}`) >= 0, 'the new token is not in the file');
                assert.ok(after.indexOf(OLD) < 0, 'the old token is still in the file');

                // The other remote, byte for byte.
                assert.ok(after.indexOf(bystander) >= 0,
                    `the bystander remote was rewritten:\n${bystander}\n--- became ---\n${after}`);
                // The comment, byte for byte.
                assert.ok(after.indexOf("# do not delete: this is Ada's work account") >= 0,
                    `the user's comment was dropped:\n${after}`);
                // Everything except the token line is unchanged, and there is exactly
                // one token line — two would leave rclone reading the older one.
                const changed = after.split('\n').filter((l) => before.split('\n').indexOf(l) < 0);
                assert.deepEqual(changed.map((l) => l.split('=')[0].trim()), ['token'],
                    `lines other than the token changed: ${changed.join(' | ')}`);
                assert.equal(after.split('\n').filter((l) => /^\s*token\s*=/.test(l)).length, 1);

                // rclone still reads the file, and reads the new value back: proof the
                // merge produced a config, not a plausible-looking string.
                const shown = sb.ok(['rclone', 'config', 'show', gd]).stdout;
                assert.match(shown, /^type\s*=\s*drive$/m);
                assert.ok(shown.indexOf(NEW) >= 0, 'rclone does not read back the token we wrote');
                assert.deepEqual(
                    Rclone.parseConfigFilePath(sb.ok(['rclone', 'config', 'file']).stdout), sb.conf);

                // And the point of writing it through the file at all: no process
                // started by this test could have shown the token in `ps`.
                sb.argvLog.forEach((argv) => {
                    assert.ok(argv.every((a) => a.indexOf(NEW) < 0 && a.indexOf('ya29.new-token') < 0),
                        `the token appeared in argv of: ${argv.slice(0, 3).join(' ')}`);
                });
            });
        }).finally(() => sb.cleanup());
    });

test('updateRemoteToken refuses input that would corrupt the config, changing nothing',
    { skip }, () => {
        const sb = makeSandbox();
        return withCockpit(sb, () => {
            const name = 'hangar_reauth_guard';
            createRemote(sb, name, 'drive', { scope: 'drive.file' });
            stashToken(sb, name, deadToken('ya29.still-here'));
            const before = sb.text();

            // A paste that carries a newline is either a mangled copy or an attempt to
            // append a second key. Either way it must not reach the file.
            return Rclone.updateRemoteToken(name, '{"access_token":"x"}\nserver_side_across_configs = true')
                .then(() => { throw new Error('a multi-line token was accepted'); },
                    (e) => {
                        assert.equal(e.kind, KIND.GENERIC);
                        assert.ok(e.message.indexOf('access_token') < 0,
                            'the rejected token was quoted back in the error message');
                        assert.equal(sb.text(), before, 'the config changed despite the refusal');
                    })
                .then(() => Rclone.updateRemoteToken(name, '   '))
                .then(() => { throw new Error('an empty token was accepted'); },
                    (e) => {
                        assert.equal(e.kind, KIND.GENERIC);
                        assert.equal(sb.text(), before, 'the config changed despite the refusal');
                    });
        }).finally(() => sb.cleanup());
    });

test('providerOfRemote reads back the type of a remote rclone really created',
    { skip }, () => {
        const sb = makeSandbox();
        return withCockpit(sb, () => {
            createRemote(sb, 'hangar_reauth_p_drive', 'drive', { scope: 'drive.file' });
            createRemote(sb, 'hangar_reauth_p_dav', 'webdav',
                { url: 'https://cloud.example.com/dav/', vendor: 'nextcloud' });
            // jottacloud cannot be created non-interactively — `rclone config create`
            // demands an oauth answer it has no headless way to get, which is the very
            // property that puts it in the EXTERNAL group. Its section is written
            // directly, and rclone is then asked whether it accepts it.
            sb.write(sb.text() + '\n[hangar_reauth_p_jotta]\ntype = jottacloud\n');
            assert.ok(sb.ok(['rclone', 'listremotes']).stdout.indexOf('hangar_reauth_p_jotta') >= 0);

            return Rclone.providerOfRemote('hangar_reauth_p_drive').then((p) => {
                assert.ok(p, 'no provider for a drive remote rclone just created');
                assert.equal(p.type, 'drive');
                assert.equal(p.auth, Rclone.AUTH.OAUTH);
                // What the recovery screen shows: the command the user runs on their
                // own computer, naming the type read back from the file.
                assert.equal(Rclone.authorizeCommand(p.id), 'rclone authorize "drive"');
            }).then(() => Rclone.providerOfRemote('hangar_reauth_p_dav')).then((p) => {
                assert.ok(p);
                assert.equal(p.type, 'webdav');
                assert.equal(p.auth, Rclone.AUTH.CREDENTIALS,
                    'a credentials remote must not be offered a token paste');
                assert.equal(Rclone.authorizeCommand(p.id), null);
            }).then(() => Rclone.providerOfRemote('hangar_reauth_p_jotta')).then((p) => {
                assert.ok(p);
                assert.equal(p.auth, Rclone.AUTH.EXTERNAL);
                // rclone cannot authorize it at all, so offering the paste flow would
                // hand the user a command that errors the moment they run it.
                assert.equal(Rclone.authorizeCommand(p.id), null);
                assert.ok(Rclone.externalSetup(p.id).steps.length,
                    'the one provider with no token flow has no instructions either');
            }).then(() => Rclone.providerOfRemote('hangar_reauth_p_absent')).then((p) => {
                // A remote that is not in the file at all: null, not a guess.
                assert.equal(p, null);
            });
        }).finally(() => sb.cleanup());
    });

test('the remote name the UI recovers is the one restic was pointed at', { skip }, () => {
    // Closes the loop: the repository URL in a job is what the failure arrives
    // with, and remoteNameFromRepoUrl is what turns it back into something
    // providerOfRemote can look up.
    const sb = makeSandbox();
    return withCockpit(sb, () => {
        const name = 'hangar_reauth_loop';
        createRemote(sb, name, 'drive', { scope: 'drive.file' });

        const url = `rclone:${name}:backups/nightly`;
        assert.equal(Rclone.remoteNameFromRepoUrl(url), name);

        return Rclone.providerOfRemote(Rclone.remoteNameFromRepoUrl(url)).then((p) => {
            assert.ok(p && p.type === 'drive',
                'the name taken from the repository URL does not find the remote rclone has');
            assert.equal(Rclone.reconnectCommand(name), `rclone config reconnect ${name}:`);
        });
    }).finally(() => sb.cleanup());
});
