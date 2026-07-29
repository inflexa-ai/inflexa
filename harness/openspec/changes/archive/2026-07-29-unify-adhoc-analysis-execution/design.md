## Context

Today the conversation agent has two computational launch paths:

- `execute_plan` resolves an approved stored plan, reserves a `cortex_runs` row,
  authorizes it, and asynchronously starts the DBOS `executeAnalysis` workflow.
  Its normal sandbox steps are writable and produce the run ledger, summaries,
  artifacts, and pull-based results.
- `run_ephemeral` starts a separate `ephemeral` workflow, awaits it inside the
  chat turn, and runs `ephemeral-executor` in a read-only sandbox with a short
  default deadline. It has no ordinary run/step/artifact lifecycle.

The second path duplicates orchestration while providing the weaker behavior.
The desired distinction is not "durable versus ephemeral" but "user-approved
multi-step plan versus explicitly requested one-step analysis." The latter can
be represented by the existing analysis machinery if its plan-shaped workflow
input is treated as an internal execution record rather than a user approval
artifact.

The harness owns the execution concept and routing policy. Embedders only supply
the required model/provider capabilities and resource policy. Because the CLI
and harness have independent OpenSpec roots, CLI configuration and composition
changes are specified by a coordinated CLI-local change with the same name.

## Goals / Non-Goals

**Goals:**

- Give explicit, targeted computational requests the same durable, writable,
  observable, and recoverable execution lifecycle as plan steps.
- Keep planned execution behavior and its explicit plan approval intact.
- Avoid a second user approval for a mechanically generated ad hoc plan.
- Select an appropriate specialist without letting the conversation model choose
  or override the selected sandbox agent.
- Make duplicate delivery of one tool invocation idempotent at the run/workflow
  boundary while treating a later agent invocation as a new run.
- Delete the ephemeral execution path and its special configuration.
- Disable synthesis for ad hoc runs without introducing a forked parent workflow.

**Non-Goals:**

- Replacing the planner or allowing the ad hoc router to create a DAG.
- Letting the router reject a request as too broad or switch it into planned
  mode. The conversation agent chooses the mode under the consent rules.
- Semantic deduplication by request text.
- An ad hoc-specific resource budget, timeout setting, or sandbox type.
- Synchronous completion or pushing final results back into the originating chat
  turn.
- Ad hoc run synthesis. It can be enabled by a future change using the preserved
  per-run switch.
- Removing the generic `readOnly` sandbox-agent capability used by other or
  future harness workflows; only ephemeral-specific provisioning is retired.

## Decisions

### 1. One flat `execute_analysis` tool owns both launch modes

The conversation roster replaces `execute_plan` and `run_ephemeral` with one
workflow-mode tool:

```typescript
{
  mode: "plan" | "adhoc";
  planId?: string;
  request?: string;
}
```

The schema remains a top-level object because the harness tool primitive rejects
union-shaped input schemas. A refinement requires exactly `planId` for `plan`
mode and exactly `request` for `adhoc` mode. Plan mode retains the existing
analysis-scoped lookup, validation, active-plan deduplication, authorization,
launch, run-card, and pull-only result behavior.

Ad hoc mode is available only when the user explicitly asks the agent to run,
compute, test, compare, or otherwise execute an analysis. That request is the
authorization to launch; there is no plan card or second approval. If the agent
merely infers that computation would improve an answer, the conversation prompt
requires it to ask the user before calling the tool.

Alternatives considered:

- Keep two public tools backed by one launcher. This preserves two overlapping
  contracts and encourages the agent to reason about implementation rather than
  user intent.
- Add ad hoc input to `execute_plan` without renaming it. The name would make a
  no-user-plan mode misleading and would preserve unnecessary compatibility
  surface inside an agent-only API.

### 2. Ad hoc routing is one bounded utility-model decision

The harness adds required `utilityProvider` and `utilityModel` dependencies to
the conversation/runtime composition. The ad hoc launcher makes one structured
model call, bounded by a small constant timeout (10 seconds), before reserving
and launching the run. The router receives:

- the exact ad hoc request;
- the persisted data-profile orientation loaded server-side;
- the plannable sandbox-agent catalog and its descriptions;
- resource-estimation guidance with explicit lower, default, and upper bounds.

The router has no workspace tools and cannot search files. Its forced structured
result is:

```typescript
{
  agentId?: string;
  resources?: {
    cpu: number;
    memoryGb: number;
    gpu?: { count: number };
  };
  rationale?: string;
}
```

Only `getPlannableAgentCatalog()` entries are valid selections. The router does
not see `scientific-executor` as a candidate; that agent is the deterministic
fallback for an absent/unknown selection, no match, timeout, malformed output,
or provider error. Agent and resource validation are independent, so a valid
specialist survives a bad resource estimate and vice versa. Routing failure
class and rationale are logged and persisted with the internal plan decision.

The resource prompt reuses the planner's resource-estimation vocabulary instead
of copying it. With a `ResourcePolicy`, CPU and memory lower bounds are
`min(1, configured ceiling)`, upper bounds are `perStep.maxCpu` and
`perStep.maxMemoryGb`, GPU ranges from absent/zero through
`perStep.maxGpuCount`, and defaults are `min(4, maxCpu)` /
`min(8, maxMemoryGb)` with no GPU. Without a policy, the historical planner
defaults (4 CPU, 8 GB, no GPU) are also the conservative ad hoc bounds. Missing
or out-of-bounds resource output uses those defaults; the value is never trusted
or silently clamped. The ordinary snapshotted machine budget remains the
execution-time authority.

Alternatives considered:

- Let the conversation agent name the specialist in tool input. This makes the
  expensive conversational model part of an operational routing contract and
  permits prompt-level agent overrides.
- Always use `scientific-executor`. It discards the focused prompts and tool
  allowlists available from specialist agents.
- Let the router decide whether the request requires a plan. That would turn a
  small classifier into a second planner and make user consent unpredictable.

### 3. The one-step plan is internal, mechanical, and first-writer-wins

Ad hoc mode derives an internal `planId` from the analysis id and stable tool
invocation id, using the existing `pln-<8hex>` shape. It first loads that plan;
when absent, it routes and mechanically builds one `AnalysisPlan`:

- a single fixed step id with no dependencies;
- the request as its question and plan narrative;
- the validated agent/resource decision;
- normal analysis-step standards as acceptance criteria, including persisted
  reproducible script(s), result file(s), and a direct answer even for a scalar
  computation;
- the selected agent's default iteration limit and the normal step timeout.

The planner is never called. `upsertPlan`'s insert-if-absent behavior is the race
arbiter: concurrent duplicate deliveries may both route, but both reload and
execute the first stored plan. The row is an execution snapshot and database
foreign-key/dedup aid, not a user-facing plan awaiting approval. It is not
emitted as a plan card.

Alternatives considered:

- Add a second non-plan workflow input. This would fork validation, scheduling,
  step briefing, persistence, and UI joins for a shape that is already exactly a
  one-step DAG.
- Invoke the planner to make the row. That adds latency, cost, and accidental
  method/DAG decisions when only bookkeeping is required.

### 4. Tool invocation identity is the idempotency boundary

`ToolContext` gains `invocationId`, populated from the AI SDK
`toolCallId`. Ad hoc mode deterministically derives a bare UUID run id from
`execute_analysis`, the analysis id, and `invocationId`; that UUID is also the
DBOS workflow id.

Run reservation becomes idempotent by `runId`: insert-if-absent followed by an
analysis-scoped reload. An existing row for the same deterministic id is
returned regardless of whether it is active or terminal, and DBOS receives the
same workflow id if duplicate delivery reaches launch. A distinct agent tool
call has a distinct `invocationId`, so it derives a new plan/run and executes
again even when its `request` string is byte-identical.

Plan mode keeps its existing active `(analysisId, planId)` deduplication: its
user-visible re-run semantics are intentionally separate from ad hoc invocation
identity.

Alternatives considered:

- Hash the request text. This would suppress intentional re-runs and still fail
  to distinguish two user-authorized calls.
- Generate a random run id after routing. A transport retry could create two
  durable computations before either result reaches the conversation.

### 5. Synthesis enablement moves into replay-stable workflow input

`ExecuteAnalysisInput` gains optional `synthesisEnabled`. The parent resolves
absent to `true` for workflows persisted before the field existed. Plan mode
sets `true`; ad hoc mode sets `false`.

The resolved value gates both synthesis-row seeding and synthesis execution.
Consequently an ad hoc run exposes exactly its single normal step and finalizes
successfully without synthesis. The construction-time
`ExecuteAnalysisDeps.synthesisEnabled` switch is removed so a deployment change
cannot alter behavior while a persisted workflow replays.

This uses the existing scheduler, child workflow, summarization, artifact
registration/sync/indexing, authorization, billing, cancellation, and terminal
finalization paths unchanged.

Alternative considered: a separate one-step workflow without synthesis. It
would duplicate the most failure-sensitive orchestration solely to avoid one
boolean gate the parent already conceptually supports.

### 6. Ephemeral removal keeps a narrow rollout bridge

The ephemeral tool, workflow, agent definition, prompt, `launchAndAwait`,
ephemeral-specific read-only provisioning, and `ResourcePolicy.ephemeral` are deleted.
Normal prompt and tool references are rewritten around `execute_analysis`.
Generic read-only agent/mount behavior remains part of the sandbox abstraction.

DBOS can still contain pending `ephemeral:*` rows from a previous binary. The
existing executor-scoped pre-launch sweep is retained temporarily as a legacy
migration hook, and must run before DBOS recovery sees those rows. It cancels
only the current stable executor's legacy ephemeral rows; no new code can create
them. The sweep can be removed in a later release after the supported upgrade
window has elapsed.

Before rolling back, deployments must drain or cancel runs started by the new
binary. An older parent would not honor the new per-run synthesis input and
therefore is not replay-compatible with in-flight ad hoc runs. A rollback also
requires restoring the old embedder configuration expected by that binary.

## Risks / Trade-offs

- **Router latency delays the run card by up to the fixed bound.** → Keep the
  call single-shot and tool-free, enforce the deadline, and fall back rather
  than failing the launch.
- **A weak router may choose a poor specialist or resource estimate.** → Restrict
  candidates, validate fields independently, expose explicit bounds, record the
  decision, and use deterministic defaults.
- **The eight-hex plan id has a small collision domain.** → Preserve the current
  storage contract for this change; scope all reads by analysis and make the
  run's full UUID the true invocation identity.
- **Concurrent duplicate delivery can issue more than one utility call before
  persistence arbitrates.** → First stored plan wins and only one deterministic
  DBOS workflow executes; avoiding duplicate prelaunch inference would require a
  new durable routing workflow and is not worth the added seam.
- **Ephemeral-specific read-only branches may be entangled with generic
  read-only support.** → Remove only the ephemeral call path and retain the
  sandbox abstraction's existing generic `readOnly` contract.
- **Legacy ephemeral DBOS rows could fail recovery after workflow registration
  is removed.** → Keep and test the pre-launch legacy sweep through the upgrade
  window.

## Migration Plan

1. Add invocation identity, utility routing, internal-plan construction,
   input-snapshotted synthesis behavior, and idempotent run reservation.
2. Introduce `execute_analysis`, update the conversation contract, and migrate
   plan-mode coverage from `execute_plan`.
3. Wire the required utility model/provider in each embedder. For the CLI, land
   the coordinated subsystem-local OpenSpec change and configuration migration.
4. Remove `run_ephemeral`, its workflow registration and agent, special resource
   configuration, and now-unused synchronous launcher/read-only path.
5. Retain and test the legacy `ephemeral:*` pre-launch sweep for the documented
   upgrade window; remove it in a later cleanup after all supported deployments
   have crossed the migration.

Rollback requires draining/cancelling workflows started by the new version,
then restoring the previous harness and embedder configuration together.

## Open Questions

None. The remaining constants and mechanical wording are implementation details
bounded by these contracts.
