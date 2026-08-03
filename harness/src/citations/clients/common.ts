import type { CitationRecord, CitationSource, CitationSourceOperation, CitationSourceOutcome, CitationSourcePlanItem } from "../types.js";

export function notApplicableOutcome(plan: CitationSourcePlanItem): CitationSourceOutcome {
    return {
        source: plan.source,
        operation: plan.operation,
        status: "not_applicable",
        requestCount: 0,
        records: [],
        detail: plan.reason,
    };
}

export function sourceOutcome(
    source: CitationSource,
    operation: CitationSourceOperation,
    status: CitationSourceOutcome["status"],
    requestCount: number,
    records: CitationRecord[] = [],
    detail?: string,
): CitationSourceOutcome {
    return {
        source,
        operation,
        status,
        requestCount,
        records,
        ...(detail === undefined ? {} : { detail }),
    };
}

/**
 * Percent-encode a DOI for use as a URL path segment. A DOI suffix may legally
 * contain `#`, `?`, and `%`, each of which silently re-parses the URL when
 * interpolated raw; only the prefix/suffix `/` is structural and stays literal.
 */
export function encodeDoiPath(doi: string): string {
    return doi.split("/").map(encodeURIComponent).join("/");
}

export function parseYear(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value !== "string") return undefined;
    const match = value.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
    return match?.[1] === undefined ? undefined : Number(match[1]);
}

export function firstNonEmpty(values: readonly unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
}
