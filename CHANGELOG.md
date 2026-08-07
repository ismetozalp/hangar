# Changelog

All notable changes to the Hangar Cockpit plugin are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed — screens that were photographs of page-load time

Reported from real use: a backup of `/` ran for six minutes and finished, and the
Overview still said *"Not run yet"*, the Jobs table said *"Never run"*, and the
Logbook offered *"Nothing has been backed up yet"* about a repository that had
just received 475,000 files. Every screen read its data once, at load, and
nothing ever read it again.

* **A run is a run, whoever started it.** The Jobs screen only knew about backups
  it had started in that browser tab, so one launched by the timer, by
  `systemctl start`, from the Overview, or from another tab was invisible — even
  though the systemd state it needed was already in the row. It now derives
  "Running now" from the unit, as the Overview always did, and "Back up now" is
  withheld while a run is in flight rather than offering to start a second one.
* **The Overview and Jobs poll while something is running**, every five seconds,
  and stop as soon as nothing is. An idle page makes no periodic calls at all.
* **The Logbook re-reads its snapshot list when the screen is shown.** It compares
  ids first and does nothing when the set is unchanged, so glancing at another tab
  no longer throws away the folder you were looking at.

### Fixed — Verify recovery could never run

The drill died the moment it started, with virt-install reporting:

```
error: Cannot run interactive console without a controlling TTY
```

hangar asked for `--console pty,target_type=serial` and ran virt-install through
cockpit's channel, which has no controlling TTY and never will. virt-install
refused AFTER defining the domain, so every drill left a VM behind and proved
nothing. Three further problems sat behind that one, each found only by running
it on a real host:

* The guest console now goes to a FILE rather than a terminal nobody is sitting
  at. Not beside the drill disk — `/var/lib/libvirt/images` is `drwx--x--x
  root:root`, so qemu can traverse it and cannot create anything in it.
* hangar makes `/var/lib/hangar/drill`, group-owned by whichever group libvirt
  runs qemu as (`qemu`, `libvirt-qemu` or `kvm`, probed in that order) and mode
  0770 — libvirt unlinks that file as the qemu user when the domain goes away,
  and unlinking needs write on the directory, not just traverse.
* With SELinux enforcing the file also needs `svirt_image_t`; it inherits
  `var_lib_t` from its directory, which qemu may not write whatever the Unix
  permissions say.

**And the rescue system now speaks on the serial port** (`USE_SERIAL_CONSOLE=1`,
`console=ttyS0,115200n8`). Without it the drill ran perfectly and reported
nothing — which reads as a failure and is really a deaf observer. Rebuild the
rescue image for this to take effect.

### Fixed — the rescue image path pointed at the wrong copy

hangar reported where ReaR BUILT the image, not where it delivered it. ReaR
always builds into its own output directory and then, when OUTPUT_URL points
elsewhere, copies the result there — into a subdirectory named after the host.
Its log says both:

```
Wrote ISO image: /var/lib/rear/output/rear-localhost.iso (905M)
Copying result files '…/rear-localhost.iso …' to /home/operator/localhost at file location
```

So a user who set the output to their home was sent to `/var/lib/rear/output`
while their rescue image sat in `/home/operator/localhost/`. The copy destination
now wins when there is one — that is the file to put on a USB stick. A remote
destination (`nfs://`, `sftp://`) is not a path anyone can open locally, so the
built copy stays the reported one there.

### Fixed — three ways the Recovery screen misled

* **Two contradictory boxes at once.** After a rebuild the screen showed "The
  rescue image is gone" beside "Rescue image ready", naming the same path. The
  load-time check set the first; the build that answered it never cleared it.
* **Build ran against a configuration nobody had written.** `rear mkrescue` reads
  `/etc/rear/local.conf`; it knows nothing about the form. Building with unsaved
  changes produced an image from the OLD configuration — several minutes later,
  with nothing on screen to say so. That is how an image landed in
  `/var/lib/rear/output` while the form said `/home/operator`, and how one got built
  from ReaR's stock file with none of hangar's restic workflow in it. The build
  now compares the two first and refuses, naming the button to press. A check
  that cannot run (no cockpit, no privileges) lets the build proceed.
* **A drill that could only ever time out.** If the image's boot default is "boot
  the hard disk" or "wait for a human", the drill VM — which has no screen anyone
  can type at — sits at the boot menu until it gives up. Measured on a real host:
  100% of one CPU, **zero bytes** written to the target disk, ten minutes in. The
  Verify dialog now says so before the run and names the setting to change. It is
  a warning rather than a rule, because the default that makes a drill useless is
  the right one for a rescue USB: one left in a running server must never start
  recovering by itself.

### Added — Recovery takes an exclude file

The Recovery screen showed hangar's short built-in exclude list while the backup
job used a 70-pattern `~/excludes.txt`. Two answers to "what does this machine
skip" is one too many: the disaster-recovery snapshot would have carried the
hundreds of gigabytes the nightly job was told to leave out.

There is now an **Exclude file** field, with a Browse button, that reaches restic
as `--exclude-file`. Point it at the same file the job uses and both skip the
same things, with one file to edit. The file is also copied into the rescue
system, because a rescue shell that reruns the backup step must be able to read
it — restic treats a missing `--exclude-file` as a hard error, not a warning.

The inline list is still there for the handful of paths that must never be in a
DR snapshot (`/proc`, `/sys`, `/dev`, `/run`); the two are combined.

### Fixed — Recovery lost its default paths and excludes

Reported from real use: selecting a repository used to fill "Paths to back up"
and "Excludes"; after building a rescue image it stopped, leaving a recovery
configuration that backs up nothing at all.

hangar records the path of the last image it built in `/etc/hangar/dr.json` — the
same file a saved configuration lives in. So that file could exist holding
nothing but `{"lastIso": "..."}`, and the loader, seeing a file, treated it as a
saved form and blanked the defaults. The rule "an absent list is an empty box,
not the default list" is right for a form somebody saved; it was being applied to
hangar's own bookkeeping.

A stored object now counts as a saved configuration only if it carries something
a save actually writes — a field, a list, or one of the switches. A list that is
present but empty still counts, so clearing the excludes and saving is respected.

### Fixed — "Rescue image ready" for an image that was gone

hangar recorded the path of the last image it built and never looked at it
again, so the screen went on promising a rescue image that had been deleted,
moved, or written to a USB stick and taken away. That is the worst thing this
screen can get wrong: the entire point of the rescue image is that it exists when
nothing else does.

The path is now checked when the screen loads. If the file is gone the promise is
withdrawn and replaced by a notice naming what went missing — a user who moved it
deliberately should recognise what happened rather than wonder whether the build
ever worked. A check that cannot run (no cockpit, no privileges) leaves the
record alone rather than discarding a good image.

### Changed — the rescue image lands where you can find it

The default ISO location is the home directory of the operator using hangar,
discovered from the Cockpit session, rather than ReaR's `/var/lib/rear/output`.
That directory is root-only and easy to forget, and the ISO is the one file you
must be able to find and copy to a USB stick *before* the machine that built it
is unavailable. A location already configured, or typed, is never overwritten;
an unusable home falls back to ReaR's own default.

### Fixed — the folder picker could not create a folder

Reported as "I cannot create folder here", and it was not a permission problem:
`mkdir` worked perfectly when called directly. The **Create** button was disabled
and could never enable.

Alpine removes a boolean attribute only for `null`, `undefined` or `false`, and
sets it for anything else:

```js
[null, undefined, false].includes(value) ? removeAttribute() : setAttribute()
```

The binding ended in `newFolderProblems().length`. A valid name produces an empty
array, whose `.length` is `0` — not `false` — so Alpine set `disabled`. Typing a
GOOD name was precisely what disabled the button; a bad one left it enabled.

Fixed with an explicit comparison, and smoke now checks every boolean-attribute
binding in the plugin (52 of them) for a last operand that can evaluate to `0`.

### Changed — one unit for every size

The same repository read three ways on three screens: `34.9 GiB added` on the
Overview, `14.8 GiB` on Repositories, `40.1 GB` in the Logbook. All three were
correct and all three measured something different — what the last run added,
what the repository occupies after deduplication and compression, and how much
data the snapshot holds — but the third was in a different UNIT as well, which
turned an explainable difference into a contradiction.

Everything is **binary (KiB/MiB/GiB)** now, matching what `restic` itself prints,
so a number on screen can be compared with the same repository at a shell. Four
modules format bytes — three screens and the size guard, duplicated on purpose
because `core/` must not depend on `features/` — and smoke now fails if their
unit tables ever disagree again.

Size limits still PARSE as typed: `1TB` is 10¹² and `1TiB` is 2⁴⁰. Only the echo
changes, so a limit entered as `1TB` reads back as `931.3 GiB` — the same unit as
the repository size it is being compared against. The Logbook's figure now says
what it is: `34.9 GiB · 475,099 files in this snapshot`.

### Added — how much is in this snapshot

The Logbook toolbar shows the size of the snapshot being browsed —
`40.1 GB · 645,462 files` — next to the selection summary, so "what is in here"
and "what have I picked" read together.

Measured with `restic stats --mode restore-size`, which answers the question a
person browsing a backup is actually asking: how much data this snapshot holds,
not how many bytes it occupies after deduplication against its neighbours. It is
read separately from the file tree and never awaited, because walking a snapshot
takes seconds on a NAS and the file list must not wait for it. A size that cannot
be read shows nothing rather than a zero.

### Added — deleting a snapshot

**Delete a snapshot from the Logbook.** The moment you are looking at can be
removed, with a confirmation that names it and says plainly that it cannot be
undone. Two details matter and are handled rather than left to the user:

* restic separates unlinking a snapshot (`forget`, instant, frees nothing) from
  reclaiming its space (`prune`, slow — four minutes for 150 GiB over CIFS in one
  measured run). Both run, and the dialog says the second takes a while.
* A live Logbook mount holds a *shared* lock on the repository and prune needs an
  *exclusive* one, so the mount is released first. Otherwise restic refuses with
  `repository is already locked by PID …` — naming a lock hangar itself is
  holding, which is not something a user can act on.

### Changed

**No empty dropdowns.** A picker with nothing in it offers a choice that does not
exist, and naming another tab in small print underneath leaves the user to find
it. Where the list is empty the control is replaced by what is actually needed —
"There is no repository yet" and a **Create one now** button that closes the
dialog, switches to Repositories and opens the form. Applies to the job dialog
and the Recovery screen; the Logbook and the rclone remote field already did
this. An e2e check walks all six tabs and fails on any visible `<select>` with
nothing to choose.

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

- **restic could not run from any systemd unit.** It locates its cache from
  `$XDG_CACHE_HOME` or `$HOME`, a systemd unit has neither, and restic exits 1
  before touching the repository:

  ```
  unable to locate cache directory: neither $XDG_CACHE_HOME nor $HOME are defined
  ```

  This broke the Logbook — its mount unit died instantly, so browsing reported
  `find: '…/snapshots/…': No such file or directory` about a snapshot that was
  perfectly fine — and it would have failed **every scheduled backup**, silently,
  every night. It never showed up in development because the cockpit bridge
  happens to carry a `HOME`, so the same commands worked from the browser.
  `--cache-dir` is now passed on every repository operation by all three
  implementations (engine, mount unit, privileged runner), `make install` creates
  `/var/cache/hangar/restic`, and smoke fails if the three ever disagree.
- **The Logbook listed the mount before it was serving.** `systemd-run` returns
  when the unit's process has been executed, not when FUSE is attached — about
  0.75 s early for a small local repository, and considerably more for one on a
  NAS that has to fetch its index first. The Logbook now waits for the snapshot
  directory to appear, and falls back to the slower reader rather than reporting
  a missing path if it never does.
- **Pressing Save on a job closed the dialog and wrote nothing.** No error, no
  job, nothing on disk. Every partial carried `x-init="init()"` while its
  component also defined `init()` — and Alpine 3 calls `init()` by itself, so it
  ran twice and every window listener was registered twice. The dialog therefore
  received its own open event twice; the second delivery hit the "a second open
  cancels the first" guard and resolved the caller's promise with `null` before
  the user had typed anything, leaving `submit()` with nothing left to resolve.
  The attribute is gone from all ten partials and the four screens that had it,
  smoke rejects it, and an e2e check asserts that opening a dialog never resolves
  its caller.
- **A repository created a moment ago was missing from the next job's
  dropdown.** Every screen keeps its own copy of the repository list, read when
  that screen loaded, and nothing told the others when one was added or removed —
  so a user who created a repository and then pressed "Create job" was offered
  nothing to back up to. The Repositories screen now announces changes, the Jobs
  screen listens, and the job editor re-reads the list as it opens.
- **hangar told a machine with a working repository that it had none.** Cockpit
  starts every session with *limited access* and all of hangar's configuration
  lives in root-owned `/etc/hangar`, so the listing was refused — and `listIds`
  turned that refusal into an empty array. Repositories, jobs and the Logbook all
  reported an empty install, and the job dialog offered no destination to back up
  to. A refusal now raises `ADMIN_REQUIRED`, the shell says so once at the top of
  every screen with a **Check again** button, and no screen may render an empty
  state unless the read that produced it actually succeeded.
- **The folder picker showed "This folder is empty." for every folder.** It asked
  `find` for NUL-separated records, and `cockpit.spawn`'s text channel discards
  output containing NUL: measured against a real Cockpit session, `-printf
  '%y\t%f\0'` resolves with an empty string — no error, no partial listing —
  while `'%y\t%f\036'` returns all 20 records. The picker is record-separated
  (0x1E) now, written as an escape on both sides, and still accepts NUL when
  splitting. Smoke rejects any literal control byte in shipped source, and a
  listing that arrives but cannot be parsed now says so rather than reporting a
  full filesystem as empty.
- **The picker refused to list anything in a session without administrative
  access.** Listing demanded `superuser: 'require'`, so the dialog opened onto
  "Not permitted to perform this action." It asks with `'try'` now — root-owned
  paths like `/srv` and `/var/lib` are still reachable when admin access is
  granted, and without it the user sees what they can see instead of nothing.
  Creating a folder still requires it.
- **Every Browse button did nothing.** `HangarDialogs` is a shared namespace:
  `fspicker-ui.js` adds `pickPath` to it, `app.js` adds the confirm and password
  dialogs — and `app.js` is the last script `index.html` loads, so its plain
  assignment deleted `pickPath`. Clicking Browse called a function that was no
  longer there and returned quietly. It is merged now, and smoke fails the build
  if any writer of a shared global replaces it instead of extending it.
- **The Repositories screen never showed a size.** Every row sat at "Reading
  repository…" with an em dash for its size and its actions disabled, for as
  long as the page stayed open. `refresh()` assigned the row array to the
  component and then handed the *raw* objects to the size query, so each result
  landed in the data without notifying Alpine of anything.
- **The Logbook left "Mounting the repository…" over a loaded file tree.** Three
  overlapping loads shared one boolean, so the first to finish declared the
  screen idle while the others still ran — and because Alpine applies `x-show`
  on an animation frame, the resulting flurry could settle on the wrong state.
  Busy is now counted, not toggled.
- **A `<select>` filled by `x-for` displayed its first option rather than the
  value the component held.** The password dialog generated a six-word
  passphrase under a box reading "Two words, two numbers — weak". Alpine binds
  `x-model` before the options exist; hangar now re-applies the model when a
  select gains options, which also covers dialogs whose lists load later.
- A heading inside an alert was nearly invisible: Bootstrap paints headings with
  `--bs-heading-color`, which every theme sets for the dark page background, not
  for an alert's light tint.
- The jobs table reported `Failed (AUTH_EXPIRED)`. It now says which failure it
  was, in the same words the Overview banner uses.
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
