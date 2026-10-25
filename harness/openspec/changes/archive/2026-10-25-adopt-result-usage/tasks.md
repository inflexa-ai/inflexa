# Tasks

## 1. The flip, the helper, and the worklist

- [x] 1.1 Delete the `#712` test-glob override of `typecheck.config.ts` —
      the comment block and the whole entry — and add `awaitOk` and
      `isResult` to the `consumers` array of the `src/**` override, with
      one comment line for each name (design D1 and D4). Make
      `src/lib/test/result-assert.ts` with the `awaitOk` helper of design
      D2, run `bun run format:file src/lib/test/result-assert.ts`, and run
      the tests of `src/lib/test/` (`bun test src/lib/test`). Run
      `bun run typecheck` and record the fresh live count into
      `openspec/changes/adopt-result-usage/notes.md` as the worklist for
      the later groups (expect exactly the 74 test-file sites of the
      forced-on run — the `isResult` entry clears the two sites of
      `src/lib/test/result.test.ts` — and nothing else; a red run is the
      sanctioned mid-state of design D1)

## 2. The src/tools pass

- [x] 2.1 Write the repeatable edit script (or batch plan) that gives each
      dropped site the wrap of design D3 — `await awaitOk(<the call>);`
      with the inner `await` removed — and run it across the 16 test files
      of `src/tools` that hold the 66 sites: `research/test/generate-plan.test.ts`
      19, `knowledge/test/knowledge-tools.test.ts` 9,
      `memory/test/update-working-memory.test.ts` 9,
      `workspace/test/execute-command.test.ts` 9,
      `report-authoring/test/authoring-tools.test.ts` 3,
      `research/test/searxng-engine.test.ts` 3,
      `research/test/context7-docs.fixtures.test.ts` 2,
      `bio/test/pubmed.test.ts` 2, `bio/test/opentargets.test.ts` 2,
      `bio/test/search-regulatory-approvals.test.ts` 2,
      `bio/test/target-safety.test.ts` 1,
      `knowledge/test/template-binding.test.ts` 1,
      `test/execute-analysis.test.ts` 1, `workspace/test/write-file.test.ts`
      1, `workspace/test/read-file.test.ts` 1 (its site keeps the
      try/catch: the throw propagates through the helper, design D3), and
      `workspace/test/workspace-display.test.ts` 1. A site that turns red
      because its call returns an `err` states its err with the tree's
      `(await x())._unsafeUnwrapErr()` form. Verify with `bun run
      typecheck` that the reports that remain sit only in the three files
      of task 2.2, run `bun run format:file` on each changed file, and
      run `bun test src/tools`

## 3. The remaining files

- [x] 3.1 Apply the same script shape to the three remaining files —
      `src/execution/test/run-synthesis.test.ts` 6,
      `src/state/test/step-executions.test.ts` 2, and
      `src/lib/test/result.test.ts` 2 (these two keep their
      `expect(isResult(...))` shape; the `consumers` entry of task 1.1
      covers them) — and verify with `bun run typecheck` that
      `must-use-result` reports nothing in the whole tree. Run
      `bun run format:file` on each changed file and run `bun test
      src/execution/test src/state/test src/lib/test`

## 4. The full gates

- [x] 4.1 Run the full harness gates one time — `bun run lint`,
      `bun run typecheck`, `bun test` in `harness/` — then the
      cross-stack gates: `bun run build` in `harness/`, `bun run
      harness:local` in `cli/` to link the working-copy harness, and
      `bun run typecheck` plus `bun test` in `cli/` against it. Record
      each result in `notes.md`
