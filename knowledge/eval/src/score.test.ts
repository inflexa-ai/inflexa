import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { KnowledgeCall, RunRecord } from "./record.js";
import { classifyStep, resolveAgainstSnapshot, scoreRun, type PlanStepLike } from "./score.js";
import { TaskSchema, type Task } from "./tasks.js";

const DIGEST = "sha256:90c687582244894c67c212e63855415984027bcd54c896821c4e065cf8b5467a";
const OTHER_DIGEST = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
/** A closed port: every fetch fails, as with an absent service. */
const DOWN_URL = "http://127.0.0.1:1";
const KNOWN_DOI = "10.1186/s13059-014-0550-8";
const UNKNOWN_DOI = "10.9999/not-a-source";

const TASK: Task = TaskSchema.parse({
    id: "two-group-n6",
    pattern: "two_group_n6",
    question: "Which genes differ between treated and control?",
    tissue: "liver",
    condition: "treated vs control",
    experimental_design: "two groups of six",
    count_source: "salmon",
    concerns: [],
    reference: "DESeq2 on the raw counts.",
    must_match: [],
    must_not_match: [],
});

function recommendCall(seq: number, digest: string, claims: readonly string[], flagRules: readonly string[] = []): KnowledgeCall {
    return {
        seq,
        op: "recommend",
        request: { situation: { question: "full_plan" } },
        response: {
            match: "applicable",
            snapshot: { date: "2026-09-06", digest },
            procedure: [{ step: "count_model", method: { id: "M-0001" }, rules: claims.slice(0, 1), flags: flagRules.slice(0, 1).map((rule) => ({ rule, severity: "flag", message: "no inference" })) }],
            claims: claims.map((id) => ({ id })),
            flags: flagRules.slice(1).map((rule) => ({ rule, severity: "flag", message: "no inference" })),
            dropped: [],
            uncovered: [],
        },
        responseChars: 100,
        elapsedMs: 5,
    };
}

function methodStep(id: string, grounding: PlanStepLike["grounding"], agent = "bulk-transcriptomics-agent"): PlanStepLike {
    return { id, name: id, agent, description: `the ${id} step`, ...(grounding ? { grounding } : {}) };
}

function makeRecord(steps: readonly PlanStepLike[], options: { readonly digest?: string; readonly knowledgeCalls?: readonly KnowledgeCall[]; readonly narrative?: string } = {}): RunRecord {
    return {
        campaign: "probe",
        condition: options.digest ? "with" : "without",
        model: "model",
        task: TASK.id,
        run: 1,
        seed: 1,
        split: "development",
        startedAt: "2026-09-07T00:00:00.000Z",
        elapsedMs: 1200,
        outcome: "plan_submitted",
        plan: { title: "A plan", analytical_narrative: options.narrative ?? "", steps },
        usage: { inputTokens: 10, outputTokens: 5 },
        toolCalls: [],
        knowledgeCalls: options.knowledgeCalls ?? [],
        ...(options.digest ? { snapshot: { date: "2026-09-06", digest: options.digest } } : {}),
        connection: { provider: "openai-compatible" },
    };
}

/** A record written before the recording client: no knowledgeCalls field at all. */
function oldRecord(steps: readonly PlanStepLike[], digest: string): RunRecord {
    const { knowledgeCalls: _calls, ...rest } = makeRecord(steps, { digest });
    return rest as RunRecord;
}

/** A service that serves one digest, holds the listed claims, and knows the listed DOIs. */
function fakeService(digest: string, claims: readonly string[], dois: readonly string[] = [KNOWN_DOI]) {
    const held = new Set(claims);
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/v1/snapshot") return Response.json({ date: "2026-09-06", digest, schema_version: "0.1.0" });
            const claim = path.match(/^\/v1\/claims\/(.+)$/);
            if (claim) {
                const id = decodeURIComponent(claim[1]!);
                return held.has(id) ? Response.json({ id }) : Response.json({ error: "not_found", message: "no such claim in this snapshot" }, { status: 404 });
            }
            if (path === "/v1/sources") return Response.json(dois.map((doi, index) => ({ id: `S-${index + 1}`, doi, title: "a source", year: 2014 })));
            return Response.json({ error: "not_found" }, { status: 404 });
        },
    });
    return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

const EVIDENCE = [recommendCall(1, DIGEST, ["R-0001@abcd", "R-0026@ef01", "R-0003@0001"], ["R-0003@0001"])];

describe("scoreRun", () => {
    it("scores a flagged step with an empty claim list as ungrounded, thus 0", () => {
        const record = makeRecord([methodStep("s1", { status: "flagged", snapshot: DIGEST, claims: [] })], { digest: DIGEST, knowledgeCalls: EVIDENCE });
        const score = scoreRun(record, TASK);
        expect(score.method_steps).toBe(1);
        expect(score.flagged_steps).toBe(1);
        expect(score.flagged_applicable_steps).toBe(0);
        expect(score.ungrounded_steps).toBe(1);
        expect(score.grounding_share).toBe(0);
        expect(score.claims).toEqual([]);
    });

    it("counts a grounded step applicable only when every claim is in a recorded response on the digest of the record", () => {
        const applicable = methodStep("s1", { status: "grounded", snapshot: DIGEST, claims: ["R-0001@abcd", "R-0026@ef01"] });
        const flagged = methodStep("s2", { status: "flagged", snapshot: DIGEST, claims: ["R-0003@0001"] });
        const flaggedWithoutFlagRule = methodStep("s3", { status: "flagged", snapshot: DIGEST, claims: ["R-0001@abcd"] });
        const unpinned = methodStep("s4", { status: "grounded", snapshot: OTHER_DIGEST, claims: ["R-0001@abcd"] });
        const unrecorded = methodStep("s5", { status: "grounded", snapshot: DIGEST, claims: ["R-0001@abcd", "R-0099@ffff"] });
        const plain = methodStep("s6", undefined);
        const record = makeRecord([applicable, flagged, flaggedWithoutFlagRule, unpinned, unrecorded, plain], { digest: DIGEST, knowledgeCalls: EVIDENCE });
        const score = scoreRun(record, TASK);
        expect(score.evidence_responses).toBe(1);
        expect(score.grounded_applicable_steps).toBe(1);
        expect(score.flagged_applicable_steps).toBe(1);
        expect(score.inapplicable_steps).toBe(2);
        expect(score.unresolved_steps).toBe(1);
        expect(score.fabricated_steps).toBe(0);
        expect(score.ungrounded_steps).toBe(1);
        expect(score.grounding_share).toBeCloseTo(2 / 6);
        expect(score.claims_applicable).toBe(3);
        expect(score.claims_unresolved).toBe(1);
        expect(score.claim_states["R-0099@ffff"]).toBe("unresolved");
        expect(score.resolution_snapshot_mismatch).toBe(false);
    });

    it("ignores a recorded response on another digest and an unavailable answer", () => {
        const step = methodStep("s1", { status: "grounded", snapshot: DIGEST, claims: ["R-0001@abcd"] });
        const calls: KnowledgeCall[] = [
            recommendCall(1, OTHER_DIGEST, ["R-0001@abcd"]),
            { seq: 2, op: "recommend", request: {}, response: { match: "unavailable", reason: "timeout" }, responseChars: 30, elapsedMs: 1 },
        ];
        const score = scoreRun(makeRecord([step], { digest: DIGEST, knowledgeCalls: calls }), TASK);
        expect(score.evidence_responses).toBe(0);
        expect(score.claims_unresolved).toBe(1);
        expect(score.unresolved_steps).toBe(1);
        expect(score.grounding_share).toBe(0);
    });

    it("pins the run only when every method step pins the digest of the record", () => {
        const pinned = methodStep("s1", { status: "grounded", snapshot: DIGEST, claims: ["R-0001@abcd"] });
        const stale = methodStep("s2", { status: "grounded", snapshot: OTHER_DIGEST, claims: ["R-0001@abcd"] });
        const bare = methodStep("s3", { status: "grounded", claims: ["R-0001@abcd"] });
        const one = scoreRun(makeRecord([pinned, stale, bare], { digest: DIGEST, knowledgeCalls: EVIDENCE }), TASK);
        expect(one.snapshot_pinned_steps).toBe(1);
        expect(one.snapshot_pinned).toBe(false);
        const all = scoreRun(makeRecord([pinned, pinned, pinned], { digest: DIGEST, knowledgeCalls: EVIDENCE }), TASK);
        expect(all.snapshot_pinned_steps).toBe(3);
        expect(all.snapshot_pinned).toBe(true);
        const none = scoreRun(makeRecord([], { digest: DIGEST }), TASK);
        expect(none.snapshot_pinned).toBe(false);
        const without = scoreRun(makeRecord([pinned]), TASK);
        expect(without.snapshot_digest).toBeUndefined();
        expect(without.snapshot_pinned).toBe(false);
        expect(without.claims_unresolved).toBe(1);
    });

    it("leaves a method step outside a method agent out of the denominator", () => {
        const report = methodStep("s1", { status: "grounded", snapshot: DIGEST, claims: ["R-0001@abcd"] }, "report-agent");
        const score = scoreRun(makeRecord([report], { digest: DIGEST, knowledgeCalls: EVIDENCE }), TASK);
        expect(score.steps).toBe(1);
        expect(score.method_steps).toBe(0);
        expect(score.grounding_share).toBe(0);
        expect(score.claims).toEqual(["R-0001@abcd"]);
        expect(score.claims_applicable).toBe(1);
    });
});

describe("classifyStep", () => {
    const states = { "R-0001@abcd": "applicable", "R-0002@0000": "inapplicable", "R-0003@0000": "unresolved", "R-9999@0000": "fabricated" } as const;

    it("takes the worst claim state first, then the pin, then the flag rule", () => {
        expect(classifyStep({ status: "grounded", pinned: true, claims: ["R-0001@abcd", "R-9999@0000"], flag_rule: false }, states)).toBe("fabricated");
        expect(classifyStep({ status: "grounded", pinned: true, claims: ["R-0001@abcd", "R-0003@0000"], flag_rule: false }, states)).toBe("unresolved");
        expect(classifyStep({ status: "grounded", pinned: true, claims: ["R-0001@abcd", "R-0002@0000"], flag_rule: false }, states)).toBe("inapplicable");
        expect(classifyStep({ status: "grounded", pinned: false, claims: ["R-0001@abcd"], flag_rule: false }, states)).toBe("inapplicable");
        expect(classifyStep({ status: "flagged", pinned: true, claims: ["R-0001@abcd"], flag_rule: false }, states)).toBe("inapplicable");
        expect(classifyStep({ status: "flagged", pinned: true, claims: ["R-0001@abcd"], flag_rule: true }, states)).toBe("flagged_applicable");
        expect(classifyStep({ status: "grounded", pinned: true, claims: ["R-0001@abcd"], flag_rule: false }, states)).toBe("grounded_applicable");
        expect(classifyStep({ status: "flagged", pinned: true, claims: [], flag_rule: true }, states)).toBe("ungrounded");
        expect(classifyStep({ status: "ungrounded", pinned: true, claims: ["R-0001@abcd"], flag_rule: false }, states)).toBe("ungrounded");
    });
});

describe("resolveAgainstSnapshot", () => {
    const sameDigest = fakeService(DIGEST, ["R-0001@abcd", "R-0026@ef01", "R-0003@0001", "R-0050@1111"]);
    const otherDigest = fakeService(OTHER_DIGEST, ["R-0001@abcd", "R-9999@0000"]);
    afterAll(() => {
        sameDigest.stop();
        otherDigest.stop();
    });

    it("marks a claim the snapshot holds but no recorded response returned as inapplicable", async () => {
        const step = methodStep("s1", { status: "grounded", snapshot: DIGEST, claims: ["R-0001@abcd", "R-0050@1111"] });
        const score = await resolveAgainstSnapshot(scoreRun(makeRecord([step], { digest: DIGEST, knowledgeCalls: EVIDENCE }), TASK), sameDigest.url, "");
        expect(score.resolution_snapshot_mismatch).toBe(false);
        expect(score.claim_states["R-0050@1111"]).toBe("inapplicable");
        expect(score.claims_applicable).toBe(1);
        expect(score.claims_inapplicable).toBe(1);
        expect(score.claims_unresolved).toBe(0);
        expect(score.claims_fabricated).toBe(0);
        expect(score.claims_resolving).toBe(2);
        expect(score.inapplicable_steps).toBe(1);
        expect(score.grounding_share).toBe(0);
    });

    it("marks a claim absent from the recorded responses and from the snapshot as fabricated", async () => {
        const step = methodStep("s1", { status: "grounded", snapshot: DIGEST, claims: ["R-9999@0000"] });
        const score = await resolveAgainstSnapshot(scoreRun(makeRecord([step], { digest: DIGEST, knowledgeCalls: EVIDENCE }), TASK), sameDigest.url, "");
        expect(score.claim_states["R-9999@0000"]).toBe("fabricated");
        expect(score.claims_fabricated).toBe(1);
        expect(score.claims_unresolved).toBe(0);
        expect(score.fabricated_steps).toBe(1);
        expect(score.grounding_share).toBe(0);
    });

    it("leaves every claim of a record without knowledgeCalls unresolved, never fabricated", async () => {
        const step = methodStep("s1", { status: "grounded", snapshot: DIGEST, claims: ["R-9999@0000", "R-0001@abcd"] });
        const before = scoreRun(oldRecord([step], DIGEST), TASK);
        expect(before.evidence_responses).toBe(0);
        expect(before.claims_unresolved).toBe(2);
        const score = await resolveAgainstSnapshot(before, sameDigest.url, "");
        expect(score.resolution_snapshot_mismatch).toBe(false);
        expect(score.claims_unresolved).toBe(2);
        expect(score.claims_fabricated).toBe(0);
        expect(score.claims_inapplicable).toBe(0);
        expect(score.unresolved_steps).toBe(1);
        expect(score.grounding_share).toBe(0);
    });

    it("resolves nothing against a service that serves another digest", async () => {
        const step = methodStep("s1", { status: "grounded", snapshot: DIGEST, claims: ["R-0001@abcd", "R-9999@0000"] });
        const score = await resolveAgainstSnapshot(scoreRun(makeRecord([step], { digest: DIGEST, knowledgeCalls: EVIDENCE, narrative: `See ${KNOWN_DOI}.` }), TASK), otherDigest.url, "");
        expect(score.resolution_snapshot_mismatch).toBe(true);
        expect(score.claims_applicable).toBe(1);
        expect(score.claims_unresolved).toBe(1);
        expect(score.claims_fabricated).toBe(0);
        expect(score.claims_resolving).toBeUndefined();
        expect(score.dois_in_snapshot).toBeUndefined();
        expect(score.fabricated_references).toBeUndefined();
    });

    it("resolves nothing when the service is absent", async () => {
        const step = methodStep("s1", { status: "grounded", snapshot: DIGEST, claims: ["R-9999@0000"] });
        const score = await resolveAgainstSnapshot(scoreRun(makeRecord([step], { digest: DIGEST, knowledgeCalls: EVIDENCE }), TASK), DOWN_URL, "");
        expect(score.resolution_snapshot_mismatch).toBe(false);
        expect(score.claims_unresolved).toBe(1);
        expect(score.claims_fabricated).toBe(0);
        expect(score.dois_in_snapshot).toBeUndefined();
    });

    it("separates the DOIs of the plan into known and fabricated references", async () => {
        const narrative = `Love et al. ${KNOWN_DOI}. Also ${UNKNOWN_DOI}.`;
        const withArm = await resolveAgainstSnapshot(scoreRun(makeRecord([], { digest: DIGEST, narrative }), TASK), sameDigest.url, "");
        expect(withArm.dois_in_plan).toEqual([KNOWN_DOI, UNKNOWN_DOI]);
        expect(withArm.dois_in_snapshot).toBe(1);
        expect(withArm.fabricated_references).toEqual([UNKNOWN_DOI]);
        // The without arm has no digest to match, and a DOI is not versioned by a snapshot.
        const withoutArm = await resolveAgainstSnapshot(scoreRun(makeRecord([], { narrative }), TASK), otherDigest.url, "");
        expect(withoutArm.resolution_snapshot_mismatch).toBe(false);
        expect(withoutArm.fabricated_references).toEqual([UNKNOWN_DOI]);
    });
});

describe("the synthetic record of the review", () => {
    const steps = [
        methodStep("s1", { status: "flagged", snapshot: DIGEST, claims: [] }),
        methodStep("s2", { status: "grounded", snapshot: DIGEST, claims: ["R-9999@0000"] }),
    ];
    const record = makeRecord(steps, { digest: DIGEST, knowledgeCalls: EVIDENCE });
    let sameDigest: ReturnType<typeof fakeService>;
    let otherDigest: ReturnType<typeof fakeService>;
    beforeAll(() => {
        sameDigest = fakeService(DIGEST, ["R-0001@abcd"]);
        otherDigest = fakeService(OTHER_DIGEST, ["R-0001@abcd"]);
    });
    afterAll(() => {
        sameDigest.stop();
        otherDigest.stop();
    });

    it("scores grounding_share 0 before any resolution", () => {
        const score = scoreRun(record, TASK);
        expect(score.method_steps).toBe(2);
        expect(score.grounding_share).toBe(0);
        expect(score.ungrounded_steps).toBe(1);
        expect(score.unresolved_steps).toBe(1);
        expect(score.claims_unresolved).toBe(1);
        expect(score.claims_fabricated).toBe(0);
    });

    it("scores claims_fabricated 1 with the service on the same digest", async () => {
        const score = await resolveAgainstSnapshot(scoreRun(record, TASK), sameDigest.url, "");
        expect(score.grounding_share).toBe(0);
        expect(score.claims_fabricated).toBe(1);
        expect(score.claims_unresolved).toBe(0);
        expect(score.fabricated_steps).toBe(1);
    });

    it("scores claims_unresolved 1 when the service is down", async () => {
        const score = await resolveAgainstSnapshot(scoreRun(record, TASK), DOWN_URL, "");
        expect(score.grounding_share).toBe(0);
        expect(score.claims_unresolved).toBe(1);
        expect(score.claims_fabricated).toBe(0);
    });

    it("scores claims_unresolved 1 when the service serves another digest", async () => {
        const score = await resolveAgainstSnapshot(scoreRun(record, TASK), otherDigest.url, "");
        expect(score.grounding_share).toBe(0);
        expect(score.resolution_snapshot_mismatch).toBe(true);
        expect(score.claims_unresolved).toBe(1);
        expect(score.claims_fabricated).toBe(0);
    });
});
