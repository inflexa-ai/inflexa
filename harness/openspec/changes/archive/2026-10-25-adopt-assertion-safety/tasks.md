# Tasks

## 1. Rule flip, shared guards, report-render and report-model src

- [x] 1.1 Remove the three `off` entries and the `#707` comment block from
      `oxlint.config.ts` (the entries of #706, #708, #709, #710 stay). Run
      `bun --bun oxlint` and record the fresh per-rule counts per directory into
      `openspec/changes/adopt-assertion-safety/notes.md` as the worklist for the
      later groups (the live run stays the authority). A red `bun run lint` from
      here on is the sanctioned mid-state of design D1
- [x] 1.2 Make the shared generic-container schemas next to
      `src/lib/unknown-array.ts` (a `z.record(z.unknown())`-shaped record schema
      and the array form the walks need — zod, not a hand predicate, per design
      D2.2), then fix each report of the three rules in the
      non-test files of `src/report-render` and `src/report-model` (led by
      `chart-renderers.ts`, `chart.ts`, `figures/dotplot.ts`, `figures/common.ts`)
      per design D2: guards and typed option accessors for the vendor-option
      walks, annotations for constructions, no new `!`, no directives. Reuse the
      option accessors the module already exports (`figures/dense.ts` `seriesOf`,
      `axisOf`) before making new ones. Verify with `bun --bun oxlint
src/report-render src/report-model` that the three rules report nothing in
      non-test files there, and that the module tests of the changed files pass

## 2. Database row boundaries

- [x] 2.1 Fix each report in the non-test files of `src/state`, `src/memory`,
      and `src/execution` per design D2 and D3: each table boundary gets one row
      parser or guard that carries the check once (`mapRunRow` and its siblings),
      a malformed value keeps the module's existing absence path, and no guard
      adds a throw. Verify with `bun --bun oxlint src/state src/memory
src/execution` that the three rules report nothing in non-test files there,
      and run the module tests of the changed files

## 3. Provider, literature, and lib boundaries

- [x] 3.1 Fix each report in the non-test files of `src/providers`
      (`errors.ts`, `ai-sdk.ts`), `src/literature` (the `pubmed.ts` XML walk),
      `src/citations`, `src/contracts`, and `src/lib` per design D2: structural
      narrowing of known unions that follows the `isProviderError` pattern for
      the error chains, a parse boundary for the PubMed record walk, container
      parses for the usage-walk entries, and the `unknown` parameter of
      `checkChatPart` (`src/contracts/chat-frame.ts:94`) so its negative tests
      pass literals with no cast. Verify with `bun --bun oxlint src/providers
src/literature src/citations src/contracts src/lib` that the three rules
      report nothing in non-test files there, and run the module tests of the
      changed files

## 4. Remaining src and scripts, residual sweep

- [x] 4.1 Fix each report in the remaining non-test files (`src/tools`,
      `src/tasks`, `src/sandbox`, `src/loop`, `src/agents`, `src/input-scan`,
      `src/workspace`, `src/workflows`, `src/runtime`, `src/reference-data`,
      `src/app`, `src/auth`, and the two sites of `scripts/refresh-fixtures.ts`)
      per design D2. Then do the design D4 residual sweep over non-test files:
      list each surviving `as` under non-test `src/` and `scripts/` (excluding
      `as const`), make sure each carries a `SAFETY:` comment naming its
      invariant, and record the list in `notes.md`. Verify with `bun --bun oxlint`
      that the three rules report nothing outside `src/**/test/` and
      `src/**/__tests__/`, and run the module tests of the changed files

## 5. The double-cast family

- [x] 5.1 Eliminate each `as unknown as` / `as any as` site (193 reports:
      11 in `src`, 182 in tests) per design D2.3, by who owns the interface:
      the structural `Querier` in `src/state/db.ts` (a `query` over a config
      returning `rows` and `rowCount`) with `counting-querier.ts` rebuilt on it,
      complete default builders for harness-owned interfaces in the test helper
      of the module that owns each interface, `fetch` fakes that return real
      `Response` values, and a typed patch target for the four DBOS registry
      patches of `src/runtime/test/assemble.test.ts` (lines 550, 563, 654,
      672). Verify with `bun --bun oxlint` that `@inflexa-ai/no-double-cast`
      reports nothing, and run the tests of the changed files

## 6. Report-render test reads

- [x] 6.1 Make the typed option-accessor family in one report-render test
      helper, then fix each remaining report of the three rules under
      `src/report-render/**/test` (the `option.series as EchartOption[]` and
      `map.top as number` population, about 1300 sites across the figure,
      gallery, chart-export, render, and hybrid-svg tests) by asserting through
      the accessors. Verify with `bun --bun oxlint src/report-render` that the
      three rules report nothing there, and run the report-render tests

## 7. Tools, memory, providers, and app tests

- [x] 7.1 Fix each remaining report of the three rules in the test files of
      `src/tools`, `src/memory`, `src/providers`, `src/app`, and
      `src/contracts` per design D2: makers and guards in the module test
      helpers for the repeated shapes, a narrowing in place for one-off sites,
      and the invalid literals of `src/contracts/test/chat-frame.test.ts` passed
      directly to the `unknown` parameter that task 3.1 gave `checkChatPart`.
      Verify with `bun --bun oxlint src/tools src/memory src/providers
src/app src/contracts` that the three rules report nothing there, and run
      the tests of the changed files

## 8. The remaining test files

- [x] 8.1 Fix each remaining report of the three rules in the test files of
      `src/workflows`, `src/execution`, `src/sandbox`, `src/runtime`, `src/tasks`,
      `src/loop`, and each remaining test file anywhere under
      `src/` per design D2. Verify with `bun --bun oxlint` that the three rules
      report nothing in the whole run, then run the tests of the changed files

## 9. Final verification

- [x] 9.1 Run `bun run format:file` on each changed `src/` file, then
      `bun run lint`, `bun run typecheck`, and `bun test` in `harness/` and
      verify all three pass (re-run a red `bun test` once before counting it as a
      failure, per design). Verify the emitted declarations stay consumable:
      `bun run build`, then `cd ../cli && bun run harness:local && bun run
typecheck` (the working-copy link that the CI jobs use; `npm install` in
      `cli` restores the pinned one). Close the record in `notes.md`: the final
      per-rule counts, the complete D4 residual list over `src/` and `scripts/`
      (non-test and test alike, excluding `as const`, each entry naming its
      invariant), and any count drift noticed under rules of other children of
      #607 for the owning issue. Verify the diff against the baseline commit:
      no added `!` outside the amended design D5 permitted forms (the two
      guarded production element reads and the test-side same-expression
      construction reads, both counted in notes.md), no added
      `@ts-expect-error`, `@ts-ignore`, or lint directive, and no new `as`
      outside the enumerated D4 residual
