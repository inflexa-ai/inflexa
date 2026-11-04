import { randomUUIDv7 } from "bun";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { present } from "../lib/present.ts";

const cliRoot = join(import.meta.dir, "../..");

/** Time budget for a test that waits on {@link lintScratch}: the spawn builds the type-aware program, and the suite runs under load. */
export const OXLINT_SPAWN_TIMEOUT_MS = 60_000;

/** A source text to lint as a file of the folder `scope` (relative to `cli/`, for example `src/tui`), with the file extension `ext`. */
export type Snippet = { scope: string; ext: "ts" | "tsx"; text: string };

/** One report of the real `oxlint.config.ts` on one line of one file. `rule` is the code that oxlint prints, for example `eslint-js(no-restricted-syntax)`. */
export type Report = { rule: string; line: number; message: string };

const OxlintOutput = z.object({
    diagnostics: z.array(
        z.object({
            code: z.string(),
            filename: z.string(),
            message: z.string(),
            labels: z.array(z.object({ span: z.object({ line: z.number() }) })).default([]),
        }),
    ),
    number_of_files: z.number(),
});

/** The code of the report of an entry of `eslint-js/no-restricted-syntax`. */
export const RESTRICTED_SYNTAX = "eslint-js(no-restricted-syntax)";

/** The code of the report of the native `no-restricted-imports` rule. */
export const RESTRICTED_IMPORTS = "eslint(no-restricted-imports)";

/** The reports of `rule` in `reports`, as the lines they name. */
export function linesOf(reports: readonly Report[], rule: string): number[] {
    return reports.filter((r) => r.rule === rule).map((r) => r.line);
}

/**
 * Lint the snippets and the real files of `realPaths` (relative to `cli/`) in ONE `bun --bun oxlint` spawn against the
 * real config, and return the reports of each, in the order given.
 *
 * The pinned oxlint rejects `--stdin`, and an override applies by the glob-relative path of a file, so each snippet is
 * written to a uniquely named file in a scratch folder under its scope. Each scratch folder is removed afterwards.
 * Other rules of the preset report on a scratch file as well. A caller reads the rule that carries its ban only.
 *
 * The call throws, and does not return an empty list, when the spawn cannot lint every target: an exit code other than
 * 0 or 1 (a config error), output that is not the JSON shape, or fewer linted files than targets (an ignored path).
 */
export async function lintScratch(snippets: readonly Snippet[], realPaths: readonly string[] = []): Promise<{ snippets: Report[][]; real: Report[][] }> {
    const scratchRoot = new Map<string, string>();
    for (const { scope } of snippets) {
        if (!scratchRoot.has(scope)) scratchRoot.set(scope, `${scope}/zz_oxlint_scratch_${randomUUIDv7()}`);
    }
    const snippetPaths = snippets.map(({ scope, ext }) => `${present(scratchRoot.get(scope), "the scratch folder of the scope")}/${randomUUIDv7()}.${ext}`);
    try {
        for (const dir of scratchRoot.values()) await mkdir(join(cliRoot, dir), { recursive: true });
        await Promise.all(snippets.map(({ text }, i) => writeFile(join(cliRoot, snippetPaths[i] ?? ""), text)));
        const targets = [...snippetPaths, ...realPaths];
        const reports = await spawnOxlint(targets);
        return {
            snippets: snippetPaths.map((path) => reports.get(path) ?? []),
            real: realPaths.map((path) => reports.get(path) ?? []),
        };
    } finally {
        await Promise.all([...scratchRoot.values()].map((dir) => rm(join(cliRoot, dir), { recursive: true, force: true })));
    }
}

async function spawnOxlint(targets: readonly string[]): Promise<Map<string, Report[]>> {
    const proc = Bun.spawn([process.execPath, "--bun", "oxlint", "-f", "json", ...targets], { cwd: cliRoot, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    // Exit 1 means "the lint found an error", which a scratch file expects. Any other code is a failure to lint.
    if (exitCode !== 0 && exitCode !== 1) throw new Error(`oxlint failed (exit ${exitCode}):\n${stderr}\n${stdout}`);
    const parsed = JSON.parseResult(stdout, OxlintOutput);
    if (parsed.isErr()) {
        if (parsed.error.type === "malformed") throw new Error(`oxlint printed no JSON (exit ${exitCode}):\n${stderr}\n${stdout}`);
        throw parsed.error.error;
    }
    const output = parsed.value;
    if (output.number_of_files !== targets.length) {
        throw new Error(`oxlint linted ${output.number_of_files} files for ${targets.length} targets (a target is ignored or missing):\n${stderr}`);
    }
    const byFile = new Map<string, Report[]>();
    for (const d of output.diagnostics) {
        const list = byFile.get(d.filename) ?? [];
        list.push({ rule: d.code, line: d.labels[0]?.span.line ?? 0, message: d.message });
        byFile.set(d.filename, list);
    }
    return byFile;
}
