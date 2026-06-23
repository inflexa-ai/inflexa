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

