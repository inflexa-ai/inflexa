/**
 * The template gate: render each declared test of each template, run the
 * script inside the pinned sandbox image with the package store mounted, and
 * check the expectations against the outputs and the simulated truth.
 *
 * Run: `bun src/build/template-tests.ts [--only tpl-id] [--keep]`
 *
 * Environment:
 *   INFLEXA_PACKAGE_STORE  the host store root (default ~/.local/share/inflexa/package-store)
 *   INFLEXA_FARM           the farm to mount (default <store>/farms/catalog)
 *   INFLEXA_SANDBOX_IMAGE  the image (default ghcr.io/inflexa-ai/sandbox-base:latest)
 *   INFLEXA_EVAL_DATA      the simulated data root (default eval/data); its `refs/` subdirectory mounts at /work/refs
 *
 * The expectation grammar, one string each:
 *   exists <path>
 *   csv_rows <path> >= <n>
 *   json <path> <key> <op> <value>          op in == != >= <= > <
 *   truth_recall <results.csv> >= <fraction>   recall of the truth DE genes at adjusted_pvalue < 0.05
 *   truth_fdr <results.csv> <= <fraction>      observed false discovery proportion at adjusted_pvalue < 0.05
 *   truth_set_recall <enrichment.csv> >= <fraction>   the planted sets found at padj < 0.05, by the `pathway` column
 *   truth_top_precision <results.csv> <n> >= <fraction>   the share of true DE genes among the top n rows by |log2_fold_change|
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { renderTemplate } from "../render/render.js";
import { loadKnowledgeBase } from "./load-kb.js";

const STORE = Bun.env.INFLEXA_PACKAGE_STORE ?? join(homedir(), ".local", "share", "inflexa", "package-store");
const FARM = Bun.env.INFLEXA_FARM ?? join(STORE, "farms", "catalog");
const IMAGE = Bun.env.INFLEXA_SANDBOX_IMAGE ?? "ghcr.io/inflexa-ai/sandbox-base:latest";
const DATA = Bun.env.INFLEXA_EVAL_DATA ?? join(import.meta.dir, "..", "..", "eval", "data");

function argument(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

async function csvRows(path: string): Promise<string[][]> {
    const text = await readFile(path, "utf8");
    return text
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .map((line) => line.split(",").map((cell) => cell.replace(/^"|"$/g, "")));
}

function column(rows: string[][], name: string): string[] {
    const index = rows[0]!.indexOf(name);
    if (index < 0) throw new Error(`no column ${name}`);
    return rows.slice(1).map((row) => row[index] ?? "");
}

function compare(actual: number, op: string, wanted: number): boolean {
    switch (op) {
        case "==":
            return actual === wanted;
        case "!=":
            return actual !== wanted;
        case ">=":
            return actual >= wanted;
        case "<=":
            return actual <= wanted;
        case ">":
            return actual > wanted;
        case "<":
            return actual < wanted;
        default:
            throw new Error(`unknown operator ${op}`);
    }
}

async function significantGenes(resultsPath: string): Promise<Set<string>> {
    const rows = await csvRows(resultsPath);
    const genes = column(rows, "gene");
    const padj = column(rows, "adjusted_pvalue").map(Number);
    return new Set(genes.filter((_gene, index) => Number.isFinite(padj[index]) && padj[index]! < 0.05));
}

export async function checkExpectation(expectation: string, stepDir: string, dataDir: string): Promise<{ ok: boolean; detail: string }> {
    const [kind, ...rest] = expectation.trim().split(/\s+/);
    try {
        switch (kind) {
            case "exists": {
                const exists = await Bun.file(join(stepDir, rest[0]!)).exists();
                return { ok: exists, detail: `${rest[0]} ${exists ? "exists" : "is missing"}` };
            }
            case "csv_rows": {
                const rows = (await csvRows(join(stepDir, rest[0]!))).length - 1;
                return { ok: compare(rows, rest[1]!, Number(rest[2])), detail: `${rest[0]} has ${rows} rows` };
            }
            case "json": {
                const record = await Bun.file(join(stepDir, rest[0]!)).json();
                const value = rest[1]!.split(".").reduce<unknown>((acc, key) => (acc as Record<string, unknown> | undefined)?.[key], record);
                const numeric = Number(value);
                const ok = Number.isFinite(numeric) ? compare(numeric, rest[2]!, Number(rest[3])) : rest[2] === "==" ? String(value) === rest[3] : String(value) !== rest[3];
                return { ok, detail: `${rest[0]} ${rest[1]} = ${String(value)}` };
            }
            case "truth_recall":
            case "truth_fdr": {
                const truthRows = await csvRows(join(dataDir, "truth.csv"));
                const truthGenes = column(truthRows, "gene");
                const truthDe = column(truthRows, "de");
                const positives = new Set(truthGenes.filter((_gene, index) => truthDe[index] === "1"));
                const called = await significantGenes(join(stepDir, rest[0]!));
                const hits = [...called].filter((gene) => positives.has(gene)).length;
                const value = kind === "truth_recall" ? (positives.size === 0 ? 0 : hits / positives.size) : called.size === 0 ? 0 : (called.size - hits) / called.size;
                return { ok: compare(value, rest[1]!, Number(rest[2])), detail: `${kind} = ${value.toFixed(3)} (${called.size} called, ${positives.size} true)` };
            }
            case "truth_top_precision": {
                // A descriptive template has no p-value, thus its truth is the precision of its ranking.
                const truthRows = await csvRows(join(dataDir, "truth.csv"));
                const truthGenes = column(truthRows, "gene");
                const truthDe = column(truthRows, "de");
                const positives = new Set(truthGenes.filter((_gene, index) => truthDe[index] === "1"));
                const rows = await csvRows(join(stepDir, rest[0]!));
                const genes = column(rows, "gene");
                const lfc = column(rows, "log2_fold_change").map(Number);
                const top = genes
                    .map((gene, index) => ({ gene, size: Math.abs(lfc[index] ?? Number.NaN) }))
                    .filter((row) => Number.isFinite(row.size))
                    .sort((a, b) => b.size - a.size)
                    .slice(0, Number(rest[1]));
                const hits = top.filter((row) => positives.has(row.gene)).length;
                const value = top.length === 0 ? 0 : hits / top.length;
                return { ok: compare(value, rest[2]!, Number(rest[3])), detail: `top ${top.length} precision = ${value.toFixed(3)}` };
            }
            case "truth_set_recall": {
                const truthRows = await csvRows(join(dataDir, "truth.csv"));
                const planted = new Set(column(truthRows, "planted_set").filter((set) => set.startsWith("HALLMARK")));
                const rows = await csvRows(join(stepDir, rest[0]!));
                const pathways = column(rows, "pathway");
                const padj = column(rows, "padj").map(Number);
                const found = new Set(pathways.filter((_pathway, index) => Number.isFinite(padj[index]) && padj[index]! < 0.05));
                const hits = [...planted].filter((set) => found.has(set)).length;
                const value = planted.size === 0 ? 0 : hits / planted.size;
                return { ok: compare(value, rest[1]!, Number(rest[2])), detail: `planted sets found ${hits}/${planted.size}` };
            }
            default:
                return { ok: false, detail: `unknown expectation ${kind}` };
        }
    } catch (error) {
        return { ok: false, detail: `${expectation}: ${error instanceof Error ? error.message : String(error)}` };
    }
}

export async function runInSandbox(stepDir: string, dataDir: string, scriptRelative: string, language: "R" | "python" = "R"): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(
        [
            "docker",
            "run",
            "--rm",
            "--entrypoint",
            language === "R" ? "Rscript" : "python3",
            "-v",
            `${STORE}:/mnt/libs:ro`,
            "-v",
            `${FARM}:/mnt/libs/farm:ro`,
            "-v",
            `${dataDir}:/work/data:ro`,
            "-v",
            `${stepDir}:/work/step`,
            "-v",
            `${join(DATA, "refs")}:/work/refs:ro`,
            "-w",
            "/work/step",
            IMAGE,
            scriptRelative,
        ],
        { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, stdout, stderr };
}

if (import.meta.main) {
    const only = argument("--only");
    const keep = process.argv.includes("--keep");
    const loaded = await loadKnowledgeBase(join(import.meta.dir, "..", "..", "kb"));
    if (!loaded.ok) {
        for (const issue of loaded.issues) console.error(`${issue.path}: ${issue.message}`);
        process.exit(1);
    }
    let failures = 0;
    let total = 0;
    for (const template of loaded.kb.templates) {
        if (only && template.id !== only) continue;
        for (const test of template.tests ?? []) {
            total += 1;
            const dataDir = join(DATA, test.dataset);
            if (!(await Bun.file(join(dataDir, "counts.csv")).exists())) {
                console.error(`✗ ${template.id} ${test.name}: dataset ${test.dataset} is missing; run eval:simulate first`);
                failures += 1;
                continue;
            }
            const rendered = renderTemplate(template, template.body, test.slots);
            if (!rendered.ok) {
                console.error(`✗ ${template.id} ${test.name}: render failed ${JSON.stringify(rendered.issues)}`);
                failures += 1;
                continue;
            }
            const stepDir = await mkdtemp(join(tmpdir(), `inflexa-tpl-${template.id}-`));
            const scriptRelative = join("scripts", `${template.id}.${template.language === "R" ? "R" : "py"}`);
            await Bun.write(join(stepDir, scriptRelative), rendered.script);
            const started = Date.now();
            const run = await runInSandbox(stepDir, dataDir, scriptRelative, template.language);
            const seconds = ((Date.now() - started) / 1000).toFixed(1);
            if (run.code !== 0) {
                console.error(`✗ ${template.id} ${test.name}: exit ${run.code} after ${seconds}s\n${run.stderr.split("\n").slice(-25).join("\n")}`);
                failures += 1;
                if (!keep) await rm(stepDir, { recursive: true, force: true });
                continue;
            }
            const results = await Promise.all((test.expect ?? []).map((expectation) => checkExpectation(expectation, stepDir, dataDir)));
            const failed = results.filter((result) => !result.ok);
            if (failed.length > 0) {
                failures += 1;
                console.error(`✗ ${template.id} ${test.name} (${seconds}s):\n${failed.map((result) => `    ${result.detail}`).join("\n")}`);
            } else {
                console.log(`✓ ${template.id} ${test.name} (${seconds}s): ${results.map((result) => result.detail).join("; ")}`);
            }
            if (keep) console.log(`  kept ${stepDir}`);
            else await rm(stepDir, { recursive: true, force: true });
        }
    }
    console.log(`${total - failures}/${total} template tests passed`);
    process.exit(failures > 0 ? 1 : 0);
}
