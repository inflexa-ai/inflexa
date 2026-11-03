# Design

## Context

See proposal.md for the motivation. The facts that shape the approach:

- `cli/oxlint.config.ts` turns the three rules off in its last override, under the comment `#806`. The other `off` entries of that block belong to #807 to #811 and stay.
- Measured on this branch (oxlint 1.85.0, `@inflexa-ai/oxlint-plugin` 0.8.0), with the three rules forced on: `require-assertion-safety` 875 reports (711 in tests), `no-unsafe-type-assertion` 669 (529 in tests), `no-double-cast` 150 (146 in tests). 717 unique `file:line` sites. 56 sites are reported only by `require-assertion-safety`, and 20 of them are outside the tests. The start list is `tmp/claude/806/probe-lint.out` at the root of the repository.
- The rule mechanics:
  - `require-assertion-safety` reports each `as` and `<T>x` except `as const`. A `SAFETY:` comment before the `as`, or before the statement that holds it, clears it.
  - `typescript/no-unsafe-type-assertion` reports an assertion that narrows or that comes from `any`. A comment does not clear it. An inline `oxlint-disable-next-line typescript/no-unsafe-type-assertion -- <reason>` does. It does not report a widening.
  - `no-double-cast` reports each `as unknown as X` and `as any as X`. It has no escape.
  - `satisfies`, a type annotation, a type predicate, and a generic type argument are not assertions.
- bun-types gives `Response.json()` the type `Promise<any>`, and an unbound `Database.query(sql)` the type `Statement<unknown>` (`bun-types/sqlite.d.ts:225` declares `query<ReturnType, ParamsType>`).
- The client of the local server already records its trust for a success body (`src/client/api.ts:134-140`). A command checks the `apiVersion` of the server in `ensureServer` (`src/client/server.ts:182-246`), and the TUI checks it at its boot (`src/tui/hooks/boot.ts:210`). `request` itself does not check it again for each call.
- bun `toHaveProperty(path, value)` compares the value at the path with the same recursive equality as `toEqual`. A probe on this machine confirmed that an extra key in the actual value fails it, and that a path can name an array `length`.
- Harness PR #727 (issue #707) did the same work. Its design is in `git show b9c79f90:harness/openspec/changes/archive/2026-10-25-adopt-assertion-safety/design.md`. Harness review #733 W1 is the defect class that this change must prevent.

## Goals / Non-Goals

**Goals:**

- The three rules report nothing, with no `off` entry and no blanket directive.
- Each repeated cast shape becomes one abstraction at the boundary that owns the data.
- Each boundary keeps its error tolerance, and each test keeps its strength.

**Non-Goals:**

- The reports of the rules of #807 to #811. This change adds no site for them: no `!` in place of an `as`, no new `x is T` predicate over `unknown` (`@inflexa-ai/no-unknown-type-guards`, #811), and no new `typeof x === "object"` probe (`@inflexa-ai/no-typeof-object`, #811). A zod parse or an existing helper takes their place. An existing helper (for example `errnoCode` of `src/lib/fs.ts:195`) can be reused.
- A runtime validation of each success body of the local-server wire (D1).
- A change to the harness. The harness is linked, but this change edits `cli/` only.
- A behavior change of any kind, also one that looks like an improvement.

## Decisions

### The reviewer record

The coordinator wrote one brief (`tmp/claude/806/decision-brief.md`) with the measurements and the options for each of the decisions D1 to D5. Three independent reviewers answered it. No reviewer saw the answer of another.

| Reviewer | Model | D1 | D2 | D3 | D4 | D5 |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | gpt-6-sol, high reasoning | A | A | A | A | A |
| Pi | `viv-issue-reviewer` flavor, zai/glm-5.3, high thinking | A | A | A | A | A |
| Claude reviewer | sonnet, high effort | A | A | A | A | A |
| Coordinator | claude-opus-5-5 | A | A | A | A | A |

Each decision below is option A, by unanimous choice. No reviewer dissented. The reviewers corrected some facts of the brief, and this design uses the corrected facts.

### D1: The success body of the local-server wire keeps one documented trust point

`request<T>` (`src/client/api.ts:146`) and `parseFrame<T>` (`src/client/api.ts:277`) route their cast through one private function in `src/client/api.ts`. That function holds the one cast, a `SAFETY:` comment, and one `oxlint-disable-next-line typescript/no-unsafe-type-assertion -- <reason>`. The comment states the invariant exactly:

- One checkout builds the server routes and the client fetchers from the same `src/api/` types.
- A command connects through `ensureServer`, and the TUI through its boot hook. Each of the two refuses a server of a different `apiVersion`.
- The accepted residual: `request` itself does not check the version. Thus `request` does not detect a version difference in two cases: a call that no earlier check precedes, and a server that a different build replaces during one client session. This is the behavior today.

No behavior changes.

Alternative rejected: a zod schema for each wire type in `src/api/`, with `z.infer` types, parsed by each fetcher. A body that does not match becomes `bad_json`, which is a behavior change. It needs about 65 response schemas and their nested types. Many wire types embed harness-owned types (for example chat parts, plan records, and run synthesis parts) that have no schema in cli.

### D2: The route tests read a JSON body as `unknown`

The shape is `(await (await app.request(url)).json()) as RunList` at about 270 sites in tests, and 64 of them are `as ApiError`.

- One reader in `src/test_support/` gives the JSON body of a `Response` (or of a promise of one) as `Promise<unknown>`. Each test reads its body through it.
- A test asserts the whole value with `toEqual`, or one field with `toHaveProperty(path, value)`. These replacements keep the strength:
  - `expect(body as T).toEqual(v)` becomes `expect(body).toEqual(v)`.
  - `expect((body as T).f).toEqual(v)`, `.toBe(v)`, or `.toBeNull()` becomes `expect(body).toHaveProperty("f", v)` (with `null` for `.toBeNull()`).
  - A nested read uses the array form of the path, for example `["runs", 0, "id"]`.
  - `.toHaveLength(n)` on a field becomes `toHaveProperty([..., "length"], n)`.
  - `expect((body as T).f).toBeUndefined()` becomes `expect(body).not.toHaveProperty("f")`. A JSON body cannot hold an `undefined` value. But the field read of today fails for a `null` body, and `not.toHaveProperty` passes for it. Thus the same test must also assert that the body is an object: a `toHaveProperty` with a value, a `toMatchObject`, a `toEqual` of an object, or a schema parse on the same body. If the test has none, add `expect(body).toMatchObject({})` before the absence assertion.
  - `toMatchObject` on a field becomes `toMatchObject` on the body with the field around the expected value.
- A test that computes on the body (`map`, `find`, `filter`, a comparison such as `toBeGreaterThan`, `toContain`, or a value that the next request uses) parses a small zod schema in the test. The schema names only the fields that the test reads, and it uses `z.looseObject` so that an extra field does not fail it. When more than one test of a file reads the same shape, the file declares the schema one time. When the same schema repeats across test files, it moves to `src/test_support/`.
- The error body parses with one `apiErrorSchema` in `src/api/common.ts`. The schema accepts exactly the bodies that the hand guard `isApiError` (`src/client/api.ts:286-291`) accepts today: an object with a string `error` from the closed set of `API_ERROR_STATUS`, a string `message`, and an optional `details` of any value. An extra key passes, and it reaches the caller unchanged. The client `errorFromBody` uses the schema in place of `isApiError`, and `isApiError` and its cast go. A route test reads an error body through the same schema (one helper in `src/test_support/` beside the body reader), then asserts with `toEqual` or `toHaveProperty`.

Alternatives rejected:

- A generic test reader `bodyOf<T>(response): Promise<T>` with one cast. The test picks `T`, and nothing ties it to the type that the route declares. It is a cast with a new name and no check.
- The route tests read through the production client (`request<T>` with a `ClientOpts` whose `fetch` calls `app.request`). Each call and each status assertion changes, and `src/test_support/fake_client.ts` already tests the client at its own level.

### D3: A database read binds the row type on the statement

Each `conn.query(sql).get(...) as Row | null` and `.all(...) as Row[]` in `src/db/` (and each other `bun:sqlite` read that this change finds) becomes `conn.query<Row, Params>(sql).get(...)`. `Params` is the tuple or the record of the bound values. The cast goes, and the type arguments state the same contract at the statement. The `CHECK` and `NOT NULL` clauses of `src/db/primary_migrations.ts` hold the column contracts. A column that holds a union (for example `r.id as TransferKind` at `src/db/primary_query.ts:862`) takes the union in the bound row type, because the `CHECK` clause of the migration holds the closed set. A membership guard would need a fallback for a value outside the set, and no such value can pass the `CHECK`. A read with `get()` gives `Row | null`. Where the SQL always gives one row (a `COUNT`, an aggregate, an `INSERT ... RETURNING`), the `null` branch takes the value that an empty result means (`0`, `{ calls: 0 }`) or the existing error of the function, with no `!`.

Alternative rejected: a zod schema for each row type, parsed at each read. Each read then needs a degrade path for a row that fails the parse. `cli/CLAUDE.md` ("Local state can go out of agreement with the database — never fail hard on it") forbids a hard failure, and each degrade path is a behavior change with no spec. The harness used zod for its Postgres rows because those rows come from untyped reads. Its typed row reads use the same generic shape (`harness/src/state/db.ts:17-31`).

### D4: A test double satisfies its type without a cast

The fix follows the owner of the type:

- A cli-owned value type that tests fake often (`Analysis` of `src/types/analysis.ts`, `Workspace` of `src/tui/contexts/workspace.ts`) gets one complete builder in `src/test_support/`. The builder returns the full type with valid defaults and takes overrides for the fields that a test changes. The compiler checks each builder.
- Some cli parameters and dependency fields receive a wide type but read only part of it. Each takes the narrowest structural type that its code reads: an options-object type, a `Pick`, or the harness `Querier` (`@inflexa-ai/harness/state/db.js`) in place of the `pg` `Pool`. Then a small literal fake satisfies it. `HarnessRuntime` (`src/modules/harness/runtime.ts:143`) is the primary case. A function that reads only `runtime.pool` takes `Pick<HarnessRuntime, "pool">`. Some code only gives the runtime to an injected dependency and never reads it, for example `watchInputDrift` (`src/server/profile_queue.ts:90-95`) and `requireRuntime` (tested at `src/server/test/http.test.ts:83`). That code takes a type parameter for the handle: its options type is generic over the handle, and the production default binds `HarnessRuntime`. Then a test gives any small value as the handle. The production callers still pass the full value, because the full type is assignable to the narrow type.
- A replacement of `globalThis.fetch` uses one helper in `src/test_support/` that gives a `typeof fetch` with no cast: it takes the fake function and borrows `preconnect` from the real `fetch` through `Object.assign`. `sealGlobalFetch` (`src/modules/refs/test/commands.test.ts:1018-1035`) already does this. An injected fetch dependency that is typed `typeof fetch` takes a plain function type, as `ClientOpts.fetch` (`src/client/api.ts:41`) does.
- An event, frame, or part double (`StampedEvent`, `BusEvent`, `ChatFrame`, `Part`) becomes a complete valid member of its union, typed by an annotation.
- An `as never` on an error value (for example `errAsync({ type: "query_failed", cause } as never)`) becomes a value of the error type that the dependency declares. Give the type arguments of `errAsync` where the compiler needs them.
- A library double (for example a `Subprocess` or a `FileHandle["read"]`) gets the same fix: the cli dependency type narrows to the members that the code calls.

Each assertion of a test stays. A double that becomes complete must not change what the test exercises.

Alternative rejected: a generic `fake<T>(partial: Partial<T>): T` helper. It needs a double cast inside, which `no-double-cast` rejects, and it hides the members that a double does not have.

### D5: A lost narrowing gets a parse, a helper, or an annotation, and the residual is listed

- A value that comes from outside the program (a file, an HTTP body, a subprocess output, an environment value) goes through a zod schema at the boundary: `JSON.parseWith` (`src/extensions/json.ext.ts`), `Response.jsonWith` (`src/extensions/response.ext.ts`), or the schema that the module already holds. A generic walk uses a generic container (`z.record(z.string(), z.unknown())`). The schema accepts each input that the current code accepts (D6).
- An errno read (`as NodeJS.ErrnoException`, about 10 sites, for example `src/client/api.ts:74` and `src/lib/lock.ts:108`) uses `errnoCode` of `src/lib/fs.ts:195`. If a site reads a field other than `code`, extend the helper in its file. Do not add a second helper.
- A membership test `(CONST as readonly string[]).includes(x)` inside a `value is T` predicate over `string` (`src/server/routes/machine.ts:372`, `src/server/routes/provenance.ts:122`, `src/lib/config.ts:363`, `src/modules/infra/setup.ts:2555`, `src/modules/infra/setup_answers.ts:1092`, `src/modules/libs/composition.ts:896`) uses one cast-free helper in `src/lib/`. The helper binds the constant to a `readonly string[]` variable (a widening that needs no cast), then calls `includes`. Each predicate calls it.
- `src/lib/log.ts:155` (`requested as pino.Level` after `Object.hasOwn(pino.levels.values, requested)`) has a different shape: `pino.levels.values` has `string` keys. It gets a constant tuple of the `pino.Level` members, checked with `satisfies readonly pino.Level[]`, and the membership helper. The accepted levels stay the same.
- A `Record<string, unknown>` cast after a `typeof x === "object"` check uses a zod parse with a generic container, or a type annotation where the compiler accepts it.
- A value that the code builds itself gets a type annotation in place of the cast (`const x: T = ...`, `satisfies T`, or a typed `Array.from`).

The residual has two kinds, and `notes.md` lists each survivor with its file, line, and invariant:

- A `SAFETY:` comment stays only on a widening that only `require-assertion-safety` reports, where no annotation can replace the cast. The comment states the invariant.
- An inline `oxlint-disable-next-line typescript/no-unsafe-type-assertion -- <reason>` stays only where no parse, guard, or type can carry the invariant. D1 is one such site. Each such site also carries a `SAFETY:` comment.

A large residual is a sign that a shape was missed, not a reason to add comments.

Alternative rejected: a `SAFETY:` comment at each site that a comment clears, and a directive at each other site. The issue names this as not the goal, and the harness rejected it.

### D6: A boundary keeps its error tolerance

A cast at a boundary is silent about malformed data. Its replacement keeps the existing handling of the module: a skip of one bad item, a default value, a `null`, or an error on the `Result` channel. No new `throw` serves a lint rule. No guard swallows a failure that the code reports today.

The boundaries that skip or tolerate one bad item today, from the scout map:

- `src/lib/otel.ts:107-130`: each pino line is parsed in a `try`, and the `catch` drops the line ("Telemetry must never break logging"). The fix parses each line with `JSON.parseWith` and a generic record schema, and it returns at `null`. The `try` and the `catch` stay around the emit.
- `src/lib/container.ts:460-475`: each pull event goes through `JSON.parseWith`, and a `null` skips the line.
- `src/client/api.ts:193-230`: a frame that is not JSON gives one `bad_json` item, and the reader continues.
- `src/modules/update/apply.ts:57-66` and `src/modules/libs/pull.ts:86-96`: a line of the wrong shape is skipped.
- Whole-file defaults on failure: `src/modules/libs/store_download.ts:1045-1054`, `src/modules/refs/store.ts:558-571`, `src/modules/prov/signing.ts:60-66`, `src/modules/infra/setup.ts:1855-1870`, `:1957-1964`, `:2046-2050`, `:2300-2302`, and `src/modules/harness/content-pack.ts:76-82` (which gives `malformed_header`).

One deviation from the rule of no behavior change is permitted. A function whose documented contract gives a `Result` and never throws can throw today on a parseable but malformed input. Then the schema parse maps that input to the existing error variant of the function, and `notes.md` lists the site. The known case is `unpackTo` (`src/modules/harness/content-pack.ts:70-87`): a header that parses to `null`, or that has an entry with a wrong field type, throws a `TypeError` today, and it gives `malformed_header` after the change. A test with a `null` header covers it.

The implementation review found more differences on malformed input. Each one is unreachable from the valid input of its boundary, and each changes no valid-input result. The reviewers voted on each one (Codex, Pi, the Claude reviewer, and the coordinator), and the majority accepted these as documented deviations:

- A config block that is not an object (`models`, `agents`, `efforts`, `harness`) starts clean in the writers of `src/modules/harness/config.ts` and `src/modules/infra/setup.ts`. Before, a spread wrote the indexes of a string or an array as keys. Dissent: Codex voted to restore the index keys. The majority (Pi, the Claude reviewer, the coordinator) kept the clean start, because the old result is not a usable config either, and restoring it needs a helper whose only job is to copy that result.
- `src/lib/otel.ts` skips a pino line that is a JSON array or `null`. Pino writes object lines only.
- `scripts/build.ts` stops with a `ZodError` when the cli or the `@opentui/core` `package.json` has no string `version`. Before, the string `undefined` went into the `bun install` command, which then failed. In the license walk, a non-string `name` or `version` or a dependency table that is not an object counts as absent, and a third-party `package.json` whose top level is `null` reads as an empty package. Before, `null` threw a `TypeError`. A top level that is an array or a scalar reads as an empty package, as before.
- `errnoCode(null)` gives `undefined` where the old cast threw a `TypeError`. A `node:fs` call throws `Error` objects only.
- A prompt value that the prompt never offers maps to a default (`src/modules/infra/setup.ts`, `src/modules/embedding/setup.ts`). Before, it passed through.
- `src/modules/embedding/local-provider.ts`: a `/tokenize` body that is JSON `null` gives the "unexpected body" message. Before, it gave the "Measuring token length ... failed" message. The `ProviderError` type and `retryable` are the same.

The review also found one difference that is not accepted: a key file of `src/modules/prov/signing.ts` whose JSON is an array or a scalar must go to the `keypair_corrupt` path and stay on disk, as before. The correction restores it.

For each such boundary that this change edits, a test feeds one malformed item between valid items (or a malformed file for a whole-file default). The test asserts that the valid items still arrive, or that the default still applies. The error-body schema of D2 gets these tests: an unknown `error` code, a `message` that is not a string, and a body that is not an object each map to `bad_json`. A body with an extra key and a `details` value maps to `http` with the body unchanged.

### D7: The order and the mid-state

The three `off` entries leave `oxlint.config.ts` first. From then on the full lint fails until the last fix group lands. The checkboxes of `tasks.md` are the record of progress. The shared abstractions (D2 readers and schema, D4 builders and the fetch helper, D5 membership helper) come in the first fix group, thus each later group uses them. Each group runs `bun --bun oxlint <paths>` on the files that it changed, and `bun run test <files>` on the test files that it changed. Only the coordinator runs the full lint, the full typecheck, and the full suite, at the close-out.

## Risks / Trade-offs

- [The route-test rewrite of D2 makes an assertion weaker] → D2 gives the replacement for each matcher form. `toHaveProperty(path, value)` keeps the equality of `toEqual`. The reviewers compare the matchers of each changed test with the diff. A test that computes on the body parses a schema, which adds a check.
- [The error-body schema rejects a body that the guard accepts (#733 W1 class)] → D2 binds the schema to the exact rule of the guard. D6 adds the malformed-body tests and the extra-key test.
- [A stricter parse removes the skip of a boundary (#733 W1)] → D6 lists the boundaries, and each edited one gets a malformed-item test.
- [A narrow parameter type hides a member that production reads] → the compiler checks it: a narrow type that misses a member that the code reads does not compile.
- [The residual grows into a comment per site] → D5 permits two survivor kinds only, and `notes.md` lists each one for the reviewers.
- [The tsgolint process of oxlint can panic one time in a run (seen in the review of #610)] → run the lint again one time. A second failure is a real failure.

## Migration Plan

No data, API, or wire format changes. Rollback is the branch.
