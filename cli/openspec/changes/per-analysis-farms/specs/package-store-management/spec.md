# package-store-management Delta — Per-Analysis Farms

## MODIFIED Requirements

### Requirement: The store can be inspected and reclaimed

The CLI SHALL report what a store holds — its packages, the farms defined against it, and the disk each occupies. It SHALL give a way to remove a farm, and a way to remove store content that no farm references. Reclamation SHALL never run implicitly as a side effect of another command.

The inspection SHALL name the analysis of each analysis farm, and it SHALL mark the catalog template farm as the template. It SHALL say which tracks each farm carries. A farm with fewer tracks than another is the reason an import fails in one analysis and not in another.

The inspection SHALL report the state of the download beside the farms. It SHALL
name the state, and it SHALL name the bytes transferred and the total bytes while
a transfer runs. When the state is `failed`, it SHALL report the message and it
SHALL name `inflexa store download` as the retry. When the state is `canceled`, it SHALL
say that the user stopped the transfer, and it SHALL name the same retry. When no
row exists, it SHALL say that no download ran, because a store can arrive by a
route that wrote no row.

The inspection SHALL report a live acquisition flight beside the download: the spec of the flight, its state, and the analyses subscribed to it.

The inspection SHALL report an available update when the recorded resolve differs
from the receipt. The row records the digest of the last resolve, and the receipt
pins the digest that is installed. The inspection SHALL name `inflexa store
download --update`, and it SHALL open no prompt. The user owns that decision.

A resolve happens only when `inflexa store download` or `inflexa setup` runs.
`inflexa store ls` stays local, and it opens no network call. Thus the two
surfaces report no update between a moved tag and the next resolve. The sidebar
obeys the same rule, because it reads the same two records.

The inspection command SHALL stay prompt-free and SHALL gain no option, because a
passive diagnostic stays passive. A new option on an `auto` command is unsafe
until the user says otherwise.

Reclamation SHALL be exclusive against live acquisition flights: it waits for zero flights and blocks new ones while it scans and deletes. Before it frees pool content, it SHALL run the orphan-farm reaper, which removes a farm whose analysis id is not in the DB.

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

The CLI SHALL start the provisioner container only for an operation that installs
packages or mutates the store under the store lock. Four operations SHALL be
host filesystem actions the CLI does directly, with no container: the read of the
store, the list of what the store holds, the preview of a reclamation, and the
composition of a farm.

The provisioner image is large, so a container start is a real cost. A read or a
link operation SHALL NOT pay it.

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

`inflexa store add` SHALL refuse while a store download is live. The command SHALL name the live download, and it SHALL
name the command that reports the progress. It SHALL write nothing to the store
root.

The published artifact is not one blob. It is a set of layers. The CLI extracts
them into a staged root. It then merges that staged root into the store root one
child at a time. A provisioning run that writes into the same pool during the
merge can meet a half-merged store root.

The refusal SHALL key on a live lock holder. A run is live when the row reports
`pending` or `running`, and a process holds the download lock. A row of `running`
with no live holder reads as `failed`, thus a dead downloader SHALL NOT refuse the
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

`inflexa store add` SHALL acquire into the pool and append to the dependency graph. It SHALL do no farm work. The farm of an analysis changes only through composition.

Concurrent adds SHALL dedup per flight key, which is the normalized spec: the ecosystem, the canonical name, and the specifier. One live flight SHALL exist per key. A request for a key with a live flight subscribes to that flight and reports its progress as its own.

A subscription belongs to an analysis. A cancel SHALL remove one subscription. The flight SHALL stop when no subscription remains. A finished flight is not a cache: a failed flight clears, and a later request for the key starts fresh.

Flights for different keys SHALL run concurrently, under a configured concurrency cap. The default cap is 2, because an R source compile can exhaust memory.

Each flight SHALL live in one DB row with named states, in the shape of the detached download lifecycle. The sidebar and `inflexa store ls` SHALL report a live flight from that row.

On success, the flight SHALL extend the farm of each subscribing analysis with the acquired closure, through composition.

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

#### Scenario: Success extends each subscriber's farm

- **GIVEN** a flight with two subscribed analyses
- **WHEN** the flight succeeds
- **THEN** composition extends the farm of each subscriber with the acquired closure

#### Scenario: The cap bounds concurrency

- **GIVEN** a concurrency cap of 2 and two live flights
- **WHEN** a third spec is requested
- **THEN** its flight queues, and it starts when a slot frees

### Requirement: A stale active-farm pointer is removed on first use

The first store command after the upgrade SHALL remove a `current` symlink at the store root, when one exists. The removal SHALL be idempotent and silent when nothing is there. No farm SHALL be rebuilt, because no farm link involves the pointer.

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
