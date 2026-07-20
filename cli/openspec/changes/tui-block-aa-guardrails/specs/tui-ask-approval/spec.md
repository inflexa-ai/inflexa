## ADDED Requirements

### Requirement: One marker vocabulary across the ask's two surfaces

A pending ask SHALL present the same marker glyph wherever it is rendered. The docked prompt and the transcript ask card are two views of one ask, so a marker that changes between them misrepresents them as different things.

The vocabulary SHALL be drawn on meaning rather than on surface:

- `GLYPHS.warning` (`⚠`) in the `warning` role SHALL mark a **pending** ask on both surfaces — the docked prompt and the transcript card's `pending` status. A pending ask is not work in progress; it is the system stopped, waiting for the user, which is what a caution marker denotes.
- `GLYPHS.circleHalf` (`◐`) SHALL NOT mark a pending ask. That glyph denotes system-busy elsewhere in the TUI (chat thinking, harness booting, sidebar running); reusing it for an ask that is blocked on the user conflates "the system is working" with "the system needs you".
- The transcript card's terminal statuses SHALL keep their settled outcome markers: `GLYPHS.check` in `success` for `resolved`, `GLYPHS.cross` in `error` for `rejected`, and `GLYPHS.circleHollow` in `fgMuted` for the no-decision outcomes `aborted` and `expired`.

#### Scenario: The same ask shows the same marker on both surfaces

- **WHEN** an ask is pending and is rendered both as the docked prompt and as a transcript card
- **THEN** both render the `⚠` marker in the `warning` role

#### Scenario: A settled ask shows its outcome, not the pending marker

- **WHEN** a transcript ask card moves from `pending` to `resolved`, `rejected`, `aborted`, or `expired`
- **THEN** its marker becomes the matching settled glyph in the matching role, and no longer shows `⚠`

#### Scenario: Busy and blocked are visually distinct

- **WHEN** the chat is thinking (system busy) while an ask is pending (blocked on the user)
- **THEN** the two states render different markers, so the user can tell which one requires action

## MODIFIED Requirements

### Requirement: A pending ask docks the approval prompt above the chat bar

While an ask is pending, the TUI SHALL dock an approval prompt in the chat
column directly above the chat bar — a full-width, non-collapsing row painted
with the panel background — never a modal over the transcript, because the
user needs the transcript visible to decide. The prompt SHALL display the
exact action being approved (title and command, plus detail when present).
When no ask is pending the prompt SHALL NOT be mounted.

The prompt SHALL be laid out as a **gutter-marked block**, aligning with the transcript blocks above it: the marker occupies the shared fixed gutter column (`size.gutter`) and the prompt's content — title, command, optional detail, and the key-hint row — hangs at that indent as a single column beside it. The marker SHALL NOT occupy a row of its own, and SHALL NOT read as decoration attached to the title line; it marks the whole block. The prompt's content SHALL resolve explicit theme foregrounds throughout, including the title.

Two structural properties SHALL be preserved by this layout. The prompt's outer box SHALL remain non-collapsing (`flexShrink: 0`), because it sits directly below the chat's growing scrollbox and would otherwise be squeezed below its own rows. The outer box SHALL remain the prompt's focus target and stay focusable, with the feedback-mode text input mounted as its descendant, because the prompt's bare `y`/`a`/`n` keys are legal only while that focus gate holds.

#### Scenario: The prompt appears docked, not modal

- **GIVEN** a turn whose tool pauses on an ask
- **WHEN** the pending part arrives
- **THEN** the prompt renders above the chat bar with the ask's exact command, and the transcript remains fully visible and scrollable

#### Scenario: The marker occupies the gutter, not its own row

- **WHEN** the docked prompt renders in choice mode
- **THEN** the marker sits in the fixed gutter column on the same row as the title, and the command, detail, and key-hint rows align at the gutter indent beneath the title

#### Scenario: The prompt holds its rows on a short terminal

- **WHEN** the terminal is short enough that the chat scrollbox is squeezed
- **THEN** the docked prompt retains all of its rows and the scroll region absorbs the reduction

#### Scenario: The focus gate survives the layout

- **GIVEN** a docked prompt in choice mode and, separately, in feedback mode
- **WHEN** the user presses `y` in choice mode, and types a character in feedback mode
- **THEN** choice mode answers the ask without the key reaching the composer, and feedback mode routes the character into the feedback input
