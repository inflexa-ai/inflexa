## Why

The bench (`inflexa-ai/bench`) embeds the harness as a second embedder beside the
CLI. Its rule is an import from the package root only, because a bench that
reaches into the source measures a fiction. Three names that an embedder needs
are absent from the root, thus the bench holds three deep imports as debt. Two
documents also name code that no longer exists, thus a reader of the harness
learns a capability that is not there.

## What Changes

- Re-export the `BioToolKeys` type from `harness/src/index.ts`. The barrel
  exports `ConversationAgentDeps` already, and `ConversationAgentDeps.bioKeys`
  has this type. Thus an embedder cannot write that dependency today.
- Re-export the four target-assessment row helpers from the root:
  `insertAssessment`, `getAssessment`, `updateProgress`, and
  `listAssessmentsByOrg`. Re-export the row types that these helpers give back
  and the input types that they accept. Without the row types, a caller cannot
  name the value of a read.
- Add `createTargetAssessmentProgressStream`, the read side of the
  target-assessment `progress` stream. Today
  `workflows/target-assessment/progress.ts` has a writer only, thus an embedder
  that shows progress must read the durability-engine stream itself. The new
  reader delivers each `TargetAssessmentProgressEvent` to a handler of the
  caller, and no type of the durability engine appears in its signature.
- Repair the stale references in the documents. `CONTEXT.md:331` and
  `openspec/specs/harness-durable-runtime/spec.md:144` name
  `RunLauncher.launchAndAwait`, but `src/execution/run-launcher.ts` declares
  `launch` only. `openspec/specs/agent-skill-assignment/spec.md:189` names
  `REPORT_BUILDER_SKILLS`, but `src/runtime/boot.ts:55` validates
  `SANDBOX_AGENT_META` only.

Issue #535 names two stale references. This change repairs three. The second
`launchAndAwait` reference is the same defect in the spec tree, and the spec
tree is the source of truth. To repair one copy and to keep the other is not
coherent.

The scenario at `harness-durable-runtime/spec.md:141` names two more things
that do not exist: the tools `execute_plan` and `run_ephemeral`. The archived
change `2026-07-29-unify-adhoc-analysis-execution` removed them. `execute_analysis`
(`src/tools/execute-analysis.ts:370`) is the tool that starts a durable run
today. Thus this change repairs the whole scenario, not one word of it.

Each change to the code surface is additive. No exported name changes, and no
exported name is removed. The repairs of the documents remove text only.

## Capabilities

### New Capabilities

- `harness-embedder-exports`: which names the curated root barrel carries, and
  the rule that decides a new one. It covers the `BioToolKeys` type and the
  target-assessment row surface.
- `target-assessment-progress-stream`: the read side of the target-assessment
  `progress` stream — the subscription lifecycle, the delivered value, the
  termination condition, and the isolation of a failure.

### Modified Capabilities

- `harness-durable-runtime`: the scenario that names the methods of
  `RunLauncher` drops `launchAndAwait`.
- `agent-skill-assignment`: the requirement that names the agents of the boot
  validation drops `REPORT_BUILDER_SKILLS`.

## Impact

- `harness/src/index.ts` — the re-exports of items 1, 2, and 3.
- `harness/src/workflows/target-assessment/progress-stream.ts` — a new module,
  the reader.
- `harness/CONTEXT.md` — the `RunLauncher` entry.
- `harness/openspec/specs/harness-durable-runtime/spec.md` and
  `harness/openspec/specs/agent-skill-assignment/spec.md` — through the delta
  specs of this change.
- No embedder breaks, because each change is additive.
