# Tasks

## 1. The join

- [x] 1.1 Add `readPoolInventory` to `EnvironmentPaths`, and add `pool` to `EnvironmentSource`.
- [x] 1.2 Give each package of a step the state `installed`, `in_store`, or `absent` in `joinEnvironment`. Resolve the pool names with `queryPackages`.
- [x] 1.3 Give no state to a package that the sandbox does not hold when the pool inventory is not bound or cannot answer.
- [x] 1.4 Look up a package in the track that the service names. Give `entry` when the store holds the name in both tracks.
- [x] 1.5 Read the image record at the container mountpoint of the store when the host gives no path.

## 2. The wiring

- [x] 2.1 Add `readPoolInventory` to `KnowledgeToolsDeps`, and give it to `knowledge_recommend`.
- [x] 2.2 Give the pool inventory of the planner to `createKnowledgeTools` in `buildPlannerSearchTools`.
- [x] 2.3 Name the three states in the description of `knowledge_recommend`.

## 3. Verification of the package

- [x] 3.1 Change the environment tests in `src/tools/knowledge/test/knowledge-tools.test.ts` to the three states. Add a test for a pool inventory that is not bound, that is unavailable, or that fails. Add a test for the track lookup.
- [x] 3.2 Add a test in `src/tools/research/test/generate-plan.test.ts` for the pool inventory of the planner in the recommend answer.
- [x] 3.3 Run `bun run format:file` on each changed file in `src/`. Then run the typecheck, the lint, `format:check`, `dupes`, and the tests of the harness and of the cli.
