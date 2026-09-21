# Spec Delta

## ADDED Requirements

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
