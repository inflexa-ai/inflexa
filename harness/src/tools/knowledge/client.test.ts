import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { createHttpKnowledgeClient, type KnowledgeSituation } from "./client.js";
import { recommendAnswer, SNAPSHOT } from "./__fixtures__/fake-client.js";

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
            if (url.pathname === "/v1/check") return Response.json({ ok: true, snapshot: SNAPSHOT, violations: [], warnings: [] });
            if (url.pathname === "/v1/template/render") return Response.json({ error: "server", message: "boom" }, { status: 500 });
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
        const answer = await client().recommend(SITUATION);
        expect(answer.match).toBe("applicable");
        if (answer.match !== "applicable") return;
        expect(answer.claims[0]?.id).toBe("R-0001@e7d0");
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

    it("parses the check answer", async () => {
        const answer = await client().check(SITUATION, [{ step_type: "differential_expression", method: "DESeq2" }]);
        expect(answer).toMatchObject({ ok: true, snapshot: SNAPSHOT });
    });
});
