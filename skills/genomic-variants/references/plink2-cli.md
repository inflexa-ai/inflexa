# PLINK2 CLI Reference

Command-line toolset for whole-genome association analysis. PLINK2 is the successor to PLINK 1.9 with better performance and additional features. Commands are executed via `execute_command`.

## File Formats

```
# PLINK 1 binary fileset (.bed/.bim/.fam)
--bfile prefix          # reads prefix.bed, prefix.bim, prefix.fam

# PLINK 2 fileset (.pgen/.pvar/.psam)
--pfile prefix          # reads prefix.pgen, prefix.pvar, prefix.psam

# VCF input
--vcf file.vcf.gz

# Plain text
--file prefix           # reads prefix.ped, prefix.map
```

## Format Conversion

```bash
# VCF to PLINK 1 binary
plink2 --vcf input.vcf.gz --make-bed --out output_prefix

# VCF to PLINK 2 format
plink2 --vcf input.vcf.gz --make-pgen --out output_prefix

# PLINK 1 to PLINK 2
plink2 --bfile input_prefix --make-pgen --out output_prefix

# PLINK 2 to PLINK 1
plink2 --pfile input_prefix --make-bed --out output_prefix

# Apply MAF filter during conversion
plink2 --bfile input --maf 0.01 --make-bed --out filtered

# Apply missingness filter
plink2 --bfile input --geno 0.05 --mind 0.1 --make-bed --out qc_passed
# --geno 0.05: exclude variants missing in >5% of samples
# --mind 0.1: exclude samples missing >10% of variants
```

## Allele Frequencies

```bash
# Basic allele frequency report
plink2 --bfile data --freq --out freq_report
# Output: freq_report.afreq (columns: CHROM, ID, REF, ALT, ALT_FREQS, OBS_CT)

# With allele counts
plink2 --bfile data --freq counts --out freq_counts
# Output: freq_counts.acount

# Case/control stratified frequencies
plink2 --bfile data --freq --loop-cats pheno_col --out stratified
```

## Hardy-Weinberg Equilibrium

```bash
# HWE exact test for all variants
plink2 --bfile data --hardy --out hwe_report
# Output: hwe_report.hardy (columns include P value for HWE test)

# Filter variants failing HWE (p < 1e-6)
plink2 --bfile data --hwe 1e-6 --make-bed --out hwe_filtered

# Midp adjustment (less conservative)
plink2 --bfile data --hwe 1e-6 midp --make-bed --out hwe_filtered
```

## PCA (Population Structure)

```bash
# Compute top 10 principal components (default)
plink2 --bfile data --pca 10 --out pca_result
# Output: pca_result.eigenvec (sample PCs) and pca_result.eigenval (eigenvalues)

# With header line and tab-delimited
plink2 --bfile data --pca 20 header tabs --out pca_result

# Variant weights (loadings)
plink2 --bfile data --pca 10 var-wts --out pca_result
# Output: pca_result.eigenvec.var (per-variant PC loadings)

# Approximate PCA for large datasets (faster)
plink2 --bfile data --pca 10 approx --out pca_result

# LD-pruned PCA (recommended workflow)
# Step 1: LD pruning
plink2 --bfile data --indep-pairwise 50 5 0.2 --out pruned
# Output: pruned.prune.in (kept variants), pruned.prune.out (removed)
# Step 2: PCA on pruned variants
plink2 --bfile data --extract pruned.prune.in --pca 20 --out pca_pruned
```

## Relatedness (KING)

```bash
# KING-robust kinship estimator
plink2 --bfile data --make-king-table --out kinship
# Output: kinship.kin0 (pairwise kinship coefficients)

# Remove related individuals (kinship > 0.0884 ~ 2nd degree)
plink2 --bfile data --king-cutoff 0.0884 --out unrelated
# Output: unrelated.king.cutoff.in.id (retained samples)
#         unrelated.king.cutoff.out.id (removed samples)

# Use the unrelated set for downstream analysis
plink2 --bfile data --keep unrelated.king.cutoff.in.id --make-bed --out unrelated_data
```

## Association Testing (--glm)

```bash
# Logistic regression for case/control (binary phenotype)
plink2 --bfile data --pheno pheno.txt --glm --out assoc
# Output: assoc.PHENO1.glm.logistic.hybrid

# Linear regression for quantitative trait
plink2 --bfile data --pheno pheno.txt --glm --out assoc
# Output: assoc.PHENO1.glm.linear

# With covariates (e.g., PCA components, age, sex)
plink2 --bfile data \
    --pheno pheno.txt \
    --covar covariates.txt \
    --glm hide-covar \
    --out assoc
# hide-covar: only report the SNP association line, not covariate lines

# Specific model types
plink2 --bfile data --pheno pheno.txt --glm dominant --out assoc_dom
plink2 --bfile data --pheno pheno.txt --glm recessive --out assoc_rec

# Firth regression (for rare variants / unbalanced case-control)
plink2 --bfile data --pheno pheno.txt --glm firth --out assoc_firth

# Multiple phenotypes
plink2 --bfile data --pheno pheno.txt --pheno-name BMI,HEIGHT --glm --out multi
```

## Common QC Pipeline

```bash
# Step 1: Basic QC filters
plink2 --vcf raw.vcf.gz \
    --maf 0.01 \
    --geno 0.05 \
    --mind 0.1 \
    --hwe 1e-6 \
    --make-bed --out qc_step1

# Step 2: LD pruning for PCA
plink2 --bfile qc_step1 --indep-pairwise 50 5 0.2 --out ld_pruned

# Step 3: PCA on pruned data
plink2 --bfile qc_step1 --extract ld_pruned.prune.in --pca 20 --out pca

# Step 4: Relatedness check
plink2 --bfile qc_step1 --extract ld_pruned.prune.in \
    --make-king-table --out kinship
plink2 --bfile qc_step1 --king-cutoff 0.0884 --out unrelated

# Step 5: Association testing with PCA covariates
plink2 --bfile qc_step1 \
    --keep unrelated.king.cutoff.in.id \
    --pheno pheno.txt \
    --covar pca.eigenvec \
    --covar-col-nums 3-12 \
    --glm hide-covar \
    --out gwas
```

## Parsing Output in Python

```python
import pandas as pd

# Read association results
assoc = pd.read_csv("gwas.PHENO1.glm.logistic.hybrid", sep="\t")
# Columns: CHROM, POS, ID, REF, ALT, A1, FIRTH?, TEST, OBS_CT, OR, LOG_OR_SE, Z_STAT, P
sig = assoc[assoc["P"] < 5e-8]

# Read PCA results
pca = pd.read_csv("pca.eigenvec", sep="\t")
# Columns: #FID, IID, PC1, PC2, ..., PC20 (when header modifier used)

# Read frequency results
freq = pd.read_csv("freq_report.afreq", sep="\t")
# Columns: CHROM, ID, REF, ALT, ALT_FREQS, OBS_CT

# Read kinship results
kin = pd.read_csv("kinship.kin0", sep="\t")
# Columns: #FID1, ID1, FID2, ID2, NSNP, HETHET, IBS0, KINSHIP
```

## Gotchas

- **PLINK2 vs PLINK 1.9 flag names**: PLINK2 uses `--glm` instead of `--logistic`/`--linear`. `--freq` output format differs (`.afreq` vs `.frq`). `--make-king-table` replaces `--genome`.
- **Phenotype encoding**: Binary phenotypes must be 1=control, 2=case (PLINK convention). Use `--1` flag if phenotype uses 0=control, 1=case.
- **Covariate file format**: Tab or space-delimited. First two columns must be FID and IID. Use `--covar-col-nums` to select specific columns.
- **Chromosome naming**: PLINK uses numeric chromosome codes by default. Use `--chr-set` or `--allow-extra-chr` for non-standard names. Use `--output-chr chrM` for `chrN` prefix format.
- **Memory**: For large datasets, use `--memory` to set max RAM in MB. PLINK2 is more memory-efficient than 1.9 but large GWAS still need planning.
- **Multiallelic variants**: PLINK2 handles multiallelic sites better than PLINK 1.9 but `--glm` still tests each ALT allele separately.
- **Output column separators**: Use `--output-chr`, `--output-missing-phenotype`, and related flags to control output formatting for downstream parsing.
