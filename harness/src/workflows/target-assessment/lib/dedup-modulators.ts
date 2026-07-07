import { getMoleculeInChIKey, type ChemblModulator } from "../../../tools/lib/chembl-client.js";
import { classifyMoleculeType, getCompoundPropertiesByInChIKey } from "../../../tools/lib/pubchem-client.js";
import { withHost } from "../../../lib/host-concurrency.js";

export type DroppedSynonym = {
    chemblId: string;
    reason: "same_active_substance" | "ambiguous_name_synonym";
    keptId: string | null;
};

export type DedupResult<T extends Pick<ChemblModulator, "moleculeChemblId" | "parentChemblId" | "maxPhase" | "firstApproval">> = {
    kept: T[];
    dropped: DroppedSynonym[];
};

/**
 * Group modulators by parent_molecule_chembl_id (or moleculeChemblId when
 * the parent is absent — singleton groups). Within each group keep the
 * "most informative" entry: prefer firstApproval populated, then highest
 * maxPhase, then earliest moleculeChemblId for deterministic tie-break.
 *
 * Reason: ChEMBL exposes the same active substance under multiple
 * molecule_chembl_ids (e.g., CALCITONIN SALMON vs generic CALCITONIN),
 * which causes downstream FAERS queries to double-count the same reports.
 *
 * A second pass handles name-prefix synonyms where ChEMBL does not populate
 * molecule_hierarchy (e.g., CALCITONIN → CALCITONIN HUMAN). Entries with a
 * null firstApproval whose preferredName (uppercased) is a strict
 * word-boundary prefix of another entry's name within the same moleculeType
 * are dropped as same_active_substance (one match) or ambiguous_name_synonym
 * (multiple matches).
 */
export function dedupModulatorsByParent<
    T extends Pick<ChemblModulator, "moleculeChemblId" | "parentChemblId" | "maxPhase" | "firstApproval" | "preferredName" | "moleculeType">,
>(modulators: T[]): DedupResult<T> {
    const groups = new Map<string, T[]>();
    for (const m of modulators) {
        const key = m.parentChemblId ?? m.moleculeChemblId;
        const arr = groups.get(key) ?? [];
        arr.push(m);
        groups.set(key, arr);
    }

    const kept: T[] = [];
    const dropped: DroppedSynonym[] = [];

    for (const group of groups.values()) {
        if (group.length === 1) {
            kept.push(group[0]!);
            continue;
        }
        const ranked = [...group].sort((a, b) => {
            const aHasApp = a.firstApproval != null ? 1 : 0;
            const bHasApp = b.firstApproval != null ? 1 : 0;
            if (aHasApp !== bHasApp) return bHasApp - aHasApp;
            const aPhase = a.maxPhase ?? -1;
            const bPhase = b.maxPhase ?? -1;
            if (aPhase !== bPhase) return bPhase - aPhase;
            return a.moleculeChemblId.localeCompare(b.moleculeChemblId);
        });
        const winner = ranked[0]!;
        kept.push(winner);
        for (const loser of ranked.slice(1)) {
            dropped.push({
                chemblId: loser.moleculeChemblId,
                reason: "same_active_substance",
                keptId: winner.moleculeChemblId,
            });
        }
    }

    // Second pass: name-prefix synonym detection within the same moleculeType.
    // Handles cases where ChEMBL does not populate molecule_hierarchy for
    // unqualified generic names (e.g., "CALCITONIN" as a prefix of
    // "CALCITONIN HUMAN" and "CALCITONIN SALMON"). Only drops entries with
    // null firstApproval — an approved generic name should never be silently
    // dropped.
    const byType = new Map<string, T[]>();
    for (const m of kept) {
        const k = (m.moleculeType ?? "").toUpperCase();
        const arr = byType.get(k) ?? [];
        arr.push(m);
        byType.set(k, arr);
    }

    const dropIds = new Set<string>();
    for (const group of byType.values()) {
        for (const shortEntry of group) {
            if (shortEntry.firstApproval != null) continue;
            const shortName = (shortEntry.preferredName ?? "").trim().toUpperCase();
            if (!shortName) continue;

            const longerMatches = group.filter((other) => {
                if (other === shortEntry) return false;
                const longName = (other.preferredName ?? "").trim().toUpperCase();
                if (longName.length <= shortName.length) return false;
                if (!longName.startsWith(shortName)) return false;
                // Require a word-boundary character (whitespace or hyphen) immediately
                // after the prefix — prevents "CALC" from matching "CALCITONIN".
                const boundary = longName.charAt(shortName.length);
                return /[\s-]/.test(boundary);
            });

            if (longerMatches.length === 1) {
                dropIds.add(shortEntry.moleculeChemblId);
                dropped.push({
                    chemblId: shortEntry.moleculeChemblId,
                    reason: "same_active_substance",
                    keptId: longerMatches[0]!.moleculeChemblId,
                });
            } else if (longerMatches.length > 1) {
                dropIds.add(shortEntry.moleculeChemblId);
                dropped.push({
                    chemblId: shortEntry.moleculeChemblId,
                    reason: "ambiguous_name_synonym",
                    keptId: null,
                });
            }
        }
    }

    const finalKept = kept.filter((m) => !dropIds.has(m.moleculeChemblId));
    return { kept: finalKept, dropped };
}

// ── PubChem-backed molecule_type backfill ─────────────────────────────────────

function looksUnknown(value: string | null | undefined): boolean {
    if (!value) return true;
    const lowered = value.trim().toLowerCase();
    return lowered === "" || lowered === "unknown";
}

/**
 * For each modulator whose ChEMBL `moleculeType` is empty or "Unknown",
 * fetch the molecule's standard InChI key from ChEMBL, look it up in
 * PubChem, and apply the heuristic classifier (MW + amide-bond count).
 * Returns a new array of modulators with `moleculeType` replaced when a
 * confident classification emerges; otherwise the original ChEMBL value is
 * preserved. Network failures are isolated per modulator.
 */
export async function resolveModulatorMoleculeType<T extends Pick<ChemblModulator, "moleculeChemblId" | "moleculeType">>(modulators: T[]): Promise<T[]> {
    const candidates = modulators.filter((m) => looksUnknown(m.moleculeType));
    if (candidates.length === 0) return modulators;

    const refined = new Map<string, string>();
    await Promise.all(
        candidates.map(async (m) => {
            try {
                const inchiKey = await withHost("chembl", () => getMoleculeInChIKey(m.moleculeChemblId));
                if (!inchiKey) return;
                const props = await withHost("pubchem", () => getCompoundPropertiesByInChIKey(inchiKey));
                if (!props) return;
                const classified = classifyMoleculeType(props);
                if (classified !== "Unknown") refined.set(m.moleculeChemblId, classified);
            } catch {
                // Per-modulator failures must not blank out the others — keep the
                // original ChEMBL annotation.
            }
        }),
    );

    if (refined.size === 0) return modulators;
    return modulators.map((m) => {
        const next = refined.get(m.moleculeChemblId);
        if (!next) return m;
        return { ...m, moleculeType: next };
    });
}
