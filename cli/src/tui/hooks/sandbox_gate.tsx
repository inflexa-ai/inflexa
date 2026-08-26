import { createSignal, onCleanup } from "solid-js";

import { ensureRuntime } from "../../lib/config.ts";
import { capture } from "../../lib/container.ts";
import { env } from "../../lib/env.ts";
import { GLYPHS } from "../../lib/design_system.ts";
import { isPublishedSandboxImage } from "../../modules/libs/images.ts";
import { takeFarmCompositionFailure, type FarmCompositionFailure } from "../../modules/libs/composition.ts";
import { configuredSandboxImage } from "../../modules/libs/pull.ts";
import { inspectStoreContent, startCatalogTransfer, type StoreContentState } from "../../modules/libs/store_download.ts";
import { listPendingStoreAdds } from "../../db/primary_query.ts";
import { startPendingFlushChild } from "../../modules/libs/store.ts";
import { describeStoreFlightSpec, readStoreFlights, type StoreFlightReport, type StoreFlightStatus } from "../../modules/libs/store_flight.ts";
import { readTransferReports, startImageTransfer, type TransferReport } from "../../modules/libs/transfers.ts";
import type { Notice } from "../theme.ts";
import { notify } from "./notice.ts";

// The sandbox prerequisite gate, held here (not inside `app.tsx`) so the holder of the state is
// decoupled from its callers. It has two jobs. It publishes the lifecycle of the three detached
// transfers, which the sidebar renders as one row per live transfer. And it holds each sandbox-making
// action (`awaitSandboxReady`) while a transfer is live, refusing a terminal state with the retry
// command.
//
// The gate STARTS NO TRANSFER and OPENS NO CONSENT (the package-store-transfers spec). `inflexa
// setup`, `inflexa sandbox pull`, and `inflexa store download` start the children, and each owns its
// consent. The gate is a reader: it reads the rows, it reports the state, and it names the retry
// command. The deliberate retry surfaces — the sidebar key and the command palette — route through
// {@link retryTerminalTransfers}, which is a user action and not the gate.
//
// The ONE start the poll owns is the pending-set flush child (the 10-second gate of the
// package-store-management spec). It carries no consent question: the user approved each add at its
// ask, and the gate only bounds how long the approved set waits — a schedule, not a permission.
//
// The FILESYSTEM decides usability, never a row. A store root that `inflexa store add` built carries
// no catalog receipt and is completely usable; a row that reports `installed` over an absent store
// keeps the refusal. The rows supply the reason for a hold and the progress the hold reports.

/** One acquisition flight as the sidebar renders it: a live one, or a terminal `failed` record. */
export type StoreFlightLine = {
    /** The flight key, which a detail opener passes back to find the row. */
    readonly id: string;
    /** The spec of the flight, as a user reads it. */
    readonly spec: string;
    /** The state: waiting for a slot under the cap, running, or failed. */
    readonly state: StoreFlightStatus;
    /** How many analyses subscribe to the flight. */
    readonly subscribers: number;
    /** The newest provisioner line of a running flight, or `null`. */
    readonly progress: string | null;
};

/** One enqueued add that no flush took yet, as the pipeline section renders it. */
export type PendingAddLine = {
    /** The spec of the add, as a user reads it. */
    readonly spec: string;
};

const [transfers, setTransfers] = createSignal<readonly TransferReport[]>([]);
const [flights, setFlights] = createSignal<readonly StoreFlightLine[]>([]);
const [pendingAdds, setPendingAdds] = createSignal<readonly PendingAddLine[]>([]);

/** The three transfer reports as last read — call inside a tracking scope for reactivity. */
export const transferReports = transfers;

/** The acquisition flights, live and failed — call inside a tracking scope for reactivity. */
export const storeFlightLines = flights;

/** The pending adds that no flush took yet — call inside a tracking scope for reactivity. */
export const pendingAddLines = pendingAdds;

/**
 * How often the watcher and the gate re-read the rows.
 *
 * The writers are DIFFERENT PROCESSES (the detached children), so a read is the only way this one
 * learns that a transfer moved. The read is a point lookup against a WAL database, thus it never
 * blocks a writer and it costs nothing measurable at this cadence.
 */
const TRANSFER_POLL_MS = 2000;

/**
 * How long the pending set may wait before the poll starts the flush child.
 * The turn end flushes first when it comes sooner. The bound exists for the
 * long turn: an add approved early must not sit queued behind minutes of
 * agent work, because the acquisition can run beside that work.
 */
const PENDING_FLUSH_AFTER_MS = 10_000;

/**
 * When the poll first saw a non-empty pending set, or `null` while it is
 * empty. The anchor does NOT slide on growth, thus a burst of asks still
 * lands in one batch and the wait stays bounded at the gate.
 */
let pendingSince: number | null = null;

/** The readiness of the sandbox image, as the seam reports it without a pull. */
export type ImageReadiness =
    { readonly kind: "present" } | { readonly kind: "absent" } | { readonly kind: "custom" } | { readonly kind: "engine_error"; readonly message: string };

/** The effects the gate operates. Production passes {@link realSandboxGateSeams}; a test injects stubs. */
export type SandboxGateSeams = {
    /** The CLI-owned store root the sandbox will mount. Real: `env.packageStoreDir`. */
    readonly storeRoot: () => string;
    /** The three transfer reports, lock-corrected. Real: {@link readTransferReports}. */
    readonly readTransfers: () => readonly TransferReport[];
    /** The acquisition flights that are live now. Real: {@link readStoreFlights}. */
    readonly readFlights: () => readonly StoreFlightReport[];
    /** The pending adds that no flush took yet. Real: the pending-set listing. */
    readonly readPending: () => readonly { readonly ecosystem: "python" | "r" | null; readonly name: string; readonly specifier: string }[];
    /** The cheap local state of the store content. Real: {@link inspectStoreContent}. */
    readonly inspect: (root: string) => Promise<StoreContentState>;
    /**
     * The farm composition that failed and that nothing reported yet, or `null`. The read CONSUMES it —
     * refer to {@link takeFarmCompositionFailure}. Real: that function.
     */
    readonly takeFarmFailure: () => FarmCompositionFailure | null;
    /** The configured sandbox image reference. Real: {@link configuredSandboxImage}. */
    readonly sandboxImage: () => string;
    /** Report the image readiness without a pull. Real: an engine inspect. */
    readonly imageReadiness: (image: string) => Promise<ImageReadiness>;
    /** Raise a transient toast. Real: {@link notify}. */
    readonly notify: (notice: Notice) => void;
    /**
     * How long the hold waits between two reads of the rows. A seam because it is a real delay, and a
     * test that must observe several polls cannot spend the production cadence on each of them.
     */
    readonly pollMs: number;
    /** How long the pending set may wait before the poll starts the flush child. Real: {@link PENDING_FLUSH_AFTER_MS}. */
    readonly pendingFlushAfterMs: number;
    /** Start the detached flush child over the pending set. Real: {@link startPendingFlushChild}. */
    readonly startFlush: () => number | null;
};

/** The first line of a multi-line message, so a hint with its remedy stays one toast line. */
function firstLine(text: string): string {
    return text.split("\n", 1)[0] ?? text;
}

/** The production seams: the real row reads, the engine image check, and the TUI feedback channel. */
export const realSandboxGateSeams: SandboxGateSeams = {
    storeRoot: () => env.packageStoreDir,
    readTransfers: readTransferReports,
    readFlights: readStoreFlights,
    readPending: () => listPendingStoreAdds().unwrapOr([]),
    inspect: inspectStoreContent,
    takeFarmFailure: takeFarmCompositionFailure,
    sandboxImage: configuredSandboxImage,
    imageReadiness: async (image) => {
        const rt = await ensureRuntime();
        if (rt.isErr()) return { kind: "engine_error", message: firstLine(rt.error.message) };
        try {
            if ((await capture(rt.value, ["image", "inspect", image])).code === 0) return { kind: "present" };
        } catch (cause) {
            return { kind: "engine_error", message: `The container engine is not reachable (${cause instanceof Error ? cause.message : String(cause)}).` };
        }
        return isPublishedSandboxImage(image) ? { kind: "absent" } : { kind: "custom" };
    },
    notify,
    pollMs: TRANSFER_POLL_MS,
    pendingFlushAfterMs: PENDING_FLUSH_AFTER_MS,
    startFlush: startPendingFlushChild,
};

/** Refresh the three signals from the rows: the transfers, the flights, and the pending adds that ride the same poll. */
export function refreshTransferState(seams: SandboxGateSeams = realSandboxGateSeams): readonly TransferReport[] {
    const reports = seams.readTransfers();
    setTransfers(reports);
    setFlights(
        seams.readFlights().map((flight) => ({
            id: flight.row.id,
            spec: describeStoreFlightSpec(flight.row),
            state: flight.row.state,
            subscribers: flight.analysisIds.length,
            progress: flight.row.progress,
        })),
    );
    const pending = seams.readPending();
    setPendingAdds(pending.map((entry) => ({ spec: describeStoreFlightSpec(entry) })));
    // The 10-second flush gate. The anchor is the first poll that saw the set
    // non-empty, and firing clears it: the child claims the rows, and the set
    // empties on a later poll. A child that could not spawn leaves the set
    // non-empty, thus the next poll re-arms and the gate retries on its own.
    // The turn-end flush call stays the sweep, and a double start is safe —
    // the flush child exits at once over an empty or claimed set.
    if (pending.length === 0) {
        pendingSince = null;
    } else if (pendingSince === null) {
        pendingSince = Date.now();
    } else if (Date.now() - pendingSince >= seams.pendingFlushAfterMs) {
        pendingSince = null;
        seams.startFlush();
    }
    return reports;
}

/**
 * Mirror the detached transfers into the gate signals, for the sidebar to render. Call ONCE from
 * `App`'s setup, inside its reactive owner.
 *
 * A poll and not a subscription, because the writers are DIFFERENT PROCESSES: the rows are the channel
 * between them, and nothing in this process is notified when one changes. The poll stays armed for the
 * whole life of the screen — a transfer that `inflexa store download` starts in another terminal must
 * appear here without the user reopening the app.
 */
export function watchTransfers(seams: SandboxGateSeams = realSandboxGateSeams): void {
    refreshTransferState(seams);
    const timer = setInterval(() => refreshTransferState(seams), seams.pollMs);
    onCleanup(() => clearInterval(timer));
}

/** The human label of one transfer kind, as every surface renders it. */
export function transferLabel(kind: TransferReport["kind"]): string {
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
function retryCommand(kind: TransferReport["kind"]): string {
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
async function runGateFlow(seams: SandboxGateSeams): Promise<"ready" | "blocked"> {
    let announced = false;
    for (;;) {
        const reports = refreshTransferState(seams);
        const live = reports.filter((report) => report.live);
        if (live.length === 0) break;
        if (!announced) {
            announced = true;
            seams.notify({
                kind: "info",
                text: `Waiting for ${live.map((report) => `the ${transferLabel(report.kind)} transfer`).join(" and ")}${GLYPHS.ellipsis}`,
            });
        }
        await Promise.sleep(seams.pollMs);
    }

    // The image half. The engine is the truth of presence; the row of the kind
    // supplies the reason when it is absent.
    const image = seams.sandboxImage();
    const readiness = await seams.imageReadiness(image);
    if (readiness.kind === "engine_error") {
        seams.notify({ kind: "error", text: readiness.message });
        return "blocked";
    }
    if (readiness.kind === "custom") {
        seams.notify({
            kind: "error",
            text: `Sandbox image "${image}" is not present, and it is not the published image, thus no registry can supply it. Build it, or set the published image and run \`inflexa sandbox pull\`.`,
        });
        return "blocked";
    }
    if (readiness.kind === "absent") {
        const report = seams.readTransfers().find((entry) => entry.kind === "runtime_image");
        const detail = report?.state === "failed" && report.row?.message ? ` ${firstLine(report.row.message)}` : "";
        seams.notify({ kind: "error", text: `The sandbox image is not installed.${detail} Run ${retryCommand("runtime_image")} to download it.` });
        return "blocked";
    }

    // The store half. The filesystem decides: `installed` is a downloaded
    // catalog, and `local` is a store that `inflexa store add` built — both
    // mount. The catalog row supplies the reason for the rest.
    const content = await seams.inspect(seams.storeRoot());
    if (content !== "installed" && content !== "local") {
        const report = seams.readTransfers().find((entry) => entry.kind === "catalog");
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
    const failure = seams.takeFarmFailure();
    if (failure !== null) {
        seams.notify({
            kind: "error",
            text: `The package farm of this analysis could not be composed: ${failure.reason}. Run \`inflexa store ls\` to see the store, then try again.`,
        });
        return "blocked";
    }

    return "ready";
}

/**
 * Hold a sandbox-making action until the transfers settle and the machine can serve one. Returns
 * `ready` when a sandbox may start, or `blocked` otherwise — the gate reports the reason as it
 * decides, so a `blocked` caller starts no sandbox against an empty store.
 */
export async function awaitSandboxReady(seams: SandboxGateSeams = realSandboxGateSeams): Promise<"ready" | "blocked"> {
    if (gateFlowInflight !== null) return gateFlowInflight;
    gateFlowInflight = runGateFlow(seams).finally(() => {
        gateFlowInflight = null;
    });
    return gateFlowInflight;
}

/**
 * Retry every transfer that sits in a terminal failure state — the deliberate action behind the
 * sidebar key and the command palette entries. This is a USER action, not the gate: the gate itself
 * starts nothing.
 */
export async function retryTerminalTransfers(): Promise<number> {
    let started = 0;
    for (const report of readTransferReports()) {
        if (report.state !== "failed" && report.state !== "declined" && report.state !== "canceled") continue;
        if (report.kind === "catalog") {
            const outcome = await startCatalogTransfer({ storeRoot: env.packageStoreDir, update: false });
            if (outcome.isOk() && outcome.value.type === "started") started += 1;
            continue;
        }
        if (startImageTransfer(report.kind).isOk()) started += 1;
    }
    refreshTransferState();
    return started;
}

/** Test hook: publish transfer reports directly, with no database. Test-only. */
export function __setTransferReportsForTest(next: readonly TransferReport[]): void {
    setTransfers(next);
}

/** Test hook: publish a set of live flights directly, with no database. Test-only. */
export function __setStoreFlightLinesForTest(next: readonly StoreFlightLine[]): void {
    setFlights(next);
}

/** Test hook: publish a set of pending adds directly, with no database. Test-only. */
export function __setPendingAddLinesForTest(next: readonly PendingAddLine[]): void {
    setPendingAdds(next);
}

/** Test hook: drop the signals, the in-flight flow, and the flush gate back to idle. Test-only. */
export function __resetSandboxGateForTest(): void {
    gateFlowInflight = null;
    pendingSince = null;
    setTransfers([]);
    setFlights([]);
    setPendingAdds([]);
}
