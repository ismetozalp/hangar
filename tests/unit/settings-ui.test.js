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

test('the editable set matches the defaults core/config.js ships, minus the two it does not own', () => {
    // `version` is a schema marker owned by core/config.js, not a preference.
    // `theme` IS a preference, but it is applied and written on click rather than
    // through the form — so it must not appear in the dirty check or the Save
    // payload, or picking a colour would leave the screen claiming unsaved changes.
    const NOT_FORM_FIELDS = ['version', 'theme'];
    const editable = Object.keys(DEFAULTS)
        .filter((k) => !NOT_FORM_FIELDS.includes(k)).sort();
    assert.deepEqual(UI.EDITABLE.slice().sort(), editable);
    for (const k of NOT_FORM_FIELDS) {
        assert.ok(!UI.EDITABLE.includes(k), `${k} must not be a form field`);
    }
});

test('picking a theme applies it and writes it without touching the form', () => {
    const Themes = require('../../js/core/themes.js');
    const deps = stubDeps();
    const c = UI.hangarSettingsUi(deps);

    const events = [];
    const prevDispatch = globalThis.dispatchEvent;
    const prevCustom = globalThis.CustomEvent;
    globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
    globalThis.dispatchEvent = (ev) => { events.push(ev); return true; };

    return (async () => {
        try {
            await c.load();
            const before = JSON.stringify(c.form);
            assert.equal(await c.pickTheme('nord'), true);

            assert.equal(c.theme, 'nord');
            // The rest of the page has to repaint, not just this tab.
            assert.equal(events.length, 1);
            assert.equal(events[0].type, 'hangar:theme');
            assert.equal(events[0].detail, 'nord');
            // Written straight away, and the form is untouched.
            assert.equal(deps.written[deps.written.length - 1].theme, 'nord');
            assert.equal(JSON.stringify(c.form), before, 'the form must not change');
            assert.equal(c.dirty(), false, 'a theme pick must not look like an unsaved edit');

            // An unknown or unchanged theme is a no-op rather than a write.
            const writes = deps.written.length;
            assert.equal(await c.pickTheme('nord'), false);
            assert.equal(await c.pickTheme('nope'), false);
            assert.equal(deps.written.length, writes);
            assert.ok(Themes.isValid(c.theme));
        } finally {
            globalThis.dispatchEvent = prevDispatch;
            globalThis.CustomEvent = prevCustom;
        }
    })();
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
        updateCheckOnStartup: 'sometimes',
        repoSizeMaxAgeHours: 'often'
    });
    assert.equal(problems.length, 6);
    assert.match(problems[0], /Mount folder/);
    assert.match(problems[1], /Idle timeout/);
    assert.match(problems[2], /Notify on failure/);
    assert.match(problems[3], /Update repository/);
    assert.match(problems[4], /Check for updates/);
    assert.match(problems[5], /Size refresh/);
});

test('validateSettings on an empty or missing form still answers', () => {
    assert.equal(UI.validateSettings(null).length, 5);
    assert.equal(UI.validateSettings(undefined).length, 5);
    assert.equal(UI.validateSettings('nonsense').length, 5);
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
        updateCheckOnStartup: DEFAULTS.updateCheckOnStartup,
        repoSizeMaxAgeHours: DEFAULTS.repoSizeMaxAgeHours
    });
    assert.equal(form.nonsense, undefined);
});

test('formFromSettings on null is the shipped defaults', () => {
    assert.deepEqual(UI.formFromSettings(null), {
        mountRoot: DEFAULTS.mountRoot,
        mountIdleTimeoutSec: DEFAULTS.mountIdleTimeoutSec,
        notifyOnFailure: DEFAULTS.notifyOnFailure,
        updateRepo: DEFAULTS.updateRepo,
        updateCheckOnStartup: DEFAULTS.updateCheckOnStartup,
        repoSizeMaxAgeHours: DEFAULTS.repoSizeMaxAgeHours
    });
});

test('settingsFromForm trims and coerces exactly once', () => {
    assert.deepEqual(UI.settingsFromForm({
        mountRoot: '  /srv/mnt  ',
        mountIdleTimeoutSec: '1200',
        notifyOnFailure: 1,
        updateRepo: '  appuser/hangar  ',
        updateCheckOnStartup: 1,
        repoSizeMaxAgeHours: '12'
    }), { mountRoot: '/srv/mnt', mountIdleTimeoutSec: 1200, notifyOnFailure: true,
          updateRepo: 'appuser/hangar', updateCheckOnStartup: true,
          repoSizeMaxAgeHours: 12 });
});

test('settingsFromForm keeps an unparseable timeout as null rather than zero', () => {
    assert.equal(UI.settingsFromForm({ mountIdleTimeoutSec: '' }).mountIdleTimeoutSec, null);
    assert.equal(UI.settingsFromForm(null).mountIdleTimeoutSec, null);
});

test('a form round-trips through settings unchanged', () => {
    const settings = { mountRoot: '/srv/mnt', mountIdleTimeoutSec: 120, notifyOnFailure: false,
        updateRepo: 'appuser/hangar', updateCheckOnStartup: true, repoSizeMaxAgeHours: 6 };
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
        'repoSizeMaxAgeHours   24',
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
          updateRepo: DEFAULTS.updateRepo, updateCheckOnStartup: DEFAULTS.updateCheckOnStartup,
          repoSizeMaxAgeHours: DEFAULTS.repoSizeMaxAgeHours }
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

// ===================================================================== hardening
//
// Everything below attacks the screen rather than describing it: the error paths
// nobody clicks through by hand, and the pure functions fed input no form would
// ever produce. Two rules are load-bearing enough to be asserted directly rather
// than inferred — a non-fatal outcome is a WARNING that names the files it could
// not read, and every failure that has a remediation offers it as an action.

// A core call that fails once and then succeeds, so a retry can be observed
// rather than assumed.
function flaky(err) {
    let armed = true;
    const calls = [];
    return {
        calls: calls,
        disarm: function () { armed = false; },
        fn: function (arg) {
            calls.push(arg);
            if (armed) return Promise.reject(err);
            return Promise.resolve();
        }
    };
}

// ------------------------------------------------------ no DOM, no cockpit

test('no pure export touches the DOM or cockpit, and none throws on nothing', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.cockpit, 'undefined');
    assert.equal(typeof globalThis.window, 'undefined');

    // Every exported function, called with the arguments a caller is most likely
    // to get wrong. None may throw; a settings screen that dies on a null is not
    // a settings screen.
    Object.keys(UI).forEach((name) => {
        const fn = UI[name];
        if (typeof fn !== 'function' || name === 'hangarSettingsUi' ||
            name === 'mount' || name === 'readInstalledVersion') return;
        [[], [null], [undefined], [''], [0], [NaN], [{}], [[]], [true],
            [null, null], [undefined, undefined]].forEach((args) => {
            assert.doesNotThrow(() => fn.apply(null, args),
                name + '(' + args.map(String).join(', ') + ') threw');
        });
    });
});

test('the module has no side effects at load time beyond its own globals', () => {
    // Requiring it again must be a no-op, not a second attempt to find a document.
    delete require.cache[require.resolve('../../js/features/settings-ui.js')];
    const again = require('../../js/features/settings-ui.js');
    assert.equal(typeof again.hangarSettingsUi, 'function');
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(globalThis.HangarSettingsUi, again);
});

test('mount() refuses anything that is not a document, without throwing', () => {
    [null, undefined, 0, '', 'document', [], { getElementById: 'not a function' }]
        .forEach((d) => assert.equal(UI.mount(d), false, String(d)));
    // A document with no #hangar-settings is a no-op, not a crash.
    assert.equal(UI.mount({ getElementById: () => null }), false);
    // A host that is already mounted is never mounted twice.
    let inserted = 0;
    const host = {
        _attrs: { 'data-hangar-mounted': null },
        getAttribute(k) { return this._attrs[k]; },
        setAttribute(k, v) { this._attrs[k] = v; },
        insertAdjacentHTML() { inserted++; }
    };
    const doc = { getElementById: () => host };
    assert.equal(UI.mount(doc), true);
    assert.equal(UI.mount(doc), false);
    assert.equal(inserted, 1);
});

// ------------------------------------------------------------ hostile input

test('a value with no usable string conversion is empty, not an exception', () => {
    const hostile = { toString() { throw new Error('nope'); } };
    assert.deepEqual(UI.pathProblems(hostile), ['Mount folder is required.']);
    assert.equal(UI.toNumber(hostile), null);
    assert.equal(UI.bannerText(hostile), 'not installed');
    assert.equal(UI.describeTimeout(hostile), '');
    assert.equal(UI.pad(hostile, 4), '    ');
    // Object.create(null) has no toString at all.
    assert.deepEqual(UI.pathProblems(Object.create(null)), ['Mount folder is required.']);
});

test('unicode, quotes and non-latin text are ordinary characters in a path', () => {
    assert.deepEqual(UI.pathProblems('/srv/yedekler/\u{1F4BE}'), []);
    assert.deepEqual(UI.pathProblems('/srv/備份/快照'), []);
    assert.deepEqual(UI.pathProblems('/srv/نسخ احتياطي'), []);
    assert.deepEqual(UI.pathProblems('/srv/it\'s a "backup"'), []);
    assert.deepEqual(UI.pathProblems('/srv/a\\backup'), []);   // backslash is a legal byte
});

test('a path with an embedded newline is rejected however it is dressed up', () => {
    ['/srv/mnt\nExecStart=/bin/sh', '/srv/mnt\r\nWantedBy=x', '/srv/"mnt"\n[Unit]']
        .forEach((p) => {
            assert.ok(UI.pathProblems(p).some((m) => /control characters/.test(m)), p);
        });
});

test('an enormous path is rejected once, not counted character by character', () => {
    const huge = '/' + 'a'.repeat(200000);
    const problems = UI.pathProblems(huge);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /longer than 4096/);
});

test('toNumber survives the exotic numeric literals a paste can carry', () => {
    assert.equal(UI.toNumber('0x10'), 16);            // Number() accepts it; the range check rejects it
    assert.ok(UI.timeoutProblems('0x10').some((m) => /at least 60/.test(m)));
    assert.equal(UI.toNumber('1e400'), null);         // overflows to Infinity
    assert.equal(UI.toNumber('-0'), -0);
    assert.equal(UI.toNumber('١٢٣'), null);   // Arabic-Indic digits are not JS numbers
    assert.equal(UI.toNumber('900\n'), 900);          // a trailing newline is whitespace
    assert.equal(UI.toNumber('9,00'), null);
    assert.equal(UI.toNumber(' '), null);
});

test('an absurd idle timeout is bounded rather than believed', () => {
    [Number.MAX_SAFE_INTEGER, 1e15, 86401].forEach((v) => {
        assert.ok(UI.timeoutProblems(v).some((m) => /at most 86400/.test(m)), String(v));
    });
    assert.deepEqual(UI.timeoutProblems(-Number.MAX_SAFE_INTEGER),
        ['Idle timeout cannot be negative.']);
    // 1e21 is an integer but stringifies in exponential notation; it must still
    // be rejected by value, and describing it must not throw.
    assert.ok(UI.timeoutProblems(1e21).some((m) => /at most 86400/.test(m)));
    assert.doesNotThrow(() => UI.describeTimeout(1e21));
});

test('describeTimeout never claims a duration it was not given', () => {
    assert.equal(UI.describeTimeout(null), '');
    assert.equal(UI.describeTimeout(''), '');
    assert.equal(UI.describeTimeout(0.5), '');
    assert.equal(UI.describeTimeout(-0), 'Snapshots stay mounted until you unmount them.');
    assert.equal(UI.describeTimeout(119), 'Unmounts after 119 seconds of no activity.');
    assert.equal(UI.describeTimeout(120), 'Unmounts after 2 minutes of no activity.');
    assert.equal(UI.describeTimeout(7199), 'Unmounts after 120 minutes of no activity.');
    assert.equal(UI.describeTimeout(7200), 'Unmounts after 2 hours of no activity.');
});

test('a probe row made of junk still produces a renderable row', () => {
    const rows = UI.toolRows([{
        tool: { toString() { return 'weird'; } },
        binary: null, optional: 'yes', present: 'no', version: 'not a version',
        ok: 1, raw: { toString() { throw new Error('x'); } }
    }]);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
        tool: 'weird', binary: '', optional: true, need: 'optional',
        present: true, version: 'not a version', status: 'ok', banner: 'not installed'
    });
});

test('toolRows survives a probe list full of the wrong things', () => {
    assert.deepEqual(UI.toolRows([undefined, 0, '', false, [], { tool: '' }, { tool: 0 }]), []);
    assert.equal(UI.toolRows([{ tool: 'restic' }, { tool: 'restic' }]).length, 2);
});

test('fuseState reads the fuse3 row and only the fuse3 row', () => {
    // Duplicate probes: the last one wins, deliberately, so a re-probe appended to
    // the list is what the screen reports.
    const state = UI.fuseState([
        probeRow('fuse3', { present: false }),
        probeRow('fuse3', { present: true, ok: true })
    ]);
    assert.equal(state.usable, true);
    assert.equal(UI.fuseState([probeRow('FUSE3', { present: true, ok: true })]).label, 'unknown');
});

test('the report survives settings and notes full of newlines and quotes', () => {
    const text = UI.diagnosticsText({
        version: 'v1\ninjected: yes',
        family: 'rhel"; DROP',
        tools: [],
        settings: { mountRoot: '/srv/"mnt"\nnotifyOnFailure  false', mountIdleTimeoutSec: 900 },
        generatedAt: '  2026-08-01  ',
        notes: [null, undefined, 0, { toString() { throw new Error('x'); } }, 'a real note']
    });
    // Untrusted text is padded, never interpreted — and it never truncates the
    // report or throws.
    assert.match(text, /hangar version: {7}v1\ninjected: yes/);
    assert.match(text, /\nnotes\n-----\n/);
    assert.match(text, /a real note\n$/);
    // A note with no string form is dropped rather than rendered as a stack trace.
    assert.doesNotMatch(text, /nope|Error/);
    assert.ok(text.endsWith('\n'));
});

test('pad handles the widths a caller can get wrong', () => {
    assert.equal(UI.pad('ab', 0), 'ab');
    assert.equal(UI.pad('ab', -5), 'ab');
    assert.equal(UI.pad('', 3), '   ');
    assert.equal(UI.pad('ab', NaN), 'ab');
    assert.equal(UI.pad('ab', undefined), 'ab');
});

// -------------------------------------------------------- update repository

test('an update repository is accepted in every form update.js accepts', () => {
    ['owner/name', 'appuser/hangar', 'https://github.com/appuser/hangar',
        'https://github.com/appuser/hangar.git', 'http://www.github.com/a/b',
        'a.b-c_d/e.f-g_h'].forEach((v) => {
        assert.deepEqual(UI.updateRepoProblems(v), [], v);
    });
    assert.deepEqual(UI.updateRepoProblems(''), []);
    assert.deepEqual(UI.updateRepoProblems('   '), []);
    assert.deepEqual(UI.updateRepoProblems(null), []);
});

test('an update repository hangar could never check is rejected, not saved', () => {
    ['owner', 'owner/name/extra', '/name', 'owner/', 'owner name',
        'https://gitlab.com/a/b', 'owner/name;rm -rf /', 'a/b\nc/d',
        '../../etc/passwd', 'x'.repeat(300) + '/y'].forEach((v) => {
        const problems = UI.updateRepoProblems(v);
        assert.equal(problems.length, 1, JSON.stringify(v) + ' should be rejected');
        assert.match(problems[0], /"owner\/name"/);
    });
});

test('the built-in repository check agrees with update.js, so it is safe as a fallback', () => {
    // In the browser index.html loads update.js AFTER this screen, so the field
    // must still validate before HangarUpdate exists. Silently accepting anything
    // would save a repository that is never checked and never says why.
    const Update = require('../../js/features/update.js');
    ['owner/name', 'https://github.com/a/b.git', 'owner', 'a/b/c', '', 'a b/c',
        'https://gitlab.com/a/b', '/a/b/'].forEach((v) => {
        assert.equal(UI.looksLikeRepo(v), !!Update.releasesApiUrl(v),
            'disagreement on ' + JSON.stringify(v));
    });
});

test('checkOnStartup, like every other switch, must be a real boolean', () => {
    assert.deepEqual(UI.checkOnStartupProblems(true), []);
    assert.deepEqual(UI.checkOnStartupProblems(false), []);
    ['true', 1, 0, null, undefined, {}].forEach((v) => {
        assert.equal(UI.checkOnStartupProblems(v).length, 1, String(v));
    });
});

// ------------------------------------------ READ_ERRORS is a partial success

test('a non-fatal outcome is a partial success, and a real failure is not', () => {
    assert.equal(UI.isPartial(Errors.create('READ_ERRORS', 'some files were unreadable')), true);
    assert.equal(UI.isPartial(Errors.create('CANCELLED', 'stopped')), true);
    ['GENERIC', 'NO_SPACE', 'NETWORK', 'REPO_LOCKED', 'WRONG_PASSWORD',
        'REPO_MISSING', 'GO_RUNTIME', 'UNKNOWN'].forEach((kind) => {
        assert.equal(UI.isPartial(Errors.create(kind, 'x')), false, kind);
    });
    // An untyped throw is a failure by default — never quietly downgraded.
    assert.equal(UI.isPartial(new Error('boom')), false);
    assert.equal(UI.isPartial(null), false);
    assert.equal(UI.isPartial('READ_ERRORS'), false);
});

test('the unreadable file list is read from every shape a producer uses', () => {
    const at = (detail) => UI.unreadableFrom(Errors.create('READ_ERRORS', 'x', detail));
    assert.deepEqual(at(['/a', '/b']), ['/a', '/b']);
    assert.deepEqual(at({ errors: ['/c'] }), ['/c']);
    assert.deepEqual(at({ files: ['/d'] }), ['/d']);
    assert.deepEqual(at({ unreadable: ['/e'] }), ['/e']);
    // restic names the file in `item` and the reason in `message`.
    assert.deepEqual(at([{ item: '/var/lib/x' }, { path: '/var/lib/y' }, { message: 'z' }]),
        ['/var/lib/x', '/var/lib/y', 'z']);
});

test('the unreadable file list is deduplicated and free of junk', () => {
    const at = (detail) => UI.unreadableFrom(Errors.create('READ_ERRORS', 'x', detail));
    assert.deepEqual(at(['/a', '/a', '  /a  ', '', '   ', null, undefined, {}]), ['/a']);
    assert.deepEqual(at({ errors: 'not a list' }), []);
    assert.deepEqual(at(undefined), []);
    assert.deepEqual(UI.unreadableFrom(null), []);
    assert.deepEqual(UI.unreadableFrom(new Error('no detail')), []);
});

test('routeError sends a partial to the warning slot and a failure to the red one', () => {
    const partial = Errors.create('READ_ERRORS', 'some files were unreadable');
    const failure = Errors.create('NO_SPACE', 'no space left on device');
    assert.deepEqual(UI.routeError(partial), { error: null, partial: partial });
    assert.deepEqual(UI.routeError(failure), { error: failure, partial: null });
    assert.deepEqual(UI.routeError(null), { error: null, partial: null });
});

test('a partial read renders as a warning listing the files, never as a failure', async () => {
    const partial = Errors.create('READ_ERRORS', 'some settings could not be read',
        { files: ['/etc/hangar/config.json', '/etc/hangar/config.d/10-site.json'] });
    const c = UI.hangarSettingsUi(stubDeps({
        config: {
            mergeGlobal: Config.mergeGlobal,
            readGlobal: () => Promise.reject(partial),
            writeGlobal: () => Promise.resolve()
        }
    }));
    await c.load();

    assert.equal(c.error, null, 'a partial success must never fill the failure slot');
    assert.equal(c.partial, partial);
    assert.deepEqual(c.unreadable(),
        ['/etc/hangar/config.json', '/etc/hangar/config.d/10-site.json']);
    // The screen still works: defaults are shown and the form is usable.
    assert.equal(c.form.mountRoot, DEFAULTS.mountRoot);
    assert.equal(c.loading, false);
});

test('a partial write is a warning too, and the edit stays in the form', async () => {
    const partial = Errors.create('READ_ERRORS', 'config was written, one include was not',
        ['/etc/hangar/config.d/10-site.json']);
    const c = UI.hangarSettingsUi(stubDeps({
        config: {
            mergeGlobal: Config.mergeGlobal,
            readGlobal: () => Promise.resolve(Config.mergeGlobal({})),
            writeGlobal: () => Promise.reject(partial)
        }
    }));
    await c.load();
    c.form.mountRoot = '/srv/mnt';
    assert.equal(await c.save(), false);
    assert.equal(c.error, null);
    assert.equal(c.partial, partial);
    assert.deepEqual(c.unreadable(), ['/etc/hangar/config.d/10-site.json']);
    assert.equal(c.form.mountRoot, '/srv/mnt', 'the edit must survive');
});

test('the template renders the partial as amber and the failure as red', () => {
    // Design rule, asserted rather than eyeballed: the two outcomes are two
    // different boxes, and the warning names the files.
    // The toggle and the styling are allowed to sit on nested elements: x-show must
    // NOT share a tag with a Bootstrap display utility, because those are !important
    // and defeat the inline `display: none` x-show sets. So match across the wrapper.
    assert.match(UI.TEMPLATE, /x-show="error"[\s\S]{0,160}alert-danger/);
    assert.match(UI.TEMPLATE, /x-show="partial"[\s\S]{0,160}alert-warning/);
    assert.doesNotMatch(UI.TEMPLATE, /x-show="partial"[^>]*alert-danger/);
    assert.ok(UI.TEMPLATE.includes('x-for="f in unreadable()"'),
        'the warning must list the files it could not read');
});

test('a partial probe names the files in the diagnostics note', async () => {
    const c = UI.hangarSettingsUi(stubDeps({
        provision: {
            detectFamilyLive: () => Promise.resolve('debian'),
            probeAll: () => Promise.reject(Errors.create('READ_ERRORS',
                'some tools could not be inspected', { files: ['/usr/bin/restic'] }))
        }
    }));
    await c.load();
    const info = await c.loadDiagnostics();
    assert.equal(info.notes.length, 1);
    assert.match(info.notes[0], /some tools could not be inspected \(\/usr\/bin\/restic\)/);
    assert.match(c.report(), /\/usr\/bin\/restic/);
});

// ------------------------------------------------------------- remediations

test('every failure kind with a remediation offers it as an action, on read and on write', async () => {
    const cases = [
        ['REPO_LOCKED', 'unlock'],
        ['WRONG_PASSWORD', 'reprompt'],
        ['REPO_MISSING', 'init'],
        ['NO_SPACE', 'free-space'],
        ['NETWORK', 'retry']
    ];

    for (const [kind, slug] of cases) {
        const err = Errors.create(kind, kind.toLowerCase());

        const onRead = UI.hangarSettingsUi(stubDeps({
            config: {
                mergeGlobal: Config.mergeGlobal,
                readGlobal: () => Promise.reject(err),
                writeGlobal: () => Promise.resolve()
            }
        }));
        await onRead.load();
        assert.equal(onRead.error, err, kind + ' on read');
        assert.equal(onRead.errorRemediation(), slug, kind + ' remediation on read');
        assert.notEqual(onRead.remediationText(), '', kind + ' has no button label');
        assert.equal(onRead.remediationText(), UI.REMEDIATION_LABEL[slug]);

        const onWrite = UI.hangarSettingsUi(stubDeps({
            config: {
                mergeGlobal: Config.mergeGlobal,
                readGlobal: () => Promise.resolve(Config.mergeGlobal({})),
                writeGlobal: () => Promise.reject(err)
            }
        }));
        await onWrite.load();
        onWrite.form.mountRoot = '/srv/mnt';
        assert.equal(await onWrite.save(), false);
        assert.equal(onWrite.errorRemediation(), slug, kind + ' remediation on write');
    }
});

test('a failure with no one-click fix offers no button rather than a dead one', async () => {
    const c = UI.hangarSettingsUi(stubDeps({
        config: {
            mergeGlobal: Config.mergeGlobal,
            readGlobal: () => Promise.reject(Errors.create('GENERIC', 'could not read')),
            writeGlobal: () => Promise.resolve()
        }
    }));
    await c.load();
    assert.equal(c.errorRemediation(), null);
    // The label is still never empty, so the button can never render nameless if
    // it is shown for a kind this screen has not met yet.
    assert.equal(c.remediationText(), 'Try again');
    assert.match(UI.TEMPLATE, /x-show="errorRemediation\(\)"/);
});

test('the remediation button retries the save, and does not reload over the edit', async () => {
    // The bug this pins: wiring the action to load() discarded everything the
    // user had typed, while the button claimed to be freeing space.
    const write = flaky(Errors.create('NO_SPACE', 'no space left on device'));
    let reads = 0;
    const c = UI.hangarSettingsUi(stubDeps({
        config: {
            mergeGlobal: Config.mergeGlobal,
            readGlobal: () => { reads++; return Promise.resolve(Config.mergeGlobal({})); },
            writeGlobal: write.fn
        }
    }));
    await c.load();
    assert.equal(reads, 1);

    c.form.mountRoot = '/srv/mnt';
    c.form.mountIdleTimeoutSec = 1800;
    assert.equal(await c.save(), false);
    assert.equal(c.errorRemediation(), 'free-space');

    write.disarm();
    assert.equal(await c.remediate(), true);
    assert.equal(reads, 1, 'remediating a failed save must not re-read the config');
    assert.equal(c.form.mountRoot, '/srv/mnt');
    assert.equal(c.form.mountIdleTimeoutSec, 1800);
    assert.equal(c.error, null);
    assert.equal(c.dirty(), false);
    assert.equal(write.calls.length, 2);
    assert.equal(write.calls[1].mountRoot, '/srv/mnt');
});

test('the remediation button re-reads when it was the read that failed', async () => {
    const read = flaky(Errors.create('NETWORK', 'the config filesystem is not responding'));
    let writes = 0;
    const c = UI.hangarSettingsUi(stubDeps({
        config: {
            mergeGlobal: Config.mergeGlobal,
            readGlobal: () => read.fn().then(() => Config.mergeGlobal({ mountRoot: '/srv/x' })),
            writeGlobal: () => { writes++; return Promise.resolve(); }
        }
    }));
    await c.load();
    assert.equal(c.errorRemediation(), 'retry');

    read.disarm();
    assert.equal(await c.remediate(), true);
    assert.equal(c.error, null);
    assert.equal(c.form.mountRoot, '/srv/x');
    assert.equal(writes, 0, 'remediating a failed read must not write anything');
});

test('a remediation that fails again leaves the error and its action in place', async () => {
    const err = Errors.create('REPO_LOCKED', 'still locked');
    const c = UI.hangarSettingsUi(stubDeps({
        config: {
            mergeGlobal: Config.mergeGlobal,
            readGlobal: () => Promise.reject(err),
            writeGlobal: () => Promise.resolve()
        }
    }));
    await c.load();
    assert.equal(await c.remediate(), false);
    assert.equal(c.error, err);
    assert.equal(c.errorRemediation(), 'unlock');
    assert.equal(c.loading, false);
});

test('a successful save clears a previous failure and its warning', async () => {
    const write = flaky(Errors.create('NO_SPACE', 'no space'));
    const c = UI.hangarSettingsUi(stubDeps({
        config: {
            mergeGlobal: Config.mergeGlobal,
            readGlobal: () => Promise.resolve(Config.mergeGlobal({})),
            writeGlobal: write.fn
        }
    }));
    await c.load();
    c.form.mountRoot = '/srv/mnt';
    await c.save();
    assert.ok(c.error);

    write.disarm();
    c.form.mountRoot = '/srv/other';
    assert.equal(await c.save(), true);
    assert.equal(c.error, null);
    assert.equal(c.partial, null);
});

// ------------------------------------------------------- failures that hang

test('a save already in flight is not started twice', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const seen = [];
    const c = UI.hangarSettingsUi(stubDeps({
        config: {
            mergeGlobal: Config.mergeGlobal,
            readGlobal: () => Promise.resolve(Config.mergeGlobal({})),
            writeGlobal: (g) => { seen.push(g); return gate; }
        }
    }));
    await c.load();
    c.form.mountRoot = '/srv/mnt';

    const first = c.save();
    assert.equal(c.saving, true);
    assert.equal(c.canSave(), false, 'Save must be disabled while a save is running');
    assert.equal(await c.save(), false);
    release();
    assert.equal(await first, true);
    assert.equal(seen.length, 1);
    assert.equal(c.saving, false);
});

test('a throwing clock does not leave the diagnostics spinner running forever', async () => {
    const c = UI.hangarSettingsUi(stubDeps({
        now: () => { throw new Error('no clock on this host'); }
    }));
    await c.load();
    const info = await c.loadDiagnostics();
    assert.equal(c.diagLoading, false, 'Re-check would stay disabled for the life of the page');
    assert.equal(info.generatedAt, '');
    assert.match(c.report(), /generated: {12}unknown/);
});

test('a provision dependency that throws synchronously is still only a note', async () => {
    const c = UI.hangarSettingsUi(stubDeps({
        readVersion: () => { throw new Error('sync throw'); },
        provision: {
            detectFamilyLive: () => { throw new Error('sync throw'); },
            probeAll: () => { throw new Error('sync throw'); }
        }
    }));
    await c.load();
    const info = await c.loadDiagnostics();
    assert.equal(c.diagLoading, false);
    assert.equal(info.notes.length, 3);
    assert.deepEqual(info.tools, []);
    assert.equal(c.fuse().label, 'unknown');
});

test('a provision dependency missing its methods entirely is still only a note', async () => {
    const c = UI.hangarSettingsUi(stubDeps({ provision: {} }));
    await c.load();
    const info = await c.loadDiagnostics();
    assert.equal(c.diagLoading, false);
    assert.equal(info.family, 'unknown');
    assert.deepEqual(info.tools, []);
    assert.match(c.report(), /\(no tools were probed\)/);
});

test('a config dependency that is not there at all is an error, not a blank screen', async () => {
    const c = UI.hangarSettingsUi({ errors: Errors, config: {}, now: () => 'now' });
    await c.load();
    assert.equal(c.loading, false);
    assert.ok(c.error, 'the failure must be visible');
    assert.equal(c.form.mountRoot, DEFAULTS.mountRoot);
    // Saving cannot silently do nothing either.
    c.form.mountRoot = '/srv/mnt';
    assert.equal(await c.save(), false);
    assert.ok(c.error);
});

test('a clipboard that returns something other than a promise does not break copy', async () => {
    const c = UI.hangarSettingsUi(stubDeps({ clipboard: { writeText: () => undefined } }));
    await c.load();
    await c.loadDiagnostics();
    assert.equal(await c.copyReport(), true);
    assert.equal(c.copyState, 'copied');

    const throws = UI.hangarSettingsUi(stubDeps({
        clipboard: { writeText: () => { throw new Error('denied'); } }
    }));
    await throws.load();
    assert.equal(await throws.copyReport(), false);
    assert.equal(throws.copyState, 'failed');
});

test('copyReport before diagnostics have loaded still copies the honest report', async () => {
    const seen = [];
    const c = UI.hangarSettingsUi(stubDeps({
        clipboard: { writeText: (t) => { seen.push(t); return Promise.resolve(); } }
    }));
    assert.equal(await c.copyReport(), true);
    assert.match(seen[0], /^hangar diagnostics\n/);
    assert.match(seen[0], /\(no tools were probed\)/);
});

// ------------------------------------------------------------ accessibility

test('every click handler in the template is on a real button', () => {
    const tags = [...UI.TEMPLATE.matchAll(/<([a-zA-Z0-9-]+)\b([^>]*)>/g)];
    const clickable = tags.filter((m) => /@click/.test(m[2]));
    assert.ok(clickable.length >= 4, 'expected the screen to have click handlers');
    clickable.forEach((m) => {
        assert.equal(m[1], 'button', '@click is on a <' + m[1] + '>, not a <button>');
    });
    assert.doesNotMatch(UI.TEMPLATE, /<div[^>]*@click/);
    assert.doesNotMatch(UI.TEMPLATE, /<span[^>]*@click/);
    assert.doesNotMatch(UI.TEMPLATE, /<a[^>]*@click/);
});

test('every button has a type and a name a screen reader can announce', () => {
    const buttons = [...UI.TEMPLATE.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
    assert.ok(buttons.length >= 4);
    buttons.forEach((m) => {
        const attrs = m[1];
        const body = m[2].replace(/\s+/g, ' ').trim();
        assert.match(attrs, /type="(submit|button)"/, 'button with no explicit type: ' + attrs);
        const named = body !== '' || /x-text=/.test(attrs) || /aria-label/.test(attrs);
        assert.ok(named, 'button has no accessible name: ' + attrs);
    });
});

test('every input the screen owns is bound to a label', () => {
    const inputs = [...UI.TEMPLATE.matchAll(/<input\b([^>]*)>/g)].map((m) => m[1]);
    assert.ok(inputs.length >= 5, 'expected every setting to have an input');
    inputs.forEach((attrs) => {
        const id = /id="([^"]+)"/.exec(attrs);
        assert.ok(id, 'an input has no id, so no label can point at it: ' + attrs);
        assert.ok(UI.TEMPLATE.includes('for="' + id[1] + '"'), id[1] + ' has no <label for>');
    });
});

test('the plain-text report is a named region, not a label pointing at a <pre>', () => {
    // <pre> is not a labelable element: a <label for> aimed at one is announced
    // by nothing at all.
    assert.doesNotMatch(UI.TEMPLATE, /<label[^>]*for="hangar-diagnostics-report"/);
    assert.match(UI.TEMPLATE, /<pre[\s\S]*?aria-labelledby="hangar-diagnostics-report-label"/);
    assert.ok(UI.TEMPLATE.includes('id="hangar-diagnostics-report-label"'));
    assert.match(UI.TEMPLATE, /<pre[^>]*tabindex="0"/);
});

test('the failure box announces itself and the warning box does not shout', () => {
    // Nested wrapper allowed — see the note above about x-show and .d-flex.
    assert.match(UI.TEMPLATE, /x-show="error"[\s\S]{0,160}role="alert"/);
    assert.match(UI.TEMPLATE, /x-show="partial"[\s\S]{0,160}role="status"/);
});

test('nothing anywhere in this screen says Time Machine', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    // The whole shipped file, not just the template: a comment or a variable name
    // that used the old name would ship too. This test file is deliberately not
    // scanned — it can only forbid the phrase by naming it.
    const source = fs.readFileSync(
        path.join(__dirname, '../..', 'js/features/settings-ui.js'), 'utf8');
    assert.doesNotMatch(source, /time\s*machine/i);
    // The screen names the feature, and it names it Logbook.
    assert.match(UI.TEMPLATE, /Logbook/);
});

// ----------------------------------------- how often sizes are measured
//
// `restic stats` reads the whole repository, so this setting decides how often
// the Overview is allowed to spend a minute or two. Two things must hold: 0 has
// to mean "only when asked" rather than "broken", and a value that is NOT a
// number must never be mistaken for 0 — a settings file missing the key would
// otherwise pin every size on screen for ever.

test('the shipped default is a day', () => {
    assert.equal(DEFAULTS.repoSizeMaxAgeHours, 24);
    assert.equal(UI.formFromSettings({}).repoSizeMaxAgeHours, 24);
});

test('sizeAgeProblems accepts hours, including fractions and zero', () => {
    assert.deepEqual(UI.sizeAgeProblems(24), []);
    assert.deepEqual(UI.sizeAgeProblems('24'), []);
    assert.deepEqual(UI.sizeAgeProblems(0.5), [], 'half an hour is reasonable locally');
    assert.deepEqual(UI.sizeAgeProblems(UI.MIN_SIZE_AGE_HOURS), []);
    // Zero has to skip the minimum, or "only when asked" would be rejected as
    // too frequent — the one reading it cannot possibly have.
    assert.deepEqual(UI.sizeAgeProblems(0), [], 'zero is a choice, not an error');
    assert.deepEqual(UI.sizeAgeProblems(UI.MAX_SIZE_AGE_HOURS), []);
});

test('sizeAgeProblems refuses what is not a number of hours', () => {
    assert.match(UI.sizeAgeProblems('often')[0], /number of hours/);
    assert.match(UI.sizeAgeProblems('')[0], /number of hours/);
    assert.match(UI.sizeAgeProblems(null)[0], /number of hours/);
    assert.match(UI.sizeAgeProblems(undefined)[0], /number of hours/);
    assert.match(UI.sizeAgeProblems(-1)[0], /negative/);
    assert.match(UI.sizeAgeProblems(UI.MAX_SIZE_AGE_HOURS + 1)[0], /at most/);
    // A minute is not an interval for a query that takes two: it would measure
    // continuously, which is what the remembered size exists to prevent.
    assert.match(UI.sizeAgeProblems(0.01)[0], /at least 15 minutes/);
});

test('the help text explains zero rather than leaving it looking broken', () => {
    assert.match(UI.describeSizeAge(0), /only measured when you press Measure now/i);
    assert.match(UI.describeSizeAge(24), /24 hours/);
    assert.match(UI.describeSizeAge(1), /1 hour\./, 'not "1 hours"');
    assert.match(UI.describeSizeAge(0.5), /30 minutes/);
    assert.match(UI.describeSizeAge(168), /7 days/);
    assert.equal(UI.describeSizeAge('nonsense'), '', 'nothing to say about a non-number');
});

test('the form has the field, wired to the model and its problems', () => {
    assert.ok(UI.TEMPLATE.includes('form.repoSizeMaxAgeHours'),
        'the input must be bound to the form');
    assert.ok(UI.TEMPLATE.includes("problemsFor('repoSizeMaxAgeHours')"),
        'and it must show its own problems');
    assert.ok(/Measure repository sizes every \(hours\)/.test(UI.TEMPLATE),
        'and be labelled in hours, since that is what it takes');
    assert.ok(UI.TEMPLATE.includes('describeSizeAge(form.repoSizeMaxAgeHours)'),
        'with the plain-English echo beneath it');
});

test('changing the interval makes the form dirty, and saving keeps it', async () => {
    const deps = stubDeps();
    const c = UI.hangarSettingsUi(deps);
    await c.load();
    assert.equal(c.dirty(), false);
    // The input hands back a string on some paths and a number on others;
    // "24" and 24 are the same interval, and reporting unsaved changes for a
    // field nobody touched trains people to ignore the warning.
    c.form.repoSizeMaxAgeHours = DEFAULTS.repoSizeMaxAgeHours + '.0';
    assert.equal(c.dirty(), false, 'the same interval written differently is not a change');
    c.form.repoSizeMaxAgeHours = 6;
    assert.equal(c.dirty(), true);
    assert.equal(await c.save(), true);
    assert.equal(deps.written[0].repoSizeMaxAgeHours, 6);
});

test('an unparseable interval blocks the save rather than being written as zero', async () => {
    const deps = stubDeps();
    const c = UI.hangarSettingsUi(deps);
    await c.load();
    c.form.repoSizeMaxAgeHours = 'often';
    assert.equal(c.hasProblem('repoSizeMaxAgeHours'), true);
    assert.equal(await c.save(), false);
    assert.deepEqual(deps.written, []);
});
