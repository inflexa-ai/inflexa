## ADDED Requirements

### Requirement: The store publishes the data profile as live progress

The store SHALL publish a live-progress entry for a **running** data profile, alongside
the per-run entries it already publishes. The entry SHALL carry what a profile has — an
identity, its start time, the workflow id its ledger row records, and whether
the entry is stale — and SHALL NOT carry completion counts or step views, because a profile has
no step decomposition. It SHALL NOT carry a display name: there is one profile per analysis and
it is always the same operation, so the name is a constant belonging to the render rather than a
fact the ledger supplies.

The refresh SHALL remain the single writer. The profile entry SHALL be built inside the same
generation-token guard as the run entries, from the profile row the refresh already reads, so no
second reader and no second staleness rule is introduced.

A `pending` profile SHALL NOT be published. The ledger writes the profile's start time only on
the transitions into `running`, so a pending row carries none — and a pending profile has no
workflow, so it has no stream and nothing reported. Publishing it would yield an entry that is a
name beside two blanks. `pending` means seeded and queued, and this entry describes work in
flight.

This SHALL NOT change the poll's arming condition, which counts a pending profile as active work.
That governs whether to keep looking, not whether there is anything to show.

A profile that reaches a terminal state SHALL have its entry removed on the next refresh.

The entry SHALL NOT replace or alter the per-run entries the RUNS section consumes. The rail's
data is unchanged by this requirement.

#### Scenario: A running profile publishes an entry

- **WHEN** a refresh reads a profile row in the `running` state
- **THEN** a profile progress entry is published carrying its start time and recorded workflow id

#### Scenario: A pending profile publishes no entry

- **WHEN** a refresh reads a profile row in the `pending` state
- **THEN** no profile progress entry is published
- **AND** the poll remains armed, because a pending profile is still active work

#### Scenario: A terminal profile's entry clears

- **WHEN** a profile reaches `completed` or `failed`
- **THEN** the next refresh removes its progress entry

#### Scenario: A profile with no recorded workflow id still publishes

- **WHEN** a refresh reads a running profile row whose workflow id is not yet recorded
- **THEN** an entry is published with no workflow id, rather than being withheld

#### Scenario: The rail's run data is unaffected

- **WHEN** a profile entry is published
- **THEN** the per-run progress entries the RUNS section reads are unchanged

### Requirement: A failed profile read carries the profile entry forward

When the read behind the profile entry fails, the refresh SHALL carry the previous entry forward
and mark it stale rather than dropping it — the same treatment a run whose step read blipped
already receives.

Without this, a transient database error would remove the profile entry entirely, because the
profile snapshot collapses to a single unavailable state on any read failure. A consumer would
then see the profile disappear and return, which is indistinguishable from the profile having
finished and a new one having started.

A carried-forward entry SHALL be marked stale so a consumer can render it as last-known rather
than current. The staleness SHALL be re-stamped on the transition into stale, so an entry that
read cleanly on the previous refresh stops advertising itself as fresh.

#### Scenario: A blip does not remove the profile entry

- **GIVEN** a profile entry was published on the previous refresh
- **WHEN** the profile read fails on the next refresh
- **THEN** the previous entry is carried forward and marked stale

#### Scenario: A recovered read clears staleness

- **GIVEN** a profile entry is carried forward and marked stale
- **WHEN** a later refresh reads the profile successfully
- **THEN** the entry is republished from the fresh read and is no longer marked stale

### Requirement: Live subjects are published in an order that never displaces a run

The store SHALL expose the active runs and the active profile as one ordered set of subjects, with
every run ahead of the profile. Run order within the set SHALL remain the existing newest-first
order.

Ordering by kind is a deliberate departure from the recency ordering used everywhere else in this
module, and the reason is provenance rather than recency: a profile is auto-triggered when a chat
opens on drifted inputs, so it can enter the set without the user having asked for anything. A
recency-ordered set would routinely place such a profile first and displace a run the user launched
deliberately on whichever surface reads the set's head as its default focus.

The ordered set SHALL be derived from the published entries rather than written independently, so
it introduces no additional writer and no additional staleness rule.

#### Scenario: A profile sorts behind a run

- **GIVEN** one run and one profile are active
- **WHEN** the subject set is read
- **THEN** the run precedes the profile

#### Scenario: A profile triggered after a run does not take the head

- **GIVEN** a run is active
- **WHEN** a profile is triggered afterwards and becomes active
- **THEN** the run remains at the head of the subject set

#### Scenario: A profile alone is the only subject

- **GIVEN** no run is active and a profile is running
- **WHEN** the subject set is read
- **THEN** it contains the profile as its only entry

#### Scenario: Runs keep their newest-first order

- **GIVEN** two runs are active
- **WHEN** the subject set is read
- **THEN** they appear in the same newest-first order the run entries are published in, ahead of any profile
