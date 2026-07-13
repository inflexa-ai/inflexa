# Design: add-step-handoff-briefings

## Context

The `sandbox-step` child workflow (`src/workflows/sandbox-step.ts`) builds its agent loop's initial messages as exactly one user message — the plan-time step prompt (`initial: LoopMessage[] = [{ role: "user", content: input.prompt }]`). That prompt was rendered at dispatch time by `renderStepPrompt` from design-time plan fields, so it cannot contain what upstream steps actually produced. Upstream results reach a dependent step today by two ad-hoc routes: the planner's `context` field (written before execution — speculation, not results) and the "Orient First" instruction in `sandbox-standards.ts` telling the agent to `read_file` "profiles and upstream outputs" and semantically search the workspace — i.e. runtime self-discovery over the read-only analysis mount and the vector index.

Meanwhile the harness already produces exactly the artifact this handoff needs: each step's post-step pipeline writes a compact interpretation summary to `runs/{runId}/{stepId}/output/summary.md` (step-interpretation-summary) and reconciles an artifact manifest. And the briefing system (add-conversation-briefings) provides the declarative contract for first-turn context injection: `BriefingDefinition<TInput>` with a pure `render → { content, caption }`, `composeBriefing` wrapping content into a `<briefing name="…">` user message, and design decision D10 already establishing that ephemeral loops "use the same definitions, unpersisted" as structured initial messages.

Constraints from the workflow layer: the child body is DBOS-durable — everything nondeterministic must be checkpointed in a `DBOS.runStep` so replays reproduce byte-identical initial messages; `SandboxStepInput` must stay JSON-serializable and small (it persists as the workflow's input row); the child today knows nothing about the DAG (no `depends_on` in its input) — only the parent does.

## Goals / Non-Goals

**Goals:**

- A dependent step's sandbox agent sees each upstream step's interpretation summary and artifact locations on turn one, via the briefing contract — typed, snapshot-tested, uniformly wrapped.
- Composition lives in the child workflow body, before `runAgent`, as unpersisted structured initial messages — zero storage, `loadRecent`, or briefing-card involvement.
- Omit-on-missing throughout: no upstream dependencies → no handoff briefing; upstream without a persisted summary → that edge contributes nothing.
- The briefing becomes the single injected channel for upstream runtime context: the orientation prompt's self-discovery instruction is rewritten to reference it, and `renderStepPrompt` stays design-time-only.
- Replay-stable: identical initial messages on DBOS recovery.

**Non-Goals:**

- Persisting workflow-loop briefings or emitting briefing-card parts (those are main-conversation, thread-history concerns).
- Handing off run synthesis, prior-run results, or anything cross-run (prior-runs briefing is a separate change).
- Changing how the interpretation summary is produced, written, or indexed (production side of step-interpretation-summary is untouched).
- Removing the read-only analysis mount or the agent's ability to `read_file` upstream artifacts — the briefing replaces blind re-discovery, not deep inspection.
- Per-briefing token budgets or truncation policy.

## Decisions

### D1: One briefing per upstream step, not one composed handoff block

Each upstream `depends_on` step renders as its own `step-handoff` briefing message, injected in `depends_on` array order. This is what the shipped code makes natural: `composeBriefing` maps one definition + one typed input onto one `user` message, and the definition-per-file pattern pairs one input fixture with one snapshot. Per-upstream inputs keep the fixture a single step's `{ stepId, name, summaryMarkdown, artifactPaths }`; the prescribed caption (`step s2 "normalize" · 4 artifacts`) is inherently per-step; and omit-on-missing applies per edge — one upstream lacking a summary does not erase its siblings' handoffs. *Alternative considered*: a single composed briefing aggregating all upstreams — rejected: it needs an aggregate input type and caption that flatten per-step identity, turns per-edge omission into content-level special-casing inside `render`, and buys nothing since multiple briefing messages are already the wire convention (D4 of the base design: one `user` message per briefing).

### D2: Standing mode, with the persistence clause vacuous for ephemeral loops

`step-handoff` declares `mode: "standing"` — injected once at loop start, immutable for the loop's lifetime, riding ahead of the task prompt. In the main conversation, standing also implies persistence and `loadRecent` pinning; workflow loops keep no thread history (the DBOS step cache is the durability), so per the base design's D10 the same definition is injected as an unpersisted initial message and the persistence clause simply has no substrate. Rolling would be wrong twice over: upstream results do not change during the step (re-rendering is pointless) and a tail block re-rendered each turn would destroy the loop's append-only prefix stability. *Alternative considered*: a third `mode` value for ephemeral loops — rejected; the base contract already covers this (D10), and a new mode would fork placement semantics for zero behavioral difference.

### D3: The parent projects upstream identity; the child loads content

`SandboxStepInput` gains `handoffSources: readonly { stepId: string; name: string }[]` — computed by `buildChildInput` from the plan DAG (`input.steps`) plus a new `ExecuteAnalysisInput.nameByStepId` map that `execute_plan` populates following the existing `promptByStepId`/`agentByStepId`/`resourcesByStepId` pattern. The child then loads the payload itself. Rationale: the parent is the only party that knows the DAG, but shipping full summary content through `SandboxStepInput` would bloat the persisted workflow-input row and freeze content at dispatch time; identity pairs are tiny and stable. The child reads each upstream's `output/summary.md` and artifact listing inside one durable step. *Alternative considered*: parent loads content and passes it in the child input — rejected (input-row bloat; parent scheduler loop takes on file I/O per dispatch; the child already holds the workspace read seam). *Alternative considered*: child re-derives its upstream ids from `loadPlan` — rejected (child input carries no `planId`, and adding a DB read for what the parent already computed inverts the existing projection discipline).

### D4: One checkpointed `handoff.load` step; composition stays pure

The child body runs a single `DBOS.runStep` (name: `handoff.load`) before `runAgent`. For each `handoffSources` entry it reads `runs/{runId}/{upstreamStepId}/output/summary.md` via the injected `workspaceFs` read seam and lists the upstream step's artifact files (a directory walk over the upstream's step tree, reusing the `walkStepArtifacts` traversal), returning the JSON array of handoff inputs — with absent-summary edges already dropped. The checkpoint makes replays compose byte-identical initial messages without re-touching disk (files could have changed; the cache is the source of truth — the same discipline as every other nondeterministic read in the body). Composition after the checkpoint is pure: `composeBriefing(stepHandoffBriefing, input)` per entry, then `initial = [...handoffMessages, { role: "user", content: input.prompt }]`. Briefings precede the task prompt, mirroring the main conversation where standing briefings ride ahead of the turn content. A `handoff.load` failure is non-fatal (logged, empty handoff) — a missing briefing degrades to today's behavior, and failing the step over context enrichment would invert priorities.

### D5: Content is the summary verbatim plus sandbox-canonical artifact paths

The briefing content embeds the upstream interpretation summary markdown unchanged — these summaries are written by a dedicated sub-agent to be compact and grounded in persisted files; unlike run synthesis they are the payload, so no re-summarization, truncation, or reformatting layer. Artifact locations are rendered as sandbox-visible absolute paths (`/{analysisId}/runs/{runId}/{stepId}/…`) because that is the namespace the agent's tools resolve (`sandbox-standards`: absolute `{{ANALYSIS_ROOT}}` paths are canonical); host paths must never leak into prompt content. The artifact list excludes `output/summary.md` itself (it is the briefing body, not a pointer), and the caption's artifact count counts the listed paths. Caption format is fixed: `step {stepId} "{name}" · {n} artifact{s}`.

### D6: Replacement, not duplication — the orientation prompt points at the briefing

"Orient First" step 5 in `sandbox-standards.ts` currently instructs agents to inspect "profiles and upstream outputs" — for dependent steps this is the ad-hoc channel being replaced. The instruction is rewritten: upstream step results arrive in `<briefing name="step-handoff">` blocks; do not spend turns re-discovering what they already state; use `read_file` on a referenced artifact when the analysis needs its contents. The sandbox orientation prompt also gains the one-sentence trust statement the base design requires wherever briefings appear (`<briefing>` blocks are trusted platform-supplied context). `renderStepPrompt` and its field partition stay untouched — the existing field-coverage guard test continues to pin that no runtime content flows through the plan-step prompt. *Alternative considered*: keep both channels ("belt and braces") — rejected; two copies of the same summary teach the model that injected context may be stale duplicate noise, and the change's premise is a single channel.

### D7: No new capability; deltas ride on `conversation-briefings` and `step-interpretation-summary`

The step-handoff definition and workflow-composition rules extend the (in-flight, not yet archived) `conversation-briefings` capability as ADDED requirements — the capability spec exists only inside add-conversation-briefings, so this change's delta must be additive against it, never MODIFIED. The consumption-side requirements (the summary as handoff payload, omission on absence) land as ADDED requirements on `step-interpretation-summary`, whose existing production-side requirements are unchanged. `step-execution-tracking` needs no delta: upstream identity comes from the plan projection and completion gating already lives in the parent's scheduler — the ledger is not consulted.

## Risks / Trade-offs

- **[Stale checkpoint on resume]** A 402-paused run resumed after manual workspace edits replays the checkpointed handoff, not the current disk state. → Accepted: identical to every other checkpointed read in the body; determinism is the contract, and the cached summary is what the upstream step actually produced.
- **[Large upstream summaries inflate the prefix]** A step with many upstreams pins several summaries ahead of its prompt. → Accepted for v1: summaries are size-disciplined by the step-summary-writer's design and the count of upstreams is plan-bounded; token budgets are an explicitly deferred concern of the briefing system.
- **[Double exposure via vector search]** Summaries remain vector-indexed, so an agent could still retrieve what the briefing already gave it. → Accepted: the index serves cross-step and conversational discovery; the orientation rewrite (D6) tells the agent not to re-discover, which is a prompt-discipline mitigation, not a mechanism removal.
- **[handoffSources drift]** `buildChildInput` derives `handoffSources` from the same `input.steps` the scheduler gates on, so a step never starts before its sources completed — but a source that completed *blocked* is impossible (blocked is terminal-failure; fail-fast cancels dependents), leaving only completed-with-no-summary, which omission covers. → No mitigation needed beyond the omission rule.
- **[Trade-off]** The parent input grows a `nameByStepId` map that exists only to decorate captions. Chosen anyway: the caption's human-readable step name is the at-a-glance identity in transcripts and debugging, and the ByStepId projection pattern is established and cheap.

## Migration Plan

Purely additive and unpersisted: no schema change, no envelope change, no backfill. Runs dispatched by an older parent (input lacking `nameByStepId`) or children with absent `handoffSources` compose zero handoff briefings and behave exactly as today — the field is optional-with-empty-default at both layers. Rollback is reverting the code; no stored state refers to handoff briefings.

## Open Questions

- Whether `handoff.load` should cap per-upstream artifact listings (e.g. first N paths + a count) when an upstream produced hundreds of files — leaning yes-at-implementation with a generous cap, since the caption already carries the true count.
