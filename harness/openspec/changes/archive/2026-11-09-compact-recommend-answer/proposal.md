# Proposal

## Why

In the run of analysis GSE136961, the `knowledge_recommend` answer had 51,794 characters. The loop cuts a tool result of more than 32,768 characters, thus the planner got the first 4,096 characters and the last 8,192 characters. The planner then did three `read_tool_output` calls to read the middle. The full views of the 23 claims held 39,033 characters of the answer: the statements held 18,264, and the evidence held 11,502.

## What Changes

- The model-facing answer of `knowledge_recommend` gives one heading for each claim: the id, the title, the strength, and the severity. The heading of a claim with no title gives the statement.
- The call record of the tool keeps the full view of each claim. The fold of the record gives the full answer to the memory of the planner, thus the plan keeps the full claim views as before.
- The new tool `knowledge_claims` gives the statement and the evidence of up to 8 claims, by claim id. It reads a claim shelf that the fold of each recommend answer fills, and it does not call the service.
- `createKnowledgeTools` gives `knowledge_claims` beside `knowledge_recommend`, over one shelf. `createKnowledgeRecommendTool` takes the shelf as a necessary dependency.
- The cli gives the conversation agent `knowledge_claims` beside `knowledge_recommend`.

With the answer of GSE136961, the model-facing answer has about 17,700 characters.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `knowledge-plane-tools`: the recommend answer gives a heading of each claim, and `knowledge_claims` gives the full view on demand.

## Impact

- `src/tools/knowledge/claims.ts` is new. `src/tools/knowledge/recommend.ts`, `src/tools/knowledge/index.ts`, `src/index.ts`, and `src/tools/research/generate-plan.ts` change.
- `KnowledgeRecommendDeps` gets the necessary `shelf` field. An embedder that calls `createKnowledgeRecommendTool` must give a shelf, and it must give `knowledge_claims` over the same shelf.
- `cli/src/modules/harness/runtime.ts` gives the two tools to the conversation agent.
- The descriptions of `knowledge_recommend` and of the new tool change the tool set, thus `knowledgeToolDefinitionHash` changes.
- A stored plan does not change. The memory of the planner reads the call record, and the call record holds the full answer.
