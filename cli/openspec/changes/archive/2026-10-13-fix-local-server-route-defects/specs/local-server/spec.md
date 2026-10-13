## MODIFIED Requirements

### Requirement: Each profile drive of the server asks the sandbox gate first

Before each profile drive, the server MUST ask why a sandbox of the analysis cannot start now. The drives are the chat open (`GET {A}/chat-context`), the deliberate re-profile (`POST {A}/data-profile/rerun`), and the input change. The gate MUST give one line for a person with the command that repairs the machine, or nothing:

- An analysis with no inputs profiles nothing, thus it MUST pass.
- A live image or catalog transfer MUST refuse, and name `inflexa sandbox status`.
- A container engine that does not answer MUST refuse with the message of the engine.
- An image that the engine cannot find MUST refuse, and name `inflexa sandbox pull`, or the build of a custom image.
- An absent or incomplete store MUST refuse, and name `inflexa store download`. A declined or canceled catalog transfer gives the reason.
- A recorded failure of the farm composition MUST refuse with its reason. The gate clears the record when it reads the machine, thus the next drive composes again.

The engine and the filesystem decide usability, and a transfer row gives only the reason of a refusal. A refused re-profile MUST give 409 `conflict` with the line. A refused chat open MUST give the outcome `failed` with the line, and start no drive. A refused input change MUST wait, per the coordination requirement.

The read of the sandbox readiness (`GET {A}/sandbox-readiness`) MUST give a recorded failure of the farm composition in `farm.failure`. That read MUST NOT clear the record. Thus the read changes no state, and the next drive can name the cause.

#### Scenario: A re-profile with no sandbox image

- **GIVEN** an analysis with inputs, and no sandbox image in the engine
- **WHEN** a client sends `POST {A}/data-profile/rerun`
- **THEN** the server answers 409 `conflict` with the line that names `inflexa sandbox pull`, and nothing is staged

#### Scenario: A chat open during a transfer

- **GIVEN** a live catalog transfer
- **WHEN** a client sends `GET {A}/chat-context` for an analysis with inputs
- **THEN** the profile outcome is `failed` with the transfer line, and no drive starts

#### Scenario: A readiness read leaves the farm failure for the gate

- **GIVEN** a recorded failure of the farm composition of an analysis with inputs, a sandbox image in the engine, and a complete store
- **WHEN** a client sends `GET {A}/sandbox-readiness` two times, and then sends `POST {A}/data-profile/rerun`
- **THEN** each readiness answer gives the failure in `farm.failure`
- **AND** the re-profile answers 409 `conflict` with the line that names the failure

#### Scenario: The gate clears the record that it read

- **GIVEN** a recorded failure of the farm composition of an analysis with inputs
- **WHEN** a profile drive asks the gate, and the gate refuses with the failure
- **THEN** the next read of the sandbox readiness gives `farm.failure` as `null`
