# Tasks

## 1. Rule flip and worklist

- [x] 1.1 Delete the `syntax: { regex: false, jsonParse: false, timers:
      false }` line and its `#708` comment from the preset call in
      `oxlint.config.ts`, and change the `.tsx` override entry to spread
      the whole set beside the JSX `className` entry —
      `...Object.values(restrictedSyntax())` (design D5: a one-entry
      selection would keep the three bans lifted on `.tsx`). Run
      `bun --bun oxlint` and record the fresh per-ban, per-directory
      counts into
      `openspec/changes/adopt-syntax-bans/notes.md` as the worklist for
      the later groups (the live run stays the authority). A red
      `bun run lint` from here on is the sanctioned mid-state of design
      D1

## 2. Regex in non-test src: shared shapes and the owning modules

- [x] 2.1 Make the shared text-shape helpers of design D2.1 (whitespace
      collapse, entity unescape, punctuation strips — string methods, no
      pattern) in the module family that owns each shape, then fix each
      regex report in the non-test files of `src/input-scan`
      (`tokens.ts` 28, `quarantine.ts` 15 — named matcher tables at their
      home), `src/citations` (`normalize.ts` 13 — the named patterns get
      their directives at the home), and `src/literature`
      (`sources/arxiv.ts` 21 — the entity chains on the shared helper).
      Verify with `bun --bun oxlint src/input-scan src/citations
      src/literature` that the regex ban reports nothing in non-test
      files there, and run the module tests of the changed files
- [x] 2.2 Fix each regex report in the remaining non-test files of
      `src/report-render`, `src/report-model`, `src/tools`, `src/sandbox`,
      `src/workspace`, `src/prompts`, `src/providers`, `src/loop`,
      `src/state`, `src/contracts`, `src/agents`, `src/app`, `src/auth`,
      `src/memory`, `src/execution`, `src/input-scan` leftovers, the
      `report-render/views/*.tsx` files (`prose.tsx:34`, the one `.tsx`
      report the flip of task 1.1 surfaces), and the rest of `src`, per
      design D2 tiers 1 to 3. Verify with
      `bun --bun oxlint src` that the regex ban reports nothing in
      non-test files (reports under test files stay for task 3.1), and
      run the module tests of the changed files

## 3. Regex in test files

- [x] 3.1 Fix each regex report under the test files of `src` (327
      reports, led by `report-render/test/render.test.ts` 38,
      `workflows/test/execute-analysis.test.ts` 22,
      `report-render/test/chart-export.test.ts` 22,
      `workspace/test/paths.test.ts` 19,
      `sandbox/test/mount-plan.test.ts` 18) per design D2.4: string
      methods first, named matchers from the owning modules, named local
      matchers with their directives last. Verify with
      `bun --bun oxlint src` that the regex ban reports nothing anywhere,
      and run the module tests of the changed files

## 4. JSON.parse behind the schema

- [x] 4.1 Make the schema-parse helper family in `src/lib` (design D3:
      the single `JSON.parse` behind one directive with its reason, a
      parse form and a safeParse form; the round trip with the NUL
      reviver of `loop/run-agent.ts:1415` keeps its own directive), then
      replace each non-test `JSON.parse` report: the schema'd boundaries
      pass their schema (`sandbox/exec.ts`, `input-scan/enrich.ts`,
      `input-scan/readout.ts`, `tools/sandbox/list-available-refs.ts`,
      `tools/workspace/decision-record.ts`,
      `runtime/result-serialization.ts`, `state/runs.ts`,
      `lib/zod-issues.ts`, `tasks/extract-values.ts`,
      `report-model/production-resolver.ts`, `report-model/pin-snapshot.ts`,
      `execution/run-synthesis.ts`, `contracts/report-reference.ts`,
      `sandbox/farm.ts`, `sandbox/image-packages.ts`,
      `tools/knowledge/client.ts`, `tools/lib/amass-client.ts`,
      `tools/lib/ctx-ops.ts`, `tools/lib/__fixtures__/fixture-runner.ts`,
      `tools/report-authoring/authoring-tools.ts`,
      `scripts/refresh-fixtures.ts`), and the unknown walks pass their
      container schema. Verify with `bun --bun oxlint` that the jsonParse
      ban reports nothing in non-test files (reports under test files
      stay for task 4.2), and run the module tests of the changed files
- [x] 4.2 Replace each `JSON.parse` report in the test files and the
      `__tests__` setup with the same helper (design D3). Verify with
      `bun --bun oxlint` that the jsonParse ban reports nothing anywhere,
      and run the module tests of the changed files

## 5. Timers

- [x] 5.1 Rebuild the shared waits on `node:timers/promises` (design
      D4.1: `lib/rate-limit.ts` `sleepWithSignal` keeps its exported
      contract, `lib/async-utils.ts` `sleep`, the signal-less delay
      branch of `literature/sources/http.ts`, the raw default of the
      injected sleep option of `sandbox/k8s-client.ts`), give the poll
      loop of `sandbox/exec.ts` the optional injected clock with its
      system default (design D4.2), and settle each remaining non-test
      deferral per design D4.3 — preserve-or-directive, with the guard
      timer of `providers/ai-sdk.ts:1151` and the abort-resolving
      `sleepUntil` of `tools/approval/gateway.ts` as the named cases
      (`lib/page-capture.ts`, `execution/run-event-parts.ts`,
      `sandbox/docker-client.ts`, `tools/ad-hoc-router.ts`,
      `tools/research/web-fetch.ts`,
      `tools/report-session/examine-page.ts` the rest). Verify with
      `bun --bun oxlint` that the timers ban reports nothing in non-test
      files (reports under test files stay for task 5.2), and run the
      module tests of the changed files
- [x] 5.2 Fix the test-file and test-setup timer reports per design D4.4
      (`src/__tests__/setup/postgres.ts` included). Verify with
      `bun --bun oxlint` that the timers ban reports nothing anywhere,
      and run the module tests of the changed files

## 6. Residual sweep and the full gates

- [x] 6.1 Do the design D6 residual sweep: list each surviving directive
      of the three bans under `src/` and `scripts/` with its file, its
      line, and the intent its reason states, into `notes.md`, and make
      sure each survivor is a tier-3 or tier-4 pattern home or a genuine
      deferral or a named escape of D3 or D4. Then run the full gates one
      time: `bun run lint` (zero reports), `bun run typecheck`, and
      `bun test` in `harness/`, and the linked-harness gates in `cli/`
      (`bun run harness:local`, then the cli typecheck and the cli test
      suite, with the documented python3 guard skip — the self-skipping
      farm-parity test of `src/modules/libs/composition.test.ts`). Run
      `bun run format:file` on each `src` file the change touched, and
      make sure that `src/index.ts`, `package.json`, and the lockfile
      are unchanged and that `oxlint.config.ts` carries no ban lift in
      any entry
