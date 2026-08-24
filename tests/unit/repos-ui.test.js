// tests/unit/repos-ui.test.js — the Repositories screen.
//
// The point of extracting fieldsFor / formStateToRepo / repoToFormState /
// validateForm is that the interesting decisions are testable without a browser.
// These tests exercise those directly, plus the error-to-action mapping, which is
// the part of the screen a user only ever meets on a bad day.
//
// No DOM and no cockpit global are installed except where a test names one — that
// is exactly the constraint the module has to satisfy.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');

const Ui = require('../../js/features/repos-ui.js');
const Repos = require('../../js/core/repos.js');
const Errors = require('../../js/core/errors.js');
const Restic = require('../../js/engine/restic.js');
const Secrets = require('../../js/core/secrets.js');
const Config = require('../../js/core/config.js');

const ROOT = path.resolve(__dirname, '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'js/features/repos-ui.js'), 'utf8');
const MODAL = fs.readFileSync(path.join(ROOT, 'html/modals/repo-edit.html'), 'utf8');

// The core modules are singletons shared with the component, so a stub installed on
// one is the stub the component calls. Always restored, so no test can leak a fake
// into the next one — the "no cockpit at load time" invariant depends on it.
async function withStubs(pairs, fn) {
    const saved = pairs.map(([obj, key]) => [obj, key, obj[key]]);
    pairs.forEach(([obj, key, value]) => { obj[key] = value; });
    try {
        return await fn();
    } finally {
        saved.forEach(([obj, key, value]) => { obj[key] = value; });
    }
}

async function withCockpit(fake, fn) {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'cockpit');
    const prev = globalThis.cockpit;
    globalThis.cockpit = fake;
    try {
        return await fn();
    } finally {
        if (had) globalThis.cockpit = prev;
        else delete globalThis.cockpit;
    }
}

// The dialogs live on app.js's global; features resolve them lazily by name.
async function withDialogs(fake, fn) {
    return withStubs([[globalThis, 'HangarDialogs', fake]], fn);
}

// A repository that is valid everywhere, so a test failure is never about the fixture.
function repoRow(id) {
    return Ui.toRow({ id: id || 'nas', kind: 'local', path: '/srv/backups/hangar' });
}

function rejectsWith(exitStatus, message) {
    return function () { return Promise.reject({ exit_status: exitStatus, message: message || '' }); };
}

// A complete, valid form for each backend. Used for the round-trip and the
// "a good form has no problems" tests.
const GOOD = {
    local: { id: 'local-disk', label: 'USB disk', path: '/srv/backups/hangar' },
    sftp: { id: 'nas', label: 'Office NAS', user: 'backup', host: 'nas.lan', path: '/vol/restic' },
    rest: { id: 'rest', label: '', url: 'https://rest.example:8000/' },
    s3: { id: 's3', label: '', endpoint: 's3.eu-central-1.amazonaws.com', bucket: 'hangar',
        prefix: 'hosts/db01', accessKeyId: 'AKIA', secretAccessKey: 'shhh' },
    b2: { id: 'b2', label: '', bucket: 'hangar', prefix: 'db01', accountId: 'aid', accountKey: 'akey' },
    azure: { id: 'azure', label: '', container: 'hangar', prefix: 'db01',
        accountName: 'acct', accountKey: 'akey' },
    gs: { id: 'gs', label: '', bucket: 'hangar', prefix: 'db01', projectId: 'proj-1' },
    rclone: { id: 'rclone', label: '', remote: 'gdrive', prefix: 'backups' }
};

function form(kind, overrides) {
    return Object.assign(Ui.blankForm(kind), { kind: kind }, GOOD[kind], overrides || {});
}

// --------------------------------------------------------------- module shape

test('module loads with no DOM and no cockpit global', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.cockpit, 'undefined');
    assert.equal(typeof Ui.fieldsFor, 'function');
});

test('both Alpine factories are registered on the global', () => {
    assert.equal(typeof globalThis.hangarReposUi, 'function');
    assert.equal(typeof globalThis.hangarRepoEdit, 'function');
});

test('the screen never uses the rejected product name', () => {
    // The feature is Logbook. This screen links to it, so the wrong name would
    // most plausibly appear here. Assembled, never spelled out — see the fuller
    // check at the end of this file.
    const forbidden = new RegExp(['time', '\\s*', 'machine'].join(''), 'i');
    assert.ok(!forbidden.test(Ui.TEMPLATE));
    assert.ok(!forbidden.test(JSON.stringify(Ui.KIND_LABEL)));
});

// -------------------------------------------------------------- fieldsFor

test('fieldsFor covers every backend HangarRepos knows about', () => {
    for (const kind of Repos.KINDS)
        assert.ok(Ui.fieldsFor(kind).length > 0, `${kind} has no fields`);
});

test('fieldsFor marks exactly the fields HangarRepos.REQUIRED lists', () => {
    // The whole reason fieldsFor exists: the form must not carry a second opinion
    // about what is mandatory.
    for (const kind of Repos.KINDS) {
        const required = Ui.fieldsFor(kind).filter((f) => f.required).map((f) => f.name).sort();
        assert.deepEqual(required, Repos.REQUIRED[kind].slice().sort(), kind);
    }
});

test('fieldsFor returns nothing for an unknown kind', () => {
    assert.deepEqual(Ui.fieldsFor('dropbox'), []);
    assert.deepEqual(Ui.fieldsFor(''), []);
    assert.deepEqual(Ui.fieldsFor(null), []);
});

test('fieldsFor local asks only for a path', () => {
    assert.deepEqual(Ui.fieldsFor('local').map((f) => f.name), ['path']);
});

test('fieldsFor sftp orders user, host, path with user optional', () => {
    const f = Ui.fieldsFor('sftp');
    assert.deepEqual(f.map((x) => x.name), ['user', 'host', 'path']);
    assert.equal(f[0].required, false);
    assert.equal(f[1].required, true);
});

test('fieldsFor s3 asks for endpoint and bucket plus optional credentials', () => {
    const f = Ui.fieldsFor('s3');
    const names = f.map((x) => x.name);
    assert.deepEqual(names, ['endpoint', 'bucket', 'prefix', 'accessKeyId', 'secretAccessKey']);
    assert.equal(f.find((x) => x.name === 'prefix').required, false);
});

test('fieldsFor rclone renders the remote as a picker', () => {
    const remote = Ui.fieldsFor('rclone').find((f) => f.name === 'remote');
    assert.equal(remote.type, 'select');
    assert.equal(remote.required, true);
});

test('credential fields are secret and rendered as password inputs', () => {
    for (const kind of ['s3', 'b2', 'azure']) {
        const secrets = Ui.fieldsFor(kind).filter((f) => f.secret);
        assert.ok(secrets.length >= 1, kind);
        for (const s of secrets) assert.equal(s.type, 'password');
    }
});

test('every field descriptor carries a human label and a type', () => {
    for (const kind of Repos.KINDS)
        for (const f of Ui.fieldsFor(kind)) {
            assert.ok(typeof f.label === 'string' && f.label.length > 0, `${kind}.${f.name}`);
            assert.match(f.type, /^(text|password|select)$/, `${kind}.${f.name}`);
        }
});

// -------------------------------------------------------------- form state

test('blankForm produces an all-string form for the kind', () => {
    const f = Ui.blankForm('s3');
    assert.equal(f.kind, 's3');
    for (const d of Ui.fieldsFor('s3')) assert.equal(f[d.name], '');
    assert.equal(f.id, '');
    assert.equal(f.label, '');
});

test('blankForm falls back to local for an unknown kind', () => {
    assert.equal(Ui.blankForm('nope').kind, 'local');
});

test('formStateToRepo / repoToFormState round-trip for all 8 backends', () => {
    for (const kind of Repos.KINDS) {
        const start = form(kind);
        const repo = Ui.formStateToRepo(kind, start);
        assert.equal(repo.kind, kind);
        assert.deepEqual(Ui.repoToFormState(repo), start, kind);
        // …and the repository is one restic actually accepts.
        assert.ok(Repos.buildUrl(repo).length > 0, kind);
    }
});

test('formStateToRepo trims pasted whitespace', () => {
    const repo = Ui.formStateToRepo('local', form('local', { id: '  disk ', path: ' /srv/b ' }));
    assert.equal(repo.id, 'disk');
    assert.equal(repo.path, '/srv/b');
});

test('formStateToRepo omits empty optional fields rather than storing ""', () => {
    const repo = Ui.formStateToRepo('sftp', form('sftp', { user: '', label: '' }));
    assert.equal('user' in repo, false);
    assert.equal('label' in repo, false);
    assert.equal(repo.host, 'nas.lan');
});

test('formStateToRepo keeps a display label when one is given', () => {
    assert.equal(Ui.formStateToRepo('local', form('local')).label, 'USB disk');
});

test('formStateToRepo tolerates a missing form object', () => {
    assert.deepEqual(Ui.formStateToRepo('local', null), { id: '', kind: 'local' });
});

test('repoToFormState falls back to local for a kind hangar does not know', () => {
    const f = Ui.repoToFormState({ id: 'x', kind: 'dropbox' });
    assert.equal(f.kind, 'local');
    assert.equal(f.id, 'x');
});

test('repoToFormState on nothing produces a blank local form', () => {
    assert.deepEqual(Ui.repoToFormState(null), Ui.blankForm('local'));
});

test('repoToFormState stringifies non-string stored values', () => {
    // A hand-edited /etc/hangar/repos/<id>.json can contain anything; x-model on a
    // number would produce a form that silently misbehaves.
    const f = Ui.repoToFormState({ id: 'x', kind: 'rest', url: 1234 });
    assert.equal(f.url, '1234');
});

// -------------------------------------------------------------- mergeKind

test('mergeKind carries values across to a backend that uses the same field', () => {
    const s3 = form('s3');
    const b2 = Ui.mergeKind(s3, 'b2');
    assert.equal(b2.kind, 'b2');
    assert.equal(b2.bucket, 'hangar');      // shared with s3
    assert.equal(b2.prefix, 'hosts/db01');
    assert.equal(b2.id, 's3');
    assert.equal(b2.label, '');
});

test('mergeKind drops fields the new backend has no use for', () => {
    const b2 = Ui.mergeKind(form('s3'), 'b2');
    assert.equal('endpoint' in b2, false);
    assert.equal('secretAccessKey' in b2, false);
});

test('mergeKind of an empty form is just a blank form', () => {
    assert.deepEqual(Ui.mergeKind({}, 'gs'), Object.assign(Ui.blankForm('gs')));
});

// -------------------------------------------------------------- validateForm

test('a complete form for every backend has no problems', () => {
    for (const kind of Repos.KINDS)
        assert.deepEqual(Ui.validateForm(kind, form(kind)), [], kind);
});

test('validateForm requires an id', () => {
    assert.match(Ui.validateForm('local', form('local', { id: '' })).join(' '), /id is required/i);
});

test('validateForm rejects an id with illegal characters', () => {
    assert.match(Ui.validateForm('local', form('local', { id: 'My Repo' })).join(' '),
        /lowercase letters, digits and hyphens/i);
});

test('validateForm rejects an id starting with a hyphen', () => {
    // core/repos.js would accept it; core/secrets.js would not, and it becomes a
    // command-line option the first time anything hands it to restic.
    const problems = Ui.validateForm('local', form('local', { id: '-nas' }));
    assert.match(problems.join(' '), /start with a letter or a digit/i);
    assert.throws(() => Secrets.keyPath('-nas'));
});

test('validateForm rejects an id that is already taken', () => {
    const problems = Ui.validateForm('local', form('local', { id: 'nas' }), ['other', 'nas']);
    assert.match(problems.join(' '), /already exists/i);
});

test('validateForm allows an id that is not in the taken list', () => {
    assert.deepEqual(Ui.validateForm('local', form('local', { id: 'nas' }), ['other']), []);
});

test('validateForm requires an absolute local path', () => {
    assert.match(Ui.validateForm('local', form('local', { path: 'backups' })).join(' '), /absolute/i);
});

test('validateForm rejects ".." in a local path', () => {
    assert.match(Ui.validateForm('local', form('local', { path: '/srv/../etc' })).join(' '), /\.\./);
});

test('validateForm rejects a REST url without a scheme', () => {
    assert.match(Ui.validateForm('rest', form('rest', { url: 'rest.example:8000' })).join(' '),
        /http:\/\/ or https:\/\//i);
});

test('validateForm reports every missing required field for s3', () => {
    const problems = Ui.validateForm('s3', form('s3', { endpoint: '', bucket: '' }));
    assert.match(problems.join(' '), /endpoint/i);
    assert.match(problems.join(' '), /bucket/i);
});

test('validateForm rejects half a credential pair', () => {
    for (const [kind, pair] of Object.entries(Ui.CREDENTIAL_PAIRS)) {
        const half = {};
        half[pair[1]] = '';
        assert.match(Ui.validateForm(kind, form(kind, half)).join(' '), /together/i, kind);
    }
});

test('validateForm accepts no credentials at all', () => {
    // Perfectly normal: an IAM role or an rclone-managed remote supplies them.
    assert.deepEqual(Ui.validateForm('s3', form('s3', { accessKeyId: '', secretAccessKey: '' })), []);
});

test('validateForm rejects ".." in a bucket prefix', () => {
    assert.match(Ui.validateForm('s3', form('s3', { prefix: 'a/../../etc' })).join(' '), /\.\./);
});

test('validateForm reports an unknown backend', () => {
    assert.match(Ui.validateForm('dropbox', { id: 'x' }).join(' '), /Unknown repository kind/i);
});

test('validateForm on an empty form still returns problems, not an exception', () => {
    const problems = Ui.validateForm('local', {});
    assert.ok(Array.isArray(problems));
    assert.ok(problems.length >= 2);
});

// ====================================================================== size limit
//
// The limit belongs to the REPOSITORY, not to a job — capacity is a property of
// the destination, and two jobs sharing one repository with per-job caps would
// each delete the other's snapshots chasing its own number. So it lives in this
// editor, and these tests are the proof that it survives the form round trip, is
// echoed back understood, and cannot be saved in a state that would delete the
// last backup.

const Guard = require('../../js/core/sizeguard.js');

test('the size fields are on every backend, because they are not a backend setting', () => {
    for (const kind of Repos.KINDS) {
        const f = Ui.blankForm(kind);
        for (const n of Ui.GUARD_FIELDS) assert.equal(f[n], '', kind + '.' + n);
    }
});

test('an empty limit is stored as nothing at all — no enforcement is the default', () => {
    const repo = Ui.formStateToRepo('local', form('local'));
    assert.equal('sizeLimit' in repo, false);
    assert.equal('minSnapshots' in repo, false);
    assert.deepEqual(Repos.validate(repo), []);
});

test('the limit is stored as the text that was typed, not as a byte count', () => {
    // "500 GB" and "500 GiB" are different limits and both are things people type.
    // Keeping the words is what lets the form show back what was entered, and
    // keeps core/sizeguard.js the only place that turns text into bytes.
    const repo = Ui.formStateToRepo('local', form('local', { sizeLimit: ' 500 GB ' }));
    assert.equal(repo.sizeLimit, '500 GB');
});

test('the floor is stored as a NUMBER, because sizeguard refuses a string', () => {
    // core/sizeguard.js will not coerce: a floor that quietly reads as NaN is a
    // floor of zero, which is a floor that deletes the last backup.
    const repo = Ui.formStateToRepo('local', form('local', { sizeLimit: '500 GB', minSnapshots: ' 5 ' }));
    assert.equal(repo.minSnapshots, 5);
    assert.equal(typeof repo.minSnapshots, 'number');
    assert.deepEqual(Repos.validate(repo), []);
});

test('a floor that is not a whole number is kept verbatim so validate can report it', () => {
    for (const bad of ['two', '2.5', '1e3', '٣']) {
        const repo = Ui.formStateToRepo('local', form('local', { sizeLimit: '500 GB', minSnapshots: bad }));
        assert.equal(repo.minSnapshots, bad, bad);
        assert.ok(Ui.validateForm('local', form('local', { sizeLimit: '500 GB', minSnapshots: bad })).length >= 1, bad);
    }
});

test('floorValue never guesses: empty is absent, digits are a number, the rest is kept', () => {
    assert.equal(Ui.floorValue(''), null);
    assert.equal(Ui.floorValue('   '), null);
    assert.equal(Ui.floorValue(undefined), null);
    assert.equal(Ui.floorValue('3'), 3);
    assert.equal(Ui.floorValue('007'), 7);
    assert.equal(Ui.floorValue('0'), 0);        // saveable-looking, refused by validate
    assert.equal(Ui.floorValue('3.0'), '3.0');
    assert.equal(Ui.floorValue(4), 4);
    // A negative floor is a whole number that is merely too small, and it earns
    // the message that explains the rule rather than "must be a whole number".
    assert.equal(Ui.floorValue('-1'), -1);
    assert.match(Ui.validateForm('local', form('local',
        { sizeLimit: '500 GB', minSnapshots: '-1' }))[0], /at least 1/);
});

test('the floor survives even when the limit is cleared', () => {
    // Clearing the limit for an afternoon must not silently discard the number
    // that protects the history when it goes back on.
    const repo = Ui.formStateToRepo('local', form('local', { sizeLimit: '', minSnapshots: '7' }));
    assert.equal(repo.minSnapshots, 7);
    assert.equal('sizeLimit' in repo, false);
});

test('the size fields round-trip through the form for every backend', () => {
    for (const kind of Repos.KINDS) {
        const start = form(kind, { sizeLimit: '1.5 TiB', minSnapshots: '4' });
        const repo = Ui.formStateToRepo(kind, start);
        assert.deepEqual(Ui.repoToFormState(repo), start, kind);
    }
});

test('switching backend keeps the size limit — it is not a backend setting', () => {
    const s3 = form('s3', { sizeLimit: '2 TB', minSnapshots: '5' });
    const b2 = Ui.mergeKind(s3, 'b2');
    assert.equal(b2.sizeLimit, '2 TB');
    assert.equal(b2.minSnapshots, '5');
});

test('validateForm refuses a limit nobody can read', () => {
    const p = Ui.validateForm('local', form('local', { sizeLimit: 'lots' }));
    assert.equal(p.length, 1);
    assert.match(p[0], /not a size hangar can read/i);
});

test('validateForm refuses a floor of zero — the last backup is not negotiable', () => {
    const p = Ui.validateForm('local', form('local', { sizeLimit: '500 GB', minSnapshots: '0' }));
    assert.equal(p.length, 1);
    assert.match(p[0], /at least 1/);
});

test('validateForm allows the settings that are merely unusual', () => {
    // A tiny cap and a floor of 1 are legitimate on a small destination. They are
    // said out loud beside the field, not vetoed.
    assert.deepEqual(Ui.validateForm('local', form('local', { sizeLimit: '500', minSnapshots: '1' })), []);
});

// --- the echo -------------------------------------------------------------

test('limitEcho says what an empty limit means, rather than saying nothing', () => {
    assert.match(Ui.limitEcho(''), /never delete a snapshot to save space/i);
    assert.equal(Ui.limitEcho('   '), Ui.limitEcho(''));
    assert.equal(Ui.limitEcho(undefined), Ui.limitEcho(''));
});

test('limitEcho echoes the parsed size, which is the point of the free-text box', () => {
    // A bare number is BYTES and a bare letter is DECIMAL — neither is visible
    // unless the form says which one it understood.
    assert.equal(Ui.limitEcho('500 GB'), 'Understood as 465.7 GiB.');
    assert.equal(Ui.limitEcho('500G'), 'Understood as 465.7 GiB.');
    assert.equal(Ui.limitEcho('500'), 'Understood as 500 B.');
    assert.equal(Ui.limitEcho('1 TiB'), 'Understood as 1 TiB.');
    assert.equal(Ui.limitEcho(' 800m '), 'Understood as 762.9 MiB.');
});

test('limitEcho never pretends to understand', () => {
    for (const bad of ['lots', '1,000 GB', '1e3', '500 GB or so', '0x10'])
        assert.match(Ui.limitEcho(bad), /Not a size hangar can read/, bad);
    assert.match(Ui.limitEcho('0'), /greater than zero/);
    assert.match(Ui.limitEcho('-5 GB'), /greater than zero/);
});

test('limitEcho agrees with what validate will do about the same text', () => {
    // The echo and the veto must not disagree: a box that says "Understood as …"
    // above a form that then refuses to save is worse than either alone.
    for (const text of ['500 GB', '1.5 TiB', '800M', 'lots', '0', '-5 GB', '500', '']) {
        const blocked = Repos.validate({ id: 'x', kind: 'local', path: '/srv', sizeLimit: text }).length > 0;
        assert.equal(/^Understood as|never delete a snapshot/.test(Ui.limitEcho(text)), !blocked, text);
    }
});

// --- advice, not vetoes ---------------------------------------------------

test('guardNotes warns that a bare number is bytes', () => {
    const notes = Ui.guardNotes(form('local', { sizeLimit: '500' }));
    assert.equal(notes.length, 1);
    assert.match(notes[0], /500 is 500 bytes, not 500 GB/);
});

test('guardNotes warns that a floor of 1 is nearly no floor', () => {
    const notes = Ui.guardNotes(form('local', { sizeLimit: '500 GB', minSnapshots: '1' }));
    assert.equal(notes.length, 1);
    assert.match(notes[0], /leaves no margin/);
});

test('guardNotes reports both at once rather than one at a time', () => {
    assert.equal(Ui.guardNotes(form('local', { sizeLimit: '500', minSnapshots: '1' })).length, 2);
});

test('guardNotes is silent for a sensible limit and for no limit at all', () => {
    assert.deepEqual(Ui.guardNotes(form('local', { sizeLimit: '500 GB', minSnapshots: '3' })), []);
    assert.deepEqual(Ui.guardNotes(form('local', { sizeLimit: '', minSnapshots: '1' })), []);
    assert.deepEqual(Ui.guardNotes(null), []);
    assert.deepEqual(Ui.guardNotes('nonsense'), []);
});

test('guardNotes carries only warnings — errors are the form problems', () => {
    // An unreadable limit is an ERROR: it must stop the save, not sit in a yellow
    // box the user can ignore.
    assert.deepEqual(Ui.guardNotes(form('local', { sizeLimit: 'lots' })), []);
    assert.ok(Ui.validateForm('local', form('local', { sizeLimit: 'lots' })).length > 0);
});

test('every guard note is a sentence the user can act on, never an error code', () => {
    for (const n of Ui.guardNotes(form('local', { sizeLimit: '500', minSnapshots: '1' }))) {
        assert.ok(n.length > 20, n);
        assert.match(n, /\.$/);
        assert.doesNotMatch(n, /\[object|undefined|NaN/);
    }
});

// --- the trade-off, stated where the choice is made -----------------------

test('the form states all three costs of a size limit', () => {
    const text = Ui.GUARD_TRADEOFFS.join(' ');
    // prune is slow, especially remotely
    assert.match(text, /prune/);
    assert.match(text, /rewrites/);
    assert.match(text, /slow|minutes/);
    assert.match(text, /remote/);
    // deduplication makes each deletion free an unpredictable amount
    assert.match(text, /[Dd]eduplication/);
    assert.match(text, /unpredictable/);
    assert.match(text, /one snapshot at a time/);
    assert.match(text, /measures/);
    // the source alone exceeding the limit stops at the floor and says so
    assert.match(text, /larger than the limit/);
    assert.match(text, /stops at the minimum/);
});

test('the trade-off list is frozen and handed out as a copy', () => {
    // It is rendered by x-for on every keystroke; a component that could mutate
    // the shared list would rewrite the warning for every other repository.
    assert.ok(Object.isFrozen(Ui.GUARD_TRADEOFFS));
    const e = Ui.hangarRepoEdit();
    const first = e.guardTradeoffs();
    first.push('injected');
    assert.deepEqual(e.guardTradeoffs(), Ui.GUARD_TRADEOFFS.slice());
});

test('the edit component echoes and warns from its own form state', () => {
    const e = Ui.hangarRepoEdit();
    e.receive({ mode: 'add', form: Ui.blankForm('local') });
    assert.match(e.limitNote(), /never delete a snapshot/);
    assert.deepEqual(e.guardWarnings(), []);

    e.form.sizeLimit = '500';
    assert.equal(e.limitNote(), 'Understood as 500 B.');
    assert.equal(e.guardWarnings().length, 1);
});

test('an edited repository opens with its size limit already in the form', () => {
    const f = Ui.repoToFormState({ id: 'nas', kind: 'local', path: '/srv/b',
        sizeLimit: '500 GB', minSnapshots: 4 });
    assert.equal(f.sizeLimit, '500 GB');
    assert.equal(f.minSnapshots, '4', 'x-model on a number misbehaves invisibly');
});

test('the size limit reaches the repository the dialog resolves with', () => {
    const e = Ui.hangarRepoEdit();
    let saved = null;
    e.receive({ mode: 'add', form: Ui.blankForm('local'), resolve: (r) => { saved = r; } });
    e.form.id = 'nas';
    e.form.path = '/srv/b';
    e.form.sizeLimit = '2 TB';
    e.form.minSnapshots = '5';
    e.submit();
    assert.deepEqual(saved, { id: 'nas', kind: 'local', path: '/srv/b',
        sizeLimit: '2 TB', minSnapshots: 5 });
});

test('a repository that would delete its last backup cannot be submitted', () => {
    const e = Ui.hangarRepoEdit();
    let saved = null;
    e.receive({ mode: 'add', form: Ui.blankForm('local'), resolve: (r) => { saved = r; } });
    e.form.id = 'nas';
    e.form.path = '/srv/b';
    e.form.sizeLimit = '500 GB';
    e.form.minSnapshots = '0';
    e.submit();
    assert.equal(saved, null, 'a floor of 0 was saved');
    assert.equal(e.problems.length, 1);
});

test('the size guard the editor writes is one core/sizeguard.js can act on', () => {
    // The end-to-end shape: what the form saves must be what planTrim consumes,
    // or the setting is decoration.
    const repo = Ui.formStateToRepo('local', form('local', { sizeLimit: '500 GB', minSnapshots: '4' }));
    const limitBytes = Guard.parseSize(repo.sizeLimit);
    assert.equal(limitBytes, 500e9);
    assert.equal(Guard.effectiveFloor(repo.minSnapshots), 4);
    const snaps = [1, 2, 3, 4, 5].map((n) => ({ id: 'id' + n, time: '2026-0' + n + '-01T00:00:00Z' }));
    assert.equal(Guard.planTrim({ currentBytes: 600e9, limitBytes, snapshots: snaps,
        minSnapshots: repo.minSnapshots }).action, 'forget');
    assert.equal(Guard.planTrim({ currentBytes: 600e9, limitBytes, snapshots: snaps.slice(0, 4),
        minSnapshots: repo.minSnapshots }).action, 'floor-reached');
});

// -------------------------------------------------------------- display

test('formatSize renders binary units', () => {
    assert.equal(Ui.formatSize(0), '0 B');
    assert.equal(Ui.formatSize(512), '512 B');
    assert.equal(Ui.formatSize(1024), '1.0 KiB');
    assert.equal(Ui.formatSize(1536), '1.5 KiB');
    assert.equal(Ui.formatSize(1024 * 1024 * 20), '20 MiB');
    assert.equal(Ui.formatSize(1024 ** 4), '1.0 TiB');
});

test('formatSize refuses to invent a number it does not have', () => {
    assert.equal(Ui.formatSize(null), '—');
    assert.equal(Ui.formatSize(undefined), '—');
    assert.equal(Ui.formatSize('big'), '—');
    assert.equal(Ui.formatSize(-1), '—');
});

test('formatCount renders counts and blanks nonsense', () => {
    assert.equal(Ui.formatCount(0), '0');
    assert.equal(Ui.formatCount(17), '17');
    assert.equal(Ui.formatCount(null), '—');
    assert.equal(Ui.formatCount('x'), '—');
});

test('toRow prefers the display label and falls back to the id', () => {
    assert.equal(Ui.toRow({ id: 'nas', label: 'Office NAS', kind: 'local', path: '/x' }).title, 'Office NAS');
    assert.equal(Ui.toRow({ id: 'nas', kind: 'local', path: '/x' }).title, 'nas');
});

test('toRow describes the location through core/repos.js', () => {
    const repo = { id: 'nas', kind: 'sftp', user: 'backup', host: 'nas.lan', path: '/vol' };
    assert.equal(Ui.toRow(repo).location, Repos.describe(repo));
    assert.equal(Ui.toRow(repo).kindLabel, 'SFTP');
});

test('busyLabelFor names the running operation', () => {
    assert.match(Ui.busyLabelFor('check'), /integrity/i);
    assert.equal(Ui.busyLabelFor(''), '');
    assert.equal(Ui.busyLabelFor('nonsense'), '');
});

test('kindChoices offers every backend with a label', () => {
    const choices = Ui.kindChoices();
    assert.deepEqual(choices.map((c) => c.value), Repos.KINDS);
    for (const c of choices) assert.ok(c.label.length > 0);
});

// -------------------------------------------------------- errors become actions

test('remediationLabel has a button label for every remediation errors.js emits', () => {
    const emitted = new Set(Object.values(Errors.REMEDIATION));
    for (const r of emitted)
        assert.ok(Ui.remediationLabel(r).length > 0, `no label for ${r}`);
    assert.equal(Ui.remediationLabel('nope'), '');
    assert.equal(Ui.remediationLabel(null), '');
});

test('a locked repository becomes a warning-free danger alert with an Unlock action', () => {
    const alert = Ui.toAlert(Restic.classifyExit(11, ''), 'Reading repository');
    assert.equal(alert.level, 'danger');
    assert.equal(alert.kind, Errors.KIND.REPO_LOCKED);
    assert.equal(alert.remediation, 'unlock');
    assert.match(alert.actionLabel, /unlock/i);
});

test('a wrong password offers a re-prompt and a missing repository offers init', () => {
    assert.equal(Ui.toAlert(Restic.classifyExit(12, '')).remediation, 'reprompt');
    assert.equal(Ui.toAlert(Restic.classifyExit(10, '')).remediation, 'init');
});

test('read errors are a PARTIAL SUCCESS, never a failure', () => {
    const alert = Ui.toAlert(Restic.classifyExit(3, ''), 'Backup');
    assert.equal(alert.level, 'warning');
    assert.notEqual(alert.level, 'danger');
    assert.equal(alert.remediation, 'list-unreadable');
});

test('a network failure offers a retry', () => {
    const alert = Ui.toAlert(Restic.classifyExit(1, 'Fatal: unable to open repo: dial tcp: i/o timeout'));
    assert.equal(alert.kind, Errors.KIND.NETWORK);
    assert.equal(alert.remediation, 'retry');
});

test('a full destination offers the free-space remediation', () => {
    const alert = Ui.toAlert(Restic.classifyExit(1, 'error: write: no space left on device'));
    assert.equal(alert.kind, Errors.KIND.NO_SPACE);
    assert.equal(alert.remediation, 'free-space');
});

test('toAlert redacts credentials out of the raw backend error', () => {
    const err = Restic.classifyExit(1, 'Fatal: sftp://backup:hunter2@nas.lan/vol refused');
    const alert = Ui.toAlert(err, 'Test');
    assert.ok(!alert.detail.includes('hunter2'), alert.detail);
    assert.ok(alert.detail.includes('nas.lan'), 'the host is diagnostic, not secret');
});

test('toAlert on a plain Error still produces something actionable-shaped', () => {
    const alert = Ui.toAlert(new Error('boom'), 'Saving');
    assert.equal(alert.level, 'danger');
    assert.equal(alert.kind, Errors.KIND.UNKNOWN);
    assert.equal(alert.remediation, null);
    assert.equal(alert.message, 'boom');
});

test('toAlert of nothing is nothing', () => {
    assert.equal(Ui.toAlert(null), null);
});

test('unreadableFrom lists the items restic could not read', () => {
    const result = Restic.summarize([
        { message_type: 'error', item: '/home/a/.gvfs' },
        { message_type: 'error', item: '/proc/1/mem' },
        { message_type: 'summary', snapshot_id: 'abc' }
    ]);
    assert.equal(result.status, 'partial');
    assert.deepEqual(Ui.unreadableFrom(result), ['/home/a/.gvfs', '/proc/1/mem']);
});

test('unreadableFrom de-duplicates and ignores messages with no item', () => {
    const r = { errors: [{ item: '/a' }, { item: '/a' }, { message: 'no item' }, null, 'noise'] };
    assert.deepEqual(Ui.unreadableFrom(r), ['/a']);
});

test('unreadableFrom digs the list out of an error detail too', () => {
    assert.deepEqual(Ui.unreadableFrom({ detail: { errors: [{ path: '/b' }] } }), ['/b']);
    assert.deepEqual(Ui.unreadableFrom(null), []);
    assert.deepEqual(Ui.unreadableFrom('nope'), []);
});

test('resultAlert turns a partial run into a warning that lists the files', () => {
    const result = Restic.summarize([
        { message_type: 'error', item: '/var/lib/sss/db' },
        { message_type: 'summary' }
    ]);
    const alert = Ui.resultAlert(result, 'Integrity check');
    assert.equal(alert.level, 'warning');
    assert.deepEqual(alert.files, ['/var/lib/sss/db']);
    assert.equal(alert.remediation, 'list-unreadable');
});

test('resultAlert reports a clean run as a success', () => {
    const alert = Ui.resultAlert(Restic.summarize([{ message_type: 'summary' }]), 'Integrity check');
    assert.equal(alert.level, 'success');
    assert.equal(alert.remediation, null);
});

test('resultAlert treats a cancelled run as neutral, not an error', () => {
    const alert = Ui.resultAlert({ status: 'cancelled' }, 'Integrity check');
    assert.equal(alert.level, 'info');
});

test('resultAlert reports a failed run as a danger alert', () => {
    const failed = Restic.summarize([{ message_type: 'exit_error', code: 1, message: 'boom' }]);
    assert.equal(Ui.resultAlert(failed, 'Integrity check').level, 'danger');
});

test('isAlreadyInitialised recognises restic re-init as success', () => {
    assert.equal(Ui.isAlreadyInitialised(new Error(
        'Fatal: create repository at /srv/b failed: config file already exists')), true);
    assert.equal(Ui.isAlreadyInitialised(new Error(
        'repository master key and config already initialized')), true);
    assert.equal(Ui.isAlreadyInitialised(new Error('connection refused')), false);
    assert.equal(Ui.isAlreadyInitialised(null), false);
});

// -------------------------------------------------------------- deletion

test('deleting a repository defaults to removing only hangar\'s reference', () => {
    const msg = Ui.deleteMessage({ id: 'nas', label: 'Office NAS', kind: 'sftp', host: 'nas.lan', path: '/vol' });
    assert.match(msg.message, /NOT deleted/);
    assert.match(msg.confirmLabel, /reference/i);
    assert.match(msg.title, /Office NAS/);
});

test('the delete message says where the data still is', () => {
    const repo = { id: 'nas', kind: 'local', path: '/srv/backups' };
    assert.ok(Ui.deleteMessage(repo).detail.includes(Repos.describe(repo)));
});

test('the delete message never claims to destroy backups', () => {
    const msg = Ui.deleteMessage({ id: 'x', kind: 'local', path: '/srv/b' });
    assert.ok(!/erase|destroy the backups will|wipe/i.test(msg.message));
});

// -------------------------------------------------------------- restic wiring

test('resticOptions builds the repo url and the password file path from core', () => {
    const repo = { id: 'nas', kind: 'sftp', user: 'backup', host: 'nas.lan', path: '/vol/restic' };
    assert.deepEqual(Ui.resticOptions(repo), {
        repoUrl: 'sftp:backup@nas.lan:/vol/restic',
        passwordFile: '/etc/hangar/repos/nas.key'
    });
    // The options must be enough to build a real restic invocation.
    assert.deepEqual(Restic.buildArgs('snapshots', Ui.resticOptions(repo)),
        ['-r', 'sftp:backup@nas.lan:/vol/restic', '--password-file', '/etc/hangar/repos/nas.key',
            '--cache-dir', Restic.CACHE_DIR, '--json', 'snapshots']);
});

test('resticOptions refuses a repository whose id would escape its directory', () => {
    assert.throws(() => Ui.resticOptions({ id: '../../etc/shadow', kind: 'local', path: '/srv/b' }));
});

// -------------------------------------------------------------- components

test('the list component constructs with no DOM and no cockpit', () => {
    const c = Ui.hangarReposUi();
    assert.deepEqual(c.rows, []);
    assert.equal(c.loading, true);
    assert.equal(c.alert, null);
    assert.deepEqual(c.unreadable, []);
});

test('existingIds excludes the repository being edited', () => {
    const c = Ui.hangarReposUi();
    c.rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    assert.deepEqual(c.existingIds(), ['a', 'b', 'c']);
    assert.deepEqual(c.existingIds('b'), ['a', 'c']);
});

test('size and snapshot columns stay blank until the stats arrive', () => {
    const c = Ui.hangarReposUi();
    const row = Ui.toRow({ id: 'a', kind: 'local', path: '/srv/b' });
    assert.equal(c.size(row), '—');
    assert.equal(c.snapshots(row), '—');
    row.stats = { size: 2048, snapshots: 3 };
    assert.equal(c.size(row), '2.0 KiB');
    assert.equal(c.snapshots(row), '3');
});

test('remediate dispatches to the action the error asked for', async () => {
    const c = Ui.hangarReposUi();
    const called = [];
    c.unlock = async () => called.push('unlock');
    c.initRepo = async () => called.push('init');
    c.reprompt = async () => called.push('reprompt');
    c.loadStats = async () => called.push('retry');

    for (const [remediation, expected] of
        [['unlock', 'unlock'], ['init', 'init'], ['reprompt', 'reprompt'], ['retry', 'retry']]) {
        const row = { alert: { remediation: remediation }, showFiles: false };
        await c.remediate(row);
        assert.equal(called.pop(), expected);
    }
});

test('the list-unreadable remediation just reveals the files', async () => {
    const c = Ui.hangarReposUi();
    const row = { alert: { remediation: 'list-unreadable', files: ['/a'] }, showFiles: false };
    await c.remediate(row);
    assert.equal(row.showFiles, true);
});

test('alertClass maps the alert level onto a Bootstrap class', () => {
    const c = Ui.hangarReposUi();
    assert.equal(c.alertClass({ level: 'warning' }), 'alert alert-warning');
    assert.equal(c.alertClass(null), 'alert alert-secondary');
});

test('the edit component constructs with no DOM', () => {
    const e = Ui.hangarRepoEdit();
    assert.equal(e.mode, 'add');
    assert.equal(e.kind, 'local');
    assert.deepEqual(e.problems, []);
    assert.equal(e.kinds.length, Repos.KINDS.length);
});

test('receiving an edit request seeds the form and locks the id', () => {
    const e = Ui.hangarRepoEdit();
    e.receive({ mode: 'edit', form: Ui.repoToFormState({ id: 'nas', kind: 'sftp', host: 'nas.lan', path: '/vol' }) });
    assert.equal(e.mode, 'edit');
    assert.equal(e.kind, 'sftp');
    assert.equal(e.form.host, 'nas.lan');
    assert.equal(e.idLocked(), true);
    assert.match(e.title(), /Edit/);
});

test('receiving an add request starts blank and unlocks the id', () => {
    const e = Ui.hangarRepoEdit();
    e.receive({ mode: 'add', existingIds: ['nas'] });
    assert.equal(e.idLocked(), false);
    assert.deepEqual(e.form, Ui.blankForm('local'));
    assert.match(e.title(), /Add/);
});

test('changing the backend re-shapes the form and clears stale problems', () => {
    const e = Ui.hangarRepoEdit();
    e.receive({ mode: 'add' });
    e.form.id = 'store';
    e.problems = ['stale'];
    e.setKind('s3');
    assert.equal(e.kind, 's3');
    assert.equal(e.form.id, 'store');
    assert.equal(e.form.endpoint, '');
    assert.deepEqual(e.problems, []);
    assert.deepEqual(e.fields().map((f) => f.name), Ui.fieldsFor('s3').map((f) => f.name));
});

test('submitting an invalid form reports problems and does not resolve', () => {
    const e = Ui.hangarRepoEdit();
    let resolved = 'not called';
    e.receive({ mode: 'add', resolve: (v) => { resolved = v; } });
    e.submit();
    assert.equal(resolved, 'not called');
    assert.ok(e.problems.length > 0);
    assert.ok(e._resolve, 'the resolver must survive a failed submit');
});

test('submitting a valid form resolves with the repository and burns the resolver', () => {
    const e = Ui.hangarRepoEdit();
    let resolved = null;
    e.receive({ mode: 'add', form: form('sftp'), resolve: (v) => { resolved = v; } });
    e.submit();
    assert.deepEqual(resolved, {
        id: 'nas', kind: 'sftp', label: 'Office NAS',
        user: 'backup', host: 'nas.lan', path: '/vol/restic'
    });
    assert.equal(e._resolve, null);
});

test('an id already in use is rejected when adding but not when editing', () => {
    const add = Ui.hangarRepoEdit();
    add.receive({ mode: 'add', form: form('local'), existingIds: ['local-disk'] });
    assert.equal(add.validate(), false);

    // Editing a repository must not report its own id as a duplicate.
    const edit = Ui.hangarRepoEdit();
    edit.receive({ mode: 'edit', form: form('local'), existingIds: ['local-disk'] });
    assert.equal(edit.validate(), true);
});

test('loadRemotes degrades to an empty list when rclone is absent', async () => {
    const e = Ui.hangarRepoEdit();
    await e.loadRemotes();                 // no cockpit → listRcloneRemotes resolves []
    assert.deepEqual(e.remotes, []);
    assert.equal(e.remotesLoaded, true);
});

// -------------------------------------------------------------- mounting

test('mount injects the screen once into #hangar-repos', () => {
    const el = {
        attrs: {}, html: '',
        getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
        setAttribute(k, v) { this.attrs[k] = v; },
        insertAdjacentHTML(pos, h) { this.html += h; }
    };
    const doc = { getElementById: (id) => (id === 'hangar-repos' ? el : null) };

    assert.equal(Ui.mount(doc), true);
    assert.match(el.html, /x-data="hangarReposUi\(\)"/);
    assert.match(el.html, /Add repository/);

    // Idempotent: a second call must not duplicate the screen.
    const before = el.html;
    assert.equal(Ui.mount(doc), false);
    assert.equal(el.html, before);
});

test('mount is a no-op when the container is missing', () => {
    assert.equal(Ui.mount({ getElementById: () => null }), false);
    assert.equal(Ui.mount({}), false);
});

test('every button in the template is a real <button> with a type', () => {
    // Accessibility: a clickable <div> is invisible to keyboard and screen reader
    // users, and a typeless button inside a form submits it.
    const buttons = Ui.TEMPLATE.match(/<button[^>]*>/g) || [];
    assert.ok(buttons.length >= 5);
    for (const b of buttons) assert.match(b, /type="button"/);
});

test('icon-free action groups still carry an accessible name', () => {
    assert.match(Ui.TEMPLATE, /aria-label="Refresh repositories"/);
    assert.match(Ui.TEMPLATE, /:aria-label="'Actions for ' \+ row\.title"/);
});

// ============================================================================
// Adversarial: hostile input to the pure functions.
// ============================================================================

test('the pure functions survive a hand-edited config full of the wrong types', () => {
    // JSON.parse can produce an object with no usable toString; String() throws on
    // it, and a throw here is a blank Repositories screen.
    const hostile = JSON.parse('{"toString": null, "valueOf": null}');
    const repo = { id: 'x', kind: 'rest', url: hostile, label: hostile };

    assert.doesNotThrow(() => Ui.repoToFormState(repo));
    assert.equal(Ui.repoToFormState(repo).url, '');
    assert.doesNotThrow(() => Ui.toRow(repo));
    assert.doesNotThrow(() => Ui.deleteMessage(repo));
    assert.doesNotThrow(() => Ui.formStateToRepo('rest', { id: 'x', url: hostile }));
});

test('fieldsFor and blankForm reject every non-kind shape without throwing', () => {
    for (const bad of [undefined, null, '', 0, 1, true, false, [], {}, ['local'], NaN, Infinity, 'LOCAL', ' local ']) {
        assert.deepEqual(Ui.fieldsFor(bad), [], String(bad));
        assert.equal(Ui.blankForm(bad).kind, 'local', String(bad));
    }
});

test('kindLabel and busyLabelFor never return undefined', () => {
    for (const bad of [null, undefined, 0, [], {}, '', 'nope']) {
        assert.equal(typeof Ui.kindLabel(bad), 'string');
        assert.equal(typeof Ui.busyLabelFor(bad), 'string');
    }
    assert.equal(Ui.kindLabel(null), 'Unknown');
});

test('mergeKind tolerates rubbish on both sides', () => {
    assert.deepEqual(Ui.mergeKind(null, 'gs'), Ui.blankForm('gs'));
    assert.deepEqual(Ui.mergeKind('not a form', 'gs'), Ui.blankForm('gs'));
    assert.deepEqual(Ui.mergeKind(undefined, undefined), Ui.blankForm('local'));
    // An unknown target kind falls back rather than producing a form with no fields.
    assert.equal(Ui.mergeKind(Ui.blankForm('s3'), 'dropbox').kind, 'local');
});

test('validateForm reports problems for hostile ids instead of throwing', () => {
    const hostile = [
        '../../etc/shadow', 'a/b', 'a\\b', 'a\nb', 'a b', "a'b", 'a"b', 'repertoire-é',
        'ID', 'a'.repeat(200), '-nas', '.', '..', 'nas\u0000', 'x;rm -rf /'
    ];
    for (const id of hostile) {
        const problems = Ui.validateForm('local', form('local', { id: id }));
        assert.ok(Array.isArray(problems), id);
        assert.ok(problems.length > 0, JSON.stringify(id) + ' was accepted');
    }
    // Surrounding whitespace is a paste artefact, not hostility: it is trimmed.
    assert.deepEqual(Ui.validateForm('local', form('local', { id: '  nas  ' })), []);
});

test('every id the form accepts is one config.js and secrets.js also accept', () => {
    // The form must not accept an id that fails three calls later, when the user has
    // no idea which field was at fault.
    const candidates = [
        'nas', 'a', '0', 'a-b-c', 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(200),
        '-nas', 'nas-', 'NAS', 'na s', 'na/s', 'na..s', '', 'ünas'
    ];
    for (const id of candidates) {
        const accepted = Ui.validateForm('local', form('local', { id: id })).length === 0;
        if (!accepted) continue;
        assert.doesNotThrow(() => Config.validateId(id.trim()), 'config.js rejects ' + JSON.stringify(id));
        assert.doesNotThrow(() => Secrets.keyPath(id.trim()), 'secrets.js rejects ' + JSON.stringify(id));
    }
});

test('validateForm tolerates a junk existingIds argument', () => {
    for (const junk of [null, undefined, 'nas', 42, { nas: true }])
        assert.deepEqual(Ui.validateForm('local', form('local')), Ui.validateForm('local', form('local'), junk));
    // Non-string entries must not silently match a real id.
    assert.deepEqual(Ui.validateForm('local', form('local'), [null, undefined, 0, {}]), []);
});

test('validateForm rejects a path carrying a newline or a quote', () => {
    // A pasted path with an embedded newline reaches restic as two arguments' worth
    // of confusion; catching it in the form is the only place it is still legible.
    for (const p of ['/srv/b\n/etc', '/srv/../etc', 'relative/path', '~/backups'])
        assert.ok(Ui.validateForm('local', form('local', { path: p })).length > 0, p);
    // A perfectly ordinary unicode path is still accepted.
    assert.deepEqual(Ui.validateForm('local', form('local', { path: '/srv/böcker' })), []);
});

test('formatSize refuses types that Number() would silently turn into a size', () => {
    // Number([]) is 0 and Number(true) is 1: both would print a confident lie.
    for (const bad of [[], {}, true, false, NaN, Infinity, -Infinity, () => 1])
        assert.equal(Ui.formatSize(bad), '—', String(bad));
    assert.equal(Ui.formatSize('2048'), '2.0 KiB');
    assert.equal(Ui.formatSize(-0), '0 B');
});

test('formatSize copes with implausibly enormous repositories', () => {
    assert.match(Ui.formatSize(Number.MAX_SAFE_INTEGER), /PiB$/);
    assert.match(Ui.formatSize(1e30), /PiB$/);
    assert.ok(!/e\+/.test(Ui.formatSize(1e30)), 'never exponential notation');
});

test('formatCount refuses types Number() would coerce', () => {
    for (const bad of [[], {}, true, NaN, Infinity, -1])
        assert.equal(Ui.formatCount(bad), '—', String(bad));
});

test('unreadableFrom survives hostile error payloads', () => {
    assert.deepEqual(Ui.unreadableFrom({ errors: 'not a list' }), []);
    assert.deepEqual(Ui.unreadableFrom({ errors: [] }), []);
    assert.deepEqual(Ui.unreadableFrom({ detail: null }), []);
    assert.deepEqual(Ui.unreadableFrom({ errors: [{ item: 0 }, { item: false }, { item: '' }] }), []);
    // Unicode and quoted paths are preserved verbatim: they are what the user has
    // to go and look at.
    assert.deepEqual(Ui.unreadableFrom({ errors: [{ item: '/srv/"a b"/資料' }] }), ['/srv/"a b"/資料']);
    const many = { errors: Array.from({ length: 5000 }, (_, i) => ({ item: '/f/' + (i % 10) })) };
    assert.equal(Ui.unreadableFrom(many).length, 10);
});

test('toAlert survives a detail whose stderr is not a string', () => {
    for (const stderr of [null, 0, [], { a: 1 }, JSON.parse('{"toString": null}')]) {
        const e = Errors.create(Errors.KIND.GENERIC, 'boom', { stderr: stderr });
        assert.doesNotThrow(() => Ui.toAlert(e, 'Test'));
        assert.equal(typeof Ui.toAlert(e, 'Test').detail, 'string');
    }
});

test('toAlert keeps a newline-laden stderr bounded and redacted', () => {
    const noise = 'line\n'.repeat(5000) + 'password = hunter2\n';
    const alert = Ui.toAlert(Errors.create(Errors.KIND.GENERIC, 'boom', { stderr: noise }), 'Test');
    assert.ok(alert.detail.length <= 2000);
    assert.ok(!alert.detail.includes('hunter2'));
});

// ============================================================================
// Adversarial: error states become actions.
// ============================================================================

test('a READ_ERRORS alert with nothing to list offers no dead button', () => {
    // classifyExit carries no file list, so "Show unreadable files" would open an
    // empty list. The kind still says partial success; only the button goes.
    const alert = Ui.toAlert(Restic.classifyExit(3, ''), 'Backup');
    assert.equal(alert.level, 'warning');
    assert.equal(alert.remediation, 'list-unreadable');
    assert.equal(alert.actionLabel, '');

    const withFiles = Ui.toAlert(
        Object.assign(Restic.classifyExit(3, ''), { detail: { errors: [{ item: '/proc/1/mem' }] } }), 'Backup');
    assert.match(withFiles.actionLabel, /unreadable/i);
    assert.deepEqual(withFiles.files, ['/proc/1/mem']);
});

test('every remediation errors.js can emit reaches a component action', () => {
    // The rule is that a typed error becomes a button. A remediation with no
    // handler would be a button that does nothing.
    const handled = ['unlock', 'init', 'reprompt', 'retry', 'list-unreadable', 'reauthorize',
        'grant-access'];
    for (const r of new Set(Object.values(Errors.REMEDIATION)))
        assert.ok(handled.includes(r) || r === 'free-space', 'unhandled remediation ' + r);
    // free-space has no one-click fix here, so it must at least still be labelled.
    assert.ok(Ui.remediationLabel('free-space').length > 0);
});

test('toAlert carries the repository id so a screen-level action knows its target', () => {
    const alert = Ui.toAlert(Restic.classifyExit(11, ''), 'Add repository', 'nas');
    assert.equal(alert.repoId, 'nas');
    assert.equal(Ui.toAlert(new Error('x'), 'y').repoId, '');
});

test('resultAlert never reports a run it has no summary for as a success', () => {
    for (const status of ['unknown', 'running', undefined]) {
        const alert = Ui.resultAlert({ status: status }, 'Integrity check');
        assert.notEqual(alert.level, 'success', String(status));
        assert.equal(alert.level, 'warning');
        assert.equal(alert.remediation, 'retry');
    }
    assert.equal(Ui.resultAlert(null, 'x'), null);
    assert.equal(Ui.resultAlert('nope', 'x'), null);
});

test('resultAlert with a partial run and no named files offers no dead button', () => {
    const alert = Ui.resultAlert({ status: 'partial', errors: [] }, 'Integrity check');
    assert.equal(alert.level, 'warning');
    assert.equal(alert.remediation, 'list-unreadable');
    assert.equal(alert.actionLabel, '');
});

test('isAlreadyInitialised also reads the stderr detail, not just the message', () => {
    // classifyExit only lifts restic's text into `message` when restic emitted an
    // exit_error object. Without one the message is generic and the reason is in
    // the detail, which is the commonest "add an existing repository" path.
    const e = Restic.classifyExit(1, 'Fatal: create repository at /srv/b failed: config file already exists');
    assert.equal(e.message, 'restic reported an error', 'guard: the message really is generic here');
    assert.equal(Ui.isAlreadyInitialised(e), true);
    assert.equal(Ui.isAlreadyInitialised(Restic.classifyExit(1, 'Fatal: connection refused')), false);
});

// ============================================================================
// Adversarial: the component against failing core modules.
// ============================================================================

test('refresh survives listRepos rejecting and still finishes loading', async () => {
    const c = Ui.hangarReposUi();
    c.loadStats = async () => {};
    await withStubs([[Config, 'listRepos', async () => {
        throw Errors.create(Errors.KIND.NETWORK, 'the config filesystem is gone');
    }]], () => c.refresh());

    assert.equal(c.loading, false, 'a permanent "Loading" is the worst failure mode');
    assert.deepEqual(c.rows, []);
    assert.equal(c.alert.level, 'danger');
    assert.equal(c.alert.context, 'Listing repositories');
    assert.equal(c.alert.remediation, 'retry');
    assert.match(c.alertActionLabel(), /try again/i);
});

test('an unreadable repository file is a WARNING listing it, never a failure', async () => {
    // The design rule: READ_ERRORS / partial results render as a warning that names
    // what could not be read, and everything readable still renders.
    const c = Ui.hangarReposUi();
    c.loadStats = async () => {};
    await withStubs([
        [Config, 'listRepos', async () => ['good', 'broken']],
        [Config, 'readRepo', async (id) => {
            if (id === 'broken') throw Errors.create(Errors.KIND.GENERIC, 'Could not read it');
            return { id: 'good', kind: 'local', path: '/srv/b' };
        }]
    ], () => c.refresh());

    assert.equal(c.alert, null, 'a partial read is not a screen-level failure');
    assert.deepEqual(c.unreadable, ['/etc/hangar/repos/broken.json']);
    assert.deepEqual(c.rows.map((r) => r.id), ['good']);
    assert.equal(c.loading, false);

    // ...and the markup renders that list as a warning, not a danger.
    assert.match(Ui.TEMPLATE, /x-show="unreadable\.length" class="alert alert-warning"/);
    assert.match(Ui.TEMPLATE, /x-for="p in unreadable"/);
    assert.ok(!/x-show="unreadable\.length"[^>]*alert-danger/.test(Ui.TEMPLATE));
});

test('an empty repository file is unreadable, not an empty repository', async () => {
    const c = Ui.hangarReposUi();
    c.loadStats = async () => {};
    await withStubs([
        [Config, 'listRepos', async () => ['blank', 'weird']],
        [Config, 'readRepo', async (id) => (id === 'blank' ? null : 'not an object')]
    ], () => c.refresh());
    assert.deepEqual(c.unreadable,
        ['/etc/hangar/repos/blank.json', '/etc/hangar/repos/weird.json']);
    assert.deepEqual(c.rows, []);
});

test('refresh survives an id the path builder refuses and a non-list listing', async () => {
    const c = Ui.hangarReposUi();
    c.loadStats = async () => {};
    // repoPath() throws on this id, inside the very handler that reports it.
    await withStubs([[Config, 'listRepos', async () => ['../../etc/shadow']]], () => c.refresh());
    assert.equal(c.loading, false);
    assert.equal(c.unreadable.length, 1);
    assert.match(c.unreadable[0], /etc\/shadow/);

    await withStubs([[Config, 'listRepos', async () => 'not a list']], () => c.refresh());
    assert.deepEqual(c.rows, []);
    assert.equal(c.loading, false);
});

test('a repository whose definition names no id inherits it from the filename', async () => {
    const c = Ui.hangarReposUi();
    c.loadStats = async () => {};
    await withStubs([
        [Config, 'listRepos', async () => ['nas']],
        [Config, 'readRepo', async () => ({ kind: 'local', path: '/srv/b' })]
    ], () => c.refresh());
    assert.equal(c.rows[0].id, 'nas');
});

test('a locked repository turns into a row alert with an Unlock button', async () => {
    const row = repoRow();
    await withCockpit({ spawn: rejectsWith(11, 'repository is already locked') }, async () => {
        await Ui.hangarReposUi().loadStats(row);
    });
    assert.equal(row.alert.kind, Errors.KIND.REPO_LOCKED);
    assert.equal(row.alert.remediation, 'unlock');
    assert.match(row.alert.actionLabel, /unlock/i);
    assert.equal(row.alert.repoId, 'nas');
    assert.equal(row.busy, '', 'the row must not stay disabled after a failure');
});

test('a wrong password and a missing repository each reach their own action', async () => {
    for (const pair of [[12, 'reprompt'], [10, 'init'], [3, 'list-unreadable']]) {
        const row = repoRow();
        await withCockpit({ spawn: rejectsWith(pair[0], '') }, async () => {
            await Ui.hangarReposUi().loadStats(row);
        });
        assert.equal(row.alert.remediation, pair[1], String(pair[0]));
    }
});

test('a snapshot count already fetched survives a failing stats call', async () => {
    const row = repoRow();
    const spawn = (argv) => (argv.indexOf('snapshots') >= 0
        ? Promise.resolve('[{"id":"aabbccdd","time":"2026-07-31T02:00:00Z"}]')
        : Promise.reject({ exit_status: 1, message: 'Fatal: unknown flag: --mode' }));
    await withCockpit({ spawn: spawn }, async () => {
        await Ui.hangarReposUi().loadStats(row);
    });
    assert.equal(row.stats.snapshots, 1, 'a true count must not be thrown away');
    assert.equal(Ui.hangarReposUi().size(row), '—', 'but a size we never got is not invented');
    assert.ok(row.alert, 'the failure is still reported');
});

test('loadStats without cockpit reports it instead of throwing', async () => {
    const row = repoRow();
    await Ui.hangarReposUi().loadStats(row);
    assert.equal(row.alert.level, 'danger');
    assert.match(row.alert.message, /cockpit/i);
    assert.equal(row.busy, '');
});

test('loadStats reports a repository id that cannot become a key path', async () => {
    // resticOptions throws before any I/O; the row must still end up with an alert
    // rather than an exception escaping into Alpine.
    const row = Ui.toRow({ id: '../../etc/shadow', kind: 'local', path: '/srv/b' });
    await Ui.hangarReposUi().loadStats(row);
    assert.ok(row.alert);
    assert.equal(row.busy, '');
});

test('an integrity check that ends without a summary is not reported as success', async () => {
    const row = repoRow();
    const c = Ui.hangarReposUi();
    await withStubs([[Restic, 'run', async () => ({ status: 'unknown', errors: [] })]],
        () => c.check(row));
    assert.notEqual(row.alert.level, 'success');
    assert.equal(row.busy, '');
});

test('an integrity check with read errors renders as a warning listing the files', async () => {
    const row = repoRow();
    const c = Ui.hangarReposUi();
    const partial = Restic.summarize([
        { message_type: 'error', item: '/srv/backups/hangar/data/ab/broken' },
        { message_type: 'summary', num_errors: 1 }
    ]);
    await withStubs([[Restic, 'run', async () => partial]], () => c.check(row));
    assert.equal(row.alert.level, 'warning');
    assert.notEqual(row.alert.level, 'danger');
    assert.deepEqual(row.alert.files, ['/srv/backups/hangar/data/ab/broken']);
    assert.equal(row.alert.remediation, 'list-unreadable');
    await c.remediate(row);
    assert.equal(row.showFiles, true, 'the files must be reachable from the button');
});

test('an integrity check that rejects becomes an action, not a stuck row', async () => {
    const row = repoRow();
    const c = Ui.hangarReposUi();
    await withStubs([[Restic, 'run', async () => { throw Restic.classifyExit(12, ''); }]],
        () => c.check(row));
    assert.equal(row.alert.remediation, 'reprompt');
    assert.equal(row.busy, '');
});

test('unlock and initRepo report their own failures on the row', async () => {
    const c = Ui.hangarReposUi();
    for (const action of ['unlock', 'initRepo']) {
        const row = repoRow();
        await withCockpit({ spawn: rejectsWith(1, 'Fatal: connection refused') }, () => c[action](row));
        assert.ok(row.alert, action);
        assert.equal(row.alert.kind, Errors.KIND.NETWORK, action);
        assert.equal(row.busy, '', action);
    }
});

test('initialising an already-initialised repository is a success that reads it', async () => {
    const c = Ui.hangarReposUi();
    const row = repoRow();
    let read = 0;
    c.loadStats = async () => { read++; };
    await withCockpit({ spawn: rejectsWith(1, 'Fatal: config file already exists') },
        () => c.initRepo(row));
    assert.equal(row.alert, null, 'the expected case is not an error');
    assert.equal(read, 1, 'and the row is refreshed rather than left blank');
});

test('creating a repository surfaces a failing key write instead of swallowing it', async () => {
    const c = Ui.hangarReposUi();
    c.refresh = async () => {};
    await withDialogs({ passwordDialog: async () => 'hunter2', confirmDialog: async () => true }, () =>
        withStubs([[Secrets, 'writeKey', async () => {
            throw Errors.create(Errors.KIND.GENERIC, 'read-only file system');
        }]], () => c.create({ id: 'nas', kind: 'local', path: '/srv/b' })));
    assert.equal(c.alert.level, 'danger');
    assert.equal(c.alert.context, 'Add repository');
    assert.equal(c.loading, false);
});

test('creating a repository whose destination is locked keeps the action reachable', async () => {
    const c = Ui.hangarReposUi();
    c.refresh = async () => {};
    c.rows = [repoRow()];
    await withDialogs({ passwordDialog: async () => 'hunter2' }, () =>
        withStubs([[Secrets, 'writeKey', async () => '/etc/hangar/repos/nas.key'],
            [Config, 'writeRepo', async () => {}]], () =>
            withCockpit({ spawn: rejectsWith(11, 'locked') },
                () => c.create({ id: 'nas', kind: 'local', path: '/srv/b' }))));
    assert.equal(c.alert.remediation, 'unlock');
    assert.equal(c.alert.repoId, 'nas');
    // The row is on screen, so the screen-level button can honour the remediation.
    assert.match(c.alertActionLabel(), /unlock/i);
});

test('adding a repository that already exists is reported as success', async () => {
    const c = Ui.hangarReposUi();
    c.refresh = async () => {};
    await withDialogs({ passwordDialog: async () => 'hunter2' }, () =>
        withStubs([[Secrets, 'writeKey', async () => 'k'], [Config, 'writeRepo', async () => {}]], () =>
            withCockpit({ spawn: rejectsWith(1, 'Fatal: config file already exists') },
                () => c.create({ id: 'nas', kind: 'local', path: '/srv/b' }))));
    assert.equal(c.alert.level, 'success');
    assert.match(c.alert.message, /already existed/i);
});

test('a password dialog that cannot be shown becomes an alert, not a lost click', async () => {
    const c = Ui.hangarReposUi();
    c.refresh = async () => {};
    await withDialogs({ passwordDialog: async () => { throw new Error('no modal'); } },
        () => c.create({ id: 'nas', kind: 'local', path: '/srv/b' }));
    assert.equal(c.alert.level, 'danger');
    assert.equal(c.alert.context, 'Add repository');

    const row = repoRow();
    await withDialogs({ passwordDialog: async () => { throw new Error('no modal'); } }, () => c.reprompt(row));
    assert.ok(row.alert);
    assert.equal(row.busy, '');
});

test('cancelling the password prompt changes nothing', async () => {
    const c = Ui.hangarReposUi();
    let wrote = 0;
    await withDialogs({ passwordDialog: async () => '' }, () =>
        withStubs([[Secrets, 'writeKey', async () => { wrote++; }]],
            () => c.create({ id: 'nas', kind: 'local', path: '/srv/b' })));
    assert.equal(wrote, 0);
    assert.equal(c.alert, null);
});

test('saving a new password reports a failing write on the row', async () => {
    const c = Ui.hangarReposUi();
    const row = repoRow();
    await withDialogs({ passwordDialog: async () => 'hunter2' }, () =>
        withStubs([[Secrets, 'writeKey', async () => {
            throw Errors.create(Errors.KIND.GENERIC, 'permission denied');
        }]], () => c.reprompt(row)));
    assert.equal(row.alert.level, 'danger');
    assert.match(row.alert.context, /password/i);
    assert.equal(row.busy, '');
});

test('editing a repository surfaces a failing write', async () => {
    const c = Ui.hangarReposUi();
    c.refresh = async () => {};
    const row = repoRow();
    await withStubs([[Config, 'writeRepo', async () => {
        throw Errors.create(Errors.KIND.GENERIC, 'disk full');
    }]], () => c.update(row, { id: 'nas', kind: 'local', path: '/srv/b' }));
    assert.equal(c.alert.context, 'Saving repository');
    assert.equal(row.busy, '');
});

test('removing a repository still drops the definition when the key will not go', async () => {
    const c = Ui.hangarReposUi();
    c.refresh = async () => {};
    const row = repoRow();
    let removedFile = false;
    const file = () => ({ replace: (v) => { removedFile = v === null; return Promise.resolve(); }, close() {} });
    await withDialogs({ confirmDialog: async () => true }, () =>
        withStubs([[Secrets, 'removeKey', async () => {
            throw Errors.create(Errors.KIND.GENERIC, 'permission denied');
        }]], () => withCockpit({ spawn: () => Promise.resolve(''), file: file }, () => c.remove(row))));
    assert.equal(removedFile, true, 'the reference must go once the user confirmed');
    assert.ok(c.alert, 'and the leftover password file is still reported');
    assert.match(c.alert.context, /password/i);
});

test('removing a repository without cockpit reports it', async () => {
    const c = Ui.hangarReposUi();
    c.refresh = async () => {};
    const row = repoRow();
    await withDialogs({ confirmDialog: async () => true }, () => c.remove(row));
    assert.equal(c.alert.context, 'Removing repository');
    assert.equal(row.busy, '');
});

test('a confirm dialog that cannot be shown never removes anything', async () => {
    const c = Ui.hangarReposUi();
    c.refresh = async () => {};
    const row = repoRow();
    let removed = 0;
    await withDialogs({ confirmDialog: async () => { throw new Error('no modal'); } }, () =>
        withStubs([[Secrets, 'removeKey', async () => { removed++; }]], () => c.remove(row)));
    assert.equal(removed, 0, 'a failed confirmation is not a confirmation');
    assert.ok(c.alert);
});

test('a failing test-connection offers the remediation and clears busy', async () => {
    const c = Ui.hangarReposUi();
    const row = repoRow();
    await withCockpit({ spawn: rejectsWith(10, '') }, () => c.testConnection(row));
    assert.equal(row.alert.remediation, 'init');
    assert.equal(row.busy, '');
});

// --------------------------------------------------------- screen-level actions

test('the screen alert only offers an action it can actually perform', () => {
    const c = Ui.hangarReposUi();
    c.rows = [repoRow('nas')];

    c.alert = Ui.toAlert(Restic.classifyExit(11, ''), 'Add repository', 'nas');
    assert.match(c.alertActionLabel(), /unlock/i);

    // Same error, but the repository is not on screen: a button that cannot act is
    // worse than no button.
    c.alert = Ui.toAlert(Restic.classifyExit(11, ''), 'Add repository', 'gone');
    assert.equal(c.alertActionLabel(), '');

    c.alert = Ui.toAlert(Restic.classifyExit(1, 'dial tcp: i/o timeout'), 'Listing repositories');
    assert.match(c.alertActionLabel(), /try again/i);

    c.alert = null;
    assert.equal(c.alertActionLabel(), '');
});

test('the screen-level remediation runs against the right row', async () => {
    const c = Ui.hangarReposUi();
    const row = repoRow('nas');
    c.rows = [repoRow('other'), row];
    const seen = [];
    c.unlock = async (r) => seen.push('unlock:' + r.id);
    c.refresh = async () => seen.push('refresh');

    c.alert = Ui.toAlert(Restic.classifyExit(11, ''), 'Add repository', 'nas');
    await c.remediateAlert();
    assert.deepEqual(seen, ['unlock:nas']);
    assert.equal(c.alert, null, 'the alert is consumed by acting on it');

    c.alert = Ui.toAlert(Restic.classifyExit(1, 'dial tcp: i/o timeout'), 'Listing repositories');
    await c.remediateAlert();
    assert.deepEqual(seen, ['unlock:nas', 'refresh']);

    c.alert = { remediation: 'list-unreadable', files: ['/a'], actionLabel: 'Show unreadable files' };
    await c.remediateAlert();
    assert.equal(c.showFiles, true);

    c.alert = null;
    assert.equal(await c.remediateAlert(), null);
});

test('remediate ignores a row that is not there', async () => {
    const c = Ui.hangarReposUi();
    assert.equal(await c.remediate(null), null);
    assert.equal(await c.remediate(undefined), null);
});

// ============================================================================
// The edit dialog against hostile state.
// ============================================================================

test('the edit dialog resolves with nothing when there is no modal to show', async () => {
    // Under node there is no event target. openAdd() must not reject into a click
    // handler that has nowhere to put the rejection.
    const c = Ui.hangarReposUi();
    let created = 0;
    c.create = async () => { created++; };
    await c.openAdd();
    assert.equal(created, 0);
    assert.equal(await Ui.repoEditDialog({ mode: 'add' }), null);
});

test('openEdit does nothing when the dialog cannot be shown', async () => {
    const c = Ui.hangarReposUi();
    let updated = 0;
    c.update = async () => { updated++; };
    await c.openEdit(repoRow());
    assert.equal(updated, 0);
});

test('the edit component ignores a hostile event payload', () => {
    const e = Ui.hangarRepoEdit();
    for (const bad of [null, undefined, 'nope', 42, []]) {
        assert.doesNotThrow(() => e.receive(bad));
        assert.equal(e.kind, 'local');
        assert.deepEqual(e.form, Ui.blankForm('local'));
    }
});

test('a stored kind this build does not know falls back to a form with fields', () => {
    const e = Ui.hangarRepoEdit();
    e.receive({ mode: 'edit', form: { id: 'x', kind: 'dropbox' } });
    assert.equal(e.kind, 'local');
    assert.equal(e.form.kind, 'local');
    assert.ok(e.fields().length > 0, 'a dialog with no fields has no way out');
    assert.equal(e.form.id, 'x');
});

test('setKind refuses a kind that would leave the form empty', () => {
    const e = Ui.hangarRepoEdit();
    e.receive({ mode: 'add' });
    for (const bad of [null, undefined, '', 'dropbox', 42, {}]) {
        e.setKind(bad);
        assert.equal(e.kind, 'local', String(bad));
        assert.ok(e.fields().length > 0, String(bad));
    }
});

test('init is a no-op where there is nothing to listen on', () => {
    assert.doesNotThrow(() => Ui.hangarRepoEdit().init());
});

test('submitting twice resolves once', () => {
    const e = Ui.hangarRepoEdit();
    let calls = 0;
    e.receive({ mode: 'add', form: form('local'), resolve: () => { calls++; } });
    e.submit();
    e.submit();
    assert.equal(calls, 1);
});

test('loadRemotes tolerates a listing that is not a list and allows a later retry', async () => {
    const e = Ui.hangarRepoEdit();
    await withStubs([[Repos, 'listRcloneRemotes', async () => 'gdrive:']], () => e.loadRemotes());
    assert.deepEqual(e.remotes, []);

    const e2 = Ui.hangarRepoEdit();
    await withStubs([[Repos, 'listRcloneRemotes', async () => { throw new Error('boom'); }]],
        () => e2.loadRemotes());
    assert.deepEqual(e2.remotes, []);
    assert.equal(e2.remotesLoaded, false, 'a failed probe must be retryable');
});

// ============================================================================
// Accessibility and naming.
// ============================================================================

test('the snapshot browser is only ever called Logbook', () => {
    // The rejected name is assembled rather than written out, so this file cannot
    // itself become the thing the smoke test is looking for.
    const forbidden = new RegExp(['time', '\\s*', 'machine'].join(''), 'i');
    assert.ok(!forbidden.test(SOURCE));
    assert.ok(!forbidden.test(MODAL));
    assert.ok(!forbidden.test(Ui.TEMPLATE));
    assert.ok(!forbidden.test(JSON.stringify(Ui.KIND_LABEL) + JSON.stringify(Ui.BUSY_LABEL)));
});

test('per-row buttons name the repository they act on', () => {
    for (const verb of ['Test', 'Check', 'Unlock', 'Edit', 'Remove'])
        assert.ok(Ui.TEMPLATE.includes(":aria-label=\"'" + verb + " ' + row.title\""), verb);
});

test('alerts and progress announce themselves', () => {
    // Without role="alert" a failure that appears in place is silent for a screen
    // reader: the user hears nothing and assumes the click did nothing.
    const alerts = Ui.TEMPLATE.match(/class="alert |:class="alertClass/g) || [];
    const roles = Ui.TEMPLATE.match(/role="alert"/g) || [];
    assert.ok(roles.length >= alerts.length - 1,
        roles.length + ' role="alert" for ' + alerts.length + ' alerts');
    assert.match(Ui.TEMPLATE, /role="status"/);
    assert.match(Ui.TEMPLATE, /aria-live="polite"/);
});

test('the screen has no clickable non-buttons', () => {
    for (const markup of [Ui.TEMPLATE, MODAL]) {
        const clickable = markup.match(/<(?!button)[a-z]+[^>]*@click/g) || [];
        assert.deepEqual(clickable, [], 'clickable non-button: ' + clickable.join(', '));
        assert.ok(!/onclick=/i.test(markup));
    }
});

test('every modal button is a real typed button', () => {
    const buttons = MODAL.match(/<button[^>]*>/g) || [];
    assert.ok(buttons.length >= 3);
    for (const b of buttons) assert.match(b, /type="(button|submit)"/);
    // The close icon has no text, so it needs a name of its own.
    assert.match(MODAL, /class="btn-close"[^>]*aria-label="Close"/);
});

test('every modal input is bound to a label', () => {
    const inputs = MODAL.match(/<(input|select)[^>]*>/g) || [];
    assert.ok(inputs.length >= 4);
    for (const el of inputs) {
        assert.ok(/\sid="/.test(el) || /\s:id="/.test(el), 'no id to label: ' + el);
    }
    assert.match(MODAL, /<label class="form-label" for="hangar-repo-id">/);
    assert.match(MODAL, /<label class="form-label" for="hangar-repo-label">/);
    assert.match(MODAL, /<label class="form-label" for="hangar-repo-kind">/);
    assert.match(MODAL, /:for="'hangar-repo-f-' \+ f\.name"/);
    assert.match(MODAL, /:id="'hangar-repo-f-' \+ f\.name"/);
});

test('the id field is readonly rather than disabled when it is locked', () => {
    // A disabled input is skipped by screen-reader forms mode, so the one field the
    // user cannot change would also be the one they never hear about.
    assert.match(MODAL, /:readonly="idLocked\(\)"/);
    assert.ok(!/:disabled="idLocked\(\)"/.test(MODAL));
});

test('the validation summary is announced', () => {
    assert.match(MODAL, /x-show="problems\.length" role="alert"/);
});

test('the size limit and its floor are both in the editor, and labelled', () => {
    assert.match(MODAL, /<label class="form-label" for="hangar-repo-size-limit">/);
    assert.match(MODAL, /<label class="form-label" for="hangar-repo-min-snapshots">/);
    assert.match(MODAL, /x-model="form\.sizeLimit"/);
    assert.match(MODAL, /x-model="form\.minSnapshots"/);
});

test('the floor sits in the same row as the limit it protects', () => {
    // It is the thing that stops the limit deleting the last backup. Put it
    // anywhere else and someone sets a cap without ever meeting the setting that
    // makes it safe.
    const row = /<div class="row g-3">[\s\S]*?hangar-repo-size-limit[\s\S]*?hangar-repo-min-snapshots[\s\S]*?<\/div>\s*<\/div>/;
    assert.match(MODAL, row);
});

test('the editor echoes the parsed limit back and shows the guard warnings', () => {
    assert.match(MODAL, /x-text="limitNote\(\)"/);
    assert.match(MODAL, /guardWarnings\(\)/);
    assert.match(MODAL, /guardTradeoffs\(\)/);
});

test('the trade-off is stated in the form, not left to documentation', () => {
    // Not behind an x-show either: the cost is what someone needs in order to
    // decide whether to set a limit at all, so revealing it only after they have
    // is too late.
    const block = MODAL.slice(MODAL.indexOf('guardTradeoffs()') - 400, MODAL.indexOf('guardTradeoffs()'));
    assert.doesNotMatch(block, /x-show/);
    assert.match(MODAL, /costs when it has to act/);
});

test('the editor says that leaving the limit empty is the default', () => {
    assert.match(MODAL, /Optional, and empty by default/);
    assert.match(Ui.limitEcho(''), /No size limit/);
});

// ==========================================================================
// An expired cloud destination: found by the Test button, fixed by a button.
//
// The point of testing this HERE is that "Test connection" has to find an
// expired sign-in before the next scheduled run does. A destination that is
// only discovered by a 03:00 unit is discovered by nobody.
// ==========================================================================

// An rclone repository, so the reclassification below has something to act on.
function rcloneRow(id) {
    return Ui.toRow({ id: id || 'gdrive-repo', kind: 'rclone', remote: 'gdrive', prefix: 'backups' });
}

// The wording rclone and the providers really produce, arriving inside restic's
// stderr because restic SPAWNS rclone for an `rclone:` repository.
const EXPIRY_STDERR =
    'Fatal: unable to open repository at rclone:gdrive:backups: couldn\'t fetch token - ' +
    'maybe it has expired? - refresh with "rclone config reconnect gdrive:"';

test('remoteOf finds the rclone remote a repository writes through', () => {
    assert.equal(Ui.remoteOf({ kind: 'rclone', remote: 'gdrive' }), 'gdrive');
    assert.equal(Ui.remoteOf({ kind: 'rclone', remote: '  gdrive  ' }), 'gdrive');
    // From the URL when the definition carries no remote field of its own.
    assert.equal(Ui.remoteOf({ id: 'x', kind: 'rclone', prefix: 'b' }), '');
    // Not an rclone repository: there is no sign-in to renew.
    assert.equal(Ui.remoteOf({ kind: 'local', path: '/srv/b' }), '');
    assert.equal(Ui.remoteOf({ kind: 'sftp', user: 'u', host: 'h', path: '/p' }), '');
    assert.equal(Ui.remoteOf(null), '');
    assert.equal(Ui.remoteOf('nonsense'), '');
});

test('classifyRepoFailure turns rclone\'s expiry wording into AUTH_EXPIRED', () => {
    const repo = { id: 'g', kind: 'rclone', remote: 'gdrive' };
    for (const text of [
        'couldn\'t fetch token - maybe it has expired?',
        'refresh with "rclone config reconnect gdrive:"',
        'oauth2: token expired and refresh token is not set',
        'invalid_grant: Token has been expired or revoked.',
        'AADSTS700082: The refresh token has expired due to inactivity.'
    ]) {
        const e = Ui.classifyRepoFailure(Errors.create('GENERIC', text), repo);
        assert.equal(e.kind, Errors.KIND.AUTH_EXPIRED, text);
        assert.equal(e.remediation, 'reauthorize', text);
        assert.equal(e.fatal, true, 'the backup did not happen');
    }
});

test('a bare 401 or 403 is NOT reported as an expired sign-in', () => {
    // The judgement the whole design turns on: those are also what an ordinary
    // permission problem looks like, and a false "your login expired" sends the
    // user through a pointless re-authorisation while hiding the real cause.
    const repo = { id: 'g', kind: 'rclone', remote: 'gdrive' };
    for (const text of [
        'HTTP 403 Forbidden',
        '401 Unauthorized',
        'Fatal: permission denied',
        'directory not found'
    ]) {
        const e = Ui.classifyRepoFailure(Errors.create('GENERIC', text), repo);
        assert.equal(e.kind, Errors.KIND.GENERIC, text);
    }
});

test('a repository that does not go through rclone is never reclassified', () => {
    // An SFTP server that said "403" has a permission problem. Offering its owner
    // a cloud sign-in would hide it.
    const sftp = { id: 'nas', kind: 'sftp', user: 'u', host: 'h', path: '/p' };
    const e = Ui.classifyRepoFailure(Errors.create('GENERIC', EXPIRY_STDERR), sftp);
    assert.equal(e.kind, Errors.KIND.GENERIC);
});

test('an error that is already AUTH_EXPIRED is passed through untouched', () => {
    const original = Errors.create(Errors.KIND.AUTH_EXPIRED, 'sign-in expired', { stderr: 'x' });
    const e = Ui.classifyRepoFailure(original, { kind: 'rclone', remote: 'gdrive' });
    assert.equal(e, original, 'it must not be rebuilt, and its detail must not be lost');
});

test('reclassifying keeps restic\'s own text for the log', () => {
    const e = Ui.classifyRepoFailure(
        Restic.classifyExit(1, EXPIRY_STDERR), { kind: 'rclone', remote: 'gdrive' });
    assert.equal(e.kind, Errors.KIND.AUTH_EXPIRED);
    assert.match(String(e.detail.stderr), /config reconnect/);
    // …but says it in words a person can act on.
    assert.match(e.message, /authorised again|sign-in has expired/i);
});

test('classifyRepoFailure survives hostile input', () => {
    assert.equal(Ui.classifyRepoFailure(null, {}), null);
    assert.equal(Ui.classifyRepoFailure(undefined, null), undefined);
    const plain = new Error('boom');
    assert.equal(Ui.classifyRepoFailure(plain, { kind: 'rclone', remote: 'gdrive' }), plain);
});

test('Test connection finds an expired sign-in before the next nightly run does', async () => {
    const c = Ui.hangarReposUi();
    const row = rcloneRow();
    await withCockpit({ spawn: rejectsWith(1, EXPIRY_STDERR) }, () => c.testConnection(row));
    assert.equal(row.alert.kind, Errors.KIND.AUTH_EXPIRED);
    assert.equal(row.alert.remediation, 'reauthorize');
    assert.equal(row.alert.actionLabel, 'Sign in again');
    assert.notEqual(row.alert.actionLabel, 'Try again',
        'retrying fails identically, every night, in silence');
    assert.equal(row.busy, '');
});

test('a channel failure with no exit status still reaches the same action', async () => {
    // The path classifyExit cannot cover on its own: no restic exit status ever
    // arrived, but rclone's text did.
    const c = Ui.hangarReposUi();
    const row = rcloneRow();
    await withCockpit({ spawn: () => Promise.reject({ problem: EXPIRY_STDERR }) },
        () => c.testConnection(row));
    assert.equal(row.alert.kind, Errors.KIND.AUTH_EXPIRED);
    assert.equal(row.alert.remediation, 'reauthorize');
});

test('reading a repository\'s size hits the same classification', async () => {
    const row = rcloneRow();
    await withCockpit({ spawn: rejectsWith(1, EXPIRY_STDERR) },
        () => Ui.hangarReposUi().loadStats(row));
    assert.equal(row.alert.remediation, 'reauthorize');
});

test('the Sign in again button opens the wizard on THAT remote', async () => {
    // The old bug this pins: hangarReposUi.remediate() dispatched to a method the
    // list component did not have, so the one button that fixes an expired
    // destination threw instead.
    const c = Ui.hangarReposUi();
    const row = rcloneRow();
    row.alert = Ui.toAlert(Errors.create(Errors.KIND.AUTH_EXPIRED, 'expired'), 'Test', row.id);
    const seen = [];
    await withStubs([
        [globalThis, 'CustomEvent', class { constructor(n, o) { this.type = n; this.detail = (o || {}).detail; } }],
        [globalThis, 'dispatchEvent', (ev) => { seen.push(ev); return true; }]
    ], async () => {
        await c.remediate(row);
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, 'hangar:rclone-remote');
    assert.equal(seen[0].detail.reauthorize, 'gdrive');
    assert.equal(seen[0].detail.repoId, 'gdrive-repo');
    assert.equal(typeof seen[0].detail.verify, 'function',
        'the wizard must be able to prove the repair, not assert it');
});

test('the wizard\'s verification is this row\'s own connection test', async () => {
    const c = Ui.hangarReposUi();
    const row = rcloneRow();
    let verify = null;
    await withStubs([
        [globalThis, 'CustomEvent', class { constructor(n, o) { this.type = n; this.detail = (o || {}).detail; } }],
        [globalThis, 'dispatchEvent', (ev) => { verify = ev.detail.verify; return true; }]
    ], async () => { c.reauthorize(row); });

    // A repository that answers resolves, and leaves the row green.
    await withCockpit({ spawn: () => Promise.resolve('[]') }, async () => {
        const r = await verify();
        assert.match(r.message, /Reachable/);
    });
    assert.equal(row.alert.level, 'success');

    // One that still does not answer rejects, so the dialog says so rather than
    // claiming the repair worked.
    await withCockpit({ spawn: rejectsWith(1, EXPIRY_STDERR) }, async () => {
        await assert.rejects(() => verify());
    });
    assert.equal(row.alert.remediation, 'reauthorize');
});

test('a repository with no rclone remote is not offered a sign-in it cannot do', async () => {
    const c = Ui.hangarReposUi();
    const row = repoRow();               // a local folder
    row.alert = Ui.toAlert(Errors.create(Errors.KIND.AUTH_EXPIRED, 'expired'), 'Test', row.id);
    const seen = [];
    await withStubs([
        [globalThis, 'CustomEvent', class { constructor(n, o) { this.type = n; this.detail = (o || {}).detail; } }],
        [globalThis, 'dispatchEvent', (ev) => { seen.push(ev); return true; }]
    ], async () => { assert.equal(c.reauthorize(row), false); });
    assert.deepEqual(seen, [], 'no wizard about a destination this row does not use');
    assert.equal(row.showFiles, true, 'the detail is opened instead');
});

test('reauthorize is a no-op, not a throw, where there is no event plumbing', () => {
    const c = Ui.hangarReposUi();
    assert.equal(c.reauthorize(rcloneRow()), false);
    assert.equal(c.reauthorize(null), false);
});

test('the screen-level alert can honour a sign-in when it knows the row', async () => {
    const c = Ui.hangarReposUi();
    c.rows = [rcloneRow('gdrive-repo')];
    c.alert = Ui.toAlert(Errors.create(Errors.KIND.AUTH_EXPIRED, 'expired'),
        'Add repository', 'gdrive-repo');
    assert.equal(c.alertActionLabel(), 'Sign in again');

    const seen = [];
    await withStubs([
        [globalThis, 'CustomEvent', class { constructor(n, o) { this.type = n; this.detail = (o || {}).detail; } }],
        [globalThis, 'dispatchEvent', (ev) => { seen.push(ev); return true; }]
    ], async () => { await c.remediateAlert(); });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].detail.reauthorize, 'gdrive');
    assert.equal(c.alert, null, 'the alert moved to the row it is about');

    // And with no such row on screen, the button is not offered at all.
    c.rows = [];
    c.alert = Ui.toAlert(Errors.create(Errors.KIND.AUTH_EXPIRED, 'expired'), 'Add repository', 'gone');
    assert.equal(c.alertActionLabel(), '');
});

test('a destination repaired elsewhere stops being reported as broken here', async () => {
    const c = Ui.hangarReposUi();
    const row = rcloneRow('gdrive-repo');
    row.alert = Ui.toAlert(Errors.create(Errors.KIND.AUTH_EXPIRED, 'expired'), 'Test', row.id);
    c.rows = [row];
    // The row is re-read rather than patched: whether the repair worked is the
    // host's answer, not this screen's assumption.
    await withCockpit({ spawn: () => Promise.resolve('[]') }, async () => {
        assert.equal(await c.remoteReconnected({ repoId: 'gdrive-repo' }), 1);
    });
    assert.equal(row.alert, null);
});

test('the reconnected listener never rejects, whatever the re-read does', async () => {
    const c = Ui.hangarReposUi();
    const row = rcloneRow('gdrive-repo');
    row.alert = Ui.toAlert(Errors.create(Errors.KIND.AUTH_EXPIRED, 'x'), 'Test', row.id);
    c.rows = [row];
    // No cockpit at all: loadStats reports it on the row, and the listener still
    // resolves — a rejection from an event handler has nowhere to go.
    assert.equal(await c.remoteReconnected({}), 1);
    assert.ok(row.alert, 'the re-read failure is itself reported');
});

test('every remediation still reaches a real method on the list component', () => {
    // The stronger form of the older test above: the method has to EXIST, which
    // is exactly what "reauthorize" did not for the row that needed it most.
    const c = Ui.hangarReposUi();
    const method = { unlock: 'unlock', init: 'initRepo', reprompt: 'reprompt',
        retry: 'loadStats', reauthorize: 'reauthorize', 'grant-access': 'grantAccess' };
    for (const r of new Set(Object.values(Errors.REMEDIATION))) {
        if (r === 'list-unreadable' || r === 'free-space') continue;
        assert.equal(typeof c[method[r]], 'function', 'no handler for ' + r);
    }
});

test('the module still touches no DOM and no cockpit at load time', () => {
    // Re-asserted at the END of the file: every test above installs and removes its
    // own fakes, and a leak would make the first assertion in this file a lie.
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.cockpit, 'undefined');
    // No top-level declaration may reference either outside a guard.
    const topLevel = SOURCE.split('\n').filter((l) => /^\s{4}(const|let|var)\s/.test(l));
    for (const l of topLevel)
        assert.ok(!/\bcockpit\b|\bdocument\b/.test(l), 'load-time access: ' + l.trim());
});

// --- Browse buttons ------------------------------------------------------

test('only a local repository offers a folder picker', () => {
    // 'path' means two different things: a directory on THIS machine for a local
    // repository, and a directory on the far side of an SSH connection for an
    // sftp one. Offering a local folder browser for the second would send the
    // user browsing the wrong machine's filesystem and typing a path that does
    // not exist there.
    assert.equal(Ui.fieldsFor('local').find((f) => f.name === 'path').browse, 'dir');
    assert.equal(Ui.fieldsFor('sftp').find((f) => f.name === 'path').browse, null);
});

test('no remote backend offers a local picker for any field', () => {
    for (const kind of ['sftp', 'rest', 's3', 'b2', 'azure', 'gs', 'rclone']) {
        const browsable = Ui.fieldsFor(kind).filter((f) => f.browse).map((f) => f.name);
        assert.deepEqual(browsable, [], `${kind} offers a local picker for ${browsable.join(', ')}`);
    }
});

test('browseFor sets the field when a path is chosen', async () => {
    const c = Ui.hangarRepoEdit();
    c.form = { path: '/srv' };
    const prev = globalThis.HangarDialogs;
    globalThis.HangarDialogs = { pickPath: async () => '/srv/backups/hangar' };
    try {
        assert.equal(await c.browseFor({ name: 'path', browse: 'dir', label: 'Path' }), true);
        assert.equal(c.form.path, '/srv/backups/hangar');
    } finally { globalThis.HangarDialogs = prev; }
});

test('cancelling the picker leaves the field exactly as it was', async () => {
    const c = Ui.hangarRepoEdit();
    c.form = { path: '/srv/original' };
    const prev = globalThis.HangarDialogs;
    globalThis.HangarDialogs = { pickPath: async () => null };
    try {
        assert.equal(await c.browseFor({ name: 'path', browse: 'dir', label: 'Path' }), false);
        assert.equal(c.form.path, '/srv/original', 'cancelling cleared the field');
    } finally { globalThis.HangarDialogs = prev; }
});

test('the picker opens where the field already points', async () => {
    // Editing an existing repository should not start the browse at '/'.
    const c = Ui.hangarRepoEdit();
    c.form = { path: '/srv/backups/hangar' };
    let seen = null;
    const prev = globalThis.HangarDialogs;
    globalThis.HangarDialogs = { pickPath: async (o) => { seen = o; return null; } };
    try {
        await c.browseFor({ name: 'path', browse: 'dir', label: 'Path' });
        assert.equal(seen.current, '/srv/backups/hangar');
        assert.equal(seen.mode, 'dir');
    } finally { globalThis.HangarDialogs = prev; }
});

test('browseFor is a no-op for a field that does not declare browsing', async () => {
    const c = Ui.hangarRepoEdit();
    c.form = { host: 'nas.lan' };
    let called = false;
    const prev = globalThis.HangarDialogs;
    globalThis.HangarDialogs = { pickPath: async () => { called = true; return '/x'; } };
    try {
        assert.equal(await c.browseFor({ name: 'host', label: 'Host' }), false);
        assert.equal(called, false);
        assert.equal(c.form.host, 'nas.lan');
    } finally { globalThis.HangarDialogs = prev; }
});

// ------------------------------------------- reading yields to a backup
//
// Reading a repository takes a restic lock, and the backup's prune needs an
// exclusive one. Polling sizes every few seconds is how this plugin denied its
// own retention the lock it needed: measured on a real repository, prune was
// blocked by a different PID on every attempt, all of them hangar's own stats
// and diff calls.

test('repository sizes are not polled while a backup is running', async () => {
    const prev = globalThis.HangarSchedule;
    globalThis.HangarSchedule = { anyBackupRunning: () => Promise.resolve(true) };
    let spawned = false;
    globalThis.cockpit = { spawn() { spawned = true; return Promise.resolve(''); } };
    try {
        const c = Ui.hangarReposUi();
        const row = { id: 'main', repo: { id: 'main', kind: 'local', path: '/srv/r' }, busy: 'x' };
        await c.loadStats(row);
        assert.equal(spawned, false, 'nothing may touch the repository during a backup');
        assert.equal(row.busy, '', 'and the row must not be left spinning');
    } finally {
        globalThis.HangarSchedule = prev;
        delete globalThis.cockpit;
    }
});

test('an idle machine is polled as before', async () => {
    const prev = globalThis.HangarSchedule;
    globalThis.HangarSchedule = { anyBackupRunning: () => Promise.resolve(false) };
    let spawned = false;
    globalThis.cockpit = { spawn() { spawned = true; return Promise.resolve('[]'); } };
    try {
        const c = Ui.hangarReposUi();
        const row = { id: 'main', repo: { id: 'main', kind: 'local', path: '/srv/r' }, busy: '' };
        await c.loadStats(row);
        assert.equal(spawned, true, 'no backup, no reason to hold back');
    } finally {
        globalThis.HangarSchedule = prev;
        delete globalThis.cockpit;
    }
});

// A guard that fails must never blank the screen.
test('an unavailable Schedule does not stop the Repositories screen', async () => {
    const prev = globalThis.HangarSchedule;
    globalThis.HangarSchedule = { anyBackupRunning: () => Promise.reject(new Error('no bus')) };
    let spawned = false;
    globalThis.cockpit = { spawn() { spawned = true; return Promise.resolve('[]'); } };
    try {
        const c = Ui.hangarReposUi();
        await c.loadStats({ id: 'main', repo: { id: 'main', kind: 'local', path: '/srv/r' }, busy: '' });
        assert.equal(spawned, true, 'carry on rather than show nothing');
    } finally {
        globalThis.HangarSchedule = prev;
        delete globalThis.cockpit;
    }
});

// --- the size this screen measures is shared, not thrown away --------------
//
// Both screens ask restic the same expensive question about the same
// repository. Whichever pays for the answer writes it down, so the other does
// not have to — and the row shows a remembered number instead of an em dash
// while its own measurement is in flight.

const RepoSize = require('../../js/core/reposize.js');

test('a measured size is written to the shared cache', async () => {
    const row = repoRow();
    const written = [];
    const spawn = (argv) => Promise.resolve(argv.indexOf('snapshots') >= 0
        ? '[{"id":"aabbccdd","time":"2026-07-31T02:00:00Z"}]'
        : '{"total_size":4096,"total_file_count":9,"snapshots_count":1}');
    await withStubs([[RepoSize, 'read', async () => null],
        [RepoSize, 'write', async (id, stats) => {
            written.push([id, stats.totalSize]);
            return { size: stats.totalSize, snapshots: 1, at: 5000 };
        }]], () => withCockpit({ spawn: spawn }, async () => {
        await Ui.hangarReposUi().loadStats(row);
    }));
    assert.deepEqual(written, [['nas', 4096]], 'the Overview must not pay for this again');
    assert.equal(row.stats.size, 4096);
    assert.equal(row.stats.at, 5000, 'and the row knows when it was taken');
});

test('a remembered size fills the row while its own measurement is in flight', async () => {
    const row = repoRow();
    let seen = null;
    const spawn = (argv) => {
        // Whatever the row looked like at the moment the slow query began.
        if (argv.indexOf('snapshots') >= 0) seen = row.stats && row.stats.size;
        return Promise.resolve(argv.indexOf('snapshots') >= 0
            ? '[]' : '{"total_size":4096,"total_file_count":9}');
    };
    await withStubs([
        [RepoSize, 'read', async () => ({ size: 2048, snapshots: 3, at: 1000 })],
        [RepoSize, 'write', async () => ({ size: 4096, snapshots: 0, at: 2000 })]
    ], () => withCockpit({ spawn: spawn }, async () => {
        await Ui.hangarReposUi().loadStats(row);
    }));
    assert.equal(seen, 2048, 'the row was not an em dash while restic was thinking');
    assert.equal(row.stats.size, 4096, 'and the fresh number replaces it');
});

test('a failed measurement leaves the remembered size on screen', async () => {
    const row = repoRow();
    const spawn = (argv) => (argv.indexOf('snapshots') >= 0
        ? Promise.resolve('[{"id":"aabbccdd","time":"2026-07-31T02:00:00Z"}]')
        : Promise.reject({ exit_status: 1, message: 'Fatal: unable to open repository' }));
    await withStubs([
        [RepoSize, 'read', async () => ({ size: 2048, snapshots: 3, at: 1000 })],
        [RepoSize, 'write', async () => { throw new Error('must not be called'); }]
    ], () => withCockpit({ spawn: spawn }, async () => {
        await Ui.hangarReposUi().loadStats(row);
    }));
    const c = Ui.hangarReposUi();
    assert.equal(row.stats.size, 2048, 'the last true size survives the failure');
    assert.equal(c.size(row), '2.0 KiB');
    assert.ok(row.alert, 'and the failure is still reported');
});

test('the row says when its size was measured, and says nothing when nothing has', () => {
    const c = Ui.hangarReposUi();
    const row = repoRow();
    assert.equal(c.measuredAt(row), '', 'a row with no stats claims no date');
    row.stats = { snapshots: 1, size: 10, at: null };
    assert.equal(c.measuredAt(row), '', 'nor does a size that arrived without one');
    row.stats = { snapshots: 1, size: 10, at: Date.now() - 3 * 60 * 60 * 1000 };
    assert.equal(c.measuredAt(row), 'measured 3 hours ago');
    assert.ok(SOURCE.includes('measuredAt(row)'),
        'and the template must render it beside the size');
});

test('an unreadable cache is simply no cache, not a failed row', async () => {
    const row = repoRow();
    const spawn = (argv) => Promise.resolve(argv.indexOf('snapshots') >= 0
        ? '[]' : '{"total_size":4096,"total_file_count":9}');
    await withStubs([
        [RepoSize, 'read', async () => { throw new Error('access denied'); }],
        [RepoSize, 'write', async () => { throw new Error('read-only'); }]
    ], () => withCockpit({ spawn: spawn }, async () => {
        await Ui.hangarReposUi().loadStats(row);
    }));
    assert.equal(row.alert, null, 'a cache problem is never the repository\'s problem');
    assert.equal(row.stats.size, 4096);
    assert.equal(row.busy, '');
});
