# Changelog

All notable changes to the Hangar Cockpit plugin are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
