import { ORGAN_SYSTEMS } from "../../../contracts/organ-system.js";

// Interpolated rather than restated, so the prompt cannot name an organ the
// schema will reject.
const organTokens = ORGAN_SYSTEMS.join(", ");

export const targetOrganLiabilitiesBrief = `# Section: Target-organ liabilities (audit trail)

For each implicated organ system, write a per-organ trail that connects
genetic, expression, FAERS, and class-precedent evidence to a stated
mechanism hypothesis.

## Inputs
You receive the full Phase-4 dossier as JSON. Cite section paths and
counts verbatim. The \`organ\` field of every row MUST be exactly one of
these tokens: ${organTokens}. Anything else is rejected. Trail prose may
use the reader-facing name for that organ; the \`organ\` field may not.

## Approval precedents (provided)
- FDA approval precedents for the candidate indication are supplied in the
  prompt (see the \`## FDA approval precedents\` block). For class
  precedents withdrawn or labelled for the same liability, cite a listed
  Drugs@FDA NDA/BLA §<section>. Do not assert precedents absent from that block.

## Output discipline
- Trail format is study-summary cadence: claim, evidence with counts,
  qualifier on human relevance.
- \`severity\` is your own read of the liability for that organ — \`high\`,
  \`medium\`, or \`low\` — and must follow from the trail you wrote.
- Cite a PMID inline (\`PMID:12345678\`) for every literature claim in the
  trail; a trail that cites none is recorded as having no citable support.
- Mechanism hypothesis can be null if the data do not support one — say
  so rather than guessing.
- Trial AEs, failed-trial reasons, and outcomes may be used as
  organ-liability evidence only when the row has
  \`eligible_for_toxicology_aggregation: true\` and
  \`attribution.evidence_role: "supports_target"\`. Rows marked
  \`contextual\` or \`excluded\` are coverage/context only; do not cite
  them as safety evidence.`;
