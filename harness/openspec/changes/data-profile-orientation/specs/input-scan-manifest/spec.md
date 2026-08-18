## ADDED Requirements

### Requirement: The scan reports observations; the agent decides the grouping

The scan SHALL report **what is observable** about the staged input tree and SHALL NOT decide
how the tree is grouped. Deciding which files constitute a *kind*, which varying filename
positions are *axes*, and what any of them mean is the profiler agent's responsibility (see the
data-profile-init spec). This is the governing constraint of this capability, and every
requirement below is subordinate to it.

The two SHALL NOT share vocabulary. The scan reports `shapes` — sets of files that are
mechanically indistinguishable by name structure, format, and location — and, per shape, the
positions in the filename whose token varies, with the values observed at each. It SHALL NOT
emit a field named `kinds` or `axes`, and its output SHALL NOT be shaped so that copying it
constitutes a valid profile. The vocabulary separation is the enforcement: a scan that handed
the agent a field named `kinds` and asked it to author `kinds` would be asking it to ratify a
machine's guess, and ratification is indistinguishable from judgement in the output.

The agent's kinds and axes SHALL NOT be required to correspond one-to-one with observed shapes
and variable positions. An agent MAY report one kind spanning several shapes, several kinds
within one shape, a variable position that is not an axis, or an axis the scan did not observe.

A shape is a mechanical fact: these filenames differ only here. A kind is a claim about meaning:
these files are the same sort of thing. The scan can establish the first and cannot establish the
second, and a manifest that blurred them would make the agent's central judgement invisible —
present in the output, but never actually exercised.

#### Scenario: The manifest carries no kinds or axes

- **WHEN** the scan returns a manifest
- **THEN** it SHALL NOT contain a field named `kinds` or `axes`
- **AND** its shapes SHALL be presented as observations of name structure, not as a grouping of the dataset

#### Scenario: The agent's kinds need not match the observed shapes

- **GIVEN** a manifest reporting one shape whose variable position takes the values `tumor` and `normal`
- **WHEN** the agent determines these are two arms rather than members of one set
- **THEN** it SHALL be able to submit two kinds over the one shape

#### Scenario: The agent may span shapes with one kind

- **GIVEN** a manifest reporting two shapes whose files serve the same analytical role
- **WHEN** the agent determines they are one kind
- **THEN** it SHALL be able to submit one kind covering both shapes

### Requirement: A deterministic scan enumerates the staged input tree

The harness SHALL provide an input scan that walks a staged input tree and returns a
structured manifest without invoking a language model. Per file the manifest SHALL carry
the path relative to the analysis root, the byte size, the extension chain, and a format
identified from magic bytes rather than extension alone. For formats the scan recognises
it SHALL additionally carry a header readout obtained by reading a bounded prefix — never
by decoding a file in full.

The scan SHALL be exposed as a tool. Its enumeration, format detection, and shape
observation SHALL run in the harness process over the workspace read seam, which is
sandbox-independent. Only the header readout SHALL run in the sandbox, because it runs a
decoder over user-supplied bytes and a decoder in the long-lived multi-tenant host process
is the exposure the sandbox exists to contain. A bounded prefix read compared against a
magic-byte table is not a decode and SHALL NOT require the sandbox.

Header readout SHALL be performed per shape, not per file: shape observation depends only
on names and sizes, so shapes SHALL be observed before any decode and each shape SHALL be
enriched by decoding a bounded number of its files. A scan that decoded every file would
make the enrichment cost scale with input size, which is the cost this capability exists
to remove.

The scan SHALL NOT require a binary or script shipped in the sandbox image, so it is
releasable on the harness's own path.

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

#### Scenario: Header decode does not scale with file count

- **GIVEN** a tree of 3513 files forming four observed shapes
- **WHEN** the scan runs
- **THEN** it SHALL decode headers for a bounded number of files per shape
- **AND** SHALL NOT decode a header per file

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

### Requirement: The scan reports filename structure as evidence, not as a conclusion

Per shape the scan SHALL report the constant and variable positions of its filenames, and per
variable position the number of distinct values observed and a bounded sample of those values.

The value sample is normative and is the material the agent's decision rests on. A count alone
cannot distinguish an entity identifier (`0001`…`1171`) from a categorical label
(`tumor`/`normal`) from a shard index (`chr1`…`chr22`), and those readings imply entirely
different kinds. Reporting the count without the values would leave the agent with nothing to
decide *from*, which in practice means deferring to whatever the scan implied.

The scan SHALL report co-occurrence between variable positions where more than one varies, so a
nested structure is visible as such. It SHALL NOT report a single flat file count in place of
per-position value sets, because the per-position structure is the dataset's design evidence and
a flat count destroys it.

#### Scenario: A repeating structure is reported with its values

- **GIVEN** 1171 files named `PATIENT_<id>.haplotypecaller.vcf.gz`
- **WHEN** the scan runs
- **THEN** the manifest SHALL report one shape of 1171 files with one variable position
- **AND** that position SHALL carry a distinct-value count of 1171 and a bounded sample of the values observed

#### Scenario: Nested variation is reported per position

- **GIVEN** files named `PT<subject>_D<timepoint>_rep<replicate>.fastq.gz` spanning 1171 subjects, 3 timepoints, and 2 replicates
- **WHEN** the scan runs
- **THEN** the manifest SHALL report three variable positions with distinct-value counts 1171, 3, and 2
- **AND** SHALL NOT report only a single file count of 7026

#### Scenario: A categorical value set is visible as one

- **GIVEN** a shape whose variable position takes exactly the values `tumor` and `normal`
- **WHEN** the scan runs
- **THEN** the manifest SHALL report those two values, not merely a distinct-value count of 2

### Requirement: Token correspondence across shapes is reported with evidence

The manifest SHALL report token correspondence across shapes with its evidence and SHALL NOT
assume it. Where two shapes' variable positions draw on overlapping value sets, the manifest
SHALL report each shape's observed value set and the overlap between them, and SHALL NOT
present the shapes as sharing one axis — whether they do is the agent's determination.

Correspondence across shapes is heuristic: it depends on stripping a shape-specific suffix
before tokenising, and near-miss namings defeat it. Reported as evidence it is useful; asserted
as a conclusion it is a guess a downstream consumer cannot tell was guessed.

#### Scenario: Overlap is reported, including its gaps

- **GIVEN** 1171 files of one shape and 1168 of another whose variable-position values overlap
- **WHEN** the scan runs
- **THEN** the manifest SHALL report the overlap and name the 3 values present in the first and absent from the second

#### Scenario: Non-overlapping value sets are not presented as one axis

- **GIVEN** two shapes whose variable-position values do not overlap
- **WHEN** the scan runs
- **THEN** the manifest SHALL report them as unrelated value sets rather than asserting a shared axis

### Requirement: Files with no shared name structure are reported in aggregate

Files whose name structure matches no other file SHALL be reported in a single aggregate
carrying a count and a bounded sample of paths. The scan SHALL NOT report one shape per such
file: a tree of arbitrarily named files would otherwise produce a shape count proportional to
the file count, which is the unbounded output this capability exists to prevent.

The aggregate is an observation like any other. Whether those files are notable singletons
worth individual description, or an unclassified remainder, is the agent's determination.

#### Scenario: Arbitrary filenames collapse into one aggregate

- **GIVEN** 3000 files whose names share no structure with any other file
- **WHEN** the scan runs
- **THEN** the manifest SHALL report one aggregate with a count of 3000 and a bounded path sample
- **AND** SHALL NOT report 3000 shapes

### Requirement: Coverage is measured against the agent's kinds, not the scan's shapes

The harness SHALL compute the profile's coverage by matching the agent's submitted kind
patterns against the scanned file set, and SHALL report how many files matched at least one
declared kind and how many matched none.

Coverage measures the profile, not the scan. Computing it from the scan's own shapes would
report only whether the scan grouped its own observations — always yes — and would say nothing
about whether the agent's kinds actually describe the dataset. Measured against the submitted
kinds it is a real check: a profile whose kinds leave most of the tree unmatched is visibly
incomplete, which is the failure that today reads as a fresh, complete profile.

The computation SHALL be deterministic. Matching declared patterns against a known file set
requires no judgement, and coverage a model self-reported would not be a check.

#### Scenario: Coverage reflects the submitted kinds

- **GIVEN** a scan of 3513 files and a submitted profile whose kind patterns match 49 of them
- **WHEN** coverage is computed
- **THEN** it SHALL report 49 matched and 3464 unmatched

#### Scenario: Full coverage is reported as such

- **GIVEN** a submitted profile whose kind patterns match every scanned file
- **WHEN** coverage is computed
- **THEN** it SHALL report zero unmatched

### Requirement: The manifest is both injected and callable

The data-profile body SHALL run the scan before the profiler agent loop and place the
resulting manifest in the agent's briefing, in place of an enumeration of input paths. The
scan is always required and its result does not depend on agent judgement, so spending an
agent turn to request it is waste, and a briefing carrying thousands of bare paths consumes
context that carries no structure.

The harness SHALL additionally expose the scan as a `scan_inputs` tool accepting a path, so
the agent can re-scan a subtree — which is how an agent that disagrees with the observed
shapes gets the evidence to group differently.

#### Scenario: The briefing carries structure, not an enumeration

- **GIVEN** an analysis with 3513 staged input files
- **WHEN** the profiler's briefing is assembled
- **THEN** it SHALL carry the manifest's shapes and their variable-position value sets
- **AND** SHALL NOT carry one line per input file

#### Scenario: The agent re-scans a subtree

- **WHEN** the agent calls `scan_inputs` with a path beneath the analysis root
- **THEN** it SHALL receive a manifest scoped to that subtree
