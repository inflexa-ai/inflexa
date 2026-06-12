import cac from "cac";

import pkg from "../../package.json";

export const cli = cac(pkg.name);

cli.command("[session]", "Launch the TUI (default)")
    .option("--session <id>", "Resume a specific session by ID")
    .action(async (session: string | undefined) => {
        const { launchTui } = await import("./tui.tsx");
        await launchTui({ session });
    });

cli.command("sessions", "List saved sessions").action(async () => {
    const { listSessions } = await import("./sessions.ts");
    await listSessions();
});

cli.command("config", "View and change settings").action(async () => {
    const { launchConfig } = await import("./config.tsx");
    await launchConfig();
});

cli.version(pkg.version);
cli.help();
