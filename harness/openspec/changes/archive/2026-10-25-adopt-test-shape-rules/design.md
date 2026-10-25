# Design

## Context

The harness lints through oxlint 1.85.0 with the
`@inflexa-ai/oxlint-plugin` preset (0.8.0). `oxlint.config.ts` carries
`typescript/no-implied-eval: "off"` and `typescript/require-await:
"off"` behind the `#710` comment of the umbrella block. Forced on, the
two rules report 879 sites on this branch: `require-await` 869 over 151
files (835 in the 132 `*.test.ts` files, 18 in 13 non-test source
modules, 16 in the 6 `__fixtures__` modules of `src`),
`no-implied-eval` 10 over the 6 test files of `src/report-render/test/`.
The live forced-on run is the worklist; task 1 records the fresh counts
into this change's `notes.md`, in the #708 pattern.

`require-await` reports every `async` function whose body holds no
`await`, an `async` arrow property included. The reports fall into three
clusters. The test doubles: an `async` member of an object literal or a
standalone `async` arrow that stands in for a promise-returning function
and awaits nothing — `createContainer: async (opts) => ({...})` in
`sandbox/test/docker-client.test.ts`, the fixture client of
`agents/sandbox/__fixtures__/deps.ts` whose `exec`, `isAlive`,
`teardown`, and `listManagedSandboxes` return values with no await. The
source stand-ins: a tool `execute` body that runs synchronously
(`tools/sandbox/report-blocker.ts:82`, `execution/run-synthesis.ts:368`
and `:391`, `tools/sandbox/submit-file-metadata.ts:70`,
`tools/research/generate-plan.ts:789`,
`tools/research/generate-analogy-report.ts:67`,
`tasks/data-profile.ts:740`), the deny-by-default `Ask`
(`tools/approval/contract.ts:89`, whose body throws), the no-service
client of `tools/knowledge/index.ts:68-76`, the static eyes realization
(`lib/eyes.ts:73`), the provider middleware (`providers/ai-sdk.ts:1205`,
`transformParams`), the cancel helper's step body
(`workflows/suspension.ts:52`), and the two corpus listings that map a
constant (`lib/regulatory-corpus/fetch-fda-guidance.ts:84`,
`fetch-ich.ts:156`). The house precedent for a promise-mandated
synchronous body is `() => Promise.resolve(...)`: `runtime/boot.ts:57`
(`noopAsync`), `workflows/sandbox-step.ts:496` (`DBOS.runStep(() =>
Promise.resolve(...))`), `state/init.ts:38,43`, and the fixture chrome
of `lib/__fixtures__/chrome.ts`.

`no-implied-eval` reports each `Function` construction. Every site is a
report-render test that runs compiled page source — the string that
`render.ts`, `page.ts`, or `views/*.tsx` ships — against fake browser
globals, which is what those tests exist to do. Five shapes: the
`runWindowScript` helper (`render.test.ts:125`) and its table-data twin
(`table-data.test.ts:144`), the bootstrap runners
(`render.test.ts:130` and `:2554` for the grid), the section spy
(`render.test.ts:2241`), the named-export factory of `options.ts:131`
with its twins in `hybrid-svg.test.ts:26`,
`chart-renderers.test.ts:124`, and `chart-toolbox.test.ts:71`, and the
parse-only check (`render.test.ts:1055`,
`expect(() => new Function(LINEAGE_POPOVER)).not.toThrow()`).

## Goals / Non-Goals

**Goals:**

- Both rules on, zero reports from the live `bun run lint`, with
  `bun run typecheck` and `bun test` green in harness.
- Each double and each stand-in holds the shape of the real function it
  stands in for, so a reader learns the real contract from the double.
- The cross-stack gates stay green: the harness build feeds the linked
  package, and the cli typecheck and test suite pass against it.

**Non-Goals:**

- The rules of the other children of #607: their `off` entries stay, the
  bun-types test-glob exemption block stays, and a site that only they
  report is not touched. A file that this change edits for its own rule
  keeps the reports of the other rules as they are.
- No behavior change: no declared signature changes, no barrel change,
  no new dependency, no toolchain change.
- No sweep beyond the reported sites: a function that already awaits
  stays as it is, and no test is rewritten beyond its doubles and its
  page-script runs.

## Decisions

**D1 — The flip comes first, and a red lint is the sanctioned
mid-state.** The two `off` lines and the `#710` comment go away in task
1.1, before any fix, so each later pass verifies its cluster with the
live rule against the real tree (`bun --bun oxlint <dir>`) instead of a
scratch config. This follows the #708 pattern.

**D2 — Each `async` function that awaits nothing takes the shape its
type demands.** Where the declared type of the member, parameter, or
return is `Promise<T>`, the function drops `async` and returns
`Promise.resolve(value)` — the existing house pattern — or
`Promise.reject(err)` where the real function rejects
(`UnavailableAsk.ask`: the promise shape must stay, because a
synchronous throw of a promise-mandated member is a different failure
surface). Where the call site accepts a plain value — an untyped test
parameter or a `T | Promise<T>` union — the double drops `async` and
returns the value. The alternative of keeping `async` and adding a
token `await` states nothing and hides the shape; the alternative of
changing the interface to accept sync returns is a public API change
that #607 does not ask for.

**D3 — A double that returns nothing gains the value of the real
function first.** The rule alone would pass `() => {}` where the real
function returns a record. The issue asks for the shape of the real
function, so each double returns the value the real one returns — or a
value the test's assertions distinguish — before D2 applies. A double
of a void member returns `Promise.resolve()`.

**D4 — Each page script runs from a fixture, or keeps its directive
with the reason named.** The named-export factories
(`options.ts:131`, `hybrid-svg.test.ts:26`,
`chart-renderers.test.ts:124`, `chart-toolbox.test.ts:71`) and the
script runners (`render.test.ts:125,130,2241,2554`,
`table-data.test.ts:144`) go through one shared fixture runner of the
report-render tests that holds the single `Function` construction, with
its one
`oxlint-disable-next-line typescript/no-implied-eval -- <reason>`
directive naming why: the string is compiled page source run against
fake browser globals, the point of the test, not an eval of untrusted
input. The parse-only check at `render.test.ts:1055` keeps its site and
its directive, because it tests the parse itself and executes nothing.
The alternative of a blanket `off` in the configuration contradicts the
capability; the alternative of a directive at each of the ten sites
repeats one reason that one runner can hold.

**D5 — The page-source string modules keep their strings.** The page
scripts that ride the report page (`page.ts`, `views/*.tsx`) are string
content, not call expressions; the change touches only the test-side
runners, never the page source itself.

## Risks / Trade-offs

- [A dropped `async` changes the failure surface of a throwing body]
  → D2 keeps the promise surface where the type demands one
  (`Promise.reject` for `UnavailableAsk.ask`); the loop's dispatch
  catch already maps a throw of a tool `execute` body — synchronous or
  not — to an error tool result.
- [A double that drops `async` returns a plain value where a caller
  awaits] → `await` of a plain value is a no-op, and the caller's type
  still accepts it; the declared types are unchanged, so `bun run
  typecheck` catches any site where it does not.
- [A later child of #607 turns on `await-thenable`] → D2 keeps a real
  promise at each promise-mandated site, so no new `await-thenable`
  report appears; the test-glob exemption of the configuration already
  covers the test files.
- [A mass pass over 835 test sites regresses a test silently] → each
  pass runs the module tests of the files it changed, and the last task
  runs the full harness suite and the cli cross-gates one time.
