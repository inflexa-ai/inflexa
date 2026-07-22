## ADDED Requirements

### Requirement: Reference transfers report combined progress

While reference artifacts are transferring, the CLI SHALL show one combined readout for the whole plan carrying: the number of artifacts completed out of the planned artifact total, the cumulative bytes downloaded so far, and the current transfer rate. The readout SHALL cover the entire selection, not one dataset or one file at a time.

The installer SHALL expose progress as a headless seam on its dependency edge — an optional reporter alongside the existing `fetch`/clock/attempt seams — and SHALL emit artifact-started, byte-delta, and artifact-completed events through it. All terminal rendering SHALL live in the command layer; the installer SHALL contain no presentation. Reporting SHALL NOT alter install semantics: staging, verification, activation, receipts, and the `Result` contract SHALL be identical whether or not a reporter is supplied, and a reporter that throws SHALL be contained so it can never fail a download.

Because the catalog pins no sizes, the CLI SHALL NOT invent a plan-wide byte total, a percentage of bytes, or an estimated time remaining. The planned artifact count is the only legitimate denominator. An upstream `Content-Length`, when present and parseable as a positive finite integer, MAY refine the readout for the artifact currently in flight; its absence SHALL be treated as the normal case and SHALL degrade the readout rather than blocking or misreporting it.

The transfer rate SHALL be measured over a trailing window rather than averaged over the whole run, and SHALL be omitted from the readout entirely — never rendered as `NaN`, `Infinity`, or a placeholder zero — until enough samples exist to state it.

A plan that fetches no artifacts SHALL show no progress readout, since there is no denominator to report against. The completed count SHALL never exceed the planned total: when the transfer fetches more artifacts than the plan predicted — a dataset damaged between planning and transfer — the readout SHALL saturate at the total, and the post-transfer summary SHALL remain the authoritative record of what was installed.

When standard output is not a terminal, the readout SHALL degrade to plain, non-animated line output carrying the same facts, emitted once per completed artifact rather than per byte delta, so captured logs hold readable text rather than cursor-control sequences or a line per chunk.

Every byte quantity the CLI prints SHALL be rendered through one shared formatter — whole bytes below 1024, then one decimal of `KB`, `MB`, `GB` on a 1024 base — and SHALL clamp negative and non-finite inputs to a zero-byte reading instead of printing `NaN`. Call sites that hand-roll their own byte string SHALL be moved onto that formatter, so the vocabulary is shared in fact and not only by declaration.

#### Scenario: A multi-file transfer shows one combined readout

- **WHEN** a selection of several datasets is transferring
- **THEN** one readout reports artifacts completed out of the planned total, the cumulative bytes downloaded, and the current rate, advancing as each artifact finishes

#### Scenario: An upstream that reports no size never becomes a fabricated total

- **WHEN** an upstream response carries no usable `Content-Length`
- **THEN** the readout continues on the artifact count and measured bytes, and no percentage of bytes and no estimated time remaining is shown

#### Scenario: The rate is omitted rather than fabricated

- **WHEN** the transfer has not yet produced enough samples to measure a rate
- **THEN** the readout omits the rate segment rather than showing `NaN`, `Infinity`, or a zero placeholder

#### Scenario: A stalled transfer stops claiming a rate

- **WHEN** no bytes arrive for longer than the sampling window
- **THEN** the rate segment decays out of the readout rather than continuing to display the last rate the connection sustained

#### Scenario: A declared size refines only the artifact in flight

- **WHEN** the upstream declares a size for the artifact currently transferring
- **THEN** the readout adds that artifact's transferred-of-declared bytes, and drops the segment when the artifact completes or when the next artifact declares no size

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

## MODIFIED Requirements

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
