# input-scan-manifest Specification

## Purpose
TBD - created by archiving change data-profile-orientation. Update Purpose after archive.
## Requirements
### Requirement: The scan reports observations; the agent decides the grouping

The scan SHALL report **what is observable** about the staged input tree and SHALL NOT decide
how the tree is grouped. The scan reports `sets` — files matching one mined name template —
and, per set, its `slots`: the template positions whose token varies, each with a
distinct-value count and a bounded sample of observed values. Deciding which files
constitute a *group*, which slots evidence a *dimension*, and what any of them mean is the
profiler agent's responsibility (see the data-profile-init spec). This is the governing
constraint of this capability, and every requirement below is subordinate to it.

The two SHALL NOT share vocabulary. The manifest SHALL NOT emit a field named `groups` or
`dimensions`, and its output SHALL NOT be shaped so that copying it constitutes a valid
profile. A set is a mechanical fact: these names instantiate one template. A group is a
claim about meaning: these files are the same sort of thing. The scan can establish the
first and cannot establish the second.

The agent's groups SHALL NOT be required to correspond one-to-one with detected sets. The
authoring operations exist precisely because they do not: the agent MAY split one set into
several groups, merge several sets into one group, or gather explicit paths the scan left
ungrouped.

#### Scenario: The manifest carries no groups or dimensions

- **WHEN** the scan returns a manifest
- **THEN** it SHALL NOT contain a field named `groups` or `dimensions`
- **AND** its sets SHALL be presented as observations of name structure, not as a grouping of the dataset

#### Scenario: The agent splits one set into two groups

- **GIVEN** a manifest reporting one set whose slot takes the values `treated` and `control`
- **WHEN** the agent determines these are two arms rather than members of one collection
- **THEN** it SHALL be able to author two groups over the one set

#### Scenario: The agent merges two sets into one group

- **GIVEN** a manifest reporting two sets whose files serve the same analytical role
- **WHEN** the agent determines they are one group
- **THEN** it SHALL be able to author one group covering both sets

### Requirement: A deterministic scan enumerates the staged input tree

The harness SHALL provide an input scan that walks a staged input tree and returns a
structured manifest without invoking a language model. Per file the manifest SHALL carry
the path relative to the analysis root, the byte size, the extension chain, and a format
identified from magic bytes rather than extension alone. For formats the scan recognises
it SHALL additionally carry a header readout obtained by reading a bounded prefix — never
by decoding a file in full.

Decoding SHALL be split by what it needs. Prefix-sufficient readouts — magic-byte
identification, delimiter sniffing, compressed-prefix peeks, text header lines — SHALL run
in the harness process over the workspace read seam, as ordinary linted TypeScript.
Only decoders that must parse a binary container structure (the Parquet and HDF5 families)
SHALL run in the sandbox, and those SHALL ship as a linted, test-covered Python package
asset — not as an inline source string assembled at runtime, which is unlintable,
untestable, and invisible to review.

Header readout SHALL be performed per set, not per file: a bounded number of members per
set, plus the leftover and singleton files individually, up to a bound of their own. A
scan that decoded every file would make enrichment cost scale with input size, which is the
cost this capability exists to remove — and leftovers are not bounded by the menu, so a
tree of one-off files would restore that cost through them. Leftovers past the bound SHALL
be counted and the count surfaced on the menu, so an agent shown a header for some
leftovers and not others is told which. The reads SHALL run at bounded concurrency.

The sandbox decoder SHALL report per path and survive its batch: one unreadable container
SHALL NOT cost the readouts of the files beside it. A path the decoder produced nothing
for SHALL carry a diagnosable reason drawn from the exec's own outcome — its exit status,
its stderr, or its timeout — because "reported nothing" alone names no fault a reader can
act on.

The scan SHALL be the sole enumeration pass. The profiler agent SHALL NOT be required to
issue one command per input file to discover structure.

#### Scenario: The scan reports format from content, not extension

- **WHEN** the scan encounters a gzip-compressed VCF whose name ends `.vcf.gz`
- **THEN** the manifest entry SHALL name the format from the file's magic bytes
- **AND** SHALL carry the header fields read from a bounded prefix of the decompressed stream

#### Scenario: A prefix-decodable format needs no sandbox

- **WHEN** the scan reads the header of a delimited text file or a gzip-wrapped text format
- **THEN** the readout SHALL run in the harness over the workspace read seam
- **AND** SHALL NOT require a sandbox round trip

#### Scenario: A binary container decodes in the sandbox via the packaged decoder

- **WHEN** the scan reads the schema of a Parquet file
- **THEN** the readout SHALL run in the sandbox through the shipped Python decoder package
- **AND** that decoder SHALL exist as reviewable source files, not a string literal

#### Scenario: Header decode does not scale with file count

- **GIVEN** a tree of thousands of files forming a handful of sets
- **WHEN** the scan runs
- **THEN** it SHALL decode headers for a bounded number of files per set plus the leftovers
- **AND** SHALL NOT decode a header per file

#### Scenario: Leftover readouts are bounded and the bound is visible

- **GIVEN** a tree whose leftovers outnumber the readout bound
- **WHEN** the scan runs
- **THEN** it SHALL open at most that many leftovers
- **AND** the menu SHALL say how many it left unopened

#### Scenario: One corrupt container does not cost its batch

- **GIVEN** a batch of containers in which one is unreadable
- **WHEN** the decoder runs
- **THEN** every other container in the batch SHALL still carry its readout
- **AND** the unreadable one SHALL carry a reason naming what failed

### Requirement: The scan recognises the bioinformatics formats the platform accepts

The scan SHALL identify, at minimum, the formats the platform's agents are equipped to
analyse, so that a file's `format` is a fact rather than an extension guess:

- **Variants** — VCF, BCF, and their tabix/CSI indexes
- **Alignments** — SAM, BAM, CRAM, and their indexes
- **Sequence** — FASTA, FASTQ, and their bgzip-compressed forms
- **Intervals and annotation** — BED, GFF/GFF3, GTF, WIG, bigWig, bigBed, chain
- **Matrices and containers** — HDF5, h5ad, loom, Matrix Market with its barcode and feature
  sidecars, Zarr, RDS
- **Tabular** — CSV, TSV, and other delimited text with the delimiter sniffed, Parquet, Excel
- **Genotype** — PLINK bed/bim/fam and pgen/pvar/psam
- **Chemistry and structure** — SDF, MOL/MOL2, SMILES, PDB, mmCIF
- **Mass spectrometry** — mzML, mzXML, mzIdentML, MGF
- **Arrays** — IDAT, CEL
- **Imaging** — DICOM, NIfTI, OME-TIFF
- **Documents and config** — PDF, DOCX, Markdown, JSON, YAML

Compression wrappers (gzip, bgzip, zstd, bzip2) SHALL be reported alongside the inner format
rather than in place of it, because `.vcf.gz` is a VCF and a shape observed on the wrapper
would present unrelated data as mechanically alike.

An unrecognised format SHALL be reported as unknown with its extension chain preserved. The
list is a floor, not a closed set, and an unknown format SHALL NOT prevent a file from joining
a shape — shape observation depends on names and sizes, which are always available.

#### Scenario: A compressed format reports its inner type

- **WHEN** the scan encounters `sample.vcf.gz`
- **THEN** it SHALL report the format as VCF with a gzip wrapper
- **AND** SHALL NOT report the format as gzip

#### Scenario: An unknown format still joins a shape

- **GIVEN** 200 files of a format the scan does not recognise, sharing a name structure
- **WHEN** the scan runs
- **THEN** it SHALL report the format as unknown with the extension chain preserved
- **AND** SHALL still report them as one shape with its variable position

### Requirement: Files with no shared name structure are reported in aggregate

Files whose name matches no mined template SHALL be reported as leftovers in a single
aggregate carrying a count and a bounded sample of paths. The scan SHALL NOT report one
set per such file: a tree of arbitrarily named files would otherwise produce a set count
proportional to the file count, which is the unbounded output this capability exists to
prevent.

The aggregate is an observation like any other. Whether those files are notable singletons
worth individual description, an explicit group gathered by path, or an unclassified
remainder is the agent's determination.

#### Scenario: Arbitrary filenames collapse into one aggregate

- **GIVEN** many files whose names share no structure with any other file
- **WHEN** the scan runs
- **THEN** the manifest SHALL report one aggregate with their count and a bounded path sample
- **AND** SHALL NOT report one set per file

### Requirement: The scan mines templates over the full relative path

The scan SHALL mine name templates over the **whole relative path** — directory segments,
stem, and dotted suffix chain — deciding per position whether the token is a literal or a
slot. Identity that lives in a directory segment SHALL be a slot like any other: a tree
whose per-entity variation is expressed as one directory per entity is structure, not
absence of structure.

The token classes SHALL include an opaque-identifier class: long, high-entropy tokens
(machine-issued upload and object identifiers) SHALL be recognised as identifiers and
matched as a class, not treated as distinct literals that fragment the template space.
Dotted suffix chains SHALL be minable as slots — a categorical token inside the chain is a
varying position, not part of the file extension.

Template proliferation SHALL be bounded by a description-length criterion: a split into
more templates must pay for itself in shorter member descriptions, so near-identical
templates collapse rather than multiply.

Per slot the scan SHALL report the number of distinct values and a bounded sample of those
values. The value sample is normative and is the material the agent's decision rests on: a
count alone cannot distinguish an entity identifier from a categorical label from a shard
index, and those readings imply entirely different groups. Where more than one slot varies,
the scan SHALL report the per-slot structure and their co-occurrence, never a single flat
file count.

#### Scenario: Identity in a directory segment forms a cross-directory set

- **GIVEN** files laid out as `cohort/<subject>/<sample>/<sample>__calls.vcf.gz` across many subjects
- **WHEN** the scan runs
- **THEN** it SHALL report one set spanning those directories with subject and sample slots
- **AND** SHALL NOT report the files as unstructured because no single directory holds them all

#### Scenario: Opaque identifiers do not fragment the template

- **GIVEN** files whose stems embed long machine-issued identifiers unique per file
- **WHEN** the scan runs
- **THEN** those tokens SHALL be classed as one identifier slot
- **AND** the files SHALL join one set rather than one set each

#### Scenario: A categorical suffix chain is a slot, not an extension

- **GIVEN** files named `<sample>__calls.<class>.<caller>.vcf.gz` where `<class>` and `<caller>` each take a few values
- **WHEN** the scan runs
- **THEN** `<class>` and `<caller>` SHALL be reported as slots with their value sets
- **AND** the format SHALL be reported as VCF, not as an unknown compound extension

#### Scenario: Nested variation is reported per slot

- **GIVEN** a set whose template carries subject, timepoint, and replicate slots
- **WHEN** the scan runs
- **THEN** the manifest SHALL report the three slots with their distinct-value counts
- **AND** SHALL NOT report only the set's total file count

#### Scenario: Slot co-occurrence distinguishes a full crossing from a partial one

- **GIVEN** a set whose two slots take 8 and 3 values
- **WHEN** the menu renders it
- **THEN** it SHALL report how many combinations were observed against the full cross product
- **AND** an incomplete crossing SHALL be named as one

### Requirement: Token correspondence across sets is reported with evidence

The manifest SHALL report slot correspondence across sets with its evidence and SHALL NOT
assume it. Where two sets' slots draw on overlapping value sets, the manifest SHALL report
each set's observed values and the overlap between them, and SHALL NOT present the sets as
sharing one dimension — whether they do is the agent's determination, recorded as a slot
observation (see the data-profile-init spec).

Where the same token appears in both a directory segment and the stem of one path, the
scan SHALL cross-check the two positions and report them as one identity slot rather than
two independent slots.

#### Scenario: Overlap is reported, including its gaps

- **GIVEN** two sets whose identity slots overlap on most but not all values
- **WHEN** the scan runs
- **THEN** the manifest SHALL report the overlap and name the values present in one set and absent from the other

#### Scenario: A repeated token is one slot

- **GIVEN** paths where the sample token appears as both a directory segment and a stem prefix
- **WHEN** the scan runs
- **THEN** the manifest SHALL report one identity slot spanning both positions

#### Scenario: Non-overlapping value sets are not presented as one dimension

- **GIVEN** two sets whose slot values do not overlap
- **WHEN** the scan runs
- **THEN** the manifest SHALL report them as unrelated value sets rather than asserting a shared dimension

### Requirement: The menu is both injected and callable

The data-profile body SHALL run the scan before the profiler agent loop and place the
resulting menu — the detected sets with their slots, the quarantine summary, and the
leftover aggregate — in the agent's briefing, in place of an enumeration of input paths.
The scan is always required and its result does not depend on agent judgement, so spending
an agent turn to request it is waste, and a briefing carrying thousands of bare paths
consumes context that carries no structure.

The menu SHALL be bounded. Its set list SHALL carry at most a fixed number of entries;
beyond the bound the remainder is aggregated with an explicit overflow note, so an elided
tail is a fact the agent can see and act on rather than a silent truncation. A walk that
stopped at its own file ceiling SHALL be stated on the menu prominently: every count on it
is then a count over part of the tree, and a grouping authored as though it were complete
is wrong in a way nothing later reveals.

A set small enough to annotate member by member SHALL be listed member by member. Member
annotations are keyed by path, so an agent shown one example of five cannot write prose for
the other four — the bound is on the listing, not on the set.

The menu SHALL nudge toward a split on any set that is residue rather than structure: one
no sharper template explained, or one whose format census says its members are not a single
substrate.

The harness SHALL additionally expose the scan as a `scan_inputs` tool accepting a path,
so the agent can re-scan a subtree. A re-scan is informational: it refines what the agent
knows, and the authoring operations still address the menu the body rendered (see the
data-profile-init spec).

#### Scenario: The briefing carries the menu, not an enumeration

- **GIVEN** an analysis with thousands of staged input files
- **WHEN** the profiler's briefing is assembled
- **THEN** it SHALL carry the detected sets with their slots and value samples
- **AND** SHALL NOT carry one line per input file

#### Scenario: A menu past its bound says so

- **GIVEN** a tree producing more sets than the menu bound
- **WHEN** the briefing is assembled
- **THEN** the menu SHALL carry the bounded list plus an aggregate naming how many sets were elided

#### Scenario: A truncated walk says so before anything else

- **GIVEN** a tree larger than the walk's file ceiling
- **WHEN** the briefing is assembled
- **THEN** the menu SHALL state that it describes part of the tree
- **AND** the persisted accounting and the rendered orientation SHALL carry the same fact

#### Scenario: A small set is listed member by member

- **GIVEN** a set of a handful of members
- **WHEN** the menu renders it
- **THEN** it SHALL list every member's path rather than one example

#### Scenario: The agent re-scans a subtree

- **WHEN** the agent calls `scan_inputs` with a path beneath the analysis root
- **THEN** it SHALL receive a manifest scoped to that subtree

### Requirement: Junk and partial artifacts are quarantined before structure is observed

Before template mining, the scan SHALL quarantine files matching a curated junk list
(operating-system and sync-tool droppings), atomic-write temp idioms, and partial-download
temp patterns. Quarantined files SHALL NOT join sets, SHALL NOT count toward membership,
and SHALL NOT enter the drift signature (see the data-profile-rerun spec).

Quarantine SHALL be visible, never silent: the manifest SHALL carry a quarantine summary
with counts per reason and a bounded path sample, so a wrongly quarantined file is
discoverable by the agent and the user.

#### Scenario: A partial-download twin is quarantined

- **GIVEN** a completed data file beside a partial-download temp file of the same stem
- **WHEN** the scan runs
- **THEN** the completed file SHALL join its set and the temp file SHALL be quarantined
- **AND** the temp file SHALL NOT appear as a member or distort the set's template

#### Scenario: Quarantine is reported, not hidden

- **WHEN** the scan quarantines any file
- **THEN** the manifest SHALL carry a quarantine summary naming the reasons and counts

### Requirement: Known dataset markers claim their subtree

The scan SHALL recognise a curated list of dataset marker files — a feature-barcode matrix
triplet, a study metadata manifest, a dataset descriptor — and a recognised marker SHALL
claim its subtree as one set carrying the marker's identification. A claimed subtree SHALL
NOT be re-mined into name-template sets, because the marker identifies the collection more
precisely than its filenames can.

The marker list is a floor, not a closed set; growth of the catalogue is additive.

#### Scenario: A matrix triplet claims its directory

- **GIVEN** a directory holding a matrix file with its barcode and feature sidecars
- **WHEN** the scan runs
- **THEN** it SHALL report the directory as one marker-identified set
- **AND** SHALL NOT mine the three filenames into templates

### Requirement: Sets may span sibling directories

The scan SHALL cluster sibling directories whose contents agree on name template and
format census into one set rooted at their common parent, so a per-entity directory layout
is one set with the entity as a slot, not one observation per directory. Clustering SHALL
require strong agreement and a majority of siblings; a sibling that does not agree stays
outside the cluster. The agreement computation SHALL be extensible to content-schema
evidence when header readouts are available.

#### Scenario: Per-entity directories form one set

- **GIVEN** dozens of sibling directories, one per sample, each holding the same file layout
- **WHEN** the scan runs
- **THEN** it SHALL report one set rooted at the parent with a sample slot
- **AND** SHALL NOT report one observation per directory

#### Scenario: A disagreeing sibling stays out

- **GIVEN** sibling directories that agree except one holding unrelated content
- **WHEN** the scan runs
- **THEN** the agreeing siblings SHALL form the set and the outlier SHALL be reported separately

### Requirement: Wrapper and companion variance is carried on the set, not split

Files differing only in compression wrapper SHALL be one set with the wrapper disagreement
recorded as a set property, not two sets. Companion files — same-stem helpers such as
indexes and checksums — SHALL attach to their data file: a member is the logical unit of a
data file plus its companions, membership counts logical units, and the scan SHALL compute
per-member completeness so a member missing an expected companion is visible.

#### Scenario: Mixed wrappers stay one set

- **GIVEN** a set where some members are gzip-compressed and some are not
- **WHEN** the scan runs
- **THEN** it SHALL report one set carrying the wrapper variance
- **AND** SHALL NOT split the set on compression

#### Scenario: A companion attaches to its member

- **GIVEN** a variant file beside its tabix index
- **WHEN** the scan runs
- **THEN** the two SHALL form one member and the set's count SHALL count them once

#### Scenario: A missing companion is visible

- **GIVEN** a set where most members carry an index companion and one does not
- **WHEN** the scan runs
- **THEN** the manifest SHALL report that member as incomplete rather than averaging the difference away

