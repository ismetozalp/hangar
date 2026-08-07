// Unit tests for js/app.js — tab wiring and the two generic dialogs.
//
// app.js is an Alpine component factory, not a pure library, so these tests drive
// the returned objects directly. That is enough to cover the logic that actually
// matters here: password confirmation, secret lifetime, and dialog resolution.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// app.js reaches for `root.document` and `root.bootstrap` only inside handlers, so
// it loads fine under node. Confirm that, since it is the reason these tests exist.
const App = require('../../js/app.js');

test('module loads with no DOM present', () => {
    assert.equal(typeof App.hangarApp, 'function');
    assert.equal(typeof App.hangarConfirm, 'function');
    assert.equal(typeof App.hangarPassword, 'function');
});

test('tabs cover every screen the plugin ships', () => {
    const ids = App.TABS.map((t) => t.id);
    assert.deepEqual(ids, ['overview', 'repos', 'jobs', 'logbook', 'recovery', 'settings']);
    for (const t of App.TABS) {
        assert.ok(t.label && typeof t.label === 'string', `${t.id} has no label`);
    }
});

test('no tab is labelled "Time Machine"', () => {
    // The feature is named Logbook. Guarded here as well as in the smoke test
    // because a label is the most likely place for it to creep back in.
    for (const t of App.TABS) assert.ok(!/time\s*machine/i.test(t.label));
});

test('app starts on overview and not ready', () => {
    const a = App.hangarApp();
    assert.equal(a.tab, 'overview');
    assert.equal(a.ready, false);
    assert.deepEqual(a.missing, []);
});

test('missingSummary renders tool names with and without reasons', () => {
    const a = App.hangarApp();
    a.missing = [{ tool: 'restic', reason: 'not packaged' }, { tool: 'fuse3' }];
    assert.equal(a.missingSummary(), 'restic (not packaged), fuse3');

    a.missing = [];
    assert.equal(a.missingSummary(), '');
});

// --- password dialog -----------------------------------------------------

function pw(overrides) {
    const p = App.hangarPassword();
    Object.assign(p, overrides || {});
    return p;
}

test('password dialog rejects an empty password', () => {
    assert.equal(pw({ password: '' }).valid(), false);
});

test('password dialog accepts a password when not confirming', () => {
    assert.equal(pw({ password: 'hunter2', confirming: false }).valid(), true);
});

test('password dialog requires a match when confirming', () => {
    assert.equal(pw({ password: 'a', confirm: 'b', confirming: true }).valid(), false);
    assert.equal(pw({ password: 'a', confirm: 'a', confirming: true }).valid(), true);
});

test('a new-repository password mismatch produces a specific message', () => {
    // A typo here is unrecoverable — there is no existing repository to check the
    // password against — so the error must say which problem it is.
    const p = pw({ password: 'a', confirm: 'b', confirming: true });
    p.submit();
    assert.match(p.error, /do not match/);
});

test('an empty password produces its own message', () => {
    const p = pw({ password: '' });
    p.submit();
    assert.match(p.error, /Enter a password/);
});

test('submit resolves with the password and then clears it from state', () => {
    // The secret must not outlive the dialog in Alpine state; core/secrets.js is the
    // only thing allowed to hold it.
    let resolved = null;
    const p = pw({ password: 's3cret', confirming: false });
    p._resolve = (v) => { resolved = v; };
    p.submit();

    assert.equal(resolved, 's3cret');
    assert.equal(p.password, '');
    assert.equal(p.confirm, '');
    assert.equal(p.error, '');
    assert.equal(p._resolve, null, 'resolver should not be reusable');
});

test('a failed submit does not clear the typed password', () => {
    // Wiping the field on a mismatch would force the user to retype both.
    const p = pw({ password: 'a', confirm: 'b', confirming: true });
    p.submit();
    assert.equal(p.password, 'a');
});

test('password dialog does not resolve when invalid', () => {
    let called = false;
    const p = pw({ password: '' });
    p._resolve = () => { called = true; };
    p.submit();
    assert.equal(called, false);
});

// --- confirm dialog ------------------------------------------------------

test('confirm dialog defaults are safe', () => {
    const c = App.hangarConfirm();
    assert.equal(c.danger, false);
    assert.equal(c.confirmLabel, 'Confirm');
    assert.equal(c.cancelLabel, 'Cancel');
});

test('confirm dialog resolves true and drops its resolver', () => {
    let resolved = null;
    const c = App.hangarConfirm();
    c._resolve = (v) => { resolved = v; };
    // No DOM: accept() must still resolve rather than throwing on the missing modal.
    globalThis.document = { getElementById: () => null };
    try {
        c.accept();
    } finally {
        delete globalThis.document;
    }
    assert.equal(resolved, true);
    assert.equal(c._resolve, null);
});

// --- the prerequisite banner is a live view, not a load-time snapshot -----

function stubProvision(missingTools) {
    return {
        probeAll: async () => missingTools.map((t) => ({ tool: t, present: false, ok: false })),
        missingFrom: (results) => results.map((r) => r.tool),
        requirementFor: (t) => ({ tool: t, reason: `${t} is needed.` })
    };
}

test('refreshMissing asks the system and pairs each tool with its reason', async () => {
    const a = App.hangarApp();
    globalThis.HangarProvision = stubProvision(['rclone', 'rear']);
    try {
        await a.refreshMissing();
        assert.deepEqual(a.missing.map((m) => m.tool), ['rclone', 'rear']);
        assert.match(a.missing[0].reason, /needed/);
    } finally { delete globalThis.HangarProvision; }
});

test('a later successful probe clears an earlier probe error', async () => {
    const a = App.hangarApp();
    a.error = new Error('an earlier failure');
    globalThis.HangarProvision = stubProvision([]);
    try {
        await a.refreshMissing();
        assert.deepEqual(a.missing, []);
        assert.equal(a.error, null, 'a stale probe error stayed on screen');
    } finally { delete globalThis.HangarProvision; }
});

test('installing the missing tools clears the banner rather than leaving it stale', async () => {
    // Reported from real use: hangar installed the tools successfully, but the
    // header chip and the prerequisite banner kept saying "2 tools missing",
    // which reads as though the install had failed.
    const a = App.hangarApp();
    globalThis.HangarProvision = stubProvision(['rclone', 'rear']);
    try {
        await a.refreshMissing();
        assert.equal(a.missing.length, 2);

        // The system changed underneath us — exactly what a successful install does.
        globalThis.HangarProvision = stubProvision([]);
        await a.refreshMissing();
        assert.deepEqual(a.missing, [], 'the banner would still be showing');
        assert.equal(a.missingSummary(), '');
    } finally { delete globalThis.HangarProvision; }
});

test('refreshMissing degrades quietly when provisioning is unavailable', async () => {
    const a = App.hangarApp();
    a.missing = [{ tool: 'restic', reason: 'x' }];
    await a.refreshMissing();          // no HangarProvision global at all
    assert.deepEqual(a.missing, []);
});

test('a probe that rejects is reported and does not leave a stale list', async () => {
    const a = App.hangarApp();
    a.missing = [{ tool: 'rclone', reason: 'x' }];
    globalThis.HangarProvision = {
        probeAll: async () => { throw new Error('bridge gone'); },
        missingFrom: () => [], requirementFor: () => ({})
    };
    try {
        await a.refreshMissing();
        assert.deepEqual(a.missing, []);
        assert.ok(a.error, 'the failure was swallowed');
    } finally { delete globalThis.HangarProvision; }
});

// --- selects whose options arrive late ------------------------------------
//
// Alpine binds x-model on a <select> before the <template x-for> inside it has
// produced any <option>, so the browser keeps showing the first one. The
// password dialog generated a six-word passphrase while its Shape box read
// "Two words, two numbers — weak".

test('a select showing something other than its model is resynced', () => {
    assert.equal(App.selectNeedsSync('short', 'longer', ['short', 'longer']), true);
});

test('a select already showing its model is left alone', () => {
    // Re-applying on every mutation would fight a user mid-selection.
    assert.equal(App.selectNeedsSync('longer', 'longer', ['short', 'longer']), false);
});

test('a model value no option carries is not forced onto the box', () => {
    // The repository this job points at was deleted: blanking the select would
    // hide that the stored value is now unavailable, which is the one thing the
    // user needs to see.
    assert.equal(App.selectNeedsSync('short', 'gone', ['short', 'longer']), false);
});

test('an absent model is not a mismatch', () => {
    for (const want of [undefined, null])
        assert.equal(App.selectNeedsSync('a', want, ['a', 'b']), false, String(want));
});

test('values are compared as strings, the way a select holds them', () => {
    // x-model on a number field yields a number; el.value is always a string.
    assert.equal(App.selectNeedsSync('30', 30, ['30', '60']), false);
    assert.equal(App.selectNeedsSync('60', 30, ['30', '60']), true);
});
