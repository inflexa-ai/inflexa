# key-bindings Specification

## Purpose
TBD - created by archiving change standardize-tui-layout. Update Purpose after archive.
## Requirements
### Requirement: Central platform-neutral keymap

The system SHALL define a single keymap module `src/tui/keymap.ts` mapping each logical action (e.g. open palette, toggle sidebar, abort) to its real key chord plus a fixed display label. Labels SHALL be platform-neutral and ALWAYS lowercase `ctrl+`/`alt+` text (e.g. `ctrl+k`, `ctrl+b`, `ctrl+c`, `esc`, `enter`) — identical on macOS, Linux, and Windows. Lowercase is a fixed rule for every keybind hint shown in the TUI. No macOS ⌘/⌥ glyphs are used: terminals do not forward Cmd to the app, so the project deliberately targets one lowercase Ctrl/Alt convention everywhere. The module SHALL import no platform or opentui APIs (it is pure data plus a structural `matchChord`). It SHALL be the single source of keybind hint strings shown anywhere in the TUI — the chat shell and the config screen (which shares `StatusBar`) — and its action set SHALL include the config screen's keys (e.g. `save`, `exit`, `moveSelection`). The previously hardcoded hint strings in `app.tsx`, `app_config.tsx`, and the palette SHALL be replaced by reads from this module.

#### Scenario: Labels are identical on every platform

- **WHEN** the keymap renders the open-palette and sidebar-toggle labels
- **THEN** they read `ctrl+k` and `ctrl+b` regardless of the host OS

#### Scenario: Every hint is lowercase

- **WHEN** any keybind hint label is read from the keymap
- **THEN** it contains no uppercase letters (e.g. `ctrl+c`, `esc`, `enter`, never `Ctrl+C` or `Esc`)

#### Scenario: Single source of truth

- **WHEN** a keybind hint is shown anywhere in the TUI (status bar, palette row)
- **THEN** its label string comes from `src/tui/keymap.ts`, not a literal inline string

#### Scenario: Config screen hints come from the keymap

- **WHEN** the config screen renders its `StatusBar` key hints (save / exit / move)
- **THEN** those label strings are read from `src/tui/keymap.ts`, not inlined in `app_config.tsx`

### Requirement: Real chords stay terminal-deliverable

The primary navigation chords SHALL use Ctrl, NOT Alt, because terminals deliver Alt/Option unreliably — on macOS the Option key composes a special character (e.g. Option+s → `ß`) instead of sending a modifier, so an Alt chord may never reach the app. Cmd/⌘ is likewise never used — terminals do not forward it. The chord matcher SHALL still accept Alt from EITHER the `option` or the `meta` flag for any binding that opts into it (e.g. the textarea newline), because terminals that DO deliver Alt do so inconsistently. Changing a chord or its label SHALL be a single edit localized to the keymap module.

#### Scenario: Navigation chords are Ctrl

- **WHEN** the palette-open and sidebar-toggle chords are defined
- **THEN** they are `ctrl+k` and `ctrl+b` (Ctrl), not Alt chords

#### Scenario: Invocation chord works on any platform

- **WHEN** Ctrl+K is pressed in the chat
- **THEN** the command palette opens

