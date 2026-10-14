# Spec Delta

## ADDED Requirements

### Requirement: The plan approval is core format

The core union MUST carry the member `plan_approved`. Its payload is the approval ref: the thread id, the plan id, the run id that the approval started, and `approvedAtMs`, the epoch time of the approval in milliseconds. The member names no model, because a person approves and no model drives the act.

The mapping MUST append these statements:

- one action activity of the type `inflexa:ApprovePlan`, with a minted action id
- the start time and the end time of the activity, both from `approvedAtMs` and not from the model clock
- the attributes `inflexa:threadId`, `inflexa:planId`, and `inflexa:runId` on the activity
- an anonymous `wasAssociatedWith` from the activity to the actor agent
- a `wasInformedBy` from the run activity of the run id to the approval activity, with the id `inflexa:informed-approval-{runId}`

The time comes from the payload, because a host can deliver the approval after the `run_started` of its run. The approval time is read before the launch, thus the document places the approval before the start of the run.

`SPEC.md` MUST state the member, and the golden fixture MUST cover it.

#### Scenario: An approval names its plan, its run, and its person

- **WHEN** `applyProvEvent` maps a `plan_approved` with a user actor, plan `pln-0000000a`, and run `r1`
- **THEN** the document holds an `inflexa:ApprovePlan` activity with the plan id, the run id, and the thread id
- **AND** the activity is associated with the user agent, and with no model agent

#### Scenario: The approval comes before the run start

- **GIVEN** a `plan_approved` for run `r1` at `approvedAtMs` 1000, and a `run_started` for `r1` at `startedAtMs` 2000
- **WHEN** the two events reach the document in the order `run_started`, then `plan_approved`
- **THEN** the approval activity has the start time of 1000, and the run activity has the start time of 2000
- **AND** a `wasInformedBy` edge goes from the run activity to the approval activity
