## Why

The store is mandatory, and no runtime image bakes a library. Thus a fresh machine
must pull a multi-gigabyte catalog before any sandbox can run.

The download lives inside the app process today, and it starts at app open. Three
faults come from that shape:

- The download dies with the app. A user who quits loses the transfer.
- The download keeps no record that a second process can read. Thus nothing
  reports the progress, and nothing can retry the transfer from outside the app.
- The harness boot starts at the same moment, and it treats an absent store as a
  boot failure. Thus chat dies on the machine where the download is most
  necessary.

The user must have the app at once. Chat, the workspace read surface, and the
planner use no package, thus they must answer while the catalog arrives.

## What Changes

- **The download becomes a detached process with a lifecycle.** `inflexa setup`
  starts it. The process outlives the command that started it, and it runs to
  completion on its own.
- **The lifecycle state goes into the database.** One row records the state, the
  byte totals, and the identity of the holder. The terminal reads that row, thus
  the sidebar reports the progress.
- **The receipt on disk stays the truth of what is installed.** The database row
  is the truth of what the process does now. The two records never merge.
- **Liveness comes from the instance lock that exists.** The downloader holds the
  `lib-store-download` key for its whole life. A `running` row with no live holder
  reads as `failed`. No heartbeat, and no clock assumption.
- **The lock gives single-flight.** Setup starts one downloader. The app finds the
  lock held, thus it starts none and it only reads the row.
- **New command `inflexa store download`.** It starts a run, or it reports the run
  that is live. `--update` is the consent to apply a moved tag. Its policy is
  `approval`, thus the conversation agent can retry the download after the user
  confirms.
- **The lifecycle takes a sixth state, which is `canceled`.** It records a transfer
  that started and that the user stopped. `declined` records a consent of no that
  started nothing. A canceled run leaves a partial staged tree, and the CLI removes
  that tree.
- **New command `inflexa store cancel`.** It stops the live transfer, it records
  `canceled`, and it removes the partial staged tree. Its policy is `blocked`,
  because the cancel throws away a transfer that is part done.
- **New command `inflexa sandbox remove`.** It removes the runtime image and the
  provisioner image, and it reports what it removed. It touches no store and no
  farm. Its policy is `blocked`, because the removal destroys a multi-gigabyte
  artifact that a user waited for.
- **A second `inflexa setup` never blocks.** Its store step opens no consent,
  reports the live transfer, names the two commands above, and continues to the
  remaining steps.
- **BREAKING** — the app no longer starts a download. `startLibStoreDownload` and
  its app-open trigger retire.
- **The harness boot no longer depends on the store.** An absent or unreadable
  store makes no boot failure. The sandbox gate owns the refusal, which it already
  does.
- **The `--sandbox` answer consents to one bundle.** That bundle is the runtime
  image, the provisioner image, and the catalog. The store is mandatory, thus no
  answer takes the two images and refuses the catalog.
- **`inflexa store add` refuses while a download is live.** The merge moves the
  staged tree into the store root one child at a time. Thus a provisioning run
  during that merge can meet a half-merged root.

## Capabilities

### New Capabilities

- `lib-store-download-process`: the lifecycle of the detached downloader. It
  covers the states, the progress record, the liveness signal, the single-flight
  rule, and the retry surface.

### Modified Capabilities

- `lib-store-download`: the trigger moves from app open to `inflexa setup`. The
  gate reads the process state rather than the receipt alone. The what-is-pulled
  half of this capability does not change. The anonymous GHCR pull stays, each
  blob still matches its sha256 descriptor, and the merge rules stay.
- `lib-store-provisioning`: an unreadable store inventory refuses each sandbox
  action, and it never fails the harness boot. Chat, the workspace read surface,
  and the planner answer with no store. `inflexa sandbox remove` joins the image
  surface, because this capability owns that surface.
- `package-store-management`: `inflexa store download` and `inflexa store cancel`
  join the store command family, and `inflexa store ls` reports the download state.
  `inflexa store add` refuses while a download is live, exactly as `inflexa store
  use` does.
- `setup-answers`: the `--sandbox` answer consents to one bundle, which is the two
  images and the catalog. Setup starts the detached downloader when it starts the
  image pulls. A second setup reports a live transfer and blocks no step.

## Impact

- `src/db/primary_migrations.ts`: one table for the download row.
- `src/db/primary_query.ts` and `src/db/primary_mutation.ts`: the read of the row,
  and the write of the progress.
- `src/modules/libs/store_download.ts`: the transfer keeps its receipt pattern and
  its merge. It gains the progress writes, the lock hold, and the cancel that
  removes the partial staged tree.
- `src/modules/libs/`: the persisted shape of the row colocates with the module,
  because it has one consumer. It does not go in `src/types/`.
- `src/modules/libs/store.ts`: `store download` and `store cancel` join it, `store
  ls` reports the state, and `store add` refuses while a download is live.
- `src/modules/libs/pull.ts`: the image removal joins `sandboxPull` and
  `sandboxStatus`, which are the other two handlers of the `sandbox` family.
- `src/modules/infra/setup.ts`: setup starts the detached process. A second setup
  reports the live run, names the two commands, and waits for nothing.
- `src/lib/lock.ts`: one read-only probe of a lock holder, beside
  `acquireInstanceLock`.
- `src/modules/harness/runtime.ts`: the boot stops treating an absent store as
  fatal.
- `src/tui/hooks/sandbox_gate.tsx`: the gate reads the row. The app-open download
  trigger retires.
- `src/tui/layout/sidebar.tsx`: the progress readout.
- `src/cli/index.ts`: `store download` registers with the `approval` policy.
  `store cancel` and `sandbox remove` each register with the `blocked` policy, and
  each one carries its mandatory reason.
- `src/cli/agent_policy_tree.test.ts`: the snapshot takes the three new grants.
- This change depends on `mandatory-store-and-farm-switch`, which makes the store
  mandatory. It supersedes the app-open trigger that the same change specifies.

Out of scope: the farm-subset download, the retention of an old store version, and
what the catalog contains. `lib-store-download` keeps the pull and the merge.
