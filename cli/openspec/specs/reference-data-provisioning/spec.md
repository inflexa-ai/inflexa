# reference-data-provisioning Specification

## Purpose

Define the CLI's public reference-store location, catalog-driven installation,
verification, setup integration, and ownership boundary for user-provided data.

## Requirements

### Requirement: The CLI exposes a stable public reference-store directory

The CLI SHALL resolve a `refsDir` under the platform data home at `<data-home>/inflexa/refs`. Root help SHALL list the directory in its Paths table, and `inflexa refs path` SHALL print the exact resolved path without creating it. Deliberate setup or reference-download actions SHALL create the directory and a documented `user/` namespace for arbitrary user-provided reference data.

#### Scenario: User discovers the host path

- **WHEN** the user runs root help or `inflexa refs path`
- **THEN** the CLI displays the host directory whose contents sandboxes see at `/mnt/refs`

#### Scenario: Path inspection does not litter

- **WHEN** `inflexa refs path` runs before the store exists
- **THEN** it prints the path and creates no directory or metadata

### Requirement: Managed and user-owned namespaces have separate ownership

The CLI installer SHALL write catalog-managed datasets only beneath `managed/<dataset-id>/<version>` and its own metadata only beneath `.inflexa/`. It SHALL recommend `user/` for arbitrary additions and SHALL NOT overwrite, adopt, verify as managed, prune, or delete content under `user/` or unknown top-level paths.

#### Scenario: User-added reference survives managed update

- **WHEN** a user places files under `refs/user/custom-atlas/` and updates a catalog dataset
- **THEN** the installer changes only its managed dataset/version and receipt paths and leaves the custom atlas byte-for-byte untouched

### Requirement: Reference options come from the harness catalog

The CLI SHALL consume the harness-exported reference catalog and install-plan interface rather than defining a second list. `inflexa refs list` SHALL show each catalog dataset's id, version, description, size, integrity class, source and licensing links, recommendation/group metadata, and local state. The CLI SHALL fetch every artifact from the upstream URL the catalog names and SHALL NOT provide any means — environment variable, flag, or config — of redirecting a fetch to a different origin.

Because an `unpinned` artifact's size is known only to its mutable upstream, a displayed size SHALL distinguish bytes the catalog knows from files whose size the upstream determines, and SHALL NOT invent a total.

#### Scenario: Catalog option is visible with links

- **WHEN** `inflexa refs list` runs
- **THEN** every downloadable option from the installed harness version is shown with its upstream source/licensing links, its integrity class, and its local installation state

#### Scenario: The download source cannot be redirected

- **WHEN** a user or operator wishes to install catalog data from somewhere other than its publisher
- **THEN** the CLI offers no such configuration, and the only supported way to add other reference data is to place files under the store's `user/` namespace

#### Scenario: Unknown id is rejected before download

- **WHEN** `inflexa refs download unknown-id` runs
- **THEN** the CLI reports the unknown id and available ids and performs no network or filesystem mutation

### Requirement: Downloads are verified and dataset activation is atomic

For each selected dataset, the CLI SHALL download artifacts to installer-owned `.part` paths, verify every `pinned` artifact against the catalog's byte size and SHA-256 digest, stage every final file beneath one attempt directory, and activate the complete version directory only after all artifacts are accounted for. It SHALL then atomically write a harness-compatible active receipt recording the size and digest **observed** for each artifact. A failed or interrupted attempt SHALL leave any previously active receipt/version unchanged and SHALL never expose a partially staged dataset as active managed content, and SHALL NOT leave orphaned staging directories behind.

Resuming a partial transfer SHALL be attempted only for a `pinned` artifact. An `unpinned` artifact SHALL be re-fetched whole, because its upstream may have replaced the file since the partial was written and appending to it would splice two different files into one that verifies against nothing.

#### Scenario: Complete dataset activates

- **WHEN** every artifact downloads, and every `pinned` artifact matches its catalog size and digest
- **THEN** the complete version appears under `managed/<id>/<version>` and its receipt records the observed size, digest, and integrity class of each file

#### Scenario: Digest mismatch preserves prior version

- **WHEN** any `pinned` artifact fails size or SHA-256 verification
- **THEN** the command fails, the staged version is not activated, and the prior active receipt and version remain unchanged

#### Scenario: Interrupted pinned download is resumable but not visible

- **WHEN** a transfer stops after writing part of a `pinned` artifact
- **THEN** resumable installer-owned partial state may remain and is resumed by range request, but no partial dataset appears as active managed reference data

#### Scenario: A mutable upstream is never resumed into

- **WHEN** a partial `.part` exists for an `unpinned` artifact
- **THEN** the CLI discards it and fetches the whole file again rather than appending to bytes the upstream may have since replaced

### Requirement: Reference datasets transfer with bounded concurrency

The installer SHALL transfer several datasets at once under a fixed concurrency cap, defaulting to four, and SHALL expose that cap on its dependency edge so a caller can pin it. Concurrency SHALL apply across datasets; artifacts within one dataset MAY remain sequential.

Concurrency SHALL NOT weaken any existing guarantee: each dataset SHALL stage into installer-owned storage that no other concurrent dataset can read, write, or delete, and SHALL activate atomically with its receipt written last, exactly as a serial install does. The staging isolation SHALL hold even when the caller supplies a fixed attempt identifier, since a shared attempt directory would let one dataset's cleanup destroy another's staged files.

The installed result SHALL be reported in plan order regardless of completion order, and a failure SHALL report the lowest-ordered failing dataset rather than whichever failed first in time. After a failure the installer SHALL start no further datasets, SHALL allow already-started ones to settle, and SHALL leave every other dataset either fully activated or untouched.

#### Scenario: Several datasets transfer at once

- **WHEN** an install plan contains more datasets than the concurrency cap
- **THEN** at most the cap are in flight at any moment, and every dataset is installed

#### Scenario: Concurrent staging cannot collide

- **WHEN** datasets install concurrently under a caller-supplied fixed attempt identifier
- **THEN** each dataset stages in its own directory, and every dataset activates with the bytes it downloaded

#### Scenario: Output does not depend on scheduling

- **WHEN** datasets complete in an order other than the plan's
- **THEN** the installed result is reported in plan order, and a failing plan reports the lowest-ordered failure

### Requirement: Reference transfers report combined progress

While reference artifacts are transferring, the CLI SHALL show one combined readout for the whole plan carrying: the number of artifacts completed out of the planned artifact total, the cumulative bytes downloaded so far, and the current transfer rate. The readout SHALL cover the entire selection, not one dataset or one file at a time.

The installer SHALL expose progress as a headless seam on its dependency edge — an optional reporter alongside the existing `fetch`/clock/attempt seams — and SHALL emit artifact-started, byte-delta, and artifact-completed events through it. Byte-delta events SHALL identify the artifact they belong to, so that deltas from concurrent transfers are attributed correctly rather than accumulating onto whichever artifact started most recently. All terminal rendering SHALL live in the command layer; the installer SHALL contain no presentation. Reporting SHALL NOT alter install semantics: staging, verification, activation, receipts, and the `Result` contract SHALL be identical whether or not a reporter is supplied, and a reporter that throws SHALL be contained so it can never fail a download.

Because the catalog pins no sizes, the CLI SHALL NOT invent a plan-wide byte total, a percentage of bytes, or an estimated time remaining. The planned artifact count is the only legitimate denominator. Upstream-declared sizes, when present and parseable as positive finite integers, MAY refine the readout for the artifacts currently in flight; their absence SHALL be treated as the normal case and SHALL degrade the readout rather than blocking or misreporting it.

The readout SHALL report how many artifacts are in flight. When every in-flight artifact declared a size, it MAY additionally report the bytes received and the sizes declared across that active set, labelled so it reads as a statement about the artifacts currently transferring and never as a plan total. When any in-flight artifact declared no size, the byte fraction SHALL be omitted rather than summed over a partial denominator.

The transfer rate SHALL be measured over a trailing window rather than averaged over the whole run, and SHALL be omitted from the readout entirely — never rendered as `NaN`, `Infinity`, or a placeholder zero — until enough samples exist to state it.

A plan that fetches no artifacts SHALL show no progress readout, since there is no denominator to report against. The completed count SHALL never exceed the planned total: when the transfer fetches more artifacts than the plan predicted — a dataset damaged between planning and transfer — the readout SHALL saturate at the total, and the post-transfer summary SHALL remain the authoritative record of what was installed.

When standard output is not a terminal, the readout SHALL degrade to plain, non-animated line output carrying the same facts, emitted once per completed artifact rather than per byte delta, so captured logs hold readable text rather than cursor-control sequences or a line per chunk.

Every byte quantity the CLI prints SHALL be rendered through one shared formatter — whole bytes below 1024, then one decimal of `KB`, `MB`, `GB` on a 1024 base — and SHALL clamp negative and non-finite inputs to a zero-byte reading instead of printing `NaN`. Call sites that hand-roll their own byte string SHALL be moved onto that formatter, so the vocabulary is shared in fact and not only by declaration.

#### Scenario: A multi-file transfer shows one combined readout

- **WHEN** a selection of several datasets is transferring
- **THEN** one readout reports artifacts completed out of the planned total, the cumulative bytes downloaded, and the current rate, advancing as each artifact finishes

#### Scenario: The readout reports the in-flight set, not one file

- **WHEN** several artifacts are transferring at once and each declared a size
- **THEN** the readout reports how many are in flight together with the bytes received and declared across exactly that set, and drops the fraction once any in-flight artifact declared no size

#### Scenario: Concurrent byte deltas are attributed to their own artifact

- **WHEN** byte deltas from two concurrent transfers interleave
- **THEN** each artifact's in-flight bytes reflect only its own deltas, and the cumulative total reflects both

#### Scenario: An upstream that reports no size never becomes a fabricated total

- **WHEN** an upstream response carries no usable `Content-Length`
- **THEN** the readout continues on the artifact count and measured bytes, and no percentage of bytes and no estimated time remaining is shown

#### Scenario: The rate is omitted rather than fabricated

- **WHEN** the transfer has not yet produced enough samples to measure a rate
- **THEN** the readout omits the rate segment rather than showing `NaN`, `Infinity`, or a zero placeholder

#### Scenario: A stalled transfer stops claiming a rate

- **WHEN** no bytes arrive for longer than the sampling window
- **THEN** the rate segment decays out of the readout rather than continuing to display the last rate the connection sustained

#### Scenario: A plan with nothing to fetch shows no readout

- **WHEN** every selected dataset is already installed and intact, so the plan fetches zero artifacts
- **THEN** no progress readout is started, and the command reports the outcome through its existing summary

#### Scenario: The completed count never overruns the planned total

- **WHEN** the transfer fetches more artifacts than the plan predicted
- **THEN** the readout saturates at the planned total rather than reporting more completed than planned, and the summary still reports what was actually installed

#### Scenario: Non-terminal output stays plain

- **WHEN** the same download runs with standard output not attached to a terminal
- **THEN** progress is reported as one plain line per completed artifact carrying the same facts, with no animation and no cursor-control sequences

#### Scenario: Progress reporting cannot fail an install

- **WHEN** the progress reporter throws while artifacts are transferring
- **THEN** the transfer continues, and the installed result, receipts, and activation are exactly what they would be with no reporter attached

#### Scenario: Byte readouts share one vocabulary

- **WHEN** any command prints a byte quantity
- **THEN** it is formatted by the shared formatter in `B`/`KB`/`MB`/`GB`, and a negative or non-finite value reads as zero bytes rather than `NaN`

### Requirement: Reference commands expose install, verification, and path operations

The CLI SHALL provide `inflexa refs list`, `inflexa refs download [ids...]`, `inflexa refs verify [ids...]`, and `inflexa refs path`. Interactive download with no ids SHALL first offer a preset choice over the datasets being offered — every offered dataset, the recommended subset, none, or an explicit escape into a per-dataset picker — and the per-dataset picker SHALL open with nothing preselected, so narrowing a selection never requires deselection. Cancelling the preset choice SHALL be treated as a cancellation, transferring nothing. Before transfer, download SHALL show the missing size and require confirmation unless explicit non-interactive consent is present. Verify SHALL hash active managed files against their receipt and SHALL report missing, modified, and valid states without modifying them, naming for each file which guarantee was checked — the catalog's checksum for a `pinned` file, the checksum recorded at install for an `unpinned` one.

`inflexa refs download --force` SHALL re-fetch and re-activate a dataset even when its active install is intact. This is the supported way to refresh an `unpinned` dataset, whose upstream may have moved on in a way no local inspection can detect.

#### Scenario: Interactive selection shows cost before consent

- **WHEN** an interactive user chooses a preset or selects datasets in the picker
- **THEN** the CLI shows the combined missing download size and begins transfer only after confirmation

#### Scenario: The per-dataset picker starts from nothing

- **WHEN** an interactive user escapes the presets into the per-dataset picker
- **THEN** no dataset is preselected, and confirming without touching anything selects nothing and transfers nothing

#### Scenario: Cancelling the preset choice transfers nothing

- **WHEN** an interactive user cancels the preset choice
- **THEN** the command treats it as a declined selection, activates no dataset, and reports the cancellation

#### Scenario: Verification detects manual damage

- **WHEN** an active managed file has been edited or removed
- **THEN** `inflexa refs verify` reports the affected dataset and file as invalid, names the repair command, exits non-zero, and changes no bytes

#### Scenario: A mutable upstream is refreshed on request

- **WHEN** an `unpinned` dataset is installed and intact, and the user runs `refs download <id> --force`
- **THEN** the CLI re-fetches from the upstream and re-activates, replacing the receipt with the newly observed digests

### Requirement: Reference inspection and verification have a machine-readable JSON mode

`inflexa refs list --json` SHALL emit on stdout a single JSON document carrying the store-level facts (the public store path, whether it exists, and unmanaged top-level content) and, for every canonical catalog dataset in catalog order, its identity and provenance fields (id, catalog version, title, description, source URL, license, group, recommended), its local install state (the same closed state set the human listing shows), the installed version and install timestamp when the dataset's files are actually present from a completed install — the `installed` and `update_available` states — (keys absent otherwise, never `null`), and its artifacts with their upstream URLs. A `partial` dataset's receipt SHALL NOT be surfaced as install facts, so key presence can never contradict `state` or misrepresent a damaged install as usable. The document SHALL be self-contained: artifact URLs are always present, and `--urls` SHALL have no effect on it. The shape SHALL be a CLI-owned projection constructed field-by-field — never a serialization of the harness catalog or receipt types — and SHALL be exported from the refs module as a typed value so in-process consumers use the same shape the flag prints.

`inflexa refs verify --json` SHALL emit on stdout a single JSON document wrapping the per-dataset verification results: dataset id, the active receipt version when one is valid (key absent otherwise), the overall dataset state, and per-file states.

Both JSON modes SHALL be byte-stable — the same store state SHALL produce byte-identical stdout across runs — and SHALL be side-effect-free, creating no directory or metadata even when the store does not exist. In JSON mode stdout SHALL carry either one complete JSON document or nothing: an inspection or verification failure SHALL leave stdout empty, report prose on stderr, and exit non-zero, exactly as the human mode's failure path does. A verification that completes but finds damage SHALL still emit the document, SHALL exit non-zero, and SHALL NOT print the human mode's advisory repair hint. The human-readable output of both commands SHALL be unchanged by this mode's existence.

#### Scenario: JSON list reports install state per catalog dataset

- **WHEN** `inflexa refs list --json` runs with one dataset installed and the rest absent
- **THEN** stdout is exactly one JSON document listing every catalog dataset in catalog order, the installed dataset carrying its state, installed version, and install timestamp from the active receipt, the absent ones carrying their state with no installed-version keys, and every dataset carrying its artifact upstream URLs without any additional flag

#### Scenario: JSON output is byte-stable and does not litter

- **WHEN** `inflexa refs list --json` runs twice before the store exists
- **THEN** both runs print byte-identical documents reporting the store as absent, and no directory or metadata is created

#### Scenario: Failure keeps stdout pure

- **WHEN** inspection fails in JSON mode
- **THEN** stdout carries no bytes, the error is reported as prose on stderr, and the command exits non-zero

#### Scenario: JSON verify reports damage in the document and the exit code

- **WHEN** an active managed file has been modified and `inflexa refs verify --json` runs
- **THEN** stdout is exactly one JSON document naming the affected dataset and file states, the command exits non-zero, and no advisory repair hint is printed

#### Scenario: A damaged install is not surfaced as install facts

- **WHEN** `inflexa refs list --json` runs against a dataset whose receipt is valid but whose installed files are incomplete
- **THEN** that dataset carries `"state": "partial"` and no installed-version or install-timestamp keys

#### Scenario: --urls does not change the JSON document

- **WHEN** `inflexa refs list --json --urls` runs
- **THEN** stdout is byte-identical to `inflexa refs list --json` on the same store state

### Requirement: Setup reuses the reference download handler

Interactive `inflexa setup` SHALL deliberately create the reference-store and `user/` directories, inspect catalog installation state, and offer missing or updateable datasets with their sizes through the same headless download operation used by `inflexa refs download`. The offer SHALL lead with the preset choice, and every preset SHALL resolve against the datasets setup is actually offering — the missing or updateable ones — so an intact dataset is never re-offered and "everything" never means "everything already installed". Choosing the recommended preset SHALL select the recommended datasets within that offered set, and SHALL resolve to an empty selection rather than silently widening when none of the offered datasets are recommended. Choosing to install nothing SHALL state how references can be obtained later: by running `inflexa refs download` for a dataset, or by asking the agent in chat, which proposes that same command for the user's approval. That statement SHALL remain true of the shipped command surface. Declining or selecting nothing SHALL continue setup. A selected installation failure SHALL fail setup visibly.

Headless setup SHALL download no reference bytes unless dataset ids and non-interactive consent are explicit. Without them it SHALL print the reference-store path and an actionable `inflexa refs download` command and continue.

#### Scenario: Setup and explicit command share one installer

- **WHEN** setup installs a selected dataset
- **THEN** it produces the same managed layout, verification, activation, and receipt as `inflexa refs download` for that id

#### Scenario: Presets cover only what setup is offering

- **WHEN** an interactive user picks the everything preset while some catalog datasets are already installed and intact
- **THEN** the plan contains only the missing or updateable datasets, and the already-installed ones are not re-fetched

#### Scenario: Choosing nothing explains how to get references later

- **WHEN** an interactive user chooses to install no references
- **THEN** setup continues successfully and tells the user they can download a dataset later with the reference download command, or ask the agent in chat, which proposes that command for their approval

#### Scenario: Headless setup does not silently download

- **WHEN** setup runs without a TTY and without explicit reference ids and consent
- **THEN** it downloads nothing, prints how to install references later, and continues

#### Scenario: Explicit ids skip the preset choice

- **WHEN** setup runs with explicit reference dataset ids supplied on the command line
- **THEN** no preset choice is offered, and the named datasets are the plan, subject to the same consent rules

#### Scenario: User declines optional references

- **WHEN** an interactive user declines or selects no catalog datasets
- **THEN** setup leaves the public store available for manual additions and continues successfully

### Requirement: Missing or inconsistent managed state is recoverable

Cheap status inspection SHALL derive managed state from the catalog, receipts, and filesystem and SHALL report at least missing, installed, update available, partial, and invalid-receipt states. Absence or inconsistency SHALL NOT crash the CLI. Re-running download for a selected dataset SHALL repair installer-owned content through normal staged verification and activation.

Deciding whether an install may be skipped as already-complete SHALL compare digests, not sizes. A size-only check cannot see a same-size corruption — a flipped byte, a bad sector, a hand-edit — and would skip the repair while reporting the dataset as installed, which is a false claim of success. Cheap listing MAY remain size-only, but an install SHALL NOT be skipped on that basis.

#### Scenario: Receipt references a deleted file

- **WHEN** a receipt names a managed file that is absent
- **THEN** list reports a partial or damaged state and download can repair it without database surgery or changes to user content

#### Scenario: Same-size corruption is repaired, not skipped

- **WHEN** an installed artifact is corrupted in place without changing its byte length, and download is re-run for that dataset
- **THEN** the CLI detects the digest mismatch, re-downloads and re-activates the dataset, and never reports it as already installed with nothing transferred
