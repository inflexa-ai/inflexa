## ADDED Requirements

### Requirement: The provisioner image is a code constant the setup flow pulls

The provisioner image reference SHALL be a constant in the CLI source, beside the
GHCR namespace constant that already names the published sandbox image. No
configuration value SHALL name it, and no configuration value SHALL move it. The
provisioner offers no variant, thus a user selects nothing.

`inflexa setup` SHALL pull the provisioner image the same way it pulls the sandbox
image: through the active container runtime, with a confirmation, and inside the
same progress surface. Declining SHALL skip the provisioner step and continue
setup. On a non-interactive terminal without an answer, setup SHALL NOT auto-pull
and SHALL print a hint naming the command that pulls it later.

A store command that starts the provisioner SHALL, when the image is absent
locally, obtain it from GHCR rather than fail. It SHALL NOT ask the user to
configure a reference.

#### Scenario: The provisioner reference comes from code

- **GIVEN** a configuration file that names a provisioner image
- **WHEN** a store command starts the provisioner
- **THEN** it runs the image the code constant names, and the configured value has no effect

#### Scenario: Setup pulls the provisioner

- **WHEN** `inflexa setup` reaches the container-image step interactively and the user accepts
- **THEN** it pulls both the sandbox image and the provisioner image through the active runtime

#### Scenario: A missing provisioner is pulled, not reported as unconfigured

- **GIVEN** the provisioner image is absent locally
- **WHEN** `inflexa store add` runs
- **THEN** the CLI pulls the provisioner image and continues, and it never reports an unconfigured image

### Requirement: Only an install starts the provisioner container

The CLI SHALL start the provisioner container only for an operation that installs
packages or mutates the store under the store lock. Four operations SHALL be
host filesystem actions the CLI does directly, with no container: the read of the
store, the list of what the store holds, the preview of a reclamation, and the
composition of a farm.

The provisioner image is large, so a container start is a real cost. A read or a
link operation SHALL NOT pay it.

#### Scenario: Listing starts no container

- **WHEN** `inflexa store ls` runs
- **THEN** it reads the store on the host and starts no container

#### Scenario: Composing a farm starts no container

- **WHEN** composition makes or extends a farm
- **THEN** it links on the host and starts no container

#### Scenario: A reclaim preview starts no container

- **WHEN** the CLI reports what a reclamation would remove
- **THEN** it computes the set on the host and starts no container

#### Scenario: An install starts the container

- **WHEN** `inflexa store add <spec>` runs
- **THEN** the provisioner container starts with a network, and it installs the closure

## MODIFIED Requirements

### Requirement: The store can be inspected and reclaimed

The CLI SHALL report what a store holds — its packages, the farms defined against it, and the disk each occupies. It SHALL give a way to remove a farm, and a way to remove store content that no farm references. Reclamation SHALL never run implicitly as a side effect of another command.

The inspection SHALL name the analysis of each analysis farm, and it SHALL mark
the catalog template farm as the template. It SHALL say which tracks each farm
carries. A farm with fewer tracks than another is the reason an import fails in
one analysis and not in another.

An update of the store SHALL remove nothing. The pool is content-addressed, thus
an update adds only the content whose hash changed, and an old version stays on
disk. `inflexa store reclaim` SHALL be the one path that removes store content.
The inspection SHALL report the reclaimable bytes, so the user sees the disk an
update leaves behind.

The inspection command SHALL stay prompt-free and SHALL gain no option, because a
passive diagnostic stays passive.

#### Scenario: Inspection reports contents and size

- **GIVEN** a populated store
- **WHEN** the user inspects it
- **THEN** the output lists the packages, the farms, and the disk used

#### Scenario: Reclamation spares referenced content

- **GIVEN** a store whose content is referenced by at least one farm
- **WHEN** reclamation runs
- **THEN** referenced content is retained and only unreferenced content is removed

#### Scenario: Reclamation is never implicit

- **WHEN** any command other than the reclamation command runs
- **THEN** no store content is removed

#### Scenario: Each farm reports its analysis

- **GIVEN** a store holding the template farm and two analysis farms
- **WHEN** the user inspects the store
- **THEN** the output names the analysis of each analysis farm and marks the template

#### Scenario: Each farm reports its tracks

- **GIVEN** a store holding one farm with a Python track and one farm with a Python track and an R track
- **WHEN** the user inspects the store
- **THEN** the output names the track set of each farm

#### Scenario: An update keeps the old version and the inspection reports the reclaimable bytes

- **GIVEN** a store whose update added new content beside an old version no farm references
- **WHEN** the user inspects the store
- **THEN** the old version is still on disk, and the output reports the reclaimable bytes and names the reclaim command

## REMOVED Requirements

### Requirement: A local package store is optional and opt-in

**Reason**: One runtime image remains and it bakes no R library and no Python
library, so a sandbox with no store mounted has no library at all. A switch that turns the store
off thus ships an unusable sandbox, and the off state has no working
behavior to fall back to.

**Migration**: Remove the `harness.libStore` boolean from the configuration. The
store root stays the fixed CLI-owned path it already is. The CLI resolves that one
path for the store commands, the store download, and the sandbox mount. The store
root stays distinct from the per-image package-inventory cache. An installation
that carries the removed key keeps working, because the key is inert and the
configuration reader reports it one time.
