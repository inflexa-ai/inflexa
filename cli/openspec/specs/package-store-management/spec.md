# package-store-management Specification

## Purpose

The `inflexa store` command family and the acquisition flights. An approved add joins the pending set, one provisioner run resolves the batch, and the load check gates the commit.
## Requirements
### Requirement: The store command family has one policy per command

The CLI MUST expose the `inflexa store` family: `add`, `link`, `ls`,
`download`, `cancel`, and `reclaim`. No `store use` and no `store verify`
exist. Each command declares its agent policy at registration: `add` and
`download` are `approval`, `ls` is `auto` with no flags, `link` is `auto`
with `analysis` in its safe flags, and `reclaim` is `approval`. The chat
install path of today MUST keep working: the agent runs `store add` through
the run-inflexa tool, and each call pauses on the TUI ask.

#### Scenario: The agent installs with one gated call

- **WHEN** the conversation agent runs `inflexa store add polars --version 1.2.0` through run-inflexa
- **THEN** the TUI asks the user, and the flight starts only on approval

#### Scenario: No farm switch exists

- **WHEN** the command tree is listed
- **THEN** no `store use` and no `store verify` command exists

### Requirement: store add takes one package with explicit flags

`store add` MUST take exactly one package per call, with `--version <v>`
(optional, latest otherwise), `--lang python|r` (optional), and
`--analysis <ref>` (optional, extends that farm after the commit). A prefix
syntax such as `r::name` MUST NOT appear at the command surface. Without
`--lang`, the flight searches both ecosystems, and a name that both satisfy
stops with an ask to the user.

#### Scenario: One package per call

- **WHEN** `inflexa store add scanpy numpy` runs
- **THEN** the command refuses with the one-package rule

#### Scenario: A both-hit name asks

- **GIVEN** a name that PyPI and CRAN both hold, and no `--lang`
- **WHEN** the add runs
- **THEN** the user gets an ask that names the two candidates, and nothing installs before the answer

### Requirement: Approved packages batch through the pending set

An approved `store add` MUST enqueue into a host-side pending set, not start
its own provisioner run. The pending set MUST persist in the primary
database, thus a crash loses no approved entry. The flight MUST launch when
the agent turn ends, or on an explicit flush. The turn end is the true end
of the asks: an approved add only enqueues, and no ask comes after the turn.
A mid-turn grace timer is rejected. The formulation time of the agent has
no bound, thus a timer would split one batch.

One one-shot provisioner run MUST resolve the whole approved set. A direct
terminal `store add` flushes the whole set at once. A flush can claim the
entries that another live turn queued, and that split is accepted: each
spec still reports through its own flight. One flight exists per normalized
spec, and the flight concurrency cap stays configurable.

#### Scenario: Three approvals share one run

- **GIVEN** an agent turn in which the user approves three package asks
- **WHEN** the turn ends
- **THEN** one provisioner run resolves the three specs together

#### Scenario: A failing spec drops without the batch

- **GIVEN** a batch in which one spec cannot resolve
- **WHEN** the flight completes
- **THEN** the other packages commit, and the failing spec reports its own refusal to the asker

### Requirement: The flight is two-phase with the load check between

A flight MUST run in two phases. Phase one: the provisioner acquires the set
into the pool and stages the graph nodes as data. Phase two: the flight runs
the load check of the acquired set inside the sandbox image. On a green
check, it appends the staged nodes to the graph under the metadata lock. A
failed check MUST leave no advertised state: no graph node, no farm link,
and a reported refusal. `store reclaim` frees the orphaned bytes.

#### Scenario: A green check commits

- **GIVEN** an acquired set whose load check passes
- **WHEN** the flight completes
- **THEN** the graph holds the new nodes, and the requested farm gains the links

#### Scenario: A red check advertises nothing

- **GIVEN** an acquired package that fails its load check
- **WHEN** the flight completes
- **THEN** the graph holds no node for it, and the failure reports with the load error

### Requirement: A flight launches the provisioner with the acquisition egress classes

The flight MUST pass the egress allowlist of an acquisition to the
provisioner container, through its `INFLEXA_EGRESS_ALLOW` environment
variable. The launch adds the `NET_ADMIN` capability for the rule install. The
list MUST hold two host classes only: the pinned Python index with its file
host, and the configured pak repositories. The GitHub hosts and
`git.bioconductor.org` belong to the catalog build alone. A flight MUST NOT
launch the provisioner with the variable unset, because an unset variable
gives open egress.

#### Scenario: The flight passes the two classes

- **WHEN** a flight launches the provisioner `acquire` run
- **THEN** the container env carries `INFLEXA_EGRESS_ALLOW` with the index hosts and the pak repositories, and no GitHub host

#### Scenario: No open-egress acquisition exists

- **WHEN** any code path of the CLI launches a provisioner `acquire` run
- **THEN** the launch sets the allowlist variable

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

