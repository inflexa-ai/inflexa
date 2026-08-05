/**
 * The IMPC top-level-phenotype vocabulary onto the canonical organ vocabulary.
 *
 * Buckets with no organ system to land in (hearing, growth, mortality,
 * craniofacial) are absent: a phenotype is reported under the organ it affects
 * or not at all, never under an approximate neighbour. The map's values are the
 * canonical tokens, so it declares no enumeration of its own.
 *
 * The endocrine bucket is absent for the same reason: IMPC's
 * "endocrine/exocrine gland phenotype" spans every endocrine organ and the
 * exocrine glands besides, while the only endocrine token names the thyroid.
 * A knockout in that bucket names no canonical organ, so it is dropped and
 * counted rather than read as a thyroid finding.
 */

import type { OrganSystem } from "../../../contracts/organ-system.js";

const IMPC_ORGAN_SYSTEMS: Record<string, OrganSystem> = {
    cardiovascular: "cardiac",
    gastrointestinal: "gi",
    hematologic: "hematologic",
    metabolic: "metabolic",
    immune: "immune",
    skin: "dermatologic",
    hepatic: "hepatic",
    musculoskeletal: "musculoskeletal",
    skeleton: "musculoskeletal",
    cns: "cns",
    renal: "renal",
    reproductive: "reproductive",
    respiratory: "respiratory",
    vision: "ocular",
};

/** Resolve one IMPC bucket, or null when it denotes no canonical organ. */
export function resolveImpcOrgan(bucket: string): OrganSystem | null {
    return IMPC_ORGAN_SYSTEMS[bucket] ?? null;
}

/** Resolve a set of IMPC buckets, dropping those with no canonical organ. */
export function toOrganSystems(impcOrganSystems: readonly string[]): OrganSystem[] {
    const resolved = impcOrganSystems.map((o) => resolveImpcOrgan(o)).filter((o): o is OrganSystem => o !== null);
    return [...new Set(resolved)];
}
