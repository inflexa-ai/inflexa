import type { ID, Str256 } from "@/lib/types";
import type { AnchorId } from "./anchor";
import type { ProjectId } from "./project";

export type AnalysisId = ID;

/**
 * The primary entity — the unit of work. Each analysis lives in a home folder (its
 * `anchor`, identified by UUID so it survives moves/renames) and owns a real, browsable
 * output directory. Project grouping is optional; an analysis can stand alone.
 */
export type Analysis = {
    /** Primary key. */
    id: AnalysisId;
    createdAt: number;
    updatedAt: number;

    /** Required human label, validated to 1–256 code points via `str256` at the CLI boundary. */
    name: Str256;
    /**
     * URL-safe handle derived from `name` (else a generated one). Unique **within an
     * anchor**, because outputs live at `…/analyses/<slug>/` and must not collide there.
     */
    slug: string;
    /**
     * Where outputs are written. `null` = derived from the anchor + slug (the default);
     * a set value is a persisted absolute path — an explicit `--output` override or the
     * XDG fallback used when the anchor folder isn't writable.
     */
    outputDirectory: string | null;

    /** The home folder's stable identity; always set. */
    anchorId: AnchorId;
    /** Optional grouping; `null` when the analysis belongs to no project. */
    projectId: ProjectId | null;
};
