import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { REFERENCE_DATA_CATALOG_VERSION, UnknownReferenceDatasetError, type ReferenceDataCatalog } from "@inflexa-ai/harness";
import { err, ok } from "neverthrow";

import { env } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import { downloadReferences, formatReferenceBytes, parseReferenceIds, runReferenceSetup } from "./commands.ts";
import { referenceStorePaths, type ReferenceCatalogSource } from "./store.ts";

function sha(bytes: string): string {
    return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Catalog fixtures. Every test here stops before the transfer (no ids, no consent, declined, or an
 * unknown id), so no `fetch` seam is needed — nothing in this file may ever reach an upstream.
 */
function catalog(artifacts: ReferenceDataCatalog["datasets"][number]["artifacts"]): ReferenceDataCatalog {
    return {
        version: REFERENCE_DATA_CATALOG_VERSION,
        datasets: [
            {
                id: "demo",
                version: "1",
                title: "Demo",
                description: "Fixture",
                sourceUrl: "https://example.test/source",
                license: { identifier: "CC0-1.0" },
                recommendation: { group: "testing", recommended: true },
                artifacts,
            },
        ],
    };
}

const PINNED_ARTIFACT = { integrity: "pinned", path: "file", url: "https://upstream.test/file", bytes: 5, sha256: sha("alpha") } as const;
const UNPINNED_ARTIFACT = { integrity: "unpinned", path: "mutable", url: "https://upstream.test/mutable" } as const;

function source(value: ReferenceDataCatalog): ReferenceCatalogSource {
    return {
        catalog: value,
        resolveInstallPlan: (ids) => {
            const unknown = ids.find((id) => id !== "demo");
            if (unknown !== undefined) return err(new UnknownReferenceDatasetError(unknown, ["demo"]));
            const dataset = value.datasets[0];
            return ok({ catalogVersion: value.version, datasets: ids.length === 0 || dataset === undefined ? [] : [{ ...dataset, installPath: "demo/1" }] });
        },
    };
}

const pinnedSource = source(catalog([PINNED_ARTIFACT]));

/** Activate the pinned fixture on disk exactly as a completed install would leave it. */
function seedIntactInstall(): void {
    assertTestSandbox(env.refsDir);
    const paths = referenceStorePaths(env.refsDir);
    mkdirSync(join(paths.managed, "demo", "1"), { recursive: true });
    mkdirSync(paths.receipts, { recursive: true });
    writeFileSync(join(paths.managed, "demo", "1", "file"), "alpha");
    writeFileSync(
        join(paths.receipts, "demo.json"),
        JSON.stringify({
            version: 1,
            datasetId: "demo",
            datasetVersion: "1",
            activatedAt: "2026-07-14T12:00:00.000Z",
            artifacts: [{ path: "file", bytes: 5, sha256: sha("alpha"), integrity: "pinned" }],
        }),
    );
}

afterEach(() => {
    assertTestSandbox(env.refsDir);
    rmSync(env.refsDir, { recursive: true, force: true });
});

describe("reference command policy", () => {
    test("parses stable selections and human-readable sizes", () => {
        expect(parseReferenceIds("demo, other, demo")).toEqual(["demo", "other"]);
        expect(formatReferenceBytes(1024)).toBe("1.0 KiB");
    });

    test("headless downloads require ids and explicit consent before mutation", async () => {
        assertTestSandbox(env.refsDir);
        const noIds = await downloadReferences({ ids: [], interactive: false, source: pinnedSource });
        expect(noIds.isErr()).toBe(true);
        const noConsent = await downloadReferences({ ids: ["demo"], interactive: false, source: pinnedSource });
        expect(noConsent._unsafeUnwrapErr().message).toBe("Downloading 5 B requires explicit consent; re-run with --yes.");
        expect(await Bun.file(env.refsDir).exists()).toBe(false);
    });

    test("an unpinned artifact is quoted as upstream-determined rather than given an invented size", async () => {
        const unsized = await downloadReferences({ ids: ["demo"], interactive: false, source: source(catalog([UNPINNED_ARTIFACT])) });
        expect(unsized._unsafeUnwrapErr().message).toBe("Downloading 1 file of upstream-determined size requires explicit consent; re-run with --yes.");

        const mixed = await downloadReferences({ ids: ["demo"], interactive: false, source: source(catalog([PINNED_ARTIFACT, UNPINNED_ARTIFACT])) });
        expect(mixed._unsafeUnwrapErr().message).toBe("Downloading 5 B + 1 file of upstream-determined size requires explicit consent; re-run with --yes.");
    });

    test("--force turns an intact install back into bytes to fetch; without it there is nothing to do", async () => {
        seedIntactInstall();
        const intact = await downloadReferences({ ids: ["demo"], interactive: false, source: pinnedSource });
        expect(intact._unsafeUnwrapErr().message).toBe("Downloading 0 B requires explicit consent; re-run with --yes.");

        const forced = await downloadReferences({ ids: ["demo"], interactive: false, force: true, source: pinnedSource });
        expect(forced._unsafeUnwrapErr().message).toBe("Downloading 5 B requires explicit consent; re-run with --yes.");
    });

    test("a declined interactive download activates nothing", async () => {
        const questions: string[] = [];
        const result = await downloadReferences({
            ids: ["demo"],
            interactive: true,
            source: pinnedSource,
            confirmDownload: async (question) => {
                questions.push(question);
                return false;
            },
        });
        expect(result._unsafeUnwrap()).toMatchObject({ declined: true, installed: [] });
        expect(questions).toEqual([`Download 5 B of reference data into ${env.refsDir}?`]);
        expect(await Bun.file(env.refsDir).exists()).toBe(false);
    });

    test("headless setup creates the public/user namespace but downloads nothing without selection", async () => {
        assertTestSandbox(env.refsDir);
        const result = await runReferenceSetup({ interactive: false });
        expect(result.isOk()).toBe(true);
        expect(statSync(`${env.refsDir}/user`).isDirectory()).toBe(true);
        expect(await Bun.file(`${env.refsDir}/managed`).exists()).toBe(false);
    });

    test("headless setup with ids but no consent prints guidance and continues without transfer", async () => {
        const result = await runReferenceSetup({ interactive: false, ids: ["demo"] });
        expect(result.isOk()).toBe(true);
        expect(await Bun.file(`${env.refsDir}/managed`).exists()).toBe(false);
    });

    test("an explicit selected setup failure is returned visibly through the shared handler", async () => {
        const result = await runReferenceSetup({ interactive: false, ids: ["unknown"], yes: true });
        expect(result._unsafeUnwrapErr().type).toBe("unknown_dataset");
        expect(await Bun.file(`${env.refsDir}/managed`).exists()).toBe(false);
    });
});
