import { beforeEach, describe, expect, test } from "bun:test";
import { ProvDocument } from "@inflexa-ai/tsprov";

import { freshDb } from "../../test_support/db.ts";
import { insertAnchor, insertAnalysis } from "../../db/primary_mutation.ts";
import { getAnalysisProvenance } from "../../db/primary_query.ts";
import { Bus } from "../../lib/bus.ts";
import { asStr256 } from "../../lib/types.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { ProvActor, ProvInputRef } from "../../types/prov.ts";
import { appendCreation, appendInputAdded, appendInputRemoved, freshDocument, serializeProvenance } from "./document.ts";
import { initProvenanceRecording, flushProvenance, flushProvenanceAsync, resetProvenanceRecorderForTests } from "./prov.ts";
import { getAnalysisIntegrity } from "../../db/primary_query.ts";
import { computeChainHash, computePayloadDigest, verifyHexDigest, resetSigningForTests, loadOrGenerateKeypair } from "./signing.ts";
import { verifyProvenance, verifyPayload } from "./verify.ts";

const analysis: Analysis = {
    id: "a1",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    name: asStr256("My Analysis"),
    slug: "my-analysis",
    outputDirectory: null,
    anchorId: "anchor1",
    projectId: null,
};

const user: ProvActor = { kind: "user", email: "alice@example.org" };
const system: ProvActor = { kind: "system", version: "0.0.1", commit: "abc1234" };
const anon: ProvActor = { kind: "anonymous" };

function inputRef(path: string): ProvInputRef {
    return { path, isDir: false, anchorId: "anchor1" };
}

describe("PROV document building (appendCreation / appendInputAdded / appendInputRemoved)", () => {
    test("appends each action's PROV records", () => {
        const doc = freshDocument(analysis);
        appendCreation(doc, "a1", system);
        appendInputAdded(doc, "a1", user, inputRef("data.csv"), null);
        appendInputRemoved(doc, "a1", anon, inputRef("data.csv"));
        const provn = doc.unified().serialize("provn");

        expect(provn).toContain("entity(inflexa:analysis-a1");
        expect(provn).toContain("agent(inflexa:agent-system");
        // qnameSafe replaces every non-[A-Za-z0-9_-] char — so both `@` and `.` become `_`.
        expect(provn).toContain("agent(inflexa:agent-user-alice_example_org");
        expect(provn).toContain("agent(inflexa:agent-anonymous");
        expect(provn).toContain("0.0.1"); // system agent's version
        expect(provn).toContain("abc1234"); // system agent's source commit (inflexa:commit)
        expect(provn).toContain("used(inflexa:action-"); // add → used
        expect(provn).toContain("wasInvalidatedBy(inflexa:input-"); // remove → wasInvalidatedBy
    });

    test("the same input is one entity across add and remove", () => {
        const doc = freshDocument(analysis);
        appendInputAdded(doc, "a1", user, inputRef("data.csv"), null);
        appendInputRemoved(doc, "a1", user, inputRef("data.csv"));
        const ids = doc
            .unified()
            .getRecords()
            .map((r) => r.identifier?.toString() ?? "")
            .filter((id) => id.startsWith("inflexa:input-"));
        expect(new Set(ids).size).toBe(1);
    });

    test("unified() collapses an agent re-declared across actions (the B decision)", () => {
        const doc = freshDocument(analysis);
        appendInputAdded(doc, "a1", user, inputRef("a.csv"), null);
        appendInputAdded(doc, "a1", user, inputRef("b.csv"), null);
        const agents = doc
            .unified()
            .getRecords()
            .map((r) => r.identifier?.toString() ?? "")
            .filter((id) => id === "inflexa:agent-user-alice_example_org");
        expect(agents.length).toBe(1);
    });

    test("round-trips losslessly through PROV-JSON (deserialize is the reload path)", () => {
        const doc = freshDocument(analysis);
        appendCreation(doc, "a1", system);
        const unified = doc.unified();
        const parsed = ProvDocument.deserialize(unified.serialize("json"), "json");
        expect(unified.equals(parsed)).toBe(true);
    });
});

describe("provenance recorder (bus → in-memory doc → column)", () => {
    beforeEach(() => {
        freshDb();
        resetProvenanceRecorderForTests();
        initProvenanceRecording(); // idempotent: subscribes once across the whole test run
    });

    test("emitted events accumulate in memory and flush to the analyses.provenance column", () => {
        insertAnchor({ id: "anchor1", createdAt: 1, updatedAt: 1, cachedPath: "/tmp/x", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis(analysis)._unsafeUnwrap();

        // No provenance until something is recorded.
        expect(getAnalysisProvenance("a1")._unsafeUnwrap()).toBeNull();

        Bus.emit("inflexa", { type: "prov.analysis_created", analysisId: "a1", actor: system });
        Bus.emit("inflexa", {
            type: "prov.input_added",
            analysisId: "a1",
            actor: user,
            input: { path: "data.csv", isDir: false, anchorId: "anchor1" },
            derivedFromAnalysisId: null,
        });
        // Drive the flush synchronously rather than waiting on the coalesced timer.
        flushProvenance();

        const stored = getAnalysisProvenance("a1")._unsafeUnwrap();
        expect(stored).not.toBeNull();
        // Stored form is valid PROV-JSON that deserializes back into a document holding both agents.
        const doc = ProvDocument.deserialize(stored!, "json");
        const provn = doc.serialize("provn");
        expect(provn).toContain("entity(inflexa:analysis-a1");
        expect(provn).toContain("agent(inflexa:agent-system");
        expect(provn).toContain("agent(inflexa:agent-user-alice_example_org");

        // serializeProvenance reads the same column back for export.
        const exported = serializeProvenance(analysis, "provn")._unsafeUnwrap();
        expect(exported).toContain("used(inflexa:action-");
    });

    test("reopening deserializes the stored doc and appends onto it", () => {
        insertAnchor({ id: "anchor1", createdAt: 1, updatedAt: 1, cachedPath: "/tmp/x", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis(analysis)._unsafeUnwrap();

        Bus.emit("inflexa", { type: "prov.analysis_created", analysisId: "a1", actor: system });
        flushProvenance();

        // Simulate a new process: drop in-memory state so the next event rebuilds from the column.
        resetProvenanceRecorderForTests();

        Bus.emit("inflexa", {
            type: "prov.input_added",
            analysisId: "a1",
            actor: user,
            input: { path: "later.csv", isDir: false, anchorId: "anchor1" },
            derivedFromAnalysisId: null,
        });
        flushProvenance();

        // The reloaded document retains the creation action AND the later add.
        const provn = serializeProvenance(analysis, "provn")._unsafeUnwrap();
        expect(provn).toContain("inflexa:CreateAnalysis");
        expect(provn).toContain("later.csv");
    });

    test("async flush signs provenance and the signature verifies against the chain hash", async () => {
        const { mkdirSync, rmSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { tmpdir } = await import("node:os");
        const { randomUUIDv7: uuid } = await import("bun");

        // Use a temp dir for the signing keypair so this test doesn't touch the real config.
        const tmpDir = join(tmpdir(), `prov-int-test-${uuid()}`);
        mkdirSync(tmpDir, { recursive: true });
        resetSigningForTests(join(tmpDir, "prov_key.json"));

        insertAnchor({ id: "anchor1", createdAt: 1, updatedAt: 1, cachedPath: "/tmp/x", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis(analysis)._unsafeUnwrap();

        Bus.emit("inflexa", { type: "prov.analysis_created", analysisId: "a1", actor: system });
        await flushProvenanceAsync();

        const integrity = getAnalysisIntegrity("a1")._unsafeUnwrap();
        expect(integrity).not.toBeNull();
        expect(integrity!.provenance).not.toBeNull();
        expect(integrity!.chainHash).not.toBeNull();
        expect(integrity!.signature).not.toBeNull();

        // First flush: prevChainHash is null, so recompute seeds from SHA-256("").
        expect(integrity!.prevChainHash).toBeNull();
        const recomputed = await computeChainHash(null, integrity!.provenance!);
        // Non-null assertions safe: the three `.not.toBeNull()` checks above guard them.
        expect(recomputed).toBe(integrity!.chainHash!);

        // Verify the Ed25519 signature.
        const kp = await loadOrGenerateKeypair();
        const ok = await verifyHexDigest(kp!.publicKey, integrity!.signature!, integrity!.chainHash!);
        expect(ok).toBe(true);

        resetSigningForTests(null);
        rmSync(tmpDir, { recursive: true, force: true });
    });

    test("second signed flush chains from the first flush's chain hash", async () => {
        const { mkdirSync, rmSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { tmpdir } = await import("node:os");
        const { randomUUIDv7: uuid } = await import("bun");

        const tmpDir = join(tmpdir(), `prov-chain-test-${uuid()}`);
        mkdirSync(tmpDir, { recursive: true });
        resetSigningForTests(join(tmpDir, "prov_key.json"));

        insertAnchor({ id: "anchor1", createdAt: 1, updatedAt: 1, cachedPath: "/tmp/x", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis(analysis)._unsafeUnwrap();

        // First flush: creation event.
        Bus.emit("inflexa", { type: "prov.analysis_created", analysisId: "a1", actor: system });
        await flushProvenanceAsync();
        const first = getAnalysisIntegrity("a1")._unsafeUnwrap();
        expect(first!.chainHash).not.toBeNull();

        // Second flush: an input-added event appends to the same document.
        Bus.emit("inflexa", {
            type: "prov.input_added",
            analysisId: "a1",
            actor: user,
            input: { path: "extra.csv", isDir: false, anchorId: "anchor1" },
            derivedFromAnalysisId: null,
        });
        await flushProvenanceAsync();
        const second = getAnalysisIntegrity("a1")._unsafeUnwrap();
        expect(second!.chainHash).not.toBeNull();

        // The second chain hash must differ from the first (the PROV-JSON grew).
        expect(second!.chainHash).not.toBe(first!.chainHash);
        // The stored prevChainHash must be the first flush's chain hash.
        expect(second!.prevChainHash).toBe(first!.chainHash);

        // The second chain hash must chain from the first: H2 = SHA-256(H1 || json2).
        const recomputed = await computeChainHash(first!.chainHash!, second!.provenance!);
        expect(recomputed).toBe(second!.chainHash!);

        // The signature still verifies against the new chain hash.
        const kp = await loadOrGenerateKeypair();
        const ok = await verifyHexDigest(kp!.publicKey, second!.signature!, second!.chainHash!);
        expect(ok).toBe(true);

        // verifyProvenance must report "valid" after multi-flush — this was the #CRT-1 bug:
        // the verifier needs prevChainHash to recompute the rolling hash correctly.
        const result = await verifyProvenance(second!.provenance, second!.prevChainHash, second!.chainHash, second!.signature, kp!.publicKey);
        expect(result.status).toBe("valid");

        resetSigningForTests(null);
        rmSync(tmpDir, { recursive: true, force: true });
    });
});

describe("export sidecar (writeSidecar via the full export path)", () => {
    test("signed provenance produces a .sig.json sidecar with the correct shape", async () => {
        const { mkdirSync, rmSync, existsSync, readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { tmpdir } = await import("node:os");
        const { randomUUIDv7: uuid } = await import("bun");

        freshDb();
        resetProvenanceRecorderForTests();
        initProvenanceRecording();

        const tmpDir = join(tmpdir(), `prov-sidecar-test-${uuid()}`);
        mkdirSync(tmpDir, { recursive: true });
        resetSigningForTests(join(tmpDir, "prov_key.json"));

        insertAnchor({ id: "anchor1", createdAt: 1, updatedAt: 1, cachedPath: "/tmp/x", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis(analysis)._unsafeUnwrap();

        Bus.emit("inflexa", { type: "prov.analysis_created", analysisId: "a1", actor: system });
        await flushProvenanceAsync();

        // Write provenance file, then call the sidecar writer via the export module.
        const provDest = join(tmpDir, "provenance.json");
        const provJson = serializeProvenance(analysis, "json")._unsafeUnwrap();
        const { writeFileSync: wf } = await import("node:fs");
        wf(provDest, provJson);

        // The flush should have written integrity columns.
        const integrity = getAnalysisIntegrity("a1")._unsafeUnwrap();
        expect(integrity!.chainHash).not.toBeNull();
        expect(integrity!.signature).not.toBeNull();

        // Build the sidecar via the shared builder (mirrors the export path).
        const { buildSidecar } = await import("./verify.ts");
        const sidecar = await buildSidecar(provJson);
        expect(sidecar).not.toBeNull();

        const sigDest = `${provDest}.sig.json`;
        wf(sigDest, JSON.stringify(sidecar, null, 2));

        expect(existsSync(sigDest)).toBe(true);
        const parsed = JSON.parse(readFileSync(sigDest, "utf-8"));
        // Self-describing envelope fields.
        expect(parsed.payloadType).toBe("application/json; profile=prov-json");
        expect(parsed.payloadDigestAlgorithm).toBe("SHA-256");
        expect(parsed.payloadDigestMethod).toBe("verbatim");
        expect(parsed.signatureAlgorithm).toBe("Ed25519");
        expect(parsed.publicKey).toHaveProperty("kty", "OKP");
        expect(parsed.publicKey).toHaveProperty("crv", "Ed25519");

        // The sidecar's payloadDigest is a simple SHA-256(provJson), not the chain hash.
        const contentDigest = await computePayloadDigest(provJson);
        expect(parsed.payloadDigest).toBe(contentDigest);
        expect(parsed.payloadDigest).not.toBe(integrity!.chainHash);

        // Third-party verification: recompute digest from the file, verify the signature.
        const importedPub = await crypto.subtle.importKey("jwk", parsed.publicKey, "Ed25519", true, ["verify"]);
        const result = await verifyPayload(provJson, parsed.payloadDigest, parsed.signature, importedPub);
        expect(result.status).toBe("valid");

        resetSigningForTests(null);
        rmSync(tmpDir, { recursive: true, force: true });
    });

    test("unsigned provenance produces no sidecar", () => {
        freshDb();
        resetProvenanceRecorderForTests();

        insertAnchor({ id: "anchor1", createdAt: 1, updatedAt: 1, cachedPath: "/tmp/x", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis(analysis)._unsafeUnwrap();

        // Sync flush (no signing) leaves integrity columns NULL.
        Bus.emit("inflexa", { type: "prov.analysis_created", analysisId: "a1", actor: system });
        flushProvenance();

        const integrity = getAnalysisIntegrity("a1")._unsafeUnwrap();
        expect(integrity!.chainHash).toBeNull();
        expect(integrity!.signature).toBeNull();
        // The sidecar writer skips when chainHash/signature are null — no file to check.
    });
});

describe("verifyProvenance end-to-end (bus → flush → verify)", () => {
    test("signed provenance round-trips through verifyProvenance as valid", async () => {
        const { mkdirSync, rmSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { tmpdir } = await import("node:os");
        const { randomUUIDv7: uuid } = await import("bun");

        freshDb();
        resetProvenanceRecorderForTests();
        initProvenanceRecording();

        const tmpDir = join(tmpdir(), `prov-e2e-verify-${uuid()}`);
        mkdirSync(tmpDir, { recursive: true });
        resetSigningForTests(join(tmpDir, "prov_key.json"));

        insertAnchor({ id: "anchor1", createdAt: 1, updatedAt: 1, cachedPath: "/tmp/x", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis(analysis)._unsafeUnwrap();

        Bus.emit("inflexa", { type: "prov.analysis_created", analysisId: "a1", actor: system });
        await flushProvenanceAsync();

        const integrity = getAnalysisIntegrity("a1")._unsafeUnwrap();
        const { loadPublicKey } = await import("./signing.ts");
        const pubKey = await loadPublicKey();
        const result = await verifyProvenance(integrity!.provenance, integrity!.prevChainHash, integrity!.chainHash, integrity!.signature, pubKey);
        expect(result.status).toBe("valid");

        resetSigningForTests(null);
        rmSync(tmpDir, { recursive: true, force: true });
    });
});
