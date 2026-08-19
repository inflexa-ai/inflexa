# Delta: lib-store-build

The capability renames to **package-store-build** at sync time, per decision
14 of `docs/feat_localPackages/decisions.md`.

## ADDED Requirements

### Requirement: The build publishes two images in lockstep

The build MUST publish exactly two images from one commit: `sandbox-base`,
the one runtime image with no baked package, and `sandbox-provisioner`, the
network-enabled builder. The provisioner build MUST assert that its base
digest equals the `base_image` of the manifest, thus no drift gives a
mismatched ABI. Both images MUST publish for `linux/amd64` and `linux/arm64`
as multi-arch manifests on GHCR.

#### Scenario: The two images ship together

- **WHEN** the image build runs
- **THEN** it publishes `sandbox-base` and `sandbox-provisioner` from the same commit, and no other runtime image

#### Scenario: A digest drift stops the provisioner build

- **GIVEN** a provisioner Dockerfile whose base digest differs from the manifest `base_image`
- **WHEN** the image build runs
- **THEN** the build fails with the two digests named

### Requirement: The catalog builds through the provisioner

The store build workflow MUST run the provisioner container to emit the
store: the pool, the catalog farm, and the graph. The workflow MUST pack the
store as one OCI artifact: one zstd layer per track, one base layer for the
rest. The media types MUST be
`application/vnd.inflexa.package-store.track.v1.tar+zstd`,
`application/vnd.inflexa.package-store.base.v1.tar+zstd`, and the artifact
type `application/vnd.inflexa.package-store.manifest.v1+json`. ORAS MUST
push the artifact to
GHCR with an immutable version tag per arch. Only a push moves the
`latest-<arch>` pointer.

#### Scenario: An identical republish is skipped

- **GIVEN** a version tag that already holds layers with the same digests
- **WHEN** the publish step runs
- **THEN** it skips the push and succeeds

#### Scenario: A different republish is refused

- **GIVEN** a version tag that holds different layer digests
- **WHEN** the publish step runs
- **THEN** it refuses, because a version tag is immutable

### Requirement: The per-arch locks commit back to the repository

The manifest is the intent layer. The build MUST resolve each track per
arch, with hashes. The workflow MUST commit the two per-arch lock files back
to the repository, with a signed-off commit. Resolution MUST obey the manifest
first and the lock second: an entry whose manifest constraint still matches
resolves from the lock, and a changed entry resolves fresh. Installs MUST
run with the hashes enforced against the pinned index.

#### Scenario: An unchanged entry keeps its lock pin

- **GIVEN** a lock entry whose manifest constraint did not change
- **WHEN** the build resolves that track
- **THEN** the resolved version and hash equal the lock entry

#### Scenario: A manifest edit re-resolves one entry

- **GIVEN** a manifest entry with a new version constraint
- **WHEN** the build resolves that track
- **THEN** that entry resolves fresh, the rest keep their pins, and the workflow commits the updated locks

### Requirement: The warm preparation is per package and gated

A preparation run MUST execute the warm script of each linked package.
The manifest entry of a package names that script with `warm: <path>`, and
the run works against the catalog farm. It
MUST record the cache entries per package in the farm lock. The cache
check MUST replay each recorded workload inside `sandbox-base`. When a
recorded entry writes again or does not load, the check MUST fail the
artifact. An
acquisition MUST NOT warm, because a numba entry keys on a call signature.

#### Scenario: One script warms one package

- **GIVEN** a manifest entry with `warm: <script path>`
- **WHEN** the preparation run executes
- **THEN** the script of that package runs, and its cache entries record under that package in the lock

#### Scenario: The cache check gates the artifact

- **GIVEN** a recorded cache entry that does not load on replay inside `sandbox-base`
- **WHEN** the cache check runs
- **THEN** the store artifact does not publish

### Requirement: The images pass the security gates

The base images MUST pin by digest. droast MUST cover both Dockerfiles. The
provisioner MUST run with an egress allowlist, with four permitted host
classes: the pinned Python index and its file host, the configured pak
repositories, the GitHub hosts for the `github` track, and
`git.bioconductor.org` for the `git` track. An acquisition run MUST get
only the first two classes. The workflow documentation MUST record the
privilege asymmetry between the two containers.

#### Scenario: droast covers the provisioner

- **WHEN** the droast configuration is read
- **THEN** it names the `sandbox-base` Dockerfile and the `sandbox-provisioner` Dockerfile

#### Scenario: The provisioner cannot reach an arbitrary host

- **GIVEN** a provisioner run with the egress allowlist active
- **WHEN** a request targets a host outside the allowlist
- **THEN** the request is refused

### Requirement: The workflows carry actor-action names

The build workflows MUST be `sandbox-images-build.yml` (the two images),
`package-store-build.yml` (the store and the bundle), and
`package-store-acceptance.yml` (the published-artifact validation). No
branch-push trigger sentinel MUST exist in the tree.

#### Scenario: No trigger sentinel

- **WHEN** the repository root is listed
- **THEN** no `.store-build-trigger` file exists

## MODIFIED Requirements

### Requirement: Builds publish immutable versions selected by a manifest

Each build MUST publish the store as an OCI artifact under a write-once
version tag (`<version>-<arch>`) that is never rewritten. The artifact
manifest pins each layer by content digest. A client MUST resolve its arch
tag and can skip a layer whose digest it already holds. Each successful push
MUST advance the mutable `latest-<arch>` tag to the version that it
published. The load check and the cache check gate the advance — the same
gate that decides the publish. Promotion is not deferred to a separate
acceptance run.

#### Scenario: A published version is never mutated

- **WHEN** a later build runs
- **THEN** it pushes a new version tag and leaves every prior version byte-identical

#### Scenario: Unchanged layers dedup on pull

- **GIVEN** a client that already holds a layer with digest D
- **WHEN** it resolves a manifest that pins digest D
- **THEN** it does not download that layer again

### Requirement: The load check is best-effort with a non-empty-track floor

The store build MUST run a load check inside `sandbox-base` — not inside the
provisioner — because the check must prove the image that runs the code. The
check loads each installed package: an import for Python, a namespace load
for R. A single load failure MUST NOT fail the track — the package is absent
from the advertised inventory of the lock. A track that loaded zero packages
MUST fail the build (the non-empty floor).

#### Scenario: A single load failure drops one package, not the track

- **GIVEN** one manifest package that installs but fails to load, beside others that load
- **WHEN** the load check runs
- **THEN** the failing package is absent from the advertised inventory, and the track still builds

#### Scenario: An all-failed track fails the build

- **GIVEN** a track in which no package loaded
- **WHEN** the load check runs
- **THEN** the build fails, and no artifact publishes

### Requirement: The build emits a per-arch coverage report and guards against regressions

After the load check, the build MUST emit a coverage report: per arch and
track, the wanted, loaded, and missing counts and names. The report MUST
diff the loaded set against the last published artifact of that arch. A
package that was published for `linux/amd64`, is still in the manifest, and
is now missing MUST fail the build as a regression. A package that never
built for `linux/arm64` reports informationally and MUST NOT fail the build.
A package that the manifest no longer holds reports as dropped, by name, and
MUST NOT fail the build.

#### Scenario: A silent amd64 drop is a regression

- **GIVEN** a package in the last published `linux/amd64` artifact, still in the manifest, that no longer loads
- **WHEN** the coverage report runs
- **THEN** it flags a regression and the build fails

#### Scenario: An intentional removal is not a regression

- **GIVEN** a package in the last published artifact that the manifest no longer holds
- **WHEN** the coverage report runs
- **THEN** it lists the package as dropped and the build does not fail

### Requirement: Each architecture publishes the tracks that pass the floor

Both legs MUST attempt every track, and the store stays per arch.
`linux/amd64` is the primary leg, and `linux/arm64` is a best-effort leg
that can fail without a red build. The R tracks (`cran`, `bioconductor`,
`github`) MUST travel together or not at all, because they share one R
library path and form one dependency chain.

#### Scenario: arm64 publishes R when it builds

- **GIVEN** a build in which the arm64 R tracks meet the floor
- **WHEN** the arm64 artifact is written
- **THEN** it holds the R track layers beside the Python layer

#### Scenario: A red arm64 leg does not stop amd64

- **GIVEN** an arm64 leg that fails
- **WHEN** the workflow completes
- **THEN** the amd64 artifact publishes, and the arm64 failure reports

### Requirement: Acceptance is a non-gating post-publish validation

After a build publishes, an acceptance run MUST validate the published
artifacts on a fresh machine. The run has no network at run time, and it
has the correct arch. It MUST pull the published store with ORAS, extract each layer, and
mount the store read-only into the published `sandbox-base`. Inside that
sandbox it MUST run the import-all invariant over the advertised inventory
and the per-library smoke-test suite. It MUST confirm that each advertised
Python module resolves from the content store. Acceptance MUST NOT move
`latest-<arch>` and MUST NOT mutate any published artifact. It MUST surface
a per-arch results table with the green or red status.

#### Scenario: Acceptance obtains the store the way a user does

- **WHEN** acceptance obtains the store
- **THEN** it pulls the published OCI artifact with ORAS and mounts it into the published `sandbox-base`

#### Scenario: Acceptance does not move any pointer

- **GIVEN** an acceptance run that completes green or red
- **WHEN** it finishes
- **THEN** `latest-<arch>` and every published artifact are exactly as the build left them

## REMOVED Requirements

### Requirement: The store ships as per-track, self-describing tarballs

**Reason**: The OCI artifact with per-track layers replaces the S3 tarball
layout, and GHCR replaces S3.
**Migration**: A client pulls the OCI artifact with ORAS. The managed
delivery is a recorded open decision (`BLOCKED`), outside this change.

### Requirement: packages.txt derives from the verified-loadable set

**Reason**: `packages.txt` leaves the farm contract. The advertised
inventory lives in `inflexa.lock`, and the load-check discipline moves into
"The load check is best-effort with a non-empty-track floor".
**Migration**: A consumer reads the inventory from
`/mnt/libs/current/inflexa.lock` through `list_available_packages`.

### Requirement: The build publishes three layered sandbox images

**Reason**: One runtime image serves every sandbox, and the packages come
from the store. The two variant images retire.
**Migration**: Pull `sandbox-base` and the package-store artifact. No
variant choice exists.

### Requirement: Every layer installs into the runtime mount path

**Reason**: No image layer installs an analysis package any more. The
provisioner writes the store on the host side.
**Migration**: None. The runtime layout of a mounted farm is unchanged.

### Requirement: Sandbox images are self-sufficient at runtime

**Reason**: The image bakes no package, thus a bare image resolves no
analysis import by design.
**Migration**: Run the image with the store mounted. The resolver env comes
from the harness mount plan.

### Requirement: Downstream images extend the store through env-driven install locations

**Reason**: The `FROM` extension path retires with the variant images. The
acquisition path (`store add`) is the extension mechanism.
**Migration**: Acquire a package into the pool with the provisioner, and
link it into a farm.

### Requirement: Managed-mount tarballs are extracted from the published images

**Reason**: The variant images retire, and the tarball source with them. The
managed delivery replacement is a recorded open decision (`BLOCKED`).
**Migration**: None yet. The open decision names the follow-up work.
