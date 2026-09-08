## 1. One section teaches the grammar

- [ ] 1.1 In `src/prompts/planner.ts`, move the block "The Packages of Each Step" out of `plannerPrompt` into an exported `packagesSection(): string`. Call it from `plannerPrompt` in the same place, so that the planner text stays the same.
- [ ] 1.2 In `src/prompts/planner.test.ts`, make sure that the existing assertions still hold. Add one assertion that `packagesSection()` names the prefixed form.

## 2. The router

- [ ] 2.1 In `src/tools/ad-hoc-router.ts`, add `packages: z.array(z.string()).optional()` to `routeSchema`.
- [ ] 2.2 In the same file, add `DroppedPackage` (`{ entry: string; reason: "unparsable" | "absent" }`), and add `packages: readonly string[]` and `droppedPackages: readonly DroppedPackage[]` to `AdHocRoute`. Both are always present.
- [ ] 2.3 In the same file, add `resolvePackages?: (names: readonly string[]) => Promise<readonly CheckedPackage[] | null>` to `AdHocRouterDeps`. Import `CheckedPackage` from `../tools/sandbox/list-available-packages.js`.
- [ ] 2.4 In `routeAdHocRequest`, add `packagesSection()` to the system prompt, plus one sentence: the language of the selected specialist and the request text decide the track of a name that both ecosystems hold. Change the first sentence of the prompt and the description of `submit_route`, so that both name the packages beside the specialist and the resources.
- [ ] 2.5 In the same function, read `candidate.packages`. Keep each string entry that `parseQuery` accepts, and record each other entry as `unparsable`, a non-string entry rendered with `String`. Keep the first of two equal entries. A missing field gives an empty array. Never set `fallbackClass` for a package failure.
- [ ] 2.6 In the same function, when `deps.resolvePackages` is bound and the kept list is not empty, call it one time. Apply the rule of design D3. A row matches an entry by its `requested` field, and any present row keeps the entry. An absent answer with a suggestion replaces the spelling through `formatQuery`. An absent answer with no suggestion drops the entry as `absent`. A `null` answer keeps every entry. Catch a throw of the dep, and treat it as `null`.
- [ ] 2.7 In the same function, add `packages` and `droppedPackages` to the `ad hoc route selected` log record and to the returned route.

## 3. The inventory read

- [ ] 3.1 In `src/tools/sandbox/list-available-packages.ts`, move the read of the sections out of the `execute` of the tool into an exported `readInventorySections(deps: ListAvailablePackagesDeps): Promise<readonly Section[] | null>`. It merges the image record, reads the pool inventory when bound, else the first readable farm lock, and gives `null` when the source is unavailable.
- [ ] 3.2 In the same file, make the `execute` of the tool call `readInventorySections`. Keep the two `available: false` notes, so that the answer to a model does not change.
- [ ] 3.3 In `src/tools/execute-analysis.ts`, add the three optional fields `farmLockFile`, `imagePackagesFile`, and `readPoolInventory` to `ExecuteAnalysisToolDeps`, typed through `Pick<EnvironmentStorePaths, ...>`.
- [ ] 3.4 In `persistedAdHocPlan`, build `resolvePackages` when at least one inventory dep is bound: read the sections with `readInventorySections`, and answer the `checked` rows of `queryPackages(sections, { names })`, or `null` when the read gives `null`. Pass it to `routeAdHocRequest`.
- [ ] 3.5 In `src/agents/conversation-agent.ts`, pass `farmLockFile`, `imagePackagesFile`, and `readPoolInventory` to `createExecuteAnalysisTool`, the same as the call to `createGeneratePlanTool` above it.

## 4. The plan and the launch

- [ ] 4.1 In `buildAdHocPlan`, write `packages: route.packages` on the step.
- [ ] 4.2 In the same function, compose the caveats of design D5: the routing fallback, then one caveat that names each dropped entry with its reason, then one caveat when `packages` is empty. Keep `undefined` when no caveat applies.
- [ ] 4.3 In `linkPlanPackages`, return the number of queries that reach the seam, and zero when the seam is unbound or the union is empty.
- [ ] 4.4 In the `execute` of the tool, add `packageQueries` with that number to the `analysis launched` log record.
- [ ] 4.5 In `src/prompts/briefing.ts`, rewrite the comment above `"packages"` in `STEP_NON_TASK_FIELDS`, so that it states a premise that holds for every step, the ad-hoc step included.

## 5. The tests

- [ ] 5.1 In `src/tools/ad-hoc-router.test.ts`, add a test: a valid `packages` list passes through, and `droppedPackages` is empty. Capture the system prompt in the provider stub, and assert that it names the prefixed form and the track rule of the selected specialist.
- [ ] 5.2 In the same file, add a test: an entry that is a path is dropped as `unparsable`, the specialist and the resources stay, and `fallbackClass` is absent.
- [ ] 5.3 In the same file, add a test with a bound `resolvePackages`: an absent name with no suggestion is dropped as `absent`, an absent name with a suggestion takes the suggestion, and a present name stays.
- [ ] 5.4 In the same file, add a test: a `resolvePackages` that answers `null` keeps every parsed entry, and a missing `packages` field gives an empty array.
- [ ] 5.5 In `src/tools/execute-analysis.test.ts`, extend `routeProvider` with an optional `packages` argument.
- [ ] 5.6 In the same file, add an ad-hoc test with a bound seam: the seam receives the router packages as queries, and the launch proceeds.
- [ ] 5.7 In the same file, add an ad-hoc test: the seam answers `collision` for a bare both-track name, the launch refuses with the two prefixed forms, and no run reserves.
- [ ] 5.8 In the same file, add an ad-hoc test: the router returns no packages, the seam is not called, and the stored step carries an empty array and the caveat.
- [ ] 5.9 In the same file, add a unit test of `buildAdHocPlan`: the packages land on the step, a dropped entry gives its caveat, and an empty list gives the no-packages caveat.
- [ ] 5.10 In `src/tools/sandbox/catalog-tools.test.ts`, add one test of `readInventorySections`: the pool reader wins, the image record merges, and an unavailable pool gives `null`.

## 6. Verification

- [ ] 6.1 Run `bun test` on each of these files, one at a time, in `harness/`: `src/tools/ad-hoc-router.test.ts`, `src/tools/execute-analysis.test.ts`, `src/prompts/planner.test.ts`, `src/tools/sandbox/catalog-tools.test.ts`, `src/prompts/briefing.test.ts`. Do not run the full suite.
- [ ] 6.2 Run `tsc -p tsconfig.json --noEmit` in `harness/`.
- [ ] 6.3 Run `bun run format:file` on each changed file under `src/`.
- [ ] 6.4 Run `openspec validate adhoc-step-packages --strict` in `harness/`.
