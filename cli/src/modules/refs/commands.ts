import { isCancel, log, multiselect } from "@clack/prompts";
import { REFERENCE_DATA_CATALOG, type ReferenceDataCatalog } from "@inflexa-ai/harness";
import { err, ok, type Result } from "neverthrow";

import { confirm } from "../../lib/cli.ts";
import { env } from "../../lib/env.ts";
import {
    ensureReferenceStore,
    inspectReferenceStore,
    installReferenceDatasets,
    referenceDownloadBytes,
    verifyReferenceDatasets,
    type ReferenceDownloadEstimate,
    type ReferenceInstallOutcome,
    type ReferenceCatalogSource,
    type ReferenceProvisionError,
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
    /** Explicit ids from `setup --refs`; absent means offer interactively. */
    readonly ids?: readonly string[];
    /** Explicit consent for a scripted transfer. */
    readonly yes?: boolean;
    /** Whether setup is attached to an interactive terminal. */
    readonly interactive: boolean;
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

/** Format a byte count for terminal output. */
export function formatReferenceBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
    return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

type ReferenceDatasetSize = {
    /** Bytes across artifacts the catalog can size. */
    readonly bytes: number;
    /** Artifacts whose size only the mutable upstream knows. */
    readonly unsized: number;
};

function datasetSize(dataset: ReferenceDataCatalog["datasets"][number]): ReferenceDatasetSize {
    let bytes = 0;
    let unsized = 0;
    for (const artifact of dataset.artifacts) {
        if (artifact.integrity === "pinned") bytes += artifact.bytes;
        else unsized += 1;
    }
    return { bytes, unsized };
}

/** Render a size the catalog may only partly know, without ever inventing a number. */
function formatReferenceSize(size: ReferenceDatasetSize): string {
    if (size.unsized === 0) return formatReferenceBytes(size.bytes);
    const unsized = `${size.unsized} file${size.unsized === 1 ? "" : "s"} of upstream-determined size`;
    return size.bytes === 0 ? unsized : `${formatReferenceBytes(size.bytes)} + ${unsized}`;
}

/** The strongest integrity guarantee that holds for every artifact in the dataset. */
function datasetIntegrity(dataset: ReferenceDataCatalog["datasets"][number]): "pinned" | "unpinned" | "mixed" {
    const pinned = dataset.artifacts.some((artifact) => artifact.integrity === "pinned");
    const unpinned = dataset.artifacts.some((artifact) => artifact.integrity === "unpinned");
    return pinned && unpinned ? "mixed" : unpinned ? "unpinned" : "pinned";
}

function renderIntegrity(dataset: ReferenceDataCatalog["datasets"][number]): string {
    switch (datasetIntegrity(dataset)) {
        case "pinned":
            return "pinned — verified against the checksums in the catalog";
        case "unpinned":
            return "unpinned — upstream is rebuilt in place; verified against what you downloaded";
        case "mixed":
            return "mixed — some files are checksum-pinned, others are verified against what you downloaded";
    }
}

function renderError(error: ReferenceProvisionError): string {
    return error.message;
}

function renderEstimate(estimate: ReferenceDownloadEstimate): string {
    return formatReferenceSize({ bytes: estimate.bytes, unsized: estimate.unsizedArtifacts });
}

async function chooseIds(catalog: ReferenceDataCatalog): Promise<readonly string[] | undefined> {
    if (catalog.datasets.length === 0) return [];
    const selected = await multiselect({
        message: "Reference datasets to download",
        required: false,
        options: catalog.datasets.map((dataset) => ({
            value: dataset.id,
            label: `${dataset.title} (${formatReferenceSize(datasetSize(dataset))})`,
            hint: `${dataset.recommendation.group}${dataset.recommendation.recommended ? ", recommended" : ""}`,
        })),
    });
    return isCancel(selected) ? undefined : selected;
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
            return err({
                type: "unknown_dataset",
                unknownId: "",
                availableIds: catalog.datasets.map((dataset) => dataset.id),
                message: "No reference ids supplied. Pass catalog ids explicitly on a non-interactive terminal.",
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
    const estimate = await referenceDownloadBytes(ids, env.refsDir, options.source ?? undefined, install);
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
    return installReferenceDatasets(
        ids,
        {
            root: env.refsDir,
            ...(options.source === undefined ? {} : { source: options.source }),
        },
        install,
    );
}

/** `inflexa refs path` — print the public path without creating it. */
export function runRefsPath(): void {
    console.log(env.refsDir);
}

/** `inflexa refs list` — render canonical options and recoverable local state. */
export async function runRefsList(): Promise<void> {
    const result = await inspectReferenceStore(env.refsDir);
    result.match(
        (inspection) => {
            if (inspection.datasets.length === 0) console.log("No catalog reference datasets are published by this harness version yet.");
            for (const item of inspection.datasets) {
                const dataset = item.dataset;
                console.log(`\n${dataset.id}  ${dataset.version}  ${item.state}`);
                console.log(`  ${dataset.title} — ${dataset.description}`);
                console.log(`  Size: ${formatReferenceSize(datasetSize(dataset))}`);
                console.log(`  Integrity: ${renderIntegrity(dataset)}`);
                console.log(`  Group: ${dataset.recommendation.group}${dataset.recommendation.recommended ? " (recommended)" : ""}`);
                console.log(`  Source: ${dataset.sourceUrl}`);
                console.log(`  License: ${dataset.license.identifier}${dataset.license.url ? ` — ${dataset.license.url}` : ""}`);
            }
            if (inspection.userContent.length > 0) {
                console.log(`\nUser/unmanaged top-level content: ${inspection.userContent.join(", ")} (left untouched)`);
            }
            console.log("\nEvery dataset is downloaded straight from the third party that publishes it; nothing is mirrored or re-hosted here.");
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
                            : `Installed ${installed.id}@${installed.version} (${formatReferenceBytes(installed.bytesDownloaded)} downloaded).`,
                    );
        },
        (error) => {
            console.error(`Reference-data download failed: ${renderError(error)}`);
            process.exitCode = 1;
        },
    );
}

/** `inflexa refs verify` command action. */
export async function runRefsVerify(ids: readonly string[]): Promise<void> {
    let selected = ids;
    if (selected.length === 0) {
        const inspection = await inspectReferenceStore(env.refsDir);
        if (inspection.isErr()) {
            console.error(`Reference-data verification failed: ${renderError(inspection.error)}`);
            process.exitCode = 1;
            return;
        }
        selected = inspection.value.datasets.filter((item) => item.receipt !== undefined || item.state === "invalid_receipt").map((item) => item.dataset.id);
    }
    const result = await verifyReferenceDatasets(env.refsDir, selected);
    result.match(
        (verified) => {
            if (verified.length === 0) console.log("No installed catalog reference datasets to verify.");
            for (const dataset of verified) {
                console.log(`${dataset.datasetId}${dataset.version ? `@${dataset.version}` : ""}: ${dataset.state}`);
                for (const file of dataset.files) {
                    const against = file.integrity === "pinned" ? "catalog checksum" : "checksum recorded at install";
                    console.log(`  ${file.state.padEnd(8)} ${file.path}  (vs ${against})`);
                }
            }
            const damaged = verified.filter((dataset) => dataset.state !== "valid");
            if (damaged.length > 0) {
                console.error(
                    `\nRe-download to repair: inflexa refs download ${damaged.map((dataset) => dataset.datasetId).join(" ")} --force --yes`,
                );
                process.exitCode = 1;
            }
        },
        (error) => {
            console.error(`Reference-data verification failed: ${renderError(error)}`);
            process.exitCode = 1;
        },
    );
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
        const downloaded = await downloadReferences({ ids: options.ids, yes: options.yes, interactive: options.interactive });
        return downloaded.map(() => undefined);
    }
    if (!options.interactive) {
        log.info(`Reference store: ${env.refsDir}\n  Install catalog data later with \`inflexa refs download <id...> --yes\`.`);
        return ok(undefined);
    }
    const inspection = await inspectReferenceStore(env.refsDir);
    if (inspection.isErr()) return err(inspection.error);
    const offered = inspection.value.datasets.filter((item) => item.state !== "installed").map((item) => item.dataset.id);
    if (offered.length === 0) {
        log.info("Reference store ready; no missing catalog datasets to offer.");
        return ok(undefined);
    }
    let chosen: readonly string[] | undefined;
    try {
        chosen = await chooseIds({ ...REFERENCE_DATA_CATALOG, datasets: REFERENCE_DATA_CATALOG.datasets.filter((dataset) => offered.includes(dataset.id)) });
    } catch (cause) {
        return err({ type: "download_failed", message: "Reference selection prompt failed.", cause });
    }
    if (chosen === undefined || chosen.length === 0) return ok(undefined);
    const downloaded = await downloadReferences({ ids: chosen, yes: options.yes, interactive: true });
    return downloaded.map(() => undefined);
}
