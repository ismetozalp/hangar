// Unit tests for js/core/themes.js.
//
// The registry is only half the contract — the other half is that every theme it
// offers actually has a palette and a swatch in css/themes.css. A theme in the
// picker with no CSS behind it renders as an unstyled page, so that link is
// asserted here rather than left to be noticed by eye.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../../js/core/themes.js');

const CSS = fs.readFileSync(
    path.join(__dirname, '..', '..', 'css', 'themes.css'), 'utf8');

// Bootstrap provides these three itself; they need no block in themes.css.
const BUILTIN = new Set(['system', 'light', 'dark']);

test('module loads with no DOM', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.ok(Array.isArray(T.THEMES));
});

test('the registry is well formed', () => {
    assert.ok(T.THEMES.length >= 10, 'suspiciously few themes');
    const seen = new Set();
    for (const t of T.THEMES) {
        assert.ok(t.id && typeof t.id === 'string', 'theme with no id');
        assert.ok(t.label && typeof t.label === 'string', `${t.id} has no label`);
        assert.ok(!seen.has(t.id), `duplicate theme id: ${t.id}`);
        seen.add(t.id);
        // Ids become CSS selectors and an HTML attribute value.
        assert.match(t.id, /^[a-z][a-z0-9]*$/, `unsafe theme id: ${t.id}`);
        if (t.id === 'system') assert.equal(t.base, null);
        else assert.ok(t.base === 'light' || t.base === 'dark', `${t.id} has no base`);
    }
});

test('system is first and is the default', () => {
    // It is the only choice that respects a preference the user already expressed
    // to their desktop, so it is what a fresh install gets.
    assert.equal(T.THEMES[0].id, 'system');
    assert.equal(T.DEFAULT_THEME, 'system');
    assert.equal(T.isValid(T.DEFAULT_THEME), true);
});

test('every non-builtin theme has a palette in themes.css', () => {
    const missing = T.THEMES
        .filter((t) => !BUILTIN.has(t.id))
        .filter((t) => !CSS.includes(`[data-bs-theme="${t.id}"]`))
        .map((t) => t.id);
    assert.deepEqual(missing, [],
        `themes offered with no palette: ${missing.join(', ')}`);
});

test('every theme has a swatch, so the picker is never blank', () => {
    const missing = T.THEMES
        .filter((t) => !CSS.includes(`.hangar-swatch-${t.id}`))
        .map((t) => t.id);
    assert.deepEqual(missing, [], `themes with no swatch: ${missing.join(', ')}`);
});

test('themes.css declares no palette the registry does not offer', () => {
    // The reverse direction: dead CSS for a theme nobody can select.
    const declared = [...CSS.matchAll(/\[data-bs-theme="([a-z0-9]+)"\]/g)]
        .map((m) => m[1]);
    const known = new Set(T.ids());
    const orphans = [...new Set(declared)].filter((id) => !known.has(id) && !BUILTIN.has(id));
    assert.deepEqual(orphans, [], `palettes with no registry entry: ${orphans.join(', ')}`);
});

test('themes.css carries no leftover manifest variables', () => {
    // The file was ported from the manifest plugin; a stray --mf-* would silently
    // resolve to nothing.
    assert.ok(!CSS.includes('--mf-'), 'themes.css still references --mf-* variables');
    assert.ok(!/\.mf-/.test(CSS), 'themes.css still references .mf-* classes');
});

test('hangar accents derive from Bootstrap so themes apply automatically', () => {
    // If these were hardcoded, every new palette would need a second edit and the
    // status dots would stay the light-theme colours on a dark background.
    const hangarCss = fs.readFileSync(
        path.join(__dirname, '..', '..', 'css', 'hangar.css'), 'utf8');
    for (const [name, source] of [
        ['--hangar-ok', '--bs-success'],
        ['--hangar-warn', '--bs-warning'],
        ['--hangar-err', '--bs-danger']
    ]) {
        const line = hangarCss.split('\n').find((l) => l.trim().startsWith(name + ':'));
        assert.ok(line, `${name} is not declared`);
        assert.ok(line.includes(source), `${name} should derive from ${source}: ${line.trim()}`);
    }
});

// --- resolution ----------------------------------------------------------

test('isValid accepts known ids and rejects everything else', () => {
    assert.equal(T.isValid('nord'), true);
    assert.equal(T.isValid('system'), true);
    for (const v of ['', 'NORD', 'nope', null, undefined, 42, {}, [], true]) {
        assert.equal(T.isValid(v), false, JSON.stringify(v));
    }
});

test('isValid is not fooled by inherited properties', () => {
    // A theme id arrives from a hand-edited config.json, so a bare index lookup
    // would return something off Object.prototype.
    for (const v of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
        assert.equal(T.isValid(v), false, v);
        assert.equal(T.get(v), null, v);
    }
});

test('system resolves from the OS preference', () => {
    assert.deepEqual(T.resolve('system', true), { id: 'system', attr: 'dark', base: 'dark' });
    assert.deepEqual(T.resolve('system', false), { id: 'system', attr: 'light', base: 'light' });
});

test('a concrete theme ignores the OS preference', () => {
    for (const prefersDark of [true, false]) {
        assert.deepEqual(T.resolve('nord', prefersDark),
            { id: 'nord', attr: 'nord', base: 'dark' });
        assert.deepEqual(T.resolve('sepia', prefersDark),
            { id: 'sepia', attr: 'sepia', base: 'light' });
    }
});

test('an unknown theme falls back to system rather than throwing', () => {
    // A stale or hand-edited name must leave the plugin usable, not blank.
    for (const v of ['nope', '', null, undefined, 42, {}, '__proto__']) {
        const r = T.resolve(v, false);
        assert.equal(r.attr, 'light', JSON.stringify(v));
        assert.equal(r.id, 'system');
    }
    assert.equal(T.resolve('nope', true).attr, 'dark');
});

test('resolve coerces a truthy/falsy prefersDark', () => {
    assert.equal(T.resolve('system', 1).attr, 'dark');
    assert.equal(T.resolve('system', 0).attr, 'light');
    assert.equal(T.resolve('system', undefined).attr, 'light');
    assert.equal(T.resolve('system', 'yes').attr, 'dark');
});

test('every registered theme resolves to a usable attribute', () => {
    for (const t of T.THEMES) {
        for (const prefersDark of [true, false]) {
            const r = T.resolve(t.id, prefersDark);
            assert.ok(r.attr, `${t.id} resolved to no attribute`);
            assert.ok(r.base === 'light' || r.base === 'dark', `${t.id} has no base`);
        }
    }
});

test('labelFor and ids agree with the registry', () => {
    assert.equal(T.labelFor('nord'), 'Nord');
    assert.equal(T.labelFor('tokyonight'), 'Tokyo Night');
    assert.equal(T.labelFor('nope'), '');
    assert.deepEqual(T.ids(), T.THEMES.map((t) => t.id));
});

test('swatchClass always returns a usable class', () => {
    assert.equal(T.swatchClass('nord'), 'hangar-swatch hangar-swatch-nord');
    // Unknown ids still get the base class, so the picker never renders a bare span.
    assert.equal(T.swatchClass('nope'), 'hangar-swatch');
    assert.equal(T.swatchClass(null), 'hangar-swatch');
});

test('selectable returns a copy, not the live registry', () => {
    const a = T.selectable();
    a.push({ id: 'injected' });
    assert.equal(T.THEMES.length, T.selectable().length,
        'mutating the returned list changed the registry');
});

test('no theme is named after the rejected feature name', () => {
    for (const t of T.THEMES) assert.ok(!/time\s*machine/i.test(t.label));
});
