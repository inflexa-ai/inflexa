# Delta: package-store-management

## ADDED Requirements

### Requirement: A refused flight leaves a durable row

A spec that a flight refuses MUST settle as a terminal `failed` flight row,
with a durable message. The message MUST name the phase: `resolve`,
`load_check`, or `commit`. It MUST carry the whole error text, because
the row is the one copy after the debris pass collects the report file.
The surfaces bound the render: the sidebar prints one line, and `store ls`
prints a short head. A success
MUST still delete its row, because a completed state that everyone has is
noise. A retry of the same spec MUST claim the same row, thus the failure
clears with the retry. `store ls` MUST list the failed flights with their
reasons. The sidebar MUST keep one failure line per failed flight. A
flight-claim query failure MUST surface as its own refusal, and it MUST NOT
read as an in-flight duplicate.

#### Scenario: A load-check refusal survives the detached flush

- **GIVEN** a chat-queued add whose load check fails inside the sandbox image
- **WHEN** the turn-end flush completes
- **THEN** a `failed` flight row holds the load error, and `store ls` prints it

#### Scenario: The retry clears the failure

- **GIVEN** a `failed` row for one spec
- **WHEN** the same spec is enqueued and flies again
- **THEN** the row returns to `queued`, and no stale failure line stays

#### Scenario: A broken ledger is not contention

- **GIVEN** a database in which the flight table is unreadable
- **WHEN** a flush claims a spec
- **THEN** the outcome is a refusal that names the ledger problem, not "joined"

### Requirement: Debris collects without a command

The app MUST collect debris silently, with no user command. Debris is the
store content that nothing references: a store directory with no farm link
and no graph node, and a stale acquire report. The collection MUST run at
two moments, and no timer exists. The tail of a flush that ended with
refusals, and one boot pass after the runtime reaches ready.

Both MUST run only when no acquisition flight, no farm composition, and no
transfer is live. A sandbox run needs no gate of its own. A run reaches
store content only through the links of its farm, and a linked directory
is never debris. Both MUST hold the reclaim exclusivity, and both MUST
yield to live work. The collection MUST NOT touch a directory that the
graph references, thus a pre-fetched package survives. `store reclaim`
keeps its meaning and its approval gate.

#### Scenario: A failed acquisition frees itself

- **GIVEN** a flush in which one spec failed its load check
- **WHEN** the flush tail runs with no other live work
- **THEN** the never-advertised directories of the failed spec leave the pool

#### Scenario: The collection yields to live work

- **GIVEN** a live acquisition flight
- **WHEN** the boot pass wakes
- **THEN** it collects nothing and takes no lock that the flight waits on

#### Scenario: A flush tail beside a live sibling collects nothing

- **GIVEN** two concurrent flights, one that ended with a refusal and one still live
- **WHEN** the tail of the finished flush runs
- **THEN** it collects nothing, because the live sibling can hold staged directories

#### Scenario: An advertised package is not debris

- **GIVEN** a committed package that no farm links yet
- **WHEN** the debris collection runs
- **THEN** the directory and its node stay

## MODIFIED Requirements

### Requirement: The post-plan conversation asks per package

After a plan is made, the conversation agent MUST write the package list of
the plan to the user. It MUST mark the packages that the pool does not
hold. It MUST then ask per missing package, through the gated `store add` call. A
refusal MUST return to the agent as guidance, thus the agent can propose a
replacement. The conversation prompt MUST carry the swap invitation: the
user can name a different package in place of a proposed one. A queued
package can stay missing in a later turn. The prompt MUST then direct the
agent to read `store ls` before any second ask, because the failed flight
row carries the reason.

#### Scenario: The user swaps a package

- **GIVEN** a plan that names pandas, and a user answer "use polars instead"
- **WHEN** the conversation continues
- **THEN** the agent revises the plan toward polars and asks for polars, and the pandas ask does not come again

#### Scenario: A refusal guides the agent

- **GIVEN** a user who declines one package ask
- **WHEN** the agent reads the refusal
- **THEN** the agent proposes an alternative or replans, and it does not send the same ask again

#### Scenario: The agent reads the failure before a second ask

- **GIVEN** a queued package whose flight failed after the turn
- **WHEN** the agent notices the package still missing
- **THEN** it reads `store ls`, and its next message carries the recorded reason instead of a repeated ask
