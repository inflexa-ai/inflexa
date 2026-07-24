import { Command } from "commander";

import pkg from "../../package.json";
import { devCommandsEnabled, env, envDoc, modelConnectionEnvDoc, type EnvDocEntry } from "../lib/env.ts";
import { registerAction } from "./agent_policy.ts";

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
    // The direct-connection secret vars are not `env`-field-backed (resolveModelApiKey reads them on
    // demand), so they live in their own doc list; render them among the other var rows.
    for (const doc of modelConnectionEnvDoc) {
        varRows.push([doc.name, doc.description]);
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

/**
 * Builds a fresh commander root — name/description/version, `exitOverride`, and
 * every command with its lazy-imported action — and returns it. A factory rather
 * than a module singleton so the whole tree can be constructed more than once: a
 * caller can build a throwaway instance to parse argv on the side (e.g. a dry
 * pass that classifies how arguments resolve) without disturbing the shared `cli`
 * root the entry point drives. Dev-channel commands are gated at build time by
 * `devCommandsEnabled()`, so each instance reflects the channel in force when it
 * was built.
 */
export function buildProgram(): Command {
    const cli = new Command();

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
    //
    // TUI-launcher family (root, `config`, `new`, `resume`, dev `chat`): these exist only to open
    // an interactive terminal UI, which cannot function as a captured subprocess (stdin ignored,
    // stdout/stderr piped — no terminal to drive). Each is `blocked`, so `run_inflexa` refuses it
    // before prompting rather than burning the user's approval on an immediate error. For this
    // family the policy is the courtesy layer, not the safety boundary — each launcher's own TTY
    // guard (`requireInteractiveTerminal`, lib/cli.ts) is the structural backstop.
    registerAction(
        cli.option("--analysis <id|name>", "Operate on a specific analysis").option("--project <name>", "Scope to a project"),
        // The root action fires for flag-only invocations too (`--analysis x`), so the reason must
        // not say "bare" — the agent may have passed flags.
        {
            kind: "blocked",
            reason:
                "`inflexa` without a subcommand (with or without flags like --analysis) opens the interactive chat UI, " +
                "which cannot run as a captured subprocess. It is not available to you.",
        },
        async (options: { analysis?: string; project?: string }) => {
            const { launchDefault } = await import("../tui/app.launch.tsx");
            await launchDefault({ analysis: options.analysis, project: options.project });
        },
    );

    registerAction(cli.command("sessions").description("List saved sessions"), { kind: "auto", safeFlags: [] }, async () => {
        const { listSessions } = await import("../modules/analysis/sessions.ts");
        await listSessions();
    });

    registerAction(
        cli.command("config").description("View and change settings"),
        {
            kind: "blocked",
            reason: "`inflexa config` opens the interactive settings UI, which cannot run as a captured subprocess. It is not available to you.",
        },
        async () => {
            const { launchConfig } = await import("../tui/app_config.tsx");
            await launchConfig();
        },
    );

    // Analysis lifecycle: the primary entity. `new`/`resume` open a chat (TUI layer); `ls`/
    // `status`/`open` are read-only text commands (module layer).
    registerAction(
        cli
            .command("new")
            .description("Create an analysis anchored at the current directory and open its chat")
            .argument("[name]", "Analysis name (prompted when omitted)")
            .argument("[paths...]", "Input files or folders to attach to the analysis")
            .option("--project <name>", "Group the analysis under a project"),
        // A TUI launcher that creates the analysis during target resolution (before its first
        // frame), so it must be refused before any state exists — hence blocked, not prompted.
        {
            kind: "blocked",
            reason:
                "`inflexa new` creates an analysis and opens its interactive chat UI, which cannot run as a captured subprocess. " +
                "It is not available to you — ask the user to run it themselves.",
        },
        async (name: string | undefined, paths: string[] | undefined, options: { project?: string }) => {
            const { launchNew } = await import("../tui/app.launch.tsx");
            await launchNew({ name, paths: paths ?? [], project: options.project });
        },
    );

    // Read-only analysis lister: cached path used deliberately, no reconciliation side effects (ls.ts).
    registerAction(
        cli.command("ls").description("List recent analyses").option("--project <name>", "Only analyses in this project"),
        { kind: "auto", safeFlags: ["project"] },
        async (options: { project?: string }) => {
            const { runLs } = await import("../modules/analysis/ls.ts");
            runLs({ project: options.project });
        },
    );

    registerAction(
        cli.command("resume").description("Reopen an analysis's chat by id or name").argument("<idOrName>", "Analysis to reopen, by id or name"),
        {
            kind: "blocked",
            reason:
                "`inflexa resume` opens an analysis's interactive chat UI, which cannot run as a captured subprocess. " +
                "It is not available to you — ask the user to run it themselves.",
        },
        async (idOrName: string) => {
            const { launchResume } = await import("../tui/app.launch.tsx");
            await launchResume(idOrName);
        },
    );

    // Stays `approval` (not `auto`): `open` launches the OS file browser — an external effect, not a read.
    registerAction(
        cli
            .command("open")
            .description("Open an analysis's workspace (inputs, run artifacts, reports, provenance) in the file browser")
            .argument("<idOrName>", "Analysis whose workspace to open, by id or name"),
        { kind: "approval" },
        async (idOrName: string) => {
            const { runOpen } = await import("../modules/analysis/open.ts");
            runOpen(idOrName);
        },
    );

    // Stays `approval` (not `auto`): `resolveContext` resolves anchors with the default `touch: true`,
    // which writes a `last_seen` heartbeat and can self-heal a cached path (anchor.ts `resolveAnchor`) —
    // an agent auto-running `status` would make that heartbeat measure agent I/O, not folder liveness.
    registerAction(
        cli
            .command("status")
            .description("Print what `inflexa` resolves to right now (loud context)")
            .option("--analysis <id|name>", "Resolve a specific analysis")
            .option("--project <name>", "Scope to a project"),
        { kind: "approval" },
        async (options: { analysis?: string; project?: string }) => {
            const { runStatus } = await import("../modules/analysis/status.ts");
            runStatus({ analysis: options.analysis, project: options.project });
        },
    );

    const inputs = cli.command("inputs").description("Manage an analysis's input files (add, remove, list)");

    // Read-only listing of the current registered inputs. `--analysis` only selects WHICH analysis to
    // list, so it leaves the command read-only and is safe-listed.
    registerAction(
        inputs.command("ls").description("List the analysis's current inputs").option("--analysis <id|name>", "Operate on a specific analysis"),
        { kind: "auto", safeFlags: ["analysis"] },
        async (options: { analysis?: string }) => {
            const { runInputsLs } = await import("../modules/analysis/inputs_command.ts");
            runInputsLs({ analysis: options.analysis });
        },
    );

    // `blocked` for the agent, not `approval`: adding inputs mid-chat must run IN the chat's own process
    // (the manage_inputs tool), because it emits provenance under the analysis lock the chat already
    // holds — a run_inflexa subprocess would be refused by that lock. This subcommand is the terminal
    // (human) surface; the lock keeps a standalone add from writing provenance concurrently with a chat.
    registerAction(
        inputs
            .command("add")
            .description("Add files or folders as inputs to the analysis")
            .argument("<paths...>", "Files or folders to add as inputs")
            .option("--analysis <id|name>", "Operate on a specific analysis"),
        {
            kind: "blocked",
            reason: "`inflexa inputs add` is the terminal surface for a human. During a chat, add inputs with the `manage_inputs` tool instead — running this as a subprocess would be refused by the analysis lock the chat holds.",
        },
        async (paths: string[], options: { analysis?: string }) => {
            const { runInputsAdd } = await import("../modules/analysis/inputs_command.ts");
            runInputsAdd({ analysis: options.analysis }, paths);
        },
    );

    registerAction(
        inputs
            .command("remove")
            .description("Remove inputs from the analysis")
            .argument("<paths...>", "Input paths to remove")
            .option("--analysis <id|name>", "Operate on a specific analysis"),
        {
            kind: "blocked",
            reason: "`inflexa inputs remove` is the terminal surface for a human. During a chat, remove inputs with the `manage_inputs` tool instead — running this as a subprocess would be refused by the analysis lock the chat holds.",
        },
        async (paths: string[], options: { analysis?: string }) => {
            const { runInputsRemove } = await import("../modules/analysis/inputs_command.ts");
            runInputsRemove({ analysis: options.analysis }, paths);
        },
    );

    // Dev/E2E command surface — `profile`, `run`, and `chat` boot the embedded harness runtime and
    // exist to exercise the loop headlessly; the product conversation surface is the TUI chat. They
    // register ONLY in the dev channel, so a release binary's commands are the product alone: the gate
    // is at registration — an absent command is not in --help and invoking it fails non-zero as an
    // unrecognized argument — never a runtime refusal inside a registered command. `INFLEXA_DEV=1`
    // re-enables them on a shipped binary. See the dev-commands spec and env.ts's `devCommandsEnabled`.
    if (devCommandsEnabled()) {
        // The deliberate harness entry point: stages files and boots the embedded
        // runtime, which no passive flow may do (no-litter policy).
        registerAction(
            cli
                .command("profile")
                .description("Stage the analysis's inputs and run a data profile in the harness sandbox")
                .option("--analysis <id|name>", "Operate on a specific analysis")
                .option("--status", "Show the profile run state instead of starting a run"),
            { kind: "approval" },
            async (options: { analysis?: string; status?: boolean }) => {
                const { runProfile, runProfileStatus } = await import("../modules/harness/profile.ts");
                const flags = { analysis: options.analysis };
                if (options.status) await runProfileStatus(flags);
                else await runProfile(flags);
            },
        );

        // The other deliberate harness entry point: launches a full `executeAnalysis` run
        // from a validated plan file (boots the embedded runtime — no passive flow may).
        registerAction(
            cli
                .command("run")
                .description("Launch an analysis run from a validated plan file in the harness sandbox")
                .argument("[analysis]", "Analysis to operate on, by id or name (default: resolved from the current directory)")
                .option("--plan <file>", "Path to the JSON analysis plan to execute")
                .option("--status", "Show this analysis's run history instead of launching a run"),
            { kind: "approval" },
            async (analysis: string | undefined, options: { plan?: string; status?: boolean }) => {
                const { runAnalysis, runAnalysisStatus } = await import("../modules/harness/run.ts");
                const flags = { analysis };
                if (options.status) await runAnalysisStatus(flags);
                else await runAnalysis(flags, options.plan);
            },
        );

        // The conversational harness entry point: boots the embedded runtime and drives
        // the conversation agent in a stdout REPL (a dev-channel surface — see chat.ts's
        // TODO(extend); no passive flow may boot the runtime). A TUI-launcher-family member
        // (blocked): an interactive prompt loop cannot run as a captured subprocess.
        registerAction(
            cli
                .command("chat")
                .description("Chat with the analysis agent (plan, execute, and inspect runs conversationally)")
                .argument("[analysis]", "Analysis to operate on, by id or name (default: resolved from the current directory)")
                .option("--thread <id>", "Resume an existing conversation thread"),
            {
                kind: "blocked",
                reason: "`inflexa chat` opens an interactive prompt loop, which cannot run as a captured subprocess. It is not available to you.",
            },
            async (analysis: string | undefined, options: { thread?: string }) => {
                const { runChat } = await import("../modules/harness/chat.ts");
                await runChat({ analysis }, options.thread);
            },
        );
    }

    const analysisCmd = cli.command("analysis").description("Manage analyses (grouping)");

    registerAction(
        analysisCmd
            .command("set-project")
            .description("Attach, move, or clear an analysis's project grouping (omit project to clear)")
            .argument("<analysis>", "Analysis to move, by id or name")
            .argument("[project]", "Target project, by id or name (omit to clear the grouping)"),
        { kind: "approval" },
        async (analysisRef: string, projectRef: string | undefined) => {
            const { runSetProject } = await import("../modules/analysis/set_project.ts");
            runSetProject(analysisRef, projectRef ?? null);
        },
    );

    // Real git-style nested subcommands — the reason for moving off cac, which could
    // not match a two-word command like `project new` (it compares only the first
    // positional token to a command name).
    const project = cli.command("project").description("Manage projects (optional grouping of analyses)");

    registerAction(
        project
            .command("new")
            .description("Create a project")
            .argument("<name>", "Name for the project")
            .option("--description <text>", "A short description")
            .option("--tags <tags>", "Comma-separated tags"),
        { kind: "approval" },
        async (name: string, options: { description?: string; tags?: string }) => {
            const { projectNew } = await import("../modules/project/project.ts");
            projectNew(name, { description: options.description, tags: options.tags });
        },
    );

    // Read-only: `listProjects` + per-project count queries (project.ts).
    registerAction(project.command("ls").description("List projects"), { kind: "auto", safeFlags: [] }, async () => {
        const { projectLs } = await import("../modules/project/project.ts");
        projectLs();
    });

    const prov = cli.command("prov").description("Provenance — the recorded history of an analysis's inputs and actions");

    // Stays `approval` (not `auto`): `export` writes the PROV document into the workspace by default.
    registerAction(
        prov
            .command("export")
            .description("Export an analysis's provenance document as PROV (writes into its workspace folder by default)")
            .argument("<analysis>", "Analysis whose provenance to export, by id or name")
            .option("--format <format>", "json (PROV-JSON) or provn (PROV-N)", "json")
            .option("--output <file>", "Write to this file instead of the analysis output folder"),
        { kind: "approval" },
        async (analysisRef: string, options: { format?: string; output?: string }) => {
            const { runExportProvenance } = await import("../modules/prov/export.ts");
            await runExportProvenance(analysisRef, { format: options.format, output: options.output });
        },
    );

    // Read-only: graph walk + print, no write imports (lineage.ts). All three options are
    // output-shaping (walk direction, hop bound, render format) — read-only over the whole graph.
    registerAction(
        prov
            .command("lineage")
            .description(
                "Trace lineage through the recorded provenance graph — <ref> is a file path, content hash, hash prefix, search string over paths/commands/tools, or record QName",
            )
            .argument("<analysis>", "Analysis whose provenance graph to walk, by id or name")
            .argument("<ref>", "What to trace: a file path, content hash, hash prefix, search string, or record QName")
            .option("--forward", "Walk forward: what was derived from this file")
            .option("--depth <n>", "Bound the walk to n generation hops (default: unbounded)")
            .option("--format <format>", "tree (human), json (flat graph), dot (Graphviz), or mermaid (flowchart source)", "tree"),
        { kind: "auto", safeFlags: ["forward", "depth", "format"] },
        async (analysisRef: string, ref: string, options: { forward?: boolean; depth?: string; format?: string }) => {
            const { runProvLineage } = await import("../modules/prov/lineage.ts");
            runProvLineage(analysisRef, ref, options);
        },
    );

    // Read-only: chain/signature check; fs imports are `readFileSync`/`existsSync` only (verify.ts).
    registerAction(
        prov
            .command("verify")
            .description("Verify the integrity of an analysis's provenance chain and signature")
            .argument("<analysis>", "Analysis whose provenance chain to verify, by id or name"),
        { kind: "auto", safeFlags: [] },
        async (analysisRef: string) => {
            const { runVerifyProvenance } = await import("../modules/prov/verify.ts");
            await runVerifyProvenance(analysisRef);
        },
    );

    // Read-only: sidecar read + verify (verify.ts), no database needed.
    registerAction(
        prov
            .command("verify-file")
            .description("Verify an exported provenance file against its .sig.json sidecar (no database needed)")
            .argument("<path>", "Exported provenance file to check against its .sig.json sidecar"),
        { kind: "auto", safeFlags: [] },
        async (path: string) => {
            const { runVerifyFile } = await import("../modules/prov/verify.ts");
            await runVerifyFile(path);
        },
    );

    // Anchor move-backstop: the manual fallback for folder moves that the automatic
    // reconciliation in `resolveAnchor` cannot settle on its own. All addressed by path.
    registerAction(
        cli
            .command("repair")
            .description("Reconcile the anchor marker at <path> (default: current directory)")
            .argument("[path]", "Folder whose anchor marker to reconcile (default: current directory)"),
        { kind: "approval" },
        async (path: string | undefined) => {
            const { runRepair } = await import("../modules/anchor/backstop.ts");
            runRepair(path);
        },
    );

    registerAction(
        cli
            .command("relocate")
            .description("Re-point a moved anchor — one path pair, or all anchors under a prefix with --from/--to")
            .argument("[fromPath]", "Path the anchor is currently tracked at")
            .argument("[toPath]", "Path the folder lives at now")
            .option("--from <prefix>", "Path prefix to rewrite from (bulk mode)")
            .option("--to <prefix>", "Path prefix to rewrite to (bulk mode)"),
        { kind: "approval" },
        async (fromPath: string | undefined, toPath: string | undefined, options: { from?: string; to?: string }) => {
            const { runRelocate } = await import("../modules/anchor/backstop.ts");
            await runRelocate({ fromPath, toPath, from: options.from, to: options.to });
        },
    );

    registerAction(cli.command("prune").description("Drop anchors whose folders are confirmed gone and unrecoverable"), { kind: "approval" }, async () => {
        const { runPrune } = await import("../modules/anchor/backstop.ts");
        await runPrune();
    });

    // Auth verbs grouped under one parent, à la `gh auth login|logout|status`.
    const auth = cli.command("auth").description("Manage authentication (Auth0 device flow)");

    registerAction(auth.command("login").description("Log in via the Auth0 device flow"), { kind: "approval" }, async () => {
        const { login } = await import("../modules/auth/login.ts");
        await login();
    });

    registerAction(auth.command("logout").description("Log out and revoke the stored session"), { kind: "approval" }, async () => {
        const { logout } = await import("../modules/auth/logout.ts");
        await logout();
    });

    // Read-only: local JWT decode without any network round-trip (whoami.ts).
    registerAction(auth.command("whoami").description("Show the logged-in user and session status"), { kind: "auto", safeFlags: [] }, async () => {
        const { whoami } = await import("../modules/auth/whoami.ts");
        whoami();
    });

    // Infrastructure-lifecycle family (`up`, `down`, `setup`): these mutate the very containers this
    // conversation runs on — `down` stops the Postgres the harness session is connected to, so even an
    // informed approval could sever the session mid-turn; `up`/`setup` re-provision the same stack. They
    // run fine headless, so unlike the TUI launchers there is no structural backstop — for this family the
    // declared `blocked` policy IS the gate, and the required-policy helper makes an undeclared lifecycle
    // command unrepresentable.
    registerAction(
        cli.command("up").description("Start the inflexa infrastructure containers (proxy + Postgres)"),
        {
            kind: "blocked",
            reason:
                "`inflexa up` manages the infrastructure containers this conversation depends on. " +
                "It is not available to you — ask the user to run it from their own shell.",
        },
        async () => {
            const { up } = await import("../modules/infra/lifecycle.ts");
            await up();
        },
    );

    registerAction(
        cli
            .command("down")
            .description("Stop the inflexa infrastructure containers")
            .option("--delete-data", "Delete Postgres data and proxy credentials (requires confirmation)"),
        {
            kind: "blocked",
            reason:
                "`inflexa down` stops the infrastructure containers — including the database this conversation is running on — " +
                "and would sever the session. It is not available to you — ask the user to run it from their own shell.",
        },
        async (options: { deleteData?: boolean }) => {
            const { down } = await import("../modules/infra/lifecycle.ts");
            await down({ deleteData: options.deleteData ?? false });
        },
    );

    registerAction(
        cli
            .command("setup")
            .description("Install, authenticate, and start CLIProxyAPI and Postgres (Docker or Podman); optionally configure embeddings")
            .option("--connection <mode>", "How inflexa reaches models: cliproxy|direct (default cliproxy)")
            .option("--provider <name>", "Authenticate a provider non-interactively: gemini|openai|claude|qwen|iflow")
            .option("--no-auth", "Skip the provider authentication step")
            .option("--no-start", "Set up only; don't start the proxy or Postgres containers")
            .option("--no-postgres", "Skip the Postgres provisioning step")
            .option("--force", "Re-pull images even if they are already cached")
            .option("--embeddings <mode>", "Configure embeddings non-interactively: local (built-in bge-small model)|api-key|off")
            .option("--refs <ids>", "Download comma-separated reference dataset ids")
            .option("--yes", "Confirm explicitly selected reference downloads"),
        {
            kind: "blocked",
            reason:
                "`inflexa setup` provisions and authenticates the infrastructure this conversation depends on. " +
                "It is not available to you — ask the user to run it from their own shell.",
        },
        async (options: {
            connection?: string;
            provider?: string;
            auth: boolean;
            start: boolean;
            postgres: boolean;
            force?: boolean;
            embeddings?: string;
            refs?: string;
            yes?: boolean;
        }) => {
            const { setup } = await import("../modules/infra/setup.ts");
            const { parseReferenceIds } = await import("../modules/refs/commands.ts");
            const embeddings = parseEmbeddingMode(options.embeddings);
            if (embeddings === null) {
                console.error("\n  `--embeddings` must be one of: local, api-key, off.\n");
                process.exitCode = 1;
                return;
            }
            await setup({
                connection: options.connection,
                provider: options.provider,
                auth: options.auth,
                start: options.start,
                force: options.force ?? false,
                postgres: options.postgres,
                embeddings,
                refs: parseReferenceIds(options.refs),
                yes: options.yes,
            });
        },
    );

    const refs = cli.command("refs").description("Manage reference data mounted read-only in sandboxes at /mnt/refs");

    // Read-only: lstat walk vs the baked-in catalog constant (store.ts `inspectReferenceStore`).
    // Both options are output-shaping (print upstream URLs; JSON vs prose).
    registerAction(
        refs
            .command("list")
            .description("List catalog options, links, sizes, and local state")
            .option("--urls", "Also print the exact upstream download URL of every file")
            .option("--json", "Emit a machine-readable JSON document instead of prose (artifact URLs always included; --urls has no effect)"),
        { kind: "auto", safeFlags: ["urls", "json"] },
        async (options: { urls?: boolean; json?: boolean }) => {
            const { runRefsList } = await import("../modules/refs/commands.ts");
            await runRefsList({ urls: options.urls ?? false, json: options.json ?? false });
        },
    );

    // Stays `approval` (not `auto`): `download` fetches from upstream publishers and writes to disk.
    registerAction(
        refs
            .command("download")
            .description("Download selected catalog datasets from their upstream publishers and verify them")
            .argument("[ids...]", "Catalog dataset ids (interactive selection when omitted)")
            .option("--yes", "Skip the download confirmation")
            .option("--force", "Re-fetch even when already installed — repairs damage and refreshes mutable upstreams"),
        { kind: "approval" },
        async (ids: string[], options: { yes?: boolean; force?: boolean }) => {
            const { runRefsDownload } = await import("../modules/refs/commands.ts");
            await runRefsDownload(ids, options);
        },
    );

    // Read-only: hashes files against receipts without mutating disk (store.ts `verifyReferenceDatasets`).
    registerAction(
        refs
            .command("verify")
            .description("Verify active managed datasets without changing them")
            .argument("[ids...]", "Catalog dataset ids (all installed datasets when omitted)")
            .option("--json", "Emit a machine-readable JSON document instead of prose"),
        { kind: "auto", safeFlags: ["json"] },
        async (ids: string[], options: { json?: boolean }) => {
            const { runRefsVerify } = await import("../modules/refs/commands.ts");
            await runRefsVerify(ids, { json: options.json ?? false });
        },
    );

    // Read-only: prints the store path (commands.ts).
    registerAction(refs.command("path").description("Print the public host reference-store path"), { kind: "auto", safeFlags: [] }, async () => {
        const { runRefsPath } = await import("../modules/refs/commands.ts");
        runRefsPath();
    });

    // The sandbox image: pull a variant (python | python-r) and inspect it. The
    // pulled image bakes the R/Python/conda/node packages at `/mnt/libs/current`, so
    // sandboxes launch on it with no local store and no `/mnt/libs` bind mount.
    // Nested subcommands (à la `project`), each lazy-importing the handler.
    const sandbox = cli.command("sandbox").description("Manage the sandbox image (R/Python/conda/node packages baked in)");

    // Stays `approval` (not `auto`): `pull` downloads an image and writes the sandbox config.
    registerAction(
        sandbox
            .command("pull")
            .description("Pull a sandbox image (python | python-r) from GitHub Packages and configure sandboxes to use it")
            .argument("[variant]", "Image variant: python or python-r (prompted when omitted)")
            .option("--yes", "Skip the download confirmation"),
        { kind: "approval" },
        async (variant: string | undefined, options: { yes?: boolean }) => {
            const { sandboxPull } = await import("../modules/libs/pull.ts");
            const { parseVariant } = await import("../modules/libs/images.ts");
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
        },
    );

    // Read-only diagnostic: must not write config (pull.ts); runtime `image inspect` is a query subprocess.
    registerAction(
        sandbox.command("status").description("Show the configured sandbox image variant, its GHCR reference, and whether it is present locally"),
        { kind: "auto", safeFlags: [] },
        async () => {
            const { sandboxStatus } = await import("../modules/libs/pull.ts");
            await sandboxStatus();
        },
    );

    cli.addHelpText("after", renderEnvHelp);

    return cli;
}

/** The root command. `src/index.ts` wires telemetry/logging, then calls `cli.parseAsync()`. */
export const cli = buildProgram();
