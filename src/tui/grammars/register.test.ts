import { describe, expect, test } from "bun:test";

import { EXTRA_GRAMMARS } from "./register.ts";

// Guards the committed grammar assets: each language warmGrammars registers must ship a real wasm
// (correct magic bytes) and a non-trivial highlights.scm, or code highlighting silently breaks at
// runtime (the renderable falls back to raw text). Reads via the embedded asset paths the module
// actually imports (`g.wasm`/`g.highlights`), so it also proves the `with { type: "file" }` imports
// resolve. Cheap + deterministic — it checks the files, not the async tree-sitter worker
// (loadability/ABI was verified manually when the grammars were added, and in a compiled binary).
describe("bundled code grammars", () => {
    for (const g of EXTRA_GRAMMARS) {
        test(`${g.filetype}: wasm + highlights.scm present and valid`, async () => {
            const wasm = new Uint8Array(await Bun.file(g.wasm).arrayBuffer());
            // WebAssembly magic number: 0x00 0x61 0x73 0x6d ("\0asm").
            expect([wasm[0], wasm[1], wasm[2], wasm[3]]).toEqual([0x00, 0x61, 0x73, 0x6d]);
            const scm = await Bun.file(g.highlights).text();
            expect(scm.trim().length).toBeGreaterThan(50);
        });
    }
});
