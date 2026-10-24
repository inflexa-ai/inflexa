# Design

## Context

The harness lints through oxlint 1.85.0 with the `@inflexa-ai/oxlint-plugin`
preset (0.8.0, bumped and re-baselined by the #705 change). `oxlint.config.ts`
holds one block commented `#707 turns the assertion-safety set back on.` with
three `off` entries. Forced on, the three rules report 3806 sites on this
branch — 686 in non-test `src`, 2 in `scripts/refresh-fixtures.ts`, and 3118
in test files; the live forced-on run is the worklist and the authoritative
count, the issue body's numbers come from plugin 0.7.0 and understate the
population, and task 1.1 records the fresh per-directory counts into this
change's `notes.md`.

The three rules interlock, and their mechanics set what may survive:

- `@inflexa-ai/require-assertion-safety` flags every `as` (and `<T>x`) except
  `as const`, unless a `SAFETY:` comment precedes the statement that holds
  the `as`, or precedes the `as` on its own line — a trailing comment after
  the line does not count. A comment is always an available escape.
- `typescript/no-unsafe-type-assertion` (type-aware, via tsgolint) flags each
  assertion that narrows away type-system knowledge ("type X is more narrow
  than the original type", "Unsafe assertion from `any`"). No comment
  silences it. This rule holds the issue's real teeth: a cast on unchecked
  external data cannot stay, comment or not.
- `@inflexa-ai/no-double-cast` flags every `as unknown as X` / `as any as X`
  with no escape at all. A double cast never survives this change.

So after this change the only surviving assertion is one that the compiler
can already justify (the original type is assignable to the asserted type, or
the assertion widens) and that still needs a `SAFETY:` comment naming its
invariant — a rule-1-only site. Everything else becomes a parse, a guard, a
type annotation, a builder, or a deletion. `as const` needs nothing.

The reports sort into the issue's three shapes, from the live run:

1. **External data at a boundary** (~450 src sites): vendor option walks in
   `src/report-render` (`as Record<string, unknown>`, `as EchartOption`,
   `chart-renderers.ts` and `chart.ts` lead), database rows to domain values
   in `src/state/*`, `src/tools/approval/queries.ts`, and
   `src/memory/conversation-display-storage.ts` (`row.parts as unknown[]`,
   `row.run_id as string`), the PubMed XML walk in
   `src/literature/sources/pubmed.ts`, and provider/SDK error chains in
   `src/providers/errors.ts` and `src/providers/ai-sdk.ts`.
2. **A narrowing the compiler lost** (~150 src sites): a `typeof x ===
"object"` check followed by `x as Record<string, unknown>` (the check
   exists, the cast restates it), constructions where a type annotation
   replaces the cast (`[] as EchartOption[]`), casts between related harness
   types, and the remainder of the src population (~86 sites) that the
   groups tally per file as they fix.
3. **Test doubles and test reads** (~3100 sites): the double-cast family is
   193 sites (11 in `src`, 182 in tests) — `Pool` fakes, `typeof fetch`
   fakes (56 casts to `typeof fetch`, 3 of them the dep-default casts of
   `src/providers/ai-sdk.ts`), the 10 `Frame` doubles of
   `src/contracts/test/chat-frame.test.ts`, and the four DBOS registry
   patches of `src/runtime/test/assemble.test.ts` (lines 550, 563, 654,
   672). The rest is the figure tests reading produced ECharts options
   (`option.series as EchartOption[]`, `map.top as number` — 1332 reports
   across the report-render test files alone).

## Goals / Non-Goals

**Goals:**

- The three rules on, their `off` entries gone, zero reports from the live
  `bun run lint`, with `bun run typecheck` and `bun test` green.
- One abstraction per repeated cast shape, at the boundary that owns the
  data; code is eliminated, not commented.
- Behavior preserved at each tolerant boundary: a malformed row or an
  off-shape external value keeps the module's existing handling.

**Non-Goals:**

- The rules of the other children of #607 (#706, #708, #709, #710): their
  `off` entries stay, and no site that only they report is touched. A site
  that reports both a rule of this change and a rule of another child is
  edited for this change's report only.
- The `!` population: #706 owns its removal. This change adds no `!` in
  `src` non-test files or `scripts` EXCEPT the two guarded element reads
  the final record lists (`src/lib/zod-issues.ts`, behind a length check);
  in test files a `!` is permitted only where the read's target is
  constructed in the same test or expression, the same permitted-use rule
  the #705 change set, and the final record counts them for #706. This
  change removes no `!` and uses no `@ts-expect-error`, `@ts-ignore`, or
  lint directive.
- No toolchain change: the plugin stays at 0.8.0, `oxlint` at 1.85.0.
- No public interface change beyond the one the maintainer decided on
  2026-10-25: `checkChatPart` takes `unknown` and `ChatPartCheck.ok.frame`
  (with the part-frame arm of `ChatFrame` where the passthrough feeds it)
  admits the unregistered-part record shape — the runtime already carries
  that shape there today, so the widening changes no behavior and only makes
  the type tell the truth. The ready release text ships in
  `release-note.md`, in the #704 pattern. Each other new helper stays
  internal to `src/`, and the barrel exports nothing new.

## Decisions

### D1: The rules flip first, and each group fixes one shape family

The three `off` entries and their comment leave `oxlint.config.ts` in the
first task, before any fix. The live run is then the worklist and the
acceptance gate — the recorded 0.8.0 counts only orient. The mid-state fails
`bun run lint` until the last group lands; the checkboxes in `tasks.md` are
the progress record, not a green pipeline, exactly as the #705 change ran.
Each task group owns one shape family, so each pass holds one abstraction in
its head and re-measures its own rule counts from the live run.

Alternative rejected: flip last, keep lint green throughout — progress would
then be measurable only through a forced-on side config, and the final flip
would land as one unreviewable surprise.

### D2: The fix shape follows the shape of the cast

Each report gets the fix its shape prescribes, in this order:

1. **External data at a boundary** — the boundary that owns the data gets the
   check, once: a zod schema at the place the value enters (the
   golden-fixture schema pattern; a domain schema where the shape is known,
   a generic container — `z.record(z.unknown())`, `z.array(z.unknown())` —
   where the walk is generic). Callers hold the parsed type. No local `as`
   at the read. A validator whose job is to check untrusted input takes
   `unknown` at its parameter (`checkChatPart` of `src/contracts/chat-frame.ts`
   is the type case): a negative test then passes its deliberately invalid
   literal directly, and the `as unknown as Frame` doubles of
   `chat-frame.test.ts` disappear without any escape hatch. Where the
   validator has a designed passthrough — a part of a type the registry does
   not know rides unchanged — the public check type admits the passthrough
   record (the 2026-10-25 maintainer decision; see Non-Goals and
   `release-note.md`), because no cast-free producer exists for a value the
   registry cannot name. Consumers narrow back with the exported guard: a
   `type`-discriminant predicate from the widened union to `ChatPartFrame`
   (a known-union narrowing, so it adds no #709 report); it joins the barrel
   because the cli consumes the union, under the bounded maintainer
   authorization of 2026-10-25.
2. **A narrowing the compiler lost** — replace the cast with the check it
   restated: a zod parse at the walk (D2.1), or a type annotation where the
   value is being constructed, or a deletion where the compiler already
   performed the check. A hand-written `value is T` predicate is reserved
   for narrowing a _known_ union or a related harness type — the
   `isProviderError` shape. This change adds no new predicate over an
   `unknown` or `any` parameter and no new `typeof x === "object"` probe:
   both are reports of `@inflexa-ai/no-unknown-type-guards` and
   `@inflexa-ai/no-typeof-object`, which #709 owns, and a site that this
   change cannot fix without one of them goes to `notes.md` for #709
   instead. (The existing `isUnknownArray` and `isProviderError` are
   already in that ledger; this change does not add to it.)
3. **A test double** — the fix follows who owns the interface:
    - A harness-owned interface gets one complete default builder in the test
      helper of the module that owns it (the `fake-client.ts` pattern): the
      builder constructs a full, valid value, takes overrides for the fields
      the test varies, and returns the interface type — the compiler checks
      the fake, and no cast exists.
    - The third-party `pg` `Pool` is too wide to fake honestly, so the state
      layer's `Querier` (`src/state/db.ts`) becomes the structural type that
      states what the state modules read — a `query` over a query config
      returning `rows` and `rowCount`. A real `Pool` and `PoolClient` stay
      assignable, `src/__tests__/setup/counting-querier.ts` builds its
      wrapper without its current `as unknown as Querier`, and each `{ query:
async () => … }` fake satisfies the type directly.
    - A `typeof fetch` fake returns real `Response` values
      (`new Response(body, { status })`), so the cast to `typeof fetch`
      disappears; the three dep-default casts of `ai-sdk.ts` get a typed
      option field instead.
    - The four DBOS registry patches of `assemble.test.ts` (550, 563, 654, 672) get a typed patch target. A double cast has no lawful survivor:
      every `as unknown as` / `as any as` site is eliminated — a comment, a
      builder argument, or an annotation, never another cast.
4. **A test reading produced output** — typed option accessors in one
   report-render test helper (an `EchartOption`-aware `seriesOf` /
   `optionArray` / `optionNumber` family), so the figure tests assert through
   accessors instead of casts. The src side reuses the accessors the module
   already exports (`figures/dense.ts` `seriesOf`, `axisOf`) before new ones
   are made. A test accessor fails the test when a present value has the
   wrong shape — it never filters a malformed entry away and never invents a
   default (the production `seriesOf` keeps its own tolerant contract; a
   test helper must not copy it silently).
5. **A real invariant that no type can carry** — the cast stays with a
   `SAFETY:` comment that states the invariant (the check, the contract, or
   the construction that guarantees the shape). This escape is viable only
   where rule 2 already passes the assertion — a rule-1-only site. The
   measured rule-1-only candidates under `src` are few (led by the
   `prompt-cache.ts:214` object probe); the `prompt-cache.ts:239`/`:253`
   `NonNullable<M["providerOptions"]>` casts narrow and are restructured,
   not commented. The residual is enumerated (D4), not incidental.

Alternative rejected: a `SAFETY:` comment per site — the issue names it as
not the goal, and rule 2 rejects it at each external-data site anyway.

### D3: A guard preserves the behavior it replaces

A cast on a boundary is silent about malformed data — it trusts and
proceeds. Its replacement must keep the module's existing handling, whatever
that handling is: the null of a legacy row (`runs.ts` treats a malformed
`parts` column as `null`), the drop-with-warn of the display reader, the
throw of `parseStoredDisplayEnvelope`, or the skip of a query that finds
nothing. No new `throw` serves a lint rule where today is silent, and no
guard swallows where today throws. A required column has no absence path to
preserve: the row parser refuses the row through the module's existing
refusal path (the `Result` `err` the caller holds, or the skip the loop
already tolerates) — it never coerces a wrong type and never silently nulls
a required field. Zod is the established idiom (173 importing files).

### D4: The residual is enumerated and checked, not assumed

Group 4 ends with a sweep of the surviving `as` sites of non-test `src` and
`scripts/` (excluding `as const`): each survivor carries a `SAFETY:` comment
naming its invariant, and the list — file, line, invariant — goes to
`notes.md`. The test groups close the same way in the final task, which
enumerates each survivor anywhere under `src/` and `scripts/`. The
implementation reviewers check both lists against the rule-2 mechanics: a
survivor that narrows external data is a finding. The expected size is
small; a large residual is a signal that a shape was missed, not that
comments are the answer.

### D5: Report populations owned by other children stay untouched

`typescript/no-non-null-assertion`, `no-unnecessary-condition`,
`no-unnecessary-type-assertion` (#706), `no-unknown-type-guards`,
`no-typeof-object` (#709), and the rest stay off, and no fix here exists to
serve them: a `!` never replaces an `as` (that would move the population to
#706's ledger), no new `off` entry appears for any rule, and counts this
change notices under other rules are recorded in `notes.md` for the owning
child, in the #705 D5 pattern. D2.2 states the #709 interaction for guards
explicitly. `as const` sites need nothing and keep their form.

## Risks / Trade-offs

- [3806 sites invite bulk commenting] → D1 makes the live zero-report run the
  gate; D4 makes the residual an enumerated list a reviewer can walk; rule 2
  rejects commented narrowing casts on its own.
- [A guard changes behavior at a boundary] → D3 binds each replacement to
  the module's existing handling, named per module; the full `bun test` run
  is the backstop (golden fixtures and the DB tests cover the row
  boundaries).
- [A structural `Querier` loosens the state layer] → the structural type
  states exactly what the state modules read (`query` over a config, `rows`,
  `rowCount`); the state tests and the DB-container tests hold the behavior,
  and the type stays internal to `src/state`.
- [A shared fake builder can overreach] → one builder per target interface,
  owned by the module that owns the interface; a double used once narrows in
  place with an annotation.
- [The figure-test accessor sweep is large but shallow] → about 1300 sites
  over ~32 files with one accessor family; the group re-measures after each
  directory and stops early only when the rule reports nothing there.
- [Module-global patches resist typing] → the four DBOS registry patches get
  a typed patch target; a double cast cannot survive them, so the group
  ends only when rule 3 reports nothing.
- [Flaky container tests] → the #705 note holds: a red `bun test` is re-run
  once before it counts as a failure.

## Migration Plan

One branch, one stack position: after #704, before #706. The user lands the
change as one commit of the stack, in the #609/#703/#705 pattern; no agent
of this workflow performs a Git action, so no merged commit carries the red
mid-state that D1 sanctions between the first and the last task group.
Rollback is the branch; no data or API migrates. The public widening of the
chat-part check types ships its ready text in `release-note.md` — the pull
request description carries it, and the next GitHub Release of
`@inflexa-ai/harness` holds it (no changelog file exists in the monorepo;
releases are GitHub Releases, per the #704 record).
