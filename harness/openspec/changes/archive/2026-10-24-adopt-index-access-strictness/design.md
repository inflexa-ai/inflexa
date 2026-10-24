# Design

## Context

The harness typechecks and lints through three pinned tools:
`inflexa-typecheck` over `tsconfig.json` (which includes `src` and
`scripts/**/*.ts`), and oxlint 1.85.0 with the `@inflexa-ai/oxlint-plugin`
preset in `oxlint.config.ts`. Each preset rule with reports is off behind an
`off` entry that names its owning child of #607; the six entries this change
removes carry the comment `#705 turns the no-unsafe-* family and the
conditional-spread ban back on`.

Measured on plugin 0.7.0, before the bump:

- `noUncheckedIndexedAccess` fallout: 1343 type errors (387 `src` non-test,
  954 test, 2 in `scripts/refresh-fixtures.ts`); 365 of the `src` errors sit
  in `src/report-render` (294, led by `chart.ts` with 93) and
  `src/report-model` (71, led by `production-resolver.ts` with 40). No
  `__fixtures__` file carries an error.
- `no-unsafe-*` reports with the rules forced on: 253 (`no-unsafe-argument` 78,
  `-assignment` 70, `-call` 47, `-member-access` 39, `-return` 19), none from
  `src/state/migrations` or `scripts` — the missing-kysely and
  outside-tsconfig causes of the umbrella inventory no longer exist.
- `@inflexa-ai/no-conditional-spread` reports with the rule forced on: 838
  (738 in `src` non-test files).

The maintainer decision of 2026-10-23 (see proposal) sets the two flags:
`noUncheckedIndexedAccess` on, `exactOptionalPropertyTypes` off.

## Goals / Non-Goals

**Goals:**

- A typecheck program and lint rule set that hold after this change with zero
  reports, verified by `bun run lint`, `bun run typecheck`, and `bun test`.
- Fixes that state access: narrowing, guards, or a shared abstraction where a
  shape repeats.

**Non-Goals:**

- Removing the existing `!` and `as` population — #706 and #707 own those
  sweeps. This change adds none.
- Rules of other children of #607, including reports that the 0.8.0 plugin
  adds under them; they are counted for the owning child, not fixed here.
- Turning `exactOptionalPropertyTypes` on, or widening optional property types
  to `?: T | undefined` in preparation for it.

## Decisions

### D1: The flag lands before the rule flips, on a re-baselined toolchain

`@inflexa-ai/oxlint-plugin` and `@inflexa-ai/typecheck` move to exactly 0.8.0
first (`oxlint` stays 1.85.0), the lock refreshes, and lint plus typecheck run
once with the rules still off — that run is the new baseline and records any
count drift 0.8.0 causes. Then `noUncheckedIndexedAccess` enters
`tsconfig.json` and the six `off` entries leave `oxlint.config.ts`. The
mid-state fails both commands until the fix groups land; the checkboxes in
`tasks.md` are the progress record, not a green pipeline.

Alternative rejected: fix reports first on 0.7.0, bump last — the bump could
invalidate counts twice and the reviewer would see a mixed toolchain.

### D2: Index-access fallout is narrowed or restructured, never silenced

A read that can miss gets a presence check, a guard, a `??`/`?.` chain, or a
restructured access. Where one lookup shape repeats, the fix makes the
abstraction that removes the shape (umbrella #607, decision 2) — for example a
typed `first(...)`/`at(...)` helper in the module that owns the data, not
twenty local variants.

A `!` is forbidden in `src` non-test files and in `scripts`: those sites
narrow or restructure, because a new `!` in product code would rebuild the
population that #706 exists to remove. In test files, a `!` is permitted only
where the read's target is constructed in the same test or expression, so
presence is certain by construction — a checkable condition, not taste. Where
it does not hold, the site narrows or restructures like `src`. The count of
added `!` goes into `notes.md` with the permitted-use rule and the pointer
that #706 sweeps this population, so the population stays findable.

In `src`, a miss follows the module's existing failure path: a `Result` `err`
where the caller holds one, a skip where the loop tolerates absence, or the
module's existing `??` default. No new `throw` serves the flag, and a new
default value carries its reason in the change record. No `as` cast, no
`@ts-expect-error`, and no lint directive hides a new error.

### D3: Conditional spreads become direct property assignments

`exactOptionalPropertyTypes` stays off, so a missing key and an `undefined`
key mean the same to the type system, and the plugin's documented fix applies:
write the property directly. The direct form is correct only where no consumer
can observe key presence — a consumer that tests `in`, walks `Object.keys`,
or serializes the object strictly. Where presence is observable, the key must
stay absent, and the fix is the `if`-form: build the object in a named variable
and add the key inside an `if` (for example the `duplicateIds` /
`resolutionFailures` keys of `src/report-model/validate.ts`, which
`src/tools/report-session/record-version.ts` spreads onward). A site that
reaches for the `if`-form carries no comment: the named variable states it.

### D4: `no-unsafe-*` reports are typed at the source

Each report marks a value that carries `any` — a generic that lost its type
parameter, an untyped callback, an unchecked external value. The fix types the
value where it enters (a generic parameter, an explicit type, a schema parse,
a type guard), not an assertion where it is read. A boundary that hands back
external data gets a parse or a guard (the #707 direction), never a local
`as`.

### D5: The 0.8.0 drift is recorded, not absorbed silently

After the bump, the fix groups measure their own rule counts from the live
run. Counts of rules this issue does not own go into
`openspec/changes/adopt-index-access-strictness/notes.md`, each with its rule
name and count for the owning child of #607 — mostly #707, whose
SAFETY-comment rules the 0.8.0 release widens — and no site of those rules is
touched. The final report carries that table to the parent, which files it on
the owning child issues. If 0.8.0 turns up lint reports under a preset rule
that no `off` entry covers, the harness adds the entry with the comment that
names the owning child, in the #609 pattern, so the lint baseline stays green;
the six rules of this change never get such an entry. A new `bun run
typecheck` error that the 0.8.0 `@inflexa-ai/typecheck` itself introduces is
root-caused, not suppressed: if it comes from this change's scope it is fixed
here, otherwise it is recorded in `notes.md` and carried to the parent with
the rest of the drift.

## Risks / Trade-offs

- [The 1343-site fallout invites bulk `!`] → D2 forbids silencing forms; the
  implementation reviewers check the diff for new `as`/directive sites, and
  #706 later removes the `!` population that remains.
- [0.8.0 changes counts mid-flight] → D1 re-baselines before fixing, and D5
  re-measures per group; the acceptance gate is the live zero-report run, not
  the recorded 0.7.0 numbers.
- [A shared lookup abstraction can overreach] → one helper per owning module,
  made only where a shape repeats; a single site narrows in place.
- [Flaky baseline] → the first full `bun test` on this branch showed 2
  container-cold-start failures; the immediate rerun was green (6167 tests,
  0 fail). A red final suite is re-run once before it counts as a failure.

## Migration Plan

One branch, one stack position: after #703 (PR #723), before #706 and #707.
Rollback is the branch; no data or API migrates. The change lands as one
commit of the stack, in the #609 and #703 pattern, so no merged commit of the
stack carries the red mid-state that D1 sanctions between group 1 and group 6.
