# Spec Delta

## Purpose

The reads of a stored plan: the plan with its lineage, the run ids of a plan, the graph of its steps, and its `data-plan` card. A host draws a plan and its replacement with no replay of a stream.

## ADDED Requirements

### Requirement: The plan store reads one plan with its lineage

The harness MUST give a read of one stored plan by its plan id, scoped to one analysis. The read MUST give these fields:

- the plan id
- the stored plan document, as the store holds it
- the parent plan id, or `null` for a plan with no parent
- `supersededBy`: the id of the newest plan of the same analysis that names this plan as its parent, or `null` when no plan names it
- the creation time of the plan

The newest plan is the plan with the latest creation time. Equal creation times MUST order by the plan id, highest first. A plan of a different analysis MUST NOT count for `supersededBy`.

The read MUST give `null` for an unknown plan id and for a plan of a different analysis. Absence is not an error. The read MUST send one statement.

#### Scenario: A revised plan names the newer plan

- **GIVEN** plan `pln-0000000a` of analysis `a1`, and plan `pln-0000000b` of `a1` whose parent is `pln-0000000a`
- **WHEN** a host reads `pln-0000000a` under `a1`
- **THEN** `supersededBy` is `pln-0000000b`, and the parent is `null`

#### Scenario: The newest of two revisions wins

- **GIVEN** plan `pln-0000000a`, and two plans whose parent is `pln-0000000a`, made at different times
- **WHEN** a host reads `pln-0000000a`
- **THEN** `supersededBy` is the plan with the later creation time

#### Scenario: The revision gives its parent

- **WHEN** a host reads `pln-0000000b`, whose parent is `pln-0000000a`
- **THEN** the parent is `pln-0000000a`, and `supersededBy` is `null`

#### Scenario: A plan of a different analysis

- **WHEN** a host reads a plan of analysis `a2` under analysis `a1`
- **THEN** the read gives `null`

### Requirement: The run store gives the run ids of one plan

The harness MUST give a read of the run ids of one plan of one analysis. The ids MUST be in the order of the start time, newest first, and the run id MUST break a tie, highest first. The caller MUST give a limit, and the read MUST give at most that count of ids. A plan with no run MUST give an empty list. The read MUST send one statement.

#### Scenario: The runs of a plan, newest first

- **GIVEN** plan `p1` with runs `r1` and `r2`, where `r2` started later, and a run `r3` of a different plan
- **WHEN** a host reads the run ids of `p1` with the limit 10
- **THEN** the read gives `r2`, then `r1`

#### Scenario: The limit bounds the ids

- **GIVEN** plan `p1` with three runs
- **WHEN** a host reads the run ids of `p1` with the limit 2
- **THEN** the read gives the two newest run ids

### Requirement: An index serves each read by the parent of a plan and each read of the runs of a plan

A migration MUST index `cortex_plans` by `parent_plan_id`. Thus the `supersededBy` read uses the index. The check of the parent key, when a plan row goes away, also uses it. The same migration MUST index `cortex_runs` by the analysis id, the plan id, the start time newest first, and the run id. Thus the read of the run ids of a plan reads only the runs of that plan.

#### Scenario: A migrated database has the two indexes

- **WHEN** `initCortexState(pool)` runs against an empty database
- **THEN** an index of `cortex_plans` covers `parent_plan_id`
- **AND** an index of `cortex_runs` covers `analysis_id`, `plan_id`, and `started_at`
- **AND** `cortex_migration` records the new migration

### Requirement: The graph of a stored plan gives each step with its agent, its dependencies, and its level

The harness MUST give a pure function that takes a stored plan document and gives its graph. The graph MUST hold one entry for each step of the plan, in the order of the plan. Each entry MUST hold these fields:

- `id`, the step id
- `name`, the step name
- `agent`, the agent of the step, or `"unknown"` when the step names no agent
- `dependsOn`, the step ids that the step depends on
- `level`: 0 for a step with no dependency, else one more than the highest level of its dependencies

The `agent` fallback and the `level` MUST equal those of the `data-dag-state` part of a run of the same plan. The function MUST give `null` when the document fails the stored plan schema. A stored plan with an empty step list MUST give an empty graph. A document whose steps have a duplicate id, a missing dependency, or a cycle MUST also give `null`. The function MUST NOT throw.

#### Scenario: The levels of a diamond plan

- **GIVEN** a plan with `T1S1`, `T1S2` and `T2S1` that depend on `T1S1`, and `T1S3` that depends on `T1S2` and `T2S1`
- **WHEN** the function reads the plan
- **THEN** the levels are 0, 1, 1, and 2, in the order of the plan

#### Scenario: A step with no agent

- **GIVEN** a stored plan whose step names no agent
- **WHEN** the function reads the plan
- **THEN** the entry of that step has the agent `"unknown"`

#### Scenario: A plan with a cycle

- **GIVEN** a stored plan where `T1S1` depends on `T1S2` and `T1S2` depends on `T1S1`
- **WHEN** the function reads the plan
- **THEN** the function gives `null`

#### Scenario: A document that is not a plan

- **WHEN** the function reads a document with no `steps` field
- **THEN** the function gives `null`

#### Scenario: A plan with no step

- **WHEN** the function reads a stored plan whose step list is empty
- **THEN** the function gives an empty graph

### Requirement: The data-plan card names the parent of a revised plan

The `data-plan` part MUST have the optional field `parentPlanId`, with the plan id shape `pln-<8hex>`. The schema of the part MUST keep the field, thus the receipt check and the stored card hold it.

The plan card builder MUST set `parentPlanId` when the stored plan has a parent. It MUST omit the field when the plan has no parent. The stored card freezes the field, thus a reload shows the parent that the card showed.

#### Scenario: The card of a revision

- **GIVEN** plan `pln-0000000b`, whose parent is `pln-0000000a`
- **WHEN** `show_plan` shows `pln-0000000b`
- **THEN** the `data-plan` part has `parentPlanId` `pln-0000000a`
- **AND** the stored card of the turn has the same `parentPlanId`

#### Scenario: The card of a first plan

- **WHEN** `show_plan` shows a plan with no parent
- **THEN** the `data-plan` part has no `parentPlanId` key

### Requirement: A stored plan record gives its data-plan part

The harness MUST give a pure function that takes a stored plan record and gives its `data-plan` part. The part MUST hold the card that the plan card builder gives for the same plan, with its `type`. The title is the title of the plan, with no title override of `show_plan`. The part schema MUST accept it, and the part MUST hold only the fields that the schema keeps. The function MUST give `null` when the plan document does not parse, or when the part schema refuses the part.

#### Scenario: The part of a stored revision

- **GIVEN** the record of plan `pln-0000000b`, whose parent is `pln-0000000a`
- **WHEN** the function reads the record
- **THEN** the part has the type `data-plan`, the plan id, the steps, and `parentPlanId` `pln-0000000a`

#### Scenario: A plan that does not parse

- **GIVEN** a record whose document fails the stored plan schema
- **WHEN** the function reads the record
- **THEN** the function gives `null`

### Requirement: The package root exports the plan reads

The package root MUST export these names and the types of their values:

- the lineage read of a plan
- the run id read of a plan
- the graph function
- the part function

Thus an embedder reads a plan with no deep import.

#### Scenario: An embedder reads a plan from the root

- **WHEN** an embedder imports the lineage read and the graph function from `@inflexa-ai/harness`
- **THEN** the imports resolve, with the types of their values
