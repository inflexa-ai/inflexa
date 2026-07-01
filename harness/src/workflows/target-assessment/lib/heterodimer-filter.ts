/**
 * Detect receptor-accessory heterodimer entries that share the assessment
 * target's gene product. These are NOT off-targets in the pharmacological
 * sense: the primary protein is the same, only the obligate accessory
 * cofactor differs. Selectivity windows between such partner complexes are
 * not pharmacologically attainable and should not be reported as off-target
 * liabilities.
 *
 * The accessory list is supplied by the IUPHAR family-complexes collector
 * at runtime — there is no hardcoded RAMP/MRAP/RGS pattern. For a CALCR
 * assessment the collector returns ["RAMP1","RAMP2","RAMP3"], so the
 * regex matches "CALCR/RAMP1", "CALCR/RAMP2", "CALCR/RAMP3" only.
 */

const ACC_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

function escapeForRegex(token: string): string {
    return token.replace(ACC_ESCAPE_RE, "\\$&");
}

export interface HeterodimerFilterInput {
    assessmentGeneSymbol: string;
    accessoryProteinNames: string[];
}

/**
 * Build a predicate that returns true when an off-target name describes a
 * heterodimer of the assessment target's primary protein with one of the
 * supplied accessory gene symbols. Returns a constant-false predicate when
 * the inputs cannot produce a meaningful match (missing gene symbol or
 * empty accessory list).
 *
 * Matched substrings:
 *   "<primary>/<accessory>"  (e.g., "CALCR/RAMP3")
 *   "<primary> + <accessory>"
 *   "<primary>-<accessory>"  (some sources use a hyphen)
 */
export function makeHeterodimerOfAssessmentFilter(input: HeterodimerFilterInput): (offTargetName: string) => boolean {
    const target = input.assessmentGeneSymbol.trim().toUpperCase();
    const accessories = input.accessoryProteinNames.map((n) => n.trim()).filter((n) => n.length > 0);
    if (!target || accessories.length === 0) {
        return () => false;
    }
    const alternation = accessories.map(escapeForRegex).join("|");
    const re = new RegExp(`\\b([A-Z][A-Z0-9]{1,9})\\s*[\\/+\\-]\\s*(${alternation})\\b`, "i");
    return (offTargetName: string) => {
        const m = re.exec(offTargetName);
        if (!m) return false;
        return m[1]!.toUpperCase() === target;
    };
}

/**
 * One-shot helper for callers that already have an accessory list in hand.
 * Equivalent to `makeHeterodimerOfAssessmentFilter(input)(offTargetName)`.
 */
export function isHeterodimerOfAssessment(input: { assessmentGeneSymbol: string; accessoryProteinNames: string[]; offTargetName: string }): boolean {
    return makeHeterodimerOfAssessmentFilter({
        assessmentGeneSymbol: input.assessmentGeneSymbol,
        accessoryProteinNames: input.accessoryProteinNames,
    })(input.offTargetName);
}
