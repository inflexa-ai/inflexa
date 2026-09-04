# package-store-management Specification

## Purpose

The `inflexa store` command family and the acquisition flights. An approved add joins the pending set, one provisioner run resolves the batch, and the load check gates the commit.
## Requirements
### Requirement: The store command family has one policy per command

The CLI MUST expose the `inflexa store` family: `add`, `link`, `ls`,
`download`, `cancel`, and `reclaim`. No `store use` and no `store verify`
exist. Each command declares its agent policy at registration. `add`,
`download`, and `reclaim` are `approval`. `ls` is `auto` with no flags.
`link` is `auto` with `analysis` and `lang` in its safe flags. The safe
flags MUST cover the natural agent call whole, because a link takes no ask.
An unsafe flag on the natural call makes the auto policy dead in practice.
A bare `store link` MUST resolve the analysis from the anchor of the
working directory. A folder that anchors none, or more than one, MUST
refuse with the flag. The chat install path of today MUST keep working: the
agent runs `store add` through the run-inflexa tool, and each call pauses
on the TUI ask.

#### Scenario: The agent installs with one gated call

- **WHEN** the conversation agent runs `inflexa store add polars --version 1.2.0` through run-inflexa
- **THEN** the TUI asks the user, and the flight starts only on approval

#### Scenario: No farm switch exists

- **WHEN** the command tree is listed
- **THEN** no `store use` and no `store verify` command exists

#### Scenario: The natural link call runs without an ask

- **GIVEN** the agent runs `store link jinja2==3.1.6 --lang python` through run-inflexa, inside the analysis folder
- **WHEN** the tool classifies the call
- **THEN** the command runs with no approval ask, and the farm of the anchored analysis gains the link

### Requirement: store add takes one package with explicit flags

`store add` MUST take exactly one argument per call, with `--version <v>`
(optional, latest otherwise), `--lang python|r` (optional), and
`--analysis <ref>` (optional, extends that farm after the commit). The
command MUST parse the argument with `parseQuery` of the harness. A
version inside the argument is the version of the query. The two flags
merge into the query. A prefix such as `r:name` MUST NOT appear at the
command surface: an argument that carries one refuses with the `--lang`
remedy. A flag and a value in the argument that disagree MUST refuse.
Without `--lang`, the flight searches both ecosystems, and a name that
both satisfy stops with an ask to the user.

#### Scenario: One package per call

- **WHEN** `inflexa store add scanpy numpy` runs
- **THEN** the command refuses with the one-package rule

#### Scenario: A both-hit name asks

- **GIVEN** a name that PyPI and CRAN both hold, and no `--lang`
- **WHEN** the add runs
- **THEN** the user gets an ask that names the two candidates, and nothing installs before the answer

#### Scenario: A pinned argument records its version

- **WHEN** `inflexa store add scanpy==1.11` runs
- **THEN** the pending row carries the spelling `scanpy` and the specifier `==1.11`

#### Scenario: A prefix at the command surface refuses

- **WHEN** `inflexa store add r:Seurat` runs
- **THEN** the command refuses, and the refusal names `--lang r`

### Requirement: Approved packages batch through the pending set

An approved `store add` MUST enqueue into a host-side pending set, not start
its own provisioner run. The pending set MUST persist in the primary
database, thus a crash loses no approved entry. The flight MUST launch at
the first of three moments: the end of the agent turn, an explicit flush,
or 10 seconds after the pending set becomes non-empty. The 10-second gate
bounds the wait of a long turn. An add approved early must not sit queued
behind minutes of agent work, because the acquisition can run beside that
work. The gate anchors on the first observation of a non-empty set. It does
not slide, thus a burst of asks still lands in one batch. The split of
one turn into two flights is accepted, and it costs one more container run,
because the provisioner resolves each spec alone.

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
- **WHEN** 10 seconds pass from the first observation of the pending set
- **THEN** the detached flush starts, and the flight runs beside the turn

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

The Python resolve of phase one MUST ride the pins of the pool as
constraints, from the head of each shelf. Thus an add reuses a held pin
whenever its ranges permit it, and no needless second pin lands. When the
constrained resolve fails, the resolve MUST run again without constraints —
the committed-lock pattern of the catalog build. A second pin of one name
appears only when the ranges force it.

The commit MUST NOT rewrite a node the graph already holds. The first
resolution of a store directory is durable. Thus a later add can never move
a held edge, and a composed farm can never go stale. Without this rule, an
add that shares one dependency with held content re-resolves that node.
The moved edge then blocks every later extension of a composed farm.

#### Scenario: A green check commits

- **GIVEN** an acquired set whose load check passes
- **WHEN** the flight completes
- **THEN** the graph holds the new nodes, and the requested farm gains the links

#### Scenario: A red check advertises nothing

- **GIVEN** an acquired package that fails its load check
- **WHEN** the flight completes
- **THEN** the graph holds no node for it, and the failure reports with the load error

#### Scenario: The acquire reuses a held pin

- **GIVEN** a pool whose jinja2 shelf head is 3.0.3, and an add whose ranges permit that version
- **WHEN** the acquire resolves
- **THEN** the closure reuses jinja2==3.0.3, and no second pin lands

#### Scenario: A true conflict still lands a second pin

- **GIVEN** an add whose ranges exclude every held pin of one name
- **WHEN** the constrained resolve fails
- **THEN** the resolve runs again without constraints, and the second pin lands

#### Scenario: A held node keeps its edges

- **GIVEN** a graph node whose store directory a new batch stages again
- **WHEN** the commit runs
- **THEN** the published edges stay, and the staged edges of that node drop

#### Scenario: A later add cannot brick a farm

- **GIVEN** a farm composed from held pins
- **WHEN** a later add commits a batch that re-stages a held node
- **THEN** every extension of that farm still composes, because no held edge moved

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

The conversation agent and the planner MUST read a POOL-scope inventory,
with the pinned versions, bound at the composition root. The farm view
answers a different question — what a step imports now — and an empty new
farm read as "everything is absent". Thus the ask list holds only the
packages that the pool does not hold. The prompt MUST also forbid an
ordering claim: no mechanism runs an acquisition before the run, and the
agent MUST NOT tell the user that one does.

#### Scenario: A pool-held package raises no ask

- **GIVEN** a plan that names pandas, and a pool that holds pandas at any version
- **WHEN** the post-plan conversation marks the packages of the plan
- **THEN** no ask for pandas is sent, and the launch links it from the pool

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

### Requirement: The launch refusal classifies each missing package

A launch whose plan packages cannot link MUST refuse before the run
reserves anything — the harness link pass is that gate. The remedy text of
the refusal MUST classify each missing spelling against the host rows. A
row matches a miss by identity when both carry a track. It matches by
spelling when neither carries a track. A pair in which only one side
carries a track matches nothing, because the side that names no track
stands for both ecosystems. A match with a pending add or a live flight
reads as in flight, with "launch again when it lands". A match with a
failed row carries the recorded reason, with the retry and the delete
remedies. An unknown spelling carries the store-add ask. When the
resolution carries a suggestion, the remedy MUST name its spelling before
the store-add ask. The pool holds the package under that spelling. Thus
the agent replans from the true state, and no run is wasted on a package
that never landed.

A version collision MUST name the two store directories and the closure
members that pull each side. The dependent is the remedy surface: the fix
is to drop or re-pin a dependent, and a bare name makes the reader guess
it. A two-track collision MUST name the two identity keys, and the two
prefixed forms written with `formatQuery`. The prefix is the remedy, thus
the refusal names it. An unreadable dependency graph MUST refuse as one
store-level reason, never as a per-package absence. A false absence sends
the agent after packages the pool holds, and it hides the structural
fault.

#### Scenario: An in-flight package defers the launch with its state

- **GIVEN** a plan package whose flight still runs
- **WHEN** the launch refuses on the pool miss
- **THEN** the remedy names the package as in flight, and directs a later launch, not a second ask

#### Scenario: A failed package surfaces its recorded reason at launch

- **GIVEN** a plan package with a `failed` flight row
- **WHEN** the launch refuses on the pool miss
- **THEN** the remedy carries the recorded reason, with the retry and the delete remedies

#### Scenario: A collision names the dependents

- **GIVEN** a plan whose closure pulls two pins of one distribution
- **WHEN** the launch refuses on the collision
- **THEN** the refusal names both store directories, each with the closure members that pull it

#### Scenario: A broken graph refuses as itself

- **GIVEN** a dependency graph with a dangling edge
- **WHEN** the launch runs its link pass
- **THEN** the refusal carries the graph reason, and no package reads as absent

#### Scenario: A two-track collision names the prefixed forms

- **GIVEN** a plan that names `igraph` bare, against a pool that holds `igraph` in both tracks
- **WHEN** the launch refuses on the collision
- **THEN** the refusal names `python:igraph` and `r:igraph`

#### Scenario: A folded R spelling names its suggestion

- **GIVEN** a plan that names `seurat`, against a pool that holds `Seurat` in the R track only
- **WHEN** the launch refuses on the pool miss
- **THEN** the remedy names `Seurat` before the store-add ask

#### Scenario: A Python flight does not answer an R miss

- **GIVEN** a live flight with the track `python` and the spelling `seurat`, and a plan that names `r:Seurat`
- **WHEN** the launch refuses on the pool miss
- **THEN** the remedy is the store-add ask, and it does not read as in flight

### Requirement: The sidebar carries the package pipeline

The sidebar MUST render the package pipeline in a section of its own,
apart from the machine transfers. A transfer is machine state, and a
flight is analysis work — one mixed section misleads the reader about
both. The section holds the pending adds, the queued
and the running flights, and the failed rows. A running flight row MUST
carry the newest provisioner progress line. A summary line MUST give the
queued and the running counts.

#### Scenario: A running flight shows its progress line

- **GIVEN** a live flight whose provisioner wrote a progress line
- **WHEN** the sidebar renders the pipeline section
- **THEN** the flight row carries that newest line

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

A failed row in the TUI MUST open a detail view, by mouse and through the
command palette. The view shows the spec, the phase as one plain sentence,
the whole recorded reason, and the store directory with its hash where
known. Its actions are copy, retry, and delete. Retry enqueues the same
spec and starts the detached flush — the action itself is the consent.
Delete removes the row, and the silent debris pass frees the bytes. The
record stays whole, and only the render translates the phase.

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

#### Scenario: The dialog retry clears the failure

- **GIVEN** a failed row open in the detail view
- **WHEN** the user chooses retry
- **THEN** the spec enqueues, the detached flush starts, and the row returns to `queued`

#### Scenario: The dialog delete removes the record

- **GIVEN** a failed row open in the detail view
- **WHEN** the user chooses delete
- **THEN** the row leaves the ledger, and the debris pass frees the never-advertised bytes

### Requirement: The reclaim removes only unadvertised content

`store reclaim` MUST remove only a store directory that no farm links AND
that the dependency graph does not advertise. A graph-advertised directory
is pool inventory, for two reasons. A locally acquired package holds no
farm link until a run links it, thus "no farm link" marks fresh inventory
as well as waste. And an edge of a surviving node must keep its target. A
removal that ignores edges leaves a dangling edge, and the strict graph
reader then refuses the whole pool. The reclaimable readout of `store ls`
MUST count the same set as the removal. The provisioner run MUST still
prune the graph nodes whose directories are gone.

#### Scenario: An acquired package survives the reclaim

- **GIVEN** a committed package that no farm links yet
- **WHEN** `store reclaim` runs
- **THEN** the directory and its graph node stay, and the readout counted nothing for it

#### Scenario: The dependency of a surviving node survives

- **GIVEN** a store directory that only the edge of another node references
- **WHEN** `store reclaim` runs
- **THEN** the directory stays, thus the graph keeps every edge resolvable

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
yield to live work. Within one process, a second collection MUST join the
live one, because the exclusivity lock is re-entrant for one pid. An entry
beside the first would release the lock under it. The collection MUST NOT touch a directory that the
graph references, thus a pre-fetched package survives. `store reclaim`
keeps its approval gate, and it removes the same tier plus the graph
prune.

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

### Requirement: Analysis creation makes the empty farm

Analysis creation MUST make the farm of the analysis, empty, with its
`inflexa.lock`, before the profile trigger. Thus every post-release analysis
carries a farm from birth, and no sandbox races the discriminator. The empty
lock holds the schema, the arch, and an empty package list. A failed farm
make MUST stop the creation. The message MUST name the farm path, the
cause, and the retry — a farm-less analysis would be a broken shell.

#### Scenario: A new analysis has a farm before its first sandbox

- **WHEN** an analysis is created
- **THEN** its farm exists with an empty lock, before the profile workflow starts

#### Scenario: A farm-make failure stops the creation

- **GIVEN** a farm path that cannot be written
- **WHEN** the analysis creation runs
- **THEN** the creation stops, and the message names the farm path, the cause, and the retry

#### Scenario: The profiler of a new analysis meets the empty farm

- **GIVEN** a freshly created analysis
- **WHEN** the profile sandbox resolves its farm
- **THEN** the resolver finds the farm, and the full-composition path does not run

### Requirement: A farm-less analysis heals full from the catalog

When no farm exists for an analysis, the heal MUST compose a full farm from
the closure of the catalog farm, through the staging swap. The missing farm
is the pre-release discriminator, thus the heal never runs for a
post-release analysis. The heal runs at the first of three triggers:

- an analysis open with the catalog present
- the catalog landing, observed by the transfer poll of the open session
- the farm resolution of a sandbox, as the backstop

The healed farm MUST copy the catalog `inflexa.lock` verbatim. Thus the
advertised inventory equals the linked content, and the warm records ride.
With no catalog and no live transfer, the open MUST prompt for the
download, with one consent. Between the consent and the landing, the
analysis stays farm-less, and a launch refuses with the classified
live-transfer reason. A present farm MUST stay untouched.

#### Scenario: A pre-release analysis keeps everything available

- **GIVEN** an analysis created before the release, with no farm, and a present catalog
- **WHEN** the analysis opens
- **THEN** the farm links the whole catalog closure, and the lock is the catalog copy

#### Scenario: A live transfer defers the heal to the landing

- **GIVEN** a farm-less analysis open while the catalog transfer runs
- **WHEN** the transfer poll observes the landing
- **THEN** the heal runs, and the next sandbox serves the full farm without a restart

#### Scenario: No catalog prompts for the download

- **GIVEN** a farm-less analysis, no catalog, and no live transfer
- **WHEN** the analysis opens
- **THEN** the open prompts for the download, and a launch before the landing refuses with the classified reason

#### Scenario: A present farm stays as it is

- **GIVEN** an analysis whose farm exists, empty or composed
- **WHEN** any trigger fires
- **THEN** the farm is served unchanged, and no composition runs

#### Scenario: A concurrent heal serializes

- **GIVEN** two triggers that fire for one analysis at the same time
- **WHEN** the two heals run
- **THEN** they serialize under the store lock, and the second serves the published farm

#### Scenario: A hand-deleted farm heals full

- **GIVEN** an analysis whose farm directory was removed outside the product
- **WHEN** a trigger fires
- **THEN** the analysis heals full, as a safe degradation

### Requirement: A request is a query, and the ledger keys its spelling

A `store add` request MUST be a `PackageQuery` of the harness. The flight
id MUST be `<track or any>::<spelling>::<specifier>`. The two request
tables MUST hold `spelling`, `ecosystem`, and `specifier`, and no folded
name. Migration 10 MUST rebuild the two tables, and it MUST fill
`spelling` from `raw_name`, or from `name` when `raw_name` is null. The
dedupe of the pending set MUST compare the spelling, the specifier, and
the track. Two spellings of one fold are two rows, because they are two
queries. The spelling MUST reach the installer and every render: the
sidebar pipeline, `store ls`, the refusal messages, and the both-hit ask.
The provisioner spec MUST be `formatQuery` of the query. Without `--lang`,
each ecosystem MUST be probed in the spelling, thus the both-hit guard
stays armed for a name that both ecosystems hold.

#### Scenario: A dotted R name reaches pak unchanged

- **WHEN** `inflexa store add GO.db --lang r` flushes
- **THEN** the provisioner spec is `r:GO.db`

#### Scenario: Two equal queries make one flight

- **GIVEN** two pending rows for `GO.db` with the track `r`
- **WHEN** the flush claims the set
- **THEN** one flight runs

#### Scenario: Two spellings make two flights

- **GIVEN** a pending `GO.db` and a pending `go.db`, both with the track `r`
- **WHEN** the flush claims the set
- **THEN** two flights run, and the second refuses because no R package is named `go.db`

#### Scenario: The render shows the spelling

- **GIVEN** a failed flight for `GO.db`
- **WHEN** the sidebar or `store ls` renders the row
- **THEN** the row reads `GO.db`, never `go-db`

#### Scenario: The both-hit guard arms for a dotted name

- **GIVEN** a name that PyPI holds under the folded form and CRAN holds under the spelling
- **WHEN** the add runs without `--lang`
- **THEN** the run stops with the two candidates, and nothing installs silently

#### Scenario: Migration 10 keeps the spelling of a live row

- **GIVEN** a database at migration 9 with a live flight row whose `raw_name` is `GO.db` and whose `name` is `go-db`
- **WHEN** migration 10 runs
- **THEN** the row carries the spelling `GO.db`, and no `name` column exists

