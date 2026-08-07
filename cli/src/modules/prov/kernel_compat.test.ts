import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyProvEvent, importPublicKeyJwk, verifyProvenance, PROV_UNIFY_OPTIONS, type ProvEvent } from "@inflexa-ai/prov-kernel";
import { cliProvDigest, provModel } from "./document.ts";

// The kernel-adoption continuity suite. The fixture was generated ONCE by the pre-kernel
// implementation (the cli's own dialect code, deleted in the same change): a small document driven
// through the historical builders with a frozen clock, its unified PROV-JSON, its first-flush chain
// hash, and an Ed25519 signature by a throwaway keypair. Existing user documents in local SQLite
// have exactly this shape, so the kernel — with the cli's injected digest — must verify it,
// rehydrate it, and dedupe re-emitted events into it.

type CompatFixture = {
    document: string;
    chainHash: string;
    signature: string;
    publicKeyJwk: Record<string, unknown>;
    events: ProvEvent[];
    qnames: { file: string; command: string; modelAgent: string };
};

// Safe: the fixture is a checked-in artifact this suite owns; its generator wrote exactly this shape.
const fixture = JSON.parse(readFileSync(join(import.meta.dir, "__fixtures__", "kernel_compat.json"), "utf-8")) as CompatFixture;

const subject = { analysisId: "compat-a1", name: "Compat Analysis", slug: "compat-analysis" };

/** The replay-stable subset: what a durable recovery re-emits. Lifecycle events are excluded — each genuine user action mints a fresh action activity by design. */
const executionEvents = fixture.events.filter((e) => e.type !== "analysis_created" && e.type !== "input_added" && e.type !== "input_removed");

/**
 * Re-key the serializer-assigned blank-node ids (`_:idN`) by their record content so two documents
 * compare on what the relations SAY, not on assignment order. A genuine duplicate blank relation
 * would collapse onto one key, so the count assertion keeps a duplication visible.
 */
function normalizeBlankIds(json: string): Record<string, Record<string, unknown>> {
    const parsed = JSON.parse(json) as Record<string, Record<string, unknown>>;
    for (const section of Object.values(parsed)) {
        const blanks = Object.keys(section).filter((k) => k.startsWith("_:"));
        for (const key of blanks) {
            const record = section[key];
            delete section[key];
            section[`_:${JSON.stringify(record)}`] = record;
        }
        expect(Object.keys(section).filter((k) => k.startsWith("_:")).length).toBe(blanks.length);
    }
    return parsed;
}

describe("kernel adoption — continuity against the pre-kernel fixture", () => {
    test("digest pin: the injected digest reproduces the historical Bun.hash form and its QNames", () => {
        // The literal pins the exact expression `Bun.hash(s).toString(36)` — a digest change breaks
        // this line before it can fork the QName space of existing documents.
        expect(cliProvDigest("continuity-pin")).toBe("21wl2iae09byl");
        expect(provModel.fileQName({ path: "runs/run-1/step-1/output/deg.csv", hash: "bbbb2222" })).toBe(fixture.qnames.file);
        expect(
            provModel.commandQName({ runId: "run-1", stepId: "step-1" }, [
                { path: "runs/run-1/step-1/scripts/deg.R", hash: "cccc3333" },
                { path: "runs/run-1/step-1/output/deg.csv", hash: "bbbb2222" },
            ]),
        ).toBe(fixture.qnames.command);
        expect(provModel.modelAgentQName("anthropic/claude-compat-1")).toBe(fixture.qnames.modelAgent);
    });

    test("kernel verifyProvenance accepts the pre-kernel signed document", async () => {
        const publicKey = (await importPublicKeyJwk(fixture.publicKeyJwk))._unsafeUnwrap();
        const result = await verifyProvenance(fixture.document, null, fixture.chainHash, fixture.signature, publicKey);
        expect(result).toEqual({ status: "valid" });
    });

    test("kernel loadDocument rehydrates the pre-kernel document", () => {
        const doc = provModel.loadDocument(subject, fixture.document);
        expect(doc.isOk()).toBe(true);
        const json = JSON.parse(doc._unsafeUnwrap().serialize("json")) as Record<string, Record<string, unknown>>;
        expect(Object.keys(json.entity!)).toContain("inflexa:analysis-compat-a1");
        expect(Object.keys(json.agent!)).toContain("inflexa:agent-user-alice_example_org");
    });

    test("re-applying the same execution events dedupes into the document", () => {
        const doc = provModel.loadDocument(subject, fixture.document)._unsafeUnwrap();
        for (const event of executionEvents) applyProvEvent(provModel, doc, event);
        const reserialized = doc.unified(PROV_UNIFY_OPTIONS).serialize("json");
        // Structural equality with the stored bytes proves everything at once: no duplicate
        // entities/agents/activities, no NEW blank-node relations from re-emission (the count
        // assertion inside the normalization), stable QNames, and the old empty-args
        // `inflexa:args: ""` surviving the merge (convergence, not corruption). Blank-node ids
        // (`_:idN`) are serializer-assigned sequence numbers, so they are compared by record
        // content, not by number.
        expect(normalizeBlankIds(reserialized)).toEqual(normalizeBlankIds(fixture.document));
    });

    test("user-agent identity: the kernel derives the historical QName from id = email", () => {
        const doc = provModel.freshDocument(subject);
        applyProvEvent(provModel, doc, {
            type: "analysis_created",
            analysisId: subject.analysisId,
            actor: { kind: "user", id: "alice@example.org", email: "alice@example.org" },
        });
        const json = JSON.parse(doc.serialize("json")) as Record<string, Record<string, unknown>>;
        expect(Object.keys(json.agent!)).toContain("inflexa:agent-user-alice_example_org");
    });

    test("accepted forward delta: a fresh kernel document omits inflexa:args when args is empty", () => {
        const doc = provModel.freshDocument(subject);
        for (const event of executionEvents) applyProvEvent(provModel, doc, event);
        const json = JSON.parse(doc.unified(PROV_UNIFY_OPTIONS).serialize("json")) as Record<string, Record<string, Record<string, unknown>>>;
        const cmd = json.activity![fixture.qnames.command]!;
        // The pre-kernel code wrote `inflexa:args: ""` for an empty argument vector; the kernel
        // omits the attribute. Existing documents keep the old value (previous test); new ones
        // never carry it.
        expect(cmd["inflexa:args"]).toBeUndefined();
        expect(JSON.parse(fixture.document).activity[fixture.qnames.command]["inflexa:args"]).toBe("");
    });
});
