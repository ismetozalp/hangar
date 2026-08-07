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

// --- no invisible control bytes in shipped source -----------------------

// The folder picker split its `find` output on a RAW NUL byte typed into the
// source file. It is invisible in every editor, no diff shows it, and anything
// in the chain from checkout to browser that drops it turns split(NUL) into
// split('') — which parsed a full listing of / into zero entries and reported it
// to the user as "This folder is empty.". Separators are escapes now, and this
// makes sure the next one cannot be a literal.
//
// \t and \n are excluded: tabs and newlines are ordinary source text.
const CONTROL_BYTE = /[\u0000-\u0008\u000b-\u001f\u007f]/;

for (const f of [...modules, 'index.html', ...walkHtml('html')]) {
    const text = read(f);
    const m = CONTROL_BYTE.exec(text);
    if (!m) continue;
    const line = text.slice(0, m.index).split('\n').length;
    const code = m[0].charCodeAt(0).toString(16).padStart(4, '0');
    fail(`${f}:${line} contains a literal control byte (U+${code.toUpperCase()}). ` +
        'It is invisible in an editor and survives copy-paste unpredictably — ' +
        `write it as an escape ("\\u${code}") instead.`);
}
ok('no literal control bytes in shipped source');

// --- x-init="init()" must not double-call an auto-called init ------------

// Alpine 3 calls init() by itself whenever the x-data object defines one. Writing
// x-init="init()" as well runs it TWICE, and every component here registers window
// listeners in init: two listeners for every event.
//
// That is not a tidiness matter — it silently broke saving. The job dialog received
// its own open event twice; the second delivery hit the "a second open cancels the
// first" guard and resolved the caller's promise with null. Pressing Save then
// closed the dialog, wrote nothing, showed no error, and left the Jobs screen
// empty. Found only by driving a real session and tracing the promise.
{
    const initPattern = /x-init="init\(\)"/;
    for (const f of [...modules, 'index.html', ...walkHtml('html')]) {
        const text = read(f);
        text.split('\n').forEach((line, i) => {
            const trimmed = line.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('<!--') || trimmed.startsWith('*')) return;
            if (!initPattern.test(line)) return;
            fail(`${f}:${i + 1} writes x-init="init()" — Alpine already calls init() ` +
                'for an x-data object that defines one, so this runs it twice and ' +
                'registers every listener twice. Remove the attribute.');
        });
    }
    ok('no component has its init() called twice');
}

// --- no shell string is ever built by concatenation ----------------------

// hangar passes argv arrays everywhere precisely so a path never meets a shell.
// Three chcon calls broke that rule: they built `sh -c '… chcon -t … ' + dir'`
// where `dir` came from a free-text field, and they ran as root. A drill disk
// location of  /tmp/x'; rm -rf /; :'  would have been executed.
//
// A shell as an ARGV ELEMENT is fine and is used deliberately — running a
// user-supplied command inside a container is that feature's whole point. What
// is banned is gluing a value into the script string.
{
    let checked = 0;
    for (const f of modules) {
        const text = read(f);
        const lines = text.split('\n');
        lines.forEach((line, i) => {
            if (!/'sh',\s*'-c'/.test(line)) return;
            checked += 1;
            // The script is this line and the two after it — enough for the
            // wrapped form these calls take.
            const window = lines.slice(i, i + 3).join(' ');
            // A quoted fragment followed by + and an identifier is concatenation.
            if (/'[^']*'\s*\+\s*[A-Za-z_$]/.test(window)) {
                fail(`${f}:${i + 1} builds a shell command string by concatenation. ` +
                    'Pass the value as an argv element instead — spawn(["chcon","-t","T","--",dir]) ' +
                    'or sh -c \'… "$1"\' with the value as a positional argument.');
            }
        });
    }
    ok(`${checked} shell invocations pass their values as arguments`);
}

// --- a boolean attribute binding must yield a real boolean ---------------

// Alpine removes a boolean attribute ONLY for null, undefined or false:
//
//   [null, undefined, false].includes(value) ? removeAttribute() : setAttribute()
//
// So `:disabled="problems().length"` disables the control forever the moment the
// list is empty, because [].length is 0 and 0 is not false. That is exactly how
// the folder picker's Create button became unclickable the instant the name
// typed into it became valid — the failure looked like a permissions problem and
// was a truthiness one.
{
    const BOOL_ATTRS = ['disabled', 'checked', 'required', 'readonly', 'open',
        'selected', 'multiple', 'autofocus', 'novalidate'];
    const pattern = new RegExp(`:(${BOOL_ATTRS.join('|')})="([^"]*)"`, 'g');
    let checked = 0;

    for (const f of [...modules, 'index.html', ...walkHtml('html')]) {
        const text = read(f);
        text.split('\n').forEach((line, i) => {
            const trimmed = line.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('<!--') || trimmed.startsWith('*')) return;
            let m;
            pattern.lastIndex = 0;
            while ((m = pattern.exec(line))) {
                checked += 1;
                const expr = m[2].trim();
                // The last operand is what the expression evaluates to when every
                // earlier one is falsy — and that is the value Alpine binds.
                const last = expr.split('||').pop().trim();
                const numeric = /\.length$/.test(last) || /^\d+$/.test(last);
                if (numeric) {
                    fail(`${f}:${i + 1} binds :${m[1]} to "${expr}" — its last operand ` +
                        'can be 0, and Alpine sets a boolean attribute for anything that ' +
                        'is not null/undefined/false. Compare it: "... .length > 0".');
                }
            }
        });
    }
    ok(`${checked} boolean-attribute bindings yield real booleans`);
}

// --- one unit convention for every size on screen ------------------------

// Four modules format bytes, deliberately duplicated because core/ must not
// depend on features/. They drifted: the Logbook divided by 1000 and said "GB"
// while the Overview and Jobs divided by 1024 and said "GiB". The same
// repository then read as "34.9 GiB added", "14.8 GiB on disk" and "40.1 GB in
// the snapshot" — three different questions, fair enough, but the third answered
// in a different UNIT, which made three correct numbers look like a
// contradiction. Binary everywhere, because that is what restic itself prints.
{
    const tables = [
        ['js/features/overview.js', /const UNITS = (\[[^\]]+\])/],
        ['js/features/jobs-ui.js', /const UNITS = (\[[^\]]+\])/],
        ['js/features/logbook-ui.js', /const UNITS = (\[[^\]]+\])/],
        ['js/core/sizeguard.js', /const DISPLAY_UNITS = (\[[^\]]+\])/]
    ];
    const seen = [];
    for (const [file, re] of tables) {
        const m = re.exec(read(file));
        if (!m) { fail(`${file} no longer declares a byte-unit table`); continue; }
        seen.push({ file, units: m[1].replace(/\s+/g, ' ') });
    }
    const distinct = [...new Set(seen.map((x) => x.units))];
    if (distinct.length > 1) {
        fail('byte units disagree between modules: ' +
            seen.map((x) => `${x.file} ${x.units}`).join(' | '));
    } else if (seen.length && !/KiB/.test(distinct[0])) {
        fail(`byte units are decimal (${distinct[0]}); hangar shows binary, as restic does`);
    } else if (seen.length) {
        // The python runner formats sizes for the journal and for the guard's own
        // sentences; an integration test compares it value-for-value with the
        // JavaScript one, and this catches the table drifting before that runs.
        const runnerUnits = /GUARD_DISPLAY_UNITS = \(([^)]+)\)/.exec(read('libexec/hangar-run'));
        const runner = runnerUnits
            ? runnerUnits[1].replace(/"/g, "'").replace(/\s+/g, ' ').trim() : null;
        const js = distinct[0].replace(/^\[|\]$/g, '').trim();
        if (!runner) fail('libexec/hangar-run no longer declares GUARD_DISPLAY_UNITS');
        else if (runner !== js)
            fail(`libexec/hangar-run formats sizes as ${runner}, the UI as ${js}`);
        else ok(`all ${seen.length + 1} byte formatters use ${distinct[0]}`);
    }
}

// --- restic's cache directory is stated, and stated identically ----------

// restic locates its cache from $XDG_CACHE_HOME or $HOME. A systemd unit has
// neither, so restic exits 1 before reading the repository:
//
//   unable to locate cache directory: neither $XDG_CACHE_HOME nor $HOME are defined
//
// Every path that runs restic from a unit therefore passes --cache-dir. Three
// implementations build restic argv — the engine, the Logbook's mount unit, and
// the privileged python runner — and a disagreement between them would mean two
// caches, or one path that silently reverts to the old failure.
{
    const engine = read('js/engine/restic.js');
    const logbook = read('js/core/logbook.js');
    const runner = read('libexec/hangar-run');

    const engineDir = /CACHE_DIR\s*=\s*'([^']+)'/.exec(engine);
    const logbookDir = /RESTIC_CACHE_DIR\s*=\s*'([^']+)'/.exec(logbook);
    // dr.js builds the argv ReaR runs; it needs the same path for the backup leg.
    const drDir = /RESTIC_CACHE_DIR\s*=\s*'([^']+)'/.exec(read('js/core/dr.js'));
    if (!drDir) fail('js/core/dr.js no longer defines RESTIC_CACHE_DIR');
    else if (engineDir && drDir[1] !== engineDir[1])
        fail(`js/core/dr.js caches in ${drDir[1]}, the engine in ${engineDir[1]}`);
    const runnerDir = /RESTIC_CACHE_DIR\s*=\s*os\.environ\.get\("HANGAR_CACHE_DIR",\s*"([^"]+)"\)/.exec(runner);

    if (!engineDir) fail('js/engine/restic.js no longer defines CACHE_DIR');
    else if (!logbookDir) fail('js/core/logbook.js no longer defines RESTIC_CACHE_DIR');
    else if (!runnerDir) fail('libexec/hangar-run no longer defines RESTIC_CACHE_DIR');
    else if (engineDir[1] !== logbookDir[1] || engineDir[1] !== runnerDir[1]) {
        fail(`restic cache directory disagrees between implementations: ` +
            `engine ${engineDir[1]}, logbook ${logbookDir[1]}, runner ${runnerDir[1]}`);
    } else {
        ok(`restic cache directory is ${engineDir[1]} in all three implementations`);
    }

    // make install must create it, or the first run does so with whatever mode
    // and ownership that process happens to have.
    const mk = read('Makefile');
    const mkDir = /CACHE_DIR \?= (.+)/.exec(mk);
    if (!mkDir) fail('Makefile no longer defines CACHE_DIR');
    else if (mkDir[1].replace('$(NAME)', 'hangar').trim() !== engineDir[1])
        fail(`Makefile installs ${mkDir[1]} but restic is told ${engineDir[1]}`);
    else if (!/install -d -m 0700 \$\(CACHE_DIR\)/.test(mk))
        fail('make install does not create the restic cache directory');

    if (!/--cache-dir/.test(runner))
        fail('libexec/hangar-run builds restic argv without --cache-dir — a scheduled ' +
            'backup would exit 1 with "unable to locate cache directory"');
}

// --- a shared namespace may only be extended, never replaced ------------

// HangarDialogs is written by two modules: fspicker-ui.js adds pickPath, app.js
// adds confirmDialog and passwordDialog. app.js is the LAST script index.html
// loads, so when it assigned a fresh object literal it deleted pickPath — and
// every Browse button in the plugin silently did nothing. Load order is not
// something a reader of either file can see, so the rule is enforced here:
// whoever writes a global that another module also writes must merge into it.
const SHARED_GLOBALS = ['HangarDialogs'];

for (const name of SHARED_GLOBALS) {
    const writers = [];
    for (const f of modules) {
        const text = read(f);
        text.split('\n').forEach((line, i) => {
            const trimmed = line.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
            const m = new RegExp('root\\.' + name + '\\s*=\\s*(.*)').exec(line);
            if (!m) return;
            writers.push({ file: f, line: i + 1, rhs: m[1] });
        });
    }
    if (writers.length < 2) {
        fail(`${name} is documented as shared but only ${writers.length} module writes it — ` +
            'either the list above is stale or a writer was lost.');
        continue;
    }
    for (const w of writers) {
        // Object.assign({}, root.X || {}, {...}) keeps whatever landed first.
        if (!/Object\.assign\(/.test(w.rhs)) {
            fail(`${w.file}:${w.line} replaces root.${name} instead of merging into it. ` +
                `${name} is written by ${writers.length} modules, and whichever loads last wins — ` +
                'use Object.assign({}, root.' + name + ' || {}, { ... }).');
        }
    }
    ok(`${name} is merged by all ${writers.length} of its writers`);
}

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
