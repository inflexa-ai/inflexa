import { createEffect, on } from "solid-js";
import type { ResultAsync } from "neverthrow";

import type { FarmHealResult } from "../../api/runs.ts";
import { describeClientError, type ClientError } from "../../client/api.ts";
import { healFarm } from "../../client/runs.ts";
import { createTransfer } from "../../client/store.ts";
import { ConfirmDialog } from "../components/dialog/confirm_dialog.tsx";
import type { Workspace } from "../contexts/workspace.ts";
import type { Notice } from "../theme.ts";
import { notify } from "./notice.ts";
import { refreshTransferState, transferReports } from "./sandbox_gate.tsx";

// The full-farm heal of a pre-release analysis (the package-store-management
// spec). Creation makes the farm WITH the analysis, thus a missing farm is the
// pre-release discriminator, and the state itself is the schedule: no repair
// queue exists beside it. This hook runs the heal at the two triggers the open
// session owns — the analysis open, and the catalog landing that the transfer
// poll observes. The farm resolution of a sandbox stays the backstop, inside
// `resolveAnalysisFarm`.
//
// The open with NO catalog and NO live transfer prompts for the download, with
// one consent. The prompt is the consent of the transfer, thus the started
// child asks nothing again. Between the consent and the landing, the analysis
// stays farm-less, and the sandbox gate refuses a launch with the classified
// live-transfer reason.

/** The effects the heal triggers operate. Production passes {@link realFarmHealSeams}; a test injects stubs. */
export type FarmHealSeams = {
    /**
     * Compose the farm of the analysis from the catalog closure when the farm is missing and the catalog
     * is present. Real: `POST {A}/farm/heal`.
     */
    readonly heal: (analysisId: string) => ResultAsync<FarmHealResult, ClientError>;
    /** Whether a catalog transfer runs right now, from the last poll read. */
    readonly liveCatalogTransfer: () => boolean;
    /** Open the one-consent download prompt. The answer callback runs once. */
    readonly confirmDownload: (onAnswer: (yes: boolean) => void) => void;
    /** Start the detached catalog transfer. The prompt above carried the consent. */
    readonly startDownload: () => Promise<void>;
    /** Raise a transient toast. Real: {@link notify}. */
    readonly notify: (notice: Notice) => void;
};

/** Build the production seams over one workspace, whose dialog stack hosts the prompt. */
export function realFarmHealSeams(ws: Workspace): FarmHealSeams {
    return {
        heal: (analysisId) => healFarm(analysisId),
        liveCatalogTransfer: () => transferReports().some((report) => report.kind === "catalog" && report.live),
        confirmDownload: (onAnswer) => {
            ws.openDialog(() => (
                <ConfirmDialog
                    title="Download the package store"
                    message={
                        "This analysis was made before the package store existed, and its packages come from the store now. " +
                        "Download the package store to give the analysis its packages again?"
                    }
                    defaultActive="confirm"
                    onConfirm={() => {
                        ws.closeDialog();
                        onAnswer(true);
                    }}
                    onCancel={() => {
                        ws.closeDialog();
                        onAnswer(false);
                    }}
                />
            ));
        },
        startDownload: async () => {
            const outcome = await createTransfer({ kind: "catalog", update: false });
            const failure = outcome.match(
                (response) => {
                    const start = response.starts[0];
                    return start?.outcome === "failed" ? start.message : null;
                },
                (error) => describeClientError(error),
            );
            if (failure !== null) {
                notify({ kind: "error", text: `The package-store download could not start: ${failure} Run \`inflexa store download\`.` });
                return;
            }
            (await refreshTransferState()).match(
                () => undefined,
                () => undefined,
            );
        },
        notify,
    };
}

/**
 * The analyses this process asked already. One consent for each analysis: a
 * declined prompt does not come again in this session, and the launch gate
 * carries the refusal instead.
 */
const prompted = new Set<string>();

/** Run the heal decision for the open analysis. Idempotent: a present farm returns at once. */
async function healOpenAnalysis(ws: Workspace, seams: FarmHealSeams): Promise<void> {
    const analysis = ws.analysis;
    if (analysis === null) return;
    const healed = await seams.heal(analysis.id);
    if (healed.isErr()) {
        seams.notify({ kind: "error", text: `The package farm of this analysis could not be checked: ${describeClientError(healed.error)}` });
        return;
    }
    const outcome = healed.value.outcome;
    switch (outcome.kind) {
        case "already_present":
            return;
        case "composed":
            seams.notify({ kind: "info", text: `The package farm of this analysis was composed from the catalog (${outcome.packages} packages).` });
            return;
        case "failed":
            seams.notify({ kind: "error", text: `The package farm of this analysis could not be composed: ${outcome.reason}.` });
            return;
        case "no_catalog":
            break;
        default: {
            const unreachable: never = outcome;
            throw new Error(`unhandled farm heal outcome: ${JSON.stringify(unreachable)}`);
        }
    }
    // A live transfer already carries the landing: the poll edge heals then.
    if (seams.liveCatalogTransfer()) return;
    if (prompted.has(analysis.id)) return;
    prompted.add(analysis.id);
    seams.confirmDownload((yes) => {
        if (yes) void seams.startDownload();
    });
}

/**
 * Arm the two heal triggers of the open session. Call ONCE from `App`'s setup,
 * inside its reactive owner, beside `watchTransfers`.
 */
export function watchFarmHeal(ws: Workspace, seams: FarmHealSeams = realFarmHealSeams(ws)): void {
    // Edge 1 — the analysis open, which covers the launch open and the in-place swap.
    createEffect(
        on(
            () => ws.analysis?.id ?? null,
            (analysisId) => {
                if (analysisId !== null) void healOpenAnalysis(ws, seams);
            },
        ),
    );

    // Edge 2 — the catalog landing, observed through the transfer poll of this
    // session. The rows are the only channel from the detached child, thus the
    // signal edge live-then-installed IS the landing.
    let catalogWasLive = false;
    createEffect(() => {
        const catalog = transferReports().find((report) => report.kind === "catalog");
        const liveNow = catalog !== undefined && catalog.live;
        if (catalogWasLive && !liveNow && catalog?.state === "installed") void healOpenAnalysis(ws, seams);
        catalogWasLive = liveNow;
    });
}

/** Test hook: drop the one-consent record, so each test starts unasked. Test-only. */
export function __resetFarmHealForTest(): void {
    prompted.clear();
}
