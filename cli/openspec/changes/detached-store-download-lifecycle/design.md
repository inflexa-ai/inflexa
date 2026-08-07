## Context

The store is mandatory after `mandatory-store-and-farm-switch`. No runtime image
bakes a library, thus a fresh machine pulls a multi-gigabyte catalog before any
sandbox runs.

That change puts the download at app open, inside the app process
(`src/tui/hooks/sandbox_gate.tsx`). It also makes an unreadable store inventory a
boot failure (`src/modules/harness/runtime.ts:644`). The two together kill chat on
a fresh machine: the boot fails before the download can finish, and nothing boots
again.

The pieces that this design needs already exist. `src/db/primary.ts:17` sets
`journal_mode = WAL`, and `:19` sets `busy_timeout = 5000`, thus two processes
share the database. `acquireInstanceLock` (`src/lib/lock.ts:76`) is pid-aware, and
it reclaims a lock whose holder is dead. `src/lib/open_external.ts:69` shows the
detached spawn pattern, which is `Bun.spawn(...).unref()`.

## Goals / Non-Goals

**Goals:**

- The app opens at once, and chat answers with no store.
- The transfer survives the exit of the command that started it.
- A second process reads the progress and reports it.
- A dead downloader reads as failed, and it never reads as live.
- A user retries the download, and the agent retries it after an approval.

**Non-Goals:**

- What the catalog holds. `lib-store-download` keeps the pull and the merge.
- The farm-subset download, and the retention of an old store version.
- A resume of a part-transferred layer. A retry starts the layer again.
- A second downloader for a second store root. There is one store root.

## Decisions

**Split the two records, and give each one job.** The receipt on disk stays the
truth of what the store holds. The database row is the truth of what the process
does now.

The reason is that a store root can arrive by a route that wrote no row. A manual
ORAS pull writes one. `inflexa store add` writes one. If the database were the
truth, each such store would read as absent, and the gate would refuse a store
that works.

The rejected alternative is one record in the database. It makes the database the
authority over the filesystem, and the filesystem is what the harness mounts.

**Five states, and only a retry leaves a terminal one.** The states are `pending`,
`running`, `installed`, `failed`, and `declined`. `declined` records a setup
answer of no, thus a user who refused is not asked again at each app open.

The rejected alternative is a `consent` state that the app opens. The consent
moves into setup with this change, thus the app asks nothing.

**Take the liveness from the instance lock, not from a heartbeat.** The downloader
holds the key `lib-store-download` for its whole life. A row that reports
`running` with no live holder reads as `failed`.

A killed process writes no `failed` row. Thus the row alone can report `running`
for ever, and the sidebar shows a frozen bar. A heartbeat closes that hole, but it
adds a timer, a stale threshold, and a clock assumption. `acquireInstanceLock`
already tests the holder pid, thus the answer costs one file read.

The probe must be read-only. A reader that took the lock would refuse the next
real downloader. Thus this change adds a probe beside `acquireInstanceLock`, and it
reuses `instanceLockPath`.

**The lock gives single-flight for free.** Setup starts one downloader. The app
finds the lock held, thus it starts none. No separate guard is necessary.

**Setup starts the process, and the app never does.** The app is a reader. This is
the whole point of the detachment: a transfer that the app owns dies with the app.

**The `--sandbox` answer consents to the catalog too.** That answer is already
"the multi-GB consent" in `setup-answers`. The catalog is the third multi-gigabyte
transfer that setup starts, beside the two images. One answer covers each of them,
thus the user answers one question about size.

**The harness boot no longer depends on the store.** `runtime.ts:644` returns
`lib_store_unusable`, and `boot.ts:81` turns that into `phase: "failed"`. Then
`app.tsx:962` reads `ready` as false and drops each submit with no message.

The `lib-store-provisioning` delta already states the correct rule: an unreadable
inventory "SHALL let the sandbox gate refuse the action". Task 4.2 of the other
change says "boot failure" instead, and the implementation obeyed the task. The
task is what is wrong.

The gate at `sandbox_gate.tsx:195-206` already refuses each sandbox action. Thus
the boot needs no refusal of its own, and one refusal in one place is correct.
`inflexa profile` and `inflexa run` keep their own refusal, because each one makes
a sandbox at once.

**Give `store download` the `approval` policy.** It writes the store root. The
`agent-command-policy` rule is that a command which writes anything is `approval`.
Thus the agent can retry the download, and the user confirms it in chat.

`store ls` reports the state, and it stays `auto` with no new option. A new option
on an `auto` command is unsafe until the user says otherwise.

## Risks / Trade-offs

- **A detached process leaves no terminal to report a fault** → the row carries the
  message, and `store ls` and the sidebar both report it.
- **The row and the receipt disagree** → the receipt wins at every decision about
  usability. The row decides nothing about a sandbox.
- **A user kills the downloader** → the lock probe reports the dead holder, thus
  the state reads as `failed` and the gate offers a retry.
- **Two store roots** → out of scope. The CLI owns one store root, and the lock key
  names the downloader, not the root.
- **A partly transferred layer costs a full retry** → the blob cache at the staging
  path already keeps a completed layer. A retry re-fetches the layer that stopped.
- **The database file is on the machine of the user** → a deleted database loses the
  progress record, not the store. The receipt survives, thus the store stays usable.

## Migration Plan

1. Add the table, the read, and the write. Nothing reads the row yet.
2. Add the lock hold and the read-only probe.
3. Add `inflexa store download`, and register it with the `approval` policy.
4. Start the detached process from `inflexa setup`.
5. Make the sidebar and `store ls` report the row.
6. Remove the app-open trigger, and make the harness boot non-fatal for the store.

Step 6 lands last, because it is the step that changes what a user sees. A
rollback of step 6 restores the app-open trigger, and the detached path keeps
working beside it.

## Open Questions

- Does the sidebar report the transfer as a bar, or as a line of text? The design
  gallery owns that answer, and this change does not decide it.
- What does the downloader do when the app and setup both run on one machine, and
  the user starts a second `inflexa setup`? The lock refuses the second start, and
  the second setup reports the live run. Confirm that this is the wanted behavior.
