export const targetOrganLiabilitiesBrief = `# Section: Target-organ liabilities (audit trail)

For each implicated organ system, write a per-organ trail that connects
genetic, expression, FAERS, and class-precedent evidence to a stated
mechanism hypothesis.

## Inputs
You receive the full Phase-4 dossier as JSON. Cite section paths and
counts verbatim. Anchor every organ name to the canonical
organ-system vocabulary (hepatobiliary, renal, cardiac, etc.) — colloquial
substitutes are rejected by the voice probe.

## Tool use
- For ICH-aligned mitigation paths, call \`search_regulatory_guidance\`
  with the relevant ICH code (e.g., "ICH S7A safety pharmacology",
  "ICH E14 thorough QT").
- For class precedents withdrawn or labelled for the same liability,
  call \`find_approval_precedent\` and cite Drugs@FDA NDA/BLA §<section>.

## Output discipline
- Trail format is study-summary cadence: claim, evidence with counts,
  qualifier on human relevance.
- Mechanism hypothesis can be null if the data do not support one — say
  so rather than guessing.
- Trial AEs, failed-trial reasons, and outcomes may be used as
  organ-liability evidence only when the row has
  \`eligible_for_toxicology_aggregation: true\` and
  \`attribution.evidence_role: "supports_target"\`. Rows marked
  \`contextual\` or \`excluded\` are coverage/context only; do not cite
  them as safety evidence.`;
