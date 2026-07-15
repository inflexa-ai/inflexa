/**
 * Install-context detection: is this process the compiled single-file binary
 * (`bun build --compile`, produced by `scripts/build.ts`) or a from-source /
 * dev / test run?
 *
 * The distinction routes ASSET SOURCE. The `llama-server` runtime archive that
 * backs local embeddings is materialized from a build-time EMBEDDED asset inside
 * the compiled binary — each target embeds exactly its own, selected by a
 * per-target `--define` — but from a pinned release DOWNLOAD in a source checkout,
 * where nothing was embedded. `llama_runtime.ts`'s `materialize` asks
 * {@link isCompiledBinary} to pick the byte source; both converge on the identical
 * verified artifact extracted to the same on-disk layout.
 *
 * This is the ONE place that knows how the compiled context is detected. The
 * `/$bunfs` marker path is a platform-shaped, stringly implementation detail
 * (`B:\~BUN\` on Windows) — sniffing `import.meta.path` for it at call sites
 * would scatter that fragility. Instead the build stamps an explicit flag and
 * every caller reads it through this accessor.
 */

// Baked to the literal `true` by scripts/build.ts's `define` mechanism for every
// release target. A bare global identifier — deliberately NOT a `process.env`
// read — so this accessor stays clear of the `no-restricted-properties`
// process.env ban (env.ts owns those) and reads as a compile-time constant.
//
// `declare const` is the escape hatch that lets TypeScript see a global the build
// injects: it is safe here because the ONLY read below is guarded by `typeof`, so
// a from-source/dev/test run (where no define ran and the identifier is genuinely
// undeclared) evaluates to `"undefined"` rather than a ReferenceError. Bun
// constant-folds `typeof __INFLEXA_COMPILED__ !== "undefined" && …` to `true` when
// the define is present and leaves the runtime-safe guard intact when it is not
// (verified against Bun.build's define substitution under `typeof`).
declare const __INFLEXA_COMPILED__: boolean | undefined;

/**
 * Test-only override of the detected context. `null` (the default) defers to the
 * real baked-flag detection; `true`/`false` force the answer so tests can exercise
 * both the compiled and from-source paths in a single process. Set via
 * {@link __setCompiledBinaryForTest}.
 */
let testOverride: boolean | null = null;

/**
 * True iff this process is the compiled single-file binary. Dev, from-source, and
 * test runs resolve to `false` (no build define). A test override, when set, wins.
 */
export function isCompiledBinary(): boolean {
    if (testOverride !== null) return testOverride;
    return typeof __INFLEXA_COMPILED__ !== "undefined" && __INFLEXA_COMPILED__ === true;
}

/**
 * TEST ONLY. Force {@link isCompiledBinary} to report a compiled (`true`) or
 * from-source (`false`) context, or pass `null` to restore real detection.
 * Mirrors the `__set…ForTest` accessors elsewhere; production code never calls it.
 */
export function __setCompiledBinaryForTest(value: boolean | null): void {
    testOverride = value;
}
