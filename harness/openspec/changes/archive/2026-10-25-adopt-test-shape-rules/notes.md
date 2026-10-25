# Worklist — adopt-test-shape-rules

Fresh live run after the 1.1 flip (`bun --bun oxlint`, oxlint 1.85.0,
plugin 0.8.0, branch `feat/710-harness-test-shape`). The live run stays
the authority.

## `typescript/require-await` — 869 sites / 151 files

### Non-test source modules (18 sites / 13 files) — task 2.1

- 5 src/tools/knowledge/index.ts
- 2 src/execution/run-synthesis.ts
- 1 src/tasks/data-profile.ts
- 1 src/tools/research/generate-plan.ts
- 1 src/tools/research/generate-analogy-report.ts
- 1 src/tools/sandbox/report-blocker.ts
- 1 src/tools/sandbox/submit-file-metadata.ts
- 1 src/tools/approval/contract.ts
- 1 src/lib/eyes.ts
- 1 src/providers/ai-sdk.ts
- 1 src/workflows/suspension.ts
- 1 src/lib/regulatory-corpus/fetch-fda-guidance.ts
- 1 src/lib/regulatory-corpus/fetch-ich.ts

### `__fixtures__` modules of src (16 sites / 6 files) — task 2.2

- 4 src/agents/sandbox/__fixtures__/deps.ts
- 4 src/tools/knowledge/__fixtures__/fake-client.ts
- 3 src/runtime/__fixtures__/construction-core.ts
- 2 src/lib/__fixtures__/chrome.ts
- 2 src/citations/__fixtures__/resolver.ts
- 1 src/loop/__fixtures__/scripted-provider.ts

### Test files (835 sites / 132 files) — tasks 3.1–3.3, by directory

- 316 src/tools
- 139 src/sandbox
- 72 src/providers
- 71 src/loop
- 67 src/workflows
- 65 src/lib
- 33 src/citations
- 29 src/execution
- 16 src/tasks
- 13 src/runtime
- 11 src/agents
- 10 src/literature
- 10 src/app
- 6 src/workspace
- 4 src/report-model
- 3 src/memory
- 2 src/input-scan
- 1 src/state
- 1 src/__tests__

Largest test files: preview-report.test.ts 91, docker-client.test.ts 72,
ai-sdk.test.ts 65, run-agent.test.ts 34, execute-analysis.test.ts 33.

## `typescript/no-implied-eval` — 10 sites / 6 files — task 4.1

All in src/report-render/test/: render.test.ts ×5, options.ts,
hybrid-svg.test.ts, chart-renderers.test.ts, chart-toolbox.test.ts,
table-data.test.ts ×1 each.

## Task 4.1 result

New shared runner: `src/report-render/test/page-function.ts`. It holds the
single `Function` construction with its one
`oxlint-disable-next-line typescript/no-implied-eval` directive, and gives
`runPageScript(params, args, script)` for the scripts that run against fake
browser globals and `pageExports(params, args, source, exports)` for the
source that returns named exports. The parse-only check at
render.test.ts:1057 keeps its own construction and directive, because it
tests the parse itself and executes nothing.

`bun --bun oxlint src/report-render` reports nothing. `bun test
src/report-render` gives 1104 pass / 0 fail / 28 skip.

## Task 5.1 result — full gates, branch feat/710-harness-test-shape

Run from harness/:

- `bun run lint` — pass (0 reports).
- `bun run typecheck` — pass.
- `bun test` — 6163 pass / 0 fail / 51 skip (74.60 s). One earlier run in
  the same session showed 2 fails that a second deliberate run did not
  show; the clean run matches the measured baseline of the review packet.
- `bun run build` — pass.
- `../cli`: `bun run typecheck` — pass.
- `../cli`: `bun test` — 4131 pass / 0 fail / 2 skip (111.73 s), against
  the working-copy harness link at
  `../cli/node_modules/@inflexa-ai/harness -> ../../../harness`.
