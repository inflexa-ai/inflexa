import { intro, log, outro, spinner } from "@clack/prompts";
import {
    loadDataProfileStatus,
    makeLocalAuth,
    reconcileOrphanedDataProfile,
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
import { shutdown } from "../../lib/shutdown.ts";
import type { Analysis } from "../../types/analysis.ts";
import { resolveContext, type ContextFlags } from "../analysis/context.ts";
import { sessionTreeDataDir } from "../staging/paths.ts";
import { stageInputs } from "../staging/staging.ts";
import { resolveHarnessConfig } from "./config.ts";
import { bootHarnessRuntime, activeHarnessRuntime, type HarnessBootError } from "./runtime.ts";

// `inflexa profile` — the ONE deliberate action that stages files and boots the
// embedded harness (no-litter: passive flows never reach any of this). Flow:
// resolve analysis → pre-flight → boot → stage → seed ledger → trigger.
// Presentation is clack (the text-command layer's prompt kit — never opentui
// here); the workflow itself is fire-and-forget and `--status` reads the ledger.

type Spinner = ReturnType<typeof spinner>;

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
        case "harness_config_invalid":
            return `Your \`harness\` config has an invalid field — ${e.issues}. Fix it in config.json and re-run.`;
        case "embedding_unconfigured":
            return [
                "No embedding endpoint configured — profiling's vector indexing requires one. Embeddings are their own endpoint (separate from the chat proxy, which serves none).",
                'Set `harness.embedding` in config.json: { "baseURL": "<OpenAI-compatible /v1>", "token": "<key>", "model": "text-embedding-3-small" }.',
            ].join("\n");
        case "embedding_unreachable":
            return [
                `The embedding endpoint ${e.baseURL} did not accept an embeddings request (${e.detail}) — profiling's vector indexing requires one and would otherwise fail after the sandbox run already spent its work.`,
                "Either configure an embeddings-capable provider in the proxy, or set `harness.embedding` in config.json:",
                '{ "baseURL": "<OpenAI-compatible /v1>", "token": "<key>", "model": "text-embedding-3-small" }.',
            ].join("\n");
        case "embedding_dimension_mismatch":
            return [
                `The embedding model at ${e.baseURL} returns ${e.actual}-dimensional vectors, but the profile's vector index is fixed at ${e.expected} dimensions.`,
                `Set \`harness.embedding.model\` in config.json to a ${e.expected}-dim model (e.g. text-embedding-3-small).`,
            ].join("\n");
        case "skills_dir_missing":
            return `Skills directory not found${e.path ? ` at ${e.path}` : ""}. Set \`harness.skillsDir\` in config.json (a checkout's \`skills/\` tree).`;
        case "proxy_key_missing":
            return "Proxy client key not found — run `inflexa setup` to provision the proxy first.";
        case "model_unresolved":
            return e.cause.type === "no_models"
                ? "The proxy lists no models — authenticate a provider via `inflexa setup`, or set `harness.model` in config.json."
                : `The proxy is unreachable (${e.cause.type === "proxy_unreachable" ? e.cause.detail : e.cause.type}) — is the container running? Try \`inflexa setup\`.`;
        case "model_not_claude":
            return [
                `The proxy's default model "${e.model}" is not a Claude model, but data profiling drives the proxy over the Anthropic protocol.`,
                "Authenticate a Claude provider via `inflexa setup`, or set `harness.model` in config.json to a Claude model the proxy serves.",
            ].join("\n");
        case "postgres_unavailable":
            return e.cause.message;
        case "ingress_failed":
            return "Could not bind the local callback listener (loopback, ephemeral port) — check for exhausted ports or a restrictive firewall.";
        case "runtime_already_active":
            return `Another \`inflexa\` process (pid ${e.holderPid}) is already running the harness runtime. Only one profile run per machine at a time — wait for it to finish or stop that process.`;
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

    intro(`inflexa profile — ${analysis.name}`);

    await ensureSandboxImage(cfg.sandboxImage);

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
    s.stop(`Runtime ready — model ${runtime.model}`);

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
    const staged = (await stageInputs(analysis.id, sessionTreeDataDir(analysis.id))).match(
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
                (e) => fail("Failed to read the profile ledger", e),
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
 * Human label for a DBOS step name from the profile workflow's step record —
 * the progress channel's vocabulary. Best-effort: unknown names pass through
 * verbatim so new step kinds surface instead of hiding behind a generic label.
 */
export function friendlyStepLabel(functionName: string): string {
    const llm = functionName.match(/^llm-(\d+)$/);
    if (llm) return `model round ${Number(llm[1]) + 1}`;
    if (functionName.startsWith("tool-")) {
        const rest = functionName.slice("tool-".length);
        // Step names are `tool-{toolName}-{toolCallId}` with toolCallId minted
        // as `toolu_…`; tool names themselves may contain hyphens/underscores.
        const cut = rest.lastIndexOf("-toolu");
        return `tool ${cut === -1 ? rest : rest.slice(0, cut)}`;
    }
    if (functionName.includes("submit-exec")) return "dispatching sandbox command";
    if (functionName === "DBOS.recv" || functionName === "DBOS.sleep" || functionName === "DBOS.now") return "sandbox executing";
    return functionName;
}

/**
 * Latest step of the newest profile workflow for this analysis, read from the
 * DBOS step record. Returns `null` on any miss or error: progress is a
 * cosmetic channel, and a hiccup here must never abort a live run's wait.
 */
async function readRunProgress(pool: Pool, analysisId: string): Promise<{ step: number; label: string } | null> {
    try {
        const result = await pool.query<{ function_id: number; function_name: string }>({
            text: `SELECT oo.function_id, oo.function_name
             FROM dbos.operation_outputs oo
             WHERE oo.workflow_uuid = (
                 SELECT workflow_uuid FROM dbos.workflow_status
                 WHERE workflow_uuid LIKE 'dataprofile:' || $1 || ':%'
                 ORDER BY created_at DESC LIMIT 1)
             ORDER BY oo.function_id DESC LIMIT 1`,
            values: [analysisId],
        });
        const row = result.rows[0];
        if (!row) return null;
        return { step: Number(row.function_id) + 1, label: friendlyStepLabel(row.function_name) };
    } catch {
        return null;
    }
}

function formatElapsed(sinceMs: number): string {
    const total = Math.floor((Date.now() - sinceMs) / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

/** Poll the ledger until the run leaves `running`, narrating progress on the spinner. */
async function waitForTerminalStatus(pool: Pool, analysisId: string, s: Spinner): Promise<{ status: string; error: string | null }> {
    const startedAt = Date.now();
    for (;;) {
        const status = (await loadDataProfileStatus(pool, analysisId)).match(
            (st) => st,
            (e) => {
                s.error("Lost the ledger connection");
                return fail("Lost the ledger connection while waiting", e);
            },
        );
        // The row was seeded before triggering, so null here means it was
        // deleted underneath us — treat as failure rather than spinning.
        if (status === null) return { status: "failed", error: "ledger row disappeared" };
        if (status.status !== "running" && status.status !== "pending") {
            return { status: status.status, error: status.error };
        }
        if (status.status === "pending") {
            s.message(`Profiling — waiting for the run to start · ${formatElapsed(startedAt)}`);
        } else {
            const progress = await readRunProgress(pool, analysisId);
            s.message(
                progress ? `Profiling — ${progress.label} · step ${progress.step} · ${formatElapsed(startedAt)}` : `Profiling · ${formatElapsed(startedAt)}`,
            );
        }
        await Promise.sleep(2000);
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
