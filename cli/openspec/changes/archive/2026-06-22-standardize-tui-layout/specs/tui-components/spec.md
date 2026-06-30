## MODIFIED Requirements

### Requirement: Shared TUI component directory with a membership rule

The system SHALL house shared, domain-agnostic TUI widgets under `src/tui/components/`. A widget SHALL belong in `components/` only when it (a) imports nothing beyond `theme` and `@opentui/*` / `solid-js` — no imports from `src/modules/`, `src/db/`, or other domain code — and (b) has two or more callers. Widgets SHALL be one component per file (no barrel/index re-exports), and callers SHALL import each component from its own file. A palette- or feature-specific adapter (e.g. `CommandPalette`, which maps `Command` domain objects) SHALL NOT live in `components/`; it stays in the `tui/` app-shell.

The chat TUI's app-shell **composition kit** is distinct from reusable widgets and SHALL live in `src/tui/layout/` (see the `tui-layout` capability), distinguished by **role** rather than by import shape: `components/` holds reusable, domain-agnostic widgets, while `layout/` holds the structural parts the screen is assembled from. A kit part SHALL stay in `layout/` even when it would otherwise satisfy the `components/` rule — for example a generic, multi-caller `StatusBar` that imports only `theme` belongs in `layout/`, not `components/`, because it is shell composition.

#### Scenario: Generic widget lives in components/

- **WHEN** a widget imports only `theme` + opentui/solid and has ≥2 callers
- **THEN** it resides in `src/tui/components/` as its own file, imported directly by each caller

#### Scenario: Domain-coupled adapter stays out of components/

- **WHEN** a component imports domain types (e.g. `Command`, an `Analysis`) or module code
- **THEN** it stays in the `tui/` app-shell, not in `components/`

#### Scenario: Composition kit lives in layout/, not components/

- **WHEN** a part is one of the app-shell composition kit (status bar, message block, input bar, sidebar) — even a generic, multi-caller one like `StatusBar`
- **THEN** it resides in `src/tui/layout/`, not `src/tui/components/`, because the two directories are distinguished by role (shell composition vs reusable widget)
