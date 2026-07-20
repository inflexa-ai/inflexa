---
name: metabolomics
description: Metabolomics and lipidomics analysis — untargeted/targeted workflows, normalization, annotation, and pathway mapping
version: 1.0.0
tags: [metabolomics, lipidomics, untargeted, targeted, xcms, mass-spectrometry]
---

# Metabolomics & Lipidomics Analysis

Comprehensive guidelines for untargeted metabolomics, targeted metabolomics, lipidomics, and metabolic pathway interpretation.

## Method-Selection Decision Tree

### 1. Untargeted Metabolomics

```
Raw mzML files
  → Peak picking: XCMS CentWave in R (matchedFilter for low-res data)
    → RT alignment: XCMS adjustRtime (obiwarp or peakGroups)
      → Feature grouping: XCMS groupChromPeaks (PeakDensity)
        → Gap filling: XCMS fillChromPeaks
          → Feature table (m/z x RT x intensity matrix)
```

- Use pymzml for raw file inspection and chromatogram extraction before peak picking.
- XCMS in R is the standard pipeline. Do NOT use Python-only peak picking unless XCMS is unavailable.
- Export the feature table as AnnData: features (m/z_RT) as `var`, samples as `obs`, intensities as `X`.

### 2. Targeted Metabolomics

```
Vendor output (concentrations or peak areas)
  → Concentration extraction from quantification report
    → Standard curve validation (R^2 >= 0.99 preferred, >= 0.98 acceptable)
      → Flag values below LOD/LOQ
        → Statistical testing (same pipeline as untargeted, starting from clean matrix)
```

- If raw data is provided instead of vendor output, use XCMS with targeted feature extraction (known m/z + RT windows).

### 3. Normalization Selection

| Scenario | Method | Notes |
|---|---|---|
| Default / simple | TIC (total ion current) | Sum-normalize each sample; fast but assumes equal total metabolite load |
| Robust cross-sample | PQN (probabilistic quotient) | Reference-based quotient scaling; robust to outlier features |
| Batched runs with signal drift | LOESS | Fit local regression to QC pool injections; correct drift per feature |
| Internal standards available | IS normalization | Normalize by spiked-in standard intensity; most accurate when available |

- Apply normalization AFTER gap filling but BEFORE log transformation.
- Always log2-transform after normalization for downstream statistics.

### 4. Annotation

```
Feature table with MS2 spectra
  → Spectral matching: matchms against a resolved reference spectral library
    → If no match: SIRIUS (molecular formula prediction)
      → If still ambiguous: MetFrag (in silico fragmentation ranking)
```

- **No spectral library is currently in the reference inventory** (MassBank, HMDB, GNPS, MoNA — none of them), and there is no network egress to fetch one. Resolve a library by what it is before planning annotation. If none is available, report that spectral annotation cannot be run and deliver the feature table with m/z, RT, adduct and isotope annotation, which is complete and useful without compound IDs. Do not invent a library path and do not silently downgrade to formula guesses presented as identifications.
- SIRIUS and MetFrag are separate binaries and are not guaranteed to be staged — probe for them before planning on them. **CSI:FingerID is a network service and always fails here**; SIRIUS can still do offline formula prediction, but structure elucidation via CSI:FingerID is unavailable.
- matchms handles spectral similarity scoring (cosine, modified cosine, entropy).
- Always report annotation confidence levels (MSI levels 1-4).
- Check adduct annotations: [M+H]+, [M+Na]+, [M-H]-, [M+FA-H]- are common.

### 5. Statistical Analysis

```
Normalized, log2-transformed feature matrix
  → PCA: overview, outlier detection, batch effects
    → If classification question: PLS-DA (with permutation testing for validation)
    → If two-group comparison: t-test with BH FDR correction + fold change
    → If multi-group: ANOVA with BH FDR correction + post-hoc Tukey
      → Volcano plot (fold change vs -log10 p-value)
```

- Use limma (R) for robust moderated statistics when sample sizes are small.
- PLS-DA MUST include permutation testing (n >= 1000) to validate model significance.

### 6. Lipidomics Specifics

- Apply lipid class normalization for within-class comparisons (normalize each lipid to its class total).
- Chain length and saturation analysis: group lipids by acyl chain properties, test for shifts.
- Use LIPID MAPS nomenclature (e.g., PC 34:1, not custom abbreviations).
- Lipid ontology enrichment: test for overrepresentation of specific lipid classes/subclasses.

### 7. Pathway Mapping

**Pathway mapping needs metabolite-set reference data that is not provisioned here.** KEGG compound mapping, SMPDB/KEGG-module metabolite sets, and KEGG pathway-map rendering all resolve over the network, which is blocked — and no metabolite-set collection is in the reference inventory (the catalogued pathway sets are gene-based: Reactome, WikiPathways, MSigDB hallmark). Check what is available before planning this step; if nothing is, report it and stop at the annotated, statistically-tested feature table rather than inventing a mapping.

- KEGG metabolic pathways: map annotated metabolites to KEGG compound IDs, run enrichment — only if a KEGG compound mapping is available locally.
- MetaboAnalyst-style enrichment: hypergeometric test on metabolite sets (SMPDB, KEGG modules), given a resolved metabolite-set file.
- For integrated views, overlay metabolomics onto KEGG pathway maps with fold-change coloring. The KEGG map-rendering API is a network call and fails here; plot your own summary instead.

## Anti-Patterns

- **WRONG normalization for drift**: Do NOT use TIC or PQN to correct instrument signal drift across a batch. Use LOESS on QC pool injections for drift correction.
- **Ignoring adduct/isotope patterns**: Do NOT treat every feature as independent. Deisotope and deadduct before counting "significant features." Failing to do this inflates hit counts.
- **Not checking peak quality**: Do NOT blindly trust the feature table. Inspect chromatographic peak shapes for top hits — poor peak shapes indicate noise or misintegration.
- **Gene-centric tools on metabolites**: Do NOT apply GSEA, DESeq2, or other gene-centric statistical frameworks to metabolite data. Metabolite IDs are not gene IDs, and the distributional assumptions differ.
- **Skipping blank subtraction**: Do NOT skip blank/solvent control filtering. Features present in blanks at >30% of sample intensity are likely contaminants.
- **PLS-DA without validation**: Do NOT report PLS-DA results without permutation testing. PLS-DA will always find separation, even on random data.
- **Mixing positive and negative mode**: Do NOT combine features from positive and negative ionization modes without proper deduplication and annotation reconciliation.

## Output Conventions

- Feature tables: AnnData (.h5ad) with m/z, RT, and annotation metadata in `var`.
- Statistical results: CSV with columns `feature_id`, `log2FC`, `pvalue`, `padj`, `annotation`.
- Figures: volcano plots, PCA score plots, heatmaps of top features, pathway enrichment bar plots.
- All intensity values reported as log2-transformed unless stated otherwise.
- Annotation tables: include MSI confidence level, adduct, m/z error (ppm), spectral score.

## Additional Available Packages

- **CAMERA** (R): Adduct and isotope annotation after XCMS peak detection. `xsAnnotate()`, `findIsotopes()`, `findAdducts()`. Run after xcms feature detection.
- **MSnbase** (R): MS data classes — `readMSData()` for reading mzML. Foundation package that xcms depends on.
- **Spectra** (R Bioconductor): Modern replacement for MSnbase data backends. Use `Spectra()` constructor, `filterMsLevel()`, `peaksData()`.
- **spectrum-utils** (Python): MS spectrum visualization — mirror plots, annotated spectra. Use for quality inspection of spectral matches.
- **ms-deisotope** (Python): Deisotoping and charge state deconvolution for high-resolution MS data.
- **openms** (system CLI): OpenMS suite — `FeatureFinderMetabo`, `MapAlignerPoseClustering`. Alternative to XCMS for feature detection.

## References

- `references/xcms-api.md` — XCMS peak picking, alignment, and grouping
- `references/matchms-api.md` — Spectral matching and similarity scoring
- `references/pymzml-api.md` — Raw mzML file parsing and chromatogram extraction
