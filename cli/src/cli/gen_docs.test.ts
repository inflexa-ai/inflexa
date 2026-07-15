import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import pkg from "../../package.json";

// The docs generator refuses to run in-process under `bun test` (src/lib/env.ts's data-loss guard,
// and the script's own NODE_ENV check) — the ONLY supported invocation is a plain `bun` process. So
// this suite spawns `bun scripts/gen_docs.ts` as a subprocess (never imports it, per the spec) with
// NODE_ENV cleared, and asserts on the dist-docs/ package it emits. This guards the portability layer
// (angle-bracket code-spanning, prose escaping) and dev-channel exclusion, which the "generation
// exits 0" CI gate cannot catch on its own.
const CLI_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(CLI_ROOT, "scripts", "gen_docs.ts");
const OUT_DIR = join(CLI_ROOT, "dist-docs");

type Manifest = { schemaVersion: number; cliVersion: string; name: string; nav: NavEntry[] };
type NavEntry = { title: string; path: string; items?: NavEntry[] };

function generate(): { exitCode: number; stderr: string } {
    // Bun.spawnSync's env REPLACES (not merges) the child environment, so copy the live env (Bun.env,
    // not process.env — sidesteps the no-restricted-properties lint) and drop NODE_ENV: under `bun test`
    // it is "test", which the generator refuses. The generator seeds its own XDG_* placeholders, so no
    // real user path is ever resolved regardless of the sandbox marker.
    const env = { ...Bun.env };
    delete env.NODE_ENV;
    const proc = Bun.spawnSync(["bun", SCRIPT], { cwd: CLI_ROOT, env });
    return { exitCode: proc.exitCode, stderr: proc.stderr.toString() };
}

/** Package-relative paths of every emitted markdown page (e.g. "prov/export.md"). */
function markdownFiles(): string[] {
    const found: string[] = [];
    const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
            const abs = join(dir, name);
            if (statSync(abs).isDirectory()) walk(abs);
            else if (name.endsWith(".md")) found.push(relative(OUT_DIR, abs));
        }
    };
    walk(OUT_DIR);
    return found;
}

/** Every `path` in the nav tree, flattened depth-first. */
function navPaths(nav: NavEntry[]): string[] {
    return nav.flatMap((entry) => [entry.path, ...(entry.items ? navPaths(entry.items) : [])]);
}

function read(rel: string): string {
    return readFileSync(join(OUT_DIR, rel), "utf8");
}

function readManifest(): Manifest {
    return JSON.parse(read("manifest.json")) as Manifest;
}

let gen: { exitCode: number; stderr: string };
beforeAll(() => {
    gen = generate();
});

describe("gen_docs (subprocess)", () => {
    test("generation succeeds and writes a versioned manifest", () => {
        expect(gen.exitCode, gen.stderr).toBe(0);
        const manifest = readManifest();
        expect(manifest.schemaVersion).toBe(1);
        expect(manifest.cliVersion).toBe(pkg.version);
        expect(manifest.name).toBe("inflexa");
    });

    test("dev-channel commands are excluded from pages and nav", () => {
        const files = markdownFiles();
        for (const dev of ["profile.md", "run.md", "chat.md"]) expect(files).not.toContain(dev);
        const paths = navPaths(readManifest().nav);
        for (const dev of ["profile.md", "run.md", "chat.md"]) expect(paths).not.toContain(dev);
    });

    test("nav covers every emitted page exactly once", () => {
        const paths = navPaths(readManifest().nav);
        expect(new Set(paths).size).toBe(paths.length); // no duplicates
        expect([...paths].sort()).toEqual(markdownFiles().sort()); // bijection with the .md files on disk
    });

    test("machine-emitted angle-bracket flags are always code-spanned", () => {
        // The root's `--analysis <id|name>` option is the canonical case: a raw `<...>` token parses as
        // an HTML tag downstream, so every occurrence of the flag must open a code span (backtick before).
        const index = read("index.md");
        let at = index.indexOf("--analysis");
        expect(at).toBeGreaterThan(-1);
        while (at !== -1) {
            expect(index[at - 1]).toBe("`");
            at = index.indexOf("--analysis", at + 1);
        }
    });

    test("angle brackets in description prose are escaped in frontmatter and body", () => {
        // `prov lineage`'s description embeds a literal `<ref>`; it must be escaped everywhere it appears
        // as prose (both the YAML frontmatter description and the rendered body), never left as raw HTML.
        const lineage = read("prov/lineage.md");
        const frontmatterDesc = lineage.split("\n").find((line) => line.startsWith("description:"));
        expect(frontmatterDesc).toContain("&lt;ref>");
        expect(frontmatterDesc).not.toContain("<ref>");
        expect(lineage).toContain("&lt;ref>"); // body prose too
    });

    test("regeneration is byte-identical", () => {
        const before = new Map(markdownFiles().map((f) => [f, readFileSync(join(OUT_DIR, f))]));
        before.set("manifest.json", readFileSync(join(OUT_DIR, "manifest.json")));
        expect(generate().exitCode).toBe(0);
        const after = new Map([...before.keys()].map((f) => [f, readFileSync(join(OUT_DIR, f))]));
        expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
        for (const [file, bytes] of before) expect(after.get(file)!.equals(bytes)).toBe(true);
    });
});
