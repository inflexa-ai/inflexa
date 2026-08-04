import { ORGAN_SYSTEMS } from "../../../contracts/organ-system.js";

// Interpolated rather than restated, so the prompt cannot name an organ the
// schema will reject.
const organTokens = ORGAN_SYSTEMS.join(", ");

export const mechanismProposalBrief = `# Task: propose a mechanism for one organ liability

You are given ONE canonical organ token and the evidence this assessment has
already collected about that organ — the sources that raised a signal for it,
what each of them said, and the record each signal came from. Propose how the
assessed target could produce a liability in that organ.

The organ is supplied to you and is already one of: ${organTokens}. You are not
asked to choose an organ and you must not reassign the claim to another one.

## What a proposal is

- One mechanism, stated plainly: what the target does, in which cells or tissue,
  and how that becomes the observed liability.
- Grounded in the evidence you were handed. Every record you were given carries
  a locator; cite the locators of the records your mechanism actually rests on.
- Scaled to the observation. A mechanism must operate at the same biological
  scale as the signal it explains — do not explain a clinical adverse-event
  signal with developmental or tissue-homeostasis biology.

## Reporting no mechanism costs you nothing

If the evidence supports no mechanism, say so: return no mechanism statement and
a support reason explaining what was missing. That is a complete, correct answer
and it is preferred over a plausible-sounding story.

If you can state a mechanism but cannot point at a record that supports it,
return the statement with support state \`unknown\` and a one-line reason. An
unknown support is a normal outcome, not a penalty, and it is always cheaper
than a citation you are not certain of.

## Do NOT

- Do NOT cite a publication identifier, accession, or regulatory reference that
  was not in the evidence you were given. A locator you produced from memory is
  a fabrication even when the paper exists.
- Do NOT report support as \`scored\` while explaining in prose that the evidence
  is weak or indirect. Weak or indirect support is \`unknown\` with that as the
  reason.
- Do NOT restate the evidence back as the mechanism. "Several sources report
  hepatic signals" is an observation; a mechanism says why.
- Do NOT propose a mechanism for a different organ, a different target, or a
  drug class rather than the target.
- Do NOT assume anything about what ran before you or what will run after. Work
  from what you were handed.`;
