// core/rclone.js — create an rclone remote from inside hangar.
//
// The gap this fills: repos.js already understands `rclone:remote:path`, and
// repos-ui already lists the remotes rclone knows about. What nobody could do
// was MAKE one without dropping to a shell and running `rclone config`.
//
// Two hard constraints shape everything below.
//
// 1. Secrets must never reach argv. /proc/<pid>/cmdline is world-readable, so a
//    password or an OAuth token passed as an argument is visible in `ps` to every
//    user on the box for as long as the process lives — and to anything sampling
//    /proc. `rclone config create` takes its values as positional arguments and
//    offers no stdin or file channel for them (verified against rclone 1.74.3:
//    `--continue`/`--result` puts the answer in argv too). So hangar creates the
//    remote with the harmless keys only, and delivers the secret keys by editing
//    rclone's config file directly — obscuring the ones rclone stores obscured
//    via `rclone obscure -`, which is the one documented stdin channel rclone has.
//
// 2. The user's browser is on their laptop, not on the server. rclone's normal
//    OAuth flow binds a callback on 127.0.0.1:53682 of the machine running it,
//    which is the wrong machine entirely. rclone's documented answer is headless
//    authorisation: the user runs `rclone authorize "drive"` on their own
//    computer and pastes the token back. hangar never runs that command — it only
//    shows it — and parseAuthorizeOutput turns the messy terminal paste into a
//    token.
//
// Pure: the provider table, validation, argv construction, token parsing and the
// config-file merge. Only createRemote/deleteRemote touch cockpit.
'use strict';
(function (root) {
    // Under node the sibling module is required relative to this file; in the
    // browser errors.js has already run and put HangarErrors on the global.
    const Errors = (typeof module !== 'undefined' && module.exports)
        ? require('./errors.js')
        : root.HangarErrors;

    const KIND = Errors.KIND;

    function fail(message, detail) {
        throw Errors.create(KIND.GENERIC, message, detail === undefined ? null : detail);
    }

    // The module's coercion boundary, so it has to be total: String() itself
    // throws on a null-prototype object, and every function below assumes it got
    // a string back.
    function str(v) {
        if (v === null || v === undefined) return '';
        try { return String(v); } catch (e) { return ''; }
    }

    function blank(v) {
        return str(v).trim() === '';
    }

    // Table and form lookups must be own-property only, or a field called
    // "constructor" resolves to Object.prototype's and hangar writes a function
    // body into rclone's config file.
    function own(table, key) {
        return (table && typeof table === 'object' &&
            Object.prototype.hasOwnProperty.call(table, key)) ? table[key] : undefined;
    }

    const AUTH = { OAUTH: 'oauth', CREDENTIALS: 'credentials', NONE: 'none' };

    // rclone itself accepts up to 100+ character names, but this name is also
    // pasted into a repository URL, a systemd unit description and a config
    // filename, so hangar caps it where it still reads as a name.
    const MAX_NAME_LEN = 64;

    // ------------------------------------------------------------- providers
    //
    // `type` is rclone's backend name and every `key` is rclone's real config key
    // — both taken from `rclone config providers` on 1.74.3, not guessed. Getting
    // a key wrong does not fail loudly: rclone accepts unknown keys into the
    // config file and the remote simply never authenticates.
    //
    // `type: 'password'` is what marks a field as secret. That one flag is what
    // keeps a value out of argv, so a new secret field is protected by declaring
    // it, not by remembering to special-case it.
    //
    // `obscure: true` marks the keys rclone stores obscured (its IsPassword
    // options). We write those keys ourselves, so the obscuring is our job — a
    // plaintext value under an obscured key is silently unusable, because rclone
    // will "reveal" it into garbage.

    const OAUTH_HELP = 'Optional. Leave both blank to use rclone\'s built-in client.';

    const PROVIDERS = [
        // ------------------------------------------------------------ OAuth
        {
            id: 'drive',
            label: 'Google Drive',
            type: 'drive',
            auth: AUTH.OAUTH,
            fields: [
                { key: 'client_id', label: 'Client ID', type: 'text', required: false,
                  placeholder: '123456789-abc.apps.googleusercontent.com',
                  help: 'Strongly recommended for Google Drive — see the note below.' },
                { key: 'client_secret', label: 'Client secret', type: 'password', required: false,
                  placeholder: '', help: 'Belongs with the client ID above.' },
                { key: 'scope', label: 'Access', type: 'select', required: false, placeholder: '',
                  options: [
                      { value: 'drive', label: 'Full access to your Drive' },
                      { value: 'drive.file', label: 'Only files hangar creates' }
                  ],
                  help: 'Restricting access means hangar can only see its own backups.' }
            ],
            // Not decoration: rclone's own documentation says the built-in Drive
            // client ID is shared by every rclone user and heavily rate-limited.
            // A backup that crawls because of that looks like hangar's fault.
            notes: 'rclone\'s built-in Google client ID is shared by every rclone user and is heavily ' +
                'rate-limited. For anything but a trial, register your own client ID in the Google Cloud ' +
                'console and paste it above — backups will be far faster.'
        },
        {
            id: 'dropbox',
            label: 'Dropbox',
            type: 'dropbox',
            auth: AUTH.OAUTH,
            fields: [
                { key: 'client_id', label: 'App key', type: 'text', required: false, placeholder: '',
                  help: OAUTH_HELP },
                { key: 'client_secret', label: 'App secret', type: 'password', required: false,
                  placeholder: '', help: OAUTH_HELP }
            ],
            notes: 'Dropbox rate-limits rclone\'s shared app key. Registering your own Dropbox app ' +
                'avoids that.'
        },
        {
            id: 'onedrive',
            label: 'Microsoft OneDrive',
            type: 'onedrive',
            auth: AUTH.OAUTH,
            fields: [
                { key: 'region', label: 'Cloud region', type: 'select', required: false, placeholder: '',
                  options: [
                      { value: 'global', label: 'Microsoft Cloud Global' },
                      { value: 'us', label: 'US Government (GCC High)' },
                      { value: 'de', label: 'Microsoft Cloud Germany' },
                      { value: 'cn', label: 'Azure and Office 365 operated by Vnet in China' }
                  ],
                  help: 'Global unless you were told otherwise.' },
                { key: 'client_id', label: 'Application (client) ID', type: 'text', required: false,
                  placeholder: '', help: OAUTH_HELP },
                { key: 'client_secret', label: 'Client secret', type: 'password', required: false,
                  placeholder: '', help: OAUTH_HELP }
            ],
            notes: 'A OneDrive for Business tenant may refuse rclone\'s built-in client ID; register ' +
                'an app in Entra ID and paste its client ID and secret above.'
        },
        {
            id: 'box',
            label: 'Box',
            type: 'box',
            auth: AUTH.OAUTH,
            fields: [
                { key: 'client_id', label: 'Client ID', type: 'text', required: false, placeholder: '',
                  help: OAUTH_HELP },
                { key: 'client_secret', label: 'Client secret', type: 'password', required: false,
                  placeholder: '', help: OAUTH_HELP }
            ],
            notes: 'Box expires its refresh token after 60 days of inactivity — a repository that is ' +
                'never written to will eventually need re-authorising.'
        },
        {
            id: 'pcloud',
            label: 'pCloud',
            type: 'pcloud',
            auth: AUTH.OAUTH,
            fields: [
                { key: 'client_id', label: 'Client ID', type: 'text', required: false, placeholder: '',
                  help: OAUTH_HELP },
                { key: 'client_secret', label: 'Client secret', type: 'password', required: false,
                  placeholder: '', help: OAUTH_HELP }
            ],
            notes: 'pCloud accounts live in one of two regions; if the remote lists nothing after ' +
                'authorising, the account is in the other one.'
        },
        {
            id: 'yandex',
            label: 'Yandex Disk',
            type: 'yandex',
            auth: AUTH.OAUTH,
            fields: [
                { key: 'client_id', label: 'Client ID', type: 'text', required: false, placeholder: '',
                  help: OAUTH_HELP },
                { key: 'client_secret', label: 'Client secret', type: 'password', required: false,
                  placeholder: '', help: OAUTH_HELP }
            ],
            notes: 'Yandex Disk applies a per-application quota, so a personal client ID is worth ' +
                'registering for large backups.'
        },
        {
            id: 'jottacloud',
            label: 'Jottacloud',
            type: 'jottacloud',
            auth: AUTH.OAUTH,
            fields: [
                { key: 'client_id', label: 'Client ID', type: 'text', required: false, placeholder: '',
                  help: OAUTH_HELP },
                { key: 'client_secret', label: 'Client secret', type: 'password', required: false,
                  placeholder: '', help: OAUTH_HELP }
            ],
            notes: 'Jottacloud issues a personal login token from its web interface; paste that where ' +
                'the token is asked for.'
        },

        // ------------------------------------------------------ credentials
        {
            id: 'webdav',
            label: 'WebDAV (Nextcloud, ownCloud, …)',
            type: 'webdav',
            auth: AUTH.CREDENTIALS,
            fields: [
                { key: 'url', label: 'Server URL', type: 'text', required: true,
                  placeholder: 'https://cloud.example.com/remote.php/dav/files/alice/',
                  help: 'The full WebDAV endpoint, not the web interface address.' },
                { key: 'vendor', label: 'Server type', type: 'select', required: false, placeholder: '',
                  options: [
                      { value: 'nextcloud', label: 'Nextcloud' },
                      { value: 'owncloud', label: 'ownCloud' },
                      { value: 'sharepoint', label: 'SharePoint Online' },
                      { value: 'sharepoint-ntlm', label: 'SharePoint with NTLM' },
                      { value: 'rclone', label: 'rclone serve webdav' },
                      { value: 'other', label: 'Other' }
                  ],
                  help: 'Lets rclone use the server\'s faster upload path where there is one.' },
                { key: 'user', label: 'Username', type: 'text', required: false, placeholder: '',
                  help: '' },
                { key: 'pass', label: 'Password', type: 'password', required: false, obscure: true,
                  placeholder: '',
                  help: 'For Nextcloud and ownCloud use an app password, not your login password.' }
            ],
            notes: 'Nextcloud and ownCloud can issue a dedicated app password that you can revoke ' +
                'without changing your account password.'
        },
        {
            id: 'sftp',
            label: 'SFTP / SSH',
            type: 'sftp',
            auth: AUTH.CREDENTIALS,
            fields: [
                { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'nas.lan',
                  help: '' },
                { key: 'user', label: 'Username', type: 'text', required: false, placeholder: '',
                  help: 'Defaults to the user rclone runs as, which is root.' },
                { key: 'port', label: 'Port', type: 'text', required: false, placeholder: '22',
                  help: '' },
                { key: 'key_file', label: 'Private key file', type: 'text', required: false,
                  placeholder: '/root/.ssh/id_ed25519',
                  help: 'A key is preferable to a password — it survives unattended runs.' },
                { key: 'key_file_pass', label: 'Key passphrase', type: 'password', required: false,
                  obscure: true, placeholder: '', help: 'Only if the private key is encrypted.' },
                { key: 'pass', label: 'Password', type: 'password', required: false, obscure: true,
                  placeholder: '', help: 'Leave blank when using a key file.' }
            ],
            notes: 'restic can talk to SFTP directly. Use this only when you want rclone in between — ' +
                'for bandwidth limits, for example.'
        },
        {
            id: 'ftp',
            label: 'FTP',
            type: 'ftp',
            auth: AUTH.CREDENTIALS,
            fields: [
                { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'ftp.example.com',
                  help: '' },
                { key: 'user', label: 'Username', type: 'text', required: false, placeholder: '',
                  help: '' },
                { key: 'port', label: 'Port', type: 'text', required: false, placeholder: '21', help: '' },
                { key: 'pass', label: 'Password', type: 'password', required: false, obscure: true,
                  placeholder: '', help: '' }
            ],
            notes: 'Plain FTP sends credentials and data unencrypted. Prefer SFTP or WebDAV over HTTPS ' +
                'wherever the server offers one.'
        },
        {
            id: 'smb',
            label: 'SMB / Windows share',
            type: 'smb',
            auth: AUTH.CREDENTIALS,
            fields: [
                { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'fileserver.lan',
                  help: '' },
                { key: 'user', label: 'Username', type: 'text', required: false, placeholder: '',
                  help: '' },
                { key: 'domain', label: 'Domain', type: 'text', required: false, placeholder: 'WORKGROUP',
                  help: '' },
                { key: 'port', label: 'Port', type: 'text', required: false, placeholder: '445', help: '' },
                { key: 'pass', label: 'Password', type: 'password', required: false, obscure: true,
                  placeholder: '', help: '' }
            ],
            notes: 'The share name is not part of the remote — it becomes the first path segment of the ' +
                'repository, for example remote:share/backups.'
        },
        {
            id: 's3',
            label: 'S3-compatible storage',
            type: 's3',
            auth: AUTH.CREDENTIALS,
            fields: [
                { key: 'provider', label: 'Provider', type: 'select', required: false, placeholder: '',
                  options: [
                      { value: 'AWS', label: 'Amazon S3' },
                      { value: 'Minio', label: 'Minio' },
                      { value: 'Ceph', label: 'Ceph' },
                      { value: 'Wasabi', label: 'Wasabi' },
                      { value: 'Scaleway', label: 'Scaleway' },
                      { value: 'DigitalOcean', label: 'DigitalOcean Spaces' },
                      { value: 'Other', label: 'Other S3-compatible' }
                  ],
                  help: 'Picks the right quirks for the service.' },
                { key: 'access_key_id', label: 'Access key ID', type: 'text', required: true,
                  placeholder: 'AKIA…', help: '' },
                { key: 'secret_access_key', label: 'Secret access key', type: 'password', required: true,
                  placeholder: '', help: '' },
                { key: 'region', label: 'Region', type: 'text', required: false,
                  placeholder: 'eu-central-1', help: '' },
                { key: 'endpoint', label: 'Endpoint', type: 'text', required: false,
                  placeholder: 'https://minio.lan:9000',
                  help: 'Required for everything that is not Amazon S3 itself.' }
            ],
            notes: 'restic speaks S3 natively. Going through rclone is worth it mainly for services ' +
                'restic\'s own S3 client trips over.'
        },
        {
            id: 'b2',
            label: 'Backblaze B2',
            type: 'b2',
            auth: AUTH.CREDENTIALS,
            fields: [
                { key: 'account', label: 'Account ID or application key ID', type: 'text', required: true,
                  placeholder: '', help: '' },
                { key: 'key', label: 'Application key', type: 'password', required: true,
                  placeholder: '', help: '' }
            ],
            notes: 'Create an application key scoped to one bucket rather than using the master key.'
        },
        {
            id: 'swift',
            label: 'OpenStack Swift',
            type: 'swift',
            auth: AUTH.CREDENTIALS,
            fields: [
                { key: 'auth', label: 'Authentication URL', type: 'text', required: true,
                  placeholder: 'https://auth.example.com/v3', help: '' },
                { key: 'user', label: 'Username', type: 'text', required: true, placeholder: '',
                  help: '' },
                { key: 'key', label: 'API key or password', type: 'password', required: true,
                  placeholder: '', help: '' },
                { key: 'tenant', label: 'Tenant / project', type: 'text', required: false,
                  placeholder: '', help: '' },
                { key: 'domain', label: 'Domain', type: 'text', required: false, placeholder: 'Default',
                  help: '' },
                { key: 'region', label: 'Region', type: 'text', required: false, placeholder: '',
                  help: '' }
            ],
            notes: 'For OVH, Rackspace and Memset the authentication URL is region-specific.'
        },
        {
            id: 'koofr',
            label: 'Koofr',
            type: 'koofr',
            auth: AUTH.CREDENTIALS,
            fields: [
                { key: 'provider', label: 'Service', type: 'select', required: false, placeholder: '',
                  options: [
                      { value: 'koofr', label: 'Koofr' },
                      { value: 'digistorage', label: 'Digi Storage' },
                      { value: 'other', label: 'Other Koofr-compatible' }
                  ],
                  help: '' },
                { key: 'endpoint', label: 'Endpoint', type: 'text', required: false,
                  placeholder: 'https://app.koofr.net',
                  help: 'Only for a Koofr-compatible service that is not Koofr itself.' },
                { key: 'user', label: 'Email address', type: 'text', required: true, placeholder: '',
                  help: '' },
                { key: 'password', label: 'Application password', type: 'password', required: true,
                  obscure: true, placeholder: '',
                  help: 'Generated in Koofr\'s preferences — not your account password.' }
            ],
            notes: 'Koofr requires an application password created in its web preferences; your login ' +
                'password will not work.'
        },
        {
            id: 'mega',
            label: 'MEGA',
            type: 'mega',
            auth: AUTH.CREDENTIALS,
            fields: [
                { key: 'user', label: 'Email address', type: 'text', required: true, placeholder: '',
                  help: '' },
                { key: 'pass', label: 'Password', type: 'password', required: true, obscure: true,
                  placeholder: '', help: '' }
            ],
            notes: 'MEGA\'s client keeps a large local cache and is memory-hungry on big accounts.'
        }
    ];

    // The table is shared with the UI, which iterates it every render. Freezing it
    // means a stray assignment in a view cannot quietly change which field is a
    // secret — the one flag that keeps values out of argv.
    function deepFreeze(o) {
        if (o && typeof o === 'object' && !Object.isFrozen(o)) {
            Object.freeze(o);
            Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
        }
        return o;
    }
    deepFreeze(PROVIDERS);

    const BY_ID = {};
    PROVIDERS.forEach(function (p) { BY_ID[p.id] = p; });

    function providers() {
        return PROVIDERS.slice();       // fresh array; the entries themselves are frozen
    }

    function providerFor(id) {
        const p = own(BY_ID, str(id));
        return p || null;
    }

    function requireProvider(id) {
        const p = providerFor(id);
        if (!p) fail('Unknown destination: ' + (str(id) || '(empty)') + '.', id);
        return p;
    }

    function isOAuth(id) {
        const p = providerFor(id);
        return !!p && p.auth === AUTH.OAUTH;
    }

    function isSecretField(f) {
        return !!f && f.type === 'password';
    }

    function fieldFor(providerId, key) {
        const p = providerFor(providerId);
        if (!p) return null;
        const want = str(key);
        for (let i = 0; i < p.fields.length; i++)
            if (p.fields[i].key === want) return p.fields[i];
        return null;
    }

    // ------------------------------------------------------------ validation

    // rclone 1.74.3 rejects a name outright with: "may only contain numbers,
    // letters, `_`, `-`, `.`, `+`, `@` and space, while not start with `-` or
    // space, and not end with space". hangar is deliberately stricter about
    // whitespace, because this name is also pasted into a repository URL and read
    // back out of one.
    const NAME_ALLOWED = /^[\p{L}\p{N}_.+@-]+$/u;

    // Everything outside printable ASCII that a terminal or a config file would
    // reinterpret. \p{C} covers NUL, the C0/C1 ranges, LINE SEPARATOR and the
    // bidi overrides that make a name render as something it is not.
    const CONTROL = /\p{C}/u;
    const CONTROL_G = /\p{C}/gu;

    function validateRemoteName(name) {
        const problems = [];
        const s = str(name);

        if (s === '') return ['A remote name is required.'];

        if (s.length > MAX_NAME_LEN)
            problems.push('A remote name may be at most ' + MAX_NAME_LEN + ' characters.');

        // A leading dash is not a style question: `rclone config create -x …`
        // makes rclone parse the name as a flag, and it exits with "unknown
        // shorthand flag" instead of creating anything.
        if (s.charAt(0) === '-')
            problems.push('A remote name must not start with "-" — it would be read as a command option.');

        if (s.indexOf(':') >= 0)
            problems.push('A remote name must not contain ":" — it separates the remote from the path.');

        if (s.indexOf('/') >= 0)
            problems.push('A remote name must not contain "/".');

        if (/\s/.test(s))
            problems.push('A remote name must not contain spaces.');

        if (CONTROL.test(s))
            problems.push('A remote name must not contain control characters.');

        // Report the leftovers only. Without this the same ":" would be reported
        // twice, once specifically and once as "an illegal character".
        const rest = s.replace(/[:/]/g, '').replace(/\s/g, '').replace(CONTROL_G, '');
        if (rest !== '' && !NAME_ALLOWED.test(rest))
            problems.push('A remote name may only contain letters, digits and _ - . + @');

        return problems;
    }

    // A newline in a value would end the key= line and start another one: the rest
    // of the pasted value becomes a config key of its own. That is config
    // injection into the file restic authenticates with, so it is rejected here
    // and again in mergeConfigSection.
    const INJECTION = /[\r\n\0]/;

    function validateFields(providerId, values) {
        const p = providerFor(providerId);
        if (!p) return ['Unknown destination: ' + (str(providerId) || '(empty)') + '.'];

        const problems = [];
        p.fields.forEach(function (f) {
            const raw = own(values, f.key);
            const v = str(raw);

            if (f.required && blank(v)) {
                problems.push(f.label + ' is required.');
                return;
            }
            if (v === '') return;

            if (INJECTION.test(v))
                problems.push(f.label + ' must not contain line breaks or NUL bytes.');

            if (f.type === 'select' && Array.isArray(f.options) && !blank(v)) {
                const allowed = f.options.map(function (o) { return o.value; });
                if (allowed.indexOf(v) < 0)
                    problems.push(f.label + ' must be one of: ' + allowed.join(', ') + '.');
            }
        });
        return problems;
    }

    // ---------------------------------------------------------------- argv

    // Returns { argv, secrets }. Nothing in argv is secret — that is the whole
    // contract of this function, and the reason secrets come back separately
    // instead of being interpolated here.
    //
    // `token` is the blob from `rclone authorize` and is treated exactly like any
    // other secret: it never becomes an argument.
    function configCreateArgv(name, providerId, values, token) {
        const p = requireProvider(providerId);

        const nameProblems = validateRemoteName(name);
        if (nameProblems.length)
            fail(nameProblems[0], { name: str(name), problems: nameProblems });

        const fieldProblems = validateFields(p.id, values);
        if (fieldProblems.length)
            fail(fieldProblems[0], { provider: p.id, problems: fieldProblems });

        const argv = ['rclone', 'config', 'create', str(name), p.type];
        const secrets = [];

        p.fields.forEach(function (f) {
            const v = str(own(values, f.key));
            if (isSecretField(f)) {
                // Deliberately not trimmed: a password may legitimately begin or
                // end with a space, and silently changing it would produce a
                // remote that authenticates nowhere.
                if (v === '') return;
                secrets.push({ key: f.key, value: v, obscure: !!f.obscure });
                return;
            }
            if (blank(v)) return;
            argv.push(f.key + '=' + v.trim());
        });

        // Documented headless-OAuth switch: it tells rclone not to try to open a
        // browser and bind 127.0.0.1:53682 on THIS machine, which is a server the
        // user is not sitting at.
        if (p.auth === AUTH.OAUTH) argv.push('config_is_local=false');

        const tok = str(token).trim();
        if (tok !== '') {
            if (p.auth !== AUTH.OAUTH)
                fail(p.label + ' does not use a pasted authorisation token.', { provider: p.id });
            if (INJECTION.test(tok))
                fail('The pasted token must be a single line.', { provider: p.id });
            secrets.push({ key: 'token', value: tok, obscure: false });
        }

        return { argv: argv, secrets: secrets };
    }

    function configDeleteArgv(name) {
        const problems = validateRemoteName(name);
        if (problems.length) fail(problems[0], { name: str(name), problems: problems });
        return ['rclone', 'config', 'delete', str(name)];
    }

    function configFileArgv() {
        return ['rclone', 'config', 'file'];
    }

    // The hyphen is documented: "This command can also accept a password through
    // STDIN instead of an argument by passing a hyphen". It is the only stdin
    // channel rclone exposes, and it is why obscuring can happen without the
    // password ever appearing in argv.
    function obscureArgv() {
        return ['rclone', 'obscure', '-'];
    }

    // Shown for copying, never executed by hangar — it has to run on the user's
    // own computer, which is where the browser is.
    function authorizeCommand(providerId) {
        const p = requireProvider(providerId);
        return 'rclone authorize "' + p.type + '"';
    }

    function describeProvider(id) {
        const p = providerFor(id);
        if (!p) return 'Unknown destination.';
        const head = p.label + ' (rclone backend "' + p.type + '"). ';
        if (p.auth === AUTH.OAUTH)
            return head + 'Sign in on your own computer with ' + authorizeCommand(p.id) +
                ', then paste the token it prints back into hangar.';
        const required = p.fields.filter(function (f) { return f.required; })
            .map(function (f) { return f.label.toLowerCase(); });
        if (!required.length) return head + 'Needs no credentials.';
        return head + 'Needs ' + joinList(required) + '.';
    }

    function joinList(items) {
        if (items.length === 1) return items[0];
        return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
    }

    // ------------------------------------------------------- authorize output
    //
    // The user is pasting out of a terminal, so assume the worst: CRLF, wrapped
    // lines, the marker lines included or trimmed off, blank lines top and bottom,
    // and rclone's own log lines above. Be generous — but return null rather than
    // a guess, because a truncated token produces a remote that fails later, at
    // 03:00, in a unit nobody is watching.

    const START_MARKER = /paste\s+the\s+following\s+into\s+your\s+remote\s+machine/i;
    const END_MARKER = /^<?-*\s*end\s+paste\s*-*>?$/i;

    // The opaque (non-JSON) form: one long run of token characters. ':' and '?'
    // are excluded so the authorisation URL rclone prints above the token is never
    // mistaken for it.
    const OPAQUE = /^[A-Za-z0-9_.~+/=-]{20,}$/;

    function looksLikeToken(text) {
        const s = str(text).trim();
        if (s === '') return false;

        if (s.charAt(0) === '{' && s.charAt(s.length - 1) === '}') {
            try {
                const o = JSON.parse(s);
                if (o && typeof o === 'object' &&
                    (typeof o.access_token === 'string' || typeof o.refresh_token === 'string'))
                    return true;
            } catch (e) {
                // Not parseable is not decisive: a terminal may have mangled the
                // whitespace. The field names are the real signal.
            }
            return /"(access_token|refresh_token)"\s*:/.test(s);
        }

        return OPAQUE.test(s);
    }

    function parseAuthorizeOutput(text) {
        const raw = str(text);
        if (raw.trim() === '') return null;

        const lines = raw.replace(/\r\n?/g, '\n').split('\n');

        let start = -1;
        let tail = '';
        for (let i = 0; i < lines.length; i++) {
            if (START_MARKER.test(lines[i])) {
                start = i;
                // Some terminals wrap the marker and the token onto one line.
                tail = lines[i].replace(/^.*?paste\s+the\s+following\s+into\s+your\s+remote\s+machine\s*-*>?/i, '').trim();
                break;
            }
        }

        if (start >= 0) {
            if (tail !== '') return tail;
            const body = [];
            for (let i = start + 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (END_MARKER.test(line)) break;
                if (line === '') continue;
                body.push(line);
            }
            // Joined with no separator: a terminal that hard-wrapped a long token
            // split it mid-string, and any separator we invented would corrupt it.
            const joined = body.join('');
            return joined === '' ? null : joined;
        }

        // No start marker. Try the whole paste, then a JSON object embedded in it,
        // then line by line — accepting only what actually looks like a token.
        const whole = raw.trim();
        if (looksLikeToken(whole)) return whole;

        const first = whole.indexOf('{');
        const last = whole.lastIndexOf('}');
        if (first >= 0 && last > first) {
            const candidate = whole.slice(first, last + 1);
            if (looksLikeToken(candidate)) return candidate;
        }

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (looksLikeToken(line)) return line;
        }

        return null;
    }

    // ------------------------------------------------------- config file merge
    //
    // rclone's config is an INI file. hangar rewrites exactly the keys it was
    // asked to set, in exactly one section, and leaves every other byte — other
    // remotes, comments, spacing — untouched. This file is the user's, not ours.

    function configLine(key, value) {
        return key + ' = ' + value;
    }

    function sectionHeader(line) {
        const m = /^\s*\[([^\]]*)\]\s*$/.exec(line);
        return m ? m[1] : null;
    }

    function mergeConfigSection(text, name, pairs) {
        const section = str(name);
        if (section === '' || /[\r\n\0[\]]/.test(section))
            fail('Invalid rclone remote name for a config section.', section);

        const list = (Array.isArray(pairs) ? pairs : []).map(function (p) {
            return { key: str(p && p.key).trim(), value: str(p && p.value) };
        }).filter(function (p) { return p.key !== ''; });

        list.forEach(function (p) {
            // Second line of defence. Reached only if a caller skipped validation,
            // which is exactly when it matters.
            if (INJECTION.test(p.key) || INJECTION.test(p.value))
                fail('A configuration value must not contain line breaks or NUL bytes.', { key: p.key });
            if (!/^[A-Za-z0-9_]+$/.test(p.key))
                fail('Invalid rclone configuration key: ' + p.key + '.', p.key);
        });

        const lines = str(text).split(/\r?\n/);
        const out = [];
        const written = {};
        let inSection = false;
        let seen = false;
        let insertAt = -1;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const header = sectionHeader(line);

            if (header !== null) {
                if (inSection) {
                    insertAt = out.length;      // end of our section reached
                    inSection = false;
                }
                if (header === section) {
                    inSection = true;
                    seen = true;
                }
                out.push(line);
                continue;
            }

            if (inSection) {
                const m = /^\s*([A-Za-z0-9_]+)\s*=/.exec(line);
                const key = m ? m[1] : null;
                if (key !== null && list.some(function (p) { return p.key === key; })) {
                    if (!written[key]) {
                        const pair = list.filter(function (p) { return p.key === key; }).pop();
                        out.push(configLine(key, pair.value));
                        written[key] = true;
                    }
                    continue;       // drop duplicates of a key we are rewriting
                }
            }
            out.push(line);
        }

        if (inSection) insertAt = out.length;

        const missing = list.filter(function (p) { return !written[p.key]; })
            .map(function (p) { return configLine(p.key, p.value); });

        if (!seen) {
            // A brand-new section. Keep one blank line before it so the file stays
            // readable when rclone rewrites it later.
            while (out.length && out[out.length - 1].trim() === '') out.pop();
            if (out.length) out.push('');
            out.push('[' + section + ']');
            missing.forEach(function (l) { out.push(l); });
        } else if (missing.length) {
            const at = insertAt < 0 ? out.length : insertAt;
            // Skip back over the blank lines that separate sections, so the new
            // keys land inside our section rather than in front of the next one.
            let k = at;
            while (k > 0 && out[k - 1].trim() === '') k--;
            out.splice.apply(out, [k, 0].concat(missing));
        }

        while (out.length && out[out.length - 1].trim() === '') out.pop();
        return out.join('\n') + '\n';
    }

    // `rclone config file` prints a sentence and then the path on its own line.
    function parseConfigFilePath(text) {
        const lines = str(text).replace(/\r\n?/g, '\n').split('\n')
            .map(function (l) { return l.trim(); })
            .filter(function (l) { return l !== ''; });
        for (let i = lines.length - 1; i >= 0; i--)
            if (lines[i].charAt(0) === '/') return lines[i];
        return null;
    }

    // ------------------------------------------------------------- errors

    // rclone reports failures as prose on stderr; there is no exit-code contract
    // like restic's, so the message is all there is to classify on.
    function classifyRcloneError(message, detail) {
        const text = str(message).trim();
        if (/not\s+found|no\s+such\s+file|ENOENT|command\s+not\s+found/i.test(text))
            return Errors.create(KIND.GENERIC,
                'rclone is not installed on this host.', detail === undefined ? null : detail);
        if (/no such host|connection refused|network is unreachable|i\/o timeout|timed out|dial tcp|temporary failure|couldn't connect/i.test(text))
            return Errors.create(KIND.NETWORK,
                text || 'rclone could not reach the service.', detail === undefined ? null : detail);
        return Errors.create(KIND.GENERIC, text || 'rclone reported an error.',
            detail === undefined ? null : detail);
    }

    // ------------------------------------------------------------- impure

    function hasCockpit(member) {
        return typeof cockpit !== 'undefined' && cockpit && typeof cockpit[member] === 'function';
    }

    function noCockpit(where) {
        return Errors.create(KIND.GENERIC, 'cockpit is not available', { where: where });
    }

    // One spawn wrapper so every rclone call fails the same way. `input` is the
    // only path by which a secret ever leaves this process.
    function run(argv, input) {
        if (!hasCockpit('spawn')) return Promise.reject(noCockpit(argv.join(' ')));
        let proc;
        try {
            proc = cockpit.spawn(argv, { superuser: 'require', err: 'message' });
        } catch (e) {
            // cockpit.spawn throws synchronously when the superuser bridge is gone.
            return Promise.reject(classifyRcloneError(e && e.message, { argv: argv }));
        }
        const started = (input !== undefined && input !== null && typeof proc.input === 'function')
            ? proc.input(input)
            : proc;
        return Promise.resolve(started).catch(function (e) {
            // Never echo the command back with its input: argv is safe by
            // construction, but the message must not tempt anyone to log both.
            throw classifyRcloneError(e && (e.message || e.problem), { command: argv.slice(0, 3).join(' ') });
        });
    }

    // rclone stores its IsPassword options obscured. We write those keys
    // ourselves, so we must obscure them ourselves — and `rclone obscure -` reads
    // the password from stdin, which keeps it out of argv.
    function obscureSecrets(secrets) {
        return secrets.reduce(function (chain, s) {
            return chain.then(function (acc) {
                if (!s.obscure) {
                    acc.push({ key: s.key, value: s.value });
                    return acc;
                }
                return run(obscureArgv(), s.value).then(function (out) {
                    const obscured = str(out).trim();
                    if (obscured === '')
                        throw Errors.create(KIND.GENERIC, 'rclone could not obscure the password.',
                            { key: s.key });
                    acc.push({ key: s.key, value: obscured });
                    return acc;
                });
            });
        }, Promise.resolve([]));
    }

    function writeSecrets(name, secrets) {
        if (!secrets.length) return Promise.resolve(null);
        if (!hasCockpit('file')) return Promise.reject(noCockpit('writeSecrets'));

        return obscureSecrets(secrets).then(function (pairs) {
            return run(configFileArgv()).then(function (out) {
                const path = parseConfigFilePath(out);
                if (!path)
                    throw Errors.create(KIND.GENERIC, 'Could not determine the rclone configuration path.',
                        { output: str(out).slice(0, 200) });
                return path;
            }).then(function (path) {
                const f = cockpit.file(path, { superuser: 'require' });
                // modify() rather than read-then-replace: cockpit reruns the
                // callback if the file changed underneath us, so a concurrent
                // `rclone config` cannot silently lose the other writer's remote.
                const done = (typeof f.modify === 'function')
                    ? f.modify(function (content) { return mergeConfigSection(content || '', name, pairs); })
                    : f.read().then(function (content) {
                        return f.replace(mergeConfigSection(content || '', name, pairs));
                    });
                return Promise.resolve(done).then(function () {
                    f.close();
                    // The file now holds credentials. rclone creates it 0600; if it
                    // pre-existed with looser permissions, tighten it.
                    return run(['chmod', '600', path]).catch(function () { return null; });
                }, function (e) {
                    f.close();
                    throw classifyRcloneError(e && (e.message || e.problem), { path: path });
                });
            });
        });
    }

    // Impure. Creates the remote with the harmless keys, then delivers the secret
    // keys off-argv. Resolves to a summary that deliberately contains no values.
    function createRemote(name, providerId, values, token) {
        return Promise.resolve().then(function () {
            const plan = configCreateArgv(name, providerId, values, token);
            if (!hasCockpit('spawn')) throw noCockpit('createRemote');
            return run(plan.argv)
                .then(function () { return writeSecrets(str(name), plan.secrets); })
                .then(function () {
                    return {
                        name: str(name),
                        type: requireProvider(providerId).type,
                        // A count, never the keys' values.
                        secrets: plan.secrets.length
                    };
                });
        });
    }

    function deleteRemote(name) {
        return Promise.resolve().then(function () {
            const argv = configDeleteArgv(name);
            if (!hasCockpit('spawn')) throw noCockpit('deleteRemote');
            return run(argv).then(function () { return str(name); });
        });
    }

    const HangarRclone = {
        AUTH, PROVIDERS, MAX_NAME_LEN,
        providers, providerFor, isOAuth, isSecretField, fieldFor, describeProvider,
        validateRemoteName, validateFields,
        configCreateArgv, configDeleteArgv, configFileArgv, obscureArgv,
        authorizeCommand, parseAuthorizeOutput, looksLikeToken,
        mergeConfigSection, parseConfigFilePath, classifyRcloneError,
        createRemote, deleteRemote
    };
    root.HangarRclone = HangarRclone;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarRclone;
})(typeof window !== 'undefined' ? window : globalThis);
