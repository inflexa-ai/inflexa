## 1. Groundwork (confirm reused seams)

- [x] 1.1 Confirm `addInputs`/`removeInput` signatures and the `prov.input_added` emit in `src/modules/analysis/analysis.ts`; confirm the file picker path (`applyInputsDiff`) already routes through `addInputs`.
- [x] 1.2 Confirm the anchor-folder resolution for an analysis (anchor path from `anchor_id`) and the `hostTools` injection point in `src/modules/harness/runtime.ts` (where `run_inflexa` is added).
- [x] 1.3 Confirm `acquireInstanceLock`/`releaseInstanceLock` (`src/lib/lock.ts`) and the refusal message shape used by the open/switch flow, to reuse for the subcommand.

## 2. Launch-dir listing host tool (Q1)

- [x] 2.1 Add a read-only host-tool module (`src/modules/harness/launch_dir_tool.ts`) that lists files under the analysis's resolved anchor folder, reusing the exported staging noise-directory walk (`walkFiles`/`IGNORED_WALK_DIRS`), returning anchor-relative path + size per file.
- [x] 2.2 Mark each returned file with whether it is already a registered `analysis_inputs` row (`registrationIndex`/`isRegistered`).
- [x] 2.3 Self-describing tool `description` (when to reach for it: a user references files not yet added).
- [x] 2.4 Inject the tool into `hostTools` in `src/modules/harness/runtime.ts`.
- [x] 2.5 Unit tests in `launch_dir_tool.test.ts`: lists files with sizes, excludes noise dirs, marks registered vs unregistered, performs no writes, `no_analysis` outside analysis scope.

## 3. `inputs` subcommands (Q2 terminal surface)

- [x] 3.1 Add an `inputs` command group in `src/cli/index.ts` with `add <paths...>`, `remove <paths...>`, and `ls` (each `--analysis <id|name>`). Policy: `ls` = auto; `add`/`remove` = **blocked** (design refinement — the agent must add/remove via the in-process tool, so shelling out would hit the lock refusal; blocking steers it there while keeping the subcommands for terminal humans).
- [x] 3.2 `add`/`remove` action (`src/modules/analysis/inputs_command.ts`): resolve the analysis, `acquireInstanceLock`; on `acquired:false` `fail(...)` naming the analysis and exiting non-zero, mutating nothing; on success call `addInputs`/`removeInput`; lock released by the process-exit hook.
- [x] 3.3 Register-only: does not call `stageInputs`, boots no runtime.
- [x] 3.4 Translate the add not-found error at the boundary to a clear "no such file: <path>" message (pre-check via `existsSync`/`expandAndResolve`, plus the `classifyInputPath:notFound` fallback).
- [x] 3.5 `remove` resolves against the current input set via `matchInputRefs` (not the filesystem); non-match → reported no-op; a still-registered input whose file is gone is removable.
- [x] 3.6 Accept absolute host paths (anchorless) and anchor-relative paths — inherited from `addInputs`/`classifyInputPath`.
- [x] 3.7 Update the `agent_policy_tree` snapshot: `inputs add`/`remove` = blocked, `inputs ls` = auto(analysis); snapshot test + lint green.
- [x] 3.8 Unit tests in `inputs_command.test.ts` (add registers + emits `prov.input_added`; ls lists; remove drops + reports a non-input no-op) and `input.test.ts` (`matchInputRefs` incl. file-gone, `expandAndResolve`). The `fail()`/`process.exit` error paths (lock-refusal, not-found) are covered by the equivalent return-variant paths in `inputs_tool.test.ts`. Also switched command resolution to the shared `resolveSingleAnalysis` (moved from `harness/profile.ts` to `analysis/context.ts`) so multi-analysis anchors get a proper "pick one with --analysis" error.

## 4. In-process agent input tool (Q2 mid-chat surface)

- [x] 4.1 Add an in-process host-tool module (`src/modules/harness/inputs_tool.ts`, `manage_inputs`) that adds, removes, and lists inputs for the open analysis via the shared ops; approval-gated via `ctx.ask` before mutating.
- [x] 4.2 Acquires no lock — relies on the lock the open chat holds; documented in the module header.
- [x] 4.3 `manage_inputs` `list` action gives the agent the current registered inputs (incl. those outside the anchor) so it can choose what to remove.
- [x] 4.4 Inject the tool into `hostTools` in `src/modules/harness/runtime.ts`.
- [x] 4.5 Unit tests in `inputs_tool.test.ts`: add registers + asks + emits `prov.input_added`; add rejects a non-existent path before asking/mutating; **mutate-without-lock is refused** (the new `holdsInstanceLock` defense-in-depth guard); remove emits `prov.input_removed` + no-ops on a non-input; list is read-only; approval-gated.

## 5. Parity + provenance integration

- [x] 5.1 Verified by composition: `manage_inputs` emits `prov.input_added`/`prov.input_removed` in-process (`inputs_tool.test.ts`) and the existing `profile_parity.test.ts` drives edge 2 (the debounced input-mutation edge) on exactly those events; the `cleared` outcome (emptied set) is covered in `profile_parity.test.ts`.
- [x] 5.2 Verified by composition: the terminal add emits `prov.input_added` (`inputs_command.test.ts`); `profile_parity.test.ts` covers edge 1 (boot/open) and the set-based `ensureProfileAtParity` drift check re-profiles on the next open.
- [x] 5.3 No recorder-level lock assertion added (the emit-site audit showed the creation path legitimately emits lock-free; a blanket assertion would break it). Discipline stays caller-side via 3.2.

## 6. Validation

- [x] 6.1 `bun run typecheck` clean; `bun run lint` clean; `bun test` for staging/analysis/cli (126 pass) + the new `input.test.ts` helper tests (11 pass).
- [x] 6.2 `bun run format:file` run on all changed `src/` files.
- [x] 6.3 `openspec validate chat-input-staging --strict` stays green.

## 7. Follow-up (separate, not in this change)

- [x] 7.1 Companion `harness/openspec` change `conversation-unstaged-data-guidance` created and implemented: `harness/src/prompts/conversation.ts` now offers to add referenced-but-unstaged files (host-agnostic) and no longer asserts profiling is init-only. Validates `--strict`; harness `tsc` green.
