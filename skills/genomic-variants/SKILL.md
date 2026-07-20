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

- PLINK2 is the default tool for GWAS QC and association. Use the `--glm` command. **Verify `plink2` is on PATH before building a pipeline around it** — it is not guaranteed to be staged, and with no egress it cannot be installed at runtime. If it is absent, report that and fall back to cyvcf2/`bcftools` for VCF-level QC and statsmodels for association on an extracted genotype matrix.
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
- **The annotation and training resources this section names are not in the reference inventory** — no ClinVar, no gnomAD, no dbSNP, no HapMap/1000G training sets, no genome FASTA beyond a PGx-scoped GRCh38 bundle. There is no network egress, so VEP/SnpEff caches and plugin data cannot be fetched at runtime either. Resolve what you need by what it is, up front. If it is absent: say so plainly, deliver the annotation-independent results (call sets, quality metrics, cohort allele frequencies computed from your own AC/AN), and state what must be provisioned. Never invent a resource path, never substitute a different database unannounced, and never quietly drop a filtering step whose reference is missing — an unfiltered call set reported as filtered is the worst outcome here.

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

- **samtools**: view, sort, index, flagstat, idxstats, depth, mpileup.
- **bcftools**: view, filter, query, stats, norm, merge, annotate, consensus.
- **tabix**: Index and query tabular genomic data (VCF, BED, GFF).
- **vcftools**: VCF filtering/statistics (`--min-alleles`, `--maf`, `--max-missing`, `--weir-fst-pop`).
- **mosdepth**: Fast BAM/CRAM depth calculation (per-base, per-window, per-region).
- **bwa / minimap2**: Read alignment (`bwa mem` for short reads, `minimap2` for long reads).
- **picard**: MarkDuplicates, CollectInsertSizeMetrics, ValidateSamFile.
- **freebayes**: Bayesian variant calling.
- **seqtk / seqkit**: Sequence file manipulation (subsample, stats, convert).
- **fastqc / multiqc**: Read quality assessment and report aggregation.
- **fastp**: All-in-one FASTQ preprocessing (trimming, quality filtering, adapter removal).

## References

- `references/pysam-api.md` — BAM/CRAM reading and pileup operations
- `references/cyvcf2-api.md` — Fast VCF parsing in Python
- `references/pyranges-api.md` — Genomic interval arithmetic
- `references/plink2-cli.md` — PLINK2 commands for GWAS QC and association testing
