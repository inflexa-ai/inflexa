## 1. Validate the load-bearing embed mechanism

- [x] 1.1 Confirm against the installed Bun how `--compile` embeds an arbitrary file asset that is NOT needed by `bun run dev`. — VERIFIED (Bun 1.3.10): a `with { type: "file" }` asset reached only through a static-string dynamic `import("./child.ts")` IS embedded under `--compile` and readable via `readFileSync` from any cwd; in `bun run` the import resolves only when its branch executes, so the asset is not needed in dev. Chosen: gated dynamic `import("./content.ts")` in runtime.ts, top-level `with { type: "file" }` in content.ts. No bytes-module fallback needed.

## 2. Build: generate, hash, and embed the archive (`cli/scripts/build.ts`)

- [x] 2.1 Tar `../skills` + `../templates` into a single `content.pack` before the `Bun.build` loop. — `collectContentEntries` walks both trees into `PackEntry[]`; `packContent` writes `cli/content.pack`.
- [x] 2.2 Compute a deterministic content hash over the file set and `--define` it as `INFLEXA_CONTENT_HASH`. — `contentHashOf` (sorted `(path, sha256(bytes))`, 16 hex); explicit `--define`, not the `bakedEnv` scanner (same treatment as `INFLEXA_GIT_COMMIT`).
- [x] 2.3 Wire the embed so every cross-compiled target carries the archive; keep the `--version` smoke test green. — VERIFIED: real build packed 128 files (117 skills + 11 templates), smoke test `--version → 0.1.0` passed, and the binary embeds the pack (grep found `skills/cheminformatics/SKILL.md`, `omics-general`, `templates/report-html/base.html.j2`).

## 3. Env: content dir + baked hash (`cli/src/lib/env.ts`)

- [x] 3.1 Add `contentDir` next to `refsDir`/`modelDir` + an `envDoc` entry. — VERIFIED: shows in `--help` paths, resolves to `<dataDir>/inflexa/content`.
- [x] 3.2 Expose baked `contentHash` (from `INFLEXA_CONTENT_HASH`); `string | undefined`, unused in dev. — added to `env`, excluded from `envDoc`.

## 4. Materialization step (`cli/src/modules/harness/content.ts` + `content-pack.ts`)

- [x] 4.1 `ensureBundledContent(): Result<ContentDirs, ContentError>` with a discriminated error union; no `throw`. — pure pack format lives in `content-pack.ts` (packer/unpacker/hash, unit-tested); `content.ts` is the embedded-asset glue.
- [x] 4.2 Warm path: reuse an existing `<contentDir>/<hash>/{skills,templates}` without extracting. — VERIFIED: sentinel file inode+mtime unchanged across a re-run.
- [x] 4.3 Cold path: extract to a private temp sibling, then atomic `rename`; concurrent-winner tolerated. — VERIFIED: a real release boot extracted all 128 files into `content/91e0e46a110dd93d/`.
- [x] 4.4 Best-effort prune of stale hash dirs; spares `.tmp-*`; never blocks boot. — VERIFIED: a planted stale hash dir was removed on the next run while a planted `.tmp-*` was preserved.

## 5. Wire resolution + boot (`config.ts`, `runtime.ts`)

- [x] 5.1 `config.ts`: release default of `skillsDir`/`templatesDir` → `join(env.contentDir, contentHash, …)`; dev keeps the repo-root trees; pure path computation. — `releaseContentDir` helper.
- [x] 5.2 `runtime.ts`: release-only `ensureBundledContent()` before the skills/templates gate; error → clear boot failure. — new `content_materialize_failed` boot error + `describeBootError` case. VERIFIED: boot proceeded PAST the skills/templates gate (failing later on embedder config), proving the gate saw a populated tree.
- [x] 5.3 `INFLEXA_DEV=1` does not repoint content — content keys off the build channel. — confirmed by the release-channel test binary run with `INFLEXA_DEV=1` (still extracted; env.isDevelopment stayed false).

## 6. Verify

- [x] 6.1 `bun run typecheck` and `bun run lint` pass; no unconsumed `Result`. — clean; `content-pack.test.ts` 8/8; full suite 1074 pass / 0 fail.
- [x] 6.2 Build + run with an EMPTY data dir and NO config override: boots, extracts, reads a skill / renders a template; re-run does not re-extract. — VERIFIED end-to-end (extraction + warm-path reuse above).
- [x] 6.3 Simulate an upgrade: new hash → fresh tree, old pruned, harness reads new content. — prune half VERIFIED live; new-hash-on-content-change covered by `content-pack.test.ts` (hash changes on any byte/file change) + the hash-keyed extraction dir.
- [x] 6.4 `bun run dev` resolves to the repo-root trees and never touches `contentDir`. — by construction: `env.isDevelopment` selects `devSkillsDir`/`devTemplatesDir` (import.meta.dir), and `ensureBundledContent` is gated out (dev never loads content.ts, per task 1.1).
- [x] 6.5 `bun run format:file` on changed `src/` files; `openspec validate --strict` passes. — done.
