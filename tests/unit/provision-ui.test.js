// tests/unit/provision-ui.test.js — the prerequisite installer screen.
//
// The point of these tests is the consent gate. A downloaded binary is not a
// distribution package, and the sentences that say so are asserted verbatim so
// they cannot be softened, shortened or dropped without this file going red.
//
// Everything else here drives the real plans that core/provision.js produces for
// each distro family, rather than hand-built step objects, so a change in
// planning shows up as a UI test failure instead of drifting apart quietly.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const UI = require('../../js/features/provision-ui.js');
const P = require('../../js/core/provision.js');
const Errors = require('../../js/core/errors.js');

const BIN = P.METHOD.BINARY;

// Replaces functions on HangarProvision for one test and puts them back after.
function withProvision(patch, fn) {
    const saved = {};
    Object.keys(patch).forEach((k) => { saved[k] = P[k]; P[k] = patch[k]; });
    return Promise.resolve()
        .then(fn)
        .finally(() => {
            Object.keys(patch).forEach((k) => {
                if (saved[k] === undefined) delete P[k]; else P[k] = saved[k];
            });
        });
}

function component() {
    return UI.hangarProvisionUi();
}

// --------------------------------------------------------------- module shape

test('module loads with no DOM and no cockpit global', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.cockpit, 'undefined');
    assert.equal(typeof UI.hangarProvisionUi, 'function');
});

test('the Alpine factory is on the global under its documented name', () => {
    assert.equal(globalThis.hangarProvisionUi, UI.hangarProvisionUi);
    assert.equal(globalThis.HangarProvisionUi, UI);
});

test('the component constructs with no DOM', () => {
    const c = component();
    assert.deepEqual(c.rows, []);
    assert.equal(c.busy, false);
    assert.equal(c.consent, null);
    assert.equal(c.started, false);
});

test('init does not throw when there is no event target', () => {
    // Under node globalThis is not an EventTarget; the component must survive it
    // so that everything below is testable at all.
    assert.doesNotThrow(() => component().init());
});

test('nothing in this screen calls the Logbook by any other name', () => {
    const texts = Object.keys(UI.REASONS).map((k) => UI.REASONS[k])
        .concat(Object.keys(UI.STATUS_LABELS).map((k) => UI.STATUS_LABELS[k]))
        .concat(Object.keys(UI.ACTION_LABELS).map((k) => UI.ACTION_LABELS[k]))
        .concat([UI.consentText({ tool: 'restic', method: BIN })]);
    for (const t of texts) assert.ok(!/time\s*machine/i.test(t), t);
});

// --------------------------------------------------------------- reasonFor

test('restic reads as the thing without which nothing works', () => {
    assert.match(UI.reasonFor('restic'), /backup engine/i);
});

test('fuse3 is explained as Logbook browsing, and names the fallback', () => {
    const r = UI.reasonFor('fuse3');
    assert.match(r, /Logbook/);
    assert.match(r, /falls back/i);
});

test('rclone is explained as extra destinations', () => {
    assert.match(UI.reasonFor('rclone'), /off-site|remote/i);
});

test('rear is explained as rescue images', () => {
    assert.match(UI.reasonFor('rear'), /rescue image/i);
});

test('libvirt is explained as the recovery drill', () => {
    // Not yet planned by core, but the sentence exists so the drill can ship
    // without inventing copy at the last minute.
    assert.match(UI.reasonFor('libvirt'), /drill/i);
    assert.match(UI.reasonFor('libvirt'), /virtual machine/i);
});

test('reasonFor falls back to the core requirement note', () => {
    // Every tool core plans has a reason one way or the other.
    for (const t of P.TOOLS) assert.notEqual(UI.reasonFor(t), '');
});

test('reasonFor is empty rather than wrong for an unknown tool', () => {
    assert.equal(UI.reasonFor('nonesuch'), '');
    assert.equal(UI.reasonFor(null), '');
    assert.equal(UI.reasonFor(undefined), '');
    assert.equal(UI.reasonFor(''), '');
});

test('reasonFor accepts a step object as well as a name', () => {
    assert.equal(UI.reasonFor({ tool: 'restic' }), UI.REASONS.restic);
});

// --------------------------------------------------------------- wouldDownload

test('a binary-method step would download', () => {
    assert.equal(UI.wouldDownload({ tool: 'restic', method: BIN }), true);
});

test('a packagekit step with a binary fallback would download', () => {
    assert.equal(UI.wouldDownload({ tool: 'restic', method: 'packagekit', fallback: BIN }), true);
});

test('a plain packagekit step would not download', () => {
    assert.equal(UI.wouldDownload({ tool: 'restic', method: 'packagekit', fallback: null }), false);
});

test('an unavailable step would not download', () => {
    assert.equal(UI.wouldDownload({ tool: 'rear', method: 'unavailable' }), false);
});

test('wouldDownload rejects junk instead of guessing', () => {
    [null, undefined, '', 0, 'restic', []].forEach((v) => {
        assert.equal(UI.wouldDownload(v), false, String(v));
    });
});

test('epelApplies only for the packagekit-with-binary-fallback shape', () => {
    assert.equal(UI.epelApplies({ method: 'packagekit', fallback: BIN }), true);
    assert.equal(UI.epelApplies({ method: BIN, fallback: null }), false);
    assert.equal(UI.epelApplies({ method: 'packagekit', fallback: null }), false);
    assert.equal(UI.epelApplies(null), false);
});

// --------------------------------------------------------------- stepRows

test('stepRows renders the real RHEL restic plan', () => {
    const rows = UI.stepRows(P.planFor(['restic'], 'rhel'));
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.tool, 'restic');
    assert.equal(r.required, true);
    assert.equal(r.need, 'Required');
    assert.deepEqual(r.packages, ['restic']);
    assert.equal(r.download, true, 'EPEL-only restic must be flagged as a possible download');
    assert.equal(r.epel, true);
    assert.equal(r.state, 'pending');
    assert.equal(r.progress, 0);
    assert.equal(r.error, null);
});

test('stepRows marks the optional tools optional', () => {
    const rows = UI.stepRows(P.planFor(['restic', 'rclone', 'fuse3', 'rear'], 'debian'));
    const byTool = {};
    rows.forEach((r) => { byTool[r.tool] = r; });
    assert.equal(byTool.restic.required, true);
    assert.equal(byTool.rclone.required, false);
    assert.equal(byTool.fuse3.required, false);
    assert.equal(byTool.rear.required, false);
    assert.equal(byTool.rclone.need, 'Optional');
});

test('every row on a full plan carries a reason and an action sentence', () => {
    const rows = UI.stepRows(P.planFor(P.TOOLS, 'fedora'));
    assert.equal(rows.length, P.TOOLS.length);
    for (const r of rows) {
        assert.notEqual(r.reason, '', r.tool + ' has no reason');
        assert.notEqual(r.action, '', r.tool + ' has no action sentence');
    }
});

test('stepRows keeps core install order — restic first', () => {
    const rows = UI.stepRows(P.planFor(['rear', 'fuse3', 'restic'], 'suse'));
    assert.deepEqual(rows.map((r) => r.tool), ['restic', 'fuse3', 'rear']);
});

test('rear on Arch is surfaced as unavailable, not as a download', () => {
    const rows = UI.stepRows(P.planFor(['rear'], 'arch'));
    assert.equal(rows[0].unavailable, true);
    assert.equal(rows[0].download, false);
    assert.match(rows[0].action, /install it manually/i);
});

test('an unknown family plans restic as a static binary', () => {
    const rows = UI.stepRows(P.planFor(['restic'], 'martian'));
    assert.equal(rows[0].method, BIN);
    assert.equal(rows[0].download, true);
    assert.equal(rows[0].epel, false, 'no EPEL story off the RHEL family');
});

test('stepRows drops entries that are not steps', () => {
    assert.deepEqual(UI.stepRows([null, undefined, 'restic', 42, {}]), []);
});

test('stepRows accepts an empty or absent plan', () => {
    assert.deepEqual(UI.stepRows([]), []);
    assert.deepEqual(UI.stepRows(null), []);
    assert.deepEqual(UI.stepRows(undefined), []);
});

test('stepRows accepts a bare step as well as a plan', () => {
    const rows = UI.stepRows(P.planFor(['fuse3'], 'debian')[0]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tool, 'fuse3');
});

test('stepRows copies the package list rather than aliasing the plan', () => {
    const plan = P.planFor(['restic'], 'debian');
    const rows = UI.stepRows(plan);
    rows[0].packages.push('oops');
    assert.deepEqual(plan[0].packages, ['restic']);
});

// --------------------------------------------------------------- needsConsent

test('needsConsent is true for the RHEL restic plan', () => {
    assert.equal(UI.needsConsent(P.planFor(['restic'], 'rhel')), true);
});

test('needsConsent is false where the distribution packages everything', () => {
    assert.equal(UI.needsConsent(P.planFor(P.TOOLS, 'fedora')), false);
    assert.equal(UI.needsConsent(P.planFor(P.TOOLS, 'debian')), false);
    assert.equal(UI.needsConsent(P.planFor(P.TOOLS, 'suse')), false);
});

test('needsConsent is false when the only gap is an unpackaged tool with no release', () => {
    // rear on Arch: nothing to install and nothing to download either.
    assert.equal(UI.needsConsent(P.planFor(['rear'], 'arch')), false);
});

test('needsConsent works on rows as well as on plans', () => {
    const rows = UI.stepRows(P.planFor(['restic'], 'rhel'));
    assert.equal(UI.needsConsent(rows), true);
    assert.equal(UI.needsConsent(UI.stepRows(P.planFor(['restic'], 'arch'))), false);
});

test('needsConsent is false for nothing at all', () => {
    assert.equal(UI.needsConsent([]), false);
    assert.equal(UI.needsConsent(null), false);
    assert.equal(UI.needsConsent(undefined), false);
});

// --------------------------------------------------------------- consentText

const RELEASE = P.binaryFallbackFor('restic', '0.19.1', 'x86_64');

test('the EPEL consent wording is exactly this and nothing softer', () => {
    const step = Object.assign({}, P.planFor(['restic'], 'rhel')[0], { release: RELEASE });
    const expected = [
        'Hangar would download the official restic release binary from GitHub and install it outside your package manager.',
        'This is not a package from your distribution. Your package manager will not update it, will not verify it again, and will not remove it when you remove hangar. You are taking on those jobs yourself.',
        'Release: https://github.com/restic/restic/releases/download/v0.19.1/restic_0.19.1_linux_amd64.bz2',
        'SHA256: https://github.com/restic/restic/releases/download/v0.19.1/SHA256SUMS — the checksum is downloaded from there and compared before anything is installed.',
        'Signature: https://github.com/restic/restic/releases/download/v0.19.1/SHA256SUMS.asc',
        'There is a better option: restic is packaged in EPEL for this distribution. Enabling EPEL installs a real package that your package manager keeps up to date. Use the download only if EPEL is not an option here.',
        'Nothing is downloaded until you confirm this step.'
    ].join('\n');
    assert.equal(UI.consentText(step), expected);
});

test('consent always says the binary is not a distribution package', () => {
    const step = Object.assign({}, P.planFor(['restic'], 'martian')[0], { release: RELEASE });
    assert.match(UI.consentText(step), /not a package from your distribution/);
});

test('consent always shows the release URL and the SHA256 source', () => {
    const step = { tool: 'restic', method: BIN, release: RELEASE };
    const text = UI.consentText(step);
    assert.ok(text.includes(RELEASE.url), 'release URL missing');
    assert.ok(text.includes(RELEASE.sha256Url), 'SHA256 source missing');
});

test('consent shows the detached signature when the project publishes one', () => {
    assert.match(UI.consentText({ tool: 'restic', method: BIN, release: RELEASE }), /^Signature: /m);
});

test('consent omits the signature line when there is no detached signature', () => {
    // rclone clear-signs its SHA256SUMS, so there is no .asc asset to point at.
    const rel = P.binaryFallbackFor('rclone', '1.74.3', 'x86_64');
    assert.equal(rel.sigUrl, null);
    assert.ok(!/^Signature: /m.test(UI.consentText({ tool: 'rclone', method: BIN, release: rel })));
});

test('consent offers EPEL as the better alternative only where it exists', () => {
    const rhel = Object.assign({}, P.planFor(['restic'], 'rhel')[0], { release: RELEASE });
    const other = { tool: 'restic', method: BIN, release: RELEASE };
    assert.match(UI.consentText(rhel), /packaged in EPEL/);
    assert.ok(!/EPEL/.test(UI.consentText(other)));
});

test('consent ends by saying nothing is downloaded yet', () => {
    assert.match(UI.consentText({ tool: 'restic', method: BIN, release: RELEASE }),
        /Nothing is downloaded until you confirm this step\.$/);
});

test('with no release there is no URL and the text says so', () => {
    const text = UI.consentText({ tool: 'restic', method: BIN });
    assert.ok(!/https:\/\//.test(text), 'must not imply a URL it does not have');
    assert.match(text, /could not work out which release asset/);
    assert.match(text, /nothing will be downloaded/);
});

test('consentText survives junk without producing a blank consent', () => {
    [null, undefined, '', 0].forEach((v) => {
        assert.match(UI.consentText(v), /not a package from your distribution/);
    });
});

// --------------------------------------------------------------- errors

test('a raw polkit rejection becomes "not authorised" with an instruction', () => {
    const e = new Error('org.freedesktop.DBus.Error.AccessDenied: Not authorized to install packages');
    const m = UI.packageKitMessage(e, null);
    assert.equal(m.title, 'Not authorised');
    assert.match(m.text, /administrative access/i);
    assert.notEqual(m.text, m.detail, 'the headline must not be the D-Bus string');
});

test('the raw string is kept as detail so a bug stays reportable', () => {
    const raw = 'org.freedesktop.DBus.Error.AccessDenied: Not authorized';
    assert.equal(UI.packageKitMessage(new Error(raw), null).detail, raw);
});

test('the EPEL "nothing resolved" failure becomes "package not found"', () => {
    // This is verbatim what core/provision.js throws when Resolve returns nothing.
    const step = P.planFor(['restic'], 'rhel')[0];
    const e = Errors.create(Errors.KIND.GENERIC,
        'restic is not available from any enabled repository.', { tool: 'restic', fallback: BIN });
    const m = UI.packageKitMessage(e, step);
    assert.equal(m.title, 'Package not found');
    assert.match(m.text, /No repository enabled/);
});

test('a package-not-found on an EPEL tool carries the EPEL hint', () => {
    const step = P.planFor(['restic'], 'rhel')[0];
    const e = Errors.create(Errors.KIND.GENERIC, 'restic is not available from any enabled repository.');
    assert.match(UI.packageKitMessage(e, step).hint, /EPEL/);
});

test('no EPEL hint where EPEL is not part of the story', () => {
    const step = P.planFor(['restic'], 'debian')[0];
    const e = Errors.create(Errors.KIND.GENERIC, 'restic is not available from any enabled repository.');
    assert.equal(UI.packageKitMessage(e, step).hint, '');
});

test('a network failure becomes retryable text with a Retry button', () => {
    const e = P.classifyPackageKitError(4, 'Could not resolve host: download.example.org');
    const m = UI.packageKitMessage(e, null);
    assert.equal(m.kind, Errors.KIND.NETWORK);
    assert.match(m.title, /reach the repositories/i);
    assert.equal(m.remediation, 'retry');
    assert.equal(m.actionLabel, 'Retry');
});

test('running out of disk space becomes the free-space action', () => {
    const e = P.classifyPackageKitError(11, 'No space left on device');
    const m = UI.packageKitMessage(e, null);
    assert.equal(m.kind, Errors.KIND.NO_SPACE);
    assert.equal(m.remediation, 'free-space');
    assert.match(m.text, /Free some space/i);
});

test('a cancelled transaction is stated neutrally and offers no action', () => {
    const e = P.classifyPackageKitError(3, 'The transaction was cancelled');
    const m = UI.packageKitMessage(e, null);
    assert.equal(m.kind, Errors.KIND.CANCELLED);
    assert.equal(m.actionLabel, null);
    assert.match(m.text, /Nothing was left half-installed/);
});

test('an unrecognised failure still gets a sentence, not a bare string', () => {
    const m = UI.packageKitMessage(new Error('backend blew up in an interesting new way'), null);
    assert.equal(m.title, 'The installation did not complete');
    assert.match(m.text, /package manager stopped/i);
    assert.equal(m.detail, 'backend blew up in an interesting new way');
});

test('a non-Error value is classified rather than rendered raw', () => {
    const m = UI.packageKitMessage('connection timed out', null);
    assert.equal(m.kind, Errors.KIND.NETWORK);
});

test('an empty failure still produces readable text', () => {
    const m = UI.packageKitMessage(null, null);
    assert.notEqual(m.title, '');
    assert.notEqual(m.text, '');
});

test('every remediation slug in core has a button label here', () => {
    for (const kind of Object.keys(Errors.REMEDIATION))
        assert.notEqual(UI.actionLabel(Errors.REMEDIATION[kind]), null, kind);
});

test('actionLabel refuses to invent a label', () => {
    assert.equal(UI.actionLabel('nope'), null);
    assert.equal(UI.actionLabel(null), null);
    assert.equal(UI.actionLabel(undefined), null);
});

// --------------------------------------------------------------- progress

test('progressFrom takes a usable percentage', () => {
    assert.equal(UI.progressFrom({ Percentage: 42 }, 0), 42);
    assert.equal(UI.progressFrom({ Percentage: 0 }, 90), 0);
    assert.equal(UI.progressFrom({ Percentage: 100 }, 0), 100);
});

test('progressFrom keeps the last value for PackageKit\'s 101 "unknown"', () => {
    assert.equal(UI.progressFrom({ Percentage: 101 }, 37), 37);
    assert.equal(UI.progressFrom({ Percentage: -1 }, 37), 37);
});

test('progressFrom unwraps a cockpit variant', () => {
    assert.equal(UI.progressFrom({ Percentage: { t: 'u', v: 55 } }, 0), 55);
});

test('progressFrom ignores properties it does not understand', () => {
    assert.equal(UI.progressFrom({ Status: 4 }, 12), 12);
    assert.equal(UI.progressFrom({}, 12), 12);
    assert.equal(UI.progressFrom(null, 12), 12);
    assert.equal(UI.progressFrom('nonsense', 12), 12);
    assert.equal(UI.progressFrom({ Percentage: 'half' }, 12), 12);
});

test('progressFrom starts from zero when there is no current value', () => {
    assert.equal(UI.progressFrom({ Percentage: 101 }, undefined), 0);
    assert.equal(UI.progressFrom({}, NaN), 0);
});

// --------------------------------------------------------------- statusLabel

test('every state a row can reach has a label', () => {
    ['pending', 'installing', 'done', 'failed', 'skipped', 'blocked', 'manual']
        .forEach((s) => assert.notEqual(UI.statusLabel(s), '', s));
    assert.equal(UI.statusLabel('done'), 'Installed');
    assert.equal(UI.statusLabel('blocked'), 'Needs your confirmation');
});

test('an unknown state reads as the idle label rather than blank', () => {
    assert.equal(UI.statusLabel('wat', false), 'Not installed');
    assert.equal(UI.statusLabel(undefined, false), 'Not installed');
    assert.equal(UI.statusLabel('wat', true), 'Waiting');
    assert.equal(UI.statusLabel(undefined, true), 'Waiting');
});

test('a pending row reads differently before and during an install run', () => {
    // Before Install is pressed nothing is waiting on anything, and calling an
    // untouched row "Waiting" makes an idle dialog look like a stalled one.
    assert.equal(UI.statusLabel('pending', false), 'Not installed');
    // Once a run is under way the row genuinely is queued behind another.
    assert.equal(UI.statusLabel('pending', true), 'Waiting');
});

test('the started flag never changes a state that is not pending', () => {
    for (const state of ['installing', 'done', 'failed', 'skipped', 'blocked', 'manual', 'partial']) {
        assert.equal(UI.statusLabel(state, false), UI.statusLabel(state, true), state);
    }
});

// --------------------------------------------------------------- installing

test('installAll installs each packagekit step and marks it done', async () => {
    const seen = [];
    await withProvision({
        installStep: (step) => { seen.push(step.tool); return Promise.resolve([]); }
    }, async () => {
        const c = component();
        c.rows = UI.stepRows(P.planFor(['restic', 'fuse3'], 'debian'));
        await c.installAll();
        assert.deepEqual(seen, ['restic', 'fuse3']);
        assert.deepEqual(c.rows.map((r) => r.state), ['done', 'done']);
        assert.equal(c.busy, false);
        assert.equal(c.finished(), true);
    });
});

test('install progress reaches the row', async () => {
    await withProvision({
        installStep: (step, onProgress) => {
            onProgress({ Percentage: 40 });
            onProgress({ Percentage: 101 });
            return Promise.resolve([]);
        }
    }, async () => {
        const c = component();
        c.rows = UI.stepRows(P.planFor(['restic'], 'debian'));
        const captured = [];
        // Watch the value as it moves, since the final state pins it to 100.
        const row = c.rows[0];
        Object.defineProperty(row, 'progress', {
            get() { return this._p || 0; },
            set(v) { this._p = v; captured.push(v); }
        });
        await c.installAll();
        assert.ok(captured.includes(40));
        assert.ok(!captured.includes(101), 'the unknown-progress sentinel must not be shown');
        assert.equal(row.progress, 100);
    });
});

test('an unavailable tool is skipped with the manual instruction, not attempted', async () => {
    let called = false;
    await withProvision({
        installStep: () => { called = true; return Promise.resolve([]); }
    }, async () => {
        const c = component();
        c.rows = UI.stepRows(P.planFor(['rear'], 'arch'));
        await c.installAll();
        assert.equal(called, false);
        assert.equal(c.rows[0].state, 'skipped');
        assert.match(c.rows[0].note, /install it manually/i);
    });
});

test('one optional tool failing does not abandon the rest', async () => {
    await withProvision({
        installStep: (step) => step.tool === 'rclone'
            ? Promise.reject(Errors.create(Errors.KIND.NETWORK, 'connection timed out'))
            : Promise.resolve([])
    }, async () => {
        const c = component();
        c.rows = UI.stepRows(P.planFor(['restic', 'rclone', 'fuse3'], 'debian'));
        await c.installAll();
        const byTool = {};
        c.rows.forEach((r) => { byTool[r.tool] = r; });
        assert.equal(byTool.restic.state, 'done');
        assert.equal(byTool.rclone.state, 'failed');
        assert.equal(byTool.fuse3.state, 'done', 'a later tool must still be attempted');
        assert.equal(byTool.rclone.error.actionLabel, 'Retry');
    });
});

// --------------------------------------------------------------- consent gate

test('the EPEL fallback parks on consent and downloads nothing', async () => {
    let downloaded = false;
    await withProvision({
        installStep: () => Promise.reject(Errors.create(Errors.KIND.GENERIC,
            'restic is not available from any enabled repository.', { tool: 'restic', fallback: BIN })),
        installBinary: () => { downloaded = true; return Promise.resolve(); }
    }, async () => {
        const c = component();
        c.arch = 'amd64';
        c.rows = UI.stepRows(P.planFor(['restic', 'fuse3'], 'rhel'));
        await c.installAll();

        assert.equal(downloaded, false, 'nothing may download before consent');
        assert.equal(c.rows[0].state, 'blocked');
        assert.ok(c.consent, 'the consent panel must be open');
        assert.equal(c.consent.tool, 'restic');
        assert.equal(c.consent.epel, true);
        assert.equal(c.consent.accepted, false);
        assert.match(c.consent.text, /not a package from your distribution/);
        assert.ok(c.consent.text.includes(c.consent.release.url));
        assert.equal(c.rows[1].state, 'pending', 'the run stops until the question is answered');
    });
});

test('a binary-only plan asks for consent before its very first action', async () => {
    let downloaded = false;
    await withProvision({
        installBinary: () => { downloaded = true; return Promise.resolve(); }
    }, async () => {
        const c = component();
        c.arch = 'x86_64';
        c.rows = UI.stepRows(P.planFor(['restic'], 'martian'));
        await c.installAll();
        assert.equal(downloaded, false);
        assert.ok(c.consent);
        assert.equal(c.consent.epel, false, 'no EPEL offer off the RHEL family');
    });
});

test('the download button stays disabled until the box is ticked', async () => {
    await withProvision({
        installBinary: () => Promise.resolve()
    }, async () => {
        const c = component();
        c.arch = 'amd64';
        c.rows = UI.stepRows(P.planFor(['restic'], 'martian'));
        await c.installAll();

        assert.equal(c.canDownload(), false);
        await c.acceptConsent();
        assert.ok(c.consent, 'an unticked consent must not proceed');

        c.consent.accepted = true;
        assert.equal(c.canDownload(), true);
    });
});

test('consent cannot be given when there is no URL to consent to', async () => {
    await withProvision({ installBinary: () => Promise.resolve() }, async () => {
        const c = component();
        c.arch = null;                       // architecture could not be determined
        c.rows = UI.stepRows(P.planFor(['restic'], 'martian'));
        await c.installAll();
        assert.equal(c.consent.release, null);
        c.consent.accepted = true;
        assert.equal(c.canDownload(), false);
    });
});

test('accepting consent downloads exactly once and continues the run', async () => {
    const calls = [];
    await withProvision({
        installStep: (step) => step.tool === 'restic'
            ? Promise.reject(Errors.create(Errors.KIND.GENERIC, 'restic is not available from any enabled repository.'))
            : (calls.push('pk:' + step.tool), Promise.resolve([])),
        installBinary: (release) => { calls.push('bin:' + release.tool); return Promise.resolve(); }
    }, async () => {
        const c = component();
        c.arch = 'amd64';
        c.rows = UI.stepRows(P.planFor(['restic', 'fuse3'], 'rhel'));
        await c.installAll();
        c.consent.accepted = true;
        await c.acceptConsent();

        assert.deepEqual(calls, ['bin:restic', 'pk:fuse3']);
        assert.equal(c.rows[0].state, 'done');
        assert.equal(c.rows[1].state, 'done');
        assert.equal(c.consent, null);
    });
});

test('declining the download skips the tool and says what that costs', async () => {
    await withProvision({
        installStep: () => Promise.reject(Errors.create(Errors.KIND.GENERIC,
            'restic is not available from any enabled repository.'))
    }, async () => {
        const c = component();
        c.arch = 'amd64';
        c.rows = UI.stepRows(P.planFor(['restic'], 'rhel'));
        await c.installAll();
        c.declineConsent();

        assert.equal(c.consent, null);
        assert.equal(c.rows[0].state, 'skipped');
        assert.match(c.rows[0].note, /cannot back anything up/i);
    });
});

test('with no downloader available the user is given the verified URLs instead', async () => {
    // core/provision.js builds and verifies URLs but ships no downloader yet.
    // Guessing at one would be worse than saying so.
    await withProvision({ installBinary: undefined }, async () => {
        const c = component();
        c.arch = 'amd64';
        c.rows = UI.stepRows(P.planFor(['restic'], 'martian'));
        await c.installAll();
        c.consent.accepted = true;
        await c.acceptConsent();

        assert.equal(c.rows[0].state, 'manual');
        assert.match(c.rows[0].note, /SHA256/);
        assert.equal(c.rows[0].release.url, P.binaryFallbackFor('restic', null, 'amd64').url);
    });
});

test('enabling EPEL installs the release package and then retries the tool', async () => {
    const calls = [];
    let epelDone = false;
    await withProvision({
        installStep: (step) => {
            calls.push(step.packages.join(','));
            if (step.tool === 'epel-release') { epelDone = true; return Promise.resolve([]); }
            return epelDone
                ? Promise.resolve([])
                : Promise.reject(Errors.create(Errors.KIND.GENERIC,
                    'restic is not available from any enabled repository.'));
        }
    }, async () => {
        const c = component();
        c.arch = 'amd64';
        c.rows = UI.stepRows(P.planFor(['restic'], 'rhel'));
        await c.installAll();
        assert.ok(c.consent);

        await c.enableEpel();
        assert.deepEqual(calls, ['restic', 'epel-release', 'restic']);
        assert.equal(c.rows[0].state, 'done');
        assert.equal(c.consent, null);
    });
});

test('a failure to enable EPEL is reported on the row, not swallowed', async () => {
    await withProvision({
        installStep: (step) => Promise.reject(step.tool === 'epel-release'
            ? Errors.create(Errors.KIND.NETWORK, 'could not resolve host')
            : Errors.create(Errors.KIND.GENERIC, 'restic is not available from any enabled repository.'))
    }, async () => {
        const c = component();
        c.arch = 'amd64';
        c.rows = UI.stepRows(P.planFor(['restic'], 'rhel'));
        await c.installAll();
        await c.enableEpel();

        assert.equal(c.rows[0].state, 'failed');
        assert.equal(c.rows[0].error.kind, Errors.KIND.NETWORK);
        assert.equal(c.busy, false);
    });
});

// --------------------------------------------------------------- retry

test('a remediation button re-runs the step it belongs to', async () => {
    let attempt = 0;
    await withProvision({
        installStep: () => {
            attempt += 1;
            return attempt === 1
                ? Promise.reject(Errors.create(Errors.KIND.NETWORK, 'connection timed out'))
                : Promise.resolve([]);
        }
    }, async () => {
        const c = component();
        c.rows = UI.stepRows(P.planFor(['rclone'], 'debian'));
        await c.installAll();
        assert.equal(c.rows[0].state, 'failed');

        await c.runAction(c.rows[0]);
        assert.equal(attempt, 2);
        assert.equal(c.rows[0].state, 'done');
    });
});

test('a remediation this screen cannot perform does nothing', async () => {
    const c = component();
    c.rows = UI.stepRows(P.planFor(['rclone'], 'debian'));
    c.rows[0].state = 'failed';
    c.rows[0].error = { remediation: 'unlock' };
    await c.runAction(c.rows[0]);
    assert.equal(c.rows[0].state, 'failed', 'state must not be quietly reset');
});

test('retryAll clears only the failures', async () => {
    await withProvision({ installStep: () => Promise.resolve([]) }, async () => {
        const c = component();
        c.rows = UI.stepRows(P.planFor(['restic', 'rclone'], 'debian'));
        c.rows[0].state = 'skipped';
        c.rows[1].state = 'failed';
        c.rows[1].error = { remediation: 'retry' };
        await c.retryAll();
        assert.equal(c.rows[0].state, 'skipped', 'a skipped tool stays skipped');
        assert.equal(c.rows[1].state, 'done');
    });
});

test('installAll refuses to run twice at once', async () => {
    let inflight = 0;
    let overlapped = false;
    await withProvision({
        installStep: () => {
            inflight += 1;
            if (inflight > 1) overlapped = true;
            return new Promise((res) => setTimeout(() => { inflight -= 1; res([]); }, 5));
        }
    }, async () => {
        const c = component();
        c.rows = UI.stepRows(P.planFor(['restic', 'fuse3'], 'debian'));
        await Promise.all([c.installAll(), c.installAll()]);
        assert.equal(overlapped, false);
    });
});

// --------------------------------------------------------------- opening

test('opening with no probe result asks the system what is missing', async () => {
    await withProvision({
        probeAll: () => Promise.resolve([
            { tool: 'restic', present: false, ok: false },
            { tool: 'fuse3', present: true, ok: true }
        ]),
        detectFamilyLive: () => Promise.resolve('debian'),
        installStep: () => Promise.resolve([])
    }, async () => {
        const c = component();
        await c.open(null);
        assert.deepEqual(c.rows.map((r) => r.tool), ['restic']);
        assert.equal(c.family, 'debian');
    });
});

test('opening with the probe result app.js already has skips a second probe', async () => {
    let probed = false;
    await withProvision({
        probeAll: () => { probed = true; return Promise.resolve([]); },
        detectFamilyLive: () => Promise.resolve('rhel')
    }, async () => {
        const c = component();
        await c.open([{ tool: 'restic', optional: false }]);
        assert.equal(probed, false);
        assert.deepEqual(c.rows.map((r) => r.tool), ['restic']);
        assert.equal(c.rows[0].epel, true);
    });
});

test('reopening clears the previous run, consent included', async () => {
    await withProvision({
        probeAll: () => Promise.resolve([]),
        detectFamilyLive: () => Promise.resolve('debian')
    }, async () => {
        const c = component();
        c.consentGiven = { restic: true };
        c.consent = { tool: 'restic' };
        c.started = true;
        await c.open(['fuse3']);
        assert.equal(c.consent, null);
        assert.deepEqual(c.consentGiven, {}, 'consent must not carry over between openings');
        assert.equal(c.started, false);
    });
});

test('pending and finished track the run rather than guessing', async () => {
    await withProvision({ installStep: () => Promise.resolve([]) }, async () => {
        const c = component();
        c.rows = UI.stepRows(P.planFor(['restic', 'fuse3'], 'debian'));
        assert.equal(c.pending(), 2);
        assert.equal(c.finished(), false, 'never finished before it started');
        await c.installAll();
        assert.equal(c.pending(), 0);
        assert.equal(c.finished(), true);
        assert.deepEqual(c.failedRows(), []);
    });
});

// =====================================================================
// Adversarial hardening: error states, hostile input, partial results.
// =====================================================================

// --------------------------------------------------- no DOM, no cockpit

test('requiring the module never reads document, cockpit or bootstrap', () => {
    const id = require.resolve('../../js/features/provision-ui.js');
    const savedEntry = require.cache[id];
    const poisoned = ['document', 'cockpit', 'bootstrap'];
    for (const name of poisoned)
        Object.defineProperty(globalThis, name, {
            configurable: true,
            get() { throw new Error('module load touched ' + name); }
        });
    try {
        delete require.cache[id];
        assert.doesNotThrow(() => require('../../js/features/provision-ui.js'));
    } finally {
        for (const name of poisoned) delete globalThis[name];
        require.cache[id] = savedEntry;
        // Put the globals back the way the first tests in this file found them.
        globalThis.hangarProvisionUi = UI.hangarProvisionUi;
        globalThis.HangarProvisionUi = UI;
    }
});

test('every exported pure function runs with no DOM and no cockpit', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.cockpit, 'undefined');
    const step = { tool: 'restic', method: BIN, release: RELEASE };
    assert.doesNotThrow(() => {
        UI.reasonFor('restic');
        UI.wouldDownload(step);
        UI.epelApplies(step);
        UI.stepRows([step]);
        UI.needsConsent([step]);
        UI.consentText(step);
        UI.packageKitMessage(new Error('x'), step);
        UI.probeFailureMessage(new Error('x'));
        UI.unreadableFrom(new Error('x'));
        UI.actionLabel('retry');
        UI.progressFrom({ Percentage: 5 }, 0);
        UI.statusLabel('done');
    });
});

test('opening and closing touch no DOM when there is none', async () => {
    await withProvision({
        probeAll: () => Promise.resolve([]),
        detectFamilyLive: () => Promise.resolve('debian')
    }, async () => {
        const c = component();
        await assert.doesNotReject(() => c.open(['restic']));
        assert.equal(c.arch, null, 'no cockpit means no architecture, not a guess');
        assert.doesNotThrow(() => c.close());
    });
});

// --------------------------------------------------- screen-level failures

test('a probe that rejects is reported, never rendered as "all installed"', async () => {
    await withProvision({
        probeAll: () => Promise.reject(new Error('the cockpit bridge went away')),
        detectFamilyLive: () => Promise.resolve('debian')
    }, async () => {
        const c = component();
        await c.open(null);
        assert.deepEqual(c.rows, []);
        assert.ok(c.error, 'a failed probe must not leave the screen silent');
        assert.match(c.error.title, /could not check/i);
        assert.match(c.error.text, /not a statement that everything is installed/i);
        assert.equal(c.error.detail, 'the cockpit bridge went away');
        assert.equal(c.loading, false);
    });
});

test('the screen-level failure offers a remediation button', async () => {
    await withProvision({
        probeAll: () => Promise.reject(Errors.create(Errors.KIND.NETWORK, 'could not resolve host')),
        detectFamilyLive: () => Promise.resolve('debian')
    }, async () => {
        const c = component();
        await c.open(null);
        assert.equal(c.error.remediation, 'retry');
        assert.equal(c.error.actionLabel, 'Retry');
        assert.equal(c.error.severity, 'danger');
    });
});

test('an untyped probe failure still gets a retry rather than a dead end', async () => {
    await withProvision({
        probeAll: () => Promise.reject('a bare string, thrown'),
        detectFamilyLive: () => Promise.resolve('debian')
    }, async () => {
        const c = component();
        await c.open(null);
        assert.equal(c.error.actionLabel, 'Retry');
    });
});

test('retrying the screen-level failure re-probes and clears the error', async () => {
    let attempt = 0;
    await withProvision({
        probeAll: () => {
            attempt += 1;
            return attempt === 1
                ? Promise.reject(new Error('bridge died'))
                : Promise.resolve([{ tool: 'restic', present: false, ok: false }]);
        },
        detectFamilyLive: () => Promise.resolve('debian')
    }, async () => {
        const c = component();
        await c.open(null);
        assert.ok(c.error);
        await c.retryOpen();
        assert.equal(c.error, null);
        assert.deepEqual(c.rows.map((r) => r.tool), ['restic']);
    });
});

test('a family detection that rejects is surfaced, not swallowed', async () => {
    await withProvision({
        detectFamilyLive: () => Promise.reject(new Error('/etc/os-release is a directory'))
    }, async () => {
        const c = component();
        await c.open(['restic']);
        assert.deepEqual(c.rows, []);
        assert.ok(c.error);
        assert.equal(c.error.detail, '/etc/os-release is a directory');
    });
});

test('an unexpected throw inside the run is surfaced instead of vanishing', async () => {
    // An unhandled rejection inside an Alpine @click leaves the user with a dead
    // button and no explanation, so the loop has to own its own surprises.
    const rows = UI.stepRows(P.planFor(['rear'], 'arch'));
    await withProvision({
        describeStep: () => { throw new TypeError('describeStep is not a function'); }
    }, async () => {
        const c = component();
        c.rows = rows;
        await assert.doesNotReject(() => c.installAll());
        assert.ok(c.error);
        assert.match(c.error.title, /stopped unexpectedly/i);
        assert.equal(c.busy, false, 'the screen must not be left stuck busy');
    });
});

// --------------------------------------------------- per-row failures

test('installStep missing altogether fails the row instead of the screen', async () => {
    await withProvision({ installStep: undefined }, async () => {
        const c = component();
        c.rows = UI.stepRows(P.planFor(['rclone'], 'debian'));
        await assert.doesNotReject(() => c.installAll());
        assert.equal(c.rows[0].state, 'failed');
        assert.notEqual(c.rows[0].error.title, '');
    });
});

test('a step that throws synchronously is handled like one that rejects', async () => {
    await withProvision({
        installStep: () => { throw Errors.create(Errors.KIND.NETWORK, 'connection timed out'); }
    }, async () => {
        const c = component();
        c.rows = UI.stepRows(P.planFor(['rclone'], 'debian'));
        await assert.doesNotReject(() => c.installAll());
        assert.equal(c.rows[0].state, 'failed');
        assert.equal(c.rows[0].error.actionLabel, 'Retry');
    });
});

test('running out of space offers the free-space action and re-runs on click', async () => {
    let attempt = 0;
    await withProvision({
        installStep: () => {
            attempt += 1;
            return attempt === 1
                ? Promise.reject(Errors.create(Errors.KIND.NO_SPACE, 'No space left on device'))
                : Promise.resolve([]);
        }
    }, async () => {
        const c = component();
        c.rows = UI.stepRows(P.planFor(['rclone'], 'debian'));
        await c.installAll();
        assert.equal(c.rows[0].error.remediation, 'free-space');
        assert.equal(c.rows[0].error.actionLabel, 'I freed some space — retry');
        await c.runAction(c.rows[0]);
        assert.equal(attempt, 2);
        assert.equal(c.rows[0].state, 'done');
    });
});

test('a remediation clicked mid-run does not strand the row on "Waiting"', async () => {
    // installAll() refuses to start a second run, so clearing the row while one is
    // in flight would leave it pending with no error and nothing coming for it.
    const c = component();
    c.rows = UI.stepRows(P.planFor(['rclone'], 'debian'));
    c.rows[0].state = 'failed';
    c.rows[0].error = { remediation: 'retry', actionLabel: 'Retry' };
    c.busy = true;
    await c.runAction(c.rows[0]);
    assert.equal(c.rows[0].state, 'failed');
    assert.ok(c.rows[0].error, 'the explanation must survive an ignored click');
});

test('retryAll does nothing while a run or a consent question is outstanding', async () => {
    const c = component();
    c.rows = UI.stepRows(P.planFor(['rclone'], 'debian'));
    c.rows[0].state = 'failed';
    c.rows[0].error = { remediation: 'retry' };
    c.busy = true;
    await c.retryAll();
    assert.equal(c.rows[0].state, 'failed');
    c.busy = false;
    c.consent = { tool: 'restic' };
    await c.retryAll();
    assert.equal(c.rows[0].state, 'failed');
});

// --------------------------------------------------- partial results

test('READ_ERRORS is a warning that names the files, never a failure', async () => {
    const e = Errors.create(Errors.KIND.READ_ERRORS,
        'some files could not be read',
        { unreadable: ['/var/lib/secret.db', '/home/ada/.gnupg/private-keys'] });
    const m = UI.packageKitMessage(e, null);
    assert.equal(m.severity, 'warning', 'a partial result must not be painted red');
    assert.ok(!/fail/i.test(m.title), m.title);
    assert.ok(!/fail/i.test(m.text), m.text);
    assert.match(m.text, /completed/i);
    assert.deepEqual(m.unreadable, ['/var/lib/secret.db', '/home/ada/.gnupg/private-keys']);
    assert.equal(m.remediation, 'list-unreadable');
    assert.equal(m.actionLabel, 'Show unreadable files');
});

test('a READ_ERRORS row finishes partial, not failed, and lists what was skipped', async () => {
    await withProvision({
        installStep: () => Promise.reject(Errors.create(Errors.KIND.READ_ERRORS,
            'unable to read 2 files', { unreadable: ['/proc/1/mem', '/sys/kernel/debug'] }))
    }, async () => {
        const c = component();
        c.rows = UI.stepRows(P.planFor(['rclone'], 'debian'));
        await c.installAll();
        const row = c.rows[0];
        assert.equal(row.state, 'partial');
        assert.notEqual(row.state, 'failed');
        assert.equal(UI.statusLabel(row.state), 'Finished with warnings');
        assert.deepEqual(c.failedRows(), [], 'a partial result is not a failure');
        assert.equal(row.error.severity, 'warning');
        assert.deepEqual(c.visibleUnreadable(row), ['/proc/1/mem', '/sys/kernel/debug']);
        assert.equal(c.moreUnreadable(row), 0);
        assert.deepEqual(c.retryableRows(), [row], 'but it can still be run again');
    });
});

test('retryAll picks up a partial row as well as a failed one', async () => {
    await withProvision({ installStep: () => Promise.resolve([]) }, async () => {
        const c = component();
        c.rows = UI.stepRows(P.planFor(['restic', 'rclone'], 'debian'));
        c.rows[0].state = 'partial';
        c.rows[0].error = { remediation: 'list-unreadable', unreadable: ['/x'] };
        c.rows[1].state = 'failed';
        c.rows[1].error = { remediation: 'retry' };
        await c.retryAll();
        assert.deepEqual(c.rows.map((r) => r.state), ['done', 'done']);
    });
});

test('a cancelled install is neutral: partial, warning-coloured, no action', async () => {
    await withProvision({
        installStep: () => Promise.reject(P.classifyPackageKitError(3, 'The transaction was cancelled'))
    }, async () => {
        const c = component();
        c.rows = UI.stepRows(P.planFor(['rclone'], 'debian'));
        await c.installAll();
        assert.equal(c.rows[0].state, 'partial');
        assert.equal(c.rows[0].error.severity, 'warning');
        assert.equal(c.rows[0].error.actionLabel, null);
    });
});

test('cancelling a packagekit install does not turn round and offer a download', async () => {
    // "Shall I download an unmanaged binary instead?" is not an answer to "stop".
    let asked = false;
    await withProvision({
        installStep: () => Promise.reject(P.classifyPackageKitError(3, 'cancelled while downloading packages')),
        installBinary: () => { asked = true; return Promise.resolve(); }
    }, async () => {
        const c = component();
        c.arch = 'amd64';
        c.rows = UI.stepRows(P.planFor(['restic'], 'rhel'));
        await c.installAll();
        assert.equal(c.consent, null, 'a cancellation must not become a download prompt');
        assert.equal(asked, false);
        assert.equal(c.rows[0].state, 'partial');
    });
});

test('a forged fatal flag cannot recolour a non-fatal kind', () => {
    const e = Errors.create(Errors.KIND.READ_ERRORS, 'x', null);
    e.fatal = true;
    assert.equal(UI.packageKitMessage(e, null).severity, 'warning');
});

// --------------------------------------------------- unreadable file lists

test('unreadableFrom accepts the shapes a detail can actually arrive in', () => {
    const mk = (detail) => Errors.create(Errors.KIND.READ_ERRORS, 'x', detail);
    assert.deepEqual(UI.unreadableFrom(mk(['/a', '/b'])), ['/a', '/b']);
    assert.deepEqual(UI.unreadableFrom(mk({ unreadable: ['/a'] })), ['/a']);
    assert.deepEqual(UI.unreadableFrom(mk({ files: ['/b'] })), ['/b']);
    assert.deepEqual(UI.unreadableFrom(mk({ paths: '/c\n/d' })), ['/c', '/d']);
    assert.deepEqual(UI.unreadableFrom(mk('/e\r\n/f')), ['/e', '/f']);
});

test('unreadableFrom trims, drops blanks and does not repeat a path', () => {
    const e = Errors.create(Errors.KIND.READ_ERRORS, 'x',
        { unreadable: ['  /a  ', '', '/a', null, undefined, '/b', '   '] });
    assert.deepEqual(UI.unreadableFrom(e), ['/a', '/b']);
});

test('unreadableFrom survives junk instead of throwing at render time', () => {
    assert.deepEqual(UI.unreadableFrom(null), []);
    assert.deepEqual(UI.unreadableFrom(undefined), []);
    assert.deepEqual(UI.unreadableFrom('a string'), []);
    assert.deepEqual(UI.unreadableFrom(new Error('no detail')), []);
    assert.deepEqual(UI.unreadableFrom({ detail: 42 }), []);
    assert.deepEqual(UI.unreadableFrom({ detail: { unreadable: 'just/one' } }), ['just/one']);
    const weird = { detail: { unreadable: [{ toString() { throw new Error('no'); } }, '/ok'] } };
    assert.deepEqual(UI.unreadableFrom(weird), ['/ok']);
});

test('an enormous unreadable list is capped and says how much it is hiding', () => {
    const many = [];
    for (let i = 0; i < 5000; i++) many.push('/data/file-' + i);
    const m = UI.packageKitMessage(Errors.create(Errors.KIND.READ_ERRORS, 'x', { unreadable: many }), null);
    assert.equal(m.unreadable.length, UI.MAX_UNREADABLE);
    assert.equal(m.unreadableMore, 5000 - UI.MAX_UNREADABLE);
});

test('the unreadable list unfolds instead of being truncated silently', async () => {
    const many = [];
    for (let i = 0; i < 40; i++) many.push('/data/file-' + i);
    await withProvision({
        installStep: () => Promise.reject(Errors.create(Errors.KIND.READ_ERRORS, 'x', { unreadable: many }))
    }, async () => {
        const c = component();
        c.rows = UI.stepRows(P.planFor(['rclone'], 'debian'));
        await c.installAll();
        const row = c.rows[0];
        assert.equal(c.visibleUnreadable(row).length, 10);
        assert.equal(c.moreUnreadable(row), 30);
        await c.runAction(row);
        assert.equal(row.state, 'partial', 'showing the list must not re-run anything');
        assert.equal(c.visibleUnreadable(row).length, 40);
        assert.equal(c.moreUnreadable(row), 0);
    });
});

test('unicode and newlines in a path survive into the list unmangled', () => {
    const paths = ['/srv/データ/写真.jpg', '/home/ada/"quoted".txt', "/home/ada/it's here"];
    const m = UI.packageKitMessage(Errors.create(Errors.KIND.READ_ERRORS, 'x', { unreadable: paths }), null);
    assert.deepEqual(m.unreadable, paths);
});

// --------------------------------------------------- table-lookup hostility

test('an inherited property is never mistaken for a status label', () => {
    ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']
        .forEach((k) => {
            assert.equal(UI.statusLabel(k, false), 'Not installed', k);
            assert.equal(UI.statusLabel(k, true), 'Waiting', k);
        });
});

test('an inherited property is never mistaken for a button label', () => {
    ['constructor', 'toString', 'hasOwnProperty', '__proto__']
        .forEach((k) => assert.equal(UI.actionLabel(k), null, k));
});

test('an inherited property is never mistaken for a reason', () => {
    ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']
        .forEach((k) => assert.equal(UI.reasonFor(k), '', k));
});

test('an error carrying an inherited kind still gets a real sentence', () => {
    const m = UI.packageKitMessage({ name: 'HangarError', kind: 'constructor', message: 'odd' }, null);
    assert.equal(typeof m.title, 'string');
    assert.equal(m.title, 'The installation did not complete');
    assert.equal(typeof m.text, 'string');
    assert.equal(m.severity, 'danger', 'an unrecognised kind is not a partial success');
});

test('the consent gate cannot be satisfied by an inherited property', async () => {
    // consentGiven['constructor'] is truthy on any object literal. The one thing
    // this gate must never do is answer "yes, they agreed" for an unasked question.
    let downloaded = false;
    await withProvision({
        installBinary: () => { downloaded = true; return Promise.resolve(); }
    }, async () => {
        const c = component();
        c.arch = 'amd64';
        c.rows = UI.stepRows([{ tool: 'constructor', method: BIN, packages: [], optional: true }]);
        assert.equal(c.rows.length, 1);
        await c.installAll();
        assert.equal(downloaded, false, 'nothing may download without an actual yes');
        assert.ok(c.consent, 'the question must still be asked');
        assert.equal(c.hasConsent('constructor'), false);
        assert.equal(c.hasConsent('toString'), false);
    });
});

// --------------------------------------------------- hostile step input

test('stepRows drops a step whose name cannot even be read', () => {
    const hostile = { tool: { toString() { throw new Error('nope'); } }, method: 'packagekit' };
    assert.doesNotThrow(() => UI.stepRows([hostile]));
    assert.deepEqual(UI.stepRows([hostile]), []);
});

test('stepRows copes with a package list that is not a list', () => {
    ['restic', 42, null, {}].forEach((p) => {
        const rows = UI.stepRows([{ tool: 'restic', method: 'packagekit', packages: p }]);
        assert.deepEqual(rows[0].packages, [], String(p));
    });
});

test('stepRows survives a deeply hostile plan without throwing', () => {
    const plan = [
        null, undefined, 0, '', false, [], {},
        { tool: '' }, { tool: '   ' }, { tool: 'restic' },
        { tool: 'rclone', packages: undefined, method: undefined }
    ];
    let rows;
    assert.doesNotThrow(() => { rows = UI.stepRows(plan); });
    assert.deepEqual(rows.map((r) => r.tool), ['   ', 'restic', 'rclone']);
});

test('a tool name with quotes, newlines and unicode is carried through verbatim', () => {
    const name = 'res"tic\n<script>☃';
    const rows = UI.stepRows([{ tool: name, method: BIN, packages: [] }]);
    assert.equal(rows[0].tool, name);
    assert.equal(rows[0].reason, '', 'an unknown tool gets no invented sentence');
    assert.ok(UI.consentText({ tool: name, method: BIN }).includes(name));
});

test('an enormous tool name does not break the consent wording', () => {
    const name = 'x'.repeat(100000);
    const text = UI.consentText({ tool: name, method: BIN, release: RELEASE });
    assert.ok(text.includes(name));
    assert.match(text, /Nothing is downloaded until you confirm this step\.$/);
});

// --------------------------------------------------- consent, hostile input

test('a release with no checksum source is treated as no release at all', () => {
    // "SHA256: undefined" beside a promise that the checksum is compared would be
    // an unverifiable download dressed up as a verified one.
    const text = UI.consentText({
        tool: 'restic', method: BIN,
        release: { url: 'https://example.invalid/restic.bz2', sha256Url: '' }
    });
    assert.ok(!/undefined/.test(text));
    assert.ok(!text.includes('https://example.invalid/restic.bz2'));
    assert.match(text, /nothing will be downloaded/);
});

test('a release with no URL is treated as no release at all', () => {
    const text = UI.consentText({ tool: 'restic', method: BIN, release: { sha256Url: 'https://x/SHA256SUMS' } });
    assert.ok(!/https:\/\//.test(text));
    assert.match(text, /could not work out which release asset/);
});

test('consent given but no verified URL still downloads nothing', async () => {
    let downloaded = false;
    await withProvision({
        installBinary: () => { downloaded = true; return Promise.resolve(); }
    }, async () => {
        const c = component();
        c.arch = null;                                  // no asset could be worked out
        c.rows = UI.stepRows(P.planFor(['restic'], 'martian'));
        c.consentGiven = { restic: true };              // as if a yes had been recorded
        await c.installAll();
        assert.equal(downloaded, false, 'a blind fetch is exactly what consent rules out');
        assert.equal(c.rows[0].state, 'failed');
        assert.match(c.rows[0].error.text, /package manager stopped|did not complete/i);
        assert.match(c.rows[0].error.detail, /release asset/);
    });
});

test('a binary install that fails is reported on the row', async () => {
    await withProvision({
        installBinary: () => Promise.reject(Errors.create(Errors.KIND.NETWORK, 'connection reset by peer'))
    }, async () => {
        const c = component();
        c.arch = 'amd64';
        c.rows = UI.stepRows(P.planFor(['restic'], 'martian'));
        await c.installAll();
        c.consent.accepted = true;
        await c.acceptConsent();
        assert.equal(c.rows[0].state, 'failed');
        assert.equal(c.rows[0].error.kind, Errors.KIND.NETWORK);
        assert.equal(c.rows[0].error.actionLabel, 'Retry');
        assert.equal(c.busy, false);
    });
});

test('a successful download clears the failure that led to it', async () => {
    await withProvision({
        installStep: () => Promise.reject(Errors.create(Errors.KIND.GENERIC,
            'restic is not available from any enabled repository.')),
        installBinary: () => Promise.resolve()
    }, async () => {
        const c = component();
        c.arch = 'amd64';
        c.rows = UI.stepRows(P.planFor(['restic'], 'rhel'));
        await c.installAll();
        assert.ok(c.rows[0].error, 'the blocked row explains why it is blocked');
        c.consent.accepted = true;
        await c.acceptConsent();
        assert.equal(c.rows[0].state, 'done');
        assert.equal(c.rows[0].error, null, 'a stale failure must not outlive a success');
    });
});

test('declining leaves no red alert on a choice the user made deliberately', async () => {
    await withProvision({
        installStep: () => Promise.reject(Errors.create(Errors.KIND.GENERIC,
            'restic is not available from any enabled repository.'))
    }, async () => {
        const c = component();
        c.arch = 'amd64';
        c.rows = UI.stepRows(P.planFor(['restic'], 'rhel'));
        await c.installAll();
        assert.ok(c.rows[0].error);
        c.declineConsent();
        assert.equal(c.rows[0].error, null);
        assert.match(c.rows[0].note, /cannot back anything up/i);
    });
});

// --------------------------------------------------- progress, hostile input

test('progressFrom never hands the template a width outside its track', () => {
    assert.equal(UI.progressFrom({}, -5), 0);
    assert.equal(UI.progressFrom({}, -1e9), 0);
    assert.equal(UI.progressFrom({}, 1e9), 100);
    assert.equal(UI.progressFrom({}, Infinity), 0);
    assert.equal(UI.progressFrom({}, -Infinity), 0);
    assert.equal(UI.progressFrom({ Percentage: 101 }, 250), 100);
});

test('progressFrom refuses every non-numeric percentage shape', () => {
    [[], {}, null, undefined, true, '50', { v: 50 }, { t: 'u' }, NaN, Infinity, -0.5, 100.5]
        .forEach((p) => {
            const v = UI.progressFrom({ Percentage: p }, 12);
            assert.ok(v >= 0 && v <= 100, String(p) + ' -> ' + v);
        });
    assert.equal(UI.progressFrom({ Percentage: [] }, 12), 12);
    assert.equal(UI.progressFrom({ Percentage: true }, 12), 12);
});

// --------------------------------------------------- the markup

const fs = require('node:fs');
const path = require('node:path');
const MODAL = fs.readFileSync(
    path.join(__dirname, '..', '..', 'html', 'modals', 'provision.html'), 'utf8');

test('the modal never calls the Logbook by any other name', () => {
    assert.ok(!/time\s*machine/i.test(MODAL));
});

test('everything clickable in the modal is a real button', () => {
    const clickable = [...MODAL.matchAll(/<([a-zA-Z][\w-]*)\b[^>]*@click=/g)].map((m) => m[1]);
    assert.ok(clickable.length > 0, 'the modal has no click handlers at all?');
    for (const tag of clickable)
        assert.ok(tag === 'button' || tag === 'a', `<${tag}> carries @click — use a real button`);
});

test('every button declares its type so none submits a form by accident', () => {
    const buttons = [...MODAL.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(buttons.length >= 6);
    for (const b of buttons) assert.match(b, /type="button"/, b);
});

test('a button with no text of its own carries an aria-label', () => {
    // btn-close renders as an icon; nothing else in this modal is icon-only.
    const icons = [...MODAL.matchAll(/<button\b[^>]*btn-close[^>]*>/g)].map((m) => m[0]);
    assert.equal(icons.length, 1);
    assert.match(icons[0], /aria-label="[^"]+"/);
});

test('every input is associated with a label', () => {
    const inputs = [...MODAL.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(inputs.length > 0);
    for (const input of inputs) {
        const id = /id="([^"]+)"/.exec(input);
        assert.ok(id, `input has no id to label: ${input}`);
        assert.ok(MODAL.includes(`for="${id[1]}"`), `no <label for="${id[1]}">`);
    }
});

test('the colour-only status dot is hidden from assistive technology', () => {
    const dots = [...MODAL.matchAll(/<span\b[^>]*hangar-dot[^>]*>/g)].map((m) => m[0]);
    assert.ok(dots.length > 0);
    for (const d of dots) assert.match(d, /aria-hidden="true"/);
});

test('the consent panel is instantiated, not merely hidden', () => {
    // x-model needs a real property. Under x-show the checkbox would still evaluate
    // consent.accepted while consent is null and take the component down with it.
    assert.match(MODAL, /<template x-if="consent">/);
    const model = /x-model="([^"]+)"/.exec(MODAL);
    assert.equal(model[1], 'consent.accepted');
    assert.ok(!/x-show="consent"[^>]*class="card/.test(MODAL));
});

test('the alert colour is bound to severity so a partial result cannot go red', () => {
    assert.match(MODAL, /row\.error\.severity === 'warning'/);
    assert.match(MODAL, /alert-warning/);
});

test('the markup renders the unreadable-file list', () => {
    assert.match(MODAL, /visibleUnreadable\(row\)/);
    assert.match(MODAL, /moreUnreadable\(row\)/);
});

test('the screen-level failure has somewhere to render and something to click', () => {
    assert.match(MODAL, /x-show="!loading && error"/);
    assert.match(MODAL, /retryOpen\(\)/);
    assert.match(MODAL, /x-show="!loading && !error && !rows\.length"/);
});

test('alerts announce themselves', () => {
    const alerts = [...MODAL.matchAll(/<div\b[^>]*class="[^"]*alert[^"]*"[^>]*>/g)].map((m) => m[0]);
    assert.ok(alerts.length >= 3);
    for (const a of alerts)
        assert.match(a, /role="(alert|status)"/, a);
});

test('finishing an install announces it so the rest of the page can re-probe', () => {
    // Without this the header chip and prerequisite banner keep showing what was
    // true at page load, so a successful install still reads as a failure.
    const c = UI.hangarProvisionUi();
    const seen = [];
    const prevDispatch = globalThis.dispatchEvent;
    const prevCustom = globalThis.CustomEvent;
    globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
    globalThis.dispatchEvent = (ev) => { seen.push(ev.type); return true; };
    try {
        assert.equal(c.announceInstalled(), true);
        assert.deepEqual(seen, ['hangar:provisioned']);
    } finally {
        globalThis.dispatchEvent = prevDispatch;
        globalThis.CustomEvent = prevCustom;
    }
});

test('announcing is a no-op rather than a crash with no event support', () => {
    const c = UI.hangarProvisionUi();
    const prevDispatch = globalThis.dispatchEvent;
    globalThis.dispatchEvent = undefined;
    try {
        assert.equal(c.announceInstalled(), false);
    } finally { globalThis.dispatchEvent = prevDispatch; }
});
