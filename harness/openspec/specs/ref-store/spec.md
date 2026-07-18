# ref-store Specification

## Purpose

Bioinformatics analysis needs large pre-staged reference data — single-cell
atlases, CellTypist models, marker panels, gene signatures, normal-tissue
references, gene-ID mappings, and network/pathway/gene-set resources (OmniPath,
Reactome, PROGENy, CollecTRI, DoRothEA, WikiPathways, MSigDB, LINCS, HPA, …).
This data is too large to bake into the sandbox image and must not be fetched at
runtime (sandboxes have no network). It lives in a shared **reference store**
mounted **read-only** into every sandbox container at `/mnt/refs`.

Agents discover what is staged through the `list_available_refs` tool
(`src/tools/sandbox/list-available-refs.ts`), which inspects the filesystem
actually mounted at `/mnt/refs`. Catalog receipts and a legacy `registry.json`
may enrich that inventory, but neither metadata source defines what files are
available. No environment variables are injected for the ref store; the tool
is the sole discovery surface.

The store is supplied by the embedder: the Docker backend bind-mounts a host
directory (`refStorePath`), the Kubernetes backend mounts a read-only PVC
(`refStorePvc`). How the reference data is *built, versioned, and published* is
owned by a separate reference-store build pipeline in another repository and is
out of scope here — this spec describes only the runtime mount contract,
filesystem-driven discovery, and optional metadata enrichment.

## Requirements

### Requirement: The reference store is a read-only mount at /mnt/refs

When a reference store is configured, the sandbox container SHALL receive it as a
**read-only** mount at `/mnt/refs`. The Docker backend SHALL evaluate the host
directory named by `refStorePath` at **each sandbox creation** — never from a
snapshot taken at embedder boot — and SHALL bind-mount it iff the path is, at
that moment, a real directory (symlinks rejected: the bind authority must itself
be the store, not an indirection). The Docker backend SHALL NOT create a bind
whose host source is missing, since the engine would auto-create a root-owned
directory at that path. A `refStorePath` that does not name a real directory at
creation time SHALL be treated as "no store yet" — a normal cold state, skipped
without a warning (deliberately unlike the lib store's missing-store path, which
is a degradation and warns). The Kubernetes backend SHALL mount the PVC named by
`refStorePvc`. When neither is configured, the container SHALL receive no
`/mnt/refs` mount.

#### Scenario: Docker bind-mounts the host ref store read-only

- **GIVEN** `refStorePath` is set and names an existing host directory
- **WHEN** a Docker sandbox is created
- **THEN** the container has a read-only bind of that directory at `/mnt/refs`

#### Scenario: A store installed mid-session is visible to the next sandbox

- **GIVEN** `refStorePath` is set but the directory does not exist when the embedder boots
- **WHEN** the directory is created (e.g. a reference download completes) and a Docker sandbox is created afterwards
- **THEN** the container has a read-only bind of that directory at `/mnt/refs`, without any runtime restart

#### Scenario: A missing store is skipped without side effects

- **GIVEN** `refStorePath` is set but the directory does not exist at sandbox creation
- **WHEN** a Docker sandbox is created
- **THEN** the container has no `/mnt/refs` mount, no directory is created at `refStorePath`, and no warning is logged

#### Scenario: A symlinked store path is not a bind authority

- **GIVEN** `refStorePath` names a symlink (even one resolving to a directory)
- **WHEN** a Docker sandbox is created
- **THEN** the container has no `/mnt/refs` mount

#### Scenario: Kubernetes mounts the ref-store PVC read-only

- **GIVEN** `refStorePvc` is set
- **WHEN** a sandbox pod spec is built
- **THEN** the pod mounts that PVC read-only at `/mnt/refs`

#### Scenario: No ref store configured

- **GIVEN** neither `refStorePath` nor `refStorePvc` is set
- **WHEN** a sandbox is created
- **THEN** the container has no `/mnt/refs` mount

### Requirement: References are discoverable via the list_available_refs tool

The harness SHALL expose a dependency-bearing `list_available_refs` tool that
inspects the reference filesystem visible inside the active sandbox at
`/mnt/refs`. The tool SHALL accept an optional path constrained beneath that
root: an omitted path SHALL return a bounded root summary and a supplied path
SHALL drill into that subtree. Results SHALL use absolute `/mnt/refs/...` paths,
SHALL NOT follow symlinks, SHALL exclude reserved installer metadata from the
data inventory, and SHALL report truncation explicitly when traversal or output
limits are reached.

The tool SHALL distinguish an unmounted store, a mounted but empty store, and a
populated store without throwing for any of those expected states. It SHALL
execute through the shared sandbox-exec runner with replay-stable identity and
workflow execution mode so discovery observes the same mount as analysis
commands.

#### Scenario: Arbitrary mounted files are available without a manifest

- **WHEN** `/mnt/refs/user/cohort/reference.h5ad` exists and no `registry.json` or receipt names it
- **THEN** `list_available_refs` reports that path through the root summary or a bounded drill-down result

#### Scenario: Store is mounted but empty

- **WHEN** `/mnt/refs` is mounted and contains no reference data
- **THEN** the tool returns an available-but-empty result rather than a missing-store result

#### Scenario: Store is not mounted

- **WHEN** the active sandbox has no `/mnt/refs` mount
- **THEN** the tool returns an unavailable data variant with an actionable note, without throwing

#### Scenario: Deep inventory is bounded

- **WHEN** a requested subtree exceeds the traversal or output limit
- **THEN** the tool returns the bounded entries plus an explicit truncation or drill-down hint

#### Scenario: Traversal outside the store is rejected

- **WHEN** the optional path is absolute outside `/mnt/refs` or contains traversal escaping the root
- **THEN** the tool returns an out-of-scope data result and performs no scan outside the store

### Requirement: Catalog and store metadata only enrich filesystem discovery

When a valid harness receipt or legacy `registry.json` describes a path that exists on disk, `list_available_refs` SHALL use its dataset name, version,
provenance, category, or descriptive fields to enrich the rendered inventory.
Metadata SHALL NOT add nonexistent files, hide unregistered files, or override
the observed path and size of a filesystem entry.

#### Scenario: Managed and user content are merged

- **WHEN** a store contains a receipted managed dataset and unregistered content under `user/`
- **THEN** discovery reports both, enriching the managed entry and listing the user content from the filesystem

#### Scenario: Stale metadata is ignored

- **WHEN** metadata names a file that no longer exists
- **THEN** discovery omits the nonexistent file and continues reporting the remaining filesystem content

### Requirement: No environment variables are injected for the reference store

The sandbox container SHALL NOT receive any reference-store environment
variables. The mount plan SHALL emit no ref-store env; agents discover reference
paths exclusively through `list_available_refs`.

#### Scenario: No ref-store env on the container

- **WHEN** a sandbox is created with a reference store mounted
- **THEN** the container env contains no reference-store variables

### Requirement: Sandbox agent prompts direct agents to the reference store

Sandbox-agent instructions SHALL direct agents to use pre-staged reference files
discovered via `list_available_refs`, and SHALL NOT instruct agents to test
internet connectivity, download resources at runtime, or fall back to network
sources.

#### Scenario: Shared sandbox standards point at the ref store

- **GIVEN** the shared sandbox-agent standards prompt
- **THEN** it directs the agent to use `list_available_refs`, narrowed to the collection it needs, for pre-staged reference data, and states there is no network access for runtime downloads
