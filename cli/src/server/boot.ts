import { err, type Result } from "neverthrow";

import pkg from "../../package.json";
import { API_VERSION, type ServerBootError, type ServerIdentity, type ServerState } from "../api/server.ts";
import { causeDetailLines, describeCause } from "../lib/cause.ts";
import { env } from "../lib/env.ts";
import { getLogger } from "../lib/log.ts";
import { resolveHarnessConfig, resolveModelConnection } from "../modules/harness/config.ts";
import { bootHarnessRuntime, describeBootError, type HarnessBootError, type HarnessRuntime } from "../modules/harness/runtime.ts";
import { ensureProxyReady } from "../modules/infra/setup.ts";
import { collectStoreDebris } from "../modules/libs/store.ts";

/** The boot of the harness runtime inside the server, as the routes see it. */
export type ServerBoot = {
    /** The body of `GET /api/v1/server`. */
    state(): ServerState;
    /** The booted runtime, or `null` until the phase is `ready`. */
    runtime(): HarnessRuntime | null;
    /**
     * Start a boot when none runs and none succeeded: at the start of the server, and again after `failed`.
     * Otherwise it does nothing. The promise settles when the attempt settles. It never rejects.
     */
    start(): Promise<void>;
};

/** The work of a boot, and the reactions to its outcome. Tests replace each one. */
export type ServerBootOpts = {
    /** Make the machine ready (containers, proxy, embedder), then boot the harness runtime. */
    readonly boot: () => Promise<Result<HarnessRuntime, ServerBootError>>;
    /** Runs one time at the ready edge. */
    readonly onReady: (runtime: HarnessRuntime) => void;
    /** Runs when an attempt settles, with the new state. */
    readonly onSettle: (state: ServerState) => void;
};

/** The production {@link ServerBootOpts}. */
export const DEFAULT_SERVER_BOOT_OPTS: ServerBootOpts = {
    boot: bootServerRuntime,
    onReady: collectDebrisAtReady,
    onSettle: () => undefined,
};

/** The phase without the runtime: the runtime handle is kept apart, because no client gets it. */
type Phase = { phase: "starting" } | { phase: "ready"; runtime: HarnessRuntime } | { phase: "failed"; bootError: ServerBootError };

/**
 * Make the boot holder of one server process. The phase is `starting` from the first moment, because the
 * server starts the boot right after it binds its port.
 */
export function createServerBoot(startedAt: Date, opts: ServerBootOpts = DEFAULT_SERVER_BOOT_OPTS): ServerBoot {
    let current: Phase = { phase: "starting" };
    let attempt: Promise<void> | null = null;

    function state(): ServerState {
        const base: ServerIdentity = { version: pkg.version, apiVersion: API_VERSION, startedAt: startedAt.toISOString() };
        switch (current.phase) {
            case "starting":
                return { ...base, phase: "starting" };
            case "ready":
                return {
                    ...base,
                    phase: "ready",
                    connection: {
                        provider: current.runtime.connection.provider,
                        mode: current.runtime.connection.mode,
                        model: current.runtime.conversation.model,
                    },
                };
            case "failed":
                return { ...base, phase: "failed", bootError: current.bootError };
            default: {
                const exhaustive: never = current;
                throw new Error(`unhandled boot phase: ${JSON.stringify(exhaustive)}`);
            }
        }
    }

    function settle(next: Phase): void {
        current = next;
        attempt = null;
        if (next.phase === "ready") opts.onReady(next.runtime);
        opts.onSettle(state());
    }

    function start(): Promise<void> {
        if (attempt !== null) return attempt;
        if (current.phase === "ready") return Promise.resolve();
        current = { phase: "starting" };
        // The second handler keeps the phase from staying `starting` forever when the boot throws past
        // its own Result channel.
        attempt = opts.boot().then(
            (result) =>
                settle(
                    result.match(
                        (runtime): Phase => ({ phase: "ready", runtime }),
                        (bootError): Phase => ({ phase: "failed", bootError }),
                    ),
                ),
            (cause: unknown) =>
                settle({ phase: "failed", bootError: { reason: "runtime_boot_failed", message: describeCause(cause), detailLines: causeDetailLines(cause) } }),
        );
        return attempt;
    }

    return {
        state,
        runtime: () => (current.phase === "ready" ? current.runtime : null),
        start,
    };
}

/**
 * The boot that the TUI did before the split: the model connection gate, the container and proxy gate,
 * the harness config gate, then the runtime boot. The server boots with no analysis: the runtime resolves
 * the farm inventory of each analysis from the session of each call.
 */
async function bootServerRuntime(): Promise<Result<HarnessRuntime, ServerBootError>> {
    const connection = resolveModelConnection();
    if (connection.configError) return err(fromHarnessBootError({ type: "model_connection_invalid", issues: connection.configError.issues }));

    // The boot never asks for a provider login, even when the terminal of `inflexa serve` is interactive: a
    // prompt there would stop the boot until someone answers it. A missing or dead login fails the boot with
    // the remedy. The user runs `inflexa setup`, and a client then sends `POST /api/v1/server/boot`.
    const infra = await ensureProxyReady(connection.mode, { interactiveLogin: false });
    if (infra.isErr()) return err({ reason: "infra_unready", message: infra.error.message, detailLines: [] });

    const config = resolveHarnessConfig();
    if (config.configError) return err(fromHarnessBootError({ type: "harness_config_invalid", issues: config.configError.issues }));

    return (await bootHarnessRuntime({ config })).mapErr(fromHarnessBootError);
}

function fromHarnessBootError(e: HarnessBootError): ServerBootError {
    return { reason: e.type, message: describeBootError(e), detailLines: "cause" in e ? causeDetailLines(e.cause) : [] };
}

/**
 * The one boot-time debris pass of the package store, fire-and-forget at the ready edge. It sweeps what a
 * crashed session left, it yields to any live work, and it starts no container when there is nothing to
 * free. Only a pass that freed something writes a log line.
 */
function collectDebrisAtReady(): void {
    void collectStoreDebris(env.packageStoreDir).then((collected) =>
        collected.match(
            (outcome) => {
                if (outcome.swept) getLogger("server").info({ dirs: outcome.dirs, reports: outcome.reports }, "collected package-store debris");
            },
            (error) => getLogger("server").debug({ err: error }, "the boot debris pass did not run"),
        ),
    );
}
