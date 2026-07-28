## ADDED Requirements

### Requirement: A harness synthetic message renders as an event, not as a user turn

The transcript SHALL recognise a harness synthetic message and render it as an event entry —
visually distinct from both the user's own messages and the assistant's replies — rather than as a
turn by either party.

Recognition SHALL use the harness's exported predicate over the stored message, never a heuristic
over its text. A synthetic message carries the `user` role for the wire format, so a mapper that
reads only the role would attribute a system-authored run outcome to the user, which is a lie
about who said it and would also mislead the reader about what they can retract.

An event entry SHALL NOT carry the user or assistant turn markers, SHALL NOT be counted as a turn
in the transcript's turn-scoped affordances, and SHALL NOT be offered as retractable or editable
content.

#### Scenario: A run outcome does not appear to be the user speaking

- **WHEN** the transcript loads a thread containing a synthetic run-outcome message
- **THEN** it renders as an event entry with neither the user nor the assistant marker

#### Scenario: Recognition is structural

- **WHEN** a synthetic message's text resembles ordinary user prose
- **THEN** it is still recognised as synthetic, because recognition reads the harness marker rather than the content

#### Scenario: Event entries are not retractable turns

- **WHEN** the user reaches for the retract affordance after a synthetic entry
- **THEN** the affordance targets the user's own most recent message, and the synthetic entry is not presented as editable

#### Scenario: A genuine user message is unaffected

- **WHEN** the transcript loads an ordinary user message
- **THEN** it renders with the user marker exactly as before
