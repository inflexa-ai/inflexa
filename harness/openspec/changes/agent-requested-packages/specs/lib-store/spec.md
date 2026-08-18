# lib-store Specification

## ADDED Requirements

### Requirement: A step requests a package into the farm of its analysis

The harness MUST declare a farm-extension seam. The seam takes an analysis id and
a set of requests. It gives one outcome for each request. The embedder MUST bind
a realization, because the embedder composes a farm and the harness mounts one.

A request MUST name a distribution requirement or an import name. The evidence
that a step holds is an import failure, thus it holds a module name. A module
name and a distribution name are not the same, thus the seam MUST accept both.

A requirement MUST carry an optional version. A request with no version MUST take
the newest store directory of that name. A request with a version MUST take the
match, or it MUST refuse.

The seam MUST link from the pool. It MUST NOT acquire a package, thus it starts
no container and it opens no network connection. An acquisition is the work of a
planner, before a run.

An outcome MUST name one of four states: the request is linked, the farm held it
already, the pool does not hold it, or the farm already links another version of
that name. A state that the pool cannot answer MUST say whether an acquisition of
that ecosystem is possible at all. The store cannot acquire an R package, thus a
generic refusal would make an agent try again forever.

A version collision MUST tell the caller to report it and to stop. A farm holds
one version of a top-level name, thus no retry of that request can succeed.

The harness MUST give this seam to a sandbox agent as the tool `link_packages`.
The name states the whole of what the tool does: it links, and it installs
nothing.

The harness MUST NOT derive the location of a farm. That rule already binds the
farm provider, and it binds this seam for the same reason: the layout of the
store belongs to the embedder.

#### Scenario: A step reaches a package that the pool holds

- **GIVEN** a live sandbox whose farm lacks a package that the pool holds
- **WHEN** the step requests it
- **THEN** the farm links it, and the next import inside that same sandbox resolves it

#### Scenario: An import name resolves to its distribution

- **GIVEN** a step that met an import failure for `sklearn`
- **WHEN** it requests that import name
- **THEN** the seam links the distribution that gives it, and it never asks the step for a distribution name

#### Scenario: A request with no version takes the newest

- **GIVEN** a pool that holds two versions of one distribution
- **WHEN** a request names that distribution and no version
- **THEN** the seam links the newest of the two

#### Scenario: A package the pool does not hold refuses with its reason

- **GIVEN** a request for a distribution that the pool does not hold
- **WHEN** the seam answers
- **THEN** it refuses, it names the distribution, and it states that an acquisition is a host action

#### Scenario: An R package that the pool does not hold names its own reason

- **GIVEN** a request for an R package that the catalog does not carry
- **WHEN** the seam answers
- **THEN** it refuses and it states that this store cannot acquire an R package, thus no retry succeeds

#### Scenario: A version collision stops the request

- **GIVEN** a farm that links pandas from one store directory
- **WHEN** a step requests pandas at a different version
- **THEN** the outcome names both store directories, and it tells the step to report and to stop

#### Scenario: An embedder that binds no realization has no capability

- **GIVEN** an embedder that binds no farm-extension seam
- **WHEN** a sandbox agent is composed
- **THEN** no `link_packages` tool exists, and no code branches on which realization is bound

## MODIFIED Requirements

### Requirement: The lib-store resolver env is injected only when the store is mounted

When the lib store is mounted, the mount plan MUST emit the package-resolver
env so language runtimes resolve imports against `/mnt/libs/current`:
`R_LIBS_SITE` covering the github/bioconductor/cran subtrees, and `PATH`
with `/opt/conda/bin` in it. `NODE_PATH` MUST be `/opt/node/node_modules`.
`PYTHONPATH` MUST NOT be set — system Python resolves the store through a `.pth`
file. When the store is not mounted, the plan MUST emit none of these vars.

The image paths MUST lead `PATH`, and `NODE_PATH` MUST name an image path only.
The image owns the conda track and the Node track. A `PATH` that put a store path
before the image paths would let a farm shadow the command-line tools of the
image.

The `bin` directory of the farm MUST append at the end of `PATH`. A farm hoists
the console scripts of its packages there, and without that entry no script of a
farm is callable by name. The image paths come first, thus a farm script MUST
NOT shadow an image tool. A farm with no `bin` directory costs nothing, because
a `PATH` lookup skips an absent directory.

#### Scenario: A console script of a farm is callable by name

- **GIVEN** a farm whose `python/bin` holds a hoisted console script
- **WHEN** a sandbox runs that script by its bare name
- **THEN** the script resolves through the farm entry at the end of `PATH`

#### Scenario: An image tool always wins over a farm script

- **GIVEN** a farm script and an image tool that share one name
- **WHEN** a sandbox runs that name
- **THEN** the image tool resolves, because the image paths come before the farm entry

### Requirement: Package installation is host-mediated and never reaches the sandbox

A sandbox step MUST NOT install packages. The library store MUST stay read-only
to the sandbox, and the sandbox MUST hold no network egress. Any change to the
package set MUST be the work of the host, outside the sandbox.

A change reaches a sandbox by two routes, and the two are different. A package
that arrives in the pool alone reaches only a sandbox that a later composition
serves. An extension of the farm of an analysis reaches the live sandbox of that
analysis, because a bind reflects a new link at once.

Sandbox agent instructions MUST direct agents to call `list_available_packages`
before an import of a package that they are not certain is staged. The lookup
MUST name only the packages that they intend to import. It is targeted and
conditional. A dump of the catalog up front is what it is not.

Those instructions MUST state that the agent installs no package itself. When the
farm-extension seam is bound, they MUST also state that the agent can request a
package that the store already holds. They MUST NOT state that the environment is
unchangeable.

#### Scenario: The sandbox cannot install a package

- **GIVEN** a sandbox step that runs
- **WHEN** it attempts to install a package
- **THEN** the attempt fails, because there is no egress and the store mount is read-only

#### Scenario: Sandbox standards describe discovery and the real limit

- **GIVEN** the shared sandbox-agent standards prompt
- **THEN** it directs the agent to look a package up with `list_available_packages` before an import of one that it is not certain is present
- **AND** it states that the agent installs none itself

#### Scenario: A provisioned package appears in the next sandbox

- **GIVEN** a store to which the host added a package
- **WHEN** a new sandbox is created against that store
- **THEN** the package is importable and it appears in `list_available_packages`

#### Scenario: A pool addition alone does not reach a live sandbox

- **GIVEN** a live sandbox whose farm does not link a package
- **WHEN** the host acquires that package into the pool and extends no farm
- **THEN** the view of that sandbox is unchanged

#### Scenario: An extension of the farm reaches the live sandbox

- **GIVEN** a live sandbox of one analysis
- **WHEN** the host extends the farm of that analysis
- **THEN** the next import inside that sandbox resolves the new links, with no restart
