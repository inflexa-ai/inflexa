# tui-harness-chat Specification

## Purpose
The TUI's harness chat lifecycle — the product conversation surface (plain `inflexa`), a client of the local server that drives the harness conversation agent at managed parity. Covers the gate on open that waits for the runtime of the server (state machine, animation, failure surface, quit semantics), the frame contract of the chat stream (harness `contracts/` vocabulary, sub-agent depth filter), the session↔thread binding, turn abort semantics (the double-press interrupt affordance and the pre-output retract-and-edit), turn-failure observability (readable banner, logged structured cause, details view), and the data-profile lifecycle at managed parity (the server keeps the profile at parity with the input set, clear-on-empty, and the manual re-profile surfaces). Lives across `src/tui/hooks/{boot,conversation,profile_parity}.ts`, `src/tui/app.launch.tsx`, `src/tui/app.tsx`, and, in the server, the shared engines `src/modules/harness/{turn,profile_trigger}.ts`.

## Requirements

### Requirement: Opening an analysis chat waits for the runtime of the local server behind a gate

Opening an analysis chat in the TUI SHALL NOT boot a harness runtime in the TUI process. The local
server owns the runtime and its prerequisites (the model connection gate, the container and proxy
gate, and the harness config gate), and it boots them at its own start, with no interactive prompt.
Before the alternate screen, the launcher SHALL resolve its target through the server. The read of
the analysis takes its instance lock in the server, thus an analysis that a different process holds
SHALL stop the launch with a plain line before the screen is taken.

After `render()`, the TUI SHALL read the boot phase of the server (`GET /api/v1/server`) every
500 ms into a boot-state store (`booting → ready | failed`) until the phase is `ready` or `failed`.
While not `ready`, the chat input SHALL be gated (submits refused, the gate visible in the input
affordance and status bar) and a boot animation SHALL render (spinner + elapsed, design-gallery
entered); session-scoped surfaces (the sidebar session line, the session-switch command) SHALL show
a placeholder / stay disabled, since the server reads thread metadata from Postgres, which has no
pre-`ready` source. When the store reaches `ready`, the TUI SHALL resolve the conversation thread for
the open analysis: the most-recent live thread that the server lists for the analysis with the
`conversation` type, else a freshly minted thread id (`randomUUIDv7()`) whose row is created by the
first turn. The narrowing to the `conversation` type keeps a report child out of the launch: the
listing orders by last activity, so a fresh report child would otherwise be the thread the next
launch opens.

A failed boot, and a server that does not answer, SHALL render one actionable message as a terminal
state — never a hang or a dead screen: the boot error that the server gives, or the instruction of
the client error. Ctrl+C at any boot stage SHALL quit the TUI through the graceful shutdown path with
the terminal restored. The quit stops nothing in the server: the server keeps its runtime for its
other clients. No passive flow boots a runtime in its own process; the local server, which an
instance command starts in the background when none answers, boots the runtime at its own start.

#### Scenario: Input is gated until the runtime is ready

- **WHEN** the TUI opens an analysis chat and the server reports the `starting` phase
- **THEN** submitting a message does nothing, the UI shows the boot state, and the first submit after `ready` starts a turn

#### Scenario: Thread resolves at the ready edge

- **WHEN** the boot store reaches `ready` for an analysis with prior live threads
- **THEN** the most-recently-active thread is resolved into the workspace scope and its transcript loads

#### Scenario: The launch never opens a report child

- **WHEN** the boot store reaches `ready` and the most-recently-active thread of the analysis is a report child
- **THEN** the launch resolves the most-recent conversation instead, and the report child opens through the report surfaces alone

#### Scenario: No threads yet means an empty chat, no row

- **WHEN** the boot store reaches `ready` for an analysis with no live threads
- **THEN** a fresh thread id is minted, the chat renders empty, and no thread row exists until the first message's turn creates it

#### Scenario: Boot failure is actionable, not fatal to the terminal

- **WHEN** the server reports a failed boot (e.g. Postgres down, model unresolved, runtime already active elsewhere), or no server answers
- **THEN** the TUI shows that actionable message and the user can quit cleanly with the terminal restored

#### Scenario: Quit during boot restores the terminal

- **WHEN** the user quits while the server is still booting
- **THEN** the TUI exits through the graceful shutdown path with the terminal restored, and the server continues its boot

#### Scenario: A locked analysis stops the launch before the screen

- **WHEN** the launcher opens an analysis that a different live process holds
- **THEN** the launch prints the conflict and exits before the alternate screen is taken

### Requirement: The TUI chat drives the shared turn engine over harness contracts

A submitted message MUST start one turn on the local server: `POST {A}/chat` with the thread id and the text. The abort chord keeps its order: dialog-dismiss, then abort-turn, then quit.

The response streams the frames of the turn, and its `Inflexa-Turn-Id` header names the turn. The abort of the turn MUST go to the server as `POST {T}/turns/:turnId/abort`. An abort that comes before the server names the turn MUST go out when the id arrives. A closed stream does not stop the turn on the server, thus the TUI MUST read the stream to its end.

After the last frame, the TUI MUST read the summary of the turn (`GET {T}/turns/:turnId`), and the summary decides the outcome. When the summary cannot be read, the terminal frame decides it: `finish` gives `done`, or `aborted` after an abort of this client, and `error` gives `failed`. A stream that breaks with no terminal frame and no summary MUST end the turn as a failure that names the break.

The server runs the turn through the shared turn engine, which calls the chat turn of the harness with these values:

- the thread-agent resolver of the runtime handle, never a pre-selected agent
- the streaming provider wrapper
- the frame sink of the response and the signal of the turn
- the usage recorder of the runtime and the approval binding of the turn
- the author and the start time of the turn

The engine passes no cache policy and no conversation budget. Thus the root conversation loop uses the 1-hour default and the budget of 150,000 tokens of the harness. The harness stores the opening of the turn, each round when it completes, and the outcome. Neither the server nor the TUI appends a row itself.

A type that the harness refuses (`unregistered_thread_type`) MUST end the turn before it opens, and the harness stores nothing. The server refuses the request with a message that names the thread type. The TUI MUST render it through the failed-turn notice path.

A turn that the user interrupts keeps its stored rounds, and the harness closes it as `aborted`. A turn whose run throws also keeps its stored rounds. The harness then adds the failure note, and it closes the turn as `failed`.

The frame reducer of the TUI MUST consume the harness `contracts/` vocabulary directly, never the event shapes of the cli bus:

- The server translates each event with `toChatFrame` of the harness. The TUI applies each frame of the top-level agent with `applyChatFrame` of the harness. Thus the assistant message of the turn holds the harness parts that a reload of the turn gives.
- A text delta changes only the streaming signal. The text part in the store takes the text when a later part arrives, or when the turn completes.
- `tool-started` and `tool-finished` become one tool-call part. The part carries the call detail of the harness and the outcome of the call: `ok`, `error`, or `denied`. The reducer MUST treat the detail as opaque display text, and it MUST NOT parse it.
- `data-compaction` becomes one compaction part of the turn. A later emission with the same id replaces that part in place.
- Each other data part stays in the message as the harness gives it. The renderer shows a part with no renderer as a tagged mention, thus the reducer hides no part.
- The server also sends the frames of a sub-agent. A sub-agent frame, whose call path is deeper than the top-level agent, becomes the activity line of the running tool call. It never becomes a part.

Each frame that the reducer applies is a fresh object that the client parsed from the stream, thus the Solid store shares no reference with the agent loop. The agent session MUST carry the thread id in its scope, thus a run that the chat starts stamps `cortex_runs.thread_id`. The harness stamps the provenance of the agent that the thread resolves to, with a `callPath` of length 1.

The summary of the turn MUST also carry the usage rollup of the turn when the run reported one. The rollup is the record of the harness for each quantity, carried whole and not reduced to one number. It covers the root loop of the turn and each sub-agent loop. The rollup MUST be absent, never zero, when no call reported usage.

A turn that returns, the ordinary interrupt included, MUST carry what it spent before it ended. A turn whose run throws produced no finish, thus its outcome MUST carry no rollup. The ledger still holds those tokens, because the loop gives each call to the usage recorder when the call completes.

#### Scenario: A plan is drafted, approved conversationally, and executed from the TUI

- **WHEN** the user asks for a plan, the agent shows it, and the next message of the user approves it
- **THEN** the transcript shows the plan card, and then the run card of a real run whose `thread_id` is the thread id of the chat

#### Scenario: Abort ends the turn, not the app

- **WHEN** the user pushes the abort chord during a streaming turn
- **THEN** the TUI sends the abort of the turn to the server, and the thread keeps the opening, each completed round, and the streamed partial
- **AND** the UI goes idle, and the app stays open

#### Scenario: The summary decides the outcome

- **WHEN** the stream of a turn ends
- **THEN** the TUI reads the summary of the turn, and it settles the turn on the status that the summary gives

#### Scenario: A failed turn keeps its rounds

- **GIVEN** a turn whose provider fails with HTTP 401 after two rounds
- **WHEN** the turn ends and the transcript loads again
- **THEN** the transcript shows the two rounds and the failure note, and the TUI showed the failure banner

#### Scenario: Sub-agent traffic stays out of the transcript

- **WHEN** an inner agent, for example the planner or the literature reviewer, emits deltas or tool events during a turn
- **THEN** none of them renders as a part of the turn, and only the activity line of the running tool call shows them

#### Scenario: A described call carries its detail onto the live part

- **WHEN** the loop emits `tool-started` for a tool that declares a call description
- **THEN** the live tool-call part carries that detail as a copied string, and the chip renders it

#### Scenario: A refused approval reaches the store as denied

- **WHEN** the loop emits `tool-finished` with the `denied` outcome
- **THEN** the outcome of the live tool-call part is `denied`, not `error`

#### Scenario: The turn's rollup includes what its sub-agents spent

- **WHEN** a turn sends a sub-agent loop that makes its own LLM calls
- **THEN** the rollup of the outcome covers the calls of both loops, and it is more than the top-level loop alone reported

#### Scenario: An interrupted turn still reports what it spent

- **WHEN** the user aborts a turn after some completed calls
- **THEN** the outcome carries the rollup of those calls, not an absent rollup

#### Scenario: A turn that reported no usage carries no rollup

- **GIVEN** a provider that reports no usage
- **WHEN** the turn completes
- **THEN** the rollup of the outcome is absent, not zero

#### Scenario: A compaction shows its progress in the turn

- **GIVEN** a turn whose root loop compacts before its second request
- **WHEN** the harness emits the `data-compaction` part with `running`, and then with `done` under the same id
- **THEN** the turn shows one compaction part, first as `Summarizing earlier conversation…` and then as the divider
- **AND** the turn shows no tagged mention of the part

#### Scenario: An unregistered thread type surfaces as a rendered refusal

- **WHEN** a turn runs on a thread whose type has no registered agent in this build
- **THEN** the server refuses the turn before it opens, the thread gets no row, and the TUI renders the failed-turn notice with the thread type

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
SHALL render. The marker SHALL be durable: the persisted partial carries the harness interruption
marker, a transcript reload derives the same muted marker from the converted message's `interrupted`
field, and the reloaded transcript SHALL render what the live view showed — partial text with the
marker, or no assistant bubble for a no-output abort (which persists no assistant row).

#### Scenario: Double esc interrupts a streaming turn

- **WHEN** a turn is streaming, the chat is the main focus in NORMAL mode, and the user presses esc twice within the window
- **THEN** the turn aborts, the streamed text stays on screen with the muted interrupted marker, the chat returns to idle, and no error surface appears

#### Scenario: The interrupted reply survives a restart

- **WHEN** a turn is interrupted mid-stream and the app is later restarted (or the session reloaded)
- **THEN** the transcript shows the partial reply with the muted interrupted marker, and the next turn's model context contains the partial — a follow-up like "continue" can pick up where the cut landed

#### Scenario: The composer's esc switches modes without arming

- **WHEN** a turn is streaming with the composer focused and the user presses esc once
- **THEN** focus moves to the scroll pane exactly as before, and the interrupt is not armed

#### Scenario: The armed window expires

- **WHEN** the user presses esc once in NORMAL mode during a turn and lets the 5-second window lapse before pressing again
- **THEN** no interrupt fires and the next esc press behaves as a fresh first press

#### Scenario: Interrupting a turn that produced nothing leaves no shell

- **WHEN** a turn is interrupted before any text delta or part arrived
- **THEN** no empty assistant message and no marker render; the user message remains in the transcript — live and after reload alike

#### Scenario: Esc while idle is unchanged

- **WHEN** no turn is in flight and the user presses esc anywhere in the chat
- **THEN** esc behaves exactly as it did before this requirement

### Requirement: The just-sent message can be retracted for editing before any output

The chat SHALL let the user retract the just-sent message for editing while a turn is in flight and
the assistant has produced nothing — no text delta, no tool part, no card part, only the pre-minted
empty assistant placeholder. The retract SHALL: claim the store generation token, abort the turn,
await the turn's settlement (the server closes the turn before its stream ends), re-validate that
nothing was produced, remove the persisted user turn from the pg thread through the server
(`POST {T}/retract`, the harness tail-turn retract), and only then remove the user message and the
assistant placeholder from the live store and seed the composer with the original message text
(cursor at end). The visible half SHALL land as one step after the durable half, never split across
it — a transcript that has dropped the message while the composer is still empty is a half-applied
state the user cannot interpret. Seeding SHALL be declined when the composer is no longer empty, so
text typed during the retract is never overwritten by the restoration.

The durable retract SHALL be skipped when the aborted turn landed nothing: its summary says that the
opening did not land, or the server refused the turn. When the client cannot know — the summary could
not be read, or the stream broke — the durable retract SHALL use the guarded form, which removes the
tail turn only while it has no assistant row. A failed retract request SHALL surface as an error
notice while the composer is still seeded, and the failed removal SHALL be retained and retried once
before the next send on that thread — a second failure SHALL let the send proceed rather than block
the conversation. The retry SHALL use the guarded form: the fault that scheduled the retry cannot
distinguish a retract that rolled back from one whose commit landed but lost its acknowledgement, and
a blind retry in the second case would delete a real, answered turn. Once the first delta or part has
landed, the retract affordance SHALL be inert. If output lands between the trigger and the abort
settling, the action SHALL downgrade to a plain interrupt (message kept) with a notice. A plain
interrupt SHALL NOT retract — the kept user message remains context for the next turn.

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

- **WHEN** the summary of the aborted turn says that its opening did not land (its append faulted), and the user retracts
- **THEN** the live store is spliced and the composer seeded, but no thread turn is removed

#### Scenario: An unknown landing uses the guarded retract

- **WHEN** the summary of the aborted turn cannot be read, and the user retracts
- **THEN** the retract asks the server to remove the tail turn only while it has no assistant row

#### Scenario: A durable retract fault keeps the user's text

- **WHEN** the retract request to the server fails
- **THEN** an error notice surfaces, the composer still holds the original text, and the removal is remembered as pending for that thread

#### Scenario: The next send heals a failed removal

- **WHEN** a pending removal exists for the thread and the user sends again
- **THEN** the removal is retried before the new turn appends, and a second failure lets the send proceed

#### Scenario: The heal declines when the orphan is already gone

- **WHEN** a pending removal exists but the thread's tail is an answered turn (the faulted retract had in fact committed)
- **THEN** nothing is removed and the send proceeds

#### Scenario: Typing during a retract survives it

- **WHEN** the user types into the composer while the retract's durable removal is in flight
- **THEN** their text stays and the original message is not restored over it

### Requirement: Turn failures are observable

A failed turn SHALL never be a dead end. The server SHALL derive the failure of a turn from its
structured cause, and give it in the summary of the turn: one message — an `Error` renders its name
and message (with one level of `.cause`), a discriminated `{type, …}` error renders its discriminant
and message — never a default object coercion (`[object Object]`), and the detail lines of the full
cause (stack, nested causes, or the pretty-printed structured object, bounded in length). The FULL
structured cause SHALL be logged at error level from the shared turn engine, in the log of the
server — the one place the whole value survives — and an append fault SHALL be logged at warn. The
TUI SHALL raise the message in the failure banner, retain the detail lines of the last turn failure,
and offer a leader-keybound details view (documented in which-key, hinted in the banner with a label
derived from the live binding) that renders those lines through the standard results dialog. The
retained failure SHALL clear when a new turn starts. A refusal before the turn opens (for example, a
thread that is gone) and a broken stream carry no detail lines, thus the TUI SHALL retain one line
that states the reason, so the details view explains it rather than showing empty.

#### Scenario: A structured cause renders readably everywhere

- **WHEN** a turn fails with a discriminated error object (e.g. a harness `ProviderError`)
- **THEN** the banner shows the discriminant and message (never `[object Object]`), and the log of the server carries the complete structured cause

#### Scenario: The details view shows the whole failure

- **WHEN** the user presses the error-details leader key after a failed turn
- **THEN** a dialog renders the detail lines of the full cause (stack and nested causes for an `Error`, pretty-printed JSON for a structured object)

#### Scenario: A new turn clears the retained failure

- **WHEN** the user sends a new message after a failure
- **THEN** the banner and the retained failure reset, and the details view reports no recent turn error

#### Scenario: A refusal still explains itself

- **WHEN** the server refuses a turn because its thread is gone, and the user opens the details view
- **THEN** the dialog shows the line that states the reason, not an empty view

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

### Requirement: A delta-less final segment renders after a mid-turn part

The chat SHALL render the engine's `fallbackText` as a message part whenever a turn's streamed text
buffer is empty at completion and that fallback is non-empty. This SHALL hold even when a non-text
part (a tool chip, a plan card, a run card) arrived mid-turn and sealed the prior streaming segment:
the chat SHALL open a fresh streaming segment for the fallback so it lands **after** the part that
interrupted the prose, matching the order a transcript reload produces.

An empty streamed buffer at turn end means no delta arrived since the last seal, and therefore that the
final assistant message's text never streamed — so the fallback is never a duplicate of text already on
screen.

#### Scenario: Prose, then a tool, then a delta-less answer

- **WHEN** a turn streams prose, runs a tool, emits no further text deltas, and the engine returns a non-empty `fallbackText`
- **THEN** the assistant message SHALL render the prose, then the tool chip, then the fallback text as a trailing part

#### Scenario: A streamed answer is not duplicated

- **WHEN** a turn's final assistant text arrived as deltas and is still in the streamed buffer at completion
- **THEN** the fallback text SHALL NOT be rendered a second time

#### Scenario: A turn ending on a card leaves no empty part

- **WHEN** a turn's last event is a plan card and the engine's `fallbackText` is empty
- **THEN** no trailing empty text part SHALL be appended

### Requirement: The user can re-trigger profiling manually

The TUI SHALL offer a deliberate re-profile action — a command-palette entry and a keybound action
inside the DATA PROFILE details dialog (per `sidebar-live`) — that forces the stage → seed → trigger
sequence regardless of drift: a completed row restarts through the trigger's CAS; a `failed` row is
retry-claimed and started (the retry-claim + run path the profile command proves); a `running`
profile SHALL refuse with a notice and start nothing. Outcomes surface as notices and poke the
sidebar's live store. When a re-profile cannot start, each surface degrades in its own idiom: the
palette entry refuses with an explanatory notice (before the runtime is `ready`, or on an analysis
with no resolvable inputs), while the dialog action is simply not offered — no footer hint, no
binding (per `sidebar-live`).

#### Scenario: Re-profile restarts a completed profile

- **WHEN** the user invokes "Re-profile data" on an analysis whose profile completed — drifted or not
- **THEN** the profile workflow restarts, a notice reports it, and the sidebar shows it running

#### Scenario: Re-profile recovers a failed profile

- **WHEN** the user invokes the re-profile action on an analysis whose profile status is `failed`
- **THEN** the failed row is retry-claimed, the workflow starts, and the failure state clears from the sidebar

#### Scenario: Re-profile while running refuses

- **WHEN** the user invokes the re-profile action while a profile is running
- **THEN** a notice says a run is already in progress and no duplicate workflow starts

### Requirement: A finished turn displays what it cost

The TUI SHALL render what the turn consumed on the completed assistant message, alongside the
duration it already stamps there, as an input figure and an output figure — never as one combined
number, since the rollup's remaining quantities are breakdowns of those two. The display SHALL
distinguish "nothing was reported" from "zero was spent" by rendering nothing at all in the former
case, and SHALL NOT block, delay, or alter the message's other content when the rollup is absent.

#### Scenario: A completed turn shows its tokens beside its duration

- **WHEN** a turn completes and its provider reported usage
- **THEN** the assistant message's meta line carries the turn's input and output figures next to its elapsed time

#### Scenario: A turn with no reported usage shows no token figure

- **WHEN** a turn completes and no call reported usage
- **THEN** the meta line shows the duration alone, with no zero and no placeholder

#### Scenario: The meta line never shows a summed token count

- **WHEN** a turn's rollup carries cache-read or reasoning counts alongside its input and output counts
- **THEN** the meta line still shows two figures, neither of which has the cache or reasoning counts added into it

### Requirement: A tool chip's duration comes from the harness when the event reports one

The emit adapter SHALL take a tool call's duration from `tool-finished` when that event carries one, and SHALL fall back to its own observation — the elapsed time between receiving that call's started and finished events — when it does not.

The local observation SHALL be retained for the fallback and for pairing an unmatched finished event to its part. Its role narrows; it is not removed.

The reported figure SHALL be the harness figure whenever the event carries one, and zero is such a figure. A sub-millisecond call reports a real `0`. Thus the fallback SHALL be a null-coalescing test and not a truthiness test.

A chip whose call never reported a duration SHALL display none. It SHALL NOT substitute an elapsed time that the adapter observed across a whole round. This governs the interrupted turn: a call still open when the turn ends receives no `tool-finished`, so nothing measured it. The adapter receives every start of a round together, so the time since a start stamp is the round's. A multi-call round would then strand some chips, each with one identical figure. That is the false claim this requirement removes.

The duration is live-only. The persisted conversation display records a call's outcome and detail and carries no duration field, so a replayed turn SHALL render its chips without one. A reader therefore cannot distinguish an unmeasured call from an unpersisted one, which is accepted: the duration is a diagnostic of the live turn, and reconstructing history is out of scope.

The adapter's own bracket cannot measure a call. The harness emits every `tool-started` for a dispatch round before it dispatches anything and every `tool-finished` after the round settles, so the interval between the two events is the round's, and every call in a multi-call round is observed with the same figure. That is invisible while chips are indistinguishable and becomes a false claim once each carries its own detail — three visibly different calls each asserting one duration. Only the harness can measure an individual call, so the reported figure SHALL be its measurement wherever it is available.

#### Scenario: Concurrent calls in one round report their own durations

- **GIVEN** a dispatch round of several tool calls whose finished events carry differing `durationMs` values
- **WHEN** the chips settle
- **THEN** each chip reports its own event's figure, and a fast call does not display a slow sibling's

#### Scenario: An event without a duration falls back to local observation

- **GIVEN** a `tool-finished` event carrying no `durationMs`
- **WHEN** the chip settles
- **THEN** it reports the elapsed time the adapter observed, rather than no duration

#### Scenario: An unpaired finished event still renders

- **GIVEN** a `tool-finished` event for which no started event was received
- **WHEN** the adapter handles it
- **THEN** a finished part is appended, carrying the event's duration when it has one and none otherwise

### Requirement: A chat turn append names the person who sent it

The shared turn engine MUST stamp the author of the turn on the append. The author is the
email of the signed-in identity of the cli. One identity rule answers "who is the user" for
the cli, thus a transcript and a provenance document name the same person.

The engine MUST read the identity when the turn OPENS, before the agent loop. The author is
who sent the message, thus the value comes from the moment of the message. A sign-out during
a turn MUST NOT erase the author of that turn. A sign-in or a sign-out between two turns
changes the author of the next turn, thus no stale value survives.

Each failure of the identity read MUST give no author. The read fails in each of these
conditions:

- The cli holds no stored session.
- The cli cannot read the stored session, or the schema refuses it.
- The token does not decode, or it holds no email.

An absent author MUST be absent, never an empty string and never a placeholder. Thus it
never reads as a real sender. The absence rides the normal path: it ends no turn and it
reports no error.

The append MUST carry the author that the read gave, and it MUST NOT carry a different one.
A turn that the user interrupts stamps the author. A turn that fails
inside the agent loop stamps the author. A turn that the
engine refuses before the agent loop appends nothing, thus it stores no author. Both chat
surfaces drive the one engine. Thus the TUI chat and the dev REPL stamp the author under one
rule, and neither supplies its own.

The identity of the agent session MUST NOT change. It stays the fixed local value that the
ask grants and the harness scope key on. The author of the turn and the identity of the
session are two different facts.

#### Scenario: A signed-in user stamps the turn

- **WHEN** a signed-in user sends a message and the turn completes
- **THEN** the append carries the email of that user as the author of the turn

#### Scenario: A signed-out user stamps nothing

- **WHEN** a user with no stored session sends a message
- **THEN** the append carries no author, and the turn completes the same as a signed-in turn

#### Scenario: A session that gives no email stamps nothing

- **WHEN** the stored session gives no email, because it does not read, does not parse, does not decode, or holds no email claim
- **THEN** the append carries no author, and no error reaches the surface

#### Scenario: An interrupted turn keeps its author

- **WHEN** a signed-in user interrupts a turn after the reply started
- **THEN** the append of the partial turn carries the same author as a completed turn

#### Scenario: A failed turn keeps its author

- **WHEN** the agent loop of a signed-in user throws
- **THEN** the append of the user message alone carries that author

#### Scenario: The next turn reads the identity again

- **WHEN** the signed-in identity changes between two turns of one engine
- **THEN** each turn stamps the identity of its own moment, and no turn stamps a held value

#### Scenario: One engine stamps both surfaces

- **WHEN** the TUI chat and the dev REPL each run a turn for the same signed-in user
- **THEN** both appends carry that one author, and neither surface passes an author of its own

### Requirement: A reloaded thread shows each call's detail and outcome

A reloaded tool call MUST show the detail that its live chip showed. This includes a tool that the embedder gives as a host tool. A reloaded call MUST also show its own outcome: a call that failed live renders as failed, and a refused call renders as denied. A reload that shows each call as a success tells the user that a failed call succeeded.

The harness records what a turn displayed when the turn displays it. The local server replays that record with `storedMessagesToChat`, and the store mounts the replayed parts with no change. The reload MUST NOT compute the detail or the outcome again at read time. It MUST NOT read them from the current schema of a tool or from the state of the workspace. Thus the transcript of a past turn does not change with the code of today.

The TUI MUST NOT ask for a transcript before the boot store reaches `ready`, because the server reads the thread from Postgres through its runtime.

#### Scenario: A reloaded call shows the detail its live chip showed

- **GIVEN** a stored turn whose tool declared a call description
- **WHEN** the thread reloads
- **THEN** the tool-call part carries the same detail that the live turn rendered

#### Scenario: A host tool keeps its detail across reload

- **GIVEN** a stored call to a tool that the embedder gives as a host tool
- **WHEN** the thread reloads
- **THEN** its detail is present, not dropped

#### Scenario: A reloaded failed call renders as failed

- **GIVEN** a stored turn that holds a tool call with an error result
- **WHEN** the thread reloads
- **THEN** the tool block shows the error status, not `ok`

#### Scenario: A reloaded refused call renders as denied

- **GIVEN** a stored turn that holds a tool call whose approval was rejected
- **WHEN** the thread reloads
- **THEN** the tool block shows the denied status, not the error status

#### Scenario: Reload before boot completes does not fail

- **GIVEN** a chat whose boot store is not `ready`
- **WHEN** the chat binds a session
- **THEN** the TUI sends no transcript read and mounts nothing, and the load runs at the ready edge

### Requirement: The thread binds one-to-one to the session through the local server

The pg conversation thread SHALL be the session identity — one id, one store. The TUI SHALL carry
the thread id in the workspace scope (minted at open when no existing thread is picked; the first
turn creates the row in the server), so thread resolution, the session picker, and in-place swaps
need no additional selection UI and no second identity store. The transcript's source of truth SHALL
be the pg thread, which the TUI reads through the local server (`GET {T}/messages`: the harness
replay of the stored messages). Thread titles SHALL be pg-owned: seeded from the first user message
and renamed through the server (`PATCH {T}`). Swapping sessions SHALL rebind the thread scope and
reload the transcript; swapping to a different analysis SHALL additionally abort any in-flight turn,
read the target analysis from the server before the swap (`GET {A}`), and re-run the profile parity
check. That read takes the instance lock of the target analysis in the server: a lock that a
different process holds SHALL refuse the swap with a notice. The server keeps the lock of each
analysis that it opened until it exits, thus a swap releases no lock, and two clients of one server
can show one analysis.

#### Scenario: Resuming a session resumes its thread

- **WHEN** the user reopens an analysis whose thread has prior harness turns
- **THEN** the transcript renders those turns from the pg thread and the next message appends to the same thread

#### Scenario: Rename writes the pg title

- **WHEN** the user renames the open session
- **THEN** the server persists the pg title and every session surface (sidebar, picker) reflects it

#### Scenario: Analysis swap refused when held elsewhere

- **WHEN** the user switches to an analysis already open in another inflexa process
- **THEN** the swap is refused with a notice naming the conflict and the current chat stays bound

#### Scenario: Two clients of one server open one analysis

- **WHEN** a second TUI that uses the same server opens the analysis that the first TUI shows
- **THEN** the open succeeds, because the server already holds the lock of that analysis

### Requirement: The local server keeps the data profile at parity, and the TUI asks at its edges

The TUI SHALL keep the data profile at managed parity with the analysis's **current input set**
through the local server, which runs each drive. The TUI SHALL ask the server for the chat context
(`GET {A}/chat-context`), which runs the open drive of `data-profile-launch`, at two edges:

- when the boot store reaches `ready` with an analysis open, and again when the open analysis changes
  in place — de-duplicated by analysis id, so a repaint or a settled boot phase does not ask again;
- once when a profile that the sidebar observed `running` reaches a terminal state for the same
  analysis — `completed` **or** `failed`, so that work deferred by the running skip is released on
  either outcome.

Each of these drives SHALL wait behind the sandbox gate of the TUI first, unless the analysis has no
inputs.

The server SHALL re-profile after an input change itself, from each writer in its process — an input
route of a client and the `manage_inputs` tool inside a turn. Each change arms a 500 ms trailing
debounce for its analysis, so a batch edit gives one input-change drive. No TUI edge watches the
inputs, and the re-profile runs when no TUI is open.

The server SHALL **serialize** every drive of one analysis — the open drive, the input-change drive,
and the deliberate re-profile — through one queue for each analysis: at most one may run its
materialize → seed → trigger sequence at a time, and one arriving while another runs SHALL queue
behind it rather than be dropped, because the edges fire precisely because state changed.
Serialization is required for two reasons the ledger CAS cannot supply, since it runs only after
staging: concurrent `stageInputs` calls on one workspace tree race the tree-reconciliation delete,
and a concurrent clear can null `seed_input_file_ids` between another drive's seed write and its
trigger. What a drive decides — the materialization, the profile decision, the clear of an emptied
set, and the running skip — is the contract of `data-profile-launch`.

The TUI SHALL map the outcome of a drive that it asked for onto notices: a trigger raises a profiling
or re-profiling notice, a clear raises an informational notice that the analysis has no inputs, a
failure raises a could-not-start notice with its reason, and every other outcome is silent. A
trigger and a clear SHALL poke the sidebar's live store, because they change the ledger outside its
own refresh triggers.

Chat SHALL NOT be gated on profile state. The server answers as soon as the trigger is dispatched,
never at the end of the profile. A drive whose analysis was swapped away while its request was in
flight SHALL drop its notice and its sidebar poke; the drive itself completes in the server.

#### Scenario: First open of an analysis with inputs profiles it

- **WHEN** the TUI opens an analysis that has inputs but has never been profiled
- **THEN** the profile workflow is triggered without blocking the chat, and a notice reports it started

#### Scenario: Chat is never blocked on the profile

- **WHEN** the chat-context drive triggers a profile workflow on chat open
- **THEN** the chat accepts turns immediately and the server answers as soon as the trigger is dispatched

#### Scenario: Chat is usable while the profile runs

- **WHEN** the profile workflow is still running
- **THEN** a submitted message runs a normal turn (no gate, no refusal)

#### Scenario: Adding an input to a profiled analysis re-profiles it

- **WHEN** an input is added to an analysis whose profile completed — through the file picker, a command, or the `manage_inputs` tool of the agent — while the runtime of the server is ready
- **THEN** the server re-triggers the profile with no further user action, and the sidebar shows the profile running at its next read

#### Scenario: A burst of input edits gives one drive

- **WHEN** one edit removes several inputs of an analysis
- **THEN** the server runs one input-change drive after the burst, not one drive for each input

#### Scenario: A run that fails still releases work deferred by the running-skip

- **GIVEN** inputs changed while a profile was running, so the drive skipped
- **WHEN** that profile reaches `failed` rather than `completed`
- **THEN** the terminal-state edge SHALL ask for the chat context again, materializing the changed input set

#### Scenario: Edits during a running profile are caught at completion

- **WHEN** inputs change while a profile is running
- **THEN** the drive skips (already running), and when that profile completes the TUI asks again and the server acts on the changed set

#### Scenario: Two drives of one analysis do not race the workspace tree

- **WHEN** an input-change drive and a chat-context drive arrive for one analysis while a drive of that analysis is staging
- **THEN** the later drives SHALL run strictly after the first completes
- **AND** `stageInputs` SHALL never execute concurrently for one analysis

#### Scenario: A clear cannot wipe a concurrent drive's seed

- **WHEN** one drive observes an emptied input set and clears the ledger while another drive is seeding a non-empty set
- **THEN** the two SHALL NOT interleave, and no drive SHALL report a start failure caused by the other's clear

#### Scenario: Removing every input clears the profile

- **WHEN** the user removes the last input of an analysis with a completed profile
- **THEN** the server clears the profile, and the DATA PROFILE section returns to "not profiled" at its next read

#### Scenario: A swap drops a stale notice

- **WHEN** the user swaps to a different analysis while a chat-context request for the first analysis is in flight
- **THEN** the TUI raises no notice and pokes no sidebar read for the first analysis
