## MODIFIED Requirements

### Requirement: Layout composition kit directory

The system SHALL house the chat TUI's app-shell composition kit under `src/tui/layout/`, one component per file with no barrel/index re-exports — today `status_bar.tsx`, `message_block.tsx`, `chat_bar.tsx` (renamed from `input_bar.tsx`), `sidebar.tsx`, and `design_gallery.tsx`. (The gutter marker set is NOT a shell-composition part; it is design-system vocabulary and lives in `src/lib/design_system.ts` so the `components/` block widgets may import it — see the "Shared gutter marker set" requirement.) A `layout/` part MAY be single-caller and MAY import domain types/queries (`src/types/`, `src/db/`, `src/modules/`), because it is structural app-shell composition rather than a reusable domain-agnostic widget. This is a deliberate, scoped exception to the "don't extract single-caller sub-components" rule, and `CLAUDE.md`'s Project-structure section SHALL document `src/tui/layout/` and this exception. `layout/` components MUST NOT be imported by `src/modules/` (presentation depends on logic, never the reverse).

#### Scenario: Kit part lives in layout/

- **WHEN** a part composes the chat shell (status bar, message block, chat bar, or sidebar)
- **THEN** it resides in `src/tui/layout/` as its own file, imported directly by its caller

#### Scenario: Single-caller, domain-coupled part is allowed

- **WHEN** a `layout/` part is composed by only `app.tsx` and imports domain types or db queries
- **THEN** it still belongs in `layout/` (the single-caller and components/-membership rules do not apply to the shell kit)

### Requirement: Input bar footer shows session/mode info, not keybinds

`ChatBar` (renamed from `InputBar`, in `layout/chat_bar.tsx`) SHALL compose the shared `TextArea` component with `chrome="full"` and render a single external footer row below the bordered textarea. The footer row SHALL show the mode word on the left (`INSERT` when the textarea is focused, `NORMAL` when blurred — with `NORMAL` rendered in bold with the accent color and the row given a `bgActive` background) and the newline chord hint on the right (`ctrl+j newline`). Global keybind hints SHALL NOT be duplicated in this footer: the command-palette, sidebar-toggle, and abort key hints live ONLY in the status bar, so the header and the input footer never repeat the same keys.

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
