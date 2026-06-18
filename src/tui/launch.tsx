import { render } from "@opentui/solid";
import { ConsolePosition } from "@opentui/core";

import { findProjectByRef, getSession, listSessionsByAnalysis } from "../db/primary_query.ts";
import { createSession } from "../db/primary_mutation.ts";
import { ensureProxyReady, ProxyError } from "../modules/proxy/setup.ts";
import { recoverAnchors, resolveAnchor } from "../modules/anchor/anchor.ts";
import { createAnalysis, matchAnalysis } from "../modules/analysis/analysis.ts";
import { resolveContext, describeContext, type ContextFlags, type ResolvedContext } from "../modules/analysis/context.ts";
import { resolveOutputDir } from "../modules/analysis/output.ts";
import { readConfig } from "../lib/config.ts";
import { getLogger } from "../lib/log.ts";
import { confirm, dieOn, fail, promptText, select } from "../lib/cli.ts";
import { str256, type Str256, type IdOrName } from "../lib/types.ts";
import { App } from "./app.tsx";
import { setTheme } from "./theme.ts";
import type { Analysis } from "../types/analysis.ts";
import type { Session } from "../types/session.ts";

// The TUI-entry layer: it decides which analysis/chat to open (resolving context, prompting,
// creating) and then hands the terminal to the opentui renderer. It lives in tui/ because
// launching a chat screen is presentation orchestration, and tui/ may import module logic
// (view → logic) where a module may never import tui/. The interactive prompts (clack, via
// lib/cli) run in the normal-stdio phase here, BEFORE render() takes over the terminal.

// Shared preamble: the TUI can only operate against a running, authenticated CLIProxyAPI.
// Make it ready (auto-start the container, sign in if needed) before the renderer takes over
// the terminal — the auth flow needs normal stdio.
async function ensureProxyReadyOrExit(): Promise<void> {
    try {
        await ensureProxyReady();
    } catch (error) {
        if (error instanceof ProxyError) {
            console.error(`\n  ${error.message}\n`);
        } else {
            console.error("\n  Could not start CLIProxyAPI:", error, "\n");
        }
        process.exit(1);
    }
}

// Shared render: seed the active theme from persisted config before the renderer reads it,
// then hand the terminal to OpenTUI with the options every launcher shares.
function renderApp(sessionId: string, workingDir: string): void {
    setTheme(readConfig().theme);
    void render(() => <App sessionId={sessionId} workingDir={workingDir} />, {
        exitOnCtrlC: false,
        targetFps: 30,
        screenMode: "alternate-screen",
        consoleOptions: {
            position: ConsolePosition.BOTTOM,
            maxStoredLogs: 500,
            sizePercent: 30,
        },
    });
}

/**
 * Open the chat TUI for an analysis: resume the given/most-recent session or create one
 * linked to the analysis, rooted at the analysis's resolved anchor path.
 */
export async function launchChat(opts: { analysis: Analysis; resumeSessionId?: string }): Promise<void> {
    await ensureProxyReadyOrExit();

    const analysis = opts.analysis;
    const workingDir = resolveAnchor(analysis.anchorId).match(
        ({ anchor, path }) => path ?? anchor.cachedPath,
        () => process.cwd(),
    );

    // Automatic anchor recovery: heal anchors whose folders moved since last run so the chat
    // resolves to the live path. Recovery only, NEVER creation (no-litter policy) — minting a
    // marker is reserved for a deliberate action like `inf new`, never a passive launch.
    const log = getLogger("anchor");
    recoverAnchors([workingDir]).match(
        ({ recovered, unresolved }) => {
            if (recovered || unresolved) log.info({ recovered, unresolved }, "recovered anchors at startup");
        },
        (error) => log.warn({ err: error }, "anchor recovery failed"),
    );

    let session: Session | null = null;
    if (opts.resumeSessionId) {
        session = getSession(opts.resumeSessionId).match((s) => s, dieOn("Failed to load session"));
    }
    if (!session) {
        // listSessionsByAnalysis is unordered; pick the most recently active, else start fresh.
        const existing = listSessionsByAnalysis(analysis.id).match(
            (ss) => ss,
            () => [],
        );
        existing.sort((a, b) => b.updatedAt - a.updatedAt);
        const [mostRecent] = existing;
        session = mostRecent ?? createSession({ title: `Chat — ${analysis.name}`, analysisId: analysis.id }).match((s) => s, dieOn("Failed to create session"));
    }

    renderApp(session.id, workingDir);
}

// Prompt for a valid analysis name, validating live and re-asking until one is given.
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

// Mint a fresh analysis anchored at `cwd` and open its chat. A deliberate action, so writing
// the anchor marker here is allowed (no-litter policy).
async function startNewAt(cwd: string): Promise<void> {
    const name = await promptName();
    const analysis = createAnalysis({ cwd, name }).match((a) => a, dieOn("Failed to start analysis"));
    await launchChat({ analysis });
}

// Numbered picker over existing analyses plus a trailing "start new" entry.
async function pickOrStart(analyses: Analysis[], cwd: string): Promise<void> {
    const NEW = "\0new"; // sentinel value that cannot collide with a uuidv7 id
    const choice = await select("Pick an analysis:", [
        ...analyses.map((a) => ({ value: a.id, label: a.name })),
        { value: NEW, label: "Start a new analysis here" },
    ]);
    if (choice === NEW) {
        await startNewAt(cwd);
        return;
    }
    const chosen = analyses.find((a) => a.id === choice);
    if (!chosen) fail("No selection.");
    await launchChat({ analysis: chosen });
}

/** `inf new [name] [paths...]` — create an analysis (anchor = cwd) and open its chat. */
export async function launchNew(opts: { name?: string; paths: string[]; project?: string; output?: string }): Promise<void> {
    let projectId: string | null = null;
    if (opts.project) {
        const project = findProjectByRef(opts.project).match((p) => p, dieOn("Failed to resolve project"));
        if (!project) fail(`No project found matching "${opts.project}".`);
        projectId = project.id;
    }

    // Name is required (1–256 code points): validate a provided one, otherwise prompt for it.
    const name =
        opts.name === undefined
            ? await promptName()
            : str256(opts.name).match(
                  (s) => s,
                  (e) => fail(e === "empty" ? "A name is required." : "Keep the name to 256 characters or fewer."),
              );

    const analysis = createAnalysis({ cwd: process.cwd(), name, inputPaths: opts.paths, outputOverride: opts.output, projectId }).match(
        (a) => a,
        dieOn("Failed to create analysis"),
    );

    const outDir = resolveOutputDir(analysis).match(
        (d) => d,
        () => null,
    );
    console.log(`\n  Created analysis "${analysis.name}"`);
    if (outDir) console.log(`  Output: ${outDir}\n`);

    await launchChat({ analysis });
}

/** `inf resume <id|name>` — reopen an analysis's chat. */
export async function launchResume(ref: IdOrName): Promise<void> {
    const match = matchAnalysis(ref).match((m) => m, dieOn("Failed to resolve analysis"));
    if (!match) fail(`No analysis found matching "${ref}".`);

    // When the ref matched by name/slug and several analyses share it, surface the ambiguity
    // rather than silently picking the most recent (matchAnalysis already resolved one match).
    if (match.others.length > 0) {
        console.error(`Multiple analyses match "${ref}":`);
        for (const a of [match.analysis, ...match.others]) console.error(`  ${a.id}  ${a.name}`);
        fail("Re-run `inf resume` with a specific id.");
    }

    await launchChat({ analysis: match.analysis });
}

/** Bare `inf [--analysis <x>|--project <p>]`: resolve context, print it loudly, then open/pick/start. */
export async function launchDefault(flags: ContextFlags): Promise<void> {
    const cwd = process.cwd();
    const ctx: ResolvedContext = resolveContext(cwd, flags).match((c) => c, dieOn("Failed to resolve context"));
    console.log(describeContext(ctx));

    switch (ctx.kind) {
        case "analysis":
            await launchChat({ analysis: ctx.analysis });
            return;
        case "anchor": {
            const [only] = ctx.analyses;
            if (ctx.analyses.length === 1 && only) {
                await launchChat({ analysis: only });
                return;
            }
            if (ctx.analyses.length === 0) {
                if (await confirm(`No analyses here yet. Start one in ${ctx.anchorPath}?`)) await startNewAt(cwd);
                else console.log("Cancelled.");
                return;
            }
            await pickOrStart(ctx.analyses, cwd);
            return;
        }
        case "pick": {
            if (ctx.analyses.length === 0) fail("No matching analyses.");
            const choice = await select(
                "Pick an analysis:",
                ctx.analyses.map((a) => ({ value: a.id, label: a.name })),
            );
            const chosen = ctx.analyses.find((a) => a.id === choice);
            if (!chosen) fail("No selection.");
            await launchChat({ analysis: chosen });
            return;
        }
        case "empty":
            if (await confirm(`Start a new analysis in ${ctx.cwd}?`)) await startNewAt(cwd);
            else console.log("Cancelled.");
            return;
        case "copy":
            // Never auto-resolve a copy (spec). The clone/fork flow is the anchor module's
            // job and isn't wired yet — direct the user to the backstop instead of guessing.
            // TODO(extend): offer re-mint+clone vs fork once the copy-resolution lands.
            console.log("  This folder looks like a copy of a tracked folder.");
            console.log("  Re-mint or relocate its identity before use: `inf repair` / `inf relocate`.");
            return;
    }
}
