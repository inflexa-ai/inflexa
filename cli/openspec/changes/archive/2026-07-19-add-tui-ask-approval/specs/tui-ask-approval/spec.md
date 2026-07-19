## Purpose

Define the CLI's approval surface for the harness tool-approval primitive: how
a chat turn binds `ctx.ask`, how `data-ask` parts become reconciled transcript
cards, how the docked prompt above the chat bar captures the user's decision
with focus-gated keys, how answers flow back through the gateway, and the
surface's deliberate boundaries (REPL deny-by-default, live-turn-only visuals).

## ADDED Requirements

### Requirement: The TUI chat turn binds the ask seam; the REPL stays deny-by-default

The TUI chat turn SHALL pass the harness turn engine a pre-bound `ask` that
invokes the runtime's ask gateway with the turn's own scope — analysis id,
thread id, the turn's abort signal, and the turn's guarded emit sink — so the
gateway's `data-ask` emissions and its poll ride the same signal and sink as
every other turn event. The REPL chat SHALL NOT bind `ask`: it is a write-only
surface with no mid-turn input path, so an approval-gated tool call there is
denied by the harness's deny-by-default realization.

#### Scenario: A TUI turn carries the bound ask

- **GIVEN** a TUI chat turn for an analysis
- **WHEN** the turn engine assembles the agent-loop options
- **THEN** `ask` is present and bound to the runtime gateway with that turn's analysis id, thread id, abort signal, and emit sink

#### Scenario: A REPL approval-gated call is denied

- **GIVEN** a REPL chat turn whose tool calls `ctx.ask`
- **WHEN** the turn runs
- **THEN** the ask is denied without any prompt and the turn ends with the model-visible denial

### Requirement: data-ask parts render as ask cards reconciled by ask id

The CLI SHALL read `data-ask` parts through a shared defensive reader that
narrows every field and validates the status against
`pending | resolved | rejected | aborted | expired`. In the TUI, a `data-ask`
SHALL become an ask card part in the transcript carrying the ask id, title, the
exact command, optional detail, and status; a re-emission under the same ask id
SHALL update the existing card's status in place (latest-wins) rather than
append a duplicate. In the REPL, a `data-ask` SHALL print a one-line
`approval` mention naming the command and status instead of the generic
unknown-part tag.

#### Scenario: Pending then terminal reconciles to one card

- **GIVEN** a turn in which an ask emits `pending` and later `resolved` under the same ask id
- **WHEN** the TUI applies both events
- **THEN** the transcript holds exactly one ask card for that id, with status `resolved`

#### Scenario: The reader rejects malformed data safely

- **WHEN** a `data-ask` arrives with missing or mistyped fields
- **THEN** the reader coerces them to safe values and an unrecognized status maps to a terminal value rather than `pending`

### Requirement: A pending ask docks the approval prompt above the chat bar

While an ask is pending, the TUI SHALL dock an approval prompt in the chat
column directly above the chat bar — a full-width, non-collapsing row painted
with the panel background — never a modal over the transcript, because the
user needs the transcript visible to decide. The prompt SHALL display the
exact action being approved (title and command, plus detail when present).
When no ask is pending the prompt SHALL NOT be mounted.

#### Scenario: The prompt appears docked, not modal

- **GIVEN** a turn whose tool pauses on an ask
- **WHEN** the pending part arrives
- **THEN** the prompt renders above the chat bar with the ask's exact command, and the transcript remains fully visible and scrollable

### Requirement: The prompt captures the decision with focus-gated keys

While the prompt is visible it SHALL hold input focus, which gates the
composer (the textarea is blurred; submitting is refused while the turn is
busy). Its key layer SHALL be gated on the prompt's own focus target so its
bare keys never steal characters from a focused editor. Choice mode SHALL
offer approve-once (`y`), approve-always (`a`), and reject (`n`); reject SHALL
enter a feedback mode with a text input where enter submits (an empty entry
means no feedback) and escape returns to choice mode. When the ask queue
drains, focus SHALL return to the composer. The turn-abort chord SHALL remain
reachable while the prompt is focused.

#### Scenario: Approve resolves the suspended tool

- **GIVEN** a docked prompt for a pending ask
- **WHEN** the user presses `y`
- **THEN** the ask is answered approve-once, the suspended tool proceeds, and the turn continues

#### Scenario: Reject with feedback stops the turn

- **GIVEN** a docked prompt in feedback mode with typed feedback
- **WHEN** the user presses enter
- **THEN** the ask is answered reject with that feedback, the turn ends with the denial and feedback visible in the transcript, and focus returns to the composer

#### Scenario: Prompt keys never leak into the composer

- **GIVEN** a visible prompt and a composer textarea
- **WHEN** the prompt holds focus and the user presses `y`
- **THEN** the key acts on the prompt and no character is inserted into the textarea

### Requirement: Answers flow through the gateway and every outcome is handled

The prompt's actions SHALL answer through the runtime gateway by ask id with
the three-variant reply (`once | always | reject(feedback?)`). An `applied`
outcome SHALL advance the queue. A `not_found` or `already_terminal` outcome
SHALL surface a transient notice and still advance the queue — the ledger has
already moved past that ask, and holding the prompt open would wedge it.

#### Scenario: A stale answer advances with a notice

- **GIVEN** a docked prompt whose ask was already terminal in the ledger
- **WHEN** the user answers it
- **THEN** a notice reports the stale outcome and the prompt advances to the next pending ask (or unmounts)

### Requirement: Pending asks stack and settle first-in-first-out

Multiple concurrent asks SHALL queue; the prompt SHALL show the head ask and a
count hint when more are queued, and the user SHALL answer them one by one.
Turn teardown (completion, failure, or abort) SHALL clear the pending queue so
a stale prompt can never outlive its turn — a terminal re-emission is not
guaranteed on abort.

#### Scenario: Two concurrent asks answered in order

- **GIVEN** a turn with two tools pausing on asks
- **WHEN** the parts arrive
- **THEN** the prompt shows the first ask with a one-more-queued hint, and answering it advances to the second

#### Scenario: Abort clears the docked prompt

- **GIVEN** a visible prompt for a pending ask
- **WHEN** the user aborts the turn
- **THEN** the prompt unmounts and the composer regains focus

### Requirement: Asks are live-turn-only visuals

Ask cards and the docked prompt SHALL exist only within the live turn that
produced them: the CLI SHALL NOT reconstruct `data-ask` parts on transcript
reload. The harness ask ledger remains the durable record of every ask and its
outcome.

#### Scenario: Reload does not resurrect asks

- **GIVEN** a session whose earlier turn contained an answered ask
- **WHEN** the chat is reopened and the thread reloads
- **THEN** no ask card renders for it and no prompt appears

### Requirement: The approval surface is exhibited in the design gallery

The design gallery SHALL exhibit the ask surface from pure mock fixtures: the
docked prompt in choice mode, feedback mode, and stacked-queue state, and the
transcript ask card in pending and terminal statuses.

#### Scenario: Gallery shows the prompt states

- **WHEN** the design gallery is opened
- **THEN** exhibits render the choice-mode prompt, the feedback-mode prompt, a queued-count variant, and ask cards across statuses, all from mock data
