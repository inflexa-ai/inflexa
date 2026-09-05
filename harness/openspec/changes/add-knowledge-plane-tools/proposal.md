# Add the knowledge plane tools and the grounding field

## Why

The planner has no knowledge tool. It selects a method from the weights and an optional literature search. A plan step has no rationale and no citation. Plan validation is structural. The bulk RNA-seq decision tree lives as prose in two full copies and one partial copy, and no copy carries a DOI. Thus a method choice is not grounded, and a smaller model has no procedure to follow.

Phase 0 of the knowledge plane adds three tools and one plan-step field, and nothing else. The remote knowledge service holds cited rules and tested script templates. The tools are the only contract, and the snapshot digest is the only shared identifier. The design is `knowledge-plane-phase-zero.html` at the repository root.

## What Changes

- A `KnowledgeClient` seam in `src/tools/knowledge/client.ts`, with the shipped HTTPS realization. An embedder binds a client at its composition root, or none. Absence is the default state of the open-source host and a normal condition: no tool attaches, and no description of a tool enters the context.
- `knowledge_recommend` and `knowledge_check` in the search tools of the planner, attached only when a client is bound.
- `knowledge_template` in the sandbox allowlist, declared by the bulk transcriptomics agent and the enrichment agent. It attaches only when a client is bound and the agent can write. It writes the rendered script and `output/decision_record.json` through the workspace mutator seam, thus the existing write-file provenance hashes both files.
- An optional `grounding` object on the plan step, in the persistence schema and in the planner schema. The briefing renders it beside the task fields.
- `knowledge_template` as a third member of `MutateToolName`, thus a rendered script carries its writer in the provenance record.

No prompt changes. No seam changes. No kernel change.

## Capabilities

### New Capabilities

- `knowledge-plane-tools`: the client seam, the three tools, their attach conditions, the typed absence, and the grounding field.

### Modified Capabilities

- `per-agent-tool-allowlist`: one allowlist member resolves to nothing when its seam is unbound.
- `planning-enhancements`: the planner search tools gain the two knowledge tools when a client is bound, and the plan step gains the optional grounding field.

## Impact

Harness source:

- `src/tools/knowledge/` (new): the client, the situation schema, the three tools, the barrel.
- `src/tools/research/generate-plan.ts`: `GeneratePlanDeps.knowledge` and the two tools in the search list.
- `src/agents/conversation-agent.ts`: `ConversationAgentDeps.knowledge`, passed to the planner.
- `src/agents/sandbox/types.ts`, `shared.ts`, `bulk-transcriptomics-agent.ts`, `enrichment-agent.ts`: the allowlist member and its resolution over the mutator.
- `src/schemas/workflow-state.ts`, `src/prompts/briefing.ts`, `src/contracts/schemas/chat-parts.ts`: the grounding field and its rendering.
- `src/tools/workspace/mutator.ts`: the tool-name union.
- `src/index.ts`: the client factory, the three tool factories, and the types, for an embedder.

Consumers: the CLI binds the client from a `knowledge` config block and the `INFLEXA_KNOWLEDGE_API_KEY` variable, in its own change. A host that binds no client sees no change.
