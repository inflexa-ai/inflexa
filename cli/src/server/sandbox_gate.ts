import { existsSync } from "node:fs";
import { join } from "node:path";

import { FARM_LOCK_FILE } from "@inflexa-ai/harness";
import { ResultAsync, type Result } from "neverthrow";

import type { SandboxImageReadiness, SandboxReadiness } from "../api/runs.ts";
import { countAnalysisInputs } from "../db/primary_query.ts";
import { describeCause } from "../lib/cause.ts";
import { ensureRuntime } from "../lib/config.ts";
import { capture } from "../lib/container.ts";
import { env } from "../lib/env.ts";
import { analysisFarmPath, catalogFarmPath, takeFarmCompositionFailure } from "../modules/libs/composition.ts";
import { isPublishedSandboxImage } from "../modules/libs/images.ts";
import { configuredSandboxImage } from "../modules/libs/pull.ts";
import { inspectStoreContent } from "../modules/libs/store_download.ts";
import { readTransferReports, type TransferReport } from "../modules/libs/transfers.ts";
import type { TransferKind } from "../types/store.ts";

/** The first line of a multi-line message, so a hint with its remedy stays one line. */
function firstLine(text: string): string {
    return text.split("\n", 1)[0] ?? text;
}

/** The state of the configured sandbox image in the container engine, with no pull. */
async function imageReadiness(image: string): Promise<SandboxImageReadiness> {
    const engine = await ensureRuntime();
    if (engine.isErr()) return { state: "engine_error", image, message: firstLine(engine.error.message) };
    const inspected = await ResultAsync.fromPromise(capture(engine.value, ["image", "inspect", image]), (cause) => cause);
    if (inspected.isErr()) return { state: "engine_error", image, message: `The container engine is not reachable (${describeCause(inspected.error)}).` };
    if (inspected.value.code === 0) return { state: "present", image };
    return isPublishedSandboxImage(image) ? { state: "absent", image } : { state: "custom", image };
}

/**
 * The verdict of the machine for a sandbox of the analysis: the engine inspect of the image, the store content,
 * and the farm. The read consumes a recorded farm-composition failure, thus the next sandbox action composes
 * again.
 */
export async function readSandboxReadiness(analysisId: string): Promise<Omit<SandboxReadiness, "inputCount">> {
    const storeRoot = env.packageStoreDir;
    const [image, store] = await Promise.all([imageReadiness(configuredSandboxImage()), inspectStoreContent(storeRoot)]);
    return {
        image,
        store,
        farm: {
            present: existsSync(join(analysisFarmPath(storeRoot, analysisId), FARM_LOCK_FILE)),
            catalogPresent: existsSync(join(catalogFarmPath(storeRoot), FARM_LOCK_FILE)),
            failure: takeFarmCompositionFailure(analysisId)?.reason ?? null,
        },
    };
}

/** What {@link sandboxRefusal} reads. Tests replace each one. */
export type SandboxGateOpts = {
    readonly inputCount: (analysisId: string) => Result<number, unknown>;
    readonly transfers: () => readonly TransferReport[];
    readonly readiness: (analysisId: string) => Promise<Omit<SandboxReadiness, "inputCount">>;
};

/** The production {@link SandboxGateOpts}. */
export const DEFAULT_SANDBOX_GATE_OPTS: SandboxGateOpts = {
    inputCount: countAnalysisInputs,
    transfers: readTransferReports,
    readiness: readSandboxReadiness,
};

/**
 * Why a profile of the analysis cannot start a sandbox now, or `null` when it can. Each profile drive of the
 * server asks this first: the chat open, the deliberate re-profile, and the re-profile after an input change.
 * The refusal is one line for a person, with the command that repairs the machine.
 *
 * A live transfer refuses before the machine is read: an image pull or a catalog merge changes what a sandbox
 * mounts, and the read of the machine consumes a recorded farm failure that the next check must still see.
 */
export async function sandboxRefusal(analysisId: string, opts: SandboxGateOpts = DEFAULT_SANDBOX_GATE_OPTS): Promise<string | null> {
    // An analysis with no inputs profiles nothing, thus it needs no image and no store. A failed count falls
    // through to the checks.
    if (opts.inputCount(analysisId).unwrapOr(null) === 0) return null;
    const transfers = opts.transfers();
    if (transfers.some((report) => report.live)) {
        return "A sandbox download is in flight. Run `inflexa sandbox status` to watch it, then try again when it ends.";
    }
    return machineRefusal(await opts.readiness(analysisId), transfers);
}

/**
 * The refusal of the machine verdict, or `null`. The filesystem and the engine decide usability, never a
 * transfer row: a store that `inflexa store add` built has no catalog receipt and serves a sandbox. The row of
 * the kind gives only the reason of a refusal.
 */
function machineRefusal(machine: Omit<SandboxReadiness, "inputCount">, transfers: readonly TransferReport[]): string | null {
    const image = machine.image;
    switch (image.state) {
        case "present":
            break;
        case "engine_error":
            return image.message;
        case "custom":
            return `Sandbox image "${image.image}" is not present, and it is not the published image, thus no registry can supply it. Build it, or set the published image and run \`inflexa sandbox pull\`.`;
        case "absent":
            return `The sandbox image is not installed.${failureDetail(transfers, "runtime_image")} Run \`inflexa sandbox pull\` to download it.`;
        default: {
            const exhaustive: never = image;
            throw new Error(`unhandled image state: ${JSON.stringify(exhaustive)}`);
        }
    }

    const content = machine.store;
    if (content !== "installed" && content !== "local") {
        const catalog = transfers.find((report) => report.kind === "catalog")?.state;
        const reason =
            catalog === "declined"
                ? "The package store was declined at setup, and the analysis sandbox needs it."
                : catalog === "canceled"
                  ? "You stopped the package-store download, and the analysis sandbox needs it."
                  : `The package store is ${content === "missing" ? "not installed" : "incomplete"}.${failureDetail(transfers, "catalog")}`;
        return `${reason} Run \`inflexa store download\` to obtain it.`;
    }

    const failure = machine.farm.failure;
    if (failure !== null) {
        return `The package farm of this analysis could not be composed: ${failure}. Run \`inflexa store ls\` to see the store, then try again.`;
    }
    return null;
}

/** The first line of the recorded reason of a failed transfer of `kind`, with a leading space, or an empty string. */
function failureDetail(transfers: readonly TransferReport[], kind: TransferKind): string {
    const report = transfers.find((entry) => entry.kind === kind);
    return report?.state === "failed" && report.row?.message ? ` ${firstLine(report.row.message)}` : "";
}
