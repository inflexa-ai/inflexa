export const liabilityBulletsBrief = `# Section: Liability bullets

Write evidence-cited liability bullets in toxicologist voice. Each bullet
covers one organ-or-axis with severity, the supporting evidence pointer,
and a rationale that names the mechanism hypothesis.

## Inputs
You receive the full Phase-4 dossier as JSON. Cite section paths and
counts (FAERS n=NN, IMPC p=...) verbatim from the dossier.

## Tool use
- For class precedents not present in the dossier, call
  \`find_approval_precedent\` with the modality and mechanism hint and
  cite the returned NDA/BLA + label section.

## Output discipline
- Severity is one of high / medium / low.
- Each rationale must include either a hedge phrase, a literature
  citation, or a regulatory reference for every efficacy/safety claim.
- Do not fabricate counts. If the dossier lacks evidence, mark it
  explicitly ("the data do not support a conclusion") rather than
  generating filler.
- Trial AEs, failed-trial reasons, and outcomes may be used as
  toxicology evidence only when the row has
  \`eligible_for_toxicology_aggregation: true\` and
  \`attribution.evidence_role: "supports_target"\`. Rows marked
  \`contextual\` or \`excluded\` are coverage/context only; do not cite
  them as safety evidence.

## Category vocabulary
Each bullet's \`category\` MUST be exactly one of:
- \`fatal_post_market\` — class-defining contraindication / fatal
  post-market signal (e.g., anaphylaxis-with-death on a class label).
  When \`safety_profile.regulatory_actions.coverage === "available"\`, every
  row in that array is a confirmed regulatory event (EMA referral, FDA
  safety communication, REMS, withdrawal). Emit one
  \`fatal_post_market\` bullet per row, naming the \`agency\`, \`action_date\`,
  and quoting the \`finding\` verbatim. Do NOT phrase regulatory
  actions as inferences from FAERS counts.
- \`class_liability\` — formal class-precedent organ liability meeting
  the 3-drug threshold (sourced from
  \`safety_profile.class_precedent.data.per_organ\`).
- \`off_target_safety\` — selectivity-driven liability at a related
  receptor (sourced from
  \`safety_profile.off_target_panel.data.rows\`).
- \`high_safety_organ_expression\` — expression-driven on-target
  liability at a safety-relevant tissue (sourced from
  \`off_tissue_risk.data.rows\` and the
  \`safety_profile.target_organ_liabilities\` probe).
- \`broad_expression\` — expression spread across many tissues without a
  single-organ driver (sourced from
  \`derived.liability_summary.expression_breadth\`).
- \`other\` — uncategorisable safety observation worth flagging; use
  only when none of the above fit.

## Obligate-cofactor rows

\`safety_profile.off_target_panel.data.excluded_rows[]\` may contain rows
with \`relationship: "obligate_cofactor"\`. These represent the
assessment target heterodimerised with a different obligate accessory
protein (e.g., a CALCR/RAMP3 entry on a CALCR assessment is the AMY3
amylin receptor — same gene product, different RAMP partner).

- Do NOT generate an \`off_target_safety\` liability bullet for these
  rows. Selectivity between cofactor partners of the same gene product
  is not pharmacologically attainable; the protein is the same.
- Do NOT recommend a between-cofactor selectivity margin (e.g., "≥N-fold
  over <gene>/RAMP<N>") against an obligate-cofactor row. The
  pharmacology is context-dependent on cofactor co-expression in the
  target tissue, which is an on-target property, not a selectivity
  property.
- If the row carries a \`clinical_consequence\` annotation (e.g.,
  satiety, nausea), fold that consequence into an
  \`high_safety_organ_expression\` or \`broad_expression\` bullet where
  the cofactor's tissue distribution makes the engagement clinically
  relevant. Do not invent a selectivity liability.

## Mechanism-claim discipline

When stating a mechanism for an adverse-event signal, the mechanism must operate at the same biological scale as the AE.

- Do NOT cite developmental, regenerative, or homeostatic biology (e.g., satellite-cell quiescence, stem-cell niche maintenance, tissue homeostasis) as the mechanism for a clinical AE signal like arthralgia, myalgia, or fatigue. Those papers describe tissue-level processes, not AE-producing pathways. If the only mechanistic candidate in the dossier is at the tissue-homeostasis level, omit the mechanism claim and report the AE signal alone (the rationale can still cite the AE prevalence number).

- Respect anatomical boundaries. The nucleus tractus solitarius (NTS) is brainstem, not hypothalamus. The nucleus accumbens is basal ganglia, not hypothalamus. The amygdala is subcortical, not hypothalamus. When binning a CNS expression signal under a region category, the region in the rationale must match the region in the dossier source path. Do not conflate "neural circuit involving X" with "expressed in X" — the latter is the only on-target claim supported by tissue expression data.

- For \`category: "high_safety_organ_expression"\` bullets, the cited brain region must be one of: hypothalamus, brainstem (medulla / pons / midbrain), cerebellum, basal ganglia (caudate / putamen / nucleus accumbens / globus pallidus), thalamus, hippocampus, amygdala, or cortex (frontal / temporal / parietal / occipital / cingulate). Do not invent new region categories.

### Source counters for bullet rationale

Each bullet rationale MUST cite at least one numeric counter from one of:
  - safety_profile.faers.data.top_signals[].report_count (preferred when available)
  - safety_profile.faers.data.per_modulator[].report_count
  - safety_profile.class_precedent.data.per_organ[].top_aes[].report_count (use when target-level FAERS is queried_no_data)
  - safety_profile.trial_aes.data.serious[].incidence_pct / non_serious[].incidence_pct
  - safety_profile.off_target_panel.data.rows[].pchembl with the off_target_name
A bullet that cites a numeric counter from class_precedent.per_organ.top_aes.report_count is valid;
do NOT delete it for "no source" if a class_precedent counter is present.

### Tissue-expression unit discipline

When citing tissue-expression values, ALWAYS use the unit string from \`reference_biology.normal_tissue_expression.data.unit\` (one of: "tpm",
"ntpm", "consensus_normalized"). Do not assume "TPM" — Open Targets'
hpa_consensus source emits "consensus_normalized" (nTPM-like).
Render as e.g. "217 nTPM" or "217 (consensus_normalized)", never "217 TPM"
unless the unit field is "tpm".

### Citation discipline

When citing a PMID inside a \`key_risks\` or \`liability_bullet\` entry:
1. The cited paper's stated conclusion MUST be directionally consistent with the way it is cited. If the paper concluded that an exposure *reduced* a risk, do NOT cite it as evidence FOR that risk — even if it was historically discussed alongside the risk in regulatory reviews.
2. When unsure of a paper's directional conclusion, omit the citation and use a different evidence source from the dossier body.
3. Every NCT cited must appear in the dossier's clinical_development.trials, failed_trials, or analytics.discovery_trials sections AND must have an intervention referencing a drug from drug_interactions. NCTs whose interventions are outside the on-target class (e.g., SGLT2 inhibitors in a GLP-1R dossier) must not be cited.`;
