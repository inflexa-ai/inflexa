## ADDED Requirements

### Requirement: A planned transfer is sized against the publishers before consent

Because the catalog pins no sizes, the CLI SHALL determine the byte cost of a planned transfer by asking the publishers directly: before consent, it SHALL issue one `HEAD` request per artifact the plan will fetch and collect the sizes they declare. The sweep SHALL report the bytes declared, how many artifacts declared a usable size, and how many did not.

The sweep SHALL run with bounded parallelism rather than one request at a time or all at once, so a catalog many times the present size neither takes proportionally longer nor arrives at any one publisher as a burst larger than the transfer itself would open. The whole sweep SHALL be bounded by a single wall-clock budget shared by every request, so its cost is capped by the budget rather than by the number of artifacts.

The sweep SHALL NOT be able to fail. A transport error, a timeout, a refusal, a redirect away from https, a malformed header, and an absent header SHALL all resolve to "this artifact's size is unknown" — never to an error — so that a metadata probe can never fail, block, or alter a download that would otherwise have succeeded. The sweep SHALL NOT write anything, and SHALL leave install semantics untouched.

The sweep SHALL be skipped where it cannot inform anything: a non-interactive run lacking explicit consent SHALL return before any request is made, and SHALL keep reporting its planned cost as an artifact count.

#### Scenario: Consent states the measured size

- **WHEN** an interactive user is asked to approve a plan whose artifacts all declared a size
- **THEN** the prompt states both the number of files and the total bytes to fetch, before any byte moves

#### Scenario: Partial knowledge is stated as a floor

- **WHEN** some planned artifacts declare no usable size
- **THEN** the stated byte figure is qualified as a lower bound and accompanied by how many artifacts did not declare one, and is never presented as a total

#### Scenario: Nothing measurable falls back to the count

- **WHEN** no planned artifact declares a usable size
- **THEN** the plan is stated as an artifact count alone, exactly as it was before any sweep existed

#### Scenario: An unreachable publisher does not fail the plan

- **WHEN** a size request errors, times out, or is refused
- **THEN** that artifact counts as unsized, the remaining artifacts are still measured, and the download proceeds as it would have

#### Scenario: A scripted refusal makes no network request

- **WHEN** a non-interactive run without explicit consent is refused for lack of consent
- **THEN** no size request is issued and the refusal states the planned artifact count

## MODIFIED Requirements

### Requirement: Reference transfers report combined progress

While reference artifacts are transferring, the CLI SHALL show one combined readout for the whole plan carrying: the number of artifacts completed out of the planned artifact total, the cumulative bytes downloaded so far, and the current transfer rate. The readout SHALL cover the entire selection, not one dataset or one file at a time.

The installer SHALL expose progress as a headless seam on its dependency edge — an optional reporter alongside the existing `fetch`/clock/attempt seams — and SHALL emit artifact-started, byte-delta, and artifact-completed events through it. Byte-delta events SHALL identify the artifact they belong to, so that deltas from concurrent transfers are attributed correctly rather than accumulating onto whichever artifact started most recently. All terminal rendering SHALL live in the command layer; the installer SHALL contain no presentation. Reporting SHALL NOT alter install semantics: staging, verification, activation, receipts, and the `Result` contract SHALL be identical whether or not a reporter is supplied, and a reporter that throws SHALL be contained so it can never fail a download.

The planned artifact count SHALL remain the readout's denominator, since it is the only quantity fully known for every plan. When the pre-transfer sweep measured a byte total, the readout SHALL additionally show cumulative bytes against that total, marked as a lower bound whenever any planned artifact went unsized. The CLI SHALL NOT invent a byte total the publishers did not state, and SHALL NOT show a percentage of bytes or an estimated time remaining.

A declared size SHALL be treated as usable only when it describes the bytes that will reach disk. A `Content-Length` on a response carrying a content encoding describes the encoded entity, not the decoded bytes the CLI writes and counts, and SHALL therefore be treated as no declaration at all rather than converted or accepted. Sizes that are absent, malformed, or not positive finite integers SHALL likewise be treated as absent, which is the normal case and SHALL degrade the readout rather than blocking or misreporting it.

The readout SHALL report how many artifacts are in flight. Where the plan carries no measured total, and every in-flight artifact declared a size, it MAY additionally report the bytes received and the sizes declared across that active set, labelled so it reads as a statement about the artifacts currently transferring and never as a plan total; when any in-flight artifact declared no size, that fraction SHALL be omitted rather than summed over a partial denominator. Where the plan does carry a measured total, the in-flight segment SHALL report the count alone, so that only one byte pair appears on the line and it is the one describing the whole plan.

The transfer rate SHALL be measured over a trailing window rather than averaged over the whole run, and SHALL be omitted from the readout entirely — never rendered as `NaN`, `Infinity`, or a placeholder zero — until enough samples exist to state it.

A plan that fetches no artifacts SHALL show no progress readout, since there is no denominator to report against. The completed count SHALL never exceed the planned total: when the transfer fetches more artifacts than the plan predicted — a dataset damaged between planning and transfer — the readout SHALL saturate at the total, and the post-transfer summary SHALL remain the authoritative record of what was installed.

When standard output is not a terminal, the readout SHALL degrade to plain, non-animated line output carrying the same facts, emitted once per completed artifact rather than per byte delta, so captured logs hold readable text rather than cursor-control sequences or a line per chunk.

Every byte quantity the CLI prints SHALL be rendered through one shared formatter — whole bytes below 1024, then one decimal of `KB`, `MB`, `GB` on a 1024 base — and SHALL clamp negative and non-finite inputs to a zero-byte reading instead of printing `NaN`. Call sites that hand-roll their own byte string SHALL be moved onto that formatter, so the vocabulary is shared in fact and not only by declaration.

#### Scenario: A multi-file transfer shows one combined readout

- **WHEN** a selection of several datasets is transferring
- **THEN** one readout reports artifacts completed out of the planned total, the cumulative bytes downloaded, and the current rate, advancing as each artifact finishes

#### Scenario: The readout counts down against the measured total

- **WHEN** the pre-transfer sweep measured a byte total for the plan
- **THEN** the readout shows cumulative bytes against that total, marking it a lower bound if any planned artifact went unsized, and reports the in-flight artifacts as a count without a second byte pair

#### Scenario: The readout reports the in-flight set, not one file

- **WHEN** several artifacts are transferring at once, each declared a size, and the plan carries no measured total
- **THEN** the readout reports how many are in flight together with the bytes received and declared across exactly that set, and drops the fraction once any in-flight artifact declared no size

#### Scenario: A compressed response declares no usable size

- **WHEN** a response carries a `Content-Length` together with a content encoding the runtime will decode
- **THEN** the size is treated as undeclared, so the readout never shows more bytes received than declared for that artifact

#### Scenario: Concurrent byte deltas are attributed to their own artifact

- **WHEN** byte deltas from two concurrent transfers interleave
- **THEN** each artifact's in-flight bytes reflect only its own deltas, and the cumulative total reflects both

#### Scenario: An upstream that reports no size never becomes a fabricated total

- **WHEN** an upstream response carries no usable `Content-Length`
- **THEN** the readout continues on the artifact count and measured bytes, and no percentage of bytes and no estimated time remaining is shown
