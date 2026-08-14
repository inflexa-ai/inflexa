import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { randomUUIDv7 } from "bun";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PAGE_ASSETS } from "@inflexa-ai/harness/report-render/assets.js";

import { collectPageAssetEntries, type ResolveAssetSource } from "./page_assets.ts";

// The bytes of one fixture file. They carry the specifier, thus a collection that pairs a specifier with
// the file of a different specifier fails the byte assertion.
function fixtureBytes(specifier: string): Buffer {
    return Buffer.from(`source of ${specifier}`, "utf8");
}

let fixtureDir: string;
const sourceBySpecifier = new Map<string, string>();

// One file on disk for each entry of the manifest, under a name that the manifest does not carry. Thus the
// staged name in the archive comes from the manifest alone, and never from the name of the source file.
beforeEach(() => {
    fixtureDir = join(tmpdir(), `page-assets-test-${randomUUIDv7()}`);
    mkdirSync(fixtureDir, { recursive: true });
    sourceBySpecifier.clear();
    let index = 0;
    for (const asset of PAGE_ASSETS) {
        const source = join(fixtureDir, `source-${index}.bin`);
        writeFileSync(source, fixtureBytes(asset.specifier));
        sourceBySpecifier.set(asset.specifier, source);
        index++;
    }
});

afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
});

/** The resolution that answers each manifest specifier with its fixture file. */
function fixtureResolver(): ResolveAssetSource {
    return (specifier: string): string => {
        const source = sourceBySpecifier.get(specifier);
        // The manifest drives the fixture set, thus a miss means that the collection asked for a specifier
        // that the manifest does not carry.
        if (source === undefined) throw new Error(`no fixture for ${specifier}`);
        return source;
    };
}

describe("collectPageAssetEntries", () => {
    test("collects each manifest entry as assets/<file>, with the bytes of the file that the resolver named", () => {
        const entries = collectPageAssetEntries(fixtureResolver())._unsafeUnwrap();

        expect(entries.map((entry) => entry.path)).toEqual(PAGE_ASSETS.map((asset) => `assets/${asset.file}`));
        for (const [index, asset] of PAGE_ASSETS.entries()) {
            expect(entries[index]?.bytes.equals(fixtureBytes(asset.specifier))).toBe(true);
        }
    });

    test("an unresolvable specifier stops the collection and names that specifier", () => {
        // The manifest is a non-empty constant of the harness, thus the last entry is present. It also
        // proves that the loop reaches the tail before it fails.
        const unresolvable = PAGE_ASSETS[PAGE_ASSETS.length - 1]!;
        const resolver: ResolveAssetSource = (specifier) => {
            if (specifier === unresolvable.specifier) throw new Error("no resolution answers this specifier");
            return fixtureResolver()(specifier);
        };

        // An Err carries no entry at all, thus a partial set never reaches the archive.
        const error = collectPageAssetEntries(resolver)._unsafeUnwrapErr();

        expect(error).toMatchObject({ type: "unresolved_specifier", specifier: unresolvable.specifier });
    });

    test("a specifier that resolves to a path with no file behind it gives its own error", () => {
        // A resolver does not always read the disk, thus this failure is different from an unresolvable
        // specifier. The manifest is a non-empty constant of the harness, thus the first entry is present.
        const target = PAGE_ASSETS[0]!;
        const absent = join(fixtureDir, "no-file-here.bin");
        const resolver: ResolveAssetSource = (specifier) => (specifier === target.specifier ? absent : fixtureResolver()(specifier));

        const error = collectPageAssetEntries(resolver)._unsafeUnwrapErr();

        expect(error).toMatchObject({ type: "unreadable_source", specifier: target.specifier, path: absent });
    });

    test("an empty manifest gives the empty-manifest error", () => {
        // An empty manifest stages no file, and the boot guard of the binary then extracts the archive on
        // every start. The build must stop instead.
        const error = collectPageAssetEntries(fixtureResolver(), [])._unsafeUnwrapErr();

        expect(error.type).toBe("empty_manifest");
    });
});
