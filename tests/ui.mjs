#!/usr/bin/env node
// tests/ui.mjs — drive hangar inside a REAL Cockpit session.
//
// tests/e2e.mjs serves the plugin from a plain HTTP server against a stubbed
// cockpit bridge. That catches a great deal, and it is blind to everything that
// only the real bridge does. It said the folder picker worked while the picker
// was listing nothing at all on the real machine, because the stub answered
// exactly what it was asked and the bridge did not:
//
//   * cockpit.spawn's TEXT channel discards output containing NUL bytes. find
//     -printf '%y\t%f\0' resolves with an empty string — no error, no partial
//     result — so every folder looked empty. '%y\t%f\036' returns all records.
//   * superuser: 'require' is REFUSED in a session with limited access, so a
//     listing that demanded it showed "Not permitted to perform this action."
//     and nothing else.
//
// Guarded, and a skip rather than a failure when it cannot run:
//
//   COCKPIT_PASS=… npm run test:ui
//   npm run test:ui            (reads $COCKPIT_CREDENTIALS_FILE)
//
// The credentials file is yours to create and is never read from the repository:
//
//   { "host": "https://localhost:9090", "user": "you", "password": "..." }
//
// chmod 600 it. Without it (and without COCKPIT_PASS) these checks skip rather
// than fail, because a missing password is not a broken plugin.
//
// Exit 0 pass, 1 fail, 2 skipped.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const SHOT = path.join(os.tmpdir(), 'hangar-ui.png');

function credentials() {
    // Named by $COCKPIT_CREDENTIALS_FILE, and never stored in the repository: a
    // file of real passwords must not sit where a `git add .` can reach it.
    // ~/cockpit-credentials.json is only the fallback when the variable is unset.
    const file = process.env.COCKPIT_CREDENTIALS_FILE
        || path.join(os.homedir(), 'cockpit-credentials.json');
    let stored = {};
    try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* env only */ }
    return {
        url: process.env.COCKPIT_URL || stored.host || 'https://localhost:9090',
        user: process.env.COCKPIT_USER || stored.user || os.userInfo().username,
        pass: process.env.COCKPIT_PASS || stored.password || ''
    };
}

let passed = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { passed++; console.log(`  ok  ${name}`); return; }
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
}

async function main() {
    const cfg = credentials();
    if (!cfg.pass) {
        console.log('skip ui (no COCKPIT_PASS and no stored credentials)');
        process.exit(2);
    }

    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    try {
        await page.goto(cfg.url, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#login-user-input', { timeout: 20000 });
        await page.fill('#login-user-input', cfg.user);
        await page.fill('#login-password-input', cfg.pass);
        await page.click('#login-button');
        await page.waitForTimeout(6000);

        // First, what hangar says BEFORE access is granted. Every Cockpit session
        // starts here, /etc/hangar is root-owned, and the honest answer matters
        // more than any other message in the plugin: a machine with a working
        // repository was once told it had none.
        await page.goto(cfg.url + '/hangar', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(5000);
        {
            const limitedFrame = page.frames().find((f) => /hangar/.test(f.name()));
            check('the plugin loads with limited access', !!limitedFrame);
            if (limitedFrame) {
                await limitedFrame.waitForSelector('.hangar-shell', { timeout: 20000 });
                const banner = await limitedFrame.evaluate(() => {
                    const el = Array.from(document.querySelectorAll('.alert'))
                        .find((a) => /administrative access/i.test(a.innerText));
                    return el && el.getClientRects().length ? el.innerText : '';
                });
                check('limited access is named, not silently swallowed',
                    /administrative access/i.test(banner), JSON.stringify(banner.slice(0, 120)));

                await limitedFrame.click('.nav-pills .nav-link:text-is("Repositories")');
                await limitedFrame.waitForTimeout(2500);
                const shown = await limitedFrame.evaluate(() =>
                    document.getElementById('hangar-repos').innerText);
                check('a refused listing is never reported as "no repositories yet"',
                    !/no repositories yet/i.test(shown), shown.replace(/\s+/g, ' ').slice(0, 140));
            }
        }

        // Now grant it, the way a user does.
        const limited = await page.$('button:has-text("Limited access")');
        if (limited) {
            await limited.click();
            await page.waitForTimeout(1500);
            const pw = await page.$('input[type="password"]');
            if (pw) {
                await pw.fill(cfg.pass);
                const auth = await page.$('button:has-text("Authenticate")');
                if (auth) await auth.click();
                await page.waitForTimeout(3000);
            }
        }

        await page.goto(cfg.url + '/hangar', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(5000);
        // The plugin is in the inner iframe, identified by NAME; the outer
        // /hangar page is only the shell that hosts it.
        const frame = page.frames().find((f) => /hangar/.test(f.name()));
        check('the plugin loads in a real Cockpit session', !!frame);
        if (!frame) throw new Error('no hangar frame');
        await frame.waitForSelector('.hangar-shell', { timeout: 20000 });

        // --- the bridge, before any UI is involved -------------------------

        const spawned = await frame.evaluate(async () => {
            const out = String(await cockpit.spawn(
                window.HangarFsPicker.listArgv('/'), { superuser: 'try', err: 'message' }));
            return { length: out.length, entries: window.HangarFsPicker.parseListing(out, { mode: 'dir' }).length };
        });
        check('a real listing of / comes back with records', spawned.entries > 3,
            `${spawned.length} chars, ${spawned.entries} entries`);

        const nulLost = await frame.evaluate(async () => {
            // The exact format hangar used to ship. If this ever stops being
            // empty, cockpit learned to carry NUL and the note in fspicker.js
            // needs revisiting — it does not mean anything is broken.
            const out = String(await cockpit.spawn(
                ['find', '/', '-mindepth', '1', '-maxdepth', '1', '-printf', '%y\\t%f\\0'],
                { err: 'message' }));
            return out.length;
        });
        check('NUL-separated output is still lost by the text channel (why we use RS)',
            nulLost === 0, `NUL listing returned ${nulLost} chars`);

        // --- the journey a person makes ------------------------------------

        await frame.click('.nav-pills .nav-link:text-is("Repositories")');
        await frame.waitForTimeout(800);
        await frame.click('button:text-is("Add repository")');
        await frame.waitForSelector('#hangar-repo-edit.show', { timeout: 10000 });
        await frame.click('#hangar-repo-edit button:has-text("Browse")');
        await frame.waitForSelector('#hangar-fspicker.show', { timeout: 10000 });
        await frame.waitForTimeout(2000);

        const state = async () => JSON.parse(await frame.evaluate(() => {
            const el = document.getElementById('hangar-fspicker');
            const d = window.Alpine.$data(el.querySelector('[x-data]') || el);
            return JSON.stringify({ cwd: d.cwd, error: d.error, count: (d.entries || []).length });
        }));

        const atRoot = await state();
        check('the picker lists / instead of calling it empty', atRoot.count > 3,
            JSON.stringify(atRoot));
        check('listing / raises no error', !atRoot.error, atRoot.error);

        const home = await frame.$('#hangar-fspicker .list-group-item:has-text("home")');
        check('/home is offered', !!home);
        if (home) {
            await home.click();
            await frame.waitForTimeout(1500);
            const inHome = await state();
            check('clicking a folder descends into it', inHome.cwd === '/home', JSON.stringify(inHome));

            const inner = await frame.$('#hangar-fspicker .list-group-item');
            if (inner) {
                await inner.click();
                await frame.waitForTimeout(1500);
                const deep = await state();
                check('a second level opens too', deep.cwd.startsWith('/home/') && deep.count > 0,
                    JSON.stringify(deep));
            }

            await frame.click('#hangar-fspicker button:text-is("Up")');
            await frame.waitForTimeout(1200);
            const up = await state();
            check('Up climbs back out', up.cwd === '/home', JSON.stringify(up));
        }

        await frame.click('#hangar-fspicker button:text-is("Choose")');
        await frame.waitForTimeout(1200);
        const value = await frame.evaluate(() => {
            const el = Array.from(document.querySelectorAll('#hangar-repo-edit input'))
                .find((i) => /^\//.test(i.value));
            return el ? el.value : '';
        });
        check('the chosen folder reaches the form', /^\/home/.test(value), `field held ${JSON.stringify(value)}`);

        check('no uncaught script errors in a real session', pageErrors.length === 0,
            JSON.stringify(pageErrors));

        await page.screenshot({ path: SHOT });
    } finally {
        await ctx.close();
        await browser.close();
    }

    console.log(`\nui: ${passed} passed, ${failures.length} failed  (shot: ${SHOT})`);
    process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
