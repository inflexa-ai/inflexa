# Render tool call details and outcomes

## Why

The harness change `add-tool-call-detail` (issue #174) makes every tool able to describe its own call in one line, and replaces the `tool-finished` error boolean with a three-way outcome. Nothing renders either yet.

The TUI renders a live tool call as a name, a status, and a duration. Four consecutive `update_working_memory` chips are indistinguishable, and a `run_inflexa` chip never says which command ran. The harness now supplies the missing line; the TUI has to place it.

Two related faults land with it:

- A reloaded tool call always renders `✓ ok`. The harness converter now recovers the real outcome, so the TUI can stop reporting a failed call as a successful one.
- A rejected approval renders `✗ error`. The user's own decision reads as a fault. The harness now reports `denied` separately, so the chip can too.

## What Changes

- `ToolBlock` renders the call detail. It stays on the name line when it fits the available width, and drops to one indented continuation row when it does not. Nothing is truncated.
- On the split, the status stays on the name line. Row 1 becomes marker, tool name, and status, which is short enough never to wrap — so the status lands in a near-constant column instead of floating behind a variable-length detail.
- `ToolCallPart` and `ToolBlockProps` rename `target` to `detail`. The field is one display string, and `target` claimed a semantic ("what the tool acted on") that a verb phrase like `hypothesis retire h3` does not satisfy. **BREAKING** for the gallery fixtures, which are the only writers today.
- The tool-call status gains `denied`, rendered with `GLYPHS.warning` in the `warning` role — a soft state, not a fault.
- The emit reducer and the REPL printer migrate from `isError: boolean` to the harness's `outcome`, and carry `detail` onto the live part.
- A reloaded call shows its own detail and its own outcome, replacing the current always-`ok` behaviour. This change states that as an outcome; the conversation-display change supplies it by replaying what the turn recorded.
- The design gallery gains the fitted form, the split form, and the denied status.

## Capabilities

### New Capabilities

<!-- None. This change consumes a harness capability; every behaviour lands in an existing cli spec. -->

### Modified Capabilities

- `tui-stream-blocks`: `ToolBlock` renders a detail that reflows to a continuation row, the status placement rule changes on the split, and the status set gains `denied`.
- `tui-harness-chat`: the emit reducer consumes `detail` and the three-way `outcome`; a reloaded call reports both.
- `tui-mock-data`: the `Part` union's tool-call kind renames `target` to `detail` and widens its status.
- `chat-command`: the REPL printer's one-line chips carry the detail and distinguish a denial from an error.

## Impact

CLI source:

- `src/types/session.ts` — `ToolCallPart`: `target` → `detail`, status gains `denied`.
- `src/tui/components/tool_block.tsx` — width measurement, the continuation row, the split-form status placement, the denied status view.
- `src/tui/hooks/conversation.ts` — the emit reducer's `tool-started`/`tool-finished` branches, and the reloaded tool part.
- `src/modules/harness/chat_printer.ts` — the REPL chips and `subAgentActivityLabel`.
- `src/tui/layout/design_gallery.tsx`, `src/tui/layout/design_gallery_fixtures.ts` — the new states and the renamed field.

Dependencies: requires the harness change `add-tool-call-detail`. The CLI does not typecheck against a harness that still emits `isError`, and does not typecheck against the new harness until this change lands — the two are a single cutover.

Testing: the continuation row is width-dependent, so it needs a width sweep in the frame-assertion tests, following `activity_panel.render.test.tsx`. `GLYPHS.warning` already exists, so no design-token addition is proposed.

Out of scope: the `warning` status tier for ok-channel outcomes such as `no_matches` and `blocked` — issue #281, which depends on this change and on the harness one.
