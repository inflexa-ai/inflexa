import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProvAttestation, ProvSigningError } from "@inflexa-ai/prov-kernel";
import { err, ok } from "neverthrow";

import type { DbError } from "../../db/errors.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { WorkspaceError } from "../analysis/output.ts";
import { exportAnalysisProvenance, type ExportProvenanceOpts } from "./export.ts";

// The export's ordering is only observable on disk: "signed before written" and "written then signed"
// differ solely in what survives a signing failure. These drive the real `mkdir`/`writeFile` against a
// temp directory for that reason — a recorded call list would prove the calls happened in an order,
// not that a failure left the destination untouched.
describe("exportAnalysisProvenance", () => {
    const ANALYSIS = { id: "a1", name: "Alpha", slug: "alpha", anchorId: "anchor-1", projectId: null } as unknown as Analysis;
    const DOCUMENT = '{"prefix":{},"entity":{}}';
    const ATTESTATION: ProvAttestation = {
        payloadType: "application/json; profile=prov-json",
        payloadDigestAlgorithm: "SHA-256",
        payloadDigest: "8f43",
        payloadDigestMethod: "verbatim",
        signatureAlgorithm: "Ed25519",
        signature: "3a91",
        publicKey: { kty: "OKP", crv: "Ed25519", x: "abc" },
    };

    let root: string;
    let out: string;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "inflexa-prov-export-"));
        // Deliberately NOT created: the export's own `mkdir` is what brings it into being, so its
        // absence afterwards proves nothing was written rather than merely that a file is missing.
        out = join(root, "analyses", "alpha");
    });
    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    /** The three edges, with the signature outcome the case is about. */
    function opts(attestation: ExportProvenanceOpts["buildAttestation"]): ExportProvenanceOpts {
        return {
            resolveOutputDir: () => ok<string, WorkspaceError>(out),
            serializeProvenance: () => ok<string, DbError>(DOCUMENT),
            buildAttestation: attestation,
        };
    }

    test("a signing failure writes neither the document nor the attestation", async () => {
        const failure = (
            await exportAnalysisProvenance(
                ANALYSIS,
                "json",
                undefined,
                opts(async () => err<ProvAttestation, ProvSigningError>({ type: "keypair_race_lost" })),
            )
        )._unsafeUnwrapErr();

        expect(failure).toEqual({ type: "signing", error: { type: "keypair_race_lost" } });
        expect(existsSync(join(out, "provenance.json"))).toBe(false);
        expect(existsSync(join(out, "provenance.json.sig.json"))).toBe(false);
        // Nothing at all, not even the directory the write would have needed: an unsigned document
        // beneath a notice claiming provenance is never exported unsigned is the failure being fixed.
        expect(existsSync(out)).toBe(false);
    });

    test("a successful signature writes the document and its attestation together", async () => {
        const exported = await exportAnalysisProvenance(
            ANALYSIS,
            "json",
            undefined,
            opts(async () => ok<ProvAttestation, ProvSigningError>(ATTESTATION)),
        );

        const path = join(out, "provenance.json");
        expect(exported._unsafeUnwrap()).toEqual({ path, attestationPath: `${path}.sig.json` });
        expect(readFileSync(path, "utf8")).toBe(DOCUMENT);
        expect(JSON.parse(readFileSync(`${path}.sig.json`, "utf8"))).toEqual(ATTESTATION);
    });

    test("a PROV-N export is never signed: the attestation claims the PROV-JSON payload type", async () => {
        let signed = false;
        const exported = await exportAnalysisProvenance(
            ANALYSIS,
            "provn",
            undefined,
            opts(async () => {
                signed = true;
                return ok<ProvAttestation, ProvSigningError>(ATTESTATION);
            }),
        );

        expect(exported._unsafeUnwrap()).toEqual({ path: join(out, "provenance.provn") });
        expect(signed).toBe(false);
        expect(existsSync(join(out, "provenance.provn.sig.json"))).toBe(false);
    });

    test("an `output` path is written as given, and the workspace is not resolved for it", async () => {
        const output = join(root, "elsewhere.json");
        const exported = await exportAnalysisProvenance(ANALYSIS, "json", output, {
            ...opts(async () => ok<ProvAttestation, ProvSigningError>(ATTESTATION)),
            resolveOutputDir: () => err<string, WorkspaceError>({ type: "workspace_unavailable", message: "not writable" }),
        });

        expect(exported._unsafeUnwrap()).toEqual({ path: output, attestationPath: `${output}.sig.json` });
        expect(readFileSync(output, "utf8")).toBe(DOCUMENT);
    });
});
