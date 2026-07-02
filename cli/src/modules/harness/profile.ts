import {
    loadDataProfileStatus,
    makeLocalAuth,
    runDataProfile,
    triggerDataProfile,
    tryRetryDataProfile,
    upsertAnalysis,
    createPool,
    type Pool,
} from "@inflexa-ai/harness";

import { fail, dieOn } from "../../lib/cli.ts";
import { activeRuntime, resolvePostgresConfig } from "../../lib/config.ts";
import { capture } from "../../lib/container.ts";
import { getLogger } from "../../lib/log.ts";
import type { Analysis } from "../../types/analysis.ts";
import { resolveContext, type ContextFlags } from "../analysis/context.ts";
import { sessionTreeDataDir } from "../staging/paths.ts";
import { stageInputs } from "../staging/staging.ts";
import { resolveHarnessConfig } from "./config.ts";
import { bootHarnessRuntime, activeHarnessRuntime, type HarnessBootError } from "./runtime.ts";

// `inflexa profile` — the ONE deliberate action that stages files and boots the
// embedded harness (no-litter: passive flows never reach any of this). Flow:
// resolve analysis → pre-flight → boot → stage → seed ledger → trigger.
// The workflow itself is fire-and-forget; `--status` reads the harness ledger.

/** Resolve the one analysis this run operates on, or die with a way forward. */
function resolveProfileAnalysis(flags: ContextFlags): Analysis {
    const ctx = resolveContext(process.cwd(), flags).match((c) => c, dieOn("Failed to resolve context"));
    const listCandidates = (analyses: Analysis[]): string => analyses.map((a) => `  - ${a.id}  ${a.name}`).join("\n");
    switch (ctx.kind) {
        case "analysis":
            return ctx.analysis;
        case "anchor": {
            const [only, ...rest] = ctx.analyses;
            if (only && rest.length === 0) return only;
            if (!only) fail("No analyses on this anchor yet. Run `inflexa new` to create one first.");
            fail(`Multiple analyses here — pick one with --analysis <id|name>:\n${listCandidates(ctx.analyses)}`);
            break;
        }
        case "pick":
            fail(`Ambiguous context — pick one with --analysis <id|name>:\n${listCandidates(ctx.analyses)}`);
            break;
        case "empty":
            fail("No analysis here. Run `inflexa` to start one, add inputs, then profile.");
            break;
        case "copy":
            fail("This folder is a copied anchor — run `inflexa repair` or `inflexa relocate` first.");
            break;
        default: {
            const exhaustive: never = ctx;
            throw new Error(`unhandled context kind: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/** Each boot error variant, as one actionable line naming the remedy. */
function describeBootError(e: HarnessBootError): string {
    switch (e.type) {
        case "embedding_unconfigured":
            return [
                "No embedding endpoint configured — profiling's vector indexing requires one, and the local proxy serves none (Anthropic auth has no embeddings API).",
                'Set `harness.embedding` in config.json: { "baseURL": "<OpenAI-compatible /v1>", "token": "<key>", "model": "text-embedding-3-small" }.',
            ].join("\n");
        case "skills_dir_missing":
            return `Skills directory not found${e.path ? ` at ${e.path}` : ""}. Set \`harness.skillsDir\` in config.json (a checkout's \`skills/\` tree).`;
        case "proxy_key_missing":
            return "Proxy client key not found — run `inflexa setup` to provision the proxy first.";
        case "model_unresolved":
            return e.cause.type === "no_models"
                ? "The proxy lists no models — authenticate a provider via `inflexa setup`, or set `harness.model` in config.json."
                : `The proxy is unreachable (${e.cause.type === "proxy_unreachable" ? e.cause.detail : e.cause.type}) — is the container running? Try \`inflexa setup\`.`;
        case "postgres_unavailable":
            return e.cause.message;
        case "ingress_failed":
            return "Could not bind the local callback listener (loopback, ephemeral port) — check for exhausted ports or a restrictive firewall.";
        case "runtime_boot_failed":
            return `Harness runtime failed to boot: ${e.cause instanceof Error ? e.cause.message : String(e.cause)}`;
        default: {
            const exhaustive: never = e;
            throw new Error(`unhandled boot error: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/** Pre-flight: the sandbox image must exist locally — after staging it is too late to find out. */
async function ensureSandboxImage(image: string): Promise<void> {
    const rt = activeRuntime();
    const result = await capture(rt, ["image", "inspect", image]);
    if (result.code !== 0) {
        fail(
            [
                `Sandbox image "${image}" not found in ${rt.id}.`,
                `Build it from the repo root: ${rt.id} build -f images/sandbox-base/Dockerfile -t ${image} .`,
                "(or set `harness.sandboxImage` in config.json to an existing tag)",
            ].join("\n"),
        );
    }
}

/** `inflexa profile` — stage the analysis's inputs and run a data profile on them. */
export async function runProfile(flags: ContextFlags): Promise<void> {
    const analysis = resolveProfileAnalysis(flags);
    const cfg = resolveHarnessConfig();

    await ensureSandboxImage(cfg.sandboxImage);

    console.log(`  Booting the harness runtime…`);
    const bootResult = await bootHarnessRuntime({ config: cfg });
    const runtime = bootResult.match(
        (r) => r,
        (e) => fail(describeBootError(e)),
    );

    console.log(`  Staging inputs for "${analysis.name}"…`);
    const staged = (await stageInputs(analysis.id, sessionTreeDataDir(analysis.id))).match(
        (s) => s,
        (e) => fail("Failed to stage inputs", e),
    );
    if (staged.length === 0) {
        fail(`"${analysis.name}" has no resolvable inputs — add input files in the chat first, then re-run \`inflexa profile\`.`);
    }
    console.log(`  Staged ${staged.length} file(s).`);

    // Seed the harness ledger row the trigger's CAS transitions — without it
    // every trigger reports "failed". Context stays null: the cli has no goal
    // text at profile time, and fabricating one would pollute the agent prompt.
    (
        await upsertAnalysis(
            runtime.pool,
            analysis.id,
            null,
            null,
            staged.map((f) => f.fileId),
        )
    ).match(
        () => {},
        (e) => fail("Failed to seed the harness analysis state", e),
    );

    const params = { auth: makeLocalAuth(), analysisId: analysis.id, stagedInputs: staged };
    const outcome = await triggerDataProfile(runtime.triggerDeps, params);
    switch (outcome) {
        case "started":
            console.log(`  Data profiling started.`);
            break;
        case "restarted":
            console.log(`  Re-profiling started (the previous profile is superseded).`);
            break;
        case "already_running":
            console.log(`  A profile run is already in progress for "${analysis.name}" — watching it.`);
            break;
        case "failed": {
            // The trigger claims pending/completed rows only; a failed row needs
            // the retry claim. Mirror the managed retry route: claim, then start.
            const retried = (await tryRetryDataProfile(runtime.pool, analysis.id)).match(
                (r) => r,
                (e) => fail("Failed to read the profile ledger", e),
            );
            if (!retried) {
                const status = (await loadDataProfileStatus(runtime.pool, analysis.id)).match(
                    (s) => s,
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
            console.log(`  Previous profile failed — retrying.`);
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
    console.log(`  Waiting for the profile to finish (Ctrl+C detaches; the run resumes on the next profile boot)…`);
    const final = await waitForTerminalStatus(runtime.pool, analysis.id);
    if (final.status === "completed") {
        console.log(`  Profile completed. Inspect details with \`inflexa profile --status\`.`);
        return;
    }
    fail(`Profile ${final.status}${final.error ? `: ${final.error}` : ""}.`);
}

/** Poll the ledger until the run leaves `running`, echoing state changes. */
async function waitForTerminalStatus(pool: Pool, analysisId: string): Promise<{ status: string; error: string | null }> {
    let lastShown: string | null = null;
    for (;;) {
        const status = (await loadDataProfileStatus(pool, analysisId)).match(
            (s) => s,
            (e) => fail("Lost the ledger connection while waiting", e),
        );
        // The row was seeded before triggering, so null here means it was
        // deleted underneath us — treat as failure rather than spinning.
        if (status === null) return { status: "failed", error: "ledger row disappeared" };
        if (status.status !== lastShown) {
            console.log(`    status: ${status.status}`);
            lastShown = status.status;
        }
        if (status.status !== "running" && status.status !== "pending") {
            return { status: status.status, error: status.error };
        }
        await Promise.sleep(3000);
    }
}

/**
 * `inflexa profile --status` — read-only ledger view. Deliberately never boots
 * the runtime or provisions anything: it reuses the booted runtime's pool when
 * present, else opens a throwaway connection to an already-running Postgres.
 */
export async function runProfileStatus(flags: ContextFlags): Promise<void> {
    const analysis = resolveProfileAnalysis(flags);

    const runtime = activeHarnessRuntime();
    let pool: Pool | null = runtime?.pool ?? null;
    let throwaway = false;
    if (!pool) {
        const conn = resolvePostgresConfig();
        pool = createPool({ host: conn.host, port: String(conn.port), database: conn.database, user: conn.user, password: conn.password, sslMode: "disable" });
        throwaway = true;
    }

    try {
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
        if (status.status === "running" && !runtime) {
            // Running row + no runtime in THIS process: either another inflexa
            // process owns it, or a previous session died and DBOS will resume
            // the workflow on the next boot. Both are normal — say so.
            console.log(`    note:       run owned by another/previous session; a crashed run resumes on the next \`inflexa profile\` boot`);
        }
    } finally {
        if (throwaway && pool) {
            await pool.end().catch(() => {
                // Read-only convenience connection; a failed drain must not fail the command.
            });
        }
    }
}
