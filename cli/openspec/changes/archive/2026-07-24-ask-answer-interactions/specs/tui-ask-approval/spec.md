## ADDED Requirements

### Requirement: The choice options are mouse-activatable

Each choice option rendered by the docked prompt (`y` approve, `a` always, `n` reject) SHALL be an individual mouse target that, when clicked, invokes the same handler as its key — a click on `n` enters feedback mode exactly as the key does, so the two input methods cannot diverge. Activation SHALL occur on mouse-up, and a release that carries a live text selection (the tail of a selection drag ending on an option) SHALL NOT activate — the guard SHALL read the renderer's live selection, not press state remembered from mouse-down. The option texts SHALL be excluded from text selection (they are buttons, not prose). While an answer is in flight (`busy`), clicks SHALL be inert like the keys. When the prompt is rendered as an inert gallery exhibit, clicks SHALL be no-ops — an exhibit click must neither mutate the exhibit's mode nor let a mounted feedback input steal the gallery's focus.

#### Scenario: Clicking an option answers the ask

- **GIVEN** a docked prompt in choice mode for a pending ask
- **WHEN** the user clicks the `y approve` option without any prior focusing click on the card
- **THEN** the ask is answered approve-once, exactly as if `y` had been pressed while the prompt held focus

#### Scenario: Clicking reject enters feedback mode

- **GIVEN** a docked prompt in choice mode
- **WHEN** the user clicks the `n reject` option
- **THEN** the prompt switches to feedback mode with the feedback input focused, identical to pressing `n`

#### Scenario: A selection drag released on an option does not activate it

- **GIVEN** a docked prompt and a text-selection drag in progress
- **WHEN** the drag is released over the `y approve` option while selected text exists
- **THEN** the ask is not answered and the release is treated as the tail of the selection gesture

#### Scenario: Gallery exhibit clicks are inert

- **GIVEN** the design gallery's choice-mode ask exhibits
- **WHEN** an option in an exhibit is clicked
- **THEN** no callback fires, the exhibit does not switch modes, and gallery focus is not stolen

### Requirement: The composer answers the head ask while one is docked

While an ask is docked, the chat composer SHALL act as a second answer path: submitting a buffer that is exactly `y`, `a`, or `n` after trimming, matched case-insensitively, SHALL answer the head ask through the same gateway funnel as the prompt's keys (`y` approve-once, `a` approve-always, `n` reject with no feedback), and SHALL clear the buffer. The token set SHALL mirror the prompt's rendered key hints exactly — no synonyms. Post-answer focus and mode transitions SHALL be left entirely to the existing settle/drain choreography (the composer path adds no focus moves of its own). Submitting any other text while an ask is docked SHALL be refused with the draft preserved, and SHALL surface a transient notice naming the `y`/`a`/`n` answer path. While an answer is already in flight, a repeated submit SHALL be swallowed without a notice. The composer path SHALL NOT carry reject feedback — the prompt's feedback mode remains the only feedback surface.

#### Scenario: Composer y approves, clears, and lands in NORMAL

- **GIVEN** a docked prompt for a pending ask and the user focused in the composer with `y` typed
- **WHEN** the user submits
- **THEN** the ask is answered approve-once, the buffer is cleared, and when the queue drains mid-turn focus lands on the stream pane with the footer showing NORMAL

#### Scenario: Tokens are trimmed and case-insensitive, and n rejects bare

- **GIVEN** a docked prompt for a pending ask
- **WHEN** the user submits `  N  `
- **THEN** the ask is answered reject with no feedback

#### Scenario: Non-answer text is refused with a notice

- **GIVEN** a docked prompt for a pending ask and a composer buffer holding `rerun it with more threads`
- **WHEN** the user submits
- **THEN** no answer is sent, the buffer keeps the draft, and a transient notice names the `y`/`a`/`n` answer path

#### Scenario: No interception without a docked ask

- **GIVEN** no pending ask and an idle, ready runtime
- **WHEN** the user submits `y`
- **THEN** the text is sent to the conversation as a normal message

## MODIFIED Requirements

### Requirement: The prompt captures the decision with focus-gated keys

While the prompt is visible it SHALL hold input focus, which gates the
composer (the textarea is blurred; a submit while an ask is docked either
answers the ask — when the buffer is an answer token — or is refused with a
transient notice, per the composer answer path requirement). Its key layer
SHALL be gated on the prompt's own focus target so its bare keys never steal
characters from a focused editor. Choice mode SHALL offer approve-once (`y`),
approve-always (`a`), and reject (`n`); reject SHALL enter a feedback mode
with a text input where enter submits (an empty entry means no feedback) and
escape returns to choice mode. When the ask queue drains, the refocus target
SHALL be busy-aware: while the turn still runs, focus returns to the stream
pane (NORMAL — the resting state of a running turn, keeping the interrupt
affordance live and its hint honest); when the turn has ended, focus returns
to the composer. The turn-abort chord SHALL remain reachable while the prompt
is focused.

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
