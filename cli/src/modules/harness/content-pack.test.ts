import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { randomUUIDv7 } from "bun";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { contentHashOf, packContent, unpackTo, type PackEntry } from "./content-pack.ts";

const FILES: PackEntry[] = [
    { path: "skills/foo/SKILL.md", bytes: Buffer.from("# Foo\nbody\n", "utf8") },
    { path: "skills/foo/references/api.md", bytes: Buffer.from("api ref", "utf8") },
    { path: "templates/report-html/base.html.j2", bytes: Buffer.from("{% block x %}{% endblock %}", "utf8") },
    // A file with bytes that include the header's structural characters, to prove the length-prefixed
    // body is sliced by size and never re-parsed.
    { path: "skills/bar/data.bin", bytes: Buffer.from([0x00, 0x7b, 0x22, 0x0a, 0xff, 0x04]) },
];

let dest: string;

beforeEach(() => {
    dest = join(tmpdir(), `content-pack-test-${randomUUIDv7()}`);
});

afterEach(() => {
    rmSync(dest, { recursive: true, force: true });
});

describe("packContent / unpackTo", () => {
    test("round-trips every file's exact bytes", () => {
        const written = unpackTo(packContent(FILES), dest)._unsafeUnwrap();
        expect([...written].sort()).toEqual([...FILES].map((f) => f.path).sort());
        for (const f of FILES) {
            expect(readFileSync(join(dest, f.path)).equals(f.bytes)).toBe(true);
        }
    });

    test("output is a pure function of the file set — insertion order does not matter", () => {
        const forward = packContent(FILES);
        const reversed = packContent([...FILES].reverse());
        expect(reversed.equals(forward)).toBe(true);
    });

    test("rejects an entry path that escapes the destination", () => {
        const evil = packContent([{ path: "../escape.md", bytes: Buffer.from("x") }]);
        expect(unpackTo(evil, dest)._unsafeUnwrapErr().type).toBe("unsafe_path");
    });

    test("reports a truncated archive rather than writing partial files", () => {
        const full = packContent(FILES);
        expect(unpackTo(full.subarray(0, full.length - 3), dest)._unsafeUnwrapErr().type).toBe("truncated");
    });

    test("reports a malformed header", () => {
        // header len 2, body "{!" — invalid JSON
        expect(unpackTo(Buffer.from([0, 0, 0, 2, 0x7b, 0x21]), dest)._unsafeUnwrapErr().type).toBe("malformed_header");
    });
});

describe("contentHashOf", () => {
    test("is stable across insertion order and independent of the pack format", () => {
        expect(contentHashOf(FILES)).toBe(contentHashOf([...FILES].reverse()));
    });

    test("changes when any file's bytes change", () => {
        const mutated = FILES.map((f, i) => (i === 0 ? { ...f, bytes: Buffer.from("# Foo\nCHANGED\n") } : f));
        expect(contentHashOf(mutated)).not.toBe(contentHashOf(FILES));
    });

    test("changes when a file is added or removed", () => {
        expect(contentHashOf(FILES.slice(1))).not.toBe(contentHashOf(FILES));
    });
});
