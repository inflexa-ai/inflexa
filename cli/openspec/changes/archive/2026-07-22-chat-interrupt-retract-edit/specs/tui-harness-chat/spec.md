## ADDED Requirements

### Requirement: Interrupt is a discoverable, quiet affordance

The chat SHALL offer a dedicated interrupt key: the remappable `app.interrupt` binding (default `esc`),
fired by a **double press while a turn is busy, with the chat as the main focus in NORMAL mode**. The
first press SHALL arm the interrupt for a 5-second window; the second press within the window SHALL
fire the turn's existing abort signal. Esc presses claimed by another owner — a stacked dialog, an
active text selection, or the composer's INSERT→NORMAL switch — SHALL NOT count toward the interrupt.
When idle, or when the window expires unfired, esc SHALL behave exactly as before. The ctrl+c
three-way chord and `/quit`-while-busy SHALL be unchanged.

An interrupted turn SHALL end quietly: whatever streamed stays on screen, the chat returns to idle,
and no error banner, toast, or turn-failure surface appears — interruption is a user action, not a
failure. When the interrupted turn streamed output, its assistant message SHALL carry a muted
"interrupted" marker; when it produced nothing, no empty assistant message SHALL remain and no marker
SHALL render. The marker is live-only — an aborted turn persists no assistant message, so a transcript
reload renders only what the thread holds.

#### Scenario: Double esc interrupts a streaming turn

- **WHEN** a turn is streaming, the chat is the main focus in NORMAL mode, and the user presses esc twice within the window
- **THEN** the turn aborts, the streamed text stays on screen with the muted interrupted marker, the chat returns to idle, and no error surface appears

#### Scenario: The composer's esc switches modes without arming

- **WHEN** a turn is streaming with the composer focused and the user presses esc once
- **THEN** focus moves to the scroll pane exactly as before, and the interrupt is not armed

#### Scenario: The armed window expires

- **WHEN** the user presses esc once in NORMAL mode during a turn and lets the 5-second window lapse before pressing again
- **THEN** no interrupt fires and the next esc press behaves as a fresh first press

#### Scenario: Interrupting a turn that produced nothing leaves no shell

- **WHEN** a turn is interrupted before any text delta or part arrived
- **THEN** no empty assistant message and no marker render; the user message remains in the transcript

#### Scenario: Esc while idle is unchanged

- **WHEN** no turn is in flight and the user presses esc anywhere in the chat
- **THEN** esc behaves exactly as it did before this requirement

### Requirement: The just-sent message can be retracted for editing before any output

The chat SHALL let the user retract the just-sent message for editing while a turn is in flight and
the assistant has produced nothing — no text delta, no tool part, no card part, only the pre-minted
empty assistant placeholder. The retract SHALL: claim the store generation token, abort the turn,
await the turn's settlement, re-validate that nothing was produced, remove the user message and the
assistant placeholder from the live store, remove the persisted user turn from the pg thread via the
harness tail-turn retract, and seed the composer with the original message text (cursor at end). The
durable retract SHALL be skipped when the aborted turn's append faulted (the thread's tail is then an
earlier turn that must not be removed); a database fault from the retract itself SHALL surface as an
error notice while the composer stays seeded, and the failed removal SHALL be retained and retried
once before the next send on that thread — a second failure SHALL let the send proceed rather than
block the conversation. Once the first delta or part has landed, the retract
affordance SHALL be inert. If output lands between the trigger and the abort settling, the action
SHALL downgrade to a plain interrupt (message kept) with a notice. A plain interrupt SHALL NOT
retract — the kept user message remains context for the next turn.

#### Scenario: Retract-and-edit round-trips

- **WHEN** the user sends a message and retracts before any output
- **THEN** the transcript shows nothing from the attempt, the composer holds the original text, and the pg thread holds no orphan turn — resending yields exactly one user message in the thread

#### Scenario: The gate closes on the first delta

- **WHEN** the assistant's first text delta or tool part arrives
- **THEN** the retract affordance is inert and only the interrupt remains available

#### Scenario: A racing delta downgrades the retract

- **WHEN** output lands after the retract is triggered but before the abort settles
- **THEN** the message is kept, a notice explains the downgrade, and nothing is removed from the store or the thread

#### Scenario: An append fault skips the durable retract

- **WHEN** the aborted turn's `appendTurn` faulted and the user retracts
- **THEN** the live store is spliced and the composer seeded, but no thread turn is removed

#### Scenario: A durable retract fault keeps the user's text

- **WHEN** the harness tail-turn retract returns a database fault
- **THEN** an error notice surfaces, the composer still holds the original text, and the removal is remembered as pending for that thread

#### Scenario: The next send heals a failed removal

- **WHEN** a pending removal exists for the thread and the user sends again
- **THEN** the removal is retried before the new turn appends, and a second failure lets the send proceed

## MODIFIED Requirements

### Requirement: One generation token orders every write to the message store

All asynchronous producers that write the conversation store SHALL claim the same monotonic
generation token at entry, and SHALL re-check it after every `await` before writing the message store,
the streaming signals, the error banner, or the chat status. Those producers are a transcript load
(`loadMessages`), a turn (`send`, through its emit adapter and `finishTurn`), and a retract (through
its store splice and composer seed). The newest store-writing operation to have *started* wins; any
older one SHALL drop silently.

A turn therefore supersedes a transcript load already in flight: the load is a replay of durable state
the turn is about to append to, while the turn carries the user's live input. A retract likewise
supersedes an in-flight load (the load would replay the very turn being removed). `resetHotState`
SHALL also claim the token, so a load started for a session the user has swapped away from can never
repopulate the cleared store. A retract superseded mid-sequence by a session swap SHALL drop its
remaining store writes and composer seed, while its durable thread removal — already committed at the
keypress and thread-scoped — still completes.

#### Scenario: A load resolving mid-turn does not wipe the turn

- **WHEN** `loadMessages` is awaiting its page read and the user submits a turn, and the page read then resolves
- **THEN** the load SHALL drop without writing
- **AND** the user message and the in-flight assistant message SHALL remain mounted
- **AND** subsequent streamed parts SHALL continue to append to that assistant message

#### Scenario: A turn submitted the instant boot completes survives

- **WHEN** the runtime reaches `ready`, the transcript load starts, and the user submits a message typed during the boot animation
- **THEN** the turn SHALL render normally and the transcript load SHALL drop

#### Scenario: A load started for a swapped-away session never lands

- **WHEN** `loadMessages` is in flight for session A and `resetHotState` runs for a swap to session B
- **THEN** the session-A load SHALL drop without writing

#### Scenario: A load resolving mid-retract does not resurrect the retracted turn

- **WHEN** `loadMessages` is in flight and a retract claims the token, and the page read then resolves
- **THEN** the load SHALL drop without writing and the spliced store stays spliced

#### Scenario: A swap mid-retract drops the UI writes, not the thread removal

- **WHEN** `resetHotState` supersedes a retract after its abort settled
- **THEN** no store write or composer seed lands, and the old thread's orphan turn is still removed
