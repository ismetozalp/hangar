# Changelog

All notable changes to the Hangar Cockpit plugin are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — v2 source kinds

**Container volumes (Podman and Docker).** Back up named volumes from either
runtime. Portability is real rather than assumed: `podman volume ls --format
json` emits a JSON array while Docker's `--format` takes Go templates, so hangar
uses `volume ls -q` plus `volume inspect`, which behave identically on both, and
reads mount points from the inspect output rather than hardcoding a storage path.

Rootless containers are per-user, and the backup runs as root from a systemd
unit — root's podman is a different, empty store. A container source therefore
records its owning user and runs every runtime command via `runuser`.

**Consistency is an explicit choice**, because copying a running database's files
can produce a backup that will not restore:

| Mode | Assessment |
|---|---|
| `none` | Fine for static assets; unsafe for a live database |
| `pause` | Better; no guarantee buffered writes reached disk |
| `stop` | The only file-level mode genuinely safe for a database, at the cost of downtime |
| `command` | A dump run inside the container. Safest, no downtime, user-supplied |

hangar warns when `none` is chosen and a container name looks like a database.

**Libvirt virtual machines.** Disk images plus the domain XML — a disk image
without its XML is not a restorable VM, so it is included by default. Disk paths
come from `virsh domblklist --details`, skipping empty CDROMs. Quiesce modes:
`none` (crash-consistent at best), `agent` (needs qemu-guest-agent in the guest
and degrades silently without it), `shutdown` (fully consistent, with downtime).

### Fixed

- **A backup interrupted by SIGTERM left containers stopped and guests frozen.**
  Python kills the process on SIGTERM by default, so the `try/finally` that
  unwinds pre-steps never ran. `systemctl stop`, a unit overrunning its timeout
  and a host shutting down mid-run all deliver SIGTERM, so this was the common
  case rather than an edge case.
- A job with an exclude file raised a `TypeError` from the timer: the field is
  normalised to an array, and the runner passed the list straight to argv.
- `excludes` given as a bare string was iterated character by character.
- The runner's name allowlists were `$`-anchored, which in Python also matches
  before a trailing newline — so a name the editor rejected, the runner accepted.
- Two live-database warnings for one source collapsed into one row, because the
  list was keyed on the warning code.
- "Back up now" on a job mixing files with volumes or domains ran only the
  filesystem half in the browser and reported success.

## [1.0.0] — 2026-08-01

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

### Known limitations

- ReaR's restic integration is `BACKUP=EXTERNAL`, which upstream ReaR does not
  support. This is why the recovery drill exists — verify your rescue image
  before you need it.
- Libvirt VM and Podman volume sources are not yet implemented. The source
  model has the extension point for them.
- Single host only; Cockpit's multi-machine fan-out is not used.
