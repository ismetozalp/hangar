// tests/unit/settings-ui.test.js — the Settings screen.
//
// Two things are worth testing here and they are both exact-text things: the
// validation boundaries (what counts as an absurd idle timeout has to be a
// number, not a feeling) and the diagnostics report, which is asserted verbatim
// because it is pasted into bug reports and its shape is the whole product.
//
// Everything runs against the real core modules — no mock of config.mergeGlobal,
// no hand-built probe shapes where a real one exists — so a change in core shows
// up here instead of drifting apart quietly.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const UI = require('../../js/features/settings-ui.js');
const Config = require('../../js/core/config.js');
const Errors = require('../../js/core/errors.js');

const DEFAULTS = Config.DEFAULT_GLOBAL;

// A probeAll-shaped result, exactly as core/provision.js emits one.
function probeRow(tool, over) {
    return Object.assign({
        tool: tool, binary: tool, optional: tool !== 'restic',
        present: false, raw: '', version: null, ok: false
    }, over || {});
}

const PROBES = [
    probeRow('restic', {
        present: true, ok: true, version: { major: 0, minor: 19, patch: 1 },
        raw: 'restic 0.19.1 compiled with go1.24.1'
    }),
    probeRow('rclone'),
    probeRow('fuse3', {
        binary: 'fusermount3', present: true, ok: true,
        version: { major: 3, minor: 16, patch: 2 },
        raw: 'fusermount3 version: 3.16.2'
    })
];

function stubDeps(over) {
    const written = [];
    const deps = Object.assign({
        errors: Errors,
        config: {
            mergeGlobal: Config.mergeGlobal,
            readGlobal: function () { return Promise.resolve(Config.mergeGlobal({})); },
            writeGlobal: function (g) { written.push(g); return Promise.resolve(); }
        },
        provision: {
            detectFamilyLive: function () { return Promise.resolve('rhel'); },
            probeAll: function () { return Promise.resolve(PROBES); }
        },
        readVersion: function () { return Promise.resolve('0.1.0'); },
        now: function () { return '2026-08-01T09:00:00.000Z'; }
    }, over || {});
    deps.written = written;
    return deps;
}

// ---------------------------------------------------------------- module shape

test('module loads with no DOM and no cockpit global', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.cockpit, 'undefined');
    assert.equal(typeof UI.hangarSettingsUi, 'function');
    assert.equal(typeof UI.validateSettings, 'function');
    assert.equal(typeof UI.diagnosticsText, 'function');
    assert.equal(typeof UI.isDirty, 'function');
});

test('the component constructs with no deps, no DOM and no cockpit', () => {
    const c = UI.hangarSettingsUi();
    assert.equal(c.loading, true);
    assert.deepEqual(c.problems(), []);
    assert.equal(c.dirty(), false);
});

test('the editable set matches the defaults core/config.js ships, minus version', () => {
    const editable = Object.keys(DEFAULTS).filter((k) => k !== 'version').sort();
    assert.deepEqual(UI.EDITABLE.slice().sort(), editable);
});

test('mount() is a no-op without a document', () => {
    assert.equal(UI.mount(null), false);
    assert.equal(UI.mount({}), false);
});

test('the template renders into #hangar-settings and never says Time Machine', () => {
    assert.match(UI.TEMPLATE, /x-data="hangarSettingsUi\(\)"/);
    assert.doesNotMatch(UI.TEMPLATE, /time\s*machine/i);
    // Every input the screen owns is labelled, because an unlabelled settings
    // field is unusable with a screen reader.
    ['hangar-mount-root', 'hangar-idle-timeout', 'hangar-notify'].forEach((id) => {
        assert.ok(UI.TEMPLATE.includes('for="' + id + '"'), id + ' has no label');
        assert.ok(UI.TEMPLATE.includes('id="' + id + '"'), id + ' is missing');
    });
});

// -------------------------------------------------------------------- toNumber

test('toNumber accepts numbers and numeric strings alike', () => {
    assert.equal(UI.toNumber(900), 900);
    assert.equal(UI.toNumber('900'), 900);
    assert.equal(UI.toNumber('  900  '), 900);
    assert.equal(UI.toNumber('0900'), 900);
    assert.equal(UI.toNumber('9e2'), 900);
    assert.equal(UI.toNumber(0), 0);
    assert.equal(UI.toNumber(-1), -1);
});

test('toNumber rejects anything that is not a number', () => {
    [null, undefined, '', '   ', 'abc', '12abc', NaN, Infinity, -Infinity,
        true, false, {}, [1, 2]].forEach((v) => {
        assert.equal(UI.toNumber(v), null, JSON.stringify(String(v)) + ' should not be a number');
    });
});

// --------------------------------------------------------------- mountRoot

test('a normal absolute mount root is accepted', () => {
    assert.deepEqual(UI.pathProblems('/run/hangar/mnt'), []);
    assert.deepEqual(UI.pathProblems('/srv/backup mounts/hangar'), []);
    assert.deepEqual(UI.pathProblems('/srv/yedekler/dosyalar'), []);
});

test('surrounding whitespace does not make a path invalid', () => {
    assert.deepEqual(UI.pathProblems('  /run/hangar/mnt \n'), []);
});

test('an empty mount root is a single "required" problem', () => {
    assert.deepEqual(UI.pathProblems(''), ['Mount folder is required.']);
    assert.deepEqual(UI.pathProblems('    '), ['Mount folder is required.']);
    assert.deepEqual(UI.pathProblems(null), ['Mount folder is required.']);
    assert.deepEqual(UI.pathProblems(undefined), ['Mount folder is required.']);
});

test('a relative mount root is rejected', () => {
    ['run/hangar', './mnt', '../mnt', 'C:\\mnt', '~/mnt'].forEach((p) => {
        const problems = UI.pathProblems(p);
        assert.ok(problems.some((m) => /absolute path/.test(m)), p + ' should be rejected');
    });
});

test('the filesystem root itself is rejected as a mount root', () => {
    const problems = UI.pathProblems('/');
    assert.ok(problems.some((m) => /cannot be "\/"/.test(m)));
});

test('a mount root containing ".." is rejected, but ".." inside a name is not', () => {
    assert.ok(UI.pathProblems('/run/../etc').some((m) => /must not contain "\.\."/.test(m)));
    assert.deepEqual(UI.pathProblems('/run/..hidden/mnt'), []);
    assert.deepEqual(UI.pathProblems('/run/mnt..'), []);
});

test('mount root length is bounded at PATH_MAX', () => {
    const ok = '/' + 'a'.repeat(UI.MAX_PATH_LEN - 1);
    const tooLong = '/' + 'a'.repeat(UI.MAX_PATH_LEN);
    assert.equal(ok.length, UI.MAX_PATH_LEN);
    assert.deepEqual(UI.pathProblems(ok), []);
    assert.ok(UI.pathProblems(tooLong).some((m) => /longer than/.test(m)));
});

test('control characters in a mount root are rejected', () => {
    ['/run/han\ngar', '/run/han\u0000gar', '/run/han\tgar', '/run/han\u007fgar'].forEach((p) => {
        assert.ok(UI.pathProblems(p).some((m) => /control characters/.test(m)), p);
    });
});

// ------------------------------------------------------------- idle timeout

test('the idle timeout accepts its documented range, at the boundaries', () => {
    assert.deepEqual(UI.timeoutProblems(UI.NEVER_IDLE), []);         // 0 = never unmount
    assert.deepEqual(UI.timeoutProblems(UI.MIN_IDLE_SEC), []);       // 60
    assert.deepEqual(UI.timeoutProblems(UI.MIN_IDLE_SEC + 1), []);
    assert.deepEqual(UI.timeoutProblems(DEFAULTS.mountIdleTimeoutSec), []);
    assert.deepEqual(UI.timeoutProblems(UI.MAX_IDLE_SEC - 1), []);
    assert.deepEqual(UI.timeoutProblems(UI.MAX_IDLE_SEC), []);       // 86400
});

test('the idle timeout rejects just outside its range, at the boundaries', () => {
    assert.ok(UI.timeoutProblems(UI.MIN_IDLE_SEC - 1).some((m) => /at least 60/.test(m)));
    assert.ok(UI.timeoutProblems(1).some((m) => /at least 60/.test(m)));
    assert.ok(UI.timeoutProblems(UI.MAX_IDLE_SEC + 1).some((m) => /at most 86400/.test(m)));
    assert.ok(UI.timeoutProblems(31536000).some((m) => /at most 86400/.test(m)));
});

test('a negative idle timeout is rejected as negative, not as too small', () => {
    const problems = UI.timeoutProblems(-1);
    assert.deepEqual(problems, ['Idle timeout cannot be negative.']);
    assert.deepEqual(UI.timeoutProblems(-86400), ['Idle timeout cannot be negative.']);
});

test('a fractional idle timeout is rejected', () => {
    assert.ok(UI.timeoutProblems(900.5).some((m) => /whole number/.test(m)));
    assert.ok(UI.timeoutProblems('60.5').some((m) => /whole number/.test(m)));
    assert.deepEqual(UI.timeoutProblems('900.0'), []);
});

test('a non-numeric idle timeout is rejected rather than becoming zero', () => {
    ['', '   ', 'abc', null, undefined, NaN, Infinity, true, {}].forEach((v) => {
        const problems = UI.timeoutProblems(v);
        assert.deepEqual(problems, ['Idle timeout must be a number of seconds.'],
            'value ' + String(v));
    });
});

test('a numeric string from a text input is accepted', () => {
    assert.deepEqual(UI.timeoutProblems('900'), []);
    assert.deepEqual(UI.timeoutProblems(' 0 '), []);
});

// ------------------------------------------------------------ notifyOnFailure

test('notifyOnFailure must be an actual boolean', () => {
    assert.deepEqual(UI.notifyProblems(true), []);
    assert.deepEqual(UI.notifyProblems(false), []);
    ['true', 'false', 'yes', 1, 0, null, undefined, {}].forEach((v) => {
        assert.deepEqual(UI.notifyProblems(v), ['Notify on failure must be true or false.'],
            'value ' + String(v));
    });
});

// ------------------------------------------------------------ validateSettings

test('the shipped defaults validate', () => {
    assert.deepEqual(UI.validateSettings(DEFAULTS), []);
    assert.deepEqual(UI.validateSettings(UI.formFromSettings(null)), []);
});

test('validateSettings reports every field, in field order', () => {
    const problems = UI.validateSettings({
        mountRoot: 'relative/path',
        mountIdleTimeoutSec: -5,
        notifyOnFailure: 'yes',
        updateRepo: 'not a repo',
        updateCheckOnStartup: 'sometimes'
    });
    assert.equal(problems.length, 5);
    assert.match(problems[0], /Mount folder/);
    assert.match(problems[1], /Idle timeout/);
    assert.match(problems[2], /Notify on failure/);
    assert.match(problems[3], /Update repository/);
    assert.match(problems[4], /Check for updates/);
});

test('validateSettings on an empty or missing form still answers', () => {
    assert.equal(UI.validateSettings(null).length, 4);
    assert.equal(UI.validateSettings(undefined).length, 4);
    assert.equal(UI.validateSettings('nonsense').length, 4);
});

test('fieldProblems keys the problems by field', () => {
    const byField = UI.fieldProblems({ mountRoot: '/ok', mountIdleTimeoutSec: 5, notifyOnFailure: true });
    assert.deepEqual(byField.mountRoot, []);
    assert.equal(byField.mountIdleTimeoutSec.length, 1);
    assert.deepEqual(byField.notifyOnFailure, []);
});

// ------------------------------------------------------------------- form <-> settings

test('formFromSettings fills defaults and drops unknown keys', () => {
    const form = UI.formFromSettings({ mountRoot: '/x', nonsense: 'dropped' });
    assert.deepEqual(form, {
        mountRoot: '/x',
        mountIdleTimeoutSec: DEFAULTS.mountIdleTimeoutSec,
        notifyOnFailure: DEFAULTS.notifyOnFailure,
        updateRepo: DEFAULTS.updateRepo,
        updateCheckOnStartup: DEFAULTS.updateCheckOnStartup
    });
    assert.equal(form.nonsense, undefined);
});

test('formFromSettings on null is the shipped defaults', () => {
    assert.deepEqual(UI.formFromSettings(null), {
        mountRoot: DEFAULTS.mountRoot,
        mountIdleTimeoutSec: DEFAULTS.mountIdleTimeoutSec,
        notifyOnFailure: DEFAULTS.notifyOnFailure,
        updateRepo: DEFAULTS.updateRepo,
        updateCheckOnStartup: DEFAULTS.updateCheckOnStartup
    });
});

test('settingsFromForm trims and coerces exactly once', () => {
    assert.deepEqual(UI.settingsFromForm({
        mountRoot: '  /srv/mnt  ',
        mountIdleTimeoutSec: '1200',
        notifyOnFailure: 1,
        updateRepo: '  appuser/hangar  ',
        updateCheckOnStartup: 1
    }), { mountRoot: '/srv/mnt', mountIdleTimeoutSec: 1200, notifyOnFailure: true,
          updateRepo: 'appuser/hangar', updateCheckOnStartup: true });
});

test('settingsFromForm keeps an unparseable timeout as null rather than zero', () => {
    assert.equal(UI.settingsFromForm({ mountIdleTimeoutSec: '' }).mountIdleTimeoutSec, null);
    assert.equal(UI.settingsFromForm(null).mountIdleTimeoutSec, null);
});

test('a form round-trips through settings unchanged', () => {
    const settings = { mountRoot: '/srv/mnt', mountIdleTimeoutSec: 120, notifyOnFailure: false,
        updateRepo: 'appuser/hangar', updateCheckOnStartup: true };
    const back = UI.settingsFromForm(UI.formFromSettings(settings));
    assert.deepEqual(back, settings);
    assert.equal(UI.isDirty(UI.formFromSettings(settings), settings), false);
});

// -------------------------------------------------------------------- isDirty

test('an untouched form is not dirty', () => {
    const saved = Config.mergeGlobal({ mountRoot: '/srv/mnt', mountIdleTimeoutSec: 300 });
    assert.equal(UI.isDirty(UI.formFromSettings(saved), saved), false);
    assert.equal(UI.isDirty(null, null), false);
    assert.equal(UI.isDirty(DEFAULTS, null), false);
});

test('a changed value is dirty, and changedFields names it', () => {
    const saved = Config.mergeGlobal({});
    assert.equal(UI.isDirty({ mountRoot: '/other' }, saved), true);
    assert.deepEqual(UI.changedFields({ mountRoot: '/other' }, saved), ['mountRoot']);
    assert.deepEqual(UI.changedFields({ mountRoot: '/other', notifyOnFailure: false }, saved),
        ['mountRoot', 'notifyOnFailure']);
});

test('dirty detection sees through the string/number coercion of a number input', () => {
    const saved = Config.mergeGlobal({ mountIdleTimeoutSec: 900 });
    assert.equal(UI.isDirty({ mountIdleTimeoutSec: '900' }, saved), false);
    assert.equal(UI.isDirty({ mountIdleTimeoutSec: ' 900 ' }, saved), false);
    assert.equal(UI.isDirty({ mountIdleTimeoutSec: '0900' }, saved), false);
    assert.equal(UI.isDirty({ mountIdleTimeoutSec: '9e2' }, saved), false);
    assert.equal(UI.isDirty({ mountIdleTimeoutSec: 900.0 }, saved), false);
    assert.equal(UI.isDirty({ mountIdleTimeoutSec: 901 }, saved), true);
});

test('a half-typed number is dirty rather than collapsing to unchanged', () => {
    const saved = Config.mergeGlobal({ mountIdleTimeoutSec: 900 });
    assert.equal(UI.isDirty({ mountIdleTimeoutSec: '' }, saved), true);
    assert.equal(UI.isDirty({ mountIdleTimeoutSec: 'abc' }, saved), true);
    // Two unparseable values compare as text, so retyping the same nonsense is
    // not a change.
    assert.equal(UI.isDirty({ mountIdleTimeoutSec: 'abc' }, { mountIdleTimeoutSec: 'abc' }), false);
    assert.equal(UI.isDirty({ mountIdleTimeoutSec: 'abc' }, { mountIdleTimeoutSec: 'abd' }), true);
});

test('surrounding whitespace in a path is not a change', () => {
    const saved = Config.mergeGlobal({ mountRoot: '/srv/mnt' });
    assert.equal(UI.isDirty({ mountRoot: '  /srv/mnt  ' }, saved), false);
    assert.equal(UI.isDirty({ mountRoot: '/srv/mnt/' }, saved), true);
    assert.equal(UI.isDirty({ mountRoot: '/SRV/mnt' }, saved), true);   // paths are case sensitive
});

test('the checkbox compares by truthiness, so a hand-edited 1 is not a change', () => {
    assert.equal(UI.isDirty({ notifyOnFailure: true }, { notifyOnFailure: 1 }), false);
    assert.equal(UI.isDirty({ notifyOnFailure: false }, { notifyOnFailure: 0 }), false);
    assert.equal(UI.isDirty({ notifyOnFailure: false }, { notifyOnFailure: true }), true);
    // mergeGlobal keeps null out, so a null in the stored file reads as the
    // default (true) rather than as "off".
    assert.equal(UI.isDirty({ notifyOnFailure: true }, { notifyOnFailure: null }), false);
});

test('sameValue is field-aware', () => {
    assert.equal(UI.sameValue('mountRoot', ' /a ', '/a'), true);
    assert.equal(UI.sameValue('mountIdleTimeoutSec', '60', 60), true);
    assert.equal(UI.sameValue('notifyOnFailure', 'yes', true), true);
    assert.equal(UI.sameValue('mountIdleTimeoutSec', '60', 61), false);
});

// -------------------------------------------------------------- version file

test('the installed-version file is read as a single line', () => {
    assert.equal(UI.parseVersionFile('0.1.0\n'), '0.1.0');
    assert.equal(UI.parseVersionFile('\n\n   \n0.2.0\nnoise\n'), '0.2.0');
    assert.equal(UI.parseVersionFile('  0.3.0  '), '0.3.0');
});

test('an empty or missing installed-version file reads as null, never as a version', () => {
    assert.equal(UI.parseVersionFile(''), null);
    assert.equal(UI.parseVersionFile('\n\n  \t\n'), null);
    assert.equal(UI.parseVersionFile(null), null);
    assert.equal(UI.parseVersionFile(undefined), null);
});

test('a preposterous installed-version file is truncated, not trusted whole', () => {
    assert.equal(UI.parseVersionFile('x'.repeat(500)).length, 64);
});

test('the version path lives under the config directory', () => {
    assert.equal(UI.VERSION_PATH, Config.CONF_DIR + '/installed-version');
});

// -------------------------------------------------------------------- tools

test('versionText formats a parsed version and admits when there is none', () => {
    assert.equal(UI.versionText({ major: 0, minor: 19, patch: 1 }), '0.19.1');
    assert.equal(UI.versionText(null), '-');
    assert.equal(UI.versionText(undefined), '-');
    assert.equal(UI.versionText({}), '-');
    assert.equal(UI.versionText('1.2.3'), '1.2.3');
});

test('a tool banner is collapsed to one line and bounded', () => {
    assert.equal(UI.bannerText('restic 0.19.1\ncompiled  with   go'), 'restic 0.19.1 compiled with go');
    assert.equal(UI.bannerText(''), 'not installed');
    assert.equal(UI.bannerText(null), 'not installed');
    const long = UI.bannerText('y'.repeat(400));
    assert.equal(long.length, 120);
    assert.ok(long.endsWith('...'));
});

test('tool status is missing / too old / ok, and never guesses', () => {
    assert.equal(UI.toolStatus(probeRow('restic')), 'missing');
    assert.equal(UI.toolStatus(probeRow('restic', { present: true, ok: false })), 'too old');
    assert.equal(UI.toolStatus(probeRow('restic', { present: true, ok: true })), 'ok');
    assert.equal(UI.toolStatus(null), 'unknown');
    assert.equal(UI.toolStatus('restic'), 'unknown');
});

test('toolRows drops junk and describes the rest', () => {
    const rows = UI.toolRows([null, 'restic', {}, PROBES[0], PROBES[1]]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.tool), ['restic', 'rclone']);
    assert.deepEqual(rows.map((r) => r.need), ['required', 'optional']);
    assert.deepEqual(rows.map((r) => r.status), ['ok', 'missing']);
    assert.equal(rows[0].version, '0.19.1');
    assert.equal(rows[1].version, '-');
});

test('toolRows on nothing is an empty list, not a throw', () => {
    assert.deepEqual(UI.toolRows(null), []);
    assert.deepEqual(UI.toolRows('nope'), []);
});

// --------------------------------------------------------------------- FUSE

test('FUSE is usable only when fuse3 is present and new enough', () => {
    assert.equal(UI.fuseState(PROBES).usable, true);
    assert.equal(UI.fuseState(PROBES).label, 'available');
});

test('a missing fuse3 is reported as a fallback, not as a failure', () => {
    const state = UI.fuseState([PROBES[0], probeRow('fuse3', { binary: 'fusermount3' })]);
    assert.equal(state.usable, false);
    assert.equal(state.label, 'not available');
    assert.match(state.detail, /fusermount3 is not installed/);
    assert.match(state.detail, /Logbook still works/);
});

test('an outdated fuse3 is reported as too old', () => {
    const state = UI.fuseState([probeRow('fuse3', { present: true, ok: false })]);
    assert.equal(state.usable, false);
    assert.equal(state.label, 'too old');
});

test('an unprobed FUSE says unknown rather than claiming it works', () => {
    const state = UI.fuseState([]);
    assert.equal(state.usable, false);
    assert.equal(state.label, 'unknown');
});

// -------------------------------------------------------------- diagnostics

const REPORT_INFO = {
    version: '0.1.0',
    family: 'rhel',
    tools: PROBES,
    settings: { mountRoot: '/run/hangar/mnt', mountIdleTimeoutSec: 900, notifyOnFailure: true },
    generatedAt: '2026-08-01T09:00:00.000Z'
};

test('the diagnostics report is exactly this text', () => {
    const expected = [
        'hangar diagnostics',
        '==================',
        'hangar version:       0.1.0',
        'distribution family:  rhel',
        'FUSE:                 available',
        'generated:            2026-08-01T09:00:00.000Z',
        '',
        'tools',
        '-----',
        'restic    required  0.19.1    ok        restic 0.19.1 compiled with go1.24.1',
        'rclone    optional  -         missing   not installed',
        'fuse3     optional  3.16.2    ok        fusermount3 version: 3.16.2',
        '',
        'settings',
        '--------',
        'mountRoot             /run/hangar/mnt',
        'mountIdleTimeoutSec   900',
        'notifyOnFailure       true',
        ''
    ].join('\n');
    assert.equal(UI.diagnosticsText(REPORT_INFO), expected);
});

test('an empty diagnostics report says what it does not know', () => {
    const expected = [
        'hangar diagnostics',
        '==================',
        'hangar version:       unknown',
        'distribution family:  unknown',
        'FUSE:                 unknown',
        'generated:            unknown',
        '',
        'tools',
        '-----',
        '(no tools were probed)',
        '',
        'settings',
        '--------',
        '(settings could not be read)',
        ''
    ].join('\n');
    assert.equal(UI.diagnosticsText(null), expected);
    assert.equal(UI.diagnosticsText({}), expected);
    assert.equal(UI.diagnosticsText('nonsense'), expected);
});

test('notes appear only when there are any', () => {
    const text = UI.diagnosticsText(Object.assign({}, REPORT_INFO, {
        notes: ['The distribution family could not be detected.', '', '  ']
    }));
    assert.match(text, /\nnotes\n-----\nThe distribution family could not be detected\.\n$/);
    assert.doesNotMatch(UI.diagnosticsText(REPORT_INFO), /\nnotes\n/);
});

test('the report never dumps unknown fields from the info object', () => {
    const text = UI.diagnosticsText(Object.assign({}, REPORT_INFO, {
        repositoryPassword: 'hunter2', extra: { deep: 'secret' }
    }));
    assert.doesNotMatch(text, /hunter2/);
    assert.doesNotMatch(text, /repositoryPassword/);
});

test('the report is redacted before it can be pasted anywhere', () => {
    const text = UI.diagnosticsText(Object.assign({}, REPORT_INFO, {
        tools: [probeRow('restic', {
            present: true, ok: true, version: { major: 0, minor: 19, patch: 1 },
            raw: 'restic 0.19.1 password=hunter2'
        })]
    }));
    assert.doesNotMatch(text, /hunter2/);
    assert.match(text, /password=\*\*\*/);
});

test('the report uses the settings it was given, not the defaults', () => {
    const text = UI.diagnosticsText(Object.assign({}, REPORT_INFO, {
        settings: { mountRoot: '/srv/mnt', mountIdleTimeoutSec: 0, notifyOnFailure: false }
    }));
    assert.match(text, /mountRoot {13}\/srv\/mnt/);
    assert.match(text, /mountIdleTimeoutSec {3}0/);
    assert.match(text, /notifyOnFailure {7}false/);
});

test('pad never truncates', () => {
    assert.equal(UI.pad('ab', 5), 'ab   ');
    assert.equal(UI.pad('abcdef', 3), 'abcdef');
    assert.equal(UI.pad(null, 3), '   ');
});

// ------------------------------------------------------------------- labels

test('remediation labels cover every slug errors.js can produce', () => {
    Object.keys(Errors.REMEDIATION).forEach((kind) => {
        const slug = Errors.REMEDIATION[kind];
        assert.notEqual(UI.remediationLabel(slug), '', 'no label for ' + slug);
    });
    assert.equal(UI.remediationLabel('nonsense'), '');
    assert.equal(UI.remediationLabel(null), '');
});

test('errorText survives a non-Error', () => {
    assert.equal(UI.errorText(Errors.create('NO_SPACE', 'out of space')), 'out of space');
    assert.equal(UI.errorText('plain string'), 'plain string');
    assert.equal(UI.errorText(null), '');
});

test('the timeout is described in units a person uses', () => {
    assert.equal(UI.describeTimeout(0), 'Snapshots stay mounted until you unmount them.');
    assert.equal(UI.describeTimeout(60), 'Unmounts after 60 seconds of no activity.');
    assert.equal(UI.describeTimeout(900), 'Unmounts after 15 minutes of no activity.');
    assert.equal(UI.describeTimeout(86400), 'Unmounts after 24 hours of no activity.');
    assert.equal(UI.describeTimeout(9000), 'Unmounts after 2.5 hours of no activity.');
    assert.equal(UI.describeTimeout('abc'), '');
    assert.equal(UI.describeTimeout(-5), '');
});

test('tool status classes exist for every status toolStatus can return', () => {
    ['ok', 'missing', 'too old', 'unknown'].forEach((s) => {
        assert.match(UI.statusClass(s), /^text-bg-/);
    });
    assert.equal(UI.statusClass('invented'), 'text-bg-secondary');
});

// ---------------------------------------------------------------- component

test('load() fills the form from readGlobal and starts clean', async () => {
    const deps = stubDeps({
        config: {
            mergeGlobal: Config.mergeGlobal,
            readGlobal: () => Promise.resolve(Config.mergeGlobal({ mountRoot: '/srv/mnt' })),
            writeGlobal: () => Promise.resolve()
        }
    });
    const c = UI.hangarSettingsUi(deps);
    await c.load();
    assert.equal(c.loading, false);
    assert.equal(c.form.mountRoot, '/srv/mnt');
    assert.equal(c.dirty(), false);
    assert.equal(c.canSave(), false);
});

test('an unreadable config falls back to the defaults and keeps the error', async () => {
    const boom = Errors.create('GENERIC', 'Could not read /etc/hangar/config.json');
    const c = UI.hangarSettingsUi(stubDeps({
        config: {
            mergeGlobal: Config.mergeGlobal,
            readGlobal: () => Promise.reject(boom),
            writeGlobal: () => Promise.resolve()
        }
    }));
    await c.load();
    assert.equal(c.error, boom);
    assert.equal(c.form.mountRoot, DEFAULTS.mountRoot);
    assert.equal(c.dirty(), false);
    assert.equal(c.errorRemediation(), null);
});

test('editing marks the screen dirty and enables Save', async () => {
    const c = UI.hangarSettingsUi(stubDeps());
    await c.load();
    c.form.mountIdleTimeoutSec = 1800;
    c.touched();
    assert.equal(c.dirty(), true);
    assert.deepEqual(c.changed(), ['mountIdleTimeoutSec']);
    assert.equal(c.canSave(), true);
    assert.equal(c.canRevert(), true);
});

test('an invalid form cannot be saved and never reaches writeGlobal', async () => {
    const deps = stubDeps();
    const c = UI.hangarSettingsUi(deps);
    await c.load();
    c.form.mountRoot = 'not/absolute';
    assert.equal(c.canSave(), false);
    assert.equal(c.hasProblem('mountRoot'), true);
    assert.equal(await c.save(), false);
    assert.deepEqual(deps.written, []);
});

test('save() writes the coerced settings and clears the dirty state', async () => {
    const deps = stubDeps();
    const c = UI.hangarSettingsUi(deps);
    await c.load();
    c.form.mountRoot = '  /srv/mnt  ';
    c.form.mountIdleTimeoutSec = '1800';
    c.form.notifyOnFailure = false;
    assert.equal(await c.save(), true);
    assert.deepEqual(deps.written, [
        { mountRoot: '/srv/mnt', mountIdleTimeoutSec: 1800, notifyOnFailure: false,
          updateRepo: DEFAULTS.updateRepo, updateCheckOnStartup: DEFAULTS.updateCheckOnStartup }
    ]);
    assert.equal(c.dirty(), false);
    assert.equal(c.savedAt, '2026-08-01T09:00:00.000Z');
    assert.equal(c.form.mountRoot, '/srv/mnt');
});

test('a failed write keeps the edit and surfaces the error with its action', async () => {
    const locked = Errors.create('NO_SPACE', 'no space left on device');
    const deps = stubDeps({
        config: {
            mergeGlobal: Config.mergeGlobal,
            readGlobal: () => Promise.resolve(Config.mergeGlobal({})),
            writeGlobal: () => Promise.reject(locked)
        }
    });
    const c = UI.hangarSettingsUi(deps);
    await c.load();
    c.form.mountRoot = '/srv/mnt';
    assert.equal(await c.save(), false);
    assert.equal(c.error, locked);
    assert.equal(c.errorRemediation(), 'free-space');
    assert.equal(UI.remediationLabel(c.errorRemediation()), 'Show what to free');
    assert.equal(c.dirty(), true);
    assert.equal(c.saving, false);
});

test('revert() puts the saved values back', async () => {
    const c = UI.hangarSettingsUi(stubDeps());
    await c.load();
    c.form.mountRoot = '/somewhere/else';
    c.savedAt = 'earlier';
    c.revert();
    assert.equal(c.form.mountRoot, DEFAULTS.mountRoot);
    assert.equal(c.dirty(), false);
    assert.equal(c.savedAt, null);
});

test('touched() drops the Saved confirmation, which belonged to older values', async () => {
    const c = UI.hangarSettingsUi(stubDeps());
    await c.load();
    c.form.mountRoot = '/srv/mnt';
    await c.save();
    assert.ok(c.savedAt);
    c.touched();
    assert.equal(c.savedAt, null);
});

test('diagnostics gather version, family, tools and FUSE', async () => {
    const c = UI.hangarSettingsUi(stubDeps());
    await c.load();
    const info = await c.loadDiagnostics();
    assert.equal(c.diagLoading, false);
    assert.equal(info.version, '0.1.0');
    assert.equal(info.family, 'rhel');
    assert.equal(info.fuse.usable, true);
    assert.deepEqual(c.tools().map((t) => t.tool), ['restic', 'rclone', 'fuse3']);
    assert.deepEqual(info.notes, []);
    assert.match(c.report(), /^hangar diagnostics\n/);
    assert.match(c.report(), /hangar version:       0\.1\.0/);
});

test('a failed probe becomes a note in the report, not a broken screen', async () => {
    const c = UI.hangarSettingsUi(stubDeps({
        readVersion: () => Promise.reject(new Error('nope')),
        provision: {
            detectFamilyLive: () => Promise.reject(new Error('no os-release')),
            probeAll: () => Promise.reject(Errors.create('GENERIC', 'spawn failed'))
        }
    }));
    await c.load();
    const info = await c.loadDiagnostics();
    assert.equal(info.version, null);
    assert.equal(info.family, 'unknown');
    assert.deepEqual(info.tools, []);
    assert.equal(info.notes.length, 3);
    const text = c.report();
    assert.match(text, /\(no tools were probed\)/);
    assert.match(text, /spawn failed/);
    assert.equal(c.fuse().usable, false);
});

test('saving refreshes the settings quoted in the report', async () => {
    const c = UI.hangarSettingsUi(stubDeps());
    await c.load();
    await c.loadDiagnostics();
    assert.match(c.report(), /mountRoot {13}\/run\/hangar\/mnt/);
    c.form.mountRoot = '/srv/mnt';
    await c.save();
    assert.match(c.report(), /mountRoot {13}\/srv\/mnt/);
});

test('copyReport uses the clipboard when there is one', async () => {
    const seen = [];
    const c = UI.hangarSettingsUi(stubDeps({
        clipboard: { writeText: (t) => { seen.push(t); return Promise.resolve(); } }
    }));
    await c.load();
    await c.loadDiagnostics();
    assert.equal(await c.copyReport(), true);
    assert.equal(c.copyState, 'copied');
    assert.equal(seen.length, 1);
    assert.equal(seen[0], c.report());
});

test('a refused or absent clipboard leaves the report on screen instead of failing', async () => {
    const c = UI.hangarSettingsUi(stubDeps());   // no clipboard under node
    await c.load();
    assert.equal(await c.copyReport(), false);
    assert.equal(c.copyState, 'failed');

    const refused = UI.hangarSettingsUi(stubDeps({
        clipboard: { writeText: () => Promise.reject(new Error('not allowed')) }
    }));
    await refused.load();
    assert.equal(await refused.copyReport(), false);
    assert.equal(refused.copyState, 'failed');
});

test('init() loads settings and diagnostics together', async () => {
    const c = UI.hangarSettingsUi(stubDeps());
    await c.init();
    assert.equal(c.loading, false);
    assert.equal(c.diag.family, 'rhel');
    assert.equal(c.form.mountRoot, DEFAULTS.mountRoot);
});

test('readInstalledVersion resolves to null with no cockpit', async () => {
    assert.equal(await UI.readInstalledVersion(), null);
});
