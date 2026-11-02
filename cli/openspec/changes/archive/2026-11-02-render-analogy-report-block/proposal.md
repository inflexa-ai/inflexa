# Proposal

## Why

The harness change `emit-analogy-report-part` emits the analogy report as a `data-analogy-report` part. The TUI has no renderer for the part, thus it shows only the mention of an unknown part. The report needs a block that shows the coverage state of each analogy.

## What Changes

- A new `AnalogyReportBlock` renders the part in the transcript.
- The block starts collapsed. A click on its header line expands it in place, and a second click collapses it.
- The collapsed block shows the problem, each analogy with its coverage state, and the title of each solution.
- The expanded block also shows the object mappings, the relevance of each solution, and its sources.
- An `extraction-failed` envelope renders as a failure state with the message of the error.
- The design gallery shows each state of the block, and the contrast guard covers the block.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tui-stream-blocks`: the analogy report renders as a block that a click expands.

## Impact

- `src/tui/components/analogy_report_block.tsx` (new), `src/tui/layout/message_block.tsx`, and `src/lib/design_system.ts` (one glyph).
- `src/tui/layout/design_gallery.tsx`, `src/tui/layout/design_gallery_fixtures.ts`, and `src/tui/theme_contrast.render.test.tsx`.
- The cli typecheck reads the new part from the linked harness `dist/`. Thus it needs `bun run harness:local` after the harness change.
