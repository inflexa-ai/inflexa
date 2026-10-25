# Proposal

## Why

Umbrella #607 turns the full oxlint preset on in harness, and the non-null
block is the gate that the stack order puts after #705 and #707:
`typescript/no-non-null-assertion`,
`typescript/no-unnecessary-type-assertion`, and
`typescript/no-unnecessary-condition` sit off in `oxlint.config.ts` behind the
`#706` comment. Measured with plugin 0.8.0 on this branch (after the #705
flags and the #707 assertion work), the three rules report 2318 sites — 2141,
23, and 154 — of which about 364 sit in non-test `src`. The counts in the
issue body (1902/1253/260) come from plugin 0.7.0 before the flags: with
`noUncheckedIndexedAccess` on, an index read types as `T | undefined`, so most
"unnecessary assertion" reports became live `!` reports. This change works
from the re-measured numbers, and the live forced-on run is the worklist.

Each site is a place where code asserts a presence the compiler cannot see.
The goal is code that states its access: a lookup that can miss returns a
result or narrows, not `!`.

## What Changes

- Turn the three rules on and remove their three `off` entries and the `#706`
  comment from `oxlint.config.ts`. The `off` entries of the other children of
  #607 (#708, #709, #710) stay as they are, and no site of their rules is
  touched.
- Apply the autofix where it is exact: each assertion the compiler already
  disproves (the unnecessary-type-assertion reports, and each `!` on a
  provably non-null expression) goes by removal.
- For each remaining `!`, narrow the type, restructure the access, or record
  the invariant. Fix shapes by cluster:
  - non-test `src` (about 247 `!` sites): one shared throwing-read family in
    `src/lib/` beside the #705 idiom (`presentFirst`, `presentAt`,
    `presentLast`, `presentGet` — internal, not barrel-exported) for the
    reads whose construction guarantees them, a local binding narrowed by
    an explicit `undefined` check for the guarded reads, and per-table
    invariants at the boundary that owns the `input-scan` data
    (`shapes.ts`, `templates.ts`, `detect-sets.ts`, `tokens.ts` lead the
    population).
  - the #707 drift ledger: the 33 `!` that the archived change added — 31
    test-side same-expression construction reads and the 2 guarded production
    reads in `src/lib/zod-issues.ts` — sweep with the rest and are already
    inside the measured population.
  - test files (about 1894 `!` sites): the repeated construction-read shapes
    (`result.messages[0]!`, a map lookup of a key the test just set) import
    the same shared family; a module test helper is made only for a shape
    the family cannot carry; one-off sites narrow in place.
- Sort the `no-unnecessary-condition` reports (154) into dead code (deleted,
  with type evidence), wrong types (corrected at the source of the type),
  redundant operators (removed, expression stays), and rule false positives
  on live guards (the recorded #707 device, never a deletion). The condition
  reports lead in `src/tools/lib/openfda-client.ts`,
  `src/workflows/execute-analysis.ts`, and the `gwas-catalog-client.ts` and
  `cbioportal-client.ts` files.
- No surviving `!` and no new lint directive beyond the enumerated
  exception: `typescript/no-non-null-assertion` has no comment escape. The
  only sanctioned directives are the per-site
  `oxlint-disable-next-line no-unnecessary-condition` lines the maintainer
  rulings of 2026-10-26 grant for the closure-and-event analysis faults
  (design D2.6 enumerates the sites). Where an invariant must be recorded,
  the named helper that throws on absence carries it, and the change record
  in `notes.md` counts each such site.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `type-strictness`: adds the requirement that the three stated-access rules
  stay on and report nothing.

## Impact

- `oxlint.config.ts`: three `off` entries and the `#706` comment line removed.
- About 364 report sites in non-test `src`, led by the `input-scan` family,
  `src/citations/resolve.ts`, `src/tasks/data-profile-resolve.ts`, and the
  provider-client condition reports.
- About 1954 report sites in test files, led by
  `src/loop/test/run-agent.test.ts`, `src/sandbox/test/k8s-client.test.ts`,
  `src/memory/test/thread-history.test.ts`, and
  `src/app/test/chat-turn.test.ts` (the live report holds the counts).
- New narrowing helpers extend the `src/lib/` toolkit
  (`null-proto.ts`, `unknown-array.ts` neighbors, internal to `src/`) and
  the module test helpers for shapes the shared family cannot carry.
  `src/index.ts` exports nothing new. One enumerated #707 residual
  assertion (`src/auth/local-auth-context.ts:23`, `{} as AuthContext`)
  carries a report of this change and is swept with it.
- Gates: harness `bun run lint`, `bun run typecheck`, `bun test`; and, as the
  standing cross-stack requirement, the `cli` typecheck and the `cli` test
  suite against the working-copy linked harness (`bun run harness:local`).
