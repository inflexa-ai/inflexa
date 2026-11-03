# Design

## Context

See proposal.md for the motivation. The facts that shape the approach:

- `cli/oxlint.config.ts` turns the three rules off in its last override, under the comment `#807`. The other `off` entries of that block belong to #809 and #811 and stay.
- Measured on this branch (oxlint 1.85.0), with the three rules forced on through the scratch config `tmp/claude/807/807-probe.json` at the root of the repository: `no-non-null-assertion` 626 sites (488 in tests, 138 in source), `no-unnecessary-condition` 50 (12 in tests), `no-unnecessary-type-assertion` 6 (4 in tests). The start lists are `tmp/claude/807/807-target-sites.txt`, `807-src-nonnull-lines.txt`, and `807-test-nonnull-lines.txt`. The scratch config enables the three rules only, thus the live run of the real config after task 1.1 is the worklist.
- The rule mechanics:
  - `no-non-null-assertion` is syntactic. It reports each `!` and has no comment escape. A `!` is erased at runtime. Thus `x!.y` throws a `TypeError` today when `x` is absent, and a value that only flows on (an argument, a stored field, an arithmetic operand) fails nothing today.
  - `no-unnecessary-type-assertion` reports an assertion that the compiler already proves. Its removal is exact.
  - `no-unnecessary-condition` reports a condition that the types make constant. The harness (#706) measured two limits of its analysis (`git show d74f604c:harness/openspec/changes/archive/2026-10-25-adopt-non-null-narrowing/notes.md`, lines 289-336 and 427). It keeps a `let` initializer across an assignment inside a closure or a callback. It types an initialized local from its initializer, not from its annotation.
- The source sites by shape:
  - the typed-array and byte reads of `src/modules/fs/search_index.ts` (51) and `src/modules/fs/walk_child.ts` (25), with the byte scorer `src/lib/fuzzy.ts:51,53`
  - a first element after a length check
  - an index loop or a parallel array
  - a modulo or clamped index
  - a ref, signal, or prop that a `<Show>` or a branch guards
  - a split or a regex group
  - an environment value in `scripts/build.ts:121`.
- `NameIndex.rank` scans up to 4,000,000 entries for each query (`search_index.ts:45`), and the record decode avoids an allocation for each entry (`walk_child.ts:266-268`).
- `cli/CLAUDE.md` (lines 114-127): a function that can fail gives a `Result`, and a `throw` needs explicit approval. The pre-approved throws include the exhaustive-switch default, "a programmer bug, not a runtime failure".
- The harness did the same work in PR #728 (issue #706), with the throwing family `harness/src/lib/present.ts`. Harness review #733 names the defect class to prevent: a `!` became `?? <placeholder>` (`DBOS.cancelWorkflow(DBOS.workflowID ?? "")`), which turned an absent case into a silent wrong call.
- The harness `Scope` has one member, `kind: "analysis"` (`harness/src/auth/types.ts:34-38`), and `scopeResource` always gives `resourceType: "analysis"` (`harness/src/auth/types.ts:78-80`). The harness is bundled into the cli binary.

## Goals / Non-Goals

**Goals:**

- The three rules report nothing, with no `off` entry, no directive for `no-non-null-assertion`, and no `!` left under `src/` and `scripts/`.
- Each `!` states where the presence comes from: a type, the absence path of its function, or one named invariant read.
- One abstraction for each repeated shape, and one presence helper for the tests and the source.

**Non-Goals:**

- The reports of the rules of #808 to #811. No fix adds a site for them, and no `off` entry changes for them.
- No `!` becomes an `as`, a `?? <placeholder>`, a new `x is T` predicate over `unknown`, or a new `typeof x === "object"` probe.
- No public wire type, route, database schema, or provenance change. No change to the harness.
- No behavior change on a reachable path, also one that looks like an improvement.

## Decisions

### The reviewer record

The coordinator wrote one brief (`tmp/claude/807/decision-brief.md`) with the measurements and the options for each question. Three independent reviewers answered it. No reviewer saw the answer of another.

| Reviewer | Model | Q1 helper | Q2 source failure | Q3 hot reads | Q4a outside value | Q4b `Scope` | Q4c closure flag | Q4d dead guard |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Codex | gpt-6-sol, high reasoning | A, `src/lib/` | A | A (helper, `DataView`, measure) | narrow parameter type | delete | directive as last resort | delete |
| Pi | `viv-issue-reviewer` flavor, zai/glm-5.3, high thinking | A, `src/lib/` | A | A, measure | annotated local | delete | directive as last resort | delete |
| Claude reviewer | sonnet, high effort | A, `src/lib/` | A | C, a config override | narrow parameter or typed declaration | delete | directive as last resort | delete |
| Coordinator | claude-opus-5-5 | A, `src/lib/` | A | A, measure | narrow parameter type | delete | directive as last resort | delete |

Each decision below takes the majority. The dissent:

- Q3: the Claude reviewer voted for an oxlint override that turns `no-non-null-assertion` off for the hot files. The majority rejected it, because the #608 done-when forbids a preset rule that the configuration turns off, and issue task 2 orders each `!` replaced.
- Q4a: Pi voted for an annotated local. The majority rejected it, because the harness measured that the analysis types an initialized local from its initializer, thus the report stays.
- Q2: Codex noted that the exhaustive-switch exception of `cli/CLAUDE.md` does not cover a new throw, thus the throw of D1 needs the approval of the user. The PR description names it (D3).

### D1: One presence helper in `src/lib/present.ts`

`present<T>(value: T | null | undefined, what?: string): T` gives `value` when it is not `null` or `undefined`. Otherwise it throws an `Error` whose message names the read (`<what> is absent`, with a default when `what` is absent). The file has a JSDoc block that states the rule of use: the helper serves a read whose construction guarantees presence. A lookup that can miss takes the absence path of its module (D2), because a throw there turns a handled absence into a crash. `src/lib/test/present.test.ts` tests a present value, `null`, `undefined`, a falsy present value (`0`, `""`, `false`), and the message.

Do not use `present` on an element of a `(T | undefined)[]` whose `undefined` is a legitimate value.

The tests use the helper as the issue orders:

- Each test `!` becomes `present(x)`: `present(rows[0]).id`, `present(map.get(k))`, `present(items.find(...))`, `present(result).field`.
- One exception applies to a `!` on the whole argument of `expect(...)`, with no dereference. That `!` goes with no helper when the assertion fails for an actual of `undefined` and of `null`. Examples are `toEqual(v)`, `toStrictEqual(v)`, `toMatchObject(v)`, `toBe(v)`, `toHaveLength(n)`, `toContain(v)`, and `toHaveProperty(...)`, each with an expected value that is not `null` or `undefined`. The `!` is erased at runtime, thus the test is the same. Where the assertion passes for `undefined` or `null` (a `not.` form, `toBeFalsy()`, `toBeUndefined()`, `toBeNull()`, `toBeDefined()`), use `present`.
- A `?.` is not a replacement for a `!`.

Alternatives rejected:

- The harness family of five readers (`presentFirst`, `presentAt`, `presentLast`, `presentFind`, `presentGet`). The issue orders one helper, and a generic helper covers each shape.
- An `expect`-based helper. bun-types does not narrow through `expect`, thus it needs a throw or a cast after the matcher.

### D2: The fix order for a source `!`

Each source `!` takes the first fix that applies:

1. **A type that makes the value present.** These restructures apply:
   - `for...of` or `entries()` in place of an index loop
   - a destructure with an `undefined` check in place of a `length` check (`const [first] = list` and then `if (first === undefined) return ...`)
   - `.at(-1)` with the existing empty branch
   - a field that holds the value, or a tuple type
   - a `<Show>` callback that gives the narrowed value (`<Show when={notice()}>{(n) => ...}</Show>`).
2. **The existing absence path of the function.** Its `Result` error, its `null`, its skip, or its existing fallback. For example, `src/lib/credential.ts:106` reads `segments[1]` after `segments.length !== 3` gave `null`, thus the read takes the same `null`.
3. **An invariant read.** A read that the construction guarantees and that neither step can carry uses `present(value, "<what>")`. An existing comment that states the invariant stays when it still explains the read. A comment that only justified the `!` goes or changes.

Prefer a total form over `present` in a callback where a throw is an uncaught exception: a timer (`src/lib/shutdown.ts:109`), an event handler, or a render path of `src/tui/`. Where no total form exists, `present` applies.

`scripts/build.ts:121` reads two environment values after a loop that exits on a missing variable. The loop covers the two names only when `src/lib/env.ts` bakes them, thus the presence is an invariant of that file. The script reads each value one time through `present`, with the variable name as the description. A build script is a top-level entry point, thus the throw ends the build.

Alternatives rejected:

- A new error variant on the `Result` channel of each such function (`{ type: "invariant_broken" }`). It changes each signature and each caller for a case that cannot happen.
- A directive that keeps the `!`. Issue task 2 orders each `!` replaced.

### D3: The behavior on a broken invariant, and the new throw

A replacement keeps the behavior of each reachable path:

- At a site that dereferences the value at once, today a `TypeError` follows a broken invariant. `present` throws an `Error` that names the read. A narrowing in place keeps the failure exactly.
- At a site where the value flows on, today a broken invariant passes on silently (for example `this.depths[parent]! + 1` stores 0 from `NaN`). `present` adds a throw on that path. The invariant makes the path unreachable.
- No fix swallows a failure that the code reports today, and no fix adds a `?? <placeholder>` that hides an absent case.

The throw of `present` is a new class of throw in the source. All reviewers chose it, and it has the reason of the pre-approved exhaustive-switch default: a broken invariant is a programmer bug, not a runtime failure. The PR description names this class for the approval of the user. The census of `notes.md` lists each source site that calls `present`, with its invariant.

### D4: The hot typed-array and byte reads

- `NameIndex` (`search_index.ts`) reads its parallel typed arrays through private accessor methods, one for each array (for example `depthAt(i)`, `flagsAt(i)`, `startAt(i)`, `lengthAt(i)`, `parentAt(i)`), beside the existing `depthOf`, `kindOf`, `isHidden`, and `nameOf`. Each accessor calls `present` with a constant description, thus the call makes no allocation. The heap of `rank` and the byte compare of `compareNames` read through the same shape. A field that holds the last chunk replaces `this.chunks[chunkIndex]!` after `reserve`.
- The record decode of `walk_child.ts` reads the header fields of a record through a `DataView` over the chunk or the carry (`getUint8`, `getUint16(offset, true)`, `getUint32(offset, true)`). A `DataView` read gives a `number` and throws a `RangeError` past the end. A chunk can be a view into a larger buffer, thus the view is `new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)`. The view is made one time for each chunk and one time for the carry, not for each record. A test decodes a chunk whose `byteOffset` is not 0. The tag read of a bad record stays inside the bounds that the loop keeps. The three `pop()` reads of the walk stacks use `present`. The dirent loop of `emit` uses `for...of`.
- The byte scorer of `src/lib/fuzzy.ts` uses `present` for its reads, or a restructure where one exists.
- A scratch benchmark in `tmp/claude/807/` runs before the first edit of these files. It measures the median time of `rank` on a `NameIndex` of 1,000,000 entries, with an ASCII query of one letter and of three letters. It also measures `decodeRecords` on a stream of 1,000,000 entry records. After the edit, the same benchmark runs again. `notes.md` records the input sizes and the numbers. If a median grows by more than 10%, the hottest loop binds its read and checks it inline. Then the benchmark runs again. A remaining growth above 10% goes to the coordinator with the numbers.

Alternatives rejected:

- An inline check at each read (B). It repeats one shape at about 76 sites.
- An override or a directive that keeps the `!` (C), per the dissent above.

### D5: The condition reports

Each condition report takes one of these fixes. `notes.md` records each site with its class and its evidence.

- **A value from outside the program.** Keep the guard. Correct the type at the boundary through a narrow structural parameter type (for example a function that takes `{ readonly columns?: number }` for `process.stderr` at `src/lib/shutdown.ts:113`, and one function for the optional platform flags at `src/server/routes/files.ts:33`), or through a function with a declared return type (for example a function that gives `string | undefined` from `JSON.stringify` for `src/lib/cause.ts:232`). An annotated local with an initializer does not clear the report, also when the initializer is a function.
- **A dead guard on a value that the program parsed or that a library guarantees.** Delete the dead operator or branch only, with the type evidence. The known sites: `src/tui/keymap.ts:366` (the zod schema `src/lib/config.ts:27` gives `leaderTimeout` a default), `src/server/routes/report_pages.ts:230` (the route declares `:threadId`, and Hono types the param `string`), `src/modules/infra/setup.ts:2711` (Bun types `exited` as `Promise<number>`, `bun-types/bun.d.ts:7958`, and a probe on Bun 1.4.2 gave `137` for a process that `SIGKILL` ended, with `exitCode` `null`), the dead `c ?? ""` of `src/modules/harness/dev/chat.ts:373` (the `widths[ci] ?? 0` on the same line is a live index guard and stays), and the `unref?.()` calls of `src/tui/keymap.ts:518` and `src/server/profile_queue.ts:120` (Bun gives `unref`). A deletion must be dead for the reason that the report names.
- **A guard on the one-member harness `Scope`.** Delete the guard and read the member directly: `src/modules/harness/inflexa_tool.ts:612,626`, `src/modules/harness/inputs_tool.ts:72,148`, `src/modules/harness/launch_dir_tool.ts:98`. A new member of `Scope` then breaks the compile at each such read. `scopeColumns` of `src/modules/harness/usage_recorder.ts:48-62` reads the scope directly and gives `ScopeColumns`, and the `null` arm of its caller goes. The `no_analysis` status stays, because a vanished analysis row still gives it (`launch_dir_tool.ts:105`, `inputs_tool.ts:156`). The scope is not data from outside the program: cli builds it in the process for each turn with `kind: "analysis"` (`src/modules/harness/turn.ts:127`), and the harness removed its other kind (commit `6eb70da8`). Some tests force a scope outside the type at runtime (`src/modules/harness/test/launch_dir_tool.test.ts:72-84`, `src/modules/harness/test/inflexa_tool.test.ts:57-61` with `:729-736`). Each such test stays and must pass unchanged, because its observable result stays the same through the remaining path. If one fails, stop and report to the coordinator. For a forced scope with no `analysisId`, a `store add` call then appends `--analysis` with no value. `notes.md` records this difference on an input that the type forbids.
- **A guard on a flag that a closure or a callback sets.** Keep the guard. Try the devices in this order: drop the initializer and annotate the local (`let failure: string | undefined;`, with each `!== null` read changed to the same test on `undefined`), `while (true)` to `for (;;)`, and a restructure that derives the flag with the same result. Do not restructure a single-flight or concurrency loop (`src/modules/prov/prov.ts:284`, `src/lib/container.ts:490`) past these devices. When no device clears a site, the last resort is `// oxlint-disable-next-line typescript/no-unnecessary-condition -- <why the guard is live>` on that line. `notes.md` lists each directive with the devices tried.
- **An unnecessary type assertion.** Remove it.
- **A condition in a test.** The same classes apply. A test guard that throws on a wrong shape goes only when the type of the value is trustworthy (not a JSON body, not a parse of `unknown`). Otherwise it stays through a device.

### D6: The order and the mid-state

The three `off` entries leave `oxlint.config.ts` first. From then on the full lint fails until the last fix group lands. The checkboxes of `tasks.md` are the record of progress. The helper and the baseline benchmark come in the first group. Each group runs `bun --bun oxlint <paths>` on the files that it changed. It runs `bun run test <files>` on the test files that it changed, and on the tests of the source that it changed. Only the coordinator runs the full lint, the full typecheck, and the full suite, at the close-out.

## Risks / Trade-offs

- [A test sweep makes an assertion weaker] → D1 permits two forms only: `present` and the drop of a bare `expect` argument whose assertion fails on `undefined` and `null`. No `?.` replaces a `!`. The reviewers compare the matchers of each changed test with the diff.
- [`present` hides a real absence] → D2 sends a lookup that can miss to its absence path, and `present` serves an invariant read only. The census of `notes.md` names each source site and its invariant.
- [A hot loop slows down] → D4 measures `rank` and the decode before and after, with a 10% gate.
- [A deleted guard was live] → D5 binds each deletion to the type evidence that the report names. The `Scope` deletion relies on the harness being bundled into the binary.
- [A closure-flag directive spreads] → D5 permits it only after the devices, one line at a time, each listed in `notes.md`.
- [The tsgolint process of oxlint can panic one time in a run] → run the lint again one time. A second failure is a real failure.

## Migration Plan

No data, API, or wire format changes. Rollback is the branch.
