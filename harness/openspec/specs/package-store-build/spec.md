# package-store-build Specification

## Purpose

The build pipeline of the package store. One manifest names the intent: the
packages of each track, per architecture. The pipeline publishes two images
(`sandbox-base`, `sandbox-provisioner`) and one OCI store artifact per
architecture to GHCR. The provisioner emits the store — the pool, the
catalog farm, and the graph — and the checks gate the publish. The harness
consumes only the published results, through the `package-store` runtime
contract.

## Open decisions

- The managed store delivery is `BLOCKED`. How a managed deployment fills
  the `libStorePvc` from the OCI artifact is not decided. The variant-image
  tarball path retired, and no replacement is chosen.
- The K8s node pin is open. Whether a sandbox pod pins to a node class that
  holds the store, and how that pin is expressed, is not decided.

## Requirements

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

The egress rules MUST come from live DNS. A local resolver feeds each address
of a permitted answer into a firewall set, before the answer returns, and
the rules match the set. Thus a host that changes its addresses under a
short TTL stays reachable, and no frozen address set can go stale during
a long build. The last rule MUST reject, thus a blocked connect fails in
milliseconds and names the host — a silent drop burns its whole timeout.

A fatal canary step MUST run before the build. It applies the same
allowlist library, fetches one pinned-snapshot binary whole through its
redirect, and proves that an off-list host refuses fast. Thus a blocked
route stops the run in minutes, not at the multi-hour budget.

#### Scenario: A changed address does not break a permitted host

- **GIVEN** a permitted host that changes its addresses during a build
- **WHEN** a connect to that host opens after the change
- **THEN** the resolver feeds the new address into the set, and the rules accept the connect

#### Scenario: The canary gates the build

- **GIVEN** an allowlist that cannot serve the binary route
- **WHEN** the canary step runs
- **THEN** the step fails before the build starts, and the failure names the route

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

### Requirement: The load check fails the build on one load failure

The store build MUST run a load check inside `sandbox-base`, not inside the
provisioner, because the check must prove the image that runs the code. The
check loads each package of the farm lock: an import for Python, a namespace
load for R. One load failure MUST fail the build. The log and the step
summary MUST name each failed package and its error. Thus a reader knows the
reason before the decision. The build MUST NOT rewrite the lock after the
check. The lock is the inventory, and each entry of a published lock loaded.

#### Scenario: One load failure fails the build

- **GIVEN** one package that installs but fails to load, beside others that load
- **WHEN** the load check runs
- **THEN** the build fails, no artifact publishes, and the log names the package and the error

#### Scenario: A clean check publishes the lock as built

- **GIVEN** a farm in which each package loads
- **WHEN** the load check runs
- **THEN** the lock publishes with each entry, and no entry is absent

### Requirement: The coverage report fails the build on a wanted package that is not loaded

After the load check, the build MUST emit a coverage report: per arch and
track, the wanted, loaded, and missing counts and names. A wanted name is a
manifest entry. A wanted name counts as loaded in two cases: the farm lock
holds it, or the R library of the `sandbox-base` image loads it. The second
case covers the base and recommended packages of R, which the image carries
and the store never holds. The build MUST prove the second case with a load
in the image, not with a record. An R name MUST compare across the three R
subtrees, because the three share one library path. The subtree of a package
is the closure that placed it, not its manifest section. One missing wanted
name MUST fail the build, and the report MUST name it. The report MUST NOT
compare against a previous artifact. A regression is a missing wanted name,
thus the rule above catches it with no baseline.

#### Scenario: A missing wanted package fails the build

- **GIVEN** a manifest entry that neither the lock nor the image library loads
- **WHEN** the coverage report runs
- **THEN** the report names the entry as missing, and the build fails

#### Scenario: A base package of the image counts as loaded

- **GIVEN** a manifest entry such as `survival` that the R installation of the image carries
- **WHEN** the coverage report runs
- **THEN** the entry counts as loaded, because the image loaded it

#### Scenario: A Bioconductor entry in the cran subtree counts as loaded

- **GIVEN** a manifest entry under `bioconductor` that the lock holds under `cran`
- **WHEN** the coverage report runs
- **THEN** the entry counts as loaded

### Requirement: Each architecture publishes the tracks that pass the load check

Both legs MUST attempt every track, and the store stays per arch.
`linux/amd64` is the primary leg, and `linux/arm64` is a best-effort leg
that can fail without a red build. The R tracks (`cran`, `bioconductor`,
`github`) MUST travel together or not at all, because they share one R
library path and form one dependency chain.

#### Scenario: arm64 publishes R when it builds

- **GIVEN** a build in which the arm64 R tracks pass the load check
- **WHEN** the arm64 artifact is written
- **THEN** it holds the R track layers beside the Python layer

#### Scenario: A red arm64 leg does not stop amd64

- **GIVEN** an arm64 leg that fails
- **WHEN** the workflow completes
- **THEN** the amd64 artifact publishes, and the arm64 failure reports

### Requirement: The github track installs through pak, with the token present

A build whose manifest names a `github` entry MUST refuse to start when
`GITHUB_PAT` is absent. The refusal MUST name the anonymous rate cap as the
reason, because an anonymous run fails late with 403 answers. The github
stage MUST install each repository through pak, the same resolver as the
bulk. Thus the stage reads the metadata that the bulk wrote, and the token
of the environment authenticates every API call. Each repository installs
best-effort, and a failed repository MUST NOT stop the stage.

#### Scenario: A build without the token refuses early

- **GIVEN** a manifest with a `github` entry and no `GITHUB_PAT` in the environment
- **WHEN** the build starts
- **THEN** it refuses before any track resolves, and the message names the rate cap

#### Scenario: One failed repository does not stop the stage

- **GIVEN** a github repository whose install fails
- **WHEN** the github stage completes
- **THEN** the other repositories install, and the failure reports per repository

### Requirement: A failed install keeps the held package

When the install of a package fails in a build, the farm MUST NOT lose the
package. The condition is: the previous catalog farm advertised it, and the
pool still holds its store directory. The new farm then links the held
directory, and the lock carries its entry, and the log reports the keep. A
dependency carries over only when a kept or wanted package reaches it
through the graph. A package whose manifest entry was removed MUST NOT
carry over.

#### Scenario: A github failure keeps the held pin

- **GIVEN** a github package that the previous farm advertised and whose install now fails
- **WHEN** the farm publishes
- **THEN** the farm links the held store directory, and the lock carries its entry

#### Scenario: A bulk failure keeps the held closure

- **GIVEN** a dependency whose source build fails, with a kept dependent that reaches it
- **WHEN** the farm publishes
- **THEN** the dependency links from the pool, and the closure of the dependent stays whole

#### Scenario: A removed manifest entry leaves the farm

- **GIVEN** a package whose manifest entry was removed since the previous build
- **WHEN** the farm publishes
- **THEN** the farm holds no link for it, even though the pool still holds its bytes

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
its executable name, because the check probes the binary. An absent record
or a record at an unknown schema MUST fail the run loud, because a dropped
record would turn the invariant into a no-op for the image tracks. It MUST
confirm that each
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

#### Scenario: An absent record fails loud

- **GIVEN** an image under test with no `/opt/inflexa/image-packages.json`
- **WHEN** the inventory is read
- **THEN** the run exits with the store-error code, and the message names the absent record

