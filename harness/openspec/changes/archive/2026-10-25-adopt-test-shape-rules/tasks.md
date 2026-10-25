# Tasks

## 1. Rule flip and worklist

- [x] 1.1 Delete the `#710` block of `oxlint.config.ts` — its comment and
      the `"typescript/no-implied-eval": "off"` and
      `"typescript/require-await": "off"` lines — and nothing else of the
      umbrella block or the bun-types test-glob exemption (design D1).
      Run `bun --bun oxlint` and record the fresh per-rule,
      per-directory counts into
      `openspec/changes/adopt-test-shape-rules/notes.md` as the worklist
      for the later groups (the live run stays the authority). A red
      `bun run lint` from here on is the sanctioned mid-state of design
      D1

## 2. The promise-mandated stand-ins of `src`

- [x] 2.1 Fix each of the 18 `require-await` reports of the 13 non-test
      source modules per design D2 and D3: the tool `execute` bodies of
      `tools/sandbox/report-blocker.ts`, `execution/run-synthesis.ts`
      (two sites), `tools/sandbox/submit-file-metadata.ts`,
      `tools/research/generate-plan.ts`,
      `tools/research/generate-analogy-report.ts`, and
      `tasks/data-profile.ts`; the no-service members of
      `tools/knowledge/index.ts` (five sites); the static eyes of
      `lib/eyes.ts`; the deny `ask` of `tools/approval/contract.ts`
      (`Promise.reject`); the `transformParams` middleware of
      `providers/ai-sdk.ts`; the step body of
      `workflows/suspension.ts:52`; and the constant listings of
      `lib/regulatory-corpus/fetch-fda-guidance.ts` and `fetch-ich.ts`.
      No declared signature changes. Verify with
      `bun --bun oxlint src` that `require-await` reports nothing
      outside `*.test.ts` files and `__fixtures__` directories, run
      `bun run format:file` on each changed file, and run the module
      tests of the changed files
- [x] 2.2 Fix each of the 16 `require-await` reports of the six
      `__fixtures__` modules of `src` (`agents/sandbox/__fixtures__/deps.ts`,
      `citations/__fixtures__/resolver.ts`, `lib/__fixtures__/chrome.ts`,
      `loop/__fixtures__/scripted-provider.ts`,
      `runtime/__fixtures__/construction-core.ts`,
      `tools/knowledge/__fixtures__/fake-client.ts`) per design D2 and
      D3. Verify with `bun --bun oxlint src` that `require-await`
      reports nothing outside `*.test.ts` files, run
      `bun run format:file` on each changed file, and run the module
      tests of the changed files

## 3. The test doubles

- [x] 3.1 In one scripted pass per cluster — `src/tools` then
      `src/sandbox` — write the repeatable edit script (or batch plan)
      that gives each of the 441 test-file `require-await` reports its
      shape per design D2 and D3, run it across the cluster, and verify
      with `bun --bun oxlint src/tools src/sandbox` that the rule reports
      nothing there. Run `bun run format:file` on each changed file and
      run the tests of the changed files
- [x] 3.2 In one scripted pass per cluster — `src/providers`,
      `src/loop`, `src/workflows`, `src/lib` — apply the same script
      shape to the 267 test-file reports, verify with
      `bun --bun oxlint src/providers src/loop src/workflows src/lib`
      that the rule reports nothing there, run
      `bun run format:file` on each changed file, and run the tests of
      the changed files
- [x] 3.3 In one scripted pass over the remaining directories —
      `src/citations`, `src/execution`, `src/tasks`, `src/runtime`,
      `src/agents`, `src/literature`, `src/app`, `src/workspace`,
      `src/report-model`, `src/memory`, `src/input-scan`, `src/state`,
      `src/__tests__` — apply the same script shape to the remaining 127
      test-file reports, verify with `bun --bun oxlint` that `require-await`
      reports nothing in the whole tree, run `bun run format:file` on
      each changed file, and run the tests of the changed files

## 4. The page scripts

- [x] 4.1 Make the shared fixture runner of the report-render tests
      that holds the single `Function` construction with its one
      `typescript/no-implied-eval` disable directive and its named
      reason (design D4), route the nine running sites of
      `render.test.ts` (four sites), `table-data.test.ts`,
      `hybrid-svg.test.ts`, `chart-renderers.test.ts`,
      `chart-toolbox.test.ts`, and `options.ts` through it, and give the
      parse-only check of `render.test.ts:1055` its own directive with
      its reason. Verify with `bun --bun oxlint src/report-render` that
      `no-implied-eval` reports nothing, run `bun run format:file` on
      each changed file, and run `bun test src/report-render`

## 5. The full gates

- [x] 5.1 Run the full harness gates one time — `bun run lint`,
      `bun run typecheck`, `bun test` in `harness/` — and record the
      results in `notes.md`. Then run the cross-stack gates: `bun run
      build` in `harness/`, and `bun run typecheck` plus `bun test` in
      `cli/` against the linked harness. Record each result in
      `notes.md`
