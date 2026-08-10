## MODIFIED Requirements

### Requirement: The library store is a read-only mount at /mnt/libs

When a library store is configured, the sandbox container SHALL receive it as a
**read-only** mount at `/mnt/libs`, with the active version at
`/mnt/libs/current`. The Docker backend SHALL bind-mount the host directory named
by `libStorePath`. The Kubernetes backend SHALL mount the PVC named by
`libStorePvc`. When neither is configured, the container SHALL receive no
`/mnt/libs` mount and no lib-store env.

No runtime image bakes an R library or a Python library. Thus the mounted store
SHALL be the one source of a library for a sandbox. A sandbox that receives no
`/mnt/libs` mount SHALL carry the language runtimes, the image-owned conda tools
and Node packages, and no library. The absence of a store is not a fall back to a
smaller library set. It is an empty library environment, and an embedder SHALL
treat it as such.

The store SHALL carry packages only. It SHALL carry the packages of the two tracks
a farm can carry, which are the Python packages and the R packages. It SHALL NOT
carry a language interpreter, thus no store changes the R version, the Python
version, or the Node version. The runtime image owns each interpreter, the system
libraries, the conda prefix, and the Node packages.

The conda prefix and the Node packages SHALL live in the runtime image, at a path
outside `/mnt/libs`. A conda prefix carries its absolute path in each shebang and
each RPATH. Thus it cannot resolve from a mount whose path a publish step swaps.
As a result a farm SHALL NOT hold a `conda` directory and SHALL NOT hold a `node`
directory.

The image advertises its two owned tracks — the bioconda command-line tools and
the Node packages — through a baked inventory fragment. The fragment SHALL live at
a path outside `/mnt/libs`, thus a mounted store never shadows it. The
`list_available_packages` tool SHALL merge the farm inventory and the image
fragment. Thus an agent reads one complete package list that names each of the four
tracks.

The dependency runs from the image to the store, and never the other way. Each
stored compiled package matches the ABI of the interpreter the image carries. A
change of the interpreter obliges a rebuild of the compiled packages of the store.
A change of the store SHALL NOT oblige a change of the image.

The store root MAY hold, in addition to `current`, a content-addressed package
directory at `/mnt/libs/store` and one or more per-analysis farms under
`/mnt/libs/farms`, with `current` resolving to the active farm. A farm SHALL
present the same interior layout as an extracted-tarball store, so the resolver
env and the Python `.pth` retain their meaning whichever way the store was
assembled. Because the whole store root is a single mount, farm links into
`/mnt/libs/store` SHALL resolve without an additional mount.

#### Scenario: Docker bind-mounts the host lib store read-only

- **GIVEN** `libStorePath` is set to a host directory
- **WHEN** a Docker sandbox is created
- **THEN** the container has a read-only bind of that directory at `/mnt/libs`

#### Scenario: Kubernetes mounts the lib-store PVC read-only

- **GIVEN** `libStorePvc` is set
- **WHEN** a sandbox pod spec is built
- **THEN** the pod mounts that PVC read-only at `/mnt/libs`

#### Scenario: No lib store configured

- **GIVEN** neither `libStorePath` nor `libStorePvc` is set
- **WHEN** a sandbox is created
- **THEN** the container has no `/mnt/libs` mount, no lib-store env vars, and no importable R or Python library

#### Scenario: The image-owned tracks survive a mount

- **GIVEN** a sandbox created with a store mounted at `/mnt/libs`
- **WHEN** a script runs a bioconda command-line tool or requires a baked Node package
- **THEN** both resolve from the image, because the store carries neither track and shadows neither path

#### Scenario: The inventory merges the farm tracks and the image tracks

- **GIVEN** a sandbox with a store mounted at `/mnt/libs` and the image inventory fragment outside it
- **WHEN** `list_available_packages` reads the inventory
- **THEN** it reports the farm's Python and R tracks with the image's command-line tools and Node packages, as one list

#### Scenario: A farm carries no conda directory and no node directory

- **WHEN** the provisioner assembles a farm
- **THEN** the farm holds the Python track and the R track only, and it holds no `conda` directory and no `node` directory

#### Scenario: A farm resolves through the store mount

- **GIVEN** a store root whose `current` resolves to a farm of symbolic links into `/mnt/libs/store`
- **WHEN** a sandbox is created against it
- **THEN** imports resolve through the farm with no mount beyond `/mnt/libs`

#### Scenario: An extracted store and a farm are indistinguishable to the runtime

- **GIVEN** two stores holding the same package set, one extracted from tarballs and one assembled as a farm
- **WHEN** a sandbox resolves an import in each
- **THEN** the resolved module and its version are the same in both

### Requirement: The lib-store resolver env is injected only when the store is mounted

When the lib store is mounted, the mount plan SHALL emit the package-resolver
env so language runtimes resolve imports against `/mnt/libs/current`:
`R_LIBS_SITE` covering the github/bioconductor/cran subtrees, and `PATH`
including `/opt/conda/bin`. `NODE_PATH` SHALL be `/opt/node/node_modules`.
`PYTHONPATH` SHALL NOT be set — system Python resolves the store through a `.pth`
file. When the store is not mounted, none of these vars SHALL be emitted.

`PATH` and `NODE_PATH` name a path in the runtime image, not a path under
`/mnt/libs`. The image owns the conda track and the Node track, thus the injected
env SHALL name the image paths. An injected `PATH` that named a store path would
remove the command-line tools of the image from each sandbox that has a store.

#### Scenario: Resolver env present with the store mounted

- **GIVEN** the lib store is mounted
- **WHEN** the mount plan is built
- **THEN** `R_LIBS_SITE`, `NODE_PATH`, and a conda-`bin` `PATH` are emitted and `PYTHONPATH` is absent

#### Scenario: The injected env names the image paths

- **GIVEN** the lib store is mounted
- **WHEN** the mount plan is built
- **THEN** `PATH` carries `/opt/conda/bin`, `NODE_PATH` is `/opt/node/node_modules`, and neither names a path under `/mnt/libs`
