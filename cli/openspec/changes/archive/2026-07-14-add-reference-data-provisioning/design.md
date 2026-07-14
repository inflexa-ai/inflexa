## Context

The harness Docker backend already accepts `refStorePath` and mounts it read-only at `/mnt/refs`, but the CLI composition root never supplies one. The CLI has no reference-store path, commands, receipts, or setup flow. At the same time, the harness companion change introduces a canonical catalog shared with managed deployment — one whose artifacts name their upstream publisher and declare what integrity that upstream can actually guarantee — and makes sandbox discovery filesystem-driven.

The CLI owns host-local policy: platform paths, terminal interaction, transfer, activation, and what setup offers. It must preserve the repository's no-litter rule, never let Docker create a missing bind source, and never treat user-added reference data as installer-owned state.

## Goals / Non-Goals

**Goals:**

- Give users a stable, documented host directory whose content appears read-only at `/mnt/refs`.
- Install selected catalog datasets from their publishers, safely and repeatably, without a second catalog definition.
- Deliver the strongest integrity check each artifact's upstream permits — and say plainly which one was checked.
- Make setup and explicit commands share one dogfooded handler.
- Keep user-added data discoverable and outside installer cleanup/update ownership.
- Make scripted setup deterministic and prevent silent multi-GB downloads.

**Non-Goals:**

- Mirroring, re-hosting, or proxying reference bytes, or offering any way to point the installer elsewhere.
- Provisioning the managed deployment's PVC or object store.
- Downloading from within a sandbox.
- Importing arbitrary user files into the managed namespace or validating their scientific meaning.
- Maintaining reference installation state in SQLite.

## Decisions

### The public store lives under the platform data home

`env.refsDir` resolves to `<data-home>/inflexa/refs` (`XDG_DATA_HOME`/`~/.local/share` on Unix and the existing platform equivalent on Windows). It is included in the root help Paths table, and `inflexa refs path` prints the exact resolved path. Setup and explicit reference commands are deliberate actions and may create it; passive launch and status-only flows do not.

The layout is:

```text
refs/
  managed/<dataset-id>/<version>/...  # activated catalog content
  user/                                # recommended user-owned namespace
  .inflexa/
    receipts/<dataset-id>.json
    staging/<attempt>/...
    downloads/<artifact>.part
```

The `managed` and `.inflexa` namespaces are installer-owned. The CLI never deletes, rewrites, or adopts content under `user/` or unknown top-level paths, and it refuses to follow a symlink or overwrite unexpected content on an installer-owned path.

### The CLI fetches from the catalog's upstream; there is nothing to configure

Each catalog artifact carries the `https` URL of the third party that publishes it, and the installer fetches exactly that. There is no artifact-key adapter, no distribution base, and no `INFLEXA_REFERENCE_DATA_BASE_URL`.

**Rejected: a configurable distribution base** (the earlier design's opaque keys plus a CLI-resolved public endpoint, with managed free to point at an internal mirror). A configurable source is a source that can be *substituted* — and once it can be, the catalog's provenance and licensing statements ("this is NCBI's `gene_info`; you accept NCBI's terms") stop describing the bytes the user actually receives. It would also quietly make us a redistributor of data we reviewed only for use. The only supported way to bring in other reference data is the `user/` namespace, which the installer never touches.

**Rejected, likewise: a CLI catalog overlay.** It would let the local option set drift from managed deployment and undermine content identity.

### Verification is as strong as the upstream allows, and never stronger than it claims

- A **`pinned`** artifact is verified against the catalog's byte size and SHA-256 before anything is activated. A mismatch means the bytes are not the reviewed bytes: the install fails and the prior activation stands.
- An **`unpinned`** artifact has no catalog digest — its upstream rebuilds the same URL in place — so there is nothing to check the download against. The installer records the size and digest it *observed* in the receipt, and `verify` proves the files are unchanged since install. `refs verify` names, per file, which guarantee it checked, so a weaker guarantee is never silently presented as a checksum match against a reviewed digest.

The receipt is therefore written from observation, never copied from the catalog — for `pinned` artifacts the two necessarily agree, and for `unpinned` ones the observation is the only honest record.

### Resume applies to pinned artifacts only

A partial `.part` is resumed with an HTTP Range request only when the artifact is `pinned`, because only then do we know the final size and digest — the two facts that make "this prefix belongs to that file" checkable. For an `unpinned` artifact the partial is discarded and the file re-fetched whole: the upstream may have replaced the file since the partial was written, and appending to it would splice two different files into one that verifies against nothing and looks complete.

### `--force` is the refresh path, not just a repair path

`refs download --force` re-fetches and re-activates even when the active install is intact. It repairs damage, and — for an `unpinned` dataset — it is the *only* way to pull a fresh copy: an intact local install of the bytes we previously received is indistinguishable from an up-to-date one without going to the network, so the user must be able to ask.

### The skip gate compares digests, not sizes

Deciding "already installed, nothing to transfer" hashes the active files against the receipt (`receiptFilesIntact`). A size-only check cannot see a same-size corruption — a flipped byte, bad sector, hand-edit — and would skip the repair *while printing "Installed"*: a false claim of success on exactly the input a user re-runs `download` to fix. Cheap `refs list` state stays size-only (it is a status glance, and hashing every dataset on every list would be slow), but an install and a download estimate both gate on the digest.

### Sizes are reported honestly, including when they are unknown

Only the upstream knows how big an `unpinned` file currently is, and a local estimate must not make a network round-trip. So the pre-transfer estimate returns both the bytes the catalog knows and the count of artifacts whose size only the upstream can report; the CLI shows both and never invents a total.

### Installation stages a complete dataset before activation

Artifacts download to installer-owned `.part` files, are placed into a per-attempt staging directory at their validated relative destinations, and the staged version directory is atomically renamed into `managed/<id>/<version>` only when every artifact is accounted for. The receipt is then written atomically. Any failure restores the prior version directory, and the per-attempt staging root is always removed — the activation `rename` moves the staged version out but leaves its parents behind, and every attempt has a fresh id, so without cleanup they would accumulate forever.

An update activates the new version only after success; older managed versions are retained rather than deleted under a running sandbox.

### Runtime wiring is existence-gated

The composition root passes `refStorePath: env.refsDir` only when the directory exists. This prevents Docker from creating a missing bind source as a root-owned empty directory and respects no-litter behavior. An existing empty directory is still mounted so discovery can distinguish empty from unmounted and user additions become visible to future sandboxes without config changes.

## Risks / Trade-offs

- **Reference files can be large** → Estimate the missing bytes before consent, stream to resumable `.part` files, verify before activation, and never auto-download headlessly.
- **An `unpinned` dataset silently ages** → Accepted and surfaced: the class is shown in `refs list`, `verify` says which guarantee it checked, and `--force` refreshes on demand. The alternative (pinning a digest to a mutable URL) would guarantee a broken download instead.
- **An upstream can be slow, rate-limited, or down** → Accepted as the price of not redistributing. A failed attempt never changes an existing activation.
- **Update leaves old versions on disk** → Accept bounded disk growth initially; add explicit managed-version reclamation later rather than deleting bytes used by a running sandbox.
- **User places files in a reserved namespace** → Document ownership clearly and refuse to adopt or overwrite unexpected managed paths.
- **Receipt and disk disagree after manual edits** → Report normal recoverable states and let `download` repair managed content; never touch user content.

## Migration Plan

1. Add the path and commands without creating anything on passive reads.
2. Add the installer and setup reuse over the harness catalog.
3. Wire the existing directory into sandbox creation conditionally.
4. Existing users have no migration: an absent store remains unmounted until setup, download, or manual directory creation.

Rollback removes the command and mount wiring without deleting the reference directory, receipts, managed versions, or user content.
