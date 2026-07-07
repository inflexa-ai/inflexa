# Proposal: embed-conversation-agent

## Why

The conversation agent — the product's actual interaction model (converse → plan → approve → execute → interpret) — has **zero production callers anywhere**: `assembleCoreRuntime`, `prepareChatTurn`, `appendTurn`, and the planner loop have never been executed outside tests (the managed Cortex host vendors an older harness and wires by hand). Under the committed daemon architecture (#33), their first-ever exercise would otherwise happen behind three simultaneously new layers (daemon lifecycle, SSE framing, TUI client). This change is the walking skeleton recommended by `docs/harness_integration_followup/13-sequencing-memo.md` (Ordering C): retire the riskiest terrain now, embedded, behind the smallest possible wrapper — the same pattern that found real bugs in changes C (`inflexa profile`) and F (`inflexa run --plan`).

## What Changes

- **Boot adopts the harness composition root.** `bootHarnessRuntime` stops registering workflows piecemeal and calls `assembleCoreRuntime` (discharging change C's D1 debt), which additionally registers the `ephemeral` and `executeTargetAssessment` workflows and builds the conversation agent. `sweepEphemeralWorkflows` is called between pool creation and `launchDbos` — without it, recovery would re-dispatch dead chat-turn sandboxes. The three sandbox-hygiene crons, ingress, `initCortexState`, and the embedder probe stay in `bootHarnessRuntime`.
- **Three new dep realizations** close the `ConversationAssemblyDeps` gaps: `templatesDir` (repo-root `templates/`, config-overridable — mirrors `skillsDir`), `chrome: {}`, and `createPreviewPublisher` returning the harness's `UnavailablePreviewPublisher` (report preview short-circuits; `submit_report` remains the only gate).
- **New command `inflexa chat <analysis>`** — a deliberately temporary clack REPL (dev surface, `TODO(extend)`-marked, #33 M3 named as the replacement): resolve analysis → pre-flight → boot → per-analysis instance lock → loop of `prepareChatTurn → runAgent(emit → stdout printer) → appendTurn`. The printer renders accumulated `text-delta`s, tool chips from `tool-started`/`tool-finished`, and text renderings of `data-plan`/`data-run-card` parts. Plan approval is conversational (prompt-enforced; the `RunAuthorizer` seam is the structural hard-gate fallback if unprompted launches are ever observed). Ctrl+C aborts the in-flight turn (signal), not the process.
- **#32 stage-1 clearing-contract rewrites (docs-only).** The `plan-intake` spec purpose becomes "protocol replay surface; the planner is the primary author; hand-authoring is a dev workflow"; the `TODO(extend)` headers in `plan_intake.ts` and `run.ts` are rewritten to match (they currently instruct deletion at adoption — that premise is now known wrong; the `run.ts` trigger replica is absorbed by #33 M2, not deleted here).
- **Per-analysis instance lock in `inflexa run` and `inflexa profile`** (#37 interim fix 1) — the same lock the TUI and the new chat command take, closing the documented two-recorder provenance hazard for command-vs-TUI concurrency.
- **Harness-side additive riders only**: barrel exports for the chat-turn machinery (`prepareChatTurn` + types, `createThreadHistory`/`createThreadStore`, `contentToCortexMessages`/`createCardResolver`), the `contracts/` chat-event/part types, `sweepEphemeralWorkflows`, and the `CoreRuntimeDeps` family; fix `harness/CLAUDE.md:151` (claims contracts are barrel-exported — currently false) and the stale `harness/CLAUDE.md:146` `consumeStream` claim.

**Not in this change** (deliberate): TUI rendering of chat (that is #33 M3/M4), SSE/daemon work, the plan-lineage provenance rider (successor change `record-plan-lineage`, per the D/D2/D3 precedent), proxy-chat retirement, and any trigger surface for `executeTargetAssessment` (it is registered deliberately untriggerable — see design).

## Capabilities

### New Capabilities

- `chat-command`: the `inflexa chat <analysis>` walking-skeleton REPL — resolution, pre-flight, boot, per-analysis lock, the turn loop, the stdout printer contract (deltas, tool chips, plan/run-card parts), conversational approval, turn-scoped abort, and its explicit clearing contract (temporary dev surface; #33 M3 replaces it).

### Modified Capabilities

- `harness-runtime`: boot composition changes from direct workflow registration to `assembleCoreRuntime` (one pre-launch cohort, now including `ephemeral` + `executeTargetAssessment` + the conversation agent), adds the pre-launch ephemeral sweep, and realizes the three new conversation deps.
- `plan-intake`: the clearing-contract requirement inverts per #32 Option B stage 1 — from "expected REMOVED at planner adoption" to "protocol replay surface beside the planner author path"; this requirement also owns the `run.ts` trigger-replica header, so its rewrite (absorbed by #33 M2, not deleted) lands here. Stale purpose prose in `plan-intake` and `analysis-run-launch` (the "cli runs no conversation agent" parenthetical) is corrected when deltas sync to main specs.
- `analysis-lock`: the lock extends beyond the TUI — deliberate harness commands (`run`, `profile`, `chat`) acquire the same per-analysis lock so only one process mutates an analysis's provenance at a time.

## Impact

- **cli**: `src/modules/harness/runtime.ts` (boot), `run_deps.ts` (builder reshape), `config.ts`/`resolveHarnessConfig` (templatesDir key), `plan_intake.ts` + `run.ts` (header rewrites; lock), `profile.ts` (lock), new `src/modules/harness/chat.ts` (or sibling) + command registration in the commander registry; `plan-intake`/`analysis-run-launch`/`analysis-lock`/`harness-runtime` specs.
- **harness**: `src/index.ts` barrel additions (additive only), `CLAUDE.md` doc corrections. No behavior changes.
- **Runtime risk**: first execution of `assembleCoreRuntime`, the proxy-backed provider at 40-tool/50-iteration scale, and the pg thread machinery — a live-E2E findings task group is budgeted, as changes C and F both needed.
- **Dependencies**: no new packages; `@clack/prompts` is already the text-command prompt layer.
