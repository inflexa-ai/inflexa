## MODIFIED Requirements

### Requirement: Sandbox resources are estimated from the staged manifest

The body MUST acquire the lease of the profile before its first exec. The size of the request MUST come from
`estimateDataProfileResources(stagedInputs)`, not from a fixed spec. The estimate derives from the file count, the total
size, and the in-memory expansion of each format. An empty manifest
MUST estimate `{ cpu: 1, memoryGb: 2 }`. The lease key is the id of the profile workflow, thus the profiler agent uses the same lease. The body MUST release the lease at the end of the profile, also after a failure.

#### Scenario: Larger inputs raise the estimate

- **WHEN** the manifest holds a multi-gigabyte file
- **THEN** the estimated `memoryGb` exceeds the 2 GiB floor

#### Scenario: Empty manifest uses the floor

- **WHEN** `estimateDataProfileResources` is called with an empty file list
- **THEN** it returns `{ cpu: 1, memoryGb: 2 }`

#### Scenario: The profiler agent uses the lease of the body

- **GIVEN** a profile body that acquired its lease with the estimate
- **WHEN** the profiler agent calls `execute_command`
- **THEN** the command runs on the machine of that lease, and the agent did not call `acquire_sandbox`

#### Scenario: A failed profile releases its lease

- **WHEN** the profile reaches `failed` after the body acquired its lease
- **THEN** the body releases the lease, and the machine goes away

### Requirement: The profile pauses in place

The data-profile body MUST pause for each cause of the `work-pause` capability that a model request of the profiler gives. During the pause, the profile row MUST stay `running`, and after the resume, the body MUST send the request again.

A refused spawn with the suspend flag MUST pause the lease workflow of the profile, under the work of the profile. The `acquire` of the body MUST continue to wait, and the profile row MUST stay `running`.

The body MUST NOT mark the analysis for a pause, and it MUST NOT revoke the run authorization for a pause. A failure
with no cause of a pause takes the failure path of the profile.

#### Scenario: A suspend error from the profiler model pauses the profile

- **GIVEN** a model request of the profiler agent that fails with a provider error of kind `suspend` and the reason `"budget_exceeded"`
- **WHEN** the body gets the error
- **THEN** the body waits in `paused` with the cause `host` and the reason `"budget_exceeded"`
- **AND** the profile row stays `running`, and the workflow stays active

#### Scenario: A refused spawn with a suspension pauses the profile

- **GIVEN** a `resolveSandboxLabels` hook that gives an `err` with `suspend: true`
- **WHEN** the body acquires the lease of the profile
- **THEN** no sandbox starts, and the lease workflow waits in `paused` under the profile with the reason of the host
- **AND** the `acquire` of the body waits, and the profile row stays `running`

#### Scenario: A failure without a suspension fails the profile

- **GIVEN** a `resolveSandboxLabels` hook that gives an `err` with `suspend: false`
- **WHEN** the body acquires the lease of the profile
- **THEN** no sandbox starts, `acquire` gives `refused`, and the profile row reaches `failed` with the reason of the host
- **AND** no pause starts
