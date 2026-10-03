import { Command, Option } from "commander";

import pkg from "../../package.json";
import { devCommandsEnabled, embeddingEnvDoc, env, envDoc, modelConnectionEnvDoc, updateEnvDoc, type EnvDocEntry } from "../lib/env.ts";
// Type-only, so the registry keeps its lazy-import discipline: nothing of the setup module loads until
// the action runs. It is the shape of `setup`'s answer flags — see the batch options declared below.
import type { SetupAnswerFlags } from "../modules/infra/setup_answers.ts";
import type { AnalysisView } from "../api/analyses.ts";
import { registerAction, terminalUiRegisterOpts } from "./agent_policy.ts";

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
    // The direct-connection and embedding secret vars are not `env`-field-backed (their resolvers read them
    // on demand), so they live in their own doc lists; render them among the other var rows.
    for (const doc of [...modelConnectionEnvDoc, ...embeddingEnvDoc, ...updateEnvDoc]) {
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
    // family the policy is the courtesy layer, not the safety boundary — the TTY guard
    // (`requireInteractiveTerminal`, lib/cli.ts) is the structural backstop. `terminalUiRegisterOpts`
    // runs it before the server check, thus a refused launch starts no server.
    registerAction(
        cli.option("--analysis <id|name>", "Operate on a specific analysis").option("--project <name>", "Scope to a project"),
        "instance",
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
        terminalUiRegisterOpts("inflexa"),
    );

    registerAction(
        cli.command("config").description("View and change settings"),
        "instance",
        {
            kind: "blocked",
            reason: "`inflexa config` opens the interactive settings UI, which cannot run as a captured subprocess. It is not available to you.",
        },
        async () => {
            const { launchConfig } = await import("../tui/app_config.tsx");
            await launchConfig();
        },
        terminalUiRegisterOpts("inflexa config"),
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
        "instance",
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
        terminalUiRegisterOpts("inflexa new"),
    );

    // Read-only analysis lister: the cached anchor path, no reconciliation side effects (`GET /api/v1/analyses`).
    registerAction(
        cli.command("ls").description("List recent analyses").option("--project <name>", "Only analyses in this project"),
        "instance",
        { kind: "auto", safeFlags: ["project"] },
        async (options: { project?: string }) => {
            const { analysisLs } = await import("../client/commands/analyses.ts");
            await analysisLs({ project: options.project });
        },
    );

    registerAction(
        cli.command("resume").description("Reopen an analysis's chat by id or name").argument("<idOrName>", "Analysis to reopen, by id or name"),
        "instance",
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
        terminalUiRegisterOpts("inflexa resume"),
    );

    // Stays `approval` (not `auto`): `open` launches the OS file browser — an external effect, not a read.
    registerAction(
        cli
            .command("open")
            .description("Open an analysis's workspace (inputs, run artifacts, reports, provenance) in the file browser")
            .argument("<idOrName>", "Analysis whose workspace to open, by id or name"),
        "instance",
        { kind: "approval" },
        async (idOrName: string) => {
            const { analysisOpen } = await import("../client/commands/analyses.ts");
            await analysisOpen(idOrName);
        },
    );

    // Stays `approval` (not `auto`): the resolve route resolves anchors with the default `touch: true`,
    // which writes a `last_seen` heartbeat and can self-heal a cached path (anchor.ts `resolveAnchor`) —
    // an agent auto-running `status` would make that heartbeat measure agent I/O, not folder liveness.
    registerAction(
        cli
            .command("status")
            .description("Print what `inflexa` resolves to right now (loud context)")
            .option("--analysis <id|name>", "Resolve a specific analysis")
            .option("--project <name>", "Scope to a project"),
        "instance",
        { kind: "approval" },
        async (options: { analysis?: string; project?: string }) => {
            const { analysisStatus } = await import("../client/commands/analyses.ts");
            await analysisStatus({ analysis: options.analysis, project: options.project });
        },
    );

    // Read-only local report over the LLM usage ledger — no harness runtime, no Postgres, no network:
    // the ledger is CLI-owned SQLite precisely so a report about tokens already spent works with the
    // durable engine cold. `--analysis` only selects WHICH analysis to report on, so every value it
    // can carry leaves the command read-only, and it is safe-listed on that basis (design Decision 8).
    const usage = cli.command("usage").description("Report an analysis's recorded LLM token usage, by served model and by agent");

    // The analysis of a usage command resolves through the server (`POST /api/v1/analyses/resolve`).
    // `touch: false` — a report is not a sighting, and these commands are `auto`, thus an agent can run
    // them unprompted.
    async function usageAnalysis(ref: string | undefined): Promise<AnalysisView> {
        const { resolveSingleAnalysisOrFail } = await import("../client/commands/analyses.ts");
        return resolveSingleAnalysisOrFail({ analysis: ref }, "No analysis here. Run `inflexa` to start or open one, then ask what it has consumed.", {
            touch: false,
        });
    }

    registerAction(
        usage.option("--analysis <id|name>", "Operate on a specific analysis"),
        "instance",
        { kind: "auto", safeFlags: ["analysis"] },
        async (options: { analysis?: string }) => {
            const { usageReport } = await import("../client/commands/usage.ts");
            await usageReport(await usageAnalysis(options.analysis));
        },
    );

    // The where-it-ran grains: subcommands, not flags on the report above. Each is read-only over the
    // same local ledger — no runtime, no Postgres, no network — and each is classified on its own, so
    // a grain added later cannot widen a sibling's allowlist. `--analysis` and `--run` only SELECT what
    // to report on, so every value either can carry leaves the command read-only.
    registerAction(
        usage
            .command("sessions")
            .description("Report what each of the analysis's conversations consumed")
            .option("--analysis <id|name>", "Operate on a specific analysis"),
        "instance",
        { kind: "auto", safeFlags: ["analysis"] },
        async (options: { analysis?: string }) => {
            const { usageSessions } = await import("../client/commands/usage.ts");
            await usageSessions(await usageAnalysis(options.analysis));
        },
    );

    registerAction(
        usage.command("runs").description("Report what each of the analysis's runs consumed").option("--analysis <id|name>", "Operate on a specific analysis"),
        "instance",
        { kind: "auto", safeFlags: ["analysis"] },
        async (options: { analysis?: string }) => {
            const { usageRuns } = await import("../client/commands/usage.ts");
            await usageRuns(await usageAnalysis(options.analysis));
        },
    );

    registerAction(
        usage
            .command("steps")
            .description("Report what each step of one run consumed")
            .requiredOption("--run <id>", "The run to report on, by id or by a trailing abbreviation of one")
            .option("--analysis <id|name>", "Operate on a specific analysis"),
        "instance",
        { kind: "auto", safeFlags: ["analysis", "run"] },
        async (options: { run: string; analysis?: string }) => {
            const { usageSteps } = await import("../client/commands/usage.ts");
            await usageSteps(await usageAnalysis(options.analysis), options.run);
        },
    );

    const inputs = cli.command("inputs").description("Manage an analysis's input files (add, remove, list)");

    // Read-only listing of the current registered inputs. `--analysis` only selects WHICH analysis to
    // list, so it leaves the command read-only and is safe-listed.
    registerAction(
        inputs.command("ls").description("List the analysis's current inputs").option("--analysis <id|name>", "Operate on a specific analysis"),
        "instance",
        { kind: "auto", safeFlags: ["analysis"] },
        async (options: { analysis?: string }) => {
            const { inputsLs } = await import("../client/commands/analyses.ts");
            await inputsLs({ analysis: options.analysis });
        },
    );

    // `blocked` for the agent, not `approval`: during a chat the agent changes the inputs with its
    // `manage_inputs` tool, which records them in the provenance of the turn. This subcommand is the
    // terminal (human) surface, a client of the same server.
    registerAction(
        inputs
            .command("add")
            .description("Add files or folders as inputs to the analysis")
            .argument("<paths...>", "Files or folders to add as inputs")
            .option("--analysis <id|name>", "Operate on a specific analysis"),
        "instance",
        {
            kind: "blocked",
            reason: "`inflexa inputs add` is the terminal surface for a human. During a chat, add inputs with the `manage_inputs` tool instead.",
        },
        async (paths: string[], options: { analysis?: string }) => {
            const { inputsAdd } = await import("../client/commands/analyses.ts");
            await inputsAdd({ analysis: options.analysis }, paths);
        },
    );

    registerAction(
        inputs
            .command("remove")
            .description("Remove inputs from the analysis")
            .argument("<paths...>", "Input paths to remove")
            .option("--analysis <id|name>", "Operate on a specific analysis"),
        "instance",
        {
            kind: "blocked",
            reason: "`inflexa inputs remove` is the terminal surface for a human. During a chat, remove inputs with the `manage_inputs` tool instead.",
        },
        async (paths: string[], options: { analysis?: string }) => {
            const { inputsRemove } = await import("../client/commands/analyses.ts");
            await inputsRemove({ analysis: options.analysis }, paths);
        },
    );

    // Dev/E2E command surface — `profile`, `run`, and `chat` boot the embedded harness runtime and
    // exist to exercise the loop headlessly; the product conversation surface is the TUI chat. They
    // register ONLY in the dev channel, so a release binary's commands are the product alone: the gate
    // is at registration — an absent command is not in --help and invoking it fails non-zero as an
    // unrecognized argument — never a runtime refusal inside a registered command. `INFLEXA_DEV=1`
    // re-enables them on a shipped binary. See the dev-commands spec and env.ts's `devCommandsEnabled`.
    if (devCommandsEnabled()) {
        // The analysis of a dev client command resolves through the server (`POST /api/v1/analyses/resolve`).
        // `touch: false` — a dev command is not a sighting of the folder.
        async function devAnalysis(ref: string | undefined, emptyHint: string): Promise<{ id: string; name: string }> {
            const { resolveSingleAnalysisOrFail } = await import("../client/commands/analyses.ts");
            return resolveSingleAnalysisOrFail({ analysis: ref }, emptyHint, { touch: false });
        }

        // The deliberate harness entry point: stages files and boots the embedded
        // runtime, which no passive flow may do (no-litter policy).
        registerAction(
            cli
                .command("profile")
                .description("Stage the analysis's inputs and run a data profile in the harness sandbox")
                .option("--analysis <id|name>", "Operate on a specific analysis")
                .option("--status", "Show the profile run state instead of starting a run"),
            "instance",
            { kind: "approval" },
            async (options: { analysis?: string; status?: boolean }) => {
                const { profileRun, profileStatus } = await import("../client/commands/runs.ts");
                const analysis = await devAnalysis(options.analysis, "No analysis here. Run `inflexa` to start one, add inputs, then profile.");
                if (options.status) await profileStatus(analysis);
                else await profileRun(analysis);
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
            { kind: "instance", machineFlags: ["plan"] },
            { kind: "approval" },
            async (analysis: string | undefined, options: { plan?: string; status?: boolean }) => {
                if (options.status) {
                    const { runStatus } = await import("../client/commands/runs.ts");
                    await runStatus(await devAnalysis(analysis, "No analysis here. Run `inflexa` to start one, add inputs, then `inflexa run`."));
                    return;
                }
                const { runAnalysis } = await import("../modules/harness/dev/run.ts");
                await runAnalysis({ analysis }, options.plan);
            },
        );

        // The conversational harness entry point: drives the conversation agent of the local
        // server in a stdout REPL, as a client of `POST {A}/chat` (a dev-channel surface — see
        // chat.ts's TODO(extend)). A TUI-launcher-family member (blocked): an interactive prompt
        // loop cannot run as a captured subprocess.
        registerAction(
            cli
                .command("chat")
                .description("Chat with the analysis agent (plan, execute, and inspect runs conversationally)")
                .argument("[analysis]", "Analysis to operate on, by id or name (default: resolved from the current directory)")
                .option("--thread <id>", "Resume an existing conversation thread"),
            "instance",
            {
                kind: "blocked",
                reason: "`inflexa chat` opens an interactive prompt loop, which cannot run as a captured subprocess. It is not available to you.",
            },
            async (analysis: string | undefined, options: { thread?: string }) => {
                const { runChat } = await import("../modules/harness/dev/chat.ts");
                await runChat({ analysis }, options.thread);
            },
        );
    }

    // The local server: it boots the harness runtime and serves each client over HTTP on 127.0.0.1. Each
    // `instance` command starts it in the background when none answers. The hidden `--run-detached` is the
    // detached child of `--detach`; its spelling is pinned against SERVE_DETACHED_CHILD_FLAG by serve.test.ts.
    registerAction(
        cli
            .command("serve")
            .description("Run the local Inflexa server in the foreground (Ctrl+C stops it), or in the background with --detach")
            .option("--detach", "Start the server in the background, detached from this terminal, and return when it answers")
            .addOption(new Option("--run-detached").hideHelp()),
        "machine",
        {
            kind: "blocked",
            reason:
                "`inflexa serve` starts the local server, which runs until it is stopped, and this conversation itself runs inside that server. " +
                "It is not available to you.",
        },
        async (options: { detach?: boolean; runDetached?: boolean }) => {
            const { runServe, runServeDetached } = await import("../server/serve.ts");
            if (options.runDetached === true) await runServe("detached");
            else if (options.detach === true) await runServeDetached();
            else await runServe("foreground");
        },
    );

    // The commands of the server process itself. Each is `machine`: none starts a server.
    const server = cli.command("server").description("Inspect and stop the local Inflexa server");

    // Read-only: the discovery file, a probe, and the activity read. `--json` only shapes the output.
    registerAction(
        server
            .command("status")
            .description("Show if the local server runs, its pid, port, versions, phase, and active work")
            .option("--json", "Emit a machine-readable JSON document instead of prose"),
        "machine",
        { kind: "auto", safeFlags: ["json"] },
        async (options: { json?: boolean }) => {
            const { serverStatus } = await import("../client/commands/server.ts");
            await serverStatus({ json: options.json ?? false });
        },
    );

    registerAction(
        server
            .command("stop")
            .description("Stop the local server and wait for its exit; a run continues at the next start")
            .option("--drain", "Wait up to 60 s for the running chat turns before the stop aborts them"),
        "machine",
        {
            kind: "blocked",
            reason:
                "`inflexa server stop` stops the local server, and this conversation runs inside that server, thus the stop would end your own turn. " +
                "It is not available to you — ask the user to run it from their own shell.",
        },
        async (options: { drain?: boolean }) => {
            const { serverStop } = await import("../client/commands/server.ts");
            await serverStop({ mode: options.drain === true ? "drain" : "now" });
        },
    );

    registerAction(
        server
            .command("logs")
            .description("Print the path of the server log and its last lines")
            .option("--lines <n>", "How many of the last lines to print", "50")
            .option("--follow", "Keep printing the lines that the server appends (Ctrl+C stops)"),
        "machine",
        { kind: "approval" },
        async (options: { lines: string; follow?: boolean }) => {
            const { serverLogs } = await import("../client/commands/server.ts");
            await serverLogs({ lines: options.lines, follow: options.follow ?? false });
        },
    );

    const analysisCmd = cli.command("analysis").description("Manage analyses (grouping)");

    registerAction(
        analysisCmd
            .command("set-project")
            .description("Attach, move, or clear an analysis's project grouping (omit project to clear)")
            .argument("<analysis>", "Analysis to move, by id or name")
            .argument("[project]", "Target project, by id or name (omit to clear the grouping)"),
        "instance",
        { kind: "approval" },
        async (analysisRef: string, projectRef: string | undefined) => {
            const { analysisSetProject } = await import("../client/commands/analyses.ts");
            await analysisSetProject(analysisRef, projectRef ?? null);
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
        "instance",
        { kind: "approval" },
        async (name: string, options: { description?: string; tags?: string }) => {
            const { projectNew } = await import("../client/commands/projects.ts");
            await projectNew(name, { description: options.description, tags: options.tags });
        },
    );

    // Read-only: `GET /api/v1/projects` (client/commands/projects.ts).
    registerAction(project.command("ls").description("List projects"), "instance", { kind: "auto", safeFlags: [] }, async () => {
        const { projectLs } = await import("../client/commands/projects.ts");
        await projectLs();
    });

    const prov = cli.command("prov").description("Provenance — the recorded history of an analysis's inputs and actions");

    // The analysis of a provenance command resolves through the server (`POST /api/v1/analyses/resolve`). An
    // ambiguous name fails with each candidate: a prov command never picks the newest of same-named analyses.
    async function provAnalysis(ref: string): Promise<AnalysisView> {
        const { requireAnalysisByRef } = await import("../client/commands/analyses.ts");
        return requireAnalysisByRef(ref);
    }

    // Stays `approval` (not `auto`): `export` writes the PROV document into the workspace by default.
    registerAction(
        prov
            .command("export")
            .description("Export an analysis's provenance document as PROV (writes into its workspace folder by default)")
            .argument("<analysis>", "Analysis whose provenance to export, by id or name")
            .option("--format <format>", "json (PROV-JSON) or provn (PROV-N)", "json")
            .option("--output <file>", "Write to this file instead of the analysis output folder"),
        "instance",
        { kind: "approval" },
        async (analysisRef: string, options: { format?: string; output?: string }) => {
            const { provExport } = await import("../client/commands/prov.ts");
            await provExport(await provAnalysis(analysisRef), { format: options.format, output: options.output });
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
        "instance",
        { kind: "auto", safeFlags: ["forward", "depth", "format"] },
        async (analysisRef: string, ref: string, options: { forward?: boolean; depth?: string; format?: string }) => {
            const { provLineage } = await import("../client/commands/prov.ts");
            await provLineage(await provAnalysis(analysisRef), ref, options);
        },
    );

    // Read-only: chain/signature check; fs imports are `readFileSync`/`existsSync` only (verify.ts).
    registerAction(
        prov
            .command("verify")
            .description("Verify the integrity of an analysis's provenance chain and signature")
            .argument("<analysis>", "Analysis whose provenance chain to verify, by id or name"),
        "instance",
        { kind: "auto", safeFlags: [] },
        async (analysisRef: string) => {
            const { provVerify } = await import("../client/commands/prov.ts");
            await provVerify(await provAnalysis(analysisRef));
        },
    );

    // Read-only: attestation read + verify (verify.ts), no database needed.
    registerAction(
        prov
            .command("verify-file")
            .description("Verify an exported provenance file against its .sig.json attestation (no database needed)")
            .argument("<path>", "Exported provenance file to check against its .sig.json attestation"),
        "standalone",
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
        "instance",
        { kind: "approval" },
        async (path: string | undefined) => {
            const { anchorRepair } = await import("../client/commands/anchors.ts");
            await anchorRepair(path);
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
        "instance",
        { kind: "approval" },
        async (fromPath: string | undefined, toPath: string | undefined, options: { from?: string; to?: string }) => {
            const { anchorRelocate } = await import("../client/commands/anchors.ts");
            await anchorRelocate({ fromPath, toPath, from: options.from, to: options.to });
        },
    );

    registerAction(
        cli.command("prune").description("Drop anchors whose folders are confirmed gone and unrecoverable"),
        "instance",
        { kind: "approval" },
        async () => {
            const { anchorPrune } = await import("../client/commands/anchors.ts");
            await anchorPrune();
        },
    );

    // `blocked`, and not for the usual reason. The command replaces the very file the agent is running
    // from: `run_inflexa` spawns it as a child of this binary, and on Windows the swap renames the running
    // executable out of the way. A person upgrades on purpose, at a moment of their choosing; an agent has
    // no reason to change the tool underneath its own session.
    registerAction(
        cli.command("upgrade").description("Install the newest inflexa release, or name the command that does"),
        "machine",
        {
            kind: "blocked",
            reason:
                "`inflexa upgrade` replaces the inflexa binary you are running from. It is a deliberate, person-driven action. " +
                "It is not available to you — tell the user to run it themselves.",
        },
        async () => {
            const { upgrade } = await import("../modules/update/upgrade.ts");
            await upgrade();
        },
    );

    // GEO datasets → the analysis's folder. `download`, not `add`: it fetches a Series host-side and
    // stops, so naming it `add` would promise the one thing it does not do and collide with `inputs add`,
    // which is how files become inputs. It writes files, so it is approval-gated; it records no input
    // rows, emits no provenance, and boots no runtime, so it never contends for the analysis lock.
    // Enrolment stays the user's separate, explicit step (`manage_inputs` in chat, `inputs add` here).
    const geo = cli.command("geo").description("Work with NCBI GEO gene-expression datasets");
    registerAction(
        geo
            .command("download")
            .description("Download a GEO Series into the analysis's folder")
            .argument("<gse>", "GEO Series accession to download (e.g. GSE12345)")
            // No `--project`: a project scopes to a SET of analyses, and this command needs exactly one
            // folder. `resolveContext` answers a project ref with a picker, never a single analysis, so
            // the flag could only ever have failed — `--analysis` is the way to name a target.
            .option("--analysis <id|name>", "Operate on a specific analysis")
            .option("--max-size <size>", "Override the per-Series download ceiling (e.g. 500MB, 64GB)"),
        "instance",
        // A transfer: a Series is gigabytes over NCBI's link, so the agent's tool gives it no deadline and
        // the downloader ends it when the bytes stop. `--max-size` bounds the SIZE, never the time.
        { kind: "approval", transfer: true },
        async (gse: string, options: { analysis?: string; maxSize?: string }) => {
            const { runGeoDownload } = await import("../modules/geo/download.ts");
            const { resolveGeoDownloadFolder } = await import("../client/commands/geo.ts");
            await runGeoDownload(gse, options.maxSize, () => resolveGeoDownloadFolder({ analysis: options.analysis }));
        },
    );

    // Auth verbs grouped under one parent, à la `gh auth login|logout|status`.
    const auth = cli.command("auth").description("Manage authentication (Auth0 device flow)");

    registerAction(auth.command("login").description("Log in via the Auth0 device flow"), "machine", { kind: "approval" }, async () => {
        const { login } = await import("../modules/auth/login.ts");
        await login();
    });

    registerAction(auth.command("logout").description("Log out and revoke the stored session"), "machine", { kind: "approval" }, async () => {
        const { logout } = await import("../modules/auth/logout.ts");
        await logout();
    });

    // Read-only: local JWT decode without any network round-trip (whoami.ts).
    registerAction(
        auth.command("whoami").description("Show the logged-in user and session status"),
        "standalone",
        { kind: "auto", safeFlags: [] },
        async () => {
            const { whoami } = await import("../modules/auth/whoami.ts");
            whoami();
        },
    );

    // Infrastructure-lifecycle family (`up`, `down`, `setup`): these mutate the very containers this
    // conversation runs on — `down` stops the Postgres the harness session is connected to, so even an
    // informed approval could sever the session mid-turn; `up`/`setup` re-provision the same stack. They
    // run fine headless, so unlike the TUI launchers there is no structural backstop — for this family the
    // declared `blocked` policy IS the gate, and the required-policy helper makes an undeclared lifecycle
    // command unrepresentable.
    registerAction(
        cli
            .command("up")
            .description(
                "Start the inflexa infrastructure containers (proxy + Postgres), sign in to the provider when the login is absent or dead, and boot a failed server again",
            ),
        "machine",
        {
            kind: "blocked",
            reason:
                "`inflexa up` manages the infrastructure containers this conversation depends on. " +
                "It is not available to you — ask the user to run it from their own shell.",
        },
        // A module does not import the client side, thus the registry asks the server to boot again after `up`.
        async () => {
            const { up } = await import("../modules/infra/lifecycle.ts");
            if (!(await up())) {
                process.exitCode = 1;
                return;
            }
            const { bootServerAfterUp } = await import("../client/commands/server.ts");
            await bootServerAfterUp();
        },
    );

    registerAction(
        cli
            .command("down")
            .description("Stop the inflexa infrastructure containers")
            .option("--delete-data", "Delete Postgres data and proxy credentials (requires confirmation)"),
        "machine",
        {
            kind: "blocked",
            reason:
                "`inflexa down` stops the infrastructure containers — including the database this conversation is running on — " +
                "and would sever the session. It is not available to you — ask the user to run it from their own shell.",
        },
        // `down` stops the Postgres of a live server, which is the backend of each client, thus it refuses
        // while a server answers.
        async (options: { deleteData?: boolean }) => {
            const { refuseWhileServerAnswers } = await import("../client/server.ts");
            await refuseWhileServerAnswers("inflexa down");
            const { down } = await import("../modules/infra/lifecycle.ts");
            await down({ deleteData: options.deleteData ?? false });
        },
    );

    registerAction(
        cli
            .command("setup")
            .description("Install, authenticate, and start CLIProxyAPI and Postgres (Docker or Podman); optionally configure embeddings")
            .option("--no-auth", "Skip the provider authentication step")
            .option("--no-start", "Set up only; don't start the proxy or Postgres containers")
            .option("--no-postgres", "Skip the Postgres provisioning step")
            .option("--force", "Re-pull images even if they are already cached")
            .option(
                "--no-validate",
                "Skip the network probes that check an answered endpoint, model, and credential source. Local GGUF verification still runs",
            )
            .option("--yes", "Batch mode: never prompt — every unanswered question takes its default or fails. Implied when there is no terminal")
            // The split is by KIND, not by novelty: everything above toggles how this run behaves, while
            // everything below supplies a VALUE for a question the wizard would otherwise ask (plus the
            // file that carries those values). Grouping the answers keeps the flat `--help` list readable
            // (design D12), and each of them also works interactively, where it simply skips its prompt.
            // Set as the command's default option group so a new answer flag joins by position alone;
            // commander's lazily-created `-h, --help` stays under the plain "Options:" heading.
            .optionsGroup("Batch mode:")
            .option("--config <path>", "YAML answers file carrying any of the batch-mode answers; a flag overrides the file's answer for that question")
            .option("--connection <mode>", "How inflexa reaches models: cliproxy|direct (default cliproxy)")
            .option(
                "--provider <name>",
                "With cliproxy: the account kind to sign in — gemini|openai|claude|qwen|iflow (interactive runs only, the sign-in needs a browser). " +
                    "With --connection direct: the vendor slug recorded for the endpoint, e.g. anthropic, openai, deepseek",
            )
            .option("--base-url <url>", "Direct connections only: the endpoint inflexa sends model requests to, `/v1`-terminated")
            .option(
                "--protocol <wire>",
                "Direct connections only: the endpoint's wire protocol — anthropic|openai-compatible (inferred from the provider when omitted)",
            )
            .option(
                "--model <id>",
                "Model id to pin for all model roles; required for a direct connection in a non-interactive run. " +
                    "Under cliproxy it is checked against the account only once the proxy is up, so a rejected id fails setup after the stack is provisioned",
            )
            .option(
                "--auth-env <var>",
                "Direct connections only: name of the environment variable holding the endpoint credential (never the credential itself)",
            )
            .option("--auth-command <cmd>", "Direct connections only: command whose output supplies a refreshing endpoint credential")
            .option("--auth-scheme <scheme>", "How the credential is sent: x-api-key|bearer. Required with --auth-env or --auth-command")
            .option("--auth-format <format>", "How --auth-command's output is read: raw|exec-credential (default raw)")
            .option("--postgres-user <user>", "Postgres role the harness connects as")
            .option("--postgres-password <password>", "Password for that Postgres role (visible in argv — prefer the --config file)")
            .option("--postgres-port <port>", "Host port the Postgres container publishes")
            .option("--postgres-database <db>", "Postgres database the harness uses")
            .option("--postgres-host <host>", "Host the harness reaches Postgres at")
            .option("--resource-share <pct>", "Percentage (1-100) of this machine's CPU and memory sandboxes may use; persisted as the absolute budget")
            .option("--embeddings <mode>", "Configure embeddings non-interactively: local (built-in bge-small model)|api-key|off")
            .option("--embeddings-url <url>", "api-key embeddings only: the embedding endpoint's base URL")
            .option("--embeddings-model <id>", "api-key embeddings only: the embedding model id")
            .option("--embeddings-gguf <path>", "Local embeddings only: path to your own GGUF model file instead of the built-in one")
            .option("--refs <ids>", "Reference data to download: recommended|all|<comma-separated dataset ids>. The value is the download consent")
            .option(
                "--sandbox",
                "Start the three detached transfers (the two sandbox images and the package catalog). The flag is the multi-GB consent; nothing downloads without it",
            )
            .option(
                "--runtime <runtime>",
                "Container runtime to provision on: docker|podman. A hard gate — setup fails rather than falling back when it is not ready",
            ),
        "machine",
        {
            kind: "blocked",
            reason:
                "`inflexa setup` provisions and authenticates the infrastructure this conversation depends on. " +
                "It is not available to you — ask the user to run it from their own shell.",
        },
        // The answer flags arrive as `SetupAnswerFlags` (commander's camelCased spelling of each one) and
        // are handed on untouched: parsing, the `--config` file, merging, and the fail-before-mutate
        // validation all belong to modules/infra/setup_answers.ts, so the registry stays a declaration of
        // the surface rather than a second place where an answer's meaning is decided.
        async (
            options: SetupAnswerFlags & {
                auth: boolean;
                start: boolean;
                postgres: boolean;
                force?: boolean;
                validate: boolean;
                yes?: boolean;
            },
        ) => {
            const { setup } = await import("../modules/infra/setup.ts");
            await setup({
                auth: options.auth,
                start: options.start,
                force: options.force ?? false,
                postgres: options.postgres,
                yes: options.yes,
                validate: options.validate,
                flags: {
                    config: options.config,
                    connection: options.connection,
                    provider: options.provider,
                    baseUrl: options.baseUrl,
                    protocol: options.protocol,
                    model: options.model,
                    authEnv: options.authEnv,
                    authCommand: options.authCommand,
                    authScheme: options.authScheme,
                    authFormat: options.authFormat,
                    postgresUser: options.postgresUser,
                    postgresPassword: options.postgresPassword,
                    postgresPort: options.postgresPort,
                    postgresDatabase: options.postgresDatabase,
                    postgresHost: options.postgresHost,
                    resourceShare: options.resourceShare,
                    embeddings: options.embeddings,
                    embeddingsUrl: options.embeddingsUrl,
                    embeddingsModel: options.embeddingsModel,
                    embeddingsGguf: options.embeddingsGguf,
                    refs: options.refs,
                    sandbox: options.sandbox,
                    runtime: options.runtime,
                },
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
        "standalone",
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
        "machine",
        // A transfer: one catalog artifact reaches 2 GB, and the captured readout prints a line for each
        // file that lands, so the whole of a large one is quiet. The downloader watches the bytes instead.
        { kind: "approval", transfer: true },
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
        "standalone",
        { kind: "auto", safeFlags: ["json"] },
        async (ids: string[], options: { json?: boolean }) => {
            const { runRefsVerify } = await import("../modules/refs/commands.ts");
            await runRefsVerify(ids, { json: options.json ?? false });
        },
    );

    // Read-only: prints the store path (commands.ts).
    registerAction(refs.command("path").description("Print the public host reference-store path"), "standalone", { kind: "auto", safeFlags: [] }, async () => {
        const { runRefsPath } = await import("../modules/refs/commands.ts");
        runRefsPath();
    });

    // The sandbox images: the one runtime image and the derived provisioner
    // image. No variant exists, and no foreground pull exists anywhere — `pull`
    // starts the two detached transfer children and returns at once.
    const sandbox = cli.command("sandbox").description("Manage the sandbox images (the runtime image and the provisioner image)");

    // `approval` (not `auto`): `pull` starts multi-GB downloads. The hidden
    // `--run-transfer <kind>` is the detached child re-invoking itself; the
    // spelling is pinned against `IMAGE_TRANSFER_FLAG` by the transfer tests.
    registerAction(
        sandbox
            .command("pull")
            .description("Start the two detached image transfers (the runtime image and the provisioner image) and return at once")
            .addOption(new Option("--run-transfer <kind>").hideHelp()),
        "machine",
        { kind: "approval" },
        async (options: { runTransfer?: string }) => {
            if (options.runTransfer !== undefined) {
                if (options.runTransfer !== "runtime_image" && options.runTransfer !== "provisioner_image") {
                    process.exitCode = 1;
                    return;
                }
                const { runImageTransfer } = await import("../modules/libs/transfers.ts");
                await runImageTransfer(options.runTransfer);
                return;
            }
            const { sandboxPull } = await import("../modules/libs/pull.ts");
            await sandboxPull();
        },
    );

    // Read-only diagnostic: must not write config (pull.ts); runtime `image inspect` is a query subprocess.
    registerAction(
        sandbox.command("status").description("Show the two images, the live transfer states, and the package-store summary"),
        "machine",
        { kind: "auto", safeFlags: [] },
        async () => {
            const { sandboxStatus } = await import("../modules/libs/pull.ts");
            await sandboxStatus();
        },
    );

    // `blocked`: an agent must not delete multi-GB assets of the user.
    registerAction(
        sandbox.command("remove").description("Remove the runtime image and the provisioner image from the engine; the store and the farms stay"),
        "machine",
        { kind: "blocked", reason: "Removing the sandbox images deletes multi-GB assets of the user; only the user runs it." },
        async () => {
            const { sandboxRemove } = await import("../modules/libs/pull.ts");
            await sandboxRemove();
        },
    );

    // The package store: the pool, the farms, and the catalog. The policies
    // come from the package-store-management spec: `add` and `download` are
    // `approval`, `ls` is `auto`, `link` is `auto` with `analysis` safe, and
    // `reclaim` is `approval`. No `store use` and no `store verify` exist.
    const store = cli.command("store").description("Manage the host package store (the pool, the per-analysis farms, and the catalog)");

    // The hidden flags: `--queued` is the agent route (enqueue, no flush), and
    // `--run-flush` is the detached flush child. Their spellings are pinned by
    // the store tests against STORE_QUEUED_FLAG / STORE_FLUSH_FLAG.
    registerAction(
        store
            .command("add")
            .description("Acquire one package into the package pool (PyPI, CRAN, or Bioconductor), behind an approval")
            .argument("[package]", "The one package to acquire")
            .option("--version <version>", "One exact version (the newest otherwise)")
            .option("--lang <ecosystem>", "The ecosystem: python or r (both searched otherwise)")
            .option("--analysis <ref>", "Extend the farm of this analysis after the commit (id or name)")
            .addOption(new Option("--queued").hideHelp())
            .addOption(new Option("--run-flush").hideHelp()),
        "machine",
        { kind: "approval" },
        async (pkg: string | undefined, options: { version?: string; lang?: string; analysis?: string; queued?: boolean; runFlush?: boolean }) => {
            if (options.runFlush === true) {
                const { flushAndPrint } = await import("../modules/libs/store.ts");
                await flushAndPrint(env.packageStoreDir);
                return;
            }
            if (options.lang !== undefined && options.lang !== "python" && options.lang !== "r") {
                console.error(`\n  Unknown ecosystem "${options.lang}". Choose python or r.\n`);
                process.exitCode = 1;
                return;
            }
            const { runStoreAdd } = await import("../modules/libs/store.ts");
            await runStoreAdd(pkg, {
                version: options.version ?? null,
                lang: options.lang ?? null,
                analysis: options.analysis ?? null,
                queued: options.queued === true,
            });
        },
    );

    // `auto` with `analysis` and `lang` safe: a link writes symbolic links
    // into the farm of the named analysis and nothing else, and the pool
    // decides what can link. `--lang` only narrows which track answers a
    // name, thus no value of it changes the effect class. The agent passes
    // both flags on its natural call, so an unsafe listing here would make
    // the auto policy dead in practice (decision 19: a link takes no ask).
    registerAction(
        store
            .command("link")
            .description("Link packages the pool already holds into the farm of one analysis (no download, no container)")
            .argument("<packages...>", "The packages to link (name, or name==version)")
            .option("--analysis <ref>", "The analysis whose farm gains the links (id or name; the analysis of this folder otherwise)")
            .option("--lang <ecosystem>", "The ecosystem: python or r (necessary when both ecosystems hold a name)"),
        "instance",
        { kind: "auto", safeFlags: ["analysis", "lang"] },
        async (packages: string[], options: { analysis?: string; lang?: string }) => {
            if (options.lang !== undefined && options.lang !== "python" && options.lang !== "r") {
                console.error(`\n  Unknown ecosystem "${options.lang}". Choose python or r.\n`);
                process.exitCode = 1;
                return;
            }
            // The `run_inflexa` tool runs its subprocess inside the analysis folder, thus the folder names the
            // analysis and `--analysis` is the exception. `touch: false` — a link is not a sighting of the folder.
            const { resolveSingleAnalysisOrFail } = await import("../client/commands/analyses.ts");
            const analysis = await resolveSingleAnalysisOrFail(
                { analysis: options.analysis },
                "`inflexa store link` needs the analysis whose farm gains the links, and this folder anchors none. " +
                    "Pass `--analysis <id|name>`, and run `inflexa ls` to see the analyses this machine holds.",
                { touch: false },
            );
            const { storeLink } = await import("../client/commands/store.ts");
            await storeLink(analysis, packages, options.lang);
        },
    );

    // Read-only: the packages, the farms, the flights, the queue, the disk.
    registerAction(
        store.command("ls").description("List the packages, the farms, the live flights, and the disk use of the package store"),
        "machine",
        { kind: "auto", safeFlags: [] },
        async () => {
            const { runStoreLs } = await import("../modules/libs/store.ts");
            await runStoreLs();
        },
    );

    // `approval`: the catalog download moves gigabytes. The hidden
    // `--run-transfer` is the detached child; the spelling is pinned against
    // CATALOG_TRANSFER_FLAG by the download tests.
    registerAction(
        store
            .command("download")
            .description("Start the detached catalog transfer from GitHub Packages, or report why none is necessary")
            .option("--update", "Apply a moved catalog tag (replaces the dependency graph whole)")
            .option("--foreground", "Run the transfer in this process and carry the outcome in the exit code (for a one-shot container)")
            .addOption(new Option("--run-transfer").hideHelp()),
        "machine",
        { kind: "approval" },
        async (options: { update?: boolean; runTransfer?: boolean; foreground?: boolean }) => {
            if (options.runTransfer === true) {
                const { runCatalogTransfer } = await import("../modules/libs/store_download.ts");
                await runCatalogTransfer({ storeRoot: env.packageStoreDir, update: options.update ?? false });
                return;
            }
            const { runStoreDownload } = await import("../modules/libs/store.ts");
            await runStoreDownload({ update: options.update, foreground: options.foreground });
        },
    );

    // `approval`: a cancel stops a transfer the user started and drops its
    // partial staged tree.
    registerAction(
        store.command("cancel").description("Stop the live catalog transfer and remove the partial staged tree; installed content stays"),
        "machine",
        { kind: "approval" },
        async () => {
            const { runStoreCancel } = await import("../modules/libs/store.ts");
            await runStoreCancel();
        },
    );

    // `approval`: the reclaim deletes pool content that no farm references.
    registerAction(
        store.command("reclaim").description("Remove store content that no farm references, after a preview inside the exclusivity window"),
        "machine",
        { kind: "approval" },
        async () => {
            const { runStoreReclaim } = await import("../modules/libs/store.ts");
            await runStoreReclaim();
        },
    );

    // `blocked`: the SBOM is an export for the user to run in a terminal and redirect. A conversation
    // has no use for it.
    registerAction(
        cli
            .command("sbom")
            .description(
                "Print the CycloneDX SBOM of this installation: the CLI binary, the two sandbox images, and the package store on this host, merged into one document",
            ),
        {
            kind: "blocked",
            reason: "`inflexa sbom` is a terminal export for the user, who redirects its output to a file. It is not available to you — ask the user to run it themselves.",
        },
        async () => {
            const { sbomAction } = await import("../modules/sbom/sbom.ts");
            await sbomAction();
        },
    );

    cli.addHelpText("after", renderEnvHelp);

    return cli;
}

/** The root command. `src/index.ts` wires telemetry/logging, then calls `cli.parseAsync()`. */
export const cli = buildProgram();
