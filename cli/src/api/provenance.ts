/** The format of a provenance export: the signed PROV-JSON bytes, or a PROV-N rendering of them. */
export type ProvExportFormat = "prov-json" | "prov-n";

/**
 * The body of `POST {A}/provenance/export`. Without `output`, the export goes into the output folder of
 * the analysis as `provenance.json` or `provenance.provn`. `output` is an absolute file path.
 */
export type ExportProvenanceRequest = {
    format: ProvExportFormat;
    output?: string;
};

/** The response of `POST {A}/provenance/export`: where the export landed. */
export type ExportProvenanceResult = {
    path: string;
    /**
     * The signed `.sig.json` attestation beside a PROV-JSON export. A PROV-N export has none: the
     * attestation claims the PROV-JSON payload type, and PROV-N is a rendering that the chain hash does
     * not cover.
     */
    attestationPath?: string;
};

/** How `GET {A}/provenance/lineage` renders the walk. */
export type LineageFormat = "tree" | "json" | "dot" | "mermaid";

/** A node of the flat JSON graph — kind-discriminated, carrying only the facts that kind has. */
export type LineageJsonNode =
    | { kind: "file"; path: string | null; hash: string | null; source: string | null; truncated?: true }
    | { kind: "command"; command?: string; exitCode?: number; unresolvedScript?: string; runId?: string; stepId?: string }
    | { kind: "file_tool"; tool?: string; runId?: string; stepId?: string }
    | { kind: "step" | "activity"; runId?: string; stepId?: string };

/** The flat JSON graph: direction-independent nodes + edges in PROV semantics, plus the walk's roots. */
export type LineageJson = {
    roots: string[];
    nodes: Record<string, LineageJsonNode>;
    edges: { from: string; to: string; kind: "wasGeneratedBy" | "used" }[];
};

/** The body of `GET {A}/provenance/lineage`: the graph for `json`, else the rendered text. */
export type LineageView = { format: "json"; lineage: LineageJson } | { format: Exclude<LineageFormat, "json">; text: string };
