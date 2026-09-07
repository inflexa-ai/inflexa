import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

import type { KnowledgeClient, KnowledgeSituation } from "@inflexa-ai/harness";

import { buildManifest, parseArm, promptDigest } from "./freeze.js";
import { recordingKnowledgeClient, trimResponse } from "./record-client.js";
import { laneDifferences, splitOf, type KnowledgeCall } from "./record.js";

const SITUATION: KnowledgeSituation = {
    question: "full_plan",
    modality: "bulk_rna_seq",
    data_state: "counts",
    count_source: "salmon",
    organism: "human",
    n_groups: 2,
    n_per_group_min: 6,
    n_per_group_max: 6,
    paired: false,
    batch: "none",
};

const SNAPSHOT = { date: "2026-09-06", digest: "sha256:90c6" };

const RECOMMEND = {
    match: "applicable",
    snapshot: SNAPSHOT,
    situation: { ...SITUATION, inferential_method: "M-0001" },
    procedure: [
        {
            step: "count_model",
            method: { id: "M-0001", label: "DESeq2 Wald test" },
            template: "tpl-deseq2-two-group",
            rules: ["R-0001@abcd", "R-0026@ef01"],
            flags: [],
            parameters: [{ name: "min_count", value: 10, default_source: "S-0001" }],
            alternatives: [{ method: "M-0002", label: "edgeR QL", when: "the counts are integer", rules: ["R-0002@1234"] }],
        },
        { step: "multiple_testing", rules: ["R-0030@9999"], flags: [{ rule: "R-0030@9999", severity: "warn", message: "state the alpha" }] },
    ],
    uncovered: ["report"],
    dropped: ["shrink_lfc"],
    flags: [{ rule: "R-0100@0000", severity: "info", message: "a note" }],
    claims: [
        { id: "R-0001@abcd", statement: "Use DESeq2 on raw counts.", strength: "strong", evidence: [{ doi: "10.1/x", title: "Love 2014", year: 2014, direction: "supports" }] },
        { id: "R-0026@ef01", statement: "Name the size factors.", strength: "moderate", evidence: [] },
    ],
    nearest: [{ claim: "R-0003@0001", title: "no replicates", failed: ["n_per_group_min"] }],
};

const CHECK = {
    ok: false,
    snapshot: SNAPSHOT,
    violations: [{ step_type: "count_model", severity: "error", rule: "R-0001@abcd", message: "not DESeq2", permitted: ["M-0001"] }],
    warnings: [],
    not_assessed: [{ step_type: "report", reason: "no_rule", message: "no rule covers report" }],
};

const SCRIPT = "library(DESeq2)\nprint('hello')\n";

const RENDER = {
    ok: true,
    snapshot: SNAPSHOT,
    template: { id: "tpl-deseq2-two-group", version: "1.1.0", label: "DESeq2 two group", method: "M-0001", language: "R" },
    script: SCRIPT,
    slots: [{ name: "min_count", value: 10, source: "R-0001@abcd", adaptable: true, lines: [12] }],
    environment: { match: "exact" },
    syntax: { status: "ok" },
    outputs: [{ name: "results", path: "results.csv" }],
    decision_record: { schema: "inflexa.decision_record/0.1", template: { id: "tpl-deseq2-two-group" }, citations: [] },
};

function fakeClient(answers: { recommend?: unknown; check?: unknown; render?: unknown }): KnowledgeClient & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        recommend: async () => {
            calls.push("recommend");
            return answers.recommend;
        },
        check: async () => {
            calls.push("check");
            return answers.check;
        },
        render: async () => {
            calls.push("render");
            return answers.render;
        },
    } as unknown as KnowledgeClient & { calls: string[] };
}

describe("recordingKnowledgeClient", () => {
    it("forwards each answer unchanged and records the request, the trimmed response, the seq, the size, and the time", async () => {
        const inner = fakeClient({ recommend: RECOMMEND, check: CHECK, render: RENDER });
        const sink: KnowledgeCall[] = [];
        const client = recordingKnowledgeClient(inner, sink);

        const recommend = await client.recommend(SITUATION, "concise", { language: "R" });
        const steps = [{ step_type: "count_model", method: "DESeq2", method_id: "M-0001" }];
        const check = await client.check(SITUATION, steps as never);
        const farm = [{ name: "DESeq2", version: "1.48.0" }];
        const render = await client.render("tpl-deseq2-two-group", { min_count: 10 }, farm);

        expect(recommend).toBe(RECOMMEND as never);
        expect(check).toBe(CHECK as never);
        expect(render).toBe(RENDER as never);
        expect(inner.calls).toEqual(["recommend", "check", "render"]);

        expect(sink.map((call) => call.seq)).toEqual([1, 2, 3]);
        expect(sink.map((call) => call.op)).toEqual(["recommend", "check", "render"]);
        for (const call of sink) {
            expect(typeof call.elapsedMs).toBe("number");
            expect(call.elapsedMs).toBeGreaterThanOrEqual(0);
        }

        expect(sink[0]?.request).toEqual({ situation: SITUATION, response_format: "concise", preferences: { language: "R" } });
        expect(sink[0]?.responseChars).toBe(JSON.stringify(RECOMMEND).length);
        expect(sink[0]?.response).toEqual({
            match: "applicable",
            snapshot: SNAPSHOT,
            situation: { ...SITUATION, inferential_method: "M-0001" },
            procedure: [
                { step: "count_model", method: { id: "M-0001" }, template: "tpl-deseq2-two-group", rules: ["R-0001@abcd", "R-0026@ef01"], flags: [] },
                { step: "multiple_testing", rules: ["R-0030@9999"], flags: [{ rule: "R-0030@9999", severity: "warn", message: "state the alpha" }] },
            ],
            claims: [{ id: "R-0001@abcd" }, { id: "R-0026@ef01" }],
            flags: [{ rule: "R-0100@0000", severity: "info", message: "a note" }],
            dropped: ["shrink_lfc"],
            uncovered: ["report"],
        });

        expect(sink[1]?.request).toEqual({ situation: SITUATION, steps });
        expect(sink[1]?.response).toEqual(CHECK);
        expect(sink[1]?.responseChars).toBe(JSON.stringify(CHECK).length);

        expect(sink[2]?.request).toEqual({ template: "tpl-deseq2-two-group", slots: { min_count: 10 }, farm });
        expect(sink[2]?.responseChars).toBe(JSON.stringify(RENDER).length);
        expect(sink[2]?.response).toEqual({
            snapshot: SNAPSHOT,
            template: RENDER.template,
            slots: RENDER.slots,
            decision_record: RENDER.decision_record,
            script_sha256: createHash("sha256").update(SCRIPT).digest("hex"),
        });
        expect(JSON.stringify(sink[2]?.response)).not.toContain("library(DESeq2)");
    });

    it("records an unavailable answer and a rejected answer as they are", async () => {
        const unavailable = { match: "unavailable", reason: "the service did not answer after 2 retries" };
        const rejected = { match: "rejected", message: "the field organism is not permitted", issues: [{ field: "organism", permitted: ["human", "mouse", "other"] }] };
        const inner = fakeClient({ recommend: unavailable, check: rejected });
        const sink: KnowledgeCall[] = [];
        const client = recordingKnowledgeClient(inner, sink);

        expect(await client.recommend(SITUATION)).toBe(unavailable as never);
        expect(await client.check(SITUATION, [])).toBe(rejected as never);
        expect(sink[0]).toMatchObject({ seq: 1, op: "recommend", request: { situation: SITUATION }, response: unavailable, responseChars: JSON.stringify(unavailable).length });
        expect(sink[1]).toMatchObject({ seq: 2, op: "check", response: rejected });
    });

    it("records a thrown call and throws it again", async () => {
        const inner = {
            recommend: async () => {
                throw new Error("socket hang up");
            },
            check: async () => CHECK,
            render: async () => RENDER,
        } as unknown as KnowledgeClient;
        const sink: KnowledgeCall[] = [];
        const client = recordingKnowledgeClient(inner, sink);
        await expect(client.recommend(SITUATION)).rejects.toThrow("socket hang up");
        expect(sink[0]).toMatchObject({ seq: 1, op: "recommend", response: { thrown: "socket hang up" }, responseChars: 0 });
    });

    it("keeps a value that is not an object as it is", () => {
        expect(trimResponse("recommend", undefined)).toBeUndefined();
        expect(trimResponse("check", "text")).toBe("text");
    });
});

const CORPUS = { date: "2026-09-06", digest: "sha256:abc", schema_version: "0.1.0", tool_definition_hash: "sha256:def" };
const RUNTIME = { harness_commit: "1111", knowledge_commit: "2222", bun: "1.3.10" };
const JUDGE = { provider: "cliproxy" as const, model: "claude-opus-5", tag: "opus", prompt_digest: promptDigest() };
const OPENROUTER = { baseUrl: "https://openrouter.ai/api/v1", providerOrder: ["wafer", "io-net/fp8"], requestTimeoutMs: 1_500_000 };

const MANIFEST = buildManifest({
    campaign: "probe",
    taskIds: ["a", "b", "c"],
    tasksPath: "eval/tasks/tasks.yaml",
    tasksDigest: "sha256:tasks",
    tasksDev: ["a", "b"],
    tasksHeld: ["c"],
    seedsDev: [1],
    seedsHeld: [7],
    corpus: CORPUS,
    runtime: RUNTIME,
    arms: [
        parseArm("economical_with=with:economical:openai-compatible:z-ai/glm-5.3-flash", OPENROUTER),
        parseArm("economical_without=without:economical:openai-compatible:z-ai/glm-5.3-flash", OPENROUTER),
        parseArm("frontier_with=with:frontier:cliproxy:claude-opus-5"),
        parseArm("frontier_without=without:frontier:cliproxy:claude-opus-5"),
    ],
    judge: JUDGE,
    margin: 5,
    runsPerTask: 3,
    frozenAt: "2026-09-07T00:00:00.000Z",
});

const FRONTIER = { provider: "cliproxy" as const, model: "claude-opus-5" };
const ECONOMICAL = { provider: "openai-compatible" as const, model: "z-ai/glm-5.3-flash", apiKeyEnv: "OPENROUTER_API_KEY", ...OPENROUTER };
const INSIDE = { condition: "with" as const, connection: FRONTIER, seed: 1, snapshotDigest: "sha256:abc", taskIds: ["a", "b"], tasksDigest: "sha256:tasks" };

describe("the manifest gate of a lane", () => {
    it("accepts a lane inside the manifest, in both arms and both splits", () => {
        expect(laneDifferences(MANIFEST, INSIDE)).toEqual([]);
        expect(laneDifferences(MANIFEST, { ...INSIDE, condition: "without", connection: ECONOMICAL, seed: 7, taskIds: ["c"] })).toEqual([]);
        expect(laneDifferences(MANIFEST, { ...INSIDE, condition: "without" })).toEqual([]);
    });

    it("names each field outside the manifest", () => {
        expect(laneDifferences(undefined, INSIDE)).toEqual(["the campaign has no manifest"]);
        expect(laneDifferences(MANIFEST, { ...INSIDE, connection: { provider: "cliproxy", model: "other-model" } })).toEqual(["the arm with cliproxy:other-model is not a frozen arm"]);
        expect(laneDifferences(MANIFEST, { ...INSIDE, connection: { ...FRONTIER, provider: "anthropic" } })).toEqual(["the arm frontier_with provider anthropic is not the frozen cliproxy"]);
        expect(laneDifferences(MANIFEST, { ...INSIDE, condition: "with", connection: { ...ECONOMICAL, providerOrder: ["wafer"], requestTimeoutMs: 1000 } })).toEqual([
            "the arm economical_with providerOrder wafer is not the frozen wafer,io-net/fp8",
            "the arm economical_with requestTimeoutMs 1000 is not the frozen 1500000",
        ]);
        expect(laneDifferences(MANIFEST, { ...INSIDE, seed: 3 })).toEqual(["the seed 3 is not a frozen seed (development [1], held out [7])"]);
        expect(laneDifferences(MANIFEST, { ...INSIDE, snapshotDigest: "sha256:other" })).toEqual(["the served snapshot sha256:other is not the frozen sha256:abc"]);
        expect(laneDifferences(MANIFEST, { ...INSIDE, taskIds: ["a", "zzz"] })).toEqual(["the task zzz is not in the frozen task set"]);
        expect(laneDifferences(MANIFEST, { ...INSIDE, tasksDigest: "sha256:edited" })).toEqual(["the task set digest sha256:edited is not the frozen sha256:tasks"]);
        expect(laneDifferences(MANIFEST, { ...INSIDE, seed: 7 })).toEqual(["the task a, b is not in the held_out split of the seed 7"]);
        expect(laneDifferences(MANIFEST, { ...INSIDE, taskIds: ["a", "c"] })).toEqual(["the task c is not in the development split of the seed 1"]);
        expect(laneDifferences(MANIFEST, { ...INSIDE, connection: { provider: "cliproxy", model: "other-model" }, seed: 3, snapshotDigest: "sha256:other" }).length).toBe(3);
    });

    it("gives the split of a task under a seed, and none across the splits", () => {
        expect(splitOf(MANIFEST, "a", 1)).toBe("development");
        expect(splitOf(MANIFEST, "c", 7)).toBe("held_out");
        expect(splitOf(MANIFEST, "a", 7)).toBe("none");
        expect(splitOf(MANIFEST, "c", 1)).toBe("none");
        expect(splitOf(MANIFEST, "zzz", 1)).toBe("none");
        expect(splitOf(undefined, "a", 1)).toBe("none");
    });
});
