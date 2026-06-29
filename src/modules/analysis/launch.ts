import { findProjectByRef, getSession, listSessionsByAnalysis } from "../../db/primary_query.ts";
import { createSession } from "../../db/primary_mutation.ts";
import { recoverAnchors, resolveAnchor } from "../anchor/anchor.ts";
import { confirm, dieOn, fail, promptText, select } from "../../lib/cli.ts";
import { getLogger } from "../../lib/log.ts";
import { str256, type Str256, type IdOrName } from "../../lib/types.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { Session } from "../../types/session.ts";
import { createAnalysis, matchAnalysis } from "./analysis.ts";
import { resolveContext, describeContext, type ContextFlags } from "./context.ts";
import { resolveOutputDir } from "./output.ts";

// Headless launch resolution: the logic behind bare `inflexa`, `inflexa new`, and `inflexa resume` that
// decides which analysis/chat to open (resolving context, prompting, creating) and produces a
// ChatTarget the presentation layer renders. It is NOT presentation — it touches db/, anchor,
// analysis, and lib/cli (clack) only, never tui/. The actual hand-off to the renderer lives in
// tui/launch.tsx, which calls these resolvers and renders their result. The clack prompts run
// in the normal-stdio phase, before the renderer takes over the terminal.

/** What the renderer needs to open a chat: the resolved session, its working directory, and the analysis it belongs to. */
export type ChatTarget = {
    /** The session to render — resumed, most-recent, or freshly created. */
    sessionId: string;
    /** Absolute path the chat is rooted at (the analysis's resolved anchor path). */
    workingDir: string;
    /** The analysis the chat operates on. */
    analysis: Analysis;
};

/**
 * Resolve the chat target for an analysis: root it at the analysis's anchor path and pick the
 * session to open — the given one, the most-recent, or a fresh one linked to the analysis.
 */
function resolveChatTarget(opts: { analysis: Analysis; resumeSessionId?: string }): ChatTarget {
    const analysis = opts.analysis;
    const workingDir = resolveAnchor(analysis.anchorId).match(
        (resolved) => (resolved ? (resolved.path ?? resolved.anchor.cachedPath) : process.cwd()),
        () => process.cwd(),
    );

    // Automatic anchor recovery: heal anchors whose folders moved since last run so the chat
    // resolves to the live path. Recovery only, NEVER creation (no-litter policy) — minting a
    // marker is reserved for a deliberate action like `inflexa new`, never a passive launch.
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

    return { sessionId: session.id, workingDir, analysis };
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

// Mint a fresh analysis anchored at `cwd` and resolve its chat. A deliberate action, so writing
// the anchor marker here is allowed (no-litter policy).
async function startNewTarget(cwd: string): Promise<ChatTarget> {
    const name = await promptName();
    const analysis = createAnalysis({ cwd, name }).match((a) => a, dieOn("Failed to start analysis"));
    return resolveChatTarget({ analysis });
}

// Numbered picker over existing analyses plus a trailing "start new" entry.
async function pickOrStartTarget(analyses: Analysis[], cwd: string): Promise<ChatTarget> {
    const NEW = "\0new"; // sentinel value that cannot collide with a uuidv7 id
    const choice = await select("Pick an analysis:", [
        ...analyses.map((a) => ({ value: a.id, label: a.name })),
        { value: NEW, label: "Start a new analysis here" },
    ]);
    if (choice === NEW) return startNewTarget(cwd);
    const chosen = analyses.find((a) => a.id === choice);
    if (!chosen) fail("No selection.");
    return resolveChatTarget({ analysis: chosen });
}

/** `inflexa new [name] [paths...]` — create an analysis (anchor = cwd) and resolve its chat target. */
export async function resolveNewTarget(opts: { name?: string; paths: string[]; project?: string; output?: string }): Promise<ChatTarget> {
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

    return resolveChatTarget({ analysis });
}

/** `inflexa resume <id|name>` — resolve the chat target for an existing analysis. */
export function resolveResumeTarget(ref: IdOrName): ChatTarget {
    const match = matchAnalysis(ref).match((m) => m, dieOn("Failed to resolve analysis"));
    if (!match) fail(`No analysis found matching "${ref}".`);

    // When the ref matched by name/slug and several analyses share it, surface the ambiguity
    // rather than silently picking the most recent (matchAnalysis already resolved one match).
    if (match.others.length > 0) {
        console.error(`Multiple analyses match "${ref}":`);
        for (const a of [match.analysis, ...match.others]) console.error(`  ${a.id}  ${a.name}`);
        fail("Re-run `inflexa resume` with a specific id.");
    }

    return resolveChatTarget({ analysis: match.analysis });
}

/**
 * Bare `inflexa [--analysis <x>|--project <p>]`: resolve context, print it loudly, then resolve a
 * chat target by opening/picking/starting. Returns null when there is nothing to render
 * (cancelled, or a copied folder that must be repaired first).
 */
export async function resolveDefaultTarget(flags: ContextFlags): Promise<ChatTarget | null> {
    const cwd = process.cwd();
    const ctx = resolveContext(cwd, flags).match((c) => c, dieOn("Failed to resolve context"));
    console.log(describeContext(ctx));

    switch (ctx.kind) {
        case "analysis":
            return resolveChatTarget({ analysis: ctx.analysis });
        case "anchor": {
            const [only] = ctx.analyses;
            if (ctx.analyses.length === 1 && only) return resolveChatTarget({ analysis: only });
            if (ctx.analyses.length === 0) {
                if (await confirm(`No analyses here yet. Start one in ${ctx.anchorPath}?`)) return startNewTarget(cwd);
                console.log("Cancelled.");
                return null;
            }
            return pickOrStartTarget(ctx.analyses, cwd);
        }
        case "pick": {
            if (ctx.analyses.length === 0) fail("No matching analyses.");
            const choice = await select(
                "Pick an analysis:",
                ctx.analyses.map((a) => ({ value: a.id, label: a.name })),
            );
            const chosen = ctx.analyses.find((a) => a.id === choice);
            if (!chosen) fail("No selection.");
            return resolveChatTarget({ analysis: chosen });
        }
        case "empty":
            if (await confirm(`Start a new analysis in ${ctx.cwd}?`)) return startNewTarget(cwd);
            console.log("Cancelled.");
            return null;
        case "copy":
            // Never auto-resolve a copy (spec). The clone/fork flow is the anchor module's
            // job and isn't wired yet — direct the user to the backstop instead of guessing.
            // TODO(extend): offer re-mint+clone vs fork once the copy-resolution lands.
            console.log("  This folder looks like a copy of a tracked folder.");
            console.log("  Re-mint or relocate its identity before use: `inflexa repair` / `inflexa relocate`.");
            return null;
    }
}
