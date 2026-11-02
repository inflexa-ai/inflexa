# Tasks

## 1. Link the harness

- [x] 1.1 From `cli/`, run `bun run harness:local`. Make sure that `node_modules/@inflexa-ai/harness/dist/contracts/chat-parts.d.ts` declares `data-analogy-report`.

## 2. Build the block

- [x] 2.1 In `src/lib/design_system.ts`, add `triangleDown` (U+25BE) to `GLYPHS` with a doc comment that names the expanded disclosure state. Run `bun run format:file src/lib/design_system.ts`. The tests of 2.3 show that this task is done.
- [x] 2.2 Add `src/tui/components/analogy_report_block.tsx` with `AnalogyReportView` and `AnalogyReportBlock`, as `design.md` describes. Resolve an explicit theme foreground for each span. Run `bun run format:file` on the file. The tests of 2.3 show that this task is done.
- [x] 2.3 Add `src/tui/components/analogy_report_block.render.test.tsx`. Assert the collapsed content, a click that expands and collapses, the coverage roles, and the failure state. From `cli/`, run `bun test src/tui/components/analogy_report_block.render.test.tsx`, and make sure that it passes.

## 3. Connect the part

- [x] 3.1 In `src/tui/layout/message_block.tsx`, add a local mapper from `AnalogyReportPart` to `AnalogyReportView`, and add the `data-analogy-report` case. Run `bun run format:file src/tui/layout/message_block.tsx`. The test of 3.2 shows that this task is done.
- [x] 3.2 In `src/tui/layout/message_block.test.tsx`, assert that a `data-analogy-report` part renders the block and not the mention of an unknown part. From `cli/`, run `bun test src/tui/layout/message_block.test.tsx`, and make sure that it passes.

## 4. Show the block in the gallery

- [x] 4.1 In `src/tui/layout/design_gallery_fixtures.ts`, add mock views for a full report, a report with partial coverage, and a failure. In `src/tui/layout/design_gallery.tsx`, add a state that shows the full report collapsed and expanded, the partial report, and the failure. Run `bun run format:file` on the two files.
- [x] 4.2 In `src/tui/theme_contrast.render.test.tsx`, add the expanded partial report to `BLOCKS` with the gallery fixture. From `cli/`, run `bun test src/tui/theme_contrast.render.test.tsx src/tui/layout/design_gallery_usage.render.test.tsx`, and make sure that they pass.

## 5. Check

- [x] 5.1 From `cli/`, run `bun run typecheck` and `bun run lint`, and make sure that both pass.
