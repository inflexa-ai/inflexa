import { describe, expect, test } from "bun:test";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { createProvenanceRecorder, type ProvSnapshot, type ProvSnapshotSink } from "./recorder.js";
import { createKeypairSigner, computePayloadDigest, type ProvSigner } from "./signing.js";
import { buildSidecar, sidecarSchema, verifyProvenance, verifySidecar } from "./verify.js";
import { createProvDocumentModel, defaultProvDigest } from "./document.js";
import type { ProvActor, ProvEvent } from "./types.js";

const actor: ProvActor = { kind: "system", label: "test-host", version: "0.0.0", commit: "abc123" };

async function makeKeypair(): Promise<CryptoKeyPair> {
    return (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
}

/**
 * An in-memory sink with compare-and-swap on `prevChainHash`. `known` analyses load a seed;
 * everything else loads `null`. Every accepted persist is appended to `persists`.
 */
function makeSink(known: string[]) {
    const stored = new Map<string, { provJson: string | null; chainHash: string | null }>();
    for (const id of known) stored.set(id, { provJson: null, chainHash: null });
    const persists: ProvSnapshot[] = [];
    const sink: ProvSnapshotSink = {
        load: (analysisId) => {
            const row = stored.get(analysisId);
            if (!row) return okAsync(null);
            return okAsync({ subject: { analysisId, name: "Test Analysis" }, provJson: row.provJson, chainHash: row.chainHash });
        },
        persist: (snapshot) => {
            const row = stored.get(snapshot.analysisId);
            if (!row) return errAsync({ type: "persist_failed" as const });
            if (row.chainHash !== snapshot.prevChainHash) return errAsync({ type: "conflict" as const });
            stored.set(snapshot.analysisId, { provJson: snapshot.provJson, chainHash: snapshot.chainHash });
            persists.push(snapshot);
            return okAsync(undefined);
        },
    };
    return { sink, stored, persists };
}

function runEvents(analysisId: string): ProvEvent[] {
    const step = { runId: "r1", stepId: "s1" };
    return [
        { type: "run_started", analysisId, actor, run: { runId: "r1", planSummary: "test plan", startedAtMs: 1_700_000_000_000 } },
        {
            type: "command_executed",
            analysisId,
            actor,
            step,
            model: "anthropic/test-model",
            command: {
                kind: "command",
                command: "python run.py",
                exitCode: 0,
                durationMs: 1200,
                outputs: [{ path: "runs/r1/s1/output/result.csv", hash: "sha256:bbb" }],
                inputs: [{ path: "data/inputs/counts.csv", hash: "sha256:aaa", source: "data" }],
            },
        },
        {
            type: "file_written",
            analysisId,
            actor,
            step,
            generation: "command",
            file: { path: "runs/r1/s1/output/result.csv", hash: "sha256:bbb", size: 10, producer: "command" },
        },
        {
            type: "step_completed",
            analysisId,
            actor,
            model: "anthropic/test-model",
            outcome: { runId: "r1", stepId: "s1", status: "completed", completedAtMs: 1_700_000_100_000, durationMs: 100_000 },
        },
        {
            type: "run_completed",
            analysisId,
            actor,
            outcome: { runId: "r1", status: "completed", completedAtMs: 1_700_000_200_000, durationMs: 200_000 },
        },
    ];
}

describe("provenance recorder", () => {
    test("a burst of events coalesces into one signed, chained persist that verifies", async () => {
        const kp = await makeKeypair();
        const { sink, persists } = makeSink(["a1"]);
        const recorder = createProvenanceRecorder({ sink, signer: createKeypairSigner(kp) });

        for (const event of runEvents("a1")) recorder.record(event);
        await recorder.flush();

        expect(persists.length).toBe(1);
        const snap = persists[0]!;
        expect(snap.prevChainHash).toBeNull();
        expect(await verifyProvenance(snap.provJson, snap.prevChainHash, snap.chainHash, snap.signature, kp.publicKey)).toEqual({ status: "valid" });

        const doc = JSON.parse(snap.provJson) as Record<string, Record<string, unknown>>;
        expect(Object.keys(doc.activity ?? {})).toContain("inflexa:run-r1");
        expect(Object.keys(doc.activity ?? {})).toContain("inflexa:step-r1-s1");
        expect(Object.keys(doc.agent ?? {})).toContain("inflexa:agent-system");
    });

    test("subsequent flushes chain onto the previous hash", async () => {
        const kp = await makeKeypair();
        const { sink, persists } = makeSink(["a1"]);
        const recorder = createProvenanceRecorder({ sink, signer: createKeypairSigner(kp) });

        const [started, command, file, step, completed] = runEvents("a1");
        recorder.record(started!);
        await recorder.flush();
        recorder.record(command!);
        recorder.record(file!);
        recorder.record(step!);
        recorder.record(completed!);
        await recorder.flush();

        expect(persists.length).toBe(2);
        expect(persists[1]!.prevChainHash).toBe(persists[0]!.chainHash);
        expect(await verifyProvenance(persists[1]!.provJson, persists[1]!.prevChainHash, persists[1]!.chainHash, persists[1]!.signature, kp.publicKey)).toEqual(
            { status: "valid" },
        );
    });

    test("re-emission of the same execution events dedupes under unified()", async () => {
        const kp = await makeKeypair();
        const { sink, persists } = makeSink(["a1"]);
        const recorder = createProvenanceRecorder({ sink, signer: createKeypairSigner(kp) });

        for (const event of runEvents("a1")) recorder.record(event);
        await recorder.flush();
        for (const event of runEvents("a1")) recorder.record(event);
        await recorder.flush();

        const doc = JSON.parse(persists.at(-1)!.provJson) as Record<string, Record<string, unknown>>;
        const model = createProvDocumentModel();
        const fileQn = model.fileQName({ path: "runs/r1/s1/output/result.csv", hash: "sha256:bbb" });
        expect(Object.keys(doc.entity ?? {}).filter((k) => k === fileQn).length).toBe(1);
        // Exactly one generation edge for the file, under its deterministic relation id.
        const genIds = Object.keys(doc.wasGeneratedBy ?? {});
        expect(genIds.filter((k) => k.includes(defaultProvDigest(`runs/r1/s1/output/result.csv|sha256:bbb`))).length).toBe(1);
        // No anonymous (blank-node) relations — every relation must carry its deterministic id.
        for (const relKind of ["used", "wasGeneratedBy", "wasAssociatedWith", "wasInformedBy", "wasAttributedTo", "wasDerivedFrom"]) {
            for (const id of Object.keys(doc[relKind] ?? {})) expect(id.startsWith("_:")).toBe(false);
        }
    });

    test("a transient signing failure retains the tail and never writes unsigned", async () => {
        const kp = await makeKeypair();
        const inner = createKeypairSigner(kp);
        let failures = 1;
        const flaky: ProvSigner = {
            sign: (digestHex) => {
                if (failures > 0) {
                    failures -= 1;
                    return errAsync({ type: "crypto_failed" as const, op: "sign", cause: new Error("transient") });
                }
                return inner.sign(digestHex);
            },
            exportPublicKeyJwk: () => inner.exportPublicKeyJwk(),
        };
        const { sink, persists } = makeSink(["a1"]);
        const recorder = createProvenanceRecorder({ sink, signer: flaky });

        for (const event of runEvents("a1")) recorder.record(event);
        await recorder.flush();

        expect(persists.length).toBe(1);
        expect(await verifyProvenance(persists[0]!.provJson, null, persists[0]!.chainHash, persists[0]!.signature, kp.publicKey)).toEqual({
            status: "valid",
        });
    });

    test("a persistent signing failure stops the drain without spinning", async () => {
        const broken: ProvSigner = {
            sign: () => errAsync({ type: "crypto_failed" as const, op: "sign", cause: new Error("permanent") }),
            exportPublicKeyJwk: () => okAsync(null),
        };
        const { sink, persists } = makeSink(["a1"]);
        const recorder = createProvenanceRecorder({ sink, signer: broken });

        recorder.record(runEvents("a1")[0]!);
        await recorder.flush();

        expect(persists.length).toBe(0);
    });

    test("an unknown analysis is skipped", async () => {
        const kp = await makeKeypair();
        const { sink, persists } = makeSink([]);
        const recorder = createProvenanceRecorder({ sink, signer: createKeypairSigner(kp) });

        for (const event of runEvents("missing")) recorder.record(event);
        await recorder.flush();

        expect(persists.length).toBe(0);
    });

    test("a corrupt stored document starts a fresh document and a fresh chain", async () => {
        const kp = await makeKeypair();
        const { sink, stored, persists } = makeSink(["a1"]);
        stored.set("a1", { provJson: "this is not prov-json", chainHash: "ab".repeat(32) });
        const recorder = createProvenanceRecorder({ sink, signer: createKeypairSigner(kp) });

        // The CAS sink compares against the corrupt row's chain hash; a fresh chain (prev null)
        // must still land, so relax the sink to accept it the way a real host's
        // corrupt-row-recovery would.
        stored.set("a1", { provJson: "this is not prov-json", chainHash: null });
        recorder.record(runEvents("a1")[0]!);
        await recorder.flush();

        expect(persists.length).toBe(1);
        expect(persists[0]!.prevChainHash).toBeNull();
        const doc = JSON.parse(persists[0]!.provJson) as Record<string, Record<string, unknown>>;
        expect(Object.keys(doc.activity ?? {})).toContain("inflexa:run-r1");
    });

    test("a CAS conflict refreshes the chain head and re-chains onto it", async () => {
        const kp = await makeKeypair();
        const { sink, stored, persists } = makeSink(["a1"]);
        const recorder = createProvenanceRecorder({ sink, signer: createKeypairSigner(kp) });

        recorder.record(runEvents("a1")[0]!);
        await recorder.flush();
        expect(persists.length).toBe(1);

        // Another writer advances the stored chain behind this recorder's back.
        const foreignHead = "cd".repeat(32);
        stored.set("a1", { provJson: stored.get("a1")!.provJson, chainHash: foreignHead });

        recorder.record(runEvents("a1")[4]!);
        await recorder.flush();

        expect(persists.length).toBe(2);
        expect(persists[1]!.prevChainHash).toBe(foreignHead);
    });

    test("events recorded while the first-touch load is in flight are drained by flush", async () => {
        const kp = await makeKeypair();
        const { sink, persists } = makeSink(["a1"]);
        const slowSink: ProvSnapshotSink = {
            load: (analysisId) => ResultAsync.fromSafePromise(new Promise((resolve) => setTimeout(resolve, 20))).andThen(() => sink.load(analysisId)),
            persist: (snapshot) => sink.persist(snapshot),
        };
        const recorder = createProvenanceRecorder({ sink: slowSink, signer: createKeypairSigner(kp) });

        for (const event of runEvents("a1")) recorder.record(event);
        await recorder.flush();

        expect(persists.length).toBe(1);
        const doc = JSON.parse(persists[0]!.provJson) as Record<string, Record<string, unknown>>;
        expect(Object.keys(doc.activity ?? {})).toContain("inflexa:run-r1");
        expect(Object.keys(doc.activity ?? {})).toContain("inflexa:step-r1-s1");
    });
});

describe("sidecar", () => {
    test("buildSidecar output validates and verifies against the payload", async () => {
        const kp = await makeKeypair();
        const signer = createKeypairSigner(kp);
        const provJson = `{"prefix":{"inflexa":"https://inflexa.ai/prov#"}}`;

        const sidecarResult = await buildSidecar(signer, provJson);
        expect(sidecarResult.isOk()).toBe(true);
        const sidecar = sidecarSchema.parse(sidecarResult._unsafeUnwrap());
        expect(sidecar.payloadDigest).toBe((await computePayloadDigest(provJson))._unsafeUnwrap());
        expect(await verifySidecar(provJson, sidecar)).toEqual({ status: "valid" });
        expect(await verifySidecar(`${provJson} `, sidecar)).toMatchObject({ status: "tampered" });
    });
});
