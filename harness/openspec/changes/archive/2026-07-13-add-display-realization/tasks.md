# Tasks — display realization (harness side)

Companion CLI change: `cli/openspec/changes/add-display-realization` (consumes
the renamed parts and `dataPath`).

## 1. Spec

- [x] `openspec validate add-display-realization --strict` passes
- [x] Review before implementation

## 2. Rename data-preview → data-report-preview

- [x] `src/contracts/chat-parts.ts`: rename the two part types (+ doc comments)
- [x] `src/contracts/schemas/chat-parts.ts`: rename the two zod literals
- [x] `src/contracts/part-registry.ts`: rename the two registry keys
- [x] `src/contracts/message.ts`: update the doc example (`case "data-preview"`)
- [x] `src/tools/iterate-report.ts`: all emit sites (success + the three failure emits)
- [x] `src/tools/report/submit-report.ts`: doc comment
- [x] `src/memory/card-builders.ts` + `src/memory/reconstruct-cards.ts`: reconstruction emits the new part type
- [x] Sweep tests + prompts for the literal `data-preview` and update
- [x] Note the **BREAKING** rename for contracts-barrel consumers (react-client) in the change description / release notes

## 3. show_user dataPath

- [x] Lift `show_file`'s `validatePath` into a shared module (single source for path shape rules)
- [x] `src/tools/display/show-user.ts`: add optional `dataPath` to the schema (described as echart-only), validate shape, return `{ shown: false, reason: "invalid_path" }` on failure
- [x] Confirm `presentationId` covers `dataPath` (it hashes the full input — add a test pinning it)
- [x] Tool description: document artifact-sourced usage (encode by column name, omit `dataset.source`)
- [x] Conversation-agent prompt "ECharts Layout" section: mirror the new `echart-layout` requirement (dataPath over inline rows; sandbox pre-shaping for non-chart-ready data)

## 4. Verify

- [x] `tsc -p tsconfig.json` clean
- [x] `bun test` green
- [x] `bun run format:file` on touched `src/` files
