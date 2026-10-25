# Design

## Context

The harness lints through oxlint with the `@inflexa-ai/oxlint-plugin` preset
(0.8.0, re-baselined by the #705 and #707 changes). `oxlint.config.ts` holds
one entry block commented `#706 turns the non-null and unnecessary-assertion
set back on.` with three `off` entries. Forced on, the three rules report
2318 sites on this branch — 2141 `no-non-null-assertion` (1894 in test
files), 154 `no-unnecessary-condition` (43 in test files), and 23
`no-unnecessary-type-assertion` (17 in test files). The issue body's counts
(1902/260/1253) predate the #705 flags and the #707 sweep: with
`noUncheckedIndexedAccess` on, an index read types as `T | undefined`, so the
old "unnecessary assertion" population moved into the live `!` population,
and #707 already deleted the `as` population. The live forced-on run is the
worklist and the authoritative count.

The three rules interlock with the three that #707 turned on:

- `typescript/no-non-null-assertion` is syntactic: it reports every `!`,
  with no comment escape. The only silencers are a lint directive or the
  removal of the `!`.
- `typescript/no-unnecessary-type-assertion` (type-aware, via tsgolint)
  reports an assertion the compiler already disproves; its fix — removal —
  is exact by definition.
- `typescript/no-unnecessary-condition` (type-aware) reports a condition the
  types make impossible: "no overlap" between compared types, an "always
  falsy" or "always truthy" operand, an unnecessary comparison between
  literal values, or a `??`/`?.` whose left side cannot be nullish. A report
  is dead code, a wrong type, a redundant operator — or a false positive of
  the rule on a live guard the type analysis cannot see through (D2.6).

The populations sort into four shapes, from the live run:

1. **Non-test `src` `!`** (~247 sites): index reads into arrays whose
   construction the same function guarantees (`src/input-scan/shapes.ts` 19,
   `src/citations/resolve.ts` 16, `src/tasks/data-profile-resolve.ts` 14,
   `templates.ts` 13, `detect-sets.ts` 11, `tokens.ts` 9), record and map
   lookups of keys set nearby, and the two guarded reads of
   `src/lib/zod-issues.ts:277,283` from the #707 drift ledger.
2. **The #707 drift ledger** (33 sites, inside the measured population): 31
   test-side same-expression construction reads and the 2 production reads
   above. The #705 design permitted a test `!` only where the read's target
   is constructed in the same test or expression; this change sweeps that
   whole population, the ledger included.
3. **Test `!`** (~1894 sites): `messages[2]!.role`, `messages.at(-1)!`,
   `provider.calls[3]!`, `planStepById["step-a"]!` — reads of values the
   test just built or collected, led by `src/loop/test/run-agent.test.ts`,
   `src/sandbox/test/k8s-client.test.ts`, `src/memory/test/thread-history.test.ts`,
   and `src/app/test/chat-turn.test.ts` (the live report holds the counts).
4. **Condition and assertion reports** (154 + 23): the condition population
   leads in `src/tools/lib/openfda-client.ts`, `src/workflows/execute-analysis.ts`,
   and the `gwas-catalog-client.ts` and `cbioportal-client.ts` files; the
   setup file `src/__tests__/setup/dbos.ts` holds 5 of the assertion
   reports. Two files inside test folders count as non-test by extension
   (`src/report-render/test/options.ts`, `src/__tests__/setup/dbos.ts`):
   the groups that own them close them, and the extension split in
   `notes.md` names this.

## Goals / Non-Goals

**Goals:**

- The three rules on, reporting nothing, with no lint directive added
  anywhere beyond the five enumerated D2.6 analysis-fault sites and no `!`
  left in `src/` or `scripts/`.
- Each fix states its access: a narrowing, a restructured access, a throwing
  read helper, a deleted dead condition, a corrected type, or a removed
  redundant operator.
- One abstraction per repeated shape, at the boundary that owns the data,
  extending the #705 idiom family before a new helper is made.
- The full gates green: harness lint, typecheck, `bun test`, and the cli
  typecheck plus cli test suite against the working-copy linked harness.

**Non-Goals:**

- No fix for any rule of another child of #607: the `off` entries of #708,
  #709, and #710 stay, and no site is reshaped to serve their rules.
- No public-surface change: `src/index.ts` exports nothing new. If a fix
  needs one, the run stops and the coordinator asks the maintainer.
- No behavior change: each replacement keeps the module's existing handling
  of absence (D3).

## Decisions

### D1: The flip comes first, and the live run is the worklist

Task 1.1 removes the three `off` entries and the `#706` comment line, so a
red `bun run lint` is the sanctioned mid-state until the last group. Each
group works from the scoped live run (`bun --bun oxlint <dirs>`) and closes
only when the three rules report nothing in its scope. The per-directory
counts land in `notes.md` as the worklist; the issue body's numbers are
recorded as history, not as targets.

### D2: The fix shape per population

A `!` asserts a presence the compiler cannot see. Each site gets the fix
that states where the presence comes from:

1. **A read the construction guarantees** — a throwing read helper names the
   guarantee and fails loudly when it is false. One shared family joins
   `src/lib/` beside `null-proto.ts` and `unknown-array.ts`, internal to
   `src/` and not exported from the barrel, in the `seriesAt`/`firstSeries`
   idiom of the #705 record. The family: `presentFirst<T>(values, what?)`,
   `presentAt<T>(values, index, what?)`, `presentLast<T>(values, what?)`,
   `presentGet<V>(source, key, what?)` (a map or record keyed read), and
   `presentFind<T>(values, predicate, what?)` (the first element the
   predicate accepts; the predicate does not narrow, per the recorded
   limitation) — each returning `T` and throwing an `Error` whose message
   carries the optional `what` description. Production and the tests import
   the same family; a module test helper is made only for a shape the
   family cannot carry (a discriminated read, a fixture builder), and the
   #705 per-file helpers keep the sites they already serve.
2. **A read a guard already protects** — bind the value once and narrow the
   binding with an explicit `undefined` check. TypeScript does not correlate
   a length check with an element read under `noUncheckedIndexedAccess`, so
   the check must read the binding itself: at `zod-issues.ts:274-277` the
   destructure `const [key, ...rest] = path` gains `if (key === undefined)
   return value;` beside the existing empty-path return, and both `key!`
   reads take the narrowed binding — same behavior, no assertion.
3. **A lookup that can miss** — restructure to the module's existing
   absence path: the `Result` `err`, the skip, the null — never a new throw
   where today is silent, and never a silent default where today throws
   (D3).
4. **A repeated parse shape** — a narrowing at the boundary that owns the
   data. The `input-scan` family (`shapes.ts`, `templates.ts`,
   `detect-sets.ts`, `tokens.ts`) reads its position/value tables through
   several distinct shapes (`family[0]!`, `values[i]!`, `rows[0]!`); the
   boundary that builds each table carries its own invariant (a tuple type,
   a length-checked binding, a D2.1 read), and a shared narrowing is made
   only where the same shape truly repeats across the family.
5. **A test reading what it just built** — the same throwing read helper
   family, imported from `src/lib/`; a one-off site narrows in place (bind,
   then let the surrounding assertion fail on absence). `?.` into a matcher
   is permitted only where the matcher itself fails when the value is
   `undefined` (the vacuous-pass rule this design states); a bare `?.` that
   would pass vacuously is never the fix.
6. **A dead condition, a wrong type, a redundant operator, or a rule false
   positive** — the condition reports sort one by one into four outcomes:
   - dead code: delete the dead part only. A condition that is always
     truthy around live statements (a test guard wrapping assertions) goes
     and the body stays; a branch that cannot execute goes and the
     condition keeps its live arm. The type evidence is recorded in
     `notes.md`.
   - a wrong type: correct it at the source of the type — the field, the
     parser, or the signature that lies — never by weakening the comparison.
     A correction that changes a type the barrel re-exports, or the output
     of a zod schema a consumer reads, stops the run for a maintainer
     ruling (the cli typecheck and the golden fixtures are the detectors).
   - a redundant operator: a `?.` or `??` whose left side cannot be nullish
     is removed and the expression stays.
   - a rule false positive: a live guard the type analysis cannot see
     through — control-flow analysis that keeps a `null` initializer across
     a closure assignment (`src/tasks/data-profile.ts:806`, the quirk the
     #707 record already met at `notes.md:771` of its archive), an
     `always truthy` on a `while (true)` loop, or a library signature that
     lies (`scripts/refresh-fixtures.ts:331`). The devices: an explicit
     wider annotation on the local (the #707-recorded form), a `for (;;)`
     rewrite of `while (true)`, or the annotation at the call site of the
     lying signature. Each such site is recorded in `notes.md` with its
     evidence, and a guard is never deleted to satisfy the rule. One
     residual class defeats every device: the closure-and-event analysis
     fault — a boolean or abort state that a closure or an event wiring
     sets and the analysis cannot see. Eight restructures were measured
     (recorded in `notes.md`); none clears it, because the analysis model
     itself keeps the initializer. For exactly five enumerated sites the
     maintainer rulings of 2026-10-26 sanction a per-site
     `oxlint-disable-next-line no-unnecessary-condition` directive in the
     `input-sanitization.ts` form, whose invariant states why the analysis
     cannot see the value: `src/tools/workspace/grep.ts` (`truncated`,
     set by the walk closures), `src/tools/display/normalize-echart-spec.ts`
     (`rotated`, set by the normalizeAxis closure), and
     `src/execution/run-event-stream.ts` at three guards (the event-wired
     `signal.aborted` re-checks, `parentDrained` set by the `parentRead`
     `.finally`, and `sawTerminal` set by the readWorkflowStream closure).
     The authorization covers exactly those five sites: a sixth site of
     this class stops the run for a new ruling — the parent files an issue
     against the analysis model rather than accumulating directives — and
     no config-level exception is made.

Alternatives rejected: `?.` everywhere (moves the absence into the type and
invites vacuous passes); `as T` for a `!` (trades one rule for another —
`@inflexa-ai/require-assertion-safety` is on, and a narrowing cast also
meets `typescript/no-unsafe-type-assertion`); an `oxlint-disable-next-line`
(the change adds no directive); keeping `!` behind a recorded invariant (the
rule has no comment escape, and the umbrella names the goal as code that
states its access).

### D3: A replacement preserves the behavior it replaces

A non-null assertion erases at runtime; it throws nothing itself. What
throws today is the dereference that follows it: `x!.y` fails when `x` is
absent, and a value that only flows on — into an argument, a comparison, a
stored field — fails nothing when absent. So the split governs the fix:

- At a site whose value is dereferenced immediately, the read fails on
  absence today; a D2.1 throwing helper keeps the failure (as an `Error`
  that names the read, not the same error class) and a narrowing in place
  keeps it exactly.
- At a site whose value flows on, the replacement adds no throw: it takes
  the module's existing absence path — the `Result` `err`, the skip, the
  null — or narrows silently with the same flow.

No new `throw` serves a lint rule where today is silent, and no replacement
swallows where today throws. A deleted dead condition must be dead for the
reason the report names (the types prove it), and the deletion goes with the
type evidence recorded in `notes.md`. The full `bun test` run — golden
fixtures, DB-container tests, integration gates — is the backstop.

### D4: The record replaces the residual

No `!` survives, so the residual is zero by construction; what `notes.md`
holds instead is the census of the sweep: the sites that became throwing
reads (production, with the guarantee each names), the dead code deleted
(with the type evidence), the types corrected, the redundant operators
removed, the rule false positives with their devices and evidence, the
drift-ledger sites swept, and any count drift noticed under rules of other
children for the owning issue. One enumerated #707 residual carries a
report of this change and is swept with it: the `{} as AuthContext` at
`src/auth/local-auth-context.ts:23` — its `SAFETY` comment goes with it, and
the archived #707 residual list shrinks by that site. The final task
verifies the diff directly: zero non-null assertion expressions under
`src/` and `scripts/` (logical negation `!x` is not an assertion and
stays), zero added lint directive beyond the five enumerated D2.6
closure-and-event analysis-fault sites, zero added
`as` outside the remaining
#707 enumerated residual (`openspec/changes/archive/2026-10-25-adopt-assertion-safety/notes.md`,
the D4 residual list), and the barrel unchanged.

### D5: Report populations owned by other children stay untouched

The `off` entries of #708, #709, and #710 stay as they are. No fix here
exists to serve their rules: a `!` never becomes an `as` (that would move
the population into the rules #707 owns), no new `off` entry appears for
any rule, and counts this change notices under other rules are recorded in
`notes.md` for the owning child, in the #705 pattern. `as const` sites need
nothing and keep their form.

### D6: The gates, cross-stack

The full suite runs once, at the end: `bun run format:file` on each changed
`src/` file, harness `bun run lint`, `bun run typecheck`, `bun test`, then
`bun run build` (so the cli gates measure a fresh `dist/` — the #707
stale-dist lesson), then in `cli/`: `bun run harness:local`, `bun run
kernel:local`, `bun run typecheck`, and the full `bun test`. A red `bun
test` is re-run once before it counts as a failure (the #705 flake note).

## Risks / Trade-offs

- [2318 sites invite a mechanical `?.` sweep] → D2.5 permits `?.` only
  behind a matcher that fails on absence; the throwing helper family is the
  default for repeated shapes; the reviewers grep for vacuous shapes.
- [A helper hides a real absence bug] → the helper throws with the
  description the site gives; a test that hits it fails loudly, and the
  production sites keep their existing absence paths (D3).
- [The condition rule reports live guards] → D2.6 sorts them as false
  positives with recorded devices; a guard is never deleted without type
  evidence, and the census in `notes.md` names each one.
- [Dead-code deletion removes wanted behavior] → D3 binds each deletion to
  the type evidence the report names; the census in `notes.md` records it;
  the full test suite is the backstop.
- [The input-scan family resists one abstraction] → its tables are read
  through several distinct shapes; the boundary that builds each table
  carries its own invariant, and a shared narrowing is made only where the
  shape truly repeats.
- [Test-helper sprawl] → one shared family in `src/lib/`; the module test
  helpers extend before duplicating.
- [Cross-stack drift in cli] → the cli gates run at the end against the
  freshly built, linked harness; any cli fallout stops the run for a
  maintainer ruling (the #707 cli-helper precedent).
- [Flaky container tests] → a red `bun test` re-runs once before counting.

## Migration Plan

One branch, one stack position: after #707, before #708. The user lands the
change as one commit of the stack, in the sibling pattern; no agent of this
workflow performs a Git action, so no merged commit carries the red
mid-state that D1 sanctions between the first and the last task group.
Rollback is the branch; no data, API, or public surface migrates. No release
note: the barrel is unchanged and no public type moves.
