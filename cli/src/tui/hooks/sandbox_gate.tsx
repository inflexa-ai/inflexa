import { createSignal, onCleanup } from "solid-js";
import type { ResultAsync } from "neverthrow";

import type { PendingAddView, StoreFlightView, StoreState, TransferReportView, TransferStartKind } from "../../api/store.ts";
import { describeClientError, type ClientError } from "../../client/api.ts";
import { createTransfer, fetchStore } from "../../client/store.ts";
import { GLYPHS } from "../../lib/design_system.ts";
import type { Notice } from "../theme.ts";
import { notify } from "./notice.ts";

// The transfer state of the TUI, held here (not inside `app.tsx`) so the holder of the state is
// decoupled from its callers. It has two jobs. It publishes the lifecycle of the three detached
// transfers, which the sidebar renders as one row per live transfer: a poll of `GET /api/v1/store`.
// And it holds each profile drive (`awaitTransfersSettled`) while a transfer is live, thus the drive
// starts when the transfer ends instead of a refusal.
//
// The hold decides nothing about the machine. The server refuses a profile that cannot start a
// sandbox (`server/sandbox_gate.ts`), and the drive shows that refusal. The hold never reads
// `GET {A}/sandbox-readiness`, because that read consumes a recorded farm failure that the server
// gate must see.
//
// The hold STARTS NO TRANSFER and OPENS NO CONSENT (the package-store-transfers spec). `inflexa
// setup`, `inflexa sandbox pull`, and `inflexa store download` start the children, and each owns its
// consent. The deliberate retry surfaces — the sidebar key and the command palette — route through
// {@link retryTerminalTransfers}, which is a user action and not the hold.

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
    /** Raise a transient toast. Real: {@link notify}. */
    readonly notify: (notice: Notice) => void;
    /**
     * How long the hold waits between two reads of the rows. A seam because it is a real delay, and a
     * test that must observe several polls cannot spend the production cadence on each of them.
     */
    readonly pollMs: number;
};

/** The production reads: the store rows and the TUI feedback channel. */
export const realSandboxGateSeams: SandboxGateSeams = {
    readStore: () => fetchStore(),
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

// The in-flight wait, so two concurrent profile drives share one hold rather than each polling the
// rows on its own. The check-and-set below has no await between the read and the write, so two
// concurrent callers cannot both start a wait.
let gateFlowInflight: Promise<"ready" | "blocked"> | null = null;

/**
 * Hold the caller while any transfer is live, and report the wait one time.
 *
 * The wait ends when the transfers end, and that bound is structural rather than a timeout: each child
 * holds its lock for its whole life, thus a process a user killed frees the lock and the next read
 * degrades its `running` row to `failed`. The hold therefore never holds without end.
 */
async function runGateFlow(seams: SandboxGateSeams): Promise<"ready" | "blocked"> {
    let announced = false;
    for (;;) {
        const read = await refreshTransferState(seams);
        if (read.isErr()) {
            seams.notify({ kind: "error", text: describeClientError(read.error) });
            return "blocked";
        }
        const live = read.value.filter((report) => report.live);
        if (live.length === 0) return "ready";
        if (!announced) {
            announced = true;
            seams.notify({
                kind: "info",
                text: `Waiting for ${live.map((report) => `the ${transferLabel(report.kind)} transfer`).join(" and ")}${GLYPHS.ellipsis}`,
            });
        }
        await Promise.sleep(seams.pollMs);
    }
}

/**
 * Hold a profile drive until no transfer is live. Gives `ready` when the drive can go to the server, which
 * decides if a sandbox can start, or `blocked` when the transfer state cannot be read. The hold reports the
 * reason of a `blocked` as it decides.
 */
export async function awaitTransfersSettled(seams: SandboxGateSeams = realSandboxGateSeams): Promise<"ready" | "blocked"> {
    if (gateFlowInflight !== null) return gateFlowInflight;
    gateFlowInflight = runGateFlow(seams).finally(() => {
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
