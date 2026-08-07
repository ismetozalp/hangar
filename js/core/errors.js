// core/errors.js — typed error kinds shared by every hangar module.
//
// House pattern: IIFE assigning to root.HangarXxx with a dual module.exports so
// the pure logic is directly loadable by `node --test` without a DOM.
//
// The whole point of this module is that a failure becomes an ACTION in the UI,
// not a toast. `kind` drives which remediation the user is offered, so kinds are
// deliberately narrow and exhaustive rather than free-form strings.
'use strict';
(function (root) {
    // Exhaustive set. Anything unmapped becomes UNKNOWN — never a silent success.
    const KIND = {
        OK: 'OK',
        GENERIC: 'GENERIC',
        GO_RUNTIME: 'GO_RUNTIME',
        READ_ERRORS: 'READ_ERRORS',
        REPO_MISSING: 'REPO_MISSING',
        REPO_LOCKED: 'REPO_LOCKED',
        WRONG_PASSWORD: 'WRONG_PASSWORD',
        CANCELLED: 'CANCELLED',
        NO_SPACE: 'NO_SPACE',
        NETWORK: 'NETWORK',
        // A cloud destination whose OAuth authorisation has lapsed: the refresh
        // token expired, was revoked, or (Box) timed out after 60 days of
        // inactivity. Deliberately its own kind rather than a flavour of NETWORK
        // or GENERIC, because it is the only failure here that a user can fix
        // completely in two minutes — and because retrying it, which is what
        // NETWORK invites, will fail every night until someone re-authorises.
        AUTH_EXPIRED: 'AUTH_EXPIRED',
        // Cockpit is running this page with limited access, so every read of
        // /etc/hangar is refused. Its own kind because it is indistinguishable
        // from "nothing is configured yet" at the call site, and reporting it as
        // that told a user with a working repository that they had none — the
        // worst possible lie for a backup tool to tell.
        ADMIN_REQUIRED: 'ADMIN_REQUIRED',
        UNKNOWN: 'UNKNOWN'
    };

    // READ_ERRORS is deliberately not fatal: restic exit 3 means the snapshot was
    // written but some files could not be read. Reporting that as "failed" would
    // train users to ignore real failures.
    const NON_FATAL = new Set([KIND.OK, KIND.READ_ERRORS, KIND.CANCELLED]);

    // Remediation offered in the UI for each kind. `null` means "no one-click fix".
    const REMEDIATION = {
        [KIND.REPO_LOCKED]: 'unlock',
        [KIND.WRONG_PASSWORD]: 'reprompt',
        [KIND.REPO_MISSING]: 'init',
        [KIND.READ_ERRORS]: 'list-unreadable',
        [KIND.NO_SPACE]: 'free-space',
        [KIND.NETWORK]: 'retry',
        // AUTH_EXPIRED is fatal — the backup did not happen — but it is the most
        // recoverable failure hangar has, so the remediation carries more weight
        // than the severity: the user signs in again and the next run works.
        // Note this is NOT 'retry': re-running a backup against a destination
        // whose token has expired fails identically, every night, in silence.
        [KIND.AUTH_EXPIRED]: 'reauthorize',
        // Not 'retry': the next read is refused exactly like the last one until
        // the user turns on administrative access in Cockpit's own header.
        [KIND.ADMIN_REQUIRED]: 'grant-access'
    };

    function create(kind, message, detail) {
        const e = new Error(message || kind);
        e.name = 'HangarError';
        e.kind = KIND[kind] ? kind : KIND.UNKNOWN;
        e.detail = detail === undefined ? null : detail;
        e.fatal = !NON_FATAL.has(e.kind);
        e.remediation = REMEDIATION[e.kind] || null;
        return e;
    }

    function isHangarError(e) {
        return !!e && e.name === 'HangarError' && typeof e.kind === 'string';
    }

    function isFatal(e) {
        if (!isHangarError(e)) return true;   // unknown failures are fatal by default
        return e.fatal;
    }

    function remediationFor(e) {
        return isHangarError(e) ? e.remediation : null;
    }

    const HangarErrors = { KIND, NON_FATAL, REMEDIATION, create, isHangarError, isFatal, remediationFor };
    root.HangarErrors = HangarErrors;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarErrors;
})(typeof window !== 'undefined' ? window : globalThis);
