## ADDED Requirements

### Requirement: A deterministic scan enumerates the staged input tree

The harness SHALL provide an input scan that walks a staged input tree and returns a
structured manifest without invoking a language model. Per file the manifest SHALL carry
the path relative to the analysis root, the byte size, the extension chain, and a format
identified from magic bytes rather than extension alone. For formats the scan recognises
it SHALL additionally carry a header readout obtained by reading a bounded prefix — never
by decoding a file in full.

The scan SHALL run inside the sandbox. Input files are user-supplied and the scan decodes
them (gzip members, container headers, document structure); performing that decode in the
long-lived multi-tenant host process is the attack surface the sandbox exists to contain.

The scan SHALL be the sole enumeration pass. The profiler agent SHALL NOT be required to
issue one command per input file to discover structure.

#### Scenario: The scan reports format from content, not extension

- **WHEN** the scan encounters a gzip-compressed VCF whose name ends `.vcf.gz`
- **THEN** the manifest entry SHALL name the format from the file's magic bytes
- **AND** SHALL carry the header fields read from a bounded prefix of the decompressed stream

#### Scenario: The scan never decodes a file in full

- **GIVEN** a staged input of several gigabytes
- **WHEN** the scan processes it
- **THEN** it SHALL read only a bounded prefix and SHALL NOT decompress or parse the whole file

#### Scenario: One pass covers the tree

- **WHEN** the scan runs over a tree of 3513 staged files
- **THEN** it SHALL return one manifest describing all of them in a single execution

### Requirement: The scan derives kinds and axes from filenames

The manifest SHALL express the tree as **kinds** crossed with **axes**.

A *kind* is a set of files sharing a detected pattern, carrying at minimum a path pattern,
a member count, the detected format, and up to three example paths. A file matching no
other file is a kind of count one; there SHALL NOT be a separate concept, threshold, or
schema arm for singletons.

An *axis* is a position in a kind's filename pattern whose token varies across members. Per
axis the manifest SHALL carry the position, the cardinality, and a bounded sample of the
distinct values observed. The value sample is normative: cardinality alone cannot
distinguish an entity identifier (`0001`…`1171`) from a categorical label
(`tumor`/`normal`), and that distinction determines whether members are instances of one
thing or arms of a comparison.

Kind and axis SHALL be structural. The scan SHALL NOT assign domain meaning to either, and
the manifest SHALL NOT encode any dataset-specific vocabulary — a patient cohort is one
input shape among many, and a scan that names it forecloses the others.

#### Scenario: A repeating set becomes one kind with an axis

- **GIVEN** 1171 files named `PATIENT_<id>.haplotypecaller.vcf.gz`
- **WHEN** the scan runs
- **THEN** the manifest SHALL carry one kind of count 1171 with that path pattern
- **AND** one axis at the varying position with cardinality 1171 and a bounded sample of its distinct values

### Requirement: Nested axes are reported per axis, not collapsed

Where a kind's pattern has more than one varying position, the manifest SHALL report each
as its own axis with its own cardinality, rather than reporting a single flat member count.
The per-axis cardinalities are the dataset's design skeleton, and a flat count destroys it.

#### Scenario: Three varying positions yield three axes

- **GIVEN** files named `PT<subject>_D<timepoint>_rep<replicate>.fastq.gz` spanning 1171 subjects, 3 timepoints, and 2 replicates
- **WHEN** the scan runs
- **THEN** the manifest SHALL report three axes with cardinalities 1171, 3, and 2
- **AND** SHALL NOT report only a single member count of 7026

### Requirement: The manifest is a proposal the agent may revise

The manifest's kinds and axes SHALL be presented to the profiler agent as a mechanical
proposal, and the agent SHALL be able to split, merge, or relabel any of them. Pattern
detection groups by name shape and cannot see meaning: two files differing only by a token
may be replicates of one thing or arms of a comparison, and only the agent can tell which.

#### Scenario: The agent splits a proposed kind

- **GIVEN** a proposed kind whose axis values are `tumor` and `normal`
- **WHEN** the agent determines these are two arms rather than two members
- **THEN** it SHALL be able to report them as two kinds

### Requirement: Cross-kind entity correspondence is reported with evidence

The manifest SHALL report cross-kind entity correspondence with its evidence and SHALL NOT
assume it. Where two kinds appear to share an axis, because the same entity token appears in
both, the manifest SHALL report each kind's observed key set and the overlap between them
rather than silently merging the kinds onto one axis. Where key sets do not correspond, the
manifest SHALL report them as separate axes.

Entity matching across kinds is heuristic: it depends on stripping a kind-specific suffix
before tokenising, and near-miss namings defeat it. A join asserted without evidence is
worse than no join, because a downstream consumer cannot tell it was guessed.

#### Scenario: Overlap is reported, including its gaps

- **GIVEN** 1171 files of one kind and 1168 of another whose entity tokens correspond
- **WHEN** the scan runs
- **THEN** the manifest SHALL report the correspondence and name the 3 entities present in the first kind and absent from the second

#### Scenario: Non-corresponding key sets are not merged

- **GIVEN** two kinds whose entity tokens do not correspond
- **WHEN** the scan runs
- **THEN** the manifest SHALL report them as separate axes rather than asserting a shared one

### Requirement: Files matching no pattern are bucketed, not enumerated as kinds

Files that fit no detected pattern SHALL be reported in a single unmatched bucket carrying
a count and a bounded sample of paths. The scan SHALL NOT emit one kind per unmatched file:
a tree of arbitrarily named files would otherwise produce a kind count proportional to the
file count, which is the unbounded output this capability exists to prevent.

#### Scenario: Arbitrary filenames collapse into one bucket

- **GIVEN** 3000 files whose names share no detectable pattern
- **WHEN** the scan runs
- **THEN** the manifest SHALL report one unmatched bucket with a count of 3000 and a bounded path sample
- **AND** SHALL NOT report 3000 kinds

### Requirement: Coverage is counted, not inferred

The manifest SHALL report how many staged files were assigned to a kind and how many fell
to the unmatched bucket, so a consumer can establish coverage arithmetically. Cross-kind
member counts SHALL likewise be reported, so a missing companion file is a counting result
rather than a judgement.

Completeness established by counting is the quality signal worth carrying: it costs a count,
and it changes what a plan can assume. Per-file statistical quality measures are not in
scope for the scan or the profile.

#### Scenario: Coverage is derivable from the manifest

- **WHEN** the scan assigns 49 of 3513 files to kinds
- **THEN** the manifest SHALL report both figures, so a consumer can establish that coverage was partial

### Requirement: The manifest is both injected and callable

The data-profile body SHALL run the scan before the profiler agent loop and place the
resulting manifest in the agent's briefing, in place of an enumeration of input paths. The
scan is always required and its result does not depend on agent judgement, so spending an
agent turn to request it is waste, and a briefing carrying thousands of bare paths consumes
context that carries no structure.

The harness SHALL additionally expose the scan as a `scan_inputs` tool accepting a path, so
the agent can re-scan a subtree.

#### Scenario: The briefing carries structure, not an enumeration

- **GIVEN** an analysis with 3513 staged input files
- **WHEN** the profiler's briefing is assembled
- **THEN** it SHALL carry the manifest's kinds and axes
- **AND** SHALL NOT carry one line per input file

#### Scenario: The agent re-scans a subtree

- **WHEN** the agent calls `scan_inputs` with a path beneath the analysis root
- **THEN** it SHALL receive a manifest scoped to that subtree
