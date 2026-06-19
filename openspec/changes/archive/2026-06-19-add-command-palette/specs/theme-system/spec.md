## MODIFIED Requirements

### Requirement: Live theme switching

Calling `setTheme(id)` SHALL repaint the currently-running render root in place — every themed surface in that root recolors on the next frame, with no process restart and no renderer re-creation. The `inf config` screen remains a user-facing switch surface, and the chat TUI (`app.tsx`) SHALL ALSO provide in-session switch surfaces via the command palette's "Change theme" command and the embedded Settings dialog. In all cases the switch repaints the running render root in place and the chosen theme is persisted via `writeConfig`. The chat TUI SHALL still apply the persisted theme at launch.

#### Scenario: Config screen recolors live on switch

- **WHEN** the theme is switched while `inf config` is running
- **THEN** the config screen's chrome, notices, and theme list recolor on the next frame without a restart

#### Scenario: Chat TUI reflects the saved theme at launch

- **WHEN** the chat TUI starts after a theme was saved
- **THEN** its message text, role labels, borders, and markdown code blocks render in the saved theme

#### Scenario: Chat TUI switches theme in-session via the palette

- **WHEN** the user runs "Change theme" from the command palette and selects a theme
- **THEN** the running chat TUI recolors on the next frame and the selection is persisted via `writeConfig`
