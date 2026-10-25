# Tasks

## 1. Rule flip, shared read helpers, lib and input-scan production

- [x] 1.1 Remove the three `off` entries and the `#706` comment line from
      `oxlint.config.ts` (the entries of #708, #709, and #710 stay). Run
      `bun --bun oxlint` and record the fresh per-rule counts per directory
      into `openspec/changes/adopt-non-null-narrowing/notes.md` as the
      worklist for the later groups (the live run stays the authority). A red
      `bun run lint` from here on is the sanctioned mid-state of design D1.
      The non-test filter for the scoped runs of groups 1 to 3: exclude every
      path under `**/test/` and `**/__tests__/` (a `*.test.ts` file inside a
      test folder is already excluded; a stray `*.test.ts` outside them
      counts as test-side and is owned by the test groups)
- [x] 1.2 Make the throwing-read helper family in `src/lib/` beside
      `null-proto.ts` and `unknown-array.ts` per design D2.1
      (`presentFirst`, `presentAt`, `presentLast`, `presentGet`, each with
      an optional description for its error message, internal to `src/`),
      then fix each report of the three rules in the non-test files of
      `src/lib` — including the two guarded reads of
      `src/lib/zod-issues.ts:277,283` from the #707 drift ledger, narrowed
      by an explicit `if (key === undefined) return value;` beside the
      empty-path return, per design D2.2 — and of `src/input-scan`
      (`shapes.ts`, `templates.ts`, `detect-sets.ts`, `tokens.ts` lead; the
      boundary that builds each table carries its invariant per design
      D2.4). Verify with `bun --bun oxlint src/lib src/input-scan`
      filtered to non-test paths (the 1.1 filter) that the three rules
      report nothing there, and run the module tests of the changed files

## 2. Production sweep: citations, tasks, providers, tools, workflows

- [x] 2.1 Fix each report of the three rules in the non-test files of
      `src/citations` (led by `resolve.ts`), `src/tasks` (led by
      `data-profile-resolve.ts`), `src/providers`, `src/tools` (including the
      `openfda-client.ts` condition reports), and `src/workflows`
      (including the `execute-analysis.ts` condition reports) per design D2
      and D3. Verify with `bun --bun oxlint src/citations src/tasks
      src/providers src/tools src/workflows` that the three rules report
      nothing in non-test files there, and run the module tests of the
      changed files

## 3. Production sweep: the rest of src and scripts

- [x] 3.1 Fix each report of the three rules in the remaining non-test files
      (`src/state`, `src/memory`, `src/execution`, `src/loop`, `src/app`,
      `src/contracts`, `src/sandbox`, `src/report-render`, `src/report-model`,
      `src/workspace`, `src/runtime`, `src/reference-data`, `src/agents`,
      `src/auth`, and any other non-test file under `src/` or `scripts/`)
      per design D2 and D3. Then do the design D4 census over non-test
      files: record in `notes.md` each throwing read with the guarantee it
      names, each deleted dead condition with its type evidence, each
      corrected type, each redundant operator removed, each rule false
      positive with its device and evidence, and each drift-ledger site
      swept. Verify with `bun --bun oxlint` filtered to non-test paths (the
      1.1 filter) that the three rules report nothing there, and run the
      module tests of the changed files

## 4. Test sweep: loop and app

- [x] 4.1 Fix each report of the three rules in the test files of `src/loop`
      (led by `run-agent.test.ts`) and `src/app` (led by
      `chat-turn.test.ts`) per design D2.5: the shared throwing-read family
      for the repeated construction reads, a binding narrowed in place for
      one-off sites, and `?.` only where the matcher fails on absence.
      Verify with `bun --bun oxlint src/loop src/app` that the three rules
      report nothing there, and run the tests of the changed files

## 5. Test sweep: sandbox, tools, providers, literature

- [x] 5.1 Fix each report of the three rules in the test files of
      `src/sandbox` (led by `k8s-client.test.ts`), `src/tools`,
      `src/providers`, and `src/literature` per design D2.5. Verify with
      `bun --bun oxlint src/sandbox src/tools src/providers src/literature`
      that the three rules report nothing there, and run the tests of the
      changed files

## 6. Test sweep: memory, state, execution, citations, tasks

- [x] 6.1 Fix each report of the three rules in the test files of
      `src/memory` (led by `thread-history.test.ts`), `src/state`,
      `src/execution`, `src/citations`, `src/tasks`, and the setup files
      under `src/__tests__/` per design D2.5. Verify with `bun --bun oxlint
      src/memory src/state src/execution src/citations src/tasks
      src/__tests__` that the three rules report nothing there, and run the
      tests of the changed files

## 7. Test sweep: workflows, runtime, contracts, agents, auth

- [x] 7.1 Fix each report of the three rules in the test files of
      `src/workflows`, `src/runtime`, `src/contracts`, `src/agents`,
      `src/auth`, `src/workspace`, `src/reference-data`, and `src/input-scan`
      per design D2.5. Verify with `bun --bun oxlint` on those directories
      that the three rules report nothing there, and run the tests of the
      changed files

## 8. Test sweep: report-render, report-model, and the remainder

- [x] 8.1 Fix each remaining report of the three rules anywhere under
      `src/` — including the test files of `src/lib`, `src/provenance`,
      `src/schemas`, and `src/prompts`, the `src/report-render` and
      `src/report-model` test files, and `src/report-render/test/options.ts`
      itself (those tests reuse the option accessors of
      `src/report-render/test/options.ts` and the figure accessors of
      `src/report-render/figures/dense.ts` before new reads are made) per
      design D2.5, then verify with a full `bun --bun oxlint` that the three
      rules report nothing in the whole run, and run the tests of the
      changed files

## 9. Final verification

- [x] 9.1 Run `bun run format:file` on each changed `src/` file, then
      `bun run lint`, `bun run typecheck`, and `bun test` in `harness/` and
      verify all three pass (re-run a red `bun test` once before counting it
      as a failure, per design D6). Run `bun run build`, then in `../cli`:
      `bun run harness:local`, `bun run kernel:local`, `bun run typecheck`,
      and the full `bun test`. Close the record in `notes.md`: the final
      per-rule counts, the complete D4 census, and any count drift noticed
      under rules of other children of #607 for the owning issue. Verify the
      diff against the baseline commit: zero non-null assertion expressions
      under `src/` and `scripts/` (logical negation `!x` is not an
      assertion), zero added lint directive beyond the five enumerated D2.6
      closure-and-event analysis-fault sites (maintainer rulings of
      2026-10-26), zero added `as` outside the
      remaining #707 residual (the D4 list of
      `openspec/changes/archive/2026-10-25-adopt-assertion-safety/notes.md`,
      minus the swept `src/auth/local-auth-context.ts:23` site), the barrel
      `src/index.ts` unchanged, and the diff of `oxlint.config.ts` shows
      only the three removed `off` entries with their `#706` comment line
