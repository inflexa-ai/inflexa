# Spec Delta

## ADDED Requirements

### Requirement: The server state gives the stop and the boot progress

`GET /api/v1/server` and the 202 body of `POST /api/v1/server/boot` MUST give `stopping` in each phase. Its value MUST be the mode of a stop in progress (`now` or `drain`), or `null` while no client asked for a stop. After a stop request, it MUST keep the mode until the process exits. The phase does not change because of a stop.

In the phase `starting`, the body MUST give `boot` with these fields:

- `attemptStartedAt`: the start of the boot attempt.
- `step`: the step that runs now, with its `id` and its `startedAt`. It is `null` before the first step starts.
- `done`: each step of the attempt that ended, in the boot order, with its `id`, its `startedAt`, and its `endedAt`.

The step ids MUST be these, in the boot order: `container_engine`, `proxy`, `images`, `containers`, `credential`, `embedder`, and `runtime`. The steps `proxy` and `credential` MUST run only in `cliproxy` mode. A step ends when the next step starts. A new attempt after `failed` MUST start with an empty `done` list.

While the step `images` pulls an image through the engine API, its `step` MUST give `progress` with `doneBytes` and `totalBytes`. `doneBytes` is the sum of the moved bytes of the pulled images. `totalBytes` is the sum of their sizes, or `null` when a size is not known. A pull that reports no bytes MUST give no `progress`.

In the phase `failed`, the body MUST give `attemptStartedAt`, `failedAt`, and `failedStep`. `failedStep` is the id of the step that ran at the fault. It is `null` for a fault before the first step, for example a model connection that is not valid.

The 503 `unavailable` body of a route that needs the runtime MUST give `details.step` beside `details.phase`. In the phase `starting`, the value is the id of the step that runs now. In the phase `failed`, it is `failedStep`. Before the first step, it is `null`.

Each time MUST be an ISO 8601 string.

#### Scenario: The first boot shows the image pull

- **GIVEN** a server in `cliproxy` mode whose boot pulls the missing images
- **WHEN** a client sends `GET /api/v1/server`
- **THEN** the body has the phase `starting`, `boot.step.id` set to `images`, and the start time of that step
- **AND** `boot.done` gives `container_engine` and `proxy`, each with its start time and its end time

#### Scenario: The pull reports its bytes

- **GIVEN** a boot whose engine socket resolves, and a pull that moved 40 MB of 120 MB
- **WHEN** a client sends `GET /api/v1/server`
- **THEN** `boot.step.progress` gives `doneBytes` 40 MB and `totalBytes` 120 MB

#### Scenario: A drain stop shows in the server state

- **GIVEN** a server in the phase `ready`
- **WHEN** a client sends `POST /api/v1/server/shutdown` with the mode `drain`
- **THEN** each `GET /api/v1/server` until the exit gives `stopping` set to `drain`, and the phase stays `ready`

#### Scenario: A failed boot gives its times and its step

- **GIVEN** a boot that fails while it starts the containers
- **WHEN** a client sends `GET /api/v1/server`
- **THEN** the body has the phase `failed`, `failedStep` set to `containers`, the start time of the attempt, and the time of the failure

#### Scenario: A fault before the first step has no step

- **GIVEN** a model connection that is not valid
- **WHEN** the server boots
- **THEN** the phase is `failed` and `failedStep` is `null`

#### Scenario: A runtime route names the step

- **GIVEN** a server whose boot runs the step `images`
- **WHEN** a client sends `GET /api/v1/analyses/a1/runs`
- **THEN** the server answers 503 `unavailable` with `details.phase` set to `starting` and `details.step` set to `images`

#### Scenario: A new attempt starts with no done step

- **GIVEN** a server in the phase `failed`
- **WHEN** a client sends `POST /api/v1/server/boot`
- **THEN** the body has the phase `starting`, a new `boot.attemptStartedAt`, and no step of the failed attempt in `boot.done`

### Requirement: The boot pulls the missing images through the engine API

The boot gate of the server and of `inflexa up` MUST pull only the images that the engine does not hold. When the engine socket resolves, the gate MUST pull each missing image through the engine API. It MUST report the moved bytes, and the total bytes from the registry manifests. An image reference that pins a digest MUST pull that digest. The step `images` MUST end only when the engine holds each image under the reference of the compose file.

When no engine socket resolves, the gate MUST pull with `compose pull` and report no bytes. Docker resolves no socket path. The gate MUST also use `compose pull` in these conditions:

- The engine API cannot start a pull: the socket does not answer, or the response is not OK.
- An engine pull completes, but the engine does not hold the image under its reference.

An error event in the pull stream of the engine MUST fail the gate with the reason of the engine. A stream that breaks before its end MUST also fail the gate.

The pull MUST write one line at its start and one line for its outcome.

#### Scenario: Podman reports the bytes of the pull

- **GIVEN** a Podman machine that runs, and a Postgres image that the engine does not hold
- **WHEN** the server boots
- **THEN** the gate pulls the image through the engine API, and the step `images` gives the moved bytes and the total bytes

#### Scenario: Docker pulls with compose

- **GIVEN** Docker as the container runtime, and a Postgres image that the engine does not hold
- **WHEN** the server boots
- **THEN** the gate pulls with `compose pull`, and the step `images` gives no `progress`

#### Scenario: The engine refuses a pull

- **GIVEN** an engine socket that resolves, and a pull stream that ends with an error event
- **WHEN** the server boots
- **THEN** the phase is `failed` with the reason `infra_unready`, `failedStep` is `images`, and the message gives the reason of the engine
