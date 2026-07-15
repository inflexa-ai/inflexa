// Ambient declarations for the `with { type: "file" }` archive imports in llama_runtime.ts. Bun's
// file loader resolves such an import to a path STRING (a real disk path under `bun run dev` / at
// build time, a `/$bunfs/root/...` path in the compiled binary); TypeScript has no built-in type for
// these specifiers, so without these declarations `tsc --noEmit` fails with "Cannot find module" —
// and, crucially, the archives live under an out-of-git `.llama-cache/` that is ABSENT in a fresh
// checkout, so the wildcard-module resolution is what lets the source typecheck without them on disk.
// Mirrors src/tui/grammars/assets.d.ts, scoped to the release-archive extensions we embed.

declare module "*.tar.gz" {
    const path: string;
    export default path;
}

declare module "*.zip" {
    const path: string;
    export default path;
}
