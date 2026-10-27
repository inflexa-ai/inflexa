## MODIFIED Requirements

### Requirement: The harness launches a stored plan through one function

The harness MUST give a function that launches the run of one stored plan. It takes a session with an analysis scope, the plan id, and an optional newest run id. It gives the run id and a `started` flag, or a typed refusal. The function MUST NOT throw for any outcome below.

The newest run id is the newest run of the plan that the caller saw, or `null` when the caller saw no run. The newest run of a plan is its run with the latest start. The run id breaks a tie of start times, highest first. A host read of the plan gives its run ids in this order.

The function MUST do these steps in this order:

1. Read the plan under the analysis of the session. An unknown plan, or a plan of a different analysis, gives `plan_not_found`.
2. Parse and validate the plan. A plan that fails the stored plan schema or the plan validation gives `plan_invalid`, with the errors of the validation.
3. When the caller gives a newest run id, read the newest run of the plan. A newest run that is not the given run gives that newest run with `started: false`. A plan with no run, and a given run id that is not `null`, gives `run_not_found` with the given run id. In each of these cases the function links nothing, reserves nothing, and authorizes nothing.
4. Read the active run of the plan. When one exists, give its run id with `started: false`. The function then links nothing, reserves nothing, and authorizes nothing.
5. Link the packages of the plan through the farm link function of the host, when the host gives one. A pool miss, a collision, or an unavailable store gives `packages_missing`, with the missing entries, the collisions, and the reason of an unavailable store. No run row exists after this refusal.
6. Reserve a run row with a new run id, the plan id, and the thread id of the scope. The lock of the plan holds the reservation, as the next paragraph tells. A collision with a concurrent launch of the same plan gives the active run with `started: false`. When the collision finds no active run, the function gives `store_failed`.
7. Authorize the run. A refusal marks the run `failed`. A refusal with the suspend flag gives `suspended` with the reason, and it does not mark the analysis. Each other refusal gives `not_authorized` with the reason. A failed write of the run status does not change the refusal.
8. Start the workflow under the run id. A failed start revokes the authorization, marks the run `failed`, and gives `launch_failed`. A failed write of the run status does not change this refusal either.
9. Give the run id with `started: true`.

Each reservation of a stored plan MUST hold a lock of the plan, from its read of the newest run to its commit. Thus the reservations of one plan occur one after the other. Under the lock, the reservation reads the newest run of the plan. When the caller gives a newest run id, a mismatch reserves nothing, and it gives the outcome of step 3.

The new row MUST get a start time that is later than the start of that newest run. Thus the new row becomes the newest run of the plan, also when the clock of a different host is ahead. As a result, one view of a plan never starts two runs.

When the caller gives no newest run id, the function MUST NOT compare a run. Step 3 then does nothing, and the reservation compares nothing. The reservation still holds the lock, and the new row still gets a later start time.

A failed store read or write gives `store_failed`. The function emits no chat part.

#### Scenario: A launch starts the run of a stored plan

- **GIVEN** a valid stored plan `pln-0000000a` of analysis `a1`, with no active run
- **WHEN** a host launches `pln-0000000a` under a session of `a1` and thread `t1`
- **THEN** the result has a new run id and `started: true`
- **AND** the run row holds the plan id and the thread id `t1`

#### Scenario: A plan with an active run starts no second run

- **GIVEN** plan `pln-0000000a` with the active run `r1`
- **WHEN** a host launches `pln-0000000a`
- **THEN** the result has the run id `r1` and `started: false`, and no new run row exists

#### Scenario: A stale view starts no run

- **GIVEN** plan `pln-0000000a` with the run `r1`, which ended
- **WHEN** a host launches `pln-0000000a` with the newest run id `null`
- **THEN** the result has the run id `r1` and `started: false`
- **AND** no new run row exists, and the farm link function receives no call

#### Scenario: The newest run lets a deliberate run again start

- **GIVEN** plan `pln-0000000a` with the run `r1`, which ended
- **WHEN** a host launches `pln-0000000a` with the newest run id `r1`
- **THEN** the result has a new run id and `started: true`

#### Scenario: A view of a run that the plan does not have is refused

- **GIVEN** plan `pln-0000000a` with no run
- **WHEN** a host launches `pln-0000000a` with the newest run id `r9`
- **THEN** the result is the refusal `run_not_found` with the run id `r9`, and no run row exists

#### Scenario: A run that starts during the link pass makes the view stale

- **GIVEN** plan `pln-0000000a` with no run
- **AND** a farm link function that makes the run `r2` of the plan, and ends it, before it returns
- **WHEN** a host launches `pln-0000000a` with the newest run id `null`
- **THEN** the result has the run id `r2` and `started: false`, and `r2` is the only run row of the plan

#### Scenario: Two launches with one view start one run

- **GIVEN** plan `pln-0000000a` with no run
- **AND** a launch with the newest run id `null` that holds the lock of the plan before its insert
- **WHEN** a second launch of `pln-0000000a` with the newest run id `null` reaches its reservation
- **THEN** the second launch waits for the lock, and it gives the run of the first launch with `started: false`
- **AND** the plan has one run row

#### Scenario: A new run is the newest run of the plan when a clock is ahead

- **GIVEN** plan `pln-0000000a` with the run `r1`, which ended, and whose start is later than the clock of the host
- **WHEN** a host launches `pln-0000000a` with the newest run id `r1`
- **THEN** the result has a new run id and `started: true`
- **AND** the start of the new run is later than the start of `r1`, and the newest run of the plan is the new run

#### Scenario: A launch with no newest run id compares nothing

- **GIVEN** plan `pln-0000000a` with the run `r1`, which ended
- **WHEN** a host launches `pln-0000000a` with no newest run id
- **THEN** the result has a new run id and `started: true`

#### Scenario: An unknown plan is refused

- **WHEN** a host launches a plan id that analysis `a1` does not hold
- **THEN** the result is the refusal `plan_not_found`, and no run row exists

#### Scenario: A package miss leaves no run behind

- **GIVEN** a plan whose package the pool does not hold
- **WHEN** a host launches the plan
- **THEN** the result is the refusal `packages_missing` with the missing entry, and no run row exists

#### Scenario: A refused authorization ends the reserved run

- **GIVEN** a run authorizer that refuses the run with a reason that is not a suspension
- **WHEN** a host launches the plan
- **THEN** the result is the refusal `not_authorized` with the reason, and the run row is `failed`

#### Scenario: A refused authorization with a suspension ends the reserved run

- **GIVEN** a run authorizer that refuses the run with the reason `payment_required` and the suspend flag
- **WHEN** a host launches the plan
- **THEN** the result is the refusal `suspended` with the reason `payment_required`, and the run row is `failed`
- **AND** the status of the analysis does not change
