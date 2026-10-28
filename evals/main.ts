/**

 * The command line of the decision evals.
 *
 *   bun run evals run [--provider <file>] [--set dev|held-out|all] [--case <id>]... [--trials 5] [--k 3]
 *                     [--concurrency 4] [--timeout 180] [--out <file>]
 *   bun run evals compare <baseline.json> <candidate.json> [--fail-on-regression]
 *
 * Each trial makes real model calls, thus the evals never run under `bun test`.
 */

// The CLI installs its global extensions (`JSON.parseWith`, `Promise.sleep`) at its entry point, and the
// CLI modules that the agent holds call them.
import "../cli/src/extensions/index.ts";

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { createNoopLogger } from "@inflexa-ai/harness/lib/console-logger.js";
import { parseJsonAs } from "@inflexa-ai/harness/lib/parse-json.js";
import { allCases } from "./cases/index.js";
import { conversationAgent } from "./lib/agent.js";
import type { EvalCase } from "./lib/case.js";
import { cliProvider, identityOf, providerOf, readProviderFile } from "./lib/provider.js";
import { buildReport, compareReports, comparisonTable, regressions, reportTable, ReportSchema, type Report } from "./lib/report.js";
import { promptDigest, runCases } from "./lib/run.js";

const USAGE = `usage:
  bun run evals run [--provider <file>] [--set dev|held-out|all] [--case <id>]... [--trials 5] [--k 3] [--concurrency 4] [--timeout 180] [--out <file>]
  bun run evals compare <baseline.json> <candidate.json> [--fail-on-regression]

With no --provider, the run uses the conversation model that the CLI configures.
A provider file holds an AiSdkProviderConfig: kind, model, baseURL, reasoning, and apiKey or apiKeyEnv.`;

function fail(message: string): never {
    process.stderr.write(`${message}\n\n${USAGE}\n`);
    process.exit(2);
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) fail(`--${name} must be a positive integer`);
    return parsed;
}

function commitOf(): string | undefined {
    try {
        const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
        const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
        return dirty ? `${head}-dirty` : head;
    } catch {
        return undefined;
    }
}

function selectCases(set: string, ids: readonly string[]): EvalCase[] {
    if (ids.length > 0) {
        const unknown = ids.filter((id) => !allCases.some((c) => c.id === id));
        if (unknown.length > 0) fail(`unknown case: ${unknown.join(", ")}`);
        return allCases.filter((c) => ids.includes(c.id));
    }
    if (set === "all") return [...allCases];
    if (set !== "dev" && set !== "held-out") fail(`--set must be dev, held-out, or all`);
    return allCases.filter((c) => c.set === set);
}

async function run(args: readonly string[]): Promise<void> {
    const { values } = parseArgs({
        args: [...args],
        options: {
            provider: { type: "string" },
            set: { type: "string", default: "dev" },
            case: { type: "string", multiple: true, default: [] },
            trials: { type: "string" },
            k: { type: "string" },
            concurrency: { type: "string" },
            timeout: { type: "string" },
            out: { type: "string" },
        },
    });
    const trials = positiveInt(values.trials, 5, "trials");
    const k = positiveInt(values.k, Math.min(3, trials), "k");
    if (k > trials) fail("--k cannot be above --trials");
    const cases = selectCases(values.set, values.case);

    const logger = createNoopLogger();
    const { provider, identity } =
        values.provider === undefined
            ? await cliProvider(logger)
            : await readProviderFile(values.provider).then((file) => ({ provider: providerOf(file, process.env, logger), identity: identityOf(file) }));
    const agent = conversationAgent();
    const startedAt = new Date().toISOString();
    const digest = promptDigest(agent);

    process.stderr.write(`${cases.length} cases x ${trials} trials on ${identity.model}, prompt ${digest}\n`);
    const results = await runCases(cases, {
        agent,
        provider,
        trials,
        concurrency: positiveInt(values.concurrency, 4, "concurrency"),
        trialTimeoutMs: positiveInt(values.timeout, 180, "timeout") * 1000,
        onTrial: (_case, result) => process.stderr.write(result.kind === "error" ? "E" : result.pass ? "." : "F"),
    });
    process.stderr.write("\n");

    const report = buildReport({ startedAt, commit: commitOf(), promptDigest: digest, provider: identity, trialsPerCase: trials, k }, cases, results);
    const out = values.out ?? join(import.meta.dirname, "..", "tmp", "evals", `${startedAt.replaceAll(":", "-")}-${digest}.json`);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${reportTable(report)}\n\nreport: ${out}\n`);
}

async function readReport(path: string): Promise<Report> {
    return parseJsonAs(await readFile(path, "utf8"), ReportSchema);
}

async function compare(args: readonly string[]): Promise<void> {
    const { values, positionals } = parseArgs({
        args: [...args],
        allowPositionals: true,
        options: { "fail-on-regression": { type: "boolean", default: false } },
    });
    const [baselinePath, candidatePath] = positionals;
    if (baselinePath === undefined || candidatePath === undefined) fail("compare needs a baseline report and a candidate report");
    const baseline = await readReport(baselinePath);
    const candidate = await readReport(candidatePath);
    const comparison = compareReports(baseline, candidate);
    process.stdout.write(`${comparisonTable(comparison, baseline, candidate)}\n`);
    const failures = regressions(comparison);
    if (failures.length > 0) process.stdout.write(`\n${failures.join("\n")}\n`);
    if (values["fail-on-regression"] && failures.length > 0) process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
    case "run":
        await run(rest);
        break;
    case "compare":
        await compare(rest);
        break;
    default:
        fail(command === undefined ? "a command is required" : `unknown command: ${command}`);
}
