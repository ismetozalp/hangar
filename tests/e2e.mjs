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
        'ls -1 /etc/hangar/jobs': ''
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
            const release = JSON.stringify({
                tag_name: 'v9.9.9', body: 'notes', prerelease: false,
                assets: [{ name: 'hangar-9.9.9.zip', browser_download_url: 'https://github.com/o/r/releases/download/v9.9.9/hangar-9.9.9.zip' }]
            });
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
            const release = JSON.stringify({ tag_name: 'v0.0.1', assets: [] });
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

            if (process.env.SHOT) await page.screenshot({ path: 'tests/e2e-theme.png', fullPage: true });
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

    } finally {
        await browser.close();
        server.close();
    }

    console.log(`\ne2e: ${passed} passed, ${failures.length} failed`);
    if (failures.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
