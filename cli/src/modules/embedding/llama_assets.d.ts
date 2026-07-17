// Ambient declarations for the `with { type: "file" }` asset imports in llama_runtime.ts (the
// release archives) and setup.ts (the embedding-model GGUF). Bun's file loader resolves such an
// import to a path STRING (a real disk path under `bun run dev` / at build time, a
// `/$bunfs/root/...` path in the compiled binary); TypeScript has no built-in type for these
// specifiers, so without these declarations `tsc --noEmit` fails with "Cannot find module" —
// and, crucially, the assets live under an out-of-git `.llama-cache/` that is ABSENT in a fresh
// checkout, so the wildcard-module resolution is what lets the source typecheck without them on disk.
// Mirrors src/tui/grammars/assets.d.ts, scoped to the embedded-asset extensions.

declare module "*.tar.gz" {
    const path: string;
    export default path;
}

declare module "*.zip" {
    const path: string;
    export default path;
}

declare module "*.gguf" {
    const path: string;
    export default path;
}
