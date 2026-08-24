/**
 * Data-profile orientation — the bounded projection of a persisted
 * `DataProfileResult` into the few hundred characters an agent needs to know
 * WHAT DATASET IT IS HOLDING before it does anything else.
 *
 * The persisted profile is deliberately rich because the DB row is its only durable
 * home — the profiler's scratch tree is deleted on completion. That richness is right
 * for a pull-on-demand tool (`inspect_data_profile`) and wrong for anything injected
 * unconditionally into a context window, which is what a step seed does. This is the
 * lossy half of that pair: a hard character budget, a fixed section order, and visible
 * truncation counts, so an agent that needs more knows to go pull it.
 *
 * Structure leads and prose follows. The census — kept files, groups, unclassified,
 * quarantined — rides in the header on a reserved budget, so no clamp can remove the one
 * line that says how much of the dataset the profile speaks for. Groups and dimensions
 * render before the design note and the caveats, and the caveats are capped both per item
 * and as a share of the whole rendering, so agent prose can never crowd out resolved
 * structure.
 *
 * A pure function over the record — no I/O, no LLM, no pipeline. It is the whole
 * mechanism.
 *
 * Every path it renders is projected into the frame-independent `/{analysisId}/…`
 * form. The record stores a path relative to the analysis root, which is the correct
 * form to store; but a step agent resolves a relative path against its own working
 * directory, thus the stored form names a file that does not exist there. The absolute
 * form resolves to the same file in every frame, including the conversation agent's, so
 * the projection is unconditional.
 */

import type { DataProfileResult } from "../state/data-profile.js";
import { toAnalysisRootPath } from "../workspace/paths.js";
import { profileCaveats, profileDimensions, profileFileRecords, profileGroups, type ProfileGroupView } from "./data-profile-view.js";

/** The character budget the projection guarantees it will not exceed. */
export const DATA_PROFILE_ORIENTATION_MAX_CHARS = 1200;

/** Files listed before the tail is elided (the count still reports the total). */
const MAX_FILES = 8;

/** Groups listed before the tail is elided. A dataset with more is described by its first few. */
const MAX_GROUPS = 6;

/** Dimensions named before the tail is elided. */
const MAX_DIMENSIONS = 8;

const MAX_GROUP_DESCRIPTION_CHARS = 90;

/** Caveats listed — the profiler orders them, so these are the top ones. */
const MAX_CAVEATS = 3;

/**
 * The share of the whole rendering agent-authored caveats may occupy.
 *
 * The per-item cap alone does not bound the section: three long caveats still displace
 * the groups a planner reads. Prose is what gets cut when the two compete.
 */
const CAVEAT_SHARE = 0.25;

/** The whole identity line's ceiling, so the census below it always fits under the budget. */
const MAX_IDENTITY_CHARS = 240;

const MAX_DESIGN_CHARS = 200;
const MAX_CAVEAT_CHARS = 120;
const MAX_FILE_DESCRIPTION_CHARS = 100;

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
function formatFileFacts(file: { rows?: number | null; cols?: number | null; format?: string }): string {
    const dims = typeof file.rows === "number" && typeof file.cols === "number" ? `${file.rows} x ${file.cols}` : undefined;
    const facts = [dims, present(file.format)].filter((f): f is string => f !== undefined);
    return facts.length > 0 ? ` (${facts.join(", ")})` : "";
}

/** What the dataset IS, or — on a snapshot carrying no structured identity — its summary. */
function identityLine(result: DataProfileResult): string {
    const identity = [
        [present(result.domain), present(result.subtype)].filter((f): f is string => f !== undefined).join(" / ") || undefined,
        formatOrganism(result.organism),
        present(result.tissue) ? `tissue: ${present(result.tissue)}` : undefined,
        present(result.cellType) ? `cells: ${present(result.cellType)}` : undefined,
        present(result.condition) ? `condition: ${present(result.condition)}` : undefined,
    ].filter((f): f is string => f !== undefined);

    return `Dataset: ${identity.length > 0 ? identity.join(" — ") : clip(result.summary, MAX_IDENTITY_CHARS)}`;
}

/**
 * The census: how much of the tree the profile speaks for, as a count rather than a
 * warning.
 *
 * A partition-era row states all four figures outright, so all four are rendered whether
 * or not any of them is zero — a census with a term omitted is a census a reader has to
 * guess at. An older row states what its era recorded and no more; one that states
 * nothing gets no census line, because inventing one would put a number behind a fact the
 * snapshot cannot support.
 */
function censusLine(result: DataProfileResult, groups: readonly ProfileGroupView[]): string | undefined {
    if (result.partition) {
        const { keptFiles, unclassifiedFiles, quarantine } = result.partition;
        return `Census: ${keptFiles} files in ${groups.length} groups · ${unclassifiedFiles} unclassified · ${quarantine.count} quarantined`;
    }
    if (result.coverage) {
        const unmatched = result.coverage.unmatched > 0 ? ` · ${result.coverage.unmatched} matching no kind` : "";
        return `Census: ${result.coverage.total} files in ${groups.length} groups${unmatched}`;
    }
    if (groups.length === 0) return undefined;
    return `Census: ${groups.reduce((sum, group) => sum + group.count, 0)} files in ${groups.length} groups`;
}

/**
 * Project a persisted profile into an orientation blurb of at most `maxChars`
 * characters. The bound is a guarantee, not a target: the assembled text is
 * hard-clamped, so no profile — however verbose — can blow a caller's budget.
 *
 * Section order is fixed: identity, census, groups, dimensions, experimental design,
 * caveats, and then the members the agent wrote about individually. The header holds its
 * own reserved budget, so the census survives whatever the body's clamp removes. Each
 * list section states its true total, so an elided tail is visible rather than silent.
 *
 * `analysisId` roots each rendered file path (see the module header). It is the
 * id of the analysis the profile belongs to, and it is what the sandbox mounts
 * the tree at.
 */
export function buildDataProfileOrientation(result: DataProfileResult, analysisId: string, maxChars: number = DATA_PROFILE_ORIENTATION_MAX_CHARS): string {
    const groups = profileGroups(result);
    const census = censusLine(result, groups);

    // The census is reserved out of the budget before the identity line is clipped into
    // what remains, so the one line saying how much of the dataset is accounted for
    // cannot be the line the final clamp drops.
    const identityBudget = Math.max(0, Math.min(MAX_IDENTITY_CHARS, maxChars - (census ? census.length + 1 : 0)));
    const header = [clamp(identityLine(result), identityBudget), census].filter((line): line is string => Boolean(line)).join("\n");
    const headerText = clamp(header, maxChars);
    const bodyBudget = maxChars - headerText.length - 1;
    if (bodyBudget <= 0) return headerText;

    const lines: string[] = [];

    if (groups.length > 0) {
        const shown = groups.slice(0, MAX_GROUPS);
        lines.push(shown.length < groups.length ? `Groups (${shown.length} of ${groups.length}):` : `Groups (${groups.length}):`);
        for (const group of shown) {
            const facts = [`${group.count}x`, present(group.format)].filter((f): f is string => f !== undefined).join(", ");
            lines.push(`- ${group.name} (${facts}) — ${clip(group.memberRepresents, MAX_GROUP_DESCRIPTION_CHARS)}`);
        }
    }

    // Every number an observation reported, side by side: observations that disagree both
    // stand, and picking one would be a judgement no consumer could see being made.
    const dimensions = profileDimensions(result);
    if (dimensions.length > 0) {
        const shown = dimensions.slice(0, MAX_DIMENSIONS);
        const more = dimensions.length > shown.length ? `, +${dimensions.length - shown.length} more` : "";
        lines.push(`Dimensions: ${shown.map((d) => `${d.label} (${d.cardinalities.join(" / ") || "unmeasured"})`).join(", ")}${more}`);
    }

    const design = present(result.experimentalDesign);
    if (design) lines.push(`Design: ${clip(design, MAX_DESIGN_CHARS)}`);

    const caveats = profileCaveats(result)
        .map((c) => present(c))
        .filter((c): c is string => c !== undefined);
    if (caveats.length > 0) {
        // Two caps, not one: the per-item cap keeps a single caveat from running away, and
        // the share cap keeps three of them from displacing the structure above.
        let budget = Math.floor(maxChars * CAVEAT_SHARE);
        const shown: string[] = [];
        for (const caveat of caveats.slice(0, MAX_CAVEATS)) {
            const text = clip(caveat, MAX_CAVEAT_CHARS);
            if (text.length > budget) break;
            budget -= text.length + 2;
            shown.push(text);
        }
        if (shown.length > 0) {
            const more = caveats.length > shown.length ? ` (+${caveats.length - shown.length} more)` : "";
            lines.push(`Caveats: ${shown.join("; ")}${more}`);
        }
    }

    // The members the agent wrote about individually — the metadata sheet, the README, the
    // outlier — never a sample of the dataset, which the groups above already account for.
    const files = profileFileRecords(result);
    if (files.length > 0) {
        const shown = files.slice(0, MAX_FILES);
        const label = groups.length > 0 ? "Notable files" : "Files";
        lines.push(shown.length < files.length ? `${label} (${shown.length} of ${files.length}):` : `${label} (${files.length}):`);
        for (const file of shown) {
            lines.push(`- ${toAnalysisRootPath(analysisId, file.path)} — ${clip(file.description, MAX_FILE_DESCRIPTION_CHARS)}${formatFileFacts(file)}`);
        }
    }

    const body = clamp(lines.join("\n"), bodyBudget);
    return body ? `${headerText}\n${body}` : headerText;
}
