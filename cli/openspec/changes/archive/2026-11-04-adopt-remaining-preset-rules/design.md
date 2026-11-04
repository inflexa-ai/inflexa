# Design

## Context

See proposal.md for the motivation. The facts that shape the approach:

- `cli/oxlint.config.ts:257-291` turns off 25 preset rules for `**/*.{ts,tsx,js,mjs}` under the comment `#811`. `:246-256` turns off the bun-types pair for `**/*.test.{ts,tsx}`, and that block stays.
- Measured on this branch (oxlint 1.85.0, `@inflexa-ai/oxlint-plugin` 0.8.0, the real configuration without the `#811` block): 551 reports in 195 files. The start list with the source line of each site is `tmp/claude/811/811-sites.txt` at the root of the repository, and the JSON is `tmp/claude/811/811-measure.json`. After task 1.1, the live `bun run lint` is the worklist.
- Counts (all / in tests): `no-base-to-string` 109/53, `no-empty-schema` 69/49, `explicit-function-return-type` 65/0, `restrict-template-expressions` 51/23, `no-instanceof-error` 48/4, `no-unknown-type-guards` 27/14, `no-typeof-object` 20/3, `unbound-method` 20/15, `no-unnecessary-type-arguments` 19/19, `no-invalid-void-type` 17/8, `no-misused-spread` 17/8, `no-deprecated` 17/0, `solid/prefer-show` 15/0, `export-at-declaration` 15/0, `no-dynamic-delete` 14/12, `no-unnecessary-type-conversion` 8/1, `no-unnecessary-boolean-literal-compare` 5/0, `no-interface` 3/0, `prefer-promise-reject-errors` 3/3, `no-unnecessary-type-parameters` 2/0, `no-confusing-void-expression` 2/0, `only-throw-error` 2/2, `restrict-plus-operands` 1/0, `no-unnecessary-template-expression` 1/0, `no-redundant-type-constituents` 1/1.
- The preset (`node_modules/@inflexa-ai/oxlint-plugin/dist/index.js`):
  - It sets `explicit-function-return-type` with `allowExpressions` and `allowTypedFunctionExpressions`, and it turns the rule off for the test globs itself. Thus issue task 6 is met when the `#811` entry goes.
  - `no-base-to-string` runs with `checkUnknown: true`. `restrict-template-expressions` permits a number only.
  - `no-instanceof-error` takes `allowIn`, a list of regex strings tested against the file name. `solid({...})` passes the top-level `instanceofErrorAllowIn` to it. The rule ignores a check of a specific class (`instanceof RunDedupCollisionError`).
  - `no-empty-schema` reports `z.unknown()`, `z.any()`, and a bare `z.custom()`, and not `z.json()`.
  - `no-unknown-type-guards` reports a type predicate whose parameter has no annotation or is annotated `unknown` or `any`.
  - `no-empty-schema`, `no-typeof-object`, `no-unknown-type-guards`, `no-interface`, and `export-at-declaration` take no options.
- `directives/architecture-directives.js` of the plugin refuses an inline directive for an `@inflexa-ai/*` rule (only `@inflexa-ai/test-placement` is inline-allowed). A `typescript/*` rule takes an inline directive with a reason.
- `src/lib/cause.ts` is the renderer of an unknown failure value: `describeCause` (`:31`) gives one line, `causeDetailLines` (`:147`) gives a details dump, and `describeNonError` (`:97`) renders a string as itself, a primitive by `String`, a `{type, message}` object as `type: message`, and another object as bounded JSON. cli has no message-only helper. The harness has `errorOf`, `errorMessageOf`, and `errorNameOf` in `harness/src/lib/thrown.ts:15-31`.
- About 33 non-test sites carry `cause instanceof Error ? cause.message : String(cause)`. Each is a report of `no-instanceof-error` and of `no-base-to-string`.
- `process.stdin.isTTY` is typed `boolean` (`@types/node/tty.d.ts:45`), but a piped stdin has no `isTTY` at run time. A test redefines it at run time (`src/modules/embedding/test/setup.test.ts:132-138`).
- `dbos.operation_outputs.function_id` is `int4` (the DBOS system migrations, `harness/node_modules/@dbos-inc/dbos-sdk/dist/src/sysdb_migrations/internal/migrations.js:34`). node-pg gives an `int4` as a number. `statfs` without the `bigint` option gives numbers.
- The four byte formatters `formatBytes` (`src/modules/libs/pull.ts:325`, `src/modules/libs/store.ts:1488`), `describeBytes` (`src/modules/libs/store_download.ts:1315`), and `formatRailBytes` (`src/tui/layout/sidebar.tsx:92`) have the same body with IEC labels. `Number.prototype.formatBytes` (`src/extensions/number.ext.ts:43`) has different labels (`KB`) and a different rounding.
- The cli program runs TypeScript 6.0.3, which infers a type predicate from `(p) => p !== null` and from a discriminant check.
- 40 TSX files already annotate `JSX.Element` (for example `src/tui/layout/sidebar.tsx:110`), with `import type { JSX } from "solid-js"`.
- The harness did the same work in PR #732 (issue #709): `harness/oxlint.config.ts:57-325` and `harness/openspec/specs/type-strictness/spec.md:114-150`. Its review #733 found three classes that this change prevents: a string conversion of a value that can be absent (`textOf(undefined)` gave "undefined"), an `unbound-method` rewrite in a test that adds no check (`?.bind(tool)`), and a model-facing schema change (a recursive `z.json()` reached an OpenAI-compatible model as `$ref`).

## Goals / Non-Goals

**Goals:**

- Zero reports from `bun run lint`, with `bun run typecheck` and `bun run test` green, and no `off` entry for a preset rule outside the bun-types test block and the zone blocks of D15.
- No change of behavior, except the one recorded in D1 and D2.

**Non-Goals:**

- No change of a model-facing schema. No tool input schema of `src/modules/harness/*_tool.ts` changes, and no `z.json()` goes into one.
- No stricter wire or disk schema: a body or a file that parsed before still parses (D4).
- No new dependency, no change of a package version, and no change to the harness.
- No change of the `KB`/`MB` text of `Number.prototype.formatBytes`, and no change of the `KiB`/`MiB` text of the store and rail readouts (D12).

## Decisions

### The reviewer record

The coordinator wrote one brief (`tmp/claude/811/decision-brief.md` at the root of the repository) with the measurements and the options for each question. Three independent reviewers answered it. No reviewer saw the answer of another.

| Question | Codex (gpt-6-sol, high reasoning) | Pi (`viv-issue-reviewer` flavor, medium) | Claude reviewer (sonnet, high effort) | Coordinator (claude-opus-5-5) | Result |
| --- | --- | --- | --- | --- | --- |
| Q1 `messageOf` | A | A | A | A | D1 |
| Q2 bare `String` | A | A | A | A | D2 |
| Q3 `allowIn` | B | A | A | A | D3, majority A |
| Q4 empty schema | A / A | A / A | A / A | A / A | D4 |
| Q5 return types | A | A | A | A | D8 |
| Q6 unbound method | A / A | A / A | A / A | A / A | D9 |
| Q7 string spread | A | A | A | A | D10 |
| Q8 type guards | A | A | A | A | D6 |
| Q9 export at declaration | A | A | A | A | D7 |
| Q10 stdin TTY | A | A | A | A | D11 |
| Q11 byte formatters | A | A | A | A | D12 |
| Q12 dynamic delete | A | A | A | A | D13 |
| Q13 spec | A | A | A | A | D15 |

The dissent: Codex chose Q3 B (put `src/modules/harness/dev/run.ts` in `allowIn`), because the name check of `:150` requires an `Error`. The majority chose A, because `allowIn` then names only the normalizer, as in the harness, and a later `instanceof Error` in `dev/run.ts` stays visible to the rule. The artifact audit (Codex C1, Pi W2) then found that the structural reads of the brief would widen the checks to a non-Error value. D3 thus reads through `errorOf`, which keeps the `Error` requirement of each site. That meets the concern of the dissent inside option A.

The objections to the brief, and their outcome:

- Pi: `src/lib/bus.ts:19` stamps the original event in place (`Object.assign(event, …)`), and a schema parse gives a copy. Supported: the file goes in the `no-typeof-object` zone block (D5).
- Pi: the ENOSPC walk of `src/modules/libs/store_download.ts:1305-1311` reads `.code` and `.cause` along a chain, and `errnoCode` alone does not remove the object gate of the `.cause` step. Supported: the walk moves into `src/lib/cause.ts` (D3). A zone block is file-level, and the other `no-typeof-object` sites of `store_download.ts` (`:378,384`) must become schema reads.
- Pi and the Claude reviewer: `src/modules/libs/store_flight.ts:803` gives `""` for a cause that is not an `Error`, and `messageOf` would give a rendering (or `": undefined"` for an absent cause). Supported: the site reads `errorOf(error.cause)?.message` and keeps `""` (D1).
- The Claude reviewer: the report at `src/tui/hooks/boot.ts:310` is on `${code}` (`number | null`), not on `spawned.error`, which is already a string. Supported (the span of the report is `code`): the site narrows `code` (D14).
- The Claude reviewer: `scripts/build.ts:755` converts a Bun `BuildMessage` or `ResolveMessage`, which is not an `Error`. Supported: `String(log)` gives `ResolveMessage: Could not resolve: "./nope.ts"` (measured with `bun -e` on this machine), which is `${log.name}: ${log.message}`. The site writes that template (D2).
- Codex: `z.json()` refuses a number that `JSON.parse` turns into `Infinity`, thus "the same accepted values" is too broad. Supported for production, which keeps its schemas (D4). A test parses the JSON text of a fixture or of the code under test, and no test text holds such a number.
- Pi: the three other `no-unnecessary-boolean-literal-compare` sites are not stdin reads. Supported: D11 lists them separately.

### D1: `messageOf`, `errorOf`, and the message sites

`src/lib/cause.ts` gets these exported helpers, each with a JSDoc block:

```ts
export function messageOf(cause: unknown): string {
    return cause instanceof Error ? cause.message : describeNonError(cause);
}

export function errorOf(cause: unknown): Error | undefined {
    return cause instanceof Error ? cause : undefined;
}
```

- Each site of `cause instanceof Error ? cause.message : String(cause)`, and of the same expression over `e.cause` or `error.cause`, calls `messageOf`. The text is the same for an `Error`, a string, and a primitive. A non-Error object gives `type: message` or bounded JSON in place of `[object Object]`. This is the one recorded behavior change of the change, and it removes the defect that `no-base-to-string` reports.
- The two sites with the fixed text `"a non-Error value"` (`src/modules/harness/prov_bridge.ts:365`, `src/modules/harness/usage_recorder.ts:112`) call `messageOf` too. A non-Error then gives its rendering. No test pins the fixed text.
- A site that gives a fallback for a non-Error, and not a rendering, reads `errorOf(<value>)?.message`: `src/modules/libs/store_flight.ts:803` keeps `""` for a cause that is absent or not an `Error`, and the test sites `src/modules/harness/test/run_deps.test.ts:345` (`""`), `src/server/test/profile_queue.test.ts:71` (`"?"`), and `src/modules/refs/test/commands.test.ts:891` (`undefined`) keep their fallbacks.
- `src/test_support/test/result.test.ts:11` returns the thrown value when it is an `Error`. It uses `errorOf`.
- The own reports of `src/lib/cause.ts` keep the text of each value:
  - `describeNonError` (`:99`) and `appendCauseDetail` (`:193-194`) render a value that is not an object and not a string through one switch on `typeof` with a typed branch for each kind (`undefined`, `number`, `bigint`, `boolean`, `symbol`, `function`), and the text of each kind stays the same as `String` gives.
  - `safeStringify` (`:219,221`) keeps `String(value)` as its last fallback, when `JSON.stringify` throws or gives nothing, under an inline `oxlint-disable-next-line typescript/no-base-to-string -- <reason>`: no other rendering exists for that value.
  - `indentFrom` (`:207`) reads each line with its index from `entries()`, so no index read is `undefined`.
- `src/lib/test/cause.test.ts` gets a test for each new helper: an `Error`, a string, a primitive, `undefined`, a `{type, message}` object, and a plain object.

Alternatives rejected:

- `String(cause)` in the non-Error branch, with an inline disable (Q1 B). It keeps `[object Object]`, the defect that the rule exists to find.
- `describeCause` at each site (Q1 C). An `Error` then prints `Error: message` and the cause tail, which changes the text of each common case.

### D2: `describeCause` for a bare `String(<unknown>)` of a failure value

A site that converts an unknown failure value with `String(...)` or `${...}` and no `instanceof` branch calls `describeCause`: for example `src/modules/auth/auth.ts:145,147,249,294,343,400`, `src/modules/update/apply.ts:180`, `src/modules/harness/content-pack.ts:83`, `src/lib/fs_pool_reexec.ts:76`, `src/modules/infra/setup.ts:793`, `src/modules/sbom/sbom.ts:110,124`, `src/test_support/server.ts:86,105`, `scripts/build.ts:97,99,767`, `scripts/dev_install.ts:68`.

- `String(error)` of an `Error` is `name: message` (`Error.prototype.toString`), and `describeCause` gives the same headline. The text changes for an `Error` with a `.cause` or `.errors` (the tail is added), for a non-Error object (JSON or `type: message`), and for an `Error` with an empty message (`Error: ` in place of `Error`, because `Error.prototype.toString` drops the separator and `describeCause` keeps it). A string and a primitive are unchanged. This is part of the recorded behavior change of D1. The shared renderer stays as it is, because a change of its headline would change the text of each existing caller of `describeCause`.
- `scripts/build.ts:755` converts a Bun build log, which is not an `Error`. It writes `${log.name}: ${log.message}`, the exact text of `String(log)`.
- `messageOf` is not used here (Q2 B): it drops the `name:` prefix of an `Error`.

### D3: `instanceofErrorAllowIn`, the class reads, and the cause walk

- `instanceofErrorAllowIn: ["src/lib/cause.ts"]`, with the reason beside it: the module renders and reads an arbitrary thrown value, and its `Error` passthrough (`errorOf`) must see the class, because a structural lookalike must not pass.
- A site outside `cause.ts` that tests `instanceof Error` and then reads a field reads through `errorOf` (D1), so each site keeps its `Error` requirement and its result for each value:
  - `src/modules/harness/dev/run.ts:150` becomes `cause instanceof RunDedupCollisionError || errorOf(cause)?.name === "RunDedupCollisionError"`.
  - The ENOENT checks `src/modules/libs/store_download.ts:321` and `src/modules/refs/store.ts:554` become `errnoCode(errorOf(cause)) === "ENOENT"` (`errnoCode` is `src/lib/fs.ts:195`, and it gives `undefined` for `undefined`).
- No structural `name` read is added. A read without the class check (`errorNameOf` of the harness, or `errnoCode` alone) would also match a non-Error value, which the code does not do today.
- The walk of `isDiskFull` (`src/modules/libs/store_download.ts:1305-1311`) moves into `src/lib/cause.ts` as one exported function that tells if a cause, or a cause that it wraps through `.cause`, carries a given errno code. The walk keeps its bound of 5 links and its order. `isDiskFull` calls it with `ENOSPC`. A test in `src/lib/test/cause.test.ts` covers a direct code, a wrapped code, a chain past the bound, and a value with no code.

### D4: `no-empty-schema`

- **Tests:** `z.json()` takes the place of `z.unknown()` (for example `parsedJson(text, z.json())`, `z.array(z.json())`). A test parses the JSON text of a fixture or of the code under test. That text holds no number past the range of a double (the one value that `JSON.parse` accepts and `z.json()` refuses, as `Infinity`), so each test input parses as before. The harness tests do the same (`harness/src/loop/test/prompt-cache.test.ts:477`). The doc of `parsedJson` (`src/test_support/json.ts:5-9`) names `z.json()`. The two throwing refinements of `src/extensions/test/extensions.test.ts:25,55` refine a schema of the value that the test parses. No test schema reaches a model.
- **Production:** no schema changes. One zone block for `@inflexa-ai/no-empty-schema` lists each production file with its reason. Each leaf is read or forwarded opaque by design, and a narrower schema would refuse a body or a file that parses today:
  - `src/api/common.ts` — the `details` of an error body hold any value, and the client gives the whole body to its caller.
  - `src/client/api.ts` — the body before `trustWireBody`. The client does not validate a success body (the reason at `:274-287`), and a `z.json()` walk of each body checks nothing that `JSON.parse` did not.
  - `src/lib/config.ts` — `harness` and `models` are validated downstream, so one bad field cannot drop the whole config (`:73-81`).
  - `src/lib/json_record.ts` — `unknownRecordSchema` is the walk container: each value stays `unknown` until the caller reads it.
  - `src/modules/libs/store_download.ts` and `src/modules/refs/store.ts` — the JSON text of a manifest or a receipt, which a second parser shapes and refuses.
  - `src/modules/libs/store.ts` and `src/modules/libs/store_flight.ts` — the `nodes` of `deps.json`: only the keys are read, or the commit writes back what it read.
  - `src/modules/harness/model_listing.ts` — the Ollama `model_info`, whose keys name the architecture.
  - `src/modules/infra/proxy_config.ts` — a credential file that the code writes back with each key that it read.
  - `src/modules/embedding/local-provider.ts` — only the length of `tokens` is read.
  - `src/server/routes/artifacts.ts` — the echart `spec`, forwarded to the opener.
  - `scripts/build.ts` — the package.json fields that the license walk narrows.

Alternatives rejected: `z.json()` in production (Q4 B), because it walks each response body again, refuses an overflow number, and changes the inferred types. A precise schema (Q4 C), because a body or a file that passed can then fail (#733 "a stricter parse that removes error tolerance"). A `parsedJson` overload with no schema (Q4 B for tests), because it hides the same `z.unknown()`.

### D5: `no-typeof-object`

One zone block for `@inflexa-ai/no-typeof-object`, with the reason of each file:

- `src/lib/cause.ts` — the error normalizer and the cause walks read an arbitrary thrown value structurally, and a record parse would answer on a copy that drops the own non-enumerable `message` and `cause` of an `Error`.
- `src/lib/fs.ts` — `errnoCode` reads the `code` of a thrown value, for the same reason.
- `src/lib/bus.ts` — the emit stamps `__infId` on the original event object in place, and a schema parse would stamp a copy.
- `src/modules/sbom/sbom.ts` — `isCdxObject` must answer on the original object of the walk (D6).
- `src/lib/test/timer.test.ts` — `isHandle` reads a spy result, which is a timer handle object or `{}` (D6).

Each other site becomes a read with an existing helper, or a narrow by the members of a known union, with the same result for each input:

- `src/server/routes/runs.ts:784,801,806` and `src/modules/libs/store_download.ts:378,384` read through `unknownRecordSchema` (`src/lib/json_record.ts:8`) or a zod schema of the shape. Each input keeps its result and its error message (for example, a manifest that is an array still gives "The manifest declared no layers.").
- `src/lib/otel.ts:124` tests the scalar kinds first. A JSON value that is not null and not a scalar is an object or an array, thus the `JSON.stringify` branch stays the same.
- `src/modules/embedding/local-provider.ts:470` narrows `server.address()` (`AddressInfo | string | null`) by its members.
- `src/modules/infra/setup_answers.ts:538` narrows the typed answer by its members.
- The test sites `src/cli/test/gen_docs.test.ts:73` and `src/modules/harness/test/inflexa_tool.test.ts:817` read through a schema or `unknownRecordSchema`.

### D6: `no-unknown-type-guards`

- A `.filter((p): p is T => ...)` or a predicate argument whose narrowing TypeScript 6 infers loses the explicit predicate: `.filter((p) => p !== null)`, `requirePart((p) => p.type === "data-plan")`. Where inference does not give the narrowed type (a narrow by a property that is not a discriminant, for example `src/tui/commands.tsx:2308`), the parameter gets its known type, and the predicate stays (`(t: ThreadView): t is ArchivedThread => t.archivedAt !== undefined`). A failed inference is a typecheck error, thus `bun run typecheck` proves each site.
- `src/api/common.ts:53` annotates the parameter: `(code: string): code is ApiErrorCode`. The schema does not change.
- `src/modules/sbom/sbom.ts:165` (`isCdxObject`) and `src/lib/test/timer.test.ts:9` (`isHandle`) stay, in a zone block for `@inflexa-ai/no-unknown-type-guards` with their reasons: the SBOM walk must keep the original object, which a schema parse copies, and the timer guard reads a spy result that is a handle or `{}`.

### D7: `export-at-declaration`

- `src/modules/embedding/llama_assets.d.ts`, `src/modules/harness/content-assets.d.ts`, and `src/tui/grammars/assets.d.ts` go in a zone block for `@inflexa-ai/export-at-declaration`. The reports are false: an ambient module has no form that puts `export default` on a typed `const`, and the importers use the default import of a `with { type: "file" }` asset.
- `src/tui/hooks/conversation.ts` and `src/tui/hooks/pauses.ts` go in the same zone block. Each exports the read accessor of a Solid signal or store, and the setter stays private to the module. `export const [messages, setMessages] = …` would export the setter too.
- `src/modules/harness/agent_switch.ts:378-379` deletes the re-export of `AGENT_NAMES` and `AgentName`. No importer reads them from `agent_switch.ts`, and `cli/CLAUDE.md` bans a re-export. The string fixture of `src/client/test/import_boundary.test.ts:53` names `agent_switch.ts` only as the text of an import that the lint test checks, and it stays.

### D8: `explicit-function-return-type`

- Each Solid component gets the return type `JSX.Element` (`import type { JSX } from "solid-js"`), as the 40 annotated TSX files already do. Each accessor arrow gets the type of its value, for example `const pgDraft = (): PostgresDraft => draft().postgres;`. Each other function gets its return type.
- `cli/CLAUDE.md:367-368` drops the JSX exception: "Always type the function parameters and the return values." The rule has no JSX exemption, thus the old sentence tells a reader to write code that the lint refuses.

### D9: `unbound-method`

- **Production:**
  - A member that the implementation never binds to `this` becomes a function property in its type: `tail: () => string` and `terminate: () => Promise<void>` in the handle types of `src/modules/embedding/local-provider.ts` (`:234,245,502`), and `sleep: (ms: number) => Promise<void>` in `src/extensions/promise.ext.ts:10`. The run time does not change.
  - `src/lib/fs_pool_reexec.ts:74` passes `process.execve?.bind(process)`. Bun owns the implementation of `execve`, so the bound reference is the safe value. The `undefined` of a platform without `execve` stays `undefined`, and the callee checks it (`:62`).
- **Tests:**
  - A shape check `expect(x.method).toBeInstanceOf(Function)` becomes `expect(typeof x.method).toBe("function")`. It is the same check, and `typeof` is a safe use for the rule (`src/modules/harness/test/runtime.test.ts:134,135,152,158,167,320,321,896`).
  - A `describeCall` reader reads the hook as the harness reader does (`harness/src/loop/tool-detail.ts:130-131`): `expect(typeof tool.describeCall).toBe("function")`, then `tool.describeCall?.(input)`, a method call with its receiver (`inflexa_tool.test.ts:759,760,807`, `inputs_tool.test.ts:204,205`). `launch_dir_tool.test.ts:102` becomes `expect(typeof tool.describeCall).toBe("undefined")`.
  - The double of `src/server/routes/test/report_pages.test.ts:453` forwards with an arrow, as its `mint` neighbor does.
  - No `.bind` goes into a test (#733).

### D10: `no-misused-spread`

Each `[...value]` of a string becomes `Array.from(value)`: the same code-point iteration, as `harness/src/report-model/draft-read.ts:70` does. The `allow` option of the rule is not used, because it would turn the check off for each string.

### D11: the stdin TTY read, and the other boolean compares

- `src/lib/cli.ts` gets `stdinIsTTY(): boolean`, which returns `process.stdin.isTTY === true` and reads the property at each call (a test redefines it). It carries one inline `oxlint-disable-next-line typescript/no-unnecessary-boolean-literal-compare -- <reason>`: the type says `boolean`, but a piped stdin has no `isTTY` at run time. The five sites call it: `src/modules/infra/setup.ts:209,1103,3110`, `src/client/commands/server.ts:73`, `src/modules/embedding/setup.ts:361`. A test in `src/lib/test/` covers `true`, `false`, and `undefined`.
- The three other compares drop `=== true`, because the value is a boolean at run time too: `src/lib/cli.ts:91` (the answer after `!isCancel` is a boolean), `src/lib/install_context.ts:49` and `src/modules/embedding/setup.ts:143` (`__INFLEXA_COMPILED__` after its `typeof` guard is the boolean that the build defines).

### D12: the byte formatter of the store and rail readouts

One exported helper in `src/lib/` (named so that it does not read as a second `formatBytes`, for example `formatIecBytes`) holds the body of the four formatters, with the same text for each input: whole bytes and `B` below 1024, then one decimal and `KiB`, `MiB`, `GiB`, or `TiB`. The loop iterates a `const` list of the units, so no index read can be `undefined`. The four call sites (`pull.ts`, `store.ts`, `store_download.ts`, `sidebar.tsx`) call it and lose their copies. `src/tui/` can import `src/lib/`. A test in `src/lib/test/` covers 0, 1023, 1024, a value in each unit, and a value above the top unit.

`Number.prototype.formatBytes` is not used (Q11 B): its labels and its rounding differ, and the readouts would change.

### D13: `no-dynamic-delete`

- **The environment in the tests:** one helper file in `src/test_support/` saves the named variables of an environment object and clears them, and gives a restore that puts each saved value back (or deletes the variable that was absent). A test that unsets a variable during a case calls a second function of the same file. The file holds the deletion once, under one inline `oxlint-disable-next-line typescript/no-dynamic-delete -- <reason>`: an assignment of `undefined` to `process.env` stores the text `"undefined"`, thus the variable must be deleted. The caller passes `process.env` or `Bun.env`, so the helper does not read `process.env` and needs no exemption from `no-restricted-properties`. The sites: `src/lib/test/env.test.ts:205-327`, `src/modules/harness/test/config.test.ts:530,533`, `src/modules/infra/test/setup.test.ts:2597`.
- **A record:** the site builds a new record without the key, with a rest destructure or an `Object.entries` filter: `src/lib/env.ts:115-116`, `src/modules/libs/store_flight.ts:737` (the same filter form as `:727`), `src/lib/test/env.test.ts:450`, `src/modules/prov/test/kernel_compat.test.ts:77`, `src/modules/libs/test/composition.test.ts:1038`. The order of the keys that stay does not change.
- `Reflect.deleteProperty` is not used (Q12 B): it satisfies the rule and changes nothing.

### D14: the other rules

- `no-deprecated`: `.passthrough()` becomes `z.looseObject({...})` (zod 4.4.3 gives both the same `catchall(unknown)`): `src/lib/container.ts`, `src/modules/sbom/sbom.ts`, `src/modules/libs/store_flight.ts`, `src/modules/libs/store.ts`.
- `no-interface`: `SpawnBounds` and `RunInflexaToolDeps` (`src/modules/harness/inflexa_tool.ts:330,470`) and `LocalEmbeddingProviderDeps` (`src/modules/embedding/local-provider.ts:55`) become types. No code merges a declaration into them.
- `no-invalid-void-type`: `Promise.withResolvers<undefined>()` with `resolve(undefined)`, and `ok<undefined, E>(undefined)`, or no type argument where the return type gives it (harness: `tasks/test/regulatory-corpus-boot-refresh.test.ts:55`, `memory/thread-history.ts:59`). `Promise<Response | void>` at `src/server/analysis_guard.ts:65` becomes `Promise<Response | undefined>`.
- `restrict-template-expressions`: the text of each defined value stays. A value that can be absent at run time never prints the text `"undefined"`. Where absence is impossible, the type says so: `present()` where the code proves presence, a destructured first element, or a narrowed branch. `src/tui/hooks/boot.ts:310` narrows `code` by the branch of `spawned`. A commander flag value or a query value that the type gives as `unknown` or `undefined` (`src/client/commands/geo.ts:30`, `src/client/commands/prov.ts:25`, `src/server/routes/provenance.ts:84`) keeps its text for each value that reaches the site today. `notes.md` records each site and its proof.
- `restrict-plus-operands` (`src/modules/infra/proxy_config.ts:202`) and `no-unnecessary-template-expression` (`src/modules/infra/setup.ts:2710`): the same text for each input, with no `!` (for example `charAt` of an index that the modulus keeps in range).
- `no-unnecessary-type-conversion`: `Number(row.function_id)` (`src/modules/harness/dev/status.ts:52`, an `int4` column that node-pg gives as a number) and `Number(fs.bavail) * Number(fs.bsize)` (`src/modules/libs/store_download.ts:1331`, `statfs` without `bigint`) drop the conversion. `src/modules/refs/commands.ts:469` and `src/tui/test/commands.test.ts:1496` drop it where the type is already the target type. The `Boolean(process.stdin.isTTY)` sites go to D11.
- `no-unnecessary-type-arguments` in the tests: delete the type argument. Where the inference then breaks a matcher, the variable gets its type at its declaration.
- `no-redundant-type-constituents`: `unknown | unknown[]` becomes `unknown` (`src/client/commands/test/runs.test.ts:16`).
- `no-confusing-void-expression` (`src/tui/hooks/artifacts.ts:39,41`): the call and the `return` become two statements.
- `solid/prefer-show`: each JSX ternary becomes `<Show when={…} fallback={…}>`. A branch that reads the narrowed value uses the keyed form or the accessor of `<Show>`, so the narrowing of the ternary stays.
- `no-unnecessary-type-parameters`: `trustWireBody<T>` (`src/client/api.ts:279`, the one trusted cast of the client) and `registerAction<Args>` (`src/cli/agent_policy.ts:194-198`, the generic keeps the parameter types of each handler) keep their form under an inline directive with the reason.
- `prefer-promise-reject-errors` and `only-throw-error` in the tests: a double that rejects or throws a non-Error by design keeps its form under an inline directive with the reason (`src/modules/harness/test/model_listing.test.ts:267,570` reject with `signal.reason` as `fetch` does, `src/modules/proxy/test/models.test.ts:398` rejects with a string to drive the non-Error path). `src/modules/harness/dev/test/run.test.ts:110,135` take the type `Error` for the thrown value where each test gives an `Error`, else an inline directive with the reason.
- **The fetch doubles and the captures of the tests** (`no-base-to-string`): `String(input)` of a `string | URL | Request` goes through one helper in `src/test_support/fake_fetch.ts` that gives the URL text of each of the three forms. `String(init.body)` goes through one body reader beside `requestedModel` in `src/test_support/request_body.ts`, which `requestedModel` also uses. A console capture double types its parameter as `string`, where the code under test logs a string, or renders the value with `describeCause`. Each other test conversion of a value whose type is known uses the property that holds the text (for example the `href` of a `URL`).

### D15: the form of a kept site, and the spec

- A deliberate site of a `typescript/*` rule keeps an inline `oxlint-disable-next-line <rule> -- <reason>`. A deliberate site of an `@inflexa-ai/*` rule is a file of a zone block in `cli/oxlint.config.ts`. A zone block names one rule. Its comment gives the reason of each file, in the form of `harness/oxlint.config.ts:153-323`. The zone blocks come after the bun-types test block. No comment names a task, a count of reports, or this change, because those go stale (#733 section 6).
- The zone blocks of this change: `@inflexa-ai/no-empty-schema` (D4), `@inflexa-ai/no-typeof-object` (D5), `@inflexa-ai/no-unknown-type-guards` (D6), `@inflexa-ai/export-at-declaration` (D7). `instanceofErrorAllowIn` is the option form for `@inflexa-ai/no-instanceof-error` (D3).
- The spec adds the requirement "The remaining preset rules report nothing" to the `type-strictness` capability, beside the requirements of the earlier layers of #608, with the text of the harness requirement adapted to cli.

### D16: The test strength

- A test edit does not remove or loosen an `expect` call. The count of `expect(` in the source text of each changed test file stays the same or grows. `notes.md` records the counts before and after.
- A test asserts the new text of a site only where D1 or D2 changes it.

## Risks / Trade-offs

- [D1 and D2 change the text of a non-Error failure object, and add the cause tail for an `Error` with a cause] → This is the one recorded behavior change. It replaces `[object Object]`, which carries no information, and the change is limited to the branch that printed it. A test that pins the old text of such a value changes its pin, and `notes.md` names it.
- [The zone blocks are file-level] → A later violation in a zoned file passes. Each zone names one rule, and each zoned file is a normalizer, a walk container, or a declaration file whose purpose is the reported form. The cause walk moves out of `store_download.ts` so that file needs no zone.
- [`z.json()` changes an inferred type in a test from `unknown` to the JSON type] → `bun run typecheck` proves each site.
- [The removal of a `Number()` or a `Boolean()` changes a value whose run-time type differs from its declared type (#733 L1)] → Context gives the proof for each removal. The stdin read keeps its normalization (D11).
- [`solid/prefer-show` changes the reactive structure of a view] → `<Show>` renders the same branch for each value of its condition. The render tests of each changed view run.
- [A mid-state with lint errors] → Task 1.1 removes the block first. A red lint between task 1.1 and the last site is the expected mid-state.

## Migration Plan

One pull request. The removal of the block, the helpers, and the site passes land together. A revert of the change restores the `off` block.
