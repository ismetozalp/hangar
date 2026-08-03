// tests/unit/rclone-ui.test.js — the "add a cloud destination" wizard.
//
// Two things this file cares about more than anything else.
//
// 1. NOTHING about a provider is duplicated in the UI layer. Every assertion
//    below that concerns fields, masking or OAuth-ness is derived from
//    HangarRclone.PROVIDERS inside the test too, so a provider added to the core
//    table cannot pass here by being forgotten — it is checked automatically.
//
// 2. The pasted OAuth token never becomes reachable. It is asserted absent from
//    the component object, from a JSON dump of it, and from the markup, and it is
//    asserted to reach HangarRclone.createRemote — which is the module that keeps
//    it out of argv.
//
// No DOM and no cockpit global exist except where a test installs one; the final
// test re-asserts that, so a leak from any test above is caught.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Ui = require('../../js/features/rclone-ui.js');
const Rclone = require('../../js/core/rclone.js');
const Errors = require('../../js/core/errors.js');
const Prov = require('../../js/core/provision.js');
const ReposUi = require('../../js/features/repos-ui.js');

const ROOT = path.resolve(__dirname, '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'js/features/rclone-ui.js'), 'utf8');
const MODAL = fs.readFileSync(path.join(ROOT, 'html/modals/rclone-remote.html'), 'utf8');
const REPO_MODAL = fs.readFileSync(path.join(ROOT, 'html/modals/repo-edit.html'), 'utf8');

// A realistic headless-OAuth paste. SYNTHETIC — built in the shape
// rclone.org/remote_setup documents, with the token values replaced.
const TOKEN_JSON = '{"access_token":"ya29.a0FAKE-ACCESS-TOKEN-0123456789","token_type":"Bearer",' +
    '"refresh_token":"1//0fFAKE-REFRESH-TOKEN-9876543210","expiry":"2026-08-01T21:00:00+03:00"}';

const PASTE = [
    '2026/08/01 20:14:02 NOTICE: If your browser doesn\'t open automatically go to the following link:',
    'http://127.0.0.1:53682/auth?state=abc',
    'Paste the following into your remote machine --->',
    TOKEN_JSON,
    '<---End paste'
].join('\n');

// The core modules are singletons shared with the component, so a stub installed
// here is the one the component calls. Always restored.
async function withStubs(pairs, fn) {
    const saved = pairs.map(([obj, key]) => [obj, key, obj[key],
        Object.prototype.hasOwnProperty.call(obj, key)]);
    pairs.forEach(([obj, key, value]) => { obj[key] = value; });
    try {
        return await fn();
    } finally {
        saved.forEach(([obj, key, value, had]) => {
            if (had) obj[key] = value; else delete obj[key];
        });
    }
}

// Node's globalThis is not an EventTarget, so the browser plumbing the component
// guards for has to be installed by hand. Returns the recorded dispatches.
async function withEvents(fn) {
    const seen = [];
    const listeners = {};
    return withStubs([
        [globalThis, 'CustomEvent', class {
            constructor(name, opts) { this.type = name; this.detail = (opts || {}).detail; }
        }],
        [globalThis, 'dispatchEvent', (ev) => {
            seen.push({ type: ev.type, detail: ev.detail });
            (listeners[ev.type] || []).forEach((h) => h(ev));
            return true;
        }],
        [globalThis, 'addEventListener', (name, handler) => {
            (listeners[name] = listeners[name] || []).push(handler);
        }]
    ], () => fn(seen, listeners));
}

// navigator is a getter on globalThis in modern node, so plain assignment is a
// silent no-op — it has to be redefined.
async function withNavigator(fake, fn) {
    const d = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: fake, configurable: true, writable: true });
    try {
        return await fn();
    } finally {
        if (d) Object.defineProperty(globalThis, 'navigator', d);
        else delete globalThis.navigator;
    }
}

// rclone is present unless a test says otherwise; probing is not what most of
// these tests are about.
function present() {
    return () => Promise.resolve({ tool: 'rclone', present: true, ok: true });
}

// Total coercion for an assertion message: String() itself throws on a
// null-prototype object, and a helper that can fail is worse than none.
function label(v) {
    try { return String(v); } catch (e) { return '(unprintable)'; }
}

const OAUTH_IDS = Rclone.providers().filter((p) => p.auth === Rclone.AUTH.OAUTH).map((p) => p.id);
const CRED_IDS = Rclone.providers().filter((p) => p.auth === Rclone.AUTH.CREDENTIALS).map((p) => p.id);

// ------------------------------------------------------------------ grouping

test('providerGroups splits the table by setup experience', () => {
    // Three, not two: some backends have no rclone authorize hook at all, and
    // putting them in either of the other groups would promise a flow that
    // cannot run.
    const groups = Ui.providerGroups();
    assert.deepEqual(groups.map((g) => g.id), ['oauth', 'credentials', 'external']);
});

test('the OAuth group comes first, because it is the one with a prerequisite', () => {
    // Choosing it commits the user to running a command elsewhere; that has to be
    // visible before the click, not after it.
    assert.equal(Ui.providerGroups()[0].id, 'oauth');
});

test('every provider in the table appears in exactly one group', () => {
    const seen = [];
    Ui.providerGroups().forEach((g) => g.providers.forEach((p) => seen.push(p.id)));
    const all = Rclone.providers().map((p) => p.id);
    assert.deepEqual(seen.slice().sort(), all.slice().sort());
    assert.equal(new Set(seen).size, seen.length, 'a provider is listed twice');
});

test('grouping is derived from the table, never from a list of names here', () => {
    Ui.providerGroups().forEach((g) => {
        g.providers.forEach((p) => {
            const want = Rclone.providerFor(p.id).auth;
            assert.equal(g.id, want, p.id + ' is in the wrong group');
        });
    });
});

test('providers keep the table order inside their group', () => {
    const oauth = Ui.providerGroups()[0].providers.map((p) => p.id);
    assert.deepEqual(oauth, OAUTH_IDS);
    const creds = Ui.providerGroups()[1].providers.map((p) => p.id);
    assert.deepEqual(creds, CRED_IDS);
});

test('each group carries a hint that says what the next screen will ask for', () => {
    const [oauth, creds] = Ui.providerGroups();
    assert.match(oauth.hint, /your own computer/i);
    assert.match(creds.hint, /Nothing has to be run on your own computer/i);
});

test('a provider card summarises itself from the core describeProvider', () => {
    const drive = Ui.providerGroups()[0].providers.find((p) => p.id === 'drive');
    assert.equal(drive.label, 'Google Drive');
    assert.equal(drive.type, 'drive');
    assert.equal(drive.oauth, true);
    assert.equal(drive.summary, Rclone.describeProvider('drive'));
});

test('groupIdFor answers for every provider and refuses to guess for none', () => {
    OAUTH_IDS.forEach((id) => assert.equal(Ui.groupIdFor(id), 'oauth'));
    CRED_IDS.forEach((id) => assert.equal(Ui.groupIdFor(id), 'credentials'));
    ['', null, undefined, 'nope', '__proto__', 'constructor']
        .forEach((v) => assert.equal(Ui.groupIdFor(v), ''));
});

// --------------------------------------------------------------- step machine

test('an OAuth provider gets the authorise step, a credentials provider the form', () => {
    assert.deepEqual(Ui.stepsFor('drive'), ['provider', 'authorize', 'name']);
    assert.deepEqual(Ui.stepsFor('webdav'), ['provider', 'details', 'name']);
});

test('the middle step is derived from the table for every provider', () => {
    Rclone.providers().forEach((p) => {
        assert.equal(Ui.stepsFor(p.id)[1], p.auth === Rclone.AUTH.OAUTH ? 'authorize' : 'details', p.id);
        assert.equal(Ui.stepsFor(p.id).length, 3, p.id);
    });
});

test('with nothing chosen there is only the choosing step', () => {
    ['', null, undefined, 'nope', 'constructor'].forEach((v) => {
        assert.deepEqual(Ui.stepsFor(v), ['provider']);
    });
});

test('nextStep walks forward and stops at the end', () => {
    assert.equal(Ui.nextStep('drive', 'provider'), 'authorize');
    assert.equal(Ui.nextStep('drive', 'authorize'), 'name');
    assert.equal(Ui.nextStep('drive', 'name'), null);
    assert.equal(Ui.nextStep('webdav', 'provider'), 'details');
});

test('prevStep walks back and stops at the start', () => {
    assert.equal(Ui.prevStep('drive', 'name'), 'authorize');
    assert.equal(Ui.prevStep('drive', 'authorize'), 'provider');
    assert.equal(Ui.prevStep('drive', 'provider'), null);
});

test('an unknown step navigates nowhere rather than to a guess', () => {
    assert.equal(Ui.nextStep('drive', 'done'), null);
    assert.equal(Ui.prevStep('drive', 'done'), null);
    assert.equal(Ui.stepIndex('drive', 'done'), -1);
});

test('stepIndex numbers the steps in order', () => {
    assert.equal(Ui.stepIndex('drive', 'provider'), 0);
    assert.equal(Ui.stepIndex('drive', 'authorize'), 1);
    assert.equal(Ui.stepIndex('drive', 'name'), 2);
});

test('every step has a human label and an unknown one has none', () => {
    ['provider', 'details', 'authorize', 'name', 'done']
        .forEach((s) => assert.notEqual(Ui.stepLabel(s), ''));
    ['', 'nope', 'constructor', '__proto__', null].forEach((s) => assert.equal(Ui.stepLabel(s), ''));
});

// ------------------------------------------------------------ form descriptors

test('a password-typed field becomes a password input for every provider', () => {
    // This is the flag that keeps a value out of argv in core/rclone.js. If the UI
    // ever stopped honouring it, the secret would be typed in the clear.
    Rclone.providers().forEach((p) => {
        Ui.formFieldsFor(p.id).forEach((f) => {
            const core = Rclone.fieldFor(p.id, f.key);
            assert.equal(f.secret, Rclone.isSecretField(core), p.id + '.' + f.key);
            if (f.secret) {
                assert.equal(f.inputType, 'password', p.id + '.' + f.key);
                assert.equal(f.autocomplete, 'new-password', p.id + '.' + f.key);
            } else {
                assert.notEqual(f.inputType, 'password', p.id + '.' + f.key);
            }
        });
    });
});

test('every declared field is rendered — none is silently dropped', () => {
    Rclone.providers().forEach((p) => {
        assert.deepEqual(Ui.formFieldsFor(p.id).map((f) => f.key),
            p.fields.map((f) => f.key), p.id);
    });
});

test('a select field keeps its options and a select control', () => {
    const scope = Ui.formFieldsFor('drive').find((f) => f.key === 'scope');
    assert.equal(scope.control, 'select');
    assert.deepEqual(scope.options.map((o) => o.value), ['drive', 'drive.file']);
    assert.equal(Ui.formFieldsFor('drive').find((f) => f.key === 'client_id').control, 'input');
});

test('field descriptors are fresh objects — the frozen core table is never touched', () => {
    const f = Ui.formFieldsFor('s3')[0];
    f.label = 'mutated';
    f.options.push({ value: 'x', label: 'x' });
    assert.notEqual(Ui.formFieldsFor('s3')[0].label, 'mutated');
    assert.ok(Object.isFrozen(Rclone.providers()[0]));
});

test('every field gets a dom id, and they are unique within a provider', () => {
    Rclone.providers().forEach((p) => {
        const ids = Ui.formFieldsFor(p.id).map((f) => f.domId);
        ids.forEach((id) => assert.match(id, /^hangar-rclone-f-[a-z0-9_]+$/, p.id));
        assert.equal(new Set(ids).size, ids.length, p.id + ' has duplicate dom ids');
    });
});

test('an unknown provider has no fields rather than a broken form', () => {
    ['', null, 'nope', 'constructor', '__proto__'].forEach((v) => {
        assert.deepEqual(Ui.formFieldsFor(v), []);
        assert.deepEqual(Ui.blankValues(v), {});
        assert.deepEqual(Ui.secretKeys(v), []);
    });
});

test('blankValues gives Alpine a stable, all-string key set', () => {
    const v = Ui.blankValues('sftp');
    assert.deepEqual(Object.keys(v), Rclone.providerFor('sftp').fields.map((f) => f.key));
    Object.keys(v).forEach((k) => assert.equal(v[k], ''));
});

test('secretKeys is derived, so a new secret field is protected automatically', () => {
    Rclone.providers().forEach((p) => {
        const want = p.fields.filter(Rclone.isSecretField).map((f) => f.key);
        assert.deepEqual(Ui.secretKeys(p.id), want, p.id);
    });
});

test('clearSecrets wipes only the secrets and keeps the object identity', () => {
    const values = Ui.blankValues('sftp');
    values.host = 'nas.lan';
    values.user = 'backup';
    values.pass = 'hunter2';
    values.key_file_pass = 'phrase';
    const same = Ui.clearSecrets('sftp', values);
    assert.equal(same, values, 'x-model must stay bound to the same object');
    assert.equal(values.pass, '');
    assert.equal(values.key_file_pass, '');
    assert.equal(values.host, 'nas.lan');
    assert.equal(values.user, 'backup');
});

test('clearSecrets tolerates being handed nothing', () => {
    assert.deepEqual(Ui.clearSecrets('sftp', null), {});
    assert.deepEqual(Ui.clearSecrets(null, undefined), {});
});

test('fieldProblems is the core validator, not a second opinion', () => {
    assert.deepEqual(Ui.fieldProblems('webdav', {}), Rclone.validateFields('webdav', {}));
    assert.ok(Ui.fieldProblems('webdav', {}).length >= 1);
    assert.deepEqual(Ui.fieldProblems('webdav', { url: 'https://cloud.example.com/dav/' }), []);
});

// ------------------------------------------------------------------- naming

test('nameProblems refuses an empty name', () => {
    assert.deepEqual(Ui.nameProblems('', []), ['A remote name is required.']);
});

test('nameProblems refuses the characters that break a repository URL', () => {
    assert.ok(Ui.nameProblems('a:b', []).some((p) => /":"/.test(p)));
    assert.ok(Ui.nameProblems('a/b', []).some((p) => /"\/"/.test(p)));
    assert.ok(Ui.nameProblems('a b', []).some((p) => /spaces/.test(p)));
    assert.ok(Ui.nameProblems('-x', []).some((p) => /command option/.test(p)));
});

test('a duplicate name is refused, because creating it again overwrites a remote', () => {
    const problems = Ui.nameProblems('gdrive', ['gdrive', 'nas']);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /already exists/);
    assert.match(problems[0], /overwrite/);
});

test('a name that is free anywhere in the list passes', () => {
    assert.deepEqual(Ui.nameProblems('gdrive2', ['gdrive', 'nas']), []);
    assert.deepEqual(Ui.nameProblems(' gdrive2 ', ['gdrive']), []);
});

test('the existing list is compared trimmed, so a stray space cannot smuggle a clash through', () => {
    assert.ok(Ui.nameProblems('gdrive', [' gdrive ']).length >= 1);
    assert.ok(Ui.nameProblems(' gdrive', ['gdrive']).length >= 1);
});

test('nameProblems survives hostile input', () => {
    [null, undefined, 42, {}, []].forEach((v) => {
        assert.ok(Array.isArray(Ui.nameProblems(v, null)));
    });
});

test('suggestName offers the provider id, which is already a legal remote name', () => {
    Rclone.providers().forEach((p) => {
        const s = Ui.suggestName(p.id, []);
        assert.equal(s, p.id);
        assert.deepEqual(Rclone.validateRemoteName(s), [], p.id);
    });
});

test('suggestName steps around a name already in use', () => {
    assert.equal(Ui.suggestName('drive', ['drive']), 'drive-2');
    assert.equal(Ui.suggestName('drive', ['drive', 'drive-2']), 'drive-3');
});

test('suggestName has nothing to offer for an unknown provider', () => {
    assert.equal(Ui.suggestName('nope', []), '');
    assert.equal(Ui.suggestName('', []), '');
});

// ------------------------------------------------------- the headless story

test('the authorise command is the documented one, run on the user\'s machine', () => {
    assert.equal(Ui.authorizeCommandFor('drive'), 'rclone authorize "drive"');
    assert.equal(Ui.authorizeCommandFor('onedrive'), 'rclone authorize "onedrive"');
});

test('an unknown provider yields no command rather than one that would fail when pasted', () => {
    ['', null, 'nope', 'constructor'].forEach((v) => assert.equal(Ui.authorizeCommandFor(v), ''));
});

test('the explanation names the actual cause: the callback goes to 127.0.0.1', () => {
    const why = Ui.whyHeadless();
    assert.match(why, /127\.0\.0\.1/);
    assert.match(why, /your browser cannot reach/i);
    assert.match(why, /computer you are sitting at/i);
});

test('the authorise instructions are three, numbered, in the order they are performed', () => {
    const steps = Ui.authorizeSteps('drive');
    assert.deepEqual(steps.map((s) => s.n), [1, 2, 3]);
    // Only the first step is a command; the other two are what happens next.
    assert.equal(steps[0].command, 'rclone authorize "drive"');
    assert.equal(steps[1].command, '');
    assert.equal(steps[2].command, '');
    assert.match(steps[0].text, /your own computer/i);
    assert.match(steps[1].text, /Paste the following into your remote machine/);
    assert.match(steps[2].text, /paste it below/i);
});

test('there are no authorise instructions for a provider that does not need them', () => {
    assert.deepEqual(Ui.authorizeSteps('nope'), []);
    assert.deepEqual(Ui.authorizeSteps(''), []);
});

test('Google Drive says plainly that the shared client ID is rate-limited', () => {
    const a = Ui.clientIdAdvice('drive');
    assert.equal(a.provider, 'drive');
    // A warning, not a footnote: a throttled Drive backup looks like hangar's fault.
    assert.equal(a.severity, 'warning');
    assert.match(a.title, /slow without your own client ID/i);
    assert.match(a.text, /rate-limited/i);
    assert.match(a.text, /own client ID/i);
});

test('the other OAuth providers get the same advice at a calmer volume', () => {
    OAUTH_IDS.filter((id) => id !== 'drive').forEach((id) => {
        const a = Ui.clientIdAdvice(id);
        assert.equal(a.severity, 'info', id);
        assert.equal(a.text, Rclone.providerFor(id).notes, id);
    });
});

test('a credentials provider gets no client-ID advice at all', () => {
    CRED_IDS.forEach((id) => assert.equal(Ui.clientIdAdvice(id), null, id));
    assert.equal(Ui.clientIdAdvice('nope'), null);
});

test('providerNote passes the table note through and is empty for an unknown one', () => {
    assert.equal(Ui.providerNote('mega'), Rclone.providerFor('mega').notes);
    assert.equal(Ui.providerNote('nope'), '');
});

// ---------------------------------------------------------- the pasted token

test('a whole terminal paste, markers and log lines included, yields the token', () => {
    assert.equal(Ui.extractToken(PASTE), TOKEN_JSON);
    assert.deepEqual(Ui.tokenProblems(PASTE), []);
});

test('a bare token with no markers is accepted too', () => {
    assert.deepEqual(Ui.tokenProblems(TOKEN_JSON), []);
    assert.deepEqual(Ui.tokenProblems('  ' + TOKEN_JSON + '\n'), []);
});

test('a CRLF paste from a Windows terminal is accepted', () => {
    assert.deepEqual(Ui.tokenProblems(PASTE.replace(/\n/g, '\r\n')), []);
});

test('an empty paste asks for the paste rather than calling it invalid', () => {
    ['', '   ', '\n\n', null, undefined].forEach((v) => {
        const p = Ui.tokenProblems(v);
        assert.equal(p.length, 1);
        assert.match(p[0], /Paste the block/);
    });
});

test('a paste with nothing token-shaped in it says so and says what to copy', () => {
    const p = Ui.tokenProblems('I ran the command and it opened a browser');
    assert.equal(p.length, 1);
    assert.match(p[0], /does not contain an authorisation token/i);
    assert.match(p[0], /Paste the following into your remote machine/);
});

test('a token truncated by the terminal is reported as truncated, not as invalid', () => {
    // Markers present, body too short to be a token: the user did the right thing
    // and the terminal ate it. Telling them "invalid" sends them to re-check a
    // command that worked.
    const cut = 'Paste the following into your remote machine --->\nya29.abc\n<---End paste';
    const p = Ui.tokenProblems(cut);
    assert.equal(p.length, 1);
    assert.match(p[0], /cut\s*short/i);
});

test('the authorisation URL printed above the token is never mistaken for it', () => {
    const p = Ui.tokenProblems('go to http://127.0.0.1:53682/auth?state=abcdefghijklmnop');
    assert.equal(p.length, 1);
    assert.match(p[0], /does not contain an authorisation token/i);
});

// -------------------------------------------------------------- messages

test('the success message names the service and the remote', () => {
    const m = Ui.successMessage('gdrive', 'drive');
    assert.match(m, /Google Drive/);
    assert.match(m, /"gdrive"/);
});

test('createdDetail carries the name, the provider and the rclone backend', () => {
    assert.deepEqual(Ui.createdDetail('  gdrive ', 'drive'),
        { name: 'gdrive', provider: 'drive', type: 'drive' });
    assert.deepEqual(Ui.createdDetail('x', 'nope'), { name: 'x', provider: '', type: '' });
});

test('the missing-rclone message offers installation rather than a shell command', () => {
    const m = Ui.missingRcloneMessage();
    assert.match(m.title, /rclone is not installed/i);
    assert.equal(m.actionLabel, 'Install rclone');
    // hangar never names a package manager: six distro families, three tools.
    assert.ok(!/dnf|apt|zypper|pacman/i.test(m.title + m.text));
});

test('toAlert types the level from the error and redacts the raw output', () => {
    const e = Errors.create(Errors.KIND.NETWORK, 'no such host',
        { stderr: 'rclone: https://alice:hunter2@cloud.example.com/dav failed' });
    const a = Ui.toAlert(e, 'Add a cloud destination');
    assert.equal(a.kind, Errors.KIND.NETWORK);
    assert.equal(a.message, 'no such host');
    assert.equal(a.context, 'Add a cloud destination');
    assert.ok(!/hunter2/.test(a.detail), 'the password survived redaction: ' + a.detail);
});

test('toAlert has nothing to say about nothing', () => {
    assert.equal(Ui.toAlert(null, 'x'), null);
    assert.equal(Ui.toAlert(undefined), null);
});

// ------------------------------------------------------------- the component

test('the component starts on the choosing step with nothing filled in', () => {
    const c = Ui.hangarRcloneUi();
    assert.equal(c.step, 'provider');
    assert.equal(c.providerId, '');
    assert.equal(c.hasToken, false);
    assert.equal(c.stepCount(), 1);
    assert.equal(c.stepNumber(), 1);
});

test('init subscribes to the open event and to provisioning news', async () => {
    await withEvents(async (seen, listeners) => {
        const c = Ui.hangarRcloneUi();
        assert.equal(c.init(), true);
        assert.ok(listeners['hangar:rclone-remote']);
        assert.ok(listeners['hangar:provisioned']);
    });
});

test('init is a no-op with no event plumbing, so the module loads under node', () => {
    const c = Ui.hangarRcloneUi();
    assert.equal(c.init(), false);
});

test('open resets the wizard and remembers the remotes that already exist', async () => {
    await withStubs([[Prov, 'probe', present()]], async () => {
        const c = Ui.hangarRcloneUi();
        c.step = 'name';
        c.providerId = 'drive';
        await c.open({ existing: [' gdrive ', 'nas'] });
        assert.equal(c.step, 'provider');
        assert.equal(c.providerId, '');
        assert.deepEqual(c.existing, ['gdrive', 'nas']);
    });
});

test('open tolerates being handed no detail at all', async () => {
    await withStubs([[Prov, 'probe', present()]], async () => {
        const c = Ui.hangarRcloneUi();
        await c.open();
        assert.deepEqual(c.existing, []);
        await c.open(null);
        assert.deepEqual(c.existing, []);
    });
});

test('an absent rclone is reported, and installing it is offered through hangar', async () => {
    await withStubs([[Prov, 'probe', () => Promise.resolve({ present: false, ok: false })]], async () => {
        await withEvents(async (seen) => {
            const c = Ui.hangarRcloneUi();
            await c.open({});
            assert.equal(c.missing(), true);
            assert.equal(c.installRclone(), true);
            assert.deepEqual(seen, [{ type: 'hangar:provision', detail: ['rclone'] }]);
        });
    });
});

test('a probe that throws does not block the wizard on a guess', async () => {
    await withStubs([[Prov, 'probe', () => Promise.reject(new Error('bus is gone'))]], async () => {
        const c = Ui.hangarRcloneUi();
        await c.checkRclone();
        // "I could not tell" is not evidence of absence; createRemote will produce
        // a real typed error if rclone truly is not there.
        assert.equal(c.missing(), false);
        assert.equal(c.rclone.checked, true);
    });
});

test('choosing an OAuth provider lands on the authorise step with a suggested name', async () => {
    const c = Ui.hangarRcloneUi();
    c.existing = ['drive'];
    assert.equal(c.choose('drive'), true);
    assert.equal(c.step, 'authorize');
    assert.equal(c.name, 'drive-2');
    assert.equal(c.stepNumber(), 2);
    assert.equal(c.stepCount(), 3);
    assert.deepEqual(Object.keys(c.values), Rclone.providerFor('drive').fields.map((f) => f.key));
});

test('choosing a credentials provider lands on the form step', () => {
    const c = Ui.hangarRcloneUi();
    assert.equal(c.choose('webdav'), true);
    assert.equal(c.step, 'details');
    assert.equal(c.providerLabel(), 'WebDAV (Nextcloud, ownCloud, …)');
});

test('choosing nothing is refused with a message rather than a dead button', () => {
    const c = Ui.hangarRcloneUi();
    ['', null, 'nope', 'constructor'].forEach((v) => {
        assert.equal(c.choose(v), false);
        assert.equal(c.step, 'provider');
        assert.equal(c.problems.length, 1);
    });
});

test('changing your mind about the provider does not carry the old answers over', () => {
    // Two backends that both have a key called `user` do not mean the same thing
    // by it, and a silently reused password is unreproducible for support.
    const c = Ui.hangarRcloneUi();
    c.choose('mega');
    c.values.user = 'alice@example.com';
    c.values.pass = 'hunter2';
    c.choose('ftp');
    assert.equal(c.values.pass, '');
    assert.equal(c.values.user, '');
});

test('Continue refuses to leave the credentials step with a required field empty', () => {
    const c = Ui.hangarRcloneUi();
    c.choose('s3');
    assert.equal(c.next(), false);
    assert.equal(c.step, 'details');
    assert.ok(c.problems.length >= 1);
    assert.deepEqual(c.problems, Rclone.validateFields('s3', c.values));
});

test('a complete credentials form advances to the naming step', () => {
    const c = Ui.hangarRcloneUi();
    c.choose('s3');
    c.values.access_key_id = 'AKIAFAKE';
    c.values.secret_access_key = 'shhh';
    assert.equal(c.next(), true);
    assert.equal(c.step, 'name');
    assert.deepEqual(c.problems, []);
});

test('Continue refuses to leave the authorise step without a token', () => {
    // Without it the remote is created unauthenticated and fails at the first
    // backup, hours later, in a unit nobody is watching.
    const c = Ui.hangarRcloneUi();
    c.choose('drive');
    assert.equal(c.next(), false);
    assert.equal(c.step, 'authorize');
    assert.match(c.problems[0], /Paste the block/);
});

test('a paste in the box is accepted by Continue without a second click', () => {
    const c = Ui.hangarRcloneUi();
    c.choose('dropbox');
    c.paste = PASTE;
    assert.equal(c.next(), true);
    assert.equal(c.step, 'name');
    assert.equal(c.hasToken, true);
    assert.equal(c.paste, '', 'the paste must not linger on screen');
});

test('accepting a paste empties the textarea and only reports that a token exists', () => {
    const c = Ui.hangarRcloneUi();
    c.choose('box');
    c.paste = PASTE;
    assert.equal(c.acceptPaste(), true);
    assert.equal(c.paste, '');
    assert.equal(c.hasToken, true);
    assert.deepEqual(c.problems, []);
});

test('a bad paste is rejected with the specific reason and no token is held', () => {
    const c = Ui.hangarRcloneUi();
    c.choose('drive');
    c.paste = 'nothing useful here';
    assert.equal(c.acceptPaste(), false);
    assert.equal(c.hasToken, false);
    assert.match(c.problems[0], /does not contain an authorisation token/i);
});

test('the token is nowhere on the component — not as a property, not in a dump', () => {
    const c = Ui.hangarRcloneUi();
    c.choose('drive');
    c.paste = PASTE;
    c.acceptPaste();
    const dump = JSON.stringify(c);
    assert.ok(!dump.includes('ya29'), 'the access token is reachable from the component');
    assert.ok(!dump.includes('1//0f'), 'the refresh token is reachable from the component');
    Object.keys(c).forEach((k) => {
        assert.ok(!/ya29|1\/\/0f/.test(String(c[k] === null ? '' : c[k])), 'token in ' + k);
    });
});

test('clearToken forgets the token without ever revealing it', () => {
    const c = Ui.hangarRcloneUi();
    c.choose('drive');
    c.paste = PASTE;
    c.acceptPaste();
    assert.equal(c.clearToken(), true);
    assert.equal(c.hasToken, false);
    assert.equal(c.paste, '');
});

test('Back walks the wizard backwards and stops at the first step', () => {
    const c = Ui.hangarRcloneUi();
    c.choose('webdav');
    c.values.url = 'https://cloud.example.com/dav/';
    c.next();
    assert.equal(c.step, 'name');
    assert.equal(c.back(), true);
    assert.equal(c.step, 'details');
    assert.equal(c.back(), true);
    assert.equal(c.step, 'provider');
    assert.equal(c.back(), false);
});

test('Create stays disabled until an OAuth remote actually has its token', () => {
    const c = Ui.hangarRcloneUi();
    c.choose('drive');
    c.step = 'name';
    assert.equal(c.canCreate(), false);
    c.paste = PASTE;
    c.acceptPaste();
    assert.equal(c.canCreate(), true);
});

test('Create stays disabled with no name and while rclone is missing', () => {
    const c = Ui.hangarRcloneUi();
    c.choose('webdav');
    c.name = '   ';
    assert.equal(c.canCreate(), false);
    c.name = 'nc';
    assert.equal(c.canCreate(), true);
    c.rclone = { checked: true, present: false };
    assert.equal(c.canCreate(), false);
});

test('submit hands the token to core/rclone.js, which is what keeps it out of argv', async () => {
    const calls = [];
    await withStubs([[Rclone, 'createRemote', (name, id, values, token) => {
        calls.push({ name, id, values, token });
        return Promise.resolve({ name: name, type: 'drive', secrets: 1 });
    }]], async () => {
        await withEvents(async (seen) => {
            const c = Ui.hangarRcloneUi();
            c.choose('drive');
            c.paste = PASTE;
            c.acceptPaste();
            c.name = '  gdrive ';
            assert.equal(await c.submit(), true);
            assert.equal(calls.length, 1);
            assert.equal(calls[0].name, 'gdrive');
            assert.equal(calls[0].id, 'drive');
            assert.equal(calls[0].token, TOKEN_JSON);
            assert.equal(c.step, 'done');
            assert.equal(c.created, 'gdrive');
            assert.deepEqual(seen, [{
                type: 'hangar:rclone-remote-created',
                detail: { name: 'gdrive', provider: 'drive', type: 'drive' }
            }]);
        });
    });
});

test('a successful create forgets every secret it was holding', async () => {
    await withStubs([[Rclone, 'createRemote', (name) => Promise.resolve({ name: name })]], async () => {
        await withEvents(async () => {
            const c = Ui.hangarRcloneUi();
            c.choose('webdav');
            c.values.url = 'https://cloud.example.com/dav/';
            c.values.user = 'alice';
            c.values.pass = 'hunter2';
            c.name = 'nc';
            assert.equal(await c.submit(), true);
            assert.equal(c.values.pass, '', 'the password is still in the component');
            // Non-secret answers stay: they are what the success message describes.
            assert.equal(c.values.user, 'alice');
            assert.ok(!JSON.stringify(c).includes('hunter2'));
        });
    });
});

test('a failed create shows a typed alert and leaves the user where they were', async () => {
    const boom = Errors.create(Errors.KIND.NETWORK, 'no such host: cloud.example.com');
    await withStubs([[Rclone, 'createRemote', () => Promise.reject(boom)]], async () => {
        await withEvents(async (seen) => {
            const c = Ui.hangarRcloneUi();
            c.choose('webdav');
            c.values.url = 'https://cloud.example.com/dav/';
            assert.equal(c.next(), true);
            c.name = 'nc';
            assert.equal(await c.submit(), false);
            assert.equal(c.step, 'name');
            assert.equal(c.alert.kind, Errors.KIND.NETWORK);
            assert.equal(c.busy, false);
            // Nothing was created, so nothing is announced.
            assert.deepEqual(seen, []);
        });
    });
});

test('submit refuses a bad name before it reaches rclone', async () => {
    let called = false;
    await withStubs([[Rclone, 'createRemote', () => { called = true; return Promise.resolve({}); }]], async () => {
        const c = Ui.hangarRcloneUi();
        c.choose('webdav');
        c.existing = ['nc'];
        c.name = 'nc';
        assert.equal(await c.submit(), false);
        assert.equal(called, false);
        assert.match(c.problems[0], /already exists/);
    });
});

test('submit cannot be started twice by an impatient double click', async () => {
    let calls = 0;
    await withStubs([[Rclone, 'createRemote', (name) => { calls++; return Promise.resolve({ name: name }); }]], async () => {
        await withEvents(async () => {
            const c = Ui.hangarRcloneUi();
            c.choose('webdav');
            c.values.url = 'https://cloud.example.com/dav/';
            c.name = 'nc';
            const first = c.submit();
            assert.equal(await c.submit(), false);
            await first;
            assert.equal(calls, 1);
        });
    });
});

test('the step counter never reads "step 0" — the result is the last step, not a fourth', async () => {
    await withStubs([[Rclone, 'createRemote', (name) => Promise.resolve({ name: name })]], async () => {
        await withEvents(async () => {
            const c = Ui.hangarRcloneUi();
            c.choose('webdav');
            c.values.url = 'https://cloud.example.com/dav/';
            c.next();
            c.name = 'nc';
            await c.submit();
            assert.equal(c.step, 'done');
            assert.equal(c.stepNumber(), 3);
            assert.equal(c.stepCount(), 3);
            assert.equal(c.stepTitle(), 'Ready');
        });
    });
});

test('closing the wizard forgets the token and the pasted block', () => {
    const c = Ui.hangarRcloneUi();
    c.choose('drive');
    c.paste = PASTE;
    c.acceptPaste();
    assert.equal(c.close(), true);
    assert.equal(c.hasToken, false);
    assert.equal(c.paste, '');
});

test('copyCommand uses the clipboard when the browser allows it', async () => {
    const written = [];
    await withNavigator({ clipboard: { writeText: (t) => { written.push(t); return Promise.resolve(); } } }, async () => {
        const c = Ui.hangarRcloneUi();
        c.choose('drive');
        assert.equal(await c.copyCommand(), true);
        assert.deepEqual(written, ['rclone authorize "drive"']);
        assert.equal(c.copied, true);
    });
});

test('a refused clipboard is not a failure — the command is on screen to select', async () => {
    await withNavigator({ clipboard: { writeText: () => Promise.reject(new Error('denied')) } }, async () => {
        const c = Ui.hangarRcloneUi();
        c.choose('drive');
        assert.equal(await c.copyCommand(), false);
        assert.equal(c.copied, false);
    });
});

test('there is nothing to copy before a provider is chosen', async () => {
    const c = Ui.hangarRcloneUi();
    assert.equal(await c.copyCommand(), false);
});

// ------------------------------------------------------ the repository editor

test('the repository editor opens the wizard and passes the remotes it knows', async () => {
    await withEvents(async (seen) => {
        const e = ReposUi.hangarRepoEdit();
        e.remotes = ['nas'];
        assert.equal(e.openRcloneWizard(), true);
        assert.deepEqual(seen, [{ type: 'hangar:rclone-remote', detail: { existing: ['nas'] } }]);
    });
});

test('a created remote re-reads the list and selects the new one', async () => {
    const Repos = require('../../js/core/repos.js');
    await withStubs([[Repos, 'listRcloneRemotes', () => Promise.resolve(['nas', 'gdrive'])]], async () => {
        const e = ReposUi.hangarRepoEdit();
        e.receive({ mode: 'add', form: { id: 'r', kind: 'rclone' } });
        assert.equal(await e.remoteCreated({ name: 'gdrive' }), 'gdrive');
        assert.deepEqual(e.remotes, ['nas', 'gdrive']);
        assert.equal(e.form.remote, 'gdrive');
    });
});

test('a remote the re-read missed is still offered, so the dropdown is never short', async () => {
    const Repos = require('../../js/core/repos.js');
    await withStubs([[Repos, 'listRcloneRemotes', () => Promise.resolve(['nas'])]], async () => {
        const e = ReposUi.hangarRepoEdit();
        e.receive({ mode: 'add', form: { id: 'r', kind: 'rclone' } });
        await e.remoteCreated({ name: 'gdrive' });
        assert.deepEqual(e.remotes, ['nas', 'gdrive']);
        assert.equal(e.form.remote, 'gdrive');
    });
});

test('a nameless creation event still refreshes the list without selecting anything', async () => {
    const Repos = require('../../js/core/repos.js');
    await withStubs([[Repos, 'listRcloneRemotes', () => Promise.resolve(['nas'])]], async () => {
        const e = ReposUi.hangarRepoEdit();
        e.receive({ mode: 'add', form: { id: 'r', kind: 'rclone' } });
        assert.equal(await e.remoteCreated({}), '');
        assert.deepEqual(e.remotes, ['nas']);
    });
});

test('a creation event never rewrites a form that is not an rclone repository', async () => {
    const Repos = require('../../js/core/repos.js');
    await withStubs([[Repos, 'listRcloneRemotes', () => Promise.resolve(['gdrive'])]], async () => {
        const e = ReposUi.hangarRepoEdit();
        e.receive({ mode: 'add', form: { id: 'r', kind: 'local' } });
        await e.remoteCreated({ name: 'gdrive' });
        assert.equal(e.form.remote, undefined);
        assert.equal(e.kind, 'local');
    });
});

test('the repository editor still says where remotes come from', () => {
    const remote = ReposUi.fieldsFor('rclone').find((f) => f.name === 'remote');
    assert.match(remote.help, /rclone configuration/);
    // The old copy said hangar does not create remotes. It does now.
    assert.ok(!/does not create remotes/.test(remote.help));
});

// ------------------------------------------------------------------- markup

test('the repository editor grew a real button that opens the wizard', () => {
    assert.match(REPO_MODAL, /openRcloneWizard\(\)/);
    const btn = /<button[^>]*openRcloneWizard[^>]*>/.exec(REPO_MODAL);
    assert.ok(btn, 'the wizard is opened by something that is not a button');
    assert.match(btn[0], /type="button"/);
    assert.match(REPO_MODAL, /aria-label="Add a cloud destination[^"]*"/);
});

test('every button in the wizard is a real typed button', () => {
    const buttons = MODAL.match(/<button[^>]*>/g) || [];
    assert.ok(buttons.length >= 6, buttons.length + ' buttons');
    for (const b of buttons) assert.match(b, /type="(button|submit)"/, b);
    // The close icon has no text, so it needs a name of its own.
    assert.match(MODAL, /class="btn-close"[^>]*aria-label="Close"/);
});

test('the wizard has no clickable non-buttons', () => {
    const clickable = MODAL.match(/<(?!button)[a-z]+[^>]*@click/g) || [];
    assert.deepEqual(clickable, [], 'clickable non-button: ' + clickable.join(', '));
    assert.ok(!/onclick=/i.test(MODAL));
});

test('every input and select in the wizard can be reached from a label', () => {
    const controls = MODAL.match(/<(input|select|textarea)[^>]*/g) || [];
    assert.ok(controls.length >= 4);
    for (const el of controls)
        assert.ok(/\sid="/.test(el) || /\s:id="/.test(el), 'no id to label: ' + el);
    assert.match(MODAL, /<label class="form-label" :for="f\.domId">/);
    assert.match(MODAL, /<label class="form-label" for="hangar-rclone-name">/);
    assert.match(MODAL, /<label class="form-label" for="hangar-rclone-paste">/);
});

test('the wizard masks secret fields by binding the type to the table', () => {
    // Never a literal type="password" per provider: the masking decision is
    // formFieldsFor's, so a new secret field is masked by declaring it.
    assert.match(MODAL, /:type="f\.inputType"/);
    assert.match(MODAL, /:autocomplete="f\.autocomplete"/);
});

test('the wizard never renders the token back to the screen', () => {
    // The paste box is bound to `paste`, which is emptied the moment it parses.
    // Nothing may bind to a token at all.
    assert.ok(!/x-text="[^"]*token/i.test(MODAL), 'a template expression renders a token');
    assert.ok(!/x-model="[^"]*token/i.test(MODAL));
    assert.match(MODAL, /x-model="paste"/);
    assert.match(MODAL, /x-if="hasToken"/);
});

test('the wizard announces its step, its errors and its result', () => {
    assert.match(MODAL, /role="status" aria-live="polite"/);
    assert.match(MODAL, /x-show="problems\.length" role="alert"/);
    const alerts = MODAL.match(/class="alert |:class="alertClass|class="alert"/g) || [];
    const announced = MODAL.match(/role="(alert|status|note)"/g) || [];
    assert.ok(announced.length >= alerts.length - 1,
        announced.length + ' announced for ' + alerts.length + ' alerts');
});

test('the Drive rate-limit warning is in the markup, not buried in a tooltip', () => {
    assert.match(MODAL, /advice\(\)\.title/);
    assert.match(MODAL, /advice\(\)\.text/);
    assert.match(MODAL, /whyHeadless\(\)/);
    assert.match(MODAL, /authorizeSteps\(\)/);
});

test('no x-show in the wizard is defeated by a Bootstrap display utility', () => {
    // Bootstrap's display utilities are !important and beat x-show's inline
    // display:none — the element would stay permanently visible.
    MODAL.split('\n').forEach((line, i) => {
        if (!line.includes('x-show')) return;
        assert.ok(!/\bd-(flex|block|inline|inline-flex|inline-block|grid|table)\b/.test(line),
            'line ' + (i + 1) + ': ' + line.trim());
    });
});

test('the wizard is registered so it actually loads and its partial is injected', () => {
    const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.match(index, /js\/features\/rclone-ui\.js/);
    const boot = fs.readFileSync(path.join(ROOT, 'js/boot.js'), 'utf8');
    assert.match(boot, /html\/modals\/rclone-remote\.html/);
    assert.match(MODAL, /x-data="hangarRcloneUi\(\)"/);
    assert.match(MODAL, /id="hangar-rclone-remote"/);
    assert.equal(Ui.MODAL_ID, 'hangar-rclone-remote');
});

test('the feature is never called Time Machine', () => {
    assert.ok(!/time\s*machine/i.test(SOURCE));
    assert.ok(!/time\s*machine/i.test(MODAL));
});

// =====================================================================
// Adversarial hardening pass.
//
// The wizard is the only place in hangar where a user types a cloud password
// and pastes an OAuth token, so the questions below are: where can that value
// still be after the dialog closes, and what does the screen say when things go
// wrong.
// =====================================================================

// One marker so a leak is found by a single search, in any direction.
const CANARY = 'CANARY-a-secret-value-0001';

// Deep search: a token can hide in a nested object, a getter or an array as
// easily as in a top-level string, and "I checked the obvious properties" is
// how a leak survives a review.
function findCanary(value, path, seen) {
    path = path || '$';
    seen = seen || new Set();
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value.includes('CANARY') ? path : null;
    if (typeof value !== 'object' && typeof value !== 'function') return null;
    if (seen.has(value)) return null;
    seen.add(value);
    let hit = null;
    Object.keys(value).forEach((k) => {
        if (hit) return;
        let v;
        try { v = value[k]; } catch (e) { return; }
        hit = findCanary(v, path + '.' + k, seen);
    });
    return hit;
}

function fakeElement() {
    const handlers = {};
    return {
        handlers,
        addEventListener(name, fn) { (handlers[name] = handlers[name] || []).push(fn); },
        fire(name) { (handlers[name] || []).forEach((fn) => fn()); }
    };
}

// A document with exactly one element, so the component can find its modal and
// nothing else. Always removed again — the last test in this file re-asserts it.
async function withDocument(el, fn) {
    return withStubs([[globalThis, 'document', { getElementById: () => el }]], fn);
}

const OAUTH_PASTE = 'Paste the following into your remote machine --->\n' +
    '{"access_token":"' + CANARY + '","refresh_token":"' + CANARY + '-refresh"}\n<---End paste';

// ------------------------------------------------------- nothing on the screen

test('toAlert redacts the message as well as the detail', () => {
    // classifyRcloneError puts rclone's stderr in `message`, and rclone quotes
    // back the URL it was handed — so the credential arrives in the message at
    // least as often as in the detail. An alert is a screenshot waiting to happen.
    const e = Errors.create(Errors.KIND.GENERIC,
        'Failed to create file system for "nc:": url="https://alice:hunter2@cloud/dav" password=hunter2',
        { stderr: 'secret_access_key = hunter2' });
    const a = Ui.toAlert(e, 'Add a cloud destination');
    assert.equal(/hunter2/.test(a.message), false, 'the message leaked: ' + a.message);
    assert.equal(/hunter2/.test(a.detail), false, 'the detail leaked: ' + a.detail);
    // …and it still says something a human can act on.
    assert.match(a.message, /Failed to create file system/);
});

test('toAlert leaves an ordinary message exactly as it was', () => {
    // Redaction that mangles "no such host" would cost a support round-trip for
    // nothing.
    ['no such host', 'rclone is not installed on this host.',
        'The pasted token must be a single line.', 'connection refused']
        .forEach((m) => {
            const a = Ui.toAlert(Errors.create(Errors.KIND.NETWORK, m), 'x');
            assert.equal(a.message, m);
        });
});

test('toAlert is total on anything that is not a HangarError', () => {
    [new Error('plain'), 'a string', 0, [], {}, { message: null }, Object.create(null)]
        .forEach((e) => {
            const a = Ui.toAlert(e, 'ctx');
            if (a === null) return;
            assert.equal(typeof a.message, 'string');
            assert.notEqual(a.message, '');
            assert.equal(typeof a.kind, 'string');
        });
});

// --------------------------------------------------- nothing left in the state

test('a dialog dismissed with Escape wipes the password and the token', async () => {
    // Bootstrap closes on Escape and on a backdrop click without any of our
    // buttons being pressed, so close() is not the only way out. Every dismissal
    // ends in 'hidden.bs.modal'.
    const el = fakeElement();
    await withDocument(el, () => withEvents(async () => {
        await withStubs([[Prov, 'probe', present()]], async () => {
            const c = Ui.hangarRcloneUi();
            c.init();
            assert.ok(el.handlers['hidden.bs.modal'], 'nothing listens for the dismissal');

            c.choose('webdav');
            c.values.pass = CANARY;
            c.values.user = 'alice';

            el.fire('hidden.bs.modal');

            assert.equal(c.values.pass, '', 'the password survived the dismissal');
            assert.equal(findCanary(c), null, 'a secret survived at ' + findCanary(c));
            // The non-secret answers are kept: reopening should not retype them.
            assert.equal(c.values.user, 'alice');
        });
    }));
});

test('a dialog dismissed with Escape wipes an accepted OAuth token', async () => {
    const el = fakeElement();
    await withDocument(el, () => withEvents(async () => {
        await withStubs([[Prov, 'probe', present()]], async () => {
            const c = Ui.hangarRcloneUi();
            c.init();
            c.choose('drive');
            c.paste = OAUTH_PASTE;
            assert.equal(c.acceptPaste(), true);
            assert.equal(c.hasToken, true);

            el.fire('hidden.bs.modal');

            assert.equal(c.hasToken, false, 'the token was still held');
            assert.equal(c.paste, '');
            assert.equal(findCanary(c), null, 'a secret survived at ' + findCanary(c));
            assert.equal(JSON.stringify(c).includes('CANARY'), false);
        });
    }));
});

test('init still works, and still returns false, with no DOM at all', () => {
    const c = Ui.hangarRcloneUi();
    assert.equal(c.init(), false);
    assert.equal(typeof globalThis.document, 'undefined');
});

test('a failed creation leaves the secrets in place to retry, and off the screen', async () => {
    await withEvents(async () => {
        const failure = Errors.create(Errors.KIND.NETWORK,
            'Failed to create file system: pass=' + CANARY + ' dial tcp: i/o timeout');
        await withStubs([
            [Prov, 'probe', present()],
            [Rclone, 'createRemote', () => Promise.reject(failure)]
        ], async () => {
            const c = Ui.hangarRcloneUi();
            c.choose('webdav');
            c.values.url = 'https://cloud.example/dav/';
            c.values.pass = CANARY;
            c.name = 'nc';

            assert.equal(await c.submit(), false);
            // Kept, because the user is about to press the button again.
            assert.equal(c.values.pass, CANARY);
            // …but nowhere the screen can show it.
            assert.equal(findCanary(c.alert), null, 'the alert leaked the password');
            assert.equal(findCanary(c.problems), null, 'the problem list leaked the password');
            assert.equal(c.busy, false);
        });
    });
});

test('a successful creation forgets every secret before it announces anything', async () => {
    await withEvents(async (seen) => {
        let sawToken = '';
        await withStubs([
            [Prov, 'probe', present()],
            [Rclone, 'createRemote', (name, id, values, token) => {
                sawToken = token;
                return Promise.resolve({ name: name, type: 'drive', secrets: 1 });
            }]
        ], async () => {
            const c = Ui.hangarRcloneUi();
            c.choose('drive');
            c.values.client_secret = CANARY;
            c.paste = OAUTH_PASTE;
            c.acceptPaste();
            c.name = 'gdrive';

            assert.equal(await c.submit(), true);
            // The token did reach the module that keeps it out of argv…
            assert.ok(sawToken.includes('CANARY'), 'the token never reached createRemote');
            // …and nothing is left here.
            assert.equal(findCanary(c), null, 'a secret survived at ' + findCanary(c));
            assert.equal(c.values.client_secret, '');
            assert.equal(c.hasToken, false);
            // The announcement carries a name and a type, never a value.
            const created = seen.filter((e) => e.type === Ui.EVENT_CREATED);
            assert.equal(created.length, 1);
            assert.equal(findCanary(created[0].detail), null);
        });
    });
});

test('choosing a different destination drops the token and the answers of the old one', async () => {
    await withEvents(async () => {
        const c = Ui.hangarRcloneUi();
        c.choose('drive');
        c.values.client_secret = CANARY;
        c.paste = OAUTH_PASTE;
        c.acceptPaste();

        c.choose('webdav');
        assert.equal(c.hasToken, false);
        assert.equal(findCanary(c), null, 'a secret survived the switch at ' + findCanary(c));

        // …and the token really is gone, not merely hidden: creating now must be
        // impossible for an OAuth destination.
        c.choose('drive');
        assert.equal(c.canCreate(), false);
    });
});

test('the token is unreachable from the component by any inspection', async () => {
    await withEvents(async () => {
        const c = Ui.hangarRcloneUi();
        c.choose('drive');
        c.paste = OAUTH_PASTE;
        c.acceptPaste();

        assert.equal(c.hasToken, true);
        // Not a property, not on the prototype, not in a JSON dump, not in the
        // output of any getter the markup could call.
        assert.equal(findCanary(c), null, 'reachable at ' + findCanary(c));
        assert.equal(JSON.stringify(c).includes('CANARY'), false);
        Object.getOwnPropertyNames(c).forEach((k) => {
            assert.equal(String(k).toLowerCase().includes('token') && typeof c[k] === 'string',
                false, 'a token-ish string property: ' + k);
        });
        ['successMessage', 'authorizeCommand', 'whyHeadless', 'note', 'stepTitle']
            .forEach((m) => assert.equal(String(c[m]()).includes('CANARY'), false, m));
        assert.equal(findCanary(c.authorizeSteps()), null);
        assert.equal(findCanary(c.advice()), null);
        assert.equal(findCanary(c.fields()), null);
    });
});

test('clearToken forgets without ever showing what it forgot', async () => {
    await withEvents(async () => {
        const c = Ui.hangarRcloneUi();
        c.choose('drive');
        c.paste = OAUTH_PASTE;
        c.acceptPaste();
        assert.equal(c.clearToken(), true);
        assert.equal(c.hasToken, false);
        assert.equal(c.paste, '');
        assert.equal(findCanary(c), null);
        assert.equal(c.canCreate(), false);
    });
});

// ------------------------------------------------------------- hostile input

test('tokenProblems never echoes the paste back at the user', () => {
    ['', '   ', CANARY, 'Paste the following into your remote machine --->\n' + CANARY,
        'Paste the following into your remote machine --->\n<---End paste',
        '{"access_token":"' + CANARY + '"}'.slice(0, 20), OAUTH_PASTE, null, undefined, {}, 0]
        .forEach((p) => {
            const problems = Ui.tokenProblems(p);
            assert.ok(Array.isArray(problems), label(p));
            problems.forEach((m) => {
                assert.equal(m.includes('CANARY'), false, 'echoed the paste: ' + m);
                assert.equal(typeof m, 'string');
            });
        });
});

test('tokenProblems says which of the three things went wrong', () => {
    assert.match(Ui.tokenProblems('')[0], /Paste the block/);
    assert.match(Ui.tokenProblems('nothing useful here')[0], /does not contain/);
    // Present, extracted, but not a token: the "cut short" case, which is the
    // commonest and needs a different instruction from "you pasted nothing".
    assert.match(Ui.tokenProblems('Paste the following into your remote machine --->\nshort\n<---End paste')[0],
        /cut short|does not contain/);
    assert.deepEqual(Ui.tokenProblems(OAUTH_PASTE), []);
});

test('a field validation message never quotes the value it is rejecting', () => {
    Rclone.providers().forEach((p) => {
        const values = {};
        p.fields.forEach((f) => { values[f.key] = CANARY + '\nevil = 1'; });
        Ui.fieldProblems(p.id, values).forEach((m) =>
            assert.equal(m.includes('CANARY'), false, p.id + ': ' + m));
        const bad = {};
        p.fields.forEach((f) => { values[f.key] = ''; });
        Ui.fieldProblems(p.id, bad).forEach((m) =>
            assert.equal(m.includes('CANARY'), false, p.id + ': ' + m));
    });
});

test('nameProblems never throws and never invents a problem for a good name', () => {
    [null, undefined, 0, {}, [], Symbol('s'), Object.create(null), '\0', '-x', 'a:b',
        'a'.repeat(500), '😀', '‮x']
        .forEach((n) => {
            [null, undefined, 'not-an-array', [], [null, 0, {}], ['gdrive']].forEach((existing) => {
                const problems = Ui.nameProblems(n, existing);
                assert.ok(Array.isArray(problems), label(n));
                problems.forEach((m) => assert.equal(typeof m, 'string'));
            });
        });
    assert.deepEqual(Ui.nameProblems('  gdrive  ', ['other']), []);
    assert.equal(Ui.nameProblems('gdrive', ['  gdrive  ']).length, 1);
});

test('suggestName only ever suggests a name validateRemoteName accepts', () => {
    Rclone.providers().forEach((p) => {
        [[], [p.id], [p.id, p.id + '-2'], Array.from({ length: 120 }, (x, i) => p.id + '-' + i)]
            .forEach((existing) => {
                const n = Ui.suggestName(p.id, existing);
                if (n === '') return;
                assert.deepEqual(Rclone.validateRemoteName(n), [], p.id + ' -> ' + n);
                assert.equal(existing.includes(n), false, p.id + ' suggested a name in use');
            });
    });
    assert.equal(Ui.suggestName('nope', []), '');
    assert.equal(Ui.suggestName(null, null), '');
});

test('every pure helper in the wizard answers rather than throws', () => {
    const hostile = [null, undefined, '', '   ', 0, NaN, true, {}, [], Symbol('s'), () => {},
        Object.create(null), 1n, new Date(), /re/, 'a'.repeat(50000), '\0', '-x', 'a:b',
        '😀', '‮',
        { toString() { throw new Error('boom'); } },
        new Proxy({}, { get() { throw new Error('trap'); },
            getOwnPropertyDescriptor() { throw new Error('trap'); } })];

    hostile.forEach((h) => {
        ['groupIdFor', 'stepLabel', 'stepsFor', 'formFieldsFor', 'blankValues', 'secretKeys',
            'authorizeCommandFor', 'authorizeSteps', 'clientIdAdvice', 'providerNote',
            'extractToken', 'tokenProblems', 'providerCard']
            .forEach((fn) => assert.doesNotThrow(() => Ui[fn](h), fn + ' with ' + label(h)));
        ['stepIndex', 'nextStep', 'prevStep', 'clearSecrets', 'fieldProblems', 'nameProblems',
            'suggestName', 'successMessage', 'createdDetail', 'toAlert']
            .forEach((fn) => {
                assert.doesNotThrow(() => Ui[fn](h, h), fn + ' with ' + label(h));
                assert.doesNotThrow(() => Ui[fn]('drive', h), fn + ' with drive, ' + label(h));
            });
    });
});

test('clearSecrets wipes what it can even when a value refuses to be written', () => {
    // It runs on the success path, after the remote already exists. A values
    // object that cannot be written must not turn "your remote is ready" into an
    // error alert.
    const frozen = Object.freeze({ pass: CANARY, url: 'https://x/' });
    assert.doesNotThrow(() => Ui.clearSecrets('webdav', frozen));

    const partly = { url: 'https://x/', pass: CANARY, key_file_pass: CANARY };
    Object.defineProperty(partly, 'pass', { value: CANARY, writable: false, configurable: true });
    assert.doesNotThrow(() => Ui.clearSecrets('sftp', partly));
    assert.equal(partly.key_file_pass, '', 'one unwritable key stopped the rest of the wipe');
});

test('clearSecrets clears exactly the secret keys the table declares, and nothing else', () => {
    Rclone.providers().forEach((p) => {
        const values = {};
        p.fields.forEach((f) => { values[f.key] = CANARY; });
        Ui.clearSecrets(p.id, values);
        p.fields.forEach((f) => {
            if (f.type === 'password') assert.equal(values[f.key], '', p.id + '.' + f.key);
            else assert.equal(values[f.key], CANARY, p.id + '.' + f.key + ' was wiped needlessly');
        });
    });
});

test('every provider field key is a plain identifier, so no form value lands on a prototype', () => {
    // blankValues builds a plain object keyed on these. A key of __proto__ would
    // silently not become a property, and the field would read back as undefined.
    Rclone.providers().forEach((p) => {
        const blank = Ui.blankValues(p.id);
        p.fields.forEach((f) => {
            assert.match(f.key, /^[a-z][a-z0-9_]*$/, p.id + '.' + f.key);
            assert.ok(Object.prototype.hasOwnProperty.call(blank, f.key), p.id + '.' + f.key);
            assert.equal(blank[f.key], '');
        });
        assert.equal(Object.keys(blank).length, p.fields.length, p.id);
    });
});

test('providerCard refuses to build a card it cannot build, rather than killing the render', () => {
    assert.equal(Ui.providerCard(null), null);
    assert.equal(Ui.providerCard(undefined), null);
    assert.equal(Ui.providerCard('drive'), null);
    assert.equal(Ui.providerCard(new Proxy({}, { get() { throw new Error('trap'); } })), null);
    // The real thing still works, and every group is still complete.
    const groups = Ui.providerGroups();
    const counted = groups.reduce((n, g) => n + g.providers.length, 0);
    assert.equal(counted, Rclone.providers().length);
    groups.forEach((g) => g.providers.forEach((c) => assert.ok(c && c.id && c.label && c.summary)));
});

test('the markup never renders the token, and never widens a password field', () => {
    // A secret on screen is a secret in a screenshot, in a screen share and in
    // the browser's form restore.
    assert.equal(/x-(text|model|html)\s*=\s*"[^"]*\btoken\b/.test(MODAL), false,
        'the markup binds something called token');
    assert.match(MODAL, /:type="f\.inputType"/);
    assert.match(MODAL, /:autocomplete="f\.autocomplete"/);
    // hasToken is a boolean; the token itself is a closure variable with no name
    // any template expression can reach.
    assert.match(MODAL, /x-if="hasToken"/);
    Rclone.providers().forEach((p) => {
        Ui.formFieldsFor(p.id).forEach((f) => {
            assert.equal(f.inputType, f.secret ? 'password' : 'text', p.id + '.' + f.key);
            assert.equal(f.autocomplete, f.secret ? 'new-password' : 'off', p.id + '.' + f.key);
        });
    });
});

// ==========================================================================
// Reconnect mode — the journey back from an expired authorisation.
//
// The rule these tests exist to hold: this is the SAME step the user already
// walked when they created the remote, pointed at one that exists. A second
// paste box, a second token path or a second set of instructions would be a
// second place for the token handling to drift, and the token handling is the
// part that must not.
// ==========================================================================

const EXTERNAL_IDS = Rclone.providers().filter((p) => p.auth === Rclone.AUTH.EXTERNAL).map((p) => p.id);

test('reconnect is one step: the provider and the name are already known', () => {
    // Asking again is asking the user to re-derive facts rclone's own config
    // already holds — and to get the name wrong is to overwrite a working remote.
    for (const id of OAUTH_IDS)
        assert.deepEqual(Ui.stepsFor(id, 'reconnect'), ['authorize'], id);
    // The creation flow is untouched by the new argument.
    for (const id of OAUTH_IDS)
        assert.deepEqual(Ui.stepsFor(id), ['provider', 'authorize', 'name'], id);
    for (const id of CRED_IDS)
        assert.deepEqual(Ui.stepsFor(id), ['provider', 'details', 'name'], id);
});

test('a backend rclone cannot authorize gets instructions, never a paste box', () => {
    // `rclone authorize jottacloud` answers "not supported by this backend", so
    // there is no token for the user to paste and no command worth printing.
    assert.ok(EXTERNAL_IDS.length, 'guard: the table still has an EXTERNAL provider');
    for (const id of EXTERNAL_IDS) {
        assert.deepEqual(Ui.stepsFor(id, 'reconnect'), ['instructions'], id);
        assert.equal(Ui.authorizeCommandFor(id), null, id);
    }
    // And a remote whose backend hangar has no entry for is treated the same way.
    assert.deepEqual(Ui.stepsFor('', 'reconnect'), ['instructions']);
    assert.deepEqual(Ui.stepsFor('not-a-provider', 'reconnect'), ['instructions']);
});

test('the step machine agrees with itself in reconnect mode', () => {
    assert.equal(Ui.stepIndex('drive', 'authorize', 'reconnect'), 0);
    assert.equal(Ui.nextStep('drive', 'authorize', 'reconnect'), null);
    assert.equal(Ui.prevStep('drive', 'authorize', 'reconnect'), null);
    assert.equal(Ui.stepLabel('instructions'), 'Sign in with rclone itself');
});

test('modeOf reads repair mode off the open event, and only off a real name', () => {
    assert.equal(Ui.modeOf({ reauthorize: 'gdrive' }), 'reconnect');
    assert.equal(Ui.modeOf({ existing: ['gdrive'] }), 'create');
    assert.equal(Ui.modeOf({ reauthorize: '   ' }), 'create');
    assert.equal(Ui.modeOf({ reauthorize: null }), 'create');
    assert.equal(Ui.modeOf(null), 'create');
    assert.equal(Ui.modeOf(undefined), 'create');
});

test('the dialog names the remote it is repairing, in the title and in the prose', () => {
    assert.equal(Ui.reconnectTitle('gdrive'), 'Sign in to gdrive again');
    assert.equal(Ui.reconnectTitle('  '), 'Sign in again');
    const intro = Ui.reconnectIntro('gdrive', 'drive');
    assert.match(intro, /Google Drive/);
    assert.match(intro, /gdrive/);
    // Present tense: this already happened, it is not a warning about later.
    assert.match(intro, /are failing/);
});

test('the dialog answers "why not rclone config reconnect", because everyone asks', () => {
    const why = Ui.whyNotReconnect('gdrive');
    assert.match(why, /rclone config reconnect gdrive:/);
    assert.match(why, /127\.0\.0\.1/);
    // A name rclone would refuse produces no command rather than a wrong one.
    assert.ok(!/reconnect\s+:/.test(Ui.whyNotReconnect('has space')));
});

test('the external instructions are the provider table\'s own, not a second copy', () => {
    for (const id of EXTERNAL_IDS) {
        const ins = Ui.reconnectInstructions(id, 'jotta');
        const core = Rclone.externalSetup(id);
        assert.deepEqual(ins.steps, core.steps, id);
        assert.equal(ins.command, core.command, id);
        assert.match(ins.reason, /rclone has no automated sign-in/i);
        // Never a token flow for a backend that has none.
        assert.ok(!/paste/i.test(ins.reason), id);
    }
});

test('a credentials backend is told what it actually needs, not offered a token', () => {
    const ins = Ui.reconnectInstructions('webdav', 'nc');
    assert.match(ins.reason, /credentials/i);
    // It says there is NO token to paste, rather than offering one.
    assert.match(ins.reason, /no token to paste/i);
    assert.equal(ins.command, 'rclone config');
    // The remote's name is in the steps: picking the wrong one in `rclone config`
    // is how people end up with a second, half-configured remote.
    assert.ok(ins.steps.some((s) => s.includes('nc')));
});

test('an unidentifiable remote still gets usable instructions', () => {
    const ins = Ui.reconnectInstructions('', 'mystery');
    assert.match(ins.reason, /backend hangar does not know/i);
    assert.equal(ins.command, 'rclone config');
    assert.ok(ins.steps.length >= 2);
});

test('the verification wording never claims more than it checked', () => {
    assert.equal(Ui.verifyMessage(''), '');
    assert.match(Ui.verifyMessage('running'), /Checking/);
    assert.match(Ui.verifyMessage('ok', ''), /answered/);
    const failed = Ui.verifyMessage('failed', 'no such host');
    assert.match(failed, /sign-in was saved/);
    assert.match(failed, /no such host/);
});

test('openReconnect reads the provider from rclone\'s config, and asks for nothing', async () => {
    await withStubs([
        [Prov, 'probe', present()],
        [Rclone, 'providerOfRemote', async (name) => {
            assert.equal(name, 'gdrive');
            return Rclone.providerFor('drive');
        }]
    ], async () => {
        const c = Ui.hangarRcloneUi();
        await c.open({ reauthorize: 'gdrive', repoId: 'nas' });
        assert.equal(c.reconnecting(), true);
        assert.equal(c.mode, 'reconnect');
        assert.equal(c.remote, 'gdrive');
        assert.equal(c.repoId, 'nas');
        assert.equal(c.providerId, 'drive');
        assert.equal(c.step, 'authorize');
        assert.deepEqual(c.steps(), ['authorize']);
        assert.equal(c.title(), 'Sign in to gdrive again');
        // The command shown is the same one creation shows for this provider.
        assert.equal(c.authorizeCommand(), Rclone.authorizeCommand('drive'));
    });
});

test('a remote hangar cannot identify opens on instructions rather than on nothing', async () => {
    await withStubs([
        [Prov, 'probe', present()],
        [Rclone, 'providerOfRemote', async () => { throw Errors.create('GENERIC', 'no rclone here'); }]
    ], async () => {
        const c = Ui.hangarRcloneUi();
        await c.open({ reauthorize: 'mystery' });
        assert.equal(c.step, 'instructions');
        assert.equal(c.providerId, '');
        // Not an error box on top of it: "hangar could not tell what this is" is
        // exactly what the instructions step answers.
        assert.equal(c.alert, null);
        assert.equal(c.canReconnect(), false);
    });
});

test('Jottacloud is never shown a flow that cannot complete', async () => {
    await withStubs([
        [Prov, 'probe', present()],
        [Rclone, 'providerOfRemote', async () => Rclone.providerFor('jottacloud')]
    ], async () => {
        const c = Ui.hangarRcloneUi();
        await c.open({ reauthorize: 'jotta' });
        assert.equal(c.step, 'instructions');
        assert.equal(c.canReconnect(), false);
        assert.deepEqual(c.instructions().steps, Rclone.externalSetup('jottacloud').steps);
    });
});

test('reconnect sends the token to updateRemoteToken — never to createRemote', async () => {
    const calls = [];
    await withStubs([
        [Prov, 'probe', present()],
        [Rclone, 'providerOfRemote', async () => Rclone.providerFor('drive')],
        [Rclone, 'createRemote', async () => { calls.push(['createRemote']); return {}; }],
        [Rclone, 'updateRemoteToken', async (name, token) => {
            calls.push(['updateRemoteToken', name, token]);
            return { name: name, updated: 'token' };
        }]
    ], async () => {
        await withEvents(async (seen) => {
            const c = Ui.hangarRcloneUi();
            await c.open({ reauthorize: 'gdrive', repoId: 'nas' });
            c.paste = PASTE;
            assert.equal(await c.submit(), true);
            assert.equal(calls.length, 1, 'nothing was created');
            assert.equal(calls[0][0], 'updateRemoteToken');
            assert.equal(calls[0][1], 'gdrive');
            assert.equal(calls[0][2], TOKEN_JSON, 'the parsed token, markers stripped');
            assert.equal(c.step, 'done');
            // And the world is told, as a repair rather than as a creation.
            const ev = seen.filter((e) => e.type === 'hangar:rclone-remote-reconnected');
            assert.equal(ev.length, 1);
            assert.deepEqual(ev[0].detail, { name: 'gdrive', repoId: 'nas', provider: 'drive' });
            assert.equal(seen.some((e) => e.type === 'hangar:rclone-remote-created'), false);
        });
    });
});

test('the pasted token is unreachable from the component and gone once it is used', async () => {
    await withStubs([
        [Prov, 'probe', present()],
        [Rclone, 'providerOfRemote', async () => Rclone.providerFor('drive')],
        [Rclone, 'updateRemoteToken', async () => ({ name: 'gdrive', updated: 'token' })]
    ], async () => {
        await withEvents(async (seen) => {
            const c = Ui.hangarRcloneUi();
            await c.open({ reauthorize: 'gdrive' });
            c.paste = PASTE;
            await c.submit();
            const dump = JSON.stringify(c);
            assert.ok(!dump.includes('ya29.a0FAKE-ACCESS-TOKEN-0123456789'), 'access token reachable');
            assert.ok(!dump.includes('1//0fFAKE-REFRESH-TOKEN-9876543210'), 'refresh token reachable');
            assert.equal(c.paste, '', 'the textarea still holds the paste');
            assert.equal(c.hasToken, false);
            for (const ev of seen)
                assert.ok(!JSON.stringify(ev.detail || {}).includes('ya29.'), 'a token left in an event');
        });
    });
});

test('a successful reconnect proves it, by re-testing the repository', async () => {
    let ran = 0;
    await withStubs([
        [Prov, 'probe', present()],
        [Rclone, 'providerOfRemote', async () => Rclone.providerFor('drive')],
        [Rclone, 'updateRemoteToken', async () => ({ name: 'gdrive', updated: 'token' })]
    ], async () => {
        await withEvents(async () => {
            const c = Ui.hangarRcloneUi();
            await c.open({
                reauthorize: 'gdrive',
                repoId: 'nas',
                verify: async () => { ran++; return { message: 'The repository answered: 2.0 KiB.' }; }
            });
            c.paste = PASTE;
            await c.submit();
            assert.equal(ran, 1);
            assert.equal(c.verifyState, 'ok');
            assert.match(c.verifyText(), /answered/);
            assert.equal(c.verifyClass(), 'text-success');
        });
    });
});

test('a re-test that fails does not turn a saved sign-in into a failed repair', async () => {
    await withStubs([
        [Prov, 'probe', present()],
        [Rclone, 'providerOfRemote', async () => Rclone.providerFor('drive')],
        [Rclone, 'updateRemoteToken', async () => ({ name: 'gdrive', updated: 'token' })]
    ], async () => {
        await withEvents(async () => {
            const c = Ui.hangarRcloneUi();
            await c.open({
                reauthorize: 'gdrive',
                verify: async () => { throw Errors.create('NETWORK', 'dial tcp: no such host'); }
            });
            c.paste = PASTE;
            assert.equal(await c.submit(), true, 'the token WAS written');
            assert.equal(c.step, 'done');
            assert.equal(c.verifyState, 'failed');
            assert.match(c.verifyText(), /no such host/);
            assert.equal(c.alert, null, 'the repair itself did not fail');
        });
    });
});

test('a verify that leaks a credential is redacted before it is shown', async () => {
    await withStubs([
        [Prov, 'probe', present()],
        [Rclone, 'providerOfRemote', async () => Rclone.providerFor('drive')],
        [Rclone, 'updateRemoteToken', async () => ({ name: 'gdrive', updated: 'token' })]
    ], async () => {
        await withEvents(async () => {
            const c = Ui.hangarRcloneUi();
            await c.open({
                reauthorize: 'gdrive',
                verify: async () => {
                    throw Errors.create('GENERIC', 'Fatal: unable to open repository at ' +
                        'rest:https://alice:hunter2@rest.example:8000/');
                }
            });
            c.paste = PASTE;
            await c.submit();
            assert.equal(c.verifyState, 'failed');
            assert.ok(!/hunter2/.test(c.verifyText()), 'a password reached the screen');
        });
    });
});

test('a failed reconnect keeps the user on the step that can retry it', async () => {
    await withStubs([
        [Prov, 'probe', present()],
        [Rclone, 'providerOfRemote', async () => Rclone.providerFor('drive')],
        [Rclone, 'updateRemoteToken', async () => {
            throw Errors.create('GENERIC', 'could not write rclone.conf');
        }]
    ], async () => {
        await withEvents(async (seen) => {
            const c = Ui.hangarRcloneUi();
            await c.open({ reauthorize: 'gdrive' });
            c.paste = PASTE;
            assert.equal(await c.submit(), false);
            assert.equal(c.step, 'authorize');
            assert.ok(c.alert);
            assert.equal(c.alert.level, 'danger');
            assert.match(c.alert.message, /rclone\.conf/);
            assert.equal(seen.some((e) => e.type === 'hangar:rclone-remote-reconnected'), false);
        });
    });
});

test('the Reconnect button is offered only when it can do something', async () => {
    await withStubs([
        [Prov, 'probe', present()],
        [Rclone, 'providerOfRemote', async () => Rclone.providerFor('drive')]
    ], async () => {
        const c = Ui.hangarRcloneUi();
        await c.open({ reauthorize: 'gdrive' });
        assert.equal(c.canReconnect(), false, 'nothing pasted yet');
        c.paste = 'x';
        assert.equal(c.canReconnect(), true, 'a paste is enough — submit parses it');
        c.busy = true;
        assert.equal(c.canReconnect(), false);
        c.busy = false;
        c.remote = '';
        assert.equal(c.canReconnect(), false);
        // And it is never offered in creation mode, where "Create destination" is.
        const d = Ui.hangarRcloneUi();
        assert.equal(d.canReconnect(), false);
    });
});

test('a paste that is not a token refuses with the reason, and writes nothing', async () => {
    let wrote = 0;
    await withStubs([
        [Prov, 'probe', present()],
        [Rclone, 'providerOfRemote', async () => Rclone.providerFor('drive')],
        [Rclone, 'updateRemoteToken', async () => { wrote++; return {}; }]
    ], async () => {
        await withEvents(async () => {
            const c = Ui.hangarRcloneUi();
            await c.open({ reauthorize: 'gdrive' });
            c.paste = 'I clicked allow in the browser';
            assert.equal(await c.submit(), false);
            assert.equal(wrote, 0);
            assert.equal(c.problems.length, 1);
            assert.match(c.problems[0], /authorisation token/i);
            assert.equal(c.step, 'authorize');
        });
    });
});

test('Continue means nothing in a one-step repair, and does not move', async () => {
    await withStubs([
        [Prov, 'probe', present()],
        [Rclone, 'providerOfRemote', async () => Rclone.providerFor('drive')]
    ], async () => {
        const c = Ui.hangarRcloneUi();
        await c.open({ reauthorize: 'gdrive' });
        assert.equal(c.next(), false);
        assert.equal(c.step, 'authorize');
        assert.equal(c.back(), false);
        assert.equal(c.step, 'authorize');
    });
});

test('opening the wizard normally afterwards is a creation again, with nothing carried over', async () => {
    await withStubs([
        [Prov, 'probe', present()],
        [Rclone, 'providerOfRemote', async () => Rclone.providerFor('drive')]
    ], async () => {
        const c = Ui.hangarRcloneUi();
        await c.open({ reauthorize: 'gdrive', repoId: 'nas' });
        await c.open({ existing: ['gdrive'] });
        assert.equal(c.reconnecting(), false);
        assert.equal(c.mode, 'create');
        assert.equal(c.remote, '');
        assert.equal(c.repoId, '');
        assert.equal(c.step, 'provider');
        assert.equal(c.verifyState, '');
        assert.equal(c.title(), 'Add a cloud destination');
    });
});

test('repair mode shows neither step until it knows which one is right', async () => {
    // The two possibilities are "paste a token" and "hangar cannot do this for
    // you". Flashing the wrong one of those is worse than a moment with neither.
    let release = null;
    const pending = new Promise((r) => { release = r; });
    await withStubs([
        [Prov, 'probe', present()],
        [Rclone, 'providerOfRemote', () => pending]
    ], async () => {
        const c = Ui.hangarRcloneUi();
        const opening = c.open({ reauthorize: 'gdrive' });
        await Promise.resolve();
        assert.equal(c.at('authorize'), false);
        assert.equal(c.at('instructions'), false);
        assert.equal(c.reconnecting(), true, 'the dialog still says what it is for');
        release(Rclone.providerFor('drive'));
        await opening;
        assert.equal(c.step, 'authorize');
    });
    assert.match(MODAL, /Reading this destination's settings/);
});

test('the markup reuses the one paste box rather than growing a second', () => {
    // The duplication that would matter most: two textareas means two places for
    // the token handling to drift apart.
    assert.equal((MODAL.match(/<textarea/g) || []).length, 1);
    assert.equal((MODAL.match(/x-model="paste"/g) || []).length, 1);
    // Repair mode is rendered by the SAME authorize step.
    assert.match(MODAL, /x-if="at\('authorize'\)"/);
    assert.match(MODAL, /x-show="reconnecting\(\) && at\('authorize'\)"/);
    assert.match(MODAL, /x-if="at\('instructions'\)"/);
    // Real buttons, and the title is bound so the dialog says which job it is on.
    assert.match(MODAL, /x-text="title\(\)"/);
    assert.ok(!/<a [^>]*@click="submit\(\)"/.test(MODAL), 'actions must be buttons');
});

test('repair mode does not re-ask for settings that are still correct', () => {
    // Re-showing client_id and scope empty invites someone to blank a working
    // setting while fixing an unrelated one.
    assert.match(MODAL, /x-if="!reconnecting\(\)"/);
    assert.match(MODAL, /x-show="!reconnecting\(\)"/);
});

test('the module still touches no DOM and no cockpit at load time', () => {
    // Re-asserted at the END: every test above installs and removes its own fakes,
    // and a leak would make the first assertion in this file a lie.
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.cockpit, 'undefined');
    assert.equal(typeof globalThis.dispatchEvent, 'undefined');
    // The wizard never reaches for cockpit itself: every system call goes through
    // HangarRclone or HangarProvision, which own the spawn and the degradation.
    assert.ok(!/\bcockpit\s*[.[]/.test(SOURCE), 'rclone-ui.js touches cockpit directly');
    const topLevel = SOURCE.split('\n').filter((l) => /^\s{4}(const|let|var)\s/.test(l));
    for (const l of topLevel)
        assert.ok(!/\bdocument\b/.test(l), 'load-time DOM access: ' + l.trim());
});
