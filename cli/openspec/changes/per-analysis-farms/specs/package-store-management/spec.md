# package-store-management Delta — Per-Analysis Farms

## MODIFIED Requirements

### Requirement: The store can be inspected and reclaimed

The CLI MUST report what a store holds — its packages, the farms defined against it, and the disk each occupies. It MUST give a way to remove a farm, and a way to remove store content that no farm references. Reclamation MUST never run implicitly as a side effect of another command.

The inspection MUST name the analysis of each analysis farm, and it MUST mark the catalog template farm as the template. It MUST say which tracks each farm carries. A farm with fewer tracks than another is the reason an import fails in one analysis and not in another.

The inspection MUST report the state of the download beside the farms. It MUST
name the state, and it MUST name the bytes transferred and the total bytes while
a transfer runs. When the state is `failed`, it MUST report the message and it
MUST name `inflexa store download` as the retry. When the state is `canceled`, it MUST
say that the user stopped the transfer, and it MUST name the same retry. When no
row exists, it MUST say that no download ran, because a store can arrive by a
route that wrote no row.

The inspection MUST report a live acquisition flight beside the download: the spec of the flight, its state, and the analyses subscribed to it.

The inspection MUST report an available update when the recorded resolve differs
from the receipt. The row records the digest of the last resolve, and the receipt
pins the digest that is installed. The inspection MUST name `inflexa store
download --update`, and it MUST open no prompt. The user owns that decision.

A resolve happens only when `inflexa store download` or `inflexa setup` runs.
`inflexa store ls` stays local, and it opens no network call. Thus the two
surfaces report no update between a moved tag and the next resolve. The sidebar
obeys the same rule, because it reads the same two records.

The inspection command MUST stay prompt-free and MUST gain no option, because a
passive diagnostic stays passive. A new option on an `auto` command is unsafe
until the user says otherwise.

Reclamation MUST be exclusive against live acquisition flights: it waits for zero flights and blocks new ones while it scans and deletes. Before it frees pool content, it MUST run the orphan-farm reaper, which removes a farm whose analysis id is not in the DB.

#### Scenario: Inspection reports contents and size

- **GIVEN** a populated store
- **WHEN** the user inspects it
- **THEN** the output lists the packages, the farms, and the disk used

#### Scenario: Reclamation spares referenced content

- **GIVEN** a store whose content is referenced by at least one farm
- **WHEN** reclamation runs
- **THEN** referenced content is retained and only unreferenced content is removed

#### Scenario: Reclamation is never implicit

- **WHEN** any command other than the reclamation command runs
- **THEN** no store content is removed

#### Scenario: Reclamation waits for live flights

- **GIVEN** a live acquisition flight
- **WHEN** reclamation runs
- **THEN** it waits for the flight to finish, and it deletes nothing the flight wrote

#### Scenario: Each farm reports its analysis and its tracks

- **GIVEN** a store holding the template farm and two analysis farms
- **WHEN** the user inspects the store
- **THEN** the output names the analysis of each analysis farm, marks the template, and names the track set of each

#### Scenario: The listing reports a live transfer

- **WHEN** `inflexa store ls` runs during a transfer
- **THEN** the output names the state and the byte totals, and it prompts for nothing

#### Scenario: The listing reports a failure and its retry

- **GIVEN** a download state of `failed`
- **WHEN** `inflexa store ls` runs
- **THEN** the output names the state, reports the message, and names `inflexa store download`

#### Scenario: The listing reports an available update

- **GIVEN** a recorded resolve whose digest differs from the digest that the receipt pins
- **WHEN** `inflexa store ls` runs
- **THEN** the output says that an update is available, names `inflexa store download --update`, and opens no prompt

#### Scenario: A moved tag that no resolve saw reports no update

- **GIVEN** a receipt that matches the last recorded resolve, and a tag that moved after that resolve
- **WHEN** `inflexa store ls` runs
- **THEN** the output reports no update, and the listing opens no network call

#### Scenario: A store with no download row is reported plainly

- **GIVEN** a complete store root that a manual pull made, and no download row
- **WHEN** `inflexa store ls` runs
- **THEN** the output reports the farms and says that no download ran

### Requirement: Only an install starts the provisioner container

The CLI MUST start the provisioner container only for an operation that installs
packages or mutates the store under the store lock. Four operations MUST be
host filesystem actions the CLI does directly, with no container: the read of the
store, the list of what the store holds, the preview of a reclamation, and the
composition of a farm.

The provisioner image is large, so a container start is a real cost. A read or a
link operation MUST NOT pay it.

#### Scenario: Listing starts no container

- **WHEN** `inflexa store ls` runs
- **THEN** it reads the store on the host and starts no container

#### Scenario: Composing a farm starts no container

- **WHEN** composition makes or extends a farm
- **THEN** it links on the host and starts no container

#### Scenario: A reclaim preview starts no container

- **WHEN** the CLI reports what a reclamation would remove
- **THEN** it computes the set on the host and starts no container

#### Scenario: An install starts the container

- **WHEN** `inflexa store add <spec>` runs
- **THEN** the provisioner container starts with a network, and it installs the closure

### Requirement: `inflexa store add` refuses while a download is live

`inflexa store add` MUST refuse while a store download is live. The command MUST name the live download, and it MUST
name the command that reports the progress. It MUST write nothing to the store
root.

The published artifact is not one blob. It is a set of layers. The CLI extracts
them into a staged root. It then merges that staged root into the store root one
child at a time. A provisioning run that writes into the same pool during the
merge can meet a half-merged store root.

The refusal MUST key on a live lock holder. A run is live when the row reports
`pending` or `running`, and a process holds the download lock. A row of `running`
with no live holder reads as `failed`, thus a dead downloader MUST NOT refuse the
command.

A `pending` row carries no holder until the child takes the lock. That window
starts no merge, because the merge comes after the transfer. Thus the window is
safe, and a provisioning run inside it meets no half-merged store root. A
`pending` row also shows nothing about the health of the starter. As a result, a
refusal on the row alone would block the command with no transfer in flight.

#### Scenario: A live download refuses the provisioning run

- **GIVEN** a live store download
- **WHEN** `inflexa store add <spec>` runs
- **THEN** the command refuses, names the live download, and writes nothing to the store root

#### Scenario: A dead downloader does not refuse the provisioning run

- **GIVEN** a row that reports `running`, whose holder process is gone
- **WHEN** `inflexa store add <spec>` runs
- **THEN** the state reads as `failed`, and the command runs

#### Scenario: A pending row with no holder does not refuse the provisioning run

- **GIVEN** a row that reports `pending`, and no holder of the download lock
- **WHEN** `inflexa store add <spec>` runs
- **THEN** the command runs, because no merge starts before the child takes the lock

## ADDED Requirements

### Requirement: `inflexa store add` is acquisition with single-flight dedup

`inflexa store add` MUST acquire into the pool and append to the dependency graph. It MUST take an optional analysis, through an `--analysis` flag. With no flag it does pool work only. With the flag it also links the acquired closure into the farm of that analysis.

Concurrent adds MUST dedup per flight key, which is the normalized spec: the ecosystem, the canonical name, and the specifier. The key MUST join the three with `::`. Neither ecosystem permits a colon in a package name: a normalized Python name is lower-case letters, digits, and the hyphen, and an R name is letters, digits, and the dot. Thus the first two occurrences of `::` are always the separators, whatever the specifier holds after them. The key MUST NOT hold a control character, because a source file that carries one reads as binary to the ordinary text tools.

One live flight MUST exist per key. A request for a key with a live flight subscribes to that flight and reports its progress as its own.

A subscription belongs to an analysis. A cancel MUST remove one subscription. The flight MUST stop when no subscription remains. A finished flight is not a cache: a failed flight clears, and a later request for the key starts fresh.

Flights for different keys MUST run concurrently, under a configured concurrency cap. The default cap is 2, because an R source compile can exhaust memory.

Each flight MUST live in one DB row with named states, in the shape of the detached download lifecycle. The sidebar and `inflexa store ls` MUST report a live flight from that row.

On success, each caller MUST extend its own farm with the acquired closure, through composition. The owner of the flight MUST NOT extend the farm of another caller. An owner that dies between the acquisition and the extension would otherwise leave a subscriber short. The row that named the subscribers is gone by then. Each caller already knows its own analysis, thus no subscriber list is necessary.

#### Scenario: Two identical requests share one flight

- **GIVEN** a live flight for a spec
- **WHEN** a second analysis requests the same spec
- **THEN** no second container starts, the second analysis subscribes, and both report the same progress

#### Scenario: Two different specs run in parallel

- **WHEN** two analyses request two different specs
- **THEN** two flights run concurrently, and neither waits for the other

#### Scenario: A cancel removes one subscription

- **GIVEN** a flight with two subscribed analyses
- **WHEN** one analysis cancels
- **THEN** the flight continues for the other, and the canceling analysis stops reporting it

#### Scenario: The last cancel stops the flight

- **GIVEN** a flight with one subscription
- **WHEN** that subscription cancels
- **THEN** the flight stops, and the pool keeps what content addressing already made safe

#### Scenario: Each caller extends its own farm

- **GIVEN** a flight with two subscribed analyses
- **WHEN** the flight succeeds
- **THEN** each caller extends the farm of its own analysis, and neither waits on the other to do it

#### Scenario: A dead owner leaves no subscriber short

- **GIVEN** a subscriber whose flight owner dies after a successful acquisition
- **WHEN** the subscriber observes that the flight ended
- **THEN** it extends its own farm from the pool, and the package resolves in its next sandbox

#### Scenario: An add with no analysis touches no farm

- **GIVEN** `inflexa store add` run in a terminal with no analysis
- **WHEN** the acquisition succeeds
- **THEN** the pool and the graph hold the package, and no farm changes

#### Scenario: The cap bounds concurrency

- **GIVEN** a concurrency cap of 2 and two live flights
- **WHEN** a third spec is requested
- **THEN** its flight queues, and it starts when a slot frees

### Requirement: `inflexa store link` links a package from the pool

The store command family MUST hold `inflexa store link <packages...>`. It MUST take an analysis, through a required `--analysis` flag. A call that names none MUST refuse, because a link with no farm has no meaning. It MUST link the named packages and their closure into the farm of that analysis, from the pool. It MUST NOT acquire, thus it starts no container and it opens no network connection.

`link` MUST be a subcommand of its own, and it MUST NOT be a flag on `store add`. An option must never change the effect class of a command. A flag that turned an acquisition into a link would classify two effects under one policy.

`link` MUST carry the `auto` agent policy. It writes symlinks only, into a farm that the analysis already owns, from packages that the user already consented to. Thus the consent that `add` takes covers it, and a second prompt would interrupt a run for nothing.

A package MUST take an optional version, in the form of a requirement, for example `polars==1.2`. A request with no version MUST take the head of the version ordering that the graph records. A request with a version MUST take the match, or it MUST refuse and name the versions that the pool holds.

`link` MUST refuse a package that the pool does not hold. The refusal MUST name the package, and it MUST say that an acquisition is the work of `store add`. For an R package the refusal MUST also say that this store acquires none, thus no retry succeeds.

#### Scenario: A pooled package links into the farm

- **GIVEN** an analysis whose farm lacks a package that the pool holds
- **WHEN** `inflexa store link` names it
- **THEN** the farm links it and its closure, no container starts, and no prompt appears

#### Scenario: A request with no version takes the newest

- **GIVEN** a pool that holds two versions of one distribution
- **WHEN** `inflexa store link` names it with no version
- **THEN** the farm links the newest of the two

#### Scenario: A package the pool does not hold refuses

- **GIVEN** a package that the pool does not hold
- **WHEN** `inflexa store link` names it
- **THEN** it refuses, names the package, and says that `store add` acquires one

#### Scenario: An R package names its own refusal

- **GIVEN** an R package that the catalog does not carry
- **WHEN** `inflexa store link` names it
- **THEN** it refuses and says that this store acquires no R package, thus no retry succeeds

### Requirement: A stale active-farm pointer is removed on first use

The first store command after the upgrade MUST remove a `current` symlink at the store root, when one exists. The removal MUST be idempotent and silent when nothing is there. No farm MUST be rebuilt, because no farm link involves the pointer.

#### Scenario: The stale pointer is removed once

- **GIVEN** a store root with a `current` symlink from the old layout
- **WHEN** any store command runs
- **THEN** the symlink is removed, the farms are untouched, and a second run changes nothing

## REMOVED Requirements

### Requirement: `inflexa store use <farm>` switches the active farm

**Reason**: No active farm exists at the store level. Each sandbox mounts the farm of its analysis, thus nothing remains for the command to switch.
**Migration**: Composition selects per analysis. The template's requested set is the default closure of each new farm.

### Requirement: A download that adds an unreachable farm names the remedy

**Reason**: A downloaded farm was unreachable because `current` did not select it. With no pointer, the catalog farm arrives as the template, and composition reaches it for every analysis.
**Migration**: None. The condition cannot occur in the new layout.
