#!/usr/bin/env node
// tests/screenshots.mjs — generate the README screenshots.
//
// Reuses the e2e harness: the plugin is served locally and driven against the
// stubbed Cockpit bridge, so this needs no Cockpit session, no root and no real
// repository. The point is a set of images that show hangar doing its job rather
// than six variations on an empty state.
//
// The data below is invented, and deliberately so — the alternative is shipping
// screenshots of a real machine's paths and hostnames. It is invented to be
// REPRESENTATIVE though: a partial run and a failed one are in there, because a
// dashboard that only ever shows green tells you nothing about what it looks like
// when something breaks.
//
//   node tests/screenshots.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'screenshots');
const PORT = Number(process.env.PORT || 8877);

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8'
};

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

// --- the scenario --------------------------------------------------------

// Anchored to the real clock: the UI renders "last run 2 hours ago" against
// Date.now(), so a fixed instant would make every screenshot say "5 months ago".
const now = Date.now();
const ago = (h) => new Date(now - h * 3600e3).toISOString();
const agoSec = (h) => (now - h * 3600e3) / 1000;

const REPOS = {
    attic: { id: 'attic', kind: 'local', name: 'Attic (local disk)', path: '/srv/backups/attic',
        sizeLimit: '500 GB', minSnapshots: 3 },
    offsite: { id: 'offsite', kind: 'b2', name: 'Backblaze off-site', bucket: 'acme-backups', prefix: 'db01' }
};

const JOBS = {
    documents: { id: 'documents', name: 'Documents and home', repo: 'attic',
        sources: [{ id: 'f', kind: 'filesystem', paths: ['/home', '/srv/www'], excludes: ['*.tmp'] }],
        retention: { hourly: 24, daily: 30, weekly: 52, monthly: 12 },
        schedule: { calendar: 'hourly' }, enabled: true },
    databases: { id: 'databases', name: 'Database volumes', repo: 'attic',
        sources: [{ id: 'c', kind: 'container', runtime: 'podman', user: 'app',
            volumes: ['pgdata'], containers: ['postgres'], consistency: 'command',
            command: 'pg_dumpall -U postgres > /backup/all.sql' }],
        retention: { daily: 14, monthly: 6 }, schedule: { calendar: 'daily' }, enabled: true },
    offsite: { id: 'offsite', name: 'Off-site copy', repo: 'offsite',
        sources: [{ id: 'f', kind: 'filesystem', paths: ['/home'] }],
        retention: { daily: 7, monthly: 12 }, schedule: { calendar: 'daily' }, enabled: true }
};

// One clean, one partial, one failed. A dashboard that is always green says
// nothing about the day something breaks.
const STATE = {
    documents: { job: 'documents', status: 'ok', kind: 'OK', started: agoSec(1) - 130,
        finished: agoSec(1), exit_code: 0, snapshot: '8a2aacd6', files_new: 12,
        files_changed: 340, data_added: 184_320_112, unreadable: 0 },
    databases: { job: 'databases', status: 'partial', kind: 'READ_ERRORS', started: agoSec(9) - 240,
        finished: agoSec(9), exit_code: 3, snapshot: '4d0045bb', files_new: 3,
        files_changed: 51, data_added: 2_143_000_000, unreadable: 2 },
    offsite: { job: 'offsite', status: 'failed', kind: 'AUTH_EXPIRED', started: agoSec(30) - 12,
        finished: agoSec(30), exit_code: 1 }
};

const SNAPSHOTS = [
    { id: 'aa11', short_id: 'aa11', time: ago(96), hostname: 'db01', paths: ['/home'], tags: ['documents'] },
    { id: 'bb22', short_id: 'bb22', time: ago(48), hostname: 'db01', paths: ['/home'], tags: ['documents'] },
    { id: 'cc33', short_id: 'cc33', time: ago(24), hostname: 'db01', paths: ['/home'], tags: ['documents'] },
    { id: 'dd44', short_id: 'dd44', time: ago(6), hostname: 'db01', paths: ['/home'], tags: ['documents'] },
    { id: 'ee55', short_id: 'ee55', time: ago(2), hostname: 'db01', paths: ['/home'], tags: ['documents'] },
    { id: 'ff66', short_id: 'ff66', time: ago(1), hostname: 'db01', paths: ['/home'], tags: ['documents'] }
];

// The off-site copy runs daily and keeps a fortnight, so its snapshot count is
// its own — the Repositories screen counts the list, it does not read stats.
const OFFSITE_SNAPSHOTS = Array.from({ length: 14 }, (_, i) => ({
    id: 'o' + (i + 10), short_id: 'o' + (i + 10), time: ago(24 * (14 - i)),
    hostname: 'db01', paths: ['/home'], tags: ['offsite']
}));

// The folder picker asks find for "%y\t%f\036" — one record per entry, ended by
// RS, so a newline in a filename cannot split one entry into two.
const RS = String.fromCharCode(30);
const pickerListing = (rows) => rows.map(([t, n]) => t + '\t' + n).join(RS) + RS;
// The Logbook asks for "%y\t%s\t%T@\t%f\n" — it needs the size and mtime columns
// for the file table, so it is a different shape entirely.
const treeListing = (rows) => rows
    .map(([t, size, ageH, n]) => [t, size, Math.round((now - ageH * 3600e3) / 1000), n].join('\t'))
    .join('\n') + '\n';

function stub() {
    const files = {
        // Hosts, paths and buckets below are invented. The update repository is
        // not: ismetozalp/hangar is where hangar itself ships from, so showing
        // anything else in Settings would document a setting nobody has.
        '/etc/hangar/config.json': JSON.stringify({
            theme: 'nord', mountRoot: '/run/hangar/mnt',
            updateRepo: 'ismetozalp/hangar', updateCheckOnStartup: true
        }),
        '/etc/hangar/installed-version': '1.0.0\n',
        '/etc/os-release': 'NAME="Red Hat Enterprise Linux"\nID="rhel"\nVERSION_ID="10.2"\n'
    };
    Object.values(REPOS).forEach((r) => { files['/etc/hangar/repos/' + r.id + '.json'] = JSON.stringify(r); });
    Object.values(JOBS).forEach((j) => { files['/etc/hangar/jobs/' + j.id + '.json'] = JSON.stringify(j); });
    Object.values(STATE).forEach((s) => { files['/var/lib/hangar/state/' + s.job + '.json'] = JSON.stringify(s); });

    return {
        files,
        spawn: {
            'restic version': 'restic 0.19.1 compiled with go1.26.4 on linux/amd64',
            'rclone --version': 'rclone v1.74.3',
            'fusermount3 --version': 'fusermount3 version: 3.16.2',
            'rear --version': 'Relax-and-Recover 2.9',
            'virt-install --version': '4.1.0',
            'unzip -v': 'UnZip 6.00', 'curl --version': 'curl 8.9.1',
            'install -d': '',
            'ls -1 /etc/hangar/repos': Object.keys(REPOS).map((i) => i + '.json').join('\n'),
            'ls -1 /etc/hangar/jobs': Object.keys(JOBS).map((i) => i + '.json').join('\n'),
            // More specific first: the stub takes the first key found in the
            // command line, and several of these are substrings of each other.
            // The mounted snapshot is read from a path containing "/snapshots/",
            // so this has to win before the `restic snapshots` key below.
            'find /run/hangar/mnt': treeListing([
                ['d', 4096, 26, 'documents'],
                ['d', 4096, 51, 'photos'],
                ['d', 4096, 3, 'projects'],
                ['f', 48211, 3, 'budget.ods'],
                ['f', 2044, 27, 'notes.md'],
                ['f', 1_284_336, 5, 'report.pdf']]),
            // The off-site repository, keyed by its password file so `snapshots`
            // and `stats` can answer differently for the same destination.
            'offsite.key --json snapshots': JSON.stringify(OFFSITE_SNAPSHOTS),
            'offsite.key --json stats': JSON.stringify({ total_size: 71_204_998_112, total_file_count: 198_004, snapshots_count: 14 }),
            'snapshots': JSON.stringify(SNAPSHOTS),
            'stats': JSON.stringify({ total_size: 148_902_334_112, total_file_count: 412_339, snapshots_count: 6 }),
            // Change badges between adjacent snapshots come from `restic diff --json`.
            // `restic diff --json` emits JSON LINES, not an array — parseDiff reads
            // it line by line, and an array document yields no changes at all.
            'diff': [
                { message_type: 'change', path: '/report.pdf', modifier: 'M' },
                { message_type: 'change', path: '/budget.ods', modifier: '+' },
                { message_type: 'change', path: '/old-draft.txt', modifier: '-' }
            ].map((c) => JSON.stringify(c)).join('\n') + '\n',
            'find /': pickerListing([['d', 'etc'], ['d', 'home'], ['d', 'srv'], ['d', 'var']]),
            'find /srv': pickerListing([['d', 'backups'], ['d', 'www']]),
            // Answered so the version badge reads "v1.0.0" rather than
            // "Update check failed", and with a tag matching the installed
            // version so no update banner appears.
            'api.github.com': JSON.stringify({ tag_name: 'v1.0.0', assets: [], body: '' }),
            'systemd-run': '', 'systemctl': ''
        },
        dbus: {
            'org.freedesktop.PackageKit:Get': [{ v: 1 }],
            'org.freedesktop.systemd1:LoadUnit': ['/org/freedesktop/systemd1/unit/hangar'],
            // Inactive: the same GetAll answers both the job units and the Logbook's
            // mount unit, and claiming "active" made every job read as running.
            // One answer serves every unit the stub is asked about, so it has to
            // be one that reads correctly for all of them: idle service units (a
            // running one would make all three jobs claim "Running now") and
            // timers with a next run to show.
            'org.freedesktop.systemd1:GetAll': [{
                ActiveState: { v: 'inactive' }, SubState: { v: 'dead' },
                LoadState: { v: 'loaded' }, Id: { v: 'hangar.service' },
                NextElapseUSecRealtime: { v: (now + 43 * 60e3) * 1000 },
                LastTriggerUSec: { v: (now - 3600e3) * 1000 }
            }]
        }
    };
}

// --- capture -------------------------------------------------------------

// Fill a field if it is there. These shots are documentation, not tests: a
// renamed input should change a picture, not break the build.
// Click only if it is really there and visible, and give up quickly. A
// screenshot script must not hang for 30 seconds on a button that moved.
async function clickVisible(page, selector, timeout = 5000) {
    try { await page.click(selector, { timeout }); return true; } catch (e) { return false; }
}

async function fill(page, selector, value) {
    const el = await page.$(selector);
    if (el) await el.fill(value);
}

async function shot(page, name, note) {
    await page.waitForTimeout(650);
    const file = path.join(OUT, name + '.png');
    await page.screenshot({ path: file, fullPage: false });
    const kb = Math.round(fs.statSync(file).size / 1024);
    console.log(`  ${name}.png  ${String(kb).padStart(4)} kB   ${note}`);
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const server = await serve();
    const browser = await chromium.launch();
    // 1440x900 keeps the images readable inline on GitHub without a scrollbar.
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.addInitScript((s) => { window.__hangarStub = s; }, stub());

    try {
        await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle' });
        await page.waitForSelector('.hangar-shell', { timeout: 10000 });
        await page.waitForTimeout(1200);

        await shot(page, 'overview', 'job status at a glance');

        await page.click('.nav-pills .nav-link:text-is("Repositories")');
        await shot(page, 'repositories', 'destinations and their size');

        await page.click('.nav-pills .nav-link:text-is("Jobs")');
        await shot(page, 'jobs', 'what is backed up, and when');

        await page.click('.nav-pills .nav-link:text-is("Logbook")');
        // Mounting is asynchronous; shooting on a timer alone caught the
        // "Mounting the repository…" line still on screen above a finished tree.
        await page.waitForSelector('text=report.pdf', { timeout: 10000 });
        await page.waitForTimeout(600);
        await shot(page, 'logbook', 'scroll back through moments');

        await page.click('.nav-pills .nav-link:text-is("Recovery")');
        // An untouched form shows nothing but its own validation errors. Pick the
        // repository the way a user would, so the screenshot shows a recovery
        // that is actually configured.
        await page.selectOption('#hangar-dr-repo', 'attic');
        await page.fill('#hangar-dr-host', 'db01');
        await shot(page, 'recovery', 'bare-metal rescue image');

        await page.click('.nav-pills .nav-link:text-is("Settings")');
        await shot(page, 'settings', 'themes and diagnostics');

        // Dialogs worth showing, because they carry the decisions that matter.
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('hangar:password',
            { detail: { confirming: true, repoLabel: 'attic', resolve() {} } })));
        await page.waitForTimeout(400);
        await page.evaluate(() => {
            const el = document.getElementById('hangar-password');
            const c = window.Alpine && window.Alpine.$data(el);
            if (c) { c.genMode = 'memorable'; c.generatePassword(); }
        });
        await shot(page, 'password-generator', 'a password you can type at a rescue console');

        // Close it before anything else is clicked: an open modal swallows every
        // pointer event behind it, which is exactly how the first attempt at
        // these shots failed.
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);

        // The dialogs below are where the decisions live. A README that shows
        // only the six main screens tells you what hangar displays; these show
        // what it actually asks you.

        // Adding a destination.
        await page.click('.nav-pills .nav-link:text-is("Repositories")');
        await page.waitForTimeout(400);
        await page.click('button:has-text("Add repository")');
        await page.waitForTimeout(600);
        await fill(page, '#hangar-repo-id', 'offsite');
        await fill(page, '#hangar-repo-name', 'Backblaze off-site');
        await shot(page, 'repository-add', 'sixteen destinations, one form');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);

        // Editing a job: sources, schedule and retention in one place.
        await page.click('.nav-pills .nav-link:text-is("Jobs")');
        await page.waitForTimeout(400);
        if (await clickVisible(page, 'button:has-text("Edit")')) {
            await page.waitForTimeout(700);
            await shot(page, 'job-edit', 'what to back up, when, and for how long');
            await page.keyboard.press('Escape');
            await page.waitForTimeout(400);
        }

        // The drill: the numbers here are the whole lesson of the recovery
        // section — the disk must match the ORIGINAL disk, and must be created
        // somewhere with room for a full restore.
        //
        // Its button is disabled until an image exists and libvirt answers,
        // neither of which is true for a stub, so both are seeded the same way
        // the password dialog is.
        await page.click('.nav-pills .nav-link:text-is("Recovery")');
        await page.waitForTimeout(500);
        await page.evaluate(() => {
            const el = [...document.querySelectorAll('[x-data]')]
                .find((e) => /hangarRecoveryUi/.test(e.getAttribute('x-data') || ''));
            const d = el && window.Alpine && window.Alpine.$data(el);
            if (d) {
                d.iso = '/var/lib/rear/output/rear-db01.iso';
                d.libvirt = { checked: true, available: true };
            }
        });
        await page.waitForTimeout(400);
        if (await clickVisible(page, 'button:has-text("Verify recovery")')) {
            await page.waitForTimeout(700);
            await fill(page, '#hangar-drill-disk', '1000');
            await fill(page, '#hangar-drill-diskdir', '/srv/drill');
            await fill(page, '#hangar-drill-sysgb', '45');
            await fill(page, '#hangar-drill-wait', '120');
            const fw = await page.$('#hangar-drill-fw');
            if (fw) await fw.selectOption('uefi');
            await shot(page, 'drill', 'the throwaway VM that proves recovery works');
            await page.keyboard.press('Escape');
            await page.waitForTimeout(400);
        }

        // The folder picker, which is how every path in hangar gets chosen.
        if (await clickVisible(page, 'button:has-text("Browse")')) {
            await page.waitForTimeout(800);
            await shot(page, 'folder-picker', 'choosing a path without typing it');
            await page.keyboard.press('Escape');
            await page.waitForTimeout(400);
        }

        // Restoring files from a moment in the Logbook.
        await page.click('.nav-pills .nav-link:text-is("Logbook")');
        await page.waitForTimeout(700);
        if (await clickVisible(page, 'button:has-text("Restore")')) {
            await page.waitForTimeout(700);
            await shot(page, 'restore', 'putting files back, with the overwrite rule stated');
            await page.keyboard.press('Escape');
            await page.waitForTimeout(400);
        }
    } finally {
        await ctx.close();
        await browser.close();
        server.close();
    }
    console.log(`\nwrote ${fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).length} images to screenshots/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
