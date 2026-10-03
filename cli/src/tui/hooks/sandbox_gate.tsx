import { createSignal, onCleanup } from "solid-js";
import type { ResultAsync } from "neverthrow";

import type { PendingAddView, StoreFlightView, StoreState, TransferReportView, TransferStartKind } from "../../api/store.ts";
import { describeClientError, type ClientError } from "../../client/api.ts";
import type { SandboxReadiness } from "../../api/runs.ts";
import { fetchSandboxReadiness } from "../../client/runs.ts";
import { createTransfer, fetchStore } from "../../client/store.ts";
import { GLYPHS } from "../../lib/design_system.ts";
import type { Notice } from "../theme.ts";
import { notify } from "./notice.ts";

// The sandbox prerequisite gate, held here (not inside `app.tsx`) so the holder of the state is
// decoupled from its callers. It has two jobs. It publishes the lifecycle of the three detached
// transfers, which the sidebar renders as one row per live transfer: a poll of `GET /api/v1/store`.
// And it holds each sandbox-making action (`awaitSandboxReady`) while a transfer is live, refusing a
// terminal state with the retry command.
//
// The gate STARTS NO TRANSFER and OPENS NO CONSENT (the package-store-transfers spec). `inflexa
// setup`, `inflexa sandbox pull`, and `inflexa store download` start the children, and each owns its
// consent. The gate is a reader: it reads the rows, it reports the state, and it names the retry
// command. The deliberate retry surfaces — the sidebar key and the command palette — route through
// {@link retryTerminalTransfers}, which is a user action and not the gate.
//
// The FILESYSTEM decides usability, never a row. A store root that `inflexa store add` built carries
// no catalog receipt and is completely usable; a row that reports `installed` over an absent store
// keeps the refusal. The rows supply the reason for a hold and the progress the hold reports.

/** One acquisition flight as the sidebar renders it: a live one, or a terminal `failed` record. */
export type StoreFlightLine = StoreFlightView;

/** One enqueued add that no flush took yet, as the pipeline section renders it. */
export type PendingAddLine = Pick<PendingAddView, "spec">;

const [transfers, setTransfers] = createSignal<readonly TransferReportView[]>([]);
const [flights, setFlights] = createSignal<readonly StoreFlightLine[]>([]);
const [pendingAdds, setPendingAdds] = createSignal<readonly PendingAddLine[]>([]);

/** The three transfer reports as last read — call inside a tracking scope for reactivity. */
export const transferReports = transfers;

/** The acquisition flights, live and failed — call inside a tracking scope for reactivity. */
export const storeFlightLines = flights;

/** The pending adds that no flush took yet — call inside a tracking scope for reactivity. */
export const pendingAddLines = pendingAdds;

/**
 * How often the watcher and the gate read the store again.
 *
 * The writers are the detached children of the server, so a read is the only way this client learns
 * that a transfer moved. The server reads a point lookup against a WAL database, thus the read never
 * blocks a writer and it costs nothing measurable at this cadence.
 */
const TRANSFER_POLL_MS = 2000;

/** The effects the gate operates. Production passes {@link realSandboxGateSeams}; a test injects stubs. */
export type SandboxGateSeams = {
    /** The transfers, the flights, and the pending adds. Real: `GET /api/v1/store`. */
    readonly readStore: () => ResultAsync<StoreState, ClientError>;
    /**
     * The verdict of the machine for a sandbox of the analysis: the image, the store content, and the
     * farm. The read CONSUMES a recorded farm-composition failure. Real: `GET {A}/sandbox-readiness`.
     */
    readonly readiness: (analysisId: string) => ResultAsync<SandboxReadiness, ClientError>;
    /** Raise a transient toast. Real: {@link notify}. */
    readonly notify: (notice: Notice) => void;
    /**
     * How long the hold waits between two reads of the rows. A seam because it is a real delay, and a
     * test that must observe several polls cannot spend the production cadence on each of them.
     */
    readonly pollMs: number;
};

/** The first line of a multi-line message, so a hint with its remedy stays one toast line. */
function firstLine(text: string): string {
    return text.split("\n", 1)[0] ?? text;
}

/** The production seams: the real row reads, the engine image check, and the TUI feedback channel. */
export const realSandboxGateSeams: SandboxGateSeams = {
    readStore: () => fetchStore(),
    readiness: (analysisId) => fetchSandboxReadiness(analysisId),
    notify,
    pollMs: TRANSFER_POLL_MS,
};

/**
 * Refresh the three signals from `GET /api/v1/store`: the transfers, the flights, and the pending adds.
 * Gives the transfer reports, or the client error of a failed read. A failed read keeps the signals as
 * they were: the next poll reads again.
 */
export function refreshTransferState(
    seams: Pick<SandboxGateSeams, "readStore"> = realSandboxGateSeams,
): ResultAsync<readonly TransferReportView[], ClientError> {
    return seams.readStore().map((store) => {
        setTransfers(store.transfers);
        setFlights(store.flights);
        setPendingAdds(store.pendingAdds.map((entry) => ({ spec: entry.spec })));
        return store.transfers;
    });
}

/** One poll of the watcher: a failed read changes nothing, and the next poll reads again. */
async function pollTransferState(seams: Pick<SandboxGateSeams, "readStore">): Promise<void> {
    (await refreshTransferState(seams)).match(
        () => undefined,
        () => undefined,
    );
}

/**
 * Mirror the detached transfers into the gate signals, for the sidebar to render. Call ONCE from
 * `App`'s setup, inside its reactive owner.
 *
 * A poll and not a subscription, because the server has no notification stream: a transfer that
 * `inflexa store download` starts in another terminal must appear here without the user reopening the
 * app. The poll stays armed for the whole life of the screen.
 */
export function watchTransfers(seams: Pick<SandboxGateSeams, "readStore" | "pollMs"> = realSandboxGateSeams): void {
    void pollTransferState(seams);
    const timer = setInterval(() => void pollTransferState(seams), seams.pollMs);
    onCleanup(() => clearInterval(timer));
}

/** The human label of one transfer kind, as every surface renders it. */
export function transferLabel(kind: TransferReportView["kind"]): string {
    switch (kind) {
        case "runtime_image":
            return "runtime image";
        case "provisioner_image":
            return "provisioner image";
        case "catalog":
            return "catalog";
        default: {
            const unreachable: never = kind;
            throw new Error(`unhandled transfer kind: ${JSON.stringify(unreachable)}`);
        }
    }
}

/** The retry command of one transfer kind, named in each refusal. */
function retryCommand(kind: TransferReportView["kind"]): string {
    return kind === "catalog" ? "`inflexa store download`" : "`inflexa sandbox pull`";
}

// The in-flight wait, so two concurrent sandbox actions share one hold rather than each polling the
// rows on its own. The check-and-set below has no await between the read and the write, so two
// concurrent callers cannot both start a wait.
let gateFlowInflight: Promise<"ready" | "blocked"> | null = null;

/**
 * Hold the caller while any transfer is live, then decide against the machine.
 *
 * The wait ends when the transfers end, and that bound is structural rather than a timeout: each child
 * holds its lock for its whole life, thus a process a user killed frees the lock and the next read
 * degrades its `running` row to `failed`. The gate therefore never holds without end.
 *
 * After the wait, the decision reads the MACHINE: a terminal transfer state refuses with the retry
 * command, an absent image refuses with the pull, an unusable store refuses with the download, and a
 * recorded farm-composition failure refuses with its reason. The gate starts nothing and opens no
 * consent in any branch.
 */
async function runGateFlow(analysisId: string, seams: SandboxGateSeams): Promise<"ready" | "blocked"> {
    let announced = false;
    let reports: readonly TransferReportView[];
    for (;;) {
        const read = await refreshTransferState(seams);
        if (read.isErr()) {
            seams.notify({ kind: "error", text: describeClientError(read.error) });
            return "blocked";
        }
        reports = read.value;
        const live = reports.filter((report) => report.live);
        if (live.length === 0) break;
        // A live CATALOG transfer over a store that cannot serve yet is the
        // between-consent-and-landing state of a farm-less analysis. Its landing
        // is a multi-gigabyte download, and that is not a wait a launch can
        // hold. The refusal classifies the state the way the launch refusal
        // classifies a pool miss: in flight, launch again when it lands. A
        // catalog UPDATE over a usable store keeps the wait, because the merge
        // into the store root is the hazard the hold exists for.
        if (live.some((report) => report.kind === "catalog")) {
            const machine = await seams.readiness(analysisId);
            if (machine.isErr()) {
                seams.notify({ kind: "error", text: describeClientError(machine.error) });
                return "blocked";
            }
            const content = machine.value.store;
            if (content !== "installed" && content !== "local") {
                seams.notify({ kind: "error", text: "The package-store catalog transfer is in flight. Launch again when it lands." });
                return "blocked";
            }
        }
        if (!announced) {
            announced = true;
            seams.notify({
                kind: "info",
                text: `Waiting for ${live.map((report) => `the ${transferLabel(report.kind)} transfer`).join(" and ")}${GLYPHS.ellipsis}`,
            });
        }
        await Promise.sleep(seams.pollMs);
    }

    // One read of the machine after the wait: the image, the store, and the farm.
    const machine = await seams.readiness(analysisId);
    if (machine.isErr()) {
        seams.notify({ kind: "error", text: describeClientError(machine.error) });
        return "blocked";
    }

    // The image half. The engine is the truth of presence; the row of the kind
    // supplies the reason when it is absent.
    const image = machine.value.image.image;
    const readiness = machine.value.image;
    if (readiness.state === "engine_error") {
        seams.notify({ kind: "error", text: readiness.message });
        return "blocked";
    }
    if (readiness.state === "custom") {
        seams.notify({
            kind: "error",
            text: `Sandbox image "${image}" is not present, and it is not the published image, thus no registry can supply it. Build it, or set the published image and run \`inflexa sandbox pull\`.`,
        });
        return "blocked";
    }
    if (readiness.state === "absent") {
        const report = reports.find((entry) => entry.kind === "runtime_image");
        const detail = report?.state === "failed" && report.row?.message ? ` ${firstLine(report.row.message)}` : "";
        seams.notify({ kind: "error", text: `The sandbox image is not installed.${detail} Run ${retryCommand("runtime_image")} to download it.` });
        return "blocked";
    }

    // The store half. The filesystem decides: `installed` is a downloaded
    // catalog, and `local` is a store that `inflexa store add` built — both
    // mount. The catalog row supplies the reason for the rest.
    const content = machine.value.store;
    if (content !== "installed" && content !== "local") {
        const report = reports.find((entry) => entry.kind === "catalog");
        const detail = report?.state === "failed" && report.row?.message ? ` ${firstLine(report.row.message)}` : "";
        const reason =
            report?.state === "declined"
                ? "The package store was declined at setup, and the analysis sandbox needs it."
                : report?.state === "canceled"
                  ? "You stopped the package-store download, and the analysis sandbox needs it."
                  : `The package store is ${content === "missing" ? "not installed" : "incomplete"}.${detail}`;
        seams.notify({ kind: "error", text: `${reason} Run ${retryCommand("catalog")} to obtain it.` });
        return "blocked";
    }

    // The farm half. Composition runs INSIDE the farm provider that the harness
    // calls, thus it runs after this gate decided and its error reaches no user
    // surface of its own. The read CONSUMES the record, thus the action after
    // this one composes again.
    const failure = machine.value.farm.failure;
    if (failure !== null) {
        seams.notify({
            kind: "error",
            text: `The package farm of this analysis could not be composed: ${failure}. Run \`inflexa store ls\` to see the store, then try again.`,
        });
        return "blocked";
    }

    return "ready";
}

/**
 * Hold a sandbox-making action of one analysis until the transfers settle and the machine can serve one.
 * Returns `ready` when a sandbox may start, or `blocked` otherwise — the gate reports the reason as it
 * decides, so a `blocked` caller starts no sandbox against an empty store.
 */
export async function awaitSandboxReady(analysisId: string, seams: SandboxGateSeams = realSandboxGateSeams): Promise<"ready" | "blocked"> {
    if (gateFlowInflight !== null) return gateFlowInflight;
    gateFlowInflight = runGateFlow(analysisId, seams).finally(() => {
        gateFlowInflight = null;
    });
    return gateFlowInflight;
}

/**
 * Retry every transfer that sits in a terminal failure state — the deliberate action behind the
 * sidebar key and the command palette entries. This is a USER action, not the gate: the gate itself
 * starts nothing. Gives the count of the children that the server started.
 */
export async function retryTerminalTransfers(start: (kind: TransferStartKind) => ResultAsync<number, ClientError> = startTransfers): Promise<number> {
    let started = 0;
    for (const report of transfers()) {
        if (report.state !== "failed" && report.state !== "declined" && report.state !== "canceled") continue;
        started += (await start(report.kind)).unwrapOr(0);
    }
    await pollTransferState(realSandboxGateSeams);
    return started;
}

/** `POST /api/v1/store/transfers` for one kind: the count of the children that the server started. */
function startTransfers(kind: TransferStartKind): ResultAsync<number, ClientError> {
    return createTransfer({ kind }).map((response) => response.starts.filter((start) => start.outcome === "started").length);
}

/** Test hook: publish transfer reports directly, with no server. Test-only. */
export function __setTransferReportsForTest(next: readonly TransferReportView[]): void {
    setTransfers(next);
}

/** Test hook: publish a set of live flights directly, with no server. Test-only. */
export function __setStoreFlightLinesForTest(next: readonly StoreFlightLine[]): void {
    setFlights(next);
}

/** Test hook: publish a set of pending adds directly, with no server. Test-only. */
export function __setPendingAddLinesForTest(next: readonly PendingAddLine[]): void {
    setPendingAdds(next);
}

/** Test hook: drop the signals and the in-flight flow back to idle. Test-only. */
export function __resetSandboxGateForTest(): void {
    gateFlowInflight = null;
    setTransfers([]);
    setFlights([]);
    setPendingAdds([]);
}
