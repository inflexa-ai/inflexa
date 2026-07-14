## Context

The harness Docker backend already accepts `refStorePath` and mounts it read-only at `/mnt/refs`, but the CLI composition root never supplies one. The CLI has no reference-store path, commands, receipts, or setup flow. At the same time, the harness companion change introduces a canonical catalog shared with managed deployment and makes sandbox discovery filesystem-driven.

The CLI owns host-local policy: platform paths, terminal interaction, public artifact resolution, downloads, activation, and what setup offers. It must preserve the repository's no-litter rule, never let Docker create a missing bind source, and never treat user-added reference data as installer-owned state.

## Goals / Non-Goals

**Goals:**

- Give users a stable, documented host directory whose content appears read-only at `/mnt/refs`.
- Install selected catalog datasets safely and reproducibly without a second catalog definition.
- Make setup and explicit commands share one dogfooded handler.
- Keep user-added data discoverable and outside installer cleanup/update ownership.
- Make scripted setup deterministic and prevent silent multi-GB downloads.

**Non-Goals:**

- Provisioning the managed deployment's PVC or object store.
- Downloading from within a sandbox.
- Importing arbitrary user files into the managed namespace or validating their scientific meaning.
- Maintaining reference installation state in SQLite.
- Supporting executable installer recipes or archive transformations in the first catalog format.

## Decisions

### The public store lives under the platform data home

`env.refsDir` resolves to `<data-home>/inflexa/refs` (`XDG_DATA_HOME`/`~/.local/share` on Unix and the existing platform equivalent on Windows). It is included in the root help Paths table, and `inflexa refs path` prints the exact resolved path. Setup and explicit reference commands are deliberate actions and may create it; passive launch and status-only flows do not.

The layout is:

```text
refs/
  managed/<dataset-id>/<version>/...  # immutable activated catalog content
  user/                                # recommended user-owned namespace
  .inflexa/
    receipts/<dataset-id>.json
    staging/<attempt>/...
    downloads/<artifact>.part
```

The `managed` and `.inflexa` namespaces are installer-owned. The CLI never deletes, rewrites, or adopts content under `user/` or unknown top-level paths.

### The CLI consumes install plans and resolves public artifact URLs

The CLI imports the harness catalog interface from the package barrel. Its adapter maps each plan artifact key to the configured public distribution base. Dataset source and licensing links remain catalog facts; the artifact base remains distribution configuration. The CLI does not copy or reinterpret catalog entries.

An alternative was a CLI catalog overlay. That would let supported options drift from managed deployment and undermine checksum identity.

### Installation stages a complete dataset before activation

The downloader computes the missing-byte plan before consent, downloads final-file artifacts to `.part` files, verifies byte size and SHA-256, and places them in a per-attempt staging directory using their validated relative destinations. Only after every artifact verifies does it atomically rename the staged dataset directory to `managed/<id>/<version>` and atomically write the active receipt.

Version directories are immutable. An update activates the new version in its receipt only after success; older managed versions are retained initially rather than being deleted under a running sandbox. `refs verify` hashes the receipt's active files on explicit request. Ordinary `refs list` performs a cheap receipt/path/size check and labels a dataset `missing`, `partial`, `installed`, `update available`, or `invalid receipt`.

The initial catalog contains final files rather than archives, so installation needs no extraction dependency and has no archive traversal surface.

### Commands form the reusable provisioning interface

- `inflexa refs list` renders every catalog option with version, description, download size, source/license links, and local state; it also notes unregistered top-level/user content without claiming ownership.
- `inflexa refs download [ids...]` accepts explicit ids or uses an interactive multi-select, shows total missing bytes, asks for confirmation unless `--yes`, and installs through the one handler.
- `inflexa refs verify [ids...]` verifies active managed files against catalog hashes; with no ids it verifies all installed catalog datasets.
- `inflexa refs path` prints `env.refsDir` without creating it.

The module's headless install operation takes selected ids and resolved policy and returns a typed outcome. Command rendering and setup consume that interface; they do not duplicate transfer logic.

### Setup offers references but never guesses in headless mode

Interactive `inflexa setup` creates the public store and `user/` namespace, inspects catalog state, and offers a size-labelled multi-select of missing or updateable datasets. A decline or empty selection continues. A selected download failure fails setup visibly so scripted/user-requested provisioning is not reported as complete.

Headless setup downloads nothing unless an explicit `--refs <id,...>` selection is supplied; explicit selection implies consent only when paired with the existing/non-interactive confirmation policy (`--yes` or the setup's explicit provisioning flag). Otherwise setup prints `inflexa refs download ...` guidance.

### Runtime wiring is existence-gated

The composition root passes `refStorePath: env.refsDir` only when the directory exists. This prevents Docker from creating a missing bind source as a root-owned empty directory and respects no-litter behavior. An existing empty directory is still mounted so discovery can distinguish empty from unmounted and user additions become visible to future sandboxes without config changes.

## Risks / Trade-offs

- **Reference files can be very large** → Calculate missing bytes before consent, stream to resumable `.part` files, verify before activation, and never auto-download headlessly.
- **Update leaves old versions on disk** → Accept bounded disk growth initially; add explicit managed-version reclamation later rather than deleting bytes used by a running sandbox.
- **Public distribution endpoint is unavailable** → Preserve prior active receipts and version directories; a failed staging attempt never changes activation.
- **User places files in a reserved namespace** → Document ownership clearly and refuse to adopt or overwrite unexpected managed paths.
- **Receipt and disk disagree after manual edits** → Report normal recoverable states and let `download` repair managed content; never touch user content.

## Migration Plan

1. Add the path and commands without creating anything on passive reads.
2. Add the installer and setup reuse over the harness catalog.
3. Wire the existing directory into sandbox creation conditionally.
4. Existing users have no migration: an absent store remains unmounted until setup, download, or manual directory creation.

Rollback removes the command and mount wiring without deleting the reference directory, receipts, managed versions, or user content.

## Open Questions

- The concrete public artifact base and initial catalog selections are release configuration/data, not architectural blockers for the provisioning interface.
