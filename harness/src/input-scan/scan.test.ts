import { describe, expect, it } from "bun:test";
import { ResultAsync, ok } from "neverthrow";

import type { AgentSession } from "../auth/types.js";
import type { FsError } from "../lib/fs-result.js";
import type { ListResult, ReadBytesResult, StatResult, ReadFileResult, WorkspaceFilesystem } from "../workspace/filesystem.js";
import { MAX_SCANNED_FILES, renderInputScanManifest, scanInputTree } from "./scan.js";

const SESSION = { scope: { kind: "analysis", analysisId: "a1" } } as unknown as AgentSession;

function okAsync<T>(value: T): ResultAsync<T, FsError> {
    return new ResultAsync(Promise.resolve(ok(value)));
}

/** A tree of `path -> bytes`, listed lazily so a large fixture costs nothing to build. */
function fakeFs(paths: readonly string[], bytesFor: (path: string) => Buffer = () => Buffer.alloc(0)): WorkspaceFilesystem {
    const set = new Set(paths);
    return {
        readFile: () => okAsync<ReadFileResult>({ kind: "not_found" }),
        readBytes: ({ path }) => okAsync<ReadBytesResult>(set.has(path) ? { kind: "ok", bytes: bytesFor(path) } : { kind: "not_found" }),
        stat: () => okAsync<StatResult>({ kind: "not_found" }),
        list: ({ path }) => {
            const prefix = path === "" ? "" : `${path}/`;
            const names = new Map<string, "file" | "directory">();
            for (const candidate of set) {
                if (!candidate.startsWith(prefix)) continue;
                const rest = candidate.slice(prefix.length);
                if (rest === "") continue;
                const slash = rest.indexOf("/");
                if (slash < 0) names.set(rest, "file");
                else names.set(rest.slice(0, slash), "directory");
            }
            if (names.size === 0) return okAsync<ListResult>({ kind: "not_found" });
            return okAsync<ListResult>({
                kind: "ok",
                entries: [...names].map(([name, type]) => (type === "file" ? { name, type, size: 100 } : { name, type })),
            });
        },
    };
}

describe("scanInputTree", () => {
    it("walks nested directories in one pass", async () => {
        const paths = ["data/inputs/vcf/S001.vcf.gz", "data/inputs/vcf/S002.vcf.gz", "data/inputs/meta/samplesheet.csv", "data/inputs/docs/paper.pdf"];
        const scan = await scanInputTree({ session: SESSION, fs: fakeFs(paths), root: "data/inputs" });

        expect(scan.files.map((f) => f.path).sort()).toEqual([...paths].sort());
        expect(scan.manifest.fileCount).toBe(4);
        expect(scan.manifest.truncated).toBe(false);
    });

    it("detects format from bytes during the walk", async () => {
        const bytes = (path: string) =>
            path.endsWith(".csv") ? Buffer.from("id,value\n1,2\n") : Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
        const scan = await scanInputTree({
            session: SESSION,
            fs: fakeFs(["data/inputs/a.vcf.gz", "data/inputs/b.csv"], bytes),
            root: "data/inputs",
        });

        const vcf = scan.files.find((f) => f.path.endsWith(".vcf.gz"))!;
        expect(vcf.format).toBe("vcf");
        expect(vcf.wrapper).toBe("gzip");
        expect(scan.files.find((f) => f.path.endsWith(".csv"))!.format).toBe("csv");
    });

    it("stops at its ceiling and says so, rather than sampling silently", async () => {
        const paths = Array.from({ length: 50 }, (_, i) => `data/inputs/run_${i}.csv`);
        const scan = await scanInputTree({ session: SESSION, fs: fakeFs(paths), root: "data/inputs", limit: 20 });

        expect(scan.files).toHaveLength(20);
        expect(scan.manifest.truncated).toBe(true);
        expect(scan.manifest.scanLimit).toBe(20);
        expect(renderInputScanManifest(scan.manifest)).toContain("INCOMPLETE");
    });

    it("has a ceiling two orders of magnitude above the largest observed tree", () => {
        expect(MAX_SCANNED_FILES).toBeGreaterThanOrEqual(100_000);
    });

    it("renders a bounded briefing for a large tree", async () => {
        const paths = Array.from({ length: 3200 }, (_, i) => `data/inputs/vcf/PATIENT_${String(i + 1).padStart(4, "0")}.vcf.gz`);
        const scan = await scanInputTree({ session: SESSION, fs: fakeFs(paths), root: "data/inputs" });
        const rendered = renderInputScanManifest(scan.manifest);

        expect(scan.manifest.fileCount).toBe(3200);
        // ~2 KB of structure in place of ~270 KB of bare paths, and not one line per file.
        expect(rendered.length).toBeLessThan(4000);
        expect(rendered.split("\n").length).toBeLessThan(60);
        expect(rendered).toContain("3200 files");
    });
});
