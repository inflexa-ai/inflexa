## ADDED Requirements

### Requirement: The profile trigger authorizes the profile through a gate

`triggerDataProfile` and `runDataProfile` MUST authorize the profile run through
`RunAuthorizer.authorize` before they start the workflow. `authorize` is a gate
(see the `host-hooks` capability). It gives a refusal as an `err` value, and it
never throws. If `authorize` gives an `err`, the trigger MUST NOT start the
workflow. The trigger MUST set the claimed profile row to `failed`, with the reason
of the host as the failure reason. Thus the row does not stay `running`.

For each value of `suspend`, the trigger MUST NOT mark the analysis. No work
exists yet, thus the refusal does not pause (see the `work-pause` capability).

#### Scenario: A refused authorization starts no profile workflow

- **GIVEN** a `RunAuthorizer` whose `authorize` gives an `err` with `suspend: false`
- **WHEN** `triggerDataProfile` claims the profile row
- **THEN** no data-profile workflow starts, and the profile row reaches `failed` with the reason of the host
- **AND** the analysis status does not change

#### Scenario: A refused authorization with a suspension fails the row

- **GIVEN** a `RunAuthorizer` whose `authorize` gives an `err` with `suspend: true`
- **WHEN** `triggerDataProfile` claims the profile row
- **THEN** no data-profile workflow starts, and the profile row reaches `failed` with the reason of the host
- **AND** the analysis status does not change

### Requirement: The profile pauses in place

The data-profile body MUST pause for each cause of the `work-pause` capability. The causes come from a model request of
the profiler, or from a refused spawn with the suspend flag. During the pause, the profile row MUST stay `running`.
After the resume, the body MUST send the request again, or spawn again.

The body MUST NOT mark the analysis for a pause, and it MUST NOT revoke the run authorization for a pause. A failure
with no cause of a pause takes the failure path of the profile.

#### Scenario: A suspend error from the profiler model pauses the profile

- **GIVEN** a model request of the profiler agent that fails with a provider error of kind `suspend` and the reason `"budget_exceeded"`
- **WHEN** the body gets the error
- **THEN** the body waits in `paused` with the cause `host` and the reason `"budget_exceeded"`
- **AND** the profile row stays `running`, and the workflow stays active

#### Scenario: A refused spawn with a suspension pauses the profile

- **GIVEN** a `resolveSandboxLabels` hook that gives an `err` with `suspend: true`
- **WHEN** the body spawns the profiler sandbox
- **THEN** no sandbox starts, and the body waits in `paused` with the reason of the host

#### Scenario: A failure without a suspension fails the profile

- **GIVEN** a `resolveSandboxLabels` hook that gives an `err` with `suspend: false`
- **WHEN** the body spawns the profiler sandbox
- **THEN** no sandbox starts, and the profile row reaches `failed` with the reason of the host
- **AND** no pause starts

## REMOVED Requirements

### Requirement: The profile trigger authorizes the run through a gate

**Reason**: Its scenarios of a suspension describe a state that no longer exists. A MODIFIED block cannot drop a scenario, thus the requirement "The profile trigger authorizes the profile through a gate" replaces it.

**Migration**: Refer to "The profile trigger authorizes the profile through a gate" in this capability.

### Requirement: A suspension cancels the profile workflow and marks the analysis

**Reason**: The data profile does not end for a suspension. It waits in place, and it sends the request or spawns again after the resume.

**Migration**: Refer to "The profile pauses in place" in this capability, and to the `work-pause` capability.
