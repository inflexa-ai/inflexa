import { Command } from "commander";

import pkg from "../../package.json";
import { env, envDoc, type EnvDocEntry } from "../lib/env.ts";

/** The root command. `src/index.ts` wires telemetry/logging, then calls `cli.parseAsync()`. */
export const cli = new Command();

/**
 * The Paths/Environment tables appended to the root `--help`. Built from `envDoc`
 * — the single source of truth for documented paths/vars — so adding an entry
 * there surfaces it here automatically. Attached only to the root command (via
 * `addHelpText("after")`, not `"afterAll"`), so focused subcommand help such as
 * `inf setup --help` stays uncluttered.
 */
function renderEnvHelp(): string {
    const pathRows: string[][] = [];
    const varRows: string[][] = [];
    // A path's base directory is overridable by a single env var; collect the
    // labels each base var covers so the override is documented once, naming
    // every path it moves.
    const baseVarLabels = new Map<string, string[]>();

    for (const [key, doc] of Object.entries(envDoc) as [keyof typeof envDoc, EnvDocEntry][]) {
        if (doc.kind === "path") {
            pathRows.push([doc.label, env[key] ?? "", doc.description]);
            baseVarLabels.set(doc.baseVar, [...(baseVarLabels.get(doc.baseVar) ?? []), doc.label]);
        } else {
            varRows.push([doc.name, doc.description]);
        }
    }
    for (const [name, labels] of baseVarLabels) {
        varRows.push([name, `overrides the base directory for: ${labels.join(", ")}`]);
    }

    const table = (rows: string[][]): string => {
        const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
        return rows.map((row) => "  " + row.map((cell, i) => (i < row.length - 1 ? cell.padEnd(widths[i]!) : cell)).join("  ")).join("\n");
    };

    return `\nPaths:\n${table(pathRows)}\n\nEnvironment:\n${table(varRows)}`;
}

cli.name(pkg.name).description("Launch the interactive TUI (default), or run one of the commands below.").version(pkg.version);

// Commander exits via process.exit() for --help/--version/parse errors. That
// abrupt exit races pino's async log destination, whose on-exit flush throws
// "sonic boom is not ready yet" when the log file's fd has not opened yet. Make
// Commander throw a CommanderError instead; src/index.ts catches it and drains
// through the normal beforeExit -> shutdown() path, which flushes logs and
// telemetry cleanly. Set before the subcommands so they inherit the behavior.
cli.exitOverride();

// Default command: bare `inf` resolves the analysis context for the current directory
// (cwd's anchor → its analyses) and opens/pick/starts a chat, per the data model's central
// "cd to the data, run inf, chat" flow. `--analysis`/`--project` override cwd resolution.
// Commander runs this action when no registered subcommand matches.
cli.option("--analysis <id|name>", "Operate on a specific analysis")
    .option("--project <name>", "Scope to a project")
    .action(async (options: { analysis?: string; project?: string }) => {
        const { launchDefault } = await import("../tui/app.launch.tsx");
        await launchDefault({ analysis: options.analysis, project: options.project });
    });

cli.command("sessions")
    .description("List saved sessions")
    .action(async () => {
        const { listSessions } = await import("../modules/session/sessions.ts");
        await listSessions();
    });

cli.command("config")
    .description("View and change settings")
    .action(async () => {
        const { launchConfig } = await import("../tui/app_config.tsx");
        await launchConfig();
    });

// Analysis lifecycle: the primary entity. `new`/`resume` open a chat (TUI layer); `ls`/
// `status`/`open` are read-only text commands (module layer).
cli.command("new [name] [paths...]")
    .description("Create an analysis anchored at the current directory and open its chat")
    .option("--project <name>", "Group the analysis under a project")
    .option("--output <path>", "Write outputs here instead of the derived default")
    .action(async (name: string | undefined, paths: string[] | undefined, options: { project?: string; output?: string }) => {
        const { launchNew } = await import("../tui/app.launch.tsx");
        await launchNew({ name, paths: paths ?? [], project: options.project, output: options.output });
    });

cli.command("ls")
    .description("List recent analyses")
    .option("--project <name>", "Only analyses in this project")
    .action(async (options: { project?: string }) => {
        const { runLs } = await import("../modules/analysis/ls.ts");
        runLs({ project: options.project });
    });

cli.command("resume <idOrName>")
    .description("Reopen an analysis's chat by id or name")
    .action(async (idOrName: string) => {
        const { launchResume } = await import("../tui/app.launch.tsx");
        await launchResume(idOrName);
    });

cli.command("open <idOrName>")
    .description("Open an analysis's output directory in the file browser")
    .action(async (idOrName: string) => {
        const { runOpen } = await import("../modules/analysis/open.ts");
        runOpen(idOrName);
    });

cli.command("status")
    .description("Print what `inf` resolves to right now (loud context)")
    .option("--analysis <id|name>", "Resolve a specific analysis")
    .option("--project <name>", "Scope to a project")
    .action(async (options: { analysis?: string; project?: string }) => {
        const { runStatus } = await import("../modules/analysis/status.ts");
        runStatus({ analysis: options.analysis, project: options.project });
    });

const analysisCmd = cli.command("analysis").description("Manage analyses (grouping)");

analysisCmd
    .command("set-project <analysis> [project]")
    .description("Attach, move, or clear an analysis's project grouping (omit project to clear)")
    .action(async (analysisRef: string, projectRef: string | undefined) => {
        const { runSetProject } = await import("../modules/analysis/set_project.ts");
        runSetProject(analysisRef, projectRef ?? null);
    });

// Real git-style nested subcommands — the reason for moving off cac, which could
// not match a two-word command like `project new` (it compares only the first
// positional token to a command name).
const project = cli.command("project").description("Manage projects (optional grouping of analyses)");

project
    .command("new <name>")
    .description("Create a project")
    .option("--description <text>", "A short description")
    .option("--tags <tags>", "Comma-separated tags")
    .action(async (name: string, options: { description?: string; tags?: string }) => {
        const { projectNew } = await import("../modules/project/project.ts");
        projectNew(name, { description: options.description, tags: options.tags });
    });

project
    .command("ls")
    .description("List projects")
    .action(async () => {
        const { projectLs } = await import("../modules/project/project.ts");
        projectLs();
    });

// Anchor move-backstop: the manual fallback for folder moves that the automatic
// reconciliation in `resolveAnchor` cannot settle on its own. All addressed by path.
cli.command("repair [path]")
    .description("Reconcile the anchor marker at <path> (default: current directory)")
    .action(async (path: string | undefined) => {
        const { runRepair } = await import("../modules/anchor/backstop.ts");
        runRepair(path);
    });

cli.command("relocate [fromPath] [toPath]")
    .description("Re-point a moved anchor — one path pair, or all anchors under a prefix with --from/--to")
    .option("--from <prefix>", "Path prefix to rewrite from (bulk mode)")
    .option("--to <prefix>", "Path prefix to rewrite to (bulk mode)")
    .action(async (fromPath: string | undefined, toPath: string | undefined, options: { from?: string; to?: string }) => {
        const { runRelocate } = await import("../modules/anchor/backstop.ts");
        await runRelocate({ fromPath, toPath, from: options.from, to: options.to });
    });

cli.command("prune")
    .description("Drop anchors whose folders are confirmed gone and unrecoverable")
    .action(async () => {
        const { runPrune } = await import("../modules/anchor/backstop.ts");
        await runPrune();
    });

// Auth verbs grouped under one parent, à la `gh auth login|logout|status`.
const auth = cli.command("auth").description("Manage authentication (Auth0 device flow)");

auth.command("login")
    .description("Log in via the Auth0 device flow")
    .action(async () => {
        const { login } = await import("../modules/auth/login.ts");
        await login();
    });

auth.command("logout")
    .description("Log out and revoke the stored session")
    .action(async () => {
        const { logout } = await import("../modules/auth/logout.ts");
        await logout();
    });

auth.command("whoami")
    .description("Show the logged-in user and session status")
    .action(async () => {
        const { whoami } = await import("../modules/auth/whoami.ts");
        whoami();
    });

cli.command("setup")
    .description("Install, authenticate, and start CLIProxyAPI (Docker or Podman)")
    .option("--provider <name>", "Authenticate a provider non-interactively: gemini|openai|claude|qwen|iflow")
    .option("--no-auth", "Skip the provider authentication step")
    .option("--no-start", "Set up only; don't start the proxy container")
    .option("--force", "Re-pull the proxy image even if it is already cached")
    .action(async (options: { provider?: string; auth: boolean; start: boolean; force?: boolean }) => {
        const { setup } = await import("../modules/proxy/setup.ts");
        await setup({ provider: options.provider, auth: options.auth, start: options.start, force: options.force ?? false });
    });

cli.addHelpText("after", renderEnvHelp);
