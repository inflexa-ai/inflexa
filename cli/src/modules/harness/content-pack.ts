// The bundled-content archive format, shared by three callers: the packer (scripts/build.ts, at build
// time), the unpacker (content.ts, in a release binary), and the round-trip test. It lives in its own
// module — not inlined in content.ts — so build.ts and the test can use it WITHOUT importing content.ts,
// whose embedded `with { type: "file" }` asset does not exist on disk in a dev checkout or under `bun test`.
//
// Why a bespoke format and not tar/zip: no archive library is a dependency and none may be added
// (cli/CLAUDE.md), and neither Bun nor Node ships a tar reader. The format is deliberately trivial so
// packing and unpacking are a few lines of pure fs each, cross-platform, and deterministic (no mtimes or
// ownership; entries sorted by path):
//
//   [0..4)      uint32 BE  headerLen H
//   [4..4+H)    utf-8      JSON `{ v, entries: [{ path, size }, ...] }`  (entries sorted by path)
//   [4+H..)     raw        each entry's bytes, concatenated in `entries` order
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

import { type Result, err, ok } from "neverthrow";

/** Archive layout version. Bumping it changes {@link contentHashOf} not at all (the hash is over content, not format), but a reader rejects a header whose `v` it does not recognize. */
export const PACK_VERSION = 1;

/** One file in the archive: its forward-slash relative path (e.g. `skills/foo/SKILL.md`) and raw bytes. */
export type PackEntry = { readonly path: string; readonly bytes: Buffer };

type Header = { readonly v: number; readonly entries: ReadonlyArray<{ readonly path: string; readonly size: number }> };

/** Why unpacking failed — each variant maps to one actionable cause. */
export type PackError =
    | { type: "malformed_header"; detail: string }
    | { type: "truncated"; detail: string }
    | { type: "unsafe_path"; path: string }
    | { type: "write_failed"; path: string; cause: unknown };

function byPath(a: PackEntry, b: PackEntry): number {
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Pack a file set into the archive buffer. Entries are sorted by path so the output is a pure function of the set. */
export function packContent(entries: ReadonlyArray<PackEntry>): Buffer {
    const sorted = [...entries].sort(byPath);
    const header: Header = { v: PACK_VERSION, entries: sorted.map((e) => ({ path: e.path, size: e.bytes.length })) };
    const headerBuf = Buffer.from(JSON.stringify(header), "utf8");
    const lenPrefix = Buffer.alloc(4);
    lenPrefix.writeUInt32BE(headerBuf.length, 0);
    return Buffer.concat([lenPrefix, headerBuf, ...sorted.map((e) => e.bytes)]);
}

/**
 * Deterministic identity of a file set — a hash over sorted `(path, sha256(bytes))` pairs. Deliberately
 * computed from content, NOT from {@link packContent}'s output, so a change to the archive FORMAT does not
 * churn the hash (and thus the on-disk extraction dir) while the content is unchanged. Truncated to 16 hex
 * chars (64 bits): it names a directory across a handful of installed versions, not a security boundary.
 */
export function contentHashOf(entries: ReadonlyArray<PackEntry>): string {
    const outer = createHash("sha256");
    for (const e of [...entries].sort(byPath)) {
        outer.update(e.path);
        outer.update("\0");
        outer.update(createHash("sha256").update(e.bytes).digest("hex"));
        outer.update("\n");
    }
    return outer.digest("hex").slice(0, 16);
}

/**
 * Unpack the archive into `destDir` (created if absent), writing each entry as a file. Pure fs, returns a
 * `Result` (no throw). Rejects any entry whose resolved path would escape `destDir` — the archive is our
 * own build output, but a reader must never let a crafted one write outside its target.
 */
export function unpackTo(archive: Buffer, destDir: string): Result<ReadonlyArray<string>, PackError> {
    if (archive.length < 4) return err({ type: "truncated", detail: "shorter than the 4-byte header length prefix" });
    const headerLen = archive.readUInt32BE(0);
    const headerEnd = 4 + headerLen;
    if (headerEnd > archive.length) return err({ type: "truncated", detail: "header length exceeds archive size" });

    let header: Header;
    try {
        header = JSON.parse(archive.subarray(4, headerEnd).toString("utf8")) as Header;
    } catch (cause) {
        return err({ type: "malformed_header", detail: String(cause) });
    }
    if (header.v !== PACK_VERSION || !Array.isArray(header.entries)) {
        return err({ type: "malformed_header", detail: `unexpected header (v=${String(header?.v)})` });
    }

    const root = resolve(destDir);
    const written: string[] = [];
    let offset = headerEnd;
    for (const entry of header.entries) {
        const end = offset + entry.size;
        if (end > archive.length) return err({ type: "truncated", detail: `body ends early at ${entry.path}` });
        const target = resolve(root, entry.path);
        if (target !== root && !target.startsWith(root + sep)) return err({ type: "unsafe_path", path: entry.path });
        try {
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, archive.subarray(offset, end));
        } catch (cause) {
            return err({ type: "write_failed", path: entry.path, cause });
        }
        written.push(entry.path);
        offset = end;
    }
    return ok(written);
}
