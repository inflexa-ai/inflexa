import cac from "cac";

import pkg from "../../package.json";
import { env, envDoc, type EnvDocEntry } from "../lib/env.ts";

export const cli = cac(pkg.name);

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
