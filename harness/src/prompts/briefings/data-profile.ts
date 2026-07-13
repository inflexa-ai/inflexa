/**
 * Data-profile briefing — the first standing briefing of the main
 * conversation (see the conversation-briefings spec).
 *
 * `render` is pure over the persisted `DataProfileResult`: the content is the
 * profile summary block (the profiler's narrative summary plus the profiled
 * file list), and the caption summarizes the profile at a glance.
 *
 * The caption's middle facet is the set of distinct file formats present.
 * `DataProfileResult` persists only `{ path, description }` per file — the
 * richer profiler output (per-file `dataType`, domain/subtype) is not stored,
 * so the file formats derived from paths are the at-a-glance "kind" signal the
 * persisted shape can supply. `profiledAt` is the profile's version stamp: a
 * re-run produces a new one, and immutability means a thread keeps the version
 * it was briefed with.
 */

import type { DataProfileResult } from "../../state/data-profile.js";
import type { BriefingDefinition } from "./types.js";

export const DATA_PROFILE_BRIEFING_NAME = "data-profile";

/** Trailing extension of a path's basename, uppercased; `""` when there is none. */
function fileFormat(path: string): string {
    const base = path.slice(path.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(dot + 1).toUpperCase() : "";
}

/** Distinct file formats present, sorted — the caption's assay-kind facet. */
function distinctFormats(files: readonly { path: string }[]): string[] {
    const formats = new Set<string>();
    for (const f of files) {
        const format = fileFormat(f.path);
        if (format.length > 0) formats.add(format);
    }
    return [...formats].sort();
}

function renderContent(profile: DataProfileResult): string {
    const fileLines = profile.files.map((f) => `- ${f.path} — ${f.description}`).join("\n");
    return [`# Data profile`, ``, profile.summary.trim(), ``, `## Files`, fileLines].join("\n");
}

function renderCaption(profile: DataProfileResult): string {
    const count = profile.files.length;
    const formats = distinctFormats(profile.files);
    const kinds = formats.length > 0 ? formats.join(", ") : "unknown format";
    // Minute precision, not date-only: same-day re-runs must stay distinguishable
    // (a thread keeps the version it was briefed with; the caption is its provenance).
    const version = profile.profiledAt.slice(0, 16).replace("T", " ");
    return `${count} file${count === 1 ? "" : "s"} · ${kinds} · profiled ${version}`;
}

export const dataProfileBriefing: BriefingDefinition<DataProfileResult> = {
    name: DATA_PROFILE_BRIEFING_NAME,
    description: "The platform's automated profile of the analysis input data.",
    mode: "standing",
    render(profile) {
        return { content: renderContent(profile), caption: renderCaption(profile) };
    },
};
