## Context

The CLI composes the harness at `src/modules/harness/runtime.ts`. It passes
`libStorePath` only when `harness.libStore` is true. It reads the inventory from
the active farm of the store, or from the image label cache. The store
download runs behind the same switch, and the sandbox gate carries a `disabled`
phase for the switch that is off (`src/tui/hooks/sandbox_gate.tsx`).

That shape assumes a baked fallback. The harness change retires the baked
variants, thus `sandbox-base` is the only runtime image and its
`/mnt/libs/current` is empty. As a result the switch, the conditional gate, and
the inventory fallback each name a state that no longer works.

Two host-side facts drive the rest of this design. The provisioner image has no
published reference on a user machine today, thus every store command that runs
the container fails with `image_unconfigured`
(`src/modules/libs/store.ts:129-134`). And nothing moves `current`, thus a
downloaded farm can sit beside an active local farm with no way to reach it.

## Goals / Non-Goals

**Goals:**

- Each sandbox mounts a usable store, or the action refuses with a remedy.
- The user chooses nothing that has one correct answer.
- A host action that reads or moves a pointer costs no container start.
- A switch of the active farm is atomic, and it never leaves `current` absent.
- One inventory source, which is the store that the sandbox will mount.

**Non-Goals:**

- A merge of two farms. `store use` switches, and it never joins.
- The farm-subset download. This change downloads the whole store, as today.
- The agent-facing install tool, and the retention policy for an old store.
- The managed service, which stays decoupled.

## Decisions

**Remove the opt-in, and pass the store root unconditionally.** The key existed so
a user could depend on the packages that the image baked. It let an installation
with a baked image miss a multi-gigabyte download. That is the whole reason that
the key is there, and the reason that it goes.

No image bakes a library after the harness change. Thus an off state gives a
sandbox with nothing to import, and the switch has no off position that works. A
switch with one working position is not a switch.

The rejected alternative is to keep the key and report a warning when it is off.
That trades one clear failure for a product that runs and produces nothing.

**State what the first run looks like.** A fresh machine holds no store. The store
is mandatory, thus the first analysis meets a multi-gigabyte download and it has
no fall back. That wait is the primary cost of this change, and the user meets it
on day one.

The order is fixed, and `src/tui/hooks/sandbox_gate.tsx` already carries each
state that it names:

1. The app opens at once. Chat, the workspace read surface, and the planner
   answer while no store is there.
2. At app open the background trigger reads the store. With no receipt it opens
   the consent one time (`consent`), and the consent names the size.
3. A yes starts the background download (`downloading`), which carries a running
   byte total. A no records `declined`, and the gate offers the consent again at
   the first sandbox action.
4. The first action that makes a sandbox holds. The gate reports which state it
   is in: `consent`, `downloading` with its byte total, or `failed` with its
   message.
5. A complete store records `installed`. The gate then makes sure of the sandbox
   image, which asks its own consent. Then the action runs.

A failed download leaves a usable app and a refused sandbox action. The gate
reports the message, and it offers a retry at the next action. It must not hold
without end, and it must not start a sandbox against an incomplete store. Chat,
the workspace read surface, and the planner keep working, thus the user reads,
searches, and plans while the store is absent.

**Make the provisioner image a code constant.** The provisioner has no variant:
either the machine holds it or it does not. Thus it is not a user setting. The
constant sits beside `GHCR_NAMESPACE` in `src/modules/libs/images.ts`, which is
already the one place that names a published image. `inflexa setup` pulls it,
exactly as it pulls the sandbox image today. The rejected alternative is to keep
`harness.provisionerImage` with a default. A default that a user can override
gives a wrong-version provisioner with no benefit, because there is nothing to
choose.

**Start the provisioner container only for an install.** The provisioner image is
1.85 GB. To start it to read a symbolic link is not permitted. The reads and the
pointer move are plain host filesystem work, and `store ls` already does its work
on the host. `store add` keeps the container, because it needs a network and a
compiler. `store remove-farm` and `store reclaim` keep it too, because both mutate
the store under the per-store lock that the provisioner owns.

**Write `current` by rename, not by unlink and make.** `flip_current` in the
provisioner unlinks `current`, then it makes the link again
(`images/sandbox-provisioner/provision.py:903-905`). Between the two calls
`current` is absent. `libStoreUsable` refuses a store whose `current` does not
resolve (`harness/src/sandbox/docker-client.ts:126-135`), and the harness then
drops the mount with a warning only. Thus a sandbox that starts in that window
holds no package and reports nothing.

`store use` makes the link at a temporary name in the store root. Then it renames
the temporary name over `current`. A rename over an existing name is atomic within
one filesystem, and the store root is one filesystem.

**`store use` switches. It never merges.** A link-level union of two farms is
unsafe. `link_tree` keeps the first link on a collision (`provision.py:296-308`).
Thus a union of two farms that pin different versions of one distribution gives an
environment that no resolver validated. The rejected alternative is a
`store use --merge`. It would produce a farm whose lock file describes neither
input.

**Refuse a switch while the harness runtime is live, with the lock that exists.**
The provisioner carries a lease mechanism (`add_lease`, `drop_lease`,
`active_leases`), and `flip_current` refuses under an active lease. Nothing in
`cli/` or in `harness/` ever calls it, thus the refusal never fires in production.
The rejected alternative is to wire the leases. It needs a lease at each sandbox
start, and a matching drop on each exit path, a crash included.

The signal that exists is simpler, and it is already correct. The harness runtime
holds a machine-wide instance lock for its whole life
(`src/modules/harness/runtime.ts:370,716`, key `harness-runtime`). A sandbox can
exist only under a live runtime, thus the held lock is a sound guard. A `--force`
option covers a lock that a killed process left behind.

`--force` bypasses the live-runtime refusal, and it bypasses nothing else. It does
not bypass the download refusal, the farm-shape refusal, or the dot-prefix
refusal. Those three protect the pointer itself. A forced pointer that no sandbox
can mount trades a clear refusal for a broken store, thus `--force` never writes
one.

**Give `store use` the `approval` policy.** It writes `current`, which changes
what every later sandbox mounts. The `agent-command-policy` rule is that a command
which writes anything is `approval`. `store ls` stays `auto`, and it gains no flag,
because a new option on an `auto` command is unsafe until the user says otherwise.

**Refuse a farm that the harness would not mount.** `store use` applies the same
shape that `libStoreUsable` applies: a directory that holds `packages.txt` and
`meta.json`. The CLI does not do the mount test again for a sandbox launch, where
the harness owns it. It applies the shape here because the refusal is the point of
the command. A refusal before the write is better than a broken pointer. A
dot-prefixed name is refused too, because it names staging debris or a superseded
farm.

**Refuse a switch while a download is in flight.** `inspectLibStoreDownload`
reports `incomplete` when a staging tree exists. A merge into the store root can
add a farm while the switch runs, thus the two must not overlap.

**Fail the inventory rather than fall back.** The rule stays "the inventory
describes what the sandbox will mount". One mount source remains, thus an
unreadable inventory has no second source. The CLI reports the store as the
fault, names the remedy, and the gate refuses the sandbox action.

**Suggest `store use` after a download that added a farm.** The download reports
`farmsAdded`, `farmsKept`, and `currentSet`. When it added a farm and it did not
set `current`, the CLI names the farm and the command. It never switches by
itself, because a switch changes what every later sandbox mounts.

## Risks / Trade-offs

- **A user with a working baked image loses it** → the image carries no R library
  and no Python library after the harness change. The store download covers the
  same set. The conda tools and the Node packages stay in the image.
- **The first run now needs two downloads** → the sandbox image drops from
  11.4 GB. It keeps the conda track and the Node track, and the store carries the R
  packages and the Python packages. The gate holds one time, with a visible state,
  and the app opens at once.
- **A stale `harness-runtime` lock blocks a switch** → the lock file records the
  holder pid, and `acquireInstanceLock` reclaims a lock whose holder is dead.
  `--force` covers the case that survives that check.
- **The `--force` option switches under a live sandbox** → a live container keeps
  its own resolved mount. A re-point breaks its view of `/mnt/libs/current`, and
  the command names that risk before it writes.
- **`harness.libStore` and `harness.provisionerImage` stay in a user file** → an
  unknown key is inert. The configuration reader reports the removed keys one time,
  so a user can clean the file.
- **CI for this subsystem is red until the harness releases** → the documented
  shape of a change across the two subsystems.

## Migration Plan

1. Add the two image constants, and pull the provisioner image in `inflexa setup`.
2. Add `store use`, its guards, and the richer `store ls` output.
3. Remove the `libStore` switch and the `provisionerImage` key. Pass the store
   root unconditionally, and drop the `disabled` phase from the gate.
4. Replace the inventory fallback with a reported failure.
5. Remove the variant surface from `sandbox pull`, from `setup`, and from
   `images.ts`.

Steps 1 and 2 are additive, and they land before the removals. A rollback of steps
3 to 5 restores the switch, but it does not restore a usable baked image, because
the harness change already retired it.

## Open Questions

- What value grammar does `--sandbox` take, now that there is no variant? The
  options are a flag with no value, or a boolean value. The tasks mark it
  `BLOCKED`.
- Does an update of the store remove the old store version, or keep it until no
  farm names it? This question stays open from the download change.
