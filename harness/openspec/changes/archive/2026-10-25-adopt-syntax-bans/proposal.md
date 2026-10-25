# Proposal

## Why

Umbrella #607 turns the full oxlint preset on in harness, and the syntax
bans are the gate that the stack order puts after #706. Since the #609
move, the three lifted bans of `eslint-js/no-restricted-syntax` sit in
`oxlint.config.ts` behind the `#708` comment: inline regex, `JSON.parse`,
raw timers. Measured with plugin 0.8.0 on this branch, the forced-on run
reports 768 sites over 249 files: regex 635 (308 non-test `src`, 327
test), `JSON.parse` 80 (26 non-test across 21 `src` files, 52 test, 2 in
`scripts/refresh-fixtures.ts`), timers 53 (19 non-test, 34 test). Each
ban marks a place where code hides its intent: a pattern inline where no
name states what it matches, a parse that proves nothing about the value
it gives back, a timer that outlives whatever asked for it. The counts in
the issue body come from plugin 0.7.0 before the sibling merges; this
change works from the re-measured 0.8.0 numbers.

## What Changes

- Turn the three bans on: the `syntax` option leaves the preset call in
  `oxlint.config.ts` (all four bans default on, `forEach` included), and
  the `.tsx` override re-states the full `restrictedSyntax()` set beside
  the JSX `className` entry.
- Regex: each site gets a parser, a zod schema, a builtin that knows the
  grammar, or the string methods. A pattern that none of those replaces
  moves into a named validator or matcher in the module that owns the
  concern, with the pattern and its intent in the name and one disable
  directive per pattern with its reason at that home. Where one shape
  repeats, the fix makes the shared helper and deletes the shape, in the
  #607 approach.
- `JSON.parse`: the parse moves behind a schema at the boundary that owns
  the data. One shared schema-parse helper holds the single
  `JSON.parse` of the tree, each boundary passes its schema, and the
  unchecked parse disappears.
- Timers: each raw `setTimeout`/`setInterval` becomes a wait that ends on
  an `AbortSignal` (the `node:timers/promises` form), or the injected
  clock that the tests control. A timer that no wait replaces keeps a
  disable directive with its reason.
- One pull request for the whole issue. The measured regex volume — 635
  reports over the files it touches — sits below every sibling pull
  request of this stack (each of #703 through #706 landed one pull
  request over 293 to 400 files), so the task-5 split condition does not
  hold.

## Capabilities

### New Capabilities

- `syntax-bans`: the harness oxlint configuration keeps the four syntax
  bans of the preset on — inline regex, unchecked `JSON.parse`, raw
  timers, `forEach` — and the source reports nothing for them.

### Modified Capabilities

(none)

## Impact

- `harness/oxlint.config.ts`: the `syntax` line of the preset call and
  the `.tsx` override.
- 249 files: the non-test `src` clusters led by `src/input-scan`
  (`tokens.ts` 28, `quarantine.ts` 15), `src/literature/sources/arxiv.ts`
  21, `src/citations/normalize.ts` 13, and `src/report-render`; the test
  clusters led by `report-render/test/render.test.ts` 38,
  `workflows/test/execute-analysis.test.ts` 22, and
  `report-render/test/chart-export.test.ts` 22; the 80 `JSON.parse`
  boundaries and the 53 timer sites named in the design context.
- New internal helpers where shapes repeat: shared text-shape helpers,
  the schema-parse helper, the rebuilt waits of `src/lib`, and clock
  construction options on the modules whose tests must drive time.
  Nothing joins the barrel. No dependency and no toolchain change (zod
  4.4.3, plugin 0.8.0, oxlint 1.85.0 stay).
