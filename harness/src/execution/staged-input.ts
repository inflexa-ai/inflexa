/**
 * Staged-input contract.
 *
 * The harness's durable workflows assume an analysis's input tree is already populated
 * under `data/inputs/` (see the data-profile-init spec) — they never download or copy input data, and
 * never call a staging step. The embedder stages the tree at the async edge,
 * once, BEFORE invoking the harness: the managed service downloads from object storage;
 * the CLI copies/links the user's local files. The embedder hands a fixed-width
 * {@link StagedInputSummary} of the resulting manifest to the data-profile trigger, which
 * rides it in the workflow input. The manifest itself never enters the workflow input: its
 * size grows with the file count, and the profile reads the tree, not the manifest.
 *
 * This file declares only the data shapes the harness consumes. The act of producing
 * them (download / copy) lives entirely caller-side; the harness holds no staging seam.
 */

import type { DataProfileInputSignature } from "../contracts/data-profile.js";

/**
 * One input file present under the analysis data dir.
 * `fileId`/`mountName`/`key`/`fileName` are source identifiers the managed
 * service derives from its object-store index and the CLI synthesizes from the
 * local path — the harness treats them as opaque labels.
 */
export type StagedInput = {
    readonly fileId: string;
    readonly mountName: string;
    readonly key: string;
    readonly fileName: string;
    readonly size: number;
    /**
     * Last-modification time in epoch milliseconds. With `size` and `fileId` it feeds
     * the kept-files `inputSignature` a completed profile persists — what lets a
     * consumer notice the bytes behind a path changed, since a `fileId` is a path
     * identity and survives an in-place content edit unchanged.
     *
     * Embedder-supplied and opaque: the CLI reads it from the same `stat` that yields
     * `size`; a managed service supplies its object store's last-modified epoch.
     */
    readonly mtimeMs: number;
    /** Path relative to the data dir, e.g. "inputs/{mountName}/{key}". */
    readonly relativePath: string;
};

/**
 * The staged input set as the data-profile trigger and workflow carry it: three fixed-width
 * facts in place of one entry for each file. The embedder computes it from its manifest.
 */
export type StagedInputSummary = {
    /** The count of staged files. Zero is an analysis with no input files. */
    readonly count: number;
    /** The sum of the sizes of the staged files, in bytes. */
    readonly totalBytes: number;
    /** `computeInputSignature` over the manifest. A completed profile persists it verbatim. */
    readonly signature: DataProfileInputSignature;
};
