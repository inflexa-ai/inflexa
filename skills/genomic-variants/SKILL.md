---
name: genomic-variants
description: Genomic variant analysis — germline/somatic SNV, structural variants, CNV, GWAS, annotation, and filtering
version: 1.0.0
tags: [wgs, wes, gwas, variant-calling, cnv, structural-variants, plink2]
---

# Genomic Variant Analysis

Comprehensive guidelines for variant calling, annotation, structural variant detection, copy number analysis, and genome-wide association studies.

## Method-Selection Decision Tree

### 1. Germline SNV/Indel Calling

```
Aligned BAM/CRAM (WGS or WES)
  → GATK HaplotypeCaller (gold standard, local assembly-based)
    → Joint genotyping via GenomicsDBImport + GenotypeGVCFs (cohort)
  → DeepVariant (deep learning-based, higher SNV accuracy on WGS)
  → FreeBayes (Bayesian haplotype-based, good for small cohorts)
```

- GATK HaplotypeCaller is the default for most projects.
- DeepVariant excels on WGS SNV calling; consider as complementary caller.
- For small panels (<50 genes), hard filtering is preferred over VQSR.

### 2. Somatic SNV/Indel Calling

```
Tumor BAM + matched normal BAM (preferred)
  → Mutect2 (GATK, default somatic caller)
    → FilterMutectCalls with contamination + orientation bias filters
    → Panel of normals (PoN) for artifact removal

Tumor-only mode (no matched normal)
  → Mutect2 --tumor-only with gnomAD resource for germline filtering
    → Higher false positive rate — requires stringent post-filtering
```

- NEVER use a germline caller (HaplotypeCaller, DeepVariant) on tumor samples. They assume diploid germline and will miss subclonal variants.
- Always run GetPileupSummaries + CalculateContamination before FilterMutectCalls.

### 3. Structural Variant Detection

```
Short-read WGS
  → Manta (deletions, insertions, inversions, tandem duplications)
    → DELLY (split-read + paired-end, strong for balanced events)
      → Ensemble: merge calls from both, require support from >=1 caller

Long-read WGS (ONT/PacBio)
  → Sniffles2 (preferred for long reads)
  → cuteSV (alternative)
```

- Manta is fast and handles most SV types. DELLY adds sensitivity for balanced rearrangements.
- For clinical SVs, always visually inspect with IGV.

### 4. Copy Number Variation (CNV)

```
WES / targeted panels
  → CNVkit (default): reference-based log2 ratio segmentation
    → Requires a pool of normals or flat reference

WGS
  → GATK gCNV (cohort-based, HMM model)
  → Control-FREEC (alternative, GC-corrected)

Tumor samples
  → FACETS (joint estimation of purity, ploidy, allele-specific CNV)
    → Requires tumor + matched normal
```

- CNVkit is the workhorse for WES CNV. Always build a reference from matched normals when available.
- FACETS provides allele-specific copy number — essential for tumor purity/ploidy estimation.

### 5. GWAS

```
Genotype data (VCF or PLINK format)
  → QC: missingness (<0.02), HWE (p > 1e-6), MAF (>0.01)
    → Population structure: PCA (top 10-20 PCs as covariates)
      → Relatedness check: KING (remove/flag related pairs)
        → Association testing:
          → PLINK2 --glm (default, fast, linear/logistic)
          → REGENIE (large biobank-scale, whole-genome regression)
          → SAIGE (case-control imbalance, saddlepoint approximation)
```

- PLINK2 is the default tool for GWAS QC and association. Use the `--glm` command. **Verify `plink2` is on PATH before building a pipeline around it — it is installed on x86_64 only.** There is no linux-aarch64 build, so on an arm64 host it is absent by design, not by misconfiguration, and no-egress means it cannot be installed at runtime. Probe (`command -v plink2`), and if it is missing, report the reason and fall back: `bcftools`/cyvcf2 for filtering, allele frequencies and missingness, statsmodels for per-variant association on a cyvcf2-extracted dosage matrix, scikit-learn PCA for population structure. `references/plink2-cli.md` maps each step to its substitute.
- ALWAYS include PCA covariates to adjust for population structure. Omitting this produces inflated results.
- Check genomic inflation factor (lambda_GC); values >1.05 suggest residual confounding.
- Use cyvcf2 for programmatic VCF parsing in Python.

### 6. Variant Annotation

```
VCF with called variants
  → VEP (Ensembl Variant Effect Predictor) — most comprehensive
    → Plugins: CADD, SpliceAI, AlphaMissense, ClinVar, gnomAD
  → SnpEff (faster, less annotation depth)
    → Suitable for quick functional annotation when VEP is unavailable
```

- VEP is preferred for its plugin ecosystem and comprehensive consequence prediction.
- Annotate with gnomAD allele frequencies for rare variant filtering **when they are available**.
- **Some of the resources this section names are in the reference inventory and some are not.** ClinVar (GRCh38, with its tabix index) and GENCODE gene annotation are available as opt-in downloads. Still absent, and too large to stage this way: gnomAD, dbSNP, the HapMap/1000G truth sets recalibration trains on, and any genome FASTA beyond the PGx-scoped GRCh38 bundle. There is no network egress, so VEP/SnpEff caches and plugin data cannot be fetched at runtime either. Resolve what you need by what it is, up front, and expect an opt-in resource may not be staged. If it is absent: say so plainly, deliver the annotation-independent results (call sets, quality metrics, cohort allele frequencies computed from your own AC/AN), and state what must be provisioned. Never invent a resource path, never substitute a different database unannounced, and never quietly drop a filtering step whose reference is missing — an unfiltered call set reported as filtered is the worst outcome here.
- **ClinVar is an assertion database, not a truth table.** Filter on `CLNREVSTAT` before believing `CLNSIG`: a single-submitter claim with no assertion criteria is not equivalent to an expert-panel review, and reporting the two alike overstates confidence. Its contigs are unprefixed (`1`, not `chr1`), the opposite of the staged GENCODE annotation — reconcile naming before joining, or every intersect returns empty without erroring.
- **A 1000 Genomes hit in the inventory is not a filtering resource.** What is staged under that name is a phased haplotype reference panel — a phasing input for haplotype-aware callers, not the truth set variant recalibration trains on. Same cohort, different product, and the one this section needs is the one that is absent. Recalibrating against a phasing panel is not a step that errors; it is a step that produces a meaningless model quietly, so check what an entry is *for* before binding it to a filtering step.

### 7. Variant Filtering

```
WGS cohort (>=30 samples)
  → GATK VQSR (Variant Quality Score Recalibration)
    → Uses known variant sites (HapMap, 1000G, dbSNP) as training data

Small panels / small cohorts
  → Hard filters: QD > 2.0, FS < 60.0, MQ > 40.0, MQRankSum > -12.5, ReadPosRankSum > -8.0
    → Adjust thresholds based on data distribution

Rare variant analysis
  → gnomAD AF < 0.01 (rare), < 0.001 (very rare), absent (novel)
    → Filter by consequence: LoF, missense (CADD > 20), splice region
```

## Anti-Patterns

- **Germline caller on tumor data**: Do NOT use HaplotypeCaller or DeepVariant on tumor samples. They assume diploid germline and miss somatic, subclonal, and aneuploid variants.
- **Ignoring population stratification in GWAS**: Do NOT run association tests without PCA covariates. This is the single most common source of false positives in GWAS.
- **Not filtering by quality/depth**: Do NOT trust raw VCF output without quality filtering. Unfiltered calls contain abundant false positives from mapping artifacts, low coverage, and strand bias.
- **Wrong reference genome build**: Do NOT mix GRCh37/hg19 and GRCh38/hg38 coordinates. Verify the reference build of all input files before analysis. Use liftOver or Picard LiftoverVcf when conversion is necessary.
- **VQSR on small panels**: Do NOT run VQSR on targeted panels or small cohorts (<30 samples). There are insufficient variants for the Gaussian mixture model to train. Use hard filters instead.
- **Ignoring relatedness**: Do NOT assume samples are unrelated in GWAS. Cryptic relatedness inflates test statistics. Run KING and exclude or model related pairs.
- **Raw allele counts as frequencies**: Do NOT report allele counts without normalizing by total alleles. Always compute allele frequency (AF) from AC/AN.

## Output Conventions

- Variant calls: VCF format with proper headers, FILTER field populated.
- Summary tables: CSV with columns `chrom`, `pos`, `ref`, `alt`, `gene`, `consequence`, `gnomAD_AF`, `CADD`, `clinical_significance`.
- GWAS results: CSV with `rsid`, `chrom`, `pos`, `ref`, `alt`, `beta`/`OR`, `se`, `pvalue`, `maf`.
- Figures: Manhattan plot, QQ plot (GWAS), variant allele frequency spectrum, CNV segmentation plots.
- PyRanges for genomic interval operations (overlaps, nearest features, window queries).

## Additional Available Packages

### Python

- **biopython** (`Bio.SeqIO`, `Bio.Seq`): Sequence parsing (FASTA/FASTQ/GenBank), sequence manipulation, restriction analysis.
- **pyfaidx**: Fast random access to FASTA sequences by coordinate. Use for extracting regions around variants.

### R (via rpy2)

- **rtracklayer**: Read/write BED, GFF, BigWig, Wiggle files. Use `import()` / `export()`.
- **Rsamtools**: BAM/FASTA I/O in R. Use `scanBam()`, `BamFile()`, `pileup()`.
- **Biostrings**: Sequence manipulation in R. Use `DNAStringSet()`, `matchPattern()`, `reverseComplement()`.
- **GenomicAlignments**: Work with aligned reads as GRanges. Use `readGAlignments()`.
- **VariantAnnotation**: Read/write/filter VCF in R. Use `readVcf()`, `info()`, `geno()`. Complements cyvcf2 for R-based workflows.

### CLI tools (run as shell commands)

Guaranteed in the sandbox — rely on these freely:

- **samtools**: view, sort, index, flagstat, idxstats, depth, mpileup.
- **bcftools**: view, filter, query, stats, norm, merge, annotate, consensus.
- **tabix**: Index and query tabular genomic data (VCF, BED, GFF).
- **bedtools**: interval arithmetic (intersect, merge, coverage, closest).
- **vcftools**: VCF filtering/statistics (`--min-alleles`, `--maf`, `--max-missing`, `--weir-fst-pop`).

This pack starts from aligned reads or called variants. Alignment, duplicate
marking, primary variant calling and read QC are upstream of it: if you were
handed FASTQ, say so and stop rather than planning a step around a tool you
would have to go looking for.

## References

- `references/pysam-api.md` — BAM/CRAM reading and pileup operations
- `references/cyvcf2-api.md` — Fast VCF parsing in Python
- `references/pyranges-api.md` — Genomic interval arithmetic
- `references/plink2-cli.md` — PLINK2 commands for GWAS QC and association testing
