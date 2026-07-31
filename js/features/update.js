// features/update.js — version badge state and GitHub-release self-update.
//
// THE CONSTRAINT THAT SHAPES THIS FILE: the plugin's CSP is connect-src 'self', so a
// browser fetch() to api.github.com is blocked outright. Every network call here goes
// through cockpit.spawn(['curl', ...]) on the host instead. Reaching for fetch() will
// appear to work in a unit test and fail silently in the browser.
//
// Update flow: check release -> download zip -> unzip -> `make install` (superuser) ->
// detached Cockpit restart. Nothing touches /usr/share/cockpit/hangar until the
// `make install` step, so a failed update leaves the working version in place.
'use strict';
(function (root) {
    const Semver = root.HangarSemver ||
        (typeof require === 'function' ? require('../core/semver.js') : null);
    const Errors = root.HangarErrors ||
        (typeof require === 'function' ? require('../core/errors.js') : null);

    const PHASE = { IDLE: 'idle', CONFIRM: 'confirm', RUNNING: 'running', DONE: 'done', ERROR: 'error' };

    // ---------------------------------------------------------------- pure

    // Accepts 'owner/repo' or any github.com URL pointing at it.
    function releasesApiUrl(raw) {
        const repo = String(raw || '').trim()
            .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
            .replace(/\.git$/i, '')
            .replace(/^\/+|\/+$/g, '');
        if (!repo) return '';
        const parts = repo.split('/');
        // Exactly owner/name. Anything deeper is a path inside the repo, not the repo.
        if (parts.length !== 2 || !parts[0] || !parts[1]) return '';
        if (!/^[A-Za-z0-9._-]+$/.test(parts[0]) || !/^[A-Za-z0-9._-]+$/.test(parts[1])) return '';
        return 'https://api.github.com/repos/' + parts[0] + '/' + parts[1] + '/releases/latest';
    }

    // Reduce a GitHub release document to the few fields the UI needs.
    function parseRelease(text, installedVersion) {
        let rel;
        try {
            rel = JSON.parse(text);
        } catch (e) {
            throw Errors.create('GENERIC', 'GitHub returned something that is not JSON.', { text: String(text).slice(0, 200) });
        }
        // Array.isArray matters: a JSON array is typeof 'object' and truthy, so it
        // would otherwise sail through and yield a release with no tag.
        if (!rel || typeof rel !== 'object' || Array.isArray(rel)) {
            throw Errors.create('GENERIC', 'GitHub returned an unexpected release document.');
        }
        // The API reports rate limiting and missing repositories as a 200 with a
        // "message" field, which would otherwise look like a release with no tag.
        if (!rel.tag_name && rel.message) {
            throw Errors.create('NETWORK', 'GitHub: ' + rel.message);
        }

        const tag = String(rel.tag_name || '');
        const version = tag.replace(/^v/i, '');
        const assets = Array.isArray(rel.assets) ? rel.assets : [];
        const zip = assets.find((a) => a && typeof a.name === 'string' && /\.zip$/i.test(a.name));

        return {
            tag: tag,
            version: version,
            available: Semver.isNewer(version, installedVersion),
            assetUrl: zip ? String(zip.browser_download_url || '') : String(rel.zipball_url || ''),
            notes: String(rel.body || ''),
            prerelease: !!rel.prerelease
        };
    }

    // Only https://github.com and its release CDN. The asset URL comes from a remote
    // document and is handed to curl, so it is treated as untrusted input.
    function isAllowedAssetUrl(url) {
        const s = String(url || '');
        return /^https:\/\/(github\.com|codeload\.github\.com|objects\.githubusercontent\.com)\//.test(s);
    }

    // `make zip` produces a single top-level hangar/ directory; GitHub's zipball also
    // nests exactly one directory. Anything else means we unpacked something we do
    // not understand, and running `make install` on it would be reckless.
    function chooseSourceDir(tmpDir, entries) {
        const dirs = (entries || []).filter((n) => n && n !== 'update.zip');
        if (dirs.length === 1) return tmpDir + '/' + dirs[0];
        return tmpDir;
    }

    function blankState() {
        return { checking: false, available: false, error: '', version: '', tag: '', assetUrl: '', notes: '', prerelease: false };
    }

    // ---------------------------------------------------------------- I/O

    function hasCockpit() { return typeof cockpit !== 'undefined' && cockpit && cockpit.spawn; }

    function spawn(argv, opts) {
        if (!hasCockpit()) return Promise.reject(Errors.create('GENERIC', 'cockpit is not available in this context.'));
        return cockpit.spawn(argv, Object.assign({ err: 'message' }, opts || {}));
    }

    // ---------------------------------------------------------------- component

    function hangarUpdateUi() {
        return {
            update: blankState(),
            updatePhase: PHASE.IDLE,
            updateLog: [],
            installedVersion: '',
            _inFlight: false,

            async initUpdate(settings) {
                this.installedVersion = await this.readInstalledVersion();
                // settings must be forwarded: checkForUpdate reads the repository from
                // it, and without it the check silently resolves to "no repository
                // configured" instead of contacting GitHub.
                if (settings && settings.updateCheckOnStartup && settings.updateRepo) {
                    await this.checkForUpdate(false, settings);
                }
            },

            async readInstalledVersion() {
                // VERSION ships beside index.html, so this is same-origin and allowed
                // by the CSP — unlike anything pointing at github.com.
                try {
                    if (typeof fetch !== 'function') return '';
                    const r = await fetch('VERSION', { cache: 'no-cache' });
                    if (!r.ok) return '';
                    return String(await r.text()).trim();
                } catch (e) {
                    return '';
                }
            },

            // manual=true reports the outcome either way; the startup check stays quiet
            // unless there is actually something to install.
            async checkForUpdate(manual, settings) {
                const api = releasesApiUrl(settings && settings.updateRepo);
                if (!api) {
                    this.update = Object.assign(blankState(), {
                        error: 'Set a GitHub repository (owner/name) in Settings first.'
                    });
                    return this.update;
                }

                this.update = Object.assign(blankState(), { checking: true });
                try {
                    // NOT fetch(): CSP connect-src 'self' blocks api.github.com.
                    const out = await spawn(['curl', '-fsSL', '--max-time', '20',
                        '-H', 'Accept: application/vnd.github+json', '--', api]);
                    const rel = parseRelease(out, this.installedVersion || '0.0.0');
                    this.update = Object.assign(blankState(), rel, { checking: false });
                } catch (e) {
                    this.update = Object.assign(blankState(), {
                        error: (e && e.message) || String(e)
                    });
                }
                return this.update;
            },

            openUpdateModal() {
                if (!this.update.assetUrl) return false;
                this.updatePhase = PHASE.CONFIRM;
                this.updateLog = [];
                const el = root.document && root.document.getElementById('hangar-update');
                if (el && root.bootstrap) root.bootstrap.Modal.getOrCreateInstance(el).show();
                return true;
            },

            closeUpdateModal() {
                // An in-flight `make install` running as root must not be abandoned
                // half-done by someone clicking away.
                if (this._inFlight) return false;
                const el = root.document && root.document.getElementById('hangar-update');
                if (el && root.bootstrap) root.bootstrap.Modal.getOrCreateInstance(el).hide();
                return true;
            },

            async startSelfUpdate() {
                if (this._inFlight) return false;
                const url = this.update && this.update.assetUrl;
                if (!url) return false;
                if (!isAllowedAssetUrl(url)) {
                    this.updatePhase = PHASE.ERROR;
                    this.updateLog = ['Refusing to download from an unexpected host: ' + url];
                    return false;
                }

                this._inFlight = true;
                this.updatePhase = PHASE.RUNNING;
                this.updateLog = [];
                const log = (line) => this.updateLog.push(String(line));
                let tmpDir = '';

                try {
                    log('Downloading ' + url);
                    tmpDir = String(await spawn(['mktemp', '-d'])).trim();
                    const zipPath = tmpDir + '/update.zip';
                    // '--' terminates option parsing: the URL is remote data.
                    await spawn(['curl', '-fsSL', '--max-time', '300', '-o', zipPath, '--', url]);

                    log('Unpacking');
                    await spawn(['unzip', '-oq', zipPath, '-d', tmpDir]);

                    const listing = String(await spawn(['ls', '-1', tmpDir]))
                        .split('\n').map((s) => s.trim()).filter(Boolean);
                    const srcDir = chooseSourceDir(tmpDir, listing);

                    log('Installing: make -C ' + srcDir + ' install');
                    const out = await spawn(['make', '-C', srcDir, 'install'], { superuser: 'require' });
                    if (out) log(String(out).trim());

                    // --no-block so the restart survives this page's channel closing;
                    // restarting Cockpit from inside Cockpit otherwise kills the call
                    // that is doing the restarting.
                    log('Scheduling Cockpit restart');
                    await spawn(['systemd-run', '--no-block', '--',
                        'systemctl', 'try-restart', 'cockpit'], { superuser: 'require' });

                    log('Done — reload this page in a few seconds.');
                    this.updatePhase = PHASE.DONE;
                    return true;
                } catch (e) {
                    log('FAILED: ' + ((e && e.message) || String(e)));
                    log('The previously installed version is untouched.');
                    this.updatePhase = PHASE.ERROR;
                    return false;
                } finally {
                    this._inFlight = false;
                    if (tmpDir) {
                        try { await spawn(['rm', '-rf', '--', tmpDir]); } catch (e) { /* best effort */ }
                    }
                }
            },

            updateBadgeLabel() {
                if (this.update.checking) return 'Checking…';
                if (this.update.error) return 'Update check failed';
                if (this.update.available) return 'Update to ' + this.update.version;
                return this.installedVersion ? 'v' + this.installedVersion : '';
            }
        };
    }

    const HangarUpdate = {
        PHASE, releasesApiUrl, parseRelease, isAllowedAssetUrl, chooseSourceDir,
        blankState, hangarUpdateUi
    };

    root.HangarUpdate = HangarUpdate;
    root.hangarUpdateUi = hangarUpdateUi;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarUpdate;
})(typeof window !== 'undefined' ? window : globalThis);
