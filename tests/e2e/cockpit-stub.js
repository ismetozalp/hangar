// tests/e2e/cockpit-stub.js — a fake Cockpit bridge for browser tests.
//
// Served in place of ../base1/cockpit.js so index.html can be driven in a real
// browser with no Cockpit session, no login and no root. The stub answers the
// handful of calls hangar makes, with scripted responses per test.
//
// This is honest about what it covers: it proves the UI layer wires up, renders and
// handles responses/errors. It does NOT prove hangar talks to restic correctly —
// tests/integration does that against the real binary.
(function () {
    'use strict';

    // Tests push scripted responses in via window.__hangarStub before load.
    const cfg = window.__hangarStub || (window.__hangarStub = {});
    cfg.calls = cfg.calls || [];
    cfg.spawn = cfg.spawn || {};      // argv-substring -> string | {error}
    cfg.files = cfg.files || {};      // path -> string
    cfg.errors = cfg.errors || [];

    function matchSpawn(argv) {
        const line = argv.join(' ');
        const key = Object.keys(cfg.spawn).find((k) => line.indexOf(k) >= 0);
        return key === undefined ? undefined : cfg.spawn[key];
    }

    function spawn(argv, opts) {
        cfg.calls.push({ kind: 'spawn', argv: argv.slice(), opts: opts || {} });
        const scripted = matchSpawn(argv);
        if (scripted === undefined) {
            // Unscripted calls reject rather than resolve empty: a UI that silently
            // renders "nothing configured" because a call was never stubbed would
            // make a broken screen look healthy.
            const e = new Error('no stub for: ' + argv.join(' '));
            e.exit_status = 1;
            return Promise.reject(e);
        }
        if (scripted && scripted.error) {
            const e = new Error(scripted.message || 'stub error');
            e.exit_status = scripted.exit_status === undefined ? 1 : scripted.exit_status;
            e.problem = scripted.problem;
            return Promise.reject(e);
        }
        const p = Promise.resolve(String(scripted));
        p.stream = function () { return p; };      // hangar calls .stream() when present
        return p;
    }

    function file(path) {
        return {
            read: function () {
                cfg.calls.push({ kind: 'read', path: path });
                const v = cfg.files[path];
                return Promise.resolve(v === undefined ? null : v);
            },
            replace: function (content) {
                cfg.calls.push({ kind: 'replace', path: path, content: content });
                cfg.files[path] = content;
                return Promise.resolve();
            },
            close: function () {}
        };
    }

    // cfg.dbus maps "<service>:<method>" to a reply array, or {error: "..."} to
    // reject. Used to simulate PackageKit being absent (a ServiceUnknown name error)
    // versus installed and answering.
    function dbus(service) {
        return {
            call: function (p, i, m, a) {
                cfg.calls.push({ kind: 'dbus', service: service, path: p, iface: i, method: m, args: a });
                const scripted = cfg.dbus && (cfg.dbus[service + ':' + m] || cfg.dbus[m]);
                if (scripted === undefined)
                    return Promise.reject(new Error('no dbus stub for ' + service + ':' + m));
                if (scripted && scripted.error) {
                    const e = new Error(scripted.error);
                    e.problem = scripted.problem;
                    return Promise.reject(e);
                }
                return Promise.resolve(scripted);
            },
            wait: function () { return Promise.resolve(); },
            close: function () {},
            addEventListener: function () {}
        };
    }

    window.cockpit = {
        spawn: spawn,
        file: file,
        dbus: dbus,
        gettext: function (s) { return s; },
        format: function (s) { return s; },
        location: { href: '', go: function () {} },
        transport: { host: 'localhost' },
        jump: function () {},
        addEventListener: function () {}
    };

    window.addEventListener('error', function (ev) {
        cfg.errors.push(String(ev.message));
    });
    window.addEventListener('unhandledrejection', function (ev) {
        cfg.errors.push('unhandledrejection: ' + String(ev.reason && ev.reason.message || ev.reason));
    });
})();
