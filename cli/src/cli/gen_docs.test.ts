import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import pkg from "../../package.json";
// Namespace import on purpose: the doc-list guard below enumerates env.ts's exports by NAME, so a list
// added there is discovered without editing this file — which is the whole point of the guard. Importing
// env.ts under `bun test` is safe: bunfig's [test].preload sandboxes XDG_* before any of it evaluates.
import * as envModule from "../lib/env.ts";

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

/**
 * The exported env-var doc lists of src/lib/env.ts, discovered by the `*EnvDoc` naming convention rather
 * than named here — a list this file had to be edited to know about could not catch the drift it guards:
 * a new list that reaches no render site and so vanishes from the published package.
 */
function exportedDocLists(): [string, unknown][] {
    // `unknown` because the guard's job is to survive a list whose shape it has never seen; the entries
    // are narrowed structurally in declaredVarNames rather than typed against today's two shapes.
    return Object.entries(envModule as Record<string, unknown>).filter(([name, value]) => /envdoc$/i.test(name) && typeof value === "object" && value !== null);
}

/**
 * Every environment-variable name a doc list declares, whatever its shape: a record keyed by `env` field
 * (`envDoc`) or a flat array (`modelConnectionEnvDoc`). A `kind: "path"` entry names no variable of its
 * own — the variable it contributes is the `baseVar` that relocates its directory.
 */
function declaredVarNames(list: unknown): string[] {
    const entries: unknown[] = Array.isArray(list) ? list : Object.values(list as Record<string, unknown>);
    const names: string[] = [];
    for (const entry of entries) {
        if (typeof entry !== "object" || entry === null) continue;
        const fields = entry as Record<string, unknown>;
        for (const field of ["name", "baseVar"]) {
            const value = fields[field];
            if (typeof value === "string") names.push(value);
        }
    }
    return names;
}

/** The `## Variables` table only — where `--help`'s Environment block's rows land (paths render above it). */
function variablesSection(): string {
    const page = read("environment.md");
    const at = page.indexOf("## Variables");
    expect(at, "the environment page has no Variables section").toBeGreaterThan(-1);
    return page.slice(at);
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

    // An env var that is a feature's ONLY channel (the two api-key secrets) is worse than undocumented
    // when it is visible in `--help` and missing from the published reference: the reader who consults
    // the website concludes the channel does not exist. These three tests keep the page whole from both
    // ends — every declared list reaches it, and the two secrets are named with their descriptions.
    test("every exported env-var doc list reaches the environment page", () => {
        const section = variablesSection();
        const listNames = exportedDocLists().map(([name]) => name);
        // Discovery smoke check: renaming the `*EnvDoc` convention must fail here, not silently reduce
        // this suite to iterating an empty set.
        for (const known of ["envDoc", "modelConnectionEnvDoc", "embeddingEnvDoc"]) expect(listNames).toContain(known);

        for (const [listName, list] of exportedDocLists()) {
            const varNames = declaredVarNames(list);
            expect(varNames.length, `${listName} declares no variable names — the guard cannot see it`).toBeGreaterThan(0);
            for (const varName of varNames) {
                expect(section, `${listName}: ${varName} reaches no rendered page — add a render site in scripts/gen_docs.ts`).toContain(varName);
            }
        }
    });

    // Static companion to the rendered check above: a list whose variables happen to be named by some
    // other row would satisfy the page assertion without ever being read. Asserted on the boolean, not
    // the source text, so a failure prints the naming message rather than the whole generator.
    test("the generator names every exported env-var doc list", () => {
        const source = readFileSync(SCRIPT, "utf8");
        for (const [listName] of exportedDocLists()) {
            expect(source.includes(listName), `scripts/gen_docs.ts never mentions ${listName}; its variables would ship undocumented`).toBe(true);
        }
    });

    test("the api-key secret channels are documented with descriptions", () => {
        const section = variablesSection();
        for (const varName of ["INFLEXA_MODEL_API_KEY", "INFLEXA_EMBEDDING_API_KEY"]) {
            const prefix = `| \`${varName}\` | `;
            const row = section.split("\n").find((line) => line.startsWith(prefix));
            expect(row, `${varName} has no row in the Variables table`).toBeDefined();
            const description = row!.slice(prefix.length, row!.lastIndexOf("|")).trim();
            expect(description, `${varName} is listed without a description`).not.toBe("");
        }
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
