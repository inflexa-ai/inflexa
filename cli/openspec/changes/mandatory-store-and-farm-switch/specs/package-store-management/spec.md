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
active farm, the list of what the store holds, the preview of a reclamation, and
the switch of the active farm.

The provisioner image is large, so a container start is a real cost. A read or a
pointer move SHALL NOT pay it.

#### Scenario: Listing starts no container

- **WHEN** `inflexa store ls` runs
- **THEN** it reads the store on the host and starts no container

#### Scenario: Switching the active farm starts no container

- **WHEN** `inflexa store use <farm>` runs
- **THEN** it writes the active-farm pointer on the host and starts no container

#### Scenario: A reclaim preview starts no container

- **WHEN** the CLI reports what a reclamation would remove
- **THEN** it computes the set on the host and starts no container

#### Scenario: An install starts the container

- **WHEN** `inflexa store add <spec>` runs
- **THEN** the provisioner container starts with a network, and it installs the closure

### Requirement: `inflexa store use <farm>` switches the active farm

The CLI SHALL give `inflexa store use <farm>`, which makes the named farm the
active farm of the store. It SHALL take the `approval` policy, because it writes
the active-farm pointer and thereby changes what every later sandbox mounts.

The write SHALL be atomic. The CLI SHALL make the new link at a temporary name in
the store root, then SHALL rename that name over the active-farm pointer. The
pointer SHALL NOT be absent at any moment, because a sandbox created while it is
absent silently drops the store mount.

The command SHALL switch the active farm and SHALL NOT merge two farms. There
SHALL be no option that joins the contents of two farms.

The command SHALL refuse, with a message naming what to do, in each of these
cases:

- The harness runtime is live, which the machine-wide runtime instance lock
  reports. A `--force` option SHALL cover a lock that a killed process left
  behind. That option SHALL name the risk to a live sandbox before it writes.
- A store download is in flight, which the download state reports as incomplete.
- The named farm is absent under the farms path.
- The named farm is incomplete. A complete farm carries the shape the harness
  mount check needs: a directory that holds both the package inventory and the
  store metadata file.
- The named farm has a dot-prefixed name, which marks staging or superseded
  debris rather than a farm.

`--force` SHALL bypass the live-runtime refusal, and it SHALL bypass no other
refusal. It SHALL NOT bypass the refusal for an absent farm. It SHALL NOT bypass
the refusal for an incomplete farm. It SHALL NOT bypass the refusal for an
in-flight download, and it SHALL NOT bypass the refusal for a dot-prefixed name.

Those four refusals protect the pointer itself. A forced pointer that no sandbox
can mount trades a clear refusal for a store the harness rejects at every later
sandbox.

#### Scenario: A switch is atomic

- **GIVEN** a store whose active farm is `default`
- **WHEN** `inflexa store use catalog` runs
- **THEN** the pointer resolves to `default` before the rename and to `catalog` after it, and it resolves at every moment in between

#### Scenario: A live runtime refuses the switch

- **GIVEN** a live harness runtime that holds the machine-wide runtime lock
- **WHEN** `inflexa store use catalog` runs without `--force`
- **THEN** the command refuses, names the live runtime, and leaves the pointer unchanged

#### Scenario: A stale lock yields to `--force`

- **GIVEN** a runtime lock whose holder process is gone
- **WHEN** `inflexa store use catalog --force` runs
- **THEN** the command names the risk to a live sandbox, switches the farm, and reports the new active farm

#### Scenario: An in-flight download refuses the switch

- **GIVEN** a store download that reports an incomplete state
- **WHEN** `inflexa store use catalog` runs
- **THEN** the command refuses, names the download, and leaves the pointer unchanged

#### Scenario: A farm the harness would not mount is refused

- **GIVEN** a directory under the farms path that carries no package inventory
- **WHEN** `inflexa store use` names it
- **THEN** the command refuses, names the missing records, and leaves the pointer unchanged

#### Scenario: `--force` still refuses an incomplete farm

- **GIVEN** a directory under the farms path that carries no package inventory
- **WHEN** `inflexa store use` names it with `--force`
- **THEN** the command refuses, names the missing records, and leaves the pointer unchanged

#### Scenario: `--force` still refuses an absent farm and an in-flight download

- **GIVEN** a farm name that no directory under the farms path carries, and separately a download that reports an incomplete state
- **WHEN** `inflexa store use` runs with `--force` in each case
- **THEN** the command refuses in both, and it leaves the pointer unchanged in both

#### Scenario: A dot-prefixed name is refused

- **WHEN** `inflexa store use .catalog-staging` runs
- **THEN** the command refuses, says the name marks staging or superseded debris, and leaves the pointer unchanged

#### Scenario: The command never merges

- **GIVEN** an active farm and a second farm with different packages
- **WHEN** the user switches to the second farm
- **THEN** the store resolves the second farm only, and no command joins the two

### Requirement: A download that adds an unreachable farm names the remedy

The CLI SHALL report, by name, each farm a store download added while it left the
active-farm pointer alone. It SHALL name the command that switches to that farm.
The CLI SHALL NOT switch the active farm by itself, because a switch changes what
every later sandbox mounts.

#### Scenario: An added farm is reported with its remedy

- **GIVEN** a store whose active-farm pointer already selects a local farm
- **WHEN** a download adds a published farm and leaves the pointer alone
- **THEN** the CLI reports the added farm by name and names `inflexa store use <farm>`

#### Scenario: A download that set the pointer suggests nothing

- **GIVEN** a store root that carried no active-farm pointer
- **WHEN** a download adds a farm and sets the pointer to it
- **THEN** the CLI reports the active farm and suggests no switch

## MODIFIED Requirements

### Requirement: The store can be inspected and reclaimed

The CLI SHALL report what a store holds — its packages, the farms defined against it, and the disk each occupies. It SHALL give a way to remove a farm, and a way to remove store content that no farm references. Reclamation SHALL never run implicitly as a side effect of another command.

The inspection SHALL also report the state of the active-farm pointer and the
track set of each farm. It SHALL say when the pointer resolves to nothing, because
that state makes every sandbox unusable and the user cannot see it otherwise. It
SHALL say which tracks each farm carries. A farm with fewer tracks than another is
the reason an import fails after a switch.

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

#### Scenario: A pointer that resolves to nothing is reported

- **GIVEN** a store whose active-farm pointer names a farm that is gone
- **WHEN** the user inspects the store
- **THEN** the output says the pointer resolves to nothing, and names the command that switches to a farm

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
