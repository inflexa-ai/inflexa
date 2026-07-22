import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
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
    PROGRESS_RATE_WINDOW_MS,
    createReferenceDownloadProgress,
    downloadReferences,
    offeredReferenceCatalog,
    onDemandReferenceNote,
    onDemandReferencePanel,
    parseReferenceIds,
    plainProgressSink,
    referenceNoteFloats,
    referencePickerBulkSelection,
    referencePickerModel,
    referenceSelectionDisclosure,
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

/** A multi-dataset offer with mixed recommendations — the shape the picker actually resolves against. */
function pickerCatalog(recommended: readonly string[], ids: readonly string[] = ["alpha", "beta", "gamma"]): ReferenceDataCatalog {
    const base = catalog([FILE_ARTIFACT]).datasets[0];
    if (base === undefined) throw new Error("fixture catalog lost its dataset");
    return {
        version: REFERENCE_DATA_CATALOG_VERSION,
        datasets: ids.map((id) => ({
            ...base,
            id,
            title: id,
            recommendation: { group: id === "gamma" ? "second" : "testing", recommended: recommended.includes(id) },
        })),
    };
}

describe("reference selection picker", () => {
    test("the model lists every offered dataset, grouped in catalog order", () => {
        const model = referencePickerModel(pickerCatalog(["alpha"]));
        expect(Object.keys(model.groups)).toEqual(["testing", "second"]);
        expect(model.groups["testing"]?.map((entry) => entry.value)).toEqual(["alpha", "beta"]);
        expect(model.groups["second"]?.map((entry) => entry.value)).toEqual(["gamma"]);
        // Every row states what it costs, which is the whole reason the listing is the primary view.
        expect(model.groups["testing"]?.[0]?.label).toBe("alpha (1 file)");
        expect(model.groups["testing"]?.[0]?.hint).toBe("recommended");
        expect(model.groups["testing"]?.[1]?.hint).toBeUndefined();
        expect(model.everything).toEqual(["alpha", "beta", "gamma"]);
        expect(model.recommended).toEqual(["alpha"]);
    });

    test("each bulk key replaces the selection outright", () => {
        const model = referencePickerModel(pickerCatalog(["alpha", "gamma"]));
        expect(referencePickerBulkSelection("a", model)).toEqual(["alpha", "beta", "gamma"]);
        expect(referencePickerBulkSelection("n", model)).toEqual([]);
        expect(referencePickerBulkSelection("r", model)).toEqual(["alpha", "gamma"]);
        // Shift-held is the same intent, and every other key belongs to the prompt.
        expect(referencePickerBulkSelection("R", model)).toEqual(["alpha", "gamma"]);
        expect(referencePickerBulkSelection(" ", model)).toBeUndefined();
        expect(referencePickerBulkSelection("j", model)).toBeUndefined();
        expect(referencePickerBulkSelection(undefined, model)).toBeUndefined();
    });

    test("the recommended key is inert, never destructive, when nothing offered is recommended", () => {
        // The state a second `inflexa setup` run reaches once the recommended datasets are installed:
        // only optional ones are still offered. Resolving to `[]` here would make a key labelled
        // "recommended" behave as "none" and silently discard whatever the user had ticked.
        const model = referencePickerModel(pickerCatalog([]));
        expect(model.recommended).toEqual([]);
        expect(referencePickerBulkSelection("r", model)).toBeUndefined();
        expect(referencePickerBulkSelection("n", model)).toEqual([]);
    });

    test("the legend keeps the recommended key visible, annotated rather than dropped", () => {
        // The reported defect was the recommended option vanishing from the prompt when the offered
        // set carried no recommendation — indistinguishable, to the reader, from a lost feature.
        expect(referencePickerModel(pickerCatalog(["alpha"])).footer).toBe("↑/↓ move · space toggle · a all · r recommended · n none · enter confirm");
        // Nothing recommended and nothing withheld: the offer genuinely has none to give.
        expect(referencePickerModel(pickerCatalog([])).footer).toBe("↑/↓ move · space toggle · a all · r recommended (none offered) · n none · enter confirm");
    });

    test("an empty recommended key names the install that emptied it", () => {
        // "none offered" is true but unhelpful when the reason is a prior success — the count is what
        // answers the question the reader actually has, which is where the recommended ones went.
        const withheld = pickerCatalog(["one", "two"], ["one", "two", "three"]).datasets;
        expect(referencePickerModel(pickerCatalog([]), withheld).footer).toBe(
            "↑/↓ move · space toggle · a all · r recommended (2 already installed) · n none · enter confirm",
        );
        // It counts the recommended installs, not every install: those are different numbers whenever
        // an optional dataset is installed too, and only the recommended ones explain this key.
        expect(referencePickerModel(pickerCatalog([]), pickerCatalog([], ["one"]).datasets).footer).toContain("r recommended (none offered)");
        // An offer that still has recommendations to give is never annotated at all.
        expect(referencePickerModel(pickerCatalog(["alpha"]), withheld).footer).toContain("r recommended ·");
    });

    test("the disclosure names what the listing omits", () => {
        expect(referenceSelectionDisclosure([])).toEqual([]);
        expect(referenceSelectionDisclosure(pickerCatalog([], ["one"]).datasets)).toEqual(["1 dataset is already installed and intact — not listed below."]);
        expect(referenceSelectionDisclosure(pickerCatalog([], ["one", "two"]).datasets)).toEqual([
            "2 datasets are already installed and intact — not listed below.",
        ]);
    });

    test("the on-demand note names both routes to a later download", () => {
        // Asserted against the copy rather than one layout of it: the prose is wrapped to a width, so
        // any phrase longer than a few words is split by a line break in some rendering of it.
        const prose = ON_DEMAND_REFERENCE_NOTE.replace(/\s+/g, " ");
        // The command keeps its own unwrapped line in every layout, so this one is asserted verbatim.
        expect(ON_DEMAND_REFERENCE_NOTE).toContain("  inflexa refs download <id>");
        // The agent route is only honest because `refs download` is registered `approval`, so the
        // agent proposes the command and the user approves it — the note must promise exactly that.
        expect(prose).toContain("asks you to approve the download");
        // It frames the choice instead of consoling an empty one, so it must read as guidance offered
        // before the fact rather than as a reply to a decision already taken.
        expect(prose).toContain("taking none now is a real choice");
    });

    test("the note wraps to whatever width it is given, and never breaks the command", () => {
        for (const width of [36, 40, 74]) {
            const lines = onDemandReferenceNote(width);
            expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(width);
            // A wrapped command is an uncopyable command, so its line survives every layout intact.
            expect(lines).toContain("  inflexa refs download <id>");
        }
    });

    test("the floating note is a closed box of exactly the width it was asked for", () => {
        const panel = onDemandReferencePanel(40);
        // Uniform width is what lets the renderer pad rows to one column and get a straight edge.
        expect(new Set(panel.map((line) => line.length))).toEqual(new Set([42]));
        expect(panel[0]?.startsWith("╭─ No rush ")).toBe(true);
        expect(panel[0]?.endsWith("╮")).toBe(true);
        expect(panel[panel.length - 1]).toBe(`╰${"─".repeat(40)}╯`);
        // Every interior line opens and closes on a border glyph — the invariant the renderer relies
        // on to colour the frame by position without touching the text between.
        for (const line of panel.slice(1, -1)) {
            expect(line.startsWith("│")).toBe(true);
            expect(line.endsWith("│")).toBe(true);
        }
        expect(panel.join("\n")).toContain("inflexa refs download <id>");
    });

    test("the note floats only where the listing keeps a usable width", () => {
        // The panel plus its gap and the guide rail claim 49 columns; below that the listing would be
        // squeezed harder than the note is worth, so the note goes back above the list.
        expect(referenceNoteFloats(105)).toBe(true);
        expect(referenceNoteFloats(104)).toBe(false);
        expect(referenceNoteFloats(80)).toBe(false);
    });

    test("setup offers only what is missing, so an intact dataset is outside every bulk key", async () => {
        seedIntactInstall();
        const fixture = singleFileSource.catalog;
        const inspection = (await inspectReferenceStore(env.refsDir, fixture))._unsafeUnwrap();
        expect(inspection.datasets[0]?.state).toBe("installed");

        const offered = offeredReferenceCatalog(fixture, inspection);
        expect(offered.datasets).toEqual([]);
        const withheld = inspection.datasets.map((item) => item.dataset);
        // "Select everything" over an intact store plans nothing rather than re-fetching what is
        // already there, and the disclosure is what stops that reading as an empty prompt.
        expect(referencePickerBulkSelection("a", referencePickerModel(offered, withheld))).toEqual([]);
        expect(referenceSelectionDisclosure(withheld)).toEqual(["1 dataset is already installed and intact — not listed below."]);
        // The fixture's one dataset is recommended, so installing it reproduces the reported state end
        // to end: an offer with nothing left to recommend, now accounted for rather than unexplained.
        expect(referencePickerModel(offered, withheld).footer).toContain("r recommended (1 already installed)");
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
        readout.report({ type: "artifact_bytes", datasetId: "demo", path: "a.txt", bytes: 2048 });
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
        readout.report({ type: "artifact_bytes", datasetId: "demo", path: "b.txt", bytes: 5_000_000 });
        readout.report({ type: "artifact_completed", datasetId: "demo", path: "a.txt", bytes: 5_000_000 });
        readout.finish();
        expect(snapshots.every((snapshot) => !snapshot.line.includes("/s"))).toBe(true);
    });

    test("nothing in the readout is a fabricated total", () => {
        const { sink, snapshots } = recordingSink();
        const readout = createReferenceDownloadProgress(3, sink);
        if (readout === undefined) throw new Error("a three-artifact plan must produce a readout");

        readout.report({ type: "artifact_started", datasetId: "demo", path: "a.txt" });
        readout.report({ type: "artifact_bytes", datasetId: "demo", path: "a.txt", bytes: 1234 });
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

describe("progress readout teardown", () => {
    test("a throw inside the transfer still closes the readout", async () => {
        // The estimate resolves the plan, then the installer resolves it again. Throwing only on the
        // second call puts the failure inside the window where the readout is live — the one exit the
        // installer's own Result channel cannot describe.
        let resolutions = 0;
        const explodingSource: ReferenceCatalogSource = {
            catalog: singleFileSource.catalog,
            resolveInstallPlan: (ids) => {
                resolutions += 1;
                if (resolutions > 1) throw new Error("catalog seam exploded mid-transfer");
                return singleFileSource.resolveInstallPlan(ids);
            },
        };

        let thrown: unknown;
        const { stdout } = await capture(async () => {
            try {
                await downloadReferences({ ids: ["demo"], yes: true, interactive: false, source: explodingSource });
            } catch (cause) {
                thrown = cause;
            }
        });

        expect((thrown as Error | undefined)?.message).toBe("catalog seam exploded mid-transfer");
        // Without the teardown the repaint timer would still be running and, on a terminal, the bar
        // would still own the screen. The closing line is the observable proof it was torn down.
        expect(stdout).toContain("Download failed at 0/1 files");
    });
});

describe("progress readout without a terminal", () => {
    test("paints one line per completed artifact and never an escape sequence", async () => {
        const { stdout } = await capture(async () => {
            const readout = createReferenceDownloadProgress(2, plainProgressSink());
            if (readout === undefined) throw new Error("a two-artifact plan must produce a readout");
            readout.report({ type: "artifact_started", datasetId: "demo", path: "a.txt", declaredBytes: 2048 });
            readout.report({ type: "artifact_bytes", datasetId: "demo", path: "a.txt", bytes: 1024 });
            readout.report({ type: "artifact_bytes", datasetId: "demo", path: "a.txt", bytes: 1024 });
            readout.report({ type: "artifact_completed", datasetId: "demo", path: "a.txt", bytes: 2048 });
            readout.report({ type: "artifact_started", datasetId: "demo", path: "b.txt" });
            readout.report({ type: "artifact_bytes", datasetId: "demo", path: "b.txt", bytes: 512 });
            readout.report({ type: "artifact_completed", datasetId: "demo", path: "b.txt", bytes: 512 });
            readout.finish();
        });

        // A byte delta paints nothing: an opening line, one line per completed artifact, one closing
        // line. Anything more would be a line per chunk in a captured log.
        expect(stdout.split("\n").filter(Boolean)).toEqual([
            "Downloading 2 reference files…",
            "  1/2 files · 2.0 KB — a.txt",
            "  2/2 files · 2.5 KB — b.txt",
            "Downloaded 2/2 files · 2.5 KB",
        ]);
        // Every ANSI sequence opens with ESC, so its absence is the whole claim: nothing cursor-like
        // reaches a stream that is not a terminal.
        expect(stdout.includes("\u001b")).toBe(false);
    });
});

describe("in-flight artifact reporting", () => {
    test("a declared size is reported as a measured fraction, and only while that file is open", () => {
        const { sink, snapshots } = recordingSink();
        const readout = createReferenceDownloadProgress(2, sink);
        if (readout === undefined) throw new Error("a two-artifact plan must produce a readout");

        readout.report({ type: "artifact_started", datasetId: "demo", path: "a.txt", declaredBytes: 4096 });
        readout.report({ type: "artifact_bytes", datasetId: "demo", path: "a.txt", bytes: 1024 });
        expect(snapshots[snapshots.length - 1]?.line).toBe("0/2 files · 1.0 KB · 1 in flight 1.0 KB/4.0 KB");

        readout.report({ type: "artifact_completed", datasetId: "demo", path: "a.txt", bytes: 4096 });
        // The fraction describes what is still open, so it leaves with the file that declared it.
        expect(snapshots[snapshots.length - 1]?.line).toBe("1/2 files · 1.0 KB");

        // An upstream that declares nothing is the normal case, and it contributes no fraction.
        readout.report({ type: "artifact_started", datasetId: "demo", path: "b.txt" });
        readout.report({ type: "artifact_bytes", datasetId: "demo", path: "b.txt", bytes: 2048 });
        expect(snapshots[snapshots.length - 1]?.line).toBe("1/2 files · 1.0 KB · 1 in flight");

        readout.report({ type: "artifact_completed", datasetId: "demo", path: "b.txt", bytes: 2048 });
        // Those 2 KB arrived inside the redraw throttle, so they painted nothing at the time — but a
        // throttled repaint must never be a lost byte, and the completion line proves they counted.
        expect(snapshots[snapshots.length - 1]?.line).toBe("2/2 files · 3.0 KB");

        readout.finish();
        expect(snapshots[snapshots.length - 1]?.line).toBe("2/2 files · 3.0 KB");
    });

    test("concurrent transfers aggregate over exactly the open set", () => {
        const { sink, snapshots } = recordingSink();
        const readout = createReferenceDownloadProgress(4, sink);
        if (readout === undefined) throw new Error("a four-artifact plan must produce a readout");

        readout.report({ type: "artifact_started", datasetId: "alpha", path: "a.txt", declaredBytes: 1024 });
        readout.report({ type: "artifact_started", datasetId: "beta", path: "b.txt", declaredBytes: 3072 });
        readout.report({ type: "artifact_bytes", datasetId: "alpha", path: "a.txt", bytes: 512 });
        expect(snapshots[snapshots.length - 1]?.line).toBe("0/4 files · 512 B · 2 in flight 512 B/4.0 KB");

        // One file leaving takes only its own share of both sides of the fraction with it.
        readout.report({ type: "artifact_completed", datasetId: "alpha", path: "a.txt", bytes: 1024 });
        expect(snapshots[snapshots.length - 1]?.line).toBe("1/4 files · 512 B · 1 in flight 0 B/3.0 KB");

        // A third transfer that declares nothing collapses the fraction for the whole set: summing a
        // denominator over some of what is open would read as a total while describing a subset.
        readout.report({ type: "artifact_started", datasetId: "gamma", path: "c.txt" });
        expect(snapshots[snapshots.length - 1]?.line).toBe("1/4 files · 512 B · 2 in flight");

        readout.finish();
        expect(snapshots[snapshots.length - 1]?.line).toBe("1/4 files · 512 B");
    });

    test("interleaved deltas land on their own artifact, never on the one that started last", () => {
        const { sink, snapshots } = recordingSink();
        const readout = createReferenceDownloadProgress(2, sink);
        if (readout === undefined) throw new Error("a two-artifact plan must produce a readout");

        readout.report({ type: "artifact_started", datasetId: "alpha", path: "a.txt", declaredBytes: 8192 });
        readout.report({ type: "artifact_started", datasetId: "beta", path: "b.txt", declaredBytes: 8192 });
        // Bytes for the artifact that started FIRST, arriving after the second one opened — the exact
        // case an unattributed delta would misfile.
        readout.report({ type: "artifact_bytes", datasetId: "alpha", path: "a.txt", bytes: 4096 });
        readout.report({ type: "artifact_completed", datasetId: "beta", path: "b.txt", bytes: 0 });

        // Beta leaves having received nothing, so the surviving fraction is alpha's 4 KB of its 8 KB.
        expect(snapshots[snapshots.length - 1]?.line).toBe("1/2 files · 4.0 KB · 1 in flight 4.0 KB/8.0 KB");
        readout.finish();
    });
});

describe("transfer rate", () => {
    const START = new Date("2026-07-22T00:00:00.000Z").getTime();

    afterEach(() => {
        setSystemTime();
    });

    test("a rate appears once the window supports one, and decays away when the transfer stalls", () => {
        setSystemTime(new Date(START));
        const { sink, snapshots } = recordingSink();
        const readout = createReferenceDownloadProgress(2, sink);
        if (readout === undefined) throw new Error("a two-artifact plan must produce a readout");

        readout.report({ type: "artifact_bytes", datasetId: "demo", path: "b.txt", bytes: 1_048_576 });
        expect(snapshots[snapshots.length - 1]?.line).not.toContain("/s");

        // Two samples, 2s apart, 2 MiB apart: the window now supports a rate.
        setSystemTime(new Date(START + 2_000));
        readout.report({ type: "artifact_bytes", datasetId: "demo", path: "b.txt", bytes: 2_097_152 });
        expect(snapshots[snapshots.length - 1]?.line).toBe("0/2 files · 3.0 MB · 1.0 MB/s");

        // Nothing arrives for longer than the window. The next repaint must not restate a rate the
        // connection is no longer sustaining — a frozen number reads as motion that is not happening.
        setSystemTime(new Date(START + 2_000 + PROGRESS_RATE_WINDOW_MS + 1));
        readout.report({ type: "artifact_completed", datasetId: "demo", path: "a.txt", bytes: 3_145_728 });
        expect(snapshots[snapshots.length - 1]?.line).toBe("1/2 files · 3.0 MB");

        readout.finish();
    });
});
