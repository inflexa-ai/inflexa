## MODIFIED Requirements

### Requirement: The harness owns the ordered boot sequence

`bootHarness` (`runtime/boot.ts`) MUST be the harness-owned boot sequence that
wraps `assembleCoreRuntime` with the effectful, order-dependent boot steps, and
MUST return a `{ runtime, shutdown }` handle. `assembleCoreRuntime` MUST stay
synchronous and pure (registration only). The steps MUST run cheapest-failure
first, in this order:

1. injected telemetry init (default no-op, so a library host acquires no
   process-wide telemetry it did not ask for),
2. `initCortexState(pool)`,
3. `assertConnectionBudget(...)`,
4. `assembleCoreRuntime(core)`,
5. an optional embedder `beforeLaunch()` hook (host-specific pre-launch work —
   scheduled sweeps, an ephemeral reap, an agent-switch install — that must
   attach before DBOS launch re-emits events),
6. `launchDbos(...)`,
7. `reconcileOrphanedRuns(pool)`.

The boot MUST NOT read the agent catalog and MUST NOT validate skills. A
defect of the built-in content fails a CI test, and custom content never
stops the boot (refer to the `agent-catalog` and `skill-store` capabilities).

Boot-step failures MUST propagate to the caller (the embedder's composition
root releases whatever it acquired). Only `shutdown` swallows per-step failures.
The repair of step 7 is the exception: a failure MUST be logged and MUST NOT
stop the boot, because the repair only frees the slot of a plan.

`reconcileOrphanedRuns` MUST set `failed` on each `running` run that started
more than `ORPHANED_RUN_GRACE_MS` (5 minutes) ago and that has no
`dbos.workflow_status` row. Such a run reserved its row, but its workflow never
started. Thus nothing will ever settle it, and it holds the active-plan slot of
its plan. A run whose workflow row exists, also a terminal one, MUST stay with
its workflow. The grace keeps a launch that is between its reservation and its
workflow start from being failed.

#### Scenario: A run whose workflow never started is failed at boot

- **GIVEN** a `running` run that started 10 minutes ago and has no workflow row
- **WHEN** the harness boots
- **THEN** the run is `failed`, and a new launch of its plan can reserve a run

#### Scenario: Skills are validated before launch

- **GIVEN** a built-in pack with no readable `SKILL.md`
- **WHEN** the CI test of the built-in content runs before a release
- **THEN** the test fails, and no release with that pack launches

#### Scenario: A catalog with a gap does not stop the boot

- **GIVEN** a catalog whose custom executor attaches a skill that the `SkillStore` does not list
- **WHEN** the harness boots
- **THEN** the boot completes

#### Scenario: The embedder hook runs after registration and before launch

- **GIVEN** a `beforeLaunch` hook is supplied
- **WHEN** `bootHarness` runs to launch
- **THEN** `beforeLaunch` MUST run after `assembleCoreRuntime` registers the workflow cohort and before `launchDbos`
