/**
 * Protein-family → preferred modality lookup, used by §2.2 Tractability
 * fallback when Open Targets has no tractability assessment for the target.
 */

import familyMappingData from "../../data/protein-family-modality.json" with { type: "json" };
import { normalizeProteinFamily } from "./protein-family-normalize.js";

interface FamilyEntry {
    family: string;
    patterns: string[];
    preferred_modality: string;
    rationale: string;
}

interface FamilyMappingFile {
    schema_version: number;
    data_version: string;
    families: FamilyEntry[];
    default: { preferred_modality: string; rationale: string };
}

// The JSON import yields an untyped/structurally-wide value; cast to the declared
// shape, which the bundled data file is authored to satisfy.
const dataset = familyMappingData as unknown as FamilyMappingFile;

function loadDataset(): FamilyMappingFile {
    return dataset;
}

export interface ModalityFallback {
    family: string | null;
    preferred_modality: string;
    rationale: string;
    source: "family-match" | "default";
}

/**
 * Infer a preferred modality from a free-text protein-family description
 * (typically the UniProt family/keyword). Returns the dataset default when
 * no family pattern matches.
 */
export function inferModalityFromFamily(familyText: string | null): ModalityFallback {
    const ds = loadDataset();
    const normalized = normalizeProteinFamily(familyText);
    if (normalized) {
        for (const entry of ds.families) {
            for (const pattern of entry.patterns) {
                const normPattern = normalizeProteinFamily(pattern);
                if (normPattern && normalized.includes(normPattern)) {
                    return {
                        family: entry.family,
                        preferred_modality: entry.preferred_modality,
                        rationale: entry.rationale,
                        source: "family-match",
                    };
                }
            }
        }
    }
    return {
        family: null,
        preferred_modality: ds.default.preferred_modality,
        rationale: ds.default.rationale,
        source: "default",
    };
}
