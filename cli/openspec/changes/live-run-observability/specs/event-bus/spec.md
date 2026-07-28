## ADDED Requirements

### Requirement: Run observation is its own event family on the single bus

`BusEvent` SHALL carry a `run.*` family describing an analysis run's observed state, distinct
from the `prov.*` provenance family. Both SHALL travel on the one shared bus, separated by type
string — no second bus instance SHALL be introduced.

The two families SHALL remain independent: a `run.*` member SHALL NOT be derived from, aliased
to, or emitted as a side effect of a `prov.*` member, and a subscriber to one SHALL be able to
ignore the other entirely. Provenance events close a signed, hash-chained record written under a
single-writer instance lock; run observation is a lossy-tolerant channel that drives presentation.
Overloading one family with the other's job would couple a repaint to the chain's write discipline
and force provenance to record step names and agent identities it has no reason to hold.

Each `run.*` member SHALL carry exactly the fields its own action needs, following the existing
one-event-per-domain-action rule — never one member discriminated by an interior field with
nullable companions.

#### Scenario: Run and provenance events are separately subscribable

- **WHEN** a subscriber handles only `run.*` events
- **THEN** it observes run state without receiving or depending on any `prov.*` event, and the provenance recorder is unaffected

#### Scenario: There is still one bus

- **WHEN** the run family is added
- **THEN** it is published and subscribed through the same single `Bus` instance as every other event

### Requirement: Run events originate from an injected harness callback

`run.*` events SHALL be produced by realizing the harness's run-observation callback at the
embedder's composition root — the same arrangement by which the provenance emitter is supplied.
The CLI SHALL NOT subscribe to any event channel owned by the harness; the harness has none, and
the boundary is a callback the host injects and adapts onto its own bus.

Because the harness re-invokes that callback after a durable-runtime recovery, a subscriber taking
a durable or user-visible action SHALL key it by run id and observed status. A subscriber that only
renders SHALL NOT need such keying.

#### Scenario: Events reach the bus through the composition root

- **WHEN** a run's state changes inside the embedded runtime
- **THEN** the injected callback fires and the corresponding `run.*` event is published on the CLI bus

#### Scenario: Re-delivery does not double a durable reaction

- **WHEN** the runtime recovers and re-invokes the callback for a run it already reported
- **THEN** subscribers that take durable actions recognise the repeat by run id and status and do not repeat them

#### Scenario: Events are in-process only

- **WHEN** a run is launched by a separate process rather than inside the running app
- **THEN** no `run.*` event is observed, and the sidebar's polling backstop remains the path by which that run becomes visible
