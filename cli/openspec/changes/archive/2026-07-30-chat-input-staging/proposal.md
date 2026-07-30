## Why

When a user launches `inflexa` anchored at a folder and tells the agent "the files are in this folder," the agent can neither see those files (workspace file tools are scoped to the analysis tree; the anchor folder is out of scope) nor add them: the only production path to register an input is the TUI file picker, so the agent invents useless folder-copy advice and the files never become a `StagedInput` manifest the harness can profile. Adding inputs mid-conversation is the missing capability — and it must be added without forking the analysis's signed provenance chain.

## What Changes

- Add a **read-only host tool** the CLI injects into the conversation agent that lists candidate files in the analysis's anchor/launch folder, so the agent can see files a user references before they are staged.
- Reuse the existing input-mutation operations (`addInputs`, `removeInput`, `applyInputsDiff` in `src/modules/analysis/analysis.ts`) from two new thin callers: new `inflexa inputs add`/`inflexa inputs remove` subcommands (terminal use) and a new **in-process host tool** the agent uses during a live chat to add and remove — symmetric with the TUI's existing "Manage inputs" / "Remove input" flows. Give the agent a read-only way to list the current registered inputs so it can choose what to remove.
- Adding an input **verifies the path exists** (via the existing `classifyInputPath` stat check) and rejects a hallucinated or mistyped path with a clear not-found message rather than storing a dangling ref; removing an input resolves against the **registered set**, not the filesystem, so a moved/deleted file's input can still be removed.
- The `inputs add`/`inputs remove` subcommands and the in-process mutation path run under the **per-analysis instance lock**: the subcommands acquire it and refuse if the analysis is held by a live instance; the in-process path relies on the lock the open chat already holds. Mutation is **register-only** — it never stages or boots a runtime.
- Reuse the existing profile-parity engine: an added input drifts the profiled set, and the running chat's parity edge auto-reprofiles. No new profiling trigger.
- Classify `inputs add` as `approval` (always confirm before adding), updating the pinned command-policy snapshot.

Not breaking: every change is additive. No existing command, tool, or storage shape changes.

## Capabilities

### New Capabilities

- `launch-dir-listing`: a read-only, CLI-injected conversation-agent tool that enumerates candidate input files in an analysis's anchor/launch folder (the folder the user launched `inflexa` in), reusing the staging walk's noise-directory rules, so the agent can surface files that exist on disk but are not yet staged.
- `analysis-input-management`: provenance-safe add AND remove of analysis inputs after creation — reusing the existing `addInputs`/`removeInput`/`applyInputsDiff` operations from the new subcommands, the in-process agent tool, and the existing file picker; register-only, existence-checked on add, registered-set-matched on remove, reusing staging + parity for materialization and re-profiling; plus a read-only listing of the current registered inputs.

### Modified Capabilities

- `analysis-lock`: extend the single-writer discipline (currently covering TUI open/switch and the `run`/`profile`/`chat` harness commands) to input-mutating surfaces — the `inputs add` and `inputs remove` subcommands acquire the analysis lock and refuse if held by a live instance, so a second process can never fork the signed provenance chain.

## Impact

- **Code**: `cli/src/modules/harness/runtime.ts` (inject the two new host tools alongside `run_inflexa`); the two new host-tool modules under `cli/src/modules/harness/`; a new `inputs` command group with `add`/`remove`/`ls` in `cli/src/cli/index.ts` where `add`/`remove` acquire the analysis lock (`cli/src/lib/lock.ts`) and call the **existing** `addInputs`/`removeInput`/`applyInputsDiff` (`cli/src/modules/analysis/analysis.ts` — already the file picker's path; `addInputs` already existence-checks via `classifyInputPath`/`input.ts`).
- **Tests**: the `agent_policy_tree` snapshot gains `inputs add` (approval); new unit coverage for `addInputs`, the lock-refusal path, and the two host tools.
- **Reused unchanged**: `analysis_inputs` schema, `stageInputs`/`enumerateInputSignatures` (`input-staging`), `watchProfileParity`/`ensureProfileAtParity`, the in-process `Bus`, and the provenance recorder.
- **Companion (out of scope, harness subsystem)**: a `harness/openspec` change to the conversation prompt (`harness/src/prompts/conversation.ts`) — offer to add referenced-but-unstaged files, and relax the "data profiling runs at analysis init" assumption. The primary agent-facing guidance rides in the two new host tools' self-describing `description`s, which are CLI-owned.
- **Constraint rationale**: the `Bus` is in-process only, so a `run_inflexa` subprocess's events never reach the live chat; and the provenance chain is a per-process signed hash chain whose integrity depends on the lock making one writer. Both forbid a subprocess mid-chat add — hence the in-process host tool.
