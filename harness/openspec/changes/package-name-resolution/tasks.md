## 1. The shelf-key rule, in its one TypeScript home

- [x] 1.1 Add `shelfKey(track, name)` to `src/sandbox/types.ts`: the PEP 503 fold for `python`, the name verbatim for `r`. Export it from `src/index.ts`.
- [x] 1.2 Add a test beside it: `shelfKey("python", "Decoupler")` gives `decoupler`, and `shelfKey("r", "decoupleR")` gives `decoupleR`.

## 2. The plan grammar

- [x] 2.1 In `src/schemas/workflow-state.ts`, extend the `packages` description with the `python:` and `r:` prefix, and with the rule that a bare both-track name refuses the launch.
- [x] 2.2 In `src/schemas/validate-plan.ts`, refuse a `<word>:` prefix that is not `python:` or `r:`. Name the two permitted prefixes in the issue.
- [x] 2.3 In `src/schemas/validate-plan.test.ts`, add the two scenarios: a prefixed form passes, and `bioc:fgsea` is refused with the two prefixes named.
- [x] 2.4 In `src/tools/execute-analysis.ts`, make `parseRequirement` read the prefix into `ecosystem`. Keep the first spelling of the plan on the request.
- [x] 2.5 In the same file, fold the union by name: a prefixed entry absorbs a bare entry of the same name, and two prefixes make two requests.
- [x] 2.6 In the same file, make the `collision` refusal name the two store directories and the two prefixed forms `python:<name>` and `r:<name>`.
- [x] 2.7 In `src/tools/execute-analysis.test.ts`, add the three scenarios: a prefixed entry reaches the seam with its ecosystem, a prefixed entry absorbs a bare entry, and a collision refusal names the prefixed forms.
- [x] 2.8 In `src/prompts/planner.ts`, teach the prefix in "The Packages of Each Step": write the prefixed form that the census shows for a name under both sections. State that a bare both-track name refuses the launch.
- [x] 2.9 In `src/tools/execute-analysis.ts`, name the condition of the prefix in the `collision` refusal. Two versions of one distribution have no remedy in a plan.
- [x] 2.10 Add `src/prompts/planner.test.ts`. Assert that the prompt teaches the prefixed form, and that a bare both-track name refuses the launch.

## 3. The census

- [x] 3.1 In `src/tools/sandbox/list-available-packages.ts`, make the `names` path answer one entry for each section that holds the name, in the section order. Remove the first-writer rule.
- [x] 3.2 In the same file, mark each listing row whose name the Python section and the R section both hold. The mark shows `python:<name>` and `r:<name>`. A two-spelling pair gets no mark.
- [x] 3.3 In `src/tools/sandbox/catalog-tools.test.ts`, add two scenarios: a both-track name answers once for each track, and a two-spelling pair answers with both spellings.
- [x] 3.4 In the same file, add the scenario: the listing marks a both-track name, and no other row carries a mark.

## 4. The agent-facing text

- [x] 4.1 In `src/tools/sandbox/link-packages.ts`, make the description state the ecosystem retry after a two-track `collision`.
- [x] 4.2 In the same description, state that a collision is terminal only after that retry, or for two versions of one distribution.
- [x] 4.3 In `src/prompts/sandbox-standards.ts`, make `sandboxPackageLinkPrompt` teach the same retry, and teach that the package is dropped only after the retry refuses.
- [x] 4.4 In `src/agents/sandbox/shared.test.ts`, assert that the composed prompt directs the agent to call `link_packages` again with `ecosystem` after a two-track collision.
- [x] 4.5 In the same file, assert that the description of `link_packages` names the ecosystem retry.

## 5. The provisioner graph

- [x] 5.1 In `images/sandbox-provisioner/emit_deps.py`, set the R node name to `inner.name`. Strip the version with `dir_version(key, canon(inner.name))`, because the directory keeps the folded form.
- [x] 5.2 In the same file, set `GRAPH_VERSION` to 2, and rewrite the docstring of `order_by_name`: the key is the identity of the track, not the canonical name.
- [x] 5.3 In the same file, extend `gate()`: stop the run when an R node name differs from its `r_dir`, and log each name that both tracks hold in one spelling.
- [x] 5.4 In `images/sandbox-provisioner/provision.py`, rewrite the comment at the ecosystem prefix (`python:` / `r:`): the prefix reaches the plan of an agent, and never a human surface.
- [x] 5.5 In `images/sandbox-provisioner/test_provision.py`, move each graph fixture to version 2.
- [x] 5.6 In the same file, add the scenarios: an R node keeps its DESCRIPTION spelling, and a `GO.db` directory strips its version.
- [x] 5.7 In the same file, add the scenarios: a folded R name stops the build, a both-track name is reported, and the graph carries version 2.
- [x] 5.8 Make sure that `images/package-store/load-check.py` reads `r_dir` before `name` for an R node. Make sure that no other reader of `deps.json` in `images/` folds an R name.

## 6. Verification

- [x] 6.1 Run `bun run format:file` on each changed file under `src/`.
- [x] 6.2 Run `tsc -p tsconfig.json` and `bun test` in `harness/`.
- [x] 6.3 Run the provisioner tests in `images/sandbox-provisioner/` the way the build workflow runs them.
