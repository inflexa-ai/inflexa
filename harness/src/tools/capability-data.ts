/**
 * inspectCapabilityData — the reference data a specialist capability cannot run without, and
 * whether this store holds it.
 *
 * The method of a capability lives in a skill pack, and only a sandbox step agent reads a skill.
 * Thus a conversation or planning surface knows a capability by its phrase alone, and it cannot
 * name the datasets the method needs. It then does one of two wrong things: it calls the work
 * impossible, or it designs a method around what it can see and substitutes for what it cannot.
 *
 * The declaration on the agent metadata is the one place a surface above the step can read, and
 * this tool is how it reads it. The answer names an absent dataset by its CATALOG ID, because the
 * id is what an install takes — a surface that can provision needs the identifier, not a
 * description. Where the ids reach an agent matters: a prompt names no dataset, so the knowledge
 * arrives through a tool, which carries its own description into the context at attach time.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { declaredDataRequirements } from "../agents/sandbox-catalog.js";
import type { EnvironmentStorePaths } from "../config/environment-stores.js";
import { defineTool, type ToolError } from "./define-tool.js";
import { readInstalledDatasetIds } from "./sandbox/list-available-refs.js";

export type InspectCapabilityDataDeps = Pick<EnvironmentStorePaths, "refStorePath">;

/** One capability, its declared datasets, and what the store holds of them. */
export interface CapabilityDataRow {
    readonly agentId: string;
    readonly capability: string;
    readonly installed: readonly string[];
    readonly absent: readonly string[];
}

export interface CapabilityDataResult {
    /** False when the store could not be answered for: every `absent` list is then unknown, not empty. */
    readonly storeReadable: boolean;
    readonly rows: readonly CapabilityDataRow[];
    readonly content: string;
}

const NO_DECLARATIONS = "No capability of this install declares reference data that it cannot run without.";

const STORE_UNREADABLE =
    "The reference store could not be read, so whether these datasets are installed is UNKNOWN — not absent. " +
    "Say that, and do not offer to install a dataset on this answer alone.";

function renderRows(rows: readonly CapabilityDataRow[], storeReadable: boolean): string {
    if (rows.length === 0) return NO_DECLARATIONS;
    const lines = rows.map((row) => {
        const state = storeReadable
            ? [row.absent.length > 0 ? `absent: ${row.absent.join(", ")}` : null, row.installed.length > 0 ? `installed: ${row.installed.join(", ")}` : null]
                  .filter((part): part is string => part !== null)
                  .join(" | ")
            : `declared: ${[...row.installed, ...row.absent].sort().join(", ")}`;
        return `- ${row.agentId} — "${row.capability}"\n  ${state}`;
    });
    const header = storeReadable
        ? "Reference data a capability cannot run without, and what this store holds. An absent id is what an install takes."
        : `Reference data a capability cannot run without. ${STORE_UNREADABLE}`;
    return [header, "", ...lines].join("\n");
}

/**
 * Build the tool. The store read happens per call, not at construction: a dataset installed during
 * the conversation must show as installed on the next call, and a cached answer would have the
 * agent offer a download the user already approved.
 */
export function createInspectCapabilityDataTool(deps: InspectCapabilityDataDeps = {}) {
    return defineTool({
        id: "inspect_capability_data",
        description:
            "The reference data a specialist capability cannot run without, and whether this install holds it. " +
            "Call it BEFORE you design a method yourself, and before you tell the user that something cannot be done — a capability whose data is absent is one install away, not impossible, and this is the only place that names WHICH datasets. " +
            "Each entry names a catalog dataset id, which is exactly what an install takes; a surface with a way to provision can act on it directly. " +
            "It takes no arguments and the whole set is small, so one call is the complete answer. " +
            "An unreadable store answers UNKNOWN rather than absent, so a store that cannot be read never reads as a store that holds nothing.",
        inputSchema: z.object({}),
        describeCall: () => "declared capability data",
        execute: async (): Promise<Result<CapabilityDataResult, ToolError>> => {
            const declared = declaredDataRequirements();
            if (declared.length === 0) return ok({ storeReadable: true, rows: [], content: NO_DECLARATIONS });
            const installedIds = await readInstalledDatasetIds(deps);
            const storeReadable = installedIds !== undefined;
            const rows = declared.map((requirement) => {
                const datasets = [...requirement.datasets].sort();
                return {
                    agentId: requirement.agentId,
                    capability: requirement.capability,
                    installed: installedIds === undefined ? [] : datasets.filter((dataset) => installedIds.has(dataset)),
                    absent: installedIds === undefined ? datasets : datasets.filter((dataset) => !installedIds.has(dataset)),
                };
            });
            return ok({ storeReadable, rows, content: renderRows(rows, storeReadable) });
        },
    });
}
