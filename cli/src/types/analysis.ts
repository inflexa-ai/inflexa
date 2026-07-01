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

/**
 * A single input reference — a path the analysis reads, stored as a reference, never a
 * copy (the local filesystem is authoritative). An analysis is free to span any number of
 * folders: its home `anchor` is only the default root, never a fence around the inputs.
 */
export type AnalysisInput = {
    /** Relative-to-`anchorId` when an anchor is set; an absolute path otherwise. */
    path: string;
    /** Distinguishes a directory reference (read its subtree) from a single-file reference. */
    isDir: boolean;
    /** The owning analysis. */
    analysisId: AnalysisId;
    /**
     * The input's **source** anchor (distinct from the analysis's *home* anchor). Set when
     * the input lives under a folder the CLI already tracks: the ref then rides that anchor's
     * UUID and survives the folder moving/being renamed. `null` for a raw absolute-path input
     * that belongs to no tracked anchor.
     */
    anchorId: AnchorId | null;
};
