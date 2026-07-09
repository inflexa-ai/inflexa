# harden-chat-turn-and-parity — Tasks

Depends on `harness/openspec/changes/harden-data-profile-claim` for `StagedInput.mtimeMs` and
`DataProfileStatus.result.inputFiles`. Land that first (§2 below will not typecheck without it).

## 1. The conversation store has one writer generation (D1, D2)

- [x] 1.1 `tui/hooks/conversation.ts`: `send` claims `++loadGeneration` at entry and re-checks it before
      `finishTurn`; `resetHotState` claims it too. Document the WHY on the token (two producers, one
      store; the newest *started* operation wins) — not the mechanism.
- [x] 1.2 `tui/hooks/conversation.ts`: `finishTurn`'s `ok` branch calls `beginStreamSegment()` when
      `streamPartId()` is null before seeding `streamText` with `outcome.fallbackText`. Replace the
      false "the same suppression the printer does" comment with the real predicate (an empty buffer
      means the final assistant text never streamed, so the fallback is not a duplicate).
- [x] 1.3 `tui/hooks/conversation.test.ts`: the two reproducers, as regression tests —
      (a) a gated `loadPage` resolving after `send` pushed its messages leaves both mounted;
      (b) deltas → `tool-started` → `tool-finished` → non-empty `fallbackText` renders the fallback as
      a trailing text part, after the tool chip.
- [x] 1.4 `tui/hooks/conversation.test.ts`: `resetHotState` mid-load drops the load; a streamed final
      segment is not double-rendered; a turn ending on a card appends no empty part (guard 1.2 against
      regression in the other direction).
- [x] 1.5 `tui/hooks/conversation.test.ts`: pin `MESSAGE_CAP <= 200`, the undocumented-at-compile-time
      coupling with `loadPage`'s `Math.min(perPage, 200)` clamp (`harness/src/memory/thread-history.ts:241`).

## 2. Drift is a signature set (D4)

- [x] 2.1 `modules/staging/staging.ts`: `materializeStagedFile` records `mtimeMs` from the `stat` it
      already performs for `size`; the local `StagedInput` mirror gains the field.
- [x] 2.2 `modules/staging/staging.ts`: `enumerateInputFileIds` → `enumerateInputSignatures`, returning
      `ReadonlySet<string>` of `fileId:size:mtimeMs`, one `statSync` per file. Update the doc: still no
      hashing, still no writes; state the accepted miss (an edit preserving size *and* mtime).
- [x] 2.3 `modules/harness/profile_trigger.ts`: `inputSetMatches` compares signature sets; the completed
      row's comparand becomes `status.result?.inputFiles` mapped to signatures. Absent `inputFiles`
      (legacy or null result) ⇒ drift. Update `ProfileParitySeams.enumerate`'s type + doc.
- [x] 2.4 `modules/staging/staging.test.ts`: an in-place rewrite of an input changes its signature and
      leaves its `fileId` unchanged; `enumerateInputSignatures` still matches `stageInputs`'s manifest
      by `fileId`; still creates nothing.
- [x] 2.5 `modules/harness/profile_trigger.test.ts`: same fileIds + changed signature ⇒ `triggered`,
      not `already_profiled`; a completed row with no `inputFiles` ⇒ `triggered`.

## 3. Parity and force drives serialize (D3)

- [x] 3.1 `tui/hooks/profile_parity.ts`: a module-level in-flight promise chain; both `driveProfileParity`
      and `driveForceReprofile` run their whole body inside it. A rejected predecessor must not poison
      the chain. Comment the WHY: the ledger CAS runs after staging, so it cannot serialize `stageInputs`
      or the clear-vs-seed interleaving.
- [x] 3.2 `tui/hooks/profile_parity.ts`: export a test-only reset for the chain, beside
      `__resetProfileParityForTest`.
- [x] 3.3 `tui/hooks/profile_parity.test.ts`: two `driveProfileParity` calls issued while the first's
      `check` is parked never overlap (assert on enter/exit ordering, not on timing); a `driveForceReprofile`
      issued mid-parity waits; a rejecting drive does not wedge the chain for the next one.

## 4. The sidebar poll never overlaps itself (D5)

- [x] 4.1 `tui/hooks/sidebar_live.ts`: an in-flight flag at the poll's timer callback (not inside
      `refreshSidebarData` — lifecycle edges must still supersede). Comment the WHY: the generation token
      makes a newer refresh cancel an older one, so unguarded ticks slower than the interval starve the
      store forever, and `unavailable` is itself an arming state.
- [x] 4.2 `tui/hooks/sidebar_live.test.ts`: with a parked `refresh`, N ticks issue exactly one refresh;
      once it resolves, the next tick issues another; a lifecycle-edge refresh during an in-flight poll
      still runs.

## 5. The test sandbox is structural (D6)

- [x] 5.1 `src/lib/env.ts`: throw at import when `process.env.NODE_ENV === "test"` and
      `INFLEXA_TEST_SANDBOX` is unset, before any XDG path resolves. Comment the WHY (bunfig does not
      walk up; a nested-cwd `bun test` bypasses both preloads) and why it is inert in a built binary
      (`--define`d `NODE_ENV`), in `bun run dev`, and in the `runCli` subprocess.
- [x] 5.2 `src/test_support/sandbox.ts`: `assertTestSandbox` compares on a path boundary
      (`sandbox + sep`, plus exact-equality) rather than a bare `startsWith`. Rewrite the docstring: it is
      a per-site check, not the choke point every destructive site funnels through — `env.ts` is the
      backstop. Keep the "test sandbox not active" phrase `harness.test.ts` asserts on.
- [x] 5.3 `bunfig.toml` + `scripts/refuse-root-test.ts` (repo root): stop citing a `harness/` bunfig
      sandbox — it does not exist (`find . -name bunfig.toml` → root + `cli/` only). Drop the
      bun-1.3.8-specific empirical claim; keep `process.exit` and justify it as version-independent.
- [x] 5.4 `src/lib/env.test.ts`: the guard's truth table as a pure function (`test` + no marker → throw;
      `test` + marker → pass; `production`/unset channel → pass), so it is testable without a second
      process.

## 6. The build gate (D7)

- [x] 6.1 `scripts/build.ts`: after the channel validation, refuse a `production` build with no
      `INFLEXA_GIT_COMMIT` (print + `process.exit(1)`). Then `define["process.env.INFLEXA_GIT_COMMIT"]`
      when the value is non-empty. Comment why this is an explicit define rather than a `bakedEnv`-block
      literal (the scanner's missing-var guard applies to every channel).
- [x] 6.2 `src/lib/env.ts`: correct `resolveGitCommit`'s comment — the `--define` is emitted explicitly by
      `scripts/build.ts`, not by the `bakedEnv` scanner, and the production `throw` is a backstop for a
      build that bypassed that script, not dead code.

## 7. Nits

- [x] 7.1 `src/lib/cause.ts`: `describeCause` and `causeDetailLines` render `AggregateError.errors`
      (bounded by the existing `MAX_CAUSE_DEPTH` / `MAX_DETAIL_LINES` caps). Tests in `cause.test.ts`.
- [x] 7.2 `modules/staging/staging.ts:64`: remove the bare `as FsError` by giving `stageFile`'s error
      literal a contextual type (D8) — do not merely comment it.
- [x] 7.3 `tui/contexts/workspace.ts:141`: keep the `throw`, name the invariant class in a comment (a
      missing Provider is a wiring bug, the same class as an exhaustive-switch default).
- [x] 7.4 `cli/CLAUDE.md`: `src/cli/` is a **commander** registry, not `cac` (`openspec/specs/cli-core/spec.md:96`
      already says commander).
- [x] 7.5 `tui/components/dialog/runs_dialog.test.ts`: cover the snapshot `Switch` ladder
      (`not_ready` / `unavailable` / loaded-empty / loaded), the `onMount` step fetch, and the
      `loadSteps` → `DbError` → "steps unavailable" degrade via the injectable seam.
- [x] 7.6 `tui/components/dialog/results_dialog.test.tsx` (new): the `action` affordance — footer
      composition, the `parseChord` binding, and that a disabled action renders byte-identically to no
      action at all.
- [x] 7.7 `modules/proxy/models.test.ts`: `resolveModelId` (fetch throw → `proxy_unreachable`, `!res.ok`,
      empty `data` → `no_models`, process-wide caching on the ok path only) and `readApiKey`
      (present / absent / malformed config).

## 8. Gate

- [x] 8.1 `bun run format:file` on every touched `src/` path.
- [x] 8.2 `bun run typecheck` && `bun run lint` clean.
- [x] 8.3 `cd cli && bun test` green; `cd harness && bun test` green.
- [x] 8.4 Verify by deletion: revert 1.1 and confirm 1.3(a) fails; revert 1.2 and confirm 1.3(b) fails.
