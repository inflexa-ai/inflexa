# Spike harvest: the `cli/` subsystem

This document reports what the code does at two states. "Main today" is the
working repo at `origin/main`. "Spike HEAD" is PR #291
(`origin/feat/two-container-package-store`). A reference with the `spike:`
prefix points into the spike worktree. Every other reference points into main.

## 1. Farm lifecycle

### Main today

Main has no farm. The sandbox image bakes the library store at
`/mnt/libs/current` inside the image (`cli/src/modules/libs/images.ts:9-11`,
`cli/src/modules/harness/runtime.ts:936-940`). The CLI makes no `/mnt/libs`
bind mount (`cli/openspec/specs/lib-store-provisioning/spec.md:94-102`). No
command makes, extends, or removes a per-analysis library set.

### Spike HEAD

The store root is `env.libStoreDir` = `<dataDir>/inflexa/lib-store`
(`spike:cli/src/lib/env.ts:281`). It holds one content-addressed pool
`store/`, one farm for each analysis under `farms/<analysisId>`, a template
farm `farms/catalog`, and a graph `deps.json`
(`spike:cli/src/modules/libs/composition.ts:41-64`).

- The CLI makes the farm WITH the analysis. `startNewTarget` and
  `resolveNewTarget` call `makeAnalysisFarm` after `createAnalysis`
  (`spike:cli/src/modules/analysis/launch.ts:76`, `:117-118` and
  `spike:cli/src/modules/analysis/analysis.ts:271-277`). A farm failure never
  fails the creation.
- A new farm is EMPTY. `makeEmptyFarm` writes the three markers
  (`packages.txt`, `meta.json`, `lock.json`) and links no package
  (`spike:cli/src/modules/libs/composition.ts:1323-1345`).
- The harness farm provider heals a missing farm at the first sandbox action.
  It makes an empty farm on a miss
  (`spike:cli/src/modules/harness/runtime.ts:321-337`), wired as
  `farmSource: { kind: "per-analysis" }`
  (`spike:cli/src/modules/harness/runtime.ts:1046-1049`).
- Three parties extend a farm:
  - The user, with `inflexa store add --analysis` (acquire, then extend:
    `spike:cli/src/modules/libs/store.ts:914-941`, `:960-985`) and
    `inflexa store link` (`spike:cli/src/modules/libs/store.ts:1013-1056`).
  - The plan, at `inflexa run --plan`: `linkPlanPackages` links the packages
    that each step names, before the boot
    (`spike:cli/src/modules/harness/run.ts:408-446`, `:634-639`).
  - The execution agent, with the `link_packages` tool through the
    `extendAnalysisFarm` seam
    (`spike:cli/src/modules/harness/runtime.ts:450-499`, `:1141-1146`).
- A farm dies with its analysis. The TUI delete flow calls
  `removeAnalysisFarm` (`spike:cli/src/tui/commands.tsx:1055`). The reclaim
  reaps a farm whose analysis the database no longer holds
  (`spike:cli/src/modules/libs/store.ts:509-535`). A removal refuses while a
  sandbox lease holds the farm
  (`spike:cli/src/modules/libs/composition.ts:1401-1441`).

## 2. Linking

### Main today

There is no link path. The store is baked into the image, thus nothing lands
on disk (`cli/src/modules/libs/pull.ts:13-17`).

### Spike HEAD

- The command is `inflexa store link <packages...> --analysis <ref>`
  (`spike:cli/src/cli/index.ts:874`,
  `spike:cli/src/modules/libs/store.ts:1013-1056`). It starts no container
  and opens no network connection. The seam route (`link_packages`) and the
  plan route call the same `extendFarm`.
- Resolution: `resolvePackageRequest` searches the graph `byName` index,
  Python track first, newest first (`spike:cli/src/modules/libs/composition.ts:567-618`).
  Only `name` and `name==version` are permitted
  (`spike:cli/src/modules/libs/composition.ts:137-143`).
- Transitive dependencies: `closureOf` walks the resolved edges of
  `deps.json` with a stack. It is a lookup, never a resolution, and it
  refuses an unknown root or a dangling edge
  (`spike:cli/src/modules/libs/composition.ts:419-483`).
- What lands on disk: one symbolic link for each top-level entry of each
  store directory, into `farms/<id>/python/site-packages`. Each link bakes an
  absolute target under `/mnt/libs/store/...`
  (`spike:cli/src/modules/libs/composition.ts:629-631`, `:753-811`). A shared
  namespace promotes to a real directory with links beneath it
  (`:777-782`). R links land at `r/<subtree>/<rDir>` (`:1115-1123`). Warm
  caches link into the template farm (`:1127-1134`). Console scripts hoist to
  `python/bin` as relative links (`:1169-1193`). The markers are written last
  (`:1014-1059`).
- The pass plans against an overlay first and writes second. A version
  collision of one distribution refuses the whole batch, and the farm stays
  as it was (`spike:cli/src/modules/libs/composition.ts:24-28`, `:669-676`,
  `:1138`).

## 3. The `current` pointer and concurrency

### Main today

The `current` pointer is a path INSIDE the image (`/mnt/libs/current`). The
CLI never writes it and never mounts through it — there is no host store and
no bind mount (`cli/src/modules/harness/runtime.ts:936-940`,
`cli/src/modules/libs/images.ts:9-11`). The only machine-wide serializer is
the harness runtime lock, one DBOS engine for each machine
(`cli/src/modules/harness/runtime.ts:460`, `:791-795`).

### Spike HEAD

No pointer selects a farm, and each analysis gets its own farm concurrently.
The proof:

- The mount seam is per analysis:
  `farmSource: { kind: "per-analysis", resolve: ... }`
  (`spike:cli/src/modules/harness/runtime.ts:1049`). The store root itself
  passes as `libStorePath` for every sandbox
  (`spike:cli/src/modules/harness/runtime.ts:1045`).
- The per-farm mutex key is `farm-<analysisId>`
  (`spike:cli/src/modules/libs/composition.ts:173`, `:1251`). Two
  compositions of two different farms hold two different keys, thus they run
  at the same time (`spike:cli/src/modules/libs/composition.ts:1219-1221`).
  The in-process `farmQueue` chain serializes only callers of ONE key
  (`spike:cli/src/modules/libs/composition.ts:194`, `:1253-1298`).
- The legacy pointer is dead code that gets removed. Every store command
  calls `removeStaleActiveFarmPointer`, which deletes a `current` symlink at
  the store root (`spike:cli/src/modules/libs/store.ts:97-103`, `:349-358`).
  The download merge never moves a staged `current` in
  (`spike:cli/src/modules/libs/store_download.ts:89-93`, `:763`).

Serialization that DOES exist, none of it farm-against-farm:

- One detached catalog downloader for each machine, through the
  `lib-store-download` lock (`spike:cli/src/lib/lock.ts:46`,
  `spike:cli/src/modules/libs/store_download.ts:1235-1236`).
- One reclamation at a time, exclusive against live flights and live
  compositions (`spike:cli/src/modules/libs/store.ts:464-492`, `:550-571`).
- One writer of `deps.json` at a time, through the `lib-store-metadata` lock
  (`spike:cli/src/lib/lock.ts:65`,
  `spike:cli/src/modules/libs/store_download.ts:692-710`).
- One acquisition flight for each normalized spec, and at most 2 flights at
  one time by default (`spike:cli/src/modules/libs/store_flight.ts:150`,
  `:273-341`). The cap is `store.flightConcurrency`
  (`spike:cli/src/lib/config.ts:42-49`).
- One harness runtime for each machine, unchanged from main
  (`spike:cli/src/modules/harness/runtime.ts:907`,
  `spike:cli/src/lib/lock.ts:35`).

## 4. Setup flow

### Main today

The sandbox-image step is the LAST setup step, after the reference data
(`cli/src/modules/infra/setup.ts:640-645`). It runs `sandboxPull` in the
foreground, with a variant prompt and a size confirmation
(`cli/src/modules/infra/setup.ts:677-700`,
`cli/src/modules/libs/pull.ts:165-228`). Nothing is detached, and no state
file records the transfer. The launch preamble also pulls the image on normal
stdio, before the TUI renders (`cli/src/tui/app.launch.tsx:49`,
`cli/src/modules/libs/pull.ts:125-154`). The TUI reports no download.

### Spike HEAD

The bundle step is still the last setup step
(`spike:cli/src/modules/infra/setup.ts:640-646`). Inside that step:

- ONE consent covers three transfers: the runtime image, the provisioner
  image, and the package catalog
  (`spike:cli/src/modules/infra/setup.ts:660-742`).
- The catalog downloader starts FIRST and DETACHED, then the two image pulls
  run in the foreground (`spike:cli/src/modules/infra/setup.ts:744-768`).
  Setup exits without a wait on the catalog
  (`spike:cli/src/modules/infra/setup.ts:682-684`).
- The child is a re-invocation of the CLI with the hidden `--run-transfer`
  flag, spawned with ignored stdio and `.unref()`
  (`spike:cli/src/modules/libs/store_download.ts:1064-1066`, `:1115`,
  `:1132`, `:1141-1145`).
- Lifecycle: one row in `lib_store_downloads` records the state, the byte
  totals, and the failure message
  (`spike:cli/src/db/primary_migrations.ts:200-221`). The `lib-store-download`
  lock gives liveness — a `running` row with no live holder reads as `failed`
  (`spike:cli/src/modules/libs/store_download.ts:1039-1050`). The receipt on
  disk, written last, is the truth of what the store holds (`:869-880`,
  `:981-990`).
- Resume: verified blobs stay in a digest-keyed cache, thus a retry does not
  fetch bytes it holds (`spike:cli/src/modules/libs/store_download.ts:454-464`).
  A failed run drops the staged tree and keeps the blob cache (`:1283-1291`).
  A disk-full failure names the bytes needed and the bytes free (`:1207-1215`).
- TUI report: `watchLibStoreDownload` polls the row every 2 seconds
  (`spike:cli/src/tui/hooks/sandbox_gate.tsx:210`, `:391-395` and
  `spike:cli/src/tui/app.tsx:508`). The sidebar PACKAGES section renders the
  state line, a 20-cell transfer meter, and one line for each live flight
  (`spike:cli/src/tui/layout/sidebar.tsx:96-166`, `:845`).
- A second setup never blocks on a live transfer. It reports the run and
  opens no second consent (`spike:cli/src/modules/infra/setup.ts:695-707`,
  `:719-724`). A decline writes the `declined` state, thus the app asks
  nothing at open (`spike:cli/src/modules/infra/setup.ts:726-733`).

## 5. Gating

### Main today

The gate is the image only, and it blocks the terminal. `ensureSandboxImage`
confirms and pulls in the foreground before any command that stages
(`cli/src/modules/libs/pull.ts:110-154`), and the chat launcher runs it before
`render()` (`cli/src/tui/app.launch.tsx:44-49`). During a pull the user does
nothing else in that terminal.

### Spike HEAD

The app opens at once, and only a sandbox-making action waits:

- `awaitSandboxReady` holds an action on three checks in order: the store,
  the last farm-composition failure, then the image
  (`spike:cli/src/tui/hooks/sandbox_gate.tsx:468-473`).
- While the download runs, the store flow polls and holds. A terminal state
  (`failed`, `declined`, `canceled`, `absent`) refuses and names
  `inflexa store download` as the retry
  (`spike:cli/src/tui/hooks/sandbox_gate.tsx:358-370`, `:327-344`). The gate
  starts no download and opens no consent for the catalog (`:33-39`).
- The FILESYSTEM decides usability: a valid receipt plus a pool inventory
  (`spike:cli/src/tui/hooks/sandbox_gate.tsx:267-277`,
  `spike:cli/src/modules/libs/packages.ts:101-118`).
- Chat, the workspace read surface, and the planner work during the
  transfer (`spike:cli/src/modules/harness/runtime.ts:873-878` and
  `spike:cli/openspec/specs/lib-store-download/spec.md:115-160`). A profile
  drive of an analysis with no inputs skips the gate
  (`spike:cli/src/tui/hooks/profile_parity.ts:452-470`).
- The dev commands refuse in the terminal instead: `inflexa run` and
  `inflexa profile` fail on a store with no readable pool inventory
  (`spike:cli/src/modules/harness/profile.ts:136-148` and
  `spike:cli/src/modules/harness/run.ts:621`) and still pull the image
  in the foreground (`spike:cli/src/modules/harness/run.ts:641`).
- `inflexa store add` refuses while the download merges
  (`spike:cli/src/modules/libs/store.ts:371-382`). A new flight and a new
  composition wait on a live reclamation
  (`spike:cli/src/modules/libs/store_flight.ts:344-356`,
  `spike:cli/src/modules/libs/composition.ts:1256-1275`).

## 6. Re-download and refresh

### Main today

`inflexa sandbox pull` re-pulls a moving `:latest` even when present, thus it
is the upgrade path (`cli/src/modules/libs/pull.ts:159-217`). A pinned ref
that is present short-circuits to `up_to_date` (`:195-199`). No code removes
an old image, and there are no OCI packages, thus there is no merge.

### Spike HEAD

- Images: `inflexa sandbox pull` keeps the same moving-tag refresh
  (`spike:cli/src/modules/libs/pull.ts:117-138`). `inflexa sandbox remove`
  removes the runtime image and the provisioner image, and it touches no
  store and no farm (`spike:cli/src/modules/libs/pull.ts:216-260`). The
  policy is `blocked` for the agent (`spike:cli/src/cli/index.ts:819`).
- Catalog: `inflexa store download` over a valid receipt resolves the
  manifest and transfers nothing. A moved tag reports `update_available`, and
  `--update` is the consent that applies it
  (`spike:cli/src/modules/libs/store_download.ts:953-960`, `:1095-1108`).
- Merge behavior (`mergeStagedRoot`,
  `spike:cli/src/modules/libs/store_download.ts:755-796`):
  - `store/` merges one level deep. A name that both sides hold is skipped,
    because the store is content-addressed and the same name is the same
    bytes (`:664-678`).
  - `farms/` merges one level deep, and an existing farm is KEPT. The
    download never replaces a farm of the user (`:778-782`).
  - `deps.json` moves in only when the root has none. On `--update` the new
    graph REPLACES the old one, under the metadata lock, because two graphs
    must not merge (`:713-733`, `:976-978`).
  - Any other top-level entry moves in only when absent (`:789-790`). A
    staged `current` never moves in (`:763`).
  - The merge removes nothing. Old versions stay until `inflexa store
    reclaim` frees the unreferenced ones
    (`spike:cli/src/modules/libs/store.ts:262-269`, `:464-492`).

## 7. Specs

### Main today

The one spec is `cli/openspec/specs/lib-store-provisioning/spec.md`. It
states four requirements (`:6-114`). Setup provisions the image through the
`sandbox pull` handler. The user picks a variant (`python` | `python-r`). A
re-pull of a present tag is a no-op. The image bakes the store at
`/mnt/libs/current`, and the CLI makes no bind mount.

### Spike HEAD

The synced specs tree adds three capabilities and rewrites two:

- `spike:cli/openspec/specs/lib-store-download/spec.md` (new): the CLI pulls
  the store from GHCR as a digest-pinned OCI artifact. The download runs as a
  detached process, and the receipt is written last. Each sandbox-making
  action waits on a complete store. The gate starts no download, opens no
  consent, and has no state in which it passes without a store (`:11-160`).
- `spike:cli/openspec/specs/lib-store-download-process/spec.md` (new): the
  lifecycle of the detached process. It states six states and one database
  row for the progress. The instance lock is the liveness signal, and one
  downloader runs at a time. `inflexa store download` and `inflexa store
  cancel` are the command surface, and the sidebar shows the meter
  (`:20-375`).
- `spike:cli/openspec/specs/package-store-management/spec.md` (new): the
  `inflexa store` family. Provisioning is an explicit and consented action,
  and the provisioner image is a code constant. Only an install starts the
  container. The store is inspectable and reclaimable, and `add` refuses
  during a live download (`:11-440`). NOTE: this synced tree still states
  `inflexa store use <farm>` switches the active farm (`:216-240`). The code
  has no such command. The removal exists only as a REMOVED delta in the
  active change `per-analysis-farms`
  (`spike:cli/openspec/changes/per-analysis-farms/specs/package-store-management/spec.md:277-286`).
- `spike:cli/openspec/specs/lib-store-provisioning/spec.md` (rewritten): one
  published runtime image, no variant, `sandbox remove` removes the two
  images, and the inventory describes what the sandbox mounts (`:21-269`).
- `spike:cli/openspec/specs/setup-answers/spec.md` (modified): `--sandbox` is
  a bare flag, and the answer is the consent for one bundle of three
  transfers. No answer refuses only the catalog. A second setup never blocks
  on a live download (`:186-330`).
- `spike:cli/openspec/specs/chat-wiring/spec.md` (modified): the interactive
  image gate leaves the launch preamble. The app renders at once, and the
  wait surfaces at the first sandbox action (`:39-60`).

Active, unsynced changes under `spike:cli/openspec/changes/`:

- `detached-store-download-lifecycle` — implemented, 2 of 109 tasks open
  (two lifecycle tests, `tasks.md:96-97`).
- `mandatory-store-and-farm-switch` — implemented, 57 of 57 tasks done.
- `per-analysis-farms` — implemented, 65 of 65 tasks done. It adds the
  `farm-composition` capability
  (`spike:.../per-analysis-farms/specs/farm-composition/spec.md:5-169`). A
  farm is composed per analysis from the pool. It is made empty with its
  analysis, it extends additively under a live sandbox, and it dies with its
  analysis.
- `per-analysis-warm-caches` — NOT implemented, 0 of 17 tasks done. It
  removes the template-linked warm caches and adds a per-analysis seeded
  cache at `farm-caches/<analysisId>`
  (`spike:.../per-analysis-warm-caches/specs/farm-composition/spec.md:5-51`).
  The code still links the caches from the template
  (`spike:cli/src/modules/libs/composition.ts:96`, `:1127-1134`).

The spike also adds two archived changes, `2026-08-06-lib-store-download` and
`2026-08-06-lib-store-mount-and-provisioning`
(`spike:cli/openspec/changes/archive/`).

## 8. Instance lock and event bus

### Main today

The libs module takes no lock and emits no bus event. The one related lock is
the harness runtime sentinel (`cli/src/modules/harness/runtime.ts:460`,
`:791`).

### Spike HEAD

The store work leans on the instance-lock family, and it never touches the
bus:

- Three new sentinel keys in `spike:cli/src/lib/lock.ts`:
  `lib-store-download` (`:46`), `lib-store-reclaim` (`:55`), and
  `lib-store-metadata` (`:65`). The per-farm mutex mints
  `farm-<analysisId>` keys (`spike:cli/src/modules/libs/composition.ts:173`).
- A new lock API, `liveInstanceLockHolds(prefix)`, lets the reclamation
  enumerate the live compositions (`spike:cli/src/lib/lock.ts:190` and
  `spike:cli/src/modules/libs/store.ts:550-571`).
- The harness runtime key moved into `lib/lock.ts` as
  `HARNESS_RUNTIME_LOCK_KEY` (`spike:cli/src/lib/lock.ts:35`), with the same
  one-engine role (`spike:cli/src/modules/harness/runtime.ts:907`).
- The event bus carries no store event. `src/types/events.ts` gains no store
  member. The detached child reports through database rows, and the TUI reads
  them with polls (`spike:cli/src/tui/hooks/sandbox_gate.tsx:203-210`,
  `:385-395`, and `spike:cli/src/modules/libs/store_flight.ts:153-159`). The
  choice is deliberate: the writer is a different process, thus the
  in-process bus cannot carry it.
