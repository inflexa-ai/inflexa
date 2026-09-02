## ADDED Requirements

### Requirement: The store carries the record of the image it was proven beside

The store build MUST copy the image record `/opt/inflexa/image-packages.json`
out of the `sandbox-base` image that it built for the run into the store
root, as `image-packages.json`. The copy MUST run after the load check and
before the pack. The base layer MUST carry the record as a root entry. The
build MUST copy the record verbatim, and it MUST NOT assemble one of its
own. Both image builds MUST pass the version that they tag with as the
`IMAGE_VERSION` build arg, thus the record names the tag of its image.

#### Scenario: The record lands in the base layer

- **WHEN** the store artifact of one arch is extracted
- **THEN** the store root holds `image-packages.json`, and it parses at schema 1

#### Scenario: The record names the image of the run

- **GIVEN** a build with the version `20260901-3031713` on `amd64`
- **WHEN** the extracted `image-packages.json` is read
- **THEN** `image.version` is `20260901-3031713` and `image.arch` is `amd64`

#### Scenario: The image build passes its version

- **WHEN** the image build tags `sandbox-base:<version>-<arch>`
- **THEN** it passed `IMAGE_VERSION=<version>` to the Dockerfile

## MODIFIED Requirements

### Requirement: Acceptance is a non-gating post-publish validation

After a build publishes, an acceptance run MUST validate the published
artifacts, on the correct arch. The run MUST obtain them only from the
registry, never from a build volume of its own box. That source is what
makes the run fresh, not the machine. The suite MUST run with no network,
no capability, and no privilege escalation inside the sandbox. The arm64
leg is best-effort, the same rule as the build, because its store is
best-effort too. It MUST pull the published store with ORAS, extract each layer, and
mount the store read-only into the published `sandbox-base`. Inside that
sandbox it MUST run the import-all invariant over the advertised inventory
and the per-library smoke-test suite. The advertised inventory MUST be the
`inflexa.lock` of the mounted farm plus the record
`/opt/inflexa/image-packages.json` of the image under test, thus the image
tracks stay inside the invariant. A conda entry of the record contributes
its executable name, because the check probes the binary. A record at an
unknown schema MUST fail the run loud, because a dropped record would turn
the invariant into a no-op for the image tracks. It MUST confirm that each
advertised Python module resolves from the content store. Acceptance MUST
NOT move `latest-<arch>` and MUST NOT mutate any published artifact. It
MUST surface a per-arch results table with the green or red status.

#### Scenario: Acceptance obtains the store the way a user does

- **WHEN** acceptance obtains the store
- **THEN** it pulls the published OCI artifact with ORAS and mounts it into the published `sandbox-base`

#### Scenario: Acceptance does not move any pointer

- **GIVEN** an acceptance run that completes green or red
- **WHEN** it finishes
- **THEN** `latest-<arch>` and every published artifact are exactly as the build left them

#### Scenario: The image tracks are inside the invariant

- **GIVEN** an image whose record lists `eagle2` with the executable `eagle`
- **WHEN** the import-all phase runs
- **THEN** the advertised set holds `eagle` under the conda track, and the check probes that binary

#### Scenario: An unknown record schema fails loud

- **GIVEN** an image record at a schema other than 1
- **WHEN** the inventory is read
- **THEN** the run exits with the store-error code, and the message names the schema
