## MODIFIED Requirements

### Requirement: Command palette invocation and navigation

The chat TUI SHALL open the command palette on **Ctrl+K**, calling `key.preventDefault()` so the textarea does not also consume the key. The palette SHALL render a focused single-line search `<input>`, a grouped, scrollable result list (`<scrollbox>`) with the highlighted row scrolled into view, and a per-row keybind hint when a command declares one. The invocation hint and the per-row keybind hints SHALL be rendered through the central keymap (`src/tui/keymap.ts`) as platform-neutral, lowercase labels (e.g. `ctrl+k`, `ctrl+c`); the bound chord (Ctrl+K) SHALL be unchanged. Navigation SHALL be Up/Down (and Ctrl+P / Ctrl+N); Enter SHALL dispatch the highlighted command through `runCommand` and close the palette; Esc SHALL close it without acting.

#### Scenario: Open with Ctrl+K

- **WHEN** Ctrl+K is pressed in the chat
- **THEN** the palette opens with the search input focused and the textarea does not receive a `k` character

#### Scenario: Filter and run

- **WHEN** the user types a query and presses Enter
- **THEN** the highlighted matching command runs via `runCommand` and the palette closes

#### Scenario: Cancel

- **WHEN** Esc is pressed in the palette
- **THEN** the palette closes and no command runs

#### Scenario: Keybind hints come from the keymap

- **WHEN** a command declares a keybind hint and the palette renders its row
- **THEN** the hint shows the platform-neutral lowercase label (e.g. `ctrl+c`) resolved from the central keymap
