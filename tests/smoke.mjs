#!/usr/bin/env node
// tests/smoke.mjs — structural checks on the shipped plugin.
//
// These are the invariants that parallel work breaks most easily: a module added to
// js/ but never referenced from index.html, an ES-module keyword sneaking in (which
// would silently fail under Cockpit's plain-script loading), a module that forgets
// its dual export and so becomes untestable, or a manifest that stops parsing.
//
// Runs with no browser and no Cockpit — deliberately cheap enough to run constantly.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const notes = [];

function fail(msg) { failures.push(msg); }
function ok(msg) { notes.push(msg); }

function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function exists(p) { return fs.existsSync(path.join(ROOT, p)); }

// --- manifest.json ------------------------------------------------------

let manifest = null;
try {
    manifest = JSON.parse(read('manifest.json'));
    ok('manifest.json parses');
} catch (e) {
    fail(`manifest.json does not parse: ${e.message}`);
}

if (manifest) {
    if (manifest.name !== 'hangar') fail('manifest name is not "hangar"');
    if (!manifest.tools?.index?.path) fail('manifest has no tools.index.path');
    else if (!exists(manifest.tools.index.path))
        fail(`manifest points at a missing file: ${manifest.tools.index.path}`);
    if (!manifest['content-security-policy']) fail('manifest has no content-security-policy');
    // Cockpit 300+ is the floor because the plugin assumes the Python bridge.
    if (!manifest.requires?.cockpit) fail('manifest does not declare a cockpit requirement');
    ok('manifest structure is valid');
}

// --- index.html references ----------------------------------------------

const indexHtml = read('index.html');
const srcs = [...indexHtml.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
const localSrcs = srcs.filter((s) => !s.startsWith('../'));

for (const s of localSrcs) {
    if (!exists(s)) fail(`index.html references a missing script: ${s}`);
}
ok(`index.html references ${localSrcs.length} local scripts`);

const hrefs = [...indexHtml.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]);
for (const h of hrefs) {
    if (!exists(h)) fail(`index.html references a missing stylesheet: ${h}`);
}

if (!indexHtml.includes('../base1/cockpit.js'))
    fail('index.html does not load cockpit.js');

// boot.js must come last: it injects partials and only then loads Alpine, so any
// script after it would race the DOM it depends on.
const bootIdx = localSrcs.indexOf('js/boot.js');
if (bootIdx === -1) fail('index.html does not load js/boot.js');
else if (bootIdx !== localSrcs.length - 1)
    fail('js/boot.js must be the last script — it loads Alpine after injecting partials');

// errors.js must load before anything that uses HangarErrors.
const coreSrcs = localSrcs.filter((s) => s.startsWith('js/core/'));
if (coreSrcs.length && coreSrcs[0] !== 'js/core/errors.js')
    fail('js/core/errors.js must be the first core script — every module depends on it');

// --- every js module is referenced, dual-exported, and ES-module-free ----

function walk(dir) {
    const out = [];
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return out;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(rel));
        else if (entry.name.endsWith('.js')) out.push(rel);
    }
    return out;
}

function walkHtml(dir) {
    const out = [];
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return out;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walkHtml(rel));
        else if (entry.name.endsWith('.html')) out.push(rel);
    }
    return out;
}

const VENDOR = new Set(['js/alpine.min.js', 'js/bootstrap.bundle.min.js']);
const modules = walk('js').filter((m) => !VENDOR.has(m));

for (const m of modules) {
    const text = read(m);

    if (!localSrcs.includes(m))
        fail(`${m} exists but is not loaded by index.html`);

    // Cockpit loads these as plain scripts. An import/export keyword is a silent
    // failure at runtime, so catch it here.
    if (/^\s*(import|export)\s/m.test(text))
        fail(`${m} uses ES module syntax — plugin scripts must be plain scripts`);

    // boot.js and app.js are entry points, not library modules.
    if (m !== 'js/boot.js') {
        if (!text.includes('module.exports'))
            fail(`${m} has no dual module.exports — it cannot be unit tested under node`);
        if (!/^\s*'use strict';/m.test(text))
            fail(`${m} is missing 'use strict'`);
    }
}
ok(`${modules.length} first-party modules checked`);

// --- unit test coverage of core modules ---------------------------------

const libModules = modules.filter(
    (m) => m.startsWith('js/core/') || m.startsWith('js/engine/'));

for (const m of libModules) {
    const base = path.basename(m, '.js');
    if (!exists(`tests/unit/${base}.test.js`))
        fail(`${m} has no unit test at tests/unit/${base}.test.js`);
}
ok(`${libModules.length} library modules have unit tests`);

// --- the helper ---------------------------------------------------------

if (!exists('libexec/hangar-run')) {
    fail('libexec/hangar-run is missing');
} else {
    const helper = read('libexec/hangar-run');
    if (!helper.startsWith('#!/usr/bin/python3')) fail('hangar-run has no python3 shebang');
    if (!helper.includes('--print-plan'))
        fail('hangar-run lost --print-plan, which the integration tests depend on');
    // The one thing that must never regress: forget with no keep flags deletes
    // everything.
    if (!helper.includes('refusing to prune'))
        fail('hangar-run lost its empty-retention guard');
    // The size guard's measurement. `restic stats` DEFAULTS to --mode restore-size,
    // which counts restored file sizes: a real 2.0 MB repository reported 5.9 MB
    // that way. A guard reading that number deletes snapshots that were never the
    // problem, so the mode is not an option here.
    if (helper.includes('"stats"') && !helper.includes('raw-data'))
        fail('hangar-run measures the repository without --mode raw-data');
    ok('hangar-run structural checks pass');
}

// --- x-show must never share an element with a Bootstrap display utility -

// Alpine's x-show toggles an inline `display: none`. Bootstrap's display utilities
// (.d-flex, .d-block, …) are declared `!important`, so they beat the inline style and
// the element stays permanently visible. This silently produced an empty red error
// box on the Overview screen, which is exactly the kind of defect that reads as
// "the UI is broken" rather than as a bug in one binding.
const DISPLAY_UTIL = /\bd-(flex|block|inline|inline-flex|inline-block|grid|table)\b/;

for (const f of [...modules, 'index.html', ...walkHtml('html')]) {
    const text = read(f);
    text.split('\n').forEach((line, i) => {
        const trimmed = line.trim();
        // Skip prose: the comments explaining this very rule name both x-show and
        // d-flex, and would otherwise flag themselves.
        if (trimmed.startsWith('//') || trimmed.startsWith('<!--') || trimmed.startsWith('*')) return;
        if (!line.includes('x-show')) return;
        // Only flag when both appear on the same tag — a class attribute on a
        // following line belongs to a different element.
        const m = DISPLAY_UTIL.exec(line);
        if (m) {
            fail(`${f}:${i + 1} puts x-show on an element with "${m[0]}" — ` +
                'Bootstrap display utilities are !important and defeat x-show. ' +
                'Move the toggle to a plain wrapper.');
        }
    });
}
ok('no x-show is defeated by a Bootstrap display utility');

// --- the README's provider claims must match the code -------------------
//
// A provider list in prose is exactly the thing that drifts: someone adds a
// backend and the documentation quietly keeps promising the old set. Worse, the
// README tells users which providers Hangar can set up FOR them and which need a
// manual step — getting that wrong sends someone to a dead end.

if (exists('README.md') && exists('js/core/rclone.js')) {
    const readme = read('README.md');
    const { createRequire } = await import('node:module');
    const require_ = createRequire(import.meta.url);
    const Rclone = require_(path.join(ROOT, 'js/core/rclone.js'));

    // The README uses the name people say ("OneDrive", "Swift") rather than the
    // table's fuller label ("Microsoft OneDrive", "OpenStack Swift"), so accept a
    // match on ANY significant word of the label, or on the id.
    const SKIP_WORDS = new Set(['microsoft', 'openstack', 'compatible', 'storage',
        'windows', 'share', 'ssh', 'google', 'and']);
    const mentions = (label, id) => {
        const words = label.split(/[\s(),/…]+/).filter(Boolean)
            .map((w) => w.replace(/[^A-Za-z0-9-]/g, ''))
            .filter((w) => w.length >= 2 && !SKIP_WORDS.has(w.toLowerCase()));
        return [id, ...words].some((w) =>
            new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(readme));
    };

    for (const p of Rclone.providers()) {
        if (!mentions(p.label, p.id))
            fail(`README does not mention the "${p.id}" destination (${p.label})`);
    }

    // A provider Hangar cannot configure must be documented as such, or the user
    // follows instructions that cannot work.
    for (const p of Rclone.providers().filter((x) => x.auth === Rclone.AUTH.EXTERNAL)) {
        const name = p.label.split(/[\s(/]/)[0];
        const inManualRow = new RegExp(`\\|\\s*\\*\\*Manual\\*\\*\\s*\\|[^|]*${name}`, 'i');
        if (!inManualRow.test(readme))
            fail(`${p.label} cannot be configured by hangar but the README does not say so`);
    }

    // And the reverse: nothing Hangar CAN automate should be listed as manual.
    const manualRow = (readme.match(/\|\s*\*\*Manual\*\*\s*\|([^|]*)\|/i) || [])[1] || '';
    for (const p of Rclone.providers().filter((x) => x.auth !== Rclone.AUTH.EXTERNAL)) {
        const name = p.label.split(/[\s(/]/)[0];
        if (new RegExp(`\\b${name}\\b`, 'i').test(manualRow))
            fail(`README lists ${p.label} as manual, but hangar can configure it`);
    }
    ok(`README documents all ${Rclone.providers().length} cloud destinations correctly`);
}

// --- the feature is called Logbook, never Time Machine ------------------

for (const f of [...modules, 'index.html', 'css/hangar.css']) {
    const text = read(f);
    if (/time\s*machine/i.test(text))
        fail(`${f} refers to "Time Machine" — the feature is named Logbook`);
}
ok('no "Time Machine" references');

// --- report -------------------------------------------------------------

for (const n of notes) console.log(`  ok  ${n}`);
if (failures.length) {
    console.error(`\n${failures.length} smoke failure(s):`);
    for (const f of failures) console.error(`  FAIL  ${f}`);
    process.exit(1);
}
console.log(`\nsmoke: all structural checks passed`);
