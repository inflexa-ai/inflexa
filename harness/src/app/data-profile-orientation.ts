/**
 * Data-profile orientation — the bounded projection of a persisted
 * `DataProfileResult` into what an agent needs to know WHAT DATASET IT IS HOLDING
 * before it does anything else.
 *
 * The persisted profile is deliberately rich because the DB row is its only durable
 * home — the profiler's scratch tree is deleted on completion. That richness is right
 * for a pull-on-demand tool (`inspect_data_profile`) and wrong for anything injected
 * unconditionally into a context window, which is what a step seed does. This is the
 * lossy half of that pair: a hard character budget, a fixed section order, and visible
 * truncation counts, so an agent that needs more knows to go pull it.
 *
 * What is lossy is the PROSE, not the structure. The submission schema bounds every array
 * an agent authors — operations, dimensions, annotations — so the resolved record is small
 * by construction, and a rendering that dropped half the groups to make room for a design
 * note would be discarding the addressable facts to keep the summary of them. Groups
 * therefore render one line each, all of them, each followed by the slots that vary across
 * its members; dimensions and notable files follow; and the design note and the caveats
 * take whatever budget is left. Groups are elided only when one line apiece already
 * overruns the whole budget, and then the count that did not fit is stated outright.
 *
 * The census — kept files, groups, unclassified, quarantined, and whether the scan reached
 * the whole tree — rides in the header on a reserved budget, so no clamp can remove the one
 * line that says how much of the dataset the profile speaks for.
 *
 * Every elision is marked. A section fitted short, a list tail dropped, a prose value
 * clamped: each ends the rendering with {@link ELISION_MARKER}, whose room is reserved
 * before anything else is fitted. A rendering that silently lost a section reads as a
 * profile that never had one.
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

import type { DataProfileDimension, DataProfileGroup, DataProfileGroupSlot } from "../contracts/data-profile.js";
import type { DataProfileResult } from "../state/data-profile.js";
import { toAnalysisRootPath } from "../workspace/paths.js";
import { profileCaveats, profileDimensions, profileFileRecords, profileGroups, type ProfileDimensionView, type ProfileGroupView } from "./data-profile-view.js";

/**
 * The character budget the projection guarantees it will not exceed.
 *
 * Sized from the record's own bounds rather than from a feel for how long a blurb should
 * be: the census header, a group line plus a slots line for each of a submission's worth of
 * groups, the dimension list, the notable files, and a prose tail. A profile past that
 * elides its group tail with a stated count — which is the honest outcome, and a far
 * cheaper one than a briefing that omits the groups an execution agent must address files
 * by.
 */
export const DATA_PROFILE_ORIENTATION_MAX_CHARS = 6000;

/** Notable files listed before the tail is elided (the count still reports the total). */
const MAX_FILES = 8;

/** The group name's ceiling — long enough to identify, short enough to keep the line one line. */
const MAX_GROUP_NAME_CHARS = 48;

const MAX_GROUP_DESCRIPTION_CHARS = 90;

/** Formats named in a group's census before the rest are counted rather than named. */
const MAX_GROUP_FORMATS = 3;

/** Slots named on a group's slots line before the rest are counted. */
const MAX_SLOTS_PER_LINE = 4;

/** A slot's values ride inline only while it is categorical enough for them to mean something. */
const MAX_INLINE_SLOT_VALUES = 4;

const MAX_SLOT_VALUE_CHARS = 24;
const MAX_DIMENSION_EXAMPLES = 3;

/** Caveats listed — the profiler orders them, so these are the top ones. */
const MAX_CAVEATS = 3;

/**
 * The share of the whole rendering agent-authored caveats may occupy.
 *
 * The per-item cap alone does not bound the section: three long caveats still displace
 * the structure a planner reads. Prose is what gets cut when the two compete.
 */
const CAVEAT_SHARE = 0.25;

/** The whole identity line's ceiling, so the census below it always fits under the budget. */
const MAX_IDENTITY_CHARS = 240;

const MAX_DESIGN_CHARS = 200;
const MAX_CAVEAT_CHARS = 120;
const MAX_FILE_DESCRIPTION_CHARS = 100;

/** Stated whenever the budget — not a per-section cap — cost the rendering something. */
const ELISION_MARKER = "… trimmed to fit";

/** Prose shortened below this states nothing; its section is dropped instead. */
const MIN_PROSE_CHARS = 24;

/**
 * Clamp to `max` chars, marking any elision with an ellipsis. Whitespace is left alone —
 * folding a multi-line value onto one line is `clip`'s job, not this one's.
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
        const { keptFiles, unclassifiedFiles, quarantine, scanTruncated } = result.partition;
        // A truncated walk makes every figure a figure over PART of the tree, so it rides the
        // census for the same reason the census itself does: it is the qualification a reader
        // must have before trusting any other number here, and no clamp may remove it.
        const partial = scanTruncated ? " · SCAN INCOMPLETE, counts cover part of the tree" : "";
        return `Census: ${keptFiles} files in ${groups.length} groups · ${unclassifiedFiles} unclassified · ${quarantine.count} quarantined${partial}`;
    }
    if (result.coverage) {
        const unmatched = result.coverage.unmatched > 0 ? ` · ${result.coverage.unmatched} matching no kind` : "";
        return `Census: ${result.coverage.total} files in ${groups.length} groups${unmatched}`;
    }
    if (groups.length === 0) return undefined;
    return `Census: ${groups.reduce((sum, group) => sum + group.count, 0)} files in ${groups.length} groups`;
}

/** What a block of lines costs once joined — its characters plus its separators. */
function costOf(block: readonly string[]): number {
    return block.reduce((sum, line) => sum + line.length, 0) + Math.max(0, block.length - 1);
}

/** The resolved records behind the era-independent views, for the facts only they carry. */
function byId<T extends { id: string }>(records: readonly T[] | undefined): Map<string, T> {
    return new Map((records ?? []).map((record) => [record.id, record]));
}

/** `VCF` for a single-format group, `VCF 40, TBI 40` for a mixed one. */
function formatCensus(view: ProfileGroupView, group: DataProfileGroup | undefined): string | undefined {
    const formats = (group?.formats ?? []).filter((entry) => present(entry.format) !== undefined);
    if (formats.length === 0) return present(view.format);
    if (formats.length === 1) return present(formats[0]!.format);
    const shown = formats.slice(0, MAX_GROUP_FORMATS).map((entry) => `${entry.format} ${entry.count}`);
    return `${shown.join(", ")}${formats.length > shown.length ? `, +${formats.length - shown.length}` : ""}`;
}

/** `name1 digits-fixed ×40` — where a slot sits, what it looks like, how far it runs. */
function renderSlot(slot: DataProfileGroupSlot): string {
    const where = slot.location === "directory" ? "dir" : "name";
    const inline =
        slot.distinctValues <= MAX_INLINE_SLOT_VALUES && slot.sampleValues.length > 0
            ? ` (${slot.sampleValues
                  .slice(0, MAX_INLINE_SLOT_VALUES)
                  .map((value) => clip(value, MAX_SLOT_VALUE_CHARS))
                  .join(", ")})`
            : "";
    return `${where}${slot.index} ${slot.tokenClass} ×${slot.distinctValues}${inline}`;
}

/**
 * The varying positions in a group's members, which is how an execution agent addresses
 * one of them.
 *
 * A single-member group's slot varies over nothing, so it is noise; every other slotted
 * group gets the line. A legacy row carries no slots and gets none.
 */
function slotsLine(group: DataProfileGroup | undefined, members: number): string | undefined {
    const slots = group?.slots ?? [];
    if (slots.length === 0 || (slots.length === 1 && members <= 1)) return undefined;
    const shown = slots.slice(0, MAX_SLOTS_PER_LINE).map(renderSlot);
    const more = slots.length > shown.length ? ` · +${slots.length - shown.length} more` : "";
    return `  slots: ${shown.join(" · ")}${more}`;
}

/** One group: what it is and how many, then the positions its members vary at. */
function groupEntry(view: ProfileGroupView, group: DataProfileGroup | undefined): readonly string[] {
    const facts = [`${view.count}x`, formatCensus(view, group), present(group?.categoryLabel ?? group?.category)]
        .filter((fact): fact is string => fact !== undefined)
        .join(", ");
    const line = `- ${clip(view.name, MAX_GROUP_NAME_CHARS)} (${facts}) — ${clip(view.memberRepresents, MAX_GROUP_DESCRIPTION_CHARS)}`;
    const slots = slotsLine(group, view.count);
    return slots ? [line, slots] : [line];
}

/**
 * Every group, one line each plus its slots.
 *
 * Groups are the addressable structure, so they are reserved ahead of everything the
 * budget might otherwise spend on prose. They elide only when one line apiece already
 * overruns the whole budget, and then the tail that did not fit is counted rather than
 * quietly absent.
 */
function groupsSection(entries: readonly (readonly string[])[], budget: number): { block: readonly string[]; dropped: number } {
    const head = `Groups (${entries.length}):`;
    for (let shown = entries.length; shown >= 0; shown--) {
        const dropped = entries.length - shown;
        const tail = dropped > 0 ? [`…and ${dropped} more group${dropped === 1 ? "" : "s"}`] : [];
        const block = [head, ...entries.slice(0, shown).flat(), ...tail];
        if (costOf(block) <= budget) return { block, dropped };
    }
    return { block: [], dropped: entries.length };
}

/**
 * A headed list rendered with as many entries as the budget holds. An entry is whole or
 * absent — a structural line cut mid-word states a fact that is not true — and the head
 * counts what survived against the true total. `dropped` reports the tail the budget cost,
 * over and above whatever the section's own cap already removed.
 */
function listSection(label: string, total: number, entries: readonly string[], budget: number): { block: readonly string[]; dropped: number } {
    for (let shown = entries.length; shown > 0; shown--) {
        const head = shown < total ? `${label} (${shown} of ${total}):` : `${label} (${total}):`;
        const block = [head, ...entries.slice(0, shown)];
        if (costOf(block) <= budget) return { block, dropped: entries.length - shown };
    }
    return { block: [], dropped: entries.length };
}

/**
 * One dimension: every number its observations reported, side by side.
 *
 * Observations that disagree both stand, and picking one would be a judgement no consumer
 * could see being made. A nesting relation rides along because it is what tells a planner
 * the two dimensions are not independent.
 */
function dimensionEntry(view: ProfileDimensionView, dimension: DataProfileDimension | undefined): string {
    const nests = dimension?.nestsUnder ? ` · nests under ${dimension.nestsUnder.dimension}` : "";
    const examples =
        view.exampleValues.length > 0
            ? ` · e.g. ${view.exampleValues
                  .slice(0, MAX_DIMENSION_EXAMPLES)
                  .map((value) => clip(value, MAX_SLOT_VALUE_CHARS))
                  .join(", ")}`
            : "";
    return `- ${view.label}: ${view.cardinalities.join(" / ") || "unmeasured"}${nests}${examples}`;
}

/** The caveats line: whole items while they fit, then one shortened item, then nothing. */
function caveatsSection(caveats: readonly string[], budget: number): string | undefined {
    const capped = caveats.slice(0, MAX_CAVEATS).map((caveat) => clip(caveat, MAX_CAVEAT_CHARS));
    const render = (texts: readonly string[]): string => {
        const more = caveats.length > texts.length ? ` (+${caveats.length - texts.length} more)` : "";
        return `Caveats: ${texts.join("; ")}${more}`;
    };
    for (let shown = capped.length; shown > 0; shown--) {
        const line = render(capped.slice(0, shown));
        if (line.length <= budget) return line;
    }
    const room = budget - render([""]).length;
    return room >= MIN_PROSE_CHARS ? render([clamp(capped[0]!, room)]) : undefined;
}

/** The body's lines, and whether the budget — rather than a per-section cap — cost anything. */
interface BodyDraft {
    readonly lines: readonly string[];
    readonly elided: boolean;
}

/**
 * Fit the body sections into `budget`, in order, each one whole or absent.
 *
 * The order is a priority: the resolved structure is reserved before the agent's prose, so
 * a verbose design note or a run of long caveats can only ever cost the sections below it,
 * and the prose is the only thing a clamp reaches in any profile whose structure fits.
 */
function composeBody(result: DataProfileResult, analysisId: string, groups: readonly ProfileGroupView[], budget: number, maxChars: number): BodyDraft {
    const lines: string[] = [];
    let elided = false;
    let used = 0;
    const room = (): number => budget - used - (lines.length > 0 ? 1 : 0);
    const push = (block: readonly string[]): void => {
        for (const line of block) {
            used += (lines.length > 0 ? 1 : 0) + line.length;
            lines.push(line);
        }
    };

    if (groups.length > 0) {
        const resolved = byId(result.groups);
        const section = groupsSection(
            groups.map((view) => groupEntry(view, resolved.get(view.id))),
            room(),
        );
        push(section.block);
        if (section.dropped > 0) elided = true;
    }

    const dimensions = profileDimensions(result);
    if (dimensions.length > 0) {
        const resolved = new Map((result.dimensions ?? []).map((dimension) => [dimension.label, dimension]));
        const entries = dimensions.map((view) => dimensionEntry(view, resolved.get(view.label)));
        const section = listSection("Dimensions", dimensions.length, entries, room());
        push(section.block);
        if (section.dropped > 0) elided = true;
    }

    // The members the agent wrote about individually — the metadata sheet, the README, the
    // outlier — never a sample of the dataset, which the groups above already account for.
    const files = profileFileRecords(result);
    if (files.length > 0) {
        const entries = files
            .slice(0, MAX_FILES)
            .map((file) => `- ${toAnalysisRootPath(analysisId, file.path)} — ${clip(file.description, MAX_FILE_DESCRIPTION_CHARS)}${formatFileFacts(file)}`);
        const section = listSection(groups.length > 0 ? "Notable files" : "Files", files.length, entries, room());
        push(section.block);
        if (section.dropped > 0) elided = true;
    }

    const design = present(result.experimentalDesign);
    if (design) {
        const text = clip(design, MAX_DESIGN_CHARS);
        const available = room() - "Design: ".length;
        if (available >= text.length) push([`Design: ${text}`]);
        else if (available >= MIN_PROSE_CHARS) {
            push([`Design: ${clamp(text, available)}`]);
            elided = true;
        } else elided = true;
    }

    const caveats = profileCaveats(result)
        .map((c) => present(c))
        .filter((c): c is string => c !== undefined);
    if (caveats.length > 0) {
        // Three caps, and only one of them is elision: the per-item and share caps are the
        // section's own and already report themselves through `(+N more)`, so the marker is
        // owed only for what the remaining room cost on top of them.
        const share = Math.floor(maxChars * CAVEAT_SHARE);
        const available = Math.min(share, room());
        const line = caveatsSection(caveats, available);
        if (line) push([line]);
        if (available < share && line !== caveatsSection(caveats, share)) elided = true;
    }

    return { lines, elided };
}

/**
 * Project a persisted profile into an orientation blurb of at most `maxChars`
 * characters. The bound is a guarantee, not a target: every section is fitted against the
 * remaining budget before it is rendered, so no profile — however verbose — can blow a
 * caller's budget, and nothing the budget removed leaves a half-line behind.
 *
 * Section order is fixed: identity, census, groups with their slots, dimensions, the
 * members the agent wrote about individually, the experimental design, then the caveats.
 * The header holds its own reserved budget, so the census survives whatever the body cannot
 * hold, and the prose sits last so that it — and not the structure — is what a clamp
 * reaches first. Each list section states its true total, and the trailing marker states
 * that the budget, rather than a per-section cap, is why something is missing.
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
    // cannot be the line the body's budget drops.
    const identityBudget = Math.max(0, Math.min(MAX_IDENTITY_CHARS, maxChars - (census ? census.length + 1 : 0)));
    const header = [clamp(identityLine(result), identityBudget), census].filter((line): line is string => Boolean(line)).join("\n");
    const headerText = clamp(header, maxChars);
    const bodyBudget = maxChars - headerText.length - 1;
    if (bodyBudget <= 0) return headerText;

    const draft = composeBody(result, analysisId, groups, bodyBudget, maxChars);
    if (!draft.elided) return draft.lines.length > 0 ? `${headerText}\n${draft.lines.join("\n")}` : headerText;

    // The marker's room is taken out of the budget first and the body re-fitted into what
    // is left, so declaring the elision can never be what overruns the bound.
    if (bodyBudget < ELISION_MARKER.length) return headerText;
    const trimmed = composeBody(result, analysisId, groups, bodyBudget - ELISION_MARKER.length - 1, maxChars);
    return `${headerText}\n${[...trimmed.lines, ELISION_MARKER].join("\n")}`;
}
