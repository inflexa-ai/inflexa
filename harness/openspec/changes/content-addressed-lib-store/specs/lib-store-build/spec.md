## ADDED Requirements

### Requirement: The build can publish a content-addressed store alongside the track tarballs

The build SHALL be able to emit the package set as per-distribution, content-addressed directories in addition to the per-track tarballs it already produces. The two forms SHALL describe the same package set for a given manifest and architecture, and either SHALL be usable as `/mnt/libs` without a change to the runtime contract.

The content-addressed form SHALL carry the same `packages.txt`, produced by the same generator, so a consumer cannot tell from the inventory which form it received.

#### Scenario: Both forms describe the same package set

- **GIVEN** one manifest and one architecture
- **WHEN** the build emits both the track tarballs and the content-addressed store
- **THEN** the package names and versions in each are identical

#### Scenario: Either form mounts unchanged

- **GIVEN** a content-addressed store assembled into a farm
- **WHEN** it is mounted at `/mnt/libs`
- **THEN** the sandbox resolves imports exactly as it does from an extracted tarball store

### Requirement: The content-addressed store publishes to GHCR as an OCI artifact

The build SHALL publish the content-addressed store to GHCR as an OCI artifact,
through an ORAS push. It SHALL push one artifact for each architecture, with one
layer for each track. The OCI manifest SHALL carry the sha256 digest of each
layer. A
version tag SHALL be immutable in content: the build SHALL refuse to publish a
version again with different content, rather than move the tag. A `latest`
pointer SHALL be a tag move only. The artifact SHALL be pullable anonymously,
over https, with no credentials.

#### Scenario: One artifact for each architecture

- **WHEN** the build publishes the store for an architecture
- **THEN** it pushes one OCI artifact whose layers are the tracks of that architecture, and each layer descriptor carries its sha256 digest

#### Scenario: A version built again with different bytes is refused

- **GIVEN** a published version tag
- **WHEN** the build publishes the same version with different content
- **THEN** the push fails loudly, and the tag does not move

#### Scenario: An anonymous consumer can pull

- **GIVEN** a published store artifact
- **WHEN** a client with no credentials requests the token, the manifest, and a blob, over https
- **THEN** the registry serves each of them

### Requirement: Cache preparation is verified to take effect at run time

The build SHALL verify that prepared caches are used by the runtime rather than merely present on disk. It SHALL run a workload that exercises compiled-on-first-call code under the unprivileged runtime user against the read-only store, and SHALL count cache loads against cache writes. A run that writes a new cache entry for a prepared code path SHALL fail the check.

Presence of cache files SHALL NOT be accepted as evidence that the cache is effective.

#### Scenario: An ineffective prepared cache fails the build

- **GIVEN** a store whose caches are written where the runtime cannot read them
- **WHEN** the verification workload runs
- **THEN** the check observes cache writes at run time and fails

#### Scenario: An effective prepared cache passes

- **GIVEN** a store whose caches are prepared where the runtime reads them
- **WHEN** the verification workload runs
- **THEN** the check observes only cache loads and passes

### Requirement: A store is validated against an equivalently built image

The build SHALL validate a content-addressed store by comparing it against an image built from the same manifest, requiring the resolved versions and the import results to agree for every advertised package.

#### Scenario: A divergent store fails validation

- **GIVEN** a store and an image built from the same manifest
- **WHEN** a package resolves to a different version in each, or imports in one and not the other
- **THEN** validation fails and names the package

## MODIFIED Requirements

### Requirement: The store ships as per-track, self-describing tarballs

The build SHALL package the library store as one tarball per **track** —
`cran`, `bioconductor`, `github`, `python`, `conda`, `node` — rather than one
combined archive. Each track tarball SHALL carry its own `packages.txt` fragment
listing that track's contents. Both architectures SHALL attempt every track; the
set of track tarballs produced for an arch SHALL be exactly those that met the
non-empty floor for that arch (best-effort), rather than a fixed per-arch set.

This form remains the published artifact for the managed mount only, until the
managed delivery change replaces it (decoupled, 2026-08-05). It is one of two
forms the build can emit. The content-addressed store is the other, and it is the
published artifact for the CLI channel.

#### Scenario: A track tarball carries its own fragment

- **WHEN** the build produces the `python` track tarball
- **THEN** it carries a `packages.txt` fragment listing exactly that track's loaded packages

#### Scenario: The produced track set is what passed the floor

- **WHEN** the build runs for an architecture
- **THEN** it produces a tarball for each track that met the non-empty floor on that arch, and none for a track that produced no loadable package

#### Scenario: Emitting the content-addressed form does not change the tarballs

- **WHEN** the build emits both forms
- **THEN** the track tarballs, their fragments, and their digests are what they would have been without the second form
