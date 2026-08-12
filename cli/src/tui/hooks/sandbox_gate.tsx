import { createSignal, onCleanup } from "solid-js";
import { err, ok, type Result } from "neverthrow";

import { GLYPHS } from "../../lib/design_system.ts";
import { ensureRuntime } from "../../lib/config.ts";
import { capture } from "../../lib/container.ts";
import { env } from "../../lib/env.ts";
import { isPublishedSandboxImage } from "../../modules/libs/images.ts";
import { takeFarmCompositionFailure, type FarmCompositionFailure } from "../../modules/libs/composition.ts";
import { storePackagesFile } from "../../modules/libs/packages.ts";
import { resolveHarnessConfig } from "../../modules/harness/config.ts";
import {
    inspectLibStoreDownload,
    installedLibStoreManifest,
    readLibStoreDownloadReport,
    type LibStoreDownloadReport,
    type LibStoreDownloadState,
} from "../../modules/libs/store_download.ts";
import { describeLibStoreFlightSpec, readLibStoreFlights, type LibStoreFlightReport, type LibStoreFlightStatus } from "../../modules/libs/store_flight.ts";
import type { Notice } from "../theme.ts";
import { notify } from "./notice.ts";
import { dialogClose, dialogPush } from "../components/dialog/dialog_host.tsx";
import { ConfirmDialog } from "../components/dialog/confirm_dialog.tsx";

// The sandbox prerequisite gate, held here (not inside `app.tsx`) so the holder of the state is
// decoupled from its callers. It has two jobs. It publishes the lifecycle of the DETACHED package-store
// downloader, which the sidebar renders. And it holds each sandbox-making action (`awaitSandboxReady`)
// until the store is complete and the sandbox image is present, reporting the wait through the notice
// channel.
//
// The app STARTS NO DOWNLOAD. `inflexa setup` starts the detached process and it owns the consent, thus
// the app is a reader: it reads the row, it reports the state, and it names `inflexa store download` as
// the retry. That split is the whole point of the detachment — a transfer the app owned would die with
// the app.
//
// The store half has NO pass-through state. The runtime image bakes no R library and no Python library,
// thus a sandbox with no store mounted can import nothing, and a gate that passed without a store would
// start exactly that sandbox. A store the CLI cannot complete is a hard failure with a remedy: the gate
// names the fault, offers a retry at the next action, and lets the action through never.
//
// The FILESYSTEM decides usability, never the row. A store root that a manual pull or `inflexa store
// add` built carries no row at all, and it is completely usable; a row that reports `installed` over an
// absent receipt keeps the refusal. The row supplies the reason for a hold and the progress the hold
// reports, and nothing else.
//
// Every effect is an injectable seam so the flow runs offline in a test with stubs, mirroring the seam
// bundles of `profile_parity.ts` and `boot.ts`. One chat screen is mounted at a time, so a module
// singleton is the right holder.

/**
 * The lifecycle of the package-store download as the TUI reports it.
 * - `idle` — not read yet (the first frame, before the watcher refreshes);
 * - `absent` — no download ever ran on this machine, and the store root carries no usable store;
 * - `pending` — a run is starting, and the manifest has not resolved;
 * - `downloading` — a transfer is live, carrying its running counts and the totals the manifest declared;
 * - `installed` — the store is complete and its pool carries a package inventory;
 * - `failed` — the store could not be completed, carrying the actionable message the gate reports;
 * - `declined` — the user answered no at setup, thus no transfer ever started;
 * - `canceled` — the user stopped a transfer that had started.
 *
 * `declined` and `canceled` behave alike at the gate: each refuses, each names the retry, and neither
 * opens a consent. They stay separate states because only one of them leaves a staged tree to remove.
 */
export type LibStoreGateState =
    | { readonly phase: "idle" }
    | { readonly phase: "absent" }
    | { readonly phase: "pending" }
    | {
          readonly phase: "downloading";
          readonly bytes: number;
          /** The bytes the manifest declares, or `null` while the manifest is still resolving. */
          readonly totalBytes: number | null;
          readonly layers: number;
          readonly totalLayers: number | null;
      }
    | { readonly phase: "installed"; readonly updateAvailable: boolean }
    | { readonly phase: "failed"; readonly message: string }
    | { readonly phase: "declined" }
    | { readonly phase: "canceled" };

const [state, setState] = createSignal<LibStoreGateState>({ phase: "idle" });

/** Read the current package-store gate state — call inside a tracking scope for reactivity. */
export const libStoreGateState = state;

/**
 * The acquisition flights that are live now, as the sidebar renders them.
 *
 * A separate signal from the gate state, because a flight decides NOTHING about whether a sandbox can
 * start: the store is usable while a package acquires into it. The gate holds a sandbox on the store, and
 * this only reports work that the machine is doing.
 */
export type LibStoreFlightLine = {
    /** The normalized spec of the flight, as a user reads it. */
    readonly spec: string;
    /** The live state: waiting for a slot under the cap, or running. */
    readonly state: LibStoreFlightStatus;
    /** The newest line of the acquisition, or `null` before the container writes one. */
    readonly progress: string | null;
    /** How many analyses subscribe to the flight. */
    readonly subscribers: number;
};

const [flights, setFlights] = createSignal<readonly LibStoreFlightLine[]>([]);

/** Read the live acquisition flights — call inside a tracking scope for reactivity. */
export const libStoreFlights = flights;

// The in-flight store wait, so two concurrent sandbox actions share one hold rather than each polling the
// row on its own. The check-and-set below has no await between the read and the write, so two concurrent
// callers cannot both start a wait.
let storeFlowInflight: Promise<"ready" | "blocked"> | null = null;

/** The readiness of the sandbox image, as the seam reports it without a network pull. */
export type ImageReadiness =
    { readonly kind: "present" } | { readonly kind: "pullable" } | { readonly kind: "custom" } | { readonly kind: "engine_error"; readonly message: string };

/** The effects the gate operates. Production passes {@link realSandboxGateSeams}; a test injects stubs. */
export type SandboxGateSeams = {
    /** The CLI-owned store root the sandbox will mount. Real: `env.libStoreDir`. */
    readonly storeRoot: () => string;
    /** The cheap local state of the download, read without the network. Real: {@link inspectLibStoreDownload}. */
    readonly inspect: (root: string) => Promise<LibStoreDownloadState>;
    /** The lifecycle of the detached downloader: the row, corrected by the liveness of the lock. Real: {@link readLibStoreDownloadReport}. */
    readonly readDownload: () => LibStoreDownloadReport;
    /** The acquisition flights that are live now. Real: {@link readLibStoreFlights}. */
    readonly readFlights: () => readonly LibStoreFlightReport[];
    /** The manifest digest the receipt pins, or `null`. Real: {@link installedLibStoreManifest}. */
    readonly installedManifest: (root: string) => Promise<string | null>;
    /**
     * The pool inventory of the store, or `null` when the store carries none. This is the one fact that
     * separates "the bytes arrived" from "a sandbox can import something". Real:
     * {@link storePackagesFile}.
     */
    readonly storeInventory: (root: string) => string | null;
    /**
     * The farm composition that failed and that nothing reported yet, or `null`. The read CONSUMES it —
     * refer to {@link takeFarmCompositionFailure}. Real: that function.
     */
    readonly takeFarmFailure: () => FarmCompositionFailure | null;
    /** The configured sandbox image reference. Real: `resolveHarnessConfig().sandboxImage`. */
    readonly sandboxImage: () => string;
    /** Report the image readiness without a pull. Real: an engine inspect. */
    readonly imageReadiness: (image: string) => Promise<ImageReadiness>;
    /** Pull the image behind the alternate screen. Real: an engine pull. */
    readonly pullImage: (image: string) => Promise<Result<void, { readonly message: string }>>;
    /** Ask a yes/no question inside the TUI. Real: {@link confirmInTui}. */
    readonly confirm: (opts: { title: string; message: string }) => Promise<boolean>;
    /** Raise a transient toast. Real: {@link notify}. */
    readonly notify: (notice: Notice) => void;
    /**
     * How long the hold waits between two reads of the row. A seam because it is a real delay, and a test
     * that must observe several polls cannot spend the production cadence on each of them. Real:
     * {@link DOWNLOAD_POLL_MS}.
     */
    readonly pollMs: number;
};

/** The first line of a multi-line message, so a runtime hint with its remedy stays one toast line. */
function firstLine(text: string): string {
    return text.split("\n", 1)[0] ?? text;
}

/**
 * Ask a yes/no question through a {@link ConfirmDialog}, resolving the promise with the answer. The close
 * funnel routes esc, click-outside, and ctrl+c through `onCancel` too, so `settled` makes sure the
 * promise resolves one time only. A cancel click pops the dialog here; a non-commit close already popped
 * it inside the funnel, where this nested pop is a no-op.
 *
 * The store half opens NO dialog: setup owns the download consent, thus the app asks nothing about the
 * catalog. This serves the sandbox image pull, which is the one consent the app still owns.
 */
function confirmInTui(opts: { title: string; message: string }): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (value: boolean): void => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        dialogPush(() => (
            <ConfirmDialog
                title={opts.title}
                message={opts.message}
                onConfirm={() => {
                    dialogClose("commit");
                    finish(true);
                }}
                onCancel={() => {
                    dialogClose();
                    finish(false);
                }}
            />
        ));
    });
}

/**
 * How often the watcher and the gate re-read the row.
 *
 * The writer is a different process, so a read is the only way this one learns that the transfer moved.
 * The read is one point lookup by primary key against a WAL database, thus it never blocks that writer
 * and it costs nothing measurable at this cadence.
 */
const DOWNLOAD_POLL_MS = 2000;

/** The production seams: the real store reads, the engine image checks, and the TUI feedback channels. */
export const realSandboxGateSeams: SandboxGateSeams = {
    storeRoot: () => env.libStoreDir,
    inspect: inspectLibStoreDownload,
    readDownload: readLibStoreDownloadReport,
    readFlights: readLibStoreFlights,
    installedManifest: installedLibStoreManifest,
    storeInventory: storePackagesFile,
    takeFarmFailure: takeFarmCompositionFailure,
    sandboxImage: () => resolveHarnessConfig().sandboxImage,
    imageReadiness: async (image) => {
        const rt = await ensureRuntime();
        if (rt.isErr()) return { kind: "engine_error", message: firstLine(rt.error.message) };
        if ((await capture(rt.value, ["image", "inspect", image])).code === 0) return { kind: "present" };
        return isPublishedSandboxImage(image) ? { kind: "pullable" } : { kind: "custom" };
    },
    pullImage: async (image) => {
        const rt = await ensureRuntime();
        if (rt.isErr()) return err({ message: firstLine(rt.error.message) });
        // `capture`, not `inherit`: the pull runs behind the alternate screen, so its output must never
        // reach the terminal. The captured text is small — the image bytes do not enter the buffer.
        const { code } = await capture(rt.value, ["pull", image]);
        return code === 0
            ? ok(undefined)
            : err({ message: `Could not pull ${image} (\`${rt.value.bin} pull\` exited ${code}). Check your network and that ghcr.io is reachable.` });
    },
    confirm: confirmInTui,
    notify,
    pollMs: DOWNLOAD_POLL_MS,
};

/** The one command that starts, or starts again, the detached transfer. Every refusal names it. */
const STORE_RETRY_COMMAND = "Run `inflexa store download` to obtain it.";

/**
 * Read the store as the FILESYSTEM reports it, and publish the state the two surfaces render.
 *
 * The receipt decides usability, and the inventory decides whether a sandbox can import anything. The row
 * is consulted only for the reason and the progress of a hold, thus a store with no row and a valid
 * receipt reads as installed, and a row of `installed` over an absent receipt does not.
 */
export async function refreshLibStoreGateState(seams: SandboxGateSeams = realSandboxGateSeams): Promise<LibStoreGateState> {
    const root = seams.storeRoot();
    const report = seams.readDownload();
    // The flights ride the same poll, because the two describe one store and a second timer would let the
    // rail show a flight against a download state that a different tick produced.
    setFlights(
        seams.readFlights().map((flight) => ({
            spec: describeLibStoreFlightSpec(flight.row),
            state: flight.row.state,
            progress: flight.row.progress,
            subscribers: flight.analysisIds.length,
        })),
    );
    const usable = (await seams.inspect(root)) === "installed" && seams.storeInventory(root) !== null;
    if (usable) {
        // The last resolve recorded the digest the registry serves now; the receipt pins the digest that is
        // installed. A difference between the two is the only signal of an available update that costs no
        // network, and neither surface opens a prompt over it — the user owns that decision.
        const latest = report.row?.manifestDigest ?? null;
        const installed = latest === null ? null : await seams.installedManifest(root);
        const next: LibStoreGateState = { phase: "installed", updateAvailable: installed !== null && installed !== latest };
        setState(next);
        return next;
    }
    const next = describeUnusableStore(root, report);
    setState(next);
    return next;
}

/** The state of a store a sandbox cannot mount yet: the lifecycle of the run, or the fault of the store itself. */
function describeUnusableStore(root: string, report: LibStoreDownloadReport): LibStoreGateState {
    const row = report.row;
    switch (report.state) {
        case null:
            return { phase: "absent" };
        case "pending":
            return { phase: "pending" };
        case "running":
            return {
                phase: "downloading",
                bytes: row?.bytesTransferred ?? 0,
                totalBytes: row?.totalBytes ?? null,
                layers: row?.layersCompleted ?? 0,
                totalLayers: row?.totalLayers ?? null,
            };
        case "failed":
            return { phase: "failed", message: row?.message ?? `The package-store download did not complete. ${STORE_RETRY_COMMAND}` };
        case "declined":
            return { phase: "declined" };
        case "canceled":
            return { phase: "canceled" };
        case "installed":
            // The row says the bytes landed and the filesystem disagrees: the receipt is gone, or the pool
            // names no package. The filesystem is what a sandbox mounts, thus it wins and the gate keeps the
            // refusal.
            return {
                phase: "failed",
                message:
                    `The package store at ${root} reports an installed download, but it carries no package inventory, ` +
                    `so a sandbox would carry no library. Run \`inflexa store ls\` to see the farms, and \`inflexa store download\` to obtain the catalog again.`,
            };
        default: {
            const exhaustive: never = report.state;
            throw new Error(`unhandled download state: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/** The one hold line for a state that is not usable yet. Bare text: the sidebar owns the meter, and two surfaces must not show one figure. */
function holdText(state: LibStoreGateState): string {
    switch (state.phase) {
        case "absent":
            return `The analysis sandbox needs the package store, and no download ran. ${STORE_RETRY_COMMAND}`;
        case "pending":
            return `The package-store download is starting${GLYPHS.ellipsis}`;
        case "downloading":
            return `The package store is downloading${GLYPHS.ellipsis} ${state.bytes} bytes so far.`;
        case "declined":
            return `The package store was declined at setup, and the analysis sandbox needs it. ${STORE_RETRY_COMMAND}`;
        case "canceled":
            return `You stopped the package-store download, and the analysis sandbox needs it. ${STORE_RETRY_COMMAND}`;
        case "failed":
            return state.message;
        default:
            return `The analysis sandbox needs the package store. ${STORE_RETRY_COMMAND}`;
    }
}

/**
 * Hold the caller while a transfer is live, then decide.
 *
 * The wait ends when the transfer ends, and that bound is structural rather than a timeout: the
 * downloader holds the lock for its whole life, thus a process a user killed frees the lock and the next
 * read of the row degrades `running` to `failed`. The gate therefore never holds without end, and it
 * never lets the action through against an incomplete store.
 *
 * It starts NO process and it opens NO consent, in any state. `declined` and `canceled` each refuse and
 * name the retry — a user who answered no, or who stopped the transfer, made a decision that the gate
 * does not put a second time.
 */
async function runStoreFlow(seams: SandboxGateSeams): Promise<"ready" | "blocked"> {
    let announced = false;
    for (;;) {
        const current = await refreshLibStoreGateState(seams);
        if (current.phase === "installed") return "ready";
        if (!announced) {
            announced = true;
            seams.notify({ kind: current.phase === "downloading" || current.phase === "pending" ? "info" : "error", text: holdText(current) });
        }
        if (current.phase !== "downloading" && current.phase !== "pending") return "blocked";
        await Promise.sleep(seams.pollMs);
    }
}

/** Hold the caller until the store is complete and mountable. There is no state in which this passes without one. */
async function ensureLibStore(seams: SandboxGateSeams): Promise<"ready" | "blocked"> {
    if (state().phase === "installed") return "ready";
    if (storeFlowInflight !== null) return storeFlowInflight;
    storeFlowInflight = runStoreFlow(seams).finally(() => {
        storeFlowInflight = null;
    });
    return storeFlowInflight;
}

/**
 * Mirror the detached downloader into the gate state, for the sidebar to render. Call ONCE from `App`'s
 * setup, inside its reactive owner.
 *
 * A poll and not a subscription, because the writer is a DIFFERENT PROCESS: the row is the channel
 * between the two, and nothing in this process is notified when it changes. The poll stays armed for the
 * whole life of the screen — a transfer that `inflexa store download` starts in another terminal must
 * appear here without the user reopening the app.
 */
export function watchLibStoreDownload(seams: SandboxGateSeams = realSandboxGateSeams): void {
    void refreshLibStoreGateState(seams);
    const timer = setInterval(() => void refreshLibStoreGateState(seams), seams.pollMs);
    onCleanup(() => clearInterval(timer));
}

/** Hold the caller until the sandbox image is present, pulling it with consent inside the TUI. */
async function ensureImage(seams: SandboxGateSeams): Promise<"ready" | "blocked"> {
    const image = seams.sandboxImage();
    const readiness = await seams.imageReadiness(image);
    switch (readiness.kind) {
        case "present":
            return "ready";
        case "engine_error":
            seams.notify({ kind: "error", text: readiness.message });
            return "blocked";
        case "custom":
            // A user's own tag cannot be pulled, so name the remedy and refuse rather than pull nothing.
            seams.notify({
                kind: "error",
                text: `Sandbox image "${image}" is not present, and it is not the published image. Build it, or set the published image and run \`inflexa sandbox pull\`.`,
            });
            return "blocked";
        case "pullable": {
            const yes = await seams.confirm({
                title: "Pull the sandbox image?",
                message: `The sandbox image is not installed. Pull it now? (a multi-gigabyte download)`,
            });
            if (!yes) {
                seams.notify({ kind: "warn", text: "A sandbox image is necessary. Run `inflexa sandbox pull`, then retry." });
                return "blocked";
            }
            seams.notify({ kind: "info", text: `Pulling the sandbox image${GLYPHS.ellipsis}` });
            const pulled = await seams.pullImage(image);
            if (pulled.isErr()) {
                seams.notify({ kind: "error", text: pulled.error.message });
                return "blocked";
            }
            seams.notify({ kind: "info", text: "The sandbox image is ready." });
            return "ready";
        }
        default: {
            const exhaustive: never = readiness;
            throw new Error(`unhandled image readiness: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/**
 * Report the farm composition that failed since the last action, and refuse this one.
 *
 * Composition runs INSIDE the farm provider that the harness calls, thus it runs after this gate decided
 * and its error reaches no user surface of its own. The provider records the reason, and this is where the
 * user reads it.
 *
 * The report CONSUMES the record, thus the action after this one composes again. A gate that held the
 * record would refuse for ever: the store download or the package acquisition that fixes the fault leaves
 * the record untouched, and the composition that would clear it is exactly what the refusal stops.
 */
function reportFarmFailure(seams: SandboxGateSeams): "ready" | "blocked" {
    const failure = seams.takeFarmFailure();
    if (failure === null) return "ready";
    seams.notify({
        kind: "error",
        text: `The package farm of this analysis could not be composed: ${failure.reason}. Run \`inflexa store ls\` to see the store, then try again.`,
    });
    return "blocked";
}

/**
 * Hold a sandbox-making action until the store is complete, the farm of the analysis composes, and the
 * image is present. Returns `ready` when the three are satisfied, or `blocked` otherwise — the gate
 * reports the reason as it decides, so a `blocked` caller starts no sandbox against an empty store.
 *
 * The farm check sits between the two, because a farm that cannot compose makes the sandbox refuse
 * whatever the image does, and the image half can open a multi-gigabyte pull consent.
 */
export async function awaitSandboxReady(seams: SandboxGateSeams = realSandboxGateSeams): Promise<"ready" | "blocked"> {
    const store = await ensureLibStore(seams);
    if (store === "blocked") return "blocked";
    if (reportFarmFailure(seams) === "blocked") return "blocked";
    return ensureImage(seams);
}

/** Test hook: publish a lifecycle state directly, with no row and no filesystem. Test-only. */
export function __setLibStoreGateStateForTest(next: LibStoreGateState): void {
    setState(next);
}

/** Test hook: publish a set of live flights directly, with no database. Test-only. */
export function __setLibStoreFlightsForTest(next: readonly LibStoreFlightLine[]): void {
    setFlights(next);
}

/** Test hook: drop the gate state, the flights, and the in-flight flow back to idle. Test-only. */
export function __resetSandboxGateForTest(): void {
    storeFlowInflight = null;
    setState({ phase: "idle" });
    setFlights([]);
}
