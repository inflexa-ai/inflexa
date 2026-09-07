import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { createHttpKnowledgeClient, RecommendResponseSchema, type KnowledgeSituation } from "./client.js";
import { limitAnswer, notAssessedCheckAnswer, recommendAnswer, SNAPSHOT, substituteRenderAnswer, substitutionAnswer } from "./__fixtures__/fake-client.js";

const SITUATION: KnowledgeSituation = {
    question: "differential_expression",
    modality: "bulk_rna_seq",
    data_state: "counts",
    organism: "human",
    n_groups: 2,
    n_per_group_min: 6,
    n_per_group_max: 6,
    paired: false,
    batch: "none",
};

/** A stub of the service: one route per behavior the client must classify. */
function stubService() {
    return Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
            const url = new URL(request.url);
            if (request.headers.get("authorization") !== "Bearer secret") return Response.json({ error: "unauthorized" }, { status: 401 });
            if (url.pathname === "/v1/recommend") {
                const body = (await request.json()) as { situation: KnowledgeSituation };
                if (body.situation.n_groups === 99) {
                    return Response.json(
                        { error: "validation", message: "bad field", issues: [{ field: "n_groups", message: "too many", permitted: ["2"] }] },
                        { status: 400 },
                    );
                }
                return Response.json(recommendAnswer());
            }
            if (url.pathname === "/v1/check") return Response.json(notAssessedCheckAnswer());
            if (url.pathname === "/v1/template/render") {
                const body = (await request.json()) as { template: string };
                if (body.template === "tpl-x") return Response.json({ error: "server", message: "boom" }, { status: 500 });
                return Response.json(substituteRenderAnswer());
            }
            return Response.json({ error: "not_found" }, { status: 404 });
        },
    });
}

describe("createHttpKnowledgeClient", () => {
    let server: ReturnType<typeof stubService>;
    beforeAll(() => {
        server = stubService();
    });
    afterAll(() => {
        server.stop(true);
    });

    function client(apiKey = "secret") {
        return createHttpKnowledgeClient({ baseUrl: `http://127.0.0.1:${server.port}/`, apiKey, maxRetries: 0, timeoutMs: 5_000 });
    }

    it("posts the situation with the bearer key and parses the answer", async () => {
        const answer = await client().recommend({ ...SITUATION, import_state: "unknown", classifier: false });
        expect(answer.match).toBe("applicable");
        if (answer.match !== "applicable") return;
        expect(answer.claims.map((view) => view.id)).toContain("R-0001@e7d0");
        const de = answer.procedure.find((step) => step.step === "differential_expression")!;
        expect(de.alternatives?.[0]?.rules).toEqual(["R-0001@e7d0"]);
        const adjust = answer.procedure.find((step) => step.step === "multiple_testing")!;
        expect(adjust.conflicts).toEqual([
            {
                parameter: "independent_filtering",
                entries: [
                    { rule: "R-0010@2b3c", value: true },
                    { rule: "R-0166@4d5e", value: false },
                ],
            },
        ]);
    });

    it("parses a substitution and a language limit on a step", () => {
        const substituted = RecommendResponseSchema.parse(substitutionAnswer());
        const enrichment = substituted.procedure.find((step) => step.step === "enrichment")!;
        expect(enrichment.substitution).toEqual({
            for: "M-0034",
            label: "GSVA per-sample pathway scores with limma on the scores",
            template: "tpl-decoupler-scores@1.0.0",
        });
        const limited = RecommendResponseSchema.parse(limitAnswer());
        const de = limited.procedure.find((step) => step.step === "differential_expression")!;
        expect(de.limit).toEqual({
            requested_language: "python",
            reason: "no Python template of M-0001 honors pairing",
            skipped: [{ template: "tpl-pydeseq2-two-group@1.0.0", missing: ["pairing"] }],
        });
        expect(
            RecommendResponseSchema.safeParse({ ...limitAnswer(), procedure: [{ ...de, limit: { ...de.limit, requested_language: "julia" } }] }).success,
        ).toBe(false);
    });

    it("parses the render answer with the method and the method of record of a substitute", async () => {
        const answer = await client().render("tpl-decoupler-scores@1.0.0", {});
        expect("ok" in answer && answer.ok).toBe(true);
        if (!("ok" in answer)) return;
        expect(answer.template.method).toEqual({ id: "M-0059", label: "decoupler ulm per-sample pathway scores with a two-sample t-test on the scores" });
        expect(answer.template.substitute_for).toEqual({ id: "M-0034", label: "GSVA per-sample pathway scores with limma on the scores" });
        expect(answer.template.language).toBe("python");
    });

    it("classifies a 400 as rejected with the field and the permitted values", async () => {
        const answer = await client().recommend({ ...SITUATION, n_groups: 99 });
        expect(answer).toEqual({ match: "rejected", message: "bad field", issues: [{ field: "n_groups", message: "too many", permitted: ["2"] }] });
    });

    it("classifies a 401, a 500, and an unreachable host as unavailable", async () => {
        const unauthorized = await client("wrong").check(SITUATION, [{ step_type: "differential_expression", method: "DESeq2" }]);
        expect(unauthorized.match).toBe("unavailable");
        const failed = await client().render("tpl-x", {});
        expect(failed.match).toBe("unavailable");
        const dead = createHttpKnowledgeClient({ baseUrl: "http://127.0.0.1:9", apiKey: "k", maxRetries: 0, timeoutMs: 2_000 });
        const answer = await dead.recommend(SITUATION);
        expect(answer.match).toBe("unavailable");
    });

    it("parses the check answer with the steps it did not assess", async () => {
        const answer = await client().check(SITUATION, [
            { step_type: "differential_expression", method: "DESeq2", method_id: "M-0001" },
            { step_type: "shrink_lfc", method: "apeglm" },
        ]);
        expect(answer).toMatchObject({ ok: true, snapshot: SNAPSHOT });
        if (!("ok" in answer)) return;
        expect(answer.not_assessed).toEqual([
            {
                step_type: "shrink_lfc",
                reason: "no_rule",
                message: "No rule of the snapshot covers shrink_lfc in this situation. The check did not assess it.",
            },
        ]);
    });
});
