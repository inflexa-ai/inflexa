# Design — Knowledge Plane, Phase 1

## Context

Method knowledge lives in prose today, and the planner cannot reach it. The planner seed carries the data profile and two inventories (`src/tools/research/generate-plan.ts:1066`). Validation is `fullyValidate`: the Zod schema, then structural `validatePlan` (`generate-plan.ts:444`). A plan step has no rationale field (`src/schemas/workflow-state.ts:18`). The sandbox agents read skills with a keyword scan (`src/tools/sandbox/skills.ts`). The full architecture is the accepted proposal "The Inflexa Knowledge Plane". Phase 1 is its local foundation.

## Goals / Non-Goals

**Goals:**

- One `KnowledgeBase` seam, with a noop realization and a file-backed realization.
- A cited, machine-readable rule-record format, with a first corpus from two skill packs.
- A grounded plan contract: a `grounding` field, a knowledge brief in the seed, and a gate in `fullyValidate`.
- Knowledge tools for the planner and the sandbox substrate.
- A consultation observation hook for a host recorder.

**Non-Goals:**

- No remote service, no graph store, no embeddings. That is Phase 2.
- No change to the prose skills or to the sandbox prompts. The duplication ends later, when the corpus covers them.
- No CLI wiring and no prov-kernel event kind. Each is a later change in its own subsystem.
- No script templates. That is Phase 3.

## Decisions

### D1 — The seam copies the eyes pattern, with three-way resolution

`KnowledgeBase` is an interface in `src/knowledge/`. `assembleCoreRuntime` resolves it one time with a `resolveCompositionKnowledge(seam, knowledgeDir)` function, in the exact shape of `resolveCompositionEyes` (`src/runtime/assemble.ts:278`). An embedder-bound seam wins. Otherwise a configured directory becomes the file-backed realization. Otherwise the knowledge source is absent, and the tools report that condition. Reason: the precedence pattern already exists, tests can drive it with no DBOS registration, and absence stays a normal condition.

The interface is narrow: `findRules(facts, session)`, `getRule(id, session)`, and `describeCorpus()`. Each read method takes the session, in the seam convention of `ArtifactRegistry` (`src/execution/artifact-registry.ts:78`). `describeCorpus()` gives the corpus identity and version for the observation and for the brief header.

### D2 — Rule records are JSON with a Zod schema, not YAML and not prose

A rule record carries: a stable `id` (`INFLEXA-R-` plus six digits), a `title`, structured `applies` conditions, an `effect` with a `severity` (`reject`, `warn`, `note`), an optional `recommendation`, an `evidence` block, and a `version`. The `evidence` block must hold at least one resolvable locator (a DOI, a PMID, or a URL), in the discipline of the target-dossier evidence rule. Reason for JSON: Zod validates it with no new dependency, and the repository adds no YAML parser.

The `applies` conditions are a small closed set that the gate can evaluate against the persisted data profile: the omics type, the omics subtype, and bounded numeric predicates such as a minimum group size. A condition over a fact that the profile does not hold evaluates to `not_evaluable`, and the gate then reports a note, never a rejection. Reason: absence of a fact is a normal condition, and a guess would make the gate dishonest.

The corpus lives in a `knowledge/` directory at the repository root, beside `skills/`. Each domain gets one JSON file, plus a manifest with the corpus version. The harness never holds that path. The embedder supplies the directory, in the `skillsDir` pattern. Reason: machine records and agent prose are different layers, and the agent-facing content rule keeps layout out of shared content.

### D3 — The gate lives in `fullyValidate`, and citations must come from the session

`fullyValidate` gains a third stage after the structural checks. The stage receives the set of rule identifiers that this invocation returned to the planner (the brief and the tool calls both record into that set, in the closure pattern of `PlannerTrace`). The stage rejects a cited identifier outside the set, because an unretrieved citation is unreliable (the ALCE result). The stage then requires an acknowledgment of each `reject` rule that applies: a plan that cites the rule nowhere is rejected. The issue carries a new `code: "grounding"`, the rule id, and the rule statement. It flows through the existing rejection loop of `submit_plan`. A `warn` or `note` outcome goes back as advisory text, and it never blocks. The gate enforces the acknowledgment, not method compliance, because a Phase-1 step carries no typed method the gate could hold to a rule.

When no knowledge source is resolved, the stage is inert, and the plan flows exactly as today. Reason: the OSS build with no corpus must keep its current behavior, and degradation must be structural, not conditional prose.

### D4 — The `grounding` field is optional on persistence, present on planner output

`AnalysisStepSchema` gains `grounding?: { rules: [{ id, note? }] }`. The persistence schema keeps it optional, thus a historical plan parses, in the established pattern of `resources` (`src/schemas/workflow-state.ts:34`). When a knowledge source is resolved and the brief returned applicable rules, the gate rejects a plan whose method-bearing steps cite nothing. When the source is absent, the field stays permitted and unenforced. Reason: the citation duty must bind exactly when citations are possible.

### D5 — The brief is host-side and mandatory, the tools are narrow

The seed gains a knowledge-brief block beside the two inventories (`generate-plan.ts:1066`). Before the loop, the host queries `findRules` with the profile facts. It renders the applicable rules with their ids, statements, and severities, and it records the ids into the session set. The block is capped, in the pattern of the data-context cap. An absent source renders one line that says so. Reason: an optional lookup is a lookup that a small model skips — the grounding must ride in the seed.

Two tools, `knowledge_search` and `knowledge_read`, mirror the skill-tool naming. They attach to the planner beside the search tools (`generate-plan.ts:905`) and to the sandbox substrate beside the skill tools (`src/agents/sandbox/shared.ts:305`). Both are `step`-mode, read-only, and self-describing. There is no plan-validation tool: the gate inside `submit_plan` is the one validator, and a second path to the same answer would drift.

### D6 — The observation is a wrapper at assembly, fire-and-forget

`CoreRuntimeDeps` gains `knowledge?: KnowledgeBase`, `knowledgeDir?: string`, and `observeKnowledge?: (event) => void`. The assembly resolves the source, then wraps it one time: each successful read reports `{ queryKind, corpusId, corpusVersion, ruleIds, agentId }` to the callback. The callback contract copies `UsageRecorder`: it must not throw and must not block, and the harness never awaits it. Reason: the consultation happens in chat context and in workflow context alike, thus the hook must sit on the seam, not on one workflow's deps. The host recorder maps the event to provenance later, in its own subsystem.

### D7 — The first corpus is a conversion with real citations

The rules in `skills/bulk-transcriptomics/SKILL.md` (the DE method tree) and `skills/statistical-modeling/SKILL.md` (cross-validation discipline, the cutpoint correction, the Cox PH remedy, the leakage rule) become records. Each record gets a real DOI or PMID during conversion. Examples are the DESeq2, edgeR, and limma-voom method papers for the DE tree, and Ambroise 2002 for the leakage rule. A rule that cannot get a resolvable source does not enter the corpus. Reason: an uncited record would poison the decision chain that this whole change exists to build.

## Risks / Trade-offs

- [A wrong `reject` rule blocks a valid plan] → Only `reject` blocks, and `warn` and `note` advise. The corpus review reads each record against its cited source before merge.
- [The profile lacks the facts a condition tests] → `not_evaluable` reports a note and never blocks, thus the gate degrades to advice, not to error.
- [The brief inflates the seed] → The block carries id, one-line statement, and severity only, under a byte cap. The full record stays behind `knowledge_read`.
- [The corpus drifts from the prose skills while both exist] → The corpus cites the same sources that the skills name. The later dedup change retires the prose copies. Until then the sandbox path is unchanged, thus no behavior regresses.
- [Schema growth breaks historical plans] → The field is optional on the persistence schema, and the gate binds only on planner output.

## Migration Plan

The change is additive. A historical plan parses because `grounding` is optional. An embedder that wires nothing sees today's behavior exactly. Rollback is to unbind the seam and drop the corpus directory, with no data migration in either direction.

## Open Questions

None that block implementation. The CLI wiring, the prov-kernel event kind, and the prompt dedup are named later changes in their own trees.
