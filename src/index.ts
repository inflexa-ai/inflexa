import cac from "cac";

const cli = cac("inf");

cli.command("[session]", "Launch the TUI (default)")
    .option("--session <id>", "Resume a specific session by ID")
    .action(async (session: string | undefined) => {
        const { launchTui } = await import("./cli/tui.tsx");
        await launchTui({ session });
    });

cli.command("sessions", "List saved sessions").action(async () => {
    const { listSessions } = await import("./cli/sessions.ts");
    await listSessions();
});

cli.version("0.0.1");
cli.help();
cli.parse();
