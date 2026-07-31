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
