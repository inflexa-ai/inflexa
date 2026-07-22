import { groupMultiselect, isCI, isCancel, isTTY, log, progress, select } from "@clack/prompts";
import { REFERENCE_DATA_CATALOG, type ReferenceDataCatalog } from "@inflexa-ai/harness";
import { err, ok, type Result } from "neverthrow";

import { confirm } from "../../lib/cli.ts";
import { env } from "../../lib/env.ts";
import {
    buildReferenceListDocument,
    buildReferenceVerifyDocument,
    ensureReferenceStore,
    inspectReferenceStore,
    installReferenceDatasets,
    referenceDownloadEstimate,
    verifyReferenceDatasets,
    type ReferenceDownloadEstimate,
    type ReferenceDownloadProgress,
    type ReferenceInstallOutcome,
    type ReferenceCatalogSource,
    type ReferenceProvisionError,
    type ReferenceStoreInspection,
} from "./store.ts";

/** Options shared by the explicit download command and setup. */
export type ReferenceDownloadOptions = {
    /** Selected catalog ids. */
    readonly ids: readonly string[];
    /** Explicit non-interactive consent and interactive confirmation bypass. */
    readonly yes?: boolean;
    /** Re-fetch even when the active install is intact; the only way to refresh a mutable upstream. */
    readonly force?: boolean;
    /** Whether terminal prompts may be used. */
    readonly interactive?: boolean;
    /** Matching catalog/plan seam for offline tests. */
    readonly source?: ReferenceCatalogSource;
    /** Confirmation seam for text-command tests; defaults to the shared terminal prompt. */
    readonly confirmDownload?: (question: string) => Promise<boolean>;
};

/** Setup-specific reference selection. */
export type ReferenceSetupOptions = {
    /** Explicit ids from `setup --refs`; absent means offer interactively (or default to recommended when headless). */
    readonly ids?: readonly string[];
    /** Explicit consent for a scripted transfer. */
    readonly yes?: boolean;
    /** Whether setup is attached to an interactive terminal. */
    readonly interactive: boolean;
    /** Matching catalog/plan seam for offline tests, mirroring the download path. */
    readonly source?: ReferenceCatalogSource;
};

/** A selection was cancelled before transfer. */
export type DeclinedReferenceDownload = {
    /** No dataset was activated. */
    readonly installed: readonly [];
    /** Distinguishes cancellation from an empty successful plan. */
    readonly declined: true;
};

/** Parse a comma-separated setup selection into stable, non-empty ids. */
export function parseReferenceIds(value: string | undefined): readonly string[] | undefined {
    if (value === undefined) return undefined;
    return [
        ...new Set(
            value
                .split(",")
                .map((id) => id.trim())
                .filter(Boolean),
        ),
    ];
}

/** A file count phrased for the terminal — the catalog pins no sizes, so the upstream determines
 * the bytes at download time and the honest thing to state ahead of time is the number of files. */
function formatFileCount(count: number): string {
    return `${count} file${count === 1 ? "" : "s"} of upstream-determined size`;
}

function formatDatasetSize(dataset: ReferenceDataCatalog["datasets"][number]): string {
    return formatFileCount(dataset.artifacts.length);
}

function renderError(error: ReferenceProvisionError): string {
    return error.message;
}

function renderEstimate(estimate: ReferenceDownloadEstimate): string {
    return formatFileCount(estimate.artifactsToFetch);
}

/** The up-front choice, resolved against whatever set of datasets the caller is offering. */
export type ReferencePreset = "recommended" | "all" | "none" | "custom";

/**
 * What to tell someone who takes nothing now. Both routes are real: `refs download` is a registered
 * command, and it is classified `approval` in the command registry, so the conversation agent can
 * propose exactly that argv through `run_inflexa` and the user approves it in chat. The agent offers
 * the download — it never performs one unattended, and the wording promises nothing more than that.
 */
export const ON_DEMAND_REFERENCE_NOTE =
    "No references now — nothing here needs them until an analysis does.\n" +
    "  Grab one whenever you want with `inflexa refs download <id>`,\n" +
    "  or just tell the agent what you need: it picks the dataset and asks you to approve the download.";

/** The per-dataset escape: the full grouped listing, opening with nothing selected. */
async function pickDatasets(catalog: ReferenceDataCatalog): Promise<readonly string[] | undefined> {
    // Present the picker as labelled categories rather than one flat wall: the catalog already
    // carries `recommendation.group` per dataset, so grouping is purely presentational. Group
    // insertion order follows first appearance in the catalog (which is ordered by group), and
    // toggling a group header selects every dataset under it — clack returns only the leaf ids,
    // never the group label, so the strict resolver downstream never sees a phantom id.
    const grouped: Record<string, { value: string; label: string; hint?: string }[]> = {};
    for (const dataset of catalog.datasets) {
        (grouped[dataset.recommendation.group] ??= []).push({
            value: dataset.id,
            label: `${dataset.title} (${formatDatasetSize(dataset)})`,
            ...(dataset.recommendation.recommended ? { hint: "recommended" } : {}),
        });
    }
    // Deliberately no `initialValues`. Someone who came this far past three one-keystroke presets is
    // here to name datasets, and seeding the recommended set would put them back where the presets
    // exist to rescue them from: unpicking 32 boxes to arrive at a smaller install.
    const selected = await groupMultiselect({
        message: "Pick the reference datasets to download",
        required: false,
        selectableGroups: true,
        options: grouped,
    });
    return isCancel(selected) ? undefined : selected;
}

/** One entry of the preset prompt. */
export type ReferencePresetOption = {
    /** Preset this entry chooses. */
    readonly value: ReferencePreset;
    /** Entry text. */
    readonly label: string;
    /** Counts, or what the preset defers to later. */
    readonly hint: string;
};

/** The preset prompt's entries and the one it opens on. */
export type ReferencePresetPrompt = {
    /** Entries in display order; the first is what an unmatched initial value would land on. */
    readonly options: readonly ReferencePresetOption[];
    /** The entry the cursor starts on. Always one of `options`. */
    readonly initialValue: ReferencePreset;
};

/**
 * Build the preset prompt for the datasets `catalog` is offering.
 *
 * The initial value is derived from the entries that actually exist rather than named ahead of them,
 * and that is load-bearing: clack resolves an unmatched `initialValue` with
 * `findIndex(...) === -1 ? 0 : index`, so naming an absent entry silently arms whatever sits first —
 * "Everything". An offered set with nothing recommended is ordinary (re-running setup once the
 * recommended datasets are installed leaves only the optional ones), so that path would have opened
 * the prompt pre-armed on the maximal install and turned an unexamined Enter into the largest
 * possible download. When there is nothing to recommend the prompt opens on "Nothing for now"
 * instead: a default that installs nothing costs one keystroke to undo, one that installs everything
 * costs a transfer.
 */
export function referencePresetPrompt(catalog: ReferenceDataCatalog): ReferencePresetPrompt {
    const recommended = catalog.datasets.filter((dataset) => dataset.recommendation.recommended).map((dataset) => dataset.id);
    const artifactsIn = (ids: readonly string[]): number => {
        const selected = new Set(ids);
        return catalog.datasets.filter((dataset) => selected.has(dataset.id)).reduce((total, dataset) => total + dataset.artifacts.length, 0);
    };
    const everything = catalog.datasets.map((dataset) => dataset.id);

    return {
        options: [
            // Recommended leads when it exists: it is the working set the enrichment, network, and
            // single-cell skills are built on, so an untouched prompt plus Enter still plans the
            // install most people want — now as a named choice rather than 32 pre-ticked boxes.
            ...(recommended.length > 0
                ? [
                      {
                          value: "recommended" as const,
                          label: "Recommended",
                          hint: `${recommended.length} datasets · ${formatFileCount(artifactsIn(recommended))}`,
                      },
                  ]
                : []),
            { value: "all", label: "Everything", hint: `${everything.length} datasets · ${formatFileCount(artifactsIn(everything))}` },
            { value: "none", label: "Nothing for now", hint: "fetch them later, on demand" },
            { value: "custom", label: "Choose specific datasets…", hint: "pick from the full list" },
        ],
        initialValue: recommended.length > 0 ? "recommended" : "none",
    };
}

async function chooseIds(catalog: ReferenceDataCatalog): Promise<readonly string[] | undefined> {
    if (catalog.datasets.length === 0) return [];
    const prompt = referencePresetPrompt(catalog);
    const preset = await select<ReferencePreset>({
        message: "Reference datasets to download",
        initialValue: prompt.initialValue,
        // Spread into a mutable array: clack's option type is not readonly, and the prompt is built
        // as immutable data so it can be asserted on without a terminal.
        options: [...prompt.options],
    });
    if (isCancel(preset)) return undefined;
    return resolveReferencePreset(preset, catalog, { pick: () => pickDatasets(catalog) });
}

/**
 * Turn a chosen preset into the ids it selects, against the datasets `catalog` is offering. Pure but
 * for the two injected effects: `pick` opens the per-dataset escape (only `custom` reaches it), and
 * `announce` says how to get references later whenever the outcome is an empty selection. Both are
 * parameters so the resolution can be exercised without a terminal. `undefined` means cancelled, and
 * is distinct from an empty selection.
 */
export async function resolveReferencePreset(
    preset: ReferencePreset,
    catalog: ReferenceDataCatalog,
    deps: { readonly pick: () => Promise<readonly string[] | undefined>; readonly announce?: (message: string) => void },
): Promise<readonly string[] | undefined> {
    const chosen = await (async (): Promise<readonly string[] | undefined> => {
        switch (preset) {
            case "all":
                return catalog.datasets.map((dataset) => dataset.id);
            case "recommended":
                // Never widened to everything when the offered set carries no recommendation: a
                // preset that quietly installs more than its name says is worse than one that
                // installs nothing, and "nothing" is a state this flow already handles.
                return catalog.datasets.filter((dataset) => dataset.recommendation.recommended).map((dataset) => dataset.id);
            case "none":
                return [];
            case "custom":
                return deps.pick();
            default: {
                const unreachable: never = preset;
                throw new Error(`unhandled reference preset: ${String(unreachable)}`);
            }
        }
    })();

    if (chosen === undefined) return undefined;
    // Same note for an explicit "none" and for a picker submitted empty — the outcome is identical,
    // and someone who lands there by either route needs the same answer to "so how do I get one?".
    // Called through a wrapper rather than passed as a bare reference: clack happens to define
    // `log.info` as an arrow, but a bare reference would break silently the day it becomes a method
    // that needs its receiver.
    if (chosen.length === 0) (deps.announce ?? ((message: string) => log.info(message)))(ON_DEMAND_REFERENCE_NOTE);
    return chosen;
}

/**
 * Trailing window the transfer rate is measured over. Long enough that one slow chunk does not read
 * as a stall, short enough that the number describes the connection now rather than its whole history.
 */
export const PROGRESS_RATE_WINDOW_MS = 3_000;
/** Minimum span the window must cover before a rate is stated at all — below it the number is noise. */
const PROGRESS_RATE_MIN_SPAN_MS = 1_000;
/** Floor between redraws, so a fast connection spends its time transferring rather than repainting. */
const PROGRESS_REFRESH_MS = 100;

/** What the readout knows at one moment; every sink renders from this and formats nothing itself. */
export type ReferenceProgressSnapshot = {
    /** Canonical readout — `12/38 files · 1.4 GB · 8.2 MB/s`, rate segment absent until measurable. */
    readonly line: string;
    /** Artifacts finished, never greater than `total`. */
    readonly completed: number;
    /** Artifacts the plan plans to fetch. */
    readonly total: number;
    /** Artifact in flight or just finished; absent before the first one opens. */
    readonly path?: string;
};

/**
 * Where a readout is painted. Two realizations exist — an animated clack bar and plain lines — and
 * tests supply a third that records snapshots, which is what keeps the formatting assertions honest
 * without a terminal.
 */
export type ReferenceProgressSink = {
    /** Opened once, before any artifact starts. */
    readonly start: (snapshot: ReferenceProgressSnapshot) => void;
    /** The byte/rate tail moved; no artifact finished. */
    readonly refresh: (snapshot: ReferenceProgressSnapshot) => void;
    /** An artifact finished. */
    readonly advance: (snapshot: ReferenceProgressSnapshot) => void;
    /** Closed once; `failure` carries the message when the transfer ended badly. */
    readonly finish: (snapshot: ReferenceProgressSnapshot, failure?: string) => void;
};

/** The animated readout: one clack progress bar over the whole plan. */
function clackProgressSink(total: number): ReferenceProgressSink {
    const bar = progress({ style: "block", max: total });
    let painted = 0;
    return {
        start: (snapshot) => bar.start(snapshot.line),
        refresh: (snapshot) => bar.message(snapshot.line),
        advance: (snapshot) => {
            // Advance by the delta against what the bar has already been told, so a clamped count
            // (a transfer that outran its estimate) refreshes the text without pushing the bar past
            // its own max.
            const step = snapshot.completed - painted;
            painted = snapshot.completed;
            if (step > 0) bar.advance(step, snapshot.line);
            else bar.message(snapshot.line);
        },
        finish: (snapshot, failure) => {
            if (failure === undefined) bar.stop(`Downloaded ${snapshot.line}`);
            else bar.error(`Download failed at ${snapshot.line}`);
        },
    };
}

/**
 * The captured-log readout: one line per completed artifact. Byte deltas paint nothing — a line per
 * chunk would bury the surrounding output in a log nobody can read. Exported because the terminal
 * check that selects it cannot be reached from a test process, and an untested log format is one
 * that silently grows escape codes.
 */
export function plainProgressSink(): ReferenceProgressSink {
    return {
        start: (snapshot) => console.log(`Downloading ${snapshot.total} reference file${snapshot.total === 1 ? "" : "s"}…`),
        refresh: () => undefined,
        advance: (snapshot) => console.log(`  ${snapshot.line}${snapshot.path === undefined ? "" : ` — ${snapshot.path}`}`),
        finish: (snapshot, failure) => console.log(failure === undefined ? `Downloaded ${snapshot.line}` : `Download failed at ${snapshot.line}`),
    };
}

/** A live readout over one transfer plan. */
export type ReferenceDownloadProgressReporter = {
    /** Feed one installer event. */
    readonly report: (event: ReferenceDownloadProgress) => void;
    /** Close the readout; always call it, on both the success and failure paths. */
    readonly finish: (failure?: string) => void;
};

/**
 * Build the combined readout for a plan of `totalArtifacts` files, or `undefined` when there is
 * nothing to draw. Returning `undefined` for an empty plan is the point: an all-intact selection
 * legitimately fetches zero files, and a bar whose denominator is zero has nothing to say — the
 * caller's existing summary already reports that outcome.
 *
 * Pass `sink` to render somewhere other than this process's terminal (tests do); by default the
 * animated bar is used only on a real interactive terminal, and captured output gets plain lines.
 */
export function createReferenceDownloadProgress(totalArtifacts: number, sink?: ReferenceProgressSink): ReferenceDownloadProgressReporter | undefined {
    if (!Number.isFinite(totalArtifacts) || totalArtifacts <= 0) return undefined;
    const total = Math.floor(totalArtifacts);
    const painter = sink ?? (isTTY(process.stdout) && !isCI() ? clackProgressSink(total) : plainProgressSink());

    let completed = 0;
    let bytes = 0;
    let path: string | undefined;
    let lastRefreshAt = 0;
    // Per-artifact progress for everything currently open, kept apart from the plan totals: the
    // active set is the only place a declared size can honestly be spent, since the plan's remaining
    // files have not been requested yet. Keyed by dataset and path because several transfer at once.
    const inFlight = new Map<string, { bytes: number; readonly declared?: number }>();
    const artifactKey = (datasetId: string, artifactPath: string): string => `${datasetId}/${artifactPath}`;
    // Cumulative-byte samples inside the window. Sampling is throttled with the redraw, so this holds
    // tens of entries rather than one per chunk.
    const samples: { at: number; bytes: number }[] = [];

    function rateBytesPerSecond(now: number): number | undefined {
        const first = samples[0];
        const last = samples[samples.length - 1];
        if (first === undefined || last === undefined) return undefined;
        // A stalled transfer emits nothing, so the newest sample simply ages. Reading its age against
        // `now` — rather than against the last sample — is what makes the rate decay to nothing
        // instead of freezing at whatever the connection was doing before it stopped.
        if (now - last.at > PROGRESS_RATE_WINDOW_MS) return undefined;
        const span = last.at - first.at;
        // Both guards matter: a window that has not filled yet would state a rate off one burst, and
        // a zero span would divide by zero. Either way the honest readout is no rate at all.
        if (span < PROGRESS_RATE_MIN_SPAN_MS) return undefined;
        const moved = last.bytes - first.bytes;
        return moved > 0 ? (moved / span) * 1000 : undefined;
    }

    /**
     * The active set: how many artifacts are open, and — only when every one of them declared a size
     * — the bytes received against the bytes declared across exactly those artifacts. Partial
     * knowledge yields the count alone rather than a denominator covering some of the set, which
     * would read as a total while describing a subset. Labelled "in flight" so it can never be
     * mistaken for the plan, whose byte total remains unknowable.
     */
    function renderInFlight(): string {
        if (inFlight.size === 0) return "";
        const active = [...inFlight.values()];
        const label = ` · ${active.length} in flight`;
        if (!active.every((artifact) => artifact.declared !== undefined)) return label;
        const received = active.reduce((total, artifact) => total + artifact.bytes, 0);
        // `?? 0` is unreachable — the `every` above proves each `declared` is present — and is used
        // in place of a non-null assertion so the arithmetic carries no escape hatch.
        const declared = active.reduce((total, artifact) => total + (artifact.declared ?? 0), 0);
        return `${label} ${received.formatBytes()}/${declared.formatBytes()}`;
    }

    function snapshot(now: number = Date.now()): ReferenceProgressSnapshot {
        const rate = rateBytesPerSecond(now);
        const line = `${completed}/${total} files · ${bytes.formatBytes()}${rate === undefined ? "" : ` · ${rate.formatBytes()}/s`}${renderInFlight()}`;
        return { line, completed, total, ...(path === undefined ? {} : { path }) };
    }

    painter.start(snapshot());
    // Nothing else repaints a stalled transfer: byte events are the only other trigger, and a stall
    // is precisely their absence. Unref'd so a hung download never holds the process open on its own.
    const heartbeat = setInterval(() => painter.refresh(snapshot()), PROGRESS_RATE_WINDOW_MS);
    heartbeat.unref();

    return {
        report: (event) => {
            const now = Date.now();
            switch (event.type) {
                case "artifact_started":
                    path = event.path;
                    inFlight.set(artifactKey(event.datasetId, event.path), {
                        bytes: 0,
                        ...(event.declaredBytes === undefined ? {} : { declared: event.declaredBytes }),
                    });
                    painter.refresh(snapshot(now));
                    return;
                case "artifact_bytes": {
                    bytes += event.bytes;
                    // Attributed to its own artifact, never to "the current one": with several
                    // transfers open, the most recently started is not the one these bytes came from.
                    const artifact = inFlight.get(artifactKey(event.datasetId, event.path));
                    if (artifact !== undefined) artifact.bytes += event.bytes;
                    if (now - lastRefreshAt < PROGRESS_REFRESH_MS) return;
                    lastRefreshAt = now;
                    samples.push({ at: now, bytes });
                    while (samples.length > 1 && now - (samples[0]?.at ?? now) > PROGRESS_RATE_WINDOW_MS) samples.shift();
                    painter.refresh(snapshot(now));
                    return;
                }
                case "artifact_completed":
                    path = event.path;
                    // Leaves the active set the moment it lands: a declared size describes the
                    // artifact that declared it, and what is still open is what the readout is about.
                    inFlight.delete(artifactKey(event.datasetId, event.path));
                    // Clamped, not incremented blindly: the estimate and the installer each decide
                    // "already intact" by digest at different moments, so a dataset damaged in between
                    // adds fetches the plan never predicted. The final summary stays authoritative.
                    completed = Math.min(completed + 1, total);
                    painter.advance(snapshot(now));
                    return;
                default: {
                    const unreachable: never = event;
                    throw new Error(`unhandled reference progress event: ${JSON.stringify(unreachable)}`);
                }
            }
        },
        finish: (failure) => {
            clearInterval(heartbeat);
            // Nothing is in flight once the plan is over — including on the failure path, where
            // whatever was open was abandoned rather than completed. The closing line reports totals.
            inFlight.clear();
            painter.finish(snapshot(), failure);
        },
    };
}

/** Headless, reusable download operation after selection and consent policy are resolved. */
export async function downloadReferences(
    options: ReferenceDownloadOptions,
): Promise<Result<ReferenceInstallOutcome | DeclinedReferenceDownload, ReferenceProvisionError>> {
    const catalog = options.source?.catalog ?? REFERENCE_DATA_CATALOG;
    const interactive = options.interactive ?? process.stdin.isTTY;
    let ids = options.ids;
    if (ids.length === 0) {
        if (!interactive) {
            // Not `unknown_dataset`: nothing was requested, so there is no unknown id to name. That
            // variant carries the id that missed, and an empty string there is a lie a caller could
            // pattern-match on.
            return err({
                type: "download_failed",
                message: `No reference ids supplied. Pass catalog ids explicitly on a non-interactive terminal. Available ids: ${catalog.datasets
                    .map((dataset) => dataset.id)
                    .join(", ")}`,
            });
        }
        let chosen: readonly string[] | undefined;
        try {
            chosen = await chooseIds(catalog);
        } catch (cause) {
            return err({ type: "download_failed", message: "Reference selection prompt failed.", cause });
        }
        if (chosen === undefined || chosen.length === 0) return ok({ installed: [], declined: true });
        ids = chosen;
    }

    const install = { force: options.force ?? false };
    const estimate = await referenceDownloadEstimate(ids, env.refsDir, options.source ?? undefined, install);
    if (estimate.isErr()) return err(estimate.error);
    const size = renderEstimate(estimate.value);
    console.log(`Reference download plan: ${size} to fetch from the upstream publishers.`);
    if (!options.yes) {
        if (!interactive) {
            return err({
                type: "download_failed",
                message: `Downloading ${size} requires explicit consent; re-run with --yes.`,
            });
        }
        let confirmed: boolean;
        try {
            confirmed = await (options.confirmDownload ?? confirm)(`Download ${size} of reference data into ${env.refsDir}?`);
        } catch (cause) {
            return err({ type: "download_failed", message: "Reference download confirmation failed.", cause });
        }
        if (!confirmed) {
            return ok({ installed: [], declined: true });
        }
    }
    // Built only after consent, so nothing is drawn for a transfer the user has not agreed to, and
    // absent entirely when the plan fetches nothing.
    const readout = createReferenceDownloadProgress(estimate.value.artifactsToFetch);
    let installed: Result<ReferenceInstallOutcome, ReferenceProvisionError> | undefined;
    try {
        installed = await installReferenceDatasets(
            ids,
            {
                root: env.refsDir,
                ...(options.source === undefined ? {} : { source: options.source }),
                ...(readout === undefined ? {} : { onProgress: readout.report }),
            },
            install,
        );
        return installed;
    } finally {
        // A live readout owns a repaint timer and holds the terminal in the bar's render state, so it
        // has to be closed on every exit — including one the installer's own `Result` channel cannot
        // describe, such as a caller-supplied catalog seam that throws. `installed` is undefined only
        // on that path, which is exactly the case the failure wording is for.
        readout?.finish(installed === undefined ? "the transfer ended unexpectedly" : installed.isErr() ? installed.error.message : undefined);
    }
}

/** `inflexa refs path` — print the public path without creating it. */
export function runRefsPath(): void {
    console.log(env.refsDir);
}

/**
 * `inflexa refs list` — render canonical options and recoverable local state. Pass `urls` to also
 * print the exact upstream download URL of every artifact, so the source is inspectable before consent.
 * Pass `json` for the machine-readable document instead of prose; `urls` has no effect on it (artifact
 * URLs are always in the JSON). `source` is a catalog seam for offline tests, mirroring the download path.
 */
export async function runRefsList(options: { readonly urls?: boolean; readonly json?: boolean; readonly source?: ReferenceCatalogSource } = {}): Promise<void> {
    const result = await inspectReferenceStore(env.refsDir, options.source?.catalog);
    if (options.json) {
        // Stdout purity: exactly one document on success (console.log supplies the trailing newline),
        // nothing on failure — the same prose the human mode prints goes to stderr with a non-zero exit.
        result.match(
            (inspection) => console.log(JSON.stringify(buildReferenceListDocument(inspection, env.refsDir), null, 2)),
            (error) => {
                console.error(`Reference-data inspection failed: ${renderError(error)}`);
                process.exitCode = 1;
            },
        );
        return;
    }
    result.match(
        (inspection) => {
            if (inspection.datasets.length === 0) console.log("No catalog reference datasets are published by this harness version yet.");
            // Datasets arrive in catalog order, which clusters by group, so a header printed on each
            // group change renders the listing as labelled categories instead of one flat wall.
            let lastGroup: string | undefined;
            for (const item of inspection.datasets) {
                const dataset = item.dataset;
                if (dataset.recommendation.group !== lastGroup) {
                    lastGroup = dataset.recommendation.group;
                    console.log(`\n== ${lastGroup} ==`);
                }
                console.log(`\n${dataset.id}  ${dataset.version}  ${item.state}${dataset.recommendation.recommended ? "" : "  (optional)"}`);
                console.log(`  ${dataset.title} — ${dataset.description}`);
                console.log(`  Size: ${formatDatasetSize(dataset)}`);
                console.log(`  Source: ${dataset.sourceUrl}`);
                console.log(`  License: ${dataset.license.identifier}${dataset.license.url ? ` — ${dataset.license.url}` : ""}`);
                if (options.urls) for (const artifact of dataset.artifacts) console.log(`  URL: ${artifact.url}`);
            }
            if (inspection.userContent.length > 0) {
                console.log(`\nUser/unmanaged top-level content: ${inspection.userContent.join(", ")} (left untouched)`);
            }
            console.log(
                "\nEvery dataset is fetched straight over HTTPS from the third party that publishes it; nothing is mirrored, re-hosted, or checksum-pinned here.",
            );
            console.log("Integrity is trust-on-first-use: `inflexa refs verify` checks each installed file against the copy you downloaded.");
            if (!options.urls) console.log("Re-run with `--urls` to print the exact upstream URL of every file.");
            console.log(`Add arbitrary references under ${env.refsDir}/user; sandboxes discover them dynamically.`);
            console.log("Missing a reusable option? Open a PR adding its upstream URL, provenance, and licensing to the harness reference-data catalog.");
        },
        (error) => {
            console.error(`Reference-data inspection failed: ${renderError(error)}`);
            process.exitCode = 1;
        },
    );
}

/** `inflexa refs download` command action. */
export async function runRefsDownload(ids: readonly string[], options: { readonly yes?: boolean; readonly force?: boolean }): Promise<void> {
    const result = await downloadReferences({ ids, yes: options.yes, force: options.force });
    result.match(
        (outcome) => {
            if ("declined" in outcome) console.log("Cancelled — no reference data activated.");
            else if (outcome.installed.length === 0) console.log("No reference datasets selected.");
            else
                for (const installed of outcome.installed)
                    console.log(
                        installed.bytesDownloaded === 0
                            ? `Already installed and intact: ${installed.id}@${installed.version} (nothing downloaded).`
                            : `Installed ${installed.id}@${installed.version} (${installed.bytesDownloaded.formatBytes()} downloaded).`,
                    );
        },
        (error) => {
            console.error(`Reference-data download failed: ${renderError(error)}`);
            process.exitCode = 1;
        },
    );
}

/**
 * `inflexa refs verify` command action. Pass `json` for the machine-readable document instead of prose.
 * `source` is a catalog/plan seam for offline tests that must reach both the no-ids selection inspection
 * and the verification itself, mirroring the download path.
 */
export async function runRefsVerify(
    ids: readonly string[],
    options: { readonly json?: boolean; readonly source?: ReferenceCatalogSource } = {},
): Promise<void> {
    let selected = ids;
    if (selected.length === 0) {
        const inspection = await inspectReferenceStore(env.refsDir, options.source?.catalog);
        if (inspection.isErr()) {
            console.error(`Reference-data verification failed: ${renderError(inspection.error)}`);
            process.exitCode = 1;
            return;
        }
        selected = inspection.value.datasets.filter((item) => item.receipt !== undefined || item.state === "invalid_receipt").map((item) => item.dataset.id);
    }
    const result = await verifyReferenceDatasets(env.refsDir, selected, options.source);
    if (options.json) {
        // The document already carries the damaged states, so a non-zero exit is enough to flag damage —
        // the human mode's "Re-download to repair" hint is suppressed to keep stderr for genuine failures.
        result.match(
            (verified) => {
                console.log(JSON.stringify(buildReferenceVerifyDocument(verified), null, 2));
                if (verified.some((dataset) => dataset.state !== "valid")) process.exitCode = 1;
            },
            (error) => {
                console.error(`Reference-data verification failed: ${renderError(error)}`);
                process.exitCode = 1;
            },
        );
        return;
    }
    result.match(
        (verified) => {
            if (verified.length === 0) console.log("No installed catalog reference datasets to verify.");
            for (const dataset of verified) {
                console.log(`${dataset.datasetId}${dataset.version ? `@${dataset.version}` : ""}: ${dataset.state}`);
                for (const file of dataset.files) {
                    console.log(`  ${file.state.padEnd(8)} ${file.path}  (vs the checksum recorded at install)`);
                }
            }
            const damaged = verified.filter((dataset) => dataset.state !== "valid");
            if (damaged.length > 0) {
                console.error(`\nRe-download to repair: inflexa refs download ${damaged.map((dataset) => dataset.datasetId).join(" ")} --force --yes`);
                process.exitCode = 1;
            }
        },
        (error) => {
            console.error(`Reference-data verification failed: ${renderError(error)}`);
            process.exitCode = 1;
        },
    );
}

/**
 * The datasets setup actually offers: everything the catalog names except what is already installed
 * and intact. Every preset resolves against this, not the raw catalog — which is what keeps
 * "Everything" from meaning "re-fetch what you already have" and keeps an intact store out of the
 * counts shown on the prompt.
 */
export function offeredReferenceCatalog(catalog: ReferenceDataCatalog, inspection: ReferenceStoreInspection): ReferenceDataCatalog {
    const offered = new Set(inspection.datasets.filter((item) => item.state !== "installed").map((item) => item.dataset.id));
    return { ...catalog, datasets: catalog.datasets.filter((dataset) => offered.has(dataset.id)) };
}

/** Deliberate reference-store setup reused by the main setup wizard. */
export async function runReferenceSetup(options: ReferenceSetupOptions): Promise<Result<void, ReferenceProvisionError>> {
    const created = await ensureReferenceStore(env.refsDir);
    if (created.isErr()) return err(created.error);
    if (options.ids !== undefined) {
        if (options.ids.length === 0) return ok(undefined);
        if (!options.interactive && !options.yes) {
            log.info(`Reference selection was not downloaded without explicit consent.\n  Re-run setup with --refs ${options.ids.join(",")} --yes.`);
            return ok(undefined);
        }
        const downloaded = await downloadReferences({
            ids: options.ids,
            yes: options.yes,
            interactive: options.interactive,
            ...(options.source === undefined ? {} : { source: options.source }),
        });
        return downloaded.map(() => undefined);
    }
    const activeCatalog = options.source?.catalog ?? REFERENCE_DATA_CATALOG;
    const inspection = await inspectReferenceStore(env.refsDir, options.source?.catalog);
    if (inspection.isErr()) return err(inspection.error);
    const offered = inspection.value.datasets.filter((item) => item.state !== "installed");
    if (offered.length === 0) {
        log.info("Reference store ready; no missing catalog datasets to offer.");
        return ok(undefined);
    }
    // `--refs` omitted on a headless terminal used to install nothing, so an unattended setup left the
    // enrichment/network/single-cell skills with no data to stand on. Default to the catalog's
    // recommended set instead — the only signal for what a working install looks like — while still
    // gating the transfer on the same explicit `--yes` consent every other download path requires.
    if (!options.interactive) {
        const recommendedOffered = offered.filter((item) => item.dataset.recommendation.recommended).map((item) => item.dataset.id);
        if (recommendedOffered.length === 0) {
            log.info(`Reference store: ${env.refsDir}\n  Install catalog data later with \`inflexa refs download <id...> --yes\`.`);
            return ok(undefined);
        }
        if (!options.yes) {
            log.info(
                `Reference store: ${env.refsDir}\n  ${recommendedOffered.length} recommended dataset(s) are the default install but need explicit consent.\n  Re-run setup with --yes, or \`inflexa refs download ${recommendedOffered.join(" ")} --yes\`.`,
            );
            return ok(undefined);
        }
        const downloaded = await downloadReferences({
            ids: recommendedOffered,
            yes: true,
            interactive: false,
            ...(options.source === undefined ? {} : { source: options.source }),
        });
        return downloaded.map(() => undefined);
    }
    let chosen: readonly string[] | undefined;
    try {
        chosen = await chooseIds(offeredReferenceCatalog(activeCatalog, inspection.value));
    } catch (cause) {
        return err({ type: "download_failed", message: "Reference selection prompt failed.", cause });
    }
    if (chosen === undefined || chosen.length === 0) return ok(undefined);
    const downloaded = await downloadReferences({
        ids: chosen,
        yes: options.yes,
        interactive: true,
        ...(options.source === undefined ? {} : { source: options.source }),
    });
    return downloaded.map(() => undefined);
}
