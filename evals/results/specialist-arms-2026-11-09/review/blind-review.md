# Blind review of the specialist drafts (v1)

Scope: the drafts in `tmp/claude/specialists/v1/`, against the rubric in
`tmp/claude/specialists/00-guidelines.md`, the current bodies in
`harness/src/prompts/sandbox/`, the standards in
`harness/src/prompts/sandbox-standards.ts`, and the skills in `skills/`.

Paths below are short:

- `D01` to `D06` are the drafts `v1/01-...` to `v1/06-...`.
- `P/<name>` is `harness/src/prompts/sandbox/<name>.ts`.
- `S/<name>` is `skills/<name>/SKILL.md`.
- `STD` is `harness/src/prompts/sandbox-standards.ts`.

## 0. The baseline for T2

The measured baseline is weak evidence for any specialist. On the 32 bulk and
enrichment cases, the generic executor passed 96 of 96 trials, and the
specialists 93 of 96 (commit `074eada4`, `docs/agent-evals-hill-climb.md`). Those
cases test the standards, not the choice of a method. Thus each decision delta
below is a hypothesis. Each one must become a case before a draft replaces a
current body.

Two readings of T2 give different answers:

- **The model reads the skill.** D06:4-5 tells the agent to read the skill of the
  domain. Then the body delta is only a rule that no single skill holds: a rule
  that spans assays, the boundary, and the output contract.
- **The model reads no skill (T4).** Then the stance is the only defense, and
  each stance line counts.

The delta lists below mark each item as `cross` (no skill holds it) or `skill`
(a skill holds it, and the body only makes it cached and unconditional).

## 1. Cross-cutting findings

### 1.1 Duplicate of the standards (T3)

Each draft restates the scope rule of the standards. `STD:162-176` already says
"name the processed form you need and stop" and "Reading evidence at sites you
already have is in scope".

- D01:40-41, D02:40-41, D05:33-35, D06:25-26 copy it.
- D05:34-35 ("you read evidence at sites that you already have, and you make no
  call") copies `STD:175-176` word for word.
- D01:51 and D02:48-50 restate `.obs`/`.var`/`.X` from `STD:227-231`.

Call: keep only the part that adds a fact. "Images without a segmentation"
(D02:41) adds a fact. "Raw spectra" (D01:40) is a scope decision (see 2.4).
Delete the rest.

### 1.2 Orphaned work

The five drafts plus the executor leave these current capabilities with no
owner. The planner routes by `capabilities` (`harness/src/prompts/planner.ts:132-139`),
so each orphan goes to the executor or to a wrong specialist.

| Work | Current owner | Why no draft takes it |
| --- | --- | --- |
| Co-expression modules (WGCNA), hub genes, module-trait | `P/network-agent:16-20,35-39` | D03:40-41 excludes it. D01:43-44 excludes networks. |
| Peak annotation, nearest gene, bigWig signal, Hi-C | `P/chromatin-agent:21-27`, `S/chromatin-regulation:61-87,150` | D01:40 takes only "a processed matrix". |
| Stand-alone scATAC | `P/chromatin-agent:29-31` | D02:3-5 names single-cell RNA and multiome only. |
| TCR/BCR repertoire, checkpoint panel, TME class | `P/immune-profiling-agent:28-38` | No draft names them. |
| Methylation clocks | `P/dna-methylation-agent:28-29` | D01 is silent. D04 fits models but a clock applies a fixed model. |
| Untargeted LC-MS from mzML (XCMS) | `P/metabolomics-agent:11,32-36` | D01:40-41 now calls raw spectra upstream. |

Decision: the executor becomes the plannable owner of orphans, or each orphan
gets a named owner. Today the executor is "Non-plannable"
(`harness/src/agents/sandbox/scientific-executor.ts:3`).

### 1.3 Contract names (T5)

- p-values: `pvalue`, `adjusted_pvalue` in each draft agree with `STD:240-241`.
- The input layer: D01:52 uses `.layers["input"]`, D02:48-49 uses
  `.layers["counts"]`. For a bulk count matrix, the two names hold the same
  thing. Pick one rule: `counts` when the input is counts, `input` otherwise.
  Write the rule once, in the standards.
- Interval: D04:44-46 `ci_lower`/`ci_upper` disagree with
  `S/statistical-modeling:90` (`CI_lower`, `mean`, `n_folds`).
- Coordinates: D05:43-46 `chromosome`/`position` disagree with
  `S/genomic-variants:167,170` (`chrom`, `pos`).
- Edges: D03:49 `score`/`evidence` disagree with `S/network-regulatory:81`
  (`weight`, `type`).
- Each skill "Output Conventions" section is a second copy of the contract.
  Delete those sections from the skills, or make them refer to the body. Else the
  copies drift again.

## 2. D01 Matrix Analyst

### T1 Branch

Sentences true for one assay:

- D01:17 "M-values" (methylation).
- D01:20-22 "Isotopes and adducts of one metabolite" (metabolomics), "peptides of
  one protein group" (proteomics), "neighboring CpGs" (methylation).
- D01:23-25 the missing-value stance: true for mass spectrometry. A count matrix
  has zeros, not missing values.
- D01:30 "one plate" (Olink, arrays).
- D01:40 "raw spectra, and raw array files".
- D01:50 `protein`, `cpg_id`.

Classification: each sentence is one example of one stance (compare samples
under a design). They differ only in tooling. No split signal.

A hidden branch: peak counts (D01:5) get zero sentences. The chromatin decisions
(consensus peak set, spike-in scale) are not abstracted. They are dropped.

### T2 Fold

Remove the stance and the executor (D06:9-16) already covers: the unit of
replication, the simplest method, distrust of a batch, an interval. The remaining
delta is real:

- the scale decides the model family, from the values, not the assay name
- no second normalization
- feature dependence before a count of hits
- missingness by cause, filter before fill
- no p-value without replicates
- the design formula first

### T3 Drift and contradictions

Two stance lines contradict the skills that the agent will read:

1. **Phospho roll-up.** D01:20-22 says peptides of one protein "come from one
   entity. Collapse or model them". A weak model applies this to
   phosphosites. The skill forbids it: `S/proteomics:85,108,136`, and so does
   `P/proteomics-agent:26,70`. This line pushes the agent toward the most
   expensive proteomics error.
2. **Correction of values.** D01:30-31 says "Put a known confounder in the model,
   not in a correction of the values." The skills prescribe value corrections:
   LOESS on QC injections for drift (`S/metabolomics:47,102`), ComBat_seq
   (`S/bulk-transcriptomics:32,55`), Olink bridge normalization
   (`S/proteomics:50`). Drift along the run order is not a design term. If this
   line is the intended stance, change the skills. If not, limit it to a known
   batch in a differential model.

### T4 Weak model

| Domain | Most expensive error | Body alone stops it? |
| --- | --- | --- |
| Bulk | Count model on TPM (`P/bulk-transcriptomics-agent:64`) | Yes, D01:15-19 |
| Bulk | Inference on 1 vs 1 (`P/bulk-transcriptomics-agent:21-23`) | Yes, D01:26-27 |
| Proteomics | Count model on intensities (`P/proteomics-agent:63`) | Yes, D01:15-17 |
| Proteomics | Phospho roll-up (`P/proteomics-agent:70`) | No. D01:20-22 invites it |
| Metabolomics | TIC/PQN for drift (`P/metabolomics-agent:65`) | No. D01:30-31 forbids the fix |
| Metabolomics | PLS-DA with no permutation (`P/metabolomics-agent:71`) | No. D01:28 is too general |
| Methylation | Tests on beta values (`P/dna-methylation-agent:65`) | Partly, D01:15-17. "Beta is a proportion: test on the logit" is not said |
| Methylation | Blood cell mix (`P/dna-methylation-agent:74`) | Partly, D01:29-31. A mix is not "known" until a step estimates it |
| Chromatin | Single-replicate differential binding (`P/chromatin-agent:63`) | Yes, D01:26-27 |
| Chromatin | CUT&Tag with no spike-in (`P/chromatin-agent:66`) | No |

One stance line closes the spike-in gap and helps proteomics and methylation:
"A normalization assumes that most features do not change. A global shift
breaks it, and the data alone cannot show the shift."

### Lost decisions

| Lost item | Current | In the skill? |
| --- | --- | --- |
| Site-level phospho, no roll-up | `P/proteomics-agent:26,70` | Yes, `S/proteomics:85,108,136`. The body contradicts it |
| LOESS on QC pools for drift | `P/metabolomics-agent:65` | Yes, `S/metabolomics:47,102`. The body contradicts it |
| PLS-DA permutation, n >= 1000 | `P/metabolomics-agent:19-20,71` | Yes, `S/metabolomics:83,107` |
| Blank subtraction | `P/metabolomics-agent:61` | Yes, `S/metabolomics:106` |
| Positive and negative mode merge | `P/metabolomics-agent:63` | Yes, `S/metabolomics:108` |
| Cross-reactive and SNP probes | `P/dna-methylation-agent:70-73` | Yes, `S/dna-methylation:156-157` |
| Report delta-beta | `P/dna-methylation-agent:24-25,84` | Yes, `S/dna-methylation:85-89`. The D01 contract has no column for it |
| Bisulfite coverage filter | `P/dna-methylation-agent:22-23` | Yes, `S/dna-methylation:70` |
| Array annotation is not staged | `P/dna-methylation-agent:11-19` | Yes, `S/dna-methylation:12-28` |
| Spike-in, consensus peaks | `P/chromatin-agent:63-71` | Yes, `S/chromatin-regulation:36-41,131-135` |
| XCMS from mzML | `P/metabolomics-agent:11,32-36` | The skill teaches it, `S/metabolomics:14-27`. D01:40 removes it from scope |

### T5 Contract

- D01:48-50 has `log2_fold_change` only. For methylation, the effect that a
  reader uses is `delta_beta`. A log2 ratio of M-values is not a log2 fold
  change. Add an `effect_scale` rule, or a `delta_beta` column for that space.
- D01:51-52 puts normalized values in `.X`. The current methylation contract puts
  beta in `.X` and M in a layer (`P/dna-methylation-agent:81-82`). The change is
  permitted, but name it.

### T6 Overlap

- With D02: bulk deconvolution (D02:5-6, 38-39) takes a bulk matrix, which is
  D01 input (D01:40). The planner cannot select from the data kind.
- With D04: an association of a feature with a covariate fits both. Write the
  rule: one model per feature, with shrinkage and correction over features, is
  D01. One outcome per model is D04.

### Decision delta (D01 vs D06 plus the same skills)

1. TPM or log input: a linear model, not a count model. (`skill`, but the rule
   "read the scale from the values" is `cross`)
2. Raw counts: no normalization before the count model. (`skill`)
3. NPX or ANML input: no second normalization. (`skill`)
4. One sample per group: effect sizes, no p-value, a reason. (`skill`)
5. Protein groups, adducts, isotopes: collapse before a count of hits. (`cross`)
6. Missing values: filter, then impute by cause. (`skill`)
7. A beta matrix: test on the logit scale. (`skill`)
8. A known batch: a term in the design. (`cross`, and it conflicts with the
   skills, see T3)
9. Paired or repeated samples: the pairing is in the design formula. (`cross`)
10. IDAT, CEL, raw spectra: stop and name the processed form. (`STD` already)

### Verdict: keep, adjust

- Fix D01:20-22 so that it keeps a site when the question is about the site.
- Fix or limit D01:30-31.
- Add the global-shift line.
- Add the effect scale for methylation to the contract.
- Decide the mzML scope.
- Take bulk deconvolution from D02.

## 3. D02 Cell-Resolved Analyst

### T1 Branch

- D02:5-6, 38-39 bulk deconvolution. The input is a bulk matrix. "The cell is the
  observation" (D02:10) is false for it. Its errors are a scale error and a
  single-method error (`P/immune-profiling-agent:67,70`). **Different stance:
  move it.**
- D02:21-22 lineage and state markers (cytometry). The same stance (a cluster is
  a choice of features). Keep it, because it is the most expensive CyTOF error.
- D02:23-25 spatial (three sentences), D02:41 "images without a segmentation",
  D02:50 `.obsm["spatial"]`. Spatial adds a variable. It does not conflict with
  the core stance: the donor or the section is still the replicate. Not a split
  now. This is the strongest split candidate if spatial cases fail in a
  different way from the dissociated cases.
- D02:48-49 `.layers["counts"]` is false for CyTOF, CODEX, MIBI, IMC. These
  give intensities.

Result: one branch with a different stance (bulk deconvolution). Move it to D01.
The other branches differ only in tooling.

### T2 Fold

The delta is real and mostly `cross`: the replicate unit, a cluster as a
choice, a label as a hypothesis, location as a variable, artifacts of the
processing. D06:9-11 names the unit of replication. It does not say "count
donors, not cells".

### T4 Weak model

| Domain | Most expensive error | Body alone stops it? |
| --- | --- | --- |
| scRNA | Per-cell tests between conditions (`P/single-cell-agent:89`) | Yes, D02:10-13 |
| CyTOF | Clusters on state markers (`P/single-cell-agent:98`) | Yes, D02:21-22 |
| CyTOF | Wrong arcsinh cofactor (`P/single-cell-agent:99`) | No. `S/single-cell:293-297` |
| Multimodal | Protein or ATAC normalized as RNA (`P/multimodal-sc-agent:63-66`) | Partly. D02:20 says "quality control of each modality alone", not "normalize each modality by its own noise model" |
| Spatial | Visium spot read as one cell (`P/spatial-omics-agent:64`) | Yes, D02:24-25 |
| Spatial | Grid vs generic neighbors (`P/spatial-omics-agent:62`) | No. `S/spatial-omics:49-53,135` |
| Deconvolution | Log-scale input (`P/immune-profiling-agent:67`) | No |

### Lost decisions

| Lost item | Current | In the skill? |
| --- | --- | --- |
| Deconvolution takes linear scale | `P/immune-profiling-agent:46,67` | Only in a reference: `skills/immune-profiling/references/immune-deconvolution.md:109-110,341` |
| At least two deconvolution methods | `P/immune-profiling-agent:22-23,70` | Yes, `S/immune-profiling:38-40,178-179` |
| Matched-tissue reference for deconvolution | `P/spatial-omics-agent:66` | Yes, `S/spatial-omics:73-74,137` |
| ligrec cannot run | `P/spatial-omics-agent:25-27` | Yes, `S/spatial-omics:110-112` |
| TF-IDF and LSI for ATAC | `P/multimodal-sc-agent:65` | Yes, `S/multimodal-single-cell:126` |
| Raw counts into scVI and TOTALVI | `P/single-cell-agent:95`, `P/multimodal-sc-agent:73` | Yes, `S/single-cell:40`. Only implied in `S/multimodal-single-cell:89` |
| scVelo needs spliced layers | `P/single-cell-agent:92` | Yes, `S/single-cell:219-220` |
| HVG flavor matches the state | `P/single-cell-agent:93-94` | Yes, `S/single-cell:47-48` |
| CyTOF DA and DS tables | `P/single-cell-agent:115-117` | Yes, `S/single-cell:330-331`. The D02 contract has no DA table |
| TF activity inside a single-cell step | `P/single-cell-agent:34` | Moved to D03 by D02:44. That is a new plan step. Name it |

`S/single-cell:326` saves the CyTOF object as RDS. That conflicts with
`STD:236-239`. This conflict exists today.

### T5 Contract

- D02:31-34 "Done" asks each contrast to name "its replicate unit and its
  count". D02:52-53 has no column for them. Add `replicate_unit` and `n`, or a
  sidecar.
- D02:48-49 raw counts in `.layers["counts"]`: limit it to count assays.
- D02:52-53 lacks the `mean_abundance` of D01:49. Pseudobulk output is a bulk
  result. Use one schema.

### T6 Overlap

Bulk deconvolution overlaps D01 (see T1). D02:3-5 does not name stand-alone
scATAC, but `S/chromatin-regulation:89-108` covers it.

### Decision delta (D02 vs D06 plus the same skills)

1. A condition contrast: pseudobulk per donor, not per cell. (`skill`, and
   `cross` for CyTOF and spatial)
2. A contrast with fewer than two donors per arm: descriptive only. (`cross`)
3. Clusters: report the change over resolutions. (`cross`)
4. A cluster from one sample: treat it as a batch, then show otherwise. (`cross`.
   Caution: the malignant cells of each tumor cluster by patient, and that is
   biology. The phrase "until shown otherwise" must stay.)
5. Labels: name the labels that the markers do not support. (`cross`, near
   `S/single-cell:106-116`)
6. Cytometry: cluster on lineage markers only. (`skill`)
7. Multimodal: QC each modality alone before the join. (`skill`)
8. Visium: a spot is a mixture, so no per-cell claim. (`skill`)
9. Images with no segmentation: stop. (`cross`)

### Verdict: keep, adjust

- Move bulk deconvolution to D01.
- Change D02:20 to "QC and normalize each modality by its own noise model".
- Fix the counts layer for intensity assays.
- Add the replicate columns.
- Name scATAC as input.

## 4. D03 Interpretation

### T1 Branch

No sentence is true for only one assay. D03:25-26 (a regulator is an activity) is
true only for TF work. PPI has no stance sentence of its own. D03:20-22 covers it
("an interaction is a curated claim"). No split signal.

### T2 Fold

This draft is the strongest fold candidate. Almost each stance line also exists
in `S/enrichment`:

- background: `S/enrichment:23,90`
- identifiers: `S/enrichment:93`
- "consistent with": `S/enrichment:95`
- redundancy: `S/enrichment:59-70`
- TF framing: `S/enrichment:34-35`
- the release: `S/enrichment:94`

The measured result agrees: the executor matched the enrichment specialist.
The `cross` delta that remains:

- the mapping fraction as a finding (D03:18-19)
- "the universe is what the upstream step tested" (D03:14-15). The skill says
  "expressed/detected", which is close.
- the per-sample branch (D03:12-13)

The round-9 exception still keeps D03. Nearly each enrichment step needs the
background and the identifier rules, and D06 without the skill does not stop a
whole-genome background. Thus T4 fails for D06 and passes for D03.

### T3 Drift

Keep the stance in D03 and delete the copies from the anti-pattern list of
`S/enrichment:88-97`. Keep the API facts in the skill.

### T4 Weak model

| Domain | Most expensive error | Body alone stops it? |
| --- | --- | --- |
| Enrichment | ORA with no background (`P/enrichment-agent:60`) | Yes, D03:14-16 |
| Enrichment | Rank by p-value with no sign (`P/enrichment-agent:17`) | No. D03:10-11 says "ranked", not "signed" |
| Network | TF from its own expression | Yes, D03:25-26 |
| Methylation hits into ORA | Probe-number bias (`S/dna-methylation:172`) | No. A gene with more probes gets hit more often. D03:14-16 does not carry the bias into the background |
| Immune signatures | A score with low gene coverage (`P/immune-profiling-agent:71-72`) | Yes, D03:18-19 by analogy |

One line closes two gaps: "The background carries the same bias as the hits. A
gene with more probes, more length, or more peaks gets hit more often. Keep the
sign of a ranked list."

### Lost decisions

| Lost item | Current | In the skill? |
| --- | --- | --- |
| Signed rank statistic | `P/enrichment-agent:17` | Yes, `S/enrichment:18,97` |
| Set size 15 to 500 | `P/enrichment-agent:34` | Yes, `S/enrichment:78` |
| gseapy column `FDR q-val` | `P/enrichment-agent:71-72` | Yes, `skills/enrichment/references/gseapy-api.md:207,312` |
| WGCNA, hubs, module-trait | `P/network-agent:16-20,35-39,73-80` | Yes, `S/network-regulatory:16-29,62-69`. No owner |
| PPI through `search_interactions` | `P/network-agent:25-30` | The tool description carries it |
| missMethyl for CpG lists | not in a current prompt | `S/dna-methylation:172`. D03 does not get that skill |
| Signature `tmin` of 2 for CYT | not in a current prompt | `S/immune-profiling:65-68`. It conflicts with the 15-gene minimum of `S/enrichment:78`. D03 needs the immune skill, or the rule moves |

The CollecTRI and DoRothEA rule also drifts today. `P/network-agent:81` forbids
DoRothEA. `S/single-cell:240` permits "DoRothEA confidence A-C".

### T5 Contract

- D03:29-31 "Done" asks for the background size and the mapping fraction. These
  are values for one run, not for one term. D03:45-46 has no place for them.
  Add `output/enrichment_summary.json`.
- D03:47-48 puts scores in `.X` of a new object. The skills write
  `adata.obsm["score_ulm"]` (`S/enrichment:31`, `S/network-regulatory:44`).
  Either form works. Name the change in the skill.
- D03:49 `score`, `evidence` vs `S/network-regulatory:81` `weight`, `type`.

### T6 Overlap

D03:36-37 input does not name a processed cell object, but D03:47 writes "samples
or cells". Add "processed expression objects" to the input. Then single-cell TF
activity routes here without doubt.

### Decision delta (D03 vs D06 plus the same skills)

1. A list cut at a threshold: ORA with the tested universe as background. (`skill`)
2. A ranked list: a rank test on a signed statistic over all tested features.
   (`skill`)
3. A mapping fraction below a threshold: report it as a finding. (`cross`)
4. Many overlapped significant terms: group them. (`skill`)
5. TF activity from targets, not from the TF level. (`skill`)
6. The wording: "consistent with". (`skill`)
7. A CpG or peak list: correct the bias of the background. (`cross` after the
   fix)

### Verdict: keep, provisional

- Add the bias and sign line.
- Give D03 the immune-signature rule, or move it into `S/enrichment`.
- Move the missMethyl note into `S/enrichment`.
- Decide the WGCNA owner.
- Fold D03 into D06 if delta cases 1, 2, 3, and 7 do not separate D03 from D06.

## 5. D04 Statistical Modeling

### T1 Branch

No assay-specific sentence. D04:47 (ratio scale) is specific to the outcome
type, and that is correct.

### T2 Fold

D06:14-15 names "the leak". The rest is a real delta: prediction vs explanation,
the structure of the outcome, the selection inside the resampling, events per
variable, prognostic vs predictive, a perfect AUC.

### T4 Weak model

| Domain | Most expensive error | Body alone stops it? |
| --- | --- | --- |
| Modeling | Preprocessing outside CV (`P/statistical-modeling-agent:78-79`) | Yes, D04:15-18 |
| Modeling | Censoring code swapped (`P/statistical-modeling-agent:50-52,80`) | **No.** It inverts each hazard ratio with no error. `S/statistical-modeling:28` holds it |
| Modeling | Gene list chosen by an upstream DE on the same samples | No. D04:17-18 says "before the split", but an earlier step is not visible as a split. `S/statistical-modeling:197-201` holds it |
| Modeling | Nominal p-value of an optimal cutpoint | Partly. D04:16 puts the cutpoint inside the fit, but the maxstat correction is not said. `S/statistical-modeling:159-164` |

Add two lines: "An event indicator has a direction: make sure that 1 means the
event." and "A selection by an earlier step on the same samples is part of the
fit."

### Lost decisions

| Lost item | Current | In the skill? |
| --- | --- | --- |
| Censoring code | `P/statistical-modeling-agent:50-52` | Yes, `S/statistical-modeling:28` |
| Hold-out 20-30 % | `P/statistical-modeling-agent:48-49` | Yes, `S/statistical-modeling:78` |
| AUPRC for imbalance | `P/statistical-modeling-agent:81-82` | Yes, `S/statistical-modeling:38,226-227` |
| VIF | `P/statistical-modeling-agent:85-86` | Yes, `S/statistical-modeling:100` |
| KM medians in `survival_results.csv` | `P/statistical-modeling-agent:98-100` | No. Lost from body and skill |
| `direction` of an importance | `P/statistical-modeling-agent:95` | Yes, `S/statistical-modeling:91`. Lost from the D04 contract |

### T5 Contract

`model_performance.json` field names disagree with `S/statistical-modeling:90`.
The body must win, and the skill section must go.

### T6 Overlap

There is an overlap with D01 on "explanation" models over omics features. Use
the rule in 2/T6.

### Decision delta (D04 vs D06 plus the same skills)

1. State prediction or explanation, and judge each in its own way. (`cross`)
2. Few events: a simple model, and say why (events per variable, not rows).
   (`cross`, the skill says N < 100)
3. Scaling, imputation, selection, cutpoint, and tuning inside the resampling.
   (`skill`)
4. "Predictive" only with a treatment interaction. (`skill`)
5. AUC near 1 on a small study: a search for a leak. (`cross`)
6. A subject in train and test: the resampling unit is the subject. (`cross`)
7. Censoring direction. (`skill`, after the fix)

### Verdict: keep, adjust

Add the censoring line and the cross-step selection line. Write the D01 boundary.

## 6. D05 Genetics

### T1 Branch

- D05:13-15 ancestry and kinship (GWAS only).
- D05:16-18 the genome-wide threshold (GWAS only).
- D05:19-20 call quality, AC/AN (VCF only).
- D05:23-24 instruments (Mendelian randomization only).
- D05:28-29 "Done": inflation and threshold exist for GWAS only. An annotated
  shortlist has no inflation.
- D05:4, 34 "called copy-number segments" get no stance and no contract.

Classification: three branches. They are GWAS, variant triage, and Mendelian
randomization. They share the coordinate stance (D05:10-12). Triage has a
different stance (evidence per variant, an annotation is an assertion). Not a
split now, because of the volume. It becomes a split signal if clinical triage
cases grow. Drop the copy-number segments, or give them one stance line and a
contract.

### T2 Fold

The delta is real and mostly `cross` for D06: coordinates first, structure, the
genome as the multiple test, a call is not a fact.

### T4 Weak model

| Domain | Most expensive error | Body alone stops it? |
| --- | --- | --- |
| GWAS | No PCA covariates (`P/genomic-variant-agent:71`) | Yes, D05:13-15 |
| All | Mixed builds (`P/genomic-variant-agent:73`) | Yes, D05:10-12 |
| Annotation | Contig names `chr1` vs `1`: the join is empty | Partly. D05:12 "no error" is general. `S/genomic-variants:111,123-125` |
| Annotation | ClinVar single-submitter claim treated as fact | No. `S/genomic-variants:120-122` |

### Lost decisions

| Lost item | Current | In the skill? |
| --- | --- | --- |
| plink2 on x86_64 only | `P/genomic-variant-agent:17-19` | Yes, `S/genomic-variants:57-64` |
| Annotation is a join (no VEP) | `P/genomic-variant-agent:20-24` | Yes, `S/genomic-variants:100-103` |
| Canonical isoform for domains | `P/genomic-variant-agent:30-38` | The tool carries it, `harness/src/tools/bio/get-protein-domains.ts:47-48` |
| Liftover loss count | `P/genomic-variant-agent:73-74` | Yes, `S/genomic-variants:155-158` |
| `clinical_significance` column | `P/genomic-variant-agent:86` | Yes, `S/genomic-variants:168`. Lost from the D05 contract |

### T5 Contract

- D05:43-45 `effect` has no named allele and no scale. A logistic GWAS gives an
  OR or a log OR. Add `effect_allele` and state the scale (D04:47 already states
  a ratio scale).
- D05:43 `variant_id` replaces `rsid` (`P/genomic-variant-agent:83`). Permitted,
  but name it.
- D05:46-47 add `clinical_significance` and a review status.
- No contract for Mendelian randomization output.

### T6 Overlap

The current meta claims "variant calling", "CNV detection", and "structural
variant detection" (`harness/src/agents/sandbox/genomic-variant-agent.ts:12`).
Each conflicts with the body and with `STD:164-176`. The planner reads those
capabilities, so the meta must change with the body. An eQTL step (genotype by
expression) fits D01, D04, and D05. Give it one owner.

### Decision delta (D05 vs D06 plus the same skills)

1. Align the build, the alleles, and the contig names before a join. (`cross`)
2. An association test: PCs and relatedness in the model, and lambda reported.
   (`skill`)
3. A genome-wide threshold, with "suggestive" named. (`skill`)
4. AF from AC/AN. (`skill`)
5. A gene for a variant: from consequence and linkage, not distance. (`cross`)
6. Mendelian randomization: assumptions stated and tested. (`skill`)

### Verdict: keep, adjust

- Add contig names.
- Add the effect allele and the scale.
- Add the review status.
- Make "Done" per output.
- Decide the CNV segments.
- Fix the meta capabilities.

## 7. D06 Executor

D06 is the T2 baseline, and it is correct as a baseline. Two facts:

- D06:4-5 tells the agent to read the domain skill. Thus the T2 delta of each
  specialist is small if the model obeys. The T4 delta is large if it does not.
- If the orphans of 1.2 go to D06, D06 must become plannable and must own
  capabilities. Today it is not plannable.

D06:25-26 duplicates `STD:162-176` (see 1.1).

## 8. Split and fold summary

| Draft | Verdict | Primary reason |
| --- | --- | --- |
| D01 | Keep, adjust | One stance, branches differ only in tooling. Two lines contradict the skills: phospho roll-up and value correction |
| D02 | Keep, adjust | Bulk deconvolution has a different stance and must move to D01. Spatial is the next split candidate |
| D03 | Keep, provisional | Its stance is a copy of `S/enrichment`. It survives on T4 only. Fold if its delta cases do not separate |
| D04 | Keep, adjust | A real delta. Censoring direction is lost |
| D05 | Keep, adjust | A real delta. A triage branch is latent. The contract lacks the effect allele |
| D06 | Keep as baseline | Must become plannable if it owns the orphans |

No draft must split now. No draft must fold now. D03 is the only fold candidate,
and the evals decide it.
