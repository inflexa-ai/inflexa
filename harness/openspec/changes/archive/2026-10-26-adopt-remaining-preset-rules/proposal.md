# Proposal

## Why

Umbrella #607 turns the full oxlint preset on in harness, and this change is
the last child of its stack: the `#609` block in `oxlint.config.ts` still
turns off each preset rule that had reports on the pinned run, and issue #709
owns every remaining entry. Measured with plugin 0.8.0 on this branch, after
the nine lower children landed, the block covers 27 rules with 1015 live
reports — 635 of them outside the test globs — so the harness still
lint-checks a minority
of the preset it ships. When this change archives, the umbrella closes and
only the bun-types test exemption stays.

## What Changes

- Remove the whole `#609`/`#709` off-block from `oxlint.config.ts`. The
  factory options apply as they stand: `typescript/explicit-function-return-
type` comes on with `allowExpressions` and `allowTypedFunctionExpressions`,
  and the factory's own `tests` glob keeps it off in the test files, which is
  the issue's "on with `off` in the tests".
- Give `@inflexa-ai/no-instanceof-error` its `allowIn` option, wired through
  the factory's `instanceofErrorAllowIn` parameter, naming the modules that
  normalize an arbitrary thrown value into an `Error`. Each other report of
  the rule is fixed: check the specific class, or narrow structurally.
- Fix each report of the other 26 rules so that the fix states its truth: a
  schema that checks something, a guard that carries the narrowing, a return
  type the function already has, a string built from named properties. Where
  a site is a deliberate pattern, the site stays and the exception carries
  the reason: an inline `oxlint-disable … -- <reason>` for a `typescript/*`
  rule, or a named file zone in `oxlint.config.ts` for an `@inflexa-ai/*`
  rule, which the plugin's architecture-directives layer keeps out of inline
  disables.
- Fix the three non-test sites behind the bun-types pair
  (`typescript/await-thenable`, `typescript/no-confusing-void-expression`)
  so their blanket off entries can go; the test-glob exemption for those two
  rules stays as the one permanent off, per the umbrella decision 6.
- Fix the true `typescript/no-deprecated` reports: the zod `.passthrough()`
  population (led by `src/sandbox/farm.ts`) moves to the zod 4
  `z.looseObject` form, and the AI SDK deprecated members (the
  `type: "file"` parts of `src/loop/tool-output.ts`, the `system` and
  `fullStream` uses of `src/providers/ai-sdk.ts`) move to the live API with
  the module tests pinning the semantics.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `type-strictness`: adds the requirement that the remaining preset rules
  report nothing, with the bun-types test exemption as the recorded
  exception.

## Impact

- `oxlint.config.ts`: the off-block is removed, `instanceofErrorAllowIn` is
  wired, and a small number of named deliberate-site zones may join the
  overrides.
- 1015 report sites across every subsystem of `src/` (635 outside the
  test globs, 380 inside them, 8 of the outside ones in
  `scripts/refresh-fixtures.ts`), led by `typescript/no-base-to-string` (241),
  `@inflexa-ai/no-empty-schema` (106), the return-type rule (89 non-test),
  `@inflexa-ai/no-typeof-object` (87), `@inflexa-ai/no-unknown-type-guards`
  (84), and `@inflexa-ai/no-instanceof-error` (80). The tail rules carry 2
  to 66 reports each.
- The carried `typescript/restrict-plus-operands` sites
  (`src/report-render/number-format.ts:499`,
  `src/report-model/production-resolver.ts:338,357`) report exactly 3 and are
  fixed here; `typescript/no-unsafe-unary-minus` reports 0 and its entry goes
  with the block.
- No public interface change is planned. The barrel exports nothing new; a
  deliberate-site zone or option is configuration, not API. The 8 reports of
  `scripts/refresh-fixtures.ts` are fixed with the same shapes.
- Gates: `bun run lint`, `bun run typecheck`, `bun test` in `harness/`, plus
  the cli typecheck and the cli test suite against the linked harness
  (cross-stack CI requirement).
