// core/themes.js — the theme registry and resolution. PURE: no DOM, no cockpit.
//
// Themes are applied by setting `data-bs-theme` on <html>, which Bootstrap 5.3
// already understands. Each custom palette is a block in css/themes.css that
// overrides the Bootstrap variables; hangar's own accents derive from those, so a
// theme never has to know this plugin exists.
//
// 'system' is not a palette — it resolves to light or dark from the OS preference
// at the moment it is asked, which is why resolution takes prefersDark rather than
// reading matchMedia itself. That keeps this file testable under node.
'use strict';
(function (root) {

    const THEMES = [
        { id: 'system',     label: 'System',      base: null },
        { id: 'light',      label: 'Light',       base: 'light' },
        { id: 'dark',       label: 'Dark',        base: 'dark' },
        { id: 'aqua',       label: 'Aqua',        base: 'dark' },
        { id: 'nord',       label: 'Nord',        base: 'dark' },
        { id: 'solarized',  label: 'Solarized',   base: 'dark' },
        { id: 'dracula',    label: 'Dracula',     base: 'dark' },
        { id: 'gruvbox',    label: 'Gruvbox',     base: 'dark' },
        { id: 'catppuccin', label: 'Catppuccin',  base: 'dark' },
        { id: 'tokyonight', label: 'Tokyo Night', base: 'dark' },
        { id: 'rosepine',   label: 'Rosé Pine',   base: 'dark' },
        { id: 'sunset',     label: 'Sunset',      base: 'dark' },
        { id: 'sepia',      label: 'Sepia',       base: 'light' }
    ];

    const DEFAULT_THEME = 'system';

    // Own-property lookup only: a theme id of "constructor" or "__proto__" arrives
    // straight from a hand-edited config.json, and a bare index would return
    // something from Object.prototype rather than falling back to the default.
    const BY_ID = THEMES.reduce(function (m, t) { m[t.id] = t; return m; }, Object.create(null));

    function isValid(id) {
        return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BY_ID, id);
    }

    function get(id) {
        return isValid(id) ? BY_ID[id] : null;
    }

    function ids() {
        return THEMES.map(function (t) { return t.id; });
    }

    function labelFor(id) {
        const t = get(id);
        return t ? t.label : '';
    }

    function resolveSystem(prefersDark) {
        return prefersDark
            ? { id: 'system', attr: 'dark', base: 'dark' }
            : { id: 'system', attr: 'light', base: 'light' };
    }

    // -> { id, attr, base }. `attr` is what goes on data-bs-theme; `base` says
    // whether the palette is fundamentally light or dark, which is what any
    // future contrast decision should key off rather than the id.
    //
    // An unknown id resolves to system rather than throwing: a stale or
    // hand-edited theme name should leave the plugin usable, not blank.
    function resolve(id, prefersDark) {
        if (id === 'system' || !isValid(id)) return resolveSystem(!!prefersDark);
        const t = BY_ID[id];
        return { id: t.id, attr: t.id, base: t.base };
    }

    function swatchClass(id) {
        return isValid(id) ? 'hangar-swatch hangar-swatch-' + id : 'hangar-swatch';
    }

    // Every theme other than 'system' is a concrete palette, so this is the set a
    // picker renders as swatches.
    function selectable() {
        return THEMES.slice();
    }

    const HangarThemes = {
        THEMES, DEFAULT_THEME,
        isValid, get, ids, labelFor, resolve, resolveSystem, swatchClass, selectable
    };
    root.HangarThemes = HangarThemes;
    if (typeof module !== 'undefined' && module.exports) module.exports = HangarThemes;
})(typeof window !== 'undefined' ? window : globalThis);
