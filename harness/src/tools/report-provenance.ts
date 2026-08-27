/**
 * The report provenance source seam -- where the frozen provenance of one analysis comes from.
 *
 * The signed document of an analysis belongs to the embedder. The report page shows the chain of each
 * grounded block, thus the page must carry a copy of that document. The harness asks the seam for the bytes,
 * and it moves them into the page. It parses no byte, and it holds no provenance API.
 *
 * Absence is a normal result, not a fault. A composition that binds no source, and a bound source that holds
 * no document for the analysis, both give nothing. The preview then renders the page with no provenance
 * asset, and every other part of the page is what it was.
 *
 * The seam can be async, because a source can read a file or ask a service. It is independent of the
 * observation seam: one bound seam works with the other unbound.
 */

import type { Logger } from "../lib/logger.js";
import type { ProvenanceExport } from "../report-render/provenance-data.js";

export type { ProvenanceExport } from "../report-render/provenance-data.js";

/**
 * The optional provenance source of the report tools.
 *
 * The source takes the analysis and gives the current document and its attestation, or `undefined` for
 * absence. The result rides in band, thus a caller reads one value and never an error channel.
 */
export type ReadReportProvenance = (analysisId: string) => ProvenanceExport | undefined | Promise<ProvenanceExport | undefined>;

/**
 * Bind the optional seam and the logger of one tool into a total read.
 *
 * An absent seam gives a call that answers absence. Thus a tool asks at its one site with no test of its
 * own, and an unbound composition needs no branch.
 *
 * The harness is host-agnostic, and it cannot assume that a host callback is total. Thus a throw of the
 * realization reaches the log and becomes absence: the provenance of the page is an addition to the report,
 * and a defect in it must never cost the render.
 */
export function bindReportProvenance(read: ReadReportProvenance | undefined, logger: Logger): (analysisId: string) => Promise<ProvenanceExport | undefined> {
    if (read === undefined) {
        return () => Promise.resolve(undefined);
    }
    return async (analysisId: string): Promise<ProvenanceExport | undefined> => {
        try {
            return await read(analysisId);
        } catch (cause) {
            logger.error("the report provenance source threw", { analysisId, ...logger.errorFields(cause) });
            return undefined;
        }
    };
}
