// Ambient declaration for the `with { type: "file" }` import of the embedded content archive in
// content.ts. Bun's file loader resolves such an import to a path STRING (a real disk path in dev,
// a /$bunfs/root/... path in a compiled binary); TypeScript has no built-in type for `.pack`
// specifiers, so without this `tsc --noEmit` fails with "Cannot find module". Mirrors the grammar
// asset declarations in src/tui/grammars/assets.d.ts.

declare module "*.pack" {
    const path: string;
    export default path;
}
