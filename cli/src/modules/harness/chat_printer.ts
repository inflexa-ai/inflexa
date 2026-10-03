import { basename, dirname } from "node:path";

import type { EventSource, FileReferencePart, PlanPart, PresentationPart } from "@inflexa-ai/harness";
import type { ChatFrame } from "@inflexa-ai/harness/contracts/index.js";

import type { OpenableEntry, PlanCardStepView, PresentationBody } from "../../types/session.ts";

// The readers that turn one chat frame, or one harness part, into the primitives a surface renders.
//
// Two surfaces consume them, and that is the whole reason they sit here rather than inside either
// one: the TUI (the conversation store `tui/hooks/conversation.ts` and its renderer
// `tui/layout/message_block.tsx`, which reads a stored plan card through `readPlanCard`) and the dev
// REPL printer (`dev/chat.ts`). Both must narrate the same stream the same way — a plan card the TUI reads
// as three steps and the REPL reads as two would be a difference with no cause behind it — so every
// reader with two consumers lives here and neither surface re-derives it.
//
// A reader with ONE consumer stays with that consumer instead, per the single-caller rule of
// `cli/CLAUDE.md`. `eventDepth` (`tui/hooks/conversation.ts`) is the case to know about: it repeats
// the `source` presence read of `eventSource` below, because exporting a private helper for one
// outside caller widens this surface for less than the repeat costs. A change to `EventSource`
// touches that function too.
//
// Every reader COPIES what it keeps, thus the view of a surface never shares a reference with a frame.
//
// The frame readers read a frame of the chat stream of the server. The part reader takes a part that
// `checkChatPart` validated where the part arrived, thus it reads each field as the type gives it.

/** Extract the `EventSource` a frame carries, if any — a part frame can have none. */
function eventSource(frame: ChatFrame): EventSource | undefined {
    return frame.source;
}

/**
 * True when `frame` originates from a SUB-AGENT loop (planner, literature
 * reviewer) — its `source.callPath` is deeper than the top-level agent — so the
 * transcript drops it (the same depth filter the managed SSE route applies). The
 * top-level chat agent's `callPath` has length 1; anything longer is sub-agent
 * traffic. A frame without a `source` is never sub-agent, so it always passes.
 * Exported so the TUI adapter shares this exact ruleset instead of re-deriving
 * it. `callPath` arrives over the wire, so it is guarded with `Array.isArray` — a
 * malformed source lacking the array is treated as top-level rather than throwing.
 */
export function isSubAgentEvent(frame: ChatFrame): boolean {
    const src = eventSource(frame);
    return src !== undefined && Array.isArray(src.callPath) && src.callPath.length > 1;
}

/**
 * A short human phrase for what a sub-agent frame says its emitter is doing, or `null` for a frame
 * that describes no activity (a data part, a text delta — prose the sub-agent is writing for its own
 * caller, not a description of work). The stream gives no frame for an `iteration` of the loop, thus
 * a sub-agent between two tool calls keeps the line of its last call.
 *
 * Shared by the REPL printer and the TUI reducer so the two narrate sub-agent work identically. The
 * agent id leads because a nested call chain is otherwise unattributable: `tool bash` alone does not
 * say who ran it.
 */
export function subAgentActivityLabel(frame: ChatFrame): string | null {
    const who = eventSource(frame)?.agentId ?? "sub-agent";
    switch (frame.type) {
        case "tool-started":
            return `${who}: ${frame.name}`;
        case "tool-finished":
            return `${who}: ${frame.name} done`;
        default:
            return null;
    }
}

/**
 * Map a plan card to the fields that a surface renders. The receipt check validated the part, thus each
 * field is read as the type gives it. An absent optional field reads as empty, and each array is copied,
 * thus the view holds no reference to the part. Exported so the TUI renderer and the REPL printer share
 * the mapping.
 */
export function readPlanCard(part: PlanPart): { planId: string; title: string; steps: PlanCardStepView[] } {
    return {
        planId: part.planId,
        title: part.title ?? "",
        steps: (part.steps ?? []).map((step) => ({
            id: step.id,
            name: step.name,
            agent: step.agent,
            question: step.question,
            acceptance_criteria: [...(step.acceptance_criteria ?? [])],
            constraints: [...(step.constraints ?? [])],
            caveats: [...(step.caveats ?? [])],
            depends_on: [...step.depends_on],
            resources:
                step.resources === undefined ? null : { cpu: step.resources.cpu, memoryGb: step.resources.memoryGb, gpuCount: step.resources.gpu?.count ?? 0 },
            track: step.track ?? "",
            step_type: step.step_type ?? "",
        })),
    };
}

/** Deep-copy an echart spec at receipt, thus no mutable loop reference survives. A spec that cannot be cloned reads as `{}`. */
function cloneSpec(spec: Record<string, unknown>): Record<string, unknown> {
    try {
        // A tool-input spec is JSON, thus the clone fails only on a value that no JSON holds.
        return structuredClone(spec);
    } catch {
        return {};
    }
}

/**
 * A `data-presentation` readout: text-shaped (`markdown`/`code`/`table`) becomes an inline body; the
 * pixel-shaped `echart`/`svg` become a single openable entry (materialized on open).
 */
export type PresentationReadout = { shape: "inline"; title?: string; body: PresentationBody } | { shape: "card"; title?: string; entry: OpenableEntry };

/**
 * Read a `show_user` presentation part. Text-shaped kinds map to an inline body; `echart`/`svg` map to
 * an openable entry carrying the embedded spec/markup + the deterministic `pres-` id. A `structure`
 * card has no renderer here, thus it degrades to an inline note that names its kind.
 */
export function readPresentation(part: PresentationPart): PresentationReadout {
    const title = part.title;
    const content = part.content;
    switch (content.kind) {
        case "markdown":
            return { shape: "inline", title, body: { kind: "markdown", body: content.body } };
        case "code":
            return { shape: "inline", title, body: { kind: "code", code: content.code, language: content.language } };
        case "table":
            return {
                shape: "inline",
                title,
                body: { kind: "table", headers: [...content.headers], rows: content.rows.map((row) => [...row]), caption: content.caption },
            };
        case "echart":
            // `dataPath` is resolved to `dataset.source` at open time. It is omitted from the target when
            // absent, thus a self-contained spec carries no empty key.
            return {
                shape: "card",
                title,
                entry: {
                    name: title ?? "Chart",
                    target: {
                        kind: "echart",
                        presId: part.id,
                        spec: cloneSpec(content.spec),
                        ...(content.dataPath !== undefined ? { dataPath: content.dataPath } : {}),
                    },
                },
            };
        case "svg":
            return {
                shape: "card",
                title,
                entry: { name: title ?? "Diagram", target: { kind: "svg", presId: part.id, markup: content.markup } },
            };
        case "structure":
            return { shape: "inline", title, body: { kind: "markdown", body: `_(unsupported presentation: ${content.kind})_` } };
        default: {
            const _exhaustive: never = content;
            return _exhaustive;
        }
    }
}

/** A `data-file-reference` readout: one entry per referenced file, plus the shared containing folder for a gallery. */
export type FileReferenceReadout = { title?: string; entries: OpenableEntry[]; folderPath?: string };

/**
 * Read a `show_file` part. Each file becomes an openable `workspace-file` entry; a multi-file gallery
 * also carries `folderPath` (the first file's directory) for the reveal-containing-folder affordance.
 */
export function readFileReference(part: FileReferencePart): FileReferenceReadout {
    const entries: OpenableEntry[] = part.files.map((file) => ({
        name: basename(file.path) || file.path,
        ...(file.caption !== undefined ? { caption: file.caption } : {}),
        target: { kind: "workspace-file", path: file.path },
    }));
    const firstPath = part.files[0]?.path ?? "";
    const dir = firstPath ? dirname(firstPath) : "";
    const folderPath = entries.length > 1 && dir && dir !== "." ? dir : undefined;
    return { title: part.title, entries, ...(folderPath !== undefined ? { folderPath } : {}) };
}
