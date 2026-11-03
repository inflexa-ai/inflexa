# Design

## Context

See proposal.md for the motivation. The facts that shape the approach:

- `cli/oxlint.config.ts:4-6` holds `const syntax = { regex: false, jsonParse: false, timers: false }` and the `#808` comment. `sharedBans` (:12) spreads `restrictedSyntax(syntax)` into each override that restates the rule, and filters out a `false` entry. The preset call takes `syntax` too (`solid({ env, syntax, overrides })`). Thus the flip is one place: no override restates a subset.
- The selectors (`@inflexa-ai/oxlint-plugin` 0.8.0, `dist/index.js:9-48`):
  - `regex` reports each regex literal, a named constant included, and each `RegExp(...)` form. A string pattern (`split(" ")`, `replaceAll("a", "b")`) does not report.
  - `jsonParse` reports each `JSON.parse` call spelling.
  - `timers` reports each `setTimeout` and `setInterval` call, bare or as a member. `clearTimeout` and an aliased import do not report.
  - One rule holds each entry. A file-level disable would also turn off the client-boundary, `NODE_ENV`, and renderer bans of the file. oxlint reports an unused directive.
- Measured on this branch (oxlint 1.85.0, the real config with the three switches on): regex 300 (110 in the source, 6 of them in `oxlint.config.ts`, 190 in the tests), `JSON.parse` 91 (21 and 70), timers 95 (39 and 56). The start list is `tmp/claude/808/sites.tsv` at the root of the repository. After task 1.1, the live lint run is the worklist.
- The helpers that exist:
  - `JSON.parseWith(raw, schema): T | null` (`src/extensions/json.ext.ts:11-23`) gives `null` on a parse error, on a schema mismatch, and on a throw from the schema.
  - `Promise.sleep(ms)` (`src/extensions/promise.ext.ts`) is a raw `setTimeout` with no cancel and no unref.
  - The test preload loads the extensions (`src/test_support/preload.ts:8`). The scripts and the walk child (`src/modules/fs/walk_child.ts`) are separate process entries that do not load them.
- `cli/CLAUDE.md` (lines 103-169): a function that can fail gives a `Result`. A new `throw` needs the approval of the user. `._unsafeUnwrap()` is permitted in a test file only. A single-caller helper stays in its file.
- On Bun 1.4.2, `jest.useFakeTimers()` controls a helper that calls the global `setTimeout` at call time, also with `.unref()`. A scratch probe on this branch showed it. `src/tui/hooks/test/notice.test.ts` and `src/tui/hooks/test/run_completion.test.ts` use fake timers.
- No cli zod schema goes to a model or to `z.toJSONSchema`. The model-facing tool inputs (`src/modules/harness/inflexa_tool.ts:518`, `inputs_tool.ts:111`, `launch_dir_tool.ts:88`) hold no regex and no refine. The two zod schemas with a regex are route inputs (`src/server/routes/artifacts.ts:28`, `src/server/routes/conversation.ts:166-170`). A route reports a refused value with `z.flattenError`, which carries the messages only (`src/server/http.ts:74-80`).
- The harness did the same work in PR #729 (issue #708). Its design is `git show 034ee5ab:harness/openspec/changes/archive/2026-10-25-adopt-syntax-bans/design.md`. Harness review #733 names two defect classes for this change: a refine that drops a JSON Schema `pattern` (section 4), and a stricter parse that removes the error tolerance of a boundary (W1).

## Goals / Non-Goals

**Goals:**

- The three bans on, zero reports from `bun run lint`, with `bun run typecheck` and `bun run test` green.
- One abstraction for each repeated shape: one parse primitive, one timer module, one text module. Code is deleted, not moved.
- Each tolerant boundary keeps its outcome for a malformed value.

**Non-Goals:**

- The rules of #809 to #811. Their `off` entries stay, and a fix adds no site for them.
- No public wire type, route response, database schema, or provenance change. No change to the harness.
- No new dependency, no fake-timer infrastructure, and no change of the oxlint or plugin version.
- No behavior change on a reachable path, also one that looks like an improvement. D7 lists the recorded differences.

## Decisions

### The reviewer record

The coordinator wrote one brief (`tmp/claude/808/decision-brief.md`) with the measurements and the options for each question. Three independent reviewers answered it. No reviewer saw the answer of another.

| Reviewer | Model | Q1 parse | Q2 test JSON | Q3 timers | Q4 test regex | Q5 config regex | Q6 route zod | Q7 source regex |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Codex | gpt-6-sol, high reasoning | A | A, `_unsafeUnwrap` | A, stop only | A | A, directive | A | A |
| Pi | `viv-issue-reviewer` flavor, medium | A | B, test helper | A, stop only | A | A, directive | A | A |
| Claude reviewer | sonnet, high effort | A | B, test helper | A, stop only | A | B, `String.raw` | A | A |
| Coordinator | claude-opus-5-5 | A | B, test helper | A, stop only | A | A, directive | A | A |

Each decision takes the majority. The dissent:

- Q2: Codex voted for `._unsafeUnwrap()` at each test site. The majority rejected it: it repeats a long call at about 70 sites, and the neverthrow `Err` that it throws prints an opaque object, not the parse or zod message.
- Q5: the Claude reviewer voted for `String.raw` strings, because `sourceSelector` only calls `pattern.toString()`. The majority rejected it: a string hides a pattern from the ban that asks for a reason, and the rewrite hand-escapes the `/` that `RegExp.toString()` escapes today.

The risks that the reviewers raised are in D1 (the build script, the throw from a schema), D2 (the file read inside a `catch`), and D6 (the ASCII digit test).

### D1: One parse primitive

`src/extensions/json.ext.ts` adds `JSON.parseResult<T>(raw: string, schema: ZodType<T>): Result<T, JsonParseError>`, with `JsonParseError = { type: "malformed"; cause: unknown } | { type: "mismatch"; error: ZodError }`. The `try` covers `JSON.parse` only. The schema runs through `safeParse` outside the `try`. Thus a throw from a refine or a transform propagates, as it does today at each site that calls `safeParse` after its parse. Such a throw is a defect of the schema, not a property of the input, and a third error kind would change the outcome of those sites. The one `JSON.parse` of the tree carries one directive: this is the one place that turns text into a value, and each caller states its schema.

`JSON.parseWith` delegates to `parseResult` and keeps its outer `catch`, thus it still gives `null` for each failure, a throw from the schema included.

A site uses the form that keeps its behavior:

- A boundary that gives `null` or a default for each failure uses `parseWith`. The reads that its `catch` covers today stay inside it.
- A site that keeps two errors, or the cause, uses `parseResult`. It maps `malformed` and `mismatch` to the error that it gives today, with the same text. The sites are `src/lib/credential.ts:126`, `src/modules/harness/content-pack.ts:82`, `src/modules/harness/plan_intake.ts:101`, `src/modules/libs/store_download.ts:420`, and `src/client/api.ts:269`.
- A site passes the schema that it applies right after the parse. Where a boundary walks unknown JSON on purpose (`client/api.ts` and its `trustWireBody`, the `readManifestLayers` walk of `store_download.ts:424`), the schema is `z.unknown()`. Where code sits between the parse and the schema, the site keeps its order and passes `z.unknown()`.
- `scripts/build.ts` imports `../src/extensions/index.ts` before its first parse. Its four manifest reads go through one local function. The function gives the value, or prints the parse or zod message and calls `process.exit(1)` (D7).

Alternatives rejected:

- The harness throwing pair in `src/lib/`. A new throw in the source needs the approval of the user, and cli gives a `Result`.
- A directive at each site that keeps two errors. It leaves `JSON.parse` in five modules.

### D2: The tolerance of a boundary stays

A boundary that tolerates malformed text today keeps the same outcome, bit for bit:

- `src/lib/config.ts:234`, `src/modules/auth/whoami.ts:70`, `src/modules/infra/setup.ts:156,1865,1963`, and `src/modules/update/notice.ts:27` keep their `null`, `false`, or default.
- `src/modules/refs/store.ts:564` and `src/modules/libs/store_download.ts:1055` keep the file read inside the `try`, thus a missing file still maps through `isMissing`. A malformed receipt still gives `{ exists: true }`, with no `receipt` key. A `receipt: undefined` key is a difference (#733, section 3) and is not permitted.
- A test of each such boundary that feeds malformed text passes unchanged. Where no test feeds malformed text, the implementor adds one before the edit.

### D3: One timer module

`src/lib/timer.ts` holds the timers of the tree:

- `runAfter(ms, fn, opts?): () => void` runs `fn` one time after `ms`, and gives the stop.
- `runEvery(ms, fn, opts?): () => void` runs `fn` each `ms`, and gives the stop.
- `withinDeadline<T>(promise, ms, opts?)` resolves to `{ kind: "settled"; value: T }` when `promise` resolves first, and to `{ kind: "timeout" }` after `ms`. A rejection of `promise` propagates. The timer clears when the race settles. It replaces the three hand-written races (`src/modules/fs/search_index.ts:831-837`, `src/modules/harness/runtime.ts:357-362`, `src/lib/otel.ts:145-150`). The round approved a stop in a `finally` for a race (Q3). The coordinator put that rule into one function, because the shape repeats in three files. The `otel.ts` timer is unref'd and stays pending today. Its clear after the race has no visible effect.
- `opts` is `{ readonly unref?: boolean }`. A site that calls `.unref()` today passes `{ unref: true }`. No other site changes its keep-alive.
- Each function calls the global `setTimeout` or `setInterval` at call time, thus `jest.useFakeTimers()` keeps its control. The two raw calls carry one directive each: this module is the one place that owns a timer handle.

`Promise.sleep` resolves through `runAfter`. A test wait `await new Promise((r) => setTimeout(r, n))` becomes `await Promise.sleep(n)`, with the same `n`, also `0`. The injected forms keep their shape, and only their production values change: `setTimer` of `src/lib/log.ts:217`, `schedule` of `src/server/profile_queue.ts:117`, and `arm` of `src/tui/hooks/sidebar_live.ts:921`.

A replacement keeps the arm order, the clear points, and the re-arm of its site. `src/modules/harness/inflexa_tool.ts:375-401` keeps each stop as a nullable variable, armed after the spawn and stopped on the same exit paths. The test of `Promise.sleep` (`src/extensions/test/extensions.test.ts:173-179`) moves to fake timers, as the `unit-test-coverage` spec says.

Alternatives rejected:

- An `AbortSignal` option (A1). No site needs a second cancel channel, and the existing injected forms already give a stop.
- A directive at each fire-and-forget timer (the harness form). It repeats about 30 directives, the shape that the loop rules remove.
- An injected clock in each module. It rewrites each module for no test that needs it.

### D4: The source regex tiers

Each source regex takes the first fix that applies:

1. **Delete the shape with a string-method helper.** A helper that two or more files use lives in `src/lib/text.ts`. A helper of one file stays in that file. The repeated shapes and their exact contracts:
   - the trailing cut `x.replace(/[set]+$/, "")` (7 sites of `/\/+$/`, `src/server/routes/fs.ts:797`): `trimTrailing(text, chars)`
   - the digit test `/^\d+$/.test(x)` (6 sites): `isAsciiDigits(text)`, true for a non-empty text whose each character is `0` to `9` (D6)
   - the whitespace split, collapse, and test with `\s` (`src/tui/keymap.ts:172,174`, `src/modules/sbom/spdx.ts:22,46`, `src/modules/refs/commands.ts:230`, `src/modules/update/apply.ts:61`, `src/tui/app.tsx:1211`, `src/modules/sbom/sbom.ts:94`, `src/modules/harness/inflexa_classify.ts:110`, `src/modules/libs/store.ts:1057`): a whitespace character is one that `String.prototype.trim` removes, the same set as `\s` (`char !== "" && char.trim() === ""`). A split helper gives the same array as `split(/\s+/)`, the empty first or last item included. Otherwise the site proves that its input cannot hold that case.
   - a single-character global replace (`/-/g`, `/</g`, `/\\/g`, `/\+/g`): `replaceAll` with a string.
   - a fixed prefix or suffix strip (`/^urn:uuid:/`, `/^W\//`, `/\r$/`, `/^ /`, `/\/v1$/`): `startsWith` or `endsWith` and `slice`.
2. **Use what already knows the grammar.** `URL`, the string methods (`includes`, `startsWith`, `endsWith`, `indexOf`), and zod at a boundary (D6). A classifier of stderr with a case-insensitive alternation becomes a list of lowercase phrases and `text.toLowerCase().includes(phrase)` (D7).
3. **Name the pattern at its home.** A protocol or grammar scanner stays a named pattern unless a string-method form is exact and no longer. Examples are these:
   - the YAML line scanners of `src/modules/infra/setup_answers.ts` and `src/modules/infra/proxy_config.ts` (with `/m`)
   - the HTTP `Range` and `Content-Disposition` forms of `src/server/routes/files.ts`
   - the entity decode of `src/modules/geo/geo.ts:184-188` (`/gi`, numeric forms)
   - the license patterns of `scripts/build.ts`.

   Each literal carries one directive. Its reason states the intent of the pattern and why no replacement applies. The constant or function name states what it matches.

The replacement keeps the semantics of the pattern: the flags (`g`, `i`, `m`), the empty input, the Unicode `\s` set, the ASCII-only `\d` and `\w`, and a repeated application. Where a pattern has an edge case with no test, the implementor adds the case to the test of its module before the edit.

The six regex literals of `oxlint.config.ts` (the `sourceSelector` arguments and `hexColor`) keep their form, each with a directive: an esquery attribute selector takes a regex, and `RegExp.toString()` gives its escaped text (Q5).

### D5: The tests

A test keeps its strength. A replacement gives the same result on each text that the code under test can produce, or a stricter one. For a `not.` assertion, the replacement matches each text that the regex matched.

- **JSON.** `src/test_support/json.ts` exports `parsedJson<T>(text: string, schema: ZodType<T>): T`. It is built on `JSON.parseResult`. A malformed text throws an `Error` with the parse message, and a mismatch throws the `ZodError`. A test that asserts on the whole value passes `z.unknown()`. `schema.parse(JSON.parse(text))` becomes `parsedJson(text, schema)`. `src/test_support/oxlint.ts:78` keeps its own error text for malformed output.
- **Timers.** D3. A producer in a test (`setInterval` feeders, a delayed abort) uses `runEvery` or `runAfter`.
- **Regex, in tier order:**
  1. The string methods: a literal pattern becomes `toContain` or `includes`. `toThrow(/X/)` becomes `toThrow("X")`. A literal with `/i` becomes a compare of the lowercase text with a lowercase literal. A count of a literal (`(s.match(/x/g) ?? []).length`) becomes a count helper on `split`. The helper lives in `src/test_support/text_shapes.ts` when two or more test files use it, else in its one file.
  2. A shared helper: a column row with `\s+` (`src/server/routes/test/usage.test.ts`, `src/cli/test/usage_command.test.ts`, `src/tui/components/dialog/test/usage_dialog.test.ts`) collapses the whitespace with the `src/lib/text.ts` helper, and then asserts `toContain("input 12.4k")`. A shape that two or more test files assert (the 64-hex token, the 6-digit hex color, the `dd/mm/yy` date) becomes a named predicate in `src/test_support/text_shapes.ts`. It is built on the string methods where they express it, else it is a named pattern with its directive.
  3. A named local matcher: a test-only shape that no string method expresses stays a named pattern in its file, with its directive. Where one file repeats one shape family, one local builder replaces the literals behind one directive. An example is the PROV-N statements with a `\w+` hole of `src/modules/prov/test/prov.test.ts`. The builder escapes the literal parts and keeps the hole class of each site (`\w+` or `[\w-]+`).
- A test edit does not remove or loosen an `expect` call. The count of `expect` calls in the source text of each changed test file stays the same or grows.

### D6: zod at a route and at a prefixed id

- A route schema replaces `.regex(pattern, message)` with one `.refine(predicate, message)` at the same position, with the same message. Thus `z.flattenError` gives the same output. The sites are `src/server/routes/artifacts.ts:28` (the `pres-` id) and `src/server/routes/conversation.ts:168`.
- The GEO accession check of `src/modules/geo/geo.ts:142` becomes a zod string schema: `startsWith("GSE")` and a refine that the rest is non-empty ASCII digits. The schema reads the text after the `trim().toUpperCase()` of `:141`, thus `gse12345` and a padded input still pass. A refused input keeps its `invalid_accession` error with the raw input. The user asked for zod where a regex validates a prefixed id. `z.templateLiteral` is not exact (it accepts `GSE-1`), thus it is not used.
- The digit predicate compares each character with `0` to `9`. `Number`, `parseInt`, and `Number.isInteger` accept `+1`, `1e3`, or white space, thus they are not a replacement for `/^\d+$/`.
- No refine replaces a regex in a schema that goes to a model or to `z.toJSONSchema`. A future schema of that kind keeps `.regex` with a directive (#733, section 4).

### D7: The recorded behavior differences

The change keeps each reachable behavior, except these:

- `scripts/build.ts`: a malformed or mismatched `package.json` ends the build with exit code 1 and the parse or zod message. Today an uncaught `SyntaxError` or `ZodError` ends it with exit code 1 and a stack.
- A stderr classifier with `/i` becomes a lowercase compare. The two forms agree on ASCII text. They differ on rare non-ASCII case forms (for example the Kelvin sign), which a stderr of `docker`, `podman`, or `psql` does not hold.

`notes.md` lists each other difference that an implementor finds, with its reason. An implementor stops and reports to the coordinator before a fix that changes a result that a test or a caller can see.

### D8: The order and the mid-state

The switches leave `oxlint.config.ts` first. From then on, the full lint fails until the last fix group lands. The checkboxes of `tasks.md` are the record of progress. The primitives and their tests come in the first group. Each group runs `bun --bun oxlint <paths>` on the files that it changed. It runs `bun run test <files>` on the test files that it changed, and on the tests of the source that it changed. Only the coordinator runs the full lint, the full typecheck, and the full suite, at the close-out. Where one shape repeats, a group works in scripted passes and then fixes the rest by hand.

`notes.md` holds the measurements, the census of each surviving directive of the three bans (file, line, and its reason), and the behavior differences. Each reason states the intent and why no replacement applies. A directive at a site that a tier-1 or tier-2 fix, a parse primitive, or a timer helper covers is a finding.

## Risks / Trade-offs

- [486 sites invite bulk directives] → D8 makes the census of each directive part of the close-out. A directive without an intent is a finding.
- [A text helper changes a result at an edge] → D4 binds each helper to the exact semantics of the shape that it deletes. Each group runs the tests of the modules that it changed.
- [A test gets weaker] → D5 binds each replacement to the same or a stricter result. The count of `expect` calls stays the same or grows.
- [A tolerant boundary loses its tolerance] → D2 names each boundary and its outcome.
- [A timer changes the life of the process] → D3 keeps the unref of each site and calls the global timer at call time.
- [A process entry without the extensions] → `scripts/build.ts` imports the loader (D1). A timer in the walk child uses `src/lib/timer.ts`, a plain import.
- [The tsgolint process of oxlint can panic one time in a run] → run the lint again one time. A second failure is a real failure.

## Migration Plan

No data, API, or wire format changes. Rollback is the branch.
