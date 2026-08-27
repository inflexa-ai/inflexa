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

The `applies` conditions are a small closed set that the gate can evaluate: the omics type, the omics subtype, and bounded numeric predicates such as a minimum group size. A condition over a fact that is not established evaluates to `not_evaluable`, and the gate then reports a note, never a rejection. Reason: absence of a fact is a normal condition, and a guess would make the gate dishonest. A categorical match uses a token lattice, because the profile writes free-form terms: accepted tokens contained in the fact pass, a partial overlap is `not_evaluable`, and a disjoint pair fails. The numeric facts never come from the profiler — a product decision. The planner reads the design from its Data Context and supplies the number to `knowledge_search`, and the returned verdict joins the gate obligations.

The corpus lives in a `knowledge/` directory at the repository root, beside `skills/`. Each domain gets one JSON file, plus a manifest with the corpus version. The harness never holds that path. The embedder supplies the directory, in the `skillsDir` pattern. Reason: machine records and agent prose are different layers, and the agent-facing content rule keeps layout out of shared content.

### D3 — The gate lives in `fullyValidate`, and citations must come from the session

`fullyValidate` gains a third stage after the structural checks, and the stage has two arms of different force.

**Citation honesty blocks.** A cited identifier outside the invocation's returned set rejects the plan, with a new `code: "grounding"` issue through the existing rejection loop. An unretrieved citation is unreliable (the ALCE result), the test is mechanical, and it has no false positive.

**Rule acknowledgment advises.** Every applicable rule the plan cites nowhere comes back as advisory content at every severity, and nothing blocks. The first design blocked on an uncited `reject` rule. Three review rounds each found that arm broken in a new way, and each fault traced to the same root: a Phase-1 step carries no typed method, thus the gate cannot tell whether a step obeys a rule. Blocking on the citation was a proxy for compliance. The proxy punished an honest plan, and it rested on a fact supply that Phase 1 does not build. The advisory carries the same rule text to the same reader, and it cannot deadlock a planner.

The verdict map is live and latest-wins. An escalate-only map could never withdraw a verdict, because a rule that stops applying is dropped before it is returned. Thus one exploratory search with a wrong number blocked every later submit. The gate exists exactly when a source is resolved: a failed brief query narrows what is citable, and it never turns the gate off.

Because the advisories are now the product of the second arm, they must survive the trip. They rank `reject` first, and the cap counts only the entries below `reject` severity. They also ride on the accepted outcome. The planner never reads an accepted `submit_plan` result, thus the conversation agent is the first reader that can act on them.

When no knowledge source is resolved, the stage is inert, and the plan flows exactly as today. Reason: the OSS build with no corpus must keep its current behavior, and degradation must be structural, not conditional prose.

### D4 — The `grounding` field is optional on persistence, and the host stamps its corpus

`AnalysisStepSchema` gains `grounding?: [{ id, note?, corpus? }]` — a bare array, not a wrapper object. The persistence schema keeps it optional, thus a historical plan parses, in the established pattern of `resources` (`src/schemas/workflow-state.ts:34`).

The host writes `corpus` at persist time and overwrites whatever reached it, thus the stamp is never model-authored. A rule id alone does not stay resolvable. The corpus moves on, an id is re-versioned or superseded, and a briefing then names text nobody read. Adding the stamp later would be a migration over stored plans, and adding it now is one additive field.

When no source is resolved, the field stays permitted and unenforced, and the seed tells the planner to leave it empty.

### D5 — The brief is host-side and mandatory, the tools are narrow

The seed gains a knowledge-brief block beside the two inventories (`generate-plan.ts:1066`). Before the loop, the host queries `findRules` with the profile facts. It renders the applicable rules with their ids, statements, and severities, and it records the ids into the session set. The block is capped, in the pattern of the data-context cap. An absent source renders one line that says so. Reason: an optional lookup is a lookup that a small model skips — the grounding must ride in the seed.

Two tools, `knowledge_search` and `knowledge_read`, mirror the skill-tool naming. They attach to the planner beside the search tools (`generate-plan.ts:905`) and to the sandbox substrate beside the skill tools (`src/agents/sandbox/shared.ts:305`). Both are `step`-mode, read-only, and self-describing. There is no plan-validation tool: the gate inside `submit_plan` is the one validator, and a second path to the same answer would drift.

### D6 — The observation is a wrapper at assembly, fire-and-forget

`CoreRuntimeDeps` gains `knowledge?: KnowledgeBase`, `knowledgeDir?: string`, and `observeKnowledge?: (event) => void`. The assembly resolves the source, then wraps it one time: each successful read reports `{ queryKind, corpusId, corpusVersion, ruleIds, agentId }` to the callback. The callback contract copies `UsageRecorder`: it must not throw and must not block, and the harness never awaits it. Reason: the consultation happens in chat context and in workflow context alike, thus the hook must sit on the seam, not on one workflow's deps. The host recorder maps the event to provenance later, in its own subsystem.

### D7 — The first corpus is a conversion with real citations

The rules in `skills/bulk-transcriptomics/SKILL.md` (the DE method tree) and `skills/statistical-modeling/SKILL.md` (cross-validation discipline, the cutpoint correction, the Cox PH remedy, the leakage rule) become records. Each record gets a real DOI or PMID during conversion. Examples are the DESeq2, edgeR, and limma-voom method papers for the DE tree, and Ambroise 2002 for the leakage rule. A rule that cannot get a resolvable source does not enter the corpus. Reason: an uncited record would poison the decision chain that this whole change exists to build.

## Risks / Trade-offs

- [A wrong rule misleads a plan] → No rule blocks, thus a wrong record costs an unwanted advisory rather than a refused plan. The corpus review reads each record against its cited source before merge.
- [The advisories are read by nobody] → This is the real exposure of an advisory gate, and it is the reason the delivery is specified: ranked, `reject` exempt from the cap, and carried on the accepted outcome to the conversation agent.
- [The facts a condition tests are not established] → `not_evaluable` reports an advisory that names the remedy, and never an error. The planner supplies a numeric fact through `knowledge_search`, and the profiler is never extended for the gate.
- [The brief inflates the seed] → The block carries id, one-line statement, and severity only, under a byte cap. The renderer sorts `reject`-and-`applies` first and truncates at entry boundaries with a count, thus no entry is ever cut mid-sentence. The full record stays behind `knowledge_read`.
- [A hostile corpus reads other files] → The containment is lexical AND symlink-following, through the same helper the workspace read seam uses. A corpus is still trusted content, thus the check is defense in depth, not a boundary.
- [The CLI drops the source at the step-agent hop] → Both sides of that hop are optional, thus a dropped copy typechecks. The one-line forward lands in this change so the seam is whole the moment the CLI binds a source.
- [The corpus has no distribution path outside the monorepo] → Deliberate for this change. The corpus is repository content, and the shipped-corpus suite skips when the directory is absent. The embedder wiring change carries the distribution, in the `skills/` pattern.
- [The corpus drifts from the prose skills while both exist] → The corpus cites the same sources that the skills name. The later dedup change retires the prose copies. Until then the sandbox path is unchanged, thus no behavior regresses.
- [Schema growth breaks historical plans] → The field is optional on the persistence schema, and the gate binds only on planner output.

## Migration Plan

The change is additive. A historical plan parses because `grounding` is optional. An embedder that wires nothing sees today's behavior exactly. Rollback is to unbind the seam and drop the corpus directory, with no data migration in either direction.

## Open Questions

None that block implementation. The CLI wiring, the prov-kernel event kind, and the prompt dedup are named later changes in their own trees.
