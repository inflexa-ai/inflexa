# Vocabulary — DRAFT v2 (three blind adversarial reviews integrated)

The controlled vocabulary the profiler draws from. Ships as data (a versioned module
the schema validates against and the prompt renders from), not as code — categories
grow by editing this list, monitored through `other` usage. All examples synthetic.
Reviewed by three independent blind passes; former pending calls resolved 2026-08-24
(cohort-arm defaults dimension; code is a category).

Design rules this draft follows:

1. **Categories label what was found — never a checklist to fill.** An empty
   dimension list is a correct answer for a simple tree.
2. **Every category carries an anti-overlap note** naming its nearest neighbor and
   the rule that separates them.
3. **Every dimension category carries a default treatment** under the substrate test
   (design.md): *would a downstream step **typically** consume one value's files as a
   different substrate than another's?* ("Typically", not "ever" — nearly any value
   can be consumed separately in some workflow, so "ever" cannot discriminate.) The
   agent follows defaults and deviates only with a stated reason.
4. **Content beats shape.** A probe×sample methylation beta matrix is methylation,
   not expression-matrix; a MAF (one row per mutation) is variant-calls, not
   clinical-table. Grain and meaning decide, not file layout.
5. Free-text refinement lives *below* the category (`label`, `subtype`), never
   instead of it.

## Group roles (closed, 5)

| role | definition | example |
|-|-|-|
| data | the measurements themselves | variant calls, count matrix, images |
| metadata | describes other members' meaning or provenance | sample sheet, pipeline manifest, config files |
| index | standalone lookup/join tables | a variable-code dictionary, a file inventory table |
| documentation | prose for humans | README, dataset card, methods paper, licenses |
| reference | external/canonical inputs the analysis consumes but did not produce | genome build, annotation GTF, compound library, pathway sets, spectral libraries |

Companions (`.bai`/`.tbi`/per-file `.md5`) never form groups and take no role — they
attach to members (design.md, Topic 1). A **multi-member checksum or inventory file**
(top-level `MD5SUMS`, manifest spanning many members) is NOT a companion — it is a
member, category `manifest`. `index` is for *tables that exist to be joined against*,
not for binary index sidecars.

## Group categories (closed + `other`)

Coarse on purpose (GDC-style); `subtype` refines freely below.

sequencing-reads · alignment · variant-calls · copy-number · structural-variants ·
association-results · regions-signal · expression-matrix · single-cell-matrix ·
methylation · proteomics · metabolomics · cytometry · chemical-structures · imaging ·
clinical-table · sample-annotation · code · document · manifest · reference-data ·
other

Definitions where non-obvious:

- `sequencing-reads` — reads **or raw instrument signal**: FASTQ, unaligned BAM,
  FAST5/POD5.
- `association-results` — per-variant/per-feature summary statistics without
  per-sample data: GWAS/QTL sumstats (GWAS-SSF, PLINK output).
- `regions-signal` — genomic intervals and coverage tracks: BED/narrowPeak/
  broadPeak, bigWig/bedGraph.
- `cytometry` — flow/mass cytometry (FCS); neither imaging nor proteomics.
- `code` — scripts, notebooks, workflow definitions arriving as inputs. Decided as
  a category (not a sixth role): the role set stays orthogonal, and configs→metadata,
  licenses→documentation already hold.

Anti-overlap notes (every category's nearest neighbor):

- `sequencing-reads` vs `alignment`: mapped-ness decides — unaligned BAM is reads.
- `variant-calls` vs `copy-number`/`structural-variants`: small variants (SNV/indel)
  are variant-calls; CNV and SV products get their own categories whatever the
  container (an SV VCF is structural-variants).
- `variant-calls` vs `association-results`: per-sample genotypes vs cohort-level
  statistics.
- `variant-calls` vs `reference-data`: sites-only population/annotation VCFs
  (dbSNP/ClinVar-class) are reference-data, role reference.
- `regions-signal` vs `association-results`: positions/coverage vs test statistics.
- `expression-matrix` vs `single-cell-matrix`: barcoded per-cell products (MEX/h5ad)
  are single-cell; bulk gene×sample tables are expression. **Spatial omics
  (Visium/Xenium-class) is a `subtype` of single-cell-matrix.**
- `methylation` vs `expression-matrix`: content beats shape (rule 4) — beta-value
  matrices are methylation.
- `proteomics`/`metabolomics`: by measured substrate; MS rawness is a subtype.
  Imaging mass spec: **assay substrate wins** — proteomics/metabolomics with
  subtype "imaging MS", not imaging.
- `imaging` vs `cytometry`: microscopy/radiology pixels vs per-event cytometry
  measurements.
- `clinical-table` vs `sample-annotation`: facts about *subjects over time*
  (diagnoses, medications, outcomes) vs *specimen/measurement* attribute maps.
  When one table does both, prefer sample-annotation only if its grain is the
  sample. (Mirrors the patient-table vs sample-table split in cancer-genomics
  portals.)
- `manifest` vs `document`: machine-readable inventory vs prose. A dataset card in
  Markdown is a document; its JSON twin is a manifest.
- `manifest` vs `index`-role: an inventory *of these files* is a manifest; a table
  that exists to be joined against data is index-role.
- `code` vs `document`: executable vs prose; a notebook is code even when narrated.
- `reference-data` vs everything: consumed-not-produced canonical inputs — genome
  builds, GTFs, pathway sets (GMT/SIF), spectral libraries.
- Correctly `other` (watch in the `other` monitor): electrophysiology, phylogenetic
  trees (Newick), ML model weights, database dumps, plate-reader/qPCR Ct tables.

Scanner pre-suggestion (near-certain only; agent confirms or overrides):

- FASTQ / FAST5 / POD5 → sequencing-reads
- **BAM/CRAM: unsuggested by name alone** (unaligned BAM is routine); suggest
  alignment only when a header readout confirms mapped reads.
- **VCF: variant-calls only when the readout shows sample genotype columns and no
  SVTYPE**; SVTYPE → structural-variants; sites-only → reference-data. Otherwise
  unsuggested.
- MAF → variant-calls · MEX triplet / h5ad → single-cell-matrix (spatial as
  subtype) · FCS → cytometry · DICOM → imaging · SDF/SMILES →
  chemical-structures · md/pdf/docx → document
- Marker-claimed sets carry their archetype's category. Everything else ships
  unsuggested.

## Dimension categories (closed + `other`)

### Biological (scope: biological)

| category | definition | default | anti-overlap |
|-|-|-|-|
| subject | the individual the data is about (patient, animal, donor). **PDX/xenograft: subject = the donor; the host is genotype context** | dimension — never split | not the specimen; see sample |
| sample | physical specimen; **nests under subject when one exists** (community/environmental samples have none) | dimension — never split | not the library/aliquot (technical: library-prep) |
| organism-species | species, when it varies across the dataset | **split** — species picks the reference genome | constant organism is the identity field |
| model-system | cell line / organoid / model identity in subject-less panels (cell-line pharmacogenomics) | dimension | a line used as the *subject surrogate* is still model-system, not subject |
| cohort-arm | deliberate grouping **assigned by design** (randomization, dose groups, discovery/validation cohorts) — assigned-by-design is the SOLE test | dimension — comparative models consume all arms together; split only for independent cohorts (discovery vs validation), as a stated deviation | observed conditions are disease-state, even when they define the comparison |
| disease-state | observed diagnosis/condition varying across subjects — including observational case/control | dimension | assigned-by-design grouping → cohort-arm |
| treatment | compound / dose / intervention as the varying quantity, incl. protocol-administered diet | dimension (dose-response curves consumed together) | named designed groups → cohort-arm; ambient exposure → environment |
| timepoint | when the measurement was taken (subject/visit time). **Acquisition/run/processing dates are batch, not timepoint** | dimension — known-ambiguous, documented | duration-of-exposure is treatment |
| tissue-site | organism part / sampling site / biofluid or subcellular fraction (plasma vs serum, nuclear vs cytosolic), when it varies | dimension — ambiguous like timepoint | constant tissue is an identity field |
| cell-type | sorted population / annotated type, when it varies across files | dimension | per-cell annotations inside one matrix are file content, not a dimension |
| genetic-perturbation | strain, genetic modification, KO/WT, CRISPR guide / shRNA / ORF per member | dimension | perturbation as the study's designed comparison → cohort-arm |
| sex | — | dimension | — |
| age-group | age or age band as a varying attribute | dimension | — |
| developmental-stage | — | dimension | age-group is calendar; stage is biology |
| environment | diet, stimulus, growth condition, field location | dimension | administered per protocol → treatment; plot/block structure → batch |

### Technical (scope: technical)

| category | definition | default | anti-overlap |
|-|-|-|-|
| assay-modality | which measurement technology (RNA-seq vs proteomics vs imaging). Different-marker panels (T-cell vs myeloid) are different modality/target, not versions | **split** — different substrates | version of one assay is assay-version |
| assay-target | the molecular target an assay is directed at (ChIP antibody target, panel target set) | **split** — each target's output is a distinct substrate | modality is the technology; target is what it points at |
| variant-origin | somatic vs germline | **split** (canonical substrate case) | — |
| sample-pairing | tumor/normal, matched-pair membership | **split** — with pairs co-retrievable via a pair id (paired callers consume both halves together) | pairing is within-subject; cohort-arm is between-subjects |
| processing-level | raw / filtered / normalized tiers of the same product | **split** — steps consume one tier | alternate tools at the same tier → tool-variant |
| assay-version | panel/kit/pipeline **version** (same target set) | dimension (batch-like) | different marker sets → assay-modality/assay-target |
| batch | plate, lane, center, run/acquisition date | dimension — never split | subject-visit time is timepoint |
| replicate | replicate index — **label MUST state biological or technical** (MIAME) | dimension — never split | — |
| tool-variant | alternate callers/aligners over the same input | dimension (consumed together for consensus) | pipeline versions over time → assay-version |
| library-prep | library, label, capture, aliquot | dimension | biofluid/subcellular fraction is biological → tissue-site |
| data-partition | chromosome shard, file chunk, read-pair half, paged export | dimension — never split, rarely promoted | pure mechanics; promotion rule keeps it off the dataset list |

## Probe list (shipped as data, 5 entries)

Probes are the ONLY dimensions the agent must actively look for. The
probe-searchable set is bounded and named: **files in metadata- or
documentation-role groups, plus clinical-table / sample-annotation members — up to
~10 files.** Probe-driven reads do not widen the evidence base for non-probe
dimensions (they exist for the probes; everything else still requires ordinary
encounter).

Probe outcomes (exactly one per probe):

- **found** — observations with checkable evidence: file + column/token name +
  2–3 verbatim example values. An invented citation is falsifiable against the file.
- **not-found** — valid only when `searched` covers the probe-searchable set above,
  with a reason.
- **found-but-constant** — the attribute exists but does not vary → recorded as an
  identity field, not a dimension.
- **attested** — prose-only evidence (dataset card says "3 arms") with no
  column/slot found: recorded as attested, not operationalized. **An attested find
  can never justify a split.**

Resolution rules: one column feeds at most one category — a probe hit that the
anti-overlap reassigns (an observed condition column reached via the cohort-arm
probe) is answered not-found *with a pointer* to where it landed. When two sources
disagree on the same probe (two sample-ID schemes, two time encodings), report both
observations under one entry, flagged — never silently pick one.

| probe | where "found" typically comes from |
|-|-|
| subject | ID slots in per-subject trees; subject-ID columns in clinical/sample tables. Reference-only trees are a legitimate not-found — a genome build's species is not a subject |
| sample | sample-ID slots or columns; sample sheets; nests under subject when both exist |
| cohort-arm | arm/group columns whose values are **assigned by design** (randomization, dose groups). An observed `condition`/diagnosis column is disease-state — answer not-found and point to it. Observational RWD typically has no arms |
| timepoint | visit/day/cycle columns; timepoint tokens in names. Acquisition/run dates are batch |
| batch | plate/lane/run columns; run-date tokens; center identifiers. Subject-visit time is timepoint |

Deliberately NOT probed (rationale recorded): **assay-modality** — varying modality
is already surfaced by group categories and scanner format suggestions; a probe adds
redundancy, not coverage. **replicate** — labeled replicate columns are a minority;
probing would invite *inferring* replicate structure from sample counts, which is
fabrication by another name, while the never-split default makes a miss cheap.

## Usage instructions (rendered into the prompt)

- Apply the substrate test ("typically", not "ever") before splitting; follow
  category defaults; deviate only with a stated reason.
- Pick the most specific category that covers ALL of a group's members. If members
  straddle two categories, that is usually a split you have not made yet.
- Content beats shape (rule 4).
- `other` is allowed and monitored — a wrong specific category is worse than an
  honest `other` with a good label.
- Dimensions come only from scanner slots and from files you already read; the probe
  list names the one bounded exception. "Not found" and "found-but-constant" are
  acceptable findings.
- Constants are identity fields, not dimensions.

## Sources (public standards)

Expression Atlas controlled vocabulary (EFO), MAGE-TAB/SDRF factor-vs-characteristic
and sample/assay split, MIAME replicate typing, OMOP CDM clinical dimensions, GDC
data_category/data_type, ENCODE output_category + target metadata, cBioPortal
file-type enum, EDAM data/format/script branches, ISA factor definition, GWAS-SSF,
ISAC FCS, MIxS environmental sample standards.
