// tests/unit/schedule.test.js — systemd unit generation and OnCalendar handling.
//
// The golden-file cases are the point of this file: the .service and .timer are
// what actually run the backups, so any drift in them must fail the build
// rather than be discovered on a host at 02:30.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const S = require('../../js/core/schedule.js');
const Errors = require('../../js/core/errors.js');

const GOLDEN = path.join(__dirname, '..', 'fixtures', 'golden');
function golden(name) { return fs.readFileSync(path.join(GOLDEN, name), 'utf8'); }

function codes(problems) { return problems.map((p) => p.detail.code).sort(); }

// The two jobs the golden files were written for.
const NIGHTLY = { id: 'nightly', name: 'Nightly documents', repo: 'attic', schedule: 'daily' };
const OFFSITE = {
    id: 'offsite',
    name: '  Off-site   mirror  ',
    repo: {
        id: 'b2-vault',
        credentials: {
            'rclone-config': '/etc/hangar/repos/b2-vault.rclone.conf',
            'b2-account-key': '/etc/hangar/repos/b2-vault.b2'
        }
    },
    timeoutSec: 21600,
    schedule: {
        calendar: ['Mon..Fri 09:00', '*-*-* 22:00'],
        randomizedDelaySec: 0,
        persistent: false,
        accuracySec: '1s'
    }
};

// ------------------------------------------------------------- unit naming

test('unitName builds the instance name', () => {
    assert.equal(S.unitName('nightly'), 'hangar-backup@nightly');
});

test('unitName accepts dots, dashes, digits and underscores', () => {
    assert.equal(S.unitName('home_2.0-daily'), 'hangar-backup@home_2.0-daily');
});

test('serviceUnit and timerUnit append the right suffixes', () => {
    assert.equal(S.serviceUnit('nightly'), 'hangar-backup@nightly.service');
    assert.equal(S.timerUnit('nightly'), 'hangar-backup@nightly.timer');
});

test('unitName rejects an empty id', () => {
    assert.throws(() => S.unitName(''), (e) => Errors.isHangarError(e) && e.kind === Errors.KIND.GENERIC);
});

test('unitName rejects a missing id', () => {
    assert.throws(() => S.unitName(undefined), (e) => e.detail[0].detail.code === 'id-required');
    assert.throws(() => S.unitName(null), (e) => e.detail[0].detail.code === 'id-required');
});

test('unitName rejects a non-string id', () => {
    assert.throws(() => S.unitName(42), (e) => e.detail[0].detail.code === 'id-required');
});

// Escaping would map '../etc/shadow' and 'etc-shadow' onto the same unit; the
// module rejects instead, so two jobs can never collide.
test('unitName rejects path traversal rather than escaping it', () => {
    assert.throws(() => S.unitName('../../etc/shadow'), (e) => e.detail[0].detail.code === 'id-charset');
});

test('unitName rejects a slash', () => {
    assert.throws(() => S.unitName('a/b'), (e) => e.detail[0].detail.code === 'id-charset');
});

test('unitName rejects an embedded @', () => {
    assert.throws(() => S.unitName('a@b'), (e) => e.detail[0].detail.code === 'id-charset');
});

test('unitName rejects whitespace and newlines', () => {
    assert.throws(() => S.unitName('two words'), (e) => e.detail[0].detail.code === 'id-charset');
    assert.throws(() => S.unitName('a\nExecStart=/bin/sh'), (e) => e.detail[0].detail.code === 'id-charset');
});

test('unitName rejects unicode', () => {
    assert.throws(() => S.unitName('gecelik-yedek-ş'), (e) => e.detail[0].detail.code === 'id-charset');
    assert.throws(() => S.unitName('снимок'), (e) => e.detail[0].detail.code === 'id-charset');
});

test('unitName rejects a leading dot or dash', () => {
    assert.throws(() => S.unitName('.hidden'), (e) => e.detail[0].detail.code === 'id-charset');
    assert.throws(() => S.unitName('-dash'), (e) => e.detail[0].detail.code === 'id-charset');
    assert.throws(() => S.unitName('..'), (e) => e.detail[0].detail.code === 'id-charset');
});

test('unitName rejects an id longer than 64 characters', () => {
    assert.throws(() => S.unitName('a'.repeat(65)), (e) => e.detail[0].detail.code === 'id-too-long');
});

test('validateId returns an empty array for a good id', () => {
    assert.deepEqual(S.validateId('nightly', 'job id'), []);
});

// --------------------------------------------------------- calendar: valid

test('validateCalendar accepts every systemd shorthand', () => {
    Object.keys(S.SHORTHAND).forEach((word) => {
        assert.deepEqual(S.validateCalendar(word), [], word);
    });
});

test('validateCalendar accepts shorthand case-insensitively and with padding', () => {
    assert.deepEqual(S.validateCalendar('Daily'), []);
    assert.deepEqual(S.validateCalendar('  HOURLY  '), []);
});

test('validateCalendar accepts a weekday range with a time', () => {
    assert.deepEqual(S.validateCalendar('Mon..Fri 09:00'), []);
});

test('validateCalendar accepts a full date-time spec', () => {
    assert.deepEqual(S.validateCalendar('*-*-* 02:30:00'), []);
});

test('validateCalendar accepts a repetition step', () => {
    assert.deepEqual(S.validateCalendar('*:0/15'), []);
    assert.deepEqual(S.validateCalendar('0/6:00'), []);
});

test('validateCalendar accepts a bare weekday and a weekday list', () => {
    assert.deepEqual(S.validateCalendar('Sat'), []);
    assert.deepEqual(S.validateCalendar('Mon,Wed,Fri 07:15'), []);
    assert.deepEqual(S.validateCalendar('Monday..Friday 07:15'), []);
});

test('validateCalendar accepts a date without a time', () => {
    assert.deepEqual(S.validateCalendar('*-*-01'), []);
    assert.deepEqual(S.validateCalendar('2027-01-01 00:00:00'), []);
});

test('validateCalendar accepts a trailing timezone', () => {
    assert.deepEqual(S.validateCalendar('Mon *-*-* 09:00 Europe/Istanbul'), []);
    assert.deepEqual(S.validateCalendar('*-*-* 03:00 UTC'), []);
});

test('validateCalendar accepts a leap second', () => {
    assert.deepEqual(S.validateCalendar('*-*-* 23:59:60'), []);
});

// ------------------------------------------------------- calendar: hostile

test('validateCalendar rejects an empty or whitespace-only expression', () => {
    assert.deepEqual(codes(S.validateCalendar('')), ['calendar-empty']);
    assert.deepEqual(codes(S.validateCalendar('   ')), ['calendar-empty']);
});

test('validateCalendar rejects non-strings', () => {
    assert.deepEqual(codes(S.validateCalendar(null)), ['calendar-type']);
    assert.deepEqual(codes(S.validateCalendar(undefined)), ['calendar-type']);
    assert.deepEqual(codes(S.validateCalendar(3)), ['calendar-type']);
    assert.deepEqual(codes(S.validateCalendar(['daily'])), ['calendar-type']);
});

// A newline here would be a second directive in the .timer file.
test('validateCalendar rejects control characters and line breaks', () => {
    assert.deepEqual(codes(S.validateCalendar('daily\nExecStart=/bin/sh')), ['calendar-control-chars']);
    assert.deepEqual(codes(S.validateCalendar('dai\u0000ly')), ['calendar-control-chars']);
});

test('validateCalendar rejects an over-long expression', () => {
    assert.deepEqual(codes(S.validateCalendar('a'.repeat(256))), ['calendar-too-long']);
});

test('validateCalendar rejects an hour above 23', () => {
    assert.deepEqual(codes(S.validateCalendar('*-*-* 25:00')), ['field-out-of-range']);
});

test('validateCalendar rejects a minute above 59', () => {
    assert.deepEqual(codes(S.validateCalendar('*-*-* 09:60')), ['field-out-of-range']);
});

test('validateCalendar rejects a second above 60', () => {
    assert.deepEqual(codes(S.validateCalendar('*-*-* 09:00:61')), ['field-out-of-range']);
});

test('validateCalendar rejects a month above 12 and a day above 31', () => {
    assert.deepEqual(codes(S.validateCalendar('*-13-01 00:00')), ['field-out-of-range']);
    assert.deepEqual(codes(S.validateCalendar('*-*-32 00:00')), ['field-out-of-range']);
});

test('validateCalendar rejects a year outside the supported window', () => {
    assert.deepEqual(codes(S.validateCalendar('1969-01-01 00:00')), ['field-out-of-range']);
});

test('validateCalendar rejects an unknown weekday', () => {
    assert.deepEqual(codes(S.validateCalendar('Frunsday 09:00')), ['calendar-weekday']);
    assert.deepEqual(codes(S.validateCalendar('Mon..Zzz 09:00')), ['calendar-weekday']);
});

test('validateCalendar rejects a backwards range', () => {
    assert.deepEqual(codes(S.validateCalendar('*-*-* 18..09:00')), ['field-range-backwards']);
});

test('validateCalendar rejects a zero or non-numeric repetition step', () => {
    assert.deepEqual(codes(S.validateCalendar('*:0/0')), ['field-step']);
    assert.deepEqual(codes(S.validateCalendar('*:0/x')), ['field-step']);
    assert.deepEqual(codes(S.validateCalendar('*:0/1/2')), ['field-step']);
});

test('validateCalendar rejects a malformed time', () => {
    assert.deepEqual(codes(S.validateCalendar('*-*-* 09:00:00:00')), ['calendar-time-shape']);
});

// A truncated time must not be blamed on the timezone slot, or the user goes
// looking in the wrong place.
test('validateCalendar reports a truncated time as trailing junk, not a bad timezone', () => {
    assert.deepEqual(codes(S.validateCalendar('*-*-* 09')), ['calendar-trailing']);
});

test('validateCalendar rejects a malformed date', () => {
    assert.deepEqual(codes(S.validateCalendar('2027-01-01-01 00:00')), ['calendar-date-shape']);
});

test('validateCalendar rejects an empty list entry', () => {
    assert.deepEqual(codes(S.validateCalendar('*-*-* 09,:00')), ['field-empty']);
});

test('validateCalendar rejects free text', () => {
    assert.deepEqual(codes(S.validateCalendar('@reboot')), ['calendar-unrecognised']);
    assert.deepEqual(codes(S.validateCalendar('whenever')), ['calendar-weekday']);
    // 'every' lands in the weekday slot and 'please' past the timezone slot;
    // what matters is that nothing about this is accepted.
    assert.deepEqual(codes(S.validateCalendar('every night please')),
        ['calendar-trailing', 'calendar-weekday']);
});

test('validateCalendar rejects trailing junk after the timezone slot', () => {
    assert.deepEqual(codes(S.validateCalendar('Mon *-*-* 09:00 UTC extra')), ['calendar-trailing']);
});

test('validateCalendar rejects a malformed timezone', () => {
    assert.deepEqual(codes(S.validateCalendar('*-*-* 09:00 Europe//Istanbul')), ['calendar-timezone']);
});

// Documented limitation, asserted so it cannot regress silently: systemd's '~'
// last-day-of-month form is valid systemd but is not accepted here.
test('validateCalendar rejects the ~ last-day-of-month form by design', () => {
    assert.ok(S.validateCalendar('*-02~03 12:00').length > 0);
});

test('validateCalendar problems are HangarErrors', () => {
    const problems = S.validateCalendar('*-*-* 25:00');
    assert.ok(Errors.isHangarError(problems[0]));
    assert.equal(problems[0].kind, Errors.KIND.GENERIC);
});

// ------------------------------------------------------------- description

test('describeSchedule renders each shorthand', () => {
    assert.equal(S.describeSchedule('daily'), 'Every day at midnight.');
    assert.equal(S.describeSchedule('hourly'), 'Every hour, on the hour.');
    assert.equal(S.describeSchedule('WEEKLY'), 'Every Monday at midnight.');
});

test('describeSchedule renders a weekday range with a time', () => {
    assert.equal(S.describeSchedule('Mon..Fri 09:00'), 'Monday to Friday at 09:00.');
});

test('describeSchedule renders a weekday list', () => {
    assert.equal(S.describeSchedule('Mon,Wed,Fri 07:15'), 'Monday, Wednesday and Friday at 07:15.');
});

test('describeSchedule renders a wildcard date', () => {
    assert.equal(S.describeSchedule('*-*-* 02:30:00'), 'Every day at 02:30.');
});

test('describeSchedule keeps non-zero seconds', () => {
    assert.equal(S.describeSchedule('*-*-* 02:30:15'), 'Every day at 02:30:15.');
});

test('describeSchedule renders repetition steps as intervals', () => {
    assert.equal(S.describeSchedule('*:0/15'), 'Every day, every 15 minutes.');
    assert.equal(S.describeSchedule('0/6:00'), 'Every day, every 6 hours.');
});

test('describeSchedule renders a day of the month and a fixed date', () => {
    assert.equal(S.describeSchedule('*-*-01'), 'On day 1 of every month at midnight.');
    assert.equal(S.describeSchedule('*-12-25 06:00'), 'On 25 December every year at 06:00.');
});

test('describeSchedule names the implied midnight when no time is given', () => {
    assert.equal(S.describeSchedule('Sat'), 'Saturday at midnight.');
});

test('describeSchedule appends the timezone', () => {
    assert.equal(S.describeSchedule('Mon *-*-* 09:00 Europe/Istanbul'),
        'Monday at 09:00 (Europe/Istanbul).');
});

test('describeSchedule joins an array of expressions', () => {
    assert.equal(S.describeSchedule(['daily', 'Mon..Fri 09:00']),
        'Every day at midnight. Monday to Friday at 09:00.');
});

test('describeSchedule never throws on hostile input', () => {
    assert.equal(S.describeSchedule(''), 'Not a valid schedule.');
    assert.equal(S.describeSchedule(null), 'Not a valid schedule.');
    assert.equal(S.describeSchedule('*-*-* 25:00'), 'Not a valid schedule.');
    assert.equal(S.describeSchedule('every night please'), 'Not a valid schedule.');
});

// ------------------------------------------------------------- credentials

test('keyPath points at the 0600 key beside the repo definition', () => {
    assert.equal(S.keyPath('attic'), '/etc/hangar/repos/attic.key');
});

test('credentialLines accepts a bare repo id', () => {
    assert.deepEqual(S.credentialLines('attic'),
        ['LoadCredential=hangar-repo-attic:/etc/hangar/repos/attic.key']);
});

// Insertion order must not reach the unit file, or the golden test would be a
// coin toss.
test('credentialLines emits the password first, then extras sorted', () => {
    const a = S.credentialLines({ id: 'r', credentials: { zeta: '/etc/z', alpha: '/etc/a' } });
    const b = S.credentialLines({ id: 'r', credentials: { alpha: '/etc/a', zeta: '/etc/z' } });
    assert.deepEqual(a, [
        'LoadCredential=hangar-repo-r:/etc/hangar/repos/r.key',
        'LoadCredential=alpha:/etc/a',
        'LoadCredential=zeta:/etc/z'
    ]);
    assert.deepEqual(a, b);
});

test('credentialLines rejects a credential id containing the LoadCredential separator', () => {
    assert.throws(() => S.credentialLines({ id: 'r', credentials: { 'a:b': '/etc/a' } }),
        (e) => codes(e.detail).includes('credential-id'));
});

test('credentialLines rejects a relative credential path', () => {
    assert.throws(() => S.credentialLines({ id: 'r', credentials: { a: 'etc/a' } }),
        (e) => codes(e.detail).includes('credential-path'));
});

test('credentialLines rejects a credential path with a colon or newline', () => {
    assert.throws(() => S.credentialLines({ id: 'r', credentials: { a: '/etc/a:b' } }),
        (e) => codes(e.detail).includes('credential-path'));
    assert.throws(() => S.credentialLines({ id: 'r', credentials: { a: '/etc/a\nb' } }),
        (e) => codes(e.detail).includes('credential-path'));
});

test('credentialLines rejects a repo with no id', () => {
    assert.throws(() => S.credentialLines(undefined), (e) => codes(e.detail).includes('repo-required'));
    assert.throws(() => S.credentialLines({}), (e) => codes(e.detail).includes('id-required'));
});

// ----------------------------------------------------------- job validation

test('validateJob accepts the golden jobs', () => {
    assert.deepEqual(S.validateJob(NIGHTLY), []);
    assert.deepEqual(S.validateJob(OFFSITE), []);
});

test('validateJob rejects a non-object', () => {
    assert.deepEqual(codes(S.validateJob(null)), ['job-shape']);
    assert.deepEqual(codes(S.validateJob([])), ['job-shape']);
});

test('validateJob reports a missing repository', () => {
    assert.deepEqual(codes(S.validateJob({ id: 'j', schedule: 'daily' })), ['repo-required']);
});

test('validateJob reports a bad randomized delay', () => {
    assert.deepEqual(codes(S.validateJob({ id: 'j', repo: 'r', schedule: { calendar: 'daily', randomizedDelaySec: -1 } })),
        ['randomized-delay']);
    assert.deepEqual(codes(S.validateJob({ id: 'j', repo: 'r', schedule: { calendar: 'daily', randomizedDelaySec: '5m' } })),
        ['randomized-delay']);
});

test('validateJob reports a bad timeout and a bad accuracy', () => {
    assert.deepEqual(codes(S.validateJob({ id: 'j', repo: 'r', timeoutSec: 0, schedule: 'daily' })), ['timeout']);
    assert.deepEqual(codes(S.validateJob({ id: 'j', repo: 'r', schedule: { calendar: 'daily', accuracySec: 'soon' } })),
        ['accuracy']);
});

test('validateJob reports a non-string job name', () => {
    assert.deepEqual(codes(S.validateJob({ id: 'j', repo: 'r', name: 7, schedule: 'daily' })), ['name-type']);
});

test('validateJob surfaces calendar problems from every OnCalendar entry', () => {
    assert.deepEqual(codes(S.validateJob({ id: 'j', repo: 'r', schedule: { calendar: ['daily', '25:00', ''] } })),
        ['calendar-empty', 'field-out-of-range']);
});

test('calendarsOf normalises the string, array and missing forms', () => {
    assert.deepEqual(S.calendarsOf({ schedule: 'daily' }), ['daily']);
    assert.deepEqual(S.calendarsOf({ schedule: { calendar: ['a', 'b'] } }), ['a', 'b']);
    assert.deepEqual(S.calendarsOf({}), []);
    assert.deepEqual(S.calendarsOf(null), []);
});

// ----------------------------------------------------------------- goldens

test('renderService matches the golden unit for a simple job', () => {
    assert.equal(S.renderService(NIGHTLY), golden('hangar-backup@nightly.service'));
});

test('renderTimer matches the golden unit for a simple job', () => {
    assert.equal(S.renderTimer(NIGHTLY), golden('hangar-backup@nightly.timer'));
});

test('renderService matches the golden unit for extra credentials and a timeout', () => {
    assert.equal(S.renderService(OFFSITE), golden('hangar-backup@offsite.service'));
});

test('renderTimer matches the golden unit for multiple calendars and Persistent=false', () => {
    assert.equal(S.renderTimer(OFFSITE), golden('hangar-backup@offsite.timer'));
});

test('rendering is deterministic across calls', () => {
    assert.equal(S.renderService(OFFSITE), S.renderService(OFFSITE));
    assert.equal(S.renderTimer(OFFSITE), S.renderTimer(OFFSITE));
});

// ---------------------------------------------------------------- renderers

test('renderService always carries the restic partial-success exit code', () => {
    assert.ok(S.renderService(NIGHTLY).includes('\nSuccessExitStatus=3\n'));
});

// Type=oneshot inherits DefaultTimeoutStartSec, which would kill a long backup.
test('renderService defaults TimeoutStartSec to infinity', () => {
    assert.ok(S.renderService(NIGHTLY).includes('\nTimeoutStartSec=infinity\n'));
});

test('renderService uses %i so the file matches the shipped template', () => {
    assert.ok(S.renderService(NIGHTLY).includes('ExecStart=/usr/libexec/hangar/hangar-run %i'));
});

// These three would silently give the backup a different view of the
// filesystem than the one the user chose, so they must never appear as
// directives — only in the comment explaining their absence.
test('renderService omits PrivateTmp, ProtectHome and ProtectSystem', () => {
    const directives = S.renderService(NIGHTLY).split('\n').filter((l) => l.charAt(0) !== '#');
    ['PrivateTmp', 'ProtectHome', 'ProtectSystem'].forEach((d) => {
        assert.equal(directives.filter((l) => l.indexOf(d + '=') === 0).length, 0, d);
    });
    assert.ok(directives.includes('NoNewPrivileges=yes'));
});

test('renderTimer sets Persistent=true by default so a missed run still fires', () => {
    assert.ok(S.renderTimer(NIGHTLY).includes('\nPersistent=true\n'));
});

test('renderTimer installs into timers.target', () => {
    assert.ok(S.renderTimer(NIGHTLY).endsWith('[Install]\nWantedBy=timers.target\n'));
});

test('renderTimer names the matching service explicitly', () => {
    assert.ok(S.renderTimer(NIGHTLY).includes('\nUnit=hangar-backup@nightly.service\n'));
});

test('renderService falls back to the job id when there is no name', () => {
    const out = S.renderService({ id: 'plain', repo: 'attic', schedule: 'daily' });
    assert.ok(out.includes('Description=hangar backup: plain\n'));
});

// A name is user input that lands in a unit file; a newline in it would be a
// new directive.
test('renderers flatten a job name that tries to inject a directive', () => {
    const job = { id: 'evil', name: 'Docs\nExecStart=/bin/rm -rf /', repo: 'attic', schedule: 'daily' };
    const service = S.renderService(job);
    const timer = S.renderTimer(job);
    assert.ok(service.includes('Description=hangar backup: Docs ExecStart=/bin/rm -rf /\n'));
    assert.equal(service.split('\n').filter((l) => l.indexOf('ExecStart=') === 0).length, 1);
    assert.equal(timer.split('\n').filter((l) => l.indexOf('ExecStart=') === 0).length, 0);
});

test('sanitizeText collapses whitespace, drops control characters and caps length', () => {
    assert.equal(S.sanitizeText('  a \t b \r\n c  ', 'x'), 'a b c');
    assert.equal(S.sanitizeText('', 'fallback'), 'fallback');
    assert.equal(S.sanitizeText(undefined, 'fallback'), 'fallback');
    assert.equal(S.sanitizeText('z'.repeat(300), 'x').length, 160);
});

test('renderService throws a typed error listing every problem', () => {
    assert.throws(() => S.renderService({ id: '', repo: '' }), (e) => {
        assert.ok(Errors.isHangarError(e));
        assert.equal(e.kind, Errors.KIND.GENERIC);
        assert.deepEqual(codes(e.detail), ['id-required', 'id-required']);
        return true;
    });
});

test('renderTimer refuses a job with no OnCalendar expression', () => {
    assert.throws(() => S.renderTimer({ id: 'j', repo: 'r' }),
        (e) => codes(e.detail).includes('calendar-required'));
});

test('renderTimer refuses an invalid calendar rather than writing it out', () => {
    assert.throws(() => S.renderTimer({ id: 'j', repo: 'r', schedule: '*-*-* 25:00' }),
        (e) => codes(e.detail).includes('field-out-of-range'));
});

// ------------------------------------------------------ D-Bus pure helpers

test('unwrapProps unwraps cockpit variant values', () => {
    assert.deepEqual(S.unwrapProps({ ActiveState: { t: 's', v: 'active' }, Result: { t: 's', v: 'success' } }),
        { ActiveState: 'active', Result: 'success' });
});

test('unwrapProps passes plain values and arrays through', () => {
    assert.deepEqual(S.unwrapProps({ A: 'x', B: [1, 2] }), { A: 'x', B: [1, 2] });
});

test('unwrapProps tolerates junk', () => {
    assert.deepEqual(S.unwrapProps(null), {});
    assert.deepEqual(S.unwrapProps(undefined), {});
    assert.deepEqual(S.unwrapProps('nonsense'), {});
});

test('usecToMillis converts microseconds and collapses both spellings of never', () => {
    assert.equal(S.usecToMillis(1754000000000000), 1754000000000);
    assert.equal(S.usecToMillis(0), null);
    assert.equal(S.usecToMillis('18446744073709551615'), null);
    assert.equal(S.usecToMillis(null), null);
    assert.equal(S.usecToMillis(undefined), null);
    assert.equal(S.usecToMillis('not a number'), null);
});

test('normalizeUnitState reports an enabled, waiting timer', () => {
    const state = S.normalizeUnitState(
        { LoadState: 'loaded', ActiveState: 'active', SubState: 'waiting', UnitFileState: 'enabled', Result: 'success' },
        { NextElapseUSecRealtime: 1754000000000000, LastTriggerUSec: 1753000000000000 }
    );
    assert.equal(state.enabled, true);
    assert.equal(state.active, true);
    assert.equal(state.failed, false);
    assert.equal(state.nextElapseMs, 1754000000000);
    assert.equal(state.lastTriggerMs, 1753000000000);
});

test('normalizeUnitState reports a failed run', () => {
    const state = S.normalizeUnitState({ ActiveState: 'failed', Result: 'exit-code', UnitFileState: 'disabled' }, {});
    assert.equal(state.failed, true);
    assert.equal(state.enabled, false);
    assert.equal(state.result, 'exit-code');
});

test('normalizeUnitState defaults a unit that does not exist yet', () => {
    const state = S.normalizeUnitState(undefined, undefined);
    assert.deepEqual(state, {
        loadState: 'not-found',
        activeState: 'inactive',
        subState: 'dead',
        unitFileState: 'unknown',
        enabled: false,
        active: false,
        failed: false,
        result: null,
        nextElapseMs: null,
        lastTriggerMs: null
    });
});

test('normalizeUnitState treats a static unit as enabled', () => {
    assert.equal(S.normalizeUnitState({ UnitFileState: 'static' }, {}).enabled, true);
    assert.equal(S.normalizeUnitState({ UnitFileState: 'enabled-runtime' }, {}).enabled, true);
});

// ---------------------------------------------------------- I/O under node

test('available() is false when cockpit is absent', () => {
    assert.equal(S.available(), false);
});

test('every I/O helper rejects with a typed error instead of throwing at load', async () => {
    const calls = [S.unitState('nightly'), S.enable('nightly'), S.disable('nightly'),
        S.start('nightly'), S.stop('nightly'), S.runNow('nightly'), S.daemonReload()];
    for (const p of calls) {
        await assert.rejects(p, (e) => Errors.isHangarError(e) && e.detail.code === 'no-dbus');
    }
});

// Structural guard: every cockpit reference must live in available()/bus(), so
// that adding a new call cannot quietly bypass the availability check.
test('the module has no ES module syntax and confines cockpit to the guarded layer', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'core', 'schedule.js'), 'utf8');
    assert.equal(/^\s*(import|export)\s/m.test(src), false);
    const lines = src.split('\n').filter((l) => l.indexOf('cockpit') >= 0 && l.trim().indexOf('//') !== 0);
    assert.deepEqual(lines.map((l) => l.trim()), [
        "return typeof cockpit !== 'undefined' && !!cockpit && typeof cockpit.dbus === 'function';",
        "return available() ? cockpit.dbus(SYSTEMD, { superuser: 'require' }) : null;"
    ]);
});

test('I/O helpers reject an invalid job id before touching D-Bus', async () => {
    await assert.rejects(S.unitState('../evil'), (e) => codes(e.detail).includes('id-charset'));
    await assert.rejects(S.enable(''), (e) => codes(e.detail).includes('id-required'));
    await assert.rejects(S.runNow(null), (e) => codes(e.detail).includes('id-required'));
});

// ============================================================================
// Adversarial pass. Everything below attacks the module rather than describing
// it: boundaries, unreached branches, and input that arrives from a config file
// or a text box rather than from the UI's own widgets.
// ============================================================================

// Control bytes are written as escapes so this file stays plain ASCII — a raw
// NUL in a test source is invisible in review.
const NUL = '\u0000';
const DEL = '\u007f';

// The single invariant that makes unit generation safe: no user-controlled text
// can produce a line that systemd reads as anything other than the directive we
// intended. Anything that is not blank, a comment or a section header must be
// KEY=VALUE.
function nonConformingLines(unit) {
    return unit.split('\n').filter((l) =>
        l !== '' && l.charAt(0) !== '#' && !/^\[[A-Za-z]+\]$/.test(l) && !/^[A-Za-z][A-Za-z0-9]*=/.test(l));
}

// ------------------------------------------------- identifiers: adversarial

test('unitName rejects shell metacharacters', () => {
    ['$(id)', '`id`', 'a;rm -rf /', 'a|b', 'a&b', 'a>b', "a'b", 'a"b', 'a*b', 'a$b'].forEach((id) => {
        assert.throws(() => S.unitName(id), (e) => e.detail[0].detail.code === 'id-charset', id);
    });
});

// A '%' in an instance name would be read by systemd as a specifier, so '%n' in
// a job id could expand inside ExecStart. It has to be rejected, not passed on.
test('unitName rejects systemd specifiers and colons', () => {
    ['%i', '%n', 'a%b', 'a:b', 'a b'].forEach((id) => {
        assert.throws(() => S.unitName(id), (e) => e.detail[0].detail.code === 'id-charset', id);
    });
});

test('unitName rejects a NUL byte or DEL in the id', () => {
    assert.throws(() => S.unitName('a' + NUL + 'b'), (e) => e.detail[0].detail.code === 'id-charset');
    assert.throws(() => S.unitName('a' + DEL), (e) => e.detail[0].detail.code === 'id-charset');
});

test('unitName rejects a leading underscore, so __proto__ is not an id', () => {
    assert.throws(() => S.unitName('__proto__'), (e) => e.detail[0].detail.code === 'id-charset');
    assert.throws(() => S.unitName('_x'), (e) => e.detail[0].detail.code === 'id-charset');
});

test('unitName accepts the length boundary and rejects one past it', () => {
    assert.equal(S.unitName('a'.repeat(64)), 'hangar-backup@' + 'a'.repeat(64));
    assert.throws(() => S.unitName('a'.repeat(65)), (e) => e.detail[0].detail.code === 'id-too-long');
});

test('unitName accepts a one-character id', () => {
    assert.equal(S.unitName('a'), 'hangar-backup@a');
    assert.equal(S.unitName('0'), 'hangar-backup@0');
});

test('validateId reports length and charset together rather than stopping at the first', () => {
    assert.deepEqual(codes(S.validateId('!'.repeat(70), 'job id')), ['id-charset', 'id-too-long']);
});

test('validateId rejects every non-string type as missing', () => {
    [true, false, [], {}, 0, 1.5, NaN, () => 1].forEach((v) => {
        assert.deepEqual(codes(S.validateId(v, 'job id')), ['id-required'], String(v));
    });
});

test('serviceUnit and timerUnit validate too, not just unitName', () => {
    assert.throws(() => S.serviceUnit('../evil'), (e) => e.detail[0].detail.code === 'id-charset');
    assert.throws(() => S.timerUnit('a/b'), (e) => e.detail[0].detail.code === 'id-charset');
    assert.throws(() => S.serviceUnit(''), (e) => e.detail[0].detail.code === 'id-required');
});

// -------------------------------------------------- calendar: field bounds

test('validateCalendar accepts the extreme legal values of every field', () => {
    assert.deepEqual(S.validateCalendar('*-*-* 00:00:00'), []);
    assert.deepEqual(S.validateCalendar('*-*-* 23:59:60'), []);
    assert.deepEqual(S.validateCalendar('1970-01-01 00:00'), []);
    assert.deepEqual(S.validateCalendar('2199-12-31 23:59'), []);
});

test('validateCalendar rejects one past the top of every field', () => {
    [['*-*-* 24:00', 'hour'], ['*-*-* 00:60', 'minute'], ['*-*-* 00:00:61', 'second'],
        ['2200-01-01 00:00', 'year'], ['*-13-01 00:00', 'month'], ['*-01-32 00:00', 'day']]
        .forEach((c) => { assert.deepEqual(codes(S.validateCalendar(c[0])), ['field-out-of-range'], c[1]); });
});

test('validateCalendar rejects zero where the field is one-based', () => {
    assert.deepEqual(codes(S.validateCalendar('*-0-1 00:00')), ['field-out-of-range']);
    assert.deepEqual(codes(S.validateCalendar('*-1-0 00:00')), ['field-out-of-range']);
});

test('validateCalendar rejects a range with more than two endpoints', () => {
    assert.deepEqual(codes(S.validateCalendar('*-*-* 1..2..3:00')), ['field-range']);
});

test('validateCalendar rejects a non-numeric field', () => {
    assert.deepEqual(codes(S.validateCalendar('*-*-* a:00')), ['field-not-number']);
    assert.deepEqual(codes(S.validateCalendar('*-*-*:00')), ['field-not-number']);
});

// Number('٠٩') is NaN, but the guard is a character class, so this must be
// rejected structurally rather than sneak through as a number.
test('validateCalendar rejects non-ASCII digits', () => {
    assert.deepEqual(codes(S.validateCalendar('\u0660\u0669:\u0660\u0660')),
        ['field-not-number', 'field-not-number']);
});

test('validateCalendar accepts a step on a date field', () => {
    assert.deepEqual(S.validateCalendar('*-*-1/2 03:00'), []);
    assert.deepEqual(S.validateCalendar('*-1/3-01 03:00'), []);
});

test('validateCalendar rejects a numeric field far beyond 2^53 without crashing', () => {
    assert.deepEqual(codes(S.validateCalendar('9'.repeat(40) + ':00')), ['field-out-of-range']);
});

// --------------------------------------------- calendar: hostile, part two

test('validateCalendar rejects a NUL byte and DEL anywhere in the expression', () => {
    assert.deepEqual(codes(S.validateCalendar('*-*-* 09:00' + NUL)), ['calendar-control-chars']);
    assert.deepEqual(codes(S.validateCalendar('daily' + DEL)), ['calendar-control-chars']);
    assert.deepEqual(codes(S.validateCalendar('*-*-*\t09:00')), ['calendar-control-chars']);
});

// Control characters are checked before length: a 300-character injection
// attempt must be reported as an injection attempt, not as "too long".
test('validateCalendar reports control characters ahead of length', () => {
    assert.deepEqual(codes(S.validateCalendar('a'.repeat(300) + '\nExecStart=/bin/sh')),
        ['calendar-control-chars']);
});

test('validateCalendar treats 255 characters as the length boundary', () => {
    assert.deepEqual(codes(S.validateCalendar('a'.repeat(255))), ['calendar-unrecognised']);
    assert.deepEqual(codes(S.validateCalendar('a'.repeat(256))), ['calendar-too-long']);
});

test('validateCalendar rejects a timezone that is a path traversal', () => {
    assert.deepEqual(codes(S.validateCalendar('*-*-* 09:00 Europe/../../etc/shadow')),
        ['calendar-timezone']);
    assert.deepEqual(codes(S.validateCalendar('*-*-* 09:00 ../Istanbul')), ['calendar-timezone']);
});

test('validateCalendar accepts the POSIX-style Etc zones', () => {
    assert.deepEqual(S.validateCalendar('*-*-* 09:00 Etc/GMT+3'), []);
    assert.deepEqual(S.validateCalendar('*-*-* 09:00 America/Argentina/Buenos_Aires'), []);
});

test('validateCalendar rejects a mangled weekday list as unrecognised', () => {
    ['Mon,,Fri 09:00', 'Mon..', '..Fri'].forEach((c) => {
        assert.deepEqual(codes(S.validateCalendar(c)), ['calendar-unrecognised'], c);
    });
});

test('validateCalendar rejects a bare separator', () => {
    ['-', '..', ':::', '*/*'].forEach((c) => { assert.ok(S.validateCalendar(c).length > 0, c); });
});

test('every calendar problem is a typed GENERIC HangarError with a code', () => {
    ['', null, 'a'.repeat(300), '*-*-* 25:00', '@reboot', '*-*-* 09:00 Europe//Istanbul']
        .forEach((c) => {
            S.validateCalendar(c).forEach((p) => {
                assert.ok(Errors.isHangarError(p), String(c));
                assert.equal(p.kind, Errors.KIND.GENERIC);
                assert.equal(typeof p.detail.code, 'string');
            });
        });
});

// -------------------------------------------------- description: hostile

test('describeSchedule returns a sentence for every shorthand, in any case', () => {
    Object.keys(S.SHORTHAND).forEach((word) => {
        [word, word.toUpperCase(), '  ' + word + '  '].forEach((v) => {
            const out = S.describeSchedule(v);
            assert.equal(typeof out, 'string');
            assert.notEqual(out, 'Not a valid schedule.', v);
            assert.ok(out.endsWith('.'), v);
        });
    });
});

// The shorthand lookup is a plain property read, so a job whose schedule is
// "constructor" must not walk into Object.prototype and return a function.
test('describeSchedule never returns a value inherited from Object.prototype', () => {
    ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__proto__']
        .forEach((k) => {
            assert.equal(S.describeSchedule(k), 'Not a valid schedule.', k);
        });
});

test('describeSchedule returns a string for any hostile input at all', () => {
    [null, undefined, 0, 1, true, false, {}, [], [[]], NaN, Infinity, () => 1, /re/, new Date(),
        '', ' ', NUL, 'x'.repeat(5000), '\u{1F600}', 'a\nb', '$(id)', '../../etc/shadow']
        .forEach((v) => {
            assert.equal(typeof S.describeSchedule(v), 'string', String(v));
        });
});

test('describeSchedule renders the remaining time shapes', () => {
    assert.equal(S.describeSchedule('*:*'), 'Every day, every minute.');
    assert.equal(S.describeSchedule('*:5'), 'Every day at 5 minutes past every hour.');
    assert.equal(S.describeSchedule('12:00'), 'Every day at 12:00.');
    assert.equal(S.describeSchedule('Mon,Tue'), 'Monday and Tuesday at midnight.');
    assert.equal(S.describeSchedule('*-2-3'), 'On 3 February every year at midnight.');
});

// Anything the describer cannot phrase must still be shown verbatim rather than
// silently dropped, or the user cannot tell what they actually scheduled.
test('describeSchedule falls back to the raw expression it cannot phrase', () => {
    assert.equal(S.describeSchedule('*-*-* 09..17:00'), 'Every day at 09..17:00.');
    assert.equal(S.describeSchedule('*-*-1/2 03:00'), 'On *-*-1/2 at 03:00.');
    assert.equal(S.describeSchedule('2027-01-01'), 'On 2027-01-01 at midnight.');
});

test('describeSchedule marks only the invalid member of an array', () => {
    assert.equal(S.describeSchedule(['daily', 'nope']), 'Every day at midnight. Not a valid schedule.');
    assert.equal(typeof S.describeSchedule([]), 'string');
});

// ------------------------------------------------ credentials: adversarial

test('credentialLines rejects a credential id with a path separator or space', () => {
    ['a/b', 'a b', '../x', 'a' + NUL, '\u015f', '.hidden', '_x', ''].forEach((id) => {
        const creds = {};
        creds[id] = '/etc/a';
        assert.throws(() => S.credentialLines({ id: 'r', credentials: creds }),
            (e) => codes(e.detail).includes('credential-id'), id);
    });
});

test('credentialLines rejects a credential id longer than 64 characters', () => {
    const creds = {};
    creds['a'.repeat(65)] = '/etc/a';
    assert.throws(() => S.credentialLines({ id: 'r', credentials: creds }),
        (e) => codes(e.detail).includes('credential-id'));
});

test('credentialLines rejects a non-string credential path', () => {
    [42, null, undefined, [], {}, true].forEach((p) => {
        assert.throws(() => S.credentialLines({ id: 'r', credentials: { a: p } }),
            (e) => codes(e.detail).includes('credential-path'), String(p));
    });
});

test('credentialLines rejects a credential path containing a NUL byte', () => {
    assert.throws(() => S.credentialLines({ id: 'r', credentials: { a: '/etc/a' + NUL + 'b' } }),
        (e) => codes(e.detail).includes('credential-path'));
});

// A space is legal in a systemd directive value, so this one is accepted; the
// test exists so nobody "fixes" it into a rejection by accident.
test('credentialLines accepts a credential path containing a space', () => {
    assert.deepEqual(S.credentialLines({ id: 'r', credentials: { a: '/etc/a b' } }),
        ['LoadCredential=hangar-repo-r:/etc/hangar/repos/r.key', 'LoadCredential=a:/etc/a b']);
});

test('credentialLines rejects a repo id that would escape the repo directory', () => {
    ['../../etc/shadow', 'a/b', '.', '..'].forEach((id) => {
        assert.throws(() => S.credentialLines(id), (e) => codes(e.detail).includes('id-charset'), id);
    });
});

test('credentialLines never emits a key path outside the repo directory', () => {
    assert.equal(S.credentialLines('attic')[0], 'LoadCredential=' + S.passwordCredentialName('attic') + ':' + S.keyPath('attic'));
    assert.ok(S.credentialLines('attic')[0].indexOf('..') < 0);
});

test('credentialLines rejects a repo that is not a string or object', () => {
    [42, [], true, null].forEach((r) => {
        assert.throws(() => S.credentialLines(r), (e) => Errors.isHangarError(e), String(r));
    });
});

// A config file is JSON, and JSON.parse produces a real own "__proto__" key.
test('credentialLines rejects a __proto__ credential id without polluting anything', () => {
    const repo = { id: 'r', credentials: JSON.parse('{"__proto__":"/etc/a"}') };
    assert.throws(() => S.credentialLines(repo), (e) => codes(e.detail).includes('credential-id'));
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal({}.a, undefined);
});

// ------------------------------------------------ job validation: hostile

test('validateJob reports every independent problem in one pass', () => {
    const job = {
        id: '',
        repo: { id: '../x', credentials: { 'a:b': 'relative' } },
        name: 7,
        timeoutSec: -1,
        schedule: { calendar: ['25:00'], randomizedDelaySec: 1.5, accuracySec: 'nope' }
    };
    assert.deepEqual(codes(S.validateJob(job)), [
        'accuracy', 'credential-id', 'credential-path', 'field-out-of-range',
        'id-charset', 'id-required', 'name-type', 'randomized-delay', 'timeout'
    ]);
});

test('validateJob rejects a timeout that is not a whole positive number', () => {
    [-1, 0, 1.5, NaN, Infinity, -Infinity, '3600', '6h', true, [], {}].forEach((v) => {
        assert.deepEqual(codes(S.validateJob({ id: 'j', repo: 'r', timeoutSec: v, schedule: 'daily' })),
            ['timeout'], String(v));
    });
});

// Number.isInteger(1e21) is true but String(1e21) is "1e+21", which systemd
// cannot parse — a validator must not accept what the renderer cannot express.
test('validateJob rejects an integer too large to render in decimal', () => {
    assert.deepEqual(codes(S.validateJob({ id: 'j', repo: 'r', timeoutSec: 1e21, schedule: 'daily' })),
        ['timeout']);
    assert.deepEqual(codes(S.validateJob({
        id: 'j', repo: 'r', schedule: { calendar: 'daily', randomizedDelaySec: 1e21 }
    })), ['randomized-delay']);
});

test('validateJob accepts the largest renderable timeout', () => {
    assert.deepEqual(S.validateJob({
        id: 'j', repo: 'r', timeoutSec: Number.MAX_SAFE_INTEGER, schedule: 'daily'
    }), []);
    assert.ok(S.renderService({ id: 'j', repo: 'r', timeoutSec: Number.MAX_SAFE_INTEGER, schedule: 'daily' })
        .includes('\nTimeoutStartSec=9007199254740991\n'));
});

test('validateJob accepts an explicit infinity timeout and a zero delay', () => {
    assert.deepEqual(S.validateJob({
        id: 'j', repo: 'r', timeoutSec: 'infinity',
        schedule: { calendar: 'daily', randomizedDelaySec: 0 }
    }), []);
});

test('validateJob rejects a delay that is not a whole non-negative number', () => {
    [-1, 1.5, NaN, Infinity, '0', true, [], {}].forEach((v) => {
        assert.deepEqual(codes(S.validateJob({
            id: 'j', repo: 'r', schedule: { calendar: 'daily', randomizedDelaySec: v }
        })), ['randomized-delay'], String(v));
    });
});

test('validateJob accepts every systemd duration spelling for accuracy', () => {
    ['1us', '1ms', '1s', '1sec', '1m', '1min', '1h', '1d', '1w', '30', '1h30min', '1h30']
        .forEach((v) => {
            assert.deepEqual(S.validateJob({
                id: 'j', repo: 'r', schedule: { calendar: 'daily', accuracySec: v }
            }), [], v);
        });
});

test('validateJob rejects a non-duration accuracy', () => {
    ['', ' ', '1x', 'infinity', 'soon', '1 min', '-1s', 'm1', 5, true]
        .forEach((v) => {
            assert.deepEqual(codes(S.validateJob({
                id: 'j', repo: 'r', schedule: { calendar: 'daily', accuracySec: v }
            })), ['accuracy'], String(v));
        });
});

// The duration pattern used to be "(number unit?)+", which backtracks
// exponentially on a long run of digits followed by junk. This field is typed
// into the UI thread, so a slow rejection is a frozen browser tab.
test('validateJob rejects a long malformed duration in linear time', () => {
    const started = Date.now();
    assert.deepEqual(codes(S.validateJob({
        id: 'j', repo: 'r', schedule: { calendar: 'daily', accuracySec: '1'.repeat(40) + 'x' }
    })), ['accuracy']);
    assert.deepEqual(codes(S.validateJob({
        id: 'j', repo: 'r', schedule: { calendar: 'daily', accuracySec: '1s'.repeat(500) + '!' }
    })), ['accuracy']);
    assert.ok(Date.now() - started < 1000, 'duration validation took ' + (Date.now() - started) + 'ms');
});

test('validateJob treats the string and object schedule forms identically', () => {
    assert.deepEqual(S.validateJob({ id: 'j', repo: 'r', schedule: '*-*-* 25:00' }),
        S.validateJob({ id: 'j', repo: 'r', schedule: { calendar: '*-*-* 25:00' } }));
});

test('validateJob rejects a repo whose credentials are junk types', () => {
    assert.deepEqual(codes(S.validateJob({ id: 'j', repo: { id: 'r', credentials: { a: {} } }, schedule: 'daily' })),
        ['credential-path']);
    // A non-object credentials bag is ignored rather than fatal: there is
    // nothing to load, and the password credential is added unconditionally.
    [null, [], 'x', 42].forEach((c) => {
        assert.deepEqual(S.validateJob({ id: 'j', repo: { id: 'r', credentials: c }, schedule: 'daily' }),
            [], String(c));
    });
});

test('validateJob accepts an empty job name and reports only a non-string one', () => {
    assert.deepEqual(S.validateJob({ id: 'j', repo: 'r', name: '', schedule: 'daily' }), []);
    [7, {}, [], true].forEach((n) => {
        assert.deepEqual(codes(S.validateJob({ id: 'j', repo: 'r', name: n, schedule: 'daily' })),
            ['name-type'], String(n));
    });
});

test('calendarsOf ignores a calendar of the wrong type', () => {
    assert.deepEqual(S.calendarsOf({ schedule: { calendar: 42 } }), []);
    assert.deepEqual(S.calendarsOf({ schedule: { calendar: null } }), []);
    assert.deepEqual(S.calendarsOf({ schedule: [] }), []);
    assert.deepEqual(S.calendarsOf(undefined), []);
});

// ---------------------------------------------------- renderers: hostile

test('no user-controlled text can produce a line that is not KEY=VALUE', () => {
    const job = {
        id: 'evil',
        name: 'A\nExecStart=/bin/sh\r[Service]\tUser=root ' + NUL + ' x',
        repo: { id: 'r', credentials: { 'a-b': '/etc/a b' } },
        schedule: { calendar: ['daily', '*-*-* 02:30'] }
    };
    assert.deepEqual(nonConformingLines(S.renderService(job)), []);
    assert.deepEqual(nonConformingLines(S.renderTimer(job)), []);
    assert.deepEqual(nonConformingLines(S.renderService(NIGHTLY)), []);
    assert.deepEqual(nonConformingLines(S.renderTimer(OFFSITE)), []);
});

test('renderers emit exactly one trailing newline and no carriage returns', () => {
    [S.renderService(OFFSITE), S.renderTimer(OFFSITE)].forEach((out) => {
        assert.ok(out.endsWith('\n'));
        assert.ok(!out.endsWith('\n\n'));
        assert.equal(out.indexOf('\r'), -1);
    });
});

test('renderService emits exactly one ExecStart and one password credential', () => {
    const lines = S.renderService(OFFSITE).split('\n');
    assert.equal(lines.filter((l) => l.indexOf('ExecStart=') === 0).length, 1);
    assert.equal(lines.filter((l) => l.indexOf('LoadCredential=' + S.CRED_PREFIX) === 0).length, 1);
});

test('renderTimer emits one OnCalendar per expression, trimmed', () => {
    const out = S.renderTimer({ id: 'j', repo: 'r', schedule: { calendar: ['  daily  ', '*-*-* 02:30'] } });
    assert.deepEqual(out.split('\n').filter((l) => l.indexOf('OnCalendar=') === 0),
        ['OnCalendar=daily', 'OnCalendar=*-*-* 02:30']);
});

// Persistent is a three-state field in practice (true / false / absent), and
// only an explicit false may disable catch-up.
test('renderTimer only disables Persistent for an explicit false', () => {
    [undefined, null, 0, '', 'false', 'no', true].forEach((v) => {
        assert.ok(S.renderTimer({ id: 'j', repo: 'r', schedule: { calendar: 'daily', persistent: v } })
            .includes('\nPersistent=true\n'), String(v));
    });
    assert.ok(S.renderTimer({ id: 'j', repo: 'r', schedule: { calendar: 'daily', persistent: false } })
        .includes('\nPersistent=false\n'));
});

test('renderers keep a unicode job name intact', () => {
    const out = S.renderService({ id: 'j', name: 'Gecelik yedek \u015f\u0131k \u0431\u044d\u043a\u0430\u043f', repo: 'r', schedule: 'daily' });
    assert.ok(out.includes('Description=hangar backup: Gecelik yedek \u015f\u0131k \u0431\u044d\u043a\u0430\u043f\n'));
});

// The 160-character cap counts UTF-16 units, so it can land between the halves
// of an astral character; a lone surrogate is not expressible in UTF-8 and
// would reach the unit file as a mangled byte.
test('renderers never emit a lone surrogate when a long name is truncated', () => {
    const name = 'a' + '\u{1F600}'.repeat(100);
    const out = S.renderService({ id: 'j', name, repo: 'r', schedule: 'daily' });
    assert.equal(/[\uD800-\uDFFF]/.test(out.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')), false);
    assert.equal(Buffer.from(out, 'utf8').toString('utf8'), out);
});

test('sanitizeText falls back when the text is only control characters or spaces', () => {
    assert.equal(S.sanitizeText(NUL + '\t\n' + DEL, 'fallback'), 'fallback');
    assert.equal(S.sanitizeText('   ', 'fallback'), 'fallback');
    assert.equal(S.sanitizeText(42, 'fallback'), 'fallback');
    assert.equal(S.sanitizeText({}, 'fallback'), 'fallback');
});

test('renderService falls back to the job id for a name made of control characters', () => {
    assert.ok(S.renderService({ id: 'plain', name: NUL + '\n\t', repo: 'r', schedule: 'daily' })
        .includes('Description=hangar backup: plain\n'));
});

test('renderers do not mutate the job they are given', () => {
    const before = JSON.stringify(OFFSITE);
    S.renderService(OFFSITE);
    S.renderTimer(OFFSITE);
    S.validateJob(OFFSITE);
    assert.equal(JSON.stringify(OFFSITE), before);
});

test('renderers reject a job that is not an object with a typed error', () => {
    [null, undefined, [], 'nightly', 42, true].forEach((j) => {
        assert.throws(() => S.renderService(j), (e) => Errors.isHangarError(e), String(j));
        assert.throws(() => S.renderTimer(j), (e) => Errors.isHangarError(e), String(j));
    });
});

test('renderTimer rejects a calendar list holding a non-string', () => {
    assert.throws(() => S.renderTimer({ id: 'j', repo: 'r', schedule: { calendar: [42] } }),
        (e) => codes(e.detail).includes('calendar-type'));
    assert.throws(() => S.renderTimer({ id: 'j', repo: 'r', schedule: { calendar: 42 } }),
        (e) => codes(e.detail).includes('calendar-required'));
});

test('renderService refuses a job whose credentials are unusable', () => {
    assert.throws(() => S.renderService({ id: 'j', repo: { id: 'r', credentials: { 'a:b': '/etc/a' } }, schedule: 'daily' }),
        (e) => codes(e.detail).includes('credential-id'));
});

// ------------------------------------------- D-Bus pure helpers: hostile

test('unwrapProps unwraps falsy variant values rather than dropping them', () => {
    assert.deepEqual(S.unwrapProps({ A: { t: 'b', v: false }, B: { t: 't', v: 0 }, C: { t: 's', v: '' } }),
        { A: false, B: 0, C: '' });
});

test('unwrapProps ignores inherited properties', () => {
    const proto = { Inherited: 'x' };
    const obj = Object.create(proto);
    obj.Own = { t: 's', v: 'y' };
    assert.deepEqual(S.unwrapProps(obj), { Own: 'y' });
});

test('unwrapProps leaves an object that merely looks like a variant alone', () => {
    assert.deepEqual(S.unwrapProps({ A: { t: 's' } }), { A: { t: 's' } });
    assert.deepEqual(S.unwrapProps({ A: [{ v: 1 }] }), { A: [{ v: 1 }] });
});

test('usecToMillis truncates rather than rounds', () => {
    assert.equal(S.usecToMillis(1999), 1);
    assert.equal(S.usecToMillis(1000), 1);
    assert.equal(S.usecToMillis(999), 0);
});

test('usecToMillis rejects junk, negatives and the never sentinels', () => {
    [-1, -1e9, NaN, Infinity, -Infinity, {}, [], false, '', '   ', 'never',
        1e18, 1.8446744073709552e19].forEach((v) => {
        assert.equal(S.usecToMillis(v), null, String(v));
    });
});

test('usecToMillis accepts the numeric string cockpit sends for a uint64', () => {
    assert.equal(S.usecToMillis('1754000000000000'), 1754000000000);
});

test('normalizeUnitState works on the wrapped variants cockpit actually returns', () => {
    const state = S.normalizeUnitState(
        { LoadState: { t: 's', v: 'loaded' }, ActiveState: { t: 's', v: 'failed' },
            SubState: { t: 's', v: 'failed' }, UnitFileState: { t: 's', v: 'enabled' },
            Result: { t: 's', v: 'exit-code' } },
        { NextElapseUSecRealtime: { t: 't', v: 0 }, LastTriggerUSec: { t: 't', v: 1753000000000000 } }
    );
    assert.equal(state.failed, true);
    assert.equal(state.active, false);
    assert.equal(state.enabled, true);
    assert.equal(state.nextElapseMs, null);
    assert.equal(state.lastTriggerMs, 1753000000000);
});

test('normalizeUnitState counts activating as active and deactivating as not', () => {
    assert.equal(S.normalizeUnitState({ ActiveState: 'activating' }, {}).active, true);
    assert.equal(S.normalizeUnitState({ ActiveState: 'deactivating' }, {}).active, false);
    assert.equal(S.normalizeUnitState({ ActiveState: 'inactive' }, {}).active, false);
});

test('normalizeUnitState treats every other unit file state as not enabled', () => {
    ['disabled', 'masked', 'linked', 'indirect', 'generated', 'transient', 'unknown']
        .forEach((s) => {
            assert.equal(S.normalizeUnitState({ UnitFileState: s }, {}).enabled, false, s);
        });
});

test('normalizeUnitState survives junk in place of either property bag', () => {
    ['nonsense', 42, [], true, null].forEach((v) => {
        const state = S.normalizeUnitState(v, v);
        assert.equal(state.loadState, 'not-found');
        assert.equal(state.failed, false);
        assert.equal(state.nextElapseMs, null);
    });
});

// ---------------------------------------------------- I/O layer: hostile

test('every I/O helper validates the job id before reaching the bus', async () => {
    const helpers = ['unitState', 'enable', 'disable', 'start', 'stop', 'runNow'];
    for (const h of helpers) {
        for (const id of ['../evil', 'a/b', 'a b', '%n', 'a' + NUL, '.', 'a'.repeat(65)]) {
            await assert.rejects(S[h](id),
                (e) => Errors.isHangarError(e) && codes(e.detail).some((c) => c.indexOf('id-') === 0),
                h + ' ' + JSON.stringify(id));
        }
        for (const id of [undefined, null, 42, {}, []]) {
            await assert.rejects(S[h](id),
                (e) => Errors.isHangarError(e) && codes(e.detail).includes('id-required'),
                h + ' ' + String(id));
        }
    }
});

test('the module exports every documented pure function', () => {
    ['validateId', 'unitName', 'serviceUnit', 'timerUnit', 'keyPath', 'credentialLines',
        'calendarsOf', 'sanitizeText', 'validateCalendar', 'describeSchedule', 'validateJob',
        'renderService', 'renderTimer', 'unwrapProps', 'usecToMillis', 'normalizeUnitState',
        'available', 'unitState', 'enable', 'disable', 'start', 'stop', 'runNow', 'daemonReload']
        .forEach((name) => { assert.equal(typeof S[name], 'function', name); });
});

// ProtectKernelModules=yes makes /usr/lib/modules INACCESSIBLE to the service.
// hangar shipped it for weeks: restic recorded that directory as empty, mode
// 0000, in every snapshot, so a machine restored from one had no kernel
// modules, could not build an initrd, and might not boot. The backups reported
// success throughout. A recovery drill found it, and only because dracut
// complained.
//
// Anything that hides part of the filesystem from a backup belongs nowhere near
// this unit, however good it looks in a hardening guide.
test('the backup unit hides no part of the filesystem from itself', () => {
    [NIGHTLY, OFFSITE].forEach((job) => {
        const unit = S.renderService(job);
        const directives = unit.split('\n').filter((l) => !l.startsWith('#'));
        ['ProtectKernelModules', 'ProtectSystem', 'ProtectHome', 'PrivateTmp',
            'InaccessiblePaths', 'TemporaryFileSystem', 'RootDirectory']
            .forEach((name) => {
                assert.ok(!directives.some((l) => l.startsWith(name + '=')),
                    name + ' would make the backup capture the wrong content, '
                    + 'silently, which is worse than failing');
            });
    });
});

test('the hardening that does not touch the filesystem is still there', () => {
    const unit = S.renderService(NIGHTLY);
    ['NoNewPrivileges=yes', 'ProtectClock=yes', 'ProtectKernelTunables=yes',
        'RestrictRealtime=yes', 'LockPersonality=yes']
        .forEach((d) => assert.ok(unit.includes(d), 'lost: ' + d));
});
