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
    resolvePublicArtifactUrl,
    verifyReferenceDatasets,
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

function totalBytes(dataset: ReferenceDataCatalog["datasets"][number]): number {
    return dataset.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
}

function renderError(error: ReferenceProvisionError): string {
    return error.message;
}

async function chooseIds(catalog: ReferenceDataCatalog): Promise<readonly string[] | undefined> {
    if (catalog.datasets.length === 0) return [];
    const selected = await multiselect({
        message: "Reference datasets to download",
        required: false,
        options: catalog.datasets.map((dataset) => ({
            value: dataset.id,
            label: `${dataset.title} (${formatReferenceBytes(totalBytes(dataset))})`,
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

    const bytes =
        options.source === undefined ? await referenceDownloadBytes(ids, env.refsDir) : await referenceDownloadBytes(ids, env.refsDir, options.source);
    if (bytes.isErr()) return err(bytes.error);
    console.log(`Reference download plan: ${formatReferenceBytes(bytes.value)} missing.`);
    if (!options.yes) {
        if (!interactive) {
            return err({
                type: "download_failed",
                message: `Downloading ${formatReferenceBytes(bytes.value)} requires explicit consent; re-run with --yes.`,
            });
        }
        let confirmed: boolean;
        try {
            confirmed = await (options.confirmDownload ?? confirm)(`Download ${formatReferenceBytes(bytes.value)} of reference data into ${env.refsDir}?`);
        } catch (cause) {
            return err({ type: "download_failed", message: "Reference download confirmation failed.", cause });
        }
        if (!confirmed) {
            return ok({ installed: [], declined: true });
        }
    }
    return installReferenceDatasets(ids, {
        root: env.refsDir,
        ...(options.source === undefined ? {} : { source: options.source }),
        resolveArtifactUrl: (key) => resolvePublicArtifactUrl(key, env.referenceDataBaseUrl),
    });
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
                console.log(`  Size: ${formatReferenceBytes(totalBytes(dataset))}`);
                console.log(`  Group: ${dataset.recommendation.group}${dataset.recommendation.recommended ? " (recommended)" : ""}`);
                console.log(`  Source: ${dataset.sourceUrl}`);
                console.log(`  License: ${dataset.license.identifier}${dataset.license.url ? ` — ${dataset.license.url}` : ""}`);
            }
            if (inspection.userContent.length > 0) {
                console.log(`\nUser/unmanaged top-level content: ${inspection.userContent.join(", ")} (left untouched)`);
            }
            console.log(`\nAdd arbitrary references under ${env.refsDir}/user; sandboxes discover them dynamically.`);
            console.log("Missing a reusable option? Open a PR adding immutable metadata to the harness reference-data catalog.");
        },
        (error) => {
            console.error(`Reference-data inspection failed: ${renderError(error)}`);
            process.exitCode = 1;
        },
    );
}

/** `inflexa refs download` command action. */
export async function runRefsDownload(ids: readonly string[], options: { readonly yes?: boolean }): Promise<void> {
    const result = await downloadReferences({ ids, yes: options.yes });
    result.match(
        (outcome) => {
            if ("declined" in outcome) console.log("Cancelled — no reference data activated.");
            else if (outcome.installed.length === 0) console.log("No reference datasets selected.");
            else
                for (const installed of outcome.installed)
                    console.log(`Installed ${installed.id}@${installed.version} (${formatReferenceBytes(installed.bytesDownloaded)} downloaded).`);
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
                for (const file of dataset.files) console.log(`  ${file.state.padEnd(8)} ${file.path}`);
            }
            if (verified.some((dataset) => dataset.state !== "valid")) process.exitCode = 1;
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
