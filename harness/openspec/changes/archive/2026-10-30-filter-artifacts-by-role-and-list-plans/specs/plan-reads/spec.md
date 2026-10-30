## ADDED Requirements

### Requirement: The plan store gives a page of the plans of an analysis

The harness MUST give a paged read of the plans of one analysis. The read takes a `Querier`, an analysis id, a limit, and an offset. It MUST give the entries of one page and `total`. `total` is the exact count of the plans of the analysis.

Each entry MUST carry these fields:

- `planId`, the plan id
- `createdAt`, the creation time of the plan, as the store holds it
- `title`, the `title` of the stored plan document when it is a string, else `null`. The read gives the string as the document holds it.
- `parentPlanId`, the parent plan id, or `null` for a plan with no parent
- `supersededBy`, by the rule of the lineage read of one plan
- `newestRunId`, the id of the newest run of the plan, or `null` for a plan with no run. The newest run is the first run of the order of the run id read of a plan.

The entries MUST be in the order of the creation time, newest first. Equal creation times MUST order by the plan id, highest first. The read MUST give at most `limit` entries, from the position `offset` of the order.

A plan of a different analysis MUST NOT be an entry, and it MUST NOT count in `total`. A plan or a run of a different analysis MUST NOT count for `supersededBy` or for `newestRunId`. A plan whose document does not parse is an entry.

The read MUST send at most two statements, whatever the limit and the count of the plans. A failed query MUST ride the error channel as a `DbError`.

#### Scenario: The newest plan comes first

- **GIVEN** plan `pln-0000000a` of analysis `a1`, and plan `pln-0000000b` of `a1` that revised it later
- **WHEN** a host reads the page of `a1` with a limit of 10 and an offset of 0
- **THEN** the entries are `pln-0000000b`, then `pln-0000000a`, and `total` is 2
- **AND** `pln-0000000a` has `supersededBy` `pln-0000000b`, and `pln-0000000b` has `parentPlanId` `pln-0000000a`

#### Scenario: Equal creation times order by the plan id

- **GIVEN** plans `pln-0000000a` and `pln-0000000b` of `a1` with the same creation time
- **WHEN** a host reads the page of `a1`
- **THEN** `pln-0000000b` comes first

#### Scenario: The newest run of each plan

- **GIVEN** plan `p1` with runs `r1` and `r2`, where `r2` started later, and plan `p2` with no run
- **WHEN** a host reads the page of the analysis
- **THEN** `p1` has `newestRunId` `r2`, and `p2` has `newestRunId` `null`

#### Scenario: The title of a plan

- **GIVEN** a plan whose document has the title `Liver DE`, and a plan whose document has no title
- **WHEN** a host reads the page of the analysis
- **THEN** the first plan has the title `Liver DE`, and the second plan has the title `null`

#### Scenario: The pages of the plans

- **GIVEN** three plans of `a1`, made at different times
- **WHEN** a host reads the page of `a1` with a limit of 2 and an offset of 2
- **THEN** it gives one entry, the oldest plan, and `total` is 3
- **AND** a read with an offset of 4 gives no entry, and `total` is 3

#### Scenario: The plans of a different analysis stay out

- **GIVEN** plan `p1` of `a1`, and plan `p2` of `a2`
- **WHEN** a host reads the page of `a1`
- **THEN** it gives only `p1`, and `total` is 1

#### Scenario: The statement count does not grow with the page

- **WHEN** a host reads the page with a limit of 1, and again with a limit of 200
- **THEN** each read sends the same count of statements, and the count is at most 2

## MODIFIED Requirements

### Requirement: The package root exports the plan reads

The package root MUST export these names and the types of their values:

- the lineage read of a plan
- the run id read of a plan
- the page read of the plans of an analysis, with the types of its page and its entry
- the graph function
- the part function

Thus an embedder reads a plan with no deep import.

#### Scenario: An embedder reads a plan from the root

- **WHEN** an embedder imports the lineage read and the graph function from `@inflexa-ai/harness`
- **THEN** the imports resolve, with the types of their values

#### Scenario: An embedder lists the plans from the root

- **WHEN** an embedder imports the page read of the plans and its types from `@inflexa-ai/harness`
- **THEN** the imports resolve, with the types of their values
