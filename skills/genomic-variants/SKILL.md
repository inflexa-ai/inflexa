---
name: genomic-variants
description: Analysis of called genomic variants — filtering, annotation, GWAS, and population-genetics summaries from VCF and PLINK-format data
version: 1.0.0
tags: [wgs, wes, gwas, variant-annotation, population-genetics, plink2]
---

# Genomic Variant Analysis

Guidelines for working with **called** variants: quality filtering, annotation
against catalogued resources, genome-wide association, and population-genetics
summaries.

## Where This Pack Starts

Your input is a VCF/BCF, a PLINK-format cohort, or an aligned BAM/CRAM you read
evidence from. Variant calling is upstream and out of scope — no caller is
installed and none can be. If you are handed reads, say what called form you
need and stop.

Knowing what produced the input still matters for reading it. Germline call sets
usually come from GATK HaplotypeCaller, DeepVariant or FreeBayes; somatic sets
from Mutect2; structural variants from Manta, DELLY or Sniffles2; copy number
from CNVkit or FACETS. Use those names to interpret the FILTER values, INFO
fields and headers you are given — not as steps to run.

## Method-Selection Decision Tree

### 1. Variant filtering

```
Called VCF
  → Programmatic pass → cyvcf2 (Python), full control over per-record logic
  → Expression pass over a large file → bcftools view/filter
  → Rare-variant subset → allele frequency from an annotation resource,
    or cohort AF computed from AC/AN when none resolves
```

- Hard-filter thresholds for a supplied germline call set, when the INFO fields
  are present: `QD > 2.0`, `FS < 60.0`, `MQ > 40.0`, `MQRankSum > -12.5`,
  `ReadPosRankSum > -8.0`. Check the distributions before applying them — these
  are starting points, not universal cutoffs, and a caller that did not emit a
  field cannot be filtered on it.
- Report the FILTER field as the caller populated it. Never present an
  unfiltered set as filtered.

### 2. GWAS

```
Genotype data (VCF or PLINK format)
  → QC: missingness (<0.02), HWE (p > 1e-6), MAF (>0.01)
    → Population structure: PCA (top 10-20 PCs as covariates)
      → Relatedness: PLINK2 --king-cutoff (remove or model related pairs)
        → Association: PLINK2 --glm (linear/logistic)
```

- **Verify `plink2` is on PATH before building a pipeline around it — it is
  installed on x86_64 only.** There is no linux-aarch64 build, so on an arm64
  host it is absent by design, not by misconfiguration, and no-egress means it
  cannot be installed at runtime. Probe (`command -v plink2`), and if it is
  missing, report the reason and fall back: `bcftools`/cyvcf2 for filtering,
  allele frequencies and missingness, statsmodels for per-variant association on
  a cyvcf2-extracted dosage matrix, scikit-learn PCA for population structure.
  `references/plink2-cli.md` maps each step to its substitute.
- ALWAYS include PCA covariates to adjust for population structure. Omitting
  this produces inflated results.
- Check genomic inflation factor (lambda_GC); values >1.05 suggest residual
  confounding.

### 3. Variant annotation

Annotation here is a **join you perform**, not a tool you invoke: VEP and SnpEff
are not installed, and their caches and plugin data cannot be fetched anyway.
Resolve an annotation resource from the reference data available to you and join
on position and alleles.

- **Some of the resources this section needs are in the reference inventory and
  some are not.** ClinVar (GRCh38, with its tabix index), GENCODE gene
  annotation, indexed genome sequence for human and mouse, and hg19/hg38
  conversion chains are all available as opt-in downloads. Still absent, and too
  large to stage this way: gnomAD and dbSNP. Note that the genome sequence and
  ClinVar share a contig-naming convention that the GENCODE annotation does not —
  check each resolved entry's stated naming rather than assuming they agree.
  Resolve what you need by what it is, up front, and expect an opt-in resource
  may not be staged. If it is absent: say so plainly, deliver the
  annotation-independent results (call sets, quality metrics, cohort allele
  frequencies computed from your own AC/AN), and state what must be provisioned.
  Never invent a resource path, never substitute a different database
  unannounced, and never quietly drop a filtering step whose reference is
  missing — an unfiltered call set reported as filtered is the worst outcome
  here.
- **ClinVar is an assertion database, not a truth table.** Filter on
  `CLNREVSTAT` before believing `CLNSIG`: a single-submitter claim with no
  assertion criteria is not equivalent to an expert-panel review, and reporting
  the two alike overstates confidence. Its contigs are unprefixed (`1`, not
  `chr1`), the opposite of the staged GENCODE annotation — reconcile naming
  before joining, or every intersect returns empty without erroring.
- **A 1000 Genomes hit in the inventory is not a filtering resource.** What is
  staged under that name is a phased haplotype reference panel — a phasing
  input, not a truth set. Same cohort, different product. Binding it to a
  filtering step is not an error that surfaces; it is one that quietly produces
  a meaningless result, so check what an entry is *for* before using it.

### 4. Reading evidence behind a call

- pysam reads BAM/CRAM: depth, pileup and read attributes at sites you already
  have. This is for inspecting the support for an existing call — it is not a
  route to making one.
- PyRanges (or `bedtools`) for interval work: overlaps, nearest feature, region
  filtering, window queries.

## Anti-Patterns

- **Calling variants**: Do NOT attempt to produce calls from BAM, CRAM or reads.
  A hand-rolled pileup threshold is not a variant caller. Report what the called
  input needs to contain.
- **Ignoring population stratification in GWAS**: Do NOT run association tests
  without PCA covariates. This is the single most common source of false
  positives in GWAS.
- **Not filtering by quality/depth**: Do NOT trust raw VCF output without
  quality filtering. Unfiltered calls contain abundant false positives from
  mapping artifacts, low coverage, and strand bias.
- **Wrong reference genome build**: Do NOT mix GRCh37/hg19 and GRCh38/hg38
  coordinates. Verify the reference build of all input files before analysis.
  Conversion chains for both directions are in the reference inventory as an
  opt-in download; the resolved entry states the one preparation step they need
  before a reader will open them. Conversion is lossy — intervals in regions
  rearranged between builds drop out entirely — so compare the count going in
  against the count coming out and report the loss rather than presenting a
  converted set as complete.
- **Ignoring relatedness**: Do NOT assume samples are unrelated in GWAS. Cryptic
  relatedness inflates test statistics. Exclude or model related pairs.
- **Raw allele counts as frequencies**: Do NOT report allele counts without
  normalizing by total alleles. Always compute allele frequency (AF) from AC/AN.

## Output Conventions

- Filtered variants: VCF format with proper headers, FILTER field populated.
- Summary tables: CSV with columns `chrom`, `pos`, `ref`, `alt`, `gene`,
  `consequence`, `clinical_significance`, plus the resource and version each
  annotation came from.
- GWAS results: CSV with `rsid`, `chrom`, `pos`, `ref`, `alt`, `beta`/`OR`,
  `se`, `pvalue`, `maf`.
- Figures: Manhattan plot, QQ plot (GWAS), variant allele frequency spectrum.

## Additional Available Packages

- **pyfaidx**: Random access to FASTA sequences by coordinate — extracting
  regions around variants.
- **VariantAnnotation** (R via rpy2): `readVcf()`, `info()`, `geno()`. The R-side
  complement to cyvcf2 when the rest of the step is already in R.

## References

- `references/cyvcf2-api.md` — Fast VCF parsing in Python
- `references/pysam-api.md` — BAM/CRAM reading and pileup operations
- `references/pyranges-api.md` — Genomic interval arithmetic
- `references/plink2-cli.md` — PLINK2 commands for GWAS QC and association testing
