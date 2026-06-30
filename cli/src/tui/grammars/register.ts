import { getTreeSitterClient } from "@opentui/core";

// Asset imports use the `with { type: "file" }` import attribute: Bun embeds each file into a
// `bun --compile` binary and rewrites the import to the embedded path. The value is a real on-disk
// absolute path under `bun run dev` and a `/$bunfs/root/...` path in the compiled executable, so the
// SAME code loads the grammars in both. This mirrors how opentui embeds its OWN bundled grammars
// (`import("./assets/.../*.wasm", { with: { type: "file" } })` in @opentui/core). The earlier
// `fileURLToPath(new URL("./x", import.meta.url))` resolution produced a path that Bun did NOT embed,
// so the wasm/scm were absent from the binary and these grammars rendered unhighlighted there.
// Paths must be string literals — Bun can only embed statically-known imports, so a templated
// `import("./" + ft + ".wasm")` would not be embedded.
import pythonWasm from "./python/tree-sitter-python.wasm" with { type: "file" };
import pythonHighlights from "./python/highlights.scm" with { type: "file" };
import rWasm from "./r/tree-sitter-r.wasm" with { type: "file" };
import rHighlights from "./r/highlights.scm" with { type: "file" };
import jsonWasm from "./json/tree-sitter-json.wasm" with { type: "file" };
import jsonHighlights from "./json/highlights.scm" with { type: "file" };

/** A code grammar shipped beyond opentui's bundled set, with its embedded asset paths. */
type ExtraGrammar = {
    /** opentui filetype id (matches a ```fence language and `<code filetype>`). */
    filetype: string;
    /** Extra fence/language spellings that resolve to this grammar. */
    aliases?: string[];
    /** Embedded path to the grammar wasm — valid in `bun run dev` and the compiled binary. */
    wasm: string;
    /** Embedded path to the grammar's `highlights.scm`. */
    highlights: string;
};

// Code grammars we ship beyond opentui's bundled set (markdown, markdown_inline, typescript,
// javascript, zig). The target users are bioinformaticians, so Python and R are the priority; JSON
// covers config/data. Provenance: python/json wasms come from the prebuilt `tree-sitter-wasms`
// build; the R wasm is compiled from `r-lib/tree-sitter-r` with the tree-sitter 0.25 CLI (matching
// opentui's `web-tree-sitter@0.25.10`, so the ABI lines up). Registering a parser is enough for BOTH
// a standalone `<code filetype>` and a ```lang fence inside `<markdown>` — the markdown injection
// resolves the fence language to the registered parser (verified), so no markdown-injection-mapping
// changes are needed.
export const EXTRA_GRAMMARS: ReadonlyArray<ExtraGrammar> = [
    { filetype: "python", aliases: ["py"], wasm: pythonWasm, highlights: pythonHighlights },
    { filetype: "r", aliases: ["R"], wasm: rWasm, highlights: rHighlights },
    { filetype: "json", wasm: jsonWasm, highlights: jsonHighlights },
];

/**
 * Register the bundled code grammars and warm the markdown + code parsers before any chat renders.
 *
 * The `<markdown>`/`<code>` renderables highlight asynchronously via a tree-sitter worker; if a parser
 * is not loaded when a block first parses, it renders raw and the renderable then marks itself clean
 * and never re-highlights — so a grammar that loads late leaves text permanently unstyled. Preloading
 * up front avoids that. markdown/markdown_inline are bundled (no registration, just preload); the
 * {@link EXTRA_GRAMMARS} ship as repo assets and are registered here first.
 *
 * Resolves once the parsers are warmed; callers fire-and-forget so a grammar load never blocks or
 * breaks TUI startup.
 */
export async function warmGrammars(): Promise<void> {
    const ts = getTreeSitterClient();

    // Defense-in-depth: if the worker ever fails to start, the client EMITS "error"; with no listener
    // that THROWS (EventEmitter semantics) and tears down the whole app. The compiled binary now embeds
    // the worker (see scripts/build.ts) so it loads there too, but a swallow listener keeps any future
    // worker failure degrading to plain (unhighlighted) text instead of crashing. The same guard covers
    // the lazy worker spawn on first markdown render, since the client is a process-global singleton.
    ts.on("error", () => {});

    try {
        // Initialize the worker BEFORE registering: addFiletypeParser only posts a message, so calling
        // it pre-init drops the registration (and wedges the run — every parser then reports missing).
        await ts.initialize();

        for (const g of EXTRA_GRAMMARS) {
            ts.addFiletypeParser({
                filetype: g.filetype,
                aliases: g.aliases,
                wasm: g.wasm,
                queries: { highlights: [g.highlights] },
            });
        }

        await Promise.allSettled([
            ts.preloadParser("markdown"),
            ts.preloadParser("markdown_inline"),
            ...EXTRA_GRAMMARS.map((g) => ts.preloadParser(g.filetype)),
        ]);
    } catch {
        // Worker unavailable: nothing to warm. Highlighting is skipped; text renders plain.
    }
}
