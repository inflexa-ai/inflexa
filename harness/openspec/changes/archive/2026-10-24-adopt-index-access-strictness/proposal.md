# Proposal

## Why

Umbrella #607 turns the full oxlint preset on in harness, and its two largest
rule families are gated by TypeScript compiler flags. Without
`noUncheckedIndexedAccess`, an index read types as the element itself, so each
`rows[0]!` is at once banned (`typescript/no-non-null-assertion`) and
"unnecessary" (`typescript/no-unnecessary-type-assertion`) — the two rules
contradict, and #706's goal ("a lookup that can miss returns a result or
narrows, not `!`") is inexpressible because the compiler says nothing can miss.
Issues #706 and #707 both declare that they need this issue first.

The maintainer decided the two flags for this issue on 2026-10-23:

- `noUncheckedIndexedAccess` is ON. It carries the umbrella: `cli` already sets
  it, it resolves the rule contradiction, and the measured fallout (1343 type
  errors on this branch) is accepted.
- `exactOptionalPropertyTypes` is OFF. It fights the preset: the documented
  direct-assignment fix for `@inflexa-ai/no-conditional-spread` holds only
  while an `undefined` value and a missing key mean the same, and widening each
  optional property to `?: T | undefined` would restore exactly that equivalence
  at the sites where the flag bites.

## What Changes

- Bump `@inflexa-ai/oxlint-plugin` and `@inflexa-ai/typecheck` from `0.7.0` to
  exactly `0.8.0` in `package.json`, refresh `bun.lock`, and re-baseline
  `bun run lint` and `bun run typecheck` before any fixing. `oxlint` stays at
  `1.85.0`. Reports that 0.8.0 adds under rules this issue does not own are
  counted and left for the owning child of #607 (mostly #707).
- Turn `noUncheckedIndexedAccess` on in `tsconfig.json`
  (`tsconfig.build.json` extends it).
- Fix the flag's type fallout by narrowing or restructuring the access. In
  `src` non-test files and in `scripts`, a `!` is forbidden: those sites
  narrow or restructure. In test files, a `!` is permitted only where the
  read's target is constructed in the same test or expression, so presence is
  certain by construction. The count of added `!`, the permitted-use rule, and
  the pointer that #706 sweeps this population go into the change record. No
  `as` cast, no `@ts-expect-error`, and no lint directive silences a new error.
- Turn `typescript/no-unsafe-call`, `-member-access`, `-assignment`,
  `-return`, `-argument` and `@inflexa-ai/no-conditional-spread` on, remove
  their `off` entries, and fix their reports. A conditional spread becomes a
  direct property assignment; the `if`-form is reserved for the rare object
  whose key truly must be absent.
- Record two verified premises instead of building them: `scripts/**/*.ts` has
  been in `tsconfig.json` since #609 (commit 28d6b427), and `kysely` 0.29.6 is
  installed, so neither contributes `no-unsafe-*` reports today.

## Capabilities

### New Capabilities

- `type-strictness`: the compiler flags and lint rules that make harness state
  its index accesses and carry no unchecked values, and the recorded reason
  `exactOptionalPropertyTypes` stays off.

### Modified Capabilities

(none — no existing spec requirement changes)

## Impact

- `tsconfig.json`, `package.json`, `bun.lock`, `oxlint.config.ts`.
- Type fallout of the flag (measured on 0.7.0 before the bump): 1343 errors —
  387 in `src` non-test files (365 of them in `src/report-render` and
  `src/report-model`, led by `src/report-render/chart.ts` with 93 and
  `src/report-model/production-resolver.ts` with 40), 954 in test files, 2 in
  `scripts/refresh-fixtures.ts`.
- `no-unsafe-*` reports (measured): 253 across `src`, none from migrations or
  scripts. `no-conditional-spread` reports (measured): 838, of which 738 in
  `src` non-test files; the 531 of the umbrella inventory predates the #703
  test move.
- Declarations are not renamed or removed, and no public type is widened by
  hand. An inferred type that indexes can widen to include `undefined` in the
  emitted declarations; task 7 verifies the cli typecheck against the linked
  working-copy harness, the same link the ci jobs use. Unlocks #706 and #707.
