# Design

## Context

`MessageBlock` maps each known part onto a block, and the `never` default of its switch fails the build for a part with no case (`src/tui/layout/message_block.tsx`). A block widget takes primitive props and lives in `src/tui/components/`. No block in the TUI toggles in place today: the `expanded` prop of `ThinkingBlock` has no live caller. A click handler on a block is a known pattern (`report_rendered_block.tsx`, `openable_card_block.tsx`).

## Goals / Non-Goals

**Goals:**

- One block with the layout that the user approved.
- A toggle that a mouse click operates.

**Non-Goals:**

- A keyboard toggle. The transcript has no focus that can target one block.
- A REPL renderer. The REPL already prints the type of a part that it cannot render.
- A link that opens a source in a browser.

## Decisions

- **The block holds its own toggle state.** A local signal starts from an optional `expanded` prop, read one time. The gallery uses the prop to show the expanded state. The live mapper gives no prop, thus each live block starts collapsed. A reload starts collapsed again, because the state is a view state and the part does not carry it.
- **The view types live in the component file.** `AnalogyReportView` is a union of a report view and a failure view, with primitive fields only. This is the pattern of `OpenableRowView`.
- **The mapper lives in `MessageBlock`.** The TUI is the only consumer, thus the mapper is a local function and not a reader in `chat_printer.ts`.
- **The header shows the disclosure state with a glyph.** `GLYPHS.triangleRight` marks the collapsed state. A new `GLYPHS.triangleDown` (U+25BE) marks the expanded state.
- **The failure state is an `ErrorBlock`.** The message of the error is its detail, and it does not toggle.
- **The header counts the distinct target domains.** Two analogies can share a domain.
- **The coverage labels come from one map in the component.** `queried_no_data` reads "no data", `not_loaded` reads "not loaded", and `search_failed` reads "search failed" with `GLYPHS.cross`.

## Risks / Trade-offs

- [A user with no mouse cannot expand the block] → The collapsed state shows each analogy and solution title. The reply of the agent names the analogies that matter.
- [A store update can mount the block again and reset the toggle] → The part is not reconciling. Thus the store does not replace it after it lands.
