# tui-layout Specification

## Purpose
TBD - created by archiving change standardize-tui-layout. Update Purpose after archive.
## Requirements
### Requirement: Layout composition kit directory

The system SHALL house the chat TUI's Direction-B app-shell composition kit under `src/tui/layout/`, one component per file with no barrel/index re-exports — today `status_bar.tsx`, `message_block.tsx`, `input_bar.tsx`, and `sidebar.tsx`. (The gutter marker set is NOT a shell-composition part; it is design-system vocabulary and lives in `src/lib/design_system.ts` so the `components/` block widgets may import it — see the "Shared gutter marker set" requirement.) A `layout/` part MAY be single-caller and MAY import domain types/queries (`src/types/`, `src/db/`, `src/modules/`), because it is structural app-shell composition rather than a reusable domain-agnostic widget. This is a deliberate, scoped exception to the "don't extract single-caller sub-components" rule, and `CLAUDE.md`'s Project-structure section SHALL document `src/tui/layout/` and this exception. `layout/` components MUST NOT be imported by `src/modules/` (presentation depends on logic, never the reverse).

#### Scenario: Kit part lives in layout/

- **WHEN** a part composes the chat shell (status bar, message block, input bar, or sidebar)
- **THEN** it resides in `src/tui/layout/` as its own file, imported directly by its caller

#### Scenario: Single-caller, domain-coupled part is allowed

- **WHEN** a `layout/` part is composed by only `app.tsx` and imports domain types or db queries
- **THEN** it still belongs in `layout/` (the single-caller and components/-membership rules do not apply to the shell kit)

### Requirement: Direction-B chat shell composition

`app.tsx` SHALL compose the chat screen as: a persistent `StatusBar` across the full width at the top; below it a main row split into a chat column (the message stream, the error banner, the transient notice, and the `InputBar`, stacked) and, beside it, an optional full-height `Sidebar`. The `Sidebar` SHALL span the full height of that row — alongside BOTH the stream and the input — so when it is shown the chat column (stream and input together) shrinks horizontally to make room (the opencode layout). When the sidebar is hidden the chat column spans the full width. The existing overlay dialog host, keyboard gating, streaming-delta flush, abort, and focus-on-dialog-close behavior SHALL be preserved unchanged.

#### Scenario: Sidebar is full height and shrinks the chat column

- **WHEN** the sidebar is shown
- **THEN** it spans the full height beside both the stream and the input, and the chat column (stream + input) narrows to make room

#### Scenario: Hidden sidebar gives full width

- **WHEN** the sidebar is toggled off
- **THEN** the chat column spans the full width and only the status bar, stream, and input remain

### Requirement: Persistent status bar

`StatusBar` SHALL render a left region, an OPTIONAL middle region, and a right region. Left = `inflexa` in `theme().accent` plus a screen title or the active analysis name. The middle region is parameterized by the caller: in the chat it SHALL show the live session state (`ready`/`thinking`/`error`), each with a leading glyph (e.g. `● ready`), colored `theme().success`/`theme().warn`/`theme().error` and sourced from the shared chat-status store (see "Chat status lives in a shared reactive store"); in `config` it SHALL show the unsaved-changes indicator in `theme().warn` and SHALL render nothing when there are no unsaved changes. Right = affordance hint labels sourced from the central keymap. `StatusBar` SHALL import only `theme` (no `modules/`/`db/` imports) and SHALL be composed by both `app.tsx` and `app_config.tsx`, replacing their hand-rolled header boxes. All colors SHALL come from `theme()`; no hex is inlined.

#### Scenario: Shows analysis name and live state

- **WHEN** a chat is open and the assistant is streaming
- **THEN** the status bar shows the analysis name on the left and `thinking` (in the warn color) in the middle

#### Scenario: Reused by the config screen

- **WHEN** `inflexa config` renders
- **THEN** its header is the shared `StatusBar`, not a separately hand-rolled box

#### Scenario: Optional middle region in config

- **WHEN** `inflexa config` has unsaved changes
- **THEN** the status bar's middle region shows the unsaved indicator, and renders nothing when there are no unsaved changes

### Requirement: Fixed-gutter message block

`MessageBlock` SHALL render a fixed-width gutter column (2 spaces) whose marker swaps by role, taken from the shared gutter marker set (`markers.ts`): `>` for the user (`theme().user`) and `<` for the assistant (`theme().assistant`), followed by the role label and the markdown body. The gutter width SHALL be constant regardless of marker, so future block types align identically. Streaming assistant text SHALL render from the live stream signal and flush into the message store on completion, exactly as before this change. No meta footer (model · duration · tokens) SHALL be rendered, because that data is not tracked; fabricating it is NOT permitted.

#### Scenario: Role selects the marker

- **WHEN** a user turn and an assistant turn render
- **THEN** the user turn shows `>` in the user color and the assistant turn shows `<` in the assistant color, both in the same 2-space gutter column

#### Scenario: Streaming behavior preserved

- **WHEN** the assistant response streams in
- **THEN** deltas render live and flush into the store on completion, identical to the pre-change behavior

### Requirement: Toggleable four-section sidebar

`Sidebar` SHALL render four sections in fixed order — SESSION, CONTEXT, ANALYSIS, RUNS — as a fixed-width, full-height column with a divider against the chat column. Its width SHALL be sourced from `size.railWidth` (the design-tokens layer), NOT an inline integer, and it is NOT mouse-resizable. SESSION SHALL show the short session id (`S·` + the first 4 hex of the id), the session age as a relative duration (e.g. `6m ago`), and the message count from live data. ANALYSIS SHALL show the analysis name, the anchor path with a ✓/⚠ badge derived from the anchor's `markerWritten`, the input count, and the project name when the analysis has one. CONTEXT (tokens · % · cost) and RUNS (live/completed rows) SHALL render values from the mock data models supplied by the `tui-mock-data` capability; that data SHALL be identifiable as mock/sample (sourced from the named mock module, never presented as live telemetry), and the sidebar MUST NOT display values fabricated inline at the render site. The sidebar's data SHALL update when the open analysis or session changes (an in-place `openSession` swap).

#### Scenario: Real data for SESSION and ANALYSIS

- **WHEN** the sidebar renders for an open analysis
- **THEN** SESSION shows id/age/message-count and ANALYSIS shows name, anchor path, inputs, and project from live queries

#### Scenario: Anchor badge reflects marker state

- **WHEN** the analysis's anchor has `markerWritten = false`
- **THEN** the ANALYSIS section shows the ⚠ badge rather than ✓

#### Scenario: CONTEXT and RUNS render mock data from the mock module

- **WHEN** the sidebar renders CONTEXT and RUNS
- **THEN** they show token/cost and run rows from the `tui-mock-data` fixtures (not inline-fabricated values), and the source is the named mock module

#### Scenario: Sidebar width comes from a token

- **WHEN** the sidebar is rendered
- **THEN** its column width is `size.railWidth`, not a raw integer literal

#### Scenario: Sidebar follows an in-place switch

- **WHEN** the user switches to a different analysis via the palette
- **THEN** the sidebar's SESSION and ANALYSIS sections update to the new analysis without a process restart

### Requirement: Sidebar toggle keybinding

The chat TUI SHALL toggle the sidebar on the central keymap's sidebar-toggle chord (`ctrl+b`), with the sidebar open by default. The chord SHALL be a Ctrl chord, NOT an Alt chord, because terminals deliver Alt/Option unreliably (on macOS the Option key composes a special character instead of sending a modifier). The handler SHALL call `preventDefault()` so the focused textarea does not also consume the key, and SHALL be gated while a dialog is open — when a modal owns the keyboard, the chord SHALL NOT toggle the sidebar.

#### Scenario: Toggle from the chat

- **WHEN** `ctrl+b` is pressed in the chat with no dialog open
- **THEN** the sidebar hides or re-shows, and the focused textarea does not receive the keystroke

#### Scenario: Gated while a dialog is open

- **WHEN** a dialog is open and the toggle chord is pressed
- **THEN** the sidebar does not toggle (the dialog owns the keyboard)

### Requirement: Chat status lives in a shared reactive store

The chat's live status (`idle`/`busy`/`error`) SHALL be held in a shared reactive store module `src/tui/hooks/status.ts` (a Solid signal accessor plus a setter, mirroring `theme.ts`), NOT as private state inside `app.tsx`. `app.tsx` SHALL only READ the store to render the status bar; every mutation SHALL go through the store's exported setter (which the chat's bus handler and the in-place session swap call). The store decouples the holder of the state from its renderer, so the state can be changed indirectly from anywhere without reaching into the chat component.

#### Scenario: App renders, store holds

- **WHEN** a session-status bus event arrives
- **THEN** the handler calls the store's setter and the status bar repaints from the store accessor, with no status signal owned by `app.tsx`

#### Scenario: Status shows a glyph

- **WHEN** the chat is ready / busy / error
- **THEN** the status bar's middle region shows a leading glyph before the state text (e.g. `● ready`)

### Requirement: Input bar footer shows session/mode info, not keybinds

The input bar SHALL render the textarea plus a single footer row of session/mode info — left `INSERT`, right `xhigh /effort` — hardcoded for now (those capabilities are not yet integrated). Global keybind hints SHALL NOT be duplicated in this footer: the command-palette, sidebar-toggle, and abort key hints live ONLY in the status bar, so the header and the input footer never repeat the same keys.

#### Scenario: Footer is session/mode info

- **WHEN** the chat renders
- **THEN** the input footer shows `INSERT` (left) and `xhigh /effort` (right), and does NOT show the palette/sidebar/abort key hints

#### Scenario: Global keys live in the header only

- **WHEN** the user looks for the command-palette / sidebar / abort shortcuts
- **THEN** they appear in the status bar, not duplicated in the input footer

### Requirement: Shared gutter marker set

The system SHALL define the gutter marker set as a shared constant (`MARKERS`) in `src/lib/design_system.ts` (the merged design-system module — solid-js-free, importable by both the shell and the `components/` block widgets without a components→layout dependency) — one entry per kind: `you >`, `assistant <`, `thinking ◆`, `tool ▸`, `run ●`, `fileEdit ✎`, `ok ✓`, `error ✗` — each mapping to its glyph and an existing `ThemeColors` role (the `thinking` and `tool` kinds use the dedicated `thinking`/`tool` roles; `run` uses `warning`). The set is the single source for every block's marker: `MessageBlock` (shell) reads `you`/`assistant`, and the `components/` block widgets read the rest.

#### Scenario: Message block reads the marker set

- **WHEN** a user or assistant turn renders
- **THEN** its gutter marker glyph and color come from the shared marker set in `src/lib/design_system.ts`, not an inline literal

#### Scenario: Block widgets read the marker set

- **WHEN** a thinking / tool / run / file-edit / error block widget renders
- **THEN** its marker glyph and role come from the shared set, imported from the tui root (no components→layout import)

