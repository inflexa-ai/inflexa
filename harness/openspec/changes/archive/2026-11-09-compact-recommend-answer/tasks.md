# Tasks

## 1. The answer

- [x] 1.1 Give the model a heading of each claim in the answer of `knowledge_recommend`, and keep the full answer in the call record.
- [x] 1.2 Give the statement in the heading of a claim with no title.
- [x] 1.3 Keep the claim views of each answer on the shelf in the fold of the call record.

## 2. The claims tool

- [x] 2.1 Add the claim shelf and `knowledge_claims` in `src/tools/knowledge/claims.ts`.
- [x] 2.2 Give `knowledge_claims` beside `knowledge_recommend` in `createKnowledgeTools`, over one shelf.
- [x] 2.3 Export the shelf and the tool from `src/index.ts`, and give the two tools to the conversation agent of the cli.
- [x] 2.4 Name `knowledge_claims` in the description of `knowledge_recommend`.

## 3. Verification of the package

- [x] 3.1 Add tests in `src/tools/knowledge/test/knowledge-tools.test.ts` for the headings, the call record, a claim with no title, and a read through the loop.
- [x] 3.2 Change the order test of the planner tools in `src/tools/research/test/generate-plan.test.ts`.
- [x] 3.3 Run `bun run format:file` on each changed file in `src/`. Then run the typecheck, the lint, `format:check`, `dupes`, and the tests of the harness and of the cli.
