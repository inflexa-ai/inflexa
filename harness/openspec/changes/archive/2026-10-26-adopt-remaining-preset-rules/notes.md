## Live worklist (measured 2026-10-26, after the config flip and the `instanceofErrorAllowIn` wiring)

Source run: `bun --bun oxlint --format json` over the full tree (plugin 0.8.0), saved at
`harness/tmp/pi/709-live-worklist.json`. Columns: total reports, then reports outside the
test globs (`**/*.test.{ts,tsx,js}`, the factory test glob). The later task groups own the
outside-test-globs column plus the test-file reports of their rule.

| rule                                     |    total | outside test globs |
| ---------------------------------------- | -------: | -----------------: |
| `no-base-to-string`                      |      241 |                 98 |
| `explicit-function-return-type`          |       89 |                 89 |
| `@inflexa-ai(no-instanceof-error)`       |       77 |                 65 |
| `@inflexa-ai(no-unknown-type-guards)`    |       84 |                 59 |
| `@inflexa-ai(no-typeof-object)`          |       87 |                 52 |
| `@inflexa-ai(no-empty-schema)`           |      106 |                 49 |
| `restrict-template-expressions`          |       66 |                 42 |
| `no-deprecated`                          |       38 |                 33 |
| `no-unnecessary-type-conversion`         |       30 |                 27 |
| `no-misused-spread`                      |       33 |                 27 |
| `@inflexa-ai(export-at-declaration)`     |       22 |                 22 |
| `unbound-method`                         |       52 |                 10 |
| `no-unnecessary-type-arguments`          |       10 |                  9 |
| `no-redundant-type-constituents`         |       10 |                  9 |
| `no-useless-default-assignment`          |        7 |                  7 |
| `no-unnecessary-type-parameters`         |        7 |                  6 |
| `only-throw-error`                       |        5 |                  5 |
| `restrict-plus-operands`                 |        3 |                  3 |
| `no-unnecessary-boolean-literal-compare` |        7 |                  3 |
| `no-invalid-void-type`                   |        8 |                  3 |
| `no-duplicate-type-constituents`         |        3 |                  3 |
| `use-unknown-in-catch-callback-variable` |        2 |                  2 |
| `prefer-promise-reject-errors`           |       13 |                  2 |
| `no-unnecessary-template-expression`     |        4 |                  2 |
| `no-dynamic-delete`                      |        5 |                  2 |
| `no-confusing-void-expression`           |        2 |                  2 |
| `await-thenable`                         |        1 |                  1 |
| **total**                                | **1012** |            **632** |

`@inflexa-ai/no-instanceof-error` is 77/65, not the probed 80/68: `src/lib/result.ts` and
`src/lib/logger.ts` are in `instanceofErrorAllowIn`, so their reports sit outside the worklist
by design.

Per-directory breakdown of the non-test reports (each directory carries its count):

- `no-base-to-string`: src/report-render 32, src/tools 19, src/literature 13, src/memory 7, src/workflows 4, scripts 3, src/lib 3, src/sandbox 3, src/providers 2, src/state 2, src/tasks 2, src/**tests** 1, src/agents 1, src/app 1, src/citations 1, src/execution 1, src/loop 1, src/runtime 1, src/schemas 1
- `explicit-function-return-type`: src/tools 53, src/report-render 15, src/lib 5, src/**tests** 3, src/sandbox 3, src/state 3, src/loop 2, src/input-scan 1, src/prompts 1, src/providers 1, src/report-model 1, src/tasks 1
- `@inflexa-ai(no-instanceof-error)`: src/tools 18, src/loop 6, src/tasks 6, src/workflows 5, src/literature 4, src/providers 4, src/sandbox 4, src/lib 3, scripts 2, src/app 2, src/citations 2, src/memory 2, src/state 2, src/**tests** 1, src/agents 1, src/report-render 1, src/runtime 1, src/schemas 1
- `@inflexa-ai(no-unknown-type-guards)`: src/tools 19, src/app 6, src/report-render 5, src/loop 4, src/memory 4, src/citations 3, src/lib 3, src/literature 3, src/tasks 3, src/input-scan 2, src/providers 2, src/runtime 2, scripts 1, src/report-model 1, src/state 1
- `@inflexa-ai(no-typeof-object)`: src/tools 12, src/lib 8, src/report-model 8, src/providers 7, src/memory 3, src/report-render 3, src/literature 2, scripts 1, src/**tests** 1, src/contracts 1, src/execution 1, src/input-scan 1, src/loop 1, src/reference-data 1, src/runtime 1, src/state 1
- `@inflexa-ai(no-empty-schema)`: src/tools 28, src/sandbox 5, src/state 4, src/lib 3, src/contracts 2, src/schemas 2, scripts 1, src/execution 1, src/input-scan 1, src/memory 1, src/report-model 1
- `restrict-template-expressions`: src/report-render 11, src/input-scan 7, src/tools 6, src/tasks 5, src/report-model 4, src/app 3, src/citations 2, src/sandbox 2, src/literature 1, src/workflows 1
- `no-deprecated`: src/sandbox 13, src/citations 7, src/providers 4, src/contracts 2, src/loop 2, src/tools 2, src/data 1, src/literature 1, src/schemas 1
- `no-unnecessary-type-conversion`: src/tools 16, src/**tests** 4, src/state 4, src/report-model 1, src/report-render 1, src/tasks 1
- `no-misused-spread`: src/input-scan 8, src/lib 6, src/tools 4, src/report-render 2, src/state 2, src/citations 1, src/providers 1, src/report-model 1, src/sandbox 1, src/workspace 1
- `@inflexa-ai(export-at-declaration)`: src/tools 9, src/providers 5, src/loop 2, src/execution 1, src/lib 1, src/report-model 1, src/report-render 1, src/sandbox 1, src/state 1
- `unbound-method`: src/loop 4, src/runtime 2, src/sandbox 2, src/tools 2
- `no-unnecessary-type-arguments`: src/state 4, src/memory 3, src/tools 2
- `no-redundant-type-constituents`: src/contracts 2, src/loop 2, src/providers 2, src/lib 1, src/memory 1, src/state 1
- `no-useless-default-assignment`: src/tools 7
- `no-unnecessary-type-parameters`: src/workflows 4, src/lib 1, src/state 1
- `only-throw-error`: src/workflows 4, src/providers 1
- `restrict-plus-operands`: src/report-model 2, src/report-render 1
- `no-unnecessary-boolean-literal-compare`: src/tools 3
- `no-invalid-void-type`: src/memory 2, src/execution 1
- `no-duplicate-type-constituents`: src/contracts 1, src/loop 1, src/providers 1
- `use-unknown-in-catch-callback-variable`: src/lib 1, src/tools 1
- `prefer-promise-reject-errors`: src/citations 1, src/tools 1
- `no-unnecessary-template-expression`: src/input-scan 1, src/tools 1
- `no-dynamic-delete`: src/memory 1, src/providers 1
- `no-confusing-void-expression`: src/tasks 2
- `await-thenable`: src/memory 1

## Group 1 outcome (post-fix run `harness/tmp/pi/709-after-g1.json`)

`bun --bun oxlint src scripts` after tasks 1.1 and 1.2: 968 reports remain in total.
`typescript/no-deprecated` (38), `typescript/no-confusing-void-expression` (2),
`typescript/await-thenable` (1), and `typescript/restrict-plus-operands` (3) each report 0.
`bun run typecheck` passes, and the module tests of each changed file pass.

### The `instanceofErrorAllowIn` list wired into `typescript()`

- `src/lib/result.ts` — the Result→throw bridge (`toThrowable`/`ResultError`): normalizing an
  arbitrary thrown value into an `Error` is the module's job, and every DBOS step and tool
  boundary unwraps through it.
- `src/lib/logger.ts` — the shipped `errorFields` (`defaultErrorFields`) of the `Logger` seam:
  it must classify any thrown value for a sink it does not control.

The probed population named no other module that meets the design D2 criterion.
`src/lib/fs-helpers.ts`, `src/lib/rate-limit.ts`, and `src/lib/page-capture.ts` each hold one
`instanceof Error` site, but normalizing a thrown value is not their job, so they stay in the
task 4.1 worklist.

### no-deprecated sites fixed (38: 33 non-test, 5 test)

- `.passthrough()` → `z.looseObject(...)` with identical parse semantics (`looseObject` is a
  `ZodObject` in loose mode, so `.extend()` keeps working): `src/sandbox/farm.ts` (7),
  `src/sandbox/image-packages.ts` (6), `src/citations/clients/crossref.ts` (3),
  `src/citations/clients/doi-registry.ts` (4), `src/literature/sources/semantic-scholar.ts` (1),
  `src/schemas/file-metadata.ts` (1), `src/tools/lib/test/string-client.test.ts` (1).
- `z.string().url()` → `z.url()`: `src/contracts/analogy-report.ts` (2).
- `z.string().date()` → `z.iso.date()`: `src/data/safety-panel-schema.ts` (1).
- `z.ZodIssueCode.custom` → `code: "custom"`: `src/tools/research/inspect-run.ts` (2).
- AI SDK content-part reads: the deprecated `file-data`/`file-url`/`file-id` members of the
  content-part union carry the deprecated `type` declarations, so any `.type` read over the full
  union reports. The reads now narrow by property presence instead:
  `src/loop/tool-output.ts` (2, `"text" in part`), `src/loop/test/tool-output.test.ts` (1),
  `src/loop/test/run-agent.test.ts` (2 — the text find narrows by `"text" in p`; the file find
  narrows by `"data" in p`, which keeps the live `file` member and the deprecated `file-data`
  twin, and the following `data` assertion rejects the deprecated string form, so the pin holds).
  No harness site constructs a tool-result file part in the deprecated shape.
- AI SDK `system` → `instructions` (same wire shape; `Instructions` accepts
  `string | SystemModelMessage`): `src/providers/ai-sdk.ts` (2),
  `src/loop/test/prompt-cache.test.ts` (1).
- AI SDK `fullStream` → `stream` (the same `TextStreamPart` iterable): `src/providers/ai-sdk.ts` (2).

### bun-types pair and carried restrict-plus-operands sites

- `src/tasks/data-profile.ts:665,865` — `return await suspendProfile(...)` returned a void
  expression. The fix the rule names moves the `await` before a bare `return`.
- `src/memory/conversation-display-recorder.ts:177` — `Promise.all` over a
  `void | Promise<void>` map result. Each element is now wrapped in `Promise.resolve(...)`, the
  rule-named fix. The sink calls still start synchronously in stream order.
- `src/report-render/number-format.ts:501` — `grouped += digits.charAt(index)`. The loop bound
  `index < digits.length` proves the read in range, and `charAt` returns the same UTF-16 unit,
  so the produced string is unchanged.
- `src/report-model/production-resolver.ts:340,359` — the two `field += ch` reads now feed from
  `const ch = text.charAt(i)` inside the `while (i < n)` loops; same produced string.

### Deliberate-site calls made in group 1

None. Every fixed site took the fix the rule message names. No value that was already correct
changed, and no contract a spec records broke.
## Group 2 outcome (no-base-to-string, 241 reports: 98 outside the test globs, 143 in test files)

`bun --bun oxlint src scripts` reports 0 for `typescript/no-base-to-string` outside test files
after task 2.1, and `bun --bun oxlint` reports 0 for the rule anywhere after task 2.2. Against the
group-1 baseline run, no other rule gained a report. `bun run typecheck` passes, and the module
tests of the changed modules pass (5260 tests across 314 files: 5208 pass, 51 skip, and the one
failure below, fixed and re-run green).

### The two helpers the family needed

- `src/lib/unknown-text.ts` (new): `textOf(value: unknown): string` — a string stays itself, each
  primitive (null and undefined included) keeps its `String` render, and a record or array renders
  as JSON (`jsonTextOf`, with the default object stringification as the fallback when
  `JSON.stringify` throws or its `toJSON` gives `undefined`). A call site whose old leaf was
  `String(x ?? "")` carries its `?? ""` inside the call. This is the `JSON.stringify` shape of design D2 in one place; it avoids
  both `instanceof Error` (the task-4.1 rule) and the `typeof === "object"` probe (the task-3 rule),
  so it creates no work in another group.
- `src/lib/test/request-url.ts` (new): `requestUrlText(input: string | URL | Request): string` —
  each member of the fetch input union names its URL itself (`href`, `url`), which replaces the
  `String(input)` idiom in the fetch doubles.

The thrown-value sites keep their existing `x instanceof Error ? x.message : ...` narrow and swap
only the `String(x)` leaf for `textOf(x)`. The parsed-leaf sites (pubmed XML text, the ECharts option
trees, DBOS step inputs) read `textOf(...)` the same way.

### Deliberate-site calls made in group 2 (each with its inline directive)

- The 14 `String(<jsx .../>)` render calls in `src/report-render/views/` (`chart-view.tsx:118`,
  `page-view.tsx:74,99,142`, `prose.tsx:87,132,157,172`, `references-view.tsx:270`,
  `values.tsx:100,120,261,303,337`; lines as of the task-6.1 audit — the task-4.2 return-type
  directives above some of these functions shifted the earlier lines): hono's `JSXNode.toString()` renders these sync element trees to
  HTML — the string form is a real domain concept — but its declared return is
  `string | Promise<string>`, which the rule cannot see past. Each carries
  `// oxlint-disable-next-line typescript/no-base-to-string -- ...`.
- `src/lib/test/console-logger.test.ts:145` — the realization under test maps with the default
  `String` form of an `Error` (`"Error: boom"`, pinned by the test); `textOf` would JSON-render the
  error as `{}` and change a value that was already correct.

### Value-form notes (values that were already wrong; the fix replaces them)

- A thrown non-Error `undefined` or `null` keeps its `"undefined"`/`"null"` render in a detail or
  log field: those strings were already correct, so `textOf` keeps them (correction round 1
  restored this after the first pass rendered empty text).
- A non-Error thrown object, a parsed-JSON leaf of the wrong shape, or an ECharts `unknown` leaf
  rendered `[object Object]` (or a comma join for arrays); `textOf` renders JSON. The pinning tests
  (chart fixtures, pubmed parse tests, provider request pins) pass unchanged.

## Group 3 outcome (task 3.1 done, task 3.2 remains: the test-file sites)

`@inflexa-ai/no-unknown-type-guards` outside the test globs is at 0: 47 sites fixed, 12 sites
deliberate under the `no-unknown-type-guards` zones of `oxlint.config.ts`. `@inflexa-ai/no-typeof-object`
outside the test globs is at 0: 52 sites, 40 fixed and 12 deliberate under the `no-typeof-object` zones
(now seven files: the five predicate-body files of the earlier pass, plus `src/providers/errors.ts` for
the body of the zoned `isProviderError`, plus `src/report-model/reference-stamp.ts` for the faithful-copy
walk). `@inflexa-ai/no-empty-schema` outside the test globs is at 0: 49 sites, 40 fixed and 9 deliberate
under the `no-empty-schema` zones (six files, enumerated below). The three rules' test-file reports (57
empty-schema, 35 typeof-object, 25 unknown-type-guards) are the task-3.2 remainder. `bun run typecheck`
passes, and the module tests of each changed file pass (two regressions were found and corrected: the
first `reference-stamp` rewrite used a zod record parse whose rebuild drops a `__proto__` own key — the
faithful-copy pin of `reference-stamp.test.ts` — so the stamp walk went back to its hand probes and
joined the zone; and the first `parseJsonTable` cell schema refused a non-finite JSON number, which
`JSON.parse` produces for `1e999` and the coercion must drop). No other rule gained a report against
the group-2 baseline run.

### The zone list (each entry names one rule and one file)

`no-unknown-type-guards` — the boundary predicates:

- `src/lib/unknown-array.ts:6` — `isUnknownArray` (ledgered): `Array.isArray` alone narrows
  `unknown` to `any[]`; the guard yields `unknown[]`.
- `src/lib/null-proto.ts:15` — `isRecordOf<T>` (ledgered): the generic record guard behind
  `nullProtoRecord`; a zod schema cannot express the caller's `T`.
- `src/lib/result.ts:127` — `isResult`: the runtime brand check of the neverthrow `Ok`/`Err`
  class identity; a schema cannot check class identity. Pinned by `src/lib/test/result.test.ts`.
- `src/providers/errors.ts:89` — `isProviderError`: the structural narrow the provider error paths share, safe across module realms by design.
- `src/loop/run-agent.ts:1498` — `isAskRejected`: class-or-name brand that recognizes a
  rejection thrown from a different module realm, where `instanceof` against this file's class
  reference would miss.
- `src/literature/sources/pubmed.ts:98,131` — `isRecord`/`isDocSumItem`: the predicates over
  PubMed XML parse output; the walk narrows each field on read.
- `src/tools/define-tool.ts:52,104` — `isToolError`/`isToolResultImage`: the boundary
  predicates over a tool ok value.
- `src/tools/display/normalize-echart-spec.ts:40` — `isRecord`: the echart option walk takes
  the container shape at entry and narrows each field on read.
- `src/runtime/result-serialization.ts:62,69` — the `isApplicable` of each recipe: the DBOS
  serialization-recipe contract declares a type predicate, and the check is the neverthrow
  class brand.
- `src/state/snapshot-parse.ts:69` — `isPlainRecord`: the stored-map walk must address the
  original object, because a zod record parse rebuilds the value through string-keyed
  assignment and a `__proto__` own key — the pin contract this module keeps — does not survive
  that rebuild.

`no-empty-schema` — the deliberately open leaves (added by the task-3.1 pass):

- `src/execution/run-synthesis.ts:365` — the submit-synthesis input envelope: the candidate
  synthesis arrives in any shape by design, and `execute` re-parses it against
  `RunSynthesisSchema` itself, so a malformed payload becomes typed validation issues in the
  ok channel instead of a loop rejection at the input boundary.
- `src/lib/unknown-containers.ts:12,15` — the shared walk containers (`UnknownRecordSchema`,
  `UnknownArraySchema`): the unknown leaf is the design — the walk narrows each field and each
  entry on read — and the record schema's shallow rebuild (a `__proto__` own key drops) is the
  behavior the callers pin.
- `src/contracts/chat-frame.ts:24` — the browser-safe generic record schema: `contracts/`
  imports no value from outside its own directory, so the lib walk-container helper cannot be
  reached, and the part schemas narrow the fields downstream.
- `src/sandbox/sandbox-error.ts:156,157,158` — the cause fields (`code`, `statusCode`,
  `response.statusCode`): the cause is an arbitrary thrown value from dockerode, the k8s
  client, or Node itself, and the reader guards each field with `typeof === "number"` because
  a sibling field of the same cause may hold a non-number (a Node error carries a string
  `code`). Typing one field would reject that cause whole and lose a status the reader would
  have found on the next field.
- `src/tools/report-authoring/authoring-tools.ts:70` — the permissive arm of the block
  payload union: a malformed block must reach `execute`, which parses it against the draft
  grammar and refuses `malformed-block` as typed data; a strict arm would turn that designed
  refusal into a hard input-validation error at the loop boundary.
- `src/tools/research/generate-plan.ts:707` — the permissive arm of the submit_plan candidate
  union: a malformed candidate must reach `execute` so its issues come back as structured
  reports, not as a parse refusal.

`no-typeof-object` — the `typeof` bodies of those predicates, plus one contract case:

- `src/lib/null-proto.ts:16` — the body of `isRecordOf<T>`.
- `src/literature/sources/pubmed.ts:99,132` — the bodies of `isRecord`/`isDocSumItem`.
- `src/tools/define-tool.ts:54,105,116,150` — the predicate bodies plus
  `readToolResultImages`/`readToolCallRecord`: the record rides a unique symbol key that
  `JSON.stringify` omits, and a zod parse clones the value through string keys only, so every
  schema-shaped fix destroys the record.
- `src/tools/display/normalize-echart-spec.ts:41` — the body of `isRecord`.
- `src/state/snapshot-parse.ts:70` — the body of `isPlainRecord`, kept for the `__proto__` pin
  contract the rule-4 entry states.
- `src/providers/errors.ts:90` — the body of `isProviderError` (added by the task-3.1 pass).
- `src/report-model/reference-stamp.ts:89,168` — the container checks of the stamp walk and the
  `stripReferenceHashes` walk: the copy must carry an own
  `__proto__` key of a `JSON.parse` payload — the faithful-copy pin of
  `reference-stamp.test.ts:217` — which a record parse rebuild drops through string-keyed
  assignment. The first rewrite tried `parseUnknownRecord` and the pin test caught it.

### Sites fixed instead of zoned (seed-list entries that took the fix)

- `src/memory/card-builders.ts:32` `isRecord` — one call site; the `parseUnknownRecord` check
  carries the same shape, so the predicate is gone.
- `src/tools/knowledge/recommend.ts:69` `isRecord` — the one use became
  `situation: parseUnknownRecord(joined.situation)`, which is the answer field's exact type.
- `src/input-scan/readout.ts:340` `isRecord` — the two uses read `parseUnknownRecord`.
- `src/report-render/figures/common.ts:760` and `src/report-render/figures/dense.ts:219` —
  `EchartOption` is `Record<string, unknown>`, so the series filter maps through
  `parseUnknownRecord` with no predicate and no zone.
- `src/memory/ai-sdk-message-storage.ts:89` `isContextKind` — `z.enum(CONTEXT_KINDS)` parse
  carries the kind inward; the predicate is gone.
- `src/tools/lib/ctx-ops.ts:144` `isString` — the one point-free use became a `typeof` filter
  over a flatMap; the predicate is gone.
- `scripts/refresh-fixtures.ts:278` `isRecord` — the one use reads `parseUnknownRecord`.
- The filters that narrowed known unions dropped their annotations (TypeScript infers the
  predicate): `data-profile-orientation.ts` (5), `crossref.ts:36`, `doi-registry.ts:30,89`,
  `menu.ts:247`, `arxiv.ts:148`, `run-agent.ts:1022,1560`, `ai-sdk.ts:649`,
  `data-profile-absorb.ts:231`, `data-profile-resolve.ts:553`, `capability-data.ts:53`,
  `execute-analysis.ts:146,169`, `skeleton.ts:212,217`, `chembl-client.ts:703`, `ctx-ops.ts:228`.
  Truthy/compound filters that TypeScript cannot infer became `flatMap` ternaries with
  identical bodies: `data-profile-orientation.ts:421`, `data-profile-index.ts:203`,
  `tool-call-integrity.ts:84`, `ad-hoc-router.ts:300` (find), `skeleton.ts:156`,
  `chembl-client.ts:553`, `openfda-client.ts:200`, `uniprot-client.ts:244`,
  `recommend.ts:74`. `reference-resolver.ts:260` inlines the negated `holdsNoRank` shape so
  the row narrows to `RankableRow`. `generate-plan.ts:151` (a tuple narrow TypeScript cannot
  infer) became a typed reduce. `run-agent.ts:1422` `isJsonValue` became `z.json().parse` —
  the stringify/parse round trip holds only JSON values, so the parse never refuses.

### Value-form notes (values that were already wrong; the fix replaces them)

- `parseUnknownRecord` rebuilds a record through string-keyed assignment, so a `__proto__` own
  key drops out of the values it returns. The paths that rebuild for reads only —
  `readout.ts` JSON-prefix key lists, `refresh-fixtures.ts` diff walk,
  `conversation-display-storage.ts` dropped-parts rebuild — lose such a key on pathological
  input where the old `typeof` probe kept it. No test pinned those values. The two paths that
  must address the original object (`snapshot-parse`, the `define-tool` symbol-key readers)
  keep their hand probes under zones for exactly this reason.

### Rule-3 non-test sites fixed by the task-3.1 pass (52 `no-typeof-object` minus the zoned 19, and 49 `no-empty-schema` minus the zoned 9)

`no-typeof-object` fixes, by the shape each took:

- Cause-field probes became literal object schemas: `src/lib/db-result.ts` (`sqlstate` →
  `z.object({ code: z.string() })`, `constraintName` → `z.object({ constraint:
  z.string().min(1) })`), `src/lib/fs-result.ts` (`errnoOf`),
  `src/execution/dbos-workflow-purger.ts:50`, `src/runtime/dbos.ts:295`, and
  `src/tools/workspace/workspace-search.ts:30` (each the `z.object({ code:
  z.literal("42P01") })` form). `z.object` accepts the class instances (pg, Node) whose
  fields ride as own enumerable properties, so the captured causes still parse.
- Record walks read `parseUnknownRecord`: `src/lib/zod-issues.ts:208` (the `parseAs` cell now
  parses with `UnknownRecordSchema` or `z.array(z.json())` directly), `src/lib/result.ts:74`
  (`describe`), `src/providers/ai-sdk.ts:351,375` (`fallbackModelOf`,
  `inputTransformationsOf`), `src/providers/prompt-cache.ts:213` (`canHostBreakpoint`),
  `src/report-model/draft-hash.ts:28` (`canonicalize` — its old body already parsed the
  record, so the outer probe was the same check twice), `src/report-model/draft-operations.ts:154`
  (the payload check and its parse merged), `src/report-model/reference-resolver.ts:76`
  (`snapshotRows`), `src/contracts/report-reference.ts:324` (`sortKeysDeep`),
  `src/tools/knowledge/client.ts:346` (`messageOf`), `src/tools/research/generate-plan.ts:868`
  (`inventoryContent`), `src/report-render/test/page-function.ts:31` (`pageExports`),
  `src/__tests__/setup/metrics.ts:49` (the histogram point).
- Thrown-object gates became `z.instanceof(Object)`: `src/providers/errors.ts:276`
  (`findInCauseChain` — the cursor is whatever a `throw` carried, mostly Error instances whose
  own fields a record schema cannot reach) and `src/providers/ai-sdk.ts:397,766`
  (`apiCallErrorOf`, `streamPartFailure`, the same `ThrownObject` schema). The gate accepts
  exactly the population the old `typeof` probe accepted, and the parse passes the original
  through, so the cause chain and the array-shaped stream payloads behave as before.
- Array-aware record checks: `src/lib/zod-issues.ts:265` (`resolvePath` steps through a
  record or an array — the zod paths only ever name schema-declared positions, so a function
  container, which the old probe also accepted, cannot sit at a walked position),
  `src/lib/zod-issues.ts:282` (`setAtPath` branches on `isUnknownArray` before the record
  parse; a string key into an array root builds through `Object.fromEntries` so no array
  spreads into an object), and `src/reference-data/catalog.ts:147` (`deepFreeze` decides
  "record or array" through a `z.custom` passthrough, because the freeze must land on the
  original container, not on a rebuilt copy).
- Known-union probes deleted: `src/report-model/draft-operations.ts:205,260` narrow the
  `DraftPlace` union with `place !== "start" && place !== "end"`, and
  `src/tools/lib/ctx-ops.ts:205` (`extractAc50Raw`) reads the already-typed `mc5Param` — the
  `typeof` probes were dead weight over typed unions.
- The `parseJsonTable` cell check of `src/report-model/production-resolver.ts:443` is now
  inside the schema: `JsonTableCell` (`z.custom` over the JSON scalars, non-finite numbers
  included) refuses a nested cell at parse time, so the mid-walk container probe is gone.
  `src/memory/ai-sdk-message-storage.ts:288` reads the record check off
  `parseUnknownRecord` beside `isJSONValue`.

`no-empty-schema` fixes, by the shape each took:

- Wire and storage payloads became `z.json()` (or `z.record(z.string(), z.json())` /
  `z.array(z.json())`): `src/schemas/workflow-state.ts:192,208`, `scripts/refresh-fixtures.ts:273`,
  `src/tools/knowledge/client.ts:50,80,88,152,164,345`, `src/tools/lib/ctx-ops.ts:58,117`,
  `src/state/plans.ts:172`, `src/tools/lib/impc-client.ts:57,58`,
  `src/tools/sandbox/list-available-refs.ts:284,327,343`, `src/tools/lib/__fixtures__/fixture-runner.ts:70`,
  `src/tools/report-authoring/authoring-tools.ts:441`, `src/state/runs.ts:585`,
  `src/tools/display/show-user.ts:43`, `src/input-scan/readout.ts:337`,
  `src/state/schema.ts:75,127`, `src/tools/lib/openfda-client.ts:58,59,60,72,74,75,76,77`,
  `src/memory/conversation-display-storage.ts:92`, `src/contracts/schemas/chat-parts.ts:49`,
  `src/sandbox/farm.ts:59` (`pak_lock`), `src/sandbox/types.ts:230` (`payload`). Each parse
  site feeds from `JSON.parse`, a service body, or a stored JSONB/JSON column, so `z.json()`
  accepts exactly what the old `z.unknown()` accepted there and types the value as JSON.
  `src/lib/zod-issues.ts:203` (`parseAs`) parses with the schema each expectation names.
- The describe-what-you-except shapes: `src/tools/knowledge/template.ts:227` — the `slots`
  record now carries the union its own tool description promises (`string | number | boolean
  | string[]`), and `src/tools/lib/clinical-trials-client.ts:101` types `otherNames` as the
  string list the mapper builds (`i.otherNames ?? []`).

### Deliberate-site calls made in the task-3.1 pass

The nine `no-empty-schema` sites and the three new `no-typeof-object` sites of the zone list
above. Each names a spec-recorded or pinned contract: the permissive-envelope refusals, the
walk-container rebuild behavior, the browser-safe contracts boundary, the thrown-cause field
variety, and the `__proto__` faithful-copy pins. `z.json()` was tried for the two permissive
union arms first and reverted, because it retyped the tool input as `AuthoringBlock | JSONType`
and broke the in-memory callers.

### Task-3.2 remainder (all in test files, next agent)

`bun --bun oxlint` still reports 57 `no-empty-schema`, 35 `no-typeof-object`, and 25
`no-unknown-type-guards`, all in `*.test.{ts,tsx}` files. The known deliberate candidates are
the test-side `isRecord` pair (`render.test.ts:286`, `table-data.test.ts:124`) and
`isRendererFunction` (`chart-renderers.test.ts:114`); every other site takes the fix shapes
above (`z.json()` for fixture/wire literals, `parseUnknownRecord` for record probes, the
schema-described shape for test schemas).

## Group 3.2 outcome (task 3.2 done; the three rules report 0 over the whole tree)

`bun --bun oxlint` reports 0 for all three rules. The pass fixed 57 `no-empty-schema`, 34
`no-typeof-object`, and 22 `no-unknown-type-guards` test-file sites, and the zone list gained
four test-side deliberate sites (recorded below). `bun run typecheck` passes, and the module
tests of the changed files pass (1696 tests across 61 files; one regression found and fixed,
see the string-client note). No other rule gained a report against the group-3.1 baseline run.

### The fix shapes the test sites took

- `parseJsonAs(<stored or captured text>, z.unknown())` became `z.json()` — the value came from
  `JSON.parse`, so `z.json()` is exactly what the parse produces. This covered the fixture
  bodies, the captured fetch bodies, the decision records, and the exec-env payloads.
- Record leaves of walk schemas became `z.record(z.string(), z.json())` (the cbioportal,
  comptox, impc, disgenet, uniprot, and opentargets oracle walks, the prompt-cache message
  parts, and the searxng positive answers).
- Record probes merged into `parseUnknownRecord` (the `asRecord` helpers of the knowledge,
  workspace, and console-logger tests, the briefing sentinel walk, the data-profiler schema
  walk, the echart option walks of `ma`/`volcano`/`manhattan`/`chart`, the csstree module
  read, and the single checks in `chat-turn`, `synthesize-run`, `dbos-workflow-purger`,
  `ai-sdk.test`, `generate-plan`, `edit-file`, `reference-stamp:228`). A gate-only
  `parseUnknownRecord(...)` call takes no copy, so the `__proto__` assertions beside it still
  read the original.
- Known-union filters dropped the `p is T` predicate and became `flatMap` ternaries
  (`tool-result` parts, the run-event stream parts, `FinishGap`, gallery chart blocks, the
  `EmitEvent` tool events). Compound `find` sites became `flatMap` plus `.at(0)`.
- Known-union `typeof === "object"` probes narrowed by their real discriminant: the pg
  `Querier` double branches on `typeof arg === "string"` first and then checks `"values" in`
  over the config member; the node `server.address()` sites narrow the `AddressInfo | string`
  union with `typeof address === "string"`; the OTel histogram reads narrow the
  `number | Histogram` union with `typeof histogram === "number"` and then check `count`/`sum`
  with `in`.
- Leaves the test asserts on became the shape the fixture holds: the fixture-runner selftest
  pair (`id: z.number()` positive, `id: z.string()` drift), the searxng drift answers
  (`z.array(z.string())`), the gateway ask-state `reply: z.json()`, the search-regulatory
  lookup `error: z.json().optional()`, and the bgee score leaf `z.json()`.

### The zone list gains (each entry names one rule and one file; line-level record)

`no-unknown-type-guards` — the test-side predicates of the `__proto__` pins and the register
pin, added to the existing zone:

- `src/report-render/test/render.test.ts:286` — the test-side `isRecord`: the
  prototype-pollution fixtures stage an own `__proto__` key, and the guard must answer on the
  original object; `parseUnknownRecord` answers on a copy whose rebuild drops the key.
- `src/report-render/test/table-data.test.ts:124` — the test-side `isRecord`: the staged rows
  must keep an own `__proto__` key, so the guard reads the original and takes no copy.
- `src/report-render/test/chart-renderers.test.ts:114` — `isRendererFunction`: the register
  test compares the registered renderer functions by identity, so a function check is the
  whole check.

`no-typeof-object` — the walker of the stamp pin, added to the existing zone:

- `src/report-model/test/reference-stamp.test.ts:37` — the `field` walker reads the original
  stamped payload, because the suite pins an own `__proto__` key that a record parse rebuild
  drops; the sibling gate at `:228` took the fix (a `z.instanceof(Object)` narrow, the 3.1
  thrown-object gate shape), so the file holds exactly one kept site.

### Deliberate-site calls made in the task-3.2 pass

The four zone gains above. `isRendererFunction` keeps its `typeof value === "function"` check
because the register comparison is by identity; the two `isRecord` guards keep the predicate
because the fixtures they read pin an own `__proto__` key.

### Value-form notes and one correction

- The searxng positive test's `typeof answer === "object"` probe became a vacuous restatement
  once the answers schema types each answer as a record, so the assertion became
  `expect(positive.answers.length).toBeGreaterThan(0)`, which keeps the fixture non-vacuous;
  the object shape itself now rides the schema.
- The string-client drift twin holds the broken string form on one row and the live array form
  on the rest, so the first rewrite (`preferredNames: z.string()`) refused the twin at parse
  time and the module test failed. The leaf is now `z.json()` — the walk accepts the mixed
  population, and the `typeof` assertion on row 0 stays the pin.
- `activitiesOf` in the run-event-stream test dropped its `StepActivityPart[]` annotation:
  `ChatPart`'s forward-compat data member (`type: \`data-${string}\``) keeps every `data-*`
  literal possible at the type level, so the flatMap ternary cannot eliminate it. The field
  reads that need text carry through `textOf`.

## Group 4 outcome (task 4.1 done, task 4.2 NOT started — budget handoff)

`bun --bun oxlint` reports 0 for `@inflexa-ai/no-instanceof-error` over the whole tree
(77 live reports: 65 outside the test globs, 12 in test files). `bun run typecheck` passes.
The module tests of the changed files pass (1036 pass / 1 fail across 51 files; the one
failure is recorded below as pre-existing on the branch and outside this group's edits).

### The `instanceofErrorAllowIn` list gains one entry

- `src/lib/thrown.ts` (new) — the shared thrown-value reads the catch sites normalize
  through: `errorOf` is the exact Error passthrough ("already an Error → use it as one"),
  and a structural lookalike must not pass, so the check must see the class;
  `errorMessageOf` / `errorNameOf` are the structural message and name reads.

The probed population named no other module that meets the design D2 criterion. Each of
`src/lib/fs-helpers.ts`, `src/lib/rate-limit.ts`, `src/lib/page-capture.ts` took the fix
shapes instead (the code read, the abort-reason passthrough, the cause chain).

### Sites fixed (77: 65 non-test, 12 test), by the shape each took

- Message extraction `x instanceof Error ? x.message : textOf(x)` became
  `errorMessageOf(x) ?? textOf(x)` (39 sites, non-test and test alike).
- Name checks became `errorNameOf(x) === "<name>"`: the abort probes
  (`src/app/chat-turn.ts`, `src/loop/genai-spans.ts`, `src/loop/run-agent.ts` isFatalLoopError,
  `src/providers/ai-sdk.ts` isAbortError, `src/providers/streaming-chat.ts`) and the
  cross-realm class-or-name fallbacks (`src/loop/run-agent.ts` isAskRejected,
  `src/tools/execute-analysis.ts` isDedupCollision).
- Exact Error passthrough became `errorOf(x)`: the abort-reason helpers
  (`src/citations/resolve.ts`, `src/lib/rate-limit.ts`, `src/literature/sources/http.ts`),
  the rethrow-or-wrap of `src/state/init.ts`, the stream-part passthrough of
  `src/providers/ai-sdk.ts` streamPartFailure, the tool-failure span of
  `src/loop/run-agent.ts` markToolFailure, the cause attach of `src/lib/page-capture.ts`,
  the Error-and-bigint replacer of `src/runtime/result-serialization.ts`, the
  ErrnoException code read of `src/lib/fs-helpers.ts`, and the assertion guards of the
  test files (`src/execution/test/step-summary.test.ts`, `src/lib/test/page-capture.test.ts`,
  `src/tools/test/execute-analysis.test.ts`, `src/tools/workspace/test/read-file.test.ts`,
  `src/workflows/__tests__/dbos/test/workflow-replay.test.ts`,
  `src/workspace/test/filesystem.test.ts`).
- The log-arg pair `err instanceof Error ? err.message : err` became
  `errorMessageOf(err) ?? err` in `src/tasks/regulatory-corpus-boot-refresh.ts` (4 sites):
  the non-Error arm logs the thrown value itself, as before.
- Narrowing-loss reworks: the guard forms that previously narrowed the guarded variable
  took shapes that narrow again — `Array.isArray` at the fake-pool answer site of
  `src/workflows/test/execute-analysis.test.ts` (a `FakeAnswer = unknown[] | Error` that
  is not an array is the scripted failure), a `"finishReason" in r` shape at
  `src/execution/test/step-summary.test.ts`, an intermediate `Error | undefined` at
  `src/workflows/__tests__/dbos/test/workflow-replay.test.ts`, and the known-union
  predicate `isStepResult` at the `handleFor` fake of the same file.

### Deliberate-site zone made in the task-4.1 pass (one rule, one file)

`no-typeof-object` — `src/lib/thrown.ts:21,28` — the object gate of `errorMessageOf` and
`errorNameOf`: `in` cannot run on a primitive, and the gate must stay realm-safe and
enumeration-safe — a record parse rebuild answers on a copy that drops an Error's own
non-enumerable `message` and inherited `name` (the exact reads these helpers exist for),
so the read must see the original object.

### Value-form notes (values that were already wrong; the fix replaces them)

- An abort DOMException is not an `Error` subclass, so the old
  `err instanceof Error && err.name === "AbortError"` probes misread a real abort as a
  failure (the span paths marked a cancellation ERROR; the fatal-error gate missed it).
  `errorNameOf` reads the name, so the cancellation classifies as the cancellation it
  names. The DOMException disjuncts of run-agent and streaming-chat are subsumed.
- A thrown object that carries a string `message` now renders its message in the detail
  and log fields where `textOf` rendered JSON. `src/sandbox/sandbox-error.ts` causeLine
  now surfaces such a message instead of returning `undefined`. This is the same class
  of read `src/lib/result.ts` `describe` already makes for structured error values.

### Pre-existing failure met by the module-test run (not this group's edit)

`src/memory/test/conversation-display-replay.unit.test.ts` — "keeps parentPlanId through
the recorder, the stored envelope, and its parse" fails on a zod refusal of the stored
`data-plan` part (`data.omicsSubtype` received `undefined`). The failure sits in the
envelope parse that group 3's working-tree edits to
`src/memory/conversation-display-storage.ts` and the plan-card schema feed; the task-4.1
edit of that module touches only the message of the rethrown error, so the parse outcome
is identical with and without it. Open for the coordinator to route.

### Task-4.2 remainder (next agent)

`typescript/explicit-function-return-type` still reports its 89 live sites (all outside
the test globs; the factory keeps the rule off in tests). No 4.2 site was written yet.

## Regression fix in the snapshotRows row gate (job A of the final round, issue #709 group 5)

The group-3.1 rewrite of `snapshotRows` (`src/report-model/reference-resolver.ts`) had replaced
the hand row gate plus the own-key walk (`Object.keys` + `Reflect.get`) with `parseUnknownRecord`,
whose zod record parse rebuilds each row through string-keyed assignment and drops an own `__proto__`
column — the exact pin the three failing tests of `src/report-model/test/validate.test.ts` keep
(the scalar and projected-column references into a prototype-named column). The own-key walk and
the hand gate are back; the walk addresses the ORIGINAL row again. The gate must stay local: the
ledgered guards (`isRecordOf` in `src/lib/null-proto.ts`, `isPlainRecord` in
`src/state/snapshot-parse.ts`) are module-private, and no shared no-rebuild guard is exported, so
`src/report-model/reference-resolver.ts` joins the `no-typeof-object` zone of `oxlint.config.ts`
(one rule, one file, reason in the comment). The kept site is the row gate at
`src/report-model/reference-resolver.ts:76` — the file holds exactly one report of the rule.
The parse output is byte-identical for every input: the gate refuses exactly what the zod record
refused (null, non-object, array), and `Reflect.get` on an own key reads the same cell the
`Object.entries` walk read.

The sibling `applyRowBound` rewrite in the same task-3.1 hunk was re-checked for arm equivalence
and kept: the `rankable` flatMap condition (`cell !== undefined && !(numeric && rest.value ===
undefined)`) is the exact negation of `holdsNoRank`, and `unrankable` still filters with
`holdsNoRank` itself, so the partition is exact and disjoint; every arm behaves as before.

Verified: `bun test src/report-model/test/validate.test.ts` passes (91 tests),
`bun test src/report-model/` passes (313 tests), `bun run typecheck` passes.

## Group 5 outcome (task 5.1 done; task 5.2 part done — budget handoff)

`bun --bun oxlint` reports 0 for `typescript/unbound-method` (52 sites: the 10 non-test sites take
`obj.method.bind(obj)` or a local arrow; the 42 test sites take `?.bind(...)` on the same guard
shape) and for `typescript/restrict-template-expressions` (66 sites: each nullable scalar
interpolation takes `String(expr)`, which renders byte-identically to `${expr}` for every type;
the two header-field pairs take `String(value)` over the `string | number | boolean` readout
columns). `bun run typecheck` passes, and the module tests of the changed modules pass (5954
pass / 0 fail across the touched trees).

Four 5.2 rules are at 0:

- `no-misused-spread` (33): every string spread took `Array.from(str)` — the identical code-point
  iteration the code-point comments already document (the providers/errors excerpt, the draft-read
  clip, the refs budget). `untracedFetch` now declares its init as `Omit<RequestInit, "headers"> &
  { headers?: Record<string, string> }`, the shape its two callers pass. The trigger-test pool
  wrapper drops the `...pool` spread (the dep contract reads `query` alone).
- `no-unnecessary-type-conversion` (31): each dropped `String`/`Number` wraps a value its type
  already holds. The one deliberate site is `src/state/artifacts.ts:155-156` (the directive and
  `size: Number(r.size)`):
  pg delivers the bigint column as text while the row annotation says `number`, so the conversion
  is real — the first rewrite dropped it and the `queryArtifactPage` pin caught the string sizes.
- `export-at-declaration` (22): each import+export pair became one `export ... from` statement;
  imports stay only where the file uses the name. `Querier` in `src/lib/db-result.ts` takes the
  `export` on its declaration. `ProviderOptions` re-exports from `@ai-sdk/provider-utils`, not
  `"ai"` — the first single-statement rewrite pointed at the wrong module and the dependents read
  an error type.
- `prefer-promise-reject-errors` (13): all deliberate, each with an inline directive — rethrow
  bridges (`Promise.reject(cause)` after a catch) and abort-reason rejects carry the value whose
  identity the awaiter reads; the streaming-chat and k8s-client rigs reject the exact scripted
  reason the production path carries. Kept sites (directive lines): `citations/resolve.ts:132`,
  `citations/test/resolve.test.ts:113,198`, `tools/report-session/examine-page.ts:277`,
  `literature/sources/test/http.test.ts:23,42`, `providers/test/ai-sdk.test.ts:1584`,
  `providers/test/ai-sdk.request-timeout.test.ts:61,64`, `providers/test/streaming-chat.test.ts:22`,
  `runtime/test/assemble.test.ts:396`, `sandbox/test/exec.test.ts:406`,
  `sandbox/test/k8s-client.test.ts:51`.

### Task-5.2 remainder (68 live sites, next agent; exact list in `harness/tmp/pi/709-g5-final.json`)

- `no-redundant-type-constituents` (10) and `no-duplicate-type-constituents` (3): the three
  key-set assertions (`providers/types.ts:141`, `contracts/schemas/usage.ts:32`,
  `loop/metrics.ts:111`) take the tuple form
  `[Exclude<A, B>, Exclude<B, A>] extends [never, never] ? true : never` (same bite, no union);
  `state/plans.ts:149` `unknown | null` → `unknown`; `lib/zod-issues.ts:126` and the test twin
  `unknown | undefined` → `unknown`; `memory/thread-store.ts:115` `ThreadType | string` → `string`
  (the runtime `isThreadType` guard owns the closed set).
- `no-unnecessary-type-arguments` (10): drop the default-valued argument (`pool.query<Record<string,
  unknown>>` in `state/runs.ts`, the `, unknown` of `z.ZodType<...>` in `tools/define-tool.ts`,
  `okVoid<DbError>` in `memory/thread-history.ts`, the `, never` of `okAsync` in the enrich test).
- `no-invalid-void-type` (8): `errAsync<void, E>` → `errAsync<never, E>`, `okAsync<void, E>` →
  `okAsync<undefined, E>`, `neverSettles<void>` → `neverSettles<never>`, `ok<void, E>(undefined)` →
  `ok<undefined, E>(undefined)` (pair the two working-memory arms so the carrier types agree),
  `whenLedgerAbsent<void>` → `<undefined>` (typecheck must confirm the `WorkflowPurger.cancel`
  `ResultAsync<void, DbError>` still accepts the chain).
- `no-unnecessary-type-parameters` (7): drop `S extends PlanStep` from the three
  `execute-analysis-scheduler` signatures (the parameter appears only in `readonly S[]`); the
  three `query<R extends QueryResultRow>` wrapper signatures (`state/db.ts:22`,
  `lib/db-result.ts:45`, the test double) are caller-bound (`pool.query<{...}>(...)`) and take
  the deliberate directive.
- `no-useless-default-assignment` (7): drop the destructured defaults the zod schema already
  guarantees (`search-clinical-trials.ts`, `search-geo-datasets.ts`, `search-faers.ts`).
- `no-unnecessary-boolean-literal-compare` (7): use or negate the boolean directly.
- `no-dynamic-delete` (5): `prompt-cache.ts:254` and `working-memory.ts:275` take the
  destructure-rest drop (the inner `bag` destructure beside each shows the idiom); the three
  `process.env` deletes (`otel.test.ts`, `require-reaper.test.ts`) are deliberate — the tests must
  mutate the live env, and a Map cannot stand in.
- `only-throw-error` (5): all deliberate with directives — the two `failStep` rethrows (it always
  throws inside; the outer throw only ends the code path), the DBOS cancellation rethrow (the
  thrown class IS the cancel signal), the synthesis rethrow, and the abort rethrow in ai-sdk.
- `no-unnecessary-template-expression` (4): unwrap the ternary in `tools/execute-analysis.ts:314`,
  the outer `${}` in `menu.ts:356`, and merge the string-literal interpolations in
  `read-tool-output.test.ts:106`.
- `use-unknown-in-catch-callback-variable` (2): annotate the catch callback parameter `: unknown`
  (`lib/chrome.ts:222`, `tools/sandbox/list-available-packages.ts:521`).

## Regression fix in the conversation-display envelope (job A of the final round)

The group-3 conversion of the `DisplayEnvelopeHeaderSchema` `messages` element to `z.json()`
(`src/memory/conversation-display-storage.ts:93`) broke
"keeps parentPlanId through the recorder, the stored envelope, and its parse": the envelope
carries the recorder's `structuredClone` of live UI messages, not JSON text, and a live card
payload holds explicit `undefined` own keys (`planCardOf` emits `data.omicsType: undefined`
and `data.omicsSubtype: undefined` on every ordinary plan card), which `z.json()` refuses.
The element is back to `z.unknown()` — the header checks presence only, and
`validateUIMessages` plus the `dataSchemas` own the shape check. The file joins the
`no-empty-schema` zone of `oxlint.config.ts` (one rule, one file, reason in the comment), and
the kept site is `src/memory/conversation-display-storage.ts:93`.

### The z.json() sweep over the rest of the change (all safe; each feed read in the code)

- `src/loop/run-agent.ts:1419` — the parse runs on the product of
  `JSON.parse(JSON.stringify(...))` with a reviver; no `undefined` or symbol keys can ride.
- `src/sandbox/farm.ts:59` (`pak_lock`) — the schema parses the lock file text through
  `safeParseJsonAs(raw, ...)` at `farm.ts:108`. The leaf is not `z.json()`: the parse of an
  over-large literal yields Infinity, which `z.json()` refuses, so the leaf is the
  non-finite-tolerant `z.custom<unknown>((value) => value !== undefined)` — the exact
  `JSON.parse` output population, the same shape as the `JsonTableCell` leaf of
  `production-resolver.ts`. Pinned by `src/sandbox/test/farm.test.ts`.
- `src/sandbox/types.ts:230` (`payload`) — the sandbox-server poll response, wire JSON.
- `src/state/plans.ts:172`, `src/state/schema.ts:75,127` — pg JSONB/JSON columns (the driver
  parses them with `JSON.parse`); `state/schema.ts` `CortexPlanRowSchema` holds no parse call
  site in the tree beyond that shape.
- `src/contracts/schemas/chat-parts.ts:49` (the echart `spec`) and
  `src/tools/display/show-user.ts:43` — the only producer is `show_user`, whose input schema
  already types `spec` as `z.record(z.string(), z.json())` from the model's JSON tool
  arguments; the reconstruct-on-read path feeds from the stored raw `tool_use` input.
- `src/tools/lib/ctx-ops.ts:58,117`, `src/tools/lib/impc-client.ts:57,58`,
  `src/tools/lib/openfda-client.ts`, `src/tools/knowledge/client.ts` — fetch-boundary service
  bodies.
- `src/lib/zod-issues.ts:203`, `src/state/runs.ts:585`, `src/input-scan/readout.ts:337`,
  `src/tools/report-authoring/authoring-tools.ts:441`,
  `src/tools/sandbox/list-available-refs.ts`, `src/tools/lib/__fixtures__/fixture-runner.ts:70`,
  `src/schemas/workflow-state.ts:192,208` — `parseJsonAs` over stored or captured text, or a
  frontend contract with no in-tree live-value parse call.
- The display `dataSchemas` chain re-checked after the header revert: `PresentationPartSchema`
  is the only member with a `z.json()` leaf, and its live value is the `show_user` tool-input
  product above.

## Group 4.2 outcome (task 4.2 done)

`bun --bun oxlint` reports 0 for `typescript/explicit-function-return-type` over the whole
tree; `bun run typecheck` passes. 75 sites took the written return type; 14 sites are
deliberate (below). The factory keeps the rule off in test files, so the test glob holds no
site.

### The written shapes

- Tool factories (`defineTool`) take `Tool<z.infer<typeof <Input>Schema>, <Output>` with the
  module's named input schema and output type — the house idiom of the report-session tools.
  Where the input schema rode inline in the `defineTool` call, it moved to a named module
  const first (same expression, same position): `ShowPlanInputSchema`, `ScanInputsInputSchema`,
  `WorkspaceSearchInputSchema`, `CapabilityDataInputSchema`, `KnowledgeCheckInputSchema`,
  `KnowledgeTemplateInputSchema`, `InspectDataProfileInputSchema`, `SearchGithubReposInputSchema`,
  `WebFetchInputSchema`, `WebSearchInputSchema`, `LinkPackagesInputSchema`,
  `ListAvailablePackagesInputSchema`, `SkillSearchInputSchema`/`SkillReadInputSchema`.
- Local arrows took the type their body returns: the character-class predicates `boolean`, the
  push/flush/grant/release/finish/settle/fail/onAbort family `void`, `emitPart`
  `void | Promise<void>` (the `EmitFn` return), the `write` of template
  `Promise<WriteOutcome>`, the `isAlive` of create-sandbox `Promise<SandboxLiveness>`,
  `registerSandbox` `Promise<void>`, the test-rig `drop`/`safeDrop` `Promise<void>`,
  `fetchOne` `Promise<FdaDoc | IchDoc>`, `pubmedSource` `PubmedSource`, `fetchHgncBy`/
  `lookupHgnc` `Promise<HgncDoc | null>` (plus a `UniprotDoc` alias beside the existing
  `HgncDoc`), `createRetry` `RetryFunction` (the `@ai-sdk/provider-utils` return type),
  `poolOptions` `pg.PoolConfig`, `chat()` `ResultAsync<ChatResponse, ProviderError>`,
  `dateField` `z.ZodOptional<z.ZodString>`, and `createExecuteAnalysisTool`
  `Tool<z.infer<typeof inputSchema>, { runId: string; status: "in_progress" }>`.
- Large structural literals took named domain types: `chartTheme` gained `ChartTheme` (the
  exact theme shape, so the design test keeps typed reads), `authoringTree` annotates with
  `ReturnType<typeof ChartTreeSchema.extend<{ binding: typeof AuthoringTableReferenceSchema }>>`
  (the exact zod schema type, with the per-call construction kept), `formatRun` fills the
  existing `FormattedRun` alias with its structural shape, and `routeTool` names
  `{ submit_route: Tool<unknown, never> }` over the AI SDK `Tool`.

### Deliberate-site calls made in the task-4.2 pass (inline directives)

The 14 JSX view components of `src/report-render/views/`, each at its inline directive line
(`references-view.tsx`: `Marker` :30, `RefKind` :41, `PathCode` :47, `Detail` :53, `HashCode` :59,
`ScriptLink` :87, `ChainLine` :111, `ReferenceBody` :166, `ArtifactEntry` :208, `CitationEntry`
:228, `ReferenceEntry` :248; `lineage.tsx`: `LineageGlyph` :74, `LineageControl` :157;
`prose.tsx`: `TextListView` :61). The written `JSXNode` — the
exact type the `jsxDEV` factory returns and the body produces — fails hono's JSX element
type check, which demands `(props: never) => FunctionComponentResult` where
`FunctionComponentResult` is `HtmlEscapedString | Child[] | Promise<...> | null`, a union
`JSXNode` does not join; `JSX.Element` (`HtmlEscapedString`) refuses the body in the other
direction. No writable type names what these functions return, so the inferred `JSXNode`
return stays, each with the inline directive and this reason.

### Pre-existing failure met by the report-model module run (not this group's edit)

`src/report-model/test/validate.test.ts` — the three `snapshotRows` pins of an own
prototype-named column (`:1727` and the two reference resolutions beside it) fail.
`snapshotRows` at `src/report-model/reference-resolver.ts:71` was rewritten in the task-3.1
pass to read `parseUnknownRecord`, whose rebuild drops a `__proto__` own key — the same class
the group-3 value-form notes record. The task-4.2 edit of this module touches only the
`authoringTree` return annotation, so the parse outcome is identical with and without it.
Open for the coordinator to route.

## Group 5.2 outcome (task 5.2 done)

`bun --bun oxlint` reports 0 over the whole tree for the eleven remaining tail rules — the
live run matched the 68 recorded sites of `harness/tmp/pi/709-g5-final.json` exactly before
the pass, and reports nothing after it. `bun run typecheck` passes, and the module tests of
the changed trees pass (3658 pass / 23 skip / 0 fail across 242 files). `bun run format:file`
ran on each changed `src/` file.

### Sites fixed, by rule

- `no-redundant-type-constituents` (10) and `no-duplicate-type-constituents` (3): the three
  key-set assertions (`providers/types.ts`, `contracts/schemas/usage.ts`, `loop/metrics.ts`)
  take the tuple form `[Exclude<A, B>, Exclude<B, A>] extends [never, never] ? true : never` —
  the same both-directions bite with no union (each `Exclude` already resolves to `never`, which
  is what the rule reported). `state/plans.ts` `unknown | null` → `unknown`; `lib/zod-issues.ts`
  and its test twin `unknown | undefined` → `unknown`; `memory/thread-store.ts`
  `ThreadType | string` → `string` (the runtime `isThreadType` guard owns the closed set, and
  the union already collapsed to `string` for every reader).
- `no-unnecessary-type-arguments` (10): the four `pool.query<Record<string, unknown>>` calls of
  `state/runs.ts` drop the argument (the `Querier.query` default is exactly that type); the two
  `z.ZodType<z.output<Schema>, unknown>` sites of `tools/define-tool.ts` drop `, unknown` (the
  zod default); `okVoid<DbError>()` → `okVoid()` at the three thread-history call sites (the
  `E = DbError` default); the enrich test drops `, never` from `okAsync` (neverthrow's default).
- `no-invalid-void-type` (8): the hooks-test `errAsync<void, …>` → `<never>` and
  `okAsync<void, …>` → `<undefined>`; working-memory pairs both arms on
  `Result<undefined, WorkingMemoryRejection>` / `ok<undefined, WorkingMemoryRejection>` so the
  ternary carries one type; `neverSettles<void>` → `<never>`; `whenLedgerAbsent<void>` →
  `<undefined>` (the `WorkflowPurger.cancel` chain still typechecks against
  `ResultAsync<void, DbError>`). `thread-history.ts` keeps `okVoid`'s declared void-carrier: the
  rule's site was the value-level `ok<void, E>(undefined)` call in the body, now
  `ok<undefined, E>(undefined)` (an undefined-carrier ≤ void-carrier), so the `writeTurn`
  reduce seed and the step chains keep one carrier type — an earlier flip of the declaration
  itself to `undefined` broke the pushes and made the reduce infer `any`
  (`no-unsafe-call`/`no-unsafe-return` fallout, reverted).
- `no-unnecessary-type-parameters` (7): `execute-analysis-scheduler` drops `S extends PlanStep`
  from all three signatures (`readonly S[]` → `readonly PlanStep[]`; `S` appeared only there).
  The three `query<R extends QueryResultRow>` wrappers (`state/db.ts:18`, `lib/db-result.ts:41`,
  the test double of `tools/test/execute-analysis.test.ts:1183`) are deliberate: `R` is caller-bound
  (`pool.query<{…}>(…)` names the row shape at each call site), each with an inline directive.
- `no-useless-default-assignment` (7): the destructured defaults the zod schemas already
  guarantee are gone (`search-clinical-trials.ts`, `search-geo-datasets.ts`, `search-faers.ts`).
- `no-unnecessary-boolean-literal-compare` (7): target-safety negates
  (`!(d.sources ?? […SOURCES]).includes("opentargets")`); edit-file binds
  `replace_all: replaceAll, regex: useRegex` in the destructure and drops the two dead
  comparisons; the tests use or negate the boolean directly (the catalog-tool guards read
  `if (result.available) throw`, the same predicate the old `!== false` spelled).
- `no-dynamic-delete` (5): `prompt-cache.ts:253` and `working-memory.ts:274` take
  `Reflect.deleteProperty` on the computed key — the in-place equivalent of the old `delete`, so
  the remaining keys keep their order (the planned destructure-rest rebuild would have moved the
  re-added key to the end of the stored record). The three `process.env` deletes in the test
  rigs (`otel.test.ts:75,84`, `require-reaper.test.ts:17`) are deliberate: the tests must mutate the
  live env of the process, and a Map stand-in would not reach the module under test.
- `only-throw-error` (5): all deliberate with directives. The three `throw await failStep(…)`
  sites of `sandbox-step.ts:731,909,916` (`failStep` always throws inside; the outer `throw` only ends the
  code path, and a wrapper would erase the scrubbed cause the parent reads), the synthesis
  rethrow of `execute-analysis.ts:1223` (the caught failure rides as-is so the workflow record fails
  with the original cause), and `providers/ai-sdk.ts:1132` `throw failure` — the structured
  `ProviderError` payload (a plain object by design, recognized structurally by
  `isProviderError`), not the abort rethrow the plan named; the abort rethrow throws `unknown`
  and reports nothing.
- `no-unnecessary-template-expression` (4): the two string-yielding ternaries unwrap from their
  `${}` (`tools/execute-analysis.ts`, `input-scan/menu.ts`), and the read-tool-output test
  merges the two literal interpolations into one string (`"ab😀cd😀ef"`).
- `use-unknown-in-catch-callback-variable` (2): `lib/chrome.ts` and
  `tools/sandbox/list-available-packages.ts` annotate the catch callback parameter `: unknown`.

### Fallout the pass created and fixed

- `tools/sandbox/list-available-packages.ts`: annotating `cause: unknown` made the fallback
  `String(cause)` report `no-base-to-string`; the leaf is now `textOf(cause)` — the group-2
  doctrine. A non-string cause rendered `[object Object]` there; `textOf` renders JSON. No test
  pinned the old render (the pool-unavailable pins hold).

### Deliberate-site calls made in the task-5.2 pass (11 inline directives)

- 5 × `only-throw-error` (the three `failStep` rethrows, the synthesis rethrow, the
  `ProviderError` payload throw — reasons above).
- 3 × `no-unnecessary-type-parameters` on the caller-bound `query<R>` wrappers.
- 3 × `no-dynamic-delete` on the `process.env` test rigs.

No other rule gained a report against the pre-pass baseline (`bun --bun oxlint --format json`
reports 0 over the whole tree).

## Group 6.1 audit (design D3 residual audit, 2026-10-26)

The audit read every inline `oxlint-disable` directive in `src/` and `scripts/`, every zone
block of `oxlint.config.ts`, and the `instanceofErrorAllowIn` list, and re-measured the zones
with a probe that removes the four `@inflexa-ai/*` zone blocks
(`harness/tmp/pi/709-audit.config.ts`, output `harness/tmp/pi/709-audit.json`).

### The inline directives (290 over `src` and `scripts`)

- Every directive is the `oxlint-disable-next-line <rule> -- <reason>` form, every one names its
  rule and carries a reason, no directive disables an `@inflexa-ai/*` rule inline, and no
  file-level or block-level disable exists.
- This change's deliberate sites: `no-base-to-string` 15 (the 14 JSX views + the
  console-logger test), `explicit-function-return-type` 14, `prefer-promise-reject-errors` 13,
  `only-throw-error` 5, `no-dynamic-delete` 3, `no-unnecessary-type-parameters` 3,
  `no-unnecessary-type-conversion` 1 — 54 in all, each recorded below in its group section with
  file and line.
- Pre-existing families this change did not touch: `eslint-js/no-restricted-syntax` 227 (the
  regex disallow sites, including `src/input-scan/shapes.ts:50`), `no-unnecessary-condition` 5,
  `typescript/no-implied-eval` 2, and the two-rule `no-control-regex, eslint-js/no-restricted-syntax`
  pair at `src/input-sanitization.ts:14,37` — each carries its reason; nothing is hidden.

### The zones and the option list

- `instanceofErrorAllowIn`: `src/lib/result.ts`, `src/lib/logger.ts`, `src/lib/thrown.ts` — each
  entry states its reason in the config comment.
- Zone blocks, one rule per block, one reason bullet per file:
  `@inflexa-ai/no-unknown-type-guards` (13 files), `@inflexa-ai/no-typeof-object` (9 files plus
  the separate `src/lib/thrown.ts` block), `@inflexa-ai/no-empty-schema` (7 files), and the
  pre-existing `no-console` exemption (`src/lib/console-logger.ts` and its test). The only other
  off entries in the config are the bun-types pair in the test globs, which acceptance
  condition 1 keeps.
- Probe result with the four zones removed: the three rules report 42 sites, all inside the
  zone'd files, and each zone'd file's sites match the live record exactly. No zone hides a
  fixable report of its rule, and no file outside the zones reports these rules.

### Corrections the audit made to this record

- Live-line refresh after the later groups' edits moved lines: group 2 JSX directive lines,
  `console-logger.test.ts` :144→:145; guards `result.ts` :125→:127, `errors.ts` :86→:89,
  `run-agent.ts` :1493→:1498, `result-serialization.ts` :60,67→:62,69, `snapshot-parse.ts`
  :63→:69; typeof `snapshot-parse.ts` :64→:70, `errors.ts` :88→:90; empty-schema
  `sandbox-error.ts` :155,156,157→:156,157,158, `generate-plan.ts` :706→:707; group 5
  `artifacts.ts` :157→:155-156, `prompt-cache.ts` :254→:253, `working-memory.ts` :275→:274,
  the `query<R>` wrappers now at `state/db.ts:18`, `lib/db-result.ts:41`,
  `tools/test/execute-analysis.test.ts:1183`.
- Records that named sites without lines now carry them: the 14 JSX return-type components
  (group 4.2), the 13 `prefer-promise-reject-errors` sites (group 5.1), the 11 task-5.2
  directives, and the `src/lib/thrown.ts` zone gate (:21,28).
- `stampablePin` left the `reference-stamp.ts` typeof record: its parameter is typed
  (`record: object`) since the task-3.1 pass, so the rule reports nothing there — the live
  probe shows the file holds exactly the two walk container checks (:89, :168).

## Correction round 1 (implementation review, 2026-10-26)

### Finding 1 — the thrown-object gates refused null-prototype causes (fixed)

`z.instanceof(Object)` rejects a thrown object with no prototype, so the cause-chain gate
of `findInCauseChain` (`src/providers/errors.ts`) and the `ThrownObject` gate of
`apiCallErrorOf`/`streamPartFailure` (`src/providers/ai-sdk.ts`) refused causes the old
`typeof` walks accepted — the status extraction and the suspend/retry rules that read
them lost real statuses. Both files took the hand object gate back, byte-equivalent to
the walks the diff records: `errors.ts` looped on truthiness plus
`typeof cursor !== "object"` (now stated as `cursor === null || typeof cursor !==
"object"`), and `ai-sdk.ts` used `error === null || typeof error !== "object"` at both
sites (arrays still accepted, exactly as before). The `z` import left both files.

- `src/providers/errors.ts` extends its `no-typeof-object` zone bullet to the
  cause-chain gate.
- `src/providers/ai-sdk.ts` joins the `no-typeof-object` zone with its own bullet and
  file entry.
- Pins: the null-prototype cause link in `src/providers/test/errors.test.ts`
  (`extractStatus` and `classifyProviderError`), the null-prototype retry-after wrapper
  and the null-prototype stream error part in `src/providers/test/ai-sdk.test.ts`.

`src/report-model/test/reference-stamp.test.ts:226` keeps its `z.instanceof(Object)`
gate: the payload there is a `JSON.parse` product (normal prototype, own `__proto__`
key), the test comment states that provenance, and the final
`Object.getPrototypeOf(stamped)` assertion pins the prototype the gate needs. No change.

### Finding 2 — textOf rendered a missing value as empty text (fixed)

`textOf` returned `""` for `null`/`undefined`, but the sites it replaced rendered
`String(null)`/`String(undefined)` — `defaultErrorFields` (`src/lib/logger.ts:98`)
emitted an empty `err` field for a thrown `null`. `textOf` now returns the `String`
render for `null`/`undefined`. `jsonTextOf` also treats the `undefined` that
`JSON.stringify` returns when a `toJSON` gives `undefined` like the throwing case: both
fall to the default object stringification, so a non-string always renders text.

Per-site decisions over every `textOf` caller (the old leaf of each site read from the
diff):

- Sites whose old leaf was a bare `String(x)` — the `errorMessageOf(x) ?? textOf(x)`
  diagnostic family, `logger.ts:98`, `run-agent.ts:1484`, `result.ts:82,84`,
  `dbos.ts:152`, `dbos-workflow-purger.ts:72`, `ai-sdk.ts:778`, `ad-hoc-router.ts:168`,
  `ai-sdk-message-storage.ts:325,328,363`, `pubmed.ts:240`, the ECharts reads
  (`chart.ts`, `chart-renderers.ts`, `chart-export.ts:89`, the `figures/` walkers), and
  `refresh-fixtures.ts:339` — keep their edit and read the exact pre-change render
  again with no code change: the new `String` render restores what they had.
- Sites whose old leaf was `String(x ?? "")` — display text where the missing-value
  render was `""` — take the default back inside the call: `pubmed.ts` `pmid`
  (`document.Id`), both `#text` reads of the abstract walk, the mesh `descriptor` read,
  `title`, `journal`, `year`, and `count-tokens.ts` `toolName` (both arms). Each is now
  `textOf(<value> ?? "")`, byte-identical to the pre-change output.

### Finding 3 — the stale `stampablePin` phrase left the config (fixed)

The `reference-stamp.ts` bullet of the `no-typeof-object` zone still named
`stampablePin`, whose parameter is typed since the task-3.1 pass, so the rule reports
nothing there. The bullet now names only the stamp walk; the live kept sites stay
`reference-stamp.ts:89` and `:168`.

### Finding 4 — pak_lock refused a non-finite number (fixed)

`z.json()` refuses Infinity, which `JSON.parse` yields for an over-large literal such as
`1e999`, so a lock whose embedded pak lock held one failed `lock_invalid` where the old
`z.unknown()` leaf accepted it. The leaf is now
`z.custom<unknown>((value) => value !== undefined)` — the exact `JSON.parse` output
population (`JSON.parse` never yields `undefined`), the same non-finite-tolerant shape
as the `JsonTableCell` leaf of `production-resolver.ts`. The `z.json()` sweep claim for
`farm.ts:59` above is corrected. Pin: `src/sandbox/test/farm.test.ts`.

### Stale group-1 locators refreshed

`number-format.ts:499` → `:501`; `data-profile.ts:662,859` → `:665,:865` (lines as of
this round).

### Gates after the corrections

`bun --bun oxlint` reports 0; `bun run typecheck` passes; the module tests of
`errors.ts`, `ai-sdk.ts`, `unknown-text.ts`, `logger.ts`, `run-agent.ts`, `farm.ts`,
`pubmed.ts`, `count-tokens.ts`, and the reference-stamp suite pass; `bun test src/providers
src/lib src/loop src/sandbox src/report-model` passes (1282 pass / 23 skip / 0 fail).
`bun run format:file` ran on each changed `src/` file.
