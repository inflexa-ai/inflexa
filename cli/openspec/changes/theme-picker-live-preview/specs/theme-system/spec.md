## ADDED Requirements

### Requirement: Live preview in the palette theme picker

The chat TUI's "Change theme" picker SHALL preview themes live, extending the config screen's preview contract to the palette switch surface. Moving the cursor onto a theme row SHALL apply that theme immediately via `setTheme` — the whole running render root, the open picker included, recolors on the next frame — without persisting it. The picker SHALL open with the cursor on the currently-persisted theme, so opening it previews nothing until the user moves. Any non-commit close (esc, click-outside, ctrl+c) SHALL revert the live theme to the persisted one; selecting a row SHALL apply and persist it via `writeConfig` (the existing select path). While a filter query matches no rows, the preview SHALL revert to the persisted theme; rows returning resume preview from the new cursor row.

#### Scenario: Highlight previews without persisting

- **WHEN** the user moves the cursor across theme rows in the palette picker
- **THEN** each highlighted theme is applied live to the running root, and `config.json` still holds the previously-persisted theme

#### Scenario: Picker opens on the persisted theme

- **WHEN** the picker opens while a non-default theme is persisted
- **THEN** the cursor sits on that theme's row and the active theme is unchanged by the act of opening

#### Scenario: Cancel reverts the preview

- **WHEN** the user previews a different theme and dismisses the picker without selecting (esc, click-outside, or ctrl+c)
- **THEN** the live theme reverts to the persisted one

#### Scenario: Select commits the preview

- **WHEN** the user presses enter on a highlighted theme
- **THEN** that theme stays active and is persisted via `writeConfig`

#### Scenario: Empty filter reverts, matching resumes

- **WHEN** the user types a filter matching no themes
- **THEN** the persisted theme is live again, and editing the query so rows return previews the new cursor row
