import type { BusyReason } from "./analyses.ts";

/** The body of `POST /api/v1/anchors/repair`. */
export type RepairAnchorRequest = {
    /** The absolute folder that holds the `.inflexa/id` marker. */
    path: string;
};

/** The body of a `POST /api/v1/anchors/repair` response. `unchanged`: the anchor already pointed at `after`. */
export type RepairAnchorResponse = {
    outcome: "repaired" | "unchanged";
    anchorId: string;
    before: string;
    after: string;
};

/**
 * The body of `POST /api/v1/anchors/relocate`: one tracked folder (`fromPath`, `toPath`), or each anchor
 * under a moved tree (`from`, `to`). Each path is absolute. With `dryRun`, the server changes nothing and
 * gives what the call would do.
 */
export type RelocateAnchorRequest = ({ fromPath: string; toPath: string } | { from: string; to: string }) & {
    dryRun?: boolean;
};

/** One anchor that a relocation points at a new path. */
export type RelocatedAnchorView = {
    anchorId: string;
    before: string;
    after: string;
};

/** The body of a `POST /api/v1/anchors/relocate` response. */
export type RelocateAnchorResponse = {
    dryRun: boolean;
    relocated: RelocatedAnchorView[];
    /** The absolute input paths under the moved tree that a prefix relocation rewrote. Zero for one folder and for a dry run. */
    rawInputs: number;
    /** One folder only: the target holds no marker of the anchor, although the anchor wrote one. */
    markerMissing: boolean;
};

/** The body of `POST /api/v1/anchors/prune`. */
export type PruneAnchorsRequest = {
    /** Give the dead anchors and change nothing. */
    dryRun?: boolean;
    /** Prune only these anchors, for example the ones that a dry run showed. Each one must still be dead. */
    anchorIds?: string[];
};

/** An anchor whose folder is gone and that no reconciliation can find again. */
export type DeadAnchorView = {
    anchorId: string;
    path: string;
    analysisCount: number;
};

/** A dead anchor that the prune kept, because work holds one of its analyses. */
export type SkippedAnchorView = {
    anchorId: string;
    analysisId: string;
    reasons: BusyReason[];
};

/** The body of a `POST /api/v1/anchors/prune` response. */
export type PruneAnchorsResponse = {
    dryRun: boolean;
    /** The dead anchors that the request selected. */
    dead: DeadAnchorView[];
    /** The ids of the pruned anchors. Empty for a dry run. */
    pruned: string[];
    skipped: SkippedAnchorView[];
    /** The analyses whose stored conversations and run history the prune erased. */
    purged: number;
};
