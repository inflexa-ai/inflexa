---
name: cheminformatics
description: Read before you analyze compound structures (SAR, library profiles, QSAR, ADMET, chemical space, target occupancy, connectivity to drug perturbation signatures, selectivity panels). It gives the method for each goal, structure standardization, split and fingerprint rules, and absent data.
metadata:
  version: 1.1.0
  tags: [cheminformatics, rdkit, datamol, mordred, deepchem, sar, qsar, drug-discovery, molecular-properties, scaffold, pains, target-engagement, cmap, selectivity, kinase-selectivity]
---

# Cheminformatics

This skill guides method selection and execution for molecular structure analysis, structure-activity relationship (SAR) triage, compound library profiling, QSAR modeling, ADMET prediction, and chemical space visualization. All workflows assume Python with RDKit as the core cheminformatics toolkit, supplemented by datamol, mordred, and DeepChem for specialized tasks.

## Method Selection Decision Tree

Choose the method based on your input data and analytical goal:

1. **SAR Triage** (has structures + activity data)
   - Murcko scaffold decomposition via `rdkit.Chem.Scaffolds.MurckoScaffold` -- group compounds by core ring system.
   - Property profiling via `rdkit.Chem.Descriptors` + `datamol` -- MW, logP, TPSA, HBD, HBA, RotBonds for each compound.
   - Druglikeness assessment: Lipinski Ro5 (MW<=500, logP<=5, HBD<=5, HBA<=10), Veber (TPSA<=140, RotBonds<=10), Ghose rules.
   - Structural alert screening via `rdkit.Chem.FilterCatalog` -- PAINS, Brenk, NIH catalogs.
   - Activity distribution analysis: `pandas` + `scipy.stats` for distribution statistics, outlier detection, and potency binning.
   - Scaffold-activity cross-tab: scaffold x potency matrix to identify chemotypes with best activity profiles.

2. **Library Profiling** (structures only, no activity data)
   - Property distributions: MW, logP, TPSA, HBD, HBA, RotBonds -- histogram/violin for each, Ro5 reference lines overlaid.
   - Chemical diversity: Tanimoto similarity on Morgan fingerprints (radius=2, 2048 bits) + Butina clustering (cutoff=0.4).
   - Chemical space map: UMAP or t-SNE on Morgan fingerprints, colored by cluster assignment.
   - Structural alert sweep: PAINS, Brenk, NIH catalogs -- report clean percentage and most common alert types.

3. **Compound Comparison** (two or more compound sets)
   - Property comparison: violin/box plots per set for MW, logP, TPSA, HBD, HBA, RotBonds -- Mann-Whitney U or KS test for statistical comparison.
   - Scaffold overlap: Venn diagram on Murcko scaffolds (generic framework) to show shared vs unique chemotypes.
   - Chemical space overlap: UMAP on combined fingerprint matrix, colored by set membership, with convex hulls or density contours.

4. **QSAR Modeling** (predictive modeling)
   - Small data (<1K compounds): Morgan fingerprints (radius=2, 2048 bits) + sklearn RandomForest or GradientBoosting. 5-fold cross-validation. Report R2 and RMSE.
   - Medium data (1K-100K): DeepChem `CircularFingerprint` + `MultitaskClassifier` or `MultitaskRegressor` (dense MLP). Scaffold split for evaluation.
   - Large data (>100K): DeepChem `MolGraphConvFeaturizer` + `GraphConvModel` or `AttentiveFPModel` (GPU recommended). Scaffold split mandatory.

5. **ADMET Prediction**
   - Computed descriptors: rdkit (basic) + mordred (1800+ 2D/3D descriptors) for comprehensive molecular characterization.
   - Rule-based assessment: Lipinski Ro5, Veber rules, PAINS alerts -- fast, interpretable, no training data needed.
   - Learned models: train on labelled data already in the workspace. DeepChem's pretrained weights and its MoleculeNet benchmark loaders (Tox21, BBBP, ClinTox, SIDER) both fetch over the network and are unavailable in the sandbox — see `references/deepchem-api.md`.

6. **Structure Processing**
   - Format conversion: `dm.from_sdf()` / `dm.to_sdf()` for SDF, `Chem.MolFromSmiles()` / `Chem.MolToSmiles()` for SMILES.
   - Standardization: `datamol.standardize_mol()` -- salt stripping, neutralization, tautomer canonicalization in one call.
   - Salt stripping / neutralization: `datamol` handles common salt forms and charge states automatically.
   - 3D conformer generation: `rdkit.AllChem.EmbedMolecule` with ETKDGv3, followed by MMFF optimization.

## Compound Acquisition

When compound data is not already in the workspace, acquire it through the
compound-database lookup capabilities available to the agent. Nothing in the
sandbox can reach these databases directly — egress is blocked — so acquisition
happens through the conversation layer's lookup tools, and the retrieved data is
written into the workspace before any sandbox analysis reads it.

**ChEMBL** (curated drug-like bioactives) — ask for:
- resolution of gene symbols to ChEMBL target identifiers
- compounds by target, name, or SMILES
- bioactivity measurements (IC50/EC50/Ki) for compound-target pairs
- mechanism of action for a drug
- approved drugs by indication

**PubChem** (broad coverage, far larger and far less curated) — ask for:
- compound identity and computed properties by name, SMILES, InChI, InChIKey, or CID
- cross-references bridging a PubChem CID to ChEMBL, DrugBank, KEGG, and PDB identifiers
- HTS assay screening results (active/inactive/inconclusive)

For an unknown compound, try ChEMBL first. Use PubChem for a compound that ChEMBL does not have, and bridge its CID to a ChEMBL ID through the cross-references to get curated activity data.

If a lookup returns nothing, report the gap — never fabricate structures,
identifiers, or activity values to fill it.

## Druglikeness Rules Reference

| Rule Set | Criteria | Interpretation |
|----------|----------|----------------|
| Lipinski Ro5 | MW <= 500, logP <= 5, HBD <= 5, HBA <= 10 | Oral bioavailability likelihood |
| Veber | TPSA <= 140, RotBonds <= 10 | Oral bioavailability (complementary to Ro5) |
| Ghose | 160 <= MW <= 480, -0.4 <= logP <= 5.6, 40 <= MR <= 130, 20 <= atoms <= 70 | Drug-like chemical space |
| REOS | MW 200-500, logP -5 to 5, HBD 0-5, HBA 0-10, formal charge -2 to 2, RotBonds 0-8, heavy atoms 15-50 | Rapid elimination of swill |

## Structure and Fingerprint Constraints

- Standardize each structure with `datamol.standardize_mol()` before any analysis. Parse each SMILES with `Chem.MolFromSmiles()`, and flag or remove each `None`.
- The default fingerprint is Morgan radius 2 (ECFP4), 2048 bits, as a bit vector for Tanimoto.
- Report the fingerprint type, the radius, the bit length, the clustering cutoff, and the dimensionality reduction parameters with each result.
- For activity cliffs, plot the pairwise delta-activity against the Tanimoto similarity. A pair with high similarity and a large activity difference is the most informative pair for SAR.

## Output Conventions

- Tractability JSON per target (when evaluating tractability): `{ target, chembl_id, compound_count, series_count, best_potency_nM, pains_clean_pct, drug_like_pct, tractability_verdict, top_scaffolds }`
- Property tables as CSV with columns: SMILES, name, MW, logP, TPSA, HBD, HBA, RotBonds, scaffold, alerts
- QSAR model reports: algorithm, fingerprint type/radius/bits, train/test split method, CV folds, R2, RMSE (regression) or ROC-AUC, accuracy (classification)
- Structural alert reports: per-compound alert status, alert description, clean/flagged counts, most common alert classes

## Target Engagement Assessment

**Reference**: `references/target-engagement.md` — occupancy model with
free drug hypothesis, residence time pharmacology, functional readout
selection guide, and integrated assessment framework. Read it before
writing occupancy or engagement analysis code.

Use free (unbound) concentration, not total plasma. Pair each occupancy estimate with at least one functional readout. Report the predicted occupancy at Cmax, Ctrough, and steady-state Cavg. A common benchmark for continuous target suppression is >= 90% occupancy at Ctrough.

## Drug Perturbation Signature Matching (CMap-Style)

**Reference**: `references/gseapy-connectivity.md` — gseapy.prerank API
for connectivity scoring, NES interpretation, multi-drug panel scoring,
query signature best practices, and sandbox constraints (custom dicts
work offline; Enrichr library names do NOT). Read it before writing
CMap-style analysis code.

### Goal and Constraints

The goal is a connectivity score for each drug against a query signature of the top up and the top down genes (gene symbols, typically N = 100-500 each).

- A drug-perturbation signature collection is in the reference inventory as an opt-in download. Resolve it by what it is, and expect that it can be absent. ChEMBL is not a substitute, because it holds bioactivity, not transcriptomic perturbation profiles.
- The collection arrives as directional gene sets, one up and one down set per experiment. **Score the up and down halves of a pair separately and subtract**, because connectivity is that difference. Pair them by their shared term prefix rather than by position.
- If nothing resolves, use perturbation experiments already staged in the workspace. If there are none, report that CMap-style scoring cannot be run, and say what would be needed. Never invent a reference path.
- Never substitute drug-target gene lists for perturbation signatures. Scoring target sets against a disease ranking is target enrichment, not connectivity, and must not be reported as a connectivity score.
- Signatures are cell-line responses. Report the cell line with the score, because a reversal in one line is a hypothesis about that context only.
- Score with `gseapy.prerank` and its permutation FDR.
- Interpret: score < -0.5 with p < 0.05 is a strong reversal candidate, score > 0.5 with p < 0.05 is strong mimicry, and |score| < 0.3 is no meaningful connectivity.

## Selectivity Profiling

**Reference**: `references/selectivity-scoring.md` — metric formulas
with edge cases, input preparation (why raw IC50 breaks Gini), S-score
interpretation table (Karaman et al. 2008), entropy thresholds
(Uitdehaag & Zaman 2011), and a complete reporting template. Read it
before computing selectivity metrics.

### Selectivity Metrics

When profiling a compound against a panel of targets (kinase panel, GPCR panel, safety panel), quantify selectivity with these metrics. See the reference for implementations, edge cases, and input preparation.

| Metric | Selective When | Panel Type |
|--------|---------------|------------|
| Gini coefficient | > 0.8 | Any (uses %inhibition or pIC50, NOT raw IC50) |
| S-score | S(3μM) < 0.05 | Kinase panels (uses Kd values) |
| Selectivity entropy | < 2 | Kinase/GPCR (uses pIC50 values) |
| Selectivity window | > 100-fold | Any (primary vs closest off-target IC50 ratio) |

### Panel Types and Reporting

**Kinase selectivity panel** (e.g., DiscoverX scanMAX, Eurofins):
- Report: S(1μM), S(3μM), Gini coefficient, selectivity entropy
- Highlight: top 5 off-target kinases by Kd
- Visualize: selectivity heatmap (compound x kinase), sorted by Kd

**GPCR/ion channel safety panel** (e.g., Eurofins SafetyScreen44):
- Report: %inhibition at 10μM for each target
- Flag: any target with >50% inhibition at 10μM
- Highlight: hERG (>50% at 10μM is a red flag), muscarinic, adrenergic

**Selectivity window**: Report the ratio between primary target potency and the most potent off-target. >100-fold is excellent; <10-fold means off-target effects are expected at therapeutic doses.

## Anti-Patterns

- **DeepChem pretrained weights or MoleculeNet loaders**: Both fetch over the network, and the sandbox has none. Train on labelled data in the workspace.
- **An Enrichr library name in `gseapy.prerank`**: The name makes an HTTP request and fails. Pass a gene set dictionary that you built from a resolved file.
- **A compound lookup from a sandbox script**: Egress is blocked. Get the ChEMBL and PubChem data through the lookup capabilities of the conversation, and write it into the workspace.
- **DeepChem GNN on CPU with >10K compounds**: Will be extremely slow. Use fingerprint-based sklearn models instead.
- **Running QSAR without scaffold split**: Random train/test splits allow similar scaffolds in both sets, inflating apparent performance. Use scaffold split for realistic evaluation.
- **Tanimoto on count fingerprints**: Use bit vectors (`GetMorganFingerprintAsBitVect`).
- **PAINS as a definitive rejection**: A PAINS flag shows possible assay interference. Report and flag the compound. Do not remove it silently.
- **"Fails Ro5" without the rule**: Report which rules the compound violates.
- **Mordred on unstandardized molecules**: Descriptor values change with salt forms and charge states.
- **NaN in the feature matrix**: Mordred and RDKit descriptors fail on some molecules. Clean the matrix before the model fit.

## QSAR Model Selection

| Data Size | Featurization | Model | Notes |
|-----------|--------------|-------|-------|
| <1K | Morgan FP (2048) | sklearn RandomForest/GBM | 5-fold CV, fast, interpretable |
| 1K-10K | Morgan FP (2048) or mordred descriptors | sklearn GBM or DeepChem MultitaskRegressor | Scaffold split for evaluation |
| 10K-100K | DeepChem CircularFingerprint | DeepChem MultitaskClassifier/Regressor | Dense MLP, moderate GPU benefit |
| >100K | DeepChem MolGraphConvFeaturizer | AttentiveFPModel or GraphConvModel | GPU required, scaffold split mandatory |

For regression tasks, report R2 and RMSE on the test set. For classification, report ROC-AUC and optionally PR-AUC (especially for imbalanced datasets). Always use scaffold split for final evaluation -- random splits overestimate performance on molecular data.

## References

| File | Purpose |
|------|---------|
| `references/rdkit-core.md` | RDKit core API: Chem, Descriptors, Scaffolds, FilterCatalog, Draw, AllChem |
| `references/datamol-api.md` | datamol: standardization, fingerprints, clustering, scaffolds |
| `references/mordred-api.md` | Mordred: molecular descriptor calculation |
| `references/deepchem-api.md` | DeepChem: featurizers, models, MoleculeNet |
| `references/structural-alerts.md` | Structural alerts: PAINS, Brenk, NIH via FilterCatalog |
| `references/target-engagement.md` | Target engagement: occupancy model, residence time, functional readouts |
| `references/gseapy-connectivity.md` | GSEApy prerank for CMap-style drug perturbation connectivity scoring |
| `references/selectivity-scoring.md` | Selectivity metrics: Gini, S-score, entropy, selectivity window |
