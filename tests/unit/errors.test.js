// Unit tests for js/core/errors.js — the typed-error contract every module relies on.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../js/core/errors.js');

test('KIND is exhaustive and self-consistent', () => {
    const expected = ['OK', 'GENERIC', 'GO_RUNTIME', 'READ_ERRORS', 'REPO_MISSING',
        'REPO_LOCKED', 'WRONG_PASSWORD', 'CANCELLED', 'NO_SPACE', 'NETWORK', 'UNKNOWN'];
    assert.deepEqual(Object.keys(E.KIND).sort(), expected.slice().sort());
    // Every key maps to itself — callers pass kind strings around freely.
    for (const k of Object.keys(E.KIND)) assert.equal(E.KIND[k], k);
});

test('create() produces a HangarError carrying kind, detail and fatality', () => {
    const e = E.create('REPO_LOCKED', 'locked', { repo: 'main' });
    assert.equal(e.name, 'HangarError');
    assert.equal(e.kind, 'REPO_LOCKED');
    assert.deepEqual(e.detail, { repo: 'main' });
    assert.ok(e instanceof Error);
    assert.equal(e.fatal, true);
});

test('create() falls back to UNKNOWN for an unrecognised kind', () => {
    const e = E.create('NOT_A_REAL_KIND', 'x');
    assert.equal(e.kind, 'UNKNOWN');
});

test('create() defaults message to the kind and detail to null', () => {
    const e = E.create('NETWORK');
    assert.equal(e.message, 'NETWORK');
    assert.equal(e.detail, null);
});

test('READ_ERRORS is non-fatal — a partial backup must not read as failure', () => {
    // This is the single most important behavioural assertion in the module: restic
    // exit 3 means the snapshot WAS written. Treating it as failure trains users to
    // ignore real failures.
    const e = E.create('READ_ERRORS', 'some files unreadable');
    assert.equal(e.fatal, false);
    assert.equal(E.isFatal(e), false);
});

test('CANCELLED and OK are non-fatal; everything else is fatal', () => {
    for (const k of Object.keys(E.KIND)) {
        const e = E.create(k, k);
        const shouldBeFatal = !['OK', 'READ_ERRORS', 'CANCELLED'].includes(k);
        assert.equal(e.fatal, shouldBeFatal, k + ' fatality');
    }
});

test('isFatal() treats non-Hangar errors as fatal by default', () => {
    assert.equal(E.isFatal(new Error('plain')), true);
    assert.equal(E.isFatal(null), true);
    assert.equal(E.isFatal(undefined), true);
    assert.equal(E.isFatal('a string'), true);
    assert.equal(E.isFatal({ kind: 'OK' }), true);   // shape alone is not enough
});

test('isHangarError() only accepts genuine hangar errors', () => {
    assert.equal(E.isHangarError(E.create('OK')), true);
    assert.equal(E.isHangarError(new Error('x')), false);
    assert.equal(E.isHangarError({ name: 'HangarError' }), false);  // missing kind
    assert.equal(E.isHangarError({ name: 'HangarError', kind: 'OK' }), true);
    assert.equal(E.isHangarError(null), false);
    assert.equal(E.isHangarError(0), false);
});

test('remediation maps the kinds the UI can offer a one-click fix for', () => {
    assert.equal(E.create('REPO_LOCKED').remediation, 'unlock');
    assert.equal(E.create('WRONG_PASSWORD').remediation, 'reprompt');
    assert.equal(E.create('REPO_MISSING').remediation, 'init');
    assert.equal(E.create('READ_ERRORS').remediation, 'list-unreadable');
    assert.equal(E.create('NO_SPACE').remediation, 'free-space');
    assert.equal(E.create('NETWORK').remediation, 'retry');
    // No pretend fix for these.
    assert.equal(E.create('GENERIC').remediation, null);
    assert.equal(E.create('GO_RUNTIME').remediation, null);
    assert.equal(E.create('UNKNOWN').remediation, null);
});

test('remediationFor() is null for foreign errors', () => {
    assert.equal(E.remediationFor(new Error('x')), null);
    assert.equal(E.remediationFor(null), null);
});

test('detail accepts falsy values without becoming null', () => {
    assert.equal(E.create('GENERIC', 'm', 0).detail, 0);
    assert.equal(E.create('GENERIC', 'm', '').detail, '');
    assert.equal(E.create('GENERIC', 'm', false).detail, false);
});

test('errors are throwable and catchable as ordinary Errors', () => {
    assert.throws(() => { throw E.create('REPO_MISSING', 'no repo'); }, (err) => {
        return err instanceof Error && err.kind === 'REPO_MISSING' && err.message === 'no repo';
    });
});
