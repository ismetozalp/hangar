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

## Cloud destinations

Hangar speaks four object stores natively — **Amazon S3** (and S3-compatible
providers), **Backblaze B2**, **Azure Blob Storage** and **Google Cloud
Storage** — plus local disks, USB drives, SFTP and a
[restic REST server](https://github.com/restic/rest-server).

Everything else goes through [rclone](https://rclone.org/overview/), which adds
roughly forty more: **Google Drive, Dropbox, OneDrive, Box, pCloud, Mega, Proton
Drive, iCloud Drive**, Yandex Disk, Koofr, Jottacloud, Seafile, and protocols
including **WebDAV, SMB/CIFS, FTP and HDFS**.

Two things worth knowing before you choose:

**Prefer the native backend where one exists.** If you are on S3, B2, Azure or
GCS, use Hangar's own repository kind rather than routing through rclone — one
less process in the path, one less thing to fail.

**Do not add rclone's `crypt` layer.** restic already encrypts everything
client-side before it leaves the machine. Layering `crypt` underneath buys
nothing and costs CPU; your provider holds encrypted restic packs either way.

### Adding a cloud destination

Hangar can create the rclone remote for you — **Repositories → Add a cloud
destination** — so `rclone config` is not a prerequisite. How much it can do
depends on how the provider authenticates.

| Kind | Providers | What you do |
|---|---|---|
| **Credentials** | WebDAV, SFTP, FTP, SMB, S3, B2, Swift, Koofr, Mega | Fill in the form. Nothing to run elsewhere. |
| **Sign-in** | Google Drive, Dropbox, OneDrive, Box, pCloud, Yandex | Run one command on **your own computer**, paste the result back. |
| **Manual** | Jottacloud | Hangar cannot automate it — it shows you what to run. |

### Why sign-in needs a command on your own computer

`rclone authorize` starts a local web server and asks the provider to redirect
your browser to `127.0.0.1` when you approve. Run it on the server and that
redirect points at the *server's* loopback address, which your laptop's browser
cannot reach.

So Hangar shows you the exact command, you run it where your browser is, and you
paste the token back. This is rclone's own documented headless procedure, not a
workaround Hangar invented.

### Per-provider limits

These are properties of the providers, not of Hangar, and Hangar states each one
at the point where you choose:

| Provider | Limit |
|---|---|
| **Google Drive** | rclone's built-in client ID is shared by every rclone user and is **heavily rate-limited**. For anything beyond a trial, register your own in the Google Cloud console — backups will be far faster. This is the only one Hangar flags as a warning rather than a note. |
| **OneDrive** | A **OneDrive for Business** tenant may refuse rclone's built-in client ID outright. Register an app in Entra ID. |
| **Box** | The refresh token **expires after 60 days of inactivity**. A repository that is never written to will eventually need re-authorising. |
| **pCloud** | Accounts live in one of two regions. If the remote lists nothing after you authorise, the account is in the other one. |
| **Dropbox, Yandex** | Shared-key rate limits and per-application quotas. Your own app registration avoids them; the built-in one is usually fine for modest backups. |
| **Jottacloud** | Works as a destination, but **Hangar cannot create the remote.** rclone has no `authorize` flow for it — verified, not assumed: `rclone authorize jottacloud` answers *"not supported by this backend"*. Generate a personal login token in Jottacloud's web interface, run **interactive** `rclone config` once, and Hangar will pick the remote up. Note that the non-interactive `rclone config create <name> jottacloud` **appears to succeed but leaves a remote with no token** — it will show up in Hangar's list and fail at backup time. Use interactive `rclone config`. |


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
| `libvirt` | Backing up virtual machines, and the recovery drill |

### A note on virtual machines

Hangar talks to `qemu:///system` as root, so it needs no group membership and is
unaffected by polkit. If you want to run `virsh` against the system hypervisor
*yourself*, add your account to the `libvirt` group and log back in:

```sh
sudo usermod -aG libvirt $USER
```

Without it, a read-write `virsh -c qemu:///system` command appears to hang — it
is actually waiting on a polkit prompt that nothing is there to answer.

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

Stated plainly, because a backup tool that oversells itself is worse than one
that does less.

**Disaster recovery rests on an unsupported path.** Upstream ReaR has no restic
workflow. Hangar generates a `BACKUP=EXTERNAL` configuration, which ReaR's own
documentation calls a last resort, and upstream will not support it. This is
exactly why the recovery drill exists — **build the rescue image and verify it
before you need it.** An untested rescue image is a guess.

**Backing up a running database's files can produce a backup that will not
restore.** Hangar warns when a container that looks like a database is backed up
with consistency `none`, but no warning makes a live copy safe. For databases
use `stop`, or `command` with a real dump (`mongodump`, `pg_dump`).

**VM quiesce mode `agent` degrades silently.** It needs `qemu-guest-agent`
running *inside* the guest. Without it the freeze fails and the copy is only
crash-consistent — and nothing in the guest tells you that.

**`none` quiesce is crash-consistent at best.** It is the fast option, not the
safe one. Whether that is acceptable depends entirely on what the VM runs.

**One machine.** Hangar manages the host it runs on. Cockpit's host switcher has
been deprecated and disabled by default since Cockpit 322, for sound security
reasons, so Hangar deliberately does not build on it. If you want several
machines in one view, point them all at **one shared restic repository** —
concurrent writers are safe and every snapshot records its hostname, so the
aggregation happens in the data rather than in the browser.

**Jottacloud cannot be configured from Hangar**, and several cloud providers
carry rate limits that are not Hangar's to fix. See
[Per-provider limits](#per-provider-limits).

**restic and rclone are not Red Hat–supported on RHEL.** They live in EPEL. Only
ReaR ships in RHEL AppStream proper. For a homelab this is irrelevant; for a
supported production estate it is a procurement question worth asking first.

**No cross-run analytics.** Hangar has no database, so it can only show what
systemd and restic can tell it. Once journald rotates, that history is gone.

## Licence

See [LICENSE](LICENSE).
