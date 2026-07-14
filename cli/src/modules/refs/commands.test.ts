import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, statSync } from "node:fs";

import { REFERENCE_DATA_CATALOG_VERSION, UnknownReferenceDatasetError, type ReferenceDataCatalog } from "@inflexa-ai/harness";
import { err, ok } from "neverthrow";

import { env } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import { downloadReferences, formatReferenceBytes, parseReferenceIds, runReferenceSetup } from "./commands.ts";
import type { ReferenceCatalogSource } from "./store.ts";

const fixture: ReferenceDataCatalog = {
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
            artifacts: [{ key: "demo/file", path: "file", bytes: 5, sha256: "8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8" }],
        },
    ],
};

const fixtureSource: ReferenceCatalogSource = {
    catalog: fixture,
    resolveInstallPlan: (ids) => {
        const unknown = ids.find((id) => id !== "demo");
        if (unknown !== undefined) return err(new UnknownReferenceDatasetError(unknown, ["demo"]));
        const dataset = fixture.datasets[0];
        return ok({ catalogVersion: fixture.version, datasets: ids.length === 0 || dataset === undefined ? [] : [{ ...dataset, installPath: "demo/1" }] });
    },
};

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
        const noIds = await downloadReferences({ ids: [], interactive: false, source: fixtureSource });
        expect(noIds.isErr()).toBe(true);
        const noConsent = await downloadReferences({ ids: ["demo"], interactive: false, source: fixtureSource });
        expect(noConsent._unsafeUnwrapErr().message).toContain("--yes");
        expect(await Bun.file(env.refsDir).exists()).toBe(false);
    });

    test("a declined interactive download activates nothing", async () => {
        const result = await downloadReferences({
            ids: ["demo"],
            interactive: true,
            source: fixtureSource,
            confirmDownload: async () => false,
        });
        expect(result._unsafeUnwrap()).toMatchObject({ declined: true, installed: [] });
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
