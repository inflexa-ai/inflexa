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
- A skill pack and the design system (#311).
- The parent-transcript tool. The user deferred it on the issue.
- Context composition for the first turn (#223). The agent orients with its read tools.
- A change to the old report path, its agent, or its tools.

## Decisions

### D1. The new agent id is `report-session`, and the old id stays untouched.

The old templating agent holds `report-builder` (`src/agents/report-builder.ts:25`) until #313 removes it. Two agents with one id would collide in `SKILL_DECLARING_AGENTS` and in provenance. Thus the new definition is `src/agents/report-session-agent.ts` with the id `report-session`.

### D2. The per-session state lives in one durable row, behind the tool boundary.

The registry returns one assembled definition. Thus the per-session state moves behind the tool boundary, and it lives in a durable session-state row keyed by the thread id. A tool reads `ctx.session.scope.threadId` (`src/auth/types.ts:37`) at call time, loads the row, applies the operation, and persists the result. A call with no `threadId` in the scope refuses as typed data.

Two alternatives fell. A per-thread agent construction at turn time breaks the singleton requirement of the resolution spec. An in-process map keyed by thread dies with the process, and chat runs one replica for each turn on a managed host. Thus memory cannot be the home of the state, and a cache is a later option.

### D3. The snapshot mints at session start, one time for each thread, and the row keeps it.

The runtime exposes an idempotent `ensureSessionState(threadId)`. The first call mints with `mintReportSnapshot(pool, analysisId)`, and it writes the result into the session-state row. The serving path of a report turn runs the operation at the start of the turn, thus the mint anchors at the first served turn. Each tool also runs the operation, thus a call order cannot break the state, and the row guard keeps the mint single.

Every later call reads the stored snapshot, across restarts and replicas alike. Thus the membership never changes after the mint, and the frozen anchor holds. A mint failure returns as typed data, and a later call mints again, because no row was written.

### D4. The authoring tools change to a storage-backed gateway, because no caller exists.

`createReportAuthoringTools` closes over one draft and one snapshot (`src/tools/report-authoring/authoring-tools.ts:311-313`), and nothing calls it yet. Thus the factory signature changes freely: it takes a session-state gateway (load the state by thread id, persist the document) in place of the closure holder. A landed operation persists before it reports `applied: true`, thus a reported landing is never lost. The pure core of #305 stays untouched, and the tool ids, the envelopes, and the refusal shapes stay as they are.

### D5. The preview tool renders only a finished draft, and absence degrades as data.

`renderReportPage` takes a `ReportDocument`, and a mid-composition draft is not one. Thus the preview tool runs the finish first. A gap list returns as data, and the agent repairs the draft. On a pass, the tool resolves each reference through the injected `ReferenceResolver`, bridges the values into `RenderValues`, and renders.

The page lands on disk, in the session directory `report-sessions/{threadId}/` under the workspace root. That namespace belongs to the new path alone, and the old path keeps `previews/` and `reports/`. The tool returns the page path as data, thus a local host shows the page with no seam. `PreviewPublisher.mintPreviewAccess` carries no content (`src/tools/report/preview-publisher.ts:39-41`), thus it serves only the hosted surface. When a realization is present, the tool also returns the minted access.

Two absences are normal conditions: a resolver realization that cannot give values, and an unavailable publisher. Each returns a typed outcome that names the absent seam. Nothing throws, and nothing substitutes a fixture.

### D6. The value bridge is a small pure module beside the renderer.

The bridge maps a `ResolvedValue` onto a `RenderValues` entry: a scalar to a metric value, rows to a table, and a file echo to a `figure.src` string through a caller-supplied policy. It lives in `src/report-render/` as a pure module, because the renderer owns the `RenderValues` contract. The preview tool supplies the source policy, because the page and its asset access are a session concern.

The policy of the preview tool is concrete: it stages the bound image into `assets/` beside the page, and the `src` is that relative path. Thus the page directory is self-contained, a local viewer and a hosted surface read the same bytes, and no workspace layout leaks into the markup. A data URI fell, because a large figure makes a page of many megabytes.

### D7. The roster is the issue list, and the rule holds by construction.

The roster wires: the four workspace read tools, the workspace search, `inspect_run`, `inspect_data_profile`, the eight authoring tools, and the preview tool. It wires no planner, no run launcher, no working-memory write, and no sandbox surface. Thus "no tool starts a run or changes an analysis" is not a runtime guard. It is the absence of the wiring.

### D8. The prompt composes with identity and conversation.

The agent talks to the user, thus `composeSystemPrompt(reportSessionPrompt, { identity: true, conversational: true })`, the same composition as the conversation agent. The prompt obeys the prompt conventions: it names tools and mechanisms, it names no dataset and no path, and it carries an explicit "Do NOT" list. No per-session value enters the system prompt, thus the prefix stays cacheable.

## Risks / Trade-offs

- [Two concurrent turns on one thread race the row] → the last write wins, and a turn on one thread is serial in practice. A version guard can land later without a contract change.
- [A read and a write on each tool call cost a round trip] → the document is small, and correctness across replicas outweighs the trip. A cache is a later option.
- [The lazy mint admits post-anchor artifacts] → D3 records the skew, and the recorded version pins the stored snapshot. The tightening path stays open.
- [The preview needs a resolver realization that #310 ships] → D5 degrades as typed data. The agent works today, and the preview completes when the realization lands.
- [Two report agents exist until #313] → distinct ids and distinct files. The old path reads nothing from the new one.

## Migration Plan

The work is additive. The registration makes `forThread("report")` succeed, but no production path spawns or serves a `report` thread until #314. A revert is one commit.

## Open Questions

- None. The exact preview output shape and the eviction rule are implementation details for the tasks phase.
