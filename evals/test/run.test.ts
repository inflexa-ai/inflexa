import { describe, expect, test } from "bun:test";

import { callTools, reply, scriptedModel, text, toolCall } from "@inflexa-ai/harness/testing.js";
import { evalAgents, UNSCRIPTED_ERROR } from "../lib/agent.js";
import { asked, decides, never, plans, type EvalCase } from "../lib/case.js";
import { allCases } from "../cases/index.js";
import { withRunScript } from "@inflexa-ai/harness/loop/run-loop.js";
import { promptDigest, runTrial, turnInputOf } from "../lib/run.js";

const agents = evalAgents();
const agent = agents.conversation;

function evalCase(overrides: Partial<EvalCase>): EvalCase {
    return { id: "case", set: "dev", source: "test", user: "Run a differential expression analysis.", maxSteps: 3, grade: never([]), ...overrides };
}

describe("runTrial", () => {
    test("sends the system prompt and each tool of the agent, and grades the calls", async () => {
        const model = scriptedModel([
            callTools(toolCall("c1", "execute_analysis", { mode: "adhoc", request: "Run a differential expression analysis." })),
            reply([text("Started.")]),
        ]);
        const result = await runTrial(
            evalCase({
                tools: { execute_analysis: { ok: { runId: "r1", started: true } } },
                grade: decides("execute_analysis", ["generate_plan"], { mode: "adhoc" }),
            }),
            { agents, provider: model.provider, trialTimeoutMs: 10_000 },
        );
        expect(result).toMatchObject({ kind: "graded", pass: true, text: "Started.", finishReason: "stop" });
        const request = model.calls[0];
        expect(request?.tools?.map((tool) => tool.name).sort()).toEqual(
            withRunScript(agent)
                .tools.map((tool) => tool.id)
                .sort(),
        );
        expect(request?.prompt[0]).toMatchObject({ role: "system", content: agent.systemPrompt });
    });

    test("stops at maxSteps, and an unscripted tool gives an error result", async () => {
        const model = scriptedModel([callTools(toolCall("c1", "inspect_run", {})), callTools(toolCall("c2", "inspect_run", {}))]);
        const result = await runTrial(evalCase({ maxSteps: 1 }), { agents, provider: model.provider, trialTimeoutMs: 10_000 });
        expect(model.calls).toHaveLength(1);
        expect(result).toMatchObject({ kind: "graded", calls: [{ step: 0, tool: "inspect_run" }] });
        expect(JSON.stringify(model.calls)).not.toContain(UNSCRIPTED_ERROR);
    });

    test("feeds the error of an unscripted tool to the next request", async () => {
        const model = scriptedModel([callTools(toolCall("c1", "inspect_run", {})), reply([text("No.")])]);
        await runTrial(evalCase({ maxSteps: 2 }), { agents, provider: model.provider, trialTimeoutMs: 10_000 });
        expect(JSON.stringify(model.calls[1]?.prompt)).toContain(UNSCRIPTED_ERROR);
    });

    test("reports a failed model call as an error, not as a grade", async () => {
        const model = scriptedModel([{ fail: new Error("the endpoint is down") }]);
        const result = await runTrial(evalCase({}), { agents, provider: model.provider, trialTimeoutMs: 10_000 });
        expect(result.kind).toBe("error");
    });
});

describe("turnInputOf", () => {
    test("gives the user message, then the context records of a production turn", async () => {
        const input = await turnInputOf(
            evalCase({ user: "Is it done?", state: { runningRuns: [{ runId: "r-1", planId: "pln-1a2b3c4d", startedAt: "2026-10-27T09:00:00.000Z" }] } }),
            [],
        );
        expect(input.map((message) => message.content)).toEqual([
            "Is it done?",
            "[Run Activity]\nRunning:\n- runId: r-1 | planId: pln-1a2b3c4d | startedAt: 2026-10-27T09:00:00.000Z",
            "[Working Memory]\nThe working memory is empty.",
        ]);
    });

    test("an empty state gives the records of an analysis with no run, and the analysis context comes first", async () => {
        const input = await turnInputOf(evalCase({ user: "Hi", state: { analysisContext: "A treatment study." } }), []);
        expect(input.map((message) => message.content)).toEqual([
            "Hi",
            "[Analysis Context]\nA treatment study.",
            "[Run Activity]\nNo runs are currently running.",
            "[Working Memory]\nThe working memory is empty.",
        ]);
    });
});

describe("the agent of a case", () => {
    test("a planner case gives the seed alone, and a report case reads no working memory", async () => {
        const planner = await turnInputOf(evalCase({ agent: "planner", user: "## Research Question\nWhich genes change?" }), []);
        const report = await turnInputOf(evalCase({ agent: "report", user: "# Report Brief" }), []);

        expect(planner).toEqual([{ role: "user", content: "## Research Question\nWhich genes change?" }]);
        expect(report.map((message) => message.content)).toEqual(["# Report Brief", "[Run Activity]\nNo runs are currently running."]);
    });

    test("the planner holds the terminal tools, and a case keeps the real check of submit_plan", () => {
        const ids = agents.planner.tools.map((tool) => tool.id);

        expect(ids).toEqual(expect.arrayContaining(["submit_plan", "request_clarification", "report_blocker", "pubmed"]));
    });

    test("plans grades the last submitted plan", () => {
        const trial = (steps: unknown[]) => ({
            calls: [{ step: 0, tool: "submit_plan", input: { plan: { steps } }, refused: false }],
            asks: [],
            text: "",
            finishReason: "stop",
        });
        const grade = plans("a DE step", (steps) => steps.some((step) => step.agent === "bulk-transcriptomics-agent"));

        expect(grade(trial([{ id: "T1S1", agent: "bulk-transcriptomics-agent" }])).pass).toBe(true);
        expect(grade(trial([{ id: "T1S1", agent: "enrichment-agent" }])).pass).toBe(false);
    });
});

describe("the CLI host tools", () => {
    test("the agent holds them", () => {
        const ids = agent.tools.map((tool) => tool.id);
        expect(ids).toEqual(expect.arrayContaining(["run_inflexa", "list_launch_dir", "manage_inputs"]));
    });

    test("a gated run_inflexa command asks through the real approval of the tool, and a read-only one does not", async () => {
        const model = scriptedModel([
            callTools(toolCall("c1", "run_inflexa", { argv: ["refs", "list"] }), toolCall("c2", "run_inflexa", { argv: ["refs", "download", "GRCh38"] })),
            reply([text("Queued.")]),
        ]);
        const result = await runTrial(
            evalCase({
                tools: { run_inflexa: { ok: { status: "ran", exitCode: 0, stdout: "", stderr: "" } } },
                grade: asked("run_inflexa", ["refs", "download", "GRCh38"]),
            }),
            {
                agents,
                provider: model.provider,
                trialTimeoutMs: 10_000,
            },
        );
        expect(result).toMatchObject({ kind: "graded", pass: true });
        expect(result.kind === "graded" ? result.asks.map((ask) => ask.command) : []).toEqual(["inflexa refs download GRCh38"]);
    });

    test("a denied ask reaches the model as a denial", async () => {
        const model = scriptedModel([callTools(toolCall("c1", "manage_inputs", { action: "add", paths: ["notes.txt"] })), reply([text("Not added.")])]);
        const result = await runTrial(evalCase({ approve: "deny", tools: { manage_inputs: { ok: { status: "added", added: ["notes.txt"] } } } }), {
            agents,
            provider: model.provider,
            trialTimeoutMs: 10_000,
        });
        expect(result).toMatchObject({ kind: "graded", asks: [{ tool: "manage_inputs" }], finishReason: "denied" });
    });
});

describe("the cases", () => {
    test("have unique ids, and each script names a tool of the agent", () => {
        const ids = allCases.map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const c of allCases) {
            const own = agents[c.agent ?? "conversation"];
            const toolIds = new Set([...own.tools, ...(own.scriptTools ?? [])].map((tool) => tool.id));
            for (const id of Object.keys(c.tools ?? {})) expect(toolIds.has(id)).toBe(true);
        }
    });

    test("each held-out case paraphrases a dev case", () => {
        const dev = new Set(allCases.filter((c) => c.set === "dev").map((c) => c.id));
        for (const c of allCases.filter((c) => c.set === "held-out")) expect(dev.has(c.id.slice(0, -"-held-out".length))).toBe(true);
    });

    test("the prompt digest is stable for one composition", () => {
        expect(promptDigest(evalAgents())).toBe(promptDigest(agents));
    });
});
