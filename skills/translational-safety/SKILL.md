---
name: translational-safety
description: Safety pharmacology assessment, CTCAE grading, organ-specific toxicity biomarkers, CYP liability analysis, structural alerts, and drug-drug interaction evaluation
version: 1.0.0
tags: [safety, toxicology, CTCAE, hERG, hepatotoxicity, CYP, DDI, adverse-events, biomarkers]
---

# Translational Safety

This skill guides safety assessment for translational medicine,
covering computational toxicology, safety biomarker interpretation,
and adverse event classification.

## CTCAE v5 Grading (Common Terminology Criteria for Adverse Events)

When clinical or laboratory safety data includes adverse event severity,
use CTCAE v5 grading:

| Grade | Description | Clinical Action |
|-------|-------------|-----------------|
| 1 | Mild; asymptomatic or mild symptoms | Observation only |
| 2 | Moderate; minimal intervention indicated | Outpatient management |
| 3 | Severe; hospitalization indicated | Dose modification/interruption |
| 4 | Life-threatening | Urgent intervention |
| 5 | Death related to AE | — |

When grading lab values:

### Hepatotoxicity (Drug-Induced Liver Injury)
- **ALT/AST**: Grade 1: >ULN–3x ULN, Grade 2: 3–5x ULN, Grade 3: 5–20x ULN, Grade 4: >20x ULN
- **Total bilirubin**: Grade 1: >ULN–1.5x ULN, Grade 2: 1.5–3x ULN, Grade 3: 3–10x ULN, Grade 4: >10x ULN
- **Hy's Law**: ALT >3x ULN AND bilirubin >2x ULN (without ALP >2x ULN) — high risk of fatal DILI
- **RUCAM score**: Use to assess causality (drug vs other cause)

### Nephrotoxicity
- **Creatinine**: Grade 1: >ULN–1.5x baseline, Grade 2: 1.5–3x baseline, Grade 3: 3–6x baseline, Grade 4: >6x baseline
- **eGFR**: Monitor trend; acute decline >25% is concerning
- **Proteinuria**: Grade 1: +1, Grade 2: +2–3, Grade 3: nephrotic range

### Cardiotoxicity
- **Troponin**: Any elevation above ULN warrants investigation
- **LVEF**: Grade 1: asymptomatic decline, Grade 2: <50% or decline >10%, Grade 3: symptomatic CHF
- **QTc prolongation**: Grade 1: 450–480ms, Grade 2: 481–500ms, Grade 3: >500ms or >60ms increase

### Hematological Toxicity
- **Neutrophils**: Grade 1: <LLN–1500, Grade 2: 1000–1500, Grade 3: 500–1000, Grade 4: <500
- **Platelets**: Grade 1: <LLN–75000, Grade 2: 50000–75000, Grade 3: 25000–50000, Grade 4: <25000

## Safety Target Panel Quick Lookup

Cortex ships a curated secondary-pharmacology off-target safety panel
(~30 well-established liability targets, organ-tagged). Use this as a
fast first-pass screen before reaching for live tools.

**From the agent:**

Screen identifiers — ChEMBL IDs, gene symbols, or UniProt accessions —
against the panel with the safety-panel lookup available to you. It
returns matched entries plus a summary by severity and organ. An
unmatched identifier is not a panel hit, which is not the same as being
safe: it may still carry Open Targets signals.

Each matched entry carries:

| Field | Contents |
|-|-|
| `chembl_id` | ChEMBL target identifier — the join key against candidate targets |
| `gene_symbol` | HGNC gene symbol |
| `uniprot` | UniProt accession |
| `organ_system` | Organ system the liability presents in (cardiovascular, hepatic, …) |
| `severity` | Severity tier for the liability |
| `clinical_consequence` | The observed clinical effect |

**From a sandbox script (Python/R):**

**The panel is a lookup, not a file.** It ships inside the agent runtime and is
never staged onto disk, so there is no path to resolve and nothing to read — a
script that goes looking for a safety-panel CSV is hunting for a file that does
not exist in any environment.

To use the panel in a script, look the identifiers up first, then persist the
result into your working directory and read it back:

```python
import pandas as pd

# Written from the panel lookup you ran before invoking the script.
panel = pd.read_csv("output/safety_panel_hits.csv")
hits = candidates.merge(panel, left_on="target_chembl_id", right_on="chembl_id")
```

Screen the whole candidate list in one lookup rather than one call per target,
and write the result once — the panel is small and fully in memory, so batching
costs nothing and keeps the script's input a single reviewable file.

**This panel is NOT exhaustive.** It is the well-cited tier-1 set, so a
clean screen against it is weak evidence of safety and must never be
reported as a clear result. For comprehensive liability assessment also
pull Open Targets organ-specific safety signals and in-vitro
high-throughput screening data (EPA CompTox / ToxCast) using the
target- and chemical-lookup tools available to you. The panel
short-circuits the easy cases; the live sources cover the long tail.

## CYP Metabolism Liability Assessment

When evaluating drug metabolism risk from omics data:

### Key CYP Enzymes
| CYP | % Drug Metabolism | Key Substrates | Key Inhibitors |
|-----|-------------------|----------------|----------------|
| CYP3A4 | ~50% | midazolam, cyclosporine, statins | ketoconazole, ritonavir, grapefruit |
| CYP2D6 | ~25% | tamoxifen, codeine, metoprolol | fluoxetine, paroxetine, quinidine |
| CYP2C9 | ~15% | warfarin, phenytoin, NSAIDs | fluconazole, amiodarone |
| CYP2C19 | ~10% | clopidogrel, omeprazole | omeprazole, fluvoxamine |
| CYP1A2 | ~5% | caffeine, theophylline | fluvoxamine, ciprofloxacin |

### Pharmacogenomic Variant Impact

Look up known gene-drug interactions in PharmGKB. Flag
these metabolizer phenotypes:
- **Poor metabolizer (PM)**: reduced enzyme activity → drug accumulation → toxicity risk
- **Ultrarapid metabolizer (UM)**: increased activity → subtherapeutic levels or excess active metabolite (codeine → morphine toxicity in CYP2D6 UM)

### CYP Expression in Omics Data

When analyzing transcriptomic data with safety implications:
- Check CYP gene expression levels in treatment vs control
- CYP induction (upregulation) may indicate enzyme induction → drug interaction risk
- CYP inhibition (downregulation or competitive binding) → toxicity risk for co-administered drugs

## Structural Alert Analysis

When compound structures are available (SMILES/SDF), screen against PAINS, Brenk, and NIH structural alert catalogs using RDKit's FilterCatalog module.

Flag but do NOT automatically exclude — structural alerts are
context-dependent. Report: alert type, affected substructure, and
the specific liability concern.

### hERG Liability Indicators

No predictive hERG model is available in the sandbox. Instead:
- Flag compounds with `ALogP > 3.5` AND `basic nitrogen` — known hERG liability correlates
- Check ChEMBL for existing hERG bioactivity data, querying the compound against target CHEMBL240 (hERG)
- Report: "hERG liability not computationally assessed; experimental
  patch-clamp assay recommended for compounds entering lead optimization"

## Safety Biomarker Panels

When clinical lab data is available alongside omics data:

### Organ-Specific Safety Panels
| Organ | Biomarkers | Alert Thresholds |
|-------|-----------|------------------|
| Liver | ALT, AST, ALP, TBil, GGT | Hy's Law criteria |
| Kidney | Creatinine, BUN, eGFR, KIM-1, NGAL | >1.5x baseline |
| Heart | Troponin I/T, BNP/NT-proBNP, CK-MB | Any troponin >ULN |
| Bone Marrow | ANC, platelets, hemoglobin, reticulocytes | CTCAE Grade 3+ |
| Pancreas | Amylase, lipase | >3x ULN |

### Analysis Approach
1. Compute per-patient max toxicity grade across timepoints
2. Correlate safety biomarker levels with omics features (DE genes,
   pathway scores) — use Spearman correlation with FDR correction
3. Identify molecular signatures predictive of high-grade toxicity
4. Report as safety biomarker associations, NOT causal claims

## Drug-Drug Interaction Assessment

When multiple drugs are in scope:
1. Identify CYP metabolism pathways for each drug (use PharmGKB)
2. Flag overlapping CYP substrates — co-administration risk
3. Check for known inhibitor-substrate pairs
4. Search FAERS for the drug combination to assess real-world signal

## Pharmacovigilance Signal Detection

When analyzing FAERS data for safety signals, use disproportionality
analysis to distinguish real signals from background noise.

### Disproportionality Measures

| Measure | Formula | Interpretation | Threshold |
|---------|---------|---------------|-----------|
| PRR (Proportional Reporting Ratio) | (a/a+b) / (c/c+d) | Frequentist, easy to compute | PRR > 2, chi-squared > 4, N >= 3 |
| ROR (Reporting Odds Ratio) | (a/b) / (c/d) | Odds ratio analog, wider CI | Lower 95% CI > 1 |
| IC (Information Component) | log2(observed/expected) | Bayesian, WHO-UMC method | IC025 > 0 (lower CI bound) |
| EBGM (Empirical Bayes Geometric Mean) | Bayesian shrinkage estimate | FDA standard method | EB05 > 2 (5th percentile) |

Contingency table: a = drug+event, b = drug+no-event,
c = no-drug+event, d = no-drug+no-event.

### Signal Detection Workflow

1. Query FAERS adverse-event reports for the drug of interest.
2. For each adverse event, compute PRR and ROR from FAERS counts.
3. Apply signal threshold: PRR > 2 AND N >= 3 AND chi-squared > 4.
4. Rank signals by PRR magnitude and report count.
5. Cross-reference with known drug label adverse events to distinguish
   known from novel signals.

### Temporal Pattern Analysis

When longitudinal FAERS data is available:
- Time-to-onset distribution for each adverse event
- Early signals (< 30 days) suggest direct pharmacological effect
- Late signals (> 90 days) suggest cumulative or immune-mediated
  toxicity
- Compare temporal patterns with known mechanism of action

### Drug-Drug Interaction Signal Detection

When assessing DDI safety:
1. Query FAERS for drug A alone, drug B alone, and combination.
2. Compute interaction signal: is the combination PRR significantly
   higher than either drug alone?
3. Flag synergistic toxicity signals (combination PRR > max(PRR_A, PRR_B)).
4. Cross-reference with CYP metabolism data from PharmGKB.

See `references/pharmacovigilance.md` for PRR/ROR computation
functions and visualization patterns.

## References

| Reference | File | Contents |
|-----------|------|----------|
| Pharmacovigilance | `references/pharmacovigilance.md` | PRR, ROR, IC computation from FAERS data, signal detection workflow, DDI signal analysis, temporal pattern visualization |

## Do NOT

- Claim computational predictions are equivalent to experimental safety
  assays (hERG patch-clamp, Ames test, in vivo toxicology)
- Use predicted ADMET properties as definitive safety assessments —
  they are screening-level signals, not regulatory-grade data
- Present structural alerts as toxicity proof — many drugs have alerts
  and are safe; context matters
- Skip the "experimental validation needed" caveat for any computational
  safety prediction
- Assign CTCAE grades without actual clinical lab values — grading
  requires measured values, not predicted values
- Report disproportionality signals as confirmed causal associations —
  FAERS data has known limitations (underreporting, confounding,
  notoriety bias)
- Use PRR alone without minimum case count (N >= 3) — low-count
  signals are statistically unreliable
- Ignore the denominator problem — FAERS reporting rates change over
  time and across regions
