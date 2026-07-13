# Resolve audited harness wiring gaps

## Why

A team audit of the harness (comments/docs vs. code, dead/unwired modules,
tool/prompt/skill→agent linkage) surfaced four clusters where the shipped code
diverges from what the specs, prompts, and comments promise. Two are **spec
compliance gaps** (the code omits behaviour a spec mandates); one is an
**unspecified half-built feature** that instructs the model to call tools that
do not exist; one is a **tracking question** about a deferred capability. Each
needs a direction decision before implementation — this change is the decision
gate. Trivial doc corrections and clearly-dead-code deletions from the same
audit are handled directly on the branch and are **not** part of this change.

The unifying defect: the harness advertises capabilities it does not wire.
`validateAgentSkills`, the graceful-shutdown sequence, and the
connection-budget guard are named in specs as live runtime components but are
reachable only from tests; the report-builder and target-assessment prompts
direct the model at `skill_*` / retrieval tools the assembled agent never
receives. The model is told to call tools that either do not exist or are not
in its roster, so those instructions fail silently at runtime and waste tokens.

## What Changes

Four decisions, detailed with options, trade-offs, and a recommendation in
[`design.md`](./design.md). Each is independently resolvable; the numbering is
priority order.

- **Decision 1 — Regulatory grounding feature: finish or remove.** The
  target-assessment synthesis briefs instruct the model to call
  `search_regulatory_guidance` (no such tool is defined anywhere) and
  `find_approval_precedent` (defined at `tools/bio/find-approval-precedent.ts`
  but wired to no agent). The synthesis path (`structured-llm.ts`) forces a
  single-shot `submit` tool with `toolChoice`, so the agent **cannot** call any
  retrieval tool regardless. Supporting scaffolding is inert: the
  `cortex_regulatory_chunks` table ships with a comment claiming a tool that
  does not exist is "wired into the synthesis agents"; the 90-day corpus
  boot-refresh (`tasks/regulatory-corpus-boot-refresh.ts`) has no caller; corpus
  filtering (`lib/regulatory-corpus.ts:155`) is "not yet applied". The feature
  is **absent from every spec**. Decide: build it properly (new spec + a
  tool-calling synthesis pass + implement the missing tool + wire refresh) or
  descope it (strip the tool-call instructions, remove the orphan tool and inert
  corpus code, correct the DB comment).

- **Decision 2 — Boot lifecycle & observability ownership.** Spec-mandated
  components are built but never invoked in-process: `validateAgentSkills`
  (`agent-skill-assignment` SHALLs a boot-time check that fails fast on a
  `meta.skills` typo — zero callers); the graceful-shutdown sequence
  (`runtime/shutdown.ts`, spec'd in `harness-durable-runtime` and
  `structured-logging`); the `connection-budget` boot guard; the
  `lifecycle.ts` drain flag (never read or set); and `initOtel`
  (`lib/otel.ts`, whose own comment claims it is "called explicitly from
  index.ts" — it is not, so the OTel metrics other specs require, e.g.
  `harness-thread-history`, emit into an uninitialized SDK). Decide **who owns
  the boot/shutdown sequence** — `assembleCoreRuntime` (harness-owned lifecycle)
  or the embedder — then wire these components at that seam and fix the stale
  `otel.ts` comment.

- **Decision 3 — Report-builder skill reachability.** The report-builder prompt
  (`prompts/report-builder.ts:48,57`) tells the model to `skill_search` /
  `skill_read` on the `report-html` pack, but `createSkillTools` is wired only
  for sandbox agents (`agents/sandbox/shared.ts:301`); report-builder's roster
  (`execution/report-runner.ts:178-197`) has no skill tools, so every such call
  fails. Separately, the `report-pdf` and `report-pptx` packs under `skills/`
  are referenced by nothing in `harness/src`. Decide: grant report-builder the
  skill tools (declare `report-html` on it) **or** strip the skill instructions
  from its prompt; and keep or remove the two orphan packs.

- **Decision 4 — 402-resume path: confirm or retire.** The parent-resume
  machinery (`workflows/resume-execute-analysis.ts`, `prepareExecuteAnalysisResume`)
  is implemented and tested but has no reachable caller and is not on the public
  surface; its doc says the entry point "is owned by change 9." Confirm change 9
  is still planned (leave as tracked scaffolding) or retire the resume code.

## Capabilities

### Modified Capabilities

- `agent-skill-assignment` — the boot-time skill-validation requirement is
  unmet in code; Decision 2 wires it (or the spec is relaxed if ownership moves
  to the embedder).
- `structured-logging` / `harness-durable-runtime` — both name the
  graceful-shutdown sequence and connection-budget guard as live runtime
  components; Decision 2 makes that true or corrects the specs.
- `iterative-report` — Decision 3 settles whether the report-builder agent has
  skill-tool access matching its prompt.

### Potentially Added Capabilities

- A new `regulatory-grounding` (or `target-assessment-synthesis-grounding`)
  capability spec **iff** Decision 1 chooses to build the feature. If it chooses
  to descope, no spec is added and the scaffolding is removed.

## Impact

- **Prompts**: `prompts/target-assessment/briefs/*` (Decision 1),
  `prompts/report-builder.ts` (Decision 3).
- **Agents/tools**: `tools/bio/find-approval-precedent.ts`,
  `workflows/target-assessment/synthesis/*`, `lib/structured-llm.ts` (Decision 1);
  `execution/report-runner.ts`, `agents/report-builder.ts` (Decision 3).
- **Runtime**: `runtime/assemble.ts`, `runtime/{shutdown,lifecycle,connection-budget}.ts`,
  `lib/otel.ts`, `agents/sandbox/validate-skills.ts` (Decision 2).
- **State/data**: `state/init.ts` (regulatory table + comment),
  `tasks/regulatory-corpus-boot-refresh.ts`, `lib/regulatory-corpus.ts` (Decision 1).
- **Workflows**: `workflows/resume-execute-analysis.ts` (Decision 4).
- **Docs**: `CLAUDE.md` / `CONTEXT.md` seam & lifecycle sections track whichever
  ownership Decision 2 picks.
- **Skills content** (repo root): `skills/report-pdf`, `skills/report-pptx`
  (Decision 3).
