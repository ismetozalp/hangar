// features/rclone-ui.js — the "add a cloud destination" wizard.
//
// core/rclone.js knows how to CREATE an rclone remote. This file is the only
// thing that asks a human the questions, and it exists because the alternative
// was a documentation sentence telling the user to leave hangar, find a shell,
// and run `rclone config` — a text-mode wizard that asks thirty questions in an
// order nobody can predict.
//
// Three things shape the design.
//
// 1. The provider table is core/rclone.js's PROVIDERS, and NOTHING here repeats
//    it. Not the field list, not which field is a secret, not which providers
//    are OAuth. A provider added there appears here with its fields, its help
//    and its password masking already correct — because the one flag that keeps
//    a value out of argv (`type: 'password'`) is read, never re-declared.
//
// 2. The two setup experiences genuinely differ, so the user sees that BEFORE
//    choosing. Picking Dropbox commits you to running a command on your own
//    laptop; picking WebDAV does not. Presenting sixteen logos in one flat grid
//    would hide the only distinction that changes what the next five minutes
//    look like.
//
// 3. The token is never rendered back. It is held in a closure variable inside
//    the component factory rather than on the component object, so no template
//    expression can reach it even by accident, and it is dropped the moment the
//    remote exists. The pasted block is cleared from the textarea as soon as it
//    parses, for the same reason: a secret on screen is a secret in a
//    screenshot, in a screen share, and in the browser's form restore.
//
// 4. The wizard has a SECOND mode. When a destination's authorisation expires,
//    the way back is the same journey as creation — `rclone authorize` on the
//    user's own computer, token pasted back — because `rclone config reconnect`
//    re-enters the interactive flow, binds 127.0.0.1 on THIS machine and asks
//    questions on stdin. There is no non-interactive form. So reconnect mode is
//    this file's existing OAuth step pointed at a remote that already exists:
//    the provider and the name are read from rclone's config rather than asked
//    for, and the token goes to updateRemoteToken instead of createRemote.
//    Reusing the step is the point — a second paste box, drifting out of sync
//    with this one, is exactly the duplication this module refuses everywhere
//    else.
//
// Pure: the grouping, the step machine, the form descriptors, name suggestion
// and every validation message. The component below is the only impure part,
// and it touches cockpit only through HangarRclone and HangarProvision.
'use strict';
(function (root) {
    // Browser: index.html has already put the core modules on the global. Node:
    // require them, so the pure functions below are testable with no DOM.
    const req = (typeof require !== 'undefined' && typeof module !== 'undefined' && module.exports)
        ? require : null;

    const Errors = root.HangarErrors || (req ? req('../core/errors.js') : null);
    const Rclone = root.HangarRclone || (req ? req('../core/rclone.js') : null);
    const Secrets = root.HangarSecrets || (req ? req('../core/secrets.js') : null);
    const Prov = root.HangarProvision || (req ? req('../core/provision.js') : null);

    // ------------------------------------------------------------------ pure

    // The module's coercion boundary, so it has to be total: String() throws on a
    // null-prototype object, and every function below assumes it got a string.
    function str(v) {
        if (v === null || v === undefined) return '';
        try { return String(v); } catch (e) { return ''; }
    }

    function trimmed(v) {
        return str(v).trim();
    }

    // Own-property only. A provider field called "constructor" would otherwise
    // resolve to Object.prototype's and put a function body in a config value.
    function own(table, key) {
        return (table && typeof table === 'object' &&
            Object.prototype.hasOwnProperty.call(table, key)) ? table[key] : undefined;
    }

    // Events. The wizard is opened by an event and reports back with one, exactly
    // like the shared confirm/password dialogs — so the repository editor never
    // reaches into this component's scope, and vice versa.
    const EVENT_OPEN = 'hangar:rclone-remote';
    const EVENT_CREATED = 'hangar:rclone-remote-created';
    // Reported separately from EVENT_CREATED: nothing was created, and a screen
    // that reacted to this by adding a remote to its list would show a duplicate.
    const EVENT_RECONNECTED = 'hangar:rclone-remote-reconnected';
    const EVENT_PROVISION = 'hangar:provision';

    // The two things this dialog does. `reconnect` targets a remote that already
    // exists, so it asks neither for a provider nor for a name — both are read
    // out of rclone's own configuration, where they are already correct.
    const MODE = { CREATE: 'create', RECONNECT: 'reconnect' };

    function modeOf(detail) {
        const o = (detail && typeof detail === 'object') ? detail : {};
        return trimmed(o.reauthorize) !== '' ? MODE.RECONNECT : MODE.CREATE;
    }

    // What hangar asks its own provisioner to install when rclone is absent. The
    // wizard never names a package manager — that is provision.js's job across
    // six distro families.
    const PROVISION_TOOLS = ['rclone'];

    const MODAL_ID = 'hangar-rclone-remote';

    // --- provider grouping -------------------------------------------------
    //
    // Grouped by AUTH, not by popularity: the group is a promise about what the
    // next screen will ask for. "You will sign in in a browser, on your own
    // machine" versus "you will type a password here" is the single fact that
    // decides whether a user can finish right now.

    const GROUPS = [
        {
            id: 'oauth',
            label: 'Sign in with your account',
            hint: 'You approve hangar once in a browser. The browser is on your own computer and ' +
                'not on this server, so there is one command to run there — hangar shows it, and ' +
                'you paste the result back.'
        },
        {
            id: 'credentials',
            label: 'Sign in with a key, a username or a password',
            hint: 'Everything is typed here. Nothing has to be run on your own computer.'
        },
        {
            id: 'external',
            label: 'Set up with rclone, then come back',
            hint: 'rclone has no automated sign-in for these, so hangar cannot finish the job ' +
                'here. It shows you exactly what to run and then picks the remote up.'
        }
    ];

    // Total: this is called while rendering, and a card that cannot be built is a
    // card that is not shown — never a render that dies and takes the whole
    // wizard's markup with it.
    function providerCard(p) {
        if (!p || typeof p !== 'object') return null;
        try {
            return {
                id: p.id,
                label: p.label,
                type: p.type,
                auth: p.auth,
                oauth: p.auth === Rclone.AUTH.OAUTH,
                summary: Rclone.describeProvider(p.id)
            };
        } catch (e) {
            return null;
        }
    }

    // Every group carries its providers in table order. A group with no providers
    // is dropped rather than rendered empty — an empty heading reads as a bug.
    function providerGroups() {
        const all = Rclone.providers();
        return GROUPS.map(function (g) {
            return {
                id: g.id,
                label: g.label,
                hint: g.hint,
                providers: all.filter(function (p) { return p && p.auth === g.id; })
                    .map(providerCard).filter(function (c) { return c !== null; })
            };
        }).filter(function (g) { return g.providers.length > 0; });
    }

    // The group IS the auth kind — mapping anything unknown onto 'credentials'
    // is what would put a provider hangar cannot automate into a form that
    // pretends it can.
    function groupIdFor(providerId) {
        const p = Rclone.providerFor(providerId);
        if (!p) return '';
        const known = GROUPS.some(function (g) { return g.id === p.auth; });
        return known ? p.auth : '';
    }

    // Instructions for a provider rclone cannot authorize for us. Null for
    // everything else, so the template can bind on its presence.
    function externalSetupFor(providerId) {
        if (typeof Rclone.externalSetup !== 'function') return null;
        try { return Rclone.externalSetup(providerId); } catch (e) { return null; }
    }

    // --- the step machine --------------------------------------------------
    //
    // 'done' is deliberately outside the numbered steps: it is the outcome, not a
    // thing the user has to do, and counting it would make the progress read
    // "step 3 of 4" while the remote already exists.

    const STEP_LABEL = {
        provider: 'Choose a destination',
        details: 'Enter the credentials',
        authorize: 'Authorise on your own computer',
        // Reconnect only, and only for a backend rclone cannot authorize for us.
        instructions: 'Sign in with rclone itself',
        name: 'Name the remote',
        done: 'Ready'
    };

    function stepLabel(step) {
        return own(STEP_LABEL, str(step)) || '';
    }

    // Which middle step a provider gets is the ONLY branch in the wizard, and it
    // is derived from the table rather than from a list of provider ids here.
    //
    // Reconnect is one step, never three: the provider and the name of an
    // existing remote are already known, and asking a user to re-choose them is
    // asking them to re-derive facts hangar can read out of rclone's config —
    // and to get them wrong is to overwrite a working remote.
    function stepsFor(providerId, mode) {
        if (str(mode) === MODE.RECONNECT) {
            // Anything hangar cannot finish itself gets instructions instead of a
            // paste box. That covers Jottacloud (AUTH.EXTERNAL — `rclone
            // authorize jottacloud` answers "not supported by this backend") and
            // a remote whose backend is not in the provider table at all.
            return [Rclone.isOAuth(providerId) ? 'authorize' : 'instructions'];
        }
        if (!Rclone.providerFor(providerId)) return ['provider'];
        return ['provider', Rclone.isOAuth(providerId) ? 'authorize' : 'details', 'name'];
    }

    function stepIndex(providerId, step, mode) {
        return stepsFor(providerId, mode).indexOf(str(step));
    }

    function nextStep(providerId, step, mode) {
        const steps = stepsFor(providerId, mode);
        const i = steps.indexOf(str(step));
        if (i < 0 || i >= steps.length - 1) return null;
        return steps[i + 1];
    }

    function prevStep(providerId, step, mode) {
        const steps = stepsFor(providerId, mode);
        const i = steps.indexOf(str(step));
        if (i <= 0) return null;
        return steps[i - 1];
    }

    // --- form descriptors --------------------------------------------------

    // A render-ready copy of the provider's fields. The PROVIDERS table is deeply
    // frozen, so these have to be new objects — and building them here is also
    // where `type: 'password'` becomes `inputType: 'password'`, in one place,
    // rather than as a conditional repeated in the markup.
    function formFieldsFor(providerId) {
        const p = Rclone.providerFor(providerId);
        if (!p) return [];
        return p.fields.map(function (f) {
            const secret = Rclone.isSecretField(f);
            return {
                key: f.key,
                label: f.label,
                required: !!f.required,
                placeholder: str(f.placeholder),
                help: str(f.help),
                secret: secret,
                // 'select' keeps its own control; everything else is an <input>
                // whose type is the masking decision, taken from the table.
                control: f.type === 'select' ? 'select' : 'input',
                inputType: secret ? 'password' : 'text',
                // A browser that autofills a saved password into a field that
                // creates a NEW remote would silently store the wrong credential.
                autocomplete: secret ? 'new-password' : 'off',
                options: Array.isArray(f.options)
                    ? f.options.map(function (o) { return { value: o.value, label: o.label }; })
                    : [],
                domId: 'hangar-rclone-f-' + f.key
            };
        });
    }

    // Flat, all-strings: Alpine's x-model wants a stable key set, and a missing
    // key silently becomes `undefined` in the markup.
    function blankValues(providerId) {
        const out = {};
        formFieldsFor(providerId).forEach(function (f) { out[f.key] = ''; });
        return out;
    }

    // Which keys must be wiped once the remote exists. Derived, so a new secret
    // field is forgotten correctly by declaring it in the table, not by
    // remembering to add it to a list here.
    function secretKeys(providerId) {
        return formFieldsFor(providerId).filter(function (f) { return f.secret; })
            .map(function (f) { return f.key; });
    }

    // Called on the success path, after the remote already exists. A frozen or
    // otherwise unwritable values object must not turn "your remote is ready"
    // into an error alert, so the wipe of each key is independent and total —
    // one key that refuses to clear does not stop the others.
    function clearSecrets(providerId, values) {
        const v = (values && typeof values === 'object') ? values : {};
        secretKeys(providerId).forEach(function (k) {
            try {
                if (Object.prototype.hasOwnProperty.call(v, k)) v[k] = '';
            } catch (e) { /* a sealed or read-only key: keep wiping the rest */ }
        });
        return v;
    }

    function fieldProblems(providerId, values) {
        return Rclone.validateFields(providerId, values);
    }

    // --- naming ------------------------------------------------------------

    // A duplicate name is not a validation nicety: `rclone config create` on an
    // existing name overwrites that remote's configuration, which would break a
    // repository that is already backing up somewhere.
    function nameProblems(name, existing) {
        // Trimmed first: the wizard creates the remote under the trimmed name, so
        // validating the untrimmed one would reject a paste artefact the user
        // cannot see and that hangar was going to discard anyway.
        const wanted = trimmed(name);
        const problems = Rclone.validateRemoteName(wanted);
        const taken = (Array.isArray(existing) ? existing : []).map(trimmed);
        if (wanted !== '' && taken.indexOf(wanted) >= 0)
            problems.push('A remote called ' + wanted + ' already exists on this host. ' +
                'Choose another name — creating it again would overwrite the existing one.');
        return problems;
    }

    // The provider id is already a legal remote name and is what the user just
    // clicked, so it is the least surprising default. Suffixed rather than
    // rejected when taken, so the common "a second Drive account" case is one
    // keystroke instead of an error message.
    function suggestName(providerId, existing) {
        const p = Rclone.providerFor(providerId);
        if (!p) return '';
        const taken = (Array.isArray(existing) ? existing : []).map(trimmed);
        if (taken.indexOf(p.id) < 0) return p.id;
        for (let i = 2; i < 100; i++) {
            const candidate = p.id + '-' + i;
            if (taken.indexOf(candidate) < 0) return candidate;
        }
        return '';
    }

    // --- the headless OAuth story -----------------------------------------

    function authorizeCommandFor(providerId) {
        try {
            return Rclone.authorizeCommand(providerId);
        } catch (e) {
            // Unknown provider. The caller renders nothing rather than a command
            // that would fail when pasted.
            return '';
        }
    }

    // The one paragraph that decides whether this flow makes sense to the user.
    // Written as cause and effect, because "run it on your machine" without the
    // reason reads as an arbitrary hoop and gets skipped.
    const WHY_HEADLESS =
        'Signing in opens a consent page in a browser, and when you approve it the service sends ' +
        'the answer back to 127.0.0.1 — the machine that started the sign-in. Started here, the ' +
        'answer would go to this server\'s own 127.0.0.1, which your browser cannot reach. So the ' +
        'command runs on the computer you are sitting at, and you bring the result back.';

    function whyHeadless() {
        return WHY_HEADLESS;
    }

    // The three things the user does, in the order they do them. Kept as data so
    // the markup cannot renumber them and the test can assert the order.
    function authorizeSteps(providerId) {
        const cmd = authorizeCommandFor(providerId);
        if (cmd === '') return [];
        return [
            {
                n: 1,
                text: 'On your own computer — the one with the browser — run this in a terminal. ' +
                    'rclone has to be installed there too.',
                command: cmd
            },
            {
                n: 2,
                text: 'A link opens in your browser. Sign in and approve access. rclone then prints ' +
                    'a block of text between "Paste the following into your remote machine --->" ' +
                    'and "<---End paste".',
                command: ''
            },
            {
                n: 3,
                text: 'Copy that whole block and paste it below. The markers can stay in — hangar ' +
                    'strips them.',
                command: ''
            }
        ];
    }

    // rclone's own documentation says the built-in client IDs are shared by every
    // rclone user and rate-limited. Surfaced as its own object rather than
    // folded into help text, so the UI can give it a heading a user will read
    // before they choose to skip the field.
    function clientIdAdvice(providerId) {
        const p = Rclone.providerFor(providerId);
        if (!p || p.auth !== Rclone.AUTH.OAUTH) return null;
        return {
            provider: p.id,
            // Drive is the one where this is the difference between a backup that
            // finishes overnight and one that does not.
            severity: p.id === 'drive' ? 'warning' : 'info',
            title: p.id === 'drive'
                ? 'Google Drive is slow without your own client ID'
                : 'You can use your own app registration',
            text: p.notes
        };
    }

    function providerNote(providerId) {
        const p = Rclone.providerFor(providerId);
        return p ? str(p.notes) : '';
    }

    // --- the pasted token --------------------------------------------------

    function extractToken(paste) {
        return Rclone.parseAuthorizeOutput(paste);
    }

    // Says which of the three ways a paste can be wrong it is, because "invalid
    // token" sends the user back to re-run a command that worked.
    function tokenProblems(paste) {
        if (trimmed(paste) === '')
            return ['Paste the block that rclone authorize printed on your own computer.'];

        const token = extractToken(paste);
        if (token === null || trimmed(token) === '')
            return ['That paste does not contain an authorisation token. Copy everything rclone ' +
                'printed after "Paste the following into your remote machine --->", including the ' +
                'marker lines if that is easier.'];

        if (!Rclone.looksLikeToken(token))
            return ['That does not look like an rclone authorisation token — it may have been cut ' +
                'short by the terminal. Run the command again and copy the whole block.'];

        return [];
    }

    // --- messages ----------------------------------------------------------

    function successMessage(name, providerId) {
        const p = Rclone.providerFor(providerId);
        const label = p ? p.label : 'The destination';
        return label + ' is set up as the remote "' + trimmed(name) + '". ' +
            'It is now selectable as the remote of an rclone repository.';
    }

    function createdDetail(name, providerId) {
        const p = Rclone.providerFor(providerId);
        return { name: trimmed(name), provider: p ? p.id : '', type: p ? p.type : '' };
    }

    // --- reconnect copy ----------------------------------------------------
    //
    // Said as repair, not as setup. A user who arrives here did not ask to add a
    // destination — something broke, and the dialog has to open by agreeing with
    // them about what broke before it asks for anything.

    function reconnectTitle(remoteName) {
        const n = trimmed(remoteName);
        return n === '' ? 'Sign in again' : 'Sign in to ' + n + ' again';
    }

    function reconnectIntro(remoteName, providerId) {
        const p = Rclone.providerFor(providerId);
        const n = trimmed(remoteName) || 'this destination';
        const label = p ? p.label : 'The service';
        return label + ' has stopped accepting this server\'s sign-in for "' + n + '", so backups ' +
            'to it are failing. Signing in again is the whole fix — nothing else about the ' +
            'destination changes, and the next run works.';
    }

    // Why the same command as first-time setup, rather than the reconnect command
    // rclone documents. Stated once, here, because a user who has done this before
    // WILL have found `rclone config reconnect` and will wonder why hangar does
    // not just run it.
    function whyNotReconnect(remoteName) {
        const cmd = Rclone.reconnectCommand(remoteName);
        return 'rclone\'s own repair command' + (cmd ? ' (' + cmd + ')' : '') + ' re-enters the ' +
            'interactive sign-in: it opens a browser and waits for the answer on 127.0.0.1 of ' +
            'whichever machine runs it — this server, which you are not sitting at. There is no ' +
            'unattended form of it. So the way back is the same one you came in by.';
    }

    // For a backend rclone cannot authorize for us. `steps` comes from
    // core/rclone.js's externalSetup, so the instructions are the provider's, not
    // a second set written here that could disagree with the creation flow.
    function reconnectInstructions(providerId, remoteName) {
        const n = trimmed(remoteName);
        const external = externalSetupFor(providerId);
        if (external) {
            return {
                provider: external.provider,
                reason: external.reason + ' Its sign-in has to be renewed with rclone itself, on ' +
                    'this server.',
                steps: (external.steps || []).slice(),
                command: external.command,
                // The remote already exists, so `rclone config` is an edit of it
                // rather than a new one. Saying which name to pick is the step
                // people get wrong and end up with a second, half-configured remote.
                remote: n
            };
        }
        const p = Rclone.providerFor(providerId);
        return {
            provider: p ? p.id : '',
            reason: p
                ? p.label + ' signs in with credentials rather than a browser, so there is no ' +
                  'token to paste. Edit the remote and enter the current credentials.'
                : 'This remote uses a backend hangar does not know, so it cannot offer the right ' +
                  'sign-in. Repair it with rclone on this server.',
            steps: [
                'On this server run rclone config.',
                n === '' ? 'Choose the remote that is failing and edit it.'
                    : 'Choose "e" to edit an existing remote, then "' + n + '".',
                'Enter the current credentials, then come back here and test the repository.'
            ],
            command: 'rclone config',
            remote: n
        };
    }

    function reconnectSuccessMessage(remoteName, providerId) {
        const p = Rclone.providerFor(providerId);
        const n = trimmed(remoteName) || 'the destination';
        return (p ? p.label : 'The destination') + ' accepted the new sign-in for "' + n + '". ' +
            'Nothing else about the remote was touched — its settings, and every other remote ' +
            'in rclone\'s configuration, are exactly as they were.';
    }

    // The re-test after a successful reconnect. "It should work now" is what this
    // exists to avoid: the user is shown the repository actually answering.
    const VERIFY = {
        IDLE: '',
        RUNNING: 'running',
        OK: 'ok',
        FAILED: 'failed'
    };

    function verifyMessage(state, message) {
        switch (str(state)) {
        case VERIFY.RUNNING: return 'Checking that the repository answers…';
        case VERIFY.OK: return trimmed(message) || 'The repository answered. Backups will run as scheduled.';
        case VERIFY.FAILED:
            return 'The sign-in was saved, but the repository still did not answer: ' +
                (trimmed(message) || 'no reason was reported.');
        default: return '';
        }
    }

    const MISSING_RCLONE = {
        title: 'rclone is not installed on this host',
        text: 'rclone is what actually talks to the cloud service — restic runs it for every ' +
            'backup to this destination. Hangar can install it for you.',
        actionLabel: 'Install rclone'
    };

    function missingRcloneMessage() {
        return { title: MISSING_RCLONE.title, text: MISSING_RCLONE.text, actionLabel: MISSING_RCLONE.actionLabel };
    }

    function scrub(text) {
        const s = str(text);
        if (s === '' || !Secrets || typeof Secrets.redact !== 'function') return s;
        return str(Secrets.redact(s));
    }

    // A typed error becomes an alert. BOTH halves are redacted before they are
    // shown: rclone reports failures as prose on stderr and classifyRcloneError
    // puts that prose in `message`, so the credential rclone was given comes back
    // in the message as often as in the detail — `Failed to create file system
    // for "nc:": ... https://alice:hunter2@cloud/dav` is one connection error
    // away. An alert is a screenshot waiting to happen.
    function toAlert(e, context) {
        if (!e) return null;
        // Total: this runs inside the catch that is already handling a failure,
        // and an alert builder that throws replaces a message the user could act
        // on with a dead dialog and an unhandled rejection.
        try {
            const fatal = Errors.isFatal(e);
            const raw = (Errors.isHangarError(e) && e.detail && typeof e.detail === 'object')
                ? str(e.detail.stderr) : '';
            return {
                level: fatal ? 'danger' : 'warning',
                kind: Errors.isHangarError(e) ? e.kind : Errors.KIND.UNKNOWN,
                context: str(context),
                message: scrub(e.message) || 'Something went wrong.',
                detail: raw === '' ? '' : scrub(raw).slice(-2000)
            };
        } catch (inner) {
            // Nothing about `e` can be quoted — reading it is what just failed.
            return {
                level: 'danger',
                kind: Errors.KIND.UNKNOWN,
                context: str(context),
                message: 'Something went wrong.',
                detail: ''
            };
        }
    }

    // ------------------------------------------------------------------- DOM

    // Every DOM touch is guarded: under node there is no document, and the
    // component must stay constructible without one.
    function showModal(id) {
        const el = root.document && root.document.getElementById(id);
        if (!el || !root.bootstrap) return null;
        const m = root.bootstrap.Modal.getOrCreateInstance(el);
        m.show();
        return m;
    }

    function hideModal(id) {
        const el = root.document && root.document.getElementById(id);
        if (!el || !root.bootstrap) return;
        root.bootstrap.Modal.getOrCreateInstance(el).hide();
    }

    // Bootstrap closes a modal on Escape and on a backdrop click without any of
    // our buttons being pressed, so close() is NOT the only way out — and a
    // password or a token would otherwise sit in component state for as long as
    // the page is open. Every dismissal ends in 'hidden.bs.modal', so that is
    // what the wipe hangs off.
    function onModalHidden(id, fn) {
        const el = root.document && typeof root.document.getElementById === 'function'
            ? root.document.getElementById(id) : null;
        if (!el || typeof el.addEventListener !== 'function') return false;
        el.addEventListener('hidden.bs.modal', fn);
        return true;
    }

    function dispatch(name, detail) {
        if (typeof root.dispatchEvent !== 'function' || typeof root.CustomEvent !== 'function')
            return false;
        root.dispatchEvent(new root.CustomEvent(name, { detail: detail }));
        return true;
    }

    // ------------------------------------------------------------- component

    function hangarRcloneUi() {
        // Deliberately a closure variable and NOT a property of the returned
        // object: nothing a template can name reaches it, so the token cannot be
        // rendered, logged by a debug dump of the component, or restored by the
        // browser. It is cleared the moment the remote exists.
        let token = '';

        // Also a closure: the caller hands in how to prove the repository works
        // again (repos-ui runs its own connection test, overview re-reads the
        // repository's health). Holding a function on the component would put a
        // caller's closure inside Alpine's reactive proxy for no reason.
        let verify = null;

        return {
            step: 'provider',
            mode: MODE.CREATE,
            // The remote being repaired. A name only — never a credential.
            remote: '',
            // Which repository the caller was looking at, echoed back so the
            // screen that opened this dialog can re-test the right one.
            repoId: '',
            verifyState: VERIFY.IDLE,
            verifyDetail: '',
            providerId: '',
            values: {},
            paste: '',
            // Only ever a boolean. The token itself lives in the closure above.
            hasToken: false,
            name: '',
            existing: [],
            problems: [],
            alert: null,
            busy: false,
            created: '',
            copied: false,
            // Assume present until told otherwise: a wizard that flashes "rclone
            // is missing" before the probe answers is worse than one that waits.
            rclone: { checked: false, present: true },

            init() {
                // Registered before the guard below, and separately from it: the
                // wipe must survive a window with no event plumbing, because a
                // dialog closed by Escape is the commonest way this wizard is
                // abandoned halfway through typing a password.
                onModalHidden(MODAL_ID, () => { this.forget(); });
                if (typeof root.addEventListener !== 'function') return false;
                root.addEventListener(EVENT_OPEN, (ev) => { this.open((ev && ev.detail) || {}); });
                // The provisioner announces success globally; re-probe rather than
                // assume, since the user may also have installed rclone in a shell.
                root.addEventListener('hangar:provisioned', () => { this.checkRclone(); });
                return true;
            },

            // `detail.existing` is the remote list the caller already has, used to
            // reject a duplicate name before rclone silently overwrites a remote.
            //
            // `detail.reauthorize` is the name of an EXISTING remote, and it puts
            // the dialog into repair mode instead: same OAuth step, no provider
            // choice, no naming.
            async open(detail) {
                const o = (detail && typeof detail === 'object') ? detail : {};
                this.reset();
                this.existing = Array.isArray(o.existing) ? o.existing.map(trimmed) : [];
                if (modeOf(o) === MODE.RECONNECT) return this.openReconnect(o);
                showModal(MODAL_ID);
                await this.checkRclone();
            },

            // Repair mode. The provider is not asked for — it is read from
            // rclone's own configuration, which is the only place that cannot be
            // wrong about what this remote is. A remote we cannot identify still
            // opens the dialog: it gets instructions rather than a token box,
            // because the alternative is a screen that says nothing at all.
            async openReconnect(detail) {
                const o = (detail && typeof detail === 'object') ? detail : {};
                this.mode = MODE.RECONNECT;
                this.remote = trimmed(o.reauthorize);
                this.repoId = trimmed(o.repoId);
                verify = typeof o.verify === 'function' ? o.verify : null;
                this.providerId = '';
                // Deliberately no step until rclone's config has answered: the two
                // possible steps are a token paste and "hangar cannot do this for
                // you", and flashing the wrong one of those is worse than a moment
                // with neither.
                this.step = '';
                showModal(MODAL_ID);
                await this.checkRclone();
                try {
                    const p = await Rclone.providerOfRemote(this.remote);
                    this.providerId = (p && p.id) ? p.id : '';
                } catch (e) {
                    // Not fatal, and deliberately not an alert: the instructions
                    // step below is a correct answer for "hangar could not tell
                    // what this remote is", and a red box on top of it would send
                    // the user looking for a second problem.
                    this.providerId = '';
                }
                this.step = stepsFor(this.providerId, MODE.RECONNECT)[0];
                return this.step;
            },

            reset() {
                token = '';
                verify = null;
                this.step = 'provider';
                this.mode = MODE.CREATE;
                this.remote = '';
                this.repoId = '';
                this.verifyState = VERIFY.IDLE;
                this.verifyDetail = '';
                this.providerId = '';
                this.values = {};
                this.paste = '';
                this.hasToken = false;
                this.name = '';
                this.problems = [];
                this.alert = null;
                this.busy = false;
                this.created = '';
                this.copied = false;
            },

            // Never rejects: "I could not tell" must not leave the wizard stuck on
            // a spinner, and an absent rclone is an ordinary state to report.
            async checkRclone() {
                try {
                    const r = await Prov.probe('rclone');
                    this.rclone = { checked: true, present: !!(r && r.present) };
                } catch (e) {
                    // A probe that throws is not evidence of absence, and blocking
                    // the wizard on it would be a guess. createRemote will produce
                    // a real, typed error if rclone truly is not there.
                    this.rclone = { checked: true, present: true };
                }
                return this.rclone;
            },

            // hangar installs its own prerequisites; it never tells the user to run
            // a package manager. provision-ui.js owns the whole flow.
            installRclone() {
                return dispatch(EVENT_PROVISION, PROVISION_TOOLS.slice());
            },

            missing() {
                return this.rclone.checked && !this.rclone.present;
            },

            missingMessage() {
                return missingRcloneMessage();
            },

            // --- navigation ------------------------------------------------

            groups() {
                return providerGroups();
            },

            steps() {
                return stepsFor(this.providerId, this.mode);
            },

            reconnecting() {
                return this.mode === MODE.RECONNECT;
            },

            // The dialog is a repair, so it says so in the one place a screen
            // reader announces on open.
            title() {
                return this.reconnecting()
                    ? reconnectTitle(this.remote)
                    : 'Add a cloud destination';
            },

            intro() {
                return this.reconnecting() ? reconnectIntro(this.remote, this.providerId) : '';
            },

            whyNotReconnect() {
                return whyNotReconnect(this.remote);
            },

            instructions() {
                return reconnectInstructions(this.providerId, this.remote);
            },

            stepNumber() {
                // 'done' is the outcome, not a fourth thing to do — so it reads as
                // the last step completed rather than "step 0 of 3".
                if (this.step === 'done') return this.stepCount();
                const i = stepIndex(this.providerId, this.step, this.mode);
                return i < 0 ? 1 : i + 1;
            },

            stepCount() {
                return this.steps().length;
            },

            stepTitle() {
                return stepLabel(this.step);
            },

            at(step) {
                return this.step === str(step);
            },

            provider() {
                return Rclone.providerFor(this.providerId);
            },

            providerLabel() {
                const p = this.provider();
                return p ? p.label : '';
            },

            fields() {
                return formFieldsFor(this.providerId);
            },

            // Choosing a provider resets the answers rather than carrying them
            // across: two backends that both have a key called `user` do not mean
            // the same thing by it, and a silently reused password is a support
            // call nobody can reproduce.
            choose(id) {
                const p = Rclone.providerFor(id);
                if (!p) {
                    this.problems = ['Choose a destination to continue.'];
                    return false;
                }
                token = '';
                this.providerId = p.id;
                this.values = blankValues(p.id);
                this.paste = '';
                this.hasToken = false;
                this.name = suggestName(p.id, this.existing);
                this.problems = [];
                this.alert = null;
                this.step = nextStep(p.id, 'provider') || 'name';
                return true;
            },

            back() {
                const prev = prevStep(this.providerId, this.step, this.mode);
                if (!prev) return false;
                this.problems = [];
                this.alert = null;
                this.step = prev;
                return true;
            },

            // Advances only when this step is actually answered. Each branch sets
            // `problems`, which is the announced summary in the markup — a silent
            // refusal to advance reads as a broken button.
            next() {
                this.problems = [];

                // Repair mode has exactly one step, so "Continue" would have
                // nowhere to go. The token is accepted by the submit button.
                if (this.reconnecting()) return false;

                if (this.step === 'provider') {
                    if (!this.provider()) {
                        this.problems = ['Choose a destination to continue.'];
                        return false;
                    }
                    this.step = nextStep(this.providerId, 'provider') || 'name';
                    return true;
                }

                if (this.step === 'details' || this.step === 'authorize') {
                    const problems = fieldProblems(this.providerId, this.values);
                    if (problems.length) {
                        this.problems = problems;
                        return false;
                    }
                    // The token is the whole point of the OAuth step; without it
                    // the remote would be created unauthenticated and fail at the
                    // first backup, hours later, in a unit nobody is watching.
                    if (this.step === 'authorize' && !this.hasToken && !this.acceptPaste())
                        return false;
                    this.step = 'name';
                    return true;
                }

                return false;
            },

            // --- the pasted authorisation ---------------------------------

            authorizeCommand() {
                return authorizeCommandFor(this.providerId);
            },

            authorizeSteps() {
                return authorizeSteps(this.providerId);
            },

            whyHeadless() {
                return whyHeadless();
            },

            advice() {
                return clientIdAdvice(this.providerId);
            },

            note() {
                return providerNote(this.providerId);
            },

            // Accepting a paste immediately empties the textarea. The token is
            // held in the closure; the UI only ever learns that there IS one.
            acceptPaste() {
                const problems = tokenProblems(this.paste);
                if (problems.length) {
                    this.problems = problems;
                    this.hasToken = false;
                    return false;
                }
                token = str(extractToken(this.paste));
                this.paste = '';
                this.hasToken = true;
                this.problems = [];
                return true;
            },

            // "Paste a different one" — forgets the token without revealing it.
            clearToken() {
                token = '';
                this.hasToken = false;
                this.paste = '';
                this.problems = [];
                return true;
            },

            async copyCommand() {
                this.copied = false;
                const text = this.authorizeCommand();
                if (text === '') return false;
                try {
                    if (root.navigator && root.navigator.clipboard &&
                        typeof root.navigator.clipboard.writeText === 'function') {
                        await root.navigator.clipboard.writeText(text);
                        this.copied = true;
                        return true;
                    }
                } catch (e) {
                    // The command is on screen to select by hand; a clipboard the
                    // browser refuses is not a failure of the wizard.
                }
                return false;
            },

            // --- creation --------------------------------------------------

            nameProblems() {
                return nameProblems(this.name, this.existing);
            },

            canCreate() {
                if (this.busy || this.missing()) return false;
                if (!this.provider()) return false;
                if (Rclone.isOAuth(this.providerId) && !this.hasToken) return false;
                return trimmed(this.name) !== '';
            },

            // Repair mode's own gate. It deliberately does NOT require the token
            // to have been accepted already — pressing the one obvious button
            // with text in the paste box accepts it first, because a user who has
            // just pasted a block does not expect a second button to be the real
            // one.
            canReconnect() {
                if (this.busy || this.missing()) return false;
                if (!this.reconnecting() || this.remote === '') return false;
                if (!Rclone.isOAuth(this.providerId)) return false;
                return this.hasToken || trimmed(this.paste) !== '';
            },

            // Impure. Replaces ONLY this remote's token line; everything else in
            // rclone's configuration — this remote's client id and scope, every
            // other remote, the comments — is left byte for byte by
            // mergeConfigSection. The token goes through updateRemoteToken, which
            // keeps it off argv.
            async reconnect() {
                if (this.busy) return false;
                if (!this.hasToken && !this.acceptPaste()) return false;

                this.alert = null;
                this.problems = [];
                this.busy = true;
                const name = trimmed(this.remote);
                try {
                    await Rclone.updateRemoteToken(name, token);
                    // Forget the token before anything else can go wrong: rclone's
                    // config now holds it, and this component has no further use
                    // for it.
                    this.forget();
                    this.created = name;
                    this.step = 'done';
                    dispatch(EVENT_RECONNECTED, { name: name, repoId: this.repoId,
                        provider: this.providerId });
                    // Then prove it. Being told a destination "should work now" is
                    // what sends people away to find out at 03:00 that it does not.
                    await this.runVerify();
                    return true;
                } catch (e) {
                    this.alert = toAlert(e, 'Sign in again');
                    return false;
                } finally {
                    this.busy = false;
                }
            },

            // Never rejects and never throws: the sign-in HAS been saved by the
            // time this runs, and a failing check must not read as a failed
            // repair. It reports what it found and leaves the dialog usable.
            async runVerify() {
                if (typeof verify !== 'function') {
                    this.verifyState = VERIFY.IDLE;
                    this.verifyDetail = '';
                    return VERIFY.IDLE;
                }
                this.verifyState = VERIFY.RUNNING;
                this.verifyDetail = '';
                try {
                    const r = await verify();
                    this.verifyState = VERIFY.OK;
                    this.verifyDetail = scrub(r && r.message);
                } catch (e) {
                    this.verifyState = VERIFY.FAILED;
                    // Redacted like every other error here: a restic or rclone
                    // failure routinely quotes a URL with credentials in it.
                    this.verifyDetail = scrub(e && e.message);
                }
                return this.verifyState;
            },

            verifyText() {
                return verifyMessage(this.verifyState, this.verifyDetail);
            },

            verifyClass() {
                if (this.verifyState === VERIFY.OK) return 'text-success';
                if (this.verifyState === VERIFY.FAILED) return 'text-warning-emphasis';
                return 'text-secondary';
            },

            async submit() {
                if (this.reconnecting()) return this.reconnect();
                if (this.busy) return false;
                this.problems = this.nameProblems();
                if (this.problems.length) return false;

                this.alert = null;
                this.busy = true;
                const name = trimmed(this.name);
                try {
                    const result = await Rclone.createRemote(name, this.providerId, this.values, token);
                    this.created = str(result && result.name) || name;
                    // Forget every secret before anything else can go wrong: the
                    // remote exists now, and this component has no further use for
                    // any of them.
                    this.forget();
                    this.step = 'done';
                    // Tell the repository editor, so the user lands back on the
                    // form they left with the new remote already selected.
                    dispatch(EVENT_CREATED, createdDetail(this.created, this.providerId));
                    return true;
                } catch (e) {
                    this.alert = toAlert(e, 'Add a cloud destination');
                    return false;
                } finally {
                    this.busy = false;
                }
            },

            // Values are cleared in place so Alpine keeps the same key set — a
            // replaced object would leave x-model bound to a detached one.
            forget() {
                token = '';
                this.hasToken = false;
                this.paste = '';
                clearSecrets(this.providerId, this.values);
                return true;
            },

            successMessage() {
                return this.reconnecting()
                    ? reconnectSuccessMessage(this.created || this.remote, this.providerId)
                    : successMessage(this.created, this.providerId);
            },

            doneTitle() {
                return this.reconnecting() ? 'Signed in again.' : 'Destination added.';
            },

            // --- display ---------------------------------------------------

            alertClass(alert) {
                return alert ? 'alert alert-' + alert.level : 'alert alert-secondary';
            },

            close() {
                // Nothing sensitive may outlive the dialog, whether it was
                // finished or abandoned halfway through.
                this.forget();
                hideModal(MODAL_ID);
                return true;
            }
        };
    }

    root.hangarRcloneUi = hangarRcloneUi;

    const HangarRcloneUi = {
        EVENT_OPEN, EVENT_CREATED, EVENT_RECONNECTED, EVENT_PROVISION, PROVISION_TOOLS, MODAL_ID,
        GROUPS, STEP_LABEL, WHY_HEADLESS, MODE, VERIFY,
        providerGroups, groupIdFor, externalSetupFor, providerCard, modeOf,
        stepLabel, stepsFor, stepIndex, nextStep, prevStep,
        formFieldsFor, blankValues, secretKeys, clearSecrets, fieldProblems,
        nameProblems, suggestName,
        authorizeCommandFor, whyHeadless, authorizeSteps, clientIdAdvice, providerNote,
        extractToken, tokenProblems,
        successMessage, createdDetail, missingRcloneMessage, toAlert,
        reconnectTitle, reconnectIntro, whyNotReconnect, reconnectInstructions,
        reconnectSuccessMessage, verifyMessage,
        hangarRcloneUi
    };
    root.HangarRcloneUi = HangarRcloneUi;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarRcloneUi;
})(typeof window !== 'undefined' ? window : globalThis);
