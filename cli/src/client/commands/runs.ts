import { intro, log, outro, spinner } from "@clack/prompts";
import PQueue from "p-queue";

import type { ProfileOutcome, RunDetail, RunSummary, SandboxReadiness } from "../../api/runs.ts";
import { fail } from "../../lib/cli.ts";
import { describeClientError, DEFAULT_CLIENT_OPTS, type ClientOpts } from "../api.ts";
import { fetchDataProfile, fetchRun, fetchRuns, fetchSandboxReadiness, rerunDataProfile } from "../runs.ts";

/** The analysis that a command operates on: its id for the routes, and its name for the text. */
export type AnalysisTarget = {
    readonly id: string;
    readonly name: string;
};

/** How long `inflexa profile` waits between two reads of the profile state. */
const PROFILE_POLL_MS = 2_000;

/** How many runs `inflexa run --status` lists: the newest page, as before the server. */
const RUN_STATUS_PAGE = 50;

/** How many run details `inflexa run --status` reads at the same time. Each run is one request, because no route gives the steps of many runs. */
const RUN_DETAIL_CONCURRENCY = 4;

/** What {@link profileRun} waits with. Tests shorten the poll. */
export type ProfileRunOpts = {
    readonly client: ClientOpts;
    readonly pollMs: number;
};

/** The production {@link ProfileRunOpts}. */
export const DEFAULT_PROFILE_RUN_OPTS: ProfileRunOpts = { client: DEFAULT_CLIENT_OPTS, pollMs: PROFILE_POLL_MS };

/**
 * `inflexa profile`: profile the analysis again through the server, then follow the profile until it ends.
 * The server stages the inputs and runs the profile in its own runtime, thus a stop of this command stops
 * only the wait.
 */
export async function profileRun(analysis: AnalysisTarget, opts: ProfileRunOpts = DEFAULT_PROFILE_RUN_OPTS): Promise<void> {
    intro(`inflexa profile — ${analysis.name}`);

    // The checks of the sandbox gate of the TUI, with no wait: a profile that the server cannot start in a
    // sandbox fails here with the command that repairs the machine.
    const readiness = (await fetchSandboxReadiness(analysis.id, opts.client)).match(
        (r) => r,
        (e) => fail(describeClientError(e)),
    );
    const refusal = sandboxRefusal(readiness);
    if (refusal !== null) fail(refusal);

    const outcome = (await rerunDataProfile(analysis.id, opts.client)).match(
        (body) => body.outcome,
        (e) => fail(`Could not start profiling — ${describeClientError(e)}`),
    );
    if (!announceOutcome(analysis, outcome)) return;

    log.info("Ctrl+C stops the wait; the profile continues in the server");
    const s = spinner();
    s.start("Profiling");
    const startedAt = Date.now();
    for (;;) {
        const view = (await fetchDataProfile(analysis.id, opts.client)).match(
            (v) => v,
            (e) => {
                s.error("Lost the server connection");
                return fail(`Lost the server connection while waiting — ${describeClientError(e)}`);
            },
        );
        // The rerun seeded the row before it triggered, thus no row means that it was deleted underneath.
        if (view.status === null) {
            s.error("Profile failed");
            return fail("Profile failed: the ledger row disappeared.");
        }
        if (view.status === "completed") {
            s.stop("Profile completed");
            outro("Done — inspect details with `inflexa profile --status`");
            return;
        }
        if (view.status === "failed") {
            s.error("Profile failed");
            return fail(`Profile failed${view.error ? `: ${view.error}` : ""}.`);
        }
        const elapsed = Date.formatDuration(Date.now() - startedAt);
        s.message(view.status === "pending" ? `Profiling — waiting for the run to start · ${elapsed}` : `Profiling · ${elapsed}`);
        await Promise.sleep(opts.pollMs);
    }
}

/** The refusal of the machine for a profile, or `null` when a sandbox can start. An analysis with no inputs profiles nothing, thus it passes. */
function sandboxRefusal(readiness: SandboxReadiness): string | null {
    if (readiness.inputCount === 0) return null;
    switch (readiness.image.state) {
        case "present":
            break;
        case "engine_error":
            return readiness.image.message;
        case "absent":
            return "The sandbox image is not installed. Run `inflexa sandbox pull` to download it.";
        case "custom":
            return `Sandbox image "${readiness.image.image}" is not present, and it is not the published image, thus no registry can supply it. Build it, or set the published image and run \`inflexa sandbox pull\`.`;
        default: {
            const exhaustive: never = readiness.image;
            throw new Error(`unhandled image state: ${JSON.stringify(exhaustive)}`);
        }
    }
    if (readiness.store !== "installed" && readiness.store !== "local") {
        return `The package store is ${readiness.store === "missing" ? "not installed" : "incomplete"}. Run \`inflexa store download\` to obtain it.`;
    }
    if (readiness.farm.failure !== null) {
        return `The package farm of this analysis could not be composed: ${readiness.farm.failure}. Run \`inflexa store ls\` to see the store, then try again.`;
    }
    return null;
}

/** Print what the rerun did. True when a profile runs, thus the command waits for it. */
function announceOutcome(analysis: AnalysisTarget, outcome: ProfileOutcome): boolean {
    switch (outcome.kind) {
        case "triggered":
            log.step(outcome.restarted ? "Re-profiling started (the previous profile is superseded)" : "Data profiling started");
            return true;
        case "already_running":
            log.info("A profile run is already in progress — watching it");
            return true;
        case "no_inputs":
            return fail(`"${analysis.name}" has no resolvable inputs — add input files in the chat first, then re-run \`inflexa profile\`.`);
        case "failed":
            return fail(`Could not start profiling — ${outcome.reason}`);
        case "already_profiled":
        case "cleared":
        case "skipped_failed":
            // The deliberate re-profile does not give these: past its live-run check it always stages,
            // seeds, and triggers. A profile that is complete has nothing to wait for.
            outro("Done — inspect details with `inflexa profile --status`");
            return false;
        default: {
            const exhaustive: never = outcome;
            throw new Error(`unhandled profile outcome: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/** `inflexa profile --status`: the profile state of the analysis, a read only. */
export async function profileStatus(analysis: AnalysisTarget, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const view = (await fetchDataProfile(analysis.id, opts)).match(
        (v) => v,
        (e) => fail(describeClientError(e)),
    );
    if (view.status === null) {
        console.log(`  "${analysis.name}" has never been profiled. Run \`inflexa profile\` to start.`);
        return;
    }
    console.log(`  Profile status for "${analysis.name}" (${analysis.id}):`);
    console.log(`    status:     ${view.status}`);
    if (view.startedAt) console.log(`    started:    ${view.startedAt}`);
    if (view.completedAt) console.log(`    completed:  ${view.completedAt}`);
    if (view.error) console.log(`    error:      ${view.error}`);
}

/** `inflexa run --status`: the newest runs of the analysis, each with its steps. A read only. */
export async function runStatus(analysis: AnalysisTarget, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const runs = (await fetchRuns(analysis.id, { perPage: RUN_STATUS_PAGE }, opts)).match(
        (list): RunSummary[] => list.runs,
        (e) => fail(describeClientError(e)),
    );
    if (runs.length === 0) {
        console.log(`  "${analysis.name}" has no runs yet. Launch one with \`inflexa run --plan <file>\`.`);
        return;
    }
    const queue = new PQueue({ concurrency: RUN_DETAIL_CONCURRENCY });
    // A run whose detail read fails still prints, with no steps.
    const details = await Promise.all(
        runs.map((run) =>
            queue.add(() =>
                fetchRun(analysis.id, run.runId, opts).match(
                    (detail): RunDetail | null => detail,
                    () => null,
                ),
            ),
        ),
    );
    console.log(`  Runs for "${analysis.name}" (${analysis.id}):`);
    for (const [i, run] of runs.entries()) {
        console.log("");
        console.log(`  ${run.runId}  [${run.status}]`);
        console.log(`    plan:       ${run.planTitle ?? "—"}`);
        console.log(`    started:    ${run.startedAt}`);
        if (run.completedAt) console.log(`    completed:  ${run.completedAt}`);
        if (run.error) console.log(`    error:      ${run.error}`);
        for (const step of details[i]?.steps ?? []) {
            const duration = step.durationMs !== null ? ` (${Math.round(step.durationMs / 1000)}s)` : "";
            const stepError = step.error ? `  ${step.error}` : "";
            console.log(`      - ${step.stepId}  ${step.status}  [${step.agentId}]${duration}${stepError}`);
        }
    }
}
