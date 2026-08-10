import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The built modules must stay free of node-only imports, so a browser bundler can resolve the
 * whole package. A `node:`-prefixed specifier anywhere in `dist/` breaks a browser build, thus
 * this guard fails the suite before a consumer finds the regression. The guard reads `dist/`,
 * which the `prepare` script emits at install time — run `bun run build` if it is absent.
 */

const distDir = join(import.meta.dir, "..", "dist");

// One pattern per way an emitted module can name its dependency: a static import or re-export
// (`from "node:..."`), a bare side-effect import, a dynamic `import("node:...")`, and a
// CommonJS `require("node:...")`. A prose mention of `node:crypto` inside a kept comment is
// not a module specifier, thus a plain substring scan would over-match.
const nodeSpecifier = /\b(?:from|import|require)\s*\(?\s*["']node:/;

describe("browser safety of dist/", () => {
    test("the build output exists", () => {
        expect(existsSync(distDir)).toBe(true);
    });

    const files = existsSync(distDir) ? readdirSync(distDir).filter((f) => f.endsWith(".js")) : [];

    test("dist/ holds the built modules", () => {
        expect(files.length).toBeGreaterThan(0);
    });

    for (const file of files) {
        test(`${file} imports no node-only module`, () => {
            const source = readFileSync(join(distDir, file), "utf8");
            const hit = nodeSpecifier.exec(source);
            expect(hit?.[0]).toBeUndefined();
        });
    }
});
