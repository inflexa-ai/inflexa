/**

 * The command line of the decision evals.
 *
 *   bun run evals run [--provider <file> | --model <id>] [--set dev|held-out|all] [--case <id>]... [--trials 5] [--k 3]
 *                     [--concurrency 4] [--timeout 180] [--exposure base] [--sandbox-agent <agent-id>] [--exec scripted|docker] [--out <file>]
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

import { createConsoleLogger, createNoopLogger } from "@inflexa-ai/harness/lib/console-logger.js";
import { parseJsonAs } from "@inflexa-ai/harness/lib/parse-json.js";
import { allCases } from "./cases/index.js";
import { evalAgents, exposed, synthesisAgent, TOOL_EXPOSURES, type StaticAgentKind, type ToolExposure } from "./lib/agent.js";
import type { EvalCase } from "./lib/case.js";
import { cliProvider, identityOf, providerOf, readProviderFile } from "./lib/provider.js";
import { buildReport, compareReports, comparisonTable, regressions, reportTable, ReportSchema, type Report } from "./lib/report.js";
import { promptDigest, runCases } from "./lib/run.js";
import { openSandboxTrial } from "./lib/sandbox.js";
import { overrideAgentIds, overrideSandboxAgent, type OverriddenCase } from "./lib/sandbox-agent.js";
import { assertSandboxImage, SANDBOX_IMAGE } from "./lib/docker-exec.js";
import type { AgentDefinition } from "@inflexa-ai/harness/loop/types.js";
import { okAsync } from "neverthrow";

const USAGE = `usage:
  bun run evals run [--provider <file> | --model <id>] [--set dev|held-out|all] [--case <id>]... [--trials 5] [--k 3] [--concurrency 4] [--timeout 180] [--exposure base|read-both|read-write-both|read-script] [--sandbox-agent <agent-id>] [--exec scripted|docker] [--out <file>]
  bun run evals compare <baseline.json> <candidate.json> [--fail-on-regression]

With no --provider, the run uses the conversation model that the CLI configures.
--sandbox-agent runs each selected step case (not a case of the data profiler) with that step agent.
--exec docker runs each command of a sandbox case in a container of the sandbox image, with no network, over a farm of the package store.
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
        // An untracked file runs only through a tracked import, which shows as a change, thus it does not mark the run.
        const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim().length > 0;
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
            model: { type: "string" },
            set: { type: "string", default: "dev" },
            case: { type: "string", multiple: true, default: [] },
            trials: { type: "string" },
            k: { type: "string" },
            concurrency: { type: "string" },
            timeout: { type: "string" },
            out: { type: "string" },
            exposure: { type: "string", default: "base" },
            "sandbox-agent": { type: "string" },
            exec: { type: "string", default: "scripted" },
        },
    });
    const exposure = TOOL_EXPOSURES.find((name) => name === values.exposure);
    if (exposure === undefined) fail(`--exposure must be one of ${TOOL_EXPOSURES.join(", ")}`);
    const trials = positiveInt(values.trials, 5, "trials");
    const k = positiveInt(values.k, Math.min(3, trials), "k");
    if (k > trials) fail("--k cannot be above --trials");
    const selected = selectCases(values.set, values.case);
    const override = values["sandbox-agent"];
    if (override !== undefined && !overrideAgentIds().includes(override)) fail(`--sandbox-agent must be one of ${overrideAgentIds().join(", ")}`);
    const exec = values.exec === "docker" ? "docker" : values.exec === "scripted" ? "scripted" : fail("--exec must be scripted or docker");
    if (exec === "docker") await assertSandboxImage();
    const cases = override !== undefined ? reported(await overrideSandboxAgent(selected, override), override) : selected;

    // EVALS_LOG=1 shows the log of the harness, for example the retries of a provider that stalls.
    const logger = process.env["EVALS_LOG"] === "1" ? createConsoleLogger() : createNoopLogger();
    const { provider, identity } =
        values.provider === undefined
            ? await cliProvider(logger, "conversation", values.model)
            : await readProviderFile(values.provider).then((file) => ({ provider: providerOf(file, process.env, logger), identity: identityOf(file) }));
    // A sandbox case runs on the sandbox model of the CLI. A provider file serves each case.
    const sandboxCases = cases.filter((c) => c.agent === "sandbox");
    const sandbox = sandboxCases.length === 0 || values.provider !== undefined ? undefined : await cliProvider(logger, "sandbox", values.model);
    const agents = evalAgents();
    const startedAt = new Date().toISOString();
    const digest = promptDigest(
        exposedAgents(agents, exposure),
        [...(await sandboxAgentsOf(sandboxCases)), synthesisAgent([])].map((agent) => exposed(agent, exposure)),
    );

    process.stderr.write(
        `${cases.length} cases x ${trials} trials on ${identity.model}${sandbox === undefined ? "" : ` (sandbox ${sandbox.identity.model})`}, prompt ${digest}\n`,
    );
    const results = await runCases(cases, {
        agents,
        provider,
        sandboxProvider: sandbox?.provider,
        trials,
        concurrency: positiveInt(values.concurrency, 4, "concurrency"),
        trialTimeoutMs: positiveInt(values.timeout, 180, "timeout") * 1000,
        exposure,
        exec,
        onTrial: (_case, result) => process.stderr.write(result.kind === "error" ? "E" : result.pass ? "." : "F"),
    });
    process.stderr.write("\n");

    const report = buildReport(
        {
            startedAt,
            commit: commitOf(),
            promptDigest: digest,
            provider: identity,
            sandboxProvider: sandbox?.identity,
            exec: exec === "docker" ? { mode: exec, image: SANDBOX_IMAGE } : undefined,
            trialsPerCase: trials,
            k,
        },
        cases,
        results,
    );
    // Kept beside the cases under the commit that ran, thus a later measure reuses the report of a commit.
    const out = values.out ?? join(import.meta.dirname, "results", `${report.commit ?? "unknown"}-${startedAt.replaceAll(":", "-")}-${digest}.json`);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${reportTable(report)}\n\nreport: ${out}\n`);
}

function reported(overridden: readonly OverriddenCase[], replacement: string): EvalCase[] {
    for (const { evalCase, dropped } of overridden)
        if (dropped.length > 0) process.stderr.write(`${evalCase.id}: ${replacement} holds no ${dropped.join(", ")}, thus the case drops their scripts\n`);
    return overridden.map(({ evalCase }) => evalCase);
}

/** The static agents as a trial of `exposure` holds them, for the prompt digest. */
function exposedAgents(agents: Readonly<Record<StaticAgentKind, AgentDefinition>>, exposure: ToolExposure): Readonly<Record<StaticAgentKind, AgentDefinition>> {
    return {
        conversation: exposed(agents.conversation, exposure),
        planner: exposed(agents.planner, exposure),
        "planner-knowledge": exposed(agents["planner-knowledge"], exposure),
        report: exposed(agents.report, exposure),
        analogy: exposed(agents.analogy, exposure),
    };
}

/** One composition of each sandbox agent that a case names, for the prompt digest. */
async function sandboxAgentsOf(cases: readonly EvalCase[]): Promise<AgentDefinition[]> {
    const setups = new Map(cases.flatMap((c) => (c.sandbox === undefined ? [] : [[c.sandbox.agentId, c.sandbox] as const])));
    const agents: AgentDefinition[] = [];
    for (const setup of setups.values()) {
        const trial = await openSandboxTrial(setup, { toolOutputStore: { put: () => okAsync(undefined), get: () => okAsync(null) }, label: "digest" });
        await trial.dispose();
        agents.push(trial.agent);
    }
    return agents;
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
