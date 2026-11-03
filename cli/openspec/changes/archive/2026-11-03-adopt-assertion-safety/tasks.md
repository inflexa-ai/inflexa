# Tasks

Constraints for each task:

- Do not do a Git mutation (no stage, commit, push, stash, restore, reset, rebase, checkout, or branch switch). To undo an edit, edit the file again.
- Do not change behavior, and do not make a test weaker (design D2, D4, D6). Do not remove or loosen an `expect` call. Use the matcher replacements of design D2.
- Do not add a `!`, a new `x is T` predicate over `unknown`, a new `typeof x === "object"` probe, or an `any` (design Non-Goals).
- Do not run the full `bun run test` or the full `bun run lint`. Lint the paths of your group with `bun --bun oxlint <paths>` from `cli/`. Run `bun run test <files>` on the test files that you changed. `bun run typecheck` is permitted. Run one heavy command at a time.
- After you edit a file in `src/`, run `bun run format:file <paths>` on it.
- The start list of the reports is `tmp/claude/806/probe-lint.out` at the root of the repository. Line numbers move as you edit. After task 1.1, the lint run of your paths gives the current lines.
- Work in large scripted passes where a shape repeats (for example the route-test body reads), then fix the remaining sites by hand. Run the tests of each file after its pass.

## 1. The configuration and the shared abstractions

- [x] 1.1 Remove the three `off` entries of `@inflexa-ai/require-assertion-safety`, `typescript/no-unsafe-type-assertion`, and `@inflexa-ai/no-double-cast`, and their `#806` comment line, from the last override of `cli/oxlint.config.ts`. Keep each other entry and comment of that block. Done when: `rg -n "require-assertion-safety|no-unsafe-type-assertion|no-double-cast|#806" cli/oxlint.config.ts` prints nothing.
- [x] 1.2 Write `notes.md` in the change folder with three sections: "Survivors" (a table with the columns file:line, kind (`SAFETY` or `disable`), and invariant, per design D5), "Shared abstractions" (each helper, schema, builder, or narrow type that this change adds, with its file and its callers), and "Tolerant boundaries" (each boundary of design D6 that this change edits, with the malformed-item test that covers it). Done when: the file exists with the three section headings.
- [x] 1.3 Add the error-body schema of design D2 to `src/api/common.ts`, derived from `API_ERROR_STATUS`, with the output type `ApiError`. Use it in `errorFromBody` of `src/client/api.ts`, and delete `isApiError` and its cast. Add the tests of design D6 to the test folder of `src/client/`: an unknown `error` code, a `message` that is not a string, and a body that is not an object each give `bad_json`, and a body with an extra key and a `details` value gives `http` with the body unchanged. Done when: the client tests pass, and each new test fails when the schema accepts any object for a moment (edit it back after).
- [x] 1.4 Route `request<T>` and `parseFrame<T>` of `src/client/api.ts` through one private function that holds the one cast, the `SAFETY:` comment, and the reasoned disable of design D1. The comment states the three points of design D1, including the accepted residual. Keep the per-frame `bad_json` continuation of `readSseFrames`. Done when: `bun --bun oxlint src/client/api.ts` reports none of the three rules, and the tests of `src/client/` pass.
- [x] 1.5 Add the shared test helpers to `src/test_support/` (design D2 and D4): the JSON body reader that gives `Promise<unknown>`, the error-body reader that parses with the schema of task 1.3, the `globalThis.fetch` replacement helper that borrows `preconnect`, and one complete builder each for `Analysis` and `Workspace` with overrides. Each exported helper has a JSDoc block. Record each one in `notes.md`. Done when: `bun run typecheck` passes, and `bun --bun oxlint src/test_support` reports none of the three rules.
- [x] 1.6 Add the cast-free membership helper of design D5 to `src/lib/`, and use it in each membership predicate that design D5 names (also those outside the paths of this group), and in `src/lib/log.ts:155` per design D5. Done when: `rg -n "as (readonly )?string\[\]\)\.includes|as pino\.Level" cli/src` prints nothing, and the tests of the changed modules pass.

## 2. The database, `lib`, the client, and the other shared layers

Scope: `src/db/**`, `src/lib/**`, `src/client/**`, `src/api/**`, `src/extensions/**`, `src/types/**`, and `src/test_support/**`, with their tests.

- [x] 2.1 Change each `bun:sqlite` read cast of `src/db/` to the bound statement of design D3 (`conn.query<Row, Params>(sql)`). Narrow a column to a union with the helper of task 1.6. Done when: `bun --bun oxlint src/db` reports none of the three rules, and the tests of `src/db/` pass.
- [x] 2.2 Fix each other report of the scope per design D4 and D5: the errno reads through `errnoCode`, the parse-then-cast sites through a schema, and the widenings through an annotation or a `SAFETY:` comment. At `src/lib/otel.ts`, keep the skip of a malformed line (design D6), and add a test that gives a malformed line between valid lines and asserts that the valid records still go out. Add a row to `notes.md` for each survivor and each edited tolerant boundary. Done when: `bun --bun oxlint src/db src/lib src/client src/api src/extensions src/types src/test_support` reports none of the three rules, `bun run typecheck` passes, and the changed test files pass.

## 3. The large route tests of the server

Scope: `src/server/routes/test/machine.test.ts`, `runs.test.ts`, and `fs.test.ts`.

- [x] 3.1 Change each JSON body read of the scope to the reader of task 1.5, and each `as ApiError` read to the error-body reader. Replace each matcher per design D2. Where a test computes on the body, parse a small schema per design D2. Done when: no `.json()) as` remains in the scope, and each changed file passes.
- [x] 3.2 Fix each other report of the scope (the doubles of `Pool`, `HarnessRuntime`, `AgentSession`, `StampedEvent`, and the `as never` error values) per design D4. Where a narrow type or a type parameter changes a production signature in `src/server/`, make sure that `bun run typecheck` passes. Done when: `bun --bun oxlint <the three files>` reports none of the three rules, `bun run typecheck` passes, and each changed test file passes.

## 4. The rest of the server

Scope: `src/server/**` except the three files of group 3. This scope holds `analyses.test.ts` and `conversation.test.ts`.

- [x] 4.1 Change each JSON body read and each `as ApiError` read of the scope as in task 3.1. Fix each other report of the scope per design D4 and D5, with the narrow types that group 3 added where they apply. Add a row to `notes.md` for each survivor. Done when: `bun --bun oxlint src/server` reports none of the three rules, `bun run typecheck` passes, and each changed test file passes.

## 5. The harness bridge, the embedding, and provenance

Scope: `src/modules/harness/**`, `src/modules/embedding/**`, and `src/modules/prov/**`.

- [x] 5.1 Fix each report of the scope per design D4 and D5. At each whole-file default of design D6 in the scope (`src/modules/prov/signing.ts:60-66`, `src/modules/harness/content-pack.ts:76-82`), keep the default or the error of today. Add a test with a malformed file if none exists. For `unpackTo`, add the `null` header test of design D6, and record the site in `notes.md`. The embedding stand-ins (`src/modules/embedding/setup.ts:269`, `:590`) take a narrow type per design D4. Add a row to `notes.md` for each survivor and each edited tolerant boundary. Done when: `bun --bun oxlint src/modules/harness src/modules/embedding src/modules/prov` reports none of the three rules, `bun run typecheck` passes, and each changed test file passes.

## 6. The other modules

Scope: `src/modules/**` except `harness/`, `embedding/`, and `prov/`.

- [x] 6.1 Fix each report of the scope per design D4 and D5. Replace each `globalThis.fetch` double with the helper of task 1.5. At each tolerant boundary of design D6 in the scope (`src/modules/libs/store_download.ts`, `src/modules/refs/store.ts`, `src/modules/update/apply.ts`, `src/modules/libs/pull.ts`, `src/modules/infra/setup.ts`), keep the skip or the default, and add a malformed-item test where the change edits the boundary. Add a row to `notes.md` for each survivor and each edited tolerant boundary. Done when: `bun --bun oxlint src/modules` reports none of the three rules, `bun run typecheck` passes, and each changed test file passes.

## 7. The TUI, the command registry, and the scripts

Scope: `src/tui/**`, `src/cli/**`, `src/index.ts`, and `scripts/**`.

- [x] 7.1 Fix each report of the scope per design D4 and D5. The TUI tests use the builders of task 1.5 for `Analysis` and `Workspace`. In `scripts/build.ts`, parse each JSON file with a schema at the read. Add a row to `notes.md` for each survivor. Done when: `bun --bun oxlint src/tui src/cli src/index.ts scripts` reports none of the three rules, `bun run typecheck` passes, and each changed test file passes.

## 8. Close-out

- [x] 8.1 Coordinator close-out: run `bun run lint`, `bun run typecheck`, `bun run docs:gen`, and the full `bun run test` one time each in `cli/`, one after the other. Done when: each passes, `rg -n "as unknown as|as any as" cli/src cli/scripts` prints no hit outside a comment, and each `as` that is not `as const` under `cli/src` and `cli/scripts` has a row in the "Survivors" table of `notes.md`.
