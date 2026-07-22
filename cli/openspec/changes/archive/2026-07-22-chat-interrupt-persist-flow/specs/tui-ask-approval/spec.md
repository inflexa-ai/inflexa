## MODIFIED Requirements

### Requirement: The prompt captures the decision with focus-gated keys

While the prompt is visible it SHALL hold input focus, which gates the
composer (the textarea is blurred; submitting is refused while the turn is
busy). Its key layer SHALL be gated on the prompt's own focus target so its
bare keys never steal characters from a focused editor. Choice mode SHALL
offer approve-once (`y`), approve-always (`a`), and reject (`n`); reject SHALL
enter a feedback mode with a text input where enter submits (an empty entry
means no feedback) and escape returns to choice mode. When the ask queue
drains, the refocus target SHALL be busy-aware: while the turn still runs,
focus returns to the stream pane (NORMAL — the resting state of a running
turn, keeping the interrupt affordance live and its hint honest); when the
turn has ended, focus returns to the composer. The turn-abort chord SHALL
remain reachable while the prompt is focused.

#### Scenario: Approve resolves the suspended tool

- **GIVEN** a docked prompt for a pending ask
- **WHEN** the user presses `y`
- **THEN** the ask is answered approve-once, the suspended tool proceeds, and the turn continues

#### Scenario: Draining mid-turn returns focus to the pane

- **GIVEN** a docked prompt whose approval lets the turn continue
- **WHEN** the queue drains while the turn is still busy
- **THEN** focus lands on the stream pane, the footer shows `NORMAL`, and two esc presses interrupt the continuing turn

#### Scenario: Reject with feedback stops the turn

- **GIVEN** a docked prompt in feedback mode with typed feedback
- **WHEN** the user presses enter
- **THEN** the ask is answered reject with that feedback, the turn ends with the denial and feedback visible in the transcript, and focus returns to the composer

#### Scenario: Prompt keys never leak into the composer

- **GIVEN** a visible prompt and a composer textarea
- **WHEN** the prompt holds focus and the user presses `y`
- **THEN** the key acts on the prompt and no character is inserted into the textarea
