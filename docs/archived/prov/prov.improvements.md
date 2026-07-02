# tsprov — improvements needed

Features/issues in `@inflexa-ai/tsprov@0.1.0` that block or limit the provenance work. Append as
they come up.

## ✅ RESOLVED in 0.1.1 — (was) BLOCKER: the published dist build is non-functional (runtime)

**Resolution:** `@inflexa-ai/tsprov` `0.1.0 → 0.1.1` ships a working dist; `import { ProvDocument }`
resolves and the full provenance suite passes (`209 pass, 0 fail, 0 skip`), incl. a PROV-JSON
round-trip and the CLI export in both formats. No code change was needed on our side — the import
specifier was already correct. The original diagnosis is kept below for the record.

---


**Symptom.** `import { ProvDocument } from "@inflexa-ai/tsprov"` throws at load:
`138 errors building .../dist/index.js` → `"NamespaceManager" is not declared in this file`, etc.
Our code typechecks cleanly (the `.d.ts` are correct) but cannot execute.

**Root cause.** The package ships **no implementation JS for its submodules**. The only `.js`
files in `dist/` are `index.js` and `index.cjs`:

- `dist/index.js` (the `"module"`/ESM entry) is a **dangling export manifest** — a single
  `export { ProvDocument, NamespaceManager, … }` block with **no `import`s and no definitions**.
  The names it exports are never brought into scope, so the module fails to evaluate.
- `dist/index.cjs` references `import_constants`, `import_namespace_manager`, … but those bindings
  are never defined (no `require()` calls, and the sibling chunk `.js` files don't exist).

This is a **bundler bug in the package's own build**: `build:js`/`build:cjs` use
`bun build ./src/index.ts --format esm|cjs` on a pure re-export barrel, and with
`"sideEffects": false` set in the package's `package.json`, the implementation gets tree-shaken
away — leaving only the export bindings, which then dangle. `build:types` (tsc) still emits the
full `.d.ts` set, which is why types look complete while the runtime is empty.

**Proof the source is fine.** Importing the shipped TypeScript directly
(`./node_modules/@inflexa-ai/tsprov/src/index.ts`, which is in the package's `files`) works
perfectly — `doc.serialize("json"/"provn")` and a `deserialize → equals` round-trip all pass. So
the API and our usage are correct; only the **published bundle** is broken.

**Fix (upstream, in inflexa-ai/tsprov), any one of:**
1. Remove `"sideEffects": false` from the package (or set it to the entry/list of side-effecting
   files) so the bundler stops tree-shaking the implementation out of a barrel entry; **or**
2. Emit the runtime with `tsc` (which already produces the `.d.ts`) instead of `bun build`, so each
   `src/*.ts` becomes a real `dist/*.js` the index re-exports from; **or**
3. Verify the build with a post-build smoke test (`node -e "require('./dist')"` +
   `import('./dist/index.js')`) in CI before publish — this would have caught it.

Then republish (e.g. `0.1.1`) and `bun update @inflexa-ai/tsprov`.

**Blast radius on our side (already contained).** All tsprov usage is isolated to
`src/modules/prov/document.ts`. Recording (`prov.ts`) and the analysis hot path never import it, so
analysis create/add/remove and the TUI launch are unaffected. Only the **export** action is blocked:
- CLI `inflexa prov export …` will throw on the broken import.
- The TUI "Export provenance" commands lazy-import `document.ts` and **catch** the failure, showing
  a notice instead of crashing.
- `prov.test.ts` probes tsprov and **skips** while it's broken (auto-runs once it's fixed).

No code change is needed here once tsprov republishes — the import specifier is already correct.
