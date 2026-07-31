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

test('the screen is never called "Time Machine"', () => {
    // The feature is Logbook. This screen links to it, so the wrong name would
    // most plausibly appear here.
    assert.ok(!/time\s*machine/i.test(Ui.TEMPLATE));
    assert.ok(!/time\s*machine/i.test(JSON.stringify(Ui.KIND_LABEL)));
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
            '--json', 'snapshots']);
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
