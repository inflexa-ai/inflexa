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
 * `inflexa setup --help` stays uncluttered.
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

/**
 * Parse the `--embeddings` flag value. `undefined` (flag absent) → `undefined`
 * (no preselect — setup prompts interactively); a valid mode string → itself;
 * anything else → `null` (invalid, surfaced as a parse error before setup runs).
 */
function parseEmbeddingMode(value: string | undefined): "local" | "api-key" | "off" | null | undefined {
    if (value === undefined) return undefined;
    if (value === "local" || value === "api-key" || value === "off") return value;
    return null;
}

cli.name(pkg.name).description("Launch the interactive TUI (default), or run one of the commands below.").version(pkg.version);

// Commander exits via process.exit() for --help/--version/parse errors. That
// abrupt exit races pino's async log destination, whose on-exit flush throws
// "sonic boom is not ready yet" when the log file's fd has not opened yet. Make
// Commander throw a CommanderError instead; src/index.ts catches it and drains
// through the normal beforeExit -> shutdown() path, which flushes logs and
// telemetry cleanly. Set before the subcommands so they inherit the behavior.
cli.exitOverride();

// Default command: bare `inflexa` resolves the analysis context for the current directory
// (cwd's anchor → its analyses) and opens/pick/starts a chat, per the data model's central
// "cd to the data, run inflexa, chat" flow. `--analysis`/`--project` override cwd resolution.
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
        const { listSessions } = await import("../modules/intelligence/sessions.ts");
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
    .description("Print what `inflexa` resolves to right now (loud context)")
    .option("--analysis <id|name>", "Resolve a specific analysis")
    .option("--project <name>", "Scope to a project")
    .action(async (options: { analysis?: string; project?: string }) => {
        const { runStatus } = await import("../modules/analysis/status.ts");
        runStatus({ analysis: options.analysis, project: options.project });
    });

// The deliberate harness entry point: stages files and boots the embedded
// runtime, which no passive flow may do (no-litter policy).
cli.command("profile")
    .description("Stage the analysis's inputs and run a data profile in the harness sandbox")
    .option("--analysis <id|name>", "Operate on a specific analysis")
    .option("--status", "Show the profile run state instead of starting a run")
    .action(async (options: { analysis?: string; status?: boolean }) => {
        const { runProfile, runProfileStatus } = await import("../modules/harness/profile.ts");
        const flags = { analysis: options.analysis };
        if (options.status) await runProfileStatus(flags);
        else await runProfile(flags);
    });

// The other deliberate harness entry point: launches a full `executeAnalysis` run
// from a validated plan file (boots the embedded runtime — no passive flow may).
cli.command("run [analysis]")
    .description("Launch an analysis run from a validated plan file in the harness sandbox")
    .option("--plan <file>", "Path to the JSON analysis plan to execute")
    .option("--status", "Show this analysis's run history instead of launching a run")
    .action(async (analysis: string | undefined, options: { plan?: string; status?: boolean }) => {
        const { runAnalysis, runAnalysisStatus } = await import("../modules/harness/run.ts");
        const flags = { analysis };
        if (options.status) await runAnalysisStatus(flags);
        else await runAnalysis(flags, options.plan);
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

const prov = cli.command("prov").description("Provenance — the recorded history of an analysis's inputs and actions");

prov.command("export <analysis>")
    .description("Export an analysis's provenance document as PROV (writes into its .inflexa output folder by default)")
    .option("--format <format>", "json (PROV-JSON) or provn (PROV-N)", "json")
    .option("--output <file>", "Write to this file instead of the analysis output folder")
    .action(async (analysisRef: string, options: { format?: string; output?: string }) => {
        const { runExportProvenance } = await import("../modules/prov/export.ts");
        await runExportProvenance(analysisRef, { format: options.format, output: options.output });
    });

prov.command("verify <analysis>")
    .description("Verify the integrity of an analysis's provenance chain and signature")
    .action(async (analysisRef: string) => {
        const { runVerifyProvenance } = await import("../modules/prov/verify.ts");
        await runVerifyProvenance(analysisRef);
    });

prov.command("verify-file <path>")
    .description("Verify an exported provenance file against its .sig.json sidecar (no database needed)")
    .action(async (path: string) => {
        const { runVerifyFile } = await import("../modules/prov/verify.ts");
        await runVerifyFile(path);
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

cli.command("up")
    .description("Start the inflexa infrastructure containers (proxy + Postgres)")
    .action(async () => {
        const { up } = await import("../modules/infra/lifecycle.ts");
        await up();
    });

cli.command("down")
    .description("Stop the inflexa infrastructure containers")
    .option("--delete-data", "Delete Postgres data and proxy credentials (requires confirmation)")
    .action(async (options: { deleteData?: boolean }) => {
        const { down } = await import("../modules/infra/lifecycle.ts");
        await down({ deleteData: options.deleteData ?? false });
    });

cli.command("setup")
    .description("Install, authenticate, and start CLIProxyAPI and Postgres (Docker or Podman); optionally configure embeddings")
    .option("--provider <name>", "Authenticate a provider non-interactively: gemini|openai|claude|qwen|iflow")
    .option("--no-auth", "Skip the provider authentication step")
    .option("--no-start", "Set up only; don't start the proxy or Postgres containers")
    .option("--no-postgres", "Skip the Postgres provisioning step")
    .option("--force", "Re-pull images even if they are already cached")
    .option("--embeddings <mode>", "Configure embeddings non-interactively: local|api-key|off")
    .action(async (options: { provider?: string; auth: boolean; start: boolean; postgres: boolean; force?: boolean; embeddings?: string }) => {
        const { setup } = await import("../modules/infra/setup.ts");
        const embeddings = parseEmbeddingMode(options.embeddings);
        if (embeddings === null) {
            console.error("\n  `--embeddings` must be one of: local, api-key, off.\n");
            process.exitCode = 1;
            return;
        }
        await setup({
            provider: options.provider,
            auth: options.auth,
            start: options.start,
            force: options.force ?? false,
            postgres: options.postgres,
            embeddings,
        });
    });

// The sandbox image: pull a variant (python | python-r) and inspect it. The
// pulled image bakes the R/Python/conda/node packages at `/mnt/libs/current`, so
// sandboxes launch on it with no local store and no `/mnt/libs` bind mount.
// Nested subcommands (à la `project`), each lazy-importing the handler.
const sandbox = cli.command("sandbox").description("Manage the sandbox image (R/Python/conda/node packages baked in)");

sandbox
    .command("pull [variant]")
    .description("Pull a sandbox image (python | python-r) from GitHub Packages and configure sandboxes to use it")
    .option("--yes", "Skip the download confirmation")
    .action(async (variant: string | undefined, options: { yes?: boolean }) => {
        const { sandboxPull, parseVariant } = await import("../modules/libs/pull.ts");
        if (variant !== undefined && parseVariant(variant) === null) {
            console.error(`\n  Unknown variant "${variant}". Choose one of: python, python-r.\n`);
            process.exitCode = 1;
            return;
        }
        const result = await sandboxPull({ variant: parseVariant(variant) ?? undefined, yes: options.yes });
        result.match(
            (outcome) => {
                if (outcome.type === "up_to_date") console.log(`Sandbox image up to date (${outcome.image}).`);
                else if (outcome.type === "pulled") console.log(`Sandbox image ready: ${outcome.image}.`);
                else if (outcome.type === "declined") console.log("Cancelled — nothing pulled.");
            },
            (error) => {
                console.error(`\n  Sandbox image pull failed: ${error.message}\n`);
                process.exitCode = 1;
            },
        );
    });

sandbox
    .command("status")
    .description("Show the configured sandbox image variant, its GHCR reference, and whether it is present locally")
    .action(async () => {
        const { sandboxStatus } = await import("../modules/libs/pull.ts");
        await sandboxStatus();
    });

cli.addHelpText("after", renderEnvHelp);
