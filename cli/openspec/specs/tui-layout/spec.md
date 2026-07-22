# tui-layout Specification

## Purpose
TBD - created by archiving change standardize-tui-layout. Update Purpose after archive.
## Requirements
### Requirement: Layout composition kit directory

The system SHALL house the chat TUI's app-shell composition kit under `src/tui/layout/`, one component per file with no barrel/index re-exports — today `status_bar.tsx`, `message_block.tsx`, `chat_bar.tsx` (renamed from `input_bar.tsx`), `sidebar.tsx`, and `design_gallery.tsx`. (The gutter marker set is NOT a shell-composition part; it is design-system vocabulary and lives in `src/lib/design_system.ts` so the `components/` block widgets may import it — see the "Shared gutter marker set" requirement.) A `layout/` part MAY be single-caller and MAY import domain types/queries (`src/types/`, `src/db/`, `src/modules/`), because it is structural app-shell composition rather than a reusable domain-agnostic widget. This is a deliberate, scoped exception to the "don't extract single-caller sub-components" rule, and `CLAUDE.md`'s Project-structure section SHALL document `src/tui/layout/` and this exception. `layout/` components MUST NOT be imported by `src/modules/` (presentation depends on logic, never the reverse).

#### Scenario: Kit part lives in layout/

- **WHEN** a part composes the chat shell (status bar, message block, chat bar, or sidebar)
- **THEN** it resides in `src/tui/layout/` as its own file, imported directly by its caller

#### Scenario: Single-caller, domain-coupled part is allowed

- **WHEN** a `layout/` part is composed by only `app.tsx` and imports domain types or db queries
- **THEN** it still belongs in `layout/` (the single-caller and components/-membership rules do not apply to the shell kit)

### Requirement: Direction-B chat shell composition

`app.tsx` SHALL compose the chat screen as: a persistent `StatusBar` across the full width at the top; below it a main row split into a chat column (the message stream, the error banner, the transient notice, and the `ChatBar`, stacked) and, beside it, an optional full-height `Sidebar`. The `Sidebar` SHALL span the full height of that row — alongside BOTH the stream and the input — so when it is shown the chat column (stream and input together) shrinks horizontally to make room (the opencode layout). When the sidebar is hidden the chat column spans the full width. The message stream SHALL render inside a `ScrollPane` (see the `scroll-pane` capability) with `stickyScroll`/`stickyStart="bottom"`; the chat SHALL declare no scroll bindings of its own. The existing overlay dialog host, keyboard gating, streaming-delta flush, and abort behavior SHALL be preserved; dialog-close focus restore follows the "Chat focus is always on a widget" requirement.

There SHALL be NO sticky run-progress row in the chat column: live run progress renders inside the sidebar RUNS section (per `sidebar-live`), and a hidden sidebar deliberately shows no live progress surface — the run-started card in the stream announces the launch, and the sidebar (open by default, `ctrl+b`) carries the live view.

#### Scenario: Sidebar is full height and shrinks the chat column

- **WHEN** the sidebar is shown
- **THEN** it spans the full height beside both the stream and the input, and the chat column (stream + input) narrows to make room

#### Scenario: Hidden sidebar gives full width

- **WHEN** the sidebar is toggled off
- **THEN** the chat column spans the full width and only the status bar, stream, and input remain

#### Scenario: Stream scrolls via ScrollPane

- **WHEN** the chat column renders the message stream
- **THEN** the stream is a `ScrollPane` (sticky-bottom), and no scroll chord is declared in `app.tsx` or `chat.tsx`

#### Scenario: No progress chrome between stream and input

- **WHEN** the newest run is non-terminal
- **THEN** the chat column shows only the stream, banner/notice, and input — the run's live progress renders in the sidebar RUNS section instead

### Requirement: Chat focus is always on a widget

The chat's INSERT/NORMAL modality SHALL be modeled purely by focus — there SHALL be no state in which no widget is focused. In INSERT mode the `ChatBar` textarea is focused; `esc` SHALL move focus to the stream's `ScrollPane` (NORMAL mode — the pane's scroll keys become live via its focus-target gating). In NORMAL mode, `i` and enter SHALL refocus the textarea (a chat-side layer gated by `target:` the scroll pane); `esc` while the pane is focused SHALL be a no-op (it MUST NOT blur into a nothing-focused state). The `ChatBar` footer's mode word continues to derive from the textarea's own focused/blurred events and needs no extra wiring.

Because focus is always on some widget, the dialog host's focus save/restore SHALL be uniform: capture the focused renderable when the first dialog opens, restore it (verifying it is still in the tree) when the last closes. The `fallbackFocus` prop and its null-restore branch SHALL NOT exist — there is no nothing-focused case to fall back from.

#### Scenario: Esc enters NORMAL by focusing the pane

- **WHEN** the textarea is focused and the user presses `esc`
- **THEN** the scroll pane receives focus, the ChatBar footer shows `NORMAL`, and vim scroll keys drive the stream

#### Scenario: i and enter return to INSERT

- **WHEN** the scroll pane is focused and the user presses `i` (or enter)
- **THEN** the textarea regains focus, the footer shows `INSERT`, and typed letters insert text again

#### Scenario: Esc in NORMAL is a no-op

- **WHEN** the scroll pane is focused and the user presses `esc`
- **THEN** focus stays on the pane; no widget is blurred into a nothing-focused state

#### Scenario: Dialog restore returns focus to the NORMAL-mode pane

- **WHEN** a dialog opens while the scroll pane is focused and is later closed
- **THEN** the dialog host restores focus to the scroll pane (no fallback branch involved), and scroll keys are live again

#### Scenario: No fallbackFocus machinery

- **WHEN** `dialog_host.tsx` is read
- **THEN** it exposes no `fallbackFocus` prop and contains no null-saved-focus fallback path

### Requirement: Persistent status bar

`StatusBar` SHALL render a left region, an OPTIONAL middle region, and a right region. Left = `inflexa` in `theme().accent` plus a screen title or the active analysis name. The middle region is parameterized by the caller: in the chat it SHALL show the live session state (`ready`/`thinking`/`error`), each with a leading glyph (e.g. `● ready`), colored `theme().success`/`theme().warn`/`theme().error` and sourced from the shared chat-status store (see "Chat status lives in a shared reactive store"); in `config` it SHALL show the unsaved-changes indicator in `theme().warn` and SHALL render nothing when there are no unsaved changes. Right = affordance hint labels sourced from the central keymap. `StatusBar` SHALL import only `theme` (no `modules/`/`db/` imports) and SHALL be composed by both `app.tsx` and `app_config.tsx`, replacing their hand-rolled header boxes. All colors SHALL come from `theme()`; no hex is inlined.

The chat's `StatusBar` SHALL additionally accept an OPTIONAL workspace-path segment, rendered as a muted ` | <path>` segment immediately after the state segment — part of the left-flowing segments, NOT the right-aligned hints region. `app.tsx` SHALL pass it only when the terminal width is at or above the design-system breakpoint token (`size.breakpointWide`), sourcing the value from the workspace store's `workingDir` with the home directory contracted to `~`; below the breakpoint the prop is absent and the path renders in the sidebar instead (see the sidebar requirement). `StatusBar` itself stays dumb — it renders whatever path string it is given and keeps its no-domain-imports rule.

The chat's right hints region SHALL be state-aware for the interrupt affordance: while a turn is busy AND the chat is in NORMAL mode (composer blurred — the one state where the interrupt binding is reachable) it SHALL include the interrupt hint, and while the interrupt is armed the label SHALL flip to its "again to interrupt" form with a visually distinct (accent) treatment. When idle, or while the composer holds focus, no interrupt hint renders — a hint promising a press the focused layer would consume is worse than none, and the abort-chord hint still covers INSERT. The label SHALL derive from the live `app.interrupt` binding (`chordLabel`, never hand-written), and both the label and the armed state SHALL arrive from `app.tsx` as data — `StatusBar` keeps its no-domain-imports rule.

#### Scenario: Shows analysis name and live state

- **WHEN** a chat is open and the assistant is streaming
- **THEN** the status bar shows the analysis name on the left and `thinking` (in the warn color) in the middle

#### Scenario: Reused by the config screen

- **WHEN** `inflexa config` renders
- **THEN** its header is the shared `StatusBar`, not a separately hand-rolled box

#### Scenario: Optional middle region in config

- **WHEN** `inflexa config` has unsaved changes
- **THEN** the status bar's middle region shows the unsaved indicator, and renders nothing when there are no unsaved changes

#### Scenario: Wide terminal shows the workspace path in the header

- **WHEN** the chat renders on a terminal at or above `size.breakpointWide` columns
- **THEN** the status bar shows the home-contracted working directory immediately after the state segment, before the right-aligned hints

#### Scenario: Narrow terminal keeps the header path-free

- **WHEN** the chat renders on a terminal below `size.breakpointWide` columns
- **THEN** the status bar shows no path segment (the sidebar carries the path)

#### Scenario: Busy shows the interrupt hint

- **WHEN** a turn is streaming in NORMAL mode and the interrupt is not armed
- **THEN** the right hints region shows the interrupt hint labeled from the live binding

#### Scenario: The composer keeps the hint honest

- **WHEN** a turn is streaming while the composer holds focus (INSERT)
- **THEN** no interrupt hint renders (the abort-chord hint still shows)

#### Scenario: Arming flips the hint

- **WHEN** the user presses esc in the chat's NORMAL mode during a turn
- **THEN** the hint flips to its "again to interrupt" form for the armed window, then reverts when the window lapses or the turn ends

### Requirement: Fixed-gutter message block

`MessageBlock` SHALL render a fixed-width gutter column (2 spaces) whose marker swaps by role, taken from the shared gutter marker set (`markers.ts`): `>` for the user (`theme().user`) and `<` for the assistant (`theme().assistant`), followed by the role label and the markdown body. The gutter width SHALL be constant regardless of marker, so future block types align identically. Streaming assistant text SHALL render from the live stream signal and flush into the message store on completion, exactly as before this change. No meta footer (model · duration · tokens) SHALL be rendered, because that data is not tracked; fabricating it is NOT permitted.

A user turn SHALL additionally differentiate itself with a left border rule in the user color (`border={["left"]}`, `theme().user`) on its parts container — the design system's quoted-content idiom. The rule MUST NOT break gutter alignment: the border glyph consumes one cell, so the user body's left padding SHALL shrink by one cell to keep body text in the same column as assistant bodies, and the header line (the `>` marker in the gutter) SHALL stay outside the bordered box. Assistant turns are unchanged.

#### Scenario: Role selects the marker

- **WHEN** a user turn and an assistant turn render
- **THEN** the user turn shows `>` in the user color and the assistant turn shows `<` in the assistant color, both in the same 2-space gutter column

#### Scenario: Streaming behavior preserved

- **WHEN** the assistant response streams in
- **THEN** deltas render live and flush into the store on completion, identical to the pre-change behavior

#### Scenario: User turns carry the rule, aligned

- **WHEN** a user turn renders above an assistant turn
- **THEN** the user body shows a left rule in the user color, and both bodies' text starts in the same column (the rule + reduced padding equals the assistant's gutter indent)

### Requirement: Toggleable four-section sidebar

`Sidebar` SHALL render four sections in fixed order — SESSION, ANALYSIS, DATA PROFILE, RUNS — as a
fixed-width, full-height column with a divider against the chat column. The order is the pipeline
order: the analysis's inputs feed the data profile, and the profile feeds runs. Its width SHALL be
sourced from `size.railWidth` (the design-tokens layer), NOT an inline integer, and it is NOT
mouse-resizable. SESSION SHALL show the short session id (`S·` + the first 4 hex of the id), the
session age as a relative duration (e.g. `6m12s`, the two-unit `Date.relativeAge` rendering), and
the message count from live data. ANALYSIS SHALL show the analysis name, the anchor path with a ✓/⚠ badge
derived from the anchor's `markerWritten`, the input count, and the project name when the analysis
has one. DATA PROFILE and RUNS SHALL render live ledger data per the `sidebar-live` capability
(states, refresh, details views, the active-run progress embed) — the sidebar MUST NOT display mock
fixtures or values fabricated inline at the render site. The sidebar's data SHALL update when the
open analysis or session changes (an in-place `openSession` swap).

The rail's section stack SHALL be vertically scrollable: when the sections outgrow the rail's
height (the RUNS section's progress embed makes its height variable), the rail scrolls rather than
clipping or squeezing sections. The scroll container SHALL NOT take focus on mount (the rail is not
a focus target; mouse-wheel scrolling suffices) and SHALL introduce no scroll keybindings.

The ANALYSIS anchor-path line SHALL render only when the terminal is below the design-system
breakpoint (`size.breakpointWide`); at or above it the path moves to the status bar (see the status
bar requirement) and the ✓/⚠ badge — which reports anchor-marker health, not the path, and never
moves to the header — SHALL join the ANALYSIS meta line (inputs · project) instead.

Section headers SHALL use vertical space responsively: a section whose value is a single short
string (SESSION's short id, ANALYSIS's name) SHALL render `LABEL <flex gap> value` on one row when
the label, a separating gap, and the value fit the rail's usable width — and SHALL fall back to
today's stacked layout (label above a full-width value line) when they do not, so a long analysis
name is never truncated or wrapped inside a right-hand cell. Sections whose first line is a
composite (DATA PROFILE's glyph-bearing `N files · time` line) and row-list sections (RUNS) keep
the stacked layout — the merge models a single plain value, not a styled composite. The fit
decision is measured in cells (one character per cell) against the rail width minus its padding
and border.

#### Scenario: Sidebar renders live sections for an open analysis

- **WHEN** the sidebar renders for an open analysis
- **THEN** SESSION/ANALYSIS show live SQLite-backed data and DATA PROFILE/RUNS show live ledger-backed states per `sidebar-live` — nothing rendered is mock

#### Scenario: Sections render in pipeline order

- **WHEN** the sidebar renders
- **THEN** the sections appear top-to-bottom as SESSION, ANALYSIS, DATA PROFILE, RUNS

#### Scenario: Anchor badge reflects marker state

- **WHEN** the analysis's anchor has `markerWritten = false`
- **THEN** the ANALYSIS section shows the ⚠ badge rather than ✓

#### Scenario: Sidebar width comes from a token

- **WHEN** the sidebar is rendered
- **THEN** its column width is `size.railWidth`, not a raw integer literal

#### Scenario: Sidebar follows an in-place swap

- **WHEN** `openSession` swaps the analysis or session
- **THEN** every section re-renders from the new scope's data

#### Scenario: Overflowing rail scrolls instead of clipping

- **WHEN** the sections (e.g. RUNS carrying the active-run progress embed) outgrow the rail's height
- **THEN** the rail scrolls vertically — no section is clipped or squeezed away — and the scroll container has not stolen focus from the chat

#### Scenario: Short value shares the label row

- **WHEN** a section's label, gap, and value fit the rail's usable width
- **THEN** they render on one row — label left, value pushed right by a flex gap — saving a vertical row

#### Scenario: Long value falls back to stacked

- **WHEN** an analysis name is too long to share the ANALYSIS label row
- **THEN** the section renders the stacked layout (label above the full-width name), never a name wrapped inside a right-hand cell

#### Scenario: Path yields to the header on wide terminals

- **WHEN** the terminal is at or above `size.breakpointWide` columns
- **THEN** the ANALYSIS section shows no path line, the ✓/⚠ badge joins the meta line, and the status bar carries the path

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

`ChatBar` (renamed from `InputBar`, in `layout/chat_bar.tsx`) SHALL compose the shared `TextArea` component with `chrome="full"` and the `Type a message…` placeholder (via `GLYPHS.ellipsis`), and render a single external footer row below the bordered textarea. The footer row SHALL show the mode word on the left (`INSERT` when the textarea is focused, `NORMAL` when blurred — with `NORMAL` rendered in bold with the accent color and the row given a `bgActive` background) and the newline chord hint on the right (`ctrl+j newline`). Global keybind hints SHALL NOT be duplicated in this footer: the command-palette, sidebar-toggle, and abort key hints live ONLY in the status bar, so the header and the input footer never repeat the same keys.

#### Scenario: ChatBar composes TextArea

- **WHEN** the chat renders the input area
- **THEN** `ChatBar` renders a `TextArea` with `chrome="full"` for the bordered textarea, plus its own external footer row

#### Scenario: Footer is session/mode info

- **WHEN** the chat renders
- **THEN** the input footer shows the mode word (left) and newline hint (right), and does NOT show the palette/sidebar/abort key hints

#### Scenario: Global keys live in the header only

- **WHEN** the user looks for the command-palette / sidebar / abort shortcuts
- **THEN** they appear in the status bar, not duplicated in the input footer

#### Scenario: NORMAL mode has distinct visual treatment

- **WHEN** the textarea is blurred (NORMAL mode)
- **THEN** the footer row shows `NORMAL` in bold accent color with `bgActive` background, signaling that vim scroll keys are live

### Requirement: Shared gutter marker set

The system SHALL define the gutter marker set as a shared constant (`MARKERS`) in `src/lib/design_system.ts` (the merged design-system module — solid-js-free, importable by both the shell and the `components/` block widgets without a components→layout dependency) — one entry per kind: `you >`, `assistant <`, `thinking ◆`, `tool ▸`, `run ●`, `fileEdit ✎`, `ok ✓`, `error ✗` — each mapping to its glyph and an existing `ThemeColors` role (the `thinking` and `tool` kinds use the dedicated `thinking`/`tool` roles; `run` uses `warning`). The set is the single source for every block's marker: `MessageBlock` (shell) reads `you`/`assistant`, and the `components/` block widgets read the rest.

#### Scenario: Message block reads the marker set

- **WHEN** a user or assistant turn renders
- **THEN** its gutter marker glyph and color come from the shared marker set in `src/lib/design_system.ts`, not an inline literal

#### Scenario: Block widgets read the marker set

- **WHEN** a thinking / tool / run / file-edit / error block widget renders
- **THEN** its marker glyph and role come from the shared set, imported from the tui root (no components→layout import)
