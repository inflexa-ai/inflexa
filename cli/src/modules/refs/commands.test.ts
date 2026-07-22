import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { REFERENCE_DATA_CATALOG_VERSION, UnknownReferenceDatasetError, type ReferenceDataCatalog } from "@inflexa-ai/harness";
import { err, ok } from "neverthrow";

// Side-effect import: the command actions render byte counts through Number.prototype.formatBytes,
// which only exists once the extension loader has run.
import "../../extensions/index.ts";
import { env } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import {
    ON_DEMAND_REFERENCE_NOTE,
    createReferenceDownloadProgress,
    downloadReferences,
    offeredReferenceCatalog,
    parseReferenceIds,
    resolveReferencePreset,
    runReferenceSetup,
    runRefsList,
    runRefsVerify,
    type ReferenceProgressSink,
    type ReferenceProgressSnapshot,
} from "./commands.ts";
import { inspectReferenceStore, referenceStorePaths, type ReferenceCatalogSource } from "./store.ts";

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

const FILE_ARTIFACT = { path: "file", url: "https://upstream.test/file", format: "txt", contents: "test fixture artifact" } as const;
const MUTABLE_ARTIFACT = { path: "mutable", url: "https://upstream.test/mutable", format: "txt", contents: "test fixture artifact" } as const;

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

const singleFileSource = source(catalog([FILE_ARTIFACT]));

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
            artifacts: [{ path: "file", bytes: 5, sha256: sha("alpha") }],
        }),
    );
}

/**
 * Run `fn` with stdout (console.log) and stderr (console.error) captured as strings, modeling the
 * trailing newline the real streams add per call so byte-stability can be asserted on the exact bytes.
 * Restores both and clears process.exitCode so a captured failure code never leaks to sibling tests.
 */
async function capture(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string; exitCode: typeof process.exitCode }> {
    const origLog = console.log;
    const origError = console.error;
    const origExitCode = process.exitCode;
    let stdout = "";
    let stderr = "";
    console.log = (msg?: unknown) => {
        stdout += `${String(msg)}\n`;
    };
    console.error = (msg?: unknown) => {
        stderr += `${String(msg)}\n`;
    };
    try {
        await fn();
        return { stdout, stderr, exitCode: process.exitCode };
    } finally {
        console.log = origLog;
        console.error = origError;
        // Bun ignores an `undefined` assignment (Node treats it as a reset), so a captured failure code
        // must be cleared with an explicit 0 — otherwise it fails the whole single-process `bun test` run.
        process.exitCode = origExitCode ?? 0;
    }
}

afterEach(() => {
    assertTestSandbox(env.refsDir);
    rmSync(env.refsDir, { recursive: true, force: true });
});

describe("reference command policy", () => {
    test("parses stable selections", () => {
        expect(parseReferenceIds("demo, other, demo")).toEqual(["demo", "other"]);
    });

    test("headless downloads require ids and explicit consent before mutation", async () => {
        assertTestSandbox(env.refsDir);
        const noIds = await downloadReferences({ ids: [], interactive: false, source: singleFileSource });
        expect(noIds.isErr()).toBe(true);
        const noConsent = await downloadReferences({ ids: ["demo"], interactive: false, source: singleFileSource });
        expect(noConsent._unsafeUnwrapErr().message).toBe("Downloading 1 file of upstream-determined size requires explicit consent; re-run with --yes.");
        expect(await Bun.file(env.refsDir).exists()).toBe(false);
    });

    test("every artifact is quoted as upstream-determined rather than given an invented size", async () => {
        const oneFile = await downloadReferences({ ids: ["demo"], interactive: false, source: source(catalog([MUTABLE_ARTIFACT])) });
        expect(oneFile._unsafeUnwrapErr().message).toBe("Downloading 1 file of upstream-determined size requires explicit consent; re-run with --yes.");

        const twoFiles = await downloadReferences({ ids: ["demo"], interactive: false, source: source(catalog([FILE_ARTIFACT, MUTABLE_ARTIFACT])) });
        expect(twoFiles._unsafeUnwrapErr().message).toBe("Downloading 2 files of upstream-determined size requires explicit consent; re-run with --yes.");
    });

    test("--force turns an intact install back into a file to fetch; without it there is nothing to do", async () => {
        seedIntactInstall();
        const intact = await downloadReferences({ ids: ["demo"], interactive: false, source: singleFileSource });
        expect(intact._unsafeUnwrapErr().message).toBe("Downloading 0 files of upstream-determined size requires explicit consent; re-run with --yes.");

        const forced = await downloadReferences({ ids: ["demo"], interactive: false, force: true, source: singleFileSource });
        expect(forced._unsafeUnwrapErr().message).toBe("Downloading 1 file of upstream-determined size requires explicit consent; re-run with --yes.");
    });

    test("a declined interactive download activates nothing", async () => {
        const questions: string[] = [];
        const result = await downloadReferences({
            ids: ["demo"],
            interactive: true,
            source: singleFileSource,
            confirmDownload: async (question) => {
                questions.push(question);
                return false;
            },
        });
        expect(result._unsafeUnwrap()).toMatchObject({ declined: true, installed: [] });
        expect(questions).toEqual([`Download 1 file of upstream-determined size of reference data into ${env.refsDir}?`]);
        expect(await Bun.file(env.refsDir).exists()).toBe(false);
    });

    test("headless setup creates the public/user namespace but downloads nothing without selection", async () => {
        assertTestSandbox(env.refsDir);
        const result = await runReferenceSetup({ interactive: false });
        expect(result.isOk()).toBe(true);
        expect(statSync(`${env.refsDir}/user`).isDirectory()).toBe(true);
        expect(await Bun.file(`${env.refsDir}/managed`).exists()).toBe(false);
    });

    test("headless setup without ids defaults to the recommended set but still gates the transfer on consent", async () => {
        assertTestSandbox(env.refsDir);
        // The fixture's only dataset is recommended, so the omitted-`--refs` headless path selects it as
        // the default — but without `--yes` the consent gate must still stop before any transfer, exactly
        // as an explicit selection does. This pins the invariant that the default never downloads silently.
        const result = await runReferenceSetup({ interactive: false, source: singleFileSource });
        expect(result.isOk()).toBe(true);
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

describe("reference json output", () => {
    test("list --json emits every catalog dataset in catalog order with per-dataset install state", async () => {
        seedIntactInstall();
        // `extra` before `demo` proves the document follows catalog order, not install state; only `demo`
        // is seeded on disk, so `extra` must report as missing with no installed-version keys.
        const twoDatasetCatalog: ReferenceDataCatalog = {
            version: REFERENCE_DATA_CATALOG_VERSION,
            datasets: [
                {
                    id: "extra",
                    version: "9",
                    title: "Extra",
                    description: "Second",
                    sourceUrl: "https://example.test/extra",
                    license: { identifier: "MIT", url: "https://example.test/mit" },
                    recommendation: { group: "extras", recommended: false },
                    artifacts: [{ path: "x.txt", url: "https://upstream.test/x.txt", format: "txt", contents: "test fixture artifact" }],
                },
                {
                    id: "demo",
                    version: "1",
                    title: "Demo",
                    description: "Fixture",
                    sourceUrl: "https://example.test/source",
                    license: { identifier: "CC0-1.0" },
                    recommendation: { group: "testing", recommended: true },
                    artifacts: [FILE_ARTIFACT],
                },
            ],
        };
        const twoDatasetSource: ReferenceCatalogSource = {
            catalog: twoDatasetCatalog,
            // The list path reads only `catalog`; a stub resolver satisfies the seam shape without being called.
            resolveInstallPlan: () => ok({ catalogVersion: twoDatasetCatalog.version, datasets: [] }),
        };

        const { stdout, stderr, exitCode } = await capture(() => runRefsList({ json: true, source: twoDatasetSource }));
        expect(stderr).toBe("");
        expect(exitCode ?? 0).toBe(0);
        const document = JSON.parse(stdout);
        expect(document.datasets.map((entry: { id: string }) => entry.id)).toEqual(["extra", "demo"]);
        const [extra, demo] = document.datasets;
        expect(extra.state).toBe("missing");
        expect(extra).not.toHaveProperty("installedVersion");
        expect(extra).not.toHaveProperty("installedAt");
        expect(extra.artifacts).toEqual([{ path: "x.txt", url: "https://upstream.test/x.txt" }]);
        expect(demo.state).toBe("installed");
        expect(demo.installedVersion).toBe("1");
        expect(demo.installedAt).toBe("2026-07-14T12:00:00.000Z");
        expect(demo.artifacts).toEqual([{ path: "file", url: "https://upstream.test/file" }]);
    });

    test("list --json is a byte-stable document whose full text pins the shape and key order", async () => {
        seedIntactInstall();
        // The full expected bytes — every key in the documented order, license.url and install facts
        // present/absent exactly as the store state dictates. Only the machine-specific root varies.
        const expected =
            `{\n` +
            `  "root": ${JSON.stringify(env.refsDir)},\n` +
            `  "exists": true,\n` +
            `  "datasets": [\n` +
            `    {\n` +
            `      "id": "demo",\n` +
            `      "version": "1",\n` +
            `      "title": "Demo",\n` +
            `      "description": "Fixture",\n` +
            `      "sourceUrl": "https://example.test/source",\n` +
            `      "license": {\n` +
            `        "identifier": "CC0-1.0"\n` +
            `      },\n` +
            `      "group": "testing",\n` +
            `      "recommended": true,\n` +
            `      "state": "installed",\n` +
            `      "installedVersion": "1",\n` +
            `      "installedAt": "2026-07-14T12:00:00.000Z",\n` +
            `      "artifacts": [\n` +
            `        {\n` +
            `          "path": "file",\n` +
            `          "url": "https://upstream.test/file"\n` +
            `        }\n` +
            `      ]\n` +
            `    }\n` +
            `  ],\n` +
            `  "userContent": []\n` +
            `}`;
        const { stdout, stderr, exitCode } = await capture(() => runRefsList({ json: true, source: singleFileSource }));
        expect(stdout).toBe(`${expected}\n`);
        expect(stderr).toBe("");
        expect(exitCode ?? 0).toBe(0);
    });

    test("list --json --urls is byte-identical to --json alone", async () => {
        seedIntactInstall();
        const plain = await capture(() => runRefsList({ json: true, source: singleFileSource }));
        const withUrls = await capture(() => runRefsList({ json: true, urls: true, source: singleFileSource }));
        expect(withUrls.stdout).toBe(plain.stdout);
        expect(plain.stdout.length).toBeGreaterThan(0);
    });

    test("list --json before the store exists is byte-stable and creates nothing", async () => {
        assertTestSandbox(env.refsDir);
        const first = await capture(() => runRefsList({ json: true, source: singleFileSource }));
        const second = await capture(() => runRefsList({ json: true, source: singleFileSource }));
        expect(first.stdout).toBe(second.stdout);
        expect(first.stderr).toBe("");
        expect(JSON.parse(first.stdout).exists).toBe(false);
        // Passive inspection must never materialize the store.
        expect(await Bun.file(env.refsDir).exists()).toBe(false);
    });

    test("list --json inspection failure keeps stdout empty and reports prose on stderr", async () => {
        assertTestSandbox(env.refsDir);
        // A store root that is a plain file, not a directory, is a genuine inspection failure.
        mkdirSync(dirname(env.refsDir), { recursive: true });
        writeFileSync(env.refsDir, "not a directory");
        const { stdout, stderr, exitCode } = await capture(() => runRefsList({ json: true, source: singleFileSource }));
        expect(stdout).toBe("");
        expect(stderr).toContain("Reference-data inspection failed");
        expect(exitCode).toBe(1);
    });

    test("verify --json inspection failure keeps stdout empty and reports prose on stderr", async () => {
        assertTestSandbox(env.refsDir);
        mkdirSync(dirname(env.refsDir), { recursive: true });
        writeFileSync(env.refsDir, "not a directory");
        const { stdout, stderr, exitCode } = await capture(() => runRefsVerify([], { json: true, source: singleFileSource }));
        expect(stdout).toBe("");
        expect(stderr).toContain("Reference-data verification failed");
        expect(exitCode).toBe(1);
    });

    test("verify --json reports damage in the document and the exit code, with no repair hint", async () => {
        seedIntactInstall();
        // Same-size, different-bytes overwrite: the size still matches the receipt, the digest does not,
        // so verification finds the file modified rather than missing.
        writeFileSync(join(referenceStorePaths(env.refsDir).managed, "demo", "1", "file"), "ALPHA");
        const { stdout, stderr, exitCode } = await capture(() => runRefsVerify([], { json: true, source: singleFileSource }));
        expect(exitCode).toBe(1);
        // The damaged states live in the document, so stderr stays reserved for genuine failures.
        expect(stderr).toBe("");
        expect(JSON.parse(stdout)).toEqual({
            datasets: [{ datasetId: "demo", version: "1", state: "modified", files: [{ path: "file", state: "modified" }] }],
        });
    });

    test("verify --json on an intact store reports valid states and exits zero", async () => {
        seedIntactInstall();
        const { stdout, stderr, exitCode } = await capture(() => runRefsVerify([], { json: true, source: singleFileSource }));
        expect(exitCode ?? 0).toBe(0);
        expect(stderr).toBe("");
        expect(JSON.parse(stdout)).toEqual({
            datasets: [{ datasetId: "demo", version: "1", state: "valid", files: [{ path: "file", state: "valid" }] }],
        });
    });

    test("verify --json surfaces a verification failure on stderr with an empty stdout", async () => {
        // Explicit ids skip the no-ids selection guard and reach `verifyReferenceDatasets`; the fixture
        // source rejects any id but "demo", so this exercises the JSON branch's own err handler.
        const { stdout, stderr, exitCode } = await capture(() => runRefsVerify(["unknown"], { json: true, source: singleFileSource }));
        expect(stdout).toBe("");
        expect(stderr).toContain("Reference-data verification failed");
        expect(exitCode).toBe(1);
    });

    test("verify --json is byte-stable across two runs of an intact store", async () => {
        seedIntactInstall();
        const first = await capture(() => runRefsVerify([], { json: true, source: singleFileSource }));
        const second = await capture(() => runRefsVerify([], { json: true, source: singleFileSource }));
        expect(second.stdout).toBe(first.stdout);
        expect(first.stdout.length).toBeGreaterThan(0);
    });
});

/** A multi-dataset offer with mixed recommendations — the shape a preset actually resolves against. */
function presetCatalog(recommended: readonly string[]): ReferenceDataCatalog {
    const base = catalog([FILE_ARTIFACT]).datasets[0];
    if (base === undefined) throw new Error("fixture catalog lost its dataset");
    return {
        version: REFERENCE_DATA_CATALOG_VERSION,
        datasets: ["alpha", "beta", "gamma"].map((id) => ({
            ...base,
            id,
            title: id,
            recommendation: { group: "testing", recommended: recommended.includes(id) },
        })),
    };
}

/** A picker that never opens — every preset except `custom` must resolve without one. */
const unusedPicker = async (): Promise<readonly string[]> => {
    throw new Error("the per-dataset picker must not open for this preset");
};

describe("reference selection presets", () => {
    test("each preset resolves against the offered datasets", async () => {
        const offered = presetCatalog(["alpha", "gamma"]);
        expect(await resolveReferencePreset("all", offered, { pick: unusedPicker })).toEqual(["alpha", "beta", "gamma"]);
        expect(await resolveReferencePreset("recommended", offered, { pick: unusedPicker })).toEqual(["alpha", "gamma"]);
        expect(await resolveReferencePreset("none", offered, { pick: unusedPicker, announce: () => {} })).toEqual([]);
    });

    test("the recommended preset resolves to nothing rather than widening when none are recommended", async () => {
        const offered = presetCatalog([]);
        const announced: string[] = [];
        expect(await resolveReferencePreset("recommended", offered, { pick: unusedPicker, announce: (m) => announced.push(m) })).toEqual([]);
        // Silently installing all three would be the tempting fallback and the wrong one — a preset
        // must never plan more than its name says.
        expect(announced).toEqual([ON_DEMAND_REFERENCE_NOTE]);
    });

    test("the per-dataset escape opens only for the custom preset and passes its selection through", async () => {
        const offered = presetCatalog(["alpha"]);
        expect(await resolveReferencePreset("custom", offered, { pick: async () => ["beta"] })).toEqual(["beta"]);
    });

    test("a cancelled picker declines, which is distinct from picking nothing", async () => {
        const offered = presetCatalog(["alpha"]);
        const announced: string[] = [];
        const cancelled = await resolveReferencePreset("custom", offered, { pick: async () => undefined, announce: (m) => announced.push(m) });
        expect(cancelled).toBeUndefined();
        // A cancellation is not an answer to "how do I get one later?", so it says nothing.
        expect(announced).toEqual([]);

        const emptied = await resolveReferencePreset("custom", offered, { pick: async () => [], announce: (m) => announced.push(m) });
        expect(emptied).toEqual([]);
        expect(announced).toEqual([ON_DEMAND_REFERENCE_NOTE]);
    });

    test("the take-nothing note names both routes to a later download", () => {
        expect(ON_DEMAND_REFERENCE_NOTE).toContain("inflexa refs download");
        // The agent route is only honest because `refs download` is registered `approval`, so the
        // agent proposes the command and the user approves it — the note must promise exactly that.
        expect(ON_DEMAND_REFERENCE_NOTE).toContain("agent");
        expect(ON_DEMAND_REFERENCE_NOTE).toContain("approve");
    });

    test("setup offers only what is missing, so an intact dataset is outside every preset", async () => {
        seedIntactInstall();
        const fixture = singleFileSource.catalog;
        const inspection = (await inspectReferenceStore(env.refsDir, fixture))._unsafeUnwrap();
        expect(inspection.datasets[0]?.state).toBe("installed");

        const offered = offeredReferenceCatalog(fixture, inspection);
        expect(offered.datasets).toEqual([]);
        // "Everything" over an intact store plans nothing rather than re-fetching what is already there.
        expect(await resolveReferencePreset("all", offered, { pick: unusedPicker, announce: () => {} })).toEqual([]);
    });
});

/** Records what a readout would paint, so the rendered strings can be asserted without a terminal. */
function recordingSink(): { readonly sink: ReferenceProgressSink; readonly snapshots: ReferenceProgressSnapshot[]; readonly failures: (string | undefined)[] } {
    const snapshots: ReferenceProgressSnapshot[] = [];
    const failures: (string | undefined)[] = [];
    return {
        snapshots,
        failures,
        sink: {
            start: (snapshot) => snapshots.push(snapshot),
            refresh: (snapshot) => snapshots.push(snapshot),
            advance: (snapshot) => snapshots.push(snapshot),
            finish: (snapshot, failure) => {
                snapshots.push(snapshot);
                failures.push(failure);
            },
        },
    };
}

describe("combined download progress", () => {
    test("a plan that fetches nothing gets no readout at all", () => {
        expect(createReferenceDownloadProgress(0)).toBeUndefined();
        expect(createReferenceDownloadProgress(-1)).toBeUndefined();
        expect(createReferenceDownloadProgress(NaN)).toBeUndefined();
    });

    test("the readout counts files and accumulates measured bytes", () => {
        const { sink, snapshots } = recordingSink();
        const readout = createReferenceDownloadProgress(2, sink);
        if (readout === undefined) throw new Error("a two-artifact plan must produce a readout");

        readout.report({ type: "artifact_started", datasetId: "demo", path: "a.txt", declaredBytes: 2048 });
        readout.report({ type: "artifact_bytes", bytes: 2048 });
        readout.report({ type: "artifact_completed", datasetId: "demo", path: "a.txt", bytes: 2048 });
        readout.finish();

        expect(snapshots[0]?.line).toBe("0/2 files · 0 B");
        const last = snapshots[snapshots.length - 1];
        expect(last?.line).toBe("1/2 files · 2.0 KB");
        expect(last?.completed).toBe(1);
        expect(last?.path).toBe("a.txt");
    });

    test("the completed count saturates at the planned total when a transfer outruns its estimate", () => {
        const { sink, snapshots } = recordingSink();
        const readout = createReferenceDownloadProgress(1, sink);
        if (readout === undefined) throw new Error("a one-artifact plan must produce a readout");

        readout.report({ type: "artifact_completed", datasetId: "demo", path: "a.txt", bytes: 10 });
        readout.report({ type: "artifact_completed", datasetId: "demo", path: "b.txt", bytes: 10 });
        readout.finish();

        expect(snapshots.map((snapshot) => snapshot.completed)).toEqual([0, 1, 1, 1]);
        expect(snapshots[snapshots.length - 1]?.line).toContain("1/1 files");
    });

    test("no rate is stated before the sample window can support one", () => {
        const { sink, snapshots } = recordingSink();
        const readout = createReferenceDownloadProgress(1, sink);
        if (readout === undefined) throw new Error("a one-artifact plan must produce a readout");

        // Every event lands within the same instant, so no window has accumulated: the rate segment
        // must be absent rather than rendered from a division by ~zero.
        readout.report({ type: "artifact_bytes", bytes: 5_000_000 });
        readout.report({ type: "artifact_completed", datasetId: "demo", path: "a.txt", bytes: 5_000_000 });
        readout.finish();
        expect(snapshots.every((snapshot) => !snapshot.line.includes("/s"))).toBe(true);
    });

    test("nothing in the readout is a fabricated total", () => {
        const { sink, snapshots } = recordingSink();
        const readout = createReferenceDownloadProgress(3, sink);
        if (readout === undefined) throw new Error("a three-artifact plan must produce a readout");

        readout.report({ type: "artifact_started", datasetId: "demo", path: "a.txt" });
        readout.report({ type: "artifact_bytes", bytes: 1234 });
        readout.report({ type: "artifact_completed", datasetId: "demo", path: "a.txt", bytes: 1234 });
        readout.finish("upstream refused the connection");

        // The catalog pins no sizes, so a percentage of bytes, an ETA, or a total-size denominator
        // would all be invented. The file count is the only denominator that is real.
        for (const { line } of snapshots) {
            expect(line).not.toContain("%");
            expect(line).not.toContain("ETA");
            expect(line).not.toContain("NaN");
            expect(line).not.toContain("Infinity");
            expect(line).not.toContain("/3 files ·  of ");
        }
    });
});
