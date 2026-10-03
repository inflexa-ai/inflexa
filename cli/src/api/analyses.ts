import type { ListEnvelope } from "./common.ts";
import type { ProjectView } from "./projects.ts";
import type { UsageTotals } from "./usage.ts";

/** An analysis on the wire. Timestamps are ISO 8601. */
export type AnalysisView = {
    id: string;
    createdAt: string;
    updatedAt: string;
    name: string;
    /** Unique within the anchor. It keys the workspace folder `<anchor>/.inflexa/analyses/<slug>`. */
    slug: string;
    anchorId: string;
    projectId: string | null;
};

/** An analysis of the list, with its folder and its recorded LLM usage. */
export type AnalysisSummary = AnalysisView & {
    /** The last known path of the anchor folder, not reconciled. `null` when the anchor row is gone. */
    anchorPath: string | null;
    /** Absent when the ledger read failed: a list with no figures is better than no list. */
    usage?: UsageTotals;
};

/** The body of `GET /api/v1/analyses`: newest first. */
export type AnalysisList = ListEnvelope<"analyses", AnalysisSummary>;

/** The home folder of an analysis. */
export type AnchorView = {
    id: string;
    /** The live path after the reconciliation of the request. `null` when the folder cannot be located. */
    path: string | null;
    /** The last known path, kept when the folder cannot be located. */
    cachedPath: string;
    /** `false` when the folder was not writable at its first sighting, thus it has no `.inflexa/id` marker. */
    markerWritten: boolean;
};

/**
 * Why the workspace folder of an analysis must not move or be retired now:
 *
 * - `chat_turn` — a chat turn of the analysis runs.
 * - `data_profile` — a data profile of the analysis is queued or runs.
 * - `run` — a run of the analysis has a live durable workflow.
 * - `run_state_unreadable` — the run ledger or the workflow status cannot be read, thus the folder cannot be shown idle.
 * - `profile_state_unreadable` — the data profile ledger cannot be read, thus the folder cannot be shown idle.
 */
export type BusyReason = "chat_turn" | "data_profile" | "run" | "run_state_unreadable" | "profile_state_unreadable";

/** The end of a sentence that starts "Cannot X while …", for each {@link BusyReason}. */
export function describeBusyReason(reason: BusyReason): string {
    switch (reason) {
        case "chat_turn":
            return "a chat turn is running";
        case "data_profile":
            return "a data profile is running";
        case "run":
            return "a run is in flight";
        case "run_state_unreadable":
            return "the run ledger is unreadable, so the workspace cannot be confirmed idle";
        case "profile_state_unreadable":
            return "the data profile ledger is unreadable, so the workspace cannot be confirmed idle";
        default: {
            const exhaustive: never = reason;
            throw new Error(`unhandled busy reason: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/** One analysis with its scope: the body of `GET {A}`, `POST /api/v1/analyses`, and `PATCH {A}`. */
export type AnalysisDetail = AnalysisView & {
    project: ProjectView | null;
    /** `null` when the anchor row is gone. */
    anchor: AnchorView | null;
    /** The workspace folder `<anchor>/.inflexa/analyses/<slug>`. `null` when the anchor folder cannot be located or is not writable. */
    outputDir: string | null;
    inputCount: number;
    /** Empty when the workspace folder can move. */
    busy: BusyReason[];
};

/** The body of `POST /api/v1/analyses`. The server validates the name. */
export type CreateAnalysisRequest = {
    name: string;
    /** The absolute path of the folder that becomes the anchor of the analysis. It must be writable. */
    folder: string;
    /** A project by id or by name. */
    project?: string;
    /** Absolute paths of the first inputs. */
    inputs?: string[];
};

/** The body of `PATCH {A}`. A rename gives 409 `busy` while work holds the workspace folder. */
export type UpdateAnalysisRequest = {
    name?: string;
    /** A project by id or by name, or `null` to clear the project. */
    project?: string | null;
};

/** The body of a `PATCH {A}` response. */
export type UpdateAnalysisResponse = AnalysisDetail & {
    /** Set when a rename could not move the workspace folder. The row has the new name, and the folder stays at `subdir` under the anchor. */
    workspaceNotMoved?: { subdir: string };
};

/** What `DELETE {A}` does with the workspace folder: `keep` moves it to `.inflexa/analyses_archived/`, `delete` removes it. */
export type WorkspaceDisposalMode = "keep" | "delete";

/** The provenance export that `DELETE {A}` writes into a kept workspace folder before it moves the folder. */
export type DeleteExportFormat = "none" | "prov-json" | "prov-n";

/** What happened to the workspace folder of a deleted analysis. `absent`: no folder existed, or its anchor folder is gone. */
export type WorkspaceDisposalView = { kind: "archived"; path: string } | { kind: "deleted"; path: string } | { kind: "absent" };

/**
 * The provenance export of a delete:
 *
 * - `none` — no export was asked for, or no workspace folder existed to hold one.
 * - `written` — the document and its attestation are in the kept folder.
 * - `written_unflushed` — written, but the recorder flush before it failed, thus the last activity can be missing.
 * - `failed` — nothing was written. The delete continued.
 */
export type DeleteExportOutcome = "none" | "written" | "written_unflushed" | "failed";

/** The body of a `DELETE {A}` response. */
export type DeleteAnalysisResponse = {
    deleted: true;
    workspace: WorkspaceDisposalView;
    export: DeleteExportOutcome;
};

/** The body of `POST /api/v1/analyses/resolve`. */
export type ResolveAnalysisRequest = {
    /** The absolute folder of the client. The anchor marker walk starts there. */
    cwd: string;
    /** An analysis by id or by name. It takes priority over `project` and `cwd`. */
    ref?: string;
    /** A project by id or by name: the candidates are its analyses. */
    project?: string;
    /** Reconcile each known anchor against `cwd` first, as a chat launch does. */
    recover?: boolean;
    /**
     * Record a sighting of the anchor folder that the resolve reaches (default `true`). A read command sends
     * `false`: a report is not a sighting, and an agent can run it unprompted.
     */
    touch?: boolean;
};

/** An analysis that shares the name of a reference, with the last known path of its anchor folder. */
export type AnalysisCandidate = AnalysisView & {
    /** `null` when the anchor row is gone. */
    anchorPath: string | null;
};

/**
 * What a folder or a reference resolves to. `describe` is the one-line context for a person.
 *
 * - `analysis` — one clear target. `others` holds the analyses that share the name of `ref`, newest first.
 * - `anchor` — a tracked folder with zero or more analyses, none of them a clear target.
 * - `pick` — candidates to pick from: the analyses of `project`, or the newest analyses when `ref` matched nothing.
 * - `copy` — the folder is a copy of a tracked folder. Repair or relocate it first.
 * - `empty` — no tracked folder at or above `cwd`.
 *
 * A candidate list holds at most the `MAX_PER_PAGE` newest analyses.
 */
export type ResolvedContextView =
    | { kind: "analysis"; describe: string; analysis: AnalysisView; anchorPath: string; others: AnalysisCandidate[] }
    | { kind: "anchor"; describe: string; anchorPath: string; analyses: AnalysisView[] }
    | { kind: "pick"; describe: string; analyses: AnalysisView[] }
    | { kind: "copy"; describe: string; cwd: string }
    | { kind: "empty"; describe: string; cwd: string };

/** The body of a `POST {A}/output-dir` response: the workspace folder, which exists after the call. */
export type OutputDirView = {
    path: string;
};

/** An input of an analysis. */
export type InputView = {
    /** The stored reference: relative to `anchorId` when it is set, else absolute. */
    path: string;
    isDir: boolean;
    /** The tracked folder that holds the input, or `null` for an input outside each tracked folder. */
    anchorId: string | null;
    /** The canonical absolute path. `null` when the anchor folder of the input cannot be located. */
    absolutePath: string | null;
};

/** The body of `GET {A}/inputs`. */
export type InputList = ListEnvelope<"inputs", InputView>;

/**
 * The body of `PUT {A}/inputs`, `POST {A}/inputs`, and `POST {A}/inputs/remove`. Each path of an add or of a
 * replacement is absolute. A path of a removal is absolute, or the stored `path` of an input.
 */
export type InputPathsRequest = {
    paths: string[];
};

/**
 * The body of an input change response. The server starts a new data profile after a change.
 *
 * A replacement keeps each input whose anchor folder cannot be located: the client could not show it, thus
 * the set that the client sent cannot hold it.
 */
export type InputsChange = {
    added: InputView[];
    removed: InputView[];
    /** The paths of a removal that match no input. */
    notInputs: string[];
};
