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
  that is live. `--force` re-downloads over a receipt that pins the current
  manifest. Its policy is `approval`, thus the conversation agent can retry the
  download after the user confirms.
- **BREAKING** — the app no longer starts a download. `startLibStoreDownload` and
  its app-open trigger retire.
- **The harness boot no longer depends on the store.** An absent or unreadable
  store makes no boot failure. The sandbox gate owns the refusal, which it already
  does.
- **The `--sandbox` answer consents to the catalog too.** One answer covers each
  multi-gigabyte transfer that setup starts, which is the two images and the
  catalog.

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
  and the planner answer with no store.
- `package-store-management`: `inflexa store download` joins the store command
  family, and `inflexa store ls` reports the download state.
- `setup-answers`: the `--sandbox` answer consents to the catalog beside the two
  images, and setup starts the detached downloader.

## Impact

- `src/db/primary_migrations.ts`: one table for the download row.
- `src/db/primary_query.ts` and `src/db/primary_mutation.ts`: the read of the row,
  and the write of the progress.
- `src/modules/libs/store_download.ts`: the transfer keeps its receipt pattern and
  its merge. It gains the progress writes and the lock hold.
- `src/modules/libs/store.ts`: `store download` joins it, and `store ls` reports
  the state.
- `src/modules/infra/setup.ts`: setup starts the detached process.
- `src/lib/lock.ts`: one read-only probe of a lock holder, beside
  `acquireInstanceLock`.
- `src/modules/harness/runtime.ts`: the boot stops treating an absent store as
  fatal.
- `src/tui/hooks/sandbox_gate.tsx`: the gate reads the row. The app-open download
  trigger retires.
- `src/tui/layout/sidebar.tsx`: the progress readout.
- `src/cli/index.ts`: `store download` registers with the `approval` policy.
- This change depends on `mandatory-store-and-farm-switch`, which makes the store
  mandatory. It supersedes the app-open trigger that the same change specifies.

Out of scope: the farm-subset download, the retention of an old store version, and
what the catalog contains. `lib-store-download` keeps the pull and the merge.
