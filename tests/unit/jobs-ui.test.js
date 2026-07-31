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
    assert.match(Jobs.SCREEN, /@click="runNow\(row\)" :disabled="working \|\| !!run \|\| row\.unreadable"/);
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
