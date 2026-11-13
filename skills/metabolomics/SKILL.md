---
name: metabolomics
description: Read before you analyze untargeted or targeted metabolomics or lipidomics data. It gives the normalization for each case (drift, internal standards), the limits of spectral annotation and identification levels, the absent pathway data, and the traps of adducts, blanks, and PLS-DA.
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
    → If no match: SIRIUS (molecular formula prediction)         [NOT INSTALLED]
      → If still ambiguous: MetFrag (in silico fragmentation)    [NOT INSTALLED]
```

Only the first step of this tree is runnable here, and only if a library is provided. The two fallback tiers are absent binaries — see the notes below before planning on either.

- **An experimental MS/MS spectral library is in the reference inventory, as an opt-in download rather than part of a default install** — so it is resolvable, and may or may not actually be staged. Resolve it by what it is before planning annotation. Two things decide whether the match is meaningful, and the entry states both: the library mixes precursor-only records in with true fragmentation spectra, so restrict to fragmentation spectra first or you will "match" on mass alone; and it covers both ionisation modes, so restrict to the mode your data was acquired in. If nothing resolves, report that spectral annotation cannot be run and deliver the feature table with m/z, RT, adduct and isotope annotation, which is complete and useful without compound IDs. Do not invent a library path and do not silently downgrade to formula guesses presented as identifications.
- **A spectral match is a level-2 identification, not a compound ID.** Report it as "matches the reference spectrum for X" with the similarity score and the number of matched fragments, and say what was not confirmed — without an authentic standard run on the same instrument, retention time and absolute confirmation are missing. Never promote a library hit to an unqualified identification.
- **Annotation stops at spectral matching.** De novo formula prediction and structure elucidation — SIRIUS, MetFrag, CSI:FingerID — are not available, so a feature with no library match stays unidentified. Report it that way rather than inferring a formula.
- matchms handles spectral similarity scoring (cosine, modified cosine, entropy).
- Always report annotation confidence levels (MSI levels 1-4).

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

- If a KEGG compound mapping or a metabolite-set file resolves locally, map the annotated metabolites and run a hypergeometric test on the metabolite sets.
- The KEGG map-rendering API is a network call and fails here. Plot your own summary of the pathway.

## Anti-Patterns

- **Library matches on precursor mass alone**: The spectral library of the reference inventory mixes precursor-only records with fragmentation spectra, and it covers both ionization modes. Keep only the fragmentation spectra of the mode of your data before you match.
- **A formula or a structure for a feature with no library match**: SIRIUS, MetFrag, and CSI:FingerID are not installed. Report the feature as unidentified.
- **A metabolite pathway enrichment from a network resource**: KEGG and SMPDB use the network, and the reference inventory has no metabolite-set collection. Stop at the annotated and tested feature table, and say why.
- **An OpenMS pipeline**: OpenMS is not installed and cannot be. Use XCMS.
- **WRONG normalization for drift**: Do NOT use TIC or PQN to correct instrument signal drift across a batch. Use LOESS on QC pool injections for drift correction.
- **Skipping blank subtraction**: Remove the features that are present in the blanks at more than 30% of the sample intensity.
- **Each feature as an independent compound**: Deisotope and deadduct (CAMERA) before you count significant features. Common adducts are [M+H]+, [M+Na]+, [M-H]-, and [M+FA-H]-.
- **No peak quality check**: Inspect the chromatographic peak shapes of the top hits. A poor shape shows noise or a bad integration.
- **Gene-centric tools on metabolites**: Do not use GSEA, DESeq2, or other gene-centric frameworks on metabolite data.
- **PLS-DA without validation**: PLS-DA finds a separation even in random data. Report it only with a permutation test (n >= 1000).
- **Mixing positive and negative mode**: Do not combine the features of the two ionization modes without deduplication and reconciliation of the annotations.

## Output Conventions

- Feature tables: AnnData (.h5ad) with m/z, RT, and annotation metadata in `var`.
- Statistical results: CSV with columns `feature_id`, `log2FC`, `pvalue`, `padj`, `annotation`.
- All intensity values reported as log2-transformed unless stated otherwise.
- Annotation tables: include MSI confidence level, adduct, m/z error (ppm), spectral score.

## Additional Available Packages

- **CAMERA** (R): Adduct and isotope annotation. Runs *after* xcms feature detection — grouping features into adducts and isotopologues is what turns a feature list into candidate compounds.
- **OpenMS** is not installed and cannot be. XCMS is the feature-detection pipeline here.

## References

- `references/xcms-api.md` — XCMS peak picking, alignment, and grouping
- `references/matchms-api.md` — Spectral matching and similarity scoring
- `references/pymzml-api.md` — Raw mzML file parsing and chromatogram extraction
