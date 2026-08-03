## 1. Types

- [x] 1.1 In `src/types/session.ts`, rename `ToolCallPart.target` to `detail` and update its JSDoc — it is one opaque display string the harness computed, not "what the tool acted on".
- [x] 1.2 Widen `ToolCallPart.status` to `"running" | "ok" | "error" | "denied"`.
- [x] 1.3 Run `bun run typecheck` and collect every break. These are the exact call sites tasks 2–5 must cover.

## 2. The tool block

- [x] 2.1 In `src/tui/components/tool_block.tsx`, rename the `target` prop to `detail` and update its JSDoc.
- [x] 2.2 Add `denied` to `statusView`: `GLYPHS.warning`, role `warning`, label `denied`.
- [x] 2.3 Measure the available width with `useTerminalDimensions()`, following `plan_card_block.tsx:36-42` — subtract `size.railWidth`, `size.gutter`, and the block's own spacing, with a floor. Assume the sidebar is present; an unnecessary split is harmless, an under-subtraction breaks the gutter.
- [x] 2.4 Render the detail on the name line when it fits, and on one `space.md`-indented row when it does not. Never truncate.
- [x] 2.5 Keep the status on the name line in the split form. Do not right-align it — the existing gutter-collision rule still holds.
- [x] 2.6 Order the subordinate rows: detail first, then the sub-agent activity row, both at `space.md`.

## 3. Live emit path

- [x] 3.1 In `src/tui/hooks/conversation.ts`, extract `detail` from `tool-started` at receipt (a copied primitive — the copy-on-receive rule) and set it on the appended part.
- [x] 3.2 Migrate the `tool-finished` branch from `isError` to the harness `outcome`, mapping `denied` through to the part's status.
- [x] 3.3 Carry the detail through `updateToolPart`'s unpaired-finish append path, so a finish with no matching start still renders one.
- [x] 3.4 Leave `subAgentActivityLabel` in `src/modules/harness/chat_printer.ts` at agent plus tool name — see the settled question in `design.md`. It does not compose the detail in this change.

## 4. Reload path

- [x] 4.1 Extend the `toCortex` seam in `LoadSeams` to take the conversation tool list, and pass `runtime.conversationAgent.tools` from `loadMessages` — the runtime is already resolved there.
- [x] 4.2 Build the harness detail resolver in `realLoadSeams.toCortex` and pass it to `contentToCortexMessages` alongside the existing card resolver, using the harness's new options-object signature.
- [x] 4.3 In the `CortexPart` → `Part` mapping, carry the converter's recovered outcome onto the part and delete the always-`ok` behaviour. Remove the `LIMITATION` comment that documented it.
- [x] 4.4 Carry the reconstructed `detail` onto the part.
- [x] 4.5 Confirm the existing test fakes for `LoadSeams` still compile and pass with the widened seam.

## 5. REPL printer

- [x] 5.1 In `src/modules/harness/chat_printer.ts`, print the detail beside the tool name on the `tool-started` chip.
- [x] 5.2 Migrate the `tool-finished` branch to the three-way outcome, with distinct wording for a denial and an error.

## 6. Design gallery

- [x] 6.1 Update `src/tui/layout/design_gallery_fixtures.ts` for the `target` → `detail` rename.
- [x] 6.2 Add gallery exhibits to `src/tui/layout/design_gallery.tsx` for: a fitted detail, a split detail, and the denied status — beside the existing ok / running / error states.
- [x] 6.3 Confirm the gallery renders every new state, since it is the source of truth for these surfaces.

## 7. Tests

- [x] 7.1 Extend `src/tui/components/tool_block.render.test.tsx` with a width sweep over one fixture whose detail crosses the fitting boundary, asserting the fitted form and the split form each at a width that produces them. Include the 40-column sidebar-open case the spec already mandates.
- [x] 7.2 Assert the denied status with `captureSpans()`, checking the resolved `warning` foreground on a light theme as well as a dark one. A character frame carries no color and cannot prove this.
- [x] 7.3 Assert that a long detail appears in full, with no ellipsis, on the split path.
- [x] 7.4 Extend the `conversation.ts` reducer tests: a described call carries its detail, a denied finish yields the denied status, and an unpaired finish still renders.
- [x] 7.5 Extend the reload tests: a rebuilt detail, a host-tool detail, a reloaded failed call, a reloaded denied call, and a reload that runs before boot.
- [x] 7.6 Extend `chat_printer.test.ts` for the detail on the chip and the denial wording.

## 8. Verify

- [x] 8.1 Run `bun run format:file` on every changed file under `src/`.
- [x] 8.2 Run `bun run typecheck` and `bun run lint`.
- [x] 8.3 Run `bun run test`.
- [x] 8.4 Launch the TUI and open the design gallery to look at the three new exhibits on a dark theme and on `github-light`.
