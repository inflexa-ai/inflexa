# Worklist — adopt-result-usage

Fresh live run after the 1.1 flip (`bun run typecheck`,
`@inflexa-ai/typecheck` 0.8.0, branch `feat/712-harness-must-use-result`):
74 sites over 18 test files, zero outside the test files, and the two
`result.test.ts` sites clear — the live count matches the expectation.
The full output of that run sits in
`tmp/pi/typecheck-712-after-1.1.out` at the repo root.
The live run stays the authority. Baseline before the flip, measured with
a scratch on-config (`tmp/pi/typecheck-712-on.config.ts` at the repo
root, output in `tmp/pi/typecheck-712-on.out`): 76 sites over 19 test
files, zero outside the test globs. The flip of task 1.1 also adds the
`isResult` consumer, so the live mid-state after 1.1 holds 74 sites.

## `must-use-result` — 74 sites / 18 files (live after the 1.1 flip)

### src/tools (66 sites / 16 files) — task 2.1

- 19 src/tools/research/test/generate-plan.test.ts
- 9 src/tools/knowledge/test/knowledge-tools.test.ts
- 9 src/tools/memory/test/update-working-memory.test.ts
- 9 src/tools/workspace/test/execute-command.test.ts
- 3 src/tools/report-authoring/test/authoring-tools.test.ts
- 3 src/tools/research/test/searxng-engine.test.ts
- 2 src/tools/research/test/context7-docs.fixtures.test.ts
- 2 src/tools/bio/test/pubmed.test.ts
- 2 src/tools/bio/test/opentargets.test.ts
- 2 src/tools/bio/test/search-regulatory-approvals.test.ts
- 1 src/tools/bio/test/target-safety.test.ts
- 1 src/tools/knowledge/test/template-binding.test.ts
- 1 src/tools/test/execute-analysis.test.ts
- 1 src/tools/workspace/test/write-file.test.ts
- 1 src/tools/workspace/test/read-file.test.ts
- 1 src/tools/workspace/test/workspace-display.test.ts

### src/execution, src/state (8 sites / 2 files) — task 3.1

- 6 src/execution/test/run-synthesis.test.ts
- 2 src/state/test/step-executions.test.ts

(`src/lib/test/result.test.ts` holds no live site: the `isResult` consumer
of task 1.1 covers its two guard lines.)

## Baseline gates (before any edit)

- `bun run lint` in `harness/`: pass
- `bun run typecheck` in `harness/`: pass (the rule still off for the
  test globs)
- `bun test` in `harness/`: 6163 pass, 51 skip, 0 fail

## Full gates — task 4.1 (branch `feat/712-harness-must-use-result`, after 3.1)

- `bun run lint` in `harness/`: pass
- `bun run typecheck` in `harness/`: pass, zero `must-use-result` sites
- `bun test` in `harness/`: 6163 pass, 51 skip, 0 fail
- `bun run build` in `harness/`: pass
- `bun run harness:local` in `cli/`: pass (harness build and link)
- `bun run typecheck` in `cli/`: pass
- `bun test` in `cli/`: 4131 pass, 2 skip, 0 fail
