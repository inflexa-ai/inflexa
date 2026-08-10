## Context

The resolution seam is ready: `assembleCoreRuntime` builds a type-keyed registry, `conversation` is its one entry, and `report` refuses (`src/runtime/assemble.ts:191`). The spec reserves the slot for this agent. The spawn writes a `report` thread with `parentThreadId` and `parentSeq` (`src/app/spawn-report-session.ts:141-152`), and it composes no context.

The resolution requirement returns assembled singletons. But the authoring tools close over one draft and one snapshot (`src/tools/report-authoring/authoring-tools.ts:311-313`). Thus the central problem of this change is per-thread state behind a singleton definition.

The renderer is a pure function `renderReportPage(document, values)` (`src/report-render/render.ts:34`). Nothing bridges a `ResolvedValue` into a `RenderValues` entry, and nothing consumes the renderer in production.

## Goals / Non-Goals

**Goals:**

- One `AgentDefinition` for the `report` thread type, registered at assembly.
- A session runtime that binds the snapshot and the draft to `scope.threadId`.
- A render-and-preview tool over the `ReferenceResolver` and `PreviewPublisher` seams.
- The prompt module, with the conversational composition.
- A read-only roster toward the analysis, held by construction.

**Non-Goals:**

- The mechanical gate and the visual examination (#310).
- A durable draft store. A restart loses an in-progress draft.
- A skill pack and the design system (#311).
- The parent-transcript tool. The user deferred it on the issue.
- Context composition for the first turn (#223). The agent orients with its read tools.
- A change to the old report path, its agent, or its tools.

## Decisions

### D1. The new agent id is `report-session`, and the old id stays untouched.

The old templating agent holds `report-builder` (`src/agents/report-builder.ts:25`) until #313 removes it. Two agents with one id would collide in `SKILL_DECLARING_AGENTS` and in provenance. Thus the new definition is `src/agents/report-session-agent.ts` with the id `report-session`.

### D2. The session runtime is a thread-keyed binder inside the tools.

The registry returns one assembled definition. Thus the per-session state moves behind the tool boundary: the runtime holds a map from `threadId` to the session cell. A tool reads `ctx.session.scope.threadId` (`src/auth/types.ts:37`) at call time, and it reaches its cell through the binder. A call with no `threadId` in the scope refuses as typed data.

The alternative was a per-thread agent construction at turn time. That breaks the singleton requirement of the resolution spec, and it rebuilds every tool on every turn.

### D3. The snapshot mints lazily, one time for each thread.

The binder mints with `mintReportSnapshot(pool, analysisId)` at the first call that needs the snapshot, and it caches the result in the cell. The mint runs after the spawn anchor, thus an artifact from the window between the spawn and the first call enters the membership. The skew is bounded and recorded: the version record of #310 pins whatever snapshot the session used, and a stricter anchor can move into the spawn later without a contract change here.

### D4. The draft is in-memory per thread, and loss on restart is accepted.

The cell holds the authoring tool set of #305, made with `createReportAuthoringTools({ snapshot })`. The draft lives in that closure. A restart empties the binder, and the agent starts a fresh draft. The durable artifact is the recorded version (#308), and a durable draft store is a separate decision for a later issue.

### D5. The preview tool renders only a finished draft, and absence degrades as data.

`renderReportPage` takes a `ReportDocument`, and a mid-composition draft is not one. Thus the preview tool runs the finish first. A gap list returns as data, and the agent repairs the draft. On a pass, the tool resolves each reference through the injected `ReferenceResolver`, bridges the values into `RenderValues`, renders, and publishes through `PreviewPublisher`.

Two absences are normal conditions: a resolver realization that cannot give values, and an unavailable publisher. Each returns a typed outcome that names the absent seam. Nothing throws, and nothing substitutes a fixture.

### D6. The value bridge is a small pure module beside the renderer.

The bridge maps a `ResolvedValue` onto a `RenderValues` entry: a scalar to a metric value, rows to a table, and a file echo to a `figure.src` string through a caller-supplied policy. It lives in `src/report-render/` as a pure module, because the renderer owns the `RenderValues` contract. The preview tool supplies the source policy, because the page and its asset access are a session concern.

### D7. The roster is the issue list, and the rule holds by construction.

The roster wires: the four workspace read tools, the workspace search, `inspect_run`, `inspect_data_profile`, the eight authoring tools, and the preview tool. It wires no planner, no run launcher, no working-memory write, and no sandbox surface. Thus "no tool starts a run or changes an analysis" is not a runtime guard. It is the absence of the wiring.

### D8. The prompt composes with identity and conversation.

The agent talks to the user, thus `composeSystemPrompt(reportSessionPrompt, { identity: true, conversational: true })`, the same composition as the conversation agent. The prompt obeys the prompt conventions: it names tools and mechanisms, it names no dataset and no path, and it carries an explicit "Do NOT" list. No per-session value enters the system prompt, thus the prefix stays cacheable.

## Risks / Trade-offs

- [The binder map grows with threads] → the cell count equals the report threads served by one process. A later eviction rule can land without a contract change.
- [The lazy mint admits post-anchor artifacts] → D3 records the skew, and the recorded version pins the snapshot that was used. The tightening path stays open.
- [The preview needs a resolver realization that #310 ships] → D5 degrades as typed data. The agent works today, and the preview completes when the realization lands.
- [Two report agents exist until #313] → distinct ids and distinct files. The old path reads nothing from the new one.

## Migration Plan

The work is additive. The registration makes `forThread("report")` succeed, but no production path spawns or serves a `report` thread until #314. A revert is one commit.

## Open Questions

- None. The exact preview output shape and the eviction rule are implementation details for the tasks phase.
