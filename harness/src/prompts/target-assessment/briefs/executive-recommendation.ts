export const executiveRecommendationBrief = `# Section: Executive recommendation

Integrate the Phase-4 dossier and the per-section synthesis outputs
(liability bullets, target-organ liabilities trail, translational
commentary) into a disposition with cited rationale, key strengths, key
risks, and a coverage qualifier.

## Inputs
You receive (1) the full Phase-4 dossier and (2) the per-section
synthesis outputs as JSON. Cite at least three section paths from the
dossier in the rationale.

## Approval precedents (provided)
- FDA approval precedents for the candidate indication are supplied in the
  prompt (see the \`## FDA approval precedents\` block). For class-level
  disposition framing, cite at least one listed prior approval trajectory
  (approved, withdrawn, or refused) where relevant. Do not assert
  precedents absent from that block.

## Output discipline
- Disposition is one of pursue / conditional / de-prioritize /
  insufficient_evidence. Confidence is one of high / medium / low.
- Rationale ≥ 600 chars (the existing length probe enforces this).
- key_strengths and key_risks must each contain at least one entry
  unless the disposition is insufficient_evidence.
- coverage_qualifier.sections_consulted must list every section
  referenced in rationale; sections_unavailable must list any section
  with coverage queried_no_data or not_loaded.

## Do NOT (target-attribution discipline)
- Do NOT cite any clinical trial, trial AE, outcome, or failed-trial
  termination reason unless that row carries
  \`attribution.evidence_role: "supports_target"\` AND
  \`eligible_for_toxicology_aggregation: true\`. Rows whose attribution
  is \`contextual\` or \`excluded\` may be discussed only as coverage gaps
  or background biology, never as clinical safety/efficacy evidence.
- For every NCT you cite, name the attribution relationship
  (\`direct_modulator\` or \`class_modulator\`) and cite the row's
  \`attribution.basis[]\` source. Biomarker-only rows
  (\`target_biomarker\`, \`pathway_biomarker\`) support biological
  plausibility only; they do not support tractability, safety, or
  efficacy claims.
- Do NOT cite trial AEs, efficacy, or termination reasons from
  \`related_target_trials[]\` as evidence of the assessment target's
  drug behaviour. These trials are on related receptors (e.g.,
  CGRP-R/CALCRL for a CALCR assessment) and tell you nothing about the
  assessment target itself.
- Do NOT interpret a Reactome pathway containing the gene symbol as
  evidence of drug-target binding. Reactome pathways list participating
  genes, not drug interactions. Drug-binding evidence comes from
  \`drug_interactions.data.rows\` and
  \`safety_profile.off_target_panel.data.rows\` only.
- Do NOT cite a dossier path for a fact that does not appear at that
  path. If the fact comes from the supplied approval precedents (the
  \`## FDA approval precedents\` block),
  add it to \`external_citations[]\` with id, kind, retrieved_via, and
  excerpt, and reference it inline as \`[ID]\`.
- Do NOT collapse FAERS signals across modulators that share an active
  substance. The deduplicated
  \`safety_profile.faers.data.per_modulator\` is the source of truth for
  distinct-substance counts.
- Do NOT surface organ-level liability claims (kidney, CNS, hepatic,
  cardiac, etc.) unless they appear in
  \`safety_profile.target_organ_liabilities\`. That section is the
  probe-validated source for organ claims; any organ liability the
  probe rejected does not belong in \`key_risks\`.
- Do NOT recommend a between-cofactor selectivity margin against rows in
  \`safety_profile.off_target_panel.data.excluded_rows[]\` that carry
  \`relationship: "obligate_cofactor"\`. These rows represent the
  assessment target paired with a different obligate accessory protein;
  the gene product is the same and a cofactor-partner selectivity
  requirement is not pharmacologically attainable. Frame any clinical
  consequence of the cofactor partner (e.g., nausea, satiety, glucose
  modulation for AMY3 on a CALCR assessment) as a context-dependent
  on-target effect tied to tissue co-expression, not as an off-target
  liability to be selected against.
- Do NOT use the erroneous abbreviation "IND-A" or any "IND" + "A" variant as shorthand for IND. The FDA's term for an investigational new drug submission is "IND" (Investigational New Drug Application). When citing an IND-enabling regulatory expectation, write "IND-enabling package", "IND filing", or "FDA IND submission" — not a four-letter acronym.
- Do NOT phrase a mechanistic claim about a brain region's involvement in a behaviour or AE without verifying that the region in your rationale matches the region in the dossier source path. The nucleus tractus solitarius is brainstem, not hypothalamus; conflating them in the recommendation undermines the rationale's credibility with toxicology reviewers.

### Citation discipline

When citing a PMID inside a \`key_risks\` or \`liability_bullet\` entry:
1. The cited paper's stated conclusion MUST be directionally consistent with the way it is cited. If the paper concluded that an exposure *reduced* a risk, do NOT cite it as evidence FOR that risk — even if it was historically discussed alongside the risk in regulatory reviews.
2. When unsure of a paper's directional conclusion, omit the citation and use a different evidence source from the dossier body.
3. Every NCT cited must appear in the dossier's clinical_development.trials, failed_trials, or analytics.discovery_trials sections AND must have an intervention referencing a drug from drug_interactions. NCTs whose interventions are outside the on-target class (e.g., SGLT2 inhibitors in a GLP-1R dossier) must not be cited.`;
