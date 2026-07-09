# harden-chat-turn-and-parity — Proposal

## Why

Review of `feat/chat-integration` found four correctness defects and a set of hardening gaps in the
code that branch introduced. Two of the four were reproduced with failing tests before any fix was
written; the other two are argued from the code and the SQL they coordinate with.

**The chat turn loses user work.**

1. `loadMessages` ends with an unconditional whole-store replacement (`tui/hooks/conversation.ts:617`).
   Its `loadGeneration` token guards load-against-load, but nothing guards load-against-`send`. The
   `Chat` component fires a load the instant `bootState().phase` flips to `ready`
   (`tui/components/chat.tsx:47`) — which is the same instant `handleSubmit`'s gate opens
   (`tui/app.tsx:351`). A user who pre-types during the boot animation (which `ChatBar` invites: the
   textarea stays editable, only submit is gated) and presses enter as it clears has their message and
   the whole in-flight assistant turn deleted, and `currentAssistantId` is left dangling so every
   subsequent part silently no-ops. Reproduced: the store goes 2 messages → 0.

2. `finishTurn`'s `ok` branch writes `outcome.fallbackText` into `streamText` and then calls
   `commitStream()`, which does nothing when `streamPartId()` is `null`
   (`tui/hooks/conversation.ts:422-423`). Any mid-turn `flushPendingText()` — every `tool-started`,
   `tool-finished`, and data part — nulls that id. So a turn that streams prose, runs a tool, then
   produces a delta-less final segment renders the prose and the tool chip and **drops the answer**.
   The branch's comment claims parity with the REPL printer's suppression, but the printer uses a
   sticky per-turn flag (`chat_printer.ts:150`) where this reads the already-emptied buffer.
   Reproduced.

**The profile parity path is unserialized.**

3. `watchProfileParity` wires three fire-and-forget edges into `driveProfileParity`, plus
   `driveForceReprofile` as a fourth entry point, with no in-flight guard. Two overlapping drives both
   call `stageInputs` on the same session tree, and `reconcileStagedTree`
   (`modules/staging/staging.ts:214-220`) deletes every on-disk file absent from *its own* manifest.
   The harness ledger CAS prevents a double workflow dispatch, but it runs after both stagings — so
   one drive can delete files another just linked, and can rm/relink under `data/inputs/` while the
   workflow the other won is already reading it.

4. The same missing serialization lets an empty-branch `clearDataProfile` (which nulls
   `seed_input_file_ids`) land between a concurrent drive's seed and its trigger. The trigger's
   seed-first guard then reads null, returns `"failed"`, and the user gets a
   `Could not start profiling "…"` warning for a benign race — while the ledger sits at "not profiled"
   until the next input event.

**An input's content can change without registering as drift.** `deriveFileId` hashes `anchorId|path`
(`modules/staging/staging.ts:45-48`) and `inputSetMatches` compares fileId sets, so editing an input
file's bytes at the same path fires no `prov.input_*` event *and* reads as `already_profiled`. The
profile silently describes stale content.

**Two robustness gaps and a false safety claim.**

- The sidebar's 5s poll bumps `refreshGeneration` on every tick with no in-flight guard
  (`tui/hooks/sidebar_live.ts:246,343`). If a refresh's two reads outlast the interval, every tick
  supersedes the previous one and *no* refresh ever completes-and-writes — the section freezes and can
  never self-heal out of `unavailable`, while the failing read is reissued every 5s.
- `bun test` from a nested cli directory (`cd cli/src && bun test`) finds no `bunfig.toml` — bun reads
  the cwd only, verified empirically — so no XDG sandbox is established, no `INFLEXA_TEST_SANDBOX`
  marker is stamped, and the root refuse preload never fires. `assertTestSandbox` is described as "the
  SINGLE authorization … one choke point every destructive env-path site funnels through"
  (`test_support/sandbox.ts:3-16`), but only `resetDb` calls it internally; every other site opts in by
  hand. That is the shape of incident 2.
- `scripts/build.ts` never `--define`s `INFLEXA_GIT_COMMIT` (its scanner reads only literal
  `process.env.X` accesses inside the `bakedEnv` block, and the variable is read inside
  `resolveGitCommit()` instead). Baking `INFLEXA_BUILD_CHANNEL=production` — which this branch
  correctly starts doing — therefore arms a **runtime** throw on the first provenance stamp. The
  failure belongs at build time.

## What Changes

- **`send` claims the load token.** A transcript load in flight when a turn starts drops rather than
  writing. The dangling-`currentAssistantId` state becomes unreachable.
- **`finishTurn` mints a streaming segment before committing the fallback**, so a delta-less final
  segment after a mid-turn flush renders instead of vanishing.
- **Parity and force drives serialize** through one in-flight promise, so `stageInputs` never runs
  concurrently on a session tree and a clear can never land between a seed and its trigger.
- **Drift is judged on a `(fileId, size, mtimeMs)` signature**, enumerated at stat cost. An in-place
  content edit re-profiles. Depends on `harness/openspec/changes/harden-data-profile-claim`, which adds
  `StagedInput.mtimeMs` and records `inputFiles` on the completed result.
- **The sidebar poll skips a tick while a refresh is in flight**, so a slow read degrades cadence
  rather than starving the store.
- **The test sandbox is enforced structurally, not by convention.** `env.ts` refuses to resolve real
  XDG paths when `NODE_ENV === "test"` without the sandbox marker, so no test file — from any working
  directory — can touch the developer's home. `assertTestSandbox` keeps its per-site role and gains a
  path-boundary check; its docstring stops overstating what it enforces.
- **The build fails when a `production` build has no `INFLEXA_GIT_COMMIT`**, and the commit is
  explicitly `--define`d so the runtime read is a baked literal. The runtime throw remains as a
  backstop for a hand-rolled build that bypasses `scripts/build.ts`, with a comment that says so
  instead of asserting the branch is dead code.
- Assorted accuracy fixes: `bunfig.toml` and `refuse-root-test.ts` stop citing a `harness/` bunfig
  sandbox that does not exist; `cause.ts` renders `AggregateError.errors`; `staging.ts`'s bare
  `as FsError` and `workspace.ts`'s raw `throw` carry the invariants that make them sound;
  `MESSAGE_CAP`'s ≤ 200 coupling with `loadPage`'s clamp gains a test; `CLAUDE.md` stops calling the
  commander registry "cac".

## Capabilities

### Modified Capabilities

- **`tui-harness-chat`** — the turn/transcript store's concurrency contract.
- **`data-profile-launch`** — parity drives are serialized; drift is signature-based.
- **`input-staging`** — enumeration yields drift signatures; the manifest carries `mtimeMs`.
- **`sidebar-live`** — the bounded poll never overlaps itself.
- **`test-harness`** — the sandbox is structurally enforced.
- **`cli-core`** — a `production` build without a baked commit fails at build time.

## Non-goals

- A serveability probe for models the proxy advertises but cannot serve. `pickDefaultModel` ranks and
  caches; a dead advertised `claude-*` id still fails on the first turn. This is the branch's own
  self-declared "chat-model boot probe gap" and needs its own change.
- Detecting an in-place edit that preserves both byte length and mtime.
