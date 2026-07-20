# tui-test-coverage Specification

## Purpose
TBD - created by archiving change add-test-suite. Update Purpose after archive.
## Requirements
### Requirement: The bus-event reducer is tested
The suite SHALL verify `applyBusEvent` (`tui/hooks/conversation.ts`) inside a `createRoot` scope for
all event types — `session.status` (flush stream on idle), `message.created`, `part.updated`
(upsert), `part.delta` (accumulate in the stream signal), `session.error` — and that every branch
filters by `sessionId` (events for another session are ignored).

#### Scenario: delta accumulates then flushes on idle
- **WHEN** several `part.delta` events arrive followed by a `session.status` idle event
- **THEN** the deltas accumulate in the stream signal and flush into the store exactly once on idle

#### Scenario: foreign-session events are ignored
- **WHEN** an event carries a different `sessionId` than the active session
- **THEN** the store is unchanged

### Requirement: TUI stores are tested
The suite SHALL verify the theme store (`setTheme`/`theme()` round-trip and `noticeColor`
role→color mapping) and the status store (`setChatStatus`/`chatStatus`) inside `createRoot`, with
global state reset between cases.

#### Scenario: theme round-trip
- **WHEN** `setTheme(id)` is called and `theme()` is read
- **THEN** the palette reflects the selected theme

#### Scenario: notice color maps to a role
- **WHEN** `noticeColor` is given each notice kind
- **THEN** it returns the mapped theme role color

### Requirement: Keymap config-resolution is tested
The suite SHALL verify `resolveKeybind`/`keybindLabel`/`leaderSeq` against a config fixture and an
end-to-end remap: rebinding a command id changes which chord triggers it through `dispatchKey`.

#### Scenario: a remapped command responds to the new chord
- **WHEN** `config.keybinds` rebinds a command id to a new chord and a key is dispatched
- **THEN** the command fires on the new chord and not on the old one

### Requirement: Core components render headlessly
The suite SHALL verify, via the `testRender` frame helper swept across at least two terminal
heights, that a representative dialog component (e.g. `dialog_panel`/`select_list`) renders its
title and content without the documented scrollbox-overlap or border-collapse artifacts.

#### Scenario: dialog renders across heights
- **WHEN** the component is rendered at a short and a tall height
- **THEN** the captured frame contains the title and footer at both heights (no row bleed)

### Requirement: Rendered-span contrast is guarded across the block set

The suite SHALL guard the rendered contrast of TUI blocks by inspecting resolved span colors, not characters. For each covered block it SHALL render headlessly under the sharpest light theme (`github-light`, `bg` = `#ffffff`), walk the captured spans, resolve each span's foreground against the surface actually painted behind it, and fail when a span falls below its contrast floor — naming the block, the span's text, the measured ratio, and the resolved colors.

Floors SHALL follow the two established tiers, and a span's tier SHALL be derived from its content rather than declared per component: a span whose trimmed text consists **solely** of decorative glyphs SHALL be held to **3:1**; every other span, including any span mixing decorative and non-decorative characters, SHALL be held to **4.5:1**.

The decorative set SHALL be exactly those glyph shapes the design system paints in its decorative tiers — the box-drawing frame glyphs and the inline separator, which render in `border`, plus the ornament rendered in `fgSubtle`: progress-meter cells and unselected gutter markers such as a not-yet-started step's hollow circle. It SHALL be maintained as a list of `GLYPHS` **keys** rather than raw characters, so a renamed or retired glyph fails the build instead of silently relaxing a span's floor. Holding any of these to the text floor would flag tokens the palette matrix already blesses at 3:1 and would push the fix toward retuning `fgSubtle` to 4.5:1, which `design_system.ts` explicitly rejects as collapsing that tier into `fgMuted`.

An unclassified span SHALL fall to the stricter floor, so the guard errs toward a loud failure rather than a silent pass.

Coverage SHALL follow the design gallery's block set, reusing the shared mock fixtures where a block has them, so the blocks under guard track the surfaces the gallery is already required to exhibit. A block that begins rendering text SHALL be brought under this guard in the same change that introduces it — the same obligation the pair matrix already places on a component that renders a new token/background pair.

#### Scenario: An unthemed title fails the guard

- **WHEN** a block renders a title that resolves the renderable's default white foreground instead of a theme color
- **THEN** the guard fails, naming the block, the offending text, and the measured ratio against its surface

#### Scenario: Decorative ornament passes at the non-text floor

- **WHEN** a block paints a panel frame, a progress-meter cell, or a separator dot in the `border`/`fgSubtle` tier at between 3:1 and 4.5:1
- **THEN** the guard passes it, because ornament is held to the non-text floor rather than the text floor

#### Scenario: A newly added block is covered

- **WHEN** a new stream block that renders text is added and exhibited in the design gallery
- **THEN** it is also covered by the rendered-span guard in the same change

### Requirement: Character-frame assertions do not establish visibility

The suite SHALL treat a `captureCharFrame()` assertion — including `toContain(...)` on a rendered frame — as evidence that a glyph was emitted, never as evidence that it is legible. Character frames carry no color, so a span rendered in an unreadable foreground satisfies them exactly as a correctly-themed one does. Any claim that a surface is *visible* SHALL be backed by a span-color assertion.

Fixtures SHALL NOT let one rendered string stand in for another. A frame assertion whose expected string appears in more than one place in the block (for example a card whose title and whose row name are the same value) SHALL use distinct values, so the assertion pins the element it names.

#### Scenario: A visibility claim is backed by color

- **WHEN** a test asserts that a block's title is shown to the user
- **THEN** it asserts on the resolved span foreground, not only on the presence of the title's characters in the captured frame

#### Scenario: Fixtures distinguish co-rendered strings

- **WHEN** a block renders two fields that a frame assertion could confuse (such as a card title and an entry name)
- **THEN** the fixture gives them distinct values so a missing or unpainted field cannot be masked by the other

