# sandbox-image-catalog Specification

## Purpose

Defines the single sandbox container image (`sandbox-base`) that every sandbox
agent runs in, and how the harness selects it. There is one image for all
agents — R, Python, and Node.js runtimes plus runtime-only system libraries,
fonts, and CLI tools, but **no** R/Python/Node packages baked in: those come
from the shared library store bind-mounted read-only at `/mnt/libs`. Keeping the
image package-free is what lets one image serve every analysis domain and keeps
the build cache stable across package-set changes.

The image runs sandbox-server as its entrypoint (`CMD ["sandbox-server"]`,
`EXPOSE 8765`), so a started container is immediately the HTTP counterpart to the
harness `SandboxClient` — there is no separate launch command. The harness does
not read a `SANDBOX_IMAGE` env var; the image reference is supplied as the
`config.image` default at composition and may be overridden per step by
`meta.image`. R and Python versions are pinned in the Dockerfile (R 4.6.0 via the
`BASE_IMAGE` build arg, Python 3.12) to match the external lib-store build's
manifest; that manifest lives in the lib-store build, not in this repo.

## Requirements

### Requirement: Single base image with the three runtimes and no packages

The system SHALL use a single container image (`sandbox-base`) for all sandbox
agents. The image SHALL contain an R runtime (4.6.0, from the `BASE_IMAGE` build
arg), a Python runtime (3.12), a Node.js 20 runtime, runtime-only system
libraries, the CLI tools `uv`, `ruff`, and the Tailwind CSS standalone binary,
the Inter and JetBrains Mono fonts, and a non-root `sandbox` user (UID 1000)
owning `/workspace`. The image SHALL NOT contain any R, Python, or Node.js
analysis packages — those come from the library store mounted at `/mnt/libs`.

#### Scenario: Base image has the R runtime

- **GIVEN** a running sandbox container
- **WHEN** `R --version` is executed
- **THEN** it reports R 4.6.0

#### Scenario: Base image has the Python runtime

- **GIVEN** a running sandbox container
- **WHEN** `python3 --version` is executed
- **THEN** it reports Python 3.12.x

#### Scenario: Base image has the Node.js runtime

- **GIVEN** a running sandbox container
- **WHEN** `node --version` is executed
- **THEN** it reports Node.js 20.x

#### Scenario: uv and ruff are available

- **GIVEN** a running sandbox container
- **WHEN** `uv --version` and `ruff --version` are executed
- **THEN** both commands succeed

#### Scenario: No analysis packages baked in

- **GIVEN** a running sandbox container WITHOUT the library store mounted
- **WHEN** an R `library(ggplot2)` (or a Python `import scanpy`) is executed
- **THEN** it fails with a package-not-found error

### Requirement: Runtime-only system libraries, no build toolchain

The base image Dockerfile's runtime stage SHALL install only runtime variants of
system libraries (no `-dev` packages) and SHALL NOT add a build toolchain to the
runtime image. Compilation needed at build time (the Go sandbox-server, the
provenance `LD_PRELOAD` shim) happens in separate builder stages whose toolchains
do not land in the final image.

#### Scenario: Runtime-variant system libraries

- **GIVEN** the base image Dockerfile runtime stage
- **WHEN** inspecting the apt install list
- **THEN** system libraries are runtime variants (e.g. `libhdf5-103-1t64`, not `libhdf5-dev`)

#### Scenario: No build toolchain in the runtime image

- **GIVEN** the base image Dockerfile runtime stage
- **WHEN** inspecting its apt install layers
- **THEN** they do NOT install `build-essential`, `cmake`, `gfortran`, or `gcc`

### Requirement: sandbox-server is the image entrypoint

The base image SHALL set `CMD ["sandbox-server"]` and SHALL `EXPOSE 8765`, so a
started container runs sandbox-server listening on port 8765 with no extra launch
step. The image SHALL set `/workspace` as the working directory.

#### Scenario: Started container runs sandbox-server

- **GIVEN** a freshly started `sandbox-base` container with no command override
- **WHEN** the container reaches running state
- **THEN** sandbox-server is the running process listening on port 8765

#### Scenario: Workspace is the default working directory

- **GIVEN** a running sandbox container
- **WHEN** `pwd` is executed without changing directory
- **THEN** output is `/workspace`

### Requirement: Image reference comes from config, overridden per step

The harness SHALL resolve the sandbox image from the `config.image` default,
overridden per step by `meta.image` when present. The harness SHALL NOT read a
`SANDBOX_IMAGE` environment variable in the sandbox client layer.

#### Scenario: Default image used when no override

- **GIVEN** `config.image` is `sandbox-base:latest` and `meta.image` is unset
- **WHEN** a sandbox is created for a step
- **THEN** the container image is `sandbox-base:latest`

#### Scenario: Per-step override wins

- **GIVEN** `config.image` is `sandbox-base:latest` and `meta.image` is `registry.example.com/sandbox-base:v1`
- **WHEN** a sandbox is created for that step
- **THEN** the container image is `registry.example.com/sandbox-base:v1`

### Requirement: No agent runtime baked into the image

The base image SHALL NOT include a Bun runtime, a Claude/Anthropic SDK, an API
client, or proxy configuration. LLM agent loops run in the harness host process,
not in sandbox containers; sandbox containers only execute analysis work.

#### Scenario: Bun is not installed

- **GIVEN** a running sandbox container
- **WHEN** `bun --version` is executed
- **THEN** the command fails

#### Scenario: No agent SDK present

- **GIVEN** a running sandbox container
- **WHEN** checking for a Claude/Anthropic SDK or proxy config
- **THEN** none is installed

### Requirement: Single base image Dockerfile location

The base image Dockerfile SHALL be at `images/sandbox-base/Dockerfile`, and
`images/` SHALL contain only the `sandbox-base/` image directory.

#### Scenario: Dockerfile location

- **GIVEN** the `images/` directory
- **WHEN** listing its subdirectories
- **THEN** it contains `sandbox-base/` with a `Dockerfile`
