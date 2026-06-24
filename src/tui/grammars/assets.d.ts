// Ambient declarations for the `with { type: "file" }` asset imports in register.ts. Bun's file
// loader resolves such an import to a path STRING (a real disk path in dev, a /$bunfs/root/... path
// in a compiled binary); TypeScript has no built-in type for these specifiers, so without these
// declarations `tsc --noEmit` fails with "Cannot find module". Scoped to the grammar asset
// extensions we actually import.

declare module "*.wasm" {
    const path: string;
    export default path;
}

declare module "*.scm" {
    const path: string;
    export default path;
}
