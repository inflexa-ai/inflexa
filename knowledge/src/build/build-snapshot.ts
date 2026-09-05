/**
 * Build one snapshot: load the tree, run the gates, write the SQLite file
 * named by the date and the digest, and point `dist/snapshots/latest.json`
 * at it.
 *
 * Run: `bun src/build/build-snapshot.ts [--date YYYY-MM-DD] [--out dir]`
 *
 * The tool definition hash pins the three tool contracts of the harness to
 * the snapshot. It is the digest of `src/service/api.ts`, because that file is
 * the wire contract that the tool descriptions restate, and a change to it is
 * a change to what the model sees.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { sha256Hex } from "../canonical.js";
import { writeSnapshot } from "../store.js";
import { loadKnowledgeBase } from "./load-kb.js";
import { validateKnowledgeBase } from "./validate.js";

const SCHEMA_VERSION = "0.1.0";
const VOCABULARIES = [
    "ECO release 2026-07-10 (CC0)",
    "STATO release 2026-04-20 (CC BY 3.0)",
    "OBI release 2026-07-27 (CC BY 4.0)",
    "EDAM 1.25 rolling release 2026-06-27 (cross-reference IRIs only)",
    "INFLEXA terms 0.1.0",
];

function argument(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

export async function buildSnapshot(options: { readonly root: string; readonly out: string; readonly date: string }): Promise<{ readonly path: string; readonly digest: string }> {
    const loaded = await loadKnowledgeBase(options.root);
    if (!loaded.ok) {
        throw new Error(loaded.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    }
    const issues = validateKnowledgeBase(loaded.kb);
    if (issues.length > 0) throw new Error(issues.map((issue) => `${issue.where}: ${issue.message}`).join("\n"));

    const apiSource = await Bun.file(join(import.meta.dir, "..", "service", "api.ts")).text();
    const toolDefinitionHash = `sha256:${sha256Hex(apiSource)}`;

    await mkdir(options.out, { recursive: true });
    const scratch = join(options.out, `.build-${crypto.randomUUID()}.sqlite`);
    const { meta } = writeSnapshot(scratch, {
        kb: loaded.kb,
        date: options.date,
        schemaVersion: SCHEMA_VERSION,
        vocabularies: VOCABULARIES,
        toolDefinitionHash,
    });
    const short = meta.digest.replace(/^sha256:/, "").slice(0, 12);
    const path = join(options.out, `${options.date}-${short}.sqlite`);
    await Bun.write(path, Bun.file(scratch));
    await Bun.file(scratch).unlink();
    await Bun.write(join(options.out, "latest.json"), `${JSON.stringify({ path: `${options.date}-${short}.sqlite`, ...meta }, null, 2)}\n`);
    return { path, digest: meta.digest };
}

if (import.meta.main) {
    const root = join(import.meta.dir, "..", "..", "kb");
    const out = argument("--out") ?? join(import.meta.dir, "..", "..", "dist", "snapshots");
    const date = argument("--date") ?? new Date().toISOString().slice(0, 10);
    try {
        const built = await buildSnapshot({ root, out, date });
        console.log(`snapshot ${built.digest}\n${built.path}`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
