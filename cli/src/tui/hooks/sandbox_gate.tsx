import { createSignal } from "solid-js";
import { err, ok, type Result } from "neverthrow";

import { GLYPHS } from "../../lib/design_system.ts";
import { ensureRuntime } from "../../lib/config.ts";
import { capture } from "../../lib/container.ts";
import { variantOfImage, type SandboxVariant } from "../../modules/libs/images.ts";
import { resolveHarnessConfig, resolveLibStore, type LibStoreLocation } from "../../modules/harness/config.ts";
import {
    inspectLibStoreDownload,
    maybeDownloadLibStore,
    type LibStoreDownloadError,
    type LibStoreDownloadOutcome,
    type LibStoreDownloadProgress,
    type LibStoreDownloadState,
} from "../../modules/libs/store_download.ts";
import type { Notice } from "../theme.ts";
import { notify } from "./notice.ts";
import { dialogClose, dialogPush } from "../components/dialog/dialog_host.tsx";
import { ConfirmDialog } from "../components/dialog/confirm_dialog.tsx";

// The sandbox prerequisite gate, held here (not inside `app.tsx`) so the holder of the state is
// decoupled from its callers. It has two jobs. The app-open trigger (`startLibStoreDownload`) starts the
// package-store download in the background when a store is configured, after a one-time consent, and it
// asks before it applies a moved-tag update. The gate (`awaitSandboxReady`) holds each sandbox-making
// action until the store is complete and the sandbox image is present, and it reports the wait through
// the notice channel. The store download and the image pull each ask for their multi-gigabyte consent
// inside the TUI, so app launch never blocks on either. The store half is a clean no-op when no store is
// configured, so a cleared config key is a full rollback.
//
// Every effect is an injectable seam so the flow runs offline in a test with stubs, mirroring the seam
// bundles of `profile_parity.ts` and `boot.ts`. One chat screen is mounted at a time, so a module
// singleton is the right holder.

/**
 * The live state of the package-store download, surfaced for the status surface.
 * - `unconfigured` — no store root; the gate passes on the store and only the image applies;
 * - `idle` — configured, not yet checked;
 * - `consent` — the first-download consent is open;
 * - `declined` — the user declined the first download; the gate re-offers at the next sandbox action;
 * - `downloading` — a first download runs, carrying a running byte total;
 * - `installed` — the receipt reports a complete store;
 * - `failed` — a download could not complete, carrying the actionable message the gate reports.
 */
export type LibStoreGateState =
    | { readonly phase: "unconfigured" }
    | { readonly phase: "idle" }
    | { readonly phase: "consent" }
    | { readonly phase: "declined" }
    | { readonly phase: "downloading"; readonly bytes: number }
    | { readonly phase: "installed" }
    | { readonly phase: "failed"; readonly message: string };

const [state, setState] = createSignal<LibStoreGateState>({ phase: "idle" });

/** Read the current package-store gate state — call inside a tracking scope for reactivity. */
export const libStoreGateState = state;

// The in-flight store flow, so the app-open trigger and the gate share one download and ask consent one
// time. The check-and-set below has no await between the read and the write, so two concurrent callers
// cannot both start a flow.
let storeFlowInflight: Promise<"ready" | "blocked"> | null = null;

/** The readiness of the sandbox image, as the seam reports it without a network pull. */
export type ImageReadiness =
    | { readonly kind: "present" }
    | { readonly kind: "pullable"; readonly variant: SandboxVariant }
    | { readonly kind: "custom" }
    | { readonly kind: "engine_error"; readonly message: string };

/** The effects the gate operates. Production passes {@link realSandboxGateSeams}; a test injects stubs. */
export type SandboxGateSeams = {
    /** Report whether a store is configured, and its root. Real: {@link resolveLibStore}. */
    readonly resolveLocation: () => LibStoreLocation;
    /** The cheap local state of the download, read without the network. Real: {@link inspectLibStoreDownload}. */
    readonly inspect: (root: string) => Promise<LibStoreDownloadState>;
    /** Pull the store; `force` applies a moved-tag update. Real: {@link maybeDownloadLibStore}. */
    readonly download: (
        location: LibStoreLocation,
        force: boolean,
        onProgress?: (event: LibStoreDownloadProgress) => void,
    ) => Promise<Result<LibStoreDownloadOutcome, LibStoreDownloadError>>;
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
};

/** The rough download size named in the consent, so the user knows the cost before the yes. */
const STORE_SIZE_HINT = "about 9 GB";
const STORE_CONSENT_TITLE = "Download the package store?";
const STORE_CONSENT_MESSAGE = `The analysis sandbox needs the package store. This is a one-time download of ${STORE_SIZE_HINT}. Download it now?`;
const STORE_UPDATE_TITLE = "Update the package store?";
const STORE_UPDATE_MESSAGE = `A newer package store is available. Download the update now? (${STORE_SIZE_HINT})`;
const STORE_RETRY_TITLE = "Retry the package store download?";

/** The first line of a multi-line message, so a runtime hint with its remedy stays one toast line. */
function firstLine(text: string): string {
    return text.split("\n", 1)[0] ?? text;
}

/**
 * Ask a yes/no question through a {@link ConfirmDialog}, resolving the promise with the answer. The close
 * funnel routes esc, click-outside, and ctrl+c through `onCancel` too, so `settled` makes sure the
 * promise resolves one time only. A cancel click pops the dialog here; a non-commit close already popped
 * it inside the funnel, where this nested pop is a no-op.
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

/** Accumulate a completed layer's bytes into the reactive state, so the status surface can show progress. */
function noteProgress(event: LibStoreDownloadProgress): void {
    if (event.type !== "layer_completed") return;
    const current = state();
    const base = current.phase === "downloading" ? current.bytes : 0;
    setState({ phase: "downloading", bytes: base + event.bytes });
}

/** The production seams: the real store reads, the engine image checks, and the TUI feedback channels. */
export const realSandboxGateSeams: SandboxGateSeams = {
    resolveLocation: () => resolveLibStore(resolveHarnessConfig()),
    inspect: inspectLibStoreDownload,
    download: (location, force, onProgress) => maybeDownloadLibStore(location, { force, ...(onProgress ? { onProgress } : {}) }),
    sandboxImage: () => resolveHarnessConfig().sandboxImage,
    imageReadiness: async (image) => {
        const rt = await ensureRuntime();
        if (rt.isErr()) return { kind: "engine_error", message: firstLine(rt.error.message) };
        if ((await capture(rt.value, ["image", "inspect", image])).code === 0) return { kind: "present" };
        const variant = variantOfImage(image);
        return variant === null ? { kind: "custom" } : { kind: "pullable", variant };
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
};

/** Download the store, moving the state to `downloading` then `installed` or `failed`, and return the verdict. */
async function performDownload(location: LibStoreLocation, force: boolean, seams: SandboxGateSeams): Promise<"ready" | "blocked"> {
    setState({ phase: "downloading", bytes: 0 });
    seams.notify({ kind: "info", text: `Downloading the package store${GLYPHS.ellipsis}` });
    const result = await seams.download(location, force, noteProgress);
    if (result.isErr()) {
        const message = `Could not download the package store: ${result.error.message}`;
        setState({ phase: "failed", message });
        seams.notify({ kind: "error", text: message });
        return "blocked";
    }
    // Every ok outcome leaves a usable store: `downloaded` and `up_to_date` both pin the manifest, and
    // `not_configured` cannot arise here because the caller proved the store configured.
    setState({ phase: "installed" });
    if (result.value.type === "downloaded") seams.notify({ kind: "info", text: "The package store is ready." });
    return "ready";
}

/** The store flow behind the shared in-flight guard: retry a failure, or consent then download. */
async function runStoreFlow(location: { readonly configured: true; readonly path: string }, seams: SandboxGateSeams): Promise<"ready" | "blocked"> {
    const previous = state();
    if (previous.phase === "failed") {
        // Report the failure again with its remedy, and offer a retry, so the gate never holds without end.
        seams.notify({ kind: "error", text: `${previous.message} Retry it?` });
        const retry = await seams.confirm({ title: STORE_RETRY_TITLE, message: previous.message });
        if (!retry) return "blocked";
        return performDownload(location, false, seams);
    }
    const local = await seams.inspect(location.path);
    if (local === "installed") {
        setState({ phase: "installed" });
        return "ready";
    }
    // The receipt is absent, or the store is incomplete: ask consent one time, then download.
    setState({ phase: "consent" });
    const yes = await seams.confirm({ title: STORE_CONSENT_TITLE, message: STORE_CONSENT_MESSAGE });
    if (!yes) {
        setState({ phase: "declined" });
        return "blocked";
    }
    return performDownload(location, false, seams);
}

/** Hold the caller until the store is complete. A missing store passes silently; a blocked flow refuses. */
async function ensureLibStore(seams: SandboxGateSeams): Promise<"ready" | "blocked"> {
    const location = seams.resolveLocation();
    if (!location.configured) {
        // No store configured: the gate passes on the store, and only the image half applies.
        setState({ phase: "unconfigured" });
        return "ready";
    }
    if (state().phase === "installed") return "ready";
    if (storeFlowInflight !== null) return storeFlowInflight;
    storeFlowInflight = runStoreFlow(location, seams).finally(() => {
        storeFlowInflight = null;
    });
    return storeFlowInflight;
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
                text: `Sandbox image "${image}" is not present, and it is not a published variant. Build it, or set a published image and run \`inflexa sandbox pull\`.`,
            });
            return "blocked";
        case "pullable": {
            const yes = await seams.confirm({
                title: "Pull the sandbox image?",
                message: `The ${readiness.variant} sandbox image is not installed. Pull it now? (a multi-gigabyte download)`,
            });
            if (!yes) {
                seams.notify({ kind: "warn", text: "A sandbox image is necessary. Run `inflexa sandbox pull`, then retry." });
                return "blocked";
            }
            seams.notify({ kind: "info", text: `Pulling the ${readiness.variant} sandbox image${GLYPHS.ellipsis}` });
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
 * Hold a sandbox-making action until the store is complete and the image is present. Returns `ready` when
 * both are satisfied, or `blocked` when the store download or the image pull did not complete — the gate
 * reports the reason as it decides, so a `blocked` caller starts no sandbox against an empty store.
 */
export async function awaitSandboxReady(seams: SandboxGateSeams = realSandboxGateSeams): Promise<"ready" | "blocked"> {
    const store = await ensureLibStore(seams);
    if (store === "blocked") return "blocked";
    return ensureImage(seams);
}

/**
 * The app-open trigger for the background download. With no store configured it is a clean no-op. With
 * the receipt absent it runs the first-download flow (consent, then the background download), sharing the
 * gate's in-flight guard so consent is asked one time. With the store installed it resolves the tag: a
 * moved `latest` reports `update_available`, and the CLI asks before it applies the update — `force` is
 * passed only after the yes, so no update downloads silently. The app never blocks on any of this.
 */
export async function startLibStoreDownload(seams: SandboxGateSeams = realSandboxGateSeams): Promise<void> {
    const location = seams.resolveLocation();
    if (!location.configured) {
        setState({ phase: "unconfigured" });
        return;
    }
    const local = await seams.inspect(location.path);
    if (local !== "installed") {
        await ensureLibStore(seams);
        return;
    }
    setState({ phase: "installed" });
    // The tag resolves to its manifest without a blob GET, so this check downloads nothing. A transient
    // fault must not break a usable store, so an error keeps the installed state.
    const check = await seams.download(location, false);
    if (check.isErr()) return;
    if (check.value.type !== "update_available") return;
    seams.notify({ kind: "info", text: "A newer package store is available." });
    const yes = await seams.confirm({ title: STORE_UPDATE_TITLE, message: STORE_UPDATE_MESSAGE });
    if (!yes) return;
    // The update runs only after the yes. The current store stays usable, so the state stays `installed`
    // and the gate does not hold while the update downloads.
    seams.notify({ kind: "info", text: `Updating the package store${GLYPHS.ellipsis}` });
    const updated = await seams.download(location, true);
    if (updated.isErr()) {
        seams.notify({ kind: "error", text: `Could not update the package store: ${updated.error.message}` });
        return;
    }
    seams.notify({ kind: "info", text: "The package store is updated." });
}

/** Test hook: drop the gate state and the in-flight flow back to idle. Test-only. */
export function __resetSandboxGateForTest(): void {
    storeFlowInflight = null;
    setState({ phase: "idle" });
}
