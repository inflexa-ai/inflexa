## ADDED Requirements

### Requirement: An inflexa command downloads a GEO Series into the analysis's folder

The CLI SHALL provide a command that accepts a GEO Series accession (`GSE…`) and
fetches the Series' processed data host-side into a per-accession directory in the
target analysis's home folder. The command SHALL resolve that folder through the
shared context resolution (`resolveContext`) — an explicit `--analysis` ref, else the
working-directory marker. It needs no resolution tier of its own for the agent path:
`run_inflexa` starts the subprocess in the session analysis's folder, so a chat request
that names only the accession resolves there through the ordinary marker walk-up.

Downloading SHALL be the command's whole responsibility. It SHALL NOT record input
rows, emit provenance, stage, seed, (re)profile, or boot a harness runtime. Because
it mutates no analysis state, it SHALL NOT require the analysis instance lock and is
therefore safe to run as a subprocess beside a live TUI that holds it. Making the
downloaded files inputs is a separate, explicit user action through the existing
add-inputs path, which already stages and profiles them like any other local file.

#### Scenario: A GSE accession is downloaded into the analysis's folder

- **GIVEN** a valid GEO Series accession and an existing analysis
- **WHEN** the command runs and the user approves
- **THEN** the Series' processed files are written to a per-accession directory in that analysis's folder and reported to the user

#### Scenario: An agent-driven run targets the chat analysis's folder with no ref

- **GIVEN** the conversation agent running the command through `run_inflexa` in an analysis-scoped session, with only the accession in the argv
- **WHEN** the command resolves its target folder
- **THEN** it resolves to the session analysis's folder, because the subprocess was started there

#### Scenario: The command records nothing about the analysis

- **GIVEN** a completed download in a subprocess
- **WHEN** the command finishes
- **THEN** no input rows were recorded, no provenance was emitted, no runtime was booted, and the analysis instance lock was never claimed

#### Scenario: The downloaded files become inputs only when the user asks

- **GIVEN** a completed download and a user who asks for the files to be added as inputs
- **WHEN** the existing add-inputs path runs
- **THEN** the files are enrolled, staged, and profiled identically to inputs added from any other local path

### Requirement: The command resolves the processed and supplementary artifact set

For a Series accession the command SHALL resolve, from the accession, the SOFT
family file, the series matrix — including per-platform matrix parts when the Series
spans multiple platforms — and author-deposited supplementary files. The command
SHALL NOT fetch raw SRA sequencing reads.

The artifact set SHALL be resolved by enumerating the Series' published directories
rather than by guessing file names. A directory listing SHALL be interpreted by
resolving each link against the directory's own URL and admitting only same-origin
links naming exactly one further path segment, so navigation links, site-wide footer
links, and any off-origin or traversing reference are excluded by construction rather
than by pattern. A resolved name SHALL be usable as a single path segment under the
download directory; anything else SHALL be discarded rather than rewritten.

#### Scenario: A multi-platform Series resolves each matrix part

- **GIVEN** a Series that spans more than one platform
- **WHEN** the command resolves its artifact set
- **THEN** each platform's series-matrix part is included

#### Scenario: Raw SRA reads are excluded

- **GIVEN** a Series whose samples have raw sequencing reads in SRA
- **WHEN** the command resolves its artifact set
- **THEN** the raw SRA reads are not included

#### Scenario: Listing furniture is not mistaken for a file

- **GIVEN** a directory listing carrying navigation links, sort links, and a site-wide off-origin footer link
- **WHEN** the command resolves the directory's files
- **THEN** only the directory's own files are returned

#### Scenario: A name that would escape the download directory is refused

- **GIVEN** a listing entry whose name resolves outside the directory, whether written plainly or percent-encoded
- **WHEN** the command resolves the directory's files
- **THEN** the entry is discarded and no file is written outside the download directory

### Requirement: The fetch is host-side, HTTPS-only, size-bounded, and all-or-nothing

The command SHALL fetch every artifact from the CLI host process over HTTPS,
re-verifying the scheme on the post-redirect URL, and SHALL obtain a size estimate
before transferring and honor a size cap the caller MAY raise. It SHALL transfer to a
staging location and place the files in their destination only on full success, so a
failed or interrupted download leaves no partial set on disk. It SHALL report progress
periodically while a single artifact transfers, not only between artifacts, so a long
transfer is distinguishable from a stalled one by an observer that sees only its output.

Because the upstream sheds load by refusing requests rather than by failing them, the
command SHALL retry a refused or transiently failing request with backoff before
treating its status as the settled answer. This applies to a transfer as much as to a
listing: a shed transfer that were taken at face value would discard every artifact
already staged for the Series.

Obtaining the size estimate SHALL be bounded in wall-clock time as a whole, independent
of how many artifacts it covers, and an artifact left unmeasured when that bound elapses
SHALL be treated as one of unknown size rather than as a failure. The estimate exists to
inform the cap and the readout, so it must never become the reason a download does not
happen — including by holding the command silent long enough to be mistaken for hung.

#### Scenario: A redirect to a non-HTTPS URL is refused

- **GIVEN** a source URL that redirects to an `http://` location
- **WHEN** the command follows the redirect
- **THEN** it refuses the transfer and writes nothing

#### Scenario: A failed download leaves nothing behind

- **GIVEN** a download that fails partway through the artifact set
- **WHEN** the command aborts
- **THEN** no destination directory is created and no transferred file is retained

#### Scenario: A Series above the size cap is refused before transferring

- **GIVEN** a Series whose declared size exceeds the cap
- **WHEN** the command measures it
- **THEN** it reports the measured size against the cap, names how to raise it, and transfers nothing

#### Scenario: A raised cap admits a Series the default would refuse

- **GIVEN** a Series above the default ceiling and a caller-supplied ceiling above its declared size
- **WHEN** the command measures it
- **THEN** it proceeds with the transfer

#### Scenario: A single long transfer keeps reporting

- **GIVEN** one artifact whose transfer spans many progress intervals
- **WHEN** it is transferring
- **THEN** the command reports its accumulated byte count periodically, without waiting for the artifact to finish

#### Scenario: A transiently refused request is retried

- **GIVEN** an upstream that refuses a request and then serves it on a later attempt
- **WHEN** the command lists or fetches
- **THEN** it retries with backoff and proceeds with the served response

#### Scenario: A shed transfer does not discard the artifacts already staged

- **GIVEN** a Series whose second artifact is refused once and served on a later attempt
- **WHEN** the command transfers the set
- **THEN** the whole set lands, including the artifact that transferred before the refusal

#### Scenario: A size sweep that keeps being refused gives up on its bound

- **GIVEN** an upstream that refuses every size probe for a Series of many artifacts
- **WHEN** the command measures it
- **THEN** the sweep ends at its bound, the artifacts are treated as unsized, and the transfer proceeds

### Requirement: An invalid, unknown, or empty Series is a reported failure, not a crash

The command SHALL surface a malformed accession, one GEO does not resolve, or one
that exposes no downloadable processed files as a `Result` error it reports to the
user, writing nothing, and SHALL NOT throw for these expected conditions. A directory
the upstream reports as absent or unreadable SHALL contribute nothing rather than
failing the whole resolution, so a Series with no supplementary files still downloads
the files it does publish.

#### Scenario: A malformed accession is reported without downloading

- **GIVEN** an accession that is not a well-formed GEO Series id
- **WHEN** the command runs
- **THEN** it returns an explanatory error and downloads nothing

#### Scenario: A Series with no processed files reports the absence

- **GIVEN** a resolvable Series that exposes no downloadable processed files
- **WHEN** the command runs
- **THEN** it reports the absence and downloads nothing

#### Scenario: A Series with no supplementary files still downloads the rest

- **GIVEN** a Series whose supplementary directory is absent or unreadable
- **WHEN** the command resolves its artifact set
- **THEN** the supplementary directory contributes nothing and the SOFT and matrix files still download

### Requirement: The command is approval-classified and agent-reachable

The command SHALL be registered with the `approval` agent policy — it writes files, so
it is never `auto` and never `blocked`. It SHALL therefore be reachable by the
conversation agent through the `run_inflexa` tool, which classifies it by the
commander parse and gates it behind the in-chat approval prompt. Every argument and
option SHALL carry a description so the CLI reference generation and the agent's
`--help` discovery both succeed.

#### Scenario: The agent runs the command behind an approval prompt

- **GIVEN** the conversation agent invoking the command through `run_inflexa`
- **WHEN** the tool classifies it
- **THEN** it resolves to `approval` and runs only after the user approves the prompt

#### Scenario: The command is never auto-run

- **WHEN** the agent policy for the command is resolved
- **THEN** it is `approval`, so the command never runs without an approval decision
