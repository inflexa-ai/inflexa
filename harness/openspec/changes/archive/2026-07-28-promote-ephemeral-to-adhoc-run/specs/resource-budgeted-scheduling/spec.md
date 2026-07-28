## REMOVED Requirements

### Requirement: Ephemeral sandbox sizing comes from the policy

**Reason**: The ephemeral path is replaced by adhoc runs; the sizing knob is renamed `policy.ephemeral` → `policy.adhoc`.

**Migration**: Embedders that set `policy.ephemeral` SHALL set `policy.adhoc` instead. Semantics and default are unchanged (see the added requirement below).

## ADDED Requirements

### Requirement: Adhoc sandbox sizing comes from the policy

`runAdhoc` SHALL size its sandbox from `policy.adhoc` when the embedder supplies one, falling back to the built-in default `{ cpu: 4, memoryGb: 8 }`. The value remains subject to the existing per-step clamp at sandbox creation.

#### Scenario: Policy overrides the adhoc default

- **GIVEN** a policy with `adhoc: { cpu: 2, memoryGb: 4 }`
- **WHEN** a `run_adhoc` sandbox is created
- **THEN** the sandbox is requested with `{ cpu: 2, memoryGb: 4 }`

#### Scenario: Absent policy falls back to the default

- **GIVEN** no resource policy supplied at the composition root
- **WHEN** a `run_adhoc` sandbox is created
- **THEN** the sandbox is requested with `{ cpu: 4, memoryGb: 8 }`
