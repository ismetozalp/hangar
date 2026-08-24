#!/usr/bin/env node
// tests/e2e.mjs — drives index.html in a real browser against a stubbed Cockpit bridge.
//
// What this proves: the page loads under the plugin's own CSP, every script parses,
// Alpine initialises and binds, the tabs and modals are really in the DOM, and the
// error paths render as designed. What it does NOT prove: that hangar talks to restic
// correctly — tests/integration covers that against the real binary.
//
// No Cockpit login is needed, which is the point: this runs anywhere, including CI.
//
//   node tests/e2e.mjs            headless
//   HEADED=1 node tests/e2e.mjs   watch it run
//   SHOT=1 node tests/e2e.mjs     write tests/e2e-*.png

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8899);

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png'
};

// Serve the plugin directory, mapping Cockpit's ../base1/cockpit.js onto the stub.
function serve() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let rel = decodeURIComponent(req.url.split('?')[0]);
            if (rel === '/') rel = '/index.html';
            if (rel === '/base1/cockpit.js') rel = '/tests/e2e/cockpit-stub.js';

            const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
            if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
                res.writeHead(404); res.end('not found'); return;
            }
            res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
            res.end(fs.readFileSync(file));
        });
        server.listen(PORT, () => resolve(server));
    });
}

// --- tiny harness --------------------------------------------------------

let passed = 0;
const failures = [];

async function check(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok  ${name}`);
    } catch (e) {
        failures.push({ name, error: e });
        console.log(`  FAIL  ${name}\n        ${e.message}`);
    }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) {
    if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

// Reasonable defaults so the page reaches a rendered state.
const DEFAULT_STUB = {
    spawn: {
        'restic version': 'restic 0.19.1 compiled with go1.26.4 on linux/amd64',
        'rclone --version': 'rclone v1.74.3',
        'fusermount3 --version': 'fusermount3 version: 3.16.2',
        'rear --version': 'Relax-and-Recover 2.9',
        'virt-install --version': '4.1.0',
        'unzip -v': 'UnZip 6.00 of 20 April 2009',
        'curl --version': 'curl 8.9.1 (x86_64-redhat-linux-gnu)',
        'ls -1 /etc/hangar/repos': '',
        'ls -1 /etc/hangar/jobs': '',
        // Every config write now creates its parent directory first, because
        // /etc/hangar does not exist on a symlink install and the first save of
        // anything used to fail with a bare "not-found".
        'install -d': ''
    },
    files: {
        '/etc/hangar/config.json': JSON.stringify({ mountRoot: '/run/hangar/mnt' }),
        // Family detection reads this; without it every distro-specific answer
        // degrades to "unknown", which would quietly weaken these tests.
        '/etc/os-release': 'NAME="Red Hat Enterprise Linux"\nID="rhel"\nID_LIKE="centos fedora"\nVERSION_ID="10.2"\n'
    }
};

async function open(browser, stub) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();

    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

    await page.addInitScript((s) => { window.__hangarStub = s; },
        Object.assign({}, DEFAULT_STUB, stub || {},
            // PackageKit answers by default; individual tests override this.
            { dbus: Object.assign({ 'org.freedesktop.PackageKit:Get': [{ v: 1 }] },
                (stub && stub.dbus) || {}) }));
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle' });
    // Alpine boots asynchronously: boot.js injects partials, then loads Alpine.
    await page.waitForSelector('.hangar-shell', { timeout: 10000 });
    await page.waitForTimeout(400);
    return { ctx, page, consoleErrors };
}

// --- the tests -----------------------------------------------------------

async function main() {
    const server = await serve();
    const browser = await chromium.launch({ headless: !process.env.HEADED });
    console.log(`e2e: serving ${ROOT} on :${PORT}\n`);

    try {
        // ---- loads clean
        {
            const { ctx, page, consoleErrors } = await open(browser);

            await check('the page loads with no uncaught script errors', async () => {
                const stubErrors = await page.evaluate(() => window.__hangarStub.errors || []);
                // CSP violations and parse failures both surface here, which is the
                // main thing this whole file exists to catch.
                assertEqual(consoleErrors.filter((e) => !/no stub for/.test(e)).length, 0,
                    `console errors: ${JSON.stringify(consoleErrors)}`);
                assertEqual(stubErrors.filter((e) => !/no stub for/.test(e)).length, 0,
                    `window errors: ${JSON.stringify(stubErrors)}`);
            });

            await check('every core module registered its global', async () => {
                const missing = await page.evaluate(() => {
                    const need = ['HangarErrors', 'HangarConfig', 'HangarRestic', 'HangarRepos',
                        'HangarSecrets', 'HangarSources', 'HangarRetention', 'HangarSchedule',
                        'HangarProvision', 'HangarDr', 'HangarLogbook', 'HangarSemver',
                        'HangarUpdate', 'hangarApp'];
                    return need.filter((n) => typeof window[n] === 'undefined');
                });
                assertEqual(missing.length, 0, `missing globals: ${missing.join(', ')}`);
            });

            await check('Alpine initialised and unhid the shell', async () => {
                assert(await page.isVisible('.hangar-shell'), 'shell not visible');
                // x-cloak is removed only once Alpine has processed the tree.
                const cloaked = await page.evaluate(() =>
                    document.querySelector('.hangar-shell').hasAttribute('x-cloak'));
                assert(!cloaked, 'x-cloak still present — Alpine did not initialise');
            });

            await check('all six tabs render', async () => {
                const labels = await page.$$eval('.nav-pills .nav-link', (els) =>
                    els.map((e) => e.textContent.trim()));
                assert.length;
                for (const want of ['Overview', 'Repositories', 'Jobs', 'Logbook', 'Recovery', 'Settings']) {
                    assert(labels.includes(want), `tab missing: ${want} (got ${labels.join(', ')})`);
                }
            });

            await check('no tab is labelled Time Machine', async () => {
                const body = await page.textContent('body');
                assert(!/time\s*machine/i.test(body), 'the page says "Time Machine"');
            });

            await check('every modal partial was injected', async () => {
                const ids = ['hangar-confirm', 'hangar-password', 'hangar-update',
                    'hangar-repo-edit', 'hangar-rclone-remote', 'hangar-job-edit', 'hangar-restore',
                    'hangar-provision', 'hangar-recovery'];
                const found = await page.evaluate((wanted) =>
                    wanted.filter((id) => !!document.getElementById(id)), ids);
                // A partial that failed to load logs to console and silently disables
                // its feature, so assert on presence rather than trusting boot.js.
                assert(found.length >= 3, `too few modals injected: ${found.join(', ')}`);
            });

            // Alpine settles asynchronously and x-show toggles after the first paint,
            // so every DOM assertion below waits for a quiet frame first. Without this
            // the checks sample a mid-render state and report alerts that are hidden
            // by the time a user could see them.
            async function settle() {
                await page.waitForFunction(() => {
                    const el = document.querySelector('.hangar-shell');
                    return el && !el.hasAttribute('x-cloak');
                }, { timeout: 10000 });
                await page.waitForTimeout(700);
            }

            await check('no visible alert renders without a message', async () => {
                // An alert box containing only buttons tells the user nothing and
                // reads as a rendering bug. Checked across every screen, because it
                // is a whole class of defect rather than one place.
                const empty = [];
                for (const tab of ['Overview', 'Repositories', 'Jobs', 'Logbook', 'Recovery', 'Settings']) {
                    await page.click(`.nav-pills .nav-link:text-is("${tab}")`);
                    await settle();
                    for (const a of await page.$$('.alert')) {
                        // Re-check visibility immediately before reading, and trust the
                        // computed style rather than a cached handle state.
                        const shown = await a.evaluate((el) => {
                            const s = getComputedStyle(el);
                            return s.display !== 'none' && s.visibility !== 'hidden' &&
                                el.getClientRects().length > 0;
                        });
                        if (!shown) continue;
                        const text = (await a.textContent()).trim();
                        // Button labels are not a message.
                        const buttons = await a.$$eval('button', (bs) =>
                            bs.map((b) => b.textContent.trim()).join(''));
                        if (text.replace(buttons, '').trim() === '') {
                            empty.push(`${tab}: <${await a.getAttribute('class')}>`);
                        }
                    }
                }
                assertEqual(empty.length, 0, `alerts with no message: ${empty.join(' | ')}`);
            });

            await check('a load failure and the empty state are never shown together', async () => {
                // "No backups yet" next to "could not read the configuration" tells
                // the user two contradictory things.
                await page.click('.nav-pills .nav-link:text-is("Overview")');
                await settle();
                // Specifically the whole-screen load-failure banner (bound to `error`),
                // not the dismissible per-action alert, which is a different thing.
                const shown = await page.evaluate(() => {
                    const vis = (el) => el && getComputedStyle(el).display !== 'none' &&
                        el.getClientRects().length > 0;
                    const scope = document.querySelector('#hangar-overview');
                    if (!scope) return { err: false, empty: false };
                    const err = Array.from(scope.querySelectorAll('.alert-danger'))
                        .find((el) => el.getAttribute('x-show') === 'error');
                    return { err: vis(err), empty: vis(scope.querySelector('.hangar-empty')) };
                });
                assert(!(shown.err && shown.empty),
                    'the overview shows a load error and the "no backups yet" empty state at once');
            });

            await check('an empty Logbook guides instead of showing dead chrome', async () => {
                // With no repository the picker has nothing to pick, the breadcrumb
                // leads nowhere and Restore cannot act. Showing them makes a screen
                // that is merely empty look broken.
                await page.click('.nav-pills .nav-link:text-is("Logbook")');
                await settle();

                const shown = await page.evaluate(() => {
                    const scope = document.querySelector('#hangar-logbook');
                    const vis = (el) => !!el && getComputedStyle(el).display !== 'none' &&
                        el.getClientRects().length > 0;
                    return {
                        picker: vis(scope && scope.querySelector('#hangar-logbook-repo')),
                        restore: Array.from(scope ? scope.querySelectorAll('button') : [])
                            .some((b) => /^Restore/.test(b.textContent.trim()) &&
                                b.getClientRects().length > 0),
                        text: scope ? scope.innerText : ''
                    };
                });

                assertEqual(shown.picker, false, 'an empty repository dropdown is still on screen');
                assertEqual(shown.restore, false, 'Restore is offered with nothing to restore');
                assert(/No repositories yet/i.test(shown.text),
                    `the screen does not say what is missing:\n${shown.text.slice(0, 200)}`);
                assert(/Add a repository/i.test(shown.text),
                    'no way forward is offered');
                assert(!/Nothing to show here/i.test(shown.text),
                    'the old non-guidance text is still there');
            });

            await check('switching tabs changes the visible panel', async () => {
                for (const [label, id] of [['Logbook', 'hangar-logbook'], ['Settings', 'hangar-settings'],
                    ['Recovery', 'hangar-recovery'], ['Overview', 'hangar-overview']]) {
                    await page.click(`.nav-pills .nav-link:text-is("${label}")`);
                    await page.waitForTimeout(120);
                    assert(await page.isVisible(`#${id}`), `${label} panel not visible`);
                }
            });

            if (process.env.SHOT) await page.screenshot({ path: 'tests/e2e-overview.png', fullPage: true });
            await ctx.close();
        }

        // ---- missing prerequisites drive the turnkey gate
        {
            const { ctx, page } = await open(browser, {
                spawn: Object.assign({}, DEFAULT_STUB.spawn, {
                    'restic version': { error: true, message: 'not found', exit_status: 127 },
                    'rear -V': { error: true, message: 'not found', exit_status: 127 }
                })
            });

            await check('missing tools raise the install prompt rather than a dead end', async () => {
                await page.waitForSelector('.alert-warning', { timeout: 5000 });
                const text = await page.textContent('.alert-warning');
                assert(/not installed yet/i.test(text), `unexpected gate text: ${text}`);
                assert(/restic/.test(text), 'the gate does not name restic');
                // The whole point of turnkey: an Install button, not an instruction to
                // go and run a package manager.
                const btn = await page.$('.alert-warning button');
                assert(btn, 'no Install button in the prerequisite gate');
                assertEqual((await btn.textContent()).trim(), 'Install');
            });

            await check('the gate explains why each tool is needed', async () => {
                const text = await page.textContent('.alert-warning');
                assert(/engine|backup/i.test(text), `no reason given: ${text}`);
            });

            await check('an untouched install dialog does not claim to be waiting', async () => {
                // "Waiting" before anything has been started reads as a stalled
                // dialog. Nothing is waiting on anything until Install is pressed.
                await page.click('.alert-warning button:text-is("Install")');
                await page.waitForSelector('#hangar-provision.show', { timeout: 5000 });
                await page.waitForTimeout(600);
                const shown = await page.evaluate(() =>
                    document.querySelector('#hangar-provision').innerText);
                assert(!/\bWaiting\b/.test(shown),
                    `an untouched dialog says "Waiting":\n${shown.slice(0, 400)}`);
                assert(/Not installed/.test(shown),
                    `rows do not state they are not installed:\n${shown.slice(0, 400)}`);
                await page.click('#hangar-provision button:text-is("Close")');
                await page.waitForTimeout(300);
            });

            await check('a successful install clears the banner and the header chip', async () => {
                // Reported from real use: hangar installed the tools, but the banner
                // and the "2 tool(s) missing" chip kept showing what was true at page
                // load — so a working install looked like a failed one.
                assert(await page.isVisible('.alert-warning'), 'the gate should be showing to begin with');
                assert(await page.isVisible('.badge:has-text("missing")'), 'the chip should be showing');

                // Make the system report the tools as present, exactly as a real
                // install does, then announce it the way provision-ui now does.
                await page.evaluate(() => {
                    window.__hangarStub.spawn['restic version'] =
                        'restic 0.19.1 compiled with go1.26.4 on linux/amd64';
                    window.__hangarStub.spawn['rear --version'] = 'Relax-and-Recover 2.9';
                    window.dispatchEvent(new CustomEvent('hangar:provisioned'));
                });
                await page.waitForTimeout(700);

                assertEqual(await page.isVisible('.alert-warning'), false,
                    'the prerequisite banner survived a successful install');
                assertEqual(await page.isVisible('.badge:has-text("missing")'), false,
                    'the header chip still claims tools are missing');
            });

            if (process.env.SHOT) await page.screenshot({ path: 'tests/e2e-provision.png', fullPage: true });
            await ctx.close();
        }

        // ---- self-update badge
        {
            // The trailing status line is what `curl -w '%{http_code}'` appends,
            // and hangar reads it to tell "no releases yet" (404) from a real
            // failure. A stub that omits it is not standing in for curl.
            const release = JSON.stringify({
                tag_name: 'v9.9.9', body: 'notes', prerelease: false,
                assets: [{ name: 'hangar-9.9.9.zip', browser_download_url: 'https://github.com/o/r/releases/download/v9.9.9/hangar-9.9.9.zip' }]
            }) + '\n200';
            const { ctx, page } = await open(browser, {
                spawn: Object.assign({}, DEFAULT_STUB.spawn, { 'api.github.com': release }),
                files: Object.assign({}, DEFAULT_STUB.files, {
                    '/etc/hangar/config.json': JSON.stringify({ updateRepo: 'appuser/hangar', updateCheckOnStartup: true })
                })
            });

            await check('an available update surfaces as a button in the header', async () => {
                await page.waitForSelector('button:has-text("Update to 9.9.9")', { timeout: 5000 });
            });

            await check('the update check goes through curl, never browser fetch', async () => {
                // CSP connect-src 'self' blocks fetch() to github.com, so this is the
                // difference between a working updater and a silently broken one.
                const calls = await page.evaluate(() => window.__hangarStub.calls
                    .filter((c) => c.kind === 'spawn')
                    .map((c) => c.argv.join(' ')));
                const gh = calls.filter((c) => /api\.github\.com/.test(c));
                assert(gh.length > 0, 'no spawn reached api.github.com');
                assert(gh.every((c) => /^curl /.test(c)), `not curl: ${gh.join(' | ')}`);
            });

            await check('clicking the badge opens the update modal on its confirm step', async () => {
                await page.click('button:has-text("Update to 9.9.9")');
                await page.waitForSelector('#hangar-update.show', { timeout: 5000 });
                const text = await page.textContent('#hangar-update');
                assert(/9\.9\.9/.test(text), 'modal does not name the version');
                assert(/stays in place/i.test(text), 'modal omits the failure reassurance');
            });

            if (process.env.SHOT) await page.screenshot({ path: 'tests/e2e-update.png', fullPage: true });
            await ctx.close();
        }

        // ---- current version shown when up to date
        {
            const release = JSON.stringify({ tag_name: 'v0.0.1', assets: [] }) + '\n200';
            const { ctx, page } = await open(browser, {
                spawn: Object.assign({}, DEFAULT_STUB.spawn, { 'api.github.com': release }),
                files: Object.assign({}, DEFAULT_STUB.files, {
                    '/etc/hangar/config.json': JSON.stringify({ updateRepo: 'appuser/hangar', updateCheckOnStartup: true })
                })
            });

            await check('an older release is never offered as an update', async () => {
                await page.waitForTimeout(600);
                assertEqual(await page.isVisible('button:has-text("Update to")'), false,
                    'an older release was offered as an upgrade');
            });

            await ctx.close();
        }


        // ---- modal sizing, in its own context
        //
        // Opening six modals leaves Bootstrap teardown state behind — backdrops,
        // body classes, focus traps. Unpicking that reliably is not worth it when a
        // fresh page costs a second, and a leaked backdrop silently swallows the
        // clicks of whatever test runs next.
        {
            const { ctx, page } = await open(browser);
            const settle = async () => {
                await page.waitForSelector('.hangar-shell', { timeout: 10000 });
                await page.waitForTimeout(500);
            };
            await settle();
            await check('every modal fits the screen and scrolls when it is too tall', async () => {
                // Reported from real use: the job editor ran off the bottom of the
                // screen with no scrollbar and no reachable buttons.
                //
                // Cause: Bootstrap's .modal-dialog-scrollable constrains .modal-body
                // because the body is a flex CHILD of .modal-content. Four modals
                // wrap header/body/footer in a <form> so Enter submits, and a
                // block-level form breaks that chain — the body grew to its content
                // (1517px inside a 644px dialog) so there was nothing to scroll.
                const ids = ['hangar-job-edit', 'hangar-repo-edit', 'hangar-password',
                    'hangar-restore', 'hangar-provision', 'hangar-fspicker'];
                const bad = [];

                await page.setViewportSize({ width: 900, height: 620 });
                for (const id of ids) {
                    const r = await page.evaluate(async (id) => {
                        const el = document.getElementById(id);
                        if (!el || !window.bootstrap) return null;
                        window.bootstrap.Modal.getOrCreateInstance(el).show();
                        await new Promise((r) => setTimeout(r, 300));
                        const dlg = el.querySelector('.modal-dialog');
                        const body = el.querySelector('.modal-body');
                        const box = dlg.getBoundingClientRect();
                        body.scrollTop = 9999;
                        const moved = body.scrollTop;
                        body.scrollTop = 0;
                        const out = {
                            id,
                            fits: box.bottom <= window.innerHeight + 1 && box.top >= -1,
                            // Either it all fits, or it can actually be scrolled.
                            reachable: body.scrollHeight <= body.clientHeight + 2 || moved > 0
                        };
                        const m = window.bootstrap.Modal.getOrCreateInstance(el);
                        m.hide();
                        await new Promise((r) => setTimeout(r, 220));
                        // dispose + sweep: a lingering backdrop swallows the clicks
                        // of whatever test runs next.
                        m.dispose();
                        document.querySelectorAll('.modal-backdrop').forEach((b) => b.remove());
                        document.body.classList.remove('modal-open');
                        document.body.style.removeProperty('overflow');
                        document.body.style.removeProperty('padding-right');
                        return out;
                    }, id);
                    if (!r) continue;
                    if (!r.fits) bad.push(`${r.id}: runs off the screen`);
                    if (!r.reachable) bad.push(`${r.id}: content is cut off with no way to scroll`);
                }
                await page.setViewportSize({ width: 1280, height: 900 });

                assertEqual(bad.length, 0, bad.join(' | '));
            });
            await ctx.close();
        }

        // ---- themes
        {
            const { ctx, page } = await open(browser);

            await check('the saved theme is applied to <html> before anything renders', async () => {
                const attr = await page.getAttribute('html', 'data-bs-theme');
                assert(attr === 'light' || attr === 'dark',
                    `system should resolve to light or dark, got ${attr}`);
            });

            await check('the Settings screen offers every registered theme', async () => {
                await page.click('.nav-pills .nav-link:text-is("Settings")');
                await page.waitForSelector('.hangar-theme-option', { timeout: 5000 });
                const count = await page.locator('.hangar-theme-option').count();
                const registry = await page.evaluate(() => window.HangarThemes.THEMES.length);
                assertEqual(count, registry, 'picker does not show every theme');
            });

            await check('picking a theme repaints the whole page and persists it', async () => {
                await page.click('.hangar-theme-option:has-text("Nord")');
                await page.waitForTimeout(300);
                assertEqual(await page.getAttribute('html', 'data-bs-theme'), 'nord');

                // Written immediately — no Save step for a theme.
                const written = await page.evaluate(() => window.__hangarStub.calls
                    .filter((c) => c.kind === 'replace' && /config\.json$/.test(c.path))
                    .map((c) => JSON.parse(c.content).theme));
                assert(written.includes('nord'), `theme was not persisted: ${JSON.stringify(written)}`);
            });

            await check('a picked theme actually changes the rendered colours', async () => {
                // The attribute alone proves nothing if themes.css lacks the palette.
                const bg = await page.evaluate(() =>
                    getComputedStyle(document.body).backgroundColor);
                await page.click('.hangar-theme-option:has-text("Sepia")');
                await page.waitForTimeout(300);
                const after = await page.evaluate(() =>
                    getComputedStyle(document.body).backgroundColor);
                assert(bg !== after, `background did not change between themes (${bg})`);
            });

            await check('a theme pick does not mark the settings form dirty', async () => {
                // It is written on click, so claiming unsaved changes would be a lie.
                assertEqual(await page.isVisible('.badge:text-is("Unsaved changes")'), false);
            });

            if (process.env.SHOT) {
                await page.screenshot({ path: 'tests/e2e-theme.png', fullPage: true });
                await page.click('.nav-pills .nav-link:text-is("Settings")').catch(() => {});
                await page.waitForTimeout(600);
                await page.screenshot({ path: 'tests/e2e-settings.png', fullPage: true });
            }
            await ctx.close();
        }

        // ---- PackageKit missing: the turnkey dead end
        {
            const { ctx, page } = await open(browser, {
                spawn: Object.assign({}, DEFAULT_STUB.spawn, {
                    'restic version': { error: true, message: 'not found', exit_status: 127 }
                }),
                dbus: {
                    'org.freedesktop.PackageKit:Get': {
                        error: 'org.freedesktop.DBus.Error.ServiceUnknown: ' +
                            'The name org.freedesktop.PackageKit was not provided by any .service files'
                    }
                }
            });

            await check('a missing PackageKit is explained rather than silently failing', async () => {
                await page.click('.alert-warning button:text-is("Install")');
                await page.waitForSelector('#hangar-provision.show', { timeout: 5000 });
                await page.waitForTimeout(600);
                const text = await page.textContent('#hangar-provision');
                assert(/cannot install anything on this system automatically/i.test(text),
                    'no warning about the missing mechanism');
                assert(/PackageKit is not installed/i.test(text),
                    `the reason is not stated: ${text.slice(0, 300)}`);
            });

            await check('the exact command for this distribution is offered', async () => {
                // Wait for the command itself rather than reading whatever is on
                // screen — the dialog may still be probing.
                await page.waitForSelector('#hangar-provision code', { timeout: 5000 });
                const text = await page.textContent('#hangar-provision');
                // The host is RHEL-family, so it must say dnf — never a generic
                // "use your package manager".
                assert(/sudo dnf install -y PackageKit/.test(text),
                    `no per-distro command found: ${text.slice(0, 400)}`);
                assert(/sudo dnf install -y epel-release/.test(text),
                    'the direct route omits EPEL, so installing restic would fail');
            });

            await check('the dialog does not promise a shell-free install it cannot deliver', async () => {
                // innerText, not textContent: textContent returns hidden nodes too, so
                // it cannot tell "removed from the page" from "still in the DOM".
                const shown = await page.evaluate(() =>
                    document.querySelector('#hangar-provision').innerText);
                assert(!/nothing has\s+to be typed at a shell/i.test(shown),
                    'the dialog claims nothing must be typed, directly above two shell commands');
            });

            await check('the Install button is withdrawn, not left dangling', async () => {
                // A greyed-out Install invites repeated clicking on something that
                // cannot work; the commands are the action in this state.
                const visible = await page.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('#hangar-provision button'))
                        .filter((b) => /^Install/.test(b.textContent.trim()));
                    return btns.filter((b) => b.getClientRects().length > 0).length;
                });
                assertEqual(visible, 0, 'Install is still offered with no way to honour it');
                assert(await page.isVisible('#hangar-provision button:text-is("Check again")'),
                    'no way to re-check after running the command');
            });

            if (process.env.SHOT) await page.screenshot({ path: 'tests/e2e-nopackagekit.png', fullPage: true });
            await ctx.close();
        }

        // ---- creating a folder from the picker
        //
        // Reported from real use: "i can not create folder here". Not a permission
        // problem — the Create button was disabled and could never enable, because
        // its binding ended in `newFolderProblems().length` and Alpine sets a
        // boolean attribute for any value that is not null/undefined/false. A valid
        // name produced an empty array, whose .length is 0, so typing a GOOD name
        // is precisely what disabled the button.
        {
            const NUL = String.fromCharCode(30);
            const { ctx, page } = await open(browser, {
                spawn: Object.assign({}, DEFAULT_STUB.spawn, {
                    'ls -1 /etc/hangar/repos': '',
                    'find /': ['d\tetc', 'd\thome', 'd\tsrv'].join(NUL) + NUL,
                    'find /srv': '',
                    'mkdir': ''
                })
            });

            await check('a valid folder name enables Create rather than disabling it', async () => {
                await page.click('.nav-pills .nav-link:text-is("Repositories")');
                await page.click('button:text-is("Add repository")');
                await page.waitForSelector('#hangar-repo-edit.show', { timeout: 5000 });
                await page.click('#hangar-repo-edit button:has-text("Browse")');
                await page.waitForSelector('#hangar-fspicker.show', { timeout: 5000 });
                await page.waitForTimeout(500);

                await page.click('#hangar-fspicker button:has-text("New folder")');
                await page.waitForTimeout(300);

                const disabled = async () => await page.evaluate(() => {
                    const btn = Array.from(document.querySelectorAll('#hangar-fspicker button'))
                        .find((b) => b.textContent.trim() === 'Create');
                    return btn ? btn.disabled : 'no Create button';
                });

                assertEqual(await disabled(), true, 'Create is offered with no name typed');

                await page.fill('#hangar-fspicker-new', 'backups');
                await page.waitForTimeout(400);
                assertEqual(await disabled(), false,
                    'Create stayed disabled for a perfectly valid folder name');

                // And an invalid one disables it again, with the reason shown.
                await page.fill('#hangar-fspicker-new', 'a/b');
                await page.waitForTimeout(400);
                assertEqual(await disabled(), true, 'Create is offered for a name with a slash in it');
                const warned = await page.evaluate(() =>
                    document.getElementById('hangar-fspicker').innerText);
                assert(/cannot contain/.test(warned), `no reason shown: ${warned.slice(0, 120)}`);
            });

            await check('creating the folder runs mkdir and moves into it', async () => {
                await page.fill('#hangar-fspicker-new', 'backups');
                await page.waitForTimeout(300);
                await page.evaluate(() => { window.__hangarStub.calls.length = 0; });
                await page.click('#hangar-fspicker button:text-is("Create")');
                await page.waitForTimeout(1200);

                const calls = await page.evaluate(() => (window.__hangarStub.calls || [])
                    .filter((c) => c.kind === 'spawn').map((c) => (c.argv || []).join(' ')));
                const mkdir = calls.find((c) => /^mkdir /.test(c));
                assert(!!mkdir, `mkdir never ran: ${JSON.stringify(calls)}`);
                assert(/\/backups$/.test(mkdir), `mkdir made the wrong path: ${mkdir}`);
                // -- terminates options so a leading-dash name cannot become a flag.
                assert(/ -- /.test(mkdir), `no option terminator: ${mkdir}`);
            });

            await ctx.close();
        }

        // ---- deleting a snapshot from the Logbook
        //
        // restic separates unlinking a snapshot from reclaiming its space, and a
        // live Logbook mount holds a shared lock that prune cannot work around —
        // so this checks the whole shape: confirmed, unmounted, forgotten AND
        // pruned, then the timeline re-read.
        {
            const REPO = { id: 'attic', kind: 'local', name: 'Attic', path: '/srv/backups/attic' };
            const SNAPS = [
                { id: 'aa11bb22cc33', short_id: 'aa11bb22', time: new Date(Date.now() - 7200e3).toISOString(),
                    hostname: 'db01', paths: ['/home'] },
                { id: 'dd44ee55ff66', short_id: 'dd44ee55', time: new Date(Date.now() - 3600e3).toISOString(),
                    hostname: 'db01', paths: ['/home'] }
            ];
            const { ctx, page } = await open(browser, {
                spawn: Object.assign({}, DEFAULT_STUB.spawn, {
                    'ls -1 /etc/hangar/repos': 'attic.json',
                    'find /run/hangar/mnt': 'f\t2048\t1700000000\tnotes.md\u001e',
                    'snapshots': JSON.stringify(SNAPS),
                    'stats': JSON.stringify({ total_size: 1024, snapshots_count: 2 }),
                    'forget': '[]', 'diff': '', 'test -d': '',
                    'systemd-run': '', 'systemctl': '', 'install -d': ''
                }),
                files: Object.assign({}, DEFAULT_STUB.files, {
                    '/etc/hangar/repos/attic.json': JSON.stringify(REPO)
                }),
                dbus: {
                    'org.freedesktop.systemd1:LoadUnit': ['/org/freedesktop/systemd1/unit/hangar'],
                    'org.freedesktop.systemd1:GetAll': [{
                        ActiveState: { v: 'inactive' }, SubState: { v: 'dead' },
                        LoadState: { v: 'loaded' }, Id: { v: 'hangar.service' }
                    }]
                }
            });

            await check('the Logbook offers to delete the snapshot being viewed', async () => {
                await page.click('.nav-pills .nav-link:text-is("Logbook")');
                await page.waitForSelector('#hangar-logbook', { timeout: 5000 });
                await page.waitForTimeout(2500);
                const btn = await page.$('#hangar-logbook button:has-text("Delete snapshot")');
                assert(!!btn, 'no delete control on the Logbook');
                const label = await btn.getAttribute('aria-label');
                assert(/Delete the snapshot from .+/.test(label || ''),
                    `the button does not name what it destroys: ${label}`);
            });

            await check('deleting asks first, and does nothing when refused', async () => {
                await page.click('#hangar-logbook button:has-text("Delete snapshot")');
                await page.waitForSelector('#hangar-confirm.show', { timeout: 5000 });
                const text = await page.evaluate(() =>
                    document.getElementById('hangar-confirm').innerText);
                assert(/cannot be undone/i.test(text), `the dialog does not say it is final: ${text}`);
                await page.click('#hangar-confirm button:text-is("Cancel")');
                await page.waitForTimeout(600);
                const ran = await page.evaluate(() => (window.__hangarStub.calls || [])
                    .some((c) => c.kind === 'spawn' && (c.argv || []).includes('forget')));
                assert(!ran, 'restic forget ran even though the user cancelled');
            });

            await check('confirming forgets AND prunes, after dropping the mount', async () => {
                await page.evaluate(() => { window.__hangarStub.calls.length = 0; });
                await page.click('#hangar-logbook button:has-text("Delete snapshot")');
                await page.waitForSelector('#hangar-confirm.show', { timeout: 5000 });
                await page.click('#hangar-confirm button:text-is("Delete snapshot")');
                await page.waitForTimeout(2500);

                const calls = await page.evaluate(() => (window.__hangarStub.calls || [])
                    .filter((c) => c.kind === 'spawn').map((c) => (c.argv || []).join(' ')));
                const forget = calls.find((c) => / forget /.test(c + ' '));
                assert(!!forget, `no forget was run: ${JSON.stringify(calls)}`);
                assert(/--prune/.test(forget), `space is never reclaimed: ${forget}`);
                assert(/dd44ee55ff66|aa11bb22cc33/.test(forget),
                    `no snapshot id was passed — that is a different command entirely: ${forget}`);

                // The mount holds a shared lock; prune needs an exclusive one.
                // The unit is stopped over systemd's D-Bus API, not by spawning
                // systemctl, so the ordering has to be read from the whole call
                // log rather than from the spawns alone.
                const ordered = await page.evaluate(() => (window.__hangarStub.calls || [])
                    .map((c) => c.kind === 'dbus'
                        ? `dbus:${c.method}:${JSON.stringify(c.args)}`
                        : `spawn:${(c.argv || []).join(' ')}`));
                const stopped = ordered.findIndex((c) => /dbus:StopUnit.*hangar-mount/.test(c));
                const forgotAt = ordered.findIndex((c) => / forget /.test(c + ' '));
                assert(stopped >= 0,
                    `the mount was never released, so prune would hit hangar's own lock: ${JSON.stringify(ordered)}`);
                assert(stopped < forgotAt,
                    'the mount was released after the prune, which is too late');
            });

            await ctx.close();
        }

        // ---- pressing Save actually writes the job
        //
        // Reported from real use: "i pressed save for job, no job appeared,
        // refreshed but the same". Every partial carried x-init="init()" while its
        // component also defined init(), and Alpine 3 calls init() by itself — so
        // init ran twice and every window listener was registered twice. The job
        // dialog therefore received its own open event twice; the second delivery
        // hit the "a second open cancels the first" guard and resolved the caller's
        // promise with null. Save then closed the dialog, wrote nothing, and
        // reported nothing.
        {
            const REPO = { id: 'attic', kind: 'local', name: 'Attic', path: '/srv/backups/attic' };
            const { ctx, page } = await open(browser, {
                spawn: Object.assign({}, DEFAULT_STUB.spawn, {
                    'ls -1 /etc/hangar/repos': 'attic.json',
                    'snapshots': '[]',
                    'stats': JSON.stringify({ total_size: 0, snapshots_count: 0 }),
                    'systemctl': '', 'systemd-run': ''
                }),
                files: Object.assign({}, DEFAULT_STUB.files, {
                    '/etc/hangar/repos/attic.json': JSON.stringify(REPO)
                })
            });

            await check('opening a dialog does not resolve the caller before they answer', async () => {
                // The exact mechanism of the silent save. With init() running twice
                // the dialog held two listeners, so one dispatch arrived twice; the
                // second arrival hit "a second open cancels the first" and resolved
                // the promise the Jobs screen was waiting on — with null, before the
                // user had touched anything. Save then had nothing left to resolve.
                const settled = await page.evaluate(() => new Promise((done) => {
                    let state = 'NOT_CALLED';
                    window.dispatchEvent(new CustomEvent('hangar:job-edit', {
                        detail: { form: {}, repos: [], taken: [], resolve: (v) => { state = String(v); } }
                    }));
                    setTimeout(() => done(state), 500);
                }));
                assertEqual(settled, 'NOT_CALLED',
                    `the dialog resolved its caller on open, with ${settled}`);

                // That dispatch opened the dialog; close it properly, or its
                // backdrop swallows the next check's clicks.
                await page.click('#hangar-job-edit button:text-is("Cancel")');
                await page.waitForSelector('#hangar-job-edit.show', { state: 'hidden', timeout: 5000 });
            });

            await check('pressing Save writes the job and lists it', async () => {
                await page.click('.nav-pills .nav-link:text-is("Jobs")');
                await page.waitForTimeout(600);
                await page.click('button:text-is("Create job")');
                await page.waitForSelector('#hangar-job-edit.show', { timeout: 5000 });
                await page.waitForTimeout(600);

                await page.fill('#hangar-job-id', 'nightly');
                await page.fill('#hangar-job-name', 'Nightly');
                await page.selectOption('#hangar-job-repo', 'attic');
                await page.fill('#hangar-job-edit textarea', '/home');
                await page.click('#hangar-job-edit button:text-is("Save job")');
                await page.waitForTimeout(2000);

                // It must reach /etc, not merely disappear from the dialog.
                const written = await page.evaluate(() => (window.__hangarStub.calls || [])
                    .filter((c) => c.kind === 'replace' && /\/etc\/hangar\/jobs\//.test(c.path || ''))
                    .map((c) => c.path));
                assert(written.some((p) => /nightly\.json$/.test(p)),
                    `nothing was written to /etc/hangar/jobs: ${JSON.stringify(written)}`);

                // The stub records writes but does not materialise files, so make
                // the world reflect what was just written and re-read it the way
                // the user did when they pressed Refresh.
                await page.evaluate(() => {
                    const call = (window.__hangarStub.calls || [])
                        .filter((c) => c.kind === 'replace' && /jobs\/nightly\.json$/.test(c.path || '')).pop();
                    window.__hangarStub.spawn['ls -1 /etc/hangar/jobs'] = 'nightly.json';
                    window.__hangarStub.files['/etc/hangar/jobs/nightly.json'] = call.content;
                });
                await page.click('#hangar-jobs button:text-is("Refresh")');
                await page.waitForTimeout(1500);

                const onScreen = await page.evaluate(() =>
                    document.getElementById('hangar-jobs').innerText);
                assert(/Nightly/.test(onScreen), `the saved job is not listed: ${onScreen.slice(0, 120)}`);
                assert(!/No backup jobs yet/i.test(onScreen),
                    'the screen still says there are no jobs');
            });

            await ctx.close();
        }

        // ---- a repository created just now is offered to the next job
        //
        // Reported from real use: "i created a repository but dropdown has nothing
        // in it". Every screen keeps its own copy of the repository list, read when
        // that screen loaded, and the Jobs screen had loaded before the repository
        // existed.
        {
            const REPO = { id: 'attic', kind: 'local', name: 'Attic', path: '/srv/backups/attic' };
            let listed = '';                       // what `ls` reports, mutated mid-test
            const { ctx, page } = await open(browser, {
                spawn: Object.assign({}, DEFAULT_STUB.spawn, {
                    'ls -1 /etc/hangar/repos': '',
                    'snapshots': '[]',
                    'stats': JSON.stringify({ total_size: 0, snapshots_count: 0 })
                }),
                files: Object.assign({}, DEFAULT_STUB.files, {
                    '/etc/hangar/repos/attic.json': JSON.stringify(REPO)
                })
            });

            await check('a repository created after the Jobs screen loaded is still offered', async () => {
                // Load the Jobs screen FIRST, with no repositories — the state the
                // report came from.
                await page.click('.nav-pills .nav-link:text-is("Jobs")');
                await page.waitForTimeout(800);

                // Now one appears, exactly as creating one on the other tab would
                // leave the world, and the Repositories screen announces it.
                await page.evaluate(() => {
                    window.__hangarStub.spawn['ls -1 /etc/hangar/repos'] = 'attic.json';
                    window.dispatchEvent(new CustomEvent('hangar:repos-changed'));
                });
                await page.waitForTimeout(800);

                await page.click('button:text-is("Create job")');
                await page.waitForSelector('#hangar-job-edit.show', { timeout: 5000 });
                await page.waitForTimeout(800);

                const seen = await page.evaluate(() => {
                    const sel = document.querySelector('#hangar-job-repo');
                    return sel ? Array.from(sel.options).map((o) => o.value).filter(Boolean) : [];
                });
                assert(seen.includes('attic'),
                    `the new repository is not in the dropdown: ${JSON.stringify(seen)}`);
                await page.click('#hangar-job-edit button:text-is("Cancel")');
                await page.waitForTimeout(400);
            });

            await ctx.close();
        }

        // ---- an empty dropdown is replaced by the action that fills it
        //
        // The default stub has no repositories, which is the state a fresh
        // install is in: the job dialog used to render a picker containing only
        // "Choose a repository…" and a line of text naming another tab.
        {
            const { ctx, page } = await open(browser);

            await check('the job dialog offers no empty repository dropdown', async () => {
                await page.click('.nav-pills .nav-link:text-is("Jobs")');
                await page.waitForTimeout(500);
                await page.click('button:text-is("Create job")');
                await page.waitForSelector('#hangar-job-edit.show', { timeout: 5000 });
                await page.waitForTimeout(600);
                const seen = await page.evaluate(() => {
                    const dlg = document.getElementById('hangar-job-edit');
                    const sel = dlg.querySelector('#hangar-job-repo');
                    const guide = Array.from(dlg.querySelectorAll('.hangar-empty'))
                        .find((e) => e.getClientRects().length);
                    return { select: !!(sel && sel.getClientRects().length),
                        guidance: guide ? guide.innerText.replace(/\s+/g, ' ') : '' };
                });
                assert(!seen.select, 'an empty repository dropdown is still rendered');
                assert(/no repository yet/i.test(seen.guidance),
                    `no guidance in its place: ${JSON.stringify(seen.guidance)}`);
            });

            await check('the guidance leads to the screen that can help', async () => {
                await page.click('#hangar-job-edit button:text-is("Create one now")');
                await page.waitForTimeout(900);
                const landed = await page.evaluate(() => ({
                    jobDialogOpen: !!document.querySelector('#hangar-job-edit.show'),
                    tab: document.querySelector('.nav-pills .nav-link.active').textContent.trim(),
                    repoDialogOpen: !!document.querySelector('#hangar-repo-edit.show')
                }));
                assert(!landed.jobDialogOpen, 'the job dialog was left open behind the new screen');
                assertEqual(landed.tab, 'Repositories', 'did not land on the Repositories tab');
                assert(landed.repoDialogOpen, 'the user was sent to a screen and left to find the button');
            });

            await check('no screen shows a dropdown with nothing to choose', async () => {
                // The rule, checked across every tab rather than one dialog.
                for (const tab of ['Overview', 'Repositories', 'Jobs', 'Logbook', 'Recovery', 'Settings']) {
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(200);
                    await page.click(`.nav-pills .nav-link:text-is("${tab}")`);
                    await page.waitForTimeout(700);
                    const empty = await page.evaluate(() => Array.from(document.querySelectorAll('select'))
                        .filter((s) => s.getClientRects().length)
                        .filter((s) => s.options.length === 0 ||
                            (s.options.length === 1 && s.options[0].value === ''))
                        .map((s) => s.id || s.getAttribute('x-model')));
                    assertEqual(empty.length, 0, `${tab} shows an empty dropdown: ${JSON.stringify(empty)}`);
                }
            });

            await ctx.close();
        }

        // ---- a loaded screen must stop saying it is loading
        //
        // Both failures below were invisible to the unit suites: the data was
        // right, only the DOM disagreed. They are the reason this block exists.
        {
            const REPO = { id: 'attic', kind: 'local', name: 'Attic', path: '/srv/backups/attic' };
            const SNAPS = [
                { id: 'aa11', short_id: 'aa11', time: new Date(Date.now() - 7200e3).toISOString(),
                    hostname: 'db01', paths: ['/home'] },
                { id: 'bb22', short_id: 'bb22', time: new Date(Date.now() - 3600e3).toISOString(),
                    hostname: 'db01', paths: ['/home'] }
            ];
            const { ctx, page } = await open(browser, {
                spawn: Object.assign({}, DEFAULT_STUB.spawn, {
                    'ls -1 /etc/hangar/repos': 'attic.json',
                    // Ahead of 'snapshots': the mounted tree is read from a path
                    // that contains /snapshots/, and the stub matches substrings.
                    'find /run/hangar/mnt': 'f\t2048\t1700000000\tnotes.md\n',
                    // The folder picker's own listing: "%y\t%f" per record,
                    // separated by RS (\u001e) — what listArgv asks find for.
                    'find /': ['d\tetc', 'd\thome', 'd\tsrv'].join('\u001e') + '\u001e',
                    'snapshots': JSON.stringify(SNAPS),
                    'stats': JSON.stringify({ total_size: 5_368_709_120, snapshots_count: 2 }),
                    'diff': '',
                    'systemd-run': '', 'systemctl': ''
                }),
                files: Object.assign({}, DEFAULT_STUB.files, {
                    '/etc/hangar/repos/attic.json': JSON.stringify(REPO),
                    // A size measured three hours ago. Fresh under the shipped
                    // 24 hour default, so the Overview must show it — and its
                    // date — without asking the repository anything.
                    '/var/lib/hangar/state/size-attic.json': JSON.stringify({
                        size: 5368709120, snapshots: 2, at: Date.now() - 3 * 3600e3
                    })
                }),
                // The Logbook asks systemd whether its mount unit is already up.
                // Without an answer it falls back to `restic ls`, which this stub
                // does not serve — and the tree would be empty for the wrong reason.
                dbus: {
                    'org.freedesktop.systemd1:LoadUnit': ['/org/freedesktop/systemd1/unit/hangar'],
                    'org.freedesktop.systemd1:GetAll': [{
                        ActiveState: { v: 'inactive' }, SubState: { v: 'dead' },
                        LoadState: { v: 'loaded' }, Id: { v: 'hangar.service' }
                    }]
                }
            });

            await check('a remembered size and its date render on the Overview', async () => {
                // Both of the last two UI bugs on this screen were invisible to
                // the unit suites — the data was right and the DOM disagreed —
                // so the size cache is checked here, in a real browser, against
                // the real template.
                await page.click('.nav-pills .nav-link:text-is("Overview")');
                await page.waitForSelector('#hangar-overview', { timeout: 5000 });
                await page.waitForTimeout(1200);
                const shown = await page.evaluate(() =>
                    document.getElementById('hangar-overview').innerText);
                // The date the cache carries, not the moment the page rendered.
                assert(/measured 3 hours ago/.test(shown),
                    `the remembered date is not on screen: ${shown.slice(0, 400)}`);
                assert(/5\.0 GiB/.test(shown), `the remembered size is not on screen: ${shown.slice(0, 400)}`);
                assert(/Measure now/.test(shown), 'the Measure now button is not on screen');
                if (process.env.SHOT)
                    await page.screenshot({ path: 'tests/e2e-reposize.png', fullPage: true });

                // And refreshing costs nothing: a size three hours old is fresh
                // under the shipped 24 hour default, so the Overview must not
                // touch the repository. Counted as a delta because the
                // Repositories screen measures on load whatever the cache says.
                const statsCalls = () => page.evaluate(() => window.__hangarStub.calls
                    .filter((c) => c.kind === 'spawn' && /stats/.test(String(c.argv))).length);
                const before = await statsCalls();
                await page.click('#hangar-overview button:text-is("Refresh")');
                await page.waitForTimeout(1200);
                assertEqual(await statsCalls(), before,
                    'the Overview measured a repository whose size it already knew');
            });

            await check('Measure now asks the repository again', async () => {
                await page.click('.nav-pills .nav-link:text-is("Overview")');
                await page.waitForSelector('#hangar-overview', { timeout: 5000 });
                const before = await page.evaluate(() => window.__hangarStub.calls
                    .filter((c) => c.kind === 'spawn' && /stats/.test(String(c.argv))).length);
                await page.click('#hangar-overview button:text-is("Measure now")');
                await page.waitForTimeout(1200);
                const after = await page.evaluate(() => window.__hangarStub.calls
                    .filter((c) => c.kind === 'spawn' && /stats/.test(String(c.argv))).length);
                assert(after > before,
                    `Measure now ran no stats call: ${before} -> ${after}`);
            });

            await check('a repository row shows its size instead of a stuck "Reading repository…"', async () => {
                // refresh() used to hand loadStats the raw row objects rather than
                // Alpine's proxies, so the size arrived in the data and never on
                // screen: the row sat at "Reading repository…" with an em dash.
                await page.click('.nav-pills .nav-link:text-is("Repositories")');
                await page.waitForSelector('#hangar-repos', { timeout: 5000 });
                await page.waitForTimeout(1200);
                const shown = await page.evaluate(() =>
                    document.getElementById('hangar-repos').innerText);
                assert(/GiB|MiB|KiB|bytes/.test(shown), `no size rendered: ${shown.slice(0, 300)}`);
                assert(!/Reading repository/.test(shown),
                    'the row still claims it is reading the repository');
                const disabled = await page.evaluate(() => Array.from(
                    document.querySelectorAll('#hangar-repos button'))
                    .filter((b) => /^(Test|Check|Edit)$/.test(b.textContent.trim()) && b.disabled).length);
                assertEqual(disabled, 0, 'row actions are still disabled by a busy flag nobody cleared');
            });

            await check('Browse opens the folder picker and fills the field', async () => {
                // It opened nothing at all: app.js loads last and replaced the
                // shared HangarDialogs object, deleting the pickPath that
                // fspicker-ui.js had registered. Clicking Browse hit a missing
                // function and returned false without a word.
                await page.click('.nav-pills .nav-link:text-is("Repositories")');
                await page.click('button:text-is("Add repository")');
                await page.waitForSelector('#hangar-repo-edit.show', { timeout: 5000 });
                await page.click('#hangar-repo-edit button:has-text("Browse")');
                await page.waitForSelector('#hangar-fspicker.show', { timeout: 5000 });
                await page.waitForSelector('#hangar-fspicker >> text=srv', { timeout: 5000 });

                // And it must hand the choice back, not just open.
                await page.click('#hangar-fspicker >> text=srv');
                await page.waitForTimeout(300);
                await page.click('#hangar-fspicker button:text-is("Choose")');
                await page.waitForSelector('#hangar-fspicker.show', { state: 'hidden', timeout: 5000 });
                const value = await page.inputValue('#hangar-repo-edit input[x-model="form[f.name]"]')
                    .catch(async () => await page.evaluate(() => {
                        const el = Array.from(document.querySelectorAll('#hangar-repo-edit input'))
                            .find((i) => /srv/.test(i.value));
                        return el ? el.value : '';
                    }));
                assert(/\/srv/.test(value), `the picked folder never reached the field: ${value}`);

                await page.click('#hangar-repo-edit button:text-is("Cancel")');
                await page.waitForSelector('#hangar-repo-edit.show', { state: 'hidden', timeout: 5000 });
            });

            await check('no select displays a value its component does not hold', async () => {
                // Alpine binds x-model before the <template x-for> inside the
                // select has produced an option, so the browser keeps showing the
                // first one: the password dialog offered a six-word passphrase
                // under a box reading "Two words, two numbers — weak".
                await page.evaluate(() => window.dispatchEvent(new CustomEvent('hangar:password',
                    { detail: { confirming: true, repoLabel: 'attic', resolve() {} } })));
                await page.waitForSelector('#hangar-pw-pattern', { timeout: 5000 });
                await page.waitForTimeout(400);
                const wrong = await page.evaluate(() =>
                    Array.from(document.querySelectorAll('select[x-model]'))
                        .filter((el) => el.options.length)
                        .map((el) => ({
                            id: el.id || el.getAttribute('x-model'),
                            shown: el.value,
                            held: String(window.Alpine.evaluate(el, el.getAttribute('x-model')))
                        }))
                        // A model value with no matching option is a different
                        // problem, and deliberately not resynced.
                        .filter((r) => r.shown !== r.held && r.held !== 'undefined'));
                assertEqual(wrong.length, 0, `selects out of sync: ${JSON.stringify(wrong)}`);

                // Leave the screen as it was found: an open modal swallows the
                // clicks the next check makes.
                await page.click('#hangar-password button:text-is("Cancel")');
                await page.waitForSelector('#hangar-password.show', { state: 'hidden', timeout: 5000 });
            });

            await check('the Logbook stops saying it is mounting once the tree is up', async () => {
                // Three overlapping loads shared one boolean, so the first to
                // finish declared the screen idle while the others still ran —
                // and Alpine applies x-show on an animation frame, which let the
                // flurry settle on "shown" over a finished tree.
                await page.click('.nav-pills .nav-link:text-is("Logbook")');
                await page.waitForSelector('#hangar-logbook', { timeout: 5000 });
                await page.waitForTimeout(1500);
                const shown = await page.evaluate(() =>
                    document.getElementById('hangar-logbook').innerText);
                assert(/notes\.md/.test(shown), `the tree never rendered: ${shown.slice(0, 300)}`);
                assert(!/Mounting the repository|Reading the snapshot|Reading snapshots|Looking for repositories/
                    .test(shown), `a stale progress line is still on screen: ${shown.slice(0, 300)}`);
            });

            await ctx.close();
        }

    } finally {
        await browser.close();
        server.close();
    }

    console.log(`\ne2e: ${passed} passed, ${failures.length} failed`);
    if (failures.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
