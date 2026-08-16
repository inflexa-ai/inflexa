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

Entering INSERT SHALL remain a deliberate act; the app SHALL move focus automatically in exactly two places. An ACCEPTED submit — one that reaches the conversation send — SHALL focus the stream pane, so the resting state of a running turn is NORMAL, where the interrupt, retract, and scroll affordances live; a refused submit (busy, booting, no analysis open) SHALL keep focus and the typed text where they are. A completed retract SHALL focus the composer along with its seeded text (cursor at end); a retract that downgrades or declines its seed SHALL NOT move focus. Turn completion SHALL move focus nowhere — an async event must never steal focus from a user who is scrolling.

Because focus is always on some widget, the dialog host's focus save/restore SHALL be uniform: capture the focused renderable when the first dialog opens, restore it (verifying it is still in the tree) when the last closes. The `fallbackFocus` prop and its null-restore branch SHALL NOT exist — there is no nothing-focused case to fall back from.

#### Scenario: Esc enters NORMAL by focusing the pane

- **WHEN** the textarea is focused and the user presses `esc`
- **THEN** the scroll pane receives focus, the ChatBar footer shows `NORMAL`, and vim scroll keys drive the stream

#### Scenario: i and enter return to INSERT

- **WHEN** the scroll pane is focused and the user presses `i` (or enter)
- **THEN** the textarea regains focus, the footer shows `INSERT`, and typed letters insert text again

#### Scenario: Esc in NORMAL stays put

- **WHEN** the scroll pane is focused and the user presses `esc`
- **THEN** focus stays on the pane; no widget is blurred into a nothing-focused state

#### Scenario: An accepted submit lands in NORMAL

- **WHEN** the user submits a message that the send accepts
- **THEN** the composer clears, focus moves to the stream pane, the footer shows `NORMAL`, and two esc presses interrupt the now-running turn

#### Scenario: A refused submit keeps INSERT and the text

- **WHEN** the user submits while the turn is busy (or the runtime is booting)
- **THEN** focus stays on the composer and the typed text remains in the buffer

#### Scenario: Turn completion steals no focus

- **WHEN** a turn finishes while the user is scrolling the stream in NORMAL mode
- **THEN** focus stays on the pane and the next scroll key scrolls — nothing is typed into the composer

### Requirement: Persistent status bar

`StatusBar` MUST render a left region, an OPTIONAL middle region, and a right region. The left region holds `inflexa` in `theme().accent`, plus a screen title or the active analysis name. The caller parameterizes the middle region. In the chat it MUST show the live session state (`ready`/`thinking`/`error`), each with a leading glyph (for example `● ready`). The state colors are `theme().success`, `theme().warn`, and `theme().error`, from the shared chat-status store (see "Chat status lives in a shared reactive store"). In `config` it MUST show the unsaved-changes indicator in `theme().warn`, and it MUST render nothing when no unsaved change exists.

The right region holds affordance hint labels from the central keymap. `StatusBar` MUST import only `theme` (no `modules/` or `db/` imports). Both `app.tsx` and `app_config.tsx` MUST compose it, in place of a hand-rolled header box. Each color MUST come from `theme()`, and no hex is inlined.

The chat's `StatusBar` MUST also accept an OPTIONAL workspace-path segment. The segment renders as a muted ` | <path>` segment directly after the state segment. It is part of the left-flowing segments, NOT the right-aligned hints region. `app.tsx` MUST pass it only when the terminal width is at or above the breakpoint token (`size.breakpointWide`). The value comes from the `workingDir` of the workspace store, with the home directory contracted to `~`. Below the breakpoint the prop is absent, and the path renders in the sidebar instead (see the sidebar requirement). `StatusBar` stays dumb: it renders the given path string, and it keeps its no-domain-imports rule.

The chat's `StatusBar` MUST also accept an OPTIONAL scope segment, per `report-session-identity`. The segment renders in the accent role, after the identity and subtitle pair and before the middle state region. `app.tsx` MUST pass it only while the open thread loads as a report row. `StatusBar` renders the given string, and its no-domain-imports rule is unchanged.

The status bar MUST NOT render the interrupt hint. That affordance is mode-scoped, and it lives in the input-bar footer beside the mode word (see "Input bar footer shows mode info and mode-scoped hints"). The status bar carries no state-aware turn affordance.

#### Scenario: Shows analysis name and live state

- **WHEN** a chat is open and the assistant streams
- **THEN** the status bar shows the analysis name on the left and `thinking` (in the warn color) in the middle

#### Scenario: Reused by the config screen

- **WHEN** `inflexa config` renders
- **THEN** its header is the shared `StatusBar`, not a separately hand-rolled box

#### Scenario: Optional middle region in config

- **WHEN** `inflexa config` holds unsaved changes
- **THEN** the middle region of the status bar shows the unsaved indicator, and it renders nothing when no unsaved change exists

#### Scenario: Wide terminal shows the workspace path in the header

- **WHEN** the chat renders on a terminal at or above `size.breakpointWide` columns
- **THEN** the status bar shows the home-contracted working directory directly after the state segment, before the right-aligned hints

#### Scenario: Narrow terminal keeps the header path-free

- **WHEN** the chat renders on a terminal below `size.breakpointWide` columns
- **THEN** the status bar shows no path segment (the sidebar carries the path)

#### Scenario: A report session shows the scope segment

- **WHEN** the chat renders while the open thread loads as a report row
- **THEN** the status bar shows the accent `report` segment after the analysis name, before the state segment

#### Scenario: No interrupt hint in the header

- **WHEN** a turn streams in NORMAL mode
- **THEN** the right hints region of the status bar shows no interrupt hint, because the input-bar footer carries it

### Requirement: Fixed-gutter message block

`MessageBlock` SHALL render a fixed-width gutter column (2 spaces) whose marker swaps by role, taken from the shared gutter marker set (`markers.ts`): `>` for the user (`theme().user`) and `<` for the assistant (`theme().assistant`), followed by the role label and the markdown body. The gutter width SHALL be constant regardless of marker, so future block types align identically. Streaming assistant text SHALL render from the live stream signal and flush into the message store on completion, exactly as before this change.

An assistant turn's header SHALL carry a meta line of the facts the application actually holds for that turn — its ordinal, its duration, and its recorded token figures in the LABELLED form of the shared notation (`usage-figure-rendering`). Each SHALL be rendered ONLY when held: a turn whose provider reported no usage SHALL show no figure, and no meta value SHALL be estimated, derived, or otherwise fabricated to fill the line. A user turn SHALL carry no token figure — the cost was not incurred by the party that sent the message.

The labelled form here, unlike the rail's rows. This header runs the full width of the stream and carries three or four facts at most, so it has the cells to spend; and it is the one place a figure appears on EVERY turn, which makes it where a reader learns to read the notation at all — words teach it, arrows assume it has already been taught.

The figure SHALL survive a transcript reload. The turn's rollup is persisted onto the turn's own assistant message when the turn is appended, and read back when the transcript loads, so a reopened conversation carries the same figures the live headers showed. Without this, absence on this field would acquire a second meaning — "this turn was reloaded" alongside "no provider reported anything" — and a reader could no longer tell which one a bare header is stating. The duration is deliberately NOT reconstructed: it is genuinely not stored, and inventing one would be exactly the fabrication this requirement forbids.

The prohibition this requirement previously carried — that no meta footer be rendered at all, on the grounds that the data is not tracked — no longer describes the system: the turn's usage rollup is now tracked end to end, rendered live, and persisted. The rule that survives it is the one that mattered, restated above: what is not held is not shown.

A user turn SHALL additionally differentiate itself with a left border rule in the user color (`border={["left"]}`, `theme().user`) on its parts container — the design system's quoted-content idiom. The rule MUST NOT break gutter alignment: the border glyph consumes one cell, so the user body's left padding SHALL shrink by one cell to keep body text in the same column as assistant bodies, and the header line (the `>` marker in the gutter) SHALL stay outside the bordered box. Assistant turns are unchanged.

#### Scenario: Role selects the marker

- **WHEN** a user turn and an assistant turn render
- **THEN** the user turn shows `>` in the user color and the assistant turn shows `<` in the assistant color, both in the same 2-space gutter column

#### Scenario: Streaming behavior preserved

- **WHEN** the assistant response streams in
- **THEN** deltas render live and flush into the store on completion, identical to the pre-change behavior

#### Scenario: An assistant turn shows the figures it has

- **GIVEN** a completed turn whose provider reported usage
- **THEN** the assistant header carries its token figures in the shared notation

#### Scenario: A turn that reported nothing shows no figure

- **GIVEN** a completed turn whose provider reported no usage
- **THEN** the assistant header carries its ordinal and duration and no token figure

#### Scenario: A reloaded turn still shows its figures

- **GIVEN** a completed turn whose provider reported usage, in a conversation that is then reopened
- **WHEN** the transcript loads
- **THEN** the turn's header carries the same figures it showed live, and its duration is absent

#### Scenario: A user turn carries no token figure

- **WHEN** a user turn renders
- **THEN** its header carries no token figure

#### Scenario: User turns carry the rule, aligned

- **WHEN** a user turn renders above an assistant turn
- **THEN** the user body shows a left rule in the user color, and both bodies' text starts in the same column (the rule + reduced padding equals the assistant's gutter indent)

### Requirement: Toggleable four-section sidebar

`Sidebar` MUST render four sections in a fixed order: SESSION, ANALYSIS, DATA PROFILE, RUNS. It is a fixed-width, full-height column with a divider against the chat column. The order is the pipeline order: the inputs of the analysis feed the data profile, and the profile feeds the runs. The width MUST come from `size.railWidth` (the design-tokens layer), NOT an inline integer, and the rail is NOT mouse-resizable.

SESSION MUST show the short session id (`S·` + the first 4 hex of the id), the absolute created time of the session (`toLocaleString()`, the durable-record rendering), and the message count from live data. A click on the id chip MUST copy the full id, per `report-session-identity`. A report child MUST carry the context line, per the same capability.

ANALYSIS MUST show the analysis name, the input count, and the project name when one exists. It MUST show the anchor path, with a ✓/⚠ badge from the `markerWritten` of the anchor. DATA PROFILE and RUNS MUST render live ledger data per the `sidebar-live` capability (states, refresh, details views, the active-run progress embed). The sidebar MUST NOT display mock fixtures, and it MUST NOT display values fabricated inline at the render site. The data of the sidebar MUST update when the open analysis or session changes (an in-place `openSession` swap).

The section stack of the rail MUST be vertically scrollable. When the sections outgrow the height of the rail, the rail scrolls, and it does not clip or squeeze a section. (The progress embed of the RUNS section makes the height variable.) The scroll container MUST NOT take focus on mount, because the rail is not a focus target and mouse-wheel scrolling suffices. It MUST introduce no scroll keybinding.

The ANALYSIS anchor-path line MUST render only when the terminal is below the breakpoint (`size.breakpointWide`). At or above it, the path moves to the status bar (see the status bar requirement). The ✓/⚠ badge then MUST join the ANALYSIS meta line (inputs · project). The badge reports anchor-marker health, not the path, and it never moves to the header.

Section headers MUST use vertical space responsively. A section whose value is one short string (the short id of SESSION, the name of ANALYSIS) MUST render `LABEL <flex gap> value` on one row. The condition is that the label, a gap, and the value fit the usable width of the rail. When they do not fit, the section MUST fall back to the stacked layout: the label above a full-width value line. Thus a long analysis name is never truncated, and it never wraps inside a right-hand cell. A section whose first line is a composite (the glyph-bearing `N files · time` line of DATA PROFILE) keeps the stacked layout, and a row-list section (RUNS) does too. The merge models a single plain value, not a styled composite. The fit decision counts cells (one character for each cell) against the rail width minus its padding and border.

#### Scenario: Sidebar renders live sections for an open analysis

- **WHEN** the sidebar renders for an open analysis
- **THEN** SESSION/ANALYSIS show live SQLite-backed data and DATA PROFILE/RUNS show live ledger-backed states per `sidebar-live` — nothing rendered is mock

#### Scenario: Sections render in pipeline order

- **WHEN** the sidebar renders
- **THEN** the sections appear top-to-bottom as SESSION, ANALYSIS, DATA PROFILE, RUNS

#### Scenario: The session time is absolute

- **WHEN** the SESSION section renders for a session with a created time
- **THEN** the line shows the absolute local date-time, not a relative age

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

- **WHEN** the sections (for example RUNS with the active-run progress embed) outgrow the height of the rail
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

### Requirement: Input bar footer shows mode info and mode-scoped hints

`ChatBar` MUST compose the shared `TextArea` with `chrome="full"` and the `Type a message…` placeholder (through `GLYPHS.ellipsis`). It MUST render one external footer row below the bordered textarea. The footer row MUST show the mode word on the left: `INSERT` when the textarea holds focus, and `NORMAL` when it is blurred. `NORMAL` renders bold in the accent color, and the row gets a `bgActive` background. Beside the mode word the footer MUST render the session scope word, per `report-session-identity`. The newline chord hint (`ctrl+j newline`) sits on the right.

While a turn is busy, the footer MUST render the mode-scoped interrupt affordance after the mode and scope words. In NORMAL it is the interrupt hint, labeled from the live `app.interrupt` binding. While the window is armed, the hint flips to its "again to interrupt" form, with a distinct armed treatment. The armed treatment MUST stay distinguishable from the accent mode word on the `bgActive` row, on light themes included. In INSERT it is the abort-chord hint, labeled from the live `app.abort` binding — the one chord that interrupts while the user types.

The hint MUST be absent when the turn is idle. It MUST also be absent when a dialog is stacked, and when an approval prompt is docked. These are the honesty gates of the interrupt binding itself. Labels MUST derive from the live bindings (`chordLabel`, never hand-written), and they arrive as data. `ChatBar` keeps its no-domain-imports rule.

GLOBAL keybind hints (command-palette, sidebar-toggle, quit) MUST NOT appear in this footer. They live ONLY in the status bar, thus the header and the footer never show the same keys. The footer carries only the mode word, the session scope word, and what the interrupt keys mean in the current mode.

#### Scenario: ChatBar composes TextArea

- **WHEN** the chat renders the input area
- **THEN** `ChatBar` renders a `TextArea` with `chrome="full"` for the bordered textarea, plus its own external footer row

#### Scenario: The footer carries the scope word

- **WHEN** the chat renders on a report thread
- **THEN** the footer shows the scope word beside the mode word, and the global keys stay in the header

#### Scenario: Busy NORMAL shows the esc hint beside the mode word

- **WHEN** a turn streams and the pane holds focus (NORMAL, unarmed)
- **THEN** the footer shows `NORMAL` followed by the interrupt hint labeled from the live binding, and the newline hint stays on the right

#### Scenario: Arming flips the footer hint

- **WHEN** the user pushes esc one time in NORMAL during a turn
- **THEN** the footer hint flips to its "again to interrupt" form with the distinct armed treatment
- **AND** the hint reverts when the window lapses or the turn ends

#### Scenario: Busy INSERT advertises the abort chord

- **WHEN** a turn streams while the composer holds focus (INSERT)
- **THEN** the footer shows `INSERT` followed by the abort-chord hint (the one-stroke interrupt that works while the user types)

#### Scenario: Idle, dialogs, and asks keep the footer quiet

- **WHEN** no turn is in flight, or a dialog is stacked, or an approval prompt is docked
- **THEN** the footer shows no interrupt affordance — only the mode word, the scope word, and the newline hint

#### Scenario: Global keys live in the header only

- **WHEN** the user looks for the command-palette or sidebar shortcuts
- **THEN** they appear in the status bar, and the input footer does not show them

#### Scenario: NORMAL mode has distinct visual treatment

- **WHEN** the textarea is blurred (NORMAL mode)
- **THEN** the footer row shows `NORMAL` in the bold accent color with the `bgActive` background, which signals that the vim scroll keys are live

### Requirement: Shared gutter marker set

The system SHALL define the gutter marker set as a shared constant (`MARKERS`) in `src/lib/design_system.ts` (the merged design-system module — solid-js-free, importable by both the shell and the `components/` block widgets without a components→layout dependency) — one entry per kind: `you >`, `assistant <`, `thinking ◆`, `tool ▸`, `run ●`, `fileEdit ✎`, `ok ✓`, `error ✗` — each mapping to its glyph and an existing `ThemeColors` role (the `thinking` and `tool` kinds use the dedicated `thinking`/`tool` roles; `run` uses `warning`). The set is the single source for every block's marker: `MessageBlock` (shell) reads `you`/`assistant`, and the `components/` block widgets read the rest.

#### Scenario: Message block reads the marker set

- **WHEN** a user or assistant turn renders
- **THEN** its gutter marker glyph and color come from the shared marker set in `src/lib/design_system.ts`, not an inline literal

#### Scenario: Block widgets read the marker set

- **WHEN** a thinking / tool / run / file-edit / error block widget renders
- **THEN** its marker glyph and role come from the shared set, imported from the tui root (no components→layout import)

### Requirement: The empty-buffer placeholder advertises prompt-history recall

A chord that does something but is announced nowhere is a chord nobody finds. `ChatBar` SHALL take a
`canRecall` boolean prop — derived by the host from the live history and retract window and handed
down as data, keeping the component's no-domain-imports rule — and, when it is true and no boot gate
applies, SHALL append a recall affordance to the empty-buffer placeholder naming the chord
(`RECALL_LABEL`, derived from the bound chord in `keymap.ts`, never hand-written here).

The placeholder is the only honest home for this hint, and it is chosen over a footer entry for
reasons that are not merely aesthetic: it renders exactly when the buffer is empty, which is exactly
when a recall can be entered; it disappears the moment the user types, so it cannot become permanent
furniture; it costs no additional rows on a composer whose footer already carries the mode word, the
interrupt affordance, and the newline hint; and it is absent in a session with nothing to recall
rather than advertising a key that would do nothing.

`canRecall` SHALL be false whenever the retract window owns the chord instead, mirroring the
interrupt hint's honesty gates. A boot gate (`booting` / `failed`) SHALL outrank the affordance
entirely — that placeholder explains why typing goes nowhere, and a recall hint layered on top would
advertise a chord whose result could not be sent.

#### Scenario: Something to recall names the chord

- **WHEN** the composer is empty, ungated, and the host reports a recallable history
- **THEN** the placeholder reads `Type a message…` followed by the recall affordance naming the bound chord

#### Scenario: Nothing to recall keeps the placeholder bare

- **WHEN** the composer is empty and the host reports no recallable history (a first-run session, or the retract owning the chord)
- **THEN** the placeholder is the plain `Type a message…` with no recall affordance

#### Scenario: A boot gate outranks the affordance

- **WHEN** the runtime is still booting and the host reports a recallable history
- **THEN** the placeholder shows only the booting explanation, with no recall affordance

### Requirement: The chat shell composes a run-activity panel between stream and input

The chat shell's main column SHALL compose, in order: the message stream's scroll region, the
run-activity panel, then the input. The panel SHALL be part of the composition kit alongside the
status bar, message block, chat bar, and sidebar.

The panel SHALL contribute rows only when it has a run to show and has not been dismissed;
otherwise the stream and input SHALL compose exactly as they do without it.

The scroll region SHALL remain the flexible child that absorbs vertical pressure, so adding the
panel reduces visible stream rows rather than squeezing the input or the panel itself.

#### Scenario: The panel takes its place in the column

- **WHEN** a run is active and the panel is not dismissed
- **THEN** the shell renders the stream, then the panel, then the input, in that order

#### Scenario: No active run leaves the layout unchanged

- **WHEN** no run is active
- **THEN** the shell's composition is identical to one with no panel at all

#### Scenario: The stream absorbs the space

- **WHEN** the panel appears during an active run
- **THEN** the scroll region shrinks to make room and the input keeps its full height

### Requirement: Fixed chrome below the scroll region is opaque and non-shrinking

A fixed row placed directly beneath the message stream's scroll region SHALL render as a
full-width box painted with the panel background, and SHALL declare that it does not shrink.
This governs the run-activity panel and any future chrome in that position.

Both properties are load-bearing rather than stylistic. A `flexGrow` scroll region renders one row
taller than the height it contributes to the column, so the row beneath it overlaps the scroll
region's last row; a bare text element paints only its own glyphs and lets scrolled content show
through the gaps between them. Separately, a non-numeric width defaults to shrinking, so an
unconstrained panel collapses below its own border on a short terminal.

Layout SHALL be verified across a range of terminal heights, since this class of defect is
size-dependent and passes at most single heights.

#### Scenario: Scrolled content does not bleed through

- **WHEN** the stream is scrolled so content sits at the boundary with the panel
- **THEN** the panel's row is fully painted across the width and no stream content is visible within it

#### Scenario: A short terminal does not collapse the panel

- **WHEN** the terminal height is reduced until the layout is under pressure
- **THEN** the panel retains its rows and the scroll region absorbs the reduction

#### Scenario: The defect is checked at more than one size

- **WHEN** the panel's layout is verified
- **THEN** it is exercised across a sweep of terminal heights rather than a single size
