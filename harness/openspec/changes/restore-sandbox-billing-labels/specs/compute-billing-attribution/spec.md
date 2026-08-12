## ADDED Requirements

### Requirement: Every K8s sandbox spawn path supplies billing attribution

Every code path that creates a K8s sandbox SHALL resolve billing attribution via the billing resolver seam (`ResolveBilling`) under the session it holds and populate `CreateSandboxMeta.billing = { billingContextId, userId }`:

1. **Analysis sandbox steps** (`src/workflows/sandbox-step.ts`): resolved under the step's session **inside the existing `sandbox.create` DBOS step** — the child workflow's step sequence is unchanged, so in-flight workflows resumed across a deploy replay cleanly. `userId` is the `RunSession`'s `identity.user`.
2. **Data-profile** (`src/tasks/data-profile.ts`): resolved under the profiling session at spawn time.

The billing-context id SHALL be read from the resolved header map's `X-Inflexa-Billing-Context` key. If resolution fails (or yields no `X-Inflexa-Billing-Context`), the spawn SHALL proceed with `billing` unset and an error-level `[billing]` log SHALL be emitted at the spawn site — billing failure never blocks sandbox work. Wirings without a resolver (dev/OSS) supply no `resolveBilling` dep and emit no logs.

#### Scenario: Analysis step resolves and stamps within sandbox.create

- **GIVEN** a sandbox step whose deps carry a billing resolver
- **WHEN** the `sandbox.create` step executes
- **THEN** the billing context is resolved under the step's session inside that step
- **AND** the spawned pod carries the resolved `cortex/billing-context` and the session user's `cortex/user-id`

#### Scenario: Data-profile pods are attributable without a run id

- **WHEN** the data-profile task spawns its sandbox
- **THEN** the pod carries `cortex/billing-context`, `cortex/user-id`, and `cortex/analysis-id` labels
- **AND** the metering reconciler meters the allocation per analysis via its one-off `Charge` path (the literal non-UUID run id routes there by design)

#### Scenario: Resolver outage degrades to unlabeled spawn, loudly

- **GIVEN** the billing resolver's upstream is unreachable from a spawn site
- **WHEN** the sandbox is spawned
- **THEN** the sandbox is created without billing labels
- **AND** an error-level log with a `[billing]` prefix identifies the analysis/run/step
