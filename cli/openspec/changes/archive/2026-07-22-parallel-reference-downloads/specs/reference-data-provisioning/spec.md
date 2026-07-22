## ADDED Requirements

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

## MODIFIED Requirements

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
