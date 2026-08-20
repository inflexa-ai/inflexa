/**
 * Data-profile orientation — the bounded projection of a persisted
 * `DataProfileResult` into the few hundred characters an agent needs to know
 * WHAT DATASET IT IS HOLDING before it does anything else.
 *
 * The persisted profile is deliberately rich (per-file metrics, warnings, tags,
 * the full narrative summary) because the DB row is its only durable home — the
 * profiler's scratch tree is deleted on completion. That richness is right for a
 * pull-on-demand tool (`inspect_data_profile`) and wrong for anything injected
 * unconditionally into a context window, which is what a step seed does. This is
 * the lossy half of that pair: a hard character budget, a fixed field order, and
 * visible truncation counts, so an agent that needs more knows to go pull it.
 *
 * A pure function over the record — no I/O, no LLM, no pipeline. It is the whole
 * mechanism.
 *
 * Every path it renders is projected into the frame-independent
 * `/{analysisId}/…` form. The record stores a path relative to the analysis
 * root, which is the correct form to store; but a step agent resolves a relative
 * path against its own working directory, thus the stored form names a file that
 * does not exist there. The absolute form resolves to the same file in every
 * frame, including the conversation agent's, so the projection is unconditional.
 */

import type { DataProfileResult } from "../state/data-profile.js";
import { toAnalysisRootPath } from "../workspace/paths.js";

/** The character budget the projection guarantees it will not exceed. */
export const DATA_PROFILE_ORIENTATION_MAX_CHARS = 1200;

/** Files listed before the tail is elided (the count still reports the total). */
const MAX_FILES = 8;

/** Kinds listed before the tail is elided. A dataset with more is described by its first few. */
const MAX_KINDS = 6;

const MAX_KIND_DESCRIPTION_CHARS = 90;

/** Quality concerns listed — the profiler orders them, so these are the top ones. */
const MAX_CONCERNS = 3;

const MAX_DESIGN_CHARS = 200;
const MAX_CONCERN_CHARS = 120;
const MAX_FILE_DESCRIPTION_CHARS = 100;
const MAX_SUMMARY_FALLBACK_CHARS = 300;

/**
 * Clamp to `max` chars, marking any elision with an ellipsis. Whitespace is left
 * alone, so the assembled line structure survives the final bound.
 */
function clamp(text: string, max: number): string {
    if (text.length <= max) return text;
    if (max <= 1) return "";
    return text.slice(0, max - 1).trimEnd() + "…";
}

/**
 * Collapse a free-text field to one line and clamp it. Profiler prose (a summary, a
 * design note, a file description) may contain newlines; folding them out is what
 * keeps one record on one line.
 */
function clip(text: string, max: number): string {
    return clamp(text.replace(/\s+/g, " ").trim(), max);
}

/** Non-empty, whitespace-collapsed value, or `undefined` — nulls and blanks read the same. */
function present(value: string | null | undefined): string | undefined {
    const flat = value?.replace(/\s+/g, " ").trim();
    return flat ? flat : undefined;
}

/** `Homo sapiens (taxon 9606)`, plus a confidence marker when the profiler was unsure. */
function formatOrganism(organism: DataProfileResult["organism"]): string | undefined {
    if (!organism) return undefined;
    const name = present(organism.scientificName);
    if (!name) return undefined;
    const taxon = present(organism.taxonId);
    const qualifier = organism.confidence === "high" ? "" : ` [${organism.confidence} confidence]`;
    return taxon ? `${name} (taxon ${taxon})${qualifier}` : `${name}${qualifier}`;
}

/** `(20000 x 24, CSV)` — whichever of dimensions / format the profiler recorded. */
function formatFileFacts(file: DataProfileResult["files"][number]): string {
    const dims = typeof file.rows === "number" && typeof file.cols === "number" ? `${file.rows} x ${file.cols}` : undefined;
    const facts = [dims, present(file.format)].filter((f): f is string => f !== undefined);
    return facts.length > 0 ? ` (${facts.join(", ")})` : "";
}

/**
 * Project a persisted profile into an orientation blurb of at most `maxChars`
 * characters. The bound is a guarantee, not a target: the assembled text is
 * hard-clamped, so no profile — however verbose — can blow a caller's budget.
 *
 * Field order is fixed and reflects what an agent must know first: what the
 * dataset IS, how it was designed, what is wrong with it, then what files carry
 * it. Both list sections state their true total, so an elided tail is visible
 * rather than silent.
 *
 * A snapshot written before the record was widened carries none of the structured
 * fields. Rather than emit a bare file list, that case falls back to the narrative
 * summary — the one orientation a legacy row does have.
 *
 * `analysisId` roots each rendered file path (see the module header). It is the
 * id of the analysis the profile belongs to, and it is what the sandbox mounts
 * the tree at.
 */
export function buildDataProfileOrientation(result: DataProfileResult, analysisId: string, maxChars: number = DATA_PROFILE_ORIENTATION_MAX_CHARS): string {
    const lines: string[] = [];

    const identity = [
        [present(result.domain), present(result.subtype)].filter((f): f is string => f !== undefined).join(" / ") || undefined,
        formatOrganism(result.organism),
        present(result.tissue) ? `tissue: ${present(result.tissue)}` : undefined,
        present(result.cellType) ? `cells: ${present(result.cellType)}` : undefined,
        present(result.condition) ? `condition: ${present(result.condition)}` : undefined,
    ].filter((f): f is string => f !== undefined);

    if (identity.length > 0) {
        lines.push(`Dataset: ${identity.join(" — ")}`);
    } else {
        // A legacy snapshot has no structured identity at all; the summary is the
        // only orientation it carries, so it stands in for the whole header.
        lines.push(`Dataset: ${clip(result.summary, MAX_SUMMARY_FALLBACK_CHARS)}`);
    }

    const design = present(result.experimentalDesign);
    if (design) lines.push(`Design: ${clip(design, MAX_DESIGN_CHARS)}`);

    const concerns = (result.qualityAssessment?.concerns ?? []).map((c) => present(c)).filter((c): c is string => c !== undefined);
    if (concerns.length > 0) {
        const shown = concerns.slice(0, MAX_CONCERNS).map((c) => clip(c, MAX_CONCERN_CHARS));
        const more = concerns.length > shown.length ? ` (+${concerns.length - shown.length} more)` : "";
        lines.push(`Concerns: ${shown.join("; ")}${more}`);
    }

    // Kinds come first because they are what the dataset IS at this budget: four lines
    // describing 3513 files, where the per-file list could only show the first eight of
    // them and imply the rest away.
    const kinds = result.kinds ?? [];
    if (kinds.length > 0) {
        const shown = kinds.slice(0, MAX_KINDS);
        const datasetFiles = kinds.reduce((sum, kind) => sum + kind.count, 0);
        const header =
            shown.length < kinds.length
                ? `Kinds (${shown.length} of ${kinds.length}, ${datasetFiles} files):`
                : `Kinds (${kinds.length}, ${datasetFiles} files):`;
        lines.push(header);
        for (const kind of shown) {
            const facts = [`${kind.count}x`, present(kind.format)].filter((f): f is string => f !== undefined).join(", ");
            lines.push(`- ${kind.name} (${facts}) — ${clip(kind.memberRepresents, MAX_KIND_DESCRIPTION_CHARS)}`);
        }
        const axes = result.axes ?? [];
        if (axes.length > 0) {
            lines.push(`Axes: ${axes.map((axis) => `${axis.label} (${axis.cardinality})`).join(", ")}`);
        }
        if (result.coverage && result.coverage.unmatched > 0) {
            lines.push(`Coverage: ${result.coverage.matched} of ${result.coverage.total} files match a kind`);
        }
    }

    if (result.files.length > 0) {
        const shown = result.files.slice(0, MAX_FILES);
        // With kinds present these are the individually notable files — the metadata
        // sheet, the README, the outlier — not a sample of the dataset.
        const label = kinds.length > 0 ? "Notable files" : "Files";
        const header = shown.length < result.files.length ? `${label} (${shown.length} of ${result.files.length}):` : `${label} (${result.files.length}):`;
        lines.push(header);
        for (const file of shown) {
            lines.push(`- ${toAnalysisRootPath(analysisId, file.path)} — ${clip(file.description, MAX_FILE_DESCRIPTION_CHARS)}${formatFileFacts(file)}`);
        }
    }

    return clamp(lines.join("\n"), maxChars);
}
