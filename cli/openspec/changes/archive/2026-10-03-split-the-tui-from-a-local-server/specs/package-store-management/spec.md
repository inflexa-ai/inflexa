## ADDED Requirements

### Requirement: Only store link is a client of the local server

`store link` MUST be a client of the local server. It resolves its
analysis through the server, and the server links the packages into the
farm, behind the farm queue of the server. Each other `store` command MUST
run in its own process, with no server and no server start. A one-shot
container of a cloud job runs these commands, and it has no local server.
The hidden worker modes (`store add --run-flush` and
`store download --run-transfer`) MUST also run with no server. The server
runs the same store logic for its own clients. The lock files and the
flight and transfer rows coordinate a command process with the server.

#### Scenario: A store command runs with no server

- **GIVEN** a machine on which no local server runs
- **WHEN** `inflexa store ls` or `inflexa store download --foreground` runs
- **THEN** the command runs to its end, and no server starts

#### Scenario: A link goes through the server

- **WHEN** `inflexa store link jinja2==3.1.6 --lang python` runs
- **THEN** the command connects to the local server, and the server extends the farm

## MODIFIED Requirements

### Requirement: Approved packages batch through the pending set

An approved `store add` MUST enqueue into a host-side pending set, not start
its own provisioner run. The pending set MUST persist in the primary
database, thus a crash loses no approved entry. The flight MUST launch at
the first of three moments: the end of the agent turn, an explicit flush,
or 10 seconds after the oldest pending add was enqueued. The 10-second gate
bounds the wait of a long turn. An add approved early must not sit queued
behind minutes of agent work, because the acquisition can run beside that
work.

The local server MUST run the gate for its whole life, whatever client is
open, because an agent add can wait while no TUI runs. The gate anchors on
the enqueue time of the oldest pending add. It does not slide, thus a
burst of asks still lands in one batch. After a start, the gate MUST NOT
start again for one window. The split of one turn into two flights is
accepted, and it costs one more container run, because the provisioner
resolves each spec alone.

One provisioner run MUST take the whole claimed set. A direct terminal
`store add` flushes the whole set at once. A flush can claim the entries
that another live turn queued, and that split is accepted: each spec still
reports through its own flight. One flight exists per normalized spec, and
the flight concurrency cap stays configurable.

#### Scenario: Three approvals share one run

- **GIVEN** an agent turn in which the user approves three package asks inside the gate window
- **WHEN** the flush claims the set
- **THEN** one provisioner run takes the three specs together

#### Scenario: The gate flushes a long turn

- **GIVEN** an approved add, and an agent turn that continues past the gate
- **WHEN** 10 seconds pass from the enqueue of the oldest pending add
- **THEN** the detached flush starts, and the flight runs beside the turn

#### Scenario: The gate runs with no TUI

- **GIVEN** a local server, a queued add, and no open TUI
- **WHEN** 10 seconds pass from the enqueue of the add
- **THEN** the server starts the detached flush

#### Scenario: A failing spec drops without the batch

- **GIVEN** a batch in which one spec cannot resolve
- **WHEN** the flight completes
- **THEN** the other packages commit, and the failing spec reports its own refusal to the asker

### Requirement: Debris collects without a command

The app MUST collect debris silently, with no user command. Debris is the
store content that nothing references: a store directory with no farm link
and no graph node, and a stale acquire report. The collection MUST run at
two moments, and no timer exists. The tail of a flush that ended with
refusals, and one boot pass after the runtime of the local server reaches
ready.

Both MUST run only when no acquisition flight, no farm composition, and no
transfer is live. A sandbox run needs no gate of its own. A run reaches
store content only through the links of its farm, and a linked directory
is never debris. Both MUST hold the reclaim exclusivity, and both MUST
yield to live work.

The reclaim lock is re-entrant for one pid, thus it excludes a different
process only. Within one process, a second collection MUST join the live
one. A reclamation and a collection MUST also exclude each other in one
process: a second reclamation refuses, and a collection yields. The local
server runs a reclamation and the debris passes in one process. An entry
beside the first would release the lock under it.

The collection MUST NOT
touch a directory that the graph references, thus a pre-fetched package
survives. `store reclaim` keeps its approval gate, and it removes the same
tier plus the graph prune.

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

#### Scenario: A collection yields to a reclamation of the same process

- **GIVEN** a reclamation that runs in the local server
- **WHEN** a debris pass of the same server starts
- **THEN** the pass collects nothing, and the lock stays with the reclamation
