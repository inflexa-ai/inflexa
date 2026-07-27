import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb } from "../../db/primary.ts";
import { insertAnalysis, insertAnchor } from "../../db/primary_mutation.ts";
import { acquireInstanceLock, releaseInstanceLock } from "../../lib/lock.ts";
import { asStr256 } from "../../lib/types.ts";
import { runCli } from "../../test_support/cli.ts";
import { freshDb } from "../../test_support/db.ts";
import { writeMarker } from "../anchor/marker.ts";
import { describeGeoDownloadError } from "./download.ts";
import { parseByteSize } from "./geo.ts";

const created: string[] = [];

/**
 * A temp directory under its PHYSICAL path.
 *
 * macOS hands back `/var/folders/…`, a symlink to `/private/var/…`, while the subprocess's own
 * `process.cwd()` reports the resolved one — seeding the unresolved spelling would leave every path
 * assertion comparing two names for one directory.
 */
function tmp(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-geo-dl-")));
    created.push(dir);
    return dir;
}

/** A folder that IS an anchor: the on-disk marker plus the row whose cached path points back at it. */
function anchorAt(id: string, dir: string): void {
    writeMarker(dir, id)._unsafeUnwrap();
    insertAnchor({ id, createdAt: 1, updatedAt: 1, cachedPath: dir, markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
}

function analysisOn(id: string, name: string, anchorId: string): void {
    insertAnalysis({ id, createdAt: 1, updatedAt: 1, name: asStr256(name), slug: name, anchorId, projectId: null })._unsafeUnwrap();
}

beforeEach(() => {
    freshDb();
});

afterEach(() => {
    // Several tests leave a folder read-only to trip the writability guard; restore the write bit first
    // or the temp directory outlives the run.
    for (const dir of created) {
        chmodSync(dir, 0o755);
        rmSync(dir, { recursive: true, force: true });
    }
    created.length = 0;
});

// Every test here runs offline, and that is a property of WHERE the command's guards sit: the accession
// parse, the `--max-size` parse, folder resolution, and the writability pre-check all run before
// `downloadGeoSeries` is reached. Reordering any of them past the transfer would silently turn these into
// tests that call NCBI, which is the reason the pre-check's position is commented at its call site.
//
// EVERY test closes the database before spawning, whether or not it seeded anything. The child opens the
// same sandboxed file this process has open, and a connection still held here leaves it unable to start:
// it exits 1 having printed NOTHING, so the exit-code assertion passes and only the message assertion
// fails. That failure needs the write volume of a full-suite run to appear at all — a single test file
// leaves too little behind — so an omission here is invisible in exactly the run used to check it.
describe("inflexa geo download — argument gates (e2e)", () => {
    test("a malformed accession is refused before the target folder is even resolved", () => {
        // A bare folder: had the accession gate run AFTER resolution, this would fail with "No analysis here".
        const dir = tmp();
        closeDb();
        const result = runCli(["geo", "download", "GSM12345"], { cwd: dir });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Not a GEO Series accession: "GSM12345"');
        expect(result.stderr).not.toContain("No analysis here");
    });

    test("an unparseable --max-size is refused before resolution, and a valid one is not", () => {
        const dir = tmp();
        closeDb();
        const bad = runCli(["geo", "download", "GSE12345", "--max-size", "banana"], { cwd: dir });
        expect(bad.exitCode).toBe(1);
        expect(bad.stderr).toContain('Not a size: "banana"');
        expect(bad.stderr).not.toContain("No analysis here");

        // The same run with a parseable size gets past the gate and fails at resolution instead — which is
        // what proves the first assertion was the size gate rather than resolution failing for both.
        const good = runCli(["geo", "download", "GSE12345", "--max-size", "500MB"], { cwd: dir });
        expect(good.exitCode).toBe(1);
        expect(good.stderr).toContain("No analysis here");
    });
});

describe("inflexa geo download — target folder resolution (e2e)", () => {
    test("a folder with no marker says how to start, not how to disambiguate", () => {
        const dir = tmp();
        closeDb();
        const result = runCli(["geo", "download", "GSE12345"], { cwd: dir });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("No analysis here — run `inflexa new` to create one, or pass --analysis <id|name>.");
    });

    test("an anchor holding several analyses still resolves to the one shared folder", () => {
        const dir = tmp();
        anchorAt("A1", dir);
        analysisOn("an1", "alpha", "A1");
        analysisOn("an2", "beta", "A1");
        closeDb();
        // The read-only bit turns the pre-transfer writability guard into a resolution probe: its message
        // names the folder that was resolved, and the run stops before any request.
        chmodSync(dir, 0o555);

        const result = runCli(["geo", "download", "GSE12345"], { cwd: dir });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(`${dir} is not writable, so GSE12345 cannot be downloaded there.`);
        // The design claim this pins: unlike the commands that need exactly one analysis, this one wants a
        // FOLDER, so two analyses sharing one is not an ambiguity it has to resolve.
        expect(result.stderr).not.toContain("--analysis");
    });

    test("a marker whose anchor row the database no longer has still resolves to the marker's folder", () => {
        const dir = tmp();
        writeMarker(dir, "A9")._unsafeUnwrap();
        closeDb();
        chmodSync(dir, 0o555);

        // Routine desync, not an error: the row is gone, the marker is not, and the folder is what was asked for.
        const result = runCli(["geo", "download", "GSE12345"], { cwd: dir });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(`${dir} is not writable`);
    });

    test("--analysis targets that analysis's home folder, not the working directory", () => {
        const home = tmp();
        const elsewhere = tmp();
        anchorAt("A2", home);
        analysisOn("an3", "gamma", "A2");
        closeDb();
        chmodSync(home, 0o555);

        const result = runCli(["geo", "download", "gse12345", "--analysis", "gamma"], { cwd: elsewhere });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(`${home} is not writable`);
        expect(result.stderr).not.toContain(elsewhere);
        // Lower-case argv, upper-case readout: the accession is normalized before it reaches any message.
        expect(result.stderr).toContain("GSE12345");
    });

    test("an unmatched --analysis names the ref and lists the analyses that do exist", () => {
        anchorAt("A4", tmp());
        analysisOn("an4", "delta", "A4");
        analysisOn("an5", "epsilon", "A4");
        closeDb();

        const result = runCli(["geo", "download", "GSE12345", "--analysis", "nope"]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('No analysis matches "nope"');
        expect(result.stderr).toContain("Known analyses:");
        expect(result.stderr).toContain("delta");
        expect(result.stderr).toContain("epsilon");
    });

    test("a copied folder is refused with the repair/relocate way forward", () => {
        const original = tmp();
        const copy = tmp();
        anchorAt("A3", original);
        // The same marker in a second place while the original still exists — a copied folder, not a moved one.
        writeMarker(copy, "A3")._unsafeUnwrap();
        closeDb();

        const result = runCli(["geo", "download", "GSE12345"], { cwd: copy });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("This folder looks copied — run `inflexa repair` or `inflexa relocate` before downloading into it.");
    });

    test("the download never claims the analysis instance lock", () => {
        const dir = tmp();
        anchorAt("A5", dir);
        analysisOn("an6", "held", "A5");
        closeDb();
        chmodSync(dir, 0o555);

        // Held by THIS process, whose pid is alive, so a child that tried to claim it would see a live
        // foreign holder and refuse. This is the regression guard for "safe to run beside a live TUI".
        acquireInstanceLock("an6");
        try {
            const result = runCli(["geo", "download", "GSE12345", "--analysis", "held"], { cwd: dir });
            expect(result.stderr).toContain(`${dir} is not writable`);
            expect(result.stderr).not.toContain("already open in another instance");
        } finally {
            releaseInstanceLock("an6");
        }
    });
});

// Unreachable end-to-end — the command threads no fetch seam into `downloadGeoSeries`, so no offline run
// can produce a transfer error. These are the messages a user acts on, so they are asserted directly.
describe("describeGeoDownloadError", () => {
    test("the too_large remedy names a ceiling that would actually admit the series", () => {
        const cap = 32 * 1024 ** 3;
        for (const declaredBytes of [1024, 500 * 1024 ** 2, cap + 1, Math.floor(32.5 * 1024 ** 3), 33 * 1024 ** 3 + 1]) {
            const message = describeGeoDownloadError({ type: "too_large", declaredBytes, cap }, "GSE12345");
            const quoted = /--max-size (\S+)/.exec(message)?.[1];
            expect(quoted).toBeDefined();
            // A remedy is only a remedy if re-running with it clears the cap that just refused. Rounding the
            // suggestion DOWN would hand the user a ceiling the same series fails against a second time.
            expect(parseByteSize(quoted ?? "")).toBeGreaterThanOrEqual(declaredBytes);
        }
    });

    test("no_processed_files sends the user to the accession, not to a retry", () => {
        const message = describeGeoDownloadError({ type: "no_processed_files", accession: "GSE12345" }, "GSE12345");
        expect(message).toContain("exposes no downloadable processed files");
        expect(message).toContain("Nothing was downloaded.");
        // Waiting helps a throttled request; it does nothing for a series that publishes no files.
        expect(message).not.toContain("wait a minute");
    });

    test("unreachable carries the upstream detail and tells the user to wait", () => {
        const message = describeGeoDownloadError({ type: "unreachable", message: "connect ECONNREFUSED" }, "GSE12345");
        expect(message).toContain("connect ECONNREFUSED");
        expect(message).toContain("wait a minute and re-run");
    });

    test("every transfer failure ends with the nothing-was-downloaded guarantee", () => {
        for (const type of ["insecure_redirect", "http_failed", "io_failed"] as const) {
            const message = describeGeoDownloadError({ type, message: "boom" }, "GSE12345");
            expect(message).toContain("GSE12345");
            expect(message).toContain("boom");
            // The all-or-nothing promise is the one thing every failure arm has to keep saying.
            expect(message.trimEnd().endsWith("Nothing was downloaded.")).toBe(true);
        }
    });
});
