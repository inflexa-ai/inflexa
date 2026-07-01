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
(`src/tools/sandbox/list-available-refs.ts`), which reads
`/mnt/refs/registry.json` — a machine-generated manifest of every reference
file grouped by category — and renders it into agent-readable paths. Each file's
absolute path is `/mnt/refs/<local_path>` from its registry entry. No
environment variables are injected for the ref store; the tool is the sole
discovery surface.

The store is supplied by the embedder: the Docker backend bind-mounts a host
directory (`refStorePath`), the Kubernetes backend mounts a read-only PVC
(`refStorePvc`). How the reference data is *built, versioned, and published* is
owned by a separate reference-store build pipeline in another repository and is
out of scope here — this spec describes only the runtime mount contract, the
`registry.json` shape the tool consumes, and the discovery surface.

## Requirements

### Requirement: The reference store is a read-only mount at /mnt/refs

When a reference store is configured, the sandbox container SHALL receive it as a
**read-only** mount at `/mnt/refs`. The Docker backend SHALL bind-mount the host
directory named by `refStorePath`; the Kubernetes backend SHALL mount the PVC
named by `refStorePvc`. When neither is configured, the container SHALL receive
no `/mnt/refs` mount.

#### Scenario: Docker bind-mounts the host ref store read-only

- **GIVEN** `refStorePath` is set to a host directory
- **WHEN** a Docker sandbox is created
- **THEN** the container has a read-only bind of that directory at `/mnt/refs`

#### Scenario: Kubernetes mounts the ref-store PVC read-only

- **GIVEN** `refStorePvc` is set
- **WHEN** a sandbox pod spec is built
- **THEN** the pod mounts that PVC read-only at `/mnt/refs`

#### Scenario: No ref store configured

- **GIVEN** neither `refStorePath` nor `refStorePvc` is set
- **WHEN** a sandbox is created
- **THEN** the container has no `/mnt/refs` mount

### Requirement: References are discoverable via the list_available_refs tool

The harness SHALL expose a `list_available_refs` tool (built with `defineTool`)
that reads `/mnt/refs/registry.json`, resolves each entry's path to
`/mnt/refs/<local_path>`, and returns a rendered inventory grouped by category.
A missing or unmounted store is an expected state: the tool SHALL NOT throw — it
SHALL return an `available: false` data variant carrying a fallback note.

#### Scenario: References available

- **WHEN** `list_available_refs` is called and `/mnt/refs/registry.json` is readable
- **THEN** it returns `{ available: true, content }` listing categories with absolute `/mnt/refs/<local_path>` paths

#### Scenario: Store not mounted

- **WHEN** `list_available_refs` is called and the registry cannot be read
- **THEN** it returns `{ available: false, content }` advising that the reference store may not be mounted at `/mnt/refs`, without throwing

### Requirement: The registry.json manifest defines the discoverable inventory

`/mnt/refs/registry.json` SHALL carry `registry_version`, `build_id`,
`generated_at`, a `files.by_category` map of category name to an array of file
entries, and a `summary` with `total_output_files` and `categories`. Each file
entry SHALL carry at least `local_path` (relative to `/mnt/refs`) and `sha256`,
plus optional descriptive fields (`bytes`, `rows`, `category`, `subtype`,
`organism`, `tax_id`, `dataset`, `endpoint`) the tool uses to group and label
output.

#### Scenario: Registry groups files by category

- **GIVEN** a `registry.json` with `files.by_category` populated
- **WHEN** `list_available_refs` renders it
- **THEN** each category becomes a section listing its files by name and `/mnt/refs/<local_path>` path

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
- **THEN** it directs the agent to use `list-available-refs` for pre-staged reference data and states there is no network access for runtime downloads
