# Knowledge Plane, Phase 1

## Why

Method selection has no ground today. The planner never sees the skill packs, a plan step carries no rationale and no citation, and plan validation covers structure only. Thus a wrong method passes validation, and the decision chain that a defensible package needs does not exist. Phase 1 builds the local foundation: a knowledge seam, cited rule records, a grounded plan contract, and an observation of each consultation. No remote service exists in this phase.

## What Changes

- Add a `KnowledgeBase` capability seam: an interface, a noop realization, and a local file-backed realization over cited rule records. `assembleCoreRuntime` resolves one realization with the same precedence as the eyes seam. `index.ts` exports the pair.
- Define a machine-readable rule-record format: a stable identifier, applicability conditions, an effect, a severity, sources with DOI or PMID, and a version. Convert the statistics rules from the `bulk-transcriptomics` and `statistical-modeling` skill packs into records. The prose skills stay in place in this phase.
- Add knowledge tools for the planner and the sandbox substrate. The tools find rules by data facts, and they read one full rule. Absence of a knowledge source is a normal condition, and the tools report it.
- Add a `grounding` field to the plan step schema. The planner cites rule identifiers on each method choice, and the host stamps the corpus identity onto each citation at persist time.
- Add a grounded gate to plan validation, with two arms of different force. The gate rejects a citation that the knowledge source did not return in this session, and that is the one blocking fault. Every applicable rule that the plan cites nowhere comes back as an advisory, and no advisory blocks a plan.
- Add a host-side knowledge brief to the planner seed, beside the reference census and the package census. The brief carries the rules that apply to the profiled data.
- Add a knowledge-consultation observation hook. The harness reports each consultation through an optional callback in the deps, in the pattern of the run-observation seam. A report carries the query, the corpus version, and the returned rule identifiers.

## Capabilities

### New Capabilities

- `knowledge-base-seam`: the `KnowledgeBase` interface, the noop and local file-backed realizations, the resolution precedence at assembly, and the consultation observation hook.
- `knowledge-rule-records`: the cited rule-record format, its validation, and the contract for a local rule corpus that the file-backed realization reads.
- `knowledge-tools`: the typed knowledge tools, their attachment to the planner and to the sandbox substrate, and their behavior when no knowledge source is bound.

### Modified Capabilities

- `planning-enhancements`: the plan step schema gains a `grounding` field, the planner seed gains the knowledge brief, and `fullyValidate` gains the citation gate and the rule-condition comparison.

## Impact

- `harness/src/schemas/` — the plan step schema and the plan validators.
- `harness/src/tools/research/generate-plan.ts` — the seed assembly, the planner tools, and the gate.
- `harness/src/agents/sandbox/shared.ts` — the sandbox tool substrate.
- `harness/src/runtime/assemble.ts`, `harness/src/index.ts` — the seam resolution and the public surface.
- A new rule corpus at the repository root, converted from `skills/bulk-transcriptomics` and `skills/statistical-modeling` prose. The harness reads it through a configured directory, in the pattern of `skillsDir`.
- Out of scope, named for the record: the CLI wiring of the seam and the prov-kernel event kind are later changes in `cli/` and `prov-kernel/`, each in its own spec tree. The remote service is Phase 2.
