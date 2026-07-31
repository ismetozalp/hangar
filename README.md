# Hangar

A Cockpit plugin for creating and managing backups.

Pick a destination, turn it on, forget about it — and when something is lost,
scroll back through the **Logbook** and take it back. Hangar adds scheduled,
deduplicated, encrypted backups with automatic retention thinning, a
point-in-time file browser, and bare-metal disaster recovery to the Cockpit web
console.

Cockpit has never shipped a backup UI. Upstream has
[said as much](https://github.com/cockpit-project/cockpit/discussions/16302):
*"It's not like we'd say 'no' to a backup UI (in fact, I think it'd be great to
have one!) — it's just that there is none right now."* Hangar is that.

---

## What it does

**Scheduled backups.** Jobs run from systemd timers with `Persistent=true`, so a
run missed while the machine was asleep fires when it wakes.

**Automatic thinning.** The **Rolling** retention preset keeps 24 hourly, 30
daily, 52 weekly and 12 monthly snapshots, grouped per host and path. Old
snapshots age out on their own; you never manage them by hand.

**The Logbook.** Scroll back through every moment your data was captured and
browse the filesystem exactly as it was. This is a real
[FUSE](https://en.wikipedia.org/wiki/Filesystem_in_Userspace) mount of the
snapshot, not a reconstruction — so it is an ordinary directory tree, and
restoring a file is copying it. Change badges show what was added, modified or
removed between adjacent snapshots.

**Anywhere for a destination.** Local disk, USB, SFTP, a REST server, Amazon S3,
Backblaze B2, Azure, Google Cloud Storage, or any
[rclone](https://rclone.org/overview/) remote — which covers most of the rest.

**Bare-metal recovery.** Hangar builds a bootable rescue image with
[ReaR](https://relax-and-recover.org/) that restores the whole system, to new
hardware if necessary, from the same repository your files live in.

**Verify recovery.** A rescue image you have never tested is a guess. Hangar can
boot yours in a throwaway libvirt VM and prove the restore completes — before
you need it.

**Turnkey.** Hangar installs what it needs. It never tells you to go and run a
package manager.

---

## Requirements

- Cockpit 300 or newer
- systemd (any host running Cockpit has it)
- `restic` 0.17.0 or newer — Hangar installs it for you

Optional, installed on demand for the features that need them:

| Package | Needed for |
|---|---|
| `fuse3` | Browsing snapshots in the Logbook |
| `rclone` | Off-site destinations rclone reaches and restic does not |
| `rear` | Bare-metal rescue images |
| `libvirt` | The recovery drill |

### A note for RHEL, CentOS, Rocky and Alma

`restic` is not in the base repositories on these distributions — it lives in
[EPEL](https://docs.fedoraproject.org/en-US/epel/). If EPEL is enabled, Hangar
installs restic through PackageKit like anywhere else. If it is not, Hangar
offers the official static binary instead, showing you the release URL and its
SHA256 and asking before it downloads anything.

Debian, Ubuntu, Fedora, openSUSE and Arch all package restic directly, so
installation there is a single click.

---

## Installing

```sh
git clone https://github.com/<you>/hangar.git
cd hangar
sudo make install
sudo systemctl try-restart cockpit
```

Then open Cockpit and choose **Hangar** in the sidebar.

To remove it:

```sh
sudo make uninstall
```

Your configuration in `/etc/hangar` is deliberately left in place. Delete it
yourself if you want it gone — and note that removing Hangar does **not** stop
your backups, which is by design (see below).

---

## How it is built

Hangar has no daemon and no database. The system is the state store:

| State | Lives in |
|---|---|
| Schedule | systemd timers and units |
| Backup data and history | the restic repository |
| Job, repository and retention config | `/etc/hangar/**.json` |
| Run history and logs | journald, per unit |
| Secrets | `/etc/hangar/repos/<id>.key`, mode 0600 root:root |

The practical consequence: **uninstall Hangar and your backups keep running.**
Everything Hangar does is reproducible by hand with `systemctl`, `restic` and
`journalctl`, and nothing it manages is locked inside a format only it can read.
It is a view and an editor over system state, not an application that owns it.

The trade-off, stated honestly: Hangar cannot show you anything systemd and
restic cannot tell it. There are no cross-run analytics beyond what journald
retains.

### Layout

```
/etc/hangar/config.json          global settings
/etc/hangar/repos/<id>.json      repository definition (never secrets)
/etc/hangar/repos/<id>.key       repository password, 0600 root:root
/etc/hangar/jobs/<id>.json       job definition
/etc/hangar/dr.json              disaster recovery configuration
/var/lib/hangar/state/<id>.json  last run record, survives reboot
/run/hangar/mnt/<repo>           transient Logbook mount
/usr/libexec/hangar/hangar-run   privileged backup runner
```

---

## Why restic

Hangar drives restic entirely through its `--json` output — progress bars come
from real `percent_done` messages, not from parsing human-readable text — and
restic's exit codes are specific enough to turn a failure into a *fix*:

| Exit | Meaning | What Hangar offers |
|---|---|---|
| 3 | Some files could not be read | Lists them. **The snapshot still exists** — this is not a failure |
| 10 | Repository does not exist | Initialise it |
| 11 | Repository is locked | Unlock it |
| 12 | Wrong password | Re-prompt |

That exit-3 row matters more than it looks. A backup where three unreadable
files turn the whole run red teaches you to ignore red. Hangar records it as
*partial*, tells you which files, and moves on.

Borg was the main alternative and was rejected: its repository is single-writer
under an exclusive lock, so a scheduled run and a manual one collide; remotes
are SSH-only with borg required at the far end; and borg 2.0 is a breaking
repository-format change still in beta.

---

## Security

- Repository passwords are passed to systemd units via `LoadCredential=`, not
  through the environment and not on the command line.
- Backend credentials are exported as environment variables, never as argv, so
  they never appear in `ps` output.
- Repository ids are validated to `[a-z0-9-]` before becoming filenames or
  systemd unit names, so path traversal is rejected at the boundary.
- restic repositories are always encrypted; there is no unencrypted mode to
  misconfigure.

Anyone with root can read the repository password. That is an accepted
trade-off — root can already read everything being backed up — and the secret
handling is isolated in one module so TPM-bound storage can replace it later.

---

## Testing

```sh
npm install          # only for the Playwright-based UI tests
npm run test:unit    # pure logic, no system state touched
npm run test:smoke   # structural checks on the shipped plugin
npm run test:integration   # real restic against a temp repository
npm run test:e2e     # Playwright, against a running Cockpit
```

The integration suite runs a real restic binary against a throwaway local
repository and asserts the round trip: backup, thin, restore, byte-for-byte
comparison — plus the exit-code contracts the entire UI depends on. It skips
cleanly when restic is not installed.

---

## Known limitations

- **ReaR's restic support is not official.** Upstream ReaR has no restic
  workflow; Hangar generates a `BACKUP=EXTERNAL` configuration, which ReaR's own
  documentation calls a last resort. This is precisely why the recovery drill
  exists. Verify your rescue image.
- **Libvirt VM and Podman volume sources are not implemented yet.** The source
  model has the extension point; the implementations are planned.
- **Single host.** Cockpit's multi-machine fan-out is not used.

---

## Licence

See [LICENSE](LICENSE).
