# Notes

## Measurements

- Start (design Context): 551 reports in 195 files, from the real configuration without the `#811` block.
- After task group 1 (the live `bun --bun oxlint`, coordinator run): 497 reports in 183 files. By rule: no-base-to-string 104, explicit-function-return-type 65, restrict-template-expressions 50, no-empty-schema 49, no-instanceof-error 45, no-unknown-type-guards 25, unbound-method 20, no-unnecessary-type-arguments 19, no-invalid-void-type 17, no-misused-spread 17, no-deprecated 17, prefer-show 15, no-dynamic-delete 14, no-typeof-object 10, no-unnecessary-type-conversion 8, no-unnecessary-boolean-literal-compare 5, no-interface 3, prefer-promise-reject-errors 3, export-at-declaration 2, no-unnecessary-type-parameters 2, no-confusing-void-expression 2, only-throw-error 2, restrict-plus-operands 1, no-unnecessary-template-expression 1, no-redundant-type-constituents 1. The zone blocks and the group 1 fixes account for the drop from 551.

- Close-out (task 6.1, coordinator, after correction round 1): `bun run lint` exit 0 with no report, `bun run typecheck` exit 0 with no report, and the full `bun run test`: 4922 pass, 2 skip, 0 fail, 17849 `expect()` calls, 4924 tests across 241 files. The `"off"` entries of `oxlint.config.ts` are the bun-types pair and the four zone blocks.

## Site outcomes

- D3: `isDiskFull` (`src/modules/libs/store_download.ts`) calls `chainCarriesCode(cause, "ENOSPC")` of `src/lib/cause.ts`. The walk keeps its bound of 5 links and its order (the value itself first, then `.cause`).
- D1: the own reports of `src/lib/cause.ts` are fixed. `describeNonError` and `appendCauseDetail` render a non-object value through `describePrimitive`, a typed switch on `typeof`. `safeStringify` keeps `String(value)` at two sites, each with an inline `typescript/no-base-to-string` directive. `indentFrom` reads each line with its index from `entries()`.
- D14: `requestBodyText` (`src/test_support/request_body.ts`) gives a string body as itself and a `URLSearchParams` body as its form encoding. It throws for a missing body and for a body of another form, where `String(init.body)` gave `"undefined"` or `"[object Blob]"`. No caller in the tests today passes such a body.
- D14: `fetchInputUrl` (`src/test_support/fake_fetch.ts`) gives a `Request` as its `url`, where `String(request)` gave `"[object Request]"`.
- D1: `messageOf(<cause>)` replaces `<cause> instanceof Error ? <cause>.message : String(<cause>)` at each production site that has the expression (the sites in `src/lib`, `src/modules`, `src/server`, and `src/tui/components/dialog/file_picker.tsx`). `src/modules/harness/prov_bridge.ts` and `src/modules/harness/usage_recorder.ts` call it in place of the fixed text `"a non-Error value"`. `src/modules/harness/inflexa_classify.ts` reads `errorOf(e)?.message.trim() ?? messageOf(e)`, so an `Error` message is still trimmed and another value is still not trimmed. `src/modules/libs/store_flight.ts` (`describeDbError`) keeps `""` for a cause that is absent or not an `Error` (`errorOf`).
- D2: `describeCause` replaces a bare `String(<failure>)` or `${<failure>}` at `scripts/build.ts` (smoke test, page-asset messages), `scripts/dev_install.ts`, `src/lib/fs_pool_reexec.ts`, `src/modules/auth/auth.ts` (six sites), `src/modules/harness/content-pack.ts`, `src/modules/infra/setup.ts:793`, `src/modules/sbom/sbom.ts` (two sites), `src/modules/update/apply.ts`, and `src/test_support/server.ts` (two sites). `scripts/build.ts` writes a build log as `${log.name}: ${log.message}`.
- D3: `src/modules/harness/dev/run.ts` reads `cause instanceof RunDedupCollisionError || errorOf(cause)?.name === "RunDedupCollisionError"`. `isMissing` in `src/modules/libs/store_download.ts` and `src/modules/refs/store.ts` reads `errnoCode(errorOf(cause)) === "ENOENT"`. A value that is not an `Error` still gives `false`, as before.
- D12: `pull.ts`, `store.ts`, `store_download.ts` (`describeBytes`), and `sidebar.tsx` (`formatRailBytes`) call `formatIecBytes` and lose their copies. Their `units[unit]` template reports go with the copies.
- D14, proof for each production site of `restrict-template-expressions` (why the value cannot print `"undefined"`):
  - `scripts/build.ts` (`modelPurl`, six spans): the pattern has three required groups (`([^/]+)`, `([^/]+)`, `([0-9a-f]+)`), so a match carries all of them. `present()` reads each group and would throw rather than print `"undefined"`.
  - `src/client/commands/geo.ts` (`flags.analysis`): the `pick` case is reached only for an unmatched `--analysis` (the comment above the case). `present()` reads the flag.
  - `src/client/commands/prov.ts` (`format`): the message reads the same `format` constant that the check lowercases. `format` is `flags.format ?? "json"`, which is never `undefined`, and `"json"` passes the check, so the message needs a defined flag.
  - `src/modules/harness/dev/chat.ts` (`threadRef`, two spans): `selectThread` returns `new` for an absent `threadRef` (`:68`), so `lookup_failed` and `not_found` need a defined one. `present()` reads it.
  - `src/modules/infra/setup.ts:793`: `describeCause(error)` gives text for each value, `undefined` included, and the catch variable is the thrown value. The text of an `Error` changes only by the D2 rule.
  - `src/modules/libs/composition.ts` (`graph_dangling_edge`): the only producer returns the error when `dangling.length > 0` (`:479`), so `edges[0]` exists. `present()` reads it.
  - `src/server/routes/provenance.ts` (`rawFormat`, `rawDepth`): `rawFormat` is `format ?? "tree"` and is never `undefined`. `rawDepth` is defined whenever `depth` is not `undefined`, because `depth` is derived from it in the line above. `present()` reads it.
  - `src/test_support/oxlint.ts`: the loop above the template sets `scratchRoot` for each scope of `snippets`, so the lookup cannot miss. `present()` reads it.
  - `src/tui/components/dialog/prompt_dialog.tsx` (`GLYPHS.spinner[spinFrame()]`): `spinFrame` starts at 0 and advances by `(f + 1) % GLYPHS.spinner.length`, so the index is in range. `present()` reads it.
  - `src/tui/components/openable_card_block.tsx`, `src/tui/components/tool_block.tsx`, `src/tui/layout/sidebar.tsx:340` (`effort`): each value is the argument of the keyed accessor of the `<Show>` that guards it, so the template runs only for a truthy value. The old guard was the same truthiness test.
  - `src/tui/components/run_card_block.tsx` (`done().total`): `stepCountText` returns `undefined` when `total` is `undefined`, and `<Show>` renders the template only for a defined text. A `total` of 0 still renders (the guard is on the text, not on the number).
  - `src/tui/hooks/activity_panel.ts` (`names[names.length - 1]`): the branch runs only when `names.length > 2`. `present()` reads the last name.
  - `src/tui/hooks/boot.ts:310`: the `Err` branch prints `spawned.error`, a string (`describeCause`). The `Ok` branch reads `code` from `await spawned.value.exited`, a number. The old `code` was `number | null`; `null` occurred only on the `Err` branch, which no longer reads `code`.
  - `src/tui/layout/sidebar.tsx:903` (`profileLine().glyph`): `<Show when={profileLine().glyph}>` renders the template only for a non-null glyph. No glyph is the empty string (`GLYPHS.warning`, `check`, `cross`), so the truthy test equals the old `!== null` test.
- D14, test sites: the fetch doubles call `fetchInputUrl` and `requestBodyText`. A console or stdout capture whose parameter is `unknown` calls `describeCause`. A Bun `server.port` and a lookup that the test just proved (`present(...)`) read through `present`. `src/modules/prov/test/prov.test.ts` parses `prov:startTime` with `z.string()` in place of `String()`.
- D14 `no-deprecated`: `.passthrough()` became `z.looseObject({...})` in `src/lib/container.ts` (`manifestSchema`, `pullEventSchema`), `src/modules/libs/store_flight.ts` (the report, node, outcome, raw-graph, and failed-load schemas), `src/modules/libs/store.ts`, and `src/modules/sbom/sbom.ts`. A `.optional()` or `.default()` stays on the new object.
- D5 proof, `src/server/routes/runs.ts` (`planTitleOf`, `planStepNames`): the plan is a stored JSON document, thus a plain object, an array, or a scalar. `unknownRecordSchema` refuses an array, a scalar, and `null`, and each of those gave no title and no names before. A step that is an array or `null` is skipped, as before (`"id" in step` was false). `src/server/routes/test/runs.test.ts` pins each of these inputs.
- D5 proof, `src/modules/libs/store_download.ts` (`readManifestLayers`): `jsonContainerSchema` (a record or an array) answers where `typeof x === "object" && x !== null` answered, because the manifest comes from `JSON.parseResult`. A manifest that is an array still gives "The manifest declared no layers.", `null` or a scalar gives "The manifest was not an object.", a layer that is an array still gives "A manifest layer lacked a media type, a digest, or a size.", and a layer that is `null` or a scalar gives "A manifest layer was not an object." The rows of `store_download.test.ts` cover each input; the rows for a manifest that is a number and a layer that is a string are new.
- D5 proof, `src/lib/otel.ts`: the scalar kinds are tested first, and the other non-null value is stringified. A pino line is JSON, thus the other value is an object or an array. `src/lib/test/otel.test.ts` pins a scalar, an array, and a `null` attribute.
- D5, `src/modules/embedding/local-provider.ts` (`allocateFreePort`): `addr !== null && typeof addr !== "string"` narrows `AddressInfo | string | null` by its members. `src/modules/infra/setup_answers.ts` (`answersNothing`) returns `false` for a string, a boolean, or an array answer, and reads the leaves of a block. The old test was `typeof answer !== "object" || Array.isArray(answer)`, and it also returned `false` for `undefined` and for a number. Neither reaches the function: the schema has no top-level number answer, and a YAML parse through the schema never gives a key with the value `undefined`.
- D5, tests: `src/cli/test/gen_docs.test.ts` (`exportedDocLists`) keeps an export whose name ends in `envdoc` when it is an array or a plain record, the two shapes that `declaredVarNames` reads. `src/modules/harness/test/inflexa_tool.test.ts` (`shown`) parses the view with a local `z.object` schema. The view result is a `ViewFields` instance, and `unknownRecordSchema` refuses a class instance, so a `z.object` schema is the read that keeps the result.
- D6: the explicit predicate is gone where TypeScript infers it: `src/modules/analysis/boundary.ts`, `src/modules/prov/lineage.ts`, `src/modules/embedding/setup.ts`, `src/server/routes/analyses.ts` (two sites), `src/modules/harness/dev/run.ts`, `src/lib/usage_format.ts`. The predicate stays with an annotated parameter at `src/api/common.ts` (`code: string`), `src/tui/commands.tsx` (`t: ThreadSummary`), `src/tui/hooks/sidebar_live.ts` (two sites; `part: string | undefined`, `fact: string | null`), and the test guards of `src/tui/hooks/test/conversation.test.ts` (`p: Part`) and `src/modules/harness/test/prov_bridge.test.ts` (`e: StampedEvent`). `scripts/build.ts` (`stringList`) drops the predicate: `entry: unknown` with a `typeof` test infers it. `bun run typecheck` proves each site.
- D7: the re-export of `AGENT_NAMES` and `AgentName` is deleted from `src/modules/harness/agent_switch.ts`, and its import of `AGENT_NAMES` goes with it. No file imports either name from `agent_switch.ts` (the string of `import_boundary.test.ts` stays).
- D14: `SpawnBounds`, `RunInflexaToolDeps`, and `LocalEmbeddingProviderDeps` are types. `trustWireBody` (`src/client/api.ts`) and `registerAction` (`src/cli/agent_policy.ts`) keep their form under an inline `typescript/no-unnecessary-type-parameters` directive with its reason. `unknown | unknown[]` is `unknown` in `src/client/commands/test/runs.test.ts`.
- D4, tests: `z.json()` takes the place of `z.unknown()` at each reported site, and the doc of `parsedJson` names it. `src/extensions/test/extensions.test.ts` refines `z.number()` (the text is `1`). `src/modules/prov/test/export.test.ts` reads the attestation into an `unknown` variable before `toEqual`, because the matcher type refuses the JSON type against `ProvAttestation`.
- D8: each Solid component gets `JSX.Element`. An accessor arrow gets the named type of its value: `SettingsDraft["postgres"]` and `SettingsDraft["embedding"]` in `src/tui/app_config.tsx`, `DialogDims` in `src/tui/components/dialog/dialog_panel.tsx`, and `boolean`, `string`, or `void` for the others. The tool factories return `Tool<Input, Output>` of the harness (`createLaunchDirTool`, `createManageInputsTool`, `createRunInflexaTool`), with the input type written as `z.infer` of the unchanged schema. `buildAuthInjectingFetch` returns `InjectingFetch & Pick<typeof fetch, "preconnect">`.
- D14, `solid/prefer-show` (the render tests of every changed view pass; the condition of each `<Show>` is the test of the old ternary):
  - `src/tui/layout/sidebar.tsx` (`RailLiveLine`): the old test was `glyph !== null`, the new test is the truthiness of `glyph` (the keyed accessor keeps the narrowing). No `LiveLine` glyph is the empty string: each producer in the file gives a `GLYPHS` entry or `null`, so the two tests agree.
  - `src/tui/layout/sidebar.tsx` (`reportParentTitle`): `when={reportParentTitle() !== null}` keeps the old test exactly. The branch does not read a narrowed value.
  - `src/tui/components/list_core.tsx`: `<Show when={props.strategy === "for"}>` replaces the ternary. The strategy is fixed per wrapper, so the condition never flips. The comment about a "plain ternary" is rewritten.
  - `src/tui/layout/message_block.tsx`, `src/tui/layout/chat_bar.tsx` (two sites), `src/tui/components/run_block.tsx`, `src/tui/components/dialog/usage_dialog.tsx`, `src/tui/components/dialog/file_picker.tsx`, `src/tui/app_config.tsx` (five sites): the condition is the old test, and no branch reads a narrowed value.
- D14, `no-confusing-void-expression` (`src/tui/hooks/artifacts.ts`): the two `return notify(...)` statements become a call and a bare `return`. The callback still returns `undefined`.

- D9, production: `SpawnHandle` (`tail`, `terminate`) and the return type of `drainStderrTail` (`tail`) in `src/modules/embedding/local-provider.ts` use function-property types, and `Promise.sleep` in `src/extensions/promise.ext.ts` is `sleep: (ms: number) => Promise<void>`. The implementations were arrow closures and a function expression that never read `this`, so the run time does not change. `src/lib/fs_pool_reexec.ts` passes `process.execve?.bind(process)`: the `@types/node` type is `execve?(...)`, so the optional call stays, and an absent `execve` stays `undefined` for the callee check.
- D9, tests: `src/modules/harness/test/runtime.test.ts` (eight sites) reads `expect(typeof x.method).toBe("function")`. The `describeCall` readers of `inflexa_tool.test.ts` (two sites) and `inputs_tool.test.ts` call `tool.describeCall?.(input)` after `expect(typeof tool.describeCall).toBe("function")`, a method call with its receiver. If the hook is absent, the first assertion fails (the reader in `inflexa_tool.test.ts` line ~808 compares the result with a string, so `undefined` fails too). `launch_dir_tool.test.ts` asserts `typeof tool.describeCall` is `"undefined"`. `report_pages.test.ts` forwards `remainingSeconds` with an arrow. The `present` import of `inputs_tool.test.ts` went with its only use. No `.bind` is in a test.
- D10: `Array.from(value)` replaces `[...value]` at each string site: `src/lib/types.ts`, `src/modules/harness/plan_dag.ts`, `src/modules/harness/inputs_tool.ts`, `src/tui/layout/sidebar.tsx` (two sites), `src/server/routes/artifacts.ts`, `src/server/routes/browser_session.ts`, `src/server/routes/files.ts` (two sites), and the tests `design_system.test.ts`, `search_index.test.ts`, `walk_child.test.ts`, `inputs_tool.test.ts`, `compaction_block.render.test.tsx` (two sites), `file_picker.render.test.tsx`, `remove_inputs_dialog.render.test.tsx`. Both forms iterate by code point. The `allow` option is not used.
- D11: `stdinIsTTY()` replaces `Boolean(process.stdin.isTTY)` and `process.stdin.isTTY === true` at `src/modules/infra/setup.ts` (three sites), `src/client/commands/server.ts` (`interactive: stdinIsTTY`, a call at each use), and `src/modules/embedding/setup.ts`. For `true`, `false`, and `undefined` the two forms give the same boolean (`src/lib/test/cli.test.ts` covers the three values). `confirm` in `src/lib/cli.ts` returns `!isCancel(answer) && answer`: after `isCancel` narrows, `answer` is a `boolean`. `src/lib/install_context.ts` and `src/modules/embedding/setup.ts` drop `=== true` on `__INFLEXA_COMPILED__`, which the build defines as a boolean and the `typeof` guard leaves as `boolean`.
- D13: `src/lib/env.ts` (`walkChildEnv`), `src/modules/libs/store_flight.ts` (the dropped store directories of a failed load check), `src/lib/test/env.test.ts` (`unsizedEnv`), `src/modules/libs/test/composition.test.ts`, and `src/modules/prov/test/kernel_compat.test.ts` (`normalizeBlankIds`) build a new record without the key, with an `Object.entries` filter. The kept keys keep their order. In `normalizeBlankIds` the re-keyed blank ids come after the kept keys, the same order that delete-then-assign gave. The environment sites call `clearEnvVars` (`env.test.ts`, two describe blocks; `harness/test/config.test.ts`) and `unsetEnvVar` (`env.test.ts`, `infra/test/setup.test.ts`).
- D14, `no-invalid-void-type`: `Promise.withResolvers<undefined>()` with `resolve(undefined)` in `src/modules/fs/search_index.ts` (three resolvers) and the tests `search_index.test.ts` (`release` is a local arrow, so the `() => void` list of gates keeps its type), `activity_panel.test.ts`, and `fs.test.ts`. `ok<undefined, E>(undefined)` and `err<undefined, E>(...)` in `src/modules/libs/composition.ts`, `src/modules/update/apply.ts`, `okAsync<undefined, FsError>` in `src/modules/prov/export.ts`, and `infra/test/setup.test.ts`. `src/server/analysis_guard.ts` returns `Promise<Response | undefined>` and ends with `return undefined;` because the function body no longer has the `void` return. The middleware callers (`guardAnalysisId`, `next()`) treat `undefined` and `void` alike.
- D14, `no-unnecessary-type-conversion`, proof for each removal: `row.function_id` (`src/modules/harness/dev/status.ts`) is typed `number` by the query generic, and the column is `int4`, which node-pg gives as a number. `fs.bavail * fs.bsize` (`src/modules/libs/store_download.ts`): `statfs(path)` without `{ bigint: true }` gives `StatsFs` with number fields (the typecheck proves the type). `option.value` (`src/modules/refs/commands.ts`): `ReferencePickerEntry.value` is `string`, so `String()` was the identity. The `Boolean(process.stdin.isTTY)` sites went to `stdinIsTTY` (D11).
- D14, `no-unnecessary-type-arguments` (19 test sites): `expect<unknown>(x)` became `expect(x)`, and `ok<T, never>` and `okAsync<T, never>` lost the `never`. Where the matcher then refused the typed value against an asymmetric matcher (a value of type `unknown`), the variable got `unknown` at its declaration: `fks` in `primary_migrations.test.ts`, `sessions` in `runs.test.ts` (`unknown[]`), `machineRead` in `sandbox_gate.test.ts`, `visible` in `serve.test.ts`, and a new `const x: unknown = ...` line before the assertion in `runs.test.ts` (`stepList`), `boot.test.ts`, and `report_session_flows.test.ts` (three sites). The `AgentSession` import of `runs.test.ts` went with the old declaration.
- D14, `prefer-promise-reject-errors` / `only-throw-error`: `model_listing.test.ts` (two sites) and `proxy/test/models.test.ts` keep their form under an inline `oxlint-disable-next-line` with a reason. `harness/dev/test/run.test.ts` types `insertThrows` and `launchThrows` as `Error`: the harness `RunDedupCollisionError extends Error`, and the other test gives `new Error("dbos down")`.

## Behavior differences

Group 1 adds helpers and changes one call site (`isDiskFull`), with the same result for each input. Group 2:

- D1 and D2 (recorded text change): a failure value that is not an `Error` now prints through `describeCause` or `messageOf` (`type: message`, bounded JSON, or the string itself) in place of `[object Object]`. An `Error` that has a `.cause` or `.errors` and goes through `describeCause` (the D2 sites) gains the cause tail. No test pinned the old text of such a value, so no pin changed.
- D2 (recorded text change): at the D2 sites, an `Error` with an empty message renders as `Error: ` (or `AbortError: `) where `String(error)` gave `Error`. No test pins this text.
- `src/modules/harness/prov_bridge.ts` and `src/modules/harness/usage_recorder.ts`: a non-Error failure value gives its rendering in place of the fixed text `a non-Error value` (D1). No test pinned the fixed text.
- `requestBodyText` and `fetchInputUrl` (test doubles): a call that passed no body, a body that is not a string or `URLSearchParams`, or a `Request` as the fetch input now gives the real text, or throws, where `String(...)` gave `"undefined"`, `"[object Blob]"`, or `"[object Request]"`. No test in the changed files hits those forms.
- `src/modules/prov/test/prov.test.ts`: `z.string().parse` throws when a `prov:startTime` is absent or not a string, where `Date.parse(String(...))` gave `NaN` and failed a later assertion. The test is stricter, not weaker.

Group 3: no result changes beyond the inputs below, which no test or caller reaches.

- `src/modules/infra/setup_answers.ts` (`answersNothing`): the old `typeof` test also returned `false` for an answer of the value `undefined` and for a number. Neither reaches the function. The schema has no top-level number answer, and a YAML parse through the schema never gives a key with the value `undefined`.
- `src/server/routes/runs.ts`: a plan that is a class instance with an inherited `title` or `steps` gave a title before, and gives none now (`unknownRecordSchema` refuses a non-plain object). The plan is a stored JSON document, thus a plain object.
- `src/modules/libs/store_download.ts`: the same for a manifest or a layer that is a class instance. The value comes from `JSON.parseResult`.
- `src/cli/test/gen_docs.test.ts` (test): an export whose name ends in `envdoc` and that is a class instance is no longer a doc list. `declaredVarNames` already refused such a value.

Group 5: no result changes. The `walkChildEnv` and `unsizedEnv` records, and the `staged` record of `store_flight.ts`, hold the same keys in the same order as before. `analysis_guard.ts` returns `undefined` explicitly where it fell off the end before. `process.execve` is called bound to `process` where it was called unbound (Bun owns the implementation).

## Open sites

- `src/tui/test/commands.test.ts` (`urls.push(String(url))`, a `no-unnecessary-type-conversion` site of task 5.2): changed to `urls.push(url)` in group 2, because `url` is already a `string` and the line sits in the same fetch double. Task 5.2 finds it done.

Group 5: no open site.

Group 3: no open site. Each zone block reason held for the files that it names; no fact in the code proved one wrong.

## Test strength

Test files changed in groups 1 to 3 (the count of `expect(` in the source text). Neither file is in `tmp/claude/811/expect-before.txt`, thus the before count is from `HEAD`. The new test files of group 1 are new, and they hold no earlier count.

| File | Before | After |
| --- | --- | --- |
| `src/lib/test/cause.test.ts` | 66 | 94 |
| `src/test_support/test/fake_fetch.test.ts` | 9 | 12 |
| `src/client/commands/test/server.test.ts` | 41 | 41 |
| `src/client/commands/test/store.test.ts` | 3 | 3 |
| `src/lib/test/config.test.ts` | 52 | 52 |
| `src/lib/test/usage_format.test.ts` | 51 | 51 |
| `src/modules/embedding/test/api_models.test.ts` | 18 | 18 |
| `src/modules/embedding/test/local-provider.test.ts` | 96 | 96 |
| `src/modules/embedding/test/setup.test.ts` | 143 | 143 |
| `src/modules/geo/test/geo.test.ts` | 88 | 88 |
| `src/modules/harness/test/run_deps.test.ts` | 28 | 28 |
| `src/modules/harness/test/runtime.test.ts` | 170 | 170 |
| `src/modules/infra/test/compose.test.ts` | 117 | 117 |
| `src/modules/infra/test/setup.test.ts` | 404 | 404 |
| `src/modules/infra/test/setup_answers.test.ts` | 271 | 271 |
| `src/modules/libs/test/store_flight.test.ts` | 102 | 102 |
| `src/modules/prov/test/lineage.test.ts` | 187 | 187 |
| `src/modules/prov/test/prov.test.ts` | 213 | 213 |
| `src/modules/prov/test/prov_report.test.ts` | 58 | 58 |
| `src/modules/proxy/test/models.test.ts` | 95 | 95 |
| `src/modules/refs/test/commands.test.ts` | 167 | 167 |
| `src/modules/refs/test/store.test.ts` | 129 | 129 |
| `src/modules/sbom/test/sbom.test.ts` | 12 | 12 |
| `src/modules/update/test/apply.test.ts` | 18 | 18 |
| `src/server/routes/test/conversation.test.ts` | 188 | 188 |
| `src/server/routes/test/fs.test.ts` | 365 | 365 |
| `src/server/routes/test/machine.test.ts` | 198 | 198 |
| `src/server/routes/test/usage.test.ts` | 101 | 101 |
| `src/server/test/app.test.ts` | 80 | 80 |
| `src/server/test/http.test.ts` | 51 | 51 |
| `src/server/test/profile_queue.test.ts` | 20 | 20 |
| `src/server/test/sandbox_gate.test.ts` | 23 | 24 |
| `src/test_support/test/result.test.ts` | 8 | 8 |
| `src/tui/test/app_config.render.test.tsx` | 57 | 57 |
| `src/tui/test/commands.test.ts` | 277 | 277 |
| `src/cli/test/gen_docs.test.ts` | 23 | 23 |
| `src/client/commands/test/runs.test.ts` | 16 | 16 |
| `src/extensions/test/extensions.test.ts` | 88 | 88 |
| `src/lib/test/otel.test.ts` | 7 | 12 |
| `src/modules/analysis/test/analysis.test.ts` | 64 | 64 |
| `src/modules/harness/test/inflexa_tool.test.ts` | 137 | 137 |
| `src/modules/harness/test/prov_bridge.test.ts` | 152 | 152 |
| `src/modules/libs/test/composition.test.ts` | 181 | 181 |
| `src/modules/libs/test/packages.test.ts` | 10 | 10 |
| `src/modules/libs/test/store_download.test.ts` | 65 | 65 |
| `src/modules/prov/test/export.test.ts` | 12 | 12 |
| `src/modules/prov/test/kernel_compat.test.ts` | 13 | 13 |
| `src/server/routes/test/artifacts.test.ts` | 67 | 67 |
| `src/server/routes/test/provenance.test.ts` | 29 | 29 |
| `src/server/routes/test/runs.test.ts` | 230 | 236 |
| `src/server/routes/test/store.test.ts` | 25 | 25 |
| `src/test_support/test/json.test.ts` | 4 | 4 |
| `src/tui/hooks/test/conversation.test.ts` | 341 | 341 |

Group 5 (the `expect(` count of the source text; a converted `expect<unknown>(` now matches the pattern, so a file with such a conversion shows one more than before, and the number of calls is the same):

| File | Before | After |
| --- | --- | --- |
| `src/lib/test/env.test.ts` | 77 | 77 |
| `src/modules/harness/test/config.test.ts` | 89 | 89 |
| `src/modules/fs/test/search_index.test.ts` | 113 | 113 |
| `src/tui/hooks/test/activity_panel.test.ts` | 154 | 154 |
| `src/lib/test/design_system.test.ts` | 7 | 7 |
| `src/modules/fs/test/walk_child.test.ts` | 38 | 38 |
| `src/modules/harness/test/inputs_tool.test.ts` | 39 | 39 |
| `src/tui/components/test/compaction_block.render.test.tsx` | 14 | 14 |
| `src/tui/components/dialog/test/file_picker.render.test.tsx` | 84 | 84 |
| `src/tui/test/remove_inputs_dialog.render.test.tsx` | 14 | 14 |
| `src/modules/harness/test/launch_dir_tool.test.ts` | 13 | 13 |
| `src/server/routes/test/report_pages.test.ts` | 69 | 69 |
| `src/db/test/primary_migrations.test.ts` | 60 | 61 |
| `src/modules/libs/test/store.test.ts` | 84 | 84 |
| `src/server/test/boot.test.ts` | 37 | 38 |
| `src/server/test/serve.test.ts` | 26 | 27 |
| `src/tui/hooks/test/run_completion.test.ts` | 84 | 84 |
| `src/tui/layout/test/run_card_settle.render.test.tsx` | 33 | 33 |
| `src/tui/test/keymap_chord_uniqueness.render.test.tsx` | 6 | 6 |
| `src/tui/test/report_session_flows.test.ts` | 197 | 200 |
| `src/modules/harness/test/model_listing.test.ts` | 111 | 111 |
| `src/modules/harness/dev/test/run.test.ts` | 35 | 35 |

Group 5 also changed these files that have a row above: `src/modules/harness/test/inflexa_tool.test.ts`, `src/modules/harness/test/runtime.test.ts`, `src/modules/infra/test/setup.test.ts`, `src/modules/libs/test/composition.test.ts`, `src/modules/libs/test/store_flight.test.ts`, `src/modules/prov/test/kernel_compat.test.ts`, `src/modules/proxy/test/models.test.ts`, `src/server/routes/test/fs.test.ts`, `src/server/routes/test/runs.test.ts`, and `src/server/test/sandbox_gate.test.ts`. The count of `runs.test.ts` and `sandbox_gate.test.ts` rose by the converted `expect<unknown>(` sites; the others stay the same.
