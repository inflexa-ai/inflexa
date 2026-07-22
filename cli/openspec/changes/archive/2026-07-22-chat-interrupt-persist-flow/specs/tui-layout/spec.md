## RENAMED Requirements

- FROM: `### Requirement: Input bar footer shows session/mode info, not keybinds`
- TO: `### Requirement: Input bar footer shows mode info and mode-scoped hints`

## MODIFIED Requirements

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

`StatusBar` SHALL render a left region, an OPTIONAL middle region, and a right region. Left = `inflexa` in `theme().accent` plus a screen title or the active analysis name. The middle region is parameterized by the caller: in the chat it SHALL show the live session state (`ready`/`thinking`/`error`), each with a leading glyph (e.g. `● ready`), colored `theme().success`/`theme().warn`/`theme().error` and sourced from the shared chat-status store (see "Chat status lives in a shared reactive store"); in `config` it SHALL show the unsaved-changes indicator in `theme().warn` and SHALL render nothing when there are no unsaved changes. Right = affordance hint labels sourced from the central keymap. `StatusBar` SHALL import only `theme` (no `modules/`/`db/` imports) and SHALL be composed by both `app.tsx` and `app_config.tsx`, replacing their hand-rolled header boxes. All colors SHALL come from `theme()`; no hex is inlined.

The chat's `StatusBar` SHALL additionally accept an OPTIONAL workspace-path segment, rendered as a muted ` | <path>` segment immediately after the state segment — part of the left-flowing segments, NOT the right-aligned hints region. `app.tsx` SHALL pass it only when the terminal width is at or above the design-system breakpoint token (`size.breakpointWide`), sourcing the value from the workspace store's `workingDir` with the home directory contracted to `~`; below the breakpoint the prop is absent and the path renders in the sidebar instead (see the sidebar requirement). `StatusBar` itself stays dumb — it renders whatever path string it is given and keeps its no-domain-imports rule.

The status bar SHALL NOT render the interrupt hint: that affordance is mode-scoped and lives in the input-bar footer beside the mode word it depends on (see "Input bar footer shows mode info and mode-scoped hints"). The interrupt-hint clause and its scenarios (busy hint, INSERT/dialog/ask honesty, armed flip) move to that requirement; the status bar carries no state-aware turn affordances.

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

#### Scenario: No interrupt hint in the header

- **WHEN** a turn is streaming in NORMAL mode
- **THEN** the status bar's right hints region shows no interrupt hint — the input-bar footer carries it

### Requirement: Input bar footer shows mode info and mode-scoped hints

`ChatBar` SHALL compose the shared `TextArea` component with `chrome="full"` and the `Type a message…` placeholder (via `GLYPHS.ellipsis`), and render a single external footer row below the bordered textarea. The footer row SHALL show the mode word on the left (`INSERT` when the textarea is focused, `NORMAL` when blurred — with `NORMAL` rendered in bold with the accent color and the row given a `bgActive` background) and the newline chord hint on the right (`ctrl+j newline`). After the mode word the footer SHALL render the mode-scoped interrupt affordance while a turn is busy: in NORMAL, the interrupt hint labeled from the live `app.interrupt` binding, flipping to its "again to interrupt" form with a visually distinct armed treatment while the window is armed (the armed treatment SHALL remain distinguishable from the accent mode word on the `bgActive` row, on light themes included); in INSERT, the one-press abort-chord hint labeled from the live `app.abort` binding. The hint SHALL be absent when idle, when a dialog is stacked, or when an approval prompt is docked — the same honesty gates as the interrupt binding itself. Labels SHALL derive from the live bindings (`chordLabel`, never hand-written), arriving as data — `ChatBar` keeps its no-domain-imports rule. GLOBAL keybind hints (command-palette, sidebar-toggle, quit) SHALL NOT appear in this footer: they live ONLY in the status bar, so the header and the footer never repeat the same keys — the footer carries only the mode word and what the interrupt keys mean in the current mode.

#### Scenario: ChatBar composes TextArea

- **WHEN** the chat renders the input area
- **THEN** `ChatBar` renders a `TextArea` with `chrome="full"` for the bordered textarea, plus its own external footer row

#### Scenario: Busy NORMAL shows the esc hint beside the mode word

- **WHEN** a turn is streaming and the pane holds focus (NORMAL, unarmed)
- **THEN** the footer shows `NORMAL` followed by the interrupt hint labeled from the live binding, and the newline hint stays on the right

#### Scenario: Arming flips the footer hint

- **WHEN** the user presses esc once in NORMAL during a turn
- **THEN** the footer hint flips to its "again to interrupt" form with the distinct armed treatment for the armed window, then reverts when the window lapses or the turn ends

#### Scenario: Busy INSERT advertises the one-press chord

- **WHEN** a turn is streaming while the composer holds focus (INSERT)
- **THEN** the footer shows `INSERT` followed by the abort-chord hint (the one-press interrupt that works while typing)

#### Scenario: Idle, dialogs, and asks keep the footer quiet

- **WHEN** no turn is in flight, or a dialog is stacked, or an approval prompt is docked
- **THEN** the footer shows no interrupt affordance — only the mode word and the newline hint

#### Scenario: Global keys live in the header only

- **WHEN** the user looks for the command-palette / sidebar shortcuts
- **THEN** they appear in the status bar, not duplicated in the input footer

#### Scenario: NORMAL mode has distinct visual treatment

- **WHEN** the textarea is blurred (NORMAL mode)
- **THEN** the footer row shows `NORMAL` in bold accent color with `bgActive` background, signaling that vim scroll keys are live
