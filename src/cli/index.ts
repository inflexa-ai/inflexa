import cac from "cac";

import pkg from "../../package.json";
import { env, envDoc, type EnvDocEntry } from "../lib/env.ts";

export const cli = cac(pkg.name);

/** A help block as cac renders it: an optional title above its body. Mirrors cac's internal (unexported) HelpSection. */
type HelpSection = { title?: string; body: string };

/** cac yields an option value as a string (`--flag <value>`) or boolean (a bare `--flag`). */
type SubcommandOptions = Record<string, string | boolean | undefined>;

/** A flag, declared alongside the subcommand (or group) that owns it so the two stay together. */
type SubcommandOption = {
    /** cac flag spec, e.g. "--tags <tags>". */
    flag: string;
    /** Help description. */
    description: string;
};

/** One git-style subcommand under a parent command (e.g. `new` under `project`). */
type Subcommand = {
    /** The verb after the parent, e.g. "new". */
    name: string;
    /** Arg signature shown in help, e.g. "<name>" (empty when the verb takes none). */
    args: string;
    /** One-line description for the help listing. */
    summary: string;
    /** Flags this verb owns. Declared here, not on the parent command (see `registerSubcommands`). */
    options?: SubcommandOption[];
    /** Invoked with the positional args following the verb, plus the parsed options. */
    run: (args: string[], options: SubcommandOptions) => void | Promise<void>;
};

/** A parent command and the verbs beneath it, retained so the help callback can render per-verb help. */
type SubcommandGroup = {
    summary: string;
    subs: Subcommand[];
    /** Flags shared by every verb (e.g. `--verbose`), registered on the parent command. */
    options: SubcommandOption[];
};

// Keyed by parent name (e.g. "project") so the global help callback can recover the group cac matched.
const subcommandGroups = new Map<string, SubcommandGroup>();

function subcommandSignature(s: Subcommand): string {
    return `${s.name} ${s.args}`.trim();
}

/** Aligned `flag  description` lines for an options block, each prefixed by `indent`. */
function optionLines(options: SubcommandOption[], indent: string): string {
    const width = Math.max(0, ...options.map((o) => o.flag.length));
    return options.map((o) => `${indent}${o.flag.padEnd(width)}  ${o.description}`).join("\n");
}

/** The subcommand listing — each verb, with its own flags indented beneath it. */
function subcommandLines(subs: Subcommand[]): string {
    const width = Math.max(...subs.map((s) => subcommandSignature(s).length));
    const lines: string[] = [];
    for (const s of subs) {
        lines.push(`  ${subcommandSignature(s).padEnd(width)}  ${s.summary}`);
        if (s.options?.length) lines.push(optionLines(s.options, `  ${" ".repeat(width)}    `));
    }
    return lines.join("\n");
}

/**
 * Help for a subcommand group: the verb's own usage + options when `verb` names one, else a
 * listing of every verb. Returned as cac `HelpSection`s so `cli.help` can render it and the
 * action path can print it directly.
 */
function renderSubcommandHelp(name: string, verb?: string): HelpSection[] {
    const group = subcommandGroups.get(name);
    if (!group) return [];
    const header: HelpSection = { body: `${pkg.name}/${pkg.version}` };
    const sub = verb ? group.subs.find((s) => s.name === verb) : undefined;

    if (sub) {
        // Shared (parent) flags apply to every verb, so list them alongside the verb's own.
        const opts = [...(sub.options ?? []), ...group.options];
        const sections: HelpSection[] = [header, { title: "Usage", body: `  $ ${pkg.name} ${name} ${subcommandSignature(sub)}` }];
        if (opts.length) sections.push({ title: "Options", body: optionLines(opts, "  ") });
        return sections;
    }

    const sections: HelpSection[] = [
        header,
        { title: "Usage", body: `  $ ${pkg.name} ${name} <subcommand> [args]` },
        { title: "Subcommands", body: subcommandLines(group.subs) },
    ];
    if (group.options.length) sections.push({ title: "Options", body: optionLines(group.options, "  ") });
    return sections;
}

/** Renders `HelpSection`s exactly as cac does (title above its body), for the non-`--help` action path. */
function printSubcommandHelp(name: string, verb?: string): void {
    const text = renderSubcommandHelp(name, verb)
        .map((s) => (s.title ? `${s.title}:\n${s.body}` : s.body))
        .join("\n\n");
    console.info(`\n${text}\n`);
}

// cac matches a command name against only the first positional token (it compares
// `parsed.args[0]` to a command's full name), so a multi-word name like `project new`
// can never match — `inf project new x` falls through to the default command with
// `new x` as stray args. We register one `<name> [action] [...args]` command, whose name
// is the single token `<name>` that cac DOES match, and route `action` ourselves.
function registerSubcommands(name: string, summary: string, subs: Subcommand[], options: SubcommandOption[] = []): void {
    subcommandGroups.set(name, { summary, subs, options });

    const cmd = cli.command(`${name} [action] [...args]`, summary);
    // cac scopes an option to a command, never to a positional action, so every flag — shared or
    // per-verb — has to be registered on the one parent command. Ownership stays legible because
    // each flag is declared on its Subcommand (or in `options`), and help renders it per verb.
    for (const o of options) cmd.option(o.flag, o.description);
    for (const s of subs) {
        cmd.example(`${pkg.name} ${name} ${subcommandSignature(s)}`);
        for (const o of s.options ?? []) cmd.option(o.flag, o.description);
    }

    cmd.action(async (action: string | undefined, args: string[] | undefined, parsed: SubcommandOptions) => {
        if (!action || action === "help") {
            printSubcommandHelp(name);
            return;
        }
        const sub = subs.find((s) => s.name === action);
        if (!sub) {
            console.error(`Unknown ${name} subcommand "${action}".`);
            printSubcommandHelp(name);
            process.exit(1);
        }
        await sub.run(args ?? [], parsed);
    });
}

cli.command("[session]", "Launch the TUI (default)")
    .option("--session <id>", "Resume a specific session by ID")
    .action(async (session: string | undefined) => {
        const { launchTui } = await import("../tui/launch.tsx");
        await launchTui({ session });
    });

cli.command("sessions", "List saved sessions").action(async () => {
    const { listSessions } = await import("../modules/session/sessions.ts");
    await listSessions();
});

cli.command("config", "View and change settings").action(async () => {
    const { launchConfig } = await import("../tui/config.tsx");
    await launchConfig();
});

registerSubcommands("project", "Manage projects (optional grouping of analyses)", [
    {
        name: "new",
        args: "<name>",
        summary: "Create a project",
        options: [
            { flag: "--description <text>", description: "A short description" },
            { flag: "--tags <tags>", description: "Comma-separated tags" },
        ],
        run: async (args, options) => {
            const name = args[0];
            if (!name) {
                console.error(`Usage: ${pkg.name} project new <name> [--description <d>] [--tags <t,t>]`);
                process.exit(1);
            }
            const { projectNew } = await import("../modules/project/project.ts");
            projectNew(name, {
                description: typeof options.description === "string" ? options.description : undefined,
                tags: typeof options.tags === "string" ? options.tags : undefined,
            });
        },
    },
    {
        name: "ls",
        args: "",
        summary: "List projects",
        run: async () => {
            const { projectLs } = await import("../modules/project/project.ts");
            projectLs();
        },
    },
]);

cli.command("login", "Log in via the Auth0 device flow").action(async () => {
    const { login } = await import("../modules/auth/login.ts");
    await login();
});

cli.command("logout", "Log out and revoke the stored session").action(async () => {
    const { logout } = await import("../modules/auth/logout.ts");
    await logout();
});

cli.command("whoami", "Show the logged-in user and session status").action(async () => {
    const { whoami } = await import("../modules/auth/whoami.ts");
    whoami();
});

cli.command("setup", "Install, authenticate, and start CLIProxyAPI (Docker)")
    .option("--provider <name>", "Authenticate a provider non-interactively: gemini|openai|claude|qwen|iflow")
    .option("--no-auth", "Skip the provider authentication step")
    .option("--no-start", "Set up only; don't start the proxy container")
    .option("--force", "Re-pull the proxy image even if it is already cached")
    .action(async (options: { provider?: string; auth: boolean; start: boolean; force: boolean }) => {
        const { setup } = await import("../modules/proxy/setup.ts");
        await setup(options);
    });

cli.version(pkg.version);
cli.help((sections) => {
    // A subcommand group is a single cac command (`<name> [action] [...args]`), so cac's own
    // help can't tell `project new --help` from `project --help`. We know the matched group and
    // the verb (`cli.args[0]`, the token after the parent), so render focused per-verb help.
    if (cli.matchedCommandName && subcommandGroups.has(cli.matchedCommandName)) {
        return renderSubcommandHelp(cli.matchedCommandName, cli.args[0]);
    }

    const pathRows: string[][] = [];
    const varRows: string[][] = [];
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

    const table = (rows: string[][]) => {
        const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
        return rows.map((row) => "  " + row.map((cell, i) => (i < row.length - 1 ? cell.padEnd(widths[i]!) : cell)).join("  ")).join("\n");
    };

    sections.push({ title: "Paths", body: table(pathRows) }, { title: "Environment", body: table(varRows) });
});
