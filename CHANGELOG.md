# Changelog

All notable changes to the Hangar Cockpit plugin are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.8] — 2026-08-25

Nothing here changes what the plugin does. Every screen, every command and every
file it writes behaves exactly as in 1.0.7 — this is development tooling, and it
is tagged only so the repository and the published archive agree on a version.

### Added

- **Coverage is reported whenever the tests run.** `make test` measures line,
  branch and function coverage over `js/` and fails below a floor of 94/89/90 —
  a shade under what the suite achieves today, so code that arrives untested
  turns the run red rather than quietly moving the number down.
- **`make coverage`** writes `coverage/lcov.info` for editors, and a committed
  `COVERAGE.html`: a row per source file, sortable by any column, opening
  worst-first and colour-banded at the floors the build enforces. The report
  names what it does **not** measure — `libexec/hangar-run` is Python, driven end
  to end by the integration suite and invisible to node's instrumentation —
  because one number that silently omits 2200 lines is worse than no number.
- **`make release`** chains the steps of cutting a release: test, build, write
  the coverage report, commit it, publish. It does not bump the version or move
  a tag; deciding that a change is the next version is a judgement, not a recipe.

### Changed

- The archive and the installed copy no longer carry `libexec/__pycache__`,
  `COVERAGE.html` or `coverage/`. They are build and development artifacts, and
  an installed plugin has no business holding a record of how it was tested.

## [1.0.7] — 2026-08-25

### Added

- **Repository sizes are remembered, with the date they were taken.** `restic
  stats` reads the whole repository — 50 to 118 seconds against a NAS over SFTP
  — so the Overview and the Repositories screen now show the last measurement
  and when it was made, and measure again only when it has gone stale. A row
  says "measured 3 hours ago" beside its size rather than presenting an
  hours-old number as if it were current.
- **A "Measure now" button** on the Overview, which ignores the remembered size
  and asks the repository directly. "How big is it right now" is the one
  question a cache cannot answer.
- **A setting for how often sizes are measured**, in hours, defaulting to 24.
  Accepts anything from 15 minutes to a year, or 0 to only measure when asked.
- **The nightly backup keeps the number fresh for free.** A job with a size
  limit already measures the repository for its size guard; that measurement is
  now written where the browser reads it, so a machine that backs up nightly has
  a current size on screen without anyone ever waiting for one.

## [1.0.6] — 2026-08-24

### Fixed

- **The Overview waited on a remote size query before showing anything.**
  `restic stats` reads the repository, and on a remote one that means loading
  its index first — measured at 50 to 118 seconds against a NAS over SFTP. The
  screen awaited it before rendering, so jobs, statuses and schedules already
  read from local files in milliseconds sat behind it. A screencast showed the
  loading placeholders still up after 28 seconds. Jobs now appear in about
  three seconds and each repository fills in its own size when it arrives.
- **A broken repository definition is reported at once**, rather than after the
  wait: an unknown repository kind is rejected while building the command, which
  touches nothing remote.

### Changed

- A repository whose size is still being measured shows a placeholder in that
  cell rather than a dash, which reads as "there is nothing here".

## [1.0.5] — 2026-08-24

### Fixed

- **Leaving the Overview open could stop retention from ever running.** 1.0.3
  taught the Repositories screen to stop reading the repository while a backup
  is in progress, because every read takes a restic lock and retention needs an
  exclusive one. The Overview lists repository sizes through its own path and
  was missed, so the default screen — the one most likely to be left open —
  went on polling and denying retention its lock. Observed on a real machine:
  the Logbook mount released, no stale locks left, and retention still blocked
  by this screen's own `stats` calls. A missing size now shows as a gap in the
  summary rather than a backup that cannot finish.

## [1.0.4] — 2026-08-09

### Fixed

- **The update badge kept offering an update that had already been installed.**
  The installed version was read once when the screen loaded and cached, but
  this screen can update the plugin in place — which changes the served files
  without reloading the tab. Every later check compared a fresh release against
  that stale value, so the badge went on saying "Update to X" after X was
  running, until the page was reloaded. A check now re-reads the version it is
  actually serving before comparing. An unreadable VERSION leaves the known
  value alone rather than falling back to 0.0.0, which would make every release
  look newer.

## [1.0.3] — 2026-08-09

### Fixed

- **The Overview could not see a backup it had not started itself.** The row it
  builds was handed the systemd unit state and dropped it, so the check for
  "is anything running" always answered no. A run started by the timer, by
  `systemctl start`, or from another browser tab left the screen showing
  whatever it last knew — including "Running now" long after the run had
  finished — until the page was reloaded.
- **Screens correct themselves without a reload.** The Overview and Jobs
  screens watched only while they believed a run was in flight, which is no
  help when the belief is wrong. They now check every 30 seconds when idle and
  every 5 while a run is going, dropping back when it ends. The idle check reads
  systemd unit state only: it touches no repository and takes no restic lock, so
  an open tab cannot get in the way of a backup or its retention.

### Changed

- **The Overview shows what it is loading, not just that it is.** The bare
  "Loading…" is replaced by placeholder rows in the shape of the real ones — a
  status dot, a name, a status line — drawn as many times as there were jobs
  last time. A refresh keeps the data already on screen and says "Checking…"
  instead, rather than blanking good rows to redraw them identically. The
  highlight that sweeps across them is disabled for anyone who has asked their
  system for less motion.

## [1.0.2] — 2026-08-09

### Fixed

- **Retention could be blocked for ever by a lock nobody owned.** restic's
  `forget` needs an exclusive lock, and a lock left behind by a process that
  died — a killed mount, an interrupted run — is never cleaned up on its own.
  Measured on a real repository: a lock thirteen hours old, its process long
  gone, and every backup in between reporting "retention failed" while the
  backups themselves succeeded. A blocked retention now clears locks whose
  owner is gone (`restic unlock`, which leaves a live lock alone) and retries.
- **hangar competed with itself for the repository.** A Logbook mount holds a
  lock while somebody browses, and the Repositories screen polled sizes every
  few seconds, each poll taking one of its own. The backup now releases its own
  Logbook mount when that is what blocks it, and size polling pauses while a
  backup is running.

## [1.0.1] — 2026-08-08

### Fixed

- **The Logbook could be wedged by a mount that died.** When the restic process
  behind a FUSE mount ends without unmounting — a stopped unit, a killed
  process — the kernel keeps the mountpoint and every access to it returns
  ENOTCONN. Each new mount then failed on the remains of the last one, and the
  Logbook fell back to its slower reader indefinitely; the only cure was a
  hand-run `fusermount -u`. A dead mountpoint is now cleared before mounting.
  Detection reads `/proc/mounts`, because anything that stats the path fails the
  same way the mount does.
- **A repository with no releases reported "Update check failed".** GitHub
  answers 404 for `releases/latest` until something is published, and `curl -f`
  turned that into an exit code with no status attached — indistinguishable from
  a broken network. The check now reads the status and says plainly that nothing
  has been published yet.

## [1.0.0] — 2026-08-08

First stable release. File-level backup with automatic retention thinning, a
point-in-time snapshot browser, and bare-metal disaster recovery.

### Added

**Engine**
- `restic` as the backup engine, driven entirely through its `--json` output.
  Streaming progress comes from restic's JSON-lines `status` messages rather
  than from parsing human-readable text.
- Typed error model mapping restic's exit codes to remediations the UI can
  offer as a single click: repository locked → unlock, wrong password →
  re-prompt, repository missing → initialise.
- Repository support for all eight restic backends: local, SFTP, REST server,
  Amazon S3, Backblaze B2, Azure, Google Cloud Storage, and rclone remotes.
  Off-site backup uses restic's own rclone backend, which reads an existing
  `rclone config` — rclone's HTTP `rcd` API is not involved.

**Scheduling and retention**
- Jobs run from systemd timers, with `Persistent=true` so a run missed while
  the machine was asleep still fires on wake.
- Retention presets including **Rolling** (24 hourly, 30 daily, 52 weekly,
  12 monthly), applied per host and path group.
- A retention policy that would keep no snapshots is refused rather than
  obeyed — in both the UI and the privileged helper.

**Logbook**
- Point-in-time browser backed by a real `restic mount` FUSE filesystem, so
  browsing the past is reading an actual directory tree rather than a
  reconstruction. Falls back to `restic ls --json` where FUSE is unavailable.
- The mount runs as a transient systemd unit, so it survives a page reload
  instead of dying with the browser channel, and unmounts when idle.
- Change badges between adjacent snapshots derived from `restic diff --json`.

**Disaster recovery**
- Bootable rescue image via ReaR. Because ReaR has no restic workflow upstream,
  Hangar generates the `BACKUP=EXTERNAL` configuration so the same repository
  serves both file history and bare-metal recovery.
- **Verify recovery** — builds the rescue image and boots it in a throwaway
  libvirt VM to prove the restore actually works, rather than assuming it.

**Turnkey setup**
- Missing prerequisites are installed through the PackageKit D-Bus API, which
  works across RPM and DEB systems without hardcoding a package manager.
- Where a distribution does not package restic — notably RHEL and CentOS,
  where it lives only in EPEL — Hangar offers the official static binary,
  showing the release URL and SHA256 and requiring explicit consent before
  downloading anything.

### Security notes

- Repository passwords live in `/etc/hangar/repos/<id>.key`, mode 0600
  root:root, and are passed to systemd units via `LoadCredential=` rather than
  through the environment or the command line.
- Backend credentials are exported as environment variables, never as
  command-line arguments, so they do not appear in `ps` output.

**Recovery**
- Bootable rescue image built from the same repository the files live in, with
  hangar generating the ReaR `BACKUP=EXTERNAL` configuration rather than leaving
  the unsupported part to be hand-written.
- **Verify recovery** boots that image in a throwaway libvirt VM, runs the
  recovery unattended, reads the guest's serial console, reports whether it
  finished, and removes the VM afterwards. It runs as a transient systemd unit,
  so it survives a page reload or a dropped connection, and a page opened while
  a drill is running picks it back up.
- Drill settings for the disk location, the disk size, the expected system size,
  firmware, network and timeout — the drill disk must match the *original* disk,
  because ReaR recreates the recorded partition table.
- Optional **shrink limit** (`AUTOSHRINK_DISK_SIZE_LIMIT_PERCENTAGE`) for
  recovering onto a replacement disk slightly smaller than the original.
- An **Exclude file** field, so the disaster-recovery snapshot skips exactly what
  the backup job skips instead of carrying hundreds of gigabytes it was told to
  leave out.
- The rescue image lands in the operator's home directory by default, not
  root-only `/var/lib/rear/output`: it is the one file you must be able to find
  and copy to a USB stick *before* the machine that built it is unavailable.

**Sources beyond the filesystem**
- **Container volumes**, Podman and Docker. Named volumes are read through
  `volume ls -q` plus `volume inspect`, which behave identically on both
  runtimes, rather than a hardcoded storage path. A source records its owning
  user and runs every runtime command through `runuser`, because rootless
  containers are per-user and the backup runs as root.
- **Libvirt domains**, with the consistency mode stated rather than assumed:
  copying a running machine's disk can produce a backup that will not restore.

**Logbook**
- The size of the snapshot being browsed, shown beside the selection summary —
  `40.1 GiB · 645,462 files` — measured with `restic stats --mode restore-size`.
- Deleting a snapshot from the UI, with the mount released first.

**Throughout**
- One unit convention: sizes are binary (GiB) everywhere, so the same repository
  cannot read 34.9 in one screen and 40.1 in another.
- Retention waits out a repository lock for about two minutes before giving up,
  because the lock is usually hangar's own browsing session and abandoning the
  prune leaves old snapshots to accumulate silently.

### Known limitations

- ReaR's restic integration is `BACKUP=EXTERNAL`, which upstream ReaR does not
  support. This is why the recovery drill exists — verify your rescue image
  before you need it.
- Container and libvirt sources back up volumes and domains, but consistency is
  the operator's choice: a running database copied file-by-file may produce a
  snapshot that will not restore. Pause the container, or dump the database in a
  pre-hook.
- Single host only; Cockpit's multi-machine fan-out is not used.
