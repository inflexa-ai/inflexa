## MODIFIED Requirements

### Requirement: Expanded semantic token vocabulary

The theme token set SHALL be a standards-grounded functional vocabulary, grouped by prefix, with these roles and meanings:

- **Surfaces**: `bg` (app background), `bgRaised` (elevated chrome — header/status bars, rail, panels), `bgActive` (hovered/selected/focused element background).
- **Foreground (three tiers)**: `fg` (primary text), `fgMuted` (labels, meta), `fgSubtle` (hints, faint, disabled).
- **Borders (two tiers)**: `border` (subtle dividers and frames), `borderFocus` (focused/active region).
- **On-color**: `onAccent` (text/icons placed on a filled accent or status background).
- **Accent**: `accent` (primary accent, focus, links), `secondary` (secondary accent).
- **Status**: `success`, `warning`, `error`, `info`.
- **Domain**: `user`, `assistant`, `tool`, `thinking`.

Every token SHALL be present and non-empty in every built-in theme; partial themes SHALL NOT be representable in the `Theme` type. The vocabulary supersedes the prior names: `bgPanel`→`bgRaised`, `bgFocused`→`bgActive`, `muted`→`fgMuted`, `borderActive`→`borderFocus`, `warn`→`warning`, and the prior `selected` role is folded into `bgActive`. The design doc's example role names (`surface`/`raised`/`fgFaint`/`id`/`ok`/`danger`) SHALL NOT be used; the standard nouns (`success`/`error`, the `bg*/fg*/border*` grouping) are authoritative. No hex SHALL be inlined at any call site; colors SHALL be read as `theme().<role>` inside a tracking scope.

#### Scenario: All tokens present in every built-in

- **WHEN** the project type-checks
- **THEN** each built-in theme object satisfies the `Theme` type with all color tokens (including `fgSubtle`, `onAccent`, `tool`, `thinking`) defined, so no `undefined` color can reach the renderer

#### Scenario: Renamed tokens repoint at every call site

- **WHEN** a consumer previously read `theme().bgPanel`, `theme().bgFocused`, `theme().muted`, `theme().borderActive`, `theme().warn`, or `theme().selected`
- **THEN** it now reads the corresponding new role (`bgRaised`, `bgActive`, `fgMuted`, `borderFocus`, `warning`, `bgActive`) and the old name no longer exists in `ThemeColors`, so any missed site fails compilation

#### Scenario: Three foreground tiers are available

- **WHEN** a component needs primary, secondary, or faint text
- **THEN** it reads `theme().fg`, `theme().fgMuted`, or `theme().fgSubtle` respectively

#### Scenario: On-color replaces background reuse

- **WHEN** text or an icon is drawn on a filled accent or status background (e.g. the error banner)
- **THEN** it reads `theme().onAccent` for its foreground, not `theme().bg`
