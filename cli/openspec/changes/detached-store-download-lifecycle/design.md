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

**Six states, and only a retry leaves a terminal one.** The states are `pending`,
`running`, `installed`, `failed`, `declined`, and `canceled`. `declined` records a
setup answer of no, thus a user who refused is not asked again at each app open.

`canceled` records a transfer that started and that the user stopped. The
difference from `declined` is load-bearing. A canceled run leaves a partial staged
tree, and the CLI removes that tree. A declined run never wrote one.

The two new transitions are `running` to `canceled`, and `canceled` to `pending`
on a retry. `canceled` is terminal, and only a retry leaves it.

At the gate the two states behave alike. Each one refuses the sandbox action, each
one names the retry, and neither one opens a consent. The state names the reason,
and the cleanup obeys the state.

The rejected alternative is one `declined` state for both answers. Then the
cleanup path cannot know whether a staged tree exists. It would stat the staging
path at each read, and a stale tree from a killed run would read the same.

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

**The `--sandbox` answer consents to one bundle.** Setup lists the runtime image,
the provisioner image, and the catalog in one message. The user answers one time.

No answer takes the two images and refuses the catalog. The store is mandatory,
thus such an answer would give a sandbox that imports nothing. The bundle is not a
convenience, and it is the only combination that works.

Setup starts the detached downloader when it starts the image pulls. Thus the
catalog transfers while the images pull. Setup exits when the images finish, and
the catalog continues.

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
on an `auto` command is unsafe until the user says otherwise. That listing is also
the readiness readout of the agent, thus this change adds no command and no tool
for it.

**The cancel is a command, and it is a subcommand.** `inflexa store cancel` stops
the live transfer, it records `canceled`, and it removes the partial staged tree.

The process is detached, thus it outlives both setup and the app. A prompt lives
in one terminal, and that terminal can close while the transfer continues. A
command reaches the process from anywhere. Setup opens no prompt for the cancel,
and it only names the command.

With no live run, the command reports that fact and changes nothing. It writes no
row, and it removes no tree. A cancel of nothing is not a failure.

The cancel is a subcommand and not a flag on `store download`. `AgentPolicy`
(`src/cli/agent_policy.ts:19-20`) binds one policy to one command, and `safeFlags`
exists for `auto` only. Thus a flag cannot be `blocked` while its command stays
`approval`. `cli/CLAUDE.md` states the same rule: an option must never change the
effect class of a command.

`--update` stays a flag on `store download`. The flag and the base command both
write the store root, and both take `approval`, thus one policy covers the two.

**The cancel takes the `blocked` policy.** The mandatory reason is that the cancel
throws away a transfer that is part done. The agent names the command, and the
user runs it.

**The image removal joins the `sandbox` family.** `inflexa sandbox remove` removes
the runtime image and the provisioner image. It sits beside `inflexa sandbox pull`
and `inflexa sandbox status`, because `lib-store-provisioning` owns the image
surface.

The command reports what it removed. An absent image is a normal condition, thus
the command reports the absence and refuses nothing. It touches no store and no
farm, because the images and the catalog are separate artifacts.

**The image removal takes the `blocked` policy.** The mandatory reason is that the
removal destroys a multi-gigabyte artifact that a user waited for. A later
`inflexa sandbox pull` transfers that artifact a second time.

**A second `inflexa setup` never blocks.** Setup does many things, for example the
references, the database, and the model configuration. A live catalog download
blocks none of them.

At its store step, a second setup opens no consent. The first answer stands, thus
setup asks that question one time only.

The store step reports the live transfer with its state and its byte totals. It
names `inflexa store cancel`, and it names `inflexa sandbox remove`. Then setup
continues to the remaining steps. The lock refuses a second downloader, thus the
second setup starts no process and it is a reader at that step.

The rejected alternative is a wait at the store step. A multi-gigabyte transfer
would then hold the database step and the model step. A user who ran setup to fix
a model could not reach that step.

**The sidebar carries the meter, and the gate hold text does not.** The sidebar
reports the transfer with the run meter glyph, which is `GLYPHS.bar` (U+25AE). The
filled cells take the `success` role, and the empty cells take the `fgSubtle` role.

`run_card_block.tsx:68-69` states the rule: two surfaces must not show one figure.
The rail already owns the meter for a run, and the panel beside it stays bare text.
The download obeys the same split, thus the gate hold text gives no percentage.

The rejected alternative is a meter at the gate too. It shows one figure two times,
and it makes each surface read as a separate widget over one transfer.

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
3. Add `inflexa store download` with `--update`, and register it with the
   `approval` policy.
4. Add `inflexa store cancel` and `inflexa sandbox remove`, each with the `blocked`
   policy and its reason. Update the policy snapshot.
5. Start the detached process from `inflexa setup`, and report a live run at a
   second setup.
6. Make the sidebar and `store ls` report the row.
7. Remove the app-open trigger, and make the harness boot non-fatal for the store.

Step 7 lands last, because it is the step that changes what a user sees. A
rollback of step 7 restores the app-open trigger, and the detached path keeps
working beside it.

## Open Questions

None. The second-setup question is resolved, and the Decisions record the answer.
