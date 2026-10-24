# Notes — adopt-assertion-safety

## Worklist: fresh per-rule counts per directory (live run, 2026-10-25, plugin 0.8.0, after the task 1.1 flip)

Total 3806 reports: `@inflexa-ai/require-assertion-safety` 2005,
`typescript/no-unsafe-type-assertion` 1608, `@inflexa-ai/no-double-cast` 193.
Format: `r` = require-assertion-safety, `u` = no-unsafe-type-assertion,
`d` = no-double-cast. A directory is `test` when it matches `/test/`,
`__tests__/`, or `*.test.ts(x)`.

| Directory                 | non-test r/u/d (sum) | test r/u/d (sum) |
| ------------------------- | -------------------- | ---------------- |
| scripts/                  | 2/0/0 (2)            | —                |
| src/agents                | 2/2/0 (4)            | 16/16/0 (32)     |
| src/app                   | 1/1/0 (2)            | 20/14/3 (37)     |
| src/auth                  | 1/0/0 (1)            | —                |
| src/citations             | 5/4/0 (9)            | —                |
| src/contracts             | 5/4/0 (9)            | 42/21/19 (82)    |
| src/execution             | 9/6/1 (16)           | 79/63/8 (150)    |
| src/input-scan            | 2/1/0 (3)            | 9/5/4 (18)       |
| src/lib                   | 24/15/1 (40)         | 17/12/5 (34)     |
| src/literature            | 20/20/0 (40)         | 10/5/5 (20)      |
| src/loop                  | 3/3/0 (6)            | 72/49/3 (124)    |
| src/memory                | 21/18/0 (39)         | 26/14/3 (43)     |
| src/prompts               | —                    | 9/4/1 (14)       |
| src/providers             | 26/15/0 (41)         | 22/20/0 (42)     |
| src/reference-data        | 1/1/0 (2)            | —                |
| src/report-model          | 16/13/1 (30)         | 15/12/2 (29)     |
| src/report-render         | 61/57/1 (119)        | 148/140/4 (292)  |
| src/report-render/figures | 34/31/0 (65)         | 459/455/0 (914)  |
| src/report-render/gallery | —                    | 63/63/0 (126)    |
| src/report-render/views   | 1/1/0 (2)            | —                |
| src/runtime               | 1/1/0 (2)            | 56/45/8 (109)    |
| src/sandbox               | 6/3/0 (9)            | 72/45/23 (140)   |
| src/state                 | 40/38/0 (78)         | 16/10/6 (32)     |
| src/tasks                 | 12/6/0 (18)          | 45/31/13 (89)    |
| src/tools                 | 80/45/4 (129)        | 330/243/52 (625) |
| src/workflows             | 2/0/0 (2)            | 93/49/23 (165)   |
| src/workspace             | 1/1/0 (2)            | 1/1/0 (2)        |
| src/**tests** (setup)     | —                    | 9/5/3 (17)       |

The pre-measured 0.8.0 reference (report-render non-test 186, report-model
non-test 30, whole-run 2005/1608/193) reproduced exactly; no count drift.

## Group 1 record (report-render and report-model non-test, after the task 1.2 fixes)

- `src/report-render` non-test: 0 reports from the three rules. The
  `chart-export.ts:79` double cast is gone: the render item crosses through a
  typed adapter (`rendererApi`), and `RenderedElement` carries the vendor
  return type beside the loose read surface.
- `src/report-model` non-test: 1 site stands —
  `reference-stamp.ts:143` `pin.record as unknown as Reference` (BLOCKER, see
  below).
- `bun run typecheck` passes; `bun test src/report-render src/report-model`
  passes (0 fail).

### BLOCKER for the coordinator: reference-stamp.ts:143

The refusal of an unstamped pin must carry the object the author wrote, but
its type is the parsed `Reference` union. The record at that point can never
satisfy the type: the stamp runs before the parse, and the hash that `Reference`
requires is the field the stamp has not filled yet. No container parse, no
narrowing predicate, and no single cast is lawful here (rule 2 rejects each),
and a double cast has no survivor under D2.3. The honest fix widens
`UnresolvedReferenceSchema.reference` (`src/contracts/report-reference.ts`, a
public refusal shape) to carry the pre-parse record — a contracts decision that
belongs to the group that owns `src/contracts` (task 3.1) or to the user.

## Group 2 record (state, memory, and execution non-test, after the task 2.1 fixes)

- `src/state`, `src/memory`, `src/execution` non-test: 0 reports from the
  three rules each (r/u/d 0/0/0 in every directory; 133 reports before).
- `bun run typecheck` passes. `bun test src/state src/memory
src/execution` gives 786 pass / 0 fail across 49 files. The first run had 6
  fail: the ENOENT and pg-unique reads went through `parseUnknownRecord`, and
  zod v4 `z.record` refuses an `Error` instance, so the refusal paths never
  fired. Corrected to field-shape zod object schemas (`ErrnoCodeSchema`,
  `PgErrorIdentitySchema`) and re-run green, per the re-run-once design rule.
- Row boundaries: `mapRunRow`, `mapStepExecutionRow`, and `mapArtifactRow`
  parse each row through the row schema that `src/state/schema.ts` already
  declares, keeping the module's existing handling: `parts` keeps its
  legacy-TEXT and malformed-to-null path; nullable columns keep null; the
  step-execution legacy defaults stay (attempts 1, `hitMaxSteps` from 1/true);
  `duration_ms` and `size` keep their bigint-string-to-number conversion. A
  required column that fails its schema now refuses the row through the
  existing `DbError` err channel (the parse throw inside `tryQuery`/
  `tryMutation`) where the casts silently produced garbage — the D3
  required-column rule, not a new throw at a tolerant boundary. The same
  refusal now covers an off-shape `sandbox_ref` (old: silent garbage).
- `ai-sdk-message-storage.ts` `providerOptionsFromLegacy`: `cache_control`
  passes `isJSONValue` (`@ai-sdk/provider`, a declared dependency). For a
  JSONB-sourced value the check always holds, so the behavior is unchanged.
- `jsonCopy` (conversation-display-recorder.ts) now uses `structuredClone`:
  the `JSON.parse(...) as T` could not survive rule 2, and an untyped
  `JSON.parse` return would have moved the site to the unsafe-return rule that
  another child owns. The payloads are JSON-safe; the one observable difference
  (a key whose value is `undefined` survives in memory, and drops at the
  store's `JSON.stringify` either way) changes nothing a reader sees.
- Write-side vocabulary: `conversationDisplayPart` takes `StoredSourcePart`
  (the stored arms) and builds each card with literal arms. A part outside the
  stored vocabulary is skipped at the two write sites (recorder `displayParts`,
  `conversationRecordTurn` filter) where the old cast produced a card the read
  path drops on reload anyway; every runtime path (durable filter, compaction
  divider, tool events, the approve-plan literals) only produces stored arms.
  `conversationUIToChatMessages` throws on a stored data part outside the
  vocabulary through the never-default switch arm — unreachable, because
  `parseStoredDisplayEnvelope` drops unknown keys before `validateUIMessages`.
  Both are the repo's compile-time exhaustiveness convention standing where a
  cast used to trust silently; flagged here for the D3 review.

## Count drift that other children of #607 own (group 2 additions)

- #709 (`no-typeof-object`): this group removed the `typeof x === "object"`
  probes its casts restated in count-tokens.ts (2) and runs.ts
  `isPartialUniqueViolation` (1). The non-test population went down by 3.
- #706: no `!` added. The `(dataSchemas as Record<string, z.ZodType>)[key]!`
  non-null assertion (conversation-display-storage.ts) disappeared with the
  cast it served; that is a side effect of the rule-2 fix, not a #706 cleanup.

## Count drift that other children of #607 own

- #709 (`no-typeof-object`): this group REMOVED the existing
  `typeof x === "object"` probes that its casts restated, in chart.ts,
  chart-renderers.ts, figures/common.ts, figures/dotplot.ts, chart-export.ts,
  and hybrid-svg.ts. The non-test population of that rule went down by the
  probes those walks held.
- #709 (`no-unknown-type-guards`): no new predicate over an `unknown` or `any`
  parameter. The one new predicate, `isEncodingKey` (chart.ts), narrows the
  known `string` to `keyof ChartEncoding` union; the reused `isUnknownArray`
  stays the ledgered guard it already was.
- #706 family: no `!` and no `@ts-expect-error` added; no unnecessary-assertion
  report was touched.

## Residual risk noted for review

- chart.ts `ENCODING_KEYS` mirrors the keys of `ChartEncodingSchema` as a
  `satisfies`-checked literal list. A key that a later change ADDS to the
  schema without adding it here stops being a declared member. A rename or a
  removal breaks the build. The schema lives in `src/contracts`, which this
  task group does not edit, so the list could not be derived from
  `ChartEncodingSchema.keyof()` here.

## Group 3 record (providers, literature, citations, contracts, lib non-test, after the task 3.1 fixes; task 3.1 still open)

- Before: 143 non-test reports in the six directories (r 82 / u 59 / d 2, including the 4
  reference-stamp.ts:143 carry-over reports). After: 11, all at three named sites (below).
  Per-directory after-counts: providers 0, literature 0, citations 0, report-model 0,
  contracts 2 (chat-frame.ts), lib 9 (async-utils.ts 3, zod-issue-shape.ts 6).
- `bun run typecheck` passes. `bun test src/lib src/citations src/literature src/contracts
src/providers src/report-model` gives 1023 pass / 0 fail across 67 files.
- The reference-stamp.ts:143 double cast is closed per the coordinator's decision:
  `UnresolvedReferenceSchema.reference` (`src/contracts/report-reference.ts`) is now a union of
  `ReferenceSchema` and the new `AuthoredPinRecordSchema` (`z.looseObject({ kind: <pinned kinds>, path:
z.string() })`) — the parsed reference in the validate/finish/resolver paths, the authored pre-parse
  record in the stamp path. The runtime payload does not change: the stamp walk still stamps and returns
  the author's original object; only the refusal's view of the pin is a shallow copy (`{ ...record, kind,
path }`), and the copy carries the same own enumerable fields, so the serialized refusal is unchanged.
  The type is exported from `report-reference.ts` but not added to the barrel.
- Task 1.2's remaining condition (report-model at 0 reports, module tests passing) is met, and its
  checkbox is marked.
- The three sites that still report, each with the reason the fix is not free:
    - `src/contracts/chat-frame.ts:84` (`{ ...part, source } as ChatPartFrame`, r+u) — the default arm of
      `toChatFrame` emits the frame UNCHECKED by contract ("checkChatPart checks it where it arrives"), and
      `ChatDataPart.data` is `unknown`, so no honest typing reaches `ChatPartFrame`. An early zod parse
      changes behavior (the cli SSE route delivers the frame and the browser flags it at receipt; the
      recorder throws at receipt); widening `ChatFrame` is a public-type change the cli consumes. Needs the
      coordinator's choice.
    - `checkChatPart`'s `unknown` parameter (task 3.1 wording) is held for the same decision: the
      forward-compat passthrough arm returns the frame for a type the registry does not know, and from an
      `unknown` input that value cannot honestly type as `ChatPartFrame` without widening `ChatPartCheck`
      (a public type the cli reads). Line 36 (`flattenDataPart`) is fixed with a contracts-local
      `z.record(z.string(), z.unknown())` parse (the module imports no value from outside `contracts/`, so
      the lib helper is not reachable there), and line 188 (`upsertPart(parts, part as ChatPart)`) keeps a
      `SAFETY:` comment — a rule-1-only site — for the D4 residual sweep.
    - `src/lib/async-utils.ts:34` (2 r + 1 u) — p-queue's `addAll<TaskResultsType>` collapses the task
      tuple onto one result type, so the element-wise mapped return cannot be produced cast-free; the
      comment on the statement states the position-preserving invariant. Same blocker family as the
      context.with case below.
    - `src/lib/zod-issue-shape.ts` (3 r + 3 u) — untouched; the planned fix is a rewrite of
      `fieldOf`/`elementOf`/`unwrap` over the high-level zod classes with `instanceof` narrowing (all the
      needed classes are exported: ZodObject, ZodUnion, ZodIntersection, ZodArray, ZodTuple, and the
      wrapper set), where the authored schema graph stays high-level all the way down. Not started when the
      tool budget closed.
- Also closed by a boundary fix: `src/lib/otel-spans.ts` `startActiveSpan`'s variadic rest now
  destructures by tuple length, and the `context.with` result rides a small `runWithSpan<T>` helper; the
  implementation signature returns `unknown` (the overloads keep `ReturnType<F>` for callers), because
  the otel `with` types lose the callback's return through the `unknown`-bounded `F`.

## Group 3 changes that touch files outside the task group's non-test scope

- `src/providers/ai-sdk.ts`: the three dep-default casts to `typeof fetch | undefined` (1225, 1231,
  1268, 1305) are gone by retyping `AiSdkProviderConfig.fetch` from `FetchLike` to `typeof fetch` —
  under bun-types `typeof fetch` is a callable with a REQUIRED `preconnect` member, so a bare `FetchLike`
  is not assignable to the SDK option and the cast was the only bridge. `wrapFetchWithRequestTimeout`
  now takes and returns `typeof fetch`, and the wrapper carries `preconnect` from the fetch it wraps.
    - This is a public type change to a barrel-exported config. The coordinator's message pre-decided the
      fix shape ("a typed option field, not a cast"), but the consumer check below found a consumer:
    - HARNESS TESTS (providers own files, minimally retyped, no rule-report work taken from group 7):
      `ai-sdk.request-timeout.test.ts`, `ai-sdk.openai-arm.test.ts`,
      `configured-provider.barrel.test.ts` build their fetch doubles with the repo's existing
      `fetchDouble` pattern (`Object.assign(run, { preconnect: fetch.preconnect })`, as the literature and
      citations tests already do).
    - CLI (NOT touched — outside this group's scope): `cli/src/modules/harness/runtime.ts`
      `buildAuthInjectingFetch` passes a bare `InjectingFetch` into `config.fetch`; the harness retype
      turns that into a cli typecheck error. The same `Object.assign(fn, { preconnect: fetch.preconnect })`
      one-liner there closes it. This is a required follow-up for the task 9.1 cli gate.

## Count drift that other children of #607 own (group 3 additions)

- #706: no `!` and no `@ts-expect-error` added anywhere in this group. The pre-existing
  `parseYear(dateParts[0])!` in `src/citations/clients/crossref.ts:45` and the `doi!` at :80 are
  untouched (#706 sites).
- #709 (`no-typeof-object`): group 3 added one `typeof x !== "object"` probe, inside
  `findInCauseChain` (`src/providers/errors.ts`) where the removed `MaybeErrorChain` cast used to elide
  the object check on each cause-chain link. The same file's other object checks are pre-existing
  probes. When #709 turns on, this probe reports; it replaces a cast, so the net is honest: errors.ts
  lost six `MaybeErrorChain` casts and its `isProviderError` now narrows through the `in` operator.
- #709 (`no-unknown-type-guards`): no new predicate over an `unknown` or `any` parameter. The new
  helpers return values, not type predicates: the `in`-narrowing reads in errors.ts, `stampablePin`
  (reference-stamp.ts, returns the authored record), and `runWithSpan` (otel-spans.ts). The pre-existing
  `isUnknownArray` and `isRecord` uses stay the ledgered guards they already were.

## Group 3 behavior notes for the D3 review

- PubMed walk (`parseEfetch`, `parseIdConvResponse`, `flattenTextContent`, `extractSection`): every cast
  is replaced by the module's existing `isRecord`/`childRecord`/`recordList` guards plus a `stringField`
  reader. Because `parseTagValue: false` (the parser's own comment) keeps every text node a string, the
  string-only reads are behavior-identical for parser output. `parseIdConvResponse` now parses with the
  `IdConvResponseSchema` the module already used at its request boundary — an off-shape record is
  skipped where the old cast trusted it. The unused `MedlineAuthor` and `MeshHeadingItem` type aliases
  are deleted with the casts they typed.
- errors.ts: `findRequestTimeout` returns the timeout VALUE (number) instead of the sentinel object and
  `findSdkTimeout` became `hasSdkTimeout` — both consumers only read existence or the bound, so no
  observable value changes; the realm-duplicate fallback keeps the name+field match, so a POJO sentinel
  still classifies as before.
- prompt-cache.ts: the two `NonNullable<M["providerOptions"]>` casts are replaced by `ProviderOptions`
  annotations on the merged bags, per the design's named restructure.
- citations/compare.ts: the `authors` casts are replaced by `Array.isArray` discriminant checks on the
  value itself. For a well-formed record the comparisons are unchanged; for an off-shape record (a
  non-array `authors` field, which the cast would have crashed on) the field now compares as a scalar
  string instead of throwing.
- zod-issues.ts `setAtPath`: an array container with a non-number path key now takes the object-spread
  arm (the old cast wrote the key through `as number`). A zod issue path into an array carries a number
  key, so the reachable behavior is unchanged.
- page-capture.ts: the browser-side sentinel read uses `Reflect.get(window, sentinel)` — the body runs
  as source text in the page, and the reflective read is the same key lookup the cast performed.

## #709 ledger (sites this change cannot fix without a rule #709 owns)

- `isChatPartRecord` (src/execution/run-event-parts.ts) — new predicate whose
  parameter is `Record<string, unknown>`. The check it carries is the
  registry-keyed discriminant with the payload trusted, per the module header:
  a part that fails its schema must still reach the consumer for its own
  check, so no zod parse can replace it without a behavior change. The rule
  flags predicates over `unknown`/`any` parameters; if it also flags
  record-typed parameters, this site is its ledger entry.

(the group 1 site reference-stamp.ts:143 is closed by the group 3 record above; the group 3 additions to
the ledger are in the "Count drift that other children of #607 own (group 3 additions)" section)

## Group 3 continuation record (task 3.1, second run, 2026-10-25)

- The two open chat-frame sites are closed: `checkChatPart` takes `unknown` and parses through the new
  module-local `ChatPartFrameSchema = z.looseObject({ type: z.templateLiteral(["data-", z.string()]),
source: EventSourceSchema.optional() })` — one parse that checks the source with the same
  `EventSourceSchema`, gates on the registry, and parses known parts with `ChatPartSchema` exactly as
  before. `toChatFrame`'s default arm returns the flattened part with no cast. `ChatPartFrame` admits the
  passthrough record beside the known part frames.
- DEVIATION FROM THE DECIDED SHAPE, disclosed: the passthrough arm's `type` is the template literal
  `` `data-${string}` `` (and the schema parses it with `z.templateLiteral`), not plain `string`. With a
  plain-`string` discriminant the record arm survives EVERY `frame.type === "<event>"` narrowing, and the
  loop-event readers of harness and cli failed to compile (measured: chat-frame.ts applyChatFrame /
  applyPartFrame, subagent-activity.ts, and the parity test all broke under the plain form). The parts
  contract is `data-`-prefixed (the registry keys, and `flattenDataPart`'s own return type), so the
  template is the truthful shape. Runtime registry gate unchanged: the check still passes through any
  type the registry does not know.
- Runtime deltas at the check boundary, each only for input the old `ChatPartFrame` parameter type
  forbade: a non-object, or a frame whose `type` is not a `data-` string, now returns `{ ok: false }`
  instead of a TypeError or an `ok: true` passthrough of the garbage value. For legitimate frames the
  check returns schema-built copies: the passthrough branch returns a shallow copy (the pinned test
  asserts with `toEqual`, so it passes unmodified in its runtime assertion), and the ok frame of a known
  type carries the schema-parsed source, so extra keys on a `source` object would drop — `toSource` is the
  only source builder in the repo and emits exactly the schema fields, so no reachable value changes. A
  malformed source now reports under the nested `source` path segment; the tests assert
  `toContain("callPath")` and still pass.
- chat-frame.test.ts: the `Frame = Parameters<typeof checkChatPart>[0]` alias became `unknown`, so the
  `as unknown as Frame` doubles no longer compile against the `toEqual` expected values. The literals now
  go to the `unknown` parameter directly (the task 7.1 shape), with `as const` on the five frame literals
  whose `type` property otherwise widened to `string`. The passthrough test's runtime assertion is
  unchanged.
- src/lib/async-utils.ts: `allWithConcurrency` narrowed to the homogeneous signature its three callers use
  (`ReadonlyArray<() => R | PromiseLike<R>>` returning `Promise<Awaited<R>[]>`); no caller changes; both
  casts at :34 are gone. The queue runs the tasks through `Promise.all(tasks.map((task) => queue.add(task)))`
  — `addAll` collapses its element type onto `R | PromiseLike<R>` and cannot produce the awaited element.
- src/lib/zod-issue-shape.ts: `fieldOf`/`elementOf`/`unwrap` rewritten over the high-level zod classes with
  `instanceof` (ZodObject, ZodUnion, ZodIntersection, ZodArray, ZodTuple, and the wrapper set through
  `.unwrap()`, `ZodPipe.in`); the walk set is the same nine wrapper kinds with the same 16-depth cap. The
  object branch reads the shape through a `z.core.$ZodShape`-typed local: `ZodObject`'s default `Shape` is
  `Record<string, any>`, and the direct index returned `any` (a new `no-unsafe-return` report, now gone).
- cli: the authorized one-liner is applied (runtime.ts `buildAuthInjectingFetch` returns
  `Object.assign(inject, { preconnect: fetch.preconnect })`; its return annotation was dropped, which the
  one-liner requires, or the preconnect would not reach `config.fetch`). The cli typecheck against the
  STALE harness dist passed vacuously; against the fresh build (`bun run build`) it fails at 8 sites in 2
  files — see the blocker.
- Verification so far: harness `bun run typecheck` passes; `bun test src/contracts src/lib src/report-model`
  gives 739 pass / 0 fail across 36 files; the three rules report nothing in non-test files of the five
  directories EXCEPT chat-frame.ts:194 (the blocker). `bun run format:file` not yet run (waiting on the
  blocker decision).

### OPEN BLOCKER for the coordinator: the passthrough record cannot enter the typed part lists

1. `src/contracts/chat-frame.ts:194` — `applyPartFrame`'s default arm inserts the part into the turn's
   `MessagePart[]` through `part as ChatPart`. With the widened frame union the rest type includes the
   passthrough record, so `typescript/no-unsafe-type-assertion` now flags the assertion (it was a
   rule-1-only site before). Rule 2 has no comment escape, and no cast-free bridge exists: the registry
   lookup and the array insert both need a narrowing the type system refuses for a record the vocabulary
   cannot name. The same wall stands behind any registry-indexed read of a passthrough type.
2. cli (fresh-dist typecheck): `src/modules/harness/dev/chat.ts` 242, 470, 491, 497 and
   `src/tui/hooks/conversation.ts` 499, 501 — after `checked.frame.type === "data-ask"` (and the
   `data-plan`/`data-presentation`/`data-file-reference` cases) the record arm survives the narrowing, so
   field reads turn `unknown`. These are outside the authorized one-liner.

Options on the table: (a) widen the message-part vocabulary (`ChatPart`/`MessagePart`) to admit the
passthrough record — completes the decision's own logic ("no cast-free producer exists for a value the
registry cannot name") but is a public-surface widening beyond the 2026-10-25 decision, with narrowing
fallout in the recorder and the cli part readers; (b) authorize the listed cli edits plus a harness-side
type for the record insert; (c) drop record frames at the messages path — a runtime change (today they
ride into the live view; storage already drops them) that violates the zero-runtime-change pin; (d) keep
the :194 report and accept a red gate. Task 3.1 is NOT marked done while the blocker stands.

## Group 3 continuation record (task 3.1, third run, 2026-10-25 — the maintainer's third ruling, Option A)

The ruling is applied: `ChatPart` (`src/contracts/chat-parts.ts`) is widened with the passthrough record
member, mirroring the frame level — `{ type: \`data-${string}\` } & Record<string, unknown>`, the template
discriminant and no `source`(a part carries no source; the frame strips it before a part enters a
message). The union admits what already rides in it at runtime. Byte-identical runtime; the stored
payload shape does not change; registered parts are untouched.`KnownChatPart`names the registered
subset (module export, re-exported from`contracts/index.ts`, not added to the package barrel).

- `ChatPartType` stays the registered keys — it is now `KnownChatPart["type"]`, the same type as before,
  so `PART_REGISTRY: Record<ChatPartType, PartDescriptor>` keeps its completeness check and every
  existing `ChatPartType` consumer is unchanged.
- `isKnownPartType(type: string)` joins `part-registry.ts` (a module export, not barrelled): the one
  registry-gate predicate, the same `Object.hasOwn` call the sites made inline. `checkChatPart` and
  `reconcileKey` use it where they used raw `Object.hasOwn` — same runtime, and the predicate is what
  makes `reconcileKey`'s `isReconciling(part.type)` compile under the widened union.
- `isKnownPartFrame` is retyped to claim `KnownChatPart & { source?: EventSource }` (was
  `ChatPart & { source? }`), so the known-frame narrowing stays exact: a frame the guard accepts and a
  `data-*` discriminant give the precise part type, for the harness and for the cli sites the earlier
  run fixed.
- `chat-frame.ts:194` is closed: the cast and its `SAFETY:` comment are gone; the source-stripped rest
  flows into `upsertPart` through the widened member. No cast, no `any`, no directive. The two pre-existing
  comments on the site stay.
- Harness fallout of the widening, fixed (3 sites): the registry key derivation above;
  `conversation-display-recorder.ts` `compactionDivider` now annotates the constructed part
  `CompactionPart` (the old `MessagePart & { type: "data-compaction" }` annotation admits the record arm,
  which `conversationDisplayPart` refuses); `displayParts` runs `isStoredSourcePart` BEFORE the pending-ask
  branch — behavior-identical, because `data-ask` is in the stored set, so the ask branch fires exactly
  when it did, and after the gate the `data-ask` narrowing is `AskPart` exactly.
- Gate results at the close of this run: `bun --bun oxlint` over src/contracts src/lib src/providers
  src/literature src/citations src/report-model src/state src/memory src/execution src/report-render —
  ZERO reports in non-test files, from the three #707 rules AND from every other rule (the three small
  regressions the previous run suspected — ai-sdk.ts no-unsafe-assignment, hybrid-svg.ts unused
  `isUnknownArray` import, dotplot.ts unused `Cell` import — are NOT present). `bun run typecheck` passes.
  `bun test src/contracts src/providers src/report-render src/lib` 1723 pass / 0 fail; `bun test
src/memory` 324 pass / 0 fail (the recorder changed). Fresh `bun run build` passes. `cd ../cli &&
bun run typecheck` FAILS — the blocker below. Task 3.1 is NOT marked done while the blocker stands.

### OPEN BLOCKER for the coordinator: the widening breaks the cli part readers outside the authorized files

The checkpoint (12 sites across the four authorized files) is NOT exceeded: `conversation.ts` breaks at
3 sites, and `chat_printer.ts`, `dev/chat.ts`, `runs.ts` at none. The authorized file is FIXED (see
below). But the widening also breaks the PART reader layer, which the decision did not measure — 18
error lines in 4 files the ruling does not name. Full inventory, file:line and reason:

- `cli/src/tui/layout/message_block.tsx:229` — `case "data-plan"`: the record arm survives the case;
  `readPlanCard(part)` refuses it.
- `cli/src/tui/layout/message_block.tsx:233` — `case "data-run-card"`: `part.runId`/`part.title`/
  `part.stepCount` read `unknown`; the `RunCardBlock` props and `resolveRunCardState(part.runId)` refuse.
- `cli/src/tui/layout/message_block.tsx:239` — `case "data-presentation"`: `readPresentation(unwrap(part))`
  refuses the record arm.
- `cli/src/tui/layout/message_block.tsx:247` — `case "data-file-reference"`: `readFileReference(part)`
  refuses the record arm.
- `cli/src/tui/layout/message_block.tsx:251` — `case "data-ask"`: `<AskCard part={part}/>` needs
  `LiveAskPart`; the record arm is not one.
- `cli/src/tui/layout/message_block.tsx:254` — `case "data-child-session-started"`: `part.threadId`
  reads `unknown`; `ReportSessionEntry` needs a string.
- `cli/src/tui/layout/message_block.tsx:261-264` — `case "data-compaction"`: `status`/`tokensBefore`/
  `durationMs` read `unknown` against the `CompactionBlock` prop types.
- `cli/src/tui/layout/message_block.tsx:290` — the default arm's exhaustive `never` check: `Part` now
  holds the record member, so the leftover is not `never`.
- `cli/src/tui/components/chat.tsx:47` — `part.threadId` reads `unknown` after the
  `data-child-session-started` narrowing; `Set<string>.add` refuses it.
- `cli/src/tui/hooks/activity_panel.ts:266` — `onActivity(frame.value)` gets
  `StepActivityPart | record`; the handler needs `StepActivityPart`.
- `cli/src/tui/hooks/conversation.test.ts:1833` — `readPresentation(card)` with
  `card: PresentationPart | record`.
- `cli/src/tui/hooks/conversation.test.ts:1849` — `readFileReference(card)` with
  `card: FileReferencePart | record`.

Each needs the same guard-first discriminant treatment the authorized file got. The narrowing device
exists and is cli-side: every known part is assignable to the record member through its implicit index
signature, so a `type`-discriminant check BEFORE the registry guard keeps the whole known union — the
guard must run FIRST, then the discriminant narrows `KnownChatPart` to the exact part. `conversation.ts`
now carries the working shape (below); the coordinator can decide between promoting it to a shared cli
helper (or a harness part-level guard export, a second barrel export the ruling did not authorize) and
per-file copies.

### The authorized cli fix (conversation.ts, 3 sites)

`cli/src/tui/hooks/conversation.ts` gains a local predicate
`isKnownPart(part: Part): part is KnownChatPart` (`Object.hasOwn(PART_REGISTRY, ...)`; `PART_REGISTRY`
is already exported, `KnownChatPart` now re-exported from `contracts/index.ts`), and:
`openableEntries` guards before its switch (a non-registered type takes the `[]` arm it already took);
`latestPlanCard` narrows `isKnownPart(part) && part.type === "data-plan"` before `readPlanCard`. Cli
consumers narrow for the passthrough; no cast, no `any`, no directive. Runtime is unchanged on every
reachable path (a part with a registered type always passed the registry gate at receipt).

### Found while verifying the changed cli file: a red cli test this run did not cause

`bun test src/tui/hooks/conversation.test.ts` gives 126 pass / 1 fail:
"an absent finished detail never blanks the one the start showed" (line 392) — the started
`detail: "output/summary.md"` is lost across a `tool-finished` that carries no detail. This run did not
cause it: the harness dist preserves the detail (probe: `applyChatFrame` with the started part then a
finish without one keeps `detail`), and no edit of this run touches the tool-started/tool-finished path
(the runtime deltas are the registry-gate predicate, the :194 cast removal, and the recorder reorder —
each proven same-result). The failure comes from the branch's uncommitted state (previous runs), which
the previous run never measured against the cli test suite. The coordinator owns the routing.

## The CI-only lint reports of PR #725 — mechanism and fix (coordinator, 2026-10-25)

Parent-supplied CI evidence: the `lint (harness)` job of PR #725 (run 40062487000) fails with
4 reports that no local run reproduced:

- src/agents/test/conversation-agent.test.ts:187:29 no-unsafe-assignment, 189:28 no-unsafe-member-access
- src/tools/test/registry.test.ts:40:25 no-unsafe-assignment, 42:24 no-unsafe-member-access
  (all: "Unsafe ... of an error typed value" on the `def.inputSchema` / `emitted.type` chain)

Mechanism, reproduced and isolated on the exact PR #725 tree (a21cdf48) in a scratch checkout:

1. `@ai-sdk/provider@4.0.18` declares `import { JSONSchema7 } from 'json-schema'` in its `dist/index.d.ts`.
2. `json-schema@0.4.0` ships no types and declares none; the ambient types live in `@types/json-schema`.
3. The harness lockfile does not pin `@types/json-schema`. It entered node_modules only as a transitive
   of the ESLint toolchain that #609 removed; directories installed before that change still hold it
   physically, so local oxlint runs resolve `JSONSchema7` and stay green.
4. CI installs fresh from the lockfile (`bun install --frozen-lockfile`), gets no `@types/json-schema`,
   and the oxlint type server (tsgolint) types the module as an error type. The error propagates through
   `ToolSet` into `registry.definitions()`, so `def.inputSchema` / `emitted.type` read as error-typed —
   the 4 reports. Fresh-install reproduction confirmed: identical tree, symlinked stale node_modules =
   green; fresh frozen install = exactly the 4 CI reports.
5. `bun run typecheck` stays green in CI because `tsconfig.json` sets `skipLibCheck: true`, which makes
   an unresolved import inside a `.d.ts` degrade silently instead of erroring.

The 4 sites are innocent: with the ambient types present, the unchanged code lints clean (verified on the
PR #725 tree AND on this branch's tree). The fix is one devDependency pin, not a test edit:

```diff
--- a/harness/package.json
+++ b/harness/package.json
@@ -110,6 +110,7 @@
         "@types/bun": "latest",
+        "@types/json-schema": "^7.0.15",
         "@types/node": "^24.13.3",
```

plus the matching `bun.lock` entries that `bun install` records (`"@types/json-schema": "^7.0.15"` in
devDependencies and the `"@types/json-schema": ["@types/json-schema@7.0.15", "", {}, "sha512-5+fP8P8MFNC+AyZCDxrB2pkZFPGzqQWUzpSeuuVLvm8VMcorNYavBqoFcxK8bQz4Qsbn4oUEEem4wDLfcysGHA=="]`
resolution line). End-to-end validation on the PR #725 tree: fresh `rm -rf node_modules && bun install
--frozen-lockfile` with the pin, then `bun --bun oxlint` — exit 0, zero reports. This branch carries the
same pin (package.json + bun.lock), so its CI cannot hit the family. The parent mirrors the hunk onto the
#725 branch.

## Group 3 completion record (task 3.1, fourth run, 2026-10-25 — the two maintainer rulings applied; task 3.1 marked done)

RULING 1 (the cli part readers): the local `isKnownPart` predicate of `cli/src/tui/hooks/conversation.ts`
became ONE shared cli helper — `isKnownPart(part: { type: string }): part is KnownChatPart` over
`Object.hasOwn(PART_REGISTRY, part.type)` — exported from `cli/src/modules/harness/chat_printer.ts`, the
module whose header already gives the rule (a part reader with more than one surface lives there). No
second harness barrel export, no per-file copies, no cast, no `any`, no directive. Every site takes the
guard-first shape: `isKnownPart(part)` FIRST, then the `type` discriminant narrows `KnownChatPart` to the
exact part. The authorized 13-line set is exactly what was edited; the cli typecheck after the fix reports
zero errors, so nothing past the set appeared. Files changed, cli:

- `src/modules/harness/chat_printer.ts` — the shared `isKnownPart` predicate; its doc comment states the
  guard-before-discriminant order (every known part is also assignable to the passthrough record, so only
  the guard lets a following `part.type === "<literal>"` check narrow past it).
- `src/tui/hooks/conversation.ts` — the local predicate deleted; `openableEntries` and `latestPlanCard`
  use the shared one; the now-unused `PART_REGISTRY`/`KnownChatPart` imports dropped.
- `src/tui/layout/message_block.tsx` (the 10 reported lines) — the render switch split guard-first: the
  parts the registry does not hold (the core `text`/`tool-call` parts, the `thinking`/`file-edit` mocks)
  and an unknown record render in a pre-switch on `!isKnownPart(part)`, where a record renders the
  mention; the main switch then runs over `KnownChatPart` only and its default's exhaustive `never` check
  compiles again. The default arm's old `(unknownPart as { type: string }).type` cast is gone: TS rejects
  a property read off `never`, so the arm renders `mention(String(unknownPart))` — unreachable at run
  time, only the `never` assignment does work.
- `src/tui/components/chat.tsx:47` — `isKnownPart(part) &&` before the `data-child-session-started`
  discriminant; `part.threadId` is a string again for `Set<string>.add`.
- `src/tui/hooks/activity_panel.ts:266` — `isKnownPart(frame.value) &&` before the `data-step-activity`
  discriminant; `onActivity` receives `StepActivityPart`.
- `src/tui/hooks/conversation.test.ts:1833,1849` — `card !== undefined && isKnownPart(card) &&
card.type === ...` before `readPresentation`/`readFileReference`.

RULING 2 (the #705 regression): `applyPartFrame`'s tool-finished arm
(`harness/src/contracts/chat-frame.ts`) builds the finished part in a named variable typed `ToolCallPart`
and adds `detail`/`durationMs` inside an `if` each — the #705 D3 if-form — so the keys stay ABSENT when
the finish carries none and the `{ ...p, ...finished }` merge no longer overwrites the started call's
`detail`/`durationMs` with an explicit `undefined`. `outcome` is required on the event and stays a direct
field. Recorded as a #705 regression: the conditional-spread sweep of commit a21cdf48 missed the if-form
case at this site. The exact final code shape, verbatim:

```ts
        case "tool-finished": {
            const finished: ToolCallPart = {
                type: "tool-call",
                toolCallId: frame.toolUseId,
                toolName: frame.name,
                outcome: frame.outcome,
            };
            if (frame.detail !== undefined) finished.detail = frame.detail;
            if (frame.durationMs !== undefined) finished.durationMs = frame.durationMs;
            let started = false;
            const next = parts.map((p) => {
                if (p.type !== "tool-call" || p.toolCallId !== frame.toolUseId) return p;
                started = true;
                return { ...p, ...finished };
            });
            // The stored transcript keeps a call whose start never arrived, thus a live view keeps it too.
            return started ? next : [...parts, finished];
        }
```

Harness files changed this run: `src/contracts/chat-frame.ts` (the regression fix only), plus the
one-import cleanup below. No harness behavior change beyond the restored key-absence: every harness
chat-frame test asserts with `toEqual`, which reads a `detail: undefined` key and an absent key as equal,
so the pinned tests pass unmodified.

### Gates at the close (all pass)

- (a) `bun --bun oxlint` over src/contracts src/lib src/providers src/literature src/citations
  src/report-model src/state src/memory src/execution src/report-render: 0 reports in NON-test files,
  from the three #707 rules and from every other rule. The 1701 remaining reports are ALL in test files
  (require-assertion-safety 867, no-unsafe-type-assertion 797, no-double-cast 37) — the populations of
  groups 6-8.
- (b) harness `bun run typecheck` passes.
- (c) `bun test src/contracts src/providers src/report-render src/lib` — 1723 pass / 0 fail across 88
  files. After the one-import cleanup below, `bun test src/providers` re-ran: 0 fail.
- (d) fresh harness `bun run build` passes.
- (e) `cd ../cli && bun run typecheck` — 0 errors (was 13 error lines in 4 files).
- (f) `bun test src/tui/hooks/conversation.test.ts` — 127 pass / 0 fail (was 126 pass / 1 fail; the red
  test "an absent finished detail never blanks the one the start showed" passes against the fresh dist).
- The tests of the other changed cli files (`message_block.test.ts`, `message_block.render.test.tsx`,
  `activity_panel.render.test.tsx`, `app_activity_panel.render.test.tsx`,
  `chat_report_entry.render.test.tsx`): 85 pass / 0 fail.
- ESLint over the changed cli files: 0 findings. `bun run format:file` ran on every changed file in both
  subsystems (all unchanged).

### One out-of-gate cleanup, disclosed

`src/providers/test/configured-provider.barrel.test.ts` — a test file the second run of this group
already edited (the fetch retype) — still carried an unused `FetchLike` type import, the only report
under the ten directories from a rule outside the three (eslint no-unused-vars, test file). The one
import line is removed; the file's tests pass (26 pass / 0 fail). The remaining test-file reports belong
to groups 6-8.

## Group 4 record (task 4.1, first run, 2026-10-25 — PARTIAL, the tool budget closed mid-group)

- Non-test reports in the group's directories: 182 before (r 119 / u 59 / d 4), 81 after
  (r 56 / u 21 / d 4). The exact surviving site list is
  `openspec/changes/adopt-assertion-safety/g4-residual-worklist.txt` (file + rule per line),
  and it is the worklist for the next run. `bun --bun oxlint` over the group's directories
  reports NOTHING from any other rule in non-test files, `bun run typecheck` passes, and
  `bun test` over every changed file's module gives 1656 pass / 0 fail (1290 + 366; the one
  red sandbox run was re-run once after the sandbox-error fix and passed, per the design rule).
- Task 4.1 is NOT marked done: 101 of the 182 reports are fixed, 81 remain, and the D4
  residual sweep cannot close while reports remain. The remaining files, by report count:
  refresh-regulatory-corpus.ts 9, impc-client.ts 6, identifier-resolver.ts 6,
  ad-hoc-router.ts 6, data-profile-absorb.ts 6, generate-plan.ts 5, fixture-runner.ts 5,
  search-github-repos.ts 4, protein-family-modality.ts 4, situation.ts 4, and the rest at
  one or two (full list in the worklist file).
- Fixed in this run, by shape:
    - `src/tools/approval/queries.ts`: the row boundary got the mapRunRow treatment — three
      zod row schemas (`AskResolutionRowSchema`, `PendingAskRowSchema`, `GrantedRowSchema`)
      parse inside the existing `tryQuery`/`tryMutation`, so a malformed required column
      refuses through the `DbError` channel (the D3 required-column rule); absence still
      reads `null` in `selectAskResolution`.
    - `src/tools/lib/api-utils.ts`: `apiFetch` lost its `<T>` phantom — it returns
      `ResultAsync<unknown, ApiError>` and the body reader is a `(res) => res.text()` /
      `(res) => res.json()` function typed to `Promise<unknown>`, so the two `as T` casts at
      the read are gone. `apiFetchText` states the string shape with a `typeof` guard (a
      `res.text()` body is always a string, so the guard never refuses). `pathway-client.ts`
      (the only explicit `apiFetch<string>` caller) calls `apiFetchText`. 143 non-test files
      already use `apiFetchValidated` or the `unknown` default.
    - `src/tools/define-tool.ts`: the two `isToolError` casts, the `Partial<ToolResultImage>`
      destructure, and the two symbol-key walks now narrow with `in` (the existing probes
      stay); `z.toJSONSchema` is read through a `Record<string, unknown>` annotation (the zod
      v4 `JSONSchema` type carries the string index signature), and `foldCallRecord` assigns
      directly (the `Tool` method syntax is bivariant, so the cast was never necessary).
    - knowledge: `ProcedureStepSchema` declares `package` and `forbids` (both rode the loose
      remainder before), so the three environment/skeleton casts delete; `template.ts:329`
      and `client.ts` `lookup` casts delete (the types already agree); `local-slots.ts` parses
      the caller value with a module-local `LocalSlotValueSchema` after `validateLocalSlot`,
      and the `default` cast deletes by tightening `SlotValueSchema` to the service contract
      the module's own comment states (scalar or string list — a template whose default is
      `null` or a scalar list now refuses at the contract parse, through the existing
      `invalid_response` err).
    - errno reads: `errnoOf` is exported from `src/lib/fs-result.ts` (the existing
      object-probe reader) and replaces the four `as NodeJS.ErrnoException` /
      `as { code?: string }` casts (filesystem.ts, examine-page.ts, derive-table.ts,
      list-available-refs.ts).
    - containers: `parseUnknownRecord`/`isUnknownArray` replace the casts and their restated
      probes in `decision-record.ts` (JSON.parse records), `workspace-search.ts`
      `fileTargetOf`, `list-available-refs.ts` `readLegacyEntries` + legacy-entry walk,
      `call-guard.ts` `sortKeys`, `sandbox-step-translate.ts` `sandboxTreeDelta` (plus a
      field-shape `SandboxTreeDeltaSchema` for the tree itself), `authoring-tools.ts`
      `fieldOf`, `generate-plan.ts` is NOT yet touched.
    - `impc-client.ts` and `bgee-client.ts` are NOT yet done — note for the next run: the
      schema exists in each module (`ImpcSolrResponseSchema`, `BgeeExpressionResponseSchema`)
      but a whole-envelope re-parse would refuse a doc whose `p_value` drifted, and the
      fixture tests pin per-row tolerance ("drops a phenotype row whose p_value drifted to a
      string" keeps the row with a null score) — the fix must walk the container with
      `parseUnknownRecord` and guard the drifted fields, not re-parse with the strict schema.
    - `sandbox-error.ts` `sandboxStatusOf`: a field-shape `z.looseObject` cause schema (the
      group-2 lesson: `z.record` refuses an `Error` instance, and the dockerode/k8s test
      doubles attach `statusCode`/`code` onto `Error`).
    - others: `reaper.ts` (the `WorkflowStatus` cast deletes — `WorkflowStatus | null` is
      assignable to `{ status: string } | null`), `sandbox-catalog.ts` (the tuple is built
      from a destructured head, no cast), `agents/sandbox/__fixtures__/deps.ts`
      `makeFakePool` returns a real unconnected `new Pool()` (the fixtures never reach a
      query), `enrich.ts` (the decoder's stdout lines parse through `ReadoutLineSchema`),
      `readout.ts` (the `as unknown` on `JSON.parse` deletes), `synthesize-run.ts`
      (`PlanNarrativeSchema` with `.catch(null)` keeps the absent/malformed → "" handling),
      `runtime/result-serialization.ts` (`JsonSchema`, a `z.lazy` recursive schema, replaces
      the `JSON.parse` cast), `reference-data/catalog.ts` (`deepFreeze` returns `T`; the
      const's `ReferenceDataCatalog` annotation carries the readonly claim, which a concrete
      mutable type satisfies directly).
    - `src/auth/local-auth-context.ts` keeps its cast with a `SAFETY:` comment (the phantom
      brand is a rule-1-only site) — the one SAFETY-comment survivor this run added.

### BLOCKERS for the coordinator (each site left reporting; see the worklist file)

1. `src/tools/knowledge/situation.ts:207` — `toSituation`'s `as unknown as
KnowledgeSituation` (r+r+d+u). The cast papers over a real drift:
   `SituationFieldsSchema.question` holds six values the barrel-exported
   `KnowledgeSituation.question` refuses, and `extra_analyses`/`enrichment_input` have no
   client-type member at all (a rest-spread restructure fails the typecheck on
   `question`). Widening the public `KnowledgeSituation` is a barrel-export change that
   needs the maintainer.
2. `src/sandbox/package-identity.ts:80` — the `brand` mint (`name as
PackageIdentity["name"]`, r+u). The brand has no runtime value, so TypeScript has no
   cast-free way to mint it, and rule 2 has no comment escape for a narrowing. The choices
   are a public retype of the branded name or a sanctioned escape.
3. `src/loop/__fixtures__/scripted-provider.ts:27` — the unmodeled finish-reason
   ride-through (`finishReason as ChatResponse["finishReason"]`, r+u). The fixture
   deliberately drives a finish the provider types do not model, and mapping it to
   `"other"` would change the recorded finish reason on that path.

### #709 drift this run added to the ledger of other children

- This run REMOVED the `typeof x === "object"` probes its casts restated in
  `decision-record.ts` (2), `list-available-refs.ts` `readLegacyEntries` (2 + the item
  probe), `call-guard.ts` `sortKeys` (1), `workspace-search.ts` `fileTargetOf` (1). The
  non-test population of `no-typeof-object` goes down by about 7. No new probe was added.
- No `!` and no `@ts-expect-error` was added. `errnoOf` keeps the pre-existing probe it
  already carried; nothing new reports under #709's rules.

## Group 4 record (task 4.1, second run, 2026-10-25 — PARTIAL, the tool budget closed mid-group; task 4.1 still open)

- The two maintainer rulings of 2026-10-25 are applied, each with zero runtime change:
    - Fork A: `KnowledgeSituation` is DERIVED. `client.ts` declares `export type KnowledgeSituation = z.infer<typeof
SituationFieldsSchema>` and sees the schema through `import type { SituationFieldsSchema } from "./situation.js"`
      (type-only both ways, so no runtime cycle). `toSituation` is now a rest-spread that strips `preferred_language`
      and returns `KnowledgeSituation` with no cast; the old loop dropped undefined-valued optional keys before the
      JSON body was built, and `JSON.stringify` drops them at serialization, so the wire bytes are unchanged (the pin
      at knowledge-tools.test.ts:130 — `Object.keys(situation)` without `preferred_language` — passes unmodified). The
      r+r+d+u cast at `situation.ts:207` is gone. The module-role aliases (`BlockingRole`, `CovariateRole`,
      `PredictorRole`) stay exported and now unused.
    - Fork B: `ChatResponse.finishReason` (providers/types.ts) is `FinishReason | "aborted" | (string & {})`, and the
      scripted-provider fixture maps an unmodeled finish word with no cast.
    - DEVIATION DISCLOSED (Fork B ripple, type-only): `AgentFinish.reason` (src/loop/run-agent.ts) also carries
      `(string & {})`. The pinned loop test ("settles a call that rides an unknown finish", run-agent.test.ts:1414,
      `expect(String(finish.reason)).toBe("unknown")`) shows the loop's settlement keeps the raw word, and the
      loop's terminal return and `logFinish` type `reason` as `AgentFinish["reason"]` — without the widened arm the
      ruling's own pinned behavior no longer compiles. This IS the ruling's "default arm settles what arrives", at
      the type level; every consumer narrows with `===` (chat-turn.ts, cli turn.ts) and is unchanged.
- Fixed this run: 43 of the 75 standing non-test reports, by shape:
    - Container walks with per-row tolerance (the impc/bgee binding): `impc-client.ts` and `bgee-client.ts` reach
      `.response.docs` / `.data.calls` through `parseUnknownRecord` + `isUnknownArray` and read each field with a
      module-local `readString` / typeof guards — no whole-envelope re-parse, so the fixture-pinned tolerance holds
      (a row whose `p_value` drifted keeps its place with a null score). Delta at the refuse path only: a doc entry
      that is not a record is now skipped where the old cast would have crashed on a primitive; disclosed for the D3
      review. The stale `ImpcSolrDoc`/`ImpcSolrResponse`/`BgeeCall` aliases are deleted with the casts.
    - Derived data instead of a cast: `protein-family-modality.ts` annotates the bundled JSON import
      (`const dataset: FamilyMappingFile = familyMappingData`) — the JSON module type already satisfies the declared
      shape, so both hand types and the double cast stay as the annotation.
    - `refresh-regulatory-corpus.ts` (9): the embeddings response parses through a field-shape zod schema (a
      malformed payload still ends in the throw, now with the zod message — operator-run script); the `center`
      narrowing casts became `as const`; `fetchOne` narrows the stub union with the stub's own `center` field (each
      source's listing carries only its own stub kind, per the comment); `metadata` rides without the cast.
    - The data-profile-absorb trio (role/category, 6 reports) closed with a resolver-input widening, type-level only:
      `data-profile-schemas.ts` exports `GroupAnnotationInput` / `ProfileDimensionInput` / `MenuOperationInput` /
      `ProfileSubmissionInput` — the submission as `resolveProfileSubmission` reads it, with `role`/`category` as the
      opaque strings the resolver always treated them as. The agent-facing schemas stay strict; a replay carries a
      persisted id a retired vocabulary served (the module doc pins the pass-through: re-adjudication is authoring).
      `dimensionScope` (contracts, barrelled) takes `DimensionCategory | (string & {})` — same mechanism the ruling
      used for finishReason; its `?? "technical"` arm already settled unknown ids at runtime. Zero runtime change.
    - Deletions where the compiler already had the type: `identifier-resolver.ts` (6) — `fetchHgncBy` returns the
      schema-validated doc, so the six `(hgncDoc as {...})` reads drop; `gene-disease-evidence.ts:272` — the input
      schema enum is exactly `ClinicalSignificance`, so the option passes with no cast (and no undefined lie); the
      two comptox membership probes take `ReadonlySet<string>` views of the const tuples; drug-gene-interactions
      annotates `selected: Source[]`.
    - Annotations where a value is built: `target-safety.ts` builds `byOrgan: Record<string, number>` directly;
      `tools/execute-analysis.ts` derives `timeoutByStepId` with a flatMap whose callback names the tuple type; the
      DBOS child handle in `workflows/execute-analysis.ts` needs no cast (the SDK's first overload returns
      `WorkflowHandle<SandboxStepResult>` from the callable's type); `sandbox-step.ts` passes a typed
      `noManifest` empty array.
- Verification at the close of this run: `bun run typecheck` passes. `bun --bun oxlint` over the group's
  directories + src/providers: 32 non-test reports remain from the three rules (exact list below), and ZERO
  reports in non-test files from any other rule. `bun run format:file` ran on every changed file. Module tests:
  `bun test src/tools/knowledge src/providers src/contracts src/schemas` 548 pass / 0 fail; `bun test src/loop
src/tasks` 451 pass / 0 fail; `bun test ./src/tools/lib/test ./src/tools/bio` 558 pass / 0 fail;
  `bun test src/workflows` 187 pass / 2 fail (below — re-run once, both red).
- Remaining worklist (32 reports, 13 files) for the next run:
  scripts/refresh-fixtures.ts:169,269; src/sandbox/package-identity.ts:80 (r+u — the ruled brand mint: give it its
  `SAFETY:` comment above the statement and put it on the D4 list); src/tasks/data-profile.ts:809;
  src/tasks/derive-table-exec.ts:119; src/tasks/extract-values.ts:247; src/tools/ad-hoc-router.ts:223 (r+r+d+u,
  BLOCKER below) and :308 (r+u — `parseUnknownRecord(raw) ?? {}` replaces the typeof probe + cast);
  src/tools/lib/**fixtures**/fixture-runner.ts:63 (r+r+d+u) and :68 (r — fixes designed: make `assertOutput` a
  method so the erased row assignability is bivariant and `fixtureCase` returns directly, and drop the
  `as unknown` on `JSON.parse` by declaring `readFixture`'s return `unknown`, the readout.ts:315 precedent);
  src/tools/lib/amass-client.ts:122; src/tools/lib/clinical-benchmarks-client.ts:37;
  src/tools/lib/gwas-catalog-client.ts:121,124; src/tools/research/generate-plan.ts:549,557,559,561;
  src/tools/research/search-github-repos.ts:54,61,62; src/tools/research/web-fetch.ts:291.
- Then the D4 sweep: not started. SAFETY-comment survivors enumerated so far:
  `src/auth/local-auth-context.ts:22` (first run) and, once its comment lands,
  `src/sandbox/package-identity.ts:80` (the ruled brand mint — rule 2 does not flag `string -> string & brand`).

### BLOCKER for the coordinator: the ad-hoc router's JSON Schema bridge cannot close cast-free without a wire change

`src/tools/ad-hoc-router.ts:223` feeds `jsonSchema(z.toJSONSchema(routeSchema) as unknown as Parameters<typeof
jsonSchema>[0])` to the ai SDK's `tool()`. zod v4's `toJSONSchema` return type is structurally incompatible with
the `@types/json-schema` `JSONSchema7` the SDK parameter declares (verified with tsc: `$defs` entry types clash
because zod's unified `JSONSchema` allows `exclusiveMaximum: boolean`). No comment, annotation, or single cast
bridges it. The cast-free alternatives both change the wire payload:

- Pass `routeSchema` (or the SDK's `zodSchema(routeSchema)`) to `tool()` directly — the SDK then converts with
  `target: "draft-7"`, `io: "input"`, and `addAdditionalPropertiesToJsonSchema` (objects get
  `additionalProperties: false`), while today's explicit `z.toJSONSchema(routeSchema)` emits the draft-2020-12,
  output-io schema the provider sees today.
- A hand conversion into `JSONSchema7` is a rewrite of the schema walker for one router tool.
  Options: authorize the SDK-path wire change for this one ad-hoc routing tool, or name another shape.

### Red workflows tests this run did not cause

`bun test src/workflows` — 2 fail (both runs, so not flake): "persist-final-status counts the run once…" and
"…records no outcome metric when the status write changes no row" (execute-analysis.test.ts:2403, :2435). The
failure is `runs.queryActiveRun`'s row parse (the group-2 zod row schema in `src/state/runs.ts`, modified on this
branch) refusing the test's fake row for lack of `workflowName`/`startedAt` — `execute-analysis.test.ts` is
UNMODIFIED on the branch, and this run's only edit to `workflows/execute-analysis.ts` is the DBOS handle cast at
:1508, off the failure path. The stale fake needs the two columns; that edit belongs to the test-file groups
(7/8) or the follow-up. Recorded per the D3 note: the refusal is the sanctioned required-column behavior meeting
a fake written before it.

## Group 4 completion record (task 4.1, third run, 2026-10-25 — the remaining 32 reports, the ruled brand mint, the D4 sweep; task 4.1 marked done)

- All 32 standing non-test reports (13 files) are closed. By site:
    - `src/tools/ad-hoc-router.ts:223` (r+r+d+u) — the coordinator's ruled bridge applied: `const schema: Record<string, unknown> = z.toJSONSchema(routeSchema);` above, and `inputSchema: jsonSchema(schema)` — the exact `define-tool.ts:299` plus `registry.ts:35` shape. The wire payload is unchanged (the same explicit `z.toJSONSchema(routeSchema)` emission reaches the provider). tsc accepts the form; no cast, so the STOP clause never fired.
    - `src/tools/ad-hoc-router.ts:308` (r+u) — `parseUnknownRecord(raw) ?? {}` replaced the typeof probe + cast. Delta for the D3 review, off-container values only: a tool-call input that is an ARRAY now takes the `{}` fallback, where the old probe treated the array as a record and read `undefined` off every named field — each named-field read is identical either way; only the container admission changed.
    - `src/tools/lib/__fixtures__/fixture-runner.ts:63` (r+r+d+u) — `assertOutput` became a method (`assertOutput?(output: z.infer<S>): void`), so the erased-row assignability is bivariant and `fixtureCase` returns `testCase` directly. The double cast is gone.
    - `src/tools/lib/__fixtures__/fixture-runner.ts:68` (r) — the `as unknown` on `JSON.parse` dropped; `readFixture` declares `: unknown` (the `readout.ts:315` precedent).
    - `scripts/refresh-fixtures.ts:169` and `:269` (r) — the two `as unknown` on `JSON.parse` dropped: one assigns to a `let raw: unknown`, one returns from a `: unknown` function.
    - `src/tasks/data-profile.ts:809` (r) — the cast dropped; the destructured locals carry an annotation. Why a bare destructure does not compile: `accepted` is assigned only inside the submit-tool closure, so the control-flow analysis keeps the initializer's `null` past the guard, and the post-guard type is `never` — `resolution` was `never` and `resolution.dimensions`/`.probes` failed to compile (measured, TS2339 on `never`). The annotation re-arms the reads against the real `ProfileResolution`; removing it breaks `tsc`, so the compiler carries the fact.
    - `src/tasks/derive-table-exec.ts:119` and `src/tasks/extract-values.ts:247` (r) — the DBOS handle casts dropped; the SDK's first `startWorkflow` overload returns `WorkflowHandle<Return>` from the callable's type (the second run's `workflows/execute-analysis.ts` shape). The now-unused `WorkflowHandle` imports dropped; the `oss-core-managed-ok` marker stays on the statement.
    - `src/tools/lib/amass-client.ts:122` (r) — `const items: readonly string[] = value;` replaces `as readonly string[]`. The bare deletion does not lint clean: `Array.isArray` narrows the union member to an intersection whose element is `any`, and `url.searchParams.append(key, item)` reports `no-unsafe-argument` (measured); the annotation restores the declared element type.
    - `src/tools/lib/clinical-benchmarks-client.ts:37` (r) — `const dataset: BenchmarksFile = benchmarksData;` (the protein-family-modality annotation device; the JSON module type satisfies the declared shape). No test file imports this module; typecheck is the guard.
    - `src/tools/lib/gwas-catalog-client.ts:121,124` (r) — both deletions: `orPerCopyNum ?? betaNum ?? null` is already `number | null` (the schema fields are `.nullable().optional()`), and `[...new Set(genes)]` over `const genes: string[]` is already `string[]`.
    - `src/tools/research/generate-plan.ts:549,557,559,561` (4r+1u) — `restoreSkeletonGrounding` walks with `parseUnknownRecord` + `isUnknownArray`: the decoded envelope, each step, and each grounding become records or the step returns as written. Delta for the D3 review, off-container values only: a grounding that is an ARRAY now leaves the step untouched, where the old cast let the array through and degenerately repaired it (spread into an object with the source's values). Envelope and step handling are behavior-identical.
    - `src/tools/research/search-github-repos.ts:54,61,62` (3r+1u) — `parseGithubReposResponse` walks with `parseUnknownRecord` + `isUnknownArray`; the per-item `html_url`/`full_name` string guards and the drop-not-fail item filter are unchanged. The envelope schema at the fetch boundary is untouched, so a drifted item failing the whole page remains the pre-existing fetch-boundary behavior, not this fix.
    - `src/tools/research/web-fetch.ts:291` (r) — `const notFound: NodeJS.ErrnoException = new Error(...)`; every member of `ErrnoException` past `Error` is optional, so the assertion was an upcast and the annotation replaces it.
- The stale fake rows: `ledgerRow` in `src/workflows/test/execute-analysis.test.ts` now carries `workflow_name: "executeAnalysis"` and `started_at` — the fake pool answers every `SELECT` with it, and `runs.queryActiveRun`'s group-2 row parse requires both columns. The parser is correct; the fake predates it. `bun test src/workflows/test/execute-analysis.test.ts` — 85 pass / 0 fail (was 2 fail).
- The ruled brand mint: the `SAFETY:` comment stands above `return name as PackageIdentity["name"]` (`src/sandbox/package-identity.ts:80`), invariant wording kept. FINDING, correcting this file's second-run record: the parenthetical "rule 2 does not flag `string -> string & brand`" is wrong on this tree — `typescript/no-unsafe-type-assertion` DOES flag the mint ("type 'string & { readonly [identityBrand]: true; }' is more narrow than the original type"), and no comment silences it. The gate therefore holds exactly ONE non-test report from the three rules: this site, rule 2 only. A cast-free mint does not exist (the brand is a phantom `unique symbol` intersection; `satisfies` and an annotation cannot produce it, and the double cast is banned outright). The lawful closes remain the maintainer's: a public retype of the branded name, or a rule-2 escape the plugin would have to grant. Task 4.1 is marked done on the coordinator's standing ruling (the SAFETY comment plus the D4 listing), with this exception disclosed here and in the handoff.
- D4 residual sweep over non-test `src/` and `scripts/` (excluding `as const`), enumerated with the TypeScript AST (AsExpression nodes), not a text scan:
    - `src/auth/local-auth-context.ts:23` — `({}) as AuthContext` — SAFETY above the statement: the auth brand is an optional phantom with no runtime member, so the empty literal carries every real field the interface holds; no caller may mint one outside this constructor. Rule-1-only (rule 2 passes: the assertion widens). The second-run record named `:22`; `:22` is the comment line, the statement is `:23`.
    - `src/sandbox/package-identity.ts:80` — `(name) as PackageIdentity["name"]` — SAFETY above the statement: the brand is a compile-time marker with no runtime value, thus a cast is the only way to mint one, and this function is the only site that casts. The one rule-2 report of the gate (above).
    - `scripts/`: zero surviving `as` assertions.
- Count drift other children own (this run): #709 (`no-typeof-object`) non-test population DOWN by 4 — the probes this run's container walks replaced in `ad-hoc-router.ts` (1), `generate-plan.ts` (2), `search-github-repos.ts` (1). The pre-existing unknown-parameter predicate `(i): i is Record<string, unknown>` of `search-github-repos.ts` is gone with the rewrite. No `!`, no `@ts-expect-error`, no lint directive added; no new predicate, no new probe.
- Gates at the close:
    - `bun --bun oxlint` over src/tools src/tasks src/sandbox src/loop src/agents src/input-scan src/workspace src/workflows src/runtime src/reference-data src/app src/auth src/providers src/state scripts — the ONLY non-test report is `src/sandbox/package-identity.ts:80` rule 2 (the ruled brand mint, above); zero reports in non-test files from any other rule. The remaining reports are all in test files (the groups 5-8 populations).
    - `bun run typecheck` passes.
    - `bun test src/workflows src/tools src/tasks src/loop src/agents src/input-scan src/workspace src/runtime src/reference-data src/app src/auth` — 2779 pass / 0 fail across 176 files, green on the first run.
    - `bun run format:file` ran on every changed `src/` file (all unchanged).

## The brand ruling (maintainer, 2026-10-25) — applied; the last non-test report is closed

The maintainer ruled the brand away: `PackageIdentity["name"]`
(`src/sandbox/package-identity.ts`) is a plain `string`; the `identityBrand`
unique symbol and the `brand` mint (the site that held the change's one
non-test report) are gone; zero runtime change. The reasoning: the brand's
nominality was advisory — it evaporated at the first `as`, and its only mint
(`brand`) was itself a cast, so the type carried no guarantee a caller could
not shed. The comment that replaces the brand doc names the surviving
invariant: the module's constructors (`pythonIdentity`, `rIdentity`,
`identityOf`) validate and fold every name, and that funnel is the guard.
The test that pinned the brand's compile-time rejection (`a literal is not an
identity`, with its `@ts-expect-error`) is deleted with the property it
asserted — a directive may not remain unused, and its claim is false under
the ruling.

Gates at the close of the ruling: `bun --bun oxlint` reports ZERO reports
from the three rules in non-test files anywhere (the whole non-test
population is closed); `bun run typecheck` passes; `bun test src/sandbox
src/tools/sandbox` gives 325 pass / 0 fail.

## Group 5 record (task 5.1, first run, 2026-10-25 — PARTIAL: the structural

Querier is in and 8 of the 162 live double-cast sites are closed; the tool
budget closed the run before the fetch family and the remaining families)

- The structural `Querier` is applied (`src/state/db.ts`): `interface Querier`
  with one generic `query<R extends QueryResultRow = Record<string, unknown>>`
  over `string | QueryConfig` plus optional `values`, returning
  `{ rows: R[]; rowCount: number | null }` — the row-generic mirrors the
  existing structural precedent of `BackfillClient`
  (`src/memory/message-backfill.ts`), so the state modules' explicit
  `query<{ ... }>(...)` type arguments keep compiling. A real `Pool` and
  `PoolClient` stay assignable (the whole-tree typecheck proves it), and a
  fake that answers `query` alone satisfies the type directly. The generic is
  the one structural definition; nothing was widened with `connect`/`end`.
- `counting-querier.ts` is rebuilt on it: the wrapper is `const querier:
Querier` and forwards with a rest spread; no cast. The two shared setup
  reads are typed: `postgres.ts` and `dbos.ts` read `pool.options` directly
  (`pg.Pool` exposes `options: PoolOptions` publicly; both casts read it
  needlessly).
- Two production parameter sets moved from `pg.Pool` to the db.ts structural
  type, because the module reads only `query` and the gate cannot close
  otherwise; DISCLOSED against the "db.ts only" binding, with the reason:
  `sandbox/reaper.ts` (`ReaperDeps.pool`, `RegisterReaperDeps.pool` — both
  flow only to `reconcileReapedSandbox`, a `Querier` consumer) and
  `runtime/dbos.ts` `sweepEphemeralWorkflows` (one `pool.query`). The STOP
  clause never fired for them — they need LESS of `Pool` than the structural
  type gives, not more.
- Fakes rebuilt on the structural type, no casts: `artifacts.chunk.test.ts`
  `capturingQuerier` (normalizes both call forms into its capture list),
  `artifacts.page.test.ts` and `runs.test.ts` rejecting fakes, `reaper.test.ts`
  `fakePool`, `dbos.test.ts` sweep fake. `rowCount`-only fake returns gained
  `rows: []` (the structural result carries both; the consumers read
  `rowCount` only).
- MEASURED for the next run — the `fetch`-fake family (41 of the 162 sites,
  exact list in `g5-remaining-worklist.txt`): the working shape is the repo's
  `fetchDouble` pattern, `Object.assign(fn, { preconnect: fetch.preconnect })`,
  which makes the fake assignable to `typeof fetch` with no cast. CAVEAT
  measured at typecheck: it compiles ONLY when the fake's parameters are at
  least the real `fetch`'s (`input: string | URL | Request, init?:
RequestInit`). Fakes that narrow `input` to `string` or `init` to a
  required/narrowed type (11 of the 41: api-utils 215, otel-spans 184,
  http.test 17+31, opentargets, pubchem, pubmed, context7,
  search-authorities 16+42, searxng 27) fail TS2345 and need the parameter
  widened plus a small body adjustment (for example otel-spans reads
  `init.headers` and must read through `new Headers(init?.headers)` and
  assert with `.get()`). A scratch run of the mechanical rewrite was REVERTED
  to the pre-run state (verified byte-identical to HEAD with `git diff`) when
  this caveat surfaced; the files are exactly as this run found them.
- STOP sites this run (each left reporting, with the reason the structural
  type cannot close it):
    1. `memory/test/message-backfill.test.ts:41` — `asClient` hands the fake to
       `BackfillClient`, which is generic over the CALLER'S row type
       (`query<R extends QueryResultRow>(...) => Promise<{ rows: R[] }>`). A
       fake that routes by SQL text cannot produce the caller's `R`: measured
       TS2322 with the fake non-generic (`{ rows: unknown[] }`) and with a
       generic method (the concrete rows are not `R[]`). Retyping
       `BackfillClient` to non-generic rows pushes `unknown` into the row reads
       and trips the unsafe-argument family another child owns. Needs the
       coordinator: a builder the module owns, or a sanctioned shape.
    2. `memory/test/thread-history.test.ts:1729` and
       `memory/test/thread-store.test.ts:523` — `createThreadHistory` /
       `createThreadStore` take `pool: Pool` and run `withTransaction`
       (`pool.connect`), so their parameter must stay `Pool`; the counting
       wrapper supplies `query` alone. Widening the structural `Querier` with
       `connect` is forbidden by the binding. Recorded as the binding's STOP
       case: these modules need more of `Pool`'s surface than the structural
       type gives.
- Gates at the close of this run: `bun run typecheck` passes; `bun --bun
oxlint` reports `no-double-cast` 162 (was 170; the 8 closed are the sites
  above) and STILL zero reports from the three rules in non-test files;
  `bun test src/state src/sandbox src/runtime/test/dbos.test.ts
src/memory/test/thread-history.test.ts src/memory/test/message-backfill.test.ts`
  gives 642 pass / 0 fail across 41 files; `bun run format:file` ran on the
  changed `src/` files (all unchanged). Task 5.1 stays open: the gate (zero
  `no-double-cast` anywhere) does not pass with 162 sites standing. The exact
  remaining site list is `g5-remaining-worklist.txt` (fresh, this run).
- Process note for the review: a scratch rewrite script mis-located the cast
  paren on two attempts; each time the touched files were restored to the
  exact pre-run bytes (proved by an empty `git diff` against HEAD) before the
  next attempt. No file outside this run's edit set was ever modified.

## Group 5 record (task 5.1, second run, 2026-10-25 — PARTIAL: 62 of the 162 standing sites closed; the tool budget closed the run with 100 open)

- All three coordinator decisions for the STOP sites are applied, each with zero runtime change:
    1. thread-history/thread-store (decision 1): `withTransaction` (`src/lib/db-result.ts`) now takes a
       structural `Connectable` pool (`connect(): Promise<TransactionQuerier & { release(): void }>`) and
       hands its callback a structural `TransactionQuerier` (one generic `query`, the db.ts `Querier`
       shape). `rollbackQuietly` takes the same client type. `createThreadHistory`/`createThreadStore`
       each carry their own module-local deps type — `type ThreadHistoryPool = Querier & Connectable` /
       `type ThreadStorePool = Querier & Connectable` — beside the module that owns it, not in db.ts. A
       real `Pool` stays assignable; the fakes build cast-free as `{ ...counted.querier, connect: () =>
pool.connect() }`. The transaction-body helpers that took `PoolClient` (`lockThread`, `nextSeq`,
       `insertGroup`, `touchThread`, `openTurnRecord`, `closeTurnRecord`, `lockPlanLaunch`,
       `discriminateMiss`, `deleteRows`) now take `TransactionQuerier`.
    2. message-backfill (decision 2): the generic builder compiles — `function fakeBackfillClient<Row
extends LegacyRow>(legacyRows: Row[]): BackfillClient<Row> & { legacyRows; updates; queries }`.
       `BackfillClient` (`src/memory/message-backfill.ts`) is now generic over the ROW TYPE instead of the
       method — `type BackfillClient<Row extends QueryResultRow = QueryResultRow> = { query(text,
values?): Promise<{ rows: Row[] }> }` — because a method-level generic cannot return the caller's
       `R[]` from concrete rows (the first run's TS2322). The module's `query<LegacyRow>`/`query<{...}>`
       type arguments dropped (type-argument erasure is a no-op at runtime); the LIMIT-1 read rides the
       client's `LegacyRow` (it reads only `thread_id`/`seq`). The migration caller
       (`20260927120000_baseline.ts`) passes its kysely bridge unchanged — typecheck accepted it. The
       fake's `query` reads `legacyRows` through the returned object (the idempotency test reassigns
       `fake.legacyRows` mid-test), and the never-mutated `remainingRows` field is deleted with the LIMIT-1
       arm's constant `{ rows: [] }`.
    3. The fetch family (decision 3, 41 sites across 28 files): each fake is now
       `fetchDouble(async (input, init) => ...)` with the file-local helper from
       `sources.test.ts` (`Object.assign(run, { preconnect: fetch.preconnect })`); narrowed parameter
       annotations dropped (contextual from the helper), and `new URL(url)` reads became
       `new URL(String(url))` where a fake now holds the full `string | URL | Request`. `otel-spans.test.ts`
       reads the captured headers through `new Headers(init?.headers)` and asserts `.get("traceparent")`.
- The maintainer's structural pattern extended to the remaining `Pool` fakes, module by module (all
  internal, zero runtime change): deps types and factory parameters that read only `query` now take the
  db.ts `Querier` (state/vector-store, state/init via `Pick<Pool, "connect" | "options">` for the kysely
  dialect, state/tool-outputs, state/report-session-state, memory/card-builders, memory/working-memory
  via `Querier & Connectable`, tasks/data-profile, tools/ad-hoc-router, tools/start-report-session,
  tools/execute-analysis and app/approve-plan via `Querier & Connectable`, app/chat-turn,
  app/spawn-report-session, app/synthesize-run, runtime/connection-budget, runtime/boot via
  `Querier & Pick<Pool, "connect" | "end" | "options">` (boot closes the pool and `initCortexState`
  builds the kysely dialect over the real connect), workflows/execute-analysis and
  workflows/sandbox-step, sandbox/create-sandbox, execution/artifact-registration,
  execution/post-step-pipeline, agents/sandbox/shared, workspace/search-config, tools/workspace
  show-plan/workspace-search, tools/research inspect-run/inspect-data-profile, and
  `ensureSearchIndex`/`loadPlanNarrative`/`readTurnContext`/`profileOrientation` internal params).
  Two pools deliberately stay `pg.Pool` because they reach the DBOS SDK boundary
  (`dbosClientFor` → `DBOSClient.create({ systemDatabasePool })`): execution/run-canceler and
  execution/dbos-workflow-purger — their test fakes are the next run's work (the working shape is
  `Object.assign(new Pool(), { query, options, on })`, the group-4 `makeFakePool` precedent).
- Fixed alongside: tasks/test/data-profile-resolve's `submission` builder gained a `Record<string,
unknown>` overload so the three negative schema tests pass their off-vocabulary group literals with
  no cast; the data-profile SandboxClient fakes spread `makeFakeSandboxClient()` (the complete
  harness-owned builder) and override `createSandbox` only; the `{ dimensions: 3, embed: () =>
okAsync([]) }` embedder literals satisfy `EmbeddingProvider` directly.
- Gates at the close of this run: `bun run typecheck` passes. `bun --bun oxlint` reports
  `no-double-cast` 100 (was 162 this run; 62 closed: the fetch family 41, the three STOP decisions 5,
  the app/tasks/state/lib test fakes 16). Zero reports from the three rules in non-test files still.
  `bun test src/memory` green (324 pass after the builder fix); the remaining changed-file suites were
  still running when the budget closed. Task 5.1 stays open.
- The exact remaining site list is `g5-remaining-worklist.txt` MINUS the closed files: everything
  still standing is in `sandbox/test/create-sandbox.test.ts` (12),
  `workflows/test/sandbox-step.test.ts` (9), `workflows/test/execute-analysis.test.ts` (8),
  `tools/research/test/misc-tools.test.ts` (5), `sandbox/test/docker-client.test.ts` (5),
  `runtime/test/assemble.test.ts` (5), `workflows/__tests__/dbos/test/suspension-cascade.test.ts` (4),
  `tools/workspace/test/workspace-display.test.ts` (4), `tools/test/execute-analysis.test.ts` (3),
  `sandbox/test/k8s-client.test.ts` (3), `loop/test/tool-detail.test.ts` (3),
  `input-scan/test/enrich.test.ts` (3), `execution/test/artifact-registration.test.ts` (3), and the
  one-and-two site files (contracts chat-frame/report-reference, state report-versions and
  report-session-state, runtime boot/connection-budget/assemble, execution run-canceler,
  post-step-pipeline, dbos-workflow-purger, tools start-report-session/ad-hoc-router, prompts
  briefing, lib hooks/otel/otel-spans-freed/chrome/page-capture, report-render singletons,
  report-model draft/validate, input-scan scan).
- Measured shapes for the next run (each proven on this tree, not guessed):
    - Pool fakes whose module now takes `Querier`/`Querier & Connectable`: annotate the const with the
      structural type, drop the cast, let the contextual types carry `query`'s parameters — the
      chat-turn/approve-plan fakes in this run are the worked examples (a forwarding fake is
      `query: (textOrConfig, values) => pool.query(textOrConfig, values)`).
    - DBOS static patches (`(dbos.DBOS as unknown as { registerWorkflow: unknown }).registerWorkflow = fn`
      at assemble.test 550/563/654/672, `(dbos.DBOS as unknown as Record<string, unknown>)[name] = fn`
      at sandbox-step 174 / execute-analysis 236, and `dbos.DBOS.runStep as unknown as ...` at
      sandbox-step 559): `Reflect.set(dbos.DBOS, "registerWorkflow", fn)` writes the same key with no
      assertion — untried but measured against the rule set (no `as`, no directive).
    - SandboxClient/ChatProvider/EmbeddingProvider: `makeFakeSandboxClient()` exists;
      `scriptedProvider` exists for ChatProvider; `{ dimensions, embed }` satisfies EmbeddingProvider
      directly. The suspension-cascade/execute-analysis `{}` casts become the builders.
    - Third-party wide types still cast (`Docker`, `BatchV1Api`/`CoreV1Api`, `Browser`,
      `ReturnType<typeof create*Ops>`): either a module-local structural deps type (the Decision-1
      pattern one level further out) or a complete builder — docker-client's own method patches
      (`docker as unknown as { getContainer ... }`) close with the same `Reflect.set` device.
    - Singles with known shapes: `tool-detail.test` `undefined as unknown as string` → the hook returns
      `undefined` typed against the hook's declared return (annotate the callback's return type);
      `hooks.test.ts:36` ResultAsync stub → build via `ResultAsync`'s constructor with the settled value
      typed; `report-reference.test:12/179` → the serialize helper takes the widened
      `UnresolvedReferenceSchema.reference` union from group 3 (no cast needed once the helper's
      parameter is that union); `chat-frame.test:107` → `ChatStreamEvent` union member built directly
      (the `done` event needs its message field — check `ChatStreamEvent`'s shape); `chat-frame.test:429`
      → `applyChatFrame`'s part parameter is `unknown`-adjacent after the group-3 widening (re-check at
      edit time); `report-versions.test:259` / `scan.test.ts:9` / `mutate-surface-invariants.test:24` →
      complete builders or the exported guard; `otel.test.ts:85` → `span` to `ReadableSpan` needs the
      exporter's span interface (annotate the captured export list with it); the report-render and
      report-model singles → group 6's accessor family may absorb them.
- Process note: a perl paren-capture bug truncated four signatures in
  `tasks/test/data-profile.trigger.test.ts` mid-run; repaired in the same run and proven by the green
  typecheck. The scratch transform script lives at `tmp/pi/g5-fetch-double.ts`.
- Test batches at the close (both green, first run): `bun test src/memory src/tasks/test/data-profile-resolve.test.ts src/tasks/test/data-profile-settle-notice.test.ts src/state src/app src/contracts src/lib` — 1243 pass / 0 fail across 72 files; `bun test src/tools/bio src/tools/lib src/tools/research src/literature src/tools/test src/tools/workspace src/runtime src/execution src/workflows src/sandbox src/input-scan src/loop src/prompts` — 2358 pass / 0 fail across 164 files. Not yet run against this run's edits: `bun run format:file` on the changed files (task 9.1's gate), and the report-render/report-model suites (their four single-site test files are untouched by this run).

## Group 5 record (task 5.1, fourth run, 2026-10-25 — PARTIAL: 19 of the 66 standing sites closed; the wall-clock budget closed the run with 47 open)

- Closed this run, by file and shape:
    - `runtime/test/assemble.test.ts` — the four DBOS registry patches (550, 563, 654, 672) use the run-2
      measured device: `Reflect.set(dbos.DBOS, "registerWorkflow", fn)` writes the same key with no
      assertion, no directive, and the save/restore bracket is unchanged.
    - `workflows/__tests__/dbos/test/suspension-cascade.test.ts` (4) — the `{} as unknown as ChatProvider`
      and `{} as unknown as EmbeddingProvider` pairs became builders. A new harness-owned complete default
      builder for `ChatProvider` now lives in the module that owns the interface:
      `src/providers/__fixtures__/chat-provider.ts` exports `unusedChatProvider()` (the shape the workflows
      tests already carried inline); the embedding is the established `{ dimensions, embed }` literal that
      satisfies `EmbeddingProvider` directly.
    - `tools/test/ad-hoc-router.test.ts:52` — `emptyPool` annotates `Querier` (the module takes `Querier`).
    - `tools/test/start-report-session.test.ts` (2) — `watchedPool` forwards: `query` is annotated
      `Querier["query"]` and returns `forward(textOrConfig, values)`; the watched object annotates
      `Querier & Connectable` and forwards `connect` to the real pool.
    - `tools/test/execute-analysis.test.ts:1147` — `interceptingPool` returns `Querier & Connectable`; the
      guard wraps `Querier["query"]` and forwards through a generic `run<R extends QueryResultRow>` so the
      row type flows (the forwarding rule below); `release()` calls the client directly, and the two
      `as (...args: unknown[])` casts of the old body are gone.
    - `workflows/test/execute-analysis.test.ts:398` — the deps pool is built directly:
      `{ query, connect }` from the fake, and the no-pool case is a throwing `query`/`connect` pair (the old
      `{} as Pool` would have crashed with a TypeError at the same call; the message names the case).
    - `state/test/report-session-state.test.ts` (2) — the store takes `Querier`, so the pooled clients pass
      directly: `createReportSessionStateStore({ pool: first })`.
    - `runtime/test/boot.test.ts:20` — `explodingPool` returns `Querier & Pick<Pool, "connect" | "end" |
"options">` over `Object.assign(new Pool(), { query: trap, connect: trap, end })` (the group-4
      `makeFakePool` precedent; a bare `Pool` dials nothing at construction).
    - `tools/research/test/misc-tools.test.ts:276` and `tools/workspace/test/workspace-display.test.ts:39,
165` — the throwing and empty-rowset fakes annotate `Querier` and drop the cast.
- MEASURED WALL 1 — the computed-row `Querier` fake cannot close at the fake. A query function that
  computes its rows (from a parameter, a map, or a literal) is NOT assignable to
  `Querier["query"]`: TS keeps `R` abstract and refuses every source whose rows are not `never[]`
  (measured TS2322 in isolation, probe kept at `tmp/pi/probe5.ts`: "Type 'Record<string, unknown>' is
  assignable to the constraint of type 'R', but 'R' could be instantiated with a different subtype"). The
  shapes that DO close are the forwarding fake (`query: (t, v) => pool.query(t, v)`, naturally generic —
  the counting-querier and chat-turn pattern), the empty-rowset fake, and the throwing fake. The run-2
  "measured shape" (`annotate the const with the structural type, drop the cast`) holds only for those.
  The run first converted the computed-row fakes, measured the TS2322 set, and restored each reverted
  file's fakes to their exact pre-run cast form by edit (no git command ran): misc-tools 4
  (94, 113, 207, 286), workspace-display 2 (20, 187), tools/execute-analysis 2 (121, 221),
  workflows/execute-analysis 3 (319, 325×2), step-seed 2 (94, 99). The lawful closes are the coordinator's
  call, module by module: the message-backfill device (the consuming call site names its row type at a
  client generic over the ROW type, not the method) or a module-local row-reader deps type (the Decision-1
  pattern with the concrete row union). This rides on the pool-fake families left in the worklist below.
- MEASURED WALL 2 — the Browser family is one coupled unit and its computing fake cannot close. The
  structural design compiles: `chrome.ts` gains `ConnectedBrowser`/`LookContext`/`LookPage` (the
  Decision-1 pattern; `BrowserConnector` and `withPage` retype; `page-capture.ts` internals take
  `LookPage`; a real `Browser`/`Page` stays assignable — the vendor classes are nominal, but class →
  structural is fine, and the `on` listener params keep the vendor's own `ConsoleMessage`/`HTTPRequest`
  types in parameter position). Three of the four fakes (chrome.test 36, examine-page 209, assemble 246)
  build the structural shape directly. The fourth (`page-capture.test.ts:104`, the only fake whose page
  computes recorded evaluate results) must implement `LookPage.evaluate` =
  `<R, Args extends unknown[]>(pageFunction: (...args: Args) => R | Promise<R>, ...args: Args) =>
Promise<R>`, and a non-generic source cannot produce `Promise<R>` for an abstract `R` (measured TS2322,
  probe at `tmp/pi/probe4.ts`; `Promise.resolve(undefined)`, a concrete union, and a rest-args form all
  fail). The whole family was REVERTED to its pre-run bytes by edit before the run closed (chrome.ts,
  page-capture.ts, and the four test files; verified by the green typecheck and the unchanged 66-site lint
  list minus this run's closures). Options for the coordinator: (a) give `LookPage.evaluate` a second,
  non-generic overload whose area read the module guards at its own boundary — a behavior decision at a
  boundary that today trusts the page body's declared return (D3 review); (b) accept the four sites as
  the enumerated residual; (c) a D2.4 test-accessor family for the page reads. Note for any retry: the
  closure must land as ONE edit across chrome.ts + page-capture.ts + the four test files, or the
  connector seam refuses one side.
- Gates at the close: `bun run typecheck` passes. `bun --bun oxlint` reports `no-double-cast` 47 (was 66;
  the 19 closed are the sites above) and still ZERO reports from the three rules in non-test files. The
  tests of every changed file pass on the FIRST run: misc-tools + mutate-surface + ad-hoc-router 35 pass;
  workspace-display + boot + report-session-state 35 pass; tools/execute-analysis +
  start-report-session 88 pass; assemble + suspension-cascade 16 pass; workflows/execute-analysis 85 pass
  (259 pass / 0 fail total). `bun run format:file` ran on every changed file (all unchanged). No `!`, no
  lint directive, and no new cast was added anywhere; the run's only new file is the provider fixture.
- Task 5.1 stays open: the gate (zero `no-double-cast` anywhere) does not pass with 47 sites standing.
  Worklist for the next run, by family: the 13 computed-row pool-fake sites (misc-tools 4,
  workspace-display 2, tools/execute-analysis 2, workflows/execute-analysis 3, step-seed 2) behind
  MEASURED WALL 1's decision; the 4 Browser sites behind MEASURED WALL 2's decision; docker-client 5
  (the module's own `DockerEngine` type already exists — `stubDocker` retypes to it, and the two method
  patches at 442/451 become plain property assignments); k8s-client 3 (the object-param merged types are
  measured: `createNamespacedJob({namespace, body}) → Promise<V1Job>`, `listNamespacedPod →
Promise<V1PodList>` — module-local `BatchJobApi`/`CorePodApi` structural types at `k8s-client.ts`,
  config and internal params retyped); enrich 3 (`readSeam` fs fake is the complete 4-member
  `WorkspaceFilesystem` literal the step-summary test already builds; both SandboxClient fakes spread
  `makeFakeSandboxClient()` from `src/agents/sandbox/__fixtures__/deps.ts` and override `exec`);
  tool-detail 3 (the hook's declared return vs `undefined` — decide at edit time whether the fixture's
  callback parameter widens or the hook seam does); the contracts 4 (report-reference 12/179 — the
  serialize helper's parameter takes the widened reference union from group 3; chat-frame 107/429 — build
  the `done` member of `ChatStreamEvent` directly and re-check the applyChatFrame part parameter); the
  report-model 2 and report-render 4 singles; and the 6 singles (otel 85, hooks 36, scan 9,
  report-versions 259, mutate-surface 24, briefing 599) whose shapes the run-2 record already sketches.

## Group 5 record (task 5.1, fifth run, 2026-10-25 — PARTIAL: 8 of the 47 standing sites closed; the wall-clock budget closed the run with 39 open)

- The two coordinator decisions for the measured walls are applied. Each is type-level only; zero runtime change.
- DECISION 2 (the Browser family, 4 sites) — closed as ONE edit across `chrome.ts` + `page-capture.ts` + the four test files, as the run-4 note required:
    - `src/lib/chrome.ts` declares the non-generic consumer-side structural types: `ConnectedBrowser` (the four members the cache reads), `LookContext`, `LookPage`, `LookPageEvents`, and `CaptureArea` (moved here from page-capture, because the look contract names it). `BrowserConnector`, `getBrowser`, `withPage`, and `EndpointEntry` are retyped to them; the module no longer imports `Browser`/`Page`/`BrowserContext`.
    - `LookPage.evaluate` is NON-GENERIC with three overloads — `() => number` → `Promise<number | undefined>`, the block-measure form → `Promise<CaptureArea | null>`, and the open `(fn: (...args: never[]) => unknown, ...args: unknown[])` → `Promise<unknown>` — each return type is what the capture read needs (probes `tmp/pi/probe7`–`probe9`: a single non-generic return cannot serve both reads, and a single-signature fake cannot satisfy precise overloads; an OVERLOADED source function satisfies an overloaded target member). `LookPage.on` is the vendor's own generic event pattern narrowed to the three events the capture reads (`LookPageEvents`); the three-literal-overload form and the `never`-listener form both refuse a real `Page` (measured TS2322: the vendor's event handler erases to `unknown`), the narrowed generic form accepts it (probe `tmp/pi/probe11`).
    - `src/lib/page-capture.ts` internals take `LookPage`; the local `CaptureArea` is deleted with the import that replaces it. A real `Browser`/`Page`/`BrowserContext` satisfies each structural type — the whole-tree typecheck proves it.
    - `src/lib/__fixtures__/chrome.ts` is new: `fakeLookPage(overrides)` (evaluate rejects with `Promise<never>` — the capture reads a refused measure as a short page and a refused readiness wait as a page that captures as it stands, so the reject lands in the catch each caller carries) and `fakeLookBrowser(pageOverrides)`. The four fakes: `chrome.test.ts` annotates `ConnectedBrowser` and its context hands out `fakeLookPage()`; `page-capture.test.ts` builds the recording page directly and its computing evaluate becomes `makeEvaluateFake(recorder, plan): LookPage["evaluate"]` — an overloaded declared function that reads `body.name` exactly as before (the run's recording behavior and every step assertion are unchanged); `examine-page.test.ts` and `assemble.test.ts` `makeFakeBrowser` are now two-line wrappers over `fakeLookBrowser({ screenshot })`.
- DECISION 1 (the computed-row fakes) — the misc-tools chain closed (4 of the 13 sites), per the decision's per-module device:
    - `src/state/runs.ts` gains `RunRowQuerier` beside the module (the decision's non-generic `query(textOrConfig, values?): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>` form, with `values?: unknown[]` matching `Querier` so a real pool and a `Querier`-typed caller stay assignable in both directions); `queryRun` and `queryRunsForInspection` take it, and their explicit `query<Record<string, unknown>>` args drop (the group-2 `mapRunRow` parser types the rows). `src/state/step-executions.ts` gains `StepRowQuerier`; `queryStepsByRun` takes it (it carried no explicit arg). `src/tools/research/inspect-run.ts` gains `InspectRunQuerier` (exported — the test's fake builders need the name); `createInspectRunTool` takes it.
    - Measured, correcting the plan this device rode in on: a non-generic row-reading type is NOT assignable to the generic `Querier` either (probe `tmp/pi/probe6`, TS2322 — `R` stays abstract in plain assignability, not only under contextual typing). So the concrete form must flow from the fake through every parameter on the path to the `.query(` call sites — the chain above is exactly that path, and no other `Querier` parameter changed.
    - `misc-tools.test.ts`: the four casts drop; `poolReturning`/`poolForRunDetail` return `InspectRunQuerier`, the two inline fakes annotate it, and each fake's `query` reads the SQL text through `typeof queryOrConfig === "string"` (the annotated `{ text: string }` parameter of the old fake refuses the config-form union that the concrete type carries).
- Gates at the close: `bun run typecheck` passes. `bun --bun oxlint` reports `no-double-cast` 39 (was 47; the 8 closed are the sites above) and still ZERO reports from the three rules in non-test files. The tests of every changed file pass: chrome + page-capture + examine-page 46 pass; misc-tools + the whole `src/state` module 282 pass (both on the first run). `bun run format:file` ran on every changed file. No `!`, no lint directive, and no new cast anywhere; the run's only new file is the chrome fixture.
- Task 5.1 stays open: the gate (zero `no-double-cast` anywhere) does not pass with 39 sites standing. Remaining worklist, by family, with the shape that closes each:
    - Decision-1 chains still open (9): workspace-display 2 (20, 187 — the same device: `workspace-search.ts` drops its `query<{id; score; metadata}>` args behind a module-local row-reader type, and `memory/card-builders.ts` `buildPlanCardData` likewise for the show-plan fake); tools/execute-analysis 2 (121, 221) and workflows/execute-analysis 3 (319, 325×2) — both chains reach `withTransaction`, whose `Connectable`/`TransactionQuerier` are row-generic, so the same non-generic form must cover the transaction client before the computed fakes close (measured direction: `Querier`-shaped callers stay assignable to the concrete form); step-seed 2 (94, 99) — the second cast hides a PARTIAL `ExecuteAnalysisDeps` bag, so the fake needs the complete builder, not only the pool type.
    - docker-client 5, k8s-client 3, enrich 3, tool-detail 3, contracts 4, report-model 2, report-render 4, and the 6 singles (otel 85, hooks 36, scan 9, report-versions 259, mutate-surface 24, briefing 599) — the run-2/run-4 sketches hold; none was started this run.

## Group 5 record (task 5.1, sixth run, 2026-10-25 — PARTIAL: 26 of the 39 standing sites closed; the wall-clock budget closed the run with 13 open)

- The five families of the run-5 worklist that were closable without a further decision are closed:
    - docker-client 5: `stubDocker`, `erroringDocker`, `reconcileDocker`, and `reconcileOps` annotate the module's own `DockerEngine`; the two method patches at 442/451 became plain property assignments (the `id` key the patches carried is not on `EngineContainer`, so it dropped); the stubs gained inert `listContainers` and the dead `createNetwork` member is gone (the `createdNetworks` array and its empty assertion stay).
    - k8s-client 3: `src/sandbox/k8s-client.ts` exports the structural `BatchJobApi`/`CorePodApi` (the exact members the module calls: create/read/delete/listNamespacedJob, listNamespacedPod), and the config fields plus every internal param ride them; a real `kc.makeApiClient(BatchV1Api)` satisfies them. The test fakes annotate the structural names; the fake's `listNamespacedJob` is real (the module's `listManagedSandboxes` calls it).
    - enrich 3 + scan 1 + mutate-surface 1: the complete 4-member `WorkspaceFilesystem` literal, both SandboxClient fakes spread `makeFakeSandboxClient()` and override `exec`, and `AgentSession` gets complete builders (identity/scope/provenance/`auth: {}` — the brand field is optional, so `{}` satisfies it).
    - tool-detail 3, with the fixture-vs-seam decision the run-2 note left open: the SEAM widened. `define-tool.ts` `describeCall`/`describeResult` now return `string | undefined` on `Tool` and `ToolDefinition` — the declared contract of what `tool-detail.ts`'s guard already treats as "no detail". Five test helpers whose local annotations pinned `=> string` widened in step (describe-call, authoring-tools, examine-page, list-artifacts, preview-report, record-version). Site 293 reads the missing result field through `Reflect.get(Reflect.get(result, "missing"), "deep")` — the deep read the old cast faked, with no shape promised.
    - The singles: chat-frame 107 (the literal is now the true provider `done` shape: `{ type: "done", response: { message: { role: "assistant", content: "" }, finishReason: "stop" } }`) and 429 (annotated `Parameters<typeof applyChatFrame>[1]` — the group-3 passthrough union admits it directly); report-reference 12/179 (`encodeUnchecked` is the one reflection point — `Reflect.apply(serializeReference, undefined, [value])` — `bounded` is generic over the rowBound, and `expectRoundTrip` keeps `Reference`); draft 56 (`draft.ts` exports the raw `DraftBlockUnionSchema` beside the erasing `DraftBlockSchema` annotation, the test reads `.options` typed); render 360 (the payload helper returns the two staged shapes and the new `registeredTablePayload`/`registeredDisplayPayload` narrow with `in` and THROW on the wrong shape — the D2.4 accessor contract); otel 85 (`otel.ts` gains `__otelTracerResourceForTest()` beside the meter-provider hook, reading the registered resource attributes; the probe span still starts and ends); hooks 36 (the seam widened: `passGate` takes `ResultAsync<T, GateFailure> | ForeignGateResult<T>` — a thenable over the exported structural `GateSettlement<T>` — and normalizes through the private `settlementOf` + a known-union guard `settlementOk`; the foreign-copy test keeps its thenable, built cast-free); report-versions 259 (the deliberate caller-bug simulation rides `Reflect.apply(store.record, store, [...])`; the record's typed surface is unchanged); briefing 599 (the sentinel step rides `Reflect.apply(renderTask, undefined, [step])`).
- Gates at the close: `bun run typecheck` passes (0 errors). `bun --bun oxlint` reports `no-double-cast` 13 (was 39) and still ZERO reports from the three rules in non-test files. The tests of every changed file pass on the FIRST run: sandbox docker+k8s 82; input-scan + tool-detail + contracts + briefing 481; otel + hooks + report-versions + draft + render 226; the six widened-helper tool suites + mutate-surface 242. `bun run format:file` ran on every changed file (all unchanged). No `!`, no lint directive, and no new cast anywhere.
- Task 5.1 stays open: the zero gate needs the last 13. Each remaining site with its shape:
    - The 9 Decision-1 chain sites, unchanged from the run-5 record: workspace-display 2 (20, 187 — `workspace-search.ts` drops its `query<{id; score; metadata}>` args behind a module-local row-reader type), tools/execute-analysis 2 (121, 221) and workflows/execute-analysis 3 (319, 325×2) — both reach `withTransaction`, whose `Connectable`/`TransactionQuerier` are row-generic and need the same non-generic form before the computed fakes close; step-seed 2 (94, 99 — the fake needs the complete `ExecuteAnalysisDeps` builder, not only the pool type).
    - validate.test:49 (sparseRows) — the resolver's rows param must admit the pre-parse sparse rows; decide at edit time between a `Record<string, unknown>` param view and the resolver seam.
    - chart.test:1603 — the test needs an empty `ChartComposition`; the type's defining module was not located this run (`grep "export type ChartComposition" src/report-render` found nothing; it is imported at chart.ts:40) — locate it, then complete the literal or add a builder.
    - chart-renderers.test:231 and chart-toolbox.test:242 — `render`/`draw` is the module's `ChartRenderer`; echarts wants `CustomSeriesRenderItem`. First try the adapter wrapper `echarts.registerCustomSeries(name, (params, api) => render(params, api))`; if the vendor param types refuse it, that is a measured wall for the coordinator.
- New module surface this run, for review: `define-tool.ts` hook returns `string | undefined` (author-facing, documents the guard's tolerance); `k8s-client.ts` exports `BatchJobApi`/`CorePodApi`; `draft.ts` exports `DraftBlockUnionSchema`; `hooks.ts` exports `GateSettlement`/`ForeignGateResult`; `otel.ts` exports `__otelTracerResourceForTest`. None is added to a barrel.

## Group 5 record (task 5.1, seventh run, 2026-10-25 — 12 of the 13 standing sites closed; ONE site stands, see STILL OPEN)

- The gate: `bun --bun oxlint` reports ONE `@inflexa-ai/no-double-cast` (was 13; validate.test.ts:44,
  the seam decision below), and still ZERO reports from the three #707 rules in non-test files. `bun run typecheck` passes. The tests of
  every changed file pass on the FIRST run: workspace-display + chart + renderers + toolbox + render +
  chart-export + state + memory 1115 pass / 0 fail across 51 files; the three execute-analysis and
  step-seed suites 174 pass / 0 fail; `src/app` (the approve-plan caller of the converted
  `loadPlanRecord`) 175 pass / 0 fail. `bun run format:file` ran on every changed file (all unchanged).
  No `!`, no lint directive, and no new cast anywhere.
- The last 13 sites, by shape:
    - workspace-display 2 (20, 187): `workspace-search.ts` declares the exported
      `WorkspaceSearchQuerier` (one row-reading `query` over `SearchHitRow = { id; score; metadata }`) and
      `createWorkspaceSearchTool` takes it; its explicit `query<{...}>` args dropped. `plans.ts` declares
      the exported `PlanRowQuerier` (concrete `Record<string, unknown>` rows) and `loadPlanRecord` takes it
      with a field-shape `PlanRecordRowSchema` parse of the row (a malformed required column refuses through
      the `tryQuery` `DbError` channel — the D3 required-column rule); `show-plan.ts` and
      `card-builders.ts` `buildPlanCardData` take `PlanRowQuerier` down the chain (exported through
      `state/index.ts`). The other `plans.ts` functions keep `Querier` — only the fake's path converted.
      The concrete-form callers stay assignable (a `Querier`-typed value satisfies the concrete form), so
      `approve-plan` and the conversation agent compile unchanged.
    - chart.test 1603: a DELETION — `{ series: [] }` satisfies `ChartComposition` directly (zod's `.min(1)`
      holds at parse time alone, never in `z.infer`), so the annotation replaces the cast and the guard
      under test still receives the empty composition.
    - chart-renderers 231 + chart-toolbox 242: the run-6 adapter shape, reused from production —
      `rendererApi` (`chart-export.ts`) is now exported and both tests register with
      `(name, render) => echarts.registerCustomSeries(name, (params, api) => render({ itemPayload:
params.itemPayload }, rendererApi(api)))`, the exact `renderChartSvg` registration. Measured reason
      the bare adapter fails: echarts' `value` returns `ParsedValue` and `coord` a `number[]`, so the
      vendor api needs the member-wise conversion `rendererApi` already carries.
    - tools/execute-analysis 2 (121, 221) + workflows/execute-analysis 3 (319, 325×2) + step-seed 2 (94, 99):
      closed with the group-4 `makeFakePool` device — `Object.assign(new Pool(), { query, connect })`. The
      own properties override the pool's behavior at runtime, and the real `Pool`'s generic `query`/`connect`
      signatures satisfy the row-generic `Querier`/`Connectable` targets (measured on this tree:
      `tmp/pi/g5-probe-walls.ts` — the bare computed fake still fails TS2322, the `Object.assign` form
      compiles). The workflows fake lost its `mock(answer)` generic wrap (no call-count assertion exists;
      the `queries` array records every statement) and its dead no-ledger ternary arm; `makeDeps` takes the
      pool member directly. The step-seed `deps()` builder now constructs a COMPLETE `ExecuteAnalysisDeps`
      (provider, embedding, sandboxStepCallable, synthesisModel, bioKeys, citationResolver,
      `createNoopRunCharge()`, a throwing `runAuthorizer`, working memory over the same fake pool), so the
      partial-bag cast is gone; `resolveWorkspaceRoot` keeps the old any-id-returns-root behavior the bag
      cast hid. step-seed's `fakePool` returns the same `Object.assign(new Pool(), { query })`.
- DEVIATION FROM THE NAMED DESIGN, disclosed: the run-6 worklist named "the `withTransaction`
  non-generic form" for the tools/workflows chains — a flip of `TransactionQuerier`/`Connectable` to
  concrete rows plus concrete row-reader params through ~15 production state functions (runs, plans,
  analyses, artifacts, data-profile, step-executions, card-builders, working-memory) and row-schema parses
  at the typed transaction-body reads (thread-store, thread-history ×2). This run did NOT take that route:
  the measured `Object.assign` device closes all seven sites with TEST-ONLY edits, zero production
  surface change, and zero runtime delta. The flip remains available if review prefers the named design —
  the run-6 record carries its full shape — but it is no longer needed for the zero gate. The
  `PlanRowQuerier`/`WorkspaceSearchQuerier` conversions above ARE the named Decision-1 device, unchanged.
- STILL OPEN (1 of the 13; the run ends here on the wall-clock budget): `validate.test.ts:44`
  `sparseRows` — the one `no-double-cast` report the fresh full run still prints (measured twice; an
  intermediate count of 0 in this run's transcript was a mis-read of a truncated lint output). The site
  is the resolver-seam decision the run-6 note deferred, and it cannot close lawfully inside this run:
  the sparse rows carry `undefined`/`null`/absent cells that `ArtifactSnapshot.rows`'s
  `Record<string, string | number>` refuses, and no cast-free construction of a deliberately off-type
  value exists. The two run-6 options, with this run's measurements:
    - the resolver seam: `ArtifactSnapshot.rows` widens to admit the three absence shapes (the module's own
      fixture-resolver comment states them, and its scalar read already handles them) — but the rows thread
      into `applyRowBound`/`columnsHeldByNoRow`, `ResolvedValue`'s table arm, `value-bridge`, and
      `ChartRow` (`Cell = string | number`), and `asFiniteNumber(null)` would read `0` where today it throws
      — a report-model + report-render seam decision the coordinator owns;
    - the param view: `ArtifactSnapshot.rows` as `Array<Record<string, unknown>>` with the fixture-resolver
      narrowing at its own reads — the scalar path takes one `typeof` guard (same refusal), but the table
      arm still passes rows through to `ResolvedValue`, so the same downstream ripple applies.
- Gates at the close (re-measured after the notes above were drafted): `bun --bun oxlint` reports ONE
  `@inflexa-ai/no-double-cast` (validate.test.ts:44 only) — was 13; still ZERO reports from the three
  #707 rules in non-test files. `bun run typecheck` passes. The tests of every changed file pass on the
  FIRST run: workspace-display + chart + renderers + toolbox + render + chart-export + state + memory
  1115 pass / 0 fail across 51 files; the three execute-analysis and step-seed suites 174 pass / 0 fail;
  `src/app` (the approve-plan caller of the converted `loadPlanRecord`) 175 pass / 0 fail.
  `bun run format:file` ran on every changed file (all unchanged). No `!`, no lint directive, and no new
  cast anywhere. Task 5.1 stays open on this one site.

## Group 5 completion record (task 5.1, eighth run, 2026-10-25 — the maintainer's Option A ruling applied at validate.test.ts:44; task 5.1 marked done)

- The ruling (2026-10-25, Option A) is applied: the rows parse at the resolver's snapshot entry. `reference-resolver.ts` declares `SnapshotRowsSchema` — a zod array of `z.record(z.string(), z.union([z.string(), z.number()]).nullish())` — which admits the three absence shapes (absent key, `undefined`, `null`), and a `.transform` that yields the module's internal typed view `Array<Record<string, string | number>>` by reading each nullish cell as an absent key. The exported `snapshotRows(entry)` parses one entry's rows (`[]` for an entry with no rows); both tiers read it, so they can never disagree about the rows of one entry (the module's own stated invariant).
- `ArtifactSnapshot.rows` widens to `Array<Record<string, string | number | null | undefined>>` — the seam admits what a real parser gives back, and the parse keeps the widened view OUT of the thread: `applyRowBound`, `columnsHeldByNoRow`'s signature, `ResolvedValue`, `value-bridge`, and `ChartRow` all keep `string | number` cells. NO widening through the thread, per the ruling.
- Reads converted: `fixture-resolver.ts` (both `artifact.rows ?? []` sites) and `structural-validation.ts` (both `snapshotEntry(...)?.rows ?? []` sites) call `snapshotRows`. No other consumer reads rows off a snapshot entry (the rest read `hash`/`fileType`).
- The negative test feeds its `sparseRows` literal directly: the `as unknown as Array<Record<string, string | number>>` cast at validate.test.ts:44 is gone, and the literal assigns to the widened row type cast-free.
- Runtime deltas, disclosed for the D3 review, each confined to fixture-supplied rows (production never populates `rows`):
    - The three absence shapes now normalize at the parse, so the scalar read refuses each as one absence. The pinned refusals are byte-identical: the undefined/null/absent sparse tests keep reason `locator-out-of-range` and the same detail (`column value holds no value in the selected row`), and the blank `""` cell stays a value. `cellMatchesFilterValue(null, v)` and `(undefined, v)` both returned false before, so the rowFilter path is identical.
    - A projected table row whose cell was `null` no longer carries the key (today the projection copied the null into the resolved table). No test reads that row.
    - `applyRowBound` over a column whose cells are all nullish: today `asFiniteNumber(null)` threw (`null.trim`); now the rows enter parsed, the cell reads as absent, and the bound ranks the row last. A crash becomes defined behavior at an unpinned edge.
    - `snapshotRows` uses `.parse`, so a cell the row type forbids (a boolean, an object) throws a zod error at the read. A caller that honors the declared row type never trips it; the old cast silently admitted such a cell.
- The four `toEqual({ type: "table", rows: snapshot.artifacts[...]?.rows ?? [] })` expectations in validate.test.ts read the rows through `snapshotRows(snapshot.artifacts[...])` — the resolver's own parsed view, which is what the resolved table actually carries. The clean tables parse to themselves, so the assertions are unchanged.
- Gates at the close: `bun --bun oxlint` reports ZERO `@inflexa-ai/no-double-cast` anywhere (was 1) — the group 5 gate passes. `bun run typecheck` passes. `bun test src/report-model` gives 306 pass / 0 fail across 11 files; the dependent suites (report-session, report-authoring, report-session-state, report-versions, value-bridge, gallery) give 0 fail. `bun run format:file` ran on every changed file (all unchanged). No `!`, no lint directive, and no new cast anywhere.

## Group 6 record (task 6.1, first run, 2026-10-25 — the accessor family is in and the figures sweep is PARTIAL; the wall-clock budget closed the run)

- The typed option-accessor family lives in ONE helper, `src/report-render/test/options.ts`: `optionOf` (an option object, or a failed test), `seriesOf` (the series array, each entry an option object), `optionArray(option, key)`, `optionAt(option, key)`, `optionNumber`, `optionNumbers`, `optionNumberRows`, `gridAt(option, index)`. Each accessor validates the shape and THROWS (fails the test) on a present value with the wrong shape — it never filters a malformed entry away and never invents a default (D2.4). The validation reads through the lib container guards (`isUnknownArray`, `parseUnknownRecord`); the production `figures/dense.ts` `seriesOf`/`axisOf` keep their tolerant contracts and are NOT reused for test reads (D2.4 names the difference).
- Sweep state per directory (the three rules, `bun --bun oxlint src/report-render`): the whole tree went 1311 → 782; `figures/test` went 914 → 380. The converted figures files carry the regular shapes: `X.series as EchartOption[]` → `seriesOf(X)`, `X.key as EchartOption[]` → `optionArray(X, "key")`, `X.key as EchartOption` → `optionAt(X, "key")`, dotted `x.y as number` → `optionNumber(x.y)`, `(option.grid as EchartOption[])[N]` → `gridAt(option, N)`, plus the number-array reads through `optionNumbers`/`optionNumberRows`. The twelve per-file local `seriesOf` wrappers (`return option.series as EchartOption[]`) are deleted — the strict helper replaces them.
- Gates at the close: `bun run typecheck` passes. `bun test src/report-render/figures` gives 0 fail (365 tests). `bun --bun oxlint` reports zero `no-double-cast` anywhere still. No `!`, no lint directive, and no new cast was added by the sweep (the codemod only removed casts; two sites below still carry their original casts).
- Named residuals for the next run, by shape (the irregular sites the codemod leaves):
    - expression casts: `series.at(-1) as EchartOption`, `series.find(...) as EchartOption`, `(guideLabel(...) as EchartOption).formatter`, `seriesOf(placed)[place]?.label` reads;
    - post-accessor scalar reads: `optionAt(option, "yAxis").max as number`, `firstGrid(...).width as number`;
    - the three sites this run REVERTED to their original casts after the strict read changed pinned behavior, each needs a shape decision at the next pass: `oncoprint.test.ts:128` (`bar.data as number[]` — the stacked bar data holds `null` segments the sum counts as zero; `optionNumbers` refuses the nulls), `roc.test.ts:121` (the `option.media as EchartOption[]` loop — `optionArray` failed it; the media member's shape needs a look), and the roc `place` read (now `findIndex` over `seriesOf(option)` — the strict accessor returns validating COPIES, so reference identity across two calls does not hold; a test that needs object identity must read by index or key);
    - the container/SVG-DOM casts (`as unknown`, `as Record`, `as Array`, `as Node`/`as Box`) in test/, chart-export.test, render.test, hybrid-svg.test — untouched;
    - gallery/test (126 reports), the remaining figures sites (380), and the test/ directory (276).
- Codemod for the mechanical shapes is at `tmp/pi/g6-codemod.ts` (tight line-scoped patterns, every hit printed); the import wiring script is `tmp/pi/g6-imports.py`. Measured lesson for the next run: the receiver patterns must not span `as number[]`/`as number[][]` (rule 5's `as number\b` matched the prefix), and a multi-line `import {` block defeats a "last import line" insertion.

## Group 6 record (task 6.1, second run, 2026-10-25 — 598 of the 782 standing reports closed; the wall-clock budget closed the run with 184 open)

- The accessor family grew the members the remaining shapes needed, all in `src/report-render/test/options.ts`: `optionList` (an array, or a failed test), `optionMaybe` (the option object of a member when present, `undefined` when absent), `optionStrings`, `optionsOf` (an array of option objects), `optionPair` (exactly two numbers), `optionPairRows` (rows of exactly two option objects), and `pageCall` (the function the page source builds under a name, called with unknown arguments — the lawful bridge for the `new Function(...).call(undefined) as (…) => …` page-function casts: `unknown` assignment, a `typeof` function guard, then `Reflect.apply`; no `any` reaches a typed surface).
- Closed this run, by shape: every regular `X.key as EchartOption[]`/`as EchartOption`/`as unknown[]`/`as number[]`/`as string[]`/`as number`/`.find(...) as EchartOption`/`.at(-1) as EchartOption`/`as [number, number]`/matrix-pair reads across gallery, chart-export, render, hybrid-svg, chart-distributions, and the figures tests; the per-file local `asObj`/`asArr` helpers now route through `optionOf`/`optionList` (chart, chart-grammar, design, dotplot, embedding); the markLine pair reads went through `optionPairRows` (manhattan, volcano, qq, chart-distributions `medianLines`, locuszoom); the tree-edge coords read through `optionPair(optionList(...)[0])` (gallery `leafPlaces`); the gallery local `seriesOf` wrapper is deleted and its `optionOf(id)` renamed `chartOf` so the imported record read can serve the same file.
- The three named revert-sites of the first run STAND reverted to their original casts, plus two more the strict reads refused this run (each a pinned behavior the accessor contract cannot express without a shape decision): `oncoprint.test.ts:128` (`bar.data as number[]` — the stacked bar holds `null` segments), `roc.test.ts:121` (the `option.media` loop) and the roc `place` identity read, `gsea.test.ts` `drawn()` and the two `markLine.data` reads (the deviation mark's data holds the ends of ONE line as `[end, end]`, and `drawn()`'s filter admits rows the all-numbers claim refuses), `embedding.test.ts:135,141` (the visualMap `left` value reaches the comparison through a cast the strict number read refuses), and `chart-export.test.ts:367,408,409` (the `bottom`/`offset` members).
- Gates at the close: `bun run typecheck` passes (0 errors). `bun test src/report-render/figures` gives 0 fail across 20 files (365 tests; the three red strict reads above were re-run, confirmed deterministic, and reverted to their pre-run cast form per the first-run precedent). `bun test src/report-render/test src/report-render/gallery` gives 0 fail across 17 files (712 tests). `bun run format:file` ran on every changed test file and on options.ts (all unchanged). No `!`, no lint directive, and no new cast was ADDED by the sweep — the casts that remain are the pre-run ones this run could not lawfully close.
- Task 6.1 is NOT marked done: `bun --bun oxlint src/report-render` reports 184 (was 782). Remaining worklist, by file: render.test 28 (the `window[TABLE_DATA_GLOBAL] as Record<…>` registry family and the toolbox `feature`/`exportClick` member reads — each needs a local registry reader over `parseUnknownRecord` with per-member claims); hybrid-svg 18 (the `Box`/`LayerBox` reads need a test-local `boxOf` that validates the four edges through `optionNumber`); volcano 14 (the `LeaderName["side"]` label-position claims, the `kind as keyof typeof CHART_EXPORT_SIZES` index — a for-in over the table gives the key type cast-free — and the two `CHART_SOURCE_MEMBER as ChartDataSource` reads); sankey 11, oncoprint 10, manhattan 9, locuszoom 9, forest 8, chart-toolbox 7, gallery 7 (the `manifest.json` `JSON.parse(...) as ManifestEntry[]`, the `seriesDataOnThePage` page-function signature, and the `CHART_SOURCE_MEMBER` read), lollipop 7, heatmap 5, chart-renderers 4 (the zr `shape` member reads — `optionOf` + member claims), and the rest at one to three. The `CHART_SOURCE_MEMBER as ChartDataSource` family (gallery, volcano, chart-grammar, embedding, qq, chart.test 1714) recurs across files and is the one shape this run could not close without a production-side validating export from `src/report-render/chart.ts` — the coordinator should rule on that export (a `sourceOf(option)` accessor beside `CHART_SOURCE_MEMBER`) before the next pass.
- Count drift other children own (this run): no `typeof` probe was added; no `!` and no `@ts-expect-error`; the removed casts took their restated claims with them (no new #709 population).

## Group 6 record (task 6.1, third run, 2026-10-25 — the sweep is complete; the three rules report zero under src/report-render)

- The run opened at 363 reports from the three rules, not the recorded 184: the recorded count matched
  rule 1 alone; the type-aware rule 2 now reports the same sites a second time (one site can carry one
  report of each rule). This run closed all 363 plus the site-level work the second type-aware pass
  surfaced. Gate state at the close: `bun --bun oxlint src/report-render` reports ZERO from
  `@inflexa-ai/require-assertion-safety`, `typescript/no-unsafe-type-assertion`, and
  `@inflexa-ai/no-double-cast`; `bun run typecheck` passes with 0 errors; `bun test src/report-render`
  gives 1103 pass / 0 fail across 39 files (no red container run, so no re-run was owed).
- The accessor family grew three members in `src/report-render/test/options.ts`: `optionEntry` (the
  option object of a list at an index, or a failed test), `markLineData` (the data of an option's mark
  line, empty when absent — the entries stay as the renderer built them, because one mark line mixes
  guide objects with pairs of line ends), and `chartSourceOf` (the payload name, the rule, and one
  option object per series of a dense chart's data source). `pageCall` now routes its return through an
  `unknown` binding. `chartSourceOf` is the TEST-SIDE answer to the run-2 escalation of the
  `CHART_SOURCE_MEMBER` family: the production export was never ruled on, and the test-side accessor
  closes the family with no production change. Read the note as the disclosure of that choice.
- Shapes closed per family: every page-function twin (`new Function(...) as (...) => ...`) now bridges
  through `pageCall`, with validating adapters where a call site reads the result as an option, as
  text, as a `LayerBox`, or as a `RenderedElement`-shaped view; the `CHART_SOURCE_MEMBER` casts ride
  `chartSourceOf`; the `TABLE_DATA_GLOBAL` registry family rides per-member readers
  (`stagedAt`/`stagedRecords`/`stagedTotal` in render.test, the reworked `registryOf` in
  table-data.test); the hybrid-svg `Box`/`LayerBox` reads ride `rectOf`/`extentsOf`/`layerBoxOf`; the
  sankey node claims ride `nodeEntries`; the volcano and manhattan `LeaderName["side"]` claims ride a
  literal `LABEL_SIDES` list checked with `satisfies`; the `CHART_EXPORT_SIZES` key claims ride a
  literal `EXPORT_KINDS` tuple (a missed table key would skip a size silently — the same residual
  class group 1 recorded for `ENCODING_KEYS`).
- DEVIATIONS DISCLOSED, each pinned-behavior-preserving: (1) oncoprint's stacked-bar totals read
  `optionList(bar.data)[place]` and count a non-number cell as zero — the old cast claimed `number[]`
  while the data holds `null` segments that the `?? 0` counted as zero, so the reachable sums are
  unchanged; (2) render.test's tool-grid stub registry uses a plain `{}` where `Object.create(null)`
  stood — the production reader touches own keys only; (3) three reads keep a numeric coercion that
  the old arithmetic implied: embedding's visualMap `left` runs through `Number(...)`, and heatmap's
  fixture rows build through a validating `rowOf` (the old `as ChartRow[]` cast hid that the rows are
  positional cell arrays); (4) render.test's bootToolbox layer styles type `string | undefined`, which
  makes the absent-`visibility` reads honest without the `?? undefined` no-ops.
- NEW TEST-SIDE PREDICATES, disclosed for the #709 ledger: render.test and table-data.test each carry
  an `isRecord` (checked with `parseUnknownRecord`, no copy taken), and chart-renderers.test carries
  `isRendererFunction` (checked with `typeof`). The no-copy property is load-bearing: the zod record
  parse behind `optionOf` REBUILDS the object and destroys an own `__proto__` key (measured: the
  parsed copy holds a null-prototype object and loses the value), so the prototype-pollution fixtures
  must be checked, never copied — `cellRows`/`cellRow` rebuild the fixture rows through
  `Object.fromEntries`, whose property creation keeps `__proto__` an own key.
- Page-twin honesty: the hybrid-svg and chart-toolbox twins build their `Function` with the
  `document` parameter exactly as before (the page sources read that closure) and hand the member
  objects over through `optionOf` plus per-member checks; the chart-renderers twin hands over the
  page's own functions (checked with `isRendererFunction`), because the register test compares the
  registered functions by identity with the twin's.
- RESIDUAL, one report from a rule outside this change: `bun --bun oxlint src/report-render` holds one
  `typescript/no-unsafe-argument` at `validity.test.ts:36` — the `csstree-validator` import is untyped
  (the file carries the pre-existing `@ts-expect-error`), and the Reflect.apply bridge that replaced
  the old cast is the one rule-clean way to reach it; the findings are parsed through
  `optionList`/`optionOf` at the boundary. The #706/D4 sweep owns the shape decision (a local module
  declaration is ignored by the harness tsconfig).
- Count drift other children own (this run): no `!`, no lint directive, and no new cast was added; the
  `isRecord`/`isRendererFunction` predicates above are the #709 ledger additions of this run.

## Item 0 record (the 26 non-#707 regressions, closed; the final-gate precondition holds)

- `bun --bun oxlint` full run: ZERO reports from any rule outside the three #707 rules (the only
  remaining "error" line is oxlint's own exit summary). `bun run typecheck` passes (0 errors).
- db-result.ts: `TransactionQuerier` and `Connectable` became `type` aliases (#704 `no-interface`).
  The conversion exposed one more member of the same family the first grep had not listed:
  `src/state/db.ts` structural `Querier` — also now a `type` alias.
- Unused imports/params removed: `Connectable` (workflows execute-analysis.test, runtime/boot.ts),
  `Pool` (app synthesize-run.test, tasks data-profile-suspension.test), `EmbeddingProvider`
  (data-profile-settle-notice.test, data-profile-suspension.test), `PoolClient`
  (state/purge-analysis.ts), `Docker` (sandbox docker-client.test), the `resourceId` parameter of
  step-seed.test's `resolveWorkspaceRoot` (zero-arg arrow), and the dead `badSnapshot` const of
  report-versions.test.
- The two `require-yield` generator fakes (providers `__fixtures__/chat-provider.ts`, workflows
  execute-analysis.test) became always-throw arrows: `chatStream`'s declared return is
  `AsyncIterable`, and a body that only throws satisfies it with no generator. Both fakes are never
  driven (the tests replace the consuming step callable), so the throw point moving from first
  iteration to call time is unobservable.
- report-versions.test "refuses a malformed snapshot": the `Reflect.apply` caller-bug simulation and
  its exposed `any` are GONE. The group-5 Option A ruling widened `ArtifactSnapshot.rows` cells to
  admit `null`, while the store's own parse (`snapshot-parse.ts` `ArtifactSnapshotSchema`) still
  refuses a null cell — so a LAWFULLY TYPED malformed snapshot now exists
  (`rows: [{ broken: null }]`). The test builds it and calls `store.record` normally; the pinned
  observables are byte-identical (refusal type `malformed_snapshot`, issues non-empty, no row). The
  old comment's premise ("no lawful value of that type is bad") is false since the widening; noted
  as the reason the reflection device retired.
- The three `Reflect.apply` return bridges (report-reference `encodeUnchecked`, briefing's
  `renderTask`, tool-detail's missing-field hook) now route through an `unknown` binding plus a
  `typeof` guard that throws on drift — the pageCall device; behavior identical on every reachable
  path (the wrapped functions all return strings).
- validity.test.ts: `src/report-render/test/csstree-validator.d.ts` is new — `validate(css,
filename?): unknown` (the module ships no types; the gate keeps validating each finding at the
  boundary). The `@ts-expect-error` and its stale "the harness ignores src/**/*.d.ts" comment are
  removed; the Reflect.apply call shape is unchanged.
- Tests of every changed file pass (report-versions, report-reference, tool-detail, briefing,
  validity, step-seed, workflows execute-analysis, synthesize-run, settle-notice, suspension,
  docker-client, providers fixtures: 0 fail).

## Group 7 record (task 7.1, first run, 2026-10-25 — PARTIAL: 72 of 511 reports closed; the wall-clock budget closed the run)

- Start of run (live): tools 413, memory 30, providers 42, app 20, contracts 6 (511 reports; every
  site carries rule 1 AND rule 2 — one fix closes both). End of run: tools 356, memory 16,
  providers 42, app 19, contracts 6. Task 7.1 NOT marked: its gate (zero from the three rules in
  the five directories) does not pass.
- Closed this run:
    - `generate-plan.test.ts` (56 → 0): the 16 `as PlanResult` sites are the planner outcome read
      through `Tool`'s `unknown` output — `planResultOf` parses with the module's own
      `PlanningAgentOutputSchema` (D2.1; a deletion attempt was MEASURED wrong: tsc proved `execute`
      returns `Result<unknown>` for the base `Tool` type). The 7 `loadPlan(...) as { steps: ... }`
      sites parse through a `storedPlan` zod helper (the state layer's payload is `unknown` by
      design); the `jsonSchema` and logger-`fields` casts parse with per-shape zod schemas. The local
      `PlanResult` type is deleted.
    - `conversation-display-storage.test.ts` (11 → 0): the three `JSON.parse(JSON.stringify(...))
as unknown` arguments pass the `any` directly into the `unknown` parameter; the three
      `toEqual([known] as never)` sites type `known` as `ConversationUIMessage["parts"][number]`
      (the ai-sdk part union the stored envelope carries — the harness `MessagePart` annotation was
      measured wrong and replaced); the tool-call expectation is a `ToolCallPart`-annotated const and
      its `call` literal gained `as const` so `outcome` keeps its literal type.
    - `ai-sdk-message-storage.test.ts` (3 → 0): the same `as unknown` deletions plus one `unknown`
      annotation on the `JSON.parse` round-trip const.
    - `chat-turn.test.ts` `storedDisplay`'s trailing `as unknown` deleted (`JSON.parse` returns into
      a declared `Promise<unknown>`).
- MEASURED WALL for the coordinator — the `tool.inputSchema.parse(x) as Parameters<typeof
tool.execute>[0]` family (knowledge-tools.test ~23 sites; the same shape in web-fetch,
  web-search, search-patents, search-regulatory-approvals): `Tool.inputSchema` is declared
  `z.ZodType` (the interface erases the schema), so `.parse()` returns `unknown` and the cast is
  the only bridge into `execute`'s concrete input. No test-local device closes it cast-free: the
  schema's concrete type lives inside the factory closure, a generic helper only moves the cast,
  and passing the raw literal skips the parse the dispatcher performs. The lawful closes are a
  public-type decision (type `Tool.inputSchema` with its schema so parse returns the input — a
  `Tool`/`defineTool` surface change the cli reads) or a maintainer-sanctioned escape. NOT
  attempted; the files stand as they were.
- Remaining worklist (in `tmp/pi/g7-sites.txt`, per-file counts in the run transcript): the
  inputSchema family above; tools execute-analysis.test (38), inspect-data-profile.test (36),
  catalog-tools.test (34), workspace-display.test (18), normalize-echart-spec.test (18),
  approval gateway.test (17), ai-sdk.request-timeout.test (15), ad-hoc-router.test (13),
  web-fetch/search-regulatory-approvals/search-patents (13 each), thread-history (7), and the
  one-to-eight site files. The devices that close each shape are the ones this run used: module
  zod schemas for tool-output reads, `storedPlan`-style parse helpers for `unknown` state payloads,
  deletions where the compiler already types the value, `unknown` bindings + `typeof` guards for
  third-party any returns, and `as const`/annotations for literal widenings.
- Gates at the close: `bun run typecheck` passes; the full oxlint run reports ZERO from any
  non-#707 rule; tests of every changed file pass (generate-plan + knowledge-tools 72 pass,
  memory + chat-turn batch 160 pass, the item-0 set 293 pass across its batches; no red run, so
  no re-run was owed). `bun run format:file` ran on every changed file. No `!`, no lint directive,
  no new cast; the one new file is the csstree declaration. `as const` added only on the
  tool-call `call` literal (D5: `as const` needs nothing).

## Group 7 record (task 7.1, second run, 2026-10-25 — the maintainer's inputSchema ruling applied and swept; 161 more reports closed; 214 stand; the wall-clock budget closed the run)

- THE RULING IS APPLIED (`src/tools/define-tool.ts`): `Tool.inputSchema` is `z.ZodType<Input>`. The
  generic mismatch this created inside `defineTool` closed by aligning the constraint —
  `Schema extends z.ZodType<any, unknown>` on `ToolDefinition` and `defineTool` (zod's own
  `_ZodType extends ZodType<any, any, Internals>` device; the `any` sits in the constraint's output
  slot only, so concrete call sites keep their precise `z.infer` types). `bun run typecheck` passed
  after the one-line retype plus the constraint alignment, before any test edit.
- The `inputSchema.parse(x) as Parameters<typeof tool.execute>[0]` family is GONE (28 sites across
  knowledge-tools, web-fetch, web-search, search-patents, search-regulatory-approvals, amass
  integration): `parse` now returns the tool's `Input`, so every cast dropped with no other edit.
  The first run's MEASURED WALL is closed by the ruling.
- Closed this run (72 of the run-open 375 after the family sweep → 214 stand; every closed file at
  zero from the three rules):
    - `tools/test/execute-analysis.test.ts` (38 → 0): the `._unsafeUnwrap() as {...}` reads deleted
      (the tool's ok type is concrete; the casts were widenings); the refusal/error reads took the
      `in`-guard and `instanceof`-guard if-throw form (D2.4); `{} as RunSession` became the complete
      session literal (the workflows-test shape); `{} as never` utilityProvider became
      `unusedChatProvider()`; `{} as Pool` became `new Pool()`; the jsonSchema properties reads went
      through `parseUnknownRecord`; the launcher capture is `unknown[]` parsed by a `launchedInput`
      zod helper (the RunLauncher method's `I` is abstract — a concrete param annotation refuses,
      measured TS2322); the plans-map read takes a `storedAdHocPlan` zod helper (the generate-plan
      `storedPlan` device); the two `storeDirs` tuple casts became `as const` (the seam declares
      `readonly [string, string]`).
    - `research/test/inspect-data-profile.test.ts` (36 → 0): union-arm reads take the
      `"field" in out` if-throw guard (with `=== undefined` where the arm's field is optional);
      `JSON.parse(JSON.stringify(...))` round-trips annotate `Record<string, unknown>`; the
      jsonSchema properties read rides `parseUnknownRecord`; the legacy-profile absence reads moved
      onto the serialized wire (`wire.domain` undefined + `not.toHaveProperty`), preserving the
      pinned drop-out behavior (the in-memory object holds the key with value `undefined` — the
      first cut asserted absence in memory and failed the pinned test once).
    - `sandbox/test/catalog-tools.test.ts` (34 → 0): every `._unsafeUnwrap() as {...}` became the
      union-arm guard keyed on the arm's unique field (`checked`/`total`/`content`/`available ===
false`); the `queryPackages` call takes the same guard. The now-unused `CheckedPackage` type
      import dropped.
    - `workspace/test/workspace-display.test.ts` (18 → 0): the emitted-event reads ride two
      file-local accessors, `emittedEvent` (the type string + the data record, or a failed test) and
      `recordOf` (a payload record, or a failed test), both over `parseUnknownRecord` — the D2.4
      test-accessor family; `emittedEvent` never copies the event object it does not rebuild (the
      zod record parse rebuilds; no prototype-sensitive fixture reads here).
    - `display/test/normalize-echart-spec.test.ts` (18 → 0): the same accessor family —
      `recordOf`/`recordsOf` beside the existing `axisLabel`/`grid`/`saveAsImage` helpers, which now
      validate instead of casting.
    - `approval/test/gateway.test.ts` (17 → 0): the `data-ask` emit double-cast parses with a
      module-local `AskPartDataSchema`; the pg row reads (`selectRow`, `countAsks`, `grantCount`)
      parse with `AskStateRowSchema`/`CountRowSchema` (rows bind through a `: unknown` local — pg
      rows are `any`); `(caught as AskRejectedError).feedback` took the instanceof guard; the
      unused `ChatDataPart` import dropped.
- NOT started this run: ad-hoc-router.test (13 — the two `as never` error literals drive error
  types `ProviderError` does not model; the Fork-B widen-or-literal decision belongs to the
  coordinator), ai-sdk.request-timeout (15), web-fetch (11), chat-turn (10), the search-patents /
  search-regulatory-approvals residue (the fetch-double and per-shape sites), and the small files.
  Fresh worklist: re-run `bun --bun oxlint src/tools src/memory src/providers src/app
src/contracts` — 214 reports, all in test files, all from the three rules.
- Gates: `bun run typecheck` passes. Tests of every changed file pass: execute-analysis 67/0;
  inspect-data-profile 31/0 (re-run after the wire-read correction, per the re-run-once rule — the
  first cut of the legacy-profile read was wrong and red once); normalize-echart-spec 45/0;
  workspace-display 14/0 (first cut red once on the same test, fixed by restoring the `.spec` field
  read); catalog-tools 37/0; gateway green in the three-file batch (88 pass / the one inspect-data
  fail above); no other red container runs. `bun run format:file` ran on every changed file; the
  one reflow it made (catalog-tools) is applied. No `!`, no lint directive, no new cast; the only
  production edit is the ruled `define-tool.ts` retype and its constraint alignment.
- #706 drift: no `!` added anywhere. #709 drift: no new predicate over `unknown`; the new helpers
  return values (`recordOf`, `emittedEvent`, `recordsOf`), not type predicates.

## Group 7 record (task 7.1, third run, 2026-10-25 — 110 of the run-open report lines closed across providers, app, memory, and contracts plus the tools core; 110 report lines stand; the wall-clock and tool budgets closed the run)

- Start of run (live): 220 report lines from the three rules in the five directories (≈110 unique sites;
  most sites carry rule 1 AND rule 2). End of run: 110 report lines stand (≈56 sites), all in test files
  except the two `no-explicit-any` lines on `define-tool.ts` named below. Task 7.1 NOT marked: its gate
  (zero from the three rules) does not pass.
- Closed this run (every touched file at zero from the three rules unless named in the residuals):
    - providers: `ai-sdk.test.ts`, `ai-sdk.request-timeout.test.ts`, `ai-sdk.openai-arm.test.ts`,
      `configured-provider.barrel.test.ts`, `errors.test.ts`, and the three live integration tests.
      The DOMException catch reads took the instanceof-guard if-throw; the timer double became a `Proxy`
      over the real `setTimeout`/`clearTimeout` (the trap keeps the exact timer interface a plain wrapper
      arrow cannot carry); the `RequestInit & {timeout}` reads took the `in`-guard; the
      `JSON.parse(...) as ResponsesRequestBody` body read parses with a test-local `z.looseObject` pair
      (passthrough keeps the negative wire assertions honest); `parseUnknownRecord` reads the captured
      Anthropic body; the `max_tokens` read narrows with `typeof`; the `findSuspendError` identity binds
      through an `unknown` local; the citation `Object.fromEntries` cast became an annotation;
      context7/quickgo took the union-arm `in`-guard.
    - `src/providers/__fixtures__/chat-provider.ts` gains `chatProviderDouble(chat, chatStream = empty
generator)` — the complete ChatProvider builder (D3); `ad-hoc-router.test.ts`'s six `{...} as
ChatProvider` doubles and both `as never` error literals route through it with modeled
      `ProviderError` values (the router classifies by catch and signal, never by the error fields, so
      the runtime behavior is unchanged).
    - memory: `thread-history.test.ts` (`sumOf` histogram accessor; the `tool-result` read drops its
      redundant cast), `tool-call-integrity.test.ts` (role-guard helpers, the tool-parts filter narrows
      the known ai-sdk part union), `card-builders.test.ts` (`parseUnknownRecord` on the card content),
      `thread-store.test.ts` (cast deleted — see the CreateThreadInput widening below),
      `conversation-display-parity.test.ts` (ModelMessage annotation replaces the literal cast).
    - `src/memory/thread-store.ts`: `CreateThreadInput.type` is `ThreadType | string` — the store
      validates the field at runtime and `unknown_thread_type` is a declared refusal, so the input type
      now admits the untyped caller it always served (D2.1); the negative test passes its out-of-set
      string without the assertion.
    - contracts: `content-url.test.ts` (the generic `readFixture` any-return dies; the fixture parses
      with a zod object), `report-blocks.test.ts` (the zod-shape reads annotate through
      `Record<string, {description?}>` — the shape carries the string index signature),
      `subagent-activity.test.ts` (`partOf` parses with a test-local frame schema — the maintainer's
      passthrough arm absorbs the `data-subagent-activity` literal, so no discriminant narrows).
    - app: `chat-turn.test.ts` (`toolResultParts` helper over a role guard + known-union filter; the
      excerpt read takes a literal-arm guard), `approve-plan.test.ts` (the complete RunSession literal —
      the workflows-test shape — replaces `{} as never`; the event read takes a discriminant guard),
      `synthesize-run.test.ts` (`validSynthesisPayload` returns `RunSynthesis`, so the mutation cast
      dies; the emitted read takes the `in`-guard), `report-session-runtime.test.ts`
      (`parseUnknownRecord` on the snapshot column).
    - tools core: `read-tool-output.test.ts` (the `read` helper returns through `parseUnknownRecord`;
      `isUnknownArray`/`typeof` guards on the matches and text reads), `define-tool.test.ts`
      (`parseUnknownRecord` on the jsonSchema properties), `execute-analysis.test.ts` (the dead
      `ExecuteAnalysisInput` import removed — the last group's leftover), workspace `read-file`/`grep`/
      `execute-command` (instanceof guard with `cause`, direct `jsonSchema.type` reads, the
      `isUnknownArray` guard on `unvetted_edits`).
- Gates: `bun run typecheck` passes. Tests of every changed file pass: providers 210/0 (openai-arm red
  once — my first body schema made `input[].type` required; corrected to optional per the original type
  and re-run green per the re-run-once rule), memory+contracts 582/0, app 175/0, tools 1567/0 after the
  describe-call revert below. `bun run format:file` ran on every changed file.
- MEASURED BLOCKER — `describe-call.test.ts:35` `const unused = {} as never` (1 site, 2 report lines):
  one `never`-typed dep bag feeds 15 tool factories whose deps types share no member, and `describeCall`
  never drives any of them. `declare const unused: never` is the only cast-free never inhabitant, and it
  MEASURED WRONG: the erased binding is a ReferenceError at every construction — the factories need a
  runtime value. The lawful closes are (a) one complete "not driven" double per dep family (queriers,
  fs seam, mutator, embedding, citation resolver, working-memory store, pg Pool, sandbox client — the
  D3 builder sweep), or (b) a maintainer-sanctioned escape for the site. Reverted to the original line;
  not attempted (a) inside this run's budget.
- Non-#707 drift for the coordinator:
    - `define-tool.ts:207` and `:298` — `no-explicit-any` on the ruled constraint
      `Schema extends z.ZodType<any, unknown>` (the second run's maintainer ruling). MEASURED: `unknown`
      in the slot fails `tsc` (TS2322 — the Tool inputSchema assignment), so the `any` is load-bearing.
      A cast-free close needs a lint-config exemption for the two constraint slots or a zod-exported
      alias; both are config/library decisions, not test fixes.
    - `inspect-data-profile.test.ts:167/181/302` — `no-unsafe-assignment` on three `const x: Record<string,
unknown> = JSON.parse(...)` annotations the SECOND run's fixes introduced. The device that closes
      them is the same `parseUnknownRecord` route this run used elsewhere; the file is on the remaining
      worklist.
- Remaining worklist (110 report lines): the lib fixtures tests (cbioportal 8, ctx-ops 6, impc 4,
  fixture-runner 4, web-search.fixtures 4, bgee/disgenet/string/uniprot 2 each), the bio tests
  (search-regulatory-approvals 9, search-patents 9, preclinical 6, target-safety 4, search-protein/
  opentargets/comptox/chembl-tool 2 each), the research tests (web-fetch 11, misc-tools 4, pdf-parse/
  literature-reviewer/generate-analogy-report/web-search 2 each, search-github-repos 1),
  `authoring-tools.test.ts` 6, `knowledge/client.test.ts` 6, `preview-report.test.ts` 2,
  `describe-call.test.ts` 2. The recurring shapes: `JSON.parse(...) as {fixture shape}` (per-shape zod
  or parseUnknownRecord), `as typeof fetch` fetch doubles (the fetchDouble + real-Response device),
  `from any` casts on client reads (container parses), `as never` identity/toEqual sites (unknown
  binding or narrow annotation), and rule-1-only widening casts (annotation or the SAFETY escape).
- #706 drift: no `!` added. #709 drift: no new predicate over `unknown` — the new helpers
  (`sumOf`, `toolResultParts`, `chatProviderDouble`, `partOf`) return values; the one filter predicate
  (`part is ToolResultPart`) narrows the known ai-sdk part union, the sanctioned isProviderError shape.

## Group 7 record (task 7.1, fourth run, 2026-10-25 — the remaining 113 test lines closed; the two define-tool `no-explicit-any` lines closed too by the F-bounded constraint; all five directories at ZERO from the three rules)

- Start of run (live): 115 report lines from the three rules in the five directories (113 in test
  files plus the two `no-explicit-any` lines on `define-tool.ts`). End of run: 0. Task 7.1 gate:
  `bun --bun oxlint src/tools src/memory src/providers src/app src/contracts` reports zero from the
  three rules AND zero from every other rule (the on-rule regression check), exit 0.
- BLOCKER 1 CLOSED — `define-tool.ts:207/:298`: the constraint is now
  `Schema extends z.ZodType<z.output<Schema>, unknown>` (F-bounded, on `ToolDefinition` and
  `defineTool`) — a variance-safe form, no `any`, no cast, no directive. `bun run typecheck`
  passes with the whole suite against it. The run-3 measurement (`unknown` in the slot fails
  TS2322) still holds for the plain form; the F-bounded form keeps `Schema`'s output tied to the
  constraint, so the `Tool<z.infer<Schema>, Output>` construction typechecks.
- BLOCKER 2 CLOSED — `describe-call.test.ts`: the `{} as never` dep bag is replaced by modeled
  doubles per dep family: the established builders (`makeFakeWorkspaceFs`, `makeFakeSandboxClient`,
  `makeFakeChatProvider` from `src/agents/sandbox/__fixtures__/deps.ts`), `new Pool()` for pg, the
  structural empty querier for the four query seams, `createLocalRunAuthorizer()`, and
  not-driven doubles whose members throw (`refuse(...)`) for the working-memory store, citation
  resolver, embedding provider, run launcher, and workspace mutator. `createListAvailableRefsTool`
  and `createListAvailablePackagesTool` take `{}` (their dep fields are all optional).
- BLOCKER 3 CLOSED — `inspect-data-profile.test.ts:167/:181/:302`: the three annotated
  `JSON.parse` consts read through a file-local `wireOf` helper over `parseUnknownRecord`
  (a failed serialization fails the test; no `!` added).
- Closed by file (all at zero from the three rules):
  - lib fixtures: cbioportal 8 → 0 (an `oracleDefinition` accessor over an openapi zod schema, a
    container `z.array(z.record(...))` for the raw wire walk), ctx-ops 6 → 0 (the excerpt oracle
    parses with a zod schema; `hitc` parses with its own two-field schema), impc 4 → 0
    (`SolrEnvelopeSchema`), fixture-runner 4 → 0, web-search.fixtures 4 → 0, bgee/disgenet/string/
    uniprot 2 → 0 each.
  - bio tests: search-regulatory-approvals 9 → 0 and search-patents 9 → 0 (the `fetchDouble`
    device for each `as typeof fetch`, the `JSON.parse` body passed directly into the `unknown`
    field, per-fixture zod schemas — `looseObject` where the fixture rides onward to the tool, so
    no field the tool's schema reads is stripped), preclinical 6 → 0 and comptox 2 → 0
    (`fetchDouble`), target-safety 4 → 0 and opentargets 2 → 0 (the GraphQL body parses with
    per-shape zod schemas), search-protein 2 → 0, chembl-tool 2 → 0 (see the measured wall below).
  - research tests: web-fetch 11 → 0 (the two dead `as WebFetchOutput`-shaped widenings deleted;
    `server.address()` narrows with a `typeof` guard; the read-tool-output page reads go through
    `parseUnknownRecord` and the erased `Tool`'s `unknown` input — both per-line casts died),
    misc-tools 4 → 0 (`in`-guard if-throw on `runs` and on `elapsedMs` — `inspectionState` is on
    BOTH arms and narrows nothing), web-search 2 → 0, pdf-parse 2 → 0, literature-reviewer
    2 → 0, generate-analogy-report 2 → 0, search-github-repos 1 → 0 (dead widenings deleted —
    the concrete tools' `execute` types carry the output), inspect-data-profile 3 → 0.
  - tools core: authoring-tools 6 → 0 (the change_block literal parses through the tool's own
    `inputSchema.parse` — the safeParse-plus-cast dance dies with the ruling; `detailOf` is
    generic over the hook input, so the `as never` call cast dies), preview-report 2 → 0 (the
    emitted event parses with a zod shape), knowledge/client 6 → 0 (`parseUnknownRecord` on the
    captured POST body; `z.object({ situation: SituationFieldsSchema })` and a two-field schema
    for the recommend/render reads).
- MEASURED WALL — `chembl-tool.test.ts` `resultKey`: the generic correlated pair
  `(out: ChemblOutput, key: K)` cannot be implemented cast-free (TS 4.6 dependent-parameter
  narrowing does not apply: `Extract<ChemblOutput, Record<K, unknown>>` defers per-arm, so
  `out[key]` is never assignable to `RecordsFor<K>`; measured TS2322/TS2536 on four shapes). The
  close is an overload per literal key with a five-arm switch body of `in`-guards; the 16 call
  sites keep their literal keys and their precise return types.
- Gates: `bun run typecheck` passes. Tests of the changed files: 456 pass / 0 fail (lib fixture
  tests + describe-call + six bio files), 218 pass / 0 fail (nine research/app files),
  search-regulatory-approvals 22/0, inspect-data-profile 31/0 (container run). One red re-run:
  the first cut of the two regulatory zod reads used plain `z.object`, whose parse stripped the
  `input` and section fields the fixture then serves to the tool — corrected to `looseObject`
  and re-run green, per the re-run-once rule. `bun run format:file` ran on the changed files.
- #706 drift: no `!` added anywhere. #709 drift: no new predicate over `unknown` — every new
  helper returns a value (`oracleDefinition`, `wireOf`, `fetchDouble`, `refuse`) and every
  narrowing is an `in`/`typeof` guard inside its test. `satisfies` appears once, on the
  `web-search.test.ts` `it.each` table (the `as [WebSearchEngineError][]` table cast), which the
  require-assertion-safety rule does not report.

## Group 8 record (task 8.1, first run, 2026-10-25 — PARTIAL: 201 of 541 report lines closed; the tool budget closed the run)

- Start of run (live): 541 report lines from the three rules, all in test files (no-double-cast already at
  zero from group 5). End of run: 340 lines stand; the changed files are at zero from the three rules AND
  from every other rule. Task 8.1 stays open.
- Closed this run, by file (each at zero from the three rules):
    - `execution/test/run-synthesis.test.ts` (60 → 0) with two type-level production edits: the inner-tool
      builders of `run-synthesis.ts` declare their concrete tools (`buildValidateTool`, `buildSubmitTool`,
      `buildBlockerTool`, and the `__buildInnerToolsForTest` return type), `ValidationIssue`/
      `SubmitSynthesisOutput` are exported types beside the module, and a new
      `ValidateSynthesisOutput` names the validate arm pair; `createReportBlockerToolFor`
      (`tools/sandbox/report-blocker.ts`) declares `Tool<z.infer<typeof ReportBlockerInputSchema>,
      { recorded: true; message: string }>`. Zero runtime change. The test drops every
      `validSynthesisPayload() as {...}` cast (`validSynthesisPayload(): RunSynthesis`; the two
      `delete <required field>` sites override with `{ ...payload, field: undefined }` — zod reads the
      required-string absence identically), drops every `_unsafeUnwrap() as {...}` ok-read, narrows the
      three rejected-submission reads with `if (!("issues" in result)) throw`, reads the written JSON
      through `parseUnknownRecord`, and swaps the `toEqual(... as never)` for a guarded
      `expect(flattenDataPart(...)).toEqual(part)` (z.infer aliases carry an implicit index signature, so
      the swap typechecks without the cast).
    - `runtime/test/assemble.test.ts` (66 → 0): the roster-tool outcome reads go through a file-local
      `z.looseObject({ outcome: z.string() })` parse (the tests read `.outcome` only); the `{} as X` dep
      bags became modeled doubles — `new Pool()`, `unusedChatProvider()`, `makeFakeWorkspaceFs()`,
      `createLocalRunAuthorizer()`, refuse-throwing doubles for the store/thread-title/derivation seams,
      annotated `executeAnalysisWorkflow` — and the construction-only workflow bags moved to the new
      shared fixture `src/runtime/__fixtures__/construction-core.ts`
      (`constructionWorkflows()` + `refuseEmbedding()`/`refuseRunLauncher()`/`refuse`).
    - `workflows/test/execute-analysis.test.ts` (28 → 0): the DBOS static patches
      (`(dbos.DBOS.runStep as unknown) = mock(...)` family, 8 sites) became
      `Reflect.set(dbos.DBOS, "<name>", mock(...))` with the same save/restore bracket; the writeStream
      push parses through `parseUnknownRecord` (a non-record write is dropped at the fake — disclosed);
      the dag/terminal part reads ride two file-local zod accessors (`dagStatesOf`, `terminalOf`) whose
      parse fails the test on a drifted shape; the error-text read takes the `typeof` if-throw.
    - `workflows/test/sandbox-step.test.ts` (24 → 0): the same Reflect.set family (5 sites), both
      writeStream fakes parse through `parseUnknownRecord`, `foldStream` narrows `type`/`id` with
      `typeof` + the exported `isKnownPartType` registry gate (an unknown type string now folds as
      non-reconciling where the old cast trusted `PART_REGISTRY[type]` — disclosed), the embedding and
      artifactRegistry literals satisfy their interfaces directly, `workspaceFs` rides
      `makeFakeWorkspaceFs()`, and the excerpt output reads take the `type !== "text" | "json"` if-throw.
    - `workflows/test/step-seed.test.ts` (4 → 0): the querier `values` reads take the `typeof`
      if-throw.
    - `workflows/test/execute-analysis-scheduler.test.ts` (4 → 0) and the two
      `workflows/__tests__/dbos` files (4 → 0): instanceof-guard if-throw on the caught errors; the
      `statusCode` mint rides an `Error & { statusCode?: number }` annotation.
    - `runtime/test/boot.test.ts` (5 → 0): the `core` bag rides `constructionWorkflows()` + the
      conversation construction bag; `DbosConfig` literals are complete (the cast claimed fields the
      object did not carry); `connectionBudget: {}` satisfies the optional-field config directly.
    - `runtime/test/dbos.test.ts` (6 → 0): the stub `DbosConfig` is complete; the shutdown patches use
      `Reflect.set`; the `span as never` became a complete `DBOSSpan` literal whose chain methods return
      the span.
    - `assemble.test.ts`'s builder extraction is shared with `boot.test.ts` through the fixture (one
      definition, two consumers).
- Gates at the close: `bun run typecheck` passes (0 errors). `bun --bun oxlint` full run: 340 report
  lines stand, ALL in test files of the group-8 directories still open (loop 112, execution 53, sandbox
  48, tasks 32, agents 32, report-model 21, lib 14, prompts 10, state 8, setup 4, workspace 2,
  input-scan 2) — zero from every rule in non-test files and in every closed file. Tests of every
  changed file pass: run-synthesis 36/0, boot + dbos green, assemble + the six workflows suites 184
  pass / 1 fail where the one red (`suspension-cascade` "a suspension preserves pending rows") passed on
  the immediate re-run (the design's re-run-once rule; the edit in that file is the type-level
  `statusCode` annotation, off the failure path). `bun run format:file` ran on every changed file (all
  unchanged). No `!` added, no lint directive, no `as const` needed, no new cast anywhere; the run's
  only new file is the construction-core fixture.
- MEASURED WALL for the coordinator — the generic RunStep replay/memo sites (5 report lines, left
  standing): `run-agent.test.ts:254` (`cache.get(name) as T` in `cachingStep`), `:1061`
  (`step.value as T` in the recorder's `replay`), `:1918-1921` (the `replayBareResult` pair),
  `metrics.test.ts:215` (`stored.get(name) as T`), `usage-accounting.test.ts:69` (same memo shape). The
  erased value is `unknown`; the return must satisfy an abstract `T` the replay cannot name; TS 4.6
  dependent-parameter narrowing does not apply and the test cannot enumerate the step names (the
  callers are the loop's own dispatch sites, unlike the chembl per-key case). Lawful closes are a
  maintainer decision: a typed replay seam on `RunStep` (production surface), or a sanctioned escape
  for these five sites.
- Remaining worklist (340 report lines, all file-local devices this run already proved): the
  `toolResultParts` role-guard + known-union filter for the `m.content as ToolResultPart[]` family
  (run-agent, tool-output, run-to-terminal); `as EmitEvent` push sites widen the captured array to
  `Parameters<EmitFn>[0][]` + a filter predicate at the return; the `"off" as PromptCachePolicy` casts
  of prompt-cache.test are DELETIONS (`"off"` assigns to the `PromptCachePolicy` union directly); the
  otel metric reads narrow with `typeof` on the dataPoint value; `{} as ToolContext` sites ride
  `makeToolContext()`; the `{} as never` dep stubs of tasks/agents/prompts/input-scan/state ride the
  established builders (`makeFakeSandboxClient`, `unusedChatProvider`, refuse doubles, the structural
  empty querier, the complete AgentSession literal); `new Error(...) as Error & { statusCode }` sites
  ride `Object.assign(new Error(...), { statusCode })`; `{ ... } as ChatPart` constructions become
  annotated consts; report-model production-resolver's `_unsafeUnwrap() as { rows: Row[] }` takes the
  `"rows" in value` if-throw; and the per-file contexts for the rest are in the run transcript.

## Group 8 record (task 8.1, second run, 2026-10-25 — PARTIAL: 116 of 340 standing report lines closed; the wall-clock budget closed the run)

- Start of run (live): 340 report lines from the three rules, all in test files (no-double-cast at zero from
  group 5). End of run: 224 lines stand; every file this run touched is at ZERO from the three rules AND from
  every other rule (`bun --bun oxlint src/loop src/__tests__/setup` exits 0). Task 8.1 stays open.
- Closed this run: the whole `src/loop` test directory (112 lines) and `src/__tests__/setup/metrics.ts` (4).
- THE RUNSTEP MEMO FAMILY IS CLOSED (the five coordinator-named sites) — with a measured correction to the
  per-key overload device: an overloaded source assigns to the generic `RunStep` target ONLY when the double
  declares at least TWO overload declarations plus a separate implementation signature; the implementation
  signature itself never participates in the overload set (a single overload + impl = the failing plain
  form, measured TS2322 in metrics.test.ts on the first cut, fixed by adding the second overload and re-run).
  Probe kept at `tmp/pi/g8-probe-runstep.ts`. Applied shapes:
    - `run-agent.test.ts` `cachingStep` + `stepStore.replay`: overloads for the two step-value families —
      `LlmStepValue = Result<ChatResponse, ProviderError>` (what the loop's llm step body returns) and
      `ToolStepValue = { result: ToolResultPart; detail?: ToolCallDetail; record?: unknown } | ToolResultPart`
      (the loop's `DispatchedCall | ToolResultPart`, named structurally because `DispatchedCall` is
      module-local). The impl reads the memo as `unknown` with no assertion.
    - `run-agent.test.ts` `replayBareResult` (1918-1921): overload claims the bare `ToolResultPart` (what the
      replay returns); the impl reads `.result` through the `in`-guard narrowing — the two casts and the
      `as never` are gone, and the stale "cast restates the shape" comment went with them.
    - `metrics.test.ts` `replayingStep` and `usage-accounting.test.ts` `cachingStep`: the llm-family overload
      plus the impl-signature-shaped second overload `(name, fn: () => Promise<unknown>): Promise<unknown>`.
- Other devices applied in loop (all file-local, zero production edits this run):
    - `toolResultParts`/`onlyResult`/`errorText` and the inline tool-message reads: role guard (`m.role !==
      "tool"` if-throw), string-content guard, then the known-union filter `(part): part is ToolResultPart =>
      part.type === "tool-result"` — the ai-sdk tool content carries `ToolApprovalResponse` beside
      `ToolResultPart`, so the bare content read could not type (measured TS2339).
    - `assistant.content`/`userParts`: `typeof content === "string"` if-throw replaces the
      `Exclude<Extract<...>>` casts.
    - imaging/content-output and execution-denied reads: `output.type !== "<arm>"` if-throw; the content arm's
      `parts.find((p) => p.type === "text")` narrows through TS's inferred predicate, `undefined` if-throw.
    - `isLoopEvent` predicate over `Parameters<EmitFn>[0]` (exhaustive over `EmitEvent`'s four type strings):
      the four `events.push(e as EmitEvent)` sites became `if (isLoopEvent(e)) events.push(e)`. The `"source"
      in e` form was REJECTED as unsound — `ChatDataPart` carries an optional `source` (loop/types.ts:130).
    - `(events[0] as { detail?: string }).detail!` reads: direct `events[i]!.detail` + `undefined` if-throw
      (the detail field is declared optional on both tool-event arms).
    - `JSON.parse(JSON.stringify(request.messages)) as ModelMessage[]` → `[...structuredClone(request.messages)]`
      (the spread restores mutability the SENT record needs).
    - `compactionParts`: a file-local `compactionData` zod object parses `event.data` (the EmitFn union erases
      data to `unknown`); the parse strips no field the loop emits (the card's five fields are exactly the
      schema), so `toEqual` expectations are unchanged — disclosed for the D3 review.
    - prompt-cache: the five `"off" as PromptCachePolicy` casts DELETED (`"off"` is a member of the union);
      the two canned fetch doubles became the `fetchDouble` device (`Object.assign(run, { preconnect:
      fetch.preconnect })`, arrow annotated `Promise<Response>`); their body reads ride a module-local
      `seenBody` (parseUnknownRecord + if-throw); the wire reads parse with zod (`z.array(z.object({
      content: z.array(z.record(...)) }))` for messages, `z.array(z.record(...))` for the system prompt);
      `counterTotal` sums through an `unknown`-binding typeof guard (the otel `dp.value` is a union property,
      which filter's inferred predicate cannot narrow — measured TS2365).
    - metrics reads in metrics.test.ts and setup/metrics.ts: `unknown`-binding typeof guards for the sum reads;
      `in`-guard if-throw for the histogram `{count, sum}` reads; `captureMetrics().sums/histograms` skip a
      data point whose value is not the claimed shape where the old cast mislabeled it — delta confined to a
      mislabeled instrument (a test author error), disclosed for the D3 review.
    - run-step.test.ts: `Reflect.set(dbos.DBOS, "runStep", stub)` patches (the group-5 device) replace both
      `(dbos.DBOS.runStep as unknown) =` assignments.
    - logging/run-to-terminal `cell` fixtures: annotation `const cell: { value: string | null } = { value: null }`.
    - call-guard.test.ts `{} as ToolContext`: complete literal (invocationId, makeSession, signal, emit, a
      rejecting `ask` — the refuse-double device; the tests never call ask).
- Gates at the close: `bun run typecheck` passes (0 errors). `bun --bun oxlint src/loop src/__tests__/setup`
  exits 0 (zero from every rule). `bun test` over the ten changed loop test files: 264 pass / 0 fail (first
  run, no red container run). `bun test src/lib/test/metrics.test.ts` (the captureMetrics consumer): 5 pass /
  0 fail. `bun run format:file` ran on every changed file (metrics.ts reflowed only). No `!` added beyond the
  indexed-access reads the files already used (`content[0]!`, `events[0]!` — same style as the surrounding
  code), no lint directive, no new cast anywhere; the new type predicates (`isLoopEvent`, the tool-result
  filters) narrow KNOWN unions — the sanctioned shape, noted for the #709 ledger.
- REMAINING WORKLIST (224 report lines, 37 files — all in test files): agents/test/conversation-agent 18 and
  report-session-agent 14 (dep-bag casts → the established builders: `new Pool()`, `unusedChatProvider()`,
  `makeFakeWorkspaceFs()`, `createLocalRunAuthorizer()`, refuse doubles, the complete AgentSession literal —
  the run-1 record names each site's cast target); report-model/test/production-resolver 16 (the
  `_unsafeUnwrap() as { rows }` family → the `"rows" in value` if-throw) + reference-stamp 4 + draft-hash 1;
  execution 53: run-canceler 14 (the `as Row` reads → row-reader Querier or zod row parses), run-event-stream
  12 and step-summary 8 and run-event-parts 8 (union-arm in-guard if-throws), artifact-registration 6
  (AgentSession literal), post-step-pipeline 2 (AgentChat/ArtifactRegistry doubles), dbos-run-launcher 3;
  sandbox 48: exec 14 (fetch doubles + Response-header string reads), k8s-client 9, package-identity 6,
  docker-client 6 (the `Object.assign(new Error(...), { statusCode })` mint for the `Error & { statusCode }`
  sites), sandbox-step-translate 6, create-sandbox 4, image-packages 3; tasks 32: data-profile-activity 14,
  settle-notice 6, agent-deps 4, trigger/resolve/suspension/index 2 each; prompts 10 (briefing 6,
  data-profiler 4); state 8 (step-executions 4 + the two barrel files 2 each); lib 14 (result 4, otel 4,
  zod-issues 4, page-capture 2); workspace 2; input-scan 2. The devices for each shape are in the run-1
  record's remaining-worklist note and this run's applied set.

## Group 8 completion record (task 8.1, third run, 2026-10-25 — the final 224 report lines closed; task 8.1 marked done)

- Start of run (live): 224 report lines from the three rules, all in test files (the 225th grep hit was
  oxlint's summary line). End of run: ZERO from the three rules and ZERO from every other rule on a full
  `bun --bun oxlint`. Task 8.1 marked done. Task 9.1 (full-suite `bun test`, `bun run lint`,
  `bun run build`, the cli working-copy link, and the closing D4 residual list) stays open for the
  final-verification group.
- Closed this run, by file (device per site):
    - `agents/test/conversation-agent.test.ts` (18 → 0): the dep-bag casts became the established
      builders — `unusedChatProvider()` twice, `new Pool()`, a file-local `unusedEmbedding` literal,
      `makeFakeWorkspaceFs()`, `createLocalRunAuthorizer()`, annotated refuse arrows for
      `executeAnalysisWorkflow` and `anchorReportSession`, and a refuse double for `RunLauncher`.
    - `agents/test/report-session-agent.test.ts` (14 → 0): `new Pool()`, `makeFakeWorkspaceFs()`, and
      complete refuse doubles for the gateway, the version store, the thread pick, and the derivation pick.
    - `report-model/test/production-resolver.test.ts` (16 → 0): a file-local `tableOf` reads the ok
      channel through the `type !== "table"` if-throw (the seven `_unsafeUnwrap() as { rows }` reads).
    - `report-model/test/reference-stamp.test.ts` (4 → 0): the `field` walker reads through the
      `key in current` guard + `Reflect.get` — the zod record parse was REJECTED because zod drops the
      own `__proto__` key, which is the exact key the faithful-copy test guards; the `Object.hasOwn`
      read takes the typeof-narrowed `stamped`.
    - `report-model/test/draft-hash.test.ts` (1 → 0): the reordered literal is an annotated
      `DraftDocument` const.
    - `execution/test/run-canceler.test.ts` (14 → 0): the four `state.run as Row` spreads take the
      null if-throw; the ledger child takes the undefined if-throw; the `started_at` duration read is a
      two-sided typeof guard.
    - `execution/test/run-event-stream.test.ts` (12 → 0): a `StepSummaryPart` Extract alias plus type
      -predicate filters (`activitiesOf` already existed); the indexed and `.at(-1)` reads take `?.`.
    - `execution/test/run-event-parts.test.ts` (8 → 0): the maker functions take `StepPhase` parameters
      and the literals annotate `ChatPart` directly.
    - `execution/test/step-summary.test.ts` (8 → 0): a `lastTextOf` helper narrows the trailing message
      by the typeof of `content` (no role check — the artifact list rides a non-assistant message); the
      tool-result output reads take the `"value" in output` guard + typeof.
    - `execution/test/artifact-registration.test.ts` (6 → 0): the three `{} as AgentSession` sites ride
      the file-local complete `session` literal (the run-canceler device).
    - `execution/test/post-step-pipeline.test.ts` (4 → 0): `unusedChatProvider()` and a refuse double
      for `ArtifactRegistry` (register + sync).
    - `execution/test/dbos-run-launcher.test.ts` (3 → 0): the `startWorkflow` patches are `Reflect.set`
      (the group-5 device).
    - `sandbox/test/exec.test.ts` (14 → 0): the fetch doubles are annotated arrows plus
      `Object.assign(double, { preconnect: fetch.preconnect })` (Node's `typeof fetch` carries
      `preconnect`); the three body reads ride a `seenBody` helper (typeof + `parseUnknownRecord`).
    - `sandbox/test/k8s-client.test.ts` (9 → 0): the two `Error & { code }` mints are
      `Object.assign(new Error(...), { code })`; `stubApis`/`pendingPod` take `V1Pod[]`/`V1Pod` (every
      V1Pod member is optional, so the Partials and the `as V1Pod` drops drop); the ownerless job is an
      annotated `V1Job` const; the `waitedMs` read is a typeof guard.
    - `sandbox/test/package-identity.test.ts` (6 → 0): the JSON fixture parses through a file-local zod
      schema (FixtureTrack/FixtureQuery), so the `as PackageQuery` and `as Track` reads drop.
    - `sandbox/test/docker-client.test.ts` (6 → 0): the three `Error & { statusCode }` mints are
      `Object.assign(new Error(...), { statusCode })`.
    - `sandbox/test/create-sandbox.test.ts` (4 → 0): the label-hook `seen` array is `RunSession[]` (the
      hook's own parameter type), and the thrown read takes the instanceof guard.
    - `sandbox/test/image-packages.test.ts` (3 → 0): the parsed-data reads drop the casts
      (`toHaveProperty` reads the typed zod output directly).
    - `sandbox/test/sandbox-step-translate.test.ts` (6 → 0): the `{} as never` tool deps ride the
      notDrivenMutator literal and `makeFakeWorkspaceFs()`.
    - `tasks/test/data-profile-activity.test.ts` (14 → 0): `Recorded` became `z.infer` of a file-local
      schema and each emitter write parses the `unknown` part; the tool deps ride `makeFakeSandboxClient()`,
      a complete `SandboxRef` literal, `makeFakeWorkspaceFs()`, and the notDrivenMutator device.
    - `tasks/test/data-profile-agent-deps.test.ts` (4 → 0): `createLocalRunAuthorizer()` and a
      file-local `unusedEmbedding`.
    - `tasks/test/data-profile-settle-notice.test.ts` (6 → 0): `unusedChatProvider()` and the stamped-time
      reads take the typeof guard.
    - `tasks/test/data-profile-suspension.test.ts` (2 → 0): `unusedChatProvider()`.
    - `tasks/test/data-profile.trigger.test.ts` (2 → 0): `legacyStagedInput` declares `SignableInput`
      (the production input of `computeInputSignature`), so the legacy shape types without the cast.
    - `tasks/test/data-profile-index.test.ts` (2 → 0): the metadata-path read takes the typeof guard.
    - `tasks/test/data-profile-resolve.test.ts` (2 → 0): the deliberately malformed submission is built
      inline for `safeParse(unknown)` — the `submission` overload set stays untouched (a loosened second
      overload broke the valid call sites' resolution).
    - `state/test/step-executions.test.ts` (4 → 0): `makeToolContext()` for the tool context and the
      `parseUnknownRecord` read of the blocker outcome.
    - `state/test/artifact-reads.barrel.test.ts` + `analysis-summary-reads.barrel.test.ts` (4 → 0):
      the structural empty querier (`Querier`-annotated, `query` throws).
    - `prompts/test/briefing.test.ts` (6 → 0): `Object.keys` needs no cast once the reads are string-
      sided; the overlap filter rides a `Set<string>`; the step copy annotates `Record<string, unknown>`
      and `base[field]` needs no cast at all (field is `keyof AnalysisStep`).
    - `prompts/sandbox/test/data-profiler.test.ts` (4 → 0): the JSON-schema walk parses each container
      with `z.record(z.string(), z.unknown())` (the two-argument form).
    - `lib/test/result.test.ts` (4 → 0): instanceof guards; the in-catch throw carries `{ cause: thrown }`
      (preserve-caught-error).
    - `lib/test/otel.test.ts` (4 → 0): the collector address takes the typeof/null guard; the OTLP body
      read walks `parseUnknownRecord` level by level (the `OtlpKeyValue` alias went with the cast).
    - `lib/test/zod-issues.test.ts` (4 → 0): a file-local `readPath` walker (`in` guard +
      `parseUnknownRecord`) reads the repaired payloads — a zod parse of the whole repair was REJECTED
      because the suite asserts the untouched branches are the same objects (`toBe`), which a parse clone
      would break.
    - `lib/test/page-capture.test.ts` (2 → 0): instanceof guard on the caught cause.
    - `workspace/test/filesystem.test.ts` (2 → 0): instanceof guard on `result.error.cause`.
    - `input-scan/test/enrich.test.ts` (2 → 0): the complete `AgentSession` literal.
- Gates at the close: full `bun --bun oxlint` exits 0 (zero from every rule, whole run);
  `bun run typecheck` passes (0 errors); `bun test` over the changed directories
  (agents, state, prompts, report-model, execution, sandbox, tasks, lib, workspace, input-scan,
  `__tests__/setup`) gives 1737 pass / 0 fail across 117 files; the re-run-once rule fired twice, both
  times on first-cut test edits of this run (step-summary's message/output narrowing, reference-stamp's
  zod-record walk) and both fixes re-ran green standalone. `bun run format:file` ran on every changed
  file (three execution files reflowed only). No `!` added, no lint directive, no `as const` needed, no
  new cast anywhere; the new file-local type predicates and zod schemas narrow known shapes only.
- For the 9.1 record: the `preserve-caught-error` rule requires `{ cause }` on a re-throw inside a catch
  (result.test.ts). Node's `typeof fetch` carries `preconnect`, so a fetch double needs the
  `Object.assign(double, { preconnect: fetch.preconnect })` attachment to satisfy the deps type.

## Final verification record (task 9.1, 2026-10-25 — all gates measured on the final tree)

- `bun run format:file` ran on every changed `src/` file in both subsystems (359 harness, 8 cli; every
  file unchanged, before and after this group's one edit). `scripts/refresh-fixtures.ts` is outside the
  formatter's `src/` scope and stayed untouched.
- `bun run lint` (the full `bun --bun oxlint`): ZERO reports from EVERY rule, exit 0. Final per-rule
  counts: `@inflexa-ai/require-assertion-safety` 0, `typescript/no-unsafe-type-assertion` 0,
  `@inflexa-ai/no-double-cast` 0. `bun run typecheck` passes (0 errors). Both re-ran green AFTER this
  group's one test edit, so the certification is of the final tree.
- FULL `bun test` (harness): 6116 pass / 0 fail / 51 skip across 358 files, 29178 expect calls, exit 0.
  The gate did NOT go green on the first run: run 1 gave 6115 pass / 1 fail and the design's one re-run
  (run 2) repeated the same single failure — `executeAnalysis body > a suspension preserves pending
  rows (no sweep), and dooms no dependent`, `src/workflows/test/execute-analysis.test.ts:1575`, a
  ZodError from the `dagStatesOf` read (`Invalid input: expected "data-dag-state"`, `steps` undefined).
  Root cause, verified against HEAD: the baseline read was
  `[...record.emittedParts].reverse().find((p) => p.type === "data-dag-state") as {...}`, which skips
  non-dag-state parts; the group-8 edit replaced it with
  `dagStatesOf([...record.emittedParts].reverse()).find(...)`, whose parse runs over EVERY part — so
  any non-dag-state part in the suspension path's stream throws before `.find()` runs. The six sibling
  call sites filter first; this one site lost the filter. A branch-introduced test regression, not a
  container cold-start flake and not a production defect. REPAIR APPLIED by this group (disclosed; a
  one-line test edit restoring the baseline read semantics with the file's own sibling shape):
  `dagStatesOf(record.emittedParts.filter((p) => p.type === "data-dag-state")).at(-1)` — same last
  dag-state part, cast-free, lint-clean, and order-tolerant, so the emit-order race cannot fail it.
  After the repair: the file passed 3 consecutive standalone runs, and full `bun test` (run 3) is the
  6116/0 green above. `bun run build` passes (fresh dist).
- cli working-copy link: `cd ../cli && bun run harness:local` OK (it rebuilds the harness dist and
  re-points the symlink; `npm install` in cli restores the pin). `bun run typecheck` in cli FAILS with
  2 errors, both branch-caused and both OUTSIDE the maintainer-authorized cli edit set — recorded, not
  fixed, routed to the supervisor:
    - `cli/src/modules/harness/inflexa_tool.test.ts:722` — TS2322 `string | undefined` not assignable
      to `string`: the helper declares `: string` and returns `tool.describeCall!(input)`.
    - `cli/src/modules/harness/inputs_tool.test.ts:191` — the same shape for `manage_inputs`.
    Cause: the group-5 sixth-run seam widening made `Tool.describeCall` return `string | undefined`
    (`define-tool.ts:196/:244`; baseline HEAD: `:190/:238` returned `string`). No cli gate ran after
    that run, so the fallout lands here, as the standing cross-stack requirement anticipated. The
    cli-side close is a guard-plus-throw or a widened helper return in the two test helpers — a
    maintainer decision, since no cli edit beyond the authorized set is permitted.
- cli TESTS (the maintainer's standing cross-stack requirement): full `bun test` in cli, run twice per
  the re-run rule; both runs identical — 4126 pass / 2 skip / 5 fail across 218 files, exit 1. The 5
  counted failures, none of them caused by this change:
    - `cli/src/modules/prov/prov.test.ts:213`, `:356`, `:616`, `:703` — four
      `expect(unified.equals(parsed)).toBe(true)` PROV-JSON round-trip failures. Deterministic (they
      reproduce in a standalone file run). The file imports `@inflexa-ai/tsprov` (the npm-pinned
      0.5.1 install — a real directory, not the working-copy link) and cli-local modules; it imports
      NO harness symbol, and the file is unmodified on this branch. The local `prov-kernel/` working
      copy is clean. Independent of the harness link and of this change; the owner is the prov issue.
    - `cli/src/modules/libs/composition.test.ts:1130` (thrown at `composeWithProvisioner`, test at
      `:1156`) — the test's own precondition guard: the Python `packaging` module is missing from the
      `python3` on PATH. Environmental; the guard's message carries the fix
      (`python3 -m pip install packaging`).
- The closing D4 residual list over `src/` and `scripts/` (non-test AND test alike, excluding
  `as const`), enumerated with the TypeScript AST over every `.ts`/`.tsx` file (AsExpression nodes plus
  the angle-bracket `TypeAssertionExpression` form — not a text scan; a text scan's 2600+ raw `as` hits
  are comment prose, destructure renames, import aliases, and `as const`):
    - `src/auth/local-auth-context.ts:23` — `{} as AuthContext` — SAFETY above the statement
      (`:20`-`:22`): the auth brand is an optional phantom with no runtime member, so the empty literal
      carries every real field the interface holds; no caller may mint one outside this constructor.
      Rule-1-only (rule 2 passes: the assertion widens). The cast is pre-existing at HEAD; this change
      added the SAFETY comment.
    - `scripts/`: zero surviving `as` assertions.
  That is the COMPLETE list — the tree holds exactly ONE `as` assertion outside `as const`. Each
  survivor passes the type-aware rule: `bun run lint` is green, and `typescript/no-unsafe-type-assertion`
  is one of the rules it runs, so the single survivor's widening assertion reports nothing (state here
  per the task; rule 2 has no comment escape, so a green lint is the proof).
- Diff verified against the baseline commit (read-only `git diff HEAD` over `harness/src` and
  `harness/scripts`; the cli diff checked separately):
    - Added non-null `!`: 31 lines, all indexed/destructured element reads. 29 sit in test files — the
      sanctioned D2 test-construction form the earlier groups recorded (`content[0]!`, `events[0]!`,
      the surrounding-code style). 2 sit in production `src/lib/zod-issues.ts:277` and `:283`
      (`key!` on the destructured `const [key, ...rest] = path`, guarded by the `path.length === 0`
      early return above) — the same element-read form in a file group 3 rewrote; recorded here as the
      only `!` additions outside test files. Removed: 34 lines with a non-null `!` (net −3).
    - Added `@ts-expect-error` / `@ts-ignore` / `@ts-nocheck` / lint directives: ZERO. Removed: 2 —
      the `validity.test.ts` `@ts-expect-error` (replaced by the new `csstree-validator.d.ts`, the
      item-0 record) and the `package-identity.test.ts` brand-mint `@ts-expect-error` (deleted with
      the brand ruling's test). Both pre-existing; nothing added.
    - Every remaining `as` is on the D4 list: the one site above. `as const` added: 23 lines (excluded
      from the sweep by design; `as const` carries no invariant and reports nothing).
    - cli diff: 0 added `!`, 0 added directives.
- Count drift noticed under rules of other children of #607, for the owning issues:
    - #706 (`!` family): the diff removes 34 non-null assertions and adds 31 (net −3); the 2 production
      additions are the guard-backed `key!` element reads of `zod-issues.ts` named above. No
      unnecessary-assertion pattern added.
    - #709 (`no-typeof-object`): 84 `typeof x ===/!== "object"` probes removed, 21 added (net −63).
      The additions are the in-guard object checks that replaced casts (the recorded group 2/3/8
      pattern: `typeof v !== "object" || v === null || !("k" in v)`), so the rule's population drops.
    - #709 (`no-unknown-type-guards`): 22 predicates added by the diff; 19 narrow KNOWN unions by
      discriminant (the sanctioned `isProviderError` shape — `part is ToolResultPart` filters,
      `StepSummaryPart` extracts, `isKnownPartFrame`, `isPartFrame`). The 3 that touch unknown-ish
      parameters are exactly the ledger entries already recorded: `isChatPartRecord`
      (`Record<string, unknown>`, the group-3 ledger entry) and the two test-side `isRecord(value:
      unknown)` walkers (render.test, table-data.test — the group-6 disclosure, no-copy property
      load-bearing for the `__proto__` fixtures).
    - `no-explicit-any` and the unsafe-family rules outside the three: 0 added `any` anywhere in the
      diff; full lint reports zero from every rule, so no non-#707 rule drifted upward.

## Gate record: the cli helper-return authorization applied (2026-10-25)

- Applied, exactly the authorized edit set and nothing else in cli:
    - `cli/src/modules/harness/inflexa_tool.test.ts:719` — the `run_inflexa` describeCall wrapper's
      return annotation widened `string` → `string | undefined` (the coordinator's reference said :720;
      :719 is the line in the current tree).
    - `cli/src/modules/harness/inputs_tool.test.ts:189` — the same widening on the `manage_inputs`
      wrapper.
- These are the two TS2322 sites the previous run recorded (722/191 under the pre-edit line numbering);
  both errors are gone.
- Gates:
    - harness `bun run lint` — exit 0.
    - harness `bun run typecheck` — exit 0.
    - harness `bun run build` — exit 0; run BEFORE the cli gates so they measure the fresh dist, per
      the stale-dist lesson in the group 3 record.
    - cli `bun test src/modules/harness/inflexa_tool.test.ts src/modules/harness/inputs_tool.test.ts`
      — 71 pass / 0 fail (258 expect() calls), exit 0.
    - cli `bun run typecheck` — exit 2, ONE error (was 2):
      `src/modules/harness/inputs_tool.test.ts(215,20)` TS2488, `Type 'string | undefined' must have a
      '[Symbol.iterator]()' method`. The inflexa_tool file compiles clean under its widened return (its
      wrapper result is only read through `toBe` comparisons).
- OPEN for the next ruling: the gate "cli typecheck passes (0 errors)" and the constraint "nothing else
  in cli" cannot both hold under the authorized widening alone. The widened helper return makes the
  spread at `inputs_tool.test.ts:215` (`[...describeCall({ action: "add", paths: [atCap] })]`) illegal —
  new fallout of this authorization, not pre-existing (the old `: string` annotation spread a `string`).
  The site is the at-cap boundary assertion, reached only with input where the hook provably returns a
  line. Close options, in the order they keep the honest signature: a local `!== undefined` guard
  feeding the spread; `describeCall(...)?.length` (moves the count from code points to UTF-16 units —
  the same value here, the string is ASCII); a non-null `!` on the call (the sanctioned
  test-construction form, but the first `!` added to the cli diff, which the records above track at 0).
  None was applied: the authorization permits no cli edit beyond the two annotation lines.
- CLOSED (follow-up ruling): the :215 fallout applied the caller-side absent-value form — the spread now reads `[...(describeCall({ action: "add", paths: [atCap] }) ?? "")]` — and every gate passes: cli `bun run typecheck` exit 0, cli tests 71 pass / 0 fail, harness `bun run lint` exit 0, harness `bun run typecheck` exit 0.

## Implementation-review corrections record (coordinator, 2026-10-25)

Artifact corrections applied by the coordinator after the four implementation reviews (two viv-issue-reviewer runs, codex, claude):
- release-note.md now lists every public-surface change the reviews found missing: the BREAKING AiSdkProviderConfig.fetch retype (FetchLike -> typeof fetch, with the Object.assign preconnect recipe), the ChatPart/MessagePart passthrough widening, AgentFinish.reason (string & {}), CreateThreadInput.type, the structural ThreadStorePool of createThreadStore, the dimensionScope widening, and the ReportSnapshot.rows/UnresolvedReference.reference widenings. The passthrough record's type is corrected to `data-${string}`; the guard is named (isKnownPartFrame); the three prose semicolons are gone.
- proposal.md Impact now states the @types/json-schema devDependency pin (was "No dependency change").
- design.md D5 and tasks.md 9.1 are amended to the recorded `!` forms: the two guarded production element reads (src/lib/zod-issues.ts, behind the path-length check) and the test-side same-expression construction reads, counted for #706. The final count is 33 added `!` (31 test + 2 production), not 31 — corrected here.
- D3 disclosures added for the two micro-deltas the reviews surfaced: snapshotRows drops a null cell (a column with only null cells reads as absent to columnsHeldByNoRow — fixture path only, the resolver refuses before the row read on the production path), and flattenDataPart now parses part.data through the record schema, so a non-record payload yields {} where the old spread of a string produced index keys (unreachable for contract-built payloads).
- harness/tmp6.txt (stray report-render worklist scratch) removed.

Code corrections (behavior-critical findings from codex and claude) go to the implementor correction round: the errors.ts probe order, the reference-resolver safeParse channel, the csstree d.ts git-ignore trap, the isKnownPartFrame invariant comment, the __proto__-safe row copy, and the unknown-part passthrough reference identity.

## Implementation-review correction record (implementor, 2026-10-25)

The six code corrections from the four implementation reviews are applied. Gates after the fixes:
harness `bun run lint` exit 0 (zero from every rule), `bun run typecheck` exit 0, and the full
`bun test` gives 6124 pass / 0 fail / 51 skip on the first pass (the container-gated DB files skip
as before the correction, so the re-run-once rule for a red run did not fire). `bun run format:file`
ran on each changed file.

1. CRITICAL (claude) — the csstree d.ts clean-checkout trap.
   - Finding: `src/report-render/test/csstree-validator.d.ts` matches the root `.gitignore` rule
     `harness/src/**/*.d.ts` and was never tracked, while `validity.test.ts` no longer carries an
     escape, so a clean checkout fails the typecheck. Reproduced before the fix: the file moved aside,
     and the typecheck gave TS7016 at the import.
   - Fix, with a disclosed deviation from the prescribed shape: the prescribed `declare module
     "csstree-validator" {}` block cannot live in the test file — inside a module file that block is
     an augmentation, and TS2665 refuses to augment an untyped module (probed in isolation). The
     declaration stays file-local by another route: the module loads through `createRequire` (the
     idiom of `src/report-render/asset-lookup.ts`), rides as `unknown`, and `validateCss` names the
     member it calls before the call. The d.ts is deleted. `.gitignore` is untouched; no new file.
   - Files: `src/report-render/test/validity.test.ts:27-35` (the load and the constraint comment),
     `:43` (the callable guard).
   - Test: the validity gate passes (5 tests), and `bun run typecheck` is green with the d.ts gone.

2. CRITICAL (codex) — the probe order in the cause-chain walk.
   - Finding: `findInCauseChain` probed a link before the object check, so a primitive on the cause
     chain (a thrown string, a wrapped number) raised TypeError out of `classifyProviderError`
     through the `in` probes of the status, body, timeout, suspension, and connection walkers.
     Reproduced with the old order in isolation: `TypeError: cursor is not an Object`.
   - Fix: the object check moved before the probe. The function's doc comment already stated the
     post-fix invariant ("each probe receives a link that the walk verified to be an object"), so no
     comment changed.
   - File: `src/providers/errors.ts:259-267`.
   - Test: `src/providers/test/errors.test.ts:35` — a thrown string and a primitive cause classify as
     non-retryable provider errors instead of raising.

3. CRITICAL (codex) — a malformed row threw out of the resolver.
   - Finding: `snapshotRows` parsed with `.parse()`, so a malformed cell raised ZodError through the
     fixture resolver and the structural tier, past the seam contract that resolution never throws.
   - Fix (design D3): `snapshotRows` returns `Result<Array<Record<string, string | number>>, string>`.
     A rows value that is not a list, an entry that is not a record, and a cell that is neither a
     string nor a number refuse through the Err channel. Each caller routes the refusal through its
     existing `fail(reference, "unreadable-artifact", detail)` path: `fixture-resolver.ts:61-65` (the
     value arm) and `:122-126` (the table arm), `structural-validation.ts:71-75` (the chart columns)
     and `:105-109` (the row bound). The four direct `snapshotRows` reads in `validate.test.ts` unwrap
     with `_unsafeUnwrap()`.
   - File: `src/report-model/reference-resolver.ts:45-107`.
   - Tests: `validate.test.ts:1690` (`describe("snapshotRows")` — the Err channel for a boolean cell
     and for a flat list entry; the fixture-resolver refusal with reason `unreadable-artifact` at
     `:1729`), and `structural-validation.test.ts:388` (the tier refuses a row bound over a lying row
     instead of raising).

4. WARNING (codex) — the isKnownPartFrame invariant comment.
   - Finding: the guard narrows by the registry key only, and its doc comment did not state that
     invariant plainly.
   - Fix: the comment states that the guard narrows by the registry key alone and does not re-validate
     the payload, and that this is safe on the arrival path only, because `checkChatPart`
     schema-checked the payload of a known part where the frame arrived.
   - File: `src/contracts/chat-frame.ts:118-124`.

5. WARNING (codex) — the row copy lost an own `__proto__` column.
   - Finding: the cells were copied by assignment into `{}`, so an own `__proto__` column did not
     become an own field, and a valid column read as absent.
   - Fix, with a finding beyond the report: zod v4.4.3 drops an own `__proto__` key inside the record
     parse itself — the reconstructed output loses the key before any transform runs (measured), so a
     transform-side copy fix alone could not restore the column. The row build moved out of the zod
     record: the walk in `snapshotRows` reads each own key with `Object.keys` and `Reflect.get`,
     checks the cell with `CellSchema`, and writes it with a `defineOwn` helper (the reference-stamp
     device), so an own prototype-named column survives as an own field. Pre-fix behavior note for the
     ledger: the value path read `selectedRow[column]` unguarded, so a `__proto__` locator gave back
     the inherited `Object.prototype` and the reference resolved with the prototype as the cell; the
     fix returns the real cell.
   - File: `src/report-model/reference-resolver.ts:45-66` (`CellSchema`, `defineOwn`) and `:69-107`.
   - Tests: `validate.test.ts:1717` (the parse keeps the own `__proto__` column) and `:1742` (a value
     reference whose locator column is `__proto__` resolves to the cell).

6. WARNING (codex) — the passthrough arm returned the parse's copy.
   - Finding: the unknown-type arm returned the zod-reconstructed value, so the passthrough contract
     (unchanged, byte for byte) did not hold: the copy was a new object, and a `source` with fields
     the source schema does not know lost them (the source schema strips unknown keys).
   - Fix: the parse stays the validator; the arm returns the original record through
     `UnchangedFrameSchema` (`z.custom<ChatPartFrame>` whose check is the same frame schema), which
     rebuilds nothing. No cast, no directive, no `!`.
   - File: `src/contracts/chat-frame.ts:28-34` (the schema and its reason) and `:113` (the arm).
   - Test: `src/contracts/test/chat-frame.test.ts:499` — an unknown part with an extra field and a
     source with an extra field comes back as the same reference (`toBe`) with the same shape.

Count drift that other children of #607 own (correction round):
- #706: no `!` and no directive added anywhere in the correction.
- Casts: none added.
- #709 (`no-typeof-object`): the moved probe in `errors.ts` keeps its count. The correction added one
  object probe in non-test code (the row check of `reference-resolver.ts`) and one in test code (the
  module read of `validity.test.ts`).
- #709 (`no-unknown-type-guards`): no new type predicate. The `z.custom` check gives zod a plain
  boolean and narrows no type, and the validity gate guards a `typeof` over a value it then calls.

## Implementation-review correction record, round 2 (implementor, 2026-10-25)

The one finding the codex recheck left open is applied. Gates after the fix: harness `bun run lint`
exit 0 (zero from every rule), `bun run typecheck` exit 0, and `bun test src/report-model` gives
313 pass / 0 fail.

7. WARNING (codex) — the table projection lost an own `__proto__` column.
   - Finding: the projection in `resolveArtifactTable` wrote `projected[column] = cell` into `{}`, so
     an own `__proto__` column did not become an own property (the same shape the round-1 correction
     fixed in the `snapshotRows` row walk), and a table reference that selects that column gave back a
     row without the requested cell.
   - Fix: the projection writes each cell with the same `defineOwn` device (the round-1 helper of
     `reference-resolver.ts`), so every projected column lands as an own data property. No cast, no
     directive, no `!`.
   - File: `src/report-model/fixture-resolver.ts:104-111` (`defineOwn`) and `:164` (the
     projection write).
   - Test: `validate.test.ts:1753` — a table reference with `columns: ["__proto__"]` resolves, and
     the projected row holds the cell as an own key with the cell's value (mirrors the round-1
     `__proto__` tests at `:1717` and `:1742`).

Count drift that other children of #607 own (correction round 2):
- #706: no `!` and no directive added anywhere in the correction.
- Casts: none added.
- #709: no new `typeof` object probe and no new type predicate. The fix reuses the existing helper
  shape, and the test narrows the resolved value with a literal `kind` comparison, so neither count
  moves.
