import type { AnalysisSummary, AnalysisView, InputView } from "../../api/analyses.ts";
import { MAX_PER_PAGE } from "../../api/common.ts";
import { confirm, fail, promptText, select } from "../../lib/cli.ts";
import { openExternal } from "../../lib/open_external.ts";
import { expandAndResolve } from "../../lib/paths.ts";
import { str256, type IdOrName, type Str256 } from "../../lib/types.ts";
import type { Analysis } from "../../types/analysis.ts";
import { DEFAULT_CLIENT_OPTS, describeClientError, type ClientError, type ClientOpts } from "../api.ts";
import {
    addInputs,
    createAnalysis,
    createOutputDir,
    fetchAnalyses,
    fetchAnalysis,
    fetchInputs,
    removeInputs,
    resolveAnalysisContext,
    toAnalysis,
    updateAnalysis,
    workingDirOf,
} from "../analyses.ts";

// The analysis commands as clients of the local server: the launch resolvers of the chat (bare
// `inflexa`, `new`, `resume`), and the text commands `ls`, `status`, `open`, `analysis set-project`, and
// `inputs`. The prompts run here, in the terminal of the client, before a renderer takes it over. Each
// relative path of the user resolves against the folder of THIS process before it goes to the server.

/** The flags that name an analysis or a project instead of the folder, each by id or by name. */
export type ContextFlags = { analysis?: IdOrName; project?: IdOrName };

/** What the renderer needs to open a chat: its working folder and the analysis it belongs to. */
export type ChatTarget = {
    /** The absolute folder the chat is rooted at: the anchor folder of the analysis. */
    workingDir: string;
    analysis: Analysis;
};

/** Print the client error and exit: the end of each command on a failed request. */
function failClient(e: ClientError): never {
    return fail(describeClientError(e));
}

/**
 * Open the chat target of an analysis: `GET {A}` takes its instance lock and reconciles its anchor folder.
 * A lock that a different process holds stops the launch before the screen is taken, as a plain line.
 */
async function openTarget(analysisId: string, opts: ClientOpts): Promise<ChatTarget> {
    const detail = (await fetchAnalysis(analysisId, process.cwd(), opts)).match((v) => v, failClient);
    return { workingDir: workingDirOf(detail), analysis: toAnalysis(detail) };
}

// Prompt for a valid analysis name, validating live and asking again until one is given.
async function promptName(): Promise<Str256> {
    const raw = await promptText("Analysis name", {
        validate: (v) =>
            str256(v).match(
                () => undefined,
                (e) => (e === "empty" ? "A name is required." : "Keep it to 256 characters or fewer."),
            ),
    });
    return str256(raw).match(
        (s) => s,
        () => fail("Invalid name."),
    );
}

// Make an analysis anchored at `cwd` and open its chat. A deliberate action, so the server writes the
// anchor marker here (no-litter policy).
async function startNewTarget(cwd: string, opts: ClientOpts): Promise<ChatTarget> {
    const name = await promptName();
    const created = (await createAnalysis({ name, folder: cwd }, opts)).match((v) => v, failClient);
    return openTarget(created.id, opts);
}

// Numbered picker over existing analyses plus a trailing "start new" entry.
async function pickOrStartTarget(analyses: AnalysisView[], cwd: string, opts: ClientOpts): Promise<ChatTarget> {
    const NEW = "\0new"; // sentinel value that cannot collide with a uuidv7 id
    const choice = await select("Pick an analysis:", [
        ...analyses.map((a) => ({ value: a.id, label: a.name })),
        { value: NEW, label: "Start a new analysis here" },
    ]);
    if (choice === NEW) return startNewTarget(cwd, opts);
    return openTarget(choice, opts);
}

/** `inflexa new [name] [paths...]` — make an analysis anchored at this folder, and resolve its chat target. */
export async function resolveNewTarget(
    flags: { name?: string; paths: string[]; project?: string },
    opts: ClientOpts = DEFAULT_CLIENT_OPTS,
): Promise<ChatTarget> {
    // Name is required (1–256 code points): validate a provided one, otherwise prompt for it.
    const name =
        flags.name === undefined
            ? await promptName()
            : str256(flags.name).match(
                  (s) => s,
                  (e) => fail(e === "empty" ? "A name is required." : "Keep the name to 256 characters or fewer."),
              );
    const cwd = process.cwd();
    const created = (
        await createAnalysis(
            { name, folder: cwd, inputs: flags.paths.map((p) => expandAndResolve(cwd, p)), ...(flags.project === undefined ? {} : { project: flags.project }) },
            opts,
        )
    ).match((v) => v, failClient);
    console.log(`\n  Created analysis "${created.name}"`);
    if (created.outputDir !== null) console.log(`  Workspace: ${created.outputDir}\n`);
    return openTarget(created.id, opts);
}

/** `inflexa resume <id|name>` — resolve the chat target of an existing analysis. */
export async function resolveResumeTarget(ref: IdOrName, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<ChatTarget> {
    const ctx = (await resolveAnalysisContext({ cwd: process.cwd(), ref, recover: true }, opts)).match((v) => v, failClient);
    if (ctx.kind !== "analysis") fail(`No analysis found matching "${ref}".`);
    // When the ref matched by name or slug and more analyses share it, surface the ambiguity rather than
    // silently pick the most recent.
    if (ctx.others.length > 0) {
        console.error(`Multiple analyses match "${ref}":`);
        for (const a of [ctx.analysis, ...ctx.others]) console.error(`  ${a.id}  ${a.name}`);
        fail("Re-run `inflexa resume` with a specific id.");
    }
    return openTarget(ctx.analysis.id, opts);
}

/**
 * Bare `inflexa [--analysis <x>|--project <p>]`: resolve the context, print it loudly, then resolve a chat
 * target by an open, a pick, or a new analysis. `null` when there is nothing to render (canceled, or a
 * copied folder that must be repaired first).
 */
export async function resolveDefaultTarget(flags: ContextFlags, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<ChatTarget | null> {
    const cwd = process.cwd();
    const ctx = (await resolveAnalysisContext({ cwd, ref: flags.analysis, project: flags.project, recover: true }, opts)).match((v) => v, failClient);
    console.log(ctx.describe);

    switch (ctx.kind) {
        case "analysis":
            return openTarget(ctx.analysis.id, opts);
        case "anchor": {
            const [only] = ctx.analyses;
            if (ctx.analyses.length === 1 && only) return openTarget(only.id, opts);
            if (ctx.analyses.length === 0) {
                if (await confirm(`No analyses here yet. Start one in ${ctx.anchorPath}?`)) return startNewTarget(cwd, opts);
                console.log("Cancelled.");
                return null;
            }
            return pickOrStartTarget(ctx.analyses, cwd, opts);
        }
        case "pick": {
            if (ctx.analyses.length === 0) fail("No matching analyses.");
            const choice = await select(
                "Pick an analysis:",
                ctx.analyses.map((a) => ({ value: a.id, label: a.name })),
            );
            return openTarget(choice, opts);
        }
        case "empty":
            if (await confirm(`Start a new analysis in ${ctx.cwd}?`)) return startNewTarget(cwd, opts);
            console.log("Cancelled.");
            return null;
        case "copy":
            // Never auto-resolve a copy (spec). The clone/fork flow is the anchor module's job and is not
            // wired yet — direct the user to the backstop instead of guessing.
            // TODO(extend): offer re-mint+clone vs fork once the copy-resolution lands.
            console.log("  This folder looks like a copy of a tracked folder.");
            console.log("  Re-mint or relocate its identity before use: `inflexa repair` / `inflexa relocate`.");
            return null;
        default: {
            const exhaustive: never = ctx;
            throw new Error(`unhandled context kind: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/**
 * Resolve the single analysis that a command operates on, or exit with a way forward: an explicit
 * `--analysis`, or a folder that holds exactly one analysis. `emptyHint` is the only difference between
 * the commands: their "how to start" line.
 *
 * `resolve.touch: false` keeps the resolve from recording a sighting of the anchor folder: a read command
 * is not a sighting, and an agent can run an `auto` command unprompted.
 */
export async function resolveSingleAnalysisOrFail(
    flags: ContextFlags,
    emptyHint: string,
    resolve: { touch?: boolean } = {},
    opts: ClientOpts = DEFAULT_CLIENT_OPTS,
): Promise<AnalysisView> {
    const ctx = (
        await resolveAnalysisContext(
            { cwd: process.cwd(), ref: flags.analysis, project: flags.project, ...(resolve.touch === undefined ? {} : { touch: resolve.touch }) },
            opts,
        )
    ).match((v) => v, failClient);
    const listCandidates = (analyses: AnalysisView[]): string => analyses.map((a) => `  - ${a.id}  ${a.name}`).join("\n");
    switch (ctx.kind) {
        case "analysis":
            return ctx.analysis;
        case "anchor": {
            const [only, ...rest] = ctx.analyses;
            if (only && rest.length === 0) return only;
            if (!only) fail("No analyses on this anchor yet. Run `inflexa new` to create one first.");
            return fail(`Multiple analyses here — pick one with --analysis <id|name>:\n${listCandidates(ctx.analyses)}`);
        }
        case "pick":
            return fail(`Ambiguous context — pick one with --analysis <id|name>:\n${listCandidates(ctx.analyses)}`);
        case "empty":
            return fail(emptyHint);
        case "copy":
            return fail("This folder is a copied anchor — run `inflexa repair` or `inflexa relocate` first.");
        default: {
            const exhaustive: never = ctx;
            throw new Error(`unhandled context kind: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/**
 * The analysis that `ref` names, by id or by name, or exit. A name that more analyses share fails with each
 * candidate: its id, its name, its local creation time, and its last known folder, so the user recognizes
 * the one they mean and runs the command again with its exact id. The failure is deterministic, never a
 * prompt, because the callers (the `prov` commands) are headless-first.
 */
export async function requireAnalysisByRef(ref: IdOrName, resolve: { touch?: boolean } = {}, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<AnalysisView> {
    const ctx = (await resolveAnalysisContext({ cwd: process.cwd(), ref, ...(resolve.touch === undefined ? {} : { touch: resolve.touch }) }, opts)).match(
        (v) => v,
        failClient,
    );
    if (ctx.kind !== "analysis") fail(`No analysis found matching "${ref}".`);
    if (ctx.others.length > 0) {
        const list = [{ ...ctx.analysis, anchorPath: ctx.anchorPath }, ...ctx.others]
            // "(folder unknown)" reads as a fact about the local state, not a failure: the anchor row is gone.
            .map((c) => `  ${c.id}  ${c.name}  ${new Date(c.createdAt).toLocaleString()}  ${c.anchorPath ?? "(folder unknown)"}`)
            .join("\n");
        fail(`Analysis reference "${ref}" is ambiguous — re-run with an exact id:\n${list}`);
    }
    return ctx.analysis;
}

/** The analysis that `ref` names, by id or by name (the newest of a shared name), or exit with `No analysis found matching`. */
async function analysisByRefOrFail(ref: IdOrName, opts: ClientOpts): Promise<AnalysisView> {
    const ctx = (await resolveAnalysisContext({ cwd: process.cwd(), ref }, opts)).match((v) => v, failClient);
    if (ctx.kind !== "analysis") fail(`No analysis found matching "${ref}".`);
    return ctx.analysis;
}

/** `inflexa ls [--project <p>]` — list the recent analyses, each with its home folder. */
export async function analysisLs(flags: { project?: string }, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const analyses: AnalysisSummary[] = [];
    // One request for each page of the largest size: each request is bounded, and the loop ends at the
    // first page with no more.
    for (let page = 0; ; page++) {
        const list = (await fetchAnalyses({ page, perPage: MAX_PER_PAGE, ...(flags.project === undefined ? {} : { project: flags.project }) }, opts)).match(
            (v) => v,
            failClient,
        );
        analyses.push(...list.analyses);
        if (!list.hasMore) break;
    }
    if (analyses.length === 0) {
        console.log("No analyses found.");
        return;
    }
    console.log(`\n  Analyses (${analyses.length}):\n`);
    for (const a of analyses) {
        // The cached anchor path, as the list gives it: a read-only display reconciles nothing.
        console.log(`  ${a.id}  ${a.name}  ${a.anchorPath ?? "?"}  (${new Date(a.createdAt).toLocaleString()})`);
    }
    console.log();
}

/** `inflexa status` — print what `inflexa` resolves to now (loud context). It launches nothing. */
export async function analysisStatus(flags: ContextFlags, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const ctx = (await resolveAnalysisContext({ cwd: process.cwd(), ref: flags.analysis, project: flags.project }, opts)).match((v) => v, failClient);
    console.log(ctx.describe);
    switch (ctx.kind) {
        case "analysis":
            console.log(`  anchor:      ${ctx.anchorPath}`);
            console.log(`  anchor id:   ${ctx.analysis.anchorId}`);
            console.log(`  analysis:    ${ctx.analysis.id}  ${ctx.analysis.name}`);
            return;
        case "anchor": {
            console.log(`  anchor:      ${ctx.anchorPath}`);
            const [first] = ctx.analyses;
            if (first) console.log(`  anchor id:   ${first.anchorId}`);
            console.log(`  analyses:    ${ctx.analyses.length}`);
            for (const a of ctx.analyses) console.log(`    - ${a.id}  ${a.name}`);
            return;
        }
        case "pick":
            console.log(`  candidates:  ${ctx.analyses.length}`);
            for (const a of ctx.analyses) console.log(`    - ${a.id}  ${a.name}`);
            return;
        case "empty":
            console.log(`  no anchor here; \`inflexa\` would start a new analysis in ${ctx.cwd}`);
            return;
        case "copy":
            console.log(`  copied folder — re-mint or relocate before use (\`inflexa repair\`/\`inflexa relocate\`)`);
            return;
        default: {
            const exhaustive: never = ctx;
            throw new Error(`unhandled context kind: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/**
 * `inflexa open <id|name>` — open the workspace folder of an analysis in the file browser. The server makes
 * the folder when it does not exist yet; this process opens it.
 */
export async function analysisOpen(ref: IdOrName, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const analysis = await analysisByRefOrFail(ref, opts);
    const { path } = (await createOutputDir(analysis.id, opts)).match((v) => v, failClient);
    // Fire-and-forget reveal: a missing opener (ENOENT) is not worth a crash — the user still gets the path
    // to print, and under WSL this routes through wslview/explorer.exe.
    openExternal(path).match(
        () => undefined,
        () => undefined,
    );
    console.log(path);
}

/** `inflexa analysis set-project <analysis> [project]` — attach, move, or clear the project of an analysis. */
export async function analysisSetProject(analysisRef: IdOrName, projectRef: IdOrName | null, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const analysis = await analysisByRefOrFail(analysisRef, opts);
    // One request: the server resolves the project before it writes, thus an unknown project never clears the link.
    const updated = (await updateAnalysis(analysis.id, { project: projectRef }, opts)).match((v) => v, failClient);
    console.log(updated.project ? `Set the project of "${analysis.name}" to "${updated.project.name}".` : `Cleared the project of "${analysis.name}".`);
}

/** The `empty`-context hint of the inputs commands. */
const INPUTS_EMPTY_HINT = "No analysis here. Run `inflexa` to start or open one, then manage its inputs.";

/** Printed after a successful change: the server profiles the new input set when its runtime is ready. */
const REPROFILE_HINT = "  The data profile no longer describes this input set. The server starts a new profile of it.";

/** `inflexa inputs ls` — list the current inputs of the analysis. */
export async function inputsLs(flags: ContextFlags, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const analysis = await resolveSingleAnalysisOrFail(flags, INPUTS_EMPTY_HINT, {}, opts);
    const inputs: InputView[] = [];
    for (let page = 0; ; page++) {
        const list = (await fetchInputs(analysis.id, { page, perPage: MAX_PER_PAGE }, opts)).match((v) => v, failClient);
        inputs.push(...list.inputs);
        if (!list.hasMore) break;
    }
    if (inputs.length === 0) {
        console.log(`  "${analysis.name}" has no inputs. Add some with \`inflexa inputs add <paths...>\`.`);
        return;
    }
    console.log(`  Inputs for "${analysis.name}":`);
    for (const input of inputs) console.log(`    ${input.isDir ? "dir " : "file"}  ${input.path}${input.anchorId === null ? "  (absolute)" : ""}`);
}

/** `inflexa inputs add <paths...>` — add files as inputs. The server refuses a path that does not exist. */
export async function inputsAdd(flags: ContextFlags, paths: string[], opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const analysis = await resolveSingleAnalysisOrFail(flags, INPUTS_EMPTY_HINT, {}, opts);
    const cwd = process.cwd();
    const change = (
        await addInputs(
            analysis.id,
            paths.map((p) => expandAndResolve(cwd, p)),
            opts,
        )
    ).match((v) => v, failClient);
    console.log(
        change.added.length === 0
            ? `  Nothing new to add — those paths are already inputs of "${analysis.name}".`
            : `  Added ${change.added.length} input(s) to "${analysis.name}": ${change.added.map((i) => i.path).join(", ")}`,
    );
    if (change.added.length > 0) console.log(REPROFILE_HINT);
}

/** `inflexa inputs remove <paths...>` — drop inputs, matched against the stored set with no check on disk. */
export async function inputsRemove(flags: ContextFlags, paths: string[], opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const analysis = await resolveSingleAnalysisOrFail(flags, INPUTS_EMPTY_HINT, {}, opts);
    const cwd = process.cwd();
    // The absolute form goes to the server; the form that the user typed comes back in the report.
    const typed = new Map(paths.map((p) => [expandAndResolve(cwd, p), p]));
    const change = (await removeInputs(analysis.id, [...typed.keys()], opts)).match((v) => v, failClient);
    const removed = change.removed.map((i) => i.path);
    const notInputs = change.notInputs.map((p) => typed.get(p) ?? p);
    if (removed.length > 0) console.log(`  Removed from "${analysis.name}": ${removed.join(", ")}`);
    if (notInputs.length > 0) console.log(`  Not current inputs (skipped): ${notInputs.join(", ")}`);
    if (removed.length === 0 && notInputs.length === 0) console.log(`  Nothing to remove.`);
    if (removed.length > 0) console.log(REPROFILE_HINT);
}
