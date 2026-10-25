# Design

## Context

The harness lints through oxlint 1.85.0 with the
`@inflexa-ai/oxlint-plugin` preset (0.8.0). `oxlint.config.ts` carries
`syntax: { regex: false, jsonParse: false, timers: false }` on the preset
call — `forEach` stays on — and the `.tsx` override re-states its subset
with the same three lifted, because an override replaces the options of a
rule and nothing can subtract one entry — and a `.forEach`-only selection
restates one entry, so the flip below must restate the whole set. Forced
on, the three bans report 768 sites on this branch over 249 files: regex
635 (308 non-test `src`, 327 test), `JSON.parse` 80 (26 non-test across
21 `src` files, 52 test, 2 in `scripts/refresh-fixtures.ts`), timers 53
(19 non-test across 14 files, 34 test). The live forced-on run is the worklist; task 1 records
the fresh per-ban, per-directory counts into this change's `notes.md`, in
the #705 pattern.

The selectors set what may survive (plugin `restrictedSyntax`):

- regex: `Literal[regex]` plus each `RegExp` construction form. Every
  regex literal reports, a named module-level constant included, so
  naming alone saves nothing — only a disable directive survives a
  genuine pattern, and the rule message names the replacements first: a
  parser, a zod schema, a builtin that knows the grammar (`URL`,
  `URLSearchParams`, `Intl.Segmenter`, `Date.parse`), or the string
  methods.
- jsonParse: each `JSON.*parse` spelling. The rule message: parse the
  value with a schema.
- timers: each bare or member `setTimeout`/`setInterval` spelling. The
  rule message: use a wait that ends on an `AbortSignal`. An aliased
  `import { setTimeout as sleep } from "node:timers/promises"` call site
  does not match the selector, and that import is the prescribed
  signal-aware wait (`sleep(ms, undefined, { signal })`) — verified
  against the pinned plugin on this branch.

Each message names the one escape: `// oxlint-disable-next-line
eslint-js/no-restricted-syntax -- <reason>` saying why.
`reportUnusedDisableDirectives: 'error'` holds each directive to a live
report. The house style for a sanctioned pattern is
`src/input-sanitization.ts`: a named table of `{ name, pattern }`
entries, one directive per literal, each reason stating the intent.

The measured cluster leads, non-test: `input-scan/tokens.ts` 28 and
`input-scan/quarantine.ts` 15 (token-class pattern tables),
`literature/sources/arxiv.ts` 21 (XML and HTML entity unescape chains),
`citations/normalize.ts` 13 (patterns already named at module top that
still report), and the format assembly of `src/report-render` and
`src/report-model`. Test leads: `report-render/test/render.test.ts` 38,
`workflows/test/execute-analysis.test.ts` 22,
`report-render/test/chart-export.test.ts` 22,
`workspace/test/paths.test.ts` 19, `sandbox/test/mount-plan.test.ts` 18.
The `JSON.parse` sites sit one to three per file at response, row,
receipt, and file boundaries; `sandbox/exec.ts:201` and
`input-scan/enrich.ts:201` already hold the collapsed
`Schema.parse(JSON.parse(...))` form. The timer sites sit in the shared
waits (`lib/rate-limit.ts` `sleepWithSignal` 2, `lib/async-utils.ts`
`sleep` 1), the poll and timeout arms (`sandbox/exec.ts` 3,
`providers/ai-sdk.ts` 1, `tools/approval/gateway.ts`,
`tools/research/web-fetch.ts`, `tools/ad-hoc-router.ts`,
`tools/report-session/examine-page.ts`), page capture
(`lib/page-capture.ts` 2), the source polling of
`literature/sources/http.ts` 2, and single sites.
`JSON.parse` and `setTimeout` inside generated page-script strings
(`report-render/page.ts`, `report-render/table-data.ts`) are string
content, not call expressions, and do not report. The lifted `.tsx`
override hides one real site from a forced-on run that keeps it lifted:
`report-render/views/prose.tsx:34` splits prose on blank lines, and the
flip of D5 surfaces it as the only `.tsx` report.

## Goals / Non-Goals

**Goals:**

- The three options on, both configuration places flipped, zero reports
  from the live `bun run lint`, with `bun run typecheck` and `bun test`
  green.
- One abstraction per repeated shape, at the boundary that owns it; code
  is deleted, not relocated.
- Behavior preserved at each tolerant boundary: a malformed value keeps
  the module's existing handling.

**Non-Goals:**

- The rules of the other children of #607 (#709, #710): their `off`
  entries stay, and a site that only they report is not touched. A site
  that this change and another child both report is edited for this
  change's report only.
- No public interface change: nothing joins the barrel, and the
  `index.ts` surface is unchanged. The clock options of D4.2 are optional
  construction parameters with system defaults.
- No dependency and no toolchain change: zod 4.4.3, plugin 0.8.0, oxlint
  1.85.0 stay.
- The bun-types false reports in tests stay off (the #607 standing
  exception), and no fake-timer infrastructure is added.

## Decisions

### D1: The bans flip first, and the live run is the worklist

Task 1 removes the `syntax` line from the preset call, re-states
`restrictedSyntax().forEach` in the `.tsx` override, and deletes the
`#708` comment. From there `bun run lint` is red until the last group
lands — the sanctioned mid-state the #705 change set — and each later
group re-measures its own counts from the live run and closes only when
its directories report nothing. The checkboxes in `tasks.md` are the
progress record, not a green pipeline.

Alternative rejected: flip last, keep lint green throughout — progress
would be measurable only through a forced-on side config, and the final
flip would land as one unreviewable surprise.

### D2: A regex gets the fix its shape prescribes, in tier order

1. **Delete the shape.** Where one shape repeats across sites —
   whitespace collapse, entity unescape chains, trailing-punctuation
   strips, prefix and suffix cuts — one named helper in the module family
   that owns the shape, built on the string methods (`replaceAll`,
   `trim`, `split`, `slice`) so that no pattern exists at all. A helper
   that crosses module lines lives in `src/lib`; a helper of one module
   family lives beside its callers.
2. **Use what already knows the grammar.** `URL` and `URLSearchParams`
   for query and path shapes, `Date.parse` for date text,
   `Intl.Segmenter` for script detection where it fits, a zod schema
   where the value enters a boundary, and the plain string methods
   (`includes`, `startsWith`, `endsWith`, `indexOf`) where a pattern only
   restated them.
3. **Name the pattern at its home.** A pattern that none of those
   replaces moves into a named validator or matcher in the module that
   owns the concern — the `input-sanitization.ts` table shape, or a named
   constant or function whose name states what it matches and why — with
   one disable directive per literal, the reason stating the intent. The
   scattered copies are deleted; the home is the one place the pattern
   lives.
4. **Tests assert through names.** A test asserts with the string methods
   first (`toContain`, `startsWith`), through a named matcher from the
   owning module where the assertion is about a shape that production
   also matches, and through a named local matcher with its directive
   where the shape is test-only (an ISO timestamp in a recorded log line,
   say). A directive without a name that states the intent does not
   survive review.

The residual of tiers 3 and 4 is enumerated (D6), not incidental.

### D3: `JSON.parse` moves behind one schema-parse helper

One helper family in `src/lib` — a parse form and a safeParse form that
take a zod schema and the text — holds the single `JSON.parse` of the
tree, behind one directive with its reason: this is the one place that
turns text into a value, and every caller states its schema. Each
boundary passes the schema it already assumes: the domain schemas where
the shape is known (`PollResponseSchema` of `sandbox/exec.ts`,
`ReadoutLineSchema` of `input-scan/enrich.ts`, the receipt and record
parsers of `tools/sandbox/list-available-refs.ts` and
`tools/workspace/decision-record.ts`, the stored-value schemas of
`runtime/result-serialization.ts`, `state/runs.ts`, and
`lib/zod-issues.ts`), and a `z.record(z.unknown())` or `z.unknown()`
container only where the boundary genuinely walks unknown JSON (the
error-body reads of `tools/knowledge/client.ts` and `tools/lib/ctx-ops.ts`,
the probe parse of `input-scan/readout.ts`; the container form is
`z.record(z.string(), z.unknown())` or `z.unknown()`). The collapsed
`Schema.parse(JSON.parse(x))` form becomes one helper call. The error
semantics stay split as they are today: malformed text throws the
`SyntaxError` of the parse, a schema failure throws the `ZodError` that a
post-parse check already threw, and the safeParse form returns the zod
result for the boundaries that already tolerate malformed input. No
boundary gains a new throw, and no boundary that today proceeds on
unknown JSON gets a refusing schema.

One site is not a text boundary and takes no schema: the
`JSON.parse(JSON.stringify(value), reviver)` round trip of
`loop/run-agent.ts:1415` applies the NUL-stripping reviver to a harness
value it just serialized. It keeps a directive with its reason — the
plugin's own escape for a parse that cannot take a schema.

Zod's `z.json` was probed on this branch with the pinned 4.4.3: it passes
any input through unchanged, valid JSON text included, so it is not a
parser and nothing uses it.

### D4: A timer becomes a wait or a clock

One rule binds every replacement: it preserves the semantics of the arm
it replaces — the resolve-or-reject choice on abort, the rejection
reason, the cleanup on settlement, and the process-lifetime behavior
(`unref`) of a guard timer. A wait that cannot express one of those
keeps the raw timer with a directive and its reason.

1. **A shared wait ends on a signal.** `sleepWithSignal`
   (`lib/rate-limit.ts`) and `sleep` (`lib/async-utils.ts`) are rebuilt
   on `node:timers/promises` (`import { setTimeout as sleep } from
   "node:timers/promises"`) only where that preserves their exported
   contract: `sleepWithSignal` resolves for a non-positive duration
   without consulting the signal and rejects with `signal.reason`, both
   asserted by `lib/test/rate-limit.test.ts`, so it wraps the promise
   form to keep them — otherwise it keeps its hand-rolled body with a
   directive. The retry sleep of `apiFetch` flows through the injected
   `sleep` option it already takes, and the two raw timers inside
   `sleepWithSignal` go with the rewrite.
2. **A poll arm that a test must drive takes the injected clock.** The
   `InspectRunClock` shape of `tools/research/inspect-run.ts`
   — `{ now(): number; wait(ms, signal): Promise<void> }` with a
   `systemClock` default — is the established form. A module gets the
   optional clock parameter only where its test must drive the arm
   without real time; the poll loop of `sandbox/exec.ts`, which already
   takes an injected `now`, is the measured case. The parameter is
   internal — a construction option of the module, never an exported
   type. The other timer sites are waits, not clocks: the signal-less
   delay branch of `literature/sources/http.ts` and the raw default of
   the injected `deps.sleep` option of `sandbox/k8s-client.ts` are D4.1
   rebuilds, the health-poll sleep of `sandbox/docker-client.ts` and the
   single deferrals (`tools/ad-hoc-router.ts`,
   `tools/report-session/examine-page.ts`, `lib/page-capture.ts`,
   `execution/run-event-parts.ts`, `tools/approval/gateway.ts`,
   `tools/research/web-fetch.ts`) take the signal-aware form or a
   directive per D4.3, and the setup timer of
   `src/__tests__/setup/postgres.ts` is D4.4 test infrastructure.
3. **A deferral keeps its own shape.** No `setInterval` site exists in
   the measured run. The fire-and-forget arms stay what they are: the
   request-timeout guard of `providers/ai-sdk.ts:1151` aborts a
   controller, unrefs its timer, and clears on settlement — a wait
   cannot express that, so it keeps the raw timer with a directive
   naming the reason; the abort-`resolving` `sleepUntil` of
   `tools/approval/gateway.ts` keeps its resolve-on-abort contract, and
   the design rule of this section picks preserve-or-directive for each
   remaining site.
4. **Tests and test setup** use the signal-aware waits and the injected
   clocks. A test that must advance time itself gets a controllable wait
   injected; no fake-timer harness is added.

Residual enumerated (D6).

### D5: The flip is complete in both configuration places

The preset call loses its `syntax` line — all four bans default on — and
the `.tsx` override restates the whole set beside the JSX `className`
entry: `...Object.values(restrictedSyntax())`, then the `className`
entry, the subset form the plugin typing prescribes. Selecting one entry
(`restrictedSyntax().forEach`) would restate only that entry and keep
the three bans lifted on `.tsx` — the exact trap the lifted override
sits in today, and the reason the flip spreads the whole set. The stale
`#708` comment and the override's `the lifted bans stay lifted on .tsx`
comment go. No `hint` joins any ban: the rule message already names each
replacement, and a hint would name helper paths that this change may
still move.

Alternative rejected: a `syntax` line with hints — configuration surface
with no report to show for it.

### D6: The residual is enumerated and checked, not assumed

The final group sweeps the surviving directives of the three bans under
`src/` and `scripts/`: each entry names its file, its line, and the
intent its reason states, and the list goes to `notes.md`. The expected
survivors are the pattern homes of D2.3 — the token tables of
`input-scan`, the citation patterns, the sanitization patterns, each a
named table or matcher whose entries carry their intent — plus the
parsed-with-reason escapes of D3 and D4. The size signal applies outside
those homes: a directive at a site that a tier-1 or tier-2 fix, a schema
parse, or a signal-aware wait covers is a finding, and a scattering of
single-literal directives away from a home is a signal that a shape was
missed.

## Risks / Trade-offs

- [768 sites invite bulk directives] → D1 makes the live zero-report run
  the gate; D6 enumerates each survivor for the reviewers to walk; a
  directive whose reason states no intent is a finding.
- [A text helper changes boundary behavior] → each helper preserves the
  exact semantics of the shape it deletes (flags, empty input, repeated
  application); the module tests of each changed file run per group, and
  the full `bun test` run is the backstop.
- [The schema-parse helper concentrates the throw] → it changes nothing
  about the throw that `JSON.parse` or the schema parse already raises at
  each site; the safeParse form serves the boundaries that already
  tolerate malformed input, and no boundary gains a new throw.
- [A clock option widens a constructor] → the clock is an optional
  construction parameter with a system default, so no caller changes; the
  poll tests of the touched modules replace real-time waits.
- [The regex rewrite loses a subtle match] → each rewritten site keeps
  its module tests green, and the golden fixtures hold the external
  boundaries; where a pattern's edge cases are untested, the home of the
  pattern gains the case before the shape is deleted.
- [Flaky container tests] → a red `bun test` is re-run once before it
  counts as a failure (the #705 note; the baseline run of this branch
  showed one first-run hook timeout in
  `src/tasks/test/data-profile-suspension.test.ts` that passes in
  isolation and on the second full run).

## Migration Plan

One branch, one stack position: after #706, before #710. The user lands
the change as one commit of the stack, in the #609 pattern; no agent of
this workflow performs a Git action, so no merged commit carries the red
mid-state that D1 sanctions between the first and the last task group.
Rollback is the branch; no data or API migrates.
