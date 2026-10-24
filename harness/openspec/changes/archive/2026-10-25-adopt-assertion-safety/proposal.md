# Proposal

## Why

Umbrella #607 turns the full oxlint preset on in harness, and the
assertion-safety block is the gate that the stack order puts after #704:
`@inflexa-ai/require-assertion-safety`, `typescript/no-unsafe-type-assertion`,
and `@inflexa-ai/no-double-cast` sit off in `oxlint.config.ts` behind the
`#707` comment. Measured with plugin 0.8.0 on this branch (after #705 and
#704), the three rules report 3806 sites — 2005, 1608, and 193 — of which 686
sit in non-test `src` and 2 in `scripts/refresh-fixtures.ts`. Each site is a place where code trusts a value without
a check: JSON from a tool, a field from a row, a shape from a test double. The
goal is not a `SAFETY:` comment per cast; where one cast shape repeats, one
parser, guard, or type at the boundary makes the casts disappear. The counts
in the issue body come from plugin 0.7.0 and understate the live population;
this change works from the re-measured 0.8.0 numbers.

## What Changes

- Turn the three rules on and remove their three `off` entries and the `#707`
  comment from `oxlint.config.ts`. The `off` entries of the other children of
  #607 (#706, #708, #709, #710) stay as they are, and no site of their rules
  is touched.
- Sort the reports by shape and make one abstraction per repeated shape, at
  the boundary that owns the data:
    - unknown and vendor option objects (`as Record<string, unknown>` walks,
      `EchartOption` reads): shared record/array guards and typed accessors.
    - database rows to domain values (`src/state/*`, approval queries,
      conversation display storage): row parsers that carry the check once per
      table boundary, with malformed rows keeping the existing
      absence-is-normal behavior.
    - provider and SDK error chains (`src/providers/errors.ts`, `ai-sdk.ts`):
      structural narrowing of known unions, following the existing
      `isProviderError` pattern.
    - test doubles (`as unknown as Pool`, `typeof fetch`, `Frame`): a
      structural `Querier` for the state layer where the third-party `Pool` is
      too wide to fake, complete default builders for harness-owned
      interfaces, and real `Response` values for `fetch` fakes.
    - validators of untrusted input (`checkChatPart`): the parameter becomes
      `unknown`, so negative tests pass literals with no cast.
    - test reads of produced chart options (`option.series as EchartOption[]`,
      `map.top as number`): typed option accessors in a report-render test
      helper.
- Keep a `SAFETY:` comment only on a cast that holds a real invariant that no
  type can carry. The residual is expected to be small; each kept site is
  recorded with its invariant.
- One public interface change, decided by the maintainer on 2026-10-25: the
  chat-part boundary stops lying about the forward-compat passthrough.
  `checkChatPart` takes `unknown` (a parameter widening, non-breaking), and
  `ChatPartCheck.ok.frame` — and the part-frame arm of `ChatFrame` where the
  passthrough feeds it — admit the unregistered-part record shape that the
  runtime already carries there. Zero runtime change. One guard joins the
  barrel — a `type`-discriminant narrowing from the widened union to
  `ChatPartFrame` — because the cli consumes the union at eight sites
  (maintainer authorization of 2026-10-25, bounded to the guard and those
  sites). The ready release text ships in `release-note.md`, in the #704
  pattern, and the pull-request description carries it. Each other new guard
  or helper stays internal to `src/`, and the barrel exports nothing new
  beyond the retypes above and that guard.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `type-strictness`: adds the requirement that the three assertion-safety
  rules stay on and report nothing.

## Impact

- `oxlint.config.ts`: three `off` entries removed.
- About 686 report sites in non-test `src` and 2 in `scripts/`, led by `src/report-render`
  (chart-renderers, chart, figures) for option walks, `src/state` for row
  parsers, `src/literature/sources/pubmed.ts` for the XML boundary, and
  `src/providers` for error chains.
- About 3118 report sites in test files: test doubles and option accessors.
- New internal helper modules (record and array guards, row parsers, fake
  builders, option accessors). One devDependency pin added:
  `@types/json-schema` (the ambient types that `@ai-sdk/provider`'s
  declarations import and that only stale pre-#609 node_modules carried —
  the PR #725 CI mechanism, recorded in notes.md). No toolchain bump: the
  plugin is already at 0.8.0 on this branch.
