import cac from "cac";

import pkg from "../../package.json";
import { env, envDoc, type EnvDocEntry } from "../lib/env.ts";

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
cli.help((sections) => {
    const pathRows: string[][] = [];
    const varRows: string[][] = [];
    const baseVarLabels = new Map<string, string[]>();

    for (const [key, doc] of Object.entries(envDoc) as [keyof typeof env, EnvDocEntry][]) {
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
