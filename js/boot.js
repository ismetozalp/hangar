// boot.js — inject modal partials into #hangar-partials, THEN load Alpine so it
// walks a complete DOM. Order is the whole trick (see manifest/js/boot.js).
(function () {
    'use strict';
    var PARTIALS = [
        'html/modals/confirm.html',
        'html/modals/repo-edit.html',
        'html/modals/rclone-remote.html',
        'html/modals/job-edit.html',
        'html/modals/restore.html',
        'html/modals/provision.html',
        'html/modals/recovery.html',
        'html/modals/password.html',
        'html/modals/update.html',
        'html/modals/fspicker.html'
    ];

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = function () { reject(new Error('failed to load ' + src)); };
            document.head.appendChild(s);
        });
    }

    var host = document.getElementById('hangar-partials');

    Promise.allSettled(PARTIALS.map(function (p) {
        return fetch(p, { cache: 'no-cache' }).then(function (r) {
            if (!r.ok) throw new Error(p + ' → HTTP ' + r.status);
            return r.text();
        });
    })).then(function (results) {
        var html = results.map(function (res, i) {
            if (res.status === 'fulfilled') return res.value;
            // A missing partial must not stop the plugin loading — the affected
            // modal simply will not open, and the console says which one.
            console.error('[hangar] partial failed:', PARTIALS[i], res.reason);
            return '';
        }).join('\n');
        // Trusted first-party templates only, same-origin under strict CSP.
        if (host) host.insertAdjacentHTML('beforeend', html);
    }).catch(function (e) {
        console.error('[hangar] partial injection error:', e);
    }).then(function () {
        return loadScript('js/alpine.min.js');
    }).catch(function (e) {
        console.error('[hangar] Alpine failed to start:', e);
        // No raw Alpine markup on failure either: leave the shell hidden but
        // display a clear error over the already-themed page background.
        var shell = document.querySelector('.hangar-shell');
        if (shell) shell.style.display = 'none';
        var error = document.createElement('div');
        error.setAttribute('role', 'alert');
        error.className = 'alert alert-danger m-3';
        error.textContent = 'Hangar could not load its interface. Reload Cockpit or check the browser console.';
        document.body.appendChild(error);
        document.documentElement.classList.remove('hangar-loading');
    });
})();
