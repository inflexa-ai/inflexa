## MODIFIED Requirements

### Requirement: The launch refusal classifies each missing package

A launch whose plan packages cannot link MUST refuse before the run
reserves anything — the harness link pass is that gate. The remedy text of
the refusal MUST classify each missing name against the host rows. A name
with a pending add or a live flight reads as in flight, with "launch again
when it lands". A name with a failed row carries the recorded reason, with
the retry and the delete remedies. An unknown name carries the store-add
ask. When the resolution carries a suggestion, the unknown-name remedy MUST
name it before the store-add ask, because the pool holds the package under
that spelling. Thus the agent replans from the true state, and no run is
wasted on a package that never landed.

A version collision MUST name the two store directories and the closure
members that pull each side. The dependent is the remedy surface: the fix
is to drop or re-pin a dependent, and a bare name makes the reader guess
it. A two-track collision MUST name the two store directories with their
tracks, and the two prefixed forms `python:<name>` and `r:<name>`. The
prefix is the remedy, thus the refusal names it. An unreadable dependency
graph MUST refuse as one store-level reason, never as a per-package
absence. A false absence sends the agent after packages the pool holds,
and it hides the structural fault.

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
- **THEN** the refusal names the two store directories with their tracks, `python:igraph`, and `r:igraph`

#### Scenario: A folded R spelling names its suggestion

- **GIVEN** a plan that names `seurat`, against a pool that holds `Seurat` in the R track only
- **WHEN** the launch refuses on the pool miss
- **THEN** the remedy names `Seurat` before the store-add ask
