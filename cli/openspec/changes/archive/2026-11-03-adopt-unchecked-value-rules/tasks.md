# Tasks

Constraints for each task:

- Do not do a Git mutation (no stage, commit, push, stash, restore, reset, rebase, checkout, or branch switch). To undo an edit, edit the file again.
- Do not change behavior, and do not make a test weaker (design D2, D3, D4).
- Do not run the full `bun run test` or the full `bun run lint`. Lint the paths of your group with `bun --bun oxlint <paths>` from `cli/`. Run `bun run test <files>` on the test files of the modules that you changed. `bun run typecheck` is permitted. Run one heavy command at a time.
- After you edit a file in `src/`, run `bun run format:file <paths>` on it.
- The site lists of the start state are in `tmp/claude/805/` at the root of the repository (`spread-sites.txt`, `unsafe-sites.txt`). Line numbers move as you edit. The lint run of your paths gives the current lines.

## 1. The configuration and the record

- [x] 1.1 Remove the six `off` entries of `typescript/no-unsafe-argument`, `-assignment`, `-call`, `-member-access`, `-return`, and `@inflexa-ai/no-conditional-spread`, and their `#805` comment lines, from the last override of `cli/oxlint.config.ts`. Keep each other entry and comment of that block. Done when: `rg -n "no-unsafe-(argument|assignment|call|member-access|return)|no-conditional-spread|#805" cli/oxlint.config.ts` prints nothing, and `cli/tsconfig.json` is unchanged.
- [x] 1.2 Write `notes.md` in the change folder with the sections of design D5. The spread table has the columns of design D5. The other sections list the `no-unsafe-*` sites that keep a directive, and the shared functions. Done when: the file exists with the three section headings and the table header.

## 2. The no-unsafe-* reports

- [x] 2.1 Fix each `typescript/no-unsafe-*` report in the non-test files of `src/` and `scripts/` per design D3 (a schema parse at the boundary, a type argument, `unknown` with a narrowing, or a published type). Done when: `bun --bun oxlint` on the changed files reports no `no-unsafe-*` site, `bun run typecheck` passes, and the test files of the changed modules pass.
- [x] 2.2 Fix each `typescript/no-unsafe-*` report in the test files per design D3. Keep each assertion. Parse with the schema of the production reader where one exists. Add one helper in `src/test_support/` only for a parse shape that repeats across test files. Done when: `bun --bun oxlint` on the changed files reports no `no-unsafe-*` site, and `bun run typecheck` passes. Each changed test file passes. `git diff` shows no `expect` call that you removed or loosened.

## 3. The conditional spreads of the server, the client, `lib`, and the scripts

Scope: `src/server/**`, `src/client/**`, `src/lib/**`, and `scripts/**`.

- [x] 3.1 Classify each `@inflexa-ai/no-conditional-spread` site of the scope per design D2. Before you edit a site, write its row in the table of `notes.md`. Read the consumer of each object. A consumer that you cannot read counts as one that observes presence. Done when: the table has a row for each site that `bun --bun oxlint src/server src/client src/lib scripts` reports for the rule.
- [x] 3.2 Change each site of the scope to the form of its row (design D2). Do not change the sites that design D2 gives to a different group: the package query of `src/server/routes/store.ts` (group 5), and the turn spend copy of `src/server/routes/conversation.ts` in `spendOf` and `finishFrame` (group 4). Where an object shape repeats only inside the scope, add one function per design D2, and record it in `notes.md`. Done when: `bun --bun oxlint src/server src/client src/lib scripts` reports no `no-conditional-spread` site except the reserved sites, and `bun run typecheck` passes.
- [x] 3.3 Take each site of the scope that observes presence. Make sure that a test asserts the absent key and the present key per design D4. Add the test where none exists. One known case is the `Content-Type` header of `src/client/api.ts`: the client must not add it when the request has no body. Run the test files of the changed modules. Done when: the tests pass. For each new presence test, change its site to the direct form for a moment, see the test fail, and edit the site back.

## 4. The conditional spreads of the harness bridge and of provenance

Scope: `src/modules/harness/**` and `src/modules/prov/**`.

- [x] 4.1 Classify each site of the scope per design D2 in the table of `notes.md`, as in task 3.1. Some consumers of the scope have presence tests already (refer to the scout map in `tmp/claude/805/review-packet.md`). Examples are the bus event payloads of `prov_bridge.ts` and the engine options of `runtime.ts`. Done when: the table has a row for each site that `bun --bun oxlint src/modules/harness src/modules/prov` reports for the rule.
- [x] 4.2 Change each site of the scope to the form of its row. Use one function for each repeated shape that design D2 gives to group 4: the used-input reference with `fileId` in `prov_bridge.ts`, and the turn spend copy. The spend-copy function lives in `turn.ts`. Change its callers in `turn.ts` and in `spendOf` and `finishFrame` of `src/server/routes/conversation.ts`. Classify the conversation sites in `notes.md` first. Done when: `bun --bun oxlint src/modules/harness src/modules/prov src/server/routes/conversation.ts` reports no `no-conditional-spread` site, and `bun run typecheck` passes.
- [x] 4.3 Make sure that each presence-observing site of the scope has its test per design D4, and add the missing tests. Run the test files of the changed modules. Done when: the tests pass, and each new presence test fails when its site takes the direct form for a moment.

## 5. The conditional spreads of the other modules

Scope: `src/modules/**` except `src/modules/harness/**` and `src/modules/prov/**`.

- [x] 5.1 Classify each site of the scope per design D2 in the table of `notes.md`. Read the merge of each dependency object over its defaults (for example the `fetch`, `arch`, and `retry` pass-through of `src/modules/libs/store_download.ts` and `src/modules/refs/store.ts`) before you classify it. Done when: the table has a row for each site that `bun --bun oxlint src/modules` reports for the rule outside `harness/` and `prov/`.
- [x] 5.2 Change each site of the scope to the form of its row. Make the package-query function of design D2 in `src/modules/libs/`. Change its callers in `store_flight.ts`, `libs/store.ts`, and `src/server/routes/store.ts` (classify the route site in `notes.md` first). Each caller keeps its own version condition. Done when: `bun --bun oxlint src/modules src/server/routes/store.ts` reports no `no-conditional-spread` site, and `bun run typecheck` passes.
- [x] 5.3 Make sure that each presence-observing site of the scope has its test per design D4, and add the missing tests (for example the key-count gate of `src/modules/infra/setup.ts`). Run the test files of the changed modules. Done when: the tests pass, and each new presence test fails when its site takes the direct form for a moment.

## 6. The conditional spreads of the TUI

Scope: `src/tui/**`.

- [x] 6.1 Classify each site of the scope per design D2 in the table of `notes.md`. The config patch of `src/tui/app_config.tsx` reads `Object.keys(patch).length`, thus it observes presence. Done when: the table has a row for each site that `bun --bun oxlint src/tui` reports for the rule.
- [x] 6.2 Change each site of the scope to the form of its row. Done when: `bun --bun oxlint src/tui` reports no `no-conditional-spread` site, and `bun run typecheck` passes.
- [x] 6.3 Make sure that each presence-observing site of the scope has its test per design D4, and add the missing tests. Run the test files of the changed modules. Done when: the tests pass, and each new presence test fails when its site takes the direct form for a moment.

## 7. Close-out

- [x] 7.1 Coordinator close-out: run `bun run lint`, `bun run typecheck`, `bun run docs:gen`, and the full `bun run test` one time each in `cli/`, one after the other. Done when: each passes, the lint reports no site of the six rules, and `notes.md` has a row for each spread site of the start list.
