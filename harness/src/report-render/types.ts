/**
 * The value model that the renderer takes, keyed by block id.
 *
 * The renderer declares its own value union. It does not take `ResolvedValue`, because a `ResolvedValue`
 * can be a file echo of a path and a hash. A page cannot show a path and a hash. The caller owns the
 * policy that turns the echo into a source string. The string is a data URI, or a URL that the host
 * serves. Thus a `figure` here carries a ready `src` string, and the renderer holds no policy about the
 * image bytes.
 */

import type { DataAsset } from "./table-data.js";

/**
 * The value that one block resolves to, as a closed union. A `scalar` gives one number or one string. A
 * `table` gives the rows and the optional column order. A `figure` gives a ready source string. A
 * `citation` echoes one external id.
 *
 * A `table` carries `total` when a row bound cut the rows of the artifact. The renderer states the shown
 * count against it. A table with no bound carries none, and the row count answers for it.
 */
export type RenderValue =
    | { type: "scalar"; value: string | number }
    | { type: "table"; rows: Array<Record<string, string | number>>; columns?: string[]; total?: number }
    | { type: "figure"; src: string }
    | { type: "citation"; id: string };

/**
 * One typed fault of a render. `blockId` names the block. `kind` names the class of the fault. `detail`
 * names what the block expected. The render collects every problem, and it returns them at once.
 */
export interface RenderProblem {
    blockId: string;
    kind: "missing-value" | "wrong-shape" | "invalid-chart-input";
    detail: string;
}

/** The value map that the renderer takes, keyed by block id. */
export type RenderValues = Record<string, RenderValue>;

/**
 * One rendered page: the HTML string, and each data asset that the page references.
 *
 * The renderer writes no file. Thus it gives the asset bytes back to the caller, and the caller stages
 * them beside the page. A document with no table gives an empty list, and its page references none.
 */
export interface RenderedPage {
    html: string;
    dataAssets: DataAsset[];
}
