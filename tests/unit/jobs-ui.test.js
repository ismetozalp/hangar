// Unit tests for js/features/jobs-ui.js.
//
// jobs-ui.js ships two Alpine factories, but everything that decides something is
// a pure function exported beside them — form <-> job conversion, validation and
// the progress line. These tests drive that real logic; the component tests only
// assert what a component test can honestly assert: that it constructs with no
// DOM and no cockpit, which is what makes the rest testable at all.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const Jobs = require('../../js/features/jobs-ui.js');
const Retention = require('../../js/core/retention.js');
const Errors = require('../../js/core/errors.js');

const {
    emptyForm, presetFields, formRetention, presetNameFor, keepsNothing,
    formCalendar, scheduleModeFor, formSource, mergeFilesystemSources,
    formStateToJob, jobToFormState, validateForm, hasErrors, problemsFor,
    formatBytes, progressPercent, progressLabel, unreadableFiles,
    lastResultLabel, remediationLabel, backupOpts, splitLines, joinTags
} = Jobs;

// A realistic stored job: the shape libexec/hangar-run reads.
function sampleJob() {
    return {
        id: 'nightly',
        name: 'Nightly home backup',
        repo: 'nas',
        enabled: true,
        sources: [{
            id: 'main',
            kind: 'filesystem',
            paths: ['/etc', '/home'],
            excludes: ['*.tmp'],
            oneFileSystem: true,
            tags: ['nightly']
        }],
        retention: { hourly: 24, daily: 30, weekly: 52, monthly: 12 },
        schedule: { calendar: 'daily' },
        hooks: { pre: 'systemctl stop app' }
    };
}

function codes(problems) { return problems.map((p) => p.code); }

// --- module shape --------------------------------------------------------

test('the module exports its pure functions alongside the component factories', () => {
    ['formStateToJob', 'jobToFormState', 'validateForm', 'progressLabel',
        'hangarJobsUi', 'hangarJobEdit'].forEach((name) => {
        assert.equal(typeof Jobs[name], 'function', name + ' is not exported');
    });
});

test('the module loads with no DOM and no cockpit present', () => {
    // The whole point of the guarded DOM access: requiring this file under node
    // must not touch document, bootstrap or cockpit.
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof Jobs.SCREEN, 'string');
});

test('nothing in this screen calls the Logbook a Time Machine', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(require.resolve('../../js/features/jobs-ui.js'), 'utf8');
    const html = fs.readFileSync(__dirname + '/../../html/modals/job-edit.html', 'utf8');
    assert.ok(!/time\s*machine/i.test(src));
    assert.ok(!/time\s*machine/i.test(html));
});

// --- form defaults -------------------------------------------------------

test('a new form preselects the rolling retention preset', () => {
    const f = emptyForm();
    assert.equal(f.retentionPreset, 'rolling');
    assert.equal(f.retentionPreset, Retention.DEFAULT_PRESET);
});

test('a new form is enabled, daily, and otherwise empty', () => {
    const f = emptyForm();
    assert.equal(f.enabled, true);
    assert.equal(f.scheduleMode, 'daily');
    assert.equal(f.isNew, true);
    assert.equal(f.id, '');
    assert.equal(f.paths, '');
});

test('presetFields renders a preset into editable strings', () => {
    const fields = presetFields('rolling');
    assert.equal(fields.hourly, '24');
    assert.equal(fields.monthly, '12');
    assert.equal(fields.last, '');
});

// --- retention -----------------------------------------------------------

test('a chosen preset is the policy, verbatim', () => {
    const f = emptyForm();
    f.retentionPreset = 'minimal';
    assert.deepEqual(formRetention(f), Retention.PRESETS.minimal);
});

test('an unknown preset name yields an empty policy rather than a guess', () => {
    const f = emptyForm();
    f.retentionPreset = 'no-such-preset';
    assert.deepEqual(formRetention(f), {});
});

test('custom retention parses typed counts into numbers', () => {
    const f = emptyForm();
    f.retentionPreset = 'custom';
    f.retention.daily = '7';
    f.retention.weekly = '4';
    assert.deepEqual(formRetention(f), { daily: 7, weekly: 4 });
});

test('blank custom fields are omitted, not sent as zero', () => {
    const f = emptyForm();
    f.retentionPreset = 'custom';
    f.retention.daily = '7';
    f.retention.hourly = '';
    const policy = formRetention(f);
    assert.equal('hourly' in policy, false);
});

test('an unparsable count survives verbatim so validation can name it', () => {
    const f = emptyForm();
    f.retentionPreset = 'custom';
    f.retention.daily = 'seven';
    assert.deepEqual(formRetention(f), { daily: 'seven' });
});

test('custom retention carries within and tags', () => {
    const f = emptyForm();
    f.retentionPreset = 'custom';
    f.retention.within = ' 7d ';
    f.retention.tags = 'keep-forever, release';
    assert.deepEqual(formRetention(f), { within: '7d', tags: ['keep-forever', 'release'] });
});

test('keepsNothing is true for an empty custom policy and false for a preset', () => {
    const f = emptyForm();
    f.retentionPreset = 'custom';
    assert.equal(keepsNothing(f), true);
    f.retentionPreset = 'rolling';
    assert.equal(keepsNothing(f), false);
});

test('a policy of explicit zeroes still keeps nothing', () => {
    const f = emptyForm();
    f.retentionPreset = 'custom';
    f.retention.daily = '0';
    f.retention.weekly = '0';
    assert.equal(keepsNothing(f), true);
});

test('presetNameFor recognises every shipped preset and falls back to custom', () => {
    Object.keys(Retention.PRESETS).forEach((name) => {
        assert.equal(presetNameFor(Retention.PRESETS[name]), name);
    });
    assert.equal(presetNameFor({ daily: 3 }), 'custom');
});

// --- schedule ------------------------------------------------------------

test('the shorthand modes map to systemd shorthands', () => {
    assert.equal(formCalendar({ scheduleMode: 'daily' }), 'daily');
    assert.equal(formCalendar({ scheduleMode: 'hourly' }), 'hourly');
    assert.equal(formCalendar({ scheduleMode: 'weekly' }), 'weekly');
});

test('a custom schedule uses the raw OnCalendar field, trimmed', () => {
    assert.equal(formCalendar({ scheduleMode: 'custom', calendar: '  Mon..Fri 02:30 ' }), 'Mon..Fri 02:30');
});

test('an unknown schedule mode produces no calendar at all', () => {
    // Better an empty calendar the validator rejects than a silent default that
    // schedules a backup the user did not ask for.
    assert.equal(formCalendar({ scheduleMode: 'fortnightly' }), '');
});

test('scheduleModeFor recognises shorthands and treats anything else as custom', () => {
    assert.equal(scheduleModeFor('daily'), 'daily');
    assert.equal(scheduleModeFor('WEEKLY'), 'weekly');
    assert.equal(scheduleModeFor('Mon..Fri 02:30'), 'custom');
});

// --- sources -------------------------------------------------------------

test('paths and excludes are one entry per line, trimmed, blanks dropped', () => {
    assert.deepEqual(splitLines('  /etc \n\n /home\n'), ['/etc', '/home']);
});

test('formSource builds a filesystem source with a default id', () => {
    const s = formSource({ paths: '/srv', excludes: '*.tmp' });
    assert.equal(s.kind, 'filesystem');
    assert.equal(s.id, 'main');
    assert.deepEqual(s.paths, ['/srv']);
    assert.deepEqual(s.excludes, ['*.tmp']);
});

test('several filesystem sources merge into one editable set without duplicates', () => {
    const merged = mergeFilesystemSources({
        sources: [
            { id: 'a', kind: 'filesystem', paths: ['/etc'], excludes: ['*.tmp'] },
            { id: 'b', kind: 'filesystem', paths: ['/etc', '/srv'], oneFileSystem: true }
        ]
    });
    assert.deepEqual(merged.paths, ['/etc', '/srv']);
    assert.deepEqual(merged.excludes, ['*.tmp']);
    assert.equal(merged.oneFileSystem, true);
});

// --- form <-> job round trip --------------------------------------------

test('formStateToJob produces the job shape the helper reads', () => {
    const job = formStateToJob(jobToFormState(sampleJob()));
    assert.equal(job.id, 'nightly');
    assert.equal(job.repo, 'nas');
    assert.equal(job.sources[0].kind, 'filesystem');
    assert.deepEqual(job.schedule, { calendar: 'daily' });
});

test('a stored job round-trips through the form unchanged', () => {
    const job = sampleJob();
    assert.deepEqual(formStateToJob(jobToFormState(job)), job);
});

test('a custom retention policy round-trips unchanged', () => {
    const job = sampleJob();
    job.retention = { last: 3, within: '7d', tags: ['keep-forever'] };
    assert.deepEqual(formStateToJob(jobToFormState(job)), job);
});

test('a custom OnCalendar and its timer options round-trip unchanged', () => {
    const job = sampleJob();
    job.schedule = { calendar: 'Mon..Fri 02:30', randomizedDelaySec: 600, persistent: false };
    const back = formStateToJob(jobToFormState(job));
    assert.deepEqual(back.schedule, job.schedule);
});

test('hooks are omitted entirely when the user set none', () => {
    const job = sampleJob();
    delete job.hooks;
    const back = formStateToJob(jobToFormState(job));
    assert.equal('hooks' in back, false);
});

test('a post hook alone is emitted alone', () => {
    const f = jobToFormState(sampleJob());
    f.preHook = '';
    f.postHook = 'systemctl start app';
    assert.deepEqual(formStateToJob(f).hooks, { post: 'systemctl start app' });
});

test('source kinds this screen cannot edit are carried through, not dropped', () => {
    // The v2 seam: a libvirt or podman source must survive an edit made in v1.
    const job = sampleJob();
    job.sources.push({ id: 'db', kind: 'libvirt', domain: 'postgres' });
    const back = formStateToJob(jobToFormState(job));
    assert.deepEqual(back.sources[1], { id: 'db', kind: 'libvirt', domain: 'postgres' });
});

test('jobToFormState accepts a repo given as an object', () => {
    const f = jobToFormState({ id: 'j', repo: { id: 'nas', credentials: {} } });
    assert.equal(f.repo, 'nas');
});

test('jobToFormState survives garbage input', () => {
    [null, undefined, 42, 'nonsense', []].forEach((bad) => {
        const f = jobToFormState(bad);
        assert.equal(f.id, '');
        assert.equal(f.isNew, true);
    });
});

test('an existing job is not marked as new', () => {
    assert.equal(jobToFormState(sampleJob()).isNew, false);
});

test('a job with a bare-string schedule is understood', () => {
    const f = jobToFormState({ id: 'j', schedule: 'hourly' });
    assert.equal(f.scheduleMode, 'hourly');
    assert.equal(formCalendar(f), 'hourly');
});

test('an enabled flag of false survives the round trip', () => {
    const job = sampleJob();
    job.enabled = false;
    assert.equal(formStateToJob(jobToFormState(job)).enabled, false);
});

// --- validation ----------------------------------------------------------

function validForm() {
    return jobToFormState(sampleJob());
}

test('a well formed job has no errors', () => {
    const problems = validateForm(validForm());
    assert.equal(hasErrors(problems), false, JSON.stringify(problems));
});

test('a missing id is an error', () => {
    const f = validForm();
    f.id = '';
    assert.ok(codes(validateForm(f)).includes('id-required'));
});

test('an id that cannot become a unit name is an error', () => {
    const f = validForm();
    f.id = 'Nightly Backup/../etc';
    assert.ok(codes(validateForm(f)).includes('id-invalid'));
});

test('a duplicate id is refused for a new job only', () => {
    const f = validForm();
    f.isNew = true;
    assert.ok(codes(validateForm(f, ['nightly'])).includes('id-taken'));

    f.isNew = false;
    assert.ok(!codes(validateForm(f, ['nightly'])).includes('id-taken'));
});

test('a job with no repository is an error', () => {
    const f = validForm();
    f.repo = '';
    assert.ok(codes(validateForm(f)).includes('repo-required'));
});

test('a job with no paths is an error', () => {
    const f = validForm();
    f.paths = '';
    const problems = validateForm(f);
    assert.ok(codes(problems).includes('source-no-paths'));
    assert.equal(problemsFor(problems, 'paths').length, 1);
});

test('a relative path is an error attached to the paths field', () => {
    const f = validForm();
    f.paths = 'home/appuser';
    const problems = validateForm(f);
    assert.ok(codes(problems).includes('source-path-not-absolute'));
    assert.equal(problemsFor(problems, 'paths')[0].severity, 'error');
});

test('a path containing .. is an error', () => {
    const f = validForm();
    f.paths = '/home/../etc/shadow';
    assert.ok(codes(validateForm(f)).includes('source-path-traversal'));
});

test('a redundant nested path is a warning, not an error', () => {
    const f = validForm();
    f.paths = '/home\n/home/appuser';
    const problems = validateForm(f);
    assert.ok(codes(problems).includes('source-path-redundant'));
    assert.equal(hasErrors(problems), false);
});

test('a retention policy that keeps nothing is blocked in the form', () => {
    // The load-bearing guard: `restic forget --prune` with such a policy deletes
    // every snapshot in the group, and that cannot be undone.
    const f = validForm();
    f.retentionPreset = 'custom';
    f.retention = { last: '', hourly: '', daily: '', weekly: '', monthly: '', yearly: '', within: '', tags: '' };
    const problems = validateForm(f);
    assert.ok(codes(problems).includes('retention-keeps-nothing'));
    assert.equal(hasErrors(problems), true);
});

test('the keeps-nothing message is reported once, in the form\'s own words', () => {
    const f = validForm();
    f.retentionPreset = 'custom';
    Object.keys(f.retention).forEach((k) => { f.retention[k] = ''; });
    const problems = validateForm(f).filter((p) => p.field === 'retention');
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /keeps nothing/);
});

test('a non-integer retention count is an error', () => {
    const f = validForm();
    f.retentionPreset = 'custom';
    f.retention.daily = 'seven';
    assert.ok(codes(validateForm(f)).some((c) => c.indexOf('retention-') === 0));
    assert.equal(hasErrors(validateForm(f)), true);
});

test('a negative retention count is an error', () => {
    const f = validForm();
    f.retentionPreset = 'custom';
    f.retention.daily = '-3';
    assert.equal(hasErrors(validateForm(f)), true);
});

test('an invalid OnCalendar expression is an error on the calendar field', () => {
    const f = validForm();
    f.scheduleMode = 'custom';
    f.calendar = 'every second tuesday';
    const problems = validateForm(f);
    assert.equal(problemsFor(problems, 'calendar').length > 0, true);
    assert.equal(hasErrors(problems), true);
});

test('a valid OnCalendar expression passes', () => {
    const f = validForm();
    f.scheduleMode = 'custom';
    f.calendar = 'Mon..Fri 02:30';
    assert.equal(hasErrors(validateForm(f)), false);
});

test('an empty custom schedule is an error rather than a silent default', () => {
    const f = validForm();
    f.scheduleMode = 'custom';
    f.calendar = '';
    assert.equal(hasErrors(validateForm(f)), true);
});

test('a NUL byte in a hook is an error', () => {
    const f = validForm();
    f.preHook = 'echo hi\u0000rm -rf /';
    const problems = validateForm(f);
    assert.ok(codes(problems).includes('hook-nul'));
    assert.equal(problemsFor(problems, 'preHook').length, 1);
});

test('an ordinary shell hook is accepted — pipes and semicolons are the point', () => {
    const f = validForm();
    f.preHook = 'pg_dumpall | gzip > /var/backups/db.sql.gz; sync';
    assert.equal(hasErrors(validateForm(f)), false);
});

test('a missing name is a warning, never a blocker', () => {
    const f = validForm();
    f.name = '';
    const problems = validateForm(f);
    assert.ok(codes(problems).includes('name-empty'));
    assert.equal(hasErrors(problems), false);
});

test('validateForm tolerates a null form instead of throwing', () => {
    assert.equal(hasErrors(validateForm(null)), true);
});

// --- progress ------------------------------------------------------------

test('progressLabel renders percent, files and bytes from a restic status message', () => {
    const label = progressLabel({
        message_type: 'status',
        percent_done: 0.4212,
        files_done: 120,
        total_files: 300,
        bytes_done: 1073741824,
        total_bytes: 3221225472
    });
    assert.equal(label, '42% · 120 of 300 files · 1 GiB of 3 GiB');
});

test('progressLabel copes with a status that has no totals yet', () => {
    assert.equal(progressLabel({ message_type: 'status', files_done: 1, bytes_done: 2048 }),
        '1 file · 2 KiB');
});

test('progressLabel says something before the first status arrives', () => {
    assert.equal(progressLabel(null), 'Starting…');
    assert.equal(progressLabel({}), 'Starting…');
    assert.equal(progressLabel('nonsense'), 'Starting…');
});

test('progressLabel ignores fields it cannot use', () => {
    assert.equal(progressLabel({ message_type: 'status', percent_done: 'lots' }), 'Starting…');
});

test('progressPercent converts the fraction and clamps it', () => {
    assert.equal(progressPercent({ percent_done: 0 }), 0);
    assert.equal(progressPercent({ percent_done: 0.5 }), 50);
    assert.equal(progressPercent({ percent_done: 1 }), 100);
    assert.equal(progressPercent({ percent_done: 1.4 }), 100);
    assert.equal(progressPercent({ percent_done: -1 }), 0);
});

test('progressPercent is null when there is no percentage to show', () => {
    // Null means "indeterminate" — an honest striped bar beats a confident 0%.
    assert.equal(progressPercent({}), null);
    assert.equal(progressPercent(null), null);
});

test('formatBytes uses binary units and drops a pointless decimal', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1024), '1 KiB');
    assert.equal(formatBytes(1536), '1.5 KiB');
    assert.equal(formatBytes(1073741824), '1 GiB');
    assert.equal(formatBytes(-1), '');
    assert.equal(formatBytes('nonsense'), '');
});

// --- outcomes ------------------------------------------------------------

test('unreadable files are listed from a partial result', () => {
    const files = unreadableFiles({
        status: 'partial',
        errors: [
            { message_type: 'error', item: '/home/x/.gvfs', error: { message: 'permission denied' } },
            { message_type: 'error', item: '/proc/1/mem', message: 'input/output error' }
        ]
    });
    assert.deepEqual(files, [
        '/home/x/.gvfs — permission denied',
        '/proc/1/mem — input/output error'
    ]);
});

test('unreadableFiles is empty rather than undefined when restic named nothing', () => {
    assert.deepEqual(unreadableFiles({ status: 'partial' }), []);
    assert.deepEqual(unreadableFiles(null), []);
});

test('a never-run job reads as idle, not as a failure', () => {
    assert.deepEqual(lastResultLabel(null), { tone: 'idle', text: 'Never run' });
});

test('an exit-3 run is reported as partial success, with a count', () => {
    const r = lastResultLabel({ status: 'partial', unreadable: 3 });
    assert.equal(r.tone, 'partial');
    assert.match(r.text, /3 files unreadable/);
});

test('a successful and a failed run are told apart', () => {
    assert.equal(lastResultLabel({ status: 'ok' }).tone, 'ok');
    assert.equal(lastResultLabel({ status: 'failed', kind: 'REPO_LOCKED' }).tone, 'failed');
});

test('a backup that succeeded but failed to thin is not shown as a failure', () => {
    assert.equal(lastResultLabel({ status: 'prune-failed' }).tone, 'partial');
});

test('every HangarErrors remediation has an action label', () => {
    // A remediation without a label would render an unlabelled button.
    Object.keys(Errors.REMEDIATION).forEach((kind) => {
        const r = Errors.REMEDIATION[kind];
        assert.ok(remediationLabel(r), 'no label for remediation ' + r);
    });
    assert.equal(remediationLabel(null), '');
});

test('backupOpts turns a stored job into restic run options', () => {
    const opts = backupOpts(sampleJob(), '/srv/backups', '/etc/hangar/repos/nas.key');
    assert.equal(opts.repoUrl, '/srv/backups');
    assert.equal(opts.passwordFile, '/etc/hangar/repos/nas.key');
    assert.deepEqual(opts.paths, ['/etc', '/home']);
    assert.deepEqual(opts.excludes, ['*.tmp']);
    assert.deepEqual(opts.tags, ['nightly']);
    assert.equal(opts.oneFileSystem, true);
});

test('backupOpts feeds buildArgs without a second opinion about the CLI', () => {
    const Restic = require('../../js/engine/restic.js');
    const args = Restic.buildArgs('backup', backupOpts(sampleJob(), '/srv/backups', '/k'));
    assert.ok(args.includes('--one-file-system'));
    assert.ok(args.includes('/home'));
    assert.equal(args[args.indexOf('--exclude') + 1], '*.tmp');
});

test('joinTags renders a tag list back into the single-line field', () => {
    assert.equal(joinTags(['a', 'b']), 'a, b');
    assert.equal(joinTags(null), '');
});

// --- components ----------------------------------------------------------

test('the list component constructs with no DOM and no cockpit', () => {
    const c = Jobs.hangarJobsUi();
    assert.deepEqual(c.jobs, []);
    assert.equal(c.loading, true);
    assert.equal(c.failure, null);
    assert.equal(c.run, null);
});

test('the list component renders a job row without any I/O', () => {
    const c = Jobs.hangarJobsUi();
    const row = { id: 'nightly', job: sampleJob(), state: { status: 'ok' }, unit: null };
    c.jobs = [row];
    c.repos = [{ id: 'nas', name: 'NAS' }];
    assert.equal(c.repoLabel('nas'), 'NAS');
    assert.equal(c.describeSchedule(row), 'Every day at midnight.');
    assert.match(c.describeRetention(row), /^Keeps /);
    assert.equal(c.dotClass(row), 'ok');
});

test('a repository the job points at but that no longer exists is named as missing', () => {
    const c = Jobs.hangarJobsUi();
    assert.match(c.repoLabel('gone'), /missing/);
});

test('a running job pulses regardless of its last result', () => {
    const c = Jobs.hangarJobsUi();
    const row = { id: 'nightly', job: sampleJob(), state: { status: 'failed' } };
    c.run = { jobId: 'nightly', percent: 10, label: '10%' };
    assert.equal(c.dotClass(row), 'running');
});

test('the editor component constructs and refuses to save an empty form', () => {
    const e = Jobs.hangarJobEdit();
    assert.equal(e.canSave(), false);
    assert.ok(e.keepsNothing() === false);      // the default preset keeps plenty
});

test('the editor explains the retention policy before anything is saved', () => {
    const e = Jobs.hangarJobEdit();
    assert.match(e.retentionText(), /Keeps 24 hourly/);
    assert.match(e.retentionEstimate(), /At most about \d+ snapshots/);
    assert.equal(e.scheduleText(), 'Every day at midnight.');
});

test('the editor blocks saving a policy that keeps nothing', () => {
    const e = Jobs.hangarJobEdit();
    e.form = jobToFormState(sampleJob());
    assert.equal(e.canSave(), true);

    e.form.retentionPreset = 'custom';
    e.form.retention = presetFields('rolling');
    assert.equal(e.canSave(), true);

    Object.keys(e.form.retention).forEach((k) => { e.form.retention[k] = ''; });
    assert.equal(e.keepsNothing(), true);
    assert.equal(e.canSave(), false);
    assert.match(e.retentionText(), /Keeps nothing/);
});

test('the editor does not resolve when the form is invalid', () => {
    let resolved = 'untouched';
    const e = Jobs.hangarJobEdit();
    e._resolve = (v) => { resolved = v; };
    e.submit();
    assert.equal(resolved, 'untouched');
    assert.equal(e.submitted, true);
});

test('the editor resolves with the form and drops its resolver', () => {
    let resolved = null;
    const e = Jobs.hangarJobEdit();
    e.form = jobToFormState(sampleJob());
    e._resolve = (v) => { resolved = v; };
    e.submit();
    assert.equal(resolved, e.form);
    assert.equal(e._resolve, null);
});

test('cancelling resolves null so the caller can stop waiting', () => {
    let resolved = 'untouched';
    const e = Jobs.hangarJobEdit();
    e._resolve = (v) => { resolved = v; };
    e.cancel();
    assert.equal(resolved, null);
    assert.equal(e._resolve, null);
});

test('switching to custom seeds the fields from the default preset', () => {
    const e = Jobs.hangarJobEdit();
    e.form.retentionPreset = 'custom';
    e.onPresetChange();
    assert.equal(e.form.retention.hourly, '24');
    assert.equal(e.keepsNothing(), false);
});

test('the editor lists every preset plus a custom option', () => {
    const e = Jobs.hangarJobEdit();
    const names = e.presetNames();
    Object.keys(Retention.PRESETS).forEach((n) => assert.ok(names.includes(n)));
    assert.ok(names.includes('custom'));
    assert.match(e.presetLabel('rolling'), /recommended/);
});

// --- markup --------------------------------------------------------------

test('every control in the screen markup is a real button', () => {
    // Accessibility is not negotiable: a div with a click handler is not a button.
    const clickable = Jobs.SCREEN.match(/@click=/g) || [];
    const buttons = Jobs.SCREEN.match(/<button/g) || [];
    assert.ok(buttons.length >= clickable.length,
        'more click handlers than buttons — something clickable is not a button');
});

test('icon-only controls in the screen markup carry an aria-label', () => {
    const closers = Jobs.SCREEN.match(/<button[^>]*btn-close[\s\S]*?>/g) || [];
    assert.ok(closers.length > 0);
    closers.forEach((b) => assert.match(b, /aria-label=/));
});

// =========================================================================
// Adversarial pass: error states, hostile input, and the invariants the
// design document makes non-negotiable.
//
// The component tests below drive the REAL component against stand-in core
// modules. jobs-ui.js resolves every dependency from the live global on each
// call, so installing one here is the whole mechanism — there is no injection
// seam to keep in sync, and the code under test is the code that ships.
// =========================================================================

const RealConfig = require('../../js/core/config.js');
const RealSchedule = require('../../js/core/schedule.js');
const RealSecrets = require('../../js/core/secrets.js');
require('../../js/core/repos.js');
require('../../js/core/sources.js');

async function withStubs(overrides, fn) {
    const names = Object.keys(overrides);
    const saved = {};
    names.forEach((n) => { saved[n] = globalThis[n]; globalThis[n] = overrides[n]; });
    try {
        return await fn();
    } finally {
        names.forEach((n) => {
            if (saved[n] === undefined) delete globalThis[n];
            else globalThis[n] = saved[n];
        });
    }
}

function sampleRepo() {
    return { id: 'nas', kind: 'local', path: '/srv/backups', name: 'NAS' };
}

// A whole little world on "disk": readJob/readRepo throw whatever an entry holds
// if it is an Error, which is how the unreadable-file cases are set up.
function configStub(o) {
    const jobs = o.jobs || {};
    const repos = o.repos || {};
    const calls = o.calls || [];
    return Object.assign({}, RealConfig, {
        listJobs: async () => { if (o.listJobsError) throw o.listJobsError; return Object.keys(jobs); },
        listRepos: async () => { if (o.listReposError) throw o.listReposError; return Object.keys(repos); },
        readJob: async (id) => { const v = jobs[id]; if (v instanceof Error) throw v; return v; },
        readRepo: async (id) => { const v = repos[id]; if (v instanceof Error) throw v; return v; },
        readState: async (id) => (o.states || {})[id] || null,
        writeJob: async (j) => { calls.push(['writeJob', j.id]); if (o.writeJobError) throw o.writeJobError; }
    }, o.config || {});
}

function scheduleStub(o) {
    const calls = o.calls || [];
    const record = (name) => async (id) => {
        calls.push([name, id]);
        if (o[name + 'Error']) throw o[name + 'Error'];
    };
    return Object.assign({}, RealSchedule, {
        available: () => false,
        unitState: async () => null,
        enable: record('enable'),
        disable: record('disable'),
        start: record('start'),
        stop: record('stop'),
        daemonReload: record('daemonReload')
    }, o.schedule || {});
}

function baseWorld(opts) {
    const o = opts || {};
    const calls = o.calls || [];
    const withCalls = Object.assign({ calls }, o);
    return {
        HangarConfig: configStub(withCalls),
        HangarSchedule: scheduleStub(withCalls),
        HangarRestic: Object.assign({}, require('../../js/engine/restic.js'), {
            run: o.run || (async () => ({ status: 'ok', errors: [] }))
        }),
        HangarDialogs: o.dialogs || {
            confirmDialog: async () => true,
            passwordDialog: async () => 'hunter2'
        },
        HangarSecrets: Object.assign({}, RealSecrets, {
            writeKey: async (id, pw) => {
                calls.push(['writeKey', id, pw]);
                return '/etc/hangar/repos/' + id + '.key';
            }
        })
    };
}

function hangarError(kind, message, detail) {
    return Errors.create(kind, message, detail);
}

// The narrowest cockpit jobs-ui.js can work against: file().replace() and nothing
// else. Anything the component reaches for beyond this is itself a finding.
function fakeCockpit(writes) {
    return {
        file: (path) => ({
            replace: async (content) => { writes.push([content === null ? 'remove' : 'write', path]); }
        })
    };
}

// --- no DOM, no cockpit --------------------------------------------------

test('neither component touches a DOM or a cockpit that is not there', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.cockpit, 'undefined');
    assert.equal(typeof globalThis.window, 'undefined');

    const c = Jobs.hangarJobsUi();
    const e = Jobs.hangarJobEdit();
    // init() registers a listener; with no addEventListener it must return quietly.
    assert.doesNotThrow(() => e.init());
    assert.doesNotThrow(() => Jobs.mount());
    assert.equal(c.unreadable.length, 0);
});

test('every renderer survives an empty row and an empty component state', () => {
    const c = Jobs.hangarJobsUi();
    [{ id: '', job: {}, state: null }, { id: 'x', job: { repo: 'gone' } }].forEach((row) => {
        assert.doesNotThrow(() => c.describeSchedule(row));
        assert.doesNotThrow(() => c.describeRetention(row));
        assert.doesNotThrow(() => c.describeSources(row));
        assert.doesNotThrow(() => c.lastResult(row));
        assert.doesNotThrow(() => c.lastRunTime(row));
        assert.doesNotThrow(() => c.dotClass(row));
        assert.doesNotThrow(() => c.repoLabel(row.job.repo));
    });
});

test('a job with no schedule at all says so instead of throwing', () => {
    const c = Jobs.hangarJobsUi();
    assert.equal(c.describeSchedule({ id: 'j', job: { id: 'j' } }), 'No schedule.');
    assert.equal(c.describeSchedule({ id: 'j', job: { schedule: { calendar: 'not a calendar' } } }),
        'Not a valid schedule.');
});

// --- reload: a partial read is a warning, never a failure ----------------

test('a job whose file cannot be read is listed as unreadable, not hidden', async () => {
    const world = baseWorld({
        jobs: { good: sampleJob(), broken: hangarError('GENERIC', 'Could not read it') },
        repos: { nas: sampleRepo() }
    });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();

        // The load did not fail: the readable job is still on screen.
        assert.equal(c.error, null);
        assert.equal(c.jobs.length, 2);
        assert.equal(c.jobs.filter((r) => r.id === 'good')[0].unreadable, false);

        // ...and the unreadable one is NAMED, by path.
        assert.equal(c.jobs.filter((r) => r.id === 'broken')[0].unreadable, true);
        assert.deepEqual(c.unreadable, ['/etc/hangar/jobs/broken.json']);
    });
});

test('an unreadable repository is named too, and does not hide the readable ones', async () => {
    const world = baseWorld({
        jobs: {},
        repos: { nas: sampleRepo(), old: hangarError('GENERIC', 'permission denied') }
    });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        assert.equal(c.error, null);
        assert.equal(c.repos.length, 2);
        assert.deepEqual(c.unreadable, ['/etc/hangar/repos/old.json']);
        assert.match(c.repoLabel('old'), /unreadable/);
    });
});

test('a job file that is present but empty counts as unreadable, not as an empty job', async () => {
    // Otherwise editing it would save the empty form over whatever is really there.
    const world = baseWorld({ jobs: { ghost: null }, repos: {} });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        assert.equal(c.jobs[0].unreadable, true);
        assert.equal(c.unreadable.length, 1);
    });
});

test('the unreadable warning is rendered as a warning listing the files', () => {
    // Design rule: a partial result is never dressed up as a failure.
    const block = Jobs.SCREEN.slice(Jobs.SCREEN.indexOf('x-if="unreadable.length"'),
        Jobs.SCREEN.indexOf('x-if="partial"'));
    assert.match(block, /alert-warning/);
    assert.ok(!/alert-danger/.test(block));
    assert.match(block, /x-for="\(f, i\) in unreadable"/);
    assert.match(block, /could not be read/i);
});

test('the whole list failing to load IS a failure, with a retry', async () => {
    const world = baseWorld({ listJobsError: hangarError('GENERIC', 'ls: permission denied') });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        assert.ok(c.error);
        assert.match(c.error.message, /permission denied/);
        assert.equal(c.loading, false);
    });
    assert.match(Jobs.SCREEN, /x-if="error"[\s\S]*?Try again/);
});

test('a job that cannot be read cannot be edited', async () => {
    const world = baseWorld({ jobs: { broken: hangarError('GENERIC', 'boom') }, repos: {} });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        let opened = false;
        c.openEditor = () => { opened = true; return Promise.resolve(null); };
        await c.edit(c.jobs[0]);
        assert.equal(opened, false, 'the editor must not open on a job we could not read');
        assert.ok(c.failure);
        assert.match(c.failure.title, /cannot be edited/);
        assert.equal(c.failure.op, 'edit');
    });
    // ...and the markup disables the control rather than relying on the guard alone.
    assert.match(Jobs.SCREEN, /@click="edit\(row\)" :disabled="working \|\| row\.unreadable"/);
    // isRunning(row), not !!run: a backup started by the timer or from another
    // tab must also stop this button offering to start a second one.
    assert.match(Jobs.SCREEN,
        /@click="runNow\(row\)" :disabled="working \|\| isRunning\(row\) \|\| row\.unreadable"/);
});

// --- backup outcomes -----------------------------------------------------

const REMEDIABLE = [
    ['REPO_LOCKED', 'unlock'],
    ['WRONG_PASSWORD', 'reprompt'],
    ['REPO_MISSING', 'init'],
    ['NO_SPACE', 'free-space'],
    ['NETWORK', 'retry']
];

REMEDIABLE.forEach((pair) => {
    test('a ' + pair[0] + ' backup failure offers "' + pair[1] + '" as an action', async () => {
        const world = baseWorld({
            jobs: { nightly: sampleJob() },
            repos: { nas: sampleRepo() },
            run: async () => { throw hangarError(pair[0], 'restic said no'); }
        });
        await withStubs(world, async () => {
            const c = Jobs.hangarJobsUi();
            await c.reload();
            await c.startBackup(sampleJob());

            assert.ok(c.failure, 'no failure was reported');
            assert.equal(c.failure.remediation, pair[1]);
            assert.ok(Jobs.remediationLabel(c.failure.remediation), 'the action button would be unlabelled');
            assert.equal(c.partial, null);
            assert.equal(c.run, null, 'the progress card was left on screen');
            assert.equal(c.working, false);
        });
    });
});

test('READ_ERRORS is a partial success: a warning listing the files, never a failure', async () => {
    // The load-bearing rule from the design doc: restic exit 3 wrote the snapshot.
    const detail = {
        errors: [
            { message_type: 'error', item: '/home/x/.gvfs', error: { message: 'permission denied' } },
            { message_type: 'error', item: '/proc/1/mem', message: 'input/output error' }
        ]
    };
    const world = baseWorld({
        jobs: { nightly: sampleJob() },
        repos: { nas: sampleRepo() },
        run: async () => { throw hangarError('READ_ERRORS', 'some files could not be read', detail); }
    });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        await c.startBackup(sampleJob());

        assert.equal(c.failure, null, 'a written snapshot was reported as a failure');
        assert.ok(c.partial);
        assert.deepEqual(c.partial.files, [
            '/home/x/.gvfs — permission denied',
            '/proc/1/mem — input/output error'
        ]);
    });
});

test('a resolved partial result lists its files too', async () => {
    const world = baseWorld({
        jobs: { nightly: sampleJob() },
        repos: { nas: sampleRepo() },
        run: async () => ({
            status: 'partial',
            errors: [{ message_type: 'error', item: '/var/lib/x', message: 'permission denied' }],
            error: hangarError('READ_ERRORS', 'exit 3')
        })
    });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        await c.startBackup(sampleJob());
        assert.equal(c.failure, null);
        assert.deepEqual(c.partial.files, ['/var/lib/x — permission denied']);
        assert.equal(c.partial.message, '');
    });
});

test('a partial restic named no files for says so rather than showing an empty list', async () => {
    const world = baseWorld({
        jobs: { nightly: sampleJob() },
        repos: { nas: sampleRepo() },
        run: async () => ({ status: 'partial', errors: [], error: hangarError('READ_ERRORS', 'exit 3, no detail') })
    });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        await c.startBackup(sampleJob());
        assert.deepEqual(c.partial.files, []);
        assert.match(c.partial.message, /no detail/);
    });
    assert.match(Jobs.SCREEN, /restic did not name the files/);
});

test('the partial banner is a warning and the failure banner is not', () => {
    const partial = Jobs.SCREEN.slice(Jobs.SCREEN.indexOf('x-if="partial"'),
        Jobs.SCREEN.indexOf('x-if="run"'));
    assert.match(partial, /alert-warning/);
    assert.ok(!/alert-danger/.test(partial));
    assert.match(partial, /snapshot was written/i);

    const failure = Jobs.SCREEN.slice(Jobs.SCREEN.indexOf('x-if="failure"'),
        Jobs.SCREEN.indexOf('x-if="unreadable.length"'));
    assert.match(failure, /alert-danger/);
    assert.match(failure, /applyRemediation\(\)/);
    assert.match(failure, /x-show="failure.remediation"/);
});

test('a cancelled backup is neutral: no failure, no warning', async () => {
    const world = baseWorld({
        jobs: { nightly: sampleJob() },
        repos: { nas: sampleRepo() },
        run: async () => ({ status: 'cancelled', errors: [], error: hangarError('CANCELLED', 'interrupted') })
    });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        await c.startBackup(sampleJob());
        assert.equal(c.failure, null);
        assert.equal(c.partial, null);
        assert.equal(c.run, null);
    });
});

test('an untyped throw from the engine still reaches the user', async () => {
    const world = baseWorld({
        jobs: { nightly: sampleJob() },
        repos: { nas: sampleRepo() },
        run: async () => { throw new TypeError('cockpit.spawn is not a function'); }
    });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        await c.startBackup(sampleJob());
        assert.ok(c.failure);
        assert.match(c.failure.message, /not a function/);
        assert.equal(c.failure.remediation, null, 'an untyped error has no one-click fix');
    });
});

test('a backup pointed at a repository that is gone reports it without a bogus action', async () => {
    const world = baseWorld({ jobs: { nightly: sampleJob() }, repos: {} });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        await c.startBackup(sampleJob());
        assert.ok(c.failure);
        assert.match(c.failure.message, /no longer exists/);
        assert.equal(c.failure.remediation, null);
    });
});

test('a backup is refused against a repository whose definition could not be read', async () => {
    let ran = false;
    const world = baseWorld({
        jobs: { nightly: sampleJob() },
        repos: { nas: hangarError('GENERIC', 'permission denied') },
        run: async () => { ran = true; return { status: 'ok' }; }
    });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        await c.startBackup(sampleJob());
        assert.equal(ran, false, 'restic must not run against a repository we could not read');
        assert.ok(c.failure);
        assert.match(c.failure.message, /could not be read/);
    });
});

test('a repository definition too broken to build a URL from becomes a banner, not a crash', async () => {
    const world = baseWorld({
        jobs: { nightly: sampleJob() },
        repos: { nas: { id: 'nas', kind: 'nonsense' } }
    });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        await c.startBackup(sampleJob());
        assert.ok(c.failure);
        assert.match(c.failure.message, /Unknown repository kind/);
        assert.equal(c.run, null);
        assert.equal(c.working, false);
    });
});

test('progress updates the run card, and a late progress line after the run is harmless', async () => {
    let captured = null;
    let sawPercent = null;
    const world = baseWorld({
        jobs: { nightly: sampleJob() },
        repos: { nas: sampleRepo() },
        run: async (op, opts, onProgress) => {
            captured = onProgress;
            onProgress({ message_type: 'status', percent_done: 0.5, files_done: 2, total_files: 4 });
            return { status: 'ok', errors: [] };
        }
    });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        const original = c.startBackup(sampleJob());
        // The card exists while the run does.
        sawPercent = c.run && c.run.percent;
        await original;
        assert.equal(c.run, null);
        // restic keeps streaming for a moment after the channel closes.
        assert.doesNotThrow(() => captured({ message_type: 'status', percent_done: 0.9 }));
    });
    assert.equal(sawPercent, 50);
});

// --- remediation ---------------------------------------------------------

test('unlocking runs restic unlock and then repeats the backup', async () => {
    const calls = [];
    let attempt = 0;
    const world = baseWorld({
        calls,
        jobs: { nightly: sampleJob() },
        repos: { nas: sampleRepo() },
        run: async (op) => {
            calls.push(['restic', op]);
            attempt += 1;
            if (op === 'backup' && attempt === 1) throw hangarError('REPO_LOCKED', 'locked');
            return { status: 'ok', errors: [] };
        }
    });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        await c.startBackup(sampleJob());
        assert.equal(c.failure.remediation, 'unlock');

        await c.applyRemediation();
        const ops = calls.filter((x) => x[0] === 'restic').map((x) => x[1]);
        assert.deepEqual(ops, ['backup', 'unlock', 'backup']);
        assert.equal(c.failure, null);
        assert.equal(c.working, false);
    });
});

test('a remediation that itself fails replaces the banner instead of vanishing', async () => {
    const world = baseWorld({
        jobs: { nightly: sampleJob() },
        repos: { nas: sampleRepo() },
        run: async (op) => {
            if (op === 'backup') throw hangarError('REPO_LOCKED', 'locked');
            throw hangarError('NETWORK', 'the NAS went away');
        }
    });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        await c.startBackup(sampleJob());
        await c.applyRemediation();
        assert.ok(c.failure, 'the failure was silently cleared');
        assert.match(c.failure.message, /went away/);
        assert.equal(c.failure.remediation, 'retry');
        assert.equal(c.working, false);
    });
});

test('remediating against a repository that has since been deleted explains itself', async () => {
    const world = baseWorld({
        jobs: { nightly: sampleJob() },
        repos: { nas: sampleRepo() },
        run: async () => { throw hangarError('REPO_LOCKED', 'locked'); }
    });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        await c.startBackup(sampleJob());
        c.repos = [];                       // deleted from another tab
        await c.applyRemediation();
        assert.ok(c.failure, 'clicking the action must not just clear the error');
        assert.match(c.failure.title, /no longer configured/);
        assert.equal(c.failure.remediation, null);
    });
});

test('the wrong-password action stores the new password and does not keep it', async () => {
    const calls = [];
    let attempt = 0;
    const world = baseWorld({
        calls,
        jobs: { nightly: sampleJob() },
        repos: { nas: sampleRepo() },
        run: async (op) => {
            attempt += 1;
            if (op === 'backup' && attempt === 1) throw hangarError('WRONG_PASSWORD', 'wrong password');
            return { status: 'ok', errors: [] };
        }
    });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        await c.startBackup(sampleJob());
        assert.equal(c.failure.remediation, 'reprompt');
        await c.applyRemediation();
        assert.deepEqual(calls.filter((x) => x[0] === 'writeKey'), [['writeKey', 'nas', 'hunter2']]);
        assert.equal(c.failure, null);
        // The secret belongs to core/secrets.js, never to a component field.
        assert.ok(!JSON.stringify({ jobs: c.jobs, failure: c.failure, run: c.run }).includes('hunter2'));
    });
});

test('cancelling the password prompt leaves the failure in place and writes nothing', async () => {
    const calls = [];
    const world = baseWorld({
        calls,
        jobs: { nightly: sampleJob() },
        repos: { nas: sampleRepo() },
        run: async () => { throw hangarError('WRONG_PASSWORD', 'wrong password'); },
        dialogs: { confirmDialog: async () => true, passwordDialog: async () => '' }
    });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        await c.startBackup(sampleJob());
        await c.applyRemediation();
        assert.equal(calls.filter((x) => x[0] === 'writeKey').length, 0);
        assert.ok(c.failure);
        assert.equal(c.working, false);
    });
});

test('"Show unreadable files" turns the failure into the warning with the list', async () => {
    const c = Jobs.hangarJobsUi();
    c.failure = {
        jobId: 'nightly', repoId: 'nas', op: 'backup',
        title: 't', message: 'm', remediation: 'list-unreadable',
        error: hangarError('READ_ERRORS', 'exit 3', {
            errors: [{ item: '/proc/1/mem', message: 'input/output error' }]
        })
    };
    await c.applyRemediation();
    assert.equal(c.failure, null);
    assert.deepEqual(c.partial.files, ['/proc/1/mem — input/output error']);
});

test('a failure with no remediation ignores the action entirely', async () => {
    const c = Jobs.hangarJobsUi();
    c.failure = { jobId: 'x', repoId: 'y', title: 't', message: 'm', remediation: null };
    await c.applyRemediation();
    assert.ok(c.failure, 'a failure without a fix must stay on screen');
});

// --- writing -------------------------------------------------------------

test('a save failure says the save failed, and offers the typed remediation', async () => {
    const world = baseWorld({
        jobs: { nightly: sampleJob() },
        repos: { nas: sampleRepo() },
        writeJobError: hangarError('NO_SPACE', 'no space left on device')
    });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        await c.save(jobToFormState(sampleJob()));
        assert.ok(c.failure);
        assert.match(c.failure.title, /not saved/);
        assert.equal(c.failure.remediation, 'free-space');
        // The read banner says "Could not read the job list" — a failed WRITE must
        // not borrow it.
        assert.equal(c.error, null);
        assert.equal(c.working, false);
    });
});

test('nothing is written when the units cannot be rendered', async () => {
    const calls = [];
    const world = baseWorld({
        calls,
        jobs: {}, repos: { nas: sampleRepo() },
        schedule: { renderTimer: () => { throw new Error('no OnCalendar'); } }
    });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        await c.save(jobToFormState(sampleJob()));
        assert.equal(calls.filter((x) => x[0] === 'writeJob').length, 0,
            'a job reached /etc that could never have been scheduled');
        assert.ok(c.failure);
    });
});

test('an invalid form is refused at the last gate before /etc', async () => {
    const calls = [];
    const world = baseWorld({ calls, jobs: {}, repos: {} });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        const form = jobToFormState(sampleJob());
        form.retentionPreset = 'custom';
        Object.keys(form.retention).forEach((k) => { form.retention[k] = ''; });
        await c.save(form);
        assert.equal(calls.filter((x) => x[0] === 'writeJob').length, 0);
        assert.ok(c.failure);
        assert.match(c.failure.message, /not valid/);
    });
});

test('a saved job writes its definition and both units, then enables the timer', async () => {
    const calls = [];
    const writes = [];
    const world = baseWorld({ calls, jobs: {}, repos: { nas: sampleRepo() } });
    world.cockpit = fakeCockpit(writes);
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.save(jobToFormState(sampleJob()));
        assert.equal(c.failure, null, c.failure && c.failure.message);
        assert.deepEqual(writes, [
            ['write', '/etc/systemd/system/hangar-backup@nightly.service'],
            ['write', '/etc/systemd/system/hangar-backup@nightly.timer']
        ]);
        const names = calls.map((x) => x[0]);
        assert.ok(names.indexOf('writeJob') >= 0);
        assert.ok(names.indexOf('enable') >= 0 && names.indexOf('start') >= 0);
    });
});

test('a disabled job is stopped and disabled rather than enabled', async () => {
    const calls = [];
    const world = baseWorld({ calls, jobs: {}, repos: { nas: sampleRepo() } });
    world.cockpit = fakeCockpit([]);
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        const form = jobToFormState(sampleJob());
        form.enabled = false;
        await c.save(form);
        assert.equal(c.failure, null, c.failure && c.failure.message);
        const names = calls.map((x) => x[0]);
        assert.ok(names.indexOf('stop') >= 0 && names.indexOf('disable') >= 0);
        assert.equal(names.indexOf('enable'), -1);
    });
});

test('a failed enable is reported rather than swallowed', async () => {
    const world = baseWorld({
        jobs: {}, repos: { nas: sampleRepo() },
        enableError: hangarError('GENERIC', 'systemd D-Bus is not available')
    });
    world.cockpit = fakeCockpit([]);
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.save(jobToFormState(sampleJob()));
        assert.ok(c.failure);
        assert.match(c.failure.message, /D-Bus/);
    });
});

test('a failed toggle names the job and does not claim the list is unreadable', async () => {
    const world = baseWorld({
        jobs: { nightly: sampleJob() }, repos: { nas: sampleRepo() },
        writeJobError: hangarError('GENERIC', 'read-only file system')
    });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        await c.toggle(c.jobs[0]);
        assert.equal(c.error, null);
        assert.ok(c.failure);
        assert.match(c.failure.title, /schedule for "Nightly home backup" was not changed/);
        assert.equal(c.working, false);
    });
});

test('nothing is deleted when the confirmation cannot be obtained', async () => {
    const removed = [];
    const world = baseWorld({
        jobs: { nightly: sampleJob() }, repos: { nas: sampleRepo() },
        dialogs: { confirmDialog: async () => { throw new Error('modal is not loaded'); } }
    });
    world.HangarConfig.jobPath = (id) => { removed.push(id); return '/etc/hangar/jobs/' + id + '.json'; };
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        await c.remove(c.jobs[0]);
        assert.equal(removed.length, 0, 'a job was deleted without consent');
        assert.ok(c.failure);
        assert.match(c.failure.title, /Nothing was deleted/);
        assert.equal(c.working, false);
    });
});

test('deleting removes the job definition before the units, so a stale unit cannot block it', async () => {
    const writes = [];
    const world = baseWorld({ jobs: { nightly: sampleJob() }, repos: { nas: sampleRepo() } });
    world.cockpit = fakeCockpit(writes);
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        await c.remove(c.jobs[0]);
        assert.equal(c.failure, null, c.failure && c.failure.message);
        assert.deepEqual(writes, [
            ['remove', '/etc/hangar/jobs/nightly.json'],
            ['remove', '/etc/systemd/system/hangar-backup@nightly.timer'],
            ['remove', '/etc/systemd/system/hangar-backup@nightly.service']
        ]);
    });
});

test('a delete that half fails says so instead of pretending it worked', async () => {
    const world = baseWorld({ jobs: { nightly: sampleJob() }, repos: { nas: sampleRepo() } });
    world.cockpit = {
        file: (path) => ({
            replace: async () => {
                if (path.indexOf('systemd') >= 0) throw hangarError('GENERIC', 'read-only file system');
            }
        })
    };
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        await c.remove(c.jobs[0]);
        assert.ok(c.failure, 'a leftover unit file was swallowed');
        assert.match(c.failure.title, /not fully deleted/);
        assert.match(c.failure.message, /read-only/);
    });
});

test('with no cockpit every write path rejects instead of throwing past the caller', async () => {
    const world = baseWorld({ jobs: {}, repos: { nas: sampleRepo() } });
    // The real config module, so writeJob really does try to reach cockpit.
    world.HangarConfig = Object.assign({}, RealConfig, {
        listJobs: async () => [],
        listRepos: async () => ['nas'],
        readRepo: async () => sampleRepo()
    });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await assert.doesNotReject(() => c.save(jobToFormState(sampleJob())));
        assert.ok(c.failure);
        assert.equal(c.error, null);
    });
});

// --- hostile input to the pure functions ---------------------------------

test('unreadableFiles digs the list out of whichever shape it arrives in', () => {
    const one = [{ item: '/a', message: 'denied' }];
    assert.deepEqual(unreadableFiles({ errors: one }), ['/a — denied']);
    assert.deepEqual(unreadableFiles({ detail: { errors: one } }), ['/a — denied']);
    assert.deepEqual(unreadableFiles({ detail: one }), ['/a — denied']);
    assert.deepEqual(unreadableFiles(one), ['/a — denied']);
    assert.deepEqual(unreadableFiles(Errors.create('READ_ERRORS', 'x', { errors: one })), ['/a — denied']);
});

test('unreadableFiles survives entries that are not error objects', () => {
    const files = unreadableFiles({
        errors: [null, undefined, 'plain string', 42, [], {}, { item: '' }, { message: '  ' }]
    });
    assert.deepEqual(files, ['plain string', '42', 'unknown error', 'unknown error', '  ']);
});

test('unreadableFiles keeps quotes, newlines and unicode in a path verbatim', () => {
    const files = unreadableFiles({
        errors: [
            { item: '/srv/"quoted"/файл name', message: 'permission denied' },
            { item: '/srv/two\nlines', error: { message: 'i/o error' } }
        ]
    });
    assert.equal(files[0], '/srv/"quoted"/файл name — permission denied');
    assert.equal(files[1], '/srv/two\nlines — i/o error');
});

test('an enormous unreadable list is truncated with an honest count', () => {
    const errors = [];
    for (let i = 0; i < Jobs.MAX_UNREADABLE + 37; i++) errors.push({ item: '/f/' + i, message: 'denied' });
    const files = unreadableFiles({ errors });
    assert.equal(files.length, Jobs.MAX_UNREADABLE + 1);
    assert.equal(files[Jobs.MAX_UNREADABLE], '… and 37 more files');
});

test('unreadableFiles refuses to invent a list out of nothing', () => {
    [null, undefined, 0, '', 'nope', { errors: 'not a list' }, { detail: 'nope' }, []]
        .forEach((bad) => assert.deepEqual(unreadableFiles(bad), []));
});

test('isReadErrors and isCancelled only fire on the typed errors', () => {
    assert.equal(Jobs.isReadErrors(Errors.create('READ_ERRORS', 'x')), true);
    assert.equal(Jobs.isCancelled(Errors.create('CANCELLED', 'x')), true);
    [null, undefined, new Error('READ_ERRORS'), { kind: 'READ_ERRORS' }, 'READ_ERRORS',
        Errors.create('GENERIC', 'x')].forEach((bad) => {
        assert.equal(Jobs.isReadErrors(bad), false);
        assert.equal(Jobs.isCancelled(bad), false);
    });
});

test('formatBytes refuses values it cannot honestly render', () => {
    [null, undefined, '', {}, [], NaN, Infinity, -Infinity, -1, -1e9, true, false]
        .forEach((bad) => assert.equal(formatBytes(bad), '', 'formatBytes(' + String(bad) + ')'));
    assert.equal(formatBytes('2048'), '2 KiB');
    assert.equal(formatBytes(1125899906842624), '1 PiB');
});

test('progress helpers never throw on a value that cannot be coerced', () => {
    const hostile = [Symbol('nope'), Object.create(null), () => 1, [], {}, new Date(0)];
    hostile.forEach((v) => {
        assert.doesNotThrow(() => progressPercent({ percent_done: v }));
        assert.doesNotThrow(() => progressLabel({ files_done: v, bytes_done: v, total_bytes: v }));
        assert.doesNotThrow(() => formatBytes(v));
    });
    assert.equal(progressPercent({ percent_done: Symbol('nope') }), null);
});

test('a negative byte count does not leave a dangling separator in the progress line', () => {
    assert.equal(progressLabel({ percent_done: 0.5, bytes_done: -1 }), '50%');
    assert.equal(progressLabel({ files_done: -3, bytes_done: 1024 }), '1 KiB');
    assert.equal(progressLabel({ percent_done: 0.5, bytes_done: 1024, total_bytes: 0 }), '50% · 1 KiB');
});

test('a failed run explains itself instead of naming an internal error kind', () => {
    // "Failed (AUTH_EXPIRED)" was on screen in the jobs table: a user cannot act
    // on an enum, and the Overview banner already had the sentence for it.
    assert.equal(lastResultLabel({ status: 'failed', kind: 'AUTH_EXPIRED' }).text,
        'Failed \u2014 the destination\'s sign-in has expired');
    assert.equal(lastResultLabel({ status: 'failed', kind: 'REPO_LOCKED' }).text,
        'Failed \u2014 the repository is locked');
});

test('an unrecognised kind degrades to plain Failed, never to the raw enum', () => {
    for (const kind of ['GENERIC', 'SOMETHING_NEW', '', undefined, null])
        assert.equal(lastResultLabel({ status: 'failed', kind: kind }).text, 'Failed',
            JSON.stringify(kind));
    // Inherited keys must not answer either.
    assert.equal(lastResultLabel({ status: 'failed', kind: 'toString' }).text, 'Failed');
});

test('lastResultLabel survives a state object built by a hostile writer', () => {
    assert.doesNotThrow(() => lastResultLabel({ status: 'failed', kind: Object.create(null) }));
    assert.equal(lastResultLabel({ status: 'failed', kind: Object.create(null) }).text, 'Failed');
    assert.equal(lastResultLabel({ status: 'partial', unreadable: 'lots' }).text, 'Partial — 0 files unreadable');
    assert.equal(lastResultLabel({ status: 'partial', unreadable: 1 }).text, 'Partial — 1 file unreadable');
    assert.equal(lastResultLabel([]).tone, 'idle');
    assert.equal(lastResultLabel('running').tone, 'idle');
});

test('a nonsense timestamp renders as nothing rather than "Invalid Date"', () => {
    const c = Jobs.hangarJobsUi();
    [1e20, -1e20, 'yesterday', {}, NaN, Infinity].forEach((v) => {
        assert.equal(c.lastRunTime({ state: { finished: v } }), '', 'finished=' + String(v));
    });
    assert.ok(c.lastRunTime({ state: { finished: 1754006400 } }).length > 0);
});

test('emptyForm and presetFields hand out fresh objects every time', () => {
    const a = emptyForm();
    a.retention.daily = '99';
    a.paths = '/mutated';
    const b = emptyForm();
    assert.equal(b.retention.daily, '');
    assert.equal(b.paths, '');

    const p = presetFields('rolling');
    p.hourly = '1';
    assert.equal(presetFields('rolling').hourly, '24');
    // ...and the shared preset table is not the thing being edited.
    assert.equal(Retention.PRESETS.rolling.hourly, 24);
});

test('presetFields and formRetention shrug off a nonsense preset name', () => {
    [null, undefined, 42, {}, [], 'no-such', '__proto__', 'constructor'].forEach((bad) => {
        assert.doesNotThrow(() => presetFields(bad));
        assert.doesNotThrow(() => formRetention({ retentionPreset: bad, retention: {} }));
    });
    assert.deepEqual(formRetention({ retentionPreset: '__proto__', retention: {} }), {});
    assert.deepEqual(formRetention({ retentionPreset: 'constructor', retention: {} }), {});
});

test('presetNameFor and keepsNothing tolerate anything at all', () => {
    [null, undefined, 0, '', 'x', [], {}, { daily: 'seven' }, Object.create(null)].forEach((bad) => {
        assert.doesNotThrow(() => presetNameFor(bad));
        assert.doesNotThrow(() => keepsNothing(bad));
    });
    assert.equal(presetNameFor(null), 'custom');
    assert.equal(keepsNothing(null), true);
});

test('a retention count past what JSON can hold is refused, not silently rounded', () => {
    const f = validForm();
    f.retentionPreset = 'custom';
    f.retention.daily = '1e21';
    assert.equal(hasErrors(validateForm(f)), true);
});

test('unicode, quotes and tabs in a job name survive the round trip', () => {
    const job = sampleJob();
    job.name = 'Nightly "home" backup — файлы\ttabbed';
    const back = formStateToJob(jobToFormState(job));
    assert.equal(back.name, job.name);
    assert.equal(hasErrors(validateForm(jobToFormState(job))), false);
});

test('a path with spaces, quotes and unicode is accepted; a NUL byte is not', () => {
    const f = validForm();
    f.paths = '/srv/my "stuff"\n/srv/файлы and spaces';
    assert.equal(hasErrors(validateForm(f)), false);

    // Built from an escape, never typed: a raw NUL byte in a source file is
    // invisible in review.
    f.paths = '/srv/' + String.fromCharCode(0) + 'injected';
    assert.equal(hasErrors(validateForm(f)), true);
});

test('a tag list splits on commas, so restic cannot split it differently later', () => {
    const f = validForm();
    f.tags = 'a,b';
    assert.deepEqual(formSource(f).tags, ['a', 'b']);
    f.tags = 'one tag';
    assert.deepEqual(formSource(f).tags, ['one tag']);
});

test('splitLines drops blanks and trims, including a lone carriage return', () => {
    assert.deepEqual(splitLines('\r\n /a \r\n\r\n/b\r\n'), ['/a', '/b']);
    assert.deepEqual(splitLines(''), []);
    assert.deepEqual(splitLines(null), []);
    assert.deepEqual(splitLines(undefined), []);
    assert.deepEqual(splitLines(['  /a  ', '', 42, null, '/b']), ['/a', '/b']);
});

test('mergeFilesystemSources copes with junk in the sources array', () => {
    [null, undefined, 42, 'x', { sources: null }, { sources: 'x' }, { sources: [null, 7, 'x'] }]
        .forEach((bad) => {
            const merged = mergeFilesystemSources(bad);
            assert.equal(merged.kind, 'filesystem');
            assert.deepEqual(merged.paths, []);
        });
    const merged = mergeFilesystemSources({ sources: [{ kind: 'filesystem', paths: '/single' }] });
    assert.deepEqual(merged.paths, ['/single']);
});

test('a null entry in sources is never written back to disk', () => {
    const job = sampleJob();
    job.sources.push(null, 'nonsense', 42);
    const back = formStateToJob(jobToFormState(job));
    assert.equal(back.sources.length, 1);
    assert.ok(back.sources.every((s) => s && typeof s === 'object'));
});

test('scheduleModeFor and formCalendar refuse to invent a schedule', () => {
    [null, undefined, 42, {}, [], '   ', '日曜日'].forEach((bad) => {
        assert.equal(scheduleModeFor(bad), 'custom');
    });
    assert.equal(formCalendar({ scheduleMode: {} }), '');
    assert.equal(formCalendar(null), '');
    assert.equal(formCalendar({ scheduleMode: 'custom', calendar: null }), '');
});

test('backupOpts never throws, whatever the stored job holds', () => {
    [null, undefined, 42, 'x', {}, { sources: null }].forEach((bad) => {
        assert.doesNotThrow(() => backupOpts(bad, '/srv', '/k'));
    });
    assert.deepEqual(backupOpts(null, '/srv', '/k').paths, []);
});

test('validateForm never throws, for any shape of form or taken list', () => {
    const forms = [null, undefined, 42, 'x', [], {}, Object.create(null),
        { id: 42, name: {}, repo: [], paths: 7, retention: 'x', retentionPreset: 9 }];
    const takens = [undefined, null, 'nightly', [null, 42], []];
    forms.forEach((f) => takens.forEach((t) => {
        assert.doesNotThrow(() => validateForm(f, t));
    }));
});

test('every remediation the errors module can produce has an action label', () => {
    Object.keys(Errors.REMEDIATION).forEach((kind) => {
        const label = remediationLabel(Errors.REMEDIATION[kind]);
        assert.ok(label && label.length > 3, 'unusable label for ' + kind);
    });
    [null, undefined, '', 'made-up', 42, {}, '__proto__', 'constructor']
        .forEach((bad) => assert.equal(remediationLabel(bad), ''));
});

// --- accessibility -------------------------------------------------------

test('every button in the screen markup declares its type', () => {
    // A button inside a form defaults to type=submit; the jobs table is not a form
    // today, but the modal footer is, and the habit is what keeps that safe.
    (Jobs.SCREEN.match(/<button[^>]*>/g) || []).forEach((b) => {
        assert.match(b, /type="button"/, b);
    });
});

test('the decorative status dot is hidden from screen readers', () => {
    // It repeats the "Last result" column; announcing an empty span helps nobody.
    const dots = Jobs.SCREEN.match(/<span class="hangar-dot"[^>]*>/g) || [];
    assert.ok(dots.length > 0);
    dots.forEach((d) => assert.match(d, /aria-hidden="true"/));
});

test('the progress bar carries the ARIA a progress bar needs', () => {
    const bar = Jobs.SCREEN.slice(Jobs.SCREEN.indexOf('role="progressbar"'));
    assert.match(bar, /aria-valuemin="0"/);
    assert.match(bar, /aria-valuemax="100"/);
    assert.match(bar, /:aria-valuenow=/);
    assert.match(bar, /aria-label="Backup progress"/);
});

test('the jobs table marks up its header cells', () => {
    const heads = Jobs.SCREEN.match(/<th\b[^>]*>/g) || [];
    assert.ok(heads.length >= 6);
    heads.forEach((h) => assert.match(h, /scope="col"/));
});

const editHtml = require('node:fs').readFileSync(__dirname + '/../../html/modals/job-edit.html', 'utf8');

test('the editor has no clickable non-buttons', () => {
    const clickable = editHtml.match(/<(\w+)[^>]*@click=/g) || [];
    assert.ok(clickable.length > 0);
    clickable.forEach((tag) => assert.match(tag, /^<button/, tag));
});

test('every control in the editor is bound to a label', () => {
    const controls = editHtml.match(/<(input|select|textarea)\b[^>]*>/g) || [];
    const labels = editHtml.match(/<label\b[^>]*>/g) || [];
    const staticFor = new Set();
    const boundFor = new Set();
    labels.forEach((l) => {
        const s = /\bfor="([^"]+)"/.exec(l);
        const b = /:for="([^"]+)"/.exec(l);
        if (s) staticFor.add(s[1]);
        if (b) boundFor.add(b[1]);
    });

    assert.ok(controls.length >= 12, 'the editor lost its fields');
    controls.forEach((c) => {
        const id = /\bid="([^"]+)"/.exec(c);
        const bound = /:id="([^"]+)"/.exec(c);
        if (id) assert.ok(staticFor.has(id[1]), 'no label for #' + id[1]);
        else if (bound) assert.ok(boundFor.has(bound[1]), 'no label bound to ' + bound[1]);
        else assert.fail('a control with no id at all: ' + c);
    });
});

test('the editor dialog names itself for assistive technology', () => {
    const labelled = /aria-labelledby="([^"]+)"/.exec(editHtml);
    assert.ok(labelled);
    assert.ok(editHtml.includes('id="' + labelled[1] + '"'), 'aria-labelledby points at nothing');
    assert.match(editHtml, /<button[^>]*class="btn-close"[^>]*aria-label="Close"/);
});

test('the editor tells the user why saving is blocked, not just that it is', () => {
    assert.match(editHtml, /:disabled="!canSave\(\)"/);
    assert.match(editHtml, /Fix the highlighted fields before saving/);
    assert.match(editHtml, /pruning it would delete every/);
});

test('neither of this screen\'s files mentions a Time Machine, in any casing', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(require.resolve('../../js/features/jobs-ui.js'), 'utf8');
    [src, editHtml].forEach((text) => {
        assert.ok(!/time[\s_-]*machine/i.test(text));
        assert.ok(!/timemachine/i.test(text));
    });
});

test('a failure is titled by what actually failed, never by what did not', () => {
    // A save that failed used to be announced as a failed backup, which sent the
    // user looking at restic instead of at /etc.
    assert.match(Jobs.failureTitle('backup', 'Nightly'), /^Backup of "Nightly"/);
    assert.match(Jobs.failureTitle('save', 'Nightly'), /not saved/);
    assert.match(Jobs.failureTitle('delete', 'Nightly'), /not fully deleted/);
    assert.match(Jobs.failureTitle('toggle', 'Nightly'), /schedule/);
    // An unknown or hostile op falls back rather than rendering "undefined".
    [null, undefined, '', 42, {}, '__proto__', 'constructor'].forEach((bad) => {
        assert.equal(typeof Jobs.failureTitle(bad, 'Nightly'), 'string');
        assert.ok(Jobs.failureTitle(bad, 'Nightly').length > 0);
    });
    assert.match(Jobs.failureTitle('save', null), /not saved/);
    assert.match(Jobs.failureTitle('backup', null), /this job/);
});

test('a remediation that fails keeps the title of the operation it belongs to', async () => {
    // The retry of a failed SAVE must not report itself as a failed backup.
    const world = baseWorld({
        jobs: { nightly: sampleJob() },
        repos: { nas: sampleRepo() },
        writeJobError: hangarError('REPO_LOCKED', 'locked'),
        run: async () => { throw hangarError('NETWORK', 'still unreachable'); }
    });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        await c.save(jobToFormState(sampleJob()));
        assert.equal(c.failure.op, 'save');
        await c.applyRemediation();
        assert.ok(c.failure);
        assert.match(c.failure.title, /not saved/, 'a failed save was reported as a failed backup');
    });
});

test('remediating a non-backup failure does not start a backup behind the users back', async () => {
    const ops = [];
    const world = baseWorld({
        jobs: { nightly: sampleJob() },
        repos: { nas: sampleRepo() },
        writeJobError: hangarError('REPO_LOCKED', 'locked'),
        run: async (op) => { ops.push(op); return { status: 'ok', errors: [] }; }
    });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        await c.save(jobToFormState(sampleJob()));
        assert.equal(c.failure.remediation, 'unlock');
        await c.applyRemediation();
        assert.deepEqual(ops, ['unlock'], 'unlocking a failed save silently ran a backup');
        assert.equal(c.failure, null);
    });
});

test('every aria-describedby in the editor points at an element that exists', () => {
    // An error message the user can see but a screen reader never reaches is not
    // an error message.
    const refs = [...editHtml.matchAll(/\baria-describedby="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length >= 8, 'fields lost their description hooks');
    refs.forEach((ref) => {
        ref.split(/\s+/).forEach((id) => {
            assert.ok(editHtml.includes('id="' + id + '"'), 'aria-describedby="' + id + '" points at nothing');
        });
    });
});

test('every field that can show an error also reports its validity', () => {
    const controls = editHtml.match(/<(input|select|textarea)\b[^>]*>/g) || [];
    const fields = [...editHtml.matchAll(/messageFor\('([a-zA-Z]+)'\)/g)].map((m) => m[1]);
    // `name` is warning-only, so it never marks the field invalid.
    const errorFields = fields.filter((f) => f !== 'name');
    errorFields.forEach((f) => {
        assert.ok(controls.some((c) => c.includes("invalid('" + f + "')")),
            'field ' + f + ' shows an error but never sets aria-invalid');
    });
});

test('the submit-blocked message announces itself', () => {
    assert.match(editHtml, /role="alert"[\s\S]{0,120}Fix the highlighted fields/);
});

// ========================================================================
// v2 — container and libvirt source kinds in the editor
//
// The editor grew a source-kind chooser and a form per kind. What is tested
// here is the same thing that is tested above: the pure functions that decide,
// not the Alpine bindings that display. The one exception is discovery, which
// is impure by nature — those tests assert what happens when the host does not
// answer, because on this development host it frequently does not.
// ========================================================================

const Container = require('../../js/core/sources-container.js');
const Libvirt = require('../../js/core/sources-libvirt.js');
const Sources = require('../../js/core/sources.js');

const {
    sourceKinds, sourceKindLabel, runtimeOptions, consistencyOptions, consistencyInfo,
    uriOptions, quiesceOptions, quiesceInfo, nameList, checkboxList,
    fieldForSourceProblem, sourceWarnings, riskWarnings, sourceDescription,
    primaryKind, primarySource, runsInBrowser, emptyContainerFields, emptyLibvirtFields
} = Jobs;

function containerForm(over) {
    const f = emptyForm();
    f.id = 'vols';
    f.name = 'Container volumes';
    f.repo = 'nas';
    f.sourceKind = 'container';
    Object.assign(f.container, { user: 'appuser', volumes: ['pgdata'] }, (over || {}).container || {});
    return Object.assign(f, over && over.form ? over.form : {});
}

function libvirtForm(over) {
    const f = emptyForm();
    f.id = 'vms';
    f.name = 'Virtual machines';
    f.repo = 'nas';
    f.sourceKind = 'libvirt';
    Object.assign(f.libvirt, { domains: ['web01'] }, (over || {}).libvirt || {});
    return f;
}

function messages(list) { return list.map((p) => p.message); }

// --- the chooser is driven by the registry, not by a second list ---------

test('the chooser offers exactly the kinds that registered themselves', () => {
    const offered = sourceKinds().map((k) => k.id);
    assert.deepEqual(offered.slice().sort(), Sources.kinds());
    // Order is the chooser's, not the registry's alphabetical order: files first
    // because it is what most jobs are.
    assert.deepEqual(offered, ['filesystem', 'container', 'libvirt']);
});

test('every offered kind has a label and a description', () => {
    sourceKinds().forEach((k) => {
        assert.equal(typeof k.label, 'string');
        assert.ok(k.label.length > 0, k.id + ' has no label');
        assert.ok(k.description.length > 0, k.id + ' has no description');
    });
});

test('an unknown kind id labels as itself rather than as "undefined"', () => {
    assert.equal(sourceKindLabel('container'), 'Container volumes');
    [null, undefined, '', 42, {}, '__proto__', 'constructor'].forEach((bad) => {
        assert.equal(typeof sourceKindLabel(bad), 'string');
    });
});

// --- the option tables come from the kinds, never from a copy ------------

test('the runtime picker is the container module RUNTIMES table', () => {
    assert.deepEqual(runtimeOptions(), Container.RUNTIMES);
    // A copy, so a component cannot mutate the module's table by reference.
    assert.notEqual(runtimeOptions(), Container.RUNTIMES);
});

test('the consistency picker is the container CONSISTENCY table, worst first', () => {
    const ids = consistencyOptions().map((m) => m.id);
    assert.deepEqual(ids, Container.CONSISTENCY_IDS);
    assert.equal(ids[0], 'none', 'the ordering of the table is the advice');
    consistencyOptions().forEach((m) => {
        assert.equal(m, Container.CONSISTENCY[m.id], 'a mode was rewritten instead of read');
        assert.ok(m.description.length > 0);
        assert.ok(['high', 'medium', 'low'].indexOf(m.risk) >= 0);
    });
});

test('the connection picker is the libvirt URIS table', () => {
    assert.deepEqual(uriOptions().map((u) => u.id), Libvirt.URIS.map((u) => u.id));
});

test('the quiesce picker is the libvirt QUIESCE table', () => {
    assert.deepEqual(quiesceOptions(), Libvirt.QUIESCE);
    quiesceOptions().forEach((m) => assert.ok(m.description.length > 0));
});

test('an unknown mode id yields no mode rather than a made-up one', () => {
    assert.equal(consistencyInfo('stop').id, 'stop');
    assert.equal(quiesceInfo('agent').id, 'agent');
    [null, undefined, '', 'nonsense', 42, {}, '__proto__', 'constructor', 'toString'].forEach((bad) => {
        assert.equal(consistencyInfo(bad), null, String(bad));
        assert.equal(quiesceInfo(bad), null, String(bad));
    });
});

// --- form defaults -------------------------------------------------------

test('a new form starts on the filesystem kind, so v1 behaviour is the default', () => {
    assert.equal(emptyForm().sourceKind, 'filesystem');
});

test('the container form defaults to the module defaults', () => {
    const c = emptyContainerFields();
    assert.equal(c.runtime, Container.DEFAULT_RUNTIME);
    assert.equal(c.consistency, Container.DEFAULT_CONSISTENCY);
    assert.deepEqual(c.volumes, []);
    assert.deepEqual(c.containers, []);
});

test('the libvirt form defaults to the module defaults, with the XML on', () => {
    const v = emptyLibvirtFields();
    assert.equal(v.uri, Libvirt.DEFAULT_URI);
    assert.equal(v.quiesce, Libvirt.DEFAULT_QUIESCE);
    // The one default that is a data-safety decision: a disk image without its
    // domain XML is not a VM you can start.
    assert.equal(v.includeXml, true);
});

// --- formSource dispatches on the chosen kind ----------------------------

test('formSource builds a container source when the container kind is chosen', () => {
    const s = formSource(containerForm());
    assert.equal(s.kind, 'container');
    assert.equal(s.runtime, 'podman');
    assert.equal(s.user, 'appuser');
    assert.deepEqual(s.volumes, ['pgdata']);
    assert.equal('paths' in s, false, 'a container source must not carry filesystem paths');
});

test('formSource builds a libvirt source when the libvirt kind is chosen', () => {
    const s = formSource(libvirtForm());
    assert.equal(s.kind, 'libvirt');
    assert.equal(s.uri, 'qemu:///system');
    assert.deepEqual(s.domains, ['web01']);
    assert.equal(s.includeXml, true);
});

test('an unknown or hostile sourceKind falls back to filesystem', () => {
    [null, undefined, '', 'nonsense', 42, {}, [], '__proto__', 'constructor'].forEach((bad) => {
        const f = emptyForm();
        f.sourceKind = bad;
        f.paths = '/etc';
        assert.equal(formSource(f).kind, 'filesystem', String(bad));
    });
});

test('formSource survives a form whose per-kind section is missing entirely', () => {
    [null, undefined, 42, 'nonsense', []].forEach((bad) => {
        const c = emptyForm();
        c.sourceKind = 'container';
        c.container = bad;
        assert.equal(formSource(c).kind, 'container');
        const v = emptyForm();
        v.sourceKind = 'libvirt';
        v.libvirt = bad;
        assert.equal(formSource(v).kind, 'libvirt');
    });
});

test('the dump command is written only by the mode that runs it', () => {
    const f = containerForm({ container: { consistency: 'stop', containers: ['app'], command: 'pg_dump app' } });
    assert.equal('command' in formSource(f), false,
        'a command left behind by another mode would never run, and the user would still believe in it');

    f.container.consistency = 'command';
    assert.equal(formSource(f).command, 'pg_dump app');
});

test('includeXml=false is written explicitly, not omitted', () => {
    // normalize() reads an absent includeXml as true, so an omitted false would
    // silently turn the XML back on between saving and running.
    const s = formSource(libvirtForm({ libvirt: { includeXml: false } }));
    assert.equal(s.includeXml, false);
    assert.equal(Libvirt.normalize(s).includeXml, false);
});

// --- ticked names plus typed names --------------------------------------

test('nameList unions what was ticked with what was typed', () => {
    assert.deepEqual(nameList(['a', 'b'], 'c\nd'), ['a', 'b', 'c', 'd']);
});

test('nameList de-duplicates across the two, keeping the ticked order', () => {
    assert.deepEqual(nameList(['b', 'a'], 'a\nc\nb'), ['b', 'a', 'c']);
});

test('nameList trims, and drops blank lines rather than making empty names', () => {
    assert.deepEqual(nameList([], '  pgdata  \n\n\n uploads \n'), ['pgdata', 'uploads']);
    assert.deepEqual(nameList([], ''), []);
    assert.deepEqual(nameList([], '   \n  '), []);
});

test('nameList accepts a string where a list was expected', () => {
    assert.deepEqual(nameList('a\nb', 'c'), ['a', 'b', 'c']);
});

test('nameList survives every garbage shape', () => {
    [null, undefined, 42, {}, [null, 3, 'ok'], true].forEach((bad) => {
        assert.doesNotThrow(() => nameList(bad, bad));
        assert.ok(Array.isArray(nameList(bad, bad)));
    });
    assert.deepEqual(nameList([null, 3, 'ok'], null), ['ok']);
});

// --- the multi-select list ----------------------------------------------

test('a selected volume the runtime no longer reports still appears, flagged', () => {
    // Dropping it from the list would drop it from the backup on the next save,
    // with nothing on screen to say so.
    const list = checkboxList(['pgdata', 'uploads'], ['pgdata', 'gone']);
    assert.deepEqual(list.map((e) => e.name), ['pgdata', 'uploads', 'gone']);
    assert.deepEqual(list.map((e) => e.discovered), [true, true, false]);
});

test('the choice list de-duplicates and survives garbage', () => {
    assert.deepEqual(checkboxList(['a', 'a'], ['a']), [{ name: 'a', discovered: true }]);
    [null, undefined, 42, {}, 'a\nb'].forEach((bad) => {
        assert.doesNotThrow(() => checkboxList(bad, bad));
    });
    assert.deepEqual(checkboxList([], []), []);
});

// --- THE WARNINGS: the reason this screen exists ------------------------

test('a live copy of a running database is warned about, in the kind\'s own words', () => {
    const f = containerForm({ container: { consistency: 'none', containers: ['app-postgres-1'] } });
    const warnings = riskWarnings(f);
    const live = warnings.filter((w) => w.code === 'live-database')[0];
    assert.ok(live, 'no warning was raised for a live copy of a postgres container');

    // Verbatim from the kind. A second copy of this wording here would drift
    // from the one core/ enforces, and this is not wording to get wrong.
    const fromKind = Sources.validate(formSource(f))
        .filter((p) => p.code === 'live-database')[0];
    assert.equal(live.message, fromKind.message);
    assert.match(live.message, /may not restore|will not restore/);
});

test('every database hint the container kind knows is warned about', () => {
    Container.DATABASE_HINTS.forEach((hint) => {
        const f = containerForm({ container: { consistency: 'none', containers: ['prod-' + hint + '-1'] } });
        assert.ok(riskWarnings(f).some((w) => w.code === 'live-database'),
            'a container named after ' + hint + ' was not flagged');
    });
});

test('choosing a safe consistency mode clears the database warning', () => {
    ['stop', 'command'].forEach((mode) => {
        const f = containerForm({
            container: { consistency: mode, containers: ['app-postgres-1'], command: 'pg_dumpall > /backup/all.sql' }
        });
        assert.deepEqual(riskWarnings(f).filter((w) => w.code === 'live-database'), []);
    });
});

test('a podman source with no owning user is warned about', () => {
    // The single most likely reason a rootless container backup comes back empty.
    const f = containerForm({ container: { user: '' } });
    assert.ok(riskWarnings(f).some((w) => w.code === 'no-user'));
    assert.deepEqual(riskWarnings(containerForm()).filter((w) => w.code === 'no-user'), []);
});

test('each libvirt quiesce mode raises exactly the warning it deserves', () => {
    const codes = (mode) => riskWarnings(libvirtForm({ libvirt: { quiesce: mode } })).map((w) => w.code);
    assert.deepEqual(codes('none'), ['quiesce-crash-consistent']);
    assert.deepEqual(codes('agent'), ['quiesce-agent-required']);
    assert.deepEqual(codes('shutdown'), []);
});

test('turning the domain XML off is warned about', () => {
    const codes = riskWarnings(libvirtForm({ libvirt: { quiesce: 'shutdown', includeXml: false } }))
        .map((w) => w.code);
    assert.deepEqual(codes, ['no-xml']);
});

test('every risk code this screen promotes is a code a kind actually emits', () => {
    // A code in RISK_CODES that no kind emits is a warning that silently never
    // shows; the opposite is a warning shown as grey helper text.
    const emitted = Object.keys(Container.PROBLEM).map((k) => Container.PROBLEM[k])
        .concat(Object.keys(Libvirt.PROBLEM).map((k) => Libvirt.PROBLEM[k]));
    Jobs.RISK_CODES.forEach((code) => {
        assert.ok(emitted.indexOf(code) >= 0, code + ' is promoted but no kind emits it');
    });
});

test('warnings are warnings: none of them blocks saving', () => {
    const forms = [
        containerForm({ container: { user: '', consistency: 'none', containers: ['mongo'] } }),
        libvirtForm({ libvirt: { quiesce: 'none', includeXml: false } })
    ];
    forms.forEach((f) => {
        const problems = validateForm(f, []);
        assert.ok(problems.some((p) => p.severity === 'warning'), 'the warning was lost');
        assert.equal(hasErrors(problems), false, 'a warning blocked the save');
        assert.ok(riskWarnings(f).length > 0);
    });
});

test('riskWarnings and sourceWarnings never throw, for any form', () => {
    [null, undefined, 42, 'nonsense', [], {}, { sourceKind: 'container' },
        { sourceKind: 'libvirt', libvirt: null }, { sourceKind: '__proto__' }].forEach((bad) => {
        assert.doesNotThrow(() => riskWarnings(bad), String(bad));
        assert.doesNotThrow(() => sourceWarnings(bad), String(bad));
        assert.ok(Array.isArray(riskWarnings(bad)));
    });
});

test('sourceDescription reports the kind\'s own sentence, and never throws', () => {
    assert.match(sourceDescription(containerForm()), /podman volume/);
    assert.match(sourceDescription(libvirtForm()), /web01/);
    assert.match(sourceDescription(emptyForm()), /no paths/);
    [null, undefined, 42, [], { sourceKind: 'container', container: null }].forEach((bad) => {
        assert.doesNotThrow(() => sourceDescription(bad));
        assert.equal(typeof sourceDescription(bad), 'string');
    });
});

// --- problems land next to the field that causes them -------------------

test('every new problem code is routed to its own field, not to the catch-all', () => {
    const routes = {
        'no-volumes': 'volumes', 'volume-unsafe': 'volumes', 'volume-duplicate': 'volumes',
        'no-containers': 'containers', 'container-empty': 'containers',
        'bad-runtime': 'runtime',
        'bad-user': 'user', 'no-user': 'user',
        'no-command': 'command', 'command-nul': 'command',
        'bad-consistency': 'consistency', 'live-database': 'consistency',
        'no-domains': 'domains', 'domain-unsafe': 'domains',
        'uri-empty': 'uri',
        'quiesce-unknown': 'quiesce', 'quiesce-crash-consistent': 'quiesce',
        'no-xml': 'includeXml',
        // v1 routing is untouched.
        'no-paths': 'paths', 'path-traversal': 'paths',
        'pattern-empty': 'excludes', 'tag-comma': 'tags', 'exclude-file-relative': 'excludeFile'
    };
    Object.keys(routes).forEach((code) => {
        assert.equal(fieldForSourceProblem(code), routes[code], code);
    });
});

test('an unrecognised code still lands somewhere that is rendered', () => {
    [null, undefined, 42, {}, 'who-knows', '__proto__'].forEach((bad) => {
        assert.equal(fieldForSourceProblem(bad), 'source', String(bad));
    });
});

test('a container source with no volumes is an error on the volumes field', () => {
    const f = containerForm({ container: { volumes: [] } });
    const problems = validateForm(f, []);
    assert.ok(hasErrors(problems));
    assert.ok(problemsFor(problems, 'volumes').some((p) => p.severity === 'error'));
});

test('the dump-command mode without a command is an error on the command field', () => {
    const f = containerForm({ container: { consistency: 'command', containers: ['app'], command: '' } });
    const problems = validateForm(f, []);
    assert.ok(problemsFor(problems, 'command').some((p) => p.severity === 'error'));
});

test('pausing or stopping with no container named is an error on the container field', () => {
    ['pause', 'stop'].forEach((mode) => {
        const f = containerForm({ container: { consistency: mode, containers: [] } });
        assert.ok(problemsFor(validateForm(f, []), 'containers').some((p) => p.severity === 'error'), mode);
    });
});

test('a libvirt source with no domain is an error on the domains field', () => {
    const f = libvirtForm({ libvirt: { domains: [] } });
    assert.ok(problemsFor(validateForm(f, []), 'domains').some((p) => p.severity === 'error'));
});

test('a name the runtime would refuse is reported against the field it was typed in', () => {
    const f = containerForm({ container: { volumes: [], volumesText: '-rf' } });
    assert.ok(problemsFor(validateForm(f, []), 'volumes').some((p) => p.severity === 'error'));
});

test('a fully configured container job saves cleanly', () => {
    const f = containerForm({
        container: { consistency: 'stop', containers: ['app-postgres-1'], user: 'appuser' }
    });
    assert.equal(hasErrors(validateForm(f, [])), false, JSON.stringify(validateForm(f, [])));
});

// --- job <-> form round trips -------------------------------------------

test('a container job round-trips through the form unchanged', () => {
    const job = {
        id: 'vols', name: 'Volumes', repo: 'nas', enabled: true,
        sources: [{
            id: 'main', kind: 'container', runtime: 'docker', user: 'appuser',
            volumes: ['pgdata', 'uploads'], consistency: 'stop',
            containers: ['app', 'app-postgres-1'], excludes: ['*.sock'], tags: ['nightly']
        }],
        retention: { hourly: 24, daily: 30, weekly: 52, monthly: 12 },
        schedule: { calendar: 'daily' }
    };
    const back = formStateToJob(jobToFormState(job));
    assert.deepEqual(back.sources, job.sources);
});

test('a libvirt job round-trips through the form unchanged', () => {
    const job = {
        id: 'vms', name: 'VMs', repo: 'nas', enabled: true,
        sources: [{
            id: 'main', kind: 'libvirt', uri: 'qemu:///session',
            domains: ['db01', 'web01'], quiesce: 'agent', includeXml: false,
            excludes: ['*.iso'], tags: ['vm']
        }],
        retention: { daily: 7 },
        schedule: { calendar: 'daily' }
    };
    const back = formStateToJob(jobToFormState(job));
    assert.deepEqual(back.sources, job.sources);
});

test('a container-only job opens on the container form, not an empty file form', () => {
    const f = jobToFormState({
        id: 'vols', repo: 'nas',
        sources: [{ id: 'main', kind: 'container', volumes: ['pgdata'], consistency: 'pause', containers: ['db'] }]
    });
    assert.equal(f.sourceKind, 'container');
    assert.deepEqual(f.container.volumes, ['pgdata']);
    assert.equal(f.container.consistency, 'pause');
    assert.equal(f.paths, '', 'a container job must not present itself as a file job');
    assert.deepEqual(f.otherSources, []);
});

test('a libvirt-only job opens on the libvirt form with its XML setting intact', () => {
    const f = jobToFormState({
        id: 'vms', repo: 'nas',
        sources: [{ id: 'main', kind: 'libvirt', domains: ['web01'], includeXml: false, quiesce: 'shutdown' }]
    });
    assert.equal(f.sourceKind, 'libvirt');
    assert.equal(f.libvirt.includeXml, false);
    assert.equal(f.libvirt.quiesce, 'shutdown');
    assert.deepEqual(f.libvirt.domains, ['web01']);
});

test('a filesystem source still wins the editor when a job has both', () => {
    // A v1 job that gained a container source must keep editing as it did in v1.
    const job = sampleJob();
    job.sources.push({ id: 'vols', kind: 'container', volumes: ['pgdata'] });
    const f = jobToFormState(job);
    assert.equal(f.sourceKind, 'filesystem');
    assert.equal(f.paths, '/etc\n/home');
    assert.deepEqual(formStateToJob(f).sources[1], { id: 'vols', kind: 'container', volumes: ['pgdata'] });
});

test('a second source of the edited kind survives the edit untouched', () => {
    // Two container sources may name different runtimes or different users, so
    // merging them the way filesystem sources are merged would be wrong.
    const second = { id: 'other', kind: 'container', runtime: 'docker', user: 'root', volumes: ['cache'] };
    const job = {
        id: 'vols', repo: 'nas',
        sources: [{ id: 'main', kind: 'container', volumes: ['pgdata'] }, second]
    };
    const back = formStateToJob(jobToFormState(job));
    assert.equal(back.sources.length, 2);
    assert.deepEqual(back.sources[1], second);
});

test('primaryKind and primarySource agree, and never throw', () => {
    assert.equal(primaryKind(sampleJob()), 'filesystem');
    assert.equal(primaryKind({ sources: [{ kind: 'libvirt', domains: ['a'] }] }), 'libvirt');
    assert.equal(primaryKind({ sources: [{ kind: 'container', volumes: ['a'] }] }), 'container');
    // Nothing renderable falls back to the filesystem form, which is empty and
    // harmless rather than an editor that refuses to open.
    [null, undefined, 42, {}, { sources: null }, { sources: [null, 'x', 7] },
        { sources: [{ kind: 'martian' }] }].forEach((bad) => {
        assert.equal(primaryKind(bad), 'filesystem', JSON.stringify(bad));
        assert.doesNotThrow(() => primarySource(bad));
    });
});

test('a job the browser cannot back up correctly is handed to its unit instead', () => {
    // Running restic here for a container job would back up an empty path vector
    // and report success. The unit resolves the mount points and unwinds the
    // pause in a try/finally that survives this page being closed.
    assert.equal(runsInBrowser(sampleJob()), true);
    assert.equal(runsInBrowser({ sources: [{ kind: 'container', volumes: ['a'] }] }), false);
    assert.equal(runsInBrowser({ sources: [{ kind: 'libvirt', domains: ['a'] }] }), false);
    assert.equal(runsInBrowser({}), true);
});

test('startBackup delegates a container job to systemd and never runs restic', async () => {
    const calls = [];
    const job = {
        id: 'vols', name: 'Volumes', repo: 'nas', enabled: true,
        sources: [{ id: 'main', kind: 'container', volumes: ['pgdata'] }],
        retention: { daily: 7 }, schedule: { calendar: 'daily' }
    };
    const ops = [];
    const world = baseWorld({
        jobs: { vols: job },
        repos: { nas: sampleRepo() },
        run: async (op) => { ops.push(op); return { status: 'ok', errors: [] }; },
        schedule: { runNow: async (id) => { calls.push(id); } }
    });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        await c.startBackup(job);
        assert.deepEqual(calls, ['vols']);
        assert.deepEqual(ops, [], 'restic was run against a source it cannot resolve');
        assert.equal(c.failure, null);
        assert.equal(c.run, null);
        assert.equal(c.working, false);
    });
});

test('a unit that refuses to start is reported, not swallowed', async () => {
    const job = {
        id: 'vms', repo: 'nas',
        sources: [{ id: 'main', kind: 'libvirt', domains: ['web01'] }],
        retention: { daily: 7 }, schedule: { calendar: 'daily' }
    };
    const world = baseWorld({
        jobs: { vms: job },
        repos: { nas: sampleRepo() },
        schedule: { runNow: async () => { throw hangarError('GENERIC', 'Unit not found.'); } }
    });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        await c.startBackup(job);
        assert.ok(c.failure);
        assert.match(c.failure.message, /Unit not found/);
        assert.equal(c.working, false);
    });
});

test('the job list describes a container job as a container job', () => {
    const c = Jobs.hangarJobsUi();
    const text = c.describeSources({
        id: 'vols',
        job: { id: 'vols', sources: [{ id: 'main', kind: 'container', volumes: ['pgdata'], user: 'appuser' }] }
    });
    assert.match(text, /podman volume/);
    assert.doesNotMatch(text, /no paths/);
});

// --- the editor component -----------------------------------------------

test('the editor constructs and answers every new question with no DOM', () => {
    const e = Jobs.hangarJobEdit();
    assert.doesNotThrow(() => e.kinds());
    assert.doesNotThrow(() => e.kindDescription());
    assert.doesNotThrow(() => e.runtimes());
    assert.doesNotThrow(() => e.consistencies());
    assert.doesNotThrow(() => e.uris());
    assert.doesNotThrow(() => e.quiesces());
    assert.doesNotThrow(() => e.warnings());
    assert.doesNotThrow(() => e.sourceText());
    assert.doesNotThrow(() => e.volumeChoices());
    assert.doesNotThrow(() => e.containerChoices());
    assert.doesNotThrow(() => e.domainChoices());
    assert.equal(e.discoveryState('volumes'), 'idle');
    assert.equal(e.discoveryMessage('domains'), '');
});

test('the editor surfaces the mode description at the moment of choosing', () => {
    const e = Jobs.hangarJobEdit();
    e.form = containerForm({ container: { consistency: 'none' } });
    assert.equal(e.consistencyText(), Container.CONSISTENCY.none.description);
    assert.equal(e.consistencyRisk(), 'high');
    e.form.container.consistency = 'stop';
    assert.equal(e.consistencyRisk(), 'low');

    e.form = libvirtForm({ libvirt: { quiesce: 'agent' } });
    assert.equal(e.quiesceText(), Libvirt.QUIESCE.filter((m) => m.id === 'agent')[0].description);
});

test('the editor shows the warning list the kind produced, unedited', () => {
    const e = Jobs.hangarJobEdit();
    e.form = containerForm({ container: { consistency: 'none', containers: ['mongo-1'], user: 'appuser' } });
    assert.equal(e.hasWarnings(), true);
    assert.deepEqual(e.warnings(), riskWarnings(e.form));
    assert.deepEqual(messages(e.warnings()),
        messages(Sources.validate(formSource(e.form)).filter((p) => p.code === 'live-database')));
});

test('discovery that fails offers the manual list and says why', async () => {
    // qemu:///system times out on this host, so this is the normal case, not the
    // exotic one: a failed probe must never leave the user with no way to type
    // the name in.
    const e = Jobs.hangarJobEdit();
    e.form = libvirtForm();
    await withStubs({
        HangarSourcesLibvirt: Object.assign({}, Libvirt, {
            listDomains: async () => { throw hangarError('NETWORK', 'The hypervisor did not answer.'); }
        })
    }, async () => {
        await e.discoverDomains();
    });
    assert.equal(e.discoveryState('domains'), 'failed');
    assert.match(e.discoveryMessage('domains'), /did not answer/);
    assert.equal(e.manual.domains, true);
    assert.deepEqual(e.discovered.domains, []);
});

test('discovery that answers nothing also offers the manual list', async () => {
    const e = Jobs.hangarJobEdit();
    e.form = libvirtForm();
    await withStubs({
        HangarSourcesLibvirt: Object.assign({}, Libvirt, { listDomains: async () => [] })
    }, async () => {
        await e.discoverDomains();
    });
    assert.equal(e.discoveryState('domains'), 'empty');
    assert.equal(e.manual.domains, true);
});

test('discovery that answers fills the choice list and keeps the selection', async () => {
    const e = Jobs.hangarJobEdit();
    e.form = libvirtForm({ libvirt: { domains: ['retired'] } });
    await withStubs({
        HangarSourcesLibvirt: Object.assign({}, Libvirt, { listDomains: async () => ['web01', 'db01'] })
    }, async () => {
        await e.discoverDomains();
    });
    assert.equal(e.discoveryState('domains'), 'ok');
    assert.equal(e.manual.domains, false);
    assert.deepEqual(e.domainChoices(),
        [{ name: 'web01', discovered: true }, { name: 'db01', discovered: true },
            { name: 'retired', discovered: false }]);
});

test('a manual list the user asked for is never taken away again', async () => {
    const e = Jobs.hangarJobEdit();
    e.form = libvirtForm();
    e.useManual('domains');
    await withStubs({
        HangarSourcesLibvirt: Object.assign({}, Libvirt, { listDomains: async () => ['web01'] })
    }, async () => {
        await e.discoverDomains();
    });
    assert.equal(e.manual.domains, true, 'a name the user was typing would have vanished');
});

test('container discovery probes volumes and containers independently', async () => {
    // One list failing must not take the other down with it: on a host where
    // `volume ls` works and `ps` does not, the volumes are still selectable.
    const e = Jobs.hangarJobEdit();
    e.form = containerForm();
    await withStubs({
        HangarSourcesContainer: Object.assign({}, Container, {
            listVolumes: async () => ['pgdata', 'uploads'],
            containerListArgv: () => { throw hangarError('GENERIC', 'no runtime'); }
        })
    }, async () => {
        await e.discoverContainerNames();
    });
    assert.equal(e.discoveryState('volumes'), 'ok');
    assert.deepEqual(e.discovered.volumes, ['pgdata', 'uploads']);
    assert.equal(e.discoveryState('containers'), 'failed');
    assert.equal(e.manual.containers, true);
    assert.equal(e.manual.volumes, false);
});

test('a discovery helper that throws synchronously is caught like a rejection', async () => {
    const e = Jobs.hangarJobEdit();
    e.form = containerForm();
    await withStubs({
        HangarSourcesContainer: Object.assign({}, Container, {
            listVolumes: () => { throw hangarError('GENERIC', 'bad runtime'); },
            containerListArgv: () => { throw hangarError('GENERIC', 'bad runtime'); }
        })
    }, async () => {
        await e.discoverContainerNames();
    });
    assert.equal(e.discoveryState('volumes'), 'failed');
    assert.match(e.discoveryMessage('volumes'), /bad runtime/);
});

test('a rejection with no message still says something', async () => {
    const e = Jobs.hangarJobEdit();
    e.form = libvirtForm();
    await withStubs({
        HangarSourcesLibvirt: Object.assign({}, Libvirt, {
            // eslint-disable-next-line prefer-promise-reject-errors
            listDomains: () => Promise.reject(null)
        })
    }, async () => {
        await e.discoverDomains();
    });
    assert.equal(e.discoveryState('domains'), 'failed');
    assert.ok(e.discoveryMessage('domains').length > 0);
});

test('discovery only asks the host about the kind actually being edited', async () => {
    const asked = [];
    const e = Jobs.hangarJobEdit();
    e.form = emptyForm();
    await withStubs({
        HangarSourcesContainer: Object.assign({}, Container, {
            listVolumes: async () => { asked.push('volumes'); return []; }
        }),
        HangarSourcesLibvirt: Object.assign({}, Libvirt, {
            listDomains: async () => { asked.push('domains'); return []; }
        })
    }, async () => {
        await e.discover();
        e.form.sourceKind = 'libvirt';
        await e.discover();
    });
    assert.deepEqual(asked, ['domains']);
});

test('switching kind re-probes and revalidates without a DOM', async () => {
    const e = Jobs.hangarJobEdit();
    e.form = emptyForm();
    e.form.sourceKind = 'libvirt';
    await withStubs({
        HangarSourcesLibvirt: Object.assign({}, Libvirt, { listDomains: async () => ['web01'] })
    }, async () => {
        assert.doesNotThrow(() => e.onKindChange());
        assert.doesNotThrow(() => e.onUriChange());
        assert.doesNotThrow(() => e.onRuntimeChange());
        // Let the probes settle so the assertions below are not racing them.
        await e.discoverDomains();
    });
    assert.deepEqual(e.discovered.domains, ['web01']);
    assert.ok(Array.isArray(e.problems));
});

// --- the markup ----------------------------------------------------------

test('the editor offers the source-kind chooser, driven by the registry', () => {
    assert.match(editHtml, /x-model="form\.sourceKind"/);
    assert.match(editHtml, /x-for="k in kinds\(\)"/);
    ['isKind(\'filesystem\')', 'isKind(\'container\')', 'isKind(\'libvirt\')'].forEach((probe) => {
        assert.ok(editHtml.includes(probe), 'no block for ' + probe);
    });
});

test('the editor renders every option list from its kind\'s table', () => {
    ['x-for="rt in runtimes()"', 'x-for="m in consistencies()"',
        'x-for="u in uris()"', 'x-for="m in quiesces()"'].forEach((probe) => {
        assert.ok(editHtml.includes(probe), 'missing ' + probe);
    });
    // No option is spelled out in the markup: a mode added to core/ must appear
    // here without an edit, and one removed must disappear.
    Container.RUNTIMES.concat(Container.CONSISTENCY_IDS)
        .concat(Libvirt.QUIESCE.map((m) => m.id))
        .concat(Libvirt.URIS.map((u) => u.id))
        .forEach((id) => {
            assert.ok(!editHtml.includes('<option value="' + id + '"'),
                'the markup hardcodes the option "' + id + '"');
        });
});

test('the warnings block renders what validate() returned, not its own prose', () => {
    assert.match(editHtml, /x-for="w in warnings\(\)"/);
    assert.match(editHtml, /x-text="w\.message"/);
    assert.match(editHtml, /warnings, not errors/);
    // The consistency and quiesce descriptions are the kinds' too.
    assert.match(editHtml, /x-text="consistencyText\(\)"/);
    assert.match(editHtml, /x-text="quiesceText\(\)"/);
});

test('the manual fallback exists for all three discovered lists', () => {
    ['form.container.volumesText', 'form.container.containersText', 'form.libvirt.domainsText']
        .forEach((model) => assert.ok(editHtml.includes(model), 'no manual entry for ' + model));
    ['useManual(\'volumes\')', 'useManual(\'containers\')', 'useManual(\'domains\')']
        .forEach((call) => assert.ok(editHtml.includes(call), 'no way to reach ' + call));
});

test('the domain XML toggle is present and defaults on', () => {
    assert.match(editHtml, /id="hangar-job-include-xml"/);
    assert.match(editHtml, /x-model="form\.libvirt\.includeXml"/);
    assert.equal(emptyLibvirtFields().includeXml, true);
});

test('a checkbox in a discovered list is labelled by the same id it declares', () => {
    // The a11y sweep above matches static ids; these are bound, and a typo would
    // leave a checkbox nobody using a screen reader can name.
    const bound = [...editHtml.matchAll(/:id="([^"]+)"/g)].map((m) => m[1]);
    const boundFor = [...editHtml.matchAll(/:for="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(bound.length >= 3);
    bound.forEach((id) => assert.ok(boundFor.indexOf(id) >= 0, 'nothing labels ' + id));
});

// ========================================================================
// v2 — adversarial hardening
//
// Three questions, in the order they matter:
//
//   1. Can anything the user types reach a command line as more than one
//      argument? Volume, container and domain names and the dump command all
//      end up in argv, and this screen is where they are typed.
//   2. Does a warning about a backup that may not restore actually reach the
//      user, or is it quietly dropped between validate() and the DOM?
//   3. Can any pure function on the render path throw? Alpine calls them on
//      every re-render, so one untyped exception blanks the editor — including
//      the message that would have explained it.
// ========================================================================

// Everything a shell would treat as more than one word, plus the two that
// truncate rather than split (NUL, newline) and the one that turns a name into
// a flag (a leading dash). A name that survives any of these as a single argv
// element is safe; a name that is refused is safe too. A name that becomes two
// elements is the bug this list exists to find.
const HOSTILE_NAMES = [
    'a b', 'a\tb', 'a;rm -rf /', 'a|b', 'a&b', 'a>b', 'a<b',
    '$(id)', '`id`', '${HOME}', 'a\nb', 'a\rb', 'a\u0000b',
    '-rf', '--all', '--latest', '-v', '../../etc/passwd', 'a/b',
    'a\'b', 'a"b', 'a\\b', 'a*b', 'a?b', 'a[b]b', 'a!b', 'a~b',
    'ünïcødé', '\u{1f4a5}', '\u202e', ' leading', 'trailing ', ''
];

// A vector is only safe if every element is a string: cockpit.spawn stringifies
// whatever it is given, so a null would reach execve as the literal "null" and
// land wherever a name was meant to be.
function assertArgv(argv, where) {
    assert.ok(Array.isArray(argv), where + ' is not an argument vector');
    argv.forEach((a, i) => {
        assert.equal(typeof a, 'string', where + '[' + i + '] is not a string');
    });
}

// --- shell safety: names typed here reach argv as one element, or not at all --

// The form trims what was typed and drops what trims to nothing — but it must
// never turn one name into two, whatever is in it. Everything downstream is
// checked against what the form actually produced, not against the raw input.
function oneName(list, name) {
    assert.ok(list.length <= 1,
        'the form split ' + JSON.stringify(name) + ' into ' + JSON.stringify(list));
    return list.length ? list[0] : null;
}

test('no volume name can add an argument to a runtime command line', () => {
    HOSTILE_NAMES.forEach((raw) => {
        const source = formSource(containerForm({ container: { volumes: [raw] } }));
        const name = oneName(source.volumes, raw);
        if (name === null) return;

        let argv = null;
        try {
            argv = Container.volumeInspectArgv(source.runtime, source.user, name);
        } catch (e) {
            // The only acceptable alternative to carrying it safely.
            assert.ok(Errors.isHangarError(e), JSON.stringify(raw) + ' threw untyped');
            assert.equal(e.kind, 'GENERIC');
            return;
        }
        assertArgv(argv, 'volumeInspectArgv(' + JSON.stringify(raw) + ')');
        // One element, in the position the builder put it — never split, never
        // an extra flag, never absorbed into a neighbour.
        assert.equal(argv.filter((a) => a === name).length, 1);
        assert.equal(argv[argv.length - 1], name);
        assert.deepEqual(argv.slice(0, -1), ['runuser', '-u', 'appuser', '--',
            'podman', 'volume', 'inspect']);
    });
});

test('no container name can add an argument to a pause, stop or exec', () => {
    ['pause', 'stop', 'command'].forEach((mode) => {
        HOSTILE_NAMES.forEach((raw) => {
            const source = formSource(containerForm({
                container: { consistency: mode, containers: [raw], command: 'pg_dumpall > /b/all.sql' }
            }));
            const name = oneName(source.containers, raw);
            if (name === null) return;
            let steps;
            try {
                steps = Container.preCommands(source).concat(Container.postCommands(source));
            } catch (e) {
                assert.ok(Errors.isHangarError(e),
                    mode + ' + ' + JSON.stringify(raw) + ' threw untyped');
                return;
            }
            steps.forEach((argv) => {
                assertArgv(argv, mode + ' step');
                // `podman stop --all` stops every container on the host and
                // `exec --latest` runs in whichever one started last: a name that
                // became its own flag is the whole failure mode.
                assert.equal(argv.filter((a) => a === name).length, 1, 'name lost or duplicated');
                assert.ok(argv.indexOf('--all') < 0 && argv.indexOf('--latest') < 0,
                    JSON.stringify(raw) + ' became a flag');
            });
        });
    });
});

test('no domain name can add an argument to a virsh command line', () => {
    ['agent', 'shutdown'].forEach((quiesce) => {
        HOSTILE_NAMES.forEach((raw) => {
            const source = formSource(libvirtForm({ libvirt: { quiesce: quiesce, domains: [raw] } }));
            const name = oneName(source.domains, raw);
            if (name === null) return;
            let steps;
            try {
                steps = Libvirt.preCommands(source).concat(Libvirt.postCommands(source));
            } catch (e) {
                assert.ok(Errors.isHangarError(e), JSON.stringify(raw) + ' threw untyped');
                return;
            }
            steps.forEach((argv) => {
                assertArgv(argv, 'virsh step');
                assert.equal(argv.filter((a) => a === name).length, 1);
                assert.equal(argv[argv.length - 1], name, 'the domain is not the last argument');
                assert.ok(argv.indexOf('--all') < 0, JSON.stringify(raw) + ' became --all');
            });
        });
    });
});

test('a virsh command is never broadened by an argument it could not build', () => {
    // virshArgv drops a non-string tail element rather than stringifying it. That
    // is only safe because no subcommand hangar uses has a domain-less form that
    // acts on everything — unlike `podman stop --all`. Pin it, because a future
    // subcommand with an --all-by-default shape would silently become one.
    [Libvirt.shutdownArgv, Libvirt.startArgv, Libvirt.freezeArgv, Libvirt.thawArgv,
        Libvirt.dumpXmlArgv].forEach((build) => {
        [null, undefined, 42, {}, []].forEach((bad) => {
            const argv = build('qemu:///system', bad);
            assertArgv(argv, 'virsh argv');
            assert.deepEqual(argv.slice(0, 3), ['virsh', '-c', 'qemu:///system']);
            assert.equal(argv.length, 4, 'a dropped domain left a command with extra arguments');
        });
    });
});

test('a hostile connection URI stays one argument and never becomes a flag', () => {
    ['qemu:///system; rm -rf /', 'qemu+ssh://h/s $(id)', 'a\nb', 'a|b', '--version'].forEach((uri) => {
        const argv = Libvirt.listDomainsArgv(uri);
        assertArgv(argv, 'listDomainsArgv');
        assert.deepEqual(argv, ['virsh', '-c', uri, 'list', '--all', '--name']);
        // -c consumes the next element whatever it looks like, so even "--version"
        // is read as this option's value rather than as a second option.
        assert.equal(argv[2], uri);
    });
});

test('the dump command travels as one argv element, however it is written', () => {
    ['pg_dump db | gzip > /b/db.gz', 'a; rm -rf /', '$(id)', 'echo "x"; echo \'y\'',
        'a\nb', 'sh -c "nested"'].forEach((command) => {
        const source = formSource(containerForm({
            container: { consistency: 'command', containers: ['db'], command: command }
        }));
        const pre = Container.preCommands(source);
        assert.equal(pre.length, 1);
        assertArgv(pre[0], 'exec step');
        // `sh -c <script>` — the shell is deliberate, and the script is one word.
        assert.deepEqual(pre[0], ['runuser', '-u', 'appuser', '--',
            'podman', 'exec', 'db', 'sh', '-c', command]);
    });
});

test('a hostile owning user is refused with a typed error, never wrapped', () => {
    ['a b', 'a;id', '$(id)', 'a\nb', '-u', 'root;rm', 'a/b', '../root'].forEach((user) => {
        assert.throws(() => Container.volumeListArgv('podman', user),
            (e) => Errors.isHangarError(e) && e.kind === 'GENERIC', JSON.stringify(user));
        assert.throws(() => Container.containerListArgv('podman', user),
            (e) => Errors.isHangarError(e), JSON.stringify(user));
    });
});

test('a hostile user typed into the editor fails discovery instead of running', async () => {
    // The editor asks the host as soon as the field changes, so this is the first
    // place a bad user name could reach a command line.
    const e = Jobs.hangarJobEdit();
    e.form = containerForm({ container: { user: 'root; rm -rf /' } });
    await e.discoverContainerNames();
    assert.equal(e.discoveryState('volumes'), 'failed');
    assert.equal(e.discoveryState('containers'), 'failed');
    assert.match(e.discoveryMessage('volumes'), /not a valid user name/);
    // And it is a problem the user can see next to the field they typed it in.
    assert.ok(validateForm(e.form, []).some((p) => p.field === 'user' && p.severity === 'error'));
});

test('every name the form accepts is a name the runtime would also accept', () => {
    // The two rules have to agree: a name the editor saves but the runtime would
    // reject is a job that validates in the UI and dies in the unit at 02:00.
    HOSTILE_NAMES.concat(['ok-name', 'ok_name.1', 'A0']).forEach((name) => {
        const problems = Container.validate({ id: 'x', volumes: [name], user: 'appuser' });
        const refused = problems.some((p) => p.severity === 'error' &&
            (p.code === 'volume-unsafe' || p.code === 'volume-empty' || p.code === 'no-volumes'));
        assert.equal(refused, !Container.isSafeName(name),
            JSON.stringify(name) + ': validate() and isSafeName() disagree');
    });
});

test('a NUL byte in a name or a dump command is reported, never truncated', () => {
    // execve stops at the first NUL, so the argument the runtime receives is not
    // the one the journal printed. Silence here is the dangerous outcome.
    const cases = [
        ['volumes', containerForm({ container: { volumes: ['pg\u0000data'] } }), 'volumes'],
        ['containers', containerForm({
            container: { consistency: 'stop', containers: ['db\u0000x'] }
        }), 'containers'],
        ['domains', libvirtForm({ libvirt: { domains: ['web' + '\u0000' + '01'] } }), 'domains']
    ];
    cases.forEach((c) => {
        const hit = validateForm(c[1], []).filter((p) => p.field === c[2] && p.severity === 'error');
        assert.ok(hit.length, c[0] + ': a NUL byte was accepted');
    });
    // The dump command too — the one free-text field that reaches argv.
    const cmd = validateForm(containerForm({
        container: { consistency: 'command', containers: ['db'], command: 'pg_dump\u0000; rm -rf /' }
    }), []);
    assert.ok(cmd.some((p) => p.field === 'command' && p.severity === 'error'),
        'a NUL byte in the dump command was accepted');
});

// --- the warnings that decide whether a backup restores reach the user -------

test('two database containers raise two warnings, and both can be rendered', () => {
    // The bug this pins: warnings were keyed by their code, and Alpine's x-for
    // keeps only the first row of any repeated key — so a user with a postgres
    // AND a mongo container was warned about one and told nothing about the other.
    const f = containerForm({
        container: { consistency: 'none', containers: ['app-postgres-1', 'mongo_primary'] }
    });
    const warnings = riskWarnings(f).filter((w) => w.code === 'live-database');
    assert.equal(warnings.length, 2);
    assert.match(warnings[0].message, /app-postgres-1/);
    assert.match(warnings[1].message, /mongo_primary/);

    const keys = riskWarnings(f).map((w) => w.key);
    assert.equal(new Set(keys).size, keys.length, 'two warnings share an x-for key');
    keys.forEach((k) => assert.equal(typeof k, 'string'));
});

test('the warnings list is keyed by something unique, in the markup as well', () => {
    assert.match(editHtml, /x-for="w in warnings\(\)" :key="w\.key"/);
});

test('a live copy of a database warns whatever else is wrong with the form', () => {
    // A warning suppressed because some unrelated field is also invalid is a
    // warning the user never sees: they fix the error, save, and are never told.
    const broken = containerForm({
        container: { consistency: 'none', containers: ['postgres'], volumes: [] }
    });
    broken.id = '';
    broken.repo = '';
    assert.ok(riskWarnings(broken).some((w) => w.code === 'live-database'));
    const problems = validateForm(broken, []);
    assert.ok(hasErrors(problems), 'the broken form somehow validated');
    assert.ok(problems.some((p) => p.code === 'source-live-database' && p.severity === 'warning'),
        'the database warning was lost among the errors');
});

test('the default consistency mode is the one that warns, not a silent one', () => {
    // A user who never opens the picker gets 'none'. If that mode stopped warning,
    // the most common configuration would be the least safe one, silently.
    const f = containerForm({ container: { containers: ['prod-mysql'] } });
    assert.equal(formSource(f).consistency, 'none');
    assert.ok(riskWarnings(f).some((w) => w.code === 'live-database'));
});

test('a warning survives the whole trip from validate() to what the editor renders', () => {
    const e = Jobs.hangarJobEdit();
    e.form = containerForm({ container: { consistency: 'none', containers: ['redis-cache', 'kafka-1'] } });
    assert.equal(e.hasWarnings(), true);
    const rendered = e.warnings();
    assert.equal(rendered.length, 2);
    // Verbatim: the wording belongs to the kind, and this screen must not soften it.
    const fromKind = Sources.validate(formSource(e.form))
        .filter((p) => p.code === 'live-database').map((p) => p.message);
    assert.deepEqual(rendered.map((w) => w.message), fromKind);
    // Warnings never block the save. Being unable to save would push the user
    // back to a mode that produces no warning rather than to a safer one.
    assert.equal(e.canSave(), true);
});

test('every libvirt quiesce mode is renderable and none is silently keyless', () => {
    ['none', 'agent', 'shutdown'].forEach((quiesce) => {
        [true, false].forEach((includeXml) => {
            const w = riskWarnings(libvirtForm({
                libvirt: { quiesce: quiesce, includeXml: includeXml }
            }));
            const keys = w.map((x) => x.key);
            assert.equal(new Set(keys).size, keys.length, quiesce + '/' + includeXml);
            w.forEach((x) => {
                assert.ok(x.message.length > 0, 'an empty warning renders as a blank bullet');
                assert.ok(Jobs.RISK_CODES.indexOf(x.code) >= 0);
            });
        });
    });
});

// --- a mixed job is not backed up by halves ---------------------------------

test('a job mixing files with volumes is handed to its unit, not run by halves', () => {
    // primaryKind() answers "which form does the editor open", and it says
    // 'filesystem' whenever there is one. Reusing that to decide where the run
    // happens meant a mixed job ran in the browser against the file paths alone —
    // a snapshot with none of the volumes in it, reported as a success.
    const mixed = {
        id: 'both', repo: 'nas',
        sources: [
            { id: 'files', kind: 'filesystem', paths: ['/etc'] },
            { id: 'vols', kind: 'container', volumes: ['pgdata'] }
        ]
    };
    assert.equal(runsInBrowser(mixed), false);
    assert.equal(primaryKind(mixed), 'filesystem', 'the editor should still open on the file form');

    // And the reverse ordering, in case the answer depended on which came first.
    assert.equal(runsInBrowser({ sources: [mixed.sources[1], mixed.sources[0]] }), false);
    assert.equal(runsInBrowser({
        sources: [{ kind: 'filesystem', paths: ['/etc'] }, { kind: 'libvirt', domains: ['web01'] }]
    }), false);

    // Unchanged for everything that was already right.
    assert.equal(runsInBrowser(sampleJob()), true);
    assert.equal(runsInBrowser({}), true);
    assert.equal(runsInBrowser({ sources: [{ paths: ['/etc'] }] }), true, 'kind-less means filesystem');
});

test('a mixed job really does reach systemd rather than restic', async () => {
    const ops = [];
    const units = [];
    const job = {
        id: 'both', name: 'Both', repo: 'nas', enabled: true,
        sources: [
            { id: 'files', kind: 'filesystem', paths: ['/etc'] },
            { id: 'vols', kind: 'container', volumes: ['pgdata'], user: 'appuser' }
        ],
        retention: { daily: 7 }, schedule: { calendar: 'daily' }
    };
    const world = baseWorld({
        jobs: { both: job },
        repos: { nas: sampleRepo() },
        run: async (op) => { ops.push(op); return { status: 'ok', errors: [] }; },
        schedule: { runNow: async (id) => { units.push(id); } }
    });
    await withStubs(world, async () => {
        const c = Jobs.hangarJobsUi();
        await c.reload();
        await c.startBackup(job);
        assert.deepEqual(units, ['both']);
        assert.deepEqual(ops, [], 'restic ran against half the job');
        assert.equal(c.failure, null);
    });
});

// --- nothing on the render path throws --------------------------------------

// Values chosen for what they break rather than for looking odd: a Symbol and a
// throwing toString() defeat implicit concatenation, a null-prototype object has
// no toString at all, and the four property names answer truthily on any plain
// object used as a lookup table.
const HOSTILE_VALUES = [
    undefined, null, '', 0, NaN, Infinity, -1, true, false, [], {}, [[]], [null],
    Object.create(null), Symbol('s'), () => {}, new Date(NaN),
    { toString() { throw new Error('boom'); } },
    '__proto__', 'constructor', 'prototype', 'toString',
    ' ', 'a\nb', 'a\u0000b', '../../etc/passwd', '$(id)', '\u{1f4a5}', '\u202e'
];

test('no pure function on the render path throws, for any value at all', () => {
    const under = [
        ['formSource', (v) => formSource(v)],
        ['formStateToJob', (v) => formStateToJob(v)],
        ['jobToFormState', (v) => jobToFormState(v)],
        ['validateForm', (v) => validateForm(v, v)],
        ['riskWarnings', (v) => riskWarnings(v)],
        ['sourceWarnings', (v) => sourceWarnings(v)],
        ['sourceDescription', (v) => sourceDescription(v)],
        ['primaryKind', (v) => primaryKind(v)],
        ['primarySource', (v) => primarySource(v)],
        ['runsInBrowser', (v) => runsInBrowser(v)],
        ['nameList', (v) => nameList(v, v)],
        ['checkboxList', (v) => checkboxList(v, v)],
        ['mergeFilesystemSources', (v) => mergeFilesystemSources(v)],
        ['fieldForSourceProblem', (v) => fieldForSourceProblem(v)],
        ['consistencyInfo', (v) => consistencyInfo(v)],
        ['quiesceInfo', (v) => quiesceInfo(v)],
        ['sourceKindLabel', (v) => sourceKindLabel(v)],
        ['lastResultLabel', (v) => lastResultLabel(v)],
        ['remediationLabel', (v) => remediationLabel(v)],
        ['formatBytes', (v) => formatBytes(v)],
        ['progressPercent', (v) => progressPercent(v)],
        ['progressLabel', (v) => progressLabel(v)],
        ['unreadableFiles', (v) => unreadableFiles(v)],
        ['hasErrors', (v) => hasErrors(v)],
        ['problemsFor', (v) => problemsFor(v, v)]
    ];
    under.forEach((entry) => {
        HOSTILE_VALUES.forEach((v) => {
            assert.doesNotThrow(() => entry[1](v), entry[0] + ' threw on a ' + typeof v);
        });
    });
});

test('a hostile value in every per-kind field is survivable', () => {
    const exercise = (kind, field) => {
        HOSTILE_VALUES.forEach((v) => {
            const f = emptyForm();
            f.sourceKind = kind;
            f[kind][field] = v;
            const where = kind + '.' + field;
            assert.doesNotThrow(() => validateForm(f, []), where);
            assert.doesNotThrow(() => riskWarnings(f), where);
            assert.doesNotThrow(() => sourceDescription(f), where);
            assert.doesNotThrow(() => formStateToJob(f), where);
        });
    };
    ['runtime', 'user', 'volumes', 'volumesText', 'containers', 'containersText',
        'consistency', 'command'].forEach((field) => exercise('container', field));
    ['uri', 'domains', 'domainsText', 'quiesce', 'includeXml']
        .forEach((field) => exercise('libvirt', field));
});

test('validateForm survives a source kind whose validate() misbehaves', () => {
    // The v2 seam means the kind doing the validating may be a third party's, and
    // validateForm is called on every re-render by canSave/invalid/messageFor.
    // A kind that throws must cost its own messages, not the whole editor.
    const S = Jobs.ensureSourceKinds();
    const saved = S.KINDS.container;
    try {
        S.KINDS.container = Object.assign({}, saved, {
            validate: () => { throw new Error('a third party exploded'); }
        });
        const f = containerForm();
        assert.doesNotThrow(() => validateForm(f, []));
        assert.doesNotThrow(() => riskWarnings(f));
        assert.doesNotThrow(() => Jobs.hangarJobEdit().canSave());

        // And one that answers with holes and non-objects instead of problems.
        S.KINDS.container = Object.assign({}, saved, {
            validate: () => [null, undefined, 'not a problem', 42,
                { severity: 'error', code: 'real', message: 'a real one' }]
        });
        const problems = validateForm(f, []);
        assert.ok(problems.some((p) => p.code === 'source-real'));
        problems.forEach((p) => {
            assert.equal(typeof p.code, 'string');
            assert.equal(typeof p.field, 'string');
            assert.equal(typeof p.message, 'string');
        });
    } finally {
        S.KINDS.container = saved;
    }
});

test('a form that cannot be saved is never a form that cannot be shown', () => {
    // Every hostile form above still has to render: the editor is the only place
    // the user could fix it from.
    const forms = [
        containerForm({ container: { volumes: ['a b'], containers: ['-rf'], consistency: 'stop' } }),
        containerForm({ container: { consistency: 'nonsense' } }),
        containerForm({ container: { runtime: 'kubernetes' } }),
        libvirtForm({ libvirt: { domains: ['a;b'], quiesce: 'freeze-everything' } }),
        libvirtForm({ libvirt: { uri: '' } })
    ];
    forms.forEach((f) => {
        const e = Jobs.hangarJobEdit();
        e.form = f;
        assert.doesNotThrow(() => e.revalidate());
        assert.doesNotThrow(() => e.warnings());
        assert.doesNotThrow(() => e.sourceText());
        assert.doesNotThrow(() => e.consistencyText());
        assert.doesNotThrow(() => e.quiesceText());
        assert.doesNotThrow(() => e.volumeChoices());
        assert.doesNotThrow(() => e.domainChoices());
        ['volumes', 'containers', 'domains', 'consistency', 'quiesce', 'user', 'runtime', 'uri', 'command']
            .forEach((field) => {
                assert.doesNotThrow(() => e.messageFor(field), field);
                assert.doesNotThrow(() => e.invalid(field), field);
            });
    });
});

test('a job file holding garbage opens the editor rather than blanking it', () => {
    // /etc/hangar is root-editable by hand, so a source can hold anything at all.
    const jobs = [
        { id: 'j', sources: [{ kind: 'container', volumes: 'not-a-list' }] },
        { id: 'j', sources: [{ kind: 'container', volumes: [null, 7, {}] }] },
        { id: 'j', sources: [{ kind: 'libvirt', domains: { nope: true } }] },
        { id: 'j', sources: [{ kind: 'libvirt', quiesce: [], includeXml: 'yes' }] },
        { id: 'j', sources: [{ kind: 'container' }, { kind: 'container' }] },
        { id: 'j', sources: { kind: 'container' } }
    ];
    jobs.forEach((job) => {
        let form;
        assert.doesNotThrow(() => { form = jobToFormState(job); }, JSON.stringify(job));
        assert.doesNotThrow(() => validateForm(form, []));
        assert.doesNotThrow(() => riskWarnings(form));
        // A round trip must not invent sources or lose the ones it could not show.
        const back = formStateToJob(form);
        assert.ok(Array.isArray(back.sources));
        back.sources.forEach((s) => assert.equal(typeof s, 'object'));
    });
});

test('a second unshowable source survives an edit rather than being dropped', () => {
    // Dropping it would silently stop backing something up, which is the failure
    // this whole screen exists to prevent.
    const job = {
        id: 'j', repo: 'nas',
        sources: [
            { id: 'a', kind: 'container', volumes: ['one'], user: 'appuser' },
            { id: 'b', kind: 'container', volumes: ['two'], user: 'other' },
            { id: 'c', kind: 'libvirt', domains: ['web01'] }
        ],
        retention: { daily: 7 }, schedule: { calendar: 'daily' }
    };
    const back = formStateToJob(jobToFormState(job));
    assert.equal(back.sources.length, 3);
    assert.deepEqual(back.sources.slice(1), [job.sources[1], job.sources[2]]);
    assert.equal(back.sources[0].user, 'appuser');
});

// --- a run is a run, whoever started it -----------------------------------
//
// Found live: a backup started with `systemctl start` was invisible here — the
// row said "Never run" while the Overview, reading the same systemd state, said
// "Running now". This screen only knew about runs it had started itself.

test('a job whose service is active reads as running, even if this tab did not start it', () => {
    const c = Jobs.hangarJobsUi();
    const row = { id: 'nightly', job: { id: 'nightly' },
        unit: { service: { active: true }, timer: { active: true } } };
    assert.equal(c.isRunning(row), true);
    assert.equal(c.dotClass(row), 'running');
});

test('a run this tab started still counts, before systemd catches up', () => {
    // runNow() sets `run` immediately; the unit takes a moment to go active.
    const c = Jobs.hangarJobsUi();
    c.run = { jobId: 'nightly' };
    assert.equal(c.isRunning({ id: 'nightly', job: { id: 'nightly' } }), true);
    assert.equal(c.isRunning({ id: 'other', job: { id: 'other' } }), false);
});

test('an idle job is not running, however incomplete its unit state', () => {
    const c = Jobs.hangarJobsUi();
    for (const unit of [undefined, null, {}, { service: null }, { service: { active: false } }])
        assert.equal(c.isRunning({ id: 'n', job: { id: 'n' }, unit }), false, JSON.stringify(unit));
});
