import { intro, log, outro, spinner } from "@clack/prompts";
import type { ResultAsync } from "neverthrow";
import {
    loadDataProfileStatus,
    makeLocalAuth,
    reconcileOrphanedDataProfile,
    runDataProfile,
    triggerDataProfile,
    tryRetryDataProfile,
    upsertAnalysis,
    createPool,
    type DataProfileTriggerParams,
    type DbError,
    type Pool,
} from "@inflexa-ai/harness";

import { confirm, fail, dieOn } from "../../lib/cli.ts";
import { ensureRuntime, resolvePostgresConfig } from "../../lib/config.ts";
import { env } from "../../lib/env.ts";
import { capture, inherit } from "../../lib/container.ts";
import { variantOfImage } from "../libs/images.ts";
import { acquireInstanceLock } from "../../lib/lock.ts";
import { getLogger } from "../../lib/log.ts";
import { shutdown } from "../../lib/shutdown.ts";
import type { Analysis } from "../../types/analysis.ts";
import { resolveContext, type ContextFlags } from "../analysis/context.ts";
import { workspaceDataDir } from "../analysis/output.ts";
import { stageInputs, type StagedInput } from "../staging/staging.ts";
import { resolveHarnessConfig } from "./config.ts";
import { bootHarnessRuntime, activeHarnessRuntime, type HarnessBootError } from "./runtime.ts";

// `inflexa profile` — the ONE deliberate action that stages files and boots the
// embedded harness (no-litter: passive flows never reach any of this). Flow:
// resolve analysis → pre-flight → boot → stage → seed ledger → trigger.
// Presentation is clack (the text-command layer's prompt kit — never opentui
// here); the workflow itself is fire-and-forget and `--status` reads the ledger.

type Spinner = ReturnType<typeof spinner>;

/**
 * Resolve the single analysis a deliberate harness command operates on, or die
 * with a way forward. Shared by `inflexa profile` and `inflexa run` — every
 * branch is identical between the two except the `empty`-context message, which
 * each command passes as `emptyHint` (its own "how to get started" line).
 */
export function resolveSingleAnalysis(flags: ContextFlags, emptyHint: string): Analysis {
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
            fail(emptyHint);
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

/**
 * Each boot error variant, as one actionable line naming the remedy. Exported so
 * `inflexa run` reuses the exact same mapping — the boot prerequisites are
 * identical for both deliberate harness entry points.
 */
export function describeBootError(e: HarnessBootError): string {
    switch (e.type) {
        case "harness_config_invalid":
            return `Your \`harness\` config has an invalid field — ${e.issues}. Fix it in config.json and re-run.`;
        case "model_connection_invalid":
            return `Your \`models.connection\` config is invalid — ${e.issues}. Fix it in config.json and re-run.`;
        case "embedding_unresolved":
            return ["Profiling's vector indexing requires an embedder, and none could be resolved from the `embedding` config key.", e.cause.message].join(
                "\n",
            );
        case "embedding_probe_failed":
            return [
                `The configured embedder failed a probe embedding (${e.detail}) — profiling would otherwise fail after the sandbox run already spent its work.`,
                "For `local` mode, re-run `inflexa setup --embeddings local`; for `api-key` mode, check `embedding.apiKey` and `embedding.baseURL` in config.json.",
            ].join("\n");
        case "embedding_dimension_mismatch":
            return [
                `The configured embedding model returns ${e.actual}-dimensional vectors, but the embedder is declared as ${e.expected}-dimensional (\`embedding.dimensions\`).`,
                `Set \`embedding.dimensions\` to ${e.actual} in config.json so the vector indexes are sized to what the model actually emits.`,
            ].join("\n");
        case "skills_dir_missing":
            return `Skills directory not found${e.path ? ` at ${e.path}` : ""}. Set \`harness.skillsDir\` in config.json (a checkout's \`skills/\` tree).`;
        case "templates_dir_missing":
            return `Templates directory not found${e.path ? ` at ${e.path}` : ""}. Set \`harness.templatesDir\` in config.json (a checkout's \`templates/\` tree).`;
        case "content_materialize_failed":
            return [
                `Could not unpack the bundled skills/templates into ${env.contentDir} (${e.cause.type}).`,
                "Ensure the data directory is writable, or point `harness.skillsDir`/`harness.templatesDir` at your own trees in config.json.",
            ].join("\n");
        case "proxy_key_missing":
            return "Proxy client key not found — run `inflexa setup` to provision the proxy first.";
        case "model_api_key_missing":
            return [
                "A direct model connection needs its API key in the `INFLEXA_MODEL_API_KEY` environment variable, which is unset.",
                `Export it (e.g. \`export INFLEXA_MODEL_API_KEY=…\`) — the key is read from the environment only, never from ${env.configPath}.`,
            ].join("\n");
        case "model_unresolved":
            return e.cause.type === "no_models"
                ? "The proxy lists no models — authenticate a provider via `inflexa setup`, or set `harness.model` in config.json."
                : `The proxy is unreachable (${e.cause.type === "proxy_unreachable" ? e.cause.detail : e.cause.type}) — is the container running? Try \`inflexa setup\`.`;
        case "model_provider_mismatch":
            return [
                `The proxy's auto-resolved model "${e.model}" does not match the configured provider "${e.provider}", but the chat route is built for that provider.`,
                `Authenticate the "${e.provider}" account via \`inflexa setup\`, or set \`harness.model\` (a model that provider serves) or \`models.connection.provider\` in config.json.`,
            ].join("\n");
        case "model_required":
            return [
                `A direct model connection needs an explicit model for the ${e.agents.join(" and ")} agent${e.agents.length > 1 ? "s" : ""} — there is no proxy \`/models\` to auto-resolve one from.`,
                "Set `harness.model` in config.json (applies to both agents), or `models.agents.<agent>` per agent, to the model id your endpoint serves.",
            ].join("\n");
        case "sandbox_engine_unresolved":
            // The message was built at resolution time against the pinned runtime AND
            // host platform (start the podman machine on macOS; enable `podman.socket`
            // on Linux; or the container-runtime remediation when no runtime resolved),
            // so it already names the exact command to run — surface it verbatim.
            return e.message;
        case "postgres_unavailable":
            return e.cause.message;
        case "ingress_failed":
            return "Could not bind the local callback listener (loopback, ephemeral port) — check for exhausted ports or a restrictive firewall.";
        case "runtime_already_active":
            // Accepted-for-now limitation of the embedded-runtime topology (one DBOS engine,
            // executor "local", per machine). The fix is the client–server split — a single
            // `inflexa serve` daemon owning the runtime, commands as HTTP clients — tracked
            // with full context in inflexa-ai/inf-cli#33.
            return `Another \`inflexa\` process (pid ${e.holderPid}) is already running the harness runtime. Only one harness runtime per machine at a time — wait for it to finish or stop that process.`;
        case "runtime_boot_failed":
            return `Harness runtime failed to boot: ${e.cause instanceof Error ? e.cause.message : String(e.cause)}`;
        default: {
            const exhaustive: never = e;
            throw new Error(`unhandled boot error: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/**
 * Pre-flight: the configured sandbox image must be present before staging — after
 * staging it is too late to find out. A missing PUBLISHED variant image is pulled
 * from GHCR (offered + confirmed on a TTY, pulled directly otherwise); a missing
 * CUSTOM local tag can't be pulled, so we hint the build. Never a silent dead-end.
 * Exported so `inflexa run` reuses profile's identical image check.
 */
export async function ensureSandboxImage(image: string): Promise<void> {
    const rtResult = await ensureRuntime();
    if (rtResult.isErr()) fail(rtResult.error.message);
    const rt = rtResult.value;
    if ((await capture(rt, ["image", "inspect", image])).code === 0) return;

    const variant = variantOfImage(image);
    if (variant === null) {
        // A custom local tag (a user's `FROM` image) — we cannot pull it.
        fail(
            [
                `Sandbox image "${image}" not found in ${rt.id}.`,
                `Build it locally (e.g. \`${rt.bin} build -f images/sandbox-python-r/Dockerfile -t ${image} .\`),`,
                "or set `harness.sandboxImage` to a published `ghcr.io/inflexa-ai/sandbox-*` tag and run `inflexa sandbox pull`.",
            ].join("\n"),
        );
    }

    // Published variant: offer + pull. The image is genuinely required to launch a
    // sandbox, so a decline is an actionable stop, not a silent dead-end.
    if (process.stdin.isTTY) {
        console.log(`\n  Sandbox image "${image}" (${variant}) is not installed.`);
        const proceed = await confirm("Pull it from GitHub Packages now? (may be a multi-GB download)");
        if (!proceed) fail("A sandbox image is required to run a profile. Run `inflexa sandbox pull` and retry.");
    } else {
        console.log(`  Sandbox image "${image}" not present — pulling ${variant} from GitHub Packages…`);
    }
    const code = await inherit(rt, ["pull", image]);
    if (code !== 0) fail(`Failed to pull ${image} (\`${rt.bin} pull\` exited ${code}). Check your network and that ghcr.io is reachable.`);
}

/**
 * Seed the harness ledger row and build the {@link DataProfileTriggerParams} for `staged` — the ONE
 * construction shared by `inflexa profile` ({@link runProfile}) and the TUI parity auto-trigger
 * (`ensureProfileAtParity` in `profile_trigger.ts`). The field mapping IS the ledger contract, so it
 * lives in exactly one place: drift between the two callers would corrupt the ledger. `context` and
 * `billingContext` stay null (neither caller has goal text at profile time, and fabricating one would
 * pollute the agent prompt); `inputFileIds` is the staged manifest's file ids; the auth is the local
 * OSS value; the manifest rides into the trigger params verbatim.
 */
export function seedProfileLedger(pool: Pool, analysisId: string, staged: readonly StagedInput[]): ResultAsync<DataProfileTriggerParams, DbError> {
    return upsertAnalysis(
        pool,
        analysisId,
        null,
        null,
        staged.map((f) => f.fileId),
    ).map(() => ({ auth: makeLocalAuth(), analysisId, stagedInputs: staged }));
}

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
    const lock = acquireInstanceLock(analysis.id);
    if (!lock.acquired) {
        fail(`"${analysis.name}" is already open in another instance (pid ${lock.holderPid}). Wait for it to finish or stop that process, then re-run.`);
    }

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
 * Latest DBOS step of the NEWEST workflow selected by `selectNewestWorkflowUuid`,
 * read from `dbos.operation_outputs`. Generalized so both the profile wait (below)
 * and the run wait (`run.ts`) share one reader: the caller supplies a scalar
 * subquery resolving to the target `workflow_uuid` (its `$N` params bind against
 * `values`), and this wraps it in the fixed newest-step projection. Returns `null`
 * on any miss or error — progress is a cosmetic channel and a hiccup here must
 * never abort a live wait.
 */
export async function readNewestWorkflowStep(
    pool: Pool,
    selectNewestWorkflowUuid: { text: string; values: unknown[] },
): Promise<{ step: number; label: string } | null> {
    try {
        const result = await pool.query<{ function_id: number; function_name: string }>({
            text: `SELECT oo.function_id, oo.function_name
             FROM dbos.operation_outputs oo
             WHERE oo.workflow_uuid = (${selectNewestWorkflowUuid.text})
             ORDER BY oo.function_id DESC LIMIT 1`,
            values: selectNewestWorkflowUuid.values,
        });
        const row = result.rows[0];
        if (!row) return null;
        return { step: Number(row.function_id) + 1, label: friendlyStepLabel(row.function_name) };
    } catch {
        return null;
    }
}

/**
 * Latest step of the newest profile workflow for this analysis, read from the
 * DBOS step record. Returns `null` on any miss or error: progress is a
 * cosmetic channel, and a hiccup here must never abort a live run's wait.
 */
async function readRunProgress(pool: Pool, analysisId: string): Promise<{ step: number; label: string } | null> {
    return readNewestWorkflowStep(pool, {
        text: `SELECT workflow_uuid FROM dbos.workflow_status
                 WHERE workflow_uuid LIKE 'dataprofile:' || $1 || ':%'
                 ORDER BY created_at DESC LIMIT 1`,
        values: [analysisId],
    });
}

/** Human-readable elapsed time since `sinceMs`, e.g. `2m05s` or `42s`. Shared with the run wait. */
export function formatElapsed(sinceMs: number): string {
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
 * Run `fn` against the harness ledger pool for a read-only `--status` view, then
 * clean up. Reuses the booted runtime's pool when THIS process owns one, else
 * opens a throwaway connection to an already-running Postgres and drains it after.
 * Never boots or provisions — a status view is pure observation. `hasRuntime`
 * tells `fn` whether a runtime is live here, which the views use to annotate a
 * `running` row (a row with no local runtime is owned elsewhere or recovering).
 *
 * Shared by `inflexa profile --status` and `inflexa run --status` — the acquire
 * and throwaway-drain are identical, so they live here once rather than once per
 * command.
 */
export async function withStatusPool<T>(fn: (pool: Pool, hasRuntime: boolean) => Promise<T>): Promise<T> {
    const runtime = activeHarnessRuntime();
    let pool: Pool | null = runtime?.pool ?? null;
    let throwaway = false;
    if (!pool) {
        const conn = resolvePostgresConfig();
        pool = createPool({ host: conn.host, port: String(conn.port), database: conn.database, user: conn.user, password: conn.password, sslMode: "disable" });
        throwaway = true;
    }

    try {
        return await fn(pool, runtime !== null);
    } finally {
        if (throwaway && pool) {
            await pool.end().catch(() => {
                // Read-only convenience connection; a failed drain must not fail the command.
            });
        }
    }
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
