## REMOVED Requirements

### Requirement: Debris collects without a command

**Reason**: The local server runs no reclamation, because it gives no reclaim route. Thus the exclusion of a reclamation and a collection in one process has no use, and the code removed it.
**Migration**: The requirement "Debris collects with no user command" gives the collection, with the delete of a failed flight record as a third moment.

## ADDED Requirements

### Requirement: Debris collects with no user command

The app MUST collect debris silently, with no user command. Debris is the
store content that nothing references: a store directory with no farm link
and no graph node, and a stale acquire report. The collection MUST run at
these moments, and no timer exists:

- the tail of a flush that ended with refusals
- one boot pass after the runtime of the local server reaches ready
- the delete of a failed flight record through the local server

Each pass MUST run only when no acquisition flight, no farm composition,
and no transfer is live. A sandbox run needs no gate of its own. A run
reaches store content only through the links of its farm, and a linked
directory is never debris. Each pass MUST hold the reclaim exclusivity,
and each pass MUST yield to live work.

The reclaim lock is re-entrant for one pid, thus it excludes a different
process only. Within one process, a second collection MUST join the live
one. Only `store reclaim` runs a reclamation, in its own process. The
local server runs no reclamation. Thus a reclamation and a collection
never meet in one process, and the lock file excludes them.

The collection MUST NOT touch a directory that the graph references, thus
a package that an add fetched before its use stays. `store reclaim` keeps
its approval gate, and it removes the same tier plus the graph prune.

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

#### Scenario: A collection yields to a reclamation of a different process

- **GIVEN** a `store reclaim` that runs in its own process
- **WHEN** the boot pass of the local server starts
- **THEN** the pass collects nothing, and the lock stays with the reclamation
