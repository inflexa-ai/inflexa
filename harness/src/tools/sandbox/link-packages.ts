/**
 * `link_packages` — a sandbox step asks for a package into the farm of its
 * analysis.
 *
 * The tool is one call over the farm-extension seam (`sandbox/types.ts`,
 * {@link ExtendAnalysisFarm}). A sandbox tool runs in the harness host process,
 * thus the call crosses no boundary: it starts no container, it opens no network
 * connection, and it asks the user for nothing.
 *
 * The seam links from the pool, and it acquires nothing. That limit is the whole
 * reason for the `description` of this tool. An agent that reads "packages" and
 * not "links" asks again for a package that will never arrive, and it burns a
 * step on each retry.
 *
 * The four outcome states carry the facts. This module composes the one
 * instruction that those facts warrant, because "report a collision and stop" is
 * a rule of the harness and not a policy of an embedder.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import type { ExtendAnalysisFarm, PackageRequest, PackageRequestOutcome } from "../../sandbox/types.js";
import { defineTool, type ToolError } from "../define-tool.js";

/**
 * A farm holds one version of one top-level name. Thus no retry of a request
 * that collides can succeed, and the step must hand the collision to a person.
 */
const COLLISION_NOTE =
    "A version collision is final: this environment holds one version of a name, so no retry of that request can succeed. " +
    "Report both store directories and stop.";

/** An acquisition is a host action, outside this run. */
const ABSENT_NOTE =
    "A package the store does not hold cannot arrive from inside this sandbox — adding one is a host action, outside this run. " +
    "Report it plainly and continue with what you do have.";

/** The mark that separates a wait from a dead end. */
const NO_ACQUISITION_NOTE = "One request names an ecosystem this store cannot acquire at all, so no retry and no later attempt will succeed.";

/** A bind reflects a new link at once. */
const READY_NOTE = "The linked packages are importable now — the mount reflects a new link immediately, so no restart is needed.";

/** The answer when a call names no package at all. */
const EMPTY_NOTE = "No package was named. Pass a module name in `imports`, or a package name in `distributions`.";

/** What the agent reads back: the outcome of each request, plus what to do next. */
export interface LinkPackagesResult {
    readonly outcomes: readonly PackageRequestOutcome[];
    /** The one instruction that these outcomes together warrant. */
    readonly message: string;
}

/** The seam plus the analysis whose farm this agent extends. */
export interface LinkPackagesDeps {
    readonly extendAnalysisFarm: ExtendAnalysisFarm;
    readonly analysisId: string;
}

const LinkPackagesInputSchema = z.object({
    distributions: z
        .array(z.string())
        .max(50)
        .optional()
        .describe('Package names, each with an optional exact version: "polars" takes the newest the store holds, "polars==1.2" takes that one or refuses.'),
    imports: z
        .array(z.string())
        .max(50)
        .optional()
        .describe('Module names taken verbatim from a failed import (e.g. "sklearn"). Each one resolves to the distribution that provides it.'),
});

/** Compose the instruction, from the state that binds hardest to the state that binds least. */
function composeMessage(outcomes: readonly PackageRequestOutcome[]): string {
    if (outcomes.length === 0) return EMPTY_NOTE;
    const notes: string[] = [];
    if (outcomes.some((outcome) => outcome.kind === "collision")) notes.push(COLLISION_NOTE);
    const absent = outcomes.filter((outcome): outcome is Extract<PackageRequestOutcome, { kind: "absent" }> => outcome.kind === "absent");
    if (absent.length > 0) notes.push(ABSENT_NOTE);
    if (absent.some((outcome) => !outcome.acquisitionPossible)) notes.push(NO_ACQUISITION_NOTE);
    if (outcomes.some((outcome) => outcome.kind === "linked" || outcome.kind === "present")) notes.push(READY_NOTE);
    return notes.join(" ");
}

/** Read the two input arrays into one ordered request list, distributions first. */
function toRequests(input: z.infer<typeof LinkPackagesInputSchema>): PackageRequest[] {
    const requests: PackageRequest[] = [];
    for (const raw of input.distributions ?? []) {
        const requirement = raw.trim();
        if (requirement) requests.push({ kind: "distribution", requirement });
    }
    for (const raw of input.imports ?? []) {
        const module = raw.trim();
        if (module) requests.push({ kind: "import", module });
    }
    return requests;
}

/**
 * Build `link_packages` over one bound seam. The composition root calls this only
 * when the embedder binds a realization, thus the tool never exists in a
 * deployment that cannot answer it.
 */
export function createLinkPackagesTool(deps: LinkPackagesDeps) {
    return defineTool({
        id: "link_packages",
        description:
            "Link a package the library store ALREADY HOLDS into this sandbox's environment, then import it. " +
            "It links what the host staged; it never installs, downloads, or acquires anything — there is no network, so a package the store does not hold cannot arrive this way. " +
            'Reach for it when an import fails for a package you expected to be there: `imports` takes the module name straight from the error ("sklearn") and resolves it to the distribution that provides it ("scikit-learn"), which is not the same string. ' +
            '`distributions` takes package names, optionally pinned: "polars" takes the newest version the store holds, "polars==1.2" takes that exact version or refuses. ' +
            "The link is live — the next import in this same sandbox resolves it, with no restart. " +
            "Each request comes back in one of four states: linked; already present; absent from the store (report it — adding one is a host action outside this run, and for an R package the store cannot acquire one at all, so no retry ever helps); " +
            "or a version collision (this environment already links a different version of that name — report both store directories and stop, because no retry can succeed). " +
            "This is not a substitute for `list_available_packages`, which is the cheap check for what is already staged.",
        inputSchema: LinkPackagesInputSchema,
        execute: async (input): Promise<Result<LinkPackagesResult, ToolError>> => {
            const requests = toRequests(input);
            if (requests.length === 0) return ok({ outcomes: [], message: EMPTY_NOTE });
            const outcomes = await deps.extendAnalysisFarm(deps.analysisId, requests);
            return ok({ outcomes, message: composeMessage(outcomes) });
        },
    });
}
