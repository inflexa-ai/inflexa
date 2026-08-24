## MODIFIED Requirements

### Requirement: Data-profiler orients via workspace tools, not cd and ls

The `data-profiler` agent prompt SHALL orient from the menu carried in its briefing —
the detected sets with their slots and value samples, the quarantine summary, and the
leftover aggregate (see the input-scan-manifest spec) — rather than by enumerating the
tree itself, and where it does need to explore it SHALL use the workspace tools rather
than shelling out with `cd`/`ls`.

The menu is the orientation pass. It is produced deterministically before the agent's
first turn, so an agent that began by listing the tree would spend turns rediscovering
what it was handed. The prompt SHALL frame the agent's job as operating on the menu —
use, split, merge, group — plus reading the small number of files that resolve meaning:
metadata sheets, one example member per set, the leftovers.

For exploration beyond the menu the prompt SHALL direct the agent to `scan_inputs` with
a path to re-scan a subtree — stating that a re-scan informs judgement but operations
address the menu — or to `list_files`, recursing by calling it again on a subdirectory
it returned.

#### Scenario: Data-profiler orientation uses the menu

- **WHEN** the data-profiler prompt is read
- **THEN** it directs the agent to orient from the menu in its briefing
- **AND** it does not direct the agent to enumerate the input tree as its orientation pass

#### Scenario: Exploration beyond the menu uses workspace tools

- **WHEN** the data-profiler prompt directs exploration beyond the menu
- **THEN** it names `scan_inputs` with a path, or `list_files`
- **AND** it states that operations address the menu, not a re-scan's output

## ADDED Requirements

### Requirement: The prompt carries the substrate test and the category defaults

The `data-profiler` prompt SHALL carry the substrate test verbatim as the rule governing
split-versus-dimension decisions:

> Would a downstream step typically consume one value's files as a different substrate
> than another's?

Yes — split the set into groups. No — the values are variants of the same substrate:
keep the slot, bound to a dimension where it evidences one. Identity slots
(high-cardinality identifiers) are never split.

The prompt SHALL state that each vocabulary category carries a default treatment
(split-worthy or dimension-only), that the agent follows the default, and that deviating
requires a stated reason recorded with the group. The prompt SHALL require a stated
reason for every split, merge, and category assignment — the reasons are the audit
currency for decisions no deterministic check can validate.

#### Scenario: The test appears verbatim

- **WHEN** the data-profiler prompt is read
- **THEN** it SHALL contain the substrate test verbatim
- **AND** SHALL present the per-category default treatments from the shipped vocabulary

#### Scenario: A deviation carries its reason

- **WHEN** the agent departs from a category's default treatment
- **THEN** the prompt SHALL require the deviation's reason in the submission

### Requirement: The prompt probes the standard dimensions without forcing them

The prompt SHALL direct the agent to probe each entry of the shipped probe list —
subject, sample, condition/arm, timepoint, batch — and to record one of the explicit
outcomes: found (with observations), not found after looking (naming the searched files
and the reason), found but constant (an identity fact, not a dimension), or attested
(described in metadata but not evidenced in files). A probe's search SHALL name a
bounded, non-trivial searched set — the plausible metadata carriers, not one arbitrary
file.

The prompt SHALL state plainly that an empty or not-found answer is a correct and
complete answer. It SHALL NOT instruct the agent to apply every vocabulary category, and
dimensions off the probe list SHALL be recorded only when encountered during normal
orientation reading — no exhaustive column hunts.

#### Scenario: Every probe gets an outcome

- **WHEN** the agent submits its profile
- **THEN** each probe-list entry SHALL carry one of the four outcomes

#### Scenario: Not-found names its search

- **GIVEN** a dataset with no discernible timepoint
- **WHEN** the agent records the timepoint probe
- **THEN** the outcome SHALL be not-found with the searched files and reason
- **AND** SHALL NOT be an invented dimension

#### Scenario: The catalogue is not a checklist

- **WHEN** the data-profiler prompt is read
- **THEN** it SHALL NOT instruct the agent to find a dimension for every vocabulary category
