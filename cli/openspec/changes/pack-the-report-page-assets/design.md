## Context

The CLI already packs two trees into one archive. `scripts/build.ts` walks `../skills` and `../templates`, hashes the sorted file set, writes `content.pack`, and bakes the hash. `content.ts` unpacks it once under `<contentDir>/<hash>/`, and it prunes each stale hash directory.

The harness holds the asset manifest, and the preview tool takes a lookup that maps a specifier onto a path on disk. The composition root of the CLI passes none, thus the default runs.

## Goals / Non-Goals

**Goals:**

- A compiled binary carries the six files, and the preview tool finds each one.
- A build cannot ship a binary that misses a manifest entry.
- A dev run keeps the behavior that it has today.

**Non-Goals:**

- A new dependency of the CLI. The three packages stay dependencies of the harness.
- The removal of the old report path, which still names a CDN.

## Decisions

### D1. One archive holds three trees, and not two archives

The assets join `content.pack` as a third tree. One hash, one extraction, one prune, and one field more on the return.

The name `assets` under the hash directory is the choice of the CLI. The page stages an `assets/` directory of its own beside itself, and the two are different things.

The alternative was a second archive with its own hash. It buys an independent churn: a change to a skill would not re-extract the fonts. The hash is baked at BUILD time, thus a user re-extracts on a version upgrade in either shape. As a result the independent hash buys almost nothing. It costs a second embedded file, a second unpack path, and a second failure arm.

### D2. The failure posture comes free

The existing rule fails the boot visibly when the archive cannot be materialized. One archive means the assets cannot go missing while the skills arrive, thus that one rule already covers the new tree. No new error variant, and no new message.

### D3. The build resolves each specifier through the installation of the harness

`echarts` and the two font packages are dependencies of the harness. A resolution from the CLI would depend on how the installer hoisted them, and a flat install is not a promise. Thus the build resolves each specifier from the entry point of the harness, and it reads what the pinned version of the harness declares.

The resolution runs in two hops, and it uses the ESM loader. The build resolves the bare name of the harness, then it resolves each specifier against that entry. `createRequire` cannot take the first hop at all: the export map of the harness declares an `import` condition alone, thus a CommonJS resolution of the bare name fails. The default lookup of the preview tool reaches for `createRequire`. That call runs INSIDE the package, where the resolution is relative and the map never applies.

### D4. The manifest is the source of the file set, and the build never restates it

The build reads the manifest from the front door of the harness. A hand-kept list in the build script would drift the moment that a harness version adds an entry. A specifier that does not resolve refuses the build, which is the posture that the existing tree walk already takes for a missing directory.

### D5. The build reads the data module, and the composition reads the front door

Both need the manifest, and they reach it differently on purpose.

The front door evaluates the whole runtime graph of the harness. A measurement puts that at about 800 ms, against nothing for the module that holds the manifest. That module is pure constants, with no import of its own. The composition root already imports the front door, thus the manifest costs it nothing. A build script drives a bundler, and it must not pull a runtime graph into that process for six string pairs.

The front door still earns the export. It is the surface that an embedder faces, and it already carries the type of the lookup that this work binds.

### D6. The build refuses an empty manifest

An empty manifest writes no assets directory. The warm-path guard reads that directory, thus it would never pass, and each boot would extract the archive again with nothing to say so.

The harness holds a non-empty manifest as an invariant. The CLI does not depend on that silently: the refusal sits at the build, where an operator meets it, and not at a boot loop that a user cannot diagnose.

### D7. The binding speaks the throw protocol of the seam

`createPreviewReportTool` wraps the lookup in a `try`, and it turns a throw into the `write-failed` outcome. Thus the lookup is a throwing contract, and the realization of the CLI obeys it: a specifier that the manifest does not carry throws.

This is a boundary shape, and it is not an exception to the rule of the `Result` channel. The caller owns the protection, and the failure reaches the agent as typed data.

### D8. A dev run binds nothing

The binding sits behind the release gate that `content.ts` already sits behind. A dev checkout has the installation of the harness on disk, thus the default lookup is correct there. To bind a materialized path in a dev run would point at a directory that no dev build ever writes.

### D9. The composition reads the assets directory from the materialization

The materialization gives back the three directories. The composition root binds the lookup over the directory that it returns, and it derives no path of its own.

The alternative was to derive the path again from the content hash. `config.ts` derives the skills directory and the templates directory that way, thus a third derivation would match them. But such a path names a directory that no step proved was written.

The return value is the one value that proves the extract ran. Thus the binding takes it, and the release gate that holds the materialization holds the binding too.

### D10. The extract takes its inputs, and its caller binds them

The extract of the archive holds the warm-path guard that this change widens. A test could not reach that guard. The module that holds it binds an embedded asset that a checkout does not carry, thus the module does not load under a test. It also reads two values that the environment freezes at import.

Thus the algorithm moves to a module of its own, and it takes the archive path, the content directory, and the content hash. The caller binds the asset and the environment over it.

The asset import stays static. The compiler embeds the bytes from that form alone, thus a dynamic import would risk the release binary for a test convenience.

## Risks / Trade-offs

- [The archive roughly doubles in size] → Accepted. The chart runtime is the bulk of it, and a user extracts it one time for each version.
- [The build depends on the installation of the harness] → Accepted, and stated. The pinned version is what a release must carry, thus reading its own tree is the honest source.
- [The default lookup has no coverage] → The preview test of the harness stubs the seam. This change adds no test of that default, because the fault it fixes is the absence of a binding and not the default.

## Migration Plan

The change is additive at the build and at the composition root. A binary of the previous version keeps its own hash directory, which the prune removes on the first run of the new one.

## Open Questions

None.
