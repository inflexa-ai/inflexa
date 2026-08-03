import { compareSuppliedMetadata, detectCitationConflicts } from "./compare.js";
import { clusterCitationRecords, selectCitationCluster, type CitationMatchConfig, DEFAULT_MATCH_CONFIG } from "./match.js";
import type { CitationCoverage, CitationInput, CitationResolutionResult, CitationSourceOutcome, CitationVerdict, NormalizedCitation } from "./types.js";

function deriveCoverage(outcomes: readonly CitationSourceOutcome[], comparisonsIncomplete: boolean): CitationCoverage {
    const applicable = outcomes.filter((outcome) => outcome.status !== "not_applicable");
    if (applicable.length === 0) return "none";
    const hasCoverage = applicable.some(
        (outcome) => outcome.status === "ok" || outcome.status === "no_data" || outcome.records.length > 0 || outcome.identifierEvidence?.exists === true,
    );
    if (!hasCoverage) return "none";
    if (applicable.some((outcome) => outcome.status === "unavailable") || comparisonsIncomplete) return "partial";
    return "complete";
}

function deriveVerdict(
    normalized: NormalizedCitation,
    selected: CitationResolutionResult["candidates"][number] | undefined,
    comparisons: CitationResolutionResult["comparisons"],
    coverage: CitationCoverage,
): CitationVerdict {
    if (normalized.unsupportedWorkKind !== undefined) return "unverifiable";
    if (selected !== undefined) {
        if (comparisons.some((comparison) => comparison.status === "mismatch")) return "metadata_mismatch";
        if (comparisons.some((comparison) => comparison.status === "not_compared")) return "inconclusive";
        return "verified";
    }
    return coverage === "complete" ? "not_found" : "inconclusive";
}

export function aggregateCitationResolution(
    input: CitationInput,
    normalized: NormalizedCitation,
    sourceOutcomes: readonly CitationSourceOutcome[],
    matchConfig: CitationMatchConfig = DEFAULT_MATCH_CONFIG,
): CitationResolutionResult {
    const records = sourceOutcomes.flatMap((outcome) => outcome.records);
    const candidates = clusterCitationRecords(input, normalized, records, matchConfig);
    const selected = selectCitationCluster(candidates, matchConfig);
    const comparisons = compareSuppliedMetadata(input, selected);
    const coverage = deriveCoverage(
        sourceOutcomes,
        comparisons.some((comparison) => comparison.status === "not_compared"),
    );
    const verdict = deriveVerdict(normalized, selected, comparisons, coverage);
    return {
        input,
        normalized,
        sourceOutcomes: [...sourceOutcomes],
        candidates,
        ...(selected === undefined ? {} : { selectedClusterId: selected.id }),
        comparisons,
        conflicts: detectCitationConflicts(candidates),
        verdict,
        coverage,
    };
}
