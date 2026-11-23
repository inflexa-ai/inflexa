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

The harness MUST give a `list_available_refs` tool. The tool reads the reference store on the host file system, and it gives each path at `/mnt/refs`, where a sandbox mounts the store. Thus the conversation agent and the planner can read the store before a sandbox exists. A step agent reads the same bytes as its mount.

The read root MUST be the `refStorePath` of the embedder when the embedder gives one, and `/mnt/refs` otherwise. A host process that mounts the store at `/mnt/refs`, for example a Kubernetes pod, thus sets nothing. The tool MUST do a check of the root before it reports. A root that does not exist MUST give an unavailable store.

The tool MUST accept an optional path below the root. With no path, the tool MUST give a bounded summary of the root. With a path, it MUST give that subtree. Each result MUST use an absolute `/mnt/refs/...` path. The tool MUST NOT resolve a symlink, and it MUST NOT list the `.inflexa/` directory of the store. A result that a limit cut MUST say so.

The tool MUST give an unavailable store, an empty store, and a populated store as data, with no error. The tool reads no manifest, no receipt, and no catalog. The files on disk are the whole inventory.

#### Scenario: Arbitrary mounted files are available without a manifest

- **WHEN** `/mnt/refs/user/cohort/reference.h5ad` exists and no record names it
- **THEN** `list_available_refs` gives that path in the root summary or in a bounded subtree result

#### Scenario: Store is mounted but empty

- **WHEN** the read root exists and contains no reference data
- **THEN** the tool gives an empty store, not a missing store

#### Scenario: A query that matches nothing with the download tool

- **GIVEN** an agent that has `download_ref`
- **WHEN** a query matches no reference in a populated store
- **THEN** the content says that no reference matches and that the sandbox has no network
- **AND** it says that the agent can download the reference into the store

#### Scenario: A query that matches nothing names the store as the only source

- **GIVEN** an agent that does not have `download_ref`
- **WHEN** a query matches no reference in a populated store
- **THEN** the content says to report the reference as absent

#### Scenario: Store is not mounted

- **WHEN** the read root does not exist or is not a directory
- **THEN** the tool gives an unavailable store with a note, and no error

#### Scenario: An unconfigured embedder reads the container mountpoint

- **GIVEN** an embedder that gives no `refStorePath`
- **WHEN** the tool reads the store
- **THEN** it reads `/mnt/refs`, and it gives the same result as an embedder that gives `/mnt/refs`

#### Scenario: Deep inventory is bounded

- **WHEN** a subtree is larger than the limit of the scan or of the output
- **THEN** the tool gives the bounded entries and a note to use a narrower path

#### Scenario: Traversal outside the store is rejected

- **WHEN** the optional path is outside `/mnt/refs` or contains `..`
- **THEN** the tool gives an out-of-scope result and reads nothing outside the store

#### Scenario: The source record is not reference data

- **WHEN** the store holds `.inflexa/sources.jsonl`
- **THEN** no listing and no search result names a path under `/mnt/refs/.inflexa`

### Requirement: No environment variables are injected for the reference store

The sandbox container SHALL NOT receive any reference-store environment
variables. The mount plan SHALL emit no ref-store env; agents discover reference
paths exclusively through `list_available_refs`.

#### Scenario: No ref-store env on the container

- **WHEN** a sandbox is created with a reference store mounted
- **THEN** the container env contains no reference-store variables

### Requirement: Discovery takes a quick look at each file

For each file that a listing or a search gives, `list_available_refs` MUST give a look at the start of the file. The look gives the format, and the first lines of a text file. The look MUST read at most 16 KB, and it MUST decompress the start of a gzip file. A query MUST match the path and the text of the look, with no case.

#### Scenario: A file found by its content

- **GIVEN** `/mnt/refs/mine/sets.gmt`, whose first line starts with `HALLMARK_APOPTOSIS`
- **WHEN** an agent calls `list_available_refs` with the query `hallmark`
- **THEN** the result names `/mnt/refs/mine/sets.gmt` with its first lines

#### Scenario: A compressed table

- **GIVEN** a `.tsv.gz` file in the store
- **WHEN** a listing gives it
- **THEN** its look gives the columns of the first line of the decompressed text

#### Scenario: A binary file

- **GIVEN** an `.h5ad` file in the store
- **WHEN** a listing gives it
- **THEN** its look gives the format and no text

### Requirement: The look at a file is cached

The tool MUST keep each look in a cache. The key is the store path, the size, and the modification time of the file. The tool MUST NOT read a file whose key is in the cache. The cache MUST be in `<store>/.inflexa/peek-cache.json` when the host can write the store, and in memory otherwise. A call MUST make at most 200 new looks. A file past that limit MUST match on its path only, and the result MUST say so.

#### Scenario: A second call reads no file

- **GIVEN** a call that looked at each file of the store
- **WHEN** a second call lists the same files, and no file changed
- **THEN** the second call reads no file content

#### Scenario: A changed file

- **GIVEN** a cached look of a file
- **WHEN** a file of a different size replaces the file
- **THEN** the next call looks at the file again

#### Scenario: A read-only store

- **GIVEN** a store that the host process cannot write
- **WHEN** a call looks at files
- **THEN** the call succeeds, and the cache stays in memory
