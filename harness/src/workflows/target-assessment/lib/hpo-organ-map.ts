/**
 * Human Phenotype Ontology terms onto the canonical organ vocabulary.
 *
 * HPO organises every phenotypic abnormality under organ-system roots, and a
 * phenotype association carries its full ancestor closure. Resolution is
 * therefore membership of an ancestor id in this table — equality on
 * identifiers, not matching on prose, so a renamed term keeps resolving and an
 * incidental word in a label never decides an organ.
 *
 * The table is ordered most specific first, because a term sits under several
 * roots at once: a liver phenotype's closure also contains the digestive-system
 * root, and reading the broad root first would file every hepatic finding under
 * `gi`. Roots with no canonical organ to land in (ear, head and neck, growth,
 * prenatal) are absent — a phenotype is reported under the organ it affects or
 * not at all.
 *
 * A root broader than any single token is absent for that same reason, even
 * where a token's name is close to it: the endocrine-system root spans every
 * endocrine organ while the only endocrine token names the thyroid, so an
 * adrenal phenotype resolves through no root and is dropped. The neoplasm root
 * says a phenotype is malignant, not where it sits, so a neoplasm resolves
 * through the organ root it also carries — a lung neoplasm is respiratory, and
 * a neoplasm with no organ root at all resolves to nothing.
 *
 * The values are the canonical tokens, so this module declares no organ
 * enumeration of its own.
 */

import type { OrganSystem } from "../../../contracts/organ-system.js";

/** HPO ancestor id → canonical organ, most specific ancestor first. */
const HPO_ORGAN_ANCESTORS: ReadonlyArray<readonly [string, OrganSystem]> = [
    ["HP:0001392", "hepatic"], // Abnormality of the liver
    ["HP:0001733", "pancreas"], // Abnormality of the pancreas
    ["HP:0000820", "endocrine_thyroid"], // Abnormality of the thyroid gland
    ["HP:0000079", "renal"], // Abnormality of the urinary system
    ["HP:0000078", "reproductive"], // Abnormality of the genital system
    ["HP:0002597", "vascular"], // Abnormality of the vasculature
    ["HP:0001627", "cardiac"], // Abnormal heart morphology
    ["HP:0001626", "cardiac"], // Abnormality of the cardiovascular system
    ["HP:0000759", "pns"], // Abnormal peripheral nervous system morphology
    ["HP:0012639", "cns"], // Abnormal nervous system morphology
    ["HP:0000707", "cns"], // Abnormality of the nervous system
    ["HP:0002715", "immune"], // Abnormality of the immune system
    ["HP:0001871", "hematologic"], // Abnormality of blood and blood-forming tissues
    ["HP:0001939", "metabolic"], // Abnormality of metabolism/homeostasis
    ["HP:0002086", "respiratory"], // Abnormality of the respiratory system
    ["HP:0025031", "gi"], // Abnormality of the digestive system
    ["HP:0000478", "ocular"], // Abnormality of the eye
    ["HP:0001574", "dermatologic"], // Abnormality of the integument
    ["HP:0003011", "musculoskeletal"], // Abnormality of the musculature
    ["HP:0000924", "musculoskeletal"], // Abnormality of the skeletal system
];

/**
 * Resolve an HPO term onto a canonical organ from its own id plus its ancestor
 * closure. Returns null when nothing in the ancestry denotes a canonical organ
 * system — the caller drops the phenotype and counts it.
 */
export function resolveHpoOrgan(termId: string, ancestorIds: readonly string[]): OrganSystem | null {
    const ancestry = new Set<string>([termId, ...ancestorIds]);
    for (const [id, organ] of HPO_ORGAN_ANCESTORS) {
        if (ancestry.has(id)) return organ;
    }
    return null;
}
