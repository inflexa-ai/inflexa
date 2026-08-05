import { intro, log, outro, spinner } from "@clack/prompts";
import { loadDataProfileStatus, reconcileOrphanedDataProfile, runDataProfile, triggerDataProfile, tryRetryDataProfile } from "@inflexa-ai/harness";

import { fail } from "../../../lib/cli.ts";
import { getLogger } from "../../../lib/log.ts";
import { shutdown } from "../../../lib/shutdown.ts";
import { claimAnalysisOrFail, resolveSingleAnalysis, type ContextFlags } from "../../analysis/context.ts";
import { workspaceDataDir } from "../../analysis/output.ts";
import { ensureSandboxImage } from "../../libs/pull.ts";
import { stageInputs } from "../../staging/staging.ts";
import { resolveHarnessConfig } from "../config.ts";
import { seedProfileLedger } from "../profile_trigger.ts";
import { bootHarnessRuntime, describeBootError } from "../runtime.ts";
import { waitForTerminalStatus, withStatusPool } from "./status.ts";

// `inflexa profile` — the ONE deliberate action that stages files and boots the
// embedded harness (no-litter: passive flows never reach any of this). Flow:
// resolve analysis → pre-flight → boot → stage → seed ledger → trigger.
// Presentation is clack (the text-command layer's prompt kit — never opentui
// here); the workflow itself is fire-and-forget and `--status` reads the ledger.

/** `inflexa profile` — stage the analysis's inputs and run a data profile on them. */
export async function runProfile(flags: ContextFlags): Promise<void> {
    const analysis = resolveSingleAnalysis(flags, "No analysis here. Run `inflexa` to start one, add inputs, then profile.");
    const cfg = resolveHarnessConfig();

    intro(`inflexa profile — ${analysis.name}`);

    // Surface an invalid `harness` config block before the image check. On a
    // config error resolveHarnessConfig collapses EVERY field to its default
    // (including a valid `harness.sandboxImage`), so ensureSandboxImage would
    // inspect the wrong tag and could fail with a misleading "image not found"
    // that buries the real problem (e.g. a mistyped `adminPort`). boot reports
    // the same error, but only after the image check it never reaches.
    if (cfg.configError) fail(describeBootError({ type: "harness_config_invalid", issues: cfg.configError.issues }));

    await ensureSandboxImage(cfg.sandboxImage);

    // Gate the workspace root BEFORE booting — an unresolvable or non-writable
    // workspace fails like any other prerequisite (no fallback location exists).
    // Resolution only; the tree is created by staging below, after boot.
    const workspaceDataRoot = workspaceDataDir(analysis).match(
        (dir) => dir,
        (e) => fail(e.type === "workspace_unavailable" ? e.message : `Failed to resolve the analysis workspace (${e.type})`),
    );

    // Claim the per-analysis instance lock before boot, so this analysis stays
    // single-process for the whole profile — the interim two-recorder fix of #37, the
    // same guard the TUI takes on open (app.launch.tsx). Acquired after the fail-fast
    // pre-flight gates and before the runtime boots or any input is staged; the
    // read-only `--status` path never reaches here, so it observes without a lock. The
    // process-exit hook (src/index.ts) releases it on every exit, so a bail-out below
    // leaks nothing.
    claimAnalysisOrFail(analysis, "Wait for it to finish or stop that process, then re-run.");

    const s = spinner();
    s.start("Booting the harness runtime (Postgres, callback listener, DBOS)");
    const bootResult = await bootHarnessRuntime({ config: cfg });
    const runtime = bootResult.match(
        (r) => r,
        (e) => {
            s.error("Harness runtime boot failed");
            return fail(describeBootError(e));
        },
    );
    s.stop(`Runtime ready — model ${runtime.sandbox.model}`);

    // A prior run that died between claiming the ledger and creating its DBOS
    // workflow leaves the row wedged at `running` with nothing for recovery to
    // resume. Boot has now run DBOS recovery, so any row still `running` with no
    // active workflow is genuinely orphaned — reset it so the trigger below can
    // re-profile instead of reporting `already_running` forever. Best-effort: a
    // reconcile hiccup must not abort the command.
    (await reconcileOrphanedDataProfile(runtime.pool, analysis.id)).match(
        () => {},
        (e) => getLogger("harness").warn({ analysisId: analysis.id, err: e }, "orphaned-profile reconcile failed"),
    );

    s.start("Staging inputs");
    const staged = (await stageInputs(analysis.id, workspaceDataRoot)).match(
        (files) => files,
        (e) => {
            s.error("Staging failed");
            return fail("Failed to stage inputs", e);
        },
    );
    if (staged.length === 0) {
        s.error("Nothing to stage");
        fail(`"${analysis.name}" has no resolvable inputs — add input files in the chat first, then re-run \`inflexa profile\`.`);
    }
    s.stop(`Staged ${staged.length} file(s)`);

    // Seed the harness ledger row the trigger's CAS transitions (without it every trigger reports
    // "failed") and build the trigger params — one shared construction with the TUI parity path, so
    // the two callers can never drift on what the ledger row and the trigger see (see seedProfileLedger).
    const params = (await seedProfileLedger(runtime.pool, analysis.id, staged)).match(
        (p) => p,
        (e) => fail("Failed to seed the harness analysis state", e),
    );
    const outcome = await triggerDataProfile(runtime.triggerDeps, params);
    switch (outcome) {
        case "started":
            log.step("Data profiling started");
            break;
        case "restarted":
            log.step("Re-profiling started (the previous profile is superseded)");
            break;
        case "already_running":
            log.info("A profile run is already in progress — watching it");
            break;
        case "failed": {
            // The trigger claims pending/completed rows only; a failed row needs
            // the retry claim. Mirror the managed retry route: claim, then start.
            const retried = (await tryRetryDataProfile(runtime.pool, analysis.id)).match(
                (r) => r,
                (e) => fail("Failed to retry-claim the failed profile", e),
            );
            if (!retried) {
                const status = (await loadDataProfileStatus(runtime.pool, analysis.id)).match(
                    (st) => st,
                    () => null,
                );
                fail(`Could not start profiling${status?.error ? ` — last error: ${status.error}` : ""}. See the logs for details.`);
            }
            runDataProfile(runtime.triggerDeps, params).catch((cause: unknown) => {
                getLogger("harness").error(
                    { analysisId: analysis.id, err: cause instanceof Error ? cause.message : String(cause) },
                    "profile retry failed to start",
                );
            });
            log.step("Previous profile failed — retrying");
            break;
        }
        default: {
            const exhaustive: never = outcome;
            throw new Error(`unhandled trigger outcome: ${JSON.stringify(exhaustive)}`);
        }
    }

    // The workflow runs inside THIS process's DBOS runtime — exiting now would
    // orphan it until some future boot adopts it. Block until a terminal state;
    // Ctrl+C is safe (DBOS marks the run recoverable and the next `inflexa
    // profile` boot resumes it).
    log.info("Ctrl+C detaches; the run resumes on the next profile boot");
    s.start("Profiling");
    const final = await waitForTerminalStatus(runtime.pool, analysis.id, s);
    if (final.status === "completed") {
        s.stop("Profile completed");
        outro("Done — inspect details with `inflexa profile --status`");
        // Explicit drain-and-exit: the runtime's live handles (ingress listener,
        // pg pools, DBOS admin server) keep the event loop busy, so the entry
        // point's beforeExit → shutdown() path would never fire on its own.
        return shutdown(0);
    }
    s.error(`Profile ${final.status}`);
    fail(`Profile ${final.status}${final.error ? `: ${final.error}` : ""}.`);
}

/**
 * `inflexa profile --status` — read-only ledger view. Deliberately never boots
 * the runtime or provisions anything: it reuses the booted runtime's pool when
 * present, else opens a throwaway connection to an already-running Postgres.
 */
export async function runProfileStatus(flags: ContextFlags): Promise<void> {
    const analysis = resolveSingleAnalysis(flags, "No analysis here. Run `inflexa` to start one, add inputs, then profile.");

    await withStatusPool(async (pool, hasRuntime) => {
        const status = (await loadDataProfileStatus(pool, analysis.id)).match(
            (s) => s,
            (e) => fail("Postgres is not reachable — profile state lives there. Start it with `inflexa setup` (or run a profile first).", e),
        );
        if (status === null) {
            console.log(`  "${analysis.name}" has never been profiled. Run \`inflexa profile\` to start.`);
            return;
        }
        console.log(`  Profile status for "${analysis.name}" (${analysis.id}):`);
        console.log(`    status:     ${status.status}`);
        if (status.startedAt) console.log(`    started:    ${status.startedAt}`);
        if (status.completedAt) console.log(`    completed:  ${status.completedAt}`);
        if (status.error) console.log(`    error:      ${status.error}`);
        if (status.status === "running" && !hasRuntime) {
            // Running row + no runtime in THIS process: either another inflexa
            // process owns it, or a previous session died and DBOS will resume
            // the workflow on the next boot. Both are normal — say so.
            console.log(`    note:       run owned by another/previous session; a crashed run resumes on the next \`inflexa profile\` boot`);
        }
    });
}
