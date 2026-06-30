/**
 * Staged-input manifest contract.
 *
 * The harness's durable workflows assume an analysis's input tree is already populated
 * under `data/inputs/` (see the data-profile-init spec) — they never download or copy input data, and
 * never call a staging step. The embedder stages the tree at the async edge,
 * once, BEFORE invoking the harness: the managed service downloads from object storage;
 * the CLI copies/links the user's local files. The embedder hands the resulting
 * manifest to the data-profile trigger, which rides it in the workflow input.
 *
 * This file declares only the manifest element — the data shape the harness consumes.
 * The act of producing it (download / copy) lives entirely caller-side; the harness
 * holds no staging seam.
 */

/**
 * One input file present under the analysis data dir, with its content hash.
 * `fileId`/`mountName`/`key`/`fileName` are source identifiers the managed
 * service derives from its object-store index and the CLI synthesizes from the
 * local path — the harness treats them as opaque labels.
 */
export interface StagedInput {
    readonly fileId: string;
    readonly mountName: string;
    readonly key: string;
    readonly fileName: string;
    readonly hash: string;
    readonly size: number;
    /** Path relative to the data dir, e.g. "inputs/{mountName}/{key}". */
    readonly relativePath: string;
}
