import { err, type Result } from "neverthrow";

import pkg from "../../package.json";
import {
    API_VERSION,
    SIGN_IN_REQUIRED,
    type BootPullProgress,
    type BootStepDone,
    type BootStepId,
    type BootStepRunning,
    type ServerBootError,
    type ServerBootState,
    type ServerIdentity,
} from "../api/server.ts";
import { causeDetailLines, describeCause } from "../lib/cause.ts";
import { env } from "../lib/env.ts";
import { getLogger } from "../lib/log.ts";
import { resolveHarnessConfig, resolveModelConnection } from "../modules/harness/config.ts";
import { bootHarnessRuntime, describeBootError, type HarnessBootError, type HarnessRuntime } from "../modules/harness/runtime.ts";
import { ensureProxyReady, ProxyError } from "../modules/infra/setup.ts";
import { collectStoreDebris } from "../modules/libs/store.ts";

/** The boot of the harness runtime inside the server, as the routes see it. */
export type ServerBoot = {
    /** The boot part of the body of `GET /api/v1/server`: the route joins the stop. */
    state(): ServerBootState;
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
    /** Make the machine ready (containers, proxy, embedder), then boot the harness runtime. It reports its steps through `progress`. */
    readonly boot: (progress: BootProgressOpts) => Promise<Result<HarnessRuntime, ServerBootError>>;
    /** The clock of the step times. */
    readonly now: () => Date;
    /** Runs one time at the ready edge. */
    readonly onReady: (runtime: HarnessRuntime) => void;
    /** Runs when an attempt settles, with the new state. */
    readonly onSettle: (state: ServerBootState) => void;
};

/** The callbacks that the holder binds to one boot attempt. After the attempt settles, they do nothing. */
export type BootProgressOpts = {
    /** The boot starts the step `id`. The step that ran before it ends. */
    readonly onStep: (id: BootStepId) => void;
    /** The pull of the missing images moved bytes. It changes the state only while the step `images` runs. */
    readonly onPullProgress: (progress: BootPullProgress) => void;
};

/** The production {@link ServerBootOpts}. */
export const DEFAULT_SERVER_BOOT_OPTS: ServerBootOpts = {
    boot: bootServerRuntime,
    now: () => new Date(),
    onReady: collectDebrisAtReady,
    onSettle: () => undefined,
};

/** The phase without the runtime: the runtime handle is kept apart, because no client gets it. */
type Phase =
    | { phase: "starting"; attemptStartedAt: string; step: BootStepRunning | null; done: BootStepDone[] }
    | { phase: "ready"; runtime: HarnessRuntime }
    | { phase: "failed"; bootError: ServerBootError; attemptStartedAt: string; failedAt: string; failedStep: BootStepId | null };

/**
 * Make the boot holder of one server process. The phase is `starting` from the first moment, because the
 * server starts the boot right after it binds its port. Before the first attempt starts, the attempt start is
 * the start of the server, with no step.
 */
export function createServerBoot(startedAt: Date, opts: ServerBootOpts = DEFAULT_SERVER_BOOT_OPTS): ServerBoot {
    let current: Phase = { phase: "starting", attemptStartedAt: startedAt.toISOString(), step: null, done: [] };
    let attempt: Promise<void> | null = null;

    function state(): ServerBootState {
        const base: ServerIdentity = { version: pkg.version, apiVersion: API_VERSION, startedAt: startedAt.toISOString() };
        switch (current.phase) {
            case "starting":
                return {
                    ...base,
                    phase: "starting",
                    boot: { attemptStartedAt: current.attemptStartedAt, step: current.step === null ? null : { ...current.step }, done: [...current.done] },
                };
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
                return {
                    ...base,
                    phase: "failed",
                    bootError: current.bootError,
                    attemptStartedAt: current.attemptStartedAt,
                    failedAt: current.failedAt,
                    failedStep: current.failedStep,
                };
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

    function fail(running: Extract<Phase, { phase: "starting" }>, bootError: ServerBootError): Phase {
        return {
            phase: "failed",
            bootError,
            attemptStartedAt: running.attemptStartedAt,
            failedAt: opts.now().toISOString(),
            failedStep: running.step?.id ?? null,
        };
    }

    function start(): Promise<void> {
        if (attempt !== null) return attempt;
        if (current.phase === "ready") return Promise.resolve();
        const running: Extract<Phase, { phase: "starting" }> = { phase: "starting", attemptStartedAt: opts.now().toISOString(), step: null, done: [] };
        current = running;
        // `settle` replaces `current`, so a callback that runs after its attempt settled sees another object and does nothing.
        const progress: BootProgressOpts = {
            onStep(id) {
                if (current !== running) return;
                const at = opts.now().toISOString();
                if (running.step !== null) running.done.push({ id: running.step.id, startedAt: running.step.startedAt, endedAt: at });
                running.step = { id, startedAt: at };
            },
            onPullProgress(pull) {
                if (current !== running || running.step?.id !== "images") return;
                running.step.progress = pull;
            },
        };
        // The second handler keeps the phase from staying `starting` forever when the boot throws past
        // its own Result channel.
        attempt = opts.boot(progress).then(
            (result) =>
                settle(
                    result.match(
                        (runtime): Phase => ({ phase: "ready", runtime }),
                        (bootError): Phase => fail(running, bootError),
                    ),
                ),
            (cause: unknown) => settle(fail(running, { reason: "runtime_boot_failed", message: describeCause(cause), detailLines: causeDetailLines(cause) })),
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
async function bootServerRuntime(progress: BootProgressOpts): Promise<Result<HarnessRuntime, ServerBootError>> {
    const connection = resolveModelConnection();
    if (connection.configError) return err(fromHarnessBootError({ type: "model_connection_invalid", issues: connection.configError.issues }));

    // The boot never asks for a provider login, even when the terminal of `inflexa serve` is interactive: a
    // prompt there would stop the boot until someone answers it. A missing or dead login fails the boot with
    // the remedy. The user runs `inflexa up`, which signs in and then sends `POST /api/v1/server/boot`.
    const infra = await ensureProxyReady(connection.mode, { interactiveLogin: false, onStep: progress.onStep, onPullProgress: progress.onPullProgress });
    if (infra.isErr()) {
        const signIn = infra.error instanceof ProxyError && infra.error.signInRequired;
        return err({ reason: signIn ? SIGN_IN_REQUIRED : "infra_unready", message: infra.error.message, detailLines: [] });
    }

    progress.onStep("runtime");
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
