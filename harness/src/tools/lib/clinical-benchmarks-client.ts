import benchmarksData from "../../data/clinical-benchmarks.json" with { type: "json" };

export interface PhaseTransitions {
    phase1_to_phase2: number;
    phase2_to_phase3: number;
    phase3_to_nda: number;
    nda_to_approval: number;
    phase1_to_approval: number;
}

export interface BenchmarkResult {
    therapeutic_area: string;
    source: "available" | "fallback";
    data_version: string;
    data_window: string;
    attribution: string;
    transitions: PhaseTransitions;
}

interface BenchmarksFile {
    schema_version: number;
    data_version: string;
    data_window: string;
    source: string;
    url: string;
    refresh_procedure: string;
    phase_transitions: Record<string, PhaseTransitions>;
    indication_to_therapeutic_area: { patterns: string[]; therapeutic_area: string }[];
}

const dataset = benchmarksData as BenchmarksFile;

if (!dataset.phase_transitions || !dataset.phase_transitions.all) {
    throw new Error("clinical-benchmarks.json is missing phase_transitions.all baseline");
}

function loadDataset(): BenchmarksFile {
    return dataset;
}

/**
 * Infer therapeutic area from a list of indication labels using the
 * dataset's pattern map. First match wins.
 */
export function inferTherapeuticArea(indicationLabels: string[]): string | null {
    const dataset = loadDataset();
    for (const label of indicationLabels) {
        const lower = label.toLowerCase();
        for (const entry of dataset.indication_to_therapeutic_area) {
            for (const pattern of entry.patterns) {
                if (lower.includes(pattern.toLowerCase())) {
                    return entry.therapeutic_area;
                }
            }
        }
    }
    return null;
}

/**
 * Get phase-transition benchmarks for a therapeutic area. Falls back to
 * the all-areas baseline when the requested area is unknown — the
 * `source` field discloses whether the fallback was used.
 */
export function getBenchmarks(therapeuticArea: string | null): BenchmarkResult {
    const dataset = loadDataset();
    const useFallback = !therapeuticArea || !dataset.phase_transitions[therapeuticArea];
    const ta = useFallback ? "all" : therapeuticArea!;
    return {
        therapeutic_area: ta,
        source: useFallback ? "fallback" : "available",
        data_version: dataset.data_version,
        data_window: dataset.data_window,
        attribution: dataset.source,
        transitions: dataset.phase_transitions[ta],
    };
}

/** Return the dataset's metadata for transparency in the dossier. */
export function getDatasetAttribution(): {
    data_version: string;
    data_window: string;
    source: string;
    url: string;
} {
    const ds = loadDataset();
    return {
        data_version: ds.data_version,
        data_window: ds.data_window,
        source: ds.source,
        url: ds.url,
    };
}
