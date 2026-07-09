# tui-harness-chat — Delta

## ADDED Requirements

### Requirement: One generation token orders every write to the message store

Both asynchronous producers that write the conversation store SHALL claim the same monotonic
generation token at entry, and SHALL re-check it after every `await` before writing the message store,
the streaming signals, the error banner, or the chat status. Those producers are a transcript load
(`loadMessages`) and a turn (`send`, through its emit adapter and `finishTurn`). The newest
store-writing operation to have *started* wins; any older one SHALL drop silently.

A turn therefore supersedes a transcript load already in flight: the load is a replay of durable state
the turn is about to append to, while the turn carries the user's live input. `resetHotState` SHALL
also claim the token, so a load started for a session the user has swapped away from can never
repopulate the cleared store.

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

## MODIFIED Requirements

### Requirement: The data profile auto-triggers at parity

Opening an analysis chat on a `ready` runtime SHALL bring the analysis's data profile to parity with
its current input set, fire-and-forget, without gating the chat. The same check SHALL re-run when the
open analysis changes, when a `prov.input_added`/`prov.input_removed` for the open analysis settles
(debounced to one check per burst), and on a profile run's `running → completed` transition.

Every entry into the profile lifecycle — the parity edges above and the deliberate manual re-profile —
SHALL be **serialized**: at most one may run its stage → seed → trigger sequence at a time, and one
arriving while another runs SHALL queue behind it rather than be dropped, because the edges fire
precisely because state changed. Serialization is required for two reasons the ledger CAS cannot
supply, since it runs only after staging: concurrent `stageInputs` calls on one session tree race the
tree-reconciliation delete, and a concurrent clear can null `seed_input_file_ids` between another
drive's seed write and its trigger.

Parity SHALL be judged on the input files' **drift signatures** — `(fileId, size, mtimeMs)` — not on
their identities alone, so that editing an input file's bytes in place at the same path re-profiles.
A completed ledger row that records no signatures SHALL be treated as drifted.

Managed-parity skips SHALL stay silent; a started (or restarted) profile SHALL raise a transient
notice and poke the sidebar's store so its bounded poll arms.

#### Scenario: Chat is never blocked on the profile

- **WHEN** the parity check triggers a profile workflow on chat open
- **THEN** the chat accepts turns immediately and the check returns as soon as the trigger is dispatched

#### Scenario: Two edges firing together do not race the session tree

- **WHEN** an input-mutation edge and a profile-completion edge fire while a parity check is already staging
- **THEN** the later drives SHALL run strictly after the first completes
- **AND** `stageInputs` SHALL never execute concurrently for one analysis

#### Scenario: A clear cannot wipe a concurrent drive's seed

- **WHEN** one drive observes an emptied input set and clears the ledger while another drive is seeding a non-empty set
- **THEN** the two SHALL NOT interleave, and no drive SHALL report a start failure caused by the other's clear

#### Scenario: An in-place content edit re-profiles

- **WHEN** an input file's bytes change at the same path (altering its size or mtime) and a parity edge fires
- **THEN** the check SHALL observe drift and re-trigger the profile, rather than reporting the analysis already profiled

#### Scenario: A completed row without signatures re-profiles once

- **WHEN** the ledger's completed result predates the drift-signature field
- **THEN** the check SHALL treat it as drifted and re-profile
